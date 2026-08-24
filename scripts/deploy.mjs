import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPortAvailable, readEnvironmentFile, requiredLocalVariables } from "./dev.mjs";

const productionSecurityVariables = ["TRADE_OBSERVATION_CURSOR_SECRET", "MARKET_OPPORTUNITY_CURSOR_SECRET", "PROSPECT_RUN_IDEMPOTENCY_SECRET", "PROSPECT_RUN_CURSOR_SECRET", "PROSPECT_EXECUTION_CLAIM_SECRET", "ORGANIZATION_IDENTITY_MASTER_SECRET", "PROSPECT_SOURCE_RAW_ENVELOPE_SECRET", "PROSPECT_COVERAGE_MASTER_SECRET"];
export const requiredProductionVariables = [...requiredLocalVariables, ...productionSecurityVariables, "SESSION_COOKIE_SECURE", "SHENSI_MYSQL_APP_PASSWORD", "CORS_ORIGINS"];

export function loadProductionEnvironment(filePath, _ambient = {}) { return readEnvironmentFile(filePath); }

export function assertOwnerOnlyMode(filePath) {
  if (process.platform !== "win32" && (statSync(filePath).mode & 0o777) !== 0o600) throw new Error("PRODUCTION_ENV_PERMISSIONS_MUST_BE_0600");
}

function assertOwnerOnlySecret(filePath) {
  if (!existsSync(filePath)) throw new Error("PRODUCTION_SECRET_FILE_MISSING");
  if (process.platform !== "win32" && (statSync(filePath).mode & 0o077) !== 0) throw new Error("PRODUCTION_SECRET_FILE_PERMISSIONS_MUST_BE_OWNER_ONLY");
}

export function validateProductionVariables(environment) {
  const missing = requiredProductionVariables.filter((name) => !environment[name]?.trim());
  if (missing.length) throw new Error(`PRODUCTION_ENVIRONMENT_MISSING:${missing.join(",")}`);
  if (environment.CRM_STORE !== "mysql") throw new Error("PRODUCTION_CRM_STORE_MUST_BE_MYSQL");
  if (environment.CRM_SEED_DEVELOPMENT_DATA !== "false") throw new Error("PRODUCTION_DEVELOPMENT_SEEDING_FORBIDDEN");
  if (environment.SESSION_COOKIE_SECURE !== "true") throw new Error("PRODUCTION_SESSION_COOKIE_SECURE_REQUIRED");
  for (const name of [...requiredLocalVariables.slice(1), ...productionSecurityVariables]) {
    const value = environment[name].trim();
    if (value.length < 32 || value.startsWith("replace_")) throw new Error(`PRODUCTION_SECURITY_VALUE_INVALID:${name}`);
  }
}

