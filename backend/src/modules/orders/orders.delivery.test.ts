import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_SECRET_KEY = "test-secret-key-with-at-least-20-characters";
process.env.SUPABASE_ANON_KEY = "test-anon-key-with-at-least-20-characters";
process.env.FRONTEND_ORIGIN = "http://localhost:3000";

const { resolveDeliveryPricing, validateStoreMinimum } = await import("./orders.service.js");

const delivery = {
  street: "Rua Teste",
  number: "10",
  neighborhood: "Centro",
  zoneId: "11111111-1111-4111-8111-111111111111"
};

test("fixed aceita taxa zero, zoneId nulo e não consulta zonas", async () => {
  let zoneQueries = 0;
  const result = await resolveDeliveryPricing({
    store: { delivery_fee_mode: "fixed", fixed_delivery_fee_cents: 0 },
    delivery,
    subtotalCents: 1_000,
    loadZone: async () => {
      zoneQueries += 1;
      return null;
    }
  });
  assert.deepEqual(result, { deliveryZoneId: null, deliveryFeeCents: 0 });
  assert.equal(zoneQueries, 0);
});

test("fixed usa taxa positiva do banco e ignora zoneId do browser", async () => {
  const result = await resolveDeliveryPricing({
    store: { delivery_fee_mode: "fixed", fixed_delivery_fee_cents: 750 },
    delivery: { ...delivery, zoneId: "22222222-2222-4222-8222-222222222222" },
    subtotalCents: 1_000,
    loadZone: async () => { throw new Error("delivery_zones não deveria ser consultada"); }
  });
  assert.deepEqual(result, { deliveryZoneId: null, deliveryFeeCents: 750 });
});

test("fixed nulo significa entrega não configurada", async () => {
  await assert.rejects(
    resolveDeliveryPricing({
      store: { delivery_fee_mode: "fixed", fixed_delivery_fee_cents: null },
      delivery,
      subtotalCents: 1_000,
      loadZone: async () => null
    }),
    /Entrega ainda não configurada/
  );
});

test("zones mantém zona obrigatória, isolamento, bairro, mínimo e taxa do banco", async () => {
  await assert.rejects(resolveDeliveryPricing({
    store: { delivery_fee_mode: "zones", fixed_delivery_fee_cents: null },
    delivery: { ...delivery, zoneId: undefined },
    subtotalCents: 2_000,
    loadZone: async () => null
  }), /Selecione uma região/);

  await assert.rejects(resolveDeliveryPricing({
    store: { delivery_fee_mode: "zones", fixed_delivery_fee_cents: null },
    delivery,
    subtotalCents: 2_000,
    loadZone: async () => null
  }), /Região de entrega inválida/);

  await assert.rejects(resolveDeliveryPricing({
    store: { delivery_fee_mode: "zones", fixed_delivery_fee_cents: null },
    delivery,
    subtotalCents: 2_000,
    loadZone: async () => ({ id: delivery.zoneId, name: "Outro bairro", fee_cents: 999, minimum_order_cents: 0 })
  }), /bairro informado/);

  await assert.rejects(resolveDeliveryPricing({
    store: { delivery_fee_mode: "zones", fixed_delivery_fee_cents: null },
    delivery,
    subtotalCents: 999,
    loadZone: async () => ({ id: delivery.zoneId, name: "Centro", fee_cents: 999, minimum_order_cents: 1_000 })
  }), /mínimo para esta região/);

  const result = await resolveDeliveryPricing({
    store: { delivery_fee_mode: "zones", fixed_delivery_fee_cents: 1 },
    delivery,
    subtotalCents: 1_000,
    loadZone: async () => ({ id: delivery.zoneId, name: " centro ", fee_cents: 650, minimum_order_cents: 1_000 })
  });
  assert.deepEqual(result, { deliveryZoneId: delivery.zoneId, deliveryFeeCents: 650 });
});

test("mínimo geral da loja continua obrigatório em fixed e zones", () => {
  assert.throws(() => validateStoreMinimum(999, 1_000), /mínimo da loja/);
  assert.doesNotThrow(() => validateStoreMinimum(1_000, 1_000));
});
