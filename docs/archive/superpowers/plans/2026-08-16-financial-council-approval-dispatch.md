# 财务委员会人工修订、批准与受控草案派发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让审批人安全地选择、删除或修改动作，并保证每次编辑都生成新 revision、完整重优化、重新校验数据与权限；批准后只创建受控草案、待办或后续审批任务。

**Architecture:** `FinancialPortfolioRevisionService` 接受闭合 edit operations，将其应用到最初的 validated candidate set 后重新运行服务端 action projector、约束引擎和 optimizer。`FinancialCouncilApprovalService` 在同一事务内锁定 run/latest revision、复核 snapshot sources/policy/capabilities 并追加 approval + dispatch outbox。`FinancialCouncilDispatchWorker` 使用 lease token/fencing/idempotency，把动作映射到 council draft 或现有 Advisor allowlisted action，不直接写权威财务/报价/CRM 表。

**Tech Stack:** TypeScript、Express、MySQL 8、现有 Growth command/idempotency/precondition、AdvisorRecommendation/AdvisorActionDispatcher、Node test runner。

## Global Constraints

- 依赖 P3 完成且 revision 1 的三套组合已持久。
- 编辑 API 不接受新的任意 action kind、任意金额、任意 capability、任意 source ref 或任意 tool name。
- 允许操作固定为 `select_portfolio|remove_action|replace_action_parameters|restore_action`；replacement 参数仅限每种 action 的闭合非财务字段，例如 owner、dueAt、durationDays，金额影响仍由服务端重算。
- 每个新 revision 重新执行 action projection、依赖闭包、全部硬约束、三个优化模式和敏感性分析；不得复制旧 totals/scores。
- `If-Match` 必须命中 run 当前 revision；approval 还必须命中 latest portfolio revision。
- 审批前重新读取 source heads/versions 和当前 capabilities。任何关键源变化使 run `stale` 并拒绝批准；用户必须新建 run。
- 批准能力固定为 `finance.council.approve`；策略修改是 `finance.council.policy.manage`；普通分析是 `finance.council.run`。
- approval 事务只写 council approval/outbox。外部草案/待办由 worker 完成，失败可恢复，批准结果不回滚或重复。
- 派发绝不执行付款、收款、记账、核销、报价批准/发布、合同、发票、税申报或外联。

---

### Task 1: 实现不可变 portfolio revision 与完整重优化

**Files:**
- Create: `backend/src/financial-portfolio-revision.ts`
- Create: `backend/src/financial-portfolio-revision-test.ts`
- Modify: `backend/src/financial-council-repository.ts`
- Modify: `backend/src/financial-council-repository-contract-test.ts`
- Modify: `backend/src/financial-council-mysql-repository.ts`
- Modify: `backend/src/financial-council-mysql-repository-test.ts`
- Modify: `backend/src/financial-council-service.ts`
- Modify: `backend/src/financial-council-service-test.ts`

**Interfaces:**
- `revisePortfolio(command,{runId,baseRevision,operations})` returns a new immutable revision and three recomputed portfolios.
- Edit operations reference existing `actionId`; replacement does not change `sourceFindingIds`, formula basis, evidence refs or hard-constraint flags.
- Repository unique key `(run_id,revision)` and idempotency request hash provide exact replay; failed optimization leaves no partial revision.

- [ ] **Step 1: Write stale and no-old-score RED tests.**

```ts
test("removing a prerequisite creates a new recomputed revision", async () => {
  const revised = await service.revisePortfolio(command({ expectedRevision: 7 }), {
    runId: "run-1", baseRevision: 1,
    operations: [{ kind: "remove_action", actionId: "cash-plan" }]
  });
  assert.equal(revised.revision, 2);
  assert.equal(revised.portfolios[0].selectedActionIds.includes("dependent"), false);
  assert.notEqual(revised.portfolios[0].score, original.portfolios[0].score);
});
```

Add changed-impact injection, unknown action, duplicate op, stale base revision, concurrent edit winner, exact replay, removed action still counted, no feasible result, unsafe dueAt and rollback on repository failure.

- [ ] **Step 2: Prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-portfolio-revision-test.ts \
  src/financial-council-service-test.ts
