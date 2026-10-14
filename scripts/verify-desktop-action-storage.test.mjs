import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { acquireApiOnlyOwnerLock, releaseApiOnlyOwnerLock,
  validateDisposableApiOnlyOwnerLock } from "./api-only-runtime.mjs";
import { desktopActionStorageSuiteFiles, parseDesktopActionStorageSuite,
  runDesktopActionStorageVerification, runDesktopActionStorageSuite } from "./verify-desktop-action-storage.mjs";

function resolvedRuntime() {
  return {
    daemon: { identity: "engine" },
    socket: { canonicalPath: "/Users/alice/.colima/shensi-trial/docker.sock" },
    environment: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      DOCKER_HOST: "unix:///Users/alice/.colima/shensi-trial/docker.sock",
      DATABASE_URL: "mysql://private-fixture-only/database",
      TOKEN: "private-fixture-only",
      SHENSI_API_BACKEND_ENV_FILE: "/private-fixture-only/backend.env"
    }
  };
}

// Same virtual socket/executable boundary as container-runtime.test.mjs, with
// no executable candidates override: discovery must consume the child's PATH.
function ownerDiscoveryFixture() {
  const uid = 501;
  const nodes = new Map();
  for (const path of ["/", "/Users", "/usr", "/usr/local", "/usr/local/bin", "/usr/bin", "/bin"]) {
    nodes.set(path, { type: "dir", uid: 0, mode: 0o755 });
  }
  for (const path of ["/Users/alice", "/Users/alice/.colima", "/Users/alice/.colima/shensi-trial"]) {
    nodes.set(path, { type: "dir", uid, mode: 0o700 });
  }
  nodes.set(resolvedRuntime().socket.canonicalPath, { type: "socket", uid, mode: 0o600 });
  nodes.set("/usr/local/bin/docker", { type: "file", uid: 0, mode: 0o755 });
  for (const [index, node] of [...nodes.values()].entries()) node.ino = index + 1;
  const lookup = (path) => {
    const node = nodes.get(path);
    if (!node) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return node;
  };
  const calls = [];
  return {
    calls,
    environment: { PATH: resolvedRuntime().environment.PATH,
      SHENSI_DOCKER_HOST: resolvedRuntime().environment.DOCKER_HOST },
    userInfo: () => ({ homedir: "/Users/alice", uid, gid: uid }),
    getuid: () => uid,
    getgroups: () => [uid],
    async lstat(path) {
      const node = lookup(path);
      return { ...node, gid: node.uid, dev: 1, nlink: 1, size: 0,
        isDirectory: () => node.type === "dir", isFile: () => node.type === "file",
        isSocket: () => node.type === "socket", isSymbolicLink: () => false };
    },
    async realpath(path) { lookup(path); return path; },
    async access(path) { assert.equal(lookup(path).type, "file"); },
    async open() { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    async readdir() { return []; },
    async readlink() { throw Object.assign(new Error("not a link"), { code: "EINVAL" }); },
    async composeVersion(command, argv, options) {
      calls.push({ type: "compose", command, argv, environment: options.env });
      assert.equal(command, "/usr/local/bin/docker");
      assert.deepEqual(argv, ["compose", "version", "--short"]);
      return "v2.31.0";
    },
    async daemonRequest(path, socket) {
      calls.push({ type: "daemon", path, socket });
      assert.equal(socket, resolvedRuntime().socket.canonicalPath);
      if (path === "/_ping") return "OK";
      assert.equal(path, "/info");
      return { ID: "fixture-engine", Name: "engine", Driver: "overlay2",
        OSType: "linux", Architecture: "aarch64", ServerVersion: "27.4.1" };
    }
  };
}

test("desktop storage verifier accepts only its fixed storage, schema and bridge MySQL suites", () => {
  for (const suite of ["installation", "binding", "actions", "all", "outreach-schema", "multi-mac-crm", "bridge-mysql"]) {
    assert.equal(parseDesktopActionStorageSuite([suite]), suite);
  }
  for (const argv of [[], ["unknown"], ["installation", "actions"], ["--help"]]) {
    assert.throws(() => parseDesktopActionStorageSuite(argv),
      /DESKTOP_ACTION_STORAGE_SUITE_INVALID/u);
  }
});

function bridgeFixture(overrides = {}) {
  const events = [];
  const lock = { nonce: "e".repeat(32) };
  const options = {
    repositoryRoot: "/repo",
    identity: { suffix: "abcdef123456", project: "shensi-api-empty-abcdef123456",
      runtimeRelativeRoot: ".runtime/api-only-empty/abcdef123456",
      ports: { gateway: 5628, mysql: 3312 } },
    async resolveComposeRuntime() { return resolvedRuntime(); },
    async withOwnerLock(input, callback) {
      events.push("lock");
      try { return await callback(lock); }
      finally { await input.cleanupChildren("return", lock); events.push("unlock"); }
    },
    async isPortAvailable() { events.push("port"); return true; },
    async prepareRuntime() { events.push("prepare"); return { project: "shensi-api-empty-abcdef123456" }; },
    async startDatabase() { events.push("database"); },
    async mysqlAdminUrl() { return "mysql://root:secret@127.0.0.1:3312/mysql"; },
    async runSuite(input) {
      events.push("tests");
      assert.equal(input.environment.DESKTOP_ACTION_BRIDGE_MYSQL, "1");
      assert.equal(input.environment.DATABASE_URL, undefined);
      assert.deepEqual(input.files, [
        "backend/src/acquisition-desktop-outreach-vertical-integration-test.ts",
        "backend/src/acquisition-independent-direct-message-test.ts",
        "desktop/tests/outreach-action-bridge.integration.test.ts"
      ]);
      return { passed: true };
    },
    async persistEvidence(_runtime, input) {
      events.push(`evidence:${input.suite}:${input.result}`);
      return { retained: { path: "/receipt", sha256: "e".repeat(64) } };
    },
    async destroyRuntime() { events.push("destroy"); return { cleanup: "complete" }; },
    ...overrides
  };
  return { events, options, lock };
}

test("bridge MySQL operator selects real DB mode, fixed files and purpose-specific evidence", async () => {
  const fixture = bridgeFixture();
  assert.deepEqual(await runDesktopActionStorageVerification("bridge-mysql", fixture.options),
    { suite: "bridge-mysql", passed: true });
  assert.deepEqual(fixture.events, ["lock", "port", "prepare", "database", "tests",
    "evidence:bridge-mysql:passed", "destroy", "unlock"]);
});

test("outreach-schema operator launches only the empty-schema file with selected discovery and owner authority", async () => {
  // Selecting schema diagnosis must not launch the business matrix or inherit
  // ambient credentials, even when the selected engine environment has them.
  const fixture = bridgeFixture({
    async runSuite(input) {
      fixture.events.push("tests");
      assert.equal(input.suite, "outreach-schema");
      assert.deepEqual(input.files, ["backend/test/outreach-schema-mysql-test.ts"]);
      assert.deepEqual(input.environment, {
        NODE_ENV: "test",
        TZ: "UTC",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        SHENSI_DOCKER_HOST: "unix:///Users/alice/.colima/shensi-trial/docker.sock",
        MYSQL_TEST_ADMIN_URL: "mysql://root:secret@127.0.0.1:3312/mysql",
        DESKTOP_ACTION_STORAGE_LOCK_NONCE: "e".repeat(32),
        DESKTOP_ACTION_STORAGE_SUITE: "outreach-schema"
      });
      assert.equal(Object.hasOwn(input.environment, "DESKTOP_ACTION_BRIDGE_MYSQL"), false);
      return { passed: true };
    }
  });
  assert.deepEqual(await runDesktopActionStorageVerification("outreach-schema", fixture.options),
    { suite: "outreach-schema", passed: true });
  assert.deepEqual(fixture.events, ["lock", "port", "prepare", "database", "tests",
    "evidence:outreach-schema:passed", "destroy", "unlock"]);
});

test("desktop storage verifier rejects missing or invalid discovery inputs before owner lock or runtime effects", async () => {
  const invalidRuntimes = [
    { ...resolvedRuntime(), environment: undefined },
    ...[undefined, "", 42, "/usr/local/bin\0/private"].map((PATH) => ({
      ...resolvedRuntime(), environment: { ...resolvedRuntime().environment, PATH }
    })),
    { ...resolvedRuntime(), socket: undefined },
    ...[undefined, "", "relative/docker.sock", "/socket\0.sock"].map((canonicalPath) => ({
      ...resolvedRuntime(), socket: { canonicalPath }
    }))
  ];
  for (const runtime of invalidRuntimes) {
    const fixture = bridgeFixture({ async resolveComposeRuntime() { return runtime; } });
    await assert.rejects(runDesktopActionStorageVerification("bridge-mysql", fixture.options),
      { message: "DESKTOP_ACTION_STORAGE_DISCOVERY_ENVIRONMENT_INVALID" });
    assert.deepEqual(fixture.events, []);
  }
});

for (const suite of ["bridge-mysql", "outreach-schema"]) {
test(`${suite} child owner validator rediscovers the selected engine through default PATH-based discovery`, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shensi-storage-child-env-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const discovery = ownerDiscoveryFixture();
  const startToken = "fixture-child-environment";
  const fixture = bridgeFixture({
    repositoryRoot: root,
    resolveComposeRuntime: undefined,
    composeRuntimeDiscoveryOptions: discovery,
    async withOwnerLock(input, callback) {
      const lock = await acquireApiOnlyOwnerLock(root, { ...input,
        processInfo: () => ({ pid: 8181, startToken }) });
      try { return await callback(lock); }
      finally {
        try { await input.cleanupChildren("return", lock); }
        finally { await releaseApiOnlyOwnerLock(lock); }
      }
    },
    async runSuite({ environment }) {
      const validate = (childEnvironment) => validateDisposableApiOnlyOwnerLock(root, {
        nonce: environment.DESKTOP_ACTION_STORAGE_LOCK_NONCE,
        readProcessStartToken: async () => startToken,
        composeRuntimeDiscoveryOptions: { ...discovery, environment: childEnvironment }
      });
      const validated = await validate(environment);
      assert.equal(validated.project, fixture.options.identity.project);
      const { PATH: _path, ...withoutPath } = environment;
      await assert.rejects(validate(withoutPath), { message: "API_ONLY_OWNER_LOCK_ENGINE_INVALID" });
      const { SHENSI_DOCKER_HOST: _host, ...withoutSelectedSocket } = environment;
      await assert.rejects(validate(withoutSelectedSocket), { message: "API_ONLY_OWNER_LOCK_ENGINE_INVALID" });
      return { passed: true };
    }
  });
  assert.deepEqual(await runDesktopActionStorageVerification(suite, fixture.options),
    { suite, passed: true });
  assert.equal(discovery.calls.filter((call) => call.type === "compose").length, 2);
  assert.ok(discovery.calls.filter((call) => call.type === "daemon")
    .every((call) => call.socket === resolvedRuntime().socket.canonicalPath));
});
}

