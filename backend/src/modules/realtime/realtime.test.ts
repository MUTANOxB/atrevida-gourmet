import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_SECRET_KEY = "test-secret-key-with-at-least-20-characters";
process.env.SUPABASE_ANON_KEY = "test-anon-key-with-at-least-20-characters";
process.env.FRONTEND_ORIGIN = "http://localhost:3000";
process.env.SERVE_STATIC = "false";

const nativeFetch = globalThis.fetch.bind(globalThis);
const storeId = "11111111-1111-4111-8111-111111111111";
const otherStoreId = "22222222-2222-4222-8222-222222222222";
const orderId = "33333333-3333-4333-8333-333333333333";
const otherOrderId = "44444444-4444-4444-8444-444444444444";
const sameStoreOtherSessionOrderId = "45454545-4545-4454-8454-454545454545";
const trackingToken = "55555555-5555-4555-8555-555555555555";
const otherTrackingToken = "66666666-6666-4666-8666-666666666666";
const publicSessionId = "88888888-8888-4888-8888-888888888888";
const publicSessionToken = Buffer.alloc(32, 7).toString("base64url");
const publicSessionHash = createHash("sha256").update(publicSessionToken).digest("hex");
let membershipRole: "owner" | "manager" | "staff" = "manager";

globalThis.fetch = (async (input, init) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request?.url ?? String(input));
  const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();

  if (url.pathname.endsWith("/auth/v1/user") && method === "GET") {
    return jsonResponse({
      id: "77777777-7777-4777-8777-777777777777",
      aud: "authenticated",
      role: "authenticated",
      email: "operacao@atrevida.test",
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-09-16T10:00:00.000Z"
    });
  }
  if (url.pathname.endsWith("/rest/v1/store_members")) {
    return jsonResponse({
      store_id: storeId,
      role: membershipRole,
      stores: { slug: "atrevida-gourmet" }
    });
  }
  if (url.pathname.endsWith("/rest/v1/public_order_sessions")) {
    if (method === "PATCH") return jsonResponse([]);
    const hash = (url.searchParams.get("token_hash") ?? "").replace(/^eq\./, "");
    return jsonResponse(hash === publicSessionHash ? {
      id: publicSessionId,
      expires_at: "2099-01-01T00:00:00.000Z"
    } : null);
  }
  if (url.pathname.endsWith("/rest/v1/stores")) {
    const slug = (url.searchParams.get("slug") ?? "").replace(/^eq\./, "");
    return jsonResponse(slug === "atrevida-gourmet" ? { id: storeId } : { id: otherStoreId });
  }
  if (url.pathname.endsWith("/rest/v1/public_order_session_orders")) {
    const session = (url.searchParams.get("session_id") ?? "").replace(/^eq\./, "");
    const store = (url.searchParams.get("store_id") ?? "").replace(/^eq\./, "");
    return jsonResponse(session === publicSessionId && store === storeId
      ? [{ order_id: orderId, created_at: "2026-09-22T12:00:00.000Z" }]
      : []);
  }
  if (url.pathname.endsWith("/rest/v1/orders")) {
    const filter = url.searchParams.get("tracking_token") ?? "";
    const token = filter.replace(/^eq\./, "");
    if (token === trackingToken) {
      return jsonResponse({
        id: orderId,
        store_id: storeId,
        tracking_token: trackingToken,
        status: "pending"
      });
    }
    if (token === otherTrackingToken) {
      return jsonResponse({
        id: otherOrderId,
        store_id: otherStoreId,
        tracking_token: otherTrackingToken,
        status: "pending"
      });
    }
    return jsonResponse(null);
  }
  return jsonResponse({ message: `Unexpected ${method} ${url.pathname}` }, 500);
}) as typeof fetch;

