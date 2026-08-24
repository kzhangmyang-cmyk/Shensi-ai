# AI 增长参谋前端体验实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有传统 CRM 首页强化为“AI 全网获客指挥中心”，用同一套组件支持可信真实模式和明确标注的确定性演示模式。

**Architecture:** 保持现有 Vite + 原生 DOM 架构，不引入新的页面框架。新增隔离的 `frontend/src/features/ai-growth/` feature；`prototype-api.ts` 只负责壳层导航、认证依赖注入和生命周期，feature 自己管理状态机、API、轮询、演示 runner 与组件渲染。

**Tech Stack:** TypeScript、DOM APIs、现有 CSS tokens、Vite、Node test runner、Playwright。

## Global Constraints

- 保持现有 Vite + TypeScript + 原生 DOM 页面架构，不引入新的 UI 框架。
- 新逻辑放入 `frontend/src/features/ai-growth/`，不得继续堆入大型 `prototype-api.ts`。
- demo 和 real 必须共享同一 ViewModel 与组件。
- demo 明确标注“演示数据”，45–90 秒，不调用外部搜索、审核、转换或 CRM 待办写接口。
- real 状态只由后端任务/运行/presentation 驱动，不用定时器伪造。
- 不从模型自由文本解析计划，不从全局 candidate 列表或创建时间猜 run 归属。
- 财务缺失显示“待评估”；不同币种分别显示。
- 作战卡只能经 Copilot 的 `build_battle_card` 工具生成。
- 使用现有图标体系，不用 emoji、CSS art、内联 SVG 或宣传水印充当产品资产。
- 1440×900、1366×768、1024×768 无横向溢出，并支持键盘、live status、focus management、`prefers-reduced-motion`。
- 每项状态、映射和轮询行为先写失败测试。

---

## Task 1: 建立稳定 DTO、ViewModel 与模板契约

**Files:**

- Create: `frontend/src/features/ai-growth/types.ts`
- Create: `frontend/src/features/ai-growth/templates.ts`
- Create: `frontend/src/features/ai-growth/view-model.ts`
- Create: `frontend/src/features/ai-growth/view-model.test.ts`
- Modify: `frontend/package.json`

**Interfaces:**

- Consumes: 后端 OpenAPI 中 plan、presentation、candidate、qualification、financial-value、battle-card DTO。
- Produces: `AdvisorState`、DTO 类型、行业模板和纯 ViewModel 映射，供全部后续前端任务使用。

### 1.1 添加独立单元测试命令

- [ ] 在 `frontend/package.json` 增加：

```json
{
  "test:unit": "tsx --test src/features/ai-growth/*.test.ts",
  "test": "npm run test:unit && tsx src/self-test.ts"
}
```

- [ ] 单元测试只测纯字符串渲染、状态机、映射和 poller；不引入 jsdom/happy-dom。焦点锁定、Escape、body scroll lock 和真实 DOM 可访问性放到 Playwright 集成计划。

### 1.2 先写 ViewModel 失败测试

- [ ] 测试以下纯函数行为：
  - 运行 presentation candidate event 按 `candidateId` upsert，而不是 append 重复卡片。
  - summary 永远用最新完整快照覆盖。
  - 多币种分别格式化，优先 CNY，不合计。
  - 没有 `financialValue` 显示“待评估”，不生成默认金额。
  - S/A 为高意向；S/A/B 且 hard gates 通过、非勿扰才是有效商机。
  - connection missing、partial success、empty、failed 映射为显式页面状态。
  - inference section 必须得到“推测”标签、置信度和证据引用。

- [ ] 运行 `npm run test:unit --workspace frontend` 并确认失败。

### 1.3 定义前端契约

- [ ] `types.ts` 至少定义：

```ts
export type AdvisorMode = "demo" | "real";
export type AdvisorStatus =
  | "idle"
  | "planning"
  | "awaiting_approval"
  | "running"
  | "paused"
  | "partial_success"
  | "completed"
  | "cancelled"
  | "connection_required"
  | "empty"
  | "failed";

export interface AdvisorState {
  mode: AdvisorMode;
  status: AdvisorStatus;
  taskText: string;
  templateId: IndustryTemplateId;
  planDraft: AcquisitionPlanCreateDto | null;
  runId: string | null;
  cursor: string | null;
  candidatesById: Map<string, CandidateCardVm>;
  summary: ExecutiveSummaryVm | null;
  error: AdvisorErrorVm | null;
}
```

