# Growth Contract and Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 发布 AI 增长参谋、目录、报价、财务和 ROI 的唯一跨仓契约，并在独立新版前端完成真实/演示隔离的 F0–F5 页面。

**Architecture:** GoodJob-1.09 的 OpenAPI 3.1/JSON Schema 是唯一契约源，生成规范化不可变 release artifact、`contractVersion` 和 SHA-256 manifest；独立前端只提交由该 release 生成的 transport types 和 pinned manifest。前端使用中性 workspace router、`GET /api/v1/growth/bootstrap` 启动门和按领域拆分的 API/controller/pure view，保留旧 `/api/v1/acquisition/performance` 与 legacy frontend，不建立第二套领域模型或智能体运行时。

**Tech Stack:** Node.js 22、TypeScript 5.7、Express 4、OpenAPI 3.1、JSON Schema 2020-12、AJV 8、openapi-typescript 7.13、Vite 6、Playwright 1.61、原生 DOM presenter/controller、npm workspaces（后端仓）、pnpm（独立前端仓）。

## Global Constraints

- 后端工作树固定为 `/Users/mac/Documents/外贸/GoodJob-1.09/.worktrees/goodjob-growth-advisor-quote-roi`；独立前端固定为 `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend`。
- C0 的 canonical Growth OpenAPI/JSON Schema、不可变 release/hash、bootstrap route、`growth-commercial-application` 与 runtime bridge 只由本计划 Tasks 1–3 创建；其他 backend domain plans 只能注册 routes/services 或消费生成契约，不得再创建同义契约源、bootstrap router 或第二个 application composition。
- 跨计划顺序固定为本计划 Tasks 1–2 → foundation Task 0.1 → 本计划 Task 3 → foundation Tasks 0.2–0.4 → 本计划 Tasks 4–10/业务领域计划。Tasks 1–2 只发布契约字节，不依赖 foundation；Task 3 必须消费 foundation Task 0.1 提供的 `ActiveWorkspaceContext`、closed capability registry、`CommandContext` 与 resolver，不重新定义 workspace、role-to-capability 映射或租户授权规则。
- 产品前端只在独立前端仓实现；不得把页面复制到 GoodJob-1.09 的 legacy `frontend/src/features/ai-growth/**`。
- `contracts/openapi/growth-advisor-quote-roi.v1.yaml` 与其 JSON Schema 是唯一可编辑契约源；release `openapi.json` 和 manifest 由脚本生成，不手工修改。
- 每个 contract release 目录名必须从已 bundle 的 OpenAPI `info.version` 动态派生并通过严格 SemVer 校验；已存在版本目录只有在 `openapi.json` 与 `manifest.json` 字节完全相同时才可复用，任一 hash/字节不同都以 immutable-version collision 失败，绝不覆盖。
- 当前 Growth 契约源发布为 `1.0.1`；`1.0.0` 字节保持不可变。该补丁只明确 collection create 的并发语义：`createCatalogItem` 没有既存资源 revision，因此不声明或发送 `If-Match`，但仍要求 workspace、认证、CSRF、`Idempotency-Key` 和封闭请求体，并在成功响应中返回首个 `ETag`。
- 所有新 API 对象、引用、查询和写入使用服务端授权的具体 `workspaceId`；不得持久化或提交 `workspaceId="all"`。
- 前端真实模式登录后必须先读取 `GET /api/v1/growth/bootstrap`；bootstrap 未 ready、feature 未启用、contract major/hash 不匹配时 fail closed，不回退到 demo。
- 权限只读 bootstrap 的 `capabilities[]`；不得在页面中用 `role` 推导 capability，也不得让 CSS 隐藏代替服务端字段脱敏。
- bootstrap 只发布 human-exposable `GrowthBootstrapCapability`；foundation registry 的内部能力 `acquisition.outcome.reconcile.internal` 只供 Reconciler 使用，禁止进入 OpenAPI、生成前端 union、bootstrap 响应或页面 fixture。
- 所有金额使用 ISO 4217 币种和最小货币单位安全整数；数量使用 `quantityMicros`；BPS 输入位于契约规定范围；页面不得使用浮点金额计算权威结果。
- 概率、折扣、覆盖率和分配等比例输入限制为 `0..10000` BPS；`grossMarginBps` 与预计/实际 `roiBps` 是可为负且可超过 10000 的有符号安全整数，契约不得错误套用百分比输入范围。利润与贡献金额同样允许负值，但价格、成本、付款和折扣金额保持非负。唯一例外是报价试算的不可执行诊断分支可返回命名明确的 `diagnosticNetProductAmountMinor` / `diagnosticQuotedAmountMinor` 有符号中间值；它们不是价格，不得进入 QuoteVersion、审批、PI、CRM 或 ROI。
- Advisor Today、Growth Performance 查询和 Closure 命令的 `asOf` 必须是严格 RFC 3339 date-time，且不得晚于服务端在请求入口冻结的 `readStartedAt`/`commandStartedAt` 加 1 秒容差；超过上界返回 `422 invalid_as_of`，Closure 零写入。容差只用于吸收客户端时钟偏差；合法但晚于入口时间的值必须被夹到 `effectiveAsOf = min(clientAsOf, startedAt)`，所有读取、hash、响应与 Closure operation 只使用该 effective cutoff。客户端时钟、模型输出和数据库完成时间都不能扩大此 cutoff。
- Foundation 唯一时间权威冻结为 workspace-global `GrowthTemporalBarrier`：每个 Growth append transaction 第一把锁调用 `allocateAppend`，持有同一 workspace barrier 至业务提交并保存全局 `{recordedAt,temporalSequence}`；任何 public historical boundary 只调用一次 `sealReadCutoff`，将 opaque `GrowthSealedReadCutoff` 传给所有 internal readers。`nextGrowthRecordedAt` 仅是 barrier 内部纯算法，later repositories 禁止对 local stream tail 直接调用。Token sequence 只作隔离审计，不进入业务 hash/idempotency/DTO；同一 effective cutoff 的重复 seal 必须产生 byte-identical business projection。
- 前端和 LLM 只能提交报价输入；标准价、底价、折扣、毛利、贡献利润、预计/实际 ROI 均读取后端确定性结果。
- 所有写命令发送契约声明的 `Idempotency-Key` 和 CSRF；已有资源的修改命令还必须发送 `If-Match`。唯一 collection-create 例外是 `createCatalogItem`：创建前不存在 revision，所以它禁止 `If-Match`，成功后由响应 `ETag` 建立首个 revision。HTTP 幂等键重放后仍以当前 capability 投影响应。
- 所有 Growth module 写路由只调用 Foundation 的 `GrowthCommandContextFactory(req, { canonicalPath, pathParams, payload, expectedRevision })`；`pathParams` 是路由校验后的封闭字符串 map（collection route 传冻结空对象），禁止直接构造 `CommandContext`。同一 key/body/If-Match 换资源 path ID 必须返回 `409 idempotency_conflict`，不得重放上一资源结果。
- 旧 `/api/v1/acquisition/performance`、旧老板简报和旧 Pi 工具保持原 Schema；新页面只消费 `/api/v1/acquisition/growth-performance` 与 `get_growth_performance`。
- 真实模式不得导入 `src/growth/demo/**`；演示适配器不得调用 `fetch`，不得外联、批准、核销或对外发布。
- 保留独立前端已有未提交 `pnpm-workspace.yaml`；每次提交前只暂存当前任务列出的文件。
- 每个任务先写会因缺失行为失败的测试，再写最小实现；完成定向测试、相关全量测试、生产构建和 `git diff --check` 后才提交。

## Locked Cross-Task Interfaces

以下名称在本计划中固定，后续任务不得另建同义 DTO：

```ts
export type Sha256Digest = `sha256:${string}`;

export type GrowthFeature =
  | "catalog"
  | "quotes"
  | "finance"
  | "growth_performance"
  | "advisor";

export type GrowthBootstrapCapability =
  | "catalog.read"
  | "catalog.manage"
  | "pricing.sensitive.read"
  | "quote.draft.create"
  | "quote.confirm"
  | "quote.exception.discount.approve"
  | "quote.exception.margin.approve"
  | "quote.exception.payment_terms.approve"
  | "quote.exception.gift.approve"
  | "quote.exception.credit.approve"
  | "quote.exception.manual.approve"
  | "ledger.pending.create"
  | "ledger.verify"
  | "roi.close"
  | "growth.performance.team.read"
  | "growth.performance.workspace.read";

export type GrowthBootstrapResponse =
  | {
      status: "ready";
      workspaceId: string;
      capabilityRegistryVersion: string;
      capabilities: GrowthBootstrapCapability[];
      contractVersion: string;
      contractHash: Sha256Digest;
      features: GrowthFeature[];
    }
  | {
      status: "workspace_selection_required";
      workspaceId: null;
      capabilityRegistryVersion: string;
      capabilities: [];
      contractVersion: string;
      contractHash: Sha256Digest;
      features: GrowthFeature[];
    };

export interface GrowthContractManifest {
  name: "growth-advisor-quote-roi";
  contractVersion: string;
  contractHash: Sha256Digest;
  openapiVersion: "3.1.0";
}

export interface GrowthRequestOptions extends RequestInit {
  idempotencyKey?: string;
  ifMatch?: string;
  signal?: AbortSignal;
}

export interface GrowthHttpResponse<T> {
  body: T;
  etag: string | null;
  requestId: string | null;
}

export interface GrowthHttpClient {
  request<T>(path: string, options?: GrowthRequestOptions): Promise<GrowthHttpResponse<T>>;
}

export type GrowthRoute =
  | { name: "advisor" }
  | { name: "catalog" }
  | { name: "quote"; quoteCaseId?: string; candidateId?: string; dealId?: string }
  | { name: "finance" }
  | { name: "roi"; cohortId?: string; currency?: string; closureVersionId?: string };

export type GrowthMode =
  | { kind: "demo" }
  | { kind: "real"; bootstrap: Extract<GrowthBootstrapResponse, { status: "ready" }> };

export type GrowthUnavailable = {
  kind: "unavailable";
  reason: "workspace_selection_required" | "contract_mismatch" | "feature_disabled";
};
```

## File Responsibility Map

- `contracts/openapi/growth-advisor-quote-roi.v1.yaml`: 所有 growth HTTP operations、请求、响应、headers 和错误信封的发布源。
- `contracts/json-schema/growth-*.v1.schema.json`: bootstrap、目录、报价、账本、批次、ROI 和建议的封闭领域 DTO。
- `contracts/scripts/build-growth-contract-release.mjs`: 将契约 bundle 为规范 JSON，计算 hash 并生成不可变 release。
- `backend/src/growth-openapi.ts`: 将 production OpenAPI 3.0 builder 暴露的 growth operations 与静态 3.1 contract 对齐。
- `backend/src/growth-bootstrap-router.ts`: 返回当前授权工作区、capabilities、features 和部署中的 contract identity。
- `backend/src/growth-commercial-application.ts`: 创建唯一 Growth router/service/tool-port composition，后续领域只向该实例注册。
- `backend/src/growth-commercial-runtime-bridge.ts`: server 的唯一 Growth mount point；install 一次并负责逆序关闭。
- `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/contracts/pinned/**`: 前端当前发布所锁定的后端 artifact，不是可编辑权威源。
- `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/generated/growth-advisor-quote-roi.ts`: openapi-typescript 生成文件，业务代码不得手改。
- `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/runtime.ts`: bootstrap、mode、route 和页面 controller 生命周期的唯一编排器。
- `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/<domain>/{api,controller,view}.ts`: transport、状态机和纯 HTML presenter 三层边界。

---

### Task 1: Publish the Canonical Growth OpenAPI and JSON Schemas

**Files:**
- Create: `contracts/openapi/growth-advisor-quote-roi.v1.yaml`
- Create: `contracts/json-schema/growth-bootstrap.v1.schema.json`
- Create: `contracts/json-schema/catalog-item.v1.schema.json`
- Create: `contracts/json-schema/package-version.v1.schema.json`
- Create: `contracts/json-schema/pricing-policy-version.v1.schema.json`
- Create: `contracts/json-schema/quote-case.v1.schema.json`
- Create: `contracts/json-schema/quote-version.v1.schema.json`
- Create: `contracts/json-schema/quote-approval.v1.schema.json`
- Create: `contracts/json-schema/quote-publication-operation.v1.schema.json`
- Create: `contracts/json-schema/acquisition-cost-ledger.v1.schema.json`
- Create: `contracts/json-schema/financial-ledger.v1.schema.json`
- Create: `contracts/json-schema/allocation-set.v1.schema.json`
- Create: `contracts/json-schema/finance-import-operation.v1.schema.json`
- Create: `contracts/json-schema/acquisition-cohort.v1.schema.json`
- Create: `contracts/json-schema/roi-closure.v1.schema.json`
- Create: `contracts/json-schema/growth-performance.v1.schema.json`
- Create: `contracts/json-schema/advisor-today.v1.schema.json`
- Create: `contracts/json-schema/advisor-recommendation.v1.schema.json`
- Create: `contracts/test/growth-openapi.test.mjs`
- Modify: `contracts/test/helpers.mjs`

**Interfaces:**
- Consumes: the routes and domain fields in `docs/superpowers/specs/2026-08-09-ai-growth-advisor-quote-roi-design.md`, existing `ApiError`, bearer/cookie authentication, `Idempotency-Key`, `If-Match`, `ETag`, pagination and cursor conventions.
- Produces: OpenAPI operations whose `operationId` values are stable lower-camel names; components named `ApiError`, `GrowthBootstrapResponse`, `CatalogItem`, `CatalogItemPagedResult`, `PackageVersion`, `PricingPolicyVersion`, `QuoteCase`, `CommercialBindingSnapshot`, `QuotePreviewInput`, `QuotePreviewIdentity`, `QuotePreviewResult`, `QuoteVersion`, `QuoteApproval`, `QuotePublicationOperation`, `DealDecisionInput`, `AcquisitionCostEntry`, `AcquisitionCostEstimate`, `FinancialFact`, `FinancialFactCorrectionInput`, `FinancialFactCorrectionResult`, `LedgerVerificationEvent`, `FinancialSourceReport`, `AttributionAllocationSet`, `CashSettlementAllocationSet`, `FinanceImportPreview`, `FinanceImportOperation`, `FinanceImportRowError`, `AcquisitionCohort`, `RoiClosureVersion`, `GrowthPerformanceQuery`, `ExpectedRoiCurrencyView`, `ActualRoiCurrencyView`, `CashCurrencyView`, `RoiCoverageSnapshot`, `RoiGapCode`, `GrowthPerformanceResponse`, `PriorityCustomerView`, `PendingQuoteApprovalView`, `FinancialDataGapView`, `AdvisorTodayQuery`, `AdvisorTodayResponse`, `AdvisorRecommendation`, `AdvisorRecommendationTransitionInput`, and `AdvisorCopilotTaskResult`.
- Produces: generated response aliases `AsyncOperation`, `CopilotSession`, `CopilotMessage`, `CopilotMessagePagedResult`, and `CopilotTask` by `$ref`-reusing the existing canonical acquisition JSON Schemas. These are type-only component exports for the existing `/api/v1/acquisition/copilot/sessions|messages|tasks` surface; this Growth contract does not republish, shadow, or alter those legacy paths.
- Produces: generated `AdvisorRecommendation` whose action, metric, evidence and entity refs are structurally identical to the Advisor domain unions below. Each JSON Schema union is a closed `oneOf` discriminated by `kind`; a generic `{ kind, id, revision }` ref is not a compatible fallback, and `create_quote_approval_task.quoteVersionRevision` is required.
- Produces: the one closed `FinancialDataGapCode` union used by Finance, Advisor and generated frontend types: `"unverified_cost" | "unverified_financial_fact" | "missing_cogs" | "unmatched_payment" | "missing_commercial_binding" | "import_requires_review"`. No plan may introduce a synonym such as `missing_verified_cost`.
- Produces: closed `FinancialDataGapSourceType = "cost_entry" | "financial_fact" | "finance_import" | "commercial_binding"`; a financial-gap metric ref binds exact code/source type/source ID/source snapshot hash/currency/as-of and carries `cohortId` as required nullable derived context (`null` when unassociated), never as source authority.
- Produces: `GrowthRoiSliceKey = "all" | \`plan:${string}\`` with JSON Schema pattern `^(?:all|plan:.+)$`; `growth_performance`, `roi_snapshot`, and `closure_version` all consume that same component, so `plan:` is invalid.
- Produces: customer entity refs bind required `quoteVersionId`, frozen `handoffContentHash`, and `bindingHashSchemaVersion`; their verifier also requires the frozen binding snapshot's `customerId` to equal `id` and the snapshot to bind that exact QuoteVersion. Deal entity refs bind required `quoteVersionId`, `dealContentHash`, `bindingHashSchemaVersion`, and required nullable `dealAuthorityRevision`. Neither branch accepts a fabricated generic `revision`, mutable ownership head, ambiguous QuoteVersion, or dual missing/null representation.
- Produces: `ledger_entry` evidence binds required `ledgerType: "cost" | "financial"` and `currency` in addition to its entry/event/revision/hash identity, so the verifier can call Finance's exact typed `getVerifiedAt` reader without guessing a ledger or currency.
- Produces: the exact closed `AdvisorEntityRef` kinds are `customer | deal | quote_version | closure_version`. `candidate`, `quote_case`, and `cohort` are deliberately absent because none has an as-of historical authority reader; candidate authority instead remains in the strong `priority_score` metric and `candidate_evidence` evidence refs. The schema and generated types must reject all three removed entity kinds instead of accepting a nominal `{ id, revision }` reference.

