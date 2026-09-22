import assert from "node:assert/strict";
import test from "node:test";
import { createOrderNumber } from "./order-number.js";

test("gera a data do número do pedido no timezone da loja", () => {
  const orderNumber = createOrderNumber(
    new Date("2026-09-22T01:30:00.000Z"),
    "America/Sao_Paulo"
  );

  assert.match(orderNumber, /^260921-\d{6}$/);
});

test("preserva o formato YYMMDD-XXXXXX", () => {
  assert.match(createOrderNumber(new Date("2026-09-22T12:00:00.000Z")), /^260922-\d{6}$/);
});