- [ ] DTO 只覆盖生产 OpenAPI 返回字段；不得在组件层导入后端 repository 类型。`RunPresentationDto` 必须与后端固定契约逐字段一致：run、provider shard 计数/失败、summary、高意向财务已评估/待评估、candidate events、`nextAfter`、`hasMore`；事件时间只使用公开 `createdAt`。
- [ ] `view-model.ts` 是唯一 DTO→ViewModel 入口，导出：

```ts
export function mergePresentation(
  previous: AdvisorRunVm,
  dto: RunPresentationDto
): AdvisorRunVm;

export function financialValueVm(
  value: FinancialValueDto | null
): FinancialValueVm;

export function battleCardSectionsVm(
  sections: BattleCardSectionDto[]
): BattleCardSectionVm[];
```

### 1.4 添加行业模板

- [ ] `templates.ts` 固定提供：
  - 企业服务（默认）
  - 外贸制造
  - 装修
  - 美业
  - 教培
  - 自定义行业
- [ ] 模板只填充可编辑的目标、地区、规模、需求信号和排除条件，不包含连接 ID、预算操作或财务结论。
- [ ] 企业服务演示文案使用：

```text
帮我寻找上海近期可能有数字化采购需求、员工规模 50 人以上的制造企业。
```

### 1.5 验证并提交

- [ ] 运行 unit tests 与 frontend build。
- [ ] 提交：

```bash
git add frontend/package.json \
  frontend/src/features/ai-growth/types.ts \
  frontend/src/features/ai-growth/templates.ts \
  frontend/src/features/ai-growth/view-model.ts \
  frontend/src/features/ai-growth/view-model.test.ts
git commit -m "feat: add AI growth advisor view models"
```

---

## Task 2: 构建零网络写入的确定性演示 runner

**Files:**

- Create: `frontend/src/features/ai-growth/demo/fixture.ts`
- Create: `frontend/src/features/ai-growth/demo/runner.ts`
- Create: `frontend/src/features/ai-growth/demo/runner.test.ts`
- Modify: `frontend/package.json`

**Interfaces:**

- Consumes: Task 1 的 `AdvisorState` 与 DTO/ViewModel 类型。
- Produces: `createDemoRunner()` 和 DTO 同形 Fixture，供 Task 4/Task 6 驱动同一组件。

### 2.1 先写 runner 失败测试

- [ ] 使用 fake clock 覆盖：
  - 总时长可配置为 45–90 秒，默认 72 秒。
  - 时间线按 `planning → awaiting_approval → running → completed` 推进。
  - 未调用 `approve()` 时不能进入 running。
  - pause 冻结时间线；resume 从原进度继续。
  - jumpToResult 直接进入 completed，但保留完整事件顺序和演示标签。
  - stop/dispose 后不再发事件。
  - runner 构造函数没有 request/api 依赖，无法发网络请求。

### 2.2 创建真实结构 Fixture

- [ ] `fixture.ts` 使用与生产 DTO 同形状的数据，包含：
  - 6 个公开搜索来源的成功/部分失败状态。
  - 至少 6 个企业候选。
  - 重复主体合并事件。
  - S/A/B/C 等级。
  - CNY 财务值、一个非 CNY 财务值、至少两个待评估。
  - 一张含 fact/inference/unknown section 的作战卡。
  - 运行完成老板摘要。
- [ ] 所有演示数据在根对象和可见页面中带 `demo: true`/“演示数据”标签。
- [ ] 不使用真实个人联系方式或敏感信息。

### 2.3 实现 runner

- [ ] 导出：

```ts
export interface DemoRunner {
  start(): void;
  approve(): void;
  pause(): void;
  resume(): void;
  jumpToResult(): void;
  dispose(): void;
}

export function createDemoRunner(options: {
  durationMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => number;
  cancel?: (id: number) => void;
  onEvent(event: AdvisorDemoEvent): void;
}): DemoRunner;
```

