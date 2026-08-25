import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import type { DouyinAutomationController, DouyinAutomationState } from "./douyin-automation-controller";
import type { DouyinCrawlerStatus } from "./douyin-automation-api";
import { mountDouyinAutomationView, renderDouyinAutomationView } from "./douyin-automation-view";

const { document } = parseHTML("<main id='host'></main>");
const host = document.querySelector<HTMLElement>("#host")!;
const draftPolicy = {
  keywords: [], schedule: { enabled: false, localTime: "09:30", timeZone: "Asia/Shanghai" },
  dailyCandidateLimit: 50, collectCreators: true, collectDemandComments: true,
  limits: { maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3, maxDurationSeconds: 3600 }
};
renderDouyinAutomationView(host, {
  phase: "ready", planId: null, planName: "", planStatus: null, account: null, loginSession: null,
  policy: null, draftPolicy, runIntent: null, activeRunId: null, crawlerStatus: null, candidates: [],
  selectedCandidateIds: [], error: null, suggestionError: null, closed: false
});
assert.match(host.textContent ?? "", /连接抖音账号/u);
assert.match(host.textContent ?? "", /每日候选人/u);
assert.match(host.textContent ?? "", /手工关键词无需搜索 API 或 AI 模型/u);
assert.match(host.textContent ?? "", /AI 智能生成（可选）/u);
assert.match(host.textContent ?? "", /仅保存/u);
assert.match(host.textContent ?? "", /保存并立即运行/u);
assert.match(host.textContent ?? "", /请先扫码连接抖音账号/u);
assert.ok(host.querySelector<HTMLInputElement>("[name=planName]"));
assert.doesNotMatch(host.innerHTML, /cookie|accountHandle|browserProfile/iu);

const connectedAccount = { id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const, displayName: "测试模拟账号", state: "active" as const, loginStateVersion: 1, revision: 1, etag: '"account:1"', lastValidatedAt: null, createdAt: "2026-08-25T09:30:00.000Z", updatedAt: "2026-08-25T09:30:00.000Z" };
const queuedRunIntent = { id: "intent-waiting-1", acquisitionRunId: "run-waiting-1", workspaceId: "workspace-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", policyVersionId: "policy-1", policyHash: "hash", accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: "budget-1", localDate: "2026-08-25", trigger: "run_now" as const, collectCreators: true, collectDemandComments: true, status: "queued" as const, reason: null, createdBy: "user-1", createdAt: "2026-08-25T09:30:00.000Z" };
renderDouyinAutomationView(host, {
  phase: "ready", planId: null, planName: "工业需求计划", planStatus: null,
  account: connectedAccount, loginSession: null, policy: null, draftPolicy,
  runIntent: null, activeRunId: null, crawlerStatus: null, candidates: [], selectedCandidateIds: [],
  error: null, suggestionError: null, closed: false
});
assert.match(host.textContent ?? "", /至少添加 1 个关键词/u);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-and-run]")?.disabled, true);

renderDouyinAutomationView(host, {
  phase: "ready", planId: null, planName: "工业需求计划", planStatus: null,
  account: connectedAccount,
  loginSession: null, policy: null,
  draftPolicy: { ...draftPolicy, keywords: ["工业除尘"] }, runIntent: null, activeRunId: null,
  crawlerStatus: null, candidates: [], selectedCandidateIds: [], error: null,
  suggestionError: null, closed: false
});
assert.match(host.textContent ?? "", /尚未保存/u);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-only]")?.disabled, false);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-and-run]")?.disabled, false);

renderDouyinAutomationView(host, {
  phase: "error", planId: "plan-1", planName: "袜子获客计划", planStatus: "approved",
  account: connectedAccount, loginSession: null, policy: null,
  draftPolicy: { ...draftPolicy, keywords: ["袜子"] }, runIntent: queuedRunIntent, activeRunId: queuedRunIntent.acquisitionRunId,
  crawlerStatus: null, candidates: [], selectedCandidateIds: [], error: "状态读取超时",
  suggestionError: null, closed: false
});
assert.match(host.textContent ?? "", /已提交采集，等待服务器返回首次观测状态/u);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-and-run]")?.disabled, true);
assert.ok(host.querySelector<HTMLElement>(".douyin-run-panel [role=status][aria-live=polite][aria-atomic=true]"));

