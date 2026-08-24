import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readEnvironmentFile } from "./dev.mjs";

export function healthTargets(environment = {}) {
  const backendPort = Number(environment.SHENSI_BACKEND_PORT ?? 4191);
  const frontendPort = Number(environment.SHENSI_FRONTEND_PORT ?? 5191);
  if (!Number.isInteger(backendPort) || !Number.isInteger(frontendPort)) throw new Error("VERIFY_PORT_INVALID");
  return [{ name: "backend", url: `http://127.0.0.1:${backendPort}/api/health` }, { name: "frontend", url: `http://127.0.0.1:${frontendPort}/` }];
}

function run(root, command, argumentsList) {
  const result = spawnSync(command, argumentsList, { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`VERIFY_COMMAND_FAILED:${command}`);
}

export async function verifyHealth(environment = {}) {
  for (const { name, url } of healthTargets(environment)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) { console.log(`HEALTH_OK:${name}`); continue; }
    } catch { /* Keep configuration values out of health failures. */ }
    throw new Error(`VERIFY_HEALTHCHECK_FAILED:${name}`);
  }
}

export async function runVerification(root, environment, options = {}) {
  const { run: runCommand = (command, argumentsList) => run(root, command, argumentsList), verifyHealth: checkHealth = verifyHealth } = options;
  runCommand(process.execPath, ["scripts/context-check.mjs"]);
  runCommand("pnpm", ["--filter", "./contracts", "test"]);
  runCommand("pnpm", ["--filter", "./backend", "build"]);
  runCommand("pnpm", ["--filter", "./frontend", "test"]);
  runCommand("pnpm", ["--filter", "./frontend", "test:types"]);
  runCommand("pnpm", ["--filter", "./frontend", "build"]);
  await checkHealth(environment);
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const environmentFile = resolve(root, ".env.local");
  await runVerification(root, existsSync(environmentFile) ? readEnvironmentFile(environmentFile) : {});
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
