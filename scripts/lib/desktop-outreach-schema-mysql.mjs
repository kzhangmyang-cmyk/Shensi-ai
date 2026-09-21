import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  DESKTOP_OUTREACH_SCHEMA_LOCK_NAME,
  DESKTOP_OUTREACH_SCHEMA_MANIFEST_SHA256,
  DESKTOP_OUTREACH_SCHEMA_OWNER_TABLE,
  DESKTOP_OUTREACH_SCHEMA_STEPS,
  DESKTOP_OUTREACH_SCHEMA_VERSION,
  validateUpgradeInput
} from "../desktop-outreach-schema-upgrade.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const error = () => new Error("DESKTOP_OUTREACH_SCHEMA_MYSQL_FAILED");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const LEDGER_COLUMNS = `schema_version AS schemaVersion,
  manifest_sha256 AS manifestSha256, step_ordinal AS stepOrdinal,
  step_id AS stepId, step_sha256 AS stepSha256, state,
  migration_attempt_id AS migrationAttemptId,
  target_server_uuid_sha256 AS targetServerUuidSha256,
  completed_at AS completedAt`;

async function connectMysql(options) {
  const require = createRequire(new URL("../../backend/package.json", import.meta.url));
  return require("mysql2/promise").createConnection(options);
}

/**
 * Target-only MySQL transport for the schema runner. The supervisor supplies the
 * credential and live ownership verifier. Metadata/preservation predicates are
 * mandatory: this adapter cannot equate table existence with schema validity.
 * There is deliberately no CLI or ambient DATABASE_URL fallback.
 */
export function createDesktopOutreachMysqlAdapter({
  readTargetPassword, verifyOwner, inspectOwnerTable, inspectStep,
  connect = connectMysql
}) {
  if (![readTargetPassword, verifyOwner, inspectOwnerTable, inspectStep, connect]
    .every((value) => typeof value === "function")) throw error();

  return {
    async openSession(input) {
      const { target, ownerWitness } = structuredClone(input);
      validateUpgradeInput({ attemptId: ownerWitness?.attemptId,
        project: ownerWitness?.project, target, ownerWitness });
      const authority = structuredClone({ target, ownerWitness });
      let connection;
      let closed = false;
      let locked = false;
      let serverUuidHash;
      let connectionId;
      const owned = async () => {
        if (closed || await verifyOwner(structuredClone(authority)) !== true) {
          throw error();
        }
      };
      const query = async (sql, values = []) => {
        if (closed || !connection) throw error();
        const [rows] = await connection.query({ sql, timeout: 10_000 }, values);
        return rows;
      };
      const identity = async () => {
        const rows = await query(`SELECT DATABASE() AS databaseName,
          @@port AS serverPort, CURRENT_USER() AS authenticatedUser,
          @@server_uuid AS serverUuid, CONNECTION_ID() AS connectionId`);
        const row = rows?.[0];
        if (rows?.length !== 1 || row.databaseName !== target.database
          || Number(row.serverPort) !== 3306
          || typeof row.authenticatedUser !== "string"
          || row.authenticatedUser.split("@", 1)[0] !== target.username
          || typeof row.serverUuid !== "string" || !row.serverUuid
          || row.serverUuid.length > 128
          || !Number.isSafeInteger(Number(row.connectionId))
          || Number(row.connectionId) < 1) throw error();
        const actualHash = hash(row.serverUuid);
        if ((serverUuidHash && serverUuidHash !== actualHash)
          || (connectionId && connectionId !== Number(row.connectionId))) throw error();
        serverUuidHash = actualHash;
        connectionId = Number(row.connectionId);
        return { database: row.databaseName, host: target.host, port: target.port,
          serverPort: Number(row.serverPort), authenticatedUser: row.authenticatedUser,
          serverUuid: row.serverUuid };
      };
      const assertAuthority = async () => {
        await owned();
        const current = await identity();
        if (!locked) throw error();
        const rows = await query("SELECT IS_USED_LOCK(?) AS owner", [DESKTOP_OUTREACH_SCHEMA_LOCK_NAME]);
        if (rows?.length !== 1 || Number(rows[0].owner) !== connectionId) throw error();
        return current;
      };
      const read = Object.freeze({
        async query(sql, values = []) {
          // Predicates only inspect metadata/data. DDL/DML belongs to applyStep.
          if (typeof sql !== "string" || !/^\s*SELECT\b/iu.test(sql)) throw error();
          return query(sql, values);
        }
      });
      const canonicalStep = (step) => {
        const canonical = DESKTOP_OUTREACH_SCHEMA_STEPS.find((item) => item.ordinal === step?.ordinal);
        if (!canonical || JSON.stringify(canonical) !== JSON.stringify(step)) throw error();
        return canonical;
      };
      try {
        await owned();
        const password = await readTargetPassword(structuredClone(authority));
        if (typeof password !== "string" || !password || password.length > 256) throw error();
        await owned();
        connection = await connect({ host: target.host, port: target.port,
          user: target.username, password, database: target.database,
          multipleStatements: false, connectTimeout: 10_000, timezone: "Z",
          dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
        await identity();
      } catch {
        if (connection) {
          try { await connection.end(); } catch { connection.destroy?.(); }
        }
        throw error();
      }
      return {
        readIdentity: identity,
        async acquireNamedLock(name) {
          if (name !== DESKTOP_OUTREACH_SCHEMA_LOCK_NAME || locked) throw error();
          await owned();
          await identity();
          const rows = await query("SELECT GET_LOCK(?, 0) AS acquired", [name]);
          locked = rows?.length === 1 && Number(rows[0].acquired) === 1;
          return locked;
        },
        assertAuthority,
        async readLedger() {
          await assertAuthority();
          const ownerTableState = await inspectOwnerTable(read);
          if (ownerTableState === "absent" || ownerTableState === "partial") {
            return { ownerTableState, rows: [] };
          }
          if (ownerTableState !== "exact") throw error();
          const rows = await query(`SELECT ${LEDGER_COLUMNS}
            FROM ${DESKTOP_OUTREACH_SCHEMA_OWNER_TABLE}
            ORDER BY schema_version, step_ordinal`);
          return { ownerTableState, rows: rows.map((row) => ({ ...row,
            stepOrdinal: Number(row.stepOrdinal),
            completedAt: typeof row.completedAt === "string"
              ? row.completedAt.replace(" ", "T").replace(/(?:\.([0-9]{1,3}))?$/u,
                (_, digits) => `.${(digits ?? "").padEnd(3, "0")}Z`)
              : null })) };
        },
        async inspectStep(step, context) {
          await assertAuthority();
          return inspectStep(read, canonicalStep(step), context);
        },
        async applyStep(step) {
          const canonical = canonicalStep(step);
          await assertAuthority();
          if (canonical.statementKind === "verify") return;
          if (!["ddl", "dml"].includes(canonical.statementKind)) throw error();
          await query(canonical.statementUtf8Lf);
        },
        async recordStep(row) {
          const step = DESKTOP_OUTREACH_SCHEMA_STEPS.find((item) => item.ordinal === row?.stepOrdinal);
          if (!step || row.schemaVersion !== DESKTOP_OUTREACH_SCHEMA_VERSION
            || row.manifestSha256 !== DESKTOP_OUTREACH_SCHEMA_MANIFEST_SHA256
            || row.stepId !== step.id || row.stepSha256 !== step.stepSha256
            || row.state !== (step.ordinal === 190 ? "sealed" : "completed")
            || row.migrationAttemptId !== ownerWitness.attemptId
            || !HASH.test(row.targetServerUuidSha256)
            || row.targetServerUuidSha256 !== serverUuidHash
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.completedAt)
            || new Date(row.completedAt).toISOString() !== row.completedAt) throw error();
          await assertAuthority();
          const result = await query(`INSERT INTO ${DESKTOP_OUTREACH_SCHEMA_OWNER_TABLE}
            (schema_version, manifest_sha256, step_ordinal, step_id, step_sha256,
             state, migration_attempt_id, target_server_uuid_sha256, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [row.schemaVersion,
            row.manifestSha256, row.stepOrdinal, row.stepId, row.stepSha256,
            row.state, row.migrationAttemptId, row.targetServerUuidSha256,
            row.completedAt.replace("T", " ").slice(0, -1)]);
          if (result?.affectedRows !== 1) throw error();
        },
        async releaseNamedLock(name) {
          if (name !== DESKTOP_OUTREACH_SCHEMA_LOCK_NAME || closed || !locked) throw error();
          const rows = await query("SELECT RELEASE_LOCK(?) AS released", [name]);
          locked = false;
          if (rows?.length !== 1 || Number(rows[0].released) !== 1) throw error();
        },
        async close() {
          if (closed) return;
          closed = true;
          try { await connection.end(); } catch { connection.destroy?.(); throw error(); }
        }
      };
    }
  };
}
