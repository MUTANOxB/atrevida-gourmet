/**
 * Produção:
 *
 * - trustProxy: true SOMENTE se a aplicação estiver atrás de proxy confiável
 *   (Vercel/Render/Fly/Cloudflare etc.).
 *
 * - bodyLimit: limite global baixo.
 *
 * - logger: usar safe-logger.ts.
 *
 * Exemplo:
 *
 * const app = Fastify({
 *   trustProxy: true,
 *   bodyLimit: 64 * 1024,
 *   logger: loggerOptions
 * });
 */
export {};
