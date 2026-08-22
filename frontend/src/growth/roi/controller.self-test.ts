import { strict as assert } from "node:assert";
import { GrowthApiError } from "../http";
import { createRoiController } from "./controller";
import type { GrowthPerformanceApi } from "./api";

function apiFixture(overrides: Partial<GrowthPerformanceApi> = {}): GrowthPerformanceApi {
  return {
    async getGrowthPerformance() {
      throw new Error("unused");
    },
    async listCohorts() {
      return {
        status: 200,
        etag: null,
        body: { items: [], nextCursor: null }
      } as never;
    },
    ...overrides
  };
}

const controller = createRoiController({
  api: apiFixture(),
  hasFeature: () => true,
  hasCapability: () => true
});

const ready = await controller.loadCohorts();
assert.equal(ready.kind, "ready");

const forbidden = await createRoiController({
  api: apiFixture(),
  hasFeature: () => false,
  hasCapability: () => false
}).loadCohorts();
assert.deepEqual(forbidden, { kind: "forbidden" });

const conflicting = await createRoiController({
  api: apiFixture({
    async listCohorts() {
      throw new GrowthApiError(409, "idempotency_conflict");
    }
  }),
  hasFeature: () => true,
  hasCapability: () => true
}).loadCohorts();
assert.deepEqual(conflicting, {
  kind: "conflict",
  message: "idempotency_conflict"
});

const queryController = createRoiController({
  api: apiFixture({
    async getGrowthPerformance() {
      return {
        status: 200,
        etag: null,
        body: {
          cohortId: "cohort-1",
          currency: "CNY",
          planId: null,
          dataAsOf: "2026-08-09T08:00:00.000Z",
          expectedRoiByCurrency: [],
          actualRoiByCurrency: [],
          cashByCurrency: [],
          coverage: {
            costCoverageBps: 0,
            marginCoverageBps: 0,
            cashCoverageBps: 0,
            attributionCoverageBps: 0,
            gapCodes: []
          },
          dataGaps: [],
          closureVersionId: null,
          formulaVersion: "growth-performance.v1",
          calculationHash: `sha256:${"a".repeat(64)}`,
          membershipSnapshotHash: null
        }
      } as never;
    }
  }),
  hasFeature: () => true,
  hasCapability: () => true
});
const queried = await queryController.query({
  cohortId: "cohort-1",
  currency: "CNY",
  asOf: "2026-08-09T08:00:00.000Z"
});
assert.equal(queried.kind, "ready");
assert.equal(
  (queried.performance as unknown as { cohortId?: string }).cohortId,
  "cohort-1"
);
