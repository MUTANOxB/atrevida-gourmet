import { z } from "zod";

export const storeSlugParams = z.object({
  storeSlug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/)
}).strict();
