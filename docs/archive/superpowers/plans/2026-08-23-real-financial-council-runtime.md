# 真实财务多智能体闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让黑色 `#agents` 智能体中心基于真实 MySQL、已验证的三张财务报表和按角色路由的真实模型连接，完成五专家分析、审计反驳、CFO 共识、三组合优化、人工审批与内部草稿派发的可恢复闭环。

**Architecture:** 保留现有 TypeScript Financial Council、Growth Foundation、Finance Import、verified ledger、模型连接中心和审批 outbox，不引入 Python 智能体运行时。新增工作区版本化模型路由策略，将选中连接和每次 fallback attempt 冻结进现有 AI job snapshot；将三张报表预览确认为不可变 statement package，再由服务端从该权威版本创建 run。前端继续使用唯一黑色壳，仅消费 closed API 投影，不重算金额、分数、组合或权限。

**Tech Stack:** Node.js `>=22.19.0`、TypeScript、Express、MySQL 8.4.11 (`127.0.0.1:3307`)、Zod、JSON Schema 2020-12、OpenAPI 3.1、vanilla TypeScript/Vite、Playwright、Node test runner、现有 OpenAI-compatible adapters。

**Spec:** `docs/superpowers/specs/2026-08-23-real-financial-council-runtime-design.md`

## Global Constraints

- 执行前必须先读本计划和对应 Spec；以现有 Financial Council 为唯一编排运行时，禁止引入 CrewAI、AutoGen、LangGraph 或第二个 Python 服务。
- 本地真实模式固定使用 MySQL `127.0.0.1:3307`；`CRM_STORE=mysql` 且数据库不可用时必须启动失败，不得回退 Memory。
- 数据库、模型 API Key、加密主密钥和真实供应商响应正文不得写入 Git、测试快照、日志或聊天。
- 所有工作区、owner、actor、team、capability、CSRF、idempotency 和 ETag 由服务端 session/middleware 解析；浏览器不得自报权威身份。
- 一个角色每次只调用一个主连接；仅可重试 provider 失败才可按有序 fallback 进入新 attempt，最多 `1 + 2` 个连接，禁止所有供应商 fan-out 投票。
- 路由评分是服务端确定性函数：结构化输出为硬门槛，使用同角色最近 30 次成功率、P95 延迟、已知成本、连续失败惩罚和管理员偏好；同分使用 connection ID UTF-8 二进制顺序打破平局。
- 三张必需报表是资产负债表、利润表、现金流量表；缺任一张不得产生可审批 run，不得补零或用示例数据代替。
- 原始 Excel 不长期保存；只保存文件哈希、来源元数据、解析器版本、标准化结果和不可变数据版本。
- 首次向第三方模型发送标准化财务数据前必须记录人工同意；模型只获得角色所需的最小投影。
- 模型不是金额、公式、硬约束、权限、审批和组合分数的权威。所有模型输出必须 closed-schema 解析并通过现有 formula/evidence/action projector。
- 人工审批只生成内部草稿、待办和 receipt，禁止付款、报税、记账、外部消息或第三方系统写入。
- 必须保留现有 lease token、attempt、严格过期边界、原子事务、不可变哈希和 Memory/MySQL parity；迟到的旧 attempt 不得提交。
- 公开 DTO 必须 closed schema 且版本化；更改同步 runtime validator、JSON Schema、OpenAPI、生成前端类型、漂移测试和不可变 Growth release。
- 黑色 `#agents` 为唯一默认首页；不恢复旧白色 CRM，不创建第二个 shell，不新增通用后台管理系统。
- 最终真实验收要求 MySQL 真实连接、至少两个不同模型供应商、无 `page.route/route.fulfill` 的 Chromium 流程；缺密钥或数据库凭据时必须报 BLOCKED，不得记为 PASS。
- 每个 Task 收尾时检查根 README、`backend/src/business-advisor/README.md`、`frontend/README.md`、环境示例、合同文档和当前状态文档；公开行为变化必须同步，纯内部重构要在交付中明确说明无需更新。

---

## Planned File Map

| 责任 | 主文件 | 不可替代的边界 |
| --- | --- | --- |
| 真实本地启动 | `backend/scripts/local-real-runtime.ts`, `backend/scripts/setup-local-mysql.ts`, `tools/start-real-local.mjs` | 纯配置校验与子进程生命周期；不包含真实密码 |
| 模型路由领域 | `backend/src/financial-council-model-routing.ts` | closed 策略、确定性评分、attempt 选择 |
| 模型路由持久化 | `backend/src/financial-council-model-routing-repository.ts`, `backend/src/financial-council-model-routing-mysql-repository.ts` | workspace/version/revision/idempotency 与 Memory/MySQL parity |
| 路由服务/API | `backend/src/financial-council-model-routing-service.ts`, `backend/src/financial-council-model-routing-router.ts` | capability、ETag、预览不调用模型 |
| 模型调用接线 | `backend/src/financial-council-routed-model-port.ts` | 主连接 + 有序 fallback，每次冻结 official snapshot |
| 三表权威版本 | `backend/src/financial-statement-package.ts`, `backend/src/financial-statement-package-repository.ts`, `backend/src/financial-statement-package-mysql-repository.ts` | 预览零写入、确认后不可变 package，不保存原文件 |
| 三表服务/API | `backend/src/financial-statement-package-service.ts`, `backend/src/financial-statement-package-router.ts` | 安全解析、勾稽、consent、从 package 创建 run |
| 智能体状态投影 | `backend/src/financial-council-agent-center.ts`, `backend/src/financial-council-agent-center-router.ts` | 卡牌/readiness/run/binding 脱敏投影，不泄露 prompt 和正文 |
| 前端真实控制 | `frontend/src/growth/agents/real-api.ts`, `frontend/src/growth/agents/real-controller.ts` | 请求 generation、同义 idempotency key、旧响应隔离 |
| 黑色智能体 UI | `frontend/src/growth/agents/view.ts`, `frontend/src/demo/demo-app.ts`, `frontend/src/growth/council/*` | 一个 shell、三表上传、路由、进度、结果、审批、receipt |
| 真实验收 | `backend/src/financial-council-real-runtime-integration-test.ts`, `frontend/tests/financial-council-real-runtime.spec.ts` | 真实 MySQL、真实 session/CSRF、无 route interception、显式 live-provider gate |

---

### Task 1: 建立可重复的真实本地运行入口

**Files:**
- Create: `backend/scripts/local-real-runtime.ts`
- Create: `backend/scripts/local-real-runtime-test.ts`
- Create: `backend/scripts/setup-local-mysql.ts`
- Create: `tools/start-real-local.mjs`
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `backend/package.json`
- Modify: `package.json`
- Modify: `backend/src/server.ts`
- Modify: `backend/src/server-shutdown-lifecycle-test.ts`
- Modify: `frontend/src/app-session.ts`
- Modify: `frontend/src/app-session.self-test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces `readLocalRealRuntimeConfig(env)` returning only validated non-secret topology and booleans; secret values remain in `process.env` and are never returned, formatted or logged.
- Produces `pnpm setup:mysql:local` that requires `MYSQL_LOCAL_ADMIN_URL` and `SHENSI_MYSQL_APP_PASSWORD`, creates only database `shensi_sales` and user `shensi_sales_app@127.0.0.1`, and grants only database-scoped `SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,INDEX,REFERENCES`.
- Produces `pnpm dev:real` that loads ignored `.env.real.local`, starts backend `127.0.0.1:4188` with `CRM_STORE=mysql`, and starts frontend with `VITE_API_TARGET=http://127.0.0.1:4188`.
- Real app bootstrap advertises exactly `catalog,quotes,finance,roi,advisor`; authentication state publishes `document.body.dataset.sessionMode = "real" | "demo"`.

- [ ] **Step 1: Write the configuration and fail-closed server RED tests.**

```ts
test("real local config is fixed to loopback mysql 3307 and never returns secrets", () => {
  const config = readLocalRealRuntimeConfig({
    CRM_STORE: "mysql",
    DATABASE_URL: "mysql://shensi_sales_app:secret@127.0.0.1:3307/shensi_sales",
    JWT_SECRET: "x".repeat(32),
    PROVIDER_CREDENTIAL_SECRET: "y".repeat(32)
  });
  assert.deepEqual(config, {
    mysqlHost: "127.0.0.1",
    mysqlPort: 3307,
    mysqlDatabase: "shensi_sales",
    backendOrigin: "http://127.0.0.1:4188",
    frontendOrigin: "http://127.0.0.1:5188"
  });
  assert.equal(JSON.stringify(config).includes("secret"), false);
});

test("real mode refuses memory and non-loopback mysql", () => {
  assert.throws(() => readLocalRealRuntimeConfig({ CRM_STORE: "memory" }),
    /REAL_RUNTIME_REQUIRES_MYSQL/u);
  assert.throws(() => readLocalRealRuntimeConfig({
    CRM_STORE: "mysql",
    DATABASE_URL: "mysql://app:x@example.com:3307/shensi_sales"
  }), /REAL_RUNTIME_MYSQL_TOPOLOGY_INVALID/u);
});
```

Add a lifecycle assertion that `enabledFeatures` returns all five current Growth features rather than only `catalog`, and an app-session assertion that a configured API target publishes `sessionMode="real"` and never calls `createDemoAdmin()`.

- [ ] **Step 2: Run the focused tests and prove RED.**

```bash
cd /Users/mac/Documents/新项目/shensi-sales/.worktrees/agent-center-shell
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  scripts/local-real-runtime-test.ts \
  src/server-shutdown-lifecycle-test.ts
pnpm --filter ./frontend exec tsx src/app-session.self-test.ts
```

