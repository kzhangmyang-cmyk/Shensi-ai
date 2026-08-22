# AI 获客真实闭环修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不新增产品功能和无意义抽象的前提下，让新前端真实完成“获客交接 → 创建绑定商机 → 报价/成交回流 → 上海时区经营简报”。

**Architecture:** 继续使用现有 `AcquisitionCustomerHandoff` 作为获客归因真源。客户读模型只暴露可绑定且已验证归因的未绑定交接；Deal 创建显式提交选中的 binding；后端保持 binding 和 DealEvent 快照不可变。日期契约统一为 `YYYY-MM-DD`，仅在后端边界转换为 Asia/Shanghai 的闭区间时间戳。

**Tech Stack:** TypeScript、Express、Zod、Vite、Playwright、Node test、自有 MySQL/In-memory repositories。

## Global Constraints

- 不开发用户尚未确认的第 4 项功能。
- 不新增通用框架、万能 service、空接口、占位类型或未被真实路径调用的代码。
- 优先修改现有责任文件；只有前后端共同复用且可消除日期契约漂移时，才允许新增一个单一职责纯函数文件。
- 所有行为变更必须先有会因当前缺陷而失败的测试，再写最小实现。
- 获客归因只能来自服务端已验证的 Handoff；客户端不能制造或修改候选、Run、Event、金额或评分事实。
- 已绑定 Deal 的获客来源不可被编辑操作改写；历史缺少可信归因的数据必须 fail closed。
- 保留用户现有未提交文件：新前端 `pnpm-workspace.yaml`；后端旧 `frontend/src/features/ai-growth/**` 与未跟踪计划文档。

---

### Task 1: 真实 UI 创建获客绑定 Deal

**Files:**
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/server.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/types.ts`（仅当 Deal/Customer DTO 需要现有类型字段）
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-deal-closed-loop-integration-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/prototype-api.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/detail-center-controller.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/detail-center-controller.self-test.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/demo-auth.spec.ts`

**Interfaces:**
- Customer read model produces `acquisitionBindings: Array<{ handoffId; leadId; candidateId; createdAt }>`，只含 `dealId` 为空、Lead 未绑定 Deal、且 Handoff 有可信 `acquisitionAttribution` 的记录。
- Deal `POST /api/deals` consumes the selected `{ handoffId, leadId }` in existing `acquisitionBinding`.
- Handoff completion event produces `customerId`, `todoId`, `leadId`, `handoffId`; product UI refreshes the authoritative customer read model.

- [ ] **Step 1: Write failing backend tests** proving the customer read model returns only valid pending bindings, rejects missing-attribution bindings, and the real HTTP flow creates exactly one bound Deal.
- [ ] **Step 2: Run the focused backend tests and verify RED** because customers currently expose no binding and UI-path fixtures must hand-build it.
- [ ] **Step 3: Write failing frontend tests** proving handoff completion broadcasts all four CRM IDs, customer selection exposes a pending Handoff choice, and Deal POST includes the selected binding while ordinary/edited Deals do not.
- [ ] **Step 4: Run frontend self-test/E2E targets and verify RED** on the absent event fields and absent Deal request binding.
- [ ] **Step 5: Implement the minimal read-model and form wiring** in existing files; do not add a second client store or persist bindings in localStorage.
- [ ] **Step 6: Make bound Deal attribution immutable**: reject changing the customer of a bound Deal, and make new DealEvents snapshot the original Handoff/Lead/owner/team/customer by `handoff.dealId`, not mutable Deal fields.
- [ ] **Step 7: Run focused tests and builds, then commit** one backend and one frontend commit scoped to Task 1.

### Task 2: 固定交接事件并安全升级历史 Handoff

**Files:**
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/detail-center-controller.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/detail-center-controller.self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-private-domain-handoff.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/server.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-private-domain-handoff-test.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-deal-closed-loop-integration-test.ts`

**Interfaces:**
- Dialog state is the sole client source for the reviewed `runId` and `discoveredEventId` between open and submit.
- A legacy operation may be upgraded only when its legacy normalized request/hash matches and the new exact Run/Event chain resolves.
- A completed legacy Handoff may be upgraded only through its durable operation/request and exact resolver; otherwise it remains unbindable.
- LeadSourceEvent snapshot must contain the same upgraded `acquisitionAttribution` as operation and Handoff.

- [ ] **Step 1: Write failing frontend tests** for “display pin A, background refresh to B, submit still A”, legacy in-flight request missing pins, and completed Handoff missing pins.
- [ ] **Step 2: Verify frontend RED**, then minimally make open/submit use dialog pins and reconstruct legacy fields from the existing operation/status DTO without inventing values.
- [ ] **Step 3: Write failing backend tests** showing legacy in-flight and completed upgrades rewrite the existing LeadSourceEvent payload, while a completed Handoff without a trustworthy operation fails closed and cannot bind a Deal.
- [ ] **Step 4: Verify backend RED**, then update operation, Handoff, and existing snapshot event in one persisted mutation with rollback.
- [ ] **Step 5: Run focused tests and builds, then commit** one backend and one frontend commit scoped to Task 2.

### Task 3: 统一上海日期契约并修正平台统计顺序

**Files:**
- Create: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-performance-window.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-performance-router.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-pi-tools.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-tool-executor.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-performance-query.ts`
- Test: corresponding existing `*-test.ts` files for router, Pi tools, executor, and performance query
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/performance-controller.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/performance-controller.self-test.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/performance-api.self-test.ts`

**Interfaces:**
- Browser and Pi tool both consume `{ from: YYYY-MM-DD, to: YYYY-MM-DD }`.
- `normalizeShanghaiPerformanceWindow()` validates real dates, ordering, maximum 90 calendar days, and produces inclusive UTC instants for Shanghai days.
- Performance query resolves platform before applying the `runs` output cap.

- [ ] **Step 1: Write failing backend tests** for date-only Pi calls, Shanghai day boundaries, invalid dates, and 100 newer web Runs not starving one older douyin Run when `platform=douyin`.
- [ ] **Step 2: Verify backend RED**, then extract only the shared date-window validator/normalizer and reuse it from router and tool executor.
- [ ] **Step 3: Write failing frontend tests** for Shanghai 00:00–07:59 default day and invalid calendar dates returning a validation error rather than `RangeError`.
- [ ] **Step 4: Verify frontend RED**, then implement deterministic Asia/Shanghai calendar formatting without changing dashboard semantics.
- [ ] **Step 5: Run focused tests and builds, then commit** one backend and one frontend commit scoped to Task 3.

### Task 4: 新前端连接最新后端并做真实链路验收

**Files:**
- No production file is required unless verification reveals an actual configuration defect.
- Test/update only existing E2E fixtures when they fail to exercise the real network boundary.

**Interfaces:**
- Start latest `GoodJob-1.09` backend on a free local port.
- Start the new frontend with `VITE_API_TARGET` pointing to that exact port; do not kill or overwrite the user’s old 4188 service.

- [ ] **Step 1: Start both processes with explicit ports and verify `/api/health` through the 5189 proxy reaches the latest backend.**
- [ ] **Step 2: Exercise login and the real chain**: approved candidate → Handoff → customer binding choice → Deal → quote/won → reconciliation → performance.
- [ ] **Step 3: Run complete frontend and backend verification suites**, generated types, contracts, OpenAPI, security, Pi, builds, E2E, and `git diff --check`.
- [ ] **Step 4: Perform one broad read-only code review** focused on real user-path wiring, attribution immutability, legacy fail-closed behavior, and YAGNI.

