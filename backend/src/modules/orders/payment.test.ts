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

test("direct_pix pendente bloqueia aceite", () => {
  assert.equal(canAcceptOrderPayment("direct_pix", "pending"), false);
});

test("direct_pix recusado bloqueia aceite", () => {
  assert.equal(canAcceptOrderPayment("direct_pix", "rejected"), false);
});

test("direct_pix cancelado bloqueia aceite", () => {
  assert.equal(canAcceptOrderPayment("direct_pix", "cancelled"), false);
});

test("direct_pix estornado bloqueia aceite", () => {
  assert.equal(canAcceptOrderPayment("direct_pix", "refunded"), false);
});

test("direct_pix aprovado permite aceite", () => {
  assert.equal(canAcceptOrderPayment("direct_pix", "approved"), true);
});

test("offline com pagamento na entrega permite aceite", () => {
  assert.equal(canAcceptOrderPayment("offline", "pay_on_delivery"), true);
});