const { buildApp } = await import("../../server.js");
const {
  OrderEventBus,
  orderChangeFromPayload
} = await import("./order-events.js");
const { SseConnectionLimiter } = await import("./sse.js");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (content: string) => boolean,
  timeoutMs = 2_000
) {
  const decoder = new TextDecoder();
  let content = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("SSE read timed out.")), remaining);
        timer.unref();
      })
    ]);
    if (result.done) break;
    content += decoder.decode(result.value, { stream: true });
    if (predicate(content)) return content;
  }
  throw new Error(`Expected SSE frame was not received. Content: ${content}`);
}

async function closeStream(
  controller: AbortController,
  reader: ReadableStreamDefaultReader<Uint8Array>
) {
  controller.abort();
  await reader.cancel().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("converte somente campos operacionais do evento Supabase", () => {
  const event = orderChangeFromPayload({
    eventType: "UPDATE",
    old: { status: "pending" },
    new: {
      id: orderId,
      store_id: storeId,
      tracking_token: trackingToken,
      status: "confirmed",
      customer_phone: "nao-deve-sair",
      delivery_street: "nao-deve-sair"
    }
  });
  assert.deepEqual(event, {
    type: "order.status",
    orderId,
    storeId,
    trackingToken,
    status: "confirmed",
    previousStatus: "pending"
  });
  assert.equal(orderChangeFromPayload({
    eventType: "INSERT",
    old: {},
    new: {
      id: orderId,
      store_id: storeId,
      tracking_token: trackingToken,
      status: "pending"
    }
  })?.type, "order.created");
});

test("limita e libera conexoes SSE por IP", () => {
  const limiter = new SseConnectionLimiter(2);
  const first = limiter.acquire("127.0.0.1");
  const second = limiter.acquire("127.0.0.1");
  assert.ok(first);
  assert.ok(second);
  assert.equal(limiter.acquire("127.0.0.1"), null);
  first();
  assert.equal(limiter.count("127.0.0.1"), 1);
  assert.ok(limiter.acquire("127.0.0.1"));
});

test("stream admin exige sessao e aceita staff, manager e owner", async (context) => {
  const events = new OrderEventBus();
  const app = await buildApp({ serveStatic: false, orderEvents: events });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());

  const anonymous = await nativeFetch(`${baseUrl}/api/admin/events`);
  assert.equal(anonymous.status, 401);

  for (const role of ["staff", "manager", "owner"] as const) {
    membershipRole = role;
    const controller = new AbortController();
    const response = await nativeFetch(`${baseUrl}/api/admin/events`, {
      headers: {
        authorization: `Bearer ${role}-token`,
        "x-store-slug": "atrevida-gourmet"
      },
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const content = await readUntil(reader, (value) => value.includes('"type":"connected"'));
    assert.match(content, /retry: 3000/);
    await closeStream(controller, reader);
  }
});

test("novo pedido chega ao painel e fica isolado por store_id", async (context) => {
  membershipRole = "manager";
  const events = new OrderEventBus();
  const app = await buildApp({
    serveStatic: false,
    orderEvents: events,
    sseHeartbeatMs: 25,
    sseMaxDurationMs: 2_000
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());
  const controller = new AbortController();
  const response = await nativeFetch(`${baseUrl}/api/admin/events`, {
    headers: {
      authorization: "Bearer manager-token",
      "x-store-slug": "atrevida-gourmet"
    },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();

  events.publish({
    type: "order.created",
    orderId: otherOrderId,
    storeId: otherStoreId,
    trackingToken: otherTrackingToken,
    status: "pending"
  });
  events.publish({
    type: "order.created",
    orderId,
    storeId,
    trackingToken,
    status: "pending"
  });

  const content = await readUntil(
    reader,
    (value) => value.includes(orderId) && value.includes(": heartbeat")
  );
  assert.match(content, /"type":"order.created"/);
  assert.equal(content.includes(otherOrderId), false);
  assert.match(content, /: heartbeat/);
  await closeStream(controller, reader);
});

test("mudanca de status chega somente ao tracking autorizado", async (context) => {
  const events = new OrderEventBus();
  const app = await buildApp({ serveStatic: false, orderEvents: events });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());
  const controller = new AbortController();
  const response = await nativeFetch(
    `${baseUrl}/api/public/orders/${trackingToken}/events`,
    { signal: controller.signal }
  );
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();

  events.publish({
    type: "order.status",
    orderId: otherOrderId,
    storeId: otherStoreId,
    trackingToken: otherTrackingToken,
    status: "cancelled"
  });
  events.publish({
    type: "order.status",
    orderId,
    storeId,
    trackingToken,
    status: "confirmed"
  });

  const content = await readUntil(reader, (value) => value.includes('"status":"confirmed"'));
  assert.match(content, /"type":"order.status"/);
  assert.equal(content.includes("cancelled"), false);
  assert.equal(content.includes(orderId), false);
  assert.equal(content.includes(storeId), false);
  assert.equal(content.includes(trackingToken), false);
  await closeStream(controller, reader);
});

test("stream da sessão recebe somente eventos dos pedidos vinculados na loja", async (context) => {
  const events = new OrderEventBus();
  const app = await buildApp({ serveStatic: false, orderEvents: events });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());
  const controller = new AbortController();
  const response = await nativeFetch(
    `${baseUrl}/api/public/my-orders/events?storeSlug=atrevida-gourmet`,
    {
      headers: { cookie: `atrevida_order_session=${publicSessionToken}` },
      signal: controller.signal
    }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  const reader = response.body!.getReader();

  events.publish({
    type: "order.status",
    orderId: otherOrderId,
    storeId: otherStoreId,
    trackingToken: otherTrackingToken,
    status: "cancelled"
  });
  events.publish({
    type: "order.status",
    orderId: sameStoreOtherSessionOrderId,
    storeId,
    trackingToken: otherTrackingToken,
    status: "ready"
  });
  events.publish({
    type: "order.status",
    orderId,
    storeId,
    trackingToken,
    status: "confirmed"
  });

  const content = await readUntil(reader, (value) => value.includes('"status":"confirmed"'));
  assert.match(content, /"type":"order.status"/);
  assert.equal(content.includes("cancelled"), false);
  assert.equal(content.includes("ready"), false);
  assert.equal(content.includes(orderId), false);
  assert.equal(content.includes(storeId), false);
  assert.equal(content.includes(trackingToken), false);
  await closeStream(controller, reader);
});

test("tracking inexistente nao abre stream e nao revela outro pedido", async (context) => {
  const events = new OrderEventBus();
  const app = await buildApp({ serveStatic: false, orderEvents: events });
  context.after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: "/api/public/orders/99999999-9999-4999-8999-999999999999/events"
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: "Pedido não encontrado.",
    code: "REQUEST_FAILED"
  });
});

test("endpoint aplica limite, timeout e libera a reconexao", async (context) => {
  membershipRole = "staff";
  const events = new OrderEventBus();
  const connections = new SseConnectionLimiter(1);
  const app = await buildApp({
    serveStatic: false,
    orderEvents: events,
    sseConnections: connections,
    sseHeartbeatMs: 20,
    sseMaxDurationMs: 120
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());
  const headers = {
    authorization: "Bearer staff-token",
    "x-store-slug": "atrevida-gourmet"
  };

  const first = await nativeFetch(`${baseUrl}/api/admin/events`, { headers });
  assert.equal(first.status, 200);
  const firstReader = first.body!.getReader();
  await readUntil(firstReader, (value) => value.includes('"type":"connected"'));

  const rejected = await nativeFetch(`${baseUrl}/api/admin/events`, { headers });
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).code, "SSE_CONNECTION_LIMIT");

  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(connections.count("127.0.0.1"), 0);

  const controller = new AbortController();
  const reconnected = await nativeFetch(`${baseUrl}/api/admin/events`, {
    headers,
    signal: controller.signal
  });
  assert.equal(reconnected.status, 200);
  const reader = reconnected.body!.getReader();
  const content = await readUntil(reader, (value) => value.includes('"type":"connected"'));
  assert.match(content, /retry: 3000/);
  await closeStream(controller, reader);
});