export function validateProductionSecrets(environment, secretDirectory) {
  const appPasswordPath = resolve(secretDirectory, "mysql_app_password");
  const rootPasswordPath = resolve(secretDirectory, "mysql_root_password");
  assertOwnerOnlySecret(appPasswordPath);
  assertOwnerOnlySecret(rootPasswordPath);
  const appPassword = readFileSync(appPasswordPath, "utf8");
  const rootPassword = readFileSync(rootPasswordPath, "utf8");
  if (!appPassword || !rootPassword || /[\r\n]/u.test(appPassword) || /[\r\n]/u.test(rootPassword)) throw new Error("PRODUCTION_SECRET_FILE_MUST_BE_NEWLINE_FREE");
  if (Buffer.byteLength(appPassword, "utf8") < 32 || Buffer.byteLength(rootPassword, "utf8") < 32) throw new Error("PRODUCTION_SECRET_FILE_TOO_SHORT");
  if (environment.SHENSI_MYSQL_APP_PASSWORD !== appPassword) throw new Error("SHENSI_MYSQL_APP_PASSWORD_SECRET_MISMATCH");
  const rawPassword = /^mysql:\/\/[^:/?#]+:([^@/?#]*)@/u.exec(environment.DATABASE_URL)?.[1];
  if (rawPassword !== encodeURIComponent(appPassword)) throw new Error("DATABASE_URL_PASSWORD_NOT_CANONICAL");
  let databaseUrl;
  try { databaseUrl = new URL(environment.DATABASE_URL); } catch { throw new Error("DATABASE_URL_INVALID"); }
  if (databaseUrl.protocol !== "mysql:" || databaseUrl.username !== "shensi_app" || databaseUrl.hostname !== "mysql" || databaseUrl.port !== "3306" || databaseUrl.pathname !== "/shensi") throw new Error("DATABASE_URL_PRODUCTION_TARGET_INVALID");
  let databasePassword;
  try { databasePassword = decodeURIComponent(databaseUrl.password); } catch { throw new Error("DATABASE_URL_INVALID"); }
  if (databasePassword !== appPassword) throw new Error("DATABASE_URL_SECRET_MISMATCH");
}

export function publicOrigin(environment) {
  const candidate = environment.CORS_ORIGINS.split(",")[0].trim();
  let origin;
  try { origin = new URL(candidate); } catch { throw new Error("PUBLIC_ORIGIN_INVALID"); }
  if ((origin.protocol !== "https:" && origin.protocol !== "http:") || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("PUBLIC_ORIGIN_INVALID");
  return origin.origin;
}

export function assertDockerAvailable(binary = "docker", options = {}) {
  const { spawnProcess = spawnSync, environment = composeOperationalEnvironment() } = options;
  const result = spawnProcess(binary, ["compose", "version"], { stdio: "ignore", env: environment });
  if (result.error || result.status !== 0) throw new Error("DOCKER_UNAVAILABLE: Docker Engine with Docker Compose v2 is required");
}

export function composeOperationalEnvironment(source = process.env) {
  const environment = {};
  for (const name of ["PATH", "HOME", "SystemRoot", "WINDIR", "LANG", "LC_ALL", "DOCKER_CONFIG", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) if (source[name]) environment[name] = source[name];
  return environment;
}

function docker(root, argumentsList, environment) {
  const result = spawnSync("docker", argumentsList, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: environment });
  if (result.error || result.status !== 0) throw new Error(`DOCKER_COMMAND_FAILED:${argumentsList[1] ?? argumentsList[0]}`);
  return result.stdout;
}

function compose(root, argumentsList, environment) { return docker(root, ["compose", "-f", "deploy/compose.yaml", "--env-file", ".env.production.local", ...argumentsList], environment); }

function parseServiceStates(output) {
  const text = output.trim();
  if (!text) throw new Error("DEPLOYMENT_STATUS_UNAVAILABLE");
  let entries;
  try { entries = JSON.parse(text); } catch { entries = text.split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  return (Array.isArray(entries) ? entries : [entries]).map((entry) => ({ name: entry.Service ?? entry.Name, state: entry.State ?? entry.Status })).filter(({ name, state }) => typeof name === "string" && typeof state === "string");
}

async function pollHealth(origin, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const [gateway, backend] = await Promise.all([fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5_000) }), fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5_000) })]);
      if (gateway.ok && backend.ok) return;
    } catch { /* Report only a stable failure code after bounded retries. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error("DEPLOYMENT_HEALTHCHECK_TIMEOUT");
}

function gatewayOwnsPort(port, runCompose, inspectContainer, environment) {
  const containerId = runCompose(["ps", "-q", "gateway"], environment).trim();
  if (!containerId) return false;
  try { return (JSON.parse(inspectContainer(containerId, environment))["8080/tcp"] ?? []).some(({ HostPort }) => HostPort === String(port)); } catch { return false; }
}

export async function deployProduction(root, environment, options = {}) {
  const dockerEnvironment = options.dockerEnvironment ?? composeOperationalEnvironment();
  const { assertDocker = assertDockerAvailable, runCompose = (argumentsList, selectedEnvironment) => compose(root, argumentsList, selectedEnvironment), inspectContainer = (containerId, selectedEnvironment) => docker(root, ["inspect", "--format", "{{json .NetworkSettings.Ports}}", containerId], selectedEnvironment), assertPort = assertPortAvailable, poll = pollHealth, emit = (line) => console.log(line) } = options;
  const origin = publicOrigin(environment);
  const port = Number(environment.SHENSI_HTTP_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT_INVALID:gateway");
  assertDocker("docker", { environment: dockerEnvironment });
  runCompose(["config", "--quiet"], dockerEnvironment);
  if (!gatewayOwnsPort(port, runCompose, inspectContainer, dockerEnvironment)) await assertPort(port, "0.0.0.0");
  runCompose(["build"], dockerEnvironment);
  runCompose(["up", "-d"], dockerEnvironment);
  try { await poll(`http://127.0.0.1:${port}`); } catch {
    try { runCompose(["down", "--remove-orphans"], dockerEnvironment); throw new Error("DEPLOYMENT_HEALTHCHECK_FAILED:CLEANUP_OK"); }
    catch (error) {
      if (error.message === "DEPLOYMENT_HEALTHCHECK_FAILED:CLEANUP_OK") throw error;
      throw new Error("DEPLOYMENT_HEALTHCHECK_FAILED:CLEANUP_FAILED");
    }
  }
  for (const { name, state } of parseServiceStates(runCompose(["ps", "--format", "json"], dockerEnvironment))) emit(`SERVICE:${name} STATE:${state}`);
  emit(`PUBLIC_ORIGIN:${origin}`);
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const environmentFile = resolve(root, ".env.production.local");
  if (!existsSync(environmentFile)) throw new Error("PRODUCTION_ENVIRONMENT_FILE_MISSING");
  assertOwnerOnlyMode(environmentFile);
  const environment = loadProductionEnvironment(environmentFile);
  validateProductionVariables(environment);
  validateProductionSecrets(environment, resolve(root, "deploy/secrets"));
  await deployProduction(root, environment);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
