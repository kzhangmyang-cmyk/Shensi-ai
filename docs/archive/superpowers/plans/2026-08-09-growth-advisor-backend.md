# AI 增长参谋后端闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不建立第二套 Agent 运行时的前提下，把权威客户、报价、ROI 和数据缺口组织成可追溯的今日经营视图，让现有 Pi Copilot 生成有证据的建议，并把建议转换成受控报价草稿、报价审批任务或销售待办。

**Architecture:** 复用现有 Acquisition Copilot、模型快照、Pi 工具审计和任务恢复；新增独立的 `AdvisorRecommendation` 追加式领域、今日查询服务、受控动作分发器和 MySQL 仓储。确定性查询负责提供事实，模型只能解释事实和提出结构化建议。建议创建、采纳、忽略、完成均保存版本化事件；所有写命令使用具体 `ActiveWorkspaceContext`、`Idempotency-Key` 和 `If-Match`，所有引用在服务端验证同工作区。

**Tech Stack:** TypeScript、Express、TypeBox、Zod、OpenAPI 3.1、MySQL 8、Node test runner、现有 Acquisition Pi/Copilot 运行时。

## Global Constraints

- 本计划依赖 `2026-08-09-growth-foundation-and-authority.md`、`2026-08-09-growth-quote-decision-publication.md` 和 `2026-08-09-growth-attribution-roi-closure.md` 完成；不得自行复制工作区、报价或 ROI 领域。
- Node 版本固定为仓库要求的 `>=22.22.3 <23`，不新增智能体框架或非必要依赖。
- `workspaceId` 必须是具体工作区；`teamId="all"` 不能进入查询、建议、任务或审计记录。
- AI 不能计算权威金额、批准报价、核销财务事实、修改成本、发布 PI、发送触达或补造 ROI。
- `get_growth_performance` 只读取权威 Growth Performance；实际 ROI 只能来自已发布 Closure Snapshot。
- 建议必须引用同工作区的强类型 `metricRefs`、`evidenceRefs` 和 `entityRefs`；引用缺失、过期或跨工作区时拒绝创建。
- 不保存模型内部推理链；只保存 `summary`、可验证 `rationale`、引用、置信度、风险和受控动作。
- 所有命令使用稳定幂等键和 `If-Match`；MySQL 与内存仓储必须通过同一行为套件。
- 不修改旧 `/api/v1/acquisition/performance`、旧 `get_acquisition_performance` 或旧老板简报语义。
- 不实现自动评论、私信、加好友、群发或未经人工批准的外联。

---

### Task 1: 固化建议领域、状态机与追加式仓储

**Files:**
- Create: `backend/src/advisor-recommendation-domain.ts`
- Create: `backend/src/advisor-recommendation-repository.ts`
- Create: `backend/src/advisor-recommendation-mysql-repository.ts`
- Create: `backend/src/advisor-recommendation-expiry-sweeper.ts`
- Create: `backend/src/advisor-recommendation-domain-test.ts`
- Create: `backend/src/advisor-recommendation-repository-test.ts`
- Create: `backend/src/advisor-recommendation-mysql-repository-test.ts`
- Create: `backend/src/advisor-recommendation-expiry-sweeper-test.ts`

**Interfaces:**
- Consumes: C0's exact closed `AdvisorRecommendedAction`, `AdvisorMetricRef`, `AdvisorEvidenceRef`, and `AdvisorEntityRef` unions; the exact Foundation `GrowthTemporalBarrier`, `CommandContext`, `ActiveWorkspaceContext`, `requireExpectedRevision`, and server-owned clock; it does not redeclare transport unions, construct a local clock/HLC, or accept caller workspace/capabilities/timestamps.
- Produces: immutable `AdvisorRecommendation`, `AdvisorRecommendationEvent { recommendationId; eventRevision; eventType; recordedAt; temporalSequence; actorId; aggregateSnapshotHash; aggregateSnapshot }`, closed `AdvisorTransitionInput { recommendationId; kind; reason }`, server-owned `AdvisorTransitionMetadata { actorId; occurredAt }`, and pure `applyAdvisorTransition(current,input,metadata): AdvisorRecommendation` for the state graph in Step 3. Transport/domain input never accepts actor, workspace, capability or timestamp fields.
- Produces: `AdvisorRecommendationRepository.create/findById/listAt/listExpirable/transition` with memory/MySQL parity, generation-key uniqueness, revision CAS, strict recorded-time allocation, and historical event reduction; `listAt` accepts only the Foundation-branded `GrowthSealedReadCutoff`; repository-owned `AdvisorRecommendationTransitionTransaction`; narrow `AdvisorExpiryBlocker.hasBlockingOperation(tx: AdvisorRecommendationTransitionTransaction,workspaceId,recommendationId): Promise<boolean>`; and `AdvisorRecommendationExpirySweeper.start/sweep/close` with one active sweep and in-flight drain. The sweeper requires this port and fails closed when it cannot prove absence of a blocking action; Task 3 supplies the production action-repository implementation on the same checked-out transaction, while Task-1 tests use an explicit stub.
- Produces: `ADVISOR_RECOMMENDATION_MYSQL_SCHEMA_STATEMENTS` and `ensureAdvisorRecommendationMysqlSchema(pool)` from `advisor-recommendation-mysql-repository.ts`; the single Growth application calls this dedicated initializer in MySQL mode rather than accumulating unrelated tables in a central schema file.

`advisor-recommendation-domain-test.ts` imports the four ref/action aliases from `growth-contract-types.ts`, proves `AdvisorRecommendation` fields are exactly those aliases, and statically rejects a locally widened generic ref. The domain module may re-export the imported names for consumers, but it must not redeclare their unions.

- [ ] **Step 1: Write the failing domain and repository behavior tests.**

```ts
test("recommendation references and state transitions are closed", async () => {
  const repository = createRepository();
  const created = recommendationFixture({ workspaceId: "ws-1", status: "proposed" });
  await repository.create(command("create-1", { workspaceId: "ws-1" }), created);
  assert.equal(created.status, "proposed");

  const accepted = applyAdvisorTransition(
    created,
    { recommendationId: created.id, kind: "accept", reason: null },
    { actorId: "manager-1", occurredAt: "2026-08-09T08:01:00.000Z" }
  );
  assert.equal(accepted.status, "accepted");
  assert.throws(
    () => applyAdvisorTransition(
      accepted,
      { recommendationId: accepted.id, kind: "ignore", reason: null },
      { actorId: "manager-1", occurredAt: "2026-08-09T08:02:00.000Z" }
    ),
    hasCode("invalid_recommendation_transition")
  );
});

test("same generation key returns one recommendation and cross-workspace references fail closed", async () => {
  const repository = createRepository();
  const aggregate = recommendationFixture({
    workspaceId: "ws-1", generationIdempotencyKey: "generation-1"
  });
  const first = await repository.create(command("request-a", { workspaceId: "ws-1" }), aggregate);
  const replay = await repository.create(command("request-b", { workspaceId: "ws-1" }), aggregate);
  assert.deepEqual(replay, first);
  assert.equal(await repository.findById(context("ws-2"), aggregate.id), null);
  await assert.rejects(
    repository.create(command("request-c", { workspaceId: "ws-1" }), {
      ...aggregate, inputSnapshotHash: `sha256:${"f".repeat(64)}`
    }),
    hasCode("advisor_generation_conflict")
  );
});

test("historical list is reduced by recorded event revision", async () => {
  const repository = createRepository();
  const created = recommendationFixture({
    workspaceId: "ws-1", createdAt: "2026-08-09T08:00:00.000Z"
  });
  await repository.create(command("create-history", { workspaceId: "ws-1" }), created);
  await repository.transition(command("accept-history", {
    workspaceId: "ws-1", expectedRevision: 1
  }), {
    recommendationId: created.id, kind: "accept", reason: null
  });
  const before = await repository.listAt(context("ws-1"), {
    status: ["proposed"],
    cutoff: await foundation.temporalBarrier.sealReadCutoff(
      context("ws-1"), "2026-08-09T08:30:00.000Z"
    ),
    limit: 100, cursor: null
  });
  assert.deepEqual(before.items.map((row) => [row.id, row.status, row.revision]), [
    [created.id, "proposed", 1]
  ]);
});

test("expiry sweeper transitions each due recommendation exactly once", async () => {
  const repository = createRepository([
    recommendationFixture({ id: "due-1", expiresAt: "2026-08-09T07:59:00.000Z" })
  ]);
  const sweeper = new AdvisorRecommendationExpirySweeper({
    repository,
    now: () => Date.parse("2026-08-09T08:00:00.000Z")
  });
  await Promise.all([sweeper.sweep(), sweeper.sweep()]);
  assert.equal((await repository.findById(context("ws-1"), "due-1"))?.status, "expired");
  assert.equal(repository.eventsFor("due-1").filter((event) => event.kind === "expired").length, 1);
  await sweeper.close();
});

test("later recommendation transitions cannot backdate an old as-of when the clock rolls back", async () => {
  const repository = recommendationRepositoryFixture({ now: "2026-08-09T09:00:00.000Z" });
  const created = await repository.create(command("create-clock"), recommendationFixture({ status: "proposed" }));
  repository.setNow("2026-08-09T08:00:00.000Z");
  await repository.transition(command("accept-clock", { expectedRevision: created.value.revision }), {
    recommendationId: created.value.id, kind: "accept"
  });
  const before = await repository.listAt(context("ws-1"), {
    status: ["proposed"],
    cutoff: await foundation.temporalBarrier.sealReadCutoff(
      context("ws-1"), "2026-08-09T09:00:00.000Z"
    ),
    limit: 100, cursor: null
  });
  assert.equal(before.items[0]?.status, "proposed");
  const atBoundary = await repository.listAt(context("ws-1"), {
    status: ["accepted"],
    cutoff: await foundation.temporalBarrier.sealReadCutoff(
      context("ws-1"), "2026-08-09T09:00:00.001Z"
    ),
    limit: 100, cursor: null
  });
  assert.equal(atBoundary.items[0]?.status, "accepted");
});
```

- [ ] **Step 2: Run the tests and prove RED.**

Run:

```bash
cd backend
node --import tsx --test --test-concurrency=1 \
  src/advisor-recommendation-domain-test.ts \
  src/advisor-recommendation-repository-test.ts \
  src/advisor-recommendation-expiry-sweeper-test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `advisor-recommendation-domain.js`.

- [ ] **Step 3: Implement the closed domain and repository interfaces.**

```ts
export const ADVISOR_RECOMMENDATION_STATUSES = [
  "proposed", "accepted", "ignored", "completed", "expired"
] as const;

import type {
  AdvisorRecommendedAction,
  AdvisorMetricRef,
  AdvisorEvidenceRef,
  AdvisorEntityRef
} from "./growth-contract-types.js";

