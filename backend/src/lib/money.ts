export function centsFromDecimal(value: number) {
  return Math.round(value * 100);
}

export function decimalFromCents(value: number) {
  return Number((value / 100).toFixed(2));
}