- [ ] 事件按固定百分比水位发出；不使用随机数。
- [ ] `prefers-reduced-motion` 只影响视觉过渡，不改变业务时间线和事件。
- [ ] demo 测试文件创建后，再把 unit command 扩展为：

```json
{
  "test:unit": "tsx --test src/features/ai-growth/*.test.ts src/features/ai-growth/demo/*.test.ts"
}
```

这样 Task 1 不会把尚不存在的 demo glob 原样传给 `tsx`。

### 2.4 验证并提交

- [ ] 运行 `npm run test:unit --workspace frontend`。
- [ ] 提交：

```bash
git add frontend/src/features/ai-growth/demo \
  frontend/package.json
git commit -m "feat: add deterministic AI growth demo"
```

---

## Task 3: 实现真实模式 API 适配与可信增量轮询

**Files:**

- Create: `frontend/src/features/ai-growth/api.ts`
- Create: `frontend/src/features/ai-growth/poll-run.ts`
- Create: `frontend/src/features/ai-growth/poll-run.test.ts`

**Interfaces:**

- Consumes: Task 1 的 DTO/ViewModel、后端 planDraft/presentation/financial-value 契约。
- Produces: `createAiGrowthApi()` 与 `createRunPresentationPoller()`，供 Task 5/Task 6 使用。

### 3.1 写 API/poller 失败测试

- [ ] 覆盖：
  - 首次 presentation 请求不带 `after`。
  - `hasMore=true` 时立即用 `nextAfter` 取下一页。
  - 追平后保留 cursor 并每 2.5 秒轮询。
  - terminal + `hasMore=false` 才停止。
  - 页面 hidden 时暂停，visible 后继续同一 cursor。
  - mode/run 切换会 abort 旧请求并用 generation token 丢弃迟到响应。
  - 只有网络错误、429、5xx 退避；4xx 业务错误直接进入对应状态。
  - cursor error 不回退到全局候选列表。

### 3.2 实现 API client

- [ ] 统一依赖注入：

```ts
export interface AdvisorRequest {
  <T>(path: string, init?: RequestInit): Promise<T>;
}

export function createAiGrowthApi(request: AdvisorRequest) {
  return {
    createSession(
      input: { connectionId?: string | null },
      idempotencyKey: string
    ): Promise<CopilotSessionDto>,
    listProviderConnections(): Promise<PageDto<ProviderConnectionDto>>,
    requestPlanDraft(
      sessionId: string,
      message: string,
      idempotencyKey: string
    ): Promise<CopilotTaskDto>,
    requestAssistantAction(
      sessionId: string,
      message: string,
      idempotencyKey: string
    ): Promise<CopilotTaskDto>,
    getCopilotTask(taskId: string): Promise<CopilotTaskDto>,
    createPlan(
      input: AcquisitionPlanCreateDto,
      idempotencyKey: string
    ): Promise<PlanDtoWithEtag>,
    getPlan(planId: string): Promise<PlanDtoWithEtag>,
    approvePlan(
      planId: string,
      etag: string,
      input: { decision: "approve"; reason: string }
    ): Promise<PlanDtoWithEtag>,
    createRun(
      planId: string,
      input: { reason: string },
      idempotencyKey: string
    ): Promise<RunDto>,
    getRun(runId: string): Promise<RunDtoWithEtag>,
    getRunPresentation(
      runId: string,
      input: { after?: string; limit: number },
      signal: AbortSignal
    ): Promise<RunPresentationDto>,
    pauseRun(
      runId: string,
      etag: string,
      reason: string
    ): Promise<RunDto>,
    resumeRun(
      runId: string,
      etag: string,
      reason: string
    ): Promise<RunDto>,
    cancelRun(
      runId: string,
      etag: string,
      reason: string
    ): Promise<RunDto>,
    getCandidate(candidateId: string): Promise<CandidateDto>,
    getEvidence(
      candidateId: string,
      cursor?: string
    ): Promise<PageDto<EvidenceDto>>,
    getQualification(candidateId: string): Promise<QualificationDto>,
    getFinancialValue(
      candidateId: string
    ): Promise<FinancialValueDto>,
    getBattleCard(candidateId: string): Promise<BattleCardDto>,
    reviewCandidate(
      candidateId: string,
      input: CandidateReviewDto,
      idempotencyKey: string
    ): Promise<CandidateReviewResultDto>,
    convertCandidate(
      candidateId: string,
      input: { decisionVersion: string },
      idempotencyKey: string
    ): Promise<CandidateConversionDto>,
    createTodo(
      input: TodoCreateDto,
      idempotencyKey: string
    ): Promise<TodoDto>
  };
}
```

