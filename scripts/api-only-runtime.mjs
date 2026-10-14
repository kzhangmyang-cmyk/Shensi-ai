import { createHash, randomBytes as nativeRandomBytes } from "node:crypto";
import { execFile as nativeExecFile } from "node:child_process";
import { constants as FS } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { request as nativeHttpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { basename, dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  allocateApiOnlyNetwork,
  assertRuntimeSelection,
  composeEnvironmentForNetworkClaim,
  createApiOnlyAcceptedComposeValidationBridge,
  createApiOnlyAcceptedLifecycleExecutionBridge,
  createApiOnlyNetworkInspectionBridge,
  createApiOnlyResourceInspectionBridge,
  discoverComposeRuntime,
  revalidateApiOnlyNetworkClaim,
  runResolvedCompose,
  validateApiOnlyComposeInputs,
  verifyApiOnlyNetworkAfterCreate,
  writeRuntimeSelection
} from "./container-runtime.mjs";
import { createApiOnlyAuthorityResolver } from "./lib/api-only-authority.mjs";
import { createSourceContentManifest } from "./source-content-manifest.mjs";

export const API_ONLY_PORTS = Object.freeze({ gateway: 5608, mysql: 3311, emptyGateway: 5628, emptyMysql: 3312 });
export function createDisposableApiOnlyIdentity(randomBytes = nativeRandomBytes) {
  if (typeof randomBytes !== "function") throw error("API_ONLY_DISPOSABLE_IDENTITY_INVALID");
  let entropy;
  try { entropy = randomBytes(6); } catch { throw error("API_ONLY_DISPOSABLE_IDENTITY_INVALID"); }
  if (!(Buffer.isBuffer(entropy) || entropy instanceof Uint8Array) || entropy.byteLength !== 6) {
    throw error("API_ONLY_DISPOSABLE_IDENTITY_INVALID");
  }
  const suffix = Buffer.from(entropy).toString("hex");
  if (!/^[a-f0-9]{12}$/u.test(suffix)) throw error("API_ONLY_DISPOSABLE_IDENTITY_INVALID");
  return Object.freeze({
    suffix,
    project: `shensi-api-empty-${suffix}`,
    runtimeRelativeRoot: `.runtime/api-only-empty/${suffix}`,
    ports: Object.freeze({ gateway: API_ONLY_PORTS.emptyGateway, mysql: API_ONLY_PORTS.emptyMysql }),
    account: `api_smoke_${suffix}`
  });
}
export const API_ONLY_CRYPTO_SECRET_BINDINGS = Object.freeze({
  JWT_SECRET: "jwt_secret",
  PROVIDER_CREDENTIAL_KEY: "provider_credential_key",
  AGENT_JOB_ENCRYPTION_KEY: "agent_job_encryption_key",
  ACQUISITION_MASTER_SECRET: "acquisition_master_secret",
  ACQUISITION_V1_CURSOR_SECRET: "acquisition_v1_cursor_secret",
  TRADE_OBSERVATION_CURSOR_SECRET: "trade_observation_cursor_secret",
  MARKET_OPPORTUNITY_CURSOR_SECRET: "market_opportunity_cursor_secret",
  PROSPECT_RUN_IDEMPOTENCY_SECRET: "prospect_run_idempotency_secret",
  PROSPECT_RUN_CURSOR_SECRET: "prospect_run_cursor_secret",
  PROSPECT_EXECUTION_CLAIM_SECRET: "prospect_execution_claim_secret",
  ORGANIZATION_IDENTITY_MASTER_SECRET: "organization_identity_master_secret",
  PROSPECT_SOURCE_RAW_ENVELOPE_SECRET: "prospect_source_raw_envelope_secret",
  PROSPECT_COVERAGE_MASTER_SECRET: "prospect_coverage_master_secret"
});

const smokeShape = (required = [], arrays = [], numbers = []) => Object.freeze({
  type: "object",
  required: Object.freeze([...required]),
  arrays: Object.freeze([...arrays]),
  numbers: Object.freeze([...numbers])
});
const smokeRoute = (module, path, required = [], arrays = [], numbers = []) => Object.freeze({
  module,
  method: "GET",
  path,
  shape: smokeShape(required, arrays, numbers),
  realPlatformWrite: false
});

export const API_ONLY_SMOKE_ROUTES = Object.freeze([
  smokeRoute("auth", "/api/auth/me", ["user"]),
  smokeRoute("dashboard", "/api/dashboard/summary", ["scope", "metrics"]),
  smokeRoute("agents", "/api/v1/business-advisor/agents", ["items"], ["items"]),
  smokeRoute("growth bootstrap", "/api/v1/growth/bootstrap", ["status", "workspaceId", "features"], ["features"]),
  smokeRoute("acquisition", "/api/v1/acquisition/overview?platform=douyin", ["generatedAt", "tasks"]),
  smokeRoute("conversations/account", "/api/v1/acquisition/social-accounts/douyin", ["items"], ["items"]),
  smokeRoute("private domain", "/api/customers?scope=mine", ["customers"], ["customers"]),
  smokeRoute("private-domain todos", "/api/todos", ["todos"], ["todos"]),
  smokeRoute("conversion", "/api/deals", ["deals", "events"], ["deals", "events"]),
  smokeRoute("scripts/knowledge", "/api/knowledge/assets", ["assets"], ["assets"]),
  smokeRoute("trade marketing", "/api/prospect-campaigns?includeArchived=false", ["campaigns", "total"], ["campaigns"], ["total"]),
  smokeRoute("settings", "/api/profile", ["user"]),
  smokeRoute("search connections", "/api/v1/acquisition/provider-connections", ["items", "nextCursor"], ["items"]),
  smokeRoute("AI connections", "/api/v1/ai/connections", ["items", "nextCursor"], ["items"]),
  smokeRoute("advisor", "/api/v1/acquisition/advisor/today?currency=CNY&asOf=<clock ISO>"),
  smokeRoute("catalog", "/api/v1/catalog/items?limit=1", ["items"], ["items"]),
  smokeRoute("quotes", "/api/v1/quotes/cases?limit=1", ["items"], ["items"]),
  smokeRoute("finance costs", "/api/v1/acquisition/cost-entries?limit=1", ["items"], ["items"]),
  smokeRoute("finance facts", "/api/v1/finance/facts?limit=1", ["items"], ["items"]),
  smokeRoute("ROI", "/api/v1/acquisition/cohorts?limit=1", ["items"], ["items"]),
  smokeRoute("financial council", "/api/v1/finance/council-policy", ["policyVersionId", "revision"])
]);

const COMMANDS = new Set(["prepare", "db-start", "start", "stop", "status", "verify", "verify-empty", "migration-preflight", "migration-run", "cutover", "rollback", "accept-prepare", "accept", "accept-resume", "active-project"]);
const PROJECT = /^shensi-api(?:-[a-z0-9-]+)?$/u;
const DISPOSABLE_PROJECT = /^shensi-api-empty-([a-f0-9]{12})$/u;
const HASH = /^[a-f0-9]{64}$/u;
const IMAGE_ID_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const LOCK_NONCE = /^[a-f0-9]{32}$/u;
const PRIVATE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_PRIVATE_JSON_BYTES = 1_048_576;
const MAX_SECRET_BYTES = 65_536;
const DEFAULT_MYSQL_HEALTH_TIMEOUT_MS = 60_000;
const MIN_MYSQL_HEALTH_TIMEOUT_MS = 100;
const MAX_MYSQL_HEALTH_TIMEOUT_MS = 300_000;
const MAX_HTTP_HEALTH_BYTES = 8_192;
const MAX_STATUS_OUTPUT_BYTES = 65_536;
const MAX_DISPOSABLE_ENGINE_BYTES = 1_048_576;
const DISPOSABLE_ENGINE_TIMEOUT_MS = 3_000;
const DISPOSABLE_PORT_TIMEOUT_MS = 3_000;
const LOCK_NAME = "owner.lock";
const DISPOSABLE_LOCK_NAME = "disposable-5628-3312";
const API_ONLY_NETWORK_CANDIDATES = Object.freeze([
  ...Array.from({ length: 6 }, (_, index) => `198.18.${250 + index}.0/24`),
  ...Array.from({ length: 10 }, (_, index) => `198.18.${240 + index}.0/24`)
]);
const error = (code) => new Error(code);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value)}\n`;
const authorityResolver = createApiOnlyAuthorityResolver();
const execFile = promisify(nativeExecFile);

const API_ONLY_SMOKE_REQUEST_TIMEOUT_MS = 10_000;
const API_ONLY_SMOKE_SUITE_TIMEOUT_MS = 90_000;
const API_ONLY_SMOKE_MAX_RESPONSE_BYTES = 1_048_576;
const API_ONLY_SMOKE_PORTS = new Set([String(API_ONLY_PORTS.gateway), String(API_ONLY_PORTS.emptyGateway)]);

function apiOnlySmokeOrigin(value) {
  if (typeof value !== "string" || value.length > 128 || value.includes("\0")) {
    throw error("API_ONLY_SMOKE_ORIGIN_INVALID");
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw error("API_ONLY_SMOKE_ORIGIN_INVALID"); }
  if (parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || !API_ONLY_SMOKE_PORTS.has(parsed.port)
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.origin !== value) throw error("API_ONLY_SMOKE_ORIGIN_INVALID");
  return parsed.origin;
}

function smokeFetchImplementation(options) {
  const value = options.fetchImpl ?? globalThis.fetch;
  if (typeof value !== "function") throw error("API_ONLY_SMOKE_FETCH_INVALID");
  return value;
}

function smokeTimers(options) {
  const set = options.setTimeoutImpl ?? globalThis.setTimeout;
  const clear = options.clearTimeoutImpl ?? globalThis.clearTimeout;
  if (typeof set !== "function" || typeof clear !== "function") {
    throw error("API_ONLY_SMOKE_TIMER_INVALID");
  }
  return Object.freeze({ set, clear });
}

function startSmokeDeadline(milliseconds, timers, parentSignal = null) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let closed = false;
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener?.("abort", abort, { once: true });
  const timeout = timers.set(abort, milliseconds);
  timeout?.unref?.();
  return Object.freeze({
    signal: controller.signal,
    close() {
      if (closed) return;
      closed = true;
      timers.clear(timeout);
      parentSignal?.removeEventListener?.("abort", abort);
    }
  });
}

function smokeResponseUrlIsAllowed(response, origin) {
  if (response?.redirected === true) return false;
  if (typeof response?.url !== "string" || response.url === "") return true;
  try { return new URL(response.url).origin === origin; } catch { return false; }
}

async function issueSmokeRequest({
  origin,
  path,
  module,
  fetchImpl,
  init,
  parentSignal = null,
  timers,
  failurePrefix = "API_ONLY_SMOKE_FAILED"
}) {
  const deadline = startSmokeDeadline(API_ONLY_SMOKE_REQUEST_TIMEOUT_MS, timers, parentSignal);
  let response;
  try {
    response = await fetchImpl(`${origin}${path}`, {
      ...init,
      redirect: "manual",
      signal: deadline.signal
    });
  } catch {
    deadline.close();
    throw error(`${failurePrefix}:${module}:${path}:0`);
  }
  const status = Number(response?.status);
  if (!Number.isSafeInteger(status) || status < 0 || status > 599
    || !smokeResponseUrlIsAllowed(response, origin)) {
    deadline.close();
    throw error(`${failurePrefix}:${module}:${path}:${Number.isSafeInteger(status) ? status : 0}`);
  }
  return Object.freeze({ response, close: deadline.close });
}

async function readSmokeText(response, module, path, status, prefix) {
  let text;
  try { text = await response.text(); } catch {
    throw error(`${prefix}:${module}:${path}:${status}`);
  }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > API_ONLY_SMOKE_MAX_RESPONSE_BYTES) {
    throw error(`${prefix}:${module}:${path}:${status}`);
  }
  return text;
}

async function readSmokeJson(response, module, path, status) {
  const invalid = "API_ONLY_SMOKE_INVALID_RESPONSE";
  const contentType = response?.headers?.get?.("content-type");
  if (typeof contentType !== "string" || !/^application\/json(?:;|$)/iu.test(contentType.trim())) {
    throw error(`${invalid}:${module}:${path}:${status}`);
  }
  const text = await readSmokeText(response, module, path, status, invalid);
  let body;
  try { body = JSON.parse(text); } catch { throw error(`${invalid}:${module}:${path}:${status}`); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw error(`${invalid}:${module}:${path}:${status}`);
  }
  return body;
}

function validSmokeSecret(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 16_384
    && !value.includes("\0");
}

function validateSmokeSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !validSmokeSecret(value.bearerToken)
    || !validSmokeSecret(value.csrfToken)
    || !value.user || typeof value.user !== "object" || Array.isArray(value.user)
    || typeof value.activeWorkspace !== "string"
    || !value.activeWorkspace.trim()
    || value.activeWorkspace === "all"
    || value.activeWorkspace.length > 512
    || value.activeWorkspace.includes("\0")) throw error("API_ONLY_SMOKE_SESSION_INVALID");
  return value;
}

export async function authenticateApiOnlySmoke(options = {}) {
  const origin = apiOnlySmokeOrigin(options.origin);
  if (options.mode !== "register" && options.mode !== "login") {
    throw error("API_ONLY_SMOKE_AUTH_MODE_INVALID");
  }
  const password = options.password;
  const identityName = options.mode === "register" ? "account" : "email";
  const identity = options[identityName];
  if (!validSmokeSecret(password)
    || typeof identity !== "string"
    || !identity.trim()
    || identity.length > 512
    || identity.includes("\0")) throw error("API_ONLY_SMOKE_AUTH_INPUT_INVALID");
  const path = options.mode === "register" ? "/api/auth/register" : "/api/auth/login";
  const expectedStatus = options.mode === "register" ? 201 : 200;
  const fetchImpl = smokeFetchImplementation(options);
  const timers = smokeTimers(options);
  const pending = await issueSmokeRequest({
    origin,
    path,
    module: "auth",
    fetchImpl,
    timers,
    parentSignal: options.parentSignal ?? null,
    init: {
      method: "POST",
      headers: Object.freeze({ Accept: "application/json", "Content-Type": "application/json" }),
      body: JSON.stringify({ [identityName]: identity, password })
    }
  });
  try {
    const { response } = pending;
    if (response.status !== expectedStatus) {
      throw error(`API_ONLY_SMOKE_FAILED:auth:${path}:${response.status}`);
    }
    const body = await readSmokeJson(response, "auth", path, response.status);
    const activeWorkspace = body.user?.teamId;
    if (!validSmokeSecret(body.token)
      || !validSmokeSecret(body.csrfToken)
      || !body.user || typeof body.user !== "object" || Array.isArray(body.user)
      || typeof activeWorkspace !== "string"
      || !activeWorkspace.trim()
      || activeWorkspace === "all"
      || activeWorkspace.length > 512) {
      throw error(`API_ONLY_SMOKE_INVALID_RESPONSE:auth:${path}:${response.status}`);
    }
    return Object.freeze({
      bearerToken: body.token,
      csrfToken: body.csrfToken,
      user: Object.freeze(body.user),
      activeWorkspace
    });
  } finally { pending.close(); }
}

function pathForSmokeRoute(route, clock) {
  if (route.module !== "advisor") return route.path;
  let value;
  try { value = clock(); } catch { throw error("API_ONLY_SMOKE_CLOCK_INVALID"); }
  let date;
  try { date = value instanceof Date ? value : new Date(value); } catch {
    throw error("API_ONLY_SMOKE_CLOCK_INVALID");
  }
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw error("API_ONLY_SMOKE_CLOCK_INVALID");
  }
  return route.path.replace("<clock ISO>", encodeURIComponent(date.toISOString()));
}

function assertSmokeShape(route, body, path, status) {
  const invalid = () => { throw error(`API_ONLY_SMOKE_INVALID_RESPONSE:${route.module}:${path}:${status}`); };
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid();
  if (route.shape.required.some((key) => !Object.hasOwn(body, key))) invalid();
  if (route.shape.arrays.some((key) => !Array.isArray(body[key]))) invalid();
  if (route.shape.numbers.some((key) => typeof body[key] !== "number" || !Number.isFinite(body[key]))) invalid();
}

async function requestSmokeRoute(route, context) {
  const path = pathForSmokeRoute(route, context.clock);
  const pending = await issueSmokeRequest({
    origin: context.origin,
    path,
    module: route.module,
    fetchImpl: context.fetchImpl,
    parentSignal: context.signal,
    timers: context.timers,
    init: {
      method: "GET",
      headers: Object.freeze({
        Accept: "application/json",
        Authorization: `Bearer ${context.session.bearerToken}`,
        "X-Workspace-Id": context.workspaceId
      })
    }
  });
  try {
    const { response } = pending;
    if (response.status !== 200) {
      throw error(`API_ONLY_SMOKE_FAILED:${route.module}:${path}:${response.status}`);
    }
    const body = await readSmokeJson(response, route.module, path, response.status);
    assertSmokeShape(route, body, path, response.status);
    return Object.freeze({
      report: Object.freeze({
        module: route.module,
        method: route.method,
        path,
        status: response.status,
        shape: route.shape
      }),
      body
    });
  } finally { pending.close(); }
}

export async function runApiOnlyModuleSmoke(options = {}) {
  const origin = apiOnlySmokeOrigin(options.origin);
  const fetchImpl = smokeFetchImplementation(options);
  const timers = smokeTimers(options);
  const clock = options.clock ?? (() => new Date());
  if (typeof clock !== "function") throw error("API_ONLY_SMOKE_CLOCK_INVALID");
  const suite = startSmokeDeadline(API_ONLY_SMOKE_SUITE_TIMEOUT_MS, timers);
  try {
    const session = validateSmokeSession(options.session ?? await authenticateApiOnlySmoke({
      ...options,
      origin,
      fetchImpl,
      parentSignal: suite.signal
    }));
    const bootstrapRoute = API_ONLY_SMOKE_ROUTES.find(({ module }) => module === "growth bootstrap");
    if (!bootstrapRoute) throw error("API_ONLY_SMOKE_MANIFEST_INVALID");
    const bootstrap = await requestSmokeRoute(bootstrapRoute, {
      origin, fetchImpl, timers, signal: suite.signal, session, clock,
      workspaceId: session.activeWorkspace
    });
    const workspaceId = bootstrap.body.workspaceId;
    if (bootstrap.body.status !== "ready"
      || typeof workspaceId !== "string"
      || !workspaceId.trim()
      || workspaceId === "all"
      || workspaceId.length > 512
      || workspaceId.includes("\0")) {
      throw error(`API_ONLY_SMOKE_INVALID_RESPONSE:growth bootstrap:${bootstrapRoute.path}:200`);
    }
    const reports = [];
    for (const route of API_ONLY_SMOKE_ROUTES) {
      if (suite.signal.aborted) throw error(`API_ONLY_SMOKE_FAILED:${route.module}:${route.path}:0`);
      if (route === bootstrapRoute) {
        reports.push(bootstrap.report);
        continue;
      }
      const result = await requestSmokeRoute(route, {
        origin, fetchImpl, timers, signal: suite.signal, session, clock, workspaceId
      });
      reports.push(result.report);
    }
    return Object.freeze(reports);
  } finally { suite.close(); }
}

function defaultApiOnlyUpgradeProbe(url, options = {}) {
  return new Promise((resolveProbe, rejectProbe) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener?.("abort", abort);
      callback(value);
    };
    const request = nativeHttpRequest(url, {
      method: "GET",
      headers: { Connection: "Upgrade", Upgrade: "websocket" }
    });
    const abort = () => {
      request.destroy();
      finish(rejectProbe, error("API_ONLY_GATEWAY_UPGRADE_ABORTED"));
    };
    options.signal?.addEventListener?.("abort", abort, { once: true });
    request.once("upgrade", (response, socket) => {
      socket.destroy();
      finish(resolveProbe, Object.freeze({ status: Number(response.statusCode) }));
    });
    request.once("response", (response) => {
      response.resume();
      finish(resolveProbe, Object.freeze({ status: Number(response.statusCode) }));
    });
    request.once("error", (caught) => finish(rejectProbe, caught));
    request.end();
  });
}

async function gatewayHttpProbe(descriptor, context) {
  const pending = await issueSmokeRequest({
    origin: context.origin,
    path: descriptor.path,
    module: descriptor.path,
    fetchImpl: context.fetchImpl,
    parentSignal: context.signal,
    timers: context.timers,
    failurePrefix: "API_ONLY_GATEWAY_BOUNDARY_FAILED",
    init: { method: "GET", headers: Object.freeze({ Accept: descriptor.json ? "application/json" : "*/*" }) }
  });
  try {
    const { response } = pending;
    if (response.status !== descriptor.status) {
      throw error(`API_ONLY_GATEWAY_BOUNDARY_FAILED:${descriptor.path}:${response.status}`);
    }
    if (descriptor.kind === "healthz") {
      const text = await readSmokeText(response, descriptor.path, descriptor.path, response.status,
        "API_ONLY_GATEWAY_BOUNDARY_FAILED");
      if (text !== "ok\n") throw error(`API_ONLY_GATEWAY_BOUNDARY_FAILED:${descriptor.path}:${response.status}`);
    }
    if (descriptor.kind === "backend") {
      let body;
      try { body = await readSmokeJson(response, descriptor.path, descriptor.path, response.status); }
      catch { throw error(`API_ONLY_GATEWAY_BOUNDARY_FAILED:${descriptor.path}:${response.status}`); }
      if (body.ok !== true || body.store !== "mysql") {
        throw error(`API_ONLY_GATEWAY_BOUNDARY_FAILED:${descriptor.path}:${response.status}`);
      }
    }
    return Object.freeze({ method: "GET", path: descriptor.path, status: response.status });
  } finally { pending.close(); }
}

async function gatewayUpgradeProbe(path, context) {
  const deadline = startSmokeDeadline(API_ONLY_SMOKE_REQUEST_TIMEOUT_MS, context.timers, context.signal);
  let result;
  try {
    result = await context.upgradeProbe(`${context.origin}${path}`, {
      signal: deadline.signal,
      timeoutMs: API_ONLY_SMOKE_REQUEST_TIMEOUT_MS
    });
  } catch {
    throw error(`API_ONLY_GATEWAY_UPGRADE_FAILED:${path}:0`);
  } finally { deadline.close(); }
  const status = Number(result?.status);
  if (!Number.isSafeInteger(status) || status < 0 || status > 599) {
    throw error(`API_ONLY_GATEWAY_UPGRADE_FAILED:${path}:0`);
  }
  if (status === 101) throw error(`API_ONLY_GATEWAY_UPGRADE_ACCEPTED:${path}:101`);
  if (status !== 404) throw error(`API_ONLY_GATEWAY_UPGRADE_FAILED:${path}:${status}`);
  return Object.freeze({ method: "UPGRADE", path, status });
}

export async function verifyApiOnlyGatewayBoundary(options = {}) {
  const origin = apiOnlySmokeOrigin(options.origin);
  const fetchImpl = smokeFetchImplementation(options);
  const timers = smokeTimers(options);
  const upgradeProbe = options.upgradeProbe ?? defaultApiOnlyUpgradeProbe;
  if (typeof upgradeProbe !== "function") throw error("API_ONLY_GATEWAY_UPGRADE_PROBE_INVALID");
  const safeId = "A".repeat(43);
  const descriptors = Object.freeze([
    Object.freeze({ path: "/healthz", status: 200, kind: "healthz" }),
    Object.freeze({ path: "/api/health", status: 200, kind: "backend", json: true }),
    Object.freeze({ path: "/", status: 404 }),
    Object.freeze({ path: "/live-sessions/probe", status: 404 }),
    Object.freeze({ path: `/douyin-live/${safeId}`, status: 404 }),
    Object.freeze({ path: "/novnc/vnc.html", status: 404 })
  ]);
  const suite = startSmokeDeadline(API_ONLY_SMOKE_SUITE_TIMEOUT_MS, timers);
  try {
    const http = [];
    for (const descriptor of descriptors) {
      http.push(await gatewayHttpProbe(descriptor, {
        origin, fetchImpl, timers, signal: suite.signal
      }));
    }
    const upgrades = [];
    for (const path of ["/live-sessions/probe", `/douyin-live/${safeId}`]) {
      upgrades.push(await gatewayUpgradeProbe(path, {
        origin, upgradeProbe, timers, signal: suite.signal
      }));
    }
    return Object.freeze({ http: Object.freeze(http), upgrades: Object.freeze(upgrades) });
  } finally { suite.close(); }
}

export function parseApiOnlyCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || typeof argv[0] !== "string" || !COMMANDS.has(argv[0])) throw error("API_ONLY_CLI_ARGUMENT_INVALID");
  return Object.freeze({ command: argv[0] });
}

export async function dispatchApiOnlyCli(argv, handlers) {
  const { command } = parseApiOnlyCli(argv);
  const descriptor = handlers !== null && typeof handlers === "object"
    ? Object.getOwnPropertyDescriptor(handlers, command)
    : null;
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
    throw error(`API_ONLY_COMMAND_GATE_REQUIRED:${command}`);
  }
  return descriptor.value();
}

function absolute(value, code) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) throw error(code);
  return value;
}
function inside(root, candidate) {
  const part = relative(root, candidate);
  return part === "" || (!part.startsWith(`..${sep}`) && part !== "..");
}
async function noFollowDirectory(path, { create = false } = {}) {
  absolute(path, "API_ONLY_RUNTIME_ROOT_MUST_BE_ABSOLUTE");
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw error("API_ONLY_RUNTIME_ROOT_SYMLINK");
    if (!info.isDirectory()) throw error("API_ONLY_RUNTIME_ROOT_INVALID");
  } catch (caught) {
    if (caught?.code !== "ENOENT" || !create) throw caught;
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw error("API_ONLY_RUNTIME_ROOT_SYMLINK");
    if (!info.isDirectory()) throw error("API_ONLY_RUNTIME_ROOT_INVALID");
  }
  await chmod(path, PRIVATE_DIRECTORY_MODE);
  return path;
}

function rootFilesystem(options = {}, code) {
  const selected = {};
  for (const [name, fallback] of Object.entries({ lstat, realpath, open, mkdir, chmod })) {
    const value = Object.hasOwn(options, name) ? options[name] : fallback;
    if (typeof value !== "function") throw error(code);
    selected[name] = value;
  }
  const getuid = Object.hasOwn(options, "getuid") ? options.getuid : (() => process.getuid?.() ?? 0);
  if (typeof getuid !== "function") throw error(code);
  selected.getuid = getuid;
  return Object.freeze(selected);
}

function directoryIdentity(info) {
  return Object.freeze({
    dev: String(info.dev),
    ino: String(info.ino),
    uid: Number(info.uid),
    mode: Number(info.mode) & 0o777,
    nlink: Number(info.nlink)
  });
}

function sameDirectoryIdentity(left, right) {
  return ["dev", "ino", "uid", "mode", "nlink"].every((key) => left[key] === right[key]);
}

function sameDirectoryAnchorIdentity(left, right) {
  return ["dev", "ino", "uid", "mode"].every((key) => left[key] === right[key]);
}

function validOwnedDirectory(info, uid, { exactMode = null, allowRootOwner = false } = {}) {
  if (!info?.isDirectory?.() || info.isSymbolicLink?.()) return false;
  const owner = Number(info.uid);
  const mode = Number(info.mode) & 0o777;
  if (allowRootOwner ? owner !== 0 && owner !== uid : owner !== uid) return false;
  return exactMode === null ? (mode & 0o022) === 0 : mode === exactMode;
}

async function pinValidatedDirectory(path, filesystem, uid, code, policy) {
  let handle;
  try {
    const before = await filesystem.lstat(path);
    if (!validOwnedDirectory(before, uid, policy) || await filesystem.realpath(path) !== path) throw error(code);
    handle = await filesystem.open(path, FS.O_RDONLY | (FS.O_DIRECTORY ?? 0) | (FS.O_NOFOLLOW ?? 0), 0);
    const descriptor = await handle.stat({ bigint: true });
    const after = await filesystem.lstat(path);
    if (!validOwnedDirectory(descriptor, uid, policy)
      || !validOwnedDirectory(after, uid, policy)
      || !sameDirectoryIdentity(directoryIdentity(before), directoryIdentity(descriptor))
      || !sameDirectoryIdentity(directoryIdentity(descriptor), directoryIdentity(after))
      || await filesystem.realpath(path) !== path) throw error(code);
    return Object.freeze({ path, identity: directoryIdentity(descriptor) });
  } catch (caught) {
    if (caught?.message === code) throw caught;
    throw error(code);
  } finally {
    if (handle) {
      try { await handle.close(); } catch { throw error(code); }
    }
  }
}

async function validateApiOnlyRepositoryRoot(repositoryRoot, options = {}) {
  absolute(repositoryRoot, "API_ONLY_REPOSITORY_ROOT_INVALID");
  const filesystem = rootFilesystem(options, "API_ONLY_REPOSITORY_ROOT_INVALID");
  let uid;
  try { uid = Number(filesystem.getuid()); } catch { throw error("API_ONLY_REPOSITORY_ROOT_INVALID"); }
  if (!Number.isInteger(uid) || uid < 0) throw error("API_ONLY_REPOSITORY_ROOT_INVALID");
  try {
    const root = parsePath(repositoryRoot).root;
    let cursor = root;
    for (const part of repositoryRoot.slice(root.length).split(sep).filter(Boolean)) {
      cursor = join(cursor, part);
      const info = await filesystem.lstat(cursor);
      const isRepository = cursor === repositoryRoot;
      if (!validOwnedDirectory(info, uid, { allowRootOwner: !isRepository })) throw error("API_ONLY_REPOSITORY_ROOT_INVALID");
    }
    if (await filesystem.realpath(repositoryRoot) !== repositoryRoot) throw error("API_ONLY_REPOSITORY_ROOT_INVALID");
    const pinned = await pinValidatedDirectory(repositoryRoot, filesystem, uid, "API_ONLY_REPOSITORY_ROOT_INVALID", {});
    return Object.freeze({ path: repositoryRoot, uid, identity: pinned.identity, filesystem });
  } catch (caught) {
    if (caught?.message === "API_ONLY_REPOSITORY_ROOT_INVALID") throw caught;
    throw error("API_ONLY_REPOSITORY_ROOT_INVALID");
  }
}

async function ensureApiOnlyRuntimeRoot(repository, runtimeRoot, { create = false } = {}) {
  const { filesystem, uid } = repository;
  const runtimeParent = join(repository.path, ".runtime");
  const expectedRetained = join(runtimeParent, "api-only");
  const expectedDisposable = join(runtimeParent, "api-only-empty");
  const disposableSuffix = relative(expectedDisposable, runtimeRoot);
  const nestedDisposable = /^[a-f0-9]{12}$/u.test(disposableSuffix)
    && runtimeRoot === join(expectedDisposable, disposableSuffix);
  if (runtimeRoot !== expectedRetained && runtimeRoot !== expectedDisposable && !nestedDisposable) {
    throw error("API_ONLY_RUNTIME_ROOT_INVALID");
  }
  try {
    const paths = [
      [runtimeParent, null],
      ...(nestedDisposable ? [[expectedDisposable, PRIVATE_DIRECTORY_MODE]] : []),
      [runtimeRoot, PRIVATE_DIRECTORY_MODE]
    ];
    for (const [path, exactMode] of paths) {
      try {
        await filesystem.lstat(path);
      } catch (caught) {
        if (caught?.code !== "ENOENT" || !create) throw caught;
        await filesystem.mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
        await filesystem.chmod(path, PRIVATE_DIRECTORY_MODE);
      }
      await pinValidatedDirectory(path, filesystem, uid, "API_ONLY_RUNTIME_ROOT_INVALID", { exactMode });
    }
    const repositoryAgain = await pinValidatedDirectory(repository.path, filesystem, uid, "API_ONLY_REPOSITORY_ROOT_INVALID", {});
    if (!sameDirectoryAnchorIdentity(repository.identity, repositoryAgain.identity)) throw error("API_ONLY_REPOSITORY_ROOT_INVALID");
    return runtimeRoot;
  } catch (caught) {
    if (caught?.message === "API_ONLY_REPOSITORY_ROOT_INVALID" || caught?.message === "API_ONLY_RUNTIME_ROOT_INVALID") throw caught;
    throw error("API_ONLY_RUNTIME_ROOT_INVALID");
  }
}
async function privateDirectory(path) {
  await noFollowDirectory(path, { create: true });
  return path;
}
async function ownerLockDirectory(repository, path) {
  return ensureApiOnlyRuntimeRoot(repository, path, { create: true });
}
async function privateFile(path, bytes, { exclusive = true } = {}) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw error("API_ONLY_PRIVATE_FILE_INVALID");
    if (info.mode & 0o077) throw error("API_ONLY_PRIVATE_FILE_MUST_BE_OWNER_ONLY");
    const current = await readFile(path);
    if (bytes !== undefined && !current.equals(Buffer.from(bytes))) throw error("API_ONLY_PRIVATE_FILE_CONTENT_MISMATCH");
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
    if (bytes === undefined) throw error("API_ONLY_PRIVATE_FILE_INVALID");
    await writeFile(path, bytes, { flag: exclusive ? "wx" : "w", mode: PRIVATE_MODE });
  }
  await chmod(path, PRIVATE_MODE);
  return path;
}
function privateRecordFilesystem(options = {}, code = "API_ONLY_PRIVATE_JSON_INVALID") {
  const filesystem = { ...rootFilesystem(options, code) };
  for (const [name, fallback] of Object.entries({ rename, unlink })) {
    const value = Object.hasOwn(options, name) ? options[name] : fallback;
    if (typeof value !== "function") throw error(code);
    filesystem[name] = value;
  }
  return Object.freeze(filesystem);
}
function privateRecordUid(filesystem, code) {
  let uid;
  try { uid = Number(filesystem.getuid()); } catch { throw error(code); }
  if (!Number.isInteger(uid) || uid < 0) throw error(code);
  return uid;
}
function validPrivateRecordStat(info, uid, { empty = false, allowEmpty = false } = {}) {
  const size = Number(info?.size);
  return info?.isFile?.()
    && !info.isSymbolicLink?.()
    && Number(info.uid) === uid
    && (Number(info.mode) & 0o777) === PRIVATE_MODE
    && Number(info.nlink) === 1
    && Number.isSafeInteger(size)
    && (empty ? size === 0 : allowEmpty ? size >= 0 && size <= MAX_PRIVATE_JSON_BYTES : size > 0 && size <= MAX_PRIVATE_JSON_BYTES);
}
async function privateRecordPathIdentity(path, filesystem, uid, code, { missing = false, allowEmpty = false } = {}) {
  let handle;
  try {
    handle = await filesystem.open(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0), 0);
  } catch (caught) {
    if (missing && caught?.code === "ENOENT") return null;
    throw error(code);
  }
  try {
    const descriptor = await handle.stat({ bigint: true });
    const pathname = await filesystem.lstat(path);
    if (!validPrivateRecordStat(descriptor, uid, { allowEmpty })
      || !validPrivateRecordStat(pathname, uid, { allowEmpty })
      || !sameDirectoryIdentity(directoryIdentity(descriptor), directoryIdentity(pathname))
      || Number(descriptor.size) !== Number(pathname.size)) throw error(code);
    return Object.freeze({ identity: directoryIdentity(descriptor), size: Number(descriptor.size) });
  } catch (caught) {
    if (caught?.message === code) throw caught;
    throw error(code);
  } finally {
    try { await handle.close(); } catch { throw error(code); }
  }
}
async function readPrivateJsonSnapshot(path, code, options = {}) {
  absolute(path, code);
  const filesystem = privateRecordFilesystem(options, code);
  const uid = privateRecordUid(filesystem, code);
  await pinValidatedDirectory(dirname(path), filesystem, uid, code, { exactMode: PRIVATE_DIRECTORY_MODE });
  let handle;
  try {
    handle = await filesystem.open(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0), 0);
  } catch (caught) {
    if (caught?.code === "ENOENT") return null;
    throw error(code);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!validPrivateRecordStat(before, uid)) throw error(code);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathname = await filesystem.lstat(path);
    if (bytes.length !== Number(before.size)
      || !validPrivateRecordStat(after, uid)
      || !validPrivateRecordStat(pathname, uid)
      || Number(after.size) !== bytes.length
      || Number(pathname.size) !== bytes.length
      || !sameDirectoryIdentity(directoryIdentity(before), directoryIdentity(after))
      || !sameDirectoryIdentity(directoryIdentity(before), directoryIdentity(pathname))) throw error(code);
    const text = bytes.toString("utf8");
    let value;
    try { value = JSON.parse(text); } catch { throw error(code); }
    if (text !== json(value)) throw error(code);
    return Object.freeze({ value, identity: directoryIdentity(before), canonicalText: text });
  } catch (caught) {
    if (caught?.message === code) throw caught;
    throw error(code);
  } finally {
    try { await handle.close(); } catch { throw error(code); }
  }
}
async function readPrivateJson(path, code, options = {}) {
  const snapshot = await readPrivateJsonSnapshot(path, code, options);
  return snapshot === null ? null : snapshot.value;
}
async function writePrivateJson(path, value, options = {}) {
  absolute(path, "API_ONLY_PRIVATE_JSON_INVALID");
  let bytes;
  try {
    bytes = Buffer.from(json(value), "utf8");
    if (bytes.length < 2 || bytes.length > MAX_PRIVATE_JSON_BYTES || json(JSON.parse(bytes.toString("utf8"))) !== bytes.toString("utf8")) throw error("API_ONLY_PRIVATE_JSON_INVALID");
  } catch (caught) {
    if (caught?.message === "API_ONLY_PRIVATE_JSON_INVALID") throw caught;
    throw error("API_ONLY_PRIVATE_JSON_INVALID");
  }
  const code = "API_ONLY_PRIVATE_JSON_INVALID";
  const filesystem = privateRecordFilesystem(options, code);
  const uid = privateRecordUid(filesystem, code);
  const parent = dirname(path);
  const parentPinned = await pinValidatedDirectory(parent, filesystem, uid, code, { exactMode: PRIVATE_DIRECTORY_MODE });
  const prior = await privateRecordPathIdentity(path, filesystem, uid, code, { missing: true });
  const temporary = join(parent, `.${basename(path)}.${nativeRandomBytes(16).toString("hex")}.tmp`);
  let handle;
  let temporaryIdentity = null;
  let promoted = false;
  try {
    handle = await filesystem.open(temporary, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | (FS.O_NOFOLLOW ?? 0), PRIVATE_MODE);
    await handle.chmod?.(PRIVATE_MODE);
    const empty = await handle.stat({ bigint: true });
    if (!validPrivateRecordStat(empty, uid, { empty: true })) throw error(code);
    temporaryIdentity = directoryIdentity(empty);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    const temporaryPath = await filesystem.lstat(temporary);
    if (!validPrivateRecordStat(written, uid)
      || !validPrivateRecordStat(temporaryPath, uid)
      || Number(written.size) !== bytes.length
      || Number(temporaryPath.size) !== bytes.length
      || !sameDirectoryIdentity(temporaryIdentity, directoryIdentity(written))
      || !sameDirectoryIdentity(temporaryIdentity, directoryIdentity(temporaryPath))) throw error(code);
    await options.privateRecordStage?.("after-file-sync", Object.freeze({ path, temporary }));
    await options.privateRecordStage?.("before-rename", Object.freeze({ path, temporary }));
    const parentAgain = await pinValidatedDirectory(parent, filesystem, uid, code, { exactMode: PRIVATE_DIRECTORY_MODE });
    if (!sameDirectoryAnchorIdentity(parentPinned.identity, parentAgain.identity)) throw error(code);
    const current = await privateRecordPathIdentity(path, filesystem, uid, code, { missing: true });
    if (prior === null ? current !== null : current === null || !sameDirectoryIdentity(prior.identity, current.identity)) throw error(code);
    const candidate = await privateRecordPathIdentity(temporary, filesystem, uid, code);
    if (!sameDirectoryIdentity(temporaryIdentity, candidate.identity) || candidate.size !== bytes.length) throw error(code);
    await filesystem.rename(temporary, path);
    promoted = true;
    await options.privateRecordStage?.("after-rename", Object.freeze({ path, temporary }));
    const visible = await privateRecordPathIdentity(path, filesystem, uid, code);
    if (!sameDirectoryIdentity(temporaryIdentity, visible.identity) || visible.size !== bytes.length) throw error(code);
    const directory = await filesystem.open(parent, FS.O_RDONLY | (FS.O_DIRECTORY ?? 0) | (FS.O_NOFOLLOW ?? 0), 0);
    try {
      const directoryStat = await directory.stat({ bigint: true });
      if (!validOwnedDirectory(directoryStat, uid, { exactMode: PRIVATE_DIRECTORY_MODE })
        || !sameDirectoryAnchorIdentity(parentPinned.identity, directoryIdentity(directoryStat))) throw error(code);
      await directory.sync();
    } finally { await directory.close(); }
    await options.privateRecordStage?.("after-directory-sync", Object.freeze({ path, temporary }));
    return readPrivateJson(path, code, options);
  } finally {
    if (handle) await handle.close();
    if (!promoted && temporaryIdentity) {
      try {
        const candidate = await privateRecordPathIdentity(temporary, filesystem, uid, code, { missing: true, allowEmpty: true });
        if (candidate && sameDirectoryIdentity(temporaryIdentity, candidate.identity)) await filesystem.unlink(temporary);
      } catch { /* Preserve the primary failure; an unpromoted temp is never authority. */ }
    }
  }
}
function safeProject(value) {
  if (typeof value !== "string" || !PROJECT.test(value)) throw error("API_ONLY_PROJECT_INVALID");
  return value;
}
function validUtcTimestamp(value) {
  try {
    return typeof value === "string"
      && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
      && new Date(value).toISOString() === value;
  } catch { return false; }
}
function suppliedRoot(repositoryRoot, options, disposable) {
  const supplied = options.runtimeRoot;
  if (supplied !== undefined) absolute(supplied, "API_ONLY_RUNTIME_ROOT_MUST_BE_ABSOLUTE");
  const expected = join(repositoryRoot, ".runtime", disposable ? "api-only-empty" : "api-only");
  if (supplied === undefined || supplied === expected) return expected;
  const match = disposable ? DISPOSABLE_PROJECT.exec(options.project ?? "") : null;
  if (!match || supplied !== join(expected, match[1])) throw error("API_ONLY_RUNTIME_ROOT_INVALID");
  return supplied;
}
function selected(options = {}) {
  const disposable = options.disposable === true;
  const project = safeProject(options.project ?? (disposable ? `shensi-api-empty-${nativeRandomBytes(6).toString("hex")}` : "shensi-api"));
  if (disposable && (!project.startsWith("shensi-api-empty-") || project === "shensi-api")) throw error("API_ONLY_DISPOSABLE_PROJECT_REQUIRED");
  if (!disposable && project !== "shensi-api" && project.startsWith("shensi-api-empty-")) throw error("API_ONLY_DISPOSABLE_PROJECT_REQUIRED");
  const ports = disposable ? { gateway: API_ONLY_PORTS.emptyGateway, mysql: API_ONLY_PORTS.emptyMysql } : { gateway: API_ONLY_PORTS.gateway, mysql: API_ONLY_PORTS.mysql };
  return { disposable, project, ports };
}
async function assertPorts(ports, isPortAvailable) {
  for (const port of Object.values(ports)) if (!await isPortAvailable(port)) throw error(`API_ONLY_PORT_OCCUPIED:${port}`);
}
async function pinPrivateDirectoryTree(repository, directory, code) {
  absolute(directory, code);
  if (!inside(repository.path, directory) || directory === repository.path) throw error(code);
  let cursor = repository.path;
  for (const part of relative(repository.path, directory).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    await pinValidatedDirectory(cursor, repository.filesystem, repository.uid, code, { exactMode: PRIVATE_DIRECTORY_MODE });
  }
  const repositoryAgain = await pinValidatedDirectory(repository.path, repository.filesystem, repository.uid, "API_ONLY_REPOSITORY_ROOT_INVALID", {});
  if (!sameDirectoryAnchorIdentity(repository.identity, repositoryAgain.identity)) throw error("API_ONLY_REPOSITORY_ROOT_INVALID");
  return directory;
}
async function pinRepositoryDirectoryTree(repository, directory, code) {
  absolute(directory, code);
  if (!inside(repository.path, directory) || directory === repository.path) throw error(code);
  let cursor = repository.path;
  for (const part of relative(repository.path, directory).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    await pinValidatedDirectory(cursor, repository.filesystem, repository.uid, code, {});
  }
  const repositoryAgain = await pinValidatedDirectory(repository.path, repository.filesystem, repository.uid, "API_ONLY_REPOSITORY_ROOT_INVALID", {});
  if (!sameDirectoryAnchorIdentity(repository.identity, repositoryAgain.identity)) throw error("API_ONLY_REPOSITORY_ROOT_INVALID");
  return directory;
}
async function ensurePrivateDirectory(repository, directory, code) {
  const parent = dirname(directory);
  await pinPrivateDirectoryTree(repository, parent, code);
  try {
    await repository.filesystem.lstat(directory);
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw error(code);
    try {
      await repository.filesystem.mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
      await repository.filesystem.chmod(directory, PRIVATE_DIRECTORY_MODE);
    } catch { throw error(code); }
  }
  return pinPrivateDirectoryTree(repository, directory, code);
}
function assertPrivateSecretStat(info, uid, invalidCode, modeCode) {
  if ((Number(info?.mode) & 0o777) !== PRIVATE_MODE) throw error(modeCode);
  const size = Number(info?.size);
  if (!info?.isFile?.()
    || info.isSymbolicLink?.()
    || Number(info.uid) !== uid
    || Number(info.nlink) !== 1
    || !Number.isSafeInteger(size)
    || size < 1
    || size > MAX_SECRET_BYTES) throw error(invalidCode);
}
async function readStablePrivateBytes(path, directory, repository, {
  missing = false,
  invalidCode = "API_ONLY_SECRET_FILE_INVALID",
  modeCode = "API_ONLY_SECRET_FILE_MUST_BE_OWNER_ONLY"
} = {}) {
  absolute(path, invalidCode);
  if (dirname(path) !== directory || !inside(repository.path, path)) throw error(invalidCode);
  await pinPrivateDirectoryTree(repository, directory, invalidCode);
  let handle;
  try {
    handle = await repository.filesystem.open(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0), 0);
  } catch (caught) {
    if (missing && caught?.code === "ENOENT") return null;
    throw error(invalidCode);
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertPrivateSecretStat(before, repository.uid, invalidCode, modeCode);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathname = await repository.filesystem.lstat(path);
    assertPrivateSecretStat(after, repository.uid, invalidCode, modeCode);
    assertPrivateSecretStat(pathname, repository.uid, invalidCode, modeCode);
    if (bytes.length !== Number(before.size)
      || Number(after.size) !== bytes.length
      || Number(pathname.size) !== bytes.length
      || !sameDirectoryIdentity(directoryIdentity(before), directoryIdentity(after))
      || !sameDirectoryIdentity(directoryIdentity(before), directoryIdentity(pathname))) throw error(invalidCode);
    return bytes;
  } catch (caught) {
    if (caught?.message === invalidCode || caught?.message === modeCode || caught?.message === "API_ONLY_REPOSITORY_ROOT_INVALID") throw caught;
    throw error(invalidCode);
  } finally {
    try { await handle.close(); } catch { throw error(invalidCode); }
  }
}
async function sourcePrivateFile(path, sourceDirectory, repository) {
  return readStablePrivateBytes(path, sourceDirectory, repository);
}
async function ensureStablePrivateBytes(destination, bytes, { destinationDirectory, repository }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_SECRET_BYTES) throw error("API_ONLY_PRIVATE_FILE_INVALID");
  const existing = await readStablePrivateBytes(destination, destinationDirectory, repository, {
    missing: true,
    invalidCode: "API_ONLY_PRIVATE_FILE_INVALID",
    modeCode: "API_ONLY_PRIVATE_FILE_MUST_BE_OWNER_ONLY"
  });
  if (existing) {
    if (existing.length !== bytes.length || sha256(existing) !== sha256(bytes)) throw error("API_ONLY_PRIVATE_FILE_CONTENT_MISMATCH");
    return destination;
  }
  await pinPrivateDirectoryTree(repository, destinationDirectory, "API_ONLY_PRIVATE_FILE_INVALID");
  let handle;
  let createdIdentity = null;
  let complete = false;
  try {
    handle = await repository.filesystem.open(destination, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | (FS.O_NOFOLLOW ?? 0), PRIVATE_MODE);
    await handle.chmod?.(PRIVATE_MODE);
    const empty = await handle.stat({ bigint: true });
    if (!empty?.isFile?.() || Number(empty.uid) !== repository.uid || (Number(empty.mode) & 0o777) !== PRIVATE_MODE || Number(empty.nlink) !== 1 || Number(empty.size) !== 0) throw error("API_ONLY_PRIVATE_FILE_INVALID");
    createdIdentity = directoryIdentity(empty);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    const pathname = await repository.filesystem.lstat(destination);
    assertPrivateSecretStat(written, repository.uid, "API_ONLY_PRIVATE_FILE_INVALID", "API_ONLY_PRIVATE_FILE_MUST_BE_OWNER_ONLY");
    assertPrivateSecretStat(pathname, repository.uid, "API_ONLY_PRIVATE_FILE_INVALID", "API_ONLY_PRIVATE_FILE_MUST_BE_OWNER_ONLY");
    if (Number(written.size) !== bytes.length
      || Number(pathname.size) !== bytes.length
      || !sameDirectoryIdentity(createdIdentity, directoryIdentity(written))
      || !sameDirectoryIdentity(createdIdentity, directoryIdentity(pathname))) throw error("API_ONLY_PRIVATE_FILE_INVALID");
    const directory = await repository.filesystem.open(destinationDirectory, FS.O_RDONLY | (FS.O_DIRECTORY ?? 0) | (FS.O_NOFOLLOW ?? 0), 0);
    try { await directory.sync(); } finally { await directory.close(); }
    complete = true;
  } finally {
    if (handle) await handle.close();
    if (!complete && createdIdentity) {
      try {
        const pathname = await repository.filesystem.lstat(destination);
        if (sameDirectoryIdentity(createdIdentity, directoryIdentity(pathname))) await unlink(destination);
      } catch { /* Preserve the primary failure and never unlink a replacement. */ }
    }
  }
  const copied = await readStablePrivateBytes(destination, destinationDirectory, repository, {
    invalidCode: "API_ONLY_PRIVATE_FILE_INVALID",
    modeCode: "API_ONLY_PRIVATE_FILE_MUST_BE_OWNER_ONLY"
  });
  if (copied.length !== bytes.length || sha256(copied) !== sha256(bytes)) throw error("API_ONLY_PRIVATE_FILE_CONTENT_MISMATCH");
  return destination;
}
async function copyStable(source, destination, context) {
  const bytes = await sourcePrivateFile(source, context.sourceDirectory, context.repository);
  return ensureStablePrivateBytes(destination, bytes, context);
}
function decodeGeneratedSecret(bytes) {
  const text = bytes.toString("utf8");
  try {
    if (!/^[A-Za-z0-9_-]{64}$/u.test(text)
      || Buffer.from(text, "base64url").length !== 48
      || Buffer.from(text, "base64url").toString("base64url") !== text) throw error("API_ONLY_GENERATED_SECRET_INVALID");
  } catch (caught) {
    if (caught?.message === "API_ONLY_GENERATED_SECRET_INVALID") throw caught;
    throw error("API_ONLY_GENERATED_SECRET_INVALID");
  }
  return text;
}
async function generatedSecrets(names, directory, repository, random) {
  if (typeof random !== "function") throw error("API_ONLY_GENERATED_SECRET_INVALID");
  const values = new Map();
  const missing = [];
  for (const name of names) {
    const path = join(directory, name);
    let existing;
    try {
      existing = await readStablePrivateBytes(path, directory, repository, {
        missing: true,
        invalidCode: "API_ONLY_GENERATED_SECRET_INVALID",
        modeCode: "API_ONLY_GENERATED_SECRET_INVALID"
      });
    } catch { throw error("API_ONLY_GENERATED_SECRET_INVALID"); }
    if (existing === null) missing.push({ name, path });
    else values.set(name, decodeGeneratedSecret(existing));
  }
  for (const { name } of missing) {
    let entropy;
    try { entropy = random(48); } catch { throw error("API_ONLY_GENERATED_SECRET_INVALID"); }
    if (!(Buffer.isBuffer(entropy) || entropy instanceof Uint8Array) || entropy.byteLength !== 48) throw error("API_ONLY_GENERATED_SECRET_INVALID");
    const encoded = Buffer.from(entropy).toString("base64url");
    values.set(name, decodeGeneratedSecret(Buffer.from(encoded, "utf8")));
  }
  if (new Set(values.values()).size !== names.length) throw error("API_ONLY_GENERATED_SECRET_INVALID");
  for (const { name, path } of missing) {
    await ensureStablePrivateBytes(path, Buffer.from(values.get(name), "utf8"), { destinationDirectory: directory, repository });
  }
  return Object.freeze(Object.fromEntries(names.map((name) => [name, values.get(name)])));
}
function backendEnvironmentValue(bytes) {
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { throw error("API_ONLY_BACKEND_ENV_VALUE_INVALID"); }
  if (!value
    || value.includes("\0")
    || value.includes("\r")
    || value.includes("\n")
    || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES
    || !Buffer.from(value, "utf8").equals(Buffer.from(bytes))) throw error("API_ONLY_BACKEND_ENV_VALUE_INVALID");
  return value;
}
function buildApiOnlyBackendEnvironment(choice, generated, preserved, gatewayServiceIp = "172.31.240.2") {
  const expectedPreserved = Object.keys(API_ONLY_CRYPTO_SECRET_BINDINGS);
  if (Object.keys(preserved).length !== expectedPreserved.length || expectedPreserved.some((name) => !Object.hasOwn(preserved, name))) throw error("API_ONLY_BACKEND_ENV_INVALID");
  const environment = {
    DATABASE_URL: `mysql://shensi_app:${encodeURIComponent(generated.mysql_app_password)}@mysql:3306/shensi`,
    CRM_STORE: "mysql",
    CRM_SEED_DEVELOPMENT_DATA: "false",
    NODE_ENV: "production",
    BACKEND_HOST: "0.0.0.0",
    PORT: "4188",
    TRUSTED_PROXY_CIDRS: `${gatewayServiceIp}/32`,
    CORS_ORIGINS: `http://127.0.0.1:${choice.ports.gateway}`,
    SESSION_COOKIE_SECURE: "true",
    DOUYIN_OUTREACH_ACTIONS_ENABLED: "false",
    DOUYIN_OUTREACH_APPROVALS_ENABLED: "true",
    DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED: "false",
    DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: "false",
    SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "migration_locked",
    INITIAL_ADMIN_EMAIL: "migration-bootstrap@shensi.local",
    INITIAL_ADMIN_PASSWORD: generated.bootstrap_admin_password,
    ...preserved
  };
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)
      || typeof value !== "string"
      || !value
      || value.includes("\0")
      || value.includes("\r")
      || value.includes("\n")
      || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw error("API_ONLY_BACKEND_ENV_VALUE_INVALID");
  }
  return Object.freeze(environment);
}
function serializeBackendEnvironment(environment) {
  return Buffer.from(`${Object.entries(environment).map(([name, value]) => `${name}=${value}`).join("\n")}\n`, "utf8");
}
function assertGatewaySourceStat(info, uid) {
  const size = Number(info?.size);
  if (!info?.isFile?.()
    || info.isSymbolicLink?.()
    || Number(info.uid) !== uid
    || (Number(info.mode) & 0o022) !== 0
    || Number(info.nlink) !== 1
    || !Number.isSafeInteger(size)
    || size < 1
    || size > MAX_SECRET_BYTES) throw error("API_ONLY_GATEWAY_SOURCE_INVALID");
}
async function readGatewaySource(repository, path) {
  if (dirname(path) !== join(repository.path, "deploy", "nginx")) throw error("API_ONLY_GATEWAY_SOURCE_INVALID");
  await pinRepositoryDirectoryTree(repository, dirname(path), "API_ONLY_GATEWAY_SOURCE_INVALID");
  let handle;
  try { handle = await repository.filesystem.open(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0), 0); }
  catch { throw error("API_ONLY_GATEWAY_SOURCE_INVALID"); }
  try {
    const before = await handle.stat({ bigint: true });
    assertGatewaySourceStat(before, repository.uid);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathname = await repository.filesystem.lstat(path);
    assertGatewaySourceStat(after, repository.uid);
    assertGatewaySourceStat(pathname, repository.uid);
    if (bytes.length !== Number(before.size)
      || Number(after.size) !== bytes.length
      || Number(pathname.size) !== bytes.length
      || !sameDirectoryIdentity(directoryIdentity(before), directoryIdentity(after))
      || !sameDirectoryIdentity(directoryIdentity(before), directoryIdentity(pathname))) throw error("API_ONLY_GATEWAY_SOURCE_INVALID");
    return bytes;
  } catch (caught) {
    if (caught?.message === "API_ONLY_GATEWAY_SOURCE_INVALID" || caught?.message === "API_ONLY_REPOSITORY_ROOT_INVALID") throw caught;
    throw error("API_ONLY_GATEWAY_SOURCE_INVALID");
  } finally {
    try { await handle.close(); } catch { throw error("API_ONLY_GATEWAY_SOURCE_INVALID"); }
  }
}
async function validateGatewaySnapshot(runtimeRoot, snapshot, repository) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || Object.keys(snapshot).length !== 2
    || Object.keys(snapshot)[0] !== "path"
    || Object.keys(snapshot)[1] !== "sha256"
    || !HASH.test(snapshot.sha256)) throw error("API_ONLY_GATEWAY_SNAPSHOT_INVALID");
  const snapshots = join(runtimeRoot, "snapshots");
  const expected = join(snapshots, `${snapshot.sha256}.conf`);
  if (snapshot.path !== expected) throw error("API_ONLY_GATEWAY_SNAPSHOT_INVALID");
  const bytes = await readStablePrivateBytes(expected, snapshots, repository, {
    invalidCode: "API_ONLY_GATEWAY_SNAPSHOT_INVALID",
    modeCode: "API_ONLY_GATEWAY_SNAPSHOT_INVALID"
  });
  if (sha256(bytes) !== snapshot.sha256) throw error("API_ONLY_GATEWAY_SNAPSHOT_INVALID");
  return Object.freeze({ path: expected, sha256: snapshot.sha256 });
}
async function gatewaySnapshot(repositoryRoot, runtimeRoot, repository) {
  const source = join(repositoryRoot, "deploy", "nginx", "api-only.conf");
  const bytes = await readGatewaySource(repository, source);
  const hash = sha256(bytes);
  const snapshots = join(runtimeRoot, "snapshots");
  await ensurePrivateDirectory(repository, snapshots, "API_ONLY_GATEWAY_SNAPSHOT_INVALID");
  const path = join(snapshots, `${hash}.conf`);
  await ensureStablePrivateBytes(path, bytes, { destinationDirectory: snapshots, repository });
  return validateGatewaySnapshot(runtimeRoot, { path, sha256: hash }, repository);
}
function environment(runtime, network = runtime?.networkClaim) {
  if (!network || network.projectName !== runtime?.project || network.runtimeNonce !== runtime?.runtimeNonce) throw error("API_ONLY_NETWORK_CLAIM_REQUIRED");
  const vars = {
    SHENSI_API_RUNTIME_ROOT: runtime.root,
    SHENSI_API_BACKEND_ENV_FILE: runtime.environmentFile,
    SHENSI_API_MYSQL_APP_PASSWORD_FILE: join(runtime.secretsDirectory, "mysql_app_password"),
    SHENSI_API_MYSQL_ROOT_PASSWORD_FILE: join(runtime.secretsDirectory, "mysql_root_password"),
    SHENSI_API_GATEWAY_CONFIG_FILE: runtime.gatewaySnapshot.path,
    SHENSI_API_HTTP_PORT: String(runtime.ports.gateway),
    SHENSI_API_MYSQL_HOST_PORT: String(runtime.ports.mysql),
    SHENSI_API_INTERNAL_SUBNET: network.subnet,
    SHENSI_API_IPAM_GATEWAY: network.ipamGatewayIp,
    SHENSI_API_GATEWAY_IP: network.gatewayServiceIp,
    SHENSI_API_RUNTIME_NONCE: runtime.runtimeNonce,
    SHENSI_API_DAEMON_IDENTITY: runtime.composeRuntime?.daemon?.identity ?? "unresolved"
  };
  return Object.freeze(vars);
}

