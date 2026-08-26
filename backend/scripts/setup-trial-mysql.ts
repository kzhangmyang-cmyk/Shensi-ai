import mysql from "mysql2/promise";
const host = "127.0.0.1", port = 3310, database = "shensi_trial", user = "shensi_trial_app";
const passwordFile = process.env.SHENSI_TRIAL_MYSQL_APP_PASSWORD_FILE;
if (!passwordFile) throw new Error("SHENSI_TRIAL_MYSQL_APP_PASSWORD_FILE_REQUIRED");
const password = (await import("node:fs/promises")).readFile(passwordFile, "utf8").then((value) => value.trim());
const adminUrl = process.env.SHENSI_TRIAL_MYSQL_ADMIN_URL;
if (!adminUrl) throw new Error("SHENSI_TRIAL_MYSQL_ADMIN_URL_REQUIRED");
const parsed = new URL(adminUrl);
if (parsed.protocol !== "mysql:" || parsed.hostname !== host || parsed.port !== String(port) || parsed.pathname !== "/mysql") throw new Error("SHENSI_TRIAL_MYSQL_ADMIN_URL_INVALID");
const pool = mysql.createPool(adminUrl); const appPassword = await password;
try { await pool.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`); await pool.execute(`CREATE USER IF NOT EXISTS '${user}'@'${host}' IDENTIFIED BY ?`, [appPassword]); await pool.execute(`ALTER USER '${user}'@'${host}' IDENTIFIED BY ?`, [appPassword]); await pool.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM '${user}'@'${host}'`); await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON \`${database}\`.* TO '${user}'@'${host}'`); const app = await mysql.createConnection({ host, port, user, password: appPassword, database }); try { const [rows] = await app.query<any[]>("SELECT CURRENT_USER() currentUser, DATABASE() databaseName"); if (rows[0]?.currentUser !== `${user}@${host}` || rows[0]?.databaseName !== database) throw new Error("TRIAL_MYSQL_APP_VERIFICATION_FAILED"); } finally { await app.end(); } } finally { await pool.end(); }
