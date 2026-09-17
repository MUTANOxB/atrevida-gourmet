import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const forbidden = [
  /sb_secret_/i,
  /\bservice_role\b/i,
  /\bSUPABASE_SECRET_KEY\b/,
  /\bSUPABASE_SERVICE_ROLE_KEY\b/,
  /\bJWT_SECRET\b/,
  /postgres(?:ql)?:\/\//i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

assert.ok(fs.existsSync(dist), "Execute npm run build antes do teste F12.");
const publicFiles = files(dist);
assert.equal(publicFiles.some((file) => file.endsWith(".map")), false, "source map público");
assert.equal(publicFiles.some((file) => /^\.env(?:\.|$)/i.test(path.basename(file))), false, ".env público");

for (const file of publicFiles) {
  if (!/\.(?:html|js|css|json|svg|txt)$/i.test(file) && path.basename(file) !== "_headers") continue;
  const source = fs.readFileSync(file, "utf8");
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `padrão sensível em ${path.relative(dist, file)}`);
  }
}

const adminSource = fs.readFileSync(path.join(dist, "assets", "js", "admin.js"), "utf8");
const apiSource = fs.readFileSync(path.join(dist, "assets", "js", "api-client.js"), "utf8");
assert.equal(/localStorage/.test(adminSource + apiSource), false, "admin não pode usar localStorage");
for (const match of adminSource.matchAll(/sessionStorage\.(?:getItem|setItem)\(["']([^"']+)/g)) {
  assert.equal(match[1], "atrevida_admin_sound", `chave admin inesperada: ${match[1]}`);
}

const baseUrl = process.env.F12_BASE_URL?.replace(/\/$/, "");
if (baseUrl) {
  for (const pathname of ["/", "/admin/login/", "/assets/js/app.js", "/assets/js/admin.js"] ) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 200, `${pathname} deveria responder 200`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.match(response.headers.get("permissions-policy") ?? "", /camera=\(\)/);
    const body = await response.text();
    for (const pattern of forbidden) assert.equal(pattern.test(body), false, `${pathname} vazou padrão sensível`);
  }

  const unauthorized = await fetch(`${baseUrl}/api/admin/orders`);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), {
    error: "Sessão inválida ou expirada.",
    code: "REQUEST_FAILED"
  });
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");
}

console.log(baseUrl
  ? "Build, respostas HTTP e política de storage do navegador verificados."
  : "Build e política de storage do navegador verificados.");
