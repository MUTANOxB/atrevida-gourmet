import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendRoot = path.join(root, "backend");
const build = spawnSync(process.execPath, [path.join(root, "scripts", "build-frontend.mjs")], {
  cwd: root,
  stdio: "inherit",
  shell: false
});

if (build.status !== 0) process.exit(build.status ?? 1);

const backend = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
  cwd: backendRoot,
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || "development",
    SERVE_STATIC: "true"
  }
});

let shuttingDown = false;
function forwardSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!backend.killed) backend.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => forwardSignal(signal));
}

backend.once("error", (error) => {
  process.stderr.write(`Não foi possível iniciar o backend: ${error.message}\n`);
  process.exitCode = 1;
});

const exitCode = await new Promise((resolve) => {
  backend.once("exit", (code, signal) => resolve(code ?? (signal ? 0 : 1)));
});

process.exitCode = exitCode;
