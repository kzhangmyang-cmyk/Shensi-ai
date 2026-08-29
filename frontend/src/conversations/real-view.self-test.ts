import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import type {
  OutreachAction,
  OutreachBatch
} from "../acquisition/outreach-batch-api";
import type { OutreachBatchState } from "../acquisition/outreach-batch-controller";
import {
  renderRealConversationsView,
  type RealConversationsViewState
} from "./real-view";

function batch(state: OutreachBatch["state"] = "awaiting_approval"): OutreachBatch {
  return {
    id: "batch-1",
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
      commentTargetPublicUrl: "https://www.douyin.com/video/video-1",
      draftRevision: 2,
      comment: "精确公开评论",
      commentHash: `sha256:${"4".repeat(64)}`,
      directMessage: "审批后的精确私信",
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

const idleOutreach = (): OutreachBatchState => ({
  phase: "idle",
  batch: null,
  drafts: {},
  actions: [],
  directMessageDailyLimit: 20,
  directMessageConfirmed: false,
  directMessageApprovalPhase: "idle",
  directMessagePendingCandidateIds: [],
  error: null,
  conflict: false,
  closed: false
});

const deliveredAction: OutreachAction = {
  id: "action-1",
  workspaceId: "workspace-1",
  batchId: "batch-1",
  batchRevision: 2,
  candidateId: "candidate-1",
  accountId: "account-1",
  accountLoginStateVersion: 1,
  policyVersionId: "policy-version-1",
  localDate: "2026-08-27",
  kind: "comment",
  sequence: 1,
  status: "succeeded",
  predecessorActionId: null,
  targetPublicUrl: "https://www.douyin.com/video/123",
  content: "精确公开评论",
  contentHash: `sha256:${"4".repeat(64)}`,
  approvalHash: `sha256:${"8".repeat(64)}`,
  createdAt: "2026-08-27T08:01:00.000Z",
  attemptCount: 1,
  platformReceiptReference: "receipt-<script>alert('receipt')</script>",
  occurredAt: "2026-08-27T08:02:00.000Z",
  failureCode: null
};

function hosts() {
  const { document } = parseHTML("<main id='main'></main><aside id='inspector'></aside>");
  return {
    main: document.querySelector<HTMLElement>("#main")!,
    inspector: document.querySelector<HTMLElement>("#inspector")!
  };
}

const baseState: RealConversationsViewState = {
  status: "ready",
  error: null,
  selectedInteractionKey: "run-1:candidate-1",
  outreach: idleOutreach(),
  snapshot: {
    generatedAt: "2026-08-26T08:00:00.000Z",
    runsRead: 1,
    accounts: [{
      id: "account-1",
      displayName: "抖音测试账号",
      state: "active",
      loginStateVersion: 1
    }],
    receiptAccess: "known_batch_id_only",
    truncatedRunIds: [],
    failedRuns: [],
    interactions: [{
      key: "run-1:candidate-1",
      candidateId: "candidate-1",
      runId: "run-1",
      taskId: "task-1",
      taskName: "展厅 <script>alert('task')</script>",
      runStatus: "succeeded",
      runUpdatedAt: "2026-08-26T07:50:00.000Z",
      displayName: "公开用户 <img src=x onerror=alert('name')>",
      candidateStatus: "new",
      excerpt: "公开评论：正在找展厅设计团队",
      sourceUrl: "https://www.douyin.com/video/123",
      outreachEligible: true
    }, {
      key: "run-1:candidate-profile",
      candidateId: "candidate-profile",
      runId: "run-1",
      taskId: "task-1",
      taskName: "展厅公开需求",
      runStatus: "succeeded",
      runUpdatedAt: "2026-08-26T07:49:00.000Z",
      displayName: "公开创作者主页",
      candidateStatus: "creator_candidate",
      excerpt: "公开主页证据仍可阅读",
      sourceUrl: "https://www.douyin.com/user/public-profile",
      outreachEligible: false
    }]
  }
};

{
  const { main, inspector } = hosts();
  renderRealConversationsView(baseState, main, inspector);
  const html = main.innerHTML + inspector.innerHTML;
  assert.match(html, /真实 · 抖音公开互动/u);
  assert.match(html, /公开评论：正在找展厅设计团队/u);
  assert.match(html, /data-real-conversations-action="create-outreach"/u);
  assert.match(html, /创建单候选待审批批次/u);
  assert.match(html, /非官方 inbox/u);
  assert.doesNotMatch(html, /发送不可用|平台回复（未接入）/u);
  assert.doesNotMatch(html, /<script>|<img src=x/u);
  assert.match(html, /&lt;script&gt;|&lt;img/u);
}

{
  const { main, inspector } = hosts();
  renderRealConversationsView({
    ...baseState,
    selectedInteractionKey: "run-1:candidate-profile"
  }, main, inspector);
  assert.match(main.innerHTML, /公开主页证据仍可阅读/u);
  assert.match(main.innerHTML, /公开来源不符合精确评论条件/u);
  assert.match(main.innerHTML, /button[^>]*disabled[^>]*>无法创建待审批批次/u);
}

{
  const { main, inspector } = hosts();
  renderRealConversationsView({
    ...baseState,
    outreach: {
      ...idleOutreach(),
      phase: "loading",
      batch: batch(),
      drafts: {
        "candidate-1": {
          comment: "等待恢复时不可见的旧评论",
          directMessage: "等待恢复时不可见的旧私信"
        }
      }
    }
  }, main, inspector);
  assert.match(main.innerHTML, /正在查询该候选人的最新审批批次/u);
  assert.match(main.innerHTML, /button[^>]*disabled/u);
  assert.doesNotMatch(main.innerHTML,
    /data-real-conversations-outreach-host|等待恢复时不可见的旧评论/u);
}

{
  const { main, inspector } = hosts();
  renderRealConversationsView({
    ...baseState,
    outreach: {
      ...idleOutreach(),
      phase: "error",
      batch: batch(),
      drafts: {
        "candidate-1": {
          comment: "恢复失败时不可见的旧评论",
          directMessage: "恢复失败时不可见的旧私信"
        }
      },
      error: "最新批次读取失败"
    }
  }, main, inspector);
  assert.match(main.innerHTML, /最新批次读取失败/u);
  assert.doesNotMatch(main.innerHTML,
    /data-real-conversations-outreach-host|恢复失败时不可见的旧评论/u);
}

{
  const { main, inspector } = hosts();
  renderRealConversationsView({
    ...baseState,
    outreach: {
      ...idleOutreach(),
      phase: "ready",
      batch: batch(),
      drafts: {
        "candidate-1": {
          comment: "精确公开评论",
          directMessage: "审批后的精确私信"
        }
      }
    }
  }, main, inspector);
  const html = main.innerHTML;
  assert.match(html, /data-real-conversations-outreach-host/u);
  assert.match(html, /精确公开评论/u);
  assert.match(html, /审批后的精确私信/u);
  assert.match(html, /抖音测试账号/u);
  assert.match(html, /https:\/\/www\.douyin\.com\/user\/actor-1/u);
  assert.match(html, /data-outreach-confirm/u);
  assert.doesNotMatch(html, /暂不能最终确认/u);
  assert.equal(
    main.querySelector<HTMLInputElement>("[data-outreach-confirm]")?.disabled,
    false
  );
  assert.match(html, /data-outreach-action="approve" disabled/u);
}

{
  const { main, inspector } = hosts();
  renderRealConversationsView({
    ...baseState,
    outreach: {
      ...idleOutreach(),
      phase: "ready",
      batch: batch("approved"),
      actions: [deliveredAction]
    }
  }, main, inspector);
  assert.match(main.innerHTML, /动作回执/u);
  assert.match(main.innerHTML, /公开评论 · 已送达/u);
  assert.match(main.innerHTML, /receipt-&lt;script&gt;/u);
  assert.doesNotMatch(main.innerHTML, /<script>alert\('receipt'\)<\/script>/u);
  assert.match(main.innerHTML, /真实私信复核/u);
  assert.equal(
    main.querySelector<HTMLTextAreaElement>(
      "[data-outreach-field=directMessage]"
    )?.disabled,
    false,
    "social conversations must share the same successful-comment unlock"
  );
  assert.match(main.innerHTML, /确认并排队真实私信/u);
}

{
  const { main, inspector } = hosts();
  renderRealConversationsView({
    status: "loading",
    error: null,
    selectedInteractionKey: null,
    snapshot: null,
    outreach: idleOutreach()
  }, main, inspector);
  assert.match(main.innerHTML, /正在读取真实公开互动/u);
  assert.doesNotMatch(main.innerHTML, /发送不可用/u);
}

{
  const { main, inspector } = hosts();
  renderRealConversationsView({
    status: "error",
    error: "真实公开互动读取失败 <unsafe>",
    selectedInteractionKey: null,
    snapshot: null,
    outreach: idleOutreach()
  }, main, inspector);
  assert.match(main.innerHTML, /真实公开互动读取失败 &lt;unsafe&gt;/u);
  assert.match(main.innerHTML, /data-real-conversations-action="retry"/u);
  assert.doesNotMatch(main.innerHTML, /发送不可用/u);
}

console.log(JSON.stringify({ ok: true, suite: "real-conversations-view" }));