renderDouyinAutomationView(host, {
  phase: "error", planId: "plan-1", planName: "袜子获客计划", planStatus: "approved",
  account: connectedAccount, loginSession: null, policy: null,
  draftPolicy: { ...draftPolicy, keywords: ["袜子"] }, runIntent: queuedRunIntent, activeRunId: queuedRunIntent.acquisitionRunId,
  crawlerStatus: {
    runId: "run-old", state: "succeeded", attempt: 1, cursorPersisted: true,
    recordCount: 25, candidateBudgetUsed: 1, candidateBudgetLimit: 50, candidateProjectionState: "ready",
    lastErrorCode: null, createdAt: "2026-08-25T09:30:00.000Z",
    updatedAt: "2026-08-25T09:31:00.000Z", completedAt: "2026-08-25T09:31:00.000Z",
    activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 5 }
  },
  candidates: [], selectedCandidateIds: [], error: "状态读取超时", suggestionError: null, closed: false
});
assert.match(host.textContent ?? "", /已提交采集，等待服务器返回首次观测状态/u);
assert.doesNotMatch(host.textContent ?? "", /采集完成/u);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-and-run]")?.disabled, true);

renderDouyinAutomationView(host, {
  phase: "ready", planId: "plan-1", planName: "袜子获客计划", planStatus: "approved",
  account: connectedAccount, loginSession: null, policy: null,
  draftPolicy: { ...draftPolicy, keywords: ["袜子"] },
  runIntent: null,
  activeRunId: "run-live-1",
  crawlerStatus: {
    runId: "run-live-1", state: "running", attempt: 1, cursorPersisted: true,
    recordCount: 25, candidateBudgetUsed: 1, candidateBudgetLimit: 50, candidateProjectionState: "pending",
    lastErrorCode: null, createdAt: "2026-08-25T09:30:00.000Z",
    updatedAt: "2026-08-25T09:31:00.000Z", completedAt: null,
    activity: {
      phase: "collecting_comments", currentKeyword: "袜子",
      browserMode: "visible", sequence: 4
    }
  },
  candidates: [{
    id: "candidate-live-1", status: "comment_candidate", displayName: "袜子采购用户",
    evidence: { sourceUrl: "https://www.douyin.com/video/live-1", excerpt: "公开评论中询问袜子批发" }
  }],
  selectedCandidateIds: [], error: null, suggestionError: null, closed: false
});
const candidatePanel = host.querySelector<HTMLElement>(".douyin-candidates-panel")!;
assert.match(host.textContent ?? "", /采集中/u);
assert.match(host.textContent ?? "", /可视窗口已打开/u);
assert.match(host.textContent ?? "", /正在采集评论/u);
assert.match(host.textContent ?? "", /当前关键词：袜子/u);
assert.ok(host.querySelector<HTMLElement>(".douyin-run-live-activity[role=status][aria-live=polite][aria-atomic=true]"));
assert.match(host.textContent ?? "", /第 1 次尝试/u);
assert.match(host.textContent ?? "", /候选人额度1 \/ 50/u);
assert.doesNotMatch(host.textContent ?? "", /采集进度|%/u);
assert.ok(candidatePanel.querySelector(".douyin-candidate-workspace"));
assert.equal(candidatePanel.querySelectorAll(".douyin-candidate-row").length, 1);
assert.match(candidatePanel.textContent ?? "", /袜子采购用户/u);
assert.match(candidatePanel.textContent ?? "", /公开评论中询问袜子批发/u);
assert.doesNotMatch(candidatePanel.textContent ?? "", /正在发现候选人|暂无候选人/u);