export function apiOnlyComposeInvocation(runtime, args) {
  if (!runtime || !Array.isArray(args) || args.some((value) => typeof value !== "string" || !value || value.includes("\0"))) throw error("API_ONLY_COMPOSE_ARGUMENT_INVALID");
  const project = safeProject(runtime.project);
  const composeRuntime = runtime.composeRuntime;
  if (!composeRuntime || !Array.isArray(composeRuntime.argvPrefix) || !composeRuntime.argvPrefix.length) throw error("API_ONLY_COMPOSE_RUNTIME_REQUIRED");
  const invocation = ["-f", "deploy/compose.api-only.yaml", "--project-name", project, ...args];
  return Object.freeze({ argvPrefix: [...composeRuntime.argvPrefix], args: invocation, environment: environment(runtime, runtime.networkClaim) });
}

function retainedOwnerLockInput(repositoryRoot, options) {
  const input = { repositoryRoot };
  for (const key of [
    "runtimeRoot", "project", "processInfo", "isProcessCurrent", "randomBytes",
    "readProcessStartToken", "beforeStaleLockRemoval", "now", "engineIdentity",
    "getuid", "lstat", "realpath", "open", "mkdir", "chmod", "rename", "unlink"
  ]) {
    if (options[key] !== undefined) input[key] = options[key];
  }
  return input;
}