Expected: `ERR_MODULE_NOT_FOUND` for `local-real-runtime.js`; server feature assertion reports `catalog` only; app-session has no `sessionMode` projection.

- [ ] **Step 3: Implement the pure config parser and MySQL provisioning command.**

```ts
export interface LocalRealRuntimeConfig {
  readonly mysqlHost: "127.0.0.1";
  readonly mysqlPort: 3307;
  readonly mysqlDatabase: "shensi_sales";
  readonly backendOrigin: "http://127.0.0.1:4188";
  readonly frontendOrigin: "http://127.0.0.1:5188";
}

export function readLocalRealRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>
): LocalRealRuntimeConfig;
```

`setup-local-mysql.ts` must parse the admin URL without logging it, connect with `mysql2/promise`, execute fixed identifier SQL (no interpolated user-provided identifier), parameterize the password, verify `SELECT CURRENT_USER(), DATABASE()` on a second app connection, and close both pools in `finally`. Refuse an empty password, a remote host, a port other than `3307`, or a database/user name different from the constants above.

- [ ] **Step 4: Implement the process supervisor and real feature/session wiring.**

```js
const children = [
  spawn("pnpm", ["--filter", "./backend", "dev"], { env: backendEnv }),
  spawn("pnpm", ["--filter", "./frontend", "dev", "--", "--host", "127.0.0.1", "--port", "5188"], {
    env: { ...baseEnv, VITE_API_TARGET: "http://127.0.0.1:4188" }
  })
];
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => children.forEach((child) => child.kill(signal)));
}
```

Use Node `--env-file-if-exists=.env.real.local`; do not implement a custom secret-printing dotenv parser. In `server.ts`, return all current `GROWTH_FEATURES` for an authenticated concrete workspace. In `app-session.ts`, set and clear `body.dataset.sessionMode` together with authentication state.

- [ ] **Step 5: Verify config, lifecycle, type/build and secret hygiene.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  scripts/local-real-runtime-test.ts \
  src/server-shutdown-lifecycle-test.ts
pnpm --filter ./frontend exec tsx src/app-session.self-test.ts
pnpm --filter ./backend build
pnpm --filter ./frontend test:types
rg -n 'MYSQL_LOCAL_ADMIN_URL=.+|SHENSI_MYSQL_APP_PASSWORD=.+' . \
  -g '!node_modules' -g '!.git' && exit 1 || true
git diff --check
```

Expected: tests/build pass; the secret scan prints nothing. Then run provisioning using local ignored environment values and verify only safe metadata:

```bash
pnpm setup:mysql:local
pnpm dev:real
curl --fail --silent http://127.0.0.1:4188/api/health
```

Expected: backend logs MySQL persistence without printing credentials; frontend is reachable at `http://127.0.0.1:5188/#agents` and login uses `/api/auth/login`.

- [ ] **Step 6: Update docs and commit.**

Document `.env.real.local` variable names, port `3307`, least-privilege provisioning, start/stop commands, and the rule that credentials are entered locally and never pasted into chat.

```bash
git add .env.example .gitignore package.json README.md \
  backend/package.json backend/scripts \
  backend/src/server.ts backend/src/server-shutdown-lifecycle-test.ts \
  frontend/src/app-session.ts frontend/src/app-session.self-test.ts \
  tools/start-real-local.mjs
git commit -m "feat(runtime): start shensi sales with real mysql"
```

---

### Task 2: 实现工作区模型路由策略、评分与 Memory/MySQL 持久化

**Files:**
- Create: `backend/src/financial-council-model-routing.ts`
- Create: `backend/src/financial-council-model-routing-test.ts`
- Create: `backend/src/financial-council-model-routing-repository.ts`
- Create: `backend/src/financial-council-model-routing-repository-contract-test.ts`
- Create: `backend/src/financial-council-model-routing-repository-test.ts`
- Create: `backend/src/financial-council-model-routing-mysql-repository.ts`
- Create: `backend/src/financial-council-model-routing-mysql-repository-test.ts`
- Modify: `backend/src/model-providers/call-ledger.ts`
- Modify: `backend/src/model-providers/runtime.ts`
- Modify: `backend/src/growth-financial-council-module.ts`
- Modify: `backend/src/growth-financial-council-module-test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes existing `ModelConnection`, `ModelCallRecord`, `MODEL_PROVIDER_IDS`, official capability certification and active workspace context.
- Produces `FinancialCouncilModelRoutingPolicyInput`, `FinancialCouncilModelRoutingPolicyVersion`, `FinancialCouncilModelRoutePreview`, and `selectFinancialCouncilModelRoute(input)`.
- Produces `FinancialCouncilModelRoutingRepository.getCurrent/getVersion/put` with exact replay and optimistic revision behavior in Memory and MySQL.
- Policy roles are exactly `cfo|finance|profit|cost|cashflow|tax`; each role is `{mode:"auto"|"pinned",primaryConnectionId:string|null,fallbackConnectionIds:readonly string[]}` with at most two unique fallbacks and no primary duplication.

- [ ] **Step 1: Write domain/scoring RED tests.**

```ts
test("auto routing is deterministic and excludes uncertified connections", () => {
  const result = selectFinancialCouncilModelRoute({
    role: "cashflow",
    policy: policy({
      roles: {
        ...defaultRoles(),
        cashflow: {
          mode: "auto",
          primaryConnectionId: null,
          fallbackConnectionIds: []
        }
      }
    }),
    connections: [
      connection("b", { structuredOutput: true }),
      connection("a", { structuredOutput: true }),
      connection("x", { structuredOutput: false })
    ],
    recentCalls: [],
    prices: []
  });
  assert.deepEqual(result.orderedConnectionIds, ["a", "b"]);
  assert.deepEqual(result.reasonCodes, [
    "structured_output_certified", "cost_unknown", "stable_tiebreak"
  ]);
});

test("pinned routing keeps one primary and no more than two fallbacks", () => {
  assert.throws(() => normalizeFinancialCouncilModelRoutingPolicyInput({
    ...routingInput(),
    roles: {
      ...routingInput().roles,
      finance: {
        mode: "pinned",
        primaryConnectionId: "model-a",
        fallbackConnectionIds: ["model-a", "model-b", "model-c"]
      }
    }
  }), hasCode("financial_council_model_routing_invalid"));
});
```

Cover cross-workspace connections, inactive/disabled credentials, structured-output false, 30-call window, success rate, P95, known/unknown cost, consecutive failure penalty, role preference weight, stable UTF-8 ordering, amount/timeout safe-integer bounds, open objects, duplicate array entries and deep immutability.

- [ ] **Step 2: Write shared repository RED tests before production files exist.**

```ts
registerFinancialCouncilModelRoutingRepositoryContract("memory", () =>
  new InMemoryFinancialCouncilModelRoutingRepository());
registerFinancialCouncilModelRoutingRepositoryContract("mysql", () =>
  mysqlHarness.repository);
```

The contract must prove no current policy, revision-1 creation, exact idempotent replay, changed request conflict, If-Match winner, workspace isolation, historical version load, open JSON rejection, hash mismatch rejection, transaction rollback and stable current pointer.

- [ ] **Step 3: Run and prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-model-routing-test.ts \
  src/financial-council-model-routing-repository-test.ts \
  src/financial-council-model-routing-mysql-repository-test.ts
```

Expected: three file loads fail with `ERR_MODULE_NOT_FOUND` for the new routing modules.

- [ ] **Step 4: Implement the closed domain and deterministic scorer.**

```ts
export type FinancialCouncilModelRole =
  | "cfo" | "finance" | "profit" | "cost" | "cashflow" | "tax";

export interface FinancialCouncilRoleRoute {
  readonly mode: "auto" | "pinned";
  readonly primaryConnectionId: string | null;
  readonly fallbackConnectionIds: readonly string[];
  readonly preferenceWeightBps: number;
}

export interface FinancialCouncilModelRoutingPolicyVersion {
  readonly policyVersionId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly status: "active" | "superseded";
  readonly roles: Readonly<
    Record<FinancialCouncilModelRole, FinancialCouncilRoleRoute>
  >;
  readonly maxRunBudgetMinor: number;
  readonly maxRoleBudgetMinor: number;
  readonly requestTimeoutMs: number;
  readonly policyHash: `sha256:${string}`;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface FinancialCouncilModelRoutePreview {
  readonly role: FinancialCouncilModelRole;
  readonly orderedConnectionIds: readonly string[];
  readonly selectedConnectionId: string | null;
  readonly reasonCodes: readonly string[];
  readonly missingCapabilities: readonly string[];
}
```

Do not add a second performance table: derive the bounded last-30 role window from durable `ModelCallRecord.jobId`, but add and use a strict parser for only canonical `financial-council:<runId>:<role>:<phase>:<attempt>` IDs. Invalid/legacy job IDs do not enter role statistics.

- [ ] **Step 5: Implement Memory/MySQL repositories and schema lifecycle.**

Create exactly:

```sql
financial_council_model_routing_policies
financial_council_model_routing_idempotency
```

The policy table primary key is `(workspace_id, policy_version_id)`, has unique `(workspace_id, revision)`, canonical JSON/hash, status and actor/timestamps. The idempotency table binds `(workspace_id, actor_id, key_hash)` to request hash and exact response. Use a named schema lock, `VARCHAR`/ASCII widths matching runtime limits, closed status checks, one transaction for old-current supersede + new-current insert + idempotency response, and no destructive down migration.

- [ ] **Step 6: Wire repositories as private Financial Council resources and verify GREEN.**

