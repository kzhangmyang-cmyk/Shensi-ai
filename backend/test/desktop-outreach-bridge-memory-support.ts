import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import express from "express";
import type {} from "../src/auth.js";
import { AcquisitionDesktopInstallationService } from "../src/acquisition-desktop-installation-service.js";
import { InMemoryDesktopInstallationRepository, type DesktopInstallationRepository } from "../src/acquisition-desktop-installation-repository.js";
import { AcquisitionMemoryTransactionCoordinator } from "../src/acquisition-memory-transaction-coordinator.js";
import { InMemoryAcquisitionOutreachBatchRepository, type AcquisitionOutreachBatchRepository,
  type AcquisitionDesktopOutreachRepository } from "../src/acquisition-outreach-batch-repository.js";
import { InMemoryAcquisitionSocialAccountRepository, type AcquisitionSocialAccountRepository } from "../src/acquisition-social-account-repository.js";
import { AcquisitionDesktopOutreachSync } from "../src/acquisition-desktop-outreach-sync.js";
import { createAcquisitionDesktopOutreachSyncRouter } from "../src/acquisition-desktop-outreach-sync-router.js";
import { outreachContentHash, outreachDirectMessageApprovalHash, outreachIndependentDirectMessageApprovalHash,
  type AcquisitionOutreachAction, type AcquisitionOutreachBatch } from "../src/acquisition-outreach-batch.js";

// Frozen data/HTTP wiring shared by Memory and explicitly guarded MySQL tests.
// The default factory remains Memory and produces no MySQL acceptance evidence.
export const bridgeScope = { workspaceId: "workspace-bridge", userId: "user-bridge", teamId: "team-bridge" };
export const bridgeAccount = { accountId: "account-bridge", accountHandle: `dyacct_${"a".repeat(64)}`,
  loginStateVersion: 3 };
export const bridgeComment = "frozen integration comment";
export const bridgeMessage = "private integration message never exposed to Renderer";
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export async function createBridgeMemoryBackend(now: () => string, options: { comment?: boolean } = {}) {
  const memoryTransactions = new AcquisitionMemoryTransactionCoordinator();
  const socialAccounts = new InMemoryAcquisitionSocialAccountRepository(memoryTransactions);
  const installationLinks: ConstructorParameters<typeof InMemoryDesktopInstallationRepository>[0] = {
    memoryTransactions, socialAccounts
  };
  const installations = new InMemoryDesktopInstallationRepository(installationLinks);
  const repository = new InMemoryAcquisitionOutreachBatchRepository({ memoryTransactions, socialAccounts,
    desktopInstallations: installations, desktopTaskTokenKey: Buffer.from("bridge-memory-task-key-at-least-thirty-two-bytes") });
  installationLinks.outreachActions = repository;
  return createBridgeBackend(now, () => ({ socialAccounts, installations, repository }), options);
}

