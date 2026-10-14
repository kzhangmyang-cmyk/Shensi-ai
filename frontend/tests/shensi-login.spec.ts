import { expect, test } from "@playwright/test";

test("login has complete theme artwork and restores the last choice on a new session", async ({ page, browser }) => {
  await page.goto("/");
  await page.locator('.login-theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.shensi-login-light-art')).toBeVisible();
  await expect(page.locator('.shensi-login-art')).toBeHidden();
  await expect(page.locator('.shensi-login-story')).not.toHaveCSS('background-color', 'rgb(6, 18, 16)');
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#loginButton')).toBeVisible();
    if (width === 390 || width === 1440) await page.screenshot({ path: `/tmp/shensi-login-light-${width}.png`, fullPage: true });
  }
  // Recreate the context with persisted appearance. The blocking bootstrap must
  // restore the theme even if application/session code never loads.
  const state = await page.context().storageState();
  const reopened = await browser.newContext({ storageState: state });
  await reopened.route('**/src/**', route => route.request().resourceType() === 'script' ? route.abort() : route.continue());
  const login = await reopened.newPage();
  await login.goto(page.url());
  await expect(login.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(login.locator('.shensi-login-light-art')).toBeVisible();
  await reopened.close();
  await page.locator('.login-theme-toggle').click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.shensi-login-art')).toBeVisible();
  await expect(page.locator('.shensi-login-light-art')).toBeHidden();
  await page.screenshot({ path: '/tmp/shensi-login-dark-1440.png', fullPage: true });
});

test("Shensi login is the only unauthenticated shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Shensi 登录" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "登录燊锶" })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "注册燊锶" })).toBeVisible();
  await expect(page.locator("#loginDescription")).toContainText("独立工作区");
  await expect(page.locator("#loginEmail")).toHaveAttribute(
    "pattern",
    "[A-Za-z0-9][A-Za-z0-9_-]{2,31}"
  );
  await expect(page.locator("#loginPassword")).toHaveAttribute("minlength", "8");
  await expect(page.locator("#loginPassword")).toHaveAttribute("autocomplete", "new-password");
  await expect(modeToggle).toHaveCSS("background-image", "none");

  await modeToggle.click();
  await expect(page.getByRole("heading", { name: "登录燊锶" })).toBeVisible();
  await expect(page.locator("#loginEmail")).not.toHaveAttribute("pattern", /.+/u);
  await expect(page.locator("#loginPassword")).not.toHaveAttribute("minlength", /.+/u);
  await modeToggle.click();

  await page.locator("#loginEmail").fill("new_account");
  await page.locator("#loginPassword").fill("12345678");
  await page.getByRole("button", { name: "注册账号", exact: true }).click();

  await expect(page.locator("body")).toHaveClass(/is-authenticated/u);
  await expect(page.locator("body")).toHaveAttribute("data-session-workspace-id", "registered-team");
  await expect(page.locator(".replica-shell")).toBeVisible();
  expect(requests).toEqual([{ account: "new_account", password: "12345678" }]);
});
