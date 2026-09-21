/**
 * Cliente HTTP único do navegador.
 *
 * Regra de arquitetura: o browser fala somente com /api. Credenciais
 * administrativas vivem em cookie HttpOnly; este módulo nunca persiste tokens.
 */
const API_BASE = "/api";
const DEFAULT_TIMEOUT_MS = 14_000;
const STORE_SLUG = document.documentElement.dataset.storeSlug || "atrevida-gourmet";

export class ApiError extends Error {
  constructor(message, { status = 0, code = "REQUEST_FAILED", retryAfter = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function publicErrorMessage(payload, fallback) {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.message === "string") return payload.message;
  if (typeof payload?.error?.message === "string") return payload.error.message;
  return fallback;
}

function apiUrl(path) {
  if (!path.startsWith("/")) throw new TypeError("O caminho da API deve começar com '/'.");
  return `${API_BASE}${path}`;
}

export async function apiFetch(path, options = {}) {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    body,
    headers,
    signal,
    ...fetchOptions
  } = options;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const isFormData = body instanceof FormData;
    const response = await fetch(apiUrl(path), {
      ...fetchOptions,
      body,
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(body && !isFormData ? { "Content-Type": "application/json" } : {}),
        ...(fetchOptions.method && fetchOptions.method !== "GET" ? { "X-Requested-With": "fetch" } : {}),
        ...(path.startsWith("/admin/") ? { "X-Store-Slug": STORE_SLUG } : {}),
        ...headers
      }
    });

    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : null;

    if (!response.ok) {
      const fallback = response.status === 401
        ? "Sua sessão expirou. Entre novamente."
        : response.status === 403
          ? "Você não tem permissão para esta ação."
          : response.status === 429
            ? "Muitas tentativas. Aguarde um pouco e tente novamente."
            : "Não foi possível concluir a solicitação.";
      throw new ApiError(publicErrorMessage(payload, fallback), {
        status: response.status,
        code: payload?.code || "REQUEST_FAILED",
        retryAfter: response.headers.get("retry-after")
      });
    }

    return response.status === 204 ? null : payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      throw new ApiError("A solicitação demorou demais. Verifique sua conexão e tente novamente.", {
        code: "TIMEOUT"
      });
    }
    throw new ApiError("Não foi possível conectar ao servidor. Verifique sua internet.", {
      code: "NETWORK_ERROR"
    });
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

function jsonRequest(path, method, input, options = {}) {
  return apiFetch(path, {
    ...options,
    method,
    body: input === undefined ? undefined : JSON.stringify(input)
  });
}

export const api = {
  getCatalog(storeSlug) {
    return apiFetch(`/public/stores/${encodeURIComponent(storeSlug)}/catalog`);
  },

  quoteDelivery(input) {
    return jsonRequest("/public/delivery/quote", "POST", input);
  },

  createOrder(input, idempotencyKey) {
    return jsonRequest("/public/orders", "POST", input, {
      headers: { "Idempotency-Key": idempotencyKey }
    });
  },

  trackOrder(trackingToken) {
    return apiFetch(`/public/orders/${encodeURIComponent(trackingToken)}`);
  },

  login(input) {
    return jsonRequest("/admin/auth/login", "POST", input);
  },

  logout() {
    return apiFetch("/admin/session", { method: "DELETE" });
  },

  getSession() {
    return apiFetch("/admin/auth/session");
  },

  listAdmin(resource) {
    return apiFetch(`/admin/${encodeURIComponent(resource)}`);
  },

  createAdmin(resource, input) {
    return jsonRequest(`/admin/${encodeURIComponent(resource)}`, "POST", input);
  },

  replaceAdmin(resource, input) {
    return jsonRequest(`/admin/${encodeURIComponent(resource)}`, "PUT", input);
  },

  updateAdmin(resource, id, input) {
    return jsonRequest(`/admin/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`, "PATCH", input);
  },

  removeAdmin(resource, id) {
    return apiFetch(`/admin/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  updateOrderStatus(orderId, status) {
    return jsonRequest(`/admin/orders/${encodeURIComponent(orderId)}/status`, "PATCH", { status });
  },

  getStoreSettings() {
    return apiFetch("/admin/store");
  },

  ensureInitialStoreData() {
    return jsonRequest("/admin/store/initial-data", "POST", {});
  },

  updateStoreSettings(input) {
    return jsonRequest("/admin/store", "PATCH", input);
  },

  uploadProductImage(file) {
    const body = new FormData();
    body.append("image", file, file.name);
    return apiFetch("/admin/uploads/product-images", {
      method: "POST",
      body,
      timeout: 30_000
    });
  }
};

export function openApiEventStream(path, handlers = {}) {
  if (!("EventSource" in window)) return null;
  const source = new EventSource(apiUrl(path), { withCredentials: true });
  source.addEventListener("open", () => handlers.open?.());
  source.addEventListener("message", (event) => {
    try {
      handlers.message?.(JSON.parse(event.data));
    } catch {
      // Frames inválidos são ignorados; o polling continua como contingência.
    }
  });
  source.addEventListener("error", () => {
    // EventSource reconecta automaticamente usando o retry informado pelo backend.
    handlers.error?.();
  });
  return source;
}
