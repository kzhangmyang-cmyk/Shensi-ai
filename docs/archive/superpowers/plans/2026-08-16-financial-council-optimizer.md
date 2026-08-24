# 财务委员会 CFO 合成、策略版本与确定性组合优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把经审计的专家结论合成为不丢异议的统一经营判断，并在不可关闭的硬约束内计算平衡、现金优先和增长优先三套可解释行动组合。

**Architecture:** 先由确定性 consensus builder 固化 accepted/minority/rejected/unresolved/data-gap 集合，再允许 CFO 模型生成只引用这些集合的叙述。工作区使用不可变 `FinancialCouncilPolicyVersion` 保存权重与可调阈值，硬约束代码不属于策略开关。优化器以最多 24 个已验证动作运行稳定排序的 exact branch-and-bound，并用 brute-force oracle 证明正确性。

**Tech Stack:** TypeScript、BigInt/integer BPS、Zod、MySQL 8、现有模型网关、Node test runner。

## Global Constraints

- 依赖 P2 完成；只有 disposition 为 accepted/minority 且无 unresolved critical conflict 的 action 可以进入 optimizer。
- CFO 不得改写 specialist record、公式值、置信度、冲突状态或 action impact；CFO 只生成 `overallDiagnosis` 和排序解释。
- 不保存模型 chain-of-thought。CFO 叙述必须逐段带 finding IDs，并通过引用 allowlist 校验。
- 策略权重允许工作区配置；现金储备、到期债务/必要支出覆盖、合规、权限、关键数据、预算、容量、时限、前置、互斥和置信门槛的存在性不可配置为关闭。
- 所有 policy version 不可变；激活新策略不改写旧运行。
- 优化器不调用模型、不查询数据库、不读取当前时间，只接受深冻结输入。
- 算术使用 `bigint` 中间值并在公开边界做 safe-integer 检查；排序不依赖 JS `Set/Map` 插入顺序。
- 三套组合不是三个随意标签：每套使用固定、版本化的权重变换并在相同硬约束下重新求最优。

---

### Task 1: 构建不丢异议的 ConsensusReport 与 CFO 叙述校验

**Files:**
- Create: `backend/src/financial-council-consensus.ts`
- Create: `backend/src/financial-council-consensus-test.ts`
- Create: `backend/src/financial-council-cfo.ts`
- Create: `backend/src/financial-council-cfo-test.ts`
- Modify: `backend/src/financial-council-model-content.ts`
- Modify: `backend/src/financial-council-model-content-test.ts`
- Modify: `backend/src/financial-council-model-port.ts`
- Modify: `backend/src/financial-council-model-gateway.ts`
- Modify: `backend/src/financial-council-model-gateway-test.ts`
- Modify: `backend/src/financial-council-repository.ts`
- Modify: `backend/src/financial-council-mysql-repository.ts`

**Interfaces:**
- `buildConsensus(audit)` deterministically partitions every finding exactly once into accepted/minority/rejected/unresolved-related sets and aggregates data gaps.
- `FinancialCfoNarrativePort.synthesize(input)` receives only structured validated findings and conflict decisions.
- CFO output is `{overallDiagnosis,priorityFindingIds,minorityFindingIds,riskNotes}` with no money, BPS, status or action mutation fields.
- Repository adds `storeConsensus/getConsensus`; one canonical consensus per run/snapshot/audit hash.

- [ ] **Step 1: Write partition completeness and unsupported narrative RED tests.**

```ts
test("every audited finding appears exactly once", () => {
  const report = buildConsensus(auditFixture());
  const ids = [
    ...report.acceptedFindingIds,
    ...report.minorityFindingIds,
    ...report.rejectedFindings.map((row) => row.findingId),
    ...report.unresolvedConflicts.flatMap((row) => row.findingIds)
  ];
  assert.deepEqual([...new Set(ids)].sort(), allFindingIds.sort());
});
```

Add cases where CFO omits a critical minority, cites a rejected ID as accepted, adds a new number, claims tax compliance or produces an unreferenced paragraph.

- [ ] **Step 2: Prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-consensus-test.ts \
  src/financial-council-cfo-test.ts
