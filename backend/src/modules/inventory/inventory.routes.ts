import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  requireAdmin,
  requireAdminWriteOrigin
} from "../../middleware/admin-auth.js";
import { noStore } from "../../middleware/no-store.js";
import {
  adjustInventoryBody,
  inventoryProductParams,
  updateInventoryBody
} from "./inventory.schemas.js";
import {
  adjustDailyInventory,
  listDailyInventory,
  updateDailyInventory
} from "./inventory.service.js";

function actor(request: FastifyRequest) {
  return {
    storeId: request.admin!.storeId,
    userId: request.admin!.userId
  };
}

export async function inventoryRoutes(app: FastifyInstance) {
  app.addHook("onRequest", noStore);
  app.addHook("preHandler", requireAdmin);

  app.get("/api/admin/inventory", async (request) =>
    listDailyInventory(request.admin!.storeId));

  app.patch(
    "/api/admin/inventory/:productId",
    { preHandler: [requireAdminWriteOrigin] },
    async (request) => {
      const { productId } = inventoryProductParams.parse(request.params);
      return updateDailyInventory(
        actor(request),
        productId,
        updateInventoryBody.parse(request.body)
      );
    }
  );

  app.post(
    "/api/admin/inventory/:productId/adjust",
    { preHandler: [requireAdminWriteOrigin] },
    async (request) => {
      const { productId } = inventoryProductParams.parse(request.params);
      return adjustDailyInventory(
        actor(request),
        productId,
        adjustInventoryBody.parse(request.body)
      );
    }
  );
}
