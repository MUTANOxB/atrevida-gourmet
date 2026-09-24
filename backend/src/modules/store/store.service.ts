import { HttpError } from "../../lib/errors.js";
import { supabaseAdmin } from "../../lib/supabase.js";

function normalized(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("pt-BR");
}

export async function quoteDelivery(input: {
  storeSlug: string;
  neighborhood: string;
  postalCode?: string;
}) {
  const { data: store, error: storeError } = await supabaseAdmin
    .from("stores")
    .select("id, delivery_fee_mode, fixed_delivery_fee_cents, minimum_order_cents, setup_complete, accepts_delivery")
    .eq("slug", input.storeSlug)
    .eq("active", true)
    .maybeSingle();
  if (storeError) throw new HttpError(503, "Não foi possível consultar a entrega.");
  if (!store) throw new HttpError(404, "Loja não encontrada.");
  if (!store.setup_complete || !store.accepts_delivery) {
    return { available: false, reason: "Entrega ainda não configurada." };
  }

  if (store.delivery_fee_mode === "fixed") {
    if (store.fixed_delivery_fee_cents == null) {
      return { available: false, mode: "fixed", reason: "Entrega ainda não configurada." };
    }
    return {
      available: true,
      mode: "fixed",
      zoneId: null,
      feeCents: store.fixed_delivery_fee_cents,
      minimumOrderCents: store.minimum_order_cents
    };
  }

  const { data: zones, error } = await supabaseAdmin
    .from("delivery_zones")
    .select("id, name, fee_cents, minimum_order_cents")
    .eq("store_id", store.id)
    .eq("active", true)
    .limit(200);
  if (error) throw new HttpError(503, "Não foi possível consultar a entrega.");
  const zone = (zones ?? []).find(
    (candidate) => normalized(candidate.name) === normalized(input.neighborhood)
  );
  if (!zone) {
    return { available: false, reason: "Região ainda não cadastrada para entrega." };
  }
  return {
    available: true,
    mode: "zones",
    zoneId: zone.id,
    zoneName: zone.name,
    feeCents: zone.fee_cents,
    minimumOrderCents: zone.minimum_order_cents
  };
}
