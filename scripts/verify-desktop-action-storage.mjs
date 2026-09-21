#!/usr/bin/env node
import { execFile as nativeExecFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { API_ONLY_PORTS, createDisposableApiOnlyIdentity,
  destroyDisposableApiOnlyRuntime, destroyFailedDisposableApiOnlyPreparation,
  persistDesktopActionStorageCleanupEvidence,
  prepareApiOnlyRuntime, startApiOnlyDatabase, withApiOnlyOwnerLock } from
  "./api-only-runtime.mjs";
import { discoverComposeRuntime } from "./container-runtime.mjs";
import { summarizeMysqlTestFailure } from "./lib/desktop-action-test-diagnostics.mjs";

const execFile = promisify(nativeExecFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUITES = Object.freeze({
  installation: Object.freeze([
    "backend/src/acquisition-desktop-installation-mysql-repository-test.ts"
  ]),
  binding: Object.freeze([
    "backend/src/acquisition-social-account-mysql-repository-test.ts"
  ]),
  actions: Object.freeze([
    "backend/src/acquisition-outreach-action-mysql-integration-test.ts"
  ]),
  "outreach-schema": Object.freeze([
    "backend/test/outreach-schema-mysql-test.ts"
  ]),
  "multi-mac-crm": Object.freeze([
    "backend/test/multi-mac-central-mysql-test.ts"
  ]),
  all: Object.freeze([
    "backend/src/acquisition-desktop-installation-mysql-repository-test.ts",
    "backend/src/acquisition-social-account-mysql-repository-test.ts",
    "backend/src/acquisition-outreach-action-mysql-integration-test.ts"
  ]),
  "bridge-mysql": Object.freeze([
    "backend/src/acquisition-desktop-outreach-vertical-integration-test.ts",
    "backend/src/acquisition-independent-direct-message-test.ts",
    "desktop/tests/outreach-action-bridge.integration.test.ts"
  ])
});

export function desktopActionStorageSuiteFiles(suite) {
  const selected = parseDesktopActionStorageSuite([suite]);
  return [...SUITES[selected]];
}

function failure(code) { return new Error(code); }

export function parseDesktopActionStorageSuite(argv) {
  if (!Array.isArray(argv) || argv.length !== 1
    || !Object.hasOwn(SUITES, argv[0])) {
    throw failure("DESKTOP_ACTION_STORAGE_SUITE_INVALID");
  }
  return argv[0];
}

function portAvailable(port) {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolvePort(false);
      else reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolvePort(true));
    });
  });
}

async function mysqlAdminUrl(runtime) {
  const password = await readFile(join(runtime.secretsDirectory,
    "mysql_root_password"), "utf8");
  if (!password || /\s/u.test(password)) {
    throw failure("DESKTOP_ACTION_STORAGE_MYSQL_SECRET_INVALID");
  }
  return `mysql://root:${encodeURIComponent(password)}@127.0.0.1:${API_ONLY_PORTS.emptyMysql}/mysql`;
}