export async function createBridgeBackend(now: () => string, repositories: () => {
  socialAccounts: AcquisitionSocialAccountRepository;
  installations: DesktopInstallationRepository;
  repository: AcquisitionOutreachBatchRepository & AcquisitionDesktopOutreachRepository;
}, options: { comment?: boolean } = {}) {
  let { socialAccounts, installations, repository } = repositories();
  const makeInstallationService = () => new AcquisitionDesktopInstallationService({ repository: installations,
    secret: "bridge-test-installation-secret-at-least-thirty-two-bytes", now, isActiveMembership: async () => true });
  let installationService = makeInstallationService();
  await socialAccounts.upsert({ id: bridgeAccount.accountId, workspaceId: bridgeScope.workspaceId,
    platform: "douyin", accountHandle: bridgeAccount.accountHandle, upstreamSessionId: null,
    displayName: "private identity display", state: "active", loginStateVersion: 3, loginStateVersionHighWater: 3,
    executorMode: "server", executorDeviceIdHash: null, executorBindingGeneration: 0, executorLeaseExpiresAt: null,
    revision: 1, etag: '"account:1"', lastValidatedAt: now(), createdAt: now(), updatedAt: now() });
  const comment: AcquisitionOutreachAction = { id: "bridge-comment", workspaceId: bridgeScope.workspaceId,
    batchId: "bridge-batch", batchRevision: 1, candidateId: "bridge-candidate", accountId: bridgeAccount.accountId,
    accountLoginStateVersion: 3, policyVersionId: "policy-v1", localDate: now().slice(0, 10), kind: "comment",
    executionTarget: "desktop", sequence: 1, status: "queued", predecessorActionId: null,
    targetPublicUrl: "https://www.douyin.com/video/bridge-candidate", content: bridgeComment,
    contentHash: outreachContentHash(bridgeComment), approvalHash: hash("comment-approval"), createdAt: now() };
  const batch: AcquisitionOutreachBatch = { id: "bridge-batch", workspaceId: bridgeScope.workspaceId,
    runId: "run-1", planId: "plan-1", planVersionId: "plan-v1", planVersion: 1, planSnapshotHash: hash("plan"),
    policyVersionId: "policy-v1", policyHash: hash("policy"), accountId: bridgeAccount.accountId,
    accountLoginStateVersion: 3, dailyBudgetId: "budget-1", localDate: now().slice(0, 10), timeZone: "UTC",
    dailyCandidateLimit: 50, dailyRemainingLimit: 49, revision: 1, etag: '"batch:1"', state: "approved",
    candidates: [{ candidateId: "bridge-candidate", selected: true, candidateRevision: 1,
      evidenceHashes: [hash("evidence")], evidenceText: ["公开需求"], publicActorKey: "public-actor",
      publicProfileUrl: "https://www.douyin.com/user/bridge-candidate", commentTargetPublicUrl: comment.targetPublicUrl,
      draftRevision: 1, comment: bridgeComment, commentHash: comment.contentHash, directMessage: bridgeMessage,
      directMessageHash: outreachContentHash(bridgeMessage), rationaleCodes: ["evidence_grounded"],
      modelSnapshotId: "model-1", sourceModelSnapshotId: "model-1", contentHash: hash("draft") }],
    batchHash: hash("batch"), approvedBy: bridgeScope.userId, approvedAt: now(), approvalHash: comment.approvalHash,
    rejectedBy: null, rejectedAt: null, rejectionReason: null, pauseReason: null,
    createdBy: bridgeScope.userId, createdAt: now(), updatedBy: bridgeScope.userId, updatedAt: now() };
  const draft = { ...batch, state: "awaiting_approval" as const, approvedBy: null, approvedAt: null, approvalHash: null };
  assert.equal((await repository.create({ workspaceId: batch.workspaceId, operation: "create", idempotencyKey: "create-bridge",
    requestHash: hash("create"), batch: draft })).kind, "created");
  if (options.comment !== false) assert.equal((await repository.approve({ workspaceId: batch.workspaceId, batchId: batch.id, ifMatch: draft.etag,
    idempotencyKey: "approve-bridge", requestHash: hash("approve"), async build() { return { batch, actions: [comment] }; } })).kind, "created");
  const makeSync = () => new AcquisitionDesktopOutreachSync({ repository, installationService,
    authority: { async resolve(snapshot) { return snapshot.account.accountHandle
      ? { accountHandle: snapshot.account.accountHandle } : null; } },
    now, actionDeadlineMs: 150_000, leaseDurationMs: 180_000 });
  let sync = makeSync();
  const app = express();
  app.use(express.json());
  app.use("/api/v1/acquisition", createAcquisitionDesktopOutreachSyncRouter({ installationService: {
    createEnrollment: (...args) => installationService.createEnrollment(...args),
    register: (...args) => installationService.register(...args),
    authenticateDevice: (...args) => installationService.authenticateDevice(...args),
    bindDesktopExecutor: (...args) => installationService.bindDesktopExecutor(...args),
    getDesktopBindingStatus: (...args) => installationService.getDesktopBindingStatus(...args)
  },
    outreachSync: { claim: (...args) => sync.claim(...args), complete: (...args) => sync.complete(...args),
      reconcile: (...args) => sync.reconcile(...args) }, desktopExecutionEnabled: true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { origin: `http://127.0.0.1:${address.port}`,
    get installationService() { return installationService; }, get repository() { return repository; },
    restartService() {
      ({ socialAccounts, installations, repository } = repositories());
      installationService = makeInstallationService(); sync = makeSync();
    },
    actions: () => repository.listActions(batch.workspaceId, batch.id),
    async bind(installationId: string, expectedGeneration = 0, handoff = false) {
      return installationService.bindDesktopExecutor(bridgeScope, bridgeAccount.accountId, {
        ...bridgeAccount, installationId, expectedGeneration, handoff
      }, `binding-${installationId}-${expectedGeneration}`, "c".repeat(64));
    },
    async approveIndependentMessage() {
      const current = await repository.find(batch.workspaceId, batch.id); assert.ok(current);
      const approvedAt = now();
      const content = "independent edited message";
      return repository.approveDirectMessages({ workspaceId: batch.workspaceId, batchId: batch.id,
        ifMatch: current.etag, idempotencyKey: "approve-independent-message", requestHash: hash("independent"),
        accountLoginStateVersion: 3, candidates: [{ candidateId: "bridge-candidate", directMessage: content }],
        dailyLimit: 20, approvedBy: bridgeScope.userId, approvedAt,
        async build(frozen, predecessors, ordinals, dailyLocalDate) {
          assert.equal(predecessors.length, 0);
          return { batch: frozen, actions: [{ ...comment, id: "independent-message", kind: "direct_message",
            sequence: 2, predecessorActionId: null, status: "queued", localDate: dailyLocalDate,
            targetPublicUrl: "https://www.douyin.com/user/bridge-candidate", content,
            contentHash: outreachContentHash(content), authorizationVersion: 3,
            approvedBy: bridgeScope.userId, approvedAt, createdAt: approvedAt,
            directMessageDailyLimit: 20, directMessageDailyOrdinal: ordinals[0]!,
            approvalHash: outreachIndependentDirectMessageApprovalHash({ authorizationVersion: 3,
              batchId: frozen.id, batchRevision: frozen.revision, batchHash: frozen.batchHash,
              candidateId: comment.candidateId, accountId: bridgeAccount.accountId, accountLoginStateVersion: 3,
              targetPublicUrl: "https://www.douyin.com/user/bridge-candidate", directMessage: content,
              directMessageHash: outreachContentHash(content), dailyLimit: 20, dailyOrdinal: ordinals[0]!,
              approvedBy: bridgeScope.userId, approvedAt }) }] };
        }
      });
    },
    async approveMessage() {
      const approvedAt = now();
      return repository.approveDirectMessages({ workspaceId: batch.workspaceId, batchId: batch.id, ifMatch: batch.etag,
        idempotencyKey: "approve-bridge-message", requestHash: hash("approve-message"),
        candidates: [{ candidateId: "bridge-candidate", directMessage: bridgeMessage }], dailyLimit: 20,
        approvedBy: bridgeScope.userId, approvedAt,
        async build(current, predecessors, ordinals, dailyLocalDate) {
          const predecessor = predecessors[0]!;
          const message: AcquisitionOutreachAction = { ...comment, id: "bridge-message", kind: "direct_message",
            sequence: 2, status: "queued", predecessorActionId: predecessor.id, localDate: dailyLocalDate,
            targetPublicUrl: "https://www.douyin.com/user/bridge-candidate", content: bridgeMessage,
            contentHash: outreachContentHash(bridgeMessage), authorizationVersion: 2, approvedBy: bridgeScope.userId,
            approvedAt, directMessageDailyLimit: 20, directMessageDailyOrdinal: ordinals[0]!, createdAt: approvedAt,
            approvalHash: outreachDirectMessageApprovalHash({ authorizationVersion: 2, batchId: current.id,
              batchRevision: current.revision, batchHash: current.batchHash, commentApprovalHash: current.approvalHash!,
              candidateId: comment.candidateId, accountId: bridgeAccount.accountId, accountLoginStateVersion: 3,
              targetPublicUrl: "https://www.douyin.com/user/bridge-candidate", directMessage: bridgeMessage,
              directMessageHash: outreachContentHash(bridgeMessage), predecessorActionId: predecessor.id,
              predecessorReceiptReference: predecessor.platformReceiptReference!, dailyLimit: 20,
              dailyOrdinal: ordinals[0]!, approvedBy: bridgeScope.userId, approvedAt }) };
          return { batch: current, actions: [message] };
        } });
    },
    async close() { await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }); }
  };
}