`createGrowthFinancialCouncilResources` must create Memory/MySQL routing repositories from the same mode/pool and expose them only through the trusted Financial Council resource object; no global singleton.

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-model-routing-test.ts \
  src/financial-council-model-routing-repository-test.ts \
  src/financial-council-model-routing-mysql-repository-test.ts \
  src/growth-financial-council-module-test.ts
npm run build --workspace backend
git diff --check
```

- [ ] **Step 7: Commit the routing domain slice.**

No public API has changed yet; update the Financial Council current status document, and state that README/OpenAPI are intentionally unchanged until Task 5 exposes the surface.

```bash
git add backend/src/financial-council-model-routing* \
  backend/src/model-providers/call-ledger.ts \
  backend/src/model-providers/runtime.ts \
  backend/src/growth-financial-council-module.ts \
  backend/src/growth-financial-council-module-test.ts backend/package.json
git commit -m "feat(finance): persist council model routing policies"
```

---

### Task 3: 将路由策略和有序 fallback 接入真实模型网关

**Files:**
- Create: `backend/src/financial-council-routed-model-port.ts`
- Create: `backend/src/financial-council-routed-model-port-test.ts`
- Create: `backend/src/financial-council-model-selection.ts`
- Create: `backend/src/financial-council-model-selection-test.ts`
- Modify: `backend/src/financial-council-model-port.ts`
- Modify: `backend/src/financial-council-model-gateway.ts`
- Modify: `backend/src/financial-council-model-gateway-test.ts`
- Modify: `backend/src/financial-council-specialists.ts`
- Modify: `backend/src/financial-council-specialists-test.ts`
- Modify: `backend/src/financial-council-cfo.ts`
- Modify: `backend/src/financial-council-cfo-test.ts`
- Modify: `backend/src/financial-council-domain.ts`
- Modify: `backend/src/financial-council-domain-test.ts`
- Modify: `backend/src/financial-council-repository.ts`
- Modify: `backend/src/financial-council-repository-contract-test.ts`
- Modify: `backend/src/financial-council-mysql-repository.ts`
- Modify: `backend/src/financial-council-mysql-repository-test.ts`
- Modify: `backend/src/financial-council-service.ts`
- Modify: `backend/src/financial-council-service-test.ts`
- Modify: `backend/src/growth-financial-council-module.ts`
- Modify: `backend/src/growth-financial-council-module-test.ts`

**Interfaces:**
- `FinancialCouncilRun` gains internal required `modelRoutingPolicyVersionId`; public run projection does not expose credentials or routing internals.
- `FinancialCouncilModelSelectionPort.resolve(input)` returns the exact policy version, ordered eligible connections and reason codes for `(workspace,run,role,phase)`.
- `RoutedFinancialCouncilModelPort` creates attempts 1..3. It retries only `FinancialCouncilModelError.retryable === true` with codes timeout/rate-limit/transient provider unavailable; business/schema/auth/input/snapshot errors stop immediately.
- `ActiveModelGatewayFinancialCouncilModelPort` accepts an exact connection resolver and binds through existing durable `bindModelConnectionSnapshot`; every returned binding includes `routingPolicyVersionId` and `routeReasonCodes`, never API keys.

- [ ] **Step 1: Write selection and fallback RED tests.**

```ts
test("retryable primary failure uses one frozen fallback attempt", async () => {
  const result = await port.analyze(analyzeInput({ attempt: 1 }));
  assert.equal(result.binding.connectionId, "fallback-b");
  assert.equal(result.binding.attempt, 2);
  assert.deepEqual(calls, [
    { connectionId: "primary-a", attempt: 1 },
    { connectionId: "fallback-b", attempt: 2 }
  ]);
  assert.equal(snapshotStore.aiJobModelSnapshots.length, 2);
});

test("invalid model output never jumps providers", async () => {
  await assert.rejects(() => port.analyze(analyzeInput()),
    hasCode("financial_council_model_output_invalid"));
  assert.equal(calls.length, 1);
});
```

Also cover auth failure, missing structured output, exhausted role budget, max three attempts, duplicated fallback elimination, late attempt-1 completion after attempt-2 success, process restart reusing an existing exact job snapshot, changed content conflict and connection removed after run creation.

- [ ] **Step 2: Write run/repository binding RED tests.**

Add shared Memory/MySQL cases proving create freezes the then-current routing policy version, replay retains it after a new policy becomes current, tampered version/hash fails reads, and analysis cannot start when the frozen version is missing.

- [ ] **Step 3: Run and prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-routed-model-port-test.ts \
  src/financial-council-model-selection-test.ts \
  src/financial-council-model-gateway-test.ts \
  src/financial-council-service-test.ts \
  src/financial-council-repository-test.ts \
  src/financial-council-mysql-repository-test.ts
```

Expected: routed port/selection modules are absent and the existing run does not contain a model routing policy binding.

- [ ] **Step 4: Implement exact selection and binding.**

```ts
export interface FinancialCouncilModelSelection {
  readonly routingPolicyVersionId: string;
  readonly role: FinancialCouncilModelRole;
  readonly phase: FinancialCouncilModelPhase;
  readonly orderedConnectionIds: readonly string[];
  readonly reasonCodes: readonly string[];
}

export interface FinancialCouncilModelSelectionPort {
  resolve(input: {
    ownerId: string;
    teamId: string;
    runId: string;
    role: FinancialCouncilModelRole;
    phase: FinancialCouncilModelPhase;
  }): Promise<FinancialCouncilModelSelection>;
}

export interface FinancialCouncilAttemptModelPort {
  analyze(
    input: FinancialCouncilAnalyzeInput,
    route: {
      readonly connectionId: string;
      readonly routingPolicyVersionId: string;
      readonly reasonCodes: readonly string[];
    }
  ): Promise<FinancialCouncilModelResult<FinancialCouncilAnalyzeOutput>>;
}

export interface FinancialCouncilAttemptFence {
  assertCurrent(input: {
    readonly runId: string;
    readonly role: FinancialCouncilModelRole;
    readonly attempt: number;
  }): Promise<void>;
}
```

The selection service must load the run in the authenticated workspace, load its exact historical routing policy, filter current connection eligibility without changing policy order, and fail `not_computable:model_connection_unavailable` before any provider call if no eligible route remains.

- [ ] **Step 5: Implement the fallback wrapper with post-await authorization.**

```ts
for (const [index, connectionId] of
  selection.orderedConnectionIds.slice(0, 3).entries()) {
  const attempt = index + 1;
  try {
    const result = await delegate.analyze({ ...input, attempt }, {
      connectionId,
      routingPolicyVersionId: selection.routingPolicyVersionId,
      reasonCodes: selection.reasonCodes
    });
    await fence.assertCurrent({ runId: input.runId, role: input.role, attempt });
    return result;
  } catch (error) {
    await fence.assertCurrent({ runId: input.runId, role: input.role, attempt });
    if (!isRetryableProviderFailure(error) || attempt === 3) throw error;
  }
}
```

Do not catch validation errors as transport failures. Persist each failed call ledger record before moving to the next attempt; if ledger persistence fails, stop and return `financial_council_model_ledger_persistence_failed` rather than calling another provider.

- [ ] **Step 6: Add MySQL schema compatibility for the run binding.**

Add `model_routing_policy_version_id VARCHAR(255) ASCII NOT NULL` to new rows and an existing-table migration under the Financial Council schema lock. Legacy rows receive one explicit `legacy-unroutable` sentinel and must fail closed if analysis is attempted; do not silently bind them to the current policy.

- [ ] **Step 7: Verify focused, aggregate and build gates.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-routed-model-port-test.ts \
  src/financial-council-model-selection-test.ts \
  src/financial-council-model-gateway-test.ts \
  src/financial-council-specialists-test.ts \
  src/financial-council-cfo-test.ts \
  src/financial-council-service-test.ts \
  src/financial-council-repository-test.ts \
  src/financial-council-mysql-repository-test.ts \
  src/growth-financial-council-module-test.ts
pnpm test:financial-council
pnpm --filter ./backend test:financial-council:mysql
pnpm --filter ./backend build
git diff --check
```

The live MySQL cases may report the existing explicit environment skip only before Task 8; fake/MySQL parser/transaction tests must all pass.

- [ ] **Step 8: Commit the routed model slice.**

```bash
git add backend/src/financial-council-routed-model-port* \
  backend/src/financial-council-model-selection* \
  backend/src/financial-council-model-port.ts \
  backend/src/financial-council-model-gateway* \
  backend/src/financial-council-specialists* \
  backend/src/financial-council-cfo* \
  backend/src/financial-council-domain* \
  backend/src/financial-council-repository* \
  backend/src/financial-council-mysql-repository* \
  backend/src/financial-council-service* \
  backend/src/growth-financial-council-module*