- [ ] 所有写 POST 都发送 8–200 字符 `Idempotency-Key`：普通动作使用 `crypto.randomUUID()`；转换后的 todo 使用下述 conversion 派生稳定 key 以支持安全重试。
- [ ] `requestPlanDraft()` 固定发送 `responseMode:"plan_draft"`；`requestAssistantAction()` 固定发送 `responseMode:"assistant"`，供 `qualify_candidate`、`build_battle_card` 和 `create_review_task` 受控工具路径使用。
- [ ] PATCH/approval/control 使用服务器 ETag 和 `If-Match`。
- [ ] 412/409 并发冲突映射为“计划已被其他成员更新”，必须重新 GET/确认。
- [ ] candidate evidence 按 `nextCursor` 读完所有页；不得只展示第一页就声称证据完整。
- [ ] 转换成功后，todo idempotency key 固定为 `ai-growth-todo:` + SHA-256(conversion.id) 前 48 个 hex 字符；同一 conversion 的所有重试必须复用该 key，不能每次重新 randomUUID。

### 3.3 实现 poller

- [ ] `createRunPresentationPoller()` 使用 `AbortController`、generation token、visibility listener。
- [ ] 轮询只消费 presentation API；不得调用 `/candidates` 全局列表猜测结果。
- [ ] 对 candidate events 调用 ViewModel upsert。

### 3.4 验证并提交

- [ ] 运行 unit tests 和 build。
- [ ] 提交：

```bash
git add frontend/src/features/ai-growth/api.ts \
  frontend/src/features/ai-growth/poll-run.ts \
  frontend/src/features/ai-growth/poll-run.test.ts
git commit -m "feat: add AI growth real mode client"
```

---

## Task 4: 构建 AI 增长参谋页面组件

**Files:**

- Create: `frontend/src/features/ai-growth/components/shell.ts`
- Create: `frontend/src/features/ai-growth/components/task-input.ts`
- Create: `frontend/src/features/ai-growth/components/plan-approval.ts`
- Create: `frontend/src/features/ai-growth/components/run-console.ts`
- Create: `frontend/src/features/ai-growth/components/candidate-list.ts`
- Create: `frontend/src/features/ai-growth/components/executive-summary.ts`
- Create: `frontend/src/features/ai-growth/components/connection-required.ts`
- Create: `frontend/src/features/ai-growth/styles.css`

**Interfaces:**

- Consumes: Task 1 的 ViewModel 和 Task 2 的演示事件。
- Produces: 无副作用 DOM renderers 与样式，供 Task 6 controller 组合。

### 4.1 先增加纯渲染测试

- [ ] 在 `view-model.test.ts` 或新增 `components.test.ts` 以纯字符串/结构输出覆盖，不依赖浏览器 DOM：
  - 首屏标题“AI 正在为你发现全网商机”。
  - demo/real 模式和演示标签。
  - 每个显式状态都有文字而不只依赖颜色。
  - awaiting approval 展示地区、行业、规模、信号、排除、搜索主题、数据源和预算上限。
  - 没连接时只显示配置搜索来源/使用演示模式，不显示假进度。
  - 财务缺失显示“待评估”。
  - partial success 展示成功与失败来源。

### 4.2 实现可组合组件

- [ ] 每个组件只接收 ViewModel + callback，不直接调用 API。
- [ ] `task-input.ts` 展示自然语言输入、六个行业模板、demo/real 切换、已连接搜索来源健康状态、最近任务和继续任务入口。
- [ ] `shell.ts` 负责状态区域和 live region：

```html
<section class="ai-growth-shell" aria-labelledby="aiGrowthTitle">
  <div id="aiGrowthStatus" role="status" aria-live="polite"></div>
  <div id="aiGrowthStage"></div>
</section>
```

