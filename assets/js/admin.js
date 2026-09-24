import { api, ApiError, openApiEventStream } from "./api-client.js";

const page = document.body.dataset.adminPage || "";
const STORE_SLUG = document.documentElement.dataset.storeSlug || "atrevida-gourmet";
const ORDER_FALLBACK_POLL_MS = 60_000;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  session: null,
  toastTimer: null,
  orders: [],
  orderIds: new Set(),
  newOrderIds: new Set(),
  orderPoll: null,
  orderStream: null,
  categories: [],
  products: [],
  inventory: [],
  inventorySummary: { available: 0, soldOut: 0, lowStock: 0 },
  inventoryFilter: "all",
  inventoryBusy: new Set(),
  optionGroups: [],
  optionValues: [],
  optionProduct: null,
  zones: [],
  deliveryStore: null,
  exceptions: []
};

const STATUS_LABELS = {
  pending: "Pedidos recebidos",
  confirmed: "Pedidos confirmados",
  preparing: "Em preparo (histórico)",
  ready: "Prontos para retirada",
  out_for_delivery: "Saiu para entrega",
  completed: "Pedidos concluídos",
  cancelled: "Pedidos cancelados"
};
const STATUS_FLOW = ["pending", "confirmed", "preparing", "ready", "out_for_delivery", "completed", "cancelled"];
const ACTIVE_STATUS_FLOW = ["pending", "confirmed", "preparing", "ready", "out_for_delivery", "completed"];
const FULFILLMENT_LABELS = { delivery: "Entrega", pickup: "Retirada", scheduled: "Encomenda" };
const PAYMENT_LABELS = { pix: "Pix", cash: "Dinheiro", card_on_delivery: "Cartão no recebimento" };
const PAYMENT_STATUS_LABELS = {
  pending: "Aguardando pagamento",
  pay_on_delivery: "Pagamento no recebimento",
  approved: "Pagamento confirmado",
  rejected: "Pagamento recusado",
  cancelled: "Pagamento cancelado",
  refunded: "Pagamento estornado"
};
const PAYMENT_METHODS = [
  { method: "pix", label: "Pix", instructions: "", active: true, sortOrder: 0 },
  { method: "cash", label: "Dinheiro", instructions: "", active: true, sortOrder: 1 },
  { method: "card_on_delivery", label: "Cartão no recebimento", instructions: "", active: true, sortOrder: 2 }
];
const ROLE_LABELS = { owner: "Proprietário", manager: "Gerente", staff: "Atendimento" };
const DAY_LABELS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
}

function money(cents) {
  const value = Number.isFinite(Number(cents)) ? Number(cents) : 0;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value / 100);
}

function dateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function dateOnly(value) {
  if (!value) return "—";
  const [year, month, day] = String(value).slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : String(value);
}

function asList(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (key && Array.isArray(payload?.[key])) return payload[key];
  return [];
}

function parseMoneyToCents(value, { allowBlank = false } = {}) {
  const raw = String(value ?? "").trim().replace(/[^\d,.-]/g, "");
  if (!raw && allowBlank) return null;
  if (!raw) return 0;
  const comma = raw.lastIndexOf(",");
  const dot = raw.lastIndexOf(".");
  let normalized = raw;
  if (comma > dot) normalized = raw.replaceAll(".", "").replace(",", ".");
  else if (dot > comma && dot >= 0) normalized = raw.replaceAll(",", "");
  else normalized = raw.replace(",", ".");
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Informe um valor monetário válido.");
  return Math.round(amount * 100);
}

