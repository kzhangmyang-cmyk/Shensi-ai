import { randomBytes, createHash } from "node:crypto";
import { access, chmod, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";

export const TRIAL_PORTS = Object.freeze({ mysql: 3310, gateway: 5608, frontend: 5610, backend: 5611, mediaCrawler: 5612 });
const secretNames = ["jwt_secret", "provider_credential_key", "agent_job_encryption_key", "acquisition_master_secret", "acquisition_v1_cursor_secret", "mediacrawler_service_secret", "mysql_app_password", "trade_observation_cursor_secret", "market_opportunity_cursor_secret", "prospect_run_idempotency_secret", "prospect_run_cursor_secret", "prospect_execution_claim_secret", "organization_identity_master_secret", "prospect_source_raw_envelope_secret", "prospect_coverage_master_secret"];

async function privateDirectory(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("TRIAL_PRIVATE_DIRECTORY_SYMLINK");
    if (!info.isDirectory()) throw new Error("TRIAL_PRIVATE_DIRECTORY_INVALID");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("TRIAL_PRIVATE_DIRECTORY_INVALID");
  }
  await chmod(path, 0o700);
}

async function privateFile(path, value) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("TRIAL_PRIVATE_FILE_SYMLINK");
    if (!info.isFile()) throw new Error("TRIAL_PRIVATE_FILE_INVALID");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeFile(path, value, { mode: 0o600, flag: "wx" });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("TRIAL_PRIVATE_FILE_INVALID");
  }
  await chmod(path, 0o600);
  return readFile(path, "utf8");
}

