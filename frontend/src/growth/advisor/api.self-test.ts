import { strict as assert } from "node:assert";
import {
  advisorTodayPath,
  createAdvisorApi
} from "./api";
import type {
  GrowthHttpClient,
  GrowthHttpRequestOptions
} from "../http";

const calls: Array<{ path: string; options?: GrowthHttpRequestOptions }> = [];
const http: GrowthHttpClient = {
  async request(path, options) {
    calls.push({ path, options });
    return {
      status: 200,
      etag: '"v:1"',
      body: {
        id: "recommendation-1",
        revision: 2,
        status: "accepted",
        outcomeRefs: []
      }
    } as never;
  }
};

const api = createAdvisorApi(http);
assert.equal(
  advisorTodayPath({
    currency: "CNY",
    asOf: "2026-08-09T08:00:00.000Z"
  }),
  "/api/v1/acquisition/advisor/today"
    + "?currency=CNY&asOf=2026-08-09T08%3A00%3A00.000Z"
);

await api.getToday({
  currency: "CNY",
  asOf: "2026-08-09T08:00:00.000Z"
});
assert.equal(
  calls[0]?.path,
  "/api/v1/acquisition/advisor/today"
    + "?currency=CNY&asOf=2026-08-09T08%3A00%3A00.000Z"
);

await api.decideRecommendation(
  "accept",
  "recommendation-1",
  { reason: null },
  '"v:1"',
  "advisor-accept:key-1"
);
assert.equal(
  calls[1]?.path,
  "/api/v1/acquisition/advisor/recommendations/recommendation-1/accept"
);
assert.deepEqual(calls[1]?.options, {
  method: "POST",
  body: { reason: null },
  ifMatch: '"v:1"',
  idempotencyKey: "advisor-accept:key-1"
});
