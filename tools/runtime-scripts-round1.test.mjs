import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  composeOperationalEnvironment,
  loadProductionEnvironment,
  deployProduction,
  validateProductionSecrets
} from "../scripts/deploy.mjs";
import { runDevelopment } from "../scripts/dev.mjs";
import { runVerification } from "../scripts/verify.mjs";

const localEnvironment = {
  DATABASE_URL: "mysql://shensi_app:fixture@127.0.0.1:3306/shensi",
  JWT_SECRET: "fixture-security-value-that-is-longer-than-32-characters",
  PROVIDER_CREDENTIAL_KEY: "fixture-security-value-that-is-longer-than-32-characters",
  AGENT_JOB_ENCRYPTION_KEY: "fixture-security-value-that-is-longer-than-32-characters",
  ACQUISITION_MASTER_SECRET: "fixture-security-value-that-is-longer-than-32-characters"
};

const productionEnvironment = {
  ...localEnvironment,
  CRM_STORE: "mysql",
  CRM_SEED_DEVELOPMENT_DATA: "false",
  SESSION_COOKIE_SECURE: "true",
  CORS_ORIGINS: "https://shensi.example",
  SHENSI_MYSQL_APP_PASSWORD: "fixture-app-password-that-is-long-enough",
  TRADE_OBSERVATION_CURSOR_SECRET: "fixture-security-value-that-is-longer-than-32-characters",
  MARKET_OPPORTUNITY_CURSOR_SECRET: "fixture-security-value-that-is-longer-than-32-characters",
  PROSPECT_RUN_IDEMPOTENCY_SECRET: "fixture-security-value-that-is-longer-than-32-characters",
  PROSPECT_RUN_CURSOR_SECRET: "fixture-security-value-that-is-longer-than-32-characters",
  PROSPECT_EXECUTION_CLAIM_SECRET: "fixture-security-value-that-is-longer-than-32-characters",
  ORGANIZATION_IDENTITY_MASTER_SECRET: "fixture-security-value-that-is-longer-than-32-characters",
  PROSPECT_SOURCE_RAW_ENVELOPE_SECRET: "fixture-security-value-that-is-longer-than-32-characters",
  PROSPECT_COVERAGE_MASTER_SECRET: "fixture-security-value-that-is-longer-than-32-characters",
  DATABASE_URL: "mysql://shensi_app:fixture-app-password-that-is-long-enough@mysql:3306/shensi"
};

function child(pid) {
  const value = new EventEmitter();
  value.pid = pid;
  value.exitCode = null;
  value.signalCode = null;
  return value;
}

test("development launches only after preflight with strict Vite ports and cleans both process trees", async () => {
  const processRef = new EventEmitter();
  const children = [child(101), child(102)];
  const started = [];
  const calls = [];
  const terminated = [];
  await runDevelopment("/workspace", localEnvironment, {
    processRef,
    assertPorts: async (ports, hosts) => calls.push({ ports, hosts }),
    spawnProcess(command, argumentsList, options) {
      calls.push({ command, argumentsList, options });
      const next = children.shift();
      started.push(next);
      if (!children.length) queueMicrotask(() => started.forEach((running) => running.emit("exit", 0, null)));
      return next;
    },
    terminateTree(running, signal) {
      terminated.push([running.pid, signal]);
      queueMicrotask(() => running.emit("exit", 0, signal));
    }
  });
  assert.deepEqual(calls[0], {
    ports: { backend: 4191, frontend: 5191 },
    hosts: { backend: "127.0.0.1", frontend: "127.0.0.1" }
  });
  assert.deepEqual(calls[1].argumentsList, ["--filter", "./backend", "dev:mysql"]);
  assert.equal(calls[1].options.detached, true);
  assert.deepEqual(calls[2].argumentsList, ["--filter", "./frontend", "dev", "--", "--port", "5191", "--strictPort"]);
  assert.equal(calls[2].options.env.VITE_API_TARGET, "http://127.0.0.1:4191");
  assert.deepEqual(terminated.map(([pid]) => pid).sort(), [101, 102]);
});