- [ ] `run-console.ts` 桌面双栏：左执行时间线/查询流，右候选列表。
- [ ] `candidate-list.ts` 用现有图标库/字符图标系统，不使用 emoji。
- [ ] 候选卡固定展示企业名称、行业/地区、需求信号摘要、来源数量、证据置信度、意向等级、财务值或“待评估”、作战卡入口。
- [ ] 成果指标显示完整口径提示；金额按币种分组。
- [ ] `executive-summary.ts` 提供：
  - 查看优先客户
  - 为首位客户生成作战卡
  - 转为线索并创建跟进任务
- [ ] demo 模式第三个动作只预览；real 模式才触发受控转换链路。
- [ ] real 模式只有 candidate 已是 `approved` 时才允许 convert；未审核客户显示“先完成人工审核”，绝不自动批准。
- [ ] `pending_review`、`rejected`、`do_not_contact`、`needs_research` 状态使用明确文字与可用动作，不只显示一个不可点击提示。

### 4.3 实现视觉与响应式

- [ ] 延续现有深蓝 token，不引入新的宣传水印或 GoodJob/AI 左上角字样。
- [ ] `styles.css`：
  - 1440/1366：完整双栏。
  - ≤1180：缩小指标与辅助栏。
  - ≤1024：主从单栏，不隐藏核心状态。
  - 所有 grid child `min-width: 0`。
  - 页面 `overflow-x` 不依赖强制 hidden 掩盖布局错误。
  - `prefers-reduced-motion` 关闭位移/数字跳动过渡。

### 4.4 验证并提交

- [ ] 运行 unit tests 和 build。
- [ ] 提交：

```bash
git add frontend/src/features/ai-growth/components \
  frontend/src/features/ai-growth/styles.css \
  frontend/src/features/ai-growth/*test.ts
git commit -m "feat: build AI growth advisor workspace"
```

---

## Task 5: 实现客户作战卡抽屉与受控生成

**Files:**

- Create: `frontend/src/features/ai-growth/components/battle-card-drawer.ts`
- Modify: `frontend/src/features/ai-growth/api.ts`
- Test: `frontend/src/features/ai-growth/battle-card-drawer.test.ts`

**Interfaces:**

- Consumes: Task 3 的 API client、Task 1 的 battle-card ViewModel。
- Produces: `battle-card-drawer` 的 open/close/load/generate/review 控制面与 `onCandidateUpdated` 回调，供 Task 6 controller 调用。

### 5.1 写失败测试

- [ ] 打开抽屉时并行读取 candidate、完整分页 evidence、qualification、financial-value、battle-card；每个读请求独立结算，单个 404 不得使其他已成功信息消失。
- [ ] qualification 404 显示“待资格评估”，并提供显式“运行资格评估”按钮；点击后通过 `requestAssistantAction()` 明确要求调用 `qualify_candidate` 并携带 candidateId，轮询 task，只有 succeeded 且 `toolNames` 包含 `qualify_candidate` 才重新 GET qualification 与 financial-value。
- [ ] financial 404 映射为“待评估”；其他错误显示真实错误。
- [ ] battle-card 404 后：
  - 复用/创建 Copilot session。
  - POST message 明确要求调用 `build_battle_card` 并携带 candidateId。
  - 轮询 task。
  - 只有 succeeded 且 `toolNames` 包含 `build_battle_card` 才重新 GET card。
  - 前端从不 POST `/candidates/:id/battle-card`。
- [ ] inference/unknown 不以事实语气显示。
- [ ] `pending_review` 候选显示“候选资格人工复核”面板：当前 decisionVersion、hard gates、AI 理由、可选 reason，以及批准、驳回、设为勿扰、需要补充研究四个明确动作。
- [ ] 人工复核调用 `reviewCandidate(candidateId,{action,decisionVersion,reason},idempotencyKey)`；成功后重新 GET candidate/qualification/financial-value，并通过 `onCandidateUpdated` 回调更新主列表。只有返回 `status:"approved"` 且 `approvedDecisionVersion === latestDecisionVersion` 后，才显示转换和“创建外联动作审核任务”。
- [ ] `rejected`、`do_not_contact`、`needs_research` 状态根据后端允许条件提供 `reopen`，仍使用最新 decisionVersion；任何状态转换都必须由用户点击确认，不由 AI 自动批准。
- [ ] 纯单元测试覆盖 open/close/load/generate 状态输出；Escape、焦点锁定、焦点恢复和 body 滚动锁定在集成 Playwright 中验证。

