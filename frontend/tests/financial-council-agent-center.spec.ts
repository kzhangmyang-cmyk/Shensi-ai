import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import manifest from "../contracts/pinned/growth-advisor-quote-roi.manifest.json";
import {
  financialCouncilFixture,
  financialCouncilPolicyFixture
} from "./fixtures/growth-contract";

const FRONTEND_ORIGIN = "http://127.0.0.1:5488";
const BACKEND_PORT = 4388;
const roles = ["cfo", "finance", "profit", "cost", "cashflow", "tax"] as const;
const connection = {
  connectionId: "connection-primary", displayName: "OpenAI 企业连接",
  provider: "openai", model: "gpt-5"
};
const fallback = {
  connectionId: "connection-fallback", displayName: "DeepSeek 备用连接",
  provider: "deepseek", model: "deepseek-chat"
};
const autoRoute = {
  mode: "auto", primaryConnectionId: null, fallbackConnectionIds: [],
  preferenceWeightBps: 0
};
const routingPolicy = {
  policyVersionId: "policy-real-1", revision: 1,
  maxRoleBudgetMinor: 1_000, maxRunBudgetMinor: 6_000,
  requestTimeoutMs: 30_000, createdAt: "2026-08-23T00:00:00.000Z",
  roles: Object.fromEntries(roles.map((role) => [role, { ...autoRoute }]))
};
const sourceFiles = roles.slice(0, 3).map((_, index) => ({
  kind: ["balance_sheet", "income_statement", "cash_flow_statement"][index],
  fileName: ["balance.xlsx", "income.xlsx", "cashflow.xlsx"][index],
  fileHash: `sha256:${String(index + 1).repeat(64)}`,
  mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  sheetNames: ["Sheet1"]
}));

let fixtureServer: Server;
let vite: ChildProcess;
const requests: Array<{ method: string; path: string; body: string }> = [];

