# 财务委员会五专家、确定性校验与一次反驳 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把五个专业角色实现为独立、有界、持久和可审计的结构化分析任务，并用确定性公式、证据校验、冲突图和一次定向反驳清洗模型输出。

**Architecture:** `FinancialFormulaCatalog` 先从冻结快照生成权威公式结果和可用动作参数；每个 specialist 通过现有官方 Model Gateway 读取同一 snapshot 的最小投影，只能输出闭合结论、引用和动作种类。`FinancialFindingValidator` 重算并绑定所有引用。`FinancialAuditCoordinator` 用规则生成冲突图，只向冲突双方发出一轮定向 rebuttal，随后持久化 accepted/minority/rejected/unresolved 状态。

**Tech Stack:** TypeScript、Zod、现有 ActiveModelGateway/model snapshots/call ledger、MySQL 8、Node test runner、现有 `business-advisor` 公式。

## Global Constraints

- 依赖 P1 完成且公开 `FinancialFinding`、`CandidateAction`、run/snapshot 合同不再随意修改。
- 五个角色固定为 `finance|profit|cost|cashflow|tax`；CFO 不在本计划生成专业 finding。
- 每个 specialist 只获得其声明的 snapshot slice 和 formula result refs；看不到其他专家自由文本。
- 模型不能输出权威金额/BPS。模型输出的 action 只有 `kind + source refs + explanation`；服务端 action projector 计算 scenario impacts。
- 所有模型任务绑定现有 active official model connection、credential version、prompt/schema hashes 和 model call ledger；无活动连接时运行进入闭合 `not_computable:model_connection_unavailable`。
- prompt 中的 CRM、报表备注和税务文本放在明确的 `UNTRUSTED_DATA` 区，任何其中的指令不得改变 system policy、tools 或 schema。
- finding 没有可见 evidence ref、公式结果不一致、跨租户、跨 snapshot、未来时间、open shape、未知 action kind 或未声明假设时直接拒绝，不进入投票。
- 税务专家只能输出风险体检和专业复核动作，文本必须含“需专业人员复核”；不得输出“已合规”、避税或申报指令。
- 每个专家初始提交一次；只在被 conflict edge 指向时允许一次 rebuttal。超时、重试或进程恢复不能增加轮次。

---

### Task 1: 版本化确定性公式与服务端动作投影

**Files:**
- Create: `backend/src/financial-council-formulas.ts`
- Create: `backend/src/financial-council-formulas-test.ts`
- Create: `backend/src/financial-council-action-projector.ts`
- Create: `backend/src/financial-council-action-projector-test.ts`
- Modify: `backend/src/business-advisor/analysis.ts`
- Modify: `backend/src/business-advisor/service-test.ts`

**Interfaces:**
- Produces `FinancialFormulaResult {formulaId;formulaVersion;inputHash;resultHash;value;unit;evidenceRefs}`.
- Reuses `analyzeFinancialIndicators/analyzeProductProfit/analyzeCustomerProfit/analyzeCashflow/analyzeCost/analyzeTaxRisk`; only extracts pure helpers where tests need direct versioned results.
- Produces `FinancialActionHypothesis {kind;sourceFindingIds;subjectRef|null;explanation}` from model output and `projectCandidateAction(hypothesis,formulaResults,policy)` from trusted code.
- Closed action formulas:
  - `collect_receivable`: eligible overdue receivable × `3000/5000/7000` BPS cash recovery.
  - `review_loss_product_pricing`: gap from current true profit to policy minimum margin, with `5000/7500/10000` BPS realization.
  - `reduce_cost_anomaly`: verified avoidable cost basis × policy realization BPS.
  - `prepare_cash_reserve_budget`: scenario cash shortfall only; never invents funding.
  - `complete_financial_data`: zero direct money impact, capacity/data-risk reduction only.
  - `schedule_tax_review`: zero direct money impact, risk reduction only and professional-review disclaimer.

- [ ] **Step 1: Write failing formula replay and no-free-money tests.**

