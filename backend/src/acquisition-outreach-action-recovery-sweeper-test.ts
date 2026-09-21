import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AcquisitionMemoryTransactionCoordinator } from
  "./acquisition-memory-transaction-coordinator.js";
import { InMemoryDesktopInstallationRepository } from
  "./acquisition-desktop-installation-repository.js";
import { AcquisitionOutreachActionRecoverySweeper } from
  "./acquisition-outreach-action-recovery-sweeper.js";
import {
  InMemoryAcquisitionOutreachBatchRepository,
  type DesktopOutreachClaimAuthorizer,
  type DesktopOutreachClaimResult,
  type DesktopOutreachReceiptRepositoryInput,
  type DesktopOutreachStartedRepositoryInput
} from "./acquisition-outreach-batch-repository.js";
import {
  outreachContentHash,
  type AcquisitionOutreachAction,
  type AcquisitionOutreachActionStatus,
  type AcquisitionOutreachBatch
} from "./acquisition-outreach-batch.js";
import { InMemoryAcquisitionSocialAccountRepository } from
  "./acquisition-social-account-repository.js";
import { desktopOutreachReceiptHash } from
  "./acquisition-outreach-target-url.js";

const BASE = Date.parse("2026-09-05T00:00:00.000Z");
const iso = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();
const bareHash = (value: string) => createHash("sha256")
  .update(value, "utf8").digest("hex");
const taggedHash = (value: string) => `sha256:${bareHash(value)}`;
const authorizeDesktopClaim: DesktopOutreachClaimAuthorizer = async (snapshot) =>
  snapshot.account.accountHandle
    ? { accountHandle: snapshot.account.accountHandle } : null;

interface Seed {
  workspaceId: string;
  batchId: string;
  accountId: string;
  actionId: string;
  candidateId: string;
  executionTarget: "desktop" | "server";
  status?: AcquisitionOutreachActionStatus;
  createdAtOffsetMs?: number;
}

function approvedBatch(seed: Seed): AcquisitionOutreachBatch {
  const content = `approved comment ${seed.actionId}`;
  const targetPublicUrl = `https://www.douyin.com/video/${seed.candidateId}`;
  return {
    id: seed.batchId,
    workspaceId: seed.workspaceId,
    runId: `run-${seed.batchId}`,
    planId: `plan-${seed.batchId}`,
    planVersionId: `plan-version-${seed.batchId}`,
    planVersion: 1,
    planSnapshotHash: taggedHash(`plan:${seed.batchId}`),
    policyVersionId: "policy-v1",
    policyHash: taggedHash("policy-v1"),
    accountId: seed.accountId,
    accountLoginStateVersion: 3,
    dailyBudgetId: `budget-${seed.batchId}`,
    localDate: "2026-09-05",
    timeZone: "UTC",
    dailyCandidateLimit: 50,
    dailyRemainingLimit: 49,
    revision: 1,
    etag: `"${seed.batchId}:1"`,
    state: "approved",
    candidates: [{
      candidateId: seed.candidateId,
      selected: true,
      candidateRevision: 1,
      evidenceHashes: [taggedHash(`evidence:${seed.candidateId}`)],
      evidenceText: ["public buying signal"],
      publicActorKey: `actor-${seed.candidateId}`,
      publicProfileUrl: `https://www.douyin.com/user/${seed.candidateId}`,
      commentTargetPublicUrl: targetPublicUrl,
      draftRevision: 1,
      comment: content,
      commentHash: outreachContentHash(content),
      directMessage: `approved message ${seed.actionId}`,
      directMessageHash: outreachContentHash(`approved message ${seed.actionId}`),
      rationaleCodes: ["evidence_grounded"],
      modelSnapshotId: "model-v1",
      sourceModelSnapshotId: "model-v1",
      contentHash: taggedHash(`draft:${seed.candidateId}`)
    }],
    batchHash: taggedHash(`batch:${seed.batchId}`),
    approvedBy: "operator-1",
    approvedAt: iso(0),
    approvalHash: taggedHash(`approval:${seed.batchId}`),
    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,
    pauseReason: null,
    createdBy: "operator-1",
    createdAt: iso(seed.createdAtOffsetMs ?? 0),
    updatedBy: "operator-1",
    updatedAt: iso(seed.createdAtOffsetMs ?? 0)
  };
}

