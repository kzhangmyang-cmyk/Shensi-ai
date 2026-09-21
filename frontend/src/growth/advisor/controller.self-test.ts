import { strict as assert } from "node:assert";
import { GrowthApiError } from "../http";
import { createAdvisorController } from "./controller";
import type { AdvisorApi, AdvisorRecommendation } from "./api";

function todayFixture() {
  return {
    workspaceId: "ws-1",
    audienceRole: "manager",
    dataAsOf: "2026-08-09T08:00:00.000Z",
    priorityCustomers: [],
    pendingQuoteApprovals: [],
    expectedRoi: [],
    actualRoi: [],
    financialDataGaps: [],
    recommendations: [],
    sourceSnapshotHash: `sha256:${"a".repeat(64)}`
  } as never;
}

function apiFixture(overrides: Partial<AdvisorApi> = {}): AdvisorApi {
  return {
    async getToday() {
      return { status: 200, etag: null, body: todayFixture() } as never;
    },
    async decideRecommendation() {
      return {
        status: 200,
        etag: '"v:2"',
        body: {
          id: "recommendation-1",
          revision: 2,
          status: "accepted",
          outcomeRefs: []
        }
      } as never;
    },
    ...overrides
  };
}

const controller = createAdvisorController({
  api: apiFixture(),
  copilot: {
    async ask(prompt) {
      assert.equal(prompt.length > 0, true);
      return { explanation: "先核销成本。", aiUnavailable: false };
    }
  },
  hasFeature: () => true,
  hasCapability: () => true
});

const loaded = await controller.loadToday({
  currency: "CNY",
  asOf: "2026-08-09T08:00:00.000Z"
});
assert.equal(loaded.kind, "ready");

const asked = await controller.ask("今天先做什么");
assert.equal(asked.kind, "ready");
assert.equal(asked.explanation, "先核销成本。");
assert.equal(asked.aiUnavailable, false);

const recommendation: AdvisorRecommendation = {
  id: "recommendation-1",
  workspaceId: "ws-1",
  revision: 1,
  audienceRole: "manager",
  type: "cost_completion",
  summary: "补全成本",
  rationale: "成本缺失",
  metricRefs: [],
  evidenceRefs: [],
  entityRefs: [],
  confidenceBps: 8000,
  riskLevel: "medium",
  recommendedAction: { kind: "complete_cost_data", cohortId: "cohort-1" },
  status: "proposed",
  assignedTo: null,
  acceptedBy: null,
  acceptedAt: null,
  outcomeRefs: [],
  dataAsOf: "2026-08-09T08:00:00.000Z",
  inputSnapshotHash: `sha256:${"d".repeat(64)}`,
  modelSnapshotRef: "model-1",
  promptVersion: "growth-advisor.v1",
  schemaVersion: "advisor-recommendation.v1",
  generationIdempotencyKey: "generation-1",
  expiresAt: "2026-08-10T08:00:00.000Z",
  createdAt: "2026-08-09T08:00:00.000Z",
  updatedAt: "2026-08-09T08:00:00.000Z"
};
const decided = await controller.decide("accept", recommendation);
assert.equal(decided.kind, "ready");
assert.equal(decided.decidingId, "recommendation-1");

const forbidden = await createAdvisorController({
  api: apiFixture(),
  copilot: {
    async ask() {
      return { explanation: "", aiUnavailable: true };
    }
  },
  hasFeature: () => false,
  hasCapability: () => false
}).loadToday({
  currency: "CNY",
  asOf: "2026-08-09T08:00:00.000Z"
});
assert.deepEqual(forbidden, { kind: "forbidden" });

const conflicting = await createAdvisorController({
  api: apiFixture({
    async getToday() {
      throw new GrowthApiError(409, "idempotency_conflict");
    }
  }),
  copilot: {
    async ask() {
      return { explanation: "", aiUnavailable: true };
    }
  },
  hasFeature: () => true,
  hasCapability: () => true
}).loadToday({
  currency: "CNY",
  asOf: "2026-08-09T08:00:00.000Z"
});
assert.deepEqual(conflicting, {
  kind: "conflict",
  message: "idempotency_conflict"
});
