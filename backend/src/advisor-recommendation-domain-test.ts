import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAdvisorTransition,
  type AdvisorRecommendation
} from "./advisor-recommendation-domain.js";

function recommendationFixture(overrides: Partial<AdvisorRecommendation> = {}) {
  return Object.freeze({
    id: "rec-1",
    workspaceId: "ws-1",
    revision: 1,
    audienceRole: "manager",
    type: "data_gap",
    summary: "complete financial data",
    rationale: "missing cogs blocks ROI",
    metricRefs: [],
    evidenceRefs: [],
    entityRefs: [],
    confidenceBps: 8000,
    riskLevel: "medium",
    recommendedAction: { kind: "complete_financial_fact", dealId: "deal-1" },
    status: "proposed",
    assignedTo: null,
    acceptedBy: null,
    acceptedAt: null,
    outcomeRefs: [],
    dataAsOf: "2026-08-09T00:00:00.000Z",
    inputSnapshotHash: `sha256:${"a".repeat(64)}`,
    modelSnapshotRef: "model-v1",
    promptVersion: "advisor-prompt.v1",
    schemaVersion: "advisor-recommendation.v1",
    generationIdempotencyKey: "generation-1",
    expiresAt: "2026-08-09T08:00:00.000Z",
    createdAt: "2026-08-09T07:00:00.000Z",
    updatedAt: "2026-08-09T07:00:00.000Z",
    ...overrides
  }) as AdvisorRecommendation;
}

export { recommendationFixture };

test("recommendation references and state transitions are closed", () => {
  const created = recommendationFixture({ status: "proposed" });
  assert.equal(created.status, "proposed");
  const accepted = applyAdvisorTransition(
    created,
    { recommendationId: created.id, kind: "accept", reason: null },
    { actorId: "manager-1", occurredAt: "2026-08-09T08:01:00.000Z" }
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.acceptedBy, "manager-1");
  assert.throws(
    () => applyAdvisorTransition(
      accepted,
      { recommendationId: accepted.id, kind: "ignore", reason: null },
      { actorId: "manager-1", occurredAt: "2026-08-09T08:02:00.000Z" }
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "invalid_recommendation_transition"
  );
});

test("accepted completes and proposed ignores", () => {
  const proposed = recommendationFixture({ status: "proposed" });
  const ignored = applyAdvisorTransition(
    proposed,
    { recommendationId: proposed.id, kind: "ignore", reason: "no" },
    { actorId: "manager-1", occurredAt: "2026-08-09T08:01:00.000Z" }
  );
  assert.equal(ignored.status, "ignored");
  const accepted = applyAdvisorTransition(
    proposed,
    { recommendationId: proposed.id, kind: "accept", reason: null },
    { actorId: "manager-1", occurredAt: "2026-08-09T08:01:00.000Z" }
  );
  const completed = applyAdvisorTransition(
    accepted,
    { recommendationId: accepted.id, kind: "complete", reason: "done" },
    { actorId: "manager-1", occurredAt: "2026-08-09T09:00:00.000Z" }
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.revision, 3);
});