async function withRetainedLifecycleAuthority(repositoryRoot, options, callback) {
  return withApiOnlyOwnerLock(retainedOwnerLockInput(repositoryRoot, options), async () => {
    const authority = await authorityResolver.readLifecycleAuthority(repositoryRoot);
    return callback(authority);
  });
}

function rejectBlockedLifecyclePhase(authority) {
  if (authority.phase === "migration") throw error("API_ONLY_MIGRATION_IN_PROGRESS");
  if (authority.phase === "write_activation_pending") throw error("API_ONLY_ACCEPT_RESUME_REQUIRED");
}

const ACCEPTED_LIFECYCLE_OPTION_NAMES = Object.freeze([
  "request", "execFile", "lstat", "realpath", "readlink", "access", "open", "mkdir", "chmod", "rename", "unlink",
  "getuid", "spawn", "setTimeout", "clearTimeout", "revalidateExecutable", "probeDaemonIdentity", "monotonicNow", "now"
]);

function acceptedLifecycleOptions(options = {}) {
  const supplied = options.acceptedLifecycleOptions ?? {};
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw error("API_ONLY_ACCEPTED_LIFECYCLE_OPTIONS_INVALID");
  const allowed = new Set(ACCEPTED_LIFECYCLE_OPTION_NAMES);
  for (const [name, value] of Object.entries(supplied)) {
    if (!allowed.has(name) || typeof value !== "function") throw error("API_ONLY_ACCEPTED_LIFECYCLE_OPTIONS_INVALID");
  }
  return supplied;
}

function pickAcceptedLifecycleOptions(supplied, names) {
  return Object.fromEntries(names.filter((name) => Object.hasOwn(supplied, name)).map((name) => [name, supplied[name]]));
}

function acceptedRuntimeDiscoveryOptions(options = {}) {
  const supplied = options.composeRuntimeDiscoveryOptions ?? {};
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw error("API_ONLY_COMPOSE_RUNTIME_DISCOVERY_INVALID");
  return supplied;
}

function sameAcceptedObservation(left, right) {
  return left?.identitySha256 === right?.identitySha256 && left?.stateSha256 === right?.stateSha256;
}

function assertAcceptedObservationUnchanged(expected, actual, operation) {
  if (!sameAcceptedObservation(expected, actual)) {
    throw error(operation === "status" ? "API_ONLY_ACCEPTED_STATUS_CHANGED" : "API_ONLY_ACCEPTED_OPERATION_FAILED_CLOSED");
  }
}

async function inspectAcceptedResources(runtime, projection, supplied) {
  const bridge = createApiOnlyResourceInspectionBridge(pickAcceptedLifecycleOptions(supplied, [
    "request", "lstat", "realpath", "open", "getuid", "setTimeout", "clearTimeout"
  ]));
  return bridge.inspectAcceptedResourceSet(runtime, projection);
}

async function validateAcceptedCompose(runtime, projection, observation, supplied) {
  const bridge = createApiOnlyAcceptedComposeValidationBridge(pickAcceptedLifecycleOptions(supplied, [
    "lstat", "realpath", "open", "getuid", "spawn", "setTimeout", "clearTimeout",
    "revalidateExecutable", "probeDaemonIdentity", "monotonicNow"
  ]));
  return bridge.validateAcceptedComposeInputs(runtime, projection, observation);
}

async function revalidateAcceptedProof(repositoryRoot, authority, expectedObservation, operation, options, { afterAcceptedEvidenceMutation = false } = {}) {
  const freshAuthority = afterAcceptedEvidenceMutation
    ? await authorityResolver.readLifecycleAuthority(repositoryRoot)
    : await authorityResolver.revalidateLifecycleAuthorityAtPointOfUse(authority);
  if (afterAcceptedEvidenceMutation && JSON.stringify(freshAuthority) !== JSON.stringify(authority)) {
    throw error("API_ONLY_ACCEPTED_VERSION_STATE_CONFLICT");
  }
  const projection = authorityResolver.projectAcceptedResources(freshAuthority);
  const runtime = await discoverComposeRuntime(acceptedRuntimeDiscoveryOptions(options));
  const supplied = acceptedLifecycleOptions(options);
  const observation = await inspectAcceptedResources(runtime, projection, supplied);
  if (expectedObservation) assertAcceptedObservationUnchanged(expectedObservation, observation, operation);
  return Object.freeze({ authority: freshAuthority, projection, runtime, observation });
}

async function runAcceptedSuboperation(repositoryRoot, authority, operation, options) {
  const before = await revalidateAcceptedProof(repositoryRoot, authority, null, operation, options);
  const supplied = acceptedLifecycleOptions(options);
  const validatedInputs = await validateAcceptedCompose(before.runtime, before.projection, before.observation, supplied);
  const bridge = createApiOnlyAcceptedLifecycleExecutionBridge(supplied);
  const result = await bridge.runAcceptedLifecycleOperation(
    before.runtime, before.projection, before.observation, validatedInputs, operation
  );
  const after = await revalidateAcceptedProof(repositoryRoot, before.authority, result.observation, operation, options, {
    afterAcceptedEvidenceMutation: true
  });
  return Object.freeze({ ...after, result });
}

async function resolveComposeRuntime(options = {}, environmentOverrides = null) {
  const discoveryOptions = options.composeRuntimeDiscoveryOptions ?? {};
  if (!discoveryOptions || typeof discoveryOptions !== "object" || Array.isArray(discoveryOptions)) {
    throw error("API_ONLY_COMPOSE_RUNTIME_DISCOVERY_INVALID");
  }
  if (environmentOverrides === null) return discoverComposeRuntime(discoveryOptions);
  const inheritedEnvironment = discoveryOptions.environment ?? process.env;
  return discoverComposeRuntime({
    ...discoveryOptions,
    environment: { ...inheritedEnvironment, ...environmentOverrides }
  });
}

function sameResolvedRuntimeAuthority(left, right) {
  return JSON.stringify({
    argvPrefix: left?.argvPrefix,
    executableIdentity: left?.executableIdentity,
    compose: left?.compose,
    socket: left?.socket,
    daemon: left?.daemon
  }) === JSON.stringify({
    argvPrefix: right?.argvPrefix,
    executableIdentity: right?.executableIdentity,
    compose: right?.compose,
    socket: right?.socket,
    daemon: right?.daemon
  });
}

async function prepareApiOnlyRuntimeUnlocked(repositoryRoot, options = {}) {
  const repository = await validateApiOnlyRepositoryRoot(repositoryRoot, options);
  const choice = selected(options); const root = suppliedRoot(repositoryRoot, options, choice.disposable);
  await ensureApiOnlyRuntimeRoot(repository, root, { create: true });
  await assertPorts(choice.ports, options.isPortAvailable ?? (async () => { throw error("API_ONLY_PORT_CHECK_REQUIRED"); }));
  const secretsDirectory = await privateDirectory(join(root, "secrets"));
  const logsDirectory = await privateDirectory(join(root, "logs"));
  const evidenceDirectory = await privateDirectory(join(root, "evidence"));
  const random = options.randomBytes ?? nativeRandomBytes;
  const generatedNames = ["mysql_app_password", "mysql_root_password", "bootstrap_admin_password", "migration_reader_password", "migration_backup_passphrase"];
  const preserved = {};
  let smokePath;
  let generated;
  if (choice.disposable) {
    const disposableNames = [
      ...Object.values(API_ONLY_CRYPTO_SECRET_BINDINGS),
      "smoke_login_password",
      ...generatedNames
    ];
    const independentlyGenerated = await generatedSecrets(disposableNames, secretsDirectory, repository, random);
    for (const [name, filename] of Object.entries(API_ONLY_CRYPTO_SECRET_BINDINGS)) {
      preserved[name] = independentlyGenerated[filename];
    }
    smokePath = join(secretsDirectory, "smoke_login_password");
    generated = Object.freeze(Object.fromEntries(generatedNames.map((name) => [name, independentlyGenerated[name]])));
  } else {
    const trialSecrets = join(repositoryRoot, ".runtime", "real-trial", "secrets");
    const stableCopyContext = { sourceDirectory: trialSecrets, destinationDirectory: secretsDirectory, repository };
    for (const [name, sourceName] of Object.entries(API_ONLY_CRYPTO_SECRET_BINDINGS)) {
      const destination = await copyStable(join(trialSecrets, sourceName), join(secretsDirectory, sourceName), stableCopyContext);
      const preservedBytes = await readStablePrivateBytes(destination, secretsDirectory, repository, {
        invalidCode: "API_ONLY_PRIVATE_FILE_INVALID",
        modeCode: "API_ONLY_PRIVATE_FILE_MUST_BE_OWNER_ONLY"
      });
      preserved[name] = backendEnvironmentValue(preservedBytes);
    }
    smokePath = await copyStable(join(trialSecrets, "trial_app_password"), join(secretsDirectory, "smoke_login_password"), stableCopyContext);
    generated = await generatedSecrets(generatedNames, secretsDirectory, repository, random);
  }
  const initialComposeRuntime = await resolveComposeRuntime(options);
  const issuedAt = options.now?.() ?? new Date().toISOString();
  const runtimeNonce = sha256(`${choice.project}:${issuedAt}:${random(16).toString("hex")}`);
  const inspection = createApiOnlyNetworkInspectionBridge(options.networkInspectionOptions ?? {});
  const [daemonNetworks, hostRoutes] = await Promise.all([
    inspection.inspectDaemonNetworks(initialComposeRuntime),
    inspection.readHostIpv4Routes()
  ]);
  const allocation = allocateApiOnlyNetwork({
    runtime: initialComposeRuntime,
    projectName: choice.project,
    runtimeNonce,
    candidates: API_ONLY_NETWORK_CANDIDATES,
    daemonNetworks,
    hostRoutes,
    issuedAt
  });
  const networkClaim = allocation.claim;
  const backend = buildApiOnlyBackendEnvironment(choice, generated, preserved, networkClaim.gatewayServiceIp);
  const environmentFile = join(root, "backend.env");
  await ensureStablePrivateBytes(environmentFile, serializeBackendEnvironment(backend), { destinationDirectory: root, repository });
  const snapshot = await gatewaySnapshot(repositoryRoot, root, repository);
  const compose = await (options.resolveCompose ?? (async () => ({ rootHash: (await createSourceContentManifest(repositoryRoot, "backend-runtime")).rootHash })))(repositoryRoot);
  const draft = { root, project: choice.project, ports: choice.ports, disposable: choice.disposable, secretsDirectory, logsDirectory, evidenceDirectory, environmentFile, smokePath, gatewaySnapshot: snapshot, composeRuntime: initialComposeRuntime, runtimeNonce, networkClaim };
  const composeInput = environment(draft, networkClaim);
  const composeRuntime = await resolveComposeRuntime(options, composeInput);
  if (!sameResolvedRuntimeAuthority(initialComposeRuntime, composeRuntime)) throw error("API_ONLY_COMPOSE_RUNTIME_CHANGED");
  const validatedComposeInput = await validateApiOnlyComposeInputs(composeRuntime, composeInput, root);
  await runResolvedCompose(composeRuntime, [
    "-f", "deploy/compose.api-only.yaml", "--project-name", choice.project, "config", "--quiet"
  ], { ...(options.composeRenderOptions ?? {}), cwd: repositoryRoot });
  await writeRuntimeSelection(root, composeRuntime, { projectName: choice.project, networkClaim }, { createdAt: issuedAt });
  const assertedSelection = await assertRuntimeSelection(root, composeRuntime, { projectName: choice.project, runtimeNonce });
  if (JSON.stringify(assertedSelection.record.ownership.networkClaim) !== JSON.stringify(networkClaim)) throw error("API_ONLY_RUNTIME_SELECTION_INVALID");
  const composeRecord = Object.freeze({ rootHash: compose.rootHash, gatewaySnapshot: snapshot.sha256, engineIdentity: composeRuntime.daemon.identity });
  await writePrivateJson(join(root, "active-project.json"), { project: choice.project, ports: choice.ports, runtimeNonce, compose: composeRecord, gatewaySnapshot: snapshot, networkClaim }, options);
  const runtime = Object.freeze({ ...draft, composeRuntime, composeRecord, backend, validatedComposeInput });
  options.emit?.(`API_ONLY_RUNTIME_PREPARED:${root}`);
  return runtime;
}

export async function prepareApiOnlyRuntime(repositoryRoot, options = {}) {
  if (options.disposable === true) return prepareApiOnlyRuntimeUnlocked(repositoryRoot, options);
  return withRetainedLifecycleAuthority(repositoryRoot, options, async (authority) => {
    rejectBlockedLifecyclePhase(authority);
    if (authority.phase === "accepted") throw error("API_ONLY_ALREADY_ACCEPTED");
    return prepareApiOnlyRuntimeUnlocked(repositoryRoot, options);
  });
}

async function loadExistingApiOnlyRuntime(repositoryRoot, options = {}) {
  // This low-level adapter is reachable only after the branded lifecycle gate
  // selected bootstrap (or from an explicitly disposable path).
  const repository = await validateApiOnlyRepositoryRoot(repositoryRoot, options);
  const choice = selected(options); const root = suppliedRoot(repositoryRoot, options, choice.disposable);
  try { await repository.filesystem.lstat(root); }
  catch (caught) {
    if (caught?.code === "ENOENT") throw error("API_ONLY_RUNTIME_NOT_PREPARED");
    throw error("API_ONLY_RUNTIME_ROOT_INVALID");
  }
  await ensureApiOnlyRuntimeRoot(repository, root, { create: false });
  const record = await readPrivateJson(join(root, "active-project.json"), "API_ONLY_ACTIVE_PROJECT_INVALID", options);
  if (!record) throw error("API_ONLY_RUNTIME_NOT_PREPARED");
  if (record.project !== choice.project || JSON.stringify(record.ports) !== JSON.stringify(choice.ports) || !HASH.test(record?.gatewaySnapshot?.sha256 ?? "") || !HASH.test(record?.compose?.gatewaySnapshot ?? "") || record.networkClaim?.projectName !== choice.project || record.networkClaim?.runtimeNonce !== record.runtimeNonce) throw error("API_ONLY_ACTIVE_PROJECT_INVALID");
  const snapshot = await validateGatewaySnapshot(root, record.gatewaySnapshot, repository);
  const initialComposeRuntime = await resolveComposeRuntime(options);
  const draft = { root, project: choice.project, ports: choice.ports, disposable: choice.disposable, secretsDirectory: join(root, "secrets"), logsDirectory: join(root, "logs"), evidenceDirectory: join(root, "evidence"), environmentFile: join(root, "backend.env"), smokePath: join(root, "secrets", "smoke_login_password"), gatewaySnapshot: snapshot, composeRuntime: initialComposeRuntime, composeRecord: record.compose, runtimeNonce: record.runtimeNonce, networkClaim: record.networkClaim, backend: null };
  const composeInput = environment(draft, record.networkClaim);
  const composeRuntime = await resolveComposeRuntime(options, composeInput);
  if (!sameResolvedRuntimeAuthority(initialComposeRuntime, composeRuntime) || record.compose.engineIdentity !== composeRuntime.daemon.identity) throw error("API_ONLY_ACCEPTED_EVIDENCE_INVALID");
  const assertedSelection = await assertRuntimeSelection(root, composeRuntime, { projectName: choice.project, runtimeNonce: record.runtimeNonce });
  if (JSON.stringify(assertedSelection.record.ownership.networkClaim) !== JSON.stringify(record.networkClaim)) throw error("API_ONLY_RUNTIME_SELECTION_INVALID");
  const validatedComposeInput = await validateApiOnlyComposeInputs(composeRuntime, composeInput, root);
  return Object.freeze({ ...draft, composeRuntime, validatedComposeInput });
}
async function loadRuntime(repositoryRoot, options = {}) {
  try { return await loadExistingApiOnlyRuntime(repositoryRoot, options); }
  catch (caught) {
    if (caught?.message !== "API_ONLY_RUNTIME_NOT_PREPARED") throw caught;
    return prepareApiOnlyRuntimeUnlocked(repositoryRoot, options);
  }
}
async function invoke(repositoryRoot, runtime, args, options) {
  const call = apiOnlyComposeInvocation(runtime, args);
  const inspection = createApiOnlyNetworkInspectionBridge(options.networkInspectionOptions ?? {});
  const authorization = await revalidateApiOnlyNetworkClaim({
    runtime: runtime.composeRuntime,
    claim: runtime.networkClaim,
    expectedProjectName: runtime.project,
    expectedRuntimeNonce: runtime.runtimeNonce,
    inspectDaemonNetworks: (composeRuntime) => inspection.inspectDaemonNetworks(composeRuntime),
    readHostIpv4Routes: () => inspection.readHostIpv4Routes()
  });
  const mutationEnvironment = composeEnvironmentForNetworkClaim(runtime.composeRuntime, authorization, runtime.validatedComposeInput);
  const composeMutationOptions = { ...(options.composeMutationOptions ?? {}) };
  if (args.includes("--build") && composeMutationOptions.timeoutMs === undefined) composeMutationOptions.timeoutMs = 600_000;
  const result = await runResolvedCompose(runtime.composeRuntime, call.args, {
    ...composeMutationOptions,
    cwd: repositoryRoot,
    environment: mutationEnvironment,
    networkAuthorization: authorization
  });
  if (args[0] === "up" && args.includes("gateway")) {
    await verifyApiOnlyNetworkAfterCreate({
      runtime: runtime.composeRuntime,
      authorization,
      inspectNetwork: (composeRuntime, claim) => inspection.inspectNetwork(composeRuntime, claim),
      inspectGatewayService: (composeRuntime, claim) => inspection.inspectGatewayService(composeRuntime, claim)
    });
  }
  return result;
}

async function promoteBootstrapNetworkClaim(runtime, options = {}) {
  const inspection = createApiOnlyNetworkInspectionBridge(options.networkInspectionOptions ?? {});
  const [daemonNetworks, hostRoutes] = await Promise.all([
    inspection.inspectDaemonNetworks(runtime.composeRuntime),
    inspection.readHostIpv4Routes()
  ]);
  const allocation = allocateApiOnlyNetwork({
    runtime: runtime.composeRuntime,
    projectName: runtime.project,
    runtimeNonce: runtime.runtimeNonce,
    candidates: [runtime.networkClaim.subnet],
    ipamGatewayIp: runtime.networkClaim.ipamGatewayIp,
    gatewayServiceIp: runtime.networkClaim.gatewayServiceIp,
    daemonNetworks,
    hostRoutes,
    issuedAt: runtime.networkClaim.issuedAt
  });
  if (allocation.reuseExisting !== true || allocation.claim.existingNetwork === null) {
    throw error("API_ONLY_NETWORK_POST_CREATE_MISMATCH");
  }
  const expectedClaim = { ...runtime.networkClaim, existingNetwork: allocation.claim.existingNetwork };
  if (JSON.stringify(allocation.claim) !== JSON.stringify(expectedClaim)) {
    throw error("API_ONLY_NETWORK_POST_CREATE_MISMATCH");
  }
  const inspectedNetwork = await inspection.inspectNetwork(runtime.composeRuntime, allocation.claim);
  if (inspectedNetwork.id !== allocation.claim.existingNetwork.id
    || inspectedNetwork.name !== allocation.claim.existingNetwork.name) {
    throw error("API_ONLY_NETWORK_POST_CREATE_MISMATCH");
  }

  const priorSelection = await assertRuntimeSelection(runtime.root, runtime.composeRuntime, {
    projectName: runtime.project,
    runtimeNonce: runtime.runtimeNonce
  });
  if (JSON.stringify(priorSelection.record.ownership.networkClaim) !== JSON.stringify(runtime.networkClaim)) {
    throw error("API_ONLY_RUNTIME_SELECTION_INVALID");
  }
  await writeRuntimeSelection(runtime.root, runtime.composeRuntime, {
    projectName: runtime.project,
    networkClaim: allocation.claim
  }, { createdAt: priorSelection.record.createdAt });
  const promotedSelection = await assertRuntimeSelection(runtime.root, runtime.composeRuntime, {
    projectName: runtime.project,
    runtimeNonce: runtime.runtimeNonce
  });
  if (JSON.stringify(promotedSelection.record.ownership.networkClaim) !== JSON.stringify(allocation.claim)) {
    throw error("API_ONLY_RUNTIME_SELECTION_INVALID");
  }
  const activeProject = await writePrivateJson(join(runtime.root, "active-project.json"), {
    project: runtime.project,
    ports: runtime.ports,
    runtimeNonce: runtime.runtimeNonce,
    compose: runtime.composeRecord,
    gatewaySnapshot: runtime.gatewaySnapshot,
    networkClaim: allocation.claim
  }, options);
  if (JSON.stringify(activeProject.networkClaim) !== JSON.stringify(allocation.claim)) {
    throw error("API_ONLY_ACTIVE_PROJECT_INVALID");
  }
  return allocation.claim;
}

function validMysqlHealthObservation(observation, expected) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) return false;
  const keys = ["status", "project", "runtimeNonce", "networkId", "networkName", "service", "containerId"];
  if (Object.keys(observation).length !== keys.length || keys.some((key) => !Object.hasOwn(observation, key))) return false;
  return observation.status === "healthy"
    && observation.project === expected.project
    && observation.runtimeNonce === expected.runtimeNonce
    && observation.networkId === expected.network.id
    && observation.networkName === expected.network.name
    && observation.service === "mysql"
    && HASH.test(observation.containerId);
}