### 5.2 实现抽屉

- [ ] 桌面宽度 600px；1024 视口最大 `52vw`；更窄视口使用可用宽度。
- [ ] Section 按：
  - 事实
  - 推测（置信度）
  - 未知/待核验
  显式分组并链接证据。
- [ ] 生成任务运行时显示真实 task 状态，不用计时器伪造。
- [ ] “创建外联动作审核任务”只在候选已批准后显示；必须通过 `requestAssistantAction()` 明确要求调用现有 `create_review_task`，且成功 task 的 `toolNames` 必须包含 `create_review_task`。`reviewCandidate()` 专门用于上述候选资格人工复核，不能把 `/review` 当作创建任务。

### 5.3 验证并提交

- [ ] 运行 unit tests 和 build。
- [ ] 提交：

```bash
git add frontend/src/features/ai-growth/components/battle-card-drawer.ts \
  frontend/src/features/ai-growth/battle-card-drawer.test.ts \
  frontend/src/features/ai-growth/api.ts
git commit -m "feat: add controlled customer battle cards"
```

---

## Task 6: 编排页面状态机并接入现有导航壳

**Files:**

- Create: `frontend/src/features/ai-growth/controller.ts`
- Create: `frontend/src/features/ai-growth/index.ts`
- Modify: `frontend/index.html`
- Modify: `frontend/src/prototype-api.ts`
- Modify: `frontend/src/self-test.ts`

**Interfaces:**

- Consumes: Task 2 runner、Task 3 API/poller、Task 4 renderers、Task 5 drawer。
- Produces: `mountAiGrowthAdvisor()` lifecycle，并将 feature 注册到现有导航壳。

### 6.1 写状态机失败测试

- [ ] 新增 `controller.test.ts`，覆盖：
  - idle→planning→awaiting_approval→running→completed。
  - 未批准不能 create run。
  - pause/resume/cancel 映射真实 API。
  - connection-required 保留用户输入。
  - drawer 人工复核成功后按 candidateId 更新主列表；只有 approved/current decision 才开放转换。
  - convert 成功后先保存 conversionId，再用其稳定 todo key 创建待办；todo 失败只重试第二步并复用同一 key，不重复 convert。
  - demo→real 清除所有 demo run/candidate/timer。
  - leave/logout dispose poller、demo runner、drawer。
  - 真实模式不根据 timer 改业务状态。

### 6.2 实现 controller

- [ ] 构造依赖：

```ts
export interface AiGrowthDependencies {
  request: AdvisorRequest;
  toast(message: string): void;
  navigate(view: string): void;
  currentUser(): User | null;
  document?: Document;
}
```

- [ ] `index.ts` 导出单例挂载接口：

```ts
export function mountAiGrowthAdvisor(
  root: HTMLElement,
  dependencies: AiGrowthDependencies
): {
  enter(): void;
  leave(): void;
  dispose(): void;
};
```

- [ ] 真实计划 flow：
  1. create Copilot session
  2. send `responseMode: "plan_draft"`
  3. poll task
  4. render service-validated planDraft
  5. user edits semantic inputs后重新请求 plan draft
  6. create plan
  7. approve with ETag
  8. create run
  9. start presentation poller
- [ ] 最近任务只在 `localStorage["goodjob.ai-growth.recent.<userId>"]` 保存最多 10 个 `{sessionId,planId,runId,updatedAt}` 指针，不保存候选内容、API Key 或模型输出；进入页面时用 GET run/session 验证，404 指针立即清除。

### 6.3 接入 HTML

- [ ] `frontend/index.html`：
  - 第一导航新增 active 的 `data-view="ai-growth"`，标题“AI 增长参谋”。
  - 原 dashboard 取消 active。
  - dashboard 前新增：

