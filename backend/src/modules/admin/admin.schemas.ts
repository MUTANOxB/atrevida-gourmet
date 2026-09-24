import { z } from "zod";

export const orderStatusSchema = z.enum([
  "pending", "confirmed", "preparing", "ready", "out_for_delivery",
  "completed", "cancelled"
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const uuidParams = z.object({ id: z.string().uuid() }).strict();
export const orderIdParams = z.object({ orderId: z.string().uuid() }).strict();
export const emptyBody = z.object({}).strict();
export const updateOrderStatusBody = z.object({
  status: orderStatusSchema,
  reason: z.string().trim().max(300).optional()
}).strict();
export const listOrdersQuery = z.object({
  status: orderStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100)
}).strict();

const categoryFields = {
  name: z.string().trim().min(2).max(100),
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9-]+$/),
  active: z.boolean(),
  sortOrder: z.number().int().min(-100_000).max(100_000)
};
export const createCategoryBody = z.object(categoryFields).strict();
export const updateCategoryBody = z.object(categoryFields).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "Informe ao menos um campo."
);

const productFields = {
  categoryId: z.string().uuid(),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1000),
  priceCents: z.number().int().min(0).max(100_000_000).nullable(),
  imageUrl: z.string().url().max(2048).nullable(),
  active: z.boolean(),
  featured: z.boolean(),
  sortOrder: z.number().int().min(-100_000).max(100_000)
};
export const createProductBody = z.object(productFields).strict();
export const updateProductBody = z.object(productFields).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "Informe ao menos um campo."
);

const optionGroupFields = {
  productId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  required: z.boolean(),
  minSelect: z.number().int().min(0).max(10),
  maxSelect: z.number().int().min(1).max(10),
  active: z.boolean(),
  sortOrder: z.number().int().min(-100_000).max(100_000)
};
const validSelectionRange = (value: { minSelect: number; maxSelect: number }) =>
  value.maxSelect >= value.minSelect;
export const createOptionGroupBody = z.object(optionGroupFields)
  .strict()
  .refine(validSelectionRange, { message: "maxSelect deve ser maior ou igual a minSelect." })
  .refine((value) => !value.required || value.minSelect >= 1, {
    message: "Grupos obrigatórios devem exigir ao menos uma opção."
  });
export const updateOptionGroupBody = z.object(optionGroupFields).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "Informe ao menos um campo."
).superRefine((value, context) => {
  if (
    value.minSelect !== undefined &&
    value.maxSelect !== undefined &&
    value.maxSelect < value.minSelect
  ) {
    context.addIssue({
      code: "custom",
      message: "maxSelect deve ser maior ou igual a minSelect."
    });
  }
});

const optionValueFields = {
  groupId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  priceDeltaCents: z.number().int().min(-100_000_000).max(100_000_000),
  active: z.boolean(),
  sortOrder: z.number().int().min(-100_000).max(100_000)
};
export const createOptionValueBody = z.object(optionValueFields).strict();
export const updateOptionValueBody = z.object(optionValueFields).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "Informe ao menos um campo."
);

const zoneFields = {
  name: z.string().trim().min(2).max(100),
  feeCents: z.number().int().min(0).max(100_000_000),
  minimumOrderCents: z.number().int().min(0).max(100_000_000),
  active: z.boolean()
};
export const createZoneBody = z.object(zoneFields).strict();
export const updateZoneBody = z.object(zoneFields).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "Informe ao menos um campo."
);

const paymentMethodCode = z.enum(["pix", "cash", "card_on_delivery"]);
export const paymentMethodSchema = z.object({
  method: paymentMethodCode,
  label: z.string().trim().min(1).max(80),
  instructions: z.string().trim().max(500).default(""),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(-1000).max(1000).default(0)
}).strict();

const paymentLabels: Record<z.infer<typeof paymentMethodCode>, string> = {
  pix: "Pix",
  cash: "Dinheiro",
  card_on_delivery: "Cartão na entrega"
};

const paymentMethodInput = z.union([paymentMethodSchema, paymentMethodCode])
  .transform((value) => typeof value === "string"
    ? {
        method: value,
        label: paymentLabels[value],
        instructions: "",
        active: true,
        sortOrder: 0
      }
    : value);

