import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "../lib/errors.js";

export async function requireCheckoutHeaders(
  request: FastifyRequest,
  _reply: FastifyReply
) {
  const idem = request.headers["idempotency-key"];

  if (
    typeof idem !== "string" ||
    idem.length < 16 ||
    idem.length > 128
  ) {
    throw new HttpError(
      400,
      "Checkout sem Idempotency-Key válida."
    );
  }

  const contentType = request.headers["content-type"] ?? "";

  if (!contentType.startsWith("application/json")) {
    throw new HttpError(
      415,
      "Checkout aceita apenas JSON."
    );
  }
}
