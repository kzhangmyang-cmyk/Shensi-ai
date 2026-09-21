import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  auditTrialOutreachQueue,
  assertOutreachQueueAuditEmpty,
  createTrialDockerDependencyShim,
  effectiveTrialOutreachActionsEnabled,
  isRecordedProcess,
  parseTrialCli,
  publishTrialRuntime,
  readRuntimeRecords,
  startTrialRuntime,
  stopTrialRuntime,
  trialStatus,
  trialStopWaitMilliseconds,
  writeRecord
} from "./real-trial-runtime.mjs";
import { verifyTrialRuntime } from "./real-trial-verify.mjs";

function child(pid) { const value = new EventEmitter(); value.pid = pid; value.stdout = new EventEmitter(); value.stderr = new EventEmitter(); value.kill = () => value.emit("exit", 0); return value; }
async function fixturePrepareCloudflared(runtimeRoot) {
  return join(runtimeRoot, "tools", "cloudflared");
}

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

test("container-backed sidecar gets enough time to stop its owned browser", () => {
  assert.equal(trialStopWaitMilliseconds({ name: "sidecar" }), 30_000);
  assert.equal(trialStopWaitMilliseconds({ name: "backend" }), 5_000);
});

test("start removes the same runtime's owned orphan before prepare checks ports", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-orphan-preflight-"));
  const runtimeRoot = join(root, ".runtime", "real-trial");
  await mkdir(join(runtimeRoot, "state", "mediacrawler"), {
    recursive: true,
    mode: 0o700
  });
  const calls = [];
  await assert.rejects(startTrialRuntime(root, {
    runtimeRoot,
    prepareCloudflared: fixturePrepareCloudflared,
    hostEnvironment: {
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      LIMA_HOME: "/fixture/lima",
      TMPDIR: "/fixture/tmp",
      LANG: "C.UTF-8",
      HTTPS_PROXY: "http://127.0.0.1:7897"
    },
    runCommand: async (command, args, options) => {
      calls.push({ kind: "command", command, args, options });
    },
    isVirtualHostProfilePresent: async () => true,
    cleanupSidecarContainer: async (environment, options) => {
      calls.push({ kind: "cleanup", environment, options });
      return { exists: true, stopped: true, id: "a".repeat(64) };
    },
    prepare: async () => {
      calls.push({ kind: "prepare" });
      throw new Error("fixture_prepare_after_cleanup");
    }
  }), /fixture_prepare_after_cleanup/u);

  assert.deepEqual(calls.map((call) => call.kind), [
    "command", "cleanup", "prepare"
  ]);
  assert.equal(calls[0].command, "/Users/mac/bin/limactl");
  assert.deepEqual(calls[0].args, [
    "start", "colima-shensi-trial", "--tty=false"
  ]);
  assert.equal(calls[0].options.env.HOME.length > 0, true);
  assert.equal(calls[0].options.env.LIMA_HOME, "/fixture/lima");
  assert.equal(calls[0].options.env.HTTPS_PROXY, "http://127.0.0.1:7897");
  assert.equal(
    calls[1].environment.MEDIACRAWLER_ENCRYPTED_VOLUME,
    join(runtimeRoot, "state", "mediacrawler")
  );
});

test("first virtual-host bootstrap uses and removes only a private temporary Docker shim", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-first-profile-"));
  const runtimeRoot = join(root, ".runtime", "real-trial");
  await mkdir(join(runtimeRoot, "state", "mediacrawler"), {
    recursive: true,
    mode: 0o700
  });
  const calls = [];
  await assert.rejects(startTrialRuntime(root, {
    runtimeRoot,
    prepareCloudflared: fixturePrepareCloudflared,
    hostEnvironment: {
      PATH: "",
      HOME: "/fixture/home",
      TMPDIR: "/fixture/tmp",
      LANG: "C.UTF-8"
    },
    isVirtualHostProfilePresent: async () => false,
    createDockerDependencyShim: async () => ({
      directory: "/private/runtime/docker-shim",
      cleanup: async () => calls.push({ kind: "shim-cleanup" })
    }),
    runCommand: async (command, args, options) => {
      calls.push({ kind: "command", command, args, options });
    },
    cleanupSidecarContainer: async () => {
      calls.push({ kind: "container-cleanup" });
      return { exists: false, stopped: false, id: null };
    },
    prepare: async () => {
      calls.push({ kind: "prepare" });
      throw new Error("fixture_after_first_bootstrap");
    }
  }), /fixture_after_first_bootstrap/u);

  assert.deepEqual(calls.map((call) => call.kind), [
    "command", "shim-cleanup", "container-cleanup", "prepare"
  ]);
  assert.equal(calls[0].command, "/Users/mac/bin/colima");
  assert.deepEqual(calls[0].args, [
    "--profile", "shensi-trial", "start",
    "--runtime", "docker", "--activate=false",
    "--cpus", "4", "--memory", "6", "--disk", "30",
    "--mount-type", "virtiofs", "--downloader", "curl"
  ]);
  assert.equal(calls[0].options.env.PATH,
    "/private/runtime/docker-shim:/usr/bin:/bin:/usr/sbin:/sbin");
});