function formatMoneyInput(cents) {
  if (cents === null || cents === undefined) return "";
  return (Number(cents) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function optionalInteger(value, { min, max, label }) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} deve ser um número inteiro entre ${min} e ${max}.`);
  }
  return parsed;
}

function slugify(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
}

function showDialog(id) {
  const dialog = typeof id === "string" ? document.getElementById(id) : id;
  if (dialog && !dialog.open) dialog.showModal();
}

function closeDialog(id) {
  const dialog = typeof id === "string" ? document.getElementById(id) : id;
  if (dialog?.open) dialog.close();
}

function setError(elementOrId, message = "") {
  const element = typeof elementOrId === "string" ? document.getElementById(elementOrId) : elementOrId;
  if (!element) return;
  element.textContent = message;
  element.hidden = !message;
}

function setBusy(button, busy, label = "Salvando…") {
  if (!button) return;
  if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  button.textContent = busy ? label : button.dataset.originalLabel;
}

function toast(message, kind = "success") {
  const element = $("#adminToast");
  if (!element) return;
  window.clearTimeout(state.toastTimer);
  element.textContent = message;
  element.dataset.kind = kind;
  element.hidden = false;
  state.toastTimer = window.setTimeout(() => { element.hidden = true; }, 4200);
}

function normalizeSession(payload) {
  const role = payload?.membership?.role || payload?.role || "";
  const storeId = payload?.membership?.storeId || payload?.storeId || "";
  const email = payload?.user?.email || payload?.email || "";
  const userId = payload?.user?.id || payload?.userId || "";
  return {
    authenticated: payload?.authenticated !== false && Boolean(role && (userId || email)),
    role,
    storeId,
    email,
    userId,
    mfaRecommended: Boolean(payload?.mfaRecommended)
  };
}

async function initLogin() {
  const form = $("#loginForm");
  const password = form.elements.password;
  const passwordToggle = $("#passwordToggle");
  passwordToggle.addEventListener("click", () => {
    const visible = password.type === "text";
    password.type = visible ? "password" : "text";
    const label = visible ? "Mostrar senha" : "Ocultar senha";
    passwordToggle.setAttribute("aria-label", label);
    passwordToggle.title = label;
  });
  try {
    const session = normalizeSession(await api.getSession());
    if (session.authenticated) {
      window.location.replace("/admin/pedidos/");
      return;
    }
  } catch {
    // A tela de login é o estado esperado sem uma sessão válida.
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("loginError");
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const button = $("#loginButton");
    setBusy(button, true, "Entrando…");
    try {
      await api.login({
        email: String(data.get("email") || "").trim(),
        password: String(data.get("password") || ""),
        storeSlug: STORE_SLUG
      });
      form.elements.password.value = "";
      window.location.replace("/admin/pedidos/");
    } catch (error) {
      setError("loginError", error.message);
    } finally {
      setBusy(button, false);
    }
  });
}

async function requireSession() {
  try {
    const session = normalizeSession(await api.getSession());
    if (!session.authenticated) throw new ApiError("Sessão inválida.", { status: 401 });
    state.session = session;
    if (session.role === "staff" && !["orders", "inventory"].includes(page)) {
      window.location.replace("/admin/pedidos/");
      return false;
    }
    $("#adminEmail").textContent = session.email || "Conta administrativa";
    $("#adminRole").textContent = ROLE_LABELS[session.role] || session.role;
    $$('[data-manager-only]').forEach((element) => { element.hidden = session.role === "staff"; });
    const notice = $("#mfaNotice");
    if (notice) notice.hidden = !session.mfaRecommended || session.role === "staff";
    $(`[data-nav="${CSS.escape(page)}"]`)?.classList.add("is-active");
    $("#adminLoading").hidden = true;
    $("#adminShell").hidden = false;
    return true;
  } catch (error) {
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      window.location.replace("/admin/login/");
      return false;
    }
    const loading = $("#adminLoading .admin-loading__mark");
    if (loading) {
      loading.innerHTML = `<span role="alert">${escapeHtml(error?.message || "Não foi possível verificar o acesso.")}</span><button class="btn btn--ghost" type="button" data-retry-session>Tentar novamente</button>`;
      $("[data-retry-session]", loading)?.addEventListener("click", () => window.location.reload());
    }
    return false;
  }
}

function wireShell() {
  const orderNav = $('[data-nav="orders"]');
  if (orderNav && !$('[data-nav="inventory"]')) {
    orderNav.insertAdjacentHTML(
      "afterend",
      '<a href="/admin/estoque/" data-nav="inventory"><span>📦</span>Estoque</a>'
    );
  }
  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("input, textarea, select, [contenteditable], [data-copyable], .order-card__number, .order-card__customer, .order-card__total, .detail, .item-list, .data-card__main")) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
  });
  $("#logoutButton")?.addEventListener("click", async () => {
    const button = $("#logoutButton");
    button.disabled = true;
    try { await api.logout(); } catch { /* Logout local segue para a tela de entrada. */ }
    window.location.replace("/admin/login/");
  });
  document.addEventListener("click", (event) => {
    const close = event.target.closest("[data-close-dialog]");
    if (close) closeDialog(close.dataset.closeDialog);
  });
}

function normalizeOrder(order) {
  const delivery = order.delivery || {};
  const customer = order.customer || {};
  return {
    id: String(order.id || ""),
    orderNumber: String(order.orderNumber || order.order_number || "Pedido"),
    status: order.status || "pending",
    fulfillmentType: order.fulfillmentType || order.fulfillment_type || "",
    customerName: order.customerName || order.customer_name || customer.name || "Cliente",
    customerPhone: order.customerPhone || order.customer_phone || customer.phone || "",
    paymentMethod: order.paymentMethod || order.payment_method || "",
    paymentProvider: order.paymentProvider || order.payment_provider || "offline",
    paymentStatus: order.paymentStatus || order.payment_status || "pay_on_delivery",
    changeForCents: order.changeForCents ?? order.change_for_cents ?? null,
    subtotalCents: Number(order.subtotalCents ?? order.subtotal_cents ?? 0),
    deliveryFeeCents: Number(order.deliveryFeeCents ?? order.delivery_fee_cents ?? 0),
    totalCents: Number(order.totalCents ?? order.total_cents ?? 0),
    note: String(order.note || ""),
    createdAt: order.createdAt || order.created_at,
    scheduledFor: order.scheduledFor || order.scheduled_for,
    delivery: {
      postalCode: delivery.postalCode || order.deliveryPostalCode || order.delivery_postal_code || "",
      street: delivery.street || order.deliveryStreet || order.delivery_street || "",
      number: delivery.number || order.deliveryNumber || order.delivery_number || "",
      neighborhood: delivery.neighborhood || order.deliveryNeighborhood || order.delivery_neighborhood || "",
      complement: delivery.complement || order.deliveryComplement || order.delivery_complement || "",
      reference: delivery.reference || order.deliveryReference || order.delivery_reference || ""
    },
    items: (order.items || order.order_items || []).map((item) => ({
      id: item.id,
      name: item.name || item.productNameSnapshot || item.product_name_snapshot || "Item",
      unitPriceCents: Number(item.unitPriceCents ?? item.unit_price_cents ?? 0),
      quantity: Number(item.quantity || 0),
      lineTotalCents: Number(item.lineTotalCents ?? item.line_total_cents ?? 0),
      note: String(item.note || ""),
      options: item.options || item.optionsSnapshot || item.options_snapshot || []
    }))
  };
}

function filteredOrders() {
  const term = normalizeText($("#orderSearch")?.value || "");
  const activeOnly = $("#orderWindow")?.value !== "all";
  return state.orders.filter((order) => {
    if (activeOnly && !ACTIVE_STATUS_FLOW.includes(order.status)) return false;
    return !term || normalizeText(`${order.orderNumber} ${order.customerName} ${order.customerPhone}`).includes(term);
  });
}

function visibleStatusFlow() {
  return $("#orderWindow")?.value === "all" ? STATUS_FLOW : ACTIVE_STATUS_FLOW;
}

function primaryOrderAction(order) {
  const fulfillment = order.fulfillmentType;
  if (order.status === "pending") {
    if (order.paymentProvider === "direct_pix" && order.paymentStatus === "pending") return null;
    return { status: "confirmed", label: fulfillment === "scheduled" ? "Aceitar encomenda" : "Aceitar pedido" };
  }
  if (["confirmed", "preparing"].includes(order.status)) {
    return fulfillment === "delivery"
      ? { status: "out_for_delivery", label: "Saiu para entrega" }
      : { status: "ready", label: fulfillment === "scheduled" ? "Marcar como pronto" : "Pronto para retirada" };
  }
  if (order.status === "ready") {
    return fulfillment === "delivery"
      ? { status: "out_for_delivery", label: "Saiu para entrega" }
      : { status: "completed", label: fulfillment === "pickup" ? "Concluir retirada" : "Concluir pedido" };
  }
  if (order.status === "out_for_delivery") return { status: "completed", label: "Concluir pedido" };
  return null;
}

function renderOrderCard(order) {
  const primaryAction = primaryOrderAction(order);
  const scheduled = order.scheduledFor ? `<span class="tag">📅 ${escapeHtml(dateTime(order.scheduledFor))}</span>` : "";
  const terminal = ["completed", "cancelled"].includes(order.status);
  const showNotes = !terminal;
  const canCancel = !terminal;
  const generalNote = showNotes && order.note.trim()
    ? `<div class="order-card__note"><strong>⚠ Observação</strong><p>${escapeHtml(order.note.trim())}</p></div>`
    : "";
  const itemNotes = showNotes
    ? order.items.filter((item) => item.note.trim()).map((item) =>
        `<li><strong>${escapeHtml(item.name)}:</strong> ${escapeHtml(item.note.trim())}</li>`
      ).join("")
    : "";
  const itemNotesBlock = itemNotes
    ? `<div class="order-card__note order-card__note--items"><strong>Observações dos itens</strong><ul>${itemNotes}</ul></div>`
    : "";
  const actions = [
    order.paymentProvider === "direct_pix" && order.paymentStatus === "pending"
      ? `<button class="btn btn--primary" type="button" data-confirm-pix="${escapeHtml(order.id)}">Confirmar Pix recebido</button>`
      : "",
    primaryAction ? `<button class="btn btn--primary" type="button" data-order-status="${primaryAction.status}" data-order-id="${escapeHtml(order.id)}">${escapeHtml(primaryAction.label)}</button>` : "",
    canCancel ? `<button class="btn btn--danger" type="button" data-order-status="cancelled" data-order-id="${escapeHtml(order.id)}">Cancelar pedido</button>` : ""
  ].filter(Boolean).join("");
  return `<article class="order-card ${state.newOrderIds.has(order.id) ? "is-new" : ""}"><div class="order-card__top"><button class="order-card__number" type="button" data-order-details="${escapeHtml(order.id)}" aria-label="Ver detalhes do pedido ${escapeHtml(order.orderNumber)}">Pedido #${escapeHtml(order.orderNumber)}</button><time>${escapeHtml(dateTime(order.createdAt))}</time></div><div class="order-card__customer"><strong>${escapeHtml(order.customerName)}</strong><span>${escapeHtml(order.customerPhone)}</span></div><div class="order-card__meta"><span class="tag">${escapeHtml(FULFILLMENT_LABELS[order.fulfillmentType] || order.fulfillmentType)}</span><span class="tag">${order.items.reduce((sum, item) => sum + item.quantity, 0)} itens</span>${scheduled}</div>${generalNote}${itemNotesBlock}<div class="order-card__payment"><strong>${escapeHtml(PAYMENT_LABELS[order.paymentMethod] || order.paymentMethod)}</strong><span>${escapeHtml(PAYMENT_STATUS_LABELS[order.paymentStatus] || order.paymentStatus)}</span></div><div class="order-card__total"><span>Total</span><strong>${money(order.totalCents)}</strong></div>${actions ? `<div class="order-card__actions">${actions}</div>` : ""}</article>`;
}

function renderOrders() {
  const orders = filteredOrders();
  $("#ordersKanban").innerHTML = visibleStatusFlow().map((status) => {
    const list = orders.filter((order) => order.status === status);
    return `<section class="kanban-column" data-status="${status}"><div class="kanban-column__head"><strong>${STATUS_LABELS[status]}</strong><span class="kanban-count">${list.length}</span></div><div class="kanban-list">${list.length ? list.map(renderOrderCard).join("") : `<div class="kanban-empty">Nenhum pedido</div>`}</div></section>`;
  }).join("");
  renderNewOrdersBadge();
}

function scrollKanbanToStatus(status) {
  const wrap = $(".kanban-wrap");
  if (!wrap) return;
  const column = $(`.kanban-column[data-status="${CSS.escape(status)}"]`, wrap);
  if (!column) return;
  wrap.scrollTo({ left: column.offsetLeft, behavior: "smooth" });
}

function renderNewOrdersBadge() {
  const badge = $("#newOrdersBadge");
  if (!badge) return;
  const count = state.newOrderIds.size;
  badge.hidden = count === 0;
  badge.textContent = `${count} novo${count === 1 ? "" : "s"}`;
  document.title = count ? `(${count}) Pedidos | Atrevida Gourmet` : "Pedidos | Atrevida Gourmet";
}

function playNewOrderSound() {
  if (sessionStorage.getItem("atrevida_admin_sound") !== "on") return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 740;
    gain.gain.setValueAtTime(.12, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .28);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + .28);
  } catch {
    // O navegador pode bloquear áudio; o badge visual continua funcionando.
  }
}

