import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isRecordedProcess,
  readRuntimeRecords,
  startTrialRuntime,
  stopTrialRuntime,
  writeRecord
} from "./real-trial-runtime.mjs";
import { verifyTrialRuntime } from "./real-trial-verify.mjs";

function child(pid) { const value = new EventEmitter(); value.pid = pid; value.stdout = new EventEmitter(); value.stderr = new EventEmitter(); value.kill = () => value.emit("exit", 0); return value; }

test("supervisor orders isolated loopback processes around the tunnel origin and stops only recorded children", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-runtime-"));
  const calls = [];
  const children = new Map();
  let nextPid = 900;
  const runtime = await startTrialRuntime(root, {
    prepare: async () => ({ root, environmentFile: join(root, "trial.env"), stateDirectory: join(root, "state"), logsDirectory: join(root, "logs"), pidsDirectory: join(root, "pids"), toolsDirectory: join(root, "tools"), mysqlDirectory: join(root, "mysql"), secretsDirectory: join(root, "secrets"), environment: { DATABASE_URL: "mysql://shensi_trial_app:fixture@127.0.0.1:3310/shensi_trial", SHENSI_TRIAL_APP_PASSWORD_FILE: join(root, "secrets/app-password"), MEDIACRAWLER_SERVICE_SECRET_FILE: join(root, "secrets/service-secret") } }),
    isPortAvailable: async () => true,
    wrapCommands: false,
    runCommand: async (command, args, options) => calls.push({ oneShot: [command, ...args], options }),
    waitForMysql: async () => calls.push({ mysqlReady: true }),
    waitForTunnelOrigin: async () => "https://trial-fixture.trycloudflare.com",
    readSidecarSecret: async () => "fixture-sidecar-secret",
    spawn: (command, args, options) => { const value = child(nextPid++); children.set(value.pid, value); calls.push({ command, args, options, pid: value.pid }); if (command.includes("cloudflared")) queueMicrotask(() => value.stderr.emit("data", "https://trial-fixture.trycloudflare.com")); return value; },
    waitForHealth: async (url) => calls.push({ health: url }),
    provisionAdmin: async (input) => calls.push({ provision: input }),
    mysqlBinary: "/fixture/mysqld",
    cloudflaredBinary: "/fixture/cloudflared",
    backendCommand: ["node", "backend.js"],
    frontendCommand: ["node", "frontend.js"],
    sidecarCommand: ["node", "sidecar.js"],
    gatewayCommand: ["node", "gateway.js"]
  });
  assert.equal(calls.find((call) => call.command === "/fixture/mysqld")?.command, "/fixture/mysqld");
  const mysql = calls.find((call) => call.command === "/fixture/mysqld");
  assert.ok(mysql.args.includes("--socket=/private/tmp/shensi-real-trial-3310.sock"));
  const tunnel = calls.findIndex((call) => call.command === "/fixture/cloudflared");
  const backend = calls.findIndex((call) => call.args?.includes("backend.js"));
  assert.ok(tunnel >= 0 && backend > tunnel);
  assert.equal(calls[backend].options.env.CORS_ORIGINS, "https://trial-fixture.trycloudflare.com");
  assert.deepEqual(
    (({ email, role, tenantId }) => ({ email, role, tenantId }))(calls.find((call) => call.provision)?.provision),
    { email: "test@shensi.local", role: "admin", tenantId: "trial-pilot-001" }
  );
  assert.ok(calls.filter((call) => call.options?.env?.HOST).every((call) => call.options.env.HOST === "127.0.0.1"));
  const oneShotCalls = calls.filter((call) => call.oneShot);
  assert.equal(oneShotCalls.length, 4);
  assert.ok(oneShotCalls.some((call) => call.oneShot.join(" ").includes("--filter ./backend exec tsx scripts/setup-trial-mysql.ts")));
  assert.ok(oneShotCalls.every((call) => typeof call.options.env.PATH === "string" && call.options.env.PATH.length > 0));
  assert.ok(oneShotCalls.every((call) => typeof call.options.env.HOME === "string" && call.options.env.HOME.length > 0));
  await stopTrialRuntime(runtime, { isRecordedProcess: async (record) => children.has(record.pid), kill: async (record) => calls.push({ stopped: record.pid }) });
  const stopped = calls.filter((call) => call.stopped).map((call) => call.stopped).sort((a, b) => a - b);
  assert.equal(stopped.includes(902), false);
  assert.deepEqual(stopped, [900, 901, 903, 904, 905, 906]);
});

