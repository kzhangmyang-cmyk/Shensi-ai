import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startTrialRuntime, stopTrialRuntime } from "./real-trial-runtime.mjs";

function child(pid) { const value = new EventEmitter(); value.pid = pid; value.stdout = new EventEmitter(); value.stderr = new EventEmitter(); value.kill = () => value.emit("exit", 0); return value; }

test("supervisor orders isolated loopback processes around the tunnel origin and stops only recorded children", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-runtime-"));
  const calls = [];
  const children = new Map();
  let nextPid = 900;
  const runtime = await startTrialRuntime(root, {
    prepare: async () => ({ root, environmentFile: join(root, "trial.env"), stateDirectory: join(root, "state"), logsDirectory: join(root, "logs"), pidsDirectory: join(root, "pids"), toolsDirectory: join(root, "tools"), mysqlDirectory: join(root, "mysql"), secretsDirectory: join(root, "secrets"), environment: { DATABASE_URL: "mysql://shensi_trial_app:fixture@127.0.0.1:3310/shensi_trial", SHENSI_TRIAL_APP_PASSWORD_FILE: join(root, "secrets/app-password"), MEDIACRAWLER_SERVICE_SECRET_FILE: join(root, "secrets/service-secret") } }),
    isPortAvailable: async () => true,
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
  assert.equal(calls[0].command, "/fixture/mysqld");
  const tunnel = calls.findIndex((call) => call.command === "/fixture/cloudflared");
  const backend = calls.findIndex((call) => call.args?.includes("backend.js"));
  assert.ok(tunnel >= 0 && backend > tunnel);
  assert.equal(calls[backend].options.env.CORS_ORIGINS, "https://trial-fixture.trycloudflare.com");
  assert.deepEqual(calls.find((call) => call.provision)?.provision, { email: "test@shensi.local", role: "admin", tenantId: "trial-pilot-001" });
  assert.ok(calls.filter((call) => call.options?.env?.HOST).every((call) => call.options.env.HOST === "127.0.0.1"));
  await stopTrialRuntime(runtime, { isRecordedProcess: async (record) => children.has(record.pid), kill: async (record) => calls.push({ stopped: record.pid }) });
  assert.deepEqual(calls.filter((call) => call.stopped).map((call) => call.stopped).sort((a, b) => a - b), [...children.keys()].sort((a, b) => a - b));
});
