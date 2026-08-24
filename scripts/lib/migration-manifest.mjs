import {
  createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual
} from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const MANIFEST_FORMAT = "shensi-encrypted-backup-manifest.v2";
const MAC_ITERATIONS = 210_000;

function isSecretField(key) {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return normalized.includes("password")
    || normalized.includes("passphrase")
    || normalized.includes("secret")
    || normalized.endsWith("url")
    || normalized === "key"
    || normalized === "credential"
    || normalized === "credentials"
    || normalized.endsWith("apikey")
    || normalized.endsWith("providerkey")
    || normalized.endsWith("encryptionkey")
    || (normalized.includes("key") && normalized.endsWith("encrypted"));
}

export function safeManifest(value) {
  if (Array.isArray(value)) return value.map(safeManifest);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isSecretField(key))
    .map(([key, entry]) => [key, safeManifest(entry)]));
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function authenticatedBytes(manifest) {
  return Buffer.from(`shensi-backup-manifest-v2\n${JSON.stringify(manifest)}`, "utf8");
}

function macKey(passphrase, authentication) {
  return pbkdf2Sync(
    passphrase,
    Buffer.from(authentication.salt, "base64"),
    authentication.iterations,
    32,
    "sha256"
  );
}

export function authenticatedManifest(fields, passphrase, { salt = randomBytes(16) } = {}) {
  const unsigned = safeManifest({
    ...fields,
    format: MANIFEST_FORMAT,
    authentication: {
      algorithm: "hmac-sha256",
      kdf: "pbkdf2-sha256",
      iterations: MAC_ITERATIONS,
      salt: Buffer.from(salt).toString("base64")
    }
  });
  const tag = createHmac("sha256", macKey(passphrase, unsigned.authentication))
    .update(authenticatedBytes(unsigned))
    .digest("hex");
  return { ...unsigned, authentication: { ...unsigned.authentication, tag } };
}

export async function verifyEncryptedBackup({ backupPath, manifestPath, passphrase }) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("BACKUP_MANIFEST_INVALID");
  }
  if (manifest.format !== MANIFEST_FORMAT
    || manifest.encryptedFile !== basename(backupPath)
    || manifest.authentication?.algorithm !== "hmac-sha256"
    || manifest.authentication?.kdf !== "pbkdf2-sha256"
    || manifest.authentication?.iterations !== MAC_ITERATIONS
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(manifest.authentication?.salt ?? "")
    || !/^[a-f0-9]{64}$/u.test(manifest.authentication?.tag ?? "")) {
    throw new Error("BACKUP_MANIFEST_INVALID");
  }
  const digest = await sha256File(backupPath);
  if (digest !== manifest.sha256) throw new Error("BACKUP_SHA256_MISMATCH");
  const { tag, ...authentication } = manifest.authentication;
  const unsigned = { ...manifest, authentication };
  const expected = createHmac("sha256", macKey(passphrase, authentication))
    .update(authenticatedBytes(unsigned))
    .digest();
  const actual = Buffer.from(tag, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("BACKUP_AUTHENTICATION_FAILED");
  }
  return manifest;
}

export async function collectBackupDatabaseSnapshot(parsed, { createConnection } = {}) {
  const connect = createConnection ?? (await importMysql2()).createConnection;
  const connection = await connect({
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database
  });
  try {
    const [[versionRow]] = await connection.query("SELECT VERSION() AS version");
    const [tables] = await connection.query(
      `SELECT TABLE_NAME AS table_name
         FROM information_schema.tables
        WHERE table_schema = ? AND table_type = 'BASE TABLE'
        ORDER BY TABLE_NAME`,
      [parsed.database]
    );
    const tableCounts = {};
    for (const row of tables) {
      const [[countRow]] = await connection.query(
        "SELECT COUNT(*) AS row_count FROM ??",
        [String(row.table_name)]
      );
      tableCounts[String(row.table_name)] = Number(countRow.row_count);
    }
    return { mysqlVersion: String(versionRow.version), tableCounts };
  } finally {
    await connection.end();
  }
}

async function importMysql2() {
  const { createRequire } = await import("node:module");
  const require = createRequire(new URL("../../backend/package.json", import.meta.url));
  return require("mysql2/promise");
}
