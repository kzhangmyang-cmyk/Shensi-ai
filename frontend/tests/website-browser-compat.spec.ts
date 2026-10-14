import { expect, test } from "@playwright/test";

test("website routes, mobile menu, and delivery-unavailable state work without Chrome", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));

  await page.goto("/");
  await expect(page.locator("main h1")).toBeVisible();
  await expect(page).toHaveTitle(/燊锶|Shensi/);
  await expect(page.locator(".vite-error-overlay, nextjs-portal")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.locator(".menu-toggle");
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.goto("/en/products/simulation");
  await expect(page.locator("main h1")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  await page.goto("/contact?need=demo");
  await expect(page.locator("#need")).toHaveValue("demo");
  await page.locator('[name="name"]').fill("Browser acceptance");
  await page.locator('[name="company"]').fill("Synthetic Company");
  await page.locator('[name="email"]').fill("browser-test@example.invalid");
  await page.locator('[name="industry"]').fill("Software");
  await page.locator('[name="message"]').fill("This is a synthetic compatibility check without real delivery.");
  await page.locator('[name="consent"]').check();
  await page.locator('#inquiry-form [type="submit"]').click();
  await expect(page.locator("#form-status")).toContainText("尚未开通");
  await expect(page.locator('[name="email"]')).toHaveValue("browser-test@example.invalid");
  await page.screenshot({ path: `/tmp/shensi-website-browser-${testInfo.project.name}.png` });
  expect(errors).toEqual([]);
});
