import assert from "node:assert/strict";
import test from "node:test";
import { loggerOptions, redactRequestUrl } from "./safe-logger.js";

test("logger remove tracking token da URL", () => {
  const url = "/api/public/orders/11111111-1111-4111-8111-111111111111?x=1";
  assert.equal(redactRequestUrl(url), "/api/public/orders/[REDACTED]?x=1");
});

test("serializer de request nao inclui headers, cookie, body ou PII", () => {
  const serialized = loggerOptions.serializers.req({
    method: "POST",
    url: "/api/public/orders",
    ip: "127.0.0.1",
    headers: { authorization: "Bearer private", cookie: "private" },
    body: { customer: { phone: "14999999999" }, delivery: { street: "privada" } }
  });
  assert.deepEqual(serialized, {
    method: "POST",
    url: "/api/public/orders",
    remoteAddress: "127.0.0.1"
  });
  assert.equal(JSON.stringify(serialized).includes("14999999999"), false);
  assert.equal(JSON.stringify(serialized).includes("private"), false);
});
