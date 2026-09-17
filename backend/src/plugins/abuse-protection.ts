import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";

/**
 * Proteção de abuso em nível de aplicação.
 *
 * IMPORTANTE:
 * - em produção atrás de proxy/CDN, configure trustProxy corretamente;
 * - em múltiplas instâncias, troque o storage em memória por Redis/Valkey.
 */
export async function registerAbuseProtection(app: FastifyInstance) {
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    ban: 3,
    cache: 20_000,
    continueExceeding: false,
    skipOnError: false,
    keyGenerator(request) {
      return request.ip;
    },
    errorResponseBuilder(_request, context) {
      return {
        error: "Muitas requisições.",
        message: "Aguarde alguns instantes antes de tentar novamente.",
        retryAfterMs: context.ttl
      };
    }
  });

  // Rotas públicas.
  app.route({
    method: "GET",
    url: "/_security-example/catalog-limit",
    config: {
      rateLimit: {
        max: 60,
        timeWindow: "1 minute"
      }
    },
    handler: async () => ({ ok: true })
  });
}

/**
 * Configs para aplicar nas rotas reais:
 *
 * catálogo:
 *   config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
 *
 * delivery quote:
 *   config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
 *
 * POST /api/public/orders:
 *   config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
 *
 * tracking:
 *   config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
 *
 * admin:
 *   config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
 */
