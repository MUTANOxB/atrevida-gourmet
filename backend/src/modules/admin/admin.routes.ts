import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  requireAdmin,
  requireAdminWriteOrigin,
  requireRoles
} from "../../middleware/admin-auth.js";
import { noStore } from "../../middleware/no-store.js";
import { HttpError } from "../../lib/errors.js";
import {
  createCategoryBody,
  createExceptionBody,
  createOptionGroupBody,
  createOptionValueBody,
  createProductBody,
  createZoneBody,
  emptyBody,
  listOrdersQuery,
  orderIdParams,
  replaceHoursBody,
  updateCategoryBody,
  updateExceptionBody,
  updateOptionGroupBody,
  updateOptionValueBody,
  updateOrderStatusBody,
  updateProductBody,
  updateStoreBody,
  updateZoneBody,
  uuidParams
} from "./admin.schemas.js";
import {
  createCategory,
  createException,
  createOptionGroup,
  createOptionValue,
  createProduct,
  createZone,
  deactivateCategory,
  deactivateOptionGroup,
  deactivateOptionValue,
  deactivateProduct,
  deactivateZone,
  deleteException,
  ensureStoreInitialData,
  getAdminOrder,
  getStoreSettings,
  listAdminOrders,
  listCategories,
  listExceptions,
  listHours,
  listOptionGroups,
  listOptionValues,
  listProducts,
  listZones,
  replaceHours,
  updateCategory,
  updateException,
  updateOptionGroup,
  updateOptionValue,
  updateOrderStatus,
  updateProduct,
  updateStoreSettings,
  updateZone
} from "./admin.service.js";

function actor(request: FastifyRequest) {
  return {
    storeId: request.admin!.storeId,
    userId: request.admin!.userId
  };
}

const managerWrite = {
  preHandler: [
    requireAdminWriteOrigin,
    requireRoles("owner", "manager")
  ]
};

const managerRead = {
  preHandler: [requireRoles("owner", "manager")]
};

