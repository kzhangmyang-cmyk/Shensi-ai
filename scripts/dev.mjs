import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const requiredLocalVariables = ["DATABASE_URL", "JWT_SECRET", "PROVIDER_CREDENTIAL_KEY", "AGENT_JOB_ENCRYPTION_KEY", "ACQUISITION_MASTER_SECRET"];

export function readEnvironmentFile(filePath) {
  if (!existsSync(filePath)) throw new Error("LOCAL_ENVIRONMENT_FILE_MISSING");
  const environment = {};
  for (const sourceLine of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!assignment) continue;
    let value = assignment[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/u, "");
    environment[assignment[1]] = value;
  }
  return environment;
}

export function validateRequiredVariables(environment) {
  const missing = requiredLocalVariables.filter((name) => !environment[name]?.trim());
  if (missing.length) throw new Error(`LOCAL_ENVIRONMENT_MISSING:${missing.join(",")}`);
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT_INVALID:${name}`);
  return port;
}

export function validatePorts({ backend, frontend }) {
  const parsed = { backend: parsePort(backend, "backend"), frontend: parsePort(frontend, "frontend") };
  if (parsed.backend === parsed.frontend) throw new Error("PORT_CONFLICT");
  return parsed;
}

export function assertPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    const fail = () => rejectPort(new Error(`PORT_UNAVAILABLE:${port}`));
    server.once("error", fail);
    server.listen({ host, port }, () => server.close((error) => error ? fail() : resolvePort()));
  });
}

export async function assertPortsAvailable(ports, hosts = { backend: "127.0.0.1", frontend: "127.0.0.1" }) {
  await assertPortAvailable(ports.backend, hosts.backend);
  await assertPortAvailable(ports.frontend, hosts.frontend);
}

export function terminateProcessTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}

function waitForChild(child) {
  return new Promise((resolveChild) => {
    child.once("exit", (code, signal) => resolveChild({ code: code ?? 1, signal }));
    child.once("error", () => resolveChild({ code: 1, signal: null }));
  });
}

export async function runDevelopment(root, environment, options = {}) {
  const { processRef = process, spawnProcess = spawn, assertPorts = assertPortsAvailable, terminateTree = terminateProcessTree, setTimer = setTimeout, clearTimer = clearTimeout } = options;
  validateRequiredVariables(environment);
  const ports = validatePorts({ backend: environment.SHENSI_BACKEND_PORT ?? 4191, frontend: environment.SHENSI_FRONTEND_PORT ?? 5191 });
  const hosts = { backend: environment.BACKEND_HOST ?? "127.0.0.1", frontend: "127.0.0.1" };
  const records = [];
  let stopping = false;
  let deadline;
  const forceCleanup = () => records.forEach(({ child }) => terminateTree(child, "SIGKILL"));
  const startDeadline = () => { if (!deadline && records.length) deadline = setTimer(forceCleanup, 10_000); };
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    records.forEach(({ child }) => terminateTree(child, signal));
    startDeadline();
  };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  processRef.once("SIGINT", onInterrupt);
  processRef.once("SIGTERM", onTerminate);
  try {
    await assertPorts(ports, hosts);
    if (stopping) return;
    const launch = (command, argumentsList, childEnvironment) => {
      const child = spawnProcess(command, argumentsList, {
        cwd: root, env: childEnvironment, stdio: "inherit", detached: process.platform !== "win32"
      });
      records.push({ child, exited: waitForChild(child) });
      if (stopping) {
        terminateTree(child, "SIGTERM");
        startDeadline();
        return false;
      }
      return true;
    };
    const waitForStoppedChildren = () => Promise.all(records.map(({ exited }) => exited));
    if (!launch("pnpm", ["--filter", "./backend", "dev:mysql"], { ...environment, CRM_STORE: "mysql", PORT: String(ports.backend), BACKEND_HOST: hosts.backend })) {
      await waitForStoppedChildren();
      return;
    }
    if (!launch("pnpm", ["--filter", "./frontend", "dev", "--", "--port", String(ports.frontend), "--strictPort"], { ...environment, VITE_API_TARGET: `http://127.0.0.1:${ports.backend}` })) {
      await waitForStoppedChildren();
      return;
    }
    const firstExit = await Promise.race(records.map(({ exited }) => exited));
    stop("SIGTERM");
    const results = await Promise.all(records.map(({ exited }) => exited));
    if (firstExit.code !== 0 || results.some(({ code }) => code !== 0)) processRef.exitCode = 1;
  } finally {
    if (deadline) clearTimer(deadline);
    processRef.removeListener("SIGINT", onInterrupt);
    processRef.removeListener("SIGTERM", onTerminate);
  }
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  await runDevelopment(root, readEnvironmentFile(resolve(root, ".env.local")));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
