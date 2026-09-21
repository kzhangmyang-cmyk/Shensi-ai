import assert from "node:assert/strict";
import test from "node:test";
import {
  createFinancialCouncilDraft
} from "./financial-council-draft.js";
import {
  InMemoryFinancialCouncilDraftRepository
} from "./financial-council-draft-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const HASH = (character: string) =>
  `sha256:${character.repeat(64)}` as `sha256:${string}`;

const context: ActiveWorkspaceContext = Object.freeze({
  workspaceId: "workspace-a", kind: "team", actorId: "admin-a", role: "admin",
  teamId: "workspace-a", capabilities: Object.freeze([]),
  capabilityRegistryVersion: "growth-capabilities.v1"
});

function draft(
  approvalHash = HASH("b"),
  createdAt = "2026-08-22T08:00:00.000Z",
  snapshotHash = HASH("d")
) {
  return createFinancialCouncilDraft({
    workspaceId: "workspace-a", runId: "run-a", portfolioRevision: 2,
    actionId: HASH("a"), actionKind: "prepare_cash_reserve_budget",
    kind: "budget_adjustment_draft", approvalId: "approval-a", approvalHash,
    portfolioOutputHash: HASH("c"), snapshotHash, policyHash: HASH("e"),
    approvedAt: "2026-08-22T08:00:00.000Z", createdAt,
    lines: Object.freeze([
      { scenario: "conservative", amountMinor: 120_000 },
      { scenario: "base", amountMinor: 80_000 },
      { scenario: "optimistic", amountMinor: 20_000 }
    ])
  });
}

test("repository replays an exact semantic council draft without creating a second artifact", async () => {
  const repository = new InMemoryFinancialCouncilDraftRepository();
  const first = await repository.create(draft());
  const replay = await repository.create(draft(HASH("b"), "2026-08-23T08:00:00.000Z"));

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.draftId, first.value.draftId);
  assert.equal(replay.value.createdAt, first.value.createdAt);
});

test("repository rejects a conflicting draft under the same stable semantic identity", async () => {
  const repository = new InMemoryFinancialCouncilDraftRepository();
  await repository.create(draft());

  await assert.rejects(
    () => repository.create(draft(HASH("b"), "2026-08-22T08:00:00.000Z", HASH("f"))),
    (error: unknown) => (error as { code?: string }).code
      === "financial_council_draft_conflict"
  );
});

test("repository scopes lookups to the active workspace", async () => {
  const repository = new InMemoryFinancialCouncilDraftRepository();
  const created = await repository.create(draft());
  const foreign = { ...context, workspaceId: "workspace-b", teamId: "workspace-b" };

  assert.equal(await repository.findById(foreign, created.value.draftId), null);
});

test("repository probes and creates one council draft through a stable dispatch hash", async () => {
  const repository = new InMemoryFinancialCouncilDraftRepository();
  const dispatchHash = HASH("9");
  assert.equal(await repository.probeByDispatchHash(context, dispatchHash), null);

  const first = await repository.createFromApprovedDispatch({
    dispatchHash, draft: draft()
  });
  const replay = await repository.createFromApprovedDispatch({
    dispatchHash, draft: draft()
  });

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(await repository.probeByDispatchHash(context, dispatchHash), {
    resourceRefs: [{ kind: "financial_council_draft", id: draft().draftId }],
    contentHash: draft().contentHash
  });
});