const queuedStatus: DouyinCrawlerStatus = {
  runId: "run-queued-1", state: "queued" as const, attempt: 0, cursorPersisted: false,
  recordCount: 0, candidateBudgetUsed: 0, candidateBudgetLimit: 50, candidateProjectionState: "pending" as const,
  lastErrorCode: null, createdAt: "2026-08-25T09:30:00.000Z", updatedAt: "2026-08-25T09:30:00.000Z", completedAt: null,
  activity: { phase: "queued" as const, currentKeyword: null, browserMode: "headless" as const, sequence: 0 }
};
const observedState = (crawlerStatus: DouyinCrawlerStatus, error: string | null = null) => ({
  phase: "ready" as const, planId: "plan-1", planName: "袜子获客计划", planStatus: "approved" as const,
  account: connectedAccount, loginSession: null, policy: null, draftPolicy: { ...draftPolicy, keywords: ["袜子"] },
  runIntent: { ...queuedRunIntent, acquisitionRunId: crawlerStatus.runId }, activeRunId: crawlerStatus.runId, crawlerStatus, candidates: [], selectedCandidateIds: [], error, suggestionError: null, closed: false
});
const queuedPlaceholderState = (runIntent = queuedRunIntent): DouyinAutomationState => ({
  phase: "ready", planId: "plan-1", planName: "袜子获客计划", planStatus: "approved",
  account: connectedAccount, loginSession: null, policy: null, draftPolicy: { ...draftPolicy, keywords: ["袜子"] },
  runIntent, activeRunId: runIntent.acquisitionRunId, crawlerStatus: null, candidates: [], selectedCandidateIds: [], error: null, suggestionError: null, closed: false
});
renderDouyinAutomationView(host, queuedPlaceholderState());
assert.equal(host.querySelector<HTMLElement>(".douyin-run-panel .douyin-empty[role=status]")?.getAttribute("aria-live"), "polite", "the first pre-status run announcement may be polite");
renderDouyinAutomationView(host, queuedPlaceholderState());
assert.equal(host.querySelector<HTMLElement>(".douyin-run-panel .douyin-empty[role=status]")?.getAttribute("aria-live"), "off", "the same pre-status run must not repeat its announcement");
renderDouyinAutomationView(host, observedState({ ...queuedStatus, runId: queuedRunIntent.acquisitionRunId }));
const nextQueuedIntent = { ...queuedRunIntent, id: "intent-waiting-2", acquisitionRunId: "run-waiting-2" };
renderDouyinAutomationView(host, queuedPlaceholderState(nextQueuedIntent));
assert.equal(host.querySelector<HTMLElement>(".douyin-run-panel .douyin-empty[role=status]")?.getAttribute("aria-live"), "polite", "a new run must announce after status reset");
renderDouyinAutomationView(host, { ...queuedPlaceholderState(nextQueuedIntent), runIntent: null });
renderDouyinAutomationView(host, queuedPlaceholderState(nextQueuedIntent));
assert.equal(host.querySelector<HTMLElement>(".douyin-run-panel .douyin-empty[role=status]")?.getAttribute("aria-live"), "polite", "clearing the run intent must reset a later queued announcement");
renderDouyinAutomationView(host, observedState(queuedStatus));
const firstObservation = host.querySelector<HTMLElement>(".douyin-run-live-activity")!;
assert.match(firstObservation.textContent ?? "", /等待浏览器启动/u);
assert.doesNotMatch(firstObservation.textContent ?? "", /后台浏览器运行中/u);
assert.equal(firstObservation.getAttribute("aria-live"), "polite", "a new queued sequence may announce once");
assert.equal(firstObservation.querySelector("time"), null, "timestamps must remain outside the live region");
renderDouyinAutomationView(host, observedState({ ...queuedStatus, updatedAt: "2026-08-25T09:31:00.000Z" }));
const timestampRefresh = host.querySelector<HTMLElement>(".douyin-run-live-activity")!;
assert.equal(timestampRefresh.getAttribute("aria-live"), "off", "timestamp-only rerenders must not repeat the activity announcement");
assert.match(host.textContent ?? "", /更新于/u);

renderDouyinAutomationView(host, observedState({
  ...queuedStatus, state: "succeeded", candidateProjectionState: "pending",
  activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 1 }, completedAt: "2026-08-25T09:31:00.000Z"
}));
const pendingCandidatePanel = host.querySelector<HTMLElement>(".douyin-candidates-panel")!;
assert.match(pendingCandidatePanel.textContent ?? "", /正在整理候选人/u);
assert.doesNotMatch(pendingCandidatePanel.textContent ?? "", /暂无候选人/u);

renderDouyinAutomationView(host, observedState({
  ...queuedStatus, state: "running", candidateProjectionState: "pending",
  activity: { phase: "collecting_comments", currentKeyword: "袜子", browserMode: "visible", sequence: 2 }
}));
const runningCandidatePanel = host.querySelector<HTMLElement>(".douyin-candidates-panel")!;
assert.match(runningCandidatePanel.textContent ?? "", /正在发现候选人/u);
assert.doesNotMatch(runningCandidatePanel.textContent ?? "", /公开记录已保存|正在整理候选人/u);

renderDouyinAutomationView(host, observedState({
  ...queuedStatus, state: "partial", candidateProjectionState: "ready", lastErrorCode: "mediacrawler_partial",
  activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 1 }, completedAt: "2026-08-25T09:31:00.000Z"
}));
assert.match(host.textContent ?? "", /采集已部分完成，请检查公开记录后再继续/u);
assert.doesNotMatch(host.textContent ?? "", /mediacrawler_partial/u);
renderDouyinAutomationView(host, observedState({
  ...queuedStatus, state: "failed", candidateProjectionState: "failed", lastErrorCode: "unrecognized_internal_fault",
  activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 2 }, completedAt: "2026-08-25T09:31:00.000Z"
}));
assert.match(host.textContent ?? "", /采集遇到问题，请稍后重试或联系管理员/u);
assert.doesNotMatch(host.textContent ?? "", /unrecognized_internal_fault/u);