git commit -m "feat(finance): route council roles across model providers"
```

---

### Task 4: 将三张财务报表确认为不可变权威数据版本

**Files:**
- Create: `backend/src/financial-statement-package.ts`
- Create: `backend/src/financial-statement-package-test.ts`
- Create: `backend/src/financial-statement-package-repository.ts`
- Create: `backend/src/financial-statement-package-repository-contract-test.ts`
- Create: `backend/src/financial-statement-package-repository-test.ts`
- Create: `backend/src/financial-statement-package-mysql-repository.ts`
- Create: `backend/src/financial-statement-package-mysql-repository-test.ts`
- Create: `backend/src/financial-statement-package-service.ts`
- Create: `backend/src/financial-statement-package-service-test.ts`
- Modify: `backend/src/business-advisor/domain.ts`
- Modify: `backend/src/business-advisor/domain-test.ts`
- Modify: `backend/src/business-advisor/statement-import.ts`
- Modify: `backend/src/business-advisor/statement-import-test.ts`
- Modify: `backend/src/finance-import-repository.ts`
- Modify: `backend/src/finance-import-service.ts`
- Modify: `backend/src/finance-import-service-test.ts`
- Modify: `backend/src/financial-council-snapshot.ts`
- Modify: `backend/src/financial-council-snapshot-test.ts`
- Modify: `backend/src/financial-council-domain.ts`
- Modify: `backend/src/financial-council-domain-test.ts`
- Modify: `backend/src/financial-council-repository.ts`
- Modify: `backend/src/financial-council-repository-contract-test.ts`
- Modify: `backend/src/financial-council-mysql-repository.ts`
- Modify: `backend/src/financial-council-mysql-repository-test.ts`
- Modify: `backend/src/financial-council-service.ts`
- Modify: `backend/src/financial-council-service-test.ts`
- Modify: `backend/src/growth-finance-module.ts`
- Create: `backend/src/growth-finance-module-test.ts`
- Modify: `backend/src/growth-financial-council-module.ts`
- Modify: `backend/package.json`
- Modify: `backend/src/business-advisor/README.md`

**Interfaces:**
- Produces `FinancialStatementPackagePreview`, `FinancialStatementPackage`, `FinancialStatementPackageRepository`, and `FinancialStatementPackageService.preview/commit/getVerified`.
- A package contains exactly one normalized balance sheet, income statement and cash-flow statement for one company/currency/period, three server-computed file hashes, parser version, canonical `BusinessReportInput`, report input hash, warnings, consent audit and immutable package hash.
- Preview writes only an expiring, non-authoritative preview record; it creates no ledger fact, verified package or council run. Commit is idempotent and atomically stores the package. Raw workbook bytes are not retained.
- Produces `FinancialCouncilService.createRunFromStatementPackage(command,{statementPackageId,policyVersionId})`; the service loads verified package data server-side and calls the existing internal run creation path.

- [ ] **Step 1: Add cash-flow parser and package-domain RED tests.**

```ts
test("a package requires all three statements for the same company period", () => {
  assert.throws(() => normalizeFinancialStatementPackage({
    balanceSheet: balanceFixture(),
    incomeStatement: incomeFixture(),
    cashFlowStatement: null
  }), hasCode("financial_statement_cashflow_required"));
});

test("cash flow is parsed, balanced and never synthesized as zero", () => {
  const parsed = parseStatementPackage(
    balanceWorkbook(), incomeWorkbook(), cashFlowWorkbook());
  assert.equal(parsed.input.cashFlow.openingCashMinor, 1_000_000);
  assert.equal(parsed.input.cashFlow.operatingInflowMinor, 5_000_000);
  assert.equal(parsed.input.cashFlow.operatingOutflowMinor, 4_100_000);
  assert.equal(parsed.input.cashFlow.investingNetMinor, -200_000);
  assert.equal(parsed.input.cashFlow.financingNetMinor, 50_000);
});
```

Cover formula cells, macros/external links, zip bombs/size limits, duplicate sheets, currency mismatch, company mismatch, period mismatch, unsafe integers, accounting equation, cash reconciliation, open JSON, parser version and Unicode/company-name bounds.

- [ ] **Step 2: Add repository/service RED tests.**

The shared Memory/MySQL contract must prove preview creates no committed row, commit exact replay, changed content conflict, cross-workspace denial, hash tamper, raw bytes absent, consent required, rollback after package insert, and server reload after restart.

```ts
test("run creation reloads the verified package instead of trusting browser report", async () => {
  const run = await service.createRunFromStatementPackage(command(), {
    statementPackageId: committed.packageId,
    policyVersionId: policy.policyVersionId
  });
  assert.deepEqual(run.businessReport, committed.businessReport);
  assert.equal(run.statementPackageId, committed.packageId);
  assert.equal(run.statementPackageHash, committed.packageHash);
});
```

- [ ] **Step 3: Run and prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-statement-package-test.ts \
  src/financial-statement-package-repository-test.ts \
  src/financial-statement-package-mysql-repository-test.ts \
  src/financial-statement-package-service-test.ts \
  src/business-advisor/statement-import-test.ts \
  src/financial-council-snapshot-test.ts \
  src/financial-council-service-test.ts
```

Expected: new package modules are absent; the current parser accepts two-statement input and returns missing cash flow.

- [ ] **Step 4: Implement the three-statement parser and immutable package.**

```ts
export interface FinancialStatementPackage {
  readonly packageId: string;
  readonly workspaceId: string;
  readonly status: "verified";
  readonly companyName: string;
  readonly currency: "CNY" | "USD";
  readonly period: string;
  readonly sourceFiles: readonly [
    FinancialStatementSource<"balance_sheet">,
    FinancialStatementSource<"income_statement">,
    FinancialStatementSource<"cash_flow_statement">
  ];
  readonly parserVersion: "financial-statements.v2";
  readonly businessReport: BusinessReportInput;
  readonly reportInputHash: `sha256:${string}`;
  readonly warnings: readonly FinancialStatementWarning[];
  readonly consent: FinancialModelDataConsent;
  readonly packageHash: `sha256:${string}`;
  readonly createdAt: string;
}
```

The referenced closed types are:

```ts
export type FinancialStatementKind =
  | "balance_sheet" | "income_statement" | "cash_flow_statement";

export interface FinancialStatementSource<Kind extends FinancialStatementKind> {
  readonly kind: Kind;
  readonly fileName: string;
  readonly fileHash: `sha256:${string}`;
  readonly mediaType:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  readonly sheetNames: readonly string[];
}

export interface FinancialStatementWarning {
  readonly code: string;
  readonly statement: FinancialStatementKind;
  readonly row: number | null;
  readonly field: string | null;
}

export interface FinancialModelDataConsent {
  readonly accepted: true;
  readonly noticeVersion: "financial-model-data.v1";
  readonly acceptedBy: string;
  readonly acceptedAt: string;
}

export interface FinancialStatementUpload<Kind extends FinancialStatementKind> {
  readonly kind: Kind;
  readonly fileName: string;
  readonly mediaType:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  readonly contentBase64: string;
}
```

Server parsing reuses `secure-spreadsheet-artifact.ts`; the stored source entry contains only `{kind,fileName,fileHash,mediaType,sheetNames}`. Explicitly exclude `content`, `contentBase64`, workbook buffers and raw cells from the persisted allowlist.

- [ ] **Step 5: Implement repositories and one atomic commit.**

Create exactly:

```sql
financial_statement_package_previews
financial_statement_packages
financial_statement_package_idempotency
```

Previews may retain normalized parsed JSON until expiry but not workbook bytes. A commit transaction locks the preview, verifies it is unexpired/uncommitted, writes the package and idempotency response, and marks the preview committed. A cleanup method deletes expired previews only; it never deletes committed packages.

- [ ] **Step 6: Bind snapshots/runs to the package.**

Add internal required `statementPackageId` and `statementPackageHash` to new Financial Council runs and snapshots. Existing legacy tests may construct a trusted package fixture, but the public real-upload route in Task 5 must never accept an arbitrary business report. Snapshot source refs include `{kind:"financial_statement_package",sourceId,sourceVersion:"financial-statements.v2",snapshotHash:packageHash}`.

- [ ] **Step 7: Verify focused/parity gates.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-statement-package-test.ts \
  src/financial-statement-package-repository-test.ts \
  src/financial-statement-package-mysql-repository-test.ts \
  src/financial-statement-package-service-test.ts \
  src/business-advisor/domain-test.ts \
  src/business-advisor/statement-import-test.ts \
  src/finance-import-service-test.ts \
  src/financial-council-snapshot-test.ts \
  src/financial-council-service-test.ts \
  src/growth-finance-module-test.ts \
  src/growth-financial-council-module-test.ts
pnpm --filter ./backend test:growth-finance:imports
pnpm test:financial-council
pnpm --filter ./backend build
git diff --check
```

- [ ] **Step 8: Commit the verified statement slice.**

Update `backend/src/business-advisor/README.md` so the current required input is three statements and a missing cash-flow statement is not silently diagnosed as complete.

```bash
git add backend/src/financial-statement-package* \
  backend/src/business-advisor backend/src/finance-import-* \
  backend/src/financial-council-{snapshot,domain,repository,mysql-repository,service}* \
  backend/src/growth-finance-module* \
  backend/src/growth-financial-council-module.ts \
  backend/package.json