```ts
test("model hypothesis cannot supply scenario money", () => {
  assert.throws(() => parseActionHypothesis({
    kind: "collect_receivable",
    sourceFindingIds: ["finding-1"],
    cashImpact: { base: 999_999_999 }
  }), hasCode("financial_action_hypothesis_invalid"));
});

test("receivable scenarios are derived from the frozen formula basis", () => {
  const action = projectCandidateAction(hypothesis("collect_receivable"),
    formulas({ overdueReceivableMinor: 1_000_000 }), policy());
  assert.deepEqual(action.cashImpact, {
    conservative: 300_000, base: 500_000, optimistic: 700_000
  });
});
```

- [ ] **Step 2: Prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-formulas-test.ts \
  src/financial-council-action-projector-test.ts
```

Expected: missing formula/action modules.

- [ ] **Step 3: Implement formulas with canonical integer arithmetic.**

Each formula rejects unsafe integers, wrong currency, mismatched snapshot hashes and absent required facts. Missing input produces a `DataGap`, not zero.

- [ ] **Step 4: Verify current business-advisor results are unchanged.**

```bash
npm run test:business-advisor --workspace backend
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-formulas-test.ts \
  src/financial-council-action-projector-test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add backend/src/business-advisor/analysis.ts backend/src/business-advisor/service-test.ts backend/src/financial-council-formulas.ts backend/src/financial-council-formulas-test.ts backend/src/financial-council-action-projector.ts backend/src/financial-council-action-projector-test.ts
git commit -m "feat(finance): version council formulas and actions"
```

---

### Task 2: 封装现有官方模型网关为专业智能体端口

**Files:**
- Create: `backend/src/financial-council-model-content.ts`
- Create: `backend/src/financial-council-model-content-test.ts`
- Create: `backend/src/financial-council-model-port.ts`
- Create: `backend/src/financial-council-model-gateway.ts`
- Create: `backend/src/financial-council-model-gateway-test.ts`
- Modify: `backend/src/model-providers/runtime.ts`
- Modify: `backend/src/model-providers/gateway.ts`
- Modify: `backend/src/model-providers/adapters/openai-compatible.ts`
- Modify: `backend/src/model-gateway-test.ts`
- Modify: `backend/src/model-runtime-integration-test.ts`
- Modify: `backend/src/financial-council-service.ts`
- Modify: `backend/src/financial-council-service-test.ts`
- Modify: `backend/src/mysql-store.ts`
- Modify: `backend/schema.mysql.sql`
- Modify: `backend/goodjob_crm.full.sql`
- Modify if the migration test requires it: `backend/src/model-pending-appends-test.ts`
- Modify if the live migration test requires it: `backend/src/provider-mysql-persistence-test.ts`
- Modify: `docs/superpowers/plans/2026-08-16-financial-council-contracts-snapshot.md`

**Interfaces:**
- Produces `FinancialCouncilModelPort.analyze(input)` and `.rebut(input)`; tests use an in-memory fake, production uses `ActiveModelGateway.generateStructured`.
- Each call binds a distinct immutable job snapshot:

```text
jobId: financial-council:{runId}:{role}:{phase}:{attempt}
promptVersion: financial-council-{role}-{phase}.v1
schemaVersion: financial-council-specialist-output.v1
```

- Model output contains only `findingDrafts[]` and `actionHypotheses[]`; all refs are IDs already supplied in the input allowlist.
- `rebut` output is exactly `{decision:"uphold"|"revise"|"withdraw";findingId;evidenceRefs;replacement|null;explanation}`.
- P1 run IDs remain the published `financial-council:create:sha256:<64hex>` shape but hash a canonical tenant scope plus the physical idempotency-key hash, so mandated specialist job IDs are globally collision-free across workspaces.
- Official model snapshot/call-ledger `job_id` columns accept the full mandated ID (bounded to 255 ASCII bytes); existing tables are migrated fail-closed before use and the static schema matches runtime schema.
- Both maintained SQL schema artifacts match the runtime migration; the full dump is not left at the obsolete 90-character boundary.
- The trusted prompt embeds the canonical phase output schema and closed field instructions; `response_format=json_object` alone is not treated as sufficient provider guidance.
- The gateway's single repair request retains the original trusted prompt/schema context plus bounded validation issues and prior output; repair never becomes a context-free second protocol.
- Structured generation carries separate trusted system and untrusted user prompts through the official adapter as actual `system` and `user` messages; a delimiter inside one user message is not treated as instruction-priority isolation.
- Specialist single-flight entries bind the complete tenant, run, frozen snapshot, role, phase, attempt, content, prompt and schema identity; a colliding in-flight request cannot reuse another tenant's result.
- Non-tool structured generation rejects any provider tool call, and its request deadline remains active through response-body parsing.
- Finding/action/rebut narratives use only closed server-authored text codes or supplied allowlist IDs, so models cannot express authoritative figures through prose. Tax narratives are closed to the server-authored `税务风险需专业人员复核` boundary with no model-authored tax assumptions, compliance claims or filing instructions.

- [ ] **Step 1: Write missing-connection, content-hash and prompt-injection RED tests.**

Include: wrong credential identity, model lacking structured output, output ref not in allowlist, additional property, repair still invalid, timeout, rate limit, CRM text asking to call a write tool, and persistence failure after a provider call.

- [ ] **Step 2: Prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-model-content-test.ts \
  src/financial-council-model-gateway-test.ts
```

