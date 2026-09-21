# 抖音平台化公开商机发现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task with RED → GREEN tests and an independent review after every task.

**Goal:** 在现有通用公开搜索、候选研究、意向/财务评分和客户作战卡链路上，补齐明确的抖音目标平台、确定性站点查询、安全来源分类和可见的平台选择，让“抖音获客智能体”能真实执行公开商机发现，而不是仅靠任务名称推断平台。

**Architecture:** 保留现有 Acquisition Plan/Run/Shard 和自动候选处理流水线。新增轻量的 `targetPlatform` 领域字段，以及两个确定性 skill-like 模块：抖音查询编译器负责把语义意图约束到允许的抖音公开站点；抖音来源分类器负责区分内容平台、搜索 Provider 和公开页面类型。大模型负责生成语义搜索意图，工作流负责审批、预算、执行、证据留痕与作战卡，规则模块负责边界和可靠性。

**Tech Stack:** TypeScript、Node.js/Express、Zod、React/Vite、OpenAPI generated types、Node test runner、Playwright。

## Global Constraints

- 只使用搜索引擎或用户导入的公开可访问资料；不得声称扫描抖音全站或全部评论。
- 不新增自动评论、自动私信、自动加好友、自动群发、账号养号或规避平台检测。
- `targetPlatform` 只允许 `douyin | web`；旧数据没有该字段时保持兼容并使用既有查询推断作为只读回退。
- 抖音目标计划的搜索查询必须由确定性编译器生成，只允许精确根域 `douyin.com`、`iesdouyin.com`；任何模型/用户提供的 `site:` 约束都先移除。
- 百度、腾讯、Tavily、Serper、Brave、SerpApi 是搜索 Provider，不得再当成内容来源平台。
- 搜索索引中的“评论式摘要”只能作为待研究信号，不得凭摘要创建已验证的评论用户身份。
- 计划审批和运行必须再次执行 readiness 校验，直接创建/更新 Plan 不能绕过抖音查询约束。
- 每条证据保留搜索 Provider、最终 URL、内容平台/页面类型、检索查询和访问状态。
- 自动测试使用确定性 fixture，不访问真实抖音或搜索 API。
- 不读取、修改、暂存或提交用户未跟踪文件 `docs/superpowers/plans/2026-07-23-ai-model-adapters-and-pi.md`。

---

### Task 1: 显式目标平台贯穿 Plan、Copilot 与任务总览

**Files:**
- Modify: `backend/src/acquisition-plan-run-repository.ts`
- Modify: `backend/src/acquisition-plan-contract.ts`
- Modify: `backend/src/acquisition-v1-router.ts`
- Modify: `backend/src/acquisition-copilot-service.ts`
- Modify: `backend/src/acquisition-copilot-runner.ts`
- Modify: `backend/src/acquisition-plan-draft.ts`
- Modify: `backend/src/acquisition-task-overview.ts`
- Modify: corresponding backend tests and `backend/src/acquisition-openapi.ts`
- Regenerate: `frontend/src/features/ai-growth/generated/ai-acquisition.ts`

**Interfaces:**
- New type: `AcquisitionTargetPlatform = "douyin" | "web"`.
- `AcquisitionPlanPayload.targetPlatform?: AcquisitionTargetPlatform` remains optional for persisted legacy plans; every newly generated plan writes it explicitly.
- `POST /api/v1/acquisition/copilot/sessions/:id/messages` accepts optional `targetPlatform`; omission preserves legacy `web` behavior.
- Copilot idempotency includes target platform.
- Task overview prefers explicit `plan.payload.targetPlatform`, then falls back to legacy query inference.

- [x] **Step 1: write failing contract/service/router tests** for schema validation, Copilot persistence and replay, runner propagation, generator defaulting, overview precedence, and legacy payload compatibility.
- [x] **Step 2: run RED** with the focused plan/Copilot/overview test files.
- [x] **Step 3: implement the smallest end-to-end field propagation**, update OpenAPI, and regenerate frontend contract types using repository scripts.
- [x] **Step 4: run GREEN**, contract checks, backend build, and generated-type drift check.
- [x] **Step 5: commit** as `feat: add acquisition target platform`.

### Task 2: 确定性抖音查询编译器与审批边界

**Files:**
- Create: `backend/src/acquisition-douyin-discovery-plan.ts`
- Create: `backend/src/acquisition-douyin-discovery-plan-test.ts`
- Modify: `backend/src/acquisition-plan-draft.ts`
- Modify: `backend/src/acquisition-plan-readiness.ts`
- Modify: corresponding plan draft/readiness/service tests

**Interfaces:**
- `compileDiscoveryQueries(targetPlatform, semanticQueries)` returns normalized, deduplicated, execution-ready queries.
- Douyin compilation creates exact `site:douyin.com ` and `site:iesdouyin.com ` variants for every semantic intent.
- NFKC normalization removes any supplied `site:` expression (including full-width colon), collapses whitespace, enforces non-empty query and maximum tool length 1000.
- Operation count and budget allocation use compiled operations, not pre-compilation model intents.
- `planReadinessIssues` rejects every Douyin plan containing an unbound or lookalike-domain search query.

