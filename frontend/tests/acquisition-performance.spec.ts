import { expect, test } from "@playwright/test";

const performance = {
  counts: { discovered: 12, highIntent: 5, approved: 4, converted: 3, contacted: 2, quoted: 1, won: 1, lost: 0 },
  rates: { highIntentRate: 5 / 12, approvalRate: 4 / 5, crmConversionRate: 3 / 4, contactRate: 2 / 3, quoteRate: 1 / 2, winRate: 1 },
  valuesByCurrency: [{ currency: "USD", estimatedPipelineMinor: 120000, quotedMinor: 80000, wonContractMinor: 60000 }],
  cost: { status: "available", executionCostMinor: 1200, currency: "USD", coverage: "recorded_api_execution_only" },
  roi: { status: "not_computable", reason: "channel_cost_or_verified_margin_unavailable" },
  dataQuality: { missingAttribution: 1, missingFinancial: 1, truncated: true, lastReconciledAt: "2026-08-07T09:00:00.000Z" },
  briefingFacts: {
    headlines: [{ metricId: "funnel.discovered", text: "本期发现 12 个候选", evidenceRefs: ["run:run-1"] }],
    risks: [{ metricId: "quality.missing_attribution", text: "1 条 CRM 事件缺少可验证归因", evidenceRefs: ["diagnostic:d-1"] }],
    actions: [{ metricId: "funnel.contact_rate", text: "优先跟进未联系的 CRM 候选", evidenceRefs: ["candidate:c-1"] }],
    metricIds: ["funnel.discovered", "quality.missing_attribution", "funnel.contact_rate"]
  }
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    document.cookie = "gj_csrf=e2e-performance-csrf; path=/";
    localStorage.setItem("gj_user", JSON.stringify({
      id: "e2e-owner", name: "Owner", email: "owner@goodjob.test", role: "admin", teamId: "team-e2e", avatar: "OW"
    }));
  });
});

test("real acquisition renders deterministic performance and preserves facts when AI fails", async ({ page }) => {
  const briefingCsrfHeaders: Array<string | undefined> = [];
  await page.route("**/api/v1/acquisition/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (value: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(value)
    });
    if (url.pathname === "/api/v1/acquisition/overview") {
      return void await json({ generatedAt: "2026-08-07T09:00:00.000Z", platform: "douyin", totals: { tasks: 0 }, statusCounts: {}, discoveryMethodCounts: {}, tasks: [] });
    }
    if (url.pathname === "/api/v1/acquisition/performance") return void await json(performance);
    if (url.pathname === "/api/v1/acquisition/copilot/sessions" && request.method() === "POST") {
      briefingCsrfHeaders.push(request.headers()["x-csrf-token"]);
      return void await json({ resourceId: "briefing-session" }, 202);
    }
    if (url.pathname.endsWith("/messages") && request.method() === "POST") {
      briefingCsrfHeaders.push(request.headers()["x-csrf-token"]);
      return void await json({ id: "briefing-task" }, 202);
    }
    if (url.pathname === "/api/v1/acquisition/copilot/tasks/briefing-task") return void await json({ status: "failed", result: null, errorCode: "model_unavailable" });
    return void await json({ code: "resource_not_found", message: "not configured" }, 404);
  });

  await page.goto("/#acquisition");
  await page.locator('[data-acquisition-mode="real"]').click();

  const area = page.locator("#replicaAcquisitionPerformance");
  await expect(area).toBeVisible();
  await expect(page.locator("#replicaMetricValue0")).toHaveText("12");
  await expect(page.locator("#replicaMetricValue1")).toHaveText("5");
  await expect(page.locator("#replicaMetricValue2")).toHaveText("3");
  await expect(page.locator("#replicaMetricValue3")).toHaveText("1");
  await expect(area).toContainText("USD 600.00");
  await expect(area).toContainText("成交合同额");
  await expect(area).toContainText("ROI 暂不可计算");
  await expect(area).toContainText("结果已按安全上限截断");
  await expect(area).toContainText("metricId: funnel.discovered");

  await area.locator('[data-performance-action="generate"]').click();
  await expect(area).toContainText("AI 解读暂不可用");
  await expect(area).toContainText("本期发现 12 个候选");
  expect(briefingCsrfHeaders).toEqual([
    "e2e-performance-csrf",
    "e2e-performance-csrf"
  ]);
});

test("a real performance failure never restores demo summary numbers", async ({ page }) => {
  await page.route("**/api/v1/acquisition/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/acquisition/overview") {
      return void await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ generatedAt: "2026-08-07T09:00:00.000Z", platform: "douyin", totals: { tasks: 0 }, statusCounts: {}, discoveryMethodCounts: {}, tasks: [] }) });
    }
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "performance unavailable" } }) });
  });

  await page.goto("/#acquisition");
  await page.locator('[data-acquisition-mode="real"]').click();
  await expect(page.locator("#replicaAcquisitionPerformanceBody")).toContainText("performance unavailable");
  await expect(page.locator("#replicaMetricValue0")).toHaveText("—");
  await expect(page.locator("#replicaMetricValue1")).toHaveText("—");
  await expect(page.locator("#replicaMetricValue2")).toHaveText("—");
  await expect(page.locator("#replicaMetricValue3")).toHaveText("—");
});
