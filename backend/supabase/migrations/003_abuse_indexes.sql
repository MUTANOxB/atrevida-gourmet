-- Índices auxiliares para manter consultas rápidas sob carga.

create index if not exists idx_orders_store_status_created
  on public.orders(store_id, status, created_at desc);

create index if not exists idx_products_store_active
  on public.products(store_id, active, category_id, sort_order);

create index if not exists idx_delivery_zones_store_active
  on public.delivery_zones(store_id, active, name);

-- A tabela idempotency_keys foi criada no security pack anterior.
-- Limpeza deve ser executada periodicamente pelo scheduler da plataforma.
