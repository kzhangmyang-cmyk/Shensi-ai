# AI 增长参谋后端可信展示契约实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以向后兼容方式提供结构化计划草稿、运行展示投影和当前财务价值三个契约，让前端真实模式不解析模型自由文本、不猜测运行候选、不伪造财务金额。

**Architecture:** 抽出计划公共契约；让模型只提交语义意图，服务端可信补全连接、版本、操作与预算；在搜索分片完成事务内持久化 run→candidate 关联；由只读 presentation service 汇总运行、分片、候选审计、资格与财务数据，并使用绑定租户/操作者/run 的 HMAC 事件游标。

**Tech Stack:** TypeScript、Express、Zod、Pi Agent Model Gateway、HMAC SHA-256、现有 Acquisition repositories 与 OpenAPI 生成器。

## Global Constraints

- Node.js 版本保持 `>=22.19.0`；不新增后端依赖。
- 除 `responseMode`、run presentation 和 financial-value 外，不改变既有 V1 字段语义。
- 模型只能生成计划语义意图；连接 ID、凭据版本、operationId、模型连接和预算分配必须由服务端生成。
- plan draft 不调用搜索或业务工具。
- run→candidate 关联必须持久化，禁止按创建时间、名称或全局列表推断。
- 财务值只读取候选当前 `latestDecisionId` 绑定的持久化决定；缺失时 404。
- 游标必须绑定 owner、team、actor 和 run，并使用 HMAC 校验。
- 不新增自动触达、隐私采集或默认财务估算。
- 每项行为变更必须先写失败测试，再写最小实现。

---

## Task 1: 抽出唯一的计划创建契约

**Files:**

- Create: `backend/src/acquisition-plan-contract.ts`
- Create: `backend/src/acquisition-plan-readiness.ts`
- Test: `backend/src/acquisition-plan-readiness-test.ts`
- Modify: `backend/src/acquisition-plan-router.ts`
- Modify: `backend/src/acquisition-plan-run-service.ts`
- Modify: `backend/src/acquisition-plan-router-test.ts`
- Test: `backend/src/acquisition-plan-contract-test.ts`

**Interfaces:**

- Consumes: `AcquisitionPlanPayload`、`AcquisitionModelSnapshotRef`、现有 `createAcquisitionPlanRouter()`。
- Produces: `acquisitionPublicPlanCreateSchema`、`AcquisitionPublicPlanCreateInput` 与共享 `planReadinessIssues()`，供 Task 3、Task 4、计划批准和 OpenAPI 使用。

### 1.1 写失败测试

- [ ] 新建 `acquisition-plan-contract-test.ts`，断言公开创建请求：
  - 接受完整的 `modelConnectionId` + ICP + operations + budget。
  - 拒绝 `modelSnapshotRef`。
  - 拒绝 operation 中额外字段。
  - 路由使用同一个导出 Schema 后，既有创建计划结果不变。
- [ ] 新建 `acquisition-plan-readiness-test.ts`，锁定现有批准门槛：
  - organization 与 individual 必须同时启用。
  - 两类 ICP criteria 均非空。
  - 两类主体至少各有一个 search operation。
  - 总 requests/results/duration 为正数。
  - operation 各预算字段是非负整数，且各维分配总和不超过计划总预算。

测试入口：

```bash
NODE_ENV=test TZ=UTC \
JWT_SECRET=goodjob-acquisition-test-secret-at-least-32-characters \
ACQUISITION_MASTER_SECRET=goodjob-acquisition-master-test-secret-at-least-32-bytes \
node --import tsx --test --test-concurrency=1 \
backend/src/acquisition-plan-contract-test.ts \
backend/src/acquisition-plan-readiness-test.ts \
backend/src/acquisition-plan-router-test.ts
```

- [ ] 运行并确认测试因文件/导出不存在而失败。

### 1.2 实现共享契约

- [ ] 将 `acquisition-plan-router.ts` 内的 usage、budget、provider connection、operation、payload 和 public create Schema 移到 `acquisition-plan-contract.ts`。
- [ ] 导出以下稳定名字：

```ts
export const acquisitionUsageSchema = z.object({
  requests: z.number().int().nonnegative(),
  results: z.number().int().nonnegative(),
  amountMinor: z.number().int().nonnegative(),
  durationSeconds: z.number().int().nonnegative()
}).strict();

export const acquisitionBudgetSchema = z.object({
  billingCurrency: z.string().trim().length(3),
  maxRequests: z.number().int().nonnegative(),
  maxResults: z.number().int().nonnegative(),
  maxAmountMinor: z.number().int().nonnegative(),
  maxDurationSeconds: z.number().int().nonnegative()
}).strict();

export const acquisitionProviderConnectionSchema = z.object({
  connectionId: idSchema,
  providerId: requiredText(100),
  kind: z.enum(["search", "content_fetch", "import"]),
  status: z.enum(["active", "inactive", "disabled"]),
  credentialVersion: z.number().int().positive()
}).strict();

export const acquisitionPlanOperationSchema = z.object({
  operationId: idSchema,
  subjectChannel: z.enum(["organization", "individual"]),
  kind: z.enum(["search", "content_fetch", "import_rows"]),
  connectionId: idSchema,
  query: z.string().trim().min(1).max(4_000).optional(),
  sourceRef: z.string().trim().min(1).max(4_000).optional(),
  allocatedBudget: acquisitionUsageSchema
}).strict();

export const acquisitionPlanPayloadSchema = z.object({
  name: requiredText(200),
  objective: requiredText(2_000),
  icp: z.object({
    industries: z.array(requiredText(120)).min(1).max(100),
    regions: z.array(requiredText(120)).min(1).max(100),
    organizationCriteria: z.array(requiredText(500)).min(1).max(100),
    individualCriteria: z.array(requiredText(500)).min(1).max(100),
    exclusionRules: z.array(requiredText(500)).max(200)
  }).strict(),
  subjectChannels: z.object({
    organization: z.boolean(),
    individual: z.boolean()
  }).strict(),
  providerConnections:
    z.array(acquisitionProviderConnectionSchema).min(1).max(100),
  operations: z.array(acquisitionPlanOperationSchema).min(1).max(500),
  budgetSnapshot: acquisitionBudgetSchema,
  modelSnapshotRef: acquisitionModelSnapshotSchema,
  stopConditions: z.object({
    stopWhenBudgetExhausted: z.boolean(),
    stopWhenNoMoreResults: z.boolean()
  }).strict()
}).strict();
export const acquisitionPublicPlanCreateSchema =
  acquisitionPlanPayloadSchema
    .omit({ modelSnapshotRef: true })
    .extend({ modelConnectionId: idSchema.nullable().optional() })
    .strict();

export type AcquisitionPublicPlanCreateInput =
  z.infer<typeof acquisitionPublicPlanCreateSchema>;
```

