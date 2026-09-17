import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../../lib/errors.js";
import type { CreateOrderInput } from "./orders.schemas.js";
import { priceOrderItems, type PricingProduct } from "./pricing.js";

const productId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const valueId = "33333333-3333-4333-8333-333333333333";

const products: PricingProduct[] = [{
  id: productId,
  name: "Cacerola",
  price_cents: 600,
  active: true,
  categoryActive: true,
  optionGroups: [{
    id: groupId,
    name: "Adicionais",
    required: false,
    min_select: 0,
    max_select: 1,
    active: true,
    values: [{
      id: valueId,
      name: "Extra confirmado",
      price_delta_cents: 150,
      active: true
    }]
  }]
}];

function item(overrides: Partial<CreateOrderInput["items"][number]> = {}) {
  return {
    productId,
    quantity: 2,
    note: "",
    options: [{ groupId, valueId }],
    ...overrides
  };
}

test("recalcula subtotal e snapshots apenas com precos carregados do banco", () => {
  const result = priceOrderItems([item()], products);

  assert.equal(result.subtotalCents, 1_500);
  assert.deepEqual(result.preparedItems[0], {
    product_id: productId,
    product_name_snapshot: "Cacerola",
    unit_price_cents: 750,
    quantity: 2,
    line_total_cents: 1_500,
    note: "",
    options_snapshot: [{
      groupId,
      groupName: "Adicionais",
      valueId,
      valueName: "Extra confirmado",
      priceDeltaCents: 150
    }]
  });
});

test("rejeita produto ausente ou pertencente a outra loja", () => {
  assert.throws(
    () => priceOrderItems([item()], []),
    (error) => error instanceof HttpError && error.statusCode === 422
  );
});

test("rejeita adicional que nao pertence ao produto", () => {
  assert.throws(
    () => priceOrderItems([item({
      options: [{
        groupId,
        valueId: "44444444-4444-4444-8444-444444444444"
      }]
    })], products),
    (error) => error instanceof HttpError && error.statusCode === 422
  );
});
