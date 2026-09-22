import { HttpError } from "../../lib/errors.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import {
  effectiveInventory,
  storeLocalDate
} from "../inventory/inventory.service.js";
import { evaluateStoreSchedule } from "../store/availability.js";

export async function getPublicCatalog(storeSlug: string) {
  const { data: store, error } = await supabaseAdmin
    .from("stores")
    .select(`
      id, slug, name, description, logo_url, setup_complete, is_open,
      accepts_delivery, accepts_pickup, accepts_scheduled_orders,
      minimum_order_cents, currency, timezone, instagram_handle,
      whatsapp_e164, whatsapp_display, pix_key, pix_merchant_name, pix_merchant_city,
      categories(
        id, name, slug, sort_order, active,
        products!products_category_same_store_fkey(
          id, category_id, name, description, image_url, price_cents,
          active, featured, sort_order,
          product_option_groups(
            id, name, required, min_select, max_select, active, sort_order,
            product_option_values(
              id, name, price_delta_cents, active, sort_order
            )
          )
        )
      ),
      store_payment_methods(method, label, instructions, active, sort_order),
      store_hours(day_of_week, opens_at, closes_at, active),
      store_schedule_exceptions(exception_date, is_closed, opens_at, closes_at)
    `)
    .eq("slug", storeSlug)
    .eq("active", true)
    .maybeSingle();
  if (error) throw new HttpError(503, "Não foi possível carregar o cardápio.");
  if (!store) throw new HttpError(404, "Loja não encontrada.");

  const schedule = evaluateStoreSchedule({
    at: new Date(),
    timezone: store.timezone,
    hours: store.store_hours ?? [],
    exceptions: store.store_schedule_exceptions ?? []
  });
  const setupComplete = !!store.setup_complete;
  const isOpen = setupComplete && !!store.is_open && schedule.configured && schedule.open;
  const productIds = (store.categories ?? [])
    .flatMap((category: any) => category.products ?? [])
    .map((product: any) => product.id as string);
  const inventoryDate = storeLocalDate(store.timezone);
  const settingsByProduct = new Map<string, any>();
  const dailyByProduct = new Map<string, any>();
  if (productIds.length) {
    const [settingsResult, dailyResult] = await Promise.all([
      supabaseAdmin
        .from("product_inventory_settings")
        .select("product_id, stock_mode")
        .eq("store_id", store.id)
        .in("product_id", productIds),
      supabaseAdmin
        .from("product_inventory_daily")
        .select("product_id, inventory_date, available, prepared_quantity, quantity_remaining")
        .eq("store_id", store.id)
        .eq("inventory_date", inventoryDate)
        .in("product_id", productIds)
    ]);
    if (settingsResult.error || dailyResult.error) {
      throw new HttpError(503, "Não foi possível carregar a disponibilidade do cardápio.");
    }
    for (const setting of settingsResult.data ?? []) {
      settingsByProduct.set(setting.product_id, setting);
    }
    for (const daily of dailyResult.data ?? []) {
      dailyByProduct.set(daily.product_id, daily);
    }
  }

  return {
    slug: store.slug,
    name: store.name,
    description: store.description,
    logoUrl: store.logo_url,
    instagram: store.instagram_handle,
    whatsappDisplay: store.whatsapp_display,
    whatsappE164: store.whatsapp_e164,
    setupComplete,
    isOpen,
    scheduleConfigured: schedule.configured,
    availabilityMessage: !setupComplete
      ? "Loja em configuração."
      : !schedule.configured
        ? "Horários ainda não configurados."
        : isOpen
          ? "Aberto agora."
          : "Fechado no momento.",
    acceptsDelivery: setupComplete && store.accepts_delivery,
    acceptsPickup: setupComplete && store.accepts_pickup,
    acceptsScheduledOrders: setupComplete && store.accepts_scheduled_orders,
    minimumOrderCents: store.minimum_order_cents,
    currency: store.currency,
    paymentMethods: (store.store_payment_methods ?? [])
      .filter((method: any) => method.active && (
        method.method !== "pix" || Boolean(
          store.pix_key?.trim() &&
          store.pix_merchant_name?.trim() &&
          store.pix_merchant_city?.trim()
        )
      ))
      .sort((left: any, right: any) => left.sort_order - right.sort_order)
      .map((method: any) => ({
        method: method.method,
        label: method.label,
        instructions: method.instructions
      })),
    hours: (store.store_hours ?? [])
      .filter((hour: any) => hour.active)
      .sort((left: any, right: any) =>
        left.day_of_week - right.day_of_week || left.opens_at.localeCompare(right.opens_at)
      )
      .map((hour: any) => ({
        dayOfWeek: hour.day_of_week,
        openTime: hour.opens_at,
        closeTime: hour.closes_at
      })),
    categories: (store.categories ?? [])
      .filter((category: any) => category.active)
      .sort((left: any, right: any) => left.sort_order - right.sort_order)
      .map((category: any) => ({
        id: category.id,
        name: category.name,
        slug: category.slug,
        products: (category.products ?? [])
          .filter((product: any) => product.active && product.price_cents != null)
          .sort((left: any, right: any) => left.sort_order - right.sort_order)
          .map((product: any) => {
            const inventory = effectiveInventory(
              settingsByProduct.get(product.id),
              dailyByProduct.get(product.id)
            );
            return {
              id: product.id,
              categoryId: product.category_id,
              name: product.name,
              description: product.description,
              imageUrl: product.image_url,
              priceCents: product.price_cents,
              featured: product.featured,
              ...inventory,
              optionGroups: (product.product_option_groups ?? [])
              .filter((group: any) => group.active)
              .sort((left: any, right: any) => left.sort_order - right.sort_order)
              .map((group: any) => ({
                id: group.id,
                name: group.name,
                required: group.required,
                minSelect: group.min_select,
                maxSelect: group.max_select,
                values: (group.product_option_values ?? [])
                  .filter((value: any) => value.active)
                  .sort((left: any, right: any) => left.sort_order - right.sort_order)
                  .map((value: any) => ({
                    id: value.id,
                    name: value.name,
                    priceDeltaCents: value.price_delta_cents
                  }))
              }))
            };
          })
      }))
  };
}
