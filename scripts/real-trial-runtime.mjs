import { randomBytes } from "node:crypto";
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateActionVisualLocator } from "./dev.mjs";
import {
  isTrialPortAvailable,
  prepareTrialCloudflared,
  prepareTrialRuntime,
  trialOutreachEnvironment,
  TRIAL_PORTS
} from "./real-trial-config.mjs";
import {
  cleanupTrialSidecarContainer,
  DEFAULT_TRIAL_COLIMA_BINARY,
  DEFAULT_TRIAL_LIMACTL_BINARY,
  DEFAULT_TRIAL_LIMA_HOME,
  inspectTrialSidecarContainer,
  TRIAL_COLIMA_PROFILE,
  virtualSidecarBuildInvocation
} from "./real-trial-sidecar-container.mjs";
import {
  attestOwnedProcess,
  expectedOwnedProcessCommand,
  inspectOwnedProcess,
  readOwnedProcessCommand,
  stopOwnedProcesses
} from "./lib/process-ownership.mjs";

const execFile = promisify(nodeExecFile);
const mysqlBasedir = "/Users/mac/.local/mysql-8.4.11-macos15-arm64";
const node = "/Users/mac/.local/node-22/bin/node";
const pnpm = "/Users/mac/bin/pnpm";
const mysqlSocket = "/private/tmp/shensi-real-trial-3310.sock";
const childScript = fileURLToPath(new URL("./real-trial-child.mjs", import.meta.url));
const sidecarContainerScript = fileURLToPath(new URL(
  "./real-trial-sidecar-container.mjs", import.meta.url
));
const requiredRuntimeRecords = Object.freeze([
  "mysql", "tunnel", "backend", "sidecar", "frontend", "gateway"
]);
const trialStatusPublicTimeoutMs = 5_000;

