import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_SECRET_KEY = "test-secret-key-with-at-least-20-characters";
process.env.SUPABASE_ANON_KEY = "test-anon-key-with-at-least-20-characters";
process.env.FRONTEND_ORIGIN = "http://localhost:3000";
process.env.SERVE_STATIC = "false";

type SupabaseFetchHandler = (
  url: URL,
  method: string,
  body: unknown
) => Response | Promise<Response>;

let supabaseFetchHandler: SupabaseFetchHandler | null = null;
globalThis.fetch = (async (input, init) => {
  if (!supabaseFetchHandler) throw new Error("Unexpected Supabase request in test.");
  const request = input instanceof Request ? input : null;
  const url = new URL(request?.url ?? String(input));
  const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
  const rawBody = init?.body ?? (request ? await request.clone().text() : null);
  const body = typeof rawBody === "string" && rawBody ? JSON.parse(rawBody) : null;
  return supabaseFetchHandler(url, method, body);
}) as typeof fetch;

const { buildApp, staticAssetCacheControl } = await import("./server.js");
const { canTransitionOrder } = await import("./modules/admin/admin.service.js");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function countResponse(count: number) {
  return new Response(null, {
    status: 200,
    headers: { "content-range": count > 0 ? `0-${count - 1}/${count}` : "*/0" }
  });
}

test("política de cache distingue assets mutáveis de imagens", () => {
  for (const filePath of ["/site/index.html", "/assets/js/app.js", "/assets/css/styles.css"]) {
    const policy = staticAssetCacheControl(filePath);
    assert.equal(policy, "no-cache", filePath);
    assert.doesNotMatch(policy, /max-age=86400/, filePath);
  }
  assert.equal(staticAssetCacheControl("/assets/images/logo.webp"), "public, max-age=86400");
});

test("Fastify Static entrega a política de cache esperada", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "atrevida-static-"));
  await Promise.all([
    mkdir(join(root, "assets", "js"), { recursive: true }),
    mkdir(join(root, "assets", "css"), { recursive: true }),
    mkdir(join(root, "assets", "images"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(root, "index.html"), "<!doctype html><title>Atrevida</title>"),
    writeFile(join(root, "assets", "js", "app.js"), "export {};"),
    writeFile(join(root, "assets", "css", "styles.css"), "body {}"),
    writeFile(join(root, "assets", "images", "logo.webp"), Buffer.from([0]))
  ]);

  const app = await buildApp({ serveStatic: true, staticRoot: root });
  context.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  for (const url of ["/index.html", "/assets/js/app.js", "/assets/css/styles.css"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, url);
    assert.equal(response.headers["cache-control"], "no-cache", url);
  }
  const image = await app.inject({ method: "GET", url: "/assets/images/logo.webp" });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["cache-control"], "public, max-age=86400");
});

test("servidor registra hardening e responde health", async (context) => {
  const app = await buildApp({ serveStatic: false });
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.match(String(response.headers["strict-transport-security"]), /max-age=31536000/);
  assert.match(String(response.headers["permissions-policy"]), /camera=\(\)/);
  assert.match(String(response.headers["content-security-policy"]), /default-src 'self'/);
  assert.match(String(response.headers["content-security-policy"]), /frame-ancestors 'none'/);
});

test("origens locais same-origin funcionam apenas na configuração não produtiva", async (context) => {
  const app = await buildApp({ serveStatic: false });
  context.after(() => app.close());

  for (const origin of ["http://127.0.0.1:3333", "http://localhost:3333"]) {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin }
    });
    assert.equal(response.statusCode, 200, origin);
    assert.equal(response.headers["access-control-allow-origin"], origin);
  }

  const rejected = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "https://origem-invalida.example" }
  });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.headers["access-control-allow-origin"], undefined);
});

test("readiness valida Supabase sem expor detalhes", async (context) => {
  supabaseFetchHandler = () => jsonResponse(null, 200);
  context.after(() => { supabaseFetchHandler = null; });
  const app = await buildApp({ serveStatic: false });
  context.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/ready" });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true, service: "atrevida-backend" });
  assert.equal(response.headers["cache-control"], "no-store");
});

test("rate limit global bloqueia flood controlado", async (context) => {
  const app = await buildApp({ serveStatic: false });
  context.after(() => app.close());

  let response;
  for (let attempt = 0; attempt < 121; attempt += 1) {
    response = await app.inject({ method: "GET", url: "/health" });
  }
  assert.equal(response!.statusCode, 429);
});

test("login limita brute force antes de consultar Auth indefinidamente", async (context) => {
  supabaseFetchHandler = () => jsonResponse({ message: "invalid credentials" }, 400);
  context.after(() => { supabaseFetchHandler = null; });
  const app = await buildApp({ serveStatic: false });
  context.after(() => app.close());

  let response;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    response = await app.inject({
      method: "POST",
      url: "/api/admin/auth/login",
      headers: { origin: "http://localhost:3000" },
      payload: {
        email: "tentativa@example.test",
        password: "senha-invalida",
        storeSlug: "atrevida-gourmet"
      }
    });
  }
  assert.equal(response!.statusCode, 429);
});

test("JSON profundamente aninhado e rejeitado", async (context) => {
  const app = await buildApp({ serveStatic: false });
  context.after(() => app.close());
  let nested: Record<string, unknown> = {};
  for (let depth = 0; depth < 20; depth += 1) nested = { child: nested };
  const response = await app.inject({
    method: "POST",
    url: "/api/public/delivery/quote",
    payload: {
      storeSlug: "atrevida-gourmet",
      neighborhood: "Centro",
      nested
    }
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "JSON excessivamente complexo.");
});

test("checkout rejeita campos financeiros adulterados antes de acessar o banco", async (context) => {
  const app = await buildApp({ serveStatic: false });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/public/orders",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "11111111-1111-4111-8111-111111111111"
    },
    payload: {
      storeSlug: "atrevida-gourmet",
      fulfillmentType: "pickup",
      customer: { name: "Cliente Teste", phone: "14999999999" },
      paymentMethod: "pix",
      totalCents: 1,
      items: [{
        productId: "11111111-1111-4111-8111-111111111111",
        quantity: 1,
        options: []
      }]
    }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "Dados inválidos.",
    code: "INVALID_INPUT"
  });
});

test("checkout exige JSON e limita o corpo a 32 KiB", async (context) => {
  const app = await buildApp({ serveStatic: false });
  context.after(() => app.close());

  const wrongType = await app.inject({
    method: "POST",
    url: "/api/public/orders",
    headers: { "idempotency-key": "11111111-1111-4111-8111-111111111111" },
    payload: "not-json"
  });
  assert.equal(wrongType.statusCode, 415);

  const oversized = await app.inject({
    method: "POST",
    url: "/api/public/orders",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "11111111-1111-4111-8111-111111111111"
    },
    payload: { note: "x".repeat(33 * 1024) }
  });
  assert.equal(oversized.statusCode, 413);
});

