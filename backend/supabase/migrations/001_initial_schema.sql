-- Atrevida / white-label delivery backend
-- Supabase PostgreSQL schema

create extension if not exists "pgcrypto";

do $$ begin
  create type public.store_member_role as enum ('owner', 'manager', 'staff');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.order_status as enum (
    'pending',
    'confirmed',
    'preparing',
    'ready',
    'out_for_delivery',
    'completed',
    'cancelled'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.fulfillment_type as enum ('delivery', 'pickup', 'scheduled');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.payment_method as enum ('pix', 'cash', 'card_on_delivery');
exception when duplicate_object then null;
end $$;

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  logo_url text,
  active boolean not null default true,
  is_open boolean not null default true,
  accepts_delivery boolean not null default true,
  accepts_pickup boolean not null default true,
  accepts_scheduled_orders boolean not null default true,
  minimum_order_cents integer not null default 0 check (minimum_order_cents >= 0),
  currency text not null default 'BRL',
  timezone text not null default 'America/Sao_Paulo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.store_members (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.store_member_role not null default 'staff',
  created_at timestamptz not null default now(),
  unique (store_id, user_id)
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  slug text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (store_id, slug)
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete restrict,
  name text not null,
  description text not null default '',
  image_url text,
  price_cents integer check (price_cents is null or price_cents >= 0),
  active boolean not null default true,
  featured boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_option_groups (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,
  required boolean not null default false,
  min_select integer not null default 0 check (min_select >= 0),
  max_select integer not null default 1 check (max_select >= 1),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (max_select >= min_select)
);

create table if not exists public.product_option_values (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.product_option_groups(id) on delete cascade,
  name text not null,
  price_delta_cents integer not null default 0,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.delivery_zones (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  fee_cents integer not null default 0 check (fee_cents >= 0),
  minimum_order_cents integer not null default 0 check (minimum_order_cents >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (store_id, name)
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  order_number text not null,
  tracking_token uuid not null default gen_random_uuid() unique,
  status public.order_status not null default 'pending',
  fulfillment_type public.fulfillment_type not null,

  customer_name text not null,
  customer_phone text not null,

  delivery_postal_code text,
  delivery_street text,
  delivery_number text,
  delivery_neighborhood text,
  delivery_complement text,
  delivery_reference text,
  delivery_zone_id uuid references public.delivery_zones(id) on delete set null,

  scheduled_for timestamptz,

  payment_method public.payment_method not null,
  change_for_cents integer check (change_for_cents is null or change_for_cents >= 0),

  note text not null default '',

  subtotal_cents integer not null check (subtotal_cents >= 0),
  delivery_fee_cents integer not null default 0 check (delivery_fee_cents >= 0),
  total_cents integer not null check (total_cents >= 0),

  accepted_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (store_id, order_number)
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name_snapshot text not null,
  unit_price_cents integer not null check (unit_price_cents >= 0),
  quantity integer not null check (quantity > 0),
  line_total_cents integer not null check (line_total_cents >= 0),
  note text not null default '',
  options_snapshot jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_categories_store on public.categories(store_id, sort_order);
create index if not exists idx_products_store on public.products(store_id, category_id, active, sort_order);
create index if not exists idx_orders_store_status on public.orders(store_id, status, created_at desc);
create index if not exists idx_orders_tracking on public.orders(tracking_token);
create index if not exists idx_order_items_order on public.order_items(order_id);

-- Automatic updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_stores_updated_at on public.stores;
create trigger trg_stores_updated_at
before update on public.stores
for each row execute function public.set_updated_at();

drop trigger if exists trg_products_updated_at on public.products;
create trigger trg_products_updated_at
before update on public.products
for each row execute function public.set_updated_at();

drop trigger if exists trg_orders_updated_at on public.orders;
create trigger trg_orders_updated_at
before update on public.orders
for each row execute function public.set_updated_at();

-- RLS
alter table public.stores enable row level security;
alter table public.store_members enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_option_groups enable row level security;
alter table public.product_option_values enable row level security;
alter table public.delivery_zones enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- The API server uses the service role for validated writes.
-- We intentionally do NOT add public insert/update policies for orders.
-- Public catalog access happens through the backend route, not direct browser DB access.

-- Realtime support for orders.
alter table public.orders replica identity full;
