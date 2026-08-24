# Growth Integration and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以 typed mocked browser tests、真实 MySQL 后端纵向 E2E 和双仓发布门禁证明抖音获客到权威报价、财务核销、不可变 ROI 与受控 AI 建议的 F6 闭环。

**Architecture:** Q0 使用前端 pinned OpenAPI 生成类型约束所有浏览器 fixture，只验证视图、请求边界和真实/演示隔离；Q1 启动独立 `NODE_ENV=test`、`CRM_STORE=mysql` 的真实后端，通过 HTTP、真实 Worker/Reconciler 和无 Playwright route interception 的前端完成纵向闭环。R0 在后端生产者和独立前端消费者各自门禁之外，再用一个显式传入两个仓库根目录、两个提交和两个回滚点的协调门禁核对同一 contract hash 并运行完整命令集。

**Tech Stack:** Node.js 22、TypeScript 5.7、Express 4、MySQL 8、OpenAPI 3.1、Node test runner、Vite 6、Playwright 1.61、GitHub Actions、npm workspaces、pnpm。

## Global Constraints

- 后端工作树固定为 `/Users/mac/Documents/外贸/GoodJob-1.09/.worktrees/goodjob-growth-advisor-quote-roi`；独立前端固定为 `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend`。
- 本计划只在 C0、B0–B5 和 F0–F5 全部完成且其定向测试通过后执行；不得在集成测试中复制目录、报价、账本、Closure 或 Advisor 领域实现。
- Q0 fixture 必须 import `src/generated/growth-advisor-quote-roi.ts` 并以 `satisfies` 接受生成类型检查；除 Growth DTO 外，它还必须使用该生成文件中从既有 acquisition JSON Schema 复用的 `AsyncOperation`、`CopilotSession`、`CopilotMessagePagedResult` 和 `CopilotTask` aliases 覆盖实际 session-create、message-post/list、task-poll 路径。禁止手写第二套 transport DTO、`as any`/`as unknown as`、未类型化 raw response 或让任何 `/api/v1/acquisition/copilot/**` 请求逃逸到真实网络。
- Q0 可以在 named fixture helper 内使用 `page.route`；Q1 的 `growth-closed-loop.real.spec.ts` 和其 helper 禁止 `page.route`、`route.fulfill`、Service Worker mock、浏览器内 demo seed 或静态业务响应。
- Q1 必须连接 `CRM_STORE=mysql` 的隔离数据库；内存测试只能作为更快的前置行为套件，不能替代 MySQL 验收。
- Advisor 发布必须同时通过普通 `test:growth-advisor` 和专用 `test:growth-advisor:mysql`。只有后者可记为 `real_mysql`：它必须从 `MYSQL_TEST_ADMIN_URL` 创建隔离库，同时持有两条独立物理连接并证明不同 MySQL `CONNECTION_ID()`，执行用例数必须大于零。缺少 URL、数据库不可用、连接 ID 相同、任何 skip 或零用例都失败；仅在这些断言全部通过后输出稳定 marker `GROWTH_REAL_MYSQL advisor connections=2 tests=<positive>`。
- 测试控制面只在 `NODE_ENV=test`、loopback 监听地址和匹配 `X-Growth-E2E-Token` 时挂载；它只能准备用户、工作区、确定性 provider/model 输入、重置隔离库、推进队列和读取断言状态，不能直接制造 QuoteVersion、FinancialFact、ClosureVersion 或 AdvisorRecommendation。
- 确定性 provider/model 不访问公网、不发送触达、不批准报价、不核销事实、不计算权威金额；报价、ROI 和建议事实仍由 production services 产生。
- 每个真实写命令经过 HTTP，发送当前 CSRF、`Idempotency-Key` 和状态要求的 `If-Match`；测试重放相同命令并断言业务副作用仍为一次。
- 所有新业务对象和测试断言固定到准备阶段返回的具体 `workspaceId`；不得使用 `workspaceId="all"`，不得跨 workspace 读取或关联 fixture ID。
- 真实模式 bootstrap/hash/capability 失败时必须 fail closed，且不得加载 `src/growth/demo/**`；演示模式不得访问真实 growth API。
- 实际 ROI 只从已发布 `RoiClosureVersion` 返回；测试不得在浏览器重算金额、覆盖率、ROAS 或 ROI。
- 旧 `/api/v1/acquisition/performance`、旧 Pi 工具、legacy frontend 和非获客 Deal 流程继续通过既有测试；不得为了 E2E 修改其响应。
- 正式矩阵中的 `npm run test:growth-foundation --workspace backend` 必须实际执行 Foundation `growth-as-of` 套件，包括“相同 serverNow 的第二次追加前进一个 `DATETIME(3)` tick，且旧 `asOf` 只看见第一条”的契约测试。不得用 test-name filter 排除该测试，也不得以 sequence 顺序断言代替严格时间 cutoff 断言。
- Foundation 发布还必须通过独立 `test:growth-foundation:mysql`，且只有该套件可标记 Foundation `real_mysql`。它从 `MYSQL_TEST_ADMIN_URL` 创建隔离库，同时 checkout 两条独立物理连接并证明不同 `CONNECTION_ID()`，执行用例数必须大于零。缺少 URL、库不可用、连接 ID 相同、任何 skip 或零用例都失败；只有成功后可输出 `GROWTH_REAL_MYSQL foundation connections=2 tests=<positive>`。
- 浏览器验收宽度固定为 1280、1366、1440 CSS px；金额、币种、比例、数据状态、错误和异步进度必须具有可访问名称或 live-region。
- 双仓发布顺序固定为：后端 contract/backend commit → 前端 pin/generated types commit → 协调门禁；contract major/hash 不一致不得发布或回退到兼容猜测。
- 发布记录必须包含两个不可变 commit SHA、`contractVersion`、`contractHash`、UTC 验证时间、逐项命令结果和两个已在各自仓库验证的 40 位回滚 commit SHA；每个 rollback SHA 必须不同于对应发布 SHA，且是发布 SHA 的祖先。符号 ref、分支名和标签名不得进入发布记录。回滚只关闭入口/回退代码，不删除追加式账本或历史报价。
- 协调发布只接受完整 Git 历史：CI 两次 checkout 都固定 `fetch-depth: 0`，本地/CI 门禁都要求 `git rev-parse --is-shallow-repository` 为 `false` 后再验证 ancestry；浅克隆、缺失祖先或无法证明 ancestry 一律拒绝。
- 实现计划期间保留独立前端已有未提交 `pnpm-workspace.yaml`，每个实现任务只暂存 Files 中列出的文件；但正式 `release:growth` 是更严格的独立门禁，开始前后两个仓库都必须 `git status --porcelain=v1 -z --untracked-files=all` 为零字节，且结束时两个仓库的原始 HEAD bytes/status bytes 与开始快照逐字节相同。因此未提交的 `pnpm-workspace.yaml` 必须在发布前由用户提交或暂存到工作树外，发布绝不豁免任何 dirty file。
- producer artifact 路径不得硬编码 `1.0.0`：协调门禁先读取 consumer pinned manifest 的 `contractVersion`，通过严格 SemVer 校验后才读取 `contracts/releases/growth-advisor-quote-roi/<contractVersion>/manifest.json`，并验证目录名、manifest 内版本和 hash 三者一致。
- 每个任务先写会因缺失行为失败的测试，记录 RED，再写最小实现；通过定向测试、相关全量测试、构建与 `git diff --check` 后才提交。

## Locked Cross-Task Interfaces

```ts
import type { APIRequestContext, Page } from "@playwright/test";
import type { components } from "../../src/generated/growth-advisor-quote-roi";

export type GrowthSchema<Name extends keyof components["schemas"]> =
  components["schemas"][Name];

export type GrowthMockScenarioName =
  | "happy_path"
  | "workspace_selection_required"
  | "contract_mismatch"
  | "sales_redacted"
  | "quote_conflict"
  | "finance_partial_import"
  | "roi_not_computable"
  | "advisor_model_failed";

export interface GrowthRequestRecord {
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}

export type GrowthMockOperationKey = `${Uppercase<string>} /api/${string}`;

export interface GrowthMockResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: GrowthSchema<keyof components["schemas"]> | null;
}

export type GrowthAdvisorCopilotTask =
  Omit<GrowthSchema<"CopilotTask">, "responseMode" | "result"> & {
    responseMode: "assistant";
    result: GrowthSchema<"AdvisorCopilotTaskResult"> | null;
  };

export interface GrowthContractScenario {
  name: GrowthMockScenarioName;
  bootstrap: GrowthSchema<"GrowthBootstrapResponse">;
  catalogItems: GrowthSchema<"CatalogItemPagedResult">;
  pricingPolicies: readonly GrowthSchema<"PricingPolicyVersion">[];
  quoteCase: GrowthSchema<"QuoteCase">;
  quotePreview: GrowthSchema<"QuotePreviewResult">;
  quoteVersions: readonly GrowthSchema<"QuoteVersion">[];
  publication: GrowthSchema<"QuotePublicationOperation">;
  costEntries: readonly GrowthSchema<"AcquisitionCostEntry">[];
  financialFacts: readonly GrowthSchema<"FinancialFact">[];
  cohort: GrowthSchema<"AcquisitionCohort">;
  performance: GrowthSchema<"GrowthPerformanceResponse">;
  advisorToday: GrowthSchema<"AdvisorTodayResponse">;
  copilotSessionOperation: GrowthSchema<"AsyncOperation">;
  copilotSession: GrowthSchema<"CopilotSession">;
  copilotMessages: GrowthSchema<"CopilotMessagePagedResult">;
  copilotQueuedTask: GrowthAdvisorCopilotTask;
  copilotCompletedTask: GrowthAdvisorCopilotTask;
  statusOverrides: Readonly<Record<string, number>>;
  responses: Readonly<Partial<Record<GrowthMockOperationKey, GrowthMockResponse>>>;
}

export interface InstalledGrowthScenario {
  requests: readonly GrowthRequestRecord[];
  requestsFor(method: string, path: string): readonly GrowthRequestRecord[];
  dispose(): Promise<void>;
}

export function growthContractScenario(
  name: GrowthMockScenarioName
): GrowthContractScenario;

export function installGrowthContractScenario(
  page: Page,
  scenario: GrowthContractScenario
): Promise<InstalledGrowthScenario>;

export type GrowthPageName = "advisor" | "catalog" | "quotes" | "finance" | "roi";

export function enterRealGrowth(page: Page, route: GrowthPageName): Promise<void>;

export interface GrowthE2eScenarioDescriptor {
  scenarioId: string;
  workspaceId: string;
  user: { email: string; password: string };
  approver: { email: string; password: string };
  currency: "CNY";
  expected: {
    candidateDisplayName: string;
    quoteAmountMinor: number;
    verifiedCostMinor: number;
    verifiedPaymentMinor: number;
    actualContributionMinor: number;
    closureCalculationHash: `sha256:${string}`;
    controlledTodoTitle: string;
  };
}

export interface GrowthE2eState {
  draftQuoteVersionIds: readonly string[];
  formalQuoteVersions: readonly { id: string; sourceDraftVersionId: string }[];
  piIds: readonly string[];
  piSnapshots: readonly {
    id: string;
    status: string;
    revision: number;
    commercialAuthority: "legacy_unverified" | "quote_projection";
    quoteVersionId: string | null;
    commercialAmountHash: string | null;
  }[];
  quotedDealEventIds: readonly string[];
  quotedOutcomeIds: readonly string[];
  wonDealEventIds: readonly string[];
  wonOutcomeIds: readonly string[];
  financialFactAuthorities: readonly { factId: string; quoteVersionId: string; commercialAmountHash: string }[];
  dealAuthority: {
    revision: number;
    currentQuoteVersionId: string | null;
  } | null;
  closureVersionIds: readonly string[];
  recommendationIds: readonly string[];
  salesTodoIds: readonly string[];
  outboundMessageIds: readonly string[];
}

export interface GrowthE2eControlClient {
  reset(): Promise<void>;
  prepareClosedLoop(): Promise<GrowthE2eScenarioDescriptor>;
  drainWorkers(): Promise<void>;
  state(scenarioId: string): Promise<GrowthE2eState>;
}

export function createGrowthE2eControlClient(
  request: APIRequestContext,
  baseUrl: string,
  token: string
): GrowthE2eControlClient;

export interface GrowthReleaseRecord {
  backendCommit: string;
  frontendCommit: string;
  /** Exact 40-hex commit SHA resolved and verified in backendRoot. */
  backendRollbackRef: string;
  /** Exact 40-hex commit SHA resolved and verified in frontendRoot. */
  frontendRollbackRef: string;
  contractVersion: string;
  contractHash: `sha256:${string}`;
  verifiedAtUtc: string;
  commands: readonly {
    repository: "backend" | "frontend";
    command: string;
    status: "passed";
    executionMode: "standard" | "real_mysql";
    executionMarker: string | null;
  }[];
}

export interface RepositoryReleaseSnapshot {
  /** Raw stdout bytes from `git rev-parse --verify HEAD^{commit}` including its newline. */
  headBytes: Uint8Array;
  /** Raw stdout bytes from `git status --porcelain=v1 -z --untracked-files=all`; must be empty. */
  statusBytes: Uint8Array;
  commit: string;
}
```

## File Responsibility Map

- `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/fixtures/growth-contract.ts`: Q0 唯一 typed response/request router；其他 mocked E2E 不直接调用 `page.route`。
- `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/growth-*.spec.ts`: bootstrap、目录/报价、财务/ROI/Advisor 和可访问性浏览器契约测试。
- `backend/src/growth-closed-loop-http-driver.ts`: 仅通过真实 HTTP 调用 production routes 的 F6 驱动器。
- `backend/src/growth-closed-loop-behavior.ts`: 内存与 MySQL 共用的纵向断言套件。
- `backend/src/growth-e2e-control-router.ts`: 受 test/loopback/token 三重门禁的准备、推进和只读状态控制面。
- `backend/src/growth-e2e-server.ts`: 使用 MySQL production repositories、真实 routers、真实 Worker/Reconciler 与确定性 provider/model adapter 的独立进程。
- `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/playwright.real.config.ts`: 同时管理后端 4288 与前端 5389 的无拦截真实浏览器套件。
- `tools/growth-dual-repo-release-gate.mjs`: 比较 producer/consumer manifest 并无 shell 插值地执行两仓固定命令矩阵。
- `.github/workflows/growth-release.yml`: 接受必填 frontend repository/ref 和两个不可变 rollback SHA、校验 frontend origin 身份、启动 MySQL、检出双仓并保存发布记录。
- `docs/operations/growth-dual-repository-release.md`: 固定发布、验证、回滚与审计步骤。

---

### Task 1: Build the Generated-Type Mock Contract Harness

**Files:**
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/fixtures/growth-contract.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/fixtures/growth-contract.self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tsconfig.tests.json`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/package.json`

