import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  auditTrialOutreachQueue,
  assertOutreachQueueAuditEmpty,
  effectiveTrialOutreachActionsEnabled,
  isRecordedProcess,
  parseTrialCli,
  publishTrialRuntime,
  readRuntimeRecords,
  startTrialRuntime,
  stopTrialRuntime,
  trialStatus,
  writeRecord
} from "./real-trial-runtime.mjs";
import { verifyTrialRuntime } from "./real-trial-verify.mjs";

function child(pid) { const value = new EventEmitter(); value.pid = pid; value.stdout = new EventEmitter(); value.stderr = new EventEmitter(); value.kill = () => value.emit("exit", 0); return value; }

test("outreach runtime authorization requires request and a usable configured sidecar", () => {
  const configured = {
    baseUrl: "http://127.0.0.1:5612",
    serviceSecretFile: "/private/runtime/service-secret"
  };
  assert.equal(effectiveTrialOutreachActionsEnabled({
    requested: false, sidecarReady: false, ...configured
  }), false);
  assert.equal(effectiveTrialOutreachActionsEnabled({
    requested: false, sidecarReady: true, ...configured
  }), false);
  assert.equal(effectiveTrialOutreachActionsEnabled({
    requested: true, sidecarReady: false, ...configured
  }), false);
  assert.equal(effectiveTrialOutreachActionsEnabled({
    requested: true, sidecarReady: true, ...configured
  }), true);
  assert.equal(effectiveTrialOutreachActionsEnabled({
    requested: true, sidecarReady: true,
    baseUrl: "http://127.0.0.1:9999",
    serviceSecretFile: configured.serviceSecretFile
  }), false);
});

test("CLI outreach authorization is an explicit one-shot publish or start flag", () => {
  assert.deepEqual(parseTrialCli(["publish"]), {
    command: "publish", outreachActionsEnabled: false
  });
  assert.deepEqual(parseTrialCli([
    "publish", "--enable-outreach-after-empty-audit"
  ]), { command: "publish", outreachActionsEnabled: true });
  assert.deepEqual(parseTrialCli([
    "start", "--enable-outreach-after-empty-audit"
  ]), { command: "start", outreachActionsEnabled: true });
  assert.throws(() => parseTrialCli([
    "status", "--enable-outreach-after-empty-audit"
  ]), /TRIAL_CLI_FLAG_NOT_ALLOWED/u);
  assert.throws(() => parseTrialCli(["publish", "--unknown"]),
    /TRIAL_CLI_ARGUMENT_INVALID/u);
});

test("outreach queue audit accepts only an exact all-zero aggregate", () => {
  const empty = { counts: {
    queued: 0, blockedByPredecessor: 0, executing: 0
  }, nonterminalCount: 0 };
  assert.deepEqual(assertOutreachQueueAuditEmpty(empty), empty);
  assert.throws(() => assertOutreachQueueAuditEmpty({
    counts: { ...empty.counts, blockedByPredecessor: 1 },
    nonterminalCount: 1
  }), /TRIAL_OUTREACH_QUEUE_NOT_EMPTY/u);
  assert.throws(() => assertOutreachQueueAuditEmpty({
    nonterminalCount: 0
  }), /TRIAL_OUTREACH_QUEUE_AUDIT_INVALID/u);
});

test("outreach queue audit uses a read-only transaction and aggregates every nonterminal status", async () => {
  const calls = [];
  const connection = {
    async query(sql) {
      calls.push(sql.replace(/\s+/gu, " ").trim());
      if (/^SELECT\b/u.test(sql.trim())) return [[{
        queued_count: "2", blocked_count: "3", executing_count: "4"
      }], undefined];
      return [[], undefined];
    },
    async rollback() { calls.push("ROLLBACK"); },
    async end() { calls.push("END"); }
  };

  const result = await auditTrialOutreachQueue({
    databaseUrl: "mysql://fixture.invalid/trial",
    createConnection: async () => connection
  });

  assert.deepEqual(result, {
    counts: { queued: 2, blockedByPredecessor: 3, executing: 4 },
    nonterminalCount: 9
  });
  assert.equal(calls[0], "START TRANSACTION READ ONLY");
  assert.match(calls[1], /status IN \('queued','blocked_by_predecessor','executing'\)/u);
  assert.deepEqual(calls.slice(-2), ["ROLLBACK", "END"]);
});

