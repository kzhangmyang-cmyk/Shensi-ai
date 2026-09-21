import { strict as assert } from "node:assert";
import { renderAcquisitionPerformance } from "./performance-view";

const html = renderAcquisitionPerformance({
  status: "ready",
  data: {
    counts: { discovered: 4, highIntent: 2, approved: 2, converted: 1, contacted: 1, quoted: 1, won: 1, lost: 0 },
    rates: { highIntentRate: 0.5, approvalRate: 0.5, crmConversionRate: 0.5, contactRate: 1, quoteRate: 1, winRate: 1 },
    valuesByCurrency: [{ currency: "USD", estimatedPipelineMinor: 100_000, quotedMinor: 80_000, wonContractMinor: 60_000 }],
    cost: { status: "available", executionCostMinor: 300, currency: "CNY", coverage: "recorded_api_execution_only" },
    roi: { status: "not_computable", reason: "channel_cost_or_verified_margin_unavailable" },
    dataQuality: { missingAttribution: 1, missingFinancial: 2, truncated: true, lastReconciledAt: "2026-08-07T08:00:00.000Z" },
    briefingFacts: {
      headlines: [{ metricId: "funnel.won", text: "<img src=x onerror=alert(1)>", evidenceRefs: ["outcome-a"] }],
      risks: [{ metricId: "roi.status", text: "ROI 不可计算", evidenceRefs: ["run-a"] }],
      actions: [],
      metricIds: ["funnel.won", "roi.status"]
    }
  },
  aiInterpretation: "<script>bad()</script>",
  aiStatus: "ready"
});
assert.equal(html.includes("发现候选"), true);
assert.equal(html.includes("高意向"), true);
assert.equal(html.includes("转 CRM"), true);
assert.equal(html.includes("成交"), true);
assert.equal(html.includes("USD 600.00"), true);
assert.equal(html.includes("成交合同额"), true);
assert.equal(html.includes("实际回款"), false);
assert.equal(html.includes("ROI 暂不可计算"), true);
assert.equal(html.includes("结果已按安全上限截断"), true);
assert.equal(html.includes("&lt;img"), true);
assert.equal(html.includes("&lt;script&gt;"), true);
assert.equal(html.includes("onerror=alert(1)><"), false);

const errorHtml = renderAcquisitionPerformance({
  status: "error",
  data: null,
  error: "真实接口失败",
  aiInterpretation: null,
  aiStatus: "idle"
});
assert.equal(errorHtml.includes("真实接口失败"), true);
assert.equal(errorHtml.includes("128"), false);
assert.equal(errorHtml.includes("演示"), false);
