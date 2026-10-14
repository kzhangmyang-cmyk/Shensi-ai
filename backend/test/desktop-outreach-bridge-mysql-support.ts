import mysql from "mysql2/promise";
import assert from "node:assert/strict";
import { resolve } from "node:path";
// @ts-expect-error The disposable operator owns the shared test-only diagnostic projection.
import { mysqlTestPhaseFailure } from "../../scripts/lib/desktop-action-test-diagnostics.mjs";
import { createBridgeBackend } from "./desktop-outreach-bridge-memory-support.js";
import { assertDesktopStorageMysqlTestAuthority, createDesktopStorageMysqlTestDatabaseName }
  from "./acquisition-desktop-installation-mysql-test-support.js";
import { ensureAcquisitionDesktopInstallationMysqlSchema, MysqlDesktopInstallationRepository }
  from "../src/acquisition-desktop-installation-mysql-repository.js";
import { ensureAcquisitionSocialAccountsMysqlSchema, MysqlAcquisitionSocialAccountRepository }
  from "../src/acquisition-social-account-mysql-repository.js";
import { ensureAcquisitionOutreachBatchMysqlSchema, MysqlAcquisitionOutreachBatchRepository }
  from "../src/acquisition-outreach-batch-mysql-repository.js";
import type { AcquisitionOutreachBatchRepository, AcquisitionDesktopOutreachRepository }
  from "../src/acquisition-outreach-batch-repository.js";

export function bridgeMysqlRequested(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.DESKTOP_ACTION_BRIDGE_MYSQL === undefined) return false;
  if (environment.DESKTOP_ACTION_BRIDGE_MYSQL !== "1") throw new Error("DESKTOP_ACTION_BRIDGE_MYSQL_MODE_INVALID");
  return true;
}

export async function createBridgeMysqlBackend(now: () => string, environment: NodeJS.ProcessEnv = process.env) {
  if (!bridgeMysqlRequested(environment)) throw new Error("DESKTOP_ACTION_BRIDGE_MYSQL_MODE_REQUIRED");
  const authority = await assertDesktopStorageMysqlTestAuthority({ environment,
    repositoryRoot: resolve(import.meta.dirname, "../..") });
  const database = createDesktopStorageMysqlTestDatabaseName();
  let admin: mysql.Connection | undefined;
  let pool: mysql.Pool | undefined;
  let backend: Awaited<ReturnType<typeof createBridgeBackend>> | undefined;
  let created = false;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      try { await backend?.close(); } finally { await pool?.end(); }
      if (created) {
        if (!/^goodjob_desktop_installation_[a-f0-9]{32}$/u.test(database)) {
          throw new Error("DESKTOP_ACTION_STORAGE_TEST_DATABASE_INVALID");
        }
        // Revalidate the live owner before destructive cleanup; never clean a DB
        // that this fixture did not successfully create, or before pool shutdown.
        await assertDesktopStorageMysqlTestAuthority({ environment,
          repositoryRoot: resolve(import.meta.dirname, "../..") });
        await admin!.query(`DROP DATABASE \`${database}\``);
      }
    } catch (caught) { throw mysqlTestPhaseFailure("cleanup", caught); }
    finally { await admin?.end().catch((caught) => { throw mysqlTestPhaseFailure("cleanup", caught); }); }
  }
  let phase = "connect";
  try {
    admin = await mysql.createConnection(authority.adminUrl);
    phase = "create_database";
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    const databaseUrl = new URL(authority.adminUrl); databaseUrl.pathname = `/${database}`;
    pool = mysql.createPool({ uri: databaseUrl.href, connectionLimit: 4 });
    phase = "social_schema";
    await ensureAcquisitionSocialAccountsMysqlSchema(pool);
    phase = "installation_schema";
    await ensureAcquisitionDesktopInstallationMysqlSchema(pool);
    phase = "outreach_schema";
    await ensureAcquisitionOutreachBatchMysqlSchema(pool);
    const activePool = pool;
    phase = "seed";
    backend = await createBridgeBackend(now, () => ({
      socialAccounts: new MysqlAcquisitionSocialAccountRepository(activePool),
      installations: new MysqlDesktopInstallationRepository(activePool),
      // The existing implementation widens one recoverDesktopAction discriminant
      // to string in inference. This test-only annotation changes no methods or storage.
      repository: new MysqlAcquisitionOutreachBatchRepository(activePool, undefined, {
        desktopTaskTokenKey: Buffer.from("bridge-mysql-task-key-at-least-thirty-two-bytes") }) as
          AcquisitionOutreachBatchRepository & AcquisitionDesktopOutreachRepository
    }));
    return { ...backend, get installationService() { return backend!.installationService; },
      get repository() { return backend!.repository; }, pool: activePool,
      async assertDurableState() {
        const [actions] = await activePool.query<mysql.RowDataPacket[]>(`SELECT id,kind,status,
          platform_write_attempt_count,platform_receipt_reference FROM acquisition_outreach_actions ORDER BY id`);
        const [attempts] = await activePool.query<mysql.RowDataPacket[]>(`SELECT action_id,fencing_token,
          execution_target,executor_binding_generation,platform_write_attempt_count,started_at,completed_at,
          outcome,receipt_hash,platform_receipt_reference FROM acquisition_outreach_action_attempts
          ORDER BY action_id,fencing_token`);
        for (const row of actions) {
          const matching = attempts.filter((attempt) => attempt.action_id === row.id);
          assert.ok(Number(row.platform_write_attempt_count) <= 1);
          assert.ok(matching.reduce((sum, attempt) => sum + Number(attempt.platform_write_attempt_count), 0) <= 1);
          if (row.status === "succeeded") {
            assert.equal(Number(row.platform_write_attempt_count), 1);
            assert.equal(matching.filter((attempt) => attempt.outcome === "succeeded").length, 1);
            const terminal = matching.find((attempt) => attempt.outcome === "succeeded")!;
            assert.equal(terminal.platform_receipt_reference, row.platform_receipt_reference);
            assert.ok(terminal.started_at); assert.ok(terminal.completed_at);
            assert.match(String(terminal.receipt_hash), /^[a-f0-9]{64}$/u);
          }
        }
        for (const row of attempts) {
          assert.equal(row.execution_target, "desktop");
          assert.ok(Number(row.fencing_token) >= 1);
          assert.ok(Number(row.executor_binding_generation) >= 1);
        }
        const [claims] = await activePool.query<mysql.RowDataPacket[]>(
          "SELECT response_kind,COUNT(*) AS count FROM acquisition_desktop_outreach_claim_replays GROUP BY response_kind");
        const [completions] = await activePool.query<mysql.RowDataPacket[]>(
          "SELECT operation_name,COUNT(*) AS count FROM acquisition_desktop_outreach_completion_replays GROUP BY operation_name");
        // Only counts/statuses leave this helper. Raw task content, token/handle,
        // receipt, SQL, device/process IDs and authority URL are never evidence.
        return { actions: actions.map((row) => ({ kind: String(row.kind), status: String(row.status),
          writes: Number(row.platform_write_attempt_count) })), attempts: attempts.length,
          claims: claims.map((row) => ({ kind: String(row.response_kind), count: Number(row.count) })),
          completions: completions.map((row) => ({ operation: String(row.operation_name), count: Number(row.count) })) };
      }, close };
  } catch (caught) {
    await close();
    // Driver errors may contain credentials or fixture SQL: never forward them.
    throw mysqlTestPhaseFailure(phase, caught);
  }
}
