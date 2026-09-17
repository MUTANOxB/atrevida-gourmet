import { z } from "zod";

export const deliveryQuoteSchema = z.object({
  storeSlug: z.string().trim().min(1).max(80).regex(/^[a-z0-9-]+$/),
  neighborhood: z.string().trim().min(2).max(100),
  postalCode: z.string().trim().regex(/^\d{5}-?\d{3}$/).optional()
}).strict();
