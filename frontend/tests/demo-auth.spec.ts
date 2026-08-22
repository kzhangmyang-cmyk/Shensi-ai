import { expect, test } from "@playwright/test";

test("settings exposes the customer-owned AI model connection center", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (value: unknown) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(value)
    });
    if (url.pathname === "/api/v1/acquisition/providers") {
      return void await json({ items: [], nextCursor: null });
    }
    if (url.pathname === "/api/v1/acquisition/provider-connections") {
      return void await json({ items: [], nextCursor: null });
    }
    if (url.pathname === "/api/v1/ai/connections") {
      return void await json({ items: [], nextCursor: null });
    }
    if (url.pathname === "/api/v1/ai/endpoint-profiles") {
      return void await json({
        items: [{
          provider: "moonshot",
          endpointProfileId: "moonshot-cn",
          region: "cn",
          baseUrl: "https://api.moonshot.cn/v1",
          requiresWorkspaceId: false,
          modelListPolicy: "same_key",
          officialReference: "https://platform.moonshot.cn/docs"
        }],
        nextCursor: null
      });
    }
    await route.fulfill({ status: 404, body: "{}" });
  });
  await page.addInitScript(() => {
    localStorage.setItem("gj_user", JSON.stringify({
      id: "demo-admin",
      name: "Admin",
      email: "admin@goodjob.com",
      role: "admin",
      teamId: "demo-team",
      avatar: "AD"
    }));
  });

  await page.goto("/#settings");
  await page.getByRole("button", { name: "配置 AI 模型" }).click();

  await expect(page.locator("#replicaConnectionCenter")).toBeVisible();
  await expect(page.getByRole("tab", { name: "AI 模型" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByRole("button", {
    name: /Kimi CN 官方端点 新增/
  })).toBeVisible();
  await expect(page.getByRole("textbox", {
    name: /官方 API Key/
  })).toHaveAttribute("type", "password");
});

test("standalone frontend login enters the demo workspace without an API server", async ({ page }) => {
  await page.goto("/#acquisition");
  await page.locator("#loginButton").click();

  await expect(page.locator("body")).toHaveClass(/is-authenticated/);
  await expect(page.locator(".replica-shell")).toBeVisible();
  await expect(page.locator(".toast.error")).toHaveCount(0);
});

test("standalone frontend restores a saved demo session without calling the API", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  await page.addInitScript(() => {
    localStorage.setItem("gj_user", JSON.stringify({
      id: "demo-admin",
      name: "Admin",
      email: "admin@goodjob.com",
      role: "admin",
      teamId: "demo-team",
      avatar: "AD"
    }));
  });

  await page.goto("/#acquisition");

  await expect(page.locator("body")).toHaveClass(/is-authenticated/);
  expect(apiRequests).toEqual([]);
});

test("standalone frontend does not poll backend dashboards in demo mode", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });

  await page.goto("/#acquisition");
  await page.locator("#loginButton").click();
  await expect(page.locator("body")).toHaveClass(/is-authenticated/);
  await page.waitForTimeout(10_250);

  expect(apiRequests).toEqual([]);
});

test("real acquisition overview follows an active run to its terminal status", async ({ page }) => {
  let overviewRequests = 0;
  const statuses = ["queued", "running", "succeeded"] as const;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/acquisition/overview") {
      const status = statuses[Math.min(overviewRequests, statuses.length - 1)]!;
      overviewRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          generatedAt: `2026-08-08T08:00:0${overviewRequests}.000Z`,
          platform: "douyin",
          totals: { tasks: 1 },
          statusCounts: { [status]: 1 },
          discoveryMethodCounts: { public_search: 1 },
          tasks: [{
            id: "plan-live-poll",
            planId: "plan-live-poll",
            name: "自动更新状态的抖音任务",
            objective: "验证运行结果自动回显",
            platform: "douyin",
            discoveryMethods: ["public_search"],
            planStatus: "approved",
            latestRun: {
              id: "run-live-poll",
              status,
              updatedAt: `2026-08-08T08:00:0${overviewRequests}.000Z`,
              completedAt: status === "succeeded"
                ? "2026-08-08T08:00:03.000Z"
                : null,
              evidenceCount: status === "succeeded" ? 4 : 0,
              consumedBudget: {
                requests: status === "queued" ? 0 : 2,
                results: status === "succeeded" ? 4 : 0,
                amountMinor: 0,
                durationSeconds: status === "succeeded" ? 12 : 0
              }
            },
            updatedAt: "2026-08-08T08:00:00.000Z"
          }]
        })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], nextCursor: null })
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem("gj_user", JSON.stringify({
      id: "demo-admin",
      name: "Admin",
      email: "admin@goodjob.com",
      role: "admin",
      teamId: "demo-team",
      avatar: "AD"
    }));
  });

  await page.goto("/#acquisition");
  await page.locator('[data-acquisition-mode="real"]').click();
  await expect(page.locator("#replicaRealTaskList")).toContainText("排队中");
  await expect.poll(() => overviewRequests, { timeout: 9_000 }).toBe(3);
  await expect(page.locator("#replicaRealTaskList")).toContainText("已完成");
  await expect(page.locator("#replicaRealTaskList")).toContainText("4 条公开证据");

  const terminalRequestCount = overviewRequests;
  await page.waitForTimeout(2_500);
  expect(overviewRequests).toBe(terminalRequestCount);
});