test("bridge suite requires both real-execution markers, not a skipped or partial run", async () => {
  const input = { suite: "bridge-mysql", repositoryRoot: "/repo", environment: { NODE_ENV: "test" } };
  for (const stdout of ["# skipped 12", "# DESKTOP_ACTION_BRIDGE_MYSQL_TEST_EXECUTED:backend",
    "# DESKTOP_ACTION_STORAGE_LIVE_TEST_EXECUTED:outreach-schema",
    "# skip DESKTOP_ACTION_BRIDGE_MYSQL_TEST_EXECUTED:backend\n# skip DESKTOP_ACTION_BRIDGE_MYSQL_TEST_EXECUTED:desktop"]) {
    await assert.rejects(runDesktopActionStorageSuite(input, async () => ({ stdout, stderr: "" })),
      /DESKTOP_ACTION_STORAGE_LIVE_TEST_NOT_EXECUTED/u);
  }
  assert.deepEqual(await runDesktopActionStorageSuite(input, async (command, argv, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(argv, ["--import", "tsx", "--test", "--test-reporter=tap", "--test-concurrency=1",
      ...desktopActionStorageSuiteFiles("bridge-mysql").map((file) => `/repo/${file}`)]);
    assert.equal(options.cwd, "/repo/backend");
    assert.deepEqual(options.env, input.environment);
    return { stdout: "# DESKTOP_ACTION_BRIDGE_MYSQL_TEST_EXECUTED:backend\n# DESKTOP_ACTION_BRIDGE_MYSQL_TEST_EXECUTED:desktop\n", stderr: "" };
  }), { passed: true });
});