- [ ] `acquisition-plan-router.ts` 改为导入 Schema；不要改变响应、ETag、幂等或模型快照重新绑定逻辑。
- [ ] 将 `acquisition-plan-run-service.ts` 内现有私有逻辑原样提取并导出为 `planReadinessIssues(payload: AcquisitionPlanPayload): string[]`，由批准流程和 Task 3 的计划草稿生成器共用；批准接口的错误码、问题顺序和文案保持兼容。

### 1.3 验证并提交

- [ ] 运行上面的两项测试。
- [ ] 运行 `npm run build --workspace backend`。
- [ ] 提交：

```bash
git add backend/src/acquisition-plan-contract.ts \
  backend/src/acquisition-plan-contract-test.ts \
  backend/src/acquisition-plan-readiness.ts \
  backend/src/acquisition-plan-readiness-test.ts \
  backend/src/acquisition-plan-router.ts \
  backend/src/acquisition-plan-router-test.ts \
  backend/src/acquisition-plan-run-service.ts
git commit -m "refactor: share acquisition plan contract"
```

---

## Task 2: 提供“当前资格决定绑定”的财务价值读取

**Files:**

- Modify: `backend/src/acquisition-domain-service.ts`
- Modify: `backend/src/acquisition-domain-test.ts`
- Modify: `backend/src/acquisition-v1-router.ts`
- Modify: `backend/src/acquisition-v1-router-test.ts`
- Modify: `backend/src/acquisition-provider-connections-router.ts`
- Modify: `backend/src/acquisition-provider-connections-router-test.ts`

**Interfaces:**

- Consumes: `AcquisitionCandidate.latestDecisionId`、`FinancialValueDecision`、`AcquisitionDomainRepository.listFinancialValues()`。
- Produces: `AcquisitionDomainService.getCurrentFinancialValueDecision()`、financial-value GET 和搜索连接健康投影，供 Task 6 和前端使用。

### 2.1 写领域失败测试

- [ ] 在 `acquisition-domain-test.ts` 增加：
  - 当前 `latestDecisionId` 有多个财务记录时，返回 `(createdAt,id)` 最新一条。
  - 有历史财务记录但候选没有当前资格决定时返回 `resource_not_found`。
  - 当前资格决定已更新、但只有旧资格决定的财务记录时返回 `resource_not_found`。
  - 读取不会追加财务记录、更新候选或改变 revision。

- [ ] 运行该文件，确认新方法尚不存在。

### 2.2 实现领域方法

- [ ] 在 `AcquisitionDomainService` 增加：

```ts
async getCurrentFinancialValueDecision(
  scope: AcquisitionActorScope,
  candidateId: string
): Promise<FinancialValueDecision> {
  const candidate = await this.requireCandidate(scope, candidateId);
  if (!candidate.latestDecisionId) {
    fail("resource_not_found", "候选当前没有财务价值决定", 404);
  }
  const values = await this.repository.listFinancialValues(scope, candidateId);
  const current = values
    .filter((value) =>
      value.qualificationDecisionId === candidate.latestDecisionId)
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id))
    .at(-1);
  if (!current) {
    fail("resource_not_found", "候选当前没有财务价值决定", 404);
  }
  return current;
}
```

### 2.3 写路由失败测试并实现

- [ ] 在 `acquisition-v1-router-test.ts` 增加：
  - `GET /api/v1/acquisition/candidates/:id/financial-value` 返回明确投影。
  - 跨租户和无当前财务值均返回稳定 `404 resource_not_found`。
  - GET 不触发默认估算。
  - qualification GET 保留既有字段，并新增 `id`、`candidateId`、`decisionVersion`、`hardGateFailures`、`createdAt`。
  - candidate GET/各写操作返回的 public candidate 对 organization/individual 都包含 `subjectKind`、`status`、`latestDecisionVersion`、`approvedDecisionVersion`、`updatedAt`，供人工复核后可靠刷新。

- [ ] 在 `acquisition-v1-router.ts` 增加 `publicFinancialValue()`：

```ts
function publicFinancialValue(decision: FinancialValueDecision) {
  return {
    id: decision.id,
    candidateId: decision.candidateId,
    qualificationDecisionId: decision.qualificationDecisionId,
    version: decision.version,
    grade: decision.grade,
    score: decision.score,
    currency: decision.currency,
    expectedRevenueMinor: decision.expectedRevenueMinor,
    expectedGrossProfitMinor: decision.expectedGrossProfitMinor,
    expectedContributionMinor: decision.expectedContributionMinor,
    factors: structuredClone(decision.factors),
    createdAt: decision.createdAt
  };
}
```

- [ ] 在 qualification 与 battle-card 读取路由附近增加只读 GET，调用领域方法。
- [ ] 向后兼容扩展 `publicQualification()`，增加以下版本与门禁字段，供人工审核、转换和 presentation 指标使用：

```ts
{
  id: decision.id,
  candidateId: decision.candidateId,
  decisionVersion: decision.decisionVersion,
  hardGateFailures: [...decision.hardGateFailures],
  createdAt: decision.createdAt
}
```

既有资格字段的含义和名字保持不变。
- [ ] 向后兼容扩展 `publicCandidate()` 的两类分支，统一增加：

```ts
{
  subjectKind: candidate.profile.kind,
  status: candidate.status,
  latestDecisionVersion: candidate.latestDecisionVersion,
  approvedDecisionVersion: candidate.approvedDecisionVersion,
  updatedAt: candidate.updatedAt
}
```

