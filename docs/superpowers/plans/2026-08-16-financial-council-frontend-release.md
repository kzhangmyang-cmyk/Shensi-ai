# 财务委员会前端、纵向验收与双仓发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在独立前端交付完整的委员会运行、冲突审计、三组合比较、修订审批和派发回执体验，并用真实后端/MySQL 纵向验收证明系统没有 mock、越权或自动执行。

**Architecture:** 前端只消费固定 Growth contract release，通过 `api/controller/view` 三层接入 `#financial-council`。Controller 维护 server projection、轮询 generation、编辑 revision、审批和对象生命周期；view 使用现有 Growth 深绿/暖白控制面样式展示密集财务事实。Playwright 先用 typed fixture 覆盖 UI 状态，再用 no-route-intercept real-backend spec 跑完整路径。

**Tech Stack:** TypeScript、Vite、现有 vanilla Growth runtime/router、Playwright、生成 OpenAPI 类型、现有 CSS design system。

## Global Constraints

- Backend repo: `/Users/mac/Documents/新项目/GoodJob-growth`。
- Frontend repo: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend`。
- 保留 frontend 用户已有 `pnpm-workspace.yaml` 与 `debug-agents.mts` 变更；不读取、修改、暂存或删除 package lock。
- 不增加 React 页面、UI 库、图表依赖或第二套路由；复用现有 `src/growth/router.ts`、runtime 和 CSS。
- 页面必须显示 server-projected 数据，不能在浏览器重算权威公式、硬约束、optimizer score 或 scenario total。
- 轮询只更新同一个 run/generation；旧请求迟到不能覆盖新 run、已批准状态或新 revision。
- 编辑成功前不展示新 totals；审批成功前不显示“已批准/已创建”。
- 浏览器不能发送 workspace/actor/capabilities、模型输出、server timestamps、action impacts 或 arbitrary tool names。
- 金额按 contract currency/minor 格式化；redacted/missing/not_computable 明确区分，不显示为 0。
- 敏感税务/成本内容不写 localStorage/sessionStorage/console/URL；运行 ID 可在 hash route 中，但快照/模型内容不可。
- 可访问性：原生 button/radio/checkbox、键盘操作、focus-visible、aria-live、颜色不是唯一状态信号。

---

### Task 1: 发布合同、导入生成类型并锁定 fixture

**Files (backend):**
- Modify: `contracts/openapi/growth-advisor-quote-roi.v1.yaml`
- Modify: `contracts/releases/growth-advisor-quote-roi/<new-version>/openapi.json`
- Modify: `contracts/releases/growth-advisor-quote-roi/<new-version>/manifest.json`
- Modify: `contracts/test/generated-types.test.mjs`

**Files (frontend):**
- Modify: `contracts/growth-advisor-quote-roi/openapi.json`
- Modify: `contracts/growth-advisor-quote-roi/manifest.json`
- Modify: `src/generated/growth-advisor-quote-roi.ts`
- Modify: `src/growth/contracts.ts`
- Modify: `tests/fixtures/growth-contract.ts`
- Modify: `tests/fixtures/growth-contract.self-test.ts`

**Interfaces:**
- Frontend aliases derive only from generated `components["schemas"]` and `paths`; no hand-written widened copy of council DTOs.
- Fixture includes runs at `analyzing`, `auditing`, `awaiting_approval`, `approved`, `not_computable`, one stale revision, one unresolved conflict, empty feasible portfolios, and partial dispatch.

- [ ] **Step 1: Write fixture RED before importing the release.**

```ts
test("financial council fixture conforms to the pinned release", () => {
  assertContract("FinancialCouncilRun", financialCouncilFixture.awaitingApproval);
  assert.deepEqual(financialCouncilFixture.awaitingApproval.portfolios
    .map((row) => row.kind), ["balanced", "cash_first", "growth_first"]);
});
```

- [ ] **Step 2: Prove RED in frontend.**

```bash
cd /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend
pnpm run test:growth:fixture
```

Expected: generated path/schema aliases are absent or pinned manifest differs.

- [ ] **Step 3: Publish backend release, import and regenerate frontend.**

```bash
cd /Users/mac/Documents/新项目/GoodJob-growth
npm run build:growth-contract-release
npm run check:growth-contracts