- [x] **Step 1: write failing security/behavior tests** for malicious site injection, Unicode variants, dedupe, length, allowed prefixes, operation/budget counts, and approval/run bypass attempts.
- [x] **Step 2: run RED**.
- [x] **Step 3: implement compiler and wire it before operation/budget calculation plus readiness enforcement**.
- [x] **Step 4: run GREEN**, focused acquisition plan suites and backend build.
- [x] **Step 5: commit** as `feat: compile safe douyin discovery queries`.

### Task 3: 抖音公开来源分类与 Provider/内容来源分离

**Files:**
- Create: `backend/src/acquisition-douyin-public-source.ts`
- Create: `backend/src/acquisition-douyin-public-source-test.ts`
- Modify: `backend/src/acquisition-tool-executor.ts`
- Modify: `backend/src/acquisition-public-search-port.ts`
- Modify: `backend/src/acquisition-candidate-research.ts`
- Modify: corresponding executor/search/research/identity tests

**Interfaces:**
- `DouyinPublicSourceType = "profile" | "video" | "comment_signal" | "short_link" | "other"`.
- `classifyDouyinPublicSource(url, title?, snippet?)` uses exact host/subdomain checks and rejects lookalikes.
- `SearchPublicSourceResult` carries content `sourcePlatform` and `sourceType`; provider remains only in response/provenance provider fields.
- Douyin-bound searches drop off-platform result URLs.
- Only stable `/user/` profile URLs may enter verified public identity resolution; videos, short links, and comment-like indexed snippets remain `needs_research` evidence.

- [x] **Step 1: write failing classifier and pipeline tests** for profile/video/short URL/comment-signal/lookalike/off-platform/provider separation and identity safety.
- [x] **Step 2: run RED**.
- [x] **Step 3: implement classification/filtering and update both evidence construction paths** without breaking legacy providers.
- [x] **Step 4: run GREEN**, focused executor/search/research suites and backend build.
- [x] **Step 5: commit** as `feat: classify douyin public sources`.

### Task 4: 前端平台选择与显式抖音计划体验

**Files:**
- Modify: `frontend/src/features/ai-growth/types.ts`
- Modify: `frontend/src/features/ai-growth/api.ts`
- Modify: `frontend/src/features/ai-growth/controller.ts`
- Modify: `frontend/src/features/ai-growth/components/task-input.ts`
- Modify: `frontend/src/features/ai-growth/styles.css`
- Modify/Create: focused frontend tests

**Interfaces:**
- `AdvisorState.targetPlatform` defaults to `douyin` in the AI growth task flow.
- Task input exposes selectable `抖音公开商机` and `全网公开网页`; 快手、微信公众号、微博、小红书 are visible as `待接入` and cannot be selected.
- `requestPlanDraft` sends explicit `targetPlatform`.
- Draft review and task details visibly distinguish target platform from search Provider and state the public-index boundary.
- Existing task overview continues to load explicit `platform=douyin` without demo metrics or formal writes.

- [x] **Step 1: write failing API/controller/render/accessibility tests** for default Douyin, web switch, disabled future channels, request payload, draft display and keyboard selection.
- [x] **Step 2: run RED**.
- [x] **Step 3: implement the platform selector and explicit payload**, preserving current responsive design and hash routes.
- [x] **Step 4: run GREEN**, frontend tests and production build.
- [x] **Step 5: commit** as `feat: select acquisition target platform`.

### Task 5: 抖音公开商机完整链路 E2E 与产品文档

**Files:**
- Create: `frontend/tests/ai-douyin-platform-discovery.spec.ts`
- Modify: deterministic Playwright fixture only as required
- Modify: `docs/product/ai-acquisition-agent.md`

**Interfaces:**
- Proves: select Douyin → submit intent → receive explicit Douyin plan → approve → compiled allowed-site queries → run → Douyin-classified evidence/candidate → S/A battle card or honest no-candidate state → refresh task detail.
- Fixture rejects undeclared acquisition traffic and records formal writes.

- [x] **Step 1: write failing end-to-end test** asserting exact targetPlatform payload, allowed query prefixes, provider/content-source separation, public-index disclosure, and no unsafe outreach writes.
- [x] **Step 2: run RED and make only minimal integration corrections**.
- [x] **Step 3: update product documentation** with capability, evidence, limitations, and workflow/skill architecture.
- [x] **Step 4: run full GREEN**: target E2E, acquisition backend suite, root tests, production build, generated contract drift and `git diff --check`.
- [x] **Step 5: commit** as `test: verify douyin platform discovery`.

## Acceptance Outcome

完成后，用户可以在 AI 增长参谋里明确选择“抖音公开商机”，让模型只负责提出获客语义意图，系统自动编译为安全的抖音限定查询，经人工审批后使用客户配置的真实搜索 Provider 执行；所有结果能区分搜索 Provider 与抖音内容来源，并进入现有的研究、评分、财务价值、作战卡和 CRM 流程。未来接入快手、公众号、微博和小红书时复用同一平台适配接口，而不是复制整套智能体。
