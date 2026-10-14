import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { API_ONLY_CRYPTO_SECRET_BINDINGS } from "./api-only-runtime.mjs";
import { discoverComposeRuntime } from "./container-runtime.mjs";
import { assertPortAvailable, terminateProcessTree } from "./dev.mjs";
import { readKnowledgeReaderRuntime } from './knowledge-reader-runtime.mjs';

const TARGET = Object.freeze({ version: 1, project: "shensi-desktop-local", database: "shensi_desktop",
  databaseUser: "shensi_desktop", mysqlPort: 3313, backendPort: 5638 });
const OWNER_LABEL = "io.shensi.desktop-local.owner";
const HASH = /^[a-f0-9]{64}$/u;
const SECRET_NAMES = [...Object.keys(API_ONLY_CRYPTO_SECRET_BINDINGS), "mysql_root_password",
  "mysql_password", "initial_admin_password"];
const error = (code) => new Error(`DESKTOP_LOCAL_${code}`);
const localRoot = (repo) => join(repo, ".runtime/desktop-local");

async function privateEntry(path, directory = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || info.uid !== process.getuid?.()
    || (directory ? !info.isDirectory() : !info.isFile())
    || (info.mode & 0o7777) !== (directory ? 0o700 : 0o600)) throw error("PRIVATE_FILE_INVALID");
}
async function privateDirectory(path) {
  try { await mkdir(path, { mode: 0o700 }); } catch (cause) { if (cause.code !== "EEXIST") throw cause; }
  await privateEntry(path, true);
}
async function retainedPrivateFile(path, contents) {
  try { await writeFile(path, contents, { mode: 0o600, flag: "wx" }); }
  catch (cause) { if (cause.code !== "EEXIST") throw cause; }
  await privateEntry(path);
  if (await readFile(path, "utf8") !== contents) throw error("PRIVATE_FILE_MISMATCH");
}
function validateConfig(config, engine) {
  if (!config || Object.entries(TARGET).some(([key, value]) => config[key] !== value)
    || !HASH.test(config.owner ?? "") || !HASH.test(config.engine ?? "")
    || !config.secrets || Object.keys(config.secrets).length !== SECRET_NAMES.length
    || SECRET_NAMES.some((key) => !/^[A-Za-z0-9_-]{64}$/u.test(config.secrets[key] ?? ""))) throw error("CONFIG_INVALID");
  if (config.engine !== engine) throw error("ENGINE_CHANGED");
}

async function embeddedReferenceRuntime(repo) {
  const directory=join(repo,'.runtime/embedded-reference'),manifestPath=join(directory,'manifest.json');
  try{await privateEntry(manifestPath);}catch(cause){if(cause.code==='ENOENT')return {mode:'disabled'};throw error('REFERENCE_PACK_INVALID');}
  try{
    await privateEntry(directory,true);
    const raw=await readFile(manifestPath,'utf8');if(Buffer.byteLength(raw)>4096)throw Error();
    const value=JSON.parse(raw),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
    if(!value||Object.keys(value).sort().join(',')!=='corpusId,file,releaseId,sha256,sourceCount,version'||value.version!==1
      ||value.file!=='books.json.gz'||value.sourceCount!==21||!HASH.test(value.sha256??'')||!uuid.test(value.corpusId??'')||!uuid.test(value.releaseId??''))throw Error();
    const packPath=join(directory,'books.json.gz');await privateEntry(packPath);
    const info=await lstat(packPath);if(info.size<1||info.size>64*1024*1024)throw Error();
    if(createHash('sha256').update(await readFile(packPath)).digest('hex')!==value.sha256)throw Error();
    return {mode:'embedded',packPath,packHash:value.sha256};
  }catch{throw error('REFERENCE_PACK_INVALID');}
}
async function referenceRuntime(root, owner, repo) {
  const path = join(root, 'system-reference.json');
  try { await privateEntry(path); }
  catch (cause) { if (cause.code === 'ENOENT') return embeddedReferenceRuntime(repo); throw error('REFERENCE_CONFIG_INVALID'); }
  try {
    const bytes = await readFile(path, 'utf8');
    if (Buffer.byteLength(bytes) > 4096) throw Error();
    const value = JSON.parse(bytes);
    if (!value || value.version !== 1 || value.mode !== 'client' || Object.keys(value).sort().join(',') !== 'mode,origin,version') throw Error();
    const url = new URL(value.origin);
    if (url.protocol !== 'https:' || url.origin !== value.origin || url.username || url.password || url.search || url.hash) throw Error();
    return { mode:'client',origin:value.origin,issuer:value.origin,
      backendInstanceId:createHash('sha256').update(`reference-connection.v1:${owner}`).digest('hex') };
  } catch { throw error('REFERENCE_CONFIG_INVALID'); }
}

