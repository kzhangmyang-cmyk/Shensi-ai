# AI 获客智能体真实闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不重写现有 Pi、搜索 Provider、计划、候选和 CRM 领域能力的前提下，打通“真实搜索 → 自动研究与评分 → 自动作战卡 → 可信结果展示”的完整获客链路。

**Architecture:** Pi 继续作为唯一自然语言入口，GoodJob 的 Worker 和领域服务承担确定性执行。搜索分片保存权威 run→candidate 关联，候选流水线在同一可取消任务中执行研究、资格判断、财务价值和 S/A 作战卡；只读 presentation feed 将运行与领域事件聚合给前端。

**Tech Stack:** Node.js 22.19+、TypeScript、Express、Zod、Pi Agent Core 0.81.1、MySQL/内存仓储、Vite、原生 DOM、Node test runner、Playwright。

## Global Constraints

- 保持 Node.js `>=22.19.0`，不升级 `@earendil-works/pi-* 0.81.1`。
- 不让 Pi 读取 API Key、数据库、Shell、文件系统或消息队列。
- 不改变客户已批准计划中的模型、Prompt、Schema 和搜索连接快照。
- 真实模式只能展示权威后端事件；演示模式必须标注“演示数据”。
- 搜索、研究、评分和作战卡允许自动执行；CRM 转换和触达仍需人工确认。
- 所有候选、证据、评分和作战卡写入必须具备稳定幂等键。
- 无证据的信息必须标记为“未知”；推测必须带证据和置信度。
- 单候选失败不得丢失已持久化搜索结果，也不得中止其他候选。
- 不实现自动加好友、自动私信、自动评论、自动群发或平台风控规避。
- 每项行为变更先写失败测试，再实现最小代码，再独立提交。

## 文件结构与责任边界

### 新增文件

- `backend/src/acquisition-run-presentation.ts`：只读运行展示投影和 HMAC 游标。
- `backend/src/acquisition-run-presentation-test.ts`：投影、分页、租户和指标测试。
- `backend/src/acquisition-candidate-processing-pipeline.ts`：单候选自动处理状态机。
- `backend/src/acquisition-candidate-processing-pipeline-test.ts`：流水线顺序、幂等、部分失败和取消测试。
- `backend/src/acquisition-candidate-research.ts`：受限补充研究查询和同主体证据吸收。
- `backend/src/acquisition-candidate-research-test.ts`：来源限制、身份过滤和预算测试。
- `contracts/json-schema/battle-card.v2.schema.json`：固定结构客户作战卡契约。
- `frontend/tests/ai-acquisition-loop.spec.ts`：真实闭环和演示闭环端到端测试。

### 主要修改文件

- `backend/src/acquisition-tool-executor.ts`：返回完整搜索计数、候选 ID 和 V2 作战卡。
- `backend/src/acquisition-search-shard-processor.ts`：调用候选处理流水线并返回展示元数据。
- `backend/src/acquisition-plan-execution-worker.ts`：校验、传递处理结果和取消信号。
- `backend/src/acquisition-plan-run-service.ts`：原子保存 run→candidate 和阶段事件。
- `backend/src/acquisition-application.ts`：装配投影、研究和处理流水线。
- `backend/src/acquisition-judgment-port.ts`：结构化 V2 作战卡模型输出。
- `backend/src/acquisition-model-content.ts`：注册新的作战卡 Schema/Prompt 内容包。
- `backend/src/acquisition-plan-router.ts`：发布 presentation GET。
- `backend/src/acquisition-copilot-service.ts`：同会话单任务和执行预算。
- `frontend/src/features/ai-growth/controller.ts`：打开演示作战卡并消费完整事件。
- `frontend/src/features/ai-growth/demo/fixture.ts`：真实查询流和差异化证据。
- `frontend/src/features/ai-growth/components/battle-card-drawer.ts`：V1/V2 兼容展示。

---

## Task 1: 保存搜索计数和权威 run→candidate 关联

**Files:**

- Modify: `backend/src/acquisition-tool-executor.ts`
- Modify: `backend/src/acquisition-tool-executor-test.ts`
- Modify: `backend/src/acquisition-search-shard-processor.ts`
- Modify: `backend/src/acquisition-search-shard-processor-test.ts`
- Modify: `backend/src/acquisition-plan-execution-worker.ts`
- Modify: `backend/src/acquisition-plan-execution-worker-test.ts`
- Modify: `backend/src/acquisition-plan-run-service.ts`
- Modify: `backend/src/acquisition-plan-run-test.ts`

**Interfaces:**

- Consumes: `search_public_sources` 已经持久化的证据和候选。
- Produces: `AcquisitionShardPresentationResult`、`candidate.discovered` run event，供 Task 2 和 Task 3 使用。