function json(response: import("node:http").ServerResponse, body: unknown,
  status = 200, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fixtureServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const path = request.url ?? "/";
      const method = request.method ?? "GET";
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method, path, body });
      if (method === "GET" && path === "/api/auth/me") return json(response, {
        user: { id: "admin-real", name: "真实管理员", email: "admin@goodjob.test",
          role: "admin", teamId: "team-real", avatar: "RA" }
      });
      if (method === "POST" && path === "/api/auth/logout") return json(response, {});
      if (method === "GET" && path === "/api/v1/growth/bootstrap") return json(response, {
        status: "ready", workspaceId: "workspace-real",
        capabilityRegistryVersion: "growth-capabilities.v1",
        capabilities: ["finance.council.run", "finance.council.approve",
          "finance.council.policy.manage"],
        contractVersion: manifest.contractVersion, contractHash: manifest.contractHash,
        features: ["finance", "advisor"]
      });
      if (method === "GET" && path === "/api/v1/finance/council-agent-center") {
        return json(response, {
          capabilities: { canApprove: true, canManageRouting: true, canRun: true },
          data: { status: "not_connected", packageId: null, companyName: null,
            period: null, verifiedAt: null, warningCodes: [] },
          models: { status: "ready", routingPolicyVersionId: "policy-real-1",
            roles: roles.map((role) => ({ role, status: "ready",
              connectionDisplayName: connection.displayName,
              provider: connection.provider, model: connection.model })) },
          latestRun: null
        });
      }
      if (method === "GET" && path === "/api/v1/finance/council-model-routing-policy") {
        return json(response, routingPolicy, 200, {
          etag: '"financial-council-policy:workspace-real:1"'
        });
      }
      if (method === "POST" && path === "/api/v1/finance/council-model-routing-policy/preview") {
        return json(response, { roles: roles.map((role) => ({
          role, selectedConnection: connection,
          orderedConnections: [connection, fallback],
          reasonCodes: ["structured_output_certified", "recent_success_rate"],
          missingCapabilities: []
        })) });
      }
      if (method === "PUT" && path === "/api/v1/finance/council-model-routing-policy") {
        return json(response, { ...routingPolicy, revision: 2 }, 200, {
          etag: '"financial-council-policy:workspace-real:2"'
        });
      }
      if (method === "POST" && path === "/api/v1/finance/statement-packages/preview") {
        return json(response, {
          previewId: "preview-real-1", status: "preview", companyName: "真实制造企业",
          period: "2026-07", currency: "CNY", parserVersion: "financial-statements.v2",
          sourceFiles, warningCodes: ["period_requires_review"],
          createdAt: "2026-08-23T00:00:00.000Z",
          expiresAt: "2026-08-23T00:30:00.000Z"
        });
      }
      if (method === "POST" && path === "/api/v1/finance/statement-packages/preview-real-1/commit") {
        return json(response, {
          packageId: "package-real-1", status: "verified", companyName: "真实制造企业",
          period: "2026-07", currency: "CNY", parserVersion: "financial-statements.v2",
          sourceFiles, warningCodes: ["period_requires_review"],
          createdAt: "2026-08-23T00:00:00.000Z", expiresAt: null
        }, 201);
      }
      if (method === "POST" && path === "/api/v1/finance/council-runs") {
        return json(response, financialCouncilFixture.awaitingApproval, 202, {
          etag: '"council-run-fixture:7"'
        });
      }
      if (method === "GET" && path === "/api/v1/finance/council-runs/council-run-fixture/agents") {
        return json(response, {
          runId: "council-run-fixture", revision: 7, status: "awaiting_approval",
          updatedAt: "2026-08-23T00:00:10.000Z",
          roles: roles.map((role, index) => ({
            role, phase: role === "cfo" ? "consensus" : "analysis", status: "completed",
            attempts: index === 1 ? [{ attempt: 1, completedAt: "2026-08-23T00:00:05.000Z",
              connectionDisplayName: connection.displayName, errorCode: "MODEL_TIMEOUT",
              model: connection.model, provider: connection.provider,
              startedAt: "2026-08-23T00:00:01.000Z", status: "failed" },
            { attempt: 2, completedAt: "2026-08-23T00:00:09.000Z",
              connectionDisplayName: fallback.displayName, errorCode: null,
              model: fallback.model, provider: fallback.provider,
              startedAt: "2026-08-23T00:00:06.000Z", status: "succeeded" }] : [{
              attempt: 1, completedAt: "2026-08-23T00:00:09.000Z",
              connectionDisplayName: connection.displayName, errorCode: null,
              model: connection.model, provider: connection.provider,
              startedAt: "2026-08-23T00:00:01.000Z", status: "succeeded"
            }]
          }))
        });
      }
      if (method === "GET" && path === "/api/v1/finance/council-runs/council-run-fixture") {
        return json(response, financialCouncilFixture.awaitingApproval, 200, {
          etag: '"council-run-fixture:7"'
        });
      }
      if (method === "GET" && path.startsWith("/api/v1/finance/council-runs/council-run-fixture/events")) {
        return json(response, { items: [], nextAfter: null, hasMore: false });
      }
      if (method === "GET" && path === "/api/v1/finance/council-policy") {
        return json(response, financialCouncilPolicyFixture, 200, {
          etag: '"council-policy-v1:1"'
        });
      }
      return json(response, { code: "fixture_route_missing", message: "fixture_route_missing",
        details: null, requestId: "fixture", retryable: false }, 501);
    });
  });
  await new Promise<void>((resolve) => fixtureServer.listen(BACKEND_PORT, "127.0.0.1", resolve));
  const frontendDir = fileURLToPath(new URL("..", import.meta.url));
  vite = spawn(process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5488"], {
      cwd: frontendDir,
      env: { ...process.env, VITE_API_TARGET: `http://127.0.0.1:${BACKEND_PORT}` },
      stdio: "ignore"
    });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(FRONTEND_ORIGIN)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("real frontend fixture did not start");
});

test.afterAll(async () => {
  vite?.kill("SIGTERM");
  await new Promise<void>((resolve) => fixtureServer?.close(() => resolve()));
});

