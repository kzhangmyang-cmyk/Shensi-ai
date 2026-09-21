import { defineConfig, devices } from "@playwright/test";

// The spec owns an isolated desktop Renderer and HTTP fixture. No native app or DB.
export default defineConfig({
  testDir: "./tests",
  outputDir: "/tmp/shensi-agent-navigation-playwright",
  testMatch: "financial-council-agent-center.spec.ts",
  grep: /council preparation anchors/u,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  workers: 1,
  retries: 0,
  reporter: "line",
  use: { trace: "retain-on-failure", viewport: { width: 1280, height: 768 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } }]
});
