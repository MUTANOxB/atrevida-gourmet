import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { HttpError } from "../lib/errors.js";

/**
 * Não devolver erro bruto do banco, stack trace,
 * path de arquivo ou SQL para o browser.
 */
export function registerSafeErrors(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Dados inválidos.",
        code: "INVALID_INPUT"
      });
    }

    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code ?? "REQUEST_FAILED"
      });
    }

    const candidate = error as {
      statusCode?: unknown;
      code?: unknown;
    };
    const statusCode = typeof candidate.statusCode === "number"
      ? candidate.statusCode
      : 500;

    if (statusCode >= 500) {
      request.log.error({
        err: error,
        requestId: request.id
      }, "Internal error");

      return reply.code(500).send({
        error: "Erro interno do servidor.",
        code: "INTERNAL_ERROR",
        requestId: request.id
      });
    }

    return reply.code(statusCode).send({
      error: statusCode === 413
        ? "Payload excede o tamanho máximo permitido."
        : statusCode === 415
          ? "Formato de conteúdo não suportado."
          : statusCode === 429
            ? "Muitas requisições. Tente novamente em instantes."
          : "Solicitação inválida.",
      code: typeof candidate.code === "string" ? candidate.code : "BAD_REQUEST"
    });
  });
}