test("failed first virtual-host bootstrap still removes its private Docker shim", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-first-profile-failure-"));
  const runtimeRoot = join(root, ".runtime", "real-trial");
  await mkdir(join(runtimeRoot, "state", "mediacrawler"), {
    recursive: true,
    mode: 0o700
  });
  const calls = [];
  await assert.rejects(startTrialRuntime(root, {
    runtimeRoot,
    prepareCloudflared: fixturePrepareCloudflared,
    isVirtualHostProfilePresent: async () => false,
    createDockerDependencyShim: async () => ({
      directory: "/private/runtime/docker-shim",
      cleanup: async () => calls.push("shim-cleanup")
    }),
    runCommand: async () => {
      calls.push("colima-start");
      throw new Error("fixture_colima_start_failed");
    },
    prepare: async () => {
      calls.push("prepare");
      throw new Error("prepare_must_not_run");
    }
  }), /fixture_colima_start_failed/u);
  assert.deepEqual(calls, ["colima-start", "shim-cleanup"]);
});

test("default Docker dependency shim is private, minimal, and recoverably removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-docker-shim-test-"));
  const shim = await createTrialDockerDependencyShim({
    PATH: "/fixture/bin",
    HOME: "/fixture/home",
    TMPDIR: root,
    LANG: "C.UTF-8"
  });
  const directory = await lstat(shim.directory);
  const executable = await lstat(join(shim.directory, "docker"));
  assert.equal(directory.isDirectory(), true);
  assert.equal(directory.isSymbolicLink(), false);
  assert.equal(directory.mode & 0o077, 0);
  assert.equal(executable.isFile(), true);
  assert.equal(executable.isSymbolicLink(), false);
  assert.equal(executable.mode & 0o077, 0);
  assert.equal(await readFile(join(shim.directory, "docker"), "utf8"),
    "#!/bin/sh\nexit 0\n");
  await shim.cleanup();
  await assert.rejects(lstat(shim.directory), /ENOENT/u);
});

test("stop and status expose a same-runtime orphan container", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-orphan-status-"));
  const pidsDirectory = join(root, "pids");
  await mkdir(join(root, "state", "mediacrawler"), {
    recursive: true,
    mode: 0o700
  });
  const inspected = [];
  const orphan = {
    exists: true,
    running: true,
    id: "b".repeat(64)
  };
  const status = await trialStatus(root, {
    inspectSidecarContainer: async (environment) => {
      inspected.push(environment.MEDIACRAWLER_ENCRYPTED_VOLUME);
      return orphan;
    }
  });
  assert.equal(status.running, false);
  assert.deepEqual(status.sidecarContainer, orphan);

  const stopped = await stopTrialRuntime({ pidsDirectory }, {
    cleanupSidecarContainer: async (environment) => {
      inspected.push(environment.MEDIACRAWLER_ENCRYPTED_VOLUME);
      return { exists: true, stopped: true, id: orphan.id };
    }
  });
  assert.deepEqual(stopped.sidecarContainer, {
    exists: true,
    stopped: true,
    id: orphan.id
  });
  assert.deepEqual(inspected, [
    join(root, "state", "mediacrawler"),
    join(root, "state", "mediacrawler")
  ]);
});

