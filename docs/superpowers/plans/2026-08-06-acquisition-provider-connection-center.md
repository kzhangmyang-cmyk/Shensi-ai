# 获客搜索来源连接中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task with RED → GREEN tests and an independent review after every task.

**Goal:** 让首次使用 AI 获客的客户能在当前工作区内完成“查看官方搜索来源 → 填写自己的 API Key → 保存 → 真实测试 → 启用 → 继续生成抖音获客方案”的完整闭环，不再跳转到无关的通用设置页。

**Architecture:** 复用现有 Provider Catalog 和 Provider Connection 后端契约，不新增另一套数据源模型。前端新增一个受控的连接中心状态机和可访问抽屉；API Key 只存在于用户当前输入和写请求中，服务端返回的始终是安全投影。连接测试、启停、轮换和删除均调用正式 Acquisition API；保存成功后刷新连接目录，并保留用户原有任务文本、目标平台和模板选择。

**Tech Stack:** TypeScript、React/Vite、现有 HTML render/controller 架构、OpenAPI generated types、Node test runner、Playwright。

## Global Constraints

- 只允许配置后端 Provider Catalog 返回且可写的官方搜索 Provider；不得硬编码或伪造“已连接”。
- API Key 永不回显、永不写入 DOM、URL、localStorage、toast、错误文本、console 或测试快照；关闭表单后清空明文。
- 默认不展示自定义 Base URL；如保留高级入口，只允许依赖后端白名单校验，并明确修改 Base URL 必须同时重新提交 Key。
- `POST` 创建必须带 `Idempotency-Key`；`PATCH`、`DELETE` 和连接测试不得虚构 ETag、If-Match 或幂等头。
- 连接测试返回 HTTP 200 但 `ok:false` 时必须展示失败状态，不能按成功处理；422/429/503 等错误走现有统一错误处理。
- 仅健康状态 `passed` 且状态 `active` 的 search 连接能解除方案生成阻塞。
- 删除、禁用和轮换密钥必须二次确认；系统托管只读来源不可修改或删除。
- 不新增自动评论、自动私信、自动加好友、自动群发或绕过平台风控的行为。
- 自动测试不得访问真实搜索 API，也不得包含真实密钥。
- 不读取、修改、暂存或提交用户未跟踪文件 `docs/superpowers/plans/2026-07-23-ai-model-adapters-and-pi.md`。

---

### Task 1: 补齐 Provider Catalog 与连接生命周期前端 API

**Files:**
- Modify: `frontend/src/features/ai-growth/api.ts`
- Modify: `frontend/src/features/ai-growth/controller.test.ts` or create focused API test

**Interfaces:**
- `listProviders()` → `GET /api/v1/acquisition/providers`。
- `createProviderConnection(input, idempotencyKey)` → `POST /api/v1/acquisition/provider-connections`。
- `updateProviderConnection(id, input)` → `PATCH /api/v1/acquisition/provider-connections/:id`。
- `deleteProviderConnection(id)` → `DELETE /api/v1/acquisition/provider-connections/:id`。
- `testProviderConnection(id)` → `POST /api/v1/acquisition/provider-connections/:id/test`。
- 所有 DTO 均从生成的 OpenAPI 类型推导，不手写漂移结构。

- [x] **Step 1: write failing request-contract tests** for exact method/path/body/header semantics and success/failure health payloads.
- [x] **Step 2: run RED**.
- [x] **Step 3: implement the smallest typed API methods** using existing request helpers and error mapping.
- [x] **Step 4: run GREEN**, frontend typecheck/tests and `git diff --check`.
- [x] **Step 5: commit** as `feat: connect acquisition provider lifecycle api`.

### Task 2: 连接中心状态机与密钥安全边界

**Files:**
- Modify: `frontend/src/features/ai-growth/controller.ts`
- Modify: `frontend/src/features/ai-growth/types.ts`
- Modify: focused controller tests