test("runs real three-report onboarding and Council inside one black shell", async ({ page }) => {
  await page.addInitScript(() => {
    document.cookie = "gj_csrf=real-csrf; path=/";
    localStorage.setItem("gj_user", JSON.stringify({
      id: "admin-real", name: "真实管理员", email: "admin@goodjob.test",
      role: "admin", teamId: "team-real", avatar: "RA"
    }));
  });
  await page.goto(`${FRONTEND_ORIGIN}/#growth/agents`);
  await expect(page).toHaveURL(/#agents$/u);
  await expect(page.locator("body")).toHaveAttribute("data-session-mode", "real");
  await expect(page.locator(".replica-shell")).toHaveCount(1);
  await expect(page.locator(".replica-shell")).toBeVisible();
  await expect(page.locator("#growthWorkspace")).toBeHidden();
  await expect(page.locator("#demoModuleMain [data-agent-center-authority=real]")).toBeVisible();
  await expect(page.locator(".real-agent-card")).toHaveCount(6);
  await expect(page.locator('[data-agents-action="sample-report"]')).toHaveCount(0);

  await page.locator('[data-routing-action="open"]').first().click();
  await expect(page.locator("[data-routing-dialog]")).toBeVisible();
  await expect(page.locator("[data-routing-role]")).toHaveCount(6);
  await expect(page.locator('[data-routing-action="save"]')).toBeVisible();
  await page.getByRole("button", { name: "关闭模型路由" }).click();

  const uploads = [
    ["balance_sheet", "balance.xlsx"],
    ["income_statement", "income.xlsx"],
    ["cash_flow_statement", "cashflow.xlsx"]
  ] as const;
  for (const [kind, name] of uploads) {
    await page.locator(`[data-statements-file="${kind}"]`).setInputFiles({
      name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(`fixture-${kind}`)
    });
  }
  await expect(page.locator("[data-statements-selection]")).toHaveText("已选择 3 / 3 份必需报表");
  await page.locator('[data-real-action="preview"]').click();
  await expect(page.getByRole("heading", { name: "解析预览" })).toBeVisible();
  await expect(page.getByText("真实制造企业")).toBeVisible();
  await expect(page.locator('[data-real-action="commit"]')).toBeDisabled();
  await page.locator("[data-real-consent]").check();
  await page.locator('[data-real-action="commit"]').click();
  await expect(page.getByText(/已验证：真实制造企业/u)).toBeVisible();
  await page.locator('[data-real-action="run"]').click();

  await expect(page).toHaveURL(/#financial-council\/run\/council-run-fixture$/u);
  await expect(page.locator(".replica-shell")).toBeVisible();
  await expect(page.locator("#demoModuleMain .council-workbench")).toBeVisible();
  await expect(page.getByRole("heading", { name: "财务委员会工作台" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "六角色进度" })).toBeVisible();
  await expect(page.getByText("确认后只创建草稿和待办，不执行任何财务动作。")).toBeVisible();

  for (const width of [1440, 1366, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect.poll(() => page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }))).toEqual({ clientWidth: width, scrollWidth: width });
  }
  expect(requests.some((request) => request.path.includes("statement-packages/preview"))).toBe(true);
  expect(requests.some((request) => request.path === "/api/v1/finance/council-runs")).toBe(true);
});

test("reload, route exit, and logout replace the authority lifecycle cleanly", async ({ page }) => {
  await page.addInitScript(() => {
    document.cookie = "gj_csrf=real-csrf; path=/";
    localStorage.setItem("gj_user", JSON.stringify({
      id: "admin-real", name: "真实管理员", email: "admin@goodjob.test",
      role: "admin", teamId: "team-real", avatar: "RA"
    }));
  });
  await page.goto(`${FRONTEND_ORIGIN}/#financial-council/run/council-run-fixture`);
  await expect(page).toHaveURL(/#financial-council\/run\/council-run-fixture$/u);
  await expect(page.getByRole("heading", { name: "财务委员会工作台" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "财务委员会工作台" })).toBeVisible();
  await expect(page.locator(".replica-shell")).toHaveCount(1);

  await page.evaluate(() => { window.location.hash = "#agents"; });
  await expect(page.locator("#demoModuleMain [data-agent-center-authority=real]")).toBeVisible();
  await expect(page.locator("#demoModuleMain .council-workbench")).toHaveCount(0);
  await expect(page.locator(".replica-shell")).toHaveCount(1);

  await page.locator("#replicaLogoutButton").click();
  await expect(page.locator(".login-screen")).toBeVisible();
  await expect(page.locator("#demoModuleMain")).toBeEmpty();
  await expect(page.locator("#demoModuleInspector")).toBeEmpty();
  await expect(page.locator("[data-agent-center-authority=real]")).toHaveCount(0);
});