test("supervisor wraps direct long-lived service commands so recorded wrapper PIDs remain authoritative", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-direct-commands-"));
  const calls = [];
  let nextPid = 1_100;
  await startTrialRuntime(root, {
    prepare: async () => ({
      root, environmentFile: join(root, "trial.env"), stateDirectory: join(root, "state"),
      logsDirectory: join(root, "logs"), pidsDirectory: join(root, "pids"),
      toolsDirectory: join(root, "tools"), mysqlDirectory: join(root, "mysql"),
      secretsDirectory: join(root, "secrets"),
      environment: {
        DATABASE_URL: "mysql://fixture", SHENSI_TRIAL_APP_PASSWORD_FILE: join(root, "password"),
        MEDIACRAWLER_SERVICE_SECRET_FILE: join(root, "sidecar-secret")
      }
    }),
    isPortAvailable: async () => true,
    runCommand: async () => undefined,
    waitForMysql: async () => undefined,
    waitForTunnelOrigin: async () => "https://trial-fixture.trycloudflare.com",
    readSidecarSecret: async () => "fixture-sidecar-secret",
    spawn: (command, args, options) => {
      const value = child(nextPid++);
      calls.push({ command, args, options, value });
      return value;
    },
    waitForHealth: async () => undefined,
    provisionAdmin: async () => undefined,
    mysqlBinary: "/fixture/mysqld",
    cloudflaredBinary: "/fixture/cloudflared"
  });
  const targets = calls.map((wrapper) => {
    const marker = wrapper.args.indexOf("--");
    return JSON.parse(Buffer.from(wrapper.args[marker + 1], "base64url").toString("utf8"));
  });
  const target = (suffix) => targets.find((item) => item.args[0]?.endsWith(suffix));
  const backend = target("backend/dist/server.js");
  const frontend = target("frontend/node_modules/vite/bin/vite.js");
  const sidecar = targets.find((item) => item.command.endsWith(
    "services/media-crawler/.venv/bin/uvicorn"
  ));
  assert.ok(backend && frontend && sidecar);
  assert.match(backend.command, /node$/u);
  assert.match(backend.args[0], /backend\/dist\/server\.js$/u);
  assert.match(frontend.command, /node$/u);
  assert.match(frontend.args[0], /frontend\/node_modules\/vite\/bin\/vite\.js$/u);
  assert.match(sidecar.command, /services\/media-crawler\/\.venv\/bin\/uvicorn$/u);
  assert.deepEqual(sidecar.args.slice(0, 2), ["shensi_adapter.app:app", "--app-dir"]);
});

test("verification checks local health, protected authentication, and public isolation", async () => {
  const calls = [];
  await verifyTrialRuntime({ origin: "http://127.0.0.1:5608", fetchImpl: async (url) => {
    calls.push(url);
    return { ok: url.endsWith("/healthz") || url.endsWith("/api/health") || url.endsWith("/internal/v1/health"), status: url.endsWith("/api/auth/me") ? 401 : url.endsWith("/internal/v1/health") ? 404 : 200 };
  } });
  assert.deepEqual(calls, ["http://127.0.0.1:5608/healthz", "http://127.0.0.1:5608/api/health", "http://127.0.0.1:5608/api/auth/me", "http://127.0.0.1:5608/internal/v1/health"]);
});

test("persisted lifecycle only signals a PID whose command and nonce still match", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-records-"));
  const pidsDirectory = join(root, "pids");
  await mkdir(pidsDirectory, { recursive: true, mode: 0o700 });
  const record = {
    name: "gateway", pid: 9123, command: "/fixture/node",
    args: ["/fixture/child.mjs", "--runtime-nonce", "a".repeat(32)],
    nonce: "a".repeat(32)
  };
  const written = await writeRecord({ pidsDirectory }, record);
  assert.equal(written.path, join(pidsDirectory, "gateway.json"));
  const [stored] = await readRuntimeRecords({ pidsDirectory });
  assert.equal(await isRecordedProcess(stored, {
    readProcessCommand: async () => "/fixture/node /fixture/child.mjs --runtime-nonce " + "a".repeat(32)
  }), true);
  assert.equal(await isRecordedProcess(stored, {
    readProcessCommand: async () => "/fixture/node /fixture/child.mjs --runtime-nonce " + "b".repeat(32)
  }), false);
  const signals = [];
  await stopTrialRuntime({ pidsDirectory }, {
    readProcessCommand: async () => "/fixture/node /fixture/child.mjs --runtime-nonce " + "b".repeat(32),
    signalProcessGroup: async (...call) => signals.push(call)
  });
  assert.deepEqual(signals, []);
  assert.equal(JSON.parse(await readFile(join(pidsDirectory, "gateway.json"), "utf8")).pid, 9123);
});

