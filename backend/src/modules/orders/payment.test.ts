import assert from "node:assert/strict";
import test from "node:test";
import { canAcceptOrderPayment, initialPaymentState } from "./payment.js";

test("Pix inicia pendente no provedor direto", () => {
  assert.deepEqual(initialPaymentState("pix"), {
    paymentProvider: "direct_pix",
    paymentStatus: "pending"
  });
});

test("dinheiro inicia como pagamento na entrega", () => {
  assert.deepEqual(initialPaymentState("cash"), {
    paymentProvider: "offline",
    paymentStatus: "pay_on_delivery"
  });
});

test("cartão na entrega inicia como pagamento na entrega", () => {
  assert.deepEqual(initialPaymentState("card_on_delivery"), {
    paymentProvider: "offline",
    paymentStatus: "pay_on_delivery"
  });
});

test("Pix pendente bloqueia aceite e Pix aprovado permite o fluxo", () => {
  assert.equal(canAcceptOrderPayment("direct_pix", "pending"), false);
  assert.equal(canAcceptOrderPayment("direct_pix", "approved"), true);
});

test("pagamento na entrega segue sem confirmação prévia", () => {
  assert.equal(canAcceptOrderPayment("offline", "pay_on_delivery"), true);
});
