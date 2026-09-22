import { api, openApiEventStream } from "./api-client.js";
import { loadCart, saveCart, loadTrackedOrders, saveTrackedOrders } from "./browser-storage-policy.js";

const STORE_SLUG = document.documentElement.dataset.storeSlug || "atrevida-gourmet";
const MAX_LINES = 40;
const MAX_LINE_QUANTITY = 50;
const MAX_TOTAL_UNITS = 200;
const TRACKING_POLL_INTERVAL_MS = 75_000;
const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);
const PAYMENT_LABELS = {
  pix: "Pix",
  cash: "Dinheiro",
  card_on_delivery: "Cartão no recebimento"
};
const PAYMENT_STATUS_LABELS = {
  pending: "Aguardando pagamento",
  pay_on_delivery: "Pagamento no recebimento",
  approved: "Pagamento confirmado",
  rejected: "Pagamento recusado",
  cancelled: "Pagamento cancelado",
  refunded: "Pagamento estornado"
};
const STATUS_LABELS = {
  pending: "Pedido recebido / aguardando confirmação",
  confirmed: "Pedido confirmado",
  preparing: "Em preparo",
  ready: "Pronto para retirada",
  out_for_delivery: "Saiu para entrega",
  completed: "Pedido concluído",
  cancelled: "Pedido cancelado"
};
const state = {
  catalog: null,
  products: new Map(),
  activeCategory: "all",
  search: "",
  cart: loadCart(),
  selectedProduct: null,
  selectedQty: 1,
  quote: null,
  quoteFingerprint: "",
  checkoutKey: null,
  trackedOrders: loadTrackedOrders(),
  trackingPoll: null,
  trackingStreams: new Map(),
  toastTimer: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const els = {
  storeLogo: $("#storeLogo"),
  storeName: $("#storeName"),
  storeDescription: $("#storeDescription"),
  heroStoreName: $("#heroStoreName"),
  footerStoreName: $("#footerStoreName"),
  footerStoreDescription: $("#footerStoreDescription"),
  instagramLink: $("#instagramLink"),
  whatsappLink: $("#whatsappLink"),
  storeAlert: $("#storeAlert"),
  deliveryCapability: $("#deliveryCapability"),
  pickupCapability: $("#pickupCapability"),
  scheduledCapability: $("#scheduledCapability"),
  scheduledOrderCta: $("#scheduledOrderCta"),
  tabs: $("#categoryTabs"),
  grid: $("#productGrid"),
  feedback: $("#catalogFeedback"),
  empty: $("#emptyState"),
  search: $("#searchInput"),
  productModal: $("#productModal"),
  productForm: $("#productForm"),
  productClose: $("#productClose"),
  modalImage: $("#modalImage"),
  modalBadge: $("#modalBadge"),
  modalTitle: $("#modalTitle"),
  modalDescription: $("#modalDescription"),
  modalPrice: $("#modalPrice"),
  modalPriceNote: $("#modalPriceNote"),
  optionGroups: $("#optionGroups"),
  productError: $("#productError"),
  qtyMinus: $("#qtyMinus"),
  qtyPlus: $("#qtyPlus"),
  qtyValue: $("#qtyValue"),
  itemNote: $("#itemNote"),
  addToCartBtn: $("#addToCartBtn"),
  cartDrawer: $("#cartDrawer"),
  cartList: $("#cartList"),
  cartSubtotal: $("#cartSubtotal"),
  checkoutBtn: $("#checkoutBtn"),
  floatingCart: $("#floatingCart"),
  floatingCartQty: $("#floatingCartQty"),
  floatingCartTotal: $("#floatingCartTotal"),
  cartCount: $("#cartCount"),
  checkoutModal: $("#checkoutModal"),
  checkoutForm: $("#checkoutForm"),
  checkoutClose: $("#checkoutClose"),
  fulfillmentOptions: $("#fulfillmentOptions"),
  checkoutSubtotal: $("#checkoutSubtotal"),
  checkoutDeliveryFee: $("#checkoutDeliveryFee"),
  checkoutTotal: $("#checkoutTotal"),
  deliveryFields: $("#deliveryFields"),
  scheduledFields: $("#scheduledFields"),
  paymentSelect: $("#paymentSelect"),
  changeField: $("#changeField"),
  quoteBtn: $("#quoteBtn"),
  quoteStatus: $("#quoteStatus"),
  checkoutError: $("#checkoutError"),
  submitOrderBtn: $("#submitOrderBtn"),
  successModal: $("#successModal"),
  successOrderId: $("#successOrderId"),
  successOrderStatus: $("#successOrderStatus"),
  successOrderTotal: $("#successOrderTotal"),
  successPix: $("#successPix"),
  pixCopyPaste: $("#pixCopyPaste"),
  copyPixBtn: $("#copyPixBtn"),
  successCloseBtn: $("#successCloseBtn"),
  viewOrdersBtn: $("#viewOrdersBtn"),
  ordersDrawer: $("#ordersDrawer"),
  ordersList: $("#ordersList"),
  ordersBtn: $("#ordersBtn"),
  heroOrdersBtn: $("#heroOrdersBtn"),
  ordersClose: $("#ordersClose"),
  showOrdersCategory: $("#showOrdersCategory"),
  toast: $("#toast")
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeImageUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value, window.location.origin);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function instagramProfile(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const candidate = new URL(raw);
    if (candidate.protocol === "https:" && ["instagram.com", "www.instagram.com"].includes(candidate.hostname)) {
      return { href: candidate.href, label: `@${candidate.pathname.split("/").filter(Boolean)[0] || "Instagram"}` };
    }
  } catch {
    // Handles such as @minha_loja are normalized below.
  }
  const handle = raw.replace(/^@/, "");
  if (!/^[a-z0-9._]{1,30}$/i.test(handle)) return null;
  return { href: `https://www.instagram.com/${handle}/`, label: `@${handle}` };
}

