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
console.log(JSON.stringify({ ok: true, suite: "douyin-automation-view" }));