test("a shutdown signal during the first spawn prevents the second spawn and forces cleanup", async () => {
  const processRef = new EventEmitter();
  const running = child(201);
  const signals = [];
  let spawnCount = 0;
  await runDevelopment("/workspace", localEnvironment, {
    processRef,
    assertPorts: async () => {},
    spawnProcess() {
      spawnCount += 1;
      processRef.emit("SIGTERM");
      return running;
    },
    terminateTree(item, signal) {
      signals.push(signal);
      if (signal === "SIGKILL") queueMicrotask(() => item.emit("exit", 0, signal));
    },
    setTimer(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimer() {}
  });
  assert.equal(spawnCount, 1);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("development does not resolve until an early-signal child has been forcibly cleaned up", async () => {
  const processRef = new EventEmitter();
  const running = child(202);
  let forceCleanup;
  let settled = false;
  const execution = runDevelopment("/workspace", localEnvironment, {
    processRef,
    assertPorts: async () => {},
    spawnProcess() {
      processRef.emit("SIGINT");
      return running;
    },
    terminateTree(item, signal) {
      if (signal === "SIGKILL") item.emit("exit", 0, signal);
    },
    setTimer(callback) {
      forceCleanup = callback;
      return 1;
    },
    clearTimer() {}
  }).then(() => { settled = true; });
  await new Promise((resolveTick) => queueMicrotask(resolveTick));
  assert.equal(settled, false);
  forceCleanup();
  await execution;
  assert.equal(settled, true);
});

test("production file values cannot be masked by ambient environment", () => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-runtime-"));
  const file = join(directory, ".env.production.local");
  try {
    writeFileSync(file, "CRM_STORE=memory\n", { mode: 0o600 });
    const loaded = loadProductionEnvironment(file, { CRM_STORE: "mysql" });
    assert.equal(loaded.CRM_STORE, "memory");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Compose receives only named operational environment values, never deployment configuration", () => {
  assert.deepEqual(composeOperationalEnvironment({
    PATH: "/fixture/bin",
    HOME: "/fixture/home",
    DATABASE_URL: "mysql://contains-a-password",
    JWT_SECRET: "fixture-secret",
    SHENSI_HTTP_PORT: "8080"
  }), {
    PATH: "/fixture/bin",
    HOME: "/fixture/home"
  });
});

test("Docker availability and every deployment command share explicit endpoint selectors", async () => {
  const selectors = {
    PATH: "/fixture/bin",
    HOME: "/fixture/home",
    DOCKER_CONFIG: "/fixture/docker-config",
    DOCKER_HOST: "ssh://fixture-daemon",
    DOCKER_CONTEXT: "fixture-context",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: "/fixture/certs"
  };
  assert.deepEqual(composeOperationalEnvironment({ ...selectors, DATABASE_URL: "mysql://password" }), selectors);
  assert.equal("DOCKER_HOST" in composeOperationalEnvironment({ PATH: "/fixture/bin" }), false);
  const received = [];
  await assert.rejects(deployProduction("/workspace", productionEnvironment, {
    dockerEnvironment: selectors,
    assertDocker(_binary, { environment }) { received.push(["availability", environment]); },
    runCompose(argumentsList, environment) {
      received.push([argumentsList[0], environment]);
      if (argumentsList.join(" ") === "ps -q gateway") return "";
      return "";
    },
    assertPort: async () => {},
    poll: async () => { throw new Error("fixture failure"); },
    emit: () => {}
  }), /DEPLOYMENT_HEALTHCHECK_FAILED:CLEANUP_OK/u);
  for (const [, environment] of received) assert.deepEqual(environment, selectors);
});

test("production requires canonical encoded database passwords and strong secret files", () => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-runtime-"));
  try {
    const appPassword = "a".repeat(31);
    writeFileSync(join(directory, "mysql_app_password"), appPassword, { mode: 0o600 });
    writeFileSync(join(directory, "mysql_root_password"), "r".repeat(32), { mode: 0o600 });
    assert.throws(
      () => validateProductionSecrets({
        ...productionEnvironment,
        SHENSI_MYSQL_APP_PASSWORD: appPassword,
        DATABASE_URL: `mysql://shensi_app:${appPassword}@mysql:3306/shensi`
      }, directory),
      /PRODUCTION_SECRET_FILE_TOO_SHORT/u
    );
    const encodedPassword = "a".repeat(31) + "@";
    writeFileSync(join(directory, "mysql_app_password"), encodedPassword, { mode: 0o600 });
    assert.throws(
      () => validateProductionSecrets({
        ...productionEnvironment,
        SHENSI_MYSQL_APP_PASSWORD: encodedPassword,
        DATABASE_URL: `mysql://shensi_app:${encodedPassword}@mysql:3306/shensi`
      }, directory),
      /DATABASE_URL_PASSWORD_NOT_CANONICAL/u
    );
    const canonicalPassword = "x".repeat(31) + "@";
    writeFileSync(join(directory, "mysql_app_password"), canonicalPassword, { mode: 0o600 });
    writeFileSync(join(directory, "mysql_root_password"), "r".repeat(31), { mode: 0o600 });
    assert.throws(() => validateProductionSecrets({
      ...productionEnvironment,
      SHENSI_MYSQL_APP_PASSWORD: canonicalPassword,
      DATABASE_URL: `mysql://shensi_app:${encodeURIComponent(canonicalPassword)}@mysql:3306/shensi`
    }, directory), /PRODUCTION_SECRET_FILE_TOO_SHORT/u);
    writeFileSync(join(directory, "mysql_root_password"), "r".repeat(32), { mode: 0o600 });
    assert.doesNotThrow(() => validateProductionSecrets({
      ...productionEnvironment,
      SHENSI_MYSQL_APP_PASSWORD: canonicalPassword,
      DATABASE_URL: `mysql://shensi_app:${encodeURIComponent(canonicalPassword)}@mysql:3306/shensi`
    }, directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("same Compose gateway ownership permits redeploy while unrelated port ownership fails closed", async () => {
  const calls = [];
  const lines = [];
  await deployProduction("/workspace", productionEnvironment, {
    assertDocker: () => {},
    runCompose(argumentsList) {
      calls.push(argumentsList);
      if (argumentsList.join(" ") === "ps -q gateway") return "gateway-id\n";
      if (argumentsList[0] === "ps") return '{"Service":"gateway","State":"running"}\n';
      return "";
    },
    inspectContainer: () => '{"8080/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}]}',
    assertPort: async () => assert.fail("same project must be allowed to reuse its gateway port"),
    poll: async () => {},
    emit: (line) => lines.push(line)
  });
  assert.deepEqual(calls.slice(0, 4), [
    ["config", "--quiet"],
    ["ps", "-q", "gateway"],
    ["build"],
    ["up", "-d"]
  ]);
  assert.deepEqual(lines, ["SERVICE:gateway STATE:running", "PUBLIC_ORIGIN:https://shensi.example"]);
  assert.doesNotMatch(lines.join("\n"), /fixture-(?:app-password|security)/u);

  await assert.rejects(deployProduction("/workspace", productionEnvironment, {
    assertDocker: () => {},
    runCompose(argumentsList) {
      if (argumentsList.join(" ") === "ps -q gateway") return "";
      return "";
    },
    assertPort: async () => { throw new Error("PORT_UNAVAILABLE:8080"); },
    poll: async () => {},
    emit: () => {}
  }), /PORT_UNAVAILABLE:8080/u);
});

test("failed post-up health checks run deterministic Compose cleanup without leaking configuration", async () => {
  const calls = [];
  await assert.rejects(deployProduction("/workspace", productionEnvironment, {
    assertDocker: () => {},
    runCompose(argumentsList) {
      calls.push(argumentsList);
      if (argumentsList.join(" ") === "ps -q gateway") return "";
      return "";
    },
    assertPort: async () => {},
    poll: async () => { throw new Error("fixture-secret-must-not-escape"); },
    emit: () => {}
  }), /DEPLOYMENT_HEALTHCHECK_FAILED:CLEANUP_OK/u);
  assert.deepEqual(calls.at(-1), ["down", "--remove-orphans"]);
});

test("verification includes frontend type tests before health requests", async () => {
  const commands = [];
  await runVerification("/workspace", {}, {
    run(command, argumentsList) { commands.push([command, argumentsList]); },
    verifyHealth: async () => {}
  });
  assert.deepEqual(commands, [
    [process.execPath, ["scripts/context-check.mjs"]],
    ["pnpm", ["--filter", "./contracts", "test"]],
    ["pnpm", ["--filter", "./backend", "build"]],
    ["pnpm", ["--filter", "./frontend", "test"]],
    ["pnpm", ["--filter", "./frontend", "test:types"]],
    ["pnpm", ["--filter", "./frontend", "build"]]
  ]);
});