function whatsappProfile(displayValue, e164Value) {
  let digits = String(e164Value || displayValue || "").replace(/\D/g, "");
  if ([10, 11].includes(digits.length)) digits = `55${digits}`;
  if (!/^\d{12,15}$/.test(digits)) return null;
  return {
    href: `https://wa.me/${digits}`,
    label: String(displayValue || e164Value || digits).trim()
  };
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
}

function scheduledOrderCategory(catalog = state.catalog) {
  return catalog?.categories.find((item) => normalizeText(`${item.name} ${item.slug}`).includes("encomenda"));
}

function money(cents, currency = state.catalog?.currency || "BRL") {
  const safeCents = Number.isFinite(Number(cents)) ? Number(cents) : 0;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(safeCents / 100);
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function showDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

function setError(element, message = "") {
  element.textContent = message;
  element.hidden = !message;
}

function setButtonBusy(button, busy, busyLabel = "Enviando…") {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  const label = $("span:first-child", button);
  const spinner = $(".button-spinner", button);
  if (label) {
    if (!label.dataset.label) label.dataset.label = label.textContent;
    label.textContent = busy ? busyLabel : label.dataset.label;
  } else {
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.textContent = busy ? busyLabel : button.dataset.label;
  }
  if (spinner) spinner.hidden = !busy;
}

function toast(message, kind = "success") {
  window.clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.dataset.kind = kind;
  els.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => { els.toast.hidden = true; }, 4200);
}

function normalizeCatalog(payload) {
  const source = payload?.store ? { ...payload.store, categories: payload.categories || payload.store.categories } : payload || {};
  const categories = (Array.isArray(source.categories) ? source.categories : []).map((category) => ({
    id: String(category.id || category.slug || ""),
    name: String(category.name || "Categoria"),
    slug: String(category.slug || category.id || ""),
    products: (Array.isArray(category.products) ? category.products : []).map((product) => ({
      id: String(product.id || ""),
      categoryId: String(product.categoryId || product.category_id || category.id || ""),
      categoryName: String(category.name || ""),
      name: String(product.name || "Produto"),
      description: String(product.description || ""),
      imageUrl: product.imageUrl || product.image_url || null,
      priceCents: Number.isInteger(product.priceCents) ? product.priceCents : (Number.isInteger(product.price_cents) ? product.price_cents : null),
      featured: Boolean(product.featured),
      active: product.active !== false,
      optionGroups: (product.optionGroups || product.product_option_groups || []).map((group) => ({
        id: String(group.id || ""),
        name: String(group.name || "Opções"),
        required: Boolean(group.required),
        minSelect: Number(group.minSelect ?? group.min_select ?? (group.required ? 1 : 0)),
        maxSelect: Number(group.maxSelect ?? group.max_select ?? 1),
        values: (group.values || group.product_option_values || []).map((value) => ({
          id: String(value.id || ""),
          name: String(value.name || "Opção"),
          priceDeltaCents: Number(value.priceDeltaCents ?? value.price_delta_cents ?? 0)
        }))
      }))
    }))
  })).filter((category) => category.products.length > 0);

  const rawPayments = Array.isArray(source.paymentMethods) ? source.paymentMethods : [];
  const paymentMethods = rawPayments.map((item) => {
    const code = typeof item === "string" ? item : item?.method || item?.code || item?.id || item?.value;
    const label = typeof item === "string" ? PAYMENT_LABELS[item] || item : item?.label || PAYMENT_LABELS[code] || code;
    return { code: String(code || ""), label: String(label || ""), active: typeof item === "string" ? true : item?.active !== false };
  }).filter((item) => item.code && item.label && item.active);
  return {
    slug: source.slug || STORE_SLUG,
    name: source.name || "Atrevida Gourmet",
    description: source.description || "",
    logoUrl: source.logoUrl || source.logo_url || null,
    instagram: source.instagram || source.instagramHandle || source.instagram_handle || "",
    whatsappDisplay: source.whatsappDisplay || source.whatsapp_display || source.whatsapp || "",
    whatsappE164: source.whatsappE164 || source.whatsapp_e164 || "",
    isOpen: source.isOpen !== false,
    acceptsDelivery: source.acceptsDelivery === true,
    acceptsPickup: source.acceptsPickup === true,
    acceptsScheduledOrders: source.acceptsScheduledOrders === true,
    minimumOrderCents: Number(source.minimumOrderCents ?? source.minimum_order_cents ?? 0),
    currency: source.currency || "BRL",
    paymentMethods,
    categories
  };
}

function productList() {
  return state.catalog?.categories.flatMap((category) => category.products) || [];
}

function renderCatalogSkeleton() {
  els.grid.setAttribute("aria-busy", "true");
  els.grid.innerHTML = Array.from({ length: 6 }, () => `<article class="product-card skeleton-card" aria-hidden="true"><div class="skeleton skeleton--image"></div><div class="product-card__body"><span class="skeleton skeleton--title"></span><span class="skeleton skeleton--text"></span><span class="skeleton skeleton--button"></span></div></article>`).join("");
}

async function loadCatalog() {
  renderCatalogSkeleton();
  els.feedback.innerHTML = "";
  try {
    state.catalog = normalizeCatalog(await api.getCatalog(STORE_SLUG));
    state.products = new Map(productList().map((product) => [product.id, product]));
    applyStoreDetails();
    reconcileCart();
    renderTabs();
    renderProducts();
    renderCart();
    configureCheckout();
  } catch (error) {
    els.grid.innerHTML = "";
    els.grid.setAttribute("aria-busy", "false");
    els.feedback.innerHTML = `<div class="inline-error"><strong>Não foi possível carregar o cardápio.</strong><span>${escapeHtml(error.message)}</span><button class="btn btn--ghost" type="button" data-retry-catalog>Tentar novamente</button></div>`;
  }
}

