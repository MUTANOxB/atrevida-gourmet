import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyReply, FastifyRequest } from "fastify";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_SECRET_KEY = "test-secret-key-with-at-least-20-characters";
process.env.FRONTEND_ORIGIN = "http://localhost:3000";

type SessionRow = {
  id: string;
  token_hash: string;
  expires_at: string;
  last_seen_at: string;
};

const storeA = "11111111-1111-4111-8111-111111111111";
const storeB = "22222222-2222-4222-8222-222222222222";
const orderA = "33333333-3333-4333-8333-333333333333";
const orderB = "44444444-4444-4444-8444-444444444444";
const unassociatedOrder = "55555555-5555-4555-8555-555555555555";
const sessionA = "66666666-6666-4666-8666-666666666666";
let nextSession = 7;
const sessions = new Map<string, SessionRow>();
const links = new Map<string, { session_id: string; order_id: string; store_id: string; created_at: string }>();
const insertedSessionBodies: Array<Record<string, unknown>> = [];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function equality(url: URL, field: string) {
  return (url.searchParams.get(field) ?? "").replace(/^eq\./, "");
}

function requestBody(input: Request | null, init?: RequestInit) {
  return init?.body ?? (input ? input.clone().text() : null);
}

const orderRows = [
  {
    id: orderA,
    store_id: storeA,
    order_number: "AG-A-001",
    status: "pending",
    fulfillment_type: "pickup",
    payment_method: "cash",
    payment_status: "pay_on_delivery",
    subtotal_cents: 1000,
    delivery_fee_cents: 0,
    total_cents: 1000,
    created_at: "2026-09-22T10:00:00.000Z",
    accepted_at: null,
    ready_at: null,
    out_for_delivery_at: null,
    completed_at: null,
    cancelled_at: null,
    order_items: []
  },
  {
    id: orderB,
    store_id: storeB,
    order_number: "AG-B-001",
    status: "confirmed",
    fulfillment_type: "delivery",
    payment_method: "pix",
    payment_status: "approved",
    subtotal_cents: 2000,
    delivery_fee_cents: 500,
    total_cents: 2500,
    created_at: "2026-09-22T11:00:00.000Z",
    accepted_at: null,
    ready_at: null,
    out_for_delivery_at: null,
    completed_at: null,
    cancelled_at: null,
    order_items: []
  },
  {
    id: unassociatedOrder,
    store_id: storeA,
    order_number: "AG-A-PRIVATE",
    status: "pending",
    order_items: []
  }
];

globalThis.fetch = (async (input, init) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request?.url ?? String(input));
  const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
  const rawBody = await requestBody(request, init);
  const parsed = typeof rawBody === "string" && rawBody ? JSON.parse(rawBody) : null;
  const body = Array.isArray(parsed) ? parsed[0] : parsed;
  const table = url.pathname.split("/").at(-1);

  if (table === "public_order_sessions") {
    if (method === "GET") return jsonResponse(sessions.get(equality(url, "token_hash")) ?? null);
    if (method === "POST") {
      insertedSessionBodies.push(body);
      const id = `77777777-7777-4777-8777-${String(nextSession++).padStart(12, "0")}`;
      const row = { id, ...body } as SessionRow;
      sessions.set(row.token_hash, row);
      return jsonResponse({ id }, 201);
    }
    if (method === "PATCH") {
      const id = equality(url, "id");
      const entry = [...sessions.entries()].find(([, row]) => row.id === id);
      if (entry) sessions.set(entry[0], { ...entry[1], ...body });
      return jsonResponse([]);
    }
  }

  if (table === "public_order_session_orders") {
    if (method === "POST") {
      const key = `${body.session_id}:${body.order_id}`;
      if (!links.has(key)) {
        links.set(key, { ...body, created_at: new Date().toISOString() });
      }
      return jsonResponse(null, 201);
    }
    if (method === "GET") {
      const rows = [...links.values()].filter((link) =>
        link.session_id === equality(url, "session_id") &&
        link.store_id === equality(url, "store_id")
      );
      return jsonResponse(rows.map(({ order_id, created_at }) => ({ order_id, created_at })));
    }
  }

  if (table === "stores" && method === "GET") {
    const slug = equality(url, "slug");
    return jsonResponse(slug === "store-a" ? { id: storeA } : slug === "store-b" ? { id: storeB } : null);
  }

  if (table === "orders" && method === "GET") {
    const storeId = equality(url, "store_id");
    const ids = (url.searchParams.get("id") ?? "")
      .replace(/^in\.\(/, "")
      .replace(/\)$/, "")
      .split(",")
      .filter(Boolean);
    return jsonResponse(orderRows.filter((order) => order.store_id === storeId && ids.includes(order.id)));
  }

  return jsonResponse({ message: `Unexpected ${method} ${url.pathname}` }, 500);
}) as typeof fetch;