export async function prepareDesktopLocalRuntime(repo, engine) {
  if (!HASH.test(engine)) throw error("ENGINE_INVALID");
  // The shared .runtime directory already belongs to other retained runtimes;
  // never change its permissions, credentials, records or data.
  await mkdir(join(repo, ".runtime"), { recursive: true, mode: 0o700 });
  const parent = await lstat(join(repo, ".runtime"));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()) throw error("PRIVATE_FILE_INVALID");
  const root = localRoot(repo);
  await privateDirectory(root);
  const path = join(root, "config.json");
  let config;
  try {
    await privateEntry(path);
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
    config = { ...TARGET, owner: randomBytes(32).toString("hex"), engine,
      secrets: Object.fromEntries(SECRET_NAMES.map((name) => [name, randomBytes(48).toString("base64url")])) };
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  validateConfig(config, engine);
  await privateDirectory(join(root, "secrets"));
  for (const name of ["mysql_root_password", "mysql_password", "initial_admin_password"]) {
    await retainedPrivateFile(join(root, "secrets", name), config.secrets[name]);
  }
  const knowledgeRoot = resolve(root, 'knowledge');
  await privateDirectory(knowledgeRoot);
  // Derived by this trusted launcher, never from inherited environment or the
  // persisted JSON's optional fields. Existing credentials are unchanged.
  let knowledgeReader,knowledgeReaderFailure;
  try{knowledgeReader=await readKnowledgeReaderRuntime(repo);}catch{knowledgeReaderFailure='knowledge_reader_configuration_invalid';}
  const reference = await referenceRuntime(root, config.owner, repo);
  return { ...config, knowledgeRoot, knowledgeReader, reference,...(knowledgeReaderFailure?{knowledgeReaderFailure}:{}) };
}

function hostEnvironment(environment) {
  return { ...Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SHELL"]
    .filter((key) => typeof environment[key] === "string").map((key) => [key, environment[key]])),
    // Keep the caller's explicit no-install choice through nested pnpm builds.
    // Never inherit arbitrary npm configuration or dependency-install modes.
    ...(environment.pnpm_config_verify_deps_before_run === "false"
      ? { pnpm_config_verify_deps_before_run: "false" } : {}) };
}

