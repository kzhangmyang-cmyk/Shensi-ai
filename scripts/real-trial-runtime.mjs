import { randomBytes } from "node:crypto";
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isTrialPortAvailable, prepareTrialRuntime, TRIAL_PORTS } from "./real-trial-config.mjs";

const execFile = promisify(nodeExecFile);
const mysqlBasedir = "/Users/mac/.local/mysql-8.4.11-macos15-arm64";
const cloudflared = "/private/tmp/shensi-cloudflared-verified-20260826/cloudflared";
const cloudflaredSha256 = "b61054d3d6326ea558cb49826eebf5676e0d0a36d51b546975096ca3e0e3c89d";
const node = "/Users/mac/.local/node-22/bin/node";
const pnpm = "/Users/mac/bin/pnpm";
const mysqlSocket = "/private/tmp/shensi-real-trial-3310.sock";
const childScript = fileURLToPath(new URL("./real-trial-child.mjs", import.meta.url));

function child(command, args, options, spawn) {
  const value = spawn(command, args, { ...options, stdio: options.stdio ?? "ignore" });
  if (!value?.pid) throw new Error("TRIAL_CHILD_START_FAILED");
  return value;
}
function tunnelOrigin(value) { return /https:\/\/[^\s]+\.trycloudflare\.com/u.exec(String(value))?.[0] ?? null; }
async function waitForTunnelOrigin(logPath) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const origin = tunnelOrigin(await readFile(logPath, "utf8").catch(() => ""));
    if (origin) return origin;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
  }
  throw new Error("TRIAL_TUNNEL_ORIGIN_TIMEOUT");
}
function expectedPsCommand(record) { return [record.command, ...record.args].join(" "); }
function validNonce(value) { return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value); }
function validRecord(value) {
  return value && typeof value === "object" && typeof value.name === "string" && /^[a-z0-9-]+$/u.test(value.name)
    && Number.isSafeInteger(value.pid) && value.pid > 1 && typeof value.command === "string" && value.command.length > 0
    && Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string") && validNonce(value.nonce);
}
async function privateDirectory(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("TRIAL_PID_DIRECTORY_SYMLINK");
    if (!info.isDirectory()) throw new Error("TRIAL_PID_DIRECTORY_INVALID");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
}
async function privateLogFile(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("TRIAL_LOG_SYMLINK");
    if (!info.isFile()) throw new Error("TRIAL_LOG_INVALID");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeFile(path, "", { mode: 0o600, flag: "wx" });
  }
  await chmod(path, 0o600);
  await writeFile(path, "", { mode: 0o600, flag: "w" });
}

