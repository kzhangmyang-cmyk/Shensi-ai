import { expect, test, type Page, type Request, type Response } from "@playwright/test";

const FRONTEND_ORIGIN = "http://127.0.0.1:5388";
const E2E_USER = process.env.FINANCIAL_COUNCIL_E2E_USER ?? "admin@goodjob.com";
const E2E_PASSWORD = process.env.FINANCIAL_COUNCIL_E2E_PASSWORD ?? "goodjob123";
const E2E_DATA_AS_OF = process.env.FINANCIAL_COUNCIL_E2E_DATA_AS_OF
  ?? "2026-08-16T08:00";
const SENSITIVE_SENTINELS = (
  process.env.FINANCIAL_COUNCIL_E2E_SENSITIVE_SENTINELS
    ?? [
      "RAW_REPORT_SECRET_e2e_never_rendered",
      "FULL_TAX_TEXT_e2e_never_rendered",
      "MODEL_KEY_e2e",
      "CHAIN_OF_THOUGHT_e2e"
    ].join(",")
).split(",").map((value) => value.trim()).filter(Boolean);

interface ObservedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
}

interface BrowserAudit {
  readonly requests: ObservedRequest[];
  readonly apiResponses: string[];
  readonly consoleProblems: string[];
  readonly requestFailures: string[];
  settle(): Promise<void>;
}