**Interfaces:**
- Consumes: generated `components["schemas"]` including the canonical acquisition `AsyncOperation`, `CopilotSession`, `CopilotMessagePagedResult`, and `CopilotTask` aliases plus generated `AdvisorCopilotTaskResult`; `GrowthAdvisorCopilotTask` only narrows the generated task's open `result` slot by intersection and does not redeclare transport fields. Also consumes pinned `GrowthContractManifest`, `GrowthContractScenario`, Playwright `Page`, exact route surface from C0 and the existing Copilot HTTP paths.
- Produces: `growthContractScenario(name)`, `installGrowthContractScenario(page, scenario)`, `enterRealGrowth(page, route)`, immutable `GrowthRequestRecord[]`, a fail-closed typed owner for all actual `/api/v1/acquisition/copilot/**` browser requests, and script `test:growth:fixture`.

- [ ] **Step 1: Write the failing fixture type/runtime self-test**

Create `tests/fixtures/growth-contract.self-test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pinnedManifest from "../../contracts/pinned/growth-advisor-quote-roi.manifest.json";
import { growthContractScenario } from "./growth-contract";

test("every named growth scenario carries the pinned bootstrap identity", () => {
  const names = [
    "happy_path",
    "workspace_selection_required",
    "contract_mismatch",
    "sales_redacted",
    "quote_conflict",
    "finance_partial_import",
    "roi_not_computable",
    "advisor_model_failed"
  ] as const;
  for (const name of names) {
    const scenario = growthContractScenario(name);
    if (name !== "contract_mismatch") {
      assert.equal(scenario.bootstrap.contractVersion, pinnedManifest.contractVersion);
      assert.equal(scenario.bootstrap.contractHash, pinnedManifest.contractHash);
    }
    assert.equal(JSON.stringify(scenario).includes('"workspaceId":"all"'), false);
  }
});

test("financial and actual ROI fixtures never promote estimates", () => {
  const scenario = growthContractScenario("happy_path");
  const actual = scenario.performance.actualRoiByCurrency.find(
    (item) => item.currency === "CNY"
  );
  assert.equal(scenario.costEntries.every((entry) => entry.status === "verified"), true);
  assert.equal(actual?.status, "computed");
  assert.equal(actual?.closureVersionId, "closure-cny-v1");

  const incomplete = growthContractScenario("roi_not_computable");
  const incompleteActual = incomplete.performance.actualRoiByCurrency.find(
    (item) => item.currency === "CNY"
  );
  assert.equal(incompleteActual?.status, "not_computable");
  assert.equal(incompleteActual?.reason, "cash_reconciliation_incomplete");
});

test("the typed fixture owns actual Copilot session, message and task traffic without escape", async () => {
  const scenario = growthContractScenario("happy_path");
  assert.equal(scenario.copilotSessionOperation.kind, "copilot_session_creation");
  assert.equal(scenario.copilotSession.id, "advisor-session-1");
  assert.equal(scenario.copilotMessages.items.every((item) => item.sessionId === "advisor-session-1"), true);
  assert.equal(scenario.copilotQueuedTask.status, "queued");
  assert.equal(scenario.copilotCompletedTask.status, "succeeded");
  for (const key of [
    "POST /api/v1/acquisition/copilot/sessions",
    "GET /api/v1/acquisition/copilot/sessions/advisor-session-1",
    "GET /api/v1/acquisition/copilot/sessions/advisor-session-1/messages",
    "POST /api/v1/acquisition/copilot/sessions/advisor-session-1/messages",
    "GET /api/v1/acquisition/copilot/tasks/advisor-task-1"
  ]) assert.ok(scenario.responses[key], key);

  const source = await readFile(new URL("./growth-contract.ts", import.meta.url), "utf8");
  assert.match(source, /\*\*\/api\/v1\/acquisition\/copilot\/\*\*/u);
  assert.doesNotMatch(source, /route\.continue\s*\(/u);
  assert.doesNotMatch(source, /\bas\s+any\b|\bas\s+unknown\s+as\b/u);
});
```

- [ ] **Step 2: Run the fixture checks and verify RED**

Run from the external frontend:

```bash
pnpm exec tsx --test tests/fixtures/growth-contract.self-test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tests/fixtures/growth-contract`.

- [ ] **Step 3: Implement typed scenarios and one recording route installer**

Start `tests/fixtures/growth-contract.ts` with generated aliases, never local duplicates:

```ts
import type { Page, Route } from "@playwright/test";
import manifest from "../../contracts/pinned/growth-advisor-quote-roi.manifest.json";
import type { components } from "../../src/generated/growth-advisor-quote-roi";

type Schema<Name extends keyof components["schemas"]> = components["schemas"][Name];

const readyBootstrap = {
  status: "ready",
  workspaceId: "workspace-e2e",
  capabilityRegistryVersion: "growth-capabilities.v1",
  capabilities: [
    "catalog.read",
    "catalog.manage",
    "pricing.sensitive.read",
    "quote.draft.create",
    "quote.confirm",
    "quote.exception.discount.approve",
    "ledger.pending.create",
    "ledger.verify",
    "roi.close",
    "growth.performance.workspace.read"
  ],
  contractVersion: manifest.contractVersion,
  contractHash: manifest.contractHash,
  features: ["catalog", "quotes", "finance", "growth_performance", "advisor"]
} satisfies Schema<"GrowthBootstrapResponse">;

const happyPerformance = {
  cohortId: "cohort-1",
  currency: "CNY",
  planId: null,
  dataAsOf: "2026-08-09T08:00:00.000Z",
  memberIds: ["cohort-member-1"],
  expectedRoiByCurrency: [{
    currency: "CNY",
    status: "computed",
    amountVisibility: "full",
    reason: null,
    probabilityWeightedGrossProfitMinor: 96000,
    attributedEstimatedCostMinor: 50000,
    roiBps: 9200,
    formulaVersion: "expected-gross-profit-roi.v1",
    quoteVersionIds: ["quote-v1"],
    probabilityAssessmentIds: ["probability-v2-1"],
    costEstimateIds: ["cost-estimate-v1"]
  }],
  actualRoiByCurrency: [{
    currency: "CNY",
    status: "computed",
    basis: "verified_gross_profit",
    amountVisibility: "full",
    closureVersionId: "closure-cny-v1",
    closureAsOf: "2026-08-09T08:00:00.000Z",
    formulaVersion: "verified-gross-profit-roi.v1",
    verifiedGrossProfitMinor: 138000,
    verifiedAcquisitionCostMinor: 50000,
    roiBps: 17600,
    costCoverageBps: 10000,
    marginCoverageBps: 10000,
    cashCoverageBps: 10000,
    attributionCoverageBps: 10000
  }],
  cashByCurrency: [{
    currency: "CNY",
    status: "complete",
    amountVisibility: "full",
    verifiedContractWonMinor: 320000,
    verifiedAcquisitionCostMinor: 50000,
    allocatedPaymentMinor: 320000,
    allocatedRefundMinor: 0,
    allocatedBadDebtMinor: 0,
    netCashMinor: 320000,
    contractRoas: { status: "computed", bps: 64000, formulaVersion: "contract-roas.v1" },
    cashMultiple: { status: "computed", bps: 64000, formulaVersion: "cash-multiple.v1" },
    collectionRate: { status: "computed", bps: 10000, formulaVersion: "collection-rate.v1" }
  }],
  coverage: {
    costCoverageBps: 10000,
    marginCoverageBps: 10000,
    cashCoverageBps: 10000,
    attributionCoverageBps: 10000,
    gapCodes: []
  },
  dataGaps: [],
  closureVersionId: "closure-cny-v1",
  formulaVersion: "verified-gross-profit-roi.v1",
  calculationHash: `sha256:${"c".repeat(64)}`,
  membershipSnapshotHash: `sha256:${"d".repeat(64)}`
} satisfies Schema<"GrowthPerformanceResponse">;
```

Define all eight scenarios as closed objects. Every `responses` entry must reference one of the scenario's generated-schema-checked fields or a separately declared `satisfies Schema<...>` command/error fixture; raw object literals typed as `unknown` are forbidden. Each scenario declares `copilotSessionOperation`, `copilotSession`, `copilotMessages`, `copilotQueuedTask`, and `copilotCompletedTask` with the generated aliases; both task objects use `satisfies GrowthAdvisorCopilotTask`, so a successful task's result must validate as `AdvisorCopilotTaskResult`. Map the five actual session/message/task method-path pairs shown in Step 1. `advisor_model_failed` keeps the same deterministic `advisorToday` facts and uses a generated `CopilotTask(status="failed", result=null, errorCode="AI_EXPLANATION_UNAVAILABLE")`; the UI maps that stable code to display reason `ai_explanation_unavailable`. `sales_redacted` omits cost/floor fields rather than filling them with null; `quote_conflict` overrides submit with 412; `finance_partial_import` returns exact row errors. Route dispatch must be a closed method/path table:

```ts
function responseFor(
  scenario: GrowthContractScenario,
  method: string,
  url: URL
): GrowthMockResponse {
  const key = `${method.toUpperCase()} ${url.pathname}` as GrowthMockOperationKey;
  const configured = scenario.responses[key];
  if (!configured) {
    return {
      status: 404,
      headers: {},
      body: {
        code: "resource_not_found",
        message: `No typed fixture for ${key}`,
        details: null,
        requestId: "growth-mock-missing",
        retryable: false
      } satisfies Schema<"ApiError">
    };
  }
  return {
    ...configured,
    status: scenario.statusOverrides[key] ?? configured.status
  };
}

export async function installGrowthContractScenario(
  page: Page,
  scenario: GrowthContractScenario
): Promise<InstalledGrowthScenario> {
  const requests: GrowthRequestRecord[] = [];
  const handler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const postData = request.postDataBuffer();
    const body = postData === null
      ? null
      : (request.headers()["content-type"] ?? "").includes("application/json")
        ? JSON.parse(postData.toString("utf8"))
        : { mediaType: request.headers()["content-type"] ?? "application/octet-stream", base64: postData.toString("base64") };
    requests.push({
      method: request.method(),
      path: `${url.pathname}${url.search}`,
      headers: request.headers(),
      body
    });
    const response = responseFor(scenario, request.method(), url);
    await route.fulfill({
      status: response.status,
      headers: { "content-type": "application/json", ...response.headers },
      body: JSON.stringify(response.body)
    });
  };
  const patterns = [
    "**/api/v1/growth/**",
    "**/api/v1/catalog/**",
    "**/api/v1/quotes/**",
    "**/api/v1/finance/**",
    "**/api/v1/acquisition/cost-entries**",
    "**/api/v1/acquisition/cost-estimates**",
    "**/api/v1/acquisition/cohorts**",
    "**/api/v1/acquisition/roi-closures**",
    "**/api/v1/acquisition/growth-performance**",
    "**/api/v1/acquisition/advisor/**",
    "**/api/v1/acquisition/copilot/**"
  ] as const;
  for (const pattern of patterns) await page.route(pattern, handler);
  return {
    requests,
    requestsFor: (method, path) => requests.filter(
      (entry) => entry.method === method && entry.path.split("?")[0] === path
    ),
    async dispose() { await page.unrouteAll({ behavior: "wait" }); }
  };
}

export async function enterRealGrowth(page: Page, route: GrowthPageName): Promise<void> {
  await page.goto(`/#growth/${route}`);
  const control = page.getByRole("button", { name: "真实模式" });
  if (await control.isVisible()) await control.click();
}
```

`responseFor` must match the fixed scenario IDs after URL decoding and ignore only the documented cursor query when selecting the typed GET-messages response. The Copilot wildcard belongs to this handler exclusively: an unknown method/path below `/api/v1/acquisition/copilot/` returns the typed `ApiError` 404 above and must never call `route.continue()`, `route.fallback()`, `fetch()`, or another mock layer. The self-test source scan and browser request assertions are the release guard against that escape hatch.

Add `tests/**/*.ts` and `playwright.config.ts` to `tsconfig.tests.json`. Merge these exact, syntactically complete script entries into the existing frontend `package.json` (preserve all unrelated keys):

```json
{
  "scripts": {
    "test:growth:fixture": "tsx --test tests/fixtures/growth-contract.self-test.ts",
    "test:types": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.tests.json --noEmit"
  }
}
```

- [ ] **Step 4: Verify fixture runtime, generated types and pinned hash**

Run:

```bash
pnpm run contract:check
pnpm run test:growth:fixture
pnpm run test:types
git diff --check
```

Expected: PASS; changing a required generated field or the pinned hash makes `test:types` or `contract:check` fail.

- [ ] **Step 5: Commit the typed fixture boundary**

```bash
git add tests/fixtures/growth-contract.ts tests/fixtures/growth-contract.self-test.ts tsconfig.tests.json package.json
git commit -m "test: add typed growth contract fixtures"
```

Do not stage `pnpm-workspace.yaml`.

---

### Task 2: Prove Bootstrap, Mode Isolation, Catalog and Quote in Mocked Browser E2E

**Files:**
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/growth-bootstrap.spec.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/growth-catalog-quote.spec.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/playwright.config.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/runtime.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/catalog/view.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/quotes/view.ts`

**Interfaces:**
- Consumes: Task 1 `growthContractScenario`, `installGrowthContractScenario`, F0 bootstrap runtime, F1 catalog view, F2 quote controller/API/view.
- Produces: stable attributes `data-growth-bootstrap-state`, `data-growth-page-state`, `data-growth-sensitive`, `data-growth-quote-state`; mocked E2E coverage for fail-closed mode, field redaction and quote request authority.

- [ ] **Step 1: Write failing bootstrap/mode and catalog/quote browser tests**

Create `tests/growth-bootstrap.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import {
  growthContractScenario,
  installGrowthContractScenario
} from "./fixtures/growth-contract";

test("real mode fails closed on contract mismatch and never restores demo data", async ({ page }) => {
  const installed = await installGrowthContractScenario(
    page,
    growthContractScenario("contract_mismatch")
  );
  await page.goto("/#growth/advisor");
  await page.getByRole("button", { name: "真实模式" }).click();
  await expect(page.locator('[data-growth-bootstrap-state="contract_mismatch"]')).toBeVisible();
  await expect(page.locator("[data-demo-metric]")).toHaveCount(0);
  expect(installed.requestsFor("GET", "/api/v1/growth/bootstrap")).toHaveLength(1);
});

test("workspace selection is required before any growth domain request", async ({ page }) => {
  const installed = await installGrowthContractScenario(
    page,
    growthContractScenario("workspace_selection_required")
  );
  await page.goto("/#growth/catalog");
  await page.getByRole("button", { name: "真实模式" }).click();
  await expect(page.getByRole("status")).toContainText("请选择具体工作区");
  expect(installed.requests.filter(
    (entry) => entry.path !== "/api/v1/growth/bootstrap"
  )).toHaveLength(0);
});
```

Create `tests/growth-catalog-quote.spec.ts` and assert the request boundary:

```ts
test("sales sees redacted catalog and quote submits only authoritative inputs", async ({ page }) => {
  const installed = await installGrowthContractScenario(page, growthContractScenario("sales_redacted"));
  await enterRealGrowth(page, "catalog");
  await expect(page.getByRole("heading", { name: "产品与报价规则" })).toBeVisible();
  await expect(page.locator('[data-growth-sensitive="cost"]')).toHaveCount(0);
  await expect(page.getByText("绝对底价")).toHaveCount(0);

  await page.goto("/#growth/quotes?candidate=candidate-1&deal=deal-1");
  await page.getByLabel("数量").fill("2.5");
  await page.getByLabel("客户目标价").fill("2900.00");
  await page.getByRole("button", { name: "试算报价" }).click();
  await page.getByRole("button", { name: "保存报价版本" }).click();
  const preview = installed.requestsFor("POST", "/api/v1/quotes/cases/case-1/preview").at(-1)!;
  expect(preview.headers["idempotency-key"]).toBeTruthy();
  expect(preview.headers["if-match"]).toBe('"quote-case-4"');
  expect(JSON.stringify(preview.body)).not.toMatch(
    /standardAmountMinor|minimumMarginPriceMinor|grossProfitMinor|contributionMinor|expectedRoiBps/u
  );
});
```

Also cover package/policy version history, active/retired immutability, missing/stale policy warning, candidate/deal context preservation, approval capability projection, self-approval absence, 412 conflict refresh, publication pending/failed/retry, and acquisition-bound Deal never calling legacy PI/quote paths.

- [ ] **Step 2: Run mocked browser tests and verify RED**

Run:

```bash
pnpm exec playwright test tests/growth-bootstrap.spec.ts tests/growth-catalog-quote.spec.ts
```

Expected: FAIL because the new specs are not in `playwright.config.ts` and the stable growth state attributes are absent.

- [ ] **Step 3: Register specs and expose state without adding test-only business branches**

Add both filenames to `testMatch`. Render controller state directly on the existing page roots:

```ts
export function renderGrowthBootstrapState(state: GrowthBootstrapState): string {
  const code = state.kind === "blocked" ? state.reason : state.kind;
  return `<section data-growth-bootstrap-state="${escapeAttribute(code)}" aria-live="polite">${renderStateBody(state)}</section>`;
}

export function renderQuoteWorkbench(state: QuoteWorkbenchState): string {
  return `<section data-growth-page="quote" data-growth-quote-state="${state.kind}">${renderQuoteBody(state)}</section>`;
}
```

Catalog view adds `data-growth-sensitive="cost"` only to rows actually present in the authorized server projection. Do not inspect role names or synthesize missing sensitive values. Quote view adds state attributes but controller continues using current ETag/idempotency/CSRF logic from F2.

- [ ] **Step 4: Verify Q0 bootstrap, catalog and quote coverage**

Run:

```bash
pnpm run contract:check
pnpm run test:types
pnpm exec playwright test tests/growth-bootstrap.spec.ts tests/growth-catalog-quote.spec.ts
pnpm test
pnpm build
git diff --check
```

Expected: PASS; real errors show no demo values, sales sees no cost/floor fields, computed quote values never occur in a request body, and stale quote commands surface a refreshable conflict.

- [ ] **Step 5: Commit Q0 bootstrap, catalog and quote E2E**

```bash
git add tests/growth-bootstrap.spec.ts tests/growth-catalog-quote.spec.ts playwright.config.ts src/growth/runtime.ts src/growth/catalog/view.ts src/growth/quotes/view.ts
git commit -m "test: cover growth bootstrap catalog and quote"
```

Do not stage `pnpm-workspace.yaml`.

---

### Task 3: Prove Finance, ROI, Advisor, Accessibility and Responsive Layout in Mocked Browser E2E

**Files:**
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/growth-finance-roi.spec.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/growth-advisor.spec.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/growth-accessibility-responsive.spec.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/fixtures/build-finance-import-fixture.mjs`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/fixtures/finance-import-partial.xlsx`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/playwright.config.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/finance/view.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/roi/view.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/advisor/view.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/runtime.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/styles.css`

**Interfaces:**
- Consumes: Task 1 typed scenarios, F3 finance/import state machine, F4 immutable closure presenter, F5 deterministic Advisor facts and controlled actions.
- Produces: `buildFinanceImportFixture(): Buffer`; stable labelled regions `growth-finance-status`, `growth-expected-roi`, `growth-actual-roi`, `growth-advisor-facts`, `growth-advisor-explanation`; Q0 coverage at 1280/1366/1440.

- [ ] **Step 1: Write failing finance/ROI/advisor and accessibility tests**

Create the committed workbook deterministically with `tests/fixtures/build-finance-import-fixture.mjs`:

```js
import { writeFileSync } from "node:fs";
import path from "node:path";
import { open, readFile, rename } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as XLSX from "xlsx";

export function buildFinanceImportFixture() {
  const rows = [
    ["sourceStableKey", "factType", "amountMinor", "currency", "businessOccurredAt", "evidenceRef"],
    ["bank:receipt:20260809-001", "payment_received", 320000, "CNY", "2026-08-09T01:00:00.000Z", "bank-slip-001"],
    ["bank:receipt:20260809-002", "payment_received", "INVALID", "CNY", "2026-08-09T01:05:00.000Z", "bank-slip-002"]
  ];
  const workbook = XLSX.utils.book_new();
  workbook.Props = {
    Author: "GoodJob",
    CreatedDate: new Date("2026-08-09T00:00:00.000Z"),
    ModifiedDate: new Date("2026-08-09T00:00:00.000Z")
  };
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "financial_facts");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
}

function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === metaUrl;
}

if (isMain(import.meta.url)) {
  writeFileSync(new URL("./finance-import-partial.xlsx", import.meta.url), buildFinanceImportFixture());
}
```

Run `node tests/fixtures/build-finance-import-fixture.mjs` once and commit both generator and generated workbook. Running it twice must preserve identical bytes.

In `tests/growth-finance-roi.spec.ts`, verify append-only and closure boundaries:

```ts
test("partial import, correction and incomplete ROI remain explicit", async ({ page }) => {
  const installed = await installGrowthContractScenario(
    page,
    growthContractScenario("finance_partial_import")
  );
  await enterRealGrowth(page, "finance");
  await page.setInputFiles("input[type=file]", "tests/fixtures/finance-import-partial.xlsx");
  await page.getByRole("button", { name: "预览导入" }).click();
  await expect(page.getByRole("status", { name: "导入状态" })).toContainText("部分成功");
  await expect(page.getByRole("table", { name: "逐行结果" })).toContainText("第 3 行");

  await page.goto("/#growth/roi?cohort=cohort-1&currency=CNY");
  await expect(page.getByRole("region", { name: "预计经营结果" })).toBeVisible();
  await expect(page.getByRole("region", { name: "已核销经营结果" })).toContainText("现金核对未完成");
  await expect(page.getByText(/实际 ROI[：:]\s*[-+]?\d/u)).toHaveCount(0);
  expect(installed.requests.some((entry) => entry.path === "/api/v1/acquisition/performance")).toBe(false);
});
```

In `tests/growth-advisor.spec.ts`, assert deterministic facts survive model failure and no forbidden mutation occurs:

```ts
test("AI failure preserves facts and exposes only controlled actions", async ({ page }) => {
  const installed = await installGrowthContractScenario(
    page,
    growthContractScenario("advisor_model_failed")
  );
  await enterRealGrowth(page, "advisor");
  await expect(page.getByRole("region", { name: "今日经营事实" })).toContainText("待审批报价");
  await page.getByLabel("向增长参谋提问").fill("今天先做什么？");
  await page.getByRole("button", { name: "提交问题" }).click();
  await expect(page.getByRole("region", { name: "AI 解释" })).toContainText("AI 解读暂不可用");
  await expect(page.getByRole("region", { name: "今日经营事实" })).toContainText("实际 ROI");
  expect(installed.requests.some((entry) => /approve|verify|publish|send/u.test(entry.path))).toBe(false);
});
```

In `tests/growth-accessibility-responsive.spec.ts`, loop exact widths:

```ts
for (const width of [1280, 1366, 1440] as const) {
  test(`growth workspaces fit ${width}px with named financial states`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installGrowthContractScenario(page, growthContractScenario("happy_path"));
    for (const route of ["advisor", "catalog", "quotes", "finance", "roi"] as const) {
      await enterRealGrowth(page, route);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(1);
      await expect(page.locator("main")).toHaveAttribute("aria-busy", /true|false/u);
      await expect(page.locator("[data-money-minor]").first()).toHaveAttribute("aria-label", /CNY|人民币/u);
      await expect(page.locator("[data-bps]").first()).toHaveAttribute("aria-label", /百分比|基点/u);
    }
  });
}
```

The test references that exact committed workbook and never constructs workbook bytes in browser code.

- [ ] **Step 2: Run Q0 remainder and verify RED**

Run:

```bash
pnpm exec playwright test tests/growth-finance-roi.spec.ts tests/growth-advisor.spec.ts tests/growth-accessibility-responsive.spec.ts
```

Expected: FAIL because specs are not registered and labelled state regions/format metadata are absent.

- [ ] **Step 3: Add semantic state metadata and exact responsive containment**

Register all three specs. Keep view logic pure and add semantic format helpers:

```ts
export function moneyMarkup(valueMinor: number, currency: string, exponent: number): string {
  const text = formatMinorUnits(valueMinor, currency, exponent);
  return `<span data-money-minor="${valueMinor}" aria-label="${escapeAttribute(`${currency} ${text}`)}">${escapeHtml(text)}</span>`;
}

export function bpsMarkup(valueBps: number): string {
  const text = formatBps(valueBps);
  return `<span data-bps="${valueBps}" aria-label="百分比 ${escapeAttribute(text)}">${escapeHtml(text)}</span>`;
}
```

Finance, ROI and Advisor roots use named `<section role="region" aria-label="...">`; async errors/status use `role="status" aria-live="polite"`. `runtime.ts` sets the existing `<main>` `aria-busy` to `true` before a controller load and to `false` on ready/empty/forbidden/error and abort. Apply this containment without introducing viewport-specific business markup:

```css
.growth-workspace {
  container-type: inline-size;
  min-width: 0;
  overflow-wrap: anywhere;
}

.growth-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr));
  min-width: 0;
}

.growth-table-scroll {
  max-width: 100%;
  overflow-x: auto;
}
```

- [ ] **Step 4: Verify complete Q0 and production frontend**

Run:

```bash
pnpm run contract:check
pnpm run test:growth:fixture
pnpm run test:types
pnpm exec playwright test tests/growth-bootstrap.spec.ts tests/growth-catalog-quote.spec.ts tests/growth-finance-roi.spec.ts tests/growth-advisor.spec.ts tests/growth-accessibility-responsive.spec.ts
pnpm test
pnpm build
git diff --check
```

Expected: PASS at all three widths; verified and estimated finance states remain distinct, actual ROI never appears without Closure identity, AI failure preserves deterministic facts, and keyboard-visible controls have accessible names.

- [ ] **Step 5: Commit Q0 finance, ROI, Advisor and layout coverage**

```bash
git add tests/growth-finance-roi.spec.ts tests/growth-advisor.spec.ts tests/growth-accessibility-responsive.spec.ts tests/fixtures/build-finance-import-fixture.mjs tests/fixtures/finance-import-partial.xlsx playwright.config.ts src/growth/finance/view.ts src/growth/roi/view.ts src/growth/advisor/view.ts src/growth/runtime.ts src/growth/styles.css
git commit -m "test: cover growth finance roi and advisor"
```

Do not stage `pnpm-workspace.yaml`.

---

### Task 4: Run One Shared Closed-Loop HTTP Behavior Suite Against Production Composition

**Files:**
- Create: `backend/src/growth-closed-loop-http-driver.ts`
- Create: `backend/src/growth-closed-loop-behavior.ts`
- Create: `backend/src/growth-e2e-contract.ts`
- Create: `backend/src/growth-closed-loop-memory-fixture.ts`
- Create: `backend/src/growth-closed-loop-memory-test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes: the single `createGrowthCommercialApplication(options)` composition, existing authenticated acquisition candidate/Deal fixtures, production growth routers, Quote Publication Worker, CRM Outcome Reconciler, Growth Advisor Copilot/tool ports.
- Produces: `GrowthClosedLoopHttpDriver`, `GrowthClosedLoopHarness`, `GrowthClosedLoopHarnessFactory`, `exerciseGrowthClosedLoop(factory)`, script `test:growth:closed-loop`.

Lock the test-facing interfaces in `growth-closed-loop-behavior.ts`:

```ts
import type { GrowthE2eState } from "./growth-e2e-contract.js";
import type { GrowthPerformanceDto } from "./acquisition-growth-performance-query.js";

export interface GrowthClosedLoopHttpDriver {
  createAndBindQuoteCase(input: { candidateId: string; customerId: string; dealId: string }): Promise<{ id: string; etag: string }>;
  previewAndCreateVersion(caseId: string): Promise<{ id: string; etag: string; quotedAmountMinor: number }>;
  submitVersion(versionId: string, etag: string, idempotencyKey: string): Promise<{ id: string; etag: string }>;
  approveVersion(versionId: string, etag: string, idempotencyKey: string): Promise<void>;
  decideDealWon(dealId: string, quoteVersionId: string): Promise<void>;
  createAndVerifyCost(input: { cohortId: string; amountMinor: number; currency: "CNY" }): Promise<string>;
  createAndVerifyFinancialFacts(input: { dealId: string; paymentMinor: number; cogsMinor: number; currency: "CNY" }): Promise<readonly string[]>;
  allocateAndClose(input: { cohortId: string; dealId: string; asOf: string; currency: "CNY" }): Promise<{ closureVersionId: string; calculationHash: `sha256:${string}` }>;
  getPerformance(input: { cohortId: string; currency: "CNY"; asOf: string; closureVersionId?: string }): Promise<GrowthPerformanceDto>;
  askAdvisorAndCreateTodo(input: { cohortId: string; currency: "CNY" }): Promise<{ recommendationId: string; todoId: string }>;
  probeAuthorityBypasses(dealId: string, draftVersionId: string): Promise<{
    legacyDealCommercialPatch: number;
    legacyDealStagePatch: number;
    legacyDealQuoteEventCreate: number;
    legacyDealLost: number;
    legacyPiCreate: number;
    legacyPiCommercialPatch: number;
    legacyPiRevision: number;
    legacyPiSubmitApproval: number;
    legacyPiApprove: number;
    legacyPiSend: number;
    legacyPiExport: number;
    publicQuotedOutcomeCreate: number;
    tamperedDealDecision: number;
    draftVersionApprove: number;
    draftVersionWon: number;
  }>;
}

export interface GrowthClosedLoopHarness {
  workspaceId: string;
  seedCandidateDealAndCohort(): Promise<{ candidateId: string; customerId: string; dealId: string; cohortId: string }>;
  driver: GrowthClosedLoopHttpDriver;
  injectOnce(point: "after_pi_before_deal_event" | "after_deal_event_before_publication_ack" | "after_outcome_before_checkpoint"): void;
  drainWorkers(): Promise<void>;
  state(): Promise<GrowthE2eState>;
  close(): Promise<void>;
}

export type GrowthClosedLoopHarnessFactory = () => Promise<GrowthClosedLoopHarness>;
export function exerciseGrowthClosedLoop(factory: GrowthClosedLoopHarnessFactory): Promise<void>;
export function exerciseGrowthRecoveryBoundaries(factory: GrowthClosedLoopHarnessFactory): Promise<void>;
```

- [ ] **Step 1: Write the failing shared F6 behavior and memory harness test**

Create `growth-closed-loop-memory-test.ts`:

```ts
import test from "node:test";
import {
  exerciseGrowthClosedLoop,
  exerciseGrowthRecoveryBoundaries
} from "./growth-closed-loop-behavior.js";
import { createMemoryGrowthClosedLoopHarness } from "./growth-closed-loop-memory-fixture.js";

test("memory composition satisfies the authoritative growth closed loop", async () => {
  await exerciseGrowthClosedLoop(createMemoryGrowthClosedLoopHarness);
});

test("memory composition recovers each cross-module delivery boundary", async () => {
  await exerciseGrowthRecoveryBoundaries(createMemoryGrowthClosedLoopHarness);
});
```

The shared behavior must contain the actual authority assertions:

```ts
export async function exerciseGrowthClosedLoop(factory: GrowthClosedLoopHarnessFactory) {
  const harness = await factory();
  try {
    const seeded = await harness.seedCandidateDealAndCohort();
    const quoteCase = await harness.driver.createAndBindQuoteCase(seeded);
    const version = await harness.driver.previewAndCreateVersion(quoteCase.id);
    assert.equal(version.quotedAmountMinor, 320000);

    const submitted = await harness.driver.submitVersion(
      version.id,
      version.etag,
      "closed-loop:submit:1"
    );
    const replayed = await harness.driver.submitVersion(
      version.id,
      version.etag,
      "closed-loop:submit:1"
    );
    assert.deepEqual(replayed, submitted);
    assert.notEqual(submitted.id, version.id);
    await harness.driver.approveVersion(
      submitted.id,
      submitted.etag,
      "closed-loop:approve:1"
    );
    await harness.drainWorkers();

    const published = await harness.state();
    assert.deepEqual(published.draftQuoteVersionIds, [version.id]);
    assert.deepEqual(published.formalQuoteVersions, [{
      id: submitted.id, sourceDraftVersionId: version.id
    }]);
    assert.equal(published.piIds.length, 1);
    assert.equal(published.quotedDealEventIds.length, 1);
    assert.equal(published.quotedOutcomeIds.length, 1);
    const bypasses = await harness.driver.probeAuthorityBypasses(seeded.dealId, version.id);
    assert.equal(Object.values(bypasses).every((status) => status >= 400), true);
    const afterBypasses = await harness.state();
    assert.deepEqual(afterBypasses.draftQuoteVersionIds, published.draftQuoteVersionIds);
    assert.deepEqual(afterBypasses.formalQuoteVersions, published.formalQuoteVersions);
    assert.deepEqual(afterBypasses.piIds, published.piIds);
    assert.deepEqual(afterBypasses.piSnapshots, published.piSnapshots);
    assert.deepEqual(afterBypasses.quotedDealEventIds, published.quotedDealEventIds);
    assert.deepEqual(afterBypasses.quotedOutcomeIds, published.quotedOutcomeIds);
    assert.deepEqual(afterBypasses.dealAuthority, published.dealAuthority);

    await harness.driver.decideDealWon(seeded.dealId, submitted.id);
    await harness.drainWorkers();
    const won = await harness.state();
    assert.equal(won.wonDealEventIds.length, 1);
    assert.equal(won.wonOutcomeIds.length, 1);
    assert.equal(won.dealAuthority?.revision, (published.dealAuthority?.revision ?? 0) + 1);
    assert.equal(won.dealAuthority?.currentQuoteVersionId, null);
    await harness.driver.createAndVerifyCost({
      cohortId: seeded.cohortId,
      amountMinor: 50000,
      currency: "CNY"
    });
    await harness.driver.createAndVerifyFinancialFacts({
      dealId: seeded.dealId,
      paymentMinor: 320000,
      cogsMinor: 182000,
      currency: "CNY"
    });
    const afterFacts = await harness.state();
    assert.equal(afterFacts.financialFactAuthorities.length > 0, true);
    assert.equal(afterFacts.financialFactAuthorities.every(
      (fact) => fact.quoteVersionId === submitted.id && fact.commercialAmountHash.length > 0
    ), true);

    const beforeClosure = await harness.driver.getPerformance({
      cohortId: seeded.cohortId,
      currency: "CNY",
      asOf: "2026-08-09T08:00:00.000Z"
    });
    const beforeActual = beforeClosure.actualRoiByCurrency.find(
      (item) => item.currency === "CNY"
    );
    assert.equal(beforeActual?.status, "not_computable");
    assert.equal(beforeActual?.reason, "cohort_not_closed");

    const closure = await harness.driver.allocateAndClose({
      cohortId: seeded.cohortId,
      dealId: seeded.dealId,
      currency: "CNY",
      asOf: "2026-08-09T08:00:00.000Z"
    });
    const closed = await harness.driver.getPerformance({
      cohortId: seeded.cohortId,
      currency: "CNY",
      asOf: "2026-08-09T08:00:00.000Z",
      closureVersionId: closure.closureVersionId
    });
    const closedActual = closed.actualRoiByCurrency.find(
      (item) => item.currency === "CNY"
    );
    assert.equal(closedActual?.status, "computed");
    assert.equal(closed.calculationHash, closure.calculationHash);

    const action = await harness.driver.askAdvisorAndCreateTodo({
      cohortId: seeded.cohortId,
      currency: "CNY"
    });
    const finalState = await harness.state();
    assert.equal(finalState.recommendationIds.includes(action.recommendationId), true);
    assert.equal(finalState.salesTodoIds.includes(action.todoId), true);
    assert.equal(finalState.outboundMessageIds.length, 0);
  } finally {
    await harness.close();
  }
}

export async function exerciseGrowthRecoveryBoundaries(
  factory: GrowthClosedLoopHarnessFactory
) {
  for (const point of [
    "after_pi_before_deal_event",
    "after_deal_event_before_publication_ack",
    "after_outcome_before_checkpoint"
  ] as const) {
    const harness = await factory();
    try {
      const seeded = await harness.seedCandidateDealAndCohort();
      const quoteCase = await harness.driver.createAndBindQuoteCase(seeded);
      const version = await harness.driver.previewAndCreateVersion(quoteCase.id);
      const submitted = await harness.driver.submitVersion(
        version.id,
        version.etag,
        `recovery:${point}:submit`
      );
      await harness.driver.approveVersion(
        submitted.id,
        submitted.etag,
        `recovery:${point}:approve`
      );
      harness.injectOnce(point);
      await assert.rejects(() => harness.drainWorkers(), /injected_growth_failure/u);
      await harness.drainWorkers();
      await harness.drainWorkers();
      const state = await harness.state();
      assert.equal(state.piIds.length, 1, point);
      assert.equal(state.quotedDealEventIds.length, 1, point);
      assert.equal(state.quotedOutcomeIds.length, 1, point);
    } finally {
      await harness.close();
    }
  }

  const late = await factory();
  try {
    const seeded = await late.seedCandidateDealAndCohort();
    const quoteCase = await late.driver.createAndBindQuoteCase(seeded);
    const version = await late.driver.previewAndCreateVersion(quoteCase.id);
    const submitted = await late.driver.submitVersion(
      version.id,
      version.etag,
      "late-worker:submit"
    );
    await late.driver.approveVersion(submitted.id, submitted.etag, "late-worker:approve");
    await late.driver.decideDealWon(seeded.dealId, submitted.id);
    await late.drainWorkers();
    const state = await late.state();
    assert.equal(state.piIds.length, 0);
    assert.equal(state.quotedDealEventIds.length, 0);
    assert.equal(state.quotedOutcomeIds.length, 0);
    assert.equal(state.wonDealEventIds.length, 1);
    assert.equal(state.wonOutcomeIds.length, 1);
  } finally {
    await late.close();
  }
}
```

- [ ] **Step 2: Run the shared behavior and verify RED**

Run:

```bash
cd backend
node --import tsx --test --test-concurrency=1 src/growth-closed-loop-memory-test.ts
```

Expected: FAIL with module-not-found for `growth-closed-loop-behavior.js` or `growth-closed-loop-memory-fixture.js`.

- [ ] **Step 3: Implement the HTTP driver and compose the memory harness once**

The driver must use an ephemeral real HTTP listener and reject non-2xx responses with the closed API envelope:

```ts
export function createGrowthClosedLoopHttpDriver(options: {
  baseUrl: string;
  authHeaders(): Record<string, string>;
  csrfToken(): string;
}): GrowthClosedLoopHttpDriver {
  async function command<T>(path: string, input: {
    body: unknown;
    idempotencyKey: string;
    etag?: string;
  }): Promise<{ body: T; etag: string }> {
    const response = await fetch(`${options.baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...options.authHeaders(),
        "content-type": "application/json",
        "x-csrf-token": options.csrfToken(),
        "idempotency-key": input.idempotencyKey,
        ...(input.etag ? { "if-match": input.etag } : {})
      },
      body: JSON.stringify(input.body)
    });
    const body = await response.json();
    if (!response.ok) throw new GrowthHttpTestError(response.status, body);
    return { body: body as T, etag: response.headers.get("etag") ?? "" };
  }
  return buildClosedLoopDriver(command, options);
}
```

`growth-e2e-contract.ts` exports the exact `GrowthE2eScenarioDescriptor` and `GrowthE2eState` structures locked above for memory/MySQL/control tests. Import `GrowthPerformanceDto` from the B4 production query module, not from frontend-generated types. `buildClosedLoopDriver` maps every interface method to the exact C0 endpoint. `previewAndCreateVersion` posts only catalog/policy IDs, `quantityMicros`, offered/target price and structured payment/pricing context; it passes the returned preview identity/hash into version creation and never copies computed money into the create request. `submitVersion` returns the distinct formal submitted version ID and ETag; approve/Deal won use only that ID. `createAndVerifyFinancialFacts` sends no quote version/hash/authority fields—the server derives them from the won Deal decision—and the driver asserts the returned/state-frozen authority equals the formal version. `allocateAndClose` creates and activates attribution and cash settlement sets, posts all required source-report/membership attestations, then closes the exact cohort/currency/asOf series. `askAdvisorAndCreateTodo` uses the existing Copilot session/message/task APIs, accepts the recommendation through `POST /api/v1/acquisition/advisor/recommendations/:id/accept`, invokes the Advisor-owned `record_recommendation_outcome` tool with the closed input `{ recommendationId, recommendationRevision }`, and completes through `POST /api/v1/acquisition/advisor/recommendations/:id/complete` with only `{ reason:null }`. The server resolves and validates the persisted exact action receipt; the driver never submits a receipt/outcome ID. There is no browser-visible action endpoint, and the driver never calls approve, verify, publish or outbound routes. `injectOnce` is wired only to the existing production worker/reconciler failure ports; it never changes repository rows itself.

`probeAuthorityBypasses` sends authenticated real HTTP commands against the already acquisition-bound Deal: `PATCH /api/deals/:id` with altered product/quantity/unit price, `PATCH /api/deals/:id/stage` toward 已报价/成交, `POST /api/deals/:id/events` with `type:"quote"`, `POST /api/deals/:id/lost`, `POST /api/trade-documents` with `type:"PI"` and arbitrary items, and public `POST /api/v1/acquisition/outcomes` with `outcome:"quoted"`. It also attempts approval and Deal-won decision with the immutable draft ID; both must fail, proving submit did not mutate the draft in place. The fixture contains one historical `legacy_unverified` PI bound to that Deal; the probe calls `PATCH /api/trade-documents/:id`, `POST /api/trade-documents/:id/revision`, `POST /api/trade-documents/:id/submit-approval`, `POST /api/trade-documents/:id/approve`, `POST /api/trade-documents/:id/send`, and `POST /api/trade-documents/:id/export` against it. Its final probe calls `POST /api/v1/quotes/deals/:dealId/decision` with the formal current version ID but a forged `commercialAmountHash`. It returns each response status without treating the expected rejection as a driver exception; every status is asserted `>= 400`, and the following `state()` assertion compares the full `piSnapshots` (status, revision, authority, quote version and commercial hash), distinct draft/formal QuoteVersions, DealEvent/Outcome and Deal authority to prove none changed.

`createMemoryGrowthClosedLoopHarness` calls the sole production `createGrowthCommercialComposition`/application bootstrap with in-memory infrastructure ports, a fixed clock, deterministic provider/model ports and a concrete workspace/capability resolver. It never constructs Catalog, Quote, Finance, ROI or Advisor business services beside that composition root. It retains the production Worker/Reconciler handles for `drainWorkers()` and closes listener plus the single composed runtime, whose module close stack drains acquisition and Growth resources exactly once in reverse startup order.

Merge this syntactically complete JSON object into `backend/package.json` without changing unrelated scripts:

```json
{
  "scripts": {
    "test:growth:closed-loop": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/growth-closed-loop-memory-test.ts"
  }
}
```

- [ ] **Step 4: Verify memory F6 plus relevant backend gates**

Run:

```bash
npm run test:growth:closed-loop --workspace backend
npm run test:growth-openapi --workspace backend
npm run test:acquisition --workspace backend
npm run build --workspace backend
git diff --check
```

Expected: PASS; one authority produces one QuoteVersion/PI/DealEvent/Outcome, pre-closure actual ROI is not computable, the exact Closure hash is returned after close, and Advisor creates one Todo with zero outbound messages.

- [ ] **Step 5: Commit the reusable F6 behavior suite**

```bash
git add backend/src/growth-closed-loop-http-driver.ts backend/src/growth-closed-loop-behavior.ts backend/src/growth-e2e-contract.ts backend/src/growth-closed-loop-memory-fixture.ts backend/src/growth-closed-loop-memory-test.ts backend/package.json
git commit -m "test(growth): add closed loop HTTP behavior"
```

---

### Task 5: Run the Shared Behavior on MySQL and Add the Guarded Real-E2E Server

**Files:**
- Create: `backend/src/growth-closed-loop-mysql-fixture.ts`
- Create: `backend/src/growth-closed-loop-mysql-test.ts`
- Create: `backend/src/growth-e2e-control-router.ts`
- Create: `backend/src/growth-e2e-control-router-test.ts`
- Create: `backend/src/growth-e2e-server.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes: Task 4 behavior/driver, production MySQL repositories and schema migration, `MYSQL_TEST_ADMIN_URL`, single Growth application composition, production workers/reconciler.
- Produces: `createMysqlGrowthClosedLoopHarness()`, `assertGrowthE2eEnvironment(env)`, `createGrowthE2eControlRouter(options)`, `startGrowthE2eServer(options): Promise<{ close(): Promise<void> }>`, guarded `main(): Promise<void>`, scripts `test:growth:closed-loop:mysql` and `e2e:growth:server`.

- [ ] **Step 1: Write failing MySQL parity and control-plane guard tests**

Create `growth-closed-loop-mysql-test.ts`:

```ts
import test from "node:test";
import {
  exerciseGrowthClosedLoop,
  exerciseGrowthRecoveryBoundaries
} from "./growth-closed-loop-behavior.js";
import { createMysqlGrowthClosedLoopHarness } from "./growth-closed-loop-mysql-fixture.js";

test("MySQL production repositories satisfy the same closed loop", async () => {
  await exerciseGrowthClosedLoop(createMysqlGrowthClosedLoopHarness);
});

test("MySQL workers recover each delivery boundary without duplicates", async () => {
  await exerciseGrowthRecoveryBoundaries(createMysqlGrowthClosedLoopHarness);
});
```

