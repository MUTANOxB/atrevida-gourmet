import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "../lib/errors.js";

const MAX_JSON_BYTES = 64 * 1024;

export async function rejectOversizedJson(
  request: FastifyRequest,
  _reply: FastifyReply
) {
  const lengthHeader = request.headers["content-length"];

  if (!lengthHeader) return;

  const length = Number(lengthHeader);

  if (Number.isFinite(length) && length > MAX_JSON_BYTES) {
    throw new HttpError(413, "Payload muito grande.");
  }
}

export async function requireJson(
  request: FastifyRequest,
  _reply: FastifyReply
) {
  if (!["POST", "PUT", "PATCH"].includes(request.method)) return;

  const contentType = request.headers["content-type"] ?? "";

  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type deve ser application/json.");
  }
}
