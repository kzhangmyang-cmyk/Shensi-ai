import { spawn as nativeSpawn } from "node:child_process";
import {
  createHash, createHmac, pbkdf2Sync, timingSafeEqual
} from "node:crypto";
import { constants as FS } from "node:fs";
import {
  chmod, lstat, mkdir, open, readdir, realpath
} from "node:fs/promises";
import {
  basename, isAbsolute, join, resolve
} from "node:path";
import { safeChildEnvironment } from "./lib/database-url.mjs";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_SECRET_BYTES = 256;
const MAX_JSON_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MIGRATION_TIMEOUT_MS = 30 * 60 * 1000;
const PROJECT = /^shensi-api-migration-([a-f0-9]{12})$/u;
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SECRET = /^[A-Za-z0-9_-]{64}$/u;
const BACKUP_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,220}\.sql\.enc$/u;
const REPORT_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,220}-shensi-verification\.json$/u;
const SOURCE = Object.freeze({ database: "shensi_trial", host: "127.0.0.1", port: 3310 });
const TARGET = Object.freeze({ database: "shensi", host: "127.0.0.1", port: 3311 });
const SECRET_FILES = Object.freeze({
  reader: "migration_reader_password",
  app: "mysql_app_password",
  root: "mysql_root_password",
  passphrase: "migration_backup_passphrase"
});
const VERIFICATION_CHECKS = Object.freeze([
  "REQUIRED_TABLE_MISSING",
  "TABLE_SET_MISMATCH",
  "TABLE_COUNT_MISMATCH",
  "SCHEMA_METADATA_MISMATCH",
  "MIGRATION_METADATA_MISMATCH",
  "STABLE_ID_MISMATCH",
  "ACQUISITION_RUN_MISMATCH",
  "FINANCIAL_COUNCIL_RUN_MISMATCH",
  "MODEL_CONNECTION_MISMATCH",
  "INTEGRITY_HASH_MISMATCH",
  "ENCRYPTED_ROW_IDENTITY_MISSING",
  "ENCRYPTED_ROW_IDENTITY_MISMATCH"
]);

const codedError = (code) => new Error(code);
const modeOf = (stat) => Number(stat?.mode) & 0o777;
const identityOf = (stat) => `${String(stat?.dev)}:${String(stat?.ino)}`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function sameEndpoint(actual, expected) {
  return actual && typeof actual === "object" && !Array.isArray(actual)
    && actual.database === expected.database
    && actual.host === expected.host
    && actual.port === expected.port;
}

function validateProject(project, attemptId) {
  const match = typeof project === "string" ? PROJECT.exec(project) : null;
  return match && (attemptId === undefined || match[1] === attemptId);
}

function validateMigrationInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !/^[a-f0-9]{12}$/u.test(input.attemptId ?? "")
    || !validateProject(input.project, input.attemptId)
    || !sameEndpoint(input.source, SOURCE)
    || !sameEndpoint(input.target, TARGET)
    || !COMMIT.test(input.sourceCommit ?? "")) {
    throw codedError("TASK5_MIGRATION_CONTEXT_INVALID");
  }
}

function validateStartInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !validateProject(input.project)
    || !sameEndpoint(input.target, TARGET)) {
    throw codedError("TASK5_TARGET_CONTEXT_INVALID");
  }
}

function validateDirectoryStat(stat, uid) {
  return stat?.isDirectory?.()
    && !stat.isSymbolicLink?.()
    && Number(stat.uid) === uid
    && modeOf(stat) === PRIVATE_DIRECTORY_MODE;
}

async function validateRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)
    || resolve(repositoryRoot) !== repositoryRoot) {
    throw codedError("TASK5_REPOSITORY_ROOT_INVALID");
  }
  let stat;
  let canonical;
  try {
    [stat, canonical] = await Promise.all([lstat(repositoryRoot), realpath(repositoryRoot)]);
  } catch {
    throw codedError("TASK5_REPOSITORY_ROOT_INVALID");
  }
  const uid = process.getuid?.() ?? Number(stat.uid);
  if (!stat.isDirectory() || stat.isSymbolicLink() || Number(stat.uid) !== uid
    || canonical !== repositoryRoot) {
    throw codedError("TASK5_REPOSITORY_ROOT_INVALID");
  }
  const migrationScript = join(repositoryRoot, "scripts", "migrate-data.mjs");
  let scriptStat;
  try { scriptStat = await lstat(migrationScript, { bigint: true }); }
  catch { throw codedError("TASK5_MIGRATION_SCRIPT_INVALID"); }
  if (!scriptStat.isFile() || scriptStat.isSymbolicLink() || Number(scriptStat.uid) !== uid
    || Number(scriptStat.nlink) !== 1) throw codedError("TASK5_MIGRATION_SCRIPT_INVALID");
  return Object.freeze({ uid, migrationScript });
}

