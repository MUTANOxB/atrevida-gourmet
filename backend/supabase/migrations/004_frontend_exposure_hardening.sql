-- Frontend exposure hardening.

-- O browser NÃO acessa as tabelas diretamente neste projeto.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;

revoke all on all tables in schema public from authenticated;
revoke all on all sequences in schema public from authenticated;

-- Manter RLS ligado mesmo com grants revogados: defesa em profundidade.
alter table public.stores enable row level security;
alter table public.store_members enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_option_groups enable row level security;
alter table public.product_option_values enable row level security;
alter table public.delivery_zones enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- Não criar policies públicas "select all".
-- Toda exposição pública passa pelo backend e DTO/allowlist.
