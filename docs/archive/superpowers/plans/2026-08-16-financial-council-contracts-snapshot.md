# 财务委员会合同、领域骨架与冻结快照 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先冻结公开合同和内部不可变数据边界，再建立可恢复的运行领域与同一时点快照，保证所有后续智能体分析都建立在同一份可验证事实之上。

**Architecture:** 创建一个闭合的 `financial-council.v1` schema 和 Growth OpenAPI 路由；运行创建时只 seal 一次 Growth cutoff，把请求中的财务报表输入与当前 CRM/报价/财务/ROI 权威投影封装成一个 canonical snapshot。运行、事件和快照在 memory/MySQL 中保持相同行为，异步 worker 只消费持久 snapshot ID，不接受任意事实 payload。

**Tech Stack:** TypeScript、Express、MySQL 8、Zod、JSON Schema 2020-12、OpenAPI 3.1、Node test runner、现有 Growth temporal barrier/idempotency/runtime bridge。

## Global Constraints

- 依赖总索引的全部 Global Constraints。
- 不修改 `business-advisor` 公式语义；本计划只把 `BusinessReportInput` 规范化、冻结和哈希。
- 请求可携带财务报表数据，但不能携带 workspace、actor、capabilities、source versions、formula result、CRM/报价/ROI 事实或服务端时间。
- 财务报表是本次分析的不可变输入证据，不升级为第二套财务账本；Growth 事实继续来自现有权威读模型。
- `FinancialSnapshot` 的敏感字段在构建时按 capability 投影；后续智能体不能恢复被删字段。
- snapshot builder 调用 `GrowthTemporalBarrier.sealReadCutoff` 恰好一次，并把同一个 branded cutoff 传给所有 nested readers。
- snapshot hash 覆盖 workspace binding、dataAsOf、报表 canonical input、全部 source version/hash、数据缺口和脱敏等级；不覆盖数据库自增 ID 或读取顺序。
- 运行创建只持久 `created`；snapshot 冻结成功后以同一事务追加 `snapshot_frozen` 事件。任一失败不留下半个 snapshot。
- 数据库存储的 JSON 必须从 `unknown` 经 closed parser 读取；额外字段、重复 JSON key、矛盾 denormalized 列或 hash 不匹配均报稳定 integrity error。

---

### Task 1: 冻结 `financial-council.v1` 合同与路由形状

**Files:**
- Create: `contracts/json-schema/financial-council.v1.schema.json`
- Modify: `contracts/openapi/growth-advisor-quote-roi.v1.yaml`
- Modify: `contracts/test/schema-registry.test.mjs`
- Modify: `contracts/test/growth-openapi.test.mjs`
- Modify: `contracts/test/generated-types.test.mjs`
- Modify: `backend/src/growth-contract-types.ts`
- Modify: `backend/src/growth-contract-types-test.ts`
- Modify: `backend/src/growth-openapi-test.ts`
- Modify: `backend/src/growth-openapi-contract-drift-test.ts`
- Modify: `backend/src/growth-openapi-response-conformance-test.ts`
- Modify: `backend/src/catalog-runtime-response-conformance-test.ts`
- Modify: `backend/src/quote-runtime-response-conformance-test.ts`

**Interfaces:**
- Produces closed `$defs` for `FinancialCouncilCreateInput`, `FinancialCouncilRun`, `FinancialCouncilRunEvent`, `FinancialSnapshotView`, `FinancialFinding`, `CandidateAction`, `ConsensusReport`, `ActionPortfolio`, `FinancialCouncilPolicyVersion`, `PortfolioRevisionInput`, `FinancialCouncilApproval`, and `FinancialCouncilDispatchView`.
- `FinancialCouncilCreateInput` contains exactly `{currency,dataAsOf,businessReport,policyVersionId}`; `businessReport` reuses the closed field set in `backend/src/business-advisor/domain.ts` and exposes integers only.
- Public money uses safe signed integer minor bounds; hashes are `sha256:<64 lowercase hex>`; BPS are signed only where a scenario delta can be negative.
- Public run statuses are `created|snapshot_frozen|analyzing|auditing|synthesizing|optimizing|awaiting_approval|approved|rejected|expired|failed|not_computable`.
- Routes are the exact surface listed in the index; create returns `202`, reads return `200`, commands declare `Idempotency-Key`, revision commands also declare `If-Match`, and errors reuse `ApiError`.