async function ensurePrivateDirectory(path, uid, create = false) {
  let stat;
  try { stat = await lstat(path); }
  catch (caught) {
    if (!create || caught?.code !== "ENOENT") throw codedError("TASK5_PRIVATE_DIRECTORY_INVALID");
    try {
      await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
      await chmod(path, PRIVATE_DIRECTORY_MODE);
      stat = await lstat(path);
    } catch { throw codedError("TASK5_PRIVATE_DIRECTORY_INVALID"); }
  }
  if (!stat?.isDirectory?.() || stat.isSymbolicLink?.() || Number(stat.uid) !== uid) {
    throw codedError("TASK5_PRIVATE_DIRECTORY_INVALID");
  }
  if (modeOf(stat) !== PRIVATE_DIRECTORY_MODE) {
    throw codedError("TASK5_PRIVATE_DIRECTORY_MODE_INVALID");
  }
  let canonical;
  try { canonical = await realpath(path); }
  catch { throw codedError("TASK5_PRIVATE_DIRECTORY_INVALID"); }
  if (canonical !== path) throw codedError("TASK5_PRIVATE_DIRECTORY_INVALID");
  return path;
}

async function privatePaths(repositoryRoot, uid) {
  const runtime = await ensurePrivateDirectory(join(repositoryRoot, ".runtime"), uid);
  const apiOnly = await ensurePrivateDirectory(join(runtime, "api-only"), uid);
  const secrets = await ensurePrivateDirectory(join(apiOnly, "secrets"), uid);
  const evidence = await ensurePrivateDirectory(join(apiOnly, "evidence"), uid);
  const backupRoot = await ensurePrivateDirectory(join(evidence, "backups"), uid, true);
  return Object.freeze({ secrets, backupRoot });
}

function validPrivateFile(stat, uid, maximumBytes) {
  const size = Number(stat?.size);
  return stat?.isFile?.()
    && !stat.isSymbolicLink?.()
    && Number(stat.uid) === uid
    && Number(stat.nlink) === 1
    && Number.isSafeInteger(size)
    && size > 0
    && size <= maximumBytes;
}

async function openPrivateFile(path, uid, maximumBytes, invalidCode, modeCode) {
  let handle;
  try { handle = await open(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0), 0); }
  catch { throw codedError(invalidCode); }
  try {
    const before = await handle.stat({ bigint: true });
    if (!validPrivateFile(before, uid, maximumBytes)) throw codedError(invalidCode);
    if (modeOf(before) !== PRIVATE_FILE_MODE) throw codedError(modeCode);
    return { handle, before };
  } catch (caught) {
    try { await handle.close(); } catch {}
    throw caught;
  }
}

async function confirmPrivateFile(path, handle, before, uid, maximumBytes, invalidCode, modeCode) {
  let after;
  let pathname;
  try {
    [after, pathname] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true })
    ]);
  } catch { throw codedError(invalidCode); }
  if (!validPrivateFile(after, uid, maximumBytes)
    || !validPrivateFile(pathname, uid, maximumBytes)
    || identityOf(after) !== identityOf(before)
    || identityOf(pathname) !== identityOf(before)
    || Number(after.size) !== Number(before.size)
    || Number(pathname.size) !== Number(before.size)) throw codedError(invalidCode);
  if (modeOf(after) !== PRIVATE_FILE_MODE || modeOf(pathname) !== PRIVATE_FILE_MODE) {
    throw codedError(modeCode);
  }
}