cd /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend
pnpm run contract:import
pnpm run contract:generate
pnpm run contract:check
pnpm run test:growth:fixture
```

- [ ] **Step 4: Verify no manual widening and commit separately in each repo.**

Backend:

```bash
git add contracts
git commit -m "feat(finance): publish financial council contract"
```

Frontend:

```bash
git add contracts/growth-advisor-quote-roi src/generated/growth-advisor-quote-roi.ts src/growth/contracts.ts tests/fixtures/growth-contract.ts tests/fixtures/growth-contract.self-test.ts
git commit -m "chore(growth): import financial council contract"
```

---

### Task 2: 实现 closed API client 与 controller 生命周期

**Files (frontend):**
- Create: `src/growth/council/api.ts`
- Create: `src/growth/council/api.self-test.ts`
- Create: `src/growth/council/controller.ts`
- Create: `src/growth/council/controller.self-test.ts`
- Modify: `src/self-test.ts`

**Interfaces:**
- API methods: `createRun/getRun/listEvents/getPolicy/updatePolicy/revisePortfolio/approve/reject/listDispatches`.
- Every response passes a closed runtime validator before controller state changes.
- Controller state is `{run,events,policy,selectedPortfolioKind,editDraft,busy,error,lastUpdatedAt}`.
- Polling generation is bound to exact run ID; terminal run stops polling. Reload may restore only run ID, not sensitive response bodies.

- [ ] **Step 1: Write API RED tests.**

Cover exact routes/headers, `If-Match`, same-key network retry, invalid success body, standard error body, 403/409/412, no caller workspace, no impacts in edit body and no approval before latest revision.

- [ ] **Step 2: Write controller RED tests.**

Cover old GET after replacement, analyzing→awaiting projection, edit pending/no false totals, edit failure/same key retry, approve pending/no false success, stale source conflict, approved terminal monotonicity, destroy/close cleanup and dispatch polling.

- [ ] **Step 3: Prove RED.**

```bash
cd /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend
pnpm exec tsx src/growth/council/api.self-test.ts
pnpm exec tsx src/growth/council/controller.self-test.ts
```

Expected: module-not-found failures.

- [ ] **Step 4: Implement API/controller and prove GREEN.**

Semantic idempotency key inputs:

```text
create: currency + dataAsOf + report hash + policyVersionId
revise: runId + baseRevision + canonical operations
approve: runId + latest portfolio revision + portfolio kind
reject: runId + current run revision
```

Failed requests retain their keys; successful lifecycle completion clears them.

- [ ] **Step 5: Run types/self-tests and commit.**

```bash
pnpm exec tsx src/growth/council/api.self-test.ts
pnpm exec tsx src/growth/council/controller.self-test.ts
pnpm run test:types
pnpm test
git diff --check
git add src/growth/council src/self-test.ts
git commit -m "feat(growth): control financial council runs"
```

---

### Task 3: 实现委员会工作台视图与路由集成

**Files (frontend):**
- Create: `src/growth/council/view.ts`
- Create: `src/growth/council/view.self-test.ts`
- Create: `src/growth/council/entry.ts`
- Modify: `src/growth/router.ts`
- Modify: `src/growth/router.self-test.ts`
- Modify: `src/growth/runtime.ts`
- Modify: `src/growth/entry.ts`
- Modify: `src/growth/styles.css`
- Modify: `README.md`

**Interfaces:**
- Route: `#financial-council` and optional `#financial-council/run/<encoded-id>`.
- Sections in fixed reading order:

```text
run summary/status/dataAsOf
five specialist cards
audit conflicts/rebuttal/minority views
CFO diagnosis/data gaps
three portfolio comparison
selected action details/rejected reasons/sensitivity
edit/reoptimization panel
approval panel
dispatch receipts
```

- Cash/compliance blockers are always visible above approval controls. Tax section always shows professional-review disclaimer.

- [ ] **Step 1: Write semantic view RED tests.**

Assert native controls, headings/order, three portfolio labels, no fake zero for missing data, blocker reasons, minority preservation, stale banner, disabled approval for infeasible/stale/unauthorized states, escape of CRM/model text and no raw JSON/chain-of-thought.

- [ ] **Step 2: Prove RED.**

```bash
pnpm exec tsx src/growth/council/view.self-test.ts
pnpm exec tsx src/growth/router.self-test.ts
```

- [ ] **Step 3: Implement dense responsive UI in the existing style namespace.**

Use CSS grid with one column below 760px, two columns for specialist/metric cards above 1024px, and no horizontal overflow at 768/1024/1440. Do not add decorative gradients, excessive rounded cards or animation.

- [ ] **Step 4: Wire events to controller.**

Use event delegation for portfolio radio, action removal/restore, owner/dueAt/duration edit, revise, approve and reject. Confirmation copy must state that approval creates drafts/todos only and does not execute financial actions.

- [ ] **Step 5: Run and commit.**

```bash
pnpm exec tsx src/growth/council/view.self-test.ts
pnpm exec tsx src/growth/router.self-test.ts
pnpm run test:types
pnpm test
pnpm build
git diff --check
git add src/growth/council src/growth/router* src/growth/runtime.ts src/growth/entry.ts src/growth/styles.css README.md
git commit -m "feat(growth): add financial council approval workbench"
```

---

### Task 4: Typed fixture Playwright 与安全/可访问性验收

**Files (frontend):**
- Create: `tests/growth-financial-council.spec.ts`
- Modify: `tests/fixtures/growth-contract.ts`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Add E2E RED cases.**

Cases:

1. create run from a valid report, observe all intermediate states, five experts and one rebuttal;
2. compare balanced/cash/growth portfolios and inspect rejected reasons;
3. remove a prerequisite action, receive a new revision and changed totals;
4. stale revision/source disables approval;
5. approve latest revision and observe only draft/todo receipts;
6. `not_computable` with cash/data blockers;
7. forbidden policy/approval roles;
8. 768/1024/1440 layout, keyboard-only edit/approve and live-region errors;
9. prompt-injection strings render as text and never mutate UI/tools;
10. external network, raw report secrets, model key, full tax text and chain-of-thought are absent from request log, console and storage.