```ts
export type AdvisorRecommendedAction =
  | { kind: "open_candidate"; candidateId: string }
  | { kind: "create_quote_draft"; quoteCaseId: string; quoteCaseRevision: number; quoteInput: QuotePreviewInput; previewIdentity: QuotePreviewIdentity }
  | { kind: "create_quote_approval_task"; quoteVersionId: string; quoteVersionRevision: number }
  | { kind: "create_sales_todo"; customerId: string; dueAt: string }
  | { kind: "complete_cost_data"; cohortId: string }
  | { kind: "complete_financial_fact"; dealId: string };

export type GrowthRoiSliceKey = "all" | `plan:${string}`;

export type FinancialDataGapSourceType =
  | "cost_entry"
  | "financial_fact"
  | "finance_import"
  | "commercial_binding";

export type AdvisorMetricRef =
  | { kind: "growth_performance"; cohortId: string; currency: string; asOf: string; planId: string | null; closureVersionId: string | null; sliceKey: GrowthRoiSliceKey; calculationHash: `sha256:${string}` }
  | { kind: "quote_preview"; quoteCaseId: string; previewIdentity: QuotePreviewIdentity; inputSnapshotHash: `sha256:${string}`; calculationHash: `sha256:${string}` }
  | { kind: "priority_score"; candidateId: string; qualificationDecisionId: string; qualificationDecisionVersion: string; inputSnapshotHash: `sha256:${string}` }
  | { kind: "financial_data_gap"; gapCode: FinancialDataGapCode; sourceType: FinancialDataGapSourceType; sourceId: string; sourceSnapshotHash: `sha256:${string}`; cohortId: string | null; currency: string; asOf: string };

export type AdvisorEvidenceRef =
  | { kind: "candidate_evidence"; candidateId: string; qualificationDecisionId: string; qualificationDecisionVersion: string; inputSnapshotHash: `sha256:${string}`; evidenceId: string; contentHash: `sha256:${string}` }
  | { kind: "quote_version"; quoteVersionId: string; lifecycleRevision: number; commercialAmountHash: `sha256:${string}` }
  | { kind: "ledger_entry"; ledgerType: "cost" | "financial"; ledgerEntryId: string; currency: string; verificationEventId: string; verificationRevision: number; evidenceHash: `sha256:${string}` }
  | { kind: "roi_snapshot"; closureVersionId: string; version: number; sliceKey: GrowthRoiSliceKey; calculationHash: `sha256:${string}` };

export type AdvisorEntityRef =
  | { kind: "customer"; id: string; quoteVersionId: string; handoffContentHash: `sha256:${string}`; bindingHashSchemaVersion: string }
  | { kind: "deal"; id: string; quoteVersionId: string; dealContentHash: `sha256:${string}`; bindingHashSchemaVersion: string; dealAuthorityRevision: number | null }
  | { kind: "quote_version"; id: string; lifecycleRevision: number; commercialAmountHash: `sha256:${string}` }
  | { kind: "closure_version"; id: string; version: number; sliceKey: GrowthRoiSliceKey; calculationHash: `sha256:${string}` };

export type FinancialDataGapCode =
  | "unverified_cost"
  | "unverified_financial_fact"
  | "missing_cogs"
  | "unmatched_payment"
  | "missing_commercial_binding"
  | "import_requires_review";
```

- [ ] **Step 1: Write the failing contract surface test**

Add this path table and assertion to `contracts/test/growth-openapi.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  loadNamedJsonSchema,
  loadNamedOpenApiSource,
  loadSchemaRegistry
} from "./helpers.mjs";

const operations = {
  "/api/v1/growth/bootstrap": ["get"],
  "/api/v1/catalog/items": ["get", "post"],
  "/api/v1/catalog/items/{id}": ["get", "patch"],
  "/api/v1/catalog/items/{id}/retire": ["post"],
  "/api/v1/catalog/pricing-policies": ["get", "post"],
  "/api/v1/catalog/pricing-policies/{id}": ["get"],
  "/api/v1/catalog/pricing-policies/{id}/activate": ["post"],
  "/api/v1/catalog/pricing-policies/{id}/retire": ["post"],
  "/api/v1/catalog/packages/{itemId}/versions": ["get", "post"],
  "/api/v1/catalog/package-versions/{id}": ["get", "patch"],
  "/api/v1/catalog/package-versions/{id}/activate": ["post"],
  "/api/v1/catalog/package-versions/{id}/retire": ["post"],
  "/api/v1/quotes/cases": ["get", "post"],
  "/api/v1/quotes/cases/{id}": ["get"],
  "/api/v1/quotes/cases/{id}/bind-deal": ["post"],
  "/api/v1/quotes/cases/{id}/close": ["post"],
  "/api/v1/quotes/cases/{id}/cancel": ["post"],
  "/api/v1/quotes/cases/{id}/preview": ["post"],
  "/api/v1/quotes/cases/{id}/versions": ["get", "post"],
  "/api/v1/quotes/versions/{id}": ["get"],
  "/api/v1/quotes/versions/{id}/submit": ["post"],
  "/api/v1/quotes/versions/{id}/approve": ["post"],
  "/api/v1/quotes/versions/{id}/reject": ["post"],
  "/api/v1/quotes/versions/{id}/expire": ["post"],
  "/api/v1/quotes/versions/{id}/approvals": ["get"],
  "/api/v1/quotes/publication-operations/{id}": ["get"],
  "/api/v1/quotes/publication-operations/{id}/retry": ["post"],
  "/api/v1/quotes/deals/{dealId}/decision": ["post"],
  "/api/v1/acquisition/cost-entries": ["get", "post"],
  "/api/v1/acquisition/cost-estimates": ["get", "post"],
  "/api/v1/acquisition/cost-estimates/{id}/activate": ["post"],
  "/api/v1/acquisition/cost-estimates/{id}/supersede": ["post"],
  "/api/v1/acquisition/cost-entries/{id}/verify": ["post"],
  "/api/v1/acquisition/cost-entries/{id}/reject": ["post"],
  "/api/v1/acquisition/cost-entries/{id}/reverse": ["post"],
  "/api/v1/acquisition/cost-entries/{id}/correct": ["post"],
  "/api/v1/acquisition/attribution-allocation-sets": ["get", "post"],
  "/api/v1/acquisition/attribution-allocation-sets/{id}": ["get"],
  "/api/v1/acquisition/attribution-allocation-sets/{id}/activate": ["post"],
  "/api/v1/finance/facts": ["get", "post"],
  "/api/v1/finance/facts/{id}/verify": ["post"],
  "/api/v1/finance/facts/{id}/reject": ["post"],
  "/api/v1/finance/facts/{id}/reverse": ["post"],
  "/api/v1/finance/facts/{id}/correct": ["post"],
  "/api/v1/finance/source-reports": ["get", "post"],
  "/api/v1/finance/source-reports/{id}": ["get"],
  "/api/v1/finance/settlement-allocation-sets": ["get", "post"],
  "/api/v1/finance/settlement-allocation-sets/{id}": ["get"],
  "/api/v1/finance/settlement-allocation-sets/{id}/activate": ["post"],
  "/api/v1/finance/import-templates/{kind}": ["get"],
  "/api/v1/finance/imports/preview": ["post"],
  "/api/v1/finance/imports/{previewId}/commit": ["post"],
  "/api/v1/finance/imports/{id}": ["get"],
  "/api/v1/finance/imports/{id}/errors": ["get"],
  "/api/v1/acquisition/cohorts": ["get", "post"],
  "/api/v1/acquisition/cohorts/{id}": ["get"],
  "/api/v1/acquisition/cohorts/{id}/attestations": ["get", "post"],
  "/api/v1/acquisition/cohorts/{id}/close": ["post"],
  "/api/v1/acquisition/cohorts/{id}/closures": ["get"],
  "/api/v1/acquisition/roi-closures/{closureVersionId}/reopen": ["post"],
  "/api/v1/acquisition/growth-performance": ["get"],
  "/api/v1/acquisition/advisor/today": ["get"],
  "/api/v1/acquisition/advisor/recommendations/{id}/accept": ["post"],
  "/api/v1/acquisition/advisor/recommendations/{id}/ignore": ["post"],
  "/api/v1/acquisition/advisor/recommendations/{id}/complete": ["post"]
};

const standardHttpMethods = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace"
]);

const advisorQuoteRiskContractFixture = () => ({
  id: "recommendation-1",
  workspaceId: "workspace-1",
  revision: 1,
  audienceRole: "manager",
  type: "quote_risk",
  summary: "Prioritize the submitted quote that is about to expire",
  rationale: "Quote version quote-v3 expires in 12 hours",
  metricRefs: [{
    kind: "quote_preview",
    quoteCaseId: "quote-case-3",
    previewIdentity: {
      inputSnapshotHash: `sha256:${"a".repeat(64)}`,
      calculationHash: `sha256:${"b".repeat(64)}`,
      pricingPolicyVersionId: "pricing-policy-v7",
      pricingPolicyRevision: 7,
      packageVersionId: "package-v3",
      formulaVersion: "quote-calculation.v1"
    },
    inputSnapshotHash: `sha256:${"a".repeat(64)}`,
    calculationHash: `sha256:${"b".repeat(64)}`
  }],
  evidenceRefs: [{
    kind: "quote_version",
    quoteVersionId: "quote-v3",
    lifecycleRevision: 3,
    commercialAmountHash: `sha256:${"c".repeat(64)}`
  }],
  entityRefs: [{
    kind: "quote_version",
    id: "quote-v3",
    lifecycleRevision: 3,
    commercialAmountHash: `sha256:${"c".repeat(64)}`
  }],
  confidenceBps: 8700,
  riskLevel: "high",
  recommendedAction: {
    kind: "create_quote_approval_task",
    quoteVersionId: "quote-v3",
    quoteVersionRevision: 3
  },
  status: "proposed",
  assignedTo: null,
  acceptedBy: null,
  acceptedAt: null,
  outcomeRefs: [],
  dataAsOf: "2026-08-09T08:00:00.000Z",
  inputSnapshotHash: `sha256:${"d".repeat(64)}`,
  modelSnapshotRef: "model-snapshot-1",
  promptVersion: "growth-advisor.v1",
  schemaVersion: "advisor-recommendation.v1",
  generationIdempotencyKey: "advisor-generation:workspace-1:2026-08-09",
  expiresAt: "2026-08-10T08:00:00.000Z",
  createdAt: "2026-08-09T08:00:00.000Z",
  updatedAt: "2026-08-09T08:00:00.000Z"
});

function findClosedPropertyEnum(
  schema: unknown,
  definitionName: string,
  propertyName: string
): string[] {
  const root = schema as Record<string, unknown>;
  const definitions = (root.$defs ?? root.definitions ?? {}) as Record<string, unknown>;
  const start = (definitions[definitionName] ?? root) as unknown;
  const matches: string[][] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const properties = record.properties as Record<string, unknown> | undefined;
    const property = properties?.[propertyName] as { enum?: unknown } | undefined;
    if (Array.isArray(property?.enum) && property.enum.every((item) => typeof item === "string")) {
      matches.push(property.enum as string[]);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(start);
  assert.equal(matches.length, 1, `${definitionName}.${propertyName}`);
  return matches[0]!;
}

test("growth contract publishes the exact route surface", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  assert.deepEqual(Object.keys(document.paths).sort(), Object.keys(operations).sort());
  for (const [path, methods] of Object.entries(operations)) {
    assert.deepEqual(
      Object.keys(document.paths[path])
        .map((key) => key.toLowerCase())
        .filter((key) => standardHttpMethods.has(key))
        .sort(),
      [...methods].sort(),
      path
    );
  }
  const bootstrap = await loadNamedJsonSchema("growth-bootstrap.v1.schema.json");
  assert.equal(
    JSON.stringify(bootstrap).includes("acquisition.outcome.reconcile.internal"),
    false
  );
});

test("every asOf boundary rejects future cutoff from one server-owned request clock", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  for (const [path, method] of [
    ["/api/v1/acquisition/growth-performance", "get"],
    ["/api/v1/acquisition/advisor/today", "get"],
    ["/api/v1/acquisition/cohorts/{id}/close", "post"]
  ]) {
    const operation = document.paths[path][method];
    assert.deepEqual(operation["x-goodjob-as-of-upper-bound"], {
      clock: method === "get" ? "readStartedAt" : "commandStartedAt",
      maxFutureSkewSeconds: 1,
      effectiveCutoff: "min(requestedAsOf,startedAt)",
      errorStatus: 422,
      errorCode: "invalid_as_of",
      zeroWritesOnReject: true
    });
    assert.ok(operation.responses["422"], `${method.toUpperCase()} ${path}`);
  }
});

test("advisor recommendation keeps kind-specific refs and quote action revision", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("advisor-recommendation");
  assert.ok(validate);

  const fixture = advisorQuoteRiskContractFixture();
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));

  const missingQuoteRevision = structuredClone(fixture);
  delete missingQuoteRevision.recommendedAction.quoteVersionRevision;
  assert.equal(validate(missingQuoteRevision), false);

  const legacyGenericRefs = structuredClone(fixture);
  legacyGenericRefs.metricRefs = [{
    kind: "quote_preview",
    id: "preview-v3",
    revision: 3,
    calculationHash: `sha256:${"b".repeat(64)}`
  }];
  assert.equal(validate(legacyGenericRefs), false);
});

test("advisor refs freeze gap sources, non-empty ROI slices and real customer/deal authorities", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("advisor-recommendation");
  assert.ok(validate);

  const gap = advisorQuoteRiskContractFixture();
  gap.metricRefs = [{
    kind: "financial_data_gap",
    gapCode: "missing_commercial_binding",
    sourceType: "commercial_binding",
    sourceId: "deal-7",
    sourceSnapshotHash: `sha256:${"e".repeat(64)}`,
    cohortId: null,
    currency: "CNY",
    asOf: "2026-08-09T08:00:00.000Z"
  }];
  assert.equal(validate(gap), true, JSON.stringify(validate.errors));
  const unknownGapCode = structuredClone(gap);
  unknownGapCode.metricRefs[0].gapCode = "missing_verified_cost";
  assert.equal(validate(unknownGapCode), false);
  const unknownGapSource = structuredClone(gap);
  unknownGapSource.metricRefs[0].sourceType = "inferred_by_model";
  assert.equal(validate(unknownGapSource), false);
  const missingGapSource = structuredClone(gap);
  delete missingGapSource.metricRefs[0].sourceId;
  assert.equal(validate(missingGapSource), false);
  const missingGapSourceSnapshot = structuredClone(gap);
  delete missingGapSourceSnapshot.metricRefs[0].sourceSnapshotHash;
  assert.equal(validate(missingGapSourceSnapshot), false);
  const missingGapCohortRepresentation = structuredClone(gap);
  delete missingGapCohortRepresentation.metricRefs[0].cohortId;
  assert.equal(validate(missingGapCohortRepresentation), false);

  const sliced = advisorQuoteRiskContractFixture();
  sliced.metricRefs = [{
    kind: "growth_performance",
    cohortId: "cohort-1",
    currency: "CNY",
    asOf: "2026-08-09T08:00:00.000Z",
    planId: "plan-1",
    closureVersionId: "closure-1",
    sliceKey: "plan:plan-1",
    calculationHash: `sha256:${"f".repeat(64)}`
  }];
  sliced.evidenceRefs = [{
    kind: "roi_snapshot",
    closureVersionId: "closure-1",
    version: 1,
    sliceKey: "plan:plan-1",
    calculationHash: `sha256:${"f".repeat(64)}`
  }];
  sliced.entityRefs = [{
    kind: "closure_version",
    id: "closure-1",
    version: 1,
    sliceKey: "plan:plan-1",
    calculationHash: `sha256:${"f".repeat(64)}`
  }];
  assert.equal(validate(sliced), true, JSON.stringify(validate.errors));
  for (const branch of ["metricRefs", "evidenceRefs", "entityRefs"]) {
    const emptyPlanSlice = structuredClone(sliced);
    emptyPlanSlice[branch][0].sliceKey = "plan:";
    assert.equal(validate(emptyPlanSlice), false, branch);
  }

  const ledgerBound = advisorQuoteRiskContractFixture();
  ledgerBound.evidenceRefs = [{
    kind: "ledger_entry",
    ledgerType: "financial",
    ledgerEntryId: "financial-fact-1",
    currency: "CNY",
    verificationEventId: "verification-1",
    verificationRevision: 2,
    evidenceHash: `sha256:${"8".repeat(64)}`
  }];
  assert.equal(validate(ledgerBound), true, JSON.stringify(validate.errors));
  const missingLedgerType = structuredClone(ledgerBound);
  delete missingLedgerType.evidenceRefs[0].ledgerType;
  assert.equal(validate(missingLedgerType), false);
  const unknownLedgerType = structuredClone(ledgerBound);
  unknownLedgerType.evidenceRefs[0].ledgerType = "combined";
  assert.equal(validate(unknownLedgerType), false);
  const missingLedgerCurrency = structuredClone(ledgerBound);
  delete missingLedgerCurrency.evidenceRefs[0].currency;
  assert.equal(validate(missingLedgerCurrency), false);

  const authority = advisorQuoteRiskContractFixture();
  authority.entityRefs = [
    {
      kind: "customer",
      id: "customer-1",
      quoteVersionId: "quote-version-1",
      handoffContentHash: `sha256:${"0".repeat(64)}`,
      bindingHashSchemaVersion: "commercial-binding.v1"
    },
    {
      kind: "deal",
      id: "deal-1",
      quoteVersionId: "quote-version-1",
      dealContentHash: `sha256:${"1".repeat(64)}`,
      bindingHashSchemaVersion: "deal-binding.v1",
      dealAuthorityRevision: null
    }
  ];
  assert.equal(validate(authority), true, JSON.stringify(validate.errors));
  const genericCustomer = structuredClone(authority);
  genericCustomer.entityRefs[0] = { kind: "customer", id: "customer-1", revision: 4 };
  assert.equal(validate(genericCustomer), false);
  const missingCustomerHash = structuredClone(authority);
  delete missingCustomerHash.entityRefs[0].handoffContentHash;
  assert.equal(validate(missingCustomerHash), false);
  const missingCustomerQuoteVersion = structuredClone(authority);
  delete missingCustomerQuoteVersion.entityRefs[0].quoteVersionId;
  assert.equal(validate(missingCustomerQuoteVersion), false);
  const genericDeal = structuredClone(authority);
  genericDeal.entityRefs[1] = { kind: "deal", id: "deal-1", revision: 7 };
  assert.equal(validate(genericDeal), false);
  const missingDealAuthority = structuredClone(authority);
  delete missingDealAuthority.entityRefs[1].dealAuthorityRevision;
  assert.equal(validate(missingDealAuthority), false);
  const missingDealQuoteVersion = structuredClone(authority);
  delete missingDealQuoteVersion.entityRefs[1].quoteVersionId;
  assert.equal(validate(missingDealQuoteVersion), false);

  const removedCandidate = structuredClone(authority);
  removedCandidate.entityRefs = [{ kind: "candidate", id: "candidate-1", revision: 1 }];
  assert.equal(validate(removedCandidate), false);
  const removedQuoteCase = structuredClone(authority);
  removedQuoteCase.entityRefs = [{ kind: "quote_case", id: "quote-case-1", revision: 1 }];
  assert.equal(validate(removedQuoteCase), false);
  const removedCohort = structuredClone(authority);
  removedCohort.entityRefs = [{ kind: "cohort", id: "cohort-1", revision: 1 }];
  assert.equal(validate(removedCohort), false);
});

test("financial data gap codes are one exact closed enum", async () => {
  const schema = await loadNamedJsonSchema("advisor-today.v1.schema.json");
  assert.deepEqual(findClosedPropertyEnum(schema, "FinancialDataGapView", "code"), [
    "unverified_cost",
    "unverified_financial_fact",
    "missing_cogs",
    "unmatched_payment",
    "missing_commercial_binding",
    "import_requires_review"
  ]);
  assert.equal(JSON.stringify(schema).includes("missing_verified_cost"), false);
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
npm run test --workspace contracts -- --test-name-pattern="growth contract publishes|asOf boundary rejects|advisor recommendation keeps|advisor refs freeze"
```

