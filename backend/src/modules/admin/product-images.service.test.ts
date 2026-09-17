import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_SECRET_KEY = "test-secret-key-with-at-least-20-characters";
process.env.FRONTEND_ORIGIN = "http://localhost:3000";

const {
  assertManagedProductImage,
  MAX_PRODUCT_IMAGE_BYTES,
  processProductImage
} = await import("./product-images.service.js");

test("imagem valida e normalizada para WebP sem metadados", async () => {
  const source = await sharp({
    create: {
      width: 2_000,
      height: 1_000,
      channels: 3,
      background: { r: 190, g: 90, b: 120 }
    }
  }).jpeg().withMetadata().toBuffer();

  const image = await processProductImage(source, "image/jpeg");
  const metadata = await sharp(image.buffer).metadata();
  assert.equal(image.mimeType, "image/webp");
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 1_600);
  assert.equal(metadata.height, 800);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
});

test("upload rejeita tipo declarado fora da lista", async () => {
  await assert.rejects(
    processProductImage(Buffer.from("<svg></svg>"), "image/svg+xml"),
    /JPEG, PNG, WebP ou AVIF/
  );
});

test("upload inspeciona o conteudo mesmo com MIME permitido", async () => {
  await assert.rejects(
    processProductImage(Buffer.from("<html>nao e imagem</html>"), "image/png"),
    /não é uma imagem aceita/
  );
  await assert.rejects(
    processProductImage(Buffer.from("MZ executavel"), "image/jpeg"),
    /não é uma imagem aceita/
  );
  await assert.rejects(
    processProductImage(Buffer.from("<svg><script>alert(1)</script></svg>"), "image/jpeg"),
    /não é uma imagem aceita/
  );
});

test("upload rejeita arquivo acima de 5 MiB antes de decodificar", async () => {
  await assert.rejects(
    processProductImage(Buffer.alloc(MAX_PRODUCT_IMAGE_BYTES + 1), "image/png"),
    /no máximo 5 MiB/
  );
});

test("imagem de outra loja e rejeitada antes de acessar Storage", async () => {
  const storeId = "11111111-1111-4111-8111-111111111111";
  const otherStoreId = "22222222-2222-4222-8222-222222222222";
  const imageId = "33333333-3333-4333-8333-333333333333";
  const url = `https://test-project.supabase.co/storage/v1/object/public/product-images/${otherStoreId}/${imageId}.webp`;
  await assert.rejects(
    assertManagedProductImage(storeId, url),
    /Use uma imagem enviada pelo painel da loja/
  );
});
