import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryGrowthTemporalTransactionRunner,
  DefaultGrowthTemporalBarrier
} from "./growth-temporal-barrier.js";
import {
  InMemoryProbabilityAssessmentRepository,
  assertFormalProbabilityAssessment
} from "./probability-assessment.js";
import { probabilityRecordFixture } from "./growth-quote-test-fixtures.js";

function repository() {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  );
  return new InMemoryProbabilityAssessmentRepository({
    transactions,
    temporalBarrier: new DefaultGrowthTemporalBarrier(transactions)
  });
}

test("records the exact qualification BPS and frozen decision evidence", async () => {
  const assessments = repository();
  const stored = await assessments.recordFromQualification({
    workspaceId: "workspace-a",
    candidateId: "candidate-a",
    dealId: null,
    qualificationDecisionId: "qualification-a",
    qualificationDecisionVersion: "decision-v3",
    qualificationInputHash: `sha256:${"a".repeat(64)}`,
    evidenceRefs: ["evidence-2", "evidence-1", "evidence-2"],
    ruleVersion: "qualification-rules.v2",
    modelSnapshotRef: "model-snapshot-a",
    financial: { closeProbabilityBps: 4_321 },
    assessedAt: "2026-08-09T07:59:59.000Z"
  });
  assert.equal(stored.closeProbabilityBps, 4_321);
  assert.equal(stored.precision, "bps");
  assert.deepEqual(stored.evidenceRefs, ["evidence-2", "evidence-1"]);
  assert.equal(stored.inputSnapshotHash, `sha256:${"a".repeat(64)}`);
  assert.equal(stored.ruleVersion, "qualification-rules.v2");
  assert.equal(stored.modelSnapshotRef, "model-snapshot-a");
  assert.equal(stored.assessedAt, "2026-08-09T07:59:59.000Z");
  assert.equal(stored.recordedAt, "2026-08-09T08:00:00.000Z");
  assert.equal(stored.temporalSequence, 1);
});

test("accepts the closed BPS boundaries and rejects lossy legacy percentages", async () => {
  const assessments = repository();
  for (const [candidateId, closeProbabilityBps] of [
    ["candidate-zero", 0],
    ["candidate-certain", 10_000]
  ] as const) {
    const stored = await assessments.recordFromQualification({
      workspaceId: "workspace-a",
      candidateId,
      dealId: null,
      qualificationDecisionId: `qualification-${candidateId}`,
      qualificationDecisionVersion: "decision-v1",
      qualificationInputHash: `sha256:${closeProbabilityBps.toString(16).padStart(64, "0")}`,
      evidenceRefs: ["evidence-a"],
      ruleVersion: "qualification-rules.v2",
      modelSnapshotRef: null,
      financial: { closeProbabilityBps },
      assessedAt: "2026-08-09T07:59:59.000Z"
    });
    assert.equal(stored.closeProbabilityBps, closeProbabilityBps);
  }
  assert.throws(
    () => assertFormalProbabilityAssessment({
      source: "legacy_percent_precision",
      closeProbabilityPercent: 43
    }),
    (error: unknown) => (error as { code?: string }).code
      === "probability_assessment_v2_required"
  );
});

test("stable qualification replay is exactly once and workspace reads are closed", async () => {
  const assessments = repository();
  const input = {
    workspaceId: "workspace-a",
    candidateId: "candidate-a",
    dealId: null,
    qualificationDecisionId: "qualification-a",
    qualificationDecisionVersion: "decision-v1",
    qualificationInputHash: `sha256:${"b".repeat(64)}` as const,
    evidenceRefs: ["evidence-a"],
    ruleVersion: "qualification-rules.v2",
    modelSnapshotRef: null,
    financial: { closeProbabilityBps: 4_321 },
    assessedAt: "2026-08-09T07:59:59.000Z"
  };
  const first = await assessments.recordFromQualification(input);
  const replay = await assessments.recordFromQualification(input);
  assert.deepEqual(replay, first);
  assert.equal(
    await assessments.findCurrent("workspace-b", "candidate-a"),
    null
  );
  assert.equal(
    (await assessments.findCurrent("workspace-a", "candidate-a"))?.id,
    first.id
  );
});

test("stable qualification identity rejects a tampered probability payload", async () => {
  const assessments = repository();
  const original = probabilityRecordFixture({
    workspaceId: "workspace-a",
    candidateId: "candidate-a",
    qualificationDecisionId: "qualification-a",
    qualificationDecisionVersion: "decision-v1",
    inputSnapshotHash: `sha256:${"e".repeat(64)}`,
    closeProbabilityBps: 4_321
  });
  await assessments.append(original);
  await assert.rejects(
    assessments.append({ ...original, closeProbabilityBps: 4_300 }),
    (error: unknown) => (error as { code?: string }).code
      === "probability_assessment_identity_conflict"
  );
});

test("deal binding is one-way, barrier stamped, and idempotent", async () => {
  const assessments = repository();
  const original = await assessments.append(probabilityRecordFixture({
    workspaceId: "workspace-a",
    candidateId: "candidate-a",
    dealId: null
  }));
  const bound = await assessments.bindDeal(
    "workspace-a",
    original.id,
    "deal-a",
    `sha256:${"c".repeat(64)}`
  );
  assert.equal(bound.dealId, "deal-a");
  assert.equal(bound.temporalSequence, 2);
  assert.equal(
    (await assessments.findCurrent("workspace-a", "candidate-a", "deal-a"))?.id,
    original.id
  );
  assert.deepEqual(await assessments.bindDeal(
    "workspace-a",
    original.id,
    "deal-a",
    `sha256:${"c".repeat(64)}`
  ), bound);
  await assert.rejects(
    assessments.bindDeal(
      "workspace-a",
      original.id,
      "deal-b",
      `sha256:${"d".repeat(64)}`
    ),
    /probability_assessment_deal_already_bound/u
  );
});
