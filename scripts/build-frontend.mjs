import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");

const required = ["index.html", "assets"];
const optional = ["admin", "public"];

for (const entry of required) {
  if (!fs.existsSync(path.join(root, entry))) {
    console.error(`Arquivo obrigatório ausente: ${entry}`);
    process.exit(1);
  }
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

function copy(entry) {
  const source = path.join(root, entry);
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, path.join(output, entry), { recursive: true });
}

for (const entry of [...required, ...optional]) copy(entry);

// A segunda rota usa a mesma marcação e o mesmo fluxo de compra da página original.
// Somente os caminhos dos assets e o modo de apresentação mudam.
const simpleDir = path.join(output, "simples");
fs.mkdirSync(simpleDir, { recursive: true });
const simpleHtml = fs.readFileSync(path.join(root, "index.html"), "utf8")
  .replace('<html lang="pt-BR"', '<html lang="pt-BR" class="simple-menu"')
  .replaceAll('="assets/', '="/assets/')
  .replace('<title>Atrevida Gourmet | Cardápio</title>', '<title>Atrevida Gourmet | Cardápio simples</title>')
  .replace('</head>', '  <link rel="stylesheet" href="/assets/css/simple.css" />\n</head>');
fs.writeFileSync(path.join(simpleDir, "index.html"), simpleHtml);

const headers = path.join(root, "config", "_headers");
if (fs.existsSync(headers)) {
  fs.copyFileSync(headers, path.join(output, "_headers"));
}

console.log(`Frontend gerado em ${path.relative(root, output)}.`);