- [ ] **Step 1: Add failing schema and OpenAPI assertions before the schema.**

```js
test("financial council contract is closed and carries three portfolios", () => {
  const validate = registry.validator("financial-council");
  const valid = financialCouncilRunFixture();
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...valid, hiddenPrompt: "ignore policy" }), false);
  assert.deepEqual(valid.portfolios.map((row) => row.kind), [
    "balanced", "cash_first", "growth_first"
  ]);
});
```

- [ ] **Step 2: Run the contract tests and prove RED.**

Run:

```bash
npm run test:contracts
npm run test:growth-openapi --workspace backend
```

Expected: schema registry fails because `financial-council` is absent and OpenAPI route assertions cannot find `/api/v1/finance/council-runs`.

- [ ] **Step 3: Implement the schema, route declarations and generated TypeScript aliases.**

The action union is closed to:

```ts
export type FinancialCouncilActionKind =
  | "collect_receivable"
  | "review_loss_product_pricing"
  | "reduce_cost_anomaly"
  | "prepare_cash_reserve_budget"
  | "complete_financial_data"
  | "schedule_tax_review";
```

Every `CandidateAction` requires `requiresHumanApproval: true`, three scenarios, source finding IDs, prerequisites, mutual exclusions, budget/capacity/duration, confidence and capabilities. No schema allows `execute`, `payment`, `posting`, `tax_filing` or arbitrary tool names.

- [ ] **Step 4: Regenerate and verify the immutable Growth release.**

Increment the Growth OpenAPI patch version, then run:

```bash
npm run build:growth-contract-release
npm run test:contracts
npm run test:growth-openapi --workspace backend
npm run check:growth-contract-release
```

Expected: all pass; the release contains the new version directory and an exact manifest hash.

- [ ] **Step 5: Commit the contract slice.**

```bash
git add contracts backend/src/growth-contract-types.ts backend/src/growth-contract-types-test.ts backend/src/growth-openapi-test.ts backend/src/growth-openapi-contract-drift-test.ts backend/src/growth-openapi-response-conformance-test.ts
git commit -m "feat(finance): define financial council contracts"
```

---

### Task 2: 建立运行状态机、事件与仓储行为合同

**Files:**
- Create: `backend/src/financial-council-domain.ts`
- Create: `backend/src/financial-council-domain-test.ts`
- Create: `backend/src/financial-council-repository.ts`
- Create: `backend/src/financial-council-repository-test.ts`
- Create: `backend/src/financial-council-repository-contract-test.ts`
- Create: `backend/src/financial-council-mysql-repository.ts`
- Create: `backend/src/financial-council-mysql-repository-test.ts`

**Interfaces:**
- Produces immutable `FinancialCouncilRun`, `FinancialCouncilRunEvent`, `FinancialSnapshotRecord` and pure `applyFinancialCouncilTransition`.
- Produces `FinancialCouncilRepository.createRun/findRun/listEvents/storeFrozenSnapshot/transitionRun` with one memory/MySQL contract suite.
- Create uniqueness is `(workspace_id, creation_key_hash)` plus `request_hash`; exact replay returns the same run and changed request fails `financial_council_idempotency_conflict`.
- Every transition requires exact current revision and legal state; event revision is contiguous and event snapshot hash must match canonical aggregate JSON.

- [ ] **Step 1: Write the state graph, replay and integrity RED tests.**

