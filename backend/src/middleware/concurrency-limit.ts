import type { FastifyInstance } from "fastify";

const MAX_CONCURRENT_PER_IP = 20;

/**
 * Limite simples de requisições concorrentes por IP.
 *
 * Protege contra um cliente manter muitas requisições simultâneas abertas.
 *
 * Para arquitetura multi-instância, a proteção principal de concorrência deve
 * existir também no proxy/CDN/WAF.
 */
export function registerConcurrencyLimit(app: FastifyInstance) {
  const active = new Map<string, number>();

  app.addHook("onRequest", async (request, reply) => {
    const ip = request.ip;
    const current = active.get(ip) ?? 0;

    if (current >= MAX_CONCURRENT_PER_IP) {
      return reply.code(429).send({
        error: "Muitas requisições simultâneas."
      });
    }

    active.set(ip, current + 1);

    let released = false;

    const release = () => {
      if (released) return;
      released = true;

      const value = (active.get(ip) ?? 1) - 1;

      if (value <= 0) {
        active.delete(ip);
      } else {
        active.set(ip, value);
      }
    };

    reply.raw.once("finish", release);
    reply.raw.once("close", release);
  });
}
