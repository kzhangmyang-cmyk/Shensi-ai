import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AcquisitionDesktopInstallationService } from
  "./acquisition-desktop-installation-service.js";
import { InMemoryDesktopInstallationRepository } from
  "./acquisition-desktop-installation-repository.js";
import { AcquisitionMemoryTransactionCoordinator } from
  "./acquisition-memory-transaction-coordinator.js";
import { createAcquisitionOutreachActionAuthority } from
  "./acquisition-outreach-action-authority.js";
import { InMemoryAcquisitionOutreachBatchRepository } from
  "./acquisition-outreach-batch-repository.js";
import { InMemoryAcquisitionSocialAccountRepository } from
  "./acquisition-social-account-repository.js";
import { outreachContentHash, outreachDirectMessageApprovalHash,
  type AcquisitionOutreachAction, type AcquisitionOutreachBatch } from
  "./acquisition-outreach-batch.js";
import { AcquisitionDesktopOutreachSync } from
  "./acquisition-desktop-outreach-sync.js";
import { desktopOutreachReceiptHash } from "./acquisition-outreach-target-url.js";

const BASE = Date.parse("2026-08-25T00:00:00.000Z");
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const token = (character: string) => character.repeat(43);

function batch(): AcquisitionOutreachBatch {
  return {
    id: "batch-1", workspaceId: "workspace-1", runId: "run-1", planId: "plan-1",
    planVersionId: "plan-v1", planVersion: 1, planSnapshotHash: hash("plan"),
    policyVersionId: "policy-v1", policyHash: hash("policy"), accountId: "account-1",
    accountLoginStateVersion: 3, dailyBudgetId: "budget-1", localDate: "2026-08-25",
    timeZone: "UTC", dailyCandidateLimit: 50, dailyRemainingLimit: 48, revision: 1,
    etag: '"batch:1"', state: "approved", candidates: [], batchHash: hash("batch"),
    approvedBy: "operator", approvedAt: new Date(BASE).toISOString(),
    approvalHash: hash("approval"), rejectedBy: null, rejectedAt: null,
    rejectionReason: null, pauseReason: null, createdBy: "operator",
    createdAt: new Date(BASE).toISOString(), updatedBy: "operator",
    updatedAt: new Date(BASE).toISOString()
  };
}

function action(id = "comment-1", candidateId = "candidate-1",
  kind: "comment" | "direct_message" = "comment",
  predecessorActionId: string | null = null): AcquisitionOutreachAction {
  const content = kind === "comment" ? `exact comment ${candidateId}`
    : `exact message ${candidateId}`;
  return {
    id, workspaceId: "workspace-1", batchId: "batch-1", batchRevision: 1,
    candidateId, accountId: "account-1", accountLoginStateVersion: 3,
    policyVersionId: "policy-v1", localDate: "2026-08-25", kind,
    executionTarget: "desktop", sequence: kind === "comment" ? 1 : 2,
    status: kind === "comment" ? "queued" : "blocked_by_predecessor",
    predecessorActionId, targetPublicUrl: kind === "comment"
      ? `https://www.douyin.com/video/${candidateId}`
      : `https://www.douyin.com/user/${candidateId}`,
    content, contentHash: outreachContentHash(content), approvalHash: hash("approval"),
    createdAt: new Date(BASE).toISOString()
  };
}

function authorizedMessage(predecessor: AcquisitionOutreachAction, id = "message-1") {
  const base = batch();
  const value = action(id, predecessor.candidateId, "direct_message", predecessor.id);
  return { ...value, authorizationVersion: 2 as const, approvedBy: "operator",
    approvedAt: new Date(BASE).toISOString(), directMessageDailyLimit: 20,
    directMessageDailyOrdinal: 1,
    approvalHash: outreachDirectMessageApprovalHash({ authorizationVersion: 2,
      batchId: base.id, batchRevision: base.revision, batchHash: base.batchHash,
      commentApprovalHash: base.approvalHash!, candidateId: value.candidateId,
      accountId: base.accountId, accountLoginStateVersion: base.accountLoginStateVersion,
      targetPublicUrl: value.targetPublicUrl, directMessage: value.content,
      directMessageHash: value.contentHash, predecessorActionId: predecessor.id,
      predecessorReceiptReference: "receipt-comment-1", dailyLimit: 20,
      dailyOrdinal: 1, approvedBy: "operator", approvedAt: new Date(BASE).toISOString() }) };
}

