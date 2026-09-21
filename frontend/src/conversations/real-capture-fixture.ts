import type { OutreachBatch } from "../acquisition/outreach-batch-api";
import type { RealConversationsViewState } from "./real-view";

function batch(state: OutreachBatch["state"] = "awaiting_approval"): OutreachBatch {
  return {
    id: "capture-batch-1",
    workspaceId: "workspace-1",
    runId: "run-1",
    planId: "plan-1",
    planVersionId: "plan-version-1",
    planVersion: 1,
    planSnapshotHash: `sha256:${"0".repeat(64)}`,
    policyVersionId: "policy-version-1",
    policyHash: `sha256:${"1".repeat(64)}`,
    accountId: "account-1",
    accountLoginStateVersion: 1,
    dailyBudgetId: `sha256:${"2".repeat(64)}`,
    localDate: "2026-08-27",
    dailyCandidateLimit: 20,
    dailyRemainingLimit: 19,
    revision: 2,
    etag: '"batch:2"',
    state,
    candidates: [{
      candidateId: "candidate-1",
      selected: true,
      candidateRevision: 1,
      evidenceHashes: [`sha256:${"3".repeat(64)}`],
      publicProfileUrl: "https://www.douyin.com/user/actor-1",
      commentTargetPublicUrl: "https://www.douyin.com/video/123",
      draftRevision: 2,
      comment: "精确公开评论",
      commentHash: `sha256:${"4".repeat(64)}`,
      directMessage: "您好，这是人工修订后的精确私信，可以为您整理能耗与交付对比。",
      directMessageHash: `sha256:${"5".repeat(64)}`,
      rationaleCodes: ["evidence_grounded"],
      modelSnapshotId: "model-snapshot-1",
      sourceModelSnapshotId: "source-model-snapshot-1",
      contentHash: `sha256:${"6".repeat(64)}`
    }],
    batchHash: `sha256:${"7".repeat(64)}`,
    approvedBy: state === "approved" ? "operator-1" : null,
    approvedAt: state === "approved" ? "2026-08-27T08:01:00.000Z" : null,
    approvalHash: state === "approved" ? `sha256:${"8".repeat(64)}` : null,
    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,
    pauseReason: null,
    createdBy: "operator-1",
    createdAt: "2026-08-27T08:00:00.000Z",
    updatedBy: "operator-1",
    updatedAt: "2026-08-27T08:00:00.000Z"
  };
}

export function createConversationCaptureFixture(): RealConversationsViewState {
  return {
    status: "ready",
    error: null,
    selectedInteractionKey: "run-1:candidate-1",
    activeTab: "direct_messages",
    candidateQuery: "",
    snapshot: {
      generatedAt: "2026-08-26T08:00:00.000Z",
      runsRead: 1,
      accounts: [{
        id: "account-1",
        displayName: "Test2",
        state: "active",
        loginStateVersion: 1
      }],
      receiptAccess: "known_batch_id_only",
      truncatedRunIds: [],
      failedRuns: [],
      interactions: [
        {
          key: "run-1:candidate-1",
          candidateId: "candidate-1",
          runId: "run-1",
          taskId: "task-1",
          planId: "plan-1",
          taskName: "工业除尘改造",
          runStatus: "succeeded",
          runUpdatedAt: "2026-08-26T07:50:00.000Z",
          displayName: "天选财税人",
          candidateStatus: "new",
          excerpt: "公开评论：正在找展厅设计团队",
          sourceUrl: "https://www.douyin.com/video/123",
          outreachEligible: true
        },
        {
          key: "run-1:candidate-2",
          candidateId: "candidate-2",
          runId: "run-1",
          taskId: "task-1",
          planId: "plan-1",
          taskName: "工业除尘改造",
          runStatus: "succeeded",
          runUpdatedAt: "2026-08-26T07:51:00.000Z",
          displayName: "方师傅",
          candidateStatus: "qualified",
          excerpt: "公开评论：需求核对中",
          sourceUrl: "https://www.douyin.com/video/124",
          outreachEligible: true
        },
        {
          key: "run-1:candidate-3",
          candidateId: "candidate-3",
          runId: "run-1",
          taskId: "task-1",
          planId: "plan-1",
          taskName: "工业除尘改造",
          runStatus: "succeeded",
          runUpdatedAt: "2026-08-26T07:52:00.000Z",
          displayName: "钮钴禄君君财税",
          candidateStatus: "creator_candidate",
          excerpt: "公开视频证据可阅读",
          sourceUrl: "https://www.douyin.com/video/125",
          outreachEligible: false
        },
        {
          key: "run-1:candidate-4",
          candidateId: "candidate-4",
          runId: "run-1",
          taskId: "task-1",
          planId: "plan-1",
          taskName: "工业除尘改造",
          runStatus: "succeeded",
          runUpdatedAt: "2026-08-26T07:53:00.000Z",
          displayName: "慕有枝",
          candidateStatus: "pending_review",
          excerpt: "公开视频证据可阅读",
          sourceUrl: "https://www.douyin.com/video/126",
          outreachEligible: false
        },
        {
          key: "run-1:candidate-5",
          candidateId: "candidate-5",
          runId: "run-1",
          taskId: "task-1",
          planId: "plan-1",
          taskName: "工业除尘改造",
          runStatus: "succeeded",
          runUpdatedAt: "2026-08-26T07:54:00.000Z",
          displayName: "CRS规划王老师",
          candidateStatus: "new",
          excerpt: "公开视频证据可阅读",
          sourceUrl: "https://www.douyin.com/video/127",
          outreachEligible: false
        }
      ]
    },
    outreach: {
      phase: "ready",
      batch: batch(),
      drafts: {
        "candidate-1": {
          comment: "精确公开评论",
          directMessage: "您好，这是人工修订后的精确私信，可以为您整理能耗与交付对比。"
        }
      },
      actions: [],
      error: null,
      conflict: false,
      closed: false,
      directMessageDailyLimit: 20,
      directMessageConfirmed: true,
      directMessageApprovalPhase: "idle",
      directMessagePendingCandidateIds: [],
      directMessageSelectedCandidateIds: ["candidate-1"]
    }
  };
}
