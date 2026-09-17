import type { FastifyInstance } from "fastify";
import {
  requireAdmin,
  requireAdminWriteOrigin,
  requireRoles
} from "../../middleware/admin-auth.js";
import { noStore } from "../../middleware/no-store.js";
import { HttpError } from "../../lib/errors.js";
import {
  MAX_PRODUCT_IMAGE_BYTES,
  uploadProductImage
} from "./product-images.service.js";

export async function adminUploadRoutes(app: FastifyInstance) {
  app.addHook("onRequest", noStore);

  app.post(
    "/api/admin/uploads/product-images",
    {
      bodyLimit: MAX_PRODUCT_IMAGE_BYTES + 128 * 1024,
      config: { allowMultipart: true },
      preHandler: [
        requireAdmin,
        requireAdminWriteOrigin,
        requireRoles("owner", "manager")
      ]
    },
    async (request, reply) => {
      let part;
      try {
        part = await request.file({
          limits: { files: 1, fields: 0, fileSize: MAX_PRODUCT_IMAGE_BYTES }
        });
        if (!part) throw new HttpError(400, "Selecione uma imagem.");
        const buffer = await part.toBuffer();
        if (part.file.truncated) {
          throw new HttpError(413, "A imagem deve ter no máximo 5 MiB.");
        }
        const uploaded = await uploadProductImage({
          storeId: request.admin!.storeId,
          userId: request.admin!.userId,
          buffer,
          mimeType: part.mimetype
        });
        return reply.code(201).send(uploaded);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(413, "A imagem deve ter no máximo 5 MiB.");
      }
    }
  );
}
