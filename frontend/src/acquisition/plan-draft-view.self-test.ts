import { strict as assert } from "node:assert";
import { renderPlanDraftPreview } from "./plan-draft-view";

const preview = renderPlanDraftPreview({
  targetPlatform: "douyin",
  name: "<b>抖音计划</b>",
  objective: "发现 <script>alert(1)</script> 采购信号",
  icp: {
    industries: ["企业服务", "装修"],
    regions: ["厦门", "泉州"],
    organizationCriteria: ["公开询价"],
    individualCriteria: ["老板账号"],
    exclusionRules: ["<img src=x>"]
  },
  subjectChannels: { organization: true, individual: true },
  providerConnections: [
    { connectionId: "a", providerId: "brave", kind: "search", status: "active", credentialVersion: 1 },
    { connectionId: "b", providerId: "serper", kind: "search", status: "active", credentialVersion: 2 }
  ],
  operations: [
    { operationId: "1", subjectChannel: "organization", kind: "search", connectionId: "a", query: "企业 <采购>", allocatedBudget: { requests: 2, results: 10, amountMinor: 15, durationSeconds: 30 } },
    { operationId: "2", subjectChannel: "individual", kind: "search", connectionId: "a", query: "老板 询价", allocatedBudget: { requests: 2, results: 10, amountMinor: 15, durationSeconds: 30 } },
    { operationId: "3", subjectChannel: "organization", kind: "search", connectionId: "b", query: "装修 寻找供应商", allocatedBudget: { requests: 2, results: 10, amountMinor: 15, durationSeconds: 30 } },
    { operationId: "4", subjectChannel: "individual", kind: "search", connectionId: "b", query: "合作 需求", allocatedBudget: { requests: 2, results: 10, amountMinor: 15, durationSeconds: 30 } }
  ],
  budgetSnapshot: { billingCurrency: "CNY", maxRequests: 8, maxResults: 40, maxAmountMinor: 60, maxDurationSeconds: 120 },
  modelConnectionId: "model-a",
  stopConditions: { stopWhenBudgetExhausted: true, stopWhenNoMoreResults: true }
});

for (const text of ["企业服务", "装修", "厦门", "泉州", "公开询价", "老板账号", "brave", "serper", "连接 a", "连接 b", "企业 &lt;采购&gt;", "老板 询价", "装修 寻找供应商", "合作 需求", "组织", "个人", "最大请求：8 CNY", "最大结果：40 CNY", "费用上限：60 CNY", "最长运行：120 秒", "预算耗尽时停止", "无更多结果时停止"]) {
  assert.equal(preview.includes(text), true, `missing ${text}`);
}
assert.equal(preview.includes("<script>alert(1)</script>"), false);
assert.equal(preview.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), true);
assert.equal(preview.includes("<img src=x>"), false);
