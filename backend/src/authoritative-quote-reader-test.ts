import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalFixture,
  managerDecisionContext,
  workspaceContextFixture
} from "./growth-quote-test-fixtures.js";
import { QuoteApprovalAsOfReader } from "./authoritative-quote-reader.js";

test("authority history is reduced by revision and terminal decisions clear current", async () => {
  const state = approvalFixture();
  await state.service.approve(managerDecisionContext(), state.formalVersion.id,
    { reason: "同意" });
  const cutoff = await state.cutoff("2026-08-10T00:00:00.000Z");
  const current = await state.dealReader.getAt(
    workspaceContextFixture("manager"), "deal-1", cutoff
  );
  assert.equal(current?.quoteVersionId, state.formalVersion.id);
  assert.equal(current?.authorityRevision, 2);
});

test("as-of approval and version evidence preserve frozen owner and values", async () => {
  const state = approvalFixture();
  const context = workspaceContextFixture("manager");
  const cutoff = await state.cutoff("2026-08-10T00:00:00.000Z");
  const pending = await state.approvalReader.listPendingAsOf(context, {
    cutoff,
    limit: 100
  });
  assert.deepEqual(pending.map((row) => row.quoteVersionId), [
    state.formalVersion.id
  ]);
  assert.equal(pending[0]?.salesOwnerActorId, "sales-a");
  assert.equal(pending[0]?.closeProbabilityBps, 4_321);

  const evidence = await state.versionReader.getAt(
    context,
    state.formalVersion.id,
    cutoff
  );
  assert.equal(evidence?.versionKind, "formal");
  assert.equal(evidence?.sourceDraftVersionId, state.draftVersion.id);
  assert.equal(evidence?.commercialBindingEvidence.dealId, "deal-1");
  assert.equal(Object.isFrozen(evidence?.commercialBindingEvidence), true);
});

test("token workspace mismatch fails closed", async () => {
  const state = approvalFixture();
  const cutoff = await state.cutoff("2026-08-10T00:00:00.000Z");
  await assert.rejects(
    state.versionReader.getAt(state.otherWorkspace, state.formalVersion.id,
      cutoff),
    (error: unknown) => (error as { code?: string }).code
      === "sealed_cutoff_workspace_mismatch"
  );
});

test("pending approval authority filters currency before applying its limit", async () => {
  const state = approvalFixture();
  const context = workspaceContextFixture("manager");
  const cutoff = await state.cutoff("2026-08-10T00:00:00.000Z");
  const approvals = Array.from({ length: 101 }, (_, index) => ({
    id: index === 100 ? "approval-target" : `approval-foreign-${index}`,
    workspaceId: context.workspaceId,
    quoteVersionId: index === 100 ? "version-target" : `version-foreign-${index}`,
    status: "pending" as const,
    approvalKind: "confirmation" as const,
    requiredCapabilities: ["quote.confirm"],
    triggeredRules: ["manager_confirmation"],
    pricingPolicyVersionId: "policy-1",
    policySnapshotHash: `sha256:${"a".repeat(64)}` as const,
    capabilityRegistryVersion: "growth-capabilities.v1",
    submittedBy: "sales-a",
    submittedAt: `2026-08-09T08:00:00.${String(index).padStart(3, "0")}Z`,
    decidedBy: null,
    decidedAt: null,
    reason: null
  }));
  const versions = new Map(approvals.map((approval, index) => [
    approval.quoteVersionId,
    {
      id: approval.quoteVersionId,
      workspaceId: context.workspaceId,
      quoteCaseId: `case-${index}`,
      version: 1,
      lifecycleRevision: 1,
      versionKind: "formal" as const,
      sourceDraftVersionId: `draft-${index}`,
      probabilityAssessmentSnapshot: {
        id: `assessment-${index}`,
        precision: "bps",
        closeProbabilityBps: 5_000
      },
      status: "submitted" as const,
      createdBy: "sales-a",
      createdAt: approval.submittedAt,
      effectiveAt: approval.submittedAt,
      recordedAt: approval.submittedAt,
      temporalSequence: index + 1,
      salesOwnerActorId: "sales-a",
      currency: index === 100 ? "CNY" : "USD",
      quotedAmountMinor: 100,
      estimatedGrossProfitMinor: 40,
      estimatedContributionMinor: 30,
      grossMarginBps: 4_000,
      commercialAmountHash: `sha256:${"b".repeat(64)}`
    }
  ]));
  const reader = new QuoteApprovalAsOfReader({
    async listApprovals() { return approvals; },
    async listApprovalEvents() { return []; },
    async listLifecycleEvents() { return []; },
    async getVersion(_workspaceId: string, versionId: string) {
      return versions.get(versionId) ?? null;
    }
  } as never);
  const pending = await reader.listPendingAsOf(context, {
    cutoff,
    limit: 100,
    currency: "CNY"
  } as never);
  assert.deepEqual(pending.map((row) => row.quoteVersionId), ["version-target"]);
  const legacy = await reader.listPendingAsOf(context, { cutoff, limit: 100 });
  assert.equal(legacy.length, 100);
  assert.deepEqual([
    legacy[0]?.quoteVersionId,
    legacy.at(-1)?.quoteVersionId
  ], ["version-foreign-0", "version-foreign-99"]);
});