test("CLI outreach authorization is an explicit one-shot publish or start flag", () => {
  assert.deepEqual(parseTrialCli(["publish"]), {
    command: "publish", outreachActionsEnabled: false,
    actionVisualLocator: "disabled"
  });
  assert.deepEqual(parseTrialCli([
    "publish", "--enable-outreach-after-empty-audit",
    "--action-visual-locator=rapidocr"
  ]), {
    command: "publish", outreachActionsEnabled: true,
    actionVisualLocator: "rapidocr"
  });
  assert.deepEqual(parseTrialCli([
    "start", "--action-visual-locator=rapidocr",
    "--enable-outreach-after-empty-audit"
  ]), {
    command: "start", outreachActionsEnabled: true,
    actionVisualLocator: "rapidocr"
  });
  assert.throws(() => parseTrialCli([
    "status", "--enable-outreach-after-empty-audit"
  ]), /TRIAL_CLI_FLAG_NOT_ALLOWED/u);
  for (const command of ["prepare", "status", "stop"]) {
    assert.throws(() => parseTrialCli([
      command, "--action-visual-locator=rapidocr"
    ]), /TRIAL_CLI_FLAG_NOT_ALLOWED/u);
  }
  for (const flag of [
    "--action-visual-locator=",
    "--action-visual-locator=RAPIDOCR",
    "--action-visual-locator= rapidocr ",
    "--action-visual-locator=ocr"
  ]) {
    assert.throws(() => parseTrialCli(["start", flag]),
      /DOUYIN_ACTION_VISUAL_LOCATOR_INVALID/u);
  }
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

test("publish preflights retained cloudflared before stopping and rebuilding the current trial", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-publish-"));
  const runtimeRoot = join(root, ".runtime", "real-trial");
  const calls = [];
  const hostEnvironment = { PATH: "/fixture/bin" };
  const published = await publishTrialRuntime(root, {
    runtimeRoot,
    hostEnvironment,
    prepareCloudflared: async (preparedRoot, options) => {
      calls.push(["prepare-cloudflared", preparedRoot, options]);
      return join(preparedRoot, "tools", "cloudflared");
    },
    stop: async (runtime) => {
      calls.push(["stop", runtime.pidsDirectory]);
      return { stopped: ["frontend", "backend"], stale: [] };
    },
    removeStatus: async (path) => calls.push(["remove-status", path]),
    startOptions: {
      outreachActionsEnabled: true,
      actionVisualLocator: "rapidocr",
      cloudflaredBinary: "/fixture/external-cloudflared"
    },
    start: async (repositoryRoot, options) => {
      calls.push(["start", repositoryRoot, options]);
      return { origin: "https://published.trycloudflare.com" };
    },
    verify: async (runtime) => calls.push(["verify", runtime.origin])
  });
  assert.deepEqual(calls, [
    ["prepare-cloudflared", runtimeRoot, {
      cloudflaredBinary: "/fixture/external-cloudflared",
      hostEnvironment
    }],
    ["stop", join(runtimeRoot, "pids")],
    ["remove-status", join(runtimeRoot, "status.json")],
    ["start", root, {
      outreachActionsEnabled: true,
      actionVisualLocator: "rapidocr",
      cloudflaredBinary: "/fixture/external-cloudflared",
      preparedCloudflaredBinary: join(runtimeRoot, "tools", "cloudflared"),
      runtimeRoot
    }],
    ["verify", "https://published.trycloudflare.com"]
  ]);
  assert.equal(published.origin, "https://published.trycloudflare.com");
  assert.deepEqual(published.stopped, ["frontend", "backend"]);
});

test("publish keeps the current trial and status untouched when cloudflared preflight fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-publish-preflight-failure-"));
  const calls = [];

  await assert.rejects(publishTrialRuntime(root, {
    prepareCloudflared: async () => {
      calls.push("prepare-cloudflared");
      throw new Error("TRIAL_CLOUDFLARED_REQUIRED");
    },
    stop: async () => {
      calls.push("stop");
      return { stopped: [], stale: [] };
    },
    removeStatus: async () => calls.push("remove-status"),
    start: async () => {
      calls.push("start");
      return { origin: "https://must-not-start.example" };
    }
  }), /TRIAL_CLOUDFLARED_REQUIRED/u);

  assert.deepEqual(calls, ["prepare-cloudflared"]);
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
      prepareCloudflared: fixturePrepareCloudflared,
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
    prepareCloudflared: fixturePrepareCloudflared,
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

