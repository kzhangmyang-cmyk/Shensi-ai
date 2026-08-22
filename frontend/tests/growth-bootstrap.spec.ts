import { expect, test } from "@playwright/test";
import {
  enterRealGrowth,
  growthContractScenario,
  installGrowthContractScenario
} from "./fixtures/growth-contract";
import * as XLSX from "xlsx";

function fixtureWorkbook(rows: (string | number)[][]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "报表");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test("happy path enters real growth and renders the catalog workspace from typed fixtures", async ({ page }) => {
  const scenario = growthContractScenario("happy_path");
  const installed = await installGrowthContractScenario(page, scenario);
  await enterRealGrowth(page, "catalog");
  await expect(page.getByRole("heading", { name: "产品目录" })).toBeVisible();
  await expect(page.getByText("标准产品")).toBeVisible();
  expect(installed.requestsFor("GET", "/api/v1/growth/bootstrap").length).toBeGreaterThan(0);
  await installed.dispose();
});

test("contract mismatch fails closed with an unavailable state", async ({ page }) => {
  const scenario = growthContractScenario("contract_mismatch");
  const installed = await installGrowthContractScenario(page, scenario);
  await enterRealGrowth(page, "catalog");
  await expect(page.getByText("contract_mismatch")).toBeVisible();
  await expect(page.getByText("标准产品")).toHaveCount(0);
  await installed.dispose();
});

test("workspace selection required shows the unavailable gate", async ({ page }) => {
  const scenario = growthContractScenario("workspace_selection_required");
  const installed = await installGrowthContractScenario(page, scenario);
  await enterRealGrowth(page, "agents");
  await expect(page.getByText("workspace_selection_required")).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI 经营顾问团队" }))
    .toHaveCount(0);
  await installed.dispose();
});

test("login retries growth bootstrap and keeps the growth workspace visible", async ({ page }) => {
  const scenario = growthContractScenario("happy_path");
  const installed = await installGrowthContractScenario(page, scenario);
  let bootstrapRequests = 0;
  await page.route("**/api/v1/growth/bootstrap", async (route) => {
    bootstrapRequests += 1;
    await route.fulfill({
      status: bootstrapRequests === 1 ? 401 : 200,
      contentType: "application/json",
      body: JSON.stringify(bootstrapRequests === 1
        ? {
            code: "unauthorized",
            message: "未登录",
            details: null,
            requestId: "growth-login-required",
            retryable: false
          }
        : scenario.bootstrap)
    });
  });

  await page.goto("/#growth/agents");
  await expect.poll(() => bootstrapRequests).toBe(1);

  await page.locator("#loginButton").click();

  await expect(page.getByRole("heading", { name: "AI 经营顾问团队" }))
    .toBeVisible();
  await expect(page.locator("#growthWorkspace")).toBeVisible();
  await expect(page.locator(".replica-shell")).toBeHidden();
  await expect(page.locator(".shell")).toBeHidden();
  expect(page.url()).toContain("#growth/agents");
  expect(bootstrapRequests).toBe(2);
  await installed.dispose();
});

test("authentication changes invalidate the cached growth runtime", async ({ page }) => {
  const scenario = growthContractScenario("happy_path");
  const installed = await installGrowthContractScenario(page, scenario);
  await enterRealGrowth(page, "catalog");
  await expect(page.getByRole("heading", { name: "产品目录" })).toBeVisible();
  expect(installed.requestsFor("GET", "/api/v1/growth/bootstrap")).toHaveLength(1);

  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent("goodjob:auth-state-changed", {
      detail: { authenticated: false }
    }));
  });
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent("goodjob:auth-state-changed", {
      detail: { authenticated: true }
    }));
  });

  await expect.poll(() =>
    installed.requestsFor("GET", "/api/v1/growth/bootstrap").length
  ).toBe(2);
  await expect(page.getByRole("heading", { name: "产品目录" })).toBeVisible();
  await installed.dispose();
});