function applyStoreDetails() {
  const catalog = state.catalog;
  els.storeName.textContent = catalog.name;
  els.storeDescription.textContent = catalog.description || "Cardápio digital";
  if (els.heroStoreName) els.heroStoreName.textContent = catalog.name;
  if (els.footerStoreName) els.footerStoreName.textContent = catalog.name;
  if (els.footerStoreDescription) els.footerStoreDescription.textContent = catalog.description || "Cardápio digital";
  document.title = `${catalog.name} | Cardápio`;
  const logoUrl = safeImageUrl(catalog.logoUrl);
  if (logoUrl) els.storeLogo.src = logoUrl;
  const instagram = instagramProfile(catalog.instagram);
  if (els.instagramLink) {
    els.instagramLink.hidden = !instagram;
    if (instagram) {
      els.instagramLink.href = instagram.href;
      els.instagramLink.textContent = instagram.label;
    }
  }
  const whatsapp = whatsappProfile(catalog.whatsappDisplay, catalog.whatsappE164);
  if (els.whatsappLink) {
    els.whatsappLink.hidden = !whatsapp;
    if (whatsapp) {
      els.whatsappLink.href = whatsapp.href;
      els.whatsappLink.textContent = `WhatsApp ${whatsapp.label}`;
    }
  }
  els.deliveryCapability.classList.toggle("is-unavailable", !catalog.acceptsDelivery);
  els.pickupCapability.classList.toggle("is-unavailable", !catalog.acceptsPickup);
  els.scheduledCapability.classList.toggle("is-unavailable", !catalog.acceptsScheduledOrders);
  els.scheduledOrderCta.hidden = !(catalog.acceptsScheduledOrders && scheduledOrderCategory(catalog));
  if (!catalog.isOpen) {
    els.storeAlert.hidden = false;
    els.storeAlert.textContent = catalog.acceptsScheduledOrders
      ? "A loja está fechada para pedidos imediatos. Você ainda pode solicitar uma encomenda."
      : "A loja está fechada no momento. Consulte novamente mais tarde.";
  } else {
    els.storeAlert.hidden = true;
  }
}

function reconcileCart() {
  const before = state.cart.length;
  state.cart = state.cart.filter((item) => state.products.has(String(item.productId)) && Number(item.quantity || item.qty) > 0).map((item) => ({
    uid: String(item.uid || uuid()),
    productId: String(item.productId),
    quantity: Math.min(MAX_LINE_QUANTITY, Number(item.quantity || item.qty || 1)),
    note: String(item.note || "").slice(0, 300),
    options: Array.isArray(item.options) ? item.options.map((option) => ({ groupId: String(option.groupId), valueId: String(option.valueId) })) : []
  }));
  saveCart(state.cart);
  if (before !== state.cart.length) toast("Itens indisponíveis foram removidos do carrinho.", "warning");
}

function renderTabs() {
  const categories = state.catalog?.categories || [];
  const featured = productList().some((product) => product.featured);
  const tabs = [{ id: "all", name: "Todos" }, ...(featured ? [{ id: "featured", name: "Destaques" }] : []), ...categories.map((category) => ({ id: category.id, name: category.name }))];
  if (!tabs.some((tab) => tab.id === state.activeCategory)) state.activeCategory = "all";
  els.tabs.innerHTML = tabs.map((tab) => `<button class="category-tab ${state.activeCategory === tab.id ? "is-active" : ""}" type="button" data-category="${escapeHtml(tab.id)}" aria-pressed="${state.activeCategory === tab.id}">${escapeHtml(tab.name)}</button>`).join("");
}

function filteredProducts() {
  const term = normalizeText(state.search.trim());
  return productList().filter((product) => {
    const categoryMatch = state.activeCategory === "all" || (state.activeCategory === "featured" ? product.featured : product.categoryId === state.activeCategory);
    const haystack = normalizeText(`${product.name} ${product.description} ${product.categoryName}`);
    return product.active && categoryMatch && (!term || haystack.includes(term));
  });
}

function productVisual(product, className = "") {
  const url = safeImageUrl(product.imageUrl);
  return url
    ? `<img class="${className}" data-product-image src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async" />`
    : `<span class="product-placeholder" aria-hidden="true">🍰</span>`;
}

function renderProducts() {
  const products = filteredProducts();
  els.feedback.innerHTML = "";
  els.grid.setAttribute("aria-busy", "false");
  els.grid.innerHTML = products.map((product) => {
    const purchasable = Number.isInteger(product.priceCents);
    return `<article class="product-card ${purchasable ? "" : "is-unavailable"}">
      <button class="product-card__image" type="button" data-open-product="${escapeHtml(product.id)}" aria-label="Ver ${escapeHtml(product.name)}">${product.featured ? `<span class="product-card__badge">Destaque</span>` : ""}${productVisual(product, "product-card__photo")}</button>
      <div class="product-card__body"><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.description)}</p><div class="product-card__footer"><div class="product-card__price"><strong>${purchasable ? money(product.priceCents) : "Indisponível"}</strong><small>${purchasable ? "adicionais à parte" : "preço ainda não cadastrado"}</small></div><button class="product-card__add" type="button" data-open-product="${escapeHtml(product.id)}" ${purchasable ? "" : "disabled"}>${purchasable ? "Escolher +" : "Sem preço"}</button></div></div>
    </article>`;
  }).join("");
  els.empty.hidden = products.length !== 0;
}

function renderOptionGroups(product) {
  els.optionGroups.innerHTML = product.optionGroups.map((group) => {
    const multi = group.maxSelect > 1;
    const inputType = multi ? "checkbox" : "radio";
    const hint = group.required ? `Escolha de ${Math.max(1, group.minSelect)} a ${group.maxSelect}` : `Opcional · até ${group.maxSelect}`;
    return `<fieldset class="option-group" data-option-group="${escapeHtml(group.id)}" data-min="${group.required ? Math.max(1, group.minSelect) : group.minSelect}" data-max="${group.maxSelect}"><legend><span>${escapeHtml(group.name)}</span><small>${escapeHtml(hint)}</small></legend>${group.values.map((value) => `<label class="option-value"><span><input type="${inputType}" name="option-${escapeHtml(group.id)}" value="${escapeHtml(value.id)}" /><b>${escapeHtml(value.name)}</b></span><small>${value.priceDeltaCents ? `+ ${money(value.priceDeltaCents)}` : "sem acréscimo"}</small></label>`).join("")}</fieldset>`;
  }).join("");
}

