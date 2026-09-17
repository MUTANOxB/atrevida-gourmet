import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "../lib/errors.js";

export const GLOBAL_BODY_LIMIT = 64 * 1024; // 64 KiB
export const ORDER_BODY_LIMIT = 32 * 1024;  // 32 KiB
export const MAX_JSON_DEPTH = 12;

export async function rejectOversizedOrder(
  request: FastifyRequest,
  _reply: FastifyReply
) {
  const raw = request.headers["content-length"];

  if (!raw) return;

  const size = Number(raw);

  if (Number.isFinite(size) && size > ORDER_BODY_LIMIT) {
    throw new HttpError(413, "Pedido excede o tamanho máximo permitido.");
  }
}

export async function requireJson(
  request: FastifyRequest,
  _reply: FastifyReply
) {
  if (!["POST", "PUT", "PATCH"].includes(request.method)) return;

  const contentType = request.headers["content-type"] ?? "";
  const allowMultipart = (request.routeOptions.config as {
    allowMultipart?: boolean;
  }).allowMultipart === true;

  if (allowMultipart && contentType.toLowerCase().startsWith("multipart/form-data")) {
    return;
  }

  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type deve ser application/json.");
  }
}

function depth(value: unknown, current = 0): number {
  if (value === null || typeof value !== "object") {
    return current;
  }

  if (current > MAX_JSON_DEPTH) {
    return current;
  }

  if (Array.isArray(value)) {
    return value.reduce(
      (max, item) => Math.max(max, depth(item, current + 1)),
      current
    );
  }

  return Object.values(value as Record<string, unknown>).reduce<number>(
    (max, item) => Math.max(max, depth(item, current + 1)),
    current
  );
}

export async function rejectDeepJson(
  request: FastifyRequest,
  _reply: FastifyReply
) {
  if (request.body == null) return;

  if (depth(request.body) > MAX_JSON_DEPTH) {
    throw new HttpError(400, "JSON excessivamente complexo.");
  }
}
