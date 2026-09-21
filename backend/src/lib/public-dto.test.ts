import assert from "node:assert/strict";
import test from "node:test";
import { publicOrderTrackingDto } from "./public-dto.js";

test("tracking publico usa allowlist e nao retorna dados pessoais", () => {
  const dto = publicOrderTrackingDto({
    order_number: "AG-TESTE",
    status: "pending",
    payment_method: "pix",
    payment_status: "pending",
    fulfillment_type: "delivery",
    subtotal_cents: 600,
    delivery_fee_cents: 0,
    total_cents: 600,
    created_at: "2026-09-16T10:00:00.000Z",
    customer_name: "Nome privado",
    customer_phone: "14999999999",
    delivery_street: "Rua privada",
    store_id: "11111111-1111-4111-8111-111111111111",
    payment_confirmed_by: "22222222-2222-4222-8222-222222222222",
    pix_key: "private@example.test",
    order_items: []
  });

  assert.equal(dto.orderNumber, "AG-TESTE");
  assert.equal(dto.paymentMethod, "pix");
  assert.equal(dto.paymentStatus, "pending");
  for (const forbidden of [
    "customer_name",
    "customerName",
    "customer_phone",
    "customerPhone",
    "delivery_street",
    "delivery",
    "store_id",
    "storeId",
    "payment_confirmed_by",
    "paymentConfirmedBy",
    "pix_key",
    "pixKey"
  ]) {
    assert.equal(Object.hasOwn(dto, forbidden), false, `tracking vazou ${forbidden}`);
  }
});