function action(seed: Seed, batch: AcquisitionOutreachBatch): AcquisitionOutreachAction {
  const candidate = batch.candidates[0]!;
  return {
    id: seed.actionId,
    workspaceId: seed.workspaceId,
    batchId: seed.batchId,
    batchRevision: 1,
    candidateId: seed.candidateId,
    accountId: seed.accountId,
    accountLoginStateVersion: 3,
    policyVersionId: "policy-v1",
    localDate: "2026-09-05",
    kind: "comment",
    executionTarget: seed.executionTarget,
    sequence: 1,
    status: seed.status ?? "queued",
    predecessorActionId: null,
    targetPublicUrl: candidate.commentTargetPublicUrl,
    content: candidate.comment,
    contentHash: candidate.commentHash,
    approvalHash: batch.approvalHash!,
    createdAt: iso(seed.createdAtOffsetMs ?? 0),
    ...(seed.status === "succeeded" ? {
      platformReceiptReference: `douyin-comment:${seed.actionId}`,
      occurredAt: iso(1_000),
      failureCode: null
    } : {}),
    ...(seed.status === "failed" ? {
      platformReceiptReference: null,
      occurredAt: iso(1_000),
      failureCode: "douyin_action_rejected"
    } : {}),
    ...(seed.status === "risk_paused" ? {
      platformReceiptReference: null,
      occurredAt: iso(1_000),
      failureCode: "douyin_account_warning"
    } : {}),
    ...(seed.status === "reconciliation_required" ? {
      platformReceiptReference: null,
      occurredAt: iso(1_000),
      failureCode: "douyin_action_receipt_ambiguous"
    } : {})
  };
}

async function seedAction(repository: InMemoryAcquisitionOutreachBatchRepository,
  seed: Seed) {
  const approved = approvedBatch(seed);
  const draft: AcquisitionOutreachBatch = {
    ...approved,
    state: "awaiting_approval",
    approvedBy: null,
    approvedAt: null,
    approvalHash: null
  };
  await repository.create({
    workspaceId: seed.workspaceId,
    operation: `create:${seed.batchId}`,
    idempotencyKey: `create:${seed.batchId}`,
    requestHash: taggedHash(`create:${seed.batchId}`),
    batch: draft
  });
  await repository.approve({
    workspaceId: seed.workspaceId,
    batchId: seed.batchId,
    ifMatch: draft.etag,
    idempotencyKey: `approve:${seed.batchId}`,
    requestHash: taggedHash(`approve:${seed.batchId}`),
    async build() {
      return { batch: approved, actions: [action(seed, approved)] };
    }
  });
}

interface DesktopFixture {
  repository: InMemoryAcquisitionOutreachBatchRepository;
  deviceIdHash: string;
  processInstanceIdHash: string;
  accountHandle: string;
  bindingGeneration: number;
}

async function desktopFixture(seed: Seed): Promise<DesktopFixture> {
  const memoryTransactions = new AcquisitionMemoryTransactionCoordinator();
  const socialAccounts = new InMemoryAcquisitionSocialAccountRepository(
    memoryTransactions
  );
  const installations = new InMemoryDesktopInstallationRepository({
    memoryTransactions
  });
  const repository = new InMemoryAcquisitionOutreachBatchRepository({
    memoryTransactions,
    socialAccounts,
    desktopInstallations: installations,
    desktopTaskTokenKey: Buffer.from(
      "task-5-sweeper-memory-key-is-at-least-32-bytes"
    )
  });
  const deviceIdHash = taggedHash(`device:${seed.workspaceId}:${seed.accountId}`);
  const processInstanceIdHash = taggedHash("process:original");
  const accountHandle = `dyacct_${bareHash(`handle:${seed.accountId}`)}`;
  const bindingGeneration = 4;
  await installations.createEnrollment({
    workspaceId: seed.workspaceId,
    userId: "user-1",
    teamId: "team-1",
    deviceIdHash,
    protocolVersion: 1,
    enrollmentTokenHash: taggedHash("enrollment-token"),
    idempotencyKeyHash: bareHash("enrollment-idempotency"),
    requestHash: bareHash("enrollment-request"),
    expiresAt: iso(60_000),
    createdAt: iso(0),
    consumedAt: null
  });
  await installations.consumeEnrollment({
    deviceIdHash,
    enrollmentTokenHash: taggedHash("enrollment-token"),
    deviceCredentialHash: taggedHash("device-credential"),
    protocolVersion: 1,
    consumedAt: iso(1)
  });
  await socialAccounts.upsert({
    id: seed.accountId,
    workspaceId: seed.workspaceId,
    platform: "douyin",
    accountHandle,
    upstreamSessionId: null,
    displayName: "Douyin",
    state: "active",
    loginStateVersion: 3,
    loginStateVersionHighWater: 3,
    executorMode: "desktop",
    executorDeviceIdHash: deviceIdHash,
    executorBindingGeneration: bindingGeneration,
    executorLeaseExpiresAt: iso(86_400_000),
    revision: 1,
    etag: '"account:1"',
    lastValidatedAt: iso(0),
    createdAt: iso(0),
    updatedAt: iso(0)
  });
  await seedAction(repository, seed);
  return { repository, deviceIdHash, processInstanceIdHash, accountHandle,
    bindingGeneration };
}