test("tracking rejeita token malformado antes de consultar o banco", async (context) => {
  const app = await buildApp({ serveStatic: false });
  context.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/public/orders/token-previsivel"
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "INVALID_INPUT");
  assert.equal(response.headers["cache-control"], "no-store");
});

test("fluxo publico liga catalogo, cotacao, checkout e tracking", async (context) => {
  const storeId = "22222222-2222-4222-8222-222222222222";
  const otherStoreId = "21212121-2121-4212-8212-212121212121";
  const sessionId = "23232323-2323-4232-8232-232323232323";
  const categoryId = "33333333-3333-4333-8333-333333333333";
  const productId = "44444444-4444-4444-8444-444444444444";
  const zoneId = "55555555-5555-4555-8555-555555555555";
  const trackingToken = "66666666-6666-4666-8666-666666666666";
  const calls: string[] = [];
  let storeOpen = true;
  let acceptsScheduledOrders = false;
  let createdSessions = 0;
  let createOrderCalls = 0;
  const sessions = new Map<string, { id: string; expires_at: string }>();
  const sessionLinks = new Set<string>();
  const idempotencyRecords = new Map<string, Record<string, any>>();
  const hours = Array.from({ length: 7 }, (_, day) => ({
    day_of_week: day,
    opens_at: "00:00:00",
    closes_at: "23:59:59",
    active: true
  }));
  const createdOrder = {
    id: "77777777-7777-4777-8777-777777777777",
    order_number: "AG-TEST-001",
    tracking_token: trackingToken,
    status: "pending",
    fulfillment_type: "pickup",
    payment_method: "pix",
    payment_provider: "direct_pix",
    payment_status: "pending",
    subtotal_cents: 1200,
    delivery_fee_cents: 0,
    total_cents: 1200,
    created_at: "2026-09-16T10:00:00.000Z"
  };

  supabaseFetchHandler = (url, method, body) => {
    const table = url.pathname.split("/").at(-1) ?? "";
    const input = Array.isArray(body) ? body[0] : body as Record<string, any> | null;
    calls.push(`${method} ${table}`);

    if (table === "public_order_sessions") {
      if (method === "GET") {
        const tokenHash = (url.searchParams.get("token_hash") ?? "").replace(/^eq\./, "");
        return jsonResponse(sessions.get(tokenHash) ?? null);
      }
      if (method === "POST") {
        createdSessions += 1;
        const id = createdSessions === 1
          ? sessionId
          : `24242424-2424-4242-8242-${String(createdSessions).padStart(12, "0")}`;
        sessions.set(String(input!.token_hash), { id, expires_at: String(input!.expires_at) });
        return jsonResponse({ id }, 201);
      }
      if (method === "PATCH") return jsonResponse([]);
    }

    if (table === "public_order_session_orders") {
      if (method === "POST") {
        sessionLinks.add(`${input!.session_id}:${input!.order_id}:${input!.store_id}`);
        return jsonResponse(null, 201);
      }
      if (method === "GET") {
        const requestedSession = (url.searchParams.get("session_id") ?? "").replace(/^eq\./, "");
        const requestedStore = (url.searchParams.get("store_id") ?? "").replace(/^eq\./, "");
        const links = [...sessionLinks]
          .map((value) => value.split(":"))
          .filter(([linkedSession, , linkedStore]) => linkedSession === requestedSession && linkedStore === requestedStore)
          .map(([, orderId]) => ({ order_id: orderId, created_at: "2026-09-16T10:00:00.000Z" }));
        return jsonResponse(links);
      }
    }

    if (table === "stores") {
      const select = url.searchParams.get("select") ?? "";
      const requestedSlug = (url.searchParams.get("slug") ?? "").replace(/^eq\./, "");
      if (select === "id") {
        return jsonResponse({ id: requestedSlug === "outra-loja" ? otherStoreId : storeId });
      }
      if (select.includes("categories(") && select.includes("products!products_category_same_store_fkey(")) {
        return jsonResponse({
          id: storeId,
          slug: "atrevida-gourmet",
          name: "Atrevida Gourmet",
          description: "",
          logo_url: null,
          setup_complete: true,
          is_open: storeOpen,
          accepts_delivery: true,
          accepts_pickup: true,
          accepts_scheduled_orders: acceptsScheduledOrders,
          delivery_fee_mode: "zones",
          fixed_delivery_fee_cents: null,
          minimum_order_cents: 0,
          currency: "BRL",
          timezone: "America/Sao_Paulo",
          instagram_handle: "@atrevida_gourmet",
          whatsapp_e164: "5514997875460",
          whatsapp_display: "(14) 99787-5460",
          pix_key: "pix@example.test",
          pix_merchant_name: "Atrevida Teste",
          pix_merchant_city: "Marilia",
          categories: [{
            id: categoryId,
            name: "Doces",
            slug: "doces",
            sort_order: 0,
            active: true,
            products: [{
              id: productId,
              category_id: categoryId,
              name: "Cacerola",
              description: "",
              image_url: null,
              price_cents: 600,
              active: true,
              featured: true,
              sort_order: 0,
              product_option_groups: []
            }]
          }],
          store_payment_methods: [{
            method: "pix",
            label: "Pix",
            instructions: null,
            active: true,
            sort_order: 0
          }],
          store_hours: hours,
          store_schedule_exceptions: []
        });
      }
      if (select.includes("is_open")) {
        return jsonResponse({
          id: storeId,
          active: true,
          setup_complete: true,
          is_open: storeOpen,
          accepts_delivery: true,
          accepts_pickup: true,
          accepts_scheduled_orders: acceptsScheduledOrders,
          delivery_fee_mode: "zones",
          fixed_delivery_fee_cents: null,
          minimum_order_cents: 0,
          timezone: "America/Sao_Paulo",
          scheduled_min_lead_minutes: 0,
          scheduled_max_advance_days: null,
          pix_key: "pix@example.test",
          pix_merchant_name: "Atrevida Teste",
          pix_merchant_city: "Marilia"
        });
      }
      return jsonResponse({
        id: storeId,
        setup_complete: true,
        accepts_delivery: true,
        delivery_fee_mode: "zones",
        fixed_delivery_fee_cents: null,
        minimum_order_cents: 0
      });
    }

    if (table === "delivery_zones") {
      return jsonResponse([{ id: zoneId, name: "Centro", fee_cents: 500, minimum_order_cents: 0 }]);
    }
    if (table === "idempotency_keys") {
      const key = (url.searchParams.get("key") ?? "").replace(/^eq\./, "") || String(input?.key ?? "");
      if (method === "DELETE") return jsonResponse([]);
      if (method === "GET") return jsonResponse(idempotencyRecords.get(key) ?? null);
      if (method === "POST") {
        idempotencyRecords.set(key, { ...input });
        return jsonResponse(null, 201);
      }
      if (method === "PATCH") {
        idempotencyRecords.set(key, { ...idempotencyRecords.get(key), ...input });
        return jsonResponse([]);
      }
    }
    if (table === "store_hours") return jsonResponse(hours);
    if (table === "store_schedule_exceptions") return jsonResponse([]);
    if (table === "store_payment_methods") return jsonResponse({ method: "pix" });
    if (table === "product_inventory_settings") return jsonResponse([]);
    if (table === "product_inventory_daily") return jsonResponse([]);
    if (table === "products") {
      assert.match(
        url.searchParams.get("select") ?? "",
        /category:categories!products_category_same_store_fkey!inner/
      );
      return jsonResponse([{
        id: productId,
        name: "Cacerola",
        price_cents: 600,
        active: true,
        category: { active: true },
        option_groups: []
      }]);
    }
    if (table === "create_order_with_items" && method === "POST") {
      createOrderCalls += 1;
      assert.equal((body as any).order_payload.subtotal_cents, 1200);
      assert.equal((body as any).order_payload.total_cents, 1200);
      return jsonResponse([createdOrder]);
    }
    if (table === "orders") {
      const row = {
        ...createdOrder,
        accepted_at: null,
        ready_at: null,
        out_for_delivery_at: null,
        completed_at: null,
        cancelled_at: null,
        order_items: [{
          product_name_snapshot: "Cacerola",
          unit_price_cents: 600,
          quantity: 2,
          line_total_cents: 1200,
          options_snapshot: []
        }]
      };
      return jsonResponse((url.searchParams.get("id") ?? "").startsWith("in.") ? [row] : row);
    }
    return jsonResponse({ message: `Unexpected ${method} ${url.pathname}` }, 500);
  };
  context.after(() => {
    supabaseFetchHandler = null;
  });

  const app = await buildApp({ serveStatic: false });
  context.after(() => app.close());

  const catalog = await app.inject({
    method: "GET",
    url: "/api/public/stores/atrevida-gourmet/catalog"
  });
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json().paymentMethods[0].method, "pix");
  assert.equal(catalog.json().categories[0].products[0].priceCents, 600);
  assert.deepEqual(
    {
      stockMode: catalog.json().categories[0].products[0].stockMode,
      available: catalog.json().categories[0].products[0].available,
      remainingQuantity: catalog.json().categories[0].products[0].remainingQuantity,
      lowStock: catalog.json().categories[0].products[0].lowStock
    },
    { stockMode: "always", available: true, remainingQuantity: null, lowStock: false }
  );

  const quote = await app.inject({
    method: "POST",
    url: "/api/public/delivery/quote",
    payload: { storeSlug: "atrevida-gourmet", neighborhood: "Centro" }
  });
  assert.equal(quote.statusCode, 200);
  assert.equal(quote.json().feeCents, 500);

  const checkoutPayload = {
    storeSlug: "atrevida-gourmet",
    fulfillmentType: "pickup",
    customer: { name: "Cliente Teste", phone: "14999999999" },
    paymentMethod: "pix",
    items: [{ productId, quantity: 2, options: [] }]
  };
  const checkout = await app.inject({
    method: "POST",
    url: "/api/public/orders",
    headers: { "idempotency-key": "88888888-8888-4888-8888-888888888888" },
    payload: checkoutPayload
  });
  assert.equal(checkout.statusCode, 201, checkout.body);
  assert.equal(checkout.json().trackingToken, trackingToken);
  assert.equal(checkout.json().totalCents, 1200);
  assert.equal(checkout.json().paymentStatus, "pending");
  assert.match(checkout.json().pix.copyPaste, /^00020126/);
  const sessionCookie = (Array.isArray(checkout.headers["set-cookie"])
    ? checkout.headers["set-cookie"]
    : [String(checkout.headers["set-cookie"] ?? "")]
  ).find((value) => value.startsWith("atrevida_order_session="));
  assert.ok(sessionCookie);
  assert.match(sessionCookie, /HttpOnly/i);
  assert.match(sessionCookie, /Path=\/api\/public/i);
  assert.match(sessionCookie, /SameSite=Strict/i);
  assert.match(sessionCookie, /Max-Age=2592000/i);
  const cookieHeader = sessionCookie!.split(";", 1)[0];

  const replay = await app.inject({
    method: "POST",
    url: "/api/public/orders",
    headers: {
      cookie: cookieHeader,
      "idempotency-key": "88888888-8888-4888-8888-888888888888"
    },
    payload: checkoutPayload
  });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.equal(createOrderCalls, 1);
  assert.equal(sessionLinks.size, 1);

  const myOrders = await app.inject({
    method: "GET",
    url: "/api/public/my-orders?storeSlug=atrevida-gourmet",
    headers: { cookie: cookieHeader }
  });
  assert.equal(myOrders.statusCode, 200, myOrders.body);
  assert.equal(myOrders.headers["cache-control"], "no-store");
  assert.deepEqual(myOrders.json().orders.map((order: any) => order.orderNumber), ["AG-TEST-001"]);
  const myOrdersBody = myOrders.body;
  for (const forbidden of ["trackingToken", "tracking_token", "customer_phone", "delivery_street", "session_id", "token_hash"]) {
    assert.equal(myOrdersBody.includes(forbidden), false, forbidden);
  }

  const anonymousOrders = await app.inject({
    method: "GET",
    url: "/api/public/my-orders?storeSlug=atrevida-gourmet"
  });
  assert.equal(anonymousOrders.statusCode, 200, anonymousOrders.body);
  assert.deepEqual(anonymousOrders.json(), { orders: [] });

  const unknownCookieToken = Buffer.alloc(32, 9).toString("base64url");
  const invalidSessionOrders = await app.inject({
    method: "GET",
    url: "/api/public/my-orders?storeSlug=atrevida-gourmet",
    headers: { cookie: `atrevida_order_session=${unknownCookieToken}` }
  });
  assert.equal(invalidSessionOrders.statusCode, 200, invalidSessionOrders.body);
  assert.deepEqual(invalidSessionOrders.json(), { orders: [] });
  const rotatedCookies = Array.isArray(invalidSessionOrders.headers["set-cookie"])
    ? invalidSessionOrders.headers["set-cookie"]
    : [String(invalidSessionOrders.headers["set-cookie"] ?? "")];
  assert.ok(rotatedCookies.some((value) =>
    /^atrevida_order_session=[A-Za-z0-9_-]{43};/.test(value) &&
    !value.includes(unknownCookieToken)
  ));

  const otherStoreOrders = await app.inject({
    method: "GET",
    url: "/api/public/my-orders?storeSlug=outra-loja",
    headers: { cookie: cookieHeader }
  });
  assert.deepEqual(otherStoreOrders.json(), { orders: [] });

  storeOpen = false;
  const closedCheckout = await app.inject({
    method: "POST",
    url: "/api/public/orders",
    headers: { "idempotency-key": "99999999-9999-4999-8999-999999999999" },
    payload: {
      storeSlug: "atrevida-gourmet",
      fulfillmentType: "pickup",
      customer: { name: "Cliente Teste", phone: "14999999999" },
      paymentMethod: "pix",
      items: [{ productId, quantity: 1, options: [] }]
    }
  });
  assert.equal(closedCheckout.statusCode, 422, closedCheckout.body);
  assert.match(closedCheckout.json().error, /fechada/);

  acceptsScheduledOrders = true;
  const scheduledCheckout = await app.inject({
    method: "POST",
    url: "/api/public/orders",
    headers: { "idempotency-key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    payload: {
      storeSlug: "atrevida-gourmet",
      fulfillmentType: "scheduled",
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      customer: { name: "Cliente Teste", phone: "14999999999" },
      paymentMethod: "pix",
      items: [{ productId, quantity: 2, options: [] }]
    }
  });
  assert.equal(scheduledCheckout.statusCode, 201, scheduledCheckout.body);

  const tracking = await app.inject({
    method: "GET",
    url: `/api/public/orders/${trackingToken}`
  });
  assert.equal(tracking.statusCode, 200, tracking.body);
  assert.equal(tracking.json().orderNumber, "AG-TEST-001");
  assert.equal(tracking.json().items[0].lineTotalCents, 1200);
  assert.equal(tracking.json().paymentMethod, "pix");
  assert.equal(tracking.json().paymentStatus, "pending");
  assert.equal("pix" in tracking.json(), false);
  assert.equal("customer_phone" in tracking.json(), false);
  assert.ok(calls.includes("POST create_order_with_items"));
  assert.ok(calls.includes("GET orders"));
});

