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

const apiClient = fs.readFileSync(path.join(root, "assets", "js", "api-client.js"), "utf8");
if (!/const API_BASE\s*=\s*["']\/api["']/.test(apiClient)) fail("O cliente HTTP deve usar apenas a base /api.");
if (!apiClient.includes('"X-Store-Slug"')) fail("Requisições administrativas devem informar X-Store-Slug.");

const publicApp = fs.readFileSync(path.join(root, "assets", "js", "app.js"), "utf8");
if (!publicApp.includes("item?.method")) fail("O catálogo deve aceitar paymentMethods[].method.");
const pollInterval = publicApp.match(/TRACKING_POLL_INTERVAL_MS\s*=\s*([\d_]+)/)?.[1]?.replaceAll("_", "");
if (!pollInterval || Number(pollInterval) < 60_000) fail("O polling de tracking deve respeitar o limite público da rota.");

const adminApp = fs.readFileSync(path.join(root, "assets", "js", "admin.js"), "utf8");
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
if (!adminApp.includes("uploadProductImage") || !apiClient.includes("/admin/uploads/product-images")) {
  fail("O upload administrativo de imagens deve passar exclusivamente pela API.");
}
if (!adminApp.includes("selection.removeAllRanges()")) {
  fail("O painel deve limpar seleções acidentais fora de conteúdo copiável.");
}

const adminCss = fs.readFileSync(path.join(root, "assets", "css", "admin.css"), "utf8");
if (!adminCss.includes("user-select: none") || !adminCss.includes(".order-card__number") || !adminCss.includes("user-select: text")) {
  fail("A política de seleção do painel deve preservar dados copiáveis.");
}

if (!publicApp.includes("fulfillmentType === \"delivery\"")) {
  fail("A timeline pública deve respeitar a modalidade do pedido.");
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
