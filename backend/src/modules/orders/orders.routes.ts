import type { FastifyInstance } from "fastify";
import { requireCheckoutHeaders } from "../../middleware/checkout-headers.js";
import { noStore } from "../../middleware/no-store.js";
import { rejectOversizedOrder } from "../../middleware/payload-guards.js";
import { createOrderSchema, trackOrderParams } from "./orders.schemas.js";
import { createOrder, trackOrder } from "./orders.service.js";

export async function orderRoutes(app: FastifyInstance) {
  app.post(
    "/api/public/orders",
    {
      bodyLimit: 32 * 1024,
      preHandler: [noStore, requireCheckoutHeaders, rejectOversizedOrder]
    },
    async (request, reply) => {
      const input = createOrderSchema.parse(request.body);
      const result = await createOrder(
        input,
        request.headers["idempotency-key"] as string
      );
      if (result.replay) reply.header("Idempotency-Replayed", "true");
      return reply.code(result.statusCode).send(result.body);
    }
  );

  app.get("/api/public/orders/:trackingToken", { preHandler: [noStore] }, async (request) => {
    const { trackingToken } = trackOrderParams.parse(request.params);
    return trackOrder(trackingToken);
  });
}
