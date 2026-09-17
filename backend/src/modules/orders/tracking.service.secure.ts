import { HttpError } from "../../lib/errors.js";
import { supabaseServer } from "../../lib/supabase-secure.js";
import { publicOrderTrackingDto } from "../../lib/public-dto.js";

/**
 * Tracking público propositalmente não retorna PII.
 */
export async function secureTrackOrder(trackingToken: string) {
  const { data, error } = await supabaseServer
    .from("orders")
    .select(`
      order_number,
      status,
      fulfillment_type,
      subtotal_cents,
      delivery_fee_cents,
      total_cents,
      created_at,
      accepted_at,
      ready_at,
      completed_at,
      order_items (
        product_name_snapshot,
        unit_price_cents,
        quantity,
        line_total_cents,
        options_snapshot
      )
    `)
    .eq("tracking_token", trackingToken)
    .maybeSingle();

  if (error) {
    throw new HttpError(
      500,
      "Não foi possível consultar o pedido."
    );
  }

  if (!data) {
    // Resposta deliberadamente genérica.
    throw new HttpError(
      404,
      "Pedido não encontrado."
    );
  }

  return publicOrderTrackingDto(data);
}
