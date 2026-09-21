import assert from "node:assert/strict";
import test from "node:test";

import { createAcquisitionOutreachActionAuthority } from
  "./acquisition-outreach-action-authority.js";
import type { DesktopOutreachClaimAuthoritySnapshot } from
  "./acquisition-outreach-batch-repository.js";
import type { AcquisitionOutreachAction, AcquisitionOutreachBatch } from
  "./acquisition-outreach-batch.js";
import { outreachContentHash, outreachIndependentDirectMessageApprovalHash } from "./acquisition-outreach-batch.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;
const batch: AcquisitionOutreachBatch = {
  id: "batch-1", workspaceId: "workspace-1", runId: "run-1", planId: "plan-1",
  planVersionId: "plan-version-1", planVersion: 1, planSnapshotHash: hash("1"),
  policyVersionId: "policy-1", policyHash: hash("2"), accountId: "account-1",
  accountLoginStateVersion: 3, dailyBudgetId: hash("3"), localDate: "2026-09-03",
  timeZone: "UTC", dailyCandidateLimit: 50, dailyRemainingLimit: 49, revision: 1,
  etag: "etag", state: "approved", candidates: [{ candidateId: "candidate-1",
    selected: true, candidateRevision: 4, evidenceHashes: [hash("4")],
    evidenceText: ["公开需求"], publicActorKey: "actor-key",
    publicProfileUrl: "https://www.douyin.com/user/candidate-1",
    commentTargetPublicUrl: "https://www.douyin.com/video/video-1", draftRevision: 1,
    comment: "评论", commentHash: hash("5"), directMessage: "私信",
    directMessageHash: hash("6"), rationaleCodes: ["evidence_grounded"],
    modelSnapshotId: "model-1", sourceModelSnapshotId: "model-1", contentHash: hash("7") }],
  batchHash: hash("8"), approvedBy: "approver", approvedAt: "2026-09-03T00:00:00.000Z",
  approvalHash: hash("9"), rejectedBy: null, rejectedAt: null, rejectionReason: null,
  pauseReason: null, createdBy: "approver", createdAt: "2026-09-03T00:00:00.000Z",
  updatedBy: "approver", updatedAt: "2026-09-03T00:00:00.000Z"
};
const action: AcquisitionOutreachAction = {
  id: "action-1", workspaceId: batch.workspaceId, batchId: batch.id,
  batchRevision: batch.revision, candidateId: "candidate-1", accountId: batch.accountId,
  accountLoginStateVersion: batch.accountLoginStateVersion,
  policyVersionId: batch.policyVersionId, localDate: batch.localDate,
  kind: "comment", sequence: 1, status: "queued", executionTarget: "server",
  predecessorActionId: null, targetPublicUrl: batch.candidates[0]!.commentTargetPublicUrl,
  content: batch.candidates[0]!.comment, contentHash: batch.candidates[0]!.commentHash,
  approvalHash: batch.approvalHash!, createdAt: batch.approvedAt!
};

function fixture() {
  let dnc = false;
  let coreReads = 0;
  let lockedLoads = 0;
  const scopes: unknown[] = [];
  const authority = createAcquisitionOutreachActionAuthority({
    findBatch: async () => { coreReads += 1; return batch; },
    listActions: async () => { coreReads += 1; return [action]; },
    findAccount: async () => { coreReads += 1; return { state: "active",
      accountHandle: `dyacct_${"a".repeat(64)}`, displayName: "账号",
      loginStateVersion: 3 }; },
    findRun: async () => ({ id: "run-1", ownerId: "owner-1", teamId: "team-1" }),
    findCrawlerJob: async () => ({ state: "succeeded", ingestionState: "succeeded",
      aliasGeneration: 1, projectedAliasGeneration: 1, planId: "plan-1",
      planVersionId: "plan-version-1", planSnapshotHash: hash("1"),
      policyVersionId: "policy-1", policyHash: hash("2"), accountId: "account-1",
      accountLoginStateVersion: 3, dailyBudgetId: hash("3"),
      localDate: "2026-09-03", dailyCandidateLimit: 50 }),
    listPolicyVersions: async () => [{ id: "policy-1", policyHash: hash("2"),
      schedule: { timeZone: "UTC" } }],
    findCandidate: async (scope) => { scopes.push(scope); return { version: 4,
      status: "qualified", profile: { kind: "individual", publicActorKey: "actor-key",
        publicProfileUrl: "https://www.douyin.com/user/candidate-1" },
      evidenceIds: ["evidence-1"] }; },
    findEvidence: async () => ({ id: "evidence-1", contentHash: hash("4"),
      sourcePlatform: "douyin", provenance: { kind: "mediacrawler_public_record",
        sourceUrl: "https://www.douyin.com/video/video-1" } }),
    hasDoNotContact: async () => dnc,
    loadLockedCandidateAuthority: async () => {
      lockedLoads += 1;
      if (dnc) return null;
      return { candidate: { version: 4, status: "qualified",
        profile: { kind: "individual", publicActorKey: "actor-key",
          publicProfileUrl: "https://www.douyin.com/user/candidate-1" },
        evidenceIds: ["evidence-1"] } as never,
      evidence: [{ id: "evidence-1", contentHash: hash("4"),
        sourcePlatform: "douyin", provenance: { kind: "mediacrawler_public_record",
          sourceUrl: "https://www.douyin.com/video/video-1" } } as never] };
    }
  });
  return { authority, scopes, coreReads: () => coreReads,
    lockedLoads: () => lockedLoads,
    setDnc(value: boolean) { dnc = value; } };
}

