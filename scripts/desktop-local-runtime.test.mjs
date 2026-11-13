import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import {createHash,randomUUID} from 'node:crypto';
import { prepareDesktopLocalRuntime, desktopLocalBackendEnvironment,
  desktopLocalCompose, assertDesktopLocalResources, parseDesktopLocalCommand, withDesktopLocalProcesses } from "./desktop-local-runtime.mjs";
import { configureKnowledgeReaderRuntime } from './knowledge-reader-runtime.mjs';

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
  assert.equal(first.knowledgeRoot, join(repo, '.runtime/desktop-local/knowledge'));
  assert.equal((await stat(first.knowledgeRoot)).mode & 0o777, 0o700);
  assert.equal(await readFile(join(old, "jwt_secret"), "utf8"), "old-do-not-copy");
  const other = await prepareDesktopLocalRuntime(await root(), engine);
  assert.notEqual(other.secrets.JWT_SECRET, first.secrets.JWT_SECRET);
  assert.notEqual(other.owner, first.owner);
});

test('reference runtime ignores inherited destinations and has stable installation scope without replacing old secrets',async()=>{
  const repo=await root(),first=await prepareDesktopLocalRuntime(repo,engine);
  const inherited={SHENSI_REFERENCE_MODE:'central',SHENSI_REFERENCE_ORIGIN:'https://evil.example',SHENSI_REFERENCE_ISSUER:'https://evil.example',SHENSI_REFERENCE_BACKEND_INSTANCE_ID:'attacker'};
  const disabled=desktopLocalBackendEnvironment(first,'a'.repeat(64),inherited);
  assert.equal(disabled.SHENSI_REFERENCE_MODE,'disabled');assert.equal(disabled.SHENSI_REFERENCE_ORIGIN,undefined);
  const path=join(repo,'.runtime/desktop-local/system-reference.json');
  await writeFile(path,JSON.stringify({version:1,mode:'client',origin:'https://library.example.test'}),{mode:0o600});
  const configured=await prepareDesktopLocalRuntime(repo,engine),next=await prepareDesktopLocalRuntime(repo,engine);
  const env=desktopLocalBackendEnvironment(configured,'b'.repeat(64),inherited),again=desktopLocalBackendEnvironment(next,'c'.repeat(64));
  assert.equal(env.SHENSI_REFERENCE_MODE,'client');assert.equal(env.SHENSI_REFERENCE_ORIGIN,'https://library.example.test');
  assert.equal(env.SHENSI_REFERENCE_BACKEND_INSTANCE_ID,again.SHENSI_REFERENCE_BACKEND_INSTANCE_ID);
  assert.notEqual(env.SHENSI_REFERENCE_BACKEND_INSTANCE_ID,'attacker');assert.deepEqual(configured.secrets,first.secrets);
  const other=await root();await prepareDesktopLocalRuntime(other,engine);
  await writeFile(join(other,'.runtime/desktop-local/system-reference.json'),JSON.stringify({version:1,mode:'client',origin:'https://library.example.test'}),{mode:0o600});
  assert.notEqual(desktopLocalBackendEnvironment(await prepareDesktopLocalRuntime(other,engine),'a'.repeat(64)).SHENSI_REFERENCE_BACKEND_INSTANCE_ID,env.SHENSI_REFERENCE_BACKEND_INSTANCE_ID);
  await chmod(path,0o644);await assert.rejects(prepareDesktopLocalRuntime(repo,engine),/REFERENCE/u);
});
test('desktop reference configuration rejects central mode, URLs with path and extra fields',async()=>{
  const repo=await root();await prepareDesktopLocalRuntime(repo,engine);const path=join(repo,'.runtime/desktop-local/system-reference.json');
  for(const value of [{version:1,mode:'central',origin:'https://library.example.test'},{version:1,mode:'client',origin:'http://127.0.0.1:1234'},{version:1,mode:'client',origin:'https://library.example.test/'},{version:1,mode:'client',origin:'https://library.example.test',secret:'not-allowed'}]) {
    await writeFile(path,JSON.stringify(value),{mode:0o600});await assert.rejects(prepareDesktopLocalRuntime(repo,engine),/REFERENCE/u);
  }
});

