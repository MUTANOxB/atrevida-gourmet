begin;

do $$
begin
  create type public.payment_status as enum (
    'pending',
    'pay_on_delivery',
    'approved',
    'rejected',
    'cancelled',
    'refunded'
  );
exception when duplicate_object then null;
end
$$;

do $$
begin
  create type public.payment_provider as enum (
    'offline',
    'direct_pix',
    'mercado_pago'
  );
exception when duplicate_object then null;
end
$$;

alter table public.stores
  add column if not exists pix_key text,
  add column if not exists pix_merchant_name text,
  add column if not exists pix_merchant_city text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.stores'::regclass
      and conname = 'stores_pix_configuration_lengths'
  ) then
    alter table public.stores
      add constraint stores_pix_configuration_lengths
      check (
        (pix_key is null or char_length(btrim(pix_key)) between 1 and 77)
        and (pix_merchant_name is null or char_length(btrim(pix_merchant_name)) between 1 and 25)
        and (pix_merchant_city is null or char_length(btrim(pix_merchant_city)) between 1 and 15)
      ) not valid;
  end if;
end
$$;

alter table public.stores
  validate constraint stores_pix_configuration_lengths;

alter table public.orders
  add column if not exists payment_status public.payment_status,
  add column if not exists payment_provider public.payment_provider,
  add column if not exists payment_paid_at timestamptz,
  add column if not exists payment_confirmed_by uuid references auth.users(id) on delete set null;

update public.orders
set
  payment_provider = case
    when payment_method = 'pix' then 'direct_pix'::public.payment_provider
    else 'offline'::public.payment_provider
  end,
  payment_status = case
    when payment_method = 'pix' then 'pending'::public.payment_status
    else 'pay_on_delivery'::public.payment_status
  end
where payment_provider is null
   or payment_status is null;

alter table public.orders
  alter column payment_provider set not null,
  alter column payment_status set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_payment_method_provider_consistency'
  ) then
    alter table public.orders
      add constraint orders_payment_method_provider_consistency
      check (
        (payment_method = 'pix' and payment_provider in ('direct_pix', 'mercado_pago'))
        or
        (payment_method in ('cash', 'card_on_delivery') and payment_provider = 'offline')
      ) not valid;
  end if;
end
$$;

alter table public.orders
  validate constraint orders_payment_method_provider_consistency;

create or replace function public.set_order_payment_initial_state()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' or new.payment_method is distinct from old.payment_method then
    if new.payment_method = 'pix' then
      new.payment_provider = 'direct_pix';
      new.payment_status = 'pending';
    else
      new.payment_provider = 'offline';
      new.payment_status = 'pay_on_delivery';
    end if;
    new.payment_paid_at = null;
    new.payment_confirmed_by = null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_orders_payment_initial_state on public.orders;
create trigger trg_orders_payment_initial_state
before insert or update of payment_method on public.orders
for each row execute function public.set_order_payment_initial_state();

create or replace function public.guard_pending_direct_pix_acceptance()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status = 'pending'
     and new.status = 'confirmed'
     and new.payment_provider = 'direct_pix'
     and new.payment_status = 'pending' then
    raise exception 'Confirme o recebimento do Pix antes de aceitar o pedido.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_orders_guard_pending_direct_pix on public.orders;
create trigger trg_orders_guard_pending_direct_pix
before update of status on public.orders
for each row execute function public.guard_pending_direct_pix_acceptance();

create index if not exists idx_orders_store_payment_status
  on public.orders(store_id, payment_status, created_at desc);

revoke all on function public.set_order_payment_initial_state() from public, anon, authenticated;
revoke all on function public.guard_pending_direct_pix_acceptance() from public, anon, authenticated;
grant execute on function public.set_order_payment_initial_state() to service_role;
grant execute on function public.guard_pending_direct_pix_acceptance() to service_role;

commit;