**Interfaces:**
- Controller exposes open/close/select/edit/save/test/toggle/delete actions through an explicit connection-center state.
- Opening loads catalog and connections concurrently; stale responses are ignored after close/reopen.
- Save creates or rotates a connection, immediately clears plaintext Key, refreshes the safe connection projection, and offers a test action.
- Test maps `ok`, health/error code and retryability honestly; active+passed refresh allows the preserved acquisition task to continue.
- Close/reopen and every connection mutation preserve `taskText`, `targetPlatform`, `templateId`, and current workflow route.

- [x] **Step 1: write failing controller tests** for zero-connection setup, stale responses, secret clearing, save/test/enable/disable/delete, task preservation and error recovery.
- [x] **Step 2: run RED**.
- [x] **Step 3: implement the state machine and mutations** without persisting plaintext credentials.
- [x] **Step 4: run GREEN** and focused controller tests.
- [x] **Step 5: commit** as `feat: manage acquisition provider connections`.

### Task 3: 工作区内可访问的搜索来源抽屉

**Files:**
- Create: `frontend/src/features/ai-growth/components/provider-connection-center.ts`
- Modify: `frontend/src/features/ai-growth/controller.ts`
- Modify: `frontend/src/features/ai-growth/styles.css`
- Modify/Create: focused rendering/accessibility tests

**Interfaces:**
- “配置搜索来源”在当前获客工作区打开抽屉，不再导航到通用设置。
- 展示百度 AI 搜索、腾讯联网搜索、Tavily、Serper、Brave、SerpApi 的官方名称、能力、健康状态和官方文档链接；实际内容以 catalog 为准。
- 新建表单只有 Provider、API Key 和明确的保存/取消；密钥输入支持显示/隐藏，但任何渲染结果不得包含其值。
- 已连接项支持测试、启停、轮换 Key 和删除；危险动作有确认，系统来源为只读。
- 抽屉具备对话框语义、标题关联、焦点管理、Escape 关闭、键盘操作和窄屏布局。

- [x] **Step 1: write failing component/integration tests** for catalog rendering, safe secret handling, actions, status/error states and accessibility.
- [x] **Step 2: run RED**.
- [x] **Step 3: implement the drawer and wire all controller callbacks**.
- [x] **Step 4: run GREEN**, frontend suite and production build.
- [x] **Step 5: commit** as `feat: add acquisition connection center`.

### Task 4: 首次配置到抖音方案的完整 E2E 与文档

**Files:**
- Create: `frontend/tests/ai-acquisition-provider-connection.spec.ts`
- Modify: deterministic Playwright fixture only as required
- Modify: `docs/product/ai-acquisition-agent.md`

**Interfaces:**
- Proves: no healthy connection → connection-required → open drawer → choose official Provider → enter fixture Key → create → test passed → drawer closes → preserved Douyin task submits → plan contains targetPlatform `douyin`.
- Also proves test `ok:false`, disabled connection and delete/rotate paths are honest and do not leak the fixture Key into DOM, URL, storage or console.
- Fixture rejects undeclared network traffic and records formal API writes.

- [x] **Step 1: write failing deterministic E2E** for the full zero-to-plan path and secret non-disclosure.
- [x] **Step 2: run RED and make only minimal integration corrections**.
- [x] **Step 3: update product documentation** with supported providers, setup flow, security model and limitations.
- [x] **Step 4: run full GREEN**: target E2E, frontend suite, acquisition backend suite, root tests, production build, generated contract drift and `git diff --check`.
- [x] **Step 5: commit** as `test: verify acquisition provider connection flow`.

## Acceptance Outcome

完成后，一个没有任何连接的新客户无需离开 AI 获客页面，即可用自己的百度、腾讯或国际搜索服务官方 Key 建立真实搜索来源。系统会安全保存并测试连接，只有实际健康且启用的来源才能启动抖音公开商机方案；整个过程保留用户输入，并且页面、日志和持久化前端状态中都不会出现明文 Key。
