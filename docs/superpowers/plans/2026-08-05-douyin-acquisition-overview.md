# 抖音获客中心真实任务总览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将新版获客中心从静态演示任务升级为由 GoodJob 权威 `AcquisitionPlan + latest AcquisitionRun` 驱动的真实抖音任务总览、任务详情和候选作战入口。

**Architecture:** 后端新增只读任务聚合服务和 REST 路由，复用现有 Plan、Run、Shard 与 Run Presentation，不复制写模型。前端在现有 AI 增长参谋内新增“任务总览”层，保留 `GoodJob-marketing-system-frontend` 的平台卡片、任务表格和执行时间线视觉语言，通过独立 ViewModel 消费真实 API；既有创建、审批、运行、作战卡、审核与 CRM 转换继续走现有权威接口。

**Tech Stack:** TypeScript、Node.js、Express、MySQL/In-memory repositories、React/Vite 外壳内的现有 DOM 组件、Node test runner、Playwright。

## Global Constraints

- 本计划只开发业务功能；不处理前一分支遗留的 OpenAPI 转换器或 `$defs` 生成问题。
- 正式“获客任务”的唯一身份是 `planId`，任务状态来自该 Plan 的 latest Run；latest 按 `createdAt`、再按 `id` 降序确定。
- 平台与搜索提供商严格分离：平台只允许 `douyin` 或 `web`；百度、腾讯、Tavily、Serper、Brave、SerpApi 只能出现在 provider 字段。
- 发现方式只允许 `public_search`、`user_import`、`official_authorized`；当前没有官方抖音授权时不得展示 `official_authorized` 已连接。
- 未完成财务评估必须显示 `null` / “待评估”，不得填充演示收入。
- 演示模式必须显示“演示数据”，且不会调用任何正式获客写接口。
- 不新增自动评论、自动私信、自动加好友、自动群发或任何规避平台检测功能。
- 自动测试不得访问真实搜索或抖音网络；使用确定性 fixture。
- 所有接口必须按 `ownerId + teamId` 隔离；跨租户任务返回 404。
- 不读取、修改、暂存或提交用户未跟踪文件 `docs/superpowers/plans/2026-07-23-ai-model-adapters-and-pi.md`。

---

### Task 1: 权威 Plan/Run 任务聚合读模型

**Files:**
- Create: `backend/src/acquisition-task-overview.ts`
- Create: `backend/src/acquisition-task-overview-test.ts`
- Modify: `backend/src/acquisition-plan-run-repository.ts`
- Modify: `backend/src/acquisition-mysql-repositories.ts`

**Interfaces:**
- Consumes: `AcquisitionPlan`, `AcquisitionRun`, `AcquisitionPlanRunRepository`, `AcquisitionScope`。
- Produces: `AcquisitionTaskOverviewService`；`getOverview(scope, platform)`、`listTasks(scope, query)`、`getTask(scope, planId)`；repository 新增按租户列出 Plan/Run 的只读方法。
- `AcquisitionTaskSummary` 固定字段：`id`、`planId`、`name`、`objective`、`platform`、`discoveryMethods`、`planStatus`、`latestRun`、`updatedAt`。
- `latestRun` 固定字段：`id`、`status`、`updatedAt`、`completedAt`、`evidenceCount`、`consumedBudget`；无 Run 时为 `null`。
- `AcquisitionTaskOverview` 固定字段：`generatedAt`、`platform`、`totals`、`statusCounts`、`discoveryMethodCounts`、`tasks`；`tasks` 取最近 20 项。

- [x] **Step 1: 先写聚合行为失败测试**

  在 `acquisition-task-overview-test.ts` 创建不同租户的 Plan 和多个 Run，断言：跨租户不可见；每个 Plan 只取 latest Run；`site:douyin.com`/`iesdouyin.com` 推断为 `douyin`；search/import/content-fetch 分别映射为公开搜索/用户导入；空财务数据不产生金额字段。

- [x] **Step 2: 运行 RED**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-task-overview-test.ts`

  Expected: FAIL，因为服务与 repository 只读查询尚不存在。

- [x] **Step 3: 实现最小读模型与内存/MySQL 查询**

  Repository 查询必须显式接收 scope，并在 SQL `WHERE owner_id = ? AND team_id = ?` 中过滤。聚合服务只读取并 `structuredClone`，不得改变 Plan/Run。

- [x] **Step 4: 运行 GREEN 与后端构建**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-task-overview-test.ts && npm run build --workspace backend`

  Expected: PASS。

- [x] **Step 5: 提交**

  ```bash
  git add backend/src/acquisition-task-overview.ts backend/src/acquisition-task-overview-test.ts backend/src/acquisition-plan-run-repository.ts backend/src/acquisition-mysql-repositories.ts
  git commit -m "feat: aggregate acquisition tasks"
  ```

### Task 2: 真实 overview、任务列表和任务详情 API

**Files:**
- Create: `backend/src/acquisition-task-overview-router.ts`
- Create: `backend/src/acquisition-task-overview-router-test.ts`
- Modify: `backend/src/acquisition-application.ts`

**Interfaces:**
- Consumes: Task 1 `AcquisitionTaskOverviewService`、现有 `AcquisitionRunPresentationService` 和 Plan/Run scope/auth/error conventions。
- Produces:
  - `GET /api/v1/acquisition/overview?platform=douyin|web`
  - `GET /api/v1/acquisition/tasks?platform=douyin|web&limit=1..100`
  - `GET /api/v1/acquisition/tasks/:planId`