test("rotas administrativas exigem uma sessao valida", async (context) => {
  supabaseFetchHandler = () => jsonResponse({ message: "invalid token" }, 401);
  context.after(() => { supabaseFetchHandler = null; });
  const app = await buildApp({ serveStatic: false });
  context.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/admin/orders"
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, "REQUEST_FAILED");
  assert.equal(response.headers["cache-control"], "no-store");

  const invalidCookie = await app.inject({
    method: "GET",
    url: "/api/admin/orders",
    headers: { cookie: "atrevida_admin_access=token-invalido" }
  });
  assert.equal(invalidCookie.statusCode, 401);
  assert.equal(invalidCookie.json().code, "REQUEST_FAILED");
});

test("progressão simples respeita entrega, retirada e encomenda", () => {
  const assertFlow = (
    fulfillmentType: "delivery" | "pickup" | "scheduled",
    statuses: Array<"pending" | "confirmed" | "ready" | "out_for_delivery" | "completed">
  ) => {
    for (let index = 0; index < statuses.length - 1; index += 1) {
      assert.equal(
        canTransitionOrder(statuses[index], statuses[index + 1], fulfillmentType),
        true,
        `${fulfillmentType}: ${statuses[index]} -> ${statuses[index + 1]}`
      );
    }
  };

  assertFlow("delivery", ["pending", "confirmed", "out_for_delivery", "completed"]);
  assertFlow("pickup", ["pending", "confirmed", "ready", "completed"]);
  assertFlow("scheduled", ["pending", "confirmed", "ready", "completed"]);
});

