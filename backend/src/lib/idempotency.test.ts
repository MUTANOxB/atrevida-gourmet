import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_SECRET_KEY = "test-secret-key-with-at-least-20-characters";
process.env.FRONTEND_ORIGIN = "http://localhost:3000";

type RecordValue = {
  key: string;
  store_id: string;
  request_hash: string;
  order_id?: string | null;
  response_status?: number | null;
  response_body?: unknown;
  completed_at?: string | null;
};

const records = new Map<string, RecordValue>();

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function equality(url: URL, name: string) {
  return (url.searchParams.get(name) ?? "").replace(/^eq\./, "");
}

globalThis.fetch = (async (input, init) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request?.url ?? String(input));
  const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
  if (!url.pathname.endsWith("/rest/v1/idempotency_keys")) {
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  }

  const raw = init?.body ?? (request ? await request.clone().text() : null);
  const parsed = typeof raw === "string" && raw ? JSON.parse(raw) : null;
  const body = Array.isArray(parsed) ? parsed[0] : parsed;
  const key = equality(url, "key") || String(body?.key ?? "");
  const storeId = equality(url, "store_id") || String(body?.store_id ?? "");
  const compound = `${storeId}:${key}`;

  if (method === "DELETE") return response([]);
  if (method === "GET") return response(records.get(compound) ?? null);
  if (method === "POST") {
    if (records.has(compound)) {
      return response({ code: "23505", message: "duplicate" }, 409);
    }
    records.set(compound, { ...body });
    return response(null, 201);
  }
  if (method === "PATCH") {
    const current = records.get(compound);
    if (current) records.set(compound, { ...current, ...body });
    return response(null);
  }
  throw new Error(`Unexpected method: ${method}`);
}) as typeof fetch;

const {
  completeIdempotency,
  reserveIdempotency
} = await import("./idempotency.js");

const storeA = "11111111-1111-4111-8111-111111111111";
const storeB = "22222222-2222-4222-8222-222222222222";

test.beforeEach(() => records.clear());

test("replay devolve a mesma resposta e rejeita conteudo diferente", async () => {
  const key = "33333333-3333-4333-8333-333333333333";
  const first = await reserveIdempotency({ key, storeId: storeA, requestHash: "hash-a" });
  assert.deepEqual(first, { kind: "reserved" });

  const body = { orderNumber: "AG-001", trackingToken: "token" };
  await completeIdempotency(key, storeA, "44444444-4444-4444-8444-444444444444", 201, body);
  const replay = await reserveIdempotency({ key, storeId: storeA, requestHash: "hash-a" });
  assert.deepEqual(replay, { kind: "replay", statusCode: 201, body });

  await assert.rejects(
    reserveIdempotency({ key, storeId: storeA, requestHash: "hash-adulterado" }),
    /reutilizada com outro conteúdo/
  );
});

test("reservas simultaneas permitem somente um checkout em processamento", async () => {
  const key = "55555555-5555-4555-8555-555555555555";
  const results = await Promise.allSettled([
    reserveIdempotency({ key, storeId: storeA, requestHash: "hash" }),
    reserveIdempotency({ key, storeId: storeA, requestHash: "hash" })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.match(String(rejected && rejected.status === "rejected" && rejected.reason.message), /processamento/);
});

test("a mesma chave fica isolada por store_id", async () => {
  const key = "66666666-6666-4666-8666-666666666666";
  const [left, right] = await Promise.all([
    reserveIdempotency({ key, storeId: storeA, requestHash: "hash-a" }),
    reserveIdempotency({ key, storeId: storeB, requestHash: "hash-b" })
  ]);
  assert.deepEqual(left, { kind: "reserved" });
  assert.deepEqual(right, { kind: "reserved" });
});
