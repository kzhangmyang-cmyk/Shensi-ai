import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(frontendRoot, "..");

export default defineConfig({
  testDir: "./tests",
  testMatch: "financial-council-real-runtime.spec.ts",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: { baseURL: "http://127.0.0.1:5588", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [{
    command: "pnpm --filter ./backend start:financial-council:real-e2e",
    cwd: repositoryRoot,
    url: "http://127.0.0.1:4288/healthz",
    reuseExistingServer: false,
    timeout: 120_000
  }, {
    command: "VITE_API_TARGET=http://127.0.0.1:4288 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5588",
    cwd: frontendRoot,
    url: "http://127.0.0.1:5588/",
    reuseExistingServer: false,
    timeout: 30_000
  }]
});