test("real acquisition header survives a private-domain round trip without hidden-panel overlap", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (value: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(value)
    });
    if (url.pathname === "/api/v1/acquisition/overview") {
      return void await json({
        generatedAt: "2026-08-08T08:00:00.000Z",
        platform: "douyin",
        totals: { tasks: 0 },
        statusCounts: {},
        discoveryMethodCounts: {},
        tasks: []
      });
    }
    if (url.pathname.startsWith("/api/customers")) {
      return void await json({ customers: [] });
    }
    await json({ message: "测试路由未配置" }, 503);
  });
  await page.addInitScript(() => {
    localStorage.setItem("gj_user", JSON.stringify({
      id: "demo-admin",
      name: "Admin",
      email: "admin@goodjob.com",
      role: "admin",
      teamId: "demo-team",
      avatar: "AD"
    }));
  });

  await page.goto("/#acquisition");
  await page.locator('button[data-acquisition-mode="real"]').click();
  await expect(page.locator("#replicaHeaderSubtitle")).toHaveText(
    "真实抖音任务 · 公开搜索 · AI 研判 · 人工审核"
  );
  await page.locator('[data-replica-view="private-domain"]').click();
  await expect(page.locator("#demoModuleMain")).toBeVisible();
  await page.locator('[data-replica-view="acquisition"]').click();

  expect(await page.locator("#demoModuleMain").evaluate((node) => node.getClientRects().length)).toBe(0);
  await expect(page.locator("#replicaHeaderSubtitle")).toHaveText(
    "真实抖音任务 · 公开搜索 · AI 研判 · 人工审核"
  );
  await expect(page.locator("#replicaNewTaskButtonLabel")).toHaveText("新建真实任务");
  await expect(page.locator("#demoModuleMain")).toBeHidden();
});

test("hidden legacy dashboard neither polls nor initialises a zero-size chart", async ({ page }) => {
  test.skip(!process.env.VITE_API_TARGET?.trim(), "requires the real-mode frontend build");
  const dashboardRequests: string[] = [];
  const chartWarnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning" && /dom width or height/i.test(message.text())) {
      chartWarnings.push(message.text());
    }
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: "demo-admin",
            name: "Admin",
            email: "admin@goodjob.com",
            role: "admin",
            teamId: "demo-team",
            avatar: "AD"
          }
        })
      });
      return;
    }
    if (url.pathname === "/api/dashboard/summary") dashboardRequests.push(url.pathname);
    await route.abort();
  });
  await page.addInitScript(() => {
    const user = {
      id: "demo-admin",
      name: "Admin",
      email: "admin@goodjob.com",
      role: "admin",
      teamId: "demo-team",
      avatar: "AD"
    };
    const summary = {
      scope: "本团队业务数据",
      scopeLabels: { business: "团队业务", todos: "本人待办" },
      updatedAt: "2026-08-08T08:00:00.000Z",
      periods: {},
      briefing: {
        title: "今日经营简报",
        description: "测试缓存",
        basis: "真实数据",
        action: "查看重点客户",
        impact: "保护成交节奏",
        riskAmount: 0,
        riskLabel: "无风险",
        closableDeals: 0,
        closableAmount: 0,
        unreadWecom: 0
      },
      metrics: {
        customers: 0,
        riskCustomers: 0,
        todos: 0,
        overdueTodos: 0,
        forecastAmount: 0,
        wecomBoundRate: 0,
        pendingKnowledge: 0,
        examPassRate: 0,
        unfinishedExams: 0,
        customerCompleteness: 0
      },
      schedule: [],
      quality: { followHealth: 0, overdueRate: 0, avgResponseHours: 0 },
      leadFunnel: {
        stages: [
          { key: "entered", label: "进入系统", count: 1, conversionRate: 100 },
          { key: "valid", label: "有效线索", count: 1, conversionRate: 100 }
        ],
        todayAdded: 1,
        filteredOut: 0,
        dealConversionRate: 0
      },
      pipelineHealth: [],
      todoInsights: {
        total: 0,
        overdue: 0,
        completionRate: 0,
        impactAmount: 0,
        typeRows: [],
        weekLoad: [],
        historyCount: 0,
        historyAmount: 0
      },
      priorityTasks: []
    };
    localStorage.setItem("gj_user", JSON.stringify(user));
    localStorage.setItem("gj_dashboard_cache", JSON.stringify({
      "demo-admin:admin:demo-team": {
        summary,
        todos: [],
        customers: [],
        cachedAt: new Date().toISOString()
      }
    }));
  });

  await page.goto("/#acquisition");
  await expect(page.locator("body")).toHaveClass(/is-authenticated/);
  await expect.poll(() => dashboardRequests.length).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(250);

  expect(chartWarnings).toEqual([]);
  expect(dashboardRequests).toHaveLength(1);
});

