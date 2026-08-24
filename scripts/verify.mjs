import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readEnvironmentFile } from "./dev.mjs";

export function healthTargets(environment = process.env) {
  const backendPort = Number(environment.SHENSI_BACKEND_PORT ?? 4191);
  const frontendPort = Number(environment.SHENSI_FRONTEND_PORT ?? 5191);
  if (!Number.isInteger(backendPort) || !Number.isInteger(frontendPort)) throw new Error("VERIFY_PORT_INVALID");
  return [
    { name: "backend", url: `http://127.0.0.1:${backendPort}/api/health` },
    { name: "frontend", url: `http://127.0.0.1:${frontendPort}/` }
  ];
}

function run(root, command, argumentsList) {
  const result = spawnSync(command, argumentsList, { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`VERIFY_COMMAND_FAILED:${command}`);
}

export async function verifyHealth(environment = process.env) {
  for (const { name, url } of healthTargets(environment)) {
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    } catch {
      throw new Error(`VERIFY_HEALTHCHECK_FAILED:${name}`);
    }
    if (!response.ok) throw new Error(`VERIFY_HEALTHCHECK_FAILED:${name}`);
    console.log(`HEALTH_OK:${name}`);
  }
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const environmentFile = resolve(root, ".env.local");
  const environment = existsSync(environmentFile)
    ? { ...readEnvironmentFile(environmentFile), ...process.env }
    : process.env;
  run(root, process.execPath, ["scripts/context-check.mjs"]);
  run(root, "pnpm", ["--filter", "./contracts", "test"]);
  run(root, "pnpm", ["--filter", "./backend", "build"]);
  run(root, "pnpm", ["--filter", "./frontend", "test"]);
  run(root, "pnpm", ["--filter", "./frontend", "build"]);
  await verifyHealth(environment);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
