import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { prepareTrialRuntime, TRIAL_PORTS } from "./real-trial-config.mjs";

const mysqlBasedir = "/Users/mac/.local/mysql-8.4.11-macos15-arm64";
const cloudflared = "/private/tmp/shensi-cloudflared-verified-20260826/cloudflared";
const cloudflaredSha256 = "b61054d3d6326ea558cb49826eebf5676e0d0a36d51b546975096ca3e0e3c89d";
const node = "/Users/mac/.local/node-22/bin/node";
const pnpm = "/Users/mac/bin/pnpm";
function child(command, args, options, spawn) { const value = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }); if (!value?.pid) throw new Error("TRIAL_CHILD_START_FAILED"); return value; }
function tunnelOrigin(value) { return /https:\/\/[^\s]+\.trycloudflare\.com/u.exec(String(value))?.[0] ?? null; }
async function writeRecord(runtime, name, value, command) { await mkdir(runtime.pidsDirectory, { recursive: true, mode: 0o700 }); await writeFile(resolve(runtime.pidsDirectory, `${name}.json`), JSON.stringify({ pid: value.pid, command, nonce: randomBytes(16).toString("hex") }), { mode: 0o600 }); }
export async function startTrialRuntime(repositoryRoot, options = {}) {
  const prepare = options.prepare ?? prepareTrialRuntime; const runtime = await prepare(repositoryRoot, { cloudflared: options.cloudflared ?? { path: options.cloudflaredBinary ?? cloudflared, sha256: cloudflaredSha256 }, ...options });
  const spawn = options.spawn ?? nodeSpawn, available = options.isPortAvailable ?? (async () => true), waitForHealth = options.waitForHealth ?? (async () => {});
  for (const port of Object.values(TRIAL_PORTS)) if (!await available(port)) throw new Error(`TRIAL_PORT_OCCUPIED:${port}`);
  const records = []; const run = (name, command, args, environment) => { const value = child(command, args, { cwd: repositoryRoot, env: { PATH: process.env.PATH ?? "", ...runtime.environment, ...environment, HOST: "127.0.0.1" } }, spawn); records.push({ name, pid: value.pid, child: value, command }); void writeRecord(runtime, name, value, command); return value; };
  const mysqld = options.mysqlBinary ?? resolve(options.mysqlBasedir ?? process.env.SHENSI_TRIAL_MYSQL_BASEDIR ?? mysqlBasedir, "bin/mysqld");
  if ((await readdir(runtime.mysqlDirectory).catch(() => [])).length === 0) {
    run("mysql-initialize", mysqld, ["--no-defaults", `--basedir=${options.mysqlBasedir ?? process.env.SHENSI_TRIAL_MYSQL_BASEDIR ?? mysqlBasedir}`, `--datadir=${runtime.mysqlDirectory}`, "--initialize-insecure"]);
  }
  run("mysql", mysqld, ["--no-defaults", `--basedir=${options.mysqlBasedir ?? process.env.SHENSI_TRIAL_MYSQL_BASEDIR ?? mysqlBasedir}`, `--datadir=${runtime.mysqlDirectory}`, "--bind-address=127.0.0.1", `--port=${TRIAL_PORTS.mysql}`, `--socket=${resolve(runtime.stateDirectory, "mysql.sock")}`]);
  await waitForHealth(`http://127.0.0.1:${TRIAL_PORTS.mysql}`);
  run("mysql-setup", pnpm, ["exec", "tsx", "backend/scripts/setup-trial-mysql.ts"], { SHENSI_TRIAL_MYSQL_ADMIN_URL: `mysql://root@127.0.0.1:${TRIAL_PORTS.mysql}/mysql` });
  const tunnel = run("tunnel", options.cloudflaredBinary ?? cloudflared, ["tunnel", "--http-host-header", `127.0.0.1:${TRIAL_PORTS.gateway}`, "--url", `http://127.0.0.1:${TRIAL_PORTS.gateway}`]);
  const origin = await new Promise((resolveOrigin, reject) => { const timer = setTimeout(() => reject(new Error("TRIAL_TUNNEL_ORIGIN_TIMEOUT")), 15_000); const onData = (data) => { const origin = tunnelOrigin(data); if (origin) { clearTimeout(timer); resolveOrigin(origin); } }; tunnel.stdout?.on("data", onData); tunnel.stderr?.on("data", onData); tunnel.on?.("exit", () => { clearTimeout(timer); reject(new Error("TRIAL_TUNNEL_EXITED")); }); });
  const backendCommand = options.backendCommand ?? [pnpm, "--filter", "./backend", "start"]; const frontendCommand = options.frontendCommand ?? [pnpm, "--filter", "./frontend", "exec", "vite", "preview", "--host", "127.0.0.1", "--port", "5610", "--strictPort"]; const sidecarCommand = options.sidecarCommand ?? ["/Users/mac/.local/bin/uv", "run", "--frozen", "--project", "services/media-crawler", "uvicorn", "shensi_adapter.app:app", "--app-dir", "services/media-crawler", "--host", "127.0.0.1", "--port", "5612"]; const gatewayCommand = options.gatewayCommand ?? [node, "scripts/real-trial-gateway.mjs"];
  const backend = run("backend", backendCommand[0], backendCommand.slice(1), { PORT: String(TRIAL_PORTS.backend), CORS_ORIGINS: origin, NODE_ENV: "production", INITIAL_ADMIN_EMAIL: "internal-trial-bootstrap@shensi.local", INITIAL_ADMIN_PASSWORD: randomBytes(32).toString("base64url") });
  run("sidecar", sidecarCommand[0], sidecarCommand.slice(1), { PORT: String(TRIAL_PORTS.mediaCrawler), NODE_ENV: "production" }); run("frontend", frontendCommand[0], frontendCommand.slice(1), { PORT: String(TRIAL_PORTS.frontend), NODE_ENV: "production" }); run("gateway", gatewayCommand[0], gatewayCommand.slice(1), { PORT: String(TRIAL_PORTS.gateway), NODE_ENV: "production", TRIAL_BACKEND_ORIGIN: `http://127.0.0.1:${TRIAL_PORTS.backend}`, TRIAL_FRONTEND_ORIGIN: `http://127.0.0.1:${TRIAL_PORTS.frontend}` });
  await waitForHealth(`http://127.0.0.1:${TRIAL_PORTS.gateway}/healthz`); await options.provisionAdmin?.({ email: "test@shensi.local", role: "admin", tenantId: "trial-pilot-001" });
  return { ...runtime, origin, records };
}
export async function stopTrialRuntime(runtime, options = {}) { const valid = options.isRecordedProcess ?? (async () => true); const kill = options.kill ?? (async (record) => record.child?.kill("SIGTERM")); for (const record of [...runtime.records].reverse()) if (await valid(record)) await kill(record); }
export async function trialStatus(root) { try { return JSON.parse(await readFile(resolve(root, "status.json"), "utf8")); } catch { return { running: false }; } }
async function main() {
  const root = resolve(import.meta.dirname, "..");
  const command = process.argv[2] ?? "start";
  if (command === "start") { const runtime = await startTrialRuntime(root); await writeFile(resolve(runtime.root, "status.json"), JSON.stringify({ running: true, origin: runtime.origin }), { mode: 0o600 }); console.log(`TRIAL_STARTED:${runtime.origin}`); return; }
  const runtimeRoot = resolve(process.env.SHENSI_TRIAL_RUNTIME_ROOT ?? resolve(root, ".runtime/real-trial"));
  if (command === "prepare") { const runtime = await prepareTrialRuntime(root); console.log(`TRIAL_PREPARED:${runtime.root}`); return; }
  if (command === "stop") { await rm(resolve(runtimeRoot, "status.json"), { force: true }); console.log("TRIAL_STOPPED"); return; }
  if (command === "status") console.log(JSON.stringify(await trialStatus(runtimeRoot)));
}
if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
