import Fastify from "fastify";
import { env } from "../config/env.js";
import { loggerOptions } from "../lib/safe-logger.js";

/**
 * Use estas opções na criação do Fastify.
 *
 * O bodyLimit evita payload gigante antes de chegar à validação.
 * Os timeouts evitam conexões lentas ficarem ocupando recursos indefinidamente.
 */
export function createHardenedServer() {
  const app = Fastify({
    logger: loggerOptions,

    trustProxy: env.TRUST_PROXY,

    bodyLimit: 64 * 1024,      // 64 KiB
    requestTimeout: 15_000,    // 15 s
    connectionTimeout: 10_000, // 10 s
    keepAliveTimeout: 5_000,   // 5 s
    routerOptions: {
      maxParamLength: 200
    }
  });

  // Limita quantas requests reutilizam o mesmo socket.
  app.server.maxRequestsPerSocket = 250;

  // Evita header ficar aberto por tempo excessivo.
  app.server.headersTimeout = 12_000;

  return app;
}
