import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || "dist";

if (!fs.existsSync(root)) {
  console.error(`Build não encontrado: ${root}`);
  process.exit(2);
}

const forbiddenPatterns = [
  {
    name: "Supabase secret key",
    regex: /sb_secret_[A-Za-z0-9_-]+/g
  },
  {
    name: "Supabase legacy service_role",
    regex: /service_role/g
  },
  {
    name: "PostgreSQL connection string",
    regex: /postgres(?:ql)?:\/\/[^"'`\s]+/gi
  },
  {
    name: "Private key",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
  },
  {
    name: "JWT secret variable",
    regex: /\bJWT_SECRET\b/g
  },
  {
    name: "Database password variable",
    regex: /\b(?:DB_PASSWORD|DATABASE_PASSWORD)\b/g
  },
  {
    name: "Service role env name",
    regex: /\bSUPABASE_SERVICE_ROLE_KEY\b/g
  },
  {
    name: "Supabase secret env name",
    regex: /\bSUPABASE_SECRET_KEY\b/g
  },
  {
    name: "Direct Supabase browser endpoint",
    regex: /https:\/\/[a-z0-9-]+\.supabase\.co/gi
  },
  {
    name: "Supabase browser SDK",
    regex: /@supabase\/supabase-js|\bcreateClient\s*\(/g
  },
  {
    name: "JWT-like token",
    regex: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g
  },
  {
    name: "Embedded source map reference",
    regex: /[#@]\s*sourceMappingURL\s*=/g
  }
];

let failed = false;
const discoveredMaps = [];
const forbiddenFileNames = [
  /^\.env(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx|sql)$/i
];
const binaryExtensions = new Set([
  ".avif", ".gif", ".ico", ".jpg", ".jpeg", ".png", ".webp",
  ".woff", ".woff2", ".ttf", ".otf", ".pdf", ".zip", ".gz"
]);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(full);
      continue;
    }

    if (entry.name.endsWith(".map")) {
      discoveredMaps.push(full);
    }

    if (forbiddenFileNames.some((pattern) => pattern.test(entry.name))) {
      failed = true;
      console.error(`[ARQUIVO SENSÍVEL] ${full}`);
    }

    const bytes = fs.readFileSync(full);

    // Binários conhecidos são ignorados; todo conteúdo textual é examinado,
    // inclusive bundles maiores que 5 MiB e arquivos com extensão incomum.
    const extension = path.extname(entry.name).toLowerCase();
    if (binaryExtensions.has(extension)) {
      continue;
    }
    if (bytes.includes(0) && ![".js", ".mjs", ".css", ".html", ".json", ".svg"].includes(extension)) continue;

    const content = bytes.toString("utf8");

    for (const pattern of forbiddenPatterns) {
      const match = content.match(pattern.regex);

      if (match) {
        failed = true;
        console.error(
          `[LEAK] ${pattern.name}: ${full}`
        );
      }
    }
  }
}

walk(root);

if (discoveredMaps.length) {
  failed = true;

  for (const map of discoveredMaps) {
    console.error(`[SOURCEMAP PÚBLICO] ${map}`);
  }
}

if (failed) {
  console.error("\nBuild rejeitado por possível exposição de dados.");
  process.exit(1);
}

console.log("Build público verificado: nenhum padrão crítico encontrado.");
