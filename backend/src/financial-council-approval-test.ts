import assert from "node:assert/strict";
import test from "node:test";
import {
  FinancialCouncilApprovalService,
  FinancialCouncilApprovalProofIssuer,
  createFinancialCouncilApprovalRecord,
  createFinancialCouncilDispatchOutboxRows
} from "./financial-council-approval.js";
import { financialCouncilCanonicalHash } from
  "./financial-council-domain.js";
import {
  InMemoryFinancialCouncilRepository,
  financialCouncilPortfolioCommandKeyHash
} from "./financial-council-repository.js";
import {
  command,
  storedActionPortfolioRevisionFixture,
  workspace
} from "./financial-council-repository-contract-test.js";
import { GROWTH_CAPABILITIES } from "./growth-capabilities.js";

const SHA = (character: string) =>
  `sha256:${character.repeat(64)}` as `sha256:${string}`;

function approvalInput() {
  return {
    workspaceId: "team-a",
    runId: "run-1",
    portfolioRevision: 2,
    portfolioKind: "balanced" as const,
    approvedActionIds: Object.freeze(["action-1", "action-2"]),
    approvedActionHashes: Object.freeze([
      { actionId: "action-1", actionHash: SHA("1") },
      { actionId: "action-2", actionHash: SHA("2") }
    ]),
    requiredCapabilities: Object.freeze([
      "finance.council.approve", "ledger.pending.create"
    ]),
    approverId: "admin-1",
    portfolioOutputHash: SHA("a"),
    snapshotId: "snapshot-1",
    snapshotHash: SHA("b"),
    policyVersionId: "policy-1",
    policyHash: SHA("c"),
    sourceSetHash: SHA("d"),
    commandKeyHash: SHA("e"),
    commandRequestHash: SHA("f"),
    status: "approved" as const,
    reason: null,
    approvedAt: "2026-08-16T10:00:00.000Z"
  };
}

test("approval freezes exact output hashes and creates one queued dispatch per action",
() => {
  const approval = createFinancialCouncilApprovalRecord(approvalInput());
  const rows = createFinancialCouncilDispatchOutboxRows(approval);
  const { approvalHash: _approvalHash, ...preimage } = approval;

  assert.equal(approval.approvalHash,
    financialCouncilCanonicalHash(preimage));
  assert.deepEqual(rows.map((row) => [row.actionId, row.status]), [
    ["action-1", "queued"], ["action-2", "queued"]
  ]);
  assert.equal(new Set(rows.map((row) => row.dispatchId)).size, 2);
  assert.ok(rows.every((row) => row.actionHash.startsWith("sha256:")
    && row.resultHash.startsWith("sha256:")));
  assert.equal(Object.isFrozen(approval), true);
  assert.equal(Object.isFrozen(rows), true);
});

test("an approval proof is action-specific, opaque, and reissuable after restart",
async () => {
  const approval = createFinancialCouncilApprovalRecord(approvalInput());
  const repository = {
    async getApproval() { return approval; }
  };
  const firstProcess = new FinancialCouncilApprovalProofIssuer(repository);
  const proof = await firstProcess.issue({
    workspaceId: "team-a", runId: "run-1", approvalId: approval.approvalId,
    actionId: "action-1"
  });

  assert.equal(firstProcess.verify(proof).actionId, "action-1");
  assert.throws(() => firstProcess.verify({ ...proof } as never),
    (error: unknown) => (error as { code?: unknown }).code
      === "financial_council_approval_proof_invalid");

  const restarted = new FinancialCouncilApprovalProofIssuer(repository);
  assert.throws(() => restarted.verify(proof),
    (error: unknown) => (error as { code?: unknown }).code
      === "financial_council_approval_proof_invalid");
  const reissued = await restarted.issue({
    workspaceId: "team-a", runId: "run-1", approvalId: approval.approvalId,
    actionId: "action-1"
  });
  assert.equal(restarted.verify(reissued).approvalHash, approval.approvalHash);
  await assert.rejects(restarted.issue({
    workspaceId: "team-a", runId: "run-1", approvalId: approval.approvalId,
    actionId: "not-approved"
  }), (error: unknown) => (error as { code?: unknown }).code
      === "financial_council_approval_proof_invalid");
});