test("outreach-schema suite requires its own execution marker and rejects bridge or skipped evidence", async () => {
  const input = { suite: "outreach-schema", repositoryRoot: "/repo", environment: { NODE_ENV: "test" } };
  for (const stdout of [
    "# skipped 1",
    "# DESKTOP_ACTION_BRIDGE_MYSQL_TEST_EXECUTED:backend\n# DESKTOP_ACTION_BRIDGE_MYSQL_TEST_EXECUTED:desktop",
    "# DESKTOP_ACTION_STORAGE_LIVE_TEST_EXECUTED:actions",
    "# skip DESKTOP_ACTION_STORAGE_LIVE_TEST_EXECUTED:outreach-schema",
    "ok 1 - empty schema # SKIP DESKTOP_ACTION_STORAGE_LIVE_TEST_EXECUTED:outreach-schema",
    "# DESKTOP_ACTION_STORAGE_LIVE_TEST_EXECUTED:outreach-schema-extra"
  ]) {
    await assert.rejects(runDesktopActionStorageSuite(input, async () => ({ stdout, stderr: "" })),
      /DESKTOP_ACTION_STORAGE_LIVE_TEST_NOT_EXECUTED/u);
  }
  assert.deepEqual(await runDesktopActionStorageSuite(input, async (command, argv, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(argv, ["--import", "tsx", "--test", "--test-reporter=tap", "--test-concurrency=1",
      "/repo/backend/test/outreach-schema-mysql-test.ts"]);
    assert.equal(options.cwd, "/repo/backend");
    assert.deepEqual(options.env, input.environment);
    return { stdout: "# DESKTOP_ACTION_STORAGE_LIVE_TEST_EXECUTED:outreach-schema\n", stderr: "" };
  }), { passed: true });
});

