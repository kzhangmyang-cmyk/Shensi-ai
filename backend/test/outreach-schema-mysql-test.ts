import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import mysql from "mysql2/promise";
import { assertDesktopStorageMysqlTestAuthority, createDesktopStorageMysqlTestDatabaseName }
  from "./acquisition-desktop-installation-mysql-test-support.js";
import { ensureAcquisitionSocialAccountsMysqlSchema }
  from "../src/acquisition-social-account-mysql-repository.js";
import { ensureAcquisitionDesktopInstallationMysqlSchema }
  from "../src/acquisition-desktop-installation-mysql-repository.js";
import { ensureAcquisitionOutreachBatchMysqlSchema }
  from "../src/acquisition-outreach-batch-mysql-repository.js";
// @ts-expect-error Shared test-only diagnostics are owned by the disposable operator.
import { mysqlTestPhaseFailure, mysqlCheckMetadataDiagnostic } from "../../scripts/lib/desktop-action-test-diagnostics.mjs";

test("isolated empty MySQL initializes outreach schema and accepts a second ensure", {
  skip: process.env.DESKTOP_ACTION_STORAGE_SUITE !== "outreach-schema"
    ? "requires the outreach-schema disposable operator" : false
}, async () => {
  const environment = process.env;
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  // This happens before any connection. A URL alone never authorizes this test.
  const authority = await assertDesktopStorageMysqlTestAuthority({ environment, repositoryRoot });
  const database = createDesktopStorageMysqlTestDatabaseName();
  let admin: mysql.Connection | undefined;
  let pool: mysql.Pool | undefined;
  let created = false;
  let phase = "connect";
  let failedStatement: number | undefined;
  let failure: Error | undefined;
  let checkDiagnostic: unknown;
  try {
    admin = await mysql.createConnection(authority.adminUrl);
    phase = "create_database";
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    const databaseUrl = new URL(authority.adminUrl);
    databaseUrl.pathname = `/${database}`;
    const activePool = mysql.createPool({ uri: databaseUrl.href, connectionLimit: 4 });
    pool = activePool;
    phase = "social_schema";
    await ensureAcquisitionSocialAccountsMysqlSchema(activePool);
    phase = "installation_schema";
    await ensureAcquisitionDesktopInstallationMysqlSchema(activePool);
    phase = "outreach_schema";
    let ordinal = 0;
    let repeat = false;
    let repeatMutations = 0;
    const tracedPool: Pick<mysql.Pool, "execute"> = {
      execute: (async (...args: Parameters<mysql.Pool["execute"]>) => {
        const current = ++ordinal;
        const sql = typeof args[0] === "string" ? args[0] : args[0].sql;
        if (repeat && /^\s*(?:ALTER|UPDATE|INSERT|DELETE|DROP)\b/iu.test(sql)) repeatMutations += 1;
        try {
          const result = await activePool.execute(...args);
          if (/FROM information_schema\.TABLE_CONSTRAINTS\b/u.test(sql)) {
            checkDiagnostic ??= mysqlCheckMetadataDiagnostic(result[0]);
          }
          return result;
        }
        catch (caught) { failedStatement ??= current; throw caught; }
      }) as mysql.Pool["execute"]
    };
    // Run the actual initializer, not prefilled information_schema fixtures.
    // Only a fixed statement ordinal may leave the trace; SQL/values never do.
    await ensureAcquisitionOutreachBatchMysqlSchema(tracedPool);
    repeat = true;
    await ensureAcquisitionOutreachBatchMysqlSchema(tracedPool);
    phase = "assertions";
    assert.equal(repeatMutations, 0, "second ensure must not repair an initialized schema");
  } catch (caught) {
    failure = mysqlTestPhaseFailure(phase, caught, { statement: failedStatement });
    if (phase === "outreach_schema" && checkDiagnostic) {
      console.error(`DESKTOP_ACTION_MYSQL_CHECKS ${JSON.stringify(checkDiagnostic)}`);
    }
  }
  try {
    await pool?.end();
    if (created) {
      if (!/^goodjob_desktop_installation_[a-f0-9]{32}$/u.test(database)) {
        throw new Error("DESKTOP_ACTION_STORAGE_TEST_DATABASE_INVALID");
      }
      await assertDesktopStorageMysqlTestAuthority({ environment, repositoryRoot });
      await admin!.query(`DROP DATABASE \`${database}\``);
    }
  } catch (caught) {
    // Preserve a setup diagnostic even if cleanup also fails, but never the
    // underlying driver error. Outer owner-controlled cleanup remains in force.
    if (failure) console.error(failure.message);
    failure = mysqlTestPhaseFailure("cleanup", caught);
  } finally {
    try { await admin?.end(); }
    catch (caught) {
      if (failure) console.error(failure.message);
      failure = mysqlTestPhaseFailure("cleanup", caught);
    }
  }
  if (failure) throw failure;
  console.log("DESKTOP_ACTION_STORAGE_LIVE_TEST_EXECUTED:outreach-schema");
});
