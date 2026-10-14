import assert from "node:assert/strict";
import test from "node:test";
import {
  isFullLiveOutcome,
  normalizeOutcomeFeedbackEvent
} from "./acquisition-outcome-compatibility.js";

function liveOutcome() {
  return {
    id: "outcome-1", ownerId: "owner-1", teamId: "team-1", leadId: "lead-1",
    customerId: "customer-1", eventType: "private_domain_entered",
    occurredAt: "2026-08-01T01:00:00.000Z", amount: null,
    reasonCode: null, reasonText: null, idempotencyKey: "outcome-1",
    createdBy: "reconciliation", createdAt: "2026-08-01T01:00:00.000Z",
    recordKind: "live", candidateId: "candidate-1",
    partyRef: { partyType: "individual", individualPartyId: "party-1", demandSignalId: "candidate-1" },
    attribution: {
      attributionVersion: "douyin-crawler.v1", jobId: "crawler-job-1",
      runId: "run-1", planId: "plan-1", planVersionId: "plan-version-1",
      planVersion: 1, planSnapshotHash: "plan-hash-1",
      discoveredEventId: "discovered-1", discoveredAt: "2026-08-01T00:00:00.000Z",
      shardId: null, operationId: null, connectionId: null, providerId: null,
      evidenceIds: ["evidence-1"], providerIds: [], queryIds: [],
      strategyVersion: "strategy-v1", qualificationDecisionId: "qualification-1",
      decisionVersion: "decision-v1", decisionSnapshotHash: "decision-hash-1",
      decisionEngine: "rules", ruleVersion: "rules-v1",
      modelProvider: null, model: null, promptVersion: null
    }
  };
}

test("persisted crawler outcomes retain live attribution and individual party identity", () => {
  const stored = liveOutcome();
  assert.equal(isFullLiveOutcome(stored), true);
  const restored = normalizeOutcomeFeedbackEvent(stored);
  assert.deepEqual(restored, stored);
  assert.notEqual(restored, stored);
  assert.notEqual(restored.attribution, stored.attribution);
});

test("malformed crawler attribution is not promoted to a live outcome", () => {
  for (const invalid of [
    { jobId: "" }, { jobId: undefined }, { shardId: "shard-1" },
    { operationId: "operation-1" }, { connectionId: "connection-1" },
    { providerId: "provider-1" }, { providerIds: ["provider-1"] },
    { queryIds: ["query-1"] }, { evidenceIds: [] }, { planVersion: 0 },
    { discoveredAt: "invalid-date" }
  ]) {
    const stored = liveOutcome();
    Object.assign(stored.attribution, invalid);
    assert.equal(isFullLiveOutcome(stored), false, JSON.stringify(invalid));
    const restored = normalizeOutcomeFeedbackEvent(stored);
    assert.equal(restored.recordKind, "legacy_migrated");
    assert.equal(restored.partyRef, null);
  }
});

test("old generic live outcomes keep their historical readable shape without accepting a job", () => {
  const stored = liveOutcome();
  const { jobId: _jobId, ...base } = stored.attribution;
  const generic = { ...stored, attribution: {
    ...base, attributionVersion: "acquisition-run.v1",
    shardId: "shard-1", operationId: "operation-1",
    connectionId: "connection-1", providerId: "provider-1",
    strategyVersion: "", qualificationDecisionId: "", decisionVersion: "",
    decisionSnapshotHash: "", ruleVersion: "", evidenceIds: [],
    providerIds: [""], queryIds: [""]
  } };
  assert.equal(isFullLiveOutcome(generic), true);
  assert.deepEqual(normalizeOutcomeFeedbackEvent(generic), generic);
  Object.assign(generic.attribution, { jobId: "crawler-job-1" });
  assert.equal(isFullLiveOutcome(generic), false);
});
