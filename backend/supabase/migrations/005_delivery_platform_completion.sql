-- ============================================================
-- Delivery platform completion (incremental)
--
-- Keeps the browser away from the database. All commercial data is
-- exposed by the Fastify API through explicit DTOs. The service_role is
-- the only application role allowed to mutate the objects below.
-- ============================================================

begin;

create extension if not exists "pgcrypto";

do $$
begin
  create type public.idempotency_state as enum (
    'processing',
    'completed',
    'failed'
  );
exception when duplicate_object then null;
end
$$;

-- ------------------------------------------------------------
-- Store configuration. A newly created store is not ready to take
-- orders until an administrator explicitly finishes its setup.
-- ------------------------------------------------------------

alter table public.stores
  add column if not exists setup_complete boolean not null default false,
  add column if not exists instagram_handle text,
  add column if not exists whatsapp_e164 text,
  add column if not exists whatsapp_display text,
  add column if not exists scheduled_min_lead_minutes integer,
  add column if not exists scheduled_max_advance_days integer;

alter table public.stores alter column is_open set default false;
alter table public.stores alter column accepts_delivery set default false;
alter table public.stores alter column accepts_pickup set default false;
alter table public.stores alter column accepts_scheduled_orders set default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.stores'::regclass
      and conname = 'stores_slug_format'
  ) then
    alter table public.stores
      add constraint stores_slug_format
      check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(slug) <= 80)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.stores'::regclass
      and conname = 'stores_instagram_handle_format'
  ) then
    alter table public.stores
      add constraint stores_instagram_handle_format
      check (
        instagram_handle is null
        or instagram_handle ~ '^@[A-Za-z0-9._]{1,30}$'
      )
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.stores'::regclass
      and conname = 'stores_whatsapp_e164_format'
  ) then
    alter table public.stores
      add constraint stores_whatsapp_e164_format
      check (
        whatsapp_e164 is null
        or whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$'
      )
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.stores'::regclass
      and conname = 'stores_scheduled_min_lead_range'
  ) then
    alter table public.stores
      add constraint stores_scheduled_min_lead_range
      check (
        scheduled_min_lead_minutes is null
        or scheduled_min_lead_minutes between 0 and 525600
      )
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.stores'::regclass
      and conname = 'stores_scheduled_max_advance_range'
  ) then
    alter table public.stores
      add constraint stores_scheduled_max_advance_range
      check (
        scheduled_max_advance_days is null
        or scheduled_max_advance_days between 1 and 3650
      )
      not valid;
  end if;
end
$$;

-- Existing catalog/configuration tables also need update timestamps for
-- deterministic admin CRUD and cache invalidation.
alter table public.categories
  add column if not exists updated_at timestamptz not null default now();

alter table public.product_option_groups
  add column if not exists updated_at timestamptz not null default now();

alter table public.product_option_values
  add column if not exists updated_at timestamptz not null default now();

alter table public.delivery_zones
  add column if not exists updated_at timestamptz not null default now();

-- ------------------------------------------------------------
-- Opening hours, future exceptions and per-store payment methods.
-- No rows are seeded: these are commercial facts that the store must
-- configure itself.
-- ------------------------------------------------------------

create table if not exists public.store_hours (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  opens_at time without time zone not null,
  closes_at time without time zone not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_hours_nonzero_window check (opens_at <> closes_at),
  unique (store_id, day_of_week, opens_at)
);

comment on column public.store_hours.day_of_week is
  'PostgreSQL DOW: Sunday=0 through Saturday=6, interpreted in stores.timezone.';

create table if not exists public.store_schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  exception_date date not null,
  is_closed boolean not null default true,
  opens_at time without time zone,
  closes_at time without time zone,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_schedule_exception_window check (
    (is_closed and opens_at is null and closes_at is null)
    or
    (not is_closed and opens_at is not null and closes_at is not null and opens_at <> closes_at)
  ),
  constraint store_schedule_exception_note_length check (char_length(note) <= 300),
  unique (store_id, exception_date)
);