function selectedOptions({ validate = false } = {}) {
  const product = state.selectedProduct;
  const selections = [];
  if (!product) return selections;
  for (const group of product.optionGroups) {
    const selected = $$(`[name="option-${CSS.escape(group.id)}"]:checked`, els.optionGroups);
    const min = group.required ? Math.max(1, group.minSelect) : group.minSelect;
    if (validate && (selected.length < min || selected.length > group.maxSelect)) {
      throw new Error(`Em “${group.name}”, escolha ${min === group.maxSelect ? min : `de ${min} a ${group.maxSelect}`} opção(ões).`);
    }
    selected.forEach((input) => selections.push({ groupId: group.id, valueId: input.value }));
  }
  return selections;
}

function optionDetails(product, options) {
  return options.map((selection) => {
    const group = product.optionGroups.find((item) => item.id === selection.groupId);
    const value = group?.values.find((item) => item.id === selection.valueId);
    return value ? { ...selection, groupName: group.name, name: value.name, priceDeltaCents: value.priceDeltaCents } : null;
  }).filter(Boolean);
}

function updateProductPrice() {
  const product = state.selectedProduct;
  if (!product || !Number.isInteger(product.priceCents)) return;
  const optionsTotal = optionDetails(product, selectedOptions()).reduce((sum, option) => sum + option.priceDeltaCents, 0);
  els.modalPrice.textContent = money((product.priceCents + optionsTotal) * state.selectedQty);
}

function openProduct(productId) {
  const product = state.products.get(String(productId));
  if (!product || !Number.isInteger(product.priceCents)) return;
  state.selectedProduct = product;
  state.selectedQty = 1;
  els.qtyValue.textContent = "1";
  els.itemNote.value = "";
  setError(els.productError);
  els.modalTitle.textContent = product.name;
  els.modalDescription.textContent = product.description;
  els.modalBadge.hidden = !product.featured;
  els.modalBadge.textContent = product.featured ? "Destaque" : "";
  els.modalImage.innerHTML = productVisual(product, "product-modal__photo");
  els.modalPrice.textContent = money(product.priceCents);
  renderOptionGroups(product);
  showDialog(els.productModal);
}

function totalUnits() {
  return state.cart.reduce((sum, item) => sum + item.quantity, 0);
}

function addSelectedToCart(event) {
  event.preventDefault();
  const product = state.selectedProduct;
  if (!product) return;
  try {
    const options = selectedOptions({ validate: true });
    if (state.cart.length >= MAX_LINES) throw new Error(`O pedido aceita até ${MAX_LINES} itens diferentes.`);
    if (totalUnits() + state.selectedQty > MAX_TOTAL_UNITS) throw new Error(`O pedido aceita até ${MAX_TOTAL_UNITS} unidades.`);
    state.cart.push({ uid: uuid(), productId: product.id, quantity: state.selectedQty, note: els.itemNote.value.trim(), options });
    saveCart(state.cart);
    resetCheckoutAttempt();
    renderCart();
    closeDialog(els.productModal);
    toast("Item adicionado ao carrinho.");
  } catch (error) {
    setError(els.productError, error.message);
  }
}

function cartTotals() {
  let subtotalCents = 0;
  let units = 0;
  let invalid = 0;
  for (const item of state.cart) {
    const product = state.products.get(item.productId);
    units += item.quantity;
    if (!product || !Number.isInteger(product.priceCents)) {
      invalid += 1;
      continue;
    }
    const optionTotal = optionDetails(product, item.options).reduce((sum, option) => sum + option.priceDeltaCents, 0);
    subtotalCents += (product.priceCents + optionTotal) * item.quantity;
  }
  return { subtotalCents, units, invalid };
}

function renderCart() {
  const totals = cartTotals();
  els.cartCount.textContent = String(totals.units);
  els.floatingCart.hidden = totals.units === 0;
  els.floatingCartQty.textContent = `${totals.units} ${totals.units === 1 ? "item" : "itens"}`;
  els.floatingCartTotal.textContent = money(totals.subtotalCents);
  els.cartSubtotal.textContent = money(totals.subtotalCents);
  els.checkoutBtn.disabled = Boolean(checkoutBlockReason(totals));
  if (!state.cart.length) {
    els.cartList.innerHTML = `<div class="empty-state"><div aria-hidden="true">🛒</div><strong>Seu carrinho está vazio.</strong><span>Adicione alguns itens do cardápio.</span></div>`;
  } else {
    els.cartList.innerHTML = state.cart.map((item) => {
      const product = state.products.get(item.productId);
      if (!product) return "";
      const details = optionDetails(product, item.options);
      const optionTotal = details.reduce((sum, option) => sum + option.priceDeltaCents, 0);
      const lineTotal = Number.isInteger(product.priceCents) ? (product.priceCents + optionTotal) * item.quantity : 0;
      return `<article class="cart-item"><div class="cart-item__emoji">${productVisual(product, "cart-item__photo")}</div><div class="cart-item__body"><strong>${item.quantity}× ${escapeHtml(product.name)}</strong><span>${Number.isInteger(product.priceCents) ? money(lineTotal) : "Indisponível"}</span>${details.length ? `<small>${details.map((option) => escapeHtml(option.name)).join(" · ")}</small>` : ""}${item.note ? `<small>Obs.: ${escapeHtml(item.note)}</small>` : ""}<div class="mini-qty"><button type="button" data-cart-qty="minus" data-cart-id="${escapeHtml(item.uid)}" aria-label="Diminuir ${escapeHtml(product.name)}">−</button><span>${item.quantity}</span><button type="button" data-cart-qty="plus" data-cart-id="${escapeHtml(item.uid)}" aria-label="Aumentar ${escapeHtml(product.name)}">+</button></div></div><div class="cart-item__actions"><button type="button" data-remove-item="${escapeHtml(item.uid)}" aria-label="Remover ${escapeHtml(product.name)}">✕</button></div></article>`;
    }).join("");
  }
  renderCheckoutSummary();
}

