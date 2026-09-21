import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";
import {
  ROI_CLOSURE_MYSQL_SCHEMA_STATEMENTS
} from "./acquisition-roi-closure-mysql-repository.js";

test("MySQL closure schema is idempotent DDL with uniqueness guards", () => {
  const ddl = ROI_CLOSURE_MYSQL_SCHEMA_STATEMENTS.join("\n");
  assert.match(ddl, /uk_roi_closure_operation_command/u);
  assert.match(ddl, /uk_roi_closure_operation_input/u);
  assert.match(ddl, /uk_roi_series/u);
  assert.match(ddl, /uk_roi_series_revision/u);
  assert.match(ddl, /uk_roi_closure_version/u);
  assert.match(ddl, /uk_closure_attestation_command/u);
  assert.match(ddl, /roi_snapshot_slice_members/u);
});

test("MySQL closure repository persists series and versions", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const repository = fixture.closureRepository();
    const series = Object.freeze({
      id: "series-cny",
      workspaceId: "workspace-a",
      cohortId: "cohort-a",
      currency: "CNY",
      status: "open",
      currentClosureVersionId: null,
      revision: 1,
      updatedAt: "2026-08-09T00:00:00.000Z"
    });
    await repository.createSeries(series);
    const read = await repository.getSeries(
      "workspace-a", "cohort-a", "CNY"
    );
    assert.equal(read?.id, "series-cny");
    assert.equal(read?.status, "open");
  });
});
