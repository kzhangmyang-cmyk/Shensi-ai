import { createHash, randomBytes } from "node:crypto";
import { execFile as nativeExecFile, spawn as nativeSpawn } from "node:child_process";
import { constants as FS } from "node:fs";
import * as nativeFs from "node:fs/promises";
import { request } from "node:http";
import { isIP, SocketAddress } from "node:net";
import { userInfo as nativeUserInfo } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertApiOnlyAcceptedResourceProjection } from "./lib/api-only-authority.mjs";

const execFile = promisify(nativeExecFile);
const RECORD_NAME = "container-runtime-selection.json";
const MAX_METADATA_BYTES = 65_536;
const MAX_RECORD_BYTES = 65_536;
const MAX_OUTPUT_BYTES = 8_192;
const MAX_ENGINE_INSPECTION_BYTES = 1_048_576;
const MAX_ROUTE_INSPECTION_BYTES = 262_144;
const INSPECTION_TIMEOUT_MS = 3_000;
const ROUTE_EXECUTABLE = "/usr/sbin/netstat";
const SAFE_ENVIRONMENT_NAMES = ["PATH", "TMPDIR", "XDG_RUNTIME_DIR"];
const PRIVATE_API_FILES = ["SHENSI_API_BACKEND_ENV_FILE", "SHENSI_API_MYSQL_APP_PASSWORD_FILE", "SHENSI_API_MYSQL_ROOT_PASSWORD_FILE", "SHENSI_API_GATEWAY_CONFIG_FILE"];
const API_ENVIRONMENT_NAMES = [...PRIVATE_API_FILES, "SHENSI_API_RUNTIME_ROOT", "SHENSI_API_HTTP_PORT", "SHENSI_API_MYSQL_HOST_PORT", "SHENSI_API_INTERNAL_SUBNET", "SHENSI_API_IPAM_GATEWAY", "SHENSI_API_GATEWAY_IP", "SHENSI_API_RUNTIME_NONCE", "SHENSI_API_DAEMON_IDENTITY"];
const PROJECT = /^shensi-api(?:-[a-z0-9-]+)?$/u;
const NONCE = /^[a-f0-9]{64}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const resolvedRuntimes = new WeakSet();
const authorizations = new WeakMap();
const composeEnvironments = new WeakMap();
const validatedComposeInputs = new WeakMap();
const acceptedResourceInspections = new WeakMap();
const acceptedComposeExecutions = new WeakMap();
const validatedAcceptedComposeInputs = new WeakMap();
const acceptedLifecycleExecutions = new WeakMap();
const ACCEPTED_LIFECYCLE_OPERATIONS = new Set(["status", "start-mysql", "start-runtime", "stop"]);
const MACOS_SPLIT_DEFAULT_ROUTE_CIDRS = Object.freeze([
  "1.0.0.0/8", "2.0.0.0/7", "4.0.0.0/6", "8.0.0.0/5",
  "16.0.0.0/4", "32.0.0.0/3", "64.0.0.0/2", "128.0.0.0/1"
]);
const MACOS_SPLIT_DEFAULT_ROUTE_SET = new Set(MACOS_SPLIT_DEFAULT_ROUTE_CIDRS);

function failure(code) { return new Error(code); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value) { return JSON.stringify(value); }
function exactKeys(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key, index) => Object.keys(value)[index] === key); }
function sameKeySet(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function frozen(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const nested of Object.values(value)) frozen(nested); Object.freeze(value); } return value; }
function io(dependencies = {}) { return { lstat: dependencies.lstat ?? nativeFs.lstat, realpath: dependencies.realpath ?? nativeFs.realpath, readlink: dependencies.readlink ?? nativeFs.readlink, readdir: dependencies.readdir ?? nativeFs.readdir, open: dependencies.open ?? nativeFs.open, rename: dependencies.rename ?? nativeFs.rename, access: dependencies.access ?? nativeFs.access }; }
function safeOwner(stat, uid) { return (stat.uid === 0 || stat.uid === uid) && (stat.mode & 0o022) === 0; }
function statIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
async function descriptorStat(handle) { return await (handle.stat ? handle.stat() : handle.fstat()); }
function validUtc(value) { try { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && new Date(value).toISOString() === value; } catch { return false; } }
function unixDockerHost(path) { return `unix://${path}`; }

function parseUnixDockerHost(value) {
  if (typeof value !== "string" || !value.startsWith("unix://")) throw failure("DOCKER_HOST_UNIX_SOCKET_REQUIRED");
  const path = value.slice(7);
  if (!isAbsolute(path) || path.includes("\0") || resolve(path) !== path || /[?#]/u.test(path)) throw failure("DOCKER_HOST_UNIX_SOCKET_REQUIRED");
  return path;
}

async function walkNoFollow(path, uid, dependencies, { exactUserFrom, final } = {}) {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) throw failure("PATH_INVALID");
  const fs = io(dependencies);
  const root = parsePath(path).root;
  let cursor = root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink?.()) throw failure("PATH_SYMLINK_FORBIDDEN");
    const insideUserRoot = exactUserFrom && (cursor === exactUserFrom || relative(exactUserFrom, cursor) && !relative(exactUserFrom, cursor).startsWith(".."));
    if (insideUserRoot ? stat.uid !== uid || (stat.mode & 0o022) !== 0 : !safeOwner(stat, uid)) throw failure("PATH_OWNER_INVALID");
    if (index < parts.length - 1 && !stat.isDirectory?.()) throw failure("PATH_TYPE_INVALID");
    if (index === parts.length - 1 && final && !final(stat)) throw failure("PATH_TYPE_INVALID");
  }
  return path;
}

async function resolveSafeExecutable(path, uid, dependencies) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path.includes("\0")) return null;
  const fs = io(dependencies);
  let pending = path;
  const seen = new Set();
  for (let hops = 0; hops <= 16; hops += 1) {
    try {
      const root = parsePath(pending).root;
      let cursor = root;
      const parts = pending.slice(root.length).split(sep).filter(Boolean);
      let followed = false;
      for (let index = 0; index < parts.length; index += 1) {
        cursor = join(cursor, parts[index]);
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink?.()) {
          if (![0, uid].includes(stat.uid) || seen.has(cursor)) return null;
          seen.add(cursor);
          const target = await fs.readlink(cursor);
          pending = resolve(dirname(cursor), target, ...parts.slice(index + 1));
          followed = true;
          break;
        }
        if (!safeOwner(stat, uid)) return null;
        if (index < parts.length - 1 && !stat.isDirectory?.()) return null;
        if (index === parts.length - 1 && !stat.isFile?.()) return null;
      }
      if (followed) continue;
      const canonical = await fs.realpath(pending);
      await fs.access(canonical, FS.X_OK);
      return canonical;
    } catch { return null; }
  }
  return null;
}

async function resolveSafeSystemSocket(path, uid, dependencies) {
  const fs = io(dependencies); let pending = path; const seen = new Set();
  for (let hops = 0; hops <= 16; hops += 1) {
    const root = parsePath(pending).root; let cursor = root; const parts = pending.slice(root.length).split(sep).filter(Boolean); let followed = false;
    for (let index = 0; index < parts.length; index += 1) {
      cursor = join(cursor, parts[index]); const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink?.()) {
        if (![0, uid].includes(stat.uid) || seen.has(cursor)) throw failure("DOCKER_SOCKET_REQUIRED");
        seen.add(cursor); pending = resolve(dirname(cursor), await fs.readlink(cursor), ...parts.slice(index + 1)); followed = true; break;
      }
      if (!safeOwner(stat, uid)) throw failure("DOCKER_SOCKET_REQUIRED");
      if (index < parts.length - 1 && !stat.isDirectory?.()) throw failure("DOCKER_SOCKET_REQUIRED");
      if (index === parts.length - 1 && !stat.isSocket?.()) throw failure("DOCKER_SOCKET_REQUIRED");
    }
    if (!followed) return await fs.realpath(pending);
  }
  throw failure("DOCKER_SOCKET_REQUIRED");
}

async function readBoundedOwnerFile(path, home, uid, dependencies) {
  const fs = io(dependencies);
  await walkNoFollow(path, uid, dependencies, { exactUserFrom: home, final: (stat) => stat.isFile?.() && stat.uid === uid && (stat.mode & 0o022) === 0 && stat.nlink === 1 && stat.size > 0 && stat.size <= MAX_METADATA_BYTES });
  const handle = await fs.open(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
  try {
    const before = await descriptorStat(handle);
    if (!before.isFile?.() || before.uid !== uid || (before.mode & 0o022) !== 0 || before.nlink !== 1 || before.size < 1 || before.size > MAX_METADATA_BYTES) throw failure("DOCKER_METADATA_INVALID");
    const bytes = await handle.readFile();
    const after = await descriptorStat(handle);
    const pathStat = await fs.lstat(path);
    if (bytes.length !== before.size || bytes.length > MAX_METADATA_BYTES || !statIdentity(before, after) || !statIdentity(before, pathStat)) throw failure("DOCKER_METADATA_INVALID");
    return bytes;
  } finally { await handle.close(); }
}

async function readBoundedMetadata(path, home, uid, dependencies) {
  try { return JSON.parse((await readBoundedOwnerFile(path, home, uid, dependencies)).toString("utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw failure("DOCKER_METADATA_INVALID"); }
}

function classifySocket(path, home, contextName) {
  if (path === join(home, ".docker", "run", "docker.sock")) return { provider: "docker-desktop", profile: "desktop-linux" };
  const colimaRoot = join(home, ".colima");
  const rel = relative(colimaRoot, path);
  const parts = rel.split(sep);
  if (!rel.startsWith("..") && parts.length === 2 && parts[1] === "docker.sock" && PROFILE.test(parts[0])) {
    if (contextName === "colima" && parts[0] !== "default") throw failure("DOCKER_METADATA_INVALID");
    if (contextName?.startsWith("colima-") && contextName.slice(7) !== parts[0]) throw failure("DOCKER_METADATA_INVALID");
    return { provider: "colima", profile: parts[0] };
  }
  if (path === "/var/run/docker.sock") return { provider: "system-local", profile: "system-local" };
  return { provider: "explicit", profile: "explicit" };
}

async function validateSocketCandidate(candidate, home, uid, dependencies) {
  const fs = io(dependencies);
  try {
    const allowSystemLinks = candidate.path === "/var/run/docker.sock";
    let canonical = candidate.path;
    if (allowSystemLinks) {
      canonical = await resolveSafeSystemSocket(candidate.path, uid, dependencies);
      await walkNoFollow(canonical, uid, dependencies, { exactUserFrom: canonical.startsWith(`${home}${sep}`) ? home : undefined, final: (stat) => stat.isSocket?.() && stat.uid === uid && (stat.mode & 0o777) === 0o600 });
    } else {
      await walkNoFollow(candidate.path, uid, dependencies, { exactUserFrom: candidate.path.startsWith(`${home}${sep}`) ? home : undefined, final: (stat) => stat.isSocket?.() && stat.uid === uid && (stat.mode & 0o777) === 0o600 });
      canonical = await fs.realpath(candidate.path);
      if (canonical !== candidate.path) throw failure("DOCKER_SOCKET_REQUIRED");
    }
    const classified = candidate.explicit ? { provider: "explicit", profile: "explicit" } : classifySocket(canonical, home, candidate.contextName);
    if (classified.provider === "colima") {
      const profileRoot = join(home, ".colima", classified.profile);
      await walkNoFollow(profileRoot, uid, dependencies, { exactUserFrom: home, final: (stat) => stat.isDirectory?.() && stat.uid === uid && (stat.mode & 0o022) === 0 });
      await readBoundedOwnerFile(join(profileRoot, "colima.yaml"), home, uid, dependencies);
    }
    return { path: canonical, ...classified };
  } catch { return null; }
}

function daemonHttp(socket, path, { timeout = 3_000, maxBytes = MAX_METADATA_BYTES } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = request({ socketPath: socket, path, method: "GET", timeout, agent: false }, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => { size += Buffer.byteLength(chunk); if (size <= maxBytes) chunks.push(Buffer.from(chunk)); else req.destroy(failure("DAEMON_UNAVAILABLE")); });
      response.on("end", () => response.statusCode === 200 ? resolveRequest(Buffer.concat(chunks).toString("utf8")) : rejectRequest(failure("DAEMON_UNAVAILABLE")));
    });
    req.once("timeout", () => req.destroy(failure("DAEMON_UNAVAILABLE")));
    req.once("error", () => rejectRequest(failure("DAEMON_UNAVAILABLE")));
    req.end();
  });
}

async function probeDaemon(socketPath, dependencies) {
  const query = dependencies.daemonRequest ?? ((path, socket, options) => daemonHttp(socket, path, options));
  const ping = await query("/_ping", socketPath, { timeout: 3_000, maxBytes: 64, agent: false });
  if (String(ping).trim() !== "OK") throw failure("DAEMON_UNAVAILABLE");
  let info;
  try { const raw = await query("/info", socketPath, { timeout: 3_000, maxBytes: MAX_METADATA_BYTES, agent: false }); info = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { throw failure("DAEMON_UNAVAILABLE"); }
  if (!info || typeof info.ID !== "string" || !info.ID || info.ID.length > 512) throw failure("DAEMON_UNAVAILABLE");
  const socketIdentity = sha256(socketPath);
  const stable = { socketIdentity, id: info.ID, name: String(info.Name ?? ""), driver: String(info.Driver ?? ""), osType: String(info.OSType ?? ""), architecture: String(info.Architecture ?? "") };
  if (Object.values(stable).some((value) => value.length > 512)) throw failure("DAEMON_UNAVAILABLE");
  return frozen({ identity: sha256(canonicalJson(stable)) });
}

async function metadataSocketCandidate(home, uid, dependencies) {
  const config = await readBoundedMetadata(join(home, ".docker", "config.json"), home, uid, dependencies);
  const current = config?.currentContext;
  if (current == null || current === "" || current === "default") return { path: "/var/run/docker.sock", contextName: "default" };
  if (typeof current !== "string" || current.length > 128) throw failure("DOCKER_METADATA_INVALID");
  const metaRoot = join(home, ".docker", "contexts", "meta");
  let entries;
  try { entries = await io(dependencies).readdir(metaRoot, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") throw failure("DOCKER_METADATA_INVALID"); throw failure("DOCKER_METADATA_INVALID"); }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory?.() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
    const meta = await readBoundedMetadata(join(metaRoot, entry.name, "meta.json"), home, uid, dependencies);
    if (meta?.Name === current) matches.push(meta);
  }
  if (matches.length !== 1) throw failure("DOCKER_METADATA_INVALID");
  const host = matches[0]?.Endpoints?.docker?.Host;
  return { path: parseUnixDockerHost(host), contextName: current };
}

async function fallbackSocketCandidates(home, uid, dependencies) {
  const result = [{ path: join(home, ".docker", "run", "docker.sock") }, { path: "/var/run/docker.sock" }];
  const colimaRoot = join(home, ".colima");
  let entries = [];
  try { entries = await io(dependencies).readdir(colimaRoot, { withFileTypes: true }); } catch (error) { if (error?.code !== "ENOENT") throw failure("DOCKER_METADATA_INVALID"); }
  for (const entry of entries) if (entry.isDirectory?.() && PROFILE.test(entry.name)) result.push({ path: join(colimaRoot, entry.name, "docker.sock") });
  return result;
}

async function selectSocket(environment, home, uid, dependencies) {
  const explicitValue = environment.SHENSI_DOCKER_HOST;
  const selected = explicitValue ? { path: parseUnixDockerHost(explicitValue), explicit: true } : await metadataSocketCandidate(home, uid, dependencies);
  const selectedValid = await validateSocketCandidate(selected, home, uid, dependencies);
  if (selectedValid) {
    try { return { socket: selectedValid, daemon: await probeDaemon(selectedValid.path, dependencies) }; } catch { if (explicitValue) throw failure("DAEMON_UNAVAILABLE"); }
  } else if (explicitValue) throw failure("DOCKER_SOCKET_REQUIRED");
  const fallback = dependencies.socketCandidates ?? await fallbackSocketCandidates(home, uid, dependencies);
  const healthy = [];
  const seen = new Set();
  for (const raw of fallback) {
    const candidate = typeof raw === "string" ? { path: raw } : raw;
    const valid = await validateSocketCandidate(candidate, home, uid, dependencies);
    if (!valid || seen.has(valid.path)) continue;
    seen.add(valid.path);
    try { healthy.push({ socket: valid, daemon: await probeDaemon(valid.path, dependencies) }); } catch { /* unavailable candidates are ignored */ }
  }
  if (healthy.length === 0) throw failure("DOCKER_SOCKET_REQUIRED");
  if (healthy.length > 1) throw failure("DOCKER_SOCKET_AMBIGUOUS");
  return healthy[0];
}

async function findExecutable(name, environment, uid, dependencies) {
  for (const directory of String(environment.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory) || resolve(directory) !== directory) continue;
    const executable = await resolveSafeExecutable(join(directory, name), uid, dependencies);
    if (executable) return executable;
  }
  return null;
}

async function selectCompose(environment, uid, dependencies) {
  const supplied = dependencies.candidates;
  const candidates = supplied ?? [
    { command: await findExecutable("docker", environment, uid, dependencies), kind: "docker" },
    { command: await findExecutable("docker-compose", environment, uid, dependencies), kind: "standalone" }
  ];
  for (const candidate of candidates) {
    if (!candidate?.command) continue;
    const command = await resolveSafeExecutable(candidate.command, uid, dependencies);
    if (!command) continue;
    const plugin = candidate.kind === "docker";
    const args = plugin ? ["compose", "version", "--short"] : ["version", "--short"];
    try {
      const runner = dependencies.composeVersion ?? (async (cmd, argv, options) => (await execFile(cmd, argv, { ...options, timeout: 5_000 })).stdout);
      const version = String(await runner(command, args, { env: environment, shell: false })).trim();
      if (!version || version.length > 256 || version.includes("\0")) continue;
      const executableStat = await io(dependencies).lstat(command);
      const executableIdentity = sha256(canonicalJson({ path: command, dev: executableStat.dev, ino: executableStat.ino, uid: executableStat.uid, mode: executableStat.mode & 0o777 }));
      return { argvPrefix: plugin ? [command, "compose"] : [command], executableIdentity, compose: { kind: plugin ? "docker-compose-plugin" : "standalone", version } };
    } catch { /* try next capability */ }
  }
  throw failure("COMPOSE_EXECUTABLE_REQUIRED");
}

export async function discoverComposeRuntime(options = {}) {
  const environment = options.environment ?? process.env;
  const info = (options.userInfo ?? nativeUserInfo)();
  const uid = (options.getuid ?? (() => process.getuid?.()))();
  (options.getgroups ?? (() => process.getgroups?.() ?? []))();
  if (!info || typeof info.homedir !== "string" || !isAbsolute(info.homedir) || info.uid !== uid) throw failure("USER_IDENTITY_INVALID");
  const home = resolve(info.homedir);
  const socketResult = await selectSocket(environment, home, uid, options);
  const minimal = { HOME: home };
  for (const name of SAFE_ENVIRONMENT_NAMES) if (typeof environment[name] === "string") minimal[name] = environment[name];
  minimal.DOCKER_HOST = unixDockerHost(socketResult.socket.path);
  const selected = await selectCompose(frozen({ ...minimal }), uid, options);
  const childEnvironment = { ...minimal };
  for (const name of API_ENVIRONMENT_NAMES) if (typeof environment[name] === "string") childEnvironment[name] = environment[name];
  const runtime = frozen({
    argvPrefix: selected.argvPrefix,
    executableIdentity: selected.executableIdentity,
    compose: selected.compose,
    socket: { canonicalPath: socketResult.socket.path, identity: sha256(socketResult.socket.path), provider: socketResult.socket.provider, profile: socketResult.socket.profile },
    daemon: socketResult.daemon,
    environment: childEnvironment
  });
  resolvedRuntimes.add(runtime);
  return runtime;
}

function redact(value, sensitiveValues = []) {
  let result = String(value ?? "");
  const lines = result.split(/\r?\n/u); const withoutBlocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const block = lines[index].match(/^([ ]*)([A-Za-z_]*(?:token|secret|password|credential|key)[A-Za-z_]*\s*:\s*)[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#.*)?$/iu);
    if (!block) { withoutBlocks.push(lines[index]); continue; }
    withoutBlocks.push(`${block[1]}${block[2]}[REDACTED]`);
    const headerIndent = block[1].length;
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (next.trim() === "") { index += 1; continue; }
      const indentation = next.match(/^ */u)[0].length;
      if (indentation <= headerIndent) break;
      index += 1;
    }
  }
  result = withoutBlocks.join("\n");
  for (const secret of sensitiveValues) if (typeof secret === "string" && secret) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/(bearer\s+)[^\s,]+/giu, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^@\s/]+@/giu, "$1[REDACTED]@")
    .replace(/("[A-Za-z_]*(?:token|secret|password|credential|key)[A-Za-z_]*"\s*:\s*")[^"]*(")/giu, "$1[REDACTED]$2")
    .replace(/([A-Za-z_]*(?:token|secret|password|credential|key)[A-Za-z_]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,}]+)/giu, "$1[REDACTED]");
}

function validateArgs(args) {
  if (!Array.isArray(args) || args.length < 1 || args.length > 256) throw failure("COMPOSE_ARGUMENT_INVALID");
  let bytes = 0;
  for (const value of args) {
    if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > 4_096) throw failure("COMPOSE_ARGUMENT_INVALID");
    bytes += Buffer.byteLength(value);
  }
  if (bytes > 32_768) throw failure("COMPOSE_ARGUMENT_INVALID");
}

