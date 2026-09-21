import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(frontendRoot, "..");

export default defineConfig({
  testDir: "./tests",
  testMatch: "douyin-mediacrawler-real.spec.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: { baseURL: "http://127.0.0.1:5588", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
  webServer: [
    {
      command: "uv run --frozen --project services/media-crawler uvicorn --factory shensi_adapter.e2e_fixture:create_app_from_environment --app-dir services/media-crawler --host 127.0.0.1 --port 5491 --workers 1 --timeout-graceful-shutdown 20",
      cwd: repositoryRoot,
      url: "http://127.0.0.1:5491/internal/v1/health",
      reuseExistingServer: false,
      timeout: 60_000,
      ignoreHTTPSErrors: false
    },
    {
      command: "pnpm --filter ./backend exec tsx src/douyin-mediacrawler-real-e2e-server.ts",
      cwd: repositoryRoot,
      url: "http://127.0.0.1:5488/healthz",
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: "VITE_API_TARGET=http://127.0.0.1:5488 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5588 --strictPort",
      cwd: frontendRoot,
      url: "http://127.0.0.1:5588/",
      reuseExistingServer: false,
      timeout: 30_000
    }
  ]
});