```html
<div class="view active" id="ai-growth">
  <div id="aiGrowthRoot"></div>
</div>
```

  - “自动获客”改名为“全网商机”。
  - 删除该页可见的“功能持续优化中”弱提示，替换为正式产品说明。
  - 主导航前七个入口固定为：
    1. `ai-growth` → AI 增长参谋
    2. `lead-finder` → 全网商机
    3. `leads` → 线索池
    4. `prospect-list` → 客户作战
    5. `pipeline` → CRM 跟进
    6. `reports` → 经营分析
    7. `settings` → 设置
  - 其他既有路由保留在现有二级分组中，不删除页面或权限。
  - 同步底部 legacy inline nav 的 labels/openTabs 默认值为 `ai-growth`，本功能不删除整段 legacy script，避免无关大重构。

### 6.4 接入 `prototype-api.ts`

- [ ] 导入 feature 和 `styles.css`。
- [ ] `openWorkspaceTabs/workspaceTabHistory` 默认 `["ai-growth"]`。
- [ ] `viewLabels`、全局搜索映射增加 AI 增长参谋；lead-finder 文案改为“全网商机”。
- [ ] 启动后挂载 feature，注入现有 `api/toast/activateNavView/state.user`。
- [ ] `activateNavView()`：
  - 从 ai-growth 离开时 `leave()`。
  - 进入时 `enter()`。
- [ ] `self-test.ts` 只验证 root、nav、模块导入和默认 active；业务逻辑留在 unit tests。

### 6.5 验证并提交

- [ ] 运行：

```bash
npm run test:unit --workspace frontend
npm run test --workspace frontend
npm run build --workspace frontend
```

- [ ] 提交：

```bash
git add frontend/index.html \
  frontend/src/prototype-api.ts \
  frontend/src/self-test.ts \
  frontend/src/features/ai-growth/controller.ts \
  frontend/src/features/ai-growth/controller.test.ts \
  frontend/src/features/ai-growth/index.ts
git commit -m "feat: make AI growth advisor the default workspace"
```

---

## Task 7: 修复 AI 配置页阻断并同步官方 Provider 表达

**Files:**

- Create: `frontend/src/styles/ai-config-responsive.css`
- Modify: `frontend/src/prototype-api.ts`
- Modify: `frontend/index.html`
- Modify: `frontend/src/self-test.ts`

**Interfaces:**

- Consumes: 现有官方模型 Provider preset 与 AI 配置 DOM。
- Produces: 可在 1024px 使用的 AI 配置布局和同步后的官方 Provider 表达。

### 7.1 添加阻断测试

- [ ] self-test 验证官方 Provider 选项至少包括 OpenAI、DeepSeek、Qwen、Kimi、MiniMax、GLM、豆包。
- [ ] 1024px E2E 在集成计划中验证无水平溢出。

### 7.2 修复布局

- [ ] `ai-config-responsive.css`：
  - ≤1180：两列，状态面板整行。
  - ≤1024：单列，所有子项 `min-width: 0`。
  - ≤600：Provider 列表、配置区、按钮和输入单列。
- [ ] 在 `prototype-api.ts` 导入 CSS。
- [ ] 设置页主叙事优先官方厂商、认证模型、连接状态、凭据版本、测试结果；自定义 Base URL 退为高级配置，不删除现有兼容能力。
- [ ] 不新增模型 Provider 后端能力；只同步已支持契约。

### 7.3 验证并提交

- [ ] 运行 frontend test/build。
- [ ] 提交：

```bash
git add frontend/src/styles/ai-config-responsive.css \
  frontend/src/prototype-api.ts \
  frontend/index.html \
  frontend/src/self-test.ts
git commit -m "fix: strengthen AI provider settings layout"
```

## 前端完成定义

- 默认首屏是 AI 增长参谋。
- demo 与 real 使用同一 ViewModel 和组件。
- demo 路径确定、可暂停/继续/跳过，且无法访问网络。
- real 模式严格使用 plan draft、presentation、financial-value 三个可信契约。
- 所有状态、错误和部分失败有文本说明。
- 作战卡只经受控 Copilot 工具生成。
- 页面离开、切换模式和登出不会留下轮询或定时器。
- frontend unit/self-test/build 全绿。
