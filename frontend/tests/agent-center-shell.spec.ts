import { expect, test, type Page } from "@playwright/test";
import {
  growthContractScenario,
  installGrowthContractScenario
} from "./fixtures/growth-contract";

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

test("root and same-page legacy hashes normalize to the agent center only", async ({ page }) => {
  await page.goto("/");
  await page.locator("#loginButton").click();

  await expect(page).toHaveURL(/#agents$/u);
  await expect(page.getByRole("heading", { name: "AI 经营顾问团队" })).toBeVisible();
  await expect(page.locator(".agent-card")).toHaveCount(6);
  await expect(page.locator(".shell")).toHaveCount(0);
  await expect(page.locator("#dashboard")).toHaveCount(0);

  for (const hash of ["#unknown-old-crm", "#dashboard", ""]) {
    await page.evaluate((nextHash) => {
      window.location.hash = nextHash;
    }, hash);
    await expect(page).toHaveURL(/#agents$/u);
    await expect(page.locator(".agent-card")).toHaveCount(6);
  }

  await page.goto("/#dashboard");
  await expect(page).toHaveURL(/#agents$/u);
  await expect(page.getByRole("heading", { name: "AI 经营顾问团队" })).toBeVisible();
});

test("supported business deep links stay inside the one black shell", async ({ page }) => {
  await useSavedDemoSession(page);

  await page.goto("/#acquisition");
  await expect(page.locator(".replica-shell")).toBeVisible();
  await expect(page.locator('[data-replica-module-panel="acquisition"]').first()).toBeVisible();

  await page.goto("/#private-domain");
  await expect(page.locator("#demoModuleMain")).toBeVisible();
  await expect(page.locator("#replicaHeaderTitle")).toHaveText("私域客户池");

  await page.goto("/#growth/agents");
  await expect(page).toHaveURL(/#agents$/u);
  await expect(page.locator("#demoModuleMain")).toBeVisible();
  await expect(page.locator(".replica-shell")).toBeVisible();
  await expect(page.locator("#growthWorkspace")).toBeHidden();

  await page.goto("/#financial-council");
  await expect(page).toHaveURL(/#financial-council$/u);
  await expect(page.locator("#demoModuleMain")).toBeVisible();
  await expect(page.locator(".replica-shell")).toBeVisible();
  await expect(page.locator("#growthWorkspace")).toBeHidden();
});

test("legacy growth agents canonicalize without creating a second instance", async ({ page }) => {
  const installed = await installGrowthContractScenario(
    page,
    growthContractScenario("happy_path")
  );
  await useSavedDemoSession(page);
  await page.goto("/#growth/agents");

  await expect(page).toHaveURL(/#agents$/u);
  await expect(page.locator("#demoModuleMain .agent-card")).toHaveCount(6);
  await expect(page.locator("#growthWorkspace .agent-card")).toHaveCount(0);
  await expect(page.locator(".replica-shell")).toHaveCount(1);
  await installed.dispose();
});

test("real private-domain customers can create an authoritative deal", async ({ page }) => {
  const dealRequests: Array<{
    csrf: string | undefined;
    body: Record<string, unknown>;
  }> = [];
  await page.route("**/api/customers*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        customers: [{
          id: "customer-shell-1",
          company: "厦门增长科技有限公司",
          country: "中国",
          contact: "王总",
          ownerId: "demo-admin",
          teamId: "demo-team",
          stage: "待首次跟进",
          amount: 12880,
          health: 80,
          nextReminder: "2026-08-25T10:30:00.000Z",
          wecomBound: false,
          activities: [],
          acquisitionBindings: [{
            handoffId: "handoff-shell-1",
            leadId: "lead-shell-1",
            candidateId: "candidate-shell-1",
            createdAt: "2026-08-23T08:10:00.000Z"
          }]
        }]
      })
    });
  });
  await page.route("**/api/todos", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ todos: [] })
    });
  });
  await page.route("**/api/deals", async (route) => {
    dealRequests.push({
      csrf: route.request().headers()["x-csrf-token"],
      body: route.request().postDataJSON() as Record<string, unknown>
    });
    const firstAttempt = dealRequests.length === 1;
    await route.fulfill({
      status: firstAttempt ? 503 : 201,
      contentType: "application/json",
      body: JSON.stringify(firstAttempt
        ? { message: "postgres://internal-secret@database" }
        : { deal: { id: "deal-shell-1" } })
    });
  });
  await useSavedDemoSession(page);
  await page.addInitScript(() => {
    document.cookie = "gj_csrf=csrf%2Fdeal-shell; path=/";
  });
  await page.goto("/#private-domain");
  await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".replica-shell");
    if (shell) shell.dataset.acquisitionMode = "real";
    document.dispatchEvent(new CustomEvent(
      "goodjob:acquisition-mode-changed",
      { detail: { mode: "real" } }
    ));
  });

  await page.getByRole("button", { name: "创建真实商机" }).click();
  const dialog = page.locator("#replicaDealCreateDialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#dealCustomerIdInput"))
    .toHaveValue("customer-shell-1");
  const quantityInput = dialog.locator("#dealQuantityInput");
  const unitPriceInput = dialog.locator("#dealUnitPriceInput");
  for (const numericInput of [quantityInput, unitPriceInput]) {
    await expect(numericInput).toHaveAttribute("required", "");
    await expect(numericInput).toHaveAttribute("min", "0.01");
    await expect(numericInput).toHaveAttribute("step", "0.01");
  }
  await dialog.locator("#dealTitleInput").fill("AI 获客绑定商机");
  await dialog.locator("#dealProductInput").fill("GoodJob CRM");
  await dialog.locator("#dealNextActionAtInput").fill("2026-08-25");
  await dialog.locator("#dealExpectedCloseAtInput").fill("2026-09-13");

  for (const invalid of [
    { input: quantityInput, value: "" },
    { input: quantityInput, value: "0" },
    { input: quantityInput, value: "-1" },
    { input: unitPriceInput, value: "" },
    { input: unitPriceInput, value: "0" },
    { input: unitPriceInput, value: "-1" }
  ]) {
    await quantityInput.fill("30");
    await unitPriceInput.fill("600");
    await invalid.input.fill(invalid.value);
    await dialog.locator("#saveDealButton").click();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(dealRequests).toHaveLength(0);
  }

  await quantityInput.fill("30");
  await unitPriceInput.fill("600");
  await dialog.locator("#saveDealButton").click();

  await expect.poll(() => dealRequests).toHaveLength(1);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#replicaDealCreateStatus"))
    .toHaveText("商机创建失败，请稍后重试");
  await expect(dialog).not.toContainText("internal-secret");
  await expect(page).toHaveURL(/#private-domain$/u);

  await dialog.locator("#saveDealButton").click();
  await expect.poll(() => dealRequests).toHaveLength(2);
  expect(dealRequests[1]).toEqual({
    csrf: "csrf/deal-shell",
    body: {
      title: "AI 获客绑定商机",
      customerId: "customer-shell-1",
      product: "GoodJob CRM",
      quantity: 30,
      unitPrice: 600,
      amount: 18000,
      currency: "USD",
      nextAction: "确认采购清单并安排报价",
      nextActionAt: "2026-08-25",
      expectedCloseAt: "2026-09-13",
      acquisitionBinding: {
        handoffId: "handoff-shell-1",
        leadId: "lead-shell-1"
      }
    }
  });
  await expect(page).toHaveURL(/#conversion$/u);
  await expect(page.locator("#replicaToast")).toHaveClass(/show/u);
  await expect(page.locator("#replicaToast")).toContainText("商机已新增");
});