不得移除 organization/individual 既有专属字段。

### 2.4 暴露搜索连接健康状态

- [ ] 在 `acquisition-provider-connections-router-test.ts` 先锁定个人和 system search connection 的统一公开字段：

```ts
{
  id,
  providerId,
  kind: "search",
  status,
  credentialVersion,
  lastHealthAt: string | null,
  lastHealthStatus,
  lastErrorCode: string | null,
  lastHealthMessage,
  usage,
  createdAt
}
```

- [ ] `publicConnection()` 增加上述健康字段：存储层空字符串在公开层归一化为 `null`；不返回 API Key、credentialRef、encrypted configuration 或 Base URL。
- [ ] `publicSystemConnection()` 返回同形字段，固定 `lastHealthAt:null`、`lastHealthStatus:"untested"`、`lastErrorCode:null`、`lastHealthMessage:"系统托管来源"`、`usage:""`；前端通过 `ownerId:"system"` 显示“系统托管”，不得把 `untested` 误报为连接故障。
- [ ] 连接测试接口成功/失败后，再次 GET list 必须反映真实 `lastHealthStatus` 与信息。

### 2.5 验证并提交

- [ ] 运行：

```bash
NODE_ENV=test TZ=UTC \
JWT_SECRET=goodjob-acquisition-test-secret-at-least-32-characters \
ACQUISITION_MASTER_SECRET=goodjob-acquisition-master-test-secret-at-least-32-bytes \
node --import tsx --test --test-concurrency=1 \
backend/src/acquisition-domain-test.ts \
backend/src/acquisition-v1-router-test.ts \
backend/src/acquisition-provider-connections-router-test.ts
```

- [ ] 运行 `npm run build --workspace backend`。
- [ ] 提交：

```bash
git add backend/src/acquisition-domain-service.ts \
  backend/src/acquisition-domain-test.ts \
  backend/src/acquisition-v1-router.ts \
  backend/src/acquisition-v1-router-test.ts \
  backend/src/acquisition-provider-connections-router.ts \
  backend/src/acquisition-provider-connections-router-test.ts
git commit -m "feat: expose current acquisition financial value"
```

---

## Task 3: 建立模型内容包兼容注册表和计划草稿 Schema

**Files:**

- Modify: `backend/src/acquisition-model-content.ts`
- Modify: `backend/src/acquisition-model-content-test.ts`
- Modify: `backend/src/acquisition-pi-runtime-factory.ts`
- Modify: `backend/src/acquisition-pi-runtime-factory-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`
- Modify: `backend/src/acquisition-judgment-port.ts`
- Modify: `backend/src/acquisition-judgment-port-test.ts`
- Create: `backend/src/acquisition-plan-draft.ts`
- Create: `backend/src/acquisition-plan-draft-test.ts`

**Interfaces:**

- Consumes: Task 1 的 `AcquisitionPublicPlanCreateInput`、现有 Model Gateway snapshot、官方搜索连接 store。
- Produces: `AcquisitionPlanDraftIntent`、`AcquisitionPlanDraftGenerator`、内容包注册表和稳定计划草稿错误码，供 Task 4 使用。

### 3.1 先锁定兼容策略

采用以下确定策略：

- 现有 v3/v2 内容包保留为 legacy bundle，旧 assistant 会话继续可运行。
- 新内容包版本为：
  - `acquisition-model-prompt-bundle.v4`
  - `acquisition-model-schema-bundle.v3`
- 新快照默认绑定 v4/v3。
- `createAcquisitionModelGatewayForSnapshot()` 按版本 + Hash 从注册表选择内容包。
- legacy 会话发送 `plan_draft` 返回稳定 `MODEL_CONTENT_UPGRADE_REQUIRED`，提示创建新会话；不得悄悄换模型快照。

### 3.2 写内容包失败测试

- [ ] 在 `acquisition-model-content-test.ts` 和 `acquisition-pi-runtime-factory-test.ts` 增加：
  - legacy v3/v2 Hash 仍可解析并运行 assistant。
  - v4/v3 包含唯一的计划草稿 Prompt 和单一提交 Tool。
  - 未登记版本/Hash 仍返回 `MODEL_CONTENT_HASH_MISMATCH`。
  - legacy 包不含计划草稿内容绑定。

### 3.3 添加计划草稿内容

- [ ] 在 `acquisition-model-content.ts` 添加：

```ts
export const ACQUISITION_PLAN_DRAFT_PROMPT_ID =
  "acquisition.plan-draft.v1";
export const ACQUISITION_PLAN_DRAFT_TOOL_SCHEMA_ID =
  "acquisition.plan-draft.v1";
export const ACQUISITION_PLAN_DRAFT_SUBMIT_TOOL =
  "__goodjob_submit_acquisition_plan_draft";
```

- [ ] Prompt 明确：只根据用户目标和对话生成语义意图，不得生成连接 ID、凭据版本、operationId、模型快照或分配后预算。
- [ ] Tool JSON Schema 严格只接受：

```ts
export interface AcquisitionPlanDraftIntent {
  name: string;
  objective: string;
  icp: AcquisitionPlanPayload["icp"];
  subjectChannels: AcquisitionPlanPayload["subjectChannels"];
  queryIntents: Array<{
    subjectChannel: AcquisitionSubjectChannel;
    query: string;
  }>;
  budgetIntent: AcquisitionBudgetSnapshot;
  stopConditions: AcquisitionPlanPayload["stopConditions"];
}
```

- [ ] `additionalProperties: false` 必须覆盖每一层对象。

### 3.4 实现内容包注册表

- [ ] 保留一个不含计划草稿的 legacy bundle 常量，并构造新 current bundle。
- [ ] 导出：

```ts
export function acquisitionModelContentForSnapshot(snapshot: {
  promptVersion: string;
  schemaVersion: string;
  promptHash: string;
  schemaHash: string;
}): ModelContentBundle;
```