Expected: FAIL because `growth-advisor-quote-roi.v1.yaml` and `loadNamedOpenApiSource` do not exist.

- [ ] **Step 3: Implement named contract loading and the minimal closed schemas**

Add to `contracts/test/helpers.mjs`:

```js
export async function loadNamedOpenApiSource(filename) {
  const source = await readFile(path.join(root, "openapi", filename), "utf8");
  return YAML.parse(source, { merge: true, maxAliasCount: -1 });
}

export async function loadNamedJsonSchema(filename) {
  const source = await readFile(path.join(root, "json-schema", filename), "utf8");
  return JSON.parse(source);
}
```

Start `growth-advisor-quote-roi.v1.yaml` with the exact identity and bootstrap operation:

```yaml
openapi: 3.1.0
info:
  title: GoodJob Growth Advisor, Quote and ROI API
  version: 1.0.0
servers:
  - url: /
paths:
  /api/v1/growth/bootstrap:
    get:
      operationId: getGrowthBootstrap
      security:
        - bearerAuth: []
        - cookieAuth: []
      responses:
        '200':
          description: Authorized concrete workspace context or actionable workspace-selection state
          content:
            application/json:
              schema:
                $ref: ../json-schema/growth-bootstrap.v1.schema.json
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
    cookieAuth:
      type: apiKey
      in: cookie
      name: gj_session
```

Implement `growth-bootstrap.v1.schema.json` as a closed `oneOf` matching `GrowthBootstrapResponse`. Define every other schema with `additionalProperties: false`, integer money/BPS bounds, explicit enums and refs. In `advisor-recommendation.v1.schema.json`, implement `AdvisorRecommendedAction`, `AdvisorMetricRef`, `AdvisorEvidenceRef`, and `AdvisorEntityRef` as the exact closed `oneOf` branches frozen in this task's Interfaces block; every branch has `additionalProperties: false`, and `create_quote_approval_task` requires positive-integer `quoteVersionRevision`. The entity union contains only `customer`, `deal`, `quote_version`, and `closure_version`; explicitly reject removed `candidate`, `quote_case`, and `cohort` refs because no as-of historical authority reader exists for them. Candidate authority is expressed only through the strong `priority_score` metric and `candidate_evidence` evidence refs. Define one reusable `GrowthRoiSliceKey` schema with `pattern: "^(?:all|plan:.+)$"` and reference it from all three metric/evidence/entity branches. Define the exact six-value `FinancialDataGapCode` and four-value `FinancialDataGapSourceType`; the gap branch requires `gapCode`, `sourceType`, `sourceId`, `sourceSnapshotHash`, `cohortId`, `currency`, and `asOf`, with `cohortId` accepting string or null but never omission. `ledger_entry` requires `ledgerType` from the closed `cost | financial` enum plus non-empty `currency`, so verification selects one exact Finance reader. Customer requires `quoteVersionId`, `handoffContentHash`, and non-empty `bindingHashSchemaVersion`; the authority verifier confirms the frozen binding snapshot's `customerId` equals `id` and that its QuoteVersion binding equals `quoteVersionId`. Deal requires `quoteVersionId`, `dealContentHash`, non-empty `bindingHashSchemaVersion`, and `dealAuthorityRevision` accepting a non-negative integer or null but never omission. Both forbid `revision`. The generated TypeScript must expose these same discriminated unions without widening any branch to generic `id`/`revision` refs. `AdvisorRecommendationTransitionInput` is closed to `{ reason: string | null }`; it forbids `outcomeRefs`, actions, workspace/actor and authority IDs. Complete resolves the exact persisted action receipt server-side and fails if none belongs to the same recommendation revision/stable action hash. Add component-only `$ref` aliases for the existing `async-operation.v1.schema.json`, `copilot-session.v1.schema.json`, `copilot-message.v1.schema.json`, plus the exact closed `CopilotMessagePagedResult`, and `copilot-task.v1.schema.json`; do not copy their fields or add their paths to the Growth path table. Mark all three `asOf` inputs `format: date-time`, publish the exact `x-goodjob-as-of-upper-bound` object from Step 1 on their operations, and declare `422 ApiError`; each router freezes `readStartedAt`/`commandStartedAt` at request entry and calls Foundation's shared `assertGrowthAsOfNotFuture(asOf, frozenStartedAt, 1000)` before any command/repository work. Values beyond that upper bound map to `422 invalid_as_of`, and Closure performs zero writes on rejection. Accepted values are converted to `effectiveAsOf = min(requestedAsOf, frozenStartedAt)`, and repositories, Closure membership/evidence readers, calculation hashes, and responses use only that effective cutoff. Use `0..10000` only for probability/discount/coverage/allocation inputs; signed margin, profit, contribution and ROI outputs use safe signed-integer bounds and include negative contract examples. `QuotePreviewResult.grossMarginBps` is nullable only for a `hard_blocked` non-positive quoted amount, where the ratio is mathematically undefined. `ExpectedRoiCurrencyView`, computed `ActualRoiCurrencyView`, and `CashCurrencyView` each use a closed `amountVisibility` oneOf. Full expected requires weighted-gross-profit and estimated-cost minors; full actual requires verified-gross-profit and acquisition-cost minors; full cash requires verified-contract, acquisition-cost, payment, refund, bad-debt and net-cash minors. Every redacted branch forbids all money-minor properties while retaining statuses/BPS, coverage, authority IDs and closure evidence. `CashCurrencyView` separately requires closed `contractRoas`, `cashMultiple`, and `collectionRate` results with exact formula versions (`contract-roas.v1`, `cash-multiple.v1`, `collection-rate.v1`) and zero-denominator `not_available` reasons; it does not expose the old ambiguous `paymentRateBps`. `FinancialFact` output includes the server-frozen `quoteVersionId`, `commercialAmountHash`, `dealAuthorityRevision`, and `commercialBindingSnapshot`, while create/import input schemas exclude those fields and reject them as additional properties. Add all route operations from the failing table; every mutation must declare required `Idempotency-Key` and CSRF. Mutations of an existing resource also declare the state-specific `If-Match`; `createCatalogItem` omits `If-Match` because no resource revision exists before collection creation, and its success response supplies the first `ETag`. Every list must declare cursor/limit/sort plus its authorized workspace projection.

Freeze `FinanceImportRowErrorCode` in `finance-import-operation.v1.schema.json` and generated TypeScript as exactly `spreadsheet_formula_forbidden | verified_import_forbidden | required_field_missing | money_invalid | currency_invalid | business_time_invalid | commercial_binding_invalid | row_identity_conflict | financial_fact_conflict | financial_fact_amount_invalid | amount_out_of_range`. Positive fixtures include all three financial-fact errors; unknown codes and omission are negative fixtures. Direct Finance commands expose the same stable `financial_fact_conflict`, `financial_fact_amount_invalid`, and `amount_out_of_range` API error codes rather than widening them to arbitrary strings.

Freeze `QuotePreviewResult` as a closed `oneOf`, never as one shape with conditionally negative price fields. The actionable branch requires `amountState:"actionable"`, nonnegative `netProductAmountMinor`, strictly positive `quotedAmountMinor`, signed `estimatedGrossProfitMinor`/`estimatedContributionMinor`/`grossMarginBps`, and the normal gate. The non-positive diagnostic branch requires `amountState:"non_positive_diagnostic"`, forbids `netProductAmountMinor`, `quotedAmountMinor`, QuoteVersion identity and all approval/publication fields, requires signed-safe `diagnosticNetProductAmountMinor` and `diagnosticQuotedAmountMinor`, fixes `grossMarginBps:null`, and requires `gate.status:"hard_blocked"` with exact reason `net_product_amount_not_positive | quoted_amount_not_positive`. Schema/generated fixtures must reject a negative actionable price, any diagnostic amount in the actionable branch, and any normal price/version field in the diagnostic branch. Draft/formal QuoteVersion schemas accept only the actionable calculation identity with `quotedAmountMinor>0` and can never serialize the diagnostic branch.

The `candidate_evidence` branch is self-locating and requires `candidateId + qualificationDecisionId + qualificationDecisionVersion + inputSnapshotHash + evidenceId + contentHash`; reject a bare evidence ID/hash because the verifier may not scan candidates or a Top-N page to discover its authority event. Add negative fixtures for every missing authority field and for a mismatched qualification snapshot.

- [ ] **Step 4: Run contract and existing acquisition contract tests**

Run:

```bash
npm run test --workspace contracts
npm run test:contract-drift --workspace backend
```

Expected: PASS; the old `ai-acquisition.v1.yaml` path surface remains unchanged.

- [ ] **Step 5: Commit the canonical contract**

```bash
git add contracts/openapi/growth-advisor-quote-roi.v1.yaml \
  contracts/json-schema/growth-bootstrap.v1.schema.json \
  contracts/json-schema/catalog-item.v1.schema.json \
  contracts/json-schema/package-version.v1.schema.json \
  contracts/json-schema/pricing-policy-version.v1.schema.json \
  contracts/json-schema/quote-case.v1.schema.json \
  contracts/json-schema/quote-version.v1.schema.json \
  contracts/json-schema/quote-approval.v1.schema.json \
  contracts/json-schema/quote-publication-operation.v1.schema.json \
  contracts/json-schema/acquisition-cost-ledger.v1.schema.json \
  contracts/json-schema/financial-ledger.v1.schema.json \
  contracts/json-schema/allocation-set.v1.schema.json \
  contracts/json-schema/finance-import-operation.v1.schema.json \
  contracts/json-schema/acquisition-cohort.v1.schema.json \
  contracts/json-schema/roi-closure.v1.schema.json \
  contracts/json-schema/growth-performance.v1.schema.json \
  contracts/json-schema/advisor-today.v1.schema.json \
  contracts/json-schema/advisor-recommendation.v1.schema.json \
  contracts/test/growth-openapi.test.mjs \
  contracts/test/helpers.mjs
git commit -m "feat(contracts): publish growth quote roi contract"
```