function changeCartQuantity(uid, delta) {
  const item = state.cart.find((entry) => entry.uid === uid);
  if (!item) return;
  if (delta > 0 && (item.quantity >= MAX_LINE_QUANTITY || totalUnits() >= MAX_TOTAL_UNITS)) {
    toast("Limite de unidades atingido.", "warning");
    return;
  }
  item.quantity += delta;
  if (item.quantity <= 0) state.cart = state.cart.filter((entry) => entry.uid !== uid);
  saveCart(state.cart);
  resetCheckoutAttempt();
  renderCart();
}

function removeCartItem(uid) {
  state.cart = state.cart.filter((item) => item.uid !== uid);
  saveCart(state.cart);
  resetCheckoutAttempt();
  renderCart();
}

function currentFulfillment() {
  return new FormData(els.checkoutForm).get("fulfillmentType") || "";
}

function allowedFulfillmentTypes(catalog = state.catalog) {
  if (!catalog) return [];
  return [
    catalog.acceptsDelivery && catalog.isOpen ? "delivery" : null,
    catalog.acceptsPickup && catalog.isOpen ? "pickup" : null,
    catalog.acceptsScheduledOrders ? "scheduled" : null
  ].filter(Boolean);
}

function checkoutBlockReason(totals = cartTotals()) {
  if (!totals.units) return "Adicione itens ao carrinho antes de continuar.";
  if (totals.invalid) return "Revise os itens indisponíveis do carrinho.";
  if (!state.catalog) return "Aguarde o carregamento do cardápio.";
  if (!allowedFulfillmentTypes().length) return "A loja não está recebendo pedidos neste momento.";
  if (!state.catalog.paymentMethods.length) return "As formas de pagamento ainda não foram configuradas.";
  return "";
}

function configureCheckout() {
  const catalog = state.catalog;
  if (!catalog) return;
  const allowed = {
    delivery: catalog.acceptsDelivery && catalog.isOpen,
    pickup: catalog.acceptsPickup && catalog.isOpen,
    scheduled: catalog.acceptsScheduledOrders
  };
  $$("input[name='fulfillmentType']", els.checkoutForm).forEach((input) => {
    input.disabled = !allowed[input.value];
    input.closest("label").classList.toggle("is-disabled", input.disabled);
  });
  const selected = $("input[name='fulfillmentType']:checked", els.checkoutForm);
  if (!selected || selected.disabled) {
    const first = $$("input[name='fulfillmentType']", els.checkoutForm).find((input) => !input.disabled);
    if (first) first.checked = true;
  }
  els.paymentSelect.innerHTML = catalog.paymentMethods.length
    ? `<option value="">Selecione</option>${catalog.paymentMethods.map((method) => `<option value="${escapeHtml(method.code)}">${escapeHtml(method.label)}</option>`).join("")}`
    : `<option value="">Formas de pagamento pendentes</option>`;
  els.paymentSelect.disabled = catalog.paymentMethods.length === 0;
  syncChangeField();
  setFulfillmentFields();
  els.checkoutBtn.disabled = Boolean(checkoutBlockReason());
}

function resetQuote() {
  state.quote = null;
  state.quoteFingerprint = "";
  els.quoteStatus.textContent = "Informe o bairro para consultar a área de entrega.";
  els.quoteStatus.className = "";
  resetCheckoutAttempt();
  renderCheckoutSummary();
}

function setFulfillmentFields() {
  const type = currentFulfillment();
  const delivery = type === "delivery";
  const scheduled = type === "scheduled";
  els.deliveryFields.hidden = !delivery;
  els.scheduledFields.hidden = !scheduled;
  ["street", "number", "neighborhood"].forEach((name) => { els.checkoutForm.elements[name].required = delivery; });
  els.checkoutForm.elements.scheduledFor.required = scheduled;
  if (!delivery) resetQuote();
  els.checkoutDeliveryFee.textContent = delivery ? "A calcular" : money(0);
  renderCheckoutSummary();
}

function quoteFingerprint() {
  const form = new FormData(els.checkoutForm);
  return `${normalizeText(form.get("neighborhood"))}|${String(form.get("postalCode") || "").replace(/\D/g, "")}`;
}

async function requestQuote() {
  const form = new FormData(els.checkoutForm);
  const neighborhood = String(form.get("neighborhood") || "").trim();
  const postalCode = String(form.get("postalCode") || "").trim();
  if (!neighborhood) {
    els.checkoutForm.elements.neighborhood.focus();
    els.quoteStatus.textContent = "Informe o bairro para calcular a entrega.";
    els.quoteStatus.className = "is-error";
    return;
  }
  const originalLabel = els.quoteBtn.textContent;
  els.quoteBtn.disabled = true;
  els.quoteBtn.setAttribute("aria-busy", "true");
  els.quoteBtn.textContent = "Calculando…";
  els.quoteStatus.textContent = "Consultando área de entrega…";
  els.quoteStatus.className = "";
  try {
    const quote = await api.quoteDelivery({ storeSlug: STORE_SLUG, neighborhood, ...(postalCode ? { postalCode } : {}) });
    state.quote = quote?.available ? quote : null;
    state.quoteFingerprint = quote?.available ? quoteFingerprint() : "";
    if (!quote?.available) throw new Error(quote?.reason || "A entrega ainda não está disponível para este bairro.");
    els.quoteStatus.textContent = `${quote.zoneName || "Região atendida"}: ${money(Number(quote.feeCents || 0))}${quote.minimumOrderCents ? ` · pedido mínimo ${money(quote.minimumOrderCents)}` : ""}`;
    els.quoteStatus.className = "is-success";
  } catch (error) {
    state.quote = null;
    state.quoteFingerprint = "";
    els.quoteStatus.textContent = error.message;
    els.quoteStatus.className = "is-error";
  } finally {
    els.quoteBtn.disabled = false;
    els.quoteBtn.setAttribute("aria-busy", "false");
    els.quoteBtn.textContent = originalLabel;
    renderCheckoutSummary();
  }
}

