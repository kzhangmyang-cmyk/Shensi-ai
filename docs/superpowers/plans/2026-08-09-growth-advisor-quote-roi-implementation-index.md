# AI 增长参谋、报价决策与可计算 ROI 总实施索引

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute the linked plans in dependency order.

**Goal:** 把确认版设计转成一条可分批提交、独立审查、可回滚且最终能够纵向验收的开发路线，完成产品目录、确定性报价、人工审批、财务核销、预计/实际 ROI 和 AI 增长参谋。

**Architecture:** 后端继续使用 GoodJob 的 TypeScript/Express/MySQL 和现有 Acquisition Copilot/Pi 运行时；新增 Growth 商业权威域、追加式账本和不可变 ROI Closure。新版独立前端只消费发布且哈希固定的 Growth 契约。每个阶段先做领域与仓储，再做 HTTP 契约和前端，最后用真实后端纵向测试证明没有模拟数据、旁路写入或 AI 越权。

**Tech Stack:** TypeScript、Express、MySQL 8、Zod/TypeBox、OpenAPI 3.1、Node test runner、Vite、现有 vanilla render/controller 前端、Playwright。

## Workspaces and Branches

- Backend plan worktree: `/Users/mac/Documents/外贸/GoodJob-1.09/.worktrees/goodjob-growth-advisor-quote-roi`
- Backend branch: `codex/growth-advisor-quote-roi`
- Standalone frontend repository: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend`
- Standalone frontend existing user change to preserve: `pnpm-workspace.yaml`
- Approved design: `docs/superpowers/specs/2026-08-09-ai-growth-advisor-quote-roi-design.md`

## Global Constraints

- Node version is `>=22.22.3 <23`; do not add unnecessary dependencies.
- Production persistence is MySQL; every new domain repository has the same memory/MySQL behavior suite.
- Money uses integer minor units with `BigInt` internally and a versioned ISO currency exponent table; probability, margin and allocation use BPS; quantity uses `quantityMicros`.
- AI never calculates authoritative money, approves/publishes quotes, verifies/reverses financial facts, modifies costs, or fabricates missing ROI.
- Expected ROI and actual ROI are separate. Actual ROI is computed only from verified ledgers, complete allocation/settlement and a published immutable Closure Snapshot.
- Missing or inconsistent inputs return a closed enumerated `not_computable` reason, never zero or a model estimate disguised as fact.
- Every operation resolves a concrete `ActiveWorkspaceContext`; `teamId="all"` is never persisted or used as a workspace.
- Sensitive cost and margin fields are projected only when the concrete capability is present.
- Quotes, approvals, financial facts, allocations, closures and recommendations are append-only or versioned; history is never overwritten.
- Foundation owns one workspace-global temporal barrier. Every Growth/Acquisition projection append locks it first and every public historical boundary seals it once, then passes one opaque cutoff token to all nested readers. Per-stream timestamp allocators, nested resealing, and token sequence in business hashes are forbidden.
- Commands require one physical `Idempotency-Key`; revisioned resources require `If-Match`; workers use leases, fencing and recovery without duplicate publication.
- The standalone frontend is the only new UI target. Do not implement duplicate pages in the backend repository's legacy `frontend`.
- Real/demo modes are explicit and fail closed. Contract mismatch, missing workspace or authorization failure never falls back to demo data.
- Existing acquisition search, old `/performance`, old Pi performance tool and old CRM pages remain backward compatible until their consumers deliberately migrate.
- No automatic comment, private message, friend request, group message or outbound marketing action is introduced.
- Every implementation task follows RED → GREEN → focused verification → independent review → scoped commit.

## Plan Set

1. [Contract and standalone frontend](./2026-08-09-growth-contract-and-frontend.md)
2. [Foundation and authority](./2026-08-09-growth-foundation-and-authority.md)
3. [Catalog and pricing](./2026-08-09-growth-catalog-pricing.md)
4. [Quote decision and publication](./2026-08-09-growth-quote-decision-publication.md)
5. [Financial ledgers and import](./2026-08-09-growth-financial-ledgers-import.md)
6. [Attribution, ROI and closure](./2026-08-09-growth-attribution-roi-closure.md)
7. [AI growth advisor backend](./2026-08-09-growth-advisor-backend.md)
8. [Integration and release](./2026-08-09-growth-integration-release.md)

## Dependency DAG

```text
C0a Published Growth contract + manifest/hash (contract Tasks 1-2)
 │
 └── B0a Concrete workspace + closed capabilities (foundation Task 0.1)
      │
      └── C0b Growth application + runtime bridge + bootstrap (contract Task 3)
           │
           ├── B0b Command/idempotency + workspace temporal barrier/sealed reads + authority guards + catalog skeleton
           │    ├── B1 Catalog + packages + pricing-policy versions
           │    │    └── B2 Deterministic quote + approval + publication authority
           │    └── B3a Cost/estimate ledger primitives
           └── F0 Frontend contract pin + bootstrap fail-closed runtime

