import assert from "node:assert/strict";
import test from "node:test";
import { publicOrderTrackingDto, publicStoreDto } from "./public-dto.js";

test("DTO público expõe somente o modo e a taxa fixa necessária", () => {
  const fixed = publicStoreDto({
    slug: "atrevida-gourmet", name: "Atrevida", description: "", is_open: true,
    accepts_delivery: true, accepts_pickup: true, accepts_scheduled_orders: false,
    delivery_fee_mode: "fixed", fixed_delivery_fee_cents: 0,
    minimum_order_cents: 0, currency: "BRL", secret_note: "não expor"
  });
  assert.equal(fixed.acceptsDelivery, true);
  assert.equal(fixed.deliveryFeeMode, "fixed");
  assert.equal(fixed.fixedDeliveryFeeCents, 0);
  assert.equal(Object.hasOwn(fixed, "secret_note"), false);

  const pending = publicStoreDto({
    slug: "x", name: "X", accepts_delivery: true,
    delivery_fee_mode: "fixed", fixed_delivery_fee_cents: null
  });
  assert.equal(pending.acceptsDelivery, false);

  const zones = publicStoreDto({
    slug: "x", name: "X", accepts_delivery: true,
    delivery_fee_mode: "zones", fixed_delivery_fee_cents: 500
  });
  assert.equal(Object.hasOwn(zones, "fixedDeliveryFeeCents"), false);
});

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
