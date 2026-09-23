import { expect, test } from "@playwright/test";

function luminance(rgb: string): number {
  const channels = rgb.match(/\d+/gu)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`not an RGB color: ${rgb}`);
  const linear = channels.map((value) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("galaxy artwork and five roles remain legible in both themes and widths", async ({ page }) => {
  await page.goto("/tests/decision-analysis-visual.html");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ["dark", "light"] as const) {
      await page.locator(`[data-theme-fixture="${theme}"]`).click();
      const appearance = await page.evaluate(() => {
        const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        const image = document.querySelector<HTMLImageElement>(".decision-galaxy-base")!;
        return {
          background: style(".decision-galaxy").backgroundColor,
          headline: style(".decision-galaxy > header h3").color,
          role: style(".decision-galaxy-node strong").color,
          detail: style(".decision-galaxy-node small").color,
          sidebar: style(".decision-analysis").backgroundColor,
          imageLoaded: image.complete && image.naturalWidth > 0,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(appearance.imageLoaded).toBe(true);
      expect(appearance.overflow).toBe(false);
      expect(contrast(appearance.headline, appearance.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(appearance.role, appearance.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(appearance.detail, appearance.background)).toBeGreaterThanOrEqual(4.5);
      if (theme === "light") expect(appearance.sidebar).toBe("rgb(255, 255, 255)");
    }
  }
});

test("enterprise query accent actions remain legible in both themes", async ({ page }) => {
  await page.goto("/tests/decision-analysis-visual.html");
  for (const theme of ["dark", "light"] as const) {
    await page.locator(`[data-theme-fixture="${theme}"]`).click();
    const actions = await page.evaluate(() => {
      const root = document.createElement("div");
      root.className = "enterprise-query";
      root.innerHTML = '<form class="enterprise-query-filters"><button type="submit">筛选已有资料</button><button type="button" data-online-search>普通搜索 · 爱企查</button></form>';
      document.body.append(root);
      const colors = [...root.querySelectorAll("button")].map((button) => {
        const computed = getComputedStyle(button);
        return { foreground: computed.color, background: computed.backgroundColor };
      });
      root.remove();
      return colors;
    });
    for (const action of actions) expect(contrast(action.foreground, action.background)).toBeGreaterThanOrEqual(4.5);
  }
});
