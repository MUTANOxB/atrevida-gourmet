import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const backendRoot = fileURLToPath(new URL("../../", import.meta.url));
const envModule = new URL("./env.ts", import.meta.url).href;
const baseEnv = {
  ...process.env,
  NODE_ENV: "production",
  PORT: "3333",
  SUPABASE_URL: "https://test-project.supabase.co",
  SUPABASE_SECRET_KEY: "test-secret-key-with-at-least-20-characters",
  SUPABASE_ANON_KEY: "test-anon-key-with-at-least-20-characters",
  SERVE_STATIC: "false"
};

function evaluate(frontendOrigin: string) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `const { corsOrigins } = await import(${JSON.stringify(envModule)}); process.stdout.write(JSON.stringify(corsOrigins));`
    ],
    {
      cwd: backendRoot,
      encoding: "utf8",
      env: { ...baseEnv, FRONTEND_ORIGIN: frontendOrigin }
    }
  );
}

test("produção mantém somente a allowlist HTTPS explícita", () => {
  const result = evaluate("https://delivery.example");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["https://delivery.example"]);
});

test("produção rejeita wildcard e origem HTTP local", () => {
  assert.notEqual(evaluate("*").status, 0);
  assert.notEqual(evaluate("http://127.0.0.1:3333").status, 0);
});