```

- [ ] **Step 3: Implement deterministic partition first, then bounded narrative.**

If the CFO model is unavailable or invalid, preserve the deterministic report and use a server template diagnosis; mark `narrativeStatus:model_unavailable|model_invalid`. This does not block optimization because facts are already validated.

- [ ] **Step 4: Add repository parity and commit.**

```bash
npm run test:financial-council --workspace backend
npm run build --workspace backend
git diff --check
git add backend/src/financial-council-consensus* backend/src/financial-council-cfo* backend/src/financial-council-model-* backend/src/financial-council-repository* backend/src/financial-council-mysql-repository*
git commit -m "feat(finance): synthesize audited council consensus"
```

---

### Task 2: 实现不可变策略版本与权限化配置

**Files:**
- Create: `backend/src/financial-council-policy.ts`
- Create: `backend/src/financial-council-policy-test.ts`
- Create: `backend/src/financial-council-policy-repository.ts`
- Create: `backend/src/financial-council-policy-repository-test.ts`
- Create: `backend/src/financial-council-policy-mysql-repository.ts`
- Create: `backend/src/financial-council-policy-mysql-repository-test.ts`
- Modify: `backend/src/financial-council-service.ts`
- Modify: `backend/src/financial-council-router.ts`
- Modify: `backend/src/financial-council-router-test.ts`
- Modify: `backend/src/growth-financial-council-module.ts`

**Interfaces:**
- `FinancialCouncilPolicyVersion` stores version/revision, currency, balanced objective weights summing to 10,000 BPS, minimum cash reserve, due debt/necessary outflow, budget/capacity/duration limits, minimum action confidence and action coefficient versions.
- Cash-first and growth-first transforms are fixed in code:

```text
cash_first: cash weight +2500 BPS, profit/strategic weights scaled proportionally
growth_first: profit + strategic weights +2500 BPS, cash weight never below 2000 BPS
```

- Hard constraint kinds are not booleans in policy and therefore cannot be disabled.
- `PUT /api/v1/finance/council-policy` creates a new immutable version using `If-Match`; GET returns the active version projected by capability.

- [ ] **Step 1: Write policy closure, activation and anti-disable RED tests.**

Reject weights not totaling 10,000, negative limits, unsafe money, unknown coefficient version, `enforceCash:false`, caller timestamps, old revision, cross-workspace policy and exact idempotency key with changed body.

- [ ] **Step 2: Prove RED, implement memory/MySQL parity and router.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-policy-test.ts \
  src/financial-council-policy-repository-test.ts \
  src/financial-council-policy-mysql-repository-test.ts \
  src/financial-council-router-test.ts
```

- [ ] **Step 3: Seed a server-owned default policy only when no workspace version exists.**

The default is a named immutable `financial-council-policy.v1`; once materialized, every run stores its exact policy ID/version/hash.

- [ ] **Step 4: Run and commit.**

```bash
npm run test:financial-council --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:financial-council:mysql --workspace backend
npm run build --workspace backend
git diff --check
git add backend/src/financial-council-policy* backend/src/financial-council-service.ts backend/src/financial-council-router* backend/src/growth-financial-council-module.ts
git commit -m "feat(finance): version council optimization policy"
```

---

### Task 3: 实现硬约束引擎和 scenario 聚合

**Files:**
- Create: `backend/src/financial-portfolio-constraints.ts`
- Create: `backend/src/financial-portfolio-constraints-test.ts`
- Create: `backend/src/financial-portfolio-scenarios.ts`
- Create: `backend/src/financial-portfolio-scenarios-test.ts`

**Interfaces:**
- `evaluateHardConstraints(input,selectedIds)` returns every constraint with `{kind,status,actual,required,blockingActionIds,reason}`.
- `aggregatePortfolioScenarios` sums conservative/base/optimistic cash/profit/risk using checked BigInt arithmetic.
- Required constraint kinds:

```text
cash_reserve
debt_and_necessary_outflow_coverage
compliance
permission
data_completeness
minimum_confidence
budget
capacity
duration
prerequisite
mutual_exclusion
duplicate_action
```

- [ ] **Step 1: Write one RED test per hard constraint.**

Include equality boundaries, exact cash reserve, missing prerequisite closure, prerequisite cycle, mutual exclusion symmetry, duplicate semantic action, unresolved tax/evidence conflict, overflow and empty candidate list.

- [ ] **Step 2: Prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-portfolio-constraints-test.ts \
  src/financial-portfolio-scenarios-test.ts
```

- [ ] **Step 3: Implement deterministic evaluation order.**

Sort actions by `actionId`; evaluate all constraints even after a failure so UI receives complete reasons. A set is feasible only when every status is `satisfied`.

- [ ] **Step 4: Verify counterexamples and commit.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-portfolio-constraints-test.ts \
  src/financial-portfolio-scenarios-test.ts
npm run build --workspace backend
git diff --check
git add backend/src/financial-portfolio-constraints* backend/src/financial-portfolio-scenarios*
git commit -m "feat(finance): enforce portfolio hard constraints"
```

---

### Task 4: 实现 exact branch-and-bound 与 brute-force oracle

**Files:**
- Create: `backend/src/financial-action-optimizer.ts`
- Create: `backend/src/financial-action-optimizer-test.ts`
- Create: `backend/src/financial-action-optimizer-oracle-test.ts`
- Create: `backend/src/financial-action-optimizer-fixtures.ts`

