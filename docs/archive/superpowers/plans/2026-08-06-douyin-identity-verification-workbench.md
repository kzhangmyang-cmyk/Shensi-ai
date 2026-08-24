# 抖音主体核验工作台 Implementation Plan

> **For agentic workers:** Use test-driven development and independent review for every task.

**Goal:** 把抖音视频页、评论式摘要和短链形成的“主体待核实”候选，安全地补充为可验证的公开主体，并在人工确认后自动继续意向评分、财务价值判断和客户作战卡生成。

**Architecture:** 复用现有受控公开网页抓取、候选身份确认、Pi 业务工具和客户作战卡抽屉。后端补齐候选版本/身份状态、公开页面类型和抓取证据 ID 的正式契约；前端在候选作战抽屉内新增核验状态机。用户提交精确公开主页后，系统受控抓取并生成证据，人工确认主体关系，再通过现有 Copilot 工具顺序运行研究、资格与财务判断、作战卡，不新增自动触达能力。

**Tech Stack:** TypeScript、Express、Zod/JSON Schema/OpenAPI、React/Vite 现有 render/controller 架构、Node test runner、Playwright。

## Global Constraints

- 只允许 HTTPS 公开 URL；个人抖音主体必须是受支持的精确 `/user/...` 公开主页，视频页、短链和评论摘要不能直接确认为个人身份。
- 抓取不得绕过登录、验证码、访问控制或平台权限；访问受限必须如实失败。
- 身份确认必须携带候选当前版本、唯一幂等键、公开证据 ID 和人工核验说明；409/412/428 等冲突必须提示刷新，不能静默覆盖。
- 新证据、主体确认、资格判断、财务价值与作战卡都保留来源、审计和版本失效语义。
- 自动续跑只包含研究、评分、财务价值和作战卡；不自动评论、私信、加好友、群发、转 CRM 或触达。
- 不读取、修改、暂存或提交用户未跟踪文件 `docs/superpowers/plans/2026-07-23-ai-model-adapters-and-pi.md`。

---

### Task 1: 固化候选身份与公开主页证据契约

**Files:**
- Modify: `contracts/json-schema/organization-candidate.v1.schema.json`
- Modify: `contracts/json-schema/individual-demand-signal.v1.schema.json`
- Modify: `contracts/json-schema/discovery-evidence.v1.schema.json`
- Modify: `contracts/json-schema/content-fetch-operation.v1.schema.json`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `backend/src/acquisition-domain.ts`
- Modify: `backend/src/acquisition-public-search-port.ts`
- Modify: `backend/src/acquisition-tool-executor.ts`
- Modify: `backend/src/acquisition-discovery-operations.ts`
- Modify: `backend/src/acquisition-v1-router.ts`
- Modify/Create: focused contract/backend tests

- [x] Add explicit candidate `version` and `identityResolved` to public DTOs.
- [x] Preserve optional public `sourceType` in search-result evidence provenance.
- [x] Return exact evidence IDs from completed content-fetch operations.
- [x] Type content-fetch OpenAPI responses with the real operation schema and regenerate frontend types.
- [x] Prove old stored evidence/operations remain readable and all new fields are tenant-safe.

### Task 2: 前端主体核验 API 与可取消状态机

**Files:**
- Modify: `frontend/src/features/ai-growth/api.ts`
- Modify: `frontend/src/features/ai-growth/components/battle-card-drawer.ts`
- Modify/Create: focused API/controller tests

- [x] Add typed create/poll content-fetch and identity-confirmation calls with exact headers.
- [x] Implement `idle → fetching → ready_for_confirmation → confirming → researching → qualifying → building_card → completed|failed|conflict`.
- [x] Ignore stale completions after close/candidate switch; coalesce duplicate submits.
- [x] After identity confirmation, sequentially use controlled Copilot tools and refresh candidate/evidence/qualification/financial/card resources.

### Task 3: 候选作战抽屉内的主体核验工作台

**Files:**
- Modify: `frontend/src/features/ai-growth/components/candidate-list.ts`
- Modify: `frontend/src/features/ai-growth/components/battle-card-drawer.ts`
- Modify: `frontend/src/features/ai-growth/controller.ts`
- Modify: `frontend/src/features/ai-growth/styles.css`
- Modify/Create: focused rendering/accessibility tests

- [x] Candidate card must show unresolved identity honestly and expose “核验主体”.
- [x] Drawer shows original URL, page type, search Provider, evidence excerpt and why identity is blocked.
- [x] The Douyin individual path accepts only an exact public `/user/...` profile and requires a human rationale; organization identity keeps the existing organization resolver path.
- [x] Confirm only after controlled fetch succeeds and evidence URL matches the declared identity.
- [x] Show deterministic progress, access restrictions, stale-version conflicts and safe retry.
- [x] Preserve focus, Escape close, narrow-screen layout and existing task/candidate context.

### Task 4: 评论/视频到作战卡的完整 E2E 与文档

**Files:**
- Create: `frontend/tests/ai-acquisition-identity-verification.spec.ts`
- Modify: `docs/product/ai-acquisition-agent.md`

- [x] Prove: Douyin comment/video candidate → identity unresolved → exact `/user/...` fetch → evidence returned → versioned human confirmation → research/qualification/financial/card complete.
- [x] Prove video/short-link URL, access-restricted fetch, mismatched evidence and stale candidate version remain blocked.
- [x] Prove no comment/message/friend/group/outreach/CRM write occurs.
- [x] Run focused tests, frontend suite/build, acquisition backend/contracts/generated drift, E2E and `git diff --check`.

## Acceptance Outcome

真实抖音公开搜索产生的视频、评论式摘要或短链候选不会被冒充成已验证客户。销售可以在原作战抽屉里查看原始证据，补充精确公开主页并完成人工核验；系统确认版本和证据后自动完成 AI 研究、意向/财务判断与客户作战卡，最终仍停在人工审核门，不执行任何自动触达。