git commit -m "feat(finance): verify three-statement data packages"
```

---

### Task 5: 暴露 closed 路由、三表与智能体状态 API，并发布 Growth 合同

**Files:**
- Create: `backend/src/financial-council-model-routing-service.ts`
- Create: `backend/src/financial-council-model-routing-service-test.ts`
- Create: `backend/src/financial-council-model-routing-router.ts`
- Create: `backend/src/financial-council-model-routing-router-test.ts`
- Create: `backend/src/financial-statement-package-router.ts`
- Create: `backend/src/financial-statement-package-router-test.ts`
- Create: `backend/src/financial-council-agent-center.ts`
- Create: `backend/src/financial-council-agent-center-test.ts`
- Create: `backend/src/financial-council-agent-center-router.ts`
- Create: `backend/src/financial-council-agent-center-router-test.ts`
- Modify: `backend/src/financial-council-router.ts`
- Modify: `backend/src/financial-council-router-test.ts`
- Modify: `backend/src/growth-financial-council-module.ts`
- Modify: `backend/src/growth-financial-council-module-test.ts`
- Modify: `backend/src/growth-commercial-composition.ts`
- Modify: `backend/src/growth-commercial-composition-test.ts`
- Modify: `contracts/json-schema/financial-council.v1.schema.json`
- Modify: `contracts/json-schema/finance-import-operation.v1.schema.json`
- Modify: `contracts/openapi/growth-advisor-quote-roi.v1.yaml`
- Create: `contracts/releases/growth-advisor-quote-roi/1.0.11/openapi.json`
- Create: `contracts/releases/growth-advisor-quote-roi/1.0.11/manifest.json`
- Modify: `contracts/test/schema-registry.test.mjs`
- Modify: `contracts/test/growth-openapi.test.mjs`
- Modify: `contracts/test/generated-types.test.mjs`
- Modify: `backend/src/growth-contract-types.ts`
- Modify: `backend/src/growth-contract-types-test.ts`
- Modify: `backend/src/growth-openapi-test.ts`
- Modify: `backend/src/growth-openapi-contract-drift-test.ts`
- Modify: `backend/src/growth-openapi-response-conformance-test.ts`
- Modify: `frontend/contracts/pinned/growth-advisor-quote-roi.manifest.json`
- Modify: `frontend/src/generated/growth-advisor-quote-roi.ts`
- Modify: `frontend/src/growth/contracts.ts`
- Modify: `frontend/tests/fixtures/growth-contract.ts`
- Modify: `frontend/tests/fixtures/growth-contract.self-test.ts`

**Interfaces:**
- Produces:
  - `GET /api/v1/finance/council-model-routing-policy`
  - `PUT /api/v1/finance/council-model-routing-policy`
  - `POST /api/v1/finance/council-model-routing-policy/preview`
  - `POST /api/v1/finance/statement-packages/preview`
  - `POST /api/v1/finance/statement-packages/:previewId/commit`
  - `POST /api/v1/finance/council-runs/from-statement-package`
  - `GET /api/v1/finance/council-agent-center`
  - `GET /api/v1/finance/council-runs/:runId/agents`
- Routing GET/preview and agent-center reads require `finance.council.run`; routing PUT requires `finance.council.policy.manage`; statement preview/commit requires `ledger.pending.create`; run creation requires `finance.council.run`.
- PUT and every POST require `Idempotency-Key`; PUT additionally requires `If-Match`. Browser bodies contain no workspace/actor/capabilities/server timestamps.
- The current immutable release advances exactly once from `1.0.10` to `1.0.11`; `1.0.10` files remain byte-for-byte unchanged.

- [ ] **Step 1: Write contract/runtime route RED tests.**

```js
test("1.0.11 exposes closed real council onboarding routes", () => {
  for (const path of [
    "/api/v1/finance/council-model-routing-policy",
    "/api/v1/finance/council-model-routing-policy/preview",
    "/api/v1/finance/statement-packages/preview",
    "/api/v1/finance/statement-packages/{previewId}/commit",
    "/api/v1/finance/council-runs/from-statement-package",
    "/api/v1/finance/council-agent-center",
    "/api/v1/finance/council-runs/{runId}/agents"
  ]) assert.ok(openapi.paths[path], path);
});

test("statement-package run input cannot carry a business report or workspace", () => {
  assert.equal(validateRunFromPackage({
    statementPackageId: "fsp-1",
    policyVersionId: "policy-1",
    businessReport: {},
    workspaceId: "other"
  }), false);
});
```

Add runtime router cases for missing CSRF/session, missing capability, missing idempotency, stale If-Match, arbitrary connection ID, cross-workspace preview ID, changed replay body and response conformance.

- [ ] **Step 2: Write agent-center projection RED tests.**

```ts
test("agent center exposes sanitized readiness and exact role attempts", async () => {
  const view = await projectAgentCenter(context, fixtures);
  assert.equal(view.data.status, "ready");
  assert.equal(view.models.status, "ready");
  assert.deepEqual(view.roles.map((role) => role.role), [
    "cfo", "finance", "profit", "cost", "cashflow", "tax"
  ]);
  assert.deepEqual(view.roles[1]!.attempts, [{
    attempt: 1,
    provider: "deepseek",
    model: "deepseek-chat",
    connectionDisplayName: "DeepSeek 主连接",
    status: "failed",
    errorCode: "MODEL_RATE_LIMITED",
    startedAt: T1,
    completedAt: T2
  }, {
    attempt: 2,
    provider: "qwen",
    model: "qwen-plus",
    connectionDisplayName: "通义备用",
    status: "succeeded",
    errorCode: null,
    startedAt: T2,
    completedAt: T3
  }]);
  assert.equal(JSON.stringify(view).includes("apiKey"), false);
  assert.equal(JSON.stringify(view).includes("prompt"), false);
  assert.equal(JSON.stringify(view).includes("businessData"), false);
});
```

Cover statuses `not_connected|ready|running|waiting|completed|manual_review|model_error`, no package, package ready, no eligible model, active run, terminal run, cross-workspace run, malformed model ledger row and deterministic role order.

- [ ] **Step 3: Run and prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-model-routing-service-test.ts \
  src/financial-council-model-routing-router-test.ts \
  src/financial-statement-package-router-test.ts \
  src/financial-council-agent-center-test.ts \
  src/financial-council-agent-center-router-test.ts \
  src/financial-council-router-test.ts \
  src/growth-openapi-test.ts
pnpm test:contracts
```

Expected: new service/router modules are absent and OpenAPI paths/schemas are missing.

- [ ] **Step 4: Implement routing service and router.**

```ts
export interface FinancialCouncilModelRoutingService {
  getCurrent(context: ActiveWorkspaceContext):
    Promise<FinancialCouncilModelRoutingPolicyVersion>;
  preview(context: ActiveWorkspaceContext):
    Promise<readonly FinancialCouncilModelRoutePreview[]>;
  put(
    command: CommandContext,
    expectedRevision: number,
    input: FinancialCouncilModelRoutingPolicyInput
  ): Promise<FinancialCouncilModelRoutingPolicyVersion>;
}
```

Validate pinned connections through the same official connection scope/capability resolver used by the scorer. GET returns an ETag based on the policy revision. Preview returns reason codes and display-safe connection metadata only and performs zero provider calls/ledger writes.

- [ ] **Step 5: Implement statement/run and agent-center routers.**

The statement preview body is closed to three entries:

```ts
export interface FinancialStatementPackagePreviewInput {
  readonly statements: readonly [
    FinancialStatementUpload<"balance_sheet">,
    FinancialStatementUpload<"income_statement">,
    FinancialStatementUpload<"cash_flow_statement">
  ];
}

export interface CreateCouncilRunFromPackageInput {
  readonly statementPackageId: string;
  readonly policyVersionId: string;
}
```

Each upload contains only `kind,fileName,mediaType,contentBase64`; max decoded bytes and workbook rules remain server-owned. Commit body is exactly `{consent:{accepted:true,noticeVersion:"financial-model-data.v1"}}`. The run route ignores/removes no fields: extra fields cause 400.

- [ ] **Step 6: Implement public projections and runtime composition.**

`FinancialCouncilAgentCenterView` is closed to:

```ts
{
  data: { status, packageId, companyName, period, verifiedAt, warningCodes },
  models: { status, routingPolicyVersionId, roles },
  latestRun: { runId, status, revision, updatedAt } | null,
  capabilities: { canRun, canApprove, canManageRouting }
}
```

The run-agent view adds current role phase/status and sanitized attempts. Derive display names from public model connection projection; never derive the active workspace from request headers supplied by the browser.

- [ ] **Step 7: Update schema/OpenAPI, generate 1.0.11 and import frontend types.**

```bash
pnpm build:growth-contract-release
pnpm test:contracts
pnpm --filter ./backend test:growth-openapi
pnpm check:growth-contract-release
pnpm --filter ./frontend contract:import
pnpm --filter ./frontend contract:generate
pnpm --filter ./frontend contract:check
pnpm --filter ./frontend test:growth:fixture
```

Before and after generation:

```bash
git diff --exit-code 105b879 -- contracts/releases/growth-advisor-quote-roi/1.0.10
```

Expected: all gates pass, old release has no diff, generated frontend types expose exact new paths and closed schemas.

- [ ] **Step 8: Run full public-boundary gates.**

```bash
pnpm test:contracts
pnpm --filter ./backend test:growth-openapi
pnpm --filter ./backend test:financial-council
pnpm --filter ./backend build
pnpm --filter ./frontend test:types
git diff --check
```

- [ ] **Step 9: Update API docs and commit.**

Update `contracts/README.md`, root README API summary and the current Financial Council status document with `1.0.11`, exact endpoints, capabilities and “approval creates drafts only”.

```bash
git add contracts/json-schema/financial-council.v1.schema.json \
  contracts/json-schema/finance-import-operation.v1.schema.json \
  contracts/openapi/growth-advisor-quote-roi.v1.yaml \
  contracts/releases/growth-advisor-quote-roi/1.0.11 \
  contracts/test/schema-registry.test.mjs \
  contracts/test/growth-openapi.test.mjs \
  contracts/test/generated-types.test.mjs contracts/README.md \
  backend/src/growth-contract-types* \
  backend/src/growth-openapi* \
  backend/src/financial-council-model-routing-{service,router}* \
  backend/src/financial-statement-package-router* \
  backend/src/financial-council-agent-center* \
  backend/src/financial-council-router* \
  backend/src/growth-financial-council-module* \
  backend/src/growth-commercial-composition* \
  frontend/contracts/pinned \
  frontend/src/generated/growth-advisor-quote-roi.ts \
  frontend/src/growth/contracts.ts frontend/tests/fixtures \
  README.md
git commit -m "feat(finance): expose real council onboarding APIs"
```

---

### Task 6: 实现前端真实数据、路由策略与运行控制器