async function readSecret(path, uid) {
  const { handle, before } = await openPrivateFile(
    path, uid, MAX_SECRET_BYTES, "TASK5_SECRET_FILE_INVALID", "TASK5_SECRET_FILE_MODE_INVALID"
  );
  try {
    const bytes = await handle.readFile();
    await confirmPrivateFile(
      path, handle, before, uid, MAX_SECRET_BYTES,
      "TASK5_SECRET_FILE_INVALID", "TASK5_SECRET_FILE_MODE_INVALID"
    );
    const value = bytes.toString("utf8");
    bytes.fill(0);
    if (!SECRET.test(value)) throw codedError("TASK5_SECRET_VALUE_INVALID");
    return value;
  } finally {
    try { await handle.close(); } catch {}
  }
}

async function hashHandle(handle) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

async function inspectArtifact(path, uid, { json = false } = {}) {
  const maximum = json ? MAX_JSON_ARTIFACT_BYTES : Number.MAX_SAFE_INTEGER;
  const { handle, before } = await openPrivateFile(
    path, uid, maximum,
    "TASK5_MIGRATION_ARTIFACT_INVALID", "TASK5_MIGRATION_ARTIFACT_MODE_INVALID"
  );
  try {
    const digest = await hashHandle(handle);
    const bytes = json ? await handle.readFile() : null;
    await confirmPrivateFile(
      path, handle, before, uid, maximum,
      "TASK5_MIGRATION_ARTIFACT_INVALID", "TASK5_MIGRATION_ARTIFACT_MODE_INVALID"
    );
    return Object.freeze({ digest, bytes });
  } finally {
    try { await handle.close(); } catch {}
  }
}

function parseJson(bytes, code) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw codedError(code); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw codedError(code);
  return value;
}

function canonicalBase64(value) {
  try {
    return typeof value === "string"
      && /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
      && Buffer.from(value, "base64").byteLength === 16
      && Buffer.from(value, "base64").toString("base64") === value;
  } catch { return false; }
}

function verifyManifest(manifest, backupName, backupDigest, passphrase, sourceCommit) {
  const authentication = manifest.authentication;
  if (manifest.format !== "shensi-encrypted-backup-manifest.v2"
    || manifest.encryptedFile !== backupName
    || manifest.sha256 !== backupDigest
    || manifest.sourceDatabase !== "shensi_trial"
    || manifest.sourceCommit !== sourceCommit
    || !manifest.observedTableCounts
    || typeof manifest.observedTableCounts !== "object"
    || Array.isArray(manifest.observedTableCounts)
    || !authentication || typeof authentication !== "object" || Array.isArray(authentication)
    || authentication.algorithm !== "hmac-sha256"
    || authentication.kdf !== "pbkdf2-sha256"
    || authentication.iterations !== 210_000
    || !canonicalBase64(authentication.salt)
    || !HASH.test(authentication.tag ?? "")) {
    throw codedError("TASK5_MIGRATION_MANIFEST_INVALID");
  }
  const counts = Object.entries(manifest.observedTableCounts);
  if (counts.length > 10_000 || counts.some(([name, count]) =>
    !/^[A-Za-z0-9_]{1,64}$/u.test(name)
    || !Number.isSafeInteger(count) || count < 0)) {
    throw codedError("TASK5_MIGRATION_MANIFEST_INVALID");
  }
  const { tag, ...unsignedAuthentication } = authentication;
  const unsigned = { ...manifest, authentication: unsignedAuthentication };
  const key = pbkdf2Sync(
    passphrase, Buffer.from(authentication.salt, "base64"), authentication.iterations, 32, "sha256"
  );
  const expected = createHmac("sha256", key)
    .update(Buffer.from(`shensi-backup-manifest-v2\n${JSON.stringify(unsigned)}`, "utf8"))
    .digest();
  key.fill(0);
  const actual = Buffer.from(tag, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw codedError("TASK5_MIGRATION_MANIFEST_INVALID");
  }
}

function validUtcTimestamp(value) {
  try {
    return typeof value === "string"
      && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
      && new Date(value).toISOString() === value;
  } catch { return false; }
}