function renderCheckoutSummary() {
  const totals = cartTotals();
  const isDelivery = currentFulfillment() === "delivery";
  const feeCents = isDelivery && state.quote ? Number(state.quote.feeCents || 0) : 0;
  els.checkoutSubtotal.textContent = money(totals.subtotalCents);
  els.checkoutDeliveryFee.textContent = isDelivery ? (state.quote ? money(feeCents) : "A calcular") : money(0);
  els.checkoutTotal.textContent = money(totals.subtotalCents + feeCents);
}

function openCart() {
  renderCart();
  showDialog(els.cartDrawer);
}

function openCheckout() {
  const reason = checkoutBlockReason();
  if (reason) {
    toast(reason, "warning");
    return;
  }
  closeDialog(els.cartDrawer);
  configureCheckout();
  setError(els.checkoutError);
  showDialog(els.checkoutModal);
}

function decimalToCents(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const normalized = raw.replace(/^R\$\s*/i, "").trim();
  if (!/^\d+(?:[.,]\d+)*$/.test(normalized)) return NaN;

  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");
  let integerPart = normalized;
  let fractionPart = "";

  if (comma >= 0 && dot >= 0) {
    const decimalSeparator = comma > dot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    const decimalIndex = normalized.lastIndexOf(decimalSeparator);
    integerPart = normalized.slice(0, decimalIndex);
    fractionPart = normalized.slice(decimalIndex + 1);
    const integerPattern = new RegExp(`^\\d{1,3}(?:\\${thousandsSeparator}\\d{3})*$`);
    if (!integerPattern.test(integerPart) || !/^\d{1,2}$/.test(fractionPart)) return NaN;
    integerPart = integerPart.replaceAll(thousandsSeparator, "");
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? "," : ".";
    const parts = normalized.split(separator);
    if (parts.length === 2 && /^\d{1,2}$/.test(parts[1])) {
      [integerPart, fractionPart] = parts;
    } else if (parts.length >= 2 && /^\d{1,3}$/.test(parts[0]) && parts.slice(1).every((part) => /^\d{3}$/.test(part))) {
      integerPart = parts.join("");
    } else {
      return NaN;
    }
  }

  const cents = Number(integerPart) * 100 + Number(fractionPart.padEnd(2, "0") || 0);
  return Number.isSafeInteger(cents) ? cents : NaN;
}

function syncChangeField() {
  els.changeField.hidden = els.paymentSelect.value !== "cash";
}

function validateCheckout(form) {
  if (!form.reportValidity()) throw new Error("Revise os campos obrigatórios.");
  const fulfillmentType = currentFulfillment();
  if (!allowedFulfillmentTypes().includes(fulfillmentType)) throw new Error("Selecione uma modalidade de atendimento disponível.");
  if (!state.catalog.paymentMethods.some((method) => method.code === String(new FormData(form).get("paymentMethod")))) throw new Error("Selecione uma forma de pagamento disponibilizada pela loja.");
  const totals = cartTotals();
  if (!state.cart.length || totals.invalid) throw new Error("Revise os itens do carrinho.");
  if (state.catalog.minimumOrderCents && totals.subtotalCents < state.catalog.minimumOrderCents) throw new Error(`O pedido mínimo da loja é ${money(state.catalog.minimumOrderCents)}.`);
  if (currentFulfillment() === "delivery") {
    if (!state.quote || state.quoteFingerprint !== quoteFingerprint()) throw new Error("Calcule novamente a entrega para o bairro informado.");
    if (state.quote.minimumOrderCents && totals.subtotalCents < state.quote.minimumOrderCents) throw new Error(`O pedido mínimo para esta região é ${money(state.quote.minimumOrderCents)}.`);
  }
  const formData = new FormData(form);
  const changeValue = String(formData.get("changeFor") ?? "").trim();
  if (formData.get("paymentMethod") === "cash" && changeValue) {
    const changeForCents = decimalToCents(changeValue);
    if (Number.isNaN(changeForCents)) throw new Error("Informe um valor de troco válido.");
    const deliveryFeeCents = currentFulfillment() === "delivery" ? Number(state.quote?.feeCents || 0) : 0;
    if (changeForCents < totals.subtotalCents + deliveryFeeCents) {
      throw new Error("O valor para troco deve ser igual ou maior que o total.");
    }
  }
}

function checkoutPayload() {
  const form = new FormData(els.checkoutForm);
  const fulfillmentType = String(form.get("fulfillmentType"));
  const paymentMethod = String(form.get("paymentMethod"));
  const changeForCents = paymentMethod === "cash" ? decimalToCents(form.get("changeFor")) : undefined;
  if (Number.isNaN(changeForCents)) throw new Error("Informe um valor de troco válido.");
  const payload = {
    storeSlug: STORE_SLUG,
    fulfillmentType,
    customer: { name: String(form.get("name") || "").trim(), phone: String(form.get("phone") || "").trim() },
    paymentMethod,
    note: String(form.get("note") || "").trim(),
    items: state.cart.map((item) => ({ productId: item.productId, quantity: item.quantity, note: item.note, options: item.options }))
  };
  if (fulfillmentType === "delivery") {
    payload.delivery = {
      postalCode: String(form.get("postalCode") || "").trim() || undefined,
      street: String(form.get("street") || "").trim(),
      number: String(form.get("number") || "").trim(),
      neighborhood: String(form.get("neighborhood") || "").trim(),
      complement: String(form.get("complement") || "").trim() || undefined,
      reference: String(form.get("reference") || "").trim() || undefined,
      zoneId: state.quote.zoneId
    };
  }
  if (fulfillmentType === "scheduled") {
    const scheduled = new Date(String(form.get("scheduledFor") || ""));
    if (Number.isNaN(scheduled.getTime()) || scheduled <= new Date()) throw new Error("Escolha uma data e um horário futuros.");
    payload.scheduledFor = scheduled.toISOString();
  }
  if (changeForCents !== undefined) payload.changeForCents = changeForCents;
  return payload;
}

