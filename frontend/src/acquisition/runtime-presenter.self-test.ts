import { strict as assert } from "node:assert";
import {
  renderPublicDouyinImportPanel,
  renderRecentRunRows,
  renderRealTaskRows
} from "./runtime-presenter";

const emptyTaskRows = renderRealTaskRows([]);
assert.match(emptyTaskRows, /replica-real-task-empty/);
assert.match(emptyTaskRows, /尚未创建真实抖音获客任务/);
assert.match(emptyTaskRows, /人工确认/);
assert.match(emptyTaskRows, /data-acquisition-open-settings/,
  "the honest empty task state must retain an explicit, keyboard-reachable plan-settings entry");
assert.match(emptyTaskRows, /任务设置/);

const html = renderRealTaskRows([{
  id: "task-1",
  planId: "plan-1",
  latestRunId: "run-1",
  candidateRunId: "historical-candidates",
  name: "<img src=x onerror=alert(1)>",
  objective: "寻找公开需求",
  platformLabel: "抖音",
  status: "running",
  statusLabel: "正在运行",
  statusTone: "active",
  evidenceCount: 12,
  requests: 4,
  results: 18,
  durationSeconds: 31,
  updatedAt: "2026-08-07T05:00:00.000Z",
  tags: ["公开搜索"]
}]);

assert.match(html, /data-acquisition-plan-id="plan-1"/);
assert.match(html, /data-acquisition-latest-run-id="run-1"/);
assert.match(html, /12 条公开证据/);
assert.match(html, /正在运行/);
assert.doesNotMatch(html, /<img/);
assert.match(html, /&lt;img/);

const recentRuns = renderRecentRunRows([{
  id: "task-1",
  planId: "plan-1",
  latestRunId: "run-1",
  name: "<script>unsafe</script>",
  objective: "寻找公开需求",
  platformLabel: "抖音",
  status: "running",
  statusLabel: "正在运行",
  statusTone: "active",
  evidenceCount: 12,
  requests: 4,
  results: 18,
  durationSeconds: 31,
  updatedAt: "2026-08-07T05:00:00.000Z",
  tags: ["公开搜索"]
}]);
assert.match(recentRuns, /最近运行/);
assert.match(recentRuns, /抖音/);
assert.match(recentRuns, /正在运行/);
assert.match(recentRuns, /12/);
assert.doesNotMatch(recentRuns, /<script>/);

const importPanel = renderPublicDouyinImportPanel({
  visible: true,
  urlText: "https://www.douyin.com/video/1",
  status: "completed",
  message: "导入完成，已形成用户提交证据；主体仍待核验",
  results: [{
    sourceUrl: "https://www.douyin.com/video/1",
    status: "succeeded",
    operationId: "import-url-1",
    errorMessage: null
  }],
  outcome: {
    acceptedRowCount: 1,
    evidenceCount: 1,
    candidateCount: 1,
    candidateIds: ["candidate-<unsafe>"],
    rowErrors: []
  }
});

for (const text of [
  "公开搜索增强（可选）",
  "搜索 API 和支持工具调用的 AI 模型",
  "创建公开搜索增强任务",
  "无 API 请使用上方 MediaCrawler 控制台",
  "已有链接？补充导入",
  "粘贴公开链接",
  "导入公开链接",
  "导入完成",
  "打开待核验候选 1"
]) {
  assert.match(importPanel, new RegExp(text));
}
assert.match(importPanel, /data-acquisition-import-action="start-auto-acquisition"/);
assert.match(importPanel, /data-acquisition-import-action="submit-urls"/);
assert.match(importPanel, /data-acquisition-import-url-input/);
assert.match(importPanel, /data-acquisition-import-action="verify-identity"/);
assert.match(importPanel, /data-candidate-id="candidate-&lt;unsafe&gt;"/);
assert.doesNotMatch(importPanel, /candidate-<unsafe>/);
assert.ok(
  importPanel.indexOf("start-auto-acquisition") < importPanel.indexOf("submit-urls"),
  "automatic acquisition must be the primary action before manual link import"
);
