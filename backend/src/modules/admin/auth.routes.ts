import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ADMIN_ACCESS_COOKIE,
  ADMIN_REFRESH_COOKIE,
  assertTrustedOrigin,
  clearAdminSessionCookies,
  findAdminMembership,
  requireAdmin,
  setAdminSessionCookies
} from "../../middleware/admin-auth.js";
import { noStore } from "../../middleware/no-store.js";
import { HttpError } from "../../lib/errors.js";
import { createSupabaseAuthClient } from "../../lib/supabase.js";
import { env } from "../../config/env.js";

const loginBody = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(256),
  storeSlug: z.string().regex(/^[a-z0-9-]{1,80}$/).optional()
}).strict();

async function login(request: FastifyRequest, reply: FastifyReply) {
  assertTrustedOrigin(request);
  const input = loginBody.parse(request.body);
  const authClient = createSupabaseAuthClient();
  const { data, error } = await authClient.auth.signInWithPassword({
    email: input.email,
    password: input.password
  });

  if (error || !data.session || !data.user) {
    throw new HttpError(401, "E-mail ou senha inválidos.");
  }

  let membership;
  const storeSlug = input.storeSlug ?? env.DEFAULT_STORE_SLUG;
  try {
    membership = await findAdminMembership(
      data.user.id,
      storeSlug
    );
  } catch (error) {
    await authClient.auth.signOut().catch(() => undefined);
    if (error instanceof HttpError && error.statusCode === 403) {
      throw new HttpError(403, "Usuário sem acesso administrativo à loja.");
    }
    throw error;
  }

  setAdminSessionCookies(reply, data.session, storeSlug);
  return {
    user: { id: data.user.id, email: data.user.email ?? null },
    storeId: membership.storeId,
    role: membership.role,
    mfaRecommended: membership.role !== "staff"
  };
}

async function session(request: FastifyRequest) {
  return {
    authenticated: true,
    userId: request.admin!.userId,
    email: request.admin!.email,
    storeId: request.admin!.storeId,
    role: request.admin!.role,
    mfaRecommended: request.admin!.role !== "staff"
  };
}

async function logout(request: FastifyRequest, reply: FastifyReply) {
  assertTrustedOrigin(request);
  const accessToken =
    request.cookies[ADMIN_ACCESS_COOKIE] ??
    request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const refreshToken = request.cookies[ADMIN_REFRESH_COOKIE];

  if (accessToken && refreshToken) {
    const authClient = createSupabaseAuthClient();
    const { error } = await authClient.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken
    });
    if (!error) await authClient.auth.signOut({ scope: "local" }).catch(() => undefined);
  }

  clearAdminSessionCookies(reply);
  return reply.code(204).send();
}

export async function adminAuthRoutes(app: FastifyInstance) {
  const writeHooks = { preHandler: [noStore] };
  app.post("/api/admin/auth/login", writeHooks, login);
  app.post("/api/admin/session", writeHooks, login);

  app.get(
    "/api/admin/auth/session",
    { preHandler: [noStore, requireAdmin] },
    session
  );
  app.get(
    "/api/admin/session/me",
    { preHandler: [noStore, requireAdmin] },
    session
  );

  app.post("/api/admin/auth/logout", { preHandler: [noStore] }, logout);
  app.delete("/api/admin/session", { preHandler: [noStore] }, logout);
}