const ingestionErrorStatus: DouyinCrawlerStatus = {
  ...queuedStatus, state: "failed", candidateProjectionState: "failed", lastErrorCode: "crawler_ingestion_failed",
  activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 3 }, completedAt: "2026-08-25T09:31:00.000Z"
};
renderDouyinAutomationView(host, observedState(ingestionErrorStatus));
assert.equal(host.querySelector<HTMLElement>(".douyin-safe-reason")?.getAttribute("aria-live"), "polite", "a newly appearing ingestion error must announce");
renderDouyinAutomationView(host, observedState({ ...ingestionErrorStatus, updatedAt: "2026-08-25T09:32:00.000Z" }));
assert.equal(host.querySelector<HTMLElement>(".douyin-safe-reason")?.getAttribute("aria-live"), "off", "timestamp-only rerenders must not repeat the same error");
renderDouyinAutomationView(host, observedState({ ...ingestionErrorStatus, lastErrorCode: null }));
assert.equal(host.querySelector(".douyin-safe-reason"), null);
renderDouyinAutomationView(host, observedState(ingestionErrorStatus));
assert.equal(host.querySelector<HTMLElement>(".douyin-safe-reason")?.getAttribute("aria-live"), "polite", "an error must announce again after it was cleared");

const recoveredCandidate = {
  id: "candidate-recovered-1",
  status: "comment_candidate",
  displayName: "恢复后的袜子采购用户",
  evidence: {
    sourceUrl: "https://www.douyin.com/video/recovered-1",
    excerpt: "公开评论中询问袜子批发"
  }
};
const recoveredViewState = {
  ...observedState({
    ...queuedStatus,
    runId: "run-recovered",
    state: "partial",
    candidateProjectionState: "ready",
    lastErrorCode: "mediacrawler_partial",
    activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 1 },
    completedAt: "2026-08-25T09:31:00.000Z"
  }),
  activeRunId: "run-recovered",
  runIntent: null,
  candidates: [recoveredCandidate],
  selectedCandidateIds: [recoveredCandidate.id]
} as DouyinAutomationState & { activeRunId: string };
const recoveredViewController = {
  getState: () => recoveredViewState,
  subscribe(listener: (state: DouyinAutomationState) => void) {
    listener(recoveredViewState);
    return () => undefined;
  }
} as unknown as DouyinAutomationController;
let recoveredBatch: { runId: string; candidateIds: string[] } | null = null;
const unmountRecoveredView = mountDouyinAutomationView(
  host,
  recoveredViewController,
  (runId, candidateIds) => { recoveredBatch = { runId, candidateIds }; }
);
const recoveredBatchButton = host.querySelector<HTMLButtonElement>("[data-douyin-action=create-batch]");
assert.ok(recoveredBatchButton, "a restored candidate selection must expose the batch action");
recoveredBatchButton.click();
assert.deepEqual(
  recoveredBatch,
  { runId: "run-recovered", candidateIds: ["candidate-recovered-1"] },
  "a restored run must create an approval batch without requiring a transient run intent"
);
unmountRecoveredView();

const recoveredStatusErrorState: DouyinAutomationState = {
  ...recoveredViewState,
  phase: "error",
  crawlerStatus: null,
  candidates: [],
  selectedCandidateIds: [],
  error: "状态暂时不可用"
};
let recoveredReloadArgs: [string | null, string | undefined, string | null | undefined] | null = null;
let recoveredRefreshCalls = 0;
const recoveredRetryController = {
  getState: () => recoveredStatusErrorState,
  subscribe(listener: (state: DouyinAutomationState) => void) {
    listener(recoveredStatusErrorState);
    return () => undefined;
  },
  load: async (planId: string | null, planName?: string, latestRunId?: string | null) => {
    recoveredReloadArgs = [planId, planName, latestRunId];
  },
  refreshRun: async () => { recoveredRefreshCalls += 1; }
} as unknown as DouyinAutomationController;
const unmountRecoveredRetry = mountDouyinAutomationView(host, recoveredRetryController, () => undefined);
assert.equal(
  host.querySelector<HTMLButtonElement>("[data-douyin-action=save-and-run]")?.disabled,
  true,
  "a restored run without an observed status must keep direct launch disabled"
);
host.querySelector<HTMLButtonElement>("[data-douyin-action=retry]")?.click();
await Promise.resolve();
assert.deepEqual(
  recoveredReloadArgs,
  ["plan-1", "袜子获客计划", "run-recovered"],
  "retry must reload account, policy, and the restored run together"
);
assert.equal(recoveredRefreshCalls, 0);
unmountRecoveredRetry();
console.log(JSON.stringify({ ok: true, suite: "douyin-automation-view" }));