```

- [ ] **Step 3: Implement pure edit application and mandatory optimizer call.**

There is no `copyPortfolioTotals` path. The only constructor for a revision result accepts fresh `optimizeFinancialActions(...)` output.

- [ ] **Step 4: Add memory/MySQL atomic parity and commit.**

```bash
npm run test:financial-council --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:financial-council:mysql --workspace backend
npm run build --workspace backend
git diff --check
git add backend/src/financial-portfolio-revision* backend/src/financial-council-repository* backend/src/financial-council-mysql-repository* backend/src/financial-council-service*
git commit -m "feat(finance): reoptimize edited council portfolios"
```

---

### Task 2: 实现 stale source/capability 复核与审批状态机

**Files:**
- Create: `backend/src/financial-council-approval.ts`
- Create: `backend/src/financial-council-approval-test.ts`
- Create: `backend/src/financial-council-source-verifier.ts`
- Create: `backend/src/financial-council-source-verifier-test.ts`
- Modify: `backend/src/financial-council-repository.ts`
- Modify: `backend/src/financial-council-repository-contract-test.ts`
- Modify: `backend/src/financial-council-mysql-repository.ts`
- Modify: `backend/src/financial-council-mysql-repository-test.ts`
- Modify: `backend/src/financial-council-service.ts`
- Modify: `backend/src/financial-council-service-test.ts`

**Interfaces:**
- `verifyCurrentSources(context,snapshot)` compares every critical source head/version/hash and workspace binding; it does not compare volatile read order or display text.
- `approve(command,{runId,portfolioRevision,portfolioKind})` requires latest run revision, latest portfolio revision, nonempty feasible selected set and current approval capability.
- Approval record freezes approver, selected action IDs, portfolio/result hash, snapshot/policy hashes, approvedAt and idempotency key hash.
- `reject` is terminal and creates no outbox.

- [ ] **Step 1: Write approval RED tests.**

Cover changed verified fact, new quote revision, changed ROI closure, changed workspace binding, removed capability, stale portfolio, empty infeasible portfolio, duplicate exact approval, changed kind replay, concurrent approve/reject and caller-supplied approver/timestamp.

- [ ] **Step 2: Prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-source-verifier-test.ts \
  src/financial-council-approval-test.ts
```

- [ ] **Step 3: Implement source verification and approval transaction.**

Lock order is temporal barrier/workspace policy → run → latest portfolio revision → approval/outbox. The transaction advances run to `approved` and inserts one outbox row per selected action. On any insert failure, neither approval nor run transition is visible.

- [ ] **Step 4: Run and commit.**

```bash
npm run test:financial-council --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:financial-council:mysql --workspace backend
npm run build --workspace backend
git diff --check
git add backend/src/financial-council-approval* backend/src/financial-council-source-verifier* backend/src/financial-council-repository* backend/src/financial-council-mysql-repository* backend/src/financial-council-service*
git commit -m "feat(finance): approve only current council revisions"
```

---

### Task 3: 定义受控 council draft/todo 与 Advisor 适配边界

**Files:**
- Create: `backend/src/financial-council-draft.ts`
- Create: `backend/src/financial-council-draft-test.ts`
- Create: `backend/src/financial-council-draft-repository.ts`
- Create: `backend/src/financial-council-draft-repository-test.ts`
- Create: `backend/src/financial-council-draft-mysql-repository.ts`
- Create: `backend/src/financial-council-draft-mysql-repository-test.ts`
- Create: `backend/src/financial-council-action-adapter.ts`
- Create: `backend/src/financial-council-action-adapter-test.ts`
- Modify: `backend/src/advisor-recommendation-service.ts`
- Modify: `backend/src/advisor-recommendation-service-test.ts`

**Interfaces:**
- Council-owned non-authoritative artifacts:

```ts
type FinancialCouncilDraft =
  | { kind:"budget_adjustment_draft"; actionId:string; lines:readonly DraftBudgetLine[] }
  | { kind:"finance_todo"; actionId:string; assigneeId:string|null; dueAt:string }
  | { kind:"tax_review_task"; actionId:string; disclaimer:"需专业人员复核" }
  | { kind:"data_completion_plan"; actionId:string; targetRef:FinancialDataGapRef };
```

- `collect_receivable` may map to existing `create_sales_todo` only when the snapshot contains an authoritative customer ID and current assignment; otherwise it becomes a council finance todo without invented customer binding.
- `complete_financial_data` may map to existing `complete_cost_data` or `complete_financial_fact` only with exact current Growth refs.
- No action maps to `create_quote_draft` unless all current QuoteCase revision/input/preview identities were already part of the approved action; first-version action projector does not produce that kind, so default is a review todo.
- Existing Advisor service gains a narrow internal `createAcceptedFromCouncil` that requires a verified `FinancialCouncilApprovalProof`; it cannot be called from HTTP/model tools and still runs the normal reference/action authorizer.

- [ ] **Step 1: Write allowlist and anti-bypass RED tests.**

Reject fake approval proof, unsupported action kind, missing customer binding, cross-workspace assignee, direct accepted recommendation without proof, tax task without disclaimer, raw payment/write payload and duplicate semantic draft.

- [ ] **Step 2: Prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-draft-test.ts \
  src/financial-council-draft-repository-test.ts \
  src/financial-council-action-adapter-test.ts \
  src/advisor-recommendation-service-test.ts
```

- [ ] **Step 3: Implement closed draft domain and adapter.**

Draft IDs are stable hashes of workspace/run/portfolio revision/action ID/kind. Draft rows store source approval/result hashes and remain editable only through their future owning workflow; council worker does not apply them to ledgers.

- [ ] **Step 4: Add MySQL parity and commit.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-draft-test.ts \
  src/financial-council-draft-repository-test.ts \
  src/financial-council-draft-mysql-repository-test.ts \
  src/financial-council-action-adapter-test.ts \
  src/advisor-recommendation-service-test.ts
npm run build --workspace backend
git diff --check
git add backend/src/financial-council-draft* backend/src/financial-council-action-adapter* backend/src/advisor-recommendation-service*
git commit -m "feat(finance): map approved actions to controlled drafts"
```

