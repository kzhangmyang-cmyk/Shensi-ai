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

test("registration creates an independent workspace from the existing account form", async ({ page }) => {
  const requests: unknown[] = [];
  await page.route("**/api/auth/register", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        user: {
          id: "registered-user",
          name: "new_account",
          email: "new_account@shensi.local",
          role: "admin",
          teamId: "registered-team",
          avatar: "NE"
        }
      })
    });
  });

  await page.goto("/");
  const modeToggle = page.locator("#loginModeToggle");
  await expect(modeToggle).toBeVisible();
  await modeToggle.click();
  await expect(page.getByRole("heading", { name: "注册 Shensi" })).toBeVisible();
  await expect(page.locator("#loginDescription")).toContainText("独立工作区");
  await expect(page.locator("#loginEmail")).toHaveAttribute(
    "pattern",
    "[A-Za-z0-9][A-Za-z0-9_-]{2,31}"
  );
  await expect(page.locator("#loginPassword")).toHaveAttribute("minlength", "8");
  await expect(page.locator("#loginPassword")).toHaveAttribute("autocomplete", "new-password");
  await expect(modeToggle).toHaveCSS("background-image", "none");

  await modeToggle.click();
  await expect(page.getByRole("heading", { name: "登录 Shensi" })).toBeVisible();
  await expect(page.locator("#loginEmail")).not.toHaveAttribute("pattern", /.+/u);
  await expect(page.locator("#loginPassword")).not.toHaveAttribute("minlength", /.+/u);
  await modeToggle.click();

  await page.locator("#loginEmail").fill("new_account");
  await page.locator("#loginPassword").fill("12345678");
  await page.getByRole("button", { name: "注册并进入工作台" }).click();

  await expect(page.locator("body")).toHaveClass(/is-authenticated/u);
  await expect(page.locator("body")).toHaveAttribute("data-session-workspace-id", "registered-team");
  await expect(page.locator(".replica-shell")).toBeVisible();
  expect(requests).toEqual([{ account: "new_account", password: "12345678" }]);
});