**Files:**
- Create: `frontend/src/growth/agents/real-api.ts`
- Create: `frontend/src/growth/agents/real-api.self-test.ts`
- Create: `frontend/src/growth/agents/real-controller.ts`
- Create: `frontend/src/growth/agents/real-controller.self-test.ts`
- Modify: `frontend/src/growth/agents/api.ts`
- Modify: `frontend/src/growth/agents/controller.ts`
- Create: `frontend/src/growth/agents/controller.self-test.ts`
- Modify: `frontend/src/growth/council/api.ts`
- Modify: `frontend/src/growth/council/api.self-test.ts`
- Modify: `frontend/src/growth/council/controller.ts`
- Modify: `frontend/src/growth/council/controller.self-test.ts`
- Modify: `frontend/src/growth/contracts.ts`
- Modify: `frontend/src/self-test.ts`

**Interfaces:**
- `RealAgentCenterApi` exposes `getAgentCenter/getRunAgents/getRoutingPolicy/previewRouting/updateRouting/previewStatements/commitStatements/createRunFromPackage`.
- `RealAgentCenterControllerState` contains server projections only: readiness, routing policy/preview, statement preview/package, latest run/roles, mutation state, safe error and consent state.
- Produces `createRealAgentCenterController(options): RealAgentCenterController`; the existing view-layer `createAgentsController` receives it through a new optional `real` dependency in Task 7.
- File bytes exist only in a mutation-local `ArrayBuffer`; controller state stores names/sizes and server projection, never base64 or workbook cells.
- Semantic idempotency keys survive ambiguous network failure and clear only after a valid success; generation/AbortController prevents old package/run/routing responses from reviving after logout, replacement or destroy.

- [ ] **Step 1: Write exact HTTP client RED tests.**

```ts
test("statement preview sends exactly three files and no authority fields", async () => {
  await api.previewStatements({
    statements: [balanceUpload(), incomeUpload(), cashflowUpload()]
  }, "preview-key", signal);
  assert.deepEqual(requests[0], {
    path: "/api/v1/finance/statement-packages/preview",
    method: "POST",
    idempotencyKey: "preview-key",
    body: {
      statements: [
        publicUpload(balanceUpload()),
        publicUpload(incomeUpload()),
        publicUpload(cashflowUpload())
      ]
    }
  });
  assert.equal("workspaceId" in requests[0]!.body, false);
  assert.equal("actorId" in requests[0]!.body, false);
});

test("routing update preserves If-Match and rejects open success bodies", async () => {
  await api.updateRouting(input, "\"routing:ws-1:2\"", "route-key");
  assert.equal(requests[0]!.headers.IfMatch, "\"routing:ws-1:2\"");
  await assert.rejects(() => api.getAgentCenter(),
    /financial_council_response_invalid/u);
});
```

Cover all new paths, CSRF delegated to `GrowthHttpClient`, 400/401/403/409/412 safe errors, no raw key, no arbitrary model body, and exact 1.0.11 runtime validators.

- [ ] **Step 2: Write controller lifecycle RED tests.**

```ts
test("three statements progress from preview to package to one run", async () => {
  await controller.selectStatement("balance_sheet", balanceFile());
  await controller.selectStatement("income_statement", incomeFile());
  await controller.selectStatement("cash_flow_statement", cashflowFile());
  await controller.previewStatements();
  controller.acceptModelDataNotice(true);
  await controller.commitStatements();
  await controller.startCouncil();
  assert.equal(controller.getState().statementPackage?.status, "verified");
  assert.equal(controller.getState().latestRun?.status, "snapshot_frozen");
  assert.equal(apiCalls.createRunFromPackage, 1);
});
```

Add cases for missing file, duplicate kind, preview warning, preview failure zero package, consent false, commit retry same key, start retry same key, routing edit unauthorized, pinned invalid connection, policy 412 reload, request A finishing after request B, logout, route exit, destroy, file buffer release and no sample fallback in real mode.

- [ ] **Step 3: Prove RED.**

```bash
cd frontend
pnpm exec tsx src/growth/agents/real-api.self-test.ts
pnpm exec tsx src/growth/agents/real-controller.self-test.ts
pnpm exec tsx src/growth/council/api.self-test.ts
pnpm exec tsx src/growth/council/controller.self-test.ts
```

Expected: the new real API/controller modules are absent and existing council API only creates a run from caller-supplied business report.

- [ ] **Step 4: Implement the closed API client.**

```ts
export interface RealAgentCenterApi {
  getAgentCenter(signal?: AbortSignal):
    Promise<GrowthHttpResponse<FinancialCouncilAgentCenterView>>;
  getRunAgents(runId: string, signal?: AbortSignal):
    Promise<GrowthHttpResponse<FinancialCouncilRunAgentsView>>;
  getRoutingPolicy(signal?: AbortSignal):
    Promise<GrowthHttpResponse<FinancialCouncilModelRoutingPolicyVersion>>;
  previewRouting(signal?: AbortSignal):
    Promise<GrowthHttpResponse<FinancialCouncilModelRoutePreview[]>>;
  updateRouting(
    input: FinancialCouncilModelRoutingPolicyInput,
    etag: string,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<FinancialCouncilModelRoutingPolicyVersion>>;
  previewStatements(
    input: FinancialStatementPackagePreviewInput,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<FinancialStatementPackagePreview>>;
  commitStatements(
    previewId: string,
    input: FinancialStatementPackageCommitInput,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<FinancialStatementPackageView>>;
  createRunFromPackage(
    input: CreateCouncilRunFromPackageInput,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<FinancialCouncilRun>>;
}
```

Use generated component/path aliases; handwritten validators may narrow generated types but may not widen them. Do not log request bodies in error handlers.

- [ ] **Step 5: Implement controller state and semantic keys.**

```ts
export interface RealAgentCenterControllerState {
  readonly readiness: FinancialCouncilAgentCenterView | null;
  readonly routingPolicy: FinancialCouncilModelRoutingPolicyVersion | null;
  readonly routingPreview: readonly FinancialCouncilModelRoutePreview[];
  readonly files: Readonly<Record<FinancialStatementKind, SelectedFileMeta | null>>;
  readonly statementPreview: FinancialStatementPackagePreview | null;
  readonly statementPackage: FinancialStatementPackageView | null;
  readonly latestRun: FinancialCouncilRun | null;
  readonly runAgents: FinancialCouncilRunAgentsView | null;
  readonly consentAccepted: boolean;
  readonly busy: RealAgentCenterBusy;
  readonly error: string | null;
}
```

Use these controller-only types; `FinancialStatementKind` comes from the
generated 1.0.11 contract:

```ts
export interface SelectedFileMeta {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly sha256: `sha256:${string}`;
}

export type RealAgentCenterBusy =
  | "loading"
  | "previewing_statements"
  | "committing_statements"
  | "creating_run"
  | "updating_routing"
  | null;

export interface RealAgentCenterController {
  getState(): RealAgentCenterControllerState;
  subscribe(listener: (state: RealAgentCenterControllerState) => void):
    () => void;
  selectStatement(kind: FinancialStatementKind, file: File): Promise<void>;
  previewStatements(): Promise<void>;
  acceptModelDataNotice(accepted: boolean): void;
  commitStatements(): Promise<void>;
  startCouncil(): Promise<void>;
  updateRouting(input: FinancialCouncilModelRoutingPolicyInput): Promise<void>;
  close(): void;
  destroy(): void;
}
```

Key inputs:
- preview: three `(kind,name,size,lastModified)` plus browser-computed SHA-256 of exact bytes;
- commit: `previewId + noticeVersion`;
- create: `packageId + optimizationPolicyVersionId`;
- routing: canonical closed routing policy input.

The browser hash is only an idempotency input; server file hashes remain authoritative.

- [ ] **Step 6: Reuse the existing council controller for run polling.**

Add `createFromStatementPackage` to `FinancialCouncilApi`/controller and remove the real-mode path that serializes `businessReport`. Existing fixture-only tests may still use the legacy internal API fixture, but production UI calls only the package route.

- [ ] **Step 7: Verify focused and frontend gates.**

```bash
pnpm --filter ./frontend exec tsx src/growth/agents/real-api.self-test.ts
pnpm --filter ./frontend exec tsx src/growth/agents/real-controller.self-test.ts
pnpm --filter ./frontend exec tsx src/growth/agents/controller.self-test.ts
pnpm --filter ./frontend exec tsx src/growth/council/api.self-test.ts
pnpm --filter ./frontend exec tsx src/growth/council/controller.self-test.ts
pnpm --filter ./frontend test:types
pnpm --filter ./frontend test
pnpm --filter ./frontend build
git diff --check
```

- [ ] **Step 8: Commit the frontend control slice.**

This is an internal control/API change with no visible copy yet; update the frontend current-status section only, not screenshots.

```bash
git add frontend/src/growth/agents \
  frontend/src/growth/council/api* \
  frontend/src/growth/council/controller* \
  frontend/src/growth/contracts.ts frontend/src/self-test.ts
git commit -m "feat(frontend): control real financial council onboarding"
```

---

### Task 7: 把真实三表、模型路由和委员会工作台接入唯一黑色智能体中心

