import assert from "node:assert/strict";
import test from "node:test";
import {
  FinancialCouncilApprovalProofIssuer,
  createFinancialCouncilApprovalRecord
} from "./financial-council-approval.js";
import {
  FinancialCouncilActionAdapter
} from "./financial-council-action-adapter.js";
import type { FinancialCouncilCandidateAction } from "./growth-contract-types.js";

const HASH = (character: string) =>
  `sha256:${character.repeat(64)}` as `sha256:${string}`;

function action(
  kind: FinancialCouncilCandidateAction["kind"] = "collect_receivable"
): FinancialCouncilCandidateAction {
  return Object.freeze({
    actionId: HASH("a"), kind, sourceFindingIds: Object.freeze(["finding-a"]),
    ownerRole: kind === "collect_receivable" ? "cashflow" : "finance",
    subjectRef: kind === "collect_receivable" ? "Customer A" : null,
    explanation: "closed action", durationDays: 7, prerequisites: Object.freeze([]),
    mutuallyExclusiveWith: Object.freeze([]),
    cashImpact: Object.freeze({ conservative: 0, base: 0, optimistic: 0 }),
    profitImpact: Object.freeze({ conservative: 0, base: 0, optimistic: 0 }),
    riskReductionBps: Object.freeze({ conservative: 0, base: 0, optimistic: 0 }),
    budgetCostMinor: 0, capacityUnits: 1, confidenceBps: 7_000,
    requiredCapabilities: Object.freeze([]), requiresHumanApproval: true
  });
}

async function fixture() {
  const approval = createFinancialCouncilApprovalRecord({
    workspaceId: "workspace-a", runId: "run-a", portfolioRevision: 2,
    portfolioKind: "balanced", approvedActionIds: [HASH("a")],
    approvedActionHashes: [{ actionId: HASH("a"), actionHash: HASH("0") }],
    requiredCapabilities: ["finance.council.approve"], approverId: "admin-a",
    portfolioOutputHash: HASH("b"), snapshotId: "snapshot-a", snapshotHash: HASH("c"),
    policyVersionId: "policy-a", policyHash: HASH("d"), sourceSetHash: HASH("e"),
    commandKeyHash: HASH("f"), commandRequestHash: HASH("1"), status: "approved",
    reason: null, approvedAt: "2026-08-22T08:00:00.000Z"
  });
  const proofs = new FinancialCouncilApprovalProofIssuer({
    async getApproval() { return approval; }
  });
  const proof = await proofs.issue({ workspaceId: "workspace-a", runId: "run-a",
    approvalId: approval.approvalId, actionId: HASH("a") });
  return { proof, proofs };
}

test("plain lookalike proof cannot create a council artifact", async () => {
  const { proof, proofs } = await fixture();
  const adapter = new FinancialCouncilActionAdapter({
    proofs,
    async resolveConditional() { throw new Error("should not resolve"); }
  });

  await assert.rejects(
    () => adapter.adapt({ workspaceId: "workspace-a", runId: "run-a",
      action: action(), approvalProof: { ...proof } }),
    (error: unknown) => (error as { code?: string }).code
      === "financial_council_approval_proof_invalid"
  );
});

test("collect receivable without an exact current customer binding becomes a council finance todo", async () => {
  const { proof, proofs } = await fixture();
  const adapter = new FinancialCouncilActionAdapter({
    proofs,
    async resolveConditional() { return { kind: "no_current_mapping" }; }
  });

  const result = await adapter.adapt({ workspaceId: "workspace-a", runId: "run-a",
    action: action(), approvalProof: proof });
  assert.equal(result.kind, "council_draft");
  assert.equal(result.draft.kind, "finance_todo");
  if (result.draft.kind === "finance_todo") {
    assert.equal(result.draft.assigneeId, null);
    assert.equal(result.draft.dueAt, "2026-08-29T08:00:00.000Z");
  }
});

test("adapter rejects an unsupported action kind before choosing any artifact", async () => {
  const { proof, proofs } = await fixture();
  const adapter = new FinancialCouncilActionAdapter({
    proofs,
    async resolveConditional() { return { kind: "no_current_mapping" }; }
  });

  await assert.rejects(
    () => adapter.adapt({ workspaceId: "workspace-a", runId: "run-a",
      action: { ...action(), kind: "wire_money" } as unknown as FinancialCouncilCandidateAction,
      approvalProof: proof }),
    (error: unknown) => (error as { code?: string }).code
      === "financial_council_action_adapter_invalid"
  );
});

test("data completion produces a council plan from an exact verified Growth gap reference", async () => {
  const { proof, proofs } = await fixture();
  const adapter = new FinancialCouncilActionAdapter({
    proofs,
    async resolveConditional() {
      return { kind: "data_completion_target", targetRef: {
        code: "unverified_cost", sourceType: "cost_entry", sourceId: "cost-a",
        sourceSnapshotHash: HASH("f"), cohortId: "cohort-a", currency: "CNY",
        asOf: "2026-08-22T08:00:00.000Z"
      } };
    }
  });

  const result = await adapter.adapt({ workspaceId: "workspace-a", runId: "run-a",
    action: action("complete_financial_data"), approvalProof: proof });
  assert.equal(result.kind, "council_draft");
  assert.equal(result.draft.kind, "data_completion_plan");
  if (result.draft.kind === "data_completion_plan") {
    assert.equal(result.draft.targetRef.sourceId, "cost-a");
  }
});

test("adapter does not turn a council action into a quote draft", async () => {
  const { proof, proofs } = await fixture();
  const adapter = new FinancialCouncilActionAdapter({
    proofs,
    async resolveConditional() {
      return { kind: "accepted_advisor_recommendation", input: {
        audienceRole: "manager", type: "quote_risk", summary: "bad",
        rationale: "bad", metricRefs: [], evidenceRefs: [], entityRefs: [],
        confidenceBps: 1, riskLevel: "low", assignedTo: null,
        dataAsOf: "2026-08-22T08:00:00.000Z", modelSnapshotRef: "model",
        promptVersion: "v1", generationIdempotencyKey: "bad",
        recommendedAction: {
          kind: "create_quote_draft", quoteCaseId: "quote-case-a",
          quoteCaseRevision: 1, quoteInput: {} as never, previewIdentity: {} as never
        }
      } };
    }
  });

  await assert.rejects(
    () => adapter.adapt({ workspaceId: "workspace-a", runId: "run-a",
      action: action(), approvalProof: proof }),
    (error: unknown) => (error as { code?: string }).code
      === "financial_council_action_adapter_invalid"
  );
});