test("stop removes a record for a PID that no longer exists without signaling", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-records-missing-"));
  const pidsDirectory = join(root, "pids");
  const stored = await writeRecord({ pidsDirectory }, {
    name: "gateway", pid: 9124, command: "/fixture/node",
    args: ["/fixture/child.mjs", "--runtime-nonce", "d".repeat(32)],
    nonce: "d".repeat(32)
  });
  const signals = [];
  const result = await stopTrialRuntime({ records: [stored] }, {
    readProcessCommand: async () => null,
    signalProcessGroup: async (...call) => signals.push(call)
  });
  assert.deepEqual(signals, []);
  assert.deepEqual(result, { stopped: [], stale: [] });
  await assert.rejects(readFile(stored.path, "utf8"), /ENOENT/u);
});

test("start removes records for missing PIDs before the port preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-start-missing-"));
  const pidsDirectory = join(root, "pids");
  const stored = await writeRecord({ pidsDirectory }, {
    name: "retired", pid: 9125, command: "/fixture/node",
    args: ["/fixture/child.mjs", "--runtime-nonce", "e".repeat(32)],
    nonce: "e".repeat(32)
  });
  await assert.rejects(startTrialRuntime(root, {
    prepare: async () => ({ root, pidsDirectory }),
    readProcessCommand: async () => null,
    isPortAvailable: async () => false
  }), /TRIAL_PORT_OCCUPIED/u);
  await assert.rejects(readFile(stored.path, "utf8"), /ENOENT/u);
});

test("start preserves a record when its PID belongs to another process", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-start-reused-"));
  const pidsDirectory = join(root, "pids");
  const stored = await writeRecord({ pidsDirectory }, {
    name: "backend", pid: 9126, command: "/fixture/node",
    args: ["/fixture/child.mjs", "--runtime-nonce", "f".repeat(32)],
    nonce: "f".repeat(32)
  });
  const before = await readFile(stored.path, "utf8");
  await assert.rejects(startTrialRuntime(root, {
    prepare: async () => ({ root, pidsDirectory }),
    readProcessCommand: async () => "/different/process --runtime-nonce " + "f".repeat(32),
    isPortAvailable: async () => false
  }), /TRIAL_PID_RECORD_ACTIVE_OR_REUSED:backend/u);
  assert.equal(await readFile(stored.path, "utf8"), before);
});

test("persisted lifecycle refuses symlinked PID records without signaling", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-records-symlink-"));
  const pidsDirectory = join(root, "pids");
  await mkdir(pidsDirectory, { recursive: true, mode: 0o700 });
  const target = join(root, "record.json");
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, join(pidsDirectory, "gateway.json"));
  await assert.rejects(readRuntimeRecords({ pidsDirectory }), /TRIAL_PID_RECORD_SYMLINK/u);
});

test("stop removes an owned record when the expected process exits after TERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-record-exit-"));
  const pidsDirectory = join(root, "pids");
  const stored = await writeRecord({ pidsDirectory }, {
    name: "backend", pid: 9234, command: "/fixture/node",
    args: ["/fixture/child.mjs", "--runtime-nonce", "c".repeat(32)],
    nonce: "c".repeat(32)
  });
  const signals = [];
  const result = await stopTrialRuntime({ records: [{ ...stored, path: join(pidsDirectory, "backend.json") }] }, {
    isRecordedProcess: async () => true,
    signalProcessGroup: async (...call) => signals.push(call),
    waitForExit: async () => false,
    readProcessCommand: async () => null
  });
  assert.deepEqual(signals, [[9234, "SIGTERM"]]);
  assert.deepEqual(result, { stopped: ["backend"], stale: [] });
  await assert.rejects(readFile(join(pidsDirectory, "backend.json"), "utf8"), /ENOENT/u);
});
