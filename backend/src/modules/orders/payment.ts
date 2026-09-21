export type SupportedPaymentMethod = "pix" | "cash" | "card_on_delivery";

export function initialPaymentState(method: SupportedPaymentMethod) {
  return method === "pix"
    ? { paymentProvider: "direct_pix" as const, paymentStatus: "pending" as const }
    : { paymentProvider: "offline" as const, paymentStatus: "pay_on_delivery" as const };
}

export function canAcceptOrderPayment(paymentProvider: string, paymentStatus: string) {
  return paymentProvider !== "direct_pix" || paymentStatus === "approved";
}
