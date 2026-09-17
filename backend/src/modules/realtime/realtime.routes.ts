import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "../../lib/errors.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { requireAdmin } from "../../middleware/admin-auth.js";
import { noStore } from "../../middleware/no-store.js";
import type { OrderEventBus, OrderRealtimeEvent } from "./order-events.js";
import { openSse, SseConnectionLimiter } from "./sse.js";

const trackingParams = z.object({ trackingToken: z.string().uuid() }).strict();

export type RealtimeRouteOptions = {
  events: OrderEventBus;
  connections?: SseConnectionLimiter;
  heartbeatMs?: number;
  maxDurationMs?: number;
};

function acquireConnection(
  request: FastifyRequest,
  connections: SseConnectionLimiter
) {
  const release = connections.acquire(request.ip);
  if (!release) {
    throw new HttpError(429, "Limite de conexões em tempo real excedido.", "SSE_CONNECTION_LIMIT");
  }
  return release;
}

async function trackingScope(trackingToken: string) {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("id, store_id, tracking_token, status")
    .eq("tracking_token", trackingToken)
    .maybeSingle();
  if (error) throw new HttpError(503, "Acompanhamento temporariamente indisponível.");
  if (!data) throw new HttpError(404, "Pedido não encontrado.");
  return {
    orderId: data.id as string,
    storeId: data.store_id as string,
    trackingToken: data.tracking_token as string,
    status: data.status as string
  };
}

function publicEvent(event: OrderRealtimeEvent) {
  return { type: event.type, status: event.status };
}

export async function realtimeRoutes(
  app: FastifyInstance,
  options: RealtimeRouteOptions
) {
  const connections = options.connections ?? new SseConnectionLimiter();

  app.get(
    "/api/admin/events",
    { preHandler: [noStore, requireAdmin] },
    async (request, reply) => {
      const release = acquireConnection(request, connections);
      try {
        await options.events.ensureStarted();
      } catch (error) {
        release();
        request.log.error({ err: error }, "Could not start admin realtime stream");
        throw new HttpError(503, "Atualização em tempo real indisponível.");
      }

      const stream = openSse(reply, {
        heartbeatMs: options.heartbeatMs,
        maxDurationMs: options.maxDurationMs,
        onClose: release
      });
      const stop = options.events.listen((event) => {
        if (event.storeId !== request.admin!.storeId) return;
        stream.send({
          type: event.type,
          orderId: event.orderId,
          status: event.status
        });
      });
      stream.addCleanup(stop);
      stream.send({ type: "connected" });
    }
  );

  app.get(
    "/api/public/orders/:trackingToken/events",
    { preHandler: [noStore] },
    async (request, reply) => {
      const { trackingToken } = trackingParams.parse(request.params);
      const scope = await trackingScope(trackingToken);
      const release = acquireConnection(request, connections);
      try {
        await options.events.ensureStarted();
      } catch (error) {
        release();
        request.log.error({ err: error }, "Could not start public realtime stream");
        throw new HttpError(503, "Atualização em tempo real indisponível.");
      }

      const stream = openSse(reply, {
        heartbeatMs: options.heartbeatMs,
        maxDurationMs: options.maxDurationMs,
        onClose: release
      });
      const stop = options.events.listen((event) => {
        if (
          event.storeId !== scope.storeId ||
          event.orderId !== scope.orderId ||
          event.trackingToken !== scope.trackingToken
        ) return;
        stream.send(publicEvent(event));
      });
      stream.addCleanup(stop);
      stream.send({ type: "connected", status: scope.status });
    }
  );
}