function resetCheckoutAttempt() {
  state.checkoutKey = null;
}

async function submitCheckout(event) {
  event.preventDefault();
  setError(els.checkoutError);
  try {
    validateCheckout(els.checkoutForm);
    const payload = checkoutPayload();
    state.checkoutKey ||= uuid();
    setButtonBusy(els.submitOrderBtn, true);
    const order = await api.createOrder(payload, state.checkoutKey);
    const tracked = { trackingToken: String(order.trackingToken), orderNumber: String(order.orderNumber), last: order };
    state.trackedOrders = [tracked, ...state.trackedOrders.filter((item) => item.trackingToken !== tracked.trackingToken)].slice(0, 10);
    saveTrackedOrders(state.trackedOrders);
    startTrackingUpdates();
    state.cart = [];
    saveCart(state.cart);
    renderCart();
    closeDialog(els.checkoutModal);
    els.successOrderId.textContent = `Pedido #${order.orderNumber}`;
    els.successOrderTotal.textContent = money(order.totalCents);
    const pixCode = String(order.pix?.copyPaste || "");
    els.successPix.hidden = !pixCode;
    els.pixCopyPaste.value = pixCode;
    els.successOrderStatus.textContent = order.paymentStatus === "pending"
      ? "Aguardando pagamento"
      : order.paymentStatus === "pay_on_delivery"
        ? "Pagamento no recebimento"
        : STATUS_LABELS[order.status] || "Pedido recebido / aguardando confirmação";
    showDialog(els.successModal);
    els.checkoutForm.reset();
    state.quote = null;
    resetCheckoutAttempt();
    configureCheckout();
  } catch (error) {
    setError(els.checkoutError, error.message);
    els.checkoutError.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } finally {
    setButtonBusy(els.submitOrderBtn, false);
  }
}

function normalizeTracking(payload) {
  return {
    orderNumber: payload.orderNumber || payload.order_number || "Pedido",
    status: payload.status || "pending",
    fulfillmentType: payload.fulfillmentType || payload.fulfillment_type || "",
    paymentMethod: payload.paymentMethod || payload.payment_method || "",
    paymentStatus: payload.paymentStatus || payload.payment_status || "",
    totalCents: Number(payload.totalCents ?? payload.total_cents ?? 0)
  };
}

function orderStatusMessage(order) {
  const messages = {
    pending: "Recebemos seu pedido e aguardamos a confirmação da loja.",
    confirmed: order.fulfillmentType === "delivery"
      ? "Seu pedido foi confirmado e seguirá para entrega."
      : "Seu pedido foi confirmado. Avisaremos quando estiver pronto.",
    preparing: "Seu pedido está sendo preparado.",
    ready: order.fulfillmentType === "delivery"
      ? "Seu pedido está pronto e seguirá para entrega."
      : "Seu pedido está pronto para retirada.",
    out_for_delivery: "Seu pedido saiu para entrega.",
    completed: "Seu pedido foi concluído.",
    cancelled: "Este pedido foi cancelado."
  };
  return messages[order.status] || "Consulte a loja para saber mais sobre este pedido.";
}

function renderTrackedOrders() {
  if (!state.trackedOrders.length) {
    els.ordersList.innerHTML = `<div class="empty-state"><div aria-hidden="true">🧾</div><strong>Nenhum pedido nesta sessão.</strong><span>Depois de finalizar, o acompanhamento aparece aqui.</span></div>`;
    return;
  }
  els.ordersList.innerHTML = state.trackedOrders.map((entry) => {
    const order = entry.last ? normalizeTracking(entry.last) : null;
    if (entry.error) return `<article class="order-track-card"><div class="order-track-card__top"><strong>Pedido #${escapeHtml(entry.orderNumber || "—")}</strong><span class="order-status">Indisponível</span></div><p>${escapeHtml(entry.error)}</p></article>`;
    if (!order) return `<article class="order-track-card skeleton-order" aria-label="Carregando pedido"><span class="skeleton skeleton--title"></span><span class="skeleton skeleton--text"></span></article>`;
    return `<article class="order-track-card"><div class="order-track-card__top"><strong>Pedido #${escapeHtml(order.orderNumber)}</strong><span class="order-status status--${escapeHtml(order.status)}">${escapeHtml(STATUS_LABELS[order.status] || "Status atualizado")}</span></div><p>${escapeHtml(orderStatusMessage(order))}</p><p><strong>${escapeHtml(PAYMENT_LABELS[order.paymentMethod] || order.paymentMethod)}</strong> · ${escapeHtml(PAYMENT_STATUS_LABELS[order.paymentStatus] || order.paymentStatus)}</p><div class="order-track-card__bottom"><span>Total</span><strong>${money(order.totalCents)}</strong></div></article>`;
  }).join("");
}

async function refreshTrackedOrder(token, { silent = false } = {}) {
  const entry = state.trackedOrders.find((item) => item.trackingToken === token);
  if (!entry) return;
  try {
    entry.last = normalizeTracking(await api.trackOrder(token));
    entry.orderNumber = entry.last.orderNumber;
    delete entry.error;
  } catch (error) {
    if (!silent) entry.error = error.message;
  }
  saveTrackedOrders(state.trackedOrders);
  renderTrackedOrders();
  if (TERMINAL_STATUSES.has(entry.last?.status)) {
    state.trackingStreams.get(token)?.close();
    state.trackingStreams.delete(token);
  }
}

async function refreshAllTrackedOrders({ silent = false } = {}) {
  const activeOrders = state.trackedOrders.filter((entry) => !TERMINAL_STATUSES.has(entry.last?.status));
  await Promise.all(activeOrders.map((entry) => refreshTrackedOrder(entry.trackingToken, { silent })));
}

function stopTrackingUpdates() {
  window.clearInterval(state.trackingPoll);
  state.trackingPoll = null;
  for (const stream of state.trackingStreams.values()) stream.close();
  state.trackingStreams.clear();
}

