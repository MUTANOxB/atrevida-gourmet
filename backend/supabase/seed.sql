-- ============================================================
-- Atrevida Gourmet seed
--
-- Only facts explicitly confirmed by the store briefing are included.
-- Commercial availability starts disabled at store level until an admin
-- configures hours, fulfillment, payment methods and (for delivery) zones.
-- No neighborhood, fee, minimum, opening hour, lead time, flavor, address
-- or payment method is inferred here.
-- ============================================================

insert into public.stores (
  slug,
  name,
  description,
  active,
  setup_complete,
  is_open,
  accepts_delivery,
  accepts_pickup,
  accepts_scheduled_orders,
  instagram_handle,
  whatsapp_e164,
  whatsapp_display
)
values (
  'atrevida-gourmet',
  'Atrevida Gourmet',
  null,
  true,
  false,
  false,
  false,
  false,
  false,
  '@atrevida_gourmet',
  '+5514997875460',
  '(14) 99787-5460'
)
on conflict (slug) do update
set
  name = excluded.name,
  instagram_handle = excluded.instagram_handle,
  whatsapp_e164 = excluded.whatsapp_e164,
  whatsapp_display = excluded.whatsapp_display;

-- Preserve products linked to the exact legacy seed category while adopting
-- the confirmed commercial name/slug. If the destination already exists,
-- leave both existing records untouched rather than deleting or merging data.
update public.categories category
set
  name = 'Doces e Sobremesas',
  slug = 'doces-e-sobremesas',
  sort_order = 20,
  active = true
from public.stores store
where category.store_id = store.id
  and store.slug = 'atrevida-gourmet'
  and category.name = 'Sobremesas'
  and category.slug = 'sobremesas'
  and not exists (
    select 1
    from public.categories confirmed
    where confirmed.store_id = store.id
      and confirmed.slug = 'doces-e-sobremesas'
  );

with target_store as (
  select id
  from public.stores
  where slug = 'atrevida-gourmet'
), seed_categories(name, slug, sort_order) as (
  values
    ('Salgados', 'salgados', 0),
    ('Crepes', 'crepes', 10),
    ('Doces e Sobremesas', 'doces-e-sobremesas', 20),
    ('Bolos', 'bolos', 30),
    ('Bebidas', 'bebidas', 40)
)
insert into public.categories (
  store_id,
  name,
  slug,
  sort_order,
  active
)
select
  target_store.id,
  seed_categories.name,
  seed_categories.slug,
  seed_categories.sort_order,
  true
from target_store
cross join seed_categories
on conflict (store_id, slug) do update
set
  name = excluded.name,
  sort_order = excluded.sort_order,
  active = true;

with target_store as (
  select id
  from public.stores
  where slug = 'atrevida-gourmet'
), seed_products(
  category_slug,
  name,
  price_cents,
  active,
  sort_order
) as (
  values
    -- Confirmed products and prices.
    ('doces-e-sobremesas', 'Cacerola', 600, true, 10),
    ('doces-e-sobremesas', 'Copo Pudim', 1500, true, 20),

    -- Known items without a confirmed price. NULL + inactive makes them
    -- visible to admins for completion but impossible to purchase.
    ('salgados', 'Coxinha', null, false, 10),
    ('salgados', 'Mini coxinhas', null, false, 20),
    ('salgados', 'Torta de frango', null, false, 30),
    ('doces-e-sobremesas', 'Pavê', null, false, 30),
    ('doces-e-sobremesas', 'Torta de Ferrero Rocher', null, false, 40),
    ('bolos', 'Bolos', null, false, 10),
    ('bebidas', 'Bebidas', null, false, 10)
)
insert into public.products (
  store_id,
  category_id,
  name,
  description,
  price_cents,
  active,
  featured,
  sort_order
)
select
  target_store.id,
  category.id,
  seed_products.name,
  '',
  seed_products.price_cents,
  seed_products.active,
  false,
  seed_products.sort_order
from target_store
join seed_products on true
join public.categories category
  on category.store_id = target_store.id
 and category.slug = seed_products.category_slug
where not exists (
  select 1
  from public.products existing
  where existing.store_id = target_store.id
    and existing.name = seed_products.name
);

-- Clean only descriptions introduced by the original demonstration seed.
-- Admin-authored descriptions are never overwritten.
update public.stores
set description = null
where slug = 'atrevida-gourmet'
  and description = 'Doces e salgados irresistíveis.';

update public.products product
set description = ''
from public.stores store
where product.store_id = store.id
  and store.slug = 'atrevida-gourmet'
  and (
    (product.name = 'Cacerola' and product.description = 'Sobremesa da Atrevida Gourmet.')
    or
    (product.name = 'Copo Pudim' and product.description = 'Copo pudim da Atrevida Gourmet.')
  );

-- Remove only the exact disabled placeholder from the old seed. No real
-- zone is deleted and no replacement is invented.
delete from public.delivery_zones zone
using public.stores store
where zone.store_id = store.id
  and store.slug = 'atrevida-gourmet'
  and zone.name = 'EXEMPLO - confirmar com a loja'
  and zone.active = false
  and zone.fee_cents = 0
  and zone.minimum_order_cents = 0;