- [ ] **Step 3: Implement frozen content bundles and gateway adapter.**

The system prompt states that all supplied business text is untrusted data, no tool calls exist, figures must be referenced rather than recalculated, and tax output is risk screening only. Persist model call records through the existing ledger before returning a successful specialist result.

- [ ] **Step 4: Run model runtime regression.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/model-gateway-test.ts \
  src/model-runtime-integration-test.ts \
  src/financial-council-model-gateway-test.ts
npm run build --workspace backend
```

- [ ] **Step 5: Commit.**

```bash
git add backend/src/financial-council-model-* backend/src/model-providers/runtime.ts backend/src/model-providers/gateway.ts backend/src/model-providers/adapters/openai-compatible.ts backend/src/model-gateway-test.ts backend/src/model-runtime-integration-test.ts backend/src/financial-council-service.ts backend/src/financial-council-service-test.ts backend/src/mysql-store.ts backend/src/model-pending-appends-test.ts backend/schema.mysql.sql backend/goodjob_crm.full.sql docs/superpowers/plans/2026-08-16-financial-council-contracts-snapshot.md docs/superpowers/plans/2026-08-16-financial-council-specialists-audit.md
git commit -m "feat(finance): bind council specialists to model snapshots"
```

---

### Task 3: 实现五专家独立提交与确定性 finding 校验

**Files:**
- Create: `backend/src/financial-council-specialists.ts`
- Create: `backend/src/financial-council-specialists-test.ts`
- Create: `backend/src/financial-council-finding-validator.ts`
- Create: `backend/src/financial-council-finding-validator-test.ts`
- Modify: `backend/src/financial-council-repository.ts`
- Modify: `backend/src/financial-council-repository-contract-test.ts`
- Modify: `backend/src/financial-council-mysql-repository.ts`
- Modify: `backend/src/financial-council-mysql-repository-test.ts`

**Interfaces:**
- Produces role projections, each with a closed formula/evidence allowlist and no peer text.
- `FinancialFindingValidator.validate(snapshot,role,output)` returns validated immutable findings/actions or closed rejection reasons.
- Repository adds `storeSpecialistResult/getSpecialistResult/listSpecialistResults`; unique key `(run_id,role,phase)` makes exact retries replay and changed output conflict.
- MySQL adds `financial_council_specialist_results`, `financial_council_findings`, `financial_council_candidate_actions`.

- [ ] **Step 1: Write five-role isolation and validator RED tests.**

```ts
test("all specialists receive the exact same snapshot identity without peer prose", async () => {
  await council.runSpecialists(run, snapshot);
  assert.deepEqual(model.calls.map((call) => call.snapshot),
    Array(5).fill(snapshot));
  assert.equal(model.calls.every((call) => !("peerFindings" in call)), true);
});
```

Also reject cross-snapshot formula ref, hidden amount, unauthorized customer, action with server impact fields, confidence outside 0..10000, tax compliance claim and fifth-role failure that hides a cash hard-constraint input.

- [ ] **Step 2: Prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-specialists-test.ts \
  src/financial-council-finding-validator-test.ts \
  src/financial-council-repository-test.ts
```

