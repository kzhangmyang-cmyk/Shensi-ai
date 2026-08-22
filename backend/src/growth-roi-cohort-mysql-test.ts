import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";
import {
  ACQUISITION_COHORT_MYSQL_SCHEMA_STATEMENTS,
  MysqlAcquisitionCohortRepository
} from "./acquisition-cohort-mysql-repository.js";

test("MySQL cohort schema is idempotent DDL with uniqueness guards", () => {
  const ddl = ACQUISITION_COHORT_MYSQL_SCHEMA_STATEMENTS.join("\n");
  assert.match(ddl, /uk_first_touch_membership/u);
  assert.match(ddl, /uk_membership_version_revision/u);
  assert.match(ddl, /uk_member_source_event/u);
  assert.match(ddl, /uk_cohort_window/u);
  assert.match(ddl, /uk_cohort_catchup_request/u);
});

test("MySQL cohort repository persists cohorts and catches up", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const repository = new MysqlAcquisitionCohortRepository(
      fixture.pool, fixture.foundation.temporalBarrier
    );
    const created = await repository.createCohort({
      id: "cohort-1",
      workspaceId: "workspace-a",
      platform: "douyin",
      cohortFrom: "2026-08-01T00:00:00.000Z",
      cohortTo: "2026-08-08T00:00:00.000Z",
      definitionVersion: "weekly.v1",
      firstTouchRuleVersion: "first-authoritative-discovery.v1",
      domainCommandHash: `sha256:${"a".repeat(64)}`,
      requestHash: `sha256:${"b".repeat(64)}`,
      requestedBy: "finance-a",
      now: "2026-08-09T00:00:00.000Z"
    });
    assert.equal(created.id, "cohort-1");
    assert.equal(created.status, "active");
    const read = await repository.requireActive("workspace-a", "cohort-1");
    assert.equal(read.platform, "douyin");
  });
});
