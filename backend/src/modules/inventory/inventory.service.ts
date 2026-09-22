import { HttpError } from "../../lib/errors.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import type {
  AdjustInventoryInput,
  StockMode,
  UpdateInventoryInput
} from "./inventory.schemas.js";

export const LOW_STOCK_LIMIT = 5;
const STOCK_CONFLICT_MARKER = "ATREVIDA_STOCK_CONFLICT";

type InventorySetting = { product_id: string; stock_mode: StockMode };
type InventoryDaily = {
  product_id: string;
  inventory_date: string;
  available: boolean;
  prepared_quantity: number;
  quantity_remaining: number;
};
type InventoryEvent = {
  product_id: string;
  inventory_date: string;
  event_type: "sale" | "cancel_return" | "sold_out";
  quantity_delta: number;
  created_at: string;
};
type Actor = { storeId: string; userId: string };

export function storeLocalDate(timezone: string, at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(at);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (!values.year || !values.month || !values.day) throw new RangeError("invalid date");
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    throw new HttpError(503, "Não foi possível determinar a data local da loja.");
  }
}

export function effectiveInventory(
  setting: InventorySetting | undefined,
  daily: InventoryDaily | undefined
) {
  const stockMode = setting?.stock_mode ?? "always";
  if (stockMode === "always") {
    return { stockMode, available: true, remainingQuantity: null, lowStock: false };
  }
  if (stockMode === "manual") {
    return {
      stockMode,
      available: daily?.available === true,
      remainingQuantity: null,
      lowStock: false
    };
  }
  const remainingQuantity = Number.isInteger(daily?.quantity_remaining)
    ? Math.max(0, daily!.quantity_remaining)
    : 0;
  const available = daily?.available === true && remainingQuantity > 0;
  return {
    stockMode,
    available,
    remainingQuantity,
    lowStock: available && remainingQuantity <= LOW_STOCK_LIMIT
  };
}

export function isStockConflictError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "P0001" && candidate.message === STOCK_CONFLICT_MARKER;
}

export async function listDailyInventory(storeId: string, at = new Date()) {
  const { data: store, error: storeError } = await supabaseAdmin
    .from("stores")
    .select("timezone")
    .eq("id", storeId)
    .maybeSingle();
  if (storeError || !store) throw new HttpError(503, "Falha ao carregar o estoque do dia.");

  const inventoryDate = storeLocalDate(store.timezone, at);
  const cutoff = new Date(at.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: products, error: productsError } = await supabaseAdmin
    .from("products")
    .select(`
      id, name, image_url, sort_order,
      category:categories!products_category_same_store_fkey(name)
    `)
    .eq("store_id", storeId)
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (productsError) throw new HttpError(503, "Falha ao carregar o estoque do dia.");

  const productIds = (products ?? []).map((product: any) => product.id as string);
  if (!productIds.length) {
    return {
      inventoryDate,
      summary: { available: 0, soldOut: 0, lowStock: 0 },
      products: []
    };
  }

  const [settingsResult, dailyResult, eventsResult] = await Promise.all([
    supabaseAdmin
      .from("product_inventory_settings")
      .select("product_id, stock_mode")
      .eq("store_id", storeId)
      .in("product_id", productIds),
    supabaseAdmin
      .from("product_inventory_daily")
      .select("product_id, inventory_date, available, prepared_quantity, quantity_remaining")
      .eq("store_id", storeId)
      .eq("inventory_date", inventoryDate)
      .in("product_id", productIds),
    supabaseAdmin
      .from("product_inventory_events")
      .select("product_id, inventory_date, event_type, quantity_delta, created_at")
      .eq("store_id", storeId)
      .in("product_id", productIds)
      .in("event_type", ["sale", "cancel_return", "sold_out"])
      .gte("created_at", cutoff)
  ]);
  if (settingsResult.error || dailyResult.error || eventsResult.error) {
    throw new HttpError(503, "Falha ao carregar o estoque do dia.");
  }

  const settings = new Map(
    (settingsResult.data ?? []).map((row: any) => [row.product_id, row as InventorySetting])
  );
  const daily = new Map(
    (dailyResult.data ?? []).map((row: any) => [row.product_id, row as InventoryDaily])
  );
  const events = eventsResult.data as InventoryEvent[] ?? [];

  const items = (products ?? []).map((product: any) => {
    const day = daily.get(product.id);
    const state = effectiveInventory(settings.get(product.id), day);
    const netConsumed = events
      .filter((event) =>
        event.product_id === product.id &&
        event.inventory_date === inventoryDate &&
        ["sale", "cancel_return"].includes(event.event_type)
      )
      .reduce((sum, event) => sum + event.quantity_delta, 0);
    const category = Array.isArray(product.category)
      ? product.category[0]
      : product.category;
    return {
      id: product.id,
      name: product.name,
      imageUrl: product.image_url,
      categoryName: category?.name ?? "Sem categoria",
      ...state,
      preparedToday: day?.prepared_quantity ?? 0,
      soldToday: Math.max(0, -netConsumed),
      remaining: state.stockMode === "quantity" ? state.remainingQuantity : null,
      soldOutLast30Days: events.filter((event) =>
        event.product_id === product.id && event.event_type === "sold_out"
      ).length
    };
  });

  return {
    inventoryDate,
    summary: {
      available: items.filter((item) => item.available).length,
      soldOut: items.filter((item) => !item.available).length,
      lowStock: items.filter((item) => item.lowStock).length
    },
    products: items
  };
}

export async function updateDailyInventory(
  actor: Actor,
  productId: string,
  input: UpdateInventoryInput
) {
  const { data, error } = await supabaseAdmin.rpc("set_daily_product_inventory", {
    p_store_id: actor.storeId,
    p_product_id: productId,
    p_stock_mode: input.stockMode ?? null,
    p_available: input.available ?? null,
    p_prepared_quantity: input.preparedToday ?? null,
    p_quantity_remaining: input.quantityRemaining ?? null,
    p_actor_user_id: actor.userId
  });
  if (error?.code === "P0002") throw new HttpError(404, "Produto não encontrado.");
  if (error?.code === "22023") throw new HttpError(409, "Os valores informados não são válidos para o estoque.");
  if (error) throw new HttpError(503, "Falha ao atualizar o estoque.");

  return data;
}

export async function adjustDailyInventory(
  actor: Actor,
  productId: string,
  input: AdjustInventoryInput
) {
  const { data, error } = await supabaseAdmin.rpc("adjust_daily_product_inventory", {
    p_store_id: actor.storeId,
    p_product_id: productId,
    p_quantity_delta: input.quantityDelta,
    p_prepared_delta: input.preparedDelta,
    p_actor_user_id: actor.userId
  });
  if (error?.code === "P0002") throw new HttpError(409, "Ative o controle por quantidade antes de ajustar o estoque.");
  if (error?.code === "22023") throw new HttpError(409, "O ajuste deixaria o estoque fora dos limites permitidos.");
  if (error) throw new HttpError(503, "Falha ao ajustar o estoque.");

  return data;
}