export function isTrialPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolvePort) => {
    const server = createServer();
    const close = () => server.close(() => resolvePort(true));
    server.once("error", () => resolvePort(false));
    server.listen(port, host, close);
  });
}
async function password(options) {
  if (options.appPassword) return options.appPassword;
  const file = options.appPasswordFile ?? process.env.SHENSI_TRIAL_APP_PASSWORD_FILE;
  if (file) { const info = await lstat(file); if (!info.isFile() || (info.mode & 0o077)) throw new Error("TRIAL_APP_PASSWORD_FILE_MUST_BE_OWNER_ONLY"); return (await readFile(file, "utf8")).trim(); }
  return process.env.SHENSI_TRIAL_APP_PASSWORD ?? "";
}
function outreachActionsEnabled(options) {
  const value = options.outreachActionsEnabled;
  return value === true
    || (typeof value === "string" && value.toLowerCase() === "true");
}
export async function prepareTrialRuntime(repositoryRoot, options = {}) {
  const suppliedRuntimeRoot = options.runtimeRoot ?? process.env.SHENSI_TRIAL_RUNTIME_ROOT;
  if (suppliedRuntimeRoot !== undefined && !isAbsolute(suppliedRuntimeRoot)) throw new Error("TRIAL_RUNTIME_ROOT_MUST_BE_ABSOLUTE");
  const runtimeRoot = resolve(suppliedRuntimeRoot ?? resolve(repositoryRoot, ".runtime/real-trial"));
  const isPortAvailable = options.isPortAvailable ?? isTrialPortAvailable;
  for (const port of Object.values(TRIAL_PORTS)) if (!await isPortAvailable(port)) throw new Error(`TRIAL_PORT_OCCUPIED:${port}`);
  const suppliedPassword = await password(options);
  if (suppliedPassword && /[\r\n]/u.test(suppliedPassword)) throw new Error("TRIAL_APP_PASSWORD_REQUIRED");
  const secretsDirectory = resolve(runtimeRoot, "secrets"), stateDirectory = resolve(runtimeRoot, "state"), logsDirectory = resolve(runtimeRoot, "logs"), pidsDirectory = resolve(runtimeRoot, "pids"), toolsDirectory = resolve(runtimeRoot, "tools"), mysqlDirectory = resolve(stateDirectory, "mysql"), profileDirectory = resolve(stateDirectory, "mediacrawler-profile"), outputDirectory = resolve(stateDirectory, "mediacrawler-output");
  for (const directory of [runtimeRoot, secretsDirectory, stateDirectory, logsDirectory, pidsDirectory, toolsDirectory, mysqlDirectory, profileDirectory, outputDirectory]) await privateDirectory(directory);
  const secrets = {};
  for (const name of secretNames) secrets[name] = await privateFile(resolve(secretsDirectory, name), randomBytes(48).toString("base64url"));
  const trialPasswordPath = resolve(secretsDirectory, "trial_app_password");
  const bootstrapPasswordPath = resolve(secretsDirectory, "bootstrap_admin_password");
  let trialPassword = "";
  try {
    const info = await lstat(trialPasswordPath);
    if (info.isSymbolicLink()) throw new Error("TRIAL_PRIVATE_FILE_SYMLINK");
    if (!info.isFile()) throw new Error("TRIAL_PRIVATE_FILE_INVALID");
    trialPassword = await readFile(trialPasswordPath, "utf8");
    if (suppliedPassword && trialPassword !== suppliedPassword) throw new Error("TRIAL_APP_PASSWORD_MISMATCH");
  } catch (error) {
    if (error instanceof Error && error.message === "TRIAL_APP_PASSWORD_MISMATCH") throw error;
    if (error?.code !== "ENOENT") throw error;
    if (!suppliedPassword) throw new Error("TRIAL_APP_PASSWORD_REQUIRED");
    trialPassword = await privateFile(trialPasswordPath, suppliedPassword);
  }
  const bootstrapPassword = await privateFile(bootstrapPasswordPath, randomBytes(32).toString("base64url"));
  const databaseUrl = `mysql://shensi_trial_app:${encodeURIComponent(secrets.mysql_app_password)}@127.0.0.1:3310/shensi_trial`;
  const environment = { DATABASE_URL: databaseUrl, CRM_STORE: "mysql", CRM_SEED_DEVELOPMENT_DATA: "false", SESSION_COOKIE_SECURE: "true", SHENSI_GATEWAY_PORT: "5608", SHENSI_FRONTEND_PORT: "5610", SHENSI_BACKEND_PORT: "5611", MEDIACRAWLER_PORT: "5612", MEDIACRAWLER_BASE_URL: "http://127.0.0.1:5612", MYSQL_PORT: "3310", VITE_REAL_TRIAL: "true", VITE_TRIAL_LOGIN_ALIAS: "test", VITE_TRIAL_LOGIN_EMAIL: "test@shensi.local", MEDIACRAWLER_BROWSER_HEADLESS: "false", MEDIACRAWLER_BROWSER_CHANNEL: "chrome", DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS: "120", DOUYIN_OUTREACH_ACTIONS_ENABLED: outreachActionsEnabled(options) ? "true" : "false", MEDIACRAWLER_ENCRYPTED_VOLUME: stateDirectory, MEDIACRAWLER_PROFILE_ROOT: profileDirectory, MEDIACRAWLER_CRAWL_OUTPUT_ROOT: outputDirectory, MEDIACRAWLER_SERVICE_SECRET_FILE: resolve(secretsDirectory, "mediacrawler_service_secret"), SHENSI_TRIAL_APP_PASSWORD_FILE: trialPasswordPath, SHENSI_TRIAL_MYSQL_APP_PASSWORD_FILE: resolve(secretsDirectory, "mysql_app_password"), SHENSI_MYSQL_APP_PASSWORD: secrets.mysql_app_password, JWT_SECRET: secrets.jwt_secret, PROVIDER_CREDENTIAL_KEY: secrets.provider_credential_key, AGENT_JOB_ENCRYPTION_KEY: secrets.agent_job_encryption_key, ACQUISITION_MASTER_SECRET: secrets.acquisition_master_secret, ACQUISITION_V1_CURSOR_SECRET: secrets.acquisition_v1_cursor_secret, TRADE_OBSERVATION_CURSOR_SECRET: secrets.trade_observation_cursor_secret, MARKET_OPPORTUNITY_CURSOR_SECRET: secrets.market_opportunity_cursor_secret, PROSPECT_RUN_IDEMPOTENCY_SECRET: secrets.prospect_run_idempotency_secret, PROSPECT_RUN_CURSOR_SECRET: secrets.prospect_run_cursor_secret, PROSPECT_EXECUTION_CLAIM_SECRET: secrets.prospect_execution_claim_secret, ORGANIZATION_IDENTITY_MASTER_SECRET: secrets.organization_identity_master_secret, PROSPECT_SOURCE_RAW_ENVELOPE_SECRET: secrets.prospect_source_raw_envelope_secret, PROSPECT_COVERAGE_MASTER_SECRET: secrets.prospect_coverage_master_secret };
  const environmentFile = resolve(runtimeRoot, "trial.env"); await writeFile(environmentFile, `${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 }); await chmod(environmentFile, 0o600);
  if (options.cloudflared?.path) { const actual = createHash("sha256").update(await readFile(options.cloudflared.path)).digest("hex"); if (actual !== options.cloudflared.sha256) throw new Error("TRIAL_CLOUDFLARED_SHA256_MISMATCH"); await copyFile(options.cloudflared.path, resolve(toolsDirectory, "cloudflared")); await chmod(resolve(toolsDirectory, "cloudflared"), 0o700); }
  options.emit?.(`TRIAL_RUNTIME_PREPARED:${runtimeRoot}`);
  return { root: runtimeRoot, secretsDirectory, stateDirectory, logsDirectory, pidsDirectory, toolsDirectory, mysqlDirectory, environmentFile, environment, trialPasswordPath, bootstrapPasswordPath, bootstrapPassword };
}
