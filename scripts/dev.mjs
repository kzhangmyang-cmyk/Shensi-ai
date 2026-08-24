import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const requiredLocalVariables = [
  "DATABASE_URL",
  "JWT_SECRET",
  "PROVIDER_CREDENTIAL_KEY",
  "AGENT_JOB_ENCRYPTION_KEY",
  "ACQUISITION_MASTER_SECRET"
];

export function readEnvironmentFile(filePath) {
  if (!existsSync(filePath)) throw new Error("LOCAL_ENVIRONMENT_FILE_MISSING");
  const environment = {};
  for (const sourceLine of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!assignment) continue;
    let value = assignment[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, "");
    }
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
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT_INVALID:${name}`);
  }
  return port;
}

export function validatePorts({ backend, frontend }) {
  const parsed = {
    backend: parsePort(backend, "backend"),
    frontend: parsePort(frontend, "frontend")
  };
  if (parsed.backend === parsed.frontend) throw new Error("PORT_CONFLICT");
  return parsed;
}

export function assertPortAvailable(port) {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    const fail = () => rejectPort(new Error(`PORT_UNAVAILABLE:${port}`));
    server.once("error", fail);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close((error) => error ? fail() : resolvePort());
    });
  });
}

export async function assertPortsAvailable(ports) {
  await assertPortAvailable(ports.backend);
  await assertPortAvailable(ports.frontend);
}

function waitForChild(child) {
  return new Promise((resolveChild) => {
    child.once("exit", (code, signal) => resolveChild({ code: code ?? 1, signal }));
    child.once("error", () => resolveChild({ code: 1, signal: null }));
  });
}

function stopChildren(children, signal) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
  const deadline = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);
  deadline.unref();
  return deadline;
}

export async function runDevelopment(root, environment) {
  validateRequiredVariables(environment);
  const ports = validatePorts({
    backend: environment.SHENSI_BACKEND_PORT ?? 4191,
    frontend: environment.SHENSI_FRONTEND_PORT ?? 5191
  });
  await assertPortsAvailable(ports);

  const backend = spawn("pnpm", ["--filter", "./backend", "dev:mysql"], {
    cwd: root,
    env: { ...environment, CRM_STORE: "mysql", PORT: String(ports.backend) },
    stdio: "inherit"
  });
  const frontend = spawn("pnpm", ["--filter", "./frontend", "dev", "--", "--port", String(ports.frontend)], {
    cwd: root,
    env: { ...environment, VITE_API_TARGET: `http://127.0.0.1:${ports.backend}` },
    stdio: "inherit"
  });
  const children = [backend, frontend];
  let stopping = false;
  let deadline;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    deadline = stopChildren(children, signal);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  const exits = children.map(waitForChild);
  const firstExit = await Promise.race(exits);
  stop("SIGTERM");
  const results = await Promise.all(exits);
  if (deadline) clearTimeout(deadline);
  if (firstExit.code !== 0 || results.some(({ code }) => code !== 0)) process.exitCode = 1;
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const fileEnvironment = readEnvironmentFile(resolve(root, ".env.local"));
  await runDevelopment(root, { ...fileEnvironment, ...process.env });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
