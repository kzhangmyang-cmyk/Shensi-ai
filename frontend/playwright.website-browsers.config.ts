import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "website-browser-compat.spec.ts",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:5694", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "WEBSITE_PORT=5694 WEBSITE_ALLOWED_ORIGINS=http://127.0.0.1:5694 node ../website/server/server.mjs",
    url: "http://127.0.0.1:5694/",
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
