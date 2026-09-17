import type { FastifyInstance } from "fastify";

export async function registerRouteLimits(app: FastifyInstance) {
  // Catálogo: leitura pública, limite relativamente alto.
  app.addHook("onRoute", (routeOptions) => {
    const url = routeOptions.url ?? "";

    if (url.includes("/api/public/stores/") && url.endsWith("/catalog")) {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 60,
          timeWindow: "1 minute"
        }
      };
    }

    // Criar pedido: limite bem menor para reduzir spam/abuso.
    if (routeOptions.method === "POST" && url === "/api/public/orders") {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 5,
          timeWindow: "1 minute"
        }
      };
    }

    // Quote de entrega pode ser abusado para enumeração/scraping.
    if (routeOptions.method === "POST" && url === "/api/public/delivery/quote") {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 20,
          timeWindow: "1 minute"
        }
      };
    }

    // Tracking: evita brute force de tokens (mesmo usando UUID).
    if (routeOptions.method === "GET" && url.includes("/api/public/orders/:trackingToken")) {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 20,
          timeWindow: "1 minute"
        }
      };
    }

    // Admin: limite conservador.
    if (url.startsWith("/api/admin/")) {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 60,
          timeWindow: "1 minute"
        }
      };
    }

    if (
      routeOptions.method === "POST" &&
      (url === "/api/admin/auth/login" || url === "/api/admin/session")
    ) {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: { max: 5, timeWindow: "1 minute" }
      };
    }
  });
}
