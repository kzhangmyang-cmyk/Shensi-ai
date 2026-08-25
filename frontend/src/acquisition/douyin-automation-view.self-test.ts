import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { renderDouyinAutomationView } from "./douyin-automation-view";

const { document } = parseHTML("<main id='host'></main>");
const host = document.querySelector<HTMLElement>("#host")!;
const draftPolicy = {
  keywords: [], schedule: { enabled: false, localTime: "09:30", timeZone: "Asia/Shanghai" },
  dailyCandidateLimit: 50, collectCreators: true, collectDemandComments: true,
  limits: { maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3, maxDurationSeconds: 3600 }
};
renderDouyinAutomationView(host, {
  phase: "ready", planId: null, planName: "", planStatus: null, account: null, loginSession: null,
  policy: null, draftPolicy, runIntent: null, crawlerStatus: null, candidates: [],
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
  runIntent: null, crawlerStatus: null, candidates: [], selectedCandidateIds: [],
  error: null, suggestionError: null, closed: false
});
assert.match(host.textContent ?? "", /至少添加 1 个关键词/u);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-and-run]")?.disabled, true);

renderDouyinAutomationView(host, {
  phase: "ready", planId: null, planName: "工业需求计划", planStatus: null,
  account: connectedAccount,
  loginSession: null, policy: null,
  draftPolicy: { ...draftPolicy, keywords: ["工业除尘"] }, runIntent: null,
  crawlerStatus: null, candidates: [], selectedCandidateIds: [], error: null,
  suggestionError: null, closed: false
});
assert.match(host.textContent ?? "", /尚未保存/u);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-only]")?.disabled, false);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-and-run]")?.disabled, false);

renderDouyinAutomationView(host, {
  phase: "error", planId: "plan-1", planName: "袜子获客计划", planStatus: "approved",
  account: connectedAccount, loginSession: null, policy: null,
  draftPolicy: { ...draftPolicy, keywords: ["袜子"] }, runIntent: queuedRunIntent,
  crawlerStatus: null, candidates: [], selectedCandidateIds: [], error: "状态读取超时",
  suggestionError: null, closed: false
});
assert.match(host.textContent ?? "", /已提交采集，等待服务器返回首次观测状态/u);
assert.equal(host.querySelector<HTMLButtonElement>("[data-douyin-action=save-and-run]")?.disabled, true);
assert.ok(host.querySelector<HTMLElement>(".douyin-run-panel [role=status][aria-live=polite][aria-atomic=true]"));

renderDouyinAutomationView(host, {
  phase: "ready", planId: "plan-1", planName: "袜子获客计划", planStatus: "approved",
  account: connectedAccount, loginSession: null, policy: null,
  draftPolicy: { ...draftPolicy, keywords: ["袜子"] },
  runIntent: null,
  crawlerStatus: {
    runId: "run-live-1", state: "running", attempt: 1, cursorPersisted: true,
    recordCount: 25, candidateBudgetUsed: 1, candidateBudgetLimit: 50,
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
assert.ok(host.querySelector<HTMLElement>(".douyin-run-observation[role=status][aria-live=polite][aria-atomic=true]"));
assert.match(host.textContent ?? "", /第 1 次尝试/u);
assert.match(host.textContent ?? "", /候选人额度1 \/ 50/u);
assert.doesNotMatch(host.textContent ?? "", /采集进度|%/u);
assert.ok(candidatePanel.querySelector(".douyin-candidate-workspace"));
assert.equal(candidatePanel.querySelectorAll(".douyin-candidate-row").length, 1);
assert.match(candidatePanel.textContent ?? "", /袜子采购用户/u);
assert.match(candidatePanel.textContent ?? "", /公开评论中询问袜子批发/u);
assert.doesNotMatch(candidatePanel.textContent ?? "", /正在发现候选人|暂无候选人/u);
console.log(JSON.stringify({ ok: true, suite: "douyin-automation-view" }));