**Files:**
- Modify: `frontend/src/demo/demo-app.ts`
- Modify: `frontend/src/demo/demo-router.ts`
- Modify: `frontend/src/growth/agents/view.ts`
- Modify: `frontend/src/growth/agents/view.self-test.ts`
- Modify: `frontend/src/growth/agents/controller.ts`
- Modify: `frontend/src/growth/agents/controller.self-test.ts`
- Modify: `frontend/src/growth/agents/agents.ts`
- Modify: `frontend/src/growth/council/entry.ts`
- Modify: `frontend/src/growth/council/entry.self-test.ts`
- Modify: `frontend/src/growth/council/view.ts`
- Modify: `frontend/src/growth/council/view.self-test.ts`
- Modify: `frontend/src/growth/council/controller.ts`
- Modify: `frontend/src/growth/runtime.ts`
- Modify: `frontend/src/growth/router.ts`
- Modify: `frontend/src/growth/router.self-test.ts`
- Modify: `frontend/src/app-route.ts`
- Modify: `frontend/src/app-route.self-test.ts`
- Modify: `frontend/src/app-shell.css`
- Modify: `frontend/src/growth/styles.css`
- Modify: `frontend/tests/agent-center-shell.spec.ts`
- Create: `frontend/tests/financial-council-agent-center.spec.ts`
- Modify: `frontend/tests/growth-financial-council.spec.ts`
- Modify: `frontend/README.md`

**Interfaces:**
- `#agents` remains the only default home. When `body.dataset.sessionMode === "real"`, it mounts `RealAgentCenterController`; demo mode remains explicitly local and labeled.
- Legacy `#growth/agents` normalizes to `#agents`; `#financial-council` and `#financial-council/run/<id>` render the existing council workbench inside the same `.replica-shell`.
- Six cards consume server role/readiness projection. They display safe connection display name, current phase, last run time and one of: `未连接数据|数据已就绪|分析中|等待其他专家|已完成|需要人工复核|模型连接异常`.
- Real mode requires three files, preview, consent and commit before run creation. The sample-report button is absent in real mode.
- Admin routing editor lives in the agent center, not a new admin system. Ordinary users can view the selected model but cannot edit policy.
- Approval copy explicitly states that it creates internal drafts/todos only.

- [ ] **Step 1: Write semantic view/router RED tests.**

```ts
test("real overview requires three statements and exposes no sample shortcut", () => {
  const html = renderAgentsOverview(realState());
  assert.match(html, /data-statements-file="balance_sheet"/u);
  assert.match(html, /data-statements-file="income_statement"/u);
  assert.match(html, /data-statements-file="cash_flow_statement"/u);
  assert.match(html, /已选择 0 \/ 3 份必需报表/u);
  assert.doesNotMatch(html, /sample-report|示例数据/u);
});

test("legacy agents route returns to the one black home", () => {
  assert.equal(normalizeAppHash("#growth/agents"), "#agents");
  assert.deepEqual(parseGrowthHash("#financial-council/run/run-1"), {
    name: "financial-council", runId: "run-1"
  });
});
```

Cover card statuses/order, model error, fallback badge, no API key/prompt/raw JSON, consent unchecked, admin edit controls, non-admin read-only, warnings, manual review, tax disclaimer, approval draft-only copy, keyboard labels and HTML escaping.

- [ ] **Step 2: Write browser RED cases against the fixture backend.**

Cases:
1. real session opens `#agents` with one `.replica-shell`, six server-projected cards and no demo admin/sample action;
2. three uploads are required; preview renders server amounts/warnings; run button is disabled before consent;
3. consent + commit creates one package and one run under ambiguous retry;
4. expert cards progress through analyzing/auditing/synthesizing/optimizing/awaiting approval;
5. a primary failure then fallback success is visible without exposing financial request data;
6. admin pins primary/fallback with If-Match; normal user cannot mutate;
7. workbench shows conflict/rebuttal/minority/three portfolios and stale approval protection;
8. approval produces only draft/todo receipts;
9. logout or route change aborts pending preview/run reads;
10. widths `1440,1366,1024,390` have no page horizontal overflow and all dialogs are keyboard operable.

- [ ] **Step 3: Prove RED.**

```bash
pnpm --filter ./frontend exec tsx src/growth/agents/view.self-test.ts
pnpm --filter ./frontend exec tsx src/growth/agents/controller.self-test.ts
pnpm --filter ./frontend exec tsx src/growth/council/view.self-test.ts
pnpm --filter ./frontend exec tsx src/growth/router.self-test.ts
pnpm --filter ./frontend exec playwright test \
  agent-center-shell.spec.ts \
  financial-council-agent-center.spec.ts \
  growth-financial-council.spec.ts --project=chromium
```

Expected: the current real `#agents` still mounts the demo controller, renders two file inputs and exposes sample data; the new real browser spec fails before production UI changes.

- [ ] **Step 4: Mount real and demo agent centers through one lifecycle boundary.**

```ts
const realMode = document.body.dataset.sessionMode === "real";
const real = realMode
  ? createRealAgentCenterController({
      api: createRealAgentCenterApi(createGrowthHttpClient()),
      council: createFinancialCouncilController({
        api: createFinancialCouncilApi(createGrowthHttpClient())
      })
    })
  : undefined;
agentsController = createAgentsController({
  host,
  demo: !realMode,
  real
});
```

Listen to `goodjob:auth-state-changed`; on every mode change dispose the old controller, abort all requests, clear both main/inspector hosts and create exactly one new controller. Never switch a running controller's authority mode in place.

- [ ] **Step 5: Implement the three-file preview/consent UI.**

Use three native file controls/dropzones. Show name/size only before server preview. After preview show company, period, currency, normalized key totals, server warnings and invalid fields. The consent checkbox copy must name the selected third-party providers generically and link to the safe routing summary; it must reset when files, preview or workspace changes.

- [ ] **Step 6: Implement role cards and routing editor.**

The routing dialog renders six fixed role rows. Auto mode shows the recommended primary and at most two fallbacks with reason labels. Pinned mode select options come only from server preview eligibility. Save uses the controller's stable idempotency key and current ETag; 412 reloads the policy and shows a non-destructive conflict message.

- [ ] **Step 7: Reuse and restyle the existing council workbench in the black shell.**

Do not duplicate council calculations. Reuse `growth/council/api/controller/view`; adapt host selection and CSS variables so `#financial-council/run/<id>` remains within `.replica-shell`. Preserve sections in this order:

```text
run/status/data version
six role progress cards
audit/rebuttal/minority
CFO diagnosis/data gaps
balanced/cash_first/growth_first
selected action/rejected reasons/sensitivity
edit/reoptimization
approval
draft/todo receipts
```

A failed/unknown metric renders `暂不可计算`, never `0`. The approval button is disabled for stale, infeasible, unauthorized or incomplete runs.

- [ ] **Step 8: Verify focused, browser, accessibility and build gates.**

```bash
pnpm --filter ./frontend test
pnpm --filter ./frontend test:types
pnpm --filter ./frontend exec playwright test \
  agent-center-shell.spec.ts \
  financial-council-agent-center.spec.ts \
  growth-financial-council.spec.ts \
  demo-auth.spec.ts --project=chromium
pnpm --filter ./frontend build
git diff --check
```

Static security checks:

```bash
rg -n 'localStorage|sessionStorage|console\.(log|info|debug)|apiKey|rawWorkbook' \
  frontend/src/growth/agents frontend/src/growth/council
rg -n 'page\.route|route\.fulfill' frontend/tests/financial-council-agent-center.spec.ts
```

Expected: first command lists only explicitly reviewed run-ID session handling if any; second command prints nothing.

- [ ] **Step 9: Update frontend docs and commit.**

Update `frontend/README.md` with the one-shell routes, three-report flow, real/demo distinction, admin routing editor, consent, approval safety and commands. Remove any current text saying two statements are sufficient or `#growth/agents` is the primary agent home.

```bash
git add frontend/src/demo/demo-app.ts frontend/src/demo/demo-router.ts \
  frontend/src/growth/agents frontend/src/growth/council \
  frontend/src/growth/runtime.ts frontend/src/growth/router* \
  frontend/src/app-route* frontend/src/app-shell.css \
  frontend/src/growth/styles.css \
  frontend/tests/agent-center-shell.spec.ts \
  frontend/tests/financial-council-agent-center.spec.ts \
  frontend/tests/growth-financial-council.spec.ts \
  frontend/README.md
git commit -m "feat(frontend): run the real council in the agent center"
```

---

### Task 8: 完成真实 MySQL、双供应商、恢复与无拦截浏览器验收

**Files:**
- Create: `backend/src/financial-council-real-runtime-integration-test.ts`
- Create: `backend/src/financial-council-model-routing-mysql-integration-test.ts`
- Create: `backend/src/financial-statement-package-mysql-integration-test.ts`
- Create: `backend/scripts/financial-council-live-provider-smoke.ts`
- Create: `backend/scripts/financial-council-live-provider-smoke-test.ts`
- Modify: `backend/src/financial-council-real-e2e-server.ts`
- Modify: `backend/src/financial-council-real-e2e-server-test.ts`
- Modify: `backend/src/financial-council-integration-fixtures.ts`
- Modify: `backend/package.json`
- Create: `frontend/tests/financial-council-real-runtime.spec.ts`
- Create: `frontend/playwright.financial-council-real-runtime.config.ts`
- Modify: `frontend/package.json`
- Modify: `package.json`
- Create: `docs/operations/financial-council-real-runtime.md`
- Modify: `README.md`
- Modify: `frontend/README.md`
- Modify: `backend/src/business-advisor/README.md`
- Modify: `docs/superpowers/specs/2026-08-23-real-financial-council-runtime-design.md`

**Interfaces:**
- `test:financial-council:real-runtime` requires `MYSQL_TEST_ADMIN_URL`; absence is a hard failure with `MYSQL_TEST_ADMIN_URL_REQUIRED:financial-council-real-runtime`, not a skip.
- `test:financial-council:live-providers` requires two already-active workspace connection IDs from different providers. It reads encrypted credentials through the existing store, never accepts raw API keys as CLI arguments and never prints request/response bodies.
- Browser config starts the real backend and Vite proxy with no Playwright network interception.
- The acceptance fixture uses real MySQL schemas, real session/CSRF/workspace/capabilities and real application routes. Deterministic model fixtures remain allowed only for fault/recovery tests; the separate live-provider gate proves two real providers.
- A controlled fallback drill wraps the selected primary adapter with one retryable pre-request failure and proves the real fallback connection succeeds on attempt 2; it never mutates production routing code or persist a test flag.

