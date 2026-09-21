import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import mysql from "mysql2/promise";
import { createMysqlConnectionOptions } from "../src/mysql-connection-options.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const root = resolve(
  process.env.SHENSI_CLOUD_TEST_RUNTIME_ROOT
    || resolve(repositoryRoot, ".runtime/cloud-test")
);
const databaseUrl = (await readFile(resolve(root, "secrets/database_url"), "utf8")).trim();
const ca = (await readFile(resolve(root, "secrets/mysql_ca.pem"), "utf8")).trim();
const initialize = process.argv.includes("--initialize");

if (initialize) {
  process.env.NODE_ENV = "test";
  process.env.CRM_STORE = "mysql";
  process.env.CRM_SEED_DEVELOPMENT_DATA = "false";
  process.env.DATABASE_URL = databaseUrl;
  process.env.MYSQL_SSL_MODE = "verify_ca";
  process.env.MYSQL_SSL_CA = ca;
  const { createMysqlStore } = await import("../src/mysql-store.ts");
  const store = await createMysqlStore({ processRole: "api" });
  await store.close?.();
}

const pool = mysql.createPool(createMysqlConnectionOptions(databaseUrl, {
  MYSQL_SSL_MODE: "verify_ca",
  MYSQL_SSL_CA: ca
}, {
  connectionLimit: 1,
  namedPlaceholders: true
}));

try {
  const [[version]] = await pool.query(
    "SELECT VERSION() AS version, DATABASE() AS database_name"
  );
  const [[cipher]] = await pool.query("SHOW STATUS LIKE 'Ssl_cipher'");
  const [[tables]] = await pool.query(
    "SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema = DATABASE()"
  );
  if (!cipher?.Value) throw new Error("CLOUD_TEST_MYSQL_TLS_NOT_ACTIVE");
  console.log(JSON.stringify({
    connected: true,
    version: String(version.version),
    database: String(version.database_name),
    sslCipherPresent: true,
    initialized: initialize,
    tableCount: Number(tables.table_count)
  }));
} finally {
  await pool.end();
}
