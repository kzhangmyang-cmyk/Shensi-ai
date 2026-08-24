import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import * as XLSX from "xlsx";

const requireBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
const mysql = requireBackend("mysql2/promise");

const SENTINEL = "RAW_FINANCIAL_SENTINEL_TASK8_NEVER_PERSIST";
const EMAIL = process.env.FINANCIAL_COUNCIL_E2E_USER ?? "admin@goodjob.com";
const PASSWORD = process.env.FINANCIAL_COUNCIL_E2E_PASSWORD ?? "goodjob123";

function workbook(rows: readonly (readonly unknown[])[]): Buffer {
  const value = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(value,
    XLSX.utils.aoa_to_sheet(rows as unknown[][]), "报表");
  return XLSX.write(value, { type: "buffer", bookType: "xlsx" });
}

function files() {
  const metadata = ["编制单位：真实验收企业", "2026-08-16", "币种：CNY"];
  return {
    balance_sheet: workbook([
      ["编制单位：真实验收企业", "2026-08-16", "币种：CNY"],
      ["资产", "行次", "期末余额", "年初余额", "负债和所有者权益", "行次", "期末余额", "年初余额"],
      ["货币资金", 1, 8000, 6000, "应付账款", 1, 7000, 7000],
      ["应收账款", 2, 12000, 11000, "流动负债合计", 2, 10000, 10000],
      ["存货", 3, 9000, 9000, "非流动负债合计", 3, 3000, 3000],
      ["流动资产合计", 4, 30000, 27000, "负债合计", 4, 13000, 13000],
      ["非流动资产合计", 5, 5000, 8000, "所有者权益合计", 5, 22000, 22000],
      ["资产合计", 6, 35000, 35000], ["内部备注", SENTINEL]
    ]),
    income_statement: workbook([metadata,
      ["项目", "行次", "本年累计金额"], ["营业收入", 1, 50000],
      ["营业成本", 2, 30000], ["财务费用", 3, 500],
      ["所得税费用", 4, 600], ["净利润", 5, 9400]]),
    cash_flow_statement: workbook([metadata,
      ["项目", "行次", "本年累计金额"],
      ["期初现金及现金等价物余额", 1, 6000],
      ["经营活动现金流入小计", 2, 45000],
      ["经营活动现金流出小计", 3, 39000],
      ["投资活动产生的现金流量净额", 4, 0],
      ["筹资活动产生的现金流量净额", 5, -4000],
      ["期末现金及现金等价物余额", 6, 8000]])
  };
}

async function sensitiveSurfaces(page: Page, consoleMessages: string[]) {
  return page.evaluate(() => ({ url: location.href,
    text: document.documentElement.textContent ?? "",
    html: document.documentElement.innerHTML,
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)) }))
    .then((value) => JSON.stringify({ ...value, consoleMessages }));
}

async function nonControlSensitiveSurfaces(
  page: Page,
  consoleMessages: string[]
) {
  return page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("input, textarea, select, option").forEach((element) =>
      element.remove());
    return { url: location.href, text: clone.textContent ?? "",
      html: clone.innerHTML, local: Object.fromEntries(Object.entries(localStorage)),
      session: Object.fromEntries(Object.entries(sessionStorage)) };
  }).then((value) => JSON.stringify({ ...value, consoleMessages }));
}

async function expectNoHorizontalOverflow(page: Page, width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }))).toEqual({ clientWidth: width, scrollWidth: width });
}

async function tabTo(page: Page, selector: string) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await page.keyboard.press("Tab");
    if (await page.locator(selector).evaluate((element) =>
      element === element.ownerDocument.activeElement)) return;
  }
  throw new Error(`keyboard_target_unreachable:${selector}`);
}

