import { expect, test, type Page } from "@playwright/test";

const FIXTURE = "http://127.0.0.1:5391";

test.beforeEach(async ({ page, request }) => {
  // Seed only the isolated HTTP fixture; never run collection or outreach.
  await request.post(`${FIXTURE}/__fixture/reset`);
  await request.post(`${FIXTURE}/api/auth/login`, {
    data: { email: "admin@example.com", password: "fixture-password" }
  });
  const seeded = await request.post(`${FIXTURE}/api/v1/acquisition/plans`, {
    headers: { "x-csrf-token": "fixture-csrf" },
    data: { name: "轮播回归计划", executionMode: "douyin_mediacrawler",
      targetPlatform: "douyin", providerConnections: [], operations: [] }
  });
  expect(seeded.status()).toBe(201);
  await page.goto("/#acquisition");
  await page.locator("#loginEmail").fill("admin@example.com");
  await page.locator("#loginPassword").fill("fixture-password");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await expect(page.locator("#replicaRealTaskList")).toContainText("轮播回归计划");
  await page.locator("#replicaFlowStage").scrollIntoViewIfNeeded();
});

async function selected(page: Page, platform: string, position: string) {
  await expect(page.locator(".replica-flow-card.is-selected .replica-flow-card-name"))
    .toHaveText(platform);
  await expect(page.locator("#replicaFlowPosition")).toHaveText(position);
  await expect(page.locator('.replica-flow-card[aria-selected="true"]')).toHaveCount(1);
}

test("platform selector browses pending cards without replacing the real task or writing", async ({ page }) => {
  await expect(page).toHaveTitle("Shensi · 多智能体增长与经营系统");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.locator("#replicaFlowStage").screenshot({ path: "/tmp/shensi-platform-before.png" });
  const writes: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/")
      && !["GET", "HEAD"].includes(request.method())) writes.push(request.url());
  });
  const originalTask = await page.locator("#replicaDetailNameText").textContent();
  await page.getByRole("button", { name: "选择下一个项目" }).click();
  await selected(page, "快手获客", "2 / 5");
  const pending = page.locator("#replicaFlowCardKuaishou");
  await expect(pending).toHaveAttribute("data-acquisition-pending", "true");
  await expect(pending.locator(".replica-flow-card-state")).toContainText("待接入");
  await expect(pending).not.toHaveAttribute("aria-disabled", "true");
  expect(await page.locator("#replicaDetailNameText").textContent()).toBe(originalTask);
  await expect(page.locator(".replica-task-group:not(.real):visible")).toHaveCount(0);

  await pending.press("End");
  await selected(page, "微信承接", "5 / 5");
  await page.getByRole("button", { name: "选择下一个项目" }).click();
  await selected(page, "抖音获客", "1 / 5");
  await page.getByRole("button", { name: "选择上一个项目" }).click();
  await selected(page, "微信承接", "5 / 5");
  await page.locator("#replicaFlowCardWechat").press("Home");
  await selected(page, "抖音获客", "1 / 5");
  await page.locator("#replicaFlowCardDouyin").press("ArrowRight");
  await selected(page, "快手获客", "2 / 5");

  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/acquisition/overview");
  await page.evaluate(() => document.dispatchEvent(new Event("goodjob:acquisition-refresh-requested")));
  await refreshed;
  await expect(page.locator('#replicaRealTaskList[aria-busy="false"]')).toBeVisible();
  await selected(page, "快手获客", "2 / 5");
  await expect(pending.locator(".replica-flow-card-state")).toContainText("待接入");
  await page.setViewportSize({ width: 1280, height: 800 });
  await selected(page, "快手获客", "2 / 5");
  await page.locator("#replicaFlowStage").screenshot({ path: "/tmp/shensi-platform-after.png" });
  expect(writes).toEqual([]);
});

test("platform selector side click, swipe and wheel retain the original transform animation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const stage = page.locator("#replicaFlowStage");
  const next = page.locator("#replicaFlowCardKuaishou");
  await next.click({ position: { x: 100, y: 120 } });
  await selected(page, "快手获客", "2 / 5");
  await expect.poll(() => next.evaluate(element =>
    element.getAnimations().filter(animation => animation.playState === "running").length
  )).toBe(0);
  const before = await next.evaluate(element => getComputedStyle(element).transform);
  await page.getByRole("button", { name: "选择下一个项目" }).click();
  await selected(page, "小红书获客", "3 / 5");
  const during = await next.evaluate(element => ({
    transform: getComputedStyle(element).transform,
    animations: element.getAnimations().map(animation => ({
      property: (animation as CSSTransition).transitionProperty,
      duration: animation.effect?.getTiming().duration
    }))
  }));
  expect(during.animations).toContainEqual({ property: "transform", duration: 480 });
  await expect.poll(() => next.evaluate(element => element.getAnimations().length)).toBe(0);
  const after = await next.evaluate(element => getComputedStyle(element).transform);
  expect(after).not.toBe(before);
  expect(during.transform).not.toBe(after);

  const bounds = await stage.boundingBox();
  if (!bounds) throw new Error("platform stage not visible");
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 100, y, { steps: 8 });
  await page.mouse.up();
  await selected(page, "微博获客", "4 / 5");
  await page.mouse.wheel(180, 0);
  await selected(page, "微信承接", "5 / 5");
  await expect(stage).not.toHaveClass(/is-dragging/);
  expect(errors).toEqual([]);
});

test("platform selector remains browsable at mobile width and honors reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#replicaFlowStage").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "选择下一个项目" }).click();
  await selected(page, "快手获客", "2 / 5");
  await expect(page.locator("#replicaFlowCardKuaishou")).toBeInViewport();
  const duration = await page.locator("#replicaFlowCardKuaishou")
    .evaluate(element => getComputedStyle(element).transitionDuration);
  expect(duration.split(",").every(value => parseFloat(value) <= 0.001)).toBe(true);
  await page.locator("#replicaFlowStage").screenshot({ path: "/tmp/shensi-platform-mobile.png" });
});
