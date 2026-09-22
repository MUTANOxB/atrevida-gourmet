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
if (!publicApp.includes("item?.method")) fail("O catálogo deve aceitar paymentMethods[].method.");
const pollInterval = publicApp.match(/TRACKING_POLL_INTERVAL_MS\s*=\s*([\d_]+)/)?.[1]?.replaceAll("_", "");
if (!pollInterval || Number(pollInterval) < 60_000) fail("O polling de tracking deve respeitar o limite público da rota.");

const adminApp = fs.readFileSync(path.join(root, "assets", "js", "admin.js"), "utf8");
const productsAdminHtml = fs.readFileSync(path.join(root, "admin", "cardapio", "index.html"), "utf8");
const activeStatusFlow = stringArrayConstant(adminApp, "ACTIVE_STATUS_FLOW");
const completeStatusFlow = stringArrayConstant(adminApp, "STATUS_FLOW");
const expectedActiveStatuses = ["pending", "confirmed", "preparing", "ready", "out_for_delivery"];
if (JSON.stringify(activeStatusFlow) !== JSON.stringify(expectedActiveStatuses)) {
  fail("O modo de pedidos ativos deve conter somente os cinco status operacionais ativos.");
}
if (JSON.stringify(completeStatusFlow) !== JSON.stringify([...expectedActiveStatuses, "completed", "cancelled"])) {
  fail("O modo de pedidos recentes deve permitir todos os status operacionais.");
}
const visibleFlow = functionBlock(adminApp, "visibleStatusFlow", "primaryOrderAction");
if (!/value\s*===\s*["']all["']\s*\?\s*STATUS_FLOW\s*:\s*ACTIVE_STATUS_FLOW/.test(visibleFlow)) {
  fail("As colunas do Kanban devem respeitar o filtro active/all.");
}
const orderCard = functionBlock(adminApp, "renderOrderCard", "renderOrders");
if (!/active\s*&&\s*order\.note\.trim\(\)/.test(orderCard) || !/escapeHtml\(order\.note\.trim\(\)\)/.test(orderCard)) {
  fail("A observação geral ativa deve ser exibida completa e escapada no card.");
}
if (!/filter\(\(item\)\s*=>\s*item\.note\.trim\(\)\)/.test(orderCard) || !/escapeHtml\(item\.name\)/.test(orderCard) || !/escapeHtml\(item\.note\.trim\(\)\)/.test(orderCard)) {
  fail("Observações de itens ativos devem ser filtradas e escapadas no card.");
}
if (!/const\s+active\s*=\s*ACTIVE_STATUS_FLOW\.includes\(order\.status\)/.test(orderCard) || !/const\s+generalNote\s*=\s*active/.test(orderCard) || !/const\s+itemNotes\s*=\s*active/.test(orderCard)) {
  fail("Pedidos concluídos ou cancelados não devem exibir observações no card.");
}
const statusUpdate = adminApp.slice(
  adminApp.indexOf("async function updateOrderStatus"),
  adminApp.indexOf("async function confirmPix")
);
if (!/\[["']completed["'],\s*["']cancelled["']\]\.includes\(status\)/.test(statusUpdate) || !/orderWindow["']\)\.value\s*=\s*["']all["']/.test(statusUpdate)) {
  fail("Concluir ou cancelar deve alternar automaticamente o filtro para todos os recentes.");
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
if (publicApp.includes("orderTimeline") || publicApp.includes("trackingForm")) {
  fail("A interface pública não deve manter timeline nem formulário manual de tracking.");
}
if (/trackingToken|Código de acompanhamento|Cole o código/i.test(publicHtml)) {
  fail("A interface pública não deve expor token ou código manual de tracking.");
}
if (!publicApp.includes("message: () => refreshTrackedOrder(token")) {
  fail("Eventos públicos devem atualizar o tracking sem refresh manual.");
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
