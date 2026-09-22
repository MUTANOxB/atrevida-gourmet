import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/errors.js";
import { publicOrderTrackingDto } from "../../lib/public-dto.js";
import { supabaseAdmin } from "../../lib/supabase.js";

export const PUBLIC_ORDER_SESSION_COOKIE = "atrevida_order_session";
export const PUBLIC_ORDER_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
export const PUBLIC_ORDER_SESSION_LAST_SEEN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const COOKIE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type PublicOrderSession = {
  id: string;
};

export function generatePublicOrderSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashPublicOrderSessionToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function publicOrderSessionCookieOptions(
  nodeEnv: "development" | "test" | "production" = env.NODE_ENV
) {
  return {
    path: "/api/public",
    httpOnly: true,
    secure: nodeEnv === "production",
    sameSite: "strict" as const,
    maxAge: PUBLIC_ORDER_SESSION_MAX_AGE_SECONDS
  };
}

export function readPublicOrderSessionCookie(request: FastifyRequest) {
  const token = request.cookies[PUBLIC_ORDER_SESSION_COOKIE];
  return typeof token === "string" && COOKIE_TOKEN_PATTERN.test(token)
    ? token
    : null;
}

export function clearPublicOrderSessionCookie(reply: FastifyReply) {
  reply.clearCookie(
    PUBLIC_ORDER_SESSION_COOKIE,
    publicOrderSessionCookieOptions()
  );
}

function setPublicOrderSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(
    PUBLIC_ORDER_SESSION_COOKIE,
    token,
    publicOrderSessionCookieOptions()
  );
}

function expiresAt(now: Date) {
  return new Date(
    now.getTime() + PUBLIC_ORDER_SESSION_MAX_AGE_SECONDS * 1000
  ).toISOString();
}

async function createPublicOrderSession(
  reply: FastifyReply,
  now: Date,
  replaceCookie: boolean
): Promise<PublicOrderSession> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = generatePublicOrderSessionToken();
    const tokenHash = hashPublicOrderSessionToken(token);
    const { data, error } = await supabaseAdmin
      .from("public_order_sessions")
      .insert({
        token_hash: tokenHash,
        created_at: now.toISOString(),
        last_seen_at: now.toISOString(),
        expires_at: expiresAt(now)
      })
      .select("id")
      .single();

    if (!error && data?.id) {
      if (replaceCookie) clearPublicOrderSessionCookie(reply);
      setPublicOrderSessionCookie(reply, token);
      return { id: data.id as string };
    }
    if (error?.code !== "23505") break;
  }
  throw new HttpError(503, "Acompanhamento temporariamente indisponível.");
}

export async function resolvePublicOrderSession(
  request: FastifyRequest,
  reply: FastifyReply,
  now = new Date()
): Promise<PublicOrderSession> {
  const token = readPublicOrderSessionCookie(request);
  if (token) {
    const tokenHash = hashPublicOrderSessionToken(token);
    const { data, error } = await supabaseAdmin
      .from("public_order_sessions")
      .select("id, last_seen_at, expires_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (error) {
      throw new HttpError(503, "Acompanhamento temporariamente indisponível.");
    }

    if (data && new Date(data.expires_at).getTime() > now.getTime()) {
      const lastSeenAt = new Date(data.last_seen_at).getTime();
      if (
        !Number.isFinite(lastSeenAt) ||
        now.getTime() - lastSeenAt >= PUBLIC_ORDER_SESSION_LAST_SEEN_INTERVAL_MS
      ) {
        await supabaseAdmin
          .from("public_order_sessions")
          .update({ last_seen_at: now.toISOString() })
          .eq("id", data.id);
      }
      return { id: data.id as string };
    }
  }

  return createPublicOrderSession(reply, now, !!request.cookies[PUBLIC_ORDER_SESSION_COOKIE]);
}

export async function associateOrderWithPublicSession(
  sessionId: string,
  orderId: string,
  storeId: string
) {
  const { error } = await supabaseAdmin
    .from("public_order_session_orders")
    .upsert(
      { session_id: sessionId, order_id: orderId, store_id: storeId },
      { onConflict: "session_id,order_id", ignoreDuplicates: true }
    );
  if (error) throw new Error("PUBLIC_ORDER_SESSION_ASSOCIATION_FAILED");
}

export async function resolvePublicStoreId(storeSlug: string) {
  const { data, error } = await supabaseAdmin
    .from("stores")
    .select("id")
    .eq("slug", storeSlug)
    .eq("active", true)
    .maybeSingle();
  if (error) throw new HttpError(503, "Acompanhamento temporariamente indisponível.");
  if (!data) throw new HttpError(404, "Loja não encontrada.");
  return data.id as string;
}

export async function listPublicSessionOrderIds(
  sessionId: string,
  storeId: string
) {
  const { data, error } = await supabaseAdmin
    .from("public_order_session_orders")
    .select("order_id, created_at")
    .eq("session_id", sessionId)
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw new HttpError(503, "Acompanhamento temporariamente indisponível.");
  return (data ?? []).map((link: any) => link.order_id as string);
}

export async function publicSessionOwnsOrder(
  sessionId: string,
  storeId: string,
  orderId: string
) {
  const { data, error } = await supabaseAdmin
    .from("public_order_session_orders")
    .select("order_id")
    .eq("session_id", sessionId)
    .eq("store_id", storeId)
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw new HttpError(503, "Acompanhamento temporariamente indisponível.");
  return !!data;
}

export async function listPublicSessionOrders(
  sessionId: string,
  storeId: string
) {
  const orderIds = await listPublicSessionOrderIds(sessionId, storeId);
  if (!orderIds.length) return [];

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(`
      id, order_number, status, fulfillment_type, payment_method, payment_status,
      subtotal_cents, delivery_fee_cents, total_cents, created_at, accepted_at,
      ready_at, out_for_delivery_at, completed_at, cancelled_at,
      order_items(product_name_snapshot, unit_price_cents, quantity,
        line_total_cents, options_snapshot)
    `)
    .eq("store_id", storeId)
    .in("id", orderIds);
  if (error) throw new HttpError(503, "Acompanhamento temporariamente indisponível.");

  const byId = new Map((data ?? []).map((order: any) => [order.id, order]));
  return orderIds
    .map((orderId) => byId.get(orderId))
    .filter(Boolean)
    .map(publicOrderTrackingDto);
}
