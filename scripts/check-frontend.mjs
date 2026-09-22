import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [path.join(root, "assets", "js"), path.join(root, "admin")];
const files = [];
const requiredPages = [
  "index.html",
  "admin/login/index.html",
  "admin/pedidos/index.html",
  "admin/cardapio/index.html",
  "admin/categorias/index.html",
  "admin/entregas/index.html",
  "admin/configuracoes/index.html"
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function stringArrayConstant(source, name) {
  const value = source.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\[[^;]+\\])`))?.[1];
  if (!value) fail(`Constante ${name} ausente.`);
  try { return JSON.parse(value); }
  catch { fail(`Constante ${name} deve ser um array literal simples.`); }
}

function functionBlock(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  if (start < 0 || end < 0) fail(`Função ${name} ausente ou fora da ordem esperada.`);
  return source.slice(start, end);
}

function collect(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith(".js")) files.push(full);
  }
}

for (const directory of roots) collect(directory);

for (const page of requiredPages) {
  if (!fs.existsSync(path.join(root, page))) fail(`Página obrigatória ausente: ${page}`);
}

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}

const htmlFiles = requiredPages.map((page) => path.join(root, page));
const browserFiles = [...files, ...htmlFiles];
const forbiddenPatterns = [
  ["cliente Supabase direto", /\bcreateClient\s*\(/],
  ["URL direta do Supabase", /https?:\/\/[^\s"']*\.supabase\.co/i],
  ["service_role", /\bservice_role\b/i],
  ["segredo Supabase", /\bsb_secret_/i],
  ["nome de segredo Supabase", /\bSUPABASE_SECRET_KEY\b/],
  ["URL PostgreSQL", /\bpostgres(?:ql)?:\/\//i],
  ["nome de JWT secret", /\bJWT_SECRET\b/],
  ["source map público", /sourceMappingURL\s*=/i]
];

for (const file of browserFiles) {
  const source = fs.readFileSync(file, "utf8");
  for (const [label, pattern] of forbiddenPatterns) {
    if (pattern.test(source)) fail(`${label} encontrado no frontend: ${path.relative(root, file)}`);
  }
  if (file.endsWith(".js") && path.basename(file) !== "api-client.js" && /\bfetch\s*\(/.test(source)) {
    fail(`fetch fora do cliente HTTP único: ${path.relative(root, file)}`);
  }
}

for (const file of htmlFiles) {
  const source = fs.readFileSync(file, "utf8");
  const errorElements = source.match(/<p\b[^>]*class="[^"]*\bform-error\b[^"]*"[^>]*>/g) ?? [];
  for (const element of errorElements) {
    if (!/\brole="alert"/.test(element)) {
      fail(`Mensagem de formulário sem role=alert: ${path.relative(root, file)}`);
    }
  }
  if (file.includes(`${path.sep}admin${path.sep}`) && !/<meta\s+name=["']viewport["'][^>]*width=device-width/i.test(source)) {
    fail(`Página administrativa sem viewport responsiva: ${path.relative(root, file)}`);
  }
}

const loginHtml = fs.readFileSync(path.join(root, "admin", "login", "index.html"), "utf8");
const loginForm = loginHtml.match(/<form\b[^>]*\bid=["']loginForm["'][^>]*>/i)?.[0];
if (!loginForm || !/\bmethod=["']post["']/i.test(loginForm)) {
  fail("O formulário de login deve usar POST mesmo sem JavaScript.");
}
if (!/\baction=["']\/api\/admin\/auth\/login["']/i.test(loginForm)) {
  fail("O fallback do login deve apontar para a API same-origin.");
}
if (/\bformmethod=["']get["']/i.test(loginHtml)) {
  fail("O login não pode permitir envio de credenciais por query string.");
}
if (/A sessão usa cookie seguro|token administrativo não são armazenados/i.test(loginHtml)) {
  fail("O banner técnico não deve aparecer na tela de login.");
}
if (!/id=["']passwordToggle["'][^>]*aria-label=["']Mostrar senha["']/i.test(loginHtml)) {
  fail("O login deve ter botão próprio para mostrar a senha.");
}

const apiClient = fs.readFileSync(path.join(root, "assets", "js", "api-client.js"), "utf8");
if (!/const API_BASE\s*=\s*["']\/api["']/.test(apiClient)) fail("O cliente HTTP deve usar apenas a base /api.");
if (!apiClient.includes('"X-Store-Slug"')) fail("Requisições administrativas devem informar X-Store-Slug.");

const publicApp = fs.readFileSync(path.join(root, "assets", "js", "app.js"), "utf8");
const publicHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const storagePolicy = fs.readFileSync(path.join(root, "assets", "js", "browser-storage-policy.js"), "utf8");
if (!publicApp.includes("item?.method")) fail("O catálogo deve aceitar paymentMethods[].method.");
const pollInterval = publicApp.match(/TRACKING_POLL_INTERVAL_MS\s*=\s*([\d_]+)/)?.[1]?.replaceAll("_", "");
if (!pollInterval || Number(pollInterval) < 60_000) fail("O polling de tracking deve respeitar o limite público da rota.");

const { reconcileCartItems } = await import("../assets/js/cart-reconciliation.js");
const requiredGroup = {
  id: "required-group",
  required: true,
  minSelect: 1,
  maxSelect: 1,
  values: [{ id: "required-value" }]
};
const optionalGroup = {
  id: "optional-group",
  required: false,
  minSelect: 0,
  maxSelect: 1,
  values: [{ id: "optional-value" }, { id: "optional-value-2" }]
};
const cartProduct = {
  id: "product-1",
  active: true,
  priceCents: 1_000,
  optionGroups: [requiredGroup, optionalGroup]
};
const cartProducts = new Map([[cartProduct.id, cartProduct]]);
const validCartLine = {
  uid: "line-1",
  productId: cartProduct.id,
  quantity: 2,
  note: "",
  options: [
    { groupId: requiredGroup.id, valueId: "required-value" },
    { groupId: optionalGroup.id, valueId: "optional-value" }
  ]
};
const reconcile = (cart) => reconcileCartItems(cart, cartProducts, {
  maxLineQuantity: 50,
  createUid: () => "generated-line"
});

const decimalQuantity = reconcile([{ ...validCartLine, quantity: 2.8 }]);
if (decimalQuantity.cart[0]?.quantity !== 2 || !decimalQuantity.changed) {
  fail("Quantidade decimal salva deve ser normalizada para um inteiro.");
}
const excessiveQuantity = reconcile([{ ...validCartLine, quantity: 500 }]);
if (excessiveQuantity.cart[0]?.quantity !== 50 || !excessiveQuantity.changed) {
  fail("Quantidade salva acima do máximo deve ser limitada.");
}
for (const invalidQuantity of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, "não é número"]) {
  if (reconcile([{ ...validCartLine, quantity: invalidQuantity }]).cart.length) {
    fail(`Quantidade inválida não pode permanecer no carrinho: ${String(invalidQuantity)}.`);
  }
}
for (const [label, line] of [
  ["opção inexistente", { ...validCartLine, options: [{ groupId: requiredGroup.id, valueId: "missing-value" }] }],
  ["valueId de outro grupo", { ...validCartLine, options: [{ groupId: requiredGroup.id, valueId: "optional-value" }] }],
  ["grupo obrigatório sem seleção", { ...validCartLine, options: [] }],
  ["seleção acima de maxSelect", { ...validCartLine, options: [
    { groupId: requiredGroup.id, valueId: "required-value" },
    { groupId: optionalGroup.id, valueId: "optional-value" },
    { groupId: optionalGroup.id, valueId: "optional-value-2" }
  ] }],
  ["valueId duplicado", { ...validCartLine, options: [
    { groupId: requiredGroup.id, valueId: "required-value" },
    { groupId: requiredGroup.id, valueId: "required-value" }
  ] }]
]) {
  const result = reconcile([line]);
  if (result.cart.length || !result.changed) fail(`${label} deve invalidar somente a linha afetada.`);
}
const validCart = reconcile([validCartLine]);
if (validCart.changed || JSON.stringify(validCart.cart) !== JSON.stringify([validCartLine])) {
  fail("Carrinho válido deve continuar intacto após a reconciliação.");
}
const reconcileBlock = functionBlock(publicApp, "reconcileCart", "renderTabs");
const cartChangeMessage = "Alguns itens do carrinho foram atualizados ou removidos porque o cardápio mudou.";
if ((reconcileBlock.match(/toast\(/g) || []).length !== 1 || !reconcileBlock.includes(cartChangeMessage)) {
  fail("A reconciliação deve emitir uma única mensagem amigável de alteração.");
}
if (reconcileBlock.indexOf("saveCart(state.cart)") > reconcileBlock.indexOf("toast(")) {
  fail("O carrinho reconciliado deve ser salvo antes da mensagem de alteração.");
}
for (const legacyName of ["saveTemporaryTrackingToken", "getTemporaryTrackingToken", "clearTemporaryTrackingToken"]) {
  if (storagePolicy.includes(legacyName)) fail(`Função legada de tracking ainda existe: ${legacyName}.`);
}

const adminApp = fs.readFileSync(path.join(root, "assets", "js", "admin.js"), "utf8");
const productsAdminHtml = fs.readFileSync(path.join(root, "admin", "cardapio", "index.html"), "utf8");
const activeStatusFlow = stringArrayConstant(adminApp, "ACTIVE_STATUS_FLOW");
const completeStatusFlow = stringArrayConstant(adminApp, "STATUS_FLOW");
const expectedActiveStatuses = ["pending", "confirmed", "preparing", "ready", "out_for_delivery", "completed"];
if (JSON.stringify(activeStatusFlow) !== JSON.stringify(expectedActiveStatuses)) {
  fail("O modo de pedidos ativos deve conter os status operacionais até concluído, sem cancelados.");
}
if (JSON.stringify(completeStatusFlow) !== JSON.stringify([...expectedActiveStatuses, "cancelled"])) {
  fail("O modo de pedidos recentes deve permitir todos os status operacionais.");
}
const visibleFlow = functionBlock(adminApp, "visibleStatusFlow", "primaryOrderAction");
if (!/value\s*===\s*["']all["']\s*\?\s*STATUS_FLOW\s*:\s*ACTIVE_STATUS_FLOW/.test(visibleFlow)) {
  fail("As colunas do Kanban devem respeitar o filtro active/all.");
}
const orderCard = functionBlock(adminApp, "renderOrderCard", "renderOrders");
if (!/showNotes\s*&&\s*order\.note\.trim\(\)/.test(orderCard) || !/escapeHtml\(order\.note\.trim\(\)\)/.test(orderCard)) {
  fail("A observação geral ativa deve ser exibida completa e escapada no card.");
}
if (!/filter\(\(item\)\s*=>\s*item\.note\.trim\(\)\)/.test(orderCard) || !/escapeHtml\(item\.name\)/.test(orderCard) || !/escapeHtml\(item\.note\.trim\(\)\)/.test(orderCard)) {
  fail("Observações de itens ativos devem ser filtradas e escapadas no card.");
}
if (!/const\s+terminal\s*=\s*\[["']completed["'],\s*["']cancelled["']\]\.includes\(order\.status\)/.test(orderCard) || !/const\s+showNotes\s*=\s*!terminal/.test(orderCard) || !/const\s+generalNote\s*=\s*showNotes/.test(orderCard) || !/const\s+itemNotes\s*=\s*showNotes/.test(orderCard)) {
  fail("Pedidos concluídos ou cancelados não devem exibir observações no card.");
}
if (!/const\s+canCancel\s*=\s*!terminal/.test(orderCard) || !/canCancel\s*\?\s*`<button[^`]*>Cancelar pedido<\/button>`/.test(orderCard) || /\bactive\b/.test(orderCard)) {
  fail("Somente pedidos não terminais devem exibir a ação de cancelar, sem referência à variável active.");
}
const statusUpdate = adminApp.slice(
  adminApp.indexOf("async function updateOrderStatus"),
  adminApp.indexOf("async function confirmPix")
);
if (!/showHistory\s*=\s*status\s*===\s*["']cancelled["']/.test(statusUpdate) || !/if\s*\(showHistory\)\s*\$\(["']#orderWindow["']\)\.value\s*=\s*["']all["']/.test(statusUpdate)) {
  fail("Somente cancelar deve alternar automaticamente o filtro para todos os recentes.");
}
const orderDetails = functionBlock(adminApp, "openOrderDetails", "initOrders");
if (!/escapeHtml\(order\.note\)/.test(orderDetails) || !/escapeHtml\(item\.note\)/.test(orderDetails)) {
  fail("Os detalhes devem continuar exibindo observações gerais e dos itens.");
}
for (const contract of ["storeSlug: STORE_SLUG", "exceptionDate:", "isClosed:", "scheduledMinLeadMinutes", "scheduledMaxAdvanceDays"]) {
  if (!adminApp.includes(contract)) fail(`Contrato administrativo ausente: ${contract}`);
}
if (/return\s+\{[^\n]*openTime:\s*closed\s*\?\s*null/.test(adminApp)) {
  fail("Dias fechados não devem enviar horários nulos.");
}
if (!adminApp.includes('openApiEventStream("/admin/events"')) {
  fail("O painel deve consumir a stream administrativa pelo backend.");
}
if (!adminApp.includes("message: () => loadOrders({ quiet: true })")) {
  fail("Eventos administrativos devem atualizar os pedidos sem refresh manual.");
}
if (!adminApp.includes("ORDER_FALLBACK_POLL_MS = 60_000")) {
  fail("O polling administrativo deve existir apenas como fallback conservador.");
}
if (!adminApp.includes("newOrdersBadge")) {
  fail("O painel deve exibir o contador de novos pedidos.");
}
if (!adminApp.includes("function primaryOrderAction(order)") || adminApp.includes("NEXT_STATUS")) {
  fail("O painel deve calcular uma única progressão conforme a modalidade do pedido.");
}
if (
  !adminApp.includes("Crie uma categoria antes de cadastrar seu primeiro produto.") ||
  !adminApp.includes('href="/admin/categorias/"') ||
  !productsAdminHtml.includes('id="newProduct" disabled') ||
  !adminApp.includes("if (!categories.length)") ||
  !adminApp.includes("await api.ensureInitialStoreData()") ||
  !apiClient.includes('jsonRequest("/admin/store/initial-data", "POST", {})')
) {
  fail("O cardápio sem categorias deve bloquear o produto e orientar a criação da categoria.");
}
if (!adminApp.includes("uploadProductImage") || !apiClient.includes("/admin/uploads/product-images")) {
  fail("O upload administrativo de imagens deve passar exclusivamente pela API.");
}
if (!adminApp.includes("selection.removeAllRanges()")) {
  fail("O painel deve limpar seleções acidentais fora de conteúdo copiável.");
}
if (
  !adminApp.includes('password.type = visible ? "password" : "text"') ||
  !adminApp.includes('visible ? "Mostrar senha" : "Ocultar senha"')
) {
  fail("O botão de senha deve alternar tipo e rótulo acessível sem recriar o campo.");
}
if (!adminApp.includes("Confirmar Pix recebido") || !apiClient.includes("/payment/confirm-pix")) {
  fail("O painel deve confirmar Pix exclusivamente pela rota administrativa.");
}

const adminCss = fs.readFileSync(path.join(root, "assets", "css", "admin.css"), "utf8");
if (!adminCss.includes("user-select: none") || !adminCss.includes(".order-card__number") || !adminCss.includes("user-select: text")) {
  fail("A política de seleção do painel deve preservar dados copiáveis.");
}
if (!/@media\s*\(min-width:\s*1020px\)[\s\S]*?\.admin-shell\s*\{[^}]*grid-template-columns:\s*220px\s+minmax\(0,\s*1fr\)/.test(adminCss)) {
  fail("O grid desktop deve reservar 220px e permitir que o conteúdo principal encolha.");
}
if (!/\.admin-main\s*\{[^}]*min-width:\s*0/.test(adminCss)) {
  fail("O conteúdo principal deve permitir encolhimento dentro do grid.");
}
if (!/\.kanban-wrap\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/.test(adminCss)) {
  fail("O scroll horizontal deve ficar contido no Kanban.");
}
if (!/\.kanban-column\s*\{[^}]*width:\s*min\(88vw,\s*330px\)[^}]*scroll-snap-align:\s*start/.test(adminCss)) {
  fail("O Kanban mobile deve usar colunas largas horizontais com scroll-snap.");
}
const noteStyles = [
  adminCss.match(/\.order-card__note\s*\{([^}]*)\}/)?.[1] ?? "",
  adminCss.match(/\.order-card__note p,\s*\.order-card__note ul\s*\{([^}]*)\}/)?.[1] ?? "",
].join("\n");
if (!/overflow-wrap:\s*anywhere/.test(noteStyles) || /(?:line-clamp|text-overflow:\s*ellipsis)/.test(noteStyles)) {
  fail("Observações no card devem quebrar linha sem truncamento.");
}
if (!/@media\s*\(min-width:\s*600px\)\s*and\s*\(max-width:\s*1019px\)[\s\S]*?\.kanban-column\s*\{[^}]*width:\s*320px/.test(adminCss)) {
  fail("O painel deve ter um comportamento intermediário específico para tablets.");
}
const kanbanRule = adminCss.match(/\.kanban\s*\{([^}]*)\}/)?.[1] ?? "";
if (/grid-template-columns:\s*repeat\(/.test(kanbanRule)) {
  fail("O Kanban não pode impor todas as colunas simultaneamente à viewport.");
}
for (const selector of ["admin-shell", "admin-main"]) {
  const rule = adminCss.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  if (/min-width:\s*\d+px/.test(rule)) fail(`${selector} não pode impor largura mínima de desktop.`);
}

if (!publicApp.includes("function orderStatusMessage(order)")) {
  fail("O pedido público deve apresentar uma mensagem simples para o status atual.");
}
const decimalParser = functionBlock(publicApp, "decimalToCents", "syncChangeField");
const parseCents = new Function(`${decimalParser}; return decimalToCents;`)();
for (const [value, expected] of [["50", 5000], ["50,00", 5000], ["50.00", 5000], ["R$ 50,00", 5000], ["1.000,50", 100050], ["1,000.50", 100050]]) {
  if (parseCents(value) !== expected) fail(`Parser de troco incorreto para ${value}.`);
}
for (const value of ["sem número", "-50", "1,2,3", "5 0"]) {
  if (!Number.isNaN(parseCents(value))) fail(`Parser de troco aceitou formato inválido: ${value}.`);
}
if (!publicApp.includes('throw new Error("O valor para troco deve ser igual ou maior que o total.")')) {
  fail("O checkout deve validar o troco contra o total conhecido.");
}
const checkoutSetup = functionBlock(publicApp, "configureCheckout", "resetQuote");
if (!checkoutSetup.includes("syncChangeField()") || !/changeField\.hidden\s*=\s*els\.paymentSelect\.value\s*!==\s*["']cash["']/.test(publicApp)) {
  fail("O campo de troco deve acompanhar a forma de pagamento após configuração e reset.");
}
if (!/id=["']scheduledOrderCta["'][^>]*\bhidden\b/.test(publicHtml)) {
  fail("O CTA de encomendas deve iniciar oculto.");
}
if (!/scheduledOrderCta\.hidden\s*=\s*!\(catalog\.acceptsScheduledOrders\s*&&\s*scheduledOrderCategory\(catalog\)\)/.test(publicApp) || !/normalizeText\(`\$\{item\.name\}\s+\$\{item\.slug\}`\)\.includes\(["']encomenda["']\)/.test(publicApp)) {
  fail("O CTA deve aparecer somente com agendamento e categoria de encomendas.");
}
if (publicApp.includes("orderTimeline") || publicApp.includes("trackingForm")) {
  fail("A interface pública não deve manter timeline nem formulário manual de tracking.");
}
if (/trackingToken|Código de acompanhamento|Cole o código/i.test(publicHtml)) {
  fail("A interface pública não deve expor token ou código manual de tracking.");
}
const submitCheckoutBlock = functionBlock(publicApp, "submitCheckout", "normalizeTracking");
if (
  submitCheckoutBlock.includes("saveTrackedOrders") ||
  /(?:localStorage|sessionStorage)\.(?:setItem|getItem)/.test(submitCheckoutBlock)
) {
  fail("Pedido novo não pode persistir trackingToken em Web Storage.");
}
if (!publicApp.includes("saveTrackedOrders(state.legacyTrackedOrders)")) {
  fail("sessionStorage deve permanecer restrito à compatibilidade de pedidos legados.");
}
if (/localStorage\.(?:getItem|setItem)\(TRACKING_KEY/.test(storagePolicy)) {
  fail("Tracking token não pode ser persistido em localStorage.");
}
if (!apiClient.includes("getMyOrders(storeSlug)") || !apiClient.includes("/public/my-orders?storeSlug=")) {
  fail("Meus pedidos deve carregar pela API persistente.");
}
if (!publicApp.includes("Carregando seus pedidos…") || !publicApp.includes("api.getMyOrders(STORE_SLUG)")) {
  fail("Meus pedidos deve exibir carregamento antes de consultar a API.");
}
if (!publicApp.includes("window.setInterval") || !publicApp.includes("TRACKING_POLL_INTERVAL_MS")) {
  fail("O polling conservador deve permanecer como fallback.");
}
if (
  !publicApp.includes("/public/my-orders/events?storeSlug=") ||
  !publicApp.includes("message: () => refreshAllTrackedOrders({ silent: true })") ||
  publicApp.includes("openApiEventStream(`/public/orders/${encodeURIComponent(token)}/events`")
) {
  fail("O tracking deve usar uma única stream SSE vinculada à sessão pública.");
}
if (!apiClient.includes("new EventSource(apiUrl(path)")) {
  fail("As streams devem usar somente endpoints /api do backend.");
}
if (!apiClient.includes("EventSource reconecta automaticamente")) {
  fail("A stream deve preservar a reconexão automática do EventSource.");
}

const requiredAdminPages = ["login", "pedidos", "cardapio", "categorias", "entregas", "configuracoes"];
for (const page of requiredAdminPages) {
  if (!fs.existsSync(path.join(root, "admin", page, "index.html"))) {
    fail(`Página administrativa ausente: /admin/${page}`);
  }
}

for (const file of htmlFiles.filter((file) => file.includes(`${path.sep}admin${path.sep}`))) {
  if (!fs.readFileSync(file, "utf8").includes("data-store-slug=")) {
    fail(`Página administrativa sem contexto de loja: ${path.relative(root, file)}`);
  }
}

if (fs.existsSync(path.join(root, "assets", "js", "products.js"))) {
  fail("O mock legado products.js não pode ser publicado.");
}

console.log(`${files.length} JavaScript(s) e ${htmlFiles.length} página(s) verificados.`);