export const updateStoreBody = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  logoUrl: z.string().url().max(2048).nullable().optional(),
  isOpen: z.boolean().optional(),
  acceptsDelivery: z.boolean().optional(),
  acceptsPickup: z.boolean().optional(),
  acceptsScheduledOrders: z.boolean().optional(),
  deliveryFeeMode: z.enum(["fixed", "zones"]).optional(),
  fixedDeliveryFeeCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  minimumOrderCents: z.number().int().min(0).max(100_000_000).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
  instagram: z.string().trim().max(100).nullable().optional(),
  whatsappE164: z.string().trim().regex(/^\+[1-9]\d{7,14}$/).nullable().optional(),
  whatsappDisplay: z.string().trim().max(30).nullable().optional(),
  scheduledMinLeadMinutes: z.number().int().min(0).max(525_600).nullable().optional(),
  scheduledMaxAdvanceDays: z.number().int().min(1).max(3_650).nullable().optional(),
  pixKey: z.string().trim().min(1).max(77).nullable().optional(),
  pixMerchantName: z.string().trim().min(1).max(25).nullable().optional(),
  pixMerchantCity: z.string().trim().min(1).max(15).nullable().optional(),
  setupComplete: z.boolean().optional(),
  paymentMethods: z.array(paymentMethodInput).max(3).optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo.")
  .superRefine((value, context) => {
    if (value.paymentMethods) {
      const methods = value.paymentMethods.map((method) => method.method);
      if (new Set(methods).size !== methods.length) {
        context.addIssue({
          code: "custom",
          path: ["paymentMethods"],
          message: "Uma forma de pagamento não pode ser repetida."
        });
      }
    }
  });

const hourInput = z.object({
  id: z.string().uuid().optional(),
  dayOfWeek: z.number().int().min(0).max(6),
  openTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/).nullable().optional(),
  closeTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/).nullable().optional(),
  closed: z.boolean().default(false),
  acceptsScheduledOrders: z.boolean().optional()
}).strict().superRefine((value, context) => {
  if (!value.closed && (!value.openTime || !value.closeTime)) {
    context.addIssue({ code: "custom", message: "Abertura e fechamento são obrigatórios." });
  }
  if (!value.closed && value.openTime === value.closeTime) {
    context.addIssue({ code: "custom", message: "Abertura e fechamento devem ser diferentes." });
  }
});
export const replaceHoursBody = z.object({ hours: z.array(hourInput).max(7) }).strict()
  .superRefine((value, context) => {
    const days = value.hours.map((hour) => hour.dayOfWeek);
    if (new Set(days).size !== days.length) {
      context.addIssue({
        code: "custom",
        path: ["hours"],
        message: "Cada dia da semana deve aparecer no máximo uma vez."
      });
    }
  });

const exceptionFields = {
  exceptionDate: z.string().date(),
  isClosed: z.boolean(),
  openTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/).nullable(),
  closeTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/).nullable(),
  note: z.string().trim().max(300)
};

function normalizeExceptionAliases(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = { ...(value as Record<string, unknown>) };
  if (normalized.exceptionDate === undefined && normalized.date !== undefined) {
    normalized.exceptionDate = normalized.date;
  }
  if (normalized.isClosed === undefined && normalized.closed !== undefined) {
    normalized.isClosed = normalized.closed;
  }
  delete normalized.date;
  delete normalized.closed;
  return normalized;
}

const createExceptionObject = z.object(exceptionFields).strict().superRefine((value, context) => {
  if (!value.isClosed && (!value.openTime || !value.closeTime)) {
    context.addIssue({ code: "custom", message: "Horários são obrigatórios quando a loja abre." });
  }
  if (!value.isClosed && value.openTime === value.closeTime) {
    context.addIssue({ code: "custom", message: "Abertura e fechamento devem ser diferentes." });
  }
});

const updateExceptionObject = z.object(exceptionFields).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "Informe ao menos um campo."
).superRefine((value, context) => {
  if (value.isClosed === false && (!value.openTime || !value.closeTime)) {
    context.addIssue({ code: "custom", message: "Horários são obrigatórios quando a loja abre." });
  }
  if ((value.openTime && !value.closeTime) || (!value.openTime && value.closeTime)) {
    context.addIssue({ code: "custom", message: "Informe abertura e fechamento juntos." });
  }
  if (value.openTime && value.openTime === value.closeTime) {
    context.addIssue({ code: "custom", message: "Abertura e fechamento devem ser diferentes." });
  }
});

export const createExceptionBody = z.preprocess(
  normalizeExceptionAliases,
  createExceptionObject
);
export const updateExceptionBody = z.preprocess(
  normalizeExceptionAliases,
  updateExceptionObject
);