async function fixture(actions: AcquisitionOutreachAction[] = [action()]) {
  let nowMs = BASE;
  let platformAllowed = true;
  const platformExecutionAccess = async () => platformAllowed;
  let authorityAllowed = true;
  const memoryTransactions = new AcquisitionMemoryTransactionCoordinator();
  const socialAccounts = new InMemoryAcquisitionSocialAccountRepository(memoryTransactions);
  const installations = new InMemoryDesktopInstallationRepository({ memoryTransactions,
    socialAccounts });
  const repository = new InMemoryAcquisitionOutreachBatchRepository({ memoryTransactions,
    platformExecutionAccess,
    socialAccounts, desktopInstallations: installations,
    desktopTaskTokenKey: Buffer.from("task-5-memory-token-key-is-at-least-32-bytes") });
  const installationId = token("A");
  const deviceIdHash = hash("desktop-device");
  await installations.createEnrollment({ workspaceId: "workspace-1", userId: "user-1",
    teamId: "team-1", deviceIdHash, protocolVersion: 1,
    enrollmentTokenHash: hash("enrollment"), idempotencyKeyHash: "1".repeat(64),
    requestHash: "2".repeat(64), expiresAt: "2026-08-25T00:01:00.000Z",
    createdAt: "2026-08-25T00:00:00.000Z", consumedAt: null });
  await installations.consumeEnrollment({ deviceIdHash,
    enrollmentTokenHash: hash("enrollment"), deviceCredentialHash: hash("credential"),
    protocolVersion: 1, consumedAt: "2026-08-25T00:00:00.001Z" });
  const accountHandle = `dyacct_${"a".repeat(64)}`;
  await socialAccounts.upsert({ id: "account-1", workspaceId: "workspace-1",
    platform: "douyin", accountHandle, upstreamSessionId: null, displayName: "Douyin",
    state: "active", loginStateVersion: 3, loginStateVersionHighWater: 3,
    executorMode: "desktop", executorDeviceIdHash: deviceIdHash,
    executorBindingGeneration: 4,
    executorLeaseExpiresAt: "2026-08-25T00:02:00.000Z", revision: 1,
    etag: '"account-v1"', lastValidatedAt: new Date(BASE).toISOString(),
    createdAt: new Date(BASE).toISOString(), updatedAt: new Date(BASE).toISOString() });
  const candidates = [...new Set(actions.map((item) => item.candidateId))].map((candidateId) => {
    const comment = actions.find((item) => item.candidateId === candidateId
      && item.kind === "comment");
    const directMessage = actions.find((item) => item.candidateId === candidateId
      && item.kind === "direct_message");
    const commentText = comment?.content ?? `exact comment ${candidateId}`;
    const messageText = directMessage?.content ?? `exact message ${candidateId}`;
    return { candidateId, selected: true, candidateRevision: 1,
      evidenceHashes: [hash(`evidence-${candidateId}`)], evidenceText: ["公开需求"],
      publicActorKey: `actor-${candidateId}`,
      publicProfileUrl: directMessage?.targetPublicUrl
        ?? `https://www.douyin.com/user/${candidateId}`,
      commentTargetPublicUrl: comment?.targetPublicUrl
        ?? `https://www.douyin.com/video/${candidateId}`,
      draftRevision: 1, comment: commentText, commentHash: outreachContentHash(commentText),
      directMessage: messageText, directMessageHash: outreachContentHash(messageText),
      rationaleCodes: ["evidence_grounded"], modelSnapshotId: "model-1",
      sourceModelSnapshotId: "model-1", contentHash: hash(`draft-${candidateId}`) };
  });
  const approved = { ...batch(), candidates };
  const draft = { ...approved, state: "awaiting_approval" as const,
    approvedBy: null, approvedAt: null, approvalHash: null };
  await repository.create({ workspaceId: draft.workspaceId, operation: "create",
    idempotencyKey: "desktop-create", requestHash: hash("desktop-create"), batch: draft });
  await repository.approve({ workspaceId: draft.workspaceId, batchId: draft.id,
    ifMatch: draft.etag, idempotencyKey: "desktop-approve",
    requestHash: hash("desktop-approve"), async build() {
      return { batch: approved, actions };
    } });
  const installationService = new AcquisitionDesktopInstallationService({
    repository: installations, secret: "task-5-installation-secret-is-long-enough",
    now: () => new Date(nowMs).toISOString(), isActiveMembership: async () => true
  });
  const calls: string[] = [];
  const sync = new AcquisitionDesktopOutreachSync({ repository,
    platformExecutionAccess,
    installationService: { async renewDesktopExecutor(...args) {
      calls.push("renew");
      return installationService.renewDesktopExecutor(...args);
    } },
    authority: { async resolve(value) { calls.push(`authority:${value.action.id}`);
      return authorityAllowed ? { accountHandle } : null; } },
    now: () => new Date(nowMs).toISOString(), actionDeadlineMs: 150_000,
    leaseDurationMs: 180_000
  });
  const principal = { workspaceId: "workspace-1", userId: "user-1", teamId: "team-1",
    deviceIdHash, protocolVersion: 1 as const };
  const claimInput = { processInstanceId: token("P"), idempotencyKey: "claim-key-1",
    availableAccounts: [{ accountId: "account-1", accountHandle,
      loginStateVersion: 3, bindingGeneration: 4 }] };
  return { sync, repository, installations, socialAccounts, memoryTransactions,
    installationService,
    principal, claimInput, calls, accountHandle, deviceIdHash,
    setPlatformAllowed(value: boolean) { platformAllowed = value; },
    setNow(value: number) { nowMs = value; },
    setAuthorityAllowed(value: boolean) { authorityAllowed = value; } };
}

function started(claim: Extract<Awaited<ReturnType<AcquisitionDesktopOutreachSync["claim"]>>,
  { kind: "claimed" }>, overrides: Record<string, unknown> = {}) {
  return { event: "started" as const, processInstanceId: token("P"),
    taskToken: claim.taskToken, leaseVersion: claim.task.leaseVersion,
    executorBindingGeneration: claim.task.executorBindingGeneration,
    loginStateVersion: claim.task.loginStateVersion,
    taskRequestHash: claim.task.taskRequestHash, idempotencyKey: "start-key-1",
    occurredAt: new Date(BASE + 1_000).toISOString(), ...overrides };
}

function receipt(claim: Extract<Awaited<ReturnType<AcquisitionDesktopOutreachSync["claim"]>>,
  { kind: "claimed" }>, failureCode: string | null = null,
  overrides: Record<string, unknown> = {}) {
  return { event: "receipt" as const, processInstanceId: token("P"),
    taskToken: claim.taskToken, leaseVersion: claim.task.leaseVersion,
    executorBindingGeneration: claim.task.executorBindingGeneration,
    loginStateVersion: claim.task.loginStateVersion,
    taskRequestHash: claim.task.taskRequestHash, idempotencyKey: "receipt-key-1",
    reconciliation: false,
    receipt: { actionId: claim.task.actionId,
      state: failureCode ? "failed" as const : "succeeded" as const,
      platformReceiptReference: failureCode ? null : "receipt-comment-1",
      occurredAt: new Date(BASE + 2_000).toISOString(), failureCode }, ...overrides };
}