function observeBrowser(page: Page): BrowserAudit {
  const requests: ObservedRequest[] = [];
  const apiResponses: string[] = [];
  const consoleProblems: string[] = [];
  const requestFailures: string[] = [];
  const pending = new Set<Promise<void>>();

  page.on("request", (request: Request) => {
    requests.push({
      method: request.method(),
      url: request.url(),
      body: request.postData()
    });
  });
  page.on("response", (response: Response) => {
    const pathname = new URL(response.url()).pathname;
    if (!pathname.startsWith("/api/")) return;
    if (!response.ok() && (
      pathname.startsWith("/api/v1/finance/council")
      || pathname === "/api/v1/business-advisor/diagnose"
    )) {
      requestFailures.push(`${response.status()} ${response.url()}`);
    }
    const task = response.text()
      .then((body) => {
        apiResponses.push(body);
      })
      .catch((error: unknown) => {
        requestFailures.push(`${response.status()} ${response.url()} ${String(error)}`);
      })
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
  });
  page.on("requestfailed", (request: Request) => {
    const reason = request.failure()?.errorText ?? "unknown_failure";
    if (reason !== "net::ERR_ABORTED") {
      requestFailures.push(`${request.method()} ${request.url()} ${reason}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleProblems.push(`${message.type()}: ${message.text()}`);
    }
  });

  return {
    requests,
    apiResponses,
    consoleProblems,
    requestFailures,
    async settle() {
      await Promise.all([...pending]);
    }
  };
}

function pathOf(request: ObservedRequest): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function expectClosedCouncilWrites(requests: readonly ObservedRequest[]): void {
  const writes = requests.filter((request) =>
    pathOf(request).startsWith("/api/") && request.method !== "GET");
  expect(writes.map((request) => `${request.method} ${pathOf(request)}`)).toEqual([
    "POST /api/auth/login",
    "POST /api/v1/business-advisor/diagnose",
    "POST /api/v1/finance/council-runs",
    expect.stringMatching(/^POST \/api\/v1\/finance\/council-runs\/[^/]+\/portfolio-revisions$/u),
    expect.stringMatching(/^POST \/api\/v1\/finance\/council-runs\/[^/]+\/portfolio-revisions\/2\/approve$/u)
  ]);

  const councilWrites = writes.filter((request) =>
    pathOf(request).startsWith("/api/v1/finance/council-runs"));
  expect(councilWrites).toHaveLength(3);
  expect(Object.keys(JSON.parse(councilWrites[0]!.body ?? "{}") as object).sort())
    .toEqual(["businessReport", "currency", "dataAsOf", "policyVersionId"]);
  expect(Object.keys(JSON.parse(councilWrites[1]!.body ?? "{}") as object).sort())
    .toEqual(["baseRevision", "operations"]);
  expect(JSON.parse(councilWrites[2]!.body ?? "{}") as object)
    .toEqual({ portfolioKind: "balanced" });

  const authorityMutation = writes.filter((request) =>
    /\/(?:payments?|ledger|settlements?|quotes?|invoices?|tax|contacts?|outreach)(?:\/|$)/iu
      .test(new URL(request.url).pathname));
  expect(authorityMutation).toEqual([]);
  const writeBodies = councilWrites.map((request) => request.body ?? "").join("\n");
  expect(writeBodies).not.toMatch(
    /"(?:workspaceId|actorId|capabilities|requiredCapabilities|approvedActionIds|scenarioForecast|objectiveScoreBps|snapshotHash|modelOutput|chainOfThought|toolName|createdAt|updatedAt|approvedAt)"\s*:/u
  );
}

async function expectNoSensitiveBrowserSurface(page: Page, audit: BrowserAudit): Promise<void> {
  await audit.settle();
  const storage = await page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage))
  }));
  const surfaces = [
    await page.locator("body").innerText(),
    page.url(),
    JSON.stringify(storage),
    audit.consoleProblems.join("\n"),
    audit.requests.map((request) => `${request.url}\n${request.body ?? ""}`).join("\n"),
    audit.apiResponses.join("\n")
  ].join("\n");
  for (const sentinel of SENSITIVE_SENTINELS) {
    expect(surfaces).not.toContain(sentinel);
  }
}

test("real login creates, revises, approves, and polls a financial council receipt", async ({ page }) => {
  const audit = observeBrowser(page);

  await page.goto("/#financial-council");
  await page.locator("#loginEmail").fill(E2E_USER);
  await page.locator("#loginPassword").fill(E2E_PASSWORD);
  await page.locator("#loginButton").click();
  await expect(page.locator("body")).toHaveClass(/is-authenticated/u);

  await page.evaluate(() => {
    window.location.hash = "#growth/agents";
  });
  await expect(page.getByRole("heading", { name: "AI 经营顾问团队" })).toBeVisible();
  await page.locator('[data-agents-action="generate-report"]').click();
  await expect(page.getByRole("heading", { name: "《经营诊断报告》" })).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#financial-council";
  });
  await expect(page.getByRole("heading", { name: "创建财务委员会运行" })).toBeVisible();
  await page.getByLabel("数据截至时间").fill(E2E_DATA_AS_OF);
  await page.getByRole("button", { name: "创建运行" }).click();

  await expect(page.getByText("analyzing", { exact: true })).toBeVisible();
  await expect(page.getByText("auditing", { exact: true })).toBeVisible();
  await expect(page.getByText("awaiting_approval", { exact: true })).toBeVisible();

  const balanced = page.getByRole("radio", { name: /均衡组合/u });
  await balanced.check();
  await page.getByRole("button", { name: "移除" }).first().click();
  await page.getByRole("button", { name: "提交重新优化" }).click();
  await expect(page.locator(".council-portfolio-picker")).toContainText("版本 2");

  await page.getByRole("button", { name: "批准并创建草稿/待办" }).click();
  const dispatches = page.locator('[aria-labelledby="council-dispatch-heading"]');
  await expect(dispatches).toContainText("succeeded");
  await expect(dispatches).toContainText("回执");

  const nonFrontendRequests = audit.requests.filter((request) =>
    new URL(request.url).origin !== FRONTEND_ORIGIN);
  expect(nonFrontendRequests).toEqual([]);
  expectClosedCouncilWrites(audit.requests);
  expect(audit.requestFailures).toEqual([]);
  expect(audit.consoleProblems.filter((problem) =>
    !/^error: Failed to load resource: the server responded with a status of (?:401|404|503) \(.+\)$/u
      .test(problem))).toEqual([]);
  await expectNoSensitiveBrowserSurface(page, audit);
});
