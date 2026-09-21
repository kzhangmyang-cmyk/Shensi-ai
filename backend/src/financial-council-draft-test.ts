import assert from "node:assert/strict";
import test from "node:test";
import {
  createFinancialCouncilDraft,
  financialCouncilDraftId,
  type FinancialCouncilDraftCreateInput
} from "./financial-council-draft.js";

const HASH = (character: string) =>
  `sha256:${character.repeat(64)}` as `sha256:${string}`;

function input(
  overrides: Partial<FinancialCouncilDraftCreateInput> = {}
): FinancialCouncilDraftCreateInput {
  return {
    workspaceId: "workspace-a",
    runId: "run-a",
    portfolioRevision: 2,
    actionId: HASH("a"),
    actionKind: "prepare_cash_reserve_budget",
    kind: "budget_adjustment_draft",
    approvalId: "approval-a",
    approvalHash: HASH("b"),
    portfolioOutputHash: HASH("c"),
    snapshotHash: HASH("d"),
    policyHash: HASH("e"),
    approvedAt: "2026-08-22T08:00:00.000Z",
    createdAt: "2026-08-22T08:00:00.000Z",
    lines: Object.freeze([
      { scenario: "conservative", amountMinor: 120_000 },
      { scenario: "base", amountMinor: 80_000 },
      { scenario: "optimistic", amountMinor: 20_000 }
    ]),
    ...overrides
  };
}

function withoutLines(
  overrides: Partial<FinancialCouncilDraftCreateInput>
): FinancialCouncilDraftCreateInput {
  const { lines: _lines, ...base } = input();
  return { ...base, ...overrides };
}

test("budget adjustment drafts have a stable semantic identity and preserve source hashes", () => {
  const first = createFinancialCouncilDraft(input());
  const replay = createFinancialCouncilDraft(input({
    createdAt: "2026-08-23T08:00:00.000Z"
  }));

  assert.equal(first.draftId, financialCouncilDraftId({
    workspaceId: "workspace-a", runId: "run-a", portfolioRevision: 2,
    actionId: HASH("a"), kind: "budget_adjustment_draft",
    approvalHash: HASH("b"), portfolioOutputHash: HASH("c")
  }));
  assert.equal(replay.draftId, first.draftId);
  assert.equal(first.approvalHash, HASH("b"));
  assert.equal(first.portfolioOutputHash, HASH("c"));
  assert.deepEqual(first.lines, [
    { scenario: "conservative", amountMinor: 120_000 },
    { scenario: "base", amountMinor: 80_000 },
    { scenario: "optimistic", amountMinor: 20_000 }
  ]);
});

test("draft identity binds the approved decision and frozen portfolio result", () => {
  const first = createFinancialCouncilDraft(input());
  const changedApproval = createFinancialCouncilDraft(input({
    approvalHash: HASH("f")
  }));
  const changedResult = createFinancialCouncilDraft(input({
    portfolioOutputHash: HASH("0")
  }));

  assert.notEqual(changedApproval.draftId, first.draftId);
  assert.notEqual(changedResult.draftId, first.draftId);
});

test("tax review task requires the exact professional-review disclaimer", () => {
  const valid = createFinancialCouncilDraft(withoutLines({
    actionId: HASH("f"), actionKind: "schedule_tax_review",
    kind: "tax_review_task", disclaimer: "需专业人员复核"
  }));
  assert.equal(valid.kind, "tax_review_task");

  assert.throws(
    () => createFinancialCouncilDraft(withoutLines({
      actionId: HASH("f"), actionKind: "schedule_tax_review",
      kind: "tax_review_task", disclaimer: "税务已合规"
    })),
    (error: unknown) => (error as { code?: string }).code
      === "financial_council_draft_invalid"
  );
});

test("draft domain rejects authority-write payloads and incompatible action mappings", () => {
  assert.throws(
    () => createFinancialCouncilDraft(input({
      kind: "finance_todo", actionKind: "prepare_cash_reserve_budget",
      lines: undefined, assigneeId: null,
      dueAt: "2026-08-29T08:00:00.000Z",
      payment: { amountMinor: 1 }
    } as unknown as FinancialCouncilDraftCreateInput)),
    (error: unknown) => (error as { code?: string }).code
      === "financial_council_draft_invalid"
  );
});