test("v3 final authority binds the current login and independently edited DM without approving comments", async () => {
  const value = fixture();
  const draft = { ...batch, state: "awaiting_approval" as const, approvalHash: null, approvedAt: null, approvedBy: null };
  const message: AcquisitionOutreachAction = { ...action, kind: "direct_message", sequence: 2,
    authorizationVersion: 3, accountLoginStateVersion: 4, content: "new independently reviewed body",
    contentHash: outreachContentHash("new independently reviewed body"),
    targetPublicUrl: draft.candidates[0]!.publicProfileUrl,
    approvedBy: "approver", approvedAt: "2026-09-03T00:00:00.000Z", directMessageDailyLimit: 20,
    directMessageDailyOrdinal: 1 };
  message.approvalHash = outreachIndependentDirectMessageApprovalHash({ authorizationVersion: 3,
    batchId: draft.id, batchRevision: draft.revision, batchHash: draft.batchHash,
    candidateId: message.candidateId, accountId: message.accountId, accountLoginStateVersion: 4,
    targetPublicUrl: message.targetPublicUrl, directMessage: message.content, directMessageHash: message.contentHash,
    dailyLimit: 20, dailyOrdinal: 1, approvedBy: message.approvedBy!, approvedAt: message.approvedAt! });
  const snapshot: DesktopOutreachClaimAuthoritySnapshot = { action: message, batch: draft,
    predecessor: null, siblings: [], account: { id: message.accountId, workspaceId: message.workspaceId,
      state: "active", accountHandle: `dyacct_${"a".repeat(64)}`, displayName: "账号", loginStateVersion: 4,
      executorMode: "desktop", executorDeviceIdHash: hash("a"), executorBindingGeneration: 1,
      executorLeaseExpiresAt: "2026-09-03T00:05:00.000Z" } };
  assert.deepEqual(await value.authority.resolve(snapshot, "actor"), { accountHandle: snapshot.account.accountHandle });
  assert.equal(await value.authority.resolve({ ...snapshot, account: { ...snapshot.account, loginStateVersion: 5 } }, "actor"), null);
  for (const altered of [{ ...message, content: "tampered" }, { ...message, targetPublicUrl: "https://www.douyin.com/user/other" },
    { ...message, predecessorActionId: action.id }, { ...message, accountLoginStateVersion: 3 }]) {
    assert.deepEqual(await value.authority.resolve({ ...snapshot, action: altered }, "actor"), { failureCode: "approval_authority_changed" });
  }
  value.setDnc(true);
  assert.deepEqual(await value.authority.resolve(snapshot, "actor"), { failureCode: "approval_authority_changed" });
});

test("shared action authority preserves batch account evidence and actor scope", async () => {
  const value = fixture();
  assert.deepEqual(await value.authority.resolve(action, "worker-actor"), {
    accountHandle: `dyacct_${"a".repeat(64)}`
  });
  assert.deepEqual(value.scopes, [{ workspaceId: "workspace-1", ownerId: "owner-1",
    teamId: "team-1", actorId: "worker-actor" }]);
});

test("shared action authority fails closed when DNC changes", async () => {
  const value = fixture();
  value.setDnc(true);
  assert.deepEqual(await value.authority.resolve(action, "desktop-device-actor"), {
    failureCode: "approval_authority_changed"
  });
});