export function assertRenderOnlyComposeArgs(args) {
  validateArgs(args);
  let index = 0; let fileSeen = false; let projectSeen = false;
  while (index < args.length && args[index].startsWith("-")) {
    const option = args[index++];
    if (option === "-f" || option === "--file") {
      if (fileSeen || args[index] !== "deploy/compose.api-only.yaml") throw failure("CONTAINER_RUNTIME_MUTATION_FORBIDDEN");
      fileSeen = true; index += 1;
    } else if (option === "-p" || option === "--project-name") {
      if (projectSeen || !validProject(args[index])) throw failure("CONTAINER_RUNTIME_MUTATION_FORBIDDEN");
      projectSeen = true; index += 1;
    } else throw failure("CONTAINER_RUNTIME_MUTATION_FORBIDDEN");
  }
  if (args[index++] !== "config") throw failure("CONTAINER_RUNTIME_MUTATION_FORBIDDEN");
  if (index === args.length) return true;
  if (args[index++] === "--quiet" && index === args.length) return true;
  throw failure("CONTAINER_RUNTIME_MUTATION_FORBIDDEN");
}
function isRenderOnly(args) { try { assertRenderOnlyComposeArgs(args); return true; } catch { return false; } }

function authorizationFor(runtime, authorization, now) {
  const state = authorizations.get(authorization);
  if (!state || state.runtime !== runtime) throw failure("API_NETWORK_AUTHORIZATION_REQUIRED");
  if (state.used) throw failure("API_NETWORK_AUTHORIZATION_USED");
  if (now() > state.expiresAt) throw failure("API_NETWORK_AUTHORIZATION_EXPIRED");
  return state;
}

export async function runResolvedCompose(runtime, args, options = {}) {
  if (!resolvedRuntimes.has(runtime) || !Object.isFrozen(runtime)) throw failure("COMPOSE_RUNTIME_UNTRUSTED");
  validateArgs(args);
  const acceptedExecution = acceptedComposeExecutions.get(options.acceptedComposeValidation);
  const acceptedRead = Boolean(acceptedExecution
    && acceptedExecution.runtime === runtime
    && acceptedExecution.used === false
    && canonicalJson(acceptedExecution.args) === canonicalJson(args)
    && options.cwd === acceptedExecution.cwd);
  if (Object.hasOwn(options, "acceptedComposeValidation") && !acceptedRead) throw failure("API_ONLY_ACCEPTED_EXECUTION_REQUIRED");
  if (acceptedRead) acceptedExecution.used = true;
  const acceptedLifecycleExecution = acceptedLifecycleExecutions.get(options.acceptedLifecycleExecution);
  const acceptedLifecycleUse = Boolean(acceptedLifecycleExecution
    && acceptedLifecycleExecution.runtime === runtime
    && acceptedLifecycleExecution.used === false
    && ["read", "mutation"].includes(acceptedLifecycleExecution.mode)
    && canonicalJson(acceptedLifecycleExecution.args) === canonicalJson(args)
    && options.cwd === acceptedLifecycleExecution.cwd);
  if (Object.hasOwn(options, "acceptedLifecycleExecution") && !acceptedLifecycleUse) throw failure("API_ONLY_ACCEPTED_LIFECYCLE_AUTHORITY_REQUIRED");
  if (acceptedLifecycleUse) acceptedLifecycleExecution.used = true;
  const acceptedLifecycleRead = acceptedLifecycleUse && acceptedLifecycleExecution.mode === "read";
  const acceptedLifecycleMutation = acceptedLifecycleUse && acceptedLifecycleExecution.mode === "mutation";
  const privateAcceptedRead = acceptedRead || acceptedLifecycleRead;
  const privateAcceptedExecution = acceptedRead ? acceptedExecution : acceptedLifecycleExecution;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const termGraceMs = options.termGraceMs ?? options.killGraceMs ?? 2_000;
  const closeGraceMs = options.closeGraceMs ?? 2_000;
  if (![timeoutMs, termGraceMs, closeGraceMs].every(Number.isSafeInteger) || timeoutMs < 100 || timeoutMs > 600_000 || termGraceMs < 10 || termGraceMs > 10_000 || closeGraceMs < 10 || closeGraceMs > 10_000) throw failure("COMPOSE_TIMEOUT_INVALID");
  const now = options.monotonicNow ?? (() => performance.now());
  const mutating = !privateAcceptedRead && !isRenderOnly(args);
  const authState = mutating ? authorizationFor(runtime, options.networkAuthorization, now) : null;
  const environmentState = mutating ? composeEnvironments.get(options.environment) : null;
  if (mutating && (!environmentState || environmentState.runtime !== runtime || environmentState.authorization !== options.networkAuthorization)) throw failure("API_NETWORK_ENVIRONMENT_REQUIRED");
  const executableOkay = await (options.revalidateExecutable ?? (async () => {
    const canonical = await resolveSafeExecutable(runtime.argvPrefix[0], process.getuid?.(), {});
    if (canonical !== runtime.argvPrefix[0]) return false;
    const stat = await nativeFs.lstat(canonical);
    return sha256(canonicalJson({ path: canonical, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 })) === runtime.executableIdentity;
  }))(runtime.argvPrefix[0], runtime);
  if (!executableOkay) throw failure("COMPOSE_EXECUTABLE_CHANGED");
  if (mutating || privateAcceptedRead) {
    const identity = await (options.probeDaemonIdentity ?? (async (selected) => (await probeDaemon(selected.socket.canonicalPath, {})).identity))(runtime);
    if (identity !== runtime.daemon.identity) throw failure("RUNTIME_ENGINE_IDENTITY_MISMATCH");
  }
  if (mutating) {
    const revalidated = await validateApiOnlyComposeInputs(runtime, environmentState.validatedInput, environmentState.inputState.runtimeRoot, environmentState.inputState.dependencies);
    if (canonicalJson(options.environment) !== canonicalJson(mutationEnvironment(runtime, authState.claim, revalidated))) throw failure("API_NETWORK_ENVIRONMENT_INVALID");
    authState.used = true;
  }
  if (privateAcceptedRead) {
    const revalidated = await validateApiOnlyComposeInputs(
      runtime,
      privateAcceptedExecution.validatedInput,
      privateAcceptedExecution.runtimeRoot,
      privateAcceptedExecution.dependencies
    );
    if (canonicalJson(privateAcceptedExecution.environment) !== canonicalJson(acceptedComposeProcessEnvironment(runtime, revalidated))) throw failure("API_ONLY_ACCEPTED_EXECUTION_REQUIRED");
    await privateAcceptedExecution.revalidate();
  }
  if (acceptedLifecycleMutation) await acceptedLifecycleExecution.revalidate();
  const command = runtime.argvPrefix[0];
  const commandArgs = [...runtime.argvPrefix.slice(1), ...args];
  const spawn = options.spawn ?? nativeSpawn;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const sensitiveValues = acceptedLifecycleUse ? acceptedLifecycleExecution.sensitiveValues : privateAcceptedRead ? privateAcceptedExecution.sensitiveValues : options.sensitiveValues ?? [];
  const childEnvironment = privateAcceptedRead ? privateAcceptedExecution.environment : mutating ? options.environment : runtime.environment;
  return await new Promise((resolveCommand, rejectCommand) => {
    let settled = false; let timedOut = false; let processError = null; let indeterminate = null; let timer; let termTimer; let closeTimer; let retained = Buffer.alloc(0); let total = 0;
    const append = (chunk) => { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); total += bytes.length; if (retained.length < MAX_OUTPUT_BYTES) retained = Buffer.concat([retained, bytes.subarray(0, MAX_OUTPUT_BYTES - retained.length)]); };
    const output = () => redact(retained.toString("utf8"), sensitiveValues);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimer(timer); clearTimer(termTimer); clearTimer(closeTimer); error ? rejectCommand(error) : resolveCommand(value); };
    let child;
    try { child = spawn(command, commandArgs, { cwd: options.cwd, env: childEnvironment, shell: false, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { finish(failure(`COMPOSE_COMMAND_SPAWN_FAILED:${redact(error?.message, sensitiveValues)}`)); return; }
    child.stdout?.on?.("data", append); child.stderr?.on?.("data", append);
    child.once("error", (error) => { processError = error; });
    child.once("close", (code, signal) => {
      if (indeterminate) finish(failure(`COMPOSE_COMMAND_INDETERMINATE:${indeterminate}:${output()}`));
      else if (timedOut) finish(failure(`COMPOSE_COMMAND_TIMEOUT:${output()}`));
      else if (processError) finish(failure(`COMPOSE_COMMAND_FAILED:${redact(processError.message, sensitiveValues)}:${output()}`));
      else if (code === 0) {
        if (acceptedLifecycleRead) acceptedLifecycleExecution.rawOutput = Buffer.from(retained);
        finish(null, frozen({ code, signal, output: output(), truncated: total > MAX_OUTPUT_BYTES }));
      }
      else finish(failure(`COMPOSE_COMMAND_FAILED:${code ?? signal ?? "unknown"}:${output()}`));
    });
    timer = setTimer(() => {
      timedOut = true;
      let delivered = false;
      try { delivered = child.kill?.("SIGTERM") === true; } catch { delivered = false; }
      if (!delivered) {
        indeterminate = "TERM_FAILED";
        closeTimer = setTimer(() => finish(failure("COMPOSE_COMMAND_INDETERMINATE:TERM_FAILED")), closeGraceMs);
        return;
      }
      termTimer = setTimer(() => {
        let killed = false;
        try { killed = child.kill?.("SIGKILL") === true; } catch { killed = false; }
        if (!killed) indeterminate = "KILL_FAILED";
        closeTimer = setTimer(() => finish(failure(indeterminate ? `COMPOSE_COMMAND_INDETERMINATE:${indeterminate}` : "COMPOSE_COMMAND_CLOSE_UNCONFIRMED")), closeGraceMs);
      }, termGraceMs);
    }, timeoutMs);
  });
}

function ipv4Number(value) {
  const text = String(value); const parts = text.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/u.test(part) || Number(part) > 255)) return null;
  return parts.reduce((total, part) => total * 256 + Number(part), 0);
}
function ipv4Text(value) { return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join("."); }
function cidr(value, minimumPrefix = 0, maximumPrefix = 32) {
  if (typeof value !== "string" || value.split("/").length !== 2) return null;
  const [address, prefixText] = value.split("/"); const start = ipv4Number(address); const prefix = Number(prefixText);
  if (start === null || !/^(?:0|[1-9]|[12]\d|3[0-2])$/u.test(prefixText) || !Number.isInteger(prefix) || prefix < minimumPrefix || prefix > maximumPrefix) return null;
  const size = 2 ** (32 - prefix); const network = Math.floor(start / size) * size;
  return { text: `${ipv4Text(network)}/${prefix}`, network, end: network + size - 1, prefix };
}
function overlaps(left, right) { return left.network <= right.end && right.network <= left.end; }
function apiOnlyHostRouteConflict(range, routes) {
  const benchmarkRange = cidr("198.18.0.0/15");
  const insideBenchmarkRange = range.network >= benchmarkRange.network && range.end <= benchmarkRange.end;
  const observedRoutes = new Set(routes.map((route) => route.cidr));
  const hasCompleteSplitDefault = insideBenchmarkRange && MACOS_SPLIT_DEFAULT_ROUTE_CIDRS.every((route) => observedRoutes.has(route));
  return routes.some((route) => (!hasCompleteSplitDefault || !MACOS_SPLIT_DEFAULT_ROUTE_SET.has(route.cidr)) && overlaps(range, cidr(route.cidr)));
}
function validProject(value) { return typeof value === "string" && value.length <= 128 && PROJECT.test(value); }
function expectedLabels(projectName, runtimeNonce, daemonIdentity) { return { "com.docker.compose.project": projectName, "com.docker.compose.network": "shensi_internal", "io.shensi.api.runtime-nonce": runtimeNonce, "io.shensi.api.daemon-identity": daemonIdentity }; }
function labelsEqual(left, right) { return left && typeof left === "object" && !Array.isArray(left) && Object.entries(right).every(([key, value]) => left[key] === value); }

function validateInventories(networks, routes) {
  if (!Array.isArray(networks) || !Array.isArray(routes)) throw failure("API_NETWORK_INVENTORY_INVALID");
  for (const network of networks) {
    if (!exactKeys(network, ["id", "name", "subnets", "labels"]) || typeof network.id !== "string" || !network.id || network.id.length > 512 || typeof network.name !== "string" || !network.name || network.name.length > 512 || !Array.isArray(network.subnets) || !network.labels || typeof network.labels !== "object" || Array.isArray(network.labels) || Object.values(network.labels).some((value) => typeof value !== "string")) throw failure("API_NETWORK_INVENTORY_INVALID");
    for (const item of network.subnets) {
      const keys = item.gateway === undefined ? ["subnet"] : ["subnet", "gateway"];
      if (!exactKeys(item, keys) || !cidr(item.subnet) || cidr(item.subnet).text !== item.subnet || item.gateway !== undefined && ipv4Number(item.gateway) === null) throw failure("API_NETWORK_INVENTORY_INVALID");
    }
  }
  for (const route of routes) if (!exactKeys(route, ["cidr"]) || !cidr(route.cidr) || cidr(route.cidr).text !== route.cidr) throw failure("API_NETWORK_INVENTORY_INVALID");
}

function validClaim(claim) {
  if (!exactKeys(claim, ["schema", "version", "issuedAt", "socketIdentity", "daemonIdentity", "projectName", "networkName", "runtimeNonce", "subnet", "ipamGatewayIp", "gatewayServiceIp", "expectedLabels", "existingNetwork"])) return false;
  const range = cidr(claim.subnet, 1, 30); const ipamGateway = ipv4Number(claim.ipamGatewayIp); const gatewayService = ipv4Number(claim.gatewayServiceIp);
  if (claim.schema !== "shensi.api-network-claim" || claim.version !== 2 || !validUtc(claim.issuedAt) || !HASH.test(claim.socketIdentity) || !HASH.test(claim.daemonIdentity) || !validProject(claim.projectName) || claim.networkName !== "shensi_internal" || !NONCE.test(claim.runtimeNonce) || !range || range.text !== claim.subnet || ipamGateway === null || ipv4Text(ipamGateway) !== claim.ipamGatewayIp || gatewayService === null || ipv4Text(gatewayService) !== claim.gatewayServiceIp || ipamGateway <= range.network || ipamGateway >= range.end || gatewayService <= range.network || gatewayService >= range.end || ipamGateway === gatewayService || overlaps(range, cidr("172.30.0.0/24")) || !exactKeys(claim.expectedLabels, Object.keys(expectedLabels(claim.projectName, claim.runtimeNonce, claim.daemonIdentity))) || !labelsEqual(claim.expectedLabels, expectedLabels(claim.projectName, claim.runtimeNonce, claim.daemonIdentity))) return false;
  return claim.existingNetwork === null || exactKeys(claim.existingNetwork, ["id", "name"]) && typeof claim.existingNetwork.id === "string" && claim.existingNetwork.id.length > 0 && claim.existingNetwork.id.length <= 512 && claim.existingNetwork.name === `${claim.projectName}_shensi_internal`;
}

function boundedInspectionText(value, maximum = 512) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

function singleResponseHeader(response, name) {
  const distinct = response?.headersDistinct?.[name];
  if (distinct !== undefined) {
    if (!Array.isArray(distinct) || distinct.length !== 1 || typeof distinct[0] !== "string") throw failure("API_NETWORK_ENGINE_RESPONSE_INVALID");
    return distinct[0];
  }
  const value = response?.headers?.[name];
  if (Array.isArray(value) || value !== undefined && typeof value !== "string") throw failure("API_NETWORK_ENGINE_RESPONSE_INVALID");
  return value;
}

function readBoundedEngineJson(requestFunction, socketPath, path, setTimer, clearTimer) {
  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false;
    let outgoing;
    let response;
    let deadline;
    let deadlineSet = false;
    let requestDestroyed = false;
    let responseDestroyed = false;
    let responseData;
    let responseEnd;
    const requestTimeout = () => rejectInvalid();
    const requestError = () => rejectInvalid();
    const responseError = () => rejectInvalid();
    const detach = () => {
      outgoing?.removeListener?.("timeout", requestTimeout);
      outgoing?.removeListener?.("error", requestError);
      response?.removeListener?.("aborted", responseError);
      response?.removeListener?.("error", responseError);
      if (responseData) response?.removeListener?.("data", responseData);
      if (responseEnd) response?.removeListener?.("end", responseEnd);
    };
    const destroyActive = () => {
      if (response && !responseDestroyed) {
        responseDestroyed = true;
        try { response.destroy?.(); } catch { /* the response is already rejected */ }
      }
      if (outgoing && !requestDestroyed) {
        requestDestroyed = true;
        try { outgoing.destroy?.(); } catch { /* the request is already rejected */ }
      }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (deadlineSet) clearTimer(deadline);
      if (error) destroyActive();
      detach();
      if (error) rejectResponse(error); else resolveResponse(value);
    };
    function rejectInvalid() { finish(failure("API_NETWORK_ENGINE_RESPONSE_INVALID")); }
    try {
      deadline = setTimer(rejectInvalid, INSPECTION_TIMEOUT_MS);
      deadlineSet = true;
      outgoing = requestFunction({
        socketPath,
        path,
        method: "GET",
        agent: false,
        timeout: INSPECTION_TIMEOUT_MS,
        maxResponseBytes: MAX_ENGINE_INSPECTION_BYTES,
        headers: { Accept: "application/json" }
      }, (incoming) => {
        response = incoming;
        try {
          if (response?.statusCode !== 200) { rejectInvalid(); return; }
          const contentType = singleResponseHeader(response, "content-type");
          if (typeof contentType !== "string" || contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") { rejectInvalid(); return; }
          const contentLength = singleResponseHeader(response, "content-length");
          if (contentLength !== undefined && (!/^(?:0|[1-9]\d*)$/u.test(contentLength) || Number(contentLength) > MAX_ENGINE_INSPECTION_BYTES)) { rejectInvalid(); return; }
          const chunks = [];
          let size = 0;
          response.once("aborted", responseError);
          response.once("error", responseError);
          responseData = (chunk) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            size += bytes.length;
            if (size > MAX_ENGINE_INSPECTION_BYTES) {
              rejectInvalid();
              return;
            }
            chunks.push(bytes);
          };
          responseEnd = () => {
            if (settled) return;
            if (response.complete !== true || contentLength !== undefined && size !== Number(contentLength) || size === 0) { rejectInvalid(); return; }
            let parsed;
            try { parsed = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); } catch { rejectInvalid(); return; }
            finish(null, parsed);
          };
          response.on("data", responseData);
          response.once("end", responseEnd);
        } catch { rejectInvalid(); }
      });
      if (settled) { destroyActive(); return; }
      if (!outgoing || typeof outgoing.once !== "function" || typeof outgoing.end !== "function") { rejectInvalid(); return; }
      outgoing.once("timeout", requestTimeout);
      outgoing.once("error", requestError);
      outgoing.end();
    } catch { rejectInvalid(); }
  });
}

function inspectedDaemonIdentity(info, socketPath) {
  if (!info || typeof info !== "object" || Array.isArray(info)) throw failure("API_NETWORK_ENGINE_RESPONSE_INVALID");
  const fields = ["ID", "Name", "Driver", "OSType", "Architecture"];
  if (fields.some((name) => !Object.hasOwn(info, name) || typeof info[name] !== "string" || Buffer.byteLength(info[name]) > 512) || !info.ID) throw failure("API_NETWORK_ENGINE_RESPONSE_INVALID");
  const stable = {
    socketIdentity: sha256(socketPath),
    id: info.ID,
    name: info.Name,
    driver: info.Driver,
    osType: info.OSType,
    architecture: info.Architecture
  };
  return sha256(canonicalJson(stable));
}

function normalizeInspectionLabels(value) {
  if (value === null) return frozen({});
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("API_NETWORK_INVENTORY_INVALID");
  const entries = Object.entries(value);
  if (entries.length > 256 || entries.some(([key, label]) => !boundedInspectionText(key, 256) || typeof label !== "string" || Buffer.byteLength(label) > 4_096 || label.includes("\0"))) throw failure("API_NETWORK_INVENTORY_INVALID");
  return frozen(Object.fromEntries(entries));
}