B2 + B3a ──> B3 Financial facts + commercial binding + secure finance import
B2 + B3  ──> B4 Cohort + attribution + settlement + immutable closure

B1 ──> F1 Catalog/pricing UI
B2 ──> F2 Quote workbench
B3 ──> F3 Finance verification/import workbench
B4 ──> F4 Expected/actual ROI board
B2 + B4 ──> B5 Advisor today/recommendations/Pi tools ──> F5 Advisor workbench

F0..F5 + B0..B5 ──> Q0 Typed mocked UI E2E
Q0 ──> Q1 Real backend vertical E2E ──> R0 Dual-repository release gate
```

## Ordered Execution Checklist

### Slice C0a/B0a/C0b: Freeze the contract, authorize a workspace, then serve bootstrap

- [ ] Build the self-contained Growth OpenAPI artifact and canonical SHA-256 manifest.
- [ ] Add backend schema registry, drift and response-conformance tests.
- [ ] Implement foundation Task 0.1 so bootstrap consumes one concrete `ActiveWorkspaceContext` and the closed capability registry.
- [ ] Create the single Growth commercial application/runtime bridge and mount bootstrap only after Task 0.1 is green.
- [ ] Import and pin the exact release artifact in the standalone frontend.
- [ ] Prove generated types and pinned manifest are clean on both repositories.

Exit gate:

```bash
cd /Users/mac/Documents/外贸/GoodJob-1.09/.worktrees/goodjob-growth-advisor-quote-roi
npm run test:contracts
npm run test:contract-drift --workspace backend