test("sync renews exact binding and invokes the sole authority resolver before claim", async () => {
  const value = await fixture();
  const claimed = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claimed.kind, "claimed");
  assert.deepEqual(value.calls, ["renew", "authority:comment-1"]);

  const rejected = await fixture();
  const denied = new AcquisitionDesktopOutreachSync({
    repository: rejected.repository,
    installationService: { renewDesktopExecutor: async (...args) => {
      rejected.calls.push("renew");
      return new AcquisitionDesktopInstallationService({ repository: rejected.installations,
        secret: "task-5-installation-secret-is-long-enough", now: () => new Date(BASE).toISOString(),
        isActiveMembership: async () => true }).renewDesktopExecutor(...args);
    } }, authority: { async resolve(value) { rejected.calls.push(`authority:${value.action.id}`);
      return null; } }, now: () => new Date(BASE).toISOString(),
    actionDeadlineMs: 150_000, leaseDurationMs: 180_000
  });
  await assert.rejects(denied.claim(rejected.principal, rejected.claimInput),
    /desktop_outreach_claim_not_authorized/u);
  assert.equal((await rejected.repository.listActions("workspace-1", "batch-1"))?.[0]?.status,
    "queued", "authority rejection must not reserve or return a task");
});

test("an empty claim is resolved in one repository transaction without an authority preview", async () => {
  const accountHandle = `dyacct_${"a".repeat(64)}`;
  let claimCalls = 0;
  const repository = {
    async claimNextDesktopAction(_input: unknown, authorize: unknown) {
      claimCalls += 1;
      assert.equal(typeof authorize, "function");
      return { kind: "empty" as const,
        serverTime: new Date(BASE).toISOString(), retryAfterMs: 3_000,
        replayed: false };
    },
    async markDesktopActionStarted() { throw new Error("unexpected_start"); },
    async completeDesktopAction() { throw new Error("unexpected_receipt"); },
    async recoverDesktopAction() { throw new Error("unexpected_recovery"); }
  };
  const sync = new AcquisitionDesktopOutreachSync({
    repository,
    installationService: { async renewDesktopExecutor() {
      return { renewed: true } as never;
    } },
    authority: { async resolve() { throw new Error("unexpected_authority"); } },
    now: () => new Date(BASE).toISOString(), actionDeadlineMs: 150_000,
    leaseDurationMs: 180_000
  });
  const result = await sync.claim({ workspaceId: "workspace-1", userId: "user-1",
    teamId: "team-1", deviceIdHash: hash("desktop-device"), protocolVersion: 1 }, {
    processInstanceId: token("P"), idempotencyKey: "claim-race-key",
    availableAccounts: [{ accountId: "account-1", accountHandle,
      loginStateVersion: 3, bindingGeneration: 4 }]
  });
  assert.equal(result.kind, "empty");
  assert.equal(claimCalls, 1,
    "sync must not split authority preview from the locked claim transaction");
});

test("sync exposes stable claim failures and sanitizes unknown repository errors", async (t) => {
  const accountHandle = `dyacct_${"a".repeat(64)}`;
  for (const [repositoryMessage, expected] of [
    ["desktop_outreach_claim_not_authorized", "desktop_outreach_claim_not_authorized"],
    ["desktop_outreach_claim_idempotency_conflict",
      "desktop_outreach_claim_idempotency_conflict"],
    ["database leaked secret=credential", "desktop_outreach_claim_not_authorized"]
  ] as const) await t.test(expected, async () => {
    const repository = {
      async claimNextDesktopAction() { throw new Error(repositoryMessage); },
      async markDesktopActionStarted() { throw new Error("unexpected_start"); },
      async completeDesktopAction() { throw new Error("unexpected_receipt"); },
      async completeDesktopReconciliation() { throw new Error("unexpected_reconciliation"); },
      async recoverDesktopAction() { throw new Error("unexpected_recovery"); }
    };
    const sync = new AcquisitionDesktopOutreachSync({ repository,
      installationService: { async renewDesktopExecutor() { return {} as never; } },
      authority: { async resolve() { return { accountHandle }; } },
      now: () => new Date(BASE).toISOString(), actionDeadlineMs: 150_000,
      leaseDurationMs: 180_000 });
    await assert.rejects(sync.claim({ workspaceId: "workspace-1", userId: "user-1",
      teamId: "team-1", deviceIdHash: hash("device"), protocolVersion: 1 }, {
      processInstanceId: token("P"), idempotencyKey: "stable-claim-error-key",
      availableAccounts: [{ accountId: "account-1", accountHandle,
        loginStateVersion: 3, bindingGeneration: 4 }]
    }), (error: unknown) => error instanceof Error
      && error.name === "AcquisitionDesktopOutreachSyncError"
      && error.message === expected
      && !error.message.includes("credential"));
  });
});

