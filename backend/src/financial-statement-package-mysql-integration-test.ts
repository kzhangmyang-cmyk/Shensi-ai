import assert from "node:assert/strict";
import test from "node:test";
import { MysqlFinancialStatementPackageRepository,
  ensureFinancialStatementPackageMysqlSchema } from
  "./financial-statement-package-mysql-repository.js";
import { previewFixture } from
  "./financial-statement-package-repository-contract-test.js";
import { requireFinancialCouncilMysqlTestAdminUrl,
  createFinancialCouncilMysqlTestDatabase,
  withFinancialCouncilMysqlTestDatabase } from
  "./financial-council-mysql-test-support.js";

requireFinancialCouncilMysqlTestAdminUrl("financial-council-real-runtime");

test("real MySQL statement schema upgrades a pre-package database", async () => {
  const database = await createFinancialCouncilMysqlTestDatabase({
    initializeSchemas: false
  });
  try {
    await database.pool.query(`CREATE TABLE financial_council_runs (
      workspace_id VARCHAR(191) NOT NULL,
      run_id VARCHAR(191) NOT NULL,
      PRIMARY KEY (workspace_id, run_id)
    ) ENGINE=InnoDB`);
    await ensureFinancialStatementPackageMysqlSchema(database.pool);
    const [rows] = await database.pool.query(
      `SELECT table_name AS table_name FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name LIKE 'financial_statement_package%'
       ORDER BY table_name`
    );
    assert.deepEqual((rows as Array<{ table_name: string }>).map((row) =>
      row.table_name), ["financial_statement_package_idempotency",
      "financial_statement_package_previews", "financial_statement_packages"]);
  } finally {
    await database.close();
  }
});

test("real MySQL package commit has one winner and exact replay across two connections", async () => {
  await withFinancialCouncilMysqlTestDatabase(async ({ pool, connectionA,
    connectionB }) => {
    assert.notEqual(connectionA.threadId, connectionB.threadId);
    await ensureFinancialStatementPackageMysqlSchema(pool);
    const first = new MysqlFinancialStatementPackageRepository(pool);
    const second = new MysqlFinancialStatementPackageRepository(pool);
    const preview = previewFixture();
    await first.appendPreview(preview);
    const input = (suffix: string) => ({ workspaceId: preview.workspaceId,
      previewId: preview.previewId, packageId: `package-${suffix}`,
      consent: { accepted: true as const,
        noticeVersion: "financial-model-data.v1" as const,
        acceptedBy: "actor-a", acceptedAt: "2026-08-23T12:11:00.000Z" },
      idempotencyKeyHash: `sha256:${suffix.repeat(64)}`,
      requestHash: `sha256:${suffix.repeat(64)}`,
      createdAt: "2026-08-23T12:11:00.000Z" });
    const contenders = await Promise.allSettled([
      first.commitPreview(input("1")), second.commitPreview(input("2"))
    ]);
    assert.equal(contenders.filter((row) => row.status === "fulfilled").length,
      1);
    assert.equal(contenders.filter((row) => row.status === "rejected").length,
      1);
    const winner = contenders.find((row): row is PromiseFulfilledResult<
      Awaited<ReturnType<typeof first.commitPreview>>> =>
      row.status === "fulfilled")!.value;
    const replayInput = winner.value.packageId === "package-1"
      ? input("1") : input("2");
    const replay = await second.commitPreview(replayInput);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.value, winner.value);
  });
});
