import { expect, test } from "@playwright/test";

test("actual Shensi session and CSRF connect to the deterministic private MediaCrawler service", async ({ page }) => {
  const externalDouyinRequests: string[] = [];
  const badResponses: string[] = [];
  page.on("request", (request) => {
    const host = new URL(request.url()).hostname;
    if (/(?:^|\.)(?:douyin|iesdouyin)\.com$/iu.test(host)) externalDouyinRequests.push(request.url());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()}:${new URL(response.url()).pathname}`);
  });

  await page.goto("/#acquisition");
  await expect(page.getByRole("region", { name: "Shensi 登录" })).toBeVisible();
  await page.locator("#loginEmail").fill("admin@goodjob.com");
  await page.locator("#loginPassword").fill("goodjob123");
  await page.getByRole("button", { name: "登录工作台" }).click();

  const workspace = page.getByRole("region", { name: "抖音自动获客工作台" });
  await expect(workspace).toBeVisible();
  await expect(workspace.locator("[data-douyin-keyword]")).toHaveCount(2);
  await expect(workspace).toContainText("连接抖音账号");
  await workspace.getByRole("button", { name: "扫码连接" }).click();
  await expect(page.getByRole("dialog", { name: /请使用抖音扫码|账号已连接/u })).toBeVisible();
  await expect(page.getByText("Task 10 Deterministic Account")).toBeVisible({ timeout: 10_000 });

  const cookies = await page.context().cookies("http://127.0.0.1:5588");
  expect(cookies.some((cookie) => cookie.name === "gj_session" && cookie.httpOnly)).toBe(true);
  expect(cookies.some((cookie) => cookie.name === "gj_csrf" && !cookie.httpOnly)).toBe(true);
  await page.reload();
  await expect(page.getByText("Task 10 Deterministic Account")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/accountHandle|browserProfile|leaseToken|service-secret/iu);
  expect(externalDouyinRequests).toEqual([]);
  expect(badResponses).toEqual([]);
});
