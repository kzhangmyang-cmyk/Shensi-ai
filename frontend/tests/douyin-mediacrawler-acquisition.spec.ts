import { expect, test } from "@playwright/test";

const FIXTURE = "http://127.0.0.1:5391";

test.beforeEach(async () => {
  const response = await fetch(`${FIXTURE}/__fixture/reset`, { method: "POST" });
  expect(response.ok).toBe(true);
});

test("real session controls automatic Douyin acquisition, approval, receipts, and responsive access", async ({ page }) => {
  test.setTimeout(60_000);
  const consoleProblems: string[] = [];
  const unexpectedHttpErrors: string[] = [];
  const expectedConflicts: string[] = [];
  const genericDependencyRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/acquisition/provider-connections" || path === "/api/v1/ai/connections") {
      genericDependencyRequests.push(path);
    }
  });
  page.on("console", (entry) => {
    if (["error", "warning"].includes(entry.type()) && !/status of 412/iu.test(entry.text())) {
      consoleProblems.push(`${entry.type()}: ${entry.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const item = `${response.status()}:${new URL(response.url()).pathname}`;
    if (response.status() === 412 && response.url().includes("/approve")) expectedConflicts.push(item);
    else unexpectedHttpErrors.push(item);
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#acquisition");
  await expect(page).toHaveTitle("GoodJob 自动营销系统");
  await expect(page.getByRole("region", { name: "Shensi 登录" })).toBeVisible();
  await page.locator("#loginEmail").fill("admin@example.com");
  await page.locator("#loginPassword").fill("fixture-password");
  await page.getByRole("button", { name: "登录工作台" }).click();

  const workspace = page.getByRole("region", { name: "抖音自动获客工作台" });
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole("heading", { name: "抖音自动获客" })).toBeVisible();
  await expect(workspace).toContainText("连接抖音账号");
  await expect(workspace).toContainText("尚未保存");
  await expect(workspace).toContainText("手工关键词无需搜索 API 或 AI 模型");
  await expect(page.getByRole("heading", { name: "通用公开搜索获客" })).toBeVisible();
  await expect(workspace).not.toContainText(/cookie|accountHandle|browserProfile|leaseToken|account-fixture|candidate-creator/iu);

  await workspace.getByRole("button", { name: "扫码连接" }).click();
  const qrDialog = page.getByRole("dialog", { name: "请使用抖音扫码" });
  await expect(qrDialog).toBeVisible();
  const qrImage = qrDialog.getByRole("img", { name: "抖音登录二维码" });
  await expect(qrImage).toBeVisible();
  await expect.poll(() => qrImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThanOrEqual(128);
  await expect.poll(() => qrImage.evaluate((image) => (image as HTMLImageElement).naturalHeight)).toBeGreaterThanOrEqual(128);
  await expect(page.getByText("测试模拟账号")).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await workspace.getByLabel("计划名称").fill("工业需求计划");
  await workspace.getByLabel("新关键词").fill("工业除尘改造");
  await workspace.getByLabel("每日候选人 建议 50").fill("50");
  await workspace.getByLabel("每日时间").fill("09:30");
  await expect(workspace.getByRole("button", { name: "保存并立即运行" })).toBeEnabled();
  await workspace.getByRole("button", { name: "保存并立即运行" }).click();
  await expect(workspace).toContainText("部分完成", { timeout: 8_000 });
  await expect(workspace).toContainText("当前计划：工业需求计划");
  await expect(workspace).toContainText("内容创作者");
  await expect(workspace).toContainText("需求评论者");
  await expect(workspace).toContainText("安全暂停原因：douyin_collection_partial");

  const firstCandidate = workspace.locator(".douyin-candidate-row").first();
  await firstCandidate.focus();
  await page.keyboard.press("Space");
  await expect(workspace).toContainText("已选 1 人");
  const secondCandidate = workspace.locator(".douyin-candidate-row").nth(1);
  await secondCandidate.focus();
  await page.keyboard.press("Space");
  await expect(workspace).toContainText("已选 2 人");
  await workspace.getByRole("button", { name: "生成待审批批次" }).click();

  const outreach = page.getByRole("region", { name: "批次审批与执行回执" });
  await expect(outreach).toContainText("今日剩余限额");
  const exactMessage = "您好，这是人工修订后的精确私信，可以为您整理能耗与交付对比。";
  await outreach.getByLabel("精确私信").first().fill(exactMessage);
  await outreach.getByRole("button", { name: "保存为新修订" }).click();
  await expect(outreach).toContainText("文案修订 2");
  await expect(outreach.getByLabel("精确私信").first()).toHaveValue(exactMessage);

  await outreach.getByLabel("我已逐条核对评论、私信与剩余限额").check();
  await outreach.getByRole("button", { name: "确认审批并排队" }).click();
  await expect(outreach).toContainText("修订冲突已刷新");
  await outreach.getByLabel("我已逐条核对评论、私信与剩余限额").check();
  await outreach.getByRole("button", { name: "确认审批并排队" }).click();
  await expect(outreach).toContainText("平台回执：DY-COMMENT-RECEIPT", { timeout: 10_000 });
  await expect(outreach).toContainText("平台回执：DY-MESSAGE-RECEIPT", { timeout: 10_000 });

  await outreach.getByRole("button", { name: "暂停批次" }).click();
  await expect(outreach.getByRole("button", { name: "恢复批次" })).toBeVisible();
  await outreach.getByRole("button", { name: "恢复批次" }).click();
  await expect(outreach.getByRole("button", { name: "暂停批次" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("region", { name: "投放批次审批与执行回执" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "批次审批与执行回执" })).toContainText("DY-MESSAGE-RECEIPT", { timeout: 10_000 });
  await expect(page.locator("body")).not.toContainText(/cookie|accountHandle|browserProfile|leaseToken|account-fixture|candidate-creator/iu);

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(workspace).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect(await page.evaluate(() => window.scrollY > 0)).toBe(true);
  }

  expect(expectedConflicts).toHaveLength(1);
  expect(genericDependencyRequests).toEqual([]);
  expect(unexpectedHttpErrors).toEqual([]);
  expect(consoleProblems).toEqual([]);
});