export function desktopLocalBackendEnvironment(config, buildDigest, inherited = process.env, uiOnly = false) {
  validateConfig(config, config.engine);
  if (!HASH.test(buildDigest)) throw error("BUILD_INVALID");
  if (!isAbsolute(config.knowledgeRoot ?? '')) throw error('KNOWLEDGE_ROOT_INVALID');
  return { ...hostEnvironment(inherited),
    ...Object.fromEntries(Object.keys(API_ONLY_CRYPTO_SECRET_BINDINGS).map((key) => [key, config.secrets[key]])),
    NODE_ENV: "production", SHENSI_SKIP_LOCAL_ENV: "true", CRM_STORE: "mysql", CRM_SEED_DEVELOPMENT_DATA: "false",
    SHENSI_REFERENCE_MODE: config.reference?.mode ?? 'disabled',
    ...(config.reference?.mode === 'embedded' ? {SHENSI_REFERENCE_PACK:config.reference.packPath,SHENSI_REFERENCE_PACK_SHA256:config.reference.packHash}:{}),
    ...(config.reference?.mode === 'client' ? { SHENSI_REFERENCE_ORIGIN:config.reference.origin,
      SHENSI_REFERENCE_ISSUER:config.reference.issuer, SHENSI_REFERENCE_BACKEND_INSTANCE_ID:config.reference.backendInstanceId } : {}),
    SHENSI_KNOWLEDGE_STORAGE_ROOT: config.knowledgeRoot,
    ...(config.knowledgeReaderFailure?{SHENSI_KNOWLEDGE_READER_CONFIGURATION_INVALID:'true'}:{}),
    ...(config.knowledgeReader ? { SHENSI_KNOWLEDGE_READER_PYTHON:config.knowledgeReader.python,
      SHENSI_KNOWLEDGE_READER_SCRIPT:config.knowledgeReader.script,
      ...(config.knowledgeReader.manifest?{SHENSI_KNOWLEDGE_PREEXTRACTED_MANIFEST:config.knowledgeReader.manifest}:{}) } : {}),
    DATABASE_URL: `mysql://${config.databaseUser}:${encodeURIComponent(config.secrets.mysql_password)}@127.0.0.1:${config.mysqlPort}/${config.database}`,
    BACKEND_HOST: "127.0.0.1", PORT: String(config.backendPort), CORS_ORIGINS: `http://127.0.0.1:${config.backendPort}`,
    SESSION_COOKIE_SECURE: "false", TRUSTED_PROXY_CIDRS: "", SHENSI_API_GATEWAY_IP: "",
    // The desktop executor can only claim the user's separately approved
    // actions. The retired server executor stays disabled.
    DOUYIN_OUTREACH_ACTIONS_ENABLED: "false", DOUYIN_OUTREACH_APPROVALS_ENABLED: uiOnly ? "false" : "true",
    DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED: "false", DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: uiOnly ? "false" : "true",
    SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "exact", SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: buildDigest,
    PROSPECT_WORKER_ENABLED: "false", PROSPECT_SCHEDULER_ENABLED: "false", PROSPECT_QUEUE_REQUIRED: "false",
    REDIS_URL: "", ENABLE_API_DOCS: "false", INITIAL_ADMIN_EMAIL: "bootstrap@shensi.local",
    INITIAL_ADMIN_PASSWORD: config.secrets.initial_admin_password, INITIAL_ADMIN_NAME: "Local Bootstrap" };
}

export function desktopLocalCompose(config, root) {
  validateConfig(config, config.engine);
  const labels = { [OWNER_LABEL]: config.owner };
  return { name: config.project,
    services: { mysql: { image: "mysql:8.4.11", restart: "unless-stopped", labels,
      environment: { MYSQL_DATABASE: config.database, MYSQL_USER: config.databaseUser,
        MYSQL_PASSWORD_FILE: "/run/secrets/mysql_password", MYSQL_ROOT_PASSWORD_FILE: "/run/secrets/mysql_root_password" },
      ports: [`127.0.0.1:${config.mysqlPort}:3306`], volumes: ["mysql_data:/var/lib/mysql"],
      secrets: ["mysql_root_password", "mysql_password"],
      healthcheck: { test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "--silent"],
        interval: "2s", timeout: "3s", retries: 60, start_period: "15s" } } },
    volumes: { mysql_data: { labels } }, networks: { default: { labels } },
    secrets: Object.fromEntries(["mysql_root_password", "mysql_password"].map((name) => [name, { file: join(root, "secrets", name) }])) };
}

export function assertDesktopLocalResources(config, resources) {
  for (const resource of resources) {
    const labels = resource.Labels ?? resource.Config?.Labels;
    if (labels?.["com.docker.compose.project"] !== config.project || labels?.[OWNER_LABEL] !== config.owner) throw error("RESOURCE_FOREIGN");
  }
}

export function parseDesktopLocalCommand(args) {
  if (args.length !== 1 || !["prepare", "start", "start-ui"].includes(args[0])) throw error("COMMAND_INVALID");
  return args[0];
}

