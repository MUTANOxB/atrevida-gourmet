import { z } from "zod";

export const inventoryProductParams = z.object({
  productId: z.string().uuid()
}).strict();

export const stockModeSchema = z.enum(["always", "manual", "quantity"]);

export const updateInventoryBody = z.object({
  stockMode: stockModeSchema.optional(),
  available: z.boolean().optional(),
  preparedToday: z.number().int().min(0).max(100_000).optional(),
  quantityRemaining: z.number().int().min(0).max(100_000).optional()
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "Informe ao menos um campo de estoque."
});

export const adjustInventoryBody = z.object({
  quantityDelta: z.number().int().min(-100_000).max(100_000),
  preparedDelta: z.number().int().min(-100_000).max(100_000).default(0)
}).strict().refine(
  (value) => value.quantityDelta !== 0 || value.preparedDelta !== 0,
  { message: "Informe um ajuste diferente de zero." }
);

export type StockMode = z.infer<typeof stockModeSchema>;
export type UpdateInventoryInput = z.infer<typeof updateInventoryBody>;
export type AdjustInventoryInput = z.infer<typeof adjustInventoryBody>;
