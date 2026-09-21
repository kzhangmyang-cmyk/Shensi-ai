import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryAcquisitionOutreachBatchRepository
} from "./acquisition-outreach-batch-repository.js";
import {
  AcquisitionOutreachBatchService,
  AcquisitionOutreachBatchError
} from "./acquisition-outreach-batch-service.js";
import {
  outreachBatchEtag,
  outreachBatchHash,
  outreachContentHash,
  outreachApprovalHash,
  outreachDirectMessageApprovalHash,
  parseAcquisitionOutreachAction,
  validOutreachTarget,
  type AcquisitionOutreachAction,
  type AcquisitionOutreachBatch
} from "./acquisition-outreach-batch.js";
import { AcquisitionMemoryTransactionCoordinator } from "./acquisition-memory-transaction-coordinator.js";
import { InMemoryAcquisitionDomainRepository } from "./acquisition-domain-repository.js";
import { InMemoryAcquisitionPlanRunRepository } from "./acquisition-plan-run-repository.js";
import { InMemoryAcquisitionDouyinCrawlerIngestionRepository } from "./acquisition-douyin-crawler-ingestion-repository.js";
import { InMemoryAcquisitionOutreachDraftFinalAuthority } from "./acquisition-outreach-draft-authority.js";
import { douyinDoNotContactIdentityHash } from "./acquisition-douyin-crawler-ingestion.js";
import { InMemoryAcquisitionSocialAccountRepository } from
  "./acquisition-social-account-repository.js";
import { InMemoryDesktopInstallationRepository } from
  "./acquisition-desktop-installation-repository.js";
import { AcquisitionDesktopInstallationService } from
  "./acquisition-desktop-installation-service.js";
import { desktopInstallationIdHash } from "./acquisition-desktop-installation.js";
import { InMemoryAcquisitionCrawlerJobRepository } from
  "./acquisition-crawler-job-repository.js";
import { crawlerOutreachFinalizationState, normalizedDouyinContentHash } from
  "./acquisition-crawler-job.js";

const scope = { workspaceId: "workspace-1", ownerId: "owner-1", teamId: "team-1", actorId: "approver-1" };
const now = "2026-08-25T02:00:00.000Z";
const evidenceHash = `sha256:${"a".repeat(64)}`;
const draftHash = `sha256:${"b".repeat(64)}`;

function fixture(options: {
  dailyLimit?: number;
  onGenerateDraft?: () => void;
  failActionInsertAt?: number;
  failDirectMessageActionInsertAt?: number;
  douyinOutreachActionsEnabled?: boolean;
  executionTarget?: "server" | "desktop";
  accountExecutorMode?: "desktop" | "server" | null;
  accountExecutorDeviceIdHash?: string | null;
  accountExecutorBindingGeneration?: number;
  accountExecutorLeaseExpiresAt?: string | null;
  serverExecutionEnabled?: boolean;
  desktopExecutionEnabled?: boolean;
  memoryTransactions?: AcquisitionMemoryTransactionCoordinator;
  commentTargetPublicUrl?: string;
  publicProfileUrl?: string;
  candidateIds?: string[];
  directMessageDailyOrdinals?: number[];
  onApproveDirectMessages?: (input: unknown) => void;
  useRepositoryDirectMessagePersistence?: boolean;
  mutateDirectMessageBuild?: (actions: AcquisitionOutreachAction[]) => AcquisitionOutreachAction[];
  mutateDirectMessageBuilderInputs?: (batch: AcquisitionOutreachBatch,
    predecessors: readonly AcquisitionOutreachAction[]) => void;
  initialNow?: string;
  runLocalDates?: Readonly<Record<string, string>>;
  reconcileAction?: (input: {
    actionId: string; accountHandle: string; loginStateVersion: number;
    kind: "comment" | "direct_message"; targetPublicUrl: string;
    content: string; approvedContentHash: string; deadlineAt: string;
  }) => Promise<{ actionId: string; state: "succeeded" | "failed";
    platformReceiptReference: string | null; occurredAt: string;
    failureCode: string | null }>;
} = {}) {
  const repository = new InMemoryAcquisitionOutreachBatchRepository({
    failActionInsertAt: options.failActionInsertAt,
    failDirectMessageActionInsertAt: options.failDirectMessageActionInsertAt,
    memoryTransactions: options.memoryTransactions
  });
  let candidateRevision = 1;
  let dnc = false;
  let accountVersion = 3;
  let accountState = "active";
  let accountExecutorMode = options.accountExecutorMode ?? null;
  let accountExecutorDeviceIdHash = options.accountExecutorDeviceIdHash ?? null;
  let accountExecutorBindingGeneration = options.accountExecutorBindingGeneration ?? 0;
  let accountExecutorLeaseExpiresAt = options.accountExecutorLeaseExpiresAt ?? null;
  let finalizationState: "pending" | "ready" | "unavailable" = "ready";
  let currentNow = options.initialNow ?? now;
  let commentTargetPublicUrl = options.commentTargetPublicUrl
    ?? "https://www.douyin.com/video/video-1";
  const service = new AcquisitionOutreachBatchService({
    repository,
    douyinOutreachActionsEnabled:
      options.douyinOutreachActionsEnabled ?? true,
    serverExecutionEnabled: options.serverExecutionEnabled ?? true,
    desktopExecutionEnabled: options.desktopExecutionEnabled ?? true,
    idFactory: (kind) => `${kind}-${crypto.randomUUID()}`,
    now: () => currentNow,
    loadRunAuthority: async (requestedScope, runId) => {
      const runLocalDate = options.runLocalDates?.[runId]
        ?? (runId === "run-1" ? "2026-08-25" : null);
      if (requestedScope.workspaceId !== scope.workspaceId || !runLocalDate) return null;
      return {
        workspaceId: scope.workspaceId, runId, planId: "plan-1",
        planVersionId: "plan-version-2", planVersion: 2,
        planSnapshotHash: `sha256:${"1".repeat(64)}`,
        policyVersionId: "policy-9", policyHash: `sha256:${"2".repeat(64)}`,
        accountId: "account-1", accountLoginStateVersion: 3,
        dailyBudgetId: `sha256:${"3".repeat(64)}`, localDate: runLocalDate,
        timeZone: "UTC",
        dailyCandidateLimit: options.dailyLimit ?? 50,
        finalizationState
      };
    },
    listRunCandidateIds: async () => options.candidateIds ?? ["candidate-1"],
    generateDraft: async (_requestedScope, candidateId) => {
      options.onGenerateDraft?.();
      return ({
      candidateId, candidateRevision, evidenceHashes: [evidenceHash],
      comment: "看到你公开提到需要获客方案",
      directMessage: "根据你公开提到需要获客方案，如你愿意，可交流公开场景里的思路",
      rationaleCodes: ["evidence_grounded"], modelSnapshotId: "model-job-1",
      contentHash: draftHash
    }); },
    loadCandidateAuthority: async (_requestedScope, candidateId) => ({
      candidateId, candidateRevision, evidenceHashes: [evidenceHash],
      evidenceText: ["需要获客方案"], publicActorKey: "actor-hash-1", doNotContact: dnc
      , publicProfileUrl: options.publicProfileUrl
        ?? "https://www.douyin.com/user/actor-1",
      commentTargetPublicUrl
    }),
    loadAccountAuthority: async () => ({
      accountId: "account-1", state: accountState, loginStateVersion: accountVersion,
      accountHandle: `dyacct_${"d".repeat(64)}`, displayName: "测试抖音账号",
      executorMode: accountExecutorMode,
      executorDeviceIdHash: accountExecutorDeviceIdHash,
      executorBindingGeneration: accountExecutorBindingGeneration,
      executorLeaseExpiresAt: accountExecutorLeaseExpiresAt
    }),
    approveDirectMessages: options.useRepositoryDirectMessagePersistence
      ? (input) => repository.approveDirectMessages({ ...input,
        build: async (batch, predecessors, ordinals, dailyLocalDate) => {
          options.mutateDirectMessageBuilderInputs?.(batch, predecessors);
          const built = await input.build(batch, predecessors, ordinals, dailyLocalDate);
          return { ...built, actions: options.mutateDirectMessageBuild
            ? options.mutateDirectMessageBuild(built.actions)
            : built.actions };
        } })
      : options.onApproveDirectMessages
      ? async (input) => {
        const batch = await repository.find(scope.workspaceId, input.batchId);
        if (!batch) throw new Error("missing batch");
        const actions = await repository.listActions(scope.workspaceId, input.batchId) ?? [];
        const built = await input.build(batch, actions,
          options.directMessageDailyOrdinals ?? [1], input.approvedAt.slice(0, 10));
        options.onApproveDirectMessages?.({ input, built });
        return { kind: "created" as const, value: built.batch };
      }
      : undefined,
    reconcileAction: options.reconcileAction
  });
  return {
    repository, service,
    setCandidateRevision: (value: number) => { candidateRevision = value; },
    setDnc: (value: boolean) => { dnc = value; },
    setAccountVersion: (value: number) => { accountVersion = value; },
    setAccountState: (value: string) => { accountState = value; },
    setAccountExecutor: (value: { mode: "desktop" | "server" | null;
      deviceIdHash: string | null; generation: number; leaseExpiresAt: string | null }) => {
      accountExecutorMode = value.mode;
      accountExecutorDeviceIdHash = value.deviceIdHash;
      accountExecutorBindingGeneration = value.generation;
      accountExecutorLeaseExpiresAt = value.leaseExpiresAt;
    },
    setFinalizationState: (
      value: "pending" | "ready" | "unavailable"
    ) => { finalizationState = value; },
    setNow: (value: string) => { currentNow = value; },
    setCommentTargetPublicUrl: (value: string) => { commentTargetPublicUrl = value; }
  };
}

async function created(value = fixture()) {
  const result = await value.service.create(scope, "run-1", "create-key-0001", {
    candidateIds: ["candidate-1"]
  });
  return { value, batch: result.value };
}

test("independent v3 DM approves edited content without a comment and keeps the batch awaiting approval", async () => {
  const { value, batch } = await created(fixture({ useRepositoryDirectMessagePersistence: true }));
  value.setAccountVersion(4);
  const result = await value.service.approveDirectMessages(scope, batch.id,
    batch.etag, "independent-dm-key-1", {
      batchRevision: batch.revision, batchHash: batch.batchHash,
      accountLoginStateVersion: 4, dailyLimit: 20, confirm: true,
      candidates: [{ candidateId: "candidate-1", directMessage: "独立编辑后确认的私信" }]
    });
  assert.deepEqual(result.value, batch);
  assert.equal(result.value.state, "awaiting_approval");
  assert.equal(result.value.accountLoginStateVersion, 3);
  const actions = await value.repository.listActions(scope.workspaceId, batch.id);
  assert.equal(actions?.length, 1);
  assert.equal(actions?.[0]?.kind, "direct_message");
  assert.equal(actions?.[0]?.authorizationVersion, 3);
  assert.equal(actions?.[0]?.predecessorActionId, null);
  assert.equal(actions?.[0]?.accountLoginStateVersion, 4);
  assert.equal(actions?.[0]?.content, "独立编辑后确认的私信");
  assert.equal(actions?.[0]?.contentHash, outreachContentHash("独立编辑后确认的私信"));
});

test("independent DM rejects a changed sender login and still enforces do-not-contact", async () => {
  const { value, batch } = await created(fixture({ useRepositoryDirectMessagePersistence: true }));
  const input = { batchRevision: batch.revision, batchHash: batch.batchHash,
    accountLoginStateVersion: 3, dailyLimit: 20, confirm: true as const,
    candidates: [{ candidateId: "candidate-1", directMessage: "审核后的正文" }] };
  value.setAccountVersion(4);
  await assert.rejects(value.service.approveDirectMessages(scope, batch.id,
    batch.etag, "independent-stale-login", input),
  (error: unknown) => error instanceof AcquisitionOutreachBatchError && error.code === "douyin_login_expired");
  value.setDnc(true);
  await assert.rejects(value.service.approveDirectMessages(scope, batch.id,
    batch.etag, "independent-dnc", { ...input, accountLoginStateVersion: 4 }),
  (error: unknown) => error instanceof AcquisitionOutreachBatchError && error.code === "candidate_evidence_invalid");
  assert.deepEqual(await value.repository.listActions(scope.workspaceId, batch.id), []);
});

