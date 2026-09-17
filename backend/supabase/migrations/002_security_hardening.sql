-- ============================================================
-- SECURITY HARDENING
-- Supabase/PostgreSQL
-- ============================================================

-- 1) Tabela de idempotência para bloquear replay de checkout.
create table if not exists public.idempotency_keys (
  key text primary key,
  request_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_idempotency_expiry
  on public.idempotency_keys(expires_at);

alter table public.idempotency_keys enable row level security;

-- 2) Bloquear acesso direto via anon/authenticated.
-- A API server-side usa service_role e continua funcionando.
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

-- 3) Bloquear execução ampla de funções públicas por padrão.
revoke all on function public.set_updated_at() from public;
grant execute on function public.set_updated_at() to service_role;

-- 4) Remover grants default perigosos para objetos futuros.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;

alter default privileges in schema public
  revoke all on sequences from anon, authenticated;

alter default privileges in schema public
  revoke execute on functions from public;

-- 5) Garantir que tracking token não seja sequencial.
alter table public.orders
  alter column tracking_token set default gen_random_uuid();

-- 6) Constraint adicional: total = subtotal + entrega.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_total_consistency'
  ) then
    alter table public.orders
      add constraint orders_total_consistency
      check (total_cents = subtotal_cents + delivery_fee_cents);
  end if;
end $$;

-- 7) Índices para consultas admin sem scan desnecessário.
create index if not exists idx_orders_store_created
  on public.orders(store_id, created_at desc);

create index if not exists idx_orders_store_phone
  on public.orders(store_id, customer_phone);

-- 8) Limpeza de idempotency expirado.
create or replace function public.cleanup_expired_idempotency_keys()
returns integer
language plpgsql
security definer
set search_path = public
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

revoke all on function public.cleanup_expired_idempotency_keys() from public;
grant execute on function public.cleanup_expired_idempotency_keys() to service_role;

-- 9) Observação:
-- Não criamos policies públicas de SELECT/INSERT.
-- O navegador NÃO deve falar diretamente com essas tabelas.
-- Toda leitura/escrita comercial passa pelo backend validado.