create table if not exists public.store_payment_methods (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  method public.payment_method not null,
  label text not null,
  active boolean not null default false,
  instructions text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_payment_method_label_length check (
    char_length(btrim(label)) between 1 and 80
  ),
  constraint store_payment_method_instructions_length check (
    char_length(instructions) <= 500
  ),
  unique (store_id, method)
);

-- ------------------------------------------------------------
-- Product image metadata. Actual bytes live in the product-images
-- Storage bucket; object names are UUID based and scoped by store id.
-- ------------------------------------------------------------

create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  object_path text not null unique,
  mime_type text not null,
  byte_size bigint not null,
  width integer,
  height integer,
  alt_text text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_images_path_scope check (
    split_part(object_path, '/', 1) = store_id::text
    and object_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|avif)$'
  ),
  constraint product_images_mime_type check (
    mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/avif')
  ),
  constraint product_images_size check (byte_size between 1 and 5242880),
  constraint product_images_dimensions check (
    (width is null and height is null)
    or
    (width between 1 and 8000 and height between 1 and 8000)
  ),
  constraint product_images_alt_text_length check (char_length(alt_text) <= 180)
);

-- ------------------------------------------------------------
-- Order status history and append-only administrative audit trail.
-- Metadata must contain identifiers and changed field names only; do not
-- put customer phone/address or tokens in it.
-- ------------------------------------------------------------

alter table public.orders
  add column if not exists status_changed_at timestamptz not null default now(),
  add column if not exists preparing_at timestamptz,
  add column if not exists out_for_delivery_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_reason text;

create table if not exists public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  from_status public.order_status,
  to_status public.order_status not null,
  changed_by uuid references auth.users(id) on delete set null,
  reason text,
  created_at timestamptz not null default now(),
  constraint order_status_history_reason_length check (
    reason is null or char_length(reason) <= 500
  )
);

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint admin_audit_action_length check (
    char_length(btrim(action)) between 1 and 100
  ),
  constraint admin_audit_entity_type_length check (
    char_length(btrim(entity_type)) between 1 and 80
  ),
  constraint admin_audit_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint admin_audit_metadata_size check (
    octet_length(metadata::text) <= 16384
  )
);

-- ------------------------------------------------------------
-- Idempotency evolution. The original global-key primary key is migrated
-- to an opaque id while legacy rows are preserved. New rows must carry a
-- store_id, and uniqueness is scoped to (store_id, key).
-- ------------------------------------------------------------

alter table public.idempotency_keys
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists store_id uuid references public.stores(id) on delete cascade,
  add column if not exists state public.idempotency_state not null default 'processing',
  add column if not exists order_id uuid references public.orders(id) on delete set null,
  add column if not exists response_status smallint,
  add column if not exists response_body jsonb,
  add column if not exists completed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

update public.idempotency_keys
set id = gen_random_uuid()
where id is null;

alter table public.idempotency_keys alter column id set not null;

do $$
declare
  current_pk text;
begin
  select pg_get_constraintdef(oid)
  into current_pk
  from pg_constraint
  where conrelid = 'public.idempotency_keys'::regclass
    and contype = 'p';

  if current_pk = 'PRIMARY KEY (key)' then
    alter table public.idempotency_keys drop constraint idempotency_keys_pkey;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.idempotency_keys'::regclass
      and contype = 'p'
  ) then
    alter table public.idempotency_keys
      add constraint idempotency_keys_pkey primary key (id);
  end if;
end
$$;

create unique index if not exists uq_idempotency_store_key
  on public.idempotency_keys(store_id, key)
  where store_id is not null;

create unique index if not exists uq_idempotency_legacy_key
  on public.idempotency_keys(key)
  where store_id is null;

