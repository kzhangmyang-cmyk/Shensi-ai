import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { prepareDesktopLocalRuntime, desktopLocalBackendEnvironment,
  desktopLocalCompose, assertDesktopLocalResources, parseDesktopLocalCommand, withDesktopLocalProcesses } from "./desktop-local-runtime.mjs";

const engine = "a".repeat(64);
const roots = [];
async function root() { const value = await mkdtemp(join(tmpdir(), "shensi-desktop-local-")); roots.push(value); return value; }
test.after(async () => { for (const value of roots) await rm(value, { recursive: true, force: true }); });

test("fresh local credentials are independent of Trial and survive another prepare", async () => {
  const repo = await root();
  const old = join(repo, ".runtime/real-trial/secrets");
  await mkdir(old, { recursive: true });
  await writeFile(join(old, "jwt_secret"), "old-do-not-copy");
  const first = await prepareDesktopLocalRuntime(repo, engine);
  const second = await prepareDesktopLocalRuntime(repo, engine);
  assert.deepEqual(second, first);
  assert.notEqual(first.secrets.JWT_SECRET, "old-do-not-copy");
  assert.equal(new Set(Object.values(first.secrets)).size, Object.keys(first.secrets).length);
  assert.equal((await stat(join(repo, ".runtime/desktop-local/config.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(repo, ".runtime/desktop-local"))).mode & 0o777, 0o700);
  assert.equal(await readFile(join(old, "jwt_secret"), "utf8"), "old-do-not-copy");
  const other = await prepareDesktopLocalRuntime(await root(), engine);
  assert.notEqual(other.secrets.JWT_SECRET, first.secrets.JWT_SECRET);
  assert.notEqual(other.owner, first.owner);
});

test("fresh local runtime refuses foreign Engine or non-private retained credentials", async () => {
  const repo = await root();
  await prepareDesktopLocalRuntime(repo, engine);
  await assert.rejects(prepareDesktopLocalRuntime(repo, "b".repeat(64)), /DESKTOP_LOCAL_ENGINE_CHANGED/);
  const file = join(repo, ".runtime/desktop-local/config.json");
  await chmod(file, 0o644);
  await assert.rejects(prepareDesktopLocalRuntime(repo, engine), /DESKTOP_LOCAL_PRIVATE_FILE_INVALID/);
});

test("fresh Backend enables confirmed desktop outreach but never the retained server executor", async () => {
  const config = await prepareDesktopLocalRuntime(await root(), engine);
  const env = desktopLocalBackendEnvironment(config, "b".repeat(64), {
    PATH: "/usr/bin", HOME: "/tmp", DATABASE_URL: "old-database",
    MEDIACRAWLER_BASE_URL: "https://old-sidecar", DOUYIN_OUTREACH_ACTIONS_ENABLED: "true",
    OPENAI_API_KEY: "old-secret"
  });
  const database = new URL(env.DATABASE_URL);
  assert.equal(database.hostname, "127.0.0.1");
  assert.equal(database.port, "3313");
  assert.equal(database.pathname, "/shensi_desktop");
  assert.equal(env.CRM_SEED_DEVELOPMENT_DATA, "false");
  assert.equal(env.SHENSI_SKIP_LOCAL_ENV, "true");
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.CORS_ORIGINS, "http://127.0.0.1:5638");
  assert.equal(env.SHENSI_DESKTOP_CLIENT_ADMISSION_MODE, "exact");
  assert.equal(env.SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256, "b".repeat(64));
  assert.equal(env.DOUYIN_OUTREACH_APPROVALS_ENABLED, "true");
  assert.equal(env.DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED, "true");
  assert.equal(env.DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED, "false");
  assert.equal(env.DOUYIN_OUTREACH_ACTIONS_ENABLED, "false");
  assert.equal(env.MEDIACRAWLER_BASE_URL, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.JWT_SECRET, config.secrets.JWT_SECRET);
  assert.throws(() => desktopLocalBackendEnvironment(config, "fake", {}), /DESKTOP_LOCAL_BUILD_INVALID/);
});

test("fresh Compose uses a persistent owned volume, loopback port, and password files", async () => {
  const repo = await root(); const config = await prepareDesktopLocalRuntime(repo, engine);
  const compose = desktopLocalCompose(config, join(repo, ".runtime/desktop-local"));
  assert.deepEqual(Object.keys(compose.services), ["mysql"]);
  assert.deepEqual(compose.services.mysql.ports, ["127.0.0.1:3313:3306"]);
  assert.deepEqual(compose.services.mysql.volumes, ["mysql_data:/var/lib/mysql"]);
  assert.equal(compose.services.mysql.environment.MYSQL_DATABASE, "shensi_desktop");
  assert.equal(compose.services.mysql.environment.MYSQL_ROOT_PASSWORD, undefined);
  assert.ok(compose.secrets.mysql_root_password.file.endsWith("/secrets/mysql_root_password"));
  assert.equal(compose.volumes.mysql_data.labels["io.shensi.desktop-local.owner"], config.owner);
  assert.equal(JSON.stringify(compose).includes(config.secrets.mysql_root_password), false);
});

test("UI acceptance disables approval and both executors without changing database identity", async () => {
  const config = await prepareDesktopLocalRuntime(await root(), engine);
  const normal = desktopLocalBackendEnvironment(config, "b".repeat(64), {});
  const ui = desktopLocalBackendEnvironment(config, "b".repeat(64), { DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: "true" }, true);
  for (const name of ["DOUYIN_OUTREACH_ACTIONS_ENABLED", "DOUYIN_OUTREACH_APPROVALS_ENABLED", "DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED", "DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED"]) assert.equal(ui[name], "false");
  assert.equal(ui.DATABASE_URL, normal.DATABASE_URL);
  assert.equal(ui.JWT_SECRET, normal.JWT_SECRET);
  assert.equal(parseDesktopLocalCommand(["start-ui"]), "start-ui");
});

test("fresh resource checks reject same-name resources not owned by this runtime", async () => {
  const config = await prepareDesktopLocalRuntime(await root(), engine);
  const labels = { "com.docker.compose.project": config.project, "io.shensi.desktop-local.owner": config.owner };
  assert.doesNotThrow(() => assertDesktopLocalResources(config, [{ Labels: labels }]));
  assert.throws(() => assertDesktopLocalResources(config, [{ Labels: { ...labels, "io.shensi.desktop-local.owner": "foreign" } }]), /DESKTOP_LOCAL_RESOURCE_FOREIGN/);
  assert.throws(() => assertDesktopLocalResources(config, [{ Labels: null }]), /DESKTOP_LOCAL_RESOURCE_FOREIGN/);
});

test("fresh runtime CLI never accepts arbitrary targets or destructive commands", () => {
  assert.equal(parseDesktopLocalCommand(["start"]), "start");
  assert.equal(parseDesktopLocalCommand(["prepare"]), "prepare");
  for (const args of [["reset"], ["delete"], ["start", "--port", "3310"], []]) {
    assert.throws(() => parseDesktopLocalCommand(args), /DESKTOP_LOCAL_COMMAND_INVALID/);
  }
});

test("cancelling startup escalates unresponsive owned children before waiting and prevents more launches", { timeout: 5_000 }, async () => {
  const signals = new EventEmitter();
  let child;
  await withDesktopLocalProcesses(async (pool) => {
    const item = pool.launch(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: "pipe" });
    child = item.child;
    await once(child.stdout, "data");
    signals.emit("SIGTERM");
    assert.throws(() => pool.launch(process.execPath, ["-e", "process.exit(0)"]), /DESKTOP_LOCAL_START_CANCELLED/);
    await item.done;
  }, { signalSource: signals, shutdownTimeoutMs: 30 });
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("startup failure stops its already-started child", { timeout: 5_000 }, async () => {
  let child;
  await assert.rejects(withDesktopLocalProcesses(async (pool) => {
    const item = pool.launch(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { stdio: "pipe" });
    child = item.child;
    await once(child.stdout, "data");
    throw new Error("startup-failed");
  }, { signalSource: new EventEmitter(), shutdownTimeoutMs: 30 }), /startup-failed/);
  assert.notEqual(child.signalCode, null);
});

test("Electron-style root is allowed to shut down its own children before group escalation", { timeout: 5_000 }, async () => {
  const signals = new EventEmitter();
  let child;
  const descendant = "process.on('SIGTERM', () => process.exit(42)); process.on('message', () => process.exit(0)); process.send('ready');";
  const main = `const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    child.on('message', () => console.log('ready'));
    child.on('exit', code => process.exit(code ?? 1));
    process.on('SIGTERM', () => child.send('quit'));`;
  await withDesktopLocalProcesses(async (pool) => {
    const item = pool.launch(process.execPath, ["-e", main], { stdio: "pipe", gracefulRoot: true });
    child = item.child;
    await once(child.stdout, "data");
    signals.emit("SIGTERM");
    assert.equal(await item.done, 0);
  }, { signalSource: signals, shutdownTimeoutMs: 300 });
  assert.equal(child.exitCode, 0);
});
