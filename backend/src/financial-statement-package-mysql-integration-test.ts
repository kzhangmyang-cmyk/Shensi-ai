import assert from "node:assert/strict";
import test from "node:test";
import { MysqlFinancialStatementPackageRepository,
  ensureFinancialStatementPackageMysqlSchema } from
  "./financial-statement-package-mysql-repository.js";
import { previewFixture } from
  "./financial-statement-package-repository-contract-test.js";
import { commitFixture, forecastRecordFixture } from
  "./financial-statement-package-repository-contract-test.js";
import { canonicalFinancialCashForecastSupplement } from
  "./financial-statement-package.js";
import { financialCouncilCanonicalHash } from
  "./financial-council-domain.js";
import { requireFinancialCouncilMysqlTestAdminUrl,
  createFinancialCouncilMysqlTestDatabase } from
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

test("real MySQL forecast commits serialize exact replay and changed conflict",
  async () => {
  const database = await createFinancialCouncilMysqlTestDatabase();
  try {
    const { pool } = database;
    await ensureFinancialStatementPackageMysqlSchema(pool);
    const connectionA = await pool.getConnection();
    const connectionB = await pool.getConnection();
    try {
      const [idsA] = await connectionA.query("SELECT CONNECTION_ID() AS id");
      const [idsB] = await connectionB.query("SELECT CONNECTION_ID() AS id");
      assert.notEqual((idsA as Array<{ id: number }>)[0]?.id,
        (idsB as Array<{ id: number }>)[0]?.id);
    } finally {
      connectionB.release();
      connectionA.release();
    }
    const first = new MysqlFinancialStatementPackageRepository(pool);
    const second = new MysqlFinancialStatementPackageRepository(pool);
    const preview = previewFixture();
    await first.appendPreview(preview);
    const exactInput = commitFixture({ packageId: "package-exact",
      cashForecast: forecastRecordFixture() });
    const exact = await Promise.all([
      first.commitPreview(exactInput), second.commitPreview(exactInput)
    ]);
    assert.deepEqual(exact.map((row) => row.replayed).sort(), [false, true]);
    assert.equal(exact[0].value.packageHash, exact[1].value.packageHash);

    const { previewHash: _previewHash, ...previewPreimage } = previewFixture();
    const changedPreviewPreimage = { ...previewPreimage,
      previewId: "preview-changed" };
    const changedPreview = { ...changedPreviewPreimage,
      previewHash: financialCouncilCanonicalHash(changedPreviewPreimage) };
    await first.appendPreview(changedPreview);
    const changedForecast = canonicalFinancialCashForecastSupplement({
      forecastAsOf: "2026-08-23T12:10:00.000Z",
      expectedInflowsNext30DaysMinor: 100_001,
      expectedOutflowsNext30DaysMinor: 500_000,
      expectedInflowsNext31To90DaysMinor: 800_000,
      expectedOutflowsNext31To90DaysMinor: 300_000,
      receivables: [], attestation: { accepted: true,
        noticeVersion: "financial-cash-forecast.v1" }
    }, { currency: "CNY", acceptedBy: "actor-a",
      acceptedAt: "2026-08-23T12:11:00.000Z", period: "2026-08-23" });
    const sameKey = `sha256:${"9".repeat(64)}` as const;
    const changed = await Promise.allSettled([
      first.commitPreview({ ...commitFixture({ packageId: "package-changed-a",
        idempotencyKeyHash: sameKey, requestHash: `sha256:${"3".repeat(64)}`,
        cashForecast: forecastRecordFixture() }), previewId: "preview-changed" }),
      second.commitPreview({ ...commitFixture({ packageId: "package-changed-b",
        idempotencyKeyHash: sameKey, requestHash: `sha256:${"4".repeat(64)}`,
        cashForecast: changedForecast }), previewId: "preview-changed" })
    ]);
    assert.equal(changed.filter((row) => row.status === "fulfilled").length, 1);
    const rejected = changed.find((row) => row.status === "rejected") as
      PromiseRejectedResult;
    assert.equal((rejected.reason as { code?: string }).code,
      "financial_statement_idempotency_conflict");

    const reopenedPool = database.openPool();
    try {
      const reopened = new MysqlFinancialStatementPackageRepository(reopenedPool);
      const persisted = await reopened.getVerified("workspace-a", "package-exact");
      assert.ok(persisted);
      assert.equal(persisted.packageHash, exact[0].value.packageHash);
      assert.equal(persisted.reportInputHash, exact[0].value.reportInputHash);
      assert.equal(persisted.cashForecast?.forecastHash,
        exact[0].value.cashForecast?.forecastHash);
      assert.equal(persisted.cashForecast?.acceptedBy, "actor-a");
      assert.equal(persisted.cashForecast?.acceptedAt,
        "2026-08-23T12:11:00.000Z");
    } finally {
      await reopenedPool.end();
    }
  } finally {
    await database.close();
  }
});