function syncTrackingStreams() {
  const activeTokens = new Set(
    state.trackedOrders
      .filter((entry) => !TERMINAL_STATUSES.has(entry.last?.status))
      .slice(0, 3)
      .map((entry) => entry.trackingToken)
  );
  for (const [token, stream] of state.trackingStreams) {
    if (!activeTokens.has(token)) {
      stream.close();
      state.trackingStreams.delete(token);
    }
  }
  for (const token of activeTokens) {
    if (state.trackingStreams.has(token)) continue;
    const stream = openApiEventStream(`/public/orders/${encodeURIComponent(token)}/events`, {
      message: () => refreshTrackedOrder(token, { silent: true }),
      error: () => {
        // EventSource reconecta automaticamente; polling permanece como fallback.
      }
    });
    if (stream) state.trackingStreams.set(token, stream);
  }
}

function startTrackingUpdates() {
  stopTrackingUpdates();
  refreshAllTrackedOrders();
  state.trackingPoll = window.setInterval(() => {
    if (els.ordersDrawer.open && !document.hidden) refreshAllTrackedOrders({ silent: true });
  }, TRACKING_POLL_INTERVAL_MS);
  syncTrackingStreams();
}

function openOrders() {
  renderTrackedOrders();
  showDialog(els.ordersDrawer);
  startTrackingUpdates();
}

function wireEvents() {
  document.addEventListener("error", (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.matches("[data-product-image]")) return;
    const placeholder = document.createElement("span");
    placeholder.className = "product-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.textContent = "🍰";
    image.replaceWith(placeholder);
  }, true);
  els.feedback.addEventListener("click", (event) => { if (event.target.closest("[data-retry-catalog]")) loadCatalog(); });
  els.tabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    state.activeCategory = button.dataset.category;
    renderTabs();
    renderProducts();
  });
  els.grid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-product]");
    if (button) openProduct(button.dataset.openProduct);
  });
  els.search.addEventListener("input", (event) => { state.search = event.target.value; renderProducts(); });
  els.productClose.addEventListener("click", () => closeDialog(els.productModal));
  els.productForm.addEventListener("submit", addSelectedToCart);
  els.optionGroups.addEventListener("change", (event) => {
    const fieldset = event.target.closest("[data-option-group]");
    if (event.target.type === "checkbox" && fieldset) {
      const checked = $$("input:checked", fieldset);
      if (checked.length > Number(fieldset.dataset.max)) {
        event.target.checked = false;
        toast(`Escolha no máximo ${fieldset.dataset.max} opção(ões).`, "warning");
      }
    }
    setError(els.productError);
    updateProductPrice();
  });
  els.qtyMinus.addEventListener("click", () => { state.selectedQty = Math.max(1, state.selectedQty - 1); els.qtyValue.textContent = state.selectedQty; updateProductPrice(); });
  els.qtyPlus.addEventListener("click", () => { state.selectedQty = Math.min(MAX_LINE_QUANTITY, state.selectedQty + 1); els.qtyValue.textContent = state.selectedQty; updateProductPrice(); });
  $$(".cart-trigger").forEach((button) => button.addEventListener("click", openCart));
  $$('[data-close-dialog="cartDrawer"]').forEach((button) => button.addEventListener("click", () => closeDialog(els.cartDrawer)));
  els.cartList.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-item]");
    const quantity = event.target.closest("[data-cart-qty]");
    if (remove) removeCartItem(remove.dataset.removeItem);
    if (quantity) changeCartQuantity(quantity.dataset.cartId, quantity.dataset.cartQty === "plus" ? 1 : -1);
  });
  els.checkoutBtn.addEventListener("click", openCheckout);
  els.checkoutClose.addEventListener("click", () => closeDialog(els.checkoutModal));
  els.checkoutForm.addEventListener("change", (event) => {
    resetCheckoutAttempt();
    if (event.target.name === "fulfillmentType") setFulfillmentFields();
    if (event.target.name === "paymentMethod") syncChangeField();
  });
  els.checkoutForm.addEventListener("input", (event) => {
    resetCheckoutAttempt();
    if (["neighborhood", "postalCode"].includes(event.target.name) && state.quoteFingerprint && state.quoteFingerprint !== quoteFingerprint()) resetQuote();
  });
  els.quoteBtn.addEventListener("click", requestQuote);
  els.checkoutForm.addEventListener("submit", submitCheckout);
  els.ordersBtn.addEventListener("click", openOrders);
  els.heroOrdersBtn.addEventListener("click", openOrders);
  els.ordersClose.addEventListener("click", () => { closeDialog(els.ordersDrawer); stopTrackingUpdates(); });
  els.ordersDrawer.addEventListener("close", stopTrackingUpdates);
  els.viewOrdersBtn.addEventListener("click", () => { closeDialog(els.successModal); openOrders(); });
  els.copyPixBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(els.pixCopyPaste.value);
      toast("Código Pix copiado.");
    } catch {
      els.pixCopyPaste.select();
      document.execCommand("copy");
      toast("Código Pix copiado.");
    }
  });
  els.successCloseBtn.addEventListener("click", () => { closeDialog(els.successModal); document.querySelector("#cardapio").scrollIntoView({ behavior: "smooth" }); });
  els.showOrdersCategory.addEventListener("click", () => {
    const category = scheduledOrderCategory();
    if (category) {
      state.activeCategory = category.id;
      state.search = "";
      els.search.value = "";
      renderTabs();
      renderProducts();
      document.querySelector("#cardapio").scrollIntoView({ behavior: "smooth" });
    } else {
      toast("A categoria de encomendas ainda não foi cadastrada.", "warning");
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && els.ordersDrawer.open) refreshAllTrackedOrders({ silent: true });
  });
}

wireEvents();
renderCatalogSkeleton();
renderCart();
renderTrackedOrders();
loadCatalog();
if (state.trackedOrders.length) startTrackingUpdates();
