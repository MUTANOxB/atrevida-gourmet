import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3333),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(20).optional(),
  // Compatibilidade temporária com projetos Supabase que ainda usam a chave JWT legada.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  SUPABASE_ANON_KEY: z.string().min(20).optional(),
  FRONTEND_ORIGIN: z.string().default("http://127.0.0.1:5500"),
  DEFAULT_STORE_SLUG: z.string().regex(/^[a-z0-9-]+$/).default("atrevida-gourmet"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  SERVE_STATIC: z.enum(["true", "false"]).optional(),
  PRODUCT_IMAGE_BUCKET: z.string().min(1).max(63).default("product-images")
}).superRefine((value, context) => {
  if (!value.SUPABASE_SECRET_KEY && !value.SUPABASE_SERVICE_ROLE_KEY) {
    context.addIssue({
      code: "custom",
      path: ["SUPABASE_SECRET_KEY"],
      message: "SUPABASE_SECRET_KEY é obrigatória."
    });
  }
});

const parsed = schema.parse(process.env);

export const env = {
  ...parsed,
  SUPABASE_SECRET_KEY:
    parsed.SUPABASE_SECRET_KEY ?? parsed.SUPABASE_SERVICE_ROLE_KEY!,
  TRUST_PROXY: parsed.TRUST_PROXY === "true",
  SERVE_STATIC:
    parsed.SERVE_STATIC == null
      ? parsed.NODE_ENV === "production"
      : parsed.SERVE_STATIC === "true"
};

const configuredCorsOrigins = env.FRONTEND_ORIGIN
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (configuredCorsOrigins.length === 0 || configuredCorsOrigins.includes("*")) {
  throw new Error("FRONTEND_ORIGIN deve conter origens explícitas.");
}

for (const origin of configuredCorsOrigins) {
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.origin !== origin) {
    throw new Error(`Origem CORS inválida: ${origin}`);
  }

  if (
    env.NODE_ENV === "production" &&
    parsedOrigin.protocol !== "https:"
  ) {
    throw new Error("FRONTEND_ORIGIN deve usar HTTPS em produção.");
  }
}

export const corsOrigins = [...new Set([
  ...configuredCorsOrigins,
  ...(env.NODE_ENV === "production"
    ? []
    : [
        `http://127.0.0.1:${env.PORT}`,
        `http://localhost:${env.PORT}`
      ])
])];
