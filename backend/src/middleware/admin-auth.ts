import type { Session, User } from "@supabase/supabase-js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { corsOrigins, env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";
import { createSupabaseAuthClient, supabaseAdmin } from "../lib/supabase.js";

export const ADMIN_ACCESS_COOKIE = "atrevida_admin_access";
export const ADMIN_REFRESH_COOKIE = "atrevida_admin_refresh";
export const ADMIN_STORE_COOKIE = "atrevida_admin_store";

type AdminRole = "owner" | "manager" | "staff";

function cookieOptions(maxAge: number) {
  return {
    path: "/api/admin",
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict" as const,
    maxAge
  };
}

export function setAdminSessionCookies(
  reply: FastifyReply,
  session: Session,
  storeSlug?: string
) {
  reply.setCookie(
    ADMIN_ACCESS_COOKIE,
    session.access_token,
    cookieOptions(Math.max(60, session.expires_in ?? 3600))
  );
  reply.setCookie(
    ADMIN_REFRESH_COOKIE,
    session.refresh_token,
    cookieOptions(60 * 60 * 24 * 30)
  );
  if (storeSlug) {
    reply.setCookie(
      ADMIN_STORE_COOKIE,
      storeSlug,
      cookieOptions(60 * 60 * 24 * 30)
    );
  }
}

export function clearAdminSessionCookies(reply: FastifyReply) {
  const options = cookieOptions(0);
  reply.clearCookie(ADMIN_ACCESS_COOKIE, options);
  reply.clearCookie(ADMIN_REFRESH_COOKIE, options);
  reply.clearCookie(ADMIN_STORE_COOKIE, options);
}

function requestedStoreSlug(request: FastifyRequest) {
  const value = request.headers["x-store-slug"];
  const candidate = typeof value === "string"
    ? value
    : request.cookies[ADMIN_STORE_COOKIE] ?? env.DEFAULT_STORE_SLUG;
  if (!/^[a-z0-9-]{1,80}$/.test(candidate)) {
    throw new HttpError(400, "Loja inválida.");
  }
  return candidate;
}

export async function findAdminMembership(userId: string, storeSlug: string) {
  const { data, error } = await supabaseAdmin
    .from("store_members")
    .select("store_id, role, stores!inner(slug)")
    .eq("user_id", userId)
    .eq("stores.slug", storeSlug)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Não foi possível validar o acesso administrativo.");
  }

  if (!data || !["owner", "manager", "staff"].includes(data.role)) {
    throw new HttpError(403, "Usuário sem acesso administrativo à loja.");
  }

  return { storeId: data.store_id as string, role: data.role as AdminRole };
}

async function validateAccessToken(token: string): Promise<User | null> {
  const authClient = createSupabaseAuthClient();
  const { data, error } = await authClient.auth.getUser(token);
  return error ? null : data.user;
}

async function refreshCookieSession(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<User | null> {
  const refreshToken = request.cookies[ADMIN_REFRESH_COOKIE];
  if (!refreshToken) return null;

  const authClient = createSupabaseAuthClient();
  const { data, error } = await authClient.auth.refreshSession({
    refresh_token: refreshToken
  });

  if (error || !data.session || !data.user) {
    clearAdminSessionCookies(reply);
    return null;
  }

  setAdminSessionCookies(
    reply,
    data.session,
    request.cookies[ADMIN_STORE_COOKIE]
  );
  return data.user;
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
  const cookieToken = request.cookies[ADMIN_ACCESS_COOKIE];
  const token = bearer || cookieToken;

  let user = token ? await validateAccessToken(token) : null;
  if (!user && !bearer) {
    user = await refreshCookieSession(request, reply);
  }

  if (!user) {
    throw new HttpError(401, "Sessão inválida ou expirada.");
  }

  const membership = await findAdminMembership(
    user.id,
    requestedStoreSlug(request)
  );

  request.admin = {
    userId: user.id,
    email: user.email ?? null,
    storeId: membership.storeId,
    role: membership.role,
    authSource: bearer ? "bearer" : "cookie"
  };
}

export function requireRoles(...roles: AdminRole[]) {
  return async function roleGuard(request: FastifyRequest) {
    if (!request.admin || !roles.includes(request.admin.role)) {
      throw new HttpError(403, "Permissão insuficiente.");
    }
  };
}

export function assertTrustedOrigin(request: FastifyRequest) {
  const origin = request.headers.origin;

  if (!origin) {
    if (env.NODE_ENV === "production" && !request.headers.authorization) {
      throw new HttpError(403, "Origem da requisição não permitida.");
    }
    return;
  }

  if (!corsOrigins.includes(origin)) {
    throw new HttpError(403, "Origem da requisição não permitida.");
  }
}

/** Impede CSRF em mutações autenticadas por cookie. */
export async function requireAdminWriteOrigin(request: FastifyRequest) {
  if (request.admin?.authSource === "cookie") {
    assertTrustedOrigin(request);
  }
}