create unique index if not exists uq_idempotency_order
  on public.idempotency_keys(order_id)
  where order_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.idempotency_keys'::regclass
      and conname = 'idempotency_store_required_for_new_rows'
  ) then
    -- NOT VALID preserves any in-flight legacy reservation while still
    -- enforcing store_id for every new/updated row.
    alter table public.idempotency_keys
      add constraint idempotency_store_required_for_new_rows
      check (store_id is not null)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.idempotency_keys'::regclass
      and conname = 'idempotency_key_length'
  ) then
    alter table public.idempotency_keys
      add constraint idempotency_key_length
      check (char_length(key) between 16 and 128)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.idempotency_keys'::regclass
      and conname = 'idempotency_request_hash_format'
  ) then
    alter table public.idempotency_keys
      add constraint idempotency_request_hash_format
      check (request_hash ~ '^[0-9a-f]{64}$')
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.idempotency_keys'::regclass
      and conname = 'idempotency_response_status_range'
  ) then
    alter table public.idempotency_keys
      add constraint idempotency_response_status_range
      check (response_status is null or response_status between 100 and 599)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.idempotency_keys'::regclass
      and conname = 'idempotency_response_body_shape'
  ) then
    alter table public.idempotency_keys
      add constraint idempotency_response_body_shape
      check (
        response_body is null
        or (
          jsonb_typeof(response_body) = 'object'
          and octet_length(response_body::text) <= 16384
        )
      )
      not valid;
  end if;
end
$$;

-- ------------------------------------------------------------
-- Tenant and arithmetic integrity.
-- ------------------------------------------------------------

create unique index if not exists uq_categories_id_store
  on public.categories(id, store_id);

create unique index if not exists uq_products_id_store
  on public.products(id, store_id);

create unique index if not exists uq_delivery_zones_id_store
  on public.delivery_zones(id, store_id);

create unique index if not exists uq_orders_id_store
  on public.orders(id, store_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.products'::regclass
      and conname = 'products_category_same_store_fkey'
  ) then
    alter table public.products
      add constraint products_category_same_store_fkey
      foreign key (category_id, store_id)
      references public.categories(id, store_id)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_delivery_zone_same_store_fkey'
  ) then
    alter table public.orders
      add constraint orders_delivery_zone_same_store_fkey
      foreign key (delivery_zone_id, store_id)
      references public.delivery_zones(id, store_id)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_status_history'::regclass
      and conname = 'order_status_history_same_store_fkey'
  ) then
    alter table public.order_status_history
      add constraint order_status_history_same_store_fkey
      foreign key (order_id, store_id)
      references public.orders(id, store_id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_option_groups'::regclass
      and conname = 'product_option_groups_required_minimum'
  ) then
    alter table public.product_option_groups
      add constraint product_option_groups_required_minimum
      check (not required or min_select >= 1)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_items'::regclass
      and conname = 'order_items_quantity_limit'
  ) then
    alter table public.order_items
      add constraint order_items_quantity_limit
      check (quantity <= 50)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_items'::regclass
      and conname = 'order_items_line_total_consistency'
  ) then
    alter table public.order_items
      add constraint order_items_line_total_consistency
      check (line_total_cents = unit_price_cents * quantity)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_items'::regclass
      and conname = 'order_items_options_shape'
  ) then
    alter table public.order_items
      add constraint order_items_options_shape
      check (
        jsonb_typeof(options_snapshot) = 'array'
        and jsonb_array_length(options_snapshot) <= 10
      )
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_scheduled_time_required'
  ) then
    alter table public.orders
      add constraint orders_scheduled_time_required
      check (fulfillment_type <> 'scheduled' or scheduled_for is not null)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_delivery_zone_required'
  ) then
    alter table public.orders
      add constraint orders_delivery_zone_required
      check (fulfillment_type <> 'delivery' or delivery_zone_id is not null)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_non_delivery_fee_zero'
  ) then
    alter table public.orders
      add constraint orders_non_delivery_fee_zero
      check (fulfillment_type = 'delivery' or delivery_fee_cents = 0)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_change_only_for_cash'
  ) then
    alter table public.orders
      add constraint orders_change_only_for_cash
      check (change_for_cents is null or payment_method = 'cash')
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_customer_fields_valid'
  ) then
    alter table public.orders
      add constraint orders_customer_fields_valid
      check (
        char_length(btrim(customer_name)) between 2 and 100
        and char_length(btrim(customer_phone)) between 8 and 24
      )
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_delivery_address_required'
  ) then
    alter table public.orders
      add constraint orders_delivery_address_required
      check (
        fulfillment_type <> 'delivery'
        or (
          char_length(btrim(coalesce(delivery_street, ''))) between 2 and 120
          and char_length(btrim(coalesce(delivery_number, ''))) between 1 and 20
          and char_length(btrim(coalesce(delivery_neighborhood, ''))) between 2 and 100
        )
      )
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_text_lengths'
  ) then
    alter table public.orders
      add constraint orders_text_lengths
      check (
        char_length(order_number) between 4 and 40
        and char_length(note) <= 500
        and char_length(coalesce(delivery_postal_code, '')) <= 12
        and char_length(coalesce(delivery_complement, '')) <= 120
        and char_length(coalesce(delivery_reference, '')) <= 180
        and char_length(coalesce(cancellation_reason, '')) <= 500
      )
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_items'::regclass
      and conname = 'order_items_text_lengths'
  ) then
    alter table public.order_items
      add constraint order_items_text_lengths
      check (
        char_length(product_name_snapshot) between 1 and 200
        and char_length(note) <= 300
      )
      not valid;
  end if;
