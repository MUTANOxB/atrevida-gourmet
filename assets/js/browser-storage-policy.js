/**
 * Não guardar credenciais administrativas em:
 * - localStorage
 * - sessionStorage
 * - IndexedDB
 *
 * Login admin deve usar sessão server-side / cookie:
 * HttpOnly; Secure; SameSite=Strict
 *
 * Dados de carrinho NÃO são segredos e podem ficar localmente.
 */

const CART_KEY = "atrevida_cart_v3";
const TRACKING_KEY = "atrevida_tracking_v1";

export function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

export function loadCart() {
  try {
    const value = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function clearCart() {
  localStorage.removeItem(CART_KEY);
}

/**
 * Uma aba pode acompanhar mais de um pedido. O token é um segredo de acesso
 * limitado a um único pedido e, por isso, fica apenas nesta sessão/aba.
 */
export function loadTrackedOrders() {
  try {
    const value = JSON.parse(sessionStorage.getItem(TRACKING_KEY) || "[]");
    return Array.isArray(value) ? value.slice(0, 10) : [];
  } catch {
    return [];
  }
}

export function saveTrackedOrders(orders) {
  sessionStorage.setItem(TRACKING_KEY, JSON.stringify(orders.slice(0, 10)));
}