export async function writeRecord(runtime, record) {
  if (!validRecord(record)) throw new Error("TRIAL_PID_RECORD_INVALID");
  await privateDirectory(runtime.pidsDirectory);
  const destination = resolve(runtime.pidsDirectory, `${record.name}.json`);
  const temporary = resolve(runtime.pidsDirectory, `.${record.name}.${record.nonce}.tmp`);
  const persisted = { version: 1, ...record, expectedPsCommand: expectedPsCommand(record) };
  await writeFile(temporary, JSON.stringify(persisted), { mode: 0o600, flag: "wx" });
  await rename(temporary, destination);
  return { ...persisted, path: destination };
}
export async function readRuntimeRecords(runtime) {
  await privateDirectory(runtime.pidsDirectory);
  const names = (await readdir(runtime.pidsDirectory)).filter((name) => name.endsWith(".json")).sort();
  const records = [];
  for (const name of names) {
    const path = resolve(runtime.pidsDirectory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("TRIAL_PID_RECORD_SYMLINK");
    if (!info.isFile() || (info.mode & 0o077)) throw new Error("TRIAL_PID_RECORD_INVALID");
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!validRecord(value) || value.version !== 1 || value.expectedPsCommand !== expectedPsCommand(value) || name !== `${value.name}.json`) throw new Error("TRIAL_PID_RECORD_INVALID");
    records.push({ ...value, path });
  }
  return records;
}
export async function readProcessCommand(pid) {
  try { return (await execFile("ps", ["-p", String(pid), "-o", "command="])).stdout.trimEnd(); } catch { return null; }
}
export async function isRecordedProcess(record, options = {}) {
  if (!validRecord(record)) return false;
  const current = await (options.readProcessCommand ?? readProcessCommand)(record.pid);
  return current === expectedPsCommand(record) && current.includes(`--runtime-nonce ${record.nonce}`);
}
async function removeMissingRecord(record) {
  if (!record.path) return;
  await unlink(record.path).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
async function clearMissingRecordsBeforeStart(runtime, readCommand) {
  for (const record of await readRuntimeRecords(runtime)) {
    if ((await readCommand(record.pid)) === null) {
      await removeMissingRecord(record);
      continue;
    }
    throw new Error(`TRIAL_PID_RECORD_ACTIVE_OR_REUSED:${record.name}`);
  }
}
async function defaultSignalProcessGroup(pid, signal) { process.kill(-pid, signal); }
export async function stopTrialRuntime(runtime, options = {}) {
  const records = runtime.records ?? await readRuntimeRecords(runtime);
  const readCommand = options.readProcessCommand ?? readProcessCommand;
  const signal = options.signalProcessGroup
    ?? (options.kill ? async (pid, signalName) => options.kill(records.find((record) => record.pid === pid), signalName) : defaultSignalProcessGroup);
  const stopped = [], stale = [];
  for (const record of [...records].reverse()) {
    const matches = options.isRecordedProcess ? await options.isRecordedProcess(record) : await isRecordedProcess(record, { readProcessCommand: readCommand });
    if (!matches) {
      if ((await readCommand(record.pid)) === null) {
        await removeMissingRecord(record);
      } else stale.push(record.name);
      continue;
    }
    await signal(record.pid, "SIGTERM");
    const exited = options.waitForExit
      ? await options.waitForExit(record)
      : await waitForRecordedExit(record, readCommand, options.sleep);
    if (exited) {
      stopped.push(record.name);
      if (record.path) await unlink(record.path).catch(() => {});
      continue;
    }
    const stillMatches = await isRecordedProcess(record, { readProcessCommand: readCommand });
    if (!stillMatches) {
      stopped.push(record.name);
      if (record.path) await unlink(record.path).catch(() => {});
      continue;
    }
    await signal(record.pid, "SIGKILL");
    const killed = options.waitForExit
      ? await options.waitForExit(record)
      : await waitForRecordedExit(record, readCommand, options.sleep);
    if (killed) {
      stopped.push(record.name);
      if (record.path) await unlink(record.path).catch(() => {});
    } else stale.push(record.name);
  }
  return { stopped, stale };
}
async function waitForRecordedExit(record, readCommand, sleep = (milliseconds) => new Promise((resolveTimer) => setTimeout(resolveTimer, milliseconds))) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await readCommand(record.pid)) === null) return true;
    await sleep(100);
  }
  return (await readCommand(record.pid)) === null;
}
async function waitForExit(value) { return new Promise((resolveExit, rejectExit) => { value.once?.("error", rejectExit); value.once?.("exit", (code, signal) => code === 0 ? resolveExit() : rejectExit(new Error(`TRIAL_CHILD_EXIT:${signal ?? code}`))); }); }
async function defaultRunCommand(command, args, options) { const value = child(command, args, { ...options, stdio: "inherit" }, nodeSpawn); await waitForExit(value); }
function oneShotEnvironment(environment, overrides = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...environment,
    ...overrides
  };
}
async function defaultWaitForMysql({ mysqladmin = resolve(mysqlBasedir, "bin/mysqladmin") } = {}) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { await execFile(mysqladmin, ["--protocol=TCP", "-h", "127.0.0.1", "-P", String(TRIAL_PORTS.mysql), "-u", "root", "ping"]); return; } catch { await new Promise((resolveTimer) => setTimeout(resolveTimer, 250)); }
  }
  throw new Error("TRIAL_MYSQL_UNHEALTHY");
}
async function defaultWaitForHealth(url, options = {}) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: options.headers });
      if (!response.ok) throw new Error("not_ok");
      if (url.endsWith("/api/health")) {
        const body = await response.json();
        if (body?.ok !== true || body?.store !== "mysql") throw new Error("backend_not_mysql");
      }
      return;
    } catch { await new Promise((resolveTimer) => setTimeout(resolveTimer, 250)); }
  }
  throw new Error("TRIAL_DEPENDENCY_UNHEALTHY");
}
async function waitForPortRelease(port, isAvailable) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await isAvailable(port)) return;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));
  }
  throw new Error(`TRIAL_PORT_RELEASE_TIMEOUT:${port}`);
}
async function defaultProvisionAdmin({ backendOrigin, bootstrapPassword, runtime }) {
  const trialPassword = (await readFile(runtime.trialPasswordPath, "utf8")).trim();
  const bootstrap = await fetch(`${backendOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "internal-trial-bootstrap@shensi.local", password: bootstrapPassword }) });
  if (!bootstrap.ok) throw new Error("TRIAL_BOOTSTRAP_LOGIN_FAILED");
  const token = (await bootstrap.json()).token;
  if (typeof token !== "string" || !token) throw new Error("TRIAL_BOOTSTRAP_TOKEN_INVALID");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const listed = await fetch(`${backendOrigin}/api/accounts`, { headers });
  if (!listed.ok) throw new Error("TRIAL_ACCOUNT_LIST_FAILED");
  const accounts = (await listed.json()).accounts;
  const matches = Array.isArray(accounts) ? accounts.filter((account) => account.email === "test@shensi.local") : [];
  if (!matches.length) {
    const created = await fetch(`${backendOrigin}/api/accounts`, { method: "POST", headers, body: JSON.stringify({ name: "试用管理员", email: "test@shensi.local", password: trialPassword, role: "admin", teamId: "trial-pilot-001" }) });
    if (!created.ok) throw new Error("TRIAL_ACCOUNT_PROVISION_FAILED");
  } else if (matches.length !== 1 || matches[0].role !== "admin" || matches[0].teamId !== "trial-pilot-001" || matches[0].status !== "active") {
    throw new Error("TRIAL_ACCOUNT_CONFLICT");
  } else {
    const updated = await fetch(`${backendOrigin}/api/accounts/${encodeURIComponent(matches[0].id)}/password`, { method: "PATCH", headers, body: JSON.stringify({ password: trialPassword }) });
    if (!updated.ok) throw new Error("TRIAL_ACCOUNT_PASSWORD_UPDATE_FAILED");
  }
  const verified = await fetch(`${backendOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "test@shensi.local", password: trialPassword }) });
  if (!verified.ok) throw new Error("TRIAL_ACCOUNT_LOGIN_VERIFICATION_FAILED");
  const user = (await verified.json()).user;
  if (user?.email !== "test@shensi.local" || user?.role !== "admin" || user?.teamId !== "trial-pilot-001") throw new Error("TRIAL_ACCOUNT_VERIFICATION_FAILED");
}