- [ ] **Step 3: Implement role tool manifests and validators.**

Role access:

```text
finance  -> statements, ratios, debt/coverage, verified financial gaps
profit   -> product/customer true-profit formulas, quote/ROI summaries
cost     -> cost structure, verified cost gaps, variance formulas
cashflow -> cash forecast, receivables, payment/settlement summaries
tax      -> provided tax-risk inputs and verified data gaps only
```

- [ ] **Step 4: Add durable specialist result parity.**

Prove exact replay, altered replay conflict, partial write rollback, parser closed shape, cross-run IDs and all five results tied to one snapshot hash.

- [ ] **Step 5: Run and commit.**

```bash
npm run test:financial-council --workspace backend
npm run build --workspace backend
git diff --check
git add backend/src/financial-council-specialists* backend/src/financial-council-finding-validator* backend/src/financial-council-repository* backend/src/financial-council-mysql-repository*
git commit -m "feat(finance): persist validated specialist findings"
```

---

### Task 4: 构建确定性冲突图与一次定向反驳

**Files:**
- Create: `backend/src/financial-council-audit.ts`
- Create: `backend/src/financial-council-audit-test.ts`
- Create: `backend/src/financial-council-rebuttal.ts`
- Create: `backend/src/financial-council-rebuttal-test.ts`
- Modify: `backend/src/financial-council-repository.ts`
- Modify: `backend/src/financial-council-repository-contract-test.ts`
- Modify: `backend/src/financial-council-mysql-repository.ts`
- Modify: `backend/src/financial-council-mysql-repository-test.ts`

**Interfaces:**
- Closed conflict kinds: `formula|evidence|definition|action_exclusivity|resource_competition|risk_preference`.
- Edge identity is a canonical hash of run/snapshot/kind/sorted finding IDs/shared refs; input order cannot change it.
- Formula/evidence/permission conflicts are resolved only by deterministic validation or withdrawal, never majority vote.
- Repository adds audit graph, rebuttal attempts and final finding disposition. One `(run_id,role,round=1)` row is allowed; round 2 is invalid.
- Each role receives at most one rebuttal call. When several directed conflicts exist, select one target deterministically by `formula > evidence > definition > action_exclusivity > resource_competition > risk_preference`, then edge ID and finding ID. Unselected unresolved conflicts receive no second call and continue to block affected actions.
- `resource_competition` is structural in P2: actions sharing one canonical subject/resource signature conflict. Numeric capacity policy remains P3 scope.
- Reserve the immutable rebuttal input hash durably before the provider call; restart reuses the same `(run,role,round=1)` reservation/job identity and completion is exact-replay-only.

- [x] **Step 1: Write joint counterexample RED tests.**

Cover profitable-but-cash-negative, high gross margin/negative true profit, high ROI/incomplete evidence, same action competing for capacity, unrelated findings not linked, and one expert timing out during rebuttal.

- [x] **Step 2: Prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-audit-test.ts \
  src/financial-council-rebuttal-test.ts
