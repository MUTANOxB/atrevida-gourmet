import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { HttpError } from "../lib/errors.js";
import { supabaseAdmin } from "../lib/supabase.js";

/**
 * Uso recomendado:
 * 1) frontend gera UUID por tentativa de checkout;
 * 2) envia em `Idempotency-Key`;
 * 3) middleware bloqueia replay do mesmo payload.
 *
 * Este middleware é intencionalmente simples.
 * O Codex deve conectar o resultado final do pedido ao registro
 * para permitir retorno idempotente completo.
 */

export async function reserveIdempotencyKey(
  request: FastifyRequest,
  _reply: FastifyReply
) {
  const key = request.headers["idempotency-key"];

  if (typeof key !== "string" || key.length < 16 || key.length > 128) {
    throw new HttpError(400, "Idempotency-Key inválida.");
  }

  const bodyHash = createHash("sha256")
    .update(JSON.stringify(request.body ?? {}))
    .digest("hex");

  const { data: existing } = await supabaseAdmin
    .from("idempotency_keys")
    .select("request_hash, expires_at")
    .eq("key", key)
    .maybeSingle();

  if (existing) {
    if (existing.request_hash !== bodyHash) {
      throw new HttpError(409, "Idempotency-Key reutilizada com outro conteúdo.");
    }

    throw new HttpError(409, "Esta tentativa de checkout já foi recebida.");
  }

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const { error } = await supabaseAdmin
    .from("idempotency_keys")
    .insert({
      key,
      request_hash: bodyHash,
      expires_at: expiresAt
    });

  if (error) {
    throw new HttpError(409, "Não foi possível reservar a tentativa de checkout.");
  }
}