test("publish stops the current trial before rebuilding the same retained runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-publish-"));
  const runtimeRoot = join(root, ".runtime", "real-trial");
  const calls = [];
  const published = await publishTrialRuntime(root, {
    runtimeRoot,
    stop: async (runtime) => {
      calls.push(["stop", runtime.pidsDirectory]);
      return { stopped: ["frontend", "backend"], stale: [] };
    },
    removeStatus: async (path) => calls.push(["remove-status", path]),
    start: async (repositoryRoot) => {
      calls.push(["start", repositoryRoot]);
      return { origin: "https://published.trycloudflare.com" };
    },
    verify: async (runtime) => calls.push(["verify", runtime.origin])
  });
  assert.deepEqual(calls, [
    ["stop", join(runtimeRoot, "pids")],
    ["remove-status", join(runtimeRoot, "status.json")],
    ["start", root],
    ["verify", "https://published.trycloudflare.com"]
  ]);
  assert.equal(published.origin, "https://published.trycloudflare.com");
  assert.deepEqual(published.stopped, ["frontend", "backend"]);
});

test("publish tears down the newly started runtime when verification fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-publish-verify-failure-"));
  const runtimeRoot = join(root, ".runtime", "real-trial");
  const calls = [];
  const started = {
    origin: "https://failed-verification.trycloudflare.com",
    records: [{ name: "backend", pid: 4444 }]
  };

  await assert.rejects(
    publishTrialRuntime(root, {
      runtimeRoot,
      stop: async (runtime) => {
        calls.push(["stop", runtime.records?.map((record) => record.name) ?? "old"]);
        return { stopped: [], stale: [] };
      },
      removeStatus: async (path) => calls.push(["remove-status", path]),
      start: async () => started,
      verify: async () => { throw new Error("fixture_verification_failed"); }
    }),
    /fixture_verification_failed/u
  );

  assert.deepEqual(calls, [
    ["stop", "old"],
    ["remove-status", join(runtimeRoot, "status.json")],
    ["stop", ["backend"]],
    ["remove-status", join(runtimeRoot, "status.json")]
  ]);
});

test("start failure signals the owned process group instead of only the wrapper", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-start-cleanup-group-"));
  const signals = [];
  let wrapperKillCalls = 0;
  const wrapper = child(4_445);
  wrapper.kill = () => {
    wrapperKillCalls += 1;
    wrapper.emit("exit", 0);
  };

  await assert.rejects(startTrialRuntime(root, {
    prepare: async () => ({
      root,
      stateDirectory: join(root, "state"),
      logsDirectory: join(root, "logs"),
      pidsDirectory: join(root, "pids"),
      toolsDirectory: join(root, "tools"),
      mysqlDirectory: join(root, "mysql"),
      secretsDirectory: join(root, "secrets"),
      environment: {}
    }),
    isPortAvailable: async () => true,
    runCommand: async () => undefined,
    spawn: () => wrapper,
    waitForMysql: async () => { throw new Error("fixture_mysql_start_failed"); },
    signalProcessGroup: async (pid, signal) => {
      signals.push([pid, signal]);
    },
    readProcessCommand: async () => null,
    mysqlBinary: "/fixture/mysqld"
  }), /fixture_mysql_start_failed/u);

  assert.deepEqual(signals, [[4_445, "SIGTERM"]]);
  assert.equal(wrapperKillCalls, 0);
});

test("trial status recomputes aggregate running from owned process records", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-status-"));
  const pidsDirectory = join(root, "pids");
  await writeFile(join(root, "status.json"), JSON.stringify({
    version: 1,
    running: true,
    origin: "https://stale.trycloudflare.com"
  }), { mode: 0o600 });
  await writeRecord({ pidsDirectory }, {
    name: "backend",
    pid: 4555,
    command: "/fixture/node",
    args: ["/fixture/backend.js", "--runtime-nonce", "9".repeat(32)],
    nonce: "9".repeat(32)
  });

  const status = await trialStatus(root, {
    readProcessCommand: async () => null
  });

  assert.equal(status.running, false);
  assert.deepEqual(status.records, [{
    name: "backend",
    pid: 4555,
    running: false
  }]);
});

