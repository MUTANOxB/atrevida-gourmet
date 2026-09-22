import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SECRET_KEY = "sb_secret_test_inventory_abcdefghijklmnopqrstuvwxyz";
process.env.FRONTEND_ORIGIN = "http://localhost:3000";

const {
  effectiveInventory,
  isStockConflictError,
  storeLocalDate
} = await import("./inventory.service.js");

test("produto sem configuração permanece always e disponível", () => {
  assert.deepEqual(effectiveInventory(undefined, undefined), {
    stockMode: "always",
    available: true,
    remainingQuantity: null,
    lowStock: false
  });
});

test("manual sem registro do dia fica indisponível", () => {
  const result = effectiveInventory(
    { product_id: "product", stock_mode: "manual" },
    undefined
  );
  assert.equal(result.available, false);
  assert.equal(result.remainingQuantity, null);
});

test("manual respeita disponível e esgotado do registro diário", () => {
  const setting = { product_id: "product", stock_mode: "manual" } as const;
  const daily = {
    product_id: "product",
    inventory_date: "2026-09-22",
    available: true,
    prepared_quantity: 0,
    quantity_remaining: 0
  };
  assert.equal(effectiveInventory(setting, daily).available, true);
  assert.equal(effectiveInventory(setting, { ...daily, available: false }).available, false);
});

test("quantity sem registro do dia fica zerado e indisponível", () => {
  const result = effectiveInventory(
    { product_id: "product", stock_mode: "quantity" },
    undefined
  );
  assert.equal(result.available, false);
  assert.equal(result.remainingQuantity, 0);
  assert.equal(result.lowStock, false);
});

test("quantity suficiente fica disponível e nunca publica valor negativo", () => {
  const setting = { product_id: "product", stock_mode: "quantity" } as const;
  const daily = {
    product_id: "product",
    inventory_date: "2026-09-22",
    available: true,
    prepared_quantity: 10,
    quantity_remaining: 8
  };
  assert.deepEqual(effectiveInventory(setting, daily), {
    stockMode: "quantity",
    available: true,
    remainingQuantity: 8,
    lowStock: false
  });
  assert.equal(effectiveInventory(setting, { ...daily, quantity_remaining: -2 }).remainingQuantity, 0);
});

test("estoque baixo é limitado a quantity entre uma e cinco unidades", () => {
  const setting = { product_id: "product", stock_mode: "quantity" } as const;
  const base = {
    product_id: "product",
    inventory_date: "2026-09-22",
    available: true,
    prepared_quantity: 10,
    quantity_remaining: 1
  };
  for (const quantity of [1, 2, 3, 4, 5]) {
    assert.equal(effectiveInventory(setting, { ...base, quantity_remaining: quantity }).lowStock, true);
  }
  assert.equal(effectiveInventory(setting, { ...base, quantity_remaining: 6 }).lowStock, false);
  assert.equal(effectiveInventory(setting, { ...base, quantity_remaining: 0 }).lowStock, false);
});

test("data do estoque usa o timezone da loja na virada do dia", () => {
  const instant = new Date("2026-09-23T01:30:00.000Z");
  assert.equal(storeLocalDate("America/Sao_Paulo", instant), "2026-09-22");
  assert.equal(storeLocalDate("UTC", instant), "2026-09-23");
});

test("somente o marcador interno exato é reconhecido como conflito de estoque", () => {
  assert.equal(isStockConflictError({ code: "P0001", message: "ATREVIDA_STOCK_CONFLICT" }), true);
  assert.equal(isStockConflictError({ code: "P0001", message: "outro erro" }), false);
  assert.equal(isStockConflictError({ code: "23505", message: "ATREVIDA_STOCK_CONFLICT" }), false);
});

test("estado público não expõe preparado, eventos ou estatísticas administrativas", () => {
  const result = effectiveInventory(
    { product_id: "product", stock_mode: "quantity" },
    {
      product_id: "product",
      inventory_date: "2026-09-22",
      available: true,
      prepared_quantity: 10,
      quantity_remaining: 3
    }
  );
  assert.deepEqual(Object.keys(result).sort(), [
    "available",
    "lowStock",
    "remainingQuantity",
    "stockMode"
  ]);
});

test("checkout converte somente o marcador de estoque em conflito público 409", () => {
  const source = readFileSync(
    new URL("../orders/orders.service.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /if \(isStockConflictError\(error\)\)[\s\S]*?new HttpError\([\s\S]*?409/);
  assert.match(source, /Alguns itens acabaram ou não possuem mais a quantidade solicitada\./);
  assert.doesNotMatch(source, /product_inventory_(?:daily|events|settings).*HttpError/);
});

test("rotas administrativas obtêm storeId da sessão e aceitam staff autenticado", () => {
  const source = readFileSync(
    new URL("./inventory.routes.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /storeId: request\.admin!\.storeId/);
  assert.match(source, /app\.addHook\("preHandler", requireAdmin\)/);
  assert.match(source, /requireAdminWriteOrigin/);
  assert.doesNotMatch(source, /requireRoles/);
  assert.doesNotMatch(source, /request\.body[\s\S]*?storeId/);
});

test("catálogo preserva produto esgotado e anexa somente o DTO público de estoque", () => {
  const source = readFileSync(
    new URL("../catalog/catalog.service.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /\.filter\(\(product: any\) => product\.active && product\.price_cents != null\)/);
  assert.match(source, /const inventory = effectiveInventory/);
  assert.match(source, /\.\.\.inventory/);
  assert.doesNotMatch(source, /soldOutLast30Days|preparedToday|product_inventory_events/);
});
