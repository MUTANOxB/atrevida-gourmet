-- ============================================================
-- Database security completion
--
-- This migration is intentionally incremental: 001-005 remain the source
-- history. It makes application grants explicit, validates every legacy
-- constraint introduced as NOT VALID, and closes the remaining tenant and
-- delivery-zone integrity gaps.
-- ============================================================

begin;

do $$
begin
  if to_regrole('service_role') is null
     or to_regrole('anon') is null
     or to_regrole('authenticated') is null then
    raise exception using
      message = 'Migration 006 requires the Supabase roles service_role, anon and authenticated.',
      hint = 'On a local PostgreSQL test instance, create the documented stub roles before applying migrations.';
  end if;
end
$$;

-- Validate all constraints that 001-005 deliberately installed as NOT VALID.
-- PostgreSQL enforces those constraints for new writes, but validation is
-- still required before the schema can be considered production-ready.
do $$
declare
  target record;
  validation_error text;
begin
  for target in
    select
      n.nspname as schema_name,
      c.relname as table_name,
      constraint_row.conname as constraint_name
    from pg_constraint constraint_row
    join pg_class c on c.oid = constraint_row.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any (array[
        'stores',
        'products',
        'product_option_groups',
        'orders',
        'order_items',
        'idempotency_keys',
        'order_status_history'
      ])
      and constraint_row.contype in ('c', 'f')
      and not constraint_row.convalidated
    order by c.relname, constraint_row.conname
  loop
    begin
      execute format(
        'alter table %I.%I validate constraint %I',
        target.schema_name,
        target.table_name,
        target.constraint_name
      );
    exception when others then
      get stacked diagnostics validation_error = message_text;
      raise exception using
        errcode = '23514',
        message = format(
          'Migration 006 preflight failed while validating %I on %I.%I.',
          target.constraint_name,
          target.schema_name,
          target.table_name
        ),
        detail = validation_error,
        hint = 'Repair the legacy rows reported by this constraint and rerun 006. The migration is transactional and made no partial change.';
    end;
  end loop;
end
$$;

-- A deterministic normalization key prevents ambiguous delivery fees for
-- names such as "Centro", " centro " and "CÃ‰NTRO". translate() keeps this
-- independent of the optional unaccent extension and its dictionary state.
create or replace function public.normalize_delivery_zone_name(input text)
returns text
language sql
immutable
strict
parallel safe
set search_path = pg_catalog
as $$
  select translate(
    lower(regexp_replace(btrim(input), '[[:space:]]+', ' ', 'g')),
    'Ã¡Ã Ã¢Ã£Ã¤Ã¥Ã©Ã¨ÃªÃ«Ã­Ã¬Ã®Ã¯Ã³Ã²Ã´ÃµÃ¶ÃºÃ¹Ã»Ã¼Ã§Ã±',
    'aaaaaaeeeeiiiiooooouuuucn'
  );
$$;

do $$
declare
  invalid_detail text;
  duplicate_detail text;
begin
  select string_agg(format('store=%s zone_id=%s', store_id, id), ', ')
  into invalid_detail
  from (
    select store_id, id
    from public.delivery_zones
    where public.normalize_delivery_zone_name(name) = ''
       or char_length(btrim(name)) > 100
    order by store_id, id
    limit 10
  ) invalid_zone;

  if invalid_detail is not null then
    raise exception using
      errcode = '23514',
      message = 'Migration 006 found blank or oversized delivery-zone names.',
      detail = invalid_detail,
      hint = 'Rename these zones to a non-blank name of at most 100 characters, then rerun 006.';
  end if;

  select string_agg(
    format('store=%s normalized_name=%L rows=%s', store_id, normalized_name, row_count),
    '; '
  )
  into duplicate_detail
  from (
    select
      store_id,
      public.normalize_delivery_zone_name(name) as normalized_name,
      count(*) as row_count
    from public.delivery_zones
    group by store_id, public.normalize_delivery_zone_name(name)
    having count(*) > 1
    order by store_id, public.normalize_delivery_zone_name(name)
    limit 10
  ) duplicate_zone;

  if duplicate_detail is not null then
    raise exception using
      errcode = '23505',
      message = 'Migration 006 found duplicate normalized delivery-zone names.',
      detail = duplicate_detail,
      hint = 'Merge or rename the duplicate zones after confirming the correct fee and minimum order, then rerun 006.';
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.delivery_zones'::regclass
      and conname = 'delivery_zones_name_valid'
  ) then
    alter table public.delivery_zones
      add constraint delivery_zones_name_valid
      check (
        char_length(btrim(name)) between 1 and 100
        and public.normalize_delivery_zone_name(name) <> ''
      )
      not valid;
  end if;
end
$$;

alter table public.delivery_zones
  validate constraint delivery_zones_name_valid;

create unique index if not exists uq_delivery_zones_store_normalized_name
  on public.delivery_zones (
    store_id,
    public.normalize_delivery_zone_name(name)
  );

-- Replace the original SET NULL FK and the provisional composite FK with one
-- tenant-safe RESTRICT relationship. Historical delivery orders must retain
-- the zone that determined their fee; admins should deactivate zones instead.
alter table public.orders
  drop constraint if exists orders_delivery_zone_id_fkey;

alter table public.orders
  drop constraint if exists orders_delivery_zone_same_store_fkey;