test("locked claim authority shares eligibility and exact replay selection", async () => {
  const invalid = { ...action("invalid-first", "candidate-1"),
    createdAt: new Date(BASE - 1_000).toISOString(), contentHash: hash("drift") };
  const valid = action("valid-second", "candidate-2");
  const value = await fixture([invalid, valid]);
  const first = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(first.kind, "claimed"); if (first.kind !== "claimed") return;
  assert.equal(first.task.actionId, "valid-second");
  assert.deepEqual(value.calls, ["renew", "authority:valid-second"]);
  value.calls.length = 0;
  const replay = await value.sync.claim(value.principal, value.claimInput);
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.deepEqual(value.calls, ["renew", "authority:valid-second"],
    "claim replay must re-authorize its persisted original action");
  value.setAuthorityAllowed(false);
  await assert.rejects(value.sync.claim(value.principal, value.claimInput),
    /desktop_outreach_claim_not_authorized/u);
  const actions = await value.repository.listActions("workspace-1", "batch-1");
  assert.equal(actions?.find((item) => item.id === "valid-second")?.status, "claimed");
  assert.equal(actions?.find((item) => item.id === "invalid-first")?.status, "queued");
});

test("claim authority drift is checked inside the claim transaction with zero failed effects",
  async (t) => {
    for (const drift of ["candidate", "evidence", "dnc"] as const) {
      await t.test(drift, async () => {
        const value = await fixture();
        let candidate = { version: 1, status: "qualified",
          profile: { kind: "individual", publicActorKey: "actor-candidate-1",
            publicProfileUrl: "https://www.douyin.com/user/candidate-1" },
          evidenceIds: ["evidence-1"] };
        let evidence = { id: "evidence-1", contentHash: hash("evidence-candidate-1"),
          sourcePlatform: "douyin", provenance: { kind: "mediacrawler_public_record",
            sourceUrl: "https://www.douyin.com/video/candidate-1" } };
        let dnc = false;
        let enter!: () => void; let release!: () => void;
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        let block = true;
        const authority = createAcquisitionOutreachActionAuthority({
          findBatch: async () => { throw new Error("locked_batch_reread"); },
          listActions: async () => { throw new Error("locked_actions_reread"); },
          findAccount: async () => { throw new Error("locked_account_reread"); },
          findRun: async () => ({ ownerId: "owner-1", teamId: "team-1" }),
          findCrawlerJob: async () => ({ state: "succeeded", ingestionState: "succeeded",
            aliasGeneration: 1, projectedAliasGeneration: 1, planId: "plan-1",
            planVersionId: "plan-v1", planSnapshotHash: hash("plan"),
            policyVersionId: "policy-v1", policyHash: hash("policy"),
            accountId: "account-1", accountLoginStateVersion: 3,
            dailyBudgetId: "budget-1", localDate: "2026-08-25",
            dailyCandidateLimit: 50 } as never),
          listPolicyVersions: async () => [{ id: "policy-v1", policyHash: hash("policy"),
            schedule: { timeZone: "UTC" } }],
          findCandidate: async () => { throw new Error("plain_candidate_reread"); },
          findEvidence: async () => { throw new Error("plain_evidence_reread"); },
          hasDoNotContact: async () => { throw new Error("plain_dnc_reread"); },
          loadLockedCandidateAuthority: async () => {
            if (block) { block = false; enter(); await barrier; }
            if (dnc) return null;
            return { candidate: structuredClone(candidate) as never,
              evidence: [structuredClone(evidence) as never] };
          }
        });
        const sync = new AcquisitionDesktopOutreachSync({ repository: value.repository,
          installationService: value.installationService,
          authority, now: () => new Date(BASE).toISOString(),
          actionDeadlineMs: 150_000, leaseDurationMs: 180_000 });
        const beforeState = (value.repository as unknown as { state: {
          actionRuntime: Map<string, unknown> } }).state;
        const beforeRuntime = structuredClone([...beforeState.actionRuntime.entries()]);
        const pending = sync.claim(value.principal, value.claimInput);
        await entered;
        if (drift === "candidate") candidate = { ...candidate, version: 2 };
        if (drift === "evidence") evidence = { ...evidence, contentHash: hash("changed") };
        if (drift === "dnc") dnc = true;
        release();
        await assert.rejects(pending, /desktop_outreach_claim_not_authorized/u);
        const state = (value.repository as unknown as { state: {
          desktopClaimReplays: Map<string, unknown>; desktopAttempts: unknown[];
          actionRuntime: Map<string, unknown>; directMessageClaims: unknown[] } }).state;
        assert.equal(state.desktopClaimReplays.size, 0);
        assert.equal(state.desktopAttempts.length, 0);
        assert.deepEqual([...state.actionRuntime.entries()], beforeRuntime);
        assert.equal(state.directMessageClaims.length, 0);
        assert.equal((await value.repository.listActions("workspace-1", "batch-1"))
          ?.[0]?.status, "queued");

        candidate = { ...candidate, version: 1 };
        evidence = { ...evidence, contentHash: hash("evidence-candidate-1") };
        dnc = false;
        const retried = await sync.claim(value.principal, value.claimInput);
        assert.equal(retried.kind, "claimed");
        assert.equal(retried.replayed, false,
          "a rejected authorizer must not leave an empty or pending claim replay");
      });
    }
  });

test('platform freeze blocks claims and late starts while accepting an already started receipt', async () => {
  const value = await fixture();
  value.setPlatformAllowed(false);
  assert.equal((await value.sync.claim(value.principal, value.claimInput)).kind, 'empty');
  assert.equal((await value.repository.listActions('workspace-1', 'batch-1'))![0]!.status, 'queued');
  value.setPlatformAllowed(true);
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, 'claimed');
  if (claim.kind !== 'claimed') throw new Error('claim required');
  value.setPlatformAllowed(false);
  await assert.rejects(value.sync.complete(value.principal, claim.task.actionId, started(claim)),
    /desktop_outreach_completion_not_authorized/u);
  value.setPlatformAllowed(true);
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  value.setPlatformAllowed(false);
  const completed = await value.sync.complete(value.principal, claim.task.actionId, receipt(claim));
  assert.equal(completed.state, 'succeeded');
});