async function loadOrders({ initial = false, quiet = false } = {}) {
  const button = $("#refreshOrders");
  const kanban = $("#ordersKanban");
  if (!quiet) setBusy(button, true, "Atualizando…");
  if (!quiet) kanban?.setAttribute("aria-busy", "true");
  try {
    const orders = asList(await api.listAdmin("orders"), "orders").map(normalizeOrder);
    if (!initial) {
      const incoming = orders.filter((order) => order.status === "pending" && !state.orderIds.has(order.id));
      incoming.forEach((order) => state.newOrderIds.add(order.id));
      if (incoming.length) {
        toast(`${incoming.length} novo${incoming.length > 1 ? "s" : ""} pedido${incoming.length > 1 ? "s" : ""}.`);
        playNewOrderSound();
      }
    }
    state.orders = orders;
    state.orderIds = new Set(orders.map((order) => order.id));
    renderOrders();
  } catch (error) {
    if (!quiet) toast(error.message, "error");
    if (initial && kanban) {
      kanban.innerHTML = `<div class="empty-panel" role="alert"><strong>Não foi possível carregar os pedidos.</strong><span>${escapeHtml(error.message)}</span><button class="btn btn--ghost" type="button" data-retry-orders>Tentar novamente</button></div>`;
    }
  } finally {
    if (!quiet) setBusy(button, false);
    if (!quiet) kanban?.setAttribute("aria-busy", "false");
  }
}