export interface AdvisorRecommendation {
  id: string;
  workspaceId: string;
  revision: number;
  audienceRole: "sales" | "manager" | "admin" | "super_admin";
  type: "priority_customer" | "quote_risk" | "roi_opportunity" | "data_gap";
  summary: string;
  rationale: string;
  metricRefs: readonly AdvisorMetricRef[];
  evidenceRefs: readonly AdvisorEvidenceRef[];
  entityRefs: readonly AdvisorEntityRef[];
  confidenceBps: number;
  riskLevel: "low" | "medium" | "high";
  recommendedAction: AdvisorRecommendedAction;
  status: typeof ADVISOR_RECOMMENDATION_STATUSES[number];
  assignedTo: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  outcomeRefs: readonly (
    | { kind: "action_receipt"; id: string }
    | { kind: "deal_outcome"; id: string }
    | { kind: "quote_version"; id: string }
  )[];
  dataAsOf: string;
  inputSnapshotHash: `sha256:${string}`;
  modelSnapshotRef: string;
  promptVersion: string;
  schemaVersion: "advisor-recommendation.v1";
  generationIdempotencyKey: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdvisorRecommendationRepository {
  create(command: CommandContext, aggregate: AdvisorRecommendation): Promise<CommandResult<AdvisorRecommendation>>;
  findById(context: ActiveWorkspaceContext, id: string): Promise<AdvisorRecommendation | null>;
  listAt(context: ActiveWorkspaceContext, query: AdvisorRecommendationListAtQuery): Promise<CursorPage<AdvisorRecommendation>>;
  listExpirable(asOf: string, limit: number): Promise<readonly AdvisorRecommendation[]>;
  transition(command: CommandContext, input: AdvisorTransitionInput): Promise<CommandResult<AdvisorRecommendation>>;
}

export interface AdvisorTransitionInput {
  recommendationId: string;
  kind: "accept" | "ignore" | "complete" | "expire";
  reason: string | null;
}

export interface AdvisorTransitionMetadata {
  actorId: string;
  occurredAt: string;
}

export interface AdvisorRecommendationListAtQuery {
  status: readonly AdvisorRecommendation["status"][];
  cutoff: GrowthSealedReadCutoff;
  limit: number;
  cursor: string | null;
}
```

Use these state transitions only:

```text
proposed -> accepted | ignored | expired
accepted -> completed | expired
ignored | completed | expired -> terminal
```

Add MySQL tables:

```text
advisor_recommendations
advisor_recommendation_events
```

HTTP/tool request idempotency is owned only by Foundation's `executeGrowthIdempotentCommand`; this domain must not create a second generic idempotency table or cache response bodies. `advisor_recommendations` has a unique business key `(workspace_id, generation_idempotency_key)` plus the frozen `input_snapshot_hash`: a matching generation replay returns the same aggregate, while the same generation key with another snapshot fails `advisor_generation_conflict`. Lock order is `generation-key reservation/unique row → recommendation row FOR UPDATE → append event → CAS revision`. Store refs and action as canonical JSON; parse every row back through the domain validator.

Every create and transition begins its transaction with `foundation.temporalBarrier.allocateAppend(tx,workspaceId)` before the generation/recommendation/event locks. Transition loads `actorId` only from the server-created `CommandContext` (or the dedicated system identity used by the expiry sweeper), uses the returned global `recordedAt` as `AdvisorTransitionMetadata.occurredAt`, and calls the pure state reducer with that metadata; caller payloads containing actor/workspace/time fields are rejected before reservation or mutation. It then appends an immutable event containing `eventRevision`, the returned global `recordedAt + temporalSequence`, server-owned transition metadata, and the canonical validated resulting aggregate snapshot. The workspace barrier lock remains held through the aggregate/event commit; event revision remains the integrity/order check, not a timestamp allocator. `listAt(context,{status,cutoff,limit,cursor})` accepts only the outer product query's already sealed token, verifies token/context workspace identity, filters concrete workspace first, reads only events with `recordedAt<=cutoff.effectiveAsOf`, chooses the largest `eventRevision` per recommendation, then applies status/cursor projection. It cannot reseal or accept a naked time. A later create/accept/ignore/complete/expire, including a brand-new recommendation under a rolled-back clock, cannot enter an already sealed Advisor Today response. Memory and MySQL repositories enforce the same invariant. `findById` and `listExpirable` may use the current operational head; historical product queries may not.

`AdvisorRecommendationExpirySweeper` reads at most 100 proposed/accepted rows whose `expiresAt <= now`, calls the injected `AdvisorExpiryBlocker` under the same recommendation lock/transaction before applying the normal revisioned `expire` transition, skips any aggregate whose blocker returns true, and fails closed on blocker availability errors. It uses `advisor-expire:<id>:<revision>` as the stable command key, isolates per-row failures, prevents overlapping sweeps and waits for an active sweep during `close()`. Task 3's production blocker reports true for `queued`, `running`, or `succeeded` action operations until their receipt/outcome is attached; all related repository methods share temporal-barrier→recommendation→operation lock order.

- [ ] **Step 4: Run memory and live-MySQL behavior tests.**

Run:

```bash
cd backend
node --import tsx --test --test-concurrency=1 \
  src/advisor-recommendation-domain-test.ts \
  src/advisor-recommendation-repository-test.ts \
  src/advisor-recommendation-mysql-repository-test.ts \
  src/advisor-recommendation-expiry-sweeper-test.ts
```

Expected: PASS, including exactly-one winner for concurrent transitions, historical sealed-cutoff reconstruction, one matching generation replay, and conflict for a changed generation snapshot. Foundation HTTP idempotency remains the only request-level reservation ledger.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/advisor-recommendation-domain.ts backend/src/advisor-recommendation-repository.ts backend/src/advisor-recommendation-mysql-repository.ts backend/src/advisor-recommendation-expiry-sweeper.ts backend/src/advisor-recommendation-domain-test.ts backend/src/advisor-recommendation-repository-test.ts backend/src/advisor-recommendation-mysql-repository-test.ts backend/src/advisor-recommendation-expiry-sweeper-test.ts
git commit -m "feat(growth): persist advisor recommendations"
```

---

### Task 2: 构建权威今日经营查询

**Files:**
- Create: `backend/src/growth-advisor-candidate-authority-projection.ts`
- Create: `backend/src/growth-advisor-candidate-authority-projection-test.ts`
- Create: `backend/src/growth-advisor-candidate-authority-mysql-repository.ts`
- Create: `backend/src/growth-advisor-candidate-authority-mysql-repository-test.ts`
- Create: `backend/src/growth-advisor-candidate-authority-backfill.ts`
- Create: `backend/src/growth-advisor-candidate-authority-backfill-test.ts`
- Create: `backend/src/migrate-growth-advisor-candidate-authority.ts`
- Create: `backend/src/growth-advisor-query.ts`
- Create: `backend/src/growth-advisor-query-test.ts`
- Create: `backend/src/growth-advisor-mysql-query.ts`
- Create: `backend/src/growth-advisor-mysql-query-test.ts`
- Modify: `backend/src/acquisition-domain-repository.ts`
- Modify: `backend/src/acquisition-domain-service.ts`
- Modify: `backend/src/acquisition-domain-test.ts`
- Modify: `backend/src/acquisition-mysql-repositories.ts`
- Modify: `backend/src/acquisition-mysql-repositories-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes: `ActiveWorkspaceContext` as the only request workspace/role/capability source; the exact C0-projected Foundation singletons `acquisitionWorkspace: GrowthAcquisitionWorkspaceResolver` and `temporalBarrier: GrowthTemporalBarrier`, token-only historical `GrowthWorkspaceSettingsReader.getAt(context,cutoff)`, and shared as-of helper; Acquisition's qualification command transaction and immutable Decision/Evidence inputs (never a mutable Candidate list API); Quote's exact token-only `GrowthQuoteAuthorityReaders.quoteApprovals`/`quoteVersions`; Finance's exact token-only `GrowthFinanceServices.verifiedAsOf`, binding-filtered `GrowthFinanceServices.financialGaps`, and `FinancialDataGapVisibilityKeys`; ROI's exact sealed Growth Performance reader plus sales-own expected reader; and `AdvisorRecommendationRepository.listAt`. The public query supplies only `{ currency, asOf }`.
- Produces: append-only `AdvisorCandidateAuthorityEvent { id; workspaceId; workspaceBindingRevision; candidateId; eventSequence; recordedAt; temporalSequence; ownerId; teamId; qualificationDecisionId; qualificationDecisionVersion; qualificationSnapshotHash; financialValueDecisionId; financialValueDecisionVersion; financialValueInputSnapshotHash; grade; score; evidence: readonly { evidenceId; contentHash; fetchedAt }[] }`, memory/MySQL repository parity, dedicated schema initializer, and one Advisor authority projection appended inside the existing B2-owned `AcquisitionDomainRepository.commitQualificationBundle` transaction. Task 2 consumes that final exact bundle interface/output and does not redeclare its signature, deterministic decision IDs, canonical input hash, raw `financial.closeProbabilityBps`, audit, or replay semantics. It extends only the implementation so the same barrier-first transaction appends one authority event after B2 allocates the persisted Qualification/FinancialValue versions and v2-repair identity; Candidate, QualificationDecision, FinancialValueDecision, authority event and replay result remain all-or-nothing. Before any write, the existing application-owned wrapper requires Candidate/evidence/drafts to share persisted `{ownerId,teamId,candidateId}`, resolves the concrete workspace only through Foundation, freezes `workspaceId + workspaceBindingRevision`, and rejects null/blank/`all`/cross-scope mappings. Produces explicit resumable `backfillGrowthAdvisorCandidateAuthority`; legacy rows get deployment-time barrier stamps and never fabricated source-time authority.
- Produces: closed `AdvisorVisibilityScope = { kind:"sales_own"; actorId:string } | { kind:"team"; teamId:string } | { kind:"workspace"; workspaceId:string }` derived only from `ActiveWorkspaceContext`; server-only `AdvisorSubjectVisibilityKeys { candidateIds:readonly string[]; customerIds:readonly string[]; dealIds:readonly string[]; cohortIds:readonly string[] }`; immutable `AdvisorVisibilitySnapshot { scope:AdvisorVisibilityScope; subjectVisibility:AdvisorSubjectVisibilityKeys; financialGapVisibility:FinancialDataGapVisibilityKeys; sourceSnapshotHash:\`sha256:${string}\` }`; and token-only `AdvisorVisibilityResolver.resolveAt(context,cutoff):Promise<AdvisorVisibilitySnapshot>`. The resolver derives bounded, sorted, deduplicated candidate/customer/Deal/cohort IDs only from the sealed candidate authority plus Quote/ROI binding authorities visible to the current association; no ID supplied by a model, ref, request body, or post-limit result can enter those sets. `financialGapVisibility` is a frozen four-field projection of the same candidate/customer/Deal/cohort authority, never a separately supplied set. Also produces token-only `PriorityCandidateReader.listAsOf(context,{cutoff:GrowthSealedReadCutoff,timeZone,limit})` and `AdvisorCandidateEvidenceAsOfReader.getAt(context,{candidateId,cutoff})`. Snapshots freeze immutable qualification/financial decision IDs, versions, hashes, owner/team, grade/score and exact evidence hashes; they never invent a mutable Candidate revision/assignee. Produces `AdvisorTodayQuery {currency;asOf}`, `AdvisorPerformancePortfolioReader.listVisible(context,{currency,cutoff,limit})`, `AdvisorRoiSliceView`, `GrowthAdvisorTodayView`, and `GrowthAdvisorQueryService.getToday(context,query)`. Sales portfolio calls ROI’s actor-scoped expected reader; team/workspace portfolio calls the sealed performance reader; all amount projection follows current capabilities.

- [ ] **Step 1: Write the failing query tests.**

```ts
test("today view combines facts without inventing missing ROI", async () => {
  const result = await query.getToday(context("ws-1", [], { role: "manager" }), {
    currency: "CNY", asOf: "2026-08-09T08:00:00.000Z"
  });
  assert.equal(result.priorityCustomers.length, 3);
  assert.equal(result.pendingQuoteApprovals[0]?.quoteVersionId, "quote-v1");
  assert.deepEqual(result.actualRoi, [{
    cohortId: "cohort-1", planId: null,
    status: "not_computable",
    reason: "cohort_not_closed"
  }]);
  assert.deepEqual(result.dataGaps.map((gap) => gap.code), ["unverified_cost"]);
  assert.equal(result.dataAsOf, "2026-08-09T08:00:00.000Z");
});

test("sensitive margins are projected by capability", async () => {
  const sales = await query.getToday(context("ws-1", ["catalog.read"]), input);
  const manager = await query.getToday(
    context("ws-1", ["catalog.read", "pricing.sensitive.read", "growth.performance.team.read"]), input
  );
  assert.equal(sales.pendingQuoteApprovals[0]?.estimatedGrossProfitMinor, undefined);
  assert.equal(manager.pendingQuoteApprovals[0]?.estimatedGrossProfitMinor, 280000);
});

test("role and timezone are server-derived and portfolio ROI is never averaged", async () => {
  const result = await query.getToday(context("ws-1", ["growth.performance.workspace.read"], { role: "admin" }), {
    currency: "CNY", asOf: "2026-08-09T08:00:00.000Z"
  });
  assert.equal(result.audienceRole, "admin");
  assert.deepEqual(result.actualRoi.map((row) => [row.cohortId, row.roiBps]), [
    ["cohort-1", 10_000], ["cohort-2", -5_000]
  ]);
  assert.equal(workspaceSettings.calls[0]?.workspaceId, "ws-1");
  assert.equal(portfolio.calls[0]?.asOf, "2026-08-09T08:00:00.000Z");
});

test("priority candidates and pending quotes are historical at dataAsOf", async () => {
  const workspace = context("ws-1", ["catalog.read"], { role: "manager" });
  const before = await query.getToday(workspace, {
    currency: "CNY", asOf: "2026-08-09T08:30:00.000Z"
  });
  await fixture.recordLaterQualificationApprovalAndFinanceEvents({
    recordedAt: "2026-08-09T09:00:00.000Z"
  });
  const replay = await query.getToday(workspace, {
    currency: "CNY", asOf: "2026-08-09T08:30:00.000Z"
  });
  assert.deepEqual(replay, before);
  assert.equal(priorityCandidateReader.calls[0]?.context, workspace);
  assert.equal(quote.quoteApprovals.calls[0]?.asOf, "2026-08-09T08:30:00.000Z");
  assert.equal(finance.financialGaps.calls[0]?.currency, "CNY");
});

test("sales sees only owned rows while manager sees team rows", async () => {
  const salesA = await query.getToday(context("ws-1", ["catalog.read"], {
    role: "sales", actorId: "sales-a", teamId: "team-1"
  }), input);
  const salesB = await query.getToday(context("ws-1", ["catalog.read"], {
    role: "sales", actorId: "sales-b", teamId: "team-1"
  }), input);
  const manager = await query.getToday(context("ws-1", [
    "catalog.read", "growth.performance.team.read"
  ], { role: "manager", actorId: "manager-1", teamId: "team-1" }), input);
  assert.deepEqual(salesA.priorityCustomers.map((row) => row.candidateId), ["candidate-sales-a"]);
  assert.deepEqual(salesB.pendingQuoteApprovals.map((row) => row.quoteVersionId), ["quote-sales-b"]);
  assert.deepEqual(salesA.dataGaps.map((row) => row.sourceId), ["gap-sales-a"]);
  assert.deepEqual(salesB.dataGaps.map((row) => row.sourceId), ["gap-sales-b"]);
  assert.deepEqual(finance.financialGaps.listCallsFor("sales-a")[0]?.visibility, {
    candidateIds: ["candidate-sales-a"], customerIds: ["customer-sales-a"],
    dealIds: ["deal-sales-a"], cohortIds: ["cohort-sales-a"]
  });
  assert.equal(manager.priorityCustomers.length, 2);
  assert.deepEqual(salesA.actualRoi, []);
});

test("candidate evidence reader verifies an arbitrary authorized ref outside the Today top list", async () => {
  const workspace = context("ws-1", ["catalog.read"]);
  const snapshot = await candidateEvidenceReader.getAt(workspace, {
    candidateId: "candidate-not-in-top-10", cutoff: await sealedCutoff(workspace, "2026-08-09T08:30:00.000Z")
  });
  assert.equal(snapshot?.qualificationDecisionId, "qualification-17");
  assert.equal(snapshot?.qualificationDecisionVersion, "qualification-v3");
  assert.match(snapshot?.qualificationSnapshotHash ?? "", /^sha256:/u);
  assert.match(snapshot?.financialValueInputSnapshotHash ?? "", /^sha256:/u);
  assert.deepEqual(snapshot?.evidence.map((row) => row.evidenceId), ["evidence-17"]);
  const otherWorkspace = context("ws-2", []);
  assert.equal(await candidateEvidenceReader.getAt(otherWorkspace, {
    candidateId: "candidate-not-in-top-10", cutoff: await sealedCutoff(otherWorkspace, "2026-08-09T08:30:00.000Z")
  }), null);
});

test("qualification authority requires one trusted concrete workspace mapping", async () => {
  const fixture = candidateAuthorityProjectionFixture();
  await fixture.commitQualificationBundle({
    ownerId: "owner-1", teamId: "team-1", candidateId: "candidate-1"
  });
  assert.deepEqual(fixture.appended[0]?.workspace, {
    workspaceId: "workspace-team-1", workspaceBindingRevision: "membership-7"
  });
  await assert.rejects(
    fixture.commitQualificationBundle({ ownerId: "owner-1", teamId: "all", candidateId: "candidate-all" }),
    /growth_workspace_required/
  );
  await assert.rejects(
    fixture.commitQualificationBundle({ ownerId: "owner-1", teamId: "team-unmapped", candidateId: "candidate-2" }),
    /growth_workspace_required/
  );
  assert.equal(fixture.domainWritesFor("candidate-all"), 0);
  assert.equal(fixture.domainWritesFor("candidate-2"), 0);
});

test("a later qualification cannot backdate or rewrite an already-read candidate cutoff", async () => {
  const repository = candidateAuthorityRepositoryFixture({ now: "2026-08-09T09:00:00.000Z" });
  await repository.append(qualificationAuthorityEventFixture({ candidateId: "candidate-1", qualificationDecisionVersion: "qualification-v1" }));
  const cutoff = await repository.seal("ws-1", "2026-08-09T09:00:00.000Z");
  const before = await repository.getAt("ws-1", "candidate-1", cutoff);
  repository.setNow("2026-08-09T08:00:00.000Z");
  await repository.append(qualificationAuthorityEventFixture({ candidateId: "candidate-1", qualificationDecisionVersion: "qualification-v2" }));
  assert.deepEqual(await repository.getAt("ws-1", "candidate-1", await repository.seal("ws-1", "2026-08-09T09:00:00.000Z")), before);
  assert.equal((await repository.getAt("ws-1", "candidate-1", await repository.seal("ws-1", "2026-08-09T09:00:00.001Z")))?.qualificationDecisionVersion, "qualification-v2");
});

test("HTTP and Pi qualification replay one B2 bundle, v2 assessment, and authority event", async () => {
  const fixture = qualificationWrapperFixture();
  await fixture.qualifyThroughHttp("candidate-1", "shared-idempotency");
  await fixture.qualifyThroughPi("candidate-1", "shared-idempotency");
  assert.deepEqual(fixture.counts(), {
    candidates: 1, qualificationDecisions: 1, financialValueDecisions: 1,
    probabilityAssessmentsV2: 1, advisorAuthorityEvents: 1
  });
});
```

- [ ] **Step 2: Run the tests and prove RED.**

Run:

```bash
cd backend
node --import tsx --test --test-concurrency=1 \
  src/growth-advisor-candidate-authority-projection-test.ts \
  src/growth-advisor-candidate-authority-mysql-repository-test.ts \
  src/growth-advisor-candidate-authority-backfill-test.ts \
  src/growth-advisor-query-test.ts \
  src/growth-advisor-mysql-query-test.ts
```

Expected: FAIL because `GrowthAdvisorQueryService` does not exist.

- [ ] **Step 3: Implement the query boundary.**

```ts
export interface GrowthAdvisorQueryService {
  getToday(
    context: ActiveWorkspaceContext,
    query: AdvisorTodayQuery
  ): Promise<GrowthAdvisorTodayView>;
}

export interface AdvisorTodayQuery {
  currency: string;
  asOf: string;
}

export interface AdvisorPerformancePortfolioReader {
  listVisible(context: ActiveWorkspaceContext, query: {
    currency: string; cutoff: GrowthSealedReadCutoff; limit: number;
  }): Promise<readonly {
    cohortId: string; planId: string | null;
    performance: GrowthPerformanceDto;
  }[]>;
}

export type AdvisorRoiSliceView =
  & { cohortId: string; planId: string | null }
  & (ExpectedRoiCurrencyView | ActualRoiCurrencyView);

export interface GrowthAdvisorTodayView {
  workspaceId: string;
  audienceRole: AdvisorRecommendation["audienceRole"];
  dataAsOf: string;
  priorityCustomers: readonly PriorityCustomerView[];
  pendingQuoteApprovals: readonly PendingQuoteApprovalView[];
  expectedRoi: readonly AdvisorRoiSliceView[];
  actualRoi: readonly AdvisorRoiSliceView[];
  dataGaps: readonly FinancialDataGapView[];
  recommendations: readonly AdvisorRecommendation[];
  sourceSnapshotHash: `sha256:${string}`;
}
```

The query must call or share the exact authoritative readers:

```ts
const effectiveAsOf = assertGrowthAsOfNotFuture(query.asOf, readStartedAt, 1_000);
const cutoff = await foundation.temporalBarrier.sealReadCutoff(context, effectiveAsOf);
const asOf = cutoff.effectiveAsOf;
const settings = await workspaceSettings.getAt(context, cutoff);
const audienceRole = advisorAudienceRoleFor(context.role);
const visibility = await advisorVisibility.resolveAt(context, cutoff);
priorityCandidateReader.listAsOf(context, { cutoff, timeZone: settings.timeZone, limit: 10 });
const approvals = await quote.quoteApprovals.listPendingAsOf(context, { cutoff, limit: 50 });
const pendingQuoteApprovals = await Promise.all(approvals.map(async (approval) => ({
  approval,
  quoteVersion: await quote.quoteVersions.getAt(context, approval.quoteVersionId, cutoff)
})));
performancePortfolio.listVisible(context, { currency, cutoff, limit: 100 });
finance.financialGaps.listForBindingsAt(context, {
  visibility: visibility.financialGapVisibility, currency, cutoff, limit: 100
});
recommendationRepository.listAt(context, { status: ["proposed", "accepted"], cutoff, limit: 100 });
```

The ordering above is normative: after sealing and reading historical settings, resolve `AdvisorVisibilitySnapshot` exactly once **before** the first priority, approval, performance, Finance, or recommendation query. Pass that same object (or its exact frozen four-field candidate/customer/Deal/cohort subset) to every selector before its `LIMIT`; tests record call order and strict object identity, and reject any implementation that resolves visibility after a bounded read.

The public query schema is closed and accepts only `currency` and `asOf`; `audienceRole`, workspace and timezone can never be supplied by the client. Capture server `readStartedAt`, call Foundation's `assertGrowthAsOfNotFuture`, then call the exact temporal singleton once; values beyond the common one-second bound return `422 invalid_as_of`, and every downstream reader receives the same branded `GrowthSealedReadCutoff` object by identity. Nested readers cannot accept a naked time or reseal. Before reading or applying `limit`, call `AdvisorVisibilityResolver.resolveAt` exactly once: `sales` receives only candidates whose immutable qualification authority event `ownerId` is itself and Quote rows whose frozen `salesOwnerActorId` is itself; `manager` receives only authority events/rows frozen to its concrete team; `admin/super_admin` receives only the selected concrete workspace (never `teamId="all"`). The resulting immutable snapshot supplies candidate/Deal/cohort keys to Finance's binding-filtered SQL before its limit, filters recommendations before hashing, and is passed unchanged to Task 3 reference verification. Model/ref/request IDs are never merged into it. Sales call ROI's `ExpectedRoiSalesOwnReader` and may see expected metrics only for their own candidate/Deal set; actual/cash are omitted, never broadened. `PriorityCandidateReader` and `AdvisorCandidateEvidenceAsOfReader` share the dedicated append-only authority reducer in `growth-advisor-query.ts`/`growth-advisor-mysql-query.ts`: both read only events with `recordedAt<=cutoff.effectiveAsOf`, validate contiguous per-candidate sequence, and return the last event by sequence. They never infer historical authority from `QualificationDecision.createdAt`, `DiscoveryEvidence.fetchedAt`, a mutable Candidate/Lead head, or a bounded Top-N scan. The authority event freezes evidence `fetchedAt` only as source metadata; its server `recordedAt` is the visibility cutoff. `qualifyCandidate` calls the new atomic bundle append; MySQL locks a per-candidate authority guard before allocating one strict recorded tick. The explicit backfill pages legacy qualification decisions in stable `(workspace,candidate,createdAt,id)` order, pairs each with its exact financial decision/evidence, allocates deployment-time authority events under the same per-candidate lock, records progress/run hashes, and is safely resumable. It never pretends legacy source timestamps were authoritative recording time; queries before migration honestly return a data gap. Pending approvals come only from `quote.quoteApprovals`; each row is joined to the exact historical `quote.quoteVersions.getAt(..., cutoff)` snapshot before projection. A missing or mismatched quote snapshot becomes a source-backed data gap rather than falling back to a mutable QuoteVersion head. `AdvisorPerformancePortfolioReader` enumerates only cohorts and plan slices visible under the caller's exact scope/capabilities, calls the authoritative B4 query for each bounded item, and preserves each slice as a separate array element. It never averages ROI BPS or sums values with different calculation hashes. `GrowthWorkspaceSettingsReader.getAt(context,cutoff)` supplies the validated historical timezone/settings event; a later settings append cannot rewrite an old Today view, and its revision/event identity joins the snapshot hash. Do not aggregate money in JavaScript `number`; retain service-provided integer minor units. `sourceSnapshotHash` is SHA-256 over canonical sorted exact refs, the exact visibility snapshot hash, priority-decision/evidence versions, approval/lifecycle revisions, settings revision, calculation hashes and `dataAsOf`, never over rendered text or the token's audit-only temporal sequence. Tests must assert exactly one seal call/token identity, future `asOf` failure, historical stability, more than 100 other-owner gaps not hiding the caller's row, two sales users not seeing each other's rows, and exact Quote/Finance/ROI private-reader identity.

In that paragraph, any shortened mention of candidate/Deal/cohort visibility means the exact four-field candidate/customer/Deal/cohort set; customer authority is never omitted or inferred from a matching candidate alone.

`AdvisorPerformancePortfolioReader.listVisible` validates `context.workspaceId===cutoff.workspaceId`, forwards that exact token object to every B4 sealed reader, and performs zero seal calls. Its tests reject a cross-workspace token and prove a later append cannot change a replay using the same old cutoff; a counting fixture asserts object identity across every selected slice.

In the query pseudocode and prose above, `asOf` means the Foundation helper's returned effective cutoff, never the raw client value. A tolerated positive skew is clamped to `readStartedAt`; all readers, snapshot hashes, and `dataAsOf` receive that one value, so an append between readers cannot enter only part of the snapshot.

The qualification transaction and backfill both obtain `workspaceId` exclusively from `foundation.acquisitionWorkspace.resolve({ownerId,teamId})` before opening the domain transaction. They require the returned binding revision, freeze it into the authority event, and then re-check that the generated Decision, FinancialValueDecision, Candidate, and every referenced evidence row belong to the same owner/team/candidate tuple under the lock. Null, `all`, a personal binding for another owner, or any tuple mismatch returns `growth_workspace_required`/`growth_workspace_mismatch` with zero decision, financial, authority-event, or backfill-cursor writes. `qualifyCandidate` may perform model/rule calculation outside the database transaction, but it passes only versionless drafts to `commitQualificationBundle`; the repository takes the workspace temporal barrier as its **first** transaction lock, then locks the per-candidate guard before reading previous Qualification/FinancialValue versions and holds both through all three inserts. Backfill uses the same guarded/global allocation rather than preassigning versions. Runtime and migration tests inject the exact C0-projected Foundation resolver/barrier by identity and prove no local mapper or HLC is constructed.

Add `"migrate:growth-advisor-candidate-authority": "tsx src/migrate-growth-advisor-candidate-authority.ts"` only after the CLI/backfill tests exist. The CLI requires the production MySQL URL, initializes only its dedicated projection schema, resumes by immutable run/cursor, prints a count/hash summary without candidate content, and closes the pool.

- [ ] **Step 4: Run focused tests.**

Run:

```bash
cd backend
node --import tsx --test --test-concurrency=1 \
  src/growth-advisor-candidate-authority-projection-test.ts \
  src/growth-advisor-candidate-authority-mysql-repository-test.ts \
  src/growth-advisor-candidate-authority-backfill-test.ts \
  src/growth-advisor-query-test.ts \
  src/growth-advisor-mysql-query-test.ts
```

Expected: PASS with no cross-workspace rows, no unclosed actual ROI and no hidden sensitive values.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/growth-advisor-candidate-authority-projection.ts backend/src/growth-advisor-candidate-authority-projection-test.ts backend/src/growth-advisor-candidate-authority-mysql-repository.ts backend/src/growth-advisor-candidate-authority-mysql-repository-test.ts backend/src/growth-advisor-candidate-authority-backfill.ts backend/src/growth-advisor-candidate-authority-backfill-test.ts backend/src/migrate-growth-advisor-candidate-authority.ts backend/src/growth-advisor-query.ts backend/src/growth-advisor-query-test.ts backend/src/growth-advisor-mysql-query.ts backend/src/growth-advisor-mysql-query-test.ts backend/src/acquisition-domain-repository.ts backend/src/acquisition-domain-service.ts backend/src/acquisition-domain-test.ts backend/src/acquisition-mysql-repositories.ts backend/src/acquisition-mysql-repositories-test.ts backend/src/acquisition-application.ts backend/src/acquisition-application-test.ts backend/package.json
git commit -m "feat(growth): query advisor operating facts"
```

---

### Task 3: 实现建议创建、引用校验与受控动作分发

**Files:**
- Create: `backend/src/advisor-recommendation-service.ts`
- Create: `backend/src/advisor-recommendation-service-test.ts`
- Create: `backend/src/advisor-action-operation.ts`
- Create: `backend/src/advisor-action-operation-test.ts`
- Create: `backend/src/advisor-action-operation-repository.ts`
- Create: `backend/src/advisor-action-operation-mysql-repository.ts`
- Create: `backend/src/advisor-action-operation-repository-test.ts`
- Create: `backend/src/advisor-action-operation-mysql-repository-test.ts`
- Create: `backend/src/advisor-action-recovery-sweeper.ts`
- Create: `backend/src/advisor-action-recovery-sweeper-test.ts`
- Create: `backend/src/advisor-action-dispatcher.ts`
- Create: `backend/src/advisor-action-dispatcher-test.ts`

**Interfaces:**
- Consumes: Task 1's `AdvisorRecommendation`, `AdvisorRecommendationRepository`, typed ref/action unions and transition fence; Task 2's exact token-only `AdvisorCandidateEvidenceAsOfReader`, `AdvisorVisibilityResolver`, and immutable `AdvisorVisibilitySnapshot`; Foundation's exact temporal barrier and request idempotency helper; Quote's token-only authority readers; Finance's exact `VerifiedFinancialLedgerSealedReader.getVerifiedAt(cutoff,input)` and `FinancialDataGapSealedReader.verifyAt(context,{visibility,...,cutoff})`; ROI's sealed performance/closure evidence readers; the current workspace/association authority; and C0's singleton `GrowthCommercialToolPorts.execute(call,childCommand)`. C0's registry is dispatch only; domain handlers bind `stableCallHash` to authoritative business idempotency/read-back.
- Produces: `AdvisorReferenceVerifier.verify(context,refs,cutoff,visibility): Promise<VerifiedAdvisorReferenceSnapshot>` and closed `verifyAdvisorActionBinding`; `AdvisorRecommendationAuthorizer.assertCanCreate/assertCanTransition`; `AdvisorRecommendationService.create`, `.accept`, `.ignore`, and `.complete(command,recommendationId)` (no caller outcome refs); deterministic `stableAdvisorActionHash`; durable `AdvisorActionOperation`/`AdvisorActionReceipt`; `AdvisorActionOperationRepository` implementing Task 1's expiry blocker; `AdvisorActionRecoveryAuthorizer`; `AdvisorActionRecoverySweeper`; and `AdvisorActionDispatcher.dispatch(command,recommendationId)`. Completion resolves and validates the exact server-side receipt belonging to the recommendation/revision/stable action hash; the dispatcher accepts no caller replacement action.

- [ ] **Step 1: Write failing reference and action tests.**

```ts
test("creation freezes verified references and model snapshot", async () => {
  const created = await service.create(command("recommend-1", { workspaceId: "ws-1" }), {
    ...validRecommendationInput(),
    metricRefs: [{
      kind: "growth_performance", cohortId: "cohort-1", currency: "CNY",
      asOf: "2026-08-09T08:00:00.000Z", planId: null,
      closureVersionId: "closure-1", sliceKey: "all",
      calculationHash: `sha256:${"a".repeat(64)}`
    }],
    entityRefs: [{
      kind: "quote_version", id: "quote-v1", lifecycleRevision: 4,
      commercialAmountHash: `sha256:${"b".repeat(64)}`
    }]
  });
  assert.equal(created.inputSnapshotHash, expectedSnapshotHash);
  assert.equal(created.modelSnapshotRef, "model-snapshot-7");
  assert.equal(created.status, "proposed");
});

test("every closed ref branch is verified by its exact as-of port", async () => {
  const workspace = context("ws-1");
  const cutoff = await foundation.temporalBarrier.sealReadCutoff(
    workspace, "2026-08-09T08:00:00.000Z"
  );
  const visibility = await advisorVisibility.resolveAt(workspace, cutoff);
  await verifier.verify(workspace, allClosedReferenceBranchesFixture(), cutoff, visibility);
  assert.equal(candidateEvidenceReader.calls.length > 0, true);
  assert.equal(quote.quotePreviews.calls.length > 0, true);
  assert.equal(quote.quoteVersions.calls.length > 0, true);
  assert.equal(finance.verifiedAsOf.calls.length > 0, true);
  assert.equal(roi.growthPerformance.calls.length > 0, true);
  for (const mutated of eachReferenceWithOneWrongHashOrVersion()) {
    await assert.rejects(
      verifier.verify(workspace, mutated.refs, cutoff, visibility),
      hasCode("advisor_reference_invalid")
    );
  }
});

test("reference verification is not limited by Today list pagination", async () => {
  const gap = financialGapReferenceFixture({ sourceId: "gap-source-101" });
  const workspace = context("ws-1");
  const cutoff = await foundation.temporalBarrier.sealReadCutoff(
    workspace, "2026-08-09T08:00:00.000Z"
  );
  const visibility = await advisorVisibility.resolveAt(workspace, cutoff);
  await verifier.verify(workspace, { metricRefs: [gap], evidenceRefs: [], entityRefs: [] }, cutoff, visibility);
  assert.equal(finance.financialGaps.listCalls.length, 0);
  assert.equal(finance.financialGaps.verifyCalls[0]?.sourceId, "gap-source-101");
  assert.equal(finance.financialGaps.verifyCalls[0]?.visibility, visibility.financialGapVisibility);
});

test("a sales recommendation cannot verify another sales actor's exact gap source", async () => {
  const salesA = command("gap-cross-sales", {
    workspaceId: "ws-1", actorId: "sales-a", role: "sales"
  });
  await assert.rejects(
    service.create(salesA, validRecommendationInput({
      metricRefs: [financialGapReferenceFixture({
        sourceId: "gap-source-sales-b", candidateId: "candidate-sales-b"
      })]
    })),
    hasCode("advisor_reference_invalid")
  );
  assert.deepEqual(finance.financialGaps.verifyCalls[0]?.visibility, {
    candidateIds: ["candidate-sales-a"], customerIds: ["customer-sales-a"],
    dealIds: ["deal-sales-a"], cohortIds: ["cohort-sales-a"]
  });
  assert.equal(repository.size, 0);
});

test("exact same-workspace refs still fail when their frozen subject belongs to another sales actor", async () => {
  const salesA = command("subject-cross-sales", {
    workspaceId: "ws-1", actorId: "sales-a", role: "sales"
  });
  for (const fixture of sameWorkspaceSalesBExactReferenceFixtures([
    "candidate_evidence", "quote_preview", "quote_version",
    "customer", "deal", "ledger_entry", "growth_performance", "closure_version"
  ])) {
    await assert.rejects(
      service.create(salesA, validRecommendationInput(fixture.refs)),
      hasCode("advisor_reference_invalid")
    );
  }
  assert.equal(repository.size, 0);
  assert.equal(finance.verifiedAsOf.calls.some((call) =>
    call.result?.candidateId === "candidate-sales-b"), true);
});

test("deal refs verify the exact current or terminal Quote authority revision", async () => {
  const workspace = context("ws-1");
  for (const authority of [
    { state: "approved", revision: 4 },
    { state: "won", revision: 5 },
    { state: "lost", revision: 6 }
  ] as const) {
    const refs = dealReferenceFixture({ quoteVersionId: "quote-v1", dealAuthorityRevision: authority.revision });
    const cutoff = await fixture.cutoffFor(authority.state);
    const visibility = await advisorVisibility.resolveAt(workspace, cutoff);
    await verifier.verify(workspace, refs, cutoff, visibility);
    await assert.rejects(
      verifier.verify(workspace, {
        ...refs,
        entityRefs: refs.entityRefs.map((ref) => ref.kind === "deal"
          ? { ...ref, dealAuthorityRevision: ref.dealAuthorityRevision === null ? 1 : ref.dealAuthorityRevision + 1 }
          : ref)
      }, cutoff, visibility),
      hasCode("advisor_reference_invalid")
    );
  }
  const terminalCutoff = await fixture.cutoffFor("won");
  await assert.rejects(
    verifier.verify(
      workspace,
      dealReferenceFixture({ dealAuthorityRevision: null }),
      terminalCutoff,
      await advisorVisibility.resolveAt(workspace, terminalCutoff)
    ),
    hasCode("advisor_reference_invalid")
  );
});

test("every embedded asOf must equal the one recommendation cutoff", async () => {
  for (const refAsOf of ["2026-08-09T07:59:59.999Z", "2026-08-09T08:00:00.001Z"]) {
    await assert.rejects(
      service.create(command(`mixed-asof-${refAsOf}`), validRecommendationInput({
        dataAsOf: "2026-08-09T08:00:00.000Z",
        metricRefs: [growthPerformanceRefFixture({ asOf: refAsOf })]
      })),
      hasCode("advisor_reference_invalid")
    );
  }
  assert.equal(repository.size, 0);
});

test("all six actions require a strong verified ref to the exact target", async () => {
  for (const fixture of allAdvisorActionBindingFixtures()) {
    await service.create(command(`binding-ok-${fixture.kind}`), fixture.valid);
    await assert.rejects(
      service.create(command(`binding-swapped-${fixture.kind}`), fixture.sameWorkspaceSwappedTarget),
      hasCode("advisor_action_reference_mismatch")
    );
  }
  assert.equal(repository.countByInputKind("sameWorkspaceSwappedTarget"), 0);
});

test("accept does not execute an unapproved or unsupported action", async () => {
  const accepted = await service.accept(command("accept", { workspaceId: "ws-1", expectedRevision: 1 }), recommendationId);
  assert.equal(accepted.status, "accepted");
  assert.equal(actionPorts.quotePublisherCalls.length, 0);
  assert.equal(actionPorts.receipts.length, 0);
});

test("sales cannot transition or dispatch another sales owner's recommendation", async () => {
  const stored = recommendationFixture({ id: "recommendation-sales-a", assignedTo: "sales-a", status: "proposed", revision: 1 });
  repository.seed(stored);
  await assert.rejects(
    service.accept(command("cross-sales", { workspaceId: "ws-1", actorId: "sales-b", role: "sales", expectedRevision: 1 }), stored.id),
    hasCode("advisor_recommendation_forbidden")
  );
  assert.equal(actionOperations.countFor(stored.id), 0);
  assert.equal(repository.eventsFor(stored.id).length, 0);
});

test("complete accepts no caller outcome refs and attaches only its exact persisted receipt", async () => {
  const stored = recommendationFixture({ id: "recommendation-complete", assignedTo: "sales-a", status: "accepted", revision: 2 });
  repository.seed(stored);
  const receipt = actionReceiptFixture({ recommendationId: stored.id, recommendationRevision: 2, stableActionHash: stableAdvisorActionHash(stored) });
  actionOperations.seedSucceeded(stored, receipt);
  const completed = await service.complete(command("complete", { workspaceId: "ws-1", actorId: "sales-a", role: "sales", expectedRevision: 2 }), stored.id);
  assert.deepEqual(completed.outcomeRefs, [{ kind: "action_receipt", id: receipt.id }]);
  await assert.rejects(() => service.complete(command("fake", { workspaceId: "ws-1", actorId: "sales-a", role: "sales", expectedRevision: 2 }), stored.id, [{ kind: "action_receipt", id: "other" }] as never), /schema_validation_failed|too_many_arguments/);
});

test("dispatcher loads the accepted frozen action and cannot accept a caller replacement", async () => {
  const stored = recommendationFixture({
    id: "recommendation-1", status: "accepted", revision: 2,
    recommendedAction: { kind: "create_quote_approval_task", quoteVersionId: "quote-v1", quoteVersionRevision: 4 }
  });
  repository.seed(stored);
  const receipt = await dispatcher.dispatch(command("dispatch-1", {
    workspaceId: "ws-1", expectedRevision: 2
  }), stored.id);
  assert.equal(receipt.actionKind, "create_quote_approval_task");
  assert.equal(toolCalls[0]?.name, "create_quote_approval_task");
  assert.equal(toolCommands[0]?.expectedRevision, 4);
  assert.deepEqual(toolCalls[0]?.input, {
    quoteVersionId: "quote-v1"
  });
  assert.equal(toolCalls[0]?.stableCallHash, stableAdvisorActionHash(stored));
});

test("post-side-effect ACK loss is repaired after capability revocation without repeating the action", async () => {
  const stored = recommendationFixture({
    id: "recommendation-ack", status: "accepted", revision: 2,
    recommendedAction: { kind: "create_sales_todo", customerId: "customer-1", dueAt: "2026-08-10T08:00:00.000Z" }
  });
  repository.seed(stored);
  actionHandlers.commitResourceThenThrowBeforeAdvisorReceiptOnce = true;
  await assert.rejects(
    dispatcher.dispatch(command("dispatch-ack", { workspaceId: "ws-1", expectedRevision: 2 }), stored.id),
    /simulated_ack_loss/
  );
  capabilities.revoke("sales-a", "todo.create");
  await recovery.sweep();
  const operation = await actionOperations.findByStableHash(
    context("ws-1"), stableAdvisorActionHash(stored)
  );
  assert.equal(operation?.status, "succeeded");
  assert.equal(actionHandlers.executeCalls.length, 1);
  assert.equal(actionHandlers.probeCalls.length, 1);
  assert.equal(domainBusinessResources.createdForStableActionHash(stableAdvisorActionHash(stored)), 1);
  assert.equal(actionOperations.receiptsFor(operation!.id).length, 1);
});

test("revocation before a side effect creates no resource or receipt", async () => {
  const stored = recommendationFixture({
    id: "recommendation-revoked", status: "accepted", revision: 2,
    recommendedAction: { kind: "create_sales_todo", customerId: "customer-1", dueAt: "2026-08-10T08:00:00.000Z" }
  });
  repository.seed(stored);
  await actionOperations.enqueue(command("enqueue-revoked"), frozenActionInput(stored));
  capabilities.revoke("sales-a", "todo.create");
  await recovery.sweep();
  const operation = await actionOperations.findByStableHash(
    context("ws-1"), stableAdvisorActionHash(stored)
  );
  assert.equal(operation?.status, "failed");
  assert.equal(operation?.lastErrorCode, "advisor_action_authorization_revoked");
  assert.equal(actionHandlers.executeCalls.length, 0);
  assert.equal(domainBusinessResources.createdForStableActionHash(stableAdvisorActionHash(stored)), 0);
  assert.equal(actionOperations.receiptsFor(operation!.id).length, 0);
});

test("expired or stale action workers cannot persist receipts", async () => {
  const claimed = await actionOperations.claimQueued("operation-1", {
    leaseOwner: "worker-a", leaseDurationMs: 1_000,
    now: "2026-08-09T08:00:00.000Z"
  });
  clock.set("2026-08-09T08:00:01.001Z");
  await assert.rejects(
    actionOperations.complete(claimed, actionReceiptFixture(), clock.now()),
    hasCode("stale_advisor_action_fence")
  );
  assert.equal(actionOperations.receiptsFor("operation-1").length, 0);
});
```

- [ ] **Step 2: Run the tests and prove RED.**

Run:

```bash
cd backend
node --import tsx --test --test-concurrency=1 \
  src/advisor-recommendation-service-test.ts \
  src/advisor-action-operation-test.ts \
  src/advisor-action-operation-repository-test.ts \
  src/advisor-action-operation-mysql-repository-test.ts \
  src/advisor-action-recovery-sweeper-test.ts \
  src/advisor-action-dispatcher-test.ts
```

Expected: FAIL because service, durable action operation/receipt, recovery, and dispatcher modules do not exist.

- [ ] **Step 3: Implement strict reference verification and the allowlisted dispatcher.**

```ts
export interface AdvisorReferenceVerifier {
  verify(
    context: ActiveWorkspaceContext,
    refs: AdvisorReferenceSet,
    cutoff: GrowthSealedReadCutoff,
    visibility: AdvisorVisibilitySnapshot
  ): Promise<VerifiedAdvisorReferenceSnapshot>;
}

export interface AdvisorActionDispatcher {
  dispatch(
    command: CommandContext,
    recommendationId: string
  ): Promise<AdvisorActionReceipt>;
}

export interface AdvisorActionOperation {
  id: string;
  workspaceId: string;
  recommendationId: string;
  recommendationRevision: number;
  requestingActorId: string;
  stableActionHash: `sha256:${string}`;
  frozenAction: AdvisorRecommendedAction;
  status: "queued" | "running" | "succeeded" | "failed";
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  attempts: number;
  receiptId: string | null;
  retryable: boolean;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdvisorActionReceipt {
  id: string;
  operationId: string;
  workspaceId: string;
  recommendationId: string;
  recommendationRevision: number;
  stableActionHash: `sha256:${string}`;
  actionKind: AdvisorRecommendedAction["kind"];
  resourceRefs: readonly (
    | { kind: "quote_version"; id: string }
    | { kind: "quote_approval_task"; id: string }
    | { kind: "sales_todo"; id: string }
    | { kind: "navigation"; id: string }
  )[];
  contentHash: `sha256:${string}`;
  createdAt: string;
}

export interface AdvisorActionOperationRepository {
  enqueue(command: CommandContext, input: FrozenAdvisorActionInput): Promise<AdvisorActionOperation>;
  findByStableHash(context: ActiveWorkspaceContext, stableActionHash: `sha256:${string}`): Promise<AdvisorActionOperation | null>;
  claim(operationId: string, input: { leaseOwner: string; leaseDurationMs: number; now: string }): Promise<AdvisorActionClaim | null>;
  renew(claim: AdvisorActionClaim, now: string, leaseDurationMs: number): Promise<AdvisorActionClaim>;
  complete(claim: AdvisorActionClaim, receipt: AdvisorActionReceipt, now: string): Promise<AdvisorActionOperation>;
  fail(claim: AdvisorActionClaim, error: AdvisorActionFailure, now: string): Promise<AdvisorActionOperation>;
  listRecoverable(asOf: string, limit: number): Promise<readonly AdvisorActionOperation[]>;
}

export interface AdvisorActionRecoveryAuthorizer {
  authorizeProbe(operation: AdvisorActionOperation): Promise<ActiveWorkspaceContext>;
  authorizeExecution(operation: AdvisorActionOperation): Promise<CommandContext>;
}

export interface AdvisorStableActionHandler {
  probeByStableActionHash(
    context: ActiveWorkspaceContext,
    operation: AdvisorActionOperation
  ): Promise<AdvisorActionReceipt | null>;
  execute(command: CommandContext, operation: AdvisorActionOperation): Promise<AdvisorActionReceipt>;
}
```

Map only these commands:

```text
open_candidate              -> navigation receipt only, no backend mutation
create_quote_draft          -> toolPorts.execute({ name:"create_quote_draft", input:{ quoteCaseId, quoteInput, previewIdentity }, stableCallHash }, quote child CommandContext)
create_quote_approval_task  -> toolPorts.execute({ name:"create_quote_approval_task", input:{ quoteVersionId }, stableCallHash }, quote child CommandContext)
create_sales_todo           -> advisor-owned capability-checked todo handler
complete_cost_data          -> finance import navigation/task receipt, no ledger write
complete_financial_fact     -> finance import navigation/task receipt, no ledger write
```

`AdvisorReferenceVerifier` dispatches every closed ref branch to an exact authority port and imports the C0-owned `GrowthRoiSliceKey = "all" | \`plan:${string}\`` plus C0-owned `FinancialDataGapCode`; it does not redeclare wider strings. It first requires matching workspace/cutoff/visibility identities and validates the immutable visibility snapshot hash; callers cannot assemble or widen it. Priority-score and candidate-evidence refs use Task 2's ID-addressable `AdvisorCandidateEvidenceAsOfReader`, matching immutable qualification decision ID/version/snapshot hash and evidence ID/content hash at `cutoff.effectiveAsOf` rather than scanning a Top-N list. Quote-preview refs call Quote's `QuotePreviewEvidenceReader.verifyAt` with exact case ID, preview identity, input snapshot hash, calculation hash and the same `cutoff`; Quote-version refs match exact `quoteVersionId + lifecycleRevision + commercialAmountHash`. Customer/deal refs are self-locating: each carries `quoteVersionId`, calls `quote.quoteVersions.getAt(context,quoteVersionId,cutoff)`, and reads only that version's `commercialBindingEvidence`. Customer requires `customerId===ref.id` and exact frozen `handoffContentHash + bindingHashSchemaVersion`. Deal first requires `dealId===ref.id` and exact frozen `dealContentHash + bindingHashSchemaVersion`, then calls `quote.dealAuthoritativeQuotes.getAt(context,dealId,cutoff)`; if the current pointer is cleared it calls `getDecisionAt(context,dealId,cutoff)`. A current or won/lost authority must match Deal ID, QuoteVersion ID, commercial amount hash and exact `dealAuthorityRevision`; supplying null when an authority event exists, supplying a fabricated revision, or swapping current/terminal versions is invalid. Null is permitted only when both authority readers prove no authority event exists at the cutoff and the immutable QuoteVersion binding itself still matches. Growth Performance refs call ROI's token-only performance reader; ROI-snapshot and Closure refs call `RoiClosureEvidenceSealedReader.getAt(context,{closureVersionId,sliceKey,cutoff})` and exact-match version/slice/calculation hash. Ledger refs carry `ledgerType + ledgerEntryId + currency` and call `finance.verifiedAsOf.getVerifiedAt(cutoff,{ledgerType,entryId:ledgerEntryId,currency})`, then match verification event/revision/evidence hash; cost/fact IDs are never guessed or searched across two stores. Financial-gap refs call the exact indexed `finance.financialGaps.verifyAt(context,{visibility:visibility.financialGapVisibility,sourceType,sourceId,gapCode,currency,sourceSnapshotHash,cohortId,cutoff})`; the authorized key sets are server-derived before model output and before any list limit, and the Top-100 Today list/public as-of wrapper are never verification ports. `candidate`, `quote_case`, and `cohort` are intentionally absent from the closed entity union because none owns an append-only as-of entity-head reader; the immutable decision/evidence, quote preview/version, and growth-performance/closure refs carry the supported authority instead. The verifier rejects a mutable head that merely shares an ID, a same-workspace gap outside the frozen sales/team binding set, any cross-workspace ref, an unknown gap code/source, any unsupported ref kind, or any row recorded after `cutoff.effectiveAsOf`.

Exact authority is necessary but not sufficient: after every lookup, the verifier applies the same immutable `visibility.subjectVisibility` membership gate before accepting the ref. Candidate/priority evidence requires its candidate ID. Quote preview requires the returned frozen `salesOwnerActorId` to match a `sales_own` scope (or an eligible member of the concrete manager team) and every non-null returned `subjectEvidence` ID to be present in the corresponding candidate/customer/Deal set, with at least one non-null subject. Quote-version, customer, and Deal refs require the returned version's frozen sales owner plus all three CommercialBindingEvidence subject IDs to match those sets. Ledger rows require at least one non-null candidate/customer/Deal binding and require **every** non-null binding to be a member of the corresponding set; an unbound row is not valid Advisor evidence. Growth-performance/ROI/Closure evidence requires the returned cohort ID in the visible cohort set and its plan slice to be authorized by the same portfolio scope. Financial-gap verification additionally enforces Finance's exact four-field subset input and post-validates that every non-null returned candidate/customer/Deal/cohort binding belongs to the same `subjectVisibility`; mixed `candidateId=mine` plus `customerId|dealId|cohortId=otherSales`, and a customer-only other-sales row, are invalid even if their hash and one binding match. These checks happen before `VerifiedAdvisorReferenceSnapshot` is built, and that snapshot freezes `visibility.sourceSnapshotHash`; a valid same-workspace hash owned only by another sales actor or team is therefore `advisor_reference_invalid`, not a verified ref. The cross-sales negative suite includes customer-only and every mixed mine/other binding for both ledger and financial-gap refs and requires zero recommendation/action writes.

For `candidate_evidence`, the verifier requires the C0 self-locating tuple `candidateId + qualificationDecisionId + qualificationDecisionVersion + inputSnapshotHash + evidenceId + contentHash`, performs one candidate-keyed historical lookup, and matches every field. A bare evidence ID/hash, a correct evidence attached to another qualification snapshot, or a cross-workspace candidate fails without scanning candidates or the Today page. `AdvisorRecommendationService.create` is the single recommendation-generation historical boundary: it captures server `readStartedAt`, applies the common future bound/clamp to the requested `dataAsOf`, seals exactly once, calls Task 2's `AdvisorVisibilityResolver.resolveAt(context,cutoff)` before interpreting any model reference, and passes the same branded token plus immutable visibility snapshot by identity to the verifier and every nested authority reader. Before invoking any authority reader, it requires every ref branch carrying `asOf` to equal `cutoff.effectiveAsOf` byte-for-byte; an earlier/later ref is invalid even when its current authority hash happens to match. The input snapshot freezes `visibility.sourceSnapshotHash`, and the persisted `dataAsOf` uses only `cutoff.effectiveAsOf`, never the token's audit sequence.

`verifyAdvisorActionBinding` runs after reference verification and before any recommendation write. It uses only the verified snapshot: `open_candidate` requires priority/candidate-evidence authority for that candidate; `create_quote_draft` requires the exact Quote preview Case/identity plus the Case revision; `create_quote_approval_task` requires the exact QuoteVersion ID/revision; `create_sales_todo` requires the exact customer entity; `complete_cost_data` requires a gap/performance ref for the exact cohort; and `complete_financial_fact` requires the exact Deal entity or source-backed gap for that Deal. At least one strong ref must bind every target, same-workspace swapped IDs fail `advisor_action_reference_mismatch` with zero writes, and the canonical verified binding snapshot is included in both recommendation `inputSnapshotHash` and `stableAdvisorActionHash`.

`AdvisorRecommendationAuthorizer` is the only create/transition/dispatch visibility gate and always re-evaluates the current `ActiveWorkspaceContext`, including HTTP/Pi replay and worker recovery. On create, `assignedTo` is resolved through the trusted workspace-member directory: sales can assign only themselves; a manager can assign only an eligible sales association in the same concrete team; admin/super-admin can assign only an eligible member of the selected concrete workspace. On accept/ignore/complete/dispatch, sales must still be the frozen `assignedTo` and own the verified target; manager must still be in the frozen concrete team; admin/super-admin must still be in the selected workspace. Unknown, cross-workspace, `teamId="all"`, reassigned, or capability-revoked actors fail `advisor_recommendation_forbidden` before operation/event/receipt writes. Replay reauthorizes before projecting the stored result.

Accepting a recommendation changes only recommendation state. The dispatcher receives only a `CommandContext` plus recommendation ID, calls `requireExpectedRevision(command)`, reloads and authorizes the accepted aggregate under `command.workspace`, and freezes the persisted `recommendedAction`, verified binding snapshot, recommendation revision, requesting actor/workspace, and `stableActionHash` into one durable operation. Callers cannot provide or replace the action or whole recommendation. The MySQL repository owns `advisor_action_operations` plus append-only `advisor_action_receipts`; unique `(workspace_id, recommendation_id, recommendation_revision, stable_action_hash)` guarantees one business operation. Operation states are `queued | running | succeeded | failed`; claim/renew/complete/fail require `running + lease_owner + fencing_token + lease_expires_at>now`, and a receipt row is unique by both `operation_id` and `stable_action_hash`.

All recommendation/action writes follow one lock order: workspace temporal barrier first, then recommendation row, then action-operation row/receipt stream. Enqueue, fenced receipt persistence and outcome attachment use barrier-issued `recordedAt + temporalSequence` and hold the global row through commit. Expiry follows the same order and may transition an accepted recommendation only when no action operation exists in `queued`, `running`, or `succeeded` state; it skips/defer-retries any such aggregate, including succeeded-with-receipt-not-yet-attached. Thus a post-side-effect crash cannot let expiry make recovery authorization impossible. Dispatcher/recovery attaches the receipt/outcome under the same recommendation→operation lock order; terminal replay never duplicates the domain side effect. Two-connection tests race expiry against enqueue and against post-side-effect/pre-receipt recovery, plus receipt attachment against completion, and require one convergent non-orphan outcome.

Quote actions reuse the Quote-owned exact tool handlers. For each quote action the worker removes the frozen quote aggregate revision from the tool domain input, creates a child `CommandContext` whose `expectedRevision` is exactly that removed revision and whose request/idempotency identity contains the same stable hash, and calls `toolPorts.execute({ name, input, stableCallHash }, childCommand)`. The draft input is exactly `{ quoteCaseId, quoteInput, previewIdentity }`; the approval-task input is exactly `{ quoteVersionId }`. No second revision remains in `GrowthCommercialToolCall.input`, and it never invokes nonexistent domain shortcuts. Tests capture both arguments and prove the full call object/hash is derived from the stored action, not caller data.

The C0 tool registry does not own or promise a result ledger. Each Advisor-dispatchable handler instead uses `stableCallHash` as a domain business idempotency key and exposes the exact `probeByStableActionHash` port above: Quote draft/approval-task probes their domain uniqueness records; sales Todo probes unique `(workspace_id,stable_action_hash)`; navigation actions probe their receipt-only record. A claimed worker always performs the workspace/target-safe probe first. If the authoritative resource already exists, recovery constructs only the missing internal Advisor receipt/outcome under a system repair context, even when the requesting actor has since lost the mutation capability; it never re-executes the mutation or projects sensitive data to that actor. Only when the probe returns null does `authorizeExecution` reload the current concrete workspace/actor/capabilities, verify the recommendation is still accepted at the frozen revision, build a server-derived `CommandContext`, and call `execute`. Revocation before the side effect therefore produces terminal `advisor_action_authorization_revoked` with zero mutation/receipt, while commit-before-Advisor-receipt plus later revocation converges to exactly one resource and one internal receipt. The dispatcher persists that receipt in a fenced transaction before appending the recommendation outcome reference. It must not add a second generic tool-result ledger. `AdvisorActionRecoverySweeper` CAS-reclaims queued/expired-running work with a higher fence, prevents overlapping sweeps, isolates failures, heartbeats while a handler is active, and waits for in-flight work on close. Terminal receipts replay without executing handlers. Public completion accepts no outcome references: it authorizes the current actor, locks the accepted recommendation plus its exact succeeded operation, verifies the receipt's recommendation ID/revision/stable action hash, and attaches only that server-resolved `action_receipt`; missing, swapped, or orphan receipts fail with zero transition.

- [ ] **Step 4: Run focused tests.**

Run:

```bash
cd backend
node --import tsx --test --test-concurrency=1 \
  src/advisor-recommendation-service-test.ts \
  src/advisor-action-operation-test.ts \
  src/advisor-action-operation-repository-test.ts \
  src/advisor-action-operation-mysql-repository-test.ts \
  src/advisor-action-recovery-sweeper-test.ts \
  src/advisor-action-dispatcher-test.ts
```

Expected: PASS for cross-workspace rejection, stale reference rejection, idempotent receipt replay and zero publish/approve/outreach calls.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/advisor-recommendation-service.ts backend/src/advisor-recommendation-service-test.ts backend/src/advisor-action-operation.ts backend/src/advisor-action-operation-test.ts backend/src/advisor-action-operation-repository.ts backend/src/advisor-action-operation-mysql-repository.ts backend/src/advisor-action-operation-repository-test.ts backend/src/advisor-action-operation-mysql-repository-test.ts backend/src/advisor-action-recovery-sweeper.ts backend/src/advisor-action-recovery-sweeper-test.ts backend/src/advisor-action-dispatcher.ts backend/src/advisor-action-dispatcher-test.ts
git commit -m "feat(growth): dispatch controlled advisor actions"
```

---

### Task 4: 暴露今日视图与建议状态命令 API

**Files:**
- Create: `backend/src/growth-advisor-router.ts`
- Create: `backend/src/growth-advisor-router-test.ts`
- Create: `backend/src/growth-advisor-module.ts`
- Create: `backend/src/growth-advisor-module-test.ts`
- Modify: `backend/src/growth-commercial-composition.ts`
- Modify: `backend/src/growth-openapi-response-conformance-test.ts`
- Test: `contracts/test/growth-openapi.test.mjs`
- Test: `contracts/test/growth-contract-release.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–3; C0's `GrowthCommercialModule`, private-service registry and singleton `GrowthCommercialToolPorts`; Foundation's exact `GROWTH_FOUNDATION_SERVICES`, `assertGrowthAsOfNotFuture`, and command-context factory; Quote's exact `GROWTH_QUOTE_AUTHORITY_READERS`; Finance's exact `GROWTH_FINANCE_SERVICES`; ROI's exact `GROWTH_ROI_SERVICES`; C0 workspace/command middleware; and the frozen Growth OpenAPI/JSON Schema bundle.
- Produces: the four exact routes below; `GrowthAdvisorServices { today: GrowthAdvisorQueryService; recommendations: AdvisorRecommendationService; dispatcher: AdvisorActionDispatcher }`; typed `GROWTH_ADVISOR_SERVICES: GrowthPrivateServiceKey<GrowthAdvisorServices>`; and `createGrowthAdvisorModule(options): GrowthCommercialModule` with an Advisor-owned idempotent `closeAdvisorResources` handle.
- Requires: `createGrowthAdvisorModule.install` obtains `workspaceSettings` and `httpIdempotency` only from the `GrowthFoundationServices` returned by `privateServices.require(GROWTH_FOUNDATION_SERVICES)`. Neither field is a `GrowthAdvisorModuleOptions` property or a separate argument supplied by `growth-commercial-composition.ts`.

```ts
export interface GrowthAdvisorServices {
  today: GrowthAdvisorQueryService;
  recommendations: AdvisorRecommendationService;
  dispatcher: AdvisorActionDispatcher;
}

export interface GrowthAdvisorResources extends GrowthAdvisorServices {
  recommendationExpiry: AdvisorRecommendationExpirySweeper;
  actionRecovery: AdvisorActionRecoverySweeper;
  closeAdvisorResources(): Promise<void>;
}

export interface GrowthAdvisorModuleOptions {
  /** Production implementation owns a reverse construction-order close stack and is strongly exception-safe. */
  createResources(input: {
    foundation: GrowthFoundationServices;
    quote: GrowthQuoteAuthorityReaders;
    finance: GrowthFinanceServices;
    roi: GrowthRoiServices;
    toolPorts: GrowthCommercialToolPorts;
  }): Promise<GrowthAdvisorResources>;
}
```

- [ ] **Step 1: Write failing router and response-conformance tests.**

```ts
test("advisor commands require auth, idempotency and revision", async () => {
  const created = await fixture.createRecommendation();
  const missingRevision = await request(app)
    .post(`/api/v1/acquisition/advisor/recommendations/${created.id}/accept`)
    .set(authHeaders())
    .set("Idempotency-Key", "accept-1")
    .send({ reason: null });
  assert.equal(missingRevision.status, 428);
  assert.equal(missingRevision.body.code, "revision_required");
});

test("today response conforms and hides private cost fields", async () => {
  const response = await request(app)
    .get("/api/v1/acquisition/advisor/today?currency=CNY&asOf=2026-08-09T08:00:00.000Z")
    .set(salesAuthHeaders());
  assert.equal(response.status, 200);
  assert.equal(validateGrowthAdvisorToday(response.body), true);
  assert.equal(JSON.stringify(response.body).includes("unitCostMinor"), false);
});

test("today shares the frozen one-second as-of boundary and rejects later values before reads", async () => {
  const response = await fixture.requestToday({
    readStartedAt: "2026-08-09T08:00:00.000Z",
    asOf: "2026-08-09T08:00:01.001Z"
  });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "invalid_as_of");
  assert.equal(fixture.todayReads, 0);
});

test("accepted positive clock skew is clamped before every Today reader", async () => {
  const response = await fixture.requestTodayWithInterleavedAppend({
    readStartedAt: "2026-08-09T08:00:00.000Z",
    requestedAsOf: "2026-08-09T08:00:00.999Z",
    appendBetweenReadersAt: "2026-08-09T08:00:00.001Z"
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.dataAsOf, "2026-08-09T08:00:00.000Z");
  assert.deepEqual(fixture.readerCutoffs, [
    "2026-08-09T08:00:00.000Z",
    "2026-08-09T08:00:00.000Z",
    "2026-08-09T08:00:00.000Z"
  ]);
  assert.equal(response.body.sourceIds.includes("interleaved-later-row"), false);
});

test("one key cannot replay a recommendation command for another path id", async () => {
  const first = await fixture.accept("recommendation-a", { key: "accept-shared", revision: 1 });
  assert.equal(first.status, 200);
  const second = await fixture.accept("recommendation-b", { key: "accept-shared", revision: 1 });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "idempotency_conflict");
  assert.equal(fixture.acceptedIds.includes("recommendation-b"), false);
});

test("advisor module requires Foundation first and reuses its singletons", async () => {
  const fixture = growthAdvisorModuleFixture();
  await fixture.install();
  assert.deepEqual(fixture.requiredKeys, [
    GROWTH_FOUNDATION_SERVICES,
    GROWTH_QUOTE_AUTHORITY_READERS,
    GROWTH_FINANCE_SERVICES,
    GROWTH_ROI_SERVICES
  ]);
  assert.equal(fixture.resourceInput?.foundation.workspaceSettings, fixture.foundation.workspaceSettings);
  assert.equal(fixture.resourceInput?.foundation.httpIdempotency, fixture.foundation.httpIdempotency);
  assert.equal(fixture.mountedRoutes, 1);
  assert.equal(fixture.recommendationExpiryStarts, 1);
  assert.equal(fixture.actionRecoveryStarts, 1);
});

test("missing Foundation fails before Advisor construction or route mounting", async () => {
  const fixture = growthAdvisorModuleFixture({ omit: GROWTH_FOUNDATION_SERVICES });
  await assert.rejects(fixture.install(), hasCode("MISSING_GROWTH_PRIVATE_SERVICE"));
  assert.equal(fixture.resourcesCreated, 0);
  assert.equal(fixture.mountedRoutes, 0);
});
```

- [ ] **Step 2: Run tests and prove RED.**

Run:

```bash
cd backend
node --import tsx --test --test-concurrency=1 \
  src/growth-advisor-router-test.ts \
  src/growth-advisor-module-test.ts
cd ..
npm run test:contracts
```

Expected: router test returns 404 while the already-frozen Growth contract tests remain green.

- [ ] **Step 3: Implement exact routes and schemas.**

Routes:

```text
GET  /api/v1/acquisition/advisor/today
POST /api/v1/acquisition/advisor/recommendations/:id/accept
POST /api/v1/acquisition/advisor/recommendations/:id/ignore
POST /api/v1/acquisition/advisor/recommendations/:id/complete
```

All POST bodies use `Content-Type: application/json`, reject missing/null/extra properties, require a single physical `Idempotency-Key` header, and require `If-Match: advisor-recommendation-v<revision>`. Missing revision is exactly `428 revision_required`. At the first line of the Today handler capture server `readStartedAt`, validate the parsed query through Foundation's `assertGrowthAsOfNotFuture(query.asOf, readStartedAt, 1_000)`, and perform zero reader calls on `422 invalid_as_of`. Every accepted downstream call, snapshot hash, and response `dataAsOf` receives the helper's one effective cutoff; a tolerated client-future value is clamped to `readStartedAt`, and no later clock read may change it.

Each command route builds one Foundation `CommandContext` and invokes the free `executeGrowthIdempotentCommand({ repository: foundation.httpIdempotency, reservation }, authorizeAndProject, execute)` helper. The exact factory calls are `commandContextFactory(req,{ canonicalPath:"/api/v1/acquisition/advisor/recommendations/:id/accept", pathParams:Object.freeze({id}), payload:req.body, expectedRevision })` and the identical shape with `/ignore` or `/complete`; `id` is the already schema-validated path value. Thus one key/body/revision used against another recommendation returns `409 idempotency_conflict` before business execution. Replay reloads the recommendation, reruns `AdvisorRecommendationAuthorizer`, and projects by recommendation/action-operation IDs under current capabilities. There is no Advisor-specific generic idempotency table, repository wrapper, or cached response body. Return `Idempotency-Replayed: true` on replay. All three request bodies are exactly the C0-owned closed `{ reason: string | null }`; they reject `outcomeRefs`, actions, receipts and authority IDs. Accept/ignore only transition state. Complete locks the exact succeeded action operation and attaches its server-resolved receipt as defined in Task 3; it never accepts caller-selected outcome references. There is no recommendation-action HTTP route. The actual quote draft, approval task and sales todo continue through their exact capability-checked Pi tools from Task 5. Use only the closed growth API error envelope. Validate every runtime response against the schema and operation already published by `2026-08-09-growth-contract-and-frontend.md`; do not edit the static Growth contract or legacy Acquisition contract in this task.

Implement `createGrowthAdvisorModule` with Foundation as the first required private dependency:

```ts
export const GROWTH_ADVISOR_SERVICES = Object.freeze({
  id: Symbol("growth.advisor.services"),
  description: "Growth Advisor query, recommendation, and dispatcher services"
}) satisfies GrowthPrivateServiceKey<GrowthAdvisorServices>;

export function createGrowthAdvisorModule(
  options: GrowthAdvisorModuleOptions
): GrowthCommercialModule {
  let installed = false;
  return {
    name: "growth-advisor",
    async install({ router, toolPorts, privateServices }) {
      if (installed) throw new Error("GROWTH_ADVISOR_MODULE_ALREADY_INSTALLED");
      installed = true;
      const foundation = privateServices.require(GROWTH_FOUNDATION_SERVICES);
      const quote = privateServices.require(GROWTH_QUOTE_AUTHORITY_READERS);
      const finance = privateServices.require(GROWTH_FINANCE_SERVICES);
      const roi = privateServices.require(GROWTH_ROI_SERVICES);
      let resources: GrowthAdvisorResources | null = null;
      try {
        resources = await options.createResources({
          foundation, quote, finance, roi, toolPorts
        });
        const services = Object.freeze({
          today: resources.today,
          recommendations: resources.recommendations,
          dispatcher: resources.dispatcher
        }) satisfies GrowthAdvisorServices;
        privateServices.provide(GROWTH_ADVISOR_SERVICES, services);
        router.use("/api/v1/acquisition/advisor", createGrowthAdvisorRouter({
          today: services.today,
          recommendations: services.recommendations,
          workspaceContext: foundation.workspaceContext,
          commandContextFactory: foundation.commandContextFactory,
          httpIdempotency: foundation.httpIdempotency
        }));
        resources.recommendationExpiry.start();
        resources.actionRecovery.start();
        return { close: () => resources!.closeAdvisorResources() };
      } catch (error) {
        if (resources !== null) await resources.closeAdvisorResources();
        throw error;
      }
    }
  };
}
```

`options.createResources` passes `foundation.workspaceSettings` and `foundation.acquisitionWorkspace` into the one `GrowthAdvisorQueryService`/candidate-authority projection; the router receives only `foundation.workspaceContext`, `foundation.commandContextFactory`, and `foundation.httpIdempotency`. `GrowthAdvisorModuleOptions` cannot inject replacements for any Foundation singleton. The production resource factory itself is strongly exception-safe: before constructing the first pool/repository/sweeper it creates an idempotent reverse-order close stack; immediately after each constructor succeeds it registers that resource's close action; if constructor N throws, the factory drains N-1 through 1 exactly once before rethrowing. Only a fully built graph returns `GrowthAdvisorResources`, whose `closeAdvisorResources` reuses that same once-only stack. The module keeps the factory await inside its own `try/catch`, so returned resources are also closed if provision, mount, or timer start fails. The four `privateServices.require` calls and complete resource construction happen before route mounting or timer start. The module constructs one recommendation repository/query/service/dispatcher/action-operation graph, mounts `createGrowthAdvisorRouter` once, provides `GROWTH_ADVISOR_SERVICES`, then starts exactly one `AdvisorRecommendationExpirySweeper` and one `AdvisorActionRecoverySweeper`. `closeAdvisorResources` stops and awaits action recovery, then recommendation expiry, before closing dispatcher/repositories; it is idempotent. Module tests inject failure at every construction position and assert all earlier resources reverse-close exactly once, no service is provided, no route is mounted, and no timer remains; they also assert both exactly-one starts, no start on missing dependency/resource failure, partial-start cleanup on a second-start failure, in-flight drain, and zero timers after failed install or repeated close. Add it once after ROI in `growth-commercial-composition.ts`. Missing upstream keys fail before any route is mounted; no business object is created in `server.ts` or the C0 application kernel.

- [ ] **Step 4: Verify routes, contracts and build.**

Run:

```bash
cd backend
node --import tsx --test --test-concurrency=1 \
  src/growth-advisor-router-test.ts \
  src/growth-advisor-module-test.ts
cd ..
npm run test:contracts
npm run test:contract-drift --workspace backend
npm run build --workspace backend
```

Expected: PASS; published schemas reject unknown fields and every command declares 400/401/403/404/409/412/428/429 responses.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/growth-advisor-router.ts backend/src/growth-advisor-router-test.ts backend/src/growth-advisor-module.ts backend/src/growth-advisor-module-test.ts backend/src/growth-commercial-composition.ts backend/src/growth-openapi-response-conformance-test.ts
git commit -m "feat(growth): expose advisor recommendations API"
```

---

### Task 5: 把增长工具注册到现有 Pi 精确白名单

**Files:**
- Create: `backend/src/growth-advisor-tools.ts`
- Create: `backend/src/growth-advisor-tools-test.ts`
- Modify: `backend/src/acquisition-pi-tools.ts`
- Modify: `backend/src/acquisition-pi-tools-test.ts`
- Modify: `backend/src/acquisition-tool-executor.ts`
- Modify: `backend/src/acquisition-tool-executor-test.ts`
- Modify: `backend/src/acquisition-pi-agent-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`
- Modify: `backend/src/growth-advisor-module.ts`

**Interfaces:**
- Consumes the Acquisition-owned `GrowthAcquisitionToolDelegate { owns(toolName:string):boolean; execute(input:AcquisitionToolExecutionInput):Promise<unknown> }` introduced by B2 and B2's seven-name `GrowthQuoteAcquisitionToolDelegate`; it never narrows the production executor option back to a Quote-only type.
- Preserves the C0 `GrowthCommercialToolPorts` shape exactly as `register(name, handler)` plus `execute(call, command)`; it adds no advisor, ROI, catalog, quote or ledger object properties.
- Registers only the five Advisor-owned names `get_growth_performance`, `list_financial_data_gaps`, `create_advisor_recommendation`, `create_sales_todo`, and `record_recommendation_outcome`, with handlers closing over the singleton Quote/Finance/ROI/Advisor services already supplied to `createGrowthAdvisorModule`. ROI registers neither read tool, so duplicate registration is impossible.
- Produces a closed internal `GrowthAdvisorToolResultEnvelope` containing only frozen authority/resource IDs, source hashes, `dataAsOf`, stable call hash, audit refs, and an unprojected full snapshot; `GrowthAdvisorToolReplayProjector.authorizeAndProjectCached(currentContext,envelope)` always performs current workspace/resource authorization and current sensitive-field projection. The existing Acquisition result ledger stores this envelope, never a projected response.
- Produces `GrowthAdvisorAcquisitionToolDelegate implements GrowthAcquisitionToolDelegate` over only the five Advisor names and `composeGrowthAcquisitionToolDelegates(quote,advisor)`, whose constructor rejects overlapping ownership and whose `owns/execute` route to exactly one child. Both children share the application-owned existing result/audit ledger instances but each focused executor invokes the result ledger only for its own call.
- Acquisition receives only the existing `growthRuntime.toolPorts` registry and delegates by closed name; it never receives or constructs a second business service graph. `ProductionAcquisitionAgentToolExecutor` dispatches all twelve Growth names (the seven Quote-owned names plus these five) to their focused Growth executors before its generic outer result-cache branch, so a Growth call enters the one existing result ledger exactly once and is never nested inside the generic path.

- [ ] **Step 1: Write failing allowlist, permission and authority tests.**

```ts
test("advisor tools extend the existing quote tools and writes remain sequential", () => {
  const tools = createAcquisitionAgentTools(options);
  assert.deepEqual(tools.filter((tool) => ADVISOR_TOOL_NAMES.includes(tool.name as never))
    .map((tool) => [tool.name, tool.executionMode]), [
      ["get_growth_performance", "parallel"],
      ["list_financial_data_gaps", "parallel"],
      ["create_advisor_recommendation", "sequential"],
      ["create_sales_todo", "sequential"],
      ["record_recommendation_outcome", "sequential"]
    ]);
});

test("AI can recommend but cannot approve, publish or verify", async () => {
  await execute("create_advisor_recommendation", validRecommendationToolPayload());
  assert.equal(ports.recommendations.length, 1);
  for (const forbidden of ["approve_quote", "publish_quote", "verify_financial_fact"]) {
    await assert.rejects(
      executor.execute(toolInput(forbidden as never, {})),
      hasCode("TOOL_NOT_ALLOWED")
    );
  }
});

test("record outcome derives revision from its closed tool input and executes only the frozen action", async () => {
  await execute("record_recommendation_outcome", {
    recommendationId: "recommendation-1", recommendationRevision: 2
  });
  assert.equal(observedCommands[0]?.expectedRevision, 2);
  assert.equal(observedReceipts[0]?.actionKind, "create_quote_approval_task");
  assert.equal("action" in observedToolInputs[0]!, false);
});

test("advisor Growth replay bypasses the generic outer cache and applies current projection", async () => {
  const first = await executor.execute(toolInput("get_growth_performance", {
    currency: "CNY", asOf: "2026-08-09T08:00:00.000Z"
  }, { stableCallHash: "stable-growth-read" }));
  assert.equal(first.amountVisibility, "full");
  capabilities.remove("pricing.sensitive.read");
  const replay = await executor.execute(toolInput("get_growth_performance", {
    currency: "CNY", asOf: "2026-08-09T08:00:00.000Z"
  }, { stableCallHash: "stable-growth-read" }));
  assert.equal(replay.amountVisibility, "redacted");
  assert.equal("attributedEstimatedCostMinor" in replay, false);
  assert.equal(genericOuterResultLedger.calls.length, 0);
  assert.equal(advisorFocusedResultLedger.executeOnceCalls.length, 2);
  assert.equal(advisorFocusedResultLedger.storedEnvelopes.length, 1);
  assert.equal(advisorReplayProjector.calls.length, 2);
  capabilities.remove("growth.performance.workspace.read");
  await assert.rejects(
    executor.execute(toolInput("get_growth_performance", {
      currency: "CNY", asOf: "2026-08-09T08:00:00.000Z"
    }, { stableCallHash: "stable-growth-read" })),
    hasCode("FORBIDDEN")
  );
});

test("one composite delegates twelve disjoint Growth names before the outer cache", async () => {
  const composite = composeGrowthAcquisitionToolDelegates(quoteDelegate, advisorDelegate);
  for (const name of [...GROWTH_QUOTE_TOOL_NAMES, ...ADVISOR_TOOL_NAMES]) {
    assert.equal(composite.owns(name), true);
    await composite.execute(acquisitionToolExecutionInput(name));
  }
  assert.equal(quoteDelegate.calls.length, 7);
  assert.equal(advisorDelegate.calls.length, 5);
  assert.equal(genericOuterResultLedger.calls.length, 0);
  assert.throws(
    () => composeGrowthAcquisitionToolDelegates(quoteDelegate, overlappingDelegate("get_growth_performance")),
    /GROWTH_TOOL_DELEGATE_OWNERSHIP_OVERLAP/
  );
});
```

- [ ] **Step 2: Run tests and prove RED.**

Run:

```bash
cd backend
node --import tsx --test --test-concurrency=1 \
  src/growth-advisor-tools-test.ts \
  src/acquisition-pi-tools-test.ts \
  src/acquisition-tool-executor-test.ts \
  src/acquisition-pi-agent-test.ts
```

Expected: FAIL because the five advisor tool names are absent from `ACQUISITION_AGENT_TOOL_NAMES`; the seven quote tools introduced by the quote plan remain green.

- [ ] **Step 3: Add versioned TypeBox/Zod schemas and adapters for exactly these tools.**

```text
get_growth_performance
list_financial_data_gaps
create_advisor_recommendation
create_sales_todo
record_recommendation_outcome
```

The quote plan already owns `list_catalog_items`, `get_pricing_policy`, `preview_quote`, `create_quote_draft`, `list_pending_quote_approvals`, `get_quote_decision`, and `create_quote_approval_task`. This task must extend that exact registry rather than declaring those blueprints, schemas or adapters again.

The two read tools are `parallel`; the three write tools are `sequential`. Every new adapter obtains `ActiveWorkspaceContext` from the authenticated Copilot identity, freezes `dataAsOf`, model snapshot, prompt version and schema version, validates response schema, and writes the existing tool audit ledger. `get_growth_performance` returns `not_computable` unchanged. `record_recommendation_outcome` has a closed input `{ recommendationId, recommendationRevision }`; the adapter moves `recommendationRevision` only into a child `CommandContext.expectedRevision`, calls the dispatcher with that context plus ID, and never accepts an action or whole recommendation. Create-new recommendation/todo commands use child contexts with `expectedRevision:null`; any update tool carries its exact aggregate revision in the tool schema. Existing quote tools keep the exact behavior and schemas established in the quote plan.

Before the pre-existing generic `toolResults.executeOnce` branch, `ProductionAcquisitionAgentToolExecutor.execute` checks a closed `growthCommercialTools.owns(call.name)` predicate covering exactly the twelve Growth names. Quote-owned calls delegate to the Quote focused executor defined in B2; these five delegate to one `GrowthAdvisorToolExecutor`. A delegated call never enters the generic ledger or its dispatch callback. `GrowthAdvisorToolExecutor` invokes the existing ledger once per attempt with `GrowthAdvisorToolResultEnvelope`, storing one envelope for a stable call; after either fresh execution or replay it unconditionally calls `GrowthAdvisorToolReplayProjector.authorizeAndProjectCached` with the current context. Read envelopes retain the original cutoff and selected authority IDs but are re-redacted after capability downgrade. Write envelopes retain only stable business/resource/receipt refs; replay re-authorizes the current actor and reads the frozen resource, never reruns a completed side effect or returns a cached sensitive body. Base-capability loss rejects, while sensitive-capability loss returns the same selected snapshot with the C0 redacted branch. Non-Growth calls retain the original generic path. Tests assert one stored envelope, zero outer generic-ledger calls for all fresh/replayed Growth tools, no nested ledger call, one current projector call per attempt, and unchanged generic behavior for a non-Growth tool.

`GrowthAdvisorAcquisitionToolDelegate.execute(input)` first performs the same persisted/authenticated Copilot identity, session, abort and actor-binding checks as B2's Quote delegate, resolves its concrete current `ActiveWorkspaceContext` only through the reference-equal projected `GrowthAcquisitionWorkspaceResolver`, reloads membership/capabilities, derives the closed `GrowthCommercialToolCall` and stable call hash, and only then calls the focused executor. `createAcquisitionApplication` constructs the Quote and Advisor child delegates with the same resolver, result ledger and audit ledger, composes them once, and supplies that one `GrowthAcquisitionToolDelegate` through `ProductionAcquisitionAgentToolExecutorOptions.growthCommercialTools`. The composite rejects duplicate names during construction; neither child can own a non-Growth or other-child name, and there is no second application/runtime/ledger.

`createGrowthAdvisorModule.install` registers the five handlers once on the single `GrowthCommercialToolPorts` supplied by C0; do not extend its structural type and do not construct catalog, quote, ledger, ROI or advisor services in the Acquisition application. Server startup creates and installs the composed Growth runtime first, then passes `growthRuntime.toolPorts` into `createAcquisitionApplication`. Shutdown closes Acquisition before Growth so an in-flight Pi task never observes already-closed business services.

- [ ] **Step 4: Run Pi, executor and application tests.**

Run:

```bash
cd backend
node --import tsx --test --test-concurrency=1 \
  src/growth-advisor-tools-test.ts \
  src/acquisition-pi-tools-test.ts \
  src/acquisition-tool-executor-test.ts \
  src/acquisition-pi-agent-test.ts \
  src/acquisition-application-test.ts
```

Expected: all subtests PASS; if the known baseline application process retains an open handle after reporting all subtests, record the observed handle separately and do not add `process.exit()`.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/growth-advisor-tools.ts backend/src/growth-advisor-tools-test.ts backend/src/acquisition-pi-tools.ts backend/src/acquisition-pi-tools-test.ts backend/src/acquisition-tool-executor.ts backend/src/acquisition-tool-executor-test.ts backend/src/acquisition-pi-agent-test.ts backend/src/acquisition-application.ts backend/src/acquisition-application-test.ts backend/src/growth-advisor-module.ts
git commit -m "feat(growth): add controlled advisor Pi tools"
```

---

### Task 6: 验证建议到受控任务再到 Outcome 的纵向闭环

**Files:**
- Create: `backend/src/growth-advisor-closed-loop-integration-test.ts`
- Create: `backend/src/growth-advisor-mysql-test-support.ts`
- Create: `backend/src/growth-advisor-mysql-integration-test.ts`
- Modify: `backend/package.json`
- Modify: `docs/product/ai-acquisition-agent.md`

**Interfaces:**
- Consumes: completed Tasks 1–5; the real C0 production composition in Foundation→Catalog→Quote→Finance→ROI→Advisor order; the existing Acquisition Copilot session/message/task executor and recovery path; the single `growthRuntime.toolPorts`; authoritative Quote/Finance/ROI fixture writers; and the closed `record_recommendation_outcome` input `{ recommendationId, recommendationRevision }`.
- Produces: `growth-advisor-closed-loop-integration-test.ts`, which asserts the complete kind-specific `growth_performance` metric ref and recommendation snapshot hash, exactly one capability-checked `record_recommendation_outcome` dispatch, exactly one `sales_todo` receipt, terminal `action_receipt` persistence, and zero quote publication/outbound-message side effects; mandatory `withGrowthAdvisorMysqlTestDatabase` plus a real two-connection concurrency suite; exact `test:growth-advisor` and `test:growth-advisor:mysql` scripts shown in Step 3; and matching product documentation.

- [ ] **Step 1: Write the failing tracer-bullet test.**

```ts
test("authoritative facts become a recommendation and one controlled task", async () => {
  const fixture = await createGrowthClosedLoopFixture();
  const session = await fixture.createCopilotSession("manager");
  const task = await fixture.ask(session, "基于已关账数据，告诉我今天先做什么");
  await fixture.runCopilotTask(task.id);

  const today = await fixture.getAdvisorToday("CNY");
  assert.equal(today.recommendations.length, 1);
  const recommendation = today.recommendations[0];
  assert.ok(recommendation);
  assert.deepEqual(recommendation.metricRefs[0], {
    kind: "growth_performance",
    cohortId: fixture.cohortId,
    currency: "CNY",
    asOf: fixture.dataAsOf,
    planId: null,
    closureVersionId: fixture.closureVersionId,
    sliceKey: fixture.sliceKey,
    calculationHash: fixture.closureCalculationHash
  });
  assert.equal(recommendation.inputSnapshotHash, fixture.expectedSnapshotHash);

  const accepted = await fixture.acceptRecommendation(recommendation);
  const receipt = await fixture.runRecordRecommendationOutcomeTool({
    recommendationId: accepted.id, recommendationRevision: accepted.revision
  });
  assert.equal(receipt.kind, "sales_todo");
  assert.equal(fixture.salesTodos.length, 1);
  assert.equal(fixture.quotePublications.length, 0);
  assert.equal(fixture.outboundMessages.length, 0);

  const completed = await fixture.completeRecommendation(accepted, { reason: null });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.outcomeRefs, [{ kind: "action_receipt", id: receipt.id }]);
});

test("real MySQL preserves Advisor uniqueness, strict time and action fences", async () => {
  await withGrowthAdvisorMysqlTestDatabase(async ({ connectionA, connectionB, fixture }) => {
    await fixture.assertOneGenerationWinner(connectionA, connectionB);
    await fixture.assertOneAcceptWinner(connectionA, connectionB);
    await fixture.assertRecordedTimeAdvancesOneDatetime3TickAfterClockRollback(connectionA, connectionB);
    await fixture.assertOneActionClaimAndReceiptWithExpiredFenceRejected(connectionA, connectionB);
    await fixture.assertConcurrentQualificationBundlesHaveUniqueConsecutiveVersions(connectionA, connectionB);
    await fixture.assertLaterQualificationAndSettingsDoNotRewriteSealedToday(connectionA, connectionB);
    await fixture.assertSalesVisibilityIsolatedByAuthoritySql(connectionA, connectionB);
    await fixture.assertWorkspaceBarrierWaitsUncommittedWriterAndFencesNewStream(connectionA, connectionB);
    await fixture.assertExpiryCannotOrphanEnqueuedOrPostSideEffectAction(connectionA, connectionB);
  });
  process.stdout.write("GROWTH_REAL_MYSQL advisor connections=2 tests=9\n");
});
```

- [ ] **Step 2: Run the tracer and prove RED.**

Run:

```bash
cd backend
node --import tsx --test --test-concurrency=1 src/growth-advisor-closed-loop-integration-test.ts
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" node --import tsx --test --test-concurrency=1 src/growth-advisor-mysql-integration-test.ts
```

Expected: FAIL before the application composition exposes advisor services and Pi tools.

- [ ] **Step 3: Complete application wiring and recovery.**

Wire the single recommendation repository/service/query/dispatcher through `growth-advisor-module` and the existing Acquisition Copilot executor. `createGrowthClosedLoopFixture` exposes the authoritative `cohortId`, `dataAsOf`, `closureVersionId`, `sliceKey`, and `closureCalculationHash` written by its closure setup; the tracer compares the complete `growth_performance` branch and never invents a generic ref ID. The module must reuse upstream typed private services and the one tool registry; it never constructs a second business graph. On startup, recover only persisted Copilot tasks and in-progress controlled task receipts using existing lease/fencing patterns. Do not schedule autonomous advice generation and do not re-execute terminal action receipts. The mandatory MySQL suite uses the real candidate-authority and Today SQL, the exact C0-projected temporal barrier, and two physical connections: it proves concurrent bundle versions/event sequences are contiguous with all-or-none rows; later Qualification/FinancialValue/settings events do not change a sealed old Today view; same-workspace sales users cannot see each other's rows; an uncommitted pre-stamped writer is waited out and a later brand-new aggregate under clock rollback receives `recordedAt>cutoff`; and expiry cannot win against enqueue or post-side-effect/pre-receipt recovery. No fake pool or skipped branch contributes to the marker count.

Add this exact stable suite only after every referenced file exists:

```json
{
  "scripts": {
    "test:growth-advisor": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/advisor-recommendation-domain-test.ts src/advisor-recommendation-repository-test.ts src/advisor-recommendation-mysql-repository-test.ts src/advisor-recommendation-expiry-sweeper-test.ts src/growth-advisor-candidate-authority-projection-test.ts src/growth-advisor-candidate-authority-mysql-repository-test.ts src/growth-advisor-candidate-authority-backfill-test.ts src/growth-advisor-query-test.ts src/growth-advisor-mysql-query-test.ts src/advisor-recommendation-service-test.ts src/advisor-action-operation-test.ts src/advisor-action-operation-repository-test.ts src/advisor-action-operation-mysql-repository-test.ts src/advisor-action-recovery-sweeper-test.ts src/advisor-action-dispatcher-test.ts src/growth-advisor-router-test.ts src/growth-advisor-module-test.ts src/acquisition-pi-tools-test.ts src/acquisition-tool-executor-test.ts src/acquisition-pi-agent-test.ts src/acquisition-application-test.ts src/growth-advisor-closed-loop-integration-test.ts",
    "test:growth-advisor:mysql": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/growth-advisor-mysql-integration-test.ts"
  }
}
```

`withGrowthAdvisorMysqlTestDatabase` requires `MYSQL_TEST_ADMIN_URL`, creates an isolated `goodjob_growth_advisor_<pid>_<random>` database, installs the real Acquisition projection/Foundation/Advisor schemas, opens at least two physical connections with distinct `CONNECTION_ID()` values, and drops the database in `finally`. Missing configuration throws `MYSQL_TEST_ADMIN_URL_REQUIRED:growth-advisor`; there is no skip or fake-pool fallback. The suite covers generation-key uniqueness, transition revision race, strict DATETIME(3) recording under clock rollback, action claim/expiry/fence, and exactly-one durable receipt. It emits `GROWTH_REAL_MYSQL advisor connections=2 tests=<positive integer>` only after every assertion passes.

- [ ] **Step 4: Run the final backend gate.**

Run:

```bash
npm run test:contracts
npm run test:contract-drift --workspace backend
npm run test:acquisition-openapi --workspace backend
npm run test:growth-advisor --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-advisor:mysql --workspace backend
npm run test:acquisition --workspace backend
npm run build
git diff --check
```

Expected: PASS, with the old Performance and old Pi tool tests unchanged and the new tracer proving exactly one controlled task and zero outbound action.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/growth-advisor-closed-loop-integration-test.ts backend/src/growth-advisor-mysql-test-support.ts backend/src/growth-advisor-mysql-integration-test.ts backend/package.json docs/product/ai-acquisition-agent.md
git commit -m "test(growth): verify advisor recommendation closed loop"
```

## Acceptance Outcome

老板或销售主管打开 AI 增长参谋时，看到的是来自权威客户、报价、Closure ROI 和财务缺口的同一快照。Copilot 可以解释事实并保存建议，但不能计算权威金额或越权执行。用户采纳后，只能显式创建报价草稿、报价审批任务或销售待办；建议、动作回执和最终结果都可按工作区、版本、模型快照和数据时间追溯。