end
$$;

create or replace function public.guard_order_item_store()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  order_store uuid;
  product_store uuid;
begin
  select o.store_id into order_store
  from public.orders o
  where o.id = new.order_id;

  if order_store is null then
    raise exception 'order not found';
  end if;

  if new.product_id is not null then
    select p.store_id into product_store
    from public.products p
    where p.id = new.product_id;

    if product_store is null or product_store <> order_store then
      raise exception 'order item product belongs to another store';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_order_items_store_guard on public.order_items;
create trigger trg_order_items_store_guard
before insert or update of order_id, product_id on public.order_items
for each row execute function public.guard_order_item_store();

create or replace function public.guard_product_image_store()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  product_store uuid;
begin
  if new.product_id is not null then
    select p.store_id into product_store
    from public.products p
    where p.id = new.product_id;

    if product_store is null or product_store <> new.store_id then
      raise exception 'product image belongs to another store';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_product_images_store_guard on public.product_images;
create trigger trg_product_images_store_guard
before insert or update of store_id, product_id on public.product_images
for each row execute function public.guard_product_image_store();

-- ------------------------------------------------------------
-- Updated-at and immutable-history triggers.
-- ------------------------------------------------------------

drop trigger if exists trg_categories_updated_at on public.categories;
create trigger trg_categories_updated_at
before update on public.categories
for each row execute function public.set_updated_at();

drop trigger if exists trg_product_option_groups_updated_at on public.product_option_groups;
create trigger trg_product_option_groups_updated_at
before update on public.product_option_groups
for each row execute function public.set_updated_at();

drop trigger if exists trg_product_option_values_updated_at on public.product_option_values;
create trigger trg_product_option_values_updated_at
before update on public.product_option_values
for each row execute function public.set_updated_at();

drop trigger if exists trg_delivery_zones_updated_at on public.delivery_zones;
create trigger trg_delivery_zones_updated_at
before update on public.delivery_zones
for each row execute function public.set_updated_at();

drop trigger if exists trg_store_hours_updated_at on public.store_hours;
create trigger trg_store_hours_updated_at
before update on public.store_hours
for each row execute function public.set_updated_at();