const {
  PUBLIC_ORDER_SESSION_COOKIE,
  PUBLIC_ORDER_SESSION_MAX_AGE_SECONDS,
  associateOrderWithPublicSession,
  generatePublicOrderSessionToken,
  hashPublicOrderSessionToken,
  listPublicSessionOrders,
  publicOrderSessionCookieOptions,
  resolvePublicOrderSession,
  resolvePublicStoreId
} = await import("./public-order-session.service.js");

function fakeReply() {
  const set: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
  const cleared: string[] = [];
  return {
    set,
    cleared,
    reply: {
      setCookie(name: string, value: string, options: Record<string, unknown>) {
        set.push({ name, value, options });
        return this;
      },
      clearCookie(name: string) {
        cleared.push(name);
        return this;
      }
    } as unknown as FastifyReply
  };
}

function fakeRequest(cookie?: string) {
  return {
    cookies: cookie ? { [PUBLIC_ORDER_SESSION_COOKIE]: cookie } : {}
  } as unknown as FastifyRequest;
}

test.beforeEach(() => {
  sessions.clear();
  links.clear();
  insertedSessionBodies.length = 0;
});

test("token usa 256 bits e o banco recebe somente SHA-256 determinístico", async () => {
  const left = generatePublicOrderSessionToken();
  const right = generatePublicOrderSessionToken();
  assert.match(left, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(left, right);
  assert.equal(hashPublicOrderSessionToken(left), hashPublicOrderSessionToken(left));
  assert.notEqual(hashPublicOrderSessionToken(left), hashPublicOrderSessionToken(right));
  assert.match(hashPublicOrderSessionToken(left), /^[0-9a-f]{64}$/);

  const target = fakeReply();
  await resolvePublicOrderSession(fakeRequest(), target.reply);
  const cookie = target.set.at(-1)!;
  assert.equal(cookie.name, PUBLIC_ORDER_SESSION_COOKIE);
  assert.equal(insertedSessionBodies[0].token_hash, hashPublicOrderSessionToken(cookie.value));
  assert.equal(JSON.stringify(insertedSessionBodies[0]).includes(cookie.value), false);
});

test("cookie persistente é HttpOnly, restrito a /api/public e Secure em produção", () => {
  const options = publicOrderSessionCookieOptions("production");
  assert.equal(options.httpOnly, true);
  assert.equal(options.secure, true);
  assert.equal(options.sameSite, "strict");
  assert.equal(options.path, "/api/public");
  assert.equal(options.maxAge, PUBLIC_ORDER_SESSION_MAX_AGE_SECONDS);
  assert.ok(options.maxAge >= 29 * 24 * 60 * 60);
});

test("cookie desconhecido ou sessão expirada é rotacionado sem cadastrar o segredo recebido", async () => {
  const unknown = generatePublicOrderSessionToken();
  const unknownReply = fakeReply();
  await resolvePublicOrderSession(fakeRequest(unknown), unknownReply.reply);
  assert.notEqual(unknownReply.set.at(-1)?.value, unknown);
  assert.ok(unknownReply.cleared.includes(PUBLIC_ORDER_SESSION_COOKIE));
  assert.equal(JSON.stringify(insertedSessionBodies).includes(unknown), false);

  const expired = generatePublicOrderSessionToken();
  sessions.set(hashPublicOrderSessionToken(expired), {
    id: sessionA,
    token_hash: hashPublicOrderSessionToken(expired),
    last_seen_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-31T00:00:00.000Z"
  });
  const expiredReply = fakeReply();
  const resolved = await resolvePublicOrderSession(
    fakeRequest(expired),
    expiredReply.reply,
    new Date("2026-09-22T12:00:00.000Z")
  );
  assert.notEqual(resolved.id, sessionA);
  assert.notEqual(expiredReply.set.at(-1)?.value, expired);
});

test("associação é idempotente e listagem isola sessão e loja sem vazar DTO privado", async () => {
  await associateOrderWithPublicSession(sessionA, orderA, storeA);
  await associateOrderWithPublicSession(sessionA, orderA, storeA);
  await associateOrderWithPublicSession(sessionA, orderB, storeB);
  assert.equal(links.size, 2);

  const resolvedStoreA = await resolvePublicStoreId("store-a");
  const ordersA = await listPublicSessionOrders(sessionA, resolvedStoreA);
  assert.deepEqual(ordersA.map((order) => order.orderNumber), ["AG-A-001"]);
  assert.equal(JSON.stringify(ordersA).includes("AG-A-PRIVATE"), false);
  assert.deepEqual(await listPublicSessionOrders("other-session", storeA), []);

  const ordersB = await listPublicSessionOrders(sessionA, storeB);
  assert.deepEqual(ordersB.map((order) => order.orderNumber), ["AG-B-001"]);
  const serialized = JSON.stringify({ orders: [...ordersA, ...ordersB] });
  for (const forbidden of [
    "trackingToken", "tracking_token", "customerPhone", "customer_phone",
    "address", "street", "postalCode", "sessionId", "tokenHash"
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