```

- [x] **Step 3: Implement deterministic graph and one-round coordinator.**

Rebuttal input contains only the specialist's original finding, the exact conflicting refs, the peer's structured claim summary without hidden chain-of-thought, and the validator reason. Rebuttal output re-enters the same validator.

- [x] **Step 4: Prove recovery cannot create a second round.**

Test crash after model result/before persist, crash after persist/before run transition, duplicate worker wake and changed rebuttal result. At most one durable round exists.

- [x] **Step 5: Run and commit.**

```bash
npm run test:financial-council --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:financial-council:mysql --workspace backend
npm run build --workspace backend
git diff --check
git add backend/src/financial-council-audit* backend/src/financial-council-rebuttal* backend/src/financial-council-repository* backend/src/financial-council-mysql-repository*
git commit -m "feat(finance): audit council findings with one rebuttal"
```

---

### Task 5: P2 orchestration、预算、恢复与审查

**Files:**
- Create: `backend/src/financial-council-analysis-worker.ts`
- Create: `backend/src/financial-council-analysis-worker-test.ts`
- Create: `backend/src/financial-council-recovery-sweeper.ts`
- Create: `backend/src/financial-council-recovery-sweeper-test.ts`
- Modify: `backend/src/growth-financial-council-module.ts`
- Modify: `backend/src/growth-financial-council-module-test.ts`
- Modify: `backend/src/financial-council-service.ts`
- Modify: `backend/src/financial-council-service-test.ts`
- Modify: `backend/src/financial-council-repository.ts`
- Modify: `backend/src/financial-council-repository-contract-test.ts`
- Modify: `backend/src/financial-council-repository-test.ts`
- Modify: `backend/src/financial-council-mysql-repository.ts`
- Modify: `backend/src/financial-council-mysql-repository-test.ts`
- Modify: `backend/src/financial-council-specialists.ts`
- Modify: `backend/src/financial-council-specialists-test.ts`
- Modify if lease fencing requires it: `backend/src/financial-council-audit.ts`
- Modify if lease fencing requires it: `backend/src/financial-council-audit-test.ts`
- Modify if lease fencing requires it: `backend/src/financial-council-rebuttal.ts`
- Modify if lease fencing requires it: `backend/src/financial-council-rebuttal-test.ts`
- Modify: `backend/src/growth-commercial-composition.ts`
- Modify: `backend/src/growth-commercial-composition-test.ts`
- Modify: `backend/src/growth-commercial-application-test.ts`
- Modify: `backend/package.json`
- Modify: `backend/src/business-advisor/README.md`
- Modify: `docs/superpowers/plans/2026-08-16-financial-multi-agent-council-implementation-index.md`

**Interfaces:**
- Worker advances `snapshot_frozen -> analyzing -> auditing -> synthesizing` only after required durable artifacts exist.
- Per-agent timeout defaults to 60s, total model calls to 10 (5 initial + at most 5 rebuttals), retry to one transport retry without increasing logical submission count.
- Lease contains random token + attempt count + strict expiry; completion at exact expiry is stale.
- Recovery claims stalled nonterminal work, reuses existing model/result identities and never duplicates findings or rebuttals.
- Persist immutable private analysis owner/team identity at create/freeze time; recovery never derives model identity from the currently selected workspace.
- Every worker-owned transition/artifact write is fenced by exact lease token + attempt and `completedAt < leaseExpiresAt`; the lease token prevents same-worker ABA while model logical attempt remains `1` across retries/reclaims.
- Finance and cashflow are hard-constraint roles. Profit/cost/tax failure may continue only when a deterministic check proves no unavailable hard-constraint formula/action and persists a closed redacted gap; missing tax input is a data gap, not invented output.

- [x] **Step 1: Write worker/recovery RED tests.**

Include same-worker lease ABA, exact-expiry completion, model timeout, one noncritical expert failure, cashflow expert failure, missing tax input, duplicate wake, process restart and logging redaction.

- [x] **Step 2: Prove RED, implement worker and sweeper, then prove GREEN.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-analysis-worker-test.ts \
  src/financial-council-recovery-sweeper-test.ts \
  src/growth-financial-council-module-test.ts
```

- [x] **Step 3: Run full P2 gates.**

```bash
npm run test:business-advisor --workspace backend
npm run test:financial-council --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:financial-council:mysql --workspace backend
npm run test:growth-advisor --workspace backend
npm run build
git diff --check
```

- [x] **Step 4: Run fast-mode counterexample verification.**

The user waived independent review. Keep focused counterexamples for shared snapshot identity, formula provenance, prompt injection, active model snapshot persistence, tool/write absence, tax boundary, one-round guarantee, partial-expert policy, lease fencing and redacted logs.

- [x] **Step 5: Update README/index and commit.**

```bash
git add backend/src/financial-council-analysis-worker* backend/src/financial-council-recovery-sweeper* backend/src/growth-financial-council-module* backend/src/financial-council-service* backend/src/business-advisor/README.md docs/superpowers/plans/2026-08-16-financial-multi-agent-council-implementation-index.md
git commit -m "feat(finance): run recoverable financial specialist council"
```