async function waitForBootstrapMysqlHealth(runtime, networkClaim, options = {}) {
  const controller = new AbortController();
  const useDefault = options.waitForMysqlHealth == null && runtime.disposable;
  const waitForMysqlHealth = options.waitForMysqlHealth ?? (useDefault
    ? (expected) => waitForDisposableMysqlHealth(runtime.composeRuntime, expected, {
      ...options, disposableEngineSignal: controller.signal
    })
    : undefined);
  const timeoutMs = options.mysqlHealthTimeoutMs ?? DEFAULT_MYSQL_HEALTH_TIMEOUT_MS;
  const setTimer = options.mysqlHealthSetTimeout ?? setTimeout;
  const clearTimer = options.mysqlHealthClearTimeout ?? clearTimeout;
  if (typeof waitForMysqlHealth !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_MYSQL_HEALTH_TIMEOUT_MS || timeoutMs > MAX_MYSQL_HEALTH_TIMEOUT_MS) {
    throw error("API_ONLY_MYSQL_HEALTH_ADAPTER_INVALID");
  }
  const expected = Object.freeze({
    project: runtime.project,
    runtimeNonce: runtime.runtimeNonce,
    host: "127.0.0.1",
    port: runtime.ports.mysql,
    timeoutMs,
    network: Object.freeze({ ...networkClaim.existingNetwork })
  });
  let timer;
  const timeout = new Promise((_, rejectTimeout) => {
    timer = setTimer(() => {
      rejectTimeout(error("API_ONLY_MYSQL_HEALTH_TIMEOUT"));
      controller.abort();
    }, timeoutMs);
  });
  const healthCheck = Promise.resolve().then(() => waitForMysqlHealth(expected));
  let observation;
  try {
    observation = await Promise.race([healthCheck, timeout]);
  } catch (caught) {
    if (caught?.message === "API_ONLY_MYSQL_HEALTH_TIMEOUT") throw caught;
    throw error("API_ONLY_MYSQL_HEALTH_FAILED");
  } finally {
    clearTimer(timer);
    controller.abort();
    if (useDefault) await healthCheck.catch(() => {});
  }
  if (!validMysqlHealthObservation(observation, expected)) throw error("API_ONLY_MYSQL_HEALTH_IDENTITY_MISMATCH");
  return Object.freeze({ ...observation });
}

async function defaultHttpHealthRequest(input) {
  const response = await fetch(input.url, {
    method: "GET",
    redirect: "error",
    signal: input.signal,
    headers: { accept: "application/json, text/plain;q=0.9" }
  });
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null
    && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > input.maximumBytes)) {
    throw error("API_ONLY_HTTP_HEALTH_BODY_INVALID");
  }
  const chunks = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const bytes = Buffer.from(part.value);
        total += bytes.length;
        if (total > input.maximumBytes) throw error("API_ONLY_HTTP_HEALTH_BODY_INVALID");
        chunks.push(bytes);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return {
    url: response.url,
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: Buffer.concat(chunks, total).toString("utf8")
  };
}

function validHttpHealthResponse(response, expectedUrl) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return false;
  const keys = ["url", "status", "contentType", "body"];
  return Object.keys(response).length === keys.length
    && keys.every((key) => Object.hasOwn(response, key))
    && response.url === expectedUrl
    && response.status === 200
    && typeof response.contentType === "string"
    && typeof response.body === "string"
    && !response.body.includes("\uFFFD")
    && Buffer.byteLength(response.body, "utf8") <= MAX_HTTP_HEALTH_BYTES;
}

async function probeBootstrapHttpHealth(origin, path, kind, options = {}) {
  const timeoutMs = options.httpHealthTimeoutMs ?? DEFAULT_MYSQL_HEALTH_TIMEOUT_MS;
  const requestHttpHealth = options.requestHttpHealth ?? defaultHttpHealthRequest;
  const setTimer = options.httpHealthSetTimeout ?? setTimeout;
  const clearTimer = options.httpHealthClearTimeout ?? clearTimeout;
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(origin)
    || !["gateway", "backend"].includes(kind)
    || typeof requestHttpHealth !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_MYSQL_HEALTH_TIMEOUT_MS || timeoutMs > MAX_MYSQL_HEALTH_TIMEOUT_MS) {
    throw error("API_ONLY_HTTP_HEALTH_ADAPTER_INVALID");
  }
  const url = `${origin}${path}`;
  const controller = new AbortController();
  const input = Object.freeze({ url, method: "GET", maximumBytes: MAX_HTTP_HEALTH_BYTES, signal: controller.signal });
  const prefix = kind === "gateway" ? "API_ONLY_GATEWAY" : "API_ONLY_BACKEND";
  let timer;
  const timeout = new Promise((_, rejectTimeout) => {
    timer = setTimer(() => {
      controller.abort();
      rejectTimeout(error(`${prefix}_HEALTH_TIMEOUT`));
    }, timeoutMs);
  });
  let response;
  try {
    response = await Promise.race([Promise.resolve().then(() => requestHttpHealth(input)), timeout]);
  } catch (caught) {
    if (caught?.message === `${prefix}_HEALTH_TIMEOUT`) throw caught;
    throw error(`${prefix}_HEALTH_FAILED`);
  } finally {
    clearTimer(timer);
  }
  if (!validHttpHealthResponse(response, url)) throw error(`${prefix}_HEALTH_RESPONSE_INVALID`);
  const mediaType = response.contentType.toLowerCase().split(";", 1)[0].trim();
  if (kind === "gateway") {
    if (mediaType !== "text/plain" || response.body !== "ok\n") throw error("API_ONLY_GATEWAY_HEALTH_RESPONSE_INVALID");
    return Object.freeze({ ok: true });
  }
  let payload;
  try { payload = JSON.parse(response.body); } catch { throw error("API_ONLY_BACKEND_HEALTH_RESPONSE_INVALID"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.ok !== true || payload.store !== "mysql"
    || mediaType !== "application/json") throw error("API_ONLY_BACKEND_HEALTH_RESPONSE_INVALID");
  return Object.freeze({ ok: true, store: "mysql" });
}

async function inspectBootstrapBackendEvidence(runtime, networkClaim, options = {}) {
  const inspect = options.inspectBootstrapBackendImage
    ?? (runtime.disposable === true
      ? (expected) => inspectDisposableService(runtime.composeRuntime, expected, options)
      : null);
  if (typeof inspect !== "function" || networkClaim.existingNetwork === null) {
    throw error("API_ONLY_BOOTSTRAP_BACKEND_INSPECTOR_REQUIRED");
  }
  const expected = Object.freeze({
    project: runtime.project,
    runtimeNonce: runtime.runtimeNonce,
    network: Object.freeze({ ...networkClaim.existingNetwork }),
    service: "backend"
  });
  let observation;
  try { observation = await inspect(expected); }
  catch { throw error("API_ONLY_BOOTSTRAP_BACKEND_INSPECTION_FAILED"); }
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw error("API_ONLY_BOOTSTRAP_BACKEND_IDENTITY_MISMATCH");
  }
  const keys = ["project", "runtimeNonce", "networkId", "networkName", "service", "containerId", "imageIdDigest"];
  if (Object.keys(observation).length !== keys.length || keys.some((key) => !Object.hasOwn(observation, key))
    || observation.project !== expected.project
    || observation.runtimeNonce !== expected.runtimeNonce
    || observation.networkId !== expected.network.id
    || observation.networkName !== expected.network.name
    || observation.service !== expected.service
    || !HASH.test(observation.containerId)
    || !IMAGE_ID_DIGEST.test(observation.imageIdDigest)) {
    throw error("API_ONLY_BOOTSTRAP_BACKEND_IDENTITY_MISMATCH");
  }
  return Object.freeze({ containerId: observation.containerId, imageIdDigest: observation.imageIdDigest });
}

async function startApiOnlyDatabaseUnlocked(repositoryRoot, options = {}) {
  const runtime = await loadRuntime(repositoryRoot, options);
  await assertPorts(runtime.ports, options.isPortAvailable ?? (async () => { throw error("API_ONLY_PORT_CHECK_REQUIRED"); }));
  const result = await invoke(repositoryRoot, runtime, ["up", "-d", "mysql"], options);
  const networkClaim = await promoteBootstrapNetworkClaim(runtime, options);
  await waitForBootstrapMysqlHealth(runtime, networkClaim, options);
  return result;
}
async function startApiOnlyRuntimeUnlocked(repositoryRoot, options = {}) {
  const runtime = await loadRuntime(repositoryRoot, options);
  await assertPorts(runtime.ports, options.isPortAvailable ?? (async () => { throw error("API_ONLY_PORT_CHECK_REQUIRED"); }));
  const result = await invoke(repositoryRoot, runtime, ["up", "-d", "--build", "mysql", "backend", "gateway"], options);
  const networkClaim = await promoteBootstrapNetworkClaim(runtime, options);
  const origin = `http://127.0.0.1:${runtime.ports.gateway}`;
  await Promise.all([
    probeBootstrapHttpHealth(origin, "/healthz", "gateway", options),
    probeBootstrapHttpHealth(origin, "/api/health", "backend", options)
  ]);
  const backend = await inspectBootstrapBackendEvidence(runtime, networkClaim, options);
  const createdAt = options.now?.() ?? new Date().toISOString();
  if (!validUtcTimestamp(createdAt)) throw error("API_ONLY_BOOTSTRAP_STATUS_TIME_INVALID");
  await writePrivateJson(join(runtime.root, "status.json"), {
    schema: "shensi.api-only.bootstrap-status",
    version: 1,
    project: runtime.project,
    origin,
    socketIdentity: runtime.composeRuntime.socket.identity,
    daemonIdentity: runtime.composeRuntime.daemon.identity,
    runtimeNonce: runtime.runtimeNonce,
    network: {
      id: networkClaim.existingNetwork.id,
      name: networkClaim.existingNetwork.name,
      claimSha256: sha256(JSON.stringify(networkClaim))
    },
    backend,
    gatewaySnapshotSha256: runtime.gatewaySnapshot.sha256,
    createdAt
  }, options);
  return result;
}

function boundedStatusText(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseApiOnlyPsOutput(result, project) {
  if (!result || typeof result !== "object" || result.code !== 0 || result.truncated !== false
    || typeof result.output !== "string" || Buffer.byteLength(result.output, "utf8") > MAX_STATUS_OUTPUT_BYTES) {
    throw error("API_ONLY_STATUS_OUTPUT_INVALID");
  }
  let rows;
  try { rows = JSON.parse(result.output); } catch { throw error("API_ONLY_STATUS_OUTPUT_INVALID"); }
  if (!Array.isArray(rows) || rows.length > 3) throw error("API_ONLY_STATUS_OUTPUT_INVALID");
  const services = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || row.Project !== project
      || !["mysql", "backend", "gateway"].includes(row.Service)
      || seen.has(row.Service)
      || !boundedStatusText(row.Name)
      || !["created", "running", "restarting", "exited", "paused", "dead", "removing"].includes(row.State)
      || typeof row.Health !== "string"
      || !["", "healthy", "unhealthy", "starting"].includes(row.Health)
      || !Number.isSafeInteger(row.ExitCode) || row.ExitCode < 0 || row.ExitCode > 255) {
      throw error("API_ONLY_STATUS_OUTPUT_INVALID");
    }
    seen.add(row.Service);
    services.push(Object.freeze({
      name: row.Name,
      service: row.Service,
      state: row.State,
      health: row.Health || "none",
      exitCode: row.ExitCode
    }));
  }
  return Object.freeze(services);
}

async function waitForApiOnlyPortsReleased(ports, options = {}) {
  const isPortAvailable = options.isPortAvailable;
  const timeoutMs = options.portReleaseTimeoutMs ?? 30_000;
  const pollIntervalMs = options.portReleasePollIntervalMs ?? 100;
  const monotonicNow = options.portReleaseMonotonicNow ?? (() => performance.now());
  const sleep = options.portReleaseSleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  if (typeof isPortAvailable !== "function" || typeof monotonicNow !== "function" || typeof sleep !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 5_000 || pollIntervalMs > timeoutMs) {
    throw error("API_ONLY_PORT_RELEASE_ADAPTER_INVALID");
  }
  const startedAt = monotonicNow();
  if (!Number.isFinite(startedAt)) throw error("API_ONLY_PORT_RELEASE_ADAPTER_INVALID");
  const deadline = startedAt + timeoutMs;
  while (true) {
    let released;
    try { released = await Promise.all(Object.values(ports).map((port) => isPortAvailable(port))); }
    catch { throw error("API_ONLY_PORT_RELEASE_CHECK_FAILED"); }
    if (released.some((value) => typeof value !== "boolean")) throw error("API_ONLY_PORT_RELEASE_CHECK_FAILED");
    if (released.every(Boolean)) return;
    const current = monotonicNow();
    if (!Number.isFinite(current)) throw error("API_ONLY_PORT_RELEASE_ADAPTER_INVALID");
    if (current >= deadline) throw error("API_ONLY_PORT_RELEASE_TIMEOUT");
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - current)));
  }
}

export async function startApiOnlyRuntime(repositoryRoot, options = {}) {
  if (options.disposable === true) return startApiOnlyRuntimeUnlocked(repositoryRoot, options);
  return withRetainedLifecycleAuthority(repositoryRoot, options, async (authority) => {
    rejectBlockedLifecyclePhase(authority);
    if (authority.phase === "accepted") {
      const database = await runAcceptedSuboperation(repositoryRoot, authority, "start-mysql", options);
      const runtime = await runAcceptedSuboperation(repositoryRoot, database.authority, "start-runtime", options);
      const origin = `http://127.0.0.1:${runtime.projection.expectedResources.ports.gateway}`;
      await Promise.all([
        probeBootstrapHttpHealth(origin, "/healthz", "gateway", options),
        probeBootstrapHttpHealth(origin, "/api/health", "backend", options)
      ]);
      await revalidateAcceptedProof(repositoryRoot, runtime.authority, runtime.observation, "start-runtime", options);
      return runtime.result;
    }
    return startApiOnlyRuntimeUnlocked(repositoryRoot, options);
  });
}
async function stopApiOnlyRuntimeUnlocked(repositoryRoot, options = {}) {
  const runtime = await loadExistingApiOnlyRuntime(repositoryRoot, options);
  const result = await invoke(repositoryRoot, runtime, ["stop"], options);
  await waitForApiOnlyPortsReleased(runtime.ports, options);
  return result;
}
async function apiOnlyStatusUnlocked(repositoryRoot, options = {}) {
  const runtime = await loadExistingApiOnlyRuntime(repositoryRoot, options);
  const result = await invoke(repositoryRoot, runtime, ["ps", "--format", "json"], options);
  const services = parseApiOnlyPsOutput(result, runtime.project);
  const origin = `http://127.0.0.1:${runtime.ports.gateway}`;
  const health = await Promise.allSettled([
    probeBootstrapHttpHealth(origin, "/healthz", "gateway", options),
    probeBootstrapHttpHealth(origin, "/api/health", "backend", options)
  ]);
  return Object.freeze({ project: runtime.project, origin, services, healthy: health.every(({ status }) => status === "fulfilled") });
}

export async function startApiOnlyDatabase(repositoryRoot, options = {}) {
  if (options.disposable === true) return startApiOnlyDatabaseUnlocked(repositoryRoot, options);
  return withRetainedLifecycleAuthority(repositoryRoot, options, async (authority) => {
    rejectBlockedLifecyclePhase(authority);
    if (authority.phase === "accepted") return (await runAcceptedSuboperation(repositoryRoot, authority, "start-mysql", options)).result;
    return startApiOnlyDatabaseUnlocked(repositoryRoot, options);
  });
}

export async function stopApiOnlyRuntime(repositoryRoot, options = {}) {
  if (options.disposable === true) return stopApiOnlyRuntimeUnlocked(repositoryRoot, options);
  const preliminary = await authorityResolver.readLifecycleAuthority(repositoryRoot);
  if (preliminary.phase === "bootstrap") await loadExistingApiOnlyRuntime(repositoryRoot, options);
  return withRetainedLifecycleAuthority(repositoryRoot, options, async (authority) => {
    rejectBlockedLifecyclePhase(authority);
    if (authority.phase === "accepted") {
      const stopped = await runAcceptedSuboperation(repositoryRoot, authority, "stop", options);
      await waitForApiOnlyPortsReleased(stopped.projection.expectedResources.ports, options);
      const final = await revalidateAcceptedProof(repositoryRoot, stopped.authority, stopped.observation, "stop", options);
      const exactStopped = final.observation.mysql.state === "clean-stopped"
        && ["absent", "clean-stopped"].includes(final.observation.backend.state)
        && ["absent", "clean-stopped"].includes(final.observation.gateway.state);
      if (!exactStopped) throw error("API_ONLY_ACCEPTED_OPERATION_FAILED_CLOSED");
      return stopped.result;
    }
    return stopApiOnlyRuntimeUnlocked(repositoryRoot, options);
  });
}

export async function apiOnlyStatus(repositoryRoot, options = {}) {
  if (options.disposable === true) return apiOnlyStatusUnlocked(repositoryRoot, options);
  const preliminary = await authorityResolver.readLifecycleAuthority(repositoryRoot);
  if (preliminary.phase === "bootstrap") await loadExistingApiOnlyRuntime(repositoryRoot, options);
  return withRetainedLifecycleAuthority(repositoryRoot, options, async (authority) => {
    if (["migration", "write_activation_pending"].includes(authority.phase)) {
      return Object.freeze({ phase: authority.phase, migration: authority.migration });
    }
    if (authority.phase === "accepted") {
      const status = await runAcceptedSuboperation(repositoryRoot, authority, "status", options);
      const ready = status.observation.mysql.state === "running" && status.observation.mysql.healthy === true
        && status.observation.backend.state === "running" && status.observation.backend.healthy === true
        && status.observation.gateway.state === "running";
      const origin = `http://127.0.0.1:${status.projection.expectedResources.ports.gateway}`;
      const health = ready ? await Promise.allSettled([
        probeBootstrapHttpHealth(origin, "/healthz", "gateway", options),
        probeBootstrapHttpHealth(origin, "/api/health", "backend", options)
      ]) : [];
      await revalidateAcceptedProof(repositoryRoot, status.authority, status.observation, "status", options);
      return Object.freeze({
        project: status.projection.expectedResources.project,
        origin,
        services: status.result.services,
        healthy: ready && health.every(({ status: state }) => state === "fulfilled")
      });
    }
    return apiOnlyStatusUnlocked(repositoryRoot, options);
  });
}

function lockPath(root, disposable) { return join(root, disposable ? DISPOSABLE_LOCK_NAME : LOCK_NAME); }
async function nativeProcessStartToken(pid) {
  let result;
  try {
    result = await execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      maxBuffer: 4_096,
      shell: false,
      timeout: 2_000
    });
  } catch (caught) {
    if (Number(caught?.code) === 1) return null;
    throw error("API_ONLY_OWNER_LOCK_LIVENESS_UNAVAILABLE");
  }
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1 || Buffer.byteLength(lines[0], "utf8") > 512 || lines[0].includes("\0")) throw error("API_ONLY_OWNER_LOCK_LIVENESS_UNAVAILABLE");
  return sha256(`${pid}\0${lines[0]}`);
}
async function readProcessStartToken(pid, input = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw error("API_ONLY_OWNER_LOCK_LIVENESS_UNAVAILABLE");
  const reader = input.readProcessStartToken ?? nativeProcessStartToken;
  if (typeof reader !== "function") throw error("API_ONLY_OWNER_LOCK_LIVENESS_UNAVAILABLE");
  let token;
  try { token = await reader(pid); } catch (caught) {
    if (caught?.message === "API_ONLY_OWNER_LOCK_LIVENESS_UNAVAILABLE") throw caught;
    throw error("API_ONLY_OWNER_LOCK_LIVENESS_UNAVAILABLE");
  }
  if (token === null) return null;
  if (typeof token !== "string" || !token || token.includes("\0") || Buffer.byteLength(token, "utf8") > 512) throw error("API_ONLY_OWNER_LOCK_LIVENESS_UNAVAILABLE");
  return token;
}
function validOwnerLockRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const keys = ["project", "ports", "pid", "processStartToken", "nonce", "engineIdHash", "createdAt"];
  if (Object.keys(record).length !== keys.length || keys.some((key, index) => Object.keys(record)[index] !== key)) return false;
  let project;
  try { project = safeProject(record.project); } catch { return false; }
  if (!record.ports || typeof record.ports !== "object" || Array.isArray(record.ports)
    || Object.keys(record.ports).length !== 2
    || Object.keys(record.ports)[0] !== "gateway"
    || Object.keys(record.ports)[1] !== "mysql") return false;
  const disposable = project.startsWith("shensi-api-empty-");
  const expectedPorts = disposable
    ? { gateway: API_ONLY_PORTS.emptyGateway, mysql: API_ONLY_PORTS.emptyMysql }
    : { gateway: API_ONLY_PORTS.gateway, mysql: API_ONLY_PORTS.mysql };
  return Number.isSafeInteger(record.pid)
    && record.pid > 0
    && typeof record.processStartToken === "string"
    && record.processStartToken.length > 0
    && Buffer.byteLength(record.processStartToken, "utf8") <= 512
    && !record.processStartToken.includes("\0")
    && LOCK_NONCE.test(record.nonce)
    && HASH.test(record.engineIdHash)
    && validUtcTimestamp(record.createdAt)
    && record.ports.gateway === expectedPorts.gateway
    && record.ports.mysql === expectedPorts.mysql
    && (disposable || project === "shensi-api");
}
export async function acquireApiOnlyOwnerLock(repositoryRoot, input = {}) {
  const choice = selected(input);
  let processInfo;
  try {
    processInfo = input.processInfo
      ? await input.processInfo()
      : { pid: process.pid, startToken: await readProcessStartToken(process.pid, input) };
  }
  catch { throw error("API_ONLY_OWNER_LOCK_INPUT_INVALID"); }
  if (!Number.isSafeInteger(processInfo?.pid)
    || processInfo.pid < 1
    || typeof processInfo.startToken !== "string"
    || !processInfo.startToken
    || processInfo.startToken.includes("\0")
    || Buffer.byteLength(processInfo.startToken, "utf8") > 512) throw error("API_ONLY_OWNER_LOCK_INPUT_INVALID");
  const random = input.randomBytes ?? nativeRandomBytes;
  let nonceBytes;
  try { nonceBytes = random(16); } catch { throw error("API_ONLY_OWNER_LOCK_INPUT_INVALID"); }
  if (!(Buffer.isBuffer(nonceBytes) || nonceBytes instanceof Uint8Array) || nonceBytes.byteLength !== 16) throw error("API_ONLY_OWNER_LOCK_INPUT_INVALID");
  const engineIdentity = input.engineIdentity ?? "unresolved";
  if (typeof engineIdentity !== "string" || !engineIdentity || engineIdentity.includes("\0") || Buffer.byteLength(engineIdentity, "utf8") > 4_096) throw error("API_ONLY_OWNER_LOCK_INPUT_INVALID");
  let createdAt;
  try { createdAt = input.now?.() ?? new Date().toISOString(); } catch { throw error("API_ONLY_OWNER_LOCK_INPUT_INVALID"); }
  if (!validUtcTimestamp(createdAt)) throw error("API_ONLY_OWNER_LOCK_INPUT_INVALID");
  const record = {
    project: choice.project,
    ports: choice.ports,
    pid: processInfo.pid,
    processStartToken: processInfo.startToken,
    nonce: Buffer.from(nonceBytes).toString("hex"),
    engineIdHash: sha256(engineIdentity),
    createdAt
  };
  if (!validOwnerLockRecord(record)) throw error("API_ONLY_OWNER_LOCK_INPUT_INVALID");
  const repository = await validateApiOnlyRepositoryRoot(repositoryRoot, input);
  const root = suppliedRoot(repositoryRoot, input, input.disposable === true);
  await ownerLockDirectory(repository, root);
  const path = lockPath(root, choice.disposable);
  try { await writeFile(path, json(record), { flag: "wx", mode: PRIVATE_MODE }); await chmod(path, PRIVATE_MODE); }
  catch (caught) {
    if (caught?.code !== "EEXIST") throw caught;
    const existingSnapshot = await readPrivateJsonSnapshot(path, "API_ONLY_OWNER_LOCK_INVALID", input);
    const existing = existingSnapshot?.value;
    if (!validOwnerLockRecord(existing)) throw error("API_ONLY_OWNER_LOCK_INVALID");
    let current;
    if (input.isProcessCurrent !== undefined) {
      if (typeof input.isProcessCurrent !== "function") throw error("API_ONLY_OWNER_LOCK_LIVENESS_UNAVAILABLE");
      try { current = await input.isProcessCurrent(existing.pid, existing.processStartToken); }
      catch { throw error("API_ONLY_OWNER_LOCK_LIVENESS_UNAVAILABLE"); }
      if (typeof current !== "boolean") throw error("API_ONLY_OWNER_LOCK_LIVENESS_UNAVAILABLE");
    } else {
      current = await readProcessStartToken(existing.pid, input) === existing.processStartToken;
    }
    if (current) throw error("API_ONLY_OWNER_LOCK_HELD");
    if (!existing?.nonce || !existing?.processStartToken) throw error("API_ONLY_OWNER_LOCK_INVALID");
    await input.beforeStaleLockRemoval?.(path, existing);
    const confirmed = await readPrivateJsonSnapshot(path, "API_ONLY_OWNER_LOCK_CHANGED", input);
    if (!confirmed
      || confirmed.canonicalText !== existingSnapshot.canonicalText
      || !sameDirectoryIdentity(confirmed.identity, existingSnapshot.identity)) throw error("API_ONLY_OWNER_LOCK_CHANGED");
    await (input.unlink ?? unlink)(path);
    return acquireApiOnlyOwnerLock(repositoryRoot, input);
  }
  return Object.freeze({ path, ...record });
}
export async function releaseApiOnlyOwnerLock(lock, options = {}) {
  if (!lock?.path || !lock?.nonce) throw error("API_ONLY_OWNER_LOCK_OWNER_MISMATCH");
  const snapshot = await readPrivateJsonSnapshot(lock.path, "API_ONLY_OWNER_LOCK_OWNER_MISMATCH", options);
  const record = snapshot?.value;
  const expected = {
    project: lock.project,
    ports: lock.ports,
    pid: lock.pid,
    processStartToken: lock.processStartToken,
    nonce: lock.nonce,
    engineIdHash: lock.engineIdHash,
    createdAt: lock.createdAt
  };
  if (!validOwnerLockRecord(record) || snapshot.canonicalText !== json(expected)) throw error("API_ONLY_OWNER_LOCK_OWNER_MISMATCH");
  await options.beforeOwnerLockRelease?.(lock.path, record);
  const confirmed = await readPrivateJsonSnapshot(lock.path, "API_ONLY_OWNER_LOCK_CHANGED", options);
  if (!confirmed
    || confirmed.canonicalText !== snapshot.canonicalText
    || !sameDirectoryIdentity(confirmed.identity, snapshot.identity)) throw error("API_ONLY_OWNER_LOCK_CHANGED");
  await (options.unlink ?? unlink)(lock.path);
}

