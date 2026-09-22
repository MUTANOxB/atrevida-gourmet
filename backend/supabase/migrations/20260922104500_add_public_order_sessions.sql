-- Anonymous, backend-only browser sessions for persistent public order tracking.
-- Raw cookie tokens never reach the database; only their SHA-256 hex digest is stored.

create table public.public_order_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint public_order_sessions_token_hash_format
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint public_order_sessions_expiry_valid
    check (expires_at > created_at)
);

create index public_order_sessions_expires_at_idx
  on public.public_order_sessions(expires_at);

create table public.public_order_session_orders (
  session_id uuid not null,
  order_id uuid not null,
  store_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (session_id, order_id),
  constraint public_order_session_orders_session_fkey
    foreign key (session_id)
    references public.public_order_sessions(id)
    on delete cascade,
  constraint public_order_session_orders_order_store_fkey
    foreign key (order_id, store_id)
    references public.orders(id, store_id)
    on delete cascade
);

create index public_order_session_orders_session_store_created_idx
  on public.public_order_session_orders(session_id, store_id, created_at desc);

create index public_order_session_orders_order_store_idx
  on public.public_order_session_orders(order_id, store_id);

alter table public.public_order_sessions enable row level security;
alter table public.public_order_session_orders enable row level security;

revoke all on table public.public_order_sessions from public, anon, authenticated;
revoke all on table public.public_order_session_orders from public, anon, authenticated;

grant select, insert, update on table public.public_order_sessions to service_role;
grant select, insert on table public.public_order_session_orders to service_role;
