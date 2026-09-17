import assert from "node:assert/strict";
import test from "node:test";
import {
  createOrderSchema,
  MAX_ITEM_QUANTITY,
  MAX_ORDER_LINES,
  MAX_TOTAL_UNITS
} from "./orders.schemas.js";

const productId = "11111111-1111-4111-8111-111111111111";

function validOrder() {
  return {
    storeSlug: "atrevida-gourmet",
    fulfillmentType: "pickup",
    customer: { name: "Cliente Teste", phone: "14999999999" },
    paymentMethod: "pix",
    note: "",
    items: [{ productId, quantity: 1, note: "", options: [] }]
  };
}

test("nao aceita preco, subtotal, taxa ou total enviados pelo navegador", () => {
  for (const field of ["priceCents", "subtotalCents", "deliveryFeeCents", "totalCents"]) {
    const result = createOrderSchema.safeParse({ ...validOrder(), [field]: 1 });
    assert.equal(result.success, false, `campo adulterado aceito: ${field}`);
  }

  const itemPrice = validOrder();
  Object.assign(itemPrice.items[0], { unitPriceCents: 1, lineTotalCents: 1 });
  assert.equal(createOrderSchema.safeParse(itemPrice).success, false);
});

test("nao aceita store_id nem campos internos manipulados", () => {
  const topLevel = {
    ...validOrder(),
    storeId: "22222222-2222-4222-8222-222222222222",
    userId: "33333333-3333-4333-8333-333333333333"
  };
  assert.equal(createOrderSchema.safeParse(topLevel).success, false);

  const nested = validOrder();
  Object.assign(nested.items[0], {
    storeId: "22222222-2222-4222-8222-222222222222",
    productStoreId: "22222222-2222-4222-8222-222222222222"
  });
  assert.equal(createOrderSchema.safeParse(nested).success, false);
});

test("aplica limites de linhas, quantidade por linha e unidades totais", () => {
  const tooManyLines = validOrder();
  tooManyLines.items = Array.from({ length: MAX_ORDER_LINES + 1 }, () => ({
    productId,
    quantity: 1,
    note: "",
    options: []
  }));
  assert.equal(createOrderSchema.safeParse(tooManyLines).success, false);

  const tooManyOnLine = validOrder();
  tooManyOnLine.items[0].quantity = MAX_ITEM_QUANTITY + 1;
  assert.equal(createOrderSchema.safeParse(tooManyOnLine).success, false);

  const tooManyUnits = validOrder();
  tooManyUnits.items = Array.from({ length: 5 }, () => ({
    productId,
    quantity: Math.floor(MAX_TOTAL_UNITS / 5) + 1,
    note: "",
    options: []
  }));
  assert.equal(createOrderSchema.safeParse(tooManyUnits).success, false);
});
