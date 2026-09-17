import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanner = path.join(root, "scripts", "scan-public-build.mjs");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "atrevida-scanner-"));

function scan() {
  return spawnSync(process.execPath, [scanner, fixture], { encoding: "utf8" });
}

try {
  fs.writeFileSync(path.join(fixture, "app.js"), "console.log('ok');\n");
  assert.equal(scan().status, 0, "build limpo deveria passar");

  fs.writeFileSync(
    path.join(fixture, "large.js"),
    `${" ".repeat(5 * 1024 * 1024 + 10)}sb_secret_regression_fixture`
  );
  assert.notEqual(scan().status, 0, "bundle textual grande com segredo deveria falhar");
  fs.rmSync(path.join(fixture, "large.js"));

  fs.writeFileSync(path.join(fixture, ".env"), "PLACEHOLDER_ONLY=true\n");
  assert.notEqual(scan().status, 0, "arquivo .env público deveria falhar");
  console.log("Scanner validado com fixtures positivas e negativas.");
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
