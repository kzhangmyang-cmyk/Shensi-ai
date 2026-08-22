import assert from "node:assert/strict";
import test from "node:test";
import {
  DefaultAcquisitionGrowthPerformanceQueryService
} from "./acquisition-growth-performance-query.js";
import {
  growthPerformanceFixture
} from "./growth-roi-test-fixtures.js";

test("explicit closure is exact and asOf selects max timestamp then highest version", async () => {
  const fixture = growthPerformanceFixture({
    closures: [
      {
        id: "closure-1",
        version: 1,
        asOf: "2026-08-08T00:00:00.000Z",
        status: "superseded",
        roiBps: 1000
      },
      {
        id: "closure-2",
        version: 2,
        asOf: "2026-08-08T00:00:00.000Z",
        status: "closed",
        roiBps: 2000
      },
      {
        id: "closure-3",
        version: 3,
        asOf: "2026-08-10T00:00:00.000Z",
        status: "closed",
        roiBps: 3000
      }
    ]
  });
  const service = new DefaultAcquisitionGrowthPerformanceQueryService(
    fixture.dependencies.source, fixture.dependencies.contributions
  );
  const selected = await service.getAt(
    fixture.workspace,
    {
      cohortId: "cohort-1",
      currency: "CNY",
      planId: null,
      closureVersionId: null
    },
    await fixture.seal("2026-08-09T00:00:00.000Z")
  );
  assert.equal(selected.actualRoiByCurrency[0]?.closureVersionId, "closure-2");
  const exact = await service.getAt(
    fixture.workspace,
    {
      cohortId: "cohort-1",
      currency: "CNY",
      planId: null,
      closureVersionId: "closure-1"
    },
    await fixture.seal("2026-08-11T00:00:00.000Z")
  );
  assert.equal(exact.actualRoiByCurrency[0]?.closureVersionId, "closure-1");
});

test("planId slices firstPlanId inside one snapshot", async () => {
  const fixture = growthPerformanceFixture({
    members: [
      { id: "member-a", firstPlanId: "plan-a" },
      { id: "member-b", firstPlanId: "plan-b" }
    ]
  });
  const service = new DefaultAcquisitionGrowthPerformanceQueryService(
    fixture.dependencies.source, fixture.dependencies.contributions
  );
  const result = await service.getAt(
    fixture.workspace,
    {
      cohortId: "cohort-1",
      currency: "CNY",
      planId: "plan-a",
      closureVersionId: null
    },
    await fixture.seal("2026-08-09T00:00:00.000Z")
  );
  assert.deepEqual(result.memberIds, ["member-a"]);
});

test("expected ROI includes every candidate source merged into one canonical member", async () => {
  const fixture = growthPerformanceFixture({
    members: [{
      id: "member-a",
      primaryCandidateId: "candidate-primary",
      firstPlanId: "plan-a"
    }],
    memberSources: [{
      cohortMemberId: "member-a",
      candidateId: "candidate-secondary"
    }],
    quoteCandidateId: "candidate-secondary"
  });
  const result = await new DefaultAcquisitionGrowthPerformanceQueryService(
    fixture.dependencies.source, fixture.dependencies.contributions
  ).getAt(
    fixture.workspace,
    {
      cohortId: "cohort-1",
      currency: "CNY",
      planId: "plan-a",
      closureVersionId: null
    },
    await fixture.seal("2026-08-09T00:00:00.000Z")
  );
  assert.deepEqual(
    result.expectedRoiByCurrency[0]?.quoteVersionIds,
    ["quote-secondary"]
  );
});

test("a late backdated closure cannot rewrite an earlier data-as-of", async () => {
  const fixture = growthPerformanceFixture({
    closures: [{
      id: "closure-late",
      version: 1,
      asOf: "2026-08-01T00:00:00.000Z",
      closedAt: "2026-08-10T00:00:00.000Z",
      status: "closed",
      roiBps: 1000
    }]
  });
  const service = new DefaultAcquisitionGrowthPerformanceQueryService(
    fixture.dependencies.source, fixture.dependencies.contributions
  );
  const historical = await service.getAt(
    fixture.workspace,
    {
      cohortId: "cohort-1",
      currency: "CNY",
      planId: null,
      closureVersionId: null
    },
    await fixture.seal("2026-08-05T00:00:00.000Z")
  );
  assert.equal(
    historical.actualRoiByCurrency[0]?.status === "not_computable"
      ? historical.actualRoiByCurrency[0].reason : null,
    "cohort_not_closed"
  );
});