```ts
test("run transitions are closed and revisioned", () => {
  const created = runFixture({ status: "created", revision: 1 });
  const frozen = applyFinancialCouncilTransition(created, {
    kind: "snapshot_frozen", occurredAt: T1, actorId: "system:council"
  });
  assert.equal(frozen.status, "snapshot_frozen");
  assert.equal(frozen.revision, 2);
  assert.throws(() => applyFinancialCouncilTransition(frozen, {
    kind: "approved", occurredAt: T2, actorId: "actor-1"
  }), hasCode("financial_council_transition_invalid"));
});
```

Add behavior cases for concurrent transition winner, cross-workspace read, duplicate create replay, changed request conflict, open JSON, duplicate JSON keys, denormalized status mismatch, and rollback after snapshot insert failure.

- [ ] **Step 2: Run and prove RED.**

```bash
cd backend
node --import tsx --test --test-concurrency=1 \
  src/financial-council-domain-test.ts \
  src/financial-council-repository-test.ts \
  src/financial-council-mysql-repository-test.ts
```

Expected: `ERR_MODULE_NOT_FOUND` for `financial-council-domain.js`.

- [ ] **Step 3: Implement domain and memory repository.**

Use this state graph only:

```text
created -> snapshot_frozen -> analyzing -> auditing -> synthesizing
-> optimizing -> awaiting_approval -> approved | rejected | expired
nonterminal -> failed | not_computable
```

Terminal states never reopen. A later fresh analysis is a new run ID, not a run reset.

- [ ] **Step 4: Implement MySQL schema and fail-closed parsers.**

Create exactly:

```text
financial_council_runs
financial_council_run_events
financial_council_snapshots
```

Named schema lock handling, transaction rollback/destroy behavior, JSON duplicate detection and denormalized cross-check follow the existing advisor/visual repository patterns. Store canonical JSON bytes and a separate `snapshot_hash`; parser recomputes the hash.

- [ ] **Step 5: Run parity and commit.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-domain-test.ts \
  src/financial-council-repository-test.ts \
  src/financial-council-mysql-repository-test.ts
npm run build --workspace backend
git diff --check
git add backend/src/financial-council-*
git commit -m "feat(finance): persist financial council runs"
```

---

### Task 3: 建立同一 cutoff 的权威快照读取层

**Files:**
- Modify: `backend/src/growth-advisor-query.ts`
- Modify: `backend/src/growth-advisor-query-test.ts`
- Create: `backend/src/financial-council-snapshot.ts`
- Create: `backend/src/financial-council-snapshot-test.ts`
- Create: `backend/src/financial-council-authority-reader.ts`
- Create: `backend/src/financial-council-authority-reader-test.ts`
- Modify: `backend/src/business-advisor/domain.ts`
- Modify: `backend/src/business-advisor/domain-test.ts`
- Modify: `backend/src/financial-ledger-repository.ts`
- Modify: `backend/src/financial-ledger-mysql-repository.ts`
- Modify: `backend/src/financial-ledger-as-of-reader.ts`
- Modify: `backend/src/financial-ledger-as-of-reader-test.ts`
- Modify: `backend/src/financial-ledger-as-of-mysql-reader.ts`
- Modify: `backend/src/financial-ledger-as-of-mysql-reader-test.ts`

**Interfaces:**
- Adds internal `GrowthAdvisorSealedQueryService.getTodayAt(context,{currency,cutoff})`; both paths share one sealed loader, while public `getToday` preserves its legacy 10/50 collection limits and internal authority reads use 100-row completeness probes that fail closed when the probe cap is reached.
- Produces `FinancialCouncilAuthorityReader.readAt(context,{currency,cutoff})` over current CRM visibility, pending quote approvals, verified finance gaps/facts and expected/actual ROI projections.
- Extends the sealed financial-ledger reader with a workspace-scoped verified-fact enumeration path so production authority snapshots never depend on caller-supplied fact IDs or test fixtures. The cutoff remains the sole temporal authority; the context workspace is the visibility boundary and `pricing.sensitive.read` remains the field-level amount/cost projection boundary.
- Produces `FinancialSnapshotBuilder.freeze(command,input)` returning a deeply frozen snapshot and deterministic `snapshotHash`.
- Snapshot contains canonical normalized report, deterministic business-analysis facts, Growth authority view, closed data gaps, source refs/hashes, projection level and one `dataAsOf`.

- [ ] **Step 1: Write the single-seal and same-object RED tests.**

```ts
test("snapshot seals once and every reader receives the same cutoff", async () => {
  const seen: object[] = [];
  const snapshot = await builder.freeze(command, createInput());
  assert.equal(temporalBarrier.sealCalls, 1);
  assert.equal(seen.length > 2, true);
  assert.equal(new Set(seen).size, 1);
  assert.equal(snapshot.dataAsOf, "2026-08-16T08:00:00.000Z");
  assert.match(snapshot.snapshotHash, /^sha256:[0-9a-f]{64}$/);
});
```

Add cases for future time, `teamId=all`, cross-workspace row, sensitive cost projection, missing cash flow, incomplete ROI, input order permutation and CRM text containing prompt instructions.

- [ ] **Step 2: Prove RED.**

```bash
cd backend
node --import tsx --test --test-concurrency=1 \
  src/growth-advisor-query-test.ts \
  src/financial-council-authority-reader-test.ts \
  src/financial-council-snapshot-test.ts