---

### Task 4: 实现 fenced dispatch outbox、恢复与回执

**Files:**
- Create: `backend/src/financial-council-dispatch-operation.ts`
- Create: `backend/src/financial-council-dispatch-operation-test.ts`
- Create: `backend/src/financial-council-dispatch-worker.ts`
- Create: `backend/src/financial-council-dispatch-worker-test.ts`
- Create: `backend/src/financial-council-dispatch-recovery-sweeper.ts`
- Create: `backend/src/financial-council-dispatch-recovery-sweeper-test.ts`
- Modify: `backend/src/financial-council-repository.ts`
- Modify: `backend/src/financial-council-mysql-repository.ts`
- Modify: `backend/src/growth-financial-council-module.ts`
- Modify: `backend/src/growth-financial-council-module-test.ts`

**Interfaces:**
- Operation lifecycle: `queued|running|retry|succeeded|failed`; claim returns random 64-hex lease token and attempt count.
- Completion/failure requires exact worker, token, attempt and `completedAt < leaseExpiresAt`; exact-expiry result is stale.
- Stable dispatch hash binds workspace/run/approval/portfolio revision/action/result hash.
- Receipt stores only created resource refs and content hash; no full report, CRM notes or model prose.

- [ ] **Step 1: Write crash/replay/ABA RED tests.**

Include duplicate wake, same-worker expired reclaim, exact-expiry completion, crash after external draft create/before operation complete, changed frozen action, one action failure among multiple, restart recovery, stale approval and log redaction.

- [ ] **Step 2: Prove RED, then implement worker and sweeper.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-dispatch-operation-test.ts \
  src/financial-council-dispatch-worker-test.ts \
  src/financial-council-dispatch-recovery-sweeper-test.ts
```

- [ ] **Step 3: Reuse the existing Advisor dispatcher only through the adapter.**

Council worker never calls advisor tool ports with caller-provided tool names. It receives a typed adapter result: `council_draft` or `accepted_advisor_recommendation`, then invokes the corresponding typed service.

- [ ] **Step 4: Run recovery/application lifecycle and commit.**

```bash
npm run test:financial-council --workspace backend
npm run test:growth-advisor --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:financial-council:mysql --workspace backend
npm run build --workspace backend
git diff --check
git add backend/src/financial-council-dispatch* backend/src/financial-council-repository* backend/src/financial-council-mysql-repository* backend/src/growth-financial-council-module*
git commit -m "feat(finance): dispatch approved council drafts safely"
```

---

### Task 5: 暴露修订/审批/派发 API 并完成 P4 审查

**Files:**
- Modify: `backend/src/financial-council-router.ts`
- Modify: `backend/src/financial-council-router-test.ts`
- Modify: `backend/src/financial-council-service.ts`
- Modify: `backend/src/financial-council-service-test.ts`
- Modify: `backend/src/growth-financial-council-module.ts`
- Modify: `backend/src/growth-openapi-test.ts`
- Modify: `backend/src/growth-openapi-response-conformance-test.ts`
- Modify: `backend/src/business-advisor/README.md`

- [ ] **Step 1: Write HTTP RED tests.**

Prove required headers, standard error body, no-store, wrong workspace 404, forbidden 403, stale 409/412, exact replay headers, edit reoptimization, approval 202, reject terminal, dispatch polling and response conformance.

- [ ] **Step 2: Implement routes and run focused GREEN.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-router-test.ts \
  src/financial-council-service-test.ts \
  src/growth-openapi-test.ts \
  src/growth-openapi-response-conformance-test.ts
```

- [ ] **Step 3: Run P4 full gates.**

```bash
npm run test:financial-council --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:financial-council:mysql --workspace backend
npm run test:growth-advisor --workspace backend
npm run test:growth-quotes --workspace backend
npm run test:growth-finance:mysql --workspace backend
npm run test:contracts
npm run check:growth-contracts
npm run build
git diff --check
```

- [ ] **Step 4: Request independent review and fix all findings.**

Review scope: latest-revision fencing, stale source check, capability reauthorization, approval atomicity, outbox fencing, no direct authority writes, adapter allowlist, exact-once resources, tax disclaimer and recovery.

- [ ] **Step 5: Update docs/index and commit.**

```bash
git add backend/src/financial-council-router* backend/src/financial-council-service* backend/src/growth-financial-council-module.ts backend/src/growth-openapi-test.ts backend/src/growth-openapi-response-conformance-test.ts backend/src/business-advisor/README.md docs/superpowers/plans/2026-08-16-financial-multi-agent-council-implementation-index.md
git commit -m "feat(finance): approve and dispatch council portfolios"
```