test("trial status is running only when all six owned service records are live and the public origin is reachable", async () => {
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
    },
    fetchImpl: async () => new Response(null, { status: 200 })
  });
  assert.equal(status.running, true);
  assert.equal(status.processesRunning, true);
  assert.equal(status.publicReachable, true);
});

test("trial status reports live processes separately when the public origin returns 530 or cannot resolve", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-status-public-down-"));
  const pidsDirectory = join(root, "pids");
  await writeFile(join(root, "status.json"), JSON.stringify({
    version: 1,
    running: true,
    origin: "https://unreachable.trycloudflare.com"
  }), { mode: 0o600 });
  let pid = 4_700;
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
  const readProcessCommand = async (recordPid) => {
    const record = (await readRuntimeRecords({ pidsDirectory }))
      .find((value) => value.pid === recordPid);
    return record?.expectedPsCommand ?? null;
  };
  const unreachableFetches = [
    async () => new Response(null, { status: 530 }),
    async () => {
      throw new TypeError("fetch failed", {
        cause: { code: "ENOTFOUND" }
      });
    }
  ];

  for (const fetchImpl of unreachableFetches) {
    const status = await trialStatus(root, {
      readProcessCommand,
      fetchImpl
    });
    assert.equal(status.processesRunning, true);
    assert.equal(status.publicReachable, false);
    assert.equal(status.running, false);
  }
});

