import { expect, test } from "@playwright/test";

test("Shensi login is the only unauthenticated shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Shensi 登录" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "登录 Shensi" })).toBeVisible();
  await expect(page.locator(".replica-shell")).toBeHidden();
  await expect(page.locator("#loginEmail")).toHaveValue("");
  await expect(page.locator("#loginPassword")).toHaveValue("");
  await expect(page.getByText("GoodJob 自动营销系统")).toHaveCount(0);
  for (const width of [390, 1024, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