export async function validateDisposableApiOnlyOwnerLock(repositoryRoot, options = {}) {
  absolute(repositoryRoot, "API_ONLY_REPOSITORY_ROOT_INVALID");
  if (!LOCK_NONCE.test(options.nonce ?? "")) throw error("API_ONLY_OWNER_LOCK_INVALID");
  const repository = await validateApiOnlyRepositoryRoot(repositoryRoot, options);
  const base = join(repositoryRoot, ".runtime", "api-only-empty");
  try { await pinPrivateDirectoryTree(repository, base, "API_ONLY_OWNER_LOCK_INVALID"); }
  catch { throw error("API_ONLY_OWNER_LOCK_INVALID"); }
  const path = join(base, DISPOSABLE_LOCK_NAME);
  let snapshot;
  try { snapshot = await readPrivateJsonSnapshot(path, "API_ONLY_OWNER_LOCK_INVALID", options); }
  catch { throw error("API_ONLY_OWNER_LOCK_INVALID"); }
  const record = snapshot?.value;
  if (!validOwnerLockRecord(record)
    || !DISPOSABLE_PROJECT.test(record.project)
    || record.nonce !== options.nonce) throw error("API_ONLY_OWNER_LOCK_INVALID");
  let live;
  try {
    live = options.isProcessCurrent === undefined
      ? await readProcessStartToken(record.pid, options) === record.processStartToken
      : await options.isProcessCurrent(record.pid, record.processStartToken);
  } catch { throw error("API_ONLY_OWNER_LOCK_LIVENESS_UNAVAILABLE"); }
  if (live !== true) throw error("API_ONLY_OWNER_LOCK_INVALID");
  const resolveRuntime = options.resolveComposeRuntimeForOwnerLockValidation
    ?? (() => resolveComposeRuntime(options));
  let runtime;
  try { runtime = await resolveRuntime(); }
  catch { throw error("API_ONLY_OWNER_LOCK_ENGINE_INVALID"); }
  if (!runtime?.daemon?.identity
    || sha256(runtime.daemon.identity) !== record.engineIdHash) {
    throw error("API_ONLY_OWNER_LOCK_ENGINE_INVALID");
  }
  let confirmed;
  try { confirmed = await readPrivateJsonSnapshot(path, "API_ONLY_OWNER_LOCK_CHANGED", options); }
  catch { throw error("API_ONLY_OWNER_LOCK_CHANGED"); }
  if (!confirmed || confirmed.canonicalText !== snapshot.canonicalText
    || !sameDirectoryIdentity(confirmed.identity, snapshot.identity)) {
    throw error("API_ONLY_OWNER_LOCK_CHANGED");
  }
  return Object.freeze({ path, ...record });
}

function disposableRuntimeIdentity(runtime) {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw error("API_ONLY_DISPOSABLE_RUNTIME_INVALID");
  }
  const match = DISPOSABLE_PROJECT.exec(runtime.project ?? "");
  if (!match) throw error("API_ONLY_DISPOSABLE_PROJECT_REQUIRED");
  const repositoryRoot = runtime.repositoryRoot;
  absolute(repositoryRoot, "API_ONLY_DISPOSABLE_RUNTIME_ROOT_INVALID");
  const expectedBase = join(repositoryRoot, ".runtime", "api-only-empty");
  const expectedRoot = join(expectedBase, match[1]);
  if (runtime.root !== expectedRoot) throw error("API_ONLY_DISPOSABLE_RUNTIME_ROOT_INVALID");
  if (!runtime.ports || runtime.ports.gateway !== API_ONLY_PORTS.emptyGateway
    || runtime.ports.mysql !== API_ONLY_PORTS.emptyMysql
    || Object.keys(runtime.ports).length !== 2) throw error("API_ONLY_DISPOSABLE_RUNTIME_INVALID");
  return Object.freeze({ suffix: match[1], repositoryRoot, base: expectedBase, root: expectedRoot });
}

async function validateDisposableRetainedEvidence(runtime, identity, options = {}) {
  const evidence = runtime.retainedEvidence;
  const emptyPath = join(identity.repositoryRoot, ".runtime", "api-only", "evidence", "empty", `${identity.suffix}.json`);
  const desktopStoragePath = join(identity.repositoryRoot, ".runtime", "api-only", "evidence",
    "desktop-action-storage", `${identity.suffix}.json`);
  const desktopBridgeMysqlPath = join(identity.repositoryRoot, ".runtime", "api-only", "evidence",
    "desktop-action-bridge-mysql", `${identity.suffix}.json`);
  const multiMacCrmMysqlPath = join(identity.repositoryRoot, ".runtime", "api-only", "evidence",
    "multi-mac-crm-mysql", `${identity.suffix}.json`);
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)
    || Object.keys(evidence).length !== 2
    || ![emptyPath, desktopStoragePath, desktopBridgeMysqlPath, multiMacCrmMysqlPath].includes(evidence.path)
    || !HASH.test(evidence.sha256)) throw error("API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
  let snapshot;
  try { snapshot = await readPrivateJsonSnapshot(evidence.path, "API_ONLY_DISPOSABLE_EVIDENCE_INVALID", options); }
  catch { throw error("API_ONLY_DISPOSABLE_EVIDENCE_INVALID"); }
  if (!snapshot || sha256(snapshot.canonicalText) !== evidence.sha256) {
    throw error("API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
  }
  if ([desktopStoragePath, desktopBridgeMysqlPath, multiMacCrmMysqlPath].includes(evidence.path)) {
    const bridgeMysql = evidence.path === desktopBridgeMysqlPath;
    const multiMacCrmMysql = evidence.path === multiMacCrmMysqlPath;
    const value = snapshot.value;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || JSON.stringify(Object.keys(value)) !== JSON.stringify([
        "schema", "version", "result", "verifiedAt", "project", "projectSuffix", "ports", "suite"
      ])
      || value.schema !== (bridgeMysql ? "shensi.desktop-action-bridge-mysql.cleanup-receipt"
        : multiMacCrmMysql ? "shensi.multi-mac-crm-mysql.cleanup-receipt"
          : "shensi.desktop-action-storage.cleanup-receipt")
      || value.version !== 1
      || !["passed", "failed"].includes(value.result)
      || !validUtcTimestamp(value.verifiedAt)
      || value.project !== runtime.project
      || value.projectSuffix !== identity.suffix
      || JSON.stringify(value.ports) !== JSON.stringify({ gateway: 5628, mysql: 3312 })
      || !(bridgeMysql ? ["bridge-mysql"] : multiMacCrmMysql ? ["multi-mac-crm"]
        : ["installation", "binding", "actions", "all", "outreach-schema"])
        .includes(value.suite)) {
      throw error("API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
    }
  }
  return snapshot;
}

async function validateDisposableOwnerLock(runtime, identity, options = {}) {
  const lock = runtime.ownerLock;
  const expectedPath = join(identity.base, DISPOSABLE_LOCK_NAME);
  if (!lock || typeof lock !== "object" || Array.isArray(lock)
    || lock.path !== expectedPath
    || lock.project !== runtime.project
    || lock.ports?.gateway !== API_ONLY_PORTS.emptyGateway
    || lock.ports?.mysql !== API_ONLY_PORTS.emptyMysql
    || lock.engineIdHash !== sha256(runtime.composeRuntime?.daemon?.identity ?? "")) {
    throw error("API_ONLY_DISPOSABLE_OWNER_LOCK_MISMATCH");
  }
  const expected = {
    project: lock.project,
    ports: lock.ports,
    pid: lock.pid,
    processStartToken: lock.processStartToken,
    nonce: lock.nonce,
    engineIdHash: lock.engineIdHash,
    createdAt: lock.createdAt
  };
  let snapshot;
  try { snapshot = await readPrivateJsonSnapshot(expectedPath, "API_ONLY_DISPOSABLE_OWNER_LOCK_MISMATCH", options); }
  catch { throw error("API_ONLY_DISPOSABLE_OWNER_LOCK_MISMATCH"); }
  if (!snapshot || !validOwnerLockRecord(snapshot.value) || snapshot.canonicalText !== json(expected)) {
    throw error("API_ONLY_DISPOSABLE_OWNER_LOCK_MISMATCH");
  }
  return snapshot;
}

function defaultDisposablePortAvailable(port, options = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return Promise.reject(error("API_ONLY_PORT_CHECK_INVALID"));
  }
  const createServer = options.createDisposablePortServer ?? (() => createNetServer());
  const setTimer = options.disposablePortSetTimeout ?? setTimeout;
  const clearTimer = options.disposablePortClearTimeout ?? clearTimeout;
  if (typeof createServer !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function") {
    return Promise.reject(error("API_ONLY_PORT_CHECK_INVALID"));
  }
  return new Promise((resolvePort, rejectPort) => {
    let server;
    let timer;
    let settled = false;
    const finish = (caught, available) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      if (caught) rejectPort(error("API_ONLY_PORT_CHECK_FAILED"));
      else resolvePort(available);
    };
    try {
      server = createServer();
      if (!server || typeof server.once !== "function" || typeof server.listen !== "function" || typeof server.close !== "function") {
        finish(error("invalid"));
        return;
      }
      server.once("error", () => finish(null, false));
      timer = setTimer(() => {
        try { server.close(() => finish(error("timeout"))); }
        catch { finish(error("timeout")); }
      }, DISPOSABLE_PORT_TIMEOUT_MS);
      timer?.unref?.();
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        try {
          server.close((caught) => finish(caught ?? null, caught ? undefined : true));
        } catch { finish(error("close")); }
      });
    } catch { finish(error("create")); }
  });
}

function disposableSingleHeader(response, name) {
  const distinct = response?.headersDistinct?.[name];
  if (distinct !== undefined) {
    if (!Array.isArray(distinct) || distinct.length !== 1 || typeof distinct[0] !== "string") {
      throw error("API_ONLY_DISPOSABLE_ENGINE_RESPONSE_INVALID");
    }
    return distinct[0];
  }
  const value = response?.headers?.[name];
  if (Array.isArray(value) || value !== undefined && typeof value !== "string") {
    throw error("API_ONLY_DISPOSABLE_ENGINE_RESPONSE_INVALID");
  }
  return value;
}

function defaultDisposableEngineJson(runtime, path, options = {}) {
  const request = options.disposableEngineRequest ?? nativeHttpRequest;
  const setTimer = options.disposableEngineSetTimeout ?? setTimeout;
  const clearTimer = options.disposableEngineClearTimeout ?? clearTimeout;
  const signal = options.disposableEngineSignal;
  if (typeof request !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function"
    || typeof runtime?.socket?.canonicalPath !== "string" || !isAbsolute(runtime.socket.canonicalPath)
    || typeof path !== "string" || !path.startsWith("/") || path.includes("\0") || Buffer.byteLength(path) > 4_096) {
    return Promise.reject(error("API_ONLY_DISPOSABLE_ENGINE_RESPONSE_INVALID"));
  }
  return new Promise((resolveResponse, rejectResponse) => {
    let outgoing;
    let response;
    let timer;
    let settled = false;
    let requestDestroyed = false;
    let responseDestroyed = false;
    const finish = (caught, value) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      signal?.removeEventListener("abort", onAbort);
      if (caught) {
        if (response && !responseDestroyed) {
          responseDestroyed = true;
          try { response.destroy?.(); } catch { /* closed failure */ }
        }
        if (outgoing && !requestDestroyed) {
          requestDestroyed = true;
          try { outgoing.destroy?.(); } catch { /* closed failure */ }
        }
        rejectResponse(error("API_ONLY_DISPOSABLE_ENGINE_RESPONSE_INVALID"));
      } else resolveResponse(value);
    };
    const onAbort = () => finish(error("aborted"));
    try {
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimer(() => finish(error("timeout")), DISPOSABLE_ENGINE_TIMEOUT_MS);
      timer?.unref?.();
      outgoing = request({
        socketPath: runtime.socket.canonicalPath,
        path,
        method: "GET",
        agent: false,
        timeout: DISPOSABLE_ENGINE_TIMEOUT_MS,
        headers: { Accept: "application/json" }
      }, (incoming) => {
        response = incoming;
        try {
          if (response?.statusCode !== 200) { finish(error("status")); return; }
          const contentType = disposableSingleHeader(response, "content-type");
          if (typeof contentType !== "string" || contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
            finish(error("content-type"));
            return;
          }
          const contentLength = disposableSingleHeader(response, "content-length");
          if (contentLength !== undefined
            && (!/^(?:0|[1-9]\d*)$/u.test(contentLength) || Number(contentLength) > MAX_DISPOSABLE_ENGINE_BYTES)) {
            finish(error("content-length"));
            return;
          }
          const chunks = [];
          let size = 0;
          response.once("aborted", () => finish(error("aborted")));
          response.once("error", () => finish(error("response")));
          response.on("data", (chunk) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            size += bytes.length;
            if (size > MAX_DISPOSABLE_ENGINE_BYTES) { finish(error("size")); return; }
            chunks.push(bytes);
          });
          response.once("end", () => {
            if (settled) return;
            if (response.complete !== true || size === 0
              || contentLength !== undefined && size !== Number(contentLength)) {
              finish(error("incomplete"));
              return;
            }
            let value;
            try { value = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
            catch { finish(error("json")); return; }
            finish(null, value);
          });
        } catch { finish(error("response")); }
      });
      if (!outgoing || typeof outgoing.once !== "function" || typeof outgoing.end !== "function") {
        finish(error("request"));
        return;
      }
      outgoing.once("timeout", () => finish(error("timeout")));
      outgoing.once("error", () => finish(error("request")));
      outgoing.end();
    } catch { finish(error("request")); }
  });
}

async function readDisposableEngineJson(runtime, path, options = {}) {
  const read = options.readDisposableEngineJson
    ?? ((selectedRuntime, selectedPath) => defaultDisposableEngineJson(selectedRuntime, selectedPath, options));
  if (typeof read !== "function") throw error("API_ONLY_DISPOSABLE_ENGINE_READER_INVALID");
  try { return await read(runtime, path); }
  catch { throw error("API_ONLY_DISPOSABLE_ENGINE_RESPONSE_INVALID"); }
}

function disposableProjectFilter(project, service = null) {
  const labels = [`com.docker.compose.project=${project}`];
  if (service !== null) labels.push(`com.docker.compose.service=${service}`);
  return encodeURIComponent(JSON.stringify({ label: labels }));
}

function validDisposableLabels(labels, project, service = null) {
  return labels && typeof labels === "object" && !Array.isArray(labels)
    && labels["com.docker.compose.project"] === project
    && (service === null || labels["com.docker.compose.service"] === service);
}

async function inspectDisposableServiceDetail(runtime, expected, options = {}) {
  options.disposableEngineSignal?.throwIfAborted();
  if (!expected || !DISPOSABLE_PROJECT.test(expected.project ?? "")
    || !["backend", "mysql"].includes(expected.service)
    || !HASH.test(expected.runtimeNonce ?? "")
    || !HASH.test(expected.network?.id ?? "")
    || expected.network?.name !== `${expected.project}_shensi_internal`) {
    throw error("API_ONLY_DISPOSABLE_SERVICE_IDENTITY_INVALID");
  }
  const listPath = `/containers/json?all=1&filters=${disposableProjectFilter(expected.project, expected.service)}`;
  const listed = await readDisposableEngineJson(runtime, listPath, options);
  options.disposableEngineSignal?.throwIfAborted();
  if (!Array.isArray(listed) || listed.length !== 1) throw error("API_ONLY_DISPOSABLE_SERVICE_IDENTITY_INVALID");
  const summary = listed[0];
  if (!summary || typeof summary !== "object" || Array.isArray(summary)
    || !HASH.test(summary.Id ?? "")
    || !validDisposableLabels(summary.Labels, expected.project, expected.service)) {
    throw error("API_ONLY_DISPOSABLE_SERVICE_IDENTITY_INVALID");
  }
  const detail = await readDisposableEngineJson(runtime, `/containers/${summary.Id}/json`, options);
  options.disposableEngineSignal?.throwIfAborted();
  const labels = detail?.Config?.Labels;
  const attachment = detail?.NetworkSettings?.Networks?.[expected.network.name];
  if (!detail || typeof detail !== "object" || Array.isArray(detail)
    || detail.Id !== summary.Id
    || !IMAGE_ID_DIGEST.test(detail.Image ?? "")
    || !validDisposableLabels(labels, expected.project, expected.service)
    || detail.State?.Status !== "running"
    || !attachment || attachment.NetworkID !== expected.network.id) {
    throw error("API_ONLY_DISPOSABLE_SERVICE_IDENTITY_INVALID");
  }
  return detail;
}

async function inspectDisposableService(runtime, expected, options = {}) {
  const detail = await inspectDisposableServiceDetail(runtime, expected, options);
  return Object.freeze({
    project: expected.project,
    runtimeNonce: expected.runtimeNonce,
    networkId: expected.network.id,
    networkName: expected.network.name,
    service: expected.service,
    containerId: detail.Id,
    imageIdDigest: detail.Image
  });
}

async function waitForDisposableMysqlHealth(runtime, expected, options) {
  let containerId;
  for (;;) {
    const detail = await inspectDisposableServiceDetail(runtime, { ...expected, service: "mysql" }, options);
    if (containerId && detail.Id !== containerId) throw error("API_ONLY_DISPOSABLE_SERVICE_IDENTITY_INVALID");
    containerId = detail.Id;
    const status = detail.State.Health?.Status;
    if (status === "healthy") {
      return Object.freeze({
        status, project: expected.project, runtimeNonce: expected.runtimeNonce,
        networkId: expected.network.id, networkName: expected.network.name,
        service: "mysql", containerId
      });
    }
    if (status !== "starting") throw error("API_ONLY_MYSQL_HEALTH_FAILED");
    await delay(250, undefined, { signal: options.disposableEngineSignal });
  }
}

async function inspectDisposableVolumes(runtime, options = {}) {
  const path = `/volumes?filters=${disposableProjectFilter(runtime.project)}`;
  const payload = await readDisposableEngineJson(runtime.composeRuntime, path, options);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || !(payload.Volumes === null || Array.isArray(payload.Volumes))) {
    throw error("API_ONLY_DISPOSABLE_VOLUME_INVALID");
  }
  const volumes = payload.Volumes ?? [];
  if (volumes.length > 2) throw error("API_ONLY_DISPOSABLE_VOLUME_INVALID");
  const names = [];
  for (const volume of volumes) {
    if (!volume || typeof volume !== "object" || Array.isArray(volume)
      || typeof volume.Name !== "string" || !volume.Name
      || !validDisposableLabels(volume.Labels, runtime.project)
      || volume.Labels["com.docker.compose.volume"] !== "mysql_data") {
      throw error("API_ONLY_DISPOSABLE_VOLUME_INVALID");
    }
    names.push(volume.Name);
  }
  return names.sort();
}

async function inspectDisposableProjectResources(runtime, options = {}) {
  const filter = disposableProjectFilter(runtime.project);
  const [containers, networks, volumes] = await Promise.all([
    readDisposableEngineJson(runtime.composeRuntime, `/containers/json?all=1&filters=${filter}`, options),
    readDisposableEngineJson(runtime.composeRuntime, `/networks?filters=${filter}`, options),
    inspectDisposableVolumes(runtime, options)
  ]);
  if (!Array.isArray(containers) || containers.length > 3
    || !Array.isArray(networks) || networks.length > 3) {
    throw error("API_ONLY_DISPOSABLE_RESOURCE_INVALID");
  }
  const services = [];
  const containerIds = new Set();
  for (const container of containers) {
    const service = container?.Labels?.["com.docker.compose.service"];
    if (!container || typeof container !== "object" || Array.isArray(container)
      || !HASH.test(container.Id ?? "") || containerIds.has(container.Id)
      || !["mysql", "backend", "gateway"].includes(service)
      || services.includes(service)
      || !validDisposableLabels(container.Labels, runtime.project, service)) {
      throw error("API_ONLY_DISPOSABLE_RESOURCE_INVALID");
    }
    containerIds.add(container.Id);
    services.push(service);
  }
  const networkNames = [];
  const allowedNetworks = new Set(["shensi_internal", "shensi_egress", "shensi_host"]);
  for (const network of networks) {
    const logicalName = network?.Labels?.["com.docker.compose.network"];
    if (!network || typeof network !== "object" || Array.isArray(network)
      || !HASH.test(network.Id ?? "")
      || !allowedNetworks.has(logicalName)
      || network.Name !== `${runtime.project}_${logicalName}`
      || networkNames.includes(network.Name)
      || !validDisposableLabels(network.Labels, runtime.project)) {
      throw error("API_ONLY_DISPOSABLE_RESOURCE_INVALID");
    }
    networkNames.push(network.Name);
  }
  return Object.freeze({
    containers: Object.freeze(services.sort()),
    networks: Object.freeze(networkNames),
    volumes: Object.freeze(volumes)
  });
}

export async function destroyFailedDisposableApiOnlyPreparation(runtime, options = {}) {
  const identity = disposableRuntimeIdentity(runtime);
  const validatedLock = await validateDisposableApiOnlyOwnerLock(identity.repositoryRoot, {
    ...options, nonce: runtime.ownerLock?.nonce
  });
  if (validatedLock.path !== runtime.ownerLock?.path
    || validatedLock.project !== runtime.project
    || validatedLock.engineIdHash !== runtime.ownerLock?.engineIdHash) {
    throw error("API_ONLY_DISPOSABLE_OWNER_LOCK_MISMATCH");
  }
  const resolveRuntime = options.resolveComposeRuntimeForCleanup
    ?? (() => resolveComposeRuntime(options));
  let currentRuntime;
  try { currentRuntime = await resolveRuntime(); }
  catch { throw error("API_ONLY_DISPOSABLE_ENGINE_CHANGED"); }
  if (!sameResolvedRuntimeAuthority(runtime.composeRuntime, currentRuntime)) {
    throw error("API_ONLY_DISPOSABLE_ENGINE_CHANGED");
  }
  const inspectResources = options.inspectFailedPreparationResources
    ?? ((candidate) => inspectDisposableProjectResources(candidate, options));
  let resources;
  try { resources = await inspectResources(runtime); }
  catch { throw error("API_ONLY_DISPOSABLE_RESOURCE_INVALID"); }
  if (!resources || !Array.isArray(resources.containers)
    || !Array.isArray(resources.networks) || !Array.isArray(resources.volumes)
    || resources.containers.length !== 0 || resources.networks.length !== 0
    || resources.volumes.length !== 0) {
    throw error("API_ONLY_DISPOSABLE_RESIDUE_DETECTED");
  }
  const repository = await validateApiOnlyRepositoryRoot(identity.repositoryRoot, options);
  try { await repository.filesystem.lstat(identity.root); }
  catch (caught) {
    if (caught?.code === "ENOENT") return Object.freeze({ project: runtime.project,
      runtimeRoot: identity.root, cleanup: "complete" });
    throw error("API_ONLY_DISPOSABLE_RUNTIME_ROOT_INVALID");
  }
  try { await pinPrivateDirectoryTree(repository, identity.root,
    "API_ONLY_DISPOSABLE_RUNTIME_ROOT_INVALID"); }
  catch { throw error("API_ONLY_DISPOSABLE_RUNTIME_ROOT_INVALID"); }
  const removeRoot = options.removeFailedPreparationRuntimeRoot
    ?? ((path) => rm(path, { recursive: true, force: false }));
  try { await removeRoot(identity.root); }
  catch { throw error("API_ONLY_DISPOSABLE_REMOVE_FAILED"); }
  try {
    await repository.filesystem.lstat(identity.root);
    throw error("API_ONLY_DISPOSABLE_REMOVE_FAILED");
  } catch (caught) {
    if (caught?.message === "API_ONLY_DISPOSABLE_REMOVE_FAILED") throw caught;
    if (caught?.code !== "ENOENT") throw error("API_ONLY_DISPOSABLE_REMOVE_FAILED");
  }
  return Object.freeze({ project: runtime.project,
    runtimeRoot: identity.root, cleanup: "complete" });
}

function validDisposableBootstrapStatus(status, runtime) {
  const keys = ["schema", "version", "project", "origin", "socketIdentity", "daemonIdentity", "runtimeNonce", "network", "backend", "gatewaySnapshotSha256", "createdAt"];
  return status && typeof status === "object" && !Array.isArray(status)
    && JSON.stringify(Object.keys(status)) === JSON.stringify(keys)
    && status.schema === "shensi.api-only.bootstrap-status"
    && status.version === 1
    && status.project === runtime.project
    && status.origin === `http://127.0.0.1:${runtime.ports.gateway}`
    && status.socketIdentity === runtime.composeRuntime.socket.identity
    && status.daemonIdentity === runtime.composeRuntime.daemon.identity
    && HASH.test(status.runtimeNonce ?? "")
    && status.network && HASH.test(status.network.id ?? "")
    && status.network.name === `${runtime.project}_shensi_internal`
    && HASH.test(status.network.claimSha256 ?? "")
    && JSON.stringify(Object.keys(status.network)) === JSON.stringify(["id", "name", "claimSha256"])
    && status.backend && HASH.test(status.backend.containerId ?? "")
    && IMAGE_ID_DIGEST.test(status.backend.imageIdDigest ?? "")
    && JSON.stringify(Object.keys(status.backend)) === JSON.stringify(["containerId", "imageIdDigest"])
    && HASH.test(status.gatewaySnapshotSha256 ?? "")
    && validUtcTimestamp(status.createdAt);
}

async function inspectDisposableBuildEvidence(repositoryRoot, runtime, context, options = {}) {
  const revalidateRuntime = options.revalidateDisposableComposeRuntime
    ?? (() => resolveComposeRuntime(options));
  if (typeof revalidateRuntime !== "function") throw error("API_ONLY_DISPOSABLE_ENGINE_RESOLVER_REQUIRED");
  let currentRuntime;
  try { currentRuntime = await revalidateRuntime(runtime); }
  catch { throw error("API_ONLY_DISPOSABLE_ENGINE_CHANGED"); }
  if (!sameResolvedRuntimeAuthority(runtime.composeRuntime, currentRuntime)) {
    throw error("API_ONLY_DISPOSABLE_ENGINE_CHANGED");
  }
  const status = await readPrivateJson(join(runtime.root, "status.json"), "API_ONLY_DISPOSABLE_BUILD_EVIDENCE_INVALID", options);
  if (!validDisposableBootstrapStatus(status, runtime) || status.runtimeNonce !== runtime.runtimeNonce) {
    throw error("API_ONLY_DISPOSABLE_BUILD_EVIDENCE_INVALID");
  }
  const observed = await inspectDisposableService(runtime.composeRuntime, {
    project: runtime.project,
    runtimeNonce: status.runtimeNonce,
    network: { id: status.network.id, name: status.network.name },
    service: "backend"
  }, options);
  if (observed.containerId !== status.backend.containerId
    || observed.imageIdDigest !== status.backend.imageIdDigest) {
    throw error("API_ONLY_DISPOSABLE_BUILD_EVIDENCE_INVALID");
  }
  const args = ["-f", "deploy/compose.api-only.yaml", "--project-name", runtime.project, "config"];
  const sensitiveValues = Object.values(runtime.backend ?? {}).filter((value) => typeof value === "string" && value.length > 0);
  const runConfig = options.runDisposableComposeConfig
    ?? ((selectedRuntime, selectedArgs, input) => runResolvedCompose(selectedRuntime, selectedArgs, {
      ...(options.composeRenderOptions ?? {}),
      cwd: input.cwd,
      sensitiveValues: input.sensitiveValues
    }));
  if (typeof runConfig !== "function") throw error("API_ONLY_DISPOSABLE_BUILD_INSPECTOR_REQUIRED");
  // The re-resolved runtime is authority evidence.  The prepared runtime is
  // the one that also carries the exact validated SHENSI_API_* render inputs.
  const rendered = await runConfig(runtime.composeRuntime, args, { cwd: repositoryRoot, sensitiveValues });
  if (!rendered || rendered.code !== 0 || rendered.truncated !== false
    || typeof rendered.output !== "string" || rendered.output.length === 0
    || Buffer.byteLength(rendered.output, "utf8") > MAX_DISPOSABLE_ENGINE_BYTES
    || rendered.output.includes("\0")) {
    throw error("API_ONLY_DISPOSABLE_BUILD_EVIDENCE_INVALID");
  }
  return Object.freeze({
    imageIdDigest: observed.imageIdDigest,
    composeConfigHash: sha256(Buffer.from(rendered.output, "utf8"))
  });
}