- [ ] `acquisition-pi-runtime-factory.ts` 默认按存储快照选择对应 bundle，不再假定所有活动会话都等于最新 Hash。
- [ ] `acquisition-judgment-port.ts` 的 `validateSnapshot()` 调用同一注册表校验函数；legacy assistant 会话调用旧 judgment binding 时仍能工作。

### 3.5 实现计划草稿意图解析与可信补全

- [ ] 在 `acquisition-plan-draft.ts` 定义：

```ts
export interface AcquisitionActiveSearchConnectionDirectory {
  list(scope: {
    ownerId: string;
    teamId: string;
  }): Promise<AcquisitionProviderConnectionSnapshot[]>;
}

export interface AcquisitionPlanDraftGenerator {
  generate(input: {
    ownerId: string;
    teamId: string;
    actorId: string;
    sessionId: string;
    transcript: AgentMessage[];
    prompt: string;
  }): Promise<{
    summary: string;
    planDraft: AcquisitionPublicPlanCreateInput;
    assistantMessage: AgentMessage;
  }>;
}

export function createAcquisitionPlanDraftGenerator(options: {
  resolveSession:
    CreateAcquisitionJudgmentPortOptions["resolveSession"];
  connections: AcquisitionActiveSearchConnectionDirectory;
  idFactory?: (prefix: string) => string;
}): AcquisitionPlanDraftGenerator;
```

- [ ] 通过 current snapshot 的 gateway 调用单一计划草稿提交 Tool，`parallelToolCalls: false`。
- [ ] 使用 Zod 二次解析工具参数，不接受模型额外字段。
- [ ] 从 directory 只取当前 owner/team、personal、active、官方 search Provider，并固定按 `(providerId,connectionId)` 排序。
- [ ] 无连接时抛出 `SEARCH_PROVIDER_CONNECTION_REQUIRED`。
- [ ] 操作生成规则固定为：
  - 将每个 query intent 与每个可用 search connection 做稳定笛卡尔积；一个搜索主题必须在所有已启用官方来源执行，而不是轮询分配给单一来源。
  - 只把实际进入 operation 的连接写入 `providerConnections`，不把未使用连接带入草稿。
  - `operationId` 由 `idFactory("operation")` 生成。
  - operation 数量必须为 1–500。
  - 笛卡尔积超过 500 时抛出 `PLAN_DRAFT_TOO_MANY_OPERATIONS`，不得静默截断。
  - `modelConnectionId = snapshot.connectionId`。
- [ ] 预算分配规则固定为：
  - 对 `maxRequests`、`maxResults`、`maxAmountMinor`、`maxDurationSeconds` 分别做整数商和余数分配。
  - 余数按稳定 operation 顺序每项加 1。
  - 每一维操作预算之和必须等于总预算，且均为非负安全整数。
  - 每项 operation 的 `requests`、`results`、`durationSeconds` 必须至少为 1；`amountMinor` 可以为 0。
  - 若 operation 数大于 `maxRequests`、`maxResults` 或 `maxDurationSeconds`，稳定报 `PLAN_DRAFT_BUDGET_TOO_SMALL`，不制造不可执行的搜索操作。
- [ ] 将补全后的草稿临时还原为完整 `AcquisitionPlanPayload`：把已验证 stored snapshot 的 `jobId` 映射成 `modelSnapshotRef.jobSnapshotId`，其余 connection/provider/model/credentialVersion/content version/hash 原样复制；先通过 `acquisitionPublicPlanCreateSchema.parse()`，再通过 Task 1 的共享 `planReadinessIssues()`，只在两个校验都无问题时返回。
- [ ] readiness 仍有问题时抛出 `PLAN_DRAFT_NOT_READY`，safe details 只包含有序 issue code 数组；不把不合格草稿交给前端让用户在批准时才发现。

### 3.6 完成安全测试

- [ ] `acquisition-plan-draft-test.ts` 覆盖：
  - 模型尝试注入 connection/version/operation 字段时被 Schema 拒绝。
  - 跨租户、inactive、disabled、非 search connection 不进入草稿。
  - 双主体 query × 全部启用官方 search connection 的稳定笛卡尔积，且 `providerConnections` 只包含实际使用连接。
  - operation 超过 500 返回 `PLAN_DRAFT_TOO_MANY_OPERATIONS`。
  - 稳定预算分配，且每项 requests/results/duration 均为正数。
  - 总预算守恒。
  - 缺连接、预算不足、readiness 不通过、legacy session 的稳定错误码。
  - 生成结果可直接作为 `POST /plans` 请求体，且可立即通过批准门槛。

### 3.7 验证并提交

- [ ] 运行相关测试与 build。
- [ ] 提交：

```bash
git add backend/src/acquisition-model-content.ts \
  backend/src/acquisition-model-content-test.ts \
  backend/src/acquisition-pi-runtime-factory.ts \
  backend/src/acquisition-pi-runtime-factory-test.ts \
  backend/src/acquisition-judgment-port.ts \
  backend/src/acquisition-judgment-port-test.ts \
  backend/src/acquisition-plan-draft.ts \
  backend/src/acquisition-plan-draft-test.ts
git commit -m "feat: generate trusted acquisition plan drafts"
```

---

## Task 4: 将 `plan_draft` 接入 Copilot 任务与 API

**Files:**

- Modify: `backend/src/acquisition-copilot-service.ts`
- Modify: `backend/src/acquisition-copilot-service-test.ts`
- Modify: `backend/src/acquisition-copilot-runner.ts`
- Modify: `backend/src/acquisition-copilot-runner-test.ts`
- Modify: `backend/src/acquisition-v1-router.ts`
- Modify: `backend/src/acquisition-v1-router-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`

**Interfaces:**

- Consumes: Task 3 的 `AcquisitionPlanDraftGenerator` 与内容包注册表、现有 `AcquisitionCopilotRunner`。
- Produces: `AcquisitionCopilotResponseMode`、带 `planDraft` 的 task result、API 的 `responseMode` 入参。

### 4.1 写 Copilot 服务失败测试

- [ ] 覆盖：
  - 省略 mode 时仍是 `assistant`。
  - 同一幂等键、不同 mode 返回 `idempotency_conflict`。
  - task 持久化 `responseMode`。
  - `result.planDraft` 再次通过共享 Schema 校验。
  - 失败任务保留稳定 plan-draft 错误码。