function claimInput(fixture: DesktopFixture, seed: Seed, options: {
  nowOffsetMs?: number;
  processInstanceIdHash?: string;
  keySuffix?: string;
} = {}) {
  const nowOffsetMs = options.nowOffsetMs ?? 0;
  const suffix = options.keySuffix ?? "first";
  return {
    workspaceId: seed.workspaceId,
    deviceIdHash: fixture.deviceIdHash,
    processInstanceIdHash: options.processInstanceIdHash
      ?? fixture.processInstanceIdHash,
    availableAccounts: [{
      accountId: seed.accountId,
      accountHandle: fixture.accountHandle,
      loginStateVersion: 3,
      bindingGeneration: fixture.bindingGeneration
    }],
    idempotencyKeyHash: bareHash(`claim-idempotency:${suffix}`),
    claimRequestHash: bareHash(`claim-request:${suffix}`),
    now: iso(nowOffsetMs),
    actionDeadlineAt: iso(nowOffsetMs + 150_000),
    leaseDurationMs: 180_000
  };
}

function requireClaimed(result: DesktopOutreachClaimResult) {
  assert.equal(result.kind, "claimed");
  if (result.kind !== "claimed") throw new Error("expected desktop action claim");
  return result;
}

function startedInput(claim: ReturnType<typeof requireClaimed>, suffix = "start"):
DesktopOutreachStartedRepositoryInput {
  return {
    workspaceId: claim.task.workspaceId,
    actionId: claim.task.actionId,
    deviceIdHash: claim.fence.deviceIdHash,
    processInstanceIdHash: claim.fence.processInstanceIdHash,
    taskTokenHash: claim.fence.taskTokenHash,
    leaseVersion: claim.task.leaseVersion,
    executorBindingGeneration: claim.task.executorBindingGeneration,
    loginStateVersion: claim.task.loginStateVersion,
    taskRequestHash: claim.task.taskRequestHash,
    idempotencyKeyHash: bareHash(`start-idempotency:${suffix}`),
    requestHash: bareHash(`start-request:${suffix}`),
    occurredAt: iso(1_000),
    now: iso(1_000)
  };
}

async function oneAction(repository: InMemoryAcquisitionOutreachBatchRepository,
  seed: Pick<Seed, "workspaceId" | "batchId">) {
  const actions = await repository.listActions(seed.workspaceId, seed.batchId);
  assert.ok(actions);
  assert.equal(actions.length, 1);
  return actions[0]!;
}

test("an expired desktop claim with no platform-write attempt requeues without losing its fence", async () => {
  const target: Seed = {
    workspaceId: "workspace-a",
    batchId: "batch-claimed",
    accountId: "account-shared",
    actionId: "action-claimed",
    candidateId: "candidate-claimed",
    executionTarget: "desktop"
  };
  const fixture = await desktopFixture(target);
  const first = requireClaimed(await fixture.repository.claimNextDesktopAction(
    claimInput(fixture, target), authorizeDesktopClaim
  ));
  const sweeper = new AcquisitionOutreachActionRecoverySweeper({
    repository: fixture.repository,
    now: () => iso(180_001)
  });

  assert.equal(await sweeper.runOnce(), 1);
  assert.deepEqual(await oneAction(fixture.repository, target), {
    ...action(target, approvedBatch(target)),
    status: "queued",
    attemptCount: 1,
    platformReceiptReference: null,
    occurredAt: null,
    failureCode: null
  });
  assert.equal(await sweeper.runOnce(), 0, "the same expired fence is swept once");

  const reclaimed = requireClaimed(await fixture.repository.claimNextDesktopAction(
    claimInput(fixture, target, {
      nowOffsetMs: 180_001,
      processInstanceIdHash: taggedHash("process:replacement"),
      keySuffix: "replacement"
    }), authorizeDesktopClaim
  ));
  assert.equal(reclaimed.fence.fencingToken, first.fence.fencingToken + 1);
  assert.equal(reclaimed.task.taskRequestHash, first.task.taskRequestHash);
  assert.equal(reclaimed.fence.deviceIdHash, first.fence.deviceIdHash);
  assert.equal(reclaimed.fence.executorBindingGeneration,
    first.fence.executorBindingGeneration);
});