Create `growth-e2e-control-router-test.ts`:

```ts
test("E2E control plane refuses production, non-loopback and wrong token", async () => {
  assert.throws(
    () => assertGrowthE2eEnvironment({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      GROWTH_E2E_TOKEN: "token-32-characters-long-for-tests"
    }),
    /NODE_ENV=test/u
  );
  assert.throws(
    () => assertGrowthE2eEnvironment({
      NODE_ENV: "test",
      HOST: "0.0.0.0",
      GROWTH_E2E_TOKEN: "token-32-characters-long-for-tests"
    }),
    /loopback/u
  );
  const fixture = await controlRouterFixture();
  assert.equal((await fixture.post("/__growth_e2e__/reset", "wrong-token")).status, 404);
  assert.equal(fixture.controlCalls.length, 0);
});
```

Add a second router test proving `prepareClosedLoop` creates only user/workspace, active catalog/policy, deterministic Douyin provider input and deterministic model input; immediately after prepare, every array in `GrowthE2eState` is empty.

Define `controlRouterFixture()` in that test file: mount the router on an ephemeral Express listener, expose `post(path, token)`, record calls to a fake `GrowthE2eControlPort`, and close the listener in `test.afterEach`.

- [ ] **Step 2: Run MySQL/control tests and verify RED**

Run:

```bash
cd backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" NODE_ENV=test CRM_STORE=mysql TZ=UTC \
  node --import tsx --test --test-concurrency=1 \
  src/growth-closed-loop-mysql-test.ts \
  src/growth-e2e-control-router-test.ts
```

Expected: FAIL with module-not-found for the MySQL fixture and control router. If `MYSQL_TEST_ADMIN_URL` is absent, stop before running and report the missing required test database rather than substituting memory storage.

- [ ] **Step 3: Implement isolated MySQL composition and the test-only server**

`createMysqlGrowthClosedLoopHarness` creates a random database name `goodjob_growth_e2e_<hex>`, applies the production schema, points all growth/acquisition repositories at its two-or-more connection pool, calls the same production application factory as Task 4, and drops the database in `close()` after closing workers and pools. It must not share tables with developer or production databases.

Guard the control plane before router construction:

```ts
import { timingSafeEqual } from "node:crypto";

export interface GrowthE2eControlPort {
  reset(): Promise<void>;
  prepareClosedLoop(): Promise<GrowthE2eScenarioDescriptor>;
  waitUntilWorkersIdle(): Promise<void>;
  state(scenarioId: string): Promise<GrowthE2eState>;
}

export interface GrowthE2eControlRouterOptions {
  token: string;
  control: GrowthE2eControlPort;
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  const actualBytes = Buffer.from(actual ?? "", "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

export function assertGrowthE2eEnvironment(env: NodeJS.ProcessEnv): {
  host: "127.0.0.1";
  token: string;
} {
  if (env.NODE_ENV !== "test") throw new Error("Growth E2E requires NODE_ENV=test");
  if (env.HOST !== "127.0.0.1") throw new Error("Growth E2E requires a loopback HOST");
  const token = env.GROWTH_E2E_TOKEN ?? "";
  if (token.length < 32) throw new Error("Growth E2E token must contain at least 32 characters");
  return { host: "127.0.0.1", token };
}

export function createGrowthE2eControlRouter(options: GrowthE2eControlRouterOptions) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!tokenMatches(req.header("x-growth-e2e-token"), options.token)) {
      res.status(404).end();
      return;
    }
    next();
  });
  router.post("/reset", async (_req, res, next) => {
    try { await options.control.reset(); res.status(204).end(); } catch (error) { next(error); }
  });
  router.post("/scenarios/growth-closed-loop", async (_req, res, next) => {
    try { res.status(201).json(await options.control.prepareClosedLoop()); } catch (error) { next(error); }
  });
  router.post("/drain", async (_req, res, next) => {
    try { await options.control.waitUntilWorkersIdle(); res.status(204).end(); } catch (error) { next(error); }
  });
  router.get("/state/:scenarioId", async (req, res, next) => {
    try { res.json(await options.control.state(req.params.scenarioId)); } catch (error) { next(error); }
  });
  return router;
}
```

`growth-e2e-server.ts` validates the environment, creates the isolated MySQL composition, mounts `/__growth_e2e__` before the production error handler, starts production Quote Publication/Copilot/Outcome workers at a 25 ms test poll interval, and listens only on `127.0.0.1:4288`. Its control `drain` only waits until production queues/checkpoints are idle; it does not invoke domain mutations. SIGINT/SIGTERM close HTTP, workers, acquisition runtime, growth runtime and database in reverse startup order. Export `main()` for a smoke test and guard execution so importing the module never starts a listener:

```ts
import path from "node:path";
import { pathToFileURL } from "node:url";

function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === metaUrl;
}

export async function main(): Promise<void> {
  const guarded = assertGrowthE2eEnvironment(process.env);
  await startGrowthE2eServer({ host: guarded.host, port: 4288, token: guarded.token });
}

if (isMain(import.meta.url)) await main();
```

Merge these exact scripts as one syntactically complete JSON object:

```json
{
  "scripts": {
    "test:growth:closed-loop:mysql": "NODE_ENV=test CRM_STORE=mysql TZ=UTC node --import tsx --test --test-concurrency=1 src/growth-closed-loop-mysql-test.ts src/growth-e2e-control-router-test.ts",
    "e2e:growth:server": "NODE_ENV=test CRM_STORE=mysql HOST=127.0.0.1 PORT=4288 tsx src/growth-e2e-server.ts"
  }
}
```

- [ ] **Step 4: Verify MySQL parity, control security and build**

Run:

```bash
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth:closed-loop:mysql --workspace backend
npm run test:security --workspace backend
npm run build --workspace backend
git diff --check
```

Expected: PASS using MySQL; repeated commands produce one business fact, cross-workspace probes return 404/403 without leakage, the control plane is unreachable without all three guards, and prepare alone produces no quote/fact/closure/recommendation.

- [ ] **Step 5: Commit the MySQL F6 harness and guarded server**

```bash
git add backend/src/growth-closed-loop-mysql-fixture.ts backend/src/growth-closed-loop-mysql-test.ts backend/src/growth-e2e-control-router.ts backend/src/growth-e2e-control-router-test.ts backend/src/growth-e2e-server.ts backend/package.json
git commit -m "test(growth): add mysql real e2e server"
```

---

### Task 6: Execute the No-Interception Real Browser Closed Loop

**Files:**
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/fixtures/growth-real-api.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/growth-closed-loop.real.spec.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/growth-real-no-mock.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/playwright.real.config.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/package.json`

**Interfaces:**
- Consumes: Task 5 server/control endpoints, all real production HTTP routes through Vite proxy, existing login/acquisition/private-domain pages, F0–F5 growth pages.
- Produces: `createGrowthE2eControlClient`, `createGrowthRealApi`, scripts `test:e2e:real:guard` and `test:e2e:real`, one no-interception MySQL browser test.

```ts
export interface GrowthRealScenarioIds {
  candidateId: string;
  customerId: string;
  dealId: string;
  formalQuoteVersionId: string;
  cohortId: string;
}

export interface GrowthRealApi {
  currentScenarioIds(): Promise<GrowthRealScenarioIds>;
  decideWon(dealId: string, quoteVersionId: string): Promise<void>;
  recordVerifyAllocateAndClose(input: {
    cohortId: string;
    dealId: string;
    paymentMinor: number;
    costMinor: number;
    currency: "CNY";
  }): Promise<{ closureVersionId: string; calculationHash: `sha256:${string}` }>;
}
```

- [ ] **Step 1: Write the failing source guard, real API helper contract and browser journey**

Create `growth-real-no-mock.self-test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("real growth E2E contains no browser network interception or demo import", async () => {
  const files = [
    new URL("./growth-closed-loop.real.spec.ts", import.meta.url),
    new URL("./fixtures/growth-real-api.ts", import.meta.url)
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /page\.route|route\.fulfill|serviceWorker|src\/growth\/demo/u);
  }
});
```

Create the real journey with test-only control limited to preparation/drain/assertion:

```ts
function requiredEnv(name: "GROWTH_E2E_TOKEN"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

test("Douyin acquisition closes into immutable ROI and one controlled advisor Todo", async ({ page }) => {
  const control = createGrowthE2eControlClient(
    page.request,
    "http://127.0.0.1:4288",
    requiredEnv("GROWTH_E2E_TOKEN")
  );
  await control.reset();
  const scenario = await control.prepareClosedLoop();

  await page.goto("/");
  await page.getByLabel("邮箱").fill(scenario.user.email);
  await page.getByLabel("密码").fill(scenario.user.password);
  await page.getByRole("button", { name: "登录" }).click();
  const api = createGrowthRealApi(page.request, "http://127.0.0.1:5389");

  await page.goto("/#growth/advisor");
  await page.getByRole("button", { name: "真实模式" }).click();
  await expect(page.locator('[data-growth-bootstrap-state="ready"]')).toBeVisible();
  await expect(page.locator("[data-demo-metric]")).toHaveCount(0);

  await page.goto("/#acquisition");
  await page.getByRole("button", { name: "真实模式" }).click();
  await createDouyinAcquisitionTask(page, "工业照明采购商");
  await control.drainWorkers();
  await expect(page.getByText(scenario.expected.candidateDisplayName)).toBeVisible();
  await openVerifiedCandidateAndHandoff(page);

  await page.getByRole("link", { name: "创建权威报价" }).click();
  await completeQuoteInputAndPreview(page);
  await expect(page.getByText("CNY 3,200.00")).toBeVisible();
  await page.getByRole("button", { name: "保存并提交" }).click();
  await approveCurrentQuoteAsSecondActor(page, scenario.approver);
  await control.drainWorkers();

  const ids = await api.currentScenarioIds();
  await api.decideWon(ids.dealId, ids.formalQuoteVersionId);
  await control.drainWorkers();
  await api.recordVerifyAllocateAndClose({
    cohortId: ids.cohortId,
    dealId: ids.dealId,
    paymentMinor: scenario.expected.verifiedPaymentMinor,
    costMinor: scenario.expected.verifiedCostMinor,
    currency: "CNY"
  });

  await page.goto(`/#growth/roi?cohort=${ids.cohortId}&currency=CNY`);
  await expect(page.getByRole("region", { name: "已核销经营结果" })).toContainText("已核销");
  await expect(page.getByText(scenario.expected.closureCalculationHash)).toBeVisible();

  await page.goto("/#growth/advisor");
  await page.getByLabel("向增长参谋提问").fill("基于刚刚关账的数据，今天下一步做什么？");
  await page.getByRole("button", { name: "提交问题" }).click();
  await control.drainWorkers();
  await page.getByRole("button", { name: "采纳并创建待办" }).click();
  await expect(page.getByText(scenario.expected.controlledTodoTitle)).toBeVisible();

  const state = await control.state(scenario.scenarioId);
  expect(state.draftQuoteVersionIds).toHaveLength(1);
  expect(state.formalQuoteVersions).toHaveLength(1);
  expect(state.formalQuoteVersions[0]?.sourceDraftVersionId).toBe(state.draftQuoteVersionIds[0]);
  expect(state.piIds).toHaveLength(1);
  expect(state.quotedDealEventIds).toHaveLength(1);
  expect(state.quotedOutcomeIds).toHaveLength(1);
  expect(state.wonDealEventIds).toHaveLength(1);
  expect(state.wonOutcomeIds).toHaveLength(1);
  expect(state.dealAuthority?.currentQuoteVersionId).toBeNull();
  expect(state.closureVersionIds).toHaveLength(1);
  expect(state.recommendationIds).toHaveLength(1);
  expect(state.salesTodoIds).toHaveLength(1);
  expect(state.outboundMessageIds).toHaveLength(0);
});
```

`growth-real-api.ts` must define the four named browser helpers in the test (`createDouyinAcquisitionTask`, `openVerifiedCandidateAndHandoff`, `completeQuoteInputAndPreview`, `approveCurrentQuoteAsSecondActor`) plus `createGrowthRealApi`. The public API helper sends real CSRF/ETag/idempotency headers through `APIRequestContext`; it may perform won, ledger verification, allocation, attestation and close because those production actions have no F0–F5 UI command requirement. It may not call any `__growth_e2e__` endpoint. The control client alone owns the four test-control operations.

- [ ] **Step 2: Run source guard/config and verify RED**

Run from the external frontend:

```bash
pnpm exec tsx --test tests/growth-real-no-mock.self-test.ts
pnpm exec playwright test --config playwright.real.config.ts
```

Expected: source test initially fails because helper/spec are absent; Playwright then fails because `playwright.real.config.ts` and the managed backend server do not exist.

- [ ] **Step 3: Implement the real API/control clients and two-server config**

Use one closed control client:

```ts
export function createGrowthE2eControlClient(request, baseUrl, token): GrowthE2eControlClient {
  async function call<T>(method: "GET" | "POST", path: string): Promise<T> {
    const response = await request.fetch(`${baseUrl}${path}`, {
      method,
      headers: { "x-growth-e2e-token": token }
    });
    if (!response.ok()) throw new Error(`Growth E2E control failed: ${response.status()} ${path}`);
    return response.json() as Promise<T>;
  }
  return {
    reset: () => call("POST", "/__growth_e2e__/reset"),
    prepareClosedLoop: () => call("POST", "/__growth_e2e__/scenarios/growth-closed-loop"),
    drainWorkers: () => call("POST", "/__growth_e2e__/drain"),
    state: (scenarioId) => call("GET", `/__growth_e2e__/state/${encodeURIComponent(scenarioId)}`)
  };
}
```

Create `playwright.real.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

const backendRoot = process.env.GOODJOB_BACKEND_ROOT;
const mysqlAdminUrl = process.env.MYSQL_TEST_ADMIN_URL;
const e2eToken = process.env.GROWTH_E2E_TOKEN;
if (!backendRoot || !mysqlAdminUrl || !e2eToken) {
  throw new Error("GOODJOB_BACKEND_ROOT, MYSQL_TEST_ADMIN_URL and GROWTH_E2E_TOKEN are required");
}

export default defineConfig({
  testDir: "./tests",
  testMatch: "growth-closed-loop.real.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:5389",
    trace: "retain-on-failure",
    video: "retain-on-failure"
  },
  webServer: [{
    command: "npm run e2e:growth:server --workspace backend",
    cwd: backendRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      CRM_STORE: "mysql",
      HOST: "127.0.0.1",
      PORT: "4288",
      MYSQL_TEST_ADMIN_URL: mysqlAdminUrl,
      GROWTH_E2E_TOKEN: e2eToken
    },
    url: "http://127.0.0.1:4288/api/health",
    reuseExistingServer: false,
    timeout: 60_000
  }, {
    command: "pnpm exec vite --host 127.0.0.1 --port 5389",
    cwd: ".",
    env: { ...process.env, VITE_API_TARGET: "http://127.0.0.1:4288" },
    url: "http://127.0.0.1:5389/",
    reuseExistingServer: false,
    timeout: 30_000
  }]
});
```

Merge these exact scripts into the frontend `package.json` as a syntactically complete JSON object:

```json
{
  "scripts": {
    "test:e2e:real:guard": "tsx --test tests/growth-real-no-mock.self-test.ts",
    "test:e2e:real": "playwright test --config playwright.real.config.ts"
  }
}
```

The real spec uses random action-key suffixes supplied by the scenario, but deliberately replays submit/approve/verification once with the same key and asserts the final state counts remain one.

- [ ] **Step 4: Verify guard, real MySQL browser loop and frontend build**

Run:

```bash
GOODJOB_BACKEND_ROOT=/Users/mac/Documents/外贸/GoodJob-1.09/.worktrees/goodjob-growth-advisor-quote-roi \
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" \
GROWTH_E2E_TOKEN=goodjob-growth-real-e2e-token-20260809 \
pnpm run test:e2e:real:guard