- [ ] **Step 1: Write live MySQL and restart RED tests.**

```ts
test("real mysql survives restart from statements through draft receipts", async () => {
  const first = await createHarness({ databaseUrl, instance: "first" });
  const packageView = await first.uploadPreviewCommit(threeStatements());
  const run = await first.createRun(packageView.packageId);
  await first.waitForStatus(run.runId, "auditing");
  await first.close();

  const second = await createHarness({ databaseUrl, instance: "second" });
  await second.waitForStatus(run.runId, "awaiting_approval");
  const revision = await second.revise(run.runId);
  await second.approve(run.runId, revision.revision, "balanced");
  await second.waitForDispatches(run.runId, "succeeded");
  assert.equal((await second.listDraftReceipts(run.runId)).length > 0, true);
});
```

Add real two-connection races for routing If-Match, package commit idempotency, run creation replay, lease reclaim/old-token rejection, exact-expiry rejection, outbox replay and schema upgrade from pre-routing/pre-package tables.

- [ ] **Step 2: Run and prove RED against local MySQL 3307.**

```bash
MYSQL_TEST_ADMIN_URL="$MYSQL_LOCAL_ADMIN_URL" \
  pnpm --filter ./backend test:financial-council:real-runtime
```

Expected: new integration modules/scripts are absent. If the environment variable is missing or credentials are invalid, stop and fix Task 1 local provisioning; do not convert the test to a skip.

- [ ] **Step 3: Implement isolated database lifecycle and restart harness.**

Create a random database `shensi_financial_council_<pid>_<uuid12>`, run the same production schema ensure paths, use at least two distinct `CONNECTION_ID()` values, and drop the isolated database in `finally`. The test may not connect to the developer's persistent `shensi_sales` database for destructive assertions.

- [ ] **Step 4: Write live-provider smoke RED tests.**

```ts
test("smoke refuses same-provider or uncertified connections", async () => {
  await assert.rejects(() => resolveLiveProviderPair(store, {
    primaryConnectionId: "deepseek-a",
    fallbackConnectionId: "deepseek-b"
  }), /LIVE_PROVIDER_PAIR_MUST_USE_DISTINCT_PROVIDERS/u);
});

test("smoke output is metadata-only", async () => {
  const output = await runLiveProviderSmoke(pair, safeFixture());
  assert.deepEqual(Object.keys(output), [
    "primary", "fallback", "structuredOutput", "fallbackDrill"
  ]);
  assert.equal(JSON.stringify(output).includes("businessData"), false);
  assert.equal(JSON.stringify(output).includes("apiKey"), false);
});
```

- [ ] **Step 5: Implement and run the two-provider live gate.**

The script requires:

```text
FINANCIAL_COUNCIL_LIVE_PRIMARY_CONNECTION_ID
FINANCIAL_COUNCIL_LIVE_FALLBACK_CONNECTION_ID
DATABASE_URL
```

It verifies both are active, belong to the authenticated test workspace, have different provider IDs and certified structured output. It runs one minimal schema call per provider, then a controlled attempt-1 retryable failure followed by an actual attempt-2 provider call. Output contains only connection ID, provider, model, request ID, latency, token counts, status and error code.

```bash
pnpm --filter ./backend test:financial-council:live-providers
```

Expected: PASS only after the administrator has entered two real API keys through the connection center. Missing IDs/credentials must exit nonzero with a safe readiness code.

- [ ] **Step 6: Write the no-intercept browser RED spec.**

The spec must not import a fixture router and must contain no `page.route`, `context.route`, `route.fulfill`, `route.fallback` or `route.abort`. It performs:

1. real login;
2. open `#agents`;
3. verify server-projected model readiness;
4. upload three workbook fixtures through file controls;
5. inspect preview and accept the third-party model notice;
6. commit package and start one run;
7. observe five specialist results, one real canonical audit conflict and one round-1 rebuttal;
8. observe CFO consensus/minority and exactly three portfolios;
9. revise latest portfolio;
10. approve the latest revision;
11. observe only draft/todo receipts;
12. reload and prove the same run/package/receipts survive;
13. verify no financial body/sentinel in URL, console, storage or rendered hidden state.

- [ ] **Step 7: Extend the real E2E server and prove browser GREEN.**

The server continues to bind only `127.0.0.1`, uses real `server.app`, session, CSRF, workspace middleware, MySQL repositories, workers and routes, and prints one machine-readable readiness line without secrets. Its deterministic model adapter is explicitly labeled acceptance-fixture-only; the separate Step 5 live gate covers real providers.

```bash
MYSQL_TEST_ADMIN_URL="$MYSQL_LOCAL_ADMIN_URL" \
  pnpm test:e2e:financial-council:real-runtime
```

Expected: Chromium passes without route interception; backend creates and drops only its isolated test database.

- [ ] **Step 8: Run the complete release gate.**

```bash
pnpm test:contracts
pnpm check:growth-contracts
pnpm --filter ./backend test:growth-foundation
pnpm --filter ./backend test:growth-finance:imports
pnpm --filter ./backend test:financial-council
MYSQL_TEST_ADMIN_URL="$MYSQL_LOCAL_ADMIN_URL" \
  pnpm --filter ./backend test:financial-council:mysql
MYSQL_TEST_ADMIN_URL="$MYSQL_LOCAL_ADMIN_URL" \
  pnpm --filter ./backend test:financial-council:real-runtime
pnpm --filter ./backend test:financial-council:live-providers
pnpm --filter ./frontend test
pnpm --filter ./frontend test:types
pnpm --filter ./frontend test:e2e
MYSQL_TEST_ADMIN_URL="$MYSQL_LOCAL_ADMIN_URL" \
  pnpm test:e2e:financial-council:real-runtime
pnpm build
git diff --check
```

All commands must pass. Existing conditional MySQL tests must actually run under the supplied URL; report exact pass/fail/skip counts and treat any remaining live skip as incomplete acceptance.

- [ ] **Step 9: Audit security, persistence and external side effects.**

```bash
rg -n 'page\.route|context\.route|route\.(fulfill|fallback|abort)' \
  frontend/tests/financial-council-real-runtime.spec.ts
rg -n 'payment|tax_filing|journal_post|send_email|webhook' \
  backend/src/financial-council-dispatch* \
  backend/src/financial-council-draft*
rg -n 'content_base64|workbook_bytes|api_key|prompt_text|business_data' \
  backend/src/financial-statement-package* \
  backend/src/financial-council-agent-center*
```

Expected: the browser grep is empty; dispatch grep shows no external executor; persistence/projection grep finds only explicit reject/allowlist tests and no stored raw body or secret column.

- [ ] **Step 10: Update operations/current docs and commit.**

`docs/operations/financial-council-real-runtime.md` must contain:
- MySQL 3307 setup/start/stop/backup without credentials;
- connection-center setup and two-provider readiness checks;
- three-statement upload/run/approval operator path;
- safe error codes and recovery checks;
- how to run every live gate;
- explicit statement that approval creates internal drafts/todos only;
- rollback by stopping real runtime/removing local env, never automatically dropping persistent tables.

Set the design document status to `已实施并通过真实验收` only after Steps 5, 7 and 8 genuinely pass. If live credentials are unavailable, leave it `实施完成，真实供应商验收待凭据` and do not claim the project complete.

```bash
git add backend/src/financial-council-real-runtime-integration-test.ts \
  backend/src/financial-council-model-routing-mysql-integration-test.ts \
  backend/src/financial-statement-package-mysql-integration-test.ts \
  backend/src/financial-council-real-e2e-server* \
  backend/src/financial-council-integration-fixtures.ts \
  backend/scripts/financial-council-live-provider-smoke* \
  backend/package.json frontend/tests/financial-council-real-runtime.spec.ts \
  frontend/playwright.financial-council-real-runtime.config.ts \
  frontend/package.json package.json \
  docs/operations/financial-council-real-runtime.md \
  docs/superpowers/specs/2026-08-23-real-financial-council-runtime-design.md \
  README.md \
  frontend/README.md backend/src/business-advisor/README.md
git commit -m "test(finance): verify the real financial council runtime"
```

---

## Final Completion Checklist

- [ ] The worktree contains no secret-bearing file, package lock change, unrelated user edit or obsolete default-path document.
- [ ] `#agents` is the only default home and the browser contains exactly one `.replica-shell`.
- [ ] Real mode never calls `sampleBusinessReport`, `demoDiagnosisReport` or `createDemoAdmin`.
- [ ] A run is bound to one verified statement package, one optimization policy version and one model routing policy version.
- [ ] Every specialist/CFO/rebuttal result has one immutable provider/model/credential/content snapshot.
- [ ] Fallback happens only on retryable provider failure and old attempts cannot commit.
- [ ] The five specialists, audit graph, one rebuttal, CFO minority opinion and three portfolios are durable after restart.
- [ ] Approval produces only internal drafts/todos and deterministic receipts.
- [ ] Runtime/static OpenAPI, generated types and immutable `1.0.11` release are equivalent; `1.0.10` is unchanged.
- [ ] Real MySQL, two-provider smoke, no-intercept Chromium, root tests/build and `git diff --check` pass with exact counts recorded.
- [ ] Root/backend/frontend/operations/current-status documentation describes the final behavior without stale two-statement/demo instructions.