function tableCounts(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || !Array.isArray(snapshot.tables) || snapshot.tables.length > 10_000) return null;
  const entries = snapshot.tables.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || !/^[A-Za-z0-9_]{1,64}$/u.test(row.name ?? "")
      || !Number.isSafeInteger(row.count) || row.count < 0) return null;
    return [row.name, row.count];
  });
  if (entries.some((entry) => entry === null)
    || new Set(entries.map(([name]) => name)).size !== entries.length) return null;
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function verifyReport(report, manifest) {
  if (report.format !== "shensi-data-verification.v1"
    || report.classification !== "non-sensitive-identifiers-and-hashes"
    || !validUtcTimestamp(report.createdAt)
    || report.passed !== true
    || JSON.stringify(report.codes) !== JSON.stringify(["VERIFICATION_PASSED"])
    || !Array.isArray(report.checks)
    || JSON.stringify(report.checks.map((entry) => entry?.code)) !== JSON.stringify(VERIFICATION_CHECKS)
    || report.checks.some((entry) => entry?.passed !== true)
    || JSON.stringify(report.source) !== JSON.stringify(report.target)) {
    throw codedError("TASK5_MIGRATION_VERIFICATION_INVALID");
  }
  const observed = Object.fromEntries(Object.entries(manifest.observedTableCounts)
    .sort(([left], [right]) => left.localeCompare(right)));
  const reportCounts = tableCounts(report.source);
  if (reportCounts === null || JSON.stringify(reportCounts) !== JSON.stringify(observed)) {
    throw codedError("TASK5_MIGRATION_VERIFICATION_BINDING_INVALID");
  }
}

function parseChildOutput(result) {
  if (!result || typeof result !== "object" || result.code !== 0 || result.signal != null
    || result.truncated !== false || result.stderr !== ""
    || typeof result.stdout !== "string"
    || Buffer.byteLength(result.stdout, "utf8") > MAX_CHILD_OUTPUT_BYTES
    || !/^[^\r\n]+\n$/u.test(result.stdout)) {
    if (result?.code !== 0 || result?.signal != null || result?.truncated === true) {
      throw codedError("TASK5_MIGRATION_PROCESS_FAILED");
    }
    throw codedError("TASK5_MIGRATION_OUTPUT_INVALID");
  }
  let value;
  try { value = JSON.parse(result.stdout.slice(0, -1)); }
  catch { throw codedError("TASK5_MIGRATION_OUTPUT_INVALID"); }
  const keys = ["code", "targetDatabase", "backupFile", "manifestFile", "reportFile"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)
    || value.code !== "SHENSI_DATA_MIGRATION_OK"
    || value.targetDatabase !== "shensi"
    || !BACKUP_FILE.test(value.backupFile ?? "")
    || basename(value.backupFile) !== value.backupFile
    || value.manifestFile !== `${value.backupFile}.migration-manifest.json`
    || basename(value.manifestFile) !== value.manifestFile
    || !REPORT_FILE.test(value.reportFile ?? "")
    || basename(value.reportFile) !== value.reportFile) {
    throw codedError("TASK5_MIGRATION_OUTPUT_INVALID");
  }
  return Object.freeze(value);
}

