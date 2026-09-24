-- Daily, store-local product inventory. Browser roles have no direct access.
-- Checkout consumption and eligible cancellation returns stay inside the order transaction.

begin;

create table public.product_inventory_settings (
  store_id uuid not null,
  product_id uuid not null,
  stock_mode text not null default 'always',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (store_id, product_id),
  constraint product_inventory_settings_mode_check
    check (stock_mode in ('always', 'manual', 'quantity')),
  constraint product_inventory_settings_product_store_fkey
    foreign key (product_id, store_id)
    references public.products(id, store_id)
    on delete cascade
);

create table public.product_inventory_daily (
  store_id uuid not null,
  product_id uuid not null,
  inventory_date date not null,
  available boolean not null default true,
  prepared_quantity integer not null default 0,
  quantity_remaining integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (store_id, product_id, inventory_date),
  constraint product_inventory_daily_product_store_fkey
    foreign key (product_id, store_id)
    references public.products(id, store_id)
    on delete cascade,
  constraint product_inventory_daily_prepared_range
    check (prepared_quantity between 0 and 100000),
  constraint product_inventory_daily_remaining_range
    check (quantity_remaining between 0 and 100000)
);

create table public.product_inventory_events (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  product_id uuid not null,
  inventory_date date not null,
  order_id uuid,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  quantity_delta integer not null default 0,
  quantity_after integer,
  created_at timestamptz not null default now(),
  constraint product_inventory_events_type_check
    check (event_type in (
      'prepared', 'adjustment', 'sale', 'sold_out', 'cancel_return', 'availability'
    )),
  constraint product_inventory_events_delta_range
    check (quantity_delta between -100000 and 100000),
  constraint product_inventory_events_after_range
    check (quantity_after is null or quantity_after between 0 and 100000),
  constraint product_inventory_events_product_store_fkey
    foreign key (product_id, store_id)
    references public.products(id, store_id)
    on delete restrict,
  constraint product_inventory_events_order_store_fkey
    foreign key (order_id, store_id)
    references public.orders(id, store_id)
    on delete restrict
);

create index product_inventory_events_product_date_idx
  on public.product_inventory_events(store_id, product_id, inventory_date, created_at desc);

create index product_inventory_events_type_created_idx
  on public.product_inventory_events(store_id, event_type, created_at desc);

create index product_inventory_events_order_idx
  on public.product_inventory_events(order_id, created_at)
  where order_id is not null;

create unique index product_inventory_events_sale_once_idx
  on public.product_inventory_events(order_id, product_id, inventory_date, event_type)
  where order_id is not null and event_type = 'sale';

create unique index product_inventory_events_cancel_return_once_idx
  on public.product_inventory_events(order_id, product_id, inventory_date, event_type)
  where order_id is not null and event_type = 'cancel_return';

create trigger trg_product_inventory_settings_updated_at
before update on public.product_inventory_settings
for each row execute function public.set_updated_at();

create trigger trg_product_inventory_daily_updated_at
before update on public.product_inventory_daily
for each row execute function public.set_updated_at();

create or replace function public.consume_daily_product_inventory()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  requested record;
  stock_mode_value text;
  daily_row public.product_inventory_daily%rowtype;
  inventory_date_value date;
  remaining_after integer;
