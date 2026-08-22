import assert from "node:assert/strict";
import { test } from "node:test";
import type mysql from "mysql2/promise";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import {
  GROWTH_TEMPORAL_BARRIER_MYSQL_SCHEMA_STATEMENTS,
  MysqlGrowthTemporalBarrier,
  MysqlGrowthTemporalTransaction,
  MysqlGrowthTemporalTransactionRunner,
  ensureGrowthTemporalBarrierMysqlSchema
} from "./growth-temporal-barrier-mysql-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { assertGrowthTemporalBarrier } from "./growth-temporal-barrier.js";

class FakeConnection {
  readonly calls: string[] = [];
  readonly values: unknown[][] = [];
  readonly queue: unknown[] = [];

  enqueue(rows: unknown) { this.queue.push(rows); }

  async query(sql: string, values: unknown[] = []) {
    this.calls.push(sql.replace(/\s+/gu, " ").trim());
    this.values.push(values);
    return [this.queue.shift() ?? { affectedRows: 1 }, []];
  }

  async beginTransaction() { this.calls.push("BEGIN"); this.values.push([]); }
  async commit() { this.calls.push("COMMIT"); this.values.push([]); }
  async rollback() { this.calls.push("ROLLBACK"); this.values.push([]); }
  release() { this.calls.push("RELEASE"); this.values.push([]); }
}

class FakePool extends FakeConnection {
  constructor(readonly connection = new FakeConnection()) { super(); }
  async getConnection() { return this.connection; }
}

function asPool(pool: FakePool) { return pool as unknown as mysql.Pool; }
function asConnection(connection: FakeConnection) {
  return connection as unknown as mysql.PoolConnection;
}

function workspace(workspaceId: string): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId,
    kind: "team",
    actorId: "user-1",
    role: "admin",
    teamId: workspaceId,
    capabilities: capabilitiesForHumanRole("admin"),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

test("temporal barrier schema is one concrete workspace row at millisecond precision", async () => {
  const pool = new FakePool();
  await ensureGrowthTemporalBarrierMysqlSchema(asPool(pool));
  assert.equal(pool.calls.length, GROWTH_TEMPORAL_BARRIER_MYSQL_SCHEMA_STATEMENTS.length);
  const schema = pool.calls.join("\n");
  assert.match(schema, /workspace_id VARCHAR\(191\) PRIMARY KEY/u);
  assert.match(schema, /last_recorded_at DATETIME\(3\) NOT NULL/u);
  assert.match(schema, /temporal_sequence BIGINT UNSIGNED NOT NULL/u);
  assert.match(schema, /workspace_id <> 'all'/u);
});

test("mysql allocation uses the caller connection and lock-first query order", async () => {
  const connection = new FakeConnection();
  connection.enqueue({ affectedRows: 1 });
  connection.enqueue([{
    last_recorded_at: "2026-08-09 08:00:00.000",
    temporal_sequence: 9
  }]);
  connection.enqueue([{
    current_timestamp_3: "2026-08-09 07:00:00.000"
  }]);
  connection.enqueue({ affectedRows: 1 });
  const pool = new FakePool(connection);
  const barrier = new MysqlGrowthTemporalBarrier(
    new MysqlGrowthTemporalTransactionRunner(asPool(pool))
  );
  const transaction = new MysqlGrowthTemporalTransaction(asConnection(connection));

  assert.deepEqual(await barrier.allocateAppend(transaction, "workspace-a"), {
    recordedAt: "2026-08-09T08:00:00.001Z",
    temporalSequence: 10
  });
  assert.match(connection.calls[0]!, /INSERT INTO growth_workspace_temporal_barriers/u);
  assert.match(connection.calls[1]!, /FOR UPDATE/u);
  assert.match(connection.calls[2]!, /CURRENT_TIMESTAMP\(3\)/u);
  assert.match(connection.calls[3]!, /UPDATE growth_workspace_temporal_barriers/u);
  assert.equal(connection.calls.includes("COMMIT"), false);
});

test("mysql seal owns a short transaction and advances the global fence", async () => {
  const connection = new FakeConnection();
  connection.enqueue({ affectedRows: 1 });
  connection.enqueue([{
    last_recorded_at: "2026-08-09 07:00:00.000",
    temporal_sequence: 3
  }]);
  connection.enqueue({ affectedRows: 1 });
  const runner = new MysqlGrowthTemporalTransactionRunner(
    asPool(new FakePool(connection))
  );
  const barrier = new MysqlGrowthTemporalBarrier(runner);

  const cutoff = await barrier.sealReadCutoff(
    workspace("workspace-a"),
    "2026-08-09T08:00:00.000Z"
  );

  assert.equal(cutoff.effectiveAsOf, "2026-08-09T08:00:00.000Z");
  assert.equal(cutoff.temporalSequence, 4);
  assert.deepEqual(connection.calls.filter((call) => [
    "BEGIN", "COMMIT", "ROLLBACK", "RELEASE"
  ].includes(call)), ["BEGIN", "COMMIT", "RELEASE"]);
  const updateIndex = connection.calls.findIndex((call) =>
    /UPDATE growth_workspace_temporal_barriers/u.test(call)
  );
  assert.deepEqual(connection.values[updateIndex], [
    "2026-08-09 08:00:00.000",
    4,
    "workspace-a",
    3
  ]);
});

test("mysql barrier rejects the non-concrete all workspace before I/O", async () => {
  const pool = new FakePool();
  const barrier = new MysqlGrowthTemporalBarrier(
    new MysqlGrowthTemporalTransactionRunner(asPool(pool))
  );
  await assert.rejects(
    () => barrier.sealReadCutoff(workspace("all"), "2026-08-09T08:00:00.000Z"),
    /invalid_growth_workspace_id/
  );
  assert.equal(pool.connection.calls.length, 0);
});

test("mysql temporal barriers carry Foundation provenance", () => {
  const barrier = new MysqlGrowthTemporalBarrier(
    new MysqlGrowthTemporalTransactionRunner(asPool(new FakePool()))
  );
  assert.equal(assertGrowthTemporalBarrier(barrier), barrier);
});