### 4.2 扩展任务类型与幂等指纹

- [ ] 添加：

```ts
export type AcquisitionCopilotResponseMode = "assistant" | "plan_draft";
```

- [ ] `AcquisitionCopilotTask` 增加 `responseMode`；`result` 增加可选 `planDraft`。
- [ ] `AcquisitionCopilotRunInput` 增加 `responseMode`。
- [ ] `enqueueMessage()` 末尾增加默认参数：

```ts
responseMode: AcquisitionCopilotResponseMode = "assistant"
```

- [ ] 幂等 Hash 使用 `{ sessionId, prompt, responseMode }`。
- [ ] MySQL payload JSON 自动承载新字段，不新增迁移。

### 4.3 实现路由 Runner

- [ ] 保留现有 `createPiAcquisitionCopilotRunner()` 不变，新增：

```ts
export function createRoutedAcquisitionCopilotRunner(options: {
  assistantRunner: AcquisitionCopilotRunner;
  planDraftGenerator: AcquisitionPlanDraftGenerator;
}): AcquisitionCopilotRunner;
```

- [ ] assistant 分支完全委托原 Runner。
- [ ] plan_draft 分支只调用 Generator；`toolNames` 对外为空数组；不调用任何 business/search tool。
- [ ] plan_draft 分支返回的新消息必须严格为 `[userMessage, assistantMessage]`：第一条保留本次用户 prompt，最后一条是 Generator 返回的 assistant 文本；这与 `AcquisitionCopilotService.#validateNewMessages()` 的既有约束一致，不能只返回 assistant message。

### 4.4 接入 API 与应用装配

- [ ] `copilotMessageBodySchema` 改为：

```ts
const copilotMessageBodySchema = z.object({
  message: requiredText(20_000),
  responseMode: z.enum(["assistant", "plan_draft"]).default("assistant")
}).strict();
```

- [ ] `publicTask()` 输出 `responseMode` 和深拷贝 result。
- [ ] `acquisition-application.ts` 提取 active search connection directory，组装 Generator 和 Routed Runner。
- [ ] 测试 plan_draft 不触发 `search_public_sources`，消息顺序为 user→assistant，且结果可创建并批准计划。

### 4.5 验证并提交

- [ ] 运行 Copilot、router、application 测试。
- [ ] 运行 `npm run build --workspace backend`。
- [ ] 提交：

```bash
git add backend/src/acquisition-copilot-service.ts \
  backend/src/acquisition-copilot-service-test.ts \
  backend/src/acquisition-copilot-runner.ts \
  backend/src/acquisition-copilot-runner-test.ts \
  backend/src/acquisition-v1-router.ts \
  backend/src/acquisition-v1-router-test.ts \
  backend/src/acquisition-application.ts \
  backend/src/acquisition-application-test.ts
git commit -m "feat: add copilot plan draft response mode"
```

---

## Task 5: 在分片完成事务中持久化 run→candidate 权威关联

**Files:**

- Modify: `backend/src/acquisition-tool-executor.ts`
- Modify: `backend/src/acquisition-tool-executor-test.ts`
- Modify: `backend/src/acquisition-search-shard-processor.ts`
- Modify: `backend/src/acquisition-search-shard-processor-test.ts`
- Modify: `backend/src/acquisition-judgment-port.ts`
- Modify: `backend/src/acquisition-judgment-port-test.ts`
- Modify: `backend/src/acquisition-pi-runtime-factory.ts`
- Modify: `backend/src/acquisition-pi-runtime-factory-test.ts`
- Modify: `backend/src/acquisition-plan-execution-worker.ts`
- Modify: `backend/src/acquisition-plan-execution-worker-test.ts`
- Modify: `backend/src/acquisition-plan-run-service.ts`
- Modify: `backend/src/acquisition-plan-run-test.ts`

**Interfaces:**

- Consumes: `search_public_sources` 已持久化的候选、`qualify_candidate` 会同时持久化资格与财务价值的既有行为、plan run 冻结模型快照、现有 search processor/worker/plan service。
- Produces: 搜索后确定性资格评估、`AcquisitionShardPresentationResult` 和 `candidate.discovered` run events，供 Task 6 建立权威投影。

### 5.1 写搜索结果计数失败测试

- [ ] Tool executor 测试覆盖：
  - `rawResultCount` 为 Provider 原始返回条目总数。
  - `acceptedResultCount` 为成功落证据并关联候选的结果数。
  - `duplicateResultCount` 为目录 upsert 返回 `created === false` 的结果数。
  - `failedResultCount` 为 result validation/evidence ingest/candidate upsert 失败总数。
  - Provider 整体失败只进入 `providerFailures`，不重复计入 result failure。
  - `candidateIds` 去重且只来自成功写入的候选。

### 5.2 让 plan run 身份可解析冻结模型快照

- [ ] 扩展 `createAcquisitionJudgmentSessionResolver()`：现有 Copilot session 查找失败且 sessionId 满足 `acquisition-plan:<runId>` 时，使用注入的 run resolver 按当前 owner/team 读取 run，并解析 run 上冻结的 `modelSnapshotRef`。
- [ ] 在 `acquisition-pi-runtime-factory.ts` 导出专用 `resolveStoredAcquisitionModelSnapshotRef()`：用 `jobSnapshotId` 查找同 owner/team 的 stored snapshot，逐项校验 connection/provider/model/credentialVersion/content version/hash 与计算后的 capability hash，再返回带完整 `baseUrlFingerprint` 的 stored snapshot。
- [ ] 复用内容包注册表校验；不得按当前活动模型连接重新绑定，也不得读取其他租户 run。Gateway identity 的 actorId 使用 run.createdBy，sessionId 使用 `acquisition-plan:<runId>`。
- [ ] `acquisition-application.ts` 向 Judgment resolver 注入 `planService.getRun()` 的受限 run resolver，并继续复用同一 gateway factory。
- [ ] 失败测试覆盖有效 run identity、跨租户、未知 run、篡改快照、legacy/current 内容包；稳定错误沿用现有 snapshot 错误码。

