import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "decision-analysis-theme.spec.ts",
  use: { baseURL: "http://127.0.0.1:5389", ...devices["Desktop Chrome"], channel: "chrome" },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --mode desktop --host 127.0.0.1 --port 5389",
    url: "http://127.0.0.1:5389/tests/decision-analysis-visual.html",
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