test("fixed child launch resolves the installed backend tsx loader; default Memory execution is not MySQL proof", async () => {
  await assert.rejects(runDesktopActionStorageSuite({ suite: "bridge-mysql",
    repositoryRoot: fileURLToPath(new URL("../", import.meta.url)),
    environment: { NODE_ENV: "test", TZ: "UTC" }
  }), /DESKTOP_ACTION_STORAGE_LIVE_TEST_NOT_EXECUTED/u);
});

test("child test errors never expose captured SQL, credentials or assertion output", async () => {
  let reached = false;
  await assert.rejects(runDesktopActionStorageSuite({ suite: "bridge-mysql", repositoryRoot: "/repo" }, async () => {
    reached = true;
    throw Object.assign(new Error("mysql://root:secret@127.0.0.1"), {
      stdout: "credential", stderr: "INSERT INTO secrets" });
  }), (caught) => caught.message === "DESKTOP_ACTION_STORAGE_TEST_PROCESS_FAILED"
    && caught.cause === undefined && caught.stdout === undefined);
  assert.equal(reached, true);
});

for (const phase of ["prepareRuntime", "startDatabase", "runSuite"]) {
  test(`signal during ${phase} waits for settlement and never starts a later phase`, async () => {
    let release;
    let entered;
    const paused = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const fixture = bridgeFixture();
    fixture.options[phase] = async () => {
      fixture.events.push("pending");
      entered();
      await paused;
      fixture.events.push("settled");
      return phase === "prepareRuntime" ? { project: fixture.options.identity.project } : { passed: true };
    };
    fixture.options.withOwnerLock = async (input, callback) => {
      const operation = callback(fixture.lock);
      const rejected = assert.rejects(operation, /DESKTOP_ACTION_STORAGE_INTERRUPTED/u);
      await started;
      const cleanup = input.cleanupChildren("SIGTERM", fixture.lock);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fixture.events.includes("destroy"), false, "no destroy while phase is active");
      release();
      await rejected;
      await cleanup;
      await input.cleanupChildren("return", fixture.lock);
      throw new Error("DESKTOP_ACTION_STORAGE_INTERRUPTED");
    };
    await assert.rejects(runDesktopActionStorageVerification("bridge-mysql", fixture.options),
      /DESKTOP_ACTION_STORAGE_INTERRUPTED/u);
    assert.deepEqual(fixture.events.slice(fixture.events.indexOf("pending")),
      ["pending", "settled", "evidence:bridge-mysql:failed", "destroy"]);
  });
}

for (const phase of ["isPortAvailable", "startDatabase", "persistEvidence", "destroyRuntime"]) {
  test(`${phase} failure preserves the ownership/cleanup boundary`, async () => {
    const fixture = bridgeFixture();
    fixture.options[phase] = async () => {
      fixture.events.push(`failed:${phase}`);
      throw new Error(`injected-${phase}`);
    };
    await assert.rejects(runDesktopActionStorageVerification("bridge-mysql", fixture.options),
      new RegExp(`injected-${phase}`, "u"));
    if (phase === "isPortAvailable") {
      assert.deepEqual(fixture.events, ["lock", "failed:isPortAvailable", "unlock"]);
    } else if (phase === "startDatabase") {
      assert.deepEqual(fixture.events.slice(-4), ["failed:startDatabase",
        "evidence:bridge-mysql:failed", "destroy", "unlock"]);
      assert.equal(fixture.events.includes("tests"), false);
    } else {
      assert.equal(fixture.events.includes("unlock"), false);
      assert.equal(fixture.events.includes("destroy"), false);
    }
  });
}