test("supervisor orders isolated loopback processes around the tunnel origin and stops only recorded children", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-runtime-"));
  const calls = [];
  const children = new Map();
  let nextPid = 900;
  const staleDesktopEnvironment = {
    DOUYIN_OUTREACH_APPROVALS_ENABLED: "true",
    DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED: "true",
    DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: "true",
    SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "exact",
    SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: "d".repeat(64)
  };
  const runtime = await startTrialRuntime(root, {
    hostEnvironment: { ...process.env, ...staleDesktopEnvironment },
    prepareCloudflared: async (runtimeRoot, options) => {
      calls.push({ cloudflaredPreflight: { runtimeRoot, options } });
      return join(runtimeRoot, "tools", "cloudflared");
    },
    prepare: async () => ({ root, environmentFile: join(root, "trial.env"), stateDirectory: join(root, "state"), logsDirectory: join(root, "logs"), pidsDirectory: join(root, "pids"), toolsDirectory: join(root, "tools"), mysqlDirectory: join(root, "mysql"), secretsDirectory: join(root, "secrets"), environment: { ...staleDesktopEnvironment, DATABASE_URL: "mysql://shensi_trial_app:fixture@127.0.0.1:3310/shensi_trial", SHENSI_TRIAL_APP_PASSWORD_FILE: join(root, "secrets/app-password"), MEDIACRAWLER_BASE_URL: "http://127.0.0.1:5612", MEDIACRAWLER_SERVICE_SECRET_FILE: join(root, "secrets/service-secret"), DOUYIN_OUTREACH_ACTIONS_ENABLED: "true", DOUYIN_ACTION_VISUAL_LOCATOR: "rapidocr" } }),
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
    isVirtualHostProfilePresent: async () => true,
    mysqlBinary: "/fixture/mysqld",
    cloudflaredBinary: "/fixture/cloudflared",
    backendCommand: ["node", "backend.js"],
    frontendCommand: ["node", "frontend.js"],
    gatewayCommand: ["node", "gateway.js"]
  });
  assert.equal(calls.find((call) => call.command === "/fixture/mysqld")?.command, "/fixture/mysqld");
  const mysql = calls.find((call) => call.command === "/fixture/mysqld");
  assert.ok(mysql.args.includes("--socket=/private/tmp/shensi-real-trial-3310.sock"));
  const tunnel = calls.findIndex((call) => call.command
    === join(root, ".runtime", "real-trial", "tools", "cloudflared"));
  const cloudflaredPreflight = calls.findIndex((call) => call.cloudflaredPreflight);
  const backendCalls = calls.filter((call) => call.args?.includes("backend.js"));
  const backend = calls.findIndex((call) => call === backendCalls.at(-1));
  assert.ok(cloudflaredPreflight >= 0 && cloudflaredPreflight < tunnel);
  assert.equal(
    calls[cloudflaredPreflight].cloudflaredPreflight.runtimeRoot,
    join(root, ".runtime", "real-trial")
  );
  assert.equal(
    calls[cloudflaredPreflight].cloudflaredPreflight.options.cloudflaredBinary,
    "/fixture/cloudflared"
  );
  assert.ok(tunnel >= 0 && backend > tunnel);
  assert.equal(
    calls[backend].options.env.CORS_ORIGINS,
    "https://trial-fixture.trycloudflare.com,http://127.0.0.1:5608"
  );
  assert.equal(backendCalls[0].options.env.DOUYIN_OUTREACH_ACTIONS_ENABLED, "false");
  assert.equal(backendCalls[1].options.env.DOUYIN_OUTREACH_ACTIONS_ENABLED, "true");
  for (const key of ["DOUYIN_OUTREACH_APPROVALS_ENABLED", "DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED"]) {
    assert.equal(backendCalls[0].options.env[key], "false", `bootstrap ${key}`);
    assert.equal(backendCalls[1].options.env[key], "true", `authorized server ${key}`);
  }
  for (const call of calls.filter((value) => value.options?.env?.DOUYIN_OUTREACH_ACTIONS_ENABLED)) {
    assert.equal(call.options.env.DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED, "false");
    assert.equal(call.options.env.SHENSI_DESKTOP_CLIENT_ADMISSION_MODE, "migration_locked");
    assert.equal(call.options.env.SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256, "");
  }
  const sidecarCall = calls.find((call) => call.command?.endsWith("node")
    && call.args?.[0]?.endsWith("scripts/real-trial-sidecar-container.mjs"));
  assert.ok(sidecarCall, "trial must supervise the virtual-display container wrapper");
  assert.equal(sidecarCall.options.env.DOUYIN_ACTION_VISUAL_LOCATOR, "rapidocr");
  assert.equal(sidecarCall.options.env.HOME.length > 0, true);
  assert.equal(sidecarCall.options.env.LIMA_HOME.length > 0, true);
  const audit = calls.findIndex((call) => call.outreachQueueAudit);
  const sidecar = calls.findIndex((call) => call === sidecarCall);
  assert.ok(audit > calls.findIndex((call) => call.provision));
  assert.ok(sidecar >= 0 && sidecar < audit);
  assert.ok(audit < backend);
  assert.deepEqual(
    (({ email, role, tenantId }) => ({ email, role, tenantId }))(calls.find((call) => call.provision)?.provision),
    { email: "test@shensi.local", role: "admin", tenantId: "trial-pilot-001" }
  );
  assert.ok(calls.filter((call) => call.options?.env?.HOST).every((call) => call.options.env.HOST === "127.0.0.1"));
  const oneShotCalls = calls.filter((call) => call.oneShot);
  assert.equal(oneShotCalls.length, 7);
  assert.ok(oneShotCalls.some((call) => call.oneShot.join(" ")
    === "/Users/mac/bin/limactl start colima-shensi-trial --tty=false"));
  assert.ok(oneShotCalls.some((call) => call.oneShot.join(" ").includes(
    "colima --profile shensi-trial ssh -- docker build"
  )));
  const colimaBuild = oneShotCalls.find((call) => call.oneShot.join(" ").includes(
    "colima --profile shensi-trial ssh -- docker build"
  ));
  assert.equal(colimaBuild.options.env.HOME.length > 0, true);
  assert.equal(colimaBuild.options.env.LIMA_HOME.length > 0, true);
  const virtualHost = calls.findIndex((call) => call.oneShot?.join(" ").includes(
    "limactl start colima-shensi-trial"
  ));
  const imageBuild = calls.findIndex((call) => call.oneShot?.join(" ").includes(
    "docker build"
  ));
  assert.ok(virtualHost >= 0 && virtualHost < imageBuild);
  assert.ok(imageBuild < calls.findIndex((call) => call.command === "/fixture/mysqld"));
  assert.ok(imageBuild < tunnel);
  assert.ok(oneShotCalls.some((call) => call.oneShot.join(" ").includes("--filter ./frontend exec tsc -b")));
  assert.ok(oneShotCalls.some((call) => call.oneShot.join(" ").includes("--filter ./frontend exec vite build --outDir")));
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
  const oneShotCalls = [];
  let nextPid = 1_100;
  await startTrialRuntime(root, {
    hostEnvironment: {
      ...process.env,
      DOUYIN_OUTREACH_ACTIONS_ENABLED: "true",
      DOUYIN_OUTREACH_APPROVALS_ENABLED: "true",
      DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED: "true",
      DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: "true",
      SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "exact",
      SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: "d".repeat(64)
    },
    prepareCloudflared: fixturePrepareCloudflared,
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
    runCommand: async (command, args) => oneShotCalls.push([command, ...args]),
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
  for (const call of calls) {
    assert.equal(call.options.env.DOUYIN_OUTREACH_ACTIONS_ENABLED, "false");
    assert.equal(call.options.env.DOUYIN_OUTREACH_APPROVALS_ENABLED, "false");
    assert.equal(call.options.env.DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED, "false");
    assert.equal(call.options.env.DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED, "false");
    assert.equal(call.options.env.SHENSI_DESKTOP_CLIENT_ADMISSION_MODE, "migration_locked");
    assert.equal(call.options.env.SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256, "");
  }
  const target = (suffix) => targets.find((item) => item.args[0]?.endsWith(suffix));
  const backend = target("backend/dist/server.js");
  const frontend = target("frontend/node_modules/vite/bin/vite.js");
  const sidecar = targets.find((item) => item.command.endsWith("node")
    && item.args[0]?.endsWith("scripts/real-trial-sidecar-container.mjs"));
  assert.ok(backend && frontend && sidecar);
  assert.match(backend.command, /node$/u);
  assert.match(backend.args[0], /backend\/dist\/server\.js$/u);
  assert.match(frontend.command, /node$/u);
  assert.match(frontend.args[0], /frontend\/node_modules\/vite\/bin\/vite\.js$/u);
  assert.equal(frontend.args[1], "preview");
  const isolatedFrontend = join(root, "release", "frontend");
  assert.equal(frontend.args[2], join(root, "frontend"));
  assert.deepEqual(frontend.args.slice(3, 5), ["--outDir", isolatedFrontend]);
  assert.ok(oneShotCalls.some((call) => call.includes("vite")
    && call.includes("build")
    && call.includes("--outDir")
    && call.includes(isolatedFrontend)));
  assert.match(sidecar.command, /node$/u);
  assert.match(sidecar.args[0], /scripts\/real-trial-sidecar-container\.mjs$/u);
});

test("verification checks local health, protected authentication, and public isolation", async () => {
  const calls = [];
  await verifyTrialRuntime({ origin: "http://127.0.0.1:5608", fetchImpl: async (url) => {
    calls.push(url);
    return { ok: url.endsWith("/healthz") || url.endsWith("/api/health") || url.endsWith("/internal/v1/health"), status: url.endsWith("/api/auth/me") ? 401 : url.endsWith("/internal/v1/health") ? 404 : 200 };
  } });
  assert.deepEqual(calls, ["http://127.0.0.1:5608/healthz", "http://127.0.0.1:5608/api/health", "http://127.0.0.1:5608/api/auth/me", "http://127.0.0.1:5608/internal/v1/health"]);
});

test("verification retries a transient network failure before checking the full public contract", async () => {
  const calls = [];
  await verifyTrialRuntime({
    origin: "https://trial-fixture.example",
    retryDelaysMs: [0],
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length === 1) throw new TypeError("fetch failed");
      return {
        ok: url.endsWith("/healthz") || url.endsWith("/api/health"),
        status: url.endsWith("/api/auth/me") ? 401 : url.endsWith("/internal/v1/health") ? 404 : 200
      };
    }
  });
  assert.deepEqual(calls, [
    "https://trial-fixture.example/healthz",
    "https://trial-fixture.example/healthz",
    "https://trial-fixture.example/api/health",
    "https://trial-fixture.example/api/auth/me",
    "https://trial-fixture.example/internal/v1/health"
  ]);
});