test("started is a single fenced 0 to 1 transition with exact replay", async () => {
  const value = await fixture();
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") return;
  const first = await value.sync.complete(value.principal, claim.task.actionId,
    started(claim));
  assert.deepEqual(first, { actionId: claim.task.actionId, state: "executing",
    replayed: false, accountPaused: false,
    occurredAt: new Date(BASE + 1_000).toISOString() });
  assert.deepEqual(await value.sync.complete(value.principal, claim.task.actionId,
    started(claim)), { ...first, replayed: true });
  await assert.rejects(value.sync.complete(value.principal, claim.task.actionId,
    started(claim, { occurredAt: new Date(BASE + 1_001).toISOString() })),
  /desktop_action_replay_conflict/u);
  assert.equal((await value.repository.listActions("workspace-1", "batch-1"))?.[0]?.status,
    "executing");
  const state = (value.repository as unknown as { state: {
    desktopAttempts: unknown[]; desktopCompletionReplays: Map<string, unknown> } }).state;
  assert.equal((state.desktopAttempts[0] as { platformWriteAttemptCount: number })
    .platformWriteAttemptCount, 1);
  const persisted = JSON.stringify({ attempts: state.desktopAttempts,
    replays: [...state.desktopCompletionReplays.entries()] });
  assert.equal(persisted.includes(claim.taskToken), false);
  assert.equal(persisted.includes(value.claimInput.processInstanceId), false);
  assert.equal(persisted.includes("start-key-1"), false);
});

test("started rejects expired and stale process token binding login task and fence", async (t) => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["process", { processInstanceId: token("Q") }, /desktop_outreach_completion_stale/u],
    ["token", { taskToken: token("T") }, /desktop_outreach_completion_stale/u],
    ["task hash", { taskRequestHash: "f".repeat(64) }, /desktop_outreach_completion_stale/u],
    ["fence", { leaseVersion: 99 }, /desktop_outreach_completion_stale/u]
  ];
  for (const [name, drift, expected] of cases) await t.test(name, async () => {
    const value = await fixture();
    const claim = await value.sync.claim(value.principal, value.claimInput);
    assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
    await assert.rejects(value.sync.complete(value.principal, claim.task.actionId,
      started(claim, drift)), expected);
  });
  const expired = await fixture();
  const claim = await expired.sync.claim(expired.principal, expired.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  expired.setNow(Date.parse(claim.task.leaseExpiresAt));
  await assert.rejects(expired.sync.complete(expired.principal, claim.task.actionId,
    started(claim)), /desktop_outreach_start_expired/u);

  for (const drift of ["device", "binding", "login", "binding-expiry"] as const) {
    await t.test(drift, async () => {
      const value = await fixture();
      const currentClaim = await value.sync.claim(value.principal, value.claimInput);
      assert.equal(currentClaim.kind, "claimed"); if (currentClaim.kind !== "claimed") return;
      let principal = value.principal;
      if (drift === "device") principal = { ...principal,
        deviceIdHash: hash("other-device") };
      else {
        const current = await value.socialAccounts.findById("workspace-1", "account-1");
        assert.ok(current);
        await value.memoryTransactions.transaction((tx) => {
          value.socialAccounts.setDesktopExecutorBindingRecord(tx, { ...current,
            ...(drift === "binding" ? {
              executorBindingGeneration: current.executorBindingGeneration + 1
            } : {}),
            ...(drift === "login" ? { loginStateVersion: current.loginStateVersion! + 1,
              loginStateVersionHighWater: current.loginStateVersionHighWater + 1 } : {}),
            ...(drift === "binding-expiry" ? {
              executorLeaseExpiresAt: new Date(BASE).toISOString()
            } : {}) });
        });
      }
      await assert.rejects(value.sync.complete(principal, currentClaim.task.actionId,
        started(currentClaim)), /desktop_outreach_completion_not_authorized/u);
    });
  }
});

test("the first valid receipt wins, replays exactly, and conflicts on changed evidence", async () => {
  const value = await fixture();
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  const first = await value.sync.complete(value.principal, claim.task.actionId, receipt(claim));
  assert.equal(first.state, "succeeded"); assert.equal(first.replayed, false);
  assert.deepEqual(await value.sync.complete(value.principal, claim.task.actionId,
    receipt(claim)), { ...first, replayed: true });
  assert.deepEqual(await value.sync.complete(value.principal, claim.task.actionId,
    receipt(claim, null, { idempotencyKey: "receipt-key-2" })), {
    ...first, replayed: true
  }, "the canonical first receipt replays under a new transport retry key");
  await assert.rejects(value.sync.complete(value.principal, claim.task.actionId,
    receipt(claim, null, { idempotencyKey: "receipt-key-3",
      receipt: { ...receipt(claim).receipt, platformReceiptReference: "changed-receipt" } })),
  /desktop_action_replay_conflict/u);
});