test("desktop storage verifier exposes only the locked suite file map", () => {
  assert.deepEqual(desktopActionStorageSuiteFiles("installation"), [
    "backend/src/acquisition-desktop-installation-mysql-repository-test.ts"
  ]);
  assert.deepEqual(desktopActionStorageSuiteFiles("binding"), [
    "backend/src/acquisition-social-account-mysql-repository-test.ts"
  ]);
  assert.deepEqual(desktopActionStorageSuiteFiles("actions"), [
    "backend/src/acquisition-outreach-action-mysql-integration-test.ts"
  ]);
  assert.deepEqual(desktopActionStorageSuiteFiles("multi-mac-crm"), [
    "backend/test/multi-mac-central-mysql-test.ts"
  ]);
  assert.deepEqual(desktopActionStorageSuiteFiles("all"), [
    "backend/src/acquisition-desktop-installation-mysql-repository-test.ts",
    "backend/src/acquisition-social-account-mysql-repository-test.ts",
    "backend/src/acquisition-outreach-action-mysql-integration-test.ts"
  ]);
});

test("desktop storage verifier holds the owner lock and passes only selected discovery inputs to its child", async () => {
  const events = [];
  const result = await runDesktopActionStorageVerification("installation", {
    repositoryRoot: "/repo",
    identity: { project: "shensi-api-empty-abcdef123456",
      runtimeRelativeRoot: ".runtime/api-only-empty/abcdef123456",
      ports: { gateway: 5628, mysql: 3312 } },
    async resolveComposeRuntime() { return resolvedRuntime(); },
    async withOwnerLock(input, callback) {
      events.push("lock");
      assert.equal(typeof input.cleanupChildren, "function");
      const lock = { nonce: "a".repeat(32), project: "shensi-api-empty-abcdef123456",
        ports: { gateway: 5628, mysql: 3312 } };
      const result = await callback(lock);
      await input.cleanupChildren("return", lock);
      return result;
    },
    async isPortAvailable(port) { events.push(`port:${port}`); return true; },
    async prepareRuntime() { events.push("prepare"); return { project: "shensi-api-empty-abcdef123456" }; },
    async startDatabase() { events.push("start-db"); },
    async mysqlAdminUrl() { return "mysql://root:secret@127.0.0.1:3312/mysql"; },
    async runSuite(input) {
      events.push("tests");
      assert.deepEqual(Object.keys(input.environment).sort(), [
        "DESKTOP_ACTION_STORAGE_LOCK_NONCE", "DESKTOP_ACTION_STORAGE_SUITE",
        "MYSQL_TEST_ADMIN_URL", "NODE_ENV", "PATH", "SHENSI_DOCKER_HOST", "TZ"
      ]);
      assert.equal(input.environment.PATH, "/usr/local/bin:/usr/bin:/bin");
      assert.equal(input.environment.SHENSI_DOCKER_HOST,
        "unix:///Users/alice/.colima/shensi-trial/docker.sock");
      assert.equal(input.environment.MYSQL_TEST_ADMIN_URL,
        "mysql://root:secret@127.0.0.1:3312/mysql");
      assert.equal(input.environment.DESKTOP_ACTION_STORAGE_LOCK_NONCE, "a".repeat(32));
      assert.equal(input.environment.DATABASE_URL, undefined);
      assert.equal(input.environment.MYSQL_URL, undefined);
      assert.equal(input.environment.TOKEN, undefined);
      assert.equal(input.environment.SHENSI_API_BACKEND_ENV_FILE, undefined);
      assert.equal(input.environment.DOCKER_HOST, undefined);
      return { passed: true };
    },
    async persistEvidence() { return { retained: { path: "/evidence", sha256: "a".repeat(64) } }; },
    async destroyRuntime() { events.push("destroy"); return { cleanup: "complete" }; }
  });
  assert.deepEqual(events, ["lock", "port:3312", "prepare", "start-db", "tests", "destroy"]);
  assert.deepEqual(result, { suite: "installation", passed: true });
});