test("AI draft creation preserves the complete server plan through approval and run", async ({ page }) => {
  const createdPlans: unknown[] = [];
  const createdRuns: unknown[] = [];
  const draft = {
    targetPlatform: "douyin",
    name: "厦门多连接获客方案",
    objective: "发现公开采购信号",
    icp: {
      industries: ["企业服务", "装修"], regions: ["厦门"],
      organizationCriteria: ["公开询价"], individualCriteria: ["老板合作需求"], exclusionRules: ["明确拒绝联系"]
    },
    subjectChannels: { organization: true, individual: true },
    providerConnections: [
      { connectionId: "search-a", providerId: "brave", kind: "search", status: "active", credentialVersion: 1 },
      { connectionId: "search-b", providerId: "serper", kind: "search", status: "active", credentialVersion: 2 }
    ],
    operations: [
      { operationId: "a-org", subjectChannel: "organization", kind: "search", connectionId: "search-a", query: "site:douyin.com 企业服务 采购", allocatedBudget: { requests: 2, results: 10, amountMinor: 0, durationSeconds: 30 } },
      { operationId: "a-person", subjectChannel: "individual", kind: "search", connectionId: "search-a", query: "site:iesdouyin.com 老板 询价", allocatedBudget: { requests: 2, results: 10, amountMinor: 0, durationSeconds: 30 } },
      { operationId: "b-org", subjectChannel: "organization", kind: "search", connectionId: "search-b", query: "site:douyin.com 装修 寻找供应商", allocatedBudget: { requests: 2, results: 10, amountMinor: 0, durationSeconds: 30 } },
      { operationId: "b-person", subjectChannel: "individual", kind: "search", connectionId: "search-b", query: "site:iesdouyin.com 老板 合作", allocatedBudget: { requests: 2, results: 10, amountMinor: 0, durationSeconds: 30 } }
    ],
    budgetSnapshot: { billingCurrency: "CNY", maxRequests: 8, maxResults: 40, maxAmountMinor: 0, maxDurationSeconds: 120 },
    modelConnectionId: "model-a",
    stopConditions: { stopWhenBudgetExhausted: true, stopWhenNoMoreResults: true }
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = async (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/api/v1/acquisition/provider-connections") {
      return void await json({ items: draft.providerConnections.map((connection) => ({ ...connection, lastHealthStatus: "passed" })), nextCursor: null });
    }
    if (url.pathname === "/api/v1/ai/connections") {
      return void await json({ items: [{ id: "model-a", provider: "zhipu", model: "glm", status: "active", credentialVersion: 1, capabilitySnapshot: { toolCalling: true } }], nextCursor: null });
    }
    if (url.pathname === "/api/v1/acquisition/copilot/sessions" && request.method() === "POST") return void await json({ resourceId: "session-ai" }, 202);
    if (url.pathname.endsWith("/messages") && request.method() === "POST") return void await json({ id: "task-ai", status: "queued", result: null, errorCode: null }, 202);
    if (url.pathname === "/api/v1/acquisition/copilot/tasks/task-ai") return void await json({ id: "task-ai", status: "succeeded", errorCode: null, result: { summary: "完整草稿已生成", planDraft: draft } });
    if (url.pathname === "/api/v1/acquisition/plans" && request.method() === "POST") {
      createdPlans.push(request.postDataJSON());
      return void await route.fulfill({ status: 201, contentType: "application/json", headers: { etag: "\"plan-ai:1\"" }, body: JSON.stringify({ id: "plan-ai", status: "draft" }) });
    }
    if (url.pathname === "/api/v1/acquisition/plans/plan-ai/approval") return void await json({ id: "plan-ai", status: "approved" });
    if (url.pathname === "/api/v1/acquisition/plans/plan-ai/runs") {
      createdRuns.push(request.postDataJSON());
      return void await json({ id: "run-ai", status: "queued" }, 202);
    }
    return void await json({ items: [], nextCursor: null });
  });
  await page.addInitScript(() => {
    document.cookie = "gj_csrf=e2e-csrf; path=/";
    localStorage.setItem("gj_user", JSON.stringify({ id: "demo-admin", name: "Admin", email: "admin@goodjob.com", role: "admin", teamId: "demo-team", avatar: "AD" }));
  });
  await page.goto("/#acquisition");
  await page.locator('[data-acquisition-mode="real"]').click();
  await page.locator("#replicaNewTaskButton").click();
  const dialog = page.locator("#replicaRealTaskModal");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#replicaRealTaskModeAi")).toHaveAttribute("aria-pressed", "true");
  await dialog.locator("#replicaRealAiPrompt").fill("帮我找厦门的企业服务和装修抖音商机");
  await dialog.locator("#replicaRealAiGenerate").click();
  await expect(dialog.locator("#replicaRealAiDraft")).toBeVisible();
  await expect(dialog.locator("#replicaRealAiDraft")).toContainText("brave");
  await expect(dialog.locator("#replicaRealAiDraft")).toContainText("serper");
  await expect(dialog.locator("#replicaRealAiDraft")).toContainText("老板 合作");
  await dialog.locator("#replicaRealApprovalConfirmed").check();
  await dialog.locator("#replicaRealAiPrompt").fill("帮我重新生成厦门的企业服务和装修抖音商机");
  await expect(dialog.locator("#replicaRealApprovalConfirmed")).not.toBeChecked();
  await expect(dialog.locator("#replicaRealAiDraft")).toBeHidden();
  await dialog.locator("#replicaRealAiGenerate").click();
  await expect(dialog.locator("#replicaRealAiDraft")).toBeVisible();
  await dialog.locator("#replicaRealApprovalConfirmed").check();
  await dialog.locator("#replicaRealTaskSubmit").click();
  await expect(dialog.locator("#replicaRealTaskSubmitStatus")).toContainText("Run run-ai");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#replicaRealTaskSubmit")).toBeDisabled();
  await expect(dialog.locator("#replicaRealAiGenerate")).toBeDisabled();
  await expect(dialog.locator("#replicaRealAiPrompt")).toBeDisabled();
  await page.waitForTimeout(1_000);
  await expect(dialog).toBeVisible();

  await dialog.locator("#replicaRealTaskForm").evaluate((form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(50);
  expect(createdPlans).toHaveLength(1);
  expect(createdRuns).toHaveLength(1);
  expect((createdPlans[0] as { providerConnections: unknown[]; operations: unknown[]; modelSnapshotRef?: unknown }).providerConnections).toHaveLength(2);
  expect((createdPlans[0] as { providerConnections: unknown[]; operations: unknown[]; modelSnapshotRef?: unknown }).operations).toHaveLength(4);
  expect((createdPlans[0] as { modelSnapshotRef?: unknown }).modelSnapshotRef).toBeUndefined();

  await dialog.locator("#replicaRealTaskClose").click();
  await expect(dialog).toBeHidden();
  await page.locator("#replicaNewTaskButton").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#replicaRealAiPrompt")).toBeEnabled();
  await expect(dialog.locator("#replicaRealTaskSubmitStatus")).toBeHidden();
});

test("real acquisition task opens authoritative plan and AI candidate review", async ({ page }) => {
  const qualification = {
    id: "qualification-ui-1",
    candidateId: "candidate-ui-1",
    decisionVersion: "decision-ui-v1",
    decisionEngine: "model",
    grade: "A",
    score: 86,
    recommendedAction: "priority_review",
    evidence: [{ evidenceId: "evidence-ui-1", excerpt: "公开表示正在比较 AI 获客方案" }],
    positiveSignals: [{ name: "明确采购需求", score: 32 }],
    negativeSignals: [],
    reasons: ["出现明确采购需求并主动比较供应商"],
    confidence: 0.91,
    ruleVersion: "qualification-rules-v1",
    promptVersion: "qualification-prompt-v1",
    modelProvider: "zhipu",
    model: "glm-5.2",
    hardGateFailures: [],
    createdAt: "2026-08-07T08:03:00.000Z"
  };
  const financialValue = {
    id: "financial-ui-1",
    candidateId: "candidate-ui-1",
    qualificationDecisionId: qualification.id,
    version: "financial-v1",
    grade: "A",
    score: 82,
    currency: "CNY",
    expectedRevenueMinor: 6800000,
    expectedGrossProfitMinor: 3800000,
    expectedContributionMinor: 2900000,
    factors: {
      profitability: 82,
      cashFlow: 76,
      creditQuality: 88,
      repeatPotential: 78,
      referralPotential: 74,
      closeProbability: 69
    },
    createdAt: "2026-08-07T08:03:00.000Z"
  };
  const task = {
    id: "plan-ui-1",
    planId: "plan-ui-1",
    name: "抖音企业服务真实获客",
    objective: "发现正在采购 AI 获客系统的企业",
    platform: "douyin",
    discoveryMethods: ["public_search"],
    planStatus: "approved",
    latestRun: {
      id: "run-ui-1",
      status: "running",
      updatedAt: "2026-08-07T08:05:00.000Z",
      completedAt: null,
      evidenceCount: 1,
      consumedBudget: { requests: 2, results: 1, amountMinor: 120, durationSeconds: 18 }
    },
    updatedAt: "2026-08-07T08:05:00.000Z"
  };
  const plan = {
    id: "plan-ui-1",
    ownerId: "demo-admin",
    teamId: "demo-team",
    status: "approved",
    version: 1,
    revision: 2,
    etag: "\"plan-ui-1:2\"",
    currentVersionId: "plan-version-ui-1",
    approvedVersionId: "plan-version-ui-1",
    approvedSnapshotHash: "sha256:approved-ui-1",
    approvedBy: "demo-admin",
    approvedAt: "2026-08-07T08:00:00.000Z",
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 20,
      maxResults: 50,
      maxAmountMinor: 3000,
      maxDurationSeconds: 600
    },
    payload: {
      targetPlatform: "douyin",
      name: task.name,
      objective: task.objective,
      icp: {
        industries: ["企业服务"],
        regions: ["中国大陆"],
        organizationCriteria: ["公开表达采购需求"],
        individualCriteria: ["公开表达合作需求"],
        exclusionRules: ["明确拒绝联系"]
      },
      subjectChannels: { organization: true, individual: true },
      providerConnections: [{
        connectionId: "search-connection-ui-1",
        providerId: "baidu_ai_search",
        kind: "search",
        status: "active",
        credentialVersion: 1
      }],
      operations: [{
        operationId: "operation-ui-1",
        subjectChannel: "organization",
        kind: "search",
        connectionId: "search-connection-ui-1",
        query: "site:douyin.com AI 获客 采购",
        allocatedBudget: { requests: 20, results: 50, amountMinor: 3000, durationSeconds: 600 }
      }],
      budgetSnapshot: {
        billingCurrency: "CNY",
        maxRequests: 20,
        maxResults: 50,
        maxAmountMinor: 3000,
        maxDurationSeconds: 600
      },
      modelSnapshotRef: {
        jobSnapshotId: "model-job-ui-1",
        connectionId: "model-connection-ui-1",
        credentialVersion: 1,
        provider: "zhipu",
        model: "glm-5.2",
        capabilitySnapshotHash: "sha256:capability-ui-1",
        promptVersion: "qualification-prompt-v1",
        schemaVersion: "qualification.v1",
        promptHash: "sha256:prompt-ui-1",
        schemaHash: "sha256:schema-ui-1"
      },
      stopConditions: { stopWhenBudgetExhausted: true, stopWhenNoMoreResults: true }
    },
    createdBy: "demo-admin",
    createdAt: "2026-08-07T08:00:00.000Z",
    updatedBy: "demo-admin",
    updatedAt: "2026-08-07T08:05:00.000Z"
  };
  const latestRun = {
    id: "run-ui-1",
    ownerId: "demo-admin",
    teamId: "demo-team",
    planId: plan.id,
    planVersionId: "plan-version-ui-1",
    planVersion: 1,
    planSnapshotHash: "sha256:approved-ui-1",
    parentRunId: null,
    status: "running",
    terminationIntent: null,
    revision: 2,
    etag: "\"run-ui-1:2\"",
    budgetSnapshotId: "budget-ui-1",
    budgetSnapshot: plan.budgetSnapshot,
    budgetSnapshotHash: "sha256:budget-ui-1",
    billingCurrency: "CNY",
    modelSnapshotRef: plan.payload.modelSnapshotRef,
    consumedBudget: { requests: 2, results: 1, amountMinor: 120, durationSeconds: 18 },
    evidenceCount: 1,
    reason: null,
    createdBy: "demo-admin",
    createdAt: "2026-08-07T08:00:00.000Z",
    updatedBy: "demo-admin",
    updatedAt: "2026-08-07T08:05:00.000Z",
    completedAt: null
  };
  let lifecycleStatus: "running" | "paused" = "running";
  let lifecycleEtag = "\"run-ui-1:2\"";
  const pauseRequests: Array<{
    ifMatch: string | undefined;
    csrf: string | undefined;
    body: unknown;
  }> = [];
  const candidateSummary = {
    id: "candidate-ui-1",
    subjectKind: "organization",
    displayName: "厦门增长科技有限公司",
    industry: "企业服务",
    region: "福建厦门",
    domain: "growth.example.cn",
    status: "approved",
    version: 2,
    identityResolved: true,
    updatedAt: "2026-08-07T08:04:00.000Z"
  };
  const presentation = {
    run: {
      id: latestRun.id,
      status: latestRun.status,
      etag: latestRun.etag,
      updatedAt: latestRun.updatedAt,
      completedAt: latestRun.completedAt
    },
    providers: [{
      shardId: "shard-ui-1",
      connectionId: "search-connection-ui-1",
      providerId: "baidu_ai_search",
      status: "succeeded",
      rawResultCount: 2,
      acceptedResultCount: 1,
      duplicateResultCount: 0,
      failedResultCount: 0,
      errorCode: null,
      retryAfterAt: null
    }],
    summary: {
      sourcesSearched: 1,
      pagesAnalyzed: 2,
      organizationsFound: 1,
      dedupedCandidates: 1,
      validOpportunities: 1,
      highIntent: 1,
      financialEvaluatedHighIntentCount: 1,
      financialPendingHighIntentCount: 0,
      expectedRevenueByCurrency: [{ currency: "CNY", amountMinor: 6800000 }]
    },
    candidateEvents: [{
      eventId: "candidate-event-ui-1",
      createdAt: "2026-08-07T08:04:00.000Z",
      candidateId: candidateSummary.id,
      candidate: candidateSummary,
      qualification,
      financialValue,
      sourcePlatforms: ["douyin"],
      evidenceCount: 1
    }],
    nextAfter: "candidate-cursor-ui-1",
    hasMore: true
  };
  const candidate = {
    id: candidateSummary.id,
    name: candidateSummary.displayName,
    domain: candidateSummary.domain,
    region: candidateSummary.region,
    creditCode: null,
    evidenceIds: ["evidence-ui-1"],
    subjectKind: "organization",
    status: "approved",
    version: 2,
    identityResolved: true,
    latestDecisionVersion: qualification.decisionVersion,
    approvedDecisionVersion: qualification.decisionVersion,
    updatedAt: candidateSummary.updatedAt,
    createdAt: "2026-08-07T08:02:00.000Z"
  };

  const handoffRequests: Array<{
    csrf: string | undefined;
    idempotencyKey: string | undefined;
    body: unknown;
  }> = [];
  const dealRequests: Array<{
    method: string;
    body: Record<string, unknown>;
  }> = [];
  const dealRows: Array<Record<string, unknown>> = [];
  const acquisitionBindings = [{
    handoffId: "ach-ui-1",
    leadId: "lead-ui-1",
    candidateId: candidate.id,
    createdAt: "2026-08-07T08:10:00.000Z"
  }, {
    handoffId: "ach-ui-2",
    leadId: "lead-ui-2",
    candidateId: "candidate-ui-2",
    createdAt: "2026-08-07T08:11:00.000Z"
  }];
  const consumedHandoffIds = new Set<string>();
  let failNextCustomerRequest = false;
  let pendingCustomerGate: {
    started(): void;
    wait: Promise<void>;
  } | null = null;
  function holdNextCustomerRequest() {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    pendingCustomerGate = { started: markStarted, wait };
    return { started, release };
  }
  await page.route("**/api/customers*", async (route) => {
    const url = new URL(route.request().url());
    if (failNextCustomerRequest) {
      failNextCustomerRequest = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "客户权威数据暂时不可用" })
      });
      return;
    }
    const gate = url.searchParams.get("scope") === "mine"
      ? pendingCustomerGate
      : null;
    if (gate) {
      pendingCustomerGate = null;
      gate.started();
      await gate.wait;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        customers: [{
          id: "customer-ui-1",
          company: candidate.name,
          country: "中国",
          contact: "王总",
          ownerId: "demo-admin",
          teamId: "demo-team",
          ownerName: "Admin",
          stage: "待首次跟进",
          amount: 12880,
          health: 80,
          grade: "A",
          nextReminder: "2026-08-09T10:30:00.000Z",
          wecomBound: false,
          acquisitionBindings: acquisitionBindings.filter((binding) =>
            !consumedHandoffIds.has(binding.handoffId)),
          activities: [{
            id: "activity-ui-1",
            customerId: "customer-ui-1",
            type: "note",
            content: "获客候选已交接至 CRM/私域",
            operatorId: "demo-admin",
            operatorName: "Admin",
            nextReminder: "2026-08-09T10:30:00.000Z",
            createdAt: "2026-08-07T08:10:00.000Z"
          }]
        }]
      })
    });
  });
  await page.route("**/api/dashboard/summary", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "E2E 不刷新 legacy dashboard" })
    });
  });
  await page.route("**/api/deals**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const fulfill = (value: unknown) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(value)
    });
    if (url.pathname === "/api/deals/closed") {
      await fulfill({
        deals: [],
        total: 0,
        page: 1,
        pageSize: 20,
        counts: { won: 0, lost: 0, revisit: 0 }
      });
      return;
    }
    if (url.pathname === "/api/deals" && request.method() === "GET") {
      await fulfill({ deals: dealRows, events: [] });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    dealRequests.push({ method: request.method(), body });
    if (url.pathname === "/api/deals" && request.method() === "POST") {
      const acquisitionBinding = body.acquisitionBinding as {
        handoffId?: unknown;
      } | undefined;
      if (typeof acquisitionBinding?.handoffId === "string") {
        consumedHandoffIds.add(acquisitionBinding.handoffId);
      }
      const deal = {
        id: `deal-ui-${dealRows.length + 1}`,
        ...body,
        stage: "询盘",
        amountType: "estimate",
        stageChangedAt: "2026-08-08T08:00:00.000Z"
      };
      dealRows.push(deal);
      await fulfill({ deal });
      return;
    }
    await fulfill({ message: "测试路由未配置" });
  });
  await page.route("**/api/todos", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        todos: [{
          id: "todo-ui-1",
          title: "首次跟进：确认需求和预算",
          type: "customer",
          priority: "high",
          status: "pending",
          dueAt: "2026-08-09T10:30:00.000Z",
          ownerId: "demo-admin",
          teamId: "demo-team",
          related: candidate.name,
          done: false,
          customerId: "customer-ui-1",
          leadId: "lead-ui-1"
        }]
      })
    });
  });
  await page.route("**/api/v1/acquisition/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
      route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(value) });
    if (url.pathname === "/api/v1/acquisition/overview") {
      await json({
        generatedAt: "2026-08-07T08:06:00.000Z",
        platform: "douyin",
        totals: { tasks: 1 },
        statusCounts: { [lifecycleStatus]: 1 },
        discoveryMethodCounts: { public_search: 1 },
        tasks: [{
          ...task,
          latestRun: task.latestRun && {
            ...task.latestRun,
            status: lifecycleStatus,
            completedAt: lifecycleStatus === "paused" ? null : task.latestRun.completedAt
          }
        }]
      });
      return;
    }
    if (url.pathname === `/api/v1/acquisition/tasks/${plan.id}`) {
      const currentRun = {
        ...latestRun,
        status: lifecycleStatus,
        etag: lifecycleEtag,
        revision: lifecycleStatus === "paused" ? 3 : 2
      };
      await json({
        task: {
          ...task,
          latestRun: task.latestRun && {
            ...task.latestRun,
            status: lifecycleStatus,
            completedAt: null
          }
        },
        plan,
        latestRun: currentRun,
        shards: [{
          id: "shard-ui-1",
          runId: latestRun.id,
          ownerId: "demo-admin",
          teamId: "demo-team",
          operationId: "operation-ui-1",
          parentShardId: null,
          subjectChannel: "organization",
          kind: "search",
          connection: plan.payload.providerConnections[0],
          query: plan.payload.operations[0].query,
          sourceRef: "douyin-public-search",
          status: "succeeded",
          budgetSnapshotId: "budget-ui-1",
          allocatedBudget: plan.payload.operations[0].allocatedBudget,
          consumedBudget: latestRun.consumedBudget,
          modelSnapshotRef: latestRun.modelSnapshotRef,
          evidenceCount: 1,
          revision: 2,
          createdAt: latestRun.createdAt,
          updatedAt: latestRun.updatedAt,
          completedAt: latestRun.completedAt
        }],
        presentation
      });
      return;
    }
    if (url.pathname === `/api/v1/acquisition/runs/${latestRun.id}/pause`
      && route.request().method() === "POST") {
      pauseRequests.push({
        ifMatch: route.request().headers()["if-match"],
        csrf: route.request().headers()["x-csrf-token"],
        body: route.request().postDataJSON()
      });
      lifecycleStatus = "paused";
      lifecycleEtag = "\"run-ui-1:3\"";
      await json({
        ...latestRun,
        status: lifecycleStatus,
        etag: lifecycleEtag,
        revision: 3,
        updatedAt: "2026-08-07T08:07:00.000Z"
      }, 200, { ETag: lifecycleEtag });
      return;
    }
    if (url.pathname === `/api/v1/acquisition/runs/${latestRun.id}/presentation`) {
      await json({
        ...presentation,
        candidateEvents: [{
          ...presentation.candidateEvents[0],
          eventId: "candidate-event-ui-2",
          candidateId: "candidate-ui-2",
          candidate: {
            ...candidateSummary,
            id: "candidate-ui-2",
            displayName: "福州数智营销有限公司",
            status: "normalized",
            version: 1
          },
          qualification: null,
          financialValue: null
        }],
        nextAfter: "",
        hasMore: false
      });
      return;
    }
    if (url.pathname === `/api/v1/acquisition/candidates/${candidate.id}`) {
      await json(candidate, 200, { ETag: "\"candidate-v2\"" });
      return;
    }
    if (url.pathname === `/api/v1/acquisition/candidates/${candidate.id}/private-domain-handoff`) {
      await json({ message: "交接记录不存在" }, 404);
      return;
    }
    if (url.pathname === `/api/v1/acquisition/candidates/${candidate.id}/private-domain-handoffs`
      && route.request().method() === "POST") {
      handoffRequests.push({
        csrf: route.request().headers()["x-csrf-token"],
        idempotencyKey: route.request().headers()["idempotency-key"],
        body: route.request().postDataJSON()
      });
      await json({
        replayed: false,
        handoff: {
          id: "ach-ui-1",
          candidateId: candidate.id,
          leadId: "lead-ui-1",
          customerId: "customer-ui-1",
          todoId: "todo-ui-1",
          runId: latestRun.id,
          discoveredEventId: presentation.candidateEvents[0].eventId,
          decisionVersion: qualification.decisionVersion,
          createdAt: "2026-08-07T08:10:00.000Z"
        },
        lead: { id: "lead-ui-1" },
        customer: { id: "customer-ui-1", company: candidate.name },
        todo: {
          id: "todo-ui-1",
          dueAt: "2026-08-09T10:30:00.000Z",
          leadId: "lead-ui-1",
          customerId: "customer-ui-1"
        },
        intelligence: {
          qualificationGrade: "S",
          qualificationScore: 94,
          financialGrade: "A",
          currency: "CNY",
          expectedRevenueMinor: 1288000,
          expectedGrossProfitMinor: 640000,
          expectedContributionMinor: 420000
        }
      });
      return;
    }
    if (url.pathname === `/api/v1/acquisition/candidates/${candidate.id}/evidence`) {
      await json({
        items: [{
          id: "evidence-ui-1",
          targetType: "organization",
          sourcePlatform: "douyin",
          sourceTitle: "企业公开采购讨论",
          sourceSnippet: "计划采购 AI 获客系统，正在比较供应商",
          publishedAt: "2026-08-06T08:00:00.000Z",
          fetchedAt: "2026-08-07T08:02:00.000Z",
          locale: "zh-CN",
          rawArtifactHash: "sha256:raw-ui-1",
          contentHash: "sha256:content-ui-1",
          provenance: {
            kind: "search_result",
            provider: "baidu_ai_search",
            providerConnectionId: "search-connection-ui-1",
            queryText: "site:douyin.com AI 获客 采购",
            sourceUrl: "https://www.douyin.com/video/example",
            resultRank: 1
          },
          accessStatus: "public_content"
        }],
        nextCursor: null
      });
      return;
    }
    if (url.pathname.endsWith("/qualification")) return void await json(qualification);
    if (url.pathname.endsWith("/financial-value")) return void await json(financialValue);
    if (url.pathname.endsWith("/battle-card")) {
      await json({
        id: "battle-card-ui-1",
        candidateId: candidate.id,
        qualificationDecisionId: qualification.id,
        partyType: "organization",
        evidenceIds: ["evidence-ui-1"],
        confidence: 0.88,
        modelProvider: "zhipu",
        model: "glm-5.2",
        promptVersion: "battle-card-prompt-v1",
        createdAt: "2026-08-07T08:04:00.000Z",
        schemaVersion: "battle-card.v1",
        sections: [{
          label: "推荐切入点",
          kind: "inference",
          content: "先提供行业获客诊断，再讨论产品方案",
          evidenceIds: ["evidence-ui-1"],
          confidence: 0.86
        }],
        intelligence: null
      });
      return;
    }
    if (url.pathname.endsWith("/reviews")) return void await json({ items: [], nextCursor: null });
    await json({ code: "resource_not_found", message: "测试路由未配置", details: null, requestId: "e2e", retryable: false }, 404);
  });

  await page.addInitScript(() => {
    document.cookie = "gj_csrf=e2e-csrf; path=/";
    localStorage.setItem("gj_user", JSON.stringify({
      id: "demo-admin",
      name: "Admin",
      email: "admin@goodjob.com",
      role: "admin",
      teamId: "demo-team",
      avatar: "AD"
    }));
  });
  await page.goto("/#acquisition");
  await page.locator('[data-acquisition-mode="real"]').click();
  await expect(page.locator('[data-acquisition-plan-id="plan-ui-1"]')).toBeVisible();
  await expect(page.locator('[data-acquisition-plan-id="plan-ui-1"]')).toHaveClass(/active/);
  await page.locator("#replicaEditTask").click();

  const dialog = page.locator("#replicaAcquisitionDetailCenter");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("发现正在采购 AI 获客系统的企业");
  await expect(dialog.locator('[data-run-progress-metric="requests"]')).toContainText(
    "2 / 20 次请求"
  );
  await expect(
    dialog.locator('[data-run-progress-metric="requests"] [data-progress-percent]')
  ).toHaveAttribute("data-progress-percent", "10");
  await expect(dialog.locator('[data-run-progress-metric="results"]')).toContainText(
    "1 / 50 条结果"
  );
  await expect(dialog.locator('[data-run-progress-metric="duration"]')).toContainText(
    "18 / 600 秒"
  );
  await expect(dialog.locator('[data-run-progress-metric="shards"]')).toContainText(
    "1 / 1 个分片"
  );
  await expect(dialog.locator("[data-acquisition-run-live]")).toBeVisible();
  await dialog.locator('[name="runControlReason"]').fill("人工检查搜索结果");
  await dialog.locator('[data-acquisition-run-action="pause"]').click();
  await expect(dialog.locator(".replica-acquisition-run-summary")).toContainText("已暂停");
  await expect(dialog.locator("[data-acquisition-run-live]")).toHaveCount(0);
  expect(pauseRequests).toEqual([{
    ifMatch: "\"run-ui-1:2\"",
    csrf: "e2e-csrf",
    body: { reason: "人工检查搜索结果" }
  }]);
  await expect(dialog.locator('[data-acquisition-run-action="resume"]')).toBeVisible();
  await dialog.locator('[data-acquisition-detail-action="switch-mode"][data-mode="candidates"]').click();
  await expect(dialog).toContainText("厦门增长科技有限公司");
  await expect(dialog).toContainText("出现明确采购需求并主动比较供应商");
  await expect(dialog.locator(".replica-acquisition-factor-list")).toContainText("82%");
  await expect(dialog.locator(".replica-acquisition-factor-list")).not.toContainText("8200%");
  await dialog.locator('[data-acquisition-detail-action="open-private-domain-handoff"]').click();
  const handoffDialog = dialog.locator(".replica-acquisition-handoff-dialog");
  await expect(handoffDialog).toBeVisible();
  await expect(handoffDialog).toContainText(latestRun.id);
  await expect(handoffDialog).toContainText(presentation.candidateEvents[0].eventId);
  await handoffDialog.locator('[name="followUpDueAt"]').fill("2026-08-09T10:30");
  await handoffDialog.locator('button[type="submit"]').click();
  await expect(dialog.locator(".replica-acquisition-handoff-complete")).toContainText(
    "customer-ui-1"
  );
  await expect(dialog.locator(".replica-acquisition-handoff-complete")).toContainText(
    "todo-ui-1"
  );
  expect(handoffRequests).toHaveLength(1);
  expect(handoffRequests[0]?.csrf).toBe("e2e-csrf");
  expect(handoffRequests[0]?.idempotencyKey?.length).toBeGreaterThanOrEqual(8);
  expect(handoffRequests[0]?.body).toEqual({
    operationCode: "handoff_acquisition_candidate_v1",
    runId: latestRun.id,
    discoveredEventId: presentation.candidateEvents[0].eventId,
    decisionVersion: qualification.decisionVersion,
    mode: "create_new",
    existingCustomerId: "",
    followUp: {
      title: "首次跟进：确认需求和预算",
      dueAt: "2026-08-09T02:30:00.000Z",
      priority: "high"
    }
  });
  await dialog.locator('[data-acquisition-detail-action="load-more-candidates"]').click();
  await expect(dialog).toContainText("福州数智营销有限公司");
  await expect(dialog.locator('[data-acquisition-detail-action="load-more-candidates"]')).toHaveCount(0);
  await dialog.getByRole("link", { name: "查看客户", exact: true }).click();
  await dialog.locator('[data-acquisition-detail-action="close"]').first().click();
  await expect(page.locator("#demoModuleMain")).toContainText("真实客户池");
  await expect(page.locator("#demoModuleMain")).toContainText(candidate.name);
  await expect(page.locator("#demoModuleInspector")).toContainText("todo-ui-1");
  await expect(page.locator("#demoModuleInspector")).toContainText("获客候选已交接");
  await expect(page.locator("#demoModuleMain")).not.toContainText("演示模式");

  const createRealDeal = page.locator('[data-private-domain-action="create-deal"]');
  await expect(createRealDeal).toBeVisible();
  await createRealDeal.click();
  await expect(page.locator("#appModal")).toHaveClass(/active/);
  await expect(page.locator("#dealCustomerIdInput")).toHaveValue("customer-ui-1");
  await expect(page.locator("#dealAcquisitionBindingField")).toBeVisible();
  await expect(page.locator("#dealAcquisitionBindingInput")).toHaveValue("");
  await page.locator("#dealAcquisitionBindingInput").selectOption("ach-ui-1");
  await page.locator("#dealTitleInput").fill("AI 获客绑定商机");
  await page.locator("#dealProductInput").fill("GoodJob CRM");
  const firstBindingRefresh = page.waitForResponse((response) =>
    response.url().includes("/api/customers?scope=mine")
    && response.status() === 200);
  await page.locator("#saveDealButton").click();
  await firstBindingRefresh;
  await expect.poll(() => dealRequests.length).toBe(1);
  expect(dealRequests[0]).toEqual({
    method: "POST",
    body: expect.objectContaining({
      title: "AI 获客绑定商机",
      customerId: "customer-ui-1",
      acquisitionBinding: {
        handoffId: "ach-ui-1",
        leadId: "lead-ui-1"
      }
    })
  });

  await expect(createRealDeal).toBeVisible();
  await createRealDeal.click();
  await expect(page.locator("#dealAcquisitionBindingInput")).toHaveValue("ach-ui-2");
  await page.locator("#dealTitleInput").fill("AI 获客绑定商机二");
  await page.locator("#dealProductInput").fill("GoodJob CRM");
  const finalBindingRefresh = page.waitForResponse((response) =>
    response.url().includes("/api/customers?scope=mine")
    && response.status() === 200);
  await page.locator("#saveDealButton").click();
  await finalBindingRefresh;
  await expect.poll(() => dealRequests.length).toBe(2);
  await expect(createRealDeal).toHaveCount(0);

  failNextCustomerRequest = true;
  const failedAuthorityRefresh = page.waitForResponse((response) =>
    response.url().includes("/api/customers?scope=mine")
    && response.status() === 503);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent(
    "goodjob:acquisition-candidate-changed",
    {
      detail: {
        action: "private_domain_handoff_completed",
        customerId: "customer-ui-1",
        todoId: "todo-ui-1",
        leadId: "lead-ui-1",
        handoffId: "ach-ui-1"
      }
    }
  )));
  await failedAuthorityRefresh;
  const retryRefresh = page.locator(".toast.error").getByRole("button", {
    name: "重试刷新"
  });
  await expect(retryRefresh).toBeVisible();
  const successfulRetry = page.waitForResponse((response) =>
    response.url().includes("/api/customers?scope=mine")
    && response.status() === 200);
  await retryRefresh.click();
  await successfulRetry;
  await expect(retryRefresh).toHaveCount(0);

  const leaveGate = holdNextCustomerRequest();
  await page.locator('[data-private-domain-action="retry"]').click();
  await leaveGate.started;
  await page.locator('[data-replica-view="dashboard"]').click();
  const leaveResponse = page.waitForResponse(
    (response) => response.url().includes("/api/customers?scope=mine")
  );
  leaveGate.release();
  await leaveResponse;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.locator("#demoModuleMain")).toContainText(
    "让每一次客户信号，都进入下一步"
  );
  await expect(page.locator("#demoModuleMain")).not.toContainText("真实客户池");

  const demoGate = holdNextCustomerRequest();
  await page.locator('[data-replica-view="private-domain"]').click();
  await demoGate.started;
  await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".replica-shell");
    if (shell) shell.dataset.acquisitionMode = "demo";
    document.dispatchEvent(new CustomEvent(
      "goodjob:acquisition-mode-changed",
      { detail: { mode: "demo" } }
    ));
  });
  const demoResponse = page.waitForResponse(
    (response) => response.url().includes("/api/customers?scope=mine")
  );
  demoGate.release();
  await demoResponse;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.locator("#demoModuleMain")).toContainText("演示模式");
  await expect(page.locator("#demoModuleMain")).not.toContainText("真实客户池");
});