test("desktop claim authority consumes its immutable locked core without re-reading it", async () => {
  const value = fixture();
  const snapshot: DesktopOutreachClaimAuthoritySnapshot = {
    action, batch, siblings: [action], predecessor: null,
    account: { id: "account-1", workspaceId: "workspace-1", state: "active",
      accountHandle: `dyacct_${"a".repeat(64)}`, displayName: "账号",
      loginStateVersion: 3, executorMode: "desktop",
      executorDeviceIdHash: hash("a"), executorBindingGeneration: 4,
      executorLeaseExpiresAt: "2026-09-03T00:02:00.000Z" }
  };
  assert.deepEqual(await value.authority.resolve(snapshot, "desktop-device-actor"), {
    accountHandle: `dyacct_${"a".repeat(64)}`
  });
  assert.equal(value.coreReads(), 0,
    "the resolver must trust the repository's locked core rather than re-read it");
  assert.equal(value.lockedLoads(), 1);
});

test("desktop claim uses the newly approved sender version without rewriting the older collection", async () => {
  const value = fixture();
  const snapshot: DesktopOutreachClaimAuthoritySnapshot = {
    action: { ...action, executionTarget: "desktop", accountLoginStateVersion: 4 },
    batch: { ...batch, accountLoginStateVersion: 4 }, siblings: [], predecessor: null,
    account: { id: "account-1", workspaceId: "workspace-1", state: "active",
      accountHandle: `dyacct_${"a".repeat(64)}`, displayName: "账号",
      loginStateVersion: 4, executorMode: "desktop", executorDeviceIdHash: hash("a"),
      executorBindingGeneration: 4, executorLeaseExpiresAt: "2026-09-03T00:02:00.000Z" }
  };
  assert.deepEqual(await value.authority.resolve(snapshot, "desktop-device-actor"), {
    accountHandle: `dyacct_${"a".repeat(64)}`
  });
  assert.equal(await value.authority.resolve({ ...snapshot,
    account: { ...snapshot.account, loginStateVersion: 5 } }, "desktop-device-actor"), null);
  assert.deepEqual(await value.authority.resolve({ ...snapshot, batch }, "desktop-device-actor"), {
    failureCode: "approval_authority_changed"
  });
  value.setDnc(true);
  assert.deepEqual(await value.authority.resolve(snapshot, "desktop-device-actor"), {
    failureCode: "approval_authority_changed"
  });
});

test("desktop locked authority fails closed when no lock-owning loader is injected", async () => {
  const value = fixture();
  const withoutLoader = createAcquisitionOutreachActionAuthority({
    findBatch: async () => batch, listActions: async () => [action],
    findAccount: async () => ({ state: "active",
      accountHandle: `dyacct_${"a".repeat(64)}`, displayName: "账号",
      loginStateVersion: 3 }), findRun: async () => ({ ownerId: "owner-1", teamId: "team-1" }),
    findCrawlerJob: async () => ({ state: "succeeded", ingestionState: "succeeded",
      aliasGeneration: 1, projectedAliasGeneration: 1, planId: "plan-1",
      planVersionId: "plan-version-1", planSnapshotHash: hash("1"),
      policyVersionId: "policy-1", policyHash: hash("2"), accountId: "account-1",
      accountLoginStateVersion: 3, dailyBudgetId: hash("3"),
      localDate: "2026-09-03", dailyCandidateLimit: 50 } as never),
    listPolicyVersions: async () => [{ id: "policy-1", policyHash: hash("2"),
      schedule: { timeZone: "UTC" } }], findCandidate: async () => null,
    findEvidence: async () => null, hasDoNotContact: async () => false
  });
  const snapshot: DesktopOutreachClaimAuthoritySnapshot = {
    action, batch, siblings: [action], predecessor: null,
    account: { id: "account-1", workspaceId: "workspace-1", state: "active",
      accountHandle: `dyacct_${"a".repeat(64)}`, displayName: "账号",
      loginStateVersion: 3, executorMode: "desktop", executorDeviceIdHash: hash("a"),
      executorBindingGeneration: 4,
      executorLeaseExpiresAt: "2026-09-03T00:02:00.000Z" }
  };
  assert.deepEqual(await withoutLoader.resolve(snapshot, "desktop-device-actor"), {
    failureCode: "approval_authority_changed"
  });
  assert.equal(value.coreReads(), 0);
});