test("desktop storage verifier destroys only its prepared runtime when tests fail", async () => {
  const events = [];
  await assert.rejects(runDesktopActionStorageVerification("installation", {
    repositoryRoot: "/repo",
    identity: { project: "shensi-api-empty-abcdef123456",
      runtimeRelativeRoot: ".runtime/api-only-empty/abcdef123456",
      ports: { gateway: 5628, mysql: 3312 } },
    async resolveComposeRuntime() { return resolvedRuntime(); },
    async withOwnerLock(input, callback) {
      const lock = { nonce: "b".repeat(32), project: "shensi-api-empty-abcdef123456",
        ports: { gateway: 5628, mysql: 3312 } };
      try { return await callback(lock); }
      finally { await input.cleanupChildren("error", lock); }
    },
    async isPortAvailable() { return true; },
    async prepareRuntime() { events.push("prepare"); return { project: "shensi-api-empty-abcdef123456" }; },
    async startDatabase() { events.push("start-db"); },
    async mysqlAdminUrl() { return "mysql://root:secret@127.0.0.1:3312/mysql"; },
    async runSuite() { events.push("tests"); throw new Error("fixture-failure"); },
    async persistEvidence() { return { retained: { path: "/evidence", sha256: "a".repeat(64) } }; },
    async destroyRuntime() { events.push("destroy"); return { cleanup: "complete" }; }
  }), /fixture-failure/u);
  assert.deepEqual(events, ["prepare", "start-db", "tests", "destroy"]);
});

test("desktop storage verifier signal cleanup is idempotent with final cleanup", async () => {
  const events = [];
  await runDesktopActionStorageVerification("installation", {
    repositoryRoot: "/repo",
    identity: { project: "shensi-api-empty-abcdef123456",
      runtimeRelativeRoot: ".runtime/api-only-empty/abcdef123456",
      ports: { gateway: 5628, mysql: 3312 } },
    async resolveComposeRuntime() { return resolvedRuntime(); },
    async withOwnerLock(input, callback) {
      const lock = { nonce: "c".repeat(32), project: "shensi-api-empty-abcdef123456",
        ports: { gateway: 5628, mysql: 3312 } };
      const result = await callback(lock);
      await input.cleanupChildren("SIGTERM", lock);
      await input.cleanupChildren("return", lock);
      return result;
    },
    async isPortAvailable() { return true; },
    async prepareRuntime() { events.push("prepare"); return { project: "shensi-api-empty-abcdef123456" }; },
    async startDatabase() { events.push("start-db"); },
    async mysqlAdminUrl() { return "mysql://root:secret@127.0.0.1:3312/mysql"; },
    async runSuite() { events.push("tests"); return { passed: true }; },
    async persistEvidence() {
      events.push("evidence");
      return { retained: { path: "/retained/evidence.json", sha256: "a".repeat(64) } };
    },
    async destroyRuntime(runtime) {
      events.push("destroy");
      assert.equal(runtime.ownerLock.nonce, "c".repeat(32));
      assert.equal(runtime.retainedEvidence.path, "/retained/evidence.json");
      return { cleanup: "complete" };
    }
  });
  assert.deepEqual(events, ["prepare", "start-db", "tests", "evidence", "destroy"]);
});

test("desktop storage verifier destroys an exact partial runtime when preparation throws", async () => {
  const events = [];
  await assert.rejects(runDesktopActionStorageVerification("installation", {
    repositoryRoot: "/repo",
    identity: { project: "shensi-api-empty-abcdef123456",
      runtimeRelativeRoot: ".runtime/api-only-empty/abcdef123456",
      ports: { gateway: 5628, mysql: 3312 } },
    async resolveComposeRuntime() { return resolvedRuntime(); },
    async withOwnerLock(input, callback) {
      const lock = { nonce: "d".repeat(32), project: "shensi-api-empty-abcdef123456",
        ports: { gateway: 5628, mysql: 3312 } };
      try { return await callback(lock); }
      finally { await input.cleanupChildren("error", lock); }
    },
    async isPortAvailable() { return true; },
    async prepareRuntime() {
      events.push("prepare-created-root");
      throw new Error("prepare failed");
    },
    async destroyPartialRuntime(handle) {
      events.push("destroy-partial");
      assert.equal(handle.root, "/repo/.runtime/api-only-empty/abcdef123456");
      assert.equal(handle.ownerLock.nonce, "d".repeat(32));
      return { cleanup: "complete" };
    }
  }), /prepare failed/u);
  assert.deepEqual(events, ["prepare-created-root", "destroy-partial"]);
});
