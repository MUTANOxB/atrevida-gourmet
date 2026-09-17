import type { FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

export async function registerSecurity(app: FastifyInstance) {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    );
  });

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
    xFrameOptions: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    ban: 3,
    cache: 20_000,
    allowList: [],
    continueExceeding: false,
    skipOnError: false,
    keyGenerator(request) {
      // Em produção, configure trustProxy corretamente no Fastify
      // para que request.ip represente o cliente real.
      return request.ip;
    },
    errorResponseBuilder(_request, context) {
      return {
        statusCode: context.statusCode,
        error: "Muitas requisições. Tente novamente em instantes.",
        code: "RATE_LIMITED",
        retryAfterMs: context.ttl
      };
    }
  });
}