test("a first receipt requires an unexpired binding but a committed receipt remains replayable", async () => {
  const expiredBeforeFirst = await fixture();
  const firstClaim = await expiredBeforeFirst.sync.claim(expiredBeforeFirst.principal,
    expiredBeforeFirst.claimInput);
  assert.equal(firstClaim.kind, "claimed");
  if (firstClaim.kind !== "claimed") return;
  await expiredBeforeFirst.sync.complete(expiredBeforeFirst.principal,
    firstClaim.task.actionId, started(firstClaim));
  const firstBinding = await expiredBeforeFirst.socialAccounts.findById(
    "workspace-1", "account-1");
  assert.ok(firstBinding?.executorLeaseExpiresAt);
  expiredBeforeFirst.setNow(Date.parse(firstBinding.executorLeaseExpiresAt));
  await assert.rejects(expiredBeforeFirst.sync.complete(expiredBeforeFirst.principal,
    firstClaim.task.actionId, receipt(firstClaim)),
  /desktop_outreach_completion_not_authorized/u);
  assert.equal((await expiredBeforeFirst.repository.listActions("workspace-1", "batch-1"))
    ?.[0]?.status, "executing", "an expired first receipt must not mutate the action");
  await expiredBeforeFirst.memoryTransactions.transaction((tx) => {
    expiredBeforeFirst.socialAccounts.setDesktopExecutorBindingRecord(tx, {
      ...firstBinding,
      executorLeaseExpiresAt: new Date(Date.parse(firstBinding.executorLeaseExpiresAt!)
        + 90_000).toISOString()
    });
  });
  const acceptedAfterRenewal = await expiredBeforeFirst.sync.complete(
    expiredBeforeFirst.principal, firstClaim.task.actionId, receipt(firstClaim));
  assert.equal(acceptedAfterRenewal.state, "succeeded",
  "the rejected first receipt must not have written a replay record");
  assert.equal(acceptedAfterRenewal.replayed, false);

  const terminal = await fixture();
  const terminalClaim = await terminal.sync.claim(terminal.principal, terminal.claimInput);
  assert.equal(terminalClaim.kind, "claimed");
  if (terminalClaim.kind !== "claimed") return;
  await terminal.sync.complete(terminal.principal, terminalClaim.task.actionId,
    started(terminalClaim));
  const first = await terminal.sync.complete(terminal.principal,
    terminalClaim.task.actionId, receipt(terminalClaim));
  const terminalBinding = await terminal.socialAccounts.findById("workspace-1", "account-1");
  assert.ok(terminalBinding?.executorLeaseExpiresAt);
  terminal.setNow(Date.parse(terminalBinding.executorLeaseExpiresAt));
  assert.deepEqual(await terminal.sync.complete(terminal.principal,
    terminalClaim.task.actionId, receipt(terminalClaim)), { ...first, replayed: true });
  assert.deepEqual(await terminal.sync.complete(terminal.principal,
    terminalClaim.task.actionId,
    receipt(terminalClaim, null, { idempotencyKey: "receipt-after-expiry-key" })), {
    ...first, replayed: true
  });
  await assert.rejects(terminal.sync.complete(terminal.principal,
    terminalClaim.task.actionId, receipt(terminalClaim, null, {
      receipt: { ...receipt(terminalClaim).receipt,
        platformReceiptReference: "changed-after-expiry" }
    })), /desktop_action_replay_conflict/u);
  await assert.rejects(terminal.sync.complete(terminal.principal,
    terminalClaim.task.actionId, receipt(terminalClaim, null, {
      idempotencyKey: "changed-after-expiry-key",
      receipt: { ...receipt(terminalClaim).receipt,
        platformReceiptReference: "changed-new-key-after-expiry" }
    })), /desktop_action_replay_conflict/u);
});

test("Memory recomputes canonical receipt classification and request evidence", async () => {
  const value = await fixture();
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  const evidence = receipt(claim).receipt;
  const receiptHash = desktopOutreachReceiptHash({ action_id: evidence.actionId,
    failure_code: evidence.failureCode, occurred_at: evidence.occurredAt,
    platform_receipt_reference: evidence.platformReceiptReference,
    state: evidence.state }).hash;
  const repositoryInput = { workspaceId: value.principal.workspaceId,
    actionId: claim.task.actionId, deviceIdHash: value.principal.deviceIdHash,
    processInstanceIdHash: hash(value.claimInput.processInstanceId),
    taskTokenHash: hash(claim.taskToken), leaseVersion: claim.task.leaseVersion,
    executorBindingGeneration: claim.task.executorBindingGeneration,
    loginStateVersion: claim.task.loginStateVersion,
    taskRequestHash: claim.task.taskRequestHash, idempotencyKeyHash: "a".repeat(64),
    requestHash: "b".repeat(64), occurredAt: evidence.occurredAt,
    now: new Date(BASE + 2_000).toISOString(), reconciliation: false as const,
    receipt: evidence, receiptHash, stateEffect: "failed" as const };
  await assert.rejects(value.repository.completeDesktopAction(repositoryInput),
    /desktop_outreach_completion_stale/u,
  "a success receipt cannot be persisted with a caller-supplied failed effect");
  assert.equal((await value.repository.listActions("workspace-1", "batch-1"))?.[0]?.status,
    "executing");

  const first = await value.sync.complete(value.principal, claim.task.actionId,
    receipt(claim));
  assert.equal(first.state, "succeeded");
  await assert.rejects(value.repository.completeDesktopAction({ ...repositoryInput,
    idempotencyKeyHash: "c".repeat(64), requestHash: "d".repeat(64),
    stateEffect: "succeeded" }), /desktop_action_replay_conflict/u,
  "same receipt evidence with a different canonical command hash conflicts");
});

test("concurrent different receipts have one atomic first-valid winner", async () => {
  const value = await fixture();
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  const [winner, loser] = await Promise.allSettled([
    value.sync.complete(value.principal, claim.task.actionId, receipt(claim)),
    value.sync.complete(value.principal, claim.task.actionId,
      receipt(claim, "action_rejected", { idempotencyKey: "receipt-race-2" }))
  ]);
  assert.equal(winner.status, "fulfilled");
  assert.equal(loser.status, "rejected");
  if (loser.status === "rejected") assert.match(String(loser.reason),
    /desktop_action_replay_conflict/u);
  assert.equal((await value.repository.listActions("workspace-1", "batch-1"))?.[0]?.status,
    "succeeded");
});

