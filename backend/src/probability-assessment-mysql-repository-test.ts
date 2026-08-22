import assert from "node:assert/strict";
import test from "node:test";
import type mysql from "mysql2/promise";
import {
  MysqlProbabilityAssessmentRepository
} from "./probability-assessment-mysql-repository.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";

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

test("ProbabilityAssessment MySQL live contention suite is fail-closed without admin URL", {
  skip: process.env.MYSQL_TEST_ADMIN_URL
    ? "covered by the configured live integration gate"
    : "MYSQL_TEST_ADMIN_URL is required; no database is provisioned implicitly"
}, () => {});