export async function destroyDisposableApiOnlyRuntime(runtime, options = {}) {
  const identity = disposableRuntimeIdentity(runtime);
  const repository = await validateApiOnlyRepositoryRoot(identity.repositoryRoot, options);
  try { await pinPrivateDirectoryTree(repository, identity.root, "API_ONLY_DISPOSABLE_RUNTIME_ROOT_INVALID"); }
  catch { throw error("API_ONLY_DISPOSABLE_RUNTIME_ROOT_INVALID"); }
  await validateDisposableOwnerLock(runtime, identity, options);
  const retainedSnapshot = await validateDisposableRetainedEvidence(runtime, identity, options);

  const resolveRuntime = options.resolveComposeRuntimeForCleanup
    ?? (() => resolveComposeRuntime(options));
  if (typeof resolveRuntime !== "function") throw error("API_ONLY_DISPOSABLE_ENGINE_RESOLVER_REQUIRED");
  let currentRuntime;
  try { currentRuntime = await resolveRuntime(); }
  catch { throw error("API_ONLY_DISPOSABLE_ENGINE_CHANGED"); }
  if (!sameResolvedRuntimeAuthority(runtime.composeRuntime, currentRuntime)) {
    throw error("API_ONLY_DISPOSABLE_ENGINE_CHANGED");
  }

  const useDefaultInventory = options.inspectDisposableVolumes === undefined;
  const inspectVolumes = options.inspectDisposableVolumes
    ?? (async (candidateRuntime) => (await inspectDisposableProjectResources(candidateRuntime, options)).volumes);
  if (typeof inspectVolumes !== "function") throw error("API_ONLY_DISPOSABLE_VOLUME_INSPECTOR_REQUIRED");
  let volumes;
  try { volumes = await inspectVolumes(runtime, currentRuntime); }
  catch { throw error("API_ONLY_DISPOSABLE_VOLUME_INVALID"); }
  const expectedVolume = `${runtime.project}_mysql_data`;
  const failedVerification = retainedSnapshot.value?.result === "failed"
    && (retainedSnapshot.value?.schema === "shensi.api-only.empty-verification"
      && retainedSnapshot.value?.version === 1
      || retainedSnapshot.value?.schema === "shensi.desktop-action-storage.cleanup-receipt"
      && retainedSnapshot.value?.version === 1
      || retainedSnapshot.value?.schema === "shensi.desktop-action-bridge-mysql.cleanup-receipt"
      && retainedSnapshot.value?.version === 1
      || retainedSnapshot.value?.schema === "shensi.multi-mac-crm-mysql.cleanup-receipt"
      && retainedSnapshot.value?.version === 1);
  if (!Array.isArray(volumes)
    || !(volumes.length === 1 && volumes[0] === expectedVolume
      || failedVerification && volumes.length === 0)
    || new Set(volumes).size !== volumes.length) throw error("API_ONLY_DISPOSABLE_VOLUME_INVALID");

  const down = options.runDisposableComposeDown
    ?? (async (_selectedRuntime, args) => {
      const loadForCleanup = options.loadDisposableRuntimeForCleanup
        ?? ((root) => loadExistingApiOnlyRuntime(root, {
          ...options,
          disposable: true,
          project: runtime.project,
          runtimeRoot: identity.root
        }));
      const invokeDown = options.invokeDisposableComposeDown
        ?? ((candidateRuntime, selectedArgs) => invoke(identity.repositoryRoot, candidateRuntime, selectedArgs, options));
      if (typeof loadForCleanup !== "function" || typeof invokeDown !== "function") {
        throw error("API_ONLY_DISPOSABLE_DOWN_ADAPTER_REQUIRED");
      }
      let fresh = await loadForCleanup(identity.repositoryRoot, runtime);
      if (!fresh || fresh.root !== identity.root || fresh.project !== runtime.project
        || fresh.runtimeNonce !== runtime.runtimeNonce
        || !sameResolvedRuntimeAuthority(fresh.composeRuntime, currentRuntime)) {
        throw error("API_ONLY_DISPOSABLE_RUNTIME_INVALID");
      }
      if (fresh.networkClaim?.existingNetwork === null) {
        try {
          await promoteBootstrapNetworkClaim(fresh, options);
          fresh = await loadForCleanup(identity.repositoryRoot, runtime);
        } catch (caught) {
          if (caught?.message !== "API_ONLY_NETWORK_POST_CREATE_MISMATCH") throw caught;
        }
      }
      return invokeDown(fresh, args);
    });
  if (typeof down !== "function") throw error("API_ONLY_DISPOSABLE_DOWN_ADAPTER_REQUIRED");
  let result;
  try { result = await down(runtime, ["down", "--volumes", "--remove-orphans"]); }
  catch { throw error("API_ONLY_DISPOSABLE_DOWN_FAILED"); }
  if (!result || (Object.hasOwn(result, "code") && result.code !== 0)) {
    throw error("API_ONLY_DISPOSABLE_DOWN_FAILED");
  }

  if (useDefaultInventory) {
    let remaining;
    try { remaining = await inspectDisposableProjectResources(runtime, options); }
    catch { throw error("API_ONLY_DISPOSABLE_RESOURCE_INVALID"); }
    if (remaining.containers.length !== 0 || remaining.networks.length !== 0 || remaining.volumes.length !== 0) {
      throw error("API_ONLY_DISPOSABLE_RESIDUE_DETECTED");
    }
  } else {
    let remainingVolumes;
    try { remainingVolumes = await inspectVolumes(runtime, currentRuntime); }
    catch { throw error("API_ONLY_DISPOSABLE_VOLUME_INVALID"); }
    if (!Array.isArray(remainingVolumes) || remainingVolumes.length !== 0) {
      throw error("API_ONLY_DISPOSABLE_RESIDUE_DETECTED");
    }
  }

  await validateDisposableRetainedEvidence(runtime, identity, options);
  try { await pinPrivateDirectoryTree(repository, identity.root, "API_ONLY_DISPOSABLE_RUNTIME_ROOT_INVALID"); }
  catch { throw error("API_ONLY_DISPOSABLE_RUNTIME_ROOT_INVALID"); }
  const removeRuntimeRoot = options.removeDisposableRuntimeRoot
    ?? ((path) => rm(path, { recursive: true, force: false }));
  if (typeof removeRuntimeRoot !== "function") throw error("API_ONLY_DISPOSABLE_REMOVE_ADAPTER_REQUIRED");
  try { await removeRuntimeRoot(identity.root); }
  catch { throw error("API_ONLY_DISPOSABLE_REMOVE_FAILED"); }
  try {
    await repository.filesystem.lstat(identity.root);
    throw error("API_ONLY_DISPOSABLE_REMOVE_FAILED");
  } catch (caught) {
    if (caught?.message === "API_ONLY_DISPOSABLE_REMOVE_FAILED") throw caught;
    if (caught?.code !== "ENOENT") throw error("API_ONLY_DISPOSABLE_REMOVE_FAILED");
  }
  return Object.freeze({
    project: runtime.project,
    runtimeRoot: identity.root,
    cleanup: "complete"
  });
}

function registerProcessSignalHandler(signal, handler) {
  const listener = () => { void handler().catch(() => undefined); };
  process.on(signal, listener);
  return () => process.off(signal, listener);
}
export async function withApiOnlyOwnerLock(input, callback) {
  if (typeof callback !== "function") throw error("API_ONLY_OWNER_LOCK_CALLBACK_INVALID");
  if (input.cleanupChildren !== undefined && typeof input.cleanupChildren !== "function") throw error("API_ONLY_OWNER_LOCK_CALLBACK_INVALID");
  if (input.registerSignalHandler !== undefined && typeof input.registerSignalHandler !== "function") throw error("API_ONLY_OWNER_LOCK_CALLBACK_INVALID");
  const lock = await acquireApiOnlyOwnerLock(input.repositoryRoot, input);
  const unregister = [];
  let cleanupPromise = null;
  let cleanupReason = null;
  const cleanupChildren = input.cleanupChildren ?? (async () => undefined);
  const ensureCleanup = (reason) => {
    cleanupReason ??= reason;
    cleanupPromise ??= Promise.resolve().then(() => cleanupChildren(cleanupReason, lock));
    return cleanupPromise;
  };
  const register = input.registerSignalHandler ?? registerProcessSignalHandler;
  try {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const remove = register(signal, () => ensureCleanup(signal));
      if (typeof remove !== "function") throw error("API_ONLY_OWNER_LOCK_CALLBACK_INVALID");
      unregister.push(remove);
    }
  } catch (caught) {
    for (const remove of unregister.reverse()) {
      try { remove(); } catch { /* Registration failed before lifecycle work began. */ }
    }
    await releaseApiOnlyOwnerLock(lock, input);
    throw caught;
  }
  let result;
  let callbackFailure;
  let callbackFailed = false;
  try {
    result = await callback(lock, Object.freeze({ requestShutdown: (reason = "requested") => ensureCleanup(reason) }));
  } catch (caught) {
    callbackFailed = true;
    callbackFailure = caught;
  }
  let cleanupFailure;
  try { await ensureCleanup(cleanupReason ?? (callbackFailed ? "error" : "return")); }
  catch (caught) { cleanupFailure = caught; }
  if (!cleanupFailure) {
    try { await releaseApiOnlyOwnerLock(lock, input); }
    catch (caught) { cleanupFailure = caught; }
  }
  for (const remove of unregister.reverse()) {
    try { remove(); } catch { /* Signal handlers are already inert after settlement. */ }
  }
  if (cleanupFailure) throw cleanupFailure;
  if (callbackFailed) throw callbackFailure;
  return result;
}

function validDisposableSmokeReport(rows) {
  if (!Array.isArray(rows) || rows.length !== API_ONLY_SMOKE_ROUTES.length) return false;
  return rows.every((row, index) => {
    const route = API_ONLY_SMOKE_ROUTES[index];
    if (!row || typeof row !== "object" || Array.isArray(row)
      || JSON.stringify(Object.keys(row)) !== JSON.stringify(["module", "method", "path", "status", "shape"])
      || row.module !== route.module
      || row.method !== "GET"
      || row.status !== 200
      || JSON.stringify(row.shape) !== JSON.stringify(route.shape)) return false;
    if (route.module !== "advisor") return row.path === route.path;
    try {
      const parsed = new URL(row.path, "http://127.0.0.1");
      return parsed.pathname === "/api/v1/acquisition/advisor/today"
        && parsed.searchParams.get("currency") === "CNY"
        && validUtcTimestamp(parsed.searchParams.get("asOf"))
        && [...parsed.searchParams.keys()].sort().join(",") === "asOf,currency";
    } catch { return false; }
  });
}

function validDisposableGatewayReport(report) {
  const safeId = "A".repeat(43);
  const http = [
    ["/healthz", 200],
    ["/api/health", 200],
    ["/", 404],
    ["/live-sessions/probe", 404],
    [`/douyin-live/${safeId}`, 404],
    ["/novnc/vnc.html", 404]
  ];
  const upgrades = [
    ["/live-sessions/probe", 404],
    [`/douyin-live/${safeId}`, 404]
  ];
  const validRows = (rows, expected, method) => Array.isArray(rows)
    && rows.length === expected.length
    && rows.every((row, index) => row && typeof row === "object" && !Array.isArray(row)
      && JSON.stringify(Object.keys(row)) === JSON.stringify(["method", "path", "status"])
      && row.method === method
      && row.path === expected[index][0]
      && row.status === expected[index][1]);
  return report && typeof report === "object" && !Array.isArray(report)
    && JSON.stringify(Object.keys(report)) === JSON.stringify(["http", "upgrades"])
    && validRows(report.http, http, "GET")
    && validRows(report.upgrades, upgrades, "UPGRADE");
}

function validateDisposablePreparedRuntime(runtime, identity, repositoryRoot, composeRuntime) {
  const expectedRoot = join(repositoryRoot, identity.runtimeRelativeRoot);
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)
    || runtime.root !== expectedRoot
    || runtime.project !== identity.project
    || runtime.ports?.gateway !== identity.ports.gateway
    || runtime.ports?.mysql !== identity.ports.mysql
    || !HASH.test(runtime.runtimeNonce ?? "")
    || runtime.evidenceDirectory !== join(expectedRoot, "evidence")
    || typeof runtime.smokePath !== "string"
    || !inside(expectedRoot, runtime.smokePath)
    || !sameResolvedRuntimeAuthority(runtime.composeRuntime, composeRuntime)) {
    throw error("API_ONLY_DISPOSABLE_RUNTIME_INVALID");
  }
  return runtime;
}