- [ ] **Step 1: 写 Tool Executor 失败测试**

在 `acquisition-tool-executor-test.ts` 添加包含一个新候选、一个重复候选和一个非法结果的搜索响应，断言：

```ts
assert.equal(result.rawResultCount, 3);
assert.equal(result.acceptedResultCount, 2);
assert.equal(result.duplicateResultCount, 1);
assert.equal(result.failedResultCount, 1);
assert.deepEqual(
  [...result.candidateIds].sort(),
  ["candidate-existing", "candidate-new"]
);
```

同时断言 Provider 整体失败只进入 `providerFailures`，不重复增加 `failedResultCount`。

- [ ] **Step 2: 运行测试并确认失败**

```bash
NODE_ENV=test node --import tsx --test \
  backend/src/acquisition-tool-executor-test.ts
```

Expected: FAIL，因为搜索结果尚未返回四类计数和 `candidateIds`。

- [ ] **Step 3: 扩展搜索执行结果**

在 `searchPublicSources()` 中维护：

```ts
let rawResultCount = 0;
let acceptedResultCount = 0;
let duplicateResultCount = 0;
const candidateIds = new Set<string>();
```

每个 Provider 的 `results.length` 计入 `rawResultCount`；成功落证据计入
`acceptedResultCount`；`upsert.created === false` 计入
`duplicateResultCount`；结果校验、证据写入和候选写入失败统一汇总到
`failedResultCount = ingestFailures.length`。返回：

```ts
{
  rawResultCount,
  acceptedResultCount,
  duplicateResultCount,
  failedResultCount: ingestFailures.length,
  candidateIds: [...candidateIds].sort(),
  // 保留现有 providers、providerFailures、evidence、candidates、usage
}
```

- [ ] **Step 4: 写 Shard/Worker 失败测试**

定义并锁定：

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
  processedCandidateIds: string[];
  battleCardCandidateIds: string[];
  candidateFailures: Array<{
    candidateId: string;
    stage: "research" | "qualification" | "battle_card";
    errorCode: string;
  }>;
}
```

测试 `AcquisitionShardProcessingResult.presentation` 被 Worker 校验并原样传给
`completeShard()`；非法负数、重复候选 ID、`acceptedResultCount !== evidenceCount`
必须返回 `SHARD_RESULT_INVALID`。

- [ ] **Step 5: 实现 Shard/Worker 透传**

`AcquisitionShardProcessingResult` 增加：

```ts
presentation?: AcquisitionShardPresentationResult;
```

搜索 Processor 将 Tool 结果映射为 presentation。Worker 的 `validResult()`
验证所有计数为非负安全整数、ID 唯一、错误投影不含响应正文或凭据。

- [ ] **Step 6: 写 Run Service 原子性失败测试**

测试 `completeShard()` 在同一事务中：

```ts
await repository.listRunEvents(runId);
// 包含 shard.succeeded 和每个 unique candidate 的 candidate.discovered
```

`candidate.discovered` 数据固定为：

```ts
{
  candidateId,
  operationId: shard.operationId,
  connectionId: shard.connection.connectionId
}
```

模拟 `appendRunEvent()` 失败，断言 shard、run、事件全部回滚；相同
dispatch/idempotency 重试不重复关联。

- [ ] **Step 7: 实现原子事件保存**

`completeShard()` 接收 `presentation`，在既有 repository transaction 内：

1. 更新 shard 和 run；
2. 保存 `shard.<status>` 计数；
3. 为去重后的 `candidateIds` 追加 `candidate.discovered`；
4. audit 只保存计数和稳定错误码，不保存完整候选或原始页面。

- [ ] **Step 8: 验证并提交**

```bash
NODE_ENV=test node --import tsx --test --test-concurrency=1 \
  backend/src/acquisition-tool-executor-test.ts \
  backend/src/acquisition-search-shard-processor-test.ts \
  backend/src/acquisition-plan-execution-worker-test.ts \
  backend/src/acquisition-plan-run-test.ts
npm run build --workspace backend
git add backend/src/acquisition-tool-executor.ts \
  backend/src/acquisition-tool-executor-test.ts \
  backend/src/acquisition-search-shard-processor.ts \
  backend/src/acquisition-search-shard-processor-test.ts \
  backend/src/acquisition-plan-execution-worker.ts \
  backend/src/acquisition-plan-execution-worker-test.ts \
  backend/src/acquisition-plan-run-service.ts \
  backend/src/acquisition-plan-run-test.ts
