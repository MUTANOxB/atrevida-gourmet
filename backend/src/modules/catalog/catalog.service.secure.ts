import { HttpError } from "../../lib/errors.js";
import { supabaseServer } from "../../lib/supabase-secure.js";

/**
 * SELECT explícito.
 *
 * Não usar:
 *   .select("*")
 *
 * em endpoint público.
 */
export async function getSecurePublicCatalog(storeSlug: string) {
  const { data: store, error } = await supabaseServer
    .from("stores")
    .select(`
      slug,
      name,
      description,
      logo_url,
      is_open,
      accepts_delivery,
      accepts_pickup,
      accepts_scheduled_orders,
      minimum_order_cents,
      currency,
      categories (
        id,
        name,
        slug,
        sort_order,
        products (
          id,
          category_id,
          name,
          description,
          image_url,
          price_cents,
          featured,
          sort_order,
          product_option_groups (
            id,
            name,
            required,
            min_select,
            max_select,
            sort_order,
            product_option_values (
              id,
              name,
              price_delta_cents,
              sort_order
            )
          )
        )
      )
    `)
    .eq("slug", storeSlug)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Não foi possível carregar o cardápio.");
  }

  if (!store) {
    throw new HttpError(404, "Loja não encontrada.");
  }

  return {
    slug: store.slug,
    name: store.name,
    description: store.description,
    logoUrl: store.logo_url,
    isOpen: store.is_open,
    acceptsDelivery: store.accepts_delivery,
    acceptsPickup: store.accepts_pickup,
    acceptsScheduledOrders: store.accepts_scheduled_orders,
    minimumOrderCents: store.minimum_order_cents,
    currency: store.currency,

    categories: (store.categories || [])
      .sort((a: any, b: any) => a.sort_order - b.sort_order)
      .map((category: any) => ({
        id: category.id,
        name: category.name,
        slug: category.slug,

        products: (category.products || [])
          .sort((a: any, b: any) => a.sort_order - b.sort_order)
          .map((product: any) => ({
            id: product.id,
            categoryId: product.category_id,
            name: product.name,
            description: product.description,
            imageUrl: product.image_url,
            priceCents: product.price_cents,
            featured: product.featured,

            optionGroups: (product.product_option_groups || [])
              .sort((a: any, b: any) => a.sort_order - b.sort_order)
              .map((group: any) => ({
                id: group.id,
                name: group.name,
                required: group.required,
                minSelect: group.min_select,
                maxSelect: group.max_select,

                values: (group.product_option_values || [])
                  .sort((a: any, b: any) => a.sort_order - b.sort_order)
                  .map((value: any) => ({
                    id: value.id,
                    name: value.name,
                    priceDeltaCents: value.price_delta_cents
                  }))
              }))
          }))
      }))
  };
}