- [ ] **Step 2: Prove RED against missing/incomplete UI.**

```bash
pnpm run test:e2e -- growth-financial-council.spec.ts --project=chromium
```

- [ ] **Step 3: Implement only fixture/harness support needed by the real production controller/view.**

Route handlers first reject every nonlocal origin, then handle exact local API paths. No test-only branch may enter production files.

- [ ] **Step 4: Run visual/accessibility verification.**

For each viewport assert `document.documentElement.scrollWidth === viewport width`, no console error/warn, focus order reaches all controls, and approval confirmation includes exact non-execution copy.

- [ ] **Step 5: Commit.**

```bash
pnpm run test:e2e -- growth-financial-council.spec.ts --project=chromium
pnpm run test:types
pnpm test
git diff --check
git add tests/growth-financial-council.spec.ts tests/fixtures/growth-contract.ts playwright.config.ts
git commit -m "test(growth): verify financial council workflow"
```

---

### Task 5: 真实后端/MySQL 纵向验收与最终发布

**Files (backend):**
- Create: `backend/src/financial-council-vertical-integration-test.ts`
- Create: `backend/src/financial-council-mysql-integration-test.ts`
- Modify: `backend/package.json`
- Modify: `backend/src/business-advisor/README.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-16-financial-multi-agent-council-design.md`
- Modify: `docs/superpowers/plans/2026-08-16-financial-multi-agent-council-implementation-index.md`

**Files (frontend):**
- Create: `tests/growth-financial-council-real.spec.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Backend vertical test uses a deterministic fake `FinancialCouncilModelPort` but real service/repository/formula/audit/optimizer/approval/dispatch composition; it is not an HTTP response mock.
- Real Playwright launches the actual backend and MySQL, uses a test-only authenticated workspace/model adapter fixture, performs no route interception, and asserts database-visible results through public APIs.

- [ ] **Step 1: Write the vertical RED test for the approved path.**

Path:

```text
report + CRM + quote + verified finance + ROI
-> one frozen snapshot
-> five durable specialist results
-> formula/evidence conflict + one rebuttal
-> consensus preserving minority
-> three exact portfolios
-> edit removes one action and creates revision 2
-> approve revision 2
-> exact draft/todo receipts, no authority-side financial mutation
```

- [ ] **Step 2: Prove RED, then implement fixtures/composition until GREEN.**

```bash
cd /Users/mac/Documents/新项目/GoodJob-growth
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-vertical-integration-test.ts \
  src/financial-council-mysql-integration-test.ts
```

- [ ] **Step 3: Run real no-intercept browser E2E.**

```bash
cd /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" \
GOODJOB_BACKEND_ROOT=/Users/mac/Documents/新项目/GoodJob-growth \
pnpm run test:e2e -- growth-financial-council-real.spec.ts --project=chromium
```

- [ ] **Step 4: Run complete final gates fresh.**

Backend:

```bash
cd /Users/mac/Documents/新项目/GoodJob-growth
npm run test:business-advisor --workspace backend
npm run test:financial-council --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:financial-council:mysql --workspace backend
npm run test:growth-advisor --workspace backend
npm run test:growth-finance:mysql --workspace backend
npm run test:growth-quotes --workspace backend
npm run test:contracts
npm run check:growth-contracts
npm run build
git diff --check
```

Frontend:

```bash
cd /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend
pnpm run contract:check
pnpm run test:growth:fixture
pnpm run test:types
pnpm test
pnpm run test:e2e -- growth-financial-council.spec.ts --project=chromium
pnpm build
git diff --check
```

- [ ] **Step 5: Request independent cross-repository review.**

Review checks contract drift, real data path, no route interception, one-cutoff snapshot, five results/one rebuttal, optimizer oracle, revision/stale fencing, approval capability, exact-once draft dispatch, secret/log/storage privacy, accessibility and user-owned file preservation.

- [ ] **Step 6: Fix all Critical/Important findings with focused RED → GREEN and rerun affected full gates.**

- [ ] **Step 7: Update current docs to completed truth and make separate final commits.**

Backend:

```bash
git add backend/src/financial-council-vertical-integration-test.ts backend/src/financial-council-mysql-integration-test.ts backend/package.json backend/src/business-advisor/README.md README.md docs/superpowers/specs/2026-08-16-financial-multi-agent-council-design.md docs/superpowers/plans/2026-08-16-financial-multi-agent-council-implementation-index.md
git commit -m "docs(finance): complete financial council verification"
```

Frontend:

```bash
git add tests/growth-financial-council-real.spec.ts package.json README.md
git commit -m "test(growth): verify financial council end to end"
```

Record both final commit hashes, contract version/hash, live-MySQL status and reviewer conclusion. Do not mark complete when the real MySQL or real browser requirement was skipped in the release environment.
