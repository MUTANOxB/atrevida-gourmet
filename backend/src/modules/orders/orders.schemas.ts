import { z } from "zod";

export const MAX_ORDER_LINES = 40;
export const MAX_ITEM_QUANTITY = 50;
export const MAX_OPTIONS_PER_LINE = 10;
export const MAX_TOTAL_UNITS = 200;

const selectedOption = z.object({
  groupId: z.string().uuid(),
  valueId: z.string().uuid()
}).strict();

const orderItem = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(MAX_ITEM_QUANTITY),
  note: z.string().trim().max(300).optional().default(""),
  options: z.array(selectedOption).max(MAX_OPTIONS_PER_LINE).default([])
}).strict().superRefine((item, context) => {
  const valueIds = item.options.map((option) => option.valueId);
  if (new Set(valueIds).size !== valueIds.length) {
    context.addIssue({
      code: "custom",
      path: ["options"],
      message: "Uma opção não pode ser repetida."
    });
  }
});

export const createOrderSchema = z.object({
  storeSlug: z.string().trim().min(1).max(80).regex(/^[a-z0-9-]+$/),
  fulfillmentType: z.enum(["delivery", "pickup", "scheduled"]),
  customer: z.object({
    name: z.string().trim().min(2).max(100),
    phone: z.string().trim().min(8).max(24).refine(
      (phone) => phone.replace(/\D/g, "").length >= 8,
      "Telefone inválido."
    )
  }).strict(),
  delivery: z.object({
    postalCode: z.string().trim().max(12).optional(),
    street: z.string().trim().min(2).max(120),
    number: z.string().trim().min(1).max(20),
    neighborhood: z.string().trim().min(2).max(100),
    complement: z.string().trim().max(120).optional(),
    reference: z.string().trim().max(180).optional(),
    zoneId: z.string().uuid()
  }).strict().optional(),
  scheduledFor: z.string().datetime({ offset: true }).optional(),
  paymentMethod: z.enum(["pix", "cash", "card_on_delivery"]),
  changeForCents: z.number().int().min(0).max(100_000_000).optional(),
  note: z.string().trim().max(500).optional().default(""),
  items: z.array(orderItem).min(1).max(MAX_ORDER_LINES)
}).strict().superRefine((value, context) => {
  const totalUnits = value.items.reduce((sum, item) => sum + item.quantity, 0);
  if (totalUnits > MAX_TOTAL_UNITS) {
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: `Pedido excede o máximo de ${MAX_TOTAL_UNITS} unidades.`
    });
  }

  if (value.fulfillmentType === "delivery" && !value.delivery) {
    context.addIssue({
      code: "custom",
      path: ["delivery"],
      message: "Endereço e zona de entrega são obrigatórios."
    });
  }

  if (value.fulfillmentType === "scheduled" && !value.scheduledFor) {
    context.addIssue({
      code: "custom",
      path: ["scheduledFor"],
      message: "Data da encomenda é obrigatória."
    });
  }

  if (value.fulfillmentType !== "scheduled" && value.scheduledFor) {
    context.addIssue({
      code: "custom",
      path: ["scheduledFor"],
      message: "Data de agendamento não é válida para este tipo de pedido."
    });
  }

  if (value.paymentMethod !== "cash" && value.changeForCents != null) {
    context.addIssue({
      code: "custom",
      path: ["changeForCents"],
      message: "Troco só pode ser informado para pagamento em dinheiro."
    });
  }
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const trackOrderParams = z.object({
  trackingToken: z.string().uuid()
}).strict();

export const myOrdersQuery = z.object({
  storeSlug: z.string().trim().min(1).max(80).regex(/^[a-z0-9-]+$/)
}).strict();