begin
  for requested in
    select
      order_row.id as order_id,
      order_row.store_id,
      order_row.fulfillment_type,
      store_row.timezone,
      inserted.product_id,
      sum(inserted.quantity)::integer as requested_quantity
    from inserted_order_items inserted
    join public.orders order_row on order_row.id = inserted.order_id
    join public.stores store_row on store_row.id = order_row.store_id
    where inserted.product_id is not null
      and order_row.fulfillment_type <> 'scheduled'
    group by
      order_row.id,
      order_row.store_id,
      order_row.fulfillment_type,
      store_row.timezone,
      inserted.product_id
    order by order_row.store_id, inserted.product_id, order_row.id
  loop
    select setting.stock_mode
    into stock_mode_value
    from public.product_inventory_settings setting
    where setting.store_id = requested.store_id
      and setting.product_id = requested.product_id
    for share;

    stock_mode_value := coalesce(stock_mode_value, 'always');
    if stock_mode_value = 'always' then
      continue;
    end if;

    inventory_date_value := (statement_timestamp() at time zone requested.timezone)::date;

    select daily.*
    into daily_row
    from public.product_inventory_daily daily
    where daily.store_id = requested.store_id
      and daily.product_id = requested.product_id
      and daily.inventory_date = inventory_date_value
    for update;

    if stock_mode_value = 'manual' then
      if not found or not daily_row.available then
        raise exception using
          errcode = 'P0001',
          message = 'ATREVIDA_STOCK_CONFLICT';
      end if;
      continue;
    end if;

    if not found
       or not daily_row.available
       or daily_row.quantity_remaining < requested.requested_quantity then
      raise exception using
        errcode = 'P0001',
        message = 'ATREVIDA_STOCK_CONFLICT';
    end if;

    remaining_after := daily_row.quantity_remaining - requested.requested_quantity;

    update public.product_inventory_daily
    set
      quantity_remaining = remaining_after,
      available = remaining_after > 0
    where store_id = requested.store_id
      and product_id = requested.product_id
      and inventory_date = inventory_date_value;

    insert into public.product_inventory_events (
      store_id,
      product_id,
      inventory_date,
      order_id,
      event_type,
      quantity_delta,
      quantity_after
    ) values (
      requested.store_id,
      requested.product_id,
      inventory_date_value,
      requested.order_id,
      'sale',
      -requested.requested_quantity,
      remaining_after
    );

    if daily_row.quantity_remaining > 0 and remaining_after = 0 then
      insert into public.product_inventory_events (
        store_id,
        product_id,
        inventory_date,
        order_id,
        event_type,
        quantity_delta,
        quantity_after
      ) values (
        requested.store_id,
        requested.product_id,
        inventory_date_value,
        requested.order_id,
        'sold_out',
        0,
        0
      );
    end if;
  end loop;

  return null;
end;
$$;

create trigger trg_order_items_consume_daily_inventory
after insert on public.order_items
referencing new table as inserted_order_items
for each statement execute function public.consume_daily_product_inventory();

create or replace function public.restore_daily_product_inventory_on_cancel()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  sale_row record;
  daily_row public.product_inventory_daily%rowtype;
  stock_mode_value text;
  returned_event_id uuid;
  return_quantity integer;
begin
  if new.status <> 'cancelled'
     or old.status not in ('pending', 'confirmed')
     or new.status is not distinct from old.status then
    return new;
  end if;

  for sale_row in
    select event.product_id, event.inventory_date, -event.quantity_delta as consumed_quantity
    from public.product_inventory_events event
    where event.store_id = new.store_id
      and event.order_id = new.id
      and event.event_type = 'sale'
    order by event.product_id, event.inventory_date
  loop
    return_quantity := sale_row.consumed_quantity;

    perform 1
    from public.products product_row
    where product_row.store_id = new.store_id
      and product_row.id = sale_row.product_id
    for share;

    if not found then
      raise exception 'inventory return product is missing';
    end if;

    select setting.stock_mode
    into stock_mode_value
    from public.product_inventory_settings setting
    where setting.store_id = new.store_id
      and setting.product_id = sale_row.product_id
    for share;
    stock_mode_value := coalesce(stock_mode_value, 'always');

    select daily.*
    into daily_row
    from public.product_inventory_daily daily
    where daily.store_id = new.store_id
      and daily.product_id = sale_row.product_id
      and daily.inventory_date = sale_row.inventory_date
    for update;

    if not found then
      raise exception 'inventory return target is missing';
    end if;

    returned_event_id := null;
    insert into public.product_inventory_events (
      store_id,
      product_id,
      inventory_date,
      order_id,
      event_type,
      quantity_delta,
      quantity_after
    ) values (
      new.store_id,
      sale_row.product_id,
      sale_row.inventory_date,
      new.id,
      'cancel_return',
      return_quantity,
      daily_row.quantity_remaining + return_quantity
    )
    on conflict (order_id, product_id, inventory_date, event_type)
      where order_id is not null and event_type = 'cancel_return'
    do nothing
    returning id into returned_event_id;

    if returned_event_id is not null then
      update public.product_inventory_daily
      set
        quantity_remaining = quantity_remaining + return_quantity,
        available = case
          when stock_mode_value = 'quantity' then true
          else available
        end
      where store_id = new.store_id
        and product_id = sale_row.product_id
        and inventory_date = sale_row.inventory_date;
    end if;
  end loop;

  return new;
