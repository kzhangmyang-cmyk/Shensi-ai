import { strict as assert } from "node:assert";
import {
  createGrowthPerformanceApi,
  growthPerformancePath
} from "./api";
import type { GrowthHttpClient } from "../http";

const calls: string[] = [];
const http: GrowthHttpClient = {
  async request(path) {
    calls.push(path);
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
};

const api = createGrowthPerformanceApi(http);
await api.getGrowthPerformance({
  cohortId: "cohort-1",
  currency: "CNY",
  asOf: "2026-08-09T08:00:00.000Z",
  planId: "plan-1",
  closureVersionId: "closure-2"
});
assert.equal(
  calls[0],
  "/api/v1/acquisition/growth-performance"
    + "?cohortId=cohort-1&currency=CNY"
    + "&asOf=2026-08-09T08%3A00%3A00.000Z"
    + "&planId=plan-1&closureVersionId=closure-2"
);

assert.equal(
  growthPerformancePath({
    cohortId: "cohort-2",
    currency: "USD",
    asOf: "2026-08-09T08:00:00.000Z"
  }),
  "/api/v1/acquisition/growth-performance"
    + "?cohortId=cohort-2&currency=USD"
    + "&asOf=2026-08-09T08%3A00%3A00.000Z"
);