test("a fresh batch after relogin freezes the current sender for separately approved comment and DM", async () => {
  const value = fixture({ useRepositoryDirectMessagePersistence: true });
  value.setAccountVersion(4); // The completed collection remains at version 3.
  const { batch } = await created(value);
  assert.equal(batch.accountLoginStateVersion, 4);
  const approved = await value.service.approve(scope, batch.id, batch.etag,
    "approve-relogin-comment", { revision: batch.revision, batchHash: batch.batchHash, confirm: true });
  const comment = await value.repository.claimNextAction({ workerId: "relogin-test",
    now, leaseDurationMs: 180_000 });
  assert.ok(comment);
  assert.equal(comment.action.accountLoginStateVersion, 4);
  assert.equal((await value.repository.listActions(scope.workspaceId, batch.id))!.length, 1);
  await value.repository.completeActionSuccess(comment.fence, {
    platformReceiptReference: "douyin-comment:relogin-fixture", occurredAt: now
  });
  await value.service.approveDirectMessages(scope, batch.id, approved.value.etag,
    "approve-relogin-dm", { batchRevision: batch.revision, batchHash: batch.batchHash,
      commentApprovalHash: approved.value.approvalHash!, dailyLimit: 20,
      candidates: [{ candidateId: "candidate-1", directMessage: "根据公开需求交流获客方案" }], confirm: true });
  const actions = await value.repository.listActions(scope.workspaceId, batch.id);
  assert.deepEqual(actions!.map((action) => [action.kind, action.accountLoginStateVersion]),
    [["comment", 4], ["direct_message", 4]]);
});

