import { randomInt } from "node:crypto";

export function createOrderNumber(now = new Date()) {
  const datePart =
    String(now.getFullYear()).slice(-2) +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");

  const randomPart = randomInt(0, 1_000_000).toString().padStart(6, "0");
  return `${datePart}-${randomPart}`;
}
