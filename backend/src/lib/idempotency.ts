import { createHash } from "node:crypto";
import { HttpError } from "./errors.js";
import { supabaseAdmin } from "./supabase.js";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

export function hashIdempotentPayload(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export type IdempotencyReservation =
  | { kind: "reserved" }
  | { kind: "replay"; statusCode: number; body: unknown };

export async function reserveIdempotency(input: {
  key: string;
  requestHash: string;
  storeId: string;
}): Promise<IdempotencyReservation> {
  const now = new Date().toISOString();
  await supabaseAdmin
    .from("idempotency_keys")
    .delete()
    .eq("key", input.key)
    .eq("store_id", input.storeId)
    .lt("expires_at", now);

  const { data: existing, error: readError } = await supabaseAdmin
    .from("idempotency_keys")
    .select("request_hash, store_id, order_id, response_status, response_body, completed_at")
    .eq("key", input.key)
    .eq("store_id", input.storeId)
    .maybeSingle();

  if (readError) {
    throw new HttpError(503, "Checkout temporariamente indisponível.");
  }

  if (existing) {
    if (existing.request_hash !== input.requestHash || existing.store_id !== input.storeId) {
      throw new HttpError(409, "Idempotency-Key reutilizada com outro conteúdo.");
    }
    if (existing.completed_at && existing.response_body) {
      return {
        kind: "replay",
        statusCode: existing.response_status ?? 201,
        body: existing.response_body
      };
    }
    if (existing.order_id) {
      const recovered = await recoverOrderResponse(
        existing.order_id,
        input.key,
        input.storeId
      );
      if (recovered) return recovered;
    }
    throw new HttpError(425, "Esta tentativa de checkout ainda está em processamento.");
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabaseAdmin.from("idempotency_keys").insert({
    key: input.key,
    request_hash: input.requestHash,
    store_id: input.storeId,
    expires_at: expiresAt
  });

  if (error) {
    // Outro processo pode ter reservado entre o SELECT e o INSERT.
    const { data: raced } = await supabaseAdmin
      .from("idempotency_keys")
      .select("request_hash, store_id, order_id, response_status, response_body, completed_at")
      .eq("key", input.key)
      .eq("store_id", input.storeId)
      .maybeSingle();
    if (raced?.request_hash !== input.requestHash || raced?.store_id !== input.storeId) {
      throw new HttpError(409, "Idempotency-Key reutilizada com outro conteúdo.");
    }
    if (raced?.completed_at && raced.response_body) {
      return {
        kind: "replay",
        statusCode: raced.response_status ?? 201,
        body: raced.response_body
      };
    }
    if (raced?.order_id) {
      const recovered = await recoverOrderResponse(
        raced.order_id,
        input.key,
        input.storeId
      );
      if (recovered) return recovered;
    }
    throw new HttpError(425, "Esta tentativa de checkout ainda está em processamento.");
  }

  return { kind: "reserved" };
}

async function recoverOrderResponse(
  orderId: string,
  key: string,
  storeId: string
): Promise<IdempotencyReservation | null> {
  const { data } = await supabaseAdmin
    .from("orders")
    .select("id, order_number, tracking_token, status, subtotal_cents, delivery_fee_cents, total_cents, created_at")
    .eq("id", orderId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (!data) return null;
  const body = {
    orderNumber: data.order_number,
    trackingToken: data.tracking_token,
    status: data.status,
    subtotalCents: data.subtotal_cents,
    deliveryFeeCents: data.delivery_fee_cents,
    totalCents: data.total_cents,
    createdAt: data.created_at
  };
  await supabaseAdmin.from("idempotency_keys").update({
    response_status: 201,
    response_body: body,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq("key", key).eq("store_id", storeId);
  return { kind: "replay", statusCode: 201, body };
}

export async function completeIdempotency(
  key: string,
  storeId: string,
  orderId: string,
  statusCode: number,
  body: unknown
) {
  const { error } = await supabaseAdmin
    .from("idempotency_keys")
    .update({
      order_id: orderId,
      response_status: statusCode,
      response_body: body,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("key", key)
    .eq("store_id", storeId);
  if (error) {
    // O pedido existe; manter a reserva incompleta é mais seguro que permitir duplicação.
    throw new HttpError(503, "Pedido recebido; confirmação temporariamente indisponível.");
  }
}

export async function releaseIdempotency(key: string, storeId: string) {
  await supabaseAdmin
    .from("idempotency_keys")
    .delete()
    .eq("key", key)
    .eq("store_id", storeId)
    .is("completed_at", null);
}