### 5.3 搜索后自动执行资格与财务评估

- [ ] `AcquisitionSearchShardProcessor` 在 `search_public_sources` 成功返回后，对去重且排序稳定的 `candidateIds` 逐个调用现有 `qualify_candidate`：

```ts
const qualificationIdentityKey = createHash("sha256")
  .update(JSON.stringify({
    runId: run.id,
    shardId: shard.id,
    candidateId,
    policyVersion: "qualification.v1"
  }))
  .digest("hex")
  .slice(0, 48);

{
  identity: {
    ...scope,
    sessionId: `acquisition-plan:${run.id}`
  },
  toolName: "qualify_candidate",
  toolCallId: `acquisition-qualify:${qualificationIdentityKey}`,
  idempotencyKey: `acquisition-qualify:${qualificationIdentityKey}`,
  payload: {
    candidateId,
    policyVersion: "qualification.v1"
  },
  signal
}
```

- [ ] 复用 Tool executor 的既有领域写入；`qualify_candidate` 成功必须同时留下 qualification 与 current financial-value，不在 processor 里复制评分或财务公式。
- [ ] 单个候选资格失败不能丢弃已持久化搜索证据：记录安全的 `qualificationFailures`，其余候选继续；存在任何候选资格失败时 shard 返回 `partial_success`。
- [ ] 不在搜索阶段自动生成所有 battle card；作战卡仍按需经 Copilot `build_battle_card` 生成。
- [ ] 测试覆盖每个 unique candidate 只评估一次、幂等重试不重复决定、部分资格失败保留候选与证据、模型失败不会伪造财务值；使用真实默认长度 run/shard/candidate ID 时 toolCallId/idempotencyKey 仍不超过 executor 的 120 字符上限。

### 5.4 扩展 processor 输出与安全失败投影

- [ ] 定义：

```ts
export interface AcquisitionShardPresentationResult {
  rawResultCount: number;
  acceptedResultCount: number;
  duplicateResultCount: number;
  failedResultCount: number;
  providers: Array<{
    providerConnectionId: string;
    provider: string;
    status: "succeeded";
  }>;
  providerFailures: Array<{
    providerConnectionId: string;
    provider: string;
    errorCode: string;
    retryAfterAt: string | null;
  }>;
  candidateIds: string[];
  qualifiedCandidateIds: string[];
  qualificationFailures: Array<{
    candidateId: string;
    errorCode: string;
  }>;
}
```

- [ ] `AcquisitionShardProcessingResult.presentation` 为可选，保证其他 processor 向后兼容。
- [ ] Search processor 严格验证所有计数、Provider 连接、候选 ID 格式和唯一性。
- [ ] Provider/tool 整体失败时，Search processor 捕获可公开的稳定错误并返回 failed result + `providerFailures`；只保留 connection、provider、errorCode、retryAfterAt，不得泄露 API Key、Base URL、原始响应或堆栈。
- [ ] 如果 processor 在返回前异常退出，worker 的失败兜底也构造同形安全 presentation，而不是丢失 Provider 失败元数据。

### 5.5 让 worker 透传、service 原子写事件

- [ ] Worker 的 `validResult()` 校验 presentation 中所有计数是非负安全整数，`acceptedResultCount === evidenceCount`，candidateIds 唯一。
- [ ] `completeShard()` 输入增加可选 `presentation`。
- [ ] 在完成分片同一 repository transaction 中：
  - `shard.<status>` 事件 data 写入完整计数、Provider 成功/失败、资格成功/失败。
  - 每个去重 candidate 写一条 `candidate.discovered` run event：

```ts
{
  candidateId,
  operationId: shard.operationId,
  connectionId: shard.connection.connectionId
}
```

- [ ] `shard.complete` audit data 同步记录计数，但不复制候选 PII 或完整投影。
- [ ] 失败结算同样把安全 presentation 传给 `completeShard()`；run event 与 audit 能显示连接、稳定错误码和可选 `retryAfterAt`。

### 5.6 验证原子性

- [ ] 测试 repository append event 失败时，shard/run/关联事件全部回滚。
- [ ] 相同 dispatch/idempotency 重试不产生重复关联。
- [ ] 全 Provider 失败、单 Provider 失败和单候选资格失败的 presentation 元数据均被持久化，且不含 secret。
- [ ] 运行四个相关测试并 build。
- [ ] 提交：

```bash
git add backend/src/acquisition-tool-executor.ts \
  backend/src/acquisition-tool-executor-test.ts \
  backend/src/acquisition-search-shard-processor.ts \
  backend/src/acquisition-search-shard-processor-test.ts \
  backend/src/acquisition-judgment-port.ts \
  backend/src/acquisition-judgment-port-test.ts \
  backend/src/acquisition-pi-runtime-factory.ts \
  backend/src/acquisition-pi-runtime-factory-test.ts \
  backend/src/acquisition-application.ts \
  backend/src/acquisition-application-test.ts \
  backend/src/acquisition-plan-execution-worker.ts \
  backend/src/acquisition-plan-execution-worker-test.ts \
  backend/src/acquisition-plan-run-service.ts \
  backend/src/acquisition-plan-run-test.ts
git commit -m "feat: persist acquisition run candidate links"
```

---

## Task 6: 实现运行展示投影与实时事件游标

**Files:**

- Create: `backend/src/acquisition-run-presentation.ts`
- Create: `backend/src/acquisition-run-presentation-test.ts`
- Modify: `backend/src/acquisition-plan-router.ts`
- Modify: `backend/src/acquisition-plan-router-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`

**Interfaces:**

- Consumes: Task 2 的当前财务读取、Task 5 的 run events、现有 candidate audit events。
- Produces: `AcquisitionRunPresentationService.get()` 与 `GET /api/v1/acquisition/runs/:id/presentation`，供前端 poller 使用。

### 6.1 写完整失败测试矩阵

