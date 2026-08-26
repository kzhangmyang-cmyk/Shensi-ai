import { strict as assert } from "node:assert";
import { renderRealConversationsView, type RealConversationsViewState } from "./real-view";

const main = { innerHTML: "" } as HTMLElement;
const inspector = { innerHTML: "" } as HTMLElement;
const state: RealConversationsViewState = {
  status: "ready",
  error: null,
  selectedInteractionKey: "run-1:candidate-1",
  snapshot: {
    generatedAt: "2026-08-26T08:00:00.000Z",
    runsRead: 1,
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
      sourceUrl: "https://www.douyin.com/video/123"
    }]
  }
};

renderRealConversationsView(state, main, inspector);
const html = main.innerHTML + inspector.innerHTML;
assert.match(html, /真实 · 抖音公开互动/);
assert.match(html, /公开互动与候选证据/);
assert.match(html, /不是平台私信会话/);
assert.match(html, /公开评论：正在找展厅设计团队/);
assert.match(html, /https:\/\/www\.douyin\.com\/video\/123/);
assert.match(html, /textarea[^>]*disabled/);
assert.match(html, /button[^>]*disabled[^>]*>发送不可用/);
assert.match(html, /没有接入官方 inbox、私信或评论发送 API/);
assert.match(html, /外联回执/);
assert.match(html, /已知批次 ID/);
assert.match(html, /本页不会发起评论、回复或私信/);
assert.doesNotMatch(html, /演示模式|林女士|会话收件箱/);
assert.doesNotMatch(html, /<script>|<img src=x/);
assert.match(html, /&lt;script&gt;|&lt;img/);

const emptyMain = { innerHTML: "" } as HTMLElement;
const emptyInspector = { innerHTML: "" } as HTMLElement;
renderRealConversationsView({
  status: "ready",
  error: null,
  selectedInteractionKey: null,
  snapshot: {
    generatedAt: "2026-08-26T08:00:00.000Z",
    runsRead: 0,
    receiptAccess: "known_batch_id_only",
    truncatedRunIds: [],
    failedRuns: [],
    interactions: []
  }
}, emptyMain, emptyInspector);
assert.match(emptyMain.innerHTML, /暂无已采集的抖音公开互动/);
assert.match(emptyMain.innerHTML + emptyInspector.innerHTML, /发送不可用/);

const errorMain = { innerHTML: "" } as HTMLElement;
const errorInspector = { innerHTML: "" } as HTMLElement;
renderRealConversationsView({
  status: "error",
  error: "真实公开互动读取失败",
  selectedInteractionKey: null,
  snapshot: null
}, errorMain, errorInspector);
assert.match(errorMain.innerHTML, /真实公开互动读取失败/);
assert.match(errorMain.innerHTML, /data-real-conversations-action="retry"/);
assert.match(errorMain.innerHTML + errorInspector.innerHTML, /发送不可用/);