test("login restart aborts an in-flight unauthenticated bootstrap", async ({ page }) => {
  const scenario = growthContractScenario("happy_path");
  const installed = await installGrowthContractScenario(page, scenario);
  let bootstrapAttempts = 0;
  let releaseFirstBootstrap: (() => void) | undefined;
  let markFirstBootstrapStarted: (() => void) | undefined;
  const firstBootstrapStarted = new Promise<void>((resolve) => {
    markFirstBootstrapStarted = resolve;
  });
  const firstBootstrapReleased = new Promise<void>((resolve) => {
    releaseFirstBootstrap = resolve;
  });
  await page.route("**/api/v1/growth/bootstrap", async (route) => {
    bootstrapAttempts += 1;
    if (bootstrapAttempts === 1) {
      markFirstBootstrapStarted?.();
      await firstBootstrapReleased;
    }
    try {
      await route.fallback();
    } catch {
      // The first request is expected to be aborted by the auth reset.
    }
  });

  await page.goto("/#growth/agents");
  await firstBootstrapStarted;
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent("goodjob:auth-state-changed", {
      detail: { authenticated: false }
    }));
    document.dispatchEvent(new CustomEvent("goodjob:auth-state-changed", {
      detail: { authenticated: true }
    }));
  });

  await expect.poll(() => bootstrapAttempts).toBe(2);
  await expect(page.getByRole("heading", { name: "AI 经营顾问团队" }))
    .toBeVisible();
  releaseFirstBootstrap?.();
  await installed.dispose();
});

test("growth hash navigation dispatches one catalog load", async ({ page }) => {
  const scenario = growthContractScenario("happy_path");
  const installed = await installGrowthContractScenario(page, scenario);
  await enterRealGrowth(page, "agents");

  await page.evaluate(() => {
    window.location.hash = "#growth/catalog";
  });

  await expect(page.getByRole("heading", { name: "产品目录" })).toBeVisible();
  expect(installed.requestsFor("GET", "/api/v1/catalog/items")).toHaveLength(1);
  await installed.dispose();
});

test("a slow page load cannot block a newer growth route", async ({ page }) => {
  const scenario = growthContractScenario("happy_path");
  const installed = await installGrowthContractScenario(page, scenario);
  let releaseCatalog: (() => void) | undefined;
  let markCatalogStarted: (() => void) | undefined;
  const catalogStarted = new Promise<void>((resolve) => {
    markCatalogStarted = resolve;
  });
  const catalogReleased = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  await page.route("**/api/v1/catalog/items**", async (route) => {
    markCatalogStarted?.();
    await catalogReleased;
    try {
      await route.fallback();
    } catch {
      // The superseded catalog request is expected to be aborted.
    }
  });
  await enterRealGrowth(page, "agents");
  await page.evaluate(() => {
    window.location.hash = "#growth/catalog";
  });
  await catalogStarted;

  await page.evaluate(() => {
    window.location.hash = "#growth/finance";
  });
  await expect(page.getByRole("heading", { name: "财务账本" }))
    .toBeVisible();
  await expect(page).toHaveURL(/#growth\/finance$/u);
  releaseCatalog?.();
  await expect(page.getByRole("heading", { name: "产品目录" })).toHaveCount(0);
  await installed.dispose();
});

test("quote workbench loads a case and its immutable versions from typed fixtures", async ({ page }) => {
  const scenario = growthContractScenario("happy_path");
  const installed = await installGrowthContractScenario(page, scenario);
  await page.goto("/#growth/quotes?case=case-1");
  await expect(page.getByRole("heading", { name: "报价工作台" })).toBeVisible();
  await expect(page.locator('[data-version-id="quote-v1"]')).toBeVisible();
  expect(
    installed.requestsFor("GET", "/api/v1/quotes/cases/case-1").length
  ).toBeGreaterThan(0);
  await installed.dispose();
});

test("business agent team overview renders inside the product workspace", async ({ page }) => {
  const scenario = growthContractScenario("happy_path");
  const installed = await installGrowthContractScenario(page, scenario);
  await enterRealGrowth(page, "agents");
  await expect(page.getByRole("heading", { name: "AI 经营顾问团队" })).toBeVisible();
  await expect(page.getByText("利润分析")).toBeVisible();
  await expect(page.getByText("现金流分析")).toBeVisible();
  await expect(page.locator(".agents-grid")).toBeVisible();
  const agentAvatars = page.locator(".agents-grid .agent-avatar-image");
  await expect(agentAvatars).toHaveCount(6);
  await expect.poll(() => agentAvatars.evaluateAll((images) =>
    images.every((image) => {
      const avatar = image as HTMLImageElement;
      return avatar.complete && avatar.naturalWidth === 384;
    })
  )).toBe(true);
  expect(await page.locator(".agents-grid").evaluate((element) =>
    getComputedStyle(element).display
  )).toBe("grid");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator(".agents-grid").evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/u).length
  )).toBe(1);
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth === document.documentElement.clientWidth
  )).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => {
    window.location.hash = "#growth/agents/profit";
  });
  await expect(page.getByRole("heading", {
    name: "利润分析",
    exact: true
  })).toBeVisible();
  await expect(page.getByText("哪个产品是假利润？")).toBeVisible();
  await installed.dispose();
});