const staffWrite = {
  preHandler: [requireAdminWriteOrigin]
};

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("onRequest", noStore);
  app.addHook("preHandler", requireAdmin);

  app.get("/api/admin/orders", async (request) => {
    const query = listOrdersQuery.parse(request.query);
    return listAdminOrders(request.admin!.storeId, query);
  });

  app.get("/api/admin/orders/:orderId", async (request) => {
    const { orderId } = orderIdParams.parse(request.params);
    const order = await getAdminOrder(request.admin!.storeId, orderId);
    if (!order) throw new HttpError(404, "Pedido não encontrado.");
    return order;
  });

  app.patch(
    "/api/admin/orders/:orderId/status",
    staffWrite,
    async (request) => {
      const { orderId } = orderIdParams.parse(request.params);
      const { status, reason } = updateOrderStatusBody.parse(request.body);
      return updateOrderStatus(actor(request), orderId, status, reason);
    }
  );

  app.get("/api/admin/categories", managerRead, async (request) =>
    listCategories(request.admin!.storeId));
  app.post("/api/admin/categories", managerWrite, async (request, reply) =>
    reply.code(201).send(await createCategory(actor(request), createCategoryBody.parse(request.body))));
  app.patch("/api/admin/categories/:id", managerWrite, async (request) =>
    updateCategory(actor(request), uuidParams.parse(request.params).id, updateCategoryBody.parse(request.body)));
  app.delete("/api/admin/categories/:id", managerWrite, async (request, reply) => {
    await deactivateCategory(actor(request), uuidParams.parse(request.params).id);
    return reply.code(204).send();
  });

  app.get("/api/admin/products", managerRead, async (request) =>
    listProducts(request.admin!.storeId));
  app.post("/api/admin/products", managerWrite, async (request, reply) =>
    reply.code(201).send(await createProduct(actor(request), createProductBody.parse(request.body))));
  app.patch("/api/admin/products/:id", managerWrite, async (request) =>
    updateProduct(actor(request), uuidParams.parse(request.params).id, updateProductBody.parse(request.body)));
  app.delete("/api/admin/products/:id", managerWrite, async (request, reply) => {
    await deactivateProduct(actor(request), uuidParams.parse(request.params).id);
    return reply.code(204).send();
  });

  app.get("/api/admin/option-groups", managerRead, async (request) =>
    listOptionGroups(request.admin!.storeId));
  app.post("/api/admin/option-groups", managerWrite, async (request, reply) =>
    reply.code(201).send(await createOptionGroup(actor(request), createOptionGroupBody.parse(request.body))));
  app.patch("/api/admin/option-groups/:id", managerWrite, async (request) =>
    updateOptionGroup(actor(request), uuidParams.parse(request.params).id, updateOptionGroupBody.parse(request.body)));
  app.delete("/api/admin/option-groups/:id", managerWrite, async (request, reply) => {
    await deactivateOptionGroup(actor(request), uuidParams.parse(request.params).id);
    return reply.code(204).send();
  });

  app.get("/api/admin/option-values", managerRead, async (request) =>
    listOptionValues(request.admin!.storeId));
  app.post("/api/admin/option-values", managerWrite, async (request, reply) =>
    reply.code(201).send(await createOptionValue(actor(request), createOptionValueBody.parse(request.body))));
  app.patch("/api/admin/option-values/:id", managerWrite, async (request) =>
    updateOptionValue(actor(request), uuidParams.parse(request.params).id, updateOptionValueBody.parse(request.body)));
  app.delete("/api/admin/option-values/:id", managerWrite, async (request, reply) => {
    await deactivateOptionValue(actor(request), uuidParams.parse(request.params).id);
    return reply.code(204).send();
  });

  app.get("/api/admin/delivery-zones", managerRead, async (request) =>
    listZones(request.admin!.storeId));
  app.post("/api/admin/delivery-zones", managerWrite, async (request, reply) =>
    reply.code(201).send(await createZone(actor(request), createZoneBody.parse(request.body))));
  app.patch("/api/admin/delivery-zones/:id", managerWrite, async (request) =>
    updateZone(actor(request), uuidParams.parse(request.params).id, updateZoneBody.parse(request.body)));
  app.delete("/api/admin/delivery-zones/:id", managerWrite, async (request, reply) => {
    await deactivateZone(actor(request), uuidParams.parse(request.params).id);
    return reply.code(204).send();
  });

  app.get("/api/admin/store", managerRead, async (request) =>
    getStoreSettings(request.admin!.storeId));
  app.post("/api/admin/store/initial-data", managerWrite, async (request) => {
    emptyBody.parse(request.body);
    return ensureStoreInitialData(actor(request));
  });
  app.patch("/api/admin/store", managerWrite, async (request) =>
    updateStoreSettings(actor(request), updateStoreBody.parse(request.body)));

  app.get("/api/admin/hours", managerRead, async (request) =>
    listHours(request.admin!.storeId));
  app.put("/api/admin/hours", managerWrite, async (request) => {
    const { hours } = replaceHoursBody.parse(request.body);
    return replaceHours(actor(request), hours);
  });

  app.get("/api/admin/hour-exceptions", managerRead, async (request) =>
    listExceptions(request.admin!.storeId));
  app.post("/api/admin/hour-exceptions", managerWrite, async (request, reply) =>
    reply.code(201).send(await createException(actor(request), createExceptionBody.parse(request.body))));
  app.patch("/api/admin/hour-exceptions/:id", managerWrite, async (request) =>
    updateException(actor(request), uuidParams.parse(request.params).id, updateExceptionBody.parse(request.body)));
  app.delete("/api/admin/hour-exceptions/:id", managerWrite, async (request, reply) => {
    await deleteException(actor(request), uuidParams.parse(request.params).id);
    return reply.code(204).send();
  });

}