test("transições inválidas são recusadas e status históricos têm saída segura", () => {
  assert.equal(canTransitionOrder("pending", "ready", "pickup"), false);
  assert.equal(canTransitionOrder("confirmed", "preparing", "delivery"), false);
  assert.equal(canTransitionOrder("confirmed", "completed", "scheduled"), false);
  assert.equal(canTransitionOrder("ready", "completed", "delivery"), false);
  assert.equal(canTransitionOrder("out_for_delivery", "ready", "delivery"), false);
  assert.equal(canTransitionOrder("completed", "cancelled", "pickup"), false);
  assert.equal(canTransitionOrder("preparing", "out_for_delivery", "delivery"), true);
  assert.equal(canTransitionOrder("preparing", "ready", "pickup"), true);
});

test("admin autentica, aplica RBAC e executa os CRUDs do marco", async (context) => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const storeId = "22222222-2222-4222-8222-222222222222";
  const categoryId = "33333333-3333-4333-8333-333333333333";
  const productId = "44444444-4444-4444-8444-444444444444";
  const groupId = "55555555-5555-4555-8555-555555555555";
  const valueId = "66666666-6666-4666-8666-666666666666";
  const zoneId = "77777777-7777-4777-8777-777777777777";
  const orderId = "88888888-8888-4888-8888-888888888888";
  const calls: string[] = [];
  const inventoryRpcCalls: Array<{ name: string; input: Record<string, any> }> = [];
  let membershipRole: "owner" | "manager" | "staff" = "manager";
  let membershipStoreId = storeId;
  let storedImagePath = "";
  let storedImageProductId: string | null = null;
  let initialCategories: Array<Record<string, any>> = [];
  let categoryCreated = false;
  let category = {
    id: categoryId,
    name: "Doces",
    slug: "doces",
    active: true,
    sort_order: 0
  };
  let product = {
    id: productId,
    category_id: categoryId,
    name: "Cacerola",
    description: "",
    price_cents: 600,
    image_url: null,
    active: true,
    featured: true,
    sort_order: 0,
    created_at: "2026-09-16T10:00:00.000Z",
    updated_at: "2026-09-16T10:00:00.000Z"
  };
  let optionGroup = {
    id: groupId,
    product_id: productId,
    name: "Adicionais",
    required: false,
    min_select: 0,
    max_select: 2,
    active: true,
    sort_order: 0
  };
  let optionValue = {
    id: valueId,
    group_id: groupId,
    name: "Cobertura",
    price_delta_cents: 200,
    active: true,
    sort_order: 0
  };
  let zone = {
    id: zoneId,
    name: "Centro",
    fee_cents: 500,
    minimum_order_cents: 1000,
    active: true
  };
  let activeZoneCount = 1;
  let zoneValidationQueries = 0;
  let store = {
    id: storeId,
    slug: "atrevida-gourmet",
    name: "Atrevida Gourmet",
    description: "",
    logo_url: null,
    setup_complete: true,
    is_open: true,
    accepts_delivery: true,
    accepts_pickup: true,
    accepts_scheduled_orders: false,
    delivery_fee_mode: "zones",
    fixed_delivery_fee_cents: null,
    minimum_order_cents: 0,
    timezone: "America/Sao_Paulo",
    instagram_handle: "@atrevida_gourmet",
    whatsapp_e164: "+5514997875460",
    whatsapp_display: "(14) 99787-5460",
    scheduled_min_lead_minutes: null,
    scheduled_max_advance_days: null,
    pix_key: "pix@example.test",
    pix_merchant_name: "Atrevida Teste",
    pix_merchant_city: "Marilia"
  };
  let orderStatus = "pending";
  let paymentStatus = "pending";

  const orderRow = () => ({
    id: orderId,
    order_number: "AG-ADMIN-001",
    status: orderStatus,
    fulfillment_type: "pickup",
    customer_name: "Cliente Teste",
    customer_phone: "14999999999",
    delivery_postal_code: null,
    delivery_street: null,
    delivery_number: null,
    delivery_neighborhood: null,
    delivery_complement: null,
    delivery_reference: null,
    delivery_zone_id: null,
    scheduled_for: null,
    payment_method: "pix",
    payment_provider: "direct_pix",
    payment_status: paymentStatus,
    payment_paid_at: paymentStatus === "approved" ? "2026-09-16T10:00:30.000Z" : null,
    change_for_cents: null,
    subtotal_cents: 600,
    delivery_fee_cents: 0,
    total_cents: 600,
    note: "",
    created_at: "2026-09-16T10:00:00.000Z",
    accepted_at: orderStatus === "pending" ? null : "2026-09-16T10:01:00.000Z",
    preparing_at: null,
    ready_at: null,
    out_for_delivery_at: null,
    completed_at: null,
    cancelled_at: null,
    order_items: [{
      id: "99999999-9999-4999-8999-999999999999",
      product_name_snapshot: "Cacerola",
      unit_price_cents: 600,
      quantity: 1,
      line_total_cents: 600,
      note: "",
      options_snapshot: []
    }]
  });

  supabaseFetchHandler = (url, method, body) => {
    const table = url.pathname.split("/").at(-1) ?? "";
    const select = url.searchParams.get("select") ?? "";
    const input = (body ?? {}) as Record<string, any>;
    calls.push(`${method} ${url.pathname}`);

    if (url.pathname.startsWith("/storage/v1/object/product-images/") && method === "POST") {
      storedImagePath = decodeURIComponent(
        url.pathname.slice("/storage/v1/object/product-images/".length)
      );
      return jsonResponse({ Key: storedImagePath }, 200);
    }

    if (url.pathname.endsWith("/auth/v1/token") && method === "POST") {
      return jsonResponse({
        access_token: "manager-access-token",
        refresh_token: "manager-refresh-token",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: "bearer",
        user: {
          id: userId,
          aud: "authenticated",
          role: "authenticated",
          email: "gestora@atrevida.test",
          app_metadata: {},
          user_metadata: {},
          created_at: "2026-09-16T10:00:00.000Z"
        }
      });
    }
    if (url.pathname.endsWith("/auth/v1/user") && method === "GET") {
      return jsonResponse({
        id: userId,
        aud: "authenticated",
        role: "authenticated",
        email: "gestora@atrevida.test",
        app_metadata: {},
        user_metadata: {},
        created_at: "2026-09-16T10:00:00.000Z"
      });
    }
    if (table === "store_members") {
      return jsonResponse({
        store_id: membershipStoreId,
        role: membershipRole,
        stores: { slug: "atrevida-gourmet" }
      });
    }
    if (["set_daily_product_inventory", "adjust_daily_product_inventory"].includes(table)) {
      inventoryRpcCalls.push({ name: table, input });
      return jsonResponse({
        stockMode: input.p_stock_mode ?? "quantity",
        available: input.p_available ?? true,
        preparedToday: input.p_prepared_quantity ?? 10,
        quantityRemaining: input.p_quantity_remaining ?? 10,
        inventoryDate: "2026-09-22"
      });
    }
    if (table === "admin_audit_log") return jsonResponse([]);
    if (table === "product_images") {
      if (method === "POST") {
        storedImageProductId = null;
        return jsonResponse(null, 201);
      }
      if (method === "GET") {
        return jsonResponse({
          id: "abababab-abab-4bab-8bab-abababababab",
          product_id: storedImageProductId
        });
      }
      if (method === "PATCH") {
        storedImageProductId = String(input.product_id);
        return jsonResponse({ id: "abababab-abab-4bab-8bab-abababababab" });
      }
    }
    if (table === "orders") {
      if (method === "GET" && select.includes("id,status,fulfillment_type")) {
        if (
          url.searchParams.get("id") !== `eq.${orderId}` ||
          url.searchParams.get("store_id") !== `eq.${storeId}`
        ) return jsonResponse(null);
        return jsonResponse({
          id: orderId,
          status: orderStatus,
          fulfillment_type: "pickup",
          payment_provider: "direct_pix",
          payment_status: paymentStatus
        });
      }
      if (method === "GET") {
        if (url.searchParams.has("id")) {
          if (url.searchParams.get("store_id") !== `eq.${storeId}`) return jsonResponse(null);
          return jsonResponse(orderRow());
        }
        return jsonResponse([orderRow()]);
      }
      if (method === "PATCH") {
        orderStatus = String(input.status ?? orderStatus);
        paymentStatus = String(input.payment_status ?? paymentStatus);
        return jsonResponse(orderRow());
      }
    }
    if (table === "categories") {
      if (method === "GET" && select === "id") {
        if (url.searchParams.has("id")) return jsonResponse({ id: categoryId });
        return jsonResponse([
          ...(categoryCreated ? [{ id: categoryId }] : []),
          ...initialCategories.map((item) => ({ id: item.id }))
        ]);
      }
      if (method === "GET") return jsonResponse([
        ...(categoryCreated ? [category] : []),
        ...initialCategories
      ]);
      if (method === "POST") {
        if (Array.isArray(body)) {
          for (const row of body as Array<Record<string, any>>) {
            const existing = initialCategories.find((item) => item.slug === row.slug);
            if (existing) Object.assign(existing, row);
            else initialCategories.push({
              id: `initial-${initialCategories.length + 1}`,
              ...row
            });
          }
          return jsonResponse(initialCategories, 201);
        }
        category = { id: categoryId, name: input.name, slug: input.slug, active: input.active, sort_order: input.sort_order };
        categoryCreated = true;
        return jsonResponse(category, 201);
      }
      if (method === "PATCH") {
        category = { ...category, ...input };
        return jsonResponse(category);
      }
    }
    if (table === "products") {
      if (method === "GET" && select === "id") return jsonResponse({ id: productId });
      if (method === "GET" && select === "id,image_url") {
        return jsonResponse({ id: productId, image_url: product.image_url });
      }
      if (method === "GET") return jsonResponse([product]);
      if (method === "POST") {
        product = { ...product, ...input, id: productId };
        return jsonResponse(product, 201);
      }
      if (method === "PATCH") {
        product = { ...product, ...input };
        return jsonResponse(product);
      }
    }
    if (table === "product_option_groups") {
      if (method === "GET" && select.includes("product:products")) {
        return jsonResponse({ id: groupId, product: { store_id: storeId } });
      }
      if (method === "GET" && select.includes("required,min_select")) {
        return jsonResponse({ ...optionGroup, products: { store_id: storeId } });
      }
      if (method === "GET") return jsonResponse([optionGroup]);
      if (method === "POST") {
        optionGroup = { ...optionGroup, ...input, id: groupId };
        return jsonResponse(optionGroup, 201);
      }
      if (method === "PATCH") {
        optionGroup = { ...optionGroup, ...input };
        return jsonResponse(optionGroup);
      }
    }
    if (table === "product_option_values") {
      if (method === "GET" && select.startsWith("id, product_option_groups")) {
        return jsonResponse({ id: valueId, product_option_groups: { products: { store_id: storeId } } });
      }
      if (method === "GET") return jsonResponse([optionValue]);
      if (method === "POST") {
        optionValue = { ...optionValue, ...input, id: valueId };
        return jsonResponse(optionValue, 201);
      }
      if (method === "PATCH") {
        optionValue = { ...optionValue, ...input };
        return jsonResponse(optionValue);
      }
    }
    if (table === "delivery_zones") {
      if (method === "HEAD") {
        zoneValidationQueries += 1;
        return countResponse(activeZoneCount);
      }
      if (method === "GET") return jsonResponse([zone]);
      if (method === "POST") {
        zone = { ...zone, ...input, id: zoneId };
        return jsonResponse(zone, 201);
      }
      if (method === "PATCH") {
        zone = { ...zone, ...input };
        return jsonResponse(zone);
      }
    }
    if (table === "stores") {
      if (method === "PATCH") {
        store = { ...store, ...input };
        return jsonResponse([]);
      }
      if (select.startsWith("setup_complete")) {
        return jsonResponse({
          setup_complete: store.setup_complete,
          is_open: store.is_open,
          accepts_delivery: store.accepts_delivery,
          accepts_pickup: store.accepts_pickup,
          accepts_scheduled_orders: store.accepts_scheduled_orders,
          delivery_fee_mode: store.delivery_fee_mode,
          fixed_delivery_fee_cents: store.fixed_delivery_fee_cents,
          pix_key: store.pix_key,
          pix_merchant_name: store.pix_merchant_name,
          pix_merchant_city: store.pix_merchant_city
        });
      }
      return jsonResponse(store);
    }
    if (table === "store_payment_methods") {
      if (select === "active") return jsonResponse({ active: true });
      return jsonResponse([{ method: "pix", label: "Pix", instructions: "", active: true, sort_order: 0 }]);
    }
    return jsonResponse({ message: `Unexpected ${method} ${url.pathname}` }, 500);
  };
  context.after(() => {
    supabaseFetchHandler = null;
  });

  const app = await buildApp({ serveStatic: false });
  context.after(() => app.close());
  const origin = "http://localhost:3000";

  const login = await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    headers: { origin },
    payload: {
      email: "gestora@atrevida.test",
      password: "senha-segura",
      storeSlug: "atrevida-gourmet"
    }
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().role, "manager");
  assert.equal("accessToken" in login.json(), false);
  const setCookies = Array.isArray(login.headers["set-cookie"])
    ? login.headers["set-cookie"]
    : [String(login.headers["set-cookie"] ?? "")];
  assert.ok(setCookies.some((cookie) => cookie.includes("atrevida_admin_access=") && cookie.includes("HttpOnly")));
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
  const managerHeaders = { cookie, origin };

  const session = await app.inject({
    method: "GET",
    url: "/api/admin/auth/session",
    headers: { cookie }
  });
  assert.equal(session.statusCode, 200, session.body);
  assert.equal(session.json().email, "gestora@atrevida.test");
  assert.equal(session.json().role, "manager");

  const orders = await app.inject({ method: "GET", url: "/api/admin/orders", headers: { cookie } });
  assert.equal(orders.statusCode, 200, orders.body);
  assert.equal(orders.json()[0].orderNumber, "AG-ADMIN-001");

  const pendingPixStatus = await app.inject({
    method: "PATCH",
    url: `/api/admin/orders/${orderId}/status`,
    headers: managerHeaders,
    payload: { status: "confirmed" }
  });
  assert.equal(pendingPixStatus.statusCode, 409, pendingPixStatus.body);
  assert.match(pendingPixStatus.json().error, /Confirme o recebimento do Pix/);

  const confirmedPix = await app.inject({
    method: "POST",
    url: `/api/admin/orders/${orderId}/payment/confirm-pix`,
    headers: managerHeaders,
    payload: {}
  });
  assert.equal(confirmedPix.statusCode, 200, confirmedPix.body);
  assert.equal(confirmedPix.json().paymentStatus, "approved");
  const repeatedConfirmation = await app.inject({
    method: "POST",
    url: `/api/admin/orders/${orderId}/payment/confirm-pix`,
    headers: managerHeaders,
    payload: {}
  });
  assert.equal(repeatedConfirmation.statusCode, 200, repeatedConfirmation.body);

  const status = await app.inject({
    method: "PATCH",
    url: `/api/admin/orders/${orderId}/status`,
    headers: managerHeaders,
    payload: { status: "confirmed" }
  });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().status, "confirmed");

  membershipStoreId = "12121212-1212-4212-8212-121212121212";
  const crossStorePix = await app.inject({
    method: "POST",
    url: `/api/admin/orders/${orderId}/payment/confirm-pix`,
    headers: managerHeaders,
    payload: {}
  });
  assert.equal(crossStorePix.statusCode, 404, crossStorePix.body);
  membershipStoreId = storeId;

  await context.test(
    "bootstrap cria categorias uma vez e não recria a removida pelo administrador",
    async () => {
      const initialData = await app.inject({
        method: "POST", url: "/api/admin/store/initial-data", headers: managerHeaders,
        payload: {}
      });
      assert.equal(initialData.statusCode, 200, initialData.body);
      assert.deepEqual(initialData.json(), { applied: true, categoriesChanged: 5 });
      assert.deepEqual(
        initialCategories.map((item) => [item.name, item.slug, item.sort_order, item.active]),
        [
          ["Salgados", "salgados", 0, true],
          ["Crepes", "crepes", 10, true],
          ["Doces e Sobremesas", "doces-e-sobremesas", 20, true],
          ["Bolos", "bolos", 30, true],
          ["Bebidas", "bebidas", 40, true]
        ]
      );

      const initialDataReplay = await app.inject({
        method: "POST", url: "/api/admin/store/initial-data", headers: managerHeaders,
        payload: {}
      });
      assert.deepEqual(initialDataReplay.json(), { applied: false, categoriesChanged: 0 });

      initialCategories = initialCategories.filter((item) => item.slug !== "crepes");
      const afterAdminRemoval = await app.inject({
        method: "POST", url: "/api/admin/store/initial-data", headers: managerHeaders,
        payload: {}
      });
      assert.deepEqual(afterAdminRemoval.json(), { applied: false, categoriesChanged: 0 });
      assert.equal(initialCategories.some((item) => item.slug === "crepes"), false);
      assert.equal(initialCategories.length, 4);
    }
  );

  store.slug = "outra-loja";
  const otherStoreInitialData = await app.inject({
    method: "POST", url: "/api/admin/store/initial-data", headers: managerHeaders,
    payload: {}
  });
  assert.deepEqual(otherStoreInitialData.json(), { applied: false, categoriesChanged: 0 });
  store.slug = "atrevida-gourmet";

  const createdCategory = await app.inject({
    method: "POST", url: "/api/admin/categories", headers: managerHeaders,
    payload: { name: "Doces", slug: "doces", active: true, sortOrder: 0 }
  });
  assert.equal(createdCategory.statusCode, 201, createdCategory.body);
  const editedCategory = await app.inject({
    method: "PATCH", url: `/api/admin/categories/${categoryId}`, headers: managerHeaders,
    payload: { name: "Sobremesas" }
  });
  assert.equal(editedCategory.json().name, "Sobremesas");

  const image = await sharp({
    create: {
      width: 40,
      height: 30,
      channels: 3,
      background: { r: 180, g: 70, b: 110 }
    }
  }).png().toBuffer();
  const boundary = "----atrevida-upload-test";
  const multipartPayload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="produto.png"\r\n` +
      "Content-Type: image/png\r\n\r\n"
    ),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const uploadedImage = await app.inject({
    method: "POST",
    url: "/api/admin/uploads/product-images",
    headers: {
      ...managerHeaders,
      "content-type": `multipart/form-data; boundary=${boundary}`
    },
    payload: multipartPayload
  });
  assert.equal(uploadedImage.statusCode, 201, uploadedImage.body);
  assert.match(storedImagePath, new RegExp(`^${storeId}/[0-9a-f-]{36}\\.webp$`, "i"));
  assert.match(uploadedImage.json().imageUrl, /\/storage\/v1\/object\/public\/product-images\//);

  const createdProduct = await app.inject({
    method: "POST", url: "/api/admin/products", headers: managerHeaders,
    payload: {
      categoryId, name: "Cacerola", description: "", priceCents: 600,
      imageUrl: uploadedImage.json().imageUrl, active: true, featured: true, sortOrder: 0
    }
  });
  assert.equal(createdProduct.statusCode, 201, createdProduct.body);
  const editedProduct = await app.inject({
    method: "PATCH", url: `/api/admin/products/${productId}`, headers: managerHeaders,
    payload: { name: "Cacerola especial" }
  });
  assert.equal(editedProduct.json().name, "Cacerola especial");
  const disabledProduct = await app.inject({
    method: "DELETE", url: `/api/admin/products/${productId}`, headers: managerHeaders
  });
  assert.equal(disabledProduct.statusCode, 204, disabledProduct.body);
  assert.equal(product.active, false);

  const createdGroup = await app.inject({
    method: "POST", url: "/api/admin/option-groups", headers: managerHeaders,
    payload: { productId, name: "Adicionais", required: false, minSelect: 0, maxSelect: 2, active: true, sortOrder: 0 }
  });
  assert.equal(createdGroup.statusCode, 201, createdGroup.body);
  const createdValue = await app.inject({
    method: "POST", url: "/api/admin/option-values", headers: managerHeaders,
    payload: { groupId, name: "Cobertura", priceDeltaCents: 200, active: true, sortOrder: 0 }
  });
  assert.equal(createdValue.statusCode, 201, createdValue.body);

  const createdZone = await app.inject({
    method: "POST", url: "/api/admin/delivery-zones", headers: managerHeaders,
    payload: { name: "Centro", feeCents: 500, minimumOrderCents: 1000, active: true }
  });
  assert.equal(createdZone.statusCode, 201, createdZone.body);
  const editedZone = await app.inject({
    method: "PATCH", url: `/api/admin/delivery-zones/${zoneId}`, headers: managerHeaders,
    payload: { feeCents: 700 }
  });
  assert.equal(editedZone.json().feeCents, 700);

  const settings = await app.inject({
    method: "PATCH", url: "/api/admin/store", headers: managerHeaders,
    payload: { name: "Atrevida Gourmet Atualizada" }
  });
  assert.equal(settings.statusCode, 200, settings.body);
  assert.equal(settings.json().name, "Atrevida Gourmet Atualizada");

  const invalidFixed = await app.inject({
    method: "PATCH", url: "/api/admin/store", headers: managerHeaders,
    payload: { deliveryFeeMode: "fixed", fixedDeliveryFeeCents: null }
  });
  assert.equal(invalidFixed.statusCode, 422, invalidFixed.body);
  assert.equal(invalidFixed.json().error, "Configure a taxa de entrega antes de ativar as entregas.");

  const fixedZero = await app.inject({
    method: "PATCH", url: "/api/admin/store", headers: managerHeaders,
    payload: { deliveryFeeMode: "fixed", fixedDeliveryFeeCents: 0 }
  });
  assert.equal(fixedZero.statusCode, 200, fixedZero.body);
  assert.equal(fixedZero.json().deliveryFeeMode, "fixed");
  assert.equal(fixedZero.json().fixedDeliveryFeeCents, 0);

  activeZoneCount = 0;
  const fixedToZonesWithoutZone = await app.inject({
    method: "PATCH", url: "/api/admin/store", headers: managerHeaders,
    payload: { deliveryFeeMode: "zones" }
  });
  assert.equal(fixedToZonesWithoutZone.statusCode, 422, fixedToZonesWithoutZone.body);
  assert.equal(fixedToZonesWithoutZone.json().error, "Cadastre uma zona ativa antes de habilitar entrega.");

  store.delivery_fee_mode = "zones";
  const activeZonesModeWithoutZone = await app.inject({
    method: "PATCH", url: "/api/admin/store", headers: managerHeaders,
    payload: { name: "Atrevida ainda sem zona" }
  });
  assert.equal(activeZonesModeWithoutZone.statusCode, 422, activeZonesModeWithoutZone.body);
  assert.equal(activeZonesModeWithoutZone.json().error, "Cadastre uma zona ativa antes de habilitar entrega.");

  store.delivery_fee_mode = "fixed";
  const queriesBeforeDisabledDelivery = zoneValidationQueries;
  const disabledDeliveryZonesMode = await app.inject({
    method: "PATCH", url: "/api/admin/store", headers: managerHeaders,
    payload: { acceptsDelivery: false, deliveryFeeMode: "zones" }
  });
  assert.equal(disabledDeliveryZonesMode.statusCode, 200, disabledDeliveryZonesMode.body);
  assert.equal(zoneValidationQueries, queriesBeforeDisabledDelivery);

  activeZoneCount = 1;
  const zonesWithActiveZone = await app.inject({
    method: "PATCH", url: "/api/admin/store", headers: managerHeaders,
    payload: { acceptsDelivery: true }
  });
  assert.equal(zonesWithActiveZone.statusCode, 200, zonesWithActiveZone.body);
  assert.equal(zonesWithActiveZone.json().deliveryFeeMode, "zones");

  const managerStockMode = await app.inject({
    method: "PATCH",
    url: `/api/admin/inventory/${productId}`,
    headers: managerHeaders,
    payload: { stockMode: "quantity" }
  });
  assert.equal(managerStockMode.statusCode, 200, managerStockMode.body);

  membershipRole = "owner";
  const ownerCategories = await app.inject({
    method: "GET",
    url: "/api/admin/categories",
    headers: { authorization: "Bearer owner-access-token", "x-store-slug": "atrevida-gourmet" }
  });
  assert.equal(ownerCategories.statusCode, 200, ownerCategories.body);
  const ownerStockMode = await app.inject({
    method: "PATCH",
    url: `/api/admin/inventory/${productId}`,
    headers: { authorization: "Bearer owner-access-token", "x-store-slug": "atrevida-gourmet" },
    payload: { stockMode: "manual" }
  });
  assert.equal(ownerStockMode.statusCode, 200, ownerStockMode.body);
  const ownerDelivery = await app.inject({
    method: "PATCH", url: "/api/admin/store",
    headers: { authorization: "Bearer owner-access-token", "x-store-slug": "atrevida-gourmet" },
    payload: { deliveryFeeMode: "zones" }
  });
  assert.equal(ownerDelivery.statusCode, 200, ownerDelivery.body);

  membershipRole = "staff";
  const staffHeaders = {
    authorization: "Bearer staff-access-token",
    "x-store-slug": "atrevida-gourmet"
  };
  const forbidden = await app.inject({
    method: "GET", url: "/api/admin/categories", headers: staffHeaders
  });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  const forbiddenInitialData = await app.inject({
    method: "POST", url: "/api/admin/store/initial-data",
    headers: { ...staffHeaders, origin }, payload: {}
  });
  assert.equal(forbiddenInitialData.statusCode, 403, forbiddenInitialData.body);
  const forbiddenDeliverySettings = await app.inject({
    method: "PATCH", url: "/api/admin/store",
    headers: { ...staffHeaders, origin },
    payload: { deliveryFeeMode: "fixed", fixedDeliveryFeeCents: 500 }
  });
  assert.equal(forbiddenDeliverySettings.statusCode, 403, forbiddenDeliverySettings.body);
  const staffOrders = await app.inject({
    method: "GET", url: "/api/admin/orders", headers: staffHeaders
  });
  assert.equal(staffOrders.statusCode, 200, staffOrders.body);
  const staffAvailability = await app.inject({
    method: "PATCH", url: `/api/admin/inventory/${productId}`, headers: staffHeaders,
    payload: { available: false }
  });
  assert.equal(staffAvailability.statusCode, 200, staffAvailability.body);
  const staffDirectQuantity = await app.inject({
    method: "PATCH", url: `/api/admin/inventory/${productId}`, headers: staffHeaders,
    payload: { preparedToday: 15, quantityRemaining: 12 }
  });
  assert.equal(staffDirectQuantity.statusCode, 200, staffDirectQuantity.body);
  const staffAdjustment = await app.inject({
    method: "POST", url: `/api/admin/inventory/${productId}/adjust`, headers: staffHeaders,
    payload: { quantityDelta: 5, preparedDelta: 5 }
  });
  assert.equal(staffAdjustment.statusCode, 200, staffAdjustment.body);
  const inventoryCallsBeforeForbiddenMode = inventoryRpcCalls.length;
  const staffStockMode = await app.inject({
    method: "PATCH", url: `/api/admin/inventory/${productId}`, headers: staffHeaders,
    payload: { stockMode: "always" }
  });
  assert.equal(staffStockMode.statusCode, 403, staffStockMode.body);
  assert.equal(inventoryRpcCalls.length, inventoryCallsBeforeForbiddenMode);
  const staffStatus = await app.inject({
    method: "PATCH", url: `/api/admin/orders/${orderId}/status`, headers: staffHeaders,
    payload: { status: "confirmed" }
  });
  assert.equal(staffStatus.statusCode, 200, staffStatus.body);
  assert.equal(staffStatus.json().status, "confirmed");

  membershipStoreId = "12121212-1212-4212-8212-121212121212";
  const crossStoreStatus = await app.inject({
    method: "PATCH", url: `/api/admin/orders/${orderId}/status`, headers: staffHeaders,
    payload: { status: "ready" }
  });
  assert.equal(crossStoreStatus.statusCode, 404, crossStoreStatus.body);
  assert.equal(orderStatus, "confirmed");
  membershipStoreId = storeId;

  const logout = await app.inject({
    method: "DELETE", url: "/api/admin/session", headers: managerHeaders
  });
  assert.equal(logout.statusCode, 204, logout.body);
  assert.ok(calls.some((call) => call === "POST /auth/v1/token"));
  assert.ok(calls.some((call) => call.endsWith("/admin_audit_log")));
});
