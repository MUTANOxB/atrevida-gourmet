import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { corsOrigins, env } from "./config/env.js";
import { HttpError } from "./lib/errors.js";
import { supabaseAdmin } from "./lib/supabase.js";
import { registerConcurrencyLimit } from "./middleware/concurrency-limit.js";
import {
  rejectDeepJson,
  requireJson
} from "./middleware/payload-guards.js";
import { registerSafeErrors } from "./middleware/safe-errors.js";
import { adminRoutes } from "./modules/admin/admin.routes.js";
import { adminAuthRoutes } from "./modules/admin/auth.routes.js";
import { adminUploadRoutes } from "./modules/admin/uploads.routes.js";
import { catalogRoutes } from "./modules/catalog/catalog.routes.js";
import { inventoryRoutes } from "./modules/inventory/inventory.routes.js";
import { orderRoutes } from "./modules/orders/orders.routes.js";
import {
  createSupabaseOrderEventBus,
  type OrderEventBus
} from "./modules/realtime/order-events.js";
import { realtimeRoutes } from "./modules/realtime/realtime.routes.js";
import type { SseConnectionLimiter } from "./modules/realtime/sse.js";
import { storeRoutes } from "./modules/store/store.routes.js";
import { registerRouteLimits } from "./plugins/route-limits.js";
import { registerSecurity } from "./plugins/security.js";
import { createHardenedServer } from "./plugins/server-hardening.js";

export type BuildAppOptions = {
  serveStatic?: boolean;
  staticRoot?: string;
  orderEvents?: OrderEventBus;
  sseConnections?: SseConnectionLimiter;
  sseHeartbeatMs?: number;
  sseMaxDurationMs?: number;
};

function frontendStaticRoot() {
  return fileURLToPath(new URL("../../dist", import.meta.url));
}

export function staticAssetCacheControl(filePath: string) {
  return [".html", ".js", ".css"].includes(extname(filePath).toLowerCase())
    ? "no-cache"
    : "public, max-age=86400";
}

export async function buildApp(
  options: BuildAppOptions = {}
): Promise<FastifyInstance> {
  const app = createHardenedServer();
  const orderEvents = options.orderEvents ?? createSupabaseOrderEventBus();

  // O handler precisa existir antes dos plugins encapsulados para sanitizar
  // também falhas de validação disparadas dentro das rotas registradas.
  registerSafeErrors(app);

  // Este hook precisa preceder o onRoute do plugin de rate limit para que
  // os limites específicos sejam compilados junto com cada rota.
  await registerRouteLimits(app);
  await registerSecurity(app);
  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      files: 1,
      fields: 0,
      fileSize: 5 * 1024 * 1024
    },
    throwFileSizeLimit: true
  });
  await app.register(cors, {
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Idempotency-Key",
      "X-Requested-With",
      "X-Store-Slug",
      "Authorization"
    ],
    origin(origin, callback) {
      if (!origin || corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new HttpError(403, "Origem da requisição não permitida."), false);
    }
  });

  registerConcurrencyLimit(app);
  app.addHook("preValidation", requireJson);
  app.addHook("preValidation", rejectDeepJson);

  app.get("/health", async () => ({
    ok: true,
    service: "atrevida-backend",
    timestamp: new Date().toISOString()
  }));

  app.get("/ready", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const { error } = await supabaseAdmin
      .from("stores")
      .select("id", { count: "exact", head: true });
    if (error) return reply.code(503).send({ ok: false, service: "atrevida-backend" });
    return { ok: true, service: "atrevida-backend" };
  });

  await app.register(catalogRoutes);
  await app.register(storeRoutes);
  await app.register(orderRoutes);
  await app.register(adminAuthRoutes);
  await app.register(adminUploadRoutes);
  await app.register(adminRoutes);
  await app.register(inventoryRoutes);
  await app.register(realtimeRoutes, {
    events: orderEvents,
    connections: options.sseConnections,
    heartbeatMs: options.sseHeartbeatMs,
    maxDurationMs: options.sseMaxDurationMs
  });
  app.addHook("onClose", async () => {
    await orderEvents.close();
  });

  const shouldServeStatic = options.serveStatic ?? env.SERVE_STATIC;
  if (shouldServeStatic) {
    const root = options.staticRoot ?? frontendStaticRoot();
    if (!existsSync(root)) {
      throw new Error(`Frontend build não encontrado em ${root}.`);
    }

    await app.register(fastifyStatic, {
      root,
      prefix: "/",
      redirect: true,
      index: ["index.html"],
      cacheControl: false,
      setHeaders(response, filePath) {
        response.header("Cache-Control", staticAssetCacheControl(filePath));
      }
    });
  }

  return app;
}

export async function start() {
  const app = await buildApp();
  await app.listen({
    port: env.PORT,
    host: "0.0.0.0"
  });
  return app;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  start()
    .then((app) => {
      let closing = false;
      const shutdown = async (signal: string) => {
        if (closing) return;
        closing = true;
        app.log.info({ signal }, "Graceful shutdown started");
        const forceExit = setTimeout(() => process.exit(1), 10_000);
        forceExit.unref();
        try {
          await app.close();
          clearTimeout(forceExit);
          process.exit(0);
        } catch {
          process.exit(1);
        }
      };
      process.once("SIGTERM", () => void shutdown("SIGTERM"));
      process.once("SIGINT", () => void shutdown("SIGINT"));
    })
    .catch((error) => {
      process.stderr.write("Não foi possível iniciar o servidor.\n");
      if (env.NODE_ENV !== "production") {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      }
      process.exitCode = 1;
    });
}
