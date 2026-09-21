import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "finance-import.spec.ts",
  timeout: 20_000,
  use: { baseURL: "http://127.0.0.1:5198", channel: "chrome" },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5198 --strictPort --mode desktop",
    url: "http://127.0.0.1:5198",
    reuseExistingServer: false
  }
});