test("an expired started desktop action reconciles, preserves its original receipt fence, and harms no neighbor", async () => {
  const target: Seed = {
    workspaceId: "workspace-a",
    batchId: "batch-executing",
    accountId: "account-shared",
    actionId: "action-executing",
    candidateId: "candidate-executing",
    executionTarget: "desktop"
  };
  const sameAccount: Seed = {
    workspaceId: "workspace-a",
    batchId: "batch-same-account",
    accountId: "account-shared",
    actionId: "action-same-account",
    candidateId: "candidate-same-account",
    executionTarget: "desktop",
    createdAtOffsetMs: 10
  };
  const otherAccount: Seed = {
    workspaceId: "workspace-a",
    batchId: "batch-other-account",
    accountId: "account-other",
    actionId: "action-other-account",
    candidateId: "candidate-other-account",
    executionTarget: "desktop",
    createdAtOffsetMs: 20
  };
  const otherWorkspace: Seed = {
    workspaceId: "workspace-b",
    batchId: "batch-other-workspace",
    accountId: "account-shared",
    actionId: "action-other-workspace",
    candidateId: "candidate-other-workspace",
    executionTarget: "desktop",
    createdAtOffsetMs: 30
  };
  const fixture = await desktopFixture(target);
  await seedAction(fixture.repository, sameAccount);
  await seedAction(fixture.repository, otherAccount);
  await seedAction(fixture.repository, otherWorkspace);
  const claim = requireClaimed(await fixture.repository.claimNextDesktopAction(
    claimInput(fixture, target), authorizeDesktopClaim
  ));
  const start = startedInput(claim);

  assert.deepEqual(await fixture.repository.markDesktopActionStarted(start), {
    actionId: target.actionId,
    state: "executing",
    replayed: false,
    accountPaused: false,
    occurredAt: iso(1_000)
  });
  assert.deepEqual(await fixture.repository.markDesktopActionStarted(start), {
    actionId: target.actionId,
    state: "executing",
    replayed: true,
    accountPaused: false,
    occurredAt: iso(1_000)
  });
  assert.equal((await oneAction(fixture.repository, target)).status, "executing");

  const sweeper = new AcquisitionOutreachActionRecoverySweeper({
    repository: fixture.repository,
    now: () => iso(180_001)
  });
  assert.equal(await sweeper.runOnce(), 1);
  const reconciled = await oneAction(fixture.repository, target);
  assert.deepEqual({ status: reconciled.status, failureCode: reconciled.failureCode,
    occurredAt: reconciled.occurredAt }, {
    status: "reconciliation_required",
    failureCode: "douyin_action_receipt_ambiguous",
    occurredAt: iso(180_001)
  });
  assert.equal(await sweeper.runOnce(), 0, "a reconciled attempt is not swept twice");
  assert.equal((await oneAction(fixture.repository, sameAccount)).status, "queued");
  assert.equal((await oneAction(fixture.repository, otherAccount)).status, "queued");
  assert.equal((await oneAction(fixture.repository, otherWorkspace)).status, "queued");

  const receipt = {
    actionId: target.actionId,
    state: "succeeded" as const,
    platformReceiptReference: "douyin-comment:late-original-receipt",
    occurredAt: iso(180_002),
    failureCode: null
  };
  const completion: DesktopOutreachReceiptRepositoryInput = {
    ...start,
    idempotencyKeyHash: bareHash("late-receipt-idempotency"),
    requestHash: bareHash("late-receipt-request"),
    occurredAt: receipt.occurredAt,
    now: receipt.occurredAt,
    reconciliation: false,
    receipt,
    receiptHash: desktopOutreachReceiptHash({
      action_id: receipt.actionId,
      state: receipt.state,
      platform_receipt_reference: receipt.platformReceiptReference,
      occurred_at: receipt.occurredAt,
      failure_code: receipt.failureCode
    }).hash,
    stateEffect: "succeeded"
  };
  await assert.rejects(fixture.repository.completeDesktopAction({
    ...completion,
    receiptHash: bareHash("tampered-late-receipt")
  }), /desktop_outreach_completion_stale/u);
  assert.equal((await oneAction(fixture.repository, target)).status,
    "reconciliation_required");
  assert.deepEqual(await fixture.repository.completeDesktopAction(completion), {
    actionId: target.actionId,
    state: "succeeded",
    replayed: false,
    accountPaused: false,
    occurredAt: receipt.occurredAt
  });
  const succeeded = await oneAction(fixture.repository, target);
  assert.equal(succeeded.status, "succeeded");
  assert.equal(succeeded.platformReceiptReference,
    "douyin-comment:late-original-receipt");
});