function normalizedIpv6Address(value) {
  if (typeof value !== "string" || isIP(value) !== 6 || value.includes("%")) return null;
  let text;
  try { text = new SocketAddress({ address: value, family: "ipv6" }).address; } catch { return null; }
  let expandedInput = text;
  if (expandedInput.includes(".")) {
    const lastColon = expandedInput.lastIndexOf(":");
    const embedded = ipv4Number(expandedInput.slice(lastColon + 1));
    if (embedded === null) return null;
    expandedInput = `${expandedInput.slice(0, lastColon)}:${((embedded >>> 16) & 0xffff).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  const halves = expandedInput.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0 || halves.length === 2 && missing < 1) return null;
  const parts = [...left, ...Array(missing).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  const number = parts.reduce((result, part) => result << 16n | BigInt(`0x${part}`), 0n);
  return { number, text };
}

function ipv6Text(number) {
  const parts = Array.from({ length: 8 }, (_, index) => Number(number >> BigInt((7 - index) * 16) & 0xffffn).toString(16));
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < parts.length;) {
    if (parts[index] !== "0") { index += 1; continue; }
    let end = index + 1;
    while (end < parts.length && parts[end] === "0") end += 1;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  const raw = bestStart === -1
    ? parts.join(":")
    : `${parts.slice(0, bestStart).join(":")}::${parts.slice(bestStart + bestLength).join(":")}`;
  try { return new SocketAddress({ address: raw, family: "ipv6" }).address; } catch { return null; }
}

function ipv6Range(value) {
  if (typeof value !== "string" || value.split("/").length !== 2) return null;
  const [addressText, prefixText] = value.split("/");
  if (!/^(?:0|[1-9]\d?|1[01]\d|12[0-8])$/u.test(prefixText)) return null;
  const address = normalizedIpv6Address(addressText);
  if (!address || address.text !== addressText) return null;
  const prefix = Number(prefixText);
  const maximum = (1n << 128n) - 1n;
  const mask = prefix === 0 ? 0n : maximum << BigInt(128 - prefix) & maximum;
  const network = address.number & mask;
  const networkText = ipv6Text(network);
  if (networkText !== addressText) return null;
  return { text: `${networkText}/${prefix}`, network, end: network | (maximum ^ mask) };
}

function normalizeInspectionSubnets(config) {
  if (config === null) return frozen([]);
  if (!Array.isArray(config) || config.length > 256) throw failure("API_NETWORK_INVENTORY_INVALID");
  const normalized = [];
  const seen = new Set();
  for (const item of config) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !Object.hasOwn(item, "Subnet") || typeof item.Subnet !== "string") throw failure("API_NETWORK_INVENTORY_INVALID");
    const range = cidr(item.Subnet);
    if (!range) {
      const ipv6 = ipv6Range(item.Subnet);
      if (!ipv6 || seen.has(ipv6.text)) throw failure("API_NETWORK_INVENTORY_INVALID");
      seen.add(ipv6.text);
      if (Object.hasOwn(item, "Gateway") && item.Gateway !== "") {
        const gateway = normalizedIpv6Address(item.Gateway);
        if (!gateway || gateway.text !== item.Gateway || gateway.number <= ipv6.network || gateway.number > ipv6.end) throw failure("API_NETWORK_INVENTORY_INVALID");
      }
      continue;
    }
    if (range.text !== item.Subnet || seen.has(range.text)) throw failure("API_NETWORK_INVENTORY_INVALID");
    seen.add(range.text);
    const normalizedItem = { subnet: range.text };
    if (Object.hasOwn(item, "Gateway") && item.Gateway !== "") {
      const gateway = ipv4Number(item.Gateway);
      if (gateway === null || ipv4Text(gateway) !== item.Gateway || gateway <= range.network || gateway >= range.end) throw failure("API_NETWORK_INVENTORY_INVALID");
      normalizedItem.gateway = item.Gateway;
    }
    normalized.push(frozen(normalizedItem));
  }
  return frozen(normalized);
}

function normalizeInspectionNetwork(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !boundedInspectionText(value.Id) || !boundedInspectionText(value.Name) || !Object.hasOwn(value, "IPAM") || !value.IPAM || typeof value.IPAM !== "object" || Array.isArray(value.IPAM) || !Object.hasOwn(value.IPAM, "Config") || !Object.hasOwn(value, "Labels")) throw failure("API_NETWORK_INVENTORY_INVALID");
  return frozen({
    id: value.Id,
    name: value.Name,
    subnets: normalizeInspectionSubnets(value.IPAM.Config),
    labels: normalizeInspectionLabels(value.Labels)
  });
}

function normalizeInspectionNetworks(value) {
  if (!Array.isArray(value) || value.length > 4_096) throw failure("API_NETWORK_INVENTORY_INVALID");
  const ids = new Set();
  const names = new Set();
  const networks = value.map((item) => {
    const network = normalizeInspectionNetwork(item);
    if (ids.has(network.id) || names.has(network.name)) throw failure("API_NETWORK_INVENTORY_INVALID");
    ids.add(network.id);
    names.add(network.name);
    return network;
  });
  return frozen(networks);
}

function ipv4MaskPrefix(value) {
  let number;
  if (/^0x[0-9a-f]{1,8}$/iu.test(value)) number = Number.parseInt(value.slice(2), 16);
  else {
    number = ipv4Number(value);
    if (number === null || ipv4Text(number) !== value) return null;
  }
  const bits = number.toString(2).padStart(32, "0");
  if (!/^1*0*$/u.test(bits)) return null;
  const firstZero = bits.indexOf("0");
  return firstZero === -1 ? 32 : firstZero;
}

function expandedRouteAddress(value) {
  const parts = value.split(".");
  if (parts.length < 1 || parts.length > 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/u.test(part) || Number(part) > 255)) return null;
  return { address: [...parts, ...Array(4 - parts.length).fill("0")].join("."), implicitPrefix: parts.length * 8, complete: parts.length === 4 };
}

function normalizedRouteDestination(destination, mask, flags) {
  if (destination === "default") {
    if (mask !== undefined && ipv4MaskPrefix(mask) !== 0) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
    return null;
  }
  if (mask !== undefined && destination.includes("/")) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
  let addressText = destination;
  let suffix;
  if (destination.includes("/")) {
    const parts = destination.split("/");
    if (parts.length !== 2) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
    [addressText, suffix] = parts;
  }
  const expanded = expandedRouteAddress(addressText);
  if (!expanded) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
  let prefix;
  if (mask !== undefined) prefix = ipv4MaskPrefix(mask);
  else if (suffix !== undefined) prefix = /^\d{1,3}$/u.test(suffix) ? Number(suffix) : ipv4MaskPrefix(suffix);
  else if (!expanded.complete) prefix = expanded.implicitPrefix;
  else if (flags.includes("H")) prefix = 32;
  else throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
  const range = cidr(`${expanded.address}/${prefix}`);
  if (!range) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
  return range.prefix === 0 ? null : range.text;
}

function parseHostIpv4Routes(output) {
  if (typeof output !== "string" || Buffer.byteLength(output) > MAX_ROUTE_INSPECTION_BYTES || !output.endsWith("\n") || output.includes("\0") || output.includes("\uFFFD")) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
  const lines = output.replace(/\r\n/gu, "\n").split("\n");
  lines.pop();
  if (lines.some((line) => Buffer.byteLength(line) > 4_096)) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
  const sections = lines.map((line) => line.trim()).reduce((indexes, line, index) => line === "Internet:" ? [...indexes, index] : indexes, []);
  if (sections.length !== 1) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
  const section = sections[0];
  if (lines.slice(0, section).some((line) => line.trim() && line.trim() !== "Routing tables")) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
  const headerIndex = lines.findIndex((line, index) => index > section && line.trim());
  if (headerIndex === -1) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
  const header = lines[headerIndex].trim().split(/\s+/u);
  const destinationIndex = header.indexOf("Destination");
  const gatewayIndex = header.indexOf("Gateway");
  const flagsIndex = header.indexOf("Flags");
  const networkInterfaceIndex = header.indexOf("Netif");
  const maskIndexes = [header.indexOf("Netmask"), header.indexOf("Genmask")].filter((index) => index !== -1);
  if (destinationIndex !== 0 || gatewayIndex === -1 || flagsIndex === -1 || networkInterfaceIndex === -1 || maskIndexes.length > 1 || new Set(header).size !== header.length) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
  const maskIndex = maskIndexes[0];
  const routes = [];
  const seen = new Set();
  for (const rawLine of lines.slice(headerIndex + 1)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.endsWith(":")) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
    const columns = line.split(/\s+/u);
    if (columns.length <= Math.max(destinationIndex, gatewayIndex, flagsIndex, networkInterfaceIndex, maskIndex ?? -1) || columns.length > header.length) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
    const gateway = columns[gatewayIndex];
    const flags = columns[flagsIndex];
    const networkInterface = columns[networkInterfaceIndex];
    if (!boundedInspectionText(gateway, 256) || !/^[A-Za-z0-9<>]+$/u.test(flags) || !/^[A-Za-z0-9_.:-]+$/u.test(networkInterface)) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
    const normalized = normalizedRouteDestination(columns[destinationIndex], maskIndex === undefined ? undefined : columns[maskIndex], flags);
    if (normalized === null) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    routes.push(frozen({ cidr: normalized }));
  }
  return frozen(routes);
}

function assertInspectionClaim(runtime, claim) {
  if (!resolvedRuntimes.has(runtime)) throw failure("COMPOSE_RUNTIME_UNTRUSTED");
  if (!validClaim(claim)) throw failure("API_NETWORK_CLAIM_INVALID");
  if (claim.socketIdentity !== runtime.socket.identity || claim.daemonIdentity !== runtime.daemon.identity) throw failure("API_NETWORK_CLAIM_RUNTIME_MISMATCH");
}

const ACCEPTED_RESOURCE_ARTIFACTS = [
  ["containerRuntimeSelection", "container-runtime-selection.json"],
  ["acceptedComposeBase", "accepted-compose-base.json"],
  ["backendEnvironment", "backend.env"],
  ["backendImageOverride", "backend-image-override.json"],
  ["gatewayConfig", "gateway.conf"],
  ["acceptedResources", "accepted-resources.json"],
  ["task5RecoverySeedCandidateReceipt", "task5-recovery-seed-candidate-receipt.json"]
];
const ACCEPTED_RESOURCE_AGGREGATE_BYTES = 4 * 1024 * 1024;
const ACCEPTED_RESOURCE_JSON_BYTES = 64 * 1024;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ACCEPTED_COMPOSE_ARTIFACTS = [
  ["acceptedComposeBase", "accepted-compose-base.json", 256 * 1024],
  ["backendImageOverride", "backend-image-override.json", 256 * 1024],
  ["backendEnvironment", "backend.env", 1024 * 1024],
  ["gatewayConfig", "gateway.conf", 1024 * 1024]
];
const ACCEPTED_COMPOSE_AGGREGATE_BYTES = 2 * 1024 * 1024;

function validAcceptedImagePair(value) {
  if (!exactKeys(value, ["imageIdDigest", "composeImageReference"]) || !IMAGE_DIGEST.test(value.imageIdDigest)) return false;
  const reference = value.composeImageReference;
  if (!exactKeys(reference, ["kind", "value"])) return false;
  if (reference.kind === "engine-image-id") return reference.value === value.imageIdDigest;
  if (reference.kind !== "repository-digest" || typeof reference.value !== "string") return false;
  if (Buffer.byteLength(reference.value, "utf8") < 1 || Buffer.byteLength(reference.value, "utf8") > 512 || !/^[\x21-\x7e]+$/u.test(reference.value) || reference.value.includes("://") || reference.value.includes("\\")) return false;
  const marker = reference.value.lastIndexOf("@sha256:");
  if (marker <= 0 || marker !== reference.value.indexOf("@") || !IMAGE_DIGEST.test(reference.value.slice(marker + 1))) return false;
  const component = "[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*";
  const domainPart = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
  const domain = `${domainPart}(?:\\.${domainPart})*(?::(?:0|[1-9][0-9]{0,4}))?`;
  return new RegExp(`^(?:${domain}/)?${component}(?:/${component})*$`, "u").test(reference.value.slice(0, marker));
}

function decodeAcceptedResourceLeaf(bytes, projection) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > ACCEPTED_RESOURCE_JSON_BYTES || bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.startsWith("\uFEFF") || text.includes("\0") || text.includes("\uFFFD")) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
    const value = JSON.parse(text);
    if (`${JSON.stringify(value)}\n` !== text
      || !exactKeys(value, ["schema", "version", "project", "ports", "runtimeNonce", "engine", "networks", "mysql", "backend", "gateway"])
      || value.schema !== "shensi.api-only.accepted-resources"
      || value.version !== 1
      || !exactKeys(value.ports, ["gateway", "mysql"])
      || !exactKeys(value.engine, ["socketIdentity", "daemonIdentity"])
      || !exactKeys(value.networks, ["internal", "egress", "host"])
      || !exactKeys(value.networks.internal, ["id", "name", "identitySha256", "subnet", "ipamGatewayIp", "gatewayServiceIp"])
      || !exactKeys(value.networks.egress, ["id", "name", "identitySha256"])
      || !exactKeys(value.networks.host, ["id", "name", "identitySha256"])
      || !exactKeys(value.mysql, ["containerId", "volumeName", "volumeIdentitySha256", "imageIdDigest"])
      || !validAcceptedImagePair(value.backend)
      || !validAcceptedImagePair(value.gateway)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
    const expected = projection.expectedResources;
    for (const key of ["project", "ports", "runtimeNonce", "engine", "networks", "mysql", "backend"]) {
      if (JSON.stringify(value[key]) !== JSON.stringify(expected[key])) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
    }
    return frozen(value);
  } catch (caught) {
    if (caught?.message === "API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID") throw caught;
    throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
  }
}

function validAcceptedArtifactStat(stat, uid, maximumBytes) {
  return stat?.isFile?.()
    && !stat.isSymbolicLink?.()
    && stat.uid === uid
    && (stat.mode & 0o777) === 0o600
    && stat.nlink === 1
    && Number.isSafeInteger(stat.size)
    && stat.size >= 1
    && stat.size <= maximumBytes;
}

async function closeAcceptedArtifactHandles(files) {
  let failed = false;
  for (const file of [...files].reverse()) {
    try { await file.handle.close(); } catch { failed = true; }
  }
  if (failed) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
}

async function readAcceptedArtifactBytes(handle, size) {
  if (!Number.isSafeInteger(size) || size < 1 || typeof handle?.read !== "function") throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (!result || !Number.isSafeInteger(result.bytesRead) || result.bytesRead < 1 || result.bytesRead > size - offset) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
    offset += result.bytesRead;
  }
  return bytes;
}

async function openAcceptedResourceArtifacts(filesystem, uid, projection) {
  const held = [];
  try {
    if (!Number.isSafeInteger(uid) || uid < 0 || !exactKeys(projection.artifacts, ACCEPTED_RESOURCE_ARTIFACTS.map(([name]) => name))) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
    let versionRoot = null;
    let aggregateBytes = 0;
    let acceptedResources = null;
    const descriptorProof = [];
    for (const [name, expectedBasename] of ACCEPTED_RESOURCE_ARTIFACTS) {
      const expected = projection.artifacts[name];
      if (!exactKeys(expected, ["path", "sha256"])
        || typeof expected.path !== "string"
        || !isAbsolute(expected.path)
        || resolve(expected.path) !== expected.path
        || expected.path.includes("\0")
        || basename(expected.path) !== expectedBasename
        || !HASH.test(expected.sha256)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
      const parent = dirname(expected.path);
      if (versionRoot === null) versionRoot = parent;
      if (parent !== versionRoot || join(versionRoot, expectedBasename) !== expected.path) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
    }
    const versionsRoot = dirname(versionRoot);
    const runtimeRoot = dirname(versionsRoot);
    if (basename(versionRoot) !== projection.pointer.versionId || basename(versionsRoot) !== "versions" || dirname(join(runtimeRoot, "versions")) !== runtimeRoot) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");

    for (const [name] of ACCEPTED_RESOURCE_ARTIFACTS) {
      const expected = projection.artifacts[name];
      const maximumBytes = name === "acceptedResources" ? ACCEPTED_RESOURCE_JSON_BYTES : ACCEPTED_RESOURCE_AGGREGATE_BYTES;
      const before = await filesystem.lstat(expected.path);
      if (!validAcceptedArtifactStat(before, uid, maximumBytes) || await filesystem.realpath(expected.path) !== expected.path) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
      const handle = await filesystem.open(expected.path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0), 0);
      const file = { handle };
      held.push(file);
      const opened = await descriptorStat(handle);
      if (!validAcceptedArtifactStat(opened, uid, maximumBytes) || !statIdentity(before, opened)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
      const bytes = await readAcceptedArtifactBytes(handle, before.size);
      const after = await descriptorStat(handle);
      const pathAfter = await filesystem.lstat(expected.path);
      aggregateBytes += bytes.length;
      if (!Buffer.isBuffer(bytes)
        || aggregateBytes > ACCEPTED_RESOURCE_AGGREGATE_BYTES
        || bytes.length !== before.size
        || !validAcceptedArtifactStat(after, uid, maximumBytes)
        || !validAcceptedArtifactStat(pathAfter, uid, maximumBytes)
        || !statIdentity(before, after)
        || !statIdentity(before, pathAfter)
        || sha256(bytes) !== expected.sha256) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
      file.path = expected.path;
      file.identity = { dev: before.dev, ino: before.ino, size: before.size, sha256: expected.sha256 };
      descriptorProof.push({ basename: basename(expected.path), dev: String(before.dev), ino: String(before.ino), size: before.size, sha256: expected.sha256 });
      if (name === "acceptedResources") acceptedResources = decodeAcceptedResourceLeaf(bytes, projection);
    }
    if (acceptedResources === null) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
    return { held, acceptedResources, descriptorProof: frozen(descriptorProof), runtimeRoot };
  } catch {
    try { await closeAcceptedArtifactHandles(held); } catch {}
    throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
  }
}

async function revalidateAcceptedResourceArtifacts(filesystem, uid, artifacts) {
  try {
    for (const file of artifacts.held) {
      const descriptor = await descriptorStat(file.handle);
      const pathname = await filesystem.lstat(file.path);
      if (!validAcceptedArtifactStat(descriptor, uid, file.identity.size)
        || !validAcceptedArtifactStat(pathname, uid, file.identity.size)
        || descriptor.size !== file.identity.size
        || pathname.size !== file.identity.size
        || descriptor.dev !== file.identity.dev
        || descriptor.ino !== file.identity.ino
        || pathname.dev !== file.identity.dev
        || pathname.ino !== file.identity.ino
        || await filesystem.realpath(file.path) !== file.path
        || sha256(await readAcceptedArtifactBytes(file.handle, file.identity.size)) !== file.identity.sha256) throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
    }
  } catch (caught) {
    if (caught?.message === "API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID") throw caught;
    throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID");
  }
}

function validAcceptedComposeArtifactStat(stat, uid, maximumBytes) {
  return stat?.isFile?.()
    && !stat.isSymbolicLink?.()
    && stat.uid === uid
    && (stat.mode & 0o777) === 0o600
    && stat.nlink === 1
    && Number.isSafeInteger(stat.size)
    && stat.size >= 1
    && stat.size <= maximumBytes;
}

async function closeAcceptedComposeArtifacts(files) {
  let failed = false;
  for (const file of [...files].reverse()) {
    try { await file.handle.close(); } catch { failed = true; }
  }
  if (failed) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
}

async function openAcceptedComposeArtifacts(filesystem, uid, projection, inspected) {
  const held = [];
  try {
    if (!Number.isSafeInteger(uid) || uid < 0) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
    const observed = new Map(inspected.artifacts.map((artifact) => [artifact.path, artifact.identity]));
    let versionRoot = null;
    let aggregateBytes = 0;
    for (const [name, expectedBasename, maximumBytes] of ACCEPTED_COMPOSE_ARTIFACTS) {
      const expected = projection.artifacts[name];
      if (!exactKeys(expected, ["path", "sha256"])
        || typeof expected.path !== "string"
        || !isAbsolute(expected.path)
        || resolve(expected.path) !== expected.path
        || expected.path.includes("\0")
        || basename(expected.path) !== expectedBasename
        || !HASH.test(expected.sha256)) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
      const parent = dirname(expected.path);
      if (versionRoot === null) versionRoot = parent;
      if (parent !== versionRoot || join(versionRoot, expectedBasename) !== expected.path) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
      const prior = observed.get(expected.path);
      if (!prior || prior.sha256 !== expected.sha256) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
      const before = await filesystem.lstat(expected.path);
      if (!validAcceptedComposeArtifactStat(before, uid, maximumBytes)
        || await filesystem.realpath(expected.path) !== expected.path
        || before.dev !== prior.dev
        || before.ino !== prior.ino
        || before.size !== prior.size) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
      const handle = await filesystem.open(expected.path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0), 0);
      const file = { name, path: expected.path, handle };
      held.push(file);
      const opened = await descriptorStat(handle);
      if (!validAcceptedComposeArtifactStat(opened, uid, maximumBytes) || !statIdentity(before, opened)) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
      const bytes = await readAcceptedArtifactBytes(handle, before.size);
      const after = await descriptorStat(handle);
      const pathname = await filesystem.lstat(expected.path);
      aggregateBytes += bytes.length;
      if (aggregateBytes > ACCEPTED_COMPOSE_AGGREGATE_BYTES
        || bytes.length !== before.size
        || !validAcceptedComposeArtifactStat(after, uid, maximumBytes)
        || !validAcceptedComposeArtifactStat(pathname, uid, maximumBytes)
        || !statIdentity(before, after)
        || !statIdentity(before, pathname)
        || await filesystem.realpath(expected.path) !== expected.path
        || sha256(bytes) !== expected.sha256) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
      file.bytes = bytes;
      file.identity = { dev: before.dev, ino: before.ino, size: before.size, sha256: expected.sha256 };
    }
    const versionsRoot = dirname(versionRoot);
    const runtimeRoot = dirname(versionsRoot);
    if (basename(versionRoot) !== projection.pointer.versionId
      || basename(versionsRoot) !== "versions"
      || join(runtimeRoot, "versions", projection.pointer.versionId) !== versionRoot) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
    return { held, versionRoot, runtimeRoot };
  } catch {
    try { await closeAcceptedComposeArtifacts(held); } catch {}
    throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
  }
}

async function revalidateAcceptedComposeArtifacts(filesystem, uid, artifacts) {
  try {
    for (const file of artifacts.held) {
      const descriptor = await descriptorStat(file.handle);
      const pathname = await filesystem.lstat(file.path);
      if (!validAcceptedComposeArtifactStat(descriptor, uid, file.identity.size)
        || !validAcceptedComposeArtifactStat(pathname, uid, file.identity.size)
        || descriptor.size !== file.identity.size
        || pathname.size !== file.identity.size
        || descriptor.dev !== file.identity.dev
        || descriptor.ino !== file.identity.ino
        || pathname.dev !== file.identity.dev
        || pathname.ino !== file.identity.ino
        || await filesystem.realpath(file.path) !== file.path
        || sha256(await readAcceptedArtifactBytes(file.handle, file.identity.size)) !== file.identity.sha256) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
    }
  } catch {
    throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
  }
}

function decodeCanonicalAcceptedComposeJson(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw failure("API_ONLY_ACCEPTED_COMPOSE_INPUT_INVALID");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.startsWith("\uFEFF") || text.includes("\0") || text.includes("\uFFFD")) throw failure("API_ONLY_ACCEPTED_COMPOSE_INPUT_INVALID");
    const value = JSON.parse(text);
    if (`${JSON.stringify(value)}\n` !== text) throw failure("API_ONLY_ACCEPTED_COMPOSE_INPUT_INVALID");
    return value;
  } catch (caught) {
    if (caught?.message === "API_ONLY_ACCEPTED_COMPOSE_INPUT_INVALID") throw caught;
    throw failure("API_ONLY_ACCEPTED_COMPOSE_INPUT_INVALID");
  }
}

function acceptedComposeOwnershipLabels() {
  return {
    "io.shensi.api.runtime-nonce": "${SHENSI_API_RUNTIME_NONCE:?required}",
    "io.shensi.api.daemon-identity": "${SHENSI_API_DAEMON_IDENTITY:?required}"
  };
}

function expectedAcceptedComposeBase(gatewayImageReference) {
  const ownershipLabels = acceptedComposeOwnershipLabels();
  return {
    services: {
      mysql: {
        image: "mysql:8.4.11",
        environment: {
          MYSQL_DATABASE: "shensi",
          MYSQL_USER: "shensi_app",
          MYSQL_PASSWORD_FILE: "/run/secrets/mysql_app_password",
          MYSQL_ROOT_PASSWORD_FILE: "/run/secrets/mysql_root_password"
        },
        secrets: ["mysql_app_password", "mysql_root_password"],
        volumes: ["mysql_data:/var/lib/mysql"],
        ports: ["127.0.0.1:${SHENSI_API_MYSQL_HOST_PORT:?required}:3306"],
        networks: { shensi_internal: null, shensi_host: null },
        labels: { ...ownershipLabels },
        healthcheck: {
          test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -p$$(cat /run/secrets/mysql_root_password) --silent"],
          interval: "5s",
          timeout: "5s",
          retries: 30
        }
      },
      backend: {
        env_file: "${SHENSI_API_BACKEND_ENV_FILE:?required}",
        environment: {
          NODE_ENV: "production",
          CRM_STORE: "mysql",
          BACKEND_HOST: "0.0.0.0",
          PORT: "4188",
          TRUSTED_PROXY_CIDRS: "${SHENSI_API_GATEWAY_IP:?required}/32",
          SHENSI_API_GATEWAY_IP: "${SHENSI_API_GATEWAY_IP:?required}",
          DOUYIN_OUTREACH_ACTIONS_ENABLED: "false",
          DOUYIN_OUTREACH_APPROVALS_ENABLED: "true",
          DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED: "false",
          DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: "true",
          SHENSI_RUNTIME_READ_ONLY: "false",
          SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "migration_locked"
        },
        depends_on: { mysql: { condition: "service_healthy" } },
        networks: ["shensi_internal", "shensi_egress"],
        labels: { ...ownershipLabels },
        healthcheck: {
          test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4188/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],
          interval: "10s",
          timeout: "5s",
          retries: 20
        }
      },
      gateway: {
        image: gatewayImageReference,
        pull_policy: "never",
        ports: ["127.0.0.1:${SHENSI_API_HTTP_PORT:?required}:8080"],
        volumes: ["${SHENSI_API_GATEWAY_CONFIG_FILE:?required}:/etc/nginx/conf.d/default.conf:ro"],
        depends_on: { backend: { condition: "service_healthy" } },
        networks: {
          shensi_internal: { ipv4_address: "${SHENSI_API_GATEWAY_IP:?required}" },
          shensi_host: null
        },
        labels: { ...ownershipLabels }
      }
    },
    secrets: {
      mysql_app_password: { file: "${SHENSI_API_MYSQL_APP_PASSWORD_FILE:?required}" },
      mysql_root_password: { file: "${SHENSI_API_MYSQL_ROOT_PASSWORD_FILE:?required}" }
    },
    volumes: { mysql_data: { labels: { ...ownershipLabels } } },
    networks: {
      shensi_internal: {
        internal: true,
        labels: { ...ownershipLabels },
        ipam: {
          config: [{
            subnet: "${SHENSI_API_INTERNAL_SUBNET:?required}",
            gateway: "${SHENSI_API_IPAM_GATEWAY:?required}"
          }]
        }
      },
      shensi_egress: { labels: { ...ownershipLabels } },
      shensi_host: {
        driver: "bridge",
        driver_opts: {
          "com.docker.network.bridge.enable_ip_masquerade": "false",
          "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"
        },
        labels: { ...ownershipLabels }
      }
    }
  };
}

function validateAcceptedComposeBase(artifacts, inspected) {
  const file = artifacts.held.find(({ name }) => name === "acceptedComposeBase");
  const gatewayReference = inspected.acceptedResources?.gateway?.composeImageReference?.value;
  if (!file || typeof gatewayReference !== "string") throw failure("API_ONLY_ACCEPTED_COMPOSE_INPUT_INVALID");
  const value = decodeCanonicalAcceptedComposeJson(file.bytes);
  if (canonicalJson(value) !== canonicalJson(expectedAcceptedComposeBase(gatewayReference))) throw failure("API_ONLY_ACCEPTED_COMPOSE_INPUT_INVALID");
  return value;
}

function validateAcceptedBackendOverride(artifacts, projection) {
  const file = artifacts.held.find(({ name }) => name === "backendImageOverride");
  if (!file) throw failure("API_ONLY_ACCEPTED_COMPOSE_INPUT_INVALID");
  const expected = {
    services: {
      backend: {
        image: projection.expectedResources.backend.composeImageReference.value,
        pull_policy: "never"
      }
    }
  };
  const value = decodeCanonicalAcceptedComposeJson(file.bytes);
  if (canonicalJson(value) !== canonicalJson(expected)) throw failure("API_ONLY_ACCEPTED_COMPOSE_INPUT_INVALID");
  return value;
}

function parseAcceptedBackendEnvironment(artifacts) {
  const file = artifacts.held.find(({ name }) => name === "backendEnvironment");
  try {
    if (!file?.bytes || file.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    if (text.startsWith("\uFEFF") || text.includes("\0") || text.includes("\r") || text.includes("\uFFFD")) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.filter((line) => line !== "").length > 4_096) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
    const environment = new Map();
    for (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > 8 * 1024) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
      if (line === "" || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      const name = separator < 0 ? "" : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
        || Buffer.byteLength(value, "utf8") > 8 * 1024
        || environment.has(name)) throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
      environment.set(name, value);
    }
    return environment;
  } catch (caught) {
    if (caught?.message === "API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID") throw caught;
    throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID");
  }
}

function acceptedComposeEnvironment(projection, runtimeRoot) {
  return {
    SHENSI_API_BACKEND_ENV_FILE: projection.artifacts.backendEnvironment.path,
    SHENSI_API_MYSQL_APP_PASSWORD_FILE: join(runtimeRoot, "secrets", "mysql_app_password"),
    SHENSI_API_MYSQL_ROOT_PASSWORD_FILE: join(runtimeRoot, "secrets", "mysql_root_password"),
    SHENSI_API_GATEWAY_CONFIG_FILE: projection.artifacts.gatewayConfig.path,
    SHENSI_API_RUNTIME_ROOT: runtimeRoot,
    SHENSI_API_HTTP_PORT: String(projection.expectedResources.ports.gateway),
    SHENSI_API_MYSQL_HOST_PORT: String(projection.expectedResources.ports.mysql),
    SHENSI_API_INTERNAL_SUBNET: projection.expectedResources.networks.internal.subnet,
    SHENSI_API_IPAM_GATEWAY: projection.expectedResources.networks.internal.ipamGatewayIp,
    SHENSI_API_GATEWAY_IP: projection.expectedResources.networks.internal.gatewayServiceIp,
    SHENSI_API_RUNTIME_NONCE: projection.expectedResources.runtimeNonce,
    SHENSI_API_DAEMON_IDENTITY: projection.expectedResources.engine.daemonIdentity
  };
}

function acceptedComposeProcessEnvironment(runtime, validatedInput) {
  const environment = { HOME: runtime.environment.HOME };
  for (const name of SAFE_ENVIRONMENT_NAMES) if (typeof runtime.environment[name] === "string") environment[name] = runtime.environment[name];
  environment.DOCKER_HOST = unixDockerHost(runtime.socket.canonicalPath);
  environment.DOCKER_CONFIG = validatedInput.SHENSI_API_RUNTIME_ROOT;
  for (const name of API_ENVIRONMENT_NAMES) environment[name] = validatedInput[name];
  return frozen(environment);
}

function acceptedComposeInputsResult(runtime, projection, inspected) {
  const reference = projection.expectedResources.backend.composeImageReference;
  const hashDescriptor = {
    authorityKind: "accepted",
    versionId: projection.pointer.versionId,
    projectName: projection.expectedResources.project,
    socketIdentity: projection.expectedResources.engine.socketIdentity,
    daemonIdentity: projection.expectedResources.engine.daemonIdentity,
    runtimeNonce: projection.expectedResources.runtimeNonce,
    base: { basename: "accepted-compose-base.json", sha256: projection.artifacts.acceptedComposeBase.sha256 },
    backendOverride: {
      basename: "backend-image-override.json",
      sha256: projection.artifacts.backendImageOverride.sha256,
      imageIdDigest: projection.expectedResources.backend.imageIdDigest,
      composeImageReference: { kind: reference.kind, value: reference.value }
    },
    backendEnvironment: { basename: "backend.env", sha256: projection.artifacts.backendEnvironment.sha256 },
    gatewayConfig: { basename: "gateway.conf", sha256: projection.artifacts.gatewayConfig.sha256 },
    acceptedResources: { basename: "accepted-resources.json", sha256: projection.artifacts.acceptedResources.sha256 },
    gatewayImage: {
      imageIdDigest: inspected.acceptedResources.gateway.imageIdDigest,
      composeImageReference: {
        kind: inspected.acceptedResources.gateway.composeImageReference.kind,
        value: inspected.acceptedResources.gateway.composeImageReference.value
      }
    },
    secretRoles: ["mysql_app_password", "mysql_root_password"]
  };
  return frozen({
    schema: "shensi.api-only-validated-version-compose-inputs",
    version: 1,
    authorityKind: "accepted",
    versionId: projection.pointer.versionId,
    projectName: projection.expectedResources.project,
    socketIdentity: projection.expectedResources.engine.socketIdentity,
    daemonIdentity: projection.expectedResources.engine.daemonIdentity,
    runtimeNonce: projection.expectedResources.runtimeNonce,
    base: { path: projection.artifacts.acceptedComposeBase.path, sha256: projection.artifacts.acceptedComposeBase.sha256 },
    backendOverride: {
      path: projection.artifacts.backendImageOverride.path,
      sha256: projection.artifacts.backendImageOverride.sha256,
      imageIdDigest: projection.expectedResources.backend.imageIdDigest,
      composeImageReference: { kind: reference.kind, value: reference.value }
    },
    backendEnvironment: { path: projection.artifacts.backendEnvironment.path, sha256: projection.artifacts.backendEnvironment.sha256 },
    gatewayConfig: { path: projection.artifacts.gatewayConfig.path, sha256: projection.artifacts.gatewayConfig.sha256 },
    acceptedResources: { path: projection.artifacts.acceptedResources.path, sha256: projection.artifacts.acceptedResources.sha256 },
    secretRoles: ["mysql_app_password", "mysql_root_password"],
    inputsSha256: sha256(Buffer.concat([
      Buffer.from("shensi.api-only.validated-accepted-compose-inputs/v1\0", "utf8"),
      Buffer.from(canonicalJson(hashDescriptor), "utf8")
    ]))
  });
}

function resourceInventoryLabels(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).length > 64 || Object.entries(value).some(([key, item]) => !boundedInspectionText(key, 256) || typeof item !== "string" || Buffer.byteLength(item) > 4_096 || item.includes("\0"))) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  return value;
}

function resourceContainerInventory(value) {
  if (!Array.isArray(value) || value.length > 16) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !HASH.test(item.Id ?? "")) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
    return { id: item.Id, labels: resourceInventoryLabels(item.Labels) };
  });
}

function resourceNetworkInventory(value) {
  if (!Array.isArray(value) || value.length > 16) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !HASH.test(item.Id ?? "") || !boundedInspectionText(item.Name)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
    return { id: item.Id, name: item.Name, labels: resourceInventoryLabels(item.Labels) };
  });
}

function resourceVolumeInventory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.Volumes) || value.Volumes.length > 16) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  return value.Volumes.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !boundedInspectionText(item.Name)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
    return { name: item.Name, labels: resourceInventoryLabels(item.Labels) };
  });
}

function acceptedProjectCandidates(projection, containers, networks, volumes) {
  const expected = projection.expectedResources;
  const project = expected.project;
  const containerIds = new Set();
  const byService = new Map([["mysql", []], ["backend", []], ["gateway", []]]);
  for (const container of containers) {
    const service = container.labels["com.docker.compose.service"];
    if (containerIds.has(container.id)
      || container.labels["com.docker.compose.project"] !== project
      || !byService.has(service)) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
    containerIds.add(container.id);
    byService.get(service).push(container);
  }
  if (byService.get("mysql").length !== 1
    || byService.get("mysql")[0].id !== expected.mysql.containerId
    || byService.get("backend").length > 1
    || byService.get("gateway").length > 1) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");

  const networkIds = new Set();
  const networkNames = new Set();
  const byNetwork = new Map([["shensi_internal", []], ["shensi_egress", []], ["shensi_host", []]]);
  for (const network of networks) {
    const logicalName = network.labels["com.docker.compose.network"];
    if (networkIds.has(network.id)
      || networkNames.has(network.name)
      || network.labels["com.docker.compose.project"] !== project
      || !byNetwork.has(logicalName)) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
    networkIds.add(network.id);
    networkNames.add(network.name);
    byNetwork.get(logicalName).push(network);
  }
  for (const [logicalName, expectedNetwork] of [["shensi_internal", expected.networks.internal], ["shensi_egress", expected.networks.egress], ["shensi_host", expected.networks.host]]) {
    const candidates = byNetwork.get(logicalName);
    if (candidates.length !== 1 || candidates[0].id !== expectedNetwork.id || candidates[0].name !== expectedNetwork.name) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
  }

  const volumeNames = new Set();
  const mysqlVolumes = [];
  for (const volume of volumes) {
    if (volumeNames.has(volume.name)
      || volume.labels["com.docker.compose.project"] !== project
      || volume.labels["com.docker.compose.volume"] !== "mysql_data") throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
    volumeNames.add(volume.name);
    mysqlVolumes.push(volume);
  }
  if (mysqlVolumes.length !== 1 || mysqlVolumes[0].name !== expected.mysql.volumeName) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
  return {
    mysqlId: byService.get("mysql")[0].id,
    backendId: byService.get("backend")[0]?.id ?? null,
    gatewayId: byService.get("gateway")[0]?.id ?? null
  };
}

function normalizedResourceStringMap(value) {
  resourceInventoryLabels(value);
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function normalizedResourceIpamConfig(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.Subnet !== "string" || typeof item.Gateway !== "string") throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
    const ipv4 = cidr(item.Subnet);
    if (ipv4) {
      const gateway = ipv4Number(item.Gateway);
      if (ipv4.text !== item.Subnet || gateway === null || ipv4Text(gateway) !== item.Gateway || gateway <= ipv4.network || gateway >= ipv4.end || seen.has(item.Subnet)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
    } else {
      const ipv6 = ipv6Range(item.Subnet);
      const gateway = normalizedIpv6Address(item.Gateway);
      if (!ipv6 || !gateway || gateway.text !== item.Gateway || gateway.number <= ipv6.network || gateway.number > ipv6.end || seen.has(item.Subnet)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
    }
    seen.add(item.Subnet);
    return { subnet: item.Subnet, gateway: item.Gateway };
  });
}

function resourceIdentitySha256(domain, value) {
  return sha256(Buffer.concat([Buffer.from(`${domain}\0`, "utf8"), Buffer.from(JSON.stringify(value), "utf8")]));
}

function requiredResourceLabels(labels, expected, logicalKey, logicalValue) {
  return labels["com.docker.compose.project"] === expected.project
    && labels[logicalKey] === logicalValue
    && labels["io.shensi.api.runtime-nonce"] === expected.runtimeNonce
    && labels["io.shensi.api.daemon-identity"] === expected.engine.daemonIdentity;
}

function normalizedNetworkAttachments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  const ids = new Set();
  for (const [id, attachment] of Object.entries(value)) {
    if (!HASH.test(id) || ids.has(id) || !attachment || typeof attachment !== "object" || Array.isArray(attachment)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
    ids.add(id);
  }
  return ids;
}

function normalizeAcceptedNetwork(value, expected, logicalName, projectContainers, allowedProjectAttachments) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !HASH.test(value.Id ?? "")
    || !boundedInspectionText(value.Name)
    || !boundedInspectionText(value.Driver)
    || !boundedInspectionText(value.Scope)
    || typeof value.Internal !== "boolean"
    || typeof value.Attachable !== "boolean"
    || typeof value.Ingress !== "boolean"
    || !value.IPAM || typeof value.IPAM !== "object" || Array.isArray(value.IPAM)
    || !boundedInspectionText(value.IPAM.Driver)
    || !value.Options || typeof value.Options !== "object" || Array.isArray(value.Options)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  const labels = normalizedResourceStringMap(value.Labels);
  const options = normalizedResourceStringMap(value.Options);
  const ipamConfig = normalizedResourceIpamConfig(value.IPAM.Config);
  const attachments = normalizedNetworkAttachments(value.Containers);
  const identity = {
    name: value.Name,
    id: value.Id,
    driver: value.Driver,
    scope: value.Scope,
    internal: value.Internal,
    attachable: value.Attachable,
    ingress: value.Ingress,
    ipamDriver: value.IPAM.Driver,
    ipamConfig,
    options,
    labels
  };
  const internal = logicalName === "shensi_internal";
  const expectedNetwork = {
    shensi_internal: expected.networks.internal,
    shensi_egress: expected.networks.egress,
    shensi_host: expected.networks.host
  }[logicalName];
  if (identity.id !== expectedNetwork.id
    || identity.name !== expectedNetwork.name
    || identity.driver !== "bridge"
    || identity.scope !== "local"
    || identity.internal !== internal
    || identity.attachable !== false
    || identity.ingress !== false
    || identity.ipamDriver !== "default"
    || !requiredResourceLabels(labels, expected, "com.docker.compose.network", logicalName)
    || internal && (ipamConfig.length !== 1 || ipamConfig[0].subnet !== expectedNetwork.subnet || ipamConfig[0].gateway !== expectedNetwork.ipamGatewayIp)
    || resourceIdentitySha256("shensi.api-only.network-identity/v1", identity) !== expectedNetwork.identitySha256) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
  if (!internal) for (const id of attachments) if (projectContainers.has(id) && !allowedProjectAttachments.has(id)) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
  return { identity, attachments: [...attachments].sort() };
}

function normalizeAcceptedVolume(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !boundedInspectionText(value.Name)
    || !boundedInspectionText(value.Driver)
    || !boundedInspectionText(value.Scope)
    || typeof value.Mountpoint !== "string"
    || !isAbsolute(value.Mountpoint)
    || resolve(value.Mountpoint) !== value.Mountpoint
    || value.Mountpoint.includes("\0")
    || Buffer.byteLength(value.Mountpoint) > 4_096
    || !validUtc(value.CreatedAt)
    || !value.Options || typeof value.Options !== "object" || Array.isArray(value.Options)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  const identity = {
    name: value.Name,
    driver: value.Driver,
    scope: value.Scope,
    mountpoint: value.Mountpoint,
    createdAt: value.CreatedAt,
    options: normalizedResourceStringMap(value.Options),
    labels: normalizedResourceStringMap(value.Labels)
  };
  if (identity.name !== expected.mysql.volumeName
    || identity.driver !== "local"
    || identity.scope !== "local"
    || !requiredResourceLabels(identity.labels, expected, "com.docker.compose.volume", "mysql_data")
    || resourceIdentitySha256("shensi.api-only.volume-identity/v1", identity) !== expected.mysql.volumeIdentitySha256) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
  return identity;
}

function normalizeAcceptedContainerState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.Status !== "string"
    || typeof value.Running !== "boolean"
    || typeof value.Paused !== "boolean"
    || typeof value.Restarting !== "boolean"
    || typeof value.OOMKilled !== "boolean"
    || typeof value.Dead !== "boolean"
    || !Number.isSafeInteger(value.ExitCode)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  if (value.Paused || value.Restarting || value.OOMKilled || value.Dead || value.ExitCode !== 0) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
  const state = value.Status === "created" && value.Running === false ? "created"
    : value.Status === "running" && value.Running === true ? "running"
      : value.Status === "exited" && value.Running === false ? "clean-stopped" : null;
  if (state === null) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
  let health = null;
  if (value.Health !== undefined) {
    if (!value.Health || typeof value.Health !== "object" || Array.isArray(value.Health) || !["starting", "healthy", "unhealthy"].includes(value.Health.Status)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
    health = value.Health.Status;
  }
  return { state, health, healthy: health === "healthy" ? true : health === "unhealthy" ? false : null };
}

function normalizeAcceptedContainerLabels(value, expected, service) {
  const labels = normalizedResourceStringMap(value);
  if (!requiredResourceLabels(labels, expected, "com.docker.compose.service", service)
    || labels["com.docker.compose.oneoff"] !== "False"
    || labels["com.docker.compose.container-number"] !== "1") throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
  return labels;
}

function exactLoopbackPortBindings(value, containerPort, hostPort) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [containerPort])) return false;
  const bindings = value[containerPort];
  return Array.isArray(bindings)
    && bindings.length === 1
    && bindings[0] && typeof bindings[0] === "object" && !Array.isArray(bindings[0])
    && bindings[0].HostIp === "127.0.0.1"
    && bindings[0].HostPort === String(hostPort);
}

function exactContainerNetworks(value, expectedNetworks) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== expectedNetworks.length) return false;
  for (const expected of expectedNetworks) {
    const attachment = value[expected.name];
    const range = expected.subnet ? cidr(expected.subnet) : null;
    const address = attachment && ipv4Number(attachment.IPAddress);
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)
      || attachment.NetworkID !== expected.id
      || range && (address === null || ipv4Text(address) !== attachment.IPAddress || address <= range.network || address >= range.end || attachment.IPPrefixLen !== range.prefix)) return false;
  }
  return true;
}

function normalizeAcceptedMounts(value) {
  if (!Array.isArray(value) || value.length > 16) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  const byDestination = new Map();
  for (const mount of value) {
    if (!mount || typeof mount !== "object" || Array.isArray(mount)
      || !boundedInspectionText(mount.Type)
      || typeof mount.Source !== "string"
      || typeof mount.Destination !== "string"
      || typeof mount.Mode !== "string"
      || typeof mount.RW !== "boolean"
      || typeof mount.Propagation !== "string"
      || byDestination.has(mount.Destination)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
    byDestination.set(mount.Destination, mount);
  }
  return byDestination;
}

function normalizeAcceptedMysql(value, expected, runtimeRoot, hostNetwork) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !value.Config || typeof value.Config !== "object" || Array.isArray(value.Config)
    || !value.HostConfig || typeof value.HostConfig !== "object" || Array.isArray(value.HostConfig)
    || !value.NetworkSettings || typeof value.NetworkSettings !== "object" || Array.isArray(value.NetworkSettings)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  const labels = normalizeAcceptedContainerLabels(value.Config.Labels, expected, "mysql");
  const state = normalizeAcceptedContainerState(value.State);
  const mounts = normalizeAcceptedMounts(value.Mounts);
  const data = mounts.get("/var/lib/mysql");
  const appSecret = mounts.get("/run/secrets/mysql_app_password");
  const rootSecret = mounts.get("/run/secrets/mysql_root_password");
  const hostSubnet = hostNetwork.identity.ipamConfig.find(({ subnet }) => cidr(subnet))?.subnet;
  const validSecret = (mount, basenameValue) => mount
    && mount.Type === "bind"
    && mount.Source === join(runtimeRoot, "secrets", basenameValue)
    && mount.Mode === "ro"
    && mount.RW === false;
  if (value.Id !== expected.mysql.containerId
    || value.Image !== expected.mysql.imageIdDigest
    || !exactLoopbackPortBindings(value.HostConfig.PortBindings, "3306/tcp", expected.ports.mysql)
    || !exactLoopbackPortBindings(value.NetworkSettings.Ports, "3306/tcp", expected.ports.mysql)
    || !exactContainerNetworks(value.NetworkSettings.Networks, [
      expected.networks.internal,
      { ...expected.networks.host, subnet: hostSubnet }
    ])
    || mounts.size !== 3
    || !data
    || data.Type !== "volume"
    || data.Name !== expected.mysql.volumeName
    || data.Destination !== "/var/lib/mysql"
    || data.Mode !== "rw"
    || data.RW !== true
    || !validSecret(appSecret, "mysql_app_password")
    || !validSecret(rootSecret, "mysql_root_password")) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
  const identity = {
    id: value.Id,
    imageId: value.Image,
    labels,
    ports: { containerPort: "3306/tcp", hostIp: "127.0.0.1", hostPort: String(expected.ports.mysql) },
    networks: Object.fromEntries(Object.entries(value.NetworkSettings.Networks).sort(([left], [right]) => left < right ? -1 : 1).map(([name, attachment]) => [name, {
      networkId: attachment.NetworkID,
      ipv4Address: attachment.IPAddress,
      ipv4PrefixLength: attachment.IPPrefixLen
    }])),
    mounts: [...mounts.values()].sort((left, right) => left.Destination < right.Destination ? -1 : 1).map((mount) => ({
      type: mount.Type,
      name: mount.Name ?? null,
      source: mount.Source,
      destination: mount.Destination,
      mode: mount.Mode,
      readWrite: mount.RW,
      propagation: mount.Propagation
    }))
  };
  return { identity, state, volumeSource: data.Source };
}

function emptyPortBindings(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function normalizeAcceptedBackend(value, expected, containerId, internalNetwork, egressNetwork) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !value.Config || typeof value.Config !== "object" || Array.isArray(value.Config)
    || !value.HostConfig || typeof value.HostConfig !== "object" || Array.isArray(value.HostConfig)
    || !value.NetworkSettings || typeof value.NetworkSettings !== "object" || Array.isArray(value.NetworkSettings)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  const labels = normalizeAcceptedContainerLabels(value.Config.Labels, expected, "backend");
  const state = normalizeAcceptedContainerState(value.State);
  const internalSubnet = internalNetwork.identity.ipamConfig.find(({ subnet }) => cidr(subnet))?.subnet;
  const egressSubnet = egressNetwork.identity.ipamConfig.find(({ subnet }) => cidr(subnet))?.subnet;
  if (value.Id !== containerId
    || value.Image !== expected.backend.imageIdDigest
    || !emptyPortBindings(value.HostConfig.PortBindings)
    || !emptyPortBindings(value.NetworkSettings.Ports)
    || !exactContainerNetworks(value.NetworkSettings.Networks, [
      { ...expected.networks.internal, subnet: internalSubnet },
      { ...expected.networks.egress, subnet: egressSubnet }
    ])
    || !Array.isArray(value.Mounts)
    || value.Mounts.length !== 0) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
  return {
    identity: {
      id: value.Id,
      imageId: value.Image,
      labels,
      ports: {},
      networks: Object.fromEntries(Object.entries(value.NetworkSettings.Networks).sort(([left], [right]) => left < right ? -1 : 1).map(([name, attachment]) => [name, {
        networkId: attachment.NetworkID,
        ipv4Address: attachment.IPAddress,
        ipv4PrefixLength: attachment.IPPrefixLen
      }])),
      mounts: []
    },
    state
  };
}

function normalizeAcceptedGateway(value, expected, accepted, containerId, gatewayConfigPath, hostNetwork) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !value.Config || typeof value.Config !== "object" || Array.isArray(value.Config)
    || !value.HostConfig || typeof value.HostConfig !== "object" || Array.isArray(value.HostConfig)
    || !value.NetworkSettings || typeof value.NetworkSettings !== "object" || Array.isArray(value.NetworkSettings)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  const labels = normalizeAcceptedContainerLabels(value.Config.Labels, expected, "gateway");
  const state = normalizeAcceptedContainerState(value.State);
  const mounts = normalizeAcceptedMounts(value.Mounts);
  const config = mounts.get("/etc/nginx/conf.d/default.conf");
  const attachment = value.NetworkSettings.Networks?.[expected.networks.internal.name];
  const hostSubnet = hostNetwork.identity.ipamConfig.find(({ subnet }) => cidr(subnet))?.subnet;
  if (value.Id !== containerId
    || value.Image !== accepted.gateway.imageIdDigest
    || value.Config.Healthcheck !== undefined && value.Config.Healthcheck !== null
    || state.health !== null
    || !exactLoopbackPortBindings(value.HostConfig.PortBindings, "8080/tcp", expected.ports.gateway)
    || !exactLoopbackPortBindings(value.NetworkSettings.Ports, "8080/tcp", expected.ports.gateway)
    || !exactContainerNetworks(value.NetworkSettings.Networks, [
      expected.networks.internal,
      { ...expected.networks.host, subnet: hostSubnet }
    ])
    || attachment?.IPAddress !== expected.networks.internal.gatewayServiceIp
    || mounts.size !== 1
    || !config
    || config.Type !== "bind"
    || config.Source !== gatewayConfigPath
    || config.Mode !== "ro"
    || config.RW !== false) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
  return {
    identity: {
      id: value.Id,
      imageId: value.Image,
      labels,
      ports: { containerPort: "8080/tcp", hostIp: "127.0.0.1", hostPort: String(expected.ports.gateway) },
      networks: Object.fromEntries(Object.entries(value.NetworkSettings.Networks).map(([name, network]) => [name, {
        networkId: network.NetworkID,
        ipv4Address: network.IPAddress,
        ipv4PrefixLength: network.IPPrefixLen
      }])),
      mounts: [{
        type: config.Type,
        name: config.Name ?? null,
        source: config.Source,
        destination: config.Destination,
        mode: config.Mode,
        readWrite: config.RW,
        propagation: config.Propagation
      }]
    },
    state,
    healthcheckConfigured: false
  };
}

function normalizeAcceptedImage(value, imageIdDigest, references) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !IMAGE_DIGEST.test(value.Id ?? "")
    || !Array.isArray(value.RepoDigests)
    || value.RepoDigests.length > 256
    || value.RepoDigests.some((digest) => typeof digest !== "string" || Buffer.byteLength(digest) > 512)) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  if (new Set(value.RepoDigests).size !== value.RepoDigests.length) throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
  if (value.Id !== imageIdDigest) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
  for (const reference of references) {
    if (reference.kind === "repository-digest" && value.RepoDigests.filter((digest) => digest === reference.value).length !== 1) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
  }
  return { id: value.Id, repoDigests: [...value.RepoDigests].sort() };
}

function acceptedResourceResult(projection, artifacts, runtime, observation) {
  const identities = frozen({
    runtime: { socketIdentity: runtime.socket.identity, daemonIdentity: runtime.daemon.identity },
    project: projection.expectedResources.project,
    runtimeNonce: projection.expectedResources.runtimeNonce,
    networks: {
      internal: { identity: observation.internal.identity, attachments: observation.internal.attachments },
      egress: { identity: observation.egress.identity, attachments: observation.egress.attachments },
      host: { identity: observation.host.identity, attachments: observation.host.attachments }
    },
    volume: observation.volume,
    mysql: observation.mysql.identity,
    backend: observation.backend?.identity ?? null,
    gateway: observation.gateway?.identity ?? null,
    images: observation.images
  });
  const states = frozen({
    mysql: observation.mysql.state,
    backend: observation.backend?.state ?? null,
    gateway: observation.gateway?.state ?? null
  });
  const projectionSha256 = resourceIdentitySha256("shensi.api-only.accepted-resource-projection/v1", projection);
  const artifactSetSha256 = resourceIdentitySha256("shensi.api-only.accepted-artifact-set/v1", artifacts.descriptorProof);
  const identitySha256 = resourceIdentitySha256("shensi.api-only.accepted-resource-identity/v1", identities);
  const stateSha256 = resourceIdentitySha256("shensi.api-only.accepted-resource-state/v1", { identities, states });
  return {
    result: frozen({
      schema: "shensi.api-only.accepted-resource-set",
      version: 1,
      projectionSha256,
      artifactSetSha256,
      identitySha256,
      stateSha256,
      matched: true,
      mysql: { present: true, state: states.mysql.state, healthy: states.mysql.healthy },
      backend: observation.backend === null
        ? { present: false, state: "absent", healthy: null }
        : { present: true, state: states.backend.state, healthy: states.backend.healthy },
      gateway: observation.gateway === null
        ? { present: false, state: "absent", healthcheckConfigured: false }
        : { present: true, state: states.gateway.state, healthcheckConfigured: false }
    }),
    metadata: frozen({
      runtime,
      projection,
      projectionSha256,
      acceptedResources: artifacts.acceptedResources,
      artifacts: artifacts.held.map(({ path, identity }) => ({ path, identity: { ...identity } })),
      identities,
      states,
      engineHealth: {
        mysql: states.mysql.health,
        backend: states.backend?.health ?? null,
        gateway: states.gateway?.health ?? null
      }
    })
  };
}

async function observeAcceptedResources(requestFunction, setTimer, clearTimer, runtime, projection, artifacts) {
  const accepted = artifacts.acceptedResources;
  const read = async (path) => {
    try { return await readBoundedEngineJson(requestFunction, runtime.socket.canonicalPath, path, setTimer, clearTimer); }
    catch { throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID"); }
  };
  const daemonIdentity = async () => {
    let identity;
    try { identity = inspectedDaemonIdentity(await read("/info"), runtime.socket.canonicalPath); }
    catch (caught) {
      if (caught?.message === "API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID") throw caught;
      throw failure("API_ONLY_ACCEPTED_RESOURCE_ENGINE_RESPONSE_INVALID");
    }
    if (identity !== runtime.daemon.identity || identity !== projection.expectedResources.engine.daemonIdentity || runtime.socket.identity !== projection.expectedResources.engine.socketIdentity) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
    return identity;
  };
  await daemonIdentity();
  const project = projection.expectedResources.project;
  const filter = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }));
  const containers = resourceContainerInventory(await read(`/containers/json?all=1&filters=${filter}`));
  const networks = resourceNetworkInventory(await read(`/networks?filters=${filter}`));
  const volumes = resourceVolumeInventory(await read(`/volumes?filters=${filter}`));
  const candidates = acceptedProjectCandidates(projection, containers, networks, volumes);
  const projectContainers = new Set(containers.map(({ id }) => id));
  const exact = [];
  const internal = normalizeAcceptedNetwork(
    await read(`/networks/${encodeURIComponent(projection.expectedResources.networks.internal.id)}`),
    projection.expectedResources,
    "shensi_internal",
    projectContainers,
    projectContainers
  );
  exact.push(internal);
  const egress = normalizeAcceptedNetwork(
    await read(`/networks/${encodeURIComponent(projection.expectedResources.networks.egress.id)}`),
    projection.expectedResources,
    "shensi_egress",
    projectContainers,
    new Set(candidates.backendId === null ? [] : [candidates.backendId])
  );
  exact.push(egress);
  const host = normalizeAcceptedNetwork(
    await read(`/networks/${encodeURIComponent(projection.expectedResources.networks.host.id)}`),
    projection.expectedResources,
    "shensi_host",
    projectContainers,
    new Set([candidates.mysqlId, candidates.gatewayId].filter((id) => id !== null))
  );
  exact.push(host);
  const mysql = normalizeAcceptedMysql(
    await read(`/containers/${encodeURIComponent(candidates.mysqlId)}/json`),
    projection.expectedResources,
    artifacts.runtimeRoot,
    host
  );
  exact.push(mysql);
  const volume = normalizeAcceptedVolume(await read(`/volumes/${encodeURIComponent(projection.expectedResources.mysql.volumeName)}`), projection.expectedResources);
  if (mysql.volumeSource !== volume.mountpoint) throw failure("API_ONLY_ACCEPTED_RESOURCE_MISMATCH");
  exact.push(volume);
  const backend = candidates.backendId === null ? null : normalizeAcceptedBackend(
    await read(`/containers/${encodeURIComponent(candidates.backendId)}/json`),
    projection.expectedResources,
    candidates.backendId,
    internal,
    egress
  );
  if (backend) exact.push(backend);
  const gateway = candidates.gatewayId === null ? null : normalizeAcceptedGateway(
    await read(`/containers/${encodeURIComponent(candidates.gatewayId)}/json`),
    projection.expectedResources,
    accepted,
    candidates.gatewayId,
    projection.artifacts.gatewayConfig.path,
    host
  );
  if (gateway) exact.push(gateway);
  const imageExpectations = new Map();
  for (const [imageId, reference] of [
    [accepted.mysql.imageIdDigest, null],
    [accepted.backend.imageIdDigest, accepted.backend.composeImageReference],
    [accepted.gateway.imageIdDigest, accepted.gateway.composeImageReference]
  ]) {
    if (!imageExpectations.has(imageId)) imageExpectations.set(imageId, []);
    if (reference) imageExpectations.get(imageId).push(reference);
  }
  const images = [];
  for (const [imageId, references] of imageExpectations) images.push(normalizeAcceptedImage(await read(`/images/${encodeURIComponent(imageId)}/json`), imageId, references));
  exact.push(...images);
  await daemonIdentity();
  return { containers, networks, volumes, internal, egress, host, mysql, volume, backend, gateway, images, exact };
}

export function createApiOnlyResourceInspectionBridge(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw failure("API_ONLY_RESOURCE_INSPECTION_OPTIONS_INVALID");
  const allowed = new Set(["request", "lstat", "realpath", "open", "getuid", "setTimeout", "clearTimeout"]);
  for (const [name, value] of Object.entries(options)) {
    if (!allowed.has(name) || typeof value !== "function") throw failure("API_ONLY_RESOURCE_INSPECTION_OPTIONS_INVALID");
  }
  const filesystem = {
    lstat: options.lstat ?? nativeFs.lstat,
    realpath: options.realpath ?? nativeFs.realpath,
    open: options.open ?? nativeFs.open
  };
  const getuid = options.getuid ?? (() => process.getuid?.() ?? 0);
  const requestFunction = options.request ?? request;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  return Object.freeze({
    async inspectAcceptedResourceSet(runtime, projection) {
      if (!resolvedRuntimes.has(runtime)) throw failure("COMPOSE_RUNTIME_UNTRUSTED");
      assertApiOnlyAcceptedResourceProjection(projection, "accepted");
      let artifacts;
      try {
        let uid;
        try { uid = getuid(); } catch { throw failure("API_ONLY_ACCEPTED_RESOURCE_ARTIFACT_INVALID"); }
        artifacts = await openAcceptedResourceArtifacts(filesystem, uid, projection);
        const observation = await observeAcceptedResources(requestFunction, setTimer, clearTimer, runtime, projection, artifacts);
        await revalidateAcceptedResourceArtifacts(filesystem, uid, artifacts);
        const inspected = acceptedResourceResult(projection, artifacts, runtime, observation);
        acceptedResourceInspections.set(inspected.result, inspected.metadata);
        return inspected.result;
      } finally {
        if (artifacts) await closeAcceptedArtifactHandles(artifacts.held);
      }
    }
  });
}

export function createApiOnlyAcceptedComposeValidationBridge(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw failure("API_ONLY_ACCEPTED_COMPOSE_OPTIONS_INVALID");
  const allowed = new Set([
    "lstat", "realpath", "open", "getuid", "spawn", "setTimeout", "clearTimeout",
    "revalidateExecutable", "probeDaemonIdentity", "monotonicNow"
  ]);
  for (const [name, value] of Object.entries(options)) {
    if (!allowed.has(name) || typeof value !== "function") throw failure("API_ONLY_ACCEPTED_COMPOSE_OPTIONS_INVALID");
  }
  const filesystem = {
    lstat: options.lstat ?? nativeFs.lstat,
    realpath: options.realpath ?? nativeFs.realpath,
    open: options.open ?? nativeFs.open
  };
  const getuid = options.getuid ?? (() => process.getuid?.() ?? 0);
  const privateInputDependencies = { ...filesystem, getuid };
  return Object.freeze({
    async validateAcceptedComposeInputs(runtime, projection, observation) {
      if (!resolvedRuntimes.has(runtime)) throw failure("COMPOSE_RUNTIME_UNTRUSTED");
      assertApiOnlyAcceptedResourceProjection(projection, "accepted");
      const inspected = acceptedResourceInspections.get(observation);
      if (!inspected || inspected.runtime !== runtime || inspected.projection !== projection || observation.matched !== true) throw failure("API_ONLY_ACCEPTED_COMPOSE_OBSERVATION_REQUIRED");
      let artifacts;
      try {
        let uid;
        try { uid = getuid(); } catch { throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID"); }
        artifacts = await openAcceptedComposeArtifacts(filesystem, uid, projection, inspected);
        validateAcceptedComposeBase(artifacts, inspected);
        validateAcceptedBackendOverride(artifacts, projection);
        const backendEnvironment = parseAcceptedBackendEnvironment(artifacts);
        let validatedInput;
        try {
          validatedInput = await validateApiOnlyComposeInputs(
            runtime,
            acceptedComposeEnvironment(projection, artifacts.runtimeRoot),
            artifacts.runtimeRoot,
            privateInputDependencies
          );
        } catch {
          throw failure("API_ONLY_ACCEPTED_COMPOSE_INPUT_INVALID");
        }
        const args = [
          "-f", projection.artifacts.acceptedComposeBase.path,
          "-f", projection.artifacts.backendImageOverride.path,
          "--project-name", projection.expectedResources.project,
          "config", "--quiet"
        ];
        const processEnvironment = acceptedComposeProcessEnvironment(runtime, validatedInput);
        const execution = frozen({});
        acceptedComposeExecutions.set(execution, {
          runtime,
          args,
          cwd: artifacts.versionRoot,
          runtimeRoot: artifacts.runtimeRoot,
          validatedInput,
          environment: processEnvironment,
          dependencies: privateInputDependencies,
          sensitiveValues: [...backendEnvironment.values()].filter(Boolean),
          used: false,
          revalidate: () => revalidateAcceptedComposeArtifacts(filesystem, uid, artifacts)
        });
        let commandResult;
        try {
          commandResult = await runResolvedCompose(runtime, args, {
            acceptedComposeValidation: execution,
            cwd: artifacts.versionRoot,
            spawn: options.spawn,
            setTimeout: options.setTimeout,
            clearTimeout: options.clearTimeout,
            revalidateExecutable: options.revalidateExecutable,
            probeDaemonIdentity: options.probeDaemonIdentity,
            monotonicNow: options.monotonicNow
          });
        } catch (caught) {
          if (caught?.message === "API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID") throw caught;
          throw failure("API_ONLY_ACCEPTED_COMPOSE_UNSUPPORTED");
        }
        if (commandResult.truncated) throw failure("API_ONLY_ACCEPTED_COMPOSE_UNSUPPORTED");
        await revalidateAcceptedComposeArtifacts(filesystem, uid, artifacts);
        const result = acceptedComposeInputsResult(runtime, projection, inspected);
        validatedAcceptedComposeInputs.set(result, {
          runtime,
          projection,
          observation,
          validatedInput,
          environment: processEnvironment,
          artifactIdentities: artifacts.held.map(({ name, path, identity }) => ({ name, path, identity: { ...identity } })),
          used: false
        });
        return result;
      } finally {
        if (artifacts) await closeAcceptedComposeArtifacts(artifacts.held);
      }
    }
  });
}

function acceptedComposeLifecycleArgs(projection, operation) {
  const prefix = [
    "-f", projection.artifacts.acceptedComposeBase.path,
    "-f", projection.artifacts.backendImageOverride.path,
    "--project-name", projection.expectedResources.project
  ];
  if (operation === "status") return [...prefix, "ps", "--format", "json"];
  if (operation === "start-mysql") return [...prefix, "start", "mysql"];
  if (operation === "start-runtime") return [...prefix, "up", "-d", "--no-build", "--no-deps", "backend", "gateway"];
  if (operation === "stop") return [...prefix, "stop"];
  throw failure("API_ONLY_ACCEPTED_LIFECYCLE_OPERATION_INVALID");
}

function acceptedComposeStatusState(state) {
  if (state === "clean-stopped") return "exited";
  return state;
}

function parseAcceptedComposeStatus(result, rawOutput, inspected) {
  try {
    if (!result || result.code !== 0 || result.truncated !== false || !Buffer.isBuffer(rawOutput)
      || rawOutput.length > MAX_OUTPUT_BYTES) throw failure("API_ONLY_ACCEPTED_STATUS_OUTPUT_INVALID");
    const output = new TextDecoder("utf-8", { fatal: true }).decode(rawOutput);
    if (output.includes("\0")) throw failure("API_ONLY_ACCEPTED_STATUS_OUTPUT_INVALID");
    const rows = JSON.parse(output);
    if (!Array.isArray(rows) || rows.length > 3) throw failure("API_ONLY_ACCEPTED_STATUS_OUTPUT_INVALID");
    const order = ["mysql", "backend", "gateway"];
    const seen = new Set();
    const services = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)
        || typeof row.ID !== "string" || typeof row.Service !== "string"
        || typeof row.State !== "string" || typeof row.Health !== "string"
        || !order.includes(row.Service) || seen.has(row.Service)) throw failure("API_ONLY_ACCEPTED_STATUS_OUTPUT_INVALID");
      const identity = inspected.identities[row.Service];
      const state = inspected.states[row.Service];
      const health = inspected.engineHealth[row.Service];
      if (!identity || !state
        || row.ID !== identity.id
        || row.State !== acceptedComposeStatusState(state.state)
        || row.Health !== (health ?? "")) throw failure("API_ONLY_ACCEPTED_STATUS_OUTPUT_INVALID");
      seen.add(row.Service);
      services.push(frozen({ service: row.Service, state: state.state, health: health ?? "none" }));
    }
    for (const service of order) {
      const state = inspected.states[service];
      if (state && state.state !== "clean-stopped" && !seen.has(service)) throw failure("API_ONLY_ACCEPTED_STATUS_OUTPUT_INVALID");
    }
    services.sort((left, right) => order.indexOf(left.service) - order.indexOf(right.service));
    return frozen(services);
  } catch (caught) {
    if (caught?.message === "API_ONLY_ACCEPTED_STATUS_OUTPUT_INVALID") throw caught;
    throw failure("API_ONLY_ACCEPTED_STATUS_OUTPUT_INVALID");
  }
}

function acceptedLifecyclePrecondition(operation, inspected) {
  const { mysql, backend, gateway } = inspected.states;
  const health = inspected.engineHealth;
  if (operation === "start-mysql") {
    return ["created", "clean-stopped"].includes(mysql.state)
      || mysql.state === "running" && ["starting", "healthy"].includes(health.mysql);
  }
  if (operation === "start-runtime") {
    const backendOkay = backend === null
      || ["created", "clean-stopped"].includes(backend.state)
      || backend.state === "running" && ["starting", "healthy"].includes(health.backend);
    const gatewayOkay = gateway === null
      || ["created", "clean-stopped"].includes(gateway.state)
      || gateway.state === "running" && health.gateway === null;
    return mysql.state === "running" && health.mysql === "healthy" && backendOkay && gatewayOkay;
  }
  if (operation === "stop") return true;
  return false;
}

function acceptedLifecycleTarget(operation, inspected) {
  const { mysql, backend, gateway } = inspected.states;
  const health = inspected.engineHealth;
  if (operation === "start-mysql") return mysql.state === "running" && ["starting", "healthy"].includes(health.mysql);
  if (operation === "start-runtime") return mysql.state === "running" && health.mysql === "healthy"
    && backend?.state === "running" && ["starting", "healthy"].includes(health.backend)
    && gateway?.state === "running" && health.gateway === null;
  if (operation === "stop") return mysql.state === "clean-stopped"
    && (backend === null || backend.state === "clean-stopped")
    && (gateway === null || gateway.state === "clean-stopped");
  return false;
}

function sameAcceptedIdentity(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function acceptedLifecycleRetrySafePartial(operation, before, after) {
  if (operation === "start-runtime") {
    const coreStable = sameAcceptedIdentity(before.identities.runtime, after.identities.runtime)
      && before.identities.project === after.identities.project
      && before.identities.runtimeNonce === after.identities.runtimeNonce
      && sameAcceptedIdentity(before.identities.networks, after.identities.networks)
      && sameAcceptedIdentity(before.identities.volume, after.identities.volume)
      && sameAcceptedIdentity(before.identities.mysql, after.identities.mysql)
      && sameAcceptedIdentity(before.identities.images, after.identities.images);
    const backendOkay = after.states.backend === null
      || ["created", "clean-stopped"].includes(after.states.backend.state)
      || after.states.backend.state === "running" && ["starting", "healthy"].includes(after.engineHealth.backend);
    const gatewayOkay = after.states.gateway === null
      || ["created", "clean-stopped"].includes(after.states.gateway.state)
      || after.states.gateway.state === "running" && after.engineHealth.gateway === null;
    return coreStable
      && after.states.mysql.state === "running" && after.engineHealth.mysql === "healthy"
      && backendOkay && gatewayOkay;
  }
  if (operation === "stop") {
    const sameIdentities = sameAcceptedIdentity(before.identities, after.identities);
    const states = [after.states.mysql, after.states.backend, after.states.gateway].filter(Boolean);
    return sameIdentities
      && states.some((state) => state.state === "running")
      && states.every((state) => ["running", "clean-stopped"].includes(state.state));
  }
  return false;
}

function acceptedNetworkClaim(runtime, projection, daemonNetworks, hostRoutes) {
  const expected = projection.expectedResources;
  const allocation = allocateApiOnlyNetwork({
    runtime,
    projectName: expected.project,
    runtimeNonce: expected.runtimeNonce,
    candidates: [expected.networks.internal.subnet],
    daemonNetworks,
    hostRoutes,
    ipamGatewayIp: expected.networks.internal.ipamGatewayIp,
    gatewayServiceIp: expected.networks.internal.gatewayServiceIp,
    issuedAt: "1970-01-01T00:00:00.000Z"
  });
  if (!allocation.reuseExisting
    || allocation.claim.existingNetwork?.id !== expected.networks.internal.id
    || allocation.claim.existingNetwork?.name !== expected.networks.internal.name
    || allocation.claim.socketIdentity !== expected.engine.socketIdentity
    || allocation.claim.daemonIdentity !== expected.engine.daemonIdentity) throw failure("API_ONLY_ACCEPTED_OPERATION_PRECONDITION_FAILED");
  return allocation.claim;
}

function selectedLifecycleOptions(options, names) {
  return Object.fromEntries(names
    .filter((name) => typeof options[name] === "function")
    .map((name) => [name, options[name]]));
}

function acceptedOperationAuthority(projection, validatedInputs) {
  return frozen({
    versionId: projection.pointer.versionId,
    recordSha256: projection.pointer.recordSha256,
    projectName: projection.expectedResources.project,
    runtimeNonce: projection.expectedResources.runtimeNonce,
    inputsSha256: validatedInputs.inputsSha256
  });
}

function validAcceptedOperationAuthority(value, expected) {
  return exactKeys(value, ["versionId", "recordSha256", "projectName", "runtimeNonce", "inputsSha256"])
    && canonicalJson(value) === canonicalJson(expected);
}

function validAcceptedOperationActive(value, authority) {
  if (!(exactKeys(value, ["sequence", "operationId", "operation", "inputSha256", "preIdentitySha256", "preStateSha256", "createdAt"])
    && Number.isSafeInteger(value.sequence) && value.sequence >= 1
    && HASH.test(value.operationId)
    && ACCEPTED_LIFECYCLE_OPERATIONS.has(value.operation) && value.operation !== "status"
    && value.inputSha256 === authority.inputsSha256
    && HASH.test(value.preIdentitySha256)
    && HASH.test(value.preStateSha256)
    && validUtc(value.createdAt))) return false;
  const descriptor = {
    sequence: value.sequence,
    operation: value.operation,
    inputSha256: value.inputSha256,
    preIdentitySha256: value.preIdentitySha256,
    preStateSha256: value.preStateSha256,
    createdAt: value.createdAt
  };
  return value.operationId === sha256(Buffer.concat([
    Buffer.from("shensi.api-only.accepted-operation-id/v1\0", "utf8"),
    Buffer.from(canonicalJson(descriptor), "utf8")
  ]));
}

function validAcceptedOperationSettlement(value, authority) {
  if (value === null) return true;
  const outcomeDisposition = {
    applied: "complete",
    already_satisfied: "complete",
    reconciled_target: "complete",
    no_effect: "retry_safe",
    partial: "retry_safe",
    unsafe: "fail_closed"
  };
  return exactKeys(value, [
    "sequence", "operationId", "operation", "inputSha256", "preIdentitySha256", "preStateSha256", "createdAt",
    "outcome", "disposition", "postIdentitySha256", "postStateSha256", "settledAt"
  ])
    && validAcceptedOperationActive(acceptedOperationIntentFromSettlement(value), authority)
    && Object.hasOwn(outcomeDisposition, value.outcome)
    && value.disposition === outcomeDisposition[value.outcome]
    && HASH.test(value.postIdentitySha256)
    && HASH.test(value.postStateSha256)
    && (!["already_satisfied", "no_effect"].includes(value.outcome)
      || value.postIdentitySha256 === value.preIdentitySha256 && value.postStateSha256 === value.preStateSha256)
    && validUtc(value.settledAt);
}

function acceptedOperationIntentFromSettlement(settlement) {
  return {
    sequence: settlement.sequence,
    operationId: settlement.operationId,
    operation: settlement.operation,
    inputSha256: settlement.inputSha256,
    preIdentitySha256: settlement.preIdentitySha256,
    preStateSha256: settlement.preStateSha256,
    createdAt: settlement.createdAt
  };
}

function validAcceptedOperationState(value, authority) {
  if (!exactKeys(value, ["schema", "version", "authority", "revision", "nextSequence", "active", "settlement"])
    || value.schema !== "shensi.api-only.accepted-operation-state"
    || value.version !== 1
    || !validAcceptedOperationAuthority(value.authority, authority)
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1
    || value.active !== null && !validAcceptedOperationActive(value.active, authority)
    || !validAcceptedOperationSettlement(value.settlement, authority)) return false;
  if (value.active === null && value.settlement === null) return value.revision === 0 && value.nextSequence === 1;
  if (value.active !== null) {
    const expectedRevision = value.active.sequence * 2 - 1;
    return Number.isSafeInteger(expectedRevision)
      && value.revision === expectedRevision
      && value.nextSequence === value.active.sequence + 1
      && (value.settlement === null
        ? value.active.sequence === 1
        : value.settlement.sequence === value.active.sequence - 1);
  }
  const expectedRevision = value.settlement.sequence * 2;
  return Number.isSafeInteger(expectedRevision)
    && value.revision === expectedRevision
    && value.nextSequence === value.settlement.sequence + 1;
}

function acceptedOperationInitialState(authority) {
  return frozen({
    schema: "shensi.api-only.accepted-operation-state",
    version: 1,
    authority,
    revision: 0,
    nextSequence: 1,
    active: null,
    settlement: null
  });
}

function validAcceptedOperationTransition(prior, next, authority) {
  if (!validAcceptedOperationState(next, authority)) return false;
  if (prior === null) return canonicalJson(next) === canonicalJson(acceptedOperationInitialState(authority));
  if (next.revision !== prior.revision + 1
    || canonicalJson(next.authority) !== canonicalJson(prior.authority)
    || next.schema !== prior.schema
    || next.version !== prior.version) return false;
  if (prior.active === null) {
    return next.active !== null
      && next.nextSequence === prior.nextSequence + 1
      && next.active.sequence === prior.nextSequence
      && canonicalJson(next.settlement) === canonicalJson(prior.settlement);
  }
  if (next.active !== null
    || next.nextSequence !== prior.nextSequence
    || next.settlement === null) return false;
  const settledIntent = acceptedOperationIntentFromSettlement(next.settlement);
  return canonicalJson(settledIntent) === canonicalJson(prior.active);
}

function acceptedOperationPaths(runtimeRoot, projection) {
  const directory = join(
    runtimeRoot, "evidence", "accepted-compose-mutations",
    projection.pointer.versionId, projection.pointer.recordSha256
  );
  return {
    components: [
      join(runtimeRoot, "evidence"),
      join(runtimeRoot, "evidence", "accepted-compose-mutations"),
      join(runtimeRoot, "evidence", "accepted-compose-mutations", projection.pointer.versionId),
      directory
    ],
    directory,
    state: join(directory, "state-v1.json"),
    pending: join(directory, ".pending-state-v1.json")
  };
}

async function syncAcceptedOperationDirectory(path, dependencies) {
  const handle = await dependencies.open(path, FS.O_RDONLY | (FS.O_DIRECTORY ?? 0) | (FS.O_NOFOLLOW ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensureAcceptedOperationDirectories(runtimeRoot, paths, uid, dependencies) {
  let parent = runtimeRoot;
  for (const path of paths.components) {
    let created = false;
    try {
      await dependencies.mkdir(path, { mode: 0o700 });
      created = true;
      await dependencies.chmod(path, 0o700);
    } catch (caught) {
      if (caught?.code !== "EEXIST") throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
    }
    try {
      const stat = await dependencies.lstat(path);
      if (!validRuntimeRootStat(stat, uid) || await dependencies.realpath(path) !== path) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
      if (created) await syncAcceptedOperationDirectory(parent, dependencies);
    } catch (caught) {
      if (caught?.message === "API_ONLY_ACCEPTED_OPERATION_STATE_INVALID") throw caught;
      throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
    }
    parent = path;
  }
}

async function readAcceptedOperationStateFile(path, authority, uid, dependencies, allowMissing = false) {
  let before;
  try { before = await dependencies.lstat(path); }
  catch (caught) {
    if (allowMissing && caught?.code === "ENOENT") return null;
    throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
  }
  if (!validPrivateFileStat(before, uid) || before.size < 1 || before.size > MAX_RECORD_BYTES
    || await dependencies.realpath(path) !== path) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
  let handle;
  try { handle = await dependencies.open(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0)); }
  catch { throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID"); }
  try {
    const opened = await descriptorStat(handle);
    if (!validPrivateFileStat(opened, uid) || !statIdentity(before, opened) || opened.size !== before.size) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
    const bytes = await handle.readFile();
    const after = await descriptorStat(handle);
    const pathname = await dependencies.lstat(path);
    if (bytes.length !== before.size || bytes.length > MAX_RECORD_BYTES
      || !validPrivateFileStat(after, uid) || !validPrivateFileStat(pathname, uid)
      || !statIdentity(before, after) || !statIdentity(before, pathname)) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
    let text;
    let value;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.startsWith("\uFEFF") || text.includes("\0")) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
      value = JSON.parse(text);
    } catch { throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID"); }
    if (!validAcceptedOperationState(value, authority) || text !== `${canonicalJson(value)}\n`) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
    return { value: frozen(value), bytes, identity: { dev: before.dev, ino: before.ino, size: before.size } };
  } finally { await handle.close(); }
}

async function removeAcceptedOperationPending(paths, dependencies) {
  try { await dependencies.unlink(paths.pending); }
  catch (caught) { if (caught?.code !== "ENOENT") throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID"); }
  await syncAcceptedOperationDirectory(paths.directory, dependencies);
}

async function recoverAcceptedOperationState(paths, authority, uid, dependencies) {
  let current = await readAcceptedOperationStateFile(paths.state, authority, uid, dependencies, true);
  const pending = await readAcceptedOperationStateFile(paths.pending, authority, uid, dependencies, true);
  if (!pending) return current;
  if (current && pending.bytes.equals(current.bytes)) {
    await removeAcceptedOperationPending(paths, dependencies);
    return current;
  }
  const adoptable = validAcceptedOperationTransition(current?.value ?? null, pending.value, authority);
  if (!adoptable) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
  try { await dependencies.rename(paths.pending, paths.state); }
  catch { throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID"); }
  await syncAcceptedOperationDirectory(paths.directory, dependencies);
  current = await readAcceptedOperationStateFile(paths.state, authority, uid, dependencies);
  if (!current.bytes.equals(pending.bytes)) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_CHANGED");
  return current;
}

async function publishAcceptedOperationState(paths, authority, uid, dependencies, prior, value) {
  if (!validAcceptedOperationTransition(prior?.value ?? null, value, authority)) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
  const visible = await readAcceptedOperationStateFile(paths.state, authority, uid, dependencies, true);
  if (prior === null ? visible !== null : !visible || !visible.bytes.equals(prior.bytes)
    || visible.identity.dev !== prior.identity.dev || visible.identity.ino !== prior.identity.ino) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_CHANGED");
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (bytes.length > MAX_RECORD_BYTES) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
  let handle;
  try { handle = await dependencies.open(paths.pending, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | (FS.O_NOFOLLOW ?? 0), 0o600); }
  catch { throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID"); }
  try {
    await handle.chmod?.(0o600);
    const empty = await descriptorStat(handle);
    if (!validPrivateFileStat(empty, uid) || empty.size !== 0) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await descriptorStat(handle);
    if (!validPrivateFileStat(written, uid) || written.size !== bytes.length) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
  } finally { await handle.close(); }
  const pending = await readAcceptedOperationStateFile(paths.pending, authority, uid, dependencies);
  if (!pending.bytes.equals(bytes)) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_CHANGED");
  const beforeRename = await readAcceptedOperationStateFile(paths.state, authority, uid, dependencies, true);
  if (prior === null ? beforeRename !== null : !beforeRename || !beforeRename.bytes.equals(prior.bytes)
    || beforeRename.identity.dev !== prior.identity.dev || beforeRename.identity.ino !== prior.identity.ino) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_CHANGED");
  try { await dependencies.rename(paths.pending, paths.state); }
  catch { throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_CHANGED"); }
  await syncAcceptedOperationDirectory(paths.directory, dependencies);
  const published = await readAcceptedOperationStateFile(paths.state, authority, uid, dependencies);
  if (!published.bytes.equals(bytes)) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_CHANGED");
  return published;
}

async function loadAcceptedOperationState(runtimeRoot, projection, validatedInputs, uid, dependencies) {
  const paths = acceptedOperationPaths(runtimeRoot, projection);
  const authority = acceptedOperationAuthority(projection, validatedInputs);
  await ensureAcceptedOperationDirectories(runtimeRoot, paths, uid, dependencies);
  let current = await recoverAcceptedOperationState(paths, authority, uid, dependencies);
  if (!current) current = await publishAcceptedOperationState(paths, authority, uid, dependencies, null, acceptedOperationInitialState(authority));
  return { paths, authority, current };
}

function acceptedOperationIntent(state, operation, validatedInputs, observation, createdAt) {
  if (!validUtc(createdAt)) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
  const descriptor = {
    sequence: state.nextSequence,
    operation,
    inputSha256: validatedInputs.inputsSha256,
    preIdentitySha256: observation.identitySha256,
    preStateSha256: observation.stateSha256,
    createdAt
  };
  const operationId = sha256(Buffer.concat([
    Buffer.from("shensi.api-only.accepted-operation-id/v1\0", "utf8"),
    Buffer.from(canonicalJson(descriptor), "utf8")
  ]));
  return frozen({
    sequence: descriptor.sequence,
    operationId,
    operation,
    inputSha256: descriptor.inputSha256,
    preIdentitySha256: descriptor.preIdentitySha256,
    preStateSha256: descriptor.preStateSha256,
    createdAt
  });
}

function acceptedOperationSettlement(active, outcome, disposition, observation, settledAt) {
  if (!validUtc(settledAt)) throw failure("API_ONLY_ACCEPTED_OPERATION_STATE_INVALID");
  return frozen({
    sequence: active.sequence,
    operationId: active.operationId,
    operation: active.operation,
    inputSha256: active.inputSha256,
    preIdentitySha256: active.preIdentitySha256,
    preStateSha256: active.preStateSha256,
    createdAt: active.createdAt,
    outcome,
    disposition,
    postIdentitySha256: observation.identitySha256,
    postStateSha256: observation.stateSha256,
    settledAt
  });
}

async function settleAcceptedOperation(ledger, uid, dependencies, active, outcome, disposition, observation, settledAt) {
  const settlement = acceptedOperationSettlement(active, outcome, disposition, observation, settledAt);
  const value = frozen({
    schema: ledger.current.value.schema,
    version: ledger.current.value.version,
    authority: ledger.current.value.authority,
    revision: ledger.current.value.revision + 1,
    nextSequence: ledger.current.value.nextSequence,
    active: null,
    settlement
  });
  const current = await publishAcceptedOperationState(
    ledger.paths, ledger.authority, uid, dependencies, ledger.current, value
  );
  return { ...ledger, current };
}

export function createApiOnlyAcceptedLifecycleExecutionBridge(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw failure("API_ONLY_ACCEPTED_LIFECYCLE_OPTIONS_INVALID");
  const allowed = new Set([
    "request", "execFile", "lstat", "realpath", "readlink", "access", "open", "mkdir", "chmod", "rename", "unlink",
    "getuid", "spawn", "setTimeout", "clearTimeout", "revalidateExecutable", "probeDaemonIdentity", "monotonicNow", "now"
  ]);
  for (const [name, value] of Object.entries(options)) {
    if (!allowed.has(name) || typeof value !== "function") throw failure("API_ONLY_ACCEPTED_LIFECYCLE_OPTIONS_INVALID");
  }
  const filesystem = {
    lstat: options.lstat ?? nativeFs.lstat,
    realpath: options.realpath ?? nativeFs.realpath,
    open: options.open ?? nativeFs.open
  };
  const operationFilesystem = {
    ...filesystem,
    mkdir: options.mkdir ?? nativeFs.mkdir,
    chmod: options.chmod ?? nativeFs.chmod,
    rename: options.rename ?? nativeFs.rename,
    unlink: options.unlink ?? nativeFs.unlink
  };
  const getuid = options.getuid ?? (() => process.getuid?.() ?? 0);
  const privateInputDependencies = { ...filesystem, getuid };
  return Object.freeze({
    async runAcceptedLifecycleOperation(runtime, projection, observation, validatedInputs, operation) {
      if (!ACCEPTED_LIFECYCLE_OPERATIONS.has(operation)) throw failure("API_ONLY_ACCEPTED_LIFECYCLE_OPERATION_INVALID");
      if (!resolvedRuntimes.has(runtime)) throw failure("COMPOSE_RUNTIME_UNTRUSTED");
      assertApiOnlyAcceptedResourceProjection(projection, "accepted");
      const inspected = acceptedResourceInspections.get(observation);
      const inputs = validatedAcceptedComposeInputs.get(validatedInputs);
      if (!inspected
        || inspected.runtime !== runtime
        || inspected.projection !== projection
        || !inputs
        || inputs.used
        || inputs.runtime !== runtime
        || inputs.projection !== projection
        || inputs.observation !== observation) throw failure("API_ONLY_ACCEPTED_LIFECYCLE_AUTHORITY_REQUIRED");
      inputs.used = true;
      if (operation === "status") {
        let artifacts;
        try {
          let uid;
          try { uid = getuid(); } catch { throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID"); }
          artifacts = await openAcceptedComposeArtifacts(filesystem, uid, projection, inspected);
          const ledger = await loadAcceptedOperationState(
            artifacts.runtimeRoot, projection, validatedInputs, uid, operationFilesystem
          );
          if (ledger.current.value.active !== null) {
            const active = ledger.current.value.active;
            if (!acceptedLifecycleTarget(active.operation, inspected)) {
              throw failure("API_ONLY_ACCEPTED_OPERATION_RECONCILIATION_REQUIRED");
            }
            await settleAcceptedOperation(
              ledger,
              uid,
              operationFilesystem,
              active,
              "reconciled_target",
              "complete",
              observation,
              (options.now ?? (() => new Date().toISOString()))()
            );
          }
          const environment = acceptedComposeProcessEnvironment(runtime, inputs.validatedInput);
          if (canonicalJson(environment) !== canonicalJson(inputs.environment)) throw failure("API_ONLY_ACCEPTED_EXECUTION_REQUIRED");
          const sensitiveValues = [...parseAcceptedBackendEnvironment(artifacts).values()].filter(Boolean);
          const args = acceptedComposeLifecycleArgs(projection, operation);
          const execution = frozen({});
          acceptedLifecycleExecutions.set(execution, {
            runtime,
            args,
            cwd: artifacts.versionRoot,
            runtimeRoot: artifacts.runtimeRoot,
            validatedInput: inputs.validatedInput,
            environment,
            dependencies: privateInputDependencies,
            sensitiveValues,
            mode: "read",
            used: false,
            revalidate: () => revalidateAcceptedComposeArtifacts(filesystem, uid, artifacts)
          });
          let commandResult;
          try {
            commandResult = await runResolvedCompose(runtime, args, {
              acceptedLifecycleExecution: execution,
              cwd: artifacts.versionRoot,
              spawn: options.spawn,
              setTimeout: options.setTimeout,
              clearTimeout: options.clearTimeout,
              revalidateExecutable: options.revalidateExecutable,
              probeDaemonIdentity: options.probeDaemonIdentity,
              monotonicNow: options.monotonicNow
            });
          } catch (caught) {
            if (typeof caught?.message === "string" && caught.message.startsWith("COMPOSE_COMMAND_")) throw failure("API_ONLY_ACCEPTED_STATUS_OUTPUT_INVALID");
            throw caught;
          }
          let services;
          try {
            services = parseAcceptedComposeStatus(commandResult, acceptedLifecycleExecutions.get(execution)?.rawOutput, inspected);
          } finally {
            acceptedLifecycleExecutions.get(execution).rawOutput = null;
          }
          await revalidateAcceptedComposeArtifacts(filesystem, uid, artifacts);
          const inspectionOptions = Object.fromEntries(
            ["request", "lstat", "realpath", "open", "getuid", "setTimeout", "clearTimeout"]
              .filter((name) => typeof options[name] === "function")
              .map((name) => [name, options[name]])
          );
          const postObservation = await createApiOnlyResourceInspectionBridge(inspectionOptions).inspectAcceptedResourceSet(runtime, projection);
          if (postObservation.identitySha256 !== observation.identitySha256
            || postObservation.stateSha256 !== observation.stateSha256) throw failure("API_ONLY_ACCEPTED_STATUS_CHANGED");
          return frozen({ operation, outcome: "observed", services, observation: postObservation });
        } finally {
          if (artifacts) await closeAcceptedComposeArtifacts(artifacts.held);
        }
      }
      let artifacts;
      try {
        let uid;
        try { uid = getuid(); } catch { throw failure("API_ONLY_ACCEPTED_COMPOSE_FILE_INVALID"); }
        artifacts = await openAcceptedComposeArtifacts(filesystem, uid, projection, inspected);
        const environment = acceptedComposeProcessEnvironment(runtime, inputs.validatedInput);
        if (canonicalJson(environment) !== canonicalJson(inputs.environment)) throw failure("API_ONLY_ACCEPTED_EXECUTION_REQUIRED");
        const sensitiveValues = [...parseAcceptedBackendEnvironment(artifacts).values()].filter(Boolean);
        if (!acceptedLifecyclePrecondition(operation, inspected)) throw failure("API_ONLY_ACCEPTED_OPERATION_PRECONDITION_FAILED");

        const networkBridge = createApiOnlyNetworkInspectionBridge(selectedLifecycleOptions(options, [
          "request", "execFile", "lstat", "realpath", "readlink", "access", "setTimeout", "clearTimeout"
        ]));
        const inspectionOptions = selectedLifecycleOptions(options, [
          "request", "lstat", "realpath", "open", "getuid", "setTimeout", "clearTimeout"
        ]);
        const inspectFresh = () => createApiOnlyResourceInspectionBridge(inspectionOptions)
          .inspectAcceptedResourceSet(runtime, projection);
        const authorize = async () => {
          const daemonNetworks = await networkBridge.inspectDaemonNetworks(runtime);
          const hostRoutes = await networkBridge.readHostIpv4Routes();
          const claim = acceptedNetworkClaim(runtime, projection, daemonNetworks, hostRoutes);
          return await revalidateApiOnlyNetworkClaim({
            runtime,
            claim,
            expectedProjectName: projection.expectedResources.project,
            expectedRuntimeNonce: projection.expectedResources.runtimeNonce,
            inspectDaemonNetworks: (selected) => networkBridge.inspectDaemonNetworks(selected),
            readHostIpv4Routes: () => networkBridge.readHostIpv4Routes(),
            monotonicNow: options.monotonicNow
          });
        };

        await authorize();
        const ledger = await loadAcceptedOperationState(
          artifacts.runtimeRoot, projection, validatedInputs, uid, operationFilesystem
        );
        if (ledger.current.value.active !== null) {
          const active = ledger.current.value.active;
          if (!acceptedLifecycleTarget(active.operation, inspected)) throw failure("API_ONLY_ACCEPTED_OPERATION_RECONCILIATION_REQUIRED");
          await settleAcceptedOperation(
            ledger,
            uid,
            operationFilesystem,
            active,
            "reconciled_target",
            "complete",
            observation,
            (options.now ?? (() => new Date().toISOString()))()
          );
          return frozen({ operation: active.operation, outcome: "reconciled_target", observation });
        }
        const latest = ledger.current.value.settlement;
        if (latest?.disposition === "fail_closed") throw failure("API_ONLY_ACCEPTED_OPERATION_FAILED_CLOSED");
        if (latest?.disposition === "retry_safe"
          && (latest.operation !== operation
            || latest.postIdentitySha256 !== observation.identitySha256
            || latest.postStateSha256 !== observation.stateSha256)) throw failure("API_ONLY_ACCEPTED_OPERATION_RECONCILIATION_REQUIRED");
        if (acceptedLifecycleTarget(operation, inspected)) {
          return frozen({ operation, outcome: "already_satisfied", observation });
        }
        const intent = acceptedOperationIntent(
          ledger.current.value,
          operation,
          validatedInputs,
          observation,
          (options.now ?? (() => new Date().toISOString()))()
        );
        const intentState = frozen({
          schema: ledger.current.value.schema,
          version: ledger.current.value.version,
          authority: ledger.current.value.authority,
          revision: ledger.current.value.revision + 1,
          nextSequence: ledger.current.value.nextSequence + 1,
          active: intent,
          settlement: ledger.current.value.settlement
        });
        const publishedIntent = await publishAcceptedOperationState(
          ledger.paths, ledger.authority, uid, operationFilesystem, ledger.current, intentState
        );
        const activeLedger = { ...ledger, current: publishedIntent };
        const authorization = await authorize();
        const preSpawnObservation = await inspectFresh();
        if (preSpawnObservation.identitySha256 !== observation.identitySha256
          || preSpawnObservation.stateSha256 !== observation.stateSha256) {
          throw failure("API_ONLY_ACCEPTED_OPERATION_RECONCILIATION_REQUIRED");
        }
        const mutationEnvironment = composeEnvironmentForNetworkClaim(runtime, authorization, inputs.validatedInput);
        const args = acceptedComposeLifecycleArgs(projection, operation);
        const execution = frozen({});
        acceptedLifecycleExecutions.set(execution, {
          runtime,
          args,
          cwd: artifacts.versionRoot,
          sensitiveValues,
          mode: "mutation",
          used: false,
          revalidate: () => revalidateAcceptedComposeArtifacts(filesystem, uid, artifacts)
        });
        try {
          await runResolvedCompose(runtime, args, {
            acceptedLifecycleExecution: execution,
            networkAuthorization: authorization,
            environment: mutationEnvironment,
            cwd: artifacts.versionRoot,
            spawn: options.spawn,
            setTimeout: options.setTimeout,
            clearTimeout: options.clearTimeout,
            revalidateExecutable: options.revalidateExecutable,
            probeDaemonIdentity: options.probeDaemonIdentity,
            monotonicNow: options.monotonicNow
          });
        } catch (caught) {
          if (typeof caught?.message === "string" && caught.message.startsWith("COMPOSE_COMMAND_INDETERMINATE")) {
            throw failure("API_ONLY_ACCEPTED_OPERATION_FAILED_CLOSED");
          }
          if (typeof caught?.message !== "string" || !caught.message.startsWith("COMPOSE_COMMAND_")) throw caught;
        }
        await revalidateAcceptedComposeArtifacts(filesystem, uid, artifacts);
        let postObservation;
        try {
          postObservation = await inspectFresh();
        } catch {
          throw failure("API_ONLY_ACCEPTED_OPERATION_FAILED_CLOSED");
        }
        const postInspected = acceptedResourceInspections.get(postObservation);
        if (!postInspected) throw failure("API_ONLY_ACCEPTED_OPERATION_FAILED_CLOSED");
        const settledAt = (options.now ?? (() => new Date().toISOString()))();
        if (acceptedLifecycleTarget(operation, postInspected)) {
          await settleAcceptedOperation(
            activeLedger, uid, operationFilesystem, intent, "applied", "complete", postObservation, settledAt
          );
          return frozen({ operation, outcome: "applied", observation: postObservation });
        }
        if (postObservation.identitySha256 === observation.identitySha256
          && postObservation.stateSha256 === observation.stateSha256) {
          await settleAcceptedOperation(
            activeLedger, uid, operationFilesystem, intent, "no_effect", "retry_safe", postObservation, settledAt
          );
          throw failure("API_ONLY_ACCEPTED_OPERATION_RETRY_SAFE");
        }
        if (acceptedLifecycleRetrySafePartial(operation, inspected, postInspected)) {
          await settleAcceptedOperation(
            activeLedger, uid, operationFilesystem, intent, "partial", "retry_safe", postObservation, settledAt
          );
          throw failure("API_ONLY_ACCEPTED_OPERATION_RETRY_SAFE");
        }
        await settleAcceptedOperation(
          activeLedger, uid, operationFilesystem, intent, "unsafe", "fail_closed", postObservation, settledAt
        );
        throw failure("API_ONLY_ACCEPTED_OPERATION_FAILED_CLOSED");
      } finally {
        if (artifacts) await closeAcceptedComposeArtifacts(artifacts.held);
      }
    }
  });
}

export function createApiOnlyNetworkInspectionBridge(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw failure("API_NETWORK_INSPECTION_OPTIONS_INVALID");
  for (const name of ["request", "execFile", "lstat", "realpath", "readlink", "access", "setTimeout", "clearTimeout"]) if (Object.hasOwn(options, name) && typeof options[name] !== "function") throw failure("API_NETWORK_INSPECTION_OPTIONS_INVALID");
  const requestFunction = options.request ?? request;
  const execute = options.execFile ?? execFile;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const readJson = (runtime, path) => readBoundedEngineJson(requestFunction, runtime.socket.canonicalPath, path, setTimer, clearTimer);
  const verifyEngine = async (runtime) => {
    if (!resolvedRuntimes.has(runtime)) throw failure("COMPOSE_RUNTIME_UNTRUSTED");
    const info = await readJson(runtime, "/info");
    if (inspectedDaemonIdentity(info, runtime.socket.canonicalPath) !== runtime.daemon.identity) throw failure("RUNTIME_ENGINE_IDENTITY_MISMATCH");
    return info;
  };
  const inspectClaimNetwork = async (runtime, claim) => {
    const expectedName = `${claim.projectName}_shensi_internal`;
    let network;
    try { network = normalizeInspectionNetwork(await readJson(runtime, `/networks/${encodeURIComponent(expectedName)}`)); }
    catch (error) { if (error?.message === "API_NETWORK_ENGINE_RESPONSE_INVALID") throw error; throw failure("API_NETWORK_POST_CREATE_MISMATCH"); }
    const matches = network.name === expectedName && network.subnets.length === 1 && network.subnets[0].subnet === claim.subnet && network.subnets[0].gateway === claim.ipamGatewayIp && labelsEqual(network.labels, claim.expectedLabels);
    if (!matches || claim.existingNetwork && (network.id !== claim.existingNetwork.id || network.name !== claim.existingNetwork.name)) throw failure("API_NETWORK_POST_CREATE_MISMATCH");
    return network;
  };

  return Object.freeze({
    async inspectDaemonNetworks(runtime) {
      if (!resolvedRuntimes.has(runtime)) throw failure("COMPOSE_RUNTIME_UNTRUSTED");
      const info = await verifyEngine(runtime);
      const networks = normalizeInspectionNetworks(await readJson(runtime, "/networks"));
      if (info.OSType !== "linux" || !["bridge", "host", "none"].every((name) => networks.some((network) => network.name === name))) throw failure("API_NETWORK_INVENTORY_INVALID");
      return networks;
    },

    async readHostIpv4Routes() {
      const uid = process.getuid?.();
      if (!Number.isSafeInteger(uid) || uid < 0) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
      const executable = await resolveSafeExecutable(ROUTE_EXECUTABLE, uid, options);
      if (!executable) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
      let result;
      try {
        result = await execute(executable, ["-rn", "-f", "inet"], {
          env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          shell: false,
          timeout: INSPECTION_TIMEOUT_MS,
          maxBuffer: MAX_ROUTE_INSPECTION_BYTES,
          encoding: "utf8"
        });
      } catch { throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID"); }
      if (!result || typeof result !== "object" || result.truncated === true || result.killed === true || result.signal != null || typeof result.stdout !== "string" || typeof result.stderr !== "string" || result.stderr.length !== 0) throw failure("API_NETWORK_ROUTE_INSPECTION_INVALID");
      return parseHostIpv4Routes(result.stdout);
    },

    async inspectNetwork(runtime, claim) {
      assertInspectionClaim(runtime, claim);
      await verifyEngine(runtime);
      return await inspectClaimNetwork(runtime, claim);
    },

    async inspectGatewayService(runtime, claim) {
      assertInspectionClaim(runtime, claim);
      await verifyEngine(runtime);
      const network = await inspectClaimNetwork(runtime, claim);
      const labels = [`com.docker.compose.project=${claim.projectName}`, "com.docker.compose.service=gateway"];
      const path = `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: labels }))}`;
      const containers = await readJson(runtime, path);
      if (!Array.isArray(containers) || containers.length !== 1) throw failure("API_NETWORK_GATEWAY_INSPECTION_INVALID");
      const container = containers[0];
      const networkName = `${claim.projectName}_shensi_internal`;
      const hostNetworkName = `${claim.projectName}_shensi_host`;
      const attachedNetworks = container?.NetworkSettings?.Networks;
      if (!container || typeof container !== "object" || Array.isArray(container) || !boundedInspectionText(container.Id) || !container.Labels || typeof container.Labels !== "object" || Array.isArray(container.Labels) || container.Labels["com.docker.compose.project"] !== claim.projectName || container.Labels["com.docker.compose.service"] !== "gateway" || !container.NetworkSettings || typeof container.NetworkSettings !== "object" || Array.isArray(container.NetworkSettings) || !attachedNetworks || typeof attachedNetworks !== "object" || Array.isArray(attachedNetworks) || Object.keys(attachedNetworks).length !== 2 || !Object.hasOwn(attachedNetworks, networkName) || !Object.hasOwn(attachedNetworks, hostNetworkName)) throw failure("API_NETWORK_GATEWAY_INSPECTION_INVALID");
      const attachment = container.NetworkSettings.Networks[networkName];
      const hostAttachment = container.NetworkSettings.Networks[hostNetworkName];
      const range = cidr(claim.subnet);
      const address = ipv4Number(attachment?.IPAddress);
      const hostAddress = ipv4Number(hostAttachment?.IPAddress);
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment) || address === null || ipv4Text(address) !== attachment.IPAddress || attachment.IPAddress !== claim.gatewayServiceIp || attachment.IPPrefixLen !== range.prefix || !boundedInspectionText(attachment.NetworkID) || attachment.NetworkID !== network.id
        || !hostAttachment || typeof hostAttachment !== "object" || Array.isArray(hostAttachment) || hostAddress === null || ipv4Text(hostAddress) !== hostAttachment.IPAddress || !Number.isSafeInteger(hostAttachment.IPPrefixLen) || hostAttachment.IPPrefixLen < 1 || hostAttachment.IPPrefixLen > 30 || !HASH.test(hostAttachment.NetworkID ?? "")) throw failure("API_NETWORK_GATEWAY_INSPECTION_INVALID");
      return frozen({ networkName, ipv4Address: attachment.IPAddress });
    }
  });
}

export function allocateApiOnlyNetwork(options = {}) {
  const runtime = options.runtime;
  if (!resolvedRuntimes.has(runtime)) throw failure("COMPOSE_RUNTIME_UNTRUSTED");
  const projectName = options.projectName; const runtimeNonce = options.runtimeNonce ?? options.nonce;
  if (!validProject(projectName) || !NONCE.test(runtimeNonce ?? "")) throw failure("API_NETWORK_OWNERSHIP_REQUIRED");
  const networks = options.daemonNetworks; const routes = options.hostRoutes; validateInventories(networks, routes);
  for (const candidateText of options.candidates ?? []) {
    const range = cidr(candidateText, 1, 30);
    if (!range || range.text !== candidateText) { if (overlaps(cidr(candidateText) ?? { network: 1, end: 0 }, cidr("172.30.0.0/24"))) throw failure("TRIAL_SUBNET_FORBIDDEN"); throw failure("API_NETWORK_SUBNET_INVALID"); }
    if (overlaps(range, cidr("172.30.0.0/24"))) throw failure("TRIAL_SUBNET_FORBIDDEN");
    const ipamGatewayIp = options.ipamGatewayIp ?? ipv4Text(range.network + 1); const gatewayServiceIp = options.gatewayServiceIp ?? ipv4Text(range.end - 1);
    const ipamGateway = ipv4Number(ipamGatewayIp); const gatewayService = ipv4Number(gatewayServiceIp);
    if (ipamGateway === null || ipv4Text(ipamGateway) !== ipamGatewayIp || gatewayService === null || ipv4Text(gatewayService) !== gatewayServiceIp || ipamGateway <= range.network || ipamGateway >= range.end || gatewayService <= range.network || gatewayService >= range.end || ipamGateway === gatewayService) throw failure("API_NETWORK_GATEWAY_INVALID");
    if (apiOnlyHostRouteConflict(range, routes)) continue;
    const labels = expectedLabels(projectName, runtimeNonce, runtime.daemon.identity);
    const matching = []; let conflict = false;
    for (const network of networks) for (const subnet of network.subnets) if (overlaps(range, cidr(subnet.subnet))) {
      if (network.name === `${projectName}_shensi_internal` && cidr(subnet.subnet).text === candidateText && subnet.gateway === ipamGatewayIp && labelsEqual(network.labels, labels)) matching.push(network); else conflict = true;
    }
    if (conflict || matching.length > 1) continue;
    const claim = {
      schema: "shensi.api-network-claim", version: 2, issuedAt: options.issuedAt ?? new Date().toISOString(),
      socketIdentity: runtime.socket.identity, daemonIdentity: runtime.daemon.identity, projectName, networkName: "shensi_internal", runtimeNonce,
      subnet: candidateText, ipamGatewayIp, gatewayServiceIp, expectedLabels: labels,
      existingNetwork: matching.length === 1 ? { id: matching[0].id, name: matching[0].name } : null
    };
    if (!validClaim(claim)) throw failure("API_NETWORK_CLAIM_INVALID");
    return frozen({ subnet: candidateText, ipamGatewayIp, gatewayServiceIp, reuseExisting: matching.length === 1, claim });
  }
  throw failure("API_NETWORK_SUBNET_UNAVAILABLE");
}

export async function revalidateApiOnlyNetworkClaim(input) {
  const { runtime, claim, expectedProjectName, expectedRuntimeNonce, inspectDaemonNetworks, readHostIpv4Routes } = input ?? {};
  if (!resolvedRuntimes.has(runtime)) throw failure("COMPOSE_RUNTIME_UNTRUSTED");
  if (!validClaim(claim)) throw failure("API_NETWORK_CLAIM_INVALID");
  if (claim.socketIdentity !== runtime.socket.identity || claim.daemonIdentity !== runtime.daemon.identity || claim.projectName !== expectedProjectName || claim.runtimeNonce !== expectedRuntimeNonce) throw failure("API_NETWORK_CLAIM_RUNTIME_MISMATCH");
  if (typeof inspectDaemonNetworks !== "function" || typeof readHostIpv4Routes !== "function") throw failure("API_NETWORK_INVENTORY_INVALID");
  const networks = await inspectDaemonNetworks(runtime); const routes = await readHostIpv4Routes(); validateInventories(networks, routes);
  const range = cidr(claim.subnet); if (apiOnlyHostRouteConflict(range, routes)) throw failure("API_NETWORK_CLAIM_CONFLICT");
  const overlapsFound = [];
  for (const network of networks) for (const subnet of network.subnets) if (overlaps(range, cidr(subnet.subnet))) overlapsFound.push(network);
  if (claim.existingNetwork === null) { if (overlapsFound.length !== 0) throw failure("API_NETWORK_CLAIM_CONFLICT"); }
  else if (overlapsFound.length !== 1 || overlapsFound[0].id !== claim.existingNetwork.id || overlapsFound[0].name !== claim.existingNetwork.name || !overlapsFound[0].subnets.some((subnet) => subnet.subnet === claim.subnet && subnet.gateway === claim.ipamGatewayIp) || !labelsEqual(overlapsFound[0].labels, claim.expectedLabels)) throw failure("API_NETWORK_CLAIM_CONFLICT");
  const now = input.monotonicNow ?? (() => performance.now()); const issued = now();
  if (!Number.isFinite(issued)) throw failure("API_NETWORK_AUTHORIZATION_INVALID");
  const claimHash = sha256(canonicalJson(claim));
  const bindingHash = sha256(canonicalJson({ claimHash, socketIdentity: runtime.socket.identity, daemonIdentity: runtime.daemon.identity, networks, routes }));
  const authorization = frozen({ claimHash, bindingHash, expiresAt: issued + 5_000 });
  authorizations.set(authorization, { runtime, claim, bindingHash, expiresAt: issued + 5_000, used: false });
  return authorization;
}

function mutationEnvironment(runtime, claim, validatedInput) {
  const environment = { HOME: runtime.environment.HOME };
  for (const name of SAFE_ENVIRONMENT_NAMES) if (typeof runtime.environment[name] === "string") environment[name] = runtime.environment[name];
  environment.DOCKER_HOST = unixDockerHost(runtime.socket.canonicalPath);
  environment.DOCKER_CONFIG = validatedInput.SHENSI_API_RUNTIME_ROOT;
  for (const name of API_ENVIRONMENT_NAMES) environment[name] = validatedInput[name];
  environment.SHENSI_API_INTERNAL_SUBNET = claim.subnet;
  environment.SHENSI_API_IPAM_GATEWAY = claim.ipamGatewayIp;
  environment.SHENSI_API_GATEWAY_IP = claim.gatewayServiceIp;
  environment.SHENSI_API_RUNTIME_NONCE = claim.runtimeNonce;
  environment.SHENSI_API_DAEMON_IDENTITY = claim.daemonIdentity;
  return environment;
}

export function composeEnvironmentForNetworkClaim(runtime, authorization, validatedInput) {
  const state = authorizations.get(authorization);
  if (!state || state.runtime !== runtime) throw failure("API_NETWORK_AUTHORIZATION_REQUIRED");
  const inputState = validatedComposeInputs.get(validatedInput);
  if (!inputState || inputState.runtime !== runtime) throw failure("API_ONLY_COMPOSE_INPUT_REQUIRED");
  if (validatedInput.SHENSI_API_INTERNAL_SUBNET !== state.claim.subnet || validatedInput.SHENSI_API_IPAM_GATEWAY !== state.claim.ipamGatewayIp || validatedInput.SHENSI_API_GATEWAY_IP !== state.claim.gatewayServiceIp || validatedInput.SHENSI_API_RUNTIME_NONCE !== state.claim.runtimeNonce || validatedInput.SHENSI_API_DAEMON_IDENTITY !== state.claim.daemonIdentity) throw failure("API_NETWORK_ENVIRONMENT_INVALID");
  const environment = frozen(mutationEnvironment(runtime, state.claim, validatedInput));
  if (Object.values(environment).some((value) => typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 4_096)) throw failure("API_NETWORK_ENVIRONMENT_INVALID");
  composeEnvironments.set(environment, { runtime, authorization, validatedInput, inputState });
  return environment;
}

export async function verifyApiOnlyNetworkAfterCreate({ runtime, authorization, inspectNetwork, inspectGatewayService }) {
  const state = authorizations.get(authorization);
  if (!state || state.runtime !== runtime || !state.used || typeof inspectNetwork !== "function" || typeof inspectGatewayService !== "function") throw failure("API_NETWORK_AUTHORIZATION_REQUIRED");
  const network = await inspectNetwork(runtime, state.claim);
  try { validateInventories([network], []); } catch { throw failure("API_NETWORK_POST_CREATE_MISMATCH"); }
  const matches = network.name === `${state.claim.projectName}_shensi_internal` && network.subnets.length === 1 && network.subnets[0].subnet === state.claim.subnet && network.subnets[0].gateway === state.claim.ipamGatewayIp && labelsEqual(network.labels, state.claim.expectedLabels);
  if (!matches || state.claim.existingNetwork && (network.id !== state.claim.existingNetwork.id || network.name !== state.claim.existingNetwork.name)) throw failure("API_NETWORK_POST_CREATE_MISMATCH");
  const gatewayService = await inspectGatewayService(runtime, state.claim);
  if (!exactKeys(gatewayService, ["networkName", "ipv4Address"]) || gatewayService.networkName !== network.name || gatewayService.ipv4Address !== state.claim.gatewayServiceIp) throw failure("API_NETWORK_POST_CREATE_MISMATCH");
  return frozen({ id: network.id, name: network.name });
}

function validRuntimeRootStat(stat, uid) { return stat?.isDirectory?.() && !stat.isSymbolicLink?.() && stat.uid === uid && (stat.mode & 0o777) === 0o700; }
function validPrivateFileStat(stat, uid) { return stat?.isFile?.() && !stat.isSymbolicLink?.() && stat.uid === uid && (stat.mode & 0o777) === 0o600 && stat.nlink === 1; }
async function validateRuntimeRoot(runtimeRoot, dependencies = {}) {
  const uid = (dependencies.getuid ?? (() => process.getuid?.()))();
  if (!isAbsolute(runtimeRoot) || resolve(runtimeRoot) !== runtimeRoot || runtimeRoot.includes("\0")) throw failure("RUNTIME_SELECTION_ROOT_INVALID");
  try {
    await walkNoFollow(runtimeRoot, uid, dependencies, { final: (stat) => validRuntimeRootStat(stat, uid) });
    if (await io(dependencies).realpath(runtimeRoot) !== runtimeRoot) throw failure("RUNTIME_SELECTION_ROOT_INVALID");
  } catch { throw failure("RUNTIME_SELECTION_ROOT_INVALID"); }
  return uid;
}
export function runtimeSelectionPath(runtimeRoot) { if (!isAbsolute(runtimeRoot)) throw failure("RUNTIME_SELECTION_ROOT_INVALID"); return join(runtimeRoot, RECORD_NAME); }

function runtimeRecord(runtime, ownership, createdAt) {
  const record = {
    schema: "shensi.container-runtime-selection", version: 1, createdAt,
    runtime: {
      socket: { canonicalPath: runtime.socket.canonicalPath, identity: runtime.socket.identity, provider: runtime.socket.provider, profile: runtime.socket.profile },
      daemon: { identity: runtime.daemon.identity },
      compose: { kind: runtime.compose.kind, version: runtime.compose.version, argvPrefix: [...runtime.argvPrefix] }
    },
    ownership: { projectName: ownership?.projectName, networkClaim: ownership?.networkClaim }
  };
  if (!validRecord(record)) throw failure("RUNTIME_SELECTION_RECORD_INVALID");
  return frozen(record);
}

function validRecord(record) {
  if (!exactKeys(record, ["schema", "version", "createdAt", "runtime", "ownership"]) || record.schema !== "shensi.container-runtime-selection" || record.version !== 1 || !validUtc(record.createdAt) || !exactKeys(record.runtime, ["socket", "daemon", "compose"]) || !exactKeys(record.runtime.socket, ["canonicalPath", "identity", "provider", "profile"]) || !isAbsolute(record.runtime.socket.canonicalPath) || resolve(record.runtime.socket.canonicalPath) !== record.runtime.socket.canonicalPath || record.runtime.socket.canonicalPath.includes("\0") || Buffer.byteLength(record.runtime.socket.canonicalPath) > 4096 || record.runtime.socket.identity !== sha256(record.runtime.socket.canonicalPath) || !["docker-desktop", "colima", "system-local", "explicit"].includes(record.runtime.socket.provider) || typeof record.runtime.socket.profile !== "string" || !PROFILE.test(record.runtime.socket.profile) || !exactKeys(record.runtime.daemon, ["identity"]) || !HASH.test(record.runtime.daemon.identity) || !exactKeys(record.runtime.compose, ["kind", "version", "argvPrefix"]) || !["docker-compose-plugin", "standalone"].includes(record.runtime.compose.kind) || typeof record.runtime.compose.version !== "string" || !record.runtime.compose.version || record.runtime.compose.version.includes("\0") || Buffer.byteLength(record.runtime.compose.version) > 256 || !Array.isArray(record.runtime.compose.argvPrefix) || !exactKeys(record.ownership, ["projectName", "networkClaim"]) || !validProject(record.ownership.projectName) || !validClaim(record.ownership.networkClaim)) return false;
  if (record.ownership.networkClaim.socketIdentity !== record.runtime.socket.identity || record.ownership.networkClaim.daemonIdentity !== record.runtime.daemon.identity || record.ownership.networkClaim.projectName !== record.ownership.projectName) return false;
  const prefix = record.runtime.compose.argvPrefix;
  if (prefix.some((value) => typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > 4_096)) return false;
  const executable = prefix[0];
  if (!isAbsolute(executable) || resolve(executable) !== executable) return false;
  return record.runtime.compose.kind === "docker-compose-plugin" ? prefix.length === 2 && prefix[1] === "compose" : prefix.length === 1;
}

async function readRecord(runtimeRoot, dependencies = {}) {
  const uid = await validateRuntimeRoot(runtimeRoot, dependencies); const fs = io(dependencies); const path = runtimeSelectionPath(runtimeRoot); let handle;
  try { handle = await fs.open(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0)); } catch { throw failure("RUNTIME_SELECTION_RECORD_INVALID"); }
  try {
    const before = await descriptorStat(handle);
    if (!validPrivateFileStat(before, uid) || before.size < 1 || before.size > MAX_RECORD_BYTES) throw failure("RUNTIME_SELECTION_RECORD_INVALID");
    const bytes = await handle.readFile(); const after = await descriptorStat(handle); const pathStat = await fs.lstat(path);
    if (bytes.length !== before.size || !validPrivateFileStat(after, uid) || after.size !== bytes.length || !validPrivateFileStat(pathStat, uid) || pathStat.size !== bytes.length || !statIdentity(before, after) || !statIdentity(before, pathStat)) throw failure("RUNTIME_SELECTION_RECORD_INVALID");
    const text = bytes.toString("utf8"); let record;
    try { record = JSON.parse(text); } catch { throw failure("RUNTIME_SELECTION_RECORD_INVALID"); }
    if (!validRecord(record) || text !== `${canonicalJson(record)}\n`) throw failure("RUNTIME_SELECTION_RECORD_INVALID");
    return frozen(record);
  } finally { await handle.close(); }
}

export async function writeRuntimeSelection(runtimeRoot, runtime, ownership, options = {}) {
  if (!resolvedRuntimes.has(runtime)) throw failure("COMPOSE_RUNTIME_UNTRUSTED");
  const uid = await validateRuntimeRoot(runtimeRoot, options); const fs = io(options); const path = runtimeSelectionPath(runtimeRoot);
  try { const existing = await fs.lstat(path); if (!validPrivateFileStat(existing, uid)) throw failure("RUNTIME_SELECTION_RECORD_INVALID"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const record = runtimeRecord(runtime, ownership, options.createdAt ?? new Date().toISOString()); const bytes = Buffer.from(`${canonicalJson(record)}\n`);
  const temporary = join(runtimeRoot, `.${RECORD_NAME}.${randomBytes(16).toString("hex")}.tmp`);
  const handle = await fs.open(temporary, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | (FS.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.chmod?.(0o600); const before = await descriptorStat(handle); if (!validPrivateFileStat(before, uid) || before.size !== 0) throw failure("RUNTIME_SELECTION_TEMP_INVALID");
    await handle.writeFile(bytes); await handle.sync(); const after = await descriptorStat(handle); if (!validPrivateFileStat(after, uid) || after.size !== bytes.length) throw failure("RUNTIME_SELECTION_TEMP_INVALID");
  } finally { await handle.close(); }
  await options.beforeRename?.(); await validateRuntimeRoot(runtimeRoot, options); await fs.rename(temporary, path); await options.afterRename?.();
  const directory = await fs.open(runtimeRoot, FS.O_RDONLY | (FS.O_DIRECTORY ?? 0) | (FS.O_NOFOLLOW ?? 0));
  try { await directory.sync(); } finally { await directory.close(); }
  const validated = await readRecord(runtimeRoot, options);
  return validated;
}

export async function assertRuntimeSelection(runtimeRoot, runtime, expectedOwnership, options = {}) {
  if (!resolvedRuntimes.has(runtime)) throw failure("COMPOSE_RUNTIME_UNTRUSTED");
  const record = await readRecord(runtimeRoot, options);
  if (record.runtime.socket.canonicalPath !== runtime.socket.canonicalPath || record.runtime.socket.identity !== runtime.socket.identity || record.runtime.daemon.identity !== runtime.daemon.identity) throw failure("RUNTIME_ENGINE_IDENTITY_MISMATCH");
  if (record.ownership.projectName !== expectedOwnership?.projectName || record.ownership.networkClaim.runtimeNonce !== expectedOwnership?.runtimeNonce) throw failure("RUNTIME_SELECTION_OWNERSHIP_MISMATCH");
  const toolchainChanged = canonicalJson(record.runtime.compose) !== canonicalJson({ kind: runtime.compose.kind, version: runtime.compose.version, argvPrefix: [...runtime.argvPrefix] });
  return frozen({ record, toolchainChanged });
}

async function privatePathUnderRoot(path, root, dependencies = {}) {
  const uid = await validateRuntimeRoot(root, dependencies); const fs = io(dependencies);
  if (!isAbsolute(path) || resolve(path) !== path || relative(root, path).startsWith(`..${sep}`) || relative(root, path) === "..") return false;
  try { await walkNoFollow(path, uid, dependencies, { final: (stat) => validPrivateFileStat(stat, uid) }); return await fs.realpath(path) === path; } catch { return false; }
}

export async function validateApiOnlyComposeInputs(runtime, environment, runtimeRoot, dependencies = {}) {
  if (!resolvedRuntimes.has(runtime)) throw failure("COMPOSE_RUNTIME_UNTRUSTED");
  if (!sameKeySet(environment, API_ENVIRONMENT_NAMES) || Object.values(environment).some((value) => typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 4_096) || environment.SHENSI_API_RUNTIME_ROOT !== runtimeRoot) throw failure("API_ONLY_COMPOSE_INPUT_INVALID");
  try { await validateRuntimeRoot(runtimeRoot, dependencies); } catch { throw failure("API_ONLY_RUNTIME_ROOT_INVALID"); }
  for (const name of PRIVATE_API_FILES) if (!isAbsolute(environment[name] ?? "")) throw failure(`API_ONLY_PRIVATE_PATH_REQUIRED:${name}`);
  for (const name of PRIVATE_API_FILES) if (!await privatePathUnderRoot(environment[name], runtimeRoot, dependencies)) throw failure("API_ONLY_PRIVATE_FILE_INVALID");
  const range = cidr(environment.SHENSI_API_INTERNAL_SUBNET); const ipamGateway = ipv4Number(environment.SHENSI_API_IPAM_GATEWAY); const gatewayService = ipv4Number(environment.SHENSI_API_GATEWAY_IP);
  if (!range || range.text !== environment.SHENSI_API_INTERNAL_SUBNET || ipamGateway === null || ipv4Text(ipamGateway) !== environment.SHENSI_API_IPAM_GATEWAY || gatewayService === null || ipv4Text(gatewayService) !== environment.SHENSI_API_GATEWAY_IP || ipamGateway <= range.network || ipamGateway >= range.end || gatewayService <= range.network || gatewayService >= range.end || ipamGateway === gatewayService) throw failure("API_NETWORK_GATEWAY_INVALID");
  for (const name of ["SHENSI_API_HTTP_PORT", "SHENSI_API_MYSQL_HOST_PORT"]) if (!/^[1-9]\d{0,4}$/u.test(environment[name]) || Number(environment[name]) > 65_535) throw failure("API_ONLY_COMPOSE_INPUT_INVALID");
  if (!NONCE.test(environment.SHENSI_API_RUNTIME_NONCE ?? "") || environment.SHENSI_API_DAEMON_IDENTITY !== runtime.daemon.identity) throw failure("API_NETWORK_OWNERSHIP_REQUIRED");
  const validated = frozen({ ...environment });
  validatedComposeInputs.set(validated, { runtime, runtimeRoot, dependencies });
  return validated;
}

export function doctorSummary(runtime) {
  if (!resolvedRuntimes.has(runtime)) throw failure("COMPOSE_RUNTIME_INVALID");
  return `API_ONLY_DOCTOR compose=${runtime.compose.kind}@${runtime.compose.version} socket=${basename(runtime.socket.canonicalPath)} profile=${runtime.socket.provider}:${runtime.socket.profile} engine=${runtime.daemon.identity}`;
}

async function main() {
  const [command, separator, ...rest] = process.argv.slice(2);
  if (command === "compose") {
    if (separator !== "--") throw failure("CONTAINER_RUNTIME_COMMAND_INVALID");
    assertRenderOnlyComposeArgs(rest);
  } else if (command !== "doctor" || separator !== undefined) throw failure("CONTAINER_RUNTIME_COMMAND_INVALID");
  const runtime = await discoverComposeRuntime();
  if (command === "doctor") { console.log(doctorSummary(runtime)); return; }
  const inputs = Object.fromEntries(API_ENVIRONMENT_NAMES.map((name) => [name, runtime.environment[name]]));
  await validateApiOnlyComposeInputs(runtime, inputs, runtime.environment.SHENSI_API_RUNTIME_ROOT);
  await runResolvedCompose(runtime, rest, { cwd: process.cwd() });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(redact(error?.message)); process.exitCode = 1; });
