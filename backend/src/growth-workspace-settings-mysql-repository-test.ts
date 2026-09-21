import assert from "node:assert/strict";
import { test } from "node:test";
import type mysql from "mysql2/promise";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner,
  type GrowthTemporalBarrier
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  GROWTH_WORKSPACE_SETTINGS_MYSQL_SCHEMA_STATEMENTS,
  MysqlGrowthWorkspaceSettingsRepository,
  ensureGrowthWorkspaceSettingsMysqlSchema
} from "./growth-workspace-settings-mysql-repository.js";

class FakeConnection {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly transactions: string[] = [];
  readonly queue: unknown[] = [];

  enqueue(rows: unknown) { this.queue.push(rows); }

  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql: sql.replace(/\s+/gu, " ").trim(), values });
    return [this.queue.shift() ?? { affectedRows: 1 }, []];
  }
  async beginTransaction() { this.transactions.push("begin"); }
  async commit() { this.transactions.push("commit"); }
  async rollback() { this.transactions.push("rollback"); }
  release() { this.transactions.push("release"); }
}

class FakePool extends FakeConnection {
  constructor(readonly connection = new FakeConnection()) { super(); }
  async getConnection() { return this.connection; }
}

function asPool(pool: FakePool) { return pool as unknown as mysql.Pool; }

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

async function cutoff(context: ActiveWorkspaceContext, effectiveAsOf: string) {
  const runner = new InMemoryGrowthTemporalTransactionRunner(effectiveAsOf);
  return new DefaultGrowthTemporalBarrier(runner)
    .sealReadCutoff(context, effectiveAsOf);
}

test("workspace settings schema is append-only and tenant ordered", async () => {
  const pool = new FakePool();
  await ensureGrowthWorkspaceSettingsMysqlSchema(asPool(pool));
  assert.equal(pool.calls.length, GROWTH_WORKSPACE_SETTINGS_MYSQL_SCHEMA_STATEMENTS.length);
  const schema = pool.calls.map((call) => call.sql).join("\n");
  assert.match(schema, /growth_workspace_settings_events/u);
  assert.match(schema, /UNIQUE KEY uk_growth_workspace_settings_sequence/u);
  assert.match(schema, /UNIQUE KEY uk_growth_workspace_settings_revision/u);
  assert.match(schema, /workspace_id, recorded_at, event_sequence/u);
  assert.doesNotMatch(schema, /ON UPDATE CURRENT_TIMESTAMP/u);
  assert.match(schema, /workspace_id <> 'all'/u);
});

test("mysql getAt uses the exact workspace token and deterministic history order", async () => {
  const pool = new FakePool();
  pool.enqueue([{
    time_zone: "Asia/Shanghai",
    revision: "settings-1",
    recorded_at: "2026-08-09 08:00:00.000",
    event_sequence: 1
  }]);
  const repository = new MysqlGrowthWorkspaceSettingsRepository(
    asPool(pool),
    {} as GrowthTemporalBarrier
  );
  const context = workspace("team-a");
  const token = await cutoff(context, "2026-08-09T08:30:00.000Z");

  assert.deepEqual(await repository.getAt(context, token), {
    timeZone: "Asia/Shanghai",
    revision: "settings-1",
    recordedAt: "2026-08-09T08:00:00.000Z",
    eventSequence: 1
  });
  const query = pool.calls.at(-1)!;
  assert.match(query.sql, /workspace_id = \?/u);
  assert.match(query.sql, /recorded_at <= \?/u);
  assert.match(query.sql, /ORDER BY recorded_at DESC, event_sequence DESC/u);
  assert.deepEqual(query.values, ["team-a", "2026-08-09 08:30:00.000"]);
});

test("trusted settings append obtains the global barrier stamp before the settings lock", async () => {
  const connection = new FakeConnection();
  connection.enqueue({ affectedRows: 1 });
  connection.enqueue([{
    event_sequence: 1,
    revision: "growth-workspace-settings.v1"
  }]);
  connection.enqueue({ affectedRows: 1 });
  const calls: string[] = [];
  const barrier: GrowthTemporalBarrier = {
    async allocateAppend(_tx, workspaceId) {
      calls.push(`barrier:${workspaceId}`);
      assert.equal(connection.calls.length, 0);
      return {
        recordedAt: "2026-08-09T09:00:00.000Z",
        temporalSequence: 4
      };
    },
    async sealReadCutoff() { throw new Error("not_used"); }
  };
  const repository = new MysqlGrowthWorkspaceSettingsRepository(
    asPool(new FakePool(connection)),
    barrier
  );

  const appended = await repository.appendTrustedSettingsEvent("team-a", {
    timeZone: "Asia/Hong_Kong",
    revision: "settings-2"
  });

  assert.deepEqual(appended, {
    timeZone: "Asia/Hong_Kong",
    revision: "settings-2",
    recordedAt: "2026-08-09T09:00:00.000Z",
    eventSequence: 2
  });
  assert.deepEqual(calls, ["barrier:team-a"]);
  assert.match(connection.calls[0]!.sql, /INSERT IGNORE INTO growth_workspace_settings_events/u);
  assert.match(connection.calls[1]!.sql, /FOR UPDATE/u);
  assert.match(connection.calls[2]!.sql, /INSERT INTO growth_workspace_settings_events/u);
  assert.deepEqual(connection.transactions, ["begin", "commit", "release"]);
});

test("trusted settings rejects invalid configuration and all before transaction", async () => {
  const pool = new FakePool();
  const repository = new MysqlGrowthWorkspaceSettingsRepository(
    asPool(pool),
    {} as GrowthTemporalBarrier
  );
  await assert.rejects(
    () => repository.appendTrustedSettingsEvent("all", {
      timeZone: "Asia/Shanghai",
      revision: "settings-2"
    }),
    /invalid_growth_workspace_id/
  );
  await assert.rejects(
    () => repository.appendTrustedSettingsEvent("team-a", {
      timeZone: "Not/AZone",
      revision: "settings-2"
    }),
    /invalid_workspace_time_zone/
  );
  assert.equal(pool.connection.transactions.length, 0);
});
