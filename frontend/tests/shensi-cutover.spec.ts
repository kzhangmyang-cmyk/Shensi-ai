import { expect, test } from "@playwright/test";

test.use({ trace: "off" });

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function targetOrigin(): string {
  const rawOrigin = requiredEnvironmentValue("SHENSI_TEST_ORIGIN");
  const origin = new URL(rawOrigin);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("SHENSI_TEST_ORIGIN_HTTP_REQUIRED");
  }
  origin.hash = "";
  return origin.toString();
}

test("restored Shensi runtime reaches the current acquisition application", async ({ page }) => {
  const origin = targetOrigin();
  const email = requiredEnvironmentValue("SHENSI_TEST_EMAIL");
  const password = requiredEnvironmentValue("SHENSI_TEST_PASSWORD");

  const browserErrors: string[] = [];
  const httpFailures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const source = message.location().url;
      const pathname = source ? new URL(source).pathname : "unknown";
      browserErrors.push(`console.error:${pathname}`);
    }
  });
  page.on("pageerror", () => browserErrors.push("pageerror"));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      httpFailures.push(`http.${response.status()}:${new URL(response.url()).pathname}`);
    }
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin);
  await expect(page).toHaveTitle(/Shensi/u);
  await expect(page.getByRole("heading", { name: "登录 Shensi" })).toBeVisible();
  await expect(page.locator(".shensi-login")).toHaveCSS("background-color", "rgb(5, 8, 6)");

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#loginEmail").fill(email);
  await page.locator("#loginPassword").fill(password);
  await page.locator("#loginButton").click();
  await expect(page.locator(".replica-shell")).toBeVisible();

  await page.goto(`${origin}#acquisition`);
  await expect(page.getByRole("heading", { name: "启动抖音自动获客" })).toBeVisible();
  await expect(page.locator(".shell")).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".replica-shell")).toBeVisible();
  await expect(page.getByRole("heading", { name: "启动抖音自动获客" })).toBeVisible();

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }

  expect({ browserErrors, httpFailures }).toEqual({ browserErrors: [], httpFailures: [] });
});
