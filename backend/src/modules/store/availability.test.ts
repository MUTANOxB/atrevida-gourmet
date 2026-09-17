import assert from "node:assert/strict";
import test from "node:test";
import { evaluateStoreSchedule } from "./availability.js";

const overnightMonday = [{
  day_of_week: 1,
  opens_at: "22:00:00",
  closes_at: "02:00:00",
  active: true
}];

test("horario semanal noturno continua aberto depois da meia-noite", () => {
  const result = evaluateStoreSchedule({
    at: new Date("2026-09-15T01:00:00.000Z"),
    timezone: "UTC",
    hours: overnightMonday,
    exceptions: []
  });
  assert.deepEqual(result, { open: true, configured: true, source: "weekly" });
});

test("excecao fechada do dia atual prevalece sobre a faixa anterior", () => {
  const result = evaluateStoreSchedule({
    at: new Date("2026-09-15T01:00:00.000Z"),
    timezone: "UTC",
    hours: overnightMonday,
    exceptions: [{
      exception_date: "2026-09-15",
      is_closed: true,
      opens_at: null,
      closes_at: null
    }]
  });
  assert.equal(result.open, false);
  assert.equal(result.source, "exception");
});

test("excecao noturna do dia anterior pode manter a loja aberta", () => {
  const result = evaluateStoreSchedule({
    at: new Date("2026-09-15T01:00:00.000Z"),
    timezone: "UTC",
    hours: [],
    exceptions: [{
      exception_date: "2026-09-14",
      is_closed: false,
      opens_at: "22:00:00",
      closes_at: "02:00:00"
    }]
  });
  assert.deepEqual(result, { open: true, configured: true, source: "exception" });
});

test("excecao do dia anterior impede herdar o horario semanal daquele dia", () => {
  const result = evaluateStoreSchedule({
    at: new Date("2026-09-15T01:00:00.000Z"),
    timezone: "UTC",
    hours: overnightMonday,
    exceptions: [{
      exception_date: "2026-09-14",
      is_closed: true,
      opens_at: null,
      closes_at: null
    }]
  });
  assert.equal(result.open, false);
});

test("fuso invalido falha fechado", () => {
  const result = evaluateStoreSchedule({
    at: new Date("2026-09-15T01:00:00.000Z"),
    timezone: "Fuso/Inexistente",
    hours: overnightMonday,
    exceptions: []
  });
  assert.deepEqual(result, { open: false, configured: false, source: "invalid" });
});