GOODJOB_BACKEND_ROOT=/Users/mac/Documents/外贸/GoodJob-1.09/.worktrees/goodjob-growth-advisor-quote-roi \
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" \
GROWTH_E2E_TOKEN=goodjob-growth-real-e2e-token-20260809 \
pnpm run test:e2e:real

pnpm run contract:check
pnpm run test:types
pnpm test
pnpm build
git diff --check
```

Expected: PASS against MySQL with no route interception; the browser sees the production bootstrap, one verified candidate/battle card, one authoritative quote and publication, closed actual ROI with the persisted calculation hash, one Advisor recommendation/Todo and no outbound action.

- [ ] **Step 5: Commit the real browser F6 suite**

```bash
git add tests/fixtures/growth-real-api.ts tests/growth-closed-loop.real.spec.ts tests/growth-real-no-mock.self-test.ts playwright.real.config.ts package.json
git commit -m "test: add real growth closed loop e2e"
```

Do not stage `pnpm-workspace.yaml`.

---

### Task 7: Enforce Producer, Consumer and Coordinated Dual-Repository Release Gates

**Files:**
- Create: `tools/growth-dual-repo-release-gate.mjs`
- Create: `tools/growth-dual-repo-release-gate.test.mjs`
- Create: `.github/workflows/growth-release.yml`
- Create: `docs/operations/growth-dual-repository-release.md`
- Modify: `.github/workflows/acquisition-contracts.yml`
- Modify: `package.json`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/.github/workflows/growth-frontend.yml`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/package.json`

**Interfaces:**
- Consumes: backend release `manifest.json`, frontend pinned manifest, immutable backend/frontend commit SHA, explicit rollback refs, all scripts from C0/Q0/Q1.
- Produces: `assertSameGrowthContract(producer, consumer)`, `assertRequiredExecutionMarker(command, execution)`, `readProducerManifestForConsumer({ backendRoot, consumerManifest })`, `readRepositoryReleaseSnapshot(repositoryRoot)`, `assertRepositoryReleaseSnapshotUnchanged(before, after)`, `resolveImmutableRollbackCommit({ repositoryRoot, suppliedSha, releaseSha })`, `runGrowthReleaseGate(options): Promise<GrowthReleaseRecord>`, `runGrowthReleaseCli(options): Promise<void>`, root scripts `test:growth-release-gate` and `release:growth`, CI artifact `growth-release-record.json`.

- [ ] **Step 1: Write the failing manifest/command/record gate test**

Create `tools/growth-dual-repo-release-gate.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertRequiredExecutionMarker,
  assertSameGrowthContract,
  assertRepositoryReleaseSnapshotUnchanged,
  expectedGrowthReleaseCommands,
  readProducerManifestForConsumer,
  resolveImmutableRollbackCommit,
  runGrowthReleaseGate
} from "./growth-dual-repo-release-gate.mjs";

const manifest = {
  name: "growth-advisor-quote-roi",
  contractVersion: "7.8.9",
  contractHash: `sha256:${"a".repeat(64)}`,
  openapiVersion: "3.1.0"
};

test("coordinated gate rejects any producer/consumer identity mismatch", () => {
  assert.throws(
    () => assertSameGrowthContract(manifest, { ...manifest, contractVersion: "2.0.0" }),
    /contractVersion mismatch/u
  );
  assert.throws(
    () => assertSameGrowthContract(manifest, { ...manifest, contractHash: `sha256:${"b".repeat(64)}` }),
    /contractHash mismatch/u
  );
});

test("Foundation and Advisor real-MySQL commands require positive two-connection markers", () => {
  for (const suite of ["foundation", "advisor"]) {
    const command = {
      executable: "npm",
      args: ["run", `test:growth-${suite}:mysql`, "--workspace", "backend"],
      requiredOutputMarkerPattern: `GROWTH_REAL_MYSQL ${suite} connections=2 tests=[1-9][0-9]*`
    };
    assert.throws(
      () => assertRequiredExecutionMarker(command, { executionMarker: null }),
      /mandatory execution marker missing/u
    );
    assert.throws(
      () => assertRequiredExecutionMarker(command, { executionMarker: `GROWTH_REAL_MYSQL ${suite} connections=2 tests=0` }),
      /mandatory execution marker missing/u
    );
    const marker = `GROWTH_REAL_MYSQL ${suite} connections=2 tests=7`;
    assert.equal(assertRequiredExecutionMarker(command, { executionMarker: marker }), marker);
  }
});

test("coordinated gate runs the fixed matrix and records both commits and rollback refs", async () => {
  const calls = [];
  const rollbackResolutions = [];
  const requiredBackendSuites = [
    "backend:npm run test:growth-foundation --workspace backend",
    "backend:npm run test:growth-foundation:mysql --workspace backend",
    "backend:npm run test:growth-catalog --workspace backend",
    "backend:npm run test:growth-quotes --workspace backend",
    "backend:npm run test:growth-finance:mysql --workspace backend",
    "backend:npm run test:growth-roi:mysql --workspace backend",
    "backend:npm run test:growth-advisor --workspace backend",
    "backend:npm run test:growth-advisor:mysql --workspace backend"
  ];
  const requiredReleaseSuites = [
    "backend:npm run test:contracts",
    "frontend:pnpm run test:growth:fixture",
    "frontend:pnpm run test:e2e:real:guard"
  ];
  for (const suite of [...requiredBackendSuites, ...requiredReleaseSuites]) {
    assert.equal(expectedGrowthReleaseCommands().includes(suite), true, suite);
  }
  const snapshots = new Map([
    ["/repo/backend", { headBytes: Buffer.from(`${"1".repeat(40)}\n`), statusBytes: Buffer.alloc(0), commit: "1".repeat(40) }],
    ["/repo/frontend", { headBytes: Buffer.from(`${"2".repeat(40)}\n`), statusBytes: Buffer.alloc(0), commit: "2".repeat(40) }]
  ]);
  const record = await runGrowthReleaseGate({
    backendRoot: "/repo/backend",
    frontendRoot: "/repo/frontend",
    backendCommit: "1".repeat(40),
    frontendCommit: "2".repeat(40),
    backendRollbackRef: "3".repeat(40),
    frontendRollbackRef: "4".repeat(40),
    producerManifest: manifest,
    consumerManifest: manifest,
    environment: { MYSQL_TEST_ADMIN_URL: "mysql://root:test@127.0.0.1:3306" },
    now: () => "2026-08-09T08:00:00.000Z",
    readProducerManifest: async () => manifest,
    readConsumerManifest: async () => manifest,
    readRepositorySnapshot: async (repositoryRoot) => structuredClone(snapshots.get(repositoryRoot)),
    resolveRollbackCommit: async (input) => {
      rollbackResolutions.push(input);
      return input.suppliedSha;
    },
    run: async (command) => {
      calls.push(command);
      return {
        executionMarker: command.requiredOutputMarkerPattern
          ? `GROWTH_REAL_MYSQL ${command.args[1].includes("foundation") ? "foundation" : "advisor"} connections=2 tests=7`
          : null
      };
    }
  });
  assert.equal(record.contractHash, manifest.contractHash);
  assert.equal(record.backendCommit, "1".repeat(40));
  assert.equal(record.frontendCommit, "2".repeat(40));
  assert.deepEqual(rollbackResolutions, [
    { repositoryRoot: "/repo/backend", suppliedSha: "3".repeat(40), releaseSha: "1".repeat(40) },
    { repositoryRoot: "/repo/frontend", suppliedSha: "4".repeat(40), releaseSha: "2".repeat(40) }
  ]);
  assert.deepEqual(
    calls.map((call) => `${call.repository}:${call.executable} ${call.args.join(" ")}`),
    expectedGrowthReleaseCommands()
  );
  assert.equal(calls.every((call) => call.environment.GROWTH_RELEASE_REQUIRE_MYSQL === "1"), true);
  assert.equal(calls.every((call) => call.environment.MYSQL_TEST_ADMIN_URL.includes("127.0.0.1")), true);
  for (const command of [
    "npm run test:growth-foundation:mysql --workspace backend",
    "npm run test:growth-catalog --workspace backend",
    "npm run test:growth-quotes --workspace backend",
    "npm run test:growth-finance:mysql --workspace backend",
    "npm run test:growth-roi:mysql --workspace backend",
    "npm run test:growth-advisor:mysql --workspace backend",
    "npm run test:growth:closed-loop:mysql --workspace backend",
    "pnpm run test:e2e:real"
  ]) {
    assert.equal(
      record.commands.find((entry) => entry.command === command)?.executionMode,
      "real_mysql",
      command
    );
  }
  assert.equal(
    record.commands.find((entry) => entry.command === "npm run test:growth-foundation --workspace backend")?.executionMode,
    "standard"
  );
  assert.equal(
    record.commands.find((entry) => entry.command === "npm run test:growth-foundation:mysql --workspace backend")?.executionMarker,
    "GROWTH_REAL_MYSQL foundation connections=2 tests=7"
  );
  assert.equal(
    record.commands.find((entry) => entry.command === "npm run test:growth-advisor --workspace backend")?.executionMode,
    "standard"
  );
  assert.equal(
    record.commands.find((entry) => entry.command === "npm run test:growth-advisor:mysql --workspace backend")?.executionMarker,
    "GROWTH_REAL_MYSQL advisor connections=2 tests=7"
  );
});

test("release requires clean repositories and byte-identical HEAD/status snapshots after commands", () => {
  const clean = {
    headBytes: Buffer.from(`${"a".repeat(40)}\n`),
    statusBytes: Buffer.alloc(0),
    commit: "a".repeat(40)
  };
  assert.doesNotThrow(() => assertRepositoryReleaseSnapshotUnchanged(clean, structuredClone(clean)));
  assert.throws(
    () => assertRepositoryReleaseSnapshotUnchanged(
      clean,
      { ...clean, headBytes: Buffer.from(`${"b".repeat(40)}\n`), commit: "b".repeat(40) }
    ),
    /HEAD changed during release/u
  );
  assert.throws(
    () => assertRepositoryReleaseSnapshotUnchanged(
      clean,
      { ...clean, statusBytes: Buffer.from("?? pnpm-workspace.yaml\0") }
    ),
    /working tree changed during release/u
  );
  assert.throws(
    () => assertRepositoryReleaseSnapshotUnchanged(
      { ...clean, statusBytes: Buffer.from(" M pnpm-workspace.yaml\0") },
      clean
    ),
    /working tree must be clean before release/u
  );
});

test("release refuses to start without the mandatory real-MySQL admin harness", async () => {
  await assert.rejects(
    runGrowthReleaseGate({
      backendCommit: "1".repeat(40),
      frontendCommit: "2".repeat(40),
      environment: {}
    }),
    /MYSQL_TEST_ADMIN_URL is required/u
  );
});