test("business advisor generates a sourced diagnosis report from typed fixtures", async ({ page }) => {
  const scenario = growthContractScenario("happy_path");
  const installed = await installGrowthContractScenario(page, scenario);
  await enterRealGrowth(page, "agents");
  await page.locator('[data-agents-action="generate-report"]')
    .evaluate((element) => {
      (element as HTMLButtonElement).click();
    });
  await expect(page.getByRole("heading", { name: "《经营诊断报告》" })).toBeVisible();
  await expect(page).toHaveURL(/#growth\/agents\/report$/u);
  await expect(page.getByText("存在假利润产品")).toBeVisible();
  await expect(page.getByText("未来 90 天行动计划")).toBeVisible();
  await expect(page.locator(".report-issue.issue-red")).not.toHaveCount(0);
  await expect(page.locator(".report-timeline")).toBeVisible();
  const evidence = page.locator("details.report-evidence").first();
  await expect(evidence).toBeVisible();
  await expect(evidence.locator(".report-evidence-body")).toBeHidden();
  await evidence.locator("summary").evaluate((element) => {
    (element as HTMLElement).click();
  });
  await expect(evidence.locator(".report-evidence-body")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const scoreRingSize = await page.locator(".health-score-ring").evaluate((element) => {
    const ring = getComputedStyle(element, "::before");
    return {
      width: Number.parseFloat(ring.width),
      height: Number.parseFloat(ring.height)
    };
  });
  expect(Math.abs(scoreRingSize.width - scoreRingSize.height)).toBeLessThan(1);
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth === document.documentElement.clientWidth
  )).toBe(true);
  await page.getByRole("link", { name: "返回团队" }).evaluate((element) => {
    (element as HTMLAnchorElement).click();
  });
  await expect(page.getByRole("heading", { name: "AI 经营顾问团队" }))
    .toBeVisible();
  await expect(page).toHaveURL(/#growth\/agents$/u);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "《经营诊断报告》" }))
    .toBeVisible();
  await expect(page).toHaveURL(/#growth\/agents\/report$/u);
  await installed.dispose();
});

test("late diagnosis responses cannot replace a page opened during the request", async ({ page }) => {
  const scenario = growthContractScenario("happy_path");
  const installed = await installGrowthContractScenario(page, scenario);
  let releaseDiagnosis: (() => void) | undefined;
  let markDiagnosisStarted: (() => void) | undefined;
  const diagnosisStarted = new Promise<void>((resolve) => {
    markDiagnosisStarted = resolve;
  });
  const diagnosisReleased = new Promise<void>((resolve) => {
    releaseDiagnosis = resolve;
  });
  await page.route("**/api/v1/business-advisor/diagnose", async (route) => {
    markDiagnosisStarted?.();
    await diagnosisReleased;
    await route.fallback();
  });
  await enterRealGrowth(page, "agents");
  await page.locator('[data-agents-action="generate-report"]')
    .evaluate((element) => {
      (element as HTMLButtonElement).click();
    });
  await diagnosisStarted;

  await page.evaluate(() => {
    window.location.hash = "#growth/catalog";
  });
  await expect(page.getByRole("heading", { name: "产品目录" })).toBeVisible();
  releaseDiagnosis?.();
  await page.waitForTimeout(100);

  await expect(page).toHaveURL(/#growth\/catalog$/u);
  await expect(page.getByRole("heading", { name: "产品目录" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "《经营诊断报告》" }))
    .toHaveCount(0);
  await installed.dispose();
});

test("business advisor imports group statements and picks a company report", async ({ page }) => {
  const scenario = growthContractScenario("happy_path");
  const installed = await installGrowthContractScenario(page, scenario);
  await enterRealGrowth(page, "agents");

  const balanceSheet = fixtureWorkbook([
    ["资产负债表"],
    ["编制单位：河南元能信息科技有限公司", "", "", "2026-06-30"],
    ["资产", "行次", "期末余额", "年初余额", "负债和所有者权益", "行次", "期末余额", "年初余额"],
    ["货币资金", "1", "110356.83", "113371.74", "应付账款", "33", "2859.9", "2859.9"],
    ["应收账款", "4", "387449.3", "387449.3", "应付职工薪酬", "35", "377386.77", "385859.03"],
    ["存货", "9", "0", "0", "其他应付款", "39", "1605977.22", "1447977.22"],
    ["流动资产合计", "15", "905447.37", "905751.46", "流动负债合计", "41", "1986223.89", "1836696.15"],
    ["固定资产账面价值", "20", "50457.45", "50457.45", "负债合计", "47", "1986223.89", "1836696.15"],
    ["非流动资产合计", "29", "50457.45", "50457.45", "所有者权益（或股东权益）合计", "52", "-1030319.07", "-880487.24"],
    ["资产合计", "30", "955904.82", "956208.91", "负债和所有者权益（或股东权益）", "53", "955904.82", "956208.91"]
  ]);
  const incomeStatement = fixtureWorkbook([
    ["利润表季报"],
    ["编制单位：河南元能信息科技有限公司", "2026年第2季度"],
    ["项目", "行次", "本年累计金额", "本季金额"],
    ["一、营业收入", "1", "0", "0"],
    ["减：营业成本", "2", "55515.87", "27757.17"],
    ["管理费用", "14", "94315.87", "49257.17"],
    ["财务费用", "18", "16.05", "10.31"],
    ["减：所得税费用", "31", "0", "0"],
    ["四、净利润（净亏损以“-”号填列）", "32", "-149831.83", "-77024.65"]
  ]);

  await page.locator('[data-statements-file="balance"]')
    .setInputFiles({ name: "资产负债表.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: balanceSheet });
  await page.locator('[data-statements-file="income"]')
    .setInputFiles({ name: "利润表.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: incomeStatement });
  await expect(page.locator('[data-statements-file-name="balance"]'))
    .toContainText("资产负债表.xlsx");
  await expect(page.locator('[data-statements-file-name="income"]'))
    .toContainText("利润表.xlsx");
  await expect(page.locator("[data-statements-selection]"))
    .toContainText("已选择 2 / 2");

  await page.locator('[data-agents-action="statements-diagnose"]')
    .evaluate((element) => {
      (element as HTMLButtonElement).click();
    });

  await expect(page.getByRole("heading", { name: "报表解析完成" })).toBeVisible();
  await expect(page.getByText("河南元能信息科技有限公司")).toBeVisible();
  await expect(page.getByText("中原影视孵化器有限公司")).toBeVisible();

  await page.locator('[data-agents-action="pick-company"]').first()
    .evaluate((element) => {
      (element as HTMLButtonElement).click();
    });

  await expect(page.getByRole("heading", { name: "《经营诊断报告》" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /毛利为负/ })).toBeVisible();
  await expect(page.getByText("数据源：河南元能信息科技有限公司 · 2026-06")).toBeVisible();
  await expect(page.getByText("未提供现金流量表，现金流预测与资金预警暂不可用")).toBeVisible();
  await installed.dispose();
});

test("business advisor statement dropzone accepts a dropped workbook", async ({ page }) => {
  const scenario = growthContractScenario("happy_path");
  const installed = await installGrowthContractScenario(page, scenario);
  await enterRealGrowth(page, "agents");

  const dropzone = page.locator('[data-statements-drop="balance"]');
  await dropzone.evaluate((element) => {
    element.dispatchEvent(new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer: new DataTransfer()
    }));
  });
  await expect(dropzone).toHaveClass(/is-dragging/);

  await dropzone.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["balance"], "拖放资产负债表.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }));
    element.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer
    }));
  });

  await expect(dropzone).not.toHaveClass(/is-dragging/);
  await expect(page.locator('[data-statements-file-name="balance"]'))
    .toContainText("拖放资产负债表.xlsx");
  await expect(page.locator("[data-statements-selection]"))
    .toContainText("已选择 1 / 2");
  await installed.dispose();
});

