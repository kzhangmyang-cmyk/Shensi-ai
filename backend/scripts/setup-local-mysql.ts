import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";

const MYSQL_HOST = "127.0.0.1";
const MYSQL_PORT = 3307;
const MYSQL_DATABASE = "shensi_sales";
const MYSQL_USER = "shensi_sales_app";

function readRequired(name: "MYSQL_LOCAL_ADMIN_URL" | "SHENSI_MYSQL_APP_PASSWORD"): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

function readAdminUrl(): string {
  const value = readRequired("MYSQL_LOCAL_ADMIN_URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("MYSQL_LOCAL_ADMIN_URL_INVALID");
  }
  if (
    parsed.protocol !== "mysql:"
    || parsed.hostname !== MYSQL_HOST
    || parsed.port !== String(MYSQL_PORT)
    || parsed.username.length === 0
  ) {
    throw new Error("MYSQL_LOCAL_ADMIN_URL_INVALID");
  }
  return value;
}

async function main(): Promise<void> {
  const adminUrl = readAdminUrl();
  const appPassword = readRequired("SHENSI_MYSQL_APP_PASSWORD");
  let adminPool: Pool | undefined;
  let appPool: Pool | undefined;
  try {
    adminPool = mysql.createPool(adminUrl);
    await adminPool.query(
      "CREATE DATABASE IF NOT EXISTS `shensi_sales` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
    );
    await adminPool.execute(
      "CREATE USER IF NOT EXISTS 'shensi_sales_app'@'127.0.0.1' IDENTIFIED BY ?",
      [appPassword]
    );
    await adminPool.execute(
      "ALTER USER 'shensi_sales_app'@'127.0.0.1' IDENTIFIED BY ?",
      [appPassword]
    );
    await adminPool.query(
      "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'shensi_sales_app'@'127.0.0.1'"
    );
    await adminPool.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON `shensi_sales`.* TO 'shensi_sales_app'@'127.0.0.1'"
    );

    appPool = mysql.createPool({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: appPassword,
      database: MYSQL_DATABASE,
      connectionLimit: 1
    });
    const [rows] = await appPool.query<RowDataPacket[]>(
      "SELECT CURRENT_USER() AS currentUser, DATABASE() AS databaseName"
    );
    if (
      rows.length !== 1
      || rows[0]?.currentUser !== `${MYSQL_USER}@${MYSQL_HOST}`
      || rows[0]?.databaseName !== MYSQL_DATABASE
    ) {
      throw new Error("LOCAL_MYSQL_APP_VERIFICATION_FAILED");
    }
    console.log(
      `Local MySQL ready: ${MYSQL_USER}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DATABASE}`
    );
  } finally {
    try {
      await appPool?.end();
    } finally {
      await adminPool?.end();
    }
  }
}

await main();
