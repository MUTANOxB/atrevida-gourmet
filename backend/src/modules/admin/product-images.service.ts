import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Metadata } from "sharp";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/errors.js";
import { supabaseAdmin } from "../../lib/supabase.js";

export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;
export const PRODUCT_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif"
]);

export type ProcessedProductImage = {
  buffer: Buffer;
  mimeType: "image/webp";
  extension: "webp";
  width: number;
  height: number;
};

function supportedDecodedFormat(metadata: Metadata) {
  if (["jpeg", "png", "webp"].includes(metadata.format ?? "")) return true;
  return metadata.format === "heif" && metadata.compression === "av1";
}

export async function processProductImage(
  input: Buffer,
  claimedMimeType: string
): Promise<ProcessedProductImage> {
  if (!PRODUCT_IMAGE_MIME_TYPES.has(claimedMimeType.toLowerCase())) {
    throw new HttpError(415, "Envie uma imagem JPEG, PNG, WebP ou AVIF.");
  }
  if (input.length === 0 || input.length > MAX_PRODUCT_IMAGE_BYTES) {
    throw new HttpError(413, "A imagem deve ter no máximo 5 MiB.");
  }

  try {
    const pipeline = sharp(input, {
      failOn: "error",
      limitInputPixels: 64_000_000
    });
    const metadata = await pipeline.metadata();
    if (
      !supportedDecodedFormat(metadata) ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 8_000 ||
      metadata.height > 8_000
    ) {
      throw new HttpError(415, "O conteúdo enviado não é uma imagem aceita.");
    }

    const result = await pipeline
      .rotate()
      .resize({
        width: 1_600,
        height: 1_600,
        fit: "inside",
        withoutEnlargement: true
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    if (!result.info.width || !result.info.height) {
      throw new HttpError(415, "Não foi possível processar a imagem.");
    }
    return {
      buffer: result.data,
      mimeType: "image/webp",
      extension: "webp",
      width: result.info.width,
      height: result.info.height
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(415, "O conteúdo enviado não é uma imagem aceita.");
  }
}

export async function uploadProductImage(input: {
  storeId: string;
  userId: string;
  buffer: Buffer;
  mimeType: string;
}) {
  const image = await processProductImage(input.buffer, input.mimeType);
  const objectPath = `${input.storeId}/${randomUUID()}.${image.extension}`;
  const bucket = supabaseAdmin.storage.from(env.PRODUCT_IMAGE_BUCKET);
  const { error: uploadError } = await bucket.upload(objectPath, image.buffer, {
    cacheControl: "31536000",
    contentType: image.mimeType,
    upsert: false
  });
  if (uploadError) {
    throw new HttpError(503, "Não foi possível armazenar a imagem.");
  }

  const { error: metadataError } = await supabaseAdmin.from("product_images").insert({
    store_id: input.storeId,
    object_path: objectPath,
    mime_type: image.mimeType,
    byte_size: image.buffer.length,
    width: image.width,
    height: image.height,
    created_by: input.userId
  });
  if (metadataError) {
    await bucket.remove([objectPath]);
    throw new HttpError(503, "Não foi possível concluir o upload da imagem.");
  }

  const { data } = bucket.getPublicUrl(objectPath);
  return {
    imageUrl: data.publicUrl,
    width: image.width,
    height: image.height,
    byteSize: image.buffer.length
  };
}

function managedPathFromUrl(storeId: string, imageUrl: string) {
  let candidate: URL;
  let publicBase: URL;
  try {
    candidate = new URL(imageUrl);
    publicBase = new URL(
      supabaseAdmin.storage.from(env.PRODUCT_IMAGE_BUCKET).getPublicUrl("").data.publicUrl
    );
  } catch {
    return null;
  }

  const prefix = publicBase.pathname.endsWith("/")
    ? publicBase.pathname
    : `${publicBase.pathname}/`;
  if (
    candidate.origin !== publicBase.origin ||
    candidate.search ||
    candidate.hash ||
    !candidate.pathname.startsWith(prefix)
  ) {
    return null;
  }

  let path: string;
  try {
    path = decodeURIComponent(candidate.pathname.slice(prefix.length));
  } catch {
    return null;
  }
  const escapedStoreId = storeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedStoreId}/[0-9a-f-]{36}\\.webp$`, "i").test(path)
    ? path
    : null;
}

export async function assertManagedProductImage(storeId: string, imageUrl: string) {
  const objectPath = managedPathFromUrl(storeId, imageUrl);
  if (!objectPath) {
    throw new HttpError(422, "Use uma imagem enviada pelo painel da loja.");
  }
  const { data, error } = await supabaseAdmin.from("product_images")
    .select("id, product_id")
    .eq("store_id", storeId)
    .eq("object_path", objectPath)
    .maybeSingle();
  if (error) throw new HttpError(503, "Não foi possível validar a imagem.");
  if (!data) throw new HttpError(422, "A imagem enviada não está disponível.");
  return data;
}

export async function claimManagedProductImage(
  storeId: string,
  imageUrl: string,
  productId: string
) {
  const image = await assertManagedProductImage(storeId, imageUrl);
  if (image.product_id === productId) return;
  if (image.product_id) {
    throw new HttpError(409, "Esta imagem já pertence a outro produto.");
  }
  const { data, error } = await supabaseAdmin.from("product_images")
    .update({ product_id: productId })
    .eq("id", image.id)
    .eq("store_id", storeId)
    .is("product_id", null)
    .select("id")
    .maybeSingle();
  if (error) throw new HttpError(503, "Não foi possível vincular a imagem ao produto.");
  if (!data) throw new HttpError(409, "Esta imagem já pertence a outro produto.");
}

export async function removeManagedProductImage(
  storeId: string,
  productId: string,
  imageUrl: string
) {
  const objectPath = managedPathFromUrl(storeId, imageUrl);
  if (!objectPath) return false;

  try {
    const { data, error } = await supabaseAdmin.from("product_images")
      .select("id")
      .eq("store_id", storeId)
      .eq("product_id", productId)
      .eq("object_path", objectPath)
      .maybeSingle();
    if (error || !data) return false;
    const { error: removeError } = await supabaseAdmin.storage
      .from(env.PRODUCT_IMAGE_BUCKET)
      .remove([objectPath]);
    if (removeError) return false;
    await supabaseAdmin.from("product_images")
      .delete()
      .eq("id", data.id)
      .eq("store_id", storeId)
      .eq("product_id", productId);
    return true;
  } catch {
    return false;
  }
}