function engineRead(runtime, path) {
  return new Promise((resolveValue, reject) => {
    const req = request({ socketPath: runtime.socket.canonicalPath, path, method: "GET", timeout: 5_000 }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; if (text.length > 2_000_000) req.destroy(error("ENGINE_RESPONSE_INVALID")); });
      res.on("end", () => {
        if (res.statusCode === 404) return resolveValue(null);
        if (res.statusCode !== 200) return reject(error("ENGINE_READ_FAILED"));
        try { resolveValue(JSON.parse(text)); } catch { reject(error("ENGINE_RESPONSE_INVALID")); }
      });
    });
    req.on("timeout", () => req.destroy(error("ENGINE_READ_TIMEOUT")));
    req.on("error", reject); req.end();
  });
}

async function assertRetainedResources(runtime, config) {
  const filter = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${config.project}`] }));
  const [containers, volumes, networks, namedVolume, namedNetwork] = await Promise.all([
    engineRead(runtime, `/containers/json?all=1&filters=${filter}`),
    engineRead(runtime, `/volumes?filters=${filter}`), engineRead(runtime, `/networks?filters=${filter}`),
    engineRead(runtime, `/volumes/${config.project}_mysql_data`), engineRead(runtime, `/networks/${config.project}_default`)
  ]);
  const resources = [...containers, ...(volumes.Volumes ?? []), ...networks, ...[namedVolume, namedNetwork].filter(Boolean)];
  assertDesktopLocalResources(config, resources);
  return containers;
}

function managedChild(command, args, options) {
  const { gracefulRoot = false, ...spawnOptions } = options ?? {};
  const child = spawn(command, args, { shell: false, detached: true, stdio: "inherit", ...spawnOptions });
  const done = new Promise((resolveValue) => {
    child.once("error", () => resolveValue(1));
    child.once("exit", (code) => resolveValue(code ?? 1));
  });
  return { child, done, gracefulRoot };
}

export async function withDesktopLocalProcesses(work, { signalSource = process, shutdownTimeoutMs = 10_000 } = {}) {
  const children = [];
  let stopping = false;
  let timeout;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const item of children) {
      if (item.child.exitCode !== null || item.child.signalCode !== null) continue;
      // Electron Main already owns renderer/Sidecar shutdown; let its controlled
      // quit run before escalating to the process group if it gets stuck.
      if (item.gracefulRoot) item.child.kill("SIGTERM");
      else terminateProcessTree(item.child, "SIGTERM");
    }
    // Start escalation now, not after an unresponsive child's done settles.
    timeout = setTimeout(() => {
      for (const item of children) if (item.child.exitCode === null && item.child.signalCode === null) terminateProcessTree(item.child, "SIGKILL");
    }, shutdownTimeoutMs);
  };
  const pool = { get stopped() { return stopping; }, launch(command, args, options) {
    if (stopping) throw error("START_CANCELLED");
    const item = managedChild(command, args, options); children.push(item); return item;
  } };
  signalSource.once("SIGINT", stop); signalSource.once("SIGTERM", stop);
  try { return await work(pool); }
  finally {
    stop(); await Promise.all(children.map((item) => item.done)); clearTimeout(timeout);
    signalSource.removeListener("SIGINT", stop); signalSource.removeListener("SIGTERM", stop);
  }
}

async function prepareDatabase(repo, pool) {
  const runtime = await discoverComposeRuntime();
  const config = await prepareDesktopLocalRuntime(repo, runtime.daemon.identity);
  const root = localRoot(repo);
  const existing = await assertRetainedResources(runtime, config);
  if (!existing.some((item) => item.State === "running")) await assertPortAvailable(config.mysqlPort);
  const composePath = join(root, "compose.json");
  await retainedPrivateFile(composePath, `${JSON.stringify(desktopLocalCompose(config, root), null, 2)}\n`);
  const selected = await discoverComposeRuntime();
  if (selected.daemon.identity !== config.engine) throw error("ENGINE_CHANGED");
  // Fresh-local is a separate, fixed, user-authorized profile. It does not
  // manufacture the historical api-only migration/cutover permissions.
  const started = pool.launch(selected.argvPrefix[0], [...selected.argvPrefix.slice(1), "-p", config.project,
    "-f", composePath, "up", "-d", "--wait", "--wait-timeout", "120", "mysql"],
  { cwd: root, env: { ...hostEnvironment(selected.environment), DOCKER_HOST: selected.environment.DOCKER_HOST,
    COMPOSE_DISABLE_ENV_FILE: "true" } });
  if (await started.done !== 0) throw error("MYSQL_START_FAILED");
  await assertRetainedResources(selected, config);
  console.log(`DESKTOP_LOCAL_MYSQL_READY project=${config.project} port=${config.mysqlPort} database=${config.database}`);
  return config;
}

export async function prepareDesktopLocalDatabase(repo) {
  return withDesktopLocalProcesses((pool) => prepareDatabase(repo, pool));
}

async function backendReady(origin, child, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw error("BACKEND_EXITED");
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2_000) });
      const body = await response.json();
      if (response.ok && body.ok === true && body.store === "mysql") return;
    } catch { /* The real schema initialization may still be running. */ }
    await delay(500);
  }
  throw error("BACKEND_NOT_READY");
}

export async function startDesktopLocal(repo, uiOnly = false) {
  return withDesktopLocalProcesses(async (pool) => {
  await assertPortAvailable(TARGET.backendPort);
  const config = await prepareDatabase(repo, pool);
    const safeEnv = hostEnvironment(process.env);
    for (const command of ["desktop:build:main", "desktop:build:renderer"]) {
      const build = pool.launch("pnpm", [command], { cwd: repo, env: safeEnv });
      if (await build.done !== 0) throw error("BUILD_FAILED");
    }
    const { prepareDevelopmentBuildIdentity, startDevelopmentDesktop } = await import("../desktop/scripts/prepare-dev-build-identity.mjs");
    const manifestPath = await prepareDevelopmentBuildIdentity(repo);
    const digest = createHash("sha256").update(await readFile(manifestPath)).digest("hex");
    const requireDesktop = createRequire(join(repo, "desktop/package.json"));
    const requireBackend = createRequire(join(repo, "backend/package.json"));
    const origin = `http://127.0.0.1:${config.backendPort}`;
    const backendLogPath = join(localRoot(repo), "curated-backend.log");
    await mkdir(localRoot(repo), { recursive: true });
    const backendEnv = {
      ...desktopLocalBackendEnvironment(config, digest, process.env, uiOnly),
      SHENSI_DESKTOP_BACKEND_LOG: backendLogPath,
    };
    const backend = pool.launch(process.execPath, [requireBackend.resolve("tsx/cli"), "src/server.ts"],
      { cwd: join(repo, "backend"), env: backendEnv });
    await backendReady(origin, backend.child);
    if (pool.stopped) return;
    let electron;
    await startDevelopmentDesktop({ repositoryRoot: repo, electronExecutable: requireDesktop("electron"),
      environment: { ...safeEnv, SHENSI_REMOTE_ORIGIN: origin },
      spawnProcess: (command, args, options) => {
        electron = pool.launch(command, args, { ...options, gracefulRoot: true }); return electron.child;
      } });
    console.log(`DESKTOP_LOCAL_READY backend=${origin} database=${config.database}; Cmd+Q in the development app or Ctrl+C stops it. MySQL data is retained.`);
    const code = await Promise.race([backend.done, electron.done]);
    if (!pool.stopped && code !== 0) throw error("PROCESS_EXITED");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const command = parseDesktopLocalCommand(process.argv.slice(2));
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    if (command === "prepare") await prepareDesktopLocalDatabase(repo);
    else await startDesktopLocal(repo, command === "start-ui");
  } catch (cause) {
    // Do not echo arbitrary config/driver errors containing credential values.
    console.error(/^DESKTOP_LOCAL_[A-Z_]+$/u.test(cause?.message ?? "") ? cause.message : "DESKTOP_LOCAL_START_FAILED");
    process.exitCode = 1;
  }
}