test("an exact original receipt remains valid after expiry but authority drift rejects it", async (t) => {
  const late = await fixture();
  const claim = await late.sync.claim(late.principal, late.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await late.sync.complete(late.principal, claim.task.actionId, started(claim));
  const lateBinding = await late.socialAccounts.findById("workspace-1", "account-1");
  assert.ok(lateBinding);
  await late.memoryTransactions.transaction((tx) => {
    late.socialAccounts.setDesktopExecutorBindingRecord(tx, { ...lateBinding,
      executorLeaseExpiresAt: new Date(Date.parse(claim.task.leaseExpiresAt)
        + 90_000).toISOString() });
  });
  late.setNow(Date.parse(claim.task.leaseExpiresAt) + 1);
  assert.equal((await late.sync.complete(late.principal, claim.task.actionId,
    receipt(claim))).state, "succeeded");

  for (const drift of ["revoke", "handoff", "login"] as const) await t.test(drift, async () => {
    const value = await fixture();
    const currentClaim = await value.sync.claim(value.principal, value.claimInput);
    assert.equal(currentClaim.kind, "claimed"); if (currentClaim.kind !== "claimed") return;
    await value.sync.complete(value.principal, currentClaim.task.actionId, started(currentClaim));
    if (drift === "revoke") {
      await value.installations.revoke("workspace-1", value.deviceIdHash,
        new Date(BASE + 1_500).toISOString());
    } else {
      const current = await value.socialAccounts.findById("workspace-1", "account-1");
      assert.ok(current);
      await value.memoryTransactions.transaction((tx) => {
        value.socialAccounts.setDesktopExecutorBindingRecord(tx, { ...current,
          ...(drift === "handoff" ? { executorDeviceIdHash: hash("another-device"),
            executorBindingGeneration: current.executorBindingGeneration + 1 }
            : { loginStateVersion: current.loginStateVersion! + 1,
              loginStateVersionHighWater: current.loginStateVersionHighWater + 1 }) });
      });
    }
    await assert.rejects(value.sync.complete(value.principal, currentClaim.task.actionId,
      receipt(currentClaim)), /desktop_outreach_completion_not_authorized/u);
  });

  const taskDrift = await fixture();
  const driftClaim = await taskDrift.sync.claim(taskDrift.principal, taskDrift.claimInput);
  assert.equal(driftClaim.kind, "claimed"); if (driftClaim.kind !== "claimed") return;
  await taskDrift.sync.complete(taskDrift.principal, driftClaim.task.actionId,
    started(driftClaim));
  const state = (taskDrift.repository as unknown as { state: {
    actions: Map<string, AcquisitionOutreachAction[]> } }).state;
  state.actions.values().next().value![0]!.content = "mutated after execution";
  await assert.rejects(taskDrift.sync.complete(taskDrift.principal,
    driftClaim.task.actionId, receipt(driftClaim)),
  /desktop_outreach_completion_stale/u);
});

test("receipt classification has stable state effects", async (t) => {
  const cases: Array<[string | null, string]> = [
    [null, "succeeded"], ["action_rejected", "failed"],
    ["deadline_exceeded", "failed"],
    ["douyin_direct_message_unavailable", "failed"],
    ["douyin_action_control_missing", "failed"],
    ["douyin_action_control_ambiguous", "failed"],
    ["douyin_action_content_mismatch", "failed"],
    ["douyin_verification_required", "risk_paused"],
    ["douyin_rate_limited", "risk_paused"],
    ["douyin_account_warning", "risk_paused"],
    ["douyin_account_identity_changed", "risk_paused"],
    ["douyin_login_expired", "risk_paused"],
    ["action_unavailable", "reconciliation_required"],
    ["douyin_action_timeout", "reconciliation_required"],
    ["douyin_action_receipt_ambiguous", "reconciliation_required"],
    ["douyin_profile_busy", "queued"]
  ];
  for (const [failureCode, expected] of cases) await t.test(String(failureCode), async () => {
    const value = await fixture();
    const claim = await value.sync.claim(value.principal, value.claimInput);
    assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
    await value.sync.complete(value.principal, claim.task.actionId, started(claim));
    const result = await value.sync.complete(value.principal, claim.task.actionId,
      receipt(claim, failureCode));
    assert.equal(result.state, expected);
    assert.equal((await value.repository.listActions("workspace-1", "batch-1"))?.[0]?.status,
      expected);
  });
});

test("completion rejects non-taxonomy failure codes before repository writes", async (t) => {
  let writes = 0;
  const repository = {
    async claimNextDesktopAction() { throw new Error("unexpected_claim"); },
    async markDesktopActionStarted() { throw new Error("unexpected_start"); },
    async completeDesktopAction() {
      writes += 1;
      return { actionId: "comment-1", state: "failed" as const,
        replayed: false, accountPaused: false,
        occurredAt: new Date(BASE + 2_000).toISOString() };
    },
    async completeDesktopReconciliation() { throw new Error("unexpected_reconciliation"); },
    async recoverDesktopAction() { throw new Error("unexpected_recovery"); }
  };
  const sync = new AcquisitionDesktopOutreachSync({ repository,
    installationService: { async renewDesktopExecutor() {
      throw new Error("unexpected_renew");
    } }, authority: { async resolve() { throw new Error("unexpected_authority"); } },
    now: () => new Date(BASE + 2_000).toISOString(), actionDeadlineMs: 150_000,
    leaseDurationMs: 180_000
  });
  const base = { event: "receipt" as const, processInstanceId: token("P"),
    taskToken: token("T"), leaseVersion: 1, executorBindingGeneration: 1,
    loginStateVersion: 1, taskRequestHash: "a".repeat(64),
    idempotencyKey: "receipt-boundary-key", reconciliation: false as const };
  for (const failureCode of ["unknown_failure", "失败", "action_rejected\n",
    "a".repeat(81)]) await t.test(JSON.stringify(failureCode), async () => {
    await assert.rejects(sync.complete({ workspaceId: "workspace-1", userId: "user-1",
      teamId: "team-1", deviceIdHash: hash("device"), protocolVersion: 1 },
    "comment-1", { ...base, receipt: { actionId: "comment-1", state: "failed",
      platformReceiptReference: null, occurredAt: new Date(BASE + 2_000).toISOString(),
      failureCode } }), /invalid_desktop_outreach_completion/u);
  });
  assert.equal(writes, 0);
});

test("comment success releases only its exact direct-message successor once", async () => {
  const comment = action();
  const exact = authorizedMessage(comment);
  const unrelated = { ...authorizedMessage({ ...comment, id: "other-comment",
    candidateId: "candidate-2" }, "message-other"), candidateId: "candidate-2",
    predecessorActionId: "other-comment", targetPublicUrl: "https://www.douyin.com/user/candidate-2" };
  const value = await fixture([comment, exact, unrelated]);
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  await value.sync.complete(value.principal, claim.task.actionId, receipt(claim));
  const actions = await value.repository.listActions("workspace-1", "batch-1");
  assert.equal(actions?.find((item) => item.id === exact.id)?.status, "queued");
  assert.equal(actions?.find((item) => item.id === unrelated.id)?.status,
    "blocked_by_predecessor");

  const invalidSuccessor = { ...authorizedMessage(comment, "message-invalid"),
    approvalHash: hash("tampered-direct-message-approval") };
  const invalid = await fixture([comment, invalidSuccessor]);
  const invalidClaim = await invalid.sync.claim(invalid.principal, invalid.claimInput);
  assert.equal(invalidClaim.kind, "claimed"); if (invalidClaim.kind !== "claimed") return;
  await invalid.sync.complete(invalid.principal, invalidClaim.task.actionId,
    started(invalidClaim));
  await invalid.sync.complete(invalid.principal, invalidClaim.task.actionId,
    receipt(invalidClaim));
  assert.equal((await invalid.repository.listActions("workspace-1", "batch-1"))
    ?.find((item) => item.id === invalidSuccessor.id)?.status, "blocked_by_predecessor");
});

test("a deterministic comment failure closes only a frozen-authority exact successor",
  async (t) => {
  const comment = { ...action(), platformReceiptReference: "receipt-comment-1" };
  const exact = authorizedMessage(comment);
  const unrelated = authorizedMessage({ ...comment, id: "other-comment",
    candidateId: "candidate-2" }, "message-other");
  const value = await fixture([comment, exact, unrelated]);
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  await value.sync.complete(value.principal, claim.task.actionId,
    receipt(claim, "action_rejected"));

  const actions = await value.repository.listActions("workspace-1", "batch-1");
  const failedAt = new Date(BASE + 2_000).toISOString();
  assert.deepEqual(((value) => value && ({ status: value.status,
    failureCode: value.failureCode, occurredAt: value.occurredAt,
    platformReceiptReference: value.platformReceiptReference }))(
    actions?.find((item) => item.id === exact.id)), {
    status: "failed", failureCode: "predecessor_failed", occurredAt: failedAt,
    platformReceiptReference: null
  });
  assert.equal(actions?.find((item) => item.id === unrelated.id)?.status,
    "blocked_by_predecessor");

  const tampered = [
    { name: "approval hash", change: { approvalHash: hash("tampered-approval") } },
    { name: "content hash", change: { contentHash: hash("tampered-content") } },
    { name: "target", change: {
      targetPublicUrl: "https://www.douyin.com/user/tampered-candidate"
    } },
    { name: "login version", change: { accountLoginStateVersion: 4 } }
  ] satisfies Array<{ name: string; change: Partial<AcquisitionOutreachAction> }>;
  for (const value of tampered) await t.test(value.name, async () => {
    const invalidSuccessor = { ...authorizedMessage(comment), ...value.change };
    const invalid = await fixture([comment, invalidSuccessor]);
    const invalidClaim = await invalid.sync.claim(invalid.principal, invalid.claimInput);
    assert.equal(invalidClaim.kind, "claimed");
    if (invalidClaim.kind !== "claimed") return;
    await invalid.sync.complete(invalid.principal, invalidClaim.task.actionId,
      started(invalidClaim));
    await invalid.sync.complete(invalid.principal, invalidClaim.task.actionId,
      receipt(invalidClaim, "action_rejected"));
    assert.equal((await invalid.repository.listActions("workspace-1", "batch-1"))
      ?.find((item) => item.id === invalidSuccessor.id)?.status,
    "blocked_by_predecessor");
  });
});

test("completion inputs are closed and reject malformed secret-bearing values", async () => {
  const value = await fixture();
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  for (const malformed of [
    { ...started(claim), extra: true },
    { ...started(claim), taskToken: "short" },
    { ...started(claim), processInstanceId: "short" },
    { ...receipt(claim), receipt: { ...receipt(claim).receipt, extra: true } }
  ]) await assert.rejects(value.sync.complete(value.principal, claim.task.actionId,
    malformed as never), /invalid_desktop_outreach_completion/u);
});