drop trigger if exists trg_store_schedule_exceptions_updated_at on public.store_schedule_exceptions;
create trigger trg_store_schedule_exceptions_updated_at
before update on public.store_schedule_exceptions
for each row execute function public.set_updated_at();

drop trigger if exists trg_store_payment_methods_updated_at on public.store_payment_methods;
create trigger trg_store_payment_methods_updated_at
before update on public.store_payment_methods
for each row execute function public.set_updated_at();

drop trigger if exists trg_product_images_updated_at on public.product_images;
create trigger trg_product_images_updated_at
before update on public.product_images
for each row execute function public.set_updated_at();

drop trigger if exists trg_idempotency_keys_updated_at on public.idempotency_keys;
create trigger trg_idempotency_keys_updated_at
before update on public.idempotency_keys
for each row execute function public.set_updated_at();

create or replace function public.set_order_status_timestamps()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    new.status_changed_at = now();

    if new.status = 'confirmed' and new.accepted_at is null then
      new.accepted_at = now();
    elsif new.status = 'preparing' and new.preparing_at is null then
      new.preparing_at = now();
    elsif new.status = 'ready' and new.ready_at is null then
      new.ready_at = now();
    elsif new.status = 'out_for_delivery' and new.out_for_delivery_at is null then
      new.out_for_delivery_at = now();
    elsif new.status = 'completed' and new.completed_at is null then
      new.completed_at = now();
    elsif new.status = 'cancelled' and new.cancelled_at is null then
      new.cancelled_at = now();
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_orders_status_timestamps on public.orders;
create trigger trg_orders_status_timestamps
before insert or update of status on public.orders
for each row execute function public.set_order_status_timestamps();

