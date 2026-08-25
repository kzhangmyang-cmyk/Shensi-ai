import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: [
    "agent-center-shell.spec.ts",
    "demo-auth.spec.ts",
    "shensi-login.spec.ts",
    "acquisition-performance.spec.ts",
    "acquisition-identity-resolution.spec.ts",
    "acquisition-comment-automation.spec.ts",
    "acquisition-visual-reader.spec.ts",
    "douyin-mediacrawler-acquisition.spec.ts",
    "growth-bootstrap.spec.ts",
    "financial-council-agent-center.spec.ts",
    "growth-financial-council.spec.ts"
  ],
  timeout: 20_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://127.0.0.1:5388",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" }
    }
  ],
  webServer: [
    {
      command: "node --import tsx tests/fixtures/douyin-mediacrawler-http-fixture.ts",
      cwd: ".",
      url: "http://127.0.0.1:5391/healthz",
      reuseExistingServer: false,
      timeout: 20_000
    },
    {
      command: "VITE_API_TARGET=http://127.0.0.1:5391 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5388",
      cwd: ".",
      url: "http://127.0.0.1:5388/",
      reuseExistingServer: false,
      timeout: 20_000
    }
  ]
});
