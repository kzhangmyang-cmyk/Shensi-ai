import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: [
    "demo-auth.spec.ts",
    "acquisition-performance.spec.ts",
    "acquisition-identity-resolution.spec.ts",
    "acquisition-comment-automation.spec.ts",
    "acquisition-visual-reader.spec.ts",
    "growth-bootstrap.spec.ts",
    "growth-financial-council.spec.ts"
  ],
  timeout: 20_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://127.0.0.1:5388",
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" }
    }
  ],
  webServer: {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5388",
    cwd: ".",
    url: "http://127.0.0.1:5388/",
    reuseExistingServer: false,
    timeout: 20_000
  }
});
