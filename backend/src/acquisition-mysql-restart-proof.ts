import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";

const families = ["account", "policy", "job_cursor", "candidate_evidence", "batch_action"] as const;

function connectionOptions(url: URL, database?: string) {
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ...(database ? { database } : {}),
    timezone: "Z" as const,
    dateStrings: true,
    connectionLimit: 4
  };
}
export async function runAcquisitionMysqlRestartProof(adminUrlValue: string) {
  const adminUrl = new URL(adminUrlValue);
  if (adminUrl.protocol !== "mysql:") throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:acquisition-restart-proof:mysql-protocol");
  const databaseName = `shensi_task10_proof_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let pool: mysql.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    pool = mysql.createPool(connectionOptions(adminUrl, databaseName));
    await pool.query(`CREATE TABLE task10_durable_identity (
      family VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      identity_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      revision BIGINT UNSIGNED NOT NULL,
      payload_json JSON NOT NULL,
      PRIMARY KEY (family, identity_key)
    ) ENGINE=InnoDB`);
    for (const [index, family] of families.entries()) {
      await pool.execute(
        "INSERT INTO task10_durable_identity (family,identity_key,revision,payload_json) VALUES (?,?,?,?)",
        [family, `stable-${family}`, index + 1, JSON.stringify({ family, durable: true })]
      );
    }

    const connectionA = await pool.getConnection();
    const connectionB = await pool.getConnection();
    assert.notEqual(connectionA.threadId, connectionB.threadId, "restart proof requires two physical MySQL connections");
    const race = await Promise.allSettled([
      connectionA.execute("INSERT INTO task10_durable_identity (family,identity_key,revision,payload_json) VALUES ('job_cursor','race',1,'{}')"),
      connectionB.execute("INSERT INTO task10_durable_identity (family,identity_key,revision,payload_json) VALUES ('job_cursor','race',1,'{}')")
    ]);
    connectionB.release();
    connectionA.release();
    const raceHadSingleWinner = race.filter((result) => result.status === "fulfilled").length === 1;

    await pool.end();
    pool = undefined;
    const restarted = mysql.createPool(connectionOptions(adminUrl, databaseName));
    const [recovered] = await restarted.query<mysql.RowDataPacket[]>(
      "SELECT family,identity_key,revision FROM task10_durable_identity WHERE identity_key LIKE 'stable-%' ORDER BY FIELD(family,'account','policy','job_cursor','candidate_evidence','batch_action')"
    );
    const restartRecovered = recovered.length === families.length
      && recovered.every((row, index) => row.family === families[index] && Number(row.revision) === index + 1);

    const transaction = await restarted.getConnection();
    await transaction.beginTransaction();
    try {
      await transaction.execute("UPDATE task10_durable_identity SET revision=99 WHERE family='batch_action' AND identity_key='stable-batch_action'");
      await transaction.execute("INSERT INTO task10_durable_identity (family,identity_key,revision,payload_json) VALUES ('account','stable-account',99,'{}')");
      await transaction.commit();
    } catch {
      await transaction.rollback();
    } finally { transaction.release(); }
    const [rollbackRows] = await restarted.query<mysql.RowDataPacket[]>(
      "SELECT revision FROM task10_durable_identity WHERE family='batch_action' AND identity_key='stable-batch_action'"
    );
    const rollbackWasAtomic = Number(rollbackRows[0]?.revision) === 5;
    await restarted.end();

    return Object.freeze({ families: [...families], restartRecovered, raceHadSingleWinner, rollbackWasAtomic });
  } finally {
    await pool?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}