test("trial status is running only when all six owned service records are live", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-status-complete-"));
  const pidsDirectory = join(root, "pids");
  await writeFile(join(root, "status.json"), JSON.stringify({
    version: 1,
    running: true,
    origin: "https://complete.trycloudflare.com"
  }), { mode: 0o600 });
  let pid = 4_600;
  let nonceValue = 1;
  for (const name of ["mysql", "tunnel", "backend", "sidecar", "frontend", "gateway"]) {
    const nonce = String(nonceValue++).repeat(32);
    await writeRecord({ pidsDirectory }, {
      name,
      pid: pid++,
      command: "/fixture/node",
      args: [name, "--runtime-nonce", nonce],
      nonce
    });
  }
  const status = await trialStatus(root, {
    readProcessCommand: async (recordPid) => {
      const record = (await readRuntimeRecords({ pidsDirectory }))
        .find((value) => value.pid === recordPid);
      return record?.expectedPsCommand ?? null;
    }
  });
  assert.equal(status.running, true);
});

test("supervisor orders isolated loopback processes around the tunnel origin and stops only recorded children", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-runtime-"));
  const calls = [];
  const children = new Map();
  let nextPid = 900;
  const runtime = await startTrialRuntime(root, {
    prepare: async () => ({ root, environmentFile: join(root, "trial.env"), stateDirectory: join(root, "state"), logsDirectory: join(root, "logs"), pidsDirectory: join(root, "pids"), toolsDirectory: join(root, "tools"), mysqlDirectory: join(root, "mysql"), secretsDirectory: join(root, "secrets"), environment: { DATABASE_URL: "mysql://shensi_trial_app:fixture@127.0.0.1:3310/shensi_trial", SHENSI_TRIAL_APP_PASSWORD_FILE: join(root, "secrets/app-password"), MEDIACRAWLER_BASE_URL: "http://127.0.0.1:5612", MEDIACRAWLER_SERVICE_SECRET_FILE: join(root, "secrets/service-secret"), DOUYIN_OUTREACH_ACTIONS_ENABLED: "true" } }),
    isPortAvailable: async () => true,
    wrapCommands: false,
    runCommand: async (command, args, options) => calls.push({ oneShot: [command, ...args], options }),
    waitForMysql: async () => calls.push({ mysqlReady: true }),
    waitForTunnelOrigin: async () => "https://trial-fixture.trycloudflare.com",
    readSidecarSecret: async () => "s".repeat(40),
    spawn: (command, args, options) => { const value = child(nextPid++); children.set(value.pid, value); calls.push({ command, args, options, pid: value.pid }); if (command.includes("cloudflared")) queueMicrotask(() => value.stderr.emit("data", "https://trial-fixture.trycloudflare.com")); return value; },
    waitForHealth: async (url) => calls.push({ health: url }),
    provisionAdmin: async (input) => calls.push({ provision: input }),
    auditOutreachQueue: async () => {
      calls.push({ outreachQueueAudit: true });
      return { counts: {
        queued: 0, blockedByPredecessor: 0, executing: 0
      }, nonterminalCount: 0 };
    },
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
  const backendCalls = calls.filter((call) => call.args?.includes("backend.js"));
  const backend = calls.findIndex((call) => call === backendCalls.at(-1));
  assert.ok(tunnel >= 0 && backend > tunnel);
  assert.equal(calls[backend].options.env.CORS_ORIGINS, "https://trial-fixture.trycloudflare.com");
  assert.equal(backendCalls[0].options.env.DOUYIN_OUTREACH_ACTIONS_ENABLED, "false");
  assert.equal(backendCalls[1].options.env.DOUYIN_OUTREACH_ACTIONS_ENABLED, "true");
  const audit = calls.findIndex((call) => call.outreachQueueAudit);
  const sidecar = calls.findIndex((call) => call.args?.includes("sidecar.js"));
  assert.ok(audit > calls.findIndex((call) => call.provision));
  assert.ok(sidecar >= 0 && sidecar < audit);
  assert.ok(audit < backend);
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
    readSidecarSecret: async () => "s".repeat(40),
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
  assert.equal(frontend.args[1], "preview");
  assert.match(frontend.args[2], /frontend$/u);
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