test("verification retries a temporary 530 before the public origin becomes healthy", async () => {
  const calls = [];
  await verifyTrialRuntime({
    origin: "https://trial-fixture.example",
    retryDelaysMs: [0],
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length === 1) return { ok: false, status: 530 };
      return {
        ok: url.endsWith("/healthz") || url.endsWith("/api/health"),
        status: url.endsWith("/api/auth/me") ? 401 : url.endsWith("/internal/v1/health") ? 404 : 200
      };
    }
  });
  assert.deepEqual(calls, [
    "https://trial-fixture.example/healthz",
    "https://trial-fixture.example/healthz",
    "https://trial-fixture.example/api/health",
    "https://trial-fixture.example/api/auth/me",
    "https://trial-fixture.example/internal/v1/health"
  ]);
});

test("verification bounds each request and reports an exhausted network failure with a safe code", async () => {
  const observedSignals = [];
  await assert.rejects(
    verifyTrialRuntime({
      origin: "https://secret-origin.example",
      requestTimeoutMs: 5,
      retryDelaysMs: [],
      fetchImpl: async (_url, options) => {
        observedSignals.push(options.signal);
        return await new Promise((_resolve, reject) => {
          const keepAlive = setTimeout(
            () => reject(new Error("fixture_timeout_signal_missing")), 100
          );
          options.signal.addEventListener("abort", () => {
            clearTimeout(keepAlive);
            reject(options.signal.reason);
          }, { once: true });
        });
      }
    }),
    (error) => {
      assert.equal(error.message, "TRIAL_PUBLIC_VERIFICATION_UNAVAILABLE");
      assert.doesNotMatch(error.message, /secret-origin/u);
      return true;
    }
  );
  assert.equal(observedSignals.length, 1);
  assert.equal(observedSignals[0].aborted, true);
});