export async function runDesktopActionStorageSuite(input, executeFile = execFile) {
  const suite = parseDesktopActionStorageSuite([input.suite]);
  const files = SUITES[suite];
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await executeFile(process.execPath,
    ["--import", "tsx", "--test", "--test-reporter=tap", "--test-concurrency=1", ...files.map((file) => join(input.repositoryRoot, file))], {
      cwd: join(input.repositoryRoot, "backend"),
      env: input.environment,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024
    }));
  } catch (caught) {
    // Child errors can contain SQL, environment values or test assertion data.
    throw Object.assign(failure("DESKTOP_ACTION_STORAGE_TEST_PROCESS_FAILED"), {
      diagnostic: summarizeMysqlTestFailure(suite, caught)
    });
  }
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/u).map((line) => line.replace(/^# /u, ""));
  const expected = suite === "bridge-mysql"
    ? ["backend", "desktop"].map((name) => `DESKTOP_ACTION_BRIDGE_MYSQL_TEST_EXECUTED:${name}`)
    : (suite === "all" ? ["installation", "binding", "actions"] : [suite])
      .map((name) => `DESKTOP_ACTION_STORAGE_LIVE_TEST_EXECUTED:${name}`);
  if (!expected.every((marker) => lines.includes(marker))) {
    throw failure("DESKTOP_ACTION_STORAGE_LIVE_TEST_NOT_EXECUTED");
  }
  return { passed: true };
}

export async function runDesktopActionStorageVerification(suite, options = {}) {
  const selectedSuite = parseDesktopActionStorageSuite([suite]);
  const root = options.repositoryRoot ?? repositoryRoot;
  const identity = options.identity ?? createDisposableApiOnlyIdentity();
  if (!/^shensi-api-empty-[a-f0-9]{12}$/u.test(identity.project)
    || identity.ports?.gateway !== 5628 || identity.ports?.mysql !== 3312) {
    throw failure("DESKTOP_ACTION_STORAGE_DISPOSABLE_IDENTITY_INVALID");
  }
  const withOwnerLock = options.withOwnerLock ?? withApiOnlyOwnerLock;
  const resolveRuntime = options.resolveComposeRuntime
    ?? (() => discoverComposeRuntime(options.composeRuntimeDiscoveryOptions ?? {}));
  const composeRuntime = await resolveRuntime();
  if (!composeRuntime?.daemon?.identity) {
    throw failure("DESKTOP_ACTION_STORAGE_ENGINE_RESOLUTION_FAILED");
  }
  const selectedPath = composeRuntime.environment?.PATH;
  const selectedSocket = composeRuntime.socket?.canonicalPath;
  if (typeof selectedPath !== "string" || !selectedPath || selectedPath.includes("\0")
    || typeof selectedSocket !== "string" || !isAbsolute(selectedSocket)
    || selectedSocket.includes("\0") || resolve(selectedSocket) !== selectedSocket) {
    throw failure("DESKTOP_ACTION_STORAGE_DISCOVERY_ENVIRONMENT_INVALID");
  }
  const discoveryEnvironment = Object.freeze({
    PATH: selectedPath,
    SHENSI_DOCKER_HOST: `unix://${selectedSocket}`
  });
  const inspectPort = options.isPortAvailable ?? portAvailable;
  const prepareRuntime = options.prepareRuntime ?? ((input) => prepareApiOnlyRuntime(root, {
    disposable: true, project: identity.project,
    runtimeRoot: join(root, identity.runtimeRelativeRoot),
    isPortAvailable: inspectPort
  }));
  const startDatabase = options.startDatabase ?? ((runtime) =>
    startApiOnlyDatabase(root, { disposable: true, project: identity.project,
      runtimeRoot: runtime.root, isPortAvailable: inspectPort }));
  const getAdminUrl = options.mysqlAdminUrl ?? mysqlAdminUrl;
  const executeSuite = options.runSuite ?? runDesktopActionStorageSuite;
  const persistEvidence = options.persistEvidence
    ?? ((runtime, input) => persistDesktopActionStorageCleanupEvidence(
      root, runtime, identity, input));
  const cleanup = options.destroyRuntime ?? destroyDisposableApiOnlyRuntime;
  const cleanupPartial = options.destroyPartialRuntime
    ?? destroyFailedDisposableApiOnlyPreparation;
  let runtime = null;
  let preparationStarted = false;
  let preparePromise = null;
  let evidence = null;
  let cleanupPromise = null;
  let operationPromise = null;
  let shuttingDown = false;
  let passed = false;
  const assertRunning = () => {
    if (shuttingDown) throw failure("DESKTOP_ACTION_STORAGE_INTERRUPTED");
  };
  const cleanupChildren = (_reason, lock) => {
    shuttingDown = true;
    cleanupPromise ??= (async () => {
      // Let the current bounded phase settle before removing its database.
      // A signal prevents all subsequent phases, including a late test launch.
      if (operationPromise !== null) await operationPromise.catch(() => undefined);
      if (preparePromise !== null) await preparePromise.catch(() => undefined);
      if (runtime === null) {
        if (!preparationStarted) return;
        const result = await cleanupPartial(Object.freeze({
          repositoryRoot: root,
          root: join(root, identity.runtimeRelativeRoot),
          project: identity.project,
          ports: identity.ports,
          composeRuntime,
          ownerLock: lock
        }));
        if (result?.cleanup !== "complete") {
          throw failure("DESKTOP_ACTION_STORAGE_CLEANUP_FAILED");
        }
        return;
      }
      evidence ??= await persistEvidence(runtime, {
        suite: selectedSuite,
        result: passed ? "passed" : "failed",
        verifiedAt: new Date().toISOString()
      });
      const authorized = Object.freeze({ ...runtime, repositoryRoot: root,
        ownerLock: lock, retainedEvidence: evidence.retained });
      const result = await cleanup(authorized);
      if (result?.cleanup !== "complete") {
        throw failure("DESKTOP_ACTION_STORAGE_CLEANUP_FAILED");
      }
    })();
    return cleanupPromise;
  };
  return withOwnerLock({ repositoryRoot: root, disposable: true,
    project: identity.project,
    runtimeRoot: join(root, ".runtime", "api-only-empty"),
    engineIdentity: composeRuntime.daemon.identity,
    cleanupChildren }, (lock) => {
    operationPromise = Promise.resolve().then(async () => {
      assertRunning();
      if (!await inspectPort(3312)) throw failure("DESKTOP_ACTION_STORAGE_PORT_IN_USE");
      assertRunning();
      preparationStarted = true;
      preparePromise = Promise.resolve().then(() => prepareRuntime({ identity, lock }))
        .then((prepared) => { runtime = prepared; return prepared; });
      await preparePromise;
      assertRunning();
      await startDatabase(runtime);
      assertRunning();
      const adminUrl = await getAdminUrl(runtime);
      assertRunning();
      const environment = Object.freeze({ NODE_ENV: "test", TZ: "UTC",
        ...discoveryEnvironment,
        MYSQL_TEST_ADMIN_URL: adminUrl,
        DESKTOP_ACTION_STORAGE_LOCK_NONCE: lock.nonce,
        DESKTOP_ACTION_STORAGE_SUITE: selectedSuite,
        ...(selectedSuite === "bridge-mysql" ? { DESKTOP_ACTION_BRIDGE_MYSQL: "1" } : {}) });
      const result = await executeSuite({ suite: selectedSuite,
        repositoryRoot: root, files: SUITES[selectedSuite], environment });
      assertRunning();
      if (result?.passed !== true) throw failure("DESKTOP_ACTION_STORAGE_SUITE_FAILED");
      passed = true;
      return Object.freeze({ suite: selectedSuite, passed: true });
    });
    return operationPromise;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const suite = parseDesktopActionStorageSuite(process.argv.slice(2));
    const result = await runDesktopActionStorageVerification(suite);
    console.log(JSON.stringify(result));
  } catch (caught) {
    const code = caught instanceof Error ? caught.message : "";
    if (code === "DESKTOP_ACTION_STORAGE_TEST_PROCESS_FAILED" && caught.diagnostic) {
      console.error(`DESKTOP_ACTION_STORAGE_DIAGNOSTIC ${JSON.stringify(caught.diagnostic)}`);
    }
    console.error(/^(?:DESKTOP_ACTION_STORAGE|API_ONLY|API_NETWORK|COMPOSE)_[A-Z0-9_]{1,120}$/u.test(code)
      ? code : "DESKTOP_ACTION_STORAGE_VERIFICATION_FAILED");
    process.exitCode = 1;
  }
}
