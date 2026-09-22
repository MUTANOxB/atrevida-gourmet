import { randomInt } from "node:crypto";

export function createOrderNumber(now = new Date(), timeZone = "UTC") {
  const dateParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "2-digit",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(now).map(({ type, value }) => [type, value])
  );
  const datePart = `${dateParts.year}${dateParts.month}${dateParts.day}`;

  const randomPart = randomInt(0, 1_000_000).toString().padStart(6, "0");
  return `${datePart}-${randomPart}`;
}