export async function startTrialRuntime(repositoryRoot, options = {}) {
  const runtime = await (options.prepare ?? prepareTrialRuntime)(repositoryRoot, { cloudflared: options.cloudflared ?? { path: options.cloudflaredBinary ?? cloudflared, sha256: cloudflaredSha256 }, ...options });
  const spawn = options.spawn ?? nodeSpawn, available = options.isPortAvailable ?? isTrialPortAvailable, readCommand = options.readProcessCommand ?? readProcessCommand, waitForHealth = options.waitForHealth ?? defaultWaitForHealth, waitForMysql = options.waitForMysql ?? defaultWaitForMysql, runCommand = options.runCommand ?? defaultRunCommand, readSidecarSecret = options.readSidecarSecret ?? ((path) => readFile(path, "utf8")), wrapCommands = options.wrapCommands !== false;
  const records = [];
  const run = async (name, command, args, environment = {}) => {
    const nonce = randomBytes(16).toString("hex"), logPath = resolve(runtime.logsDirectory, `${name}.log`);
    await privateDirectory(runtime.logsDirectory); await privateLogFile(logPath);
    const wrappedCommand = wrapCommands ? node : command;
    const wrappedArgs = wrapCommands ? [childScript, "--runtime-nonce", nonce, "--log", logPath, "--", Buffer.from(JSON.stringify({ command, args })).toString("base64url")] : args;
    const value = child(wrappedCommand, wrappedArgs, { cwd: repositoryRoot, detached: wrapCommands, stdio: "ignore", env: { PATH: process.env.PATH ?? "", ...runtime.environment, ...environment, HOST: "127.0.0.1" } }, spawn);
    const record = { ...await writeRecord(runtime, { name, pid: value.pid, command: wrappedCommand, args: wrappedArgs, nonce }), child: value };
    if (wrapCommands) value.unref?.();
    records.push(record); return record;
  };
  const killKnown = async (pid, signal) => records.find((record) => record.pid === pid)?.child?.kill?.(signal);
  try {
    await clearMissingRecordsBeforeStart(runtime, readCommand);
    for (const port of Object.values(TRIAL_PORTS)) if (!await available(port)) throw new Error(`TRIAL_PORT_OCCUPIED:${port}`);
    await runCommand(pnpm, ["--filter", "./backend", "build"], { cwd: repositoryRoot, env: oneShotEnvironment(runtime.environment, { NODE_ENV: "production" }) });
    await runCommand(pnpm, ["--filter", "./frontend", "build"], { cwd: repositoryRoot, env: oneShotEnvironment(runtime.environment, { NODE_ENV: "production" }) });
    const mysqld = options.mysqlBinary ?? resolve(options.mysqlBasedir ?? process.env.SHENSI_TRIAL_MYSQL_BASEDIR ?? mysqlBasedir, "bin/mysqld"), basedir = options.mysqlBasedir ?? process.env.SHENSI_TRIAL_MYSQL_BASEDIR ?? mysqlBasedir;
    const mysqlContents = await readdir(runtime.mysqlDirectory).catch(() => []);
    if (!mysqlContents.length) await runCommand(mysqld, ["--no-defaults", `--basedir=${basedir}`, `--datadir=${runtime.mysqlDirectory}`, "--initialize-insecure"], { cwd: repositoryRoot, env: oneShotEnvironment(runtime.environment) });
    else if (!mysqlContents.includes("mysql")) throw new Error("TRIAL_MYSQL_DATADIR_INVALID");
    await run("mysql", mysqld, ["--no-defaults", `--basedir=${basedir}`, `--datadir=${runtime.mysqlDirectory}`, "--bind-address=127.0.0.1", `--port=${TRIAL_PORTS.mysql}`, `--socket=${mysqlSocket}`, "--mysqlx=OFF", `--pid-file=${resolve(runtime.stateDirectory, "mysql.pid")}`, `--log-error=${resolve(runtime.logsDirectory, "mysql-error.log")}`]);
    await waitForMysql({ mysqladmin: resolve(basedir, "bin/mysqladmin") });
    await runCommand(pnpm, ["--filter", "./backend", "exec", "tsx", "scripts/setup-trial-mysql.ts"], { cwd: repositoryRoot, env: oneShotEnvironment(runtime.environment, { SHENSI_TRIAL_MYSQL_ADMIN_URL: `mysql://root@127.0.0.1:${TRIAL_PORTS.mysql}/mysql` }) });
    const tunnel = await run("tunnel", options.cloudflaredBinary ?? resolve(runtime.toolsDirectory, "cloudflared"), ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://127.0.0.1:${TRIAL_PORTS.gateway}`, "--http-host-header", `127.0.0.1:${TRIAL_PORTS.gateway}`]);
    const origin = await (options.waitForTunnelOrigin ?? waitForTunnelOrigin)(resolve(runtime.logsDirectory, "tunnel.log"));
    const backendCommand = options.backendCommand ?? [node, resolve(repositoryRoot, "backend/dist/server.js")], frontendCommand = options.frontendCommand ?? [node, resolve(repositoryRoot, "frontend/node_modules/vite/bin/vite.js"), "preview", resolve(repositoryRoot, "frontend"), "--host", "127.0.0.1", "--port", "5610", "--strictPort"], sidecarCommand = options.sidecarCommand ?? [resolve(repositoryRoot, "services/media-crawler/.venv/bin/uvicorn"), "shensi_adapter.app:app", "--app-dir", "services/media-crawler", "--host", "127.0.0.1", "--port", "5612"], gatewayCommand = options.gatewayCommand ?? [node, "scripts/real-trial-gateway.mjs"];
    const bootstrapPassword = runtime.bootstrapPassword ?? randomBytes(32).toString("base64url");
    const temporaryBackend = await run("backend-bootstrap", backendCommand[0], backendCommand.slice(1), { PORT: String(TRIAL_PORTS.backend), CORS_ORIGINS: origin, NODE_ENV: "production", INITIAL_ADMIN_EMAIL: "internal-trial-bootstrap@shensi.local", INITIAL_ADMIN_PASSWORD: bootstrapPassword });
    await waitForHealth(`http://127.0.0.1:${TRIAL_PORTS.backend}/api/health`);
    await (options.provisionAdmin ?? defaultProvisionAdmin)({ backendOrigin: `http://127.0.0.1:${TRIAL_PORTS.backend}`, bootstrapPassword, runtime, email: "test@shensi.local", role: "admin", tenantId: "trial-pilot-001" });
    const bootstrapStop = await stopTrialRuntime({ records: [temporaryBackend] }, { isRecordedProcess: async () => true, signalProcessGroup: killKnown });
    if (bootstrapStop.stale.length) throw new Error("TRIAL_BOOTSTRAP_STOP_FAILED");
    records.splice(records.indexOf(temporaryBackend), 1);
    await (options.waitForPortRelease ?? waitForPortRelease)(TRIAL_PORTS.backend, available);
    await run("backend", backendCommand[0], backendCommand.slice(1), { PORT: String(TRIAL_PORTS.backend), CORS_ORIGINS: origin, NODE_ENV: "production", MEDIACRAWLER_BASE_URL: `http://127.0.0.1:${TRIAL_PORTS.mediaCrawler}` });
    await waitForHealth(`http://127.0.0.1:${TRIAL_PORTS.backend}/api/health`);
    await run("sidecar", sidecarCommand[0], sidecarCommand.slice(1), { PORT: String(TRIAL_PORTS.mediaCrawler), NODE_ENV: "production" });
    const sidecarSecret = (await readSidecarSecret(runtime.environment.MEDIACRAWLER_SERVICE_SECRET_FILE)).trim();
    await waitForHealth(`http://127.0.0.1:${TRIAL_PORTS.mediaCrawler}/internal/v1/health`, { headers: { authorization: `Bearer ${sidecarSecret}` } });
    await run("frontend", frontendCommand[0], frontendCommand.slice(1), { PORT: String(TRIAL_PORTS.frontend), NODE_ENV: "production" });
    await waitForHealth(`http://127.0.0.1:${TRIAL_PORTS.frontend}/`);
    await run("gateway", gatewayCommand[0], gatewayCommand.slice(1), { PORT: String(TRIAL_PORTS.gateway), NODE_ENV: "production", TRIAL_BACKEND_ORIGIN: `http://127.0.0.1:${TRIAL_PORTS.backend}`, TRIAL_FRONTEND_ORIGIN: `http://127.0.0.1:${TRIAL_PORTS.frontend}` });
    await waitForHealth(`http://127.0.0.1:${TRIAL_PORTS.gateway}/healthz`);
    await writeFile(resolve(runtime.root, "status.json"), JSON.stringify({ version: 1, running: true, origin, records: records.map(({ name, pid }) => ({ name, pid })) }), { mode: 0o600 });
    return { ...runtime, origin, records };
  } catch (error) {
    await stopTrialRuntime({ records }, { isRecordedProcess: async () => true, signalProcessGroup: killKnown });
    for (const record of records) if (!await isRecordedProcess(record)) await unlink(record.path).catch(() => {});
    throw error;
  }
}
export async function trialStatus(root, options = {}) {
  try {
    const status = JSON.parse(await readFile(resolve(root, "status.json"), "utf8"));
    const records = await readRuntimeRecords({ pidsDirectory: resolve(root, "pids") });
    return {
      ...status,
      records: await Promise.all(records.map(async (record) => ({
        name: record.name,
        pid: record.pid,
        running: await isRecordedProcess(record, options)
      })))
    };
  } catch { return { running: false }; }
}
async function main() { const root = resolve(import.meta.dirname, ".."), command = process.argv[2] ?? "start", runtimeRoot = resolve(process.env.SHENSI_TRIAL_RUNTIME_ROOT ?? resolve(root, ".runtime/real-trial")); if (command === "start") { const runtime = await startTrialRuntime(root); console.log(`TRIAL_STARTED:${runtime.origin}`); return; } if (command === "prepare") { const runtime = await prepareTrialRuntime(root); console.log(`TRIAL_PREPARED:${runtime.root}`); return; } if (command === "stop") { const result = await stopTrialRuntime({ pidsDirectory: resolve(runtimeRoot, "pids") }); await rm(resolve(runtimeRoot, "status.json"), { force: true }); if (result.stale.length) throw new Error("TRIAL_STOP_INCOMPLETE"); console.log("TRIAL_STOPPED"); return; } if (command === "status") console.log(JSON.stringify(await trialStatus(runtimeRoot))); }
if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