```

Expected: `FinancialSnapshotBuilder` is missing and existing `getToday` seals internally instead of accepting the outer cutoff.

- [ ] **Step 3: Extract the internal sealed query without changing the public response.**

`getToday(context,query)` validates `asOf`, seals once and calls the shared private sealed loader with legacy limits. Internal `getTodayAt` calls the same loader with authority completeness probes and rejects an unissued or wrong-workspace cutoff. No path reseals, and existing public advisor responses remain byte-for-byte compatible.

- [ ] **Step 4: Implement snapshot canonicalization.**

```ts
export interface FinancialSnapshot {
  readonly snapshotId: string;
  readonly workspaceId: string;
  readonly dataAsOf: string;
  readonly currency: string;
  readonly report: NormalizedBusinessReport;
  readonly reportInputHash: `sha256:${string}`;
  readonly authority: FinancialCouncilAuthoritySnapshot;
  readonly formulaInputs: BusinessAnalysisResult;
  readonly dataGaps: readonly FinancialCouncilDataGap[];
  readonly sourceRefs: readonly FinancialCouncilSourceRef[];
  readonly snapshotHash: `sha256:${string}`;
}
```

Canonical sort keys are source kind then source ID; array order from callers never enters the hash. Untrusted strings are length-bounded data and wrapped in model prompts under an explicit untrusted-data section in Plan 2.

- [ ] **Step 5: Run regression and commit.**

```bash
npm run test:business-advisor --workspace backend
npm run test:growth-advisor --workspace backend
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-ledger-as-of-reader-test.ts \
  src/financial-ledger-as-of-mysql-reader-test.ts
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-authority-reader-test.ts \
  src/financial-council-snapshot-test.ts
