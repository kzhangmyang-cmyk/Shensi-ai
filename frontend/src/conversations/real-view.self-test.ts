import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
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

const conversationsStyles = readFileSync(
  new URL("../replica-dashboard.css", import.meta.url),
  "utf8"
);

assert.match(
  conversationsStyles,
  /\.real-conversations \.real-conversation-list input\[type="search"\] \{/u,
  "the candidate search must retain the black-green field styling across all three tabs"
);
assert.doesNotMatch(
  conversationsStyles,
  /data-real-conversations-tab-panel="direct_messages"\]\s*\n\s*\.real-conversation-list input\[type="search"\]/u,
  "candidate search styling must not be limited to the direct-message tab"
);
assert.match(
  conversationsStyles,
  /\.is-conversations-direct-message \.outreach-direct-message-compose\.is-compact-single-recipient/u,
  "a single real recipient must use the dense private-message layout without changing other surfaces"
);
assert.match(
  conversationsStyles,
  /\.real-conversation-evidence > summary \{/u,
  "public evidence must retain an explicit, collapsible summary affordance"
);

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
      planId: "plan-1",
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
      planId: "plan-1",
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

// Capacity must neither clip a complete 50-candidate result nor inflate a
// smaller persisted result to the configured collection allowance.
for (const count of [5, 50]) {
  const { main, inspector } = hosts();
  const interactions = Array.from({ length: count }, (_, index) => ({
    ...baseState.snapshot!.interactions[0]!,
    key: `run-1:candidate-${index + 1}`,
    candidateId: `candidate-${index + 1}`,
    displayName: `真实候选 ${index + 1}`
  }));
  for (const activeTab of ["direct_messages", "comments", "history"] as const) {
    renderRealConversationsView({
      ...baseState,
      activeTab,
      selectedInteractionKey: `run-1:candidate-${count}`,
      snapshot: { ...baseState.snapshot!, interactions }
    }, main, inspector);
    assert.equal(main.querySelectorAll("[data-real-conversations-action=select]").length, count,
      `${activeTab} must render the complete persisted candidate result`);
    assert.equal(main.querySelector(".real-conversation-list > div > small")?.textContent,
      `${count} 位已采集真实候选 · 1 个运行`);
    assert.equal(main.querySelector(".real-conversation-row.selected")?.getAttribute("data-interaction-key"),
      `run-1:candidate-${count}`);
    const privateDomainEntry = main.querySelector<HTMLButtonElement>("[data-real-conversations-action=review-candidate]");
    assert.ok(privateDomainEntry, `${activeTab} must expose the selected candidate's review/private-domain entry`);
    assert.equal(privateDomainEntry.disabled, false);
  }
}

{
  const { main, inspector } = hosts();
  renderRealConversationsView(baseState, main, inspector);
  const html = main.innerHTML;
  assert.match(html, /社媒对话/u);
  assert.match(html, /data-real-conversations-tab="direct_messages" aria-current="page"/u);
  assert.match(html, />私信<.*>公开评论<.*>发送记录</u);
  assert.match(html, /公开评论：正在找展厅设计团队/u);
  assert.match(html, /当前私信收件人/u);
  assert.match(html, /与当前任务相关的公开内容/u);
  assert.match(html, /公开视频与评论/u);
  assert.match(html, /新发现/u);
  assert.doesNotMatch(html, />new<|needs_research/u);
  assert.equal(main.querySelector(".real-conversations-account-strip a")?.getAttribute("href"),
    "#acquisition");
  assert.match(html, /data-real-conversations-action="create-outreach"/u);
  assert.match(html, /准备私信草稿/u);
  assert.match(html, /class="real-conversation-avatar"/u);
  assert.match(html, /data-real-conversations-help/u);
  assert.match(html, /发送与审批说明/u);
  assert.match(html, /发送前核对/u);
  assert.equal(inspector.hidden, true,
    "the real conversations route must not reserve the shared inspector column");
  assert.equal(inspector.innerHTML, "",
    "operational guidance belongs in the collapsed main-workspace help, not the inspector");
  assert.doesNotMatch(html, /发送不可用|平台回复（未接入）/u);
  assert.doesNotMatch(html, /<script>|<img src=x/u);
  assert.match(html, /&lt;script&gt;|&lt;img/u);
}

{
  const { main, inspector } = hosts();
  const mediaState: RealConversationsViewState = {
    ...baseState,
    snapshot: {
      ...baseState.snapshot!,
      interactions: [{
        ...baseState.snapshot!.interactions[0]!,
        avatarUrl: "https://cdn.example.test/public-avatar.webp",
        coverUrl: "https://cdn.example.test/public-cover.webp"
      }, {
        ...baseState.snapshot!.interactions[1]!,
        avatarUrl: "javascript:alert(1)",
        coverUrl: "https://public:secret@cdn.example.test/cover.webp"
      }]
    }
  };
  renderRealConversationsView(mediaState, main, inspector);
  const avatar = main.querySelector<HTMLImageElement>(
    '[data-real-conversation-media="avatar"]'
  );
  const cover = main.querySelector<HTMLImageElement>(
    '[data-real-conversation-media="cover"]'
  );
  assert.equal(avatar?.getAttribute("src"), "https://cdn.example.test/public-avatar.webp");
  assert.equal(cover?.getAttribute("src"), "https://cdn.example.test/public-cover.webp");
  assert.equal(avatar?.getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(cover?.getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(main.querySelectorAll('[src^="javascript:"]').length, 0);
  assert.equal(main.querySelectorAll('[src*="public:secret@"]').length, 0);
  const evidence = main.querySelector<HTMLDetailsElement>(
    ".real-conversation-evidence"
  );
  assert.equal(evidence?.hasAttribute("open"), false,
    "recipient evidence remains available but starts collapsed for a denser first screen");
  assert.equal(evidence?.querySelector("a")?.getAttribute("href"),
    "https://www.douyin.com/video/123");
}

{
  const { main, inspector } = hosts();
  const stableState: RealConversationsViewState = {
    ...baseState,
    outreach: {
      ...idleOutreach(), phase: "ready", batch: batch(),
      drafts: { "candidate-1": { comment: "精确公开评论", directMessage: "保留输入中的私信正文" } },
      directMessageSelectedCandidateIds: ["candidate-1"]
    }
  };
  renderRealConversationsView(stableState, main, inspector);
  assert.equal(main.querySelector(".outreach-account-manage")?.getAttribute("href"),
    "#acquisition", "sender management must open the Douyin account login/binding controls");
  assert.equal(main.querySelector(".outreach-workspace .douyin-step") === null, true,
    "independent private messages must not retain the acquisition sequence step");
  const textarea = main.querySelector<HTMLTextAreaElement>(
    "[data-outreach-field=directMessage]"
  )!;
  Object.defineProperties(textarea, {
    selectionStart: { value: 2, writable: true, configurable: true },
    selectionEnd: { value: 5, writable: true, configurable: true },
    __focused: { value: true, writable: true, configurable: true }
  });
  renderRealConversationsView({
    ...stableState,
    outreach: { ...stableState.outreach, error: "动作状态暂时不可用" }
  }, main, inspector);
  assert.equal(main.querySelector("[data-outreach-field=directMessage]"), textarea,
    "receipt/status rendering must preserve the native composer textarea node");
  assert.equal(textarea.selectionStart, 2);
  assert.equal(textarea.selectionEnd, 5);
  assert.equal((textarea as HTMLTextAreaElement & { __focused: boolean }).__focused,
    true, "the focused native node must survive status rendering");
  assert.match(main.textContent ?? "", /动作状态暂时不可用/u,
    "the private-message tab must retain its API error");
  assert.equal(main.querySelector<HTMLInputElement>(
    "[data-outreach-direct-message-candidate]"
  )?.hasAttribute("checked"), true);
}

{
  const { main, inspector } = hosts();
  const singleRecipientState: RealConversationsViewState = {
    ...baseState,
    snapshot: {
      ...baseState.snapshot!,
      interactions: [baseState.snapshot!.interactions[0]!]
    },
    outreach: {
      ...idleOutreach(),
      phase: "ready",
      batch: batch(),
      drafts: {
        "candidate-1": {
          comment: "精确公开评论",
          directMessage: "审批后的精确私信"
        }
      },
      directMessageSelectedCandidateIds: ["candidate-1"]
    }
  };
  renderRealConversationsView(singleRecipientState, main, inspector);
  const compose = main.querySelector<HTMLElement>(
    "[data-outreach-direct-message-compose]"
  )!;
  assert.equal(compose.classList.contains("is-compact-single-recipient"), true);
  const headerSummary = compose.querySelector<HTMLElement>(
    ".outreach-direct-message-header-summary"
  );
  assert.ok(headerSummary, "single-recipient mode keeps sender and limit in a compact summary row");
  assert.equal(headerSummary?.querySelector<HTMLInputElement>(
    "[data-outreach-direct-message-limit]"
  )?.value, "20");
  assert.match(headerSummary?.textContent ?? "", /抖音测试账号/u);
  assert.equal(headerSummary?.querySelector(".outreach-account-manage")
    ?.getAttribute("href"), "#acquisition");
  const preview = compose.querySelector<HTMLDetailsElement>(
    ".outreach-direct-message-preview"
  );
  assert.equal(preview?.hasAttribute("open"), false,
    "preview and confirmation stay explicitly user-opened before any queue action");
  assert.match(preview?.querySelector("summary")?.textContent ?? "", /预览并确认私信/u);
  assert.match(preview?.textContent ?? "", /发送账号：.*抖音测试账号/u);
  assert.match(preview?.textContent ?? "", /精确收件人：.*公开用户/u);
  assert.match(preview?.textContent ?? "", /审批后的精确私信/u);
  assert.equal(compose.querySelector<HTMLInputElement>(
    "[data-outreach-direct-message-confirm]"
  )?.disabled, false);
  assert.equal(compose.querySelector<HTMLButtonElement>(
    '[data-outreach-action="approve-direct-messages"]'
  )?.disabled, true,
  "the denser arrangement does not bypass the separate approval checkbox");
  assert.equal(main.querySelector<HTMLDetailsElement>(
    ".real-conversation-evidence"
  )?.hasAttribute("open"), false);
}

{
  const { main, inspector } = hosts();
  const multiCandidateBatch = batch();
  multiCandidateBatch.candidates.push({
    ...multiCandidateBatch.candidates[0]!,
    candidateId: "candidate-profile",
    publicProfileUrl: "https://www.douyin.com/user/public-profile",
    commentTargetPublicUrl: "https://www.douyin.com/video/456",
    directMessage: "第二位保留正文"
  });
  const secondCandidateState: RealConversationsViewState = {
    ...baseState,
    selectedInteractionKey: "run-1:candidate-profile",
    outreach: {
      ...idleOutreach(),
      phase: "ready",
      batch: multiCandidateBatch,
      drafts: {
        "candidate-1": { comment: "第一位评论", directMessage: "第一位私信" },
        "candidate-profile": { comment: "第二位评论", directMessage: "第二位保留正文" }
      },
      directMessageSelectedCandidateIds: ["candidate-profile"]
    }
  };
  renderRealConversationsView(secondCandidateState, main, inspector);
  const textarea = main.querySelector<HTMLTextAreaElement>(
    "[data-outreach-field=directMessage]"
  )!;
  assert.equal(textarea.dataset.outreachCandidateId, "candidate-profile");
  assert.equal(textarea.value, "第二位保留正文");
  Object.defineProperties(textarea, {
    selectionStart: { value: 1, writable: true, configurable: true },
    selectionEnd: { value: 4, writable: true, configurable: true }
  });
  renderRealConversationsView({
    ...secondCandidateState,
    outreach: {
      ...secondCandidateState.outreach,
      directMessageApprovalPhase: "pending",
      directMessagePendingCandidateIds: ["candidate-profile"]
    }
  }, main, inspector);
  renderRealConversationsView({
    ...secondCandidateState,
    outreach: { ...secondCandidateState.outreach, error: "第二位状态刷新失败" }
  }, main, inspector);
  assert.equal(main.querySelector("[data-outreach-field=directMessage]"), textarea,
    "receipt and error renders must retain the non-first candidate textarea");
  assert.equal(textarea.value, "第二位保留正文");
  assert.equal(textarea.selectionStart, 1);
  assert.equal(textarea.selectionEnd, 4);
  assert.equal(main.querySelectorAll("[data-outreach-direct-message-state]").length, 1);
  assert.equal(main.querySelector("[data-outreach-direct-message-state]")
    ?.getAttribute("data-view-key"), "dm-draft:candidate-profile");
  assert.match(main.textContent ?? "", /第二位状态刷新失败/u);
}

{
  const { main, inspector } = hosts();
  inspector.textContent = "能力与审批边界";
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
  renderRealConversationsView({ ...baseState, candidateQuery: "创作者" }, main, inspector);
  assert.match(main.textContent ?? "", /公开创作者主页/u);
  assert.doesNotMatch(
    main.querySelector(".real-conversation-list nav")?.textContent ?? "",
    /公开用户 <img/u
  );
  assert.equal(main.querySelector(".real-conversation-row.selected"), null,
    "search must not visually replace the current recipient with another candidate");
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
  assert.doesNotMatch(html, /精确公开评论/u,
    "the default private-message tab must not be led by comment approval");
  assert.match(html, /审批后的精确私信/u);
  assert.match(html, /私信可独立发送/u);
  assert.match(html, /抖音测试账号/u);
  assert.match(html, /https:\/\/www\.douyin\.com\/user\/actor-1/u);
  assert.match(html, /data-outreach-direct-message-confirm/u);
  assert.doesNotMatch(html, /暂不能最终确认/u);
  assert.equal(
    main.querySelector<HTMLInputElement>("[data-outreach-direct-message-confirm]")?.disabled,
    false
  );
  assert.match(html, /data-outreach-action="approve-direct-messages" disabled/u);
}

{
  const { main, inspector } = hosts();
  inspector.textContent = "能力与审批边界";
  renderRealConversationsView({
    ...baseState,
    activeTab: "comments",
    outreach: {
      ...idleOutreach(), phase: "ready", batch: batch(),
      drafts: { "candidate-1": { comment: "精确公开评论", directMessage: "审批后的精确私信" } }
    }
  }, main, inspector);
  assert.match(main.innerHTML, /精确公开评论/u);
  assert.doesNotMatch(main.innerHTML, /data-outreach-direct-message-compose/u);
  assert.match(main.innerHTML, /data-real-conversations-help/u);
  assert.equal(main.querySelectorAll(".real-conversations-heading").length, 0,
    "the public-comment tab must use the compact secondary toolbar instead of repeating the page title");
  assert.equal(main.querySelectorAll(".real-conversations-secondary-toolbar").length, 1);
  assert.equal(inspector.hidden, true,
    "the public-comment tab must not restore the technical inspector column");
  assert.equal(inspector.innerHTML, "",
    "the public-comment tab must clear stale inspector content");
}

{
  const { main, inspector } = hosts();
  inspector.textContent = "能力与审批边界";
  renderRealConversationsView({
    ...baseState,
    activeTab: "history",
    outreach: {
      ...idleOutreach(),
      phase: "ready",
      batch: batch("approved"),
      actions: [deliveredAction]
    }
  }, main, inspector);
  assert.match(main.innerHTML, /发送详情与回执/u);
  assert.match(main.innerHTML, /公开评论 · 平台回执已确认/u);
  assert.match(main.innerHTML, /不代表评论持续公开可见/u);
  assert.match(main.innerHTML, /receipt-&lt;script&gt;/u);
  assert.doesNotMatch(main.innerHTML, /<script>alert\('receipt'\)<\/script>/u);
  assert.doesNotMatch(main.innerHTML, /data-outreach-direct-message-compose/u);
  assert.match(main.innerHTML, /data-real-conversations-help/u);
  assert.equal(main.querySelectorAll(".real-conversations-heading").length, 0,
    "the send-history tab must use the compact secondary toolbar instead of repeating the page title");
  assert.equal(main.querySelectorAll(".real-conversations-secondary-toolbar").length, 1);
  assert.equal(inspector.hidden, true,
    "the send-history tab must not restore the technical inspector column");
  assert.equal(inspector.innerHTML, "",
    "the send-history tab must clear stale inspector content");
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
