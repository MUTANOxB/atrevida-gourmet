import "dotenv/config";
import { z } from "zod";

/**
 * Supabase recomenda as novas secret keys (sb_secret_...)
 * para serviços server-side.
 *
 * Esta variável JAMAIS chega no frontend.
 */
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  SUPABASE_URL: z.string().url(),

  SUPABASE_SECRET_KEY: z
    .string()
    .min(20),

  FRONTEND_ORIGIN: z
    .string()
    .url()
});

export const secureEnv = schema.parse(process.env);