- [ ] 首次不传 `after`，按 `(createdAt,eventId)` 返回 upsert 事件。
- [ ] `limit` 分页、`hasMore`、追平水位后保留 `nextAfter`。
- [ ] 重放相同 `after` 返回可幂等合并的事件。
- [ ] 追平后新增资格/财务 audit，可在下一轮读取到该 candidate 的更新投影。
- [ ] 篡改游标、跨 owner/team/actor/run 重放均 400。
- [ ] 只返回 `candidate.discovered` 关联的候选。
- [ ] 没有当前财务值时为 `null` 并计入待评估。
- [ ] 多币种按 currency 分组，绝不相加。
- [ ] 部分 Provider 失败、重复、失败结果计数正确。

### 6.2 实现专用 HMAC 游标

- [ ] 游标 payload：

```ts
type RunPresentationCursorPayload = {
  v: 1;
  endpoint: "acquisition-run-presentation";
  ownerId: string;
  teamId: string;
  actorId: string;
  runId: string;
  createdAt: string;
  eventId: string;
};
```

- [ ] 编码为 `base64url(json) + "." + HMAC_SHA256(secret, base64url(json))`。
- [ ] 使用 `timingSafeEqual()` 校验签名。
- [ ] 不复用当前冻结分页 snapshot cursor。

### 6.3 实现投影 service

- [ ] 定义 `AcquisitionRunPresentationService`，依赖：
  - `planService.getRun/listRunShards`
  - `planRepository.listRunEvents`
  - `domainService.getCandidate/getEvidence/getQualificationDecision/getCurrentFinancialValueDecision/listAuditEvents`
- [ ] 先调用 `getRun()` 完成租户可见性校验。
- [ ] 从 `candidate.discovered` 事件建立唯一权威 candidate 集合与首次关联时间。
- [ ] 对已关联 candidate：
  - 初始事件来自 prefixed `run:<runEventId>`。
  - 后续更新事件来自 prefixed `domain:<auditEventId>`。
  - 只读取首次关联时间之后的领域 audit。
- [ ] 当前投影始终重新读取 candidate、证据、当前 qualification、当前 financial value。
- [ ] qualification 公开投影包含 `hardGateFailures`，仅用于可信指标和前端解释。
- [ ] 当前财务 404 映射为 `null`，其他错误继续抛出。
- [ ] run event 的时间字段 `at` 与 domain audit 的 `createdAt` 在公开响应中统一归一化为 `createdAt`；游标仍按 `(createdAt,eventId)` 排序。
- [ ] 不从现有 candidate 数据中臆造行业；无可信行业字段时 `industry: null`，前端显示“行业待确认”。

公开响应固定为：

```ts
export interface AcquisitionRunPresentation {
  run: {
    id: string;
    status: AcquisitionRunStatus;
    etag: string;
    updatedAt: string;
    completedAt: string | null;
  };
  providers: Array<{
    shardId: string;
    connectionId: string;
    providerId: string;
    status: AcquisitionShardStatus;
    rawResultCount: number;
    acceptedResultCount: number;
    duplicateResultCount: number;
    failedResultCount: number;
    errorCode: string | null;
    retryAfterAt: string | null;
  }>;
  summary: {
    sourcesSearched: number;
    pagesAnalyzed: number;
    organizationsFound: number;
    dedupedCandidates: number;
    validOpportunities: number;
    highIntent: number;
    financialEvaluatedHighIntentCount: number;
    financialPendingHighIntentCount: number;
    expectedRevenueByCurrency: Array<{
      currency: string;
      amountMinor: number;
    }>;
  };
  candidateEvents: Array<{
    eventId: string;
    createdAt: string;
    candidateId: string;
    candidate: {
      id: string;
      subjectKind: "organization" | "individual";
      displayName: string;
      industry: string | null;
      region: string | null;
      domain: string | null;
      status: CandidateStatus;
      updatedAt: string;
    };
    qualification: PublicQualification | null;
    financialValue: PublicFinancialValue | null;
    sourcePlatforms: string[];
    evidenceCount: number;
  }>;
  nextAfter: string;
  hasMore: boolean;
}
```

- [ ] `PublicQualification` 必须包含 `id`、`candidateId`、`decisionVersion`、grade、score、recommendedAction、hardGateFailures、confidence、createdAt；`PublicFinancialValue` 与 Task 2 的 GET 契约同形。

### 6.4 固定指标口径

- [ ] `sourcesSearched`: 有至少一个非 queued 分片且产生执行事件的 distinct provider/connection providerId 数。
- [ ] `pagesAnalyzed`: 所有分片 `consumedBudget.results` 之和；字段名在 OpenAPI 中明确为“持久化执行结果页数”。
- [ ] `organizationsFound`: 本次关联且 `profile.kind === "organization"` 的 unique candidate 数。
- [ ] `dedupedCandidates`: 所有关联 unique candidate 数。
- [ ] `validOpportunities`: 最新等级 S/A/B、`hardGateFailures.length === 0`、且 candidate 非 do-not-contact。
- [ ] `highIntent`: 最新等级 S/A。
- [ ] `expectedRevenueByCurrency`: 仅高意向且有当前财务值的 `expectedRevenueMinor` 按 ISO currency 分组。
- [ ] `financialEvaluatedHighIntentCount` 与 `financialPendingHighIntentCount` 只统计高意向候选，并同时返回；不能混入 B/C/D。

### 6.5 接入路由和应用

- [ ] `AcquisitionPlanRouterOptions` 增加 `presentationService`。
- [ ] 增加严格 query Schema：

```ts
z.object({
  after: z.string().trim().min(1).max(8_192).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();
```

- [ ] 新增 `GET /api/v1/acquisition/runs/:id/presentation`。
- [ ] 应用使用 master secret 派生 `"run-presentation-cursor"` secret 并装配 service。

### 6.6 验证并提交

- [ ] 跑新 service、plan router、application 测试。
- [ ] 跑 `npm run build --workspace backend`。
- [ ] 提交：

```bash
git add backend/src/acquisition-run-presentation.ts \
  backend/src/acquisition-run-presentation-test.ts \
  backend/src/acquisition-plan-router.ts \
  backend/src/acquisition-plan-router-test.ts \
  backend/src/acquisition-application.ts \
  backend/src/acquisition-application-test.ts
git commit -m "feat: add acquisition run presentation feed"
```