npm run build --workspace backend
git diff --check
git add backend/src/growth-advisor-query.ts backend/src/growth-advisor-query-test.ts backend/src/business-advisor/domain.ts backend/src/business-advisor/domain-test.ts backend/src/financial-council-snapshot.ts backend/src/financial-council-snapshot-test.ts backend/src/financial-council-authority-reader.ts backend/src/financial-council-authority-reader-test.ts backend/src/financial-ledger-repository.ts backend/src/financial-ledger-mysql-repository.ts backend/src/financial-ledger-as-of-reader.ts backend/src/financial-ledger-as-of-reader-test.ts backend/src/financial-ledger-as-of-mysql-reader.ts backend/src/financial-ledger-as-of-mysql-reader-test.ts docs/superpowers/plans/2026-08-16-financial-council-contracts-snapshot.md
git commit -m "feat(finance): freeze council authority snapshots"
```

---

### Task 4: 创建运行服务、HTTP 路由与模块装配

**Files:**
- Create: `backend/src/financial-council-service.ts`
- Create: `backend/src/financial-council-service-test.ts`
- Create: `backend/src/financial-council-router.ts`
- Create: `backend/src/financial-council-router-test.ts`
- Create: `backend/src/growth-financial-council-module.ts`
- Create: `backend/src/growth-financial-council-module-test.ts`
- Modify: `backend/src/growth-commercial-composition.ts`
- Modify: `backend/src/growth-commercial-composition-test.ts`
- Modify: `backend/src/growth-commercial-application-test.ts`
- Modify: `backend/package.json`
- Modify: `backend/src/business-advisor/README.md`
- Modify: `backend/src/business-advisor/domain.ts`
- Modify: `backend/src/business-advisor/domain-test.ts`
- Modify: `backend/src/financial-council-repository.ts`
- Modify: `backend/src/financial-council-repository-contract-test.ts`
- Modify: `backend/src/financial-council-repository-test.ts`
- Modify: `backend/src/financial-council-mysql-repository.ts`
- Modify: `backend/src/financial-council-mysql-repository-test.ts`
- Modify: `backend/src/financial-council-snapshot.ts`
- Modify: `backend/src/financial-council-snapshot-test.ts`
- Modify: `backend/src/financial-council-domain.ts`
- Modify: `backend/src/financial-council-domain-test.ts`
- Modify: `backend/src/financial-council-authority-reader.ts`
- Modify: `backend/src/financial-council-authority-reader-test.ts`
- Modify: `backend/src/growth-capabilities.ts`
- Modify: `backend/src/growth-capabilities-test.ts`
- Modify: `backend/src/growth-bootstrap-router-test.ts`
- Modify: `backend/src/growth-openapi-test.ts`
- Modify: `backend/src/growth-openapi-response-conformance-test.ts`
- Modify: `contracts/json-schema/growth-bootstrap.v1.schema.json`
- Modify: `contracts/json-schema/financial-council.v1.schema.json`
- Modify: `contracts/openapi/growth-advisor-quote-roi.v1.yaml`
- Modify: `contracts/test/schema-registry.test.mjs`
- Modify: `contracts/test/growth-openapi.test.mjs`
- Modify: `contracts/test/growth-contract-release.test.mjs`
- Create: `contracts/releases/growth-advisor-quote-roi/1.0.8/manifest.json`
- Create: `contracts/releases/growth-advisor-quote-roi/1.0.8/openapi.json`
- Create: `contracts/releases/growth-advisor-quote-roi/1.0.9/manifest.json`
- Create: `contracts/releases/growth-advisor-quote-roi/1.0.9/openapi.json`

**Interfaces:**
- Produces `FinancialCouncilService.createRun/getRun/listEvents`.
- `createRun(command,input)` validates capability `finance.council.run`, persists run, freezes/stores snapshot, advances to `snapshot_frozen`, and enqueues an internal wake signal; it never runs models inline.
- The repository exposes one compound create-and-freeze mutation. It atomically persists the creation-key binding, run, frozen snapshot, `created` event and `snapshot_frozen` event; exact replay returns the existing frozen run and conflicts never leak a partial row.
- `FinancialSnapshotBuilder` receives the target `runId` before hashing. The persisted snapshot includes `runId`; `snapshotHash` is recomputed from the closed snapshot preimage with only the `snapshotHash` field omitted, so the service and repository share one run-bound hash meaning.
- The durable recoverable wake fact is the persisted `snapshot_frozen` run. The repository can enumerate bounded runnable runs from the existing runs table; after-commit wake delivery is advisory and an application-owned relay retries runnable runs idempotently. No fourth table is added.
- Adds `GROWTH_FINANCIAL_COUNCIL_SERVICES` after `GROWTH_ADVISOR_SERVICES` in module order.
- Router reuses standard Growth error response, workspace resolution, command idempotency and no-store headers.
- `finance.council.run` is added to the existing additive capability-registry line and the public bootstrap enum. It is granted only to `admin` and `super_admin` in a concrete active workspace; `sales` and `manager` remain denied. The Growth wire contract advances to immutable release `1.0.8`.
- Contract/runtime create-input parity fixes discovered during independent review advance the immutable Growth wire release again to `1.0.9`; release `1.0.8` remains untouched.

- [ ] **Step 1: Write route/application RED tests.**

Cover exact create replay, changed body conflict, unauthorized 403, sensitive projection, 202 shape, GET tenant isolation, invalid extra body field, snapshot failure rollback, module close and server shutdown.

- [ ] **Step 2: Prove RED.**

```bash
npm exec --workspace backend -- tsx --test --test-concurrency=1 \
  src/financial-council-service-test.ts \
  src/financial-council-router-test.ts \
  src/growth-financial-council-module-test.ts