test("producer manifest location is derived from the pinned consumer version", async () => {
  const paths = [];
  assert.deepEqual(
    await readProducerManifestForConsumer({
      backendRoot: "/repo/backend",
      consumerManifest: manifest,
      readJson: async (filename) => { paths.push(filename); return manifest; }
    }),
    manifest
  );
  assert.deepEqual(paths, [
    `/repo/backend/contracts/releases/growth-advisor-quote-roi/${manifest.contractVersion}/manifest.json`
  ]);
  await assert.rejects(
    readProducerManifestForConsumer({
      backendRoot: "/repo/backend",
      consumerManifest: { ...manifest, contractVersion: "../mutable" },
      readJson: async () => manifest
    }),
    /strict SemVer/u
  );
  const source = await readFile(
    new URL("./growth-dual-repo-release-gate.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /contracts\/releases\/growth-advisor-quote-roi\/\d+\.\d+\.\d+\//u
  );
});

test("rollback inputs require a distinct ancestor and complete history in their own repository", async () => {
  await assert.rejects(
    resolveImmutableRollbackCommit({
      repositoryRoot: "/repo/backend",
      suppliedSha: "HEAD",
      releaseSha: "1".repeat(40),
      runGit: async () => "1".repeat(40)
    }),
    /40-hex immutable commit SHA/u
  );
  await assert.rejects(
    resolveImmutableRollbackCommit({
      repositoryRoot: "/repo/backend",
      suppliedSha: "b".repeat(40),
      releaseSha: "b".repeat(40),
      runGit: async () => "false\n"
    }),
    /must differ from release SHA/u
  );
  await assert.rejects(
    resolveImmutableRollbackCommit({
      repositoryRoot: "/repo/frontend",
      suppliedSha: "c".repeat(40),
      releaseSha: "d".repeat(40),
      runGit: async ({ args }) => args.includes("--is-shallow-repository") ? "true\n" : `${"c".repeat(40)}\n`
    }),
    /complete Git history/u
  );
  await assert.rejects(
    resolveImmutableRollbackCommit({
      repositoryRoot: "/repo/frontend",
      suppliedSha: "c".repeat(40),
      releaseSha: "d".repeat(40),
      runGit: async ({ args }) => {
        if (args.includes("--is-shallow-repository")) return "false\n";
        if (args[0] === "merge-base") throw new Error("rollback SHA is not an ancestor of release SHA");
        return `${"c".repeat(40)}\n`;
      }
    }),
    /not an ancestor/u
  );
  const rollbackSha = "a".repeat(40);
  const releaseSha = "b".repeat(40);
  const calls = [];
  assert.equal(
    await resolveImmutableRollbackCommit({
      repositoryRoot: "/repo/frontend",
      suppliedSha: rollbackSha,
      releaseSha,
      runGit: async (input) => {
        calls.push(input);
        if (input.args.includes("--is-shallow-repository")) return "false\n";
        if (input.args[0] === "merge-base") return "";
        return `${rollbackSha}\n`;
      }
    }),
    rollbackSha
  );
  assert.deepEqual(calls, [
    { cwd: "/repo/frontend", args: ["rev-parse", "--is-shallow-repository"] },
    { cwd: "/repo/frontend", args: ["rev-parse", "--verify", `${rollbackSha}^{commit}`] },
    { cwd: "/repo/frontend", args: ["merge-base", "--is-ancestor", rollbackSha, releaseSha] }
  ]);
});

test("release workflow checks out the explicit frontend repository and verifies origin", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/growth-release.yml", import.meta.url),
    "utf8"
  );
  assert.match(workflow, /frontend_repository:\s*[\s\S]*?required:\s*true/u);
  assert.match(workflow, /repository:\s*\$\{\{\s*inputs\.frontend_repository\s*\}\}/u);
  assert.match(workflow, /EXPECTED_FRONTEND_REPOSITORY/u);
  assert.match(workflow, /remote get-url origin/u);
  assert.equal((workflow.match(/fetch-depth:\s*0/gu) ?? []).length, 2);
  assert.doesNotMatch(
    workflow,
    /repository:\s*\$\{\{\s*github\.repository\s*\}\}[\s\S]{0,160}frontend_ref/u
  );
});
```

- [ ] **Step 2: Run release gate tests and verify RED**

Run from the backend worktree:

```bash
node --test tools/growth-dual-repo-release-gate.test.mjs
```

Expected: FAIL with module-not-found for `growth-dual-repo-release-gate.mjs`.

- [ ] **Step 3: Implement hash equality, fixed command execution and atomic release record**

Implement equality and command execution without `shell: true`:

```js
const rawCommands = [
  { repository: "backend", executable: "npm", args: ["run", "check:growth-contracts"] },
  { repository: "backend", executable: "npm", args: ["run", "test:contracts"] },
  { repository: "backend", executable: "npm", args: ["run", "test:contract-drift", "--workspace", "backend"] },
  { repository: "backend", executable: "npm", args: ["run", "test:acquisition-openapi", "--workspace", "backend"] },
  { repository: "backend", executable: "npm", args: ["run", "test:security", "--workspace", "backend"] },
  { repository: "backend", executable: "npm", args: ["run", "test:growth-foundation", "--workspace", "backend"] },
  {
    repository: "backend",
    executable: "npm",
    args: ["run", "test:growth-foundation:mysql", "--workspace", "backend"],
    requiredOutputMarkerPattern: "GROWTH_REAL_MYSQL foundation connections=2 tests=[1-9][0-9]*"
  },
  { repository: "backend", executable: "npm", args: ["run", "test:growth-catalog", "--workspace", "backend"] },
  { repository: "backend", executable: "npm", args: ["run", "test:growth-quotes", "--workspace", "backend"] },
  { repository: "backend", executable: "npm", args: ["run", "test:growth-finance:mysql", "--workspace", "backend"] },
  { repository: "backend", executable: "npm", args: ["run", "test:growth-roi:mysql", "--workspace", "backend"] },
  { repository: "backend", executable: "npm", args: ["run", "test:growth-advisor", "--workspace", "backend"] },
  {
    repository: "backend",
    executable: "npm",
    args: ["run", "test:growth-advisor:mysql", "--workspace", "backend"],
    requiredOutputMarkerPattern: "GROWTH_REAL_MYSQL advisor connections=2 tests=[1-9][0-9]*"
  },
  { repository: "backend", executable: "npm", args: ["run", "test:acquisition", "--workspace", "backend"] },
  { repository: "backend", executable: "npm", args: ["run", "test:growth:closed-loop", "--workspace", "backend"] },
  { repository: "backend", executable: "npm", args: ["run", "test:growth:closed-loop:mysql", "--workspace", "backend"] },
  { repository: "backend", executable: "npm", args: ["run", "build"] },
  { repository: "frontend", executable: "pnpm", args: ["run", "contract:check"] },
  { repository: "frontend", executable: "pnpm", args: ["run", "test:growth:fixture"] },
  { repository: "frontend", executable: "pnpm", args: ["run", "test:types"] },
  { repository: "frontend", executable: "pnpm", args: ["test"] },
  { repository: "frontend", executable: "pnpm", args: ["run", "test:e2e"] },
  { repository: "frontend", executable: "pnpm", args: ["run", "test:e2e:real:guard"] },
  { repository: "frontend", executable: "pnpm", args: ["run", "test:e2e:real"] },
  { repository: "frontend", executable: "pnpm", args: ["build"] }
];

// This unfiltered suite is release-mandatory and includes Foundation's
// nextGrowthRecordedAt same-clock/old-asOf immutability contract test.
if (!rawCommands.some((command) =>
    command.repository === "backend"
    && command.executable === "npm"
    && command.args.join(" ") === "run test:growth-foundation --workspace backend"
  )) throw new Error("growth release matrix must include the unfiltered Foundation clock suite");

const realMysqlCommandKeys = new Set([
  "backend:npm run test:growth-foundation:mysql --workspace backend",
  "backend:npm run test:growth-catalog --workspace backend",
  "backend:npm run test:growth-quotes --workspace backend",
  "backend:npm run test:growth-finance:mysql --workspace backend",
  "backend:npm run test:growth-roi:mysql --workspace backend",
  "backend:npm run test:growth-advisor:mysql --workspace backend",
  "backend:npm run test:growth:closed-loop:mysql --workspace backend",
  "frontend:pnpm run test:e2e:real"
]);

const commands = rawCommands.map((command) => {
  const key = `${command.repository}:${command.executable} ${command.args.join(" ")}`;
  return {
    ...command,
    executionMode: realMysqlCommandKeys.has(key) ? "real_mysql" : "standard"
  };
});

export function expectedGrowthReleaseCommands() {
  return commands.map(
    (command) => `${command.repository}:${command.executable} ${command.args.join(" ")}`
  );
}

export function assertSameGrowthContract(producer, consumer) {
  if (producer.name !== "growth-advisor-quote-roi" || consumer.name !== producer.name) {
    throw new Error("growth contract name mismatch");
  }
  if (consumer.contractVersion !== producer.contractVersion) {
    throw new Error("growth contractVersion mismatch");
  }
  if (consumer.contractHash !== producer.contractHash) {
    throw new Error("growth contractHash mismatch");
  }
}

export function assertRequiredExecutionMarker(command, execution) {
  if (!command.requiredOutputMarkerPattern) return null;
  const markerPattern = new RegExp(`^(?:${command.requiredOutputMarkerPattern})$`, "u");
  if (typeof execution?.executionMarker !== "string" || !markerPattern.test(execution.executionMarker)) {
    throw new Error(`mandatory execution marker missing for ${command.executable} ${command.args.join(" ")}`);
  }
  return execution.executionMarker;
}

export async function runGrowthReleaseGate(options) {
  assertFullCommitSha(options.backendCommit, "backendCommit");
  assertFullCommitSha(options.frontendCommit, "frontendCommit");
  const environment = options.environment ?? process.env;
  if (!environment.MYSQL_TEST_ADMIN_URL) {
    throw new Error("MYSQL_TEST_ADMIN_URL is required for mandatory release MySQL suites");
  }
  const commandEnvironment = Object.freeze({
    ...environment,
    MYSQL_TEST_ADMIN_URL: environment.MYSQL_TEST_ADMIN_URL,
    GROWTH_RELEASE_REQUIRE_MYSQL: "1"
  });
  const readSnapshot = options.readRepositorySnapshot ?? readRepositoryReleaseSnapshot;
  const [backendBefore, frontendBefore] = await Promise.all([
    readSnapshot(options.backendRoot),
    readSnapshot(options.frontendRoot)
  ]);
  if (backendBefore.commit !== options.backendCommit) throw new Error("backend release SHA must equal checked-out HEAD");
  if (frontendBefore.commit !== options.frontendCommit) throw new Error("frontend release SHA must equal checked-out HEAD");
  assertRepositoryReleaseSnapshotUnchanged(backendBefore, backendBefore);
  assertRepositoryReleaseSnapshotUnchanged(frontendBefore, frontendBefore);
  const resolveRollback = options.resolveRollbackCommit ?? resolveImmutableRollbackCommit;
  const backendRollbackRef = await resolveRollback({
    repositoryRoot: options.backendRoot,
    suppliedSha: options.backendRollbackRef,
    releaseSha: options.backendCommit
  });
  const frontendRollbackRef = await resolveRollback({
    repositoryRoot: options.frontendRoot,
    suppliedSha: options.frontendRollbackRef,
    releaseSha: options.frontendCommit
  });
  assertFullCommitSha(backendRollbackRef, "backendRollbackRef");
  assertFullCommitSha(frontendRollbackRef, "frontendRollbackRef");
  assertSameGrowthContract(options.producerManifest, options.consumerManifest);
  const results = [];
  for (const command of commands) {
    const execution = await options.run({
      ...command,
      cwd: command.repository === "backend" ? options.backendRoot : options.frontendRoot,
      environment: commandEnvironment
    });
    const executionMarker = assertRequiredExecutionMarker(command, execution);
    results.push({
      repository: command.repository,
      command: `${command.executable} ${command.args.join(" ")}`,
      status: "passed",
      executionMode: command.executionMode,
      executionMarker
    });
  }
  const recordedRealMysqlKeys = new Set(
    results
      .filter((entry) => entry.executionMode === "real_mysql")
      .map((entry) => `${entry.repository}:${entry.command}`)
  );
  for (const requiredKey of realMysqlCommandKeys) {
    if (!recordedRealMysqlKeys.has(requiredKey)) {
      throw new Error(`mandatory real-MySQL suite did not execute: ${requiredKey}`);
    }
  }
  const producerAfter = await (
    options.readProducerManifest
    ?? ((backendRoot) => readProducerManifestForConsumer({
      backendRoot,
      consumerManifest: options.consumerManifest
    }))
  )(options.backendRoot);
  const consumerAfter = await (options.readConsumerManifest ?? readConsumerManifest)(options.frontendRoot);
  assertSameGrowthContract(producerAfter, consumerAfter);
  assertSameGrowthContract(options.producerManifest, producerAfter);
  assertSameGrowthContract(options.consumerManifest, consumerAfter);
  const [backendAfter, frontendAfter] = await Promise.all([
    readSnapshot(options.backendRoot),
    readSnapshot(options.frontendRoot)
  ]);
  assertRepositoryReleaseSnapshotUnchanged(backendBefore, backendAfter);
  assertRepositoryReleaseSnapshotUnchanged(frontendBefore, frontendAfter);
  const verifiedAt = options.now();
  return {
    backendCommit: options.backendCommit,
    frontendCommit: options.frontendCommit,
    backendRollbackRef,
    frontendRollbackRef,
    contractVersion: options.producerManifest.contractVersion,
    contractHash: options.producerManifest.contractHash,
    verifiedAtUtc: typeof verifiedAt === "string" ? verifiedAt : verifiedAt.toISOString(),
    commands: results
  };
}
```

Resolve repository snapshots and rollback inputs with this exact fail-closed rule. Snapshot capture preserves raw stdout bytes; a release requires zero status bytes before any manifest read/command and byte-identical HEAD/status after the command matrix. The rollback value itself must already be a 40-hex SHA, must differ from the corresponding release SHA, and must be a proven ancestor of that release SHA in a non-shallow repository:

```js
import { spawn } from "node:child_process";
import { open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const fullCommitSha = /^[0-9a-f]{40}$/u;

function assertFullCommitSha(value, label) {
  if (typeof value !== "string" || !fullCommitSha.test(value.toLowerCase())) {
    throw new Error(`${label} must be a 40-hex commit SHA`);
  }
}

function runGitCaptureBytes({ cwd, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout.push(Buffer.from(chunk)); });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function runGitCapture(input) {
  return (await runGitCaptureBytes(input)).toString("utf8");
}

export async function readRepositoryReleaseSnapshot(
  repositoryRoot,
  runGitBytes = runGitCaptureBytes
) {
  const [headBytes, statusBytes] = await Promise.all([
    runGitBytes({ cwd: repositoryRoot, args: ["rev-parse", "--verify", "HEAD^{commit}"] }),
    runGitBytes({ cwd: repositoryRoot, args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"] })
  ]);
  const commit = Buffer.from(headBytes).toString("utf8").trim().toLowerCase();
  assertFullCommitSha(commit, "checkedOutCommit");
  return { headBytes, statusBytes, commit };
}

export function assertRepositoryReleaseSnapshotUnchanged(before, after) {
  if (Buffer.from(before.statusBytes).byteLength !== 0) {
    throw new Error("working tree must be clean before release");
  }
  if (!Buffer.from(before.headBytes).equals(Buffer.from(after.headBytes))) {
    throw new Error("HEAD changed during release");
  }
  if (!Buffer.from(before.statusBytes).equals(Buffer.from(after.statusBytes))) {
    throw new Error("working tree changed during release");
  }
}

export async function resolveImmutableRollbackCommit({
  repositoryRoot,
  suppliedSha,
  releaseSha,
  runGit = runGitCapture
}) {
  if (typeof suppliedSha !== "string" || !fullCommitSha.test(suppliedSha.toLowerCase())) {
    throw new Error("rollback ref must be a 40-hex immutable commit SHA");
  }
  if (typeof releaseSha !== "string") throw new Error("releaseSha must be a 40-hex commit SHA");
  const normalized = suppliedSha.toLowerCase();
  const normalizedRelease = releaseSha.toLowerCase();
  assertFullCommitSha(normalizedRelease, "releaseSha");
  if (normalized === normalizedRelease) {
    throw new Error("rollback SHA must differ from release SHA");
  }
  const shallow = (await runGit({
    cwd: repositoryRoot,
    args: ["rev-parse", "--is-shallow-repository"]
  })).trim();
  if (shallow !== "false") throw new Error("release ancestry requires complete Git history");
  const resolved = (await runGit({
    cwd: repositoryRoot,
    args: ["rev-parse", "--verify", `${normalized}^{commit}`]
  })).trim().toLowerCase();
  if (resolved !== normalized || !fullCommitSha.test(resolved)) {
    throw new Error(`rollback SHA is not an immutable commit in ${repositoryRoot}`);
  }
  try {
    await runGit({
      cwd: repositoryRoot,
      args: ["merge-base", "--is-ancestor", normalized, normalizedRelease]
    });
  } catch (error) {
    throw new Error("rollback SHA is not an ancestor of release SHA", { cause: error });
  }
  return resolved;
}
```

The CLI accepts exactly `--frontend-root`, `--backend-rollback-ref`, `--frontend-rollback-ref`, and `--record`. It obtains checked-out commits only from the clean repository snapshots above. It calls `resolveImmutableRollbackCommit` once with `backendRoot`/backend release SHA/rollback SHA, then once with `frontendRoot`/frontend release SHA/rollback SHA; it records only those distinct verified ancestor commits. Unresolvable SHAs, SHA-like values that name a non-commit object, symbolic refs, mutable names, shallow history, equal release/rollback SHAs and non-ancestors stop before the command matrix. It reads the consumer manifest first, derives the producer manifest path from its strict-SemVer `contractVersion`, uses `spawn(executable, args, { cwd, stdio: "inherit", shell: false })`, writes the release record to a temporary sibling, fsyncs it, then renames atomically. It passes `GOODJOB_BACKEND_ROOT`, mandatory `MYSQL_TEST_ADMIN_URL` and `GROWTH_E2E_TOKEN` into the real frontend E2E command; a missing MySQL admin URL fails before any suite and no MySQL suite may skip.

The module is importable by its unit test, so use an explicit main guard:

```js
const requiredCliFlags = [
  "--frontend-root",
  "--backend-rollback-ref",
  "--frontend-rollback-ref",
  "--record"
];

function parseExactReleaseArguments(argv) {
  if (argv.length !== requiredCliFlags.length * 2) {
    throw new Error(`Usage: growth-dual-repo-release-gate.mjs ${requiredCliFlags.map((flag) => `${flag} <value>`).join(" ")}`);
  }
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!requiredCliFlags.includes(flag) || !value || parsed.has(flag)) {
      throw new Error(`Invalid or duplicate release argument: ${flag ?? "<missing>"}`);
    }
    parsed.set(flag, value);
  }
  if (parsed.size !== requiredCliFlags.length) throw new Error("Missing required release argument");
  return {
    frontendRoot: path.resolve(parsed.get("--frontend-root")),
    backendRollbackRef: parsed.get("--backend-rollback-ref"),
    frontendRollbackRef: parsed.get("--frontend-rollback-ref"),
    recordPath: path.resolve(parsed.get("--record"))
  };
}

function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === metaUrl;
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

const strictContractVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export async function readProducerManifestForConsumer({
  backendRoot,
  consumerManifest,
  readJson: read = readJson
}) {
  const version = consumerManifest?.contractVersion;
  if (typeof version !== "string" || !strictContractVersion.test(version)) {
    throw new Error("consumer contractVersion must be strict SemVer");
  }
  const manifest = await read(path.join(
    backendRoot,
    "contracts/releases/growth-advisor-quote-roi",
    version,
    "manifest.json"
  ));
  if (manifest.contractVersion !== version) {
    throw new Error("producer manifest version does not match its release directory");
  }
  return manifest;
}

function readConsumerManifest(repositoryRoot) {
  return readJson(path.join(
    repositoryRoot,
    "contracts/pinned/growth-advisor-quote-roi.manifest.json"
  ));
}

async function runFixedCommand(command, backendRoot) {
  return new Promise((resolve, reject) => {
    const markerPattern = command.requiredOutputMarkerPattern
      ? new RegExp(command.requiredOutputMarkerPattern, "u")
      : null;
    let markerTail = "";
    let executionMarker = null;
    const inspectMarker = (chunk) => {
      if (!markerPattern || executionMarker) return;
      markerTail = `${markerTail}${chunk.toString("utf8")}`.slice(-512);
      executionMarker = markerTail.match(markerPattern)?.[0] ?? null;
    };
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...command.environment,
        GOODJOB_BACKEND_ROOT: backendRoot,
        GROWTH_RELEASE_REQUIRE_MYSQL: "1"
      }
    });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      inspectMarker(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      inspectMarker(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command.executable} ${command.args.join(" ")} failed with ${code}`));
        return;
      }
      if (markerPattern && !executionMarker) {
        reject(new Error(`mandatory execution marker missing for ${command.executable} ${command.args.join(" ")}`));
        return;
      }
      resolve({ executionMarker });
    });
  });
}

async function writeRecordAtomically(filename, record) {
  const temporary = `${filename}.tmp-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
}

export async function runGrowthReleaseCli(options) {
  const backendRoot = process.cwd();
  for (const repositoryRoot of [backendRoot, options.frontendRoot]) {
    const relative = path.relative(repositoryRoot, options.recordPath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error("release record must be written outside both repository roots");
    }
  }
  const [backendSnapshot, frontendSnapshot] = await Promise.all([
    readRepositoryReleaseSnapshot(backendRoot),
    readRepositoryReleaseSnapshot(options.frontendRoot)
  ]);
  assertRepositoryReleaseSnapshotUnchanged(backendSnapshot, backendSnapshot);
  assertRepositoryReleaseSnapshotUnchanged(frontendSnapshot, frontendSnapshot);
  const consumerManifest = await readJson(path.join(
    options.frontendRoot,
    "contracts/pinned/growth-advisor-quote-roi.manifest.json"
  ));
  const producerManifest = await readProducerManifestForConsumer({
    backendRoot,
    consumerManifest
  });
  const record = await runGrowthReleaseGate({
    backendRoot,
    frontendRoot: options.frontendRoot,
    backendCommit: backendSnapshot.commit,
    frontendCommit: frontendSnapshot.commit,
    backendRollbackRef: options.backendRollbackRef,
    frontendRollbackRef: options.frontendRollbackRef,
    producerManifest,
    consumerManifest,
    now: () => new Date(),
    run: (command) => runFixedCommand(command, backendRoot)
  });
  await writeRecordAtomically(options.recordPath, record);
  const [backendAfterRecord, frontendAfterRecord] = await Promise.all([
    readRepositoryReleaseSnapshot(backendRoot),
    readRepositoryReleaseSnapshot(options.frontendRoot)
  ]);
  assertRepositoryReleaseSnapshotUnchanged(backendSnapshot, backendAfterRecord);
  assertRepositoryReleaseSnapshotUnchanged(frontendSnapshot, frontendAfterRecord);
}

export async function main(argv) {
  const options = parseExactReleaseArguments(argv);
  await runGrowthReleaseCli(options);
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));
```

Consume both exact Foundation-owned scripts. Unfiltered `test:growth-foundation` includes `growth-as-of-test.ts`'s same-clock append/old-`asOf` immutability case; a filtered or skipped Foundation clock test invalidates the release. Mandatory `test:growth-foundation:mysql` fails before tests without `MYSQL_TEST_ADMIN_URL`, proves two simultaneously checked-out physical connections have distinct `SELECT CONNECTION_ID()` values, rejects skip/zero cases, and emits `GROWTH_REAL_MYSQL foundation connections=2 tests=<positive>` only after successful assertions. Consume both Advisor-owned scripts without redefining or narrowing them: ordinary `test:growth-advisor` remains the standard behavior suite, while `test:growth-advisor:mysql` is the mandatory real-database concurrency suite with the same URL/two-connection/positive-test rules and its own Advisor marker. Add only the coordinator scripts at the root by merging this syntactically complete JSON object into the existing root `scripts` map:

Root `package.json`:

```json
{
  "scripts": {
    "test:growth-release-gate": "node --test tools/growth-dual-repo-release-gate.test.mjs",
    "release:growth": "node tools/growth-dual-repo-release-gate.mjs"
  }
}
```

Extend `acquisition-contracts.yml` to run `npm run check:growth-contracts`, then invoke `buildGrowthContractRelease({ input, releasesRoot, check: true })` in a Node step and write its returned `contractVersion` to step output `version`. Upload only `contracts/releases/growth-advisor-quote-roi/${{ steps.growth_contract_identity.outputs.version }}/openapi.json` and `manifest.json` as `growth-contract-release`; the workflow must not contain a literal version directory. The external `growth-frontend.yml` runs on pull request/push and executes install, `contract:check`, `test:growth:fixture`, `test:types`, `test`, mocked `test:e2e`, and `build`; it never downloads an unpinned latest contract.

Create `.github/workflows/growth-release.yml` with required `workflow_dispatch` inputs `frontend_repository`, `frontend_ref`, `backend_rollback_ref`, `frontend_rollback_ref`. `frontend_repository` is the explicit `owner/repository` identity of the independent consumer repository; it must not default to `${{ github.repository }}`. Check the workflow's selected backend ref into `backend-repo` with `fetch-depth: 0`, and use a second checkout with `repository: ${{ inputs.frontend_repository }}`, `ref: ${{ inputs.frontend_ref }}`, `path: frontend-repo`, `fetch-depth: 0`, and `persist-credentials: false`. Before dependency installation, explicitly assert `git rev-parse --is-shallow-repository` prints `false` in both roots; the release CLI repeats this proof before ancestry validation.

Immediately after both checkouts, verify frontend remote identity before installing or executing code. Pass the input through `env`, never interpolate it directly into the shell program:

```yaml
- name: Verify frontend checkout identity
  shell: bash
  env:
    EXPECTED_FRONTEND_REPOSITORY: ${{ inputs.frontend_repository }}
  run: |
    set -euo pipefail
    actual_url="$(git -C "$GITHUB_WORKSPACE/frontend-repo" remote get-url origin)"
    actual_repo="$(printf '%s' "$actual_url" | sed -E 's#^https://github.com/##; s#^git@github.com:##; s#\.git$##')"
    test "$actual_repo" = "$EXPECTED_FRONTEND_REPOSITORY" || {
      printf 'frontend remote mismatch: expected %s, got %s\n' "$EXPECTED_FRONTEND_REPOSITORY" "$actual_repo" >&2
      exit 1
    }