---

## Task 7: 发布明确 OpenAPI 契约并完成后端回归

**Files:**

- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `contracts/test/openapi.test.mjs`

**Interfaces:**

- Consumes: Task 2、Task 4、Task 6 的生产路由请求和响应形状。
- Produces: 生产 OpenAPI 与 `contracts/openapi/ai-acquisition.v1.yaml` 的可验证公开契约。

### 7.1 写失败契约测试

- [ ] Copilot message body 的 `responseMode` 可选且默认 assistant。
- [ ] Copilot task result 明确包含可选 `planDraft`，不是宽松 `resourceSchema`。
- [ ] `GET /runs/{id}/presentation` 明确描述 summary、providers、candidateEvents、`nextAfter`、`hasMore`。
- [ ] `GET /candidates/{id}/financial-value` 明确描述所有金额单位和 404。
- [ ] planDraft 复用正式公开 plan-create Schema。
- [ ] provider connection 响应明确描述 `lastHealthAt`、`lastHealthStatus`、`lastErrorCode`、`lastHealthMessage` 和 `usage`，且不包含凭据。
- [ ] candidate 响应两类分支都明确包含 `subjectKind`、`status`、`latestDecisionVersion`、`approvedDecisionVersion`、`updatedAt`，同时保留既有专属字段。

### 7.2 更新生产 OpenAPI 与发布 YAML

- [ ] 在 `backend/src/acquisition-openapi.ts` 中定义明确 reusable schemas。
- [ ] 手工同步 `contracts/openapi/ai-acquisition.v1.yaml`，再由 `backend/src/acquisition-openapi-test.ts` 和 `contracts/test/openapi.test.mjs` 逐路径、逐字段锁定生产定义与发布 YAML。
- [ ] 不改变既有 V1 字段语义。

### 7.3 后端全量验证

- [ ] 运行：

```bash
npm run test:contracts
npm run test:acquisition --workspace backend
npm run test --workspace backend
npm run build --workspace backend
git diff --check
```

- [ ] 提交：

```bash
git add backend/src/acquisition-openapi.ts \
  backend/src/acquisition-openapi-test.ts \
  contracts/openapi/ai-acquisition.v1.yaml \
  contracts/test/openapi.test.mjs
git commit -m "docs: publish AI growth advisor contracts"
```

---

## Task 8: 为转换后的 CRM 待办增加可重试幂等契约

**Files:**

- Create: `backend/src/todo-create-idempotency.ts`
- Create: `backend/src/todo-create-idempotency-test.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/src/self-test.ts`

**Interfaces:**

- Consumes: 现有 `POST /api/todos`、`Todo.triggerKey` 持久化字段、AI 增长参谋转换结果。
- Produces: 对携带 `Idempotency-Key` 的 todo create 提供同请求重放与冲突检测；未携带该头的既有调用保持兼容。

### 8.1 写失败测试

- [ ] helper 测试覆盖：
  - key 长度必须为 8–200。
  - owner/team/key 生成 64 位 hash，存储值不包含原始 key。
  - 相同 scope + key + body 返回同一 todo。
  - 相同 scope + key + 不同 body 返回 `idempotency_conflict`。
  - 首次创建后即使 todo 被 PATCH 修改，同 key + 原始 body 重放仍返回原 todo id，不因可变业务字段误报 conflict。
  - 不同 owner/team 不互相复用。
- [ ] `self-test.ts` 通过真实 HTTP 覆盖首次 201、同请求重放 200 + `Idempotency-Replayed:true`、冲突 409，且 `/api/todos` 中只有一条。

### 8.2 实现无迁移幂等

- [ ] `todo-create-idempotency.ts` 导出纯函数，对标准化 body 计算请求指纹，并生成：

```ts
{
  keyHash: sha256(ownerId + "\u001f" + teamId + "\u001f" + key),
  requestHash: sha256(canonicalJson(normalizedBody)),
  triggerKey:
    `ai-growth-todo:${keyHash}:${requestHash}`,
  todoId: `t_ag_${keyHash.slice(0, 48)}`
}
```

- [ ] `POST /api/todos` 仅在存在 `Idempotency-Key` 时启用该路径：
  - 按 owner/team 和 `ai-growth-todo:<keyHash>:` 前缀查找已有 todo，从不可变 triggerKey 读取已存 requestHash；与本次 requestHash 一致则返回原 todo。
  - 同 keyHash 但 requestHash 不同，返回 409 `idempotency_conflict`。
  - 首次创建使用确定性 todoId，并把 hash 形式 triggerKey 写入现有字段后再 persist。
  - in-memory 插入在首次 await 前完成，避免同进程并发重复。
- [ ] PATCH todo 不得修改 `triggerKey`；重放判断不能从可变 title/type/priority/dueAt/related 反推原请求。
- [ ] 不新增数据库列；现有 `trigger_key VARCHAR(255)` 足以持久化约 145 字符的 keyHash + requestHash。不得记录原始 key。
- [ ] 未携带 `Idempotency-Key` 的旧客户端继续使用原有创建行为和响应语义。

### 8.3 验证并提交

- [ ] 运行：

```bash
node --import tsx --test backend/src/todo-create-idempotency-test.ts
npm run test --workspace backend
npm run build --workspace backend
```

- [ ] 提交：

```bash
git add backend/src/todo-create-idempotency.ts \
  backend/src/todo-create-idempotency-test.ts \
  backend/src/server.ts \
  backend/src/self-test.ts
git commit -m "feat: make AI growth todo creation idempotent"
```

## 后端完成定义

- 三个新增契约均在生产路由、OpenAPI、YAML 和测试中存在。
- 旧 assistant 客户端无需发送 `responseMode`。
- 旧内容包 assistant 会话继续可运行；旧会话计划草稿明确要求新建会话。
- 任何 planDraft 连接/版本/操作/预算均来自服务端可信数据。
- presentation 不依赖候选创建时间或全局候选列表。
- financial-value 不触发估算。
- 转换后的 todo 创建可用同一 Idempotency-Key 安全重试，不会重复插入。
- 全量获客测试、后端测试、构建与 diff check 全绿。