async function persistDisposableVerificationEvidence(repositoryRoot, runtime, identity, report, options = {}) {
  const serialized = json(report);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PRIVATE_JSON_BYTES) {
    throw error("API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
  }
  const repository = await validateApiOnlyRepositoryRoot(repositoryRoot, options);
  await pinPrivateDirectoryTree(repository, runtime.evidenceDirectory, "API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
  const runtimePath = join(runtime.evidenceDirectory, "empty-verification.json");
  const retainedRoot = join(repositoryRoot, ".runtime", "api-only");
  await ensureApiOnlyRuntimeRoot(repository, retainedRoot, { create: true });
  const retainedEvidence = join(retainedRoot, "evidence");
  try { await repository.filesystem.lstat(retainedEvidence); }
  catch (caught) {
    if (caught?.code !== "ENOENT") throw error("API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
    await repository.filesystem.mkdir(retainedEvidence, { mode: PRIVATE_DIRECTORY_MODE });
    await repository.filesystem.chmod(retainedEvidence, PRIVATE_DIRECTORY_MODE);
  }
  await pinPrivateDirectoryTree(repository, retainedEvidence, "API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
  const emptyEvidence = join(retainedEvidence, "empty");
  await ensurePrivateDirectory(repository, emptyEvidence, "API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
  const retainedPath = join(emptyEvidence, `${identity.suffix}.json`);
  try {
    await privateFile(runtimePath, serialized);
    await privateFile(retainedPath, serialized);
  } catch { throw error("API_ONLY_DISPOSABLE_EVIDENCE_INVALID"); }
  const [runtimeBytes, retainedBytes] = await Promise.all([
    readFile(runtimePath),
    readFile(retainedPath)
  ]);
  const digest = sha256(serialized);
  if (!runtimeBytes.equals(retainedBytes)
    || sha256(runtimeBytes) !== digest
    || sha256(retainedBytes) !== digest) throw error("API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
  return Object.freeze({
    retained: Object.freeze({ path: retainedPath, sha256: digest }),
    runtimePath
  });
}

export async function persistDesktopActionStorageCleanupEvidence(
  repositoryRoot, runtime, identity, input, options = {}
) {
  const match = DISPOSABLE_PROJECT.exec(identity?.project ?? "");
  if (!match || match[1] !== identity?.suffix
    || identity?.ports?.gateway !== API_ONLY_PORTS.emptyGateway
    || identity?.ports?.mysql !== API_ONLY_PORTS.emptyMysql
    || runtime?.project !== identity.project
    || runtime?.root !== join(repositoryRoot, ".runtime", "api-only-empty", identity.suffix)
    || runtime?.evidenceDirectory !== join(runtime.root, "evidence")
    || !["installation", "binding", "actions", "all", "bridge-mysql", "outreach-schema", "multi-mac-crm"].includes(input?.suite)
    || !["passed", "failed"].includes(input?.result)
    || !validUtcTimestamp(input?.verifiedAt)) {
    throw error("API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
  }
  const purpose = input.suite === "bridge-mysql" ? "desktop-action-bridge-mysql"
    : input.suite === "multi-mac-crm" ? "multi-mac-crm-mysql" : "desktop-action-storage";
  const report = Object.freeze({
    schema: `shensi.${purpose}.cleanup-receipt`,
    version: 1,
    result: input.result,
    verifiedAt: input.verifiedAt,
    project: identity.project,
    projectSuffix: identity.suffix,
    ports: identity.ports,
    suite: input.suite
  });
  const serialized = json(report);
  const repository = await validateApiOnlyRepositoryRoot(repositoryRoot, options);
  await pinPrivateDirectoryTree(repository, runtime.evidenceDirectory,
    "API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
  const runtimePath = join(runtime.evidenceDirectory, `${purpose}-cleanup.json`);
  const retainedRoot = join(repositoryRoot, ".runtime", "api-only");
  await ensureApiOnlyRuntimeRoot(repository, retainedRoot, { create: true });
  const retainedEvidence = join(retainedRoot, "evidence");
  try { await repository.filesystem.lstat(retainedEvidence); }
  catch (caught) {
    if (caught?.code !== "ENOENT") throw error("API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
    await repository.filesystem.mkdir(retainedEvidence, { mode: PRIVATE_DIRECTORY_MODE });
    await repository.filesystem.chmod(retainedEvidence, PRIVATE_DIRECTORY_MODE);
  }
  await pinPrivateDirectoryTree(repository, retainedEvidence,
    "API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
  const storageEvidence = join(retainedEvidence, purpose);
  await ensurePrivateDirectory(repository, storageEvidence,
    "API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
  const retainedPath = join(storageEvidence, `${identity.suffix}.json`);
  try {
    await privateFile(runtimePath, serialized);
    await privateFile(retainedPath, serialized);
  } catch { throw error("API_ONLY_DISPOSABLE_EVIDENCE_INVALID"); }
  const [runtimeBytes, retainedBytes] = await Promise.all([
    readFile(runtimePath), readFile(retainedPath)
  ]);
  const digest = sha256(serialized);
  if (!runtimeBytes.equals(retainedBytes)
    || sha256(runtimeBytes) !== digest
    || sha256(retainedBytes) !== digest) throw error("API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
  return Object.freeze({
    retained: Object.freeze({ path: retainedPath, sha256: digest }),
    runtimePath
  });
}

function safeDisposableFailureCode(caught) {
  const code = caught instanceof Error ? caught.message : "";
  return /^(?:API_ONLY|API_NETWORK|COMPOSE)_[A-Z0-9_]{1,120}$/u.test(code) ? code : null;
}

function disposableFailureReport(identity, stage, failureCode, now) {
  return Object.freeze({
    schema: "shensi.api-only.empty-verification",
    version: 1,
    result: "failed",
    verifiedAt: now,
    projectSuffix: identity.suffix,
    ports: identity.ports,
    failedStage: stage,
    failureCode,
    modules: Object.freeze([]),
    gateway: null,
    build: null
  });
}

function disposableSuccessReport(identity, modules, gateway, build, now) {
  return Object.freeze({
    schema: "shensi.api-only.empty-verification",
    version: 1,
    result: "passed",
    verifiedAt: now,
    projectSuffix: identity.suffix,
    ports: identity.ports,
    modules,
    gateway,
    build
  });
}

function apiOnlyOwnerOptions(repositoryRoot, identity, composeRuntime, options, cleanupChildren) {
  const input = {
    repositoryRoot,
    runtimeRoot: join(repositoryRoot, ".runtime", "api-only-empty"),
    disposable: true,
    project: identity.project,
    engineIdentity: composeRuntime.daemon.identity,
    randomBytes: options.ownerLockRandomBytes ?? nativeRandomBytes,
    cleanupChildren
  };
  for (const name of [
    "processInfo", "isProcessCurrent", "readProcessStartToken", "now",
    "registerSignalHandler", "getuid", "lstat", "realpath", "open", "mkdir",
    "chmod", "rename", "unlink", "beforeStaleLockRemoval"
  ]) if (options[name] !== undefined) input[name] = options[name];
  return input;
}

async function persistDisposableStaleLockAudit(repositoryRoot, record, options = {}) {
  const match = DISPOSABLE_PROJECT.exec(record?.project ?? "");
  if (!match || !validOwnerLockRecord(record)) throw error("API_ONLY_DISPOSABLE_STALE_LOCK_INVALID");
  let recoveredAt;
  try { recoveredAt = options.now?.() ?? new Date().toISOString(); }
  catch { throw error("API_ONLY_DISPOSABLE_STALE_LOCK_INVALID"); }
  if (!validUtcTimestamp(recoveredAt)) throw error("API_ONLY_DISPOSABLE_STALE_LOCK_INVALID");
  const repository = await validateApiOnlyRepositoryRoot(repositoryRoot, options);
  const retainedRoot = join(repositoryRoot, ".runtime", "api-only");
  await ensureApiOnlyRuntimeRoot(repository, retainedRoot, { create: true });
  const evidenceDirectory = join(retainedRoot, "evidence");
  try { await repository.filesystem.lstat(evidenceDirectory); }
  catch (caught) {
    if (caught?.code !== "ENOENT") throw error("API_ONLY_DISPOSABLE_STALE_LOCK_INVALID");
    await repository.filesystem.mkdir(evidenceDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    await repository.filesystem.chmod(evidenceDirectory, PRIVATE_DIRECTORY_MODE);
  }
  await pinPrivateDirectoryTree(repository, evidenceDirectory, "API_ONLY_DISPOSABLE_STALE_LOCK_INVALID");
  const emptyDirectory = join(evidenceDirectory, "empty");
  await ensurePrivateDirectory(repository, emptyDirectory, "API_ONLY_DISPOSABLE_STALE_LOCK_INVALID");
  const auditDirectory = join(emptyDirectory, "stale-locks");
  await ensurePrivateDirectory(repository, auditDirectory, "API_ONLY_DISPOSABLE_STALE_LOCK_INVALID");
  const recordHash = sha256(json(record));
  const path = join(auditDirectory, `${recordHash}.json`);
  const audit = {
    schema: "shensi.api-only.disposable-stale-lock",
    version: 1,
    recoveredAt,
    projectSuffix: match[1],
    pid: record.pid,
    processStartTokenSha256: sha256(record.processStartToken),
    nonceSha256: sha256(record.nonce),
    engineIdHash: record.engineIdHash,
    priorCreatedAt: record.createdAt,
    ownerRecordSha256: recordHash
  };
  try { await privateFile(path, json(audit)); }
  catch { throw error("API_ONLY_DISPOSABLE_STALE_LOCK_INVALID"); }
  return Object.freeze({ path, sha256: sha256(json(audit)) });
}

export async function verifyEmptyApiOnlyRuntime(repositoryRoot, options = {}) {
  absolute(repositoryRoot, "API_ONLY_REPOSITORY_ROOT_INVALID");
  const identity = createDisposableApiOnlyIdentity(options.identityRandomBytes ?? nativeRandomBytes);
  const runtimeRoot = join(repositoryRoot, identity.runtimeRelativeRoot);
  const resolveRuntime = options.resolveDisposableComposeRuntime
    ?? (() => resolveComposeRuntime(options));
  if (typeof resolveRuntime !== "function") throw error("API_ONLY_DISPOSABLE_ENGINE_RESOLVER_REQUIRED");
  let composeRuntime;
  try { composeRuntime = await resolveRuntime(); }
  catch { throw error("API_ONLY_DISPOSABLE_ENGINE_RESOLUTION_FAILED"); }
  if (!composeRuntime?.daemon?.identity) throw error("API_ONLY_DISPOSABLE_ENGINE_RESOLUTION_FAILED");

  let runtime = null;
  let evidence = null;
  let cleanupResult = null;
  let stage = "ports";
  let failureCode = null;
  const now = () => {
    let value;
    try { value = options.now?.() ?? new Date().toISOString(); }
    catch { throw error("API_ONLY_DISPOSABLE_TIME_INVALID"); }
    if (!validUtcTimestamp(value)) throw error("API_ONLY_DISPOSABLE_TIME_INVALID");
    return value;
  };
  const persistEvidence = options.persistDisposableEvidence
    ?? ((candidateRuntime, report) => persistDisposableVerificationEvidence(
      repositoryRoot, candidateRuntime, identity, report, options));
  const destroyRuntime = options.destroyDisposableRuntime
    ?? ((candidateRuntime) => destroyDisposableApiOnlyRuntime(candidateRuntime, options));
  if (typeof persistEvidence !== "function" || typeof destroyRuntime !== "function") {
    throw error("API_ONLY_DISPOSABLE_ADAPTER_INVALID");
  }

  const cleanupChildren = async (_reason, ownerLock) => {
    if (cleanupResult !== null || runtime === null) return;
    if (evidence === null) {
      const failure = disposableFailureReport(identity, stage, failureCode, now());
      try { evidence = await persistEvidence(runtime, failure); }
      catch { throw error("API_ONLY_DISPOSABLE_EVIDENCE_INVALID"); }
    }
    const authorized = Object.freeze({
      ...runtime,
      repositoryRoot,
      ownerLock,
      retainedEvidence: evidence.retained
    });
    try { cleanupResult = await destroyRuntime(authorized); }
    catch { throw error("API_ONLY_DISPOSABLE_CLEANUP_FAILED"); }
  };

  const userStaleLockHook = options.beforeStaleLockRemoval;
  if (userStaleLockHook !== undefined && typeof userStaleLockHook !== "function") {
    throw error("API_ONLY_DISPOSABLE_STALE_LOCK_INVALID");
  }
  const ownerInput = apiOnlyOwnerOptions(
    repositoryRoot,
    identity,
    composeRuntime,
    {
      ...options,
      beforeStaleLockRemoval: async (path, record) => {
        await persistDisposableStaleLockAudit(repositoryRoot, record, options);
        await userStaleLockHook?.(path, record);
      }
    },
    cleanupChildren
  );
  const verified = await withApiOnlyOwnerLock(ownerInput, async () => {
    try {
      const isPortAvailable = options.isPortAvailable
        ?? ((port) => defaultDisposablePortAvailable(port, options));
      await assertPorts(identity.ports, isPortAvailable);

      stage = "manifest";
      const createManifest = options.createBackendRuntimeManifest
        ?? ((root) => createSourceContentManifest(root, "backend-runtime"));
      if (typeof createManifest !== "function") throw error("API_ONLY_DISPOSABLE_MANIFEST_ADAPTER_INVALID");
      const sourceManifest = await createManifest(repositoryRoot);
      if (!sourceManifest || sourceManifest.scope !== "backend-runtime" || !HASH.test(sourceManifest.rootHash)) {
        throw error("API_ONLY_DISPOSABLE_SOURCE_MANIFEST_INVALID");
      }

      stage = "prepare";
      const prepareRuntime = options.prepareDisposableRuntime
        ?? ((root, context) => prepareApiOnlyRuntime(root, {
          ...options,
          disposable: true,
          project: context.identity.project,
          runtimeRoot: context.runtimeRoot,
          isPortAvailable,
          randomBytes: options.secretRandomBytes ?? nativeRandomBytes,
          composeRuntimeDiscoveryOptions: options.composeRuntimeDiscoveryOptions
        }));
      if (typeof prepareRuntime !== "function") throw error("API_ONLY_DISPOSABLE_PREPARE_ADAPTER_INVALID");
      runtime = validateDisposablePreparedRuntime(await prepareRuntime(repositoryRoot, {
        identity,
        runtimeRoot,
        composeRuntime,
        sourceManifest
      }), identity, repositoryRoot, composeRuntime);

      stage = "start";
      const startRuntime = options.startDisposableRuntime
        ?? ((candidate) => startApiOnlyRuntime(repositoryRoot, {
          ...options,
          disposable: true,
          project: identity.project,
          runtimeRoot: candidate.root,
          isPortAvailable,
          randomBytes: options.secretRandomBytes ?? nativeRandomBytes
        }));
      if (typeof startRuntime !== "function") throw error("API_ONLY_DISPOSABLE_START_ADAPTER_INVALID");
      await startRuntime(runtime);

      stage = "password";
      const readPassword = options.readDisposableSmokePassword
        ?? (async (candidate) => {
          const repository = await validateApiOnlyRepositoryRoot(repositoryRoot, options);
          return backendEnvironmentValue(await readStablePrivateBytes(
            candidate.smokePath, candidate.secretsDirectory, repository));
        });
      if (typeof readPassword !== "function") throw error("API_ONLY_DISPOSABLE_PASSWORD_ADAPTER_INVALID");
      const password = await readPassword(runtime);
      if (!validSmokeSecret(password)) throw error("API_ONLY_DISPOSABLE_PASSWORD_INVALID");

      stage = "smoke";
      const runSmoke = options.runDisposableModuleSmoke
        ?? ((input) => runApiOnlyModuleSmoke({
          origin: input.origin,
          mode: "register",
          account: input.account,
          password: input.password,
          fetchImpl: options.smokeFetchImpl ?? options.fetchImpl,
          clock: options.smokeClock ?? options.clock,
          setTimeoutImpl: options.smokeSetTimeout,
          clearTimeoutImpl: options.smokeClearTimeout
        }));
      if (typeof runSmoke !== "function") throw error("API_ONLY_DISPOSABLE_SMOKE_ADAPTER_INVALID");
      const modules = await runSmoke({
        origin: `http://127.0.0.1:${identity.ports.gateway}`,
        mode: "register",
        account: identity.account,
        password
      });
      if (!validDisposableSmokeReport(modules)) throw error("API_ONLY_DISPOSABLE_SMOKE_REPORT_INVALID");

      stage = "gateway";
      const verifyGateway = options.verifyDisposableGateway
        ?? ((input) => verifyApiOnlyGatewayBoundary({
          origin: input.origin,
          fetchImpl: options.gatewayFetchImpl ?? options.fetchImpl,
          upgradeProbe: options.gatewayUpgradeProbe,
          setTimeoutImpl: options.gatewaySetTimeout,
          clearTimeoutImpl: options.gatewayClearTimeout
        }));
      if (typeof verifyGateway !== "function") throw error("API_ONLY_DISPOSABLE_GATEWAY_ADAPTER_INVALID");
      const gateway = await verifyGateway({ origin: `http://127.0.0.1:${identity.ports.gateway}` });
      if (!validDisposableGatewayReport(gateway)) throw error("API_ONLY_DISPOSABLE_GATEWAY_REPORT_INVALID");

      stage = "build";
      const inspectBuild = options.inspectDisposableBuild
        ?? ((candidateRuntime, context) => inspectDisposableBuildEvidence(
          repositoryRoot, candidateRuntime, context, options));
      if (typeof inspectBuild !== "function") throw error("API_ONLY_DISPOSABLE_BUILD_INSPECTOR_REQUIRED");
      const inspected = await inspectBuild(runtime, { sourceManifestHash: sourceManifest.rootHash });
      if (!inspected || typeof inspected !== "object" || Array.isArray(inspected)
        || JSON.stringify(Object.keys(inspected)) !== JSON.stringify(["imageIdDigest", "composeConfigHash"])
        || !IMAGE_ID_DIGEST.test(inspected.imageIdDigest)
        || !HASH.test(inspected.composeConfigHash)) {
        throw error("API_ONLY_DISPOSABLE_BUILD_EVIDENCE_INVALID");
      }
      const builtAt = now();
      const build = Object.freeze({
        sourceManifestHash: sourceManifest.rootHash,
        imageIdDigest: inspected.imageIdDigest,
        composeConfigHash: inspected.composeConfigHash,
        builtAt
      });

      stage = "evidence";
      const report = disposableSuccessReport(identity, Object.freeze(modules), gateway, build, now());
      const serialized = JSON.stringify(report);
      if ([password, identity.account].some((secret) => serialized.includes(secret))
        || /(?:bearerToken|csrfToken|"token")/u.test(serialized)) {
        throw error("API_ONLY_DISPOSABLE_EVIDENCE_SECRET");
      }
      evidence = await persistEvidence(runtime, report);
      if (!evidence?.retained?.path || !HASH.test(evidence?.retained?.sha256 ?? "")) {
        throw error("API_ONLY_DISPOSABLE_EVIDENCE_INVALID");
      }
      stage = "cleanup";
      return Object.freeze({
        projectSuffix: identity.suffix,
        modules: Object.freeze(modules),
        gateway,
        build,
        retainedEvidence: evidence.retained
      });
    } catch (caught) {
      failureCode = safeDisposableFailureCode(caught);
      throw error(`API_ONLY_EMPTY_VERIFICATION_FAILED:${stage}`);
    }
  });
  if (!cleanupResult || cleanupResult.cleanup !== "complete") {
    throw error("API_ONLY_DISPOSABLE_CLEANUP_FAILED");
  }
  return Object.freeze({ ...verified, cleanup: Object.freeze(cleanupResult) });
}

const TASK5_WRITER_NAMES = Object.freeze([
  "backend", "gateway", "frontend", "sidecar", "tunnel"
]);
const TASK5_SOURCE = Object.freeze({
  database: "shensi_trial", host: "127.0.0.1", port: 3310
});
const TASK5_TARGET = Object.freeze({
  database: "shensi", host: "127.0.0.1", port: 3311
});

function task5SafeId(value) {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 255
    && !/[\0\r\n]/u.test(value);
}

function task5Build(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && HASH.test(value.sourceManifestHash ?? "")
    && IMAGE_ID_DIGEST.test(value.imageIdDigest ?? "")
    && HASH.test(value.composeConfigHash ?? "")
    && validUtcTimestamp(value.builtAt);
}

function sameTask5Build(left, right) {
  return task5Build(left) && task5Build(right)
    && left.sourceManifestHash === right.sourceManifestHash
    && left.imageIdDigest === right.imageIdDigest
    && left.composeConfigHash === right.composeConfigHash;
}

function task5EvidenceDescriptor(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && HASH.test(value.sha256 ?? "")
    && value.basename === `${value.sha256}.json`;
}

function task5ArtifactDescriptor(value, suffix) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 2
    && Object.hasOwn(value, "basename")
    && Object.hasOwn(value, "sha256")
    && task5SafeId(value.basename)
    && basename(value.basename) === value.basename
    && value.basename.endsWith(suffix)
    && HASH.test(value.sha256 ?? "");
}

function task5MigrationArtifacts(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 4
    && value.ok === true
    && task5ArtifactDescriptor(value.manifest, ".sql.enc.migration-manifest.json")
    && task5ArtifactDescriptor(value.encryptedBackup, ".sql.enc")
    && task5ArtifactDescriptor(value.verification, ".json")
    && new Set([
      value.manifest.basename, value.encryptedBackup.basename, value.verification.basename
    ]).size === 3;
}

function task5ActionBridgeResult(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 3
    && value.version === "desktop-outreach-action-bridge-v1"
    && HASH.test(value.sha256 ?? "")
    && task5ArtifactDescriptor(value.preservationReport, ".json");
}

function task5Prerequisites(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && value.actionBridge?.version === "desktop-outreach-action-bridge-v1"
    && HASH.test(value.actionBridge?.sha256 ?? "")
    && HASH.test(value.featureParity?.tasks1To4Sha256 ?? "")
    && HASH.test(value.featureParity?.task5HarnessSha256 ?? "");
}

function task5Inventory(value) {
  const names = [
    "legacyServerActions", "desktopNonTerminalActions", "desktopInFlightWrites"
  ];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || names.some((name) => !value[name]
      || !Number.isSafeInteger(value[name].count) || value[name].count < 0
      || !Array.isArray(value[name].ids)
      || value[name].ids.length > 1_000
      || value[name].ids.some((id) => !task5SafeId(id))
      || new Set(value[name].ids).size !== value[name].ids.length)) return false;
  return true;
}

function task5MysqlIdentity(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value)) === JSON.stringify([
      "authenticatedUser", "database", "port", "datadir", "serverIdentitySha256", "sql"
    ])
    && value.authenticatedUser === "shensi_trial_app@127.0.0.1"
    && value.database === TASK5_SOURCE.database
    && value.port === TASK5_SOURCE.port
    && value.datadir === "retained-trial"
    && HASH.test(value.serverIdentitySha256 ?? "")
    && value.sql === "ok";
}

function task5Trial(value) {
  const lifecycle = (entry) => entry?.state ?? entry?.status;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.mysql?.name !== "mysql" || lifecycle(value.mysql) !== "owned"
    || !Number.isSafeInteger(value.mysql?.pid) || value.mysql.pid <= 1
    || (value.mysql.identity !== undefined && !task5MysqlIdentity(value.mysql.identity))
    || !Array.isArray(value.writers) || value.writers.length !== TASK5_WRITER_NAMES.length) return false;
  const ordered = [...value.writers].sort((left, right) => left.name.localeCompare(right.name));
  const expected = [...TASK5_WRITER_NAMES].sort();
  return ordered.every((writer, index) => writer?.name === expected[index]
    && ["owned", "absent"].includes(lifecycle(writer))
    && (lifecycle(writer) === "owned"
      ? Number.isSafeInteger(writer.pid) && writer.pid > 1
      : writer.pid === null));
}

function task5PublicSnapshot(value) {
  const lifecycle = (entry) => entry?.state ?? entry?.status;
  const identity = task5MysqlIdentity(value.mysql.identity)
    ? Object.freeze({ ...value.mysql.identity })
    : undefined;
  return Object.freeze({
    mysql: Object.freeze({
      name: value.mysql.name, pid: value.mysql.pid, state: lifecycle(value.mysql),
      ...(identity ? { identity } : {})
    }),
    writers: Object.freeze(value.writers.map((writer) => Object.freeze({
      name: writer.name, pid: writer.pid, state: lifecycle(writer)
    })))
  });
}

function parseTask5MysqlUrl(value, code) {
  let parsed;
  try { parsed = new URL(value); } catch { throw error(code); }
  const port = Number(parsed.port || 3306);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  if (parsed.protocol !== "mysql:" || parsed.hostname !== "127.0.0.1"
    || !parsed.username || !database || !Number.isSafeInteger(port)
    || port < 1 || port > 65_535) throw error(code);
  return Object.freeze({
    host: parsed.hostname,
    port,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database
  });
}

async function task5MysqlConnection(input) {
  const mysql = await import(new URL(
    "../backend/node_modules/mysql2/promise.js", import.meta.url
  ));
  return mysql.createConnection(input);
}

async function rotateTask5Secret(path, value, options = {}) {
  if (!task5SafeId(value) || !isAbsolute(path)) {
    throw error("API_ONLY_MIGRATION_READER_SECRET_INVALID");
  }
  const directory = dirname(path);
  await privateDirectory(directory);
  const random = options.secretTemporaryRandomBytes ?? nativeRandomBytes;
  let entropy;
  try { entropy = random(16); } catch {
    throw error("API_ONLY_MIGRATION_READER_SECRET_INVALID");
  }
  if (!(Buffer.isBuffer(entropy) || entropy instanceof Uint8Array)
    || entropy.byteLength !== 16) {
    throw error("API_ONLY_MIGRATION_READER_SECRET_INVALID");
  }
  const temporary = join(directory, `.${basename(path)}.${Buffer.from(entropy).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | (FS.O_NOFOLLOW ?? 0), PRIVATE_MODE);
    await handle.writeFile(Buffer.from(value, "utf8"));
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    await chmod(path, PRIVATE_MODE);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== PRIVATE_MODE
      || Number(info.size) !== Buffer.byteLength(value, "utf8")) {
      throw error("API_ONLY_MIGRATION_READER_SECRET_INVALID");
    }
  } catch (caught) {
    try { await handle?.close(); } catch { /* Preserve the primary failure. */ }
    await unlink(temporary).catch(() => {});
    if (caught?.message === "API_ONLY_MIGRATION_READER_SECRET_INVALID") throw caught;
    throw error("API_ONLY_MIGRATION_READER_SECRET_INVALID");
  }
}

export async function provisionTrialMigrationReader(options = {}) {
  const repositoryRoot = options.repositoryRoot;
  absolute(repositoryRoot, "API_ONLY_REPOSITORY_ROOT_INVALID");
  const admin = parseTask5MysqlUrl(
    options.adminDatabaseUrl ?? "mysql://root@127.0.0.1:3310/mysql",
    "API_ONLY_MIGRATION_READER_ADMIN_INVALID"
  );
  if (admin.port !== TASK5_SOURCE.port || admin.database !== "mysql") {
    throw error("API_ONLY_MIGRATION_READER_ADMIN_INVALID");
  }
  const random = options.randomBytes ?? nativeRandomBytes;
  let entropy;
  try { entropy = random(48); } catch {
    throw error("API_ONLY_MIGRATION_READER_SECRET_INVALID");
  }
  if (!(Buffer.isBuffer(entropy) || entropy instanceof Uint8Array)
    || entropy.byteLength !== 48) {
    throw error("API_ONLY_MIGRATION_READER_SECRET_INVALID");
  }
  const password = Buffer.from(entropy).toString("base64url");
  const connect = options.createConnection ?? task5MysqlConnection;
  if (typeof connect !== "function") throw error("API_ONLY_MIGRATION_READER_ADAPTER_INVALID");
  let connection;
  try {
    connection = await connect(admin);
    if (!connection || typeof connection.execute !== "function"
      || typeof connection.end !== "function") {
      throw error("API_ONLY_MIGRATION_READER_ADAPTER_INVALID");
    }
    await connection.execute("CREATE USER IF NOT EXISTS 'shensi_migration_reader'@'127.0.0.1'");
    await connection.execute("ALTER USER 'shensi_migration_reader'@'127.0.0.1' IDENTIFIED BY ?", [password]);
    await connection.execute("REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'shensi_migration_reader'@'127.0.0.1'");
    await connection.execute("GRANT SELECT, SHOW VIEW, TRIGGER ON `shensi_trial`.* TO 'shensi_migration_reader'@'127.0.0.1'");
    const [rows] = await connection.execute("SHOW GRANTS FOR 'shensi_migration_reader'@'127.0.0.1'");
    const grants = Array.isArray(rows)
      ? rows.flatMap((row) => Object.values(row ?? {}).filter((entry) => typeof entry === "string"))
      : [];
    const principal = "(?:`shensi_migration_reader`|'shensi_migration_reader')@(?:`127\\.0\\.0\\.1`|'127\\.0\\.0\\.1')";
    const expectedGrant = new RegExp(
      "^GRANT SELECT, SHOW VIEW, TRIGGER ON `shensi_trial`\\.\\* TO " + principal + "$", "u"
    );
    const usageGrant = new RegExp("^GRANT USAGE ON \\*\\.\\* TO " + principal + "$", "u");
    if (grants.filter((grant) => expectedGrant.test(grant)).length !== 1
      || grants.some((grant) => !expectedGrant.test(grant) && !usageGrant.test(grant))) {
      throw error("API_ONLY_MIGRATION_READER_GRANT_INVALID");
    }
    const secretFile = join(repositoryRoot, ".runtime", "api-only", "secrets", "migration_reader_password");
    await (options.writeSecret ?? rotateTask5Secret)(secretFile, password, options);
    return Object.freeze({
      user: "shensi_migration_reader",
      host: "127.0.0.1",
      database: "shensi_trial",
      privileges: Object.freeze(["SELECT", "SHOW VIEW", "TRIGGER"]),
      secretFile
    });
  } catch (caught) {
    if (caught?.message?.startsWith("API_ONLY_MIGRATION_")) throw caught;
    throw error("API_ONLY_MIGRATION_READER_PROVISION_FAILED");
  } finally {
    if (connection) {
      try { await connection.end(); }
      catch { throw error("API_ONLY_MIGRATION_READER_CLOSE_FAILED"); }
    }
  }
}

async function readLatestTask5EmptyEvidence(repositoryRoot, options = {}) {
  const directory = join(repositoryRoot, ".runtime", "api-only", "evidence", "empty");
  let names;
  try { names = (await readdir(directory)).filter((name) => /^[a-f0-9]{12}\.json$/u.test(name)); }
  catch { throw error("API_ONLY_MIGRATION_EMPTY_EVIDENCE_MISSING"); }
  const candidates = [];
  for (const name of names) {
    const snapshot = await readPrivateJsonSnapshot(
      join(directory, name), "API_ONLY_MIGRATION_EMPTY_EVIDENCE_INVALID", options
    );
    if (snapshot?.value?.result === "passed" && task5Build(snapshot.value.build)) {
      candidates.push({
        descriptor: Object.freeze({
          basename: `${sha256(snapshot.canonicalText)}.json`,
          sha256: sha256(snapshot.canonicalText)
        }),
        report: snapshot.value
      });
    }
  }
  candidates.sort((left, right) => String(right.report.verifiedAt).localeCompare(String(left.report.verifiedAt)));
  if (!candidates.length) throw error("API_ONLY_MIGRATION_EMPTY_EVIDENCE_MISSING");
  return Object.freeze(candidates[0]);
}

async function readTask5PrerequisiteEvidence(repositoryRoot, options = {}) {
  const directory = join(repositoryRoot, ".runtime", "api-only", "evidence", "prerequisites");
  const names = [
    "desktop-outreach-action-bridge-v1.json",
    "desktop-feature-parity-tasks-1-4.json",
    "desktop-feature-parity-task-5-harness.json"
  ];
  const values = [];
  for (const name of names) {
    let snapshot;
    try {
      snapshot = await readPrivateJsonSnapshot(
        join(directory, name), "API_ONLY_MIGRATION_PREREQUISITE_EVIDENCE_INVALID", options
      );
    } catch (caught) {
      if (caught?.message === "API_ONLY_MIGRATION_PREREQUISITE_EVIDENCE_INVALID") return null;
      throw caught;
    }
    if (!snapshot) return null;
    values.push({ value: snapshot.value, sha256: sha256(snapshot.canonicalText) });
  }
  if (values[0].value?.version !== "desktop-outreach-action-bridge-v1"
    || values.some(({ value }) => value?.result !== "passed")) return null;
  return Object.freeze({
    actionBridge: Object.freeze({ version: values[0].value.version, sha256: values[0].sha256 }),
    featureParity: Object.freeze({
      tasks1To4Sha256: values[1].sha256,
      task5HarnessSha256: values[2].sha256
    })
  });
}

async function readTask5TrialDatabaseUrl(repositoryRoot) {
  const path = join(repositoryRoot, ".runtime", "real-trial", "trial.env");
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077)) {
    throw error("API_ONLY_MIGRATION_TRIAL_ENV_INVALID");
  }
  const text = await readFile(path, "utf8");
  const rows = text.split("\n").filter(Boolean);
  const matches = rows.filter((row) => row.startsWith("DATABASE_URL="));
  if (matches.length !== 1) throw error("API_ONLY_MIGRATION_TRIAL_ENV_INVALID");
  const value = matches[0].slice("DATABASE_URL=".length);
  const parsed = parseTask5MysqlUrl(value, "API_ONLY_MIGRATION_TRIAL_ENV_INVALID");
  if (parsed.database !== TASK5_SOURCE.database || parsed.port !== TASK5_SOURCE.port) {
    throw error("API_ONLY_MIGRATION_TRIAL_ENV_INVALID");
  }
  return value;
}

async function queryTask5ActionInventory(repositoryRoot, options = {}) {
  const databaseUrl = await (options.readTrialDatabaseUrl ?? readTask5TrialDatabaseUrl)(repositoryRoot);
  const parsed = parseTask5MysqlUrl(databaseUrl, "API_ONLY_MIGRATION_TRIAL_ENV_INVALID");
  const connect = options.createActionInventoryConnection ?? task5MysqlConnection;
  let connection;
  try {
    connection = await connect(parsed);
    const [columnRows] = await connection.execute(`SELECT COLUMN_NAME AS column_name
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='acquisition_outreach_actions'
        AND COLUMN_NAME='execution_target'`);
    const hasExecutionTarget = Array.isArray(columnRows)
      && columnRows.some((row) => String(row.column_name) === "execution_target");
    const nonTerminal = "('queued','blocked_by_predecessor','claimed','executing','risk_paused','reconciliation_required')";
    const targetExpression = hasExecutionTarget ? "execution_target" : "'server'";
    const [countRows] = await connection.execute(`SELECT ${targetExpression} AS execution_target,
      status, COUNT(*) AS action_count
      FROM acquisition_outreach_actions
      WHERE status IN ${nonTerminal}
      GROUP BY ${targetExpression},status`);
    const [serverRows] = await connection.execute(`SELECT id,status
      FROM acquisition_outreach_actions
      WHERE status IN ${nonTerminal}${hasExecutionTarget ? " AND execution_target='server'" : ""}
      ORDER BY id LIMIT 1000`);
    const [desktopRows] = hasExecutionTarget
      ? await connection.execute(`SELECT id,status
        FROM acquisition_outreach_actions
        WHERE status IN ${nonTerminal} AND execution_target='desktop'
        ORDER BY id LIMIT 1000`)
      : [[]];
    const countFor = (target, states = null) => Array.isArray(countRows)
      ? countRows.reduce((total, row) => {
        const rowTarget = String(row.execution_target ?? "server");
        const status = String(row.status ?? "");
        const count = Number(row.action_count);
        if (!Number.isSafeInteger(count) || count < 0) return Number.NaN;
        if (rowTarget !== target || states && !states.has(status)) return total;
        return total + count;
      }, 0)
      : Number.NaN;
    const stableRows = (rows) => Array.isArray(rows)
      ? rows.map((row) => ({ id: String(row.id ?? ""), status: String(row.status ?? "") }))
      : [];
    const server = stableRows(serverRows);
    const desktop = stableRows(desktopRows);
    const inFlightStates = new Set(["claimed", "executing", "reconciliation_required"]);
    const inFlight = desktop.filter(({ status }) => inFlightStates.has(status));
    const value = {
      legacyServerActions: { count: countFor("server"), ids: server.map(({ id }) => id) },
      desktopNonTerminalActions: { count: countFor("desktop"), ids: desktop.map(({ id }) => id) },
      desktopInFlightWrites: {
        count: countFor("desktop", inFlightStates), ids: inFlight.map(({ id }) => id)
      }
    };
    if (!task5Inventory(value)
      || value.legacyServerActions.ids.length !== Math.min(value.legacyServerActions.count, 1_000)
      || value.desktopNonTerminalActions.ids.length !== Math.min(value.desktopNonTerminalActions.count, 1_000)
      || value.desktopInFlightWrites.ids.length > Math.min(value.desktopInFlightWrites.count, 1_000)) {
      throw error("API_ONLY_MIGRATION_ACTION_INVENTORY_INVALID");
    }
    return value;
  } catch (caught) {
    if (caught?.message?.startsWith("API_ONLY_MIGRATION_")) throw caught;
    throw error("API_ONLY_MIGRATION_ACTION_INVENTORY_FAILED");
  } finally {
    if (connection) await connection.end().catch(() => {});
  }
}

async function task5GitCommit(repositoryRoot, options = {}) {
  const run = options.execFile ?? execFile;
  let result;
  try {
    result = await run("/usr/bin/git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      maxBuffer: 4_096,
      shell: false,
      timeout: 3_000
    });
  } catch { throw error("API_ONLY_MIGRATION_COMMIT_INVALID"); }
  const commit = String(result?.stdout ?? result ?? "").trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) {
    throw error("API_ONLY_MIGRATION_COMMIT_INVALID");
  }
  return commit;
}

async function persistTask5Evidence(repositoryRoot, report, options = {}) {
  const root = join(repositoryRoot, ".runtime", "api-only");
  const repository = await validateApiOnlyRepositoryRoot(repositoryRoot, options);
  await ensureApiOnlyRuntimeRoot(repository, root, { create: true });
  const evidence = await privateDirectory(join(root, "evidence"));
  const directory = await privateDirectory(join(evidence, "migration"));
  const text = json(report);
  const digest = sha256(text);
  const path = join(directory, `${digest}.json`);
  await privateFile(path, text);
  return Object.freeze({ basename: basename(path), sha256: digest });
}

function task5Transition(previous, state, evidenceManifest, now, extras = {}) {
  const source = previous
    ? previous.source
    : { database: TASK5_SOURCE.database, port: TASK5_SOURCE.port, commit: extras.commit };
  const target = previous
    ? previous.target
    : { database: TASK5_TARGET.database, port: TASK5_TARGET.port, commit: extras.commit };
  return {
    attemptId: extras.attemptId ?? previous.attemptId,
    project: extras.project ?? previous.project,
    source,
    target,
    state,
    activeRuntime: state === "prepared" ? "trial"
      : state === "failed_recovered" ? "trial" : null,
    rollbackClosedAt: null,
    desktopClientAdmission: {
      mode: "migration_locked", admittedBuildManifestSha256: null
    },
    transitionedAt: now,
    evidenceManifest,
    failure: extras.failure ?? (state === "failed_recovered" ? previous.failure : null),
    recoveryEvidence: extras.recoveryEvidence ?? null,
    writeActivation: null,
    acceptedVersion: null
  };
}

function task5FreezeIntentPath(repositoryRoot) {
  return join(repositoryRoot, ".runtime", "api-only", "migration-freeze-intent.json");
}

function validTask5FreezeIntent(value, journal) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value)) === JSON.stringify([
      "schema", "version", "attemptId", "project", "createdAt", "evidence"
    ])
    && value.schema === "shensi.api-only.source-freeze-intent"
    && value.version === 1
    && value.attemptId === journal?.activeAttemptId
    && value.project === `shensi-api-migration-${value.attemptId}`
    && validUtcTimestamp(value.createdAt)
    && task5EvidenceDescriptor(value.evidence);
}

async function readTask5FreezeIntent(repositoryRoot, journal, options = {}) {
  const intent = await readPrivateJson(
    task5FreezeIntentPath(repositoryRoot), "API_ONLY_MIGRATION_FREEZE_INTENT_INVALID", options
  );
  if (intent === null) return null;
  if (!validTask5FreezeIntent(intent, journal)) {
    throw error("API_ONLY_MIGRATION_FREEZE_INTENT_INVALID");
  }
  return intent;
}

async function writeTask5FreezeIntent(repositoryRoot, journal, snapshot, now, options = {}) {
  const report = {
    schema: "shensi.api-only.source-freeze-intent-evidence",
    version: 1,
    result: "pending",
    createdAt: now,
    attemptId: journal.activeAttemptId,
    project: `shensi-api-migration-${journal.activeAttemptId}`,
    writers: task5PublicSnapshot(snapshot).writers
  };
  const evidence = await (options.persistMigrationEvidence ?? persistTask5Evidence)(
    repositoryRoot, report, options
  );
  if (!task5EvidenceDescriptor(evidence)) {
    throw error("API_ONLY_MIGRATION_FREEZE_INTENT_INVALID");
  }
  const intent = {
    schema: "shensi.api-only.source-freeze-intent",
    version: 1,
    attemptId: journal.activeAttemptId,
    project: `shensi-api-migration-${journal.activeAttemptId}`,
    createdAt: now,
    evidence
  };
  await writePrivateJson(task5FreezeIntentPath(repositoryRoot), intent, options);
  return Object.freeze(intent);
}

async function clearTask5FreezeIntent(repositoryRoot) {
  try {
    await unlink(task5FreezeIntentPath(repositoryRoot));
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw error("API_ONLY_MIGRATION_FREEZE_INTENT_CLEAR_FAILED");
  }
}

async function markTask5FreezeIntentAsSourceFrozen(repositoryRoot, journal, intent, options = {}) {
  if (journal?.state !== "prepared" || !validTask5FreezeIntent(intent, journal)) {
    throw error("API_ONLY_MIGRATION_FREEZE_INTENT_INVALID");
  }
  const now = options.now?.() ?? new Date().toISOString();
  if (!validUtcTimestamp(now)) throw error("API_ONLY_MIGRATION_TIME_INVALID");
  const previous = journal.attemptSummaries.at(-1);
  const built = authorityResolver.buildNextMigrationJournal(journal, task5Transition(
    previous, "source_frozen", intent.evidence, now
  ));
  await writePrivateJson(
    join(repositoryRoot, ".runtime", "api-only", "migration-state.json"), built.journal, options
  );
  return built.journal;
}

function task5AttemptId(random) {
  let bytes;
  try { bytes = random(6); } catch { throw error("API_ONLY_MIGRATION_ATTEMPT_ID_INVALID"); }
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) || bytes.byteLength !== 6) {
    throw error("API_ONLY_MIGRATION_ATTEMPT_ID_INVALID");
  }
  return Buffer.from(bytes).toString("hex");
}

function task5FailureCode(caught) {
  const raw = typeof caught?.message === "string" ? caught.message : "";
  if (!/^(?:API_ONLY|DATA|BACKUP|RESTORE)_[A-Z0-9_:,-]{1,512}$/u.test(raw)) {
    return "API_ONLY_MIGRATION_FAILED";
  }
  const normalized = raw.replace(/[^A-Z0-9_:-]+/gu, ":").slice(0, 128);
  return /^[A-Z][A-Z0-9_:-]{0,127}$/u.test(normalized)
    ? normalized
    : "API_ONLY_MIGRATION_FAILED";
}

async function task5CurrentBuild(repositoryRoot, existing, options) {
  const verify = options.refreshEmptyVerification
    ?? ((root) => verifyEmptyApiOnlyRuntime(root, options.emptyVerificationOptions ?? {}));
  const fresh = await verify(repositoryRoot);
  if (!task5Build(fresh?.build)) throw error("API_ONLY_MIGRATION_BUILD_EVIDENCE_INVALID");
  return fresh.build;
}

function task5Blockers({ prerequisites, inventory, trial, ports, emptyEvidence, currentBuild }) {
  const blockers = [];
  if (!task5Prerequisites(prerequisites)) blockers.push("DESKTOP_ACTION_BRIDGE_EVIDENCE_MISSING");
  if (!task5Trial(trial)) blockers.push("TRIAL_PROCESS_OWNERSHIP_INVALID");
  if (!emptyEvidence || !task5EvidenceDescriptor(emptyEvidence.descriptor)
    || emptyEvidence.report?.result !== "passed" || !task5Build(emptyEvidence.report?.build)) {
    blockers.push("EMPTY_DATABASE_EVIDENCE_INVALID");
  }
  if (currentBuild && !sameTask5Build(emptyEvidence?.report?.build, currentBuild)) {
    blockers.push("BUILD_EVIDENCE_CHANGED");
  }
  if (!task5Inventory(inventory)) blockers.push("ACTION_INVENTORY_INVALID");
  else {
    if (inventory.legacyServerActions.count !== 0) blockers.push("LEGACY_SERVER_ACTIONS_PRESENT");
    if (inventory.desktopNonTerminalActions.count !== 0) blockers.push("DESKTOP_NON_TERMINAL_ACTIONS_PRESENT");
    if (inventory.desktopInFlightWrites.count !== 0) blockers.push("DESKTOP_IN_FLIGHT_WRITES_PRESENT");
  }
  if (ports?.targetMysql3311 !== "free"
    || !["free", "owned_trial_writer"].includes(ports?.gateway5608)) {
    blockers.push("MIGRATION_PORTS_UNAVAILABLE");
  }
  return blockers;
}

const TASK5_OWNER_LOCK_HELD = Symbol("task5-owner-lock-held");

async function withTask5OwnerLock(repositoryRoot, options, callback) {
  if (options[TASK5_OWNER_LOCK_HELD] === true) return callback(options);
  const lockedOptions = { ...options, [TASK5_OWNER_LOCK_HELD]: true };
  const injected = options.withMigrationOwnerLock;
  if (injected !== undefined) {
    if (typeof injected !== "function") throw error("API_ONLY_MIGRATION_OWNER_LOCK_INVALID");
    return injected(() => callback(lockedOptions));
  }
  return withApiOnlyOwnerLock(retainedOwnerLockInput(repositoryRoot, {
    ...options,
    randomBytes: options.ownerLockRandomBytes ?? nativeRandomBytes
  }), () => callback(lockedOptions));
}

async function prepareTrialToApiOnlyMigrationUnlocked(repositoryRoot, options = {}) {
  absolute(repositoryRoot, "API_ONLY_REPOSITORY_ROOT_INVALID");
  const adapter = options.trialAdapter;
  if (!adapter || typeof adapter.inspect !== "function") {
    throw error("API_ONLY_MIGRATION_TRIAL_ADAPTER_REQUIRED");
  }
  const readPrerequisites = options.readPrerequisiteEvidence ?? readTask5PrerequisiteEvidence;
  const readEmpty = options.readEmptyVerificationEvidence ?? readLatestTask5EmptyEvidence;
  const queryInventory = options.queryActionInventory ?? queryTask5ActionInventory;
  const probePort = options.isMigrationPortAvailable ?? defaultDisposablePortAvailable;
  const checkPorts = options.checkMigrationPorts ?? (async () => ({
    targetMysql3311: await probePort(TASK5_TARGET.port),
    gateway5608: await probePort(5608)
  }));
  const [prerequisites, trialRaw, emptyEvidence, inventory, rawPorts] = await Promise.all([
    readPrerequisites(repositoryRoot, options),
    adapter.inspect(),
    readEmpty(repositoryRoot, options).catch((caught) => {
      if (caught?.message?.startsWith("API_ONLY_MIGRATION_EMPTY_EVIDENCE_")) return null;
      throw caught;
    }),
    queryInventory(repositoryRoot, options).catch((caught) => {
      if (caught?.message?.startsWith("API_ONLY_MIGRATION_ACTION_INVENTORY_")) return null;
      throw caught;
    }),
    checkPorts()
  ]);
  const trial = task5Trial(trialRaw) ? task5PublicSnapshot(trialRaw) : trialRaw;
  const gatewayOwned = task5Trial(trial)
    && trial.writers.some(({ name, state }) => name === "gateway" && state === "owned");
  const ports = {
    targetMysql3311: rawPorts?.targetMysql3311 === true ? "free"
      : rawPorts?.targetMysql3311 === false ? "occupied" : rawPorts?.targetMysql3311,
    gateway5608: gatewayOwned && rawPorts?.gateway5608 === false ? "owned_trial_writer"
      : rawPorts?.gateway5608 === true ? "free"
        : rawPorts?.gateway5608 === false ? "occupied" : rawPorts?.gateway5608
  };
  let blockers = task5Blockers({ prerequisites, inventory, trial, ports, emptyEvidence, currentBuild: null });
  let currentBuild = null;
  if (blockers.length === 0) {
    const capture = options.captureCurrentBuild ?? task5CurrentBuild;
    currentBuild = await capture(repositoryRoot, emptyEvidence.report.build, options);
    blockers = task5Blockers({ prerequisites, inventory, trial, ports, emptyEvidence, currentBuild });
  }
  const summary = {
    ready: blockers.length === 0,
    authorized: false,
    source: { ...TASK5_SOURCE },
    target: { ...TASK5_TARGET },
    writers: task5Trial(trial) ? trial.writers : [],
    mysql: task5Trial(trial) ? trial.mysql : null,
    legacyServerActions: task5Inventory(inventory) ? inventory.legacyServerActions : null,
    desktopNonTerminalActions: task5Inventory(inventory) ? inventory.desktopNonTerminalActions : null,
    desktopInFlightWrites: task5Inventory(inventory) ? inventory.desktopInFlightWrites : null,
    emptyVerificationEvidenceSha256: emptyEvidence?.descriptor?.sha256 ?? null,
    prerequisites: task5Prerequisites(prerequisites) ? prerequisites : null,
    blockers
  };
  if (blockers.length > 0) return Object.freeze(summary);

  const priorJournal = await authorityResolver.readMigrationJournal(repositoryRoot);
  if (priorJournal && priorJournal.state === "prepared") {
    return Object.freeze({
      ...summary,
      attemptId: priorJournal.activeAttemptId,
      project: `shensi-api-migration-${priorJournal.activeAttemptId}`
    });
  }
  if (priorJournal && !["failed_recovered", "rolled_back"].includes(priorJournal.state)) {
    throw error("API_ONLY_MIGRATION_STATE_CONFLICT");
  }
  const provision = options.provisionMigrationReader
    ?? ((input) => provisionTrialMigrationReader({ repositoryRoot, ...options, ...input }));
  await provision({ source: TASK5_SOURCE });
  const commit = await (options.gitCommit ?? task5GitCommit)(repositoryRoot, options);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) {
    throw error("API_ONLY_MIGRATION_COMMIT_INVALID");
  }
  const attemptId = task5AttemptId(options.randomBytes ?? nativeRandomBytes);
  const project = `shensi-api-migration-${attemptId}`;
  const now = options.now?.() ?? new Date().toISOString();
  if (!validUtcTimestamp(now)) throw error("API_ONLY_MIGRATION_TIME_INVALID");
  const report = {
    schema: "shensi.api-only.migration-preflight",
    version: 1,
    result: "passed",
    preparedAt: now,
    attemptId,
    project,
    source: TASK5_SOURCE,
    target: TASK5_TARGET,
    writers: summary.writers,
    mysql: summary.mysql,
    legacyServerActions: summary.legacyServerActions,
    desktopNonTerminalActions: summary.desktopNonTerminalActions,
    desktopInFlightWrites: summary.desktopInFlightWrites,
    emptyVerificationEvidenceSha256: summary.emptyVerificationEvidenceSha256,
    build: currentBuild,
    prerequisites
  };
  if (/password|passphrase|databaseUrl|token/iu.test(JSON.stringify(report))) {
    throw error("API_ONLY_MIGRATION_EVIDENCE_SECRET");
  }
  const evidence = await (options.persistMigrationEvidence ?? persistTask5Evidence)(repositoryRoot, report, options);
  const built = authorityResolver.buildNextMigrationJournal(priorJournal, task5Transition(
    null, "prepared", evidence, now, { attemptId, project, commit }
  ));
  await writePrivateJson(join(repositoryRoot, ".runtime", "api-only", "migration-state.json"), built.journal, options);
  return Object.freeze({ ...summary, attemptId, project, evidence });
}

export async function prepareTrialToApiOnlyMigration(repositoryRoot, options = {}) {
  return withTask5OwnerLock(repositoryRoot, options, (lockedOptions) => (
    prepareTrialToApiOnlyMigrationUnlocked(repositoryRoot, lockedOptions)
  ));
}

async function freezeTrialWritersUnlocked(repositoryRoot, options = {}) {
  absolute(repositoryRoot, "API_ONLY_REPOSITORY_ROOT_INVALID");
  if (options.authorized !== true) throw error("API_ONLY_MIGRATION_AUTHORIZATION_REQUIRED");
  const journal = await authorityResolver.readMigrationJournal(repositoryRoot);
  if (!journal || journal.state !== "prepared") throw error("API_ONLY_MIGRATION_PREPARED_REQUIRED");
  const adapter = options.trialAdapter;
  if (!adapter || typeof adapter.inspect !== "function" || typeof adapter.freezeWriters !== "function") {
    throw error("API_ONLY_MIGRATION_TRIAL_ADAPTER_REQUIRED");
  }
  const inventory = await (options.queryActionInventory ?? queryTask5ActionInventory)(repositoryRoot, options);
  if (!task5Inventory(inventory)
    || inventory.legacyServerActions.count !== 0
    || inventory.desktopNonTerminalActions.count !== 0
    || inventory.desktopInFlightWrites.count !== 0) {
    throw error("API_ONLY_MIGRATION_ACTIONS_NOT_QUIESCENT");
  }
  const snapshot = await adapter.inspect();
  if (!task5Trial(snapshot)) throw error("API_ONLY_MIGRATION_TRIAL_OWNERSHIP_INVALID");
  const liveWriters = snapshot.writers.filter((writer) => writer.state === "owned");
  const now = options.now?.() ?? new Date().toISOString();
  if (!validUtcTimestamp(now)) throw error("API_ONLY_MIGRATION_TIME_INVALID");
  await writeTask5FreezeIntent(repositoryRoot, journal, snapshot, now, options);
  const stopped = await adapter.freezeWriters({ snapshot, liveWriters });
  const verifyPorts = options.verifyReleasedWriterPorts ?? (async () => {
    const results = await Promise.all([5608, 5610, 5611, 5612].map((port) => defaultDisposablePortAvailable(port)));
    return results.every(Boolean);
  });
  if (await verifyPorts() !== true) throw error("API_ONLY_MIGRATION_WRITER_PORT_STILL_OWNED");
  const previous = journal.attemptSummaries.at(-1);
  const report = {
    schema: "shensi.api-only.source-freeze",
    version: 1,
    result: "passed",
    frozenAt: now,
    attemptId: journal.activeAttemptId,
    mysql: task5PublicSnapshot(snapshot).mysql,
    stoppedWriters: liveWriters.map(({ name, pid }) => ({ name, pid })),
    absentWriters: snapshot.writers.filter(({ state }) => state === "absent").map(({ name }) => name)
  };
  const evidence = await (options.persistMigrationEvidence ?? persistTask5Evidence)(repositoryRoot, report, options);
  const built = authorityResolver.buildNextMigrationJournal(journal, task5Transition(
    previous, "source_frozen", evidence, now
  ));
  await writePrivateJson(join(repositoryRoot, ".runtime", "api-only", "migration-state.json"), built.journal, options);
  await clearTask5FreezeIntent(repositoryRoot);
  return Object.freeze({
    state: "source_frozen",
    attemptId: journal.activeAttemptId,
    project: previous.project,
    mysql: task5PublicSnapshot(snapshot).mysql,
    stopped,
    evidence
  });
}

export async function freezeTrialWriters(repositoryRoot, options = {}) {
  return withTask5OwnerLock(repositoryRoot, options, (lockedOptions) => (
    freezeTrialWritersUnlocked(repositoryRoot, lockedOptions)
  ));
}

async function task5RecoveryCheckpoint(options, stage, context) {
  const checkpoint = options.recoveryCheckpoint;
  if (checkpoint === undefined) return;
  if (typeof checkpoint !== "function"
    || typeof stage !== "string"
    || !/^[a-z][a-z0-9-]{0,63}$/u.test(stage)) {
    throw error("API_ONLY_MIGRATION_RECOVERY_CHECKPOINT_INVALID");
  }
  await checkpoint(stage, Object.freeze({
    attemptId: context.attemptId,
    project: context.project
  }));
}

function task5ExistingResult(journal) {
  const previous = journal.attemptSummaries.at(-1);
  return Object.freeze({
    state: journal.state,
    attemptId: previous.attemptId,
    project: previous.project,
    evidence: previous.recoveryEvidence ?? previous.evidenceManifest,
    resumed: true
  });
}

async function recoverTask5Migration(repositoryRoot, journal, options = {}) {
  const adapter = options.trialAdapter;
  if (!adapter || typeof adapter.restart !== "function" || typeof adapter.verifyRecovered !== "function") {
    throw error("API_ONLY_MIGRATION_RECOVERY_ADAPTER_REQUIRED");
  }
  if (typeof options.stopTargetProject !== "function") {
    throw error("API_ONLY_MIGRATION_TARGET_STOP_ADAPTER_REQUIRED");
  }
  const previous = journal.attemptSummaries.at(-1);
  const context = Object.freeze({ attemptId: previous.attemptId, project: previous.project });
  await task5RecoveryCheckpoint(options, "before-target-stop", context);
  await options.stopTargetProject({ project: previous.project, retainVolumes: true });
  await task5RecoveryCheckpoint(options, "after-target-stop", context);
  await task5RecoveryCheckpoint(options, "before-trial-restart", context);
  const runtime = await adapter.restart({
    onStage: async (stage) => task5RecoveryCheckpoint(options, stage, context)
  });
  await task5RecoveryCheckpoint(options, "after-full-trial-start", context);
  const verified = await adapter.verifyRecovered(runtime);
  if (verified?.ok !== true) throw error("API_ONLY_MIGRATION_TRIAL_RECOVERY_FAILED");
  await task5RecoveryCheckpoint(options, "after-health-login-verification", context);
  const now = options.now?.() ?? new Date().toISOString();
  if (!validUtcTimestamp(now)) throw error("API_ONLY_MIGRATION_TIME_INVALID");
  const report = {
    schema: "shensi.api-only.trial-recovery",
    version: 1,
    result: "passed",
    recoveredAt: now,
    attemptId: previous.attemptId,
    health: "mysql",
    login: "verified"
  };
  const evidence = await (options.persistMigrationEvidence ?? persistTask5Evidence)(repositoryRoot, report, options);
  const built = authorityResolver.buildNextMigrationJournal(journal, task5Transition(
    previous, "failed_recovered", previous.evidenceManifest, now,
    { recoveryEvidence: evidence }
  ));
  await task5RecoveryCheckpoint(options, "before-final-recovered-state-commit", context);
  await writePrivateJson(join(repositoryRoot, ".runtime", "api-only", "migration-state.json"), built.journal, options);
  await clearTask5FreezeIntent(repositoryRoot);
  await task5RecoveryCheckpoint(options, "after-final-recovered-state-commit", context);
  return Object.freeze({ state: "failed_recovered", attemptId: previous.attemptId, project: previous.project, evidence });
}

async function enterTask5RecoveryPending(repositoryRoot, journal, failureCode, options = {}) {
  const previous = journal?.attemptSummaries?.at(-1);
  if (!previous || !["source_frozen", "target_restored"].includes(journal.state)
    || !/^[A-Z][A-Z0-9_:-]{0,127}$/u.test(failureCode)) {
    throw error("API_ONLY_MIGRATION_RECOVERY_PENDING_INPUT_INVALID");
  }
  const now = options.now?.() ?? new Date().toISOString();
  if (!validUtcTimestamp(now)) throw error("API_ONLY_MIGRATION_TIME_INVALID");
  const failureReport = {
    schema: "shensi.api-only.migration-failure",
    version: 1,
    failedAt: now,
    attemptId: previous.attemptId,
    failureCode
  };
  const failureEvidence = await (options.persistMigrationEvidence ?? persistTask5Evidence)(
    repositoryRoot, failureReport, options
  );
  const pending = authorityResolver.buildNextMigrationJournal(journal, task5Transition(
    previous, "recovery_pending", failureEvidence, now,
    { failure: { code: failureCode, evidence: failureEvidence } }
  ));
  await writePrivateJson(
    join(repositoryRoot, ".runtime", "api-only", "migration-state.json"), pending.journal, options
  );
  await task5RecoveryCheckpoint(options, "after-recovery-pending-entry", {
    attemptId: previous.attemptId,
    project: previous.project
  });
  return pending.journal;
}

async function runTrialToApiOnlyMigrationUnlocked(repositoryRoot, options = {}) {
  absolute(repositoryRoot, "API_ONLY_REPOSITORY_ROOT_INVALID");
  let existing = await authorityResolver.readMigrationJournal(repositoryRoot);
  const freezeIntent = existing
    ? await readTask5FreezeIntent(repositoryRoot, existing, options)
    : null;
  if (existing?.state === "prepared" && freezeIntent) {
    existing = await markTask5FreezeIntentAsSourceFrozen(
      repositoryRoot, existing, freezeIntent, options
    );
  }
  if (existing?.state === "recovery_pending") {
    return recoverTask5Migration(repositoryRoot, existing, options);
  }
  if (existing?.state === "source_frozen") {
    const pending = await enterTask5RecoveryPending(
      repositoryRoot, existing, "API_ONLY_MIGRATION_INTERRUPTED_AFTER_FREEZE", options
    );
    return recoverTask5Migration(repositoryRoot, pending, options);
  }
  if (existing?.state === "target_restored") return task5ExistingResult(existing);
  if (["failed_recovered", "rolled_back"].includes(existing?.state)
    && options.retryAuthorized !== true) {
    return task5ExistingResult(existing);
  }
  if (options.authorized !== true) throw error("API_ONLY_MIGRATION_AUTHORIZATION_REQUIRED");
  if (typeof options.upgradeActionBridge !== "function") {
    throw error("API_ONLY_MIGRATION_ACTION_BRIDGE_UPGRADER_REQUIRED");
  }
  if (typeof options.runMigrationProcess !== "function") {
    throw error("API_ONLY_MIGRATION_PROCESS_ADAPTER_REQUIRED");
  }
  if (typeof options.stopTargetProject !== "function") {
    throw error("API_ONLY_MIGRATION_TARGET_STOP_ADAPTER_REQUIRED");
  }
  const prepared = await prepareTrialToApiOnlyMigration(repositoryRoot, options);
  if (!prepared.ready) throw error(`API_ONLY_MIGRATION_PREFLIGHT_BLOCKED:${prepared.blockers.join(",")}`);
  let frozen;
  try {
    frozen = await freezeTrialWriters(repositoryRoot, options);
  } catch (caught) {
    let journal = await authorityResolver.readMigrationJournal(repositoryRoot);
    const intent = journal
      ? await readTask5FreezeIntent(repositoryRoot, journal, options)
      : null;
    if (journal?.state === "prepared" && intent) {
      journal = await markTask5FreezeIntentAsSourceFrozen(
        repositoryRoot, journal, intent, options
      );
    }
    if (journal?.state !== "source_frozen") throw caught;
    const failureCode = task5FailureCode(caught);
    const pending = await enterTask5RecoveryPending(
      repositoryRoot, journal, failureCode, options
    );
    await recoverTask5Migration(repositoryRoot, pending, options);
    throw error(`API_ONLY_MIGRATION_FAILED_RECOVERED:${failureCode}`);
  }
  try {
    const frozenJournal = await authorityResolver.readMigrationJournal(repositoryRoot);
    const frozenAttempt = frozenJournal?.attemptSummaries?.at(-1);
    if (!frozenJournal || frozenJournal.state !== "source_frozen"
      || frozenJournal.activeAttemptId !== frozen.attemptId
      || frozenAttempt?.project !== frozen.project
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(frozenAttempt?.source?.commit ?? "")) {
      throw error("API_ONLY_MIGRATION_STATE_CONFLICT");
    }
    const migration = await options.runMigrationProcess({
      attemptId: frozen.attemptId,
      project: frozen.project,
      source: TASK5_SOURCE,
      target: TASK5_TARGET,
      sourceCommit: frozenAttempt.source.commit
    });
    if (!task5MigrationArtifacts(migration)) {
      throw error("API_ONLY_MIGRATION_ARTIFACTS_INVALID");
    }
    const upgraded = await options.upgradeActionBridge({
      attemptId: frozen.attemptId,
      project: frozen.project
    });
    if (!task5ActionBridgeResult(upgraded)) {
      throw error("API_ONLY_MIGRATION_ACTION_BRIDGE_RESULT_INVALID");
    }
    const journal = await authorityResolver.readMigrationJournal(repositoryRoot);
    if (!journal || journal.state !== "source_frozen") {
      throw error("API_ONLY_MIGRATION_STATE_CONFLICT");
    }
    const now = options.now?.() ?? new Date().toISOString();
    const previous = journal.attemptSummaries.at(-1);
    const report = {
      schema: "shensi.api-only.target-restored",
      version: 1,
      result: "passed",
      restoredAt: now,
      attemptId: previous.attemptId,
      migration,
      actionBridge: upgraded
    };
    const evidence = await (options.persistMigrationEvidence ?? persistTask5Evidence)(repositoryRoot, report, options);
    const built = authorityResolver.buildNextMigrationJournal(journal, task5Transition(
      previous, "target_restored", evidence, now
    ));
    await writePrivateJson(join(repositoryRoot, ".runtime", "api-only", "migration-state.json"), built.journal, options);
    return Object.freeze({ state: "target_restored", attemptId: previous.attemptId, project: previous.project, evidence });
  } catch (caught) {
    const journal = await authorityResolver.readMigrationJournal(repositoryRoot);
    if (!journal || journal.state !== "source_frozen") throw caught;
    const previous = journal.attemptSummaries.at(-1);
    const failureCode = task5FailureCode(caught);
    const pending = await enterTask5RecoveryPending(repositoryRoot, journal, failureCode, options);
    await recoverTask5Migration(repositoryRoot, pending, options);
    throw error(`API_ONLY_MIGRATION_FAILED_RECOVERED:${failureCode}`);
  }
}

export async function runTrialToApiOnlyMigration(repositoryRoot, options = {}) {
  return withTask5OwnerLock(repositoryRoot, options, (lockedOptions) => (
    runTrialToApiOnlyMigrationUnlocked(repositoryRoot, lockedOptions)
  ));
}

async function startTask5MigrationTargetDatabase(repositoryRoot, input) {
  const journal = await authorityResolver.readMigrationJournal(repositoryRoot);
  const attempt = journal?.attemptSummaries?.at(-1);
  if (journal?.state !== "source_frozen"
    || attempt?.project !== input?.project
    || JSON.stringify(input?.target) !== JSON.stringify(TASK5_TARGET)) {
    throw error("API_ONLY_MIGRATION_TARGET_CONTEXT_INVALID");
  }
  return startApiOnlyDatabaseUnlocked(repositoryRoot, {
    project: input.project,
    isPortAvailable: defaultDisposablePortAvailable
  });
}

async function stopTask5MigrationTargetProject(repositoryRoot, input) {
  const journal = await authorityResolver.readMigrationJournal(repositoryRoot);
  const attempt = journal?.attemptSummaries?.at(-1);
  if (journal?.state !== "recovery_pending"
    || attempt?.project !== input?.project
    || input?.retainVolumes !== true) {
    throw error("API_ONLY_MIGRATION_TARGET_CONTEXT_INVALID");
  }
  let runtime;
  try {
    runtime = await loadExistingApiOnlyRuntime(repositoryRoot, { project: input.project });
  } catch (caught) {
    if (caught?.message === "API_ONLY_RUNTIME_NOT_PREPARED") {
      return Object.freeze({ project: input.project, state: "absent", volumesRetained: true });
    }
    throw caught;
  }
  const result = await invoke(repositoryRoot, runtime, ["stop"], {});
  await waitForApiOnlyPortsReleased(runtime.ports, {
    isPortAvailable: defaultDisposablePortAvailable
  });
  return result;
}

async function main() {
  const root = process.cwd();
  const unavailable = (command) => async () => { throw error(`API_ONLY_COMMAND_NOT_IMPLEMENTED:${command}`); };
  const trialAdapter = async () => {
    const { createTrialCutoverAdapter } = await import("./trial-cutover-adapter.mjs");
    return createTrialCutoverAdapter(root);
  };
  const task5MigrationRunner = async () => {
    const { createTask5MigrationRunner } = await import("./task5-migration-runner.mjs");
    return createTask5MigrationRunner({
      repositoryRoot: root,
      startTargetDatabase: (input) => startTask5MigrationTargetDatabase(root, input),
      stopTargetProject: (input) => stopTask5MigrationTargetProject(root, input)
    });
  };
  return dispatchApiOnlyCli(process.argv.slice(2), {
    prepare: async () => {
      const runtime = await prepareApiOnlyRuntime(root);
      console.log(JSON.stringify({ project: runtime.project, root: runtime.root }));
    },
    "db-start": () => startApiOnlyDatabase(root),
    start: () => startApiOnlyRuntime(root),
    stop: () => stopApiOnlyRuntime(root),
    status: async () => { console.log(JSON.stringify(await apiOnlyStatus(root))); },
    verify: unavailable("verify"),
    "verify-empty": async () => { console.log(JSON.stringify(await verifyEmptyApiOnlyRuntime(root))); },
    "migration-preflight": async () => {
      console.log(JSON.stringify(await prepareTrialToApiOnlyMigration(root, {
        trialAdapter: await trialAdapter()
      })));
    },
    "migration-run": async () => {
      const migrationRunner = await task5MigrationRunner();
      console.log(JSON.stringify(await runTrialToApiOnlyMigration(root, {
        authorized: process.env.SHENSI_MIGRATION_AUTHORIZED === "true",
        trialAdapter: await trialAdapter(),
        runMigrationProcess: migrationRunner.runMigrationProcess,
        stopTargetProject: migrationRunner.stopTargetProject
      })));
    },
    cutover: unavailable("cutover"),
    rollback: unavailable("rollback"),
    "accept-prepare": unavailable("accept-prepare"),
    accept: unavailable("accept"),
    "accept-resume": unavailable("accept-resume"),
    "active-project": unavailable("active-project")
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((caught) => { console.error(caught?.message ?? "API_ONLY_RUNTIME_FAILED"); process.exitCode = 1; });