test('a shipped book pack is enabled automatically for a fresh local installation without binding configuration',async()=>{
  const repo=await root(),directory=join(repo,'.runtime/embedded-reference'),bytes=Buffer.from('synthetic-pack');
  await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(join(directory,'books.json.gz'),bytes,{mode:0o600});
  const sha256=createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory,'manifest.json'),JSON.stringify({version:1,file:'books.json.gz',sha256,sourceCount:21,corpusId:randomUUID(),releaseId:randomUUID()}),{mode:0o600});
  const config=await prepareDesktopLocalRuntime(repo,engine),env=desktopLocalBackendEnvironment(config,'b'.repeat(64),{SHENSI_REFERENCE_PACK:'/foreign'});
  assert.equal(env.SHENSI_REFERENCE_MODE,'embedded');assert.equal(env.SHENSI_REFERENCE_PACK,join(directory,'books.json.gz'));
  assert.equal(env.SHENSI_REFERENCE_PACK_SHA256,sha256);assert.equal(env.SHENSI_REFERENCE_ORIGIN,undefined);
  await writeFile(join(directory,'books.json.gz'),'damaged');
  await assert.rejects(prepareDesktopLocalRuntime(repo,engine),/REFERENCE_PACK_INVALID/);
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
    OPENAI_API_KEY: "old-secret", SHENSI_KNOWLEDGE_STORAGE_ROOT: '/foreign'
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
  assert.equal(env.SHENSI_KNOWLEDGE_STORAGE_ROOT, config.knowledgeRoot);
  assert.throws(() => desktopLocalBackendEnvironment(config, "fake", {}), /DESKTOP_LOCAL_BUILD_INVALID/);
});

test('source runtime refuses non-private retained knowledge root', async () => {
  const repo = await root(); const config = await prepareDesktopLocalRuntime(repo, engine);
  await chmod(config.knowledgeRoot, 0o755);
  await assert.rejects(prepareDesktopLocalRuntime(repo, engine), /DESKTOP_LOCAL_PRIVATE_FILE_INVALID/);
});

test('source children retain explicit no-install setting without inheriting private credentials', async () => {
  const config = await prepareDesktopLocalRuntime(await root(), engine);
  const env = desktopLocalBackendEnvironment(config, 'b'.repeat(64), {
    PATH: '/usr/bin', pnpm_config_verify_deps_before_run: 'false',
    OPENAI_API_KEY: 'foreign-private-key', DATABASE_URL: 'foreign-database'
  });
  assert.equal(env.pnpm_config_verify_deps_before_run, 'false');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.notEqual(env.DATABASE_URL, 'foreign-database');
  assert.equal(desktopLocalBackendEnvironment(config, 'b'.repeat(64), {
    pnpm_config_verify_deps_before_run: 'install'
  }).pnpm_config_verify_deps_before_run, undefined);
});

test('knowledge parser uses explicit private runtime selection, never inherited reader or manifest paths',async()=>{
  const repo=await root(),python=join(repo,'python'),script=join(repo,'services/knowledge-reader/shensi_knowledge_reader.py');
  await mkdir(join(repo,'services/knowledge-reader'),{recursive:true});
  await writeFile(python,'synthetic trusted executable',{mode:0o700});await writeFile(script,'parser',{mode:0o644});
  const initial=await prepareDesktopLocalRuntime(repo,engine);
  assert.equal(desktopLocalBackendEnvironment(initial,'b'.repeat(64),{SHENSI_KNOWLEDGE_READER_PYTHON:'/foreign',SHENSI_KNOWLEDGE_PREEXTRACTED_MANIFEST:'/foreign'}).SHENSI_KNOWLEDGE_READER_PYTHON,undefined);
  await configureKnowledgeReaderRuntime(repo,{python});
  const ready=await prepareDesktopLocalRuntime(repo,engine),env=desktopLocalBackendEnvironment(ready,'b'.repeat(64),{SHENSI_KNOWLEDGE_READER_SCRIPT:'/foreign'});
  assert.equal(env.SHENSI_KNOWLEDGE_READER_PYTHON,await realpath(python));assert.equal(env.SHENSI_KNOWLEDGE_READER_SCRIPT,await realpath(script));
  assert.equal((await stat(join(repo,'.runtime/desktop-local/knowledge-reader.json'))).mode&0o777,0o600);
  assert.deepEqual(ready.secrets,initial.secrets);
  await chmod(join(repo,'.runtime/desktop-local/knowledge-reader.json'),0o644);
  const unavailable=await prepareDesktopLocalRuntime(repo,engine);
  assert.equal(unavailable.knowledgeReaderFailure,'knowledge_reader_configuration_invalid');
  assert.equal(unavailable.knowledgeReader,undefined);
  assert.deepEqual(unavailable.secrets,initial.secrets);
  assert.equal(desktopLocalBackendEnvironment(unavailable,'b'.repeat(64)).SHENSI_KNOWLEDGE_READER_CONFIGURATION_INVALID,'true');
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