async function expectExactlyOneRebuttal(runId: string) {
  const adminUrl = process.env.MYSQL_TEST_ADMIN_URL;
  if (!adminUrl) throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:browser-rebuttal");
  const response = await fetch("http://127.0.0.1:4288/healthz");
  const readiness = await response.json() as { databaseName?: unknown };
  if (typeof readiness.databaseName !== "string"
    || !/^shensi_financial_council_\d+_[0-9a-f]{12}$/u.test(
      readiness.databaseName
    )) throw new Error("INVALID_OWNED_E2E_DATABASE_NAME");
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${readiness.databaseName}`;
  const connection = await mysql.createConnection(databaseUrl.href);
  try {
    const [rows] = await connection.query(
      `SELECT role FROM financial_council_rebuttal_attempts
        WHERE run_id = ? ORDER BY attempt_id`,
      [runId]
    );
    expect(rows).toEqual([{ role: "cashflow" }]);
  } finally {
    await connection.end();
  }
}

test("real MySQL council persists three-statement run and draft receipts without browser interception", async ({ page }) => {
  const consoleMessages: string[] = [];
  const httpFailures: string[] = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) {
      consoleMessages.push(`${message.type()}:${message.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      httpFailures.push(`${response.status()}:${response.url()}`);
    }
  });
  await page.clock.setFixedTime(new Date("2026-08-16T08:09:00.000Z"));
  await page.goto("/");
  await page.locator("#loginEmail").fill(EMAIL);
  await page.locator("#loginPassword").fill(PASSWORD);
  await page.locator("#loginButton").click();
  await expect(page.locator("body")).toHaveClass(/is-authenticated/u);
  await expect(page).toHaveURL(/#agents$/u);
  await expect(page.locator("body")).toHaveAttribute("data-session-mode", "real");
  await expect(page.locator(".replica-shell")).toHaveCount(1);
  await expect(page.locator(".real-agent-card")).toHaveCount(6);
  await expect(page.locator(".real-agent-card").first()).toContainText(
    "acceptance-openai-structured"
  );
  for (const width of [1440, 1366, 1024, 390]) {
    await expectNoHorizontalOverflow(page, width);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  const uploads = files();
  for (const kind of ["balance_sheet", "income_statement",
    "cash_flow_statement"] as const) {
    await page.locator(`[data-statements-file="${kind}"]`).setInputFiles({
      name: `${kind}.xlsx`,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: uploads[kind]
    });
  }
  await expect(page.locator("[data-statements-selection]")).toHaveText(
    "已选择 3 / 3 份必需报表"
  );
  await page.locator('[data-real-action="preview"]').click();
  await expect(page.getByRole("heading", { name: "解析预览" })).toBeVisible();
  await expect(page.getByText("真实验收企业")).toBeVisible();
  const forecastInputs = [
    ["#cash-forecast-inflow30", "1000.00"],
    ["#cash-forecast-outflow30", "5000.00"],
    ["#cash-forecast-inflow31To90", "8000.00"],
    ["#cash-forecast-outflow31To90", "3000.00"]
  ] as const;
  for (const [selector, value] of forecastInputs) {
    await tabTo(page, selector);
    await page.locator(selector).fill(value);
  }
  await page.getByRole("button", { name: "添加应收账款" }).click();
  for (const [label, value] of [
    ["应收客户 1", "验收客户 A"],
    ["应收金额 1", "10000.00"],
    ["逾期天数 1", "120"]
  ] as const) {
    const input = page.getByLabel(label);
    await tabTo(page, `#${await input.getAttribute("id")}`);
    await input.fill(value);
  }
  const attestation = page.getByLabel(/管理层现金预测/u);
  await attestation.check();
  await attestation.uncheck();
  await page.keyboard.press("Shift+Tab");
  await tabTo(page, "[data-cash-forecast-attestation]");
  await page.keyboard.press("Space");
  await expect(attestation).toBeChecked();
  await tabTo(page, "[data-real-consent]");
  await page.keyboard.press("Space");
  await expect(page.locator("[data-real-consent]")).toBeChecked();

  const rawValues = ["验收客户 A", "1000.00", "5000.00", "8000.00",
    "3000.00", "10000.00"];
  const controlValues = await page.locator("input").evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).value));
  for (const value of rawValues) {
    expect(controlValues).toContain(value);
    expect(await nonControlSensitiveSurfaces(page, consoleMessages))
      .not.toContain(value);
  }
  await tabTo(page, '[data-real-action="commit"]');
  await page.keyboard.press("Space");
  await expect(page.getByText(/已验证：真实验收企业/u)).toBeVisible();
  for (const value of rawValues) {
    expect(await sensitiveSurfaces(page, consoleMessages)).not.toContain(value);
  }
  await page.locator('[data-real-action="run"]').click();

  await expect(page).toHaveURL(/#financial-council\/run\//u);
  const durableUrl = page.url();
  await expect(page.getByRole("heading", { name: "财务委员会工作台" }))
    .toBeVisible();
  await expect(page.getByText("awaiting_approval", { exact: true }).first())
    .toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".council-specialist-card")).toHaveCount(5);
  await expect(page.getByRole("heading", { name: "审计与异议" })).toBeVisible();
  const reconsideration = page.getByRole("heading", { name: "复议保留" })
    .locator("..");
  await expect(reconsideration.locator("li")).toHaveCount(2);
  await expect(reconsideration).not.toContainText("暂无少数意见");
  const runId = decodeURIComponent(durableUrl.split("/").at(-1)!);
  await expectExactlyOneRebuttal(runId);
  await expect(page.locator('input[name="council-portfolio"]')).toHaveCount(3);

  await page.getByRole("radio", { name: /均衡组合/u }).check();
  const duration = page.locator(
    'input[data-council-action="replace-action-parameters"][data-field="durationDays"]'
  ).first();
  const revisedDuration = await duration.inputValue() === "30" ? "29" : "30";
  await duration.fill(revisedDuration);
  await duration.press("Tab");
  await page.getByRole("button", { name: "提交重新优化" }).click();
  await expect(page.locator(".council-portfolio-picker")).toContainText("版本 2");
  await expect(page.getByRole("radio", { name: /均衡组合/u })).toBeChecked();
  const approval = page.getByRole("button", { name: "批准并创建草稿/待办" });
  await expect(approval).toBeEnabled();
  await approval.click();
  const receipts = page.locator('[aria-labelledby="council-dispatch-heading"]');
  await expect(receipts).toContainText("succeeded", { timeout: 30_000 });
  await expect(receipts).toContainText("回执");
  const receiptText = await receipts.innerText();

  await page.reload();
  await expect(page).toHaveURL(durableUrl);
  await expect(page.getByRole("heading", { name: "财务委员会工作台" }))
    .toBeVisible();
  await expect(page.locator('[aria-labelledby="council-dispatch-heading"]'))
    .toHaveText(receiptText);
  for (const value of rawValues) {
    expect(await sensitiveSurfaces(page, consoleMessages)).not.toContain(value);
  }
  expect(await sensitiveSurfaces(page, consoleMessages)).not.toContain(SENTINEL);
  const allowedUnavailable = /^503:http:\/\/127\.0\.0\.1:5588\/api\/v1\/acquisition\/(?:overview|performance)(?:\?|$)/u;
  expect(httpFailures.filter((line) => !line.startsWith("401:")
    && !allowedUnavailable.test(line))).toEqual([]);
  const console503 = consoleMessages.filter((line) =>
    /Failed to load resource.*503/u.test(line));
  expect(console503).toHaveLength(httpFailures.filter((line) =>
    allowedUnavailable.test(line)).length);
  expect(consoleMessages.filter((line) =>
    !/Failed to load resource.*(?:401|503)/u.test(line))).toEqual([]);
});