```

Then start `mysql:8.0` with root password `growth-e2e-root`, install npm/pnpm dependencies and Chromium, and run:

```bash
cd "$GITHUB_WORKSPACE/backend-repo"
npm run release:growth -- \
  --frontend-root "$GITHUB_WORKSPACE/frontend-repo" \
  --backend-rollback-ref "${{ inputs.backend_rollback_ref }}" \
  --frontend-rollback-ref "${{ inputs.frontend_rollback_ref }}" \
  --record "$GITHUB_WORKSPACE/growth-release-record.json"
```

Set workflow environment `MYSQL_TEST_ADMIN_URL=mysql://root:growth-e2e-root@127.0.0.1:3306`, `GROWTH_RELEASE_REQUIRE_MYSQL=1`, `GROWTH_E2E_TOKEN=github-actions-growth-e2e-token-20260809`, and `GOODJOB_BACKEND_ROOT=$GITHUB_WORKSPACE/backend-repo`. Foundation, Catalog, Quote, Finance, ROI, Advisor and closed-loop MySQL harnesses must treat a missing admin URL, unavailable database, lock contention, zero executed test cases, or any attempted `skip` as failure when `GROWTH_RELEASE_REQUIRE_MYSQL=1`; the coordinator records each such command with `executionMode: "real_mysql"`. Foundation and Advisor records additionally contain their exact positive two-connection `executionMarker`; missing or `tests=0` output fails before release-record creation. Upload `growth-release-record.json`, Playwright reports and traces even on failure; only the record from a fully passing run is a release authorization.

Document in `docs/operations/growth-dual-repository-release.md`: exact prerequisite commands, required inputs, how to verify the record hashes/SHAs, deployment order backend-before-frontend, feature-gate rollback order frontend-before-backend, and the prohibition on deleting or rewriting quote/ledger/closure history.

- [ ] **Step 4: Run producer, consumer and coordinated gate tests**

Run backend checks:

```bash
npm run test:growth-release-gate
npm run check:growth-contracts
npm run test:contracts
npm run test:contract-drift --workspace backend
npm run test:acquisition-openapi --workspace backend
npm run test:security --workspace backend
npm run test:growth-foundation --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-foundation:mysql --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-catalog --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-quotes --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-finance:mysql --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-roi:mysql --workspace backend
npm run test:growth-advisor --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-advisor:mysql --workspace backend
npm run test:growth:closed-loop --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth:closed-loop:mysql --workspace backend
npm run build
git diff --check
```

Run external frontend checks:

```bash
pnpm run contract:check
pnpm run test:growth:fixture
pnpm run test:types
pnpm test
pnpm run test:e2e
pnpm run test:e2e:real:guard
pnpm build
git diff --check
```

Then run the coordinated local gate with real immutable refs:

```bash
git status --porcelain=v1 -z --untracked-files=all > /tmp/growth-backend-release.status
git -C /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend status --porcelain=v1 -z --untracked-files=all > /tmp/growth-frontend-release.status
test ! -s /tmp/growth-backend-release.status
test ! -s /tmp/growth-frontend-release.status
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" \
GROWTH_RELEASE_REQUIRE_MYSQL=1 \
GROWTH_E2E_TOKEN=goodjob-growth-release-gate-token-20260809 \
GOODJOB_BACKEND_ROOT=/Users/mac/Documents/外贸/GoodJob-1.09/.worktrees/goodjob-growth-advisor-quote-roi \
npm run release:growth -- \
  --frontend-root /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend \
  --backend-rollback-ref "$(git rev-parse --verify 'HEAD^1^{commit}')" \
  --frontend-rollback-ref "$(git -C /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend rev-parse --verify 'HEAD^1^{commit}')" \
  --record /tmp/growth-release-record.json
```

If either status file is non-empty, stop before `release:growth`. In particular, the pre-existing frontend `pnpm-workspace.yaml` diff protected during implementation is not a release exception: obtain the user's decision to commit it or move it outside the working tree; never auto-stash, discard, or silently exclude it.

Expected: PASS only when producer/pinned hashes and versions are equal, both repositories begin clean and retain byte-identical HEAD/status snapshots, both release SHAs are recorded, each rollback SHA is a distinct proven ancestor in complete history, and every fixed command passes. The record must label the mandatory Foundation/Catalog/Quote/Finance/ROI/Advisor/closed-loop/browser database suites `executionMode: "real_mysql"`; ordinary Foundation and Advisor remain `standard`, while their dedicated MySQL entries must respectively record `GROWTH_REAL_MYSQL foundation connections=2 tests=<positive>` and `GROWTH_REAL_MYSQL advisor connections=2 tests=<positive>`. A skipped or zero-test MySQL suite is a failure. A mismatched pin, dirty tree, shallow clone, mutable/equal/non-ancestor rollback or missing MySQL URL stops before release authorization.

- [ ] **Step 5: Commit backend producer/coordinator and frontend consumer gates separately**

In the backend worktree:

```bash
git add tools/growth-dual-repo-release-gate.mjs tools/growth-dual-repo-release-gate.test.mjs .github/workflows/acquisition-contracts.yml .github/workflows/growth-release.yml docs/operations/growth-dual-repository-release.md package.json
git commit -m "ci(growth): add dual repository release gate"
```

In the external frontend:

```bash
git add .github/workflows/growth-frontend.yml package.json
git commit -m "ci: gate growth frontend release"
```

Do not stage `pnpm-workspace.yaml`.

## Plan Completion Gate

The backend producer must pass:

```bash
npm run check:growth-contracts
npm run test:contracts
npm run test:contract-drift --workspace backend
npm run test:acquisition-openapi --workspace backend
npm run test:security --workspace backend
npm run test:growth-foundation --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-foundation:mysql --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-catalog --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-quotes --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-finance:mysql --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-roi:mysql --workspace backend
npm run test:growth-advisor --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-advisor:mysql --workspace backend
npm run test:acquisition --workspace backend
npm run test:growth:closed-loop --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth:closed-loop:mysql --workspace backend
npm run build
git diff --check
```

The external frontend consumer must pass:

```bash
pnpm run contract:check
pnpm run test:growth:fixture
pnpm run test:types
pnpm test
pnpm run test:e2e
pnpm run test:e2e:real:guard
GOODJOB_BACKEND_ROOT=/Users/mac/Documents/外贸/GoodJob-1.09/.worktrees/goodjob-growth-advisor-quote-roi MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 GROWTH_E2E_TOKEN=goodjob-growth-real-e2e-token-20260809 pnpm run test:e2e:real
pnpm build
git diff --check
```

The release is eligible only after `release:growth` produces a record whose producer and consumer `contractVersion`/`contractHash` match, whose release SHAs equal unchanged clean HEAD snapshots, whose rollback SHAs are distinct ancestors in full history, and whose command list contains only `passed` with every mandatory database suite labeled `real_mysql`. Q0 must prove all visible/error/redaction modes—including actual Copilot session/message/task traffic—from generated typed fixtures with no network escape; Q1 must prove the real MySQL candidate → quote → approval → PI/CRM → won/payment/cost → allocation/Closure → actual ROI → Advisor Todo chain without browser interception, demo fallback, duplicate authority or outbound action.

---