```

Expected: missing service/router/module imports.

- [ ] **Step 3: Implement service, router and module.**

Use `financial-council:create:sha256:<64hex>` as the stable creation identity. The digest preimage is canonical `{workspaceId,ownerId,teamId,idempotencyKeyHash}`, where `idempotencyKeyHash` is the physical command-idempotency key hash. This keeps same-tenant replay stable while making the public run identity globally tenant-scoped. The module initializes schema before mounting routes and closes workers/resources in reverse order.

- [ ] **Step 4: Add focused script and run it.**

Add `test:financial-council` and `test:financial-council:mysql` to `backend/package.json`, then run:

```bash
npm run test:financial-council --workspace backend
npm run test:growth-openapi --workspace backend
npm run build --workspace backend
```

- [ ] **Step 5: Update current docs and commit.**

Update `backend/src/business-advisor/README.md` to distinguish the legacy synchronous diagnosis API from the new frozen council workflow. Then:

```bash
git add backend/src/financial-council-* backend/src/growth-financial-council-module* backend/src/growth-commercial-composition* backend/src/growth-commercial-application-test.ts backend/package.json backend/src/business-advisor/README.md
git commit -m "feat(finance): expose financial council runs"
```

---

### Task 5: P1 完整回归与独立审查

**Files:**
- Modify only if findings require it: files from Tasks 1-4
- Modify if final-review finding I4 requires it: `backend/src/authoritative-quote-reader.ts`
- Test if final-review finding I4 requires it: `backend/src/authoritative-quote-reader-test.ts`
- Modify: `docs/superpowers/specs/2026-08-16-financial-multi-agent-council-design.md`
- Modify: `docs/superpowers/plans/2026-08-16-financial-multi-agent-council-implementation-index.md`

- [x] **Step 1: Run all P1 gates fresh.**

```bash
npm run test:business-advisor --workspace backend
npm run test:financial-council --workspace backend
npm run test:growth-advisor --workspace backend
npm run test:growth-openapi --workspace backend
npm run test:contracts
npm run check:growth-contracts
npm run build
git diff --check
```

- [x] **Step 2: Run live MySQL when configured.**

```bash
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" \
  npm run test:financial-council:mysql --workspace backend
```

Expected: PASS when configured; otherwise exactly one documented conditional skip, never a fabricated live result.

- [x] **Step 3: Request independent review.**

Reviewer checks contract closure, one-cutoff identity, snapshot hash stability, sensitive projection, cross-tenant reads, transaction rollback, parser integrity, idempotent create and module shutdown.

- [x] **Step 4: Fix every Critical/Important with a new RED → GREEN cycle.**

- [x] **Step 5: Mark only P1 complete in the implementation index and commit docs.**

```bash
git add docs/superpowers/specs/2026-08-16-financial-multi-agent-council-design.md docs/superpowers/plans/2026-08-16-financial-multi-agent-council-implementation-index.md
git commit -m "docs(finance): record council snapshot verification"
```