test("demo agent center shows the business advisor team offline with sample data", async ({ page }) => {
  await page.goto("/#agents");
  await page.evaluate(() => {
    document.body.classList.add("is-authenticated");
  });

  await expect(page.getByRole("heading", { name: "AI 经营顾问团队" })).toBeVisible();
  await expect(page.locator("#demoModuleMain").getByText("演示数据")).toBeVisible();
  await expect(page.getByText("利润分析")).toBeVisible();

  await page.locator('[data-agents-action="generate-report"]')
    .evaluate((element) => {
      (element as HTMLButtonElement).click();
    });
  await expect(page.getByRole("heading", { name: "《经营诊断报告》" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /存在假利润产品/ })).toBeVisible();

  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.locator("#demoModuleMain a.agents-back")
    .evaluate((element) => {
      (element as HTMLAnchorElement).click();
    });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.locator('[data-agents-demo-link="profit"]')
    .evaluate((element) => {
      (element as HTMLAnchorElement).click();
    });
  await expect(page.getByRole("heading", { name: "利润分析", exact: true })).toBeVisible();
  await expect(page.getByText("哪个产品是假利润？")).toBeVisible();
  const workbenchBounds = await page.evaluate(() => ({
    gridRight: document.querySelector(".agent-workbench-grid")
      ?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
    mainRight: document.querySelector("#demoModuleMain")
      ?.getBoundingClientRect().right ?? 0
  }));
  expect(workbenchBounds.gridRight).toBeLessThanOrEqual(workbenchBounds.mainRight + 0.5);

  await page.getByRole("button", { name: "哪个产品是假利润？" }).click();
  await expect(page.locator("[data-agent-question-input]"))
    .toHaveValue("哪个产品是假利润？");
  await expect(page.locator(".agent-answer-empty")).toBeVisible();
  await page.locator('[data-agents-form="ask"] button[type="submit"]').click();
  await expect(page.getByText(/产品 A：毛利率/)).toBeVisible();
  await expect(page.locator(".agent-answer-conclusion")).toBeVisible();
  await expect(page.locator(".agent-answer-evidence")).toBeVisible();
  await expect(page.locator(".agent-answer-actions")).toBeVisible();
  await expect(page.locator(".report-evidence").getByText(/假利润产品：产品 A/)).toBeVisible();
});