---

### Task 2: Build Immutable Contract Releases and Hash Manifests

**Files:**
- Create: `contracts/scripts/build-growth-contract-release.mjs`
- Create: `contracts/test/growth-contract-release.test.mjs`
- Create: `contracts/releases/growth-advisor-quote-roi/1.0.0/openapi.json`
- Create: `contracts/releases/growth-advisor-quote-roi/1.0.0/manifest.json`
- Modify: `contracts/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `contracts/openapi/growth-advisor-quote-roi.v1.yaml`, all external JSON Schema refs, `GrowthContractManifest`.
- Produces: `buildGrowthContractRelease({ input, releasesRoot, check? }): Promise<GrowthContractManifest>`; it derives `<releasesRoot>/<bundled.info.version>/` only after strict SemVer validation, writes canonical UTF-8 `openapi.json` ending in one newline, and sets manifest `contractHash` to SHA-256 of those exact bytes. `--check` verifies the source-declared version directory without writing; normal mode creates a missing immutable version or byte-compares an existing version and rejects any collision instead of overwriting it.

- [ ] **Step 1: Write the failing deterministic-release test**

Create `contracts/test/growth-contract-release.test.mjs`:

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildGrowthContractRelease } from "../scripts/build-growth-contract-release.mjs";

test("growth release derives the version directory and never overwrites different bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "growth-contract-release-"));
  try {
    const input = new URL("../openapi/growth-advisor-quote-roi.v1.yaml", import.meta.url);
    const firstRoot = path.join(root, "first");
    const secondRoot = path.join(root, "second");
    const firstManifest = await buildGrowthContractRelease({ input, releasesRoot: firstRoot });
    const secondManifest = await buildGrowthContractRelease({ input, releasesRoot: secondRoot });
    const first = path.join(firstRoot, firstManifest.contractVersion);
    const second = path.join(secondRoot, secondManifest.contractVersion);
    const bytes = await readFile(path.join(first, "openapi.json"));
    const expectedHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assert.equal(firstManifest.contractVersion, "1.0.0");
    assert.equal(firstManifest.contractHash, expectedHash);
    assert.deepEqual(firstManifest, secondManifest);
    assert.deepEqual(bytes, await readFile(path.join(second, "openapi.json")));

    await buildGrowthContractRelease({ input, releasesRoot: firstRoot, check: true });
    const committedManifestBytes = await readFile(path.join(first, "manifest.json"));
    await writeFile(
      path.join(first, "manifest.json"),
      `${JSON.stringify({ ...firstManifest, contractHash: `sha256:${"9".repeat(64)}` }, null, 2)}\n`,
      "utf8"
    );
    await assert.rejects(
      buildGrowthContractRelease({ input, releasesRoot: firstRoot }),
      /immutable growth contract release collision for 1\.0\.0/u
    );
    await writeFile(path.join(first, "manifest.json"), committedManifestBytes);
    await writeFile(path.join(first, "openapi.json"), "{}\n", "utf8");
    await assert.rejects(
      buildGrowthContractRelease({ input, releasesRoot: firstRoot }),
      /immutable growth contract release collision for 1\.0\.0/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm run test --workspace contracts -- --test-name-pattern="growth release derives the version directory"
```

Expected: FAIL with module-not-found for `build-growth-contract-release.mjs`.

- [ ] **Step 3: Implement canonical bundling, hash calculation and check mode**

Implement and export this core from `build-growth-contract-release.mjs`:

```js
import SwaggerParser from "@apidevtools/swagger-parser";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])])
  );
}

const strictSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

async function readReleaseBytes(outputDirectory) {
  return Promise.all([
    readFile(path.join(outputDirectory, "openapi.json")),
    readFile(path.join(outputDirectory, "manifest.json"))
  ]);
}

async function releaseDirectoryExists(outputDirectory) {
  try {
    const metadata = await stat(outputDirectory);
    if (!metadata.isDirectory()) throw new Error("growth release path is not a directory");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function buildGrowthContractRelease({ input, releasesRoot, check = false }) {
  const bundled = await SwaggerParser.bundle(input);
  const contractVersion = bundled.info?.version;
  if (typeof contractVersion !== "string" || !strictSemver.test(contractVersion)) {
    throw new Error("OpenAPI info.version must be a strict SemVer release directory name");
  }
  const outputDirectory = path.join(releasesRoot, contractVersion);
  const bytes = Buffer.from(`${JSON.stringify(canonical(bundled), null, 2)}\n`, "utf8");
  const manifest = {
    name: "growth-advisor-quote-roi",
    contractVersion,
    contractHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    openapiVersion: "3.1.0"
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (await releaseDirectoryExists(outputDirectory)) {
    let committedOpenApi;
    let committedManifest;
    try {
      [committedOpenApi, committedManifest] = await readReleaseBytes(outputDirectory);
    } catch (error) {
      throw new Error(`immutable growth contract release collision for ${contractVersion}`, { cause: error });
    }
    if (!committedOpenApi.equals(bytes) || !committedManifest.equals(manifestBytes)) {
      throw new Error(`immutable growth contract release collision for ${contractVersion}`);
    }
    return manifest;
  }
  if (check) throw new Error(`Committed growth contract release ${contractVersion} is missing`);
  await mkdir(releasesRoot, { recursive: true });
  await mkdir(outputDirectory);
  await writeFile(path.join(outputDirectory, "openapi.json"), bytes, { flag: "wx" });
  await writeFile(path.join(outputDirectory, "manifest.json"), manifestBytes, { flag: "wx" });
  return manifest;
}

function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === metaUrl;
}

async function main(argv) {
  const allowed = new Set(["--check", "--print-version"]);
  if (argv.some((argument) => !allowed.has(argument)) || new Set(argv).size !== argv.length) {
    throw new Error("Usage: build-growth-contract-release.mjs [--check] [--print-version]");
  }
  const manifest = await buildGrowthContractRelease({
    input: new URL("../openapi/growth-advisor-quote-roi.v1.yaml", import.meta.url),
    releasesRoot: fileURLToPath(
      new URL("../releases/growth-advisor-quote-roi/", import.meta.url)
    ),
    check: argv.includes("--check")
  });
  if (argv.includes("--print-version")) process.stdout.write(`${manifest.contractVersion}\n`);
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));
```

Use these complete `scripts` objects rather than adding shell fragments. In `contracts/package.json`:

```json
{
  "scripts": {
    "generate:types": "node scripts/generate-frontend-contract-types.mjs",
    "check:types": "node scripts/generate-frontend-contract-types.mjs --check",
    "build:growth-release": "node scripts/build-growth-contract-release.mjs",
    "check:growth-release": "node scripts/build-growth-contract-release.mjs --check",
    "test": "node --test test/*.test.mjs"
  }
}
```

In the root `package.json`, preserve the existing ordering and use this complete `scripts` object:

```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:mysql --workspace backend\" \"npm run dev --workspace frontend\"",
    "dev:mysql": "concurrently \"npm run dev:mysql --workspace backend\" \"npm run dev --workspace frontend\"",
    "build": "npm run build --workspace backend && npm run build --workspace frontend",
    "generate:frontend-contract-types": "npm run generate:types --workspace contracts",
    "check:generated-acquisition-types": "npm run check:types --workspace contracts",
    "build:growth-contract-release": "npm run build:growth-release --workspace contracts",
    "check:growth-contract-release": "npm run check:growth-release --workspace contracts",
    "check:acquisition-contracts": "npm run test:contracts && npm run test:contract-drift --workspace backend && npm run test:security --workspace backend && npm run test:acquisition-openapi --workspace backend && npm run check:generated-acquisition-types && npm run build --workspace frontend && npm run test --workspace frontend && npm run test:baota-package",
    "test:contracts": "npm run test --workspace contracts",
    "test:baota-package": "node --test deploy/baota/build-package.test.mjs",
    "test": "npm run test:contracts && npm run test --workspace backend && npm run test --workspace frontend && npm run test:baota-package",
    "test:e2e": "npm run test:e2e --workspace frontend"
  }
}
```

Generate and commit the source-declared initial version (`info.version` is `1.0.0` in Task 1). The CLI and library must never contain `.../1.0.0/`; that directory appears only as the derived first artifact and in this task's exact `Files`/`git add` list. The `isMain` guard is mandatory because the test imports `buildGrowthContractRelease`; importing the module must never write or rewrite a release.

- [ ] **Step 4: Verify generated bytes, check mode and full contracts**

Run:

```bash
npm run build:growth-contract-release
npm run check:growth-contract-release
npm run test:contracts
git diff --check
```

Expected: all commands PASS and a second build produces no diff.

- [ ] **Step 5: Commit the release tool and first immutable release**

```bash
git add package.json \
  contracts/package.json \
  contracts/scripts/build-growth-contract-release.mjs \
  contracts/test/growth-contract-release.test.mjs \
  contracts/releases/growth-advisor-quote-roi/1.0.0/openapi.json \
  contracts/releases/growth-advisor-quote-roi/1.0.0/manifest.json
git commit -m "build(contracts): add immutable growth releases"
```

---

### Task 3: Serve Bootstrap and Enforce Static/Production OpenAPI Parity

**Prerequisite:** `2026-08-09-growth-foundation-and-authority.md` Task 0.1 已完成并导出唯一 `ActiveWorkspaceContext`、capability registry/resolver 和 `CommandContext`；Tasks 0.2–0.4 尚不需要完成。

**Files:**
- Create: `backend/src/growth-contract-types.ts`
- Create: `backend/src/growth-contract-types-test.ts`
- Create: `backend/src/growth-openapi.ts`
- Create: `backend/src/growth-openapi-test.ts`
- Create: `backend/src/growth-openapi-contract-drift-test.ts`
- Create: `backend/src/growth-openapi-response-conformance-test.ts`
- Create: `backend/src/growth-bootstrap-router.ts`
- Create: `backend/src/growth-bootstrap-router-test.ts`
- Create: `backend/src/growth-commercial-application.ts`
- Create: `backend/src/growth-commercial-application-test.ts`
- Create: `backend/src/growth-commercial-private-services.ts`
- Create: `backend/src/growth-commercial-private-services-test.ts`
- Create: `backend/src/growth-commercial-composition.ts`
- Create: `backend/src/growth-commercial-composition-test.ts`
- Create: `backend/src/growth-commercial-runtime-bridge.ts`
- Create: `backend/src/growth-commercial-runtime-bridge-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`
- Modify: `backend/src/swagger.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: release `manifest.json`, authenticated `Request.user`, foundation-owned `ActiveWorkspaceContext`, closed capability registry/resolver and enabled feature flags; it imports these foundation types and does not define substitutes.
- Produces: backend canonical `AdvisorRecommendedAction`, `AdvisorMetricRef`, `AdvisorEvidenceRef`, `AdvisorEntityRef`, `GrowthRoiSliceKey`, `FinancialDataGapCode`, and `FinancialDataGapSourceType` from `growth-contract-types.ts`. These are the only backend TypeScript declarations of the C0-frozen unions; Advisor imports them and never redeclares them. `growth-contract-types-test.ts` compiles positive/negative fixtures against those aliases and validates the same fixtures with the released JSON Schema so a schema/type branch cannot drift silently.
- Consumes: exact Foundation adapter `GrowthCommandContextFactory = (req, { canonicalPath: string; pathParams: Readonly<Record<string,string>>; payload: unknown; expectedRevision: number|null }) => CommandContext`; no C0 or later module may call a narrower overload or hash only the route template/body.
- Consumes: exact Foundation `GrowthTemporalBarrier`, `GrowthTemporalTransaction`, and branded `GrowthSealedReadCutoff` composition types. C0 only wires/projects the reference-equal singleton; it does not expose the internal pure timestamp helper as a repository adapter. Later modules must allocate under the workspace-global barrier before domain locks and must make internal as-of readers token-only.
- Produces: `createGrowthBootstrapRouter(options): Router`, `createGrowthOpenApiPaths(): Record<string, OpenApiPathItem>`, `createGrowthCommercialComposition(dependencies): GrowthCommercialComposition<GrowthAcquisitionIntegrations>`, `createGrowthCommercialApplication(options): Promise<GrowthCommercialRuntime>`, install-style `GrowthCommercialRuntimeBridge`, exact static/production operation parity, and runtime responses conforming to `GrowthBootstrapResponse`.

Use these exact composition interfaces for every later backend plan:

```ts
import type { QuoteProjectedDocumentAuthorityValidator } from "./commercial-authority-guard";

export type GrowthCommercialToolName =
  | "list_catalog_items"
  | "get_pricing_policy"
  | "preview_quote"
  | "create_quote_draft"
  | "list_pending_quote_approvals"
  | "get_quote_decision"
  | "get_growth_performance"
  | "list_financial_data_gaps"
  | "create_advisor_recommendation"
  | "create_quote_approval_task"
  | "create_sales_todo"
  | "record_recommendation_outcome";

export interface GrowthCommercialToolCall {
  name: GrowthCommercialToolName;
  input: unknown;
  stableCallHash: `sha256:${string}`;
}

export type GrowthCommercialToolHandler = (
  input: unknown,
  command: CommandContext
) => Promise<unknown>;

export interface GrowthCommercialToolPorts {
  register(name: GrowthCommercialToolName, handler: GrowthCommercialToolHandler): void;
  execute(call: GrowthCommercialToolCall, command: CommandContext): Promise<unknown>;
}

export interface GrowthPrivateServiceKey<T> {
  readonly id: symbol;
  readonly description: string;
  readonly __value?: T;
}

export interface GrowthPrivateServiceRegistry {
  provide<T>(key: GrowthPrivateServiceKey<T>, value: T): void;
  require<T>(key: GrowthPrivateServiceKey<T>): T;
  get<T>(key: GrowthPrivateServiceKey<T>): T | null;
}

export interface GrowthCommercialModule {
  readonly name: string;
  install(input: {
    router: express.Router;
    toolPorts: GrowthCommercialToolPorts;
    privateServices: GrowthPrivateServiceRegistry;
  }): Promise<{ close(): Promise<void> }>;
}

export interface GrowthCommercialComposition<TIntegrations extends object> {
  modules: readonly GrowthCommercialModule[];
  projectIntegrations(privateServices: GrowthPrivateServiceRegistry): TIntegrations;
}

// C0 creates the Foundation projection plus a fail-closed PI-validator seam.
// Quote Task 6 modifies this same interface once: it adds required
// probabilityAssessments and makes quoteProjectedDocumentAuthority required,
// both sourced atomically from GROWTH_QUOTE_ACQUISITION_INTEGRATIONS.
// ROI Task 2 then modifies this same interface once more: it adds required
// authoritativeDiscoveryProjectionWriter, sourced only and reference-identically
// from GROWTH_ROI_ACQUISITION_INTEGRATIONS. ROI Task 13 preserves that field and
// must not add a second projection, writer, or Acquisition application call site.
export interface GrowthCommercialCompositionDependencies {}
export interface GrowthAcquisitionIntegrations {
  /** Exact reference-equal Foundation ports needed by the single Acquisition domain graph. */
  acquisitionWorkspace: GrowthAcquisitionWorkspaceResolver;
  temporalBarrier: GrowthTemporalBarrier;
  /** C0 is absent/fail-closed; the Quote module later makes and supplies this projection. */
  quoteProjectedDocumentAuthority?: QuoteProjectedDocumentAuthorityValidator;
}

export function createGrowthCommercialComposition(
  dependencies: GrowthCommercialCompositionDependencies
): GrowthCommercialComposition<GrowthAcquisitionIntegrations>;