alter table public.orders
  add constraint orders_delivery_zone_same_store_fkey
  foreign key (delivery_zone_id, store_id)
  references public.delivery_zones(id, store_id)
  on delete restrict
  not valid;

alter table public.orders
  validate constraint orders_delivery_zone_same_store_fkey;

-- Idempotency responses may only reference an order from the same tenant.
do $$
declare
  mismatch_detail text;
begin
  select string_agg(
    format(
      'idempotency_id=%s reservation_store=%s order_id=%s order_store=%s',
      reservation.id,
      reservation.store_id,
      reservation.order_id,
      order_row.store_id
    ),
    '; '
  )
  into mismatch_detail
  from (
    select i.id, i.store_id, i.order_id
    from public.idempotency_keys i
    where i.order_id is not null
    order by i.id
    limit 1000
  ) reservation
  join public.orders order_row on order_row.id = reservation.order_id
  where reservation.store_id is distinct from order_row.store_id;

  if mismatch_detail is not null then
    raise exception using
      errcode = '23503',
      message = 'Migration 006 found cross-store idempotency/order references.',
      detail = mismatch_detail,
      hint = 'Investigate these reservations and assign the correct store_id before rerunning 006.';
  end if;
end
$$;

alter table public.idempotency_keys
  drop constraint if exists idempotency_keys_order_id_fkey;

alter table public.idempotency_keys
  drop constraint if exists idempotency_order_same_store_fkey;

alter table public.idempotency_keys
  add constraint idempotency_order_same_store_fkey
  foreign key (order_id, store_id)
  references public.orders(id, store_id)
  on delete restrict
  not valid;

alter table public.idempotency_keys
  validate constraint idempotency_order_same_store_fkey;

-- Tighten metadata paths to canonical UUID/UUID.ext form. The bucket itself
-- still validates MIME and size; the backend must decode and re-encode bytes.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.product_images'::regclass
      and conname = 'product_images_object_path_uuid_format'
  ) then
    alter table public.product_images
      add constraint product_images_object_path_uuid_format
      check (
        object_path ~ (
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/'
          || '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|avif)$'
        )
      )
      not valid;
  end if;
end
$$;

alter table public.product_images
  validate constraint product_images_object_path_uuid_format;

-- RLS remains defense in depth. Browser roles receive no commercial table,
-- sequence or function access; every public/admin operation crosses Fastify.
alter table public.stores enable row level security;
alter table public.store_members enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_option_groups enable row level security;
alter table public.product_option_values enable row level security;
alter table public.delivery_zones enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.store_hours enable row level security;
alter table public.store_schedule_exceptions enable row level security;
alter table public.store_payment_methods enable row level security;
alter table public.product_images enable row level security;
alter table public.order_status_history enable row level security;
alter table public.admin_audit_log enable row level security;

revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke create on schema public from public, anon, authenticated;

grant usage on schema public to service_role;

grant select, update on table public.stores to service_role;
grant select on table public.store_members to service_role;
grant select, insert, update, delete on table public.categories to service_role;
grant select, insert, update, delete on table public.products to service_role;
grant select, insert, update, delete on table public.product_option_groups to service_role;
grant select, insert, update, delete on table public.product_option_values to service_role;
grant select, insert, update, delete on table public.delivery_zones to service_role;
grant select, update on table public.orders to service_role;
grant select on table public.order_items to service_role;
grant select, insert, update, delete on table public.idempotency_keys to service_role;
grant select, insert, update, delete on table public.store_hours to service_role;
grant select, insert, update, delete on table public.store_schedule_exceptions to service_role;
grant select, insert, update, delete on table public.store_payment_methods to service_role;
grant select, insert, update, delete on table public.product_images to service_role;
grant select on table public.order_status_history to service_role;
grant select, insert on table public.admin_audit_log to service_role;
grant usage, select on all sequences in schema public to service_role;

grant execute on function public.cleanup_expired_idempotency_keys() to service_role;
grant execute on function public.store_is_open_at(uuid, timestamptz) to service_role;
grant execute on function public.create_order_with_items(jsonb, jsonb) to service_role;
grant execute on function public.normalize_delivery_zone_name(text) to service_role;

-- Keep cleanup's SECURITY DEFINER search path as narrow as the newer RPCs.
create or replace function public.cleanup_expired_idempotency_keys()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  deleted_count integer;
begin
  delete from public.idempotency_keys
  where expires_at < now();

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.cleanup_expired_idempotency_keys()
  from public, anon, authenticated;
grant execute on function public.cleanup_expired_idempotency_keys()
  to service_role;

-- Storage is managed by Supabase.
-- Do not alter storage.objects or its policies from this migration.
-- Browser uploads remain denied by default because there are no permissive
-- INSERT/UPDATE/DELETE policies for product-images.
-- Uploads and deletes are performed only by the backend through the Storage API.
comment on function public.normalize_delivery_zone_name(text) is
  'Canonical comparison key for delivery zones; not a customer-facing label.';

comment on constraint orders_delivery_zone_same_store_fkey on public.orders is
  'A historical delivery order retains a zone from the same store; deactivate zones instead of deleting referenced rows.';

comment on constraint idempotency_order_same_store_fkey on public.idempotency_keys is
  'An idempotency reservation can only reference an order from the same store.';

commit;

