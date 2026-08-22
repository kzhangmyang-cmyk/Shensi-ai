import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(frontendRoot, "..");
const backendRoot = process.env.GOODJOB_BACKEND_ROOT
  ?? repositoryRoot;

export default defineConfig({
  testDir: "./tests",
  testMatch: "growth-financial-council-real.spec.ts",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
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
  webServer: [
    {
      command: "NODE_ENV=test PORT=4288 pnpm --filter ./backend exec tsx src/financial-council-real-e2e-server.ts",
      cwd: backendRoot,
      url: "http://127.0.0.1:4288/healthz",
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: "VITE_API_TARGET=http://127.0.0.1:4288 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5388",
      cwd: ".",
      url: "http://127.0.0.1:5388/",
      reuseExistingServer: false,
      timeout: 30_000
    }
  ]
});