export interface GrowthCommercialApplicationOptions<TIntegrations extends object> {
  manifest: GrowthContractManifest;
  requireAuth: express.RequestHandler;
  workspaceMiddleware: express.RequestHandler;
  enabledFeatures(context: ActiveWorkspaceContext): readonly GrowthFeature[];
  composition: GrowthCommercialComposition<TIntegrations>;
  createToolPorts?: () => GrowthCommercialToolPorts;
  createPrivateServices?: () => GrowthPrivateServiceRegistry;
}

export interface GrowthBootstrapRouterOptions {
  manifest: GrowthContractManifest;
  capabilityRegistryVersion: "growth-capabilities.v1";
  resolveContext(req: express.Request): Promise<ActiveWorkspaceContext | null>;
  enabledFeatures(context: ActiveWorkspaceContext): readonly GrowthFeature[];
}

export interface GrowthCommercialRuntime<TIntegrations extends object> {
  handler: express.RequestHandler;
  toolPorts: GrowthCommercialToolPorts;
  integrations: TIntegrations;
  close(): Promise<void>;
}

export function createGrowthCommercialApplication<TIntegrations extends object>(
  options: GrowthCommercialApplicationOptions<TIntegrations>
): Promise<GrowthCommercialRuntime<TIntegrations>>;

export class GrowthCommercialRuntimeBridge {
  install(runtime: GrowthCommercialRuntime<object>): void;
  middleware(): express.RequestHandler;
  close(): Promise<void>;
}
```

The tool registry and private-service registry are each one object owned by the one Growth runtime. Duplicate tool registration fails with `DUPLICATE_GROWTH_TOOL_PORT`; duplicate private-service provision fails with `DUPLICATE_GROWTH_PRIVATE_SERVICE`. `createToolPorts` and `createPrivateServices` are test seams invoked exactly once. `growth-commercial-composition.ts` is the sole production composition owner: Tasks B1–B5 add typed modules there in dependency order, modules communicate only through typed `GrowthPrivateServiceKey<T>` values, and every module returns its own idempotent close handle. The application installs each module exactly once, closes installed modules once in reverse order, then projects only the narrow `integrations` object needed by Acquisition. C0 always projects the exact reference-equal Foundation `acquisitionWorkspace` and `temporalBarrier` ports; they are required even while `quoteProjectedDocumentAuthority` remains absent/fail-closed. Quote Task 6 provides one typed, frozen integration object containing its probability writer and PI validator; the sole projector requires it and makes both final ports required/reference-equal in one step. `server.ts` injects these named ports into their existing Acquisition consumers and never exposes `privateServices`, constructs a writer/validator/resolver/barrier independently, or falls back to a permissive stub. `server.ts` coordinates the two runtimes but never constructs catalog, quote, ledger, ROI, Advisor, Worker, or repository objects. Acquisition Pi receives `growthRuntime.toolPorts` and the explicit projected integration ports; it cannot access the private registry or create a second business graph.

- [ ] **Step 1: Write failing bootstrap and drift tests**

Create the focused router assertion in `growth-bootstrap-router-test.ts` with the repository's existing ephemeral-listener/fetch pattern:

```ts
test("bootstrap returns only the authorized concrete workspace and release identity", async () => {
  const router = createGrowthBootstrapRouter({
    manifest: {
      name: "growth-advisor-quote-roi",
      contractVersion: "1.0.0",
      contractHash: `sha256:${"a".repeat(64)}`,
      openapiVersion: "3.1.0"
    },
    capabilityRegistryVersion: "growth-capabilities.v1",
    resolveContext: async () => ({
      workspaceId: "workspace-1",
      capabilities: ["catalog.read", "quote.draft.create"]
    }),
    enabledFeatures: () => ["catalog", "quotes"]
  });
  const application = express();
  application.use((req, _res, next) => {
    (req as AuthenticatedRequest).user = authenticatedUserFixture("user-1");
    next();
  });
  application.use(router);
  const fixture = await listenForTest(application);
  const response = await fetch(`${fixture.baseUrl}/api/v1/growth/bootstrap`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    status: "ready",
    workspaceId: "workspace-1",
    capabilityRegistryVersion: "growth-capabilities.v1",
    capabilities: ["catalog.read", "quote.draft.create"],
    contractVersion: "1.0.0",
    contractHash: `sha256:${"a".repeat(64)}`,
    features: ["catalog", "quotes"]
  });
  assert.equal(JSON.stringify(body).includes("all"), false);
  await fixture.close();
});

test("bootstrap derives features from the closed server projector and has no null-context feature leak", async () => {
  const ready = await bootstrapFixture({
    context: context("workspace-1"),
    enabledFeatures: () => ["catalog", "quotes"]
  }).get();
  assert.deepEqual(ready.body.features, ["catalog", "quotes"]);
  const selectionRequired = await bootstrapFixture({
    context: null,
    enabledFeatures: () => { throw new Error("must not run without a workspace"); }
  }).get();
  assert.deepEqual(selectionRequired.body.features, []);
  const invalid = bootstrapFixture({
    context: context("workspace-1"),
    enabledFeatures: () => ["catalog", "unknown-growth-feature" as never]
  });
  const response = await invalid.get();
  assert.equal(response.status, 500);
  assert.equal(invalid.serializedBootstrapBodies.length, 0);
});
```

Create composition tests in `growth-commercial-application-test.ts` and `growth-commercial-runtime-bridge-test.ts`:

```ts
test("one runtime shares its tool registry with HTTP route registrations", async () => {
  const options = applicationOptions();
  const runtime = await createGrowthCommercialApplication(options);
  try {
    assert.equal(options.createdToolPortRegistries.length, 1);
    assert.equal(runtime.toolPorts, options.createdToolPortRegistries[0]);
    const response = await requestHandlerForTest(runtime.handler, {
      method: "GET",
      path: "/api/v1/growth/bootstrap",
      user: authenticatedUserFixture("user-1")
    });
    assert.equal(response.status, 200);
  } finally {
    await runtime.close();
  }
});

test("modules share one typed private registry and close once in reverse order", async () => {
  const events: string[] = [];
  const composition = compositionFixture(events);
  const runtime = await createGrowthCommercialApplication(applicationOptions({ composition }));
  assert.deepEqual(events, ["install:catalog", "install:quote", "project"]);
  assert.equal(runtime.integrations.acquisitionWorkspace, composition.acquisitionWorkspace);
  await runtime.close();
  await runtime.close();
  assert.deepEqual(events, [
    "install:catalog", "install:quote", "project",
    "close:quote", "close:catalog"
  ]);
});

test("C0 projects exact Foundation acquisition ports, no PI authority, and no private registry", async () => {
  const fixture = growthFoundationProjectionFixture();
  const runtime = await createGrowthCommercialApplication(fixture.options);
  try {
    assert.equal(runtime.integrations.acquisitionWorkspace, fixture.foundation.acquisitionWorkspace);
    assert.equal(runtime.integrations.temporalBarrier, fixture.foundation.temporalBarrier);
    assert.equal(runtime.integrations.quoteProjectedDocumentAuthority, undefined);
    assert.equal("privateServices" in runtime, false);
  } finally {
    await runtime.close();
  }
});