- 任务详情固定字段：`task`、`plan`、`latestRun`、`shards`、`presentation`；没有 Run 时后三项分别为 `null`、`[]`、`null`。

- [x] **Step 1: 先写挂载路由失败测试**

  用真实 Express router 和内存 repositories 断言 200 结构、无 Run、部分成功 Run、未知平台 400、跨租户 404、未登录 401，以及任务详情中的 presentation 候选来自权威服务。

- [x] **Step 2: 运行 RED**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-task-overview-router-test.ts`

  Expected: FAIL，因为路由尚不存在。

- [x] **Step 3: 实现路由并挂载应用**

  错误信封沿用现有 `{ error: { code, message, details, requestId } }`，所有响应 `Cache-Control: no-store`。不得新建写接口。

- [x] **Step 4: 运行 GREEN、专项测试与构建**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-task-overview-test.ts src/acquisition-task-overview-router-test.ts && npm run build --workspace backend`

  Expected: PASS。

- [x] **Step 5: 提交**

  ```bash
  git add backend/src/acquisition-task-overview-router.ts backend/src/acquisition-task-overview-router-test.ts backend/src/acquisition-application.ts
  git commit -m "feat: expose acquisition task overview"
  ```

### Task 3: 新版获客中心真实 ViewModel 与交互

**Files:**
- Create: `frontend/src/features/ai-growth/components/task-overview.ts`
- Create: `frontend/src/features/ai-growth/task-overview.test.ts`
- Modify: `frontend/src/features/ai-growth/api.ts`
- Modify: `frontend/src/features/ai-growth/types.ts`
- Modify: `frontend/src/features/ai-growth/controller.ts`
- Modify: `frontend/src/features/ai-growth/styles.css`

**Interfaces:**
- Consumes: Task 2 三个只读 API，以及现有 `continueRecent`/Run Presentation/Battle Card 流程。
- Produces: `TaskOverviewVm`、`renderTaskOverview()`；控制器首次进入真实模式时加载 overview 和抖音 task list；`新建获客任务` 切到既有自然语言输入；`打开任务` 加载任务详情并恢复 latest Run；`返回任务总览` 返回真实列表。
- URL hash 固定为 `#ai-growth`、`#ai-growth/new`、`#ai-growth/task/<encoded-planId>`。

- [x] **Step 1: 写 API、ViewModel、hash 与渲染失败测试**

  测试真实/空/失败/部分成功/无连接状态，断言正式数据不从 HTML `data-*` 读取；平台卡明确显示“抖音 · 公开搜索”，其他平台标记“待接入”；演示数据有独立标识。

- [x] **Step 2: 运行 RED**

  Run: `npm run test:unit --workspace frontend`

  Expected: FAIL，因为 overview API/组件/控制器状态尚不存在。

- [x] **Step 3: 实现真实页面**

  复用 `GoodJob-marketing-system-frontend` 的暖白背景、深色侧栏、平台卡片、指标卡、任务表格和时间线设计语言；禁止直接复制其 demo store。正式模式只渲染后端 ViewModel。

- [x] **Step 4: 运行 GREEN、前端测试与构建**

  Run: `npm run test --workspace frontend && npm run build --workspace frontend`

  Expected: PASS。

- [x] **Step 5: 提交**

  ```bash
  git add frontend/src/features/ai-growth/components/task-overview.ts frontend/src/features/ai-growth/task-overview.test.ts frontend/src/features/ai-growth/api.ts frontend/src/features/ai-growth/types.ts frontend/src/features/ai-growth/controller.ts frontend/src/features/ai-growth/styles.css
  git commit -m "feat: connect acquisition overview UI"
  ```

### Task 4: 真实任务总览 E2E、响应式与刷新保持

**Files:**
- Create: `frontend/tests/ai-acquisition-overview.spec.ts`
- Modify: `frontend/playwright.config.ts` only if the existing deterministic backend fixture cannot mount the new endpoints.
- Modify: `docs/product/ai-acquisition-agent.md`

**Interfaces:**
- Consumes: Tasks 1–3 的真实 API 与 UI。
- Produces: 登录 → 抖音任务列表 → 任务详情 → 候选/作战卡 → 刷新保留的浏览器级证明。

- [x] **Step 1: 先写 E2E 失败测试**

  Fixture 必须按 method + pathname 拦截，未声明的获客请求返回 501；记录所有写请求。测试 1440、1366、1024 宽度无横向溢出，Tab 可聚焦任务和返回按钮，刷新 `#ai-growth/task/<id>` 仍显示同一真实任务。

- [x] **Step 2: 运行 RED**

  Run: `npm run test:e2e --workspace frontend -- ai-acquisition-overview.spec.ts`

  Expected: FAIL，直到 hash 恢复、响应式或 fixture 完成。

- [x] **Step 3: 完成最小集成修正和运行文档**

  文档增加三个只读 API、任务身份、平台/Provider 区分以及演示模式零写请求说明。

- [x] **Step 4: 运行 GREEN 与完整验收**

  Run:

  ```bash
  npm run test:e2e --workspace frontend -- ai-acquisition-overview.spec.ts
  npm run test:acquisition --workspace backend
  npm test
  npm run build
  ```

  Expected: 全部 PASS；只允许既有 Vite chunk warning。

- [x] **Step 5: 提交**

  ```bash
  git add frontend/tests/ai-acquisition-overview.spec.ts frontend/playwright.config.ts docs/product/ai-acquisition-agent.md
  git commit -m "test: verify acquisition task overview"
  ```