test("terminal and already-reconciled desktop rows are stable across repeated sweeps", async () => {
  const repository = new InMemoryAcquisitionOutreachBatchRepository();
  const seeds: Seed[] = [
    ["succeeded", "terminal-success"],
    ["failed", "terminal-failure"],
    ["risk_paused", "terminal-risk"],
    ["reconciliation_required", "terminal-reconcile"]
  ].map(([status, suffix], index) => ({
    workspaceId: "workspace-terminal",
    batchId: `batch-${suffix}`,
    accountId: `account-${suffix}`,
    actionId: `action-${suffix}`,
    candidateId: `candidate-${suffix}`,
    executionTarget: "desktop" as const,
    status: status as AcquisitionOutreachActionStatus,
    createdAtOffsetMs: index
  }));
  for (const seed of seeds) await seedAction(repository, seed);
  const before = await Promise.all(seeds.map((seed) => oneAction(repository, seed)));
  const sweeper = new AcquisitionOutreachActionRecoverySweeper({
    repository,
    now: () => iso(999_999)
  });

  assert.equal(await sweeper.runOnce(), 0);
  assert.equal(await sweeper.runOnce(), 0);
  assert.deepEqual(
    await Promise.all(seeds.map((seed) => oneAction(repository, seed))),
    before
  );
});

test("an expired server execution retains legacy account risk-pausing without crossing tenant boundaries", async () => {
  const repository = new InMemoryAcquisitionOutreachBatchRepository();
  const target: Seed = {
    workspaceId: "workspace-server",
    batchId: "batch-server-executing",
    accountId: "account-server",
    actionId: "action-server-executing",
    candidateId: "candidate-server-executing",
    executionTarget: "server"
  };
  const sameAccount: Seed = {
    workspaceId: "workspace-server",
    batchId: "batch-server-neighbor",
    accountId: "account-server",
    actionId: "action-server-neighbor",
    candidateId: "candidate-server-neighbor",
    executionTarget: "server",
    createdAtOffsetMs: 10
  };
  const otherAccount: Seed = {
    workspaceId: "workspace-server",
    batchId: "batch-unrelated-account",
    accountId: "account-unrelated",
    actionId: "action-unrelated-account",
    candidateId: "candidate-unrelated-account",
    executionTarget: "server",
    createdAtOffsetMs: 20
  };
  const otherWorkspace: Seed = {
    workspaceId: "workspace-unrelated",
    batchId: "batch-unrelated-workspace",
    accountId: "account-server",
    actionId: "action-unrelated-workspace",
    candidateId: "candidate-unrelated-workspace",
    executionTarget: "server",
    createdAtOffsetMs: 30
  };
  for (const seed of [target, sameAccount, otherAccount, otherWorkspace]) {
    await seedAction(repository, seed);
  }
  const claim = await repository.claimNextAction({
    workerId: "legacy-server-worker",
    executionTarget: "server",
    now: iso(0),
    leaseDurationMs: 1_000
  });
  assert.equal(claim?.action.id, target.actionId);
  const sweeper = new AcquisitionOutreachActionRecoverySweeper({
    repository,
    now: () => iso(1_001)
  });

  assert.equal(await sweeper.runOnce(), 1);
  const paused = await oneAction(repository, target);
  assert.deepEqual({ status: paused.status, failureCode: paused.failureCode }, {
    status: "risk_paused",
    failureCode: "douyin_action_receipt_ambiguous"
  });
  const related = await oneAction(repository, sameAccount);
  assert.deepEqual({ status: related.status, failureCode: related.failureCode }, {
    status: "risk_paused",
    failureCode: "account_risk_paused"
  });
  assert.equal((await oneAction(repository, otherAccount)).status, "queued");
  assert.equal((await oneAction(repository, otherWorkspace)).status, "queued");
  assert.equal(await sweeper.runOnce(), 0);
});