test("the same idempotency key and body cannot replay across two path resource IDs", async () => {
  const fixture = await commandContextPathParamFixture();
  try {
    const first = await fixture.post("resource-a", {
      idempotencyKey: "growth-path-identity-0001",
      ifMatch: '"revision-1"',
      body: { decision: "approve" }
    });
    assert.equal(first.status, 201);
    const second = await fixture.post("resource-b", {
      idempotencyKey: "growth-path-identity-0001",
      ifMatch: '"revision-1"',
      body: { decision: "approve" }
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "idempotency_conflict");
    assert.equal(fixture.executedResourceIds.join(","), "resource-a");
  } finally {
    await fixture.close();
  }
});

test("a same-clock append advances one DATETIME(3) tick and cannot change an old asOf view", () => {
  const serverNow = "2026-08-09T08:00:00.123Z";
  const firstRecordedAt = nextGrowthRecordedAt(serverNow, null, 1);
  const oldAsOf = firstRecordedAt;
  const secondRecordedAt = nextGrowthRecordedAt(serverNow, firstRecordedAt, 1);
  assert.equal(secondRecordedAt, "2026-08-09T08:00:00.124Z");
  const visibleAtOldCutoff = [firstRecordedAt, secondRecordedAt]
    .filter((recordedAt) => Date.parse(recordedAt) <= Date.parse(oldAsOf));
  assert.deepEqual(visibleAtOldCutoff, [firstRecordedAt]);
});

test("a private service key cannot be provided twice", () => {
  const services = createGrowthPrivateServiceRegistry();
  const key = defineGrowthPrivateServiceKey<{ read(): string }>("catalog-services");
  services.provide(key, { read: () => "first" });
  assert.throws(
    () => services.provide(key, { read: () => "second" }),
    /DUPLICATE_GROWTH_PRIVATE_SERVICE/u
  );
});

test("bootstrap filters internal-only capabilities from the human projection", async () => {
  const options = applicationOptions({
    resolvedCapabilities: ["catalog.read", "acquisition.outcome.reconcile.internal"]
  });
  const runtime = await createGrowthCommercialApplication(options);
  try {
    const response = await requestHandlerForTest(runtime.handler, {
      method: "GET",
      path: "/api/v1/growth/bootstrap",
      user: authenticatedUserFixture("user-1")
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.capabilities, ["catalog.read"]);
    assert.equal(JSON.stringify(response.body).includes("acquisition.outcome.reconcile.internal"), false);
  } finally {
    await runtime.close();
  }
});

test("install bridge delegates once and closes one installed runtime", async () => {
  const events: string[] = [];
  const runtime = growthRuntimeFixture(events);
  const bridge = new GrowthCommercialRuntimeBridge();
  assert.equal((await requestHandlerForTest(bridge.middleware(), requestFixture())).status, 503);
  bridge.install(runtime);
  assert.equal((await requestHandlerForTest(bridge.middleware(), requestFixture())).status, 200);
  assert.throws(() => bridge.install(growthRuntimeFixture(events)), /already installed/u);
  await bridge.close();
  await bridge.close();
  assert.deepEqual(events, ["handle", "close"]);
});
```

`applicationOptions`, `compositionFixture`, `authenticatedUserFixture`, `listenForTest`, `requestHandlerForTest`, `requestFixture`, `growthRuntimeFixture` and `commandContextPathParamFixture` are local test helpers defined in these test files; each returns the exact types shown above and uses no second runtime. Import `nextGrowthRecordedAt` directly from Foundation for the same-clock cutoff test; do not duplicate its arithmetic in C0. `commandContextPathParamFixture` installs one test-only `POST /__test/growth/resources/:id/approve` module after Foundation, validates `req.params.id` as one non-empty string, and calls only `foundation.commandContextFactory(req, { canonicalPath: "/__test/growth/resources/:id/approve", pathParams: Object.freeze({ id }), payload: req.body, expectedRevision: 1 })` before `executeGrowthIdempotentCommand`. It records an ID only inside claimed execution, so the second request's 409 proves the resource ID is in the canonical identity. `growth-commercial-composition-test.ts` also asserts dependency order, missing-key fail-closed behavior, integration projection after all installs, and cleanup of already-installed modules when a later install fails, and cleanup of all installed modules when `projectIntegrations` or bootstrap capability projection throws. Per-module tests separately prove the currently installing module locally closes resources if its own provide/mount/start fails before returning a handle. Every later Growth append repository receives the reference-equal Foundation barrier, calls `allocateAppend` before any domain lock, persists its global stamp, and holds that barrier through commit. Each public historical boundary seals once; every nested reader consumes the same branded token and cannot reseal or accept a naked time. Composition tests reject local allocators and duplicate barrier instances.

In `growth-openapi-contract-drift-test.ts`, load the static release paths and the production builder, normalize them with the existing acquisition contract helper, and assert every operation from Task 1 is equal.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run test:growth-openapi --workspace backend
```

Expected: FAIL because the router, application, install bridge, path builder and script do not exist.

- [ ] **Step 3: Implement the bootstrap union and OpenAPI merge**

Implement the router boundary:

```ts
export function createGrowthBootstrapRouter(options: GrowthBootstrapRouterOptions) {
  const router = express.Router();
  router.get("/api/v1/growth/bootstrap", async (req, res, next) => {
    try {
      const context = await options.resolveContext(req);
      res.setHeader("Cache-Control", "no-store");
      if (context === null) {
        res.json({
          status: "workspace_selection_required",
          workspaceId: null,
          capabilityRegistryVersion: options.capabilityRegistryVersion,
          capabilities: [],
          contractVersion: options.manifest.contractVersion,
          contractHash: options.manifest.contractHash,
          features: []
        } satisfies GrowthBootstrapResponse);
        return;
      }
      res.json({
        status: "ready",
        workspaceId: context.workspaceId,
        capabilityRegistryVersion: options.capabilityRegistryVersion,
        capabilities: context.capabilities,
        contractVersion: options.manifest.contractVersion,
        contractHash: options.manifest.contractHash,
        features: projectGrowthBootstrapFeatures(options.enabledFeatures(context))
      } satisfies GrowthBootstrapResponse);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
```

`createGrowthCommercialComposition(dependencies)` is the sole factory for production and in-memory Growth graphs. In C0 it freezes the supplied dependency object and returns the initial ordered module list/integration projector; that projector returns no `quoteProjectedDocumentAuthority`, so the Foundation-owned PI guard remains fail-closed. Later B1–B5 tasks extend only this factory's list and projection with their typed modules/ports. Quote Task 6 modifies this exact interface once to add required `probabilityAssessments: ProbabilityAssessmentWriter` and to make `quoteProjectedDocumentAuthority` required; its module owns/provides one frozen typed `GROWTH_QUOTE_ACQUISITION_INTEGRATIONS { probabilityAssessments; quoteProjectedDocumentAuthority }`, and the sole projector must `require` that key and copy both reference-identical ports atomically. ROI Task 2 subsequently modifies the same exact final interface once to add required `authoritativeDiscoveryProjectionWriter: AuthoritativeDiscoveryProjectionWriter`; the ROI module alone owns/provides frozen typed `GROWTH_ROI_ACQUISITION_INTEGRATIONS { authoritativeDiscoveryProjectionWriter }`, and the sole projector must require that key and copy the same writer reference into the one Acquisition application. Missing, duplicate, partial, lookalike, or non-reference-identical Quote/ROI integration objects fail projection and trigger reverse cleanup; authority-reader or discovery-reader composites are not integration substitutes. ROI Task 13 only completes the already-installed ROI module and preserves this projection; it cannot add another field, writer, projector invocation, or Acquisition application call site. Every command route requires `GROWTH_FOUNDATION_SERVICES` and calls its exact `commandContextFactory` with canonical route template, the closed validated path-param map, payload and parsed expected revision; no module constructs a `CommandContext`, omits `pathParams`, or treats a template as the full resource identity. Its tests reject duplicate module names and prove two factory calls have isolated registries/resources. `createGrowthCommercialApplication` creates exactly one tool-port registry, one private-service registry, and one router, registers bootstrap first, then installs the modules returned by that factory in listed dependency order. Each module receives the same router/registries, mounts its own routes once, and returns one close handle. Only after every install succeeds does the application call `composition.projectIntegrations(privateServices)` and expose that narrow projection; installs, integration projection, and bootstrap capability projection run inside one application try/catch, and any failure awaits all returned handles in reverse order before the runtime can be published; the private registry itself is never returned. It calls `projectGrowthBootstrapCapabilities` against the closed human-exposable union: the known internal-only capability is deliberately filtered, while an unknown registry value fails before serialization and the standard error response never echoes that value. Later B1–B5 tasks modify the sole composition file and their own module files, not this application kernel. An unregistered closed tool name returns `FEATURE_NOT_ENABLED`; unknown names are rejected before dispatch. `close()` is idempotent and closes installed modules in reverse order. A failed install closes previously installed modules, while the failing module's local install catch closes its own not-yet-returned resources; a failed integration/bootstrap projection closes every installed module and leaves zero sweeper timers or published runtime.

`createGrowthCommercialApplication` passes its exact `options.enabledFeatures` function into `createGrowthBootstrapRouter` together with frozen `GROWTH_CAPABILITY_REGISTRY_VERSION`; no context object carries a `features` property and the router has no `options.features` fallback. The ready branch calls `projectGrowthBootstrapFeatures(options.enabledFeatures(context))`, which validates/deduplicates the closed `GrowthFeature` union before any response serialization. The workspace-selection-required branch never invokes that function and returns frozen `features: []`, because no concrete workspace exists from which to derive feature enablement.

`GrowthCommercialRuntimeBridge.middleware()` returns 503 `GROWTH_RUNTIME_NOT_READY` before `install`, delegates to the installed handler afterward, rejects a second installation and closes the installed runtime once. In `server.ts`, construct and install Growth before Acquisition; pass the exact `growthRuntime.toolPorts`, `growthRuntime.integrations.acquisitionWorkspace`, and `growthRuntime.integrations.temporalBarrier` objects into `createAcquisitionApplication`; pass only `growthRuntime.integrations.quoteProjectedDocumentAuthority` to the Foundation-owned legacy PI submit/approve/send/export guards; and mount only `growthBridge.middleware()` for Growth routes. The single Acquisition application injects the first two ports into its existing DomainService/transaction graph for qualification authority and Acquisition-to-Growth append projection. Missing or non-identical ports fail startup/identity tests; there is no optional fallback. In C0 the PI validator is `undefined` and the mounted acquisition-bound `quote_projection` route test receives `409 authoritative_quote_required`; after the Quote module is installed, the final composition additionally passes its required, reference-equal `probabilityAssessments` writer into the shared qualification wrapper and its exact validator into the PI guard, with no second construction or fallback. After ROI Task 2, that same one call also receives the required, reference-equal `authoritativeDiscoveryProjectionWriter` projected only from `GROWTH_ROI_ACQUISITION_INTEGRATIONS`; Run and direct candidate-ingestion paths share it, and missing, duplicate, or non-identical projection fails startup before Acquisition publishes a handler. Shutdown closes Acquisition first and Growth bridge second. No router, validator, resolver, barrier, private registry, or business service is constructed in `server.ts`.

Mount `requireAuth` inside the Growth application before `/api/v1/growth`, `/api/v1/catalog`, `/api/v1/quotes`, `/api/v1/finance` and the new acquisition growth routes. Merge `createGrowthOpenApiPaths()` into `createOpenApiDocument()` without modifying the old acquisition path builder. Add both composition tests to `test:growth-openapi` and add root `check:growth-contracts` with these syntactically complete JSON additions (merge the shown keys into the existing `scripts` objects without changing unrelated keys).

`backend/package.json`:

```json
{
  "scripts": {
    "test:growth-openapi": "NODE_ENV=test JWT_SECRET=goodjob-growth-openapi-test-secret-at-least-32-characters node --import tsx --test --test-concurrency=1 src/growth-contract-types-test.ts src/growth-openapi-test.ts src/growth-openapi-contract-drift-test.ts src/growth-openapi-response-conformance-test.ts src/growth-bootstrap-router-test.ts src/growth-commercial-private-services-test.ts src/growth-commercial-composition-test.ts src/growth-commercial-application-test.ts src/growth-commercial-runtime-bridge-test.ts"
  }
}
```

Root `package.json`:

```json
{
  "scripts": {
    "check:growth-contracts": "npm run check:growth-contract-release && npm run test:growth-openapi --workspace backend"
  }
}
```

- [ ] **Step 4: Verify bootstrap, response conformance, security and build**

Run:

```bash
npm run test:growth-openapi --workspace backend
npm run test:security --workspace backend
npm run check:growth-contracts
npm run build --workspace backend
git diff --check
```

Expected: PASS; unauthenticated bootstrap is 401, unselected super admin receives `workspace_selection_required`, one Growth runtime is installed, Acquisition sees that runtime's exact `toolPorts`, shutdown is reverse ordered, and no response contains secrets or unauthorized capabilities.

- [ ] **Step 5: Commit runtime contract support**

```bash
git add backend/src/growth-contract-types.ts backend/src/growth-contract-types-test.ts backend/src/growth-openapi.ts backend/src/growth-openapi-test.ts backend/src/growth-openapi-contract-drift-test.ts backend/src/growth-openapi-response-conformance-test.ts backend/src/growth-bootstrap-router.ts backend/src/growth-bootstrap-router-test.ts backend/src/growth-commercial-application.ts backend/src/growth-commercial-application-test.ts backend/src/growth-commercial-private-services.ts backend/src/growth-commercial-private-services-test.ts backend/src/growth-commercial-composition.ts backend/src/growth-commercial-composition-test.ts backend/src/growth-commercial-runtime-bridge.ts backend/src/growth-commercial-runtime-bridge-test.ts backend/src/acquisition-application.ts backend/src/acquisition-application-test.ts backend/src/swagger.ts backend/src/server.ts backend/package.json package.json
git commit -m "feat(backend): serve growth bootstrap contract"
```

---

### Task 4: Pin the Backend Release and Generate External Frontend Types

**Prerequisite:** This plan Task 3 has published and served the exact release identity; no B1–B5 domain route is required yet.

**Files:**
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/contracts/pinned/growth-advisor-quote-roi.openapi.json`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/contracts/pinned/growth-advisor-quote-roi.manifest.json`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/scripts/import-growth-contract.mjs`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/scripts/generate-growth-contract-types.mjs`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/scripts/check-growth-contract.mjs`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/scripts/check-growth-contract.test.mjs`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/generated/growth-advisor-quote-roi.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/contracts.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tsconfig.tests.json`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/package.json`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/pnpm-lock.yaml`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tsconfig.json`

**Interfaces:**
- Consumes: one backend release directory containing exact `openapi.json` and `manifest.json` from Task 2.
- Produces: `importGrowthContract(releaseDirectory)`, `generateGrowthContractTypes({ check }: { check: boolean })`, `verifyPinnedGrowthContract()`, generated `paths/components/operations`, aliases exported from `src/growth/contracts.ts`, and scripts `contract:import`, `contract:generate`, `contract:check`, `test:types`.

- [ ] **Step 1: Write the failing pinned-hash test**

Create `scripts/check-growth-contract.test.mjs`:

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyPinnedGrowthContractAt } from "./check-growth-contract.mjs";

test("pinned contract rejects a manifest whose hash is not the OpenAPI bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "growth-pin-"));
  try {
    const openapi = Buffer.from('{"openapi":"3.1.0"}\n');
    await writeFile(path.join(root, "growth-advisor-quote-roi.openapi.json"), openapi);
    await writeFile(path.join(root, "growth-advisor-quote-roi.manifest.json"), JSON.stringify({
      name: "growth-advisor-quote-roi",
      contractVersion: "1.0.0",
      contractHash: `sha256:${createHash("sha256").update("different").digest("hex")}`,
      openapiVersion: "3.1.0"
    }));
    await assert.rejects(
      verifyPinnedGrowthContractAt(root),
      /Pinned growth contract hash mismatch/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("contract generator dependencies are exact and represented in pnpm lock", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  assert.equal(packageJson.devDependencies["openapi-typescript"], "7.13.0");
  assert.equal(packageJson.devDependencies.yaml, "2.8.1");
  assert.match(lock, /openapi-typescript:\s*\n\s+specifier: 7\.13\.0/u);
  assert.match(lock, /yaml:\s*\n\s+specifier: 2\.8\.1/u);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run from the external frontend:

```bash
node --test scripts/check-growth-contract.test.mjs
```

Expected: FAIL because `check-growth-contract.mjs` is absent.

- [ ] **Step 3: Implement import, hash check and type generation**

Implement the hash check core:

```js
export async function verifyPinnedGrowthContractAt(directory) {
  const openApiPath = path.join(directory, "growth-advisor-quote-roi.openapi.json");
  const manifestPath = path.join(directory, "growth-advisor-quote-roi.manifest.json");
  const [bytes, manifestText] = await Promise.all([
    readFile(openApiPath),
    readFile(manifestPath, "utf8")
  ]);
  const manifest = JSON.parse(manifestText);
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== manifest.contractHash) {
    throw new Error("Pinned growth contract hash mismatch");
  }
  return manifest;
}
```

`import-growth-contract.mjs` accepts exactly `--release <directory>`, verifies the source manifest/hash, then copies both files into `contracts/pinned`. `generate-growth-contract-types.mjs` runs `openapi-typescript` against the pinned JSON and writes `src/generated/growth-advisor-quote-roi.ts`; `--check` compares bytes without writing. `src/growth/contracts.ts` re-exports generated aliases and the locked bootstrap/manifest names.

Every executable module is also imported by a test or another script, so each must have an explicit CLI main guard. Put this exact helper in all three scripts:

```js
import path from "node:path";
import { pathToFileURL } from "node:url";

function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === metaUrl;
}
```

Use these exact guarded entrypoints:

```js
// import-growth-contract.mjs
async function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--release") {
    throw new Error("Usage: import-growth-contract.mjs --release <directory>");
  }
  await importGrowthContract(path.resolve(argv[1]));
}
if (isMain(import.meta.url)) await main(process.argv.slice(2));
```

```js
// generate-growth-contract-types.mjs
async function main(argv) {
  if (argv.some((argument) => argument !== "--check")) {
    throw new Error("Usage: generate-growth-contract-types.mjs [--check]");
  }
  await generateGrowthContractTypes({ check: argv.includes("--check") });
}
if (isMain(import.meta.url)) await main(process.argv.slice(2));
```

```js
// check-growth-contract.mjs
async function main(argv) {
  if (argv.length !== 0) throw new Error("Usage: check-growth-contract.mjs");
  await verifyPinnedGrowthContract();
}
if (isMain(import.meta.url)) await main(process.argv.slice(2));
```

Pin the new frontend dev dependencies exactly, never with ranges, and add the exact script keys below. Merge these complete JSON objects into `package.json` while preserving unrelated dependencies/scripts:

```json
{
  "scripts": {
    "contract:import": "node scripts/import-growth-contract.mjs",
    "contract:generate": "node scripts/generate-growth-contract-types.mjs",
    "contract:check": "node scripts/check-growth-contract.mjs && node scripts/generate-growth-contract-types.mjs --check",
    "test:types": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.tests.json --noEmit"
  },
  "devDependencies": {
    "openapi-typescript": "7.13.0",
    "yaml": "2.8.1"
  }
}
```

Before editing, preserve the user's existing workspace-file diff with `git diff -- pnpm-workspace.yaml > /tmp/goodjob-growth-pnpm-workspace.before.diff`. After editing `package.json`, run `pnpm install --lockfile-only` from `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend` and verify `pnpm-lock.yaml` records specifiers `7.13.0` and `2.8.1`. The command may read `pnpm-workspace.yaml`, but `cmp /tmp/goodjob-growth-pnpm-workspace.before.diff <(git diff -- pnpm-workspace.yaml)` must pass so the pre-existing diff is byte-for-byte unchanged.

- [ ] **Step 4: Import the source-declared release, generate and verify**

Run from the external frontend:

```bash
BACKEND_ROOT=/Users/mac/Documents/外贸/GoodJob-1.09/.worktrees/goodjob-growth-advisor-quote-roi
GROWTH_CONTRACT_VERSION="$(node "$BACKEND_ROOT/contracts/scripts/build-growth-contract-release.mjs" --check --print-version)"
pnpm run contract:import -- --release "$BACKEND_ROOT/contracts/releases/growth-advisor-quote-roi/$GROWTH_CONTRACT_VERSION"
pnpm run contract:generate
pnpm run contract:check
pnpm run test:types
pnpm build
cmp /tmp/goodjob-growth-pnpm-workspace.before.diff <(git diff -- pnpm-workspace.yaml)
git diff --check
```

Expected: PASS; running `contract:generate` twice produces no diff.

- [ ] **Step 5: Commit only the external frontend contract consumer**

```bash
git add package.json \
  pnpm-lock.yaml \
  tsconfig.json \
  tsconfig.tests.json \
  contracts/pinned/growth-advisor-quote-roi.openapi.json \
  contracts/pinned/growth-advisor-quote-roi.manifest.json \
  scripts/import-growth-contract.mjs \
  scripts/generate-growth-contract-types.mjs \
  scripts/check-growth-contract.mjs \
  scripts/check-growth-contract.test.mjs \
  src/generated/growth-advisor-quote-roi.ts \
  src/growth/contracts.ts
git commit -m "build: pin growth backend contract"
```

Do not stage `pnpm-workspace.yaml`.

---

### Task 5: Add the Neutral Growth Router, Bootstrap Gate and Mode Isolation

**Prerequisite:** This plan Tasks 3–4 and foundation Task 0.1 are complete, so real mode can consume the one authorized bootstrap context and pinned hash.

**Files:**
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/router.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/router.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/http.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/http.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/bootstrap-api.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/bootstrap-api.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/mode.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/mode.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/runtime.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/runtime.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/demo/fixture.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/demo/adapter.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/demo/adapter.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/styles.css`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/index.html`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/replica-dashboard.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/demo/demo-router.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/demo/demo-app.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/self-test.ts`

**Interfaces:**
- Consumes: generated `GrowthBootstrapResponse`, pinned `GrowthContractManifest`, existing `csrfFromCookie`, existing `goodjob:acquisition-mode-changed` event and legacy hashes such as `#acquisition` / `#private-domain`.
- Produces: `parseGrowthHash(hash): GrowthRoute | null`, `growthHash(route): string`, `createGrowthHttpClient()`, `loadGrowthBootstrap()`, `resolveGrowthMode(input): GrowthMode | GrowthUnavailable`, `startGrowthRuntime()`, and one `#growthWorkspace` host. Domain controllers register through `GrowthPageRegistry` and receive one immutable `GrowthMode`.

- [ ] **Step 1: Write failing route, contract-gate and isolation tests**

Add to `router.self-test.ts`:

```ts
import { strict as assert } from "node:assert";
import { growthHash, parseGrowthHash } from "./router";

assert.deepEqual(parseGrowthHash("#growth/advisor"), { name: "advisor" });
assert.deepEqual(
  parseGrowthHash("#growth/quotes?case=case-1&deal=deal-1"),
  { name: "quote", quoteCaseId: "case-1", dealId: "deal-1" }
);
assert.deepEqual(
  parseGrowthHash("#growth/roi?cohort=cohort-1&currency=CNY&closure=closure-2"),
  { name: "roi", cohortId: "cohort-1", currency: "CNY", closureVersionId: "closure-2" }
);
assert.equal(growthHash({ name: "finance" }), "#growth/finance");
assert.equal(parseGrowthHash("#acquisition"), null);
```

Add to `mode.self-test.ts`:

```ts
import { strict as assert } from "node:assert";
import manifest from "../../contracts/pinned/growth-advisor-quote-roi.manifest.json";
import { resolveGrowthMode } from "./mode";

const mismatch = resolveGrowthMode({
  requested: "real",
  pinned: manifest,
  bootstrap: {
    status: "ready",
    workspaceId: "workspace-1",
    capabilityRegistryVersion: "growth-capabilities.v1",
    capabilities: ["catalog.read"],
    contractVersion: manifest.contractVersion,
    contractHash: `sha256:${"f".repeat(64)}`,
    features: ["catalog"]
  }
});
assert.deepEqual(mismatch, { kind: "unavailable", reason: "contract_mismatch" });
```

Add a static import-boundary assertion to `runtime.self-test.ts` that recursively reads `src/growth` and fails if a non-demo file imports `/demo/` or a demo file imports `http.ts`.

- [ ] **Step 2: Run self-tests and verify RED**

Run from the external frontend:

```bash
pnpm test
```

Expected: FAIL because growth router, mode and runtime modules do not exist.

- [ ] **Step 3: Implement the minimal router and HTTP/bootstrap gate**

Implement deterministic parsing without changing legacy hashes:

```ts
export function parseGrowthHash(hash: string): GrowthRoute | null {
  const [pathname, query = ""] = hash.replace(/^#/, "").split("?", 2);
  const params = new URLSearchParams(query);
  if (pathname === "growth/advisor") return { name: "advisor" };
  if (pathname === "growth/catalog") return { name: "catalog" };
  if (pathname === "growth/finance") return { name: "finance" };
  if (pathname === "growth/quotes") {
    return {
      name: "quote",
      quoteCaseId: params.get("case") || undefined,
      candidateId: params.get("candidate") || undefined,
      dealId: params.get("deal") || undefined
    };
  }
  if (pathname === "growth/roi") {
    return {
      name: "roi",
      cohortId: params.get("cohort") || undefined,
      currency: params.get("currency") || undefined,
      closureVersionId: params.get("closure") || undefined
    };
  }
  return null;
}
```

Implement `createGrowthHttpClient()` so non-safe methods add CSRF, `Idempotency-Key` and `If-Match` only when supplied; parse the generated error envelope into a `GrowthApiError` carrying `status`, `code`, `requestId` and `etag`. Implement the gate exactly:

```ts
export function resolveGrowthMode(input: ResolveGrowthModeInput): GrowthMode | GrowthUnavailable {
  if (input.requested === "demo") return { kind: "demo" };
  if (input.bootstrap.status !== "ready") {
    return { kind: "unavailable", reason: "workspace_selection_required" };
  }
  const pinnedMajor = input.pinned.contractVersion.split(".")[0];
  const serverMajor = input.bootstrap.contractVersion.split(".")[0];
  if (pinnedMajor !== serverMajor || input.bootstrap.contractHash !== input.pinned.contractHash) {
    return { kind: "unavailable", reason: "contract_mismatch" };
  }
  return { kind: "real", bootstrap: input.bootstrap };
}
```

Add neutral nav entries for `growth/advisor`, `growth/catalog`, `growth/quotes`, `growth/finance`, and `growth/roi`, plus one hidden `#growthWorkspace`. `demo-router.ts` must return without redirecting when `parseGrowthHash()` is non-null. `runtime.ts` aborts the previous page controller and clears its state before switching mode or route.

- [ ] **Step 4: Run focused and full frontend checks**

Run:

```bash
pnpm test
pnpm run contract:check
pnpm run test:types
pnpm build
git diff --check
```

Expected: PASS; `#acquisition` still loads, growth hashes remain stable after refresh, contract mismatch shows an unavailable state, and demo mode performs zero growth API requests.

- [ ] **Step 5: Commit the external growth shell**

```bash
git add index.html \
  src/replica-dashboard.ts \
  src/demo/demo-router.ts \
  src/demo/demo-app.ts \
  src/self-test.ts \
  src/growth/router.ts \
  src/growth/router.self-test.ts \
  src/growth/http.ts \
  src/growth/http.self-test.ts \
  src/growth/bootstrap-api.ts \
  src/growth/bootstrap-api.self-test.ts \
  src/growth/mode.ts \
  src/growth/mode.self-test.ts \
  src/growth/runtime.ts \
  src/growth/runtime.self-test.ts \
  src/growth/demo/fixture.ts \
  src/growth/demo/adapter.ts \
  src/growth/demo/adapter.self-test.ts \
  src/growth/styles.css
git commit -m "feat: add growth workspace bootstrap shell"
```

Do not stage `pnpm-workspace.yaml`.

---

### Task 6: Build the Catalog, Package and Pricing Policy Page

**Prerequisite:** `2026-08-09-growth-catalog-pricing.md` has completed its catalog/package/pricing routes and response conformance against C0.

**Files:**
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/catalog/api.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/catalog/api.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/catalog/controller.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/catalog/controller.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/catalog/view.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/catalog/view.self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/runtime.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/styles.css`

**Interfaces:**
- Consumes: `GrowthHttpClient`, `GrowthMode`, generated `CatalogItem`, `CatalogItemPagedResult`, `PackageVersion`, `PricingPolicyVersion`, and capability values `catalog.read`, `catalog.manage`, `pricing.sensitive.read`.
- Produces: `createCatalogApi(http): CatalogApi`, `createCatalogController(options): CatalogController`, `renderCatalogPage(state): string`; controller states `loading | ready | empty | forbidden | conflict | error`; all PATCH/activate/retire commands use the latest response `ETag` as `If-Match` and a fresh UI-action idempotency key.

- [ ] **Step 1: Write failing API, capability and presenter tests**

In `api.self-test.ts`, use a recording fake `GrowthHttpClient`:

```ts
const calls: Array<{ path: string; options?: GrowthRequestOptions }> = [];
const http: GrowthHttpClient = {
  async request(path, options) {
    calls.push({ path, options });
    return { body: { id: "package-v1", status: "active", revision: 2 }, etag: '"2"', requestId: "req-1" };
  }
};
const api = createCatalogApi(http);
await api.activatePackageVersion("package-v1", '"1"', "catalog-activate:key-1");
assert.deepEqual(calls[0], {
  path: "/api/v1/catalog/package-versions/package-v1/activate",
  options: { method: "POST", ifMatch: '"1"', idempotencyKey: "catalog-activate:key-1" }
});
```

In `view.self-test.ts`, render a sales projection with no sensitive fields and assert the HTML contains standard allowed price but not `absoluteFloorUnitPriceMinor`, standard cost or hidden placeholders. Escape a malicious catalog name and verify no raw `<script>` appears.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm test
```

Expected: FAIL because the catalog API/controller/view modules are absent.

- [ ] **Step 3: Implement generated-type transport, controller and pure view**

Keep transport free of hand-written DTOs:

```ts
type CatalogItem = components["schemas"]["CatalogItem"];
type CatalogItemPagedResult = components["schemas"]["CatalogItemPagedResult"];

export function createCatalogApi(http: GrowthHttpClient): CatalogApi {
  return {
    listItems(query, signal) {
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.status) params.set("status", query.status);
      return http.request<CatalogItemPagedResult>(`/api/v1/catalog/items?${params}`, { signal });
    },
    activatePackageVersion(id, etag, idempotencyKey) {
      return http.request(`/api/v1/catalog/package-versions/${encodeURIComponent(id)}/activate`, {
        method: "POST",
        ifMatch: etag,
        idempotencyKey
      });
    }
  };
}
```

The controller checks features and capabilities before loading, cancels stale list/detail requests, retains no sensitive values after a workspace or capability change, and maps 409/412 to `conflict`. The view exposes item/service/package list, package components, price-policy history, effective window, approval rules and missing/expired warnings. Management controls render only with `catalog.manage`; sensitive rows render only when the server projection contains them and bootstrap has `pricing.sensitive.read`.

- [ ] **Step 4: Verify catalog behavior and production build**

Run:

```bash
pnpm test
pnpm run test:types
pnpm build
git diff --check
```

Expected: PASS; sales projection never renders costs/floor, concurrent stale responses are ignored, and active/retired package content has no edit control.

- [ ] **Step 5: Commit the catalog page**

```bash
git add src/growth/catalog/api.ts \
  src/growth/catalog/api.self-test.ts \
  src/growth/catalog/controller.ts \
  src/growth/catalog/controller.self-test.ts \
  src/growth/catalog/view.ts \
  src/growth/catalog/view.self-test.ts \
  src/growth/runtime.ts \
  src/growth/styles.css \
  src/self-test.ts
git commit -m "feat: add catalog pricing workspace"
```

---

### Task 7: Build the Context-Preserving Quote Workbench

**Prerequisite:** `2026-08-09-growth-quote-decision-publication.md` has completed deterministic preview, QuoteCase/Deal authority, approval and publication routes.

**Files:**
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/quotes/api.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/quotes/api.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/quotes/entry.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/quotes/entry.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/quotes/controller.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/quotes/controller.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/quotes/view.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/quotes/view.self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/detail-center-controller.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/detail-center-controller.self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/detail-center-view.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/detail-center-view.self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/private-domain/controller.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/private-domain/controller.self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/private-domain/view.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/private-domain/view.self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/prototype-api.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/runtime.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/styles.css`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/self-test.ts`

**Interfaces:**
- Consumes: generated `QuoteCase`, `CommercialBindingSnapshot`, `QuotePreviewInput`, `QuotePreviewResult`, `QuoteVersion`, `QuoteApproval`, `QuotePublicationOperation`, `DealDecisionInput`, current Candidate/BattleCard read model, `goodjob:acquisition-deal-created`, and capability set.
- Produces: `QuoteEntryContext = { quoteCaseId?: string; candidateId?: string; customerId?: string; dealId?: string }`, `openQuoteWorkbench(context)`, `createQuoteApi(http)`, `createQuoteController(options)`, `renderQuoteWorkbench(state)`. Preview accepts only structured inputs; save version consumes server preview identity/hash; submit/approve/reject/retry always use generated command types.

- [ ] **Step 1: Write failing authority, input and entry-bridge tests**

Add this API assertion:

```ts
const preview: QuotePreviewInput = {
  catalogItemId: "catalog-1",
  pricingPolicyVersionId: "policy-3",
  quantityMicros: 2_500_000,
  offeredUnitPriceMinor: 120000,
  orderDiscountMinor: 5000,
  customerTargetPriceMinor: 290000,
  paymentTerms: { days: 30, method: "bank_transfer" },
  giftItems: [],
  pricingContext: { region: "CN", fulfillmentMode: "standard" }
};
await api.previewQuote("case-1", preview, '"case-4"', "quote-preview:key-1");
assert.equal(calls[0].path, "/api/v1/quotes/cases/case-1/preview");
assert.equal(calls[0].options?.ifMatch, '"case-4"');
assert.equal(JSON.stringify(calls[0].options?.body).includes("estimatedGrossProfitMinor"), false);
```

Add entry tests proving an approved candidate without a Deal emits a controlled CRM conversion task instead of submitting; a completed Handoff plus Deal routes to `#growth/quotes?candidate=<id>&deal=<id>`; and `prototype-api.ts` does not call legacy Deal stage/PI endpoints for an acquisition-bound Deal.

- [ ] **Step 2: Run focused frontend tests and verify RED**

Run:

```bash
pnpm test
```

Expected: FAIL because quote workbench modules and authority gates are absent.

- [ ] **Step 3: Implement quote transport, state machine and existing-module bridges**

Implement the preview boundary without computed fields:

```ts
export function createQuoteApi(http: GrowthHttpClient): QuoteApi {
  return {
    previewQuote(caseId, input, etag, idempotencyKey, signal) {
      return http.request<QuotePreviewResult>(
        `/api/v1/quotes/cases/${encodeURIComponent(caseId)}/preview`,
        {
          method: "POST",
          body: JSON.stringify(input),
          ifMatch: etag,
          idempotencyKey,
          signal
        }
      );
    },
    submitVersion(versionId, etag, idempotencyKey) {
      return http.request<QuoteVersion>(
        `/api/v1/quotes/versions/${encodeURIComponent(versionId)}/submit`,
        { method: "POST", ifMatch: etag, idempotencyKey }
      );
    }
  };
}
```

Controller transitions are `loading_case → editing → previewing → preview_ready → saving → draft_saved → submitting → submitted`, plus `conflict`, `hard_blocked`, `publication_pending`, `publication_failed`, and `error`. A new preview aborts the old request. The controller narrows `QuotePreviewResult.amountState` before reading amount fields: only `actionable` enters `preview_ready`/save and exposes nonnegative normal prices; `non_positive_diagnostic` enters `hard_blocked`, displays its two diagnostic values as invalid intermediate math, clears any prior actionable preview identity, and never enables draft/approval/publication. A capability or response downgrade also clears stale sensitive/actionable state. Approve/reject controls require the exact server `requiredCapabilities` and reject self-decision client-side while treating the server as final authority. View columns show customer/battle card, target and purchase preference, catalog/package, standard/recommended/minimum, discount/margin/contribution, rule decisions, AI negotiation explanation, immutable version comparison, approval timeline and publication status.

Add a quote CTA to candidate detail and real private-domain Deal context. In `prototype-api.ts`, acquisition-bound Deal commercial fields become read-only and direct quote/PI/stage actions dispatch `goodjob:quote-workbench-requested`; non-acquisition legacy Deals keep their existing compatible flow.

- [ ] **Step 4: Verify quote UI, race handling and old-route guard**

Run:

```bash
pnpm test
pnpm run test:types
pnpm build
git diff --check
```

Expected: PASS; no client payload contains computed quote fields, stale preview cannot overwrite current input, candidate-only submit is disabled, and acquisition-bound Deal never uses legacy quote/PI writes.

- [ ] **Step 5: Commit the quote workbench**

```bash
git add src/growth/quotes/api.ts \
  src/growth/quotes/api.self-test.ts \
  src/growth/quotes/entry.ts \
  src/growth/quotes/entry.self-test.ts \
  src/growth/quotes/controller.ts \
  src/growth/quotes/controller.self-test.ts \
  src/growth/quotes/view.ts \
  src/growth/quotes/view.self-test.ts \
  src/growth/runtime.ts \
  src/growth/styles.css \
  src/acquisition/detail-center-controller.ts \
  src/acquisition/detail-center-controller.self-test.ts \
  src/acquisition/detail-center-view.ts \
  src/acquisition/detail-center-view.self-test.ts \
  src/private-domain/controller.ts \
  src/private-domain/controller.self-test.ts \
  src/private-domain/view.ts \
  src/private-domain/view.self-test.ts \
  src/prototype-api.ts \
  src/self-test.ts
git commit -m "feat: add authoritative quote workbench"
```

---

### Task 8: Build the Cost, Financial Fact and Excel Import Page

**Prerequisite:** `2026-08-09-growth-financial-ledgers-import.md` has completed acquisition-cost ledger, financial-fact ledger, verification/correction and secure import routes. F3 does not consume source-report, attribution-allocation or cash-settlement APIs because those are owned by B4/F4.

**Files:**
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/finance/api.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/finance/api.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/finance/import-workflow.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/finance/import-workflow.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/finance/controller.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/finance/controller.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/finance/view.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/finance/view.self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/runtime.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/styles.css`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/self-test.ts`

**Interfaces:**
- Consumes: generated `AcquisitionCostEntry`, `AcquisitionCostEstimate`, `FinancialFact`, `LedgerVerificationEvent`, `FinanceImportPreview`, `FinanceImportOperation`, `FinanceImportRowError`; capabilities `ledger.pending.create`, `ledger.verify`.
- Produces: `createFinanceApi(http)`, `createFinanceImportWorkflow(api)`, `createFinanceController(options)`, `renderFinancePage(state)`; import state `idle | uploading | preview_ready | committing | polling | partial_success | succeeded | failed`; ledger correction uses one server command and never PATCHes an existing fact.

- [ ] **Step 1: Write failing append-only and import-state tests**

Add to `api.self-test.ts`:

```ts
const expectedCorrection: FinancialFactCorrectionInput = {
  reason: "银行回单金额录入错误",
  replacement: {
    factType: "payment_received",
    amountMinor: 125000,
    currency: "CNY",
    businessOccurredAt: "2026-08-09T01:00:00.000Z",
    provenance: "manual_verified",
    evidenceRef: "evidence-2"
  }
};
await api.correctFinancialFact(
  "fact-1",
  expectedCorrection,
  '"fact-3"',
  "finance-correct:key-1"
);
assert.deepEqual(calls[0], {
  path: "/api/v1/finance/facts/fact-1/correct",
  options: {
    method: "POST",
    body: JSON.stringify(expectedCorrection),
    ifMatch: '"fact-3"',
    idempotencyKey: "finance-correct:key-1"
  }
});
```

In `import-workflow.self-test.ts`, assert preview reports valid/invalid/derived rows, commit reuses the same preview ID, terminal polling stops, and retry with the same action key does not create a second job.

- [ ] **Step 2: Run self-tests and verify RED**

Run:

```bash
pnpm test
```

Expected: FAIL because finance modules are absent.

- [ ] **Step 3: Implement append-only commands and bounded import polling**

Use generated request/response types and a single correction command:

```ts
correctFinancialFact(id, input, etag, idempotencyKey) {
  return http.request<FinancialFactCorrectionResult>(
    `/api/v1/finance/facts/${encodeURIComponent(id)}/correct`,
    {
      method: "POST",
      body: JSON.stringify(input),
      ifMatch: etag,
      idempotencyKey
    }
  );
}
```

The import workflow accepts only the template media types and size from the generated contract, creates preview, shows derived COGS provenance explicitly, commits after confirmation, polls with abortable bounded backoff, and exposes row-error download. The view separates estimates from actual cost entries; pending/verified/rejected/reversed are event projections; verified facts have no edit control; correction opens a new replacement form. Payment/refund/bad-debt facts show their server-frozen Deal/QuoteVersion authority, but allocation-set and source-report management is deliberately absent from F3 and belongs to F4 after B4 exists.

- [ ] **Step 4: Verify finance flows and build**

Run:

```bash
pnpm test
pnpm run test:types
pnpm build
git diff --check
```

Expected: PASS; verified entries cannot be edited, correction never emits PATCH, partial import preserves row errors, and no estimated cost is presented as verified actual cost.

- [ ] **Step 5: Commit the finance page**

```bash
git add src/growth/finance/api.ts \
  src/growth/finance/api.self-test.ts \
  src/growth/finance/import-workflow.ts \
  src/growth/finance/import-workflow.self-test.ts \
  src/growth/finance/controller.ts \
  src/growth/finance/controller.self-test.ts \
  src/growth/finance/view.ts \
  src/growth/finance/view.self-test.ts \
  src/growth/runtime.ts \
  src/growth/styles.css \
  src/self-test.ts
git commit -m "feat: add growth finance ledger workspace"
```

---

### Task 9: Build the Expected and Closed Actual ROI Page

**Prerequisite:** `2026-08-09-growth-attribution-roi-closure.md` has completed Cohort, allocation/settlement, Closure and Growth Performance routes.

**Files:**
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/roi/api.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/roi/api.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/roi/controller.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/roi/controller.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/roi/view.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/roi/view.self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/runtime.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/styles.css`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/self-test.ts`

**Interfaces:**
- Consumes: generated `GrowthPerformanceQuery`, `GrowthPerformanceResponse`, `ExpectedRoiCurrencyView`, `ActualRoiCurrencyView`, `CashCurrencyView`, `RoiCoverageSnapshot`, `RoiGapCode`, `AcquisitionCohort`, `FinancialSourceReport`, `AttributionAllocationSet`, `CashSettlementAllocationSet`, `RoiClosureVersion`; growth-performance and `roi.close` capabilities.
- Produces: `createGrowthPerformanceApi(http)`, `createRoiController(options)`, `renderRoiPage(state)`; filters `{ cohortId, currency, asOf, planId?, closureVersionId? }`; actual projection is rendered only from the response closure identity and never recalculated in the browser.

- [ ] **Step 1: Write failing query, closure and presentation tests**

In `api.self-test.ts`:

```ts
await api.getGrowthPerformance({
  cohortId: "cohort-1",
  currency: "CNY",
  asOf: "2026-08-09T08:00:00.000Z",
  planId: "plan-1",
  closureVersionId: "closure-2"
});
assert.equal(
  calls[0].path,
  "/api/v1/acquisition/growth-performance?cohortId=cohort-1&currency=CNY&asOf=2026-08-09T08%3A00%3A00.000Z&planId=plan-1&closureVersionId=closure-2"
);
```

In `view.self-test.ts`, assert expected and actual live in separate labelled regions; `not_computable: cash_reconciliation_incomplete` displays a data-gap action and no actual ROI percentage; a computed response displays `closureVersionId`, `formulaVersion`, `calculationHash`, `dataAsOf`, `membershipSnapshotHash`, four coverage BPS values and formula evidence. The `amountVisibility="redacted"` fixture must render “详细金额已脱敏” for expected, actual, and cash sections and must not leave any prior gross-profit/cost/contract/payment/refund/bad-debt/net-cash minor value in DOM or controller state after a capability change. It still displays separately labelled contract ROAS, cash multiple, and collection rate BPS/status, and tests payment=100/refund=20 so the first two cash ratios use the 100 received-payment numerator while net cash displays 80 only in the full branch. Also assert the B4 evidence panel lists source-report versions and active attribution/settlement set identities, and that a refund row links the exact original payment allocation set/item rather than a mutable current head.

- [ ] **Step 2: Run self-tests and verify RED**

Run:

```bash
pnpm test
```

Expected: FAIL because ROI modules are absent.

- [ ] **Step 3: Implement exact query serialization and immutable snapshot rendering**

Implement query serialization in contract order:

```ts
export function growthPerformancePath(query: GrowthPerformanceQuery): string {
  const params = new URLSearchParams({
    cohortId: query.cohortId,
    currency: query.currency,
    asOf: query.asOf
  });
  if (query.planId) params.set("planId", query.planId);
  if (query.closureVersionId) params.set("closureVersionId", query.closureVersionId);
  return `/api/v1/acquisition/growth-performance?${params.toString()}`;
}
```

The controller aborts stale filters and maps missing capability, empty cohorts, not-computable enums, conflict and server error independently. The view labels expected ROI as planned, actual ROI as verified closed result, and separately labels contract ROAS, cash multiple and collection rate. Money is formatted from minor units using the response currency exponent; ROI BPS is display-only conversion. Data-gap actions route to finance, quote or cohort closure with strong entity refs. F4 owns the B4 evidence/operations panel: it reads financial source reports and immutable attribution/settlement versions, activates a selected draft only with its current ETag/idempotency key, and displays refund-to-original-payment allocation references. This preserves the explicit DAG `B3 -> F3` and `B2 + B3 -> B4 -> F4`.

- [ ] **Step 4: Verify ROI separation, old performance compatibility and build**

Run:

```bash
pnpm test
pnpm exec playwright test tests/acquisition-performance.spec.ts
pnpm run test:types
pnpm build
git diff --check
```

Expected: PASS; old `/performance` test remains green, no actual ROI appears without a closure, and exact historical closure metadata remains visible.

- [ ] **Step 5: Commit the ROI page**

```bash
git add src/growth/roi/api.ts \
  src/growth/roi/api.self-test.ts \
  src/growth/roi/controller.ts \
  src/growth/roi/controller.self-test.ts \
  src/growth/roi/view.ts \
  src/growth/roi/view.self-test.ts \
  src/growth/runtime.ts \
  src/growth/styles.css \
  src/self-test.ts
git commit -m "feat: add closed growth roi workspace"
```

---

### Task 10: Build the Global AI Growth Advisor Home

**Prerequisite:** `2026-08-09-growth-advisor-backend.md` has completed Advisor today/recommendation routes and injected its handlers into the one Growth runtime/tool-port registry.

**Files:**
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/advisor/api.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/advisor/api.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/advisor/copilot-workflow.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/advisor/copilot-workflow.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/advisor/controller.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/advisor/controller.self-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/advisor/view.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/advisor/view.self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/runtime.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/growth/styles.css`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/README.md`

**Interfaces:**
- Consumes: generated `AdvisorTodayResponse`, `PriorityCustomerView`, `PendingQuoteApprovalView`, `ExpectedRoiCurrencyView`, `ActualRoiCurrencyView`, `FinancialDataGapView`, `AdvisorRecommendation`, `AdvisorCopilotTaskResult`; existing Copilot session/message/task paths; controlled routes from Tasks 6–9.
- Produces: `createAdvisorApi(http)`, `createAdvisorCopilotWorkflow(api)`, `createAdvisorController(options)`, `renderAdvisorHome(state)`; recommendation actions `accept | ignore | complete`; action targets limited to battle card, quote draft, sales Todo, quote approval task and finance/ROI navigation.

- [ ] **Step 1: Write failing recommendation, AI-failure and action-boundary tests**

In `copilot-workflow.self-test.ts`, use fake timers and assert one session, one advisor message, bounded polling, abort on query/mode change, and no client-generated financial values. In `view.self-test.ts`, use this recommendation:

```ts
const quotePreviewInputSnapshotHash = `sha256:${"a".repeat(64)}` as const;
const quotePreviewCalculationHash = `sha256:${"b".repeat(64)}` as const;
const quoteCommercialAmountHash = `sha256:${"c".repeat(64)}` as const;

const recommendation = {
  id: "recommendation-1",
  workspaceId: "workspace-1",
  revision: 1,
  audienceRole: "manager",
  type: "quote_risk",
  summary: "优先处理已提交且即将过期的报价",
  rationale: "报价版本 quote-v3 距失效还有 12 小时",
  metricRefs: [{
    kind: "quote_preview",
    quoteCaseId: "quote-case-3",
    previewIdentity: {
      inputSnapshotHash: quotePreviewInputSnapshotHash,
      calculationHash: quotePreviewCalculationHash,
      pricingPolicyVersionId: "pricing-policy-v7",
      pricingPolicyRevision: 7,
      packageVersionId: "package-v3",
      formulaVersion: "quote-calculation.v1"
    },
    inputSnapshotHash: quotePreviewInputSnapshotHash,
    calculationHash: quotePreviewCalculationHash
  }],
  evidenceRefs: [{
    kind: "quote_version",
    quoteVersionId: "quote-v3",
    lifecycleRevision: 3,
    commercialAmountHash: quoteCommercialAmountHash
  }],
  entityRefs: [{
    kind: "quote_version",
    id: "quote-v3",
    lifecycleRevision: 3,
    commercialAmountHash: quoteCommercialAmountHash
  }],
  confidenceBps: 8700,
  riskLevel: "high",
  recommendedAction: {
    kind: "create_quote_approval_task",
    quoteVersionId: "quote-v3",
    quoteVersionRevision: 3
  },
  status: "proposed",
  assignedTo: null,
  acceptedBy: null,
  acceptedAt: null,
  outcomeRefs: [],
  dataAsOf: "2026-08-09T08:00:00.000Z",
  inputSnapshotHash: `sha256:${"d".repeat(64)}`,
  modelSnapshotRef: "model-snapshot-1",
  promptVersion: "growth-advisor.v1",
  schemaVersion: "advisor-recommendation.v1",
  generationIdempotencyKey: "advisor-generation:workspace-1:2026-08-09",
  expiresAt: "2026-08-10T08:00:00.000Z",
  createdAt: "2026-08-09T08:00:00.000Z",
  updatedAt: "2026-08-09T08:00:00.000Z"
} satisfies AdvisorRecommendation;

const [previewMetric] = recommendation.metricRefs;
assert.ok(previewMetric);
assert.equal(previewMetric.kind, "quote_preview");
assert.equal(previewMetric.quoteCaseId, "quote-case-3");
assert.equal(previewMetric.previewIdentity.inputSnapshotHash, quotePreviewInputSnapshotHash);
assert.equal(previewMetric.previewIdentity.calculationHash, quotePreviewCalculationHash);

const [quoteEvidence] = recommendation.evidenceRefs;
assert.ok(quoteEvidence);
assert.equal(quoteEvidence.kind, "quote_version");
assert.equal(quoteEvidence.quoteVersionId, "quote-v3");
assert.equal(quoteEvidence.lifecycleRevision, 3);
assert.equal(quoteEvidence.commercialAmountHash, quoteCommercialAmountHash);
assert.equal(recommendation.recommendedAction.quoteVersionRevision, 3);
```

Assert summary, rationale, dataAsOf, confidence/risk, metric/evidence/entity refs and one controlled action render; there is no approve, verify, send or outreach action. Simulate Copilot failure and assert deterministic today facts stay rendered with `ai_explanation_unavailable`.

- [ ] **Step 2: Run self-tests and verify RED**

Run:

```bash
pnpm test
```

Expected: FAIL because advisor modules are absent.

- [ ] **Step 3: Implement today query, controlled recommendation commands and Copilot workflow**

Implement recommendation commands through one exact mapper:

```ts
const recommendationCommandPath = {
  accept: (id: string) => `/api/v1/acquisition/advisor/recommendations/${encodeURIComponent(id)}/accept`,
  ignore: (id: string) => `/api/v1/acquisition/advisor/recommendations/${encodeURIComponent(id)}/ignore`,
  complete: (id: string) => `/api/v1/acquisition/advisor/recommendations/${encodeURIComponent(id)}/complete`
} as const;

export interface AdvisorApi {
  getToday(
    query: AdvisorTodayQuery,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<AdvisorTodayResponse>>;
  decideRecommendation(
    action: "accept" | "ignore" | "complete",
    id: string,
    input: AdvisorRecommendationTransitionInput,
    etag: string,
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<AdvisorRecommendation>>;
}

export function advisorTodayPath(query: AdvisorTodayQuery): string {
  const params = new URLSearchParams({ currency: query.currency, asOf: query.asOf });
  return `/api/v1/acquisition/advisor/today?${params.toString()}`;
}

export function createAdvisorApi(http: GrowthHttpClient): AdvisorApi {
  return {
    getToday(query, signal) {
      return http.request<AdvisorTodayResponse>(advisorTodayPath(query), { signal });
    },
    decideRecommendation(
      action: "accept" | "ignore" | "complete",
      id: string,
      input: AdvisorRecommendationTransitionInput,
      etag: string,
      idempotencyKey: string
    ) {
      return http.request<AdvisorRecommendation>(recommendationCommandPath[action](id), {
        method: "POST",
        body: JSON.stringify(input),
        ifMatch: etag,
        idempotencyKey
      });
    }
  };
}
```

No free/global HTTP client is used.

Render today conclusion, three-to-ten priority customers, pending quote approvals, expected/actual ROI summaries, data gaps, natural-language input, task status and recommendation outcomes. Copilot uses the existing session/message/task API with the generated `AdvisorCopilotTaskResult`; it may request `create_quote_draft`, `create_quote_approval_task`, `create_sales_todo` or `record_recommendation_outcome`, but the browser never calls approval, ledger verification or outbound-send operations from AI output. Model failure changes only the explanation region.

Update README to document explicit demo and real modes, bootstrap contract gate, and the actual `pnpm` verification commands.

- [ ] **Step 4: Verify the complete F0–F5 frontend**

Run:

```bash
pnpm run contract:check
pnpm run test:types
pnpm test
pnpm run test:e2e
pnpm build
git diff --check
```

Expected: PASS; deterministic advisor facts survive AI failure, every recommendation shows traceable refs, and AI actions cannot approve, verify, publish or contact a customer.

- [ ] **Step 5: Commit the advisor home**

```bash
git add src/growth/advisor/api.ts \
  src/growth/advisor/api.self-test.ts \
  src/growth/advisor/copilot-workflow.ts \
  src/growth/advisor/copilot-workflow.self-test.ts \
  src/growth/advisor/controller.ts \
  src/growth/advisor/controller.self-test.ts \
  src/growth/advisor/view.ts \
  src/growth/advisor/view.self-test.ts \
  src/growth/runtime.ts \
  src/growth/styles.css \
  src/self-test.ts \
  README.md
git commit -m "feat: add global growth advisor home"
```

Do not stage `pnpm-workspace.yaml`.

## Plan Completion Gate

Run in the backend worktree:

```bash
npm run check:growth-contracts
npm run test:security --workspace backend
npm run test:acquisition --workspace backend
npm run build --workspace backend
git diff --check
```

Run in the external frontend:

```bash
pnpm run contract:check
pnpm run test:types
pnpm test
pnpm run test:e2e
pnpm build
git diff --check
```

The plan is complete only when the backend release manifest equals the pinned frontend manifest byte-for-byte, all five page features are gated by bootstrap capabilities/features, legacy acquisition performance remains green, and real-mode failures never load demo financial or quote data.