async function isTrialPublicOriginReachable(origin, options = {}) {
  let healthUrl;
  try {
    healthUrl = new URL("/api/health", origin);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(healthUrl.protocol)) return false;
  try {
    const response = await (options.fetchImpl ?? fetch)(healthUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(trialStatusPublicTimeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function createTrialDockerDependencyShim(
  hostEnvironment = process.env
) {
  const temporaryRoot = hostEnvironment?.TMPDIR ?? "/tmp";
  if (!isAbsolute(temporaryRoot)) {
    throw new Error("TRIAL_DOCKER_SHIM_TEMP_ROOT_INVALID");
  }
  const directory = await mkdtemp(resolve(
    temporaryRoot, "shensi-colima-docker-shim-"
  ));
  await chmod(directory, 0o700);
  const created = await lstat(directory);
  if (!created.isDirectory() || created.isSymbolicLink()
    || (created.mode & 0o077)) {
    throw new Error("TRIAL_DOCKER_SHIM_DIRECTORY_INVALID");
  }
  const executable = resolve(directory, "docker");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
    flag: "wx"
  });
  await chmod(executable, 0o700);
  let cleaned = false;
  return {
    directory,
    async cleanup() {
      if (cleaned) return;
      const current = await lstat(directory).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (current && (current.isSymbolicLink() || !current.isDirectory()
        || current.dev !== created.dev || current.ino !== created.ino)) {
        throw new Error("TRIAL_DOCKER_SHIM_DIRECTORY_REPLACED");
      }
      if (current) await rm(directory, { recursive: true, force: false });
      cleaned = true;
    }
  };
}

export function effectiveTrialOutreachActionsEnabled(input) {
  return input?.requested === true
    && input?.sidecarReady === true
    && input?.baseUrl === `http://127.0.0.1:${TRIAL_PORTS.mediaCrawler}`
    && typeof input?.serviceSecretFile === "string"
    && input.serviceSecretFile.length > 0;
}

export function assertOutreachQueueAuditEmpty(value) {
  const counts = value?.counts;
  const keys = ["queued", "blockedByPredecessor", "executing"];
  if (!counts || typeof counts !== "object"
    || Object.keys(counts).sort().join(",") !== [...keys].sort().join(",")
    || keys.some((key) => !Number.isSafeInteger(counts[key]) || counts[key] < 0)
    || !Number.isSafeInteger(value?.nonterminalCount)
    || value.nonterminalCount < 0
    || value.nonterminalCount !== keys.reduce((total, key) => total + counts[key], 0)) {
    throw new Error("TRIAL_OUTREACH_QUEUE_AUDIT_INVALID");
  }
  if (value.nonterminalCount !== 0) {
    throw new Error("TRIAL_OUTREACH_QUEUE_NOT_EMPTY");
  }
  return value;
}

export async function auditTrialOutreachQueue({ databaseUrl, createConnection }) {
  let connection;
  try {
    const connect = createConnection ?? (async (url) => {
      const mysql = await import(new URL(
        "../backend/node_modules/mysql2/promise.js",
        import.meta.url
      ));
      return mysql.createConnection(url);
    });
    connection = await connect(databaseUrl);
    await connection.query("START TRANSACTION READ ONLY");
    const [rows] = await connection.query(`SELECT
      COALESCE(SUM(status='queued'),0) AS queued_count,
      COALESCE(SUM(status='blocked_by_predecessor'),0) AS blocked_count,
      COALESCE(SUM(status='executing'),0) AS executing_count
      FROM acquisition_outreach_actions
      WHERE status IN ('queued','blocked_by_predecessor','executing')`);
    await connection.rollback();
    const row = Array.isArray(rows) ? rows[0] : null;
    const counts = {
      queued: Number(row?.queued_count),
      blockedByPredecessor: Number(row?.blocked_count),
      executing: Number(row?.executing_count)
    };
    return { counts, nonterminalCount: counts.queued
      + counts.blockedByPredecessor + counts.executing };
  } catch {
    throw new Error("TRIAL_OUTREACH_QUEUE_AUDIT_FAILED");
  } finally {
    await connection?.end().catch(() => {});
  }
}

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
function expectedPsCommand(record) { return expectedOwnedProcessCommand(record); }
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
  return readOwnedProcessCommand(pid);
}
export async function isRecordedProcess(record, options = {}) {
  if (!validRecord(record)) return false;
  if (record.processStartToken !== undefined) {
    return await inspectOwnedProcess(record, options) === "owned";
  }
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
function runtimeRootFromLifecycle(runtime) {
  if (typeof runtime?.root === "string" && runtime.root.length > 0) {
    return resolve(runtime.root);
  }
  if (typeof runtime?.pidsDirectory === "string"
    && runtime.pidsDirectory.length > 0) {
    return dirname(resolve(runtime.pidsDirectory));
  }
  return null;
}
async function runtimeSidecarEnvironment(runtime) {
  const configured = runtime?.environment?.MEDIACRAWLER_ENCRYPTED_VOLUME;
  if (typeof configured === "string" && configured.length > 0) {
    return { MEDIACRAWLER_ENCRYPTED_VOLUME: configured };
  }
  const root = runtimeRootFromLifecycle(runtime);
  if (!root) return null;
  const volume = resolve(root, "state/mediacrawler");
  try {
    const info = await lstat(volume);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("TRIAL_SIDECAR_VOLUME_INVALID");
    }
    return { MEDIACRAWLER_ENCRYPTED_VOLUME: volume };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
function sidecarLifecycleOptions(options = {}) {
  const hostEnvironment = options.hostEnvironment ?? process.env;
  return {
    colimaBinary: options.colimaBinary
      ?? process.env.SHENSI_TRIAL_COLIMA_BIN
      ?? DEFAULT_TRIAL_COLIMA_BINARY,
    execFile: options.sidecarExecFile,
    hostEnvironment: oneShotEnvironment(
      {},
      { LIMA_HOME: options.limaHome
        ?? hostEnvironment.SHENSI_TRIAL_LIMA_HOME
        ?? hostEnvironment.LIMA_HOME
        ?? DEFAULT_TRIAL_LIMA_HOME },
      hostEnvironment
    )
  };
}
async function virtualHostProfilePresent(limaHome) {
  const instanceDirectory = resolve(
    limaHome, `colima-${TRIAL_COLIMA_PROFILE}`
  );
  try {
    const info = await lstat(instanceDirectory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("TRIAL_COLIMA_PROFILE_DIRECTORY_INVALID");
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
async function defaultSignalProcessGroup(pid, signal) { process.kill(-pid, signal); }
export async function stopTrialRuntime(runtime, options = {}) {
  const records = runtime.records ?? await readRuntimeRecords(runtime);
  const useSharedOwnership = options.isRecordedProcess === undefined
    && options.kill === undefined
    && !(options.readProcessCommand !== undefined
      && options.readProcessStartToken === undefined);
  if (useSharedOwnership) {
    const attested = [];
    const preflightStale = [];
    for (const record of records) {
      try {
        attested.push(await attestOwnedProcess(record, options));
      } catch (caught) {
        if (caught?.message === "PROCESS_OWNERSHIP_PROCESS_MISSING") {
          await removeMissingRecord(record);
          continue;
        }
        if (caught?.message === "PROCESS_OWNERSHIP_PROCESS_REUSED") {
          preflightStale.push(record.name);
          continue;
        }
        throw caught;
      }
    }
    const stoppedOwned = await stopOwnedProcesses(attested, {
      ...options,
      waitMilliseconds: options.waitMilliseconds ?? trialStopWaitMilliseconds,
      removeRecord: options.removeRecord ?? (async (path) => {
        await unlink(path).catch((caught) => {
          if (caught?.code !== "ENOENT") throw caught;
        });
      })
    });
    const result = {
      stopped: [...stoppedOwned.stopped],
      stale: [...preflightStale, ...stoppedOwned.stale]
    };
    const sidecarEnvironment = await runtimeSidecarEnvironment(runtime);
    if (sidecarEnvironment) {
      result.sidecarContainer = await (
        options.cleanupSidecarContainer ?? cleanupTrialSidecarContainer
      )(sidecarEnvironment, sidecarLifecycleOptions(options));
    }
    return result;
  }
  const readCommand = options.readProcessCommand ?? readProcessCommand;
  const signal = options.signalProcessGroup
    ?? (options.kill ? async (pid, signalName) => options.kill(records.find((record) => record.pid === pid), signalName) : defaultSignalProcessGroup);
  const signalIfPresent = async (record, signalName) => {
    try {
      await signal(record.pid, signalName);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH" || await readCommand(record.pid) !== null) {
        throw error;
      }
      return false;
    }
  };
  const stopped = [], stale = [];
  for (const record of [...records].reverse()) {
    const matches = options.isRecordedProcess ? await options.isRecordedProcess(record) : await isRecordedProcess(record, { readProcessCommand: readCommand });
    if (!matches) {
      if ((await readCommand(record.pid)) === null) {
        await removeMissingRecord(record);
      } else stale.push(record.name);
      continue;
    }
    if (!await signalIfPresent(record, "SIGTERM")) {
      stopped.push(record.name);
      if (record.path) await unlink(record.path).catch(() => {});
      continue;
    }
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
    if (!await signalIfPresent(record, "SIGKILL")) {
      stopped.push(record.name);
      if (record.path) await unlink(record.path).catch(() => {});
      continue;
    }
    const killed = options.waitForExit
      ? await options.waitForExit(record)
      : await waitForRecordedExit(record, readCommand, options.sleep);
    if (killed) {
      stopped.push(record.name);
      if (record.path) await unlink(record.path).catch(() => {});
    } else stale.push(record.name);
  }
  const result = { stopped, stale };
  const sidecarEnvironment = await runtimeSidecarEnvironment(runtime);
  if (sidecarEnvironment) {
    result.sidecarContainer = await (
      options.cleanupSidecarContainer ?? cleanupTrialSidecarContainer
    )(sidecarEnvironment, sidecarLifecycleOptions(options));
  }
  return result;
}
export function trialStopWaitMilliseconds(record) {
  return record?.name === "sidecar" ? 30_000 : 5_000;
}
async function waitForRecordedExit(record, readCommand, sleep = (milliseconds) => new Promise((resolveTimer) => setTimeout(resolveTimer, milliseconds))) {
  const deadline = Date.now() + trialStopWaitMilliseconds(record);
  while (Date.now() < deadline) {
    if ((await readCommand(record.pid)) === null) return true;
    await sleep(100);
  }
  return (await readCommand(record.pid)) === null;
}
async function waitForExit(value) { return new Promise((resolveExit, rejectExit) => { value.once?.("error", rejectExit); value.once?.("exit", (code, signal) => code === 0 ? resolveExit() : rejectExit(new Error(`TRIAL_CHILD_EXIT:${signal ?? code}`))); }); }
async function defaultRunCommand(command, args, options) { const value = child(command, args, { ...options, stdio: "inherit" }, nodeSpawn); await waitForExit(value); }
function oneShotEnvironment(
  environment, overrides = {}, hostEnvironment = process.env
) {
  return {
    PATH: hostEnvironment?.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: hostEnvironment?.HOME ?? "",
    LIMA_HOME: hostEnvironment?.SHENSI_TRIAL_LIMA_HOME
      ?? hostEnvironment?.LIMA_HOME
      ?? DEFAULT_TRIAL_LIMA_HOME,
    TMPDIR: hostEnvironment?.TMPDIR ?? "/tmp",
    LANG: hostEnvironment?.LANG ?? "C.UTF-8",
    ...Object.fromEntries(Object.entries(hostEnvironment ?? {})
      .filter(([key, value]) => /^(?:HTTP|HTTPS|NO|ALL)_PROXY$/iu.test(key)
        && typeof value === "string" && value.length > 0)),
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
  const hostEnvironment = options.hostEnvironment ?? process.env;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const colimaBinary = options.colimaBinary
    ?? process.env.SHENSI_TRIAL_COLIMA_BIN
    ?? DEFAULT_TRIAL_COLIMA_BINARY;
  const limactlBinary = options.limactlBinary
    ?? process.env.SHENSI_TRIAL_LIMACTL_BIN
    ?? DEFAULT_TRIAL_LIMACTL_BINARY;
  const limaHome = options.limaHome
    ?? hostEnvironment.SHENSI_TRIAL_LIMA_HOME
    ?? hostEnvironment.LIMA_HOME
    ?? DEFAULT_TRIAL_LIMA_HOME;
  const usesVirtualSidecar = !options.sidecarCommand;
  let virtualHostStarted = false;
  const ensureVirtualHost = async () => {
    if (virtualHostStarted) return;
    const profilePresent = await (
      options.isVirtualHostProfilePresent ?? virtualHostProfilePresent
    )(limaHome);
    const baseEnvironment = oneShotEnvironment(
      {}, { LIMA_HOME: limaHome }, hostEnvironment
    );
    if (profilePresent) {
      await runCommand(limactlBinary, [
        "start", `colima-${TRIAL_COLIMA_PROFILE}`, "--tty=false"
      ], { cwd: repositoryRoot, env: baseEnvironment });
    } else {
      const shim = await (
        options.createDockerDependencyShim
          ?? createTrialDockerDependencyShim
      )(hostEnvironment);
      try {
        if (!shim || typeof shim.cleanup !== "function"
          || typeof shim.directory !== "string"
          || !isAbsolute(shim.directory)
          || /[:\r\n]/u.test(shim.directory)) {
          throw new Error("TRIAL_DOCKER_SHIM_INVALID");
        }
        await runCommand(colimaBinary, [
          "--profile", TRIAL_COLIMA_PROFILE, "start",
          "--runtime", "docker", "--activate=false",
          "--cpus", "4", "--memory", "6", "--disk", "30",
          "--mount-type", "virtiofs", "--downloader", "curl"
        ], {
          cwd: repositoryRoot,
          env: {
            ...baseEnvironment,
            PATH: `${shim.directory}:${baseEnvironment.PATH}`
          }
        });
      } finally {
        await shim?.cleanup?.();
      }
    }
    virtualHostStarted = true;
  };
  const requestedRuntimeRoot = resolve(
    options.runtimeRoot
      ?? process.env.SHENSI_TRIAL_RUNTIME_ROOT
      ?? resolve(repositoryRoot, ".runtime/real-trial")
  );
  const runtimeCloudflared = options.preparedCloudflaredBinary
    ?? await (options.prepareCloudflared ?? prepareTrialCloudflared)(
      requestedRuntimeRoot,
      {
        cloudflaredBinary: options.cloudflaredBinary,
        hostEnvironment
      }
    );
  const retainedSidecarEnvironment = usesVirtualSidecar
    ? await runtimeSidecarEnvironment({ root: requestedRuntimeRoot })
    : null;
  if (retainedSidecarEnvironment) {
    await ensureVirtualHost();
    await (options.cleanupSidecarContainer
      ?? cleanupTrialSidecarContainer)(
      retainedSidecarEnvironment,
      sidecarLifecycleOptions({ ...options, colimaBinary, limaHome })
    );
  }
  const preparedRuntime = await (options.prepare ?? prepareTrialRuntime)(
    repositoryRoot,
    { ...options, runtimeRoot: requestedRuntimeRoot, cloudflared: undefined }
  );
  const runtime = {
    ...preparedRuntime,
    environment: {
      ...preparedRuntime.environment,
      ...trialOutreachEnvironment(
        preparedRuntime.environment.DOUYIN_OUTREACH_ACTIONS_ENABLED === "true"
      )
    }
  };
  const frontendReleaseDirectory = resolve(runtime.root, "release/frontend");
  const spawn = options.spawn ?? nodeSpawn, available = options.isPortAvailable ?? isTrialPortAvailable, readCommand = options.readProcessCommand ?? readProcessCommand, waitForHealth = options.waitForHealth ?? defaultWaitForHealth, waitForMysql = options.waitForMysql ?? defaultWaitForMysql, readSidecarSecret = options.readSidecarSecret ?? ((path) => readFile(path, "utf8")), wrapCommands = options.wrapCommands !== false;
  const records = [];
  const run = async (name, command, args, environment = {}) => {
    const nonce = randomBytes(16).toString("hex"), logPath = resolve(runtime.logsDirectory, `${name}.log`);
    await privateDirectory(runtime.logsDirectory); await privateLogFile(logPath);
    const wrappedCommand = wrapCommands ? node : command;
    const wrappedArgs = wrapCommands ? [childScript, "--runtime-nonce", nonce, "--log", logPath, "--", Buffer.from(JSON.stringify({ command, args })).toString("base64url")] : args;
    const value = child(wrappedCommand, wrappedArgs, { cwd: repositoryRoot, detached: wrapCommands, stdio: "ignore", env: oneShotEnvironment(runtime.environment, { ...environment, HOST: "127.0.0.1" }, hostEnvironment) }, spawn);
    const record = { ...await writeRecord(runtime, { name, pid: value.pid, command: wrappedCommand, args: wrappedArgs, nonce }), child: value };
    if (wrapCommands) value.unref?.();
    records.push(record); return record;
  };
  const killKnown = async (pid, signal) => records.find((record) => record.pid === pid)?.child?.kill?.(signal);
  const signalKnown = options.signalProcessGroup
    ?? (spawn === nodeSpawn && wrapCommands ? defaultSignalProcessGroup : killKnown);
  try {
    await clearMissingRecordsBeforeStart(runtime, readCommand);
    for (const port of Object.values(TRIAL_PORTS)) if (!await available(port)) throw new Error(`TRIAL_PORT_OCCUPIED:${port}`);
    await runCommand(pnpm, ["--filter", "./backend", "build"], { cwd: repositoryRoot, env: oneShotEnvironment(runtime.environment, { NODE_ENV: "production" }) });
    await rm(frontendReleaseDirectory, { recursive: true, force: true });
    await mkdir(frontendReleaseDirectory, { recursive: true, mode: 0o700 });
    await chmod(frontendReleaseDirectory, 0o700);
    await runCommand(pnpm, ["--filter", "./frontend", "exec", "tsc", "-b"], { cwd: repositoryRoot, env: oneShotEnvironment(runtime.environment, { NODE_ENV: "production" }) });
    await runCommand(pnpm, ["--filter", "./frontend", "exec", "vite", "build", "--outDir", frontendReleaseDirectory, "--emptyOutDir"], { cwd: repositoryRoot, env: oneShotEnvironment(runtime.environment, { NODE_ENV: "production" }) });
    let sidecarCommand = options.sidecarCommand;
    if (!sidecarCommand) {
      await ensureVirtualHost();
      const build = virtualSidecarBuildInvocation(
        repositoryRoot,
        runtime.environment.DOUYIN_ACTION_VISUAL_LOCATOR,
        colimaBinary
      );
      await runCommand(build.command, build.args, {
        cwd: repositoryRoot,
        env: oneShotEnvironment(
          runtime.environment, { LIMA_HOME: limaHome }, hostEnvironment
        )
      });
      sidecarCommand = [node, sidecarContainerScript];
    }
    const mysqld = options.mysqlBinary ?? resolve(options.mysqlBasedir ?? process.env.SHENSI_TRIAL_MYSQL_BASEDIR ?? mysqlBasedir, "bin/mysqld"), basedir = options.mysqlBasedir ?? process.env.SHENSI_TRIAL_MYSQL_BASEDIR ?? mysqlBasedir;
    const mysqlContents = await readdir(runtime.mysqlDirectory).catch(() => []);
    if (!mysqlContents.length) await runCommand(mysqld, ["--no-defaults", `--basedir=${basedir}`, `--datadir=${runtime.mysqlDirectory}`, "--initialize-insecure"], { cwd: repositoryRoot, env: oneShotEnvironment(runtime.environment) });
    else if (!mysqlContents.includes("mysql")) throw new Error("TRIAL_MYSQL_DATADIR_INVALID");
    await run("mysql", mysqld, ["--no-defaults", `--basedir=${basedir}`, `--datadir=${runtime.mysqlDirectory}`, "--bind-address=127.0.0.1", `--port=${TRIAL_PORTS.mysql}`, `--socket=${mysqlSocket}`, "--mysqlx=OFF", `--pid-file=${resolve(runtime.stateDirectory, "mysql.pid")}`, `--log-error=${resolve(runtime.logsDirectory, "mysql-error.log")}`]);
    await waitForMysql({ mysqladmin: resolve(basedir, "bin/mysqladmin") });
    await runCommand(pnpm, ["--filter", "./backend", "exec", "tsx", "scripts/setup-trial-mysql.ts"], { cwd: repositoryRoot, env: oneShotEnvironment(runtime.environment, { SHENSI_TRIAL_MYSQL_ADMIN_URL: `mysql://root@127.0.0.1:${TRIAL_PORTS.mysql}/mysql` }) });
    const tunnel = await run("tunnel", runtimeCloudflared, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://127.0.0.1:${TRIAL_PORTS.gateway}`, "--http-host-header", `127.0.0.1:${TRIAL_PORTS.gateway}`]);
    const origin = await (options.waitForTunnelOrigin ?? waitForTunnelOrigin)(resolve(runtime.logsDirectory, "tunnel.log"));
    const backendCommand = options.backendCommand ?? [node, resolve(repositoryRoot, "backend/dist/server.js")], frontendCommand = options.frontendCommand ?? [node, resolve(repositoryRoot, "frontend/node_modules/vite/bin/vite.js"), "preview", resolve(repositoryRoot, "frontend"), "--outDir", frontendReleaseDirectory, "--host", "127.0.0.1", "--port", "5610", "--strictPort"], gatewayCommand = options.gatewayCommand ?? [node, "scripts/real-trial-gateway.mjs"];
    const bootstrapPassword = runtime.bootstrapPassword ?? randomBytes(32).toString("base64url");
    const temporaryBackend = await run("backend-bootstrap", backendCommand[0], backendCommand.slice(1), { PORT: String(TRIAL_PORTS.backend), CORS_ORIGINS: origin, NODE_ENV: "production", ...trialOutreachEnvironment(false), INITIAL_ADMIN_EMAIL: "internal-trial-bootstrap@shensi.local", INITIAL_ADMIN_PASSWORD: bootstrapPassword });
    await waitForHealth(`http://127.0.0.1:${TRIAL_PORTS.backend}/api/health`);
    await (options.provisionAdmin ?? defaultProvisionAdmin)({ backendOrigin: `http://127.0.0.1:${TRIAL_PORTS.backend}`, bootstrapPassword, runtime, email: "test@shensi.local", role: "admin", tenantId: "trial-pilot-001" });
    const bootstrapStop = await stopTrialRuntime({ records: [temporaryBackend] }, {
      isRecordedProcess: async () => true,
      signalProcessGroup: signalKnown
    });
    if (bootstrapStop.stale.length) throw new Error("TRIAL_BOOTSTRAP_STOP_FAILED");
    records.splice(records.indexOf(temporaryBackend), 1);
    await (options.waitForPortRelease ?? waitForPortRelease)(TRIAL_PORTS.backend, available);
    await run("sidecar", sidecarCommand[0], sidecarCommand.slice(1), { PORT: String(TRIAL_PORTS.mediaCrawler), NODE_ENV: "production" });
    const sidecarSecret = (await readSidecarSecret(runtime.environment.MEDIACRAWLER_SERVICE_SECRET_FILE)).trim();
    if (Buffer.byteLength(sidecarSecret) < 32) {
      throw new Error("TRIAL_SIDECAR_SECRET_INVALID");
    }
    await waitForHealth(`http://127.0.0.1:${TRIAL_PORTS.mediaCrawler}/internal/v1/health`, { headers: { authorization: `Bearer ${sidecarSecret}` } });
    const requestedOutreach = runtime.environment.DOUYIN_OUTREACH_ACTIONS_ENABLED === "true";
    const outreachEnabled = effectiveTrialOutreachActionsEnabled({
      requested: requestedOutreach,
      sidecarReady: true,
      baseUrl: runtime.environment.MEDIACRAWLER_BASE_URL,
      serviceSecretFile: runtime.environment.MEDIACRAWLER_SERVICE_SECRET_FILE
    });
    if (requestedOutreach && !outreachEnabled) {
      throw new Error("TRIAL_OUTREACH_GATEWAY_NOT_USABLE");
    }
    if (outreachEnabled) {
      const audit = await (options.auditOutreachQueue ?? auditTrialOutreachQueue)({
        databaseUrl: runtime.environment.DATABASE_URL
      });
      assertOutreachQueueAuditEmpty(audit);
    }
    await run("backend", backendCommand[0], backendCommand.slice(1), { PORT: String(TRIAL_PORTS.backend), CORS_ORIGINS: `${origin},http://127.0.0.1:${TRIAL_PORTS.gateway}`, NODE_ENV: "production", ...trialOutreachEnvironment(outreachEnabled), MEDIACRAWLER_BASE_URL: `http://127.0.0.1:${TRIAL_PORTS.mediaCrawler}` });
    await waitForHealth(`http://127.0.0.1:${TRIAL_PORTS.backend}/api/health`);
    await run("frontend", frontendCommand[0], frontendCommand.slice(1), { PORT: String(TRIAL_PORTS.frontend), NODE_ENV: "production" });
    await waitForHealth(`http://127.0.0.1:${TRIAL_PORTS.frontend}/`);
    await run("gateway", gatewayCommand[0], gatewayCommand.slice(1), { PORT: String(TRIAL_PORTS.gateway), NODE_ENV: "production", TRIAL_BACKEND_ORIGIN: `http://127.0.0.1:${TRIAL_PORTS.backend}`, TRIAL_FRONTEND_ORIGIN: `http://127.0.0.1:${TRIAL_PORTS.frontend}` });
    await waitForHealth(`http://127.0.0.1:${TRIAL_PORTS.gateway}/healthz`);
    await writeFile(resolve(runtime.root, "status.json"), JSON.stringify({ version: 1, running: true, origin, records: records.map(({ name, pid }) => ({ name, pid })) }), { mode: 0o600 });
    return { ...runtime, origin, records };
  } catch (error) {
    await stopTrialRuntime({ ...runtime, records }, {
      isRecordedProcess: async () => true,
      signalProcessGroup: signalKnown,
      cleanupSidecarContainer: options.cleanupSidecarContainer,
      sidecarExecFile: options.sidecarExecFile,
      colimaBinary,
      limaHome,
      hostEnvironment
    });
    for (const record of records) if (!await isRecordedProcess(record)) await unlink(record.path).catch(() => {});
    throw error;
  }
}

export async function publishTrialRuntime(repositoryRoot, options = {}) {
  const runtimeRoot = resolve(
    options.runtimeRoot
      ?? process.env.SHENSI_TRIAL_RUNTIME_ROOT
      ?? resolve(repositoryRoot, ".runtime/real-trial")
  );
  const stop = options.stop ?? stopTrialRuntime;
  const start = options.start ?? startTrialRuntime;
  const verify = options.verify ?? (async (runtime) => {
    const { verifyTrialRuntime } = await import("./real-trial-verify.mjs");
    await verifyTrialRuntime({ origin: runtime.origin });
  });
  const removeStatus = options.removeStatus
    ?? ((path) => rm(path, { force: true }));
  const preparedCloudflaredBinary = await (
    options.prepareCloudflared ?? prepareTrialCloudflared
  )(runtimeRoot, {
    cloudflaredBinary: options.startOptions?.cloudflaredBinary,
    hostEnvironment: options.hostEnvironment ?? process.env
  });
  const stopped = await stop(
    { pidsDirectory: resolve(runtimeRoot, "pids") },
    options.stopOptions ?? {}
  );
  if (stopped.stale.length > 0) {
    throw new Error(`TRIAL_PUBLISH_STOP_INCOMPLETE:${stopped.stale.join(",")}`);
  }
  await removeStatus(resolve(runtimeRoot, "status.json"));
  const runtime = await start(repositoryRoot, {
    ...(options.startOptions ?? {}),
    preparedCloudflaredBinary,
    runtimeRoot
  });
  try {
    await verify(runtime);
  } catch (error) {
    const cleanup = await stop(runtime, options.cleanupStopOptions ?? {});
    await removeStatus(resolve(runtimeRoot, "status.json"));
    if (cleanup.stale.length > 0) {
      throw new Error(`TRIAL_PUBLISH_CLEANUP_INCOMPLETE:${cleanup.stale.join(",")}`);
    }
    throw error;
  }
  return { ...runtime, stopped: stopped.stopped };
}

export async function trialStatus(root, options = {}) {
  const sidecarEnvironment = await runtimeSidecarEnvironment({ root });
  let sidecarContainer;
  if (sidecarEnvironment) {
    sidecarContainer = await (
      options.inspectSidecarContainer ?? inspectTrialSidecarContainer
    )(sidecarEnvironment, sidecarLifecycleOptions(options));
  }
  try {
    const status = JSON.parse(await readFile(resolve(root, "status.json"), "utf8"));
    const records = await readRuntimeRecords({ pidsDirectory: resolve(root, "pids") });
    const projected = await Promise.all(records.map(async (record) => ({
      name: record.name,
      pid: record.pid,
      running: await isRecordedProcess(record, options)
    })));
    const names = projected.map((record) => record.name).sort();
    const complete = names.length === requiredRuntimeRecords.length
      && names.every((name, index) => name === [...requiredRuntimeRecords].sort()[index]);
    const processesRunning = complete
      && projected.every((record) => record.running)
      && (sidecarContainer?.running ?? true);
    const publicReachable = processesRunning
      ? await isTrialPublicOriginReachable(status?.origin, options)
      : false;
    return {
      ...status,
      processesRunning,
      publicReachable,
      running: status?.running === true && processesRunning && publicReachable,
      records: projected,
      ...(sidecarContainer ? { sidecarContainer } : {})
    };
  } catch {
    return {
      running: false,
      processesRunning: false,
      publicReachable: false,
      ...(sidecarContainer ? { sidecarContainer } : {})
    };
  }
}
export function parseTrialCli(argv) {
  const [command = "start", ...flags] = argv;
  if (!["start", "publish", "prepare", "stop", "status"].includes(command)) {
    throw new Error("TRIAL_CLI_ARGUMENT_INVALID");
  }
  const enableFlag = "--enable-outreach-after-empty-audit";
  const locatorPrefix = "--action-visual-locator=";
  let outreachActionsEnabled = false;
  let actionVisualLocator = "disabled";
  let locatorProvided = false;
  for (const flag of flags) {
    if (flag === enableFlag) {
      if (outreachActionsEnabled) throw new Error("TRIAL_CLI_ARGUMENT_INVALID");
      outreachActionsEnabled = true;
      continue;
    }
    if (flag.startsWith(locatorPrefix)) {
      if (locatorProvided) throw new Error("TRIAL_CLI_ARGUMENT_INVALID");
      locatorProvided = true;
      actionVisualLocator = validateActionVisualLocator(
        flag.slice(locatorPrefix.length)
      );
      continue;
    }
    throw new Error("TRIAL_CLI_ARGUMENT_INVALID");
  }
  if ((outreachActionsEnabled || locatorProvided)
    && !["start", "publish"].includes(command)) {
    throw new Error("TRIAL_CLI_FLAG_NOT_ALLOWED");
  }
  return { command, outreachActionsEnabled, actionVisualLocator };
}
async function main() {
  const root = resolve(import.meta.dirname, "..");
  const { command, outreachActionsEnabled, actionVisualLocator } = parseTrialCli(process.argv.slice(2));
  const runtimeRoot = resolve(process.env.SHENSI_TRIAL_RUNTIME_ROOT
    ?? resolve(root, ".runtime/real-trial"));
  if (command === "start") {
    const runtime = await startTrialRuntime(root, {
      outreachActionsEnabled, actionVisualLocator
    });
    console.log(`TRIAL_STARTED:${runtime.origin}`);
    return;
  }
  if (command === "publish") {
    const runtime = await publishTrialRuntime(root, {
      runtimeRoot,
      startOptions: { outreachActionsEnabled, actionVisualLocator }
    });
    console.log(`TRIAL_PUBLISHED:${runtime.origin}`);
    return;
  }
  if (command === "prepare") {
    await prepareTrialCloudflared(runtimeRoot, {
      hostEnvironment: process.env
    });
    const runtime = await prepareTrialRuntime(root, { runtimeRoot });
    console.log(`TRIAL_PREPARED:${runtime.root}`);
    return;
  }
  if (command === "stop") {
    const result = await stopTrialRuntime({
      pidsDirectory: resolve(runtimeRoot, "pids")
    });
    await rm(resolve(runtimeRoot, "status.json"), { force: true });
    if (result.stale.length) throw new Error("TRIAL_STOP_INCOMPLETE");
    console.log("TRIAL_STOPPED");
    return;
  }
  console.log(JSON.stringify(await trialStatus(runtimeRoot)));
}
if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
