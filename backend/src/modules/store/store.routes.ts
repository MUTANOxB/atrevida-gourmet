import type { FastifyInstance } from "fastify";
import { noStore } from "../../middleware/no-store.js";
import { deliveryQuoteSchema } from "./store.schemas.js";
import { quoteDelivery } from "./store.service.js";

export async function storeRoutes(app: FastifyInstance) {
  app.post("/api/public/delivery/quote", { preHandler: [noStore] }, async (request) => {
    const input = deliveryQuoteSchema.parse(request.body);
    return quoteDelivery(input);
  });
}
