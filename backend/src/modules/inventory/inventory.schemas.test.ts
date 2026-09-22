import assert from "node:assert/strict";
import test from "node:test";
import {
  adjustInventoryBody,
  updateInventoryBody
} from "./inventory.schemas.js";

test("PATCH de estoque aceita somente modos e inteiros limitados", () => {
  assert.deepEqual(updateInventoryBody.parse({
    stockMode: "quantity",
    available: true,
    preparedToday: 12,
    quantityRemaining: 7
  }), {
    stockMode: "quantity",
    available: true,
    preparedToday: 12,
    quantityRemaining: 7
  });
  assert.throws(() => updateInventoryBody.parse({ stockMode: "automatic" }));
  assert.throws(() => updateInventoryBody.parse({ quantityRemaining: 1.5 }));
  assert.throws(() => updateInventoryBody.parse({ quantityRemaining: 100_001 }));
  assert.throws(() => updateInventoryBody.parse({ storeId: crypto.randomUUID() }));
});

test("ajuste rápido rejeita zero, decimal e valores absurdos", () => {
  assert.deepEqual(adjustInventoryBody.parse({ quantityDelta: 5, preparedDelta: 5 }), {
    quantityDelta: 5,
    preparedDelta: 5
  });
  assert.throws(() => adjustInventoryBody.parse({ quantityDelta: 0, preparedDelta: 0 }));
  assert.throws(() => adjustInventoryBody.parse({ quantityDelta: -1.5 }));
  assert.throws(() => adjustInventoryBody.parse({ quantityDelta: -100_001 }));
});