git commit -m "feat: persist acquisition run candidate links"
```

---

## Task 2: 实现真实运行 presentation feed

**Files:**

- Create: `backend/src/acquisition-run-presentation.ts`
- Create: `backend/src/acquisition-run-presentation-test.ts`
- Modify: `backend/src/acquisition-plan-router.ts`
- Modify: `backend/src/acquisition-plan-router-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`

**Interfaces:**

- Consumes: Task 1 的 run events、现有 candidate/qualification/financial getters。
- Produces: `AcquisitionRunPresentationService.get()` 和
  `GET /api/v1/acquisition/runs/:id/presentation`。

- [ ] **Step 1: 写投影失败测试**

覆盖：

```ts
const first = await service.get(scope, runId, { limit: 2 });
assert.equal(first.candidateEvents.length, 2);
assert.equal(first.hasMore, true);

const second = await service.get(scope, runId, {
  after: first.nextAfter,
  limit: 2
});
assert.equal(second.hasMore, false);
```

并覆盖：

- 相同 cursor 重放可幂等 merge；
- cursor 被篡改、跨 owner/team/actor/run 使用均返回
  `INVALID_PRESENTATION_CURSOR`；
- 只返回 `candidate.discovered` 关联候选；
- 财务缺失为 `null`；
- 多币种分别汇总；
- 领域 audit 更新后同一 candidate 产生 upsert 事件。

- [ ] **Step 2: 运行并确认缺少 service**

```bash
NODE_ENV=test node --import tsx --test \
  backend/src/acquisition-run-presentation-test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现绑定身份的 HMAC 游标**

```ts
interface RunPresentationCursorPayload {
  v: 1;
  endpoint: "acquisition-run-presentation";
  ownerId: string;
  teamId: string;
  actorId: string;
  runId: string;
  createdAt: string;
  eventId: string;
}
```

编码为 `base64url(json) + "." + hmacSha256(secret, body)`，使用
`timingSafeEqual()` 验签。游标不包含候选内容。

