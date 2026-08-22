import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";
import {
  MysqlAcquisitionCohortRepository
} from "./acquisition-cohort-mysql-repository.js";

test("MySQL cohort recovery requires an authorizer before cache writes", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const repository = new MysqlAcquisitionCohortRepository(
      fixture.pool, fixture.foundation.temporalBarrier
    );
    const operation = await repository.createOrReplayCatchUp({
      workspaceId: "workspace-a",
      cohortId: "cohort-1",
      cutoff: {
        effectiveAsOf: "2026-08-09T00:00:00.000Z",
        temporalSequence: 1
      },
      requestedBy: "finance-a",
      authorityKind: "performance_read",
      parentClosureOperationId: null,
      requestIdentity: "workspace-a\u0000finance-a\u0000cohort-1\u00002026-08-09T00:00:00.000Z"
    });
    assert.equal(operation.status, "queued");
    const claimed = await repository.claimCatchUp(
      operation.id, "worker-a", "2026-08-09T00:00:00.000Z", 30_000
    );
    assert.ok(claimed);
    assert.equal(claimed.status, "running");
  });
});