cd /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend
pnpm run contract:check
pnpm build
```

### Slice B0b/F0: Establish command authority before business writes

- [ ] Resolve one concrete workspace and closed capabilities for every request.
- [ ] Add Growth command idempotency and optimistic concurrency primitives.
- [ ] Close direct Deal/PI/Outcome commercial-authority bypasses.
- [ ] Expose `/api/v1/growth/bootstrap` as the sole real-mode frontend gate.
- [ ] Fail closed on contract hash/version mismatch or unresolved workspace.

Exit condition: an authorized user enters real Growth mode only with an exact contract and concrete workspace; an unauthorized legacy write cannot alter quote, won/lost or strong ROI attribution state.

### Slice B1/F1: Add authoritative product and price policy

- [ ] Implement CatalogItem, PackageVersion/component graph and PricingPolicyVersion.
- [ ] Migrate CommissionProduct through an auditable adapter without making it the authority.
- [ ] Implement capability-projected catalog and pricing pages in the standalone frontend.
- [ ] Prove concurrent activation has exactly one active package/policy version.

Exit condition: a published catalog/policy version can be selected by ID and hash, while cost fields remain hidden from roles without capability.

### Slice B2/F2: Complete quote decision and publication

- [ ] Implement fixed-point quote preview and ProbabilityAssessment.v2.
- [ ] Bind QuoteCase once to candidate/customer/deal and freeze CommercialBindingSnapshot.
- [ ] Persist QuoteVersion, approval events and one DealAuthoritativeQuote.
- [ ] Publish approved quote to PI and CRM through a fenced outbox worker.
- [ ] Block direct legacy Deal/PI state changes that bypass the authority.
- [ ] Connect candidate/CRM pages to the standalone quote workbench.

Exit condition: one approved quote version publishes exactly one PI and one CRM quoted state; stale, replayed, under-floor or unauthorized commands cannot bypass approval.

### Slice B3/F3: Establish verified financial inputs

- [ ] Implement CostEntry/Estimate and FinancialFact append-only ledgers.
- [ ] Project provider-request accounting evidence without passing decimals through floating point.
- [ ] Verify/reject/reverse/correct with source heads and exact commercial binding.
- [ ] Extract the secure spreadsheet parser and add finance preview/commit/error export.
- [ ] Render pending/verified/reversed facts and data gaps in the standalone finance UI.

Exit condition: imported rows remain pending until explicit verification; correction reverses the prior fact and creates the next source version; formula/ZIP/macro/external-link attacks are rejected.

### Slice B4/F4: Compute expected and closed actual ROI

- [ ] Freeze canonical first-touch Cohort membership.
- [ ] Activate exact BPS attribution allocations and cash settlement allocations.
- [ ] Close a cohort/currency only when attestations and coverage gates pass.
- [ ] Persist immutable RoiSnapshot entries and versioned reopen events.
- [ ] Expose new `/api/v1/acquisition/growth-performance` without changing old Performance.
- [ ] Render expected and actual ROI separately with data gaps and closure metadata.

Exit condition: expected ROI reads authoritative quotes; actual ROI reads only an immutable ClosureVersion; incomplete coverage returns the exact `not_computable` reason.

### Slice B5/F5: Make AI recommendations traceable and controlled

- [ ] Query priority customers, pending approvals, ROI and data gaps at one `dataAsOf`.
- [ ] Persist versioned AdvisorRecommendation records with strong references and model snapshot.
- [ ] Add the exact Growth Pi tool allowlist and deterministic adapters.
- [ ] Accept/ignore/complete recommendations through idempotent revisioned commands.
- [ ] Dispatch only quote drafts, approval tasks, sales todos or data-completion links.
- [ ] Render conclusion, evidence, risk, action receipt and outcome in the standalone advisor.

Exit condition: one model-backed recommendation points to real evidence and creates exactly one approved type of task; no recommendation can approve/publish/verify or perform outbound communication.

### Slice Q0/Q1/R0: Prove and release the whole loop

- [ ] Run typed mocked E2E for bootstrap, catalog, quote, finance, ROI and advisor states.
- [ ] Run one no-route-intercept E2E against the real backend and MySQL.
- [ ] Prove the full path: candidate → quote → approval → PI/CRM → financial facts → closure → ROI → advisor task.
- [ ] Run security, contracts, drift, generated files, backend, frontend and Playwright gates.
- [ ] Record both repository commits, the pinned contract hash and deployment rollback points.

Final gate:

```bash
cd /Users/mac/Documents/外贸/GoodJob-1.09/.worktrees/goodjob-growth-advisor-quote-roi
npm run check:growth-contracts
npm run test:contracts
npm run test:contract-drift --workspace backend
npm run test:acquisition-openapi --workspace backend
npm run test:security --workspace backend
npm run test:growth-foundation --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-foundation:mysql --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-catalog --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-quotes --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-finance:mysql --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-roi:mysql --workspace backend
npm run test:growth-advisor --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth-advisor:mysql --workspace backend
npm run test:acquisition --workspace backend
npm run test:growth:closed-loop --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" GROWTH_RELEASE_REQUIRE_MYSQL=1 npm run test:growth:closed-loop:mysql --workspace backend
npm run build
git diff --check

cd /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend
pnpm run contract:check
pnpm run test:growth:fixture
pnpm run test:types
pnpm test
pnpm run test:e2e
pnpm run test:e2e:real:guard
GOODJOB_BACKEND_ROOT=/Users/mac/Documents/外贸/GoodJob-1.09/.worktrees/goodjob-growth-advisor-quote-roi \
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" \
GROWTH_RELEASE_REQUIRE_MYSQL=1 \
GROWTH_E2E_TOKEN=goodjob-growth-real-e2e-token-20260809 \
pnpm run test:e2e:real
pnpm build
git diff --check

cd /Users/mac/Documents/外贸/GoodJob-1.09/.worktrees/goodjob-growth-advisor-quote-roi
node --test tools/growth-dual-repo-release-gate.test.mjs
```

## Execution Protocol

1. Execute only one task from a linked plan per worker.
2. The worker must show the planned RED failure before production edits.
3. The worker commits only files named in that task and writes its verification result.
4. A fresh reviewer checks tenant isolation, capability projection, idempotency, fixed-point arithmetic, version authority, lease/fencing and forbidden AI actions.
5. Important review findings return to the same task for a new RED → GREEN round before the next dependency begins.
6. Frontend tasks may run in parallel only after their contract and backend route are frozen.
7. The integration/release plan is the only place where backend and frontend completion is declared.

## Final Acceptance Outcome

The released product has one auditable commercial truth chain: a discovered customer receives a deterministic quote under a versioned policy, an authorized person approves it, publication writes one PI/CRM result, verified costs and financial facts close into immutable ROI, and the AI growth advisor explains those facts and creates only a controlled next-step task. Every incomplete input remains visibly incomplete; every historical version remains reproducible.
