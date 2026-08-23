import { expect, test, type Page } from "@playwright/test";

async function useSavedDemoSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("gj_user", JSON.stringify({
      id: "demo-admin",
      name: "Admin",
      email: "admin@goodjob.com",
      role: "admin",
      teamId: "demo-team",
      avatar: "AD"
    }));
  });
}

test("root and legacy dashboard open the agent center only", async ({ page }) => {
  await page.goto("/");
  await page.locator("#loginButton").click();

  await expect(page).toHaveURL(/#agents$/u);
  await expect(page.getByRole("heading", { name: "AI 经营顾问团队" })).toBeVisible();
  await expect(page.locator(".agent-card")).toHaveCount(6);
  await expect(page.locator(".shell")).toHaveCount(0);
  await expect(page.locator("#dashboard")).toHaveCount(0);

  await page.goto("/#dashboard");
  await expect(page).toHaveURL(/#agents$/u);
  await expect(page.getByRole("heading", { name: "AI 经营顾问团队" })).toBeVisible();
});

test("supported business deep links stay on their existing hosts", async ({ page }) => {
  await useSavedDemoSession(page);

  await page.goto("/#acquisition");
  await expect(page.locator(".replica-shell")).toBeVisible();
  await expect(page.locator('[data-replica-module-panel="acquisition"]').first()).toBeVisible();

  await page.goto("/#private-domain");
  await expect(page.locator("#demoModuleMain")).toBeVisible();
  await expect(page.locator("#replicaHeaderTitle")).toHaveText("私域客户池");

  for (const hash of ["#growth/agents", "#financial-council"]) {
    await page.goto(`/${hash}`);
    await expect(page).toHaveURL(new RegExp(`${hash.replace("/", "\\/")}$`, "u"));
    await expect(page.locator("#growthWorkspace")).toBeVisible();
    await expect(page.locator(".replica-shell")).toBeHidden();
    await expect(page.locator(".shell")).toHaveCount(0);
    await expect(page.locator("#dashboard")).toHaveCount(0);
  }
});

test("agent center has no page-level horizontal overflow at critical widths", async ({ page }) => {
  await useSavedDemoSession(page);
  await page.goto("/#agents");
  await expect(page.getByRole("heading", { name: "AI 经营顾问团队" })).toBeVisible();

  for (const width of [1440, 1366, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect.poll(() => page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }))).toEqual({ clientWidth: width, scrollWidth: width });
  }
});