test("relogin never silently rebinds an existing batch or accepts a rolled-back sender version", async () => {
  const value = fixture();
  const { batch } = await created(value);
  value.setAccountVersion(4);
  await assert.rejects(value.service.approve(scope, batch.id, batch.etag,
    "approve-old-login", { revision: batch.revision, batchHash: batch.batchHash, confirm: true }),
  (error: unknown) => error instanceof AcquisitionOutreachBatchError && error.code === "douyin_login_expired");
  assert.equal((await value.service.get(scope, batch.id)).accountLoginStateVersion, 3);
  assert.deepEqual(await value.repository.listActions(scope.workspaceId, batch.id), []);
  value.setAccountVersion(2);
  await assert.rejects(value.service.create(scope, "run-1", "create-older-login", { candidateIds: ["candidate-1"] }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError && error.code === "douyin_login_expired");
});

function discoveryBatch(input: {
  id: string; workspaceId: string; runId: string; candidateId: string; createdAt: string;
}): AcquisitionOutreachBatch {
  return {
    id: input.id, workspaceId: input.workspaceId, runId: input.runId,
    planId: "plan-discovery", planVersionId: "plan-version-discovery", planVersion: 1,
    planSnapshotHash: `sha256:${"d".repeat(64)}`, policyVersionId: "policy-discovery",
    policyHash: `sha256:${"e".repeat(64)}`, accountId: "account-discovery",
    accountLoginStateVersion: 1, dailyBudgetId: `sha256:${"f".repeat(64)}`,
    localDate: "2026-08-27", timeZone: "UTC",
    dailyCandidateLimit: 9, dailyRemainingLimit: 9,
    revision: 1, etag: outreachBatchEtag(input.id, 1), state: "awaiting_approval",
    candidates: [{ candidateId: input.candidateId, selected: true, candidateRevision: 1,
      evidenceHashes: [`sha256:${"a".repeat(64)}`], evidenceText: ["公开线索"],
      publicActorKey: "actor-discovery", publicProfileUrl: "https://www.douyin.com/user/discovery",
      commentTargetPublicUrl: "https://www.douyin.com/video/discovery", draftRevision: 1,
      comment: "公开评论", commentHash: `sha256:${"b".repeat(64)}`,
      directMessage: "公开私信", directMessageHash: `sha256:${"c".repeat(64)}`,
      rationaleCodes: ["evidence_grounded"], modelSnapshotId: "model-discovery",
      sourceModelSnapshotId: "model-discovery", contentHash: `sha256:${"0".repeat(64)}` }],
    batchHash: `sha256:${"1".repeat(64)}`, approvedBy: null, approvedAt: null,
    approvalHash: null, rejectedBy: null, rejectedAt: null, rejectionReason: null,
    pauseReason: null, createdBy: "creator-discovery", createdAt: input.createdAt,
    updatedBy: "creator-discovery", updatedAt: input.createdAt
  };
}

test("candidate-scoped discovery returns only current heads in descending keyset pages", async () => {
  const repository = new InMemoryAcquisitionOutreachBatchRepository();
  const batches = [
    discoveryBatch({ id: "batch-page-a", workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-1", createdAt: "2026-08-27T03:00:00.000Z" }),
    discoveryBatch({ id: "batch-page-z", workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-1", createdAt: "2026-08-27T04:00:00.000Z" }),
    discoveryBatch({ id: "batch-other-workspace", workspaceId: "workspace-2", runId: "run-1", candidateId: "candidate-1", createdAt: "2026-08-27T05:00:00.000Z" }),
    discoveryBatch({ id: "batch-other-run", workspaceId: "workspace-1", runId: "run-2", candidateId: "candidate-1", createdAt: "2026-08-27T06:00:00.000Z" }),
    discoveryBatch({ id: "batch-other-candidate", workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-2", createdAt: "2026-08-27T07:00:00.000Z" })
  ];
  for (const batch of batches) await repository.create({ workspaceId: batch.workspaceId,
    operation: `create:${batch.id}`, idempotencyKey: `key:${batch.id}`,
    requestHash: `sha256:${batch.id.padEnd(64, "0").slice(0, 64)}`, batch });
  const revised = await repository.replace({ workspaceId: "workspace-1", batchId: "batch-page-a",
    ifMatch: outreachBatchEtag("batch-page-a", 1), operation: "put", idempotencyKey: "key:revision",
    requestHash: `sha256:${"2".repeat(64)}`, build: (current) => ({ ...current, revision: 2,
      etag: outreachBatchEtag(current.id, 2), updatedAt: "2026-08-27T08:00:00.000Z" }) });
  assert.equal(revised.kind, "created");

  const firstPage = await repository.listByRunCandidate({
    workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-1", limit: 1, after: null
  });
  assert.deepEqual(firstPage.items.map((batch) => batch.id), ["batch-page-z"]);
  assert.ok(firstPage.next);
  const secondPage = await repository.listByRunCandidate({
    workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-1", limit: 1, after: firstPage.next
  });
  assert.deepEqual(secondPage.items.map((batch) => batch.id), ["batch-page-a"]);
  assert.equal(secondPage.items[0]?.revision, 2);
  assert.equal(secondPage.next, null);
  assert.notEqual(secondPage.items[0]?.id, firstPage.items[0]?.id);
});

test("candidate discovery exposes frozen public review targets but removes private evidence fields", async () => {
  const value = fixture({ dailyLimit: 3 });
  const batch = await value.service.create(scope, "run-1", "create-discovery-public", {
    candidateIds: ["candidate-1"]
  });
  await value.service.approve(scope, batch.value.id, batch.value.etag, "approve-discovery-public", {
    revision: 1, batchHash: batch.value.batchHash, confirm: true
  });

  const publicPage = await value.service.listByRunCandidate(scope, {
    runId: "run-1", candidateId: "candidate-1", limit: 4, after: null
  });
  assert.equal(publicPage.items.length, 1);
  assert.equal(publicPage.items[0]?.dailyRemainingLimit, 2);
  const candidate = publicPage.items[0]?.candidates[0] as Record<string, unknown>;
  assert.equal(candidate.evidenceText, undefined);
  assert.equal(candidate.publicActorKey, undefined);
  assert.equal(candidate.publicProfileUrl, "https://www.douyin.com/user/actor-1");
  assert.equal(candidate.commentTargetPublicUrl, "https://www.douyin.com/video/video-1");
});

test("batch approval hash authority changes when either frozen public target changes", () => {
  const base = discoveryBatch({
    id: "batch-target-hash", workspaceId: "workspace-1", runId: "run-1",
    candidateId: "candidate-1", createdAt: "2026-08-27T03:00:00.000Z"
  });
  const changedVideo = {
    ...base,
    candidates: base.candidates.map((candidate) => ({
      ...candidate,
      commentTargetPublicUrl: "https://www.douyin.com/video/changed-video"
    }))
  };
  const changedProfile = {
    ...base,
    candidates: base.candidates.map((candidate) => ({
      ...candidate,
      publicProfileUrl: "https://www.douyin.com/user/changed-profile"
    }))
  };
  assert.notEqual(outreachBatchHash(base), outreachBatchHash(changedVideo));
  assert.notEqual(outreachBatchHash(base), outreachBatchHash(changedProfile));
});

test("candidate discovery normalizes an offset anchor before repository keyset lookup", async () => {
  const value = fixture();
  let receivedAnchor: { createdAt: string; batchId: string } | null = null;
  const list = value.repository.listByRunCandidate.bind(value.repository);
  value.repository.listByRunCandidate = async (input) => {
    receivedAnchor = input.after;
    return list(input);
  };

  await value.service.listByRunCandidate(scope, {
    runId: "run-1", candidateId: "candidate-1", limit: 1,
    after: { createdAt: "2026-08-25T11:00:00+08:00", batchId: "batch-offset-anchor" }
  });
  assert.deepEqual(receivedAnchor, {
    createdAt: "2026-08-25T03:00:00.000Z", batchId: "batch-offset-anchor"
  });
});

test("creation persists Task 6 values as immutable candidate revision 1 and freezes run authority", async () => {
  const { batch } = await created();
  assert.equal(batch.revision, 1);
  assert.equal(batch.state, "awaiting_approval");
  assert.equal(batch.policyVersionId, "policy-9");
  assert.equal(batch.dailyCandidateLimit, 50);
  assert.equal(batch.dailyRemainingLimit, 50);
  assert.equal(batch.candidates[0]?.draftRevision, 1);
  assert.equal(batch.candidates[0]?.comment, "看到你公开提到需要获客方案");
  assert.equal(batch.candidates[0]?.sourceModelSnapshotId, "model-job-1");
  assert.match(batch.batchHash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(batch.etag, outreachBatchEtag(batch.id, 1));
});

test("live candidates cannot become executable until terminal ingestion and projection are final", async () => {
  const value = fixture();
  value.setFinalizationState("pending");

  await assert.rejects(
    value.service.create(scope, "run-1", "create-live-page-pending", {
      candidateIds: ["candidate-1"]
    }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_candidate_projection_pending"
  );

  value.setFinalizationState("ready");
  const early = await value.service.create(
    scope,
    "run-1",
    "create-before-reopened-projection",
    { candidateIds: ["candidate-1"] }
  );

  // A later crawler page for the same actor reopens final projection and may
  // mutate the evidence authority. The old review can never queue actions.
  value.setFinalizationState("pending");
  value.setCandidateRevision(2);
  await assert.rejects(
    value.service.approve(
      scope,
      early.value.id,
      early.value.etag,
      "approve-before-terminal-projection",
      {
        revision: early.value.revision,
        batchHash: early.value.batchHash,
        confirm: true
      }
    ),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_candidate_projection_pending"
  );
  assert.equal((await value.service.get(scope, early.value.id)).state,
    "awaiting_approval");
  assert.deepEqual(await value.service.actions(scope, early.value.id), []);

  value.setFinalizationState("ready");
  await assert.rejects(
    value.service.approve(
      scope,
      early.value.id,
      early.value.etag,
      "approve-stale-live-page-evidence",
      {
        revision: early.value.revision,
        batchHash: early.value.batchHash,
        confirm: true
      }
    ),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "candidate_evidence_invalid"
  );
  assert.deepEqual(await value.service.actions(scope, early.value.id), []);

  const finalized = await value.service.create(
    scope,
    "run-1",
    "create-after-terminal-projection",
    { candidateIds: ["candidate-1"] }
  );
  const approved = await value.service.approve(
    scope,
    finalized.value.id,
    finalized.value.etag,
    "approve-after-terminal-projection",
    {
      revision: finalized.value.revision,
      batchHash: finalized.value.batchHash,
      confirm: true
    }
  );
  assert.equal(approved.value.state, "approved");
  assert.deepEqual(
    (await value.service.actions(scope, finalized.value.id))
      .map((action) => action.status),
    ["queued"]
  );
});

test("failed or cancelled crawl authority cannot create an outreach batch", async () => {
  const value = fixture();
  value.setFinalizationState("unavailable");
  await assert.rejects(
    value.service.create(scope, "run-1", "create-unavailable-projection", {
      candidateIds: ["candidate-1"]
    }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_candidate_projection_unavailable"
  );
});

test("PUT removes candidates and valid human edits create batch and draft revision 2", async () => {
  const { value, batch } = await created();
  const edited = await value.service.put(scope, batch.id, batch.etag, "put-key-0001", {
    candidates: [{
      candidateId: "candidate-1", selected: true,
      comment: "需要获客方案，期待交流",
      directMessage: "看到你公开提到需要获客方案，方便的话，可交流公开场景里的思路"
    }]
  });
  assert.equal(edited.value.revision, 2);
  assert.equal(edited.value.candidates[0]?.draftRevision, 2);
  assert.equal(edited.value.candidates[0]?.modelSnapshotId, "model-job-1");
  assert.equal(edited.value.candidates[0]?.sourceModelSnapshotId, "model-job-1");
  await assert.rejects(
    value.service.put(scope, batch.id, edited.value.etag, "put-key-0002", { candidates: [] }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError && error.code === "outreach_batch_empty"
  );
});

test("manual revision accepts short conversational comments without regenerating drafts", async () => {
  let generations = 0;
  const { value, batch } = await created(fixture({ onGenerateDraft: () => { generations++; } }));
  for (const comment of ["看到你公开提到需要获客方案,方便的话聊聊？", "聊聊?", "你好"]) {
    const current = (await value.service.get(scope, batch.id));
    const result = await value.service.put(scope, batch.id, current.etag, `manual-${comment}`, {
      candidates: [{ candidateId: "candidate-1", selected: true, comment, directMessage: batch.candidates[0]!.directMessage }]
    });
    assert.equal(result.value.candidates[0]!.comment, comment.normalize("NFKC"));
    assert.equal(result.value.candidates[0]!.sourceModelSnapshotId, "model-job-1");
    assert.equal(result.value.state, "awaiting_approval");
    assert.deepEqual(await value.service.actions(scope, batch.id), []);
    assert.equal(generations, 1, "PUT must never request fresh model generation");
  }
});

test("PUT rejects a canonical target that drifted from the frozen candidate", async () => {
  const { value, batch } = await created();
  value.setCommentTargetPublicUrl("https://www.douyin.com/video/video-2");

  await assert.rejects(
    value.service.put(scope, batch.id, batch.etag, "put-target-drift", {
      candidates: [{
        candidateId: "candidate-1", selected: true,
        comment: batch.candidates[0]!.comment,
        directMessage: batch.candidates[0]!.directMessage
      }]
    }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "candidate_evidence_invalid"
  );
});

test("approval rejects stale revisions, replays an exact command, and conflicts on changed semantics", async () => {
  const { value, batch } = await created();
  await assert.rejects(
    value.service.approve(scope, batch.id, '"outreach-batch:stale:1"', "approve-key-0001", {
      revision: 1, batchHash: batch.batchHash, confirm: true
    }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError && error.code === "outreach_batch_stale"
  );
  const command = { revision: 1, batchHash: batch.batchHash, confirm: true as const };
  const approved = await value.service.approve(scope, batch.id, batch.etag, "approve-key-0001", command);
  const replay = await value.service.approve(scope, batch.id, batch.etag, "approve-key-0001", command);
  assert.equal(approved.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.value, approved.value);
  await assert.rejects(
    value.service.approve(scope, batch.id, batch.etag, "approve-key-0001", { ...command, batchHash: `sha256:${"9".repeat(64)}` }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError && error.code === "outreach_idempotency_conflict"
  );
});

test("approval creates only the exact frozen queued comment and no direct-message successor", async () => {
  const { value, batch } = await created();
  const approved = await value.service.approve(scope, batch.id, batch.etag, "approve-key-0002", {
    revision: 1, batchHash: batch.batchHash, confirm: true
  });
  assert.notEqual(approved.value.etag, batch.etag);
  const actions = await value.service.actions(scope, batch.id);
  assert.deepEqual(actions.map(({ kind, sequence, status }) => ({ kind, sequence, status })), [
    { kind: "comment", sequence: 1, status: "queued" }
  ]);
  assert.equal(actions[0]?.content, batch.candidates[0]?.comment);
  assert.equal(actions.some((action) => action.kind === "direct_message"), false);
});

test("direct-message approval requires the exact succeeded comment receipt and a confirmed 1 through 100 daily limit", async () => {
  let approved: { built: { actions: AcquisitionOutreachAction[] } } | undefined;
  const value = fixture({ onApproveDirectMessages: (input) => {
    approved = input as { built: { actions: AcquisitionOutreachAction[] } };
  } });
  const created = await value.service.create(scope, "run-1", "create-dm-approval", {
    candidateIds: ["candidate-1"]
  });
  const batch = await value.service.approve(scope, created.value.id, created.value.etag,
    "approve-comment-for-dm", {
      revision: created.value.revision, batchHash: created.value.batchHash, confirm: true
    });
  const command = {
    batchRevision: batch.value.revision,
    batchHash: batch.value.batchHash,
    commentApprovalHash: batch.value.approvalHash!,
    dailyLimit: 20,
    candidates: [{ candidateId: "candidate-1", directMessage: "请交流公开场景里的思路" }],
    confirm: true as const
  };
  for (const invalid of [
    { ...command, confirm: false },
    { ...command, dailyLimit: 0 },
    { ...command, dailyLimit: 101 }
  ]) {
    await assert.rejects(value.service.approveDirectMessages(scope, batch.value.id,
      batch.value.etag, `invalid-dm-${String(invalid.dailyLimit)}-${String(invalid.confirm)}`,
      invalid), (error: unknown) => error instanceof AcquisitionOutreachBatchError
        && error.code === "invalid_request");
  }
  await assert.rejects(value.service.approveDirectMessages(scope, batch.value.id,
    batch.value.etag, "dm-over-daily-limit", { ...command, dailyLimit: 1,
      candidates: [...command.candidates, { candidateId: "candidate-2",
        directMessage: "第二条私信" }] }),
  (error: unknown) => error instanceof AcquisitionOutreachBatchError
    && error.code === "invalid_request");
  await assert.rejects(value.service.approveDirectMessages(scope, batch.value.id,
    batch.value.etag, "dm-before-comment-receipt", command),
  (error: unknown) => error instanceof AcquisitionOutreachBatchError
    && error.code === "outreach_comment_receipt_required");

  const claim = await value.repository.claimNextAction({ workerId: "dm-receipt-worker",
    now: "2026-08-25T02:01:00.000Z", leaseDurationMs: 180_000 });
  assert.ok(claim);
  await value.repository.completeActionSuccess(claim.fence, {
    platformReceiptReference: "douyin-comment:receipt-123",
    occurredAt: "2026-08-25T02:02:00.000Z"
  });
  value.setFinalizationState("pending");
  await assert.rejects(value.service.approveDirectMessages(scope, batch.value.id,
    batch.value.etag, "dm-pending-projection", command),
  (error: unknown) => error instanceof AcquisitionOutreachBatchError
    && error.code === "outreach_candidate_projection_pending");
  value.setFinalizationState("ready");
  for (const dailyLimit of [1, 20, 100]) {
    approved = undefined;
    await value.service.approveDirectMessages(scope, batch.value.id, batch.value.etag,
      `approve-dm-${dailyLimit}`, { ...command, dailyLimit });
    assert.ok(approved);
    const action = approved.built.actions[0]!;
    assert.deepEqual({ kind: action.kind, sequence: action.sequence,
      authorizationVersion: action.authorizationVersion, approvedBy: action.approvedBy,
      approvedAt: action.approvedAt, directMessageDailyLimit: action.directMessageDailyLimit,
      directMessageDailyOrdinal: action.directMessageDailyOrdinal }, {
      kind: "direct_message", sequence: 2, authorizationVersion: 2,
      approvedBy: scope.actorId, approvedAt: now,
      directMessageDailyLimit: dailyLimit, directMessageDailyOrdinal: 1
    });
    assert.equal(action.predecessorActionId, claim.action.id);
    assert.equal(action.targetPublicUrl, "https://www.douyin.com/user/actor-1");
    assert.equal(action.content, command.candidates[0]?.directMessage);
    assert.equal(action.contentHash, outreachContentHash(command.candidates[0]!.directMessage));
    assert.equal(action.approvalHash, outreachDirectMessageApprovalHash({
      authorizationVersion: 2, batchId: batch.value.id,
      batchRevision: batch.value.revision, batchHash: batch.value.batchHash,
      commentApprovalHash: batch.value.approvalHash!, candidateId: "candidate-1",
      accountId: "account-1", accountLoginStateVersion: 3,
      targetPublicUrl: "https://www.douyin.com/user/actor-1",
      directMessage: command.candidates[0]!.directMessage,
      directMessageHash: action.contentHash, predecessorActionId: claim.action.id,
      predecessorReceiptReference: "douyin-comment:receipt-123", dailyLimit,
      dailyOrdinal: 1, approvedBy: scope.actorId, approvedAt: now
    }));
  }
});

test("direct-message approval fails closed on duplicate or nonconsecutive persistence ordinals", async () => {
  for (const directMessageDailyOrdinals of [[1, 1], [1, 3]]) {
    const value = fixture({ candidateIds: ["candidate-1", "candidate-2"],
      directMessageDailyOrdinals, onApproveDirectMessages: () => {} });
    const created = await value.service.create(scope, "run-1",
      `create-dm-ordinal-${directMessageDailyOrdinals.join("-")}`, {
        candidateIds: ["candidate-1", "candidate-2"]
      });
    const batch = await value.service.approve(scope, created.value.id, created.value.etag,
      `approve-dm-comment-${directMessageDailyOrdinals.join("-")}`, {
        revision: 1, batchHash: created.value.batchHash, confirm: true
      });
    for (const [index, at] of ["2026-08-25T02:01:00.000Z", "2026-08-25T02:03:00.000Z"].entries()) {
      const claim = await value.repository.claimNextAction({ workerId: `ordinal-${index}`,
        now: at, leaseDurationMs: 180_000 });
      assert.ok(claim);
      await value.repository.completeActionSuccess(claim.fence, {
        platformReceiptReference: `douyin-comment:receipt-${index}`,
        occurredAt: at
      });
    }
    await assert.rejects(value.service.approveDirectMessages(scope, batch.value.id,
      batch.value.etag, `approve-dm-ordinal-${directMessageDailyOrdinals.join("-")}`, {
        batchRevision: 1, batchHash: batch.value.batchHash,
        commentApprovalHash: batch.value.approvalHash!, dailyLimit: 3,
        candidates: ["candidate-1", "candidate-2"].map((candidateId) => ({
          candidateId, directMessage: `私信 ${candidateId}`
        })), confirm: true
      }), (error: unknown) => error instanceof AcquisitionOutreachBatchError
        && error.code === "outreach_batch_stale");
  }
});

test("memory direct-message approval atomically persists one v2 action and replays without another reservation", async () => {
  const value = fixture({ useRepositoryDirectMessagePersistence: true,
    candidateIds: ["candidate-1", "candidate-2"], accountExecutorMode: "desktop",
    accountExecutorDeviceIdHash: `sha256:${"a".repeat(64)}`,
    accountExecutorBindingGeneration: 3,
    accountExecutorLeaseExpiresAt: "2026-08-25T02:01:30.000Z" });
  const created = await value.service.create(scope, "run-1", "create-dm-persist", {
    candidateIds: ["candidate-1"]
  });
  const other = await value.service.create(scope, "run-1", "create-other-dm-persist", {
    candidateIds: ["candidate-2"]
  });
  const approved = await value.service.approve(scope, created.value.id,
    created.value.etag, "approve-comment-dm-persist", {
      revision: 1, batchHash: created.value.batchHash, confirm: true
    });
  const comment = await value.repository.claimNextAction({
    workerId: "comment-before-dm-persist",
    now: "2026-08-25T02:01:00.000Z",
    leaseDurationMs: 180_000, executionTarget: "desktop"
  });
  assert.ok(comment);
  assert.equal(await value.repository.completeActionSuccess(comment.fence, {
    platformReceiptReference: "douyin-comment:persisted-receipt",
    occurredAt: "2026-08-25T02:02:00.000Z"
  }), true);
  const command = {
    batchRevision: 1,
    batchHash: approved.value.batchHash,
    commentApprovalHash: approved.value.approvalHash!,
    dailyLimit: 2,
    candidates: [{ candidateId: "candidate-1", directMessage: "已审批的精确私信" }],
    confirm: true as const
  };

  const first = await value.service.approveDirectMessages(scope, approved.value.id,
    approved.value.etag, "persist-dm-key", command);
  const replay = await value.service.approveDirectMessages(scope, approved.value.id,
    approved.value.etag, "persist-dm-key", command);
  const actions = await value.repository.listActions(scope.workspaceId, approved.value.id);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(actions?.map((action) => action.executionTarget),
    ["desktop", "desktop"]);
  await assert.rejects(value.service.approveDirectMessages(scope, other.value.id,
    other.value.etag, "persist-dm-key", command),
  (error: unknown) => error instanceof AcquisitionOutreachBatchError
    && error.code === "outreach_idempotency_conflict");
  assert.deepEqual(actions?.map(({ kind, authorizationVersion,
    directMessageDailyOrdinal }) => ({ kind, authorizationVersion,
    directMessageDailyOrdinal })), [
    { kind: "comment", authorizationVersion: undefined,
      directMessageDailyOrdinal: undefined },
    { kind: "direct_message", authorizationVersion: 2,
      directMessageDailyOrdinal: 1 }
  ]);
  await assert.rejects(value.service.approveDirectMessages(scope, approved.value.id,
    approved.value.etag, "persist-dm-key", {
      ...command,
      candidates: [{ candidateId: "candidate-1", directMessage: "改过的私信" }]
    }), (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_idempotency_conflict");
});

test("direct-message approval re-resolves a desktop binding and writes nothing when its gate is disabled", async () => {
  const value = fixture({ useRepositoryDirectMessagePersistence: true,
    serverExecutionEnabled: true, desktopExecutionEnabled: false });
  const created = await value.service.create(scope, "run-1", "create-dm-disabled", {
    candidateIds: ["candidate-1"]
  });
  const approved = await value.service.approve(scope, created.value.id,
    created.value.etag, "approve-comment-before-desktop", {
      revision: 1, batchHash: created.value.batchHash, confirm: true
    });
  const comment = await value.repository.claimNextAction({
    workerId: "comment-before-desktop", now: "2026-08-25T02:00:10.000Z",
    leaseDurationMs: 180_000, executionTarget: "server"
  });
  assert.ok(comment);
  await value.repository.completeActionSuccess(comment.fence, {
    platformReceiptReference: "douyin-comment:before-desktop",
    occurredAt: "2026-08-25T02:00:20.000Z"
  });
  value.setAccountExecutor({ mode: "desktop",
    deviceIdHash: `sha256:${"a".repeat(64)}`, generation: 2,
    leaseExpiresAt: "2026-08-25T02:01:30.000Z" });

  await assert.rejects(value.service.approveDirectMessages(scope, approved.value.id,
    approved.value.etag, "approve-dm-desktop-disabled", {
      batchRevision: 1, batchHash: approved.value.batchHash,
      commentApprovalHash: approved.value.approvalHash!, dailyLimit: 2,
      candidates: [{ candidateId: "candidate-1", directMessage: "不应落库" }],
      confirm: true
    }), { code: "outreach_desktop_execution_disabled" });
  assert.deepEqual((await value.repository.listActions(scope.workspaceId,
    approved.value.id))?.map((action) => action.kind), ["comment"]);
});

test("direct-message approval re-resolves server authority and writes nothing when its gate is disabled", async () => {
  for (const currentMode of ["server", null] as const) {
    const value = fixture({ useRepositoryDirectMessagePersistence: true,
      serverExecutionEnabled: false, desktopExecutionEnabled: true,
      accountExecutorMode: "desktop",
      accountExecutorDeviceIdHash: `sha256:${"a".repeat(64)}`,
      accountExecutorBindingGeneration: 2,
      accountExecutorLeaseExpiresAt: "2026-08-25T02:01:30.000Z" });
    const created = await value.service.create(scope, "run-1",
      `create-dm-server-disabled-${currentMode ?? "unbound"}`, {
        candidateIds: ["candidate-1"]
      });
    const approved = await value.service.approve(scope, created.value.id,
      created.value.etag, `approve-comment-before-${currentMode ?? "unbound"}`, {
        revision: 1, batchHash: created.value.batchHash, confirm: true
      });
    const comment = await value.repository.claimNextAction({
      workerId: `comment-before-${currentMode ?? "unbound"}`,
      now: "2026-08-25T02:00:10.000Z",
      leaseDurationMs: 180_000, executionTarget: "desktop"
    });
    assert.ok(comment);
    await value.repository.completeActionSuccess(comment.fence, {
      platformReceiptReference: `douyin-comment:before-${currentMode ?? "unbound"}`,
      occurredAt: "2026-08-25T02:00:20.000Z"
    });
    value.setAccountExecutor({ mode: currentMode, deviceIdHash: null,
      generation: 0, leaseExpiresAt: null });

    await assert.rejects(value.service.approveDirectMessages(scope,
      approved.value.id, approved.value.etag,
      `approve-dm-server-disabled-${currentMode ?? "unbound"}`, {
        batchRevision: 1, batchHash: approved.value.batchHash,
        commentApprovalHash: approved.value.approvalHash!, dailyLimit: 2,
        candidates: [{ candidateId: "candidate-1", directMessage: "不应落库" }],
        confirm: true
      }), { code: "outreach_server_execution_disabled" });
    const actions = await value.repository.listActions(scope.workspaceId,
      approved.value.id);
    assert.deepEqual(actions?.map(({ kind, executionTarget }) => ({
      kind, executionTarget
    })), [{ kind: "comment", executionTarget: "desktop" }]);
  }
});

test("service assigns direct-message approval quota to the actual approval day instead of the crawler batch day", async () => {
  const value = fixture({ useRepositoryDirectMessagePersistence: true,
    initialNow: "2026-08-25T23:58:00.000Z" });
  const created = await value.service.create(scope, "run-1", "create-dm-cross-midnight", {
    candidateIds: ["candidate-1"]
  });
  const approved = await value.service.approve(scope, created.value.id,
    created.value.etag, "approve-comment-cross-midnight", {
      revision: 1, batchHash: created.value.batchHash, confirm: true
    });
  const comment = await value.repository.claimNextAction({
    workerId: "comment-cross-midnight",
    now: "2026-08-25T23:59:00.000Z",
    leaseDurationMs: 180_000
  });
  assert.ok(comment);
  await value.repository.completeActionSuccess(comment.fence, {
    platformReceiptReference: "douyin-comment:cross-midnight",
    occurredAt: "2026-08-25T23:59:30.000Z"
  });

  value.setNow("2026-08-26T00:01:00.000Z");
  await value.service.approveDirectMessages(scope, approved.value.id,
    approved.value.etag, "approve-dm-cross-midnight", {
      batchRevision: approved.value.revision,
      batchHash: approved.value.batchHash,
      commentApprovalHash: approved.value.approvalHash!,
      dailyLimit: 1,
      candidates: [{ candidateId: "candidate-1", directMessage: "跨日审批的精确私信" }],
      confirm: true
    });

  const directMessage = (await value.repository.listActions(scope.workspaceId,
    approved.value.id))!.find((action) => action.kind === "direct_message");
  assert.equal(directMessage?.localDate, "2026-08-26");
});

test("memory direct-message approval permanently rejects the same batch candidate across local dates", async () => {
  const value = fixture({ useRepositoryDirectMessagePersistence: true,
    initialNow: "2026-08-25T02:00:00.000Z" });
  const created = await value.service.create(scope, "run-1", "create-dm-permanent-unique", {
    candidateIds: ["candidate-1"]
  });
  const approved = await value.service.approve(scope, created.value.id,
    created.value.etag, "approve-comment-permanent-unique", {
      revision: 1, batchHash: created.value.batchHash, confirm: true
    });
  const comment = await value.repository.claimNextAction({
    workerId: "comment-permanent-unique", now: "2026-08-25T02:01:00.000Z",
    leaseDurationMs: 180_000
  });
  assert.ok(comment);
  await value.repository.completeActionSuccess(comment.fence, {
    platformReceiptReference: "douyin-comment:permanent-unique",
    occurredAt: "2026-08-25T02:02:00.000Z"
  });
  const command = {
    batchRevision: approved.value.revision, batchHash: approved.value.batchHash,
    commentApprovalHash: approved.value.approvalHash!, dailyLimit: 20,
    candidates: [{ candidateId: "candidate-1", directMessage: "首条精确私信" }],
    confirm: true as const
  };
  await value.service.approveDirectMessages(scope, approved.value.id,
    approved.value.etag, "approve-dm-permanent-unique-first", command);

  value.setNow("2026-08-26T02:00:00.000Z");
  await assert.rejects(value.service.approveDirectMessages(scope, approved.value.id,
    approved.value.etag, "approve-dm-permanent-unique-next-day", {
      ...command,
      candidates: [{ candidateId: "candidate-1", directMessage: "次日重复私信" }]
    }), (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_direct_message_already_approved");
  assert.equal((await value.repository.listActions(scope.workspaceId,
    approved.value.id))!.filter((action) => action.kind === "direct_message").length, 1);
});

test("memory direct-message approval rejects the same account candidate across batches on one local date", async () => {
  const value = fixture({ useRepositoryDirectMessagePersistence: true,
    initialNow: "2026-08-24T02:00:00.000Z",
    runLocalDates: {
      "run-day-1": "2026-08-24",
      "run-day-2": "2026-08-25"
    } });
  const approveComment = async (runId: string, key: string, claimAt: string) => {
    value.setNow(claimAt);
    const created = await value.service.create(scope, runId, `create-${key}`, {
      candidateIds: ["candidate-1"]
    });
    const approved = await value.service.approve(scope, created.value.id,
      created.value.etag, `approve-${key}`, {
        revision: created.value.revision,
        batchHash: created.value.batchHash,
        confirm: true
      });
    const claim = await value.repository.claimNextAction({
      workerId: `worker-${key}`, now: claimAt, leaseDurationMs: 180_000
    });
    assert.equal(claim?.action.batchId, approved.value.id);
    await value.repository.completeActionSuccess(claim!.fence, {
      platformReceiptReference: `douyin-comment:${key}`,
      occurredAt: claimAt
    });
    return approved.value;
  };
  const first = await approveComment("run-day-1", "cross-batch-day-1",
    "2026-08-24T02:00:00.000Z");
  const second = await approveComment("run-day-2", "cross-batch-day-2",
    "2026-08-25T02:00:00.000Z");
  value.setNow("2026-08-25T03:00:00.000Z");
  const command = (batch: AcquisitionOutreachBatch, directMessage: string) => ({
    batchRevision: batch.revision,
    batchHash: batch.batchHash,
    commentApprovalHash: batch.approvalHash!,
    dailyLimit: 20,
    candidates: [{ candidateId: "candidate-1", directMessage }],
    confirm: true as const
  });
  await value.service.approveDirectMessages(scope, first.id, first.etag,
    "approve-first-cross-batch-dm", command(first, "第一批次精确私信"));

  await assert.rejects(value.service.approveDirectMessages(scope, second.id,
    second.etag, "approve-second-cross-batch-dm",
    command(second, "第二批次重复私信")),
  (error: unknown) => error instanceof AcquisitionOutreachBatchError
    && error.code === "outreach_direct_message_already_approved");
  const firstActions = await value.repository.listActions(scope.workspaceId, first.id);
  const secondActions = await value.repository.listActions(scope.workspaceId, second.id);
  assert.equal([...(firstActions ?? []), ...(secondActions ?? [])]
    .filter((action) => action.kind === "direct_message").length, 1);
});

test("memory direct-message approval reserves permanent consecutive daily ordinals and rejects duplicate candidates", async () => {
  const value = fixture({ useRepositoryDirectMessagePersistence: true,
    candidateIds: ["candidate-1", "candidate-2"] });
  const created = await value.service.create(scope, "run-1", "create-dm-ordinals", {
    candidateIds: ["candidate-1", "candidate-2"]
  });
  const approved = await value.service.approve(scope, created.value.id,
    created.value.etag, "approve-comments-dm-ordinals", {
      revision: 1, batchHash: created.value.batchHash, confirm: true
    });
  for (const [index, at] of ["2026-08-25T02:01:00.000Z",
    "2026-08-25T02:02:00.000Z"].entries()) {
    const comment = await value.repository.claimNextAction({
      workerId: `comment-ordinal-${index}`, now: at, leaseDurationMs: 180_000
    });
    assert.ok(comment);
    await value.repository.completeActionSuccess(comment.fence, {
      platformReceiptReference: `douyin-comment:ordinal-${index + 1}`,
      occurredAt: at
    });
  }
  const base = {
    batchRevision: 1, batchHash: approved.value.batchHash,
    commentApprovalHash: approved.value.approvalHash!, dailyLimit: 2,
    confirm: true as const
  };
  await value.service.approveDirectMessages(scope, approved.value.id,
    approved.value.etag, "approve-two-dms", { ...base,
      candidates: ["candidate-1", "candidate-2"].map((candidateId) => ({
        candidateId, directMessage: `精确私信 ${candidateId}`
      })) });
  const directMessages = (await value.repository.listActions(scope.workspaceId,
    approved.value.id))!.filter((action) => action.kind === "direct_message");
  assert.deepEqual(directMessages.map((action) => action.directMessageDailyOrdinal), [1, 2]);
  await assert.rejects(value.service.approveDirectMessages(scope, approved.value.id,
    approved.value.etag, "duplicate-candidate-dm", { ...base,
      candidates: [{ candidateId: "candidate-1", directMessage: "再次私信" }] }),
  (error: unknown) => error instanceof AcquisitionOutreachBatchError
    && error.code === "outreach_direct_message_already_approved");
  assert.equal((await value.repository.listActions(scope.workspaceId,
    approved.value.id))!.filter((action) => action.kind === "direct_message").length, 2);
});

test("memory direct-message approval rolls back the action and replay when insertion fails", async () => {
  const value = fixture({ useRepositoryDirectMessagePersistence: true,
    failDirectMessageActionInsertAt: 1 });
  const created = await value.service.create(scope, "run-1", "create-dm-rollback", {
    candidateIds: ["candidate-1"]
  });
  const approved = await value.service.approve(scope, created.value.id,
    created.value.etag, "approve-comment-dm-rollback", {
      revision: 1, batchHash: created.value.batchHash, confirm: true
    });
  const comment = await value.repository.claimNextAction({ workerId: "rollback-comment",
    now: "2026-08-25T02:01:00.000Z", leaseDurationMs: 180_000 });
  assert.ok(comment);
  await value.repository.completeActionSuccess(comment.fence, {
    platformReceiptReference: "douyin-comment:rollback",
    occurredAt: "2026-08-25T02:02:00.000Z"
  });
  const command = { batchRevision: 1, batchHash: approved.value.batchHash,
    commentApprovalHash: approved.value.approvalHash!, dailyLimit: 20,
    candidates: [{ candidateId: "candidate-1", directMessage: "不应落库" }],
    confirm: true as const };
  await assert.rejects(value.service.approveDirectMessages(scope, approved.value.id,
    approved.value.etag, "dm-rollback-key", command), /test_action_insert_failure/u);
  assert.deepEqual((await value.repository.listActions(scope.workspaceId,
    approved.value.id))!.map((action) => action.kind), ["comment"]);
  await assert.rejects(value.service.approveDirectMessages(scope, approved.value.id,
    approved.value.etag, "dm-rollback-key", command), /test_action_insert_failure/u,
  "the failed transaction must not leave an idempotency replay");
});

test("memory direct-message approval rejects a malicious builder and leaves no replay", async () => {
  const value = fixture({ useRepositoryDirectMessagePersistence: true,
    mutateDirectMessageBuild: (actions) => actions.map((action) => ({
      ...action,
      workspaceId: "forged-workspace"
    })) });
  const created = await value.service.create(scope, "run-1", "create-dm-malicious-builder", {
    candidateIds: ["candidate-1"]
  });
  const approved = await value.service.approve(scope, created.value.id,
    created.value.etag, "approve-comment-dm-malicious-builder", {
      revision: 1, batchHash: created.value.batchHash, confirm: true
    });
  const comment = await value.repository.claimNextAction({ workerId: "malicious-builder-comment",
    now: "2026-08-25T02:01:00.000Z", leaseDurationMs: 180_000 });
  assert.ok(comment);
  await value.repository.completeActionSuccess(comment.fence, {
    platformReceiptReference: "douyin-comment:malicious-builder",
    occurredAt: "2026-08-25T02:02:00.000Z"
  });
  const command = { batchRevision: 1, batchHash: approved.value.batchHash,
    commentApprovalHash: approved.value.approvalHash!, dailyLimit: 20,
    candidates: [{ candidateId: "candidate-1", directMessage: "不应被 builder 篡改" }],
    confirm: true as const };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(value.service.approveDirectMessages(scope, approved.value.id,
      approved.value.etag, "dm-malicious-builder-key", command),
    /outreach_direct_message_authority_invalid/u);
  }
  assert.deepEqual((await value.repository.listActions(scope.workspaceId,
    approved.value.id))!.map((action) => action.kind), ["comment"]);
});

test("memory direct-message approval freezes builder inputs and preserves the receipt authority", async () => {
  const value = fixture({ useRepositoryDirectMessagePersistence: true,
    mutateDirectMessageBuilderInputs: (_batch, predecessors) => {
      predecessors[0]!.platformReceiptReference = "douyin-comment:forged-in-builder";
    } });
  const created = await value.service.create(scope, "run-1", "create-dm-frozen-builder", {
    candidateIds: ["candidate-1"]
  });
  const approved = await value.service.approve(scope, created.value.id,
    created.value.etag, "approve-comment-dm-frozen-builder", {
      revision: 1, batchHash: created.value.batchHash, confirm: true
    });
  const comment = await value.repository.claimNextAction({ workerId: "frozen-builder-comment",
    now: "2026-08-25T02:01:00.000Z", leaseDurationMs: 180_000 });
  assert.ok(comment);
  await value.repository.completeActionSuccess(comment.fence, {
    platformReceiptReference: "douyin-comment:original-builder-receipt",
    occurredAt: "2026-08-25T02:02:00.000Z"
  });
  const command = { batchRevision: 1, batchHash: approved.value.batchHash,
    commentApprovalHash: approved.value.approvalHash!, dailyLimit: 20,
    candidates: [{ candidateId: "candidate-1", directMessage: "不可改写审批依据" }],
    confirm: true as const };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(value.service.approveDirectMessages(scope, approved.value.id,
      approved.value.etag, "dm-frozen-builder-key", command), TypeError);
  }
  const actions = await value.repository.listActions(scope.workspaceId, approved.value.id);
  assert.deepEqual(actions?.map(({ kind, platformReceiptReference }) => ({
    kind, platformReceiptReference
  })), [{ kind: "comment",
    platformReceiptReference: "douyin-comment:original-builder-receipt" }]);
});

test("direct-message approval hash binds the second-stage authority", () => {
  const input = {
    authorizationVersion: 2 as const,
    batchId: "batch-1", batchRevision: 1, batchHash: `sha256:${"a".repeat(64)}`,
    commentApprovalHash: `sha256:${"b".repeat(64)}`,
    candidateId: "candidate-1", accountId: "account-1", accountLoginStateVersion: 3,
    targetPublicUrl: "https://www.douyin.com/user/candidate-1",
    directMessage: "公开线索交流", directMessageHash: `sha256:${"c".repeat(64)}`,
    predecessorActionId: "comment-action-1",
    predecessorReceiptReference: "douyin-comment:receipt-1",
    dailyLimit: 20, dailyOrdinal: 1, approvedBy: "approver-1",
    approvedAt: "2026-08-25T02:00:00.000Z"
  };
  const original = outreachDirectMessageApprovalHash(input);
  for (const changed of [
    { directMessage: "已编辑的私信" },
    { predecessorReceiptReference: "douyin-comment:receipt-2" },
    { accountLoginStateVersion: 4 },
    { targetPublicUrl: "https://www.douyin.com/user/candidate-2" },
    { dailyOrdinal: 2 },
    { approvedBy: "approver-2" }
  ]) {
    assert.notEqual(outreachDirectMessageApprovalHash({ ...input, ...changed }), original);
  }
});

test("comment approval hash excludes the editable direct-message draft", () => {
  const candidate = { candidateId: "candidate-1", selected: true,
    comment: "公开评论", commentHash: `sha256:${"a".repeat(64)}`,
    directMessage: "初始私信", directMessageHash: `sha256:${"b".repeat(64)}` };
  const input = { batchId: "batch-1", batchRevision: 1,
    batchHash: `sha256:${"c".repeat(64)}`, approvedBy: "approver-1",
    approvedAt: "2026-08-25T02:00:00.000Z", candidates: [candidate] as never };
  assert.equal(outreachApprovalHash(input), outreachApprovalHash({ ...input,
    candidates: [{ ...candidate, directMessage: "已编辑私信",
      directMessageHash: `sha256:${"d".repeat(64)}` }] as never }));
});

test("manual reconciliation proves an uncertain action read-only and never requeues it", async () => {
  const reconciliationCalls: string[] = [];
  const value = fixture({
    reconcileAction: async (input) => {
      reconciliationCalls.push(input.actionId);
      return {
        actionId: input.actionId,
        state: "succeeded",
        platformReceiptReference: "douyin-comment:reconciled-123",
        occurredAt: "2026-08-25T02:05:00.000Z",
        failureCode: null
      };
    }
  });
  const created = await value.service.create(scope, "run-1", "create-reconcile", {
    candidateIds: ["candidate-1"]
  });
  await value.service.approve(scope, created.value.id, created.value.etag,
    "approve-reconcile", {
      revision: created.value.revision,
      batchHash: created.value.batchHash,
      confirm: true
    });
  const claim = await value.repository.claimNextAction({
    workerId: "worker-reconcile",
    now: "2026-08-25T02:01:00.000Z",
    leaseDurationMs: 180_000
  });
  assert.ok(claim);
  await value.repository.completeActionFailure(
    claim.fence,
    "douyin_action_receipt_ambiguous",
    "2026-08-25T02:04:00.000Z"
  );
  value.setAccountState("risk_paused");

  const reconciled = await value.service.reconcileAction(
    scope,
    created.value.id,
    claim.action.id,
    {
      batchRevision: claim.action.batchRevision,
      approvalHash: claim.action.approvalHash,
      contentHash: claim.action.contentHash,
      confirm: true
    }
  );

  assert.equal(reconciled.status, "succeeded");
  assert.equal(reconciled.platformReceiptReference,
    "douyin-comment:reconciled-123");
  assert.deepEqual(reconciliationCalls, [claim.action.id]);
  const actions = await value.service.actions(scope, created.value.id);
  assert.deepEqual(actions.map((action) => action.status), ["succeeded"]);
  assert.equal(await value.repository.claimNextAction({
    workerId: "worker-must-not-resend",
    now: "2026-08-25T02:10:00.000Z",
    leaseDurationMs: 180_000
  }), null);
});

test("manual account recovery only releases the exact unattempted approved comments and never resends an uncertain action", async () => {
  const value = fixture({ candidateIds: ["candidate-1", "candidate-2"] });
  const first = await value.service.create(scope, "run-1", "create-recovery-first", {
    candidateIds: ["candidate-1"]
  });
  await value.service.approve(scope, first.value.id, first.value.etag,
    "approve-recovery-first", {
      revision: first.value.revision,
      batchHash: first.value.batchHash,
      confirm: true
    });
  value.setNow("2026-08-25T02:01:00.000Z");
  const second = await value.service.create(scope, "run-1", "create-recovery-second", {
    candidateIds: ["candidate-2"]
  });
  const secondApproved = await value.service.approve(scope, second.value.id, second.value.etag,
    "approve-recovery-second", {
      revision: second.value.revision,
      batchHash: second.value.batchHash,
      confirm: true
    });
  const uncertain = await value.repository.claimNextAction({
    workerId: "worker-recovery-uncertain",
    now: "2026-08-25T02:02:00.000Z",
    leaseDurationMs: 180_000
  });
  assert.ok(uncertain);
  await value.repository.completeActionFailure(
    uncertain.fence,
    "douyin_action_receipt_ambiguous",
    "2026-08-25T02:03:00.000Z"
  );
  const [held] = await value.service.actions(scope, second.value.id);
  assert.ok(held);
  assert.equal(held.status, "risk_paused");
  assert.equal(held.failureCode, "account_risk_paused");
  assert.equal(held.attemptCount, 0);
  value.setAccountState("risk_paused");

  const recovered = await value.service.recoverAccountActions(
    scope,
    second.value.id,
    secondApproved.value.etag,
    "recover-account-actions-key",
    {
      batchRevision: second.value.revision,
      accountLoginStateVersion: second.value.accountLoginStateVersion,
      pendingActionIds: [held.id],
      acknowledgedUncertainActionIds: [uncertain.action.id],
      reason: "人工确认旧动作结果未知，仅恢复当前已审批且从未尝试的评论",
      confirm: true
    }
  );

  assert.equal(recovered.value.riskPaused, false);
  assert.deepEqual(recovered.value.enabledActionIds, [held.id]);
  assert.deepEqual(recovered.value.acknowledgedUncertainActionIds,
    [uncertain.action.id]);
  const firstActions = await value.service.actions(scope, first.value.id);
  assert.equal(firstActions[0]?.status, "risk_paused");
  assert.equal(firstActions[0]?.failureCode, "douyin_action_receipt_ambiguous");
  assert.equal(firstActions[0]?.attemptCount, 1);
  const next = await value.repository.claimNextAction({
    workerId: "worker-recovery-current",
    now: "2026-08-25T02:04:00.000Z",
    leaseDurationMs: 180_000
  });
  assert.equal(next?.action.id, held.id);
});

test("account recovery can clear an exact empty queue after all comments failed before submission", async () => {
  const candidateIds = ["candidate-1", "candidate-2", "candidate-3"];
  const value = fixture({ candidateIds });
  const created = await value.service.create(scope, "run-1",
    "create-empty-recovery", { candidateIds });
  const approved = await value.service.approve(scope, created.value.id,
    created.value.etag, "approve-empty-recovery", {
      revision: created.value.revision,
      batchHash: created.value.batchHash,
      confirm: true
    });

  for (const [index, claimedAt] of [
    "2026-08-25T02:01:00.000Z",
    "2026-08-25T02:02:01.000Z",
    "2026-08-25T02:03:02.000Z"
  ].entries()) {
    const claim = await value.repository.claimNextAction({
      workerId: `worker-empty-recovery-${index + 1}`,
      now: claimedAt,
      leaseDurationMs: 180_000
    });
    assert.ok(claim);
    const completed = await value.repository.completeActionFailure(
      claim.fence,
      "douyin_action_control_missing",
      new Date(Date.parse(claimedAt) + 1_000).toISOString()
    );
    assert.equal(completed.completed, true);
  }

  const before = await value.service.actionExecutionGate(scope,
    created.value.id);
  assert.equal(before.riskPaused, true);
  assert.deepEqual(before.pendingActionIds, []);
  assert.deepEqual(before.unresolvedActions, []);
  value.setAccountState("risk_paused");

  const recovered = await value.service.recoverAccountActions(
    scope,
    created.value.id,
    approved.value.etag,
    "recover-empty-account-gate",
    {
      batchRevision: created.value.revision,
      accountLoginStateVersion: created.value.accountLoginStateVersion,
      pendingActionIds: [],
      acknowledgedUncertainActionIds: [],
      reason: "三条评论均在提交前失败，人工确认队列已空后恢复账号",
      confirm: true
    }
  );

  assert.equal(recovered.value.riskPaused, false);
  assert.deepEqual(recovered.value.pendingActionIds, []);
  assert.deepEqual(recovered.value.enabledActionIds, []);
  assert.equal(await value.repository.claimNextAction({
    workerId: "worker-empty-recovery-must-not-requeue",
    now: "2026-08-25T02:10:00.000Z",
    leaseDurationMs: 180_000
  }), null);
});

test("manual reconciliation rejects disconnected or stale account authority before sidecar", async () => {
  let calls = 0;
  const value = fixture({
    reconcileAction: async (input) => {
      calls += 1;
      return {
        actionId: input.actionId,
        state: "succeeded",
        platformReceiptReference: "douyin-comment:must-not-be-used",
        occurredAt: now,
        failureCode: null
      };
    }
  });
  const created = await value.service.create(scope, "run-1", "create-reconcile-authority", {
    candidateIds: ["candidate-1"]
  });
  await value.service.approve(scope, created.value.id, created.value.etag,
    "approve-reconcile-authority", {
      revision: created.value.revision,
      batchHash: created.value.batchHash,
      confirm: true
    });
  const claim = await value.repository.claimNextAction({
    workerId: "worker-reconcile-authority",
    now: "2026-08-25T02:01:00.000Z",
    leaseDurationMs: 180_000
  });
  assert.ok(claim);
  await value.repository.completeActionFailure(
    claim.fence,
    "douyin_action_timeout",
    "2026-08-25T02:04:00.000Z"
  );
  const command = {
    batchRevision: claim.action.batchRevision,
    approvalHash: claim.action.approvalHash,
    contentHash: claim.action.contentHash,
    confirm: true as const
  };

  value.setAccountState("disconnected");
  await assert.rejects(value.service.reconcileAction(
    scope, created.value.id, claim.action.id, command
  ), (error: unknown) => error instanceof AcquisitionOutreachBatchError
    && error.code === "douyin_login_expired");

  value.setAccountState("risk_paused");
  value.setAccountVersion(4);
  await assert.rejects(value.service.reconcileAction(
    scope, created.value.id, claim.action.id, command
  ), (error: unknown) => error instanceof AcquisitionOutreachBatchError
    && error.code === "douyin_login_expired");
  assert.equal(calls, 0);
});

test("manual reconciliation fails closed before sidecar unless authority is exact and uncertain", async () => {
  let calls = 0;
  const { value, batch } = await created(fixture({
    reconcileAction: async (input) => {
      calls += 1;
      return {
        actionId: input.actionId,
        state: "succeeded",
        platformReceiptReference: "douyin-comment:must-not-be-used",
        occurredAt: now,
        failureCode: null
      };
    }
  }));
  await value.service.approve(scope, batch.id, batch.etag,
    "approve-reconcile-reject", {
      revision: batch.revision,
      batchHash: batch.batchHash,
      confirm: true
    });
  const [action] = await value.service.actions(scope, batch.id);
  assert.ok(action);

  await assert.rejects(value.service.reconcileAction(
    scope,
    batch.id,
    action.id,
    {
      batchRevision: action.batchRevision,
      approvalHash: action.approvalHash,
      contentHash: action.contentHash,
      confirm: true
    }
  ), (error: unknown) => error instanceof AcquisitionOutreachBatchError
    && error.code === "outreach_action_reconciliation_unavailable");
  assert.equal(calls, 0);
});

test("final approval fails closed before persisting actions when outreach is disabled", async () => {
  const { value, batch } = await created(fixture({
    douyinOutreachActionsEnabled: false
  }));

  await assert.rejects(
    value.service.approve(
      scope,
      batch.id,
      batch.etag,
      "approve-disabled",
      { revision: 1, batchHash: batch.batchHash, confirm: true }
    ),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_actions_disabled"
      && error.status === 503
  );
  assert.equal((await value.service.get(scope, batch.id)).state, "awaiting_approval");
  assert.equal((await value.service.actions(scope, batch.id)).length, 0);
});

test("historical actions default to server and newly approved actions freeze the explicit target", async () => {
  const historical = parseAcquisitionOutreachAction({
    id: "historical", workspaceId: "workspace-1", batchId: "batch-1",
    batchRevision: 1, candidateId: "candidate-1", accountId: "account-1",
    accountLoginStateVersion: 3, policyVersionId: "policy-9",
    localDate: "2026-08-25", kind: "comment", sequence: 1,
    status: "queued", predecessorActionId: null,
    targetPublicUrl: "https://www.douyin.com/video/video-1",
    content: "历史评论", contentHash: evidenceHash, approvalHash: draftHash,
    createdAt: now
  });
  assert.equal(historical.executionTarget, "server");

  const { value, batch } = await created(fixture({ accountExecutorMode: "desktop",
    accountExecutorDeviceIdHash: `sha256:${"a".repeat(64)}`,
    accountExecutorBindingGeneration: 1,
    accountExecutorLeaseExpiresAt: "2026-08-25T02:01:30.000Z" }));
  await value.service.approve(scope, batch.id, batch.etag, "approve-desktop-target", {
    revision: batch.revision, batchHash: batch.batchHash, confirm: true
  });
  assert.deepEqual((await value.service.actions(scope, batch.id))
    .map((action) => action.executionTarget), ["desktop"]);
});

test("approval resolves the frozen action target only from the private account binding and independent gate", async () => {
  const desktop = await created(fixture({ executionTarget: "server",
    accountExecutorMode: "desktop",
    accountExecutorDeviceIdHash: `sha256:${"a".repeat(64)}`,
    accountExecutorBindingGeneration: 4,
    accountExecutorLeaseExpiresAt: "2026-08-25T02:01:30.000Z",
    desktopExecutionEnabled: true, serverExecutionEnabled: false }));
  await desktop.value.service.approve(scope, desktop.batch.id, desktop.batch.etag,
    "approve-account-desktop", { revision: desktop.batch.revision,
      batchHash: desktop.batch.batchHash, confirm: true });
  assert.deepEqual((await desktop.value.service.actions(scope, desktop.batch.id))
    .map((action) => action.executionTarget), ["desktop"]);

  const disabled = await created(fixture({ executionTarget: "desktop",
    accountExecutorMode: "desktop",
    accountExecutorDeviceIdHash: `sha256:${"a".repeat(64)}`,
    accountExecutorBindingGeneration: 4,
    accountExecutorLeaseExpiresAt: "2026-08-25T02:01:30.000Z",
    desktopExecutionEnabled: false, serverExecutionEnabled: true }));
  await assert.rejects(disabled.value.service.approve(scope, disabled.batch.id,
    disabled.batch.etag, "approve-account-desktop-disabled", {
      revision: disabled.batch.revision, batchHash: disabled.batch.batchHash,
      confirm: true }), { code: "outreach_desktop_execution_disabled" });
  assert.equal((await disabled.value.service.actions(scope, disabled.batch.id)).length, 0);
  assert.equal((await disabled.value.service.get(scope, disabled.batch.id)).state,
    "awaiting_approval");

  const serverDisabled = await created(fixture({ accountExecutorMode: null,
    serverExecutionEnabled: false, desktopExecutionEnabled: true }));
  await assert.rejects(serverDisabled.value.service.approve(scope,
    serverDisabled.batch.id, serverDisabled.batch.etag,
    "approve-account-server-disabled", { revision: serverDisabled.batch.revision,
      batchHash: serverDisabled.batch.batchHash, confirm: true }), {
    code: "outreach_server_execution_disabled"
  });
  assert.equal((await serverDisabled.value.service.actions(scope,
    serverDisabled.batch.id)).length, 0);

  const expiredDesktop = await created(fixture({ accountExecutorMode: "desktop",
    accountExecutorDeviceIdHash: `sha256:${"a".repeat(64)}`,
    accountExecutorBindingGeneration: 2,
    accountExecutorLeaseExpiresAt: now,
    serverExecutionEnabled: true, desktopExecutionEnabled: true }));
  await assert.rejects(expiredDesktop.value.service.approve(scope,
    expiredDesktop.batch.id, expiredDesktop.batch.etag,
    "approve-expired-desktop-no-fallback", { revision: expiredDesktop.batch.revision,
      batchHash: expiredDesktop.batch.batchHash, confirm: true }), {
    code: "douyin_desktop_executor_invalid"
  });
  assert.equal((await expiredDesktop.value.service.actions(scope,
    expiredDesktop.batch.id)).length, 0);
});

test("a revoked installation fence remains desktop and cannot fall back to server", async () => {
  const revoked = await created(fixture({ accountExecutorMode: "desktop",
    accountExecutorDeviceIdHash: `sha256:${"a".repeat(64)}`,
    accountExecutorBindingGeneration: 3,
    accountExecutorLeaseExpiresAt: now,
    serverExecutionEnabled: true, desktopExecutionEnabled: true }));

  await assert.rejects(revoked.value.service.approve(scope, revoked.batch.id,
    revoked.batch.etag, "approve-revoked-desktop-no-fallback", {
      revision: revoked.batch.revision, batchHash: revoked.batch.batchHash,
      confirm: true
    }), { code: "douyin_desktop_executor_invalid" });
  assert.equal((await revoked.value.service.actions(scope, revoked.batch.id)).length, 0);
  assert.equal((await revoked.value.service.get(scope, revoked.batch.id)).state,
    "awaiting_approval");
});

test("explicit handoff is fenced by unresolved account actions across the desktop target", async () => {
  const coordinator = new AcquisitionMemoryTransactionCoordinator();
  const accountRepository = new InMemoryAcquisitionSocialAccountRepository(coordinator);
  const value = await created(fixture({ memoryTransactions: coordinator,
    accountExecutorMode: "desktop",
    accountExecutorDeviceIdHash: desktopInstallationIdHash("A".repeat(43)),
    accountExecutorBindingGeneration: 1,
    accountExecutorLeaseExpiresAt: "2026-08-25T02:01:30.000Z" }));
  const installationRepository = new InMemoryDesktopInstallationRepository({
    memoryTransactions: coordinator, socialAccounts: accountRepository,
    outreachActions: value.value.repository
  });
  for (const [installationId, suffix] of [["A".repeat(43), "a"], ["B".repeat(43), "b"]]) {
    const deviceIdHash = desktopInstallationIdHash(installationId);
    await installationRepository.createEnrollment({ workspaceId: scope.workspaceId,
      userId: "owner-1", teamId: scope.teamId, deviceIdHash, protocolVersion: 1,
      enrollmentTokenHash: `sha256:${suffix.repeat(64)}`,
      idempotencyKeyHash: suffix.repeat(64), requestHash: suffix.repeat(64),
      expiresAt: "2026-08-25T02:01:00.000Z", createdAt: now, consumedAt: null });
    await installationRepository.consumeEnrollment({ deviceIdHash,
      enrollmentTokenHash: `sha256:${suffix.repeat(64)}`,
      deviceCredentialHash: `sha256:${suffix.repeat(64)}`, protocolVersion: 1,
      consumedAt: "2026-08-25T02:00:01.000Z" });
  }
  await accountRepository.upsert({ id: "account-1", workspaceId: scope.workspaceId,
    platform: "douyin", accountHandle: `dyacct_${"d".repeat(64)}`,
    upstreamSessionId: null, displayName: "Douyin", state: "active",
    loginStateVersion: 3, loginStateVersionHighWater: 3, executorMode: "desktop",
    executorDeviceIdHash: desktopInstallationIdHash("A".repeat(43)),
    executorBindingGeneration: 1,
    executorLeaseExpiresAt: "2026-08-25T02:01:30.000Z", revision: 1,
    etag: '"account-v1"', lastValidatedAt: now, createdAt: now, updatedAt: now });
  await value.value.service.approve(scope, value.batch.id, value.batch.etag,
    "approve-before-handoff", { revision: value.batch.revision,
      batchHash: value.batch.batchHash, confirm: true });
  const claim = await value.value.repository.claimNextAction({ workerId: "desktop-worker",
    now, leaseDurationMs: 30_000, executionTarget: "desktop" });
  assert.equal(claim?.action.status, "executing");
  const installationService = new AcquisitionDesktopInstallationService({
    repository: installationRepository,
    secret: "task-3-secret-material-is-at-least-32-bytes-long",
    isActiveMembership: async () => true, now: () => "2026-08-25T02:00:10.000Z" });

  await assert.rejects(installationService.bindDesktopExecutor({
    workspaceId: scope.workspaceId, userId: "owner-1", teamId: scope.teamId
  }, "account-1", { accountHandle: `dyacct_${"d".repeat(64)}`,
    loginStateVersion: 3, installationId: "B".repeat(43), expectedGeneration: 1,
    handoff: true }, "handoff-blocked-key", "c".repeat(64)), {
    code: "desktop_executor_handoff_blocked"
  });
});

test("handoff fence recognizes every unresolved status and ignores terminal controls", async () => {
  const coordinator = new AcquisitionMemoryTransactionCoordinator();
  const value = await created(fixture({ memoryTransactions: coordinator }));
  await value.value.service.approve(scope, value.batch.id, value.batch.etag,
    "approve-handoff-status-matrix", { revision: value.batch.revision,
      batchHash: value.batch.batchHash, confirm: true });
  const internal = value.value.repository as unknown as { state: {
    actions: Map<string, AcquisitionOutreachAction[]> } };
  const action = internal.state.actions.get(
    `${scope.workspaceId}\u0000${value.batch.id}`)?.[0];
  assert.ok(action);
  for (const [status, expected] of [
    ["claimed", true], ["executing", true], ["reconciliation_required", true],
    ["queued", false], ["succeeded", false], ["failed", false],
    ["risk_paused", false]
  ] as const) {
    action.status = status;
    const blocked = await coordinator.transaction((token) =>
      value.value.repository.hasUnresolvedAccountActions(token,
        scope.workspaceId, "account-1"));
    assert.equal(blocked, expected, status);
  }
});

test("action creation service rejects malformed execution gates", () => {
  assert.throws(() => fixture({ serverExecutionEnabled: "true" as never }),
    /outreach_action_execution_gates_invalid/u);
});

test("action parser accepts the desktop bridge states and rejects unknown targets", () => {
  const base = {
    id: "action-state", workspaceId: "workspace-1", batchId: "batch-1",
    batchRevision: 1, candidateId: "candidate-1", accountId: "account-1",
    accountLoginStateVersion: 3, policyVersionId: "policy-9",
    localDate: "2026-08-25", kind: "comment", sequence: 1,
    predecessorActionId: null, targetPublicUrl: "https://www.douyin.com/video/video-1",
    content: "评论", contentHash: evidenceHash, approvalHash: draftHash,
    createdAt: now, executionTarget: "desktop"
  };
  assert.equal(parseAcquisitionOutreachAction({ ...base, status: "claimed" }).status,
    "claimed");
  assert.equal(parseAcquisitionOutreachAction({ ...base,
    status: "reconciliation_required" }).status, "reconciliation_required");
  assert.throws(() => parseAcquisitionOutreachAction({ ...base,
    status: "queued", executionTarget: "automatic" }), /outreach_action_invalid/u);
});

test("creation rejects a candidate without an exact Douyin video comment target", async () => {
  const value = fixture({
    commentTargetPublicUrl: "https://www.douyin.com/user/actor-1"
  });

  await assert.rejects(
    value.service.create(scope, "run-1", "create-invalid-target", {
      candidateIds: ["candidate-1"]
    }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_comment_target_invalid"
  );
});

test("outreach target validation accepts only byte-canonical public Douyin URLs", () => {
  assert.equal(
    validOutreachTarget(
      "comment",
      "https://www.douyin.com/video/AbC_123-xyz"
    ),
    true
  );
  assert.equal(
    validOutreachTarget("comment", "https://www.douyin.com/video/123?share=1"),
    true
  );
  assert.equal(
    validOutreachTarget("direct_message", "https://www.douyin.com/user/actor?from=video"),
    true
  );
  assert.equal(
    validOutreachTarget(
      "direct_message",
      "https://www.douyin.com/user/MS4wLjAB_creator-1"
    ),
    true
  );
  for (const [kind, target] of [
    ["comment", "https://user@www.douyin.com/video/123"],
    ["comment", "https://www.douyin.com:443/video/123"],
    ["comment", "https://WWW.douyin.com/video/123"],
    ["comment", "https://www.douyin.com/video/123#comment"],
    ["comment", "https://www.douyin.com/video/123/"],
    ["direct_message", "https://www.douyin.com/%75ser/actor"],
    ["direct_message", "https://www.douyin.com/user/actor/"],
    ["direct_message", "https://www.douyin.com/video/123"]
  ] as const) {
    assert.equal(
      validOutreachTarget(kind, target),
      false,
      `${kind} must reject non-canonical target ${target}`
    );
  }
});

test("creation rejects a candidate without an exact Douyin profile message target", async () => {
  const value = fixture({
    publicProfileUrl: "https://www.douyin.com/video/video-1"
  });

  await assert.rejects(
    value.service.create(scope, "run-1", "create-invalid-profile", {
      candidateIds: ["candidate-1"]
    }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_direct_message_target_invalid"
  );
});

test("approval rechecks the exact Douyin video comment target before queuing actions", async () => {
  const { value, batch } = await created();
  value.setCommentTargetPublicUrl("https://www.douyin.com/user/actor-1");

  await assert.rejects(
    value.service.approve(scope, batch.id, batch.etag, "approve-invalid-target", {
      revision: 1, batchHash: batch.batchHash, confirm: true
    }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_comment_target_invalid"
  );
  assert.equal((await value.service.get(scope, batch.id)).state, "awaiting_approval");
  assert.equal((await value.service.actions(scope, batch.id)).length, 0);
});

test("the selected policy limit is authoritative and remaining allowance is shared by account and local date", async () => {
  const value = fixture({ dailyLimit: 1 });
  const first = await value.service.create(scope, "run-1", "create-limit-1", { candidateIds: ["candidate-1"] });
  await value.service.approve(scope, first.value.id, first.value.etag, "approve-limit-1", {
    revision: 1, batchHash: first.value.batchHash, confirm: true
  });
  const second = await value.service.create(scope, "run-1", "create-limit-2", { candidateIds: ["candidate-1"] });
  assert.equal(second.value.dailyRemainingLimit, 0);
  await assert.rejects(
    value.service.approve(scope, second.value.id, second.value.etag, "approve-limit-2", {
      revision: 1, batchHash: second.value.batchHash, confirm: true
    }),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError && error.code === "outreach_daily_limit_exhausted"
  );
});

test("a finalized 50-candidate job queues 50 approved comments without rewriting the old 5-candidate batch", async () => {
  const crawlerJobs = new InMemoryAcquisitionCrawlerJobRepository();
  const repository = new InMemoryAcquisitionOutreachBatchRepository();
  const candidateIds = Array.from({ length: 50 }, (_, index) =>
    `candidate-${String(index + 1).padStart(2, "0")}`);
  const legacyCandidateIds = Array.from({ length: 5 }, (_, index) =>
    `legacy-${index + 1}`);
  const profileUrl = (candidateId: string) => `https://www.douyin.com/user/${candidateId}`;
  const targetUrl = (candidateId: string) => `https://www.douyin.com/video/${candidateId}`;
  async function finalizedJob(id: string, dailyCandidateLimit: number, ids: string[]) {
    await crawlerJobs.createOrGet({
      id: `crawler-${id}`, workspaceId: scope.workspaceId, runId: `run-${id}`,
      automationIntentId: `intent-${id}`, planId: "plan-1",
      planVersionId: "plan-version-2", planSnapshotHash: `sha256:${"1".repeat(64)}`,
      policyVersionId: `policy-${id}`, policyHash: `sha256:${id.repeat(64)}`,
      accountId: "account-1", accountLoginStateVersion: 3,
      dailyBudgetId: `sha256:${id.repeat(64)}`, localDate: "2026-08-25",
      trigger: "run_now", dailyCandidateLimit,
      keywords: ["获客方案"], collectCreators: true, collectDemandComments: true,
      limits: { maxVideos: 30, maxCommentsPerVideo: 50,
        maxPagesPerVideo: 3, maxDurationSeconds: 3_600 },
      createdAt: now
    });
    await crawlerJobs.enqueue(scope.workspaceId, `run-${id}`, now);
    const claim = await crawlerJobs.claimNext("fixture-crawler", now, 30_000);
    assert.ok(claim);
    const records = ids.map((candidateId) => {
      const record = { recordId: candidateId, kind: "comment" as const,
        actorKind: "commenter" as const, canonicalUrl: targetUrl(candidateId),
        publicDisplayName: candidateId, publicProfileUrl: profileUrl(candidateId),
        textExcerpt: "需要获客方案", sourceKeyword: "获客方案",
        observedAt: now, contentHash: "" };
      record.contentHash = normalizedDouyinContentHash(record);
      return record;
    });
    await crawlerJobs.persistPage(claim.fence, {
      expectedCursor: null, nextCursor: null, records, done: true, now,
      terminalActivity: { phase: "completed", currentKeyword: null,
        browserMode: "visible", sequence: 1 }
    });
    const ingestion = await crawlerJobs.claimNextIngestion("fixture-ingester", now, 30_000);
    assert.ok(ingestion);
    return crawlerJobs.completeIngestion(ingestion.fence, now, now, now);
  }
  const service = new AcquisitionOutreachBatchService({
    repository, douyinOutreachActionsEnabled: true,
    serverExecutionEnabled: false, desktopExecutionEnabled: true,
    idFactory: (kind) => `${kind}-${crypto.randomUUID()}`, now: () => now,
    async loadRunAuthority(requestedScope, runId) {
      const job = await crawlerJobs.findByRun(requestedScope.workspaceId, runId);
      if (!job) return null;
      return { workspaceId: job.workspaceId, runId: job.runId,
        planId: job.planId, planVersionId: job.planVersionId, planVersion: 2,
        planSnapshotHash: job.planSnapshotHash, policyVersionId: job.policyVersionId,
        policyHash: job.policyHash, accountId: job.accountId,
        accountLoginStateVersion: job.accountLoginStateVersion,
        dailyBudgetId: job.dailyBudgetId, localDate: job.localDate, timeZone: "UTC",
        dailyCandidateLimit: job.dailyCandidateLimit,
        finalizationState: crawlerOutreachFinalizationState(job) };
    },
    async listRunCandidateIds(requestedScope, runId) {
      const job = await crawlerJobs.findByRun(requestedScope.workspaceId, runId);
      return job ? (await crawlerJobs.listRecords(job.id)).map((record) => record.recordId) : [];
    },
    async generateDraft(_requestedScope, candidateId) {
      return { candidateId, candidateRevision: 1, evidenceHashes: [evidenceHash],
        comment: "看到你公开提到需要获客方案", directMessage: "如你愿意，可交流公开场景里的思路",
        rationaleCodes: ["evidence_grounded"], modelSnapshotId: "model-job-1",
        contentHash: draftHash };
    },
    async loadCandidateAuthority(_requestedScope, candidateId) {
      return { candidateId, candidateRevision: 1, evidenceHashes: [evidenceHash],
        evidenceText: ["需要获客方案"], publicActorKey: `actor-${candidateId}`,
        publicProfileUrl: profileUrl(candidateId), commentTargetPublicUrl: targetUrl(candidateId),
        doNotContact: false };
    },
    async loadAccountAuthority() {
      return { accountId: "account-1", state: "active", loginStateVersion: 3,
        accountHandle: `dyacct_${"d".repeat(64)}`, displayName: "测试抖音账号",
        executorMode: "desktop", executorDeviceIdHash: `sha256:${"e".repeat(64)}`,
        executorBindingGeneration: 1, executorLeaseExpiresAt: "2026-08-25T03:00:00.000Z" };
    }
  });
  const legacyJob = await finalizedJob("5", 5, legacyCandidateIds);
  const legacy = await service.create(scope, legacyJob.runId, "create-legacy-5", {
    candidateIds: legacyCandidateIds
  });
  assert.equal(legacy.value.dailyCandidateLimit, 5);
  assert.equal(legacy.value.candidates.length, 5);
  const frozenLegacyBatch = await repository.find(scope.workspaceId, legacy.value.id);
  const currentJob = await finalizedJob("a", 50, candidateIds);
  assert.equal(currentJob.dailyCandidateLimit, 50);
  assert.equal(currentJob.candidateBudgetUsed, 50);
  const createdBatch = await service.create(scope, currentJob.runId, "create-comments-50", {
    candidateIds
  });
  const batch = createdBatch.value;
  assert.equal(batch.dailyCandidateLimit, 50);
  assert.equal(batch.dailyRemainingLimit, 50);
  assert.deepEqual(batch.candidates.filter((candidate) => candidate.selected)
    .map((candidate) => candidate.candidateId), candidateIds);
  assert.deepEqual(await repository.listActions(scope.workspaceId, batch.id), []);
  const command = { revision: batch.revision, batchHash: batch.batchHash, confirm: true as const };
  const approved = await service.approve(scope, batch.id, batch.etag, "approve-comments-50", command);
  assert.equal(approved.value.state, "approved");
  assert.equal(approved.value.dailyRemainingLimit, 0);
  const replay = await service.approve(scope, batch.id, batch.etag, "approve-comments-50", command);
  assert.equal(replay.replayed, true);
  const actions = await service.actions(scope, batch.id);
  assert.equal(actions.length, 50);
  assert.equal(new Set(actions.map((action) => action.id)).size, 50);
  assert.deepEqual(actions.map((action) => action.candidateId).sort(), candidateIds);
  for (const action of actions) {
    assert.equal(action.kind, "comment");
    assert.equal(action.status, "queued");
    assert.equal(action.attemptCount, 0);
    assert.equal(action.platformReceiptReference, null);
    assert.equal(action.executionTarget, "desktop");
    assert.equal(action.predecessorActionId, null);
    assert.equal(action.policyVersionId, currentJob.policyVersionId);
    assert.equal(action.targetPublicUrl, targetUrl(action.candidateId));
    assert.equal(action.content, "看到你公开提到需要获客方案");
    assert.equal(action.approvalHash, approved.value.approvalHash);
  }
  await assert.rejects(service.approve(scope, legacy.value.id, legacy.value.etag,
    "approve-legacy-after-50", { revision: legacy.value.revision,
      batchHash: legacy.value.batchHash, confirm: true }),
  (error: unknown) => error instanceof AcquisitionOutreachBatchError
    && error.code === "outreach_daily_limit_exhausted");
  assert.equal((await crawlerJobs.findByRun(scope.workspaceId, legacyJob.runId))?.dailyCandidateLimit, 5);
  assert.deepEqual(await repository.find(scope.workspaceId, legacy.value.id), frozenLegacyBatch);
  assert.deepEqual(await repository.listActions(scope.workspaceId, legacy.value.id), []);
});

test("approval rechecks DNC, candidate revision/evidence, and account login authority", async () => {
  for (const mutate of [
    (value: ReturnType<typeof fixture>) => value.setDnc(true),
    (value: ReturnType<typeof fixture>) => value.setCandidateRevision(2),
    (value: ReturnType<typeof fixture>) => value.setAccountVersion(4)
  ]) {
    const { value, batch } = await created();
    mutate(value);
    await assert.rejects(
      value.service.approve(scope, batch.id, batch.etag, `approve-recheck-${crypto.randomUUID()}`, {
        revision: 1, batchHash: batch.batchHash, confirm: true
      }),
      (error: unknown) => error instanceof AcquisitionOutreachBatchError
        && ["candidate_evidence_invalid", "douyin_login_expired"].includes(error.code)
    );
    assert.equal((await value.service.actions(scope, batch.id)).length, 0);
  }
});

test("cross-workspace access is rejected and two approvers produce one winner", async () => {
  const { value, batch } = await created();
  await assert.rejects(
    value.service.get({ ...scope, workspaceId: "workspace-2" }, batch.id),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError && error.code === "outreach_batch_not_found"
  );
  const command = { revision: 1, batchHash: batch.batchHash, confirm: true as const };
  const outcomes = await Promise.allSettled([
    value.service.approve(scope, batch.id, batch.etag, "approver-race-1", command),
    value.service.approve({ ...scope, actorId: "approver-2" }, batch.id, batch.etag, "approver-race-2", command)
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
  assert.equal((await value.service.actions(scope, batch.id)).length, 1);
});

test("memory approval is failure-atomic when the comment action insert fails", async () => {
  const { value, batch } = await created(fixture({ failActionInsertAt: 1 }));
  await assert.rejects(value.service.approve(scope, batch.id, batch.etag, "approve-fail-comment", {
    revision: 1, batchHash: batch.batchHash, confirm: true
  }), /test_action_insert_failure/u);
  assert.equal((await value.service.get(scope, batch.id)).state, "awaiting_approval");
  assert.equal((await value.service.actions(scope, batch.id)).length, 0);
});

test("memory batch transaction shares a reentrant authority coordinator with DNC writers", async () => {
  const coordinator = new AcquisitionMemoryTransactionCoordinator();
  const repository = new InMemoryAcquisitionOutreachBatchRepository({ memoryTransactions: coordinator });
  const ordering: string[] = [];
  const completed = coordinator.transaction(async () => {
    ordering.push("outer");
    await coordinator.transaction(() => { ordering.push("nested-authority"); });
    await repository.remaining("workspace-1", "account-1", "2026-08-25", 50);
  });
  await assert.doesNotReject(Promise.race([
    completed,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("memory_authority_deadlock")), 100))
  ]));
  assert.deepEqual(ordering, ["outer", "nested-authority"]);
});

test("memory DM approval and a concurrent real DNC writer complete without lock-order deadlock", async () => {
  const coordinator = new AcquisitionMemoryTransactionCoordinator();
  const domain = new InMemoryAcquisitionDomainRepository();
  const plans = new InMemoryAcquisitionPlanRunRepository(coordinator);
  const dnc = new InMemoryAcquisitionDouyinCrawlerIngestionRepository(domain, plans);
  const finalAuthority = new InMemoryAcquisitionOutreachDraftFinalAuthority({
    domain, doNotContact: dnc
  });
  const repository = new InMemoryAcquisitionOutreachBatchRepository({
    memoryTransactions: coordinator,
    memoryDomainTransactions: domain
  } as never);
  const candidate = {
    id: "candidate-lock-order", ownerId: scope.ownerId, teamId: scope.teamId,
    partyType: "individual", partyRef: { partyType: "individual",
      individualPartyId: "individual-lock-order", demandSignalId: "signal-lock-order" },
    version: 1, status: "needs_research", evidenceIds: ["evidence-lock-order"],
    profile: { kind: "individual", publicActorKey: "actor-lock-order",
      publicDisplayName: "并发潜客",
      publicProfileUrl: "https://www.douyin.com/user/actor-lock-order",
      sourcePlatform: "douyin", demandCategory: "public_business_demand",
      demandSummary: "公开需求", locationHint: "", buyingStage: "solution_research",
      negativeSignals: [] }, latestDecisionId: null, latestDecisionVersion: null,
    approvedDecisionVersion: null, hardGateFailures: [], leadId: null,
    createdAt: now, updatedAt: now
  } as const;
  const evidence = {
    id: "evidence-lock-order", ownerId: scope.ownerId, teamId: scope.teamId,
    targetType: "individual_signal", sourcePlatform: "douyin", sourceTitle: "获客",
    sourceSnippet: "公开提到需要获客方案", publishedAt: now, locale: "zh-CN",
    rawArtifactHash: evidenceHash, contentHash: evidenceHash,
    provenance: { kind: "mediacrawler_public_record",
      sourceUrl: "https://www.douyin.com/video/video-lock-order", jobId: "job-lock-order",
      recordId: "record-lock-order", actorKind: "commenter", cursor: "cursor-lock-order",
      upstreamCommit: "commit-lock-order" }, accessStatus: "public_content",
    supersedesEvidenceId: null, fetchedAt: now
  } as const;
  await domain.appendEvidence(structuredClone(evidence) as never);
  await domain.insertCandidate(structuredClone(candidate) as never);

  let holdCandidateAuthority = false;
  let approvalEnteredResolve!: () => void;
  const approvalEntered = new Promise<void>((resolve) => { approvalEnteredResolve = resolve; });
  let releaseApprovalResolve!: () => void;
  const releaseApproval = new Promise<void>((resolve) => { releaseApprovalResolve = resolve; });
  const loadCandidateAuthority = async () => {
    if (holdCandidateAuthority) {
      approvalEnteredResolve();
      await releaseApproval;
    }
    const current = await domain.findCandidate(scope, candidate.id);
    const currentEvidence = await domain.findEvidence(scope, evidence.id);
    if (!current || !currentEvidence || current.profile.kind !== "individual") return null;
    const verified = await finalAuthority.verify({ scope, candidateId: candidate.id,
      evidenceIds: [evidence.id], publicActorKey: candidate.profile.publicActorKey,
      expectedCandidate: current, expectedEvidence: [currentEvidence] });
    return { candidateId: verified.candidate.id,
      candidateRevision: verified.candidate.version,
      evidenceHashes: verified.evidence.map((value) => value.contentHash),
      evidenceText: verified.evidence.map((value) => value.sourceSnippet),
      publicActorKey: candidate.profile.publicActorKey,
      publicProfileUrl: candidate.profile.publicProfileUrl,
      commentTargetPublicUrl: evidence.provenance.sourceUrl,
      doNotContact: false };
  };
  const service = new AcquisitionOutreachBatchService({ repository,
    approveDirectMessages: (input) => repository.approveDirectMessages(input),
    douyinOutreachActionsEnabled: true,
    serverExecutionEnabled: true, desktopExecutionEnabled: false,
    idFactory: (kind) => `${kind}-${crypto.randomUUID()}`, now: () => now,
    loadRunAuthority: async () => ({ workspaceId: scope.workspaceId, runId: "run-lock-order",
      planId: "plan-lock-order", planVersionId: "plan-version-lock-order", planVersion: 1,
      planSnapshotHash: `sha256:${"1".repeat(64)}`, policyVersionId: "policy-lock-order",
      policyHash: `sha256:${"2".repeat(64)}`, accountId: "account-lock-order",
      accountLoginStateVersion: 1, dailyBudgetId: `sha256:${"3".repeat(64)}`,
      localDate: "2026-08-25", timeZone: "UTC", dailyCandidateLimit: 20,
      finalizationState: "ready" }),
    listRunCandidateIds: async () => [candidate.id],
    generateDraft: async () => ({ candidateId: candidate.id, candidateRevision: 1,
      evidenceHashes: [evidenceHash], comment: "公开评论", directMessage: "精确私信",
      rationaleCodes: ["evidence_grounded"], modelSnapshotId: "model-lock-order",
      contentHash: draftHash }),
    loadCandidateAuthority,
    loadAccountAuthority: async () => ({ accountId: "account-lock-order", state: "active",
      loginStateVersion: 1, accountHandle: `dyacct_${"d".repeat(64)}`,
      displayName: "并发测试账号", executorMode: null,
      executorDeviceIdHash: null, executorBindingGeneration: 0,
      executorLeaseExpiresAt: null })
  });
  const created = await service.create(scope, "run-lock-order", "create-lock-order", {
    candidateIds: [candidate.id]
  });
  const approved = await service.approve(scope, created.value.id, created.value.etag,
    "approve-comment-lock-order", { revision: 1, batchHash: created.value.batchHash,
      confirm: true });
  const comment = await repository.claimNextAction({ workerId: "comment-lock-order",
    now: "2026-08-25T02:01:00.000Z", leaseDurationMs: 180_000 });
  assert.ok(comment);
  await repository.completeActionSuccess(comment.fence, {
    platformReceiptReference: "douyin-comment:lock-order", occurredAt: now
  });

  holdCandidateAuthority = true;
  const approval = service.approveDirectMessages(scope, approved.value.id,
    approved.value.etag, "approve-dm-lock-order", {
      batchRevision: 1, batchHash: approved.value.batchHash,
      commentApprovalHash: approved.value.approvalHash!, dailyLimit: 20,
      candidates: [{ candidateId: candidate.id, directMessage: "精确私信" }], confirm: true
    });
  await approvalEntered;
  let writerHasDomainResolve!: () => void;
  const writerHasDomain = new Promise<void>((resolve) => { writerHasDomainResolve = resolve; });
  const writer = domain.transaction(async () => {
    writerHasDomainResolve();
    await dnc.transaction(scope, async () => {
      await dnc.retainDoNotContact(scope.workspaceId,
        douyinDoNotContactIdentityHash(candidate.profile.publicActorKey), "explicit_refusal");
    });
  });
  await Promise.race([writerHasDomain,
    new Promise<void>((resolve) => setTimeout(resolve, 20))]);
  releaseApprovalResolve();

  await assert.doesNotReject(Promise.race([
    Promise.all([approval, writer]),
    new Promise<never>((_resolve, reject) => setTimeout(() =>
      reject(new Error("memory_dm_dnc_lock_order_deadlock")), 500))
  ]));
});

test("rejection and approved pause/resume are revision-bound state transitions", async () => {
  const first = await created();
  const rejected = await first.value.service.reject(scope, first.batch.id, first.batch.etag, "reject-key-1", { reason: "not suitable" });
  assert.equal(rejected.value.state, "rejected");
  const second = await created();
  const approved = await second.value.service.approve(scope, second.batch.id, second.batch.etag, "approve-state-1", {
    revision: 1, batchHash: second.batch.batchHash, confirm: true
  });
  const paused = await second.value.service.pause(scope, second.batch.id, approved.value.etag, "pause-key-1", { reason: "operator review" });
  assert.equal(paused.value.state, "paused");
  assert.notEqual(paused.value.etag, approved.value.etag);
  await assert.rejects(
    second.value.service.resume(scope, second.batch.id, approved.value.etag,
      "resume-stale-key-1", {}),
    (error: unknown) => error instanceof AcquisitionOutreachBatchError
      && error.code === "outreach_batch_stale"
  );
  const resumed = await second.value.service.resume(scope, second.batch.id, paused.value.etag, "resume-key-1", {});
  assert.equal(resumed.value.state, "approved");
  assert.notEqual(resumed.value.etag, paused.value.etag);
});
