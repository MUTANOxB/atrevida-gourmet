import type { FastifyReply, FastifyRequest } from "fastify";

export async function noStore(
  _request: FastifyRequest,
  reply: FastifyReply
) {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
}