- [ ] **Step 4: 实现展示 DTO**

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
  candidateEvents: RunCandidatePresentationEvent[];
  nextAfter: string;
  hasMore: boolean;
}
```

高意向只统计 S/A；有效商机只统计 S/A/B 且硬门禁为空、非勿扰候选；
`expectedRevenueByCurrency` 只合计高意向且绑定当前资格决定的财务记录。

- [ ] **Step 5: 接入 GET 和 OpenAPI**

路由 query：

```ts
z.object({
  after: z.string().trim().min(1).max(8192).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();
```

应用从 `ACQUISITION_MASTER_SECRET` 派生
`run-presentation-cursor` 密钥并装配 service。GET 只读，不触发研究、模型或
领域写入。

- [ ] **Step 6: 验证并提交**

```bash
NODE_ENV=test TZ=UTC \
JWT_SECRET=goodjob-acquisition-test-secret-at-least-32-characters \
ACQUISITION_MASTER_SECRET=goodjob-acquisition-master-test-secret-at-least-32-bytes \
node --import tsx --test --test-concurrency=1 \
  backend/src/acquisition-run-presentation-test.ts \
  backend/src/acquisition-plan-router-test.ts \
  backend/src/acquisition-application-test.ts \
  backend/src/acquisition-openapi-test.ts
npm run build --workspace backend
git add backend/src/acquisition-run-presentation.ts \
  backend/src/acquisition-run-presentation-test.ts \
  backend/src/acquisition-plan-router.ts \
  backend/src/acquisition-plan-router-test.ts \
  backend/src/acquisition-application.ts \
  backend/src/acquisition-application-test.ts \
  backend/src/acquisition-openapi.ts \
  backend/src/acquisition-openapi-test.ts
git commit -m "feat: add acquisition run presentation feed"
```

---

## Task 3: 串起自动研究、资格、财务和作战卡

**Files:**

- Create: `backend/src/acquisition-candidate-processing-pipeline.ts`
- Create: `backend/src/acquisition-candidate-processing-pipeline-test.ts`
- Modify: `backend/src/acquisition-search-shard-processor.ts`
- Modify: `backend/src/acquisition-search-shard-processor-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`

**Interfaces:**

- Consumes: Task 1 的 unique `candidateIds` 和现有受控 Tool Executor。
- Produces: 每候选阶段结果，以及 Task 1 presentation 中的
  `processedCandidateIds`、`battleCardCandidateIds`、`candidateFailures`。

- [ ] **Step 1: 写流水线失败测试**

测试顺序：

```ts
assert.deepEqual(calls.map((call) => call.toolName), [
  "research_candidate",
  "qualify_candidate",
  "build_battle_card"
]);
```

测试规则：

- S/A 或 score ≥ 70 且硬门禁为空才生成作战卡；
- B/C/D 不生成作战卡；
- 研究失败时保留候选并继续执行其余候选；
- qualification 失败时该候选不执行 battle card；
- abort 后不再启动后续工具；
- 同一 run/shard/candidate 重试复用相同幂等键。

- [ ] **Step 2: 运行并确认模块不存在**

```bash
NODE_ENV=test node --import tsx --test \
  backend/src/acquisition-candidate-processing-pipeline-test.ts
```

- [ ] **Step 3: 定义流水线类型**

```ts
export interface AcquisitionCandidateProcessingInput {
  scope: AcquisitionScope;
  run: AcquisitionRun;
  shard: AcquisitionOperationShard;
  candidateIds: string[];
  signal: AbortSignal;
}

export interface AcquisitionCandidateProcessingResult {
  processedCandidateIds: string[];
  battleCardCandidateIds: string[];
  failures: Array<{
    candidateId: string;
    stage: "research" | "qualification" | "battle_card";
    errorCode: string;
  }>;
}
```

每阶段幂等键：

```ts
function stageKey(input: {
  runId: string;
  shardId: string;
  candidateId: string;
  stage: string;
}) {
  return `acquisition-stage:${createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 48)}`;
}
```

- [ ] **Step 4: 实现候选状态机**

每个 candidate：

1. 调用 `research_candidate`，参数
   `{ candidateId, depth: "standard", researchQuestions: [...] }`；
2. 调用 `qualify_candidate`，参数
   `{ candidateId, policyVersion: "qualification.v2" }`；
3. 从严格校验后的 qualification 读取 grade、score、hardGateFailures；
4. 满足阈值时调用 `build_battle_card`，参数
   `{ candidateId, templateVersion: "battle-card.v1" }`。Task 4 发布 V2 后，
   同一流水线切换到 `battle-card.v2`。

固定研究问题：

```ts
[
  "该主体最近有哪些与目标产品相关的明确需求或经营变化？",
  "哪些公开信息支持或反驳采购可能性？",
  "可能参与采购决策的部门和商务角色有哪些？",
  "是否存在现有供应商、比价、拒绝联系或勿扰信号？"
]
```

错误对外只保存稳定 code；不得保存模型原文、堆栈、API Key 或 Base URL。

- [ ] **Step 5: 接入搜索 Processor**

Tool 搜索成功后，对排序去重后的 `candidateIds` 调用 pipeline。将结果并入
`presentation`。只要某候选阶段失败，Shard 为 `partial_success`，但
`evidenceCount`、已成功候选和作战卡保持有效。

- [ ] **Step 6: 验证并提交**

```bash
NODE_ENV=test node --import tsx --test --test-concurrency=1 \
  backend/src/acquisition-candidate-processing-pipeline-test.ts \
  backend/src/acquisition-search-shard-processor-test.ts \
  backend/src/acquisition-application-test.ts
npm run build --workspace backend
git add backend/src/acquisition-candidate-processing-pipeline.ts \
  backend/src/acquisition-candidate-processing-pipeline-test.ts \
  backend/src/acquisition-search-shard-processor.ts \
  backend/src/acquisition-search-shard-processor-test.ts \
  backend/src/acquisition-application.ts \
  backend/src/acquisition-application-test.ts
git commit -m "feat: automate acquisition candidate analysis"
```

---

## Task 4: 发布结构化 Battle Card V2

**Files:**

- Create: `contracts/json-schema/battle-card.v2.schema.json`
- Modify: `contracts/test/schema-registry.test.mjs`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `contracts/test/openapi.test.mjs`
- Modify: `backend/src/acquisition-domain.ts`
- Modify: `backend/src/acquisition-domain-service.ts`
- Modify: `backend/src/acquisition-domain-test.ts`
- Modify: `backend/src/acquisition-judgment-port.ts`
- Modify: `backend/src/acquisition-judgment-port-test.ts`
- Modify: `backend/src/acquisition-model-content.ts`
- Modify: `backend/src/acquisition-model-content-test.ts`
- Modify: `backend/src/acquisition-v1-router.ts`
- Modify: `backend/src/acquisition-v1-router-test.ts`
- Modify: `backend/src/acquisition-candidate-processing-pipeline.ts`
- Modify: `backend/src/acquisition-candidate-processing-pipeline-test.ts`

**Interfaces:**

- Consumes: 当前 `BattleCardSection`、qualification 和 financial value。
- Produces: `BattleCardV2`；`battle-card.v1` 保持只读兼容。

- [ ] **Step 1: 写 V2 Schema 失败测试**

测试 V2 必须包含：

```ts
{
  schemaVersion: "battle-card.v2",
  accountOverview: Claim[],
  needAssessment: Claim[],
  supplierHypotheses: Claim[],
  buyingCommittee: BuyingRole[],
  procurementPreferences: Claim[],
  connectionStrategies: ConnectionStrategy[],
  roleSpecificOpeners: RoleOpener[],
  doNotActions: string[],
  financialSummary: FinancialSummary | null
}
```

所有 `fact` 必须至少一个 `evidenceId`；`inference` 必须至少一个
`evidenceId` 且 confidence 为 0–1；`unknown` 的 evidenceIds 为空。

- [ ] **Step 2: 建立精确类型**

```ts
export interface BattleCardClaim {
  kind: "fact" | "inference" | "unknown";
  text: string;
  evidenceIds: string[];
  confidence: number | null;
}

export interface BuyingRole {
  role: string;
  priority: 1 | 2 | 3;
  influence: "decision_maker" | "influencer" | "user" | "gatekeeper";
  concerns: string[];
  claim: BattleCardClaim;
}

export interface ConnectionStrategy {
  channel: "public_reply" | "wecom" | "phone" | "email" | "referral";
  targetRole: string;
  rationale: BattleCardClaim;
  openingDraft: string;
}

export interface RoleOpener {
  role: string;
  channel: ConnectionStrategy["channel"];
  text: string;
}
```

`BattleCard` 变为 V1/V2 可辨识联合类型。历史数据缺少 `schemaVersion` 时在读取
投影中解释为 `battle-card.v1`，不得回写或伪造 V2 字段。

- [ ] **Step 3: 更新模型内容包**

新增注册版本：

```ts
promptVersion: "acquisition-model-prompt-bundle.v5";
schemaVersion: "acquisition-model-schema-bundle.v4";
```

V2 Judgment 只能引用输入 evidence ID；财务摘要从已持久化的当前财务决定传入，
模型不能自行生成金额。旧快照继续使用旧内容包，不能静默升级。

- [ ] **Step 4: 实现领域与 API 兼容**

`createBattleCard()` 根据 input.schemaVersion 校验并保存。GET 返回：

```ts
{
  ...existingPublicFields,
  schemaVersion: card.schemaVersion ?? "battle-card.v1",
  intelligence: card.schemaVersion === "battle-card.v2"
    ? structuredClone(card.intelligence)
    : null
}
```

写路由仍受 `requireDirectDomainWrites` 控制；普通前端不能直接 POST 作战卡。

Task 3 的自动流水线在 V2 内容包通过测试后，把
`templateVersion` 从 `battle-card.v1` 改为 `battle-card.v2`；测试断言新产生的
S/A 作战卡均为 V2，历史 V1 仍可读取。

- [ ] **Step 5: 验证并提交**

```bash
npm run test:contracts
NODE_ENV=test node --import tsx --test --test-concurrency=1 \
  backend/src/acquisition-domain-test.ts \
  backend/src/acquisition-judgment-port-test.ts \
  backend/src/acquisition-model-content-test.ts \
  backend/src/acquisition-v1-router-test.ts
npm run build --workspace backend
git add contracts/json-schema/battle-card.v2.schema.json \
  contracts/test/schema-registry.test.mjs \
  contracts/openapi/ai-acquisition.v1.yaml \
  contracts/test/openapi.test.mjs \
  backend/src/acquisition-domain.ts \
  backend/src/acquisition-domain-service.ts \
  backend/src/acquisition-domain-test.ts \
  backend/src/acquisition-judgment-port.ts \
  backend/src/acquisition-judgment-port-test.ts \
  backend/src/acquisition-model-content.ts \
  backend/src/acquisition-model-content-test.ts \
  backend/src/acquisition-v1-router.ts \
  backend/src/acquisition-v1-router-test.ts \
  backend/src/acquisition-candidate-processing-pipeline.ts \
  backend/src/acquisition-candidate-processing-pipeline-test.ts
git commit -m "feat: add structured acquisition battle cards"
```

---

## Task 5: 增加受限补充研究

**Files:**

- Create: `backend/src/acquisition-candidate-research.ts`
- Create: `backend/src/acquisition-candidate-research-test.ts`
- Modify: `backend/src/acquisition-candidate-processing-pipeline.ts`
- Modify: `backend/src/acquisition-candidate-processing-pipeline-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`

**Interfaces:**

- Consumes: 当前候选、当前证据、Run 中批准的搜索连接快照和
  `SearchPublicSourcesPort`。
- Produces: 只附加到同一强身份候选的公开补充证据。

- [ ] **Step 1: 写研究安全失败测试**

覆盖：

- 企业候选只接受域名或统一信用代码与目标一致的结果；
- 个人候选只接受精确公开主页身份一致的结果；
- 不匹配结果不创建新候选、不附加证据；
- 登录、验证码和访问受限标记 `access_restricted`；
- 每候选最多 3 个补充查询、每查询最多 5 个结果、总时长 30 秒；
- Run abort 后中止后续查询；
- 新证据附加后旧资格、财务和作战卡失效。

- [ ] **Step 2: 定义服务接口**

```ts
export interface AcquisitionCandidateResearchInput {
  scope: AcquisitionScope;
  run: AcquisitionRun;
  shard: AcquisitionOperationShard;
  candidateId: string;
  questions: string[];
  signal: AbortSignal;
}

export interface AcquisitionCandidateResearchResult {
  status:
    | "completed"
    | "no_new_evidence"
    | "access_restricted"
    | "failed";
  queries: Array<{
    query: string;
    providerConnectionId: string;
    resultCount: number;
  }>;
  addedEvidenceIds: string[];
}
```

- [ ] **Step 3: 生成跨行业查询**

组织候选固定生成：

```ts
[
  `"${name}" "${domain}" 采购 招标 合作`,
  `"${name}" 招聘 扩张 融资 新项目`,
  `"${name}" 供应商 系统 服务商`
]
```

个人候选固定生成：

```ts
[
  `"${publicDisplayName}" "${publicProfileUrl}" 求购 报价 合作`,
  `"${publicDisplayName}" 采购 寻找供应商 解决方案`,
  `"${publicDisplayName}" 比价 预算 上线`
]
```

空字段不进入查询；查询去重并截断为 3 条、每条不超过 500 字符。

- [ ] **Step 4: 实现同主体证据吸收**

调用 Run 已批准并仍有效的同一搜索连接。对每个结果重新执行
`resolveAcquisitionPublicIdentity()`，只有强身份等于目标 candidate 的结果才：

1. `appendEvidence()`；
2. `attachEvidenceToCandidate()`；
3. 记录 query/provider/source provenance。

不得复用 `search_public_sources` 的“可创建新候选”分支。幂等键包含
`runId + candidateId + providerConnectionId + normalizedSourceUrl`。

- [ ] **Step 5: 接入流水线**

Task 3 的 `research_candidate` 前先执行该服务；如果新增证据，再读取最新候选并
继续 `research_candidate → qualify_candidate → build_battle_card`。研究失败作为
候选 `research` failure，但不删除原证据。

- [ ] **Step 6: 验证并提交**

```bash
NODE_ENV=test node --import tsx --test --test-concurrency=1 \
  backend/src/acquisition-candidate-research-test.ts \
  backend/src/acquisition-candidate-processing-pipeline-test.ts \
  backend/src/acquisition-application-test.ts
npm run build --workspace backend
git add backend/src/acquisition-candidate-research.ts \
  backend/src/acquisition-candidate-research-test.ts \
  backend/src/acquisition-candidate-processing-pipeline.ts \
  backend/src/acquisition-candidate-processing-pipeline-test.ts \
  backend/src/acquisition-application.ts \
  backend/src/acquisition-application-test.ts
git commit -m "feat: research acquisition candidates safely"
```

---

## Task 6: 打通前端真实和演示作战卡

**Files:**

- Modify: `frontend/src/features/ai-growth/controller.ts`
- Modify: `frontend/src/features/ai-growth/controller.test.ts`
- Modify: `frontend/src/features/ai-growth/demo/fixture.ts`
- Modify: `frontend/src/features/ai-growth/demo/runner.test.ts`
- Modify: `frontend/src/features/ai-growth/types.ts`
- Modify: `frontend/src/features/ai-growth/view-model.ts`
- Modify: `frontend/src/features/ai-growth/view-model.test.ts`
- Modify: `frontend/src/features/ai-growth/components/battle-card-drawer.ts`
- Modify: `frontend/src/features/ai-growth/battle-card-drawer.test.ts`

**Interfaces:**

- Consumes: Task 2 presentation feed、Task 4 V1/V2 BattleCard GET。
- Produces: 能打开真实/演示作战卡的单一 AI 增长参谋体验。

- [ ] **Step 1: 写演示作战卡失败测试**

```ts
runner.jumpToResult();
await controller.openCandidate("demo-candidate-1");
assert.equal(controller.snapshot().drawer.open, true);
assert.match(controller.render().html, /客户作战卡/);
```

测试 `battle_card` 事件保存到 `Map<candidateId, BattleCardDto>`；点击没有卡的
演示候选显示“演示作战卡尚未生成”，不调用任何 API。

- [ ] **Step 2: 消费演示事件**

`applyDemoEvent()` 增加：

```ts
} else if (event.type === "battle_card") {
  demoBattleCards.set(event.battleCard.candidateId, event.battleCard);
} else if (event.type === "duplicate_merged") {
  demoDuplicateMerges.push(event.duplicateMerge);
}
```

`openCandidate()` 在 demo 模式调用 drawer 的只读
`openFixture(candidate, card, evidence, qualification, financial)`，而不是返回
Toast。

- [ ] **Step 3: 给演示计划加入真实查询流**

`fixture.plan.operations` 至少包含 6 条：

```ts
[
  "上海 装备制造 海外市场 招聘 外贸销售",
  "苏州 工业零部件 扩产 新项目",
  "宁波 制造企业 寻找供应商 合作",
  "长三角 制造业 CRM 招标 采购",
  "site:gov.cn 制造企业 扩产 项目 公示",
  "site:company-domain.example 英文站 海外业务"
]
```

Provider 名称只使用当前产品目录：
`baidu_ai_search`、`tencent_web_search`、`tavily`、`serper`、`brave`、
`serpapi`，展示层翻译成中文并加“演示数据”。

- [ ] **Step 4: 增加差异化证据**

六个候选分别使用不同信号：招聘外贸销售、英文站上线、扩产公告、CRM 招标、
海外展会、供应商服务投诉。置信度不得全部相同。每项资格理由引用自己的
`evidenceId`。

- [ ] **Step 5: 展示 V2 固定区域**

Drawer 先判断：

```ts
if (card.schemaVersion === "battle-card.v2" && card.intelligence) {
  return renderBattleCardV2(card);
}
return renderBattleCardV1(card);
```

V2 顺序固定为客户概况、需求证据、供应商、决策链、采购偏好、连接策略、角色
话术、不建议动作、财务摘要。所有 inference 显示“推测”和置信度。

- [ ] **Step 6: 验证并提交**

```bash
npm run test:unit --workspace frontend
npm run build --workspace frontend
git add frontend/src/features/ai-growth/controller.ts \
  frontend/src/features/ai-growth/controller.test.ts \
  frontend/src/features/ai-growth/demo/fixture.ts \
  frontend/src/features/ai-growth/demo/runner.test.ts \
  frontend/src/features/ai-growth/types.ts \
  frontend/src/features/ai-growth/view-model.ts \
  frontend/src/features/ai-growth/view-model.test.ts \
  frontend/src/features/ai-growth/components/battle-card-drawer.ts \
  frontend/src/features/ai-growth/battle-card-drawer.test.ts
git commit -m "feat: complete AI growth battle card experience"
```

---

## Task 7: 增加 Pi 运行预算和会话串行化

**Files:**

- Modify: `backend/src/acquisition-pi-agent.ts`
- Modify: `backend/src/acquisition-pi-agent-test.ts`
- Modify: `backend/src/acquisition-copilot-runner.ts`
- Modify: `backend/src/acquisition-copilot-runner-test.ts`
- Modify: `backend/src/acquisition-copilot-service.ts`
- Modify: `backend/src/acquisition-copilot-service-test.ts`
- Modify: `backend/src/acquisition-mysql-repositories.ts`
- Modify: `backend/src/acquisition-mysql-repositories-test.ts`

**Interfaces:**

- Consumes: 现有 Pi `AbortSignal`、Copilot task repository。
- Produces: 单次执行硬上限和同 session single-flight。

- [ ] **Step 1: 写运行上限失败测试**

固定默认上限：

```ts
export interface AcquisitionPiRunLimits {
  maxToolCalls: number;
  maxModelTurns: number;
  maxDurationMs: number;
  maxTotalTokens: number;
}

export const DEFAULT_ACQUISITION_PI_RUN_LIMITS =
  Object.freeze<AcquisitionPiRunLimits>({
    maxToolCalls: 32,
    maxModelTurns: 16,
    maxDurationMs: 180_000,
    maxTotalTokens: 200_000
  });
```

测试第 33 个工具调用返回 `AGENT_TOOL_BUDGET_EXHAUSTED`；第 17 个模型回合返回
`AGENT_TURN_BUDGET_EXHAUSTED`；超时返回 `AGENT_DURATION_EXHAUSTED`；外部取消
优先返回 `MODEL_STREAM_ABORTED`。达到上限后不得启动新工具。

- [ ] **Step 2: 实现 budget controller**

Runner 创建一个组合 AbortController，将用户取消、任务超时和预算耗尽传给 Pi
和全部 Tool Executor。每个 assistant turn 累计模型回合和 token；每个 tool
start 累计工具调用。错误只返回稳定 code。

- [ ] **Step 3: 写 session 并发失败测试**

同一 session 同时 enqueue 两条消息：

```ts
assert.equal(await repository.claimTaskDispatch(scope, first.id), true);
assert.equal(await repository.claimTaskDispatch(scope, second.id), false);
```

第一条终态后，第二条才可 claim。不同 session 可并行。Memory 和 MySQL 行为
必须一致。

- [ ] **Step 4: 实现 single-flight**

`claimTaskDispatch()` 在同一事务中：

1. 读取目标 queued task；
2. 查询同 owner/team/session 是否存在 `running` task；
3. 存在则返回 false；
4. 不存在则将目标 task 原子转为 claimed/running。

恢复任务按 `(createdAt,id)` 排序重新入队，不改变同会话顺序。

- [ ] **Step 5: 验证并提交**

```bash
NODE_ENV=test node --import tsx --test --test-concurrency=1 \
  backend/src/acquisition-pi-agent-test.ts \
  backend/src/acquisition-copilot-runner-test.ts \
  backend/src/acquisition-copilot-service-test.ts \
  backend/src/acquisition-mysql-repositories-test.ts
npm run build --workspace backend
git add backend/src/acquisition-pi-agent.ts \
  backend/src/acquisition-pi-agent-test.ts \
  backend/src/acquisition-copilot-runner.ts \
  backend/src/acquisition-copilot-runner-test.ts \
  backend/src/acquisition-copilot-service.ts \
  backend/src/acquisition-copilot-service-test.ts \
  backend/src/acquisition-mysql-repositories.ts \
  backend/src/acquisition-mysql-repositories-test.ts
git commit -m "fix: bound acquisition agent execution"
```

---

## Task 8: 端到端验收和交接

**Files:**

- Create: `frontend/tests/ai-acquisition-loop.spec.ts`
- Modify: `docs/product/ai-acquisition-agent.md`
- Modify: `docs/superpowers/specs/2026-07-26-ai-acquisition-loop-closure-design.md`

**Interfaces:**

- Consumes: Tasks 1–7 的生产契约。
- Produces: 可重复验证的真实/演示旅程和运维说明。

- [ ] **Step 1: 建立严格 E2E fixture**

Fixture 覆盖：

```text
创建会话
→ plan_draft
→ 创建并审批计划
→ 创建 Run
→ presentation 第一页 hasMore=true
→ 第二页追平
→ candidate 从 researched 更新为 qualified
→ S/A candidate 出现 battle-card.v2
→ 用户审核并转换 CRM
```

请求日志断言 demo 不调用外部搜索、review、convert 或 todo 写接口。

- [ ] **Step 2: 覆盖失败恢复**

E2E 覆盖：

- 搜索连接缺失；
- 单 Provider 失败；
- 单候选研究失败；
- 财务待评估；
- cursor 篡改；
- pause/resume/cancel；
- 作战卡生成失败后重试；
- pending review 不允许转换；
- approved 后转换只执行一次。

- [ ] **Step 3: 更新交接文档**

`docs/product/ai-acquisition-agent.md` 明确：

- Pi 和确定性流水线的职责；
- 两道人工作业门；
- presentation 指标口径；
- V1/V2 作战卡兼容；
- 研究、模型和搜索预算；
- 本地启动、测试和恢复命令。

设计文档状态改为“已实现”时必须同时写入最终提交和完整验收命令；测试未全部
通过时保持“实施中”。

- [ ] **Step 4: 全量验证**

```bash
npm run test:contracts
npm run test:acquisition --workspace backend
npm run test --workspace backend
npm run test --workspace frontend
npm run test:e2e --workspace frontend -- ai-acquisition-loop.spec.ts
npm run build
git diff --check
```

额外安全检查：

```bash
rg -n 'shell_exec|file_write|auto.*friend|auto.*message|模拟真人|绕过风控' \
  backend/src/acquisition-* frontend/src/features/ai-growth
rg -n 'POST.*battle-card|candidates/.*/battle-card.*POST' \
  frontend/src/features/ai-growth frontend/tests
```

- [ ] **Step 5: 提交**

```bash
git add frontend/tests/ai-acquisition-loop.spec.ts \
  docs/product/ai-acquisition-agent.md \
  docs/superpowers/specs/2026-07-26-ai-acquisition-loop-closure-design.md
git commit -m "test: verify AI acquisition loop"
```

## 完成定义

- [ ] 一句话任务能在一次 Run 内自动产生优先客户和作战卡。
- [ ] 用户能看见 AI 实际搜索了什么、用了哪个 Provider、为什么推荐客户。
- [ ] 搜索后不再要求逐条点击评分或生成作战卡。
- [ ] 作战卡稳定展示供应商、决策链、采购偏好和连接策略。
- [ ] 任何推测都有证据和置信度，任何未知都不会被补写成事实。
- [ ] 单来源、单候选或单模型失败表现为 partial success，不丢失已完成结果。
- [ ] 运行、模型、工具和补充搜索均有硬预算和取消传播。
- [ ] CRM 转换和触达仍由人工确认。
- [ ] contracts、backend、frontend、E2E 和 build 全部通过。
