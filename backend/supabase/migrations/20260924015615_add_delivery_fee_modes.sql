begin;

alter table public.stores
  add column if not exists delivery_fee_mode text not null default 'zones',
  add column if not exists fixed_delivery_fee_cents integer;

alter table public.stores
  add constraint stores_delivery_fee_mode_valid
  check (delivery_fee_mode in ('fixed', 'zones')) not valid;

alter table public.stores
  validate constraint stores_delivery_fee_mode_valid;

alter table public.stores
  add constraint stores_fixed_delivery_fee_cents_nonnegative
  check (fixed_delivery_fee_cents is null or fixed_delivery_fee_cents >= 0) not valid;

alter table public.stores
  validate constraint stores_fixed_delivery_fee_cents_nonnegative;

update public.stores
set delivery_fee_mode = 'fixed'
where slug = 'atrevida-gourmet';

alter table public.orders
  drop constraint if exists orders_delivery_zone_required;

-- Keep checkout atomic and authoritative. In fixed mode the database ignores
-- any client-supplied zone and re-reads the configured fee from the store.
create or replace function public.create_order_with_items(
  order_payload jsonb,
  items_payload jsonb
)
returns public.orders
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  store_row public.stores%rowtype;
  zone_row public.delivery_zones%rowtype;
  created_order public.orders%rowtype;
  existing_order public.orders%rowtype;
  idempotency_row public.idempotency_keys%rowtype;
  item_value jsonb;
  prepared_item jsonb;
  prepared_items jsonb := '[]'::jsonb;
  selected_options jsonb;
  rebuilt_options jsonb;
  product_row record;
  store_id_value uuid;
  product_id_value uuid;
  delivery_zone_id_value uuid;
  idempotency_key_value text;
  fulfillment_value public.fulfillment_type;
  payment_value public.payment_method;
  scheduled_for_value timestamptz;
  quantity_value integer;
  item_count integer;
  total_units integer := 0;
  selected_count integer;
  distinct_selected_count integer;
  valid_selected_count integer;
  option_delta bigint;
  unit_price bigint;
  line_total bigint;
  subtotal bigint := 0;
  delivery_fee bigint := 0;
  total_value bigint;
  change_for_value bigint;
  order_number_value text;
