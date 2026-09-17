\set ON_ERROR_STOP on

-- Execute depois das migrations e do seed. O teste usa transacao para ser
-- repetivel, mas cria um pedido real e consulta o tracking antes do rollback.
begin;

update public.stores
set setup_complete = true,
    is_open = true,
    accepts_pickup = true
where slug = 'atrevida-gourmet';

insert into public.store_payment_methods (
  store_id, method, label, active, sort_order
)
select id, 'pix', 'Pix', true, 0
from public.stores
where slug = 'atrevida-gourmet'
on conflict (store_id, method) do update set active = true;

insert into public.store_hours (store_id, day_of_week, opens_at, closes_at, active)
select store.id, day_value, time '00:00', time '23:59:59', true
from public.stores store
cross join generate_series(0, 6) day_value
where store.slug = 'atrevida-gourmet'
on conflict (store_id, day_of_week, opens_at) do update set active = true;

update public.products product
set active = true
from public.stores store
where product.store_id = store.id
  and store.slug = 'atrevida-gourmet'
  and product.name = 'Copo Pudim'
  and product.price_cents = 1500;

do $$
declare
  store_id_value uuid;
  product_id_value uuid;
  created public.orders%rowtype;
  replayed public.orders%rowtype;
  order_count integer;
  tracked record;
  key_value constant text := '99999999-9999-4999-8999-999999999999';
begin
  select id into strict store_id_value
  from public.stores
  where slug = 'atrevida-gourmet';

  select id into strict product_id_value
  from public.products
  where store_id = store_id_value
    and name = 'Copo Pudim'
    and price_cents = 1500
  limit 1;

  delete from public.orders
  where store_id = store_id_value
    and order_number in ('FLOW-REAL-001', 'FLOW-IGNORED-REPLAY');
  delete from public.idempotency_keys
  where store_id = store_id_value and key = key_value;

  insert into public.idempotency_keys (
    key, request_hash, store_id, expires_at
  ) values (
    key_value, repeat('a', 64), store_id_value, now() + interval '1 day'
  );

  select * into created
  from public.create_order_with_items(
    jsonb_build_object(
      'store_id', store_id_value,
      'order_number', 'FLOW-REAL-001',
      'fulfillment_type', 'pickup',
      'customer_name', 'Cliente Integracao',
      'customer_phone', '14999999999',
      'payment_method', 'pix',
      'idempotency_key', key_value,
      -- Valores adulterados devem ser ignorados pelo RPC.
      'subtotal_cents', 1,
      'delivery_fee_cents', 999999,
      'total_cents', 1
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id', product_id_value,
      'quantity', 2,
      'unit_price_cents', 1,
      'line_total_cents', 1,
      'options_snapshot', '[]'::jsonb
    ))
  );

  if created.subtotal_cents <> 3000
     or created.delivery_fee_cents <> 0
     or created.total_cents <> 3000 then
    raise exception 'server-side pricing failed: %, %, %',
      created.subtotal_cents, created.delivery_fee_cents, created.total_cents;
  end if;

  select * into replayed
  from public.create_order_with_items(
    jsonb_build_object(
      'store_id', store_id_value,
      'order_number', 'FLOW-IGNORED-REPLAY',
      'fulfillment_type', 'pickup',
      'customer_name', 'Cliente Integracao',
      'customer_phone', '14999999999',
      'payment_method', 'pix',
      'idempotency_key', key_value
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id', product_id_value,
      'quantity', 2,
      'options_snapshot', '[]'::jsonb
    ))
  );

  if replayed.id <> created.id then
    raise exception 'idempotency replay created another order';
  end if;

  select count(*) into order_count
  from public.orders
  where id = created.id;
  if order_count <> 1 then
    raise exception 'expected one persisted order, got %', order_count;
  end if;

  select
    order_number,
    status,
    fulfillment_type,
    subtotal_cents,
    delivery_fee_cents,
    total_cents
  into strict tracked
  from public.orders
  where tracking_token = created.tracking_token;

  if tracked.order_number <> created.order_number
     or tracked.total_cents <> created.total_cents then
    raise exception 'tracking lookup did not recover the created order';
  end if;

  raise notice 'pedido %, tracking %, total %',
    created.order_number, created.tracking_token, created.total_cents;
end
$$;

rollback;
