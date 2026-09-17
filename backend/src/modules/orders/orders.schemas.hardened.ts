import { z } from "zod";

const MAX_ORDER_LINES = 40;
const MAX_ITEM_QUANTITY = 50;
const MAX_OPTIONS_PER_LINE = 10;
const MAX_TOTAL_UNITS = 200;

const selectedOption = z.object({
  groupId: z.string().uuid(),
  valueId: z.string().uuid()
});

const orderItem = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(MAX_ITEM_QUANTITY),

  note: z
    .string()
    .trim()
    .max(300)
    .optional()
    .default(""),

  options: z
    .array(selectedOption)
    .max(MAX_OPTIONS_PER_LINE)
    .default([])
});

export const hardenedCreateOrderSchema = z.object({
  storeSlug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/),

  fulfillmentType: z.enum([
    "delivery",
    "pickup",
    "scheduled"
  ]),

  customer: z.object({
    name: z.string().trim().min(2).max(100),
    phone: z.string().trim().min(8).max(24)
  }),

  delivery: z.object({
    postalCode: z.string().trim().max(12).optional(),
    street: z.string().trim().max(120).optional(),
    number: z.string().trim().max(20).optional(),
    neighborhood: z.string().trim().max(100).optional(),
    complement: z.string().trim().max(120).optional(),
    reference: z.string().trim().max(180).optional(),
    zoneId: z.string().uuid().optional()
  }).optional(),

  scheduledFor: z.string().datetime().optional(),

  paymentMethod: z.enum([
    "pix",
    "cash",
    "card_on_delivery"
  ]),

  changeForCents: z
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .optional(),

  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .default(""),

  items: z
    .array(orderItem)
    .min(1)
    .max(MAX_ORDER_LINES)
}).superRefine((value, ctx) => {
  const totalUnits = value.items.reduce(
    (sum, item) => sum + item.quantity,
    0
  );

  if (totalUnits > MAX_TOTAL_UNITS) {
    ctx.addIssue({
      code: "custom",
      path: ["items"],
      message: `Pedido excede o máximo de ${MAX_TOTAL_UNITS} unidades.`
    });
  }

  if (
    value.fulfillmentType === "delivery" &&
    !value.delivery
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["delivery"],
      message: "Dados de entrega são obrigatórios."
    });
  }
});