test("memory approval and its outbox commit atomically and replay exactly",
async () => {
  const repository = new InMemoryFinancialCouncilRepository();
  const { run, revision, action } =
    await storedActionPortfolioRevisionFixture(repository);
  const approvalCommand = command("approve-1", "ws-1", run.revision,
    SHA("9"));
  const portfolio = revision.portfolios.find((row) =>
    row.kind === "balanced")!;
  const approval = createFinancialCouncilApprovalRecord({
    workspaceId: run.workspaceId,
    runId: run.runId,
    portfolioRevision: revision.revision,
    portfolioKind: "balanced",
    approvedActionIds: portfolio.actionIds,
    approvedActionHashes: Object.freeze([{
      actionId: action.actionId,
      actionHash: financialCouncilCanonicalHash(action)
    }]),
    requiredCapabilities: Object.freeze([...new Set([
      "finance.council.approve", ...portfolio.requiredApprovalCapabilities
    ])]),
    approverId: approvalCommand.actorId,
    portfolioOutputHash: financialCouncilCanonicalHash(portfolio),
    snapshotId: revision.snapshotId,
    snapshotHash: revision.snapshotHash,
    policyVersionId: revision.policyVersionId,
    policyHash: revision.policyHash,
    sourceSetHash: SHA("8"),
    commandKeyHash: financialCouncilPortfolioCommandKeyHash(approvalCommand),
    commandRequestHash: approvalCommand.requestHash as `sha256:${string}`,
    status: "approved",
    reason: null,
    approvedAt: "2026-08-16T08:08:00.000Z"
  });
  const outbox = createFinancialCouncilDispatchOutboxRows(approval);

  await assert.rejects(repository.commitApprovalDecision(approvalCommand, {
    approval, outbox: Object.freeze([]), verifiedTemporalSequence: 0
  }), (error: unknown) => (error as { code?: unknown }).code
      === "financial_council_input_invalid");
  assert.equal((await repository.findRun(
    workspace(), run.runId
  ))?.status, "awaiting_approval");
  assert.equal((await repository.listDispatchOutbox(
    workspace(), run.runId
  )).length, 0);

  const first = await repository.commitApprovalDecision(approvalCommand, {
    approval, outbox, verifiedTemporalSequence: 0
  });
  const replay = await repository.commitApprovalDecision(approvalCommand, {
    approval, outbox, verifiedTemporalSequence: 0
  });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal((await repository.findRun(
    workspace(), run.runId
  ))?.status, "approved");
  assert.deepEqual(await repository.getApproval(
    workspace(), approval.approvalId
  ), approval);
  assert.deepEqual(await repository.listDispatchOutbox(
    workspace(), run.runId
  ), outbox);
});

test("approval service reauthorizes current capabilities and rejects caller authority",
async () => {
  const repository = new InMemoryFinancialCouncilRepository();
  const { run, revision } = await storedActionPortfolioRevisionFixture(
    repository
  );
  let sourceChecks = 0;
  const service = new FinancialCouncilApprovalService({
    repository,
    policyRepository: {
      async findActive() {
        return { policyVersionId: revision.policyVersionId,
          policyHash: revision.policyHash };
      }
    } as never,
    sourceVerifier: {
      async verifyCurrentSources() {
        sourceChecks += 1;
        return {
          workspaceId: run.workspaceId,
          verifiedAt: "2026-08-16T08:08:00.000Z",
          temporalSequence: 0,
          sourceSetHash: SHA("8"),
          bindingRevision: "binding-2"
        };
      }
    } as never,
    now: () => "2026-08-16T08:08:00.000Z"
  });
  const base = command("service-approve", "ws-1", run.revision, SHA("6"));
  const authorized = Object.freeze({
    ...base,
    workspace: Object.freeze({ ...base.workspace,
      role: "admin" as const,
      capabilities: GROWTH_CAPABILITIES })
  });

  await assert.rejects(service.approve({
    ...authorized,
    workspace: { ...authorized.workspace, capabilities: [] }
  }, { runId: run.runId, portfolioRevision: 1,
    portfolioKind: "balanced" }),
  (error: unknown) => (error as { code?: unknown }).code
    === "capability_forbidden");
  await assert.rejects(service.approve(authorized, {
    runId: run.runId, portfolioRevision: 1, portfolioKind: "balanced",
    approverId: "forged", approvedAt: "2020-01-01T00:00:00.000Z"
  } as never), (error: unknown) => (error as { code?: unknown }).code
      === "financial_council_approval_invalid");

  const first = await service.approve(authorized, {
    runId: run.runId, portfolioRevision: 1, portfolioKind: "balanced"
  });
  const replay = await service.approve(authorized, {
    runId: run.runId, portfolioRevision: 1, portfolioKind: "balanced"
  });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(first.value.approverId, authorized.actorId);
  assert.equal(first.value.approvedAt, "2026-08-16T08:08:00.000Z");
  assert.equal(sourceChecks, 1);
});
