import assert from "node:assert/strict";
import test from "node:test";
import { MysqlFinancialCouncilModelRoutingRepository,
  ensureFinancialCouncilModelRoutingMysqlSchema } from
  "./financial-council-model-routing-mysql-repository.js";
import { routingPolicyVersion, routingPutCommand, routingWorkspace } from
  "./financial-council-model-routing-repository-contract-test.js";
import { requireFinancialCouncilMysqlTestAdminUrl,
  createFinancialCouncilMysqlTestDatabase,
  withFinancialCouncilMysqlTestDatabase } from
  "./financial-council-mysql-test-support.js";

requireFinancialCouncilMysqlTestAdminUrl("financial-council-real-runtime");

test("real MySQL routing schema upgrades a pre-routing database", async () => {
  const database = await createFinancialCouncilMysqlTestDatabase({
    initializeSchemas: false
  });
  try {
    await database.pool.query(`CREATE TABLE financial_council_runs (
      workspace_id VARCHAR(191) NOT NULL,
      run_id VARCHAR(191) NOT NULL,
      PRIMARY KEY (workspace_id, run_id)
    ) ENGINE=InnoDB`);
    await ensureFinancialCouncilModelRoutingMysqlSchema(database.pool);
    const [rows] = await database.pool.query(
      `SELECT table_name AS table_name FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name LIKE 'financial_council_model_routing_%'
       ORDER BY table_name`
    );
    assert.deepEqual((rows as Array<{ table_name: string }>).map((row) =>
      row.table_name), ["financial_council_model_routing_idempotency",
      "financial_council_model_routing_policies"]);
  } finally {
    await database.close();
  }
});

test("real MySQL routing has one If-Match winner across two repository instances", async () => {
  await withFinancialCouncilMysqlTestDatabase(async ({ pool, connectionA,
    connectionB }) => {
    assert.notEqual(connectionA.threadId, connectionB.threadId);
    await ensureFinancialCouncilModelRoutingMysqlSchema(pool);
    const first = new MysqlFinancialCouncilModelRoutingRepository(pool);
    const second = new MysqlFinancialCouncilModelRoutingRepository(pool);
    await first.put(routingPutCommand(), routingPolicyVersion());
    const contenders = await Promise.allSettled([
      first.put(routingPutCommand({ key: "race-a",
        requestHash: `sha256:${"d".repeat(64)}`, expectedRevision: 1 }),
      routingPolicyVersion("team-1", 2, { policyVersionId: "route-a" })),
      second.put(routingPutCommand({ key: "race-b",
        requestHash: `sha256:${"e".repeat(64)}`, expectedRevision: 1 }),
      routingPolicyVersion("team-1", 2, { policyVersionId: "route-b" }))
    ]);
    assert.equal(contenders.filter((row) => row.status === "fulfilled").length,
      1);
    assert.equal(contenders.filter((row) => row.status === "rejected").length,
      1);
    assert.equal((await first.getCurrent(routingWorkspace()))?.revision, 2);
  });
});