**Interfaces:**
- `optimizeFinancialActions({snapshot,consensus,actions,policy})` returns exactly three `ActionPortfolio` rows in fixed order.
- Objective score components are integer-normalized to BPS: cash improvement, profit improvement, risk reduction, strategic value, implementation cost, uncertainty, time-to-impact and capacity load.
- Candidate count >24 returns `not_computable:candidate_limit_exceeded`; zero feasible nonempty sets returns three empty portfolios carrying hard-constraint reasons.
- Tie-break order: higher score, higher conservative closing cash, higher conservative profit, lower budget, fewer actions, lexicographically sorted action IDs.

- [ ] **Step 1: Write RED against exhaustive search.**

```ts
test("branch-and-bound equals brute force for seeded random cases", () => {
  for (const seed of Array.from({ length: 200 }, (_, index) => index + 1)) {
    const input = randomOptimizerFixture(seed, { maxActions: 12 });
    assert.deepEqual(optimizeFinancialActions(input), bruteForceOptimize(input));
  }
});
```

Add input-permutation invariance, all ties, 24 candidates, 25 rejection, negative impacts, prerequisite closure, empty feasible result and all three weight modes.

- [ ] **Step 2: Prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-action-optimizer-test.ts \
  src/financial-action-optimizer-oracle-test.ts
```

- [ ] **Step 3: Implement exact search.**

Use a pre-sorted action array, bit masks up to 24 bits, an admissible optimistic score bound, prerequisite closure before feasibility, and deterministic memo keys. The oracle remains test-only and enumerates all `2^n` sets for `n<=12`.

- [ ] **Step 4: Add sensitivity output.**

For each selected action, recompute score without it; for each objective, adjust its weight by ±500 BPS with deterministic rebalancing and record whether the selected set changes. Do not call the model.

- [ ] **Step 5: Run and commit.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-action-optimizer-test.ts \
  src/financial-action-optimizer-oracle-test.ts
npm run build --workspace backend
git diff --check
git add backend/src/financial-action-optimizer*
git commit -m "feat(finance): optimize exact financial action portfolios"
```

---

### Task 5: 持久组合、推进运行并完成 P3 审查

**Files:**
- Create: `backend/src/financial-council-optimization-worker.ts`
- Create: `backend/src/financial-council-optimization-worker-test.ts`
- Modify: `backend/src/financial-council-repository.ts`
- Modify: `backend/src/financial-council-repository-contract-test.ts`
- Modify: `backend/src/financial-council-mysql-repository.ts`
- Modify: `backend/src/financial-council-mysql-repository-test.ts`
- Modify: `backend/src/financial-council-service.ts`
- Modify: `backend/src/growth-financial-council-module.ts`
- Modify: `backend/src/business-advisor/README.md`

**Interfaces:**
- Repository adds immutable consensus and portfolio revision 1 persistence, keyed by run/snapshot/audit/policy/candidate set hash.
- Worker advances `synthesizing -> optimizing -> awaiting_approval`; no feasible combination still reaches `awaiting_approval` with empty portfolios and complete blockers, unless a critical input makes the whole run `not_computable`.
- Recovery replay recomputes and byte-compares optimizer output before accepting a stored row; mismatch is integrity failure.

- [ ] **Step 1: Write end-to-end worker RED tests.**

Cover profitable/cash-breaking expansion, fake-profit product, incomplete high ROI, model-unavailable CFO fallback, reordered candidates, crash between portfolio insert and transition, and stored score tamper.

- [ ] **Step 2: Implement persistence and worker, then run focused GREEN.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-consensus-test.ts \
  src/financial-council-optimization-worker-test.ts \
  src/financial-action-optimizer-test.ts \
  src/financial-action-optimizer-oracle-test.ts
```

- [ ] **Step 3: Run P3 full gates.**

```bash
npm run test:financial-council --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:financial-council:mysql --workspace backend
npm run test:business-advisor --workspace backend
npm run test:growth-advisor --workspace backend
npm run test:contracts
npm run build
git diff --check
```

- [ ] **Step 4: Request independent optimizer review.**

Reviewer checks oracle equivalence, admissible pruning, integer overflow, deterministic tie-break, hard constraints, policy version binding, empty-set semantics, sensitivity accuracy, consensus completeness and model fallback.

- [ ] **Step 5: Fix findings, update README/index and commit.**

```bash
git add backend/src/financial-council-optimization-worker* backend/src/financial-council-repository* backend/src/financial-council-mysql-repository* backend/src/financial-council-service.ts backend/src/growth-financial-council-module.ts backend/src/business-advisor/README.md docs/superpowers/plans/2026-08-16-financial-multi-agent-council-implementation-index.md
git commit -m "feat(finance): publish optimized council portfolios"
```
