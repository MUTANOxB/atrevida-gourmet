import type { FastifyInstance } from "fastify";
import { requireCheckoutHeaders } from "../../middleware/checkout-headers.js";
import { noStore } from "../../middleware/no-store.js";
import { rejectOversizedOrder } from "../../middleware/payload-guards.js";
import { createOrderSchema, myOrdersQuery, trackOrderParams } from "./orders.schemas.js";
import { createOrder, trackOrder } from "./orders.service.js";
import {
  associateOrderWithPublicSession,
  listPublicSessionOrders,
  resolvePublicOrderSession,
  resolvePublicStoreId
} from "./public-order-session.service.js";

export async function orderRoutes(app: FastifyInstance) {
  app.post(
    "/api/public/orders",
    {
      bodyLimit: 32 * 1024,
      preHandler: [noStore, requireCheckoutHeaders, rejectOversizedOrder]
    },
    async (request, reply) => {
      const input = createOrderSchema.parse(request.body);
      const session = await resolvePublicOrderSession(request, reply);
      const result = await createOrder(
        input,
        request.headers["idempotency-key"] as string
      );
      try {
        await associateOrderWithPublicSession(
          session.id,
          result.orderId,
          result.storeId
        );
      } catch {
        request.log.error(
          { reason: "association_write_failed" },
          "Could not associate order with public session"
        );
      }
      if (result.replay) reply.header("Idempotency-Replayed", "true");
      return reply.code(result.statusCode).send(result.body);
    }
  );

  app.get("/api/public/orders/:trackingToken", { preHandler: [noStore] }, async (request) => {
    const { trackingToken } = trackOrderParams.parse(request.params);
    return trackOrder(trackingToken);
  });

  app.get(
    "/api/public/my-orders",
    { preHandler: [noStore] },
    async (request, reply) => {
      const { storeSlug } = myOrdersQuery.parse(request.query);
      const session = await resolvePublicOrderSession(request, reply);
      const storeId = await resolvePublicStoreId(storeSlug);
      return { orders: await listPublicSessionOrders(session.id, storeId) };
    }
  );
}
