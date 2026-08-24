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
