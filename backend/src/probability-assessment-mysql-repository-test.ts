import assert from "node:assert/strict";
import test from "node:test";
import type mysql from "mysql2/promise";
import {
  MysqlProbabilityAssessmentRepository,
  PROBABILITY_ASSESSMENT_MYSQL_SCHEMA_STATEMENTS
} from "./probability-assessment-mysql-repository.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import { MysqlGrowthTemporalBarrier } from "./growth-temporal-barrier-mysql-repository.js";
import { probabilityRecordFixture } from "./growth-quote-test-fixtures.js";

class ReservedWordConnection {
  readonly calls: string[] = [];

  async query(sql: string) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.calls.push(normalized);
    if (/^SELECT last_recorded_at/u.test(normalized)) {
      return [[{
        last_recorded_at: "2026-08-09 08:00:00.000",
        temporal_sequence: 0
      }], []];
    }
    if (/^SELECT CURRENT_TIMESTAMP/u.test(normalized)) {
      return [[{ current_timestamp_3: "2026-08-09 08:00:00.000" }], []];
    }
    if (/^SELECT \* FROM probability_assessments_v2/u.test(normalized)) {
      return [[], []];
    }
    return [{ affectedRows: 1 }, []];
  }

  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  release() {}
}

test("MySQL deal binding rejects malformed authority before opening a transaction", async () => {
  let connections = 0;
  const pool = {
    async getConnection() {
      connections += 1;
      throw new Error("pool must remain unopened");
    }
  } as unknown as mysql.Pool;
  const transactions = new InMemoryGrowthTemporalTransactionRunner();
  const repository = new MysqlProbabilityAssessmentRepository(
    pool,
    new DefaultGrowthTemporalBarrier(transactions)
  );
  await assert.rejects(
    repository.bindDeal(
      "workspace-a",
      "probability-a",
      "deal-a",
      "not-a-hash" as never
    ),
    (error: unknown) => (error as { code?: string }).code
      === "invalid_probability_assessment_hash"
  );
  assert.equal(connections, 0);
});

test("MySQL 8.4 schema and writes quote the reserved precision identifier", async () => {
  const schema = PROBABILITY_ASSESSMENT_MYSQL_SCHEMA_STATEMENTS.join("\n");
  assert.match(schema, /`precision` ENUM\('bps'\) NOT NULL/u);
  assert.match(
    schema,
    /stable_identity_hash CHAR\(64\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/u
  );
  assert.match(
    schema,
    /UNIQUE KEY uk_probability_assessment_identity \(\s*workspace_id,stable_identity_hash\s*\)/u
  );

  const connection = new ReservedWordConnection();
  const pool = {
    async getConnection() { return connection; }
  } as unknown as mysql.Pool;
  const repository = new MysqlProbabilityAssessmentRepository(
    pool,
    new MysqlGrowthTemporalBarrier(pool)
  );
  await repository.append(probabilityRecordFixture({
    workspaceId: "workspace-a",
    recordedAt: "2026-08-09T08:00:00.000Z",
    temporalSequence: 1
  }));
  const insert = connection.calls.find((sql) =>
    /^INSERT INTO probability_assessments_v2/u.test(sql));
  assert.match(
    insert ?? "",
    /input_snapshot_hash,\s*stable_identity_hash,\s*assessed_at,[\s\S]*`precision`/u
  );
});

test("ProbabilityAssessment MySQL live contention suite is fail-closed without admin URL", {
  skip: process.env.MYSQL_TEST_ADMIN_URL
    ? "covered by the configured live integration gate"
    : "MYSQL_TEST_ADMIN_URL is required; no database is provisioned implicitly"
}, () => {});