test("deal creation authentication loss closes and clears the top-layer dialog", async ({ page }) => {
  await page.route("**/api/customers*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        customers: [{
          id: "customer-auth-loss",
          company: "敏感客户有限公司",
          country: "中国",
          contact: "李总",
          ownerId: "demo-admin",
          teamId: "demo-team",
          stage: "待首次跟进",
          amount: 18800,
          health: 80,
          nextReminder: "2026-08-25T10:30:00.000Z",
          wecomBound: false,
          activities: [],
          acquisitionBindings: [{
            handoffId: "handoff-auth-loss",
            leadId: "lead-auth-loss",
            candidateId: "candidate-auth-loss",
            createdAt: "2026-08-23T08:10:00.000Z"
          }]
        }]
      })
    });
  });
  await page.route("**/api/todos", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ todos: [] })
    });
  });
  await page.route("**/api/deals", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ message: "登录已失效" })
    });
  });
  await useSavedDemoSession(page);
  await page.addInitScript(() => {
    document.cookie = "gj_csrf=csrf-auth-loss; path=/";
  });
  await page.goto("/#private-domain");
  await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".replica-shell");
    if (shell) shell.dataset.acquisitionMode = "real";
    document.dispatchEvent(new CustomEvent(
      "goodjob:acquisition-mode-changed",
      { detail: { mode: "real" } }
    ));
  });

  await page.getByRole("button", { name: "创建真实商机" }).click();
  const dialog = page.locator("#replicaDealCreateDialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("#dealTitleInput").fill("敏感商机");
  await dialog.locator("#dealProductInput").fill("敏感产品");
  await dialog.locator("#dealNextActionAtInput").fill("2026-08-25");
  await dialog.locator("#saveDealButton").click();

  await expect(page.locator(".login-screen")).toBeVisible();
  await expect(dialog).not.toBeVisible();
  await expect(dialog.locator("#dealCustomerIdInput")).toHaveValue("");
  await expect(dialog.locator("#dealCustomerInput")).toHaveValue("");
  await expect(dialog.locator("#dealTitleInput")).toHaveValue("");
  await expect(dialog.locator("#dealProductInput")).toHaveValue("");
  await expect(dialog.locator("#dealAcquisitionBindingInput option")).toHaveCount(0);
  await expect(dialog).not.toContainText(/敏感客户|敏感商机|敏感产品/u);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page).toHaveURL(/#private-domain$/u);
  await expect(dialog).not.toBeVisible();
});

test("short desktop login overlay scrolls to the login controls", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 300 });
  await page.goto("/");

  const loginScreen = page.locator(".login-screen");
  await expect(loginScreen).toBeVisible();
  const dimensions = await loginScreen.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  await loginScreen.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => loginScreen.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(page.locator("#loginButton")).toBeInViewport();
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