end;
$$;

create trigger trg_orders_restore_daily_inventory
after update of status on public.orders
for each row execute function public.restore_daily_product_inventory_on_cancel();

create or replace function public.set_daily_product_inventory(
  p_store_id uuid,
  p_product_id uuid,
  p_stock_mode text,
  p_available boolean default null,
  p_prepared_quantity integer default null,
  p_quantity_remaining integer default null,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  inventory_date_value date;
  daily_row public.product_inventory_daily%rowtype;
  stock_mode_value text;
  prepared_after integer;
  remaining_after integer;
  available_after boolean;
begin
  select (statement_timestamp() at time zone store_row.timezone)::date
  into inventory_date_value
  from public.stores store_row
  join public.products product_row
    on product_row.store_id = store_row.id
   and product_row.id = p_product_id
   and product_row.active
  where store_row.id = p_store_id
  for update of product_row;

  if not found then
    raise exception using errcode = 'P0002', message = 'ATREVIDA_INVENTORY_PRODUCT_NOT_FOUND';
  end if;

  select setting.stock_mode
  into stock_mode_value
  from public.product_inventory_settings setting
  where setting.store_id = p_store_id
    and setting.product_id = p_product_id
  for share;
  stock_mode_value := coalesce(p_stock_mode, stock_mode_value, 'always');

  if stock_mode_value not in ('always', 'manual', 'quantity') then
    raise exception using errcode = '22023', message = 'invalid stock mode';
  end if;

  insert into public.product_inventory_settings (store_id, product_id, stock_mode)
  values (p_store_id, p_product_id, stock_mode_value)
  on conflict (store_id, product_id) do update
  set stock_mode = excluded.stock_mode;

  if stock_mode_value = 'always' then
    insert into public.admin_audit_log (
      store_id, user_id, action, entity_type, entity_id, metadata
    ) values (
      p_store_id,
      p_actor_user_id,
      'inventory.updated',
      'product_inventory',
      p_product_id,
      jsonb_strip_nulls(jsonb_build_object(
        'stockMode', p_stock_mode,
        'available', p_available,
        'preparedToday', p_prepared_quantity,
        'quantityRemaining', p_quantity_remaining
      ))
    );

    return jsonb_build_object(
      'stockMode', 'always',
      'available', true,
      'preparedToday', 0,
      'quantityRemaining', 0,
      'inventoryDate', inventory_date_value
    );
  end if;

  insert into public.product_inventory_daily (
    store_id,
    product_id,
    inventory_date,
    available,
    prepared_quantity,
    quantity_remaining
  ) values (
    p_store_id,
    p_product_id,
    inventory_date_value,
    false,
    0,
    0
  )
  on conflict (store_id, product_id, inventory_date) do nothing;

  select daily.*
  into daily_row
  from public.product_inventory_daily daily
  where daily.store_id = p_store_id
    and daily.product_id = p_product_id
    and daily.inventory_date = inventory_date_value
  for update;

  remaining_after := coalesce(p_quantity_remaining, daily_row.quantity_remaining);
  prepared_after := case
    when p_prepared_quantity is not null then p_prepared_quantity
    when stock_mode_value = 'quantity'
      and p_quantity_remaining is not null
      and p_quantity_remaining > daily_row.quantity_remaining
      then daily_row.prepared_quantity
        + (p_quantity_remaining - daily_row.quantity_remaining)
    else daily_row.prepared_quantity
  end;
  available_after := coalesce(
    p_available,
    case
      when stock_mode_value = 'quantity' and p_quantity_remaining is not null
        then remaining_after > 0
      else daily_row.available
    end
  );

  if prepared_after not between 0 and 100000
     or remaining_after not between 0 and 100000 then
    raise exception using errcode = '22023', message = 'inventory value is out of range';
  end if;

  if stock_mode_value = 'quantity' and remaining_after = 0 then
    available_after := false;
  end if;

  update public.product_inventory_daily
  set
    available = available_after,
    prepared_quantity = prepared_after,
    quantity_remaining = remaining_after
  where store_id = p_store_id
    and product_id = p_product_id
    and inventory_date = inventory_date_value;

  if prepared_after is distinct from daily_row.prepared_quantity then
    insert into public.product_inventory_events (
      store_id, product_id, inventory_date, actor_user_id,
      event_type, quantity_delta, quantity_after
    ) values (
      p_store_id, p_product_id, inventory_date_value, p_actor_user_id,
      'prepared', prepared_after - daily_row.prepared_quantity, prepared_after
    );
  end if;

  if remaining_after is distinct from daily_row.quantity_remaining then
    insert into public.product_inventory_events (
      store_id, product_id, inventory_date, actor_user_id,
      event_type, quantity_delta, quantity_after
    ) values (
      p_store_id, p_product_id, inventory_date_value, p_actor_user_id,
      'adjustment', remaining_after - daily_row.quantity_remaining, remaining_after
    );
  end if;

  if available_after is distinct from daily_row.available then
    insert into public.product_inventory_events (
      store_id, product_id, inventory_date, actor_user_id,
      event_type, quantity_delta, quantity_after
    ) values (
      p_store_id, p_product_id, inventory_date_value, p_actor_user_id,
      'availability', 0, remaining_after
    );
  end if;

  if (
    (daily_row.quantity_remaining > 0 and remaining_after = 0)
    or (daily_row.available and not available_after)
  ) then
    insert into public.product_inventory_events (
      store_id, product_id, inventory_date, actor_user_id,
      event_type, quantity_delta, quantity_after
    ) values (
      p_store_id, p_product_id, inventory_date_value, p_actor_user_id,
      'sold_out', 0, remaining_after
    );
  end if;

  insert into public.admin_audit_log (
    store_id, user_id, action, entity_type, entity_id, metadata
  ) values (
    p_store_id,
    p_actor_user_id,
    'inventory.updated',
    'product_inventory',
    p_product_id,
    jsonb_strip_nulls(jsonb_build_object(
      'stockMode', p_stock_mode,
      'available', p_available,
      'preparedToday', p_prepared_quantity,
      'quantityRemaining', p_quantity_remaining
    ))
  );

  return jsonb_build_object(
    'stockMode', stock_mode_value,
    'available', available_after,
    'preparedToday', prepared_after,
    'quantityRemaining', remaining_after,
    'inventoryDate', inventory_date_value
  );
end;
$$;

create or replace function public.adjust_daily_product_inventory(
  p_store_id uuid,
  p_product_id uuid,
  p_quantity_delta integer,
  p_prepared_delta integer default 0,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  inventory_date_value date;
  daily_row public.product_inventory_daily%rowtype;
  prepared_after integer;
  remaining_after integer;
  available_after boolean;
begin
  if p_quantity_delta is null
     or p_prepared_delta is null
     or p_quantity_delta not between -100000 and 100000
     or p_prepared_delta not between -100000 and 100000 then
    raise exception using errcode = '22023', message = 'inventory delta is out of range';
  end if;

  select (statement_timestamp() at time zone store_row.timezone)::date
  into inventory_date_value
  from public.stores store_row
  join public.products product_row
    on product_row.store_id = store_row.id
   and product_row.id = p_product_id
   and product_row.active
  join public.product_inventory_settings setting
    on setting.store_id = store_row.id
   and setting.product_id = product_row.id
   and setting.stock_mode = 'quantity'
  where store_row.id = p_store_id
  for share of product_row, setting;

  if not found then
    raise exception using errcode = 'P0002', message = 'ATREVIDA_INVENTORY_PRODUCT_NOT_FOUND';
  end if;

  insert into public.product_inventory_daily (
    store_id, product_id, inventory_date, available,
    prepared_quantity, quantity_remaining
  ) values (
    p_store_id, p_product_id, inventory_date_value, false, 0, 0
  )
  on conflict (store_id, product_id, inventory_date) do nothing;

  select daily.*
  into daily_row
  from public.product_inventory_daily daily
  where daily.store_id = p_store_id
    and daily.product_id = p_product_id
    and daily.inventory_date = inventory_date_value
  for update;

  prepared_after := daily_row.prepared_quantity + p_prepared_delta;
  remaining_after := daily_row.quantity_remaining + p_quantity_delta;

  if prepared_after not between 0 and 100000
     or remaining_after not between 0 and 100000 then
    raise exception using errcode = '22023', message = 'inventory adjustment would exceed bounds';
  end if;

  available_after := remaining_after > 0;

  update public.product_inventory_daily
  set
    available = available_after,
    prepared_quantity = prepared_after,
    quantity_remaining = remaining_after
  where store_id = p_store_id
    and product_id = p_product_id
    and inventory_date = inventory_date_value;

  if p_prepared_delta <> 0 then
    insert into public.product_inventory_events (
      store_id, product_id, inventory_date, actor_user_id,
      event_type, quantity_delta, quantity_after
    ) values (
      p_store_id, p_product_id, inventory_date_value, p_actor_user_id,
      'prepared', p_prepared_delta, prepared_after
    );
  end if;

  if p_quantity_delta <> 0 then
    insert into public.product_inventory_events (
      store_id, product_id, inventory_date, actor_user_id,
      event_type, quantity_delta, quantity_after
    ) values (
      p_store_id, p_product_id, inventory_date_value, p_actor_user_id,
      'adjustment', p_quantity_delta, remaining_after
    );
  end if;

  if daily_row.available is distinct from available_after then
    insert into public.product_inventory_events (
      store_id, product_id, inventory_date, actor_user_id,
      event_type, quantity_delta, quantity_after
    ) values (
      p_store_id, p_product_id, inventory_date_value, p_actor_user_id,
      'availability', 0, remaining_after
    );
  end if;

  if daily_row.quantity_remaining > 0 and remaining_after = 0 then
    insert into public.product_inventory_events (
      store_id, product_id, inventory_date, actor_user_id,
      event_type, quantity_delta, quantity_after
    ) values (
      p_store_id, p_product_id, inventory_date_value, p_actor_user_id,
      'sold_out', 0, 0
    );
  end if;

  insert into public.admin_audit_log (
    store_id, user_id, action, entity_type, entity_id, metadata
  ) values (
    p_store_id,
    p_actor_user_id,
    'inventory.adjusted',
    'product_inventory',
    p_product_id,
    jsonb_build_object(
      'quantityDelta', p_quantity_delta,
      'preparedDelta', p_prepared_delta
    )
  );

  return jsonb_build_object(
    'stockMode', 'quantity',
    'available', available_after,
    'preparedToday', prepared_after,
    'quantityRemaining', remaining_after,
    'inventoryDate', inventory_date_value
  );
end;
$$;

alter table public.product_inventory_settings enable row level security;
alter table public.product_inventory_daily enable row level security;
alter table public.product_inventory_events enable row level security;

revoke all on table public.product_inventory_settings from public, anon, authenticated;
revoke all on table public.product_inventory_daily from public, anon, authenticated;
revoke all on table public.product_inventory_events from public, anon, authenticated;

revoke all on table public.product_inventory_settings from service_role;
revoke all on table public.product_inventory_daily from service_role;
revoke all on table public.product_inventory_events from service_role;

grant select, insert, update on table public.product_inventory_settings to service_role;
grant select, insert, update on table public.product_inventory_daily to service_role;
grant select, insert on table public.product_inventory_events to service_role;

revoke all on function public.consume_daily_product_inventory()
  from public, anon, authenticated, service_role;
revoke all on function public.restore_daily_product_inventory_on_cancel()
  from public, anon, authenticated, service_role;
revoke all on function public.set_daily_product_inventory(uuid, uuid, text, boolean, integer, integer, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.adjust_daily_product_inventory(uuid, uuid, integer, integer, uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.set_daily_product_inventory(uuid, uuid, text, boolean, integer, integer, uuid)
  to service_role;
grant execute on function public.adjust_daily_product_inventory(uuid, uuid, integer, integer, uuid)
  to service_role;

commit;
