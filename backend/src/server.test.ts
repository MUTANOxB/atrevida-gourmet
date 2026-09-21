import assert from "node:assert/strict";
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

const { buildApp } = await import("./server.js");
const { canTransitionOrder } = await import("./modules/admin/admin.service.js");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

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
  const categoryId = "33333333-3333-4333-8333-333333333333";
  const productId = "44444444-4444-4444-8444-444444444444";
  const zoneId = "55555555-5555-4555-8555-555555555555";
  const trackingToken = "66666666-6666-4666-8666-666666666666";
  const calls: string[] = [];
  let storeOpen = true;
  let acceptsScheduledOrders = false;
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
    subtotal_cents: 1200,
    delivery_fee_cents: 0,
    total_cents: 1200,
    created_at: "2026-09-16T10:00:00.000Z"
  };

  supabaseFetchHandler = (url, method, body) => {
    const table = url.pathname.split("/").at(-1) ?? "";
    calls.push(`${method} ${table}`);

    if (table === "stores") {
      const select = url.searchParams.get("select") ?? "";
      if (select.includes("categories(") && select.includes("products!products_category_same_store_fkey(")) {
        return jsonResponse({
          slug: "atrevida-gourmet",
          name: "Atrevida Gourmet",
          description: "",
          logo_url: null,
          setup_complete: true,
          is_open: storeOpen,
          accepts_delivery: true,
          accepts_pickup: true,
          accepts_scheduled_orders: acceptsScheduledOrders,
          minimum_order_cents: 0,
          currency: "BRL",
          timezone: "America/Sao_Paulo",
          instagram_handle: "@atrevida_gourmet",
          whatsapp_e164: "5514997875460",
          whatsapp_display: "(14) 99787-5460",
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
          minimum_order_cents: 0,
          timezone: "America/Sao_Paulo",
          scheduled_min_lead_minutes: 0,
          scheduled_max_advance_days: null
        });
      }
      return jsonResponse({ id: storeId, setup_complete: true, accepts_delivery: true });
    }

    if (table === "delivery_zones") {
      return jsonResponse([{ id: zoneId, name: "Centro", fee_cents: 500, minimum_order_cents: 0 }]);
    }
    if (table === "idempotency_keys") {
      if (method === "GET") return jsonResponse(null);
      return jsonResponse([]);
    }
    if (table === "store_hours") return jsonResponse(hours);
    if (table === "store_schedule_exceptions") return jsonResponse([]);
    if (table === "store_payment_methods") return jsonResponse({ method: "pix" });
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
      assert.equal((body as any).order_payload.subtotal_cents, 1200);
      assert.equal((body as any).order_payload.total_cents, 1200);
      return jsonResponse([createdOrder]);
    }
    if (table === "orders") {
      return jsonResponse({
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
      });
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

  const quote = await app.inject({
    method: "POST",
    url: "/api/public/delivery/quote",
    payload: { storeSlug: "atrevida-gourmet", neighborhood: "Centro" }
  });
  assert.equal(quote.statusCode, 200);
  assert.equal(quote.json().feeCents, 500);

  const checkout = await app.inject({
    method: "POST",
    url: "/api/public/orders",
    headers: { "idempotency-key": "88888888-8888-4888-8888-888888888888" },
    payload: {
      storeSlug: "atrevida-gourmet",
      fulfillmentType: "pickup",
      customer: { name: "Cliente Teste", phone: "14999999999" },
      paymentMethod: "pix",
      items: [{ productId, quantity: 2, options: [] }]
    }
  });
  assert.equal(checkout.statusCode, 201, checkout.body);
  assert.equal(checkout.json().trackingToken, trackingToken);
  assert.equal(checkout.json().totalCents, 1200);

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
    minimum_order_cents: 0,
    timezone: "America/Sao_Paulo",
    instagram_handle: "@atrevida_gourmet",
    whatsapp_e164: "+5514997875460",
    whatsapp_display: "(14) 99787-5460",
    scheduled_min_lead_minutes: null,
    scheduled_max_advance_days: null
  };
  let orderStatus = "pending";

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
        return jsonResponse({ id: orderId, status: orderStatus, fulfillment_type: "pickup" });
      }
      if (method === "GET") return jsonResponse([orderRow()]);
      if (method === "PATCH") {
        orderStatus = String(input.status ?? orderStatus);
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
          accepts_scheduled_orders: store.accepts_scheduled_orders
        });
      }
      return jsonResponse(store);
    }
    if (table === "store_payment_methods") {
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

  const status = await app.inject({
    method: "PATCH",
    url: `/api/admin/orders/${orderId}/status`,
    headers: managerHeaders,
    payload: { status: "confirmed" }
  });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().status, "confirmed");

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

  membershipRole = "owner";
  const ownerCategories = await app.inject({
    method: "GET",
    url: "/api/admin/categories",
    headers: { authorization: "Bearer owner-access-token", "x-store-slug": "atrevida-gourmet" }
  });
  assert.equal(ownerCategories.statusCode, 200, ownerCategories.body);

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
  const staffOrders = await app.inject({
    method: "GET", url: "/api/admin/orders", headers: staffHeaders
  });
  assert.equal(staffOrders.statusCode, 200, staffOrders.body);
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
