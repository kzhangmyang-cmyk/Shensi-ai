import { strict as assert } from "node:assert";
import {
  renderPublicDouyinImportPanel,
  renderRealTaskRows
} from "./runtime-presenter";

assert.match(renderRealTaskRows([]), /暂无真实抖音获客任务/);

const html = renderRealTaskRows([{
  id: "task-1",
  planId: "plan-1",
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
assert.match(html, /12 条公开证据/);
assert.match(html, /正在运行/);
assert.doesNotMatch(html, /<img/);
assert.match(html, /&lt;img/);

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
  "导入公开抖音线索",
  "仅支持公开页面",
  "导入后先形成用户提交证据",
  "粘贴公开链接",
  "导入公开链接",
  "导入完成",
  "打开待核验候选 1"
]) {
  assert.match(importPanel, new RegExp(text));
}
assert.match(importPanel, /data-acquisition-import-action="submit-urls"/);
assert.match(importPanel, /data-acquisition-import-url-input/);
assert.match(importPanel, /data-acquisition-import-action="verify-identity"/);
assert.match(importPanel, /data-candidate-id="candidate-&lt;unsafe&gt;"/);
assert.doesNotMatch(importPanel, /candidate-<unsafe>/);
