import assert from "node:assert/strict";
import test from "node:test";
import { generatePixPayload, pixCrc16 } from "./pix.js";

test("gera Pix Copia e Cola com valor, TXID e campos sanitizados", () => {
  const payload = generatePixPayload({
    pixKey: "pix@example.test",
    merchantName: "João da Silva & Cia",
    merchantCity: "São Paulo",
    amountCents: 12345,
    txid: "AG-2026-0001"
  });

  assert.match(payload, /^00020126/);
  assert.match(payload, /5406123\.45/);
  assert.match(payload, /5917JOAO DA SILVA CIA/);
  assert.match(payload, /6009SAO PAULO/);
  assert.match(payload, /62140510AG20260001/);
});

test("CRC do payload Pix corresponde ao conteúdo completo", () => {
  const payload = generatePixPayload({
    pixKey: "12345678901",
    merchantName: "Loja Teste",
    merchantCity: "Marilia",
    amountCents: 600,
    txid: "PEDIDO1"
  });
  const content = payload.slice(0, -4);
  assert.equal(payload.slice(-4), pixCrc16(content));
  assert.match(payload, /6304[0-9A-F]{4}$/);
});