async function defaultSpawnProcess(command, args, options) {
  const { timeoutMs, maximumOutputBytes, ...spawnOptions } = options;
  return new Promise((resolveChild, rejectChild) => {
    let child;
    try {
      child = nativeSpawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    } catch { rejectChild(codedError("TASK5_MIGRATION_PROCESS_FAILED")); return; }
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const append = (kind, chunk) => {
      const next = (kind === "stdout" ? stdout : stderr) + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maximumOutputBytes) {
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      if (kind === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    timer.unref();
    child.once("error", () => {
      clearTimeout(timer);
      rejectChild(codedError("TASK5_MIGRATION_PROCESS_FAILED"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveChild({ code, signal, stdout, stderr, truncated: truncated || timedOut });
    });
  });
}

function migrationEnvironment(baseEnv, secrets, backupRoot) {
  return Object.freeze({
    ...safeChildEnvironment(baseEnv),
    SOURCE_DATABASE_URL: `mysql://shensi_migration_reader:${encodeURIComponent(secrets.reader)}@127.0.0.1:3310/shensi_trial`,
    TARGET_DATABASE_URL: `mysql://shensi_app:${encodeURIComponent(secrets.app)}@127.0.0.1:3311/shensi`,
    MYSQL_LOCAL_ADMIN_URL: `mysql://root:${encodeURIComponent(secrets.root)}@127.0.0.1:3311/mysql`,
    SHENSI_BACKUP_PASSPHRASE: secrets.passphrase,
    BACKUP_DIRECTORY: backupRoot
  });
}

export function createTask5MigrationRunner({
  repositoryRoot,
  startTargetDatabase: startTargetDatabaseEffect,
  stopTargetProject: stopTargetProjectEffect,
  spawnProcess = defaultSpawnProcess,
  baseEnv = process.env,
  migrationTimeoutMs = DEFAULT_MIGRATION_TIMEOUT_MS
} = {}) {
  if (typeof startTargetDatabaseEffect !== "function"
    || typeof stopTargetProjectEffect !== "function"
    || typeof spawnProcess !== "function"
    || !baseEnv || typeof baseEnv !== "object" || Array.isArray(baseEnv)
    || !Number.isSafeInteger(migrationTimeoutMs)
    || migrationTimeoutMs < 1_000 || migrationTimeoutMs > 6 * 60 * 60 * 1000) {
    throw codedError("TASK5_MIGRATION_RUNNER_OPTIONS_INVALID");
  }

  const startTargetDatabase = async (input) => {
    validateStartInput(input);
    return startTargetDatabaseEffect(Object.freeze({
      project: input.project,
      target: TARGET
    }));
  };

  const stopTargetProject = async (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || !validateProject(input.project)) throw codedError("TASK5_TARGET_PROJECT_INVALID");
    if (input.retainVolumes !== true) throw codedError("TASK5_TARGET_RETAIN_VOLUMES_REQUIRED");
    return stopTargetProjectEffect(Object.freeze({ project: input.project, retainVolumes: true }));
  };

  const runMigrationProcess = async (input) => {
    validateMigrationInput(input);
    const repository = await validateRepositoryRoot(repositoryRoot);
    const paths = await privatePaths(repositoryRoot, repository.uid);
    const secretEntries = await Promise.all(Object.entries(SECRET_FILES).map(async ([key, name]) => [
      key, await readSecret(join(paths.secrets, name), repository.uid)
    ]));
    const secrets = Object.freeze(Object.fromEntries(secretEntries));
    const before = new Set(await readdir(paths.backupRoot));
    await startTargetDatabase({ project: input.project, target: input.target });
    const args = Object.freeze([
      repository.migrationScript,
      "--source-env", "SOURCE_DATABASE_URL",
      "--target-env", "TARGET_DATABASE_URL",
      "--target-database", "shensi"
    ]);
    let childResult;
    try {
      childResult = await spawnProcess(process.execPath, args, Object.freeze({
        cwd: repositoryRoot,
        env: migrationEnvironment(baseEnv, secrets, paths.backupRoot),
        shell: false,
        windowsHide: true,
        timeoutMs: migrationTimeoutMs,
        maximumOutputBytes: MAX_CHILD_OUTPUT_BYTES
      }));
    } catch { throw codedError("TASK5_MIGRATION_PROCESS_FAILED"); }
    const output = parseChildOutput(childResult);
    if ([output.backupFile, output.manifestFile, output.reportFile].some((name) => before.has(name))) {
      throw codedError("TASK5_MIGRATION_ARTIFACT_STALE");
    }
    const backup = await inspectArtifact(join(paths.backupRoot, output.backupFile), repository.uid);
    const manifestArtifact = await inspectArtifact(
      join(paths.backupRoot, output.manifestFile), repository.uid, { json: true }
    );
    const verificationArtifact = await inspectArtifact(
      join(paths.backupRoot, output.reportFile), repository.uid, { json: true }
    );
    const manifest = parseJson(manifestArtifact.bytes, "TASK5_MIGRATION_MANIFEST_INVALID");
    verifyManifest(
      manifest, output.backupFile, backup.digest, secrets.passphrase, input.sourceCommit
    );
    const report = parseJson(verificationArtifact.bytes, "TASK5_MIGRATION_VERIFICATION_INVALID");
    verifyReport(report, manifest);
    return Object.freeze({
      ok: true,
      manifest: Object.freeze({ basename: output.manifestFile, sha256: manifestArtifact.digest }),
      encryptedBackup: Object.freeze({ basename: output.backupFile, sha256: backup.digest }),
      verification: Object.freeze({ basename: output.reportFile, sha256: verificationArtifact.digest })
    });
  };

  return Object.freeze({ startTargetDatabase, runMigrationProcess, stopTargetProject });
}