begin
  if jsonb_typeof(order_payload) <> 'object' then
    raise exception 'order_payload must be an object';
  end if;

  if jsonb_typeof(items_payload) <> 'array' then
    raise exception 'items_payload must be an array';
  end if;

  item_count := jsonb_array_length(items_payload);
  if item_count < 1 or item_count > 40 then
    raise exception 'order must contain between 1 and 40 lines';
  end if;

  store_id_value := nullif(
    coalesce(order_payload ->> 'store_id', order_payload ->> 'storeId'),
    ''
  )::uuid;

  idempotency_key_value := nullif(
    coalesce(order_payload ->> 'idempotency_key', order_payload ->> 'idempotencyKey'),
    ''
  );

  if store_id_value is null or idempotency_key_value is null then
    raise exception 'store_id and idempotency_key are required';
  end if;

  select * into store_row
  from public.stores s
  where s.id = store_id_value
  for share;

  if not found or not store_row.active or not store_row.setup_complete then
    raise exception 'store is unavailable or setup is incomplete';
  end if;

  select * into idempotency_row
  from public.idempotency_keys i
  where i.store_id = store_id_value
    and i.key = idempotency_key_value
  for update;

  if not found then
    raise exception 'idempotency reservation not found';
  end if;

  if idempotency_row.expires_at <= now() then
    raise exception 'idempotency reservation expired';
  end if;

  if idempotency_row.order_id is not null then
    select * into existing_order
    from public.orders o
    where o.id = idempotency_row.order_id
      and o.store_id = store_id_value;

    if found then
      return existing_order;
    end if;
  end if;

  fulfillment_value := coalesce(
    order_payload ->> 'fulfillment_type',
    order_payload ->> 'fulfillmentType'
  )::public.fulfillment_type;

  payment_value := coalesce(
    order_payload ->> 'payment_method',
    order_payload ->> 'paymentMethod'
  )::public.payment_method;

  scheduled_for_value := nullif(coalesce(
    order_payload ->> 'scheduled_for',
    order_payload ->> 'scheduledFor'
  ), '')::timestamptz;

  if fulfillment_value = 'delivery' and not store_row.accepts_delivery then
    raise exception 'delivery is unavailable';
  elsif fulfillment_value = 'pickup' and not store_row.accepts_pickup then
    raise exception 'pickup is unavailable';
  elsif fulfillment_value = 'scheduled' and not store_row.accepts_scheduled_orders then
    raise exception 'scheduled orders are unavailable';
  end if;

  if fulfillment_value = 'scheduled' then
    if scheduled_for_value is null or scheduled_for_value <= now() then
      raise exception 'a future scheduled_for is required';
    end if;

    if store_row.scheduled_min_lead_minutes is not null
       and scheduled_for_value < now()
         + (store_row.scheduled_min_lead_minutes * interval '1 minute') then
      raise exception 'scheduled order is below configured lead time';
    end if;

    if store_row.scheduled_max_advance_days is not null
       and scheduled_for_value > now()
         + (store_row.scheduled_max_advance_days * interval '1 day') then
      raise exception 'scheduled order exceeds configured advance window';
    end if;

    if not public.store_is_open_at(store_id_value, scheduled_for_value) then
      raise exception 'store is closed at scheduled time';
    end if;
  else
    if not store_row.is_open or not public.store_is_open_at(store_id_value, now()) then
      raise exception 'store is closed';
    end if;
  end if;

  if not exists (
    select 1
    from public.store_payment_methods m
    where m.store_id = store_id_value
      and m.method = payment_value
      and m.active
  ) then
    raise exception 'payment method is unavailable';
  end if;

  if fulfillment_value = 'delivery' then
    if store_row.delivery_fee_mode = 'fixed' then
      if store_row.fixed_delivery_fee_cents is null then
        raise exception 'fixed delivery fee is not configured';
      end if;

      delivery_zone_id_value := null;
      delivery_fee := store_row.fixed_delivery_fee_cents;
    else
      delivery_zone_id_value := nullif(coalesce(
        order_payload ->> 'delivery_zone_id',
        order_payload ->> 'deliveryZoneId'
      ), '')::uuid;

      if delivery_zone_id_value is null then
        raise exception 'delivery_zone_id is required';
      end if;

      select * into zone_row
      from public.delivery_zones z
      where z.id = delivery_zone_id_value
        and z.store_id = store_id_value
        and z.active
      for share;

      if not found then
        raise exception 'delivery zone is unavailable';
      end if;

      delivery_fee := zone_row.fee_cents;
    end if;
  else
    delivery_zone_id_value := null;
    delivery_fee := 0;
  end if;

  for item_value in
    select value from jsonb_array_elements(items_payload)
  loop
    if jsonb_typeof(item_value) <> 'object' then
      raise exception 'each order line must be an object';
    end if;

    product_id_value := nullif(coalesce(
      item_value ->> 'product_id',
      item_value ->> 'productId'
    ), '')::uuid;
    quantity_value := (item_value ->> 'quantity')::integer;

    if product_id_value is null or quantity_value < 1 or quantity_value > 50 then
      raise exception 'invalid product or quantity';
    end if;

    total_units := total_units + quantity_value;
    if total_units > 200 then
      raise exception 'order exceeds total unit limit';
    end if;

    select p.id, p.name, p.price_cents
    into product_row
    from public.products p
    where p.id = product_id_value
      and p.store_id = store_id_value
      and p.active
      and p.price_cents is not null
      and exists (
        select 1
        from public.categories c
        where c.id = p.category_id
          and c.store_id = p.store_id
          and c.active
      )
    for share;

    if not found then
      raise exception 'product is unavailable or belongs to another store';
    end if;

    selected_options := coalesce(
      item_value -> 'options_snapshot',
      item_value -> 'options',
      '[]'::jsonb
    );

    if jsonb_typeof(selected_options) <> 'array'
       or jsonb_array_length(selected_options) > 10 then
      raise exception 'invalid option selection';
    end if;

    selected_count := jsonb_array_length(selected_options);

    select count(distinct nullif(coalesce(
      selected.value ->> 'valueId',
      selected.value ->> 'value_id'
    ), '')::uuid)
    into distinct_selected_count
    from jsonb_array_elements(selected_options) selected(value);

    if distinct_selected_count <> selected_count then
      raise exception 'duplicate option value';
    end if;

    select
      count(*),
      coalesce(sum(v.price_delta_cents), 0),
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'groupId', g.id,
            'groupName', g.name,
            'valueId', v.id,
            'valueName', v.name,
            'priceDeltaCents', v.price_delta_cents
          )
          order by g.sort_order, v.sort_order, v.id
        ),
        '[]'::jsonb
      )
    into valid_selected_count, option_delta, rebuilt_options
    from jsonb_array_elements(selected_options) selected(value)
    join public.product_option_groups g
      on g.id = nullif(coalesce(
        selected.value ->> 'groupId',
        selected.value ->> 'group_id'
      ), '')::uuid
     and g.product_id = product_id_value
     and g.active
    join public.product_option_values v
      on v.id = nullif(coalesce(
        selected.value ->> 'valueId',
        selected.value ->> 'value_id'
      ), '')::uuid
     and v.group_id = g.id
     and v.active;

    if valid_selected_count <> selected_count then
      raise exception 'option does not belong to product or is inactive';
    end if;

    if exists (
      select 1
      from public.product_option_groups g
      left join (
        select
          nullif(coalesce(
            selected.value ->> 'groupId',
            selected.value ->> 'group_id'
          ), '')::uuid as group_id,
          count(*)::integer as selected_total
        from jsonb_array_elements(selected_options) selected(value)
        group by 1
      ) chosen on chosen.group_id = g.id
      where g.product_id = product_id_value
        and g.active
        and (
          coalesce(chosen.selected_total, 0)
            < case when g.required then greatest(g.min_select, 1) else g.min_select end
          or coalesce(chosen.selected_total, 0) > g.max_select
        )
    ) then
      raise exception 'option group cardinality is invalid';
    end if;

    unit_price := product_row.price_cents::bigint + option_delta;
    if unit_price < 0 or unit_price > 1000000000 then
      raise exception 'calculated unit price is invalid';
    end if;

    line_total := unit_price * quantity_value;
    subtotal := subtotal + line_total;

    if subtotal > 2000000000 then
      raise exception 'order subtotal is too large';
    end if;

    prepared_item := jsonb_build_object(
      'product_id', product_id_value,
      'product_name_snapshot', product_row.name,
      'unit_price_cents', unit_price,
      'quantity', quantity_value,
      'line_total_cents', line_total,
      'note', coalesce(item_value ->> 'note', ''),
      'options_snapshot', rebuilt_options
    );

    prepared_items := prepared_items || jsonb_build_array(prepared_item);
  end loop;

  if subtotal < store_row.minimum_order_cents then
    raise exception 'order is below store minimum';
  end if;

  if fulfillment_value = 'delivery'
     and store_row.delivery_fee_mode = 'zones'
     and subtotal < zone_row.minimum_order_cents then
    raise exception 'order is below delivery zone minimum';
  end if;

  total_value := subtotal + delivery_fee;
  if total_value > 2000000000 then
    raise exception 'order total is too large';
  end if;

  change_for_value := nullif(coalesce(
    order_payload ->> 'change_for_cents',
    order_payload ->> 'changeForCents'
  ), '')::bigint;

  if payment_value <> 'cash' and change_for_value is not null then
    raise exception 'change is only valid for cash';
  end if;

  if change_for_value is not null and change_for_value < total_value then
    raise exception 'change amount is below order total';
  end if;

  if change_for_value is not null and change_for_value > 2000000000 then
    raise exception 'change amount is too large';
  end if;

  order_number_value := btrim(coalesce(
    order_payload ->> 'order_number',
    order_payload ->> 'orderNumber',
    ''
  ));

  if char_length(order_number_value) < 4 or char_length(order_number_value) > 40 then
    raise exception 'invalid order number';
  end if;

  insert into public.orders (
    store_id,
    order_number,
    status,
    fulfillment_type,
    customer_name,
    customer_phone,
    delivery_postal_code,
    delivery_street,
    delivery_number,
    delivery_neighborhood,
    delivery_complement,
    delivery_reference,
    delivery_zone_id,
    scheduled_for,
    payment_method,
    change_for_cents,
    note,
    subtotal_cents,
    delivery_fee_cents,
    total_cents
  ) values (
    store_id_value,
    order_number_value,
    'pending',
    fulfillment_value,
    btrim(coalesce(order_payload ->> 'customer_name', order_payload #>> '{customer,name}', '')),
    btrim(coalesce(order_payload ->> 'customer_phone', order_payload #>> '{customer,phone}', '')),
    nullif(coalesce(order_payload ->> 'delivery_postal_code', order_payload #>> '{delivery,postalCode}'), ''),
    nullif(coalesce(order_payload ->> 'delivery_street', order_payload #>> '{delivery,street}'), ''),
    nullif(coalesce(order_payload ->> 'delivery_number', order_payload #>> '{delivery,number}'), ''),
    nullif(coalesce(order_payload ->> 'delivery_neighborhood', order_payload #>> '{delivery,neighborhood}'), ''),
    nullif(coalesce(order_payload ->> 'delivery_complement', order_payload #>> '{delivery,complement}'), ''),
    nullif(coalesce(order_payload ->> 'delivery_reference', order_payload #>> '{delivery,reference}'), ''),
    delivery_zone_id_value,
    scheduled_for_value,
    payment_value,
    change_for_value::integer,
    coalesce(order_payload ->> 'note', ''),
    subtotal::integer,
    delivery_fee::integer,
    total_value::integer
  )
  returning * into created_order;

  insert into public.order_items (
    order_id,
    product_id,
    product_name_snapshot,
    unit_price_cents,
    quantity,
    line_total_cents,
    note,
    options_snapshot
  )
  select
    created_order.id,
    prepared.product_id,
    prepared.product_name_snapshot,
    prepared.unit_price_cents,
    prepared.quantity,
    prepared.line_total_cents,
    prepared.note,
    prepared.options_snapshot
  from jsonb_to_recordset(prepared_items) as prepared(
    product_id uuid,
    product_name_snapshot text,
    unit_price_cents integer,
    quantity integer,
    line_total_cents integer,
    note text,
    options_snapshot jsonb
  );

  update public.idempotency_keys
  set
    state = 'completed',
    order_id = created_order.id,
    response_status = 201,
    response_body = jsonb_build_object(
      'orderNumber', created_order.order_number,
      'trackingToken', created_order.tracking_token,
      'status', created_order.status,
      'subtotalCents', created_order.subtotal_cents,
      'deliveryFeeCents', created_order.delivery_fee_cents,
      'totalCents', created_order.total_cents,
      'createdAt', created_order.created_at
    ),
    completed_at = now()
  where id = idempotency_row.id;

  return created_order;
end;
$$;

revoke all on function public.create_order_with_items(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_order_with_items(jsonb, jsonb)
  to service_role;

commit;
