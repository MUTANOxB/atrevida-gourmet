import assert from "node:assert/strict";
import test from "node:test";
import {
  createOptionGroupBody,
  replaceHoursBody,
  updateStoreBody
} from "./admin.schemas.js";

test("grupo obrigatorio exige ao menos uma opcao", () => {
  const result = createOptionGroupBody.safeParse({
    productId: "11111111-1111-4111-8111-111111111111",
    name: "Escolha",
    required: true,
    minSelect: 0,
    maxSelect: 1,
    active: true,
    sortOrder: 0
  });
  assert.equal(result.success, false);
});

test("configuracoes aceitam somente WhatsApp internacional valido", () => {
  assert.equal(updateStoreBody.safeParse({ whatsappE164: "14997875460" }).success, false);
  assert.equal(updateStoreBody.safeParse({ whatsappE164: "+5514997875460" }).success, true);
  assert.equal(updateStoreBody.safeParse({ whatsappE164: null }).success, true);
});

test("configuração de entrega aceita taxa zero e null tipado", () => {
  assert.equal(updateStoreBody.safeParse({
    deliveryFeeMode: "fixed",
    fixedDeliveryFeeCents: 0
  }).success, true);
  assert.equal(updateStoreBody.safeParse({ fixedDeliveryFeeCents: null }).success, true);
  assert.equal(updateStoreBody.safeParse({ fixedDeliveryFeeCents: 1.5 }).success, false);
  assert.equal(updateStoreBody.safeParse({ deliveryFeeMode: "distance" }).success, false);
});

test("cada dia aceita somente um intervalo no editor semanal", () => {
  const result = replaceHoursBody.safeParse({
    hours: [
      { dayOfWeek: 1, openTime: "08:00", closeTime: "12:00", closed: false },
      { dayOfWeek: 1, openTime: "13:00", closeTime: "18:00", closed: false }
    ]
  });
  assert.equal(result.success, false);
});