test("verification reports exhausted unhealthy responses with a stable code", async () => {
  let calls = 0;
  await assert.rejects(
    verifyTrialRuntime({
      origin: "https://trial-fixture.example",
      retryDelaysMs: [0],
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 530 };
      }
    }),
    { message: "TRIAL_GATEWAY_OR_BACKEND_UNHEALTHY" }
  );
  assert.equal(calls, 2);
});

test("verification fails closed without retry when the protected route is exposed", async () => {
  const calls = [];
  await assert.rejects(
    verifyTrialRuntime({
      origin: "https://trial-fixture.example",
      retryDelaysMs: [0, 0],
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.endsWith("/api/auth/me")) return { ok: true, status: 200 };
        return { ok: true, status: 200 };
      }
    }),
    { message: "TRIAL_PROTECTED_ROUTE_NOT_AUTHENTICATED" }
  );
  assert.deepEqual(calls, [
    "https://trial-fixture.example/healthz",
    "https://trial-fixture.example/api/health",
    "https://trial-fixture.example/api/auth/me"
  ]);
});

test("verification fails closed without retry when an internal route is exposed", async () => {
  const calls = [];
  await assert.rejects(
    verifyTrialRuntime({
      origin: "https://trial-fixture.example",
      retryDelaysMs: [0, 0],
      fetchImpl: async (url) => {
        calls.push(url);
        return {
          ok: true,
          status: url.endsWith("/api/auth/me") ? 401 : 200
        };
      }
    }),
    { message: "TRIAL_INTERNAL_ROUTE_EXPOSED" }
  );
  assert.deepEqual(calls, [
    "https://trial-fixture.example/healthz",
    "https://trial-fixture.example/api/health",
    "https://trial-fixture.example/api/auth/me",
    "https://trial-fixture.example/internal/v1/health"
  ]);
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
    prepareCloudflared: fixturePrepareCloudflared,
    prepare: async () => ({ root, pidsDirectory, environment: {} }),
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
    prepareCloudflared: fixturePrepareCloudflared,
    prepare: async () => ({ root, pidsDirectory, environment: {} }),
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

test("stop tolerates a process exiting between the ownership check and TERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-record-race-"));
  const pidsDirectory = join(root, "pids");
  const stored = await writeRecord({ pidsDirectory }, {
    name: "frontend", pid: 9235, command: "/fixture/node",
    args: ["/fixture/child.mjs", "--runtime-nonce", "b".repeat(32)],
    nonce: "b".repeat(32)
  });
  const missing = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  const result = await stopTrialRuntime({ records: [stored] }, {
    isRecordedProcess: async () => true,
    signalProcessGroup: async () => { throw missing; },
    readProcessCommand: async () => null
  });
  assert.deepEqual(result, { stopped: ["frontend"], stale: [] });
  await assert.rejects(readFile(stored.path, "utf8"), /ENOENT/u);
});