async function updateOrderStatus(orderId, status, button) {
  if (status === "cancelled" && !window.confirm("Cancelar este pedido? Essa ação ficará registrada.")) return;
  setBusy(button, true, "Salvando…");
  try {
    await api.updateOrderStatus(orderId, status);
    const showHistory = status === "cancelled";
    if (showHistory) $("#orderWindow").value = "all";
    state.newOrderIds.delete(orderId);
    document.title = "Pedidos | Atrevida Gourmet";
    toast(`Pedido marcado como ${STATUS_LABELS[status].toLocaleLowerCase("pt-BR")}.`);
    await loadOrders({ quiet: true });
    if (["completed", "cancelled"].includes(status)) scrollKanbanToStatus(status);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function confirmPix(orderId, button) {
  setBusy(button, true, "Confirmando…");
  try {
    await api.confirmPix(orderId);
    toast("Pix confirmado.");
    await loadOrders({ quiet: true });
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function optionNames(options) {
  if (!Array.isArray(options)) return "";
  return options.map((option) => option.valueName || option.value_name || option.name || "").filter(Boolean).join(" · ");
}

function openOrderDetails(orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return;
  state.newOrderIds.delete(orderId);
  const address = [order.delivery.street, order.delivery.number, order.delivery.neighborhood, order.delivery.complement].filter(Boolean).join(", ");
  $("#orderDialogTitle").textContent = `Pedido #${order.orderNumber}`;
  $("#orderDetails").innerHTML = `<section class="dialog-section"><div class="detail-grid"><div class="detail"><small>Status do pedido</small><strong>${escapeHtml(STATUS_LABELS[order.status] || order.status)}</strong></div><div class="detail"><small>Recebimento</small><strong>${escapeHtml(FULFILLMENT_LABELS[order.fulfillmentType] || order.fulfillmentType)}</strong></div><div class="detail"><small>Cliente</small><strong>${escapeHtml(order.customerName)}</strong></div><div class="detail"><small>Telefone</small><span>${escapeHtml(order.customerPhone)}</span></div>${order.scheduledFor ? `<div class="detail"><small>Agendado para</small><strong>${escapeHtml(dateTime(order.scheduledFor))}</strong></div>` : ""}<div class="detail"><small>Forma de pagamento</small><strong>${escapeHtml(PAYMENT_LABELS[order.paymentMethod] || order.paymentMethod)}</strong></div><div class="detail"><small>Status do pagamento</small><strong>${escapeHtml(PAYMENT_STATUS_LABELS[order.paymentStatus] || order.paymentStatus)}</strong></div></div></section>${address ? `<section class="dialog-section"><h3>Entrega</h3><div class="detail"><span>${escapeHtml(address)}</span>${order.delivery.postalCode ? `<small>CEP ${escapeHtml(order.delivery.postalCode)}</small>` : ""}${order.delivery.reference ? `<small>Referência: ${escapeHtml(order.delivery.reference)}</small>` : ""}</div></section>` : ""}<section class="dialog-section"><h3>Itens</h3><ul class="item-list">${order.items.map((item) => `<li><span><strong>${item.quantity}× ${escapeHtml(item.name)}</strong>${optionNames(item.options) ? `<br><small>${escapeHtml(optionNames(item.options))}</small>` : ""}${item.note ? `<br><small>Obs.: ${escapeHtml(item.note)}</small>` : ""}</span><strong>${money(item.lineTotalCents)}</strong></li>`).join("")}</ul></section>${order.note ? `<section class="dialog-section"><h3>Observação</h3><div class="detail"><span>${escapeHtml(order.note)}</span></div></section>` : ""}<section class="dialog-section"><div class="detail-grid"><div class="detail"><small>Subtotal</small><strong>${money(order.subtotalCents)}</strong></div><div class="detail"><small>Entrega</small><strong>${money(order.deliveryFeeCents)}</strong></div><div class="detail"><small>Total</small><strong>${money(order.totalCents)}</strong></div>${order.changeForCents !== null ? `<div class="detail"><small>Troco para</small><strong>${money(order.changeForCents)}</strong></div>` : ""}</div></section>`;
  showDialog("orderDialog");
  renderOrders();
}

async function initOrders() {
  const soundButton = $("#soundToggle");
  const renderSound = () => {
    const enabled = sessionStorage.getItem("atrevida_admin_sound") === "on";
    soundButton.textContent = enabled ? "🔔 Som ligado" : "🔕 Som desligado";
    soundButton.setAttribute("aria-pressed", String(enabled));
  };
  renderSound();
  soundButton.addEventListener("click", () => {
    sessionStorage.setItem("atrevida_admin_sound", sessionStorage.getItem("atrevida_admin_sound") === "on" ? "off" : "on");
    renderSound();
    if (sessionStorage.getItem("atrevida_admin_sound") === "on") playNewOrderSound();
  });
  $("#refreshOrders").addEventListener("click", () => loadOrders());
  $("#orderSearch").addEventListener("input", renderOrders);
  $("#orderWindow").addEventListener("change", renderOrders);
  $("#ordersKanban").addEventListener("click", (event) => {
    const retry = event.target.closest("[data-retry-orders]");
    const statusButton = event.target.closest("[data-order-status]");
    const pixButton = event.target.closest("[data-confirm-pix]");
    const details = event.target.closest("[data-order-details]");
    if (retry) loadOrders({ initial: true });
    else if (pixButton) confirmPix(pixButton.dataset.confirmPix, pixButton);
    else if (statusButton) updateOrderStatus(statusButton.dataset.orderId, statusButton.dataset.orderStatus, statusButton);
    else if (details) openOrderDetails(details.dataset.orderDetails);
  });
  await loadOrders({ initial: true });
  state.orderPoll = window.setInterval(() => {
    if (!document.hidden) loadOrders({ quiet: true });
  }, ORDER_FALLBACK_POLL_MS);
  state.orderStream = openApiEventStream("/admin/events", {
    message: () => loadOrders({ quiet: true }),
    error: () => {
      // O navegador reconecta a stream; o polling acima cobre a indisponibilidade.
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadOrders({ quiet: true }); });
  window.addEventListener("beforeunload", () => state.orderStream?.close(), { once: true });
}

function normalizeCategory(item) {
  return { id: String(item.id || ""), name: String(item.name || "Categoria"), slug: String(item.slug || ""), sortOrder: Number(item.sortOrder ?? item.sort_order ?? 0), active: item.active !== false };
}

function normalizeProduct(item) {
  return {
    id: String(item.id || ""), categoryId: String(item.categoryId || item.category_id || ""),
    name: String(item.name || "Produto"), description: String(item.description || ""),
    priceCents: Number.isInteger(item.priceCents) ? item.priceCents : (Number.isInteger(item.price_cents) ? item.price_cents : null),
    imageUrl: item.imageUrl || item.image_url || null, active: item.active !== false, featured: Boolean(item.featured), sortOrder: Number(item.sortOrder ?? item.sort_order ?? 0)
  };
}

function normalizeOptionGroup(item) {
  return { id: String(item.id || ""), productId: String(item.productId || item.product_id || ""), name: String(item.name || "Grupo"), required: Boolean(item.required), minSelect: Number(item.minSelect ?? item.min_select ?? 0), maxSelect: Number(item.maxSelect ?? item.max_select ?? 1), active: item.active !== false, sortOrder: Number(item.sortOrder ?? item.sort_order ?? 0), values: Array.isArray(item.values) ? item.values.map(normalizeOptionValue) : [] };
}

function normalizeOptionValue(item) {
  return { id: String(item.id || ""), groupId: String(item.groupId || item.group_id || ""), name: String(item.name || "Opção"), priceDeltaCents: Number(item.priceDeltaCents ?? item.price_delta_cents ?? 0), active: item.active !== false, sortOrder: Number(item.sortOrder ?? item.sort_order ?? 0) };
}

async function loadProductData() {
  try {
    let [categoryPayload, productPayload] = await Promise.all([api.listAdmin("categories"), api.listAdmin("products")]);
    let categories = asList(categoryPayload, "categories").map(normalizeCategory).sort((a, b) => a.sortOrder - b.sortOrder);
    if (!categories.length) {
      await api.ensureInitialStoreData();
      categoryPayload = await api.listAdmin("categories");
      categories = asList(categoryPayload, "categories").map(normalizeCategory).sort((a, b) => a.sortOrder - b.sortOrder);
    }
    state.categories = categories;
    state.products = asList(productPayload, "products").map(normalizeProduct).sort((a, b) => a.sortOrder - b.sortOrder);
    populateCategorySelects();
    renderProductsAdmin();
  } catch (error) {
    $("#productList").innerHTML = `<div class="empty-panel"><strong>Não foi possível carregar.</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
}

function populateCategorySelects() {
  const options = state.categories.map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`).join("");
  $("#productCategoryFilter").innerHTML = `<option value="">Todas</option>${options}`;
  $("#productAdminForm").elements.categoryId.innerHTML = `<option value="">Selecione</option>${options}`;
  const hasCategories = state.categories.length > 0;
  $("#newProduct").disabled = !hasCategories;
  $("#newProduct").title = hasCategories ? "" : "Crie uma categoria antes de cadastrar um produto.";
  $("#productCategoryFilter").disabled = !hasCategories;
}

function renderProductsAdmin() {
  if (!state.categories.length) {
    $("#productCount").textContent = "0 produtos";
    $("#productList").innerHTML = `<div class="empty-panel"><strong>Crie uma categoria antes de cadastrar seu primeiro produto.</strong><a class="btn btn--primary empty-panel__action" href="/admin/categorias/">Criar categoria</a></div>`;
    return;
  }
  const term = normalizeText($("#productSearch").value);
  const categoryId = $("#productCategoryFilter").value;
  const list = state.products.filter((product) => (!categoryId || product.categoryId === categoryId) && (!term || normalizeText(`${product.name} ${product.description}`).includes(term)));
  $("#productCount").textContent = `${list.length} ${list.length === 1 ? "produto" : "produtos"}`;
  $("#productList").innerHTML = list.length ? list.map((product) => {
    const category = state.categories.find((item) => item.id === product.categoryId);
    return `<article class="data-card"><div class="data-card__main"><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(category?.name || "Sem categoria")} · ordem ${product.sortOrder}</span><small>${escapeHtml(product.description || "Sem descrição")}</small></div><div class="data-card__meta"><span class="price">${product.priceCents === null ? "Sem preço" : money(product.priceCents)}</span><span class="status-pill ${product.active ? "" : "is-off"}">${product.active ? "Ativo" : "Inativo"}</span>${product.featured ? `<span class="status-pill">Destaque</span>` : ""}</div><div class="data-card__actions"><button class="btn btn--ghost" type="button" data-options-product="${escapeHtml(product.id)}">Opções</button><button class="btn btn--ghost" type="button" data-edit-product="${escapeHtml(product.id)}">Editar</button><button class="btn btn--ghost" type="button" data-delete-product="${escapeHtml(product.id)}">Excluir</button></div></article>`;
  }).join("") : `<div class="empty-panel"><strong>Nenhum produto encontrado.</strong><span>Cadastre um produto ou ajuste os filtros.</span></div>`;
}

function openProductForm(product = null) {
  if (!state.categories.length) {
    toast("Crie uma categoria antes de cadastrar seu primeiro produto.", "error");
    return;
  }
  const form = $("#productAdminForm");
  form.reset();
  form.elements.id.value = product?.id || "";
  form.elements.categoryId.value = product?.categoryId || "";
  form.elements.name.value = product?.name || "";
  form.elements.description.value = product?.description || "";
  form.elements.price.value = formatMoneyInput(product?.priceCents);
  form.elements.sortOrder.value = product?.sortOrder ?? 0;
  form.elements.imageUrl.value = product?.imageUrl || "";
  form.elements.removeImage.checked = false;
  $("#removeProductImageField").hidden = !product?.imageUrl;
  $("#currentProductImage").textContent = product?.imageUrl
    ? "Há uma imagem publicada. Escolha outro arquivo para substituí-la."
    : "JPEG, PNG, WebP ou AVIF, até 5 MiB.";
  form.elements.active.checked = product ? product.active : true;
  form.elements.featured.checked = product?.featured || false;
  $("#productDialogTitle").textContent = product ? "Editar produto" : "Novo produto";
  setError("productAdminError");
  showDialog("productDialog");
}

async function saveProduct(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const submit = form.querySelector('[type="submit"]');
  setBusy(submit, true);
  setError("productAdminError");
  try {
    const file = form.elements.imageFile.files?.[0] || null;
    const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
    if (file && (!allowedTypes.has(file.type) || file.size > 5 * 1024 * 1024)) {
      throw new Error("Escolha uma imagem JPEG, PNG, WebP ou AVIF de até 5 MiB.");
    }
    let imageUrl = form.elements.removeImage.checked
      ? null
      : (form.elements.imageUrl.value.trim() || null);
    if (file) {
      const upload = await api.uploadProductImage(file);
      imageUrl = upload.imageUrl;
    }
    const input = {
      categoryId: form.elements.categoryId.value,
      name: form.elements.name.value.trim(),
      description: form.elements.description.value.trim(),
      priceCents: parseMoneyToCents(form.elements.price.value, { allowBlank: true }),
      imageUrl,
      active: form.elements.active.checked,
      featured: form.elements.featured.checked,
      sortOrder: Number(form.elements.sortOrder.value || 0)
    };
    const id = form.elements.id.value;
    if (id) await api.updateAdmin("products", id, input);
    else await api.createAdmin("products", input);
    closeDialog("productDialog");
    toast("Produto salvo.");
    await loadProductData();
  } catch (error) {
    setError("productAdminError", error.message);
  } finally {
    setBusy(submit, false);
  }
}

async function deleteResource(resource, id, label, reload) {
  if (!window.confirm(`Excluir ${label}? Se houver vínculos, prefira desativar.`)) return;
  try {
    await api.removeAdmin(resource, id);
    toast(`${label} excluído(a).`);
    await reload();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadOptions(product) {
  state.optionProduct = product;
  $("#optionsDialogTitle").textContent = product.name;
  $("#optionEditor").innerHTML = `<div class="empty-panel"><span>Carregando opções…</span></div>`;
  showDialog("optionsDialog");
  try {
    const [groupPayload, valuePayload] = await Promise.all([api.listAdmin("option-groups"), api.listAdmin("option-values")]);
    state.optionGroups = asList(groupPayload, "optionGroups").map(normalizeOptionGroup);
    state.optionValues = asList(valuePayload, "optionValues").map(normalizeOptionValue);
    for (const group of state.optionGroups) {
      for (const value of group.values) if (!state.optionValues.some((item) => item.id === value.id)) state.optionValues.push({ ...value, groupId: group.id });
    }
    renderOptions();
  } catch (error) {
    $("#optionEditor").innerHTML = `<div class="empty-panel"><strong>Não foi possível carregar.</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
}

function renderOptions() {
  const groups = state.optionGroups.filter((group) => group.productId === state.optionProduct?.id).sort((a, b) => a.sortOrder - b.sortOrder);
  $("#optionEditor").innerHTML = groups.length ? groups.map((group) => {
    const values = state.optionValues.filter((value) => value.groupId === group.id).sort((a, b) => a.sortOrder - b.sortOrder);
    return `<article class="option-group-card"><div class="option-group-card__head"><div><strong>${escapeHtml(group.name)}</strong><div class="data-card__meta"><span class="status-pill ${group.active ? "" : "is-off"}">${group.active ? "Ativo" : "Inativo"}</span><span class="tag">${group.required ? "Obrigatório" : "Opcional"} · ${group.minSelect}–${group.maxSelect}</span></div></div><div class="tiny-actions"><button class="tiny-button" type="button" data-edit-group="${escapeHtml(group.id)}">Editar</button><button class="tiny-button" type="button" data-delete-group="${escapeHtml(group.id)}">Excluir</button></div></div><div class="option-values">${values.map((value) => `<div class="option-value-row"><span>${escapeHtml(value.name)} · ${value.priceDeltaCents ? `+ ${money(value.priceDeltaCents)}` : "sem acréscimo"}</span><div class="tiny-actions"><button class="tiny-button" type="button" data-edit-value="${escapeHtml(value.id)}">Editar</button><button class="tiny-button" type="button" data-delete-value="${escapeHtml(value.id)}">Excluir</button></div></div>`).join("") || `<small>Nenhuma opção neste grupo.</small>`}</div><button class="btn btn--ghost" type="button" data-new-value="${escapeHtml(group.id)}">+ Adicionar valor</button></article>`;
  }).join("") : `<div class="empty-panel"><strong>Nenhum grupo de opções.</strong><span>Crie tamanhos, sabores ou adicionais para este produto.</span></div>`;
}

function openGroupForm(group = null) {
  const form = $("#optionGroupForm");
  form.reset();
  form.elements.id.value = group?.id || "";
  form.elements.productId.value = state.optionProduct?.id || "";
  form.elements.name.value = group?.name || "";
  form.elements.minSelect.value = group?.minSelect ?? 0;
  form.elements.maxSelect.value = group?.maxSelect ?? 1;
  form.elements.sortOrder.value = group?.sortOrder ?? 0;
  form.elements.required.checked = group?.required || false;
  form.elements.active.checked = group ? group.active : true;
  setError("optionGroupError");
  showDialog("optionGroupDialog");
}

async function saveGroup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = { productId: form.elements.productId.value, name: form.elements.name.value.trim(), minSelect: Number(form.elements.minSelect.value), maxSelect: Number(form.elements.maxSelect.value), sortOrder: Number(form.elements.sortOrder.value || 0), required: form.elements.required.checked, active: form.elements.active.checked };
  if (input.maxSelect < Math.max(input.minSelect, 1)) { setError("optionGroupError", "O máximo deve ser maior ou igual ao mínimo."); return; }
  if (input.required && input.minSelect < 1) { setError("optionGroupError", "Um grupo obrigatório deve exigir ao menos uma opção."); return; }
  const submit = form.querySelector('[type="submit"]');
  setBusy(submit, true);
  try {
    if (form.elements.id.value) await api.updateAdmin("option-groups", form.elements.id.value, input);
    else await api.createAdmin("option-groups", input);
    closeDialog("optionGroupDialog");
    toast("Grupo salvo.");
    await loadOptions(state.optionProduct);
  } catch (error) { setError("optionGroupError", error.message); }
  finally { setBusy(submit, false); }
}

function openValueForm(groupId, value = null) {
  const form = $("#optionValueForm");
  form.reset();
  form.elements.id.value = value?.id || "";
  form.elements.groupId.value = groupId;
  form.elements.name.value = value?.name || "";
  form.elements.priceDelta.value = formatMoneyInput(value?.priceDeltaCents ?? 0);
  form.elements.sortOrder.value = value?.sortOrder ?? 0;
  form.elements.active.checked = value ? value.active : true;
  setError("optionValueError");
  showDialog("optionValueDialog");
}

async function saveValue(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  setBusy(submit, true);
  try {
    const input = { groupId: form.elements.groupId.value, name: form.elements.name.value.trim(), priceDeltaCents: parseMoneyToCents(form.elements.priceDelta.value), sortOrder: Number(form.elements.sortOrder.value || 0), active: form.elements.active.checked };
    if (form.elements.id.value) await api.updateAdmin("option-values", form.elements.id.value, input);
    else await api.createAdmin("option-values", input);
    closeDialog("optionValueDialog");
    toast("Opção salva.");
    await loadOptions(state.optionProduct);
  } catch (error) { setError("optionValueError", error.message); }
  finally { setBusy(submit, false); }
}

async function initProducts() {
  $("#newProduct").addEventListener("click", () => openProductForm());
  $("#productSearch").addEventListener("input", renderProductsAdmin);
  $("#productCategoryFilter").addEventListener("change", renderProductsAdmin);
  $("#productAdminForm").addEventListener("submit", saveProduct);
  $("#productAdminForm").elements.imageFile.addEventListener("change", (event) => {
    if (event.target.files?.length) {
      $("#productAdminForm").elements.removeImage.checked = false;
    }
  });
  $("#productList").addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit-product]");
    const remove = event.target.closest("[data-delete-product]");
    const options = event.target.closest("[data-options-product]");
    if (edit) openProductForm(state.products.find((item) => item.id === edit.dataset.editProduct));
    if (remove) deleteResource("products", remove.dataset.deleteProduct, "produto", loadProductData);
    if (options) loadOptions(state.products.find((item) => item.id === options.dataset.optionsProduct));
  });
  $("#newOptionGroup").addEventListener("click", () => openGroupForm());
  $("#optionGroupForm").addEventListener("submit", saveGroup);
  $("#optionValueForm").addEventListener("submit", saveValue);
  $("#optionEditor").addEventListener("click", (event) => {
    const editGroup = event.target.closest("[data-edit-group]");
    const deleteGroup = event.target.closest("[data-delete-group]");
    const newValue = event.target.closest("[data-new-value]");
    const editValue = event.target.closest("[data-edit-value]");
    const deleteValue = event.target.closest("[data-delete-value]");
    if (editGroup) openGroupForm(state.optionGroups.find((item) => item.id === editGroup.dataset.editGroup));
    if (deleteGroup) deleteResource("option-groups", deleteGroup.dataset.deleteGroup, "grupo", () => loadOptions(state.optionProduct));
    if (newValue) openValueForm(newValue.dataset.newValue);
    if (editValue) { const value = state.optionValues.find((item) => item.id === editValue.dataset.editValue); if (value) openValueForm(value.groupId, value); }
    if (deleteValue) deleteResource("option-values", deleteValue.dataset.deleteValue, "opção", () => loadOptions(state.optionProduct));
  });
  await loadProductData();
}

async function loadCategories() {
  try {
    state.categories = asList(await api.listAdmin("categories"), "categories").map(normalizeCategory).sort((a, b) => a.sortOrder - b.sortOrder);
    $("#categoryCount").textContent = `${state.categories.length} ${state.categories.length === 1 ? "categoria" : "categorias"}`;
    $("#categoryList").innerHTML = state.categories.length ? state.categories.map((category) => `<article class="data-card"><div class="data-card__main"><strong>${escapeHtml(category.name)}</strong><span>/${escapeHtml(category.slug)} · ordem ${category.sortOrder}</span></div><div class="data-card__meta"><span class="status-pill ${category.active ? "" : "is-off"}">${category.active ? "Ativa" : "Inativa"}</span></div><div class="data-card__actions"><button class="btn btn--ghost" type="button" data-edit-category="${escapeHtml(category.id)}">Editar</button><button class="btn btn--ghost" type="button" data-delete-category="${escapeHtml(category.id)}">Excluir</button></div></article>`).join("") : `<div class="empty-panel"><strong>Nenhuma categoria.</strong><span>Crie a primeira seção do cardápio.</span></div>`;
  } catch (error) { $("#categoryList").innerHTML = `<div class="empty-panel"><strong>Não foi possível carregar.</strong><span>${escapeHtml(error.message)}</span></div>`; }
}

function openCategoryForm(category = null) {
  const form = $("#categoryForm");
  form.reset();
  form.elements.id.value = category?.id || "";
  form.elements.name.value = category?.name || "";
  form.elements.slug.value = category?.slug || "";
  form.elements.sortOrder.value = category?.sortOrder ?? 0;
  form.elements.active.checked = category ? category.active : true;
  $("#categoryDialogTitle").textContent = category ? "Editar categoria" : "Nova categoria";
  setError("categoryError");
  showDialog("categoryDialog");
}

async function saveCategory(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = { name: form.elements.name.value.trim(), slug: slugify(form.elements.slug.value || form.elements.name.value), sortOrder: Number(form.elements.sortOrder.value || 0), active: form.elements.active.checked };
  const submit = form.querySelector('[type="submit"]');
  setBusy(submit, true);
  try {
    if (form.elements.id.value) await api.updateAdmin("categories", form.elements.id.value, input);
    else await api.createAdmin("categories", input);
    closeDialog("categoryDialog"); toast("Categoria salva."); await loadCategories();
  } catch (error) { setError("categoryError", error.message); }
  finally { setBusy(submit, false); }
}

async function initCategories() {
  $("#newCategory").addEventListener("click", () => openCategoryForm());
  $("#categoryForm").addEventListener("submit", saveCategory);
  $("#categoryList").addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit-category]");
    const remove = event.target.closest("[data-delete-category]");
    if (edit) openCategoryForm(state.categories.find((item) => item.id === edit.dataset.editCategory));
    if (remove) deleteResource("categories", remove.dataset.deleteCategory, "categoria", loadCategories);
  });
  await loadCategories();
}

function normalizeZone(item) {
  return { id: String(item.id || ""), name: String(item.name || "Zona"), feeCents: Number(item.feeCents ?? item.fee_cents ?? 0), minimumOrderCents: Number(item.minimumOrderCents ?? item.minimum_order_cents ?? 0), active: item.active !== false };
}

async function loadZones() {
  try {
    state.zones = asList(await api.listAdmin("delivery-zones"), "deliveryZones").map(normalizeZone);
    $("#zoneCount").textContent = `${state.zones.length} ${state.zones.length === 1 ? "zona" : "zonas"}`;
    $("#zoneList").innerHTML = state.zones.length ? state.zones.map((zone) => `<article class="data-card"><div class="data-card__main"><strong>${escapeHtml(zone.name)}</strong><span>Taxa ${money(zone.feeCents)} · mínimo ${money(zone.minimumOrderCents)}</span></div><div class="data-card__meta"><span class="status-pill ${zone.active ? "" : "is-off"}">${zone.active ? "Ativa" : "Inativa"}</span></div><div class="data-card__actions"><button class="btn btn--ghost" type="button" data-edit-zone="${escapeHtml(zone.id)}">Editar</button><button class="btn btn--ghost" type="button" data-delete-zone="${escapeHtml(zone.id)}">Excluir</button></div></article>`).join("") : `<div class="empty-panel"><strong>Nenhuma zona cadastrada.</strong><span>Não há bairros ou taxas publicados.</span></div>`;
  } catch (error) { $("#zoneList").innerHTML = `<div class="empty-panel"><strong>Não foi possível carregar.</strong><span>${escapeHtml(error.message)}</span></div>`; }
}

function openZoneForm(zone = null) {
  const form = $("#zoneForm");
  form.reset();
  form.elements.id.value = zone?.id || "";
  form.elements.name.value = zone?.name || "";
  form.elements.fee.value = formatMoneyInput(zone?.feeCents ?? 0);
  form.elements.minimumOrder.value = formatMoneyInput(zone?.minimumOrderCents ?? 0);
  form.elements.active.checked = zone ? zone.active : true;
  $("#zoneDialogTitle").textContent = zone ? "Editar zona" : "Nova zona";
  setError("zoneError");
  showDialog("zoneDialog");
}

async function saveZone(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  setBusy(submit, true);
  try {
    const input = { name: form.elements.name.value.trim(), feeCents: parseMoneyToCents(form.elements.fee.value), minimumOrderCents: parseMoneyToCents(form.elements.minimumOrder.value), active: form.elements.active.checked };
    if (form.elements.id.value) await api.updateAdmin("delivery-zones", form.elements.id.value, input);
    else await api.createAdmin("delivery-zones", input);
    closeDialog("zoneDialog"); toast("Zona de entrega salva."); await loadZones();
  } catch (error) { setError("zoneError", error.message); }
  finally { setBusy(submit, false); }
}

async function initDelivery() {
  const settingsForm = $("#deliverySettingsForm");
  const syncDeliveryMode = () => {
    const fixed = settingsForm.elements.deliveryFeeMode.value === "fixed";
    $("#fixedDeliveryFields").hidden = !fixed;
    $("#zonesPanel").hidden = fixed;
  };
  const loadDeliverySettings = async () => {
    try {
      state.deliveryStore = normalizeStore(await api.getStoreSettings());
      settingsForm.elements.deliveryFeeMode.value = state.deliveryStore.deliveryFeeMode;
      settingsForm.elements.fixedDeliveryFee.value = formatMoneyInput(state.deliveryStore.fixedDeliveryFeeCents);
      syncDeliveryMode();
      if (state.deliveryStore.deliveryFeeMode === "zones") await loadZones();
    } catch (error) {
      setError("deliverySettingsError", error.message);
    }
  };
  $("#newZone").addEventListener("click", () => openZoneForm());
  $("#zoneForm").addEventListener("submit", saveZone);
  $("#zoneList").addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit-zone]");
    const remove = event.target.closest("[data-delete-zone]");
    if (edit) openZoneForm(state.zones.find((item) => item.id === edit.dataset.editZone));
    if (remove) deleteResource("delivery-zones", remove.dataset.deleteZone, "zona", loadZones);
  });
  settingsForm.elements.deliveryFeeMode.addEventListener("change", syncDeliveryMode);
  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = settingsForm.querySelector('[type="submit"]');
    setBusy(submit, true);
    setError("deliverySettingsError");
    try {
      const deliveryFeeMode = settingsForm.elements.deliveryFeeMode.value;
      const input = { deliveryFeeMode };
      if (deliveryFeeMode === "fixed") {
        input.fixedDeliveryFeeCents = parseMoneyToCents(
          settingsForm.elements.fixedDeliveryFee.value,
          { allowBlank: true }
        );
      }
      await api.updateStoreSettings(input);
      toast("Configuração de entrega salva.");
      await loadDeliverySettings();
    } catch (error) {
      setError("deliverySettingsError", error.message);
    } finally {
      setBusy(submit, false);
    }
  });
  await loadDeliverySettings();
}

function normalizeStore(payload) {
  const item = payload?.store || payload || {};
  const rawPayments = Array.isArray(item.paymentMethods) ? item.paymentMethods : [];
  return {
    name: item.name || "",
    description: item.description || "",
    logoUrl: item.logoUrl || item.logo_url || "",
    timezone: item.timezone || "America/Sao_Paulo",
    minimumOrderCents: Number(item.minimumOrderCents ?? item.minimum_order_cents ?? 0),
    isOpen: item.isOpen ?? item.is_open ?? false,
    acceptsDelivery: item.acceptsDelivery ?? item.accepts_delivery ?? false,
    deliveryFeeMode: item.deliveryFeeMode === "fixed" || item.delivery_fee_mode === "fixed"
      ? "fixed"
      : "zones",
    fixedDeliveryFeeCents: item.fixedDeliveryFeeCents ?? item.fixed_delivery_fee_cents ?? null,
    acceptsPickup: item.acceptsPickup ?? item.accepts_pickup ?? false,
    acceptsScheduledOrders: item.acceptsScheduledOrders ?? item.accepts_scheduled_orders ?? false,
    setupComplete: item.setupComplete ?? item.setup_complete ?? false,
    instagram: item.instagram || item.instagram_handle || "",
    whatsappE164: item.whatsappE164 || item.whatsapp_e164 || "",
    whatsappDisplay: item.whatsappDisplay || item.whatsapp_display || "",
    scheduledMinLeadMinutes: item.scheduledMinLeadMinutes ?? item.scheduled_min_lead_minutes ?? null,
    scheduledMaxAdvanceDays: item.scheduledMaxAdvanceDays ?? item.scheduled_max_advance_days ?? null,
    pixKey: item.pixKey || item.pix_key || "",
    pixMerchantName: item.pixMerchantName || item.pix_merchant_name || "",
    pixMerchantCity: item.pixMerchantCity || item.pix_merchant_city || "",
    paymentMethods: rawPayments
      .filter((method) => typeof method === "string" || method?.active !== false)
      .map((method) => typeof method === "string" ? method : method.method || method.code || method.id || method.value)
      .filter(Boolean)
  };
}

async function loadStoreSettings() {
  try {
    const store = normalizeStore(await api.getStoreSettings());
    const form = $("#storeForm");
    form.elements.name.value = store.name;
    form.elements.description.value = store.description;
    form.elements.logoUrl.value = store.logoUrl;
    form.elements.timezone.value = store.timezone;
    form.elements.minimumOrder.value = formatMoneyInput(store.minimumOrderCents);
    form.elements.isOpen.checked = Boolean(store.isOpen);
    form.elements.acceptsDelivery.checked = Boolean(store.acceptsDelivery);
    form.elements.acceptsPickup.checked = Boolean(store.acceptsPickup);
    form.elements.acceptsScheduledOrders.checked = Boolean(store.acceptsScheduledOrders);
    form.elements.setupComplete.checked = Boolean(store.setupComplete);
    form.elements.instagram.value = store.instagram;
    form.elements.whatsappE164.value = store.whatsappE164;
    form.elements.whatsappDisplay.value = store.whatsappDisplay;
    form.elements.scheduledMinLeadMinutes.value = store.scheduledMinLeadMinutes ?? "";
    form.elements.scheduledMaxAdvanceDays.value = store.scheduledMaxAdvanceDays ?? "";
    form.elements.pixKey.value = store.pixKey;
    form.elements.pixMerchantName.value = store.pixMerchantName;
    form.elements.pixMerchantCity.value = store.pixMerchantCity;
    $$("#paymentMethods input").forEach((input) => { input.checked = store.paymentMethods.includes(input.value); });
    syncPixSettingsVisibility();
  } catch (error) { setError("storeError", error.message); }
}

function syncPixSettingsVisibility() {
  const enabled = Boolean($("#paymentMethods input[value='pix']")?.checked);
  $("#pixSettings").hidden = !enabled;
  $$("#pixSettings input").forEach((input) => { input.required = enabled; });
}

async function saveStoreSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  setBusy(submit, true);
  setError("storeError");
  try {
    const whatsappE164 = form.elements.whatsappE164.value.trim();
    if (whatsappE164 && !/^\+[1-9]\d{7,14}$/.test(whatsappE164)) {
      throw new Error("Informe o WhatsApp internacional no formato +5514999999999.");
    }
    const scheduledMinLeadMinutes = optionalInteger(form.elements.scheduledMinLeadMinutes.value, {
      min: 0, max: 525600, label: "A antecedência mínima"
    });
    const scheduledMaxAdvanceDays = optionalInteger(form.elements.scheduledMaxAdvanceDays.value, {
      min: 1, max: 3650, label: "O limite de antecedência"
    });
    const paymentMethods = $$("#paymentMethods input:checked").map((input) => ({
      ...PAYMENT_METHODS.find((method) => method.method === input.value)
    })).filter((method) => method.method);
    const pixEnabled = paymentMethods.some((method) => method.method === "pix");
    const pixKey = form.elements.pixKey.value.trim();
    const pixMerchantName = form.elements.pixMerchantName.value.trim();
    const pixMerchantCity = form.elements.pixMerchantCity.value.trim();
    if (pixEnabled && (!pixKey || !pixMerchantName || !pixMerchantCity)) {
      throw new Error("Preencha a chave Pix, o nome e a cidade do recebedor.");
    }
    await api.updateStoreSettings({
      name: form.elements.name.value.trim(), description: form.elements.description.value.trim(), timezone: form.elements.timezone.value.trim(),
      logoUrl: form.elements.logoUrl.value.trim() || null,
      minimumOrderCents: parseMoneyToCents(form.elements.minimumOrder.value), isOpen: form.elements.isOpen.checked,
      acceptsDelivery: form.elements.acceptsDelivery.checked, acceptsPickup: form.elements.acceptsPickup.checked,
      acceptsScheduledOrders: form.elements.acceptsScheduledOrders.checked,
      setupComplete: form.elements.setupComplete.checked,
      instagram: form.elements.instagram.value.trim() || null,
      whatsappE164: whatsappE164 || null,
      whatsappDisplay: form.elements.whatsappDisplay.value.trim() || null,
      scheduledMinLeadMinutes,
      scheduledMaxAdvanceDays,
      pixKey: pixKey || null,
      pixMerchantName: pixMerchantName || null,
      pixMerchantCity: pixMerchantCity || null,
      paymentMethods
    });
    toast("Configurações salvas.");
  } catch (error) { setError("storeError", error.message); }
  finally { setBusy(submit, false); }
}

function normalizeHour(item) {
  return { id: item.id || "", dayOfWeek: Number(item.dayOfWeek ?? item.day_of_week), openTime: item.openTime || item.open_time || "", closeTime: item.closeTime || item.close_time || "", closed: Boolean(item.closed ?? item.is_closed) };
}

function renderHours(hours) {
  const byDay = new Map(hours.map((hour) => [hour.dayOfWeek, hour]));
  $("#hoursGrid").innerHTML = DAY_LABELS.map((label, day) => {
    const hour = byDay.get(day) || { id: "", openTime: "", closeTime: "", closed: true };
    return `<div class="hours-row" data-day="${day}" data-id="${escapeHtml(hour.id)}"><div class="hours-row__day"><strong>${label}</strong><label class="check-field"><input type="checkbox" data-hour-closed ${hour.closed ? "checked" : ""} /> Fechado</label></div><label class="field"><span>Abertura</span><input type="time" data-hour-open value="${escapeHtml(hour.openTime || "")}" ${hour.closed ? "disabled" : ""} /></label><label class="field"><span>Fechamento</span><input type="time" data-hour-close value="${escapeHtml(hour.closeTime || "")}" ${hour.closed ? "disabled" : ""} /></label></div>`;
  }).join("");
}

async function loadHours() {
  try { renderHours(asList(await api.listAdmin("hours"), "hours").map(normalizeHour)); }
  catch (error) { setError("hoursError", error.message); renderHours([]); }
}

async function saveHours(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  setBusy(button, true);
  setError("hoursError");
  try {
    const hours = $$("[data-day]", $("#hoursGrid")).map((row) => {
      const closed = $("[data-hour-closed]", row).checked;
      const openTime = $("[data-hour-open]", row).value;
      const closeTime = $("[data-hour-close]", row).value;
      if (!closed && (!openTime || !closeTime)) throw new Error(`Preencha abertura e fechamento de ${DAY_LABELS[Number(row.dataset.day)]}.`);
      return {
        ...(row.dataset.id ? { id: row.dataset.id } : {}),
        dayOfWeek: Number(row.dataset.day),
        closed,
        ...(!closed ? { openTime, closeTime } : {})
      };
    });
    await api.replaceAdmin("hours", { hours });
    toast("Horários salvos.");
    await loadHours();
  } catch (error) { setError("hoursError", error.message); }
  finally { setBusy(button, false); }
}

function normalizeException(item) {
  return { id: String(item.id || ""), date: String(item.date || item.exceptionDate || item.exception_date || "").slice(0, 10), closed: Boolean(item.closed ?? item.isClosed ?? item.is_closed), openTime: item.openTime || item.open_time || "", closeTime: item.closeTime || item.close_time || "", note: String(item.note || "") };
}

async function loadExceptions() {
  try {
    state.exceptions = asList(await api.listAdmin("hour-exceptions"), "hourExceptions").map(normalizeException);
    $("#exceptionList").innerHTML = state.exceptions.length ? state.exceptions.map((item) => `<article class="data-card"><div class="data-card__main"><strong>${escapeHtml(dateOnly(item.date))}</strong><span>${item.closed ? "Fechado" : `${escapeHtml(item.openTime)}–${escapeHtml(item.closeTime)}`}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</span></div><div class="data-card__actions"><button class="btn btn--ghost" type="button" data-edit-exception="${escapeHtml(item.id)}">Editar</button><button class="btn btn--ghost" type="button" data-delete-exception="${escapeHtml(item.id)}">Excluir</button></div></article>`).join("") : `<div class="empty-panel"><strong>Nenhuma exceção.</strong><span>Os horários semanais serão usados.</span></div>`;
  } catch (error) { $("#exceptionList").innerHTML = `<div class="empty-panel"><strong>Exceções indisponíveis.</strong><span>${escapeHtml(error.message)}</span></div>`; }
}

function openExceptionForm(item = null) {
  const form = $("#exceptionForm");
  form.reset();
  form.elements.id.value = item?.id || "";
  form.elements.date.value = item?.date || "";
  form.elements.closed.checked = item?.closed || false;
  form.elements.openTime.value = item?.openTime || "";
  form.elements.closeTime.value = item?.closeTime || "";
  form.elements.openTime.disabled = form.elements.closed.checked;
  form.elements.closeTime.disabled = form.elements.closed.checked;
  form.elements.note.value = item?.note || "";
  setError("exceptionError");
  showDialog("exceptionDialog");
}

async function saveException(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const closed = form.elements.closed.checked;
  if (!closed && (!form.elements.openTime.value || !form.elements.closeTime.value)) { setError("exceptionError", "Informe abertura e fechamento, ou marque como fechado."); return; }
  const submit = form.querySelector('[type="submit"]');
  setBusy(submit, true);
  try {
    const input = {
      exceptionDate: form.elements.date.value,
      isClosed: closed,
      openTime: closed ? null : form.elements.openTime.value,
      closeTime: closed ? null : form.elements.closeTime.value,
      note: form.elements.note.value.trim()
    };
    if (form.elements.id.value) await api.updateAdmin("hour-exceptions", form.elements.id.value, input);
    else await api.createAdmin("hour-exceptions", input);
    closeDialog("exceptionDialog"); toast("Exceção salva."); await loadExceptions();
  } catch (error) { setError("exceptionError", error.message); }
  finally { setBusy(submit, false); }
}

async function initSettings() {
  $("#storeForm").addEventListener("submit", saveStoreSettings);
  $("#paymentMethods input[value='pix']").addEventListener("change", syncPixSettingsVisibility);
  $("#hoursForm").addEventListener("submit", saveHours);
  $("#hoursGrid").addEventListener("change", (event) => {
    if (!event.target.matches("[data-hour-closed]")) return;
    const row = event.target.closest("[data-day]");
    $("[data-hour-open]", row).disabled = event.target.checked;
    $("[data-hour-close]", row).disabled = event.target.checked;
  });
  $("#newException").addEventListener("click", () => openExceptionForm());
  $("#exceptionForm").addEventListener("submit", saveException);
  $("#exceptionForm").elements.closed.addEventListener("change", (event) => {
    const form = event.target.form;
    form.elements.openTime.disabled = event.target.checked;
    form.elements.closeTime.disabled = event.target.checked;
    if (event.target.checked) {
      form.elements.openTime.value = "";
      form.elements.closeTime.value = "";
    }
  });
  $("#exceptionList").addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit-exception]");
    const remove = event.target.closest("[data-delete-exception]");
    if (edit) openExceptionForm(state.exceptions.find((item) => item.id === edit.dataset.editException));
    if (remove) deleteResource("hour-exceptions", remove.dataset.deleteException, "exceção", loadExceptions);
  });
  await Promise.all([loadStoreSettings(), loadHours(), loadExceptions()]);
}

function normalizeInventoryProduct(item) {
  return {
    id: String(item.id || ""),
    name: String(item.name || "Produto"),
    imageUrl: item.imageUrl || null,
    categoryName: String(item.categoryName || "Sem categoria"),
    stockMode: ["always", "manual", "quantity"].includes(item.stockMode)
      ? item.stockMode
      : "always",
    available: item.available === true,
    lowStock: item.lowStock === true,
    preparedToday: Number(item.preparedToday || 0),
    soldToday: Number(item.soldToday || 0),
    remaining: item.remaining === null ? null : Number(item.remaining || 0),
    soldOutLast30Days: Number(item.soldOutLast30Days || 0)
  };
}

function inventoryModeLabel(mode) {
  return {
    always: "Sempre disponível",
    manual: "Disponível / Esgotado",
    quantity: "Controlar quantidade"
  }[mode] || mode;
}

function inventoryImage(product) {
  return product.imageUrl
    ? `<img src="${escapeHtml(product.imageUrl)}" alt="" loading="lazy" decoding="async" />`
    : `<span aria-hidden="true">🍰</span>`;
}

function inventoryControls(product) {
  if (product.stockMode === "always") {
    return `<div class="inventory-always"><strong>Sempre disponível</strong><span>Sem controle de quantidade</span></div>`;
  }
  if (product.stockMode === "manual") {
    return `<button class="inventory-toggle ${product.available ? "is-available" : "is-sold-out"}" type="button" data-inventory-availability="${escapeHtml(product.id)}" aria-pressed="${product.available}">${product.available ? "DISPONÍVEL" : "ESGOTADO"}</button>`;
  }
  return `<div class="inventory-numbers"><span><small>Preparado hoje</small><strong>${product.preparedToday}</strong></span><span><small>Vendidas hoje</small><strong>${product.soldToday}</strong></span><label><small>Restante</small><input type="number" min="0" max="100000" step="1" value="${product.remaining}" data-inventory-quantity="${escapeHtml(product.id)}" aria-label="Quantidade restante de ${escapeHtml(product.name)}" /></label></div><div class="inventory-quick-actions"><button type="button" data-inventory-adjust="${escapeHtml(product.id)}" data-quantity-delta="-1" data-prepared-delta="0">−1</button><button type="button" data-inventory-adjust="${escapeHtml(product.id)}" data-quantity-delta="1" data-prepared-delta="1">+1</button><button type="button" data-inventory-adjust="${escapeHtml(product.id)}" data-quantity-delta="5" data-prepared-delta="5">+5</button></div>`;
}

function inventoryModeControl(product) {
  if (!["owner", "manager"].includes(state.session?.role)) {
    return `<div class="field inventory-mode"><span>Modo de estoque</span><strong>${escapeHtml(inventoryModeLabel(product.stockMode))}</strong></div>`;
  }
  return `<label class="field inventory-mode"><span>Modo de estoque</span><select data-inventory-mode="${escapeHtml(product.id)}"><option value="always" ${product.stockMode === "always" ? "selected" : ""}>Sempre disponível</option><option value="manual" ${product.stockMode === "manual" ? "selected" : ""}>Disponível / Esgotado</option><option value="quantity" ${product.stockMode === "quantity" ? "selected" : ""}>Controlar quantidade</option></select></label>`;
}

function renderInventory() {
  const summary = state.inventorySummary;
  $("#inventorySummary").innerHTML = `<strong>${summary.available} disponíveis</strong><strong>${summary.soldOut} esgotados</strong><strong>${summary.lowStock} com estoque baixo</strong>`;
  $$('[data-inventory-filter]').forEach((button) => {
    const active = button.dataset.inventoryFilter === state.inventoryFilter;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const term = normalizeText($("#inventorySearch").value.trim());
  const products = state.inventory.filter((product) => {
    const matchesSearch = !term || normalizeText(`${product.name} ${product.categoryName}`).includes(term);
    const matchesFilter = state.inventoryFilter === "all"
      || (state.inventoryFilter === "available" && product.available)
      || (state.inventoryFilter === "sold-out" && !product.available)
      || (state.inventoryFilter === "low" && product.lowStock);
    return matchesSearch && matchesFilter;
  });
  $("#inventoryCount").textContent = `${products.length} ${products.length === 1 ? "produto" : "produtos"}`;
  $("#inventoryList").innerHTML = products.length ? products.map((product) => {
    const busy = state.inventoryBusy.has(product.id);
    const statusLabel = product.available
      ? product.lowStock ? "Estoque baixo" : "Disponível"
      : "Esgotado";
    return `<article class="inventory-card ${product.available ? "" : "is-sold-out"}" data-inventory-card="${escapeHtml(product.id)}" aria-busy="${busy}"><div class="inventory-card__head"><div class="inventory-card__image">${inventoryImage(product)}</div><div><small>${escapeHtml(product.categoryName)}</small><h2>${escapeHtml(product.name)}</h2><span class="status-pill ${product.available ? "" : "is-off"}">${statusLabel}</span></div></div>${inventoryModeControl(product)}<div class="inventory-card__controls">${inventoryControls(product)}</div><div class="inventory-card__history"><span>${escapeHtml(inventoryModeLabel(product.stockMode))}</span><strong>Esgotou ${product.soldOutLast30Days} ${product.soldOutLast30Days === 1 ? "vez" : "vezes"} nos últimos 30 dias</strong></div></article>`;
  }).join("") : `<div class="empty-panel"><strong>Nenhum produto encontrado.</strong><span>Ajuste a busca ou os filtros rápidos.</span></div>`;
}

async function loadInventory({ quiet = false } = {}) {
  if (!quiet) $("#inventoryList").innerHTML = `<div class="empty-panel"><strong>Carregando estoque do dia…</strong></div>`;
  try {
    const payload = await api.getDailyInventory();
    state.inventory = asList(payload, "products").map(normalizeInventoryProduct);
    state.inventorySummary = payload?.summary || { available: 0, soldOut: 0, lowStock: 0 };
    renderInventory();
  } catch (error) {
    $("#inventoryList").innerHTML = `<div class="empty-panel"><strong>Não foi possível carregar.</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
}

async function mutateInventory(productId, operation, successMessage) {
  if (state.inventoryBusy.has(productId)) return;
  state.inventoryBusy.add(productId);
  renderInventory();
  try {
    await operation();
    toast(successMessage);
    await loadInventory({ quiet: true });
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.inventoryBusy.delete(productId);
    renderInventory();
  }
}

async function initInventory() {
  $("#inventorySearch").addEventListener("input", renderInventory);
  $("#inventoryFilters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-inventory-filter]");
    if (!button) return;
    state.inventoryFilter = button.dataset.inventoryFilter;
    renderInventory();
  });
  $("#inventoryList").addEventListener("change", (event) => {
    const mode = event.target.closest("[data-inventory-mode]");
    const quantity = event.target.closest("[data-inventory-quantity]");
    if (mode) {
      void mutateInventory(
        mode.dataset.inventoryMode,
        () => api.updateDailyInventory(mode.dataset.inventoryMode, { stockMode: mode.value }),
        "Modo de estoque atualizado."
      );
    }
    if (quantity) {
      const product = state.inventory.find((item) => item.id === quantity.dataset.inventoryQuantity);
      const remaining = Number(quantity.value);
      if (!product || !Number.isInteger(remaining) || remaining < 0 || remaining > 100000) {
        toast("Informe uma quantidade inteira entre 0 e 100000.", "error");
        renderInventory();
        return;
      }
      void mutateInventory(
        product.id,
        () => api.updateDailyInventory(product.id, { quantityRemaining: remaining }),
        "Quantidade atualizada."
      );
    }
  });
  $("#inventoryList").addEventListener("click", (event) => {
    const availability = event.target.closest("[data-inventory-availability]");
    const adjustment = event.target.closest("[data-inventory-adjust]");
    if (availability) {
      const product = state.inventory.find((item) => item.id === availability.dataset.inventoryAvailability);
      if (product) void mutateInventory(
        product.id,
        () => api.updateDailyInventory(product.id, { available: !product.available }),
        product.available ? "Produto marcado como esgotado." : "Produto marcado como disponível."
      );
    }
    if (adjustment) {
      const productId = adjustment.dataset.inventoryAdjust;
      void mutateInventory(
        productId,
        () => api.adjustDailyInventory(productId, {
          quantityDelta: Number(adjustment.dataset.quantityDelta),
          preparedDelta: Number(adjustment.dataset.preparedDelta)
        }),
        "Estoque ajustado."
      );
    }
  });
  await loadInventory();
}

async function init() {
  wireShell();
  if (page === "login") { await initLogin(); return; }
  if (!await requireSession()) return;
  const initializers = { orders: initOrders, inventory: initInventory, products: initProducts, categories: initCategories, delivery: initDelivery, settings: initSettings };
  await initializers[page]?.();
}

init();