create or replace function public.log_order_status_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.order_status_history (
      order_id,
      store_id,
      from_status,
      to_status,
      changed_by,
      reason
    ) values (
      new.id,
      new.store_id,
      null,
      new.status,
      auth.uid(),
      null
    );
  elsif new.status is distinct from old.status then
    insert into public.order_status_history (
      order_id,
      store_id,
      from_status,
      to_status,
      changed_by,
      reason
    ) values (
      new.id,
      new.store_id,
      old.status,
      new.status,
      auth.uid(),
      case when new.status = 'cancelled' then new.cancellation_reason else null end
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_orders_status_history on public.orders;
create trigger trg_orders_status_history
after insert or update of status on public.orders
for each row execute function public.log_order_status_change();

create or replace function public.reject_append_only_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  raise exception 'append-only table';
end;
$$;

drop trigger if exists trg_order_status_history_append_only on public.order_status_history;
create trigger trg_order_status_history_append_only
before update or delete on public.order_status_history
for each row execute function public.reject_append_only_mutation();

drop trigger if exists trg_admin_audit_log_append_only on public.admin_audit_log;
create trigger trg_admin_audit_log_append_only
before update or delete on public.admin_audit_log
for each row execute function public.reject_append_only_mutation();

-- ------------------------------------------------------------
-- Schedule evaluation in the store's configured time zone.
-- Manual stores.is_open is intentionally evaluated by the checkout RPC
-- only for immediate orders; a currently closed store can still accept a
-- future scheduled order when configured to do so.
-- ------------------------------------------------------------

create or replace function public.store_is_open_at(
  p_store_id uuid,
  p_at timestamptz default now()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  store_row record;
  local_timestamp timestamp without time zone;
  local_date date;
  local_time time without time zone;
  local_dow smallint;
  previous_date date;
  previous_dow smallint;
  today_exception record;
  previous_exception record;
begin
  select s.active, s.setup_complete, s.timezone
  into store_row
  from public.stores s
  where s.id = p_store_id;

  if not found or not store_row.active or not store_row.setup_complete then
    return false;
  end if;

  local_timestamp := p_at at time zone store_row.timezone;
  local_date := local_timestamp::date;
  local_time := local_timestamp::time;
  local_dow := extract(dow from local_timestamp)::smallint;
  previous_date := local_date - 1;
  previous_dow := (local_dow + 6) % 7;

  select e.is_closed, e.opens_at, e.closes_at
  into today_exception
  from public.store_schedule_exceptions e
  where e.store_id = p_store_id
    and e.exception_date = local_date;

  if found then
    if today_exception.is_closed then
      return false;
    end if;

    if today_exception.opens_at < today_exception.closes_at then
      return local_time >= today_exception.opens_at
        and local_time < today_exception.closes_at;
    end if;

    -- An overnight exception belongs to its start date. Its after-midnight
    -- portion is evaluated from the previous day's exception below.
    return local_time >= today_exception.opens_at;
  end if;

  select e.is_closed, e.opens_at, e.closes_at
  into previous_exception
  from public.store_schedule_exceptions e
  where e.store_id = p_store_id
    and e.exception_date = previous_date;

  if found then
    if not previous_exception.is_closed
       and previous_exception.opens_at > previous_exception.closes_at
       and local_time < previous_exception.closes_at then
      return true;
    end if;
  elsif exists (
    select 1
    from public.store_hours h
    where h.store_id = p_store_id
      and h.day_of_week = previous_dow
      and h.active
      and h.opens_at > h.closes_at
      and local_time < h.closes_at
  ) then
    return true;
  end if;

  return exists (
    select 1
    from public.store_hours h
    where h.store_id = p_store_id
      and h.day_of_week = local_dow
      and h.active
      and (
        (h.opens_at < h.closes_at and local_time >= h.opens_at and local_time < h.closes_at)
        or
        (h.opens_at > h.closes_at and local_time >= h.opens_at)
      )
  );
exception
  when invalid_parameter_value then
    -- Invalid time zones must fail closed.
    return false;
end;
$$;

-- ------------------------------------------------------------
-- Atomic checkout.
--
-- The Fastify server passes identifiers/quantities only. Product prices,
-- option deltas, availability, delivery fee and totals are re-read and
-- recalculated inside this transaction. Supplied snapshot prices/totals
-- are ignored. The same transaction creates items and completes the
-- idempotency record, eliminating orphan/partial orders.
-- ------------------------------------------------------------

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

  if fulfillment_value = 'delivery' and subtotal < zone_row.minimum_order_cents then
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

-- ------------------------------------------------------------
-- Supporting indexes.
-- ------------------------------------------------------------

create index if not exists idx_store_members_user
  on public.store_members(user_id, store_id);

create index if not exists idx_option_groups_product_active
  on public.product_option_groups(product_id, active, sort_order);

create index if not exists idx_option_values_group_active
  on public.product_option_values(group_id, active, sort_order);

create index if not exists idx_store_hours_lookup
  on public.store_hours(store_id, day_of_week, active, opens_at);

create index if not exists idx_store_schedule_exceptions_lookup
  on public.store_schedule_exceptions(store_id, exception_date);

create index if not exists idx_store_payment_methods_active
  on public.store_payment_methods(store_id, active, sort_order);

create index if not exists idx_product_images_product
  on public.product_images(store_id, product_id, created_at desc);

create index if not exists idx_order_status_history_order
  on public.order_status_history(order_id, created_at);

create index if not exists idx_order_status_history_store
  on public.order_status_history(store_id, created_at desc);

create index if not exists idx_admin_audit_store_created
  on public.admin_audit_log(store_id, created_at desc);

create index if not exists idx_admin_audit_user_created
  on public.admin_audit_log(user_id, created_at desc);

create index if not exists idx_idempotency_store_expiry
  on public.idempotency_keys(store_id, expires_at);

-- ------------------------------------------------------------
-- RLS and least-privilege grants.
-- No anon/authenticated policies are created. Realtime is consumed by
-- the backend and retransmitted as public/admin DTOs.
-- ------------------------------------------------------------

alter table public.store_hours enable row level security;
alter table public.store_schedule_exceptions enable row level security;
alter table public.store_payment_methods enable row level security;
alter table public.product_images enable row level security;
alter table public.order_status_history enable row level security;
alter table public.admin_audit_log enable row level security;

revoke all on table public.store_hours from public, anon, authenticated;
revoke all on table public.store_schedule_exceptions from public, anon, authenticated;
revoke all on table public.store_payment_methods from public, anon, authenticated;
revoke all on table public.product_images from public, anon, authenticated;
revoke all on table public.order_status_history from public, anon, authenticated;
revoke all on table public.admin_audit_log from public, anon, authenticated;

-- Reassert revokes for every pre-existing commercial table as defense in
-- depth if this migration is applied without 002/004 by mistake.
revoke all on table public.stores from anon, authenticated;
revoke all on table public.store_members from anon, authenticated;
revoke all on table public.categories from anon, authenticated;
revoke all on table public.products from anon, authenticated;
revoke all on table public.product_option_groups from anon, authenticated;
revoke all on table public.product_option_values from anon, authenticated;
revoke all on table public.delivery_zones from anon, authenticated;
revoke all on table public.orders from anon, authenticated;
revoke all on table public.order_items from anon, authenticated;
revoke all on table public.idempotency_keys from anon, authenticated;

grant select, insert, update, delete on table public.store_hours to service_role;
grant select, insert, update, delete on table public.store_schedule_exceptions to service_role;
grant select, insert, update, delete on table public.store_payment_methods to service_role;
grant select, insert, update, delete on table public.product_images to service_role;
grant select on table public.order_status_history to service_role;

revoke all on table public.admin_audit_log from service_role;
grant select, insert on table public.admin_audit_log to service_role;

revoke all on function public.guard_order_item_store() from public, anon, authenticated;
revoke all on function public.guard_product_image_store() from public, anon, authenticated;
revoke all on function public.set_order_status_timestamps() from public, anon, authenticated;
revoke all on function public.log_order_status_change() from public, anon, authenticated;
revoke all on function public.reject_append_only_mutation() from public, anon, authenticated;
revoke all on function public.store_is_open_at(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.create_order_with_items(jsonb, jsonb) from public, anon, authenticated;

grant execute on function public.store_is_open_at(uuid, timestamptz) to service_role;
grant execute on function public.create_order_with_items(jsonb, jsonb) to service_role;

-- ------------------------------------------------------------
-- Supabase Realtime. Do not replace the publication: other tables may
-- already belong to it.
-- ------------------------------------------------------------

alter table public.orders replica identity full;
alter table public.order_status_history replica identity full;

do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'orders'
    ) then
      execute 'alter publication supabase_realtime add table public.orders';
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'order_status_history'
    ) then
      execute 'alter publication supabase_realtime add table public.order_status_history';
    end if;
  end if;
end
$$;

-- Product images are deliberately public assets, but uploads/deletes have
-- no browser policy and must pass through the backend. The bucket rejects
-- SVG and files larger than 5 MiB. The backend is responsible for decode,
-- resize/compression and metadata stripping before upload.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    execute $bucket$
      insert into storage.buckets (
        id,
        name,
        public,
        file_size_limit,
        allowed_mime_types
      ) values (
        'product-images',
        'product-images',
        true,
        5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/avif']::text[]
      )
      on conflict (id) do update
      set
        public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types
    $bucket$;
  end if;
end
$$;

-- Remove only the exact disabled placeholder that the original seed used.
-- No real delivery zone is inferred or inserted.
delete from public.delivery_zones zone
using public.stores store
where zone.store_id = store.id
  and store.slug = 'atrevida-gourmet'
  and zone.name = 'EXEMPLO - confirmar com a loja'
  and zone.active = false
  and zone.fee_cents = 0
  and zone.minimum_order_cents = 0;

commit;
