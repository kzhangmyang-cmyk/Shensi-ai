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
    runCommand: async (command, args) => calls.push({ oneShot: [command, ...args] }),
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
  const tunnel = calls.findIndex((call) => call.command === "/fixture/cloudflared");
  const backend = calls.findIndex((call) => call.args?.includes("backend.js"));
  assert.ok(tunnel >= 0 && backend > tunnel);
  assert.equal(calls[backend].options.env.CORS_ORIGINS, "https://trial-fixture.trycloudflare.com");
  assert.deepEqual(
    (({ email, role, tenantId }) => ({ email, role, tenantId }))(calls.find((call) => call.provision)?.provision),
    { email: "test@shensi.local", role: "admin", tenantId: "trial-pilot-001" }
  );
  assert.ok(calls.filter((call) => call.options?.env?.HOST).every((call) => call.options.env.HOST === "127.0.0.1"));
  await stopTrialRuntime(runtime, { isRecordedProcess: async (record) => children.has(record.pid), kill: async (record) => calls.push({ stopped: record.pid }) });
  const stopped = calls.filter((call) => call.stopped).map((call) => call.stopped).sort((a, b) => a - b);
  assert.equal(stopped.includes(902), false);
  assert.deepEqual(stopped, [900, 901, 903, 904, 905, 906]);
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
  await writeRecord({ pidsDirectory }, record);
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

test("persisted lifecycle refuses symlinked PID records without signaling", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-records-symlink-"));
  const pidsDirectory = join(root, "pids");
  await mkdir(pidsDirectory, { recursive: true, mode: 0o700 });
  const target = join(root, "record.json");
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, join(pidsDirectory, "gateway.json"));
  await assert.rejects(readRuntimeRecords({ pidsDirectory }), /TRIAL_PID_RECORD_SYMLINK/u);
});
