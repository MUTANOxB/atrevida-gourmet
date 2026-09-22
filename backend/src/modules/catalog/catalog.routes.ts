import type { FastifyInstance } from "fastify";
import { storeSlugParams } from "./catalog.schemas.js";
import { getPublicCatalog } from "./catalog.service.js";

export async function catalogRoutes(app: FastifyInstance) {
  app.get("/api/public/stores/:storeSlug/catalog", async (request, reply) => {
    const { storeSlug } = storeSlugParams.parse(request.params);
    reply.header("Cache-Control", "no-store");
    return getPublicCatalog(storeSlug);
  });
}
