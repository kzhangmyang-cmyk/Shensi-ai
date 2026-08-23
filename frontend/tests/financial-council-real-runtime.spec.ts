import { expect, test, type Page } from "@playwright/test";
import * as XLSX from "xlsx";

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

test("real MySQL council persists three-statement run and draft receipts without browser interception", async ({ page }) => {
  const consoleMessages: string[] = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) {
      consoleMessages.push(`${message.type()}:${message.text()}`);
    }
  });
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
  await page.locator("[data-real-consent]").check();
  await page.locator('[data-real-action="commit"]').click();
  await expect(page.getByText(/已验证：真实验收企业/u)).toBeVisible();
  await page.locator('[data-real-action="run"]').click();

  await expect(page).toHaveURL(/#financial-council\/run\//u);
  const durableUrl = page.url();
  await expect(page.getByRole("heading", { name: "财务委员会工作台" }))
    .toBeVisible();
  await expect(page.getByText("awaiting_approval", { exact: true }).first())
    .toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".council-specialist-card")).toHaveCount(5);
  await expect(page.getByRole("heading", { name: "审计与异议" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "复议保留" })).toBeVisible();
  await expect(page.locator('input[name="council-portfolio"]')).toHaveCount(3);

  await page.getByRole("radio", { name: /均衡组合/u }).check();
  await page.getByRole("button", { name: "移除" }).first().click();
  await page.getByRole("button", { name: "提交重新优化" }).click();
  await expect(page.locator(".council-portfolio-picker")).toContainText("版本 2");
  await page.getByRole("button", { name: "批准并创建草稿/待办" }).click();
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
  expect(await sensitiveSurfaces(page, consoleMessages)).not.toContain(SENTINEL);
  expect(consoleMessages.filter((line) => !/Failed to load resource.*401/u
    .test(line))).toEqual([]);
});
