# Growth Attribution, ROI Closure, and Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build first-touch acquisition cohorts, exact cost/fact attribution, per-revenue cash settlement, immutable currency-specific ROI closures, and a database-backed expected/actual growth-performance API for stages 4.1–4.5.

**Architecture:** Resolve every discovered subject to one workspace-wide canonical identity and one first-touch cohort, then allocate shared sources through immutable versioned sets. Close actual ROI only after signed completeness attestations, verified append-only ledgers, exact attribution, and per-revenue cash reconciliation are frozen into a versioned snapshot. Serve expected metrics from authoritative quote history and active estimates, while serving actual metrics only from a published closure snapshot; never recompute a published closure from current mutable state.

**Tech Stack:** TypeScript 5, Node.js test runner, `tsx`, Express, MySQL 8/InnoDB via `mysql2/promise`, BigInt fixed-point arithmetic, SHA-256 canonical JSON, JSON Schema Draft 2020-12, OpenAPI 3.1, Ajv, npm workspaces.

## Global Constraints

- This plan starts after stages 0–2 and `2026-08-09-growth-financial-ledgers-import.md` are complete. It consumes `ActiveWorkspaceContext` from `backend/src/growth-workspace-context.ts`, `CommandContext` from `backend/src/growth-command-context.ts`, `GrowthHttpIdempotencyRepository` from `backend/src/growth-http-idempotency-repository.ts`, its MySQL implementation, and `growth-money.ts`.
- Contract plan C0 exclusively creates and publishes `contracts/openapi/growth-advisor-quote-roi.v1.yaml`, every Growth JSON Schema, release manifest/hash, `backend/src/growth-openapi.ts`, `backend/src/growth-commercial-application.ts`, `backend/src/growth-commercial-runtime-bridge.ts`, and bootstrap. This plan consumes those artifacts and never edits `ai-acquisition.v1.yaml`, `acquisition-openapi.ts`, or legacy generated acquisition types.
- C0's application returns `{ handler, toolPorts: GrowthCommercialToolPorts, integrations, close }`. `GrowthCommercialRuntimeBridge` mirrors the existing acquisition bridge with `install/middleware/close`; server startup installs Growth first and injects `growthRuntime.toolPorts` plus the exact projected Acquisition integrations into the single Acquisition application. Stage 4 adds one required, reference-equal `authoritativeDiscoveryProjectionWriter` through the typed ROI private integration; it never adds a structural field to the C0 `register/execute` tool registry, creates a second Acquisition application, or lets Run/candidate-ingestion construct another writer. Later Advisor handlers close over the same ROI readers.
- Consume stage-2 `AuthoritativeQuoteAsOfReader.listContributionsAsOf(...)`, `DealAuthoritativeQuote`, `QuoteLifecycleEvent`, `DealAuthoritativeQuoteEvent`, `ProbabilityAssessment.v2`, and the quote plan's `CommercialBindingVerifier`/`CommercialBindingSnapshot` from `backend/src/commercial-binding-snapshot.ts`; do not redeclare the verifier or reconstruct quote history from current QuoteCase status.
- Consume stage-3 `AcquisitionCostEntry`, `AcquisitionCostEstimate`, `FinancialFact`, `LedgerVerificationEvent`, and `LedgerSourceHead`; only verified non-reversed actual entries can enter closure.
- Every write and query is scoped to one concrete authorized `workspaceId`. `teamId="all"` is never persisted or used as a synthetic cross-workspace aggregate.
- Capability enforcement lives at every service entry and is repeated on replay/recovery with current Foundation authority, never inferred from a caller-supplied role string. Source-report and allocation/settlement drafts require `ledger.pending.create`; allocation/settlement activation requires `ledger.verify`; cohort create, attestation create, close and reopen require `roi.close`. Cohort projection catch-up is not a public command: Closure passes its currently authorized `roi.close` context through a narrow operation-bound port, while Performance passes its concrete team/workspace read context through a separate read-repair port. Public cohort/closure/Performance reads require one of the server-owned `growth.performance.team.read | growth.performance.workspace.read` visibility paths before query/limit, while Advisor's internal sales-own expected reader retains its narrower actor-scoped port. A denied command performs zero idempotency completion, operation, lifecycle, or business writes.
- Individual canonical subject identity is `sha256(workspaceId + platform + normalized publicActorKey)`. Do not reuse existing owner+team-scoped `individualPartyId` as the cross-owner cohort key.
- Organization canonical identity prefers a validated unified social credit code; otherwise use the normalized public domain. Subjects without either remain unassignable and lower attribution coverage.
- Cohort windows are half-open `[cohortFrom,cohortTo)`. At any sealed cutoff, the same workspace/platform canonical subject belongs to exactly one cohort selected by the lexicographically earliest authoritative tuple `(discoveredAt,sourceRecordedAt,eventId)` using code-point comparison. Platform windows may not overlap. A late-recorded event with an earlier tuple appends a new ownership version and may move current ownership across adjacent cohorts; it never updates/deletes the former version, never changes an older cutoff, and never mutates an already-published Closure snapshot.
- Plan is a slice, not a second membership system. `planId` filters frozen members and attributed sources by `firstPlanId` inside the same cohort/closure.
- Every public Stage-4 mutation calls the Task-2 `RoiCommandExecutor` exactly once; that adapter delegates to Foundation's sole `executeGrowthIdempotentCommand` before any business row lock and unwraps only its `{value,replayed}` result. There is no ROI-owned generic idempotency table and no nested reservation. Each claimed business core receives a stable `domainCommandHash`, probes an immutable row/event/operation carrying that hash before append, and returns the same IDs after business-commit/HTTP-completion loss. Mutable guards use `If-Match`; matching Foundation replay and domain-probe recovery both re-authorize and project the referenced IDs under current capabilities, while a same key with changed payload/revision/path resource returns `409 idempotency_conflict`.
- Every write-service method accepts `CommandContext` plus business input only. The sole mutable revision source is `requireExpectedRevision(context)` after the HTTP adapter parses `If-Match`; HTTP/Pi bodies never contain `expectedRevision`, lease owner, lease expiry, or fencing token.
- Fixed lock orders are mandatory: workspace temporal barrier → allocation source head → active set; workspace temporal barrier → settlement deal guard → source fact → target revenue facts sorted by `(dealId,targetRevenueFactId)` → referenced payment set/item; workspace temporal barrier → closure publication operation row → closure series. Cohort catch-up and evidence reads complete outside the short closure-publication transaction and never hold publication locks.
- Long-running internal catch-up operations and close commands use lease owner, lease expiry, monotonic fencing token, heartbeat, and recovery scan. Stale fencing tokens cannot publish membership or closure state.
- All money is ISO 4217 currency plus JavaScript-safe integer minor units; intermediate multiplication, division, ROI, BPS, and largest-remainder allocation use `BigInt`. No floating-point money is persisted or aggregated.
- BPS allocations sum to exactly 10000. Floor every share, distribute remaining minor units by descending fractional remainder, and break equal remainders by `targetStableKey` lexical order.
- Cohort ownership, allocation, settlement, verification, series, and closure changes are append-only or versioned. Every assignable authoritative discovery event appends one event-unique immutable ownership candidate; a mutable cohort-membership head is only a lock/CAS acceleration hint and never decides or supplies historical membership. Historical membership filters candidates by authoritative `sourceRecordedAt`, then selects the earliest discovery tuple. Never update an old ownership candidate, allocation item, settlement item, closure version, snapshot, or snapshot entry.
- Every Stage-4 append transaction imports the exact Foundation `GrowthTemporalBarrier`, calls `allocateAppend(tx,workspaceId)` before taking any domain lock, persists both returned `recordedAt` and `temporalSequence`, and holds the workspace barrier lock through its business commit. No ROI repository calls `nextGrowthRecordedAt` against a local stream tail. Every public historical boundary normalizes the requested time, calls `sealReadCutoff` exactly once, and passes the resulting opaque `GrowthSealedReadCutoff` to every internal as-of reader; nested readers never reseal or accept a naked `asOf` string. This single barrier prevents new aggregates, clock rollback, and pre-stamped uncommitted writers from rewriting an already-observed cutoff.
- `AttributionAllocationSet` activation and supersession are append-only source-level lifecycle events with monotonic `eventSequence/revision` and explicit `effectiveAt`. The active head is only a command/concurrency guard; expected and closure `asOf` readers rebuild the published set from lifecycle history, including same-millisecond transitions.
- `CashSettlementAllocationSet` follows the same append-only lifecycle rule per source fact. Closure chooses the settlement version recorded and effective at its `asOf`; a later payment/refund reallocation cannot rewrite an earlier closure input.
- A refund freezes `originalPaymentFactId`, `originalPaymentAllocationSetId`, and `originalPaymentAllocationItemId`. An active referenced payment set cannot be reassigned while an active refund references it.
- Closure is per `(workspaceId, cohortId, currency)`. CNY and USD series reopen and close independently; `If-Match` revision permits one winner.
- The sealed cutoff's `effectiveAsOf` constrains both `businessOccurredAt <= effectiveAsOf` and `recordedAt <= effectiveAsOf`. Its `temporalSequence` is internal audit metadata only and never enters query/operation idempotency, evidence/calculation hashes, or DTO identity. Published closure snapshots never change after late facts, reversals, corrected allocations, or reopen.
- Stage 4 reads cost/fact truth only through Finance's `GrowthFinanceServices.verifiedAsOf`, whose exact type is token-only `VerifiedFinancialLedgerSealedReader`: it filters immutable ledger rows and their verification-event prefix by both business time and the sealed recording cutoff, derives status/net from that prefix, and never consults a current verification projection. This plan consumes that exact singleton and never defines a second ledger reader or public self-sealing wrapper.
- Actual ROI is computed only during successful ClosureVersion publication. Without a closure, actual returns `not_computable: cohort_not_closed`; realtime queries never synthesize actual ROI.
- Expected ROI and actual ROI use separate sources, formulas, DTO sections, statuses, and evidence. AI `FinancialValueDecision` never enters either authoritative calculation.
- Keep `backend/src/acquisition-performance-query.ts`, `backend/src/acquisition-performance-router.ts`, old `/api/v1/acquisition/performance`, old `roi:not_computable`, old Pi tool, and its 100-run/500-candidate limits unchanged.
- New `/api/v1/acquisition/growth-performance` uses database aggregation and an independent schema. Any query safety truncation returns actual `not_computable: query_truncated`, never `computed`.
- Repositories are dedicated append-only modules with matching memory/MySQL behavior and `*_MYSQL_SCHEMA_STATEMENTS + ensure*Schema(pool)`. Do not use `backend/src/mysql-store.ts` `persistAll/replaceRows`.
- Every public JSON Schema is closed with `additionalProperties: false`; runtime OpenAPI, published OpenAPI, schema registry, generated types, response conformance, and drift tests move together.
- Do not edit `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend` in this plan.

---

### Task 1: Define workspace-wide canonical acquisition subject keys

**Files:**
- Create: `backend/src/acquisition-canonical-subject.ts`
- Create: `backend/src/acquisition-canonical-subject-test.ts`
- Modify: `backend/src/acquisition-public-identity-resolver.ts`
- Test: `backend/src/acquisition-canonical-subject-test.ts`

**Interfaces:**
- Consumes: `normalizeAcquisitionPublicDomain`, `normalizeAcquisitionPublicCreditCode`, and validated candidate profile data from existing identity resolution.
- Produces: `CanonicalSubjectMaterial`, `canonicalSubjectStableKey(input)`, and `AcquisitionCanonicalSubjectResolver.resolve(workspace, candidate)`.

```ts
export type CanonicalSubjectMaterial =
  | { kind: "individual"; platform: string; publicActorKey: string; canonicalProfileUrl: string | null }
  | { kind: "organization"; platform: string; creditCode: string | null; domain: string | null };

export interface CanonicalSubjectResolution {
  status: "resolved" | "unassignable";
  subjectStableKey: string | null;
  basis: "platform_public_actor" | "organization_credit_code" | "organization_domain" | null;
  canonicalProfileUrl: string | null;
  resolverVersion: "acquisition-canonical-subject.v1";
}
```

- [ ] **Step 1: Write the failing canonical-key test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSubjectStableKey } from "./acquisition-canonical-subject.js";

test("two owners discovering one Douyin actor share a workspace canonical key", () => {
  const first = canonicalSubjectStableKey("workspace-a", { kind: "individual", platform: "DOUYIN", publicActorKey: " Public:Douyin:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ", canonicalProfileUrl: "https://www.douyin.com/user/MS4wLjABAAAA" });
  const second = canonicalSubjectStableKey("workspace-a", { kind: "individual", platform: "douyin", publicActorKey: "public:douyin:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", canonicalProfileUrl: null });
  assert.equal(first.subjectStableKey, second.subjectStableKey);
  assert.equal(first.basis, "platform_public_actor");
});

test("workspace and platform remain part of individual identity", () => {
  const actor = { kind: "individual" as const, platform: "douyin", publicActorKey: "public:douyin:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", canonicalProfileUrl: null };
  assert.notEqual(canonicalSubjectStableKey("workspace-a", actor).subjectStableKey, canonicalSubjectStableKey("workspace-b", actor).subjectStableKey);
  assert.notEqual(canonicalSubjectStableKey("workspace-a", actor).subjectStableKey, canonicalSubjectStableKey("workspace-a", { ...actor, platform: "kuaishou" }).subjectStableKey);
});
```

- [ ] **Step 2: Run the canonical-key test to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-canonical-subject-test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `acquisition-canonical-subject.js`.

- [ ] **Step 3: Implement stable workspace-scoped keys**

```ts
import { createHash } from "node:crypto";
import { normalizeAcquisitionPublicCreditCode, normalizeAcquisitionPublicDomain } from "./acquisition-public-identity-resolver.js";

const hash = (parts: string[]) => createHash("sha256").update(parts.join("\u0000")).digest("hex");
const normalized = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");

export function canonicalSubjectStableKey(workspaceId: string, material: CanonicalSubjectMaterial): CanonicalSubjectResolution {
  const workspace = workspaceId.trim();
  const platform = normalized(material.platform);
  if (!workspace || !platform) return { status: "unassignable", subjectStableKey: null, basis: null, canonicalProfileUrl: null, resolverVersion: "acquisition-canonical-subject.v1" };
  if (material.kind === "individual") {
    const actor = normalized(material.publicActorKey);
    if (!actor) return { status: "unassignable", subjectStableKey: null, basis: null, canonicalProfileUrl: null, resolverVersion: "acquisition-canonical-subject.v1" };
    return { status: "resolved", subjectStableKey: `subject:${hash([workspace, platform, "individual", actor])}`, basis: "platform_public_actor", canonicalProfileUrl: material.canonicalProfileUrl, resolverVersion: "acquisition-canonical-subject.v1" };
  }
  const creditCode = normalizeAcquisitionPublicCreditCode(material.creditCode);
  const domain = normalizeAcquisitionPublicDomain(material.domain);
  const identity = creditCode ? ["credit", creditCode] : domain ? ["domain", domain] : null;
  if (!identity) return { status: "unassignable", subjectStableKey: null, basis: null, canonicalProfileUrl: null, resolverVersion: "acquisition-canonical-subject.v1" };
  return { status: "resolved", subjectStableKey: `subject:${hash([workspace, platform, ...identity])}`, basis: creditCode ? "organization_credit_code" : "organization_domain", canonicalProfileUrl: null, resolverVersion: "acquisition-canonical-subject.v1" };
}
```

Keep the existing public identity resolver behavior intact. Export only normalization/validated material needed by this new resolver; do not change its owner/team `partyId` because existing candidate references rely on it.

- [ ] **Step 4: Run canonical and existing identity tests**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-canonical-subject-test.ts src/acquisition-public-identity-resolver-test.ts src/acquisition-identity-resolution-service-test.ts`

Expected: PASS; existing party IDs are unchanged, while the new subject key deduplicates across owners in one workspace.

- [ ] **Step 5: Commit canonical identity**

```bash
git add backend/src/acquisition-canonical-subject.ts backend/src/acquisition-canonical-subject-test.ts backend/src/acquisition-public-identity-resolver.ts
git commit -m "feat: add workspace canonical acquisition subjects"
```

### Task 2: Project authoritative discoveries and implement versioned in-memory first-touch ownership

**Files:**
- Create: `backend/src/acquisition-authoritative-discovery-projection.ts`
- Create: `backend/src/acquisition-authoritative-discovery-mysql-repository.ts`
- Create: `backend/src/acquisition-authoritative-discovery-projection-test.ts`
- Create: `backend/src/growth-roi-discovery-projection-mysql-test.ts`
- Create: `backend/src/growth-roi-command-executor.ts`
- Create: `backend/src/growth-roi-command-executor-test.ts`
- Create: `backend/src/acquisition-cohort.ts`
- Create: `backend/src/acquisition-cohort-repository.ts`
- Create: `backend/src/growth-roi-test-fixtures.ts`
- Create: `backend/src/acquisition-cohort-test.ts`
- Create: `backend/src/growth-roi-module.ts`
- Create: `backend/src/growth-roi-module-test.ts`
- Modify: `backend/src/acquisition-domain.ts`
- Modify: `backend/src/acquisition-domain-repository.ts`
- Modify: `backend/src/acquisition-domain-service.ts`
- Modify: `backend/src/acquisition-domain-test.ts`
- Modify: `backend/src/acquisition-individual-signal-ingestion.ts`
- Modify: `backend/src/acquisition-discovery-candidate-ingestion-test.ts`
- Modify: `backend/src/acquisition-tool-executor.ts`
- Modify: `backend/src/acquisition-tool-executor-test.ts`
- Modify: `backend/src/acquisition-tool-support-repositories.ts`
- Modify: `backend/src/acquisition-tool-support-repositories-test.ts`
- Modify: `backend/src/acquisition-plan-run-repository.ts`
- Modify: `backend/src/acquisition-plan-run-service.ts`
- Modify: `backend/src/acquisition-plan-run-test.ts`
- Modify: `backend/src/acquisition-plan-execution-recovery-sweeper.ts`
- Modify: `backend/src/acquisition-plan-execution-recovery-sweeper-test.ts`
- Modify: `backend/src/acquisition-mysql-repositories.ts`
- Modify: `backend/src/acquisition-mysql-repositories-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`
- Modify: `backend/src/growth-commercial-application.ts`
- Modify: `backend/src/growth-commercial-composition.ts`
- Modify: `backend/src/growth-commercial-composition-test.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/package.json`
- Test: `backend/src/acquisition-cohort-test.ts`
- Test: `backend/src/acquisition-authoritative-discovery-projection-test.ts`
- Test: `backend/src/growth-roi-discovery-projection-mysql-test.ts`

**Interfaces:**
- Consumes: Task 1 canonical resolver, existing `OutcomeAttributionInput`, C0's exact Foundation `GrowthTemporalBarrier`, `GrowthAcquisitionWorkspaceResolver`, and branded immutable `ResolvedAcquisitionWorkspace {workspaceId,kind,bindingRevision,ownerId,teamId}` from `growth-workspace-context.ts`, the existing Acquisition Run/recovery and direct candidate-ingestion transaction graphs, and an unbounded paged authoritative discovery source. It does not redeclare that Foundation type, introduce a second resolver, or construct an `ActiveWorkspaceContext` adapter.
- Authorizes: `AcquisitionCohortService.create` calls `requireGrowthCapabilities(context.workspace,["roi.close"])` before reservation/domain reads; `get/listMembersAt` require the server-derived team/workspace Growth Performance visibility scope before SQL/limits. Every internal catch-up operation persists `requestedBy`, a hash of its parent `requestIdentity`, closed `authorityKind="roi_close" | "performance_read"`, and `parentClosureOperationId` required only for `roi_close`; it never stores a capability list. Matching retry and `AcquisitionCohortRecoverySweeper` call `AcquisitionCohortRecoveryAuthorizer`: the close branch exact-loads that parent operation and reconstructs current authorization from its persisted workspace/requester/idempotency/request-hash/revision identity, while the performance branch resolves its stored actor/workspace against the team/workspace read path. Parent absence, terminal failure/supersession, identity mismatch, or current denial marks the fenced catch-up operation failed and performs zero checkpoint, membership, ownership-candidate, source, idempotency-completion, or business writes.
- Produces: shared `RoiCommandExecutor`, production `AuthoritativeDiscoveryProjectionWriter`/`MysqlAuthoritativeDiscoveryProjectionRepository`, token-only `AuthoritativeDiscoverySource`, typed `GROWTH_ROI_ACQUISITION_INTEGRATIONS`, public `AcquisitionCohortService.create/get/listMembersAt`, internal `CohortClosureCatchUpPort.ensureForClosure`/`CohortProjectionReadCatchUpPort.ensureAt`, `AcquisitionCohortRepository`, `InMemoryAcquisitionCohortRepository`, immutable `AcquisitionCohortMembershipVersion`, and test-only `cohortCommandContext`/`discoverySource`. Neither catch-up port is an HTTP/tool command or uses `RoiCommandExecutor`: Closure binds it to an existing authorized close operation; Performance accepts one concrete authenticated `ActiveWorkspaceContext` plus the already sealed cutoff. Both persist the real actor, recheck their narrow authority, and perform only idempotent projection-cache completion. Neither can accept/forge caller capabilities, attribution edits, a naked time, or business input.

```ts
export type RoiMutationRouteTemplate =
  | "/api/v1/acquisition/cohorts"
  | "/api/v1/acquisition/cohorts/:id/attestations"
  | "/api/v1/acquisition/cohorts/:id/close"
  | "/api/v1/acquisition/roi-closures/:closureVersionId/reopen"
  | "/api/v1/acquisition/attribution-allocation-sets"
  | "/api/v1/acquisition/attribution-allocation-sets/:id/activate"
  | "/api/v1/finance/source-reports"
  | "/api/v1/finance/settlement-allocation-sets"
  | "/api/v1/finance/settlement-allocation-sets/:id/activate";
export interface RoiCommandSpec {
  method: "POST";
  /** Foundation-frozen closed route template; concrete path params live only in requestHash. */
  canonicalPath: RoiMutationRouteTemplate;
  resourceKind: "cohort" | "source_report" | "attribution_set" | "settlement_set" | "attestation" | "closure" | "closure_series";
}
export interface RoiCommandExecutionIds {
  resourceId: string | null;
  operationId: string | null;
}
export interface RoiCommandExecutor {
  execute<T>(
    context: CommandContext,
    spec: RoiCommandSpec,
    hooks: {
      authorizeAndProject(ids: RoiCommandExecutionIds): Promise<T>;
      executeClaimed(domainCommandHash: `sha256:${string}`): Promise<RoiCommandExecutionIds>;
    }
  ): Promise<T>;
}

import type { ResolvedAcquisitionWorkspace } from "./growth-workspace-context.js";

export interface AuthoritativeDiscoveryAppendInput {
  eventId: string; platform: string; candidateId: string; ownerId: string;
  discoveredAt: string; material: CanonicalSubjectMaterial;
  attribution: OutcomeAttributionInput;
  origin: "acquisition_run" | "candidate_ingestion";
  payloadHash: `sha256:${string}`;
}
export interface AuthoritativeDiscoveryProjectionRow
extends AuthoritativeDiscoveryAppendInput {
  workspaceId: string; sourceRecordedAt: string;
  sourceTemporalSequence: number;
}
export interface AuthoritativeDiscoveryProjectionTransaction
extends GrowthTemporalTransaction {
  lockDiscoverySourceGuardForUpdate(workspaceId: string, platform: string): Promise<void>;
  appendAuthoritativeDiscovery(row: AuthoritativeDiscoveryProjectionRow): Promise<"inserted" | "replayed">;
}
export interface AuthoritativeDiscoveryProjectionWriter {
  /** Must be the first participant called inside the existing business transaction. */
  appendBatchFirst(
    transaction: AuthoritativeDiscoveryProjectionTransaction,
    workspace: ResolvedAcquisitionWorkspace,
    events: readonly AuthoritativeDiscoveryAppendInput[]
  ): Promise<readonly AuthoritativeDiscoveryProjectionRow[]>;
}
export interface GrowthRoiAcquisitionIntegrations {
  authoritativeDiscoveryProjectionWriter: AuthoritativeDiscoveryProjectionWriter;
}
export const GROWTH_ROI_ACQUISITION_INTEGRATIONS:
  GrowthPrivateServiceKey<GrowthRoiAcquisitionIntegrations>;
export interface GrowthRoiDiscoveryServices {
  commandExecutor: RoiCommandExecutor;
  authoritativeDiscoveries: AuthoritativeDiscoverySource;
  acquisitionIntegrations: GrowthRoiAcquisitionIntegrations;
}
export const GROWTH_ROI_DISCOVERY_SERVICES:
  GrowthPrivateServiceKey<GrowthRoiDiscoveryServices>;

export interface AuthoritativeDiscoverySource {
  listDiscoveries(workspaceId: string, query: { platform: string; from: string; to: string; cutoff: GrowthSealedReadCutoff; after: { sourceRecordedAt: string; eventId: string } | null; limit: number }): Promise<{ items: Array<{ eventId: string; candidateId: string; ownerId: string; discoveredAt: string; sourceRecordedAt: string; sourceTemporalSequence: number; material: CanonicalSubjectMaterial; attribution: OutcomeAttributionInput }>; next: { sourceRecordedAt: string; eventId: string } | null }>;
  getWatermark(workspaceId: string, query: { platform: string; cutoff: GrowthSealedReadCutoff }): Promise<{ lastSourceRecordedAt: string | null; lastEventId: string | null; lastSourceTemporalSequence: number | null; eventCount: number; eventSetHash: `sha256:${string}` }>;
}

export interface AcquisitionCohort {
  id: string; workspaceId: string; platform: string; cohortFrom: string;
  cohortTo: string; definitionVersion: string; firstTouchRuleVersion: string;
  status: "active" | "superseded"; createdAt: string; temporalSequence: number;
}
export interface AcquisitionCanonicalSubject {
  id: string; workspaceId: string; platform: string; subjectStableKey: string;
  canonicalProfileUrl: string | null; createdAt: string;
}
export interface AcquisitionCohortMember {
  id: string; cohortId: string; workspaceId: string; platform: string;
  canonicalSubjectId: string; subjectStableKey: string; primaryCandidateId: string;
  firstEventId: string; firstDiscoveredAt: string; firstSourceRecordedAt: string; firstSourceTemporalSequence: number; firstPlanId: string; firstRunId: string;
  firstShardId: string; attributionSnapshot: OutcomeAttributionInput;
  ownershipVersionId: string; appendRevision: number;
  projectionRecordedAt: string; projectionTemporalSequence: number;
}
export interface AcquisitionCohortMembershipVersion {
  id: string; cohortMemberId: string; workspaceId: string; platform: string;
  subjectStableKey: string; cohortId: string; appendRevision: number;
  eventId: string; candidateId: string; planId: string; runId: string;
  discoveredAt: string; sourceRecordedAt: string; sourceTemporalSequence: number;
  attributionSnapshot: OutcomeAttributionInput; becameHead: boolean;
  previousHeadVersionId: string | null;
  projectionRecordedAt: string; projectionTemporalSequence: number;
}
export interface AcquisitionCohortMemberSource {
  cohortMemberId: string; eventId: string; candidateId: string; evidenceId: string | null;
  ownerId: string; discoveredAt: string; sourceRecordedAt: string; sourceTemporalSequence: number;
  projectionRecordedAt: string; projectionTemporalSequence: number;
}
export interface AcquisitionCohortService {
  create(context: CommandContext, input: { platform: string; cohortFrom: string; cohortTo: string; definitionVersion: string; firstTouchRuleVersion: string }): Promise<AcquisitionCohort>;
  get(workspace: ActiveWorkspaceContext, cohortId: string): Promise<AcquisitionCohort | null>;
  listMembersAt(workspace: ActiveWorkspaceContext, cohortId: string, cutoff: GrowthSealedReadCutoff): Promise<Array<AcquisitionCohortMember & { sources: AcquisitionCohortMemberSource[] }>>;
}
export interface CohortCatchUpResult {
  inserted: number; reassigned: number; aliased: number; unassignable: number; complete: boolean;
  sourceWatermark: { lastSourceRecordedAt: string | null; lastEventId: string | null; lastSourceTemporalSequence: number | null; eventCount: number; eventSetHash: `sha256:${string}` };
}
export interface CohortProjectionReadCatchUpPort {
  ensureAt(workspace: ActiveWorkspaceContext, cohortId: string, cutoff: GrowthSealedReadCutoff): Promise<CohortCatchUpResult>;
}
export interface CohortClosureCatchUpPort {
  /** Closure-internal cache repair. The already-authorized close owns command identity/fencing. */
  ensureForClosure(context: CommandContext, input: { closureOperationId: string; cohortId: string; cutoff: GrowthSealedReadCutoff }): Promise<CohortCatchUpResult>;
}
export interface AcquisitionCohortCatchUpOperation {
  id: string; workspaceId: string; cohortId: string; cutoffEffectiveAsOf: string;
  initialCutoffTemporalSequence: number;
  requestedBy: string; authorityKind: "roi_close" | "performance_read";
  parentClosureOperationId: string | null;
  requestIdentityHash: `sha256:${string}`;
  status: "queued" | "running" | "succeeded" | "failed";
  checkpoint: { sourceRecordedAt: string; eventId: string } | null;
  leaseOwner: string | null; leaseExpiresAt: string | null; fencingToken: number;
  errorCode: "capability_forbidden" | "stale_fencing_token" | null;
}
export interface AcquisitionCohortRecoveryAuthorizer {
  authorize(operation: AcquisitionCohortCatchUpOperation): Promise<
    | { authorityKind: "roi_close"; parentClosureOperationId: string; context: CommandContext }
    | { authorityKind: "performance_read"; workspace: ActiveWorkspaceContext }
  >;
}
```

- [ ] **Step 1: Write the failing first-touch test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { AcquisitionCohortService } from "./acquisition-cohort.js";
import { InMemoryAcquisitionCohortRepository } from "./acquisition-cohort-repository.js";
import { cohortCommandContext, cohortServiceFixture, discoverySource, fixtureWatermark, lateRecordedDiscoveryFixture, sealedCutoff } from "./growth-roi-test-fixtures.js";

test("first authoritative discovery owns membership and later discoveries become sources", async () => {
  const discoveries = discoverySource([
    { eventId: "event-1", candidateId: "candidate-1", ownerId: "sales-a", discoveredAt: "2026-08-01T01:00:00.000Z", recordedAt: "2026-08-01T01:00:01.000Z", actorKey: "public:douyin:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", planId: "plan-a" },
    { eventId: "event-2", candidateId: "candidate-2", ownerId: "sales-b", discoveredAt: "2026-08-02T01:00:00.000Z", recordedAt: "2026-08-02T01:00:01.000Z", actorKey: "public:douyin:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", planId: "plan-b" }
  ]);
  const fixture = cohortServiceFixture({
    repository: new InMemoryAcquisitionCohortRepository(),
    discoveries
  });
  const service = fixture.service;
  const context = cohortCommandContext("workspace-a", "admin-a");
  const created = await service.create(context, { platform: "douyin", cohortFrom: "2026-08-01T00:00:00.000Z", cohortTo: "2026-08-08T00:00:00.000Z", definitionVersion: "weekly.v1", firstTouchRuleVersion: "first-authoritative-discovery.v1" });
  const cutoff = await sealedCutoff(context.workspace, "2026-08-09T00:00:00.000Z");
  const result = await fixture.closureCatchUp.ensureForClosure(context, { closureOperationId: "close-operation-1", cohortId: created.id, cutoff });
  const members = await service.listMembersAt(context.workspace, created.id, cutoff);
  assert.deepEqual(result, {
    inserted: 1, reassigned: 0, aliased: 1, unassignable: 0, complete: true,
    sourceWatermark: fixtureWatermark("event-2", 2)
  });
  assert.equal(members[0]?.firstPlanId, "plan-a");
  assert.equal(members[0]?.sources.length, 2);
  assert.equal(discoveries.listCalls.every((call) => call.cutoff === cutoff), true);
  assert.equal(discoveries.watermarkCalls[0]?.cutoff, cutoff);
  await assert.rejects(
    fixture.closureCatchUp.ensureForClosure(context, { closureOperationId: "close-operation-1", cohortId: created.id,
      cutoff: await sealedCutoff(cohortCommandContext("workspace-b", "admin-b").workspace, "2026-08-09T00:00:00.000Z")
    }),
    /sealed_cutoff_workspace_mismatch/
  );
});

test("late-recorded backfill before the discovery-time cursor is still captured", async () => {
  const fixture = lateRecordedDiscoveryFixture({
    initial: [{ eventId: "event-2", discoveredAt: "2026-08-02T00:00:00.000Z", recordedAt: "2026-08-02T01:00:00.000Z" }],
    late: [{ eventId: "event-1", discoveredAt: "2026-08-01T00:00:00.000Z", recordedAt: "2026-08-03T01:00:00.000Z" }]
  });
  await fixture.catchUp("2026-08-02T23:59:59.999Z");
  await fixture.appendLateRows();
  await fixture.catchUp("2026-08-03T23:59:59.999Z");
  assert.deepEqual((await fixture.listSources()).map((source) => source.candidateId).sort(), ["candidate-event-1", "candidate-event-2"]);
});

test("a late earlier discovery appends ownership into the adjacent earlier cohort", async () => {
  const fixture = lateRecordedDiscoveryFixture({
    cohorts: [
      { id: "cohort-early", from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" },
      { id: "cohort-late", from: "2026-08-08T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" }
    ],
    initial: [{ eventId: "event-late-window", discoveredAt: "2026-08-09T00:00:00.000Z", recordedAt: "2026-08-09T01:00:00.000Z" }],
    late: [{ eventId: "event-early-window", discoveredAt: "2026-08-07T00:00:00.000Z", recordedAt: "2026-08-10T01:00:00.000Z" }]
  });
  const oldCutoff = await fixture.seal("2026-08-09T23:59:59.999Z");
  await fixture.catchUpCohort("cohort-late", oldCutoff);
  const oldLate = await fixture.listMembersAt("cohort-late", oldCutoff);
  await fixture.appendLateRows();
  const newCutoff = await fixture.seal("2026-08-10T23:59:59.999Z");
  const reassignment = await fixture.catchUpCohort("cohort-early", newCutoff);

  assert.equal(reassignment.reassigned, 1);
  assert.deepEqual((await fixture.listMembersAt("cohort-late", oldCutoff)).map((row) => row.id), oldLate.map((row) => row.id));
  assert.equal((await fixture.listMembersAt("cohort-late", newCutoff)).length, 0);
  assert.deepEqual((await fixture.listMembersAt("cohort-early", newCutoff)).map((row) => row.firstEventId), ["event-early-window"]);
  assert.deepEqual((await fixture.listOwnershipVersions()).map((row) => [row.cohortId, row.appendRevision, row.becameHead]), [
    ["cohort-late", 1, true],
    ["cohort-early", 2, true]
  ]);
});

test("reverse cohort catch-up preserves the old cutoff and ignores cache projection time", async () => {
  const fixture = lateRecordedDiscoveryFixture({
    cohorts: [
      { id: "cohort-early", from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" },
      { id: "cohort-late", from: "2026-08-08T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" }
    ],
    initial: [
      { eventId: "event-late-window", discoveredAt: "2026-08-09T00:00:00.000Z", recordedAt: "2026-08-09T01:00:00.000Z" },
      { eventId: "event-early-window", discoveredAt: "2026-08-07T00:00:00.000Z", recordedAt: "2026-08-10T01:00:00.000Z" }
    ],
    projectOnlyAfterSeal: true
  });
  const oldCutoff = await fixture.seal("2026-08-09T23:59:59.999Z");
  await fixture.catchUpCohort("cohort-early", await fixture.seal("2026-08-10T23:59:59.999Z"));
  await fixture.catchUpCohort("cohort-late", await fixture.seal("2026-08-10T23:59:59.999Z"));
  const newCutoff = await fixture.seal("2026-08-10T23:59:59.999Z");

  assert.deepEqual((await fixture.listMembersAt("cohort-late", oldCutoff)).map((row) => row.firstEventId), ["event-late-window"]);
  assert.equal((await fixture.listMembersAt("cohort-early", oldCutoff)).length, 0);
  assert.deepEqual((await fixture.listMembersAt("cohort-early", newCutoff)).map((row) => row.firstEventId), ["event-early-window"]);
  assert.equal((await fixture.listMembersAt("cohort-late", newCutoff)).length, 0);
  assert.equal((await fixture.listOwnershipVersions()).every((row) => row.projectionRecordedAt > oldCutoff.effectiveAsOf), true);
  assert.deepEqual((await fixture.listOwnershipVersions()).map((row) => row.eventId).sort(), ["event-early-window", "event-late-window"]);
});
```

In `acquisition-authoritative-discovery-projection-test.ts`, exercise the same required writer through both existing Acquisition entry paths, not a fixture-only `AuthoritativeDiscoverySource`:

```ts
test("Run and candidate ingestion share the one C0-projected ROI writer", async () => {
  const fixture = await acquisitionProjectionIntegrationFixture();
  assert.equal(fixture.application.authoritativeDiscoveryProjectionWriter, fixture.roiPrivateIntegration.authoritativeDiscoveryProjectionWriter);
  await fixture.completeRunCandidate("run-event-1");
  await fixture.ingestAttributedCandidate("ingestion-event-1");
  assert.deepEqual((await fixture.sourceRows()).map((row) => [row.eventId, row.origin]), [
    ["ingestion-event-1", "candidate_ingestion"],
    ["run-event-1", "acquisition_run"]
  ]);
  assert.equal(fixture.distinctWriterInstances.size, 1);
  assert.equal(fixture.activeWorkspaceContextsCreated, 0);
  assert.equal(fixture.writerWorkspaceInputs.every((value) => fixture.acquisitionWorkspaceResolveResults.includes(value)), true);
});

test("background Run recovery resolves persisted Acquisition scope without fabricating a user context", async () => {
  const fixture = await acquisitionProjectionIntegrationFixture({ crashRunBeforeCandidateCommit: true });
  await fixture.recoverRunFromPersistedScope({ ownerId: "sales-a", teamId: "team-a" });
  assert.deepEqual((await fixture.sourceRows()).map((row) => row.eventId), ["recovered-run-event-1"]);
  assert.equal(fixture.activeWorkspaceContextsCreated, 0);
  assert.deepEqual(fixture.acquisitionWorkspaceResolveCalls, [{ ownerId: "sales-a", teamId: "team-a" }]);
  assert.equal(fixture.writerWorkspaceInputs[0], fixture.acquisitionWorkspaceResolveResults[0]);
});

test("direct ingestion uses the resolver token and rejects an unbound or cross-team scope", async () => {
  const fixture = await acquisitionProjectionIntegrationFixture();
  await fixture.ingestAttributedCandidate("direct-valid", { ownerId: "sales-a", teamId: "team-a" });
  await assert.rejects(
    fixture.ingestAttributedCandidate("direct-cross-team", { ownerId: "sales-a", teamId: "team-b" }),
    /acquisition_workspace_unresolved/
  );
  assert.deepEqual((await fixture.sourceRows()).map((row) => row.eventId), ["direct-valid"]);
  assert.equal(fixture.activeWorkspaceContextsCreated, 0);
});

test("unattributed direct ingestion is not silently promoted to cohort authority", async () => {
  const fixture = await acquisitionProjectionIntegrationFixture();
  await fixture.ingestCandidateWithoutPersistedRunAttribution("manual-event-1");
  assert.deepEqual(await fixture.sourceRows(), []);
  assert.deepEqual(fixture.projectionSkips, [{ eventId: "manual-event-1", reason: "authoritative_attribution_missing" }]);
});

test("business commit followed by lost Foundation completion reuses the domain command probe", async () => {
  const fixture = roiCommandExecutorFixture({ failFirstCompletion: true, leaseDurationMs: 1_000 });
  const execute = () => fixture.executor.execute(
    fixture.context({ key: "draft-1", requestHash: `sha256:${"a".repeat(64)}` }),
    { method: "POST", canonicalPath: "/api/v1/acquisition/attribution-allocation-sets", resourceKind: "attribution_set" },
    {
      authorizeAndProject: (ids) => fixture.authorizeAndProject(ids),
      executeClaimed: (domainCommandHash) => fixture.insertOrProbe(domainCommandHash)
    }
  );
  await assert.rejects(execute(), /injected_completion_loss/);
  await fixture.advancePastLease();
  const replay = await execute();
  assert.equal(replay.id, "allocation-set-stable");
  assert.equal(fixture.domainRows.length, 1);
  assert.equal(fixture.businessAppendCalls, 1);
});

test("completed replay reauthorizes and a reused key for another path resource conflicts", async () => {
  const fixture = roiCommandExecutorFixture();
  await fixture.executeResource("allocation-a", { key: "activate-shared", capabilities: ["ledger.verify"] });
  await fixture.revoke("ledger.verify");
  await assert.rejects(
    fixture.executeResource("allocation-a", { key: "activate-shared", capabilities: [] }),
    /capability_forbidden/
  );
  await assert.rejects(
    fixture.executeResource("allocation-b", { key: "activate-shared", capabilities: ["ledger.verify"] }),
    /idempotency_conflict/
  );
  assert.equal(fixture.businessWritesFor("allocation-b"), 0);
});
```

- [ ] **Step 2: Run the cohort test to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/growth-roi-command-executor-test.ts src/acquisition-authoritative-discovery-projection-test.ts src/acquisition-cohort-test.ts src/acquisition-application-test.ts`

Expected: FAIL because the Foundation-backed ROI command adapter, production projection writer/repository, typed ROI integration, and versioned cohort modules are absent.

- [ ] **Step 3: Implement the production projection, versioned first-touch ownership, and paged catch-up**

Implement `FoundationRoiCommandExecutor` in `growth-roi-command-executor.ts`. It receives the exact Foundation `httpIdempotency` repository; it does not expose `reserve/complete` to business services or create storage. For every public mutation it computes one stable domain command hash from the server-owned command identity, calls `executeGrowthIdempotentCommand` exactly once, passes only IDs through Foundation completion, and always invokes the service-specific current-authority projector on both claimed success and completed replay:

```ts
async execute<T>(context: CommandContext, spec: RoiCommandSpec, hooks: {
  authorizeAndProject(ids: RoiCommandExecutionIds): Promise<T>;
  executeClaimed(domainCommandHash: `sha256:${string}`): Promise<RoiCommandExecutionIds>;
}): Promise<T> {
  const domainCommandHash = hashCanonicalJson({
    workspaceId: context.workspace.workspaceId,
    actorId: context.actorId,
    method: spec.method,
    canonicalPath: spec.canonicalPath,
    idempotencyKey: context.idempotencyKey,
    requestHash: context.requestHash,
    expectedRevision: context.expectedRevision ?? null
  });
  const executed = await executeGrowthIdempotentCommand({
    repository: this.foundation.httpIdempotency,
    reservation: {
      workspaceId: context.workspace.workspaceId,
      actorId: context.actorId,
      method: spec.method,
      canonicalPath: spec.canonicalPath,
      key: context.idempotencyKey,
      requestHash: context.requestHash,
      attemptedAt: this.now(),
      leaseOwner: crypto.randomUUID(),
      leaseDurationMs: 30_000
    }
  },
  (resourceId, operationId) => hooks.authorizeAndProject({ resourceId, operationId }),
  () => hooks.executeClaimed(domainCommandHash));
  return executed.value;
}
```

Each service owns its Foundation-frozen closed route-template `RoiCommandSpec` and typed projector. `canonicalPath` always remains the exact `:id`/`:closureVersionId` template used by `GrowthCommandContextFactory`; the router alone supplies validated `pathParams`, and Foundation's `context.requestHash` already hashes `{method,canonicalPath,pathParams,payload,expectedRevision}`. No service interpolates/encodes a concrete URL, and no caller supplies a path, kind, hash, result resource ID, or operation ID. Including that request hash and the server-derived expected revision in the domain hash makes reuse of one key for another path resource/revision conflict before a domain append. A claimed core persists `domainCommandHash`, `requestHash`, and `requestedBy` on the created immutable resource/lifecycle event/operation under a unique workspace+command constraint, and begins with a non-locking indexed probe of that hash. A match exact-checks request/actor/kind/concrete resource and returns the stored IDs without allocating a temporal stamp; a mismatch fails closed. On a miss, the mutation transaction allocates the Foundation temporal barrier before any domain lock. Thus recovery after business commit but before Foundation completion is read-only at the domain layer. A completed replay first repeats current capability and workspace/resource-kind checks, then projects from IDs; it never returns a cached body. Add the executor to Task 2's base ROI services and inject that one instance into Cohort and all later HTTP mutation services.

Create `acquisition_authoritative_discovery_source_guards` and append-only `acquisition_authoritative_discoveries` in `acquisition-authoritative-discovery-mysql-repository.ts`; export `AUTHORITATIVE_DISCOVERY_MYSQL_SCHEMA_STATEMENTS`, `ensureAuthoritativeDiscoveryMysqlSchema(pool)`, `MysqlAuthoritativeDiscoveryProjectionRepository`, and the same instance as both `AuthoritativeDiscoveryProjectionWriter` and `AuthoritativeDiscoverySource`. A discovery row stores the non-null server event ID, workspace/platform/candidate/owner, canonical material, complete persisted `OutcomeAttributionInput`, `discovered_at`, Foundation-owned `source_recorded_at/source_temporal_sequence`, origin and canonical payload hash. Require unique `(workspace_id,platform,event_id)`, index `(workspace_id,platform,source_recorded_at,event_id)`, and reject a duplicate event ID unless every immutable field and `payload_hash` matches byte-for-byte. There is no foreign key that would force the projection insert after a candidate/run lock; the same business transaction supplies atomicity and referential validation.

```sql
CREATE TABLE acquisition_authoritative_discovery_source_guards (
  workspace_id VARCHAR(191) NOT NULL,
  platform VARCHAR(64) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id,platform)
) ENGINE=InnoDB;
CREATE TABLE acquisition_authoritative_discoveries (
  workspace_id VARCHAR(191) NOT NULL,
  platform VARCHAR(64) NOT NULL,
  event_id VARCHAR(128) NOT NULL,
  candidate_id VARCHAR(128) NOT NULL,
  owner_id VARCHAR(191) NOT NULL,
  discovered_at DATETIME(3) NOT NULL,
  source_recorded_at DATETIME(3) NOT NULL,
  source_temporal_sequence BIGINT UNSIGNED NOT NULL,
  origin ENUM('acquisition_run','candidate_ingestion') NOT NULL,
  canonical_subject_material JSON NOT NULL,
  attribution_snapshot JSON NOT NULL,
  payload_hash CHAR(71) NOT NULL,
  PRIMARY KEY (workspace_id,platform,event_id),
  KEY idx_authoritative_discovery_page (workspace_id,platform,source_recorded_at,event_id),
  KEY idx_authoritative_discovery_window (workspace_id,platform,discovered_at,source_recorded_at,event_id)
) ENGINE=InnoDB;
```

`appendBatchFirst` accepts only Foundation's exact branded immutable `ResolvedAcquisitionWorkspace` plus the transaction adapter already bound to the existing physical Acquisition connection. It rejects a blank/`all` workspace, resolver binding mismatch, or any event whose persisted owner/team/Run attribution does not equal `workspace.ownerId/workspace.teamId/workspace.bindingRevision`. It never accepts `ActiveWorkspaceContext`, a structural lookalike, or caller workspace text; actor, role, capability, and request fields do not exist on the token.

Both foreground and recovered Run execution resolve the persisted Run `{ownerId,teamId}` on every attempt through the injected reference-equal Foundation resolver before opening the projection transaction; direct candidate ingestion does the same for its persisted Acquisition scope. A null/stale/cross-team resolution fails before temporal or domain writes. The writer sorts the closed batch by `(platform,eventId)`, validates every event's owner/team/Run attribution against that resolver credential, allocates one consecutive Foundation stamp per event while retaining the workspace barrier, and completes **all** allocations before any Run, candidate, evidence, identity, or projection source-guard lock; it then locks distinct source guards in code-point platform order and appends the stamped rows. `acquisition-plan-run-service.ts` pre-generates the exact `candidate.discovered` event IDs and passes those same IDs plus the fully persisted Run/Plan/shard/decision attribution through `acquisition-plan-run-repository.ts`; `acquisition-plan-execution-recovery-sweeper.ts` re-enters that same resolver-gated service path, and the projection and Run events commit or roll back together. `acquisition-tool-executor.ts` and `acquisition-individual-signal-ingestion.ts` carry the canonical candidate/evidence material into the attributed candidate-ingestion transaction. Refactor `acquisition-tool-support-repositories.ts` so its candidate-directory upsert can bind to the already-open `AcquisitionDomainRepository` physical transaction; `acquisition-domain-service.ts`/`acquisition-domain-repository.ts` open that unit of work, invoke the same writer as its first transaction participant, and then perform evidence, identity-alias and candidate writes on that connection. The transaction-bound directory must not acquire a second connection or commit independently. A direct ingestion without complete persisted `OutcomeAttributionInput` records the closed `authoritative_attribution_missing` diagnostic and does not become a cohort source. No path constructs an `ActiveWorkspaceContext` or role/capability list for projection; no after-commit callback, outbox poller, presentation scan, or best-effort repair may create authoritative rows.

Extend the Task-2 base `growth-roi-module.ts` to construct this one projection repository, freeze/provide `GROWTH_ROI_DISCOVERY_SERVICES`, and freeze/provide `GROWTH_ROI_ACQUISITION_INTEGRATIONS` containing the exact same writer reference. Extend C0's sole `GrowthAcquisitionIntegrations` in `growth-commercial-application.ts` with required `authoritativeDiscoveryProjectionWriter`; `growth-commercial-composition.ts` alone requires the ROI private integration and projects that reference after module installation, while `server.ts` passes it into the one `createAcquisitionApplication` call. `CreateAcquisitionApplicationOptions` requires the writer, passes it by identity to the Run and domain/candidate-ingestion graphs, and has no default. Missing/partial/lookalike private integration, a second writer, or a writer whose Foundation barrier is not the reference-equal singleton fails startup before Acquisition publishes a handler. `growth-commercial-composition-test.ts`, `growth-roi-module-test.ts`, and `acquisition-application-test.ts` assert exact identity and one construction. Task 13 extends this already-created ROI module/resources; it does not construct or replace the discovery repository/writer.

The production reader preserves these exact token-only calls: `listDiscoveries(workspaceId,{platform,from,to,cutoff,after,limit})` and `getWatermark(workspaceId,{platform,cutoff})`. The former requires `cutoff.workspaceId===workspaceId`, applies `discovered_at >= from AND discovered_at < to AND source_recorded_at <= cutoff.effectiveAsOf` before its code-point `(source_recorded_at,event_id)` cursor/order and `limit+1`; the latter applies the identical workspace/platform/cutoff identity and derives exact `eventCount + lastSourceRecordedAt + lastEventId + lastSourceTemporalSequence + eventSetHash` from all selected immutable platform rows at that cutoff. Neither method seals, accepts a naked time, consults mutable presentation state, or pages by `discoveredAt`. `growth-roi-test-fixtures.ts` keeps `discoverySource(rows)` only as a parity fake with the same token checks, ordering, bounds and canonical hashes; it is never the production source.

Create cohort, canonical subject, alias, logical member, immutable ownership-version, and member-source records. Public `create` requires current `roi.close` and calls `RoiCommandExecutor.execute` exactly once with the concrete collection path; its private `createClaimed(context,input,domainCommandHash)` first probes the cohort row carrying that hash, then on a miss calls the Foundation singleton barrier before the workspace+platform cohort guard, rejects overlapping half-open windows, and stores `domainCommandHash/requestHash/requestedBy` on the immutable cohort. The replay projector reauthorizes and loads only that returned cohort ID. For every source event, `upsertFirstTouch` starts a separate barrier-first transaction, appends the immutable subject source exactly once, locks the global `(workspaceId,platform,subjectStableKey)` membership head, and compares the candidate tuple by exact ISO/code-point order:

```ts
const discoveryOrder = (event: { discoveredAt: string; sourceRecordedAt: string; eventId: string }) =>
  `${event.discoveredAt}\u0000${event.sourceRecordedAt}\u0000${event.eventId}`;
const compareDiscoveryOrder = (left: ReturnType<typeof discoveryOrder>, right: ReturnType<typeof discoveryOrder>) =>
  left < right ? -1 : left > right ? 1 : 0;
```

Every assignable, previously unseen authoritative `eventId` appends one immutable ownership candidate/version, even when its tuple is equal to or later than the current head. With no head it also creates the logical member/head and returns `"inserted"`. With an earlier tuple it marks the new candidate `becameHead=true`, records `previousHeadVersionId`, CAS-advances only the acceleration head, and returns `"reassigned"`. With an equal/later tuple it appends the candidate with `becameHead=false`, leaves the head untouched, and returns `"aliased"`. Exact event replay returns the stored outcome without a second candidate; changed-payload event reuse fails. No branch updates an existing candidate or source row.

`listMembersAt` and every Closure/expected-ROI membership reader **ignore the head and cache append time**. They first select event-unique ownership candidates satisfying `sourceRecordedAt <= cutoff.effectiveAsOf`, then for each logical subject choose the code-point minimum `(discoveredAt,sourceRecordedAt,eventId)`, and only afterward filter that selected candidate's `cohortId` to the requested cohort. `projectionRecordedAt/projectionTemporalSequence` are audit/cache metadata: a first catch-up performed after a cutoff must still project and return a candidate whose authoritative `sourceRecordedAt` is within that cutoff. This makes catch-up order irrelevant: processing the Aug-10-recorded/Aug-7-discovered earlier cohort before the Aug-9-recorded/Aug-9-discovered later cohort still yields the later cohort at an Aug-9 cutoff and only the earlier cohort at an Aug-10 cutoff. Closure freezes the selected ownership-candidate IDs plus source watermark; an already-published snapshot never re-resolves them.

The minimum GREEN private coordinator preserves the exact token-only discovery calls and accounts for reassignment explicitly. Its two narrow adapters perform authority validation first: the Closure adapter verifies the existing running close operation belongs to the same current `CommandContext`/cohort and derives `requestIdentity="roi-close:"+closureOperationId`; the Performance adapter verifies the concrete read scope and derives `requestIdentity` from `(workspaceId,actorId,cohortId,cutoff.effectiveAsOf)`. Neither adapter calls Foundation HTTP idempotency or exposes a route:

```ts
private async projectMembersClaimed(authority: { workspace: ActiveWorkspaceContext; requestedBy: string; authorityKind: "roi_close" | "performance_read"; parentClosureOperationId: string | null; requestIdentity: string }, cohortId: string, cutoff: GrowthSealedReadCutoff): Promise<CohortCatchUpResult> {
  const cohort = await this.repository.requireActive(authority.workspace.workspaceId, cohortId);
  const operation = await this.repository.createOrReplayCatchUp({
    workspaceId: authority.workspace.workspaceId,
    cohortId,
    cutoff,
    requestedBy: authority.requestedBy,
    authorityKind: authority.authorityKind,
    parentClosureOperationId: authority.parentClosureOperationId,
    requestIdentity: authority.requestIdentity
  });
  const lease = await this.repository.claimCatchUp(operation.id, crypto.randomUUID(), this.now(), 30_000);
  if (lease === null) throw new CohortError("catch_up_in_progress", 409);
  let after = await this.repository.readCheckpoint(operation.id, lease);
  let inserted = 0, reassigned = 0, aliased = 0, unassignable = 0;
  for (;;) {
    const page = await this.discoveries.listDiscoveries(authority.workspace.workspaceId, {
      platform: cohort.platform, from: cohort.cohortFrom, to: cohort.cohortTo,
      cutoff, after, limit: 250
    });
    for (const event of page.items) {
      const resolution = canonicalSubjectStableKey(authority.workspace.workspaceId, event.material);
      if (resolution.status === "unassignable" || resolution.subjectStableKey === null) {
        await this.repository.recordUnassignable(operation.id, event.eventId, lease);
        unassignable += 1;
        continue;
      }
      const outcome = await this.repository.upsertFirstTouch({ cohort, event, resolution, lease });
      if (outcome === "inserted") inserted += 1;
      else if (outcome === "reassigned") reassigned += 1;
      else aliased += 1;
    }
    await this.repository.advanceCheckpoint(operation.id, page.next, lease);
    await this.repository.renewCatchUp(lease, this.now(), 30_000);
    if (page.next === null) {
      const sourceWatermark = await this.discoveries.getWatermark(
        authority.workspace.workspaceId,
        { platform: cohort.platform, cutoff }
      );
      const result = { inserted, reassigned, aliased, unassignable, complete: true, sourceWatermark };
      await this.repository.completeCatchUp(operation.id, lease, result);
      return result;
    }
    after = page.next;
  }
}
```

- [ ] **Step 4: Verify production projection atomicity and first-touch time travel**

Add the initial dedicated MySQL gate:

```json
{
  "scripts": {
    "test:growth-roi:mysql": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/growth-roi-discovery-projection-mysql-test.ts"
  }
}
```

Run:

```bash
cd backend
NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/growth-roi-command-executor-test.ts src/acquisition-authoritative-discovery-projection-test.ts src/acquisition-cohort-test.ts src/acquisition-plan-run-test.ts src/acquisition-plan-execution-recovery-sweeper-test.ts src/acquisition-discovery-candidate-ingestion-test.ts src/acquisition-application-test.ts src/growth-roi-module-test.ts
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-roi:mysql
```

Expected: PASS. The real-MySQL test uses two physical connections and both production entry paths. It proves: Run event + discovery row and attributed candidate/evidence + discovery row commit atomically; an injected failure after projection append rolls the whole business transaction back; exact duplicate event/payload produces one row while changed-payload reuse fails and rolls back; a workspace-B event cannot enter workspace A; `listDiscoveries` and `getWatermark` receive the exact same sealed token and exclude later rows; foreground Run, recovered Run, and direct ingestion pass only the exact `ResolvedAcquisitionWorkspace` returned by the one Foundation resolver and create zero `ActiveWorkspaceContext`/role/capability lookalikes; and the Run path, candidate-ingestion path, ROI private key, C0 projection, server injection, and single Acquisition application all hold one reference-identical writer. The memory suite proves overlapping windows fail, adjacent windows succeed, equal `discoveredAt` ties by `sourceRecordedAt` then `eventId`, a late-recorded earlier tuple appends one reassignment version, old-cutoff later-cohort membership is byte-identical, new-cutoff membership exists only in the earlier cohort, and cross-workspace references write nothing.

- [ ] **Step 5: Commit in-memory cohorts**

```bash
git add backend/src/acquisition-authoritative-discovery-projection.ts backend/src/acquisition-authoritative-discovery-mysql-repository.ts backend/src/acquisition-authoritative-discovery-projection-test.ts backend/src/growth-roi-discovery-projection-mysql-test.ts backend/src/growth-roi-command-executor.ts backend/src/growth-roi-command-executor-test.ts backend/src/acquisition-cohort.ts backend/src/acquisition-cohort-repository.ts backend/src/growth-roi-test-fixtures.ts backend/src/acquisition-cohort-test.ts backend/src/growth-roi-module.ts backend/src/growth-roi-module-test.ts backend/src/acquisition-domain.ts backend/src/acquisition-domain-repository.ts backend/src/acquisition-domain-service.ts backend/src/acquisition-domain-test.ts backend/src/acquisition-individual-signal-ingestion.ts backend/src/acquisition-discovery-candidate-ingestion-test.ts backend/src/acquisition-tool-executor.ts backend/src/acquisition-tool-executor-test.ts backend/src/acquisition-tool-support-repositories.ts backend/src/acquisition-tool-support-repositories-test.ts backend/src/acquisition-plan-run-repository.ts backend/src/acquisition-plan-run-service.ts backend/src/acquisition-plan-run-test.ts backend/src/acquisition-plan-execution-recovery-sweeper.ts backend/src/acquisition-plan-execution-recovery-sweeper-test.ts backend/src/acquisition-mysql-repositories.ts backend/src/acquisition-mysql-repositories-test.ts backend/src/acquisition-application.ts backend/src/acquisition-application-test.ts backend/src/growth-commercial-application.ts backend/src/growth-commercial-composition.ts backend/src/growth-commercial-composition-test.ts backend/src/server.ts backend/package.json
git commit -m "feat: project versioned first-touch acquisition authority"
```

### Task 3: Persist cohorts in MySQL and fence concurrent catch-up

**Files:**
- Create: `backend/src/acquisition-cohort-mysql-repository.ts`
- Create: `backend/src/growth-roi-cohort-mysql-test.ts`
- Create: `backend/src/acquisition-cohort-recovery-sweeper.ts`
- Create: `backend/src/growth-roi-cohort-recovery-mysql-test.ts`
- Modify: `backend/src/growth-roi-test-fixtures.ts`
- Modify: `backend/src/growth-finance-mysql.ts`
- Modify: `backend/src/growth-finance-mysql-test-support.ts`
- Modify: `backend/package.json`
- Test: `backend/src/growth-roi-cohort-mysql-test.ts`
- Test: `backend/src/growth-roi-cohort-recovery-mysql-test.ts`

**Interfaces:**
- Consumes: Task 2 repository contract and shared MySQL harness.
- Produces: `ACQUISITION_COHORT_MYSQL_SCHEMA_STATEMENTS`, `ensureAcquisitionCohortMysqlSchema(pool)`, `MysqlAcquisitionCohortRepository`, `AcquisitionCohortRecoveryAuthorizer`, and `AcquisitionCohortRecoverySweeper.start/stop/sweepOnce`; the sweeper cannot be constructed without the current-authority resolver.

- [ ] **Step 1: Write the failing concurrent catch-up test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";
import { MysqlAcquisitionCohortRepository } from "./acquisition-cohort-mysql-repository.js";
import { ownershipCandidateFixture } from "./growth-roi-test-fixtures.js";

test("two workers cannot assign one canonical subject twice", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const { pool } = fixture;
    const repository = new MysqlAcquisitionCohortRepository(pool);
    const operation = await fixture.createCatchUpOperation({ cohortId: "cohort-1", authorityKind: "roi_close" });
    const attempts = await Promise.allSettled(["worker-a", "worker-b"].map((worker) => repository.transaction(async (tx) => {
      const lease = await tx.claimCatchUp(operation.id, worker, "2026-08-09T00:00:00.000Z");
      if (!lease) throw new Error("lease_not_acquired");
      await tx.insertCanonicalSubject({ id: "subject-1", workspaceId: "workspace-a", platform: "douyin", subjectStableKey: "subject:key-1", canonicalProfileUrl: null, createdAt: "2026-08-09T00:00:00.000Z" });
      await tx.appendOwnershipCandidate(ownershipCandidateFixture("cohort-1", "subject-1", "event-1"), lease);
      return lease;
    })));
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal((await repository.listMembersAt("workspace-a", "cohort-1", await fixture.seal("2026-08-09T00:00:00.000Z"))).length, 1);
  });
});

test("two connections preserve historical ownership when adjacent cohorts catch up in reverse order", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    await fixture.createAdjacentCohorts();
    await fixture.advanceServerClockTo("2026-08-09T01:00:00.000Z");
    const lateAuthority = await fixture.commitRunDiscovery({ eventId: "event-late-window", discoveredAt: "2026-08-09T00:00:00.000Z" });
    assert.equal(lateAuthority.sourceRecordedAt, "2026-08-09T01:00:00.000Z");
    const oldCutoff = await fixture.seal("2026-08-09T23:59:59.999Z");
    await fixture.advanceServerClockTo("2026-08-10T01:00:00.000Z");
    const earlyAuthority = await fixture.commitRunDiscovery({ eventId: "event-early-window", discoveredAt: "2026-08-07T00:00:00.000Z" });
    assert.equal(earlyAuthority.sourceRecordedAt, "2026-08-10T01:00:00.000Z");
    const newCutoff = await fixture.seal("2026-08-10T23:59:59.999Z");
    await fixture.catchUpOnConnection("a", "cohort-early", newCutoff);
    await Promise.all([
      fixture.catchUpOnConnection("b", "cohort-late", newCutoff),
      fixture.catchUpOnConnection("a", "cohort-early", newCutoff)
    ]);

    assert.deepEqual((await fixture.listMembersAt("cohort-late", oldCutoff)).map((row) => row.firstEventId), ["event-late-window"]);
    assert.equal((await fixture.listMembersAt("cohort-early", oldCutoff)).length, 0);
    assert.equal((await fixture.listMembersAt("cohort-late", newCutoff)).length, 0);
    assert.deepEqual((await fixture.listMembersAt("cohort-early", newCutoff)).map((row) => row.firstEventId), ["event-early-window"]);
    assert.deepEqual((await fixture.listOwnershipVersions()).map((row) => [row.cohortId, row.appendRevision, row.becameHead]), [["cohort-early", 1, true], ["cohort-late", 2, false]]);
    assert.equal((await fixture.listOwnershipVersions()).every((row) => row.projectionRecordedAt > oldCutoff.effectiveAsOf), true);
    assert.equal(await fixture.countDuplicateOwnershipRevisions(), 0);
  });
});

test("expired catch-up lease is fenced and recovery resumes from recorded-time checkpoint", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const operation = await fixture.crashCatchUpAfterPage({ cohortId: "cohort-1", cutoff: await fixture.seal("2026-08-09T00:00:00.000Z") });
    await fixture.advanceClockPastLease();
    await fixture.cohortRecoverySweeper().sweepOnce();
    assert.equal((await fixture.catchUpOperation(operation.id)).status, "succeeded");
    assert.equal(await fixture.countDuplicateMemberSources(), 0);
  });
});

test("recovery reauthorizes Closure and Performance read-repair actors before cache writes", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    for (const authorityKind of ["roi_close", "performance_read"] as const) {
      const operation = await fixture.crashCatchUpBeforeFirstPage({
        cohortId: `cohort-${authorityKind}`,
        requestedBy: `actor-${authorityKind}`,
        authorityKind
      });
      await fixture.revokeCatchUpAuthority(operation.requestedBy, authorityKind);
      await fixture.advanceClockPastLease();
      await fixture.cohortRecoverySweeper().sweepOnce();
      const failed = await fixture.catchUpOperation(operation.id);
      assert.equal(failed.status, "failed");
      assert.equal(failed.errorCode, "capability_forbidden");
      assert.equal(await fixture.countOwnershipCandidates(operation.id), 0);
      assert.equal(await fixture.readCheckpoint(operation.id), null);
    }
  });
});
```

- [ ] **Step 2: Run MySQL cohort test to verify RED**

Run: `cd backend && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-roi:mysql`

Expected: FAIL because the script, schema, and MySQL repository are missing.

- [ ] **Step 3: Implement InnoDB cohort tables and leases**

Create `acquisition_cohort_platform_guards`, `acquisition_cohorts`, `acquisition_cohort_catch_up_operations`, `acquisition_canonical_subjects`, `acquisition_canonical_subject_aliases`, logical `acquisition_cohort_members`, operational `acquisition_cohort_membership_heads`, immutable `acquisition_cohort_membership_versions`, and append-only `acquisition_cohort_member_sources`. Mandatory uniqueness:

```sql
UNIQUE KEY uk_canonical_subject (workspace_id, platform, subject_stable_key),
UNIQUE KEY uk_first_touch_membership (workspace_id, platform, subject_stable_key),
UNIQUE KEY uk_membership_version_revision (cohort_member_id, append_revision),
UNIQUE KEY uk_membership_version_event (cohort_member_id, first_event_id),
UNIQUE KEY uk_member_source_event (cohort_member_id, event_id),
UNIQUE KEY uk_cohort_window (workspace_id, platform, cohort_from, cohort_to),
UNIQUE KEY uk_cohort_catchup_request (workspace_id, authority_kind, request_identity_hash),
UNIQUE KEY uk_cohort_catchup_boundary (workspace_id, cohort_id, cutoff_effective_as_of, requested_by, authority_kind, request_identity_hash),
KEY ix_cohort_catchup_parent_closure (workspace_id, parent_closure_operation_id)
```

The platform guard serializes overlap checks. The logical member never carries mutable cohort ownership. Its head stores only the current minimum-tuple candidate/version and append revision for locking/CAS acceleration. Every assignable source event—whether it becomes head or not—stores one immutable candidate with event ID, candidate cohort, complete discovery/attribution snapshot, authoritative `source_recorded_at/source_temporal_sequence`, cache-only `projection_recorded_at/projection_temporal_sequence`, `became_head`, and optional `previous_head_version_id`; it has no update/delete method. `upsertFirstTouch` takes the workspace barrier first and then locks the global subject head, so catch-up of adjacent cohorts on two physical connections produces a gap-free event-unique candidate chain. `listMembersAt` uses a set-based query that first filters `source_recorded_at<=cutoff.effectiveAsOf`, ranks `(discovered_at,source_recorded_at,event_id)` ascending per logical member, keeps rank 1, and only then applies `cohort_id`. It never filters on `projection_recorded_at`, joins only the current head, or chooses greatest cache append revision. Thus reverse cohort catch-up and first cache projection after sealing still reconstruct the old owner. The append-only member-source table keeps the same source/cache timestamp separation; never use nullable `evidence_id` in an idempotency key.

Each catch-up operation—not the cohort row—stores `(checkpoint_source_recorded_at,checkpoint_event_id)`, effective cutoff plus initial temporal sequence as audit-only metadata, `requested_by`, closed `authority_kind`, nullable `parent_closure_operation_id`, non-null `request_identity_hash`, status, lease owner/expiry/fencing fields, and every candidate insert/checkpoint advance/completion requires the current fencing token and an unexpired lease. The invariant is exact: `authority_kind='roi_close'` requires one non-null parent ID whose workspace/requester/request identity equals the catch-up row; `performance_read` requires null. Task 3 creates the parent index/check, while Task 11—after `roi_closure_operations` exists—adds the composite parent foreign key without weakening the check. The Closure adapter derives the hash from and stores its verified existing close operation ID; `CohortProjectionReadCatchUpPort.ensureAt` derives its hash from the concrete authenticated `(workspaceId,actorId,cohortId,cutoff.effectiveAsOf)` and stores a null parent. Neither accepts an HTTP idempotency key or creates a `CommandContext`. A unique-hash hit must exact-match workspace/cohort/cutoff/requester/authority/parent or fail `catch_up_identity_conflict`; an exact retry resumes/returns the same operation. `AcquisitionCohortRecoverySweeper` scans only expired incomplete operations, CAS-claims with a higher fencing token, calls its injected authorizer before the first source/cache access, then asks the exact Foundation barrier to seal the persisted `cutoffEffectiveAsOf` once for that recovery boundary and passes that one token to every page/watermark read. For `roi_close`, the authorizer indexed-loads the parent, requires it remain the matching live/recoverable operation with exact persisted workspace/requestedBy/idempotency key/request hash/expected series revision, then re-resolves current `roi.close` and builds the command from those server records; it never reverses the hash or scans operations. Missing, failed, superseded, cross-workspace, or identity-mismatched parents terminally fail the catch-up before source/cache access. The performance branch uses only its stored narrow authority. Authorized recovery resumes from the source-recorded-time checkpoint, heartbeats per page, isolates one operation failure from the rest, and `stop()` waits for active sweeps. The audit sequence never enters operation identity and no recovery reader accepts a naked persisted time. Revocation produces a fenced terminal `capability_forbidden` event with zero source read, membership/source/checkpoint/cache change. Mandatory memory/MySQL tests cover failed/superseded/missing/mismatched parents plus revocation and require zero source/cache writes; they also commit the first authority event, seal the old cutoff, commit the late earlier event, seal the new cutoff, then catch up adjacent cohorts in reverse order on separate connections, proving the former candidate and Closure bytes stay unchanged at the old cutoff while only the earlier cohort owns the subject at the new cutoff. Add this cumulative dedicated script to `backend/package.json`; every named file uses the `growth-roi-*-mysql-test.ts` suffix and therefore cannot match the default `acquisition-*-test.ts` wildcard:

```json
{
  "scripts": {
    "test:growth-roi:mysql": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/growth-roi-discovery-projection-mysql-test.ts src/growth-roi-cohort-mysql-test.ts src/growth-roi-cohort-recovery-mysql-test.ts"
  }
}
```

- [ ] **Step 4: Verify memory/MySQL parity and two-connection races**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-cohort-test.ts && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-roi:mysql`

Expected: PASS; one catch-up lease wins, no duplicate logical subject/member or ownership revision exists, the earliest tuple wins regardless of two-connection arrival order, old/new cutoff ownership differs only through immutable versions, and recovery advances fencing.

- [ ] **Step 5: Commit MySQL cohorts**

```bash
git add backend/src/acquisition-cohort-mysql-repository.ts backend/src/growth-roi-cohort-mysql-test.ts backend/src/acquisition-cohort-recovery-sweeper.ts backend/src/growth-roi-cohort-recovery-mysql-test.ts backend/src/growth-roi-test-fixtures.ts backend/src/growth-finance-mysql.ts backend/src/growth-finance-mysql-test-support.ts backend/package.json
git commit -m "feat: persist acquisition cohorts in mysql"
```

### Task 4: Implement exact largest-remainder money allocation

**Files:**
- Create: `backend/src/acquisition-allocation-math.ts`
- Create: `backend/src/acquisition-allocation-math-test.ts`
- Test: `backend/src/acquisition-allocation-math-test.ts`

**Interfaces:**
- Consumes: `safeMinor` from `growth-money.ts`.
- Produces: `allocateMinorByBps(amountMinor, targets)`.

- [ ] **Step 1: Write the failing rounding and tie-break tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { allocateMinorByBps } from "./acquisition-allocation-math.js";

test("largest remainder preserves every minor unit", () => {
  assert.deepEqual(allocateMinorByBps(10, [
    { targetStableKey: "b", allocationBps: 3333 },
    { targetStableKey: "a", allocationBps: 3333 },
    { targetStableKey: "c", allocationBps: 3334 }
  ]), [
    { targetStableKey: "a", amountMinor: 3 },
    { targetStableKey: "b", amountMinor: 3 },
    { targetStableKey: "c", amountMinor: 4 }
  ]);
});

test("equal fractional remainders break ties lexically", () => {
  assert.deepEqual(allocateMinorByBps(1, [
    { targetStableKey: "z", allocationBps: 5000 },
    { targetStableKey: "a", allocationBps: 5000 }
  ]), [
    { targetStableKey: "a", amountMinor: 1 },
    { targetStableKey: "z", amountMinor: 0 }
  ]);
});

test("code-point order is locale-independent and duplicate targets fail closed", () => {
  assert.deepEqual(allocateMinorByBps(1, [
    { targetStableKey: "é", allocationBps: 5000 },
    { targetStableKey: "Z", allocationBps: 5000 }
  ]), [
    { targetStableKey: "Z", amountMinor: 1 },
    { targetStableKey: "é", amountMinor: 0 }
  ]);
  assert.throws(() => allocateMinorByBps(1, [
    { targetStableKey: "same", allocationBps: 5000 },
    { targetStableKey: "same", allocationBps: 5000 }
  ]), /allocation_target_duplicate/);
});
```

- [ ] **Step 2: Run allocation math test to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-allocation-math-test.ts`

Expected: FAIL with missing allocation module.

- [ ] **Step 3: Implement BigInt floor/remainder allocation**

```ts
export function allocateMinorByBps(amountMinor: number, targets: readonly { targetStableKey: string; allocationBps: number }[]) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error("allocation_amount_invalid");
  if (targets.length === 0 || targets.reduce((sum, item) => sum + item.allocationBps, 0) !== 10000) throw new Error("allocation_bps_incomplete");
  const compareCodePoint = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  if (new Set(targets.map((item) => item.targetStableKey)).size !== targets.length) throw new Error("allocation_target_duplicate");
  const amount = BigInt(amountMinor);
  const rows = targets.map((item) => {
    if (!item.targetStableKey || !Number.isSafeInteger(item.allocationBps) || item.allocationBps < 0 || item.allocationBps > 10000) throw new Error("allocation_target_invalid");
    const numerator = amount * BigInt(item.allocationBps);
    return { targetStableKey: item.targetStableKey, amountMinor: numerator / 10000n, remainder: numerator % 10000n };
  });
  let remaining = amount - rows.reduce((sum, item) => sum + item.amountMinor, 0n);
  for (const row of [...rows].sort((a, b) => a.remainder === b.remainder ? compareCodePoint(a.targetStableKey, b.targetStableKey) : a.remainder > b.remainder ? -1 : 1)) {
    if (remaining === 0n) break;
    row.amountMinor += 1n;
    remaining -= 1n;
  }
  return rows.sort((a, b) => compareCodePoint(a.targetStableKey, b.targetStableKey)).map(({ targetStableKey, amountMinor: value }) => ({ targetStableKey, amountMinor: safeMinor(value, "allocatedAmountMinor") }));
}
```

- [ ] **Step 4: Run allocation tests and property sweep**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-allocation-math-test.ts`

Expected: PASS for all deterministic examples and a test loop covering amounts 0–10000 whose allocated sum always equals the input.

- [ ] **Step 5: Commit allocation math**

```bash
git add backend/src/acquisition-allocation-math.ts backend/src/acquisition-allocation-math-test.ts
git commit -m "feat: allocate attributed money exactly"
```

### Task 5: Implement FinancialSourceReport and in-memory AttributionAllocationSet activation

**Files:**
- Create: `backend/src/acquisition-attribution-allocation.ts`
- Create: `backend/src/acquisition-attribution-allocation-repository.ts`
- Create: `backend/src/acquisition-attribution-allocation-as-of-reader.ts`
- Create: `backend/src/acquisition-attribution-allocation-test.ts`
- Create: `backend/src/financial-source-report.ts`
- Create: `backend/src/financial-source-report-test.ts`
- Modify: `backend/src/growth-roi-test-fixtures.ts`
- Test: `backend/src/acquisition-attribution-allocation-test.ts`

**Interfaces:**
- Consumes: Task 4 allocation math, Task 2 cohort membership, stage-3 ledgers, and `CommercialBindingVerifier`.
- Authorizes: `FinancialSourceReportService.create/get` and `AttributionAllocationService.createDraft/get` require `ledger.pending.create`; `AttributionAllocationService.activate` requires `ledger.verify`. Checks occur in the service before reservation/domain reads and repeat on replay. Internal token-only as-of readers remain exact authority ports and are not exposed by weakening the HTTP capability.
- Produces: `AttributionAllocationService.createDraft/activate/get`, token-only `AttributionAllocationAsOfReader.getActiveAt`, `FinancialSourceReportService.create/get`, and `InMemoryAttributionAllocationRepository`.

```ts
export interface FinancialSourceReport {
  id: string; workspaceId: string; currency: string; sourceSystem: string;
  sourceCursor: string | null; reportHash: string; declaredTotalMinor: number;
  periodFrom: string; periodTo: string; createdBy: string; createdAt: string;
}
interface PersistedFinancialSourceReport extends FinancialSourceReport {
  domainCommandHash: `sha256:${string}`; requestHash: `sha256:${string}`; requestedBy: string;
}
export interface FinancialSourceReportService {
  create(context: CommandContext, input: { currency: string; sourceSystem: string; sourceCursor: string | null; reportHash: `sha256:${string}`; declaredTotalMinor: number; periodFrom: string; periodTo: string }): Promise<FinancialSourceReport>;
  get(workspace: ActiveWorkspaceContext, id: string): Promise<FinancialSourceReport | null>;
}
export type AttributionEvidenceRef =
  | { kind: "cohort_member"; cohortMemberId: string }
  | { kind: "source_report"; sourceReportId: string; reportHash: string }
  | { kind: "commercial_binding"; dealId: string; bindingHash: string }
  | { kind: "ledger_source"; ledgerType: "cost" | "financial"; ledgerEntryId: string; evidenceHash: string };
export interface AttributionAllocationItemInput {
  cohortId: string; candidateId: string | null; planId: string | null;
  runId: string | null; allocationBps: number;
  allocationRule: "first_touch" | "direct" | "manual" | "equal_split" | "evidence_weighted";
  ruleVersion: string; evidenceRefs: AttributionEvidenceRef[]; targetStableKey: string;
}
export interface AttributionAllocationSet {
  id: string; workspaceId: string;
  sourceType: "cost_entry" | "cost_estimate" | "financial_fact" | "source_report";
  sourceId: string; version: number; status: "draft" | "active" | "superseded";
  revision: number; items: Array<AttributionAllocationItemInput & { effectiveAmountMinor: number }>;
  createdBy: string; createdAt: string; activatedBy: string | null; activatedAt: string | null;
}
export interface AttributionAllocationLifecycleEvent {
  id: string; workspaceId: string;
  sourceType: "cost_entry" | "cost_estimate" | "financial_fact" | "source_report";
  sourceId: string; allocationSetId: string;
  eventType: "activated" | "superseded"; eventSequence: number; revision: number;
  effectiveAt: string; supersedesAllocationSetId: string | null;
  actorId: string; recordedAt: string; temporalSequence: number;
}
interface PersistedAttributionAllocationSet extends AttributionAllocationSet {
  createDomainCommandHash: `sha256:${string}`; createRequestHash: `sha256:${string}`; requestedBy: string;
}
interface PersistedAttributionAllocationLifecycleEvent extends AttributionAllocationLifecycleEvent {
  activationDomainCommandHash: `sha256:${string}` | null;
  activationRequestHash: `sha256:${string}` | null;
  requestedBy: string;
}
export interface AttributionAllocationService {
  createDraft(context: CommandContext, input: { sourceType: "cost_entry" | "cost_estimate" | "financial_fact" | "source_report"; sourceId: string; items: AttributionAllocationItemInput[] }): Promise<AttributionAllocationSet>;
  activate(context: CommandContext, allocationSetId: string): Promise<AttributionAllocationSet>;
  get(workspace: ActiveWorkspaceContext, id: string): Promise<AttributionAllocationSet | null>;
}
export interface AttributionAllocationAsOfReader {
  getActiveAt(workspace: ActiveWorkspaceContext, input: { sourceType: AttributionAllocationSet["sourceType"]; sourceId: string; cutoff: GrowthSealedReadCutoff }): Promise<AttributionAllocationSet | null>;
}
```

- [ ] **Step 1: Write the failing activation test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { AttributionAllocationService } from "./acquisition-attribution-allocation.js";
import { activeAttributionSetIdAsOf } from "./acquisition-attribution-allocation-as-of-reader.js";
import type { AttributionAllocationLifecycleEvent } from "./acquisition-attribution-allocation.js";
import { allocationFixture } from "./growth-roi-test-fixtures.js";

test("activation requires complete BPS and supersedes only the prior version", async () => {
  const fixture = allocationFixture();
  const service = new AttributionAllocationService(fixture.dependencies);
  const first = await service.createDraft(fixture.context, { sourceType: "cost_entry", sourceId: "cost-1", items: [
    { cohortId: "cohort-a", candidateId: null, planId: null, runId: null, allocationBps: 6000, allocationRule: "manual", ruleVersion: "manual.v1", evidenceRefs: [{ kind: "ledger_source", ledgerType: "cost", ledgerEntryId: "cost-1", evidenceHash: "sha256:voucher-1" }], targetStableKey: "cohort-a" },
    { cohortId: "cohort-b", candidateId: null, planId: null, runId: null, allocationBps: 4000, allocationRule: "manual", ruleVersion: "manual.v1", evidenceRefs: [{ kind: "ledger_source", ledgerType: "cost", ledgerEntryId: "cost-1", evidenceHash: "sha256:voucher-1" }], targetStableKey: "cohort-b" }
  ] });
  const active = await service.activate({ ...fixture.context, expectedRevision: 1 }, first.id);
  assert.equal(active.status, "active");
  const incomplete = await service.createDraft(fixture.context, { sourceType: "cost_entry", sourceId: "cost-1", items: [{ cohortId: "cohort-a", candidateId: null, planId: null, runId: null, allocationBps: 9000, allocationRule: "manual", ruleVersion: "manual.v1", evidenceRefs: [], targetStableKey: "cohort-a" }] });
  await assert.rejects(() => service.activate({ ...fixture.context, expectedRevision: 1 }, incomplete.id), /allocation_bps_incomplete/);
  assert.equal((await service.get(fixture.context.workspace, active.id))?.status, "active");
});

test("allocation replacement advances one recorded tick and preserves an already-read cutoff", () => {
  const events: AttributionAllocationLifecycleEvent[] = [
    { id: "event-1", workspaceId: "workspace-a", sourceType: "cost_estimate", sourceId: "estimate-1", allocationSetId: "set-v1", eventType: "activated", eventSequence: 1, revision: 1, effectiveAt: "2026-08-01T00:00:00.000Z", supersedesAllocationSetId: null, actorId: "finance-a", recordedAt: "2026-08-01T00:00:00.000Z", temporalSequence: 1 },
    { id: "event-z", workspaceId: "workspace-a", sourceType: "cost_estimate", sourceId: "estimate-1", allocationSetId: "set-v1", eventType: "superseded", eventSequence: 2, revision: 2, effectiveAt: "2026-08-09T00:00:00.000Z", supersedesAllocationSetId: null, actorId: "finance-a", recordedAt: "2026-08-09T00:00:00.000Z", temporalSequence: 2 },
    { id: "event-a", workspaceId: "workspace-a", sourceType: "cost_estimate", sourceId: "estimate-1", allocationSetId: "set-v2", eventType: "activated", eventSequence: 3, revision: 3, effectiveAt: "2026-08-09T00:00:00.000Z", supersedesAllocationSetId: "set-v1", actorId: "finance-a", recordedAt: "2026-08-09T00:00:00.001Z", temporalSequence: 3 }
  ];
  assert.equal(activeAttributionSetIdAsOf(events, "2026-08-08T23:59:59.999Z"), "set-v1");
  assert.equal(activeAttributionSetIdAsOf(events, "2026-08-09T00:00:00.000Z"), null);
  assert.equal(activeAttributionSetIdAsOf(events, "2026-08-09T00:00:00.001Z"), "set-v2");
});

test("report, draft, and activation recover after business commit before Foundation completion", async () => {
  const fixture = allocationFixture({ failFoundationCompletionOncePerMutation: true });
  const service = new AttributionAllocationService(fixture.dependencies);
  const reportService = fixture.financialSourceReports();
  await assert.rejects(() => reportService.create(fixture.context("report-ack-loss"), fixture.reportInput), /injected_completion_loss/);
  await fixture.expireFoundationLease();
  const report = await reportService.create(fixture.context("report-ack-loss"), fixture.reportInput);
  await assert.rejects(() => service.createDraft(fixture.context("draft-ack-loss"), fixture.allocationDraft(report.id)), /injected_completion_loss/);
  await fixture.expireFoundationLease();
  const draft = await service.createDraft(fixture.context("draft-ack-loss"), fixture.allocationDraft(report.id));
  await assert.rejects(() => service.activate({ ...fixture.context("activate-ack-loss"), expectedRevision: 1 }, draft.id), /injected_completion_loss/);
  await fixture.expireFoundationLease();
  const active = await service.activate({ ...fixture.context("activate-ack-loss"), expectedRevision: 1 }, draft.id);
  assert.equal(active.id, draft.id);
  assert.deepEqual(await fixture.domainCommandRowCounts(), { reports: 1, drafts: 1, activations: 1 });
});

test("allocation replay reauthorizes and one key cannot cross resource IDs", async () => {
  const fixture = allocationFixture();
  const service = new AttributionAllocationService(fixture.dependencies);
  const [a, b] = await fixture.twoCompleteDrafts(service);
  await service.activate({ ...fixture.context("shared-key"), expectedRevision: 1 }, a.id);
  await fixture.revoke("ledger.verify");
  await assert.rejects(() => service.activate({ ...fixture.context("shared-key"), expectedRevision: 1 }, a.id), /capability_forbidden/);
  await fixture.restore("ledger.verify");
  await assert.rejects(() => service.activate({ ...fixture.context("shared-key"), expectedRevision: 1 }, b.id), /idempotency_conflict/);
  assert.equal(await fixture.activationCount(b.id), 0);
});
```

- [ ] **Step 2: Run attribution tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-attribution-allocation-test.ts src/financial-source-report-test.ts`

Expected: FAIL because allocation and report services are absent.

- [ ] **Step 3: Implement versioned sources, drafts, and atomic activation**

Create `FinancialSourceReport` exactly as section 8.9 specifies; `(workspaceId, reportHash)` is its permanent source identity. Validate all source, cohort, candidate, plan, and run references in one workspace. Candidate/deal targets require a verified binding snapshot. Direct sources may default to one `direct` item; shared sources require an explicit complete set.

Every Task-5 public mutation is a thin current-authority wrapper over the one injected `RoiCommandExecutor`: `FinancialSourceReportService.create` uses the exact reports collection path, `AttributionAllocationService.createDraft` uses the exact allocation-set collection path, and `activate` uses Foundation's frozen `:id` activation template (the validated concrete ID is already bound into `context.requestHash`). Each calls `execute` exactly once, then delegates respectively to private `createReportClaimed`, `createDraftClaimed`, or `activateClaimed`; claimed cores never reserve/complete Foundation idempotency themselves. Report/draft rows persist their creation command identity, while only the new `activated` lifecycle event persists the activation identity (`superseded` carries null activation fields). Each core first performs a non-locking indexed `domainCommandHash` probe and exact-checks actor/request/resource; a hit returns the same ID, while a miss enters a barrier-first append transaction. `authorizeAndProject` repeats current capability/workspace/kind checks and projects only the stored returned ID, so completed replay after capability loss is denied and never leaks a cached DTO. Public projectors omit all command hashes.

Activation starts one transaction by calling `temporalBarrier.allocateAppend(tx,workspaceId)` before locking the source attribution head, validates exactly 10000 BPS, computes source-minor allocations with Task 4, and appends `superseded` for the old published set and `activated` for the draft. If both events are needed, it requests a consecutive global stamp for each while retaining the same barrier lock; every event stores `recordedAt`, `temporalSequence`, source-level sequence/revision and `effectiveAt`, then advances the operational head. It never updates an old set row or item. An incomplete or unpublished set lowers coverage and cannot enter closure. Its historical reader consumes a `GrowthSealedReadCutoff` and never seals internally.

The in-memory repository follows the same source-head transaction boundary as MySQL. The smallest GREEN public wrapper plus private claimed activation is:

```ts
async activate(context: CommandContext, allocationSetId: string) {
  requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
  const expectedRevision = requireExpectedRevision(context);
  return this.commandExecutor.execute(context, {
    method: "POST",
    canonicalPath: "/api/v1/acquisition/attribution-allocation-sets/:id/activate",
    resourceKind: "attribution_set"
  }, {
    authorizeAndProject: (ids) => this.authorizeAndProjectActivation(context, allocationSetId, ids),
    executeClaimed: (domainCommandHash) => this.activateClaimed(context, allocationSetId, expectedRevision, domainCommandHash)
  });
}

private async activateClaimed(context: CommandContext, allocationSetId: string, expectedRevision: number, domainCommandHash: `sha256:${string}`): Promise<RoiCommandExecutionIds> {
  const replay = await this.repository.findActivationByDomainCommandHash(context.workspace.workspaceId, domainCommandHash); // indexed, non-locking
  if (replay !== null) return this.requireExactActivationReplay(replay, context, allocationSetId, expectedRevision);
  return this.repository.transaction(async (tx) => {
    const firstStamp = await this.temporalBarrier.allocateAppend(tx, context.workspace.workspaceId);
    const draft = await tx.requireDraft(context.workspace.workspaceId, allocationSetId);
    const head = await tx.lockSourceHead(context.workspace.workspaceId, draft.sourceType, draft.sourceId);
    if (head.revision !== expectedRevision) throw new AttributionError("revision_mismatch", 412);
    if (draft.items.reduce((sum, item) => sum + item.allocationBps, 0) !== 10000) throw new AttributionError("allocation_bps_incomplete", 422);
    const sourceAmountMinor = await this.sources.requireEffectiveAmountMinor(context.workspace, draft.sourceType, draft.sourceId);
    const amounts = allocateMinorByBps(sourceAmountMinor, draft.items);
    let nextSequence = head.lastEventSequence;
    let activationStamp = firstStamp;
    if (head.activeAllocationSetId !== null) {
      await tx.appendLifecycleEvent(allocationLifecycleEvent({ head, allocationSetId: head.activeAllocationSetId, eventType: "superseded", eventSequence: ++nextSequence, revision: nextSequence, effectiveAt: firstStamp.recordedAt, ...firstStamp, actorId: context.actorId }));
      activationStamp = await this.temporalBarrier.allocateAppend(tx, context.workspace.workspaceId);
    }
    await tx.storeEffectiveAmounts(draft.id, amounts);
    await tx.appendLifecycleEvent(allocationLifecycleEvent({ head, allocationSetId: draft.id, eventType: "activated", eventSequence: ++nextSequence, revision: nextSequence, effectiveAt: activationStamp.recordedAt, ...activationStamp, actorId: context.actorId, supersedesAllocationSetId: head.activeAllocationSetId, activationDomainCommandHash: domainCommandHash, activationRequestHash: context.requestHash, requestedBy: context.actorId }));
    await tx.advanceSourceHead(head, draft.id, expectedRevision + 1, nextSequence);
    return { resourceId: draft.id, operationId: null };
  });
}
```

```ts
export function activeAttributionSetIdAsOf(events: readonly AttributionAllocationLifecycleEvent[], asOf: string): string | null {
  const recorded = events.filter((event) => event.recordedAt <= asOf).sort((a, b) => a.eventSequence - b.eventSequence);
  for (const [index, event] of recorded.entries()) if (event.eventSequence !== index + 1 || event.revision !== index + 1) throw new Error("attribution_history_invalid");
  let activeSetId: string | null = null;
  for (const event of recorded.filter((event) => event.effectiveAt <= asOf).sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : a.effectiveAt > b.effectiveAt ? 1 : 0) || a.eventSequence - b.eventSequence)) {
    if (event.eventType === "superseded" && activeSetId !== event.allocationSetId) throw new Error("attribution_history_invalid");
    activeSetId = event.eventType === "activated" ? event.allocationSetId : null;
  }
  return activeSetId;
}
```

- [ ] **Step 4: Verify source-report totals, binding, and correction versions**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-attribution-allocation-test.ts src/financial-source-report-test.ts src/commercial-binding-snapshot-test.ts`

Expected: PASS; same report hash deduplicates, cross-workspace targets fail, and the former active set remains immutable as `superseded`.

- [ ] **Step 5: Commit in-memory attribution**

```bash
git add backend/src/acquisition-attribution-allocation.ts backend/src/acquisition-attribution-allocation-repository.ts backend/src/acquisition-attribution-allocation-as-of-reader.ts backend/src/acquisition-attribution-allocation-test.ts backend/src/financial-source-report.ts backend/src/financial-source-report-test.ts backend/src/growth-roi-test-fixtures.ts
git commit -m "feat: add versioned acquisition attribution"
```

### Task 6: Persist source reports and attribution sets with concurrent activation safety

**Files:**
- Create: `backend/src/acquisition-attribution-allocation-mysql-repository.ts`
- Create: `backend/src/growth-roi-attribution-mysql-test.ts`
- Modify: `backend/src/growth-finance-mysql-test-support.ts`
- Modify: `backend/src/growth-finance-mysql.ts`
- Modify: `backend/package.json`
- Test: `backend/src/growth-roi-attribution-mysql-test.ts`

**Interfaces:**
- Consumes: Task 5 repository contract and shared MySQL harness.
- Produces: `ATTRIBUTION_ALLOCATION_MYSQL_SCHEMA_STATEMENTS`, `ensureAttributionAllocationMysqlSchema(pool)`, and `MysqlAttributionAllocationRepository`.

- [ ] **Step 1: Add a failing concurrent activation test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";
import { completeTwoCohortDraft } from "./growth-roi-test-fixtures.js";

test("only one allocation version becomes active under concurrent activation", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const service = fixture.attributionService();
    const [a, b] = await Promise.all([6000, 7000].map((bps, index) => service.createDraft(fixture.context(`draft-${index}`), completeTwoCohortDraft("cost-1", bps))));
    const results = await Promise.allSettled([
      service.activate({ ...fixture.context("activate-a"), expectedRevision: 1 }, a.id),
      service.activate({ ...fixture.context("activate-b"), expectedRevision: 1 }, b.id)
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal((await fixture.repository.listActiveSets("workspace-a", "cost_entry", "cost-1")).length, 1);
  });
});
```

- [ ] **Step 2: Run MySQL attribution test to verify RED**

Run: `cd backend && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-roi:mysql`

Expected: FAIL until the MySQL tables and repository exist.

- [ ] **Step 3: Implement append-only source/report/allocation tables**

Create `financial_source_reports`, `attribution_allocation_source_heads`, `attribution_allocation_sets`, `attribution_allocation_items`, and `attribution_allocation_lifecycle_events`. In addition to business columns, reports store non-null `domain_command_hash/request_hash/requested_by`, sets store non-null `create_domain_command_hash/create_request_hash/requested_by`, and lifecycle events store nullable `activation_domain_command_hash/activation_request_hash/requested_by` (non-null only on `activated`). Unique keys are `(workspace_id, report_hash)`, `(workspace_id,domain_command_hash)` on reports, `(workspace_id, source_type, source_id)`, `(workspace_id, source_type, source_id, version)`, `(workspace_id,create_domain_command_hash)` on sets, `(allocation_set_id, target_stable_key)`, `(workspace_id,source_type,source_id,event_sequence)`, `(workspace_id,source_type,source_id,revision)`, and `(workspace_id,activation_domain_command_hash)` on lifecycle events. Use source-head `FOR UPDATE` and revision CAS. Never update set, item, or lifecycle rows. All three domain-command lookups are indexed non-locking probes; a probe miss enters the transaction and allocates the temporal barrier before the first domain lock.

Replace `backend/package.json`'s stage-4 MySQL command with this cumulative, explicitly named suite:

```json
{
  "scripts": {
    "test:growth-roi:mysql": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/growth-roi-discovery-projection-mysql-test.ts src/growth-roi-cohort-mysql-test.ts src/growth-roi-cohort-recovery-mysql-test.ts src/growth-roi-attribution-mysql-test.ts"
  }
}
```

The minimum GREEN private MySQL repository helper serializes the source head before publication and treats a lost revision as a precondition failure. `expectedHeadRevision` was obtained by the service from `requireExpectedRevision(context)`; this helper is not an HTTP/Pi/service input:

```ts
async publishActiveSet(workspaceId: string, setId: string, expectedHeadRevision: number) {
  return this.transaction(async (tx) => {
    const firstStamp = await this.temporalBarrier.allocateAppend(tx, workspaceId);
    const draft = await tx.requireDraftForUpdate(workspaceId, setId);
    const head = await tx.requireSourceHeadForUpdate(workspaceId, draft.sourceType, draft.sourceId);
    if (head.revision !== expectedHeadRevision) throw new AttributionError("revision_mismatch", 412);
    const items = await tx.listItems(workspaceId, setId);
    if (items.reduce((sum, item) => sum + item.allocationBps, 0) !== 10000) throw new AttributionError("allocation_bps_incomplete", 422);
    let nextSequence = head.lastEventSequence;
    let activationStamp = firstStamp;
    if (head.activeAllocationSetId !== null) {
      await tx.appendLifecycleEvent(mysqlAllocationLifecycleEvent(head, head.activeAllocationSetId, "superseded", ++nextSequence, firstStamp));
      activationStamp = await this.temporalBarrier.allocateAppend(tx, workspaceId);
    }
    await tx.appendLifecycleEvent(mysqlAllocationLifecycleEvent(head, setId, "activated", ++nextSequence, activationStamp, head.activeAllocationSetId));
    const changed = await tx.compareAndSwapHead(workspaceId, draft.sourceType, draft.sourceId, expectedHeadRevision, setId, nextSequence);
    if (!changed) throw new AttributionError("revision_mismatch", 412);
    return tx.projectSet(workspaceId, setId);
  });
}
```

- [ ] **Step 4: Verify concurrency, exact amounts, and memory/MySQL parity**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-attribution-allocation-test.ts && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-roi:mysql`

Expected: PASS; one active set exists, set items sum exactly to the source amount, old version remains queryable, and memory/MySQL `getActiveAt` agree across the two strict adjacent recorded ticks of one replacement. Real MySQL also injects process loss after each report/draft/activation business commit but before Foundation completion and proves one immutable domain row/event plus stable returned ID after lease recovery; completed replay with revoked capability performs zero reads beyond the authority check, and the same key against another set ID/revision returns `idempotency_conflict` with zero writes.

- [ ] **Step 5: Commit MySQL attribution**

```bash
git add backend/src/acquisition-attribution-allocation-mysql-repository.ts backend/src/growth-roi-attribution-mysql-test.ts backend/src/growth-finance-mysql-test-support.ts backend/src/growth-finance-mysql.ts backend/package.json
git commit -m "feat: persist acquisition attribution sets"
```

### Task 7: Implement per-revenue cash settlement and refund binding in memory

**Files:**
- Create: `backend/src/financial-settlement-allocation.ts`
- Create: `backend/src/financial-settlement-allocation-repository.ts`
- Create: `backend/src/financial-settlement-allocation-test.ts`
- Modify: `backend/src/growth-roi-test-fixtures.ts`
- Test: `backend/src/financial-settlement-allocation-test.ts`

**Interfaces:**
- Consumes: verified stage-3 FinancialFacts and CommercialBindingSnapshot.
- Authorizes: `CashSettlementAllocationService.createDraft/get` requires `ledger.pending.create`; `activate` requires `ledger.verify`. Replay and any recovery path resolve current Foundation authority again, while the internal `reconcile`/token reader is callable only through already-authorized Closure/Advisor service graphs.
- Produces: `CashSettlementAllocationService.createDraft/activate/get`, token-only `CashSettlementAllocationAsOfReader.getActiveAt`, `CashReconciliationResult`, and `InMemoryFinancialSettlementRepository`.

```ts
export interface CashSettlementAllocationItemInput {
  targetRevenueFactId: string; dealId: string; quoteVersionId: string;
  amountMinor: number; currency: string;
  originalPaymentFactId: string | null;
  originalPaymentAllocationSetId: string | null;
  originalPaymentAllocationItemId: string | null;
  commercialBindingSnapshot: CommercialBindingSnapshot;
}
export interface CashSettlementAllocationSet {
  id: string; workspaceId: string; sourceFactId: string; version: number;
  status: "draft" | "active" | "superseded"; revision: number;
  items: Array<CashSettlementAllocationItemInput & { id: string }>;
  createdBy: string; createdAt: string; activatedBy: string | null; activatedAt: string | null;
}
export interface CashSettlementAllocationLifecycleEvent {
  id: string; workspaceId: string; sourceFactId: string; allocationSetId: string;
  eventType: "activated" | "superseded"; eventSequence: number; revision: number;
  effectiveAt: string; supersedesAllocationSetId: string | null;
  actorId: string; recordedAt: string; temporalSequence: number;
}
interface PersistedCashSettlementAllocationSet extends CashSettlementAllocationSet {
  createDomainCommandHash: `sha256:${string}`; createRequestHash: `sha256:${string}`; requestedBy: string;
}
interface PersistedCashSettlementAllocationLifecycleEvent extends CashSettlementAllocationLifecycleEvent {
  activationDomainCommandHash: `sha256:${string}` | null;
  activationRequestHash: `sha256:${string}` | null;
  requestedBy: string;
}
export interface CashReconciliationResult {
  status: "complete" | "incomplete"; allocatedPaymentMinor: number;
  allocatedRefundMinor: number; allocatedBadDebtMinor: number;
  netCashMinor: number; unallocatedCustomerBalanceMinor: number;
  gaps: Array<{ revenueFactId: string; remainingMinor: number }>;
}
export interface CashSettlementAllocationService {
  createDraft(context: CommandContext, input: { sourceFactId: string; items: CashSettlementAllocationItemInput[] }): Promise<CashSettlementAllocationSet>;
  activate(context: CommandContext, setId: string): Promise<CashSettlementAllocationSet>;
  reconcile(workspace: ActiveWorkspaceContext, revenueFactIds: string[], cutoff: GrowthSealedReadCutoff): Promise<CashReconciliationResult>;
}
export interface CashSettlementAllocationAsOfReader {
  getActiveAt(workspace: ActiveWorkspaceContext, input: { sourceFactId: string; cutoff: GrowthSealedReadCutoff }): Promise<CashSettlementAllocationSet | null>;
}
```

- [ ] **Step 1: Write the failing per-deal reconciliation test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { CashSettlementAllocationService } from "./financial-settlement-allocation.js";
import { settlementFixture } from "./growth-roi-test-fixtures.js";

test("Deal A underpayment is not cancelled by Deal B overpayment", async () => {
  const fixture = settlementFixture({ revenues: [{ id: "rev-a", dealId: "deal-a", amountMinor: 100 }, { id: "rev-b", dealId: "deal-b", amountMinor: 100 }], payments: [{ id: "pay-a", dealId: "deal-a", amountMinor: 50 }, { id: "pay-b", dealId: "deal-b", amountMinor: 150 }] });
  const service = new CashSettlementAllocationService(fixture.dependencies);
  await fixture.activatePayment(service, "pay-a", "rev-a", 50);
  await fixture.activatePayment(service, "pay-b", "rev-b", 100);
  const cutoff = await fixture.foundation.temporalBarrier.sealReadCutoff(
    fixture.workspace, "2026-08-09T00:00:00.000Z"
  );
  const result = await service.reconcile(fixture.workspace, ["rev-a", "rev-b"], cutoff);
  assert.equal(result.status, "incomplete");
  assert.equal(result.unallocatedCustomerBalanceMinor, 50);
  assert.deepEqual(result.gaps, [{ revenueFactId: "rev-a", remainingMinor: 50 }]);
});

test("refund must freeze the exact active payment allocation item", async () => {
  const fixture = settlementFixture({ revenues: [{ id: "rev-a", dealId: "deal-a", amountMinor: 100 }], payments: [{ id: "pay-a", dealId: "deal-a", amountMinor: 100 }], refunds: [{ id: "refund-a", dealId: "deal-a", amountMinor: 20 }] });
  const service = new CashSettlementAllocationService(fixture.dependencies);
  const payment = await fixture.activatePayment(service, "pay-a", "rev-a", 100);
  await assert.rejects(() => fixture.activateRefund(service, "refund-a", "rev-a", 20, { paymentFactId: "pay-a", paymentSetId: payment.id, paymentItemId: "wrong-item" }), /refund_payment_item_invalid/);
});

test("settlement replacement advances one recorded tick and preserves historical asOf", async () => {
  const fixture = settlementLifecycleFixture();
  assert.equal(fixture.asOfReader.getActiveId(fixture.events, "2026-08-08T23:59:59.999Z"), "payment-v1");
  assert.equal(fixture.asOfReader.getActiveId(fixture.events, "2026-08-09T00:00:00.000Z"), null);
  assert.equal(fixture.asOfReader.getActiveId(fixture.events, "2026-08-09T00:00:00.001Z"), "payment-v2");
  assert.deepEqual(fixture.events.map((event) => event.eventSequence), [1, 2, 3]);
});

test("settlement draft and activation recover one immutable result after Foundation completion loss", async () => {
  const fixture = settlementFixture({ failFoundationCompletionOncePerMutation: true });
  const service = new CashSettlementAllocationService(fixture.dependencies);
  await assert.rejects(() => service.createDraft(fixture.context("settlement-draft-loss"), fixture.completeDraft), /injected_completion_loss/);
  await fixture.expireFoundationLease();
  const draft = await service.createDraft(fixture.context("settlement-draft-loss"), fixture.completeDraft);
  await assert.rejects(() => service.activate({ ...fixture.context("settlement-activate-loss"), expectedRevision: 1 }, draft.id), /injected_completion_loss/);
  await fixture.expireFoundationLease();
  const active = await service.activate({ ...fixture.context("settlement-activate-loss"), expectedRevision: 1 }, draft.id);
  assert.equal(active.id, draft.id);
  assert.deepEqual(await fixture.domainCommandRowCounts(), { drafts: 1, activations: 1 });
});

test("settlement replay reauthorizes and rejects a shared key on another set", async () => {
  const fixture = settlementFixture();
  const service = new CashSettlementAllocationService(fixture.dependencies);
  const [a, b] = await fixture.twoCompleteDrafts(service);
  await service.activate({ ...fixture.context("shared-settlement-key"), expectedRevision: 1 }, a.id);
  await fixture.revoke("ledger.verify");
  await assert.rejects(() => service.activate({ ...fixture.context("shared-settlement-key"), expectedRevision: 1 }, a.id), /capability_forbidden/);
  await fixture.restore("ledger.verify");
  await assert.rejects(() => service.activate({ ...fixture.context("shared-settlement-key"), expectedRevision: 1 }, b.id), /idempotency_conflict/);
  assert.equal(await fixture.activationCount(b.id), 0);
});
```

- [ ] **Step 2: Run settlement tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/financial-settlement-allocation-test.ts`

Expected: FAIL because settlement modules are absent.

- [ ] **Step 3: Implement deal guards and legal settlement allocation**

Create immutable draft/set/item rows plus append-only source-level lifecycle events from section 8.10.1. Source and targets must be verified, non-reversed, same workspace, deal, quote, currency, and binding hash. Payment plus bad-debt allocation cannot exceed recognized revenue. Overpayment remains unallocated; partial payment remains a gap. Refund locks and validates the exact settlement version selected by lifecycle, its payment item, and decreases both net cash and net revenue.

Public `createDraft` and `activate` each perform their capability check and call the one injected `RoiCommandExecutor.execute` exactly once, using respectively the collection path and Foundation's frozen `:id` activation template (the validated concrete ID is already in `context.requestHash`). Their private `createDraftClaimed`/`activateClaimed` cores never touch Foundation idempotency. The draft row persists its create command identity; only the new `activated` lifecycle event persists activation command identity. Each claimed core starts with an indexed non-locking hash probe that exact-checks actor/request/resource/revision and returns the same ID on recovery; a miss enters the barrier-first domain transaction. `authorizeAndProject` repeats current authorization and workspace/resource checks on completed replay. Command identity fields are internal and never appear in settlement DTOs.

Introduce a `(workspaceId, dealId, currency)` settlement guard so every mutation for one deal serializes before individual fact locks. Every settlement transaction first acquires the workspace temporal barrier; each superseded/activated lifecycle append receives its own global `{recordedAt,temporalSequence}` before the deal guard/source head and fact locks. Refuse payment reassignment while an active refund references it. Historical settlement readers consume the boundary's `GrowthSealedReadCutoff` and never reseal.

The minimum GREEN public wrapper plus private claimed activation validates and locks in the declared order; `requireVerifiedFacts` returns source followed by target rows sorted by `(dealId,id)`:

```ts
async activate(context: CommandContext, setId: string) {
  requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
  const expectedRevision = requireExpectedRevision(context);
  return this.commandExecutor.execute(context, {
    method: "POST",
    canonicalPath: "/api/v1/finance/settlement-allocation-sets/:id/activate",
    resourceKind: "settlement_set"
  }, {
    authorizeAndProject: (ids) => this.authorizeAndProjectActivation(context, setId, ids),
    executeClaimed: (domainCommandHash) => this.activateClaimed(context, setId, expectedRevision, domainCommandHash)
  });
}

private async activateClaimed(context: CommandContext, setId: string, expectedRevision: number, domainCommandHash: `sha256:${string}`): Promise<RoiCommandExecutionIds> {
  const replay = await this.repository.findActivationByDomainCommandHash(context.workspace.workspaceId, domainCommandHash); // indexed, non-locking
  if (replay !== null) return this.requireExactActivationReplay(replay, context, setId, expectedRevision);
  return this.repository.transaction(async (tx) => {
    const firstStamp = await this.temporalBarrier.allocateAppend(tx, context.workspace.workspaceId);
    const draft = await tx.requireDraft(context.workspace.workspaceId, setId);
    const identities = await this.facts.requireSettlementIdentities(context.workspace, draft.sourceFactId, draft.items);
    await tx.lockDealGuard(context.workspace.workspaceId, identities.dealId, identities.currency);
    const facts = await tx.requireVerifiedFacts(context.workspace.workspaceId, draft.sourceFactId, draft.items.map((item) => item.targetRevenueFactId));
    this.validateSameCommercialBinding(facts.source, facts.targets);
    await tx.lockReferencedPaymentItems(draft.items.filter((item) => item.originalPaymentAllocationItemId !== null));
    const capacity = await tx.remainingRevenueCapacity(context.workspace.workspaceId, facts.targets.map((fact) => fact.id), draft.sourceFactId);
    for (const item of draft.items) if (item.amountMinor > (capacity.get(item.targetRevenueFactId) ?? 0)) throw new SettlementError("revenue_overallocated", 422);
    const head = await tx.lockSourceHead(context.workspace.workspaceId, draft.sourceFactId);
    if (head.revision !== expectedRevision) throw new SettlementError("revision_mismatch", 412);
    if (head.activeSetId !== null) await tx.assertNotReferencedByActiveRefund(head.activeSetId);
    let nextSequence = head.lastEventSequence;
    let activationStamp = firstStamp;
    if (head.activeSetId !== null) {
      await tx.appendLifecycleEvent(settlementLifecycleEvent({ head, allocationSetId: head.activeSetId, eventType: "superseded", eventSequence: ++nextSequence, revision: nextSequence, effectiveAt: firstStamp.recordedAt, ...firstStamp, actorId: context.actorId }));
      activationStamp = await this.temporalBarrier.allocateAppend(tx, context.workspace.workspaceId);
    }
    await tx.appendLifecycleEvent(settlementLifecycleEvent({ head, allocationSetId: draft.id, eventType: "activated", eventSequence: ++nextSequence, revision: nextSequence, effectiveAt: activationStamp.recordedAt, ...activationStamp, actorId: context.actorId, supersedesAllocationSetId: head.activeSetId, activationDomainCommandHash: domainCommandHash, activationRequestHash: context.requestHash, requestedBy: context.actorId }));
    await tx.advanceSourceHead(head, draft.id, expectedRevision + 1, nextSequence);
    return { resourceId: draft.id, operationId: null };
  });
}
```

`reconcile(workspace,revenueFactIds,cutoff: GrowthSealedReadCutoff)` validates `workspace.workspaceId===cutoff.workspaceId` and resolves each source through `CashSettlementAllocationAsOfReader.getActiveAt(workspace,{sourceFactId,cutoff})`, which orders effective events by `(effectiveAt,eventSequence)` and validates contiguous sequence/revision. `AttributionAllocationAsOfReader.getActiveAt` follows the same token/workspace contract. Neither reader reads the current source head, accepts a naked `asOf`, or reseals to answer a historical query. Tests pass one token object through allocation, settlement and reconciliation by identity, reject a cross-workspace token, and assert zero nested seal calls. The pure reducers `activeAttributionSetIdAsOf(events,asOf)` and settlement equivalent may keep their string cutoff because they have no repository/barrier authority.

- [ ] **Step 4: Verify partial cash, overpayment, cross-deal, and refund invariants**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/financial-settlement-allocation-test.ts src/financial-fact-ledger-test.ts`

Expected: PASS; aggregate equality across deals never masks a per-deal gap.

- [ ] **Step 5: Commit in-memory settlements**

```bash
git add backend/src/financial-settlement-allocation.ts backend/src/financial-settlement-allocation-repository.ts backend/src/financial-settlement-allocation-test.ts backend/src/growth-roi-test-fixtures.ts
git commit -m "feat: reconcile cash per revenue fact"
```

### Task 8: Persist settlements and prove concurrent payment/bad-debt safety

**Files:**
- Create: `backend/src/financial-settlement-allocation-mysql-repository.ts`
- Create: `backend/src/growth-roi-settlement-mysql-test.ts`
- Modify: `backend/src/growth-finance-mysql-test-support.ts`
- Modify: `backend/src/growth-finance-mysql.ts`
- Modify: `backend/package.json`
- Test: `backend/src/growth-roi-settlement-mysql-test.ts`

**Interfaces:**
- Consumes: Task 7 repository contract and shared MySQL harness.
- Produces: `FINANCIAL_SETTLEMENT_MYSQL_SCHEMA_STATEMENTS`, `ensureFinancialSettlementMysqlSchema(pool)`, and `MysqlFinancialSettlementRepository`.

- [ ] **Step 1: Write the failing concurrent payment/bad-debt test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";
import { settlementDraft } from "./growth-roi-test-fixtures.js";

test("concurrent payment and bad debt cannot consume more than one revenue", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    await fixture.insertVerifiedRevenue("rev-a", "deal-a", 100);
    await fixture.insertVerifiedPayment("pay-a", "deal-a", 70);
    await fixture.insertVerifiedBadDebt("bad-a", "deal-a", 70);
    const service = fixture.settlementService();
    const [paySet, badSet] = await Promise.all([
      service.createDraft(fixture.context("pay-draft"), settlementDraft("pay-a", "rev-a", 70)),
      service.createDraft(fixture.context("bad-draft"), settlementDraft("bad-a", "rev-a", 70))
    ]);
    const results = await Promise.allSettled([
      service.activate({ ...fixture.context("pay-active"), expectedRevision: 1 }, paySet.id),
      service.activate({ ...fixture.context("bad-active"), expectedRevision: 1 }, badSet.id)
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  });
});
```

- [ ] **Step 2: Run MySQL settlement tests to verify RED**

Run: `cd backend && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-roi:mysql`

Expected: FAIL until settlement tables and repository exist.

- [ ] **Step 3: Implement fixed-order row locking and immutable versions**

Create `cash_settlement_deal_guards`, `cash_settlement_source_heads`, `cash_settlement_allocation_sets`, `cash_settlement_allocation_items`, and `cash_settlement_allocation_lifecycle_events`. Draft sets store non-null `create_domain_command_hash/create_request_hash/requested_by`; lifecycle rows store nullable `activation_domain_command_hash/activation_request_hash/requested_by`, populated only on `activated`. Add unique `(workspace_id,create_domain_command_hash)` and `(workspace_id,activation_domain_command_hash)` probes. After a probe miss and temporal-barrier allocation, lock the deal guard first, then source fact, sorted target revenue facts, referenced payment rows, and source head. Use unique source versions and immutable set/item/event rows. Enforce unique `(workspace_id,source_fact_id,event_sequence)` and `(workspace_id,source_fact_id,revision)` keys; only the operational head is CAS-updated. Historical and closure readers reconstruct the effective settlement version from events rather than a mutable status column.

Replace `backend/package.json`'s stage-4 MySQL command with this cumulative, explicitly named suite:

```json
{
  "scripts": {
    "test:growth-roi:mysql": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/growth-roi-discovery-projection-mysql-test.ts src/growth-roi-cohort-mysql-test.ts src/growth-roi-cohort-recovery-mysql-test.ts src/growth-roi-attribution-mysql-test.ts src/growth-roi-settlement-mysql-test.ts"
  }
}
```

Use non-null frozen reference columns and foreign keys for refund bindings; the repository activation starts with these exact locks:

```ts
await connection.execute(
  `SELECT workspace_id FROM cash_settlement_deal_guards
   WHERE workspace_id=? AND deal_id=? AND currency=? FOR UPDATE`,
  [workspaceId, dealId, currency]
);
await connection.execute(
  `SELECT id, fact_type, amount_minor, currency, commercial_binding_hash
   FROM financial_facts WHERE workspace_id=? AND id IN (?)
   ORDER BY deal_id, id FOR UPDATE`,
  [workspaceId, [sourceFactId, ...targetRevenueFactIds].sort()]
);
await connection.execute(
  `SELECT id, allocation_set_id, target_revenue_fact_id, amount_minor
   FROM cash_settlement_allocation_items
   WHERE workspace_id=? AND id IN (?) ORDER BY id FOR UPDATE`,
  [workspaceId, referencedPaymentItemIds.sort()]
);
```

The migration adds `UNIQUE KEY uk_settlement_source_version (workspace_id,source_fact_id,version)` and foreign keys from `(original_payment_allocation_set_id,original_payment_allocation_item_id)` to the immutable payment allocation item. The service rejects an empty reference list for refunds rather than relying on nullable SQL uniqueness.

- [ ] **Step 4: Verify two-connection races and refund/payment lock ordering**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/financial-settlement-allocation-test.ts && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-roi:mysql`

Expected: PASS without deadlocks; one over-allocation attempt loses and an active refund prevents payment reassignment. Real MySQL injects loss after draft/activation business commit but before Foundation completion and proves stable IDs with one domain append; a completed replay after `ledger.verify` revocation writes nothing, and reuse of the same key for another set ID/revision returns `idempotency_conflict` before domain locks.

- [ ] **Step 5: Commit MySQL settlements**

```bash
git add backend/src/financial-settlement-allocation-mysql-repository.ts backend/src/growth-roi-settlement-mysql-test.ts backend/src/growth-finance-mysql-test-support.ts backend/src/growth-finance-mysql.ts backend/package.json
git commit -m "feat: persist cash settlement allocations"
```

### Task 9: Implement deterministic expected and closed-actual ROI calculation

**Files:**
- Create: `backend/src/acquisition-roi-calculation.ts`
- Create: `backend/src/acquisition-roi-calculation-test.ts`
- Test: `backend/src/acquisition-roi-calculation-test.ts`

**Interfaces:**
- Consumes: fixed-point money, authoritative quote contributions, attributed estimates, verified actual aggregates, and coverage states.
- Produces: `calculateExpectedRoi(input)`, `calculateActualRoiForClosure(input)`, `GrowthRoiStatus`, and formula version constants.

```ts
export interface ClosureCalculationEvidence {
  membershipSnapshotHash: string; attestationSetHash: string;
  factSetHash: string; costSetHash: string;
  allocationSetHash: string; settlementSetHash: string;
}
export interface ClosedActualRoiInput {
  verifiedRevenueMinor: number; verifiedCogsMinor: number;
  verifiedRefundMinor: number; verifiedBadDebtMinor: number;
  verifiedAcquisitionCostMinor: number; allCoverageBps: number;
  cashReconciled: boolean; closureEvidence: ClosureCalculationEvidence | null;
}
export type RoiGapCode =
  | "cost_missing" | "cost_not_closed" | "gross_profit_unverified"
  | "cash_reconciliation_incomplete" | "attribution_incomplete"
  | "multi_currency_without_fx" | "zero_estimated_cost" | "zero_cost"
  | "query_truncated" | "cohort_not_closed";
export type ExpectedRoiResult =
  | { status: "computed"; probabilityWeightedGrossProfitMinor: number; attributedEstimatedCostMinor: number; roiBps: number; formulaVersion: "expected-gross-profit-roi.v1" }
  | { status: "not_computable"; reason: "cost_missing" | "attribution_incomplete" | "zero_estimated_cost"; formulaVersion: "expected-gross-profit-roi.v1" };
export interface ExpectedRoiContributionInput {
  dealId: string; approvedGrossProfitMinor: number; closeProbabilityBps: number;
}
export type ClosedActualRoiResult =
  | { status: "computed"; verifiedGrossProfitMinor: number; verifiedAcquisitionCostMinor: number; roiBps: number; formulaVersion: "verified-gross-profit-roi.v1" }
  | { status: "not_computable"; reason: RoiGapCode; formulaVersion: "verified-gross-profit-roi.v1" };
```

Import, rather than redeclare, the quote-plan-owned `AuthoritativeQuoteAsOfReader` and `AuthoritativeQuoteContribution`. Its exact token-only call is `listContributionsAsOf(context: ActiveWorkspaceContext, input: { candidateIds: string[]; currency: string; cutoff: GrowthSealedReadCutoff }): Promise<AuthoritativeQuoteContribution[]>`; each contribution contains `candidateId`, `dealId`, `quoteVersionId`, `currency`, `approvedQuoteGrossProfitMinor`, `closeProbabilityBps`, `probabilityAssessmentId`, and `commercialAmountHash`. Cohort membership and `firstPlanId` filtering belong to Stage 4: filter members first, then pass their canonical candidate IDs and the same boundary token to this Stage-2 reader.

- [ ] **Step 1: Write failing ROI golden tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { calculateActualRoiForClosure, calculateExpectedRoi } from "./acquisition-roi-calculation.js";
import { roundSignedHalfUpDiv } from "./growth-money.js";

test("expected ROI applies probability exactly once", () => {
  assert.deepEqual(calculateExpectedRoi({ contributions: [{ dealId: "deal-a", approvedGrossProfitMinor: 10000, closeProbabilityBps: 4000 }], attributedEstimatedCostMinor: 1000, costCoverageBps: 10000 }), { status: "computed", probabilityWeightedGrossProfitMinor: 4000, attributedEstimatedCostMinor: 1000, roiBps: 30000, formulaVersion: "expected-gross-profit-roi.v1" });
});

test("known attributed cost with no authoritative quote contribution is minus one hundred percent", () => {
  assert.deepEqual(calculateExpectedRoi({ contributions: [], attributedEstimatedCostMinor: 1000, costCoverageBps: 10000 }), {
    status: "computed", probabilityWeightedGrossProfitMinor: 0,
    attributedEstimatedCostMinor: 1000, roiBps: -10000,
    formulaVersion: "expected-gross-profit-roi.v1"
  });
  assert.deepEqual(calculateExpectedRoi({ contributions: [], attributedEstimatedCostMinor: null, costCoverageBps: 10000 }), {
    status: "not_computable", reason: "cost_missing", formulaVersion: "expected-gross-profit-roi.v1"
  });
});

test("expected ROI rounds each Deal independently before deterministic summation", () => {
  const heterogeneous = calculateExpectedRoi({
    contributions: [
      { dealId: "deal-b", approvedGrossProfitMinor: -2000, closeProbabilityBps: 2500 },
      { dealId: "deal-a", approvedGrossProfitMinor: 10000, closeProbabilityBps: 4000 }
    ],
    attributedEstimatedCostMinor: 1000,
    costCoverageBps: 10000
  });
  assert.deepEqual(heterogeneous, { status: "computed", probabilityWeightedGrossProfitMinor: 3500, attributedEstimatedCostMinor: 1000, roiBps: 25000, formulaVersion: "expected-gross-profit-roi.v1" });
  const signedTies = calculateExpectedRoi({
    contributions: [
      { dealId: "deal-a", approvedGrossProfitMinor: 1, closeProbabilityBps: 5000 },
      { dealId: "deal-b", approvedGrossProfitMinor: -1, closeProbabilityBps: 5000 }
    ],
    attributedEstimatedCostMinor: 2,
    costCoverageBps: 10000
  });
  assert.deepEqual(signedTies, { status: "computed", probabilityWeightedGrossProfitMinor: 0, attributedEstimatedCostMinor: 2, roiBps: -10000, formulaVersion: "expected-gross-profit-roi.v1" });
});

test("actual ROI uses verified gross profit and cost only during closure", () => {
  const values = { verifiedRevenueMinor: 100000, verifiedCogsMinor: 20000, verifiedRefundMinor: 5000, verifiedBadDebtMinor: 5000, verifiedAcquisitionCostMinor: 20000, allCoverageBps: 10000, cashReconciled: true };
  const closureEvidence = {
    membershipSnapshotHash: `sha256:${"a".repeat(64)}`,
    attestationSetHash: `sha256:${"b".repeat(64)}`,
    factSetHash: `sha256:${"c".repeat(64)}`,
    costSetHash: `sha256:${"d".repeat(64)}`,
    allocationSetHash: `sha256:${"e".repeat(64)}`,
    settlementSetHash: `sha256:${"f".repeat(64)}`
  };
  assert.deepEqual(calculateActualRoiForClosure({ ...values, closureEvidence }), { status: "computed", verifiedGrossProfitMinor: 70000, verifiedAcquisitionCostMinor: 20000, roiBps: 25000, formulaVersion: "verified-gross-profit-roi.v1" });
  assert.throws(() => calculateActualRoiForClosure({ ...values, closureEvidence: null }), /actual_roi_requires_closure_evidence/);
});

test("expected and actual ROI preserve negative results with signed rounding", () => {
  const closureEvidence = {
    membershipSnapshotHash: `sha256:${"a".repeat(64)}`,
    attestationSetHash: `sha256:${"b".repeat(64)}`,
    factSetHash: `sha256:${"c".repeat(64)}`,
    costSetHash: `sha256:${"d".repeat(64)}`,
    allocationSetHash: `sha256:${"e".repeat(64)}`,
    settlementSetHash: `sha256:${"f".repeat(64)}`
  };
  const expected = calculateExpectedRoi({ contributions: [{ dealId: "deal-a", approvedGrossProfitMinor: 0, closeProbabilityBps: 10_000 }], attributedEstimatedCostMinor: 3, costCoverageBps: 10_000 });
  assert.equal(expected.status, "computed");
  if (expected.status !== "computed") throw new Error("expected_computed_roi");
  assert.equal(expected.roiBps, -10_000);
  assert.equal(roundSignedHalfUpDiv(1n, 2n), 1n);
  assert.equal(roundSignedHalfUpDiv(-1n, 2n), -1n);
  assert.deepEqual(calculateActualRoiForClosure({ verifiedRevenueMinor: 50, verifiedCogsMinor: 80, verifiedRefundMinor: 0, verifiedBadDebtMinor: 0, verifiedAcquisitionCostMinor: 20, allCoverageBps: 10_000, cashReconciled: true, closureEvidence }), {
    status: "computed", verifiedGrossProfitMinor: -30, verifiedAcquisitionCostMinor: 20,
    roiBps: -25_000, formulaVersion: "verified-gross-profit-roi.v1"
  });
  for (const invalid of [
    `sha256:${"a".repeat(63)}`,
    `sha256:${"a".repeat(65)}`,
    `sha256:${"g".repeat(64)}`
  ]) {
    assert.throws(() => calculateActualRoiForClosure({
      verifiedRevenueMinor: 1, verifiedCogsMinor: 0, verifiedRefundMinor: 0,
      verifiedBadDebtMinor: 0, verifiedAcquisitionCostMinor: 1,
      allCoverageBps: 10_000, cashReconciled: true,
      closureEvidence: { ...closureEvidence, factSetHash: invalid as `sha256:${string}` }
    }), /actual_roi_requires_closure_evidence/);
  }
});

test("ROI rejects unsafe, negative unsigned, and out-of-range BPS before BigInt conversion", () => {
  for (const invalid of [
    () => calculateExpectedRoi({ contributions: [], attributedEstimatedCostMinor: -1, costCoverageBps: 10_000 }),
    () => calculateExpectedRoi({ contributions: [{ dealId: "deal-a", approvedGrossProfitMinor: 1, closeProbabilityBps: 10_001 }], attributedEstimatedCostMinor: 1, costCoverageBps: 10_000 }),
    () => calculateExpectedRoi({ contributions: [{ dealId: "deal-a", approvedGrossProfitMinor: Number.MAX_SAFE_INTEGER + 1, closeProbabilityBps: 1 }], attributedEstimatedCostMinor: 1, costCoverageBps: 10_000 }),
    () => calculateActualRoiForClosure({ verifiedRevenueMinor: -1, verifiedCogsMinor: 0, verifiedRefundMinor: 0, verifiedBadDebtMinor: 0, verifiedAcquisitionCostMinor: 1, allCoverageBps: 10_000, cashReconciled: true, closureEvidence: validClosureEvidence() }),
    () => calculateActualRoiForClosure({ verifiedRevenueMinor: 1, verifiedCogsMinor: 0, verifiedRefundMinor: 0, verifiedBadDebtMinor: 0, verifiedAcquisitionCostMinor: 1, allCoverageBps: -1, cashReconciled: true, closureEvidence: validClosureEvidence() })
  ]) assert.throws(invalid, /roi_input_invalid/);
  assert.throws(() => calculateExpectedRoi({
    contributions: [
      { dealId: "deal-a", approvedGrossProfitMinor: Number.MAX_SAFE_INTEGER, closeProbabilityBps: 10_000 },
      { dealId: "deal-b", approvedGrossProfitMinor: Number.MAX_SAFE_INTEGER, closeProbabilityBps: 10_000 }
    ], attributedEstimatedCostMinor: 1, costCoverageBps: 10_000
  }), /amount_out_of_range/);
});

test("contract ROAS, cash multiple, and collection rate remain separate fixed-point ratios", () => {
  assert.deepEqual(calculateContractRoas({ verifiedContractWonMinor: 1000, verifiedAcquisitionCostMinor: 200 }), {
    status: "computed", bps: 50_000, formulaVersion: "contract-roas.v1"
  });
  assert.deepEqual(calculateCashMultiple({ allocatedPaymentMinor: 900, verifiedAcquisitionCostMinor: 200 }), {
    status: "computed", bps: 45_000, formulaVersion: "cash-multiple.v1"
  });
  assert.deepEqual(calculateCollectionRate({ allocatedPaymentMinor: 900, verifiedContractWonMinor: 1000 }), {
    status: "computed", bps: 9_000, formulaVersion: "collection-rate.v1"
  });
  assert.deepEqual(calculateContractRoas({ verifiedContractWonMinor: 1000, verifiedAcquisitionCostMinor: 0 }), {
    status: "not_available", reason: "zero_cost", formulaVersion: "contract-roas.v1"
  });
  assert.deepEqual(calculateCollectionRate({ allocatedPaymentMinor: 0, verifiedContractWonMinor: 0 }), {
    status: "not_available", reason: "zero_contract_amount", formulaVersion: "collection-rate.v1"
  });
});
```

- [ ] **Step 2: Run ROI tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-roi-calculation-test.ts`

Expected: FAIL with missing ROI calculation module.

- [ ] **Step 3: Implement fixed-point formulas and enumerated gaps**

Use `BigInt`, strict unsigned `roundHalfUpDiv/safeMinor` for nonnegative amounts, and foundation-owned `roundSignedHalfUpDiv/safeSignedInteger` for profit and ROI BPS. Before any `BigInt(number)` call, `requireUnsignedRoiMinor` rejects non-safe integers and negatives, `requireSignedRoiInteger` rejects non-safe signed values, and `requireRoiBps` accepts only integer `0..10000`; all invalid inputs throw stable `roi_input_invalid`, while an intermediate/final value outside the JavaScript-safe range throws stable `amount_out_of_range`. Apply them to every revenue/cogs/refund/bad-debt/contract-won/payment/cost/estimated-cost, approved gross-profit, probability, allocation and coverage input. Expected ROI accepts `attributedEstimatedCostMinor: number | null`, where `null` alone means `cost_missing`; it accepts the closed `contributions[]` input, rejects duplicate `dealId`, sorts by code-point `dealId`, applies signed half-up probability weighting once per Deal, and only then sums with `BigInt`. An empty contribution set with a known positive, fully attributed cost has weighted gross profit `0` and computes exactly `-10000` BPS; it is not a missing-cost condition. Expected returns `zero_estimated_cost` only for known zero cost and `attribution_incomplete` for incomplete cost coverage. `calculateActualRoiForClosure` requires a non-null `closureEvidence` object containing all six canonical set hashes; reject null, blank, or non-`sha256:` values before arithmetic. Only `RoiClosureService.close` may import this function. Compute `verifiedGrossProfit = revenue - cogs - refunds - badDebt`, then `(grossProfit - cost) * 10000 / cost`; validate cumulative results with `safeSignedInteger` so summed overflow fails closed.

Implement three separate non-ROI ratios with unsigned BigInt half-up arithmetic and closed results: `calculateContractRoas({verifiedContractWonMinor,verifiedAcquisitionCostMinor}) = contractWon*10000/cost`, `calculateCashMultiple({allocatedPaymentMinor,verifiedAcquisitionCostMinor}) = allocatedPayment*10000/cost`, and `calculateCollectionRate({allocatedPaymentMinor,verifiedContractWonMinor}) = allocatedPayment*10000/contractWon`. Their formula versions are respectively `contract-roas.v1`, `cash-multiple.v1`, and `collection-rate.v1`. A zero cost returns `not_available: zero_cost` for the first two; a zero contract amount returns `not_available: zero_contract_amount` for collection rate. Refunds reduce the separately displayed `netCashMinor = allocatedPaymentMinor - allocatedRefundMinor` but do not rewrite the design-defined “已到账金额” numerator. They never inherit actual ROI's profitability name/status and never divide by zero. Closure alone supplies verified, currency-matched `contract_won`, allocated payment, net cash, and acquisition-cost totals.

```ts
const requireClosureEvidence = (evidence: ClosureCalculationEvidence | null) => {
  if (evidence === null || Object.values(evidence).some((value) => !/^sha256:[a-f0-9]{64}$/u.test(value))) {
    throw new Error("actual_roi_requires_closure_evidence");
  }
};

const requireUnsignedRoiMinor = (value: number, field: string) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RoiCalculationError("roi_input_invalid", field);
};
const requireSignedRoiInteger = (value: number, field: string) => {
  if (!Number.isSafeInteger(value)) throw new RoiCalculationError("roi_input_invalid", field);
};
const requireRoiBps = (value: number, field: string) => {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new RoiCalculationError("roi_input_invalid", field);
};

export function calculateExpectedRoi(input: { contributions: ExpectedRoiContributionInput[]; attributedEstimatedCostMinor: number | null; costCoverageBps: number }): ExpectedRoiResult {
  if (input.attributedEstimatedCostMinor === null) return { status: "not_computable", reason: "cost_missing", formulaVersion: "expected-gross-profit-roi.v1" };
  requireUnsignedRoiMinor(input.attributedEstimatedCostMinor, "attributedEstimatedCostMinor");
  requireRoiBps(input.costCoverageBps, "costCoverageBps");
  if (input.costCoverageBps !== 10000) return { status: "not_computable", reason: "attribution_incomplete", formulaVersion: "expected-gross-profit-roi.v1" };
  if (input.attributedEstimatedCostMinor === 0) return { status: "not_computable", reason: "zero_estimated_cost", formulaVersion: "expected-gross-profit-roi.v1" };
  const ordered = [...input.contributions].sort((left, right) => left.dealId < right.dealId ? -1 : left.dealId > right.dealId ? 1 : 0);
  const seen = new Set<string>();
  let weighted = 0n;
  for (const contribution of ordered) {
    if (seen.has(contribution.dealId)) throw new Error("duplicate_expected_roi_deal");
    seen.add(contribution.dealId);
    requireSignedRoiInteger(contribution.approvedGrossProfitMinor, "approvedGrossProfitMinor");
    requireRoiBps(contribution.closeProbabilityBps, "closeProbabilityBps");
    weighted += roundSignedHalfUpDiv(BigInt(contribution.approvedGrossProfitMinor) * BigInt(contribution.closeProbabilityBps), 10000n);
  }
  const roi = roundSignedHalfUpDiv((weighted - BigInt(input.attributedEstimatedCostMinor)) * 10000n, BigInt(input.attributedEstimatedCostMinor));
  return { status: "computed", probabilityWeightedGrossProfitMinor: safeSignedInteger(weighted, "probabilityWeightedGrossProfitMinor"), attributedEstimatedCostMinor: input.attributedEstimatedCostMinor, roiBps: safeSignedInteger(roi, "roiBps"), formulaVersion: "expected-gross-profit-roi.v1" };
}

export function calculateActualRoiForClosure(input: ClosedActualRoiInput): ClosedActualRoiResult {
  requireClosureEvidence(input.closureEvidence);
  requireUnsignedRoiMinor(input.verifiedRevenueMinor, "verifiedRevenueMinor");
  requireUnsignedRoiMinor(input.verifiedCogsMinor, "verifiedCogsMinor");
  requireUnsignedRoiMinor(input.verifiedRefundMinor, "verifiedRefundMinor");
  requireUnsignedRoiMinor(input.verifiedBadDebtMinor, "verifiedBadDebtMinor");
  requireUnsignedRoiMinor(input.verifiedAcquisitionCostMinor, "verifiedAcquisitionCostMinor");
  requireRoiBps(input.allCoverageBps, "allCoverageBps");
  if (!input.cashReconciled) return { status: "not_computable", reason: "cash_reconciliation_incomplete", formulaVersion: "verified-gross-profit-roi.v1" };
  if (input.allCoverageBps !== 10000) return { status: "not_computable", reason: "attribution_incomplete", formulaVersion: "verified-gross-profit-roi.v1" };
  if (input.verifiedAcquisitionCostMinor === 0) return { status: "not_computable", reason: "zero_cost", formulaVersion: "verified-gross-profit-roi.v1" };
  const grossProfit = BigInt(input.verifiedRevenueMinor) - BigInt(input.verifiedCogsMinor) - BigInt(input.verifiedRefundMinor) - BigInt(input.verifiedBadDebtMinor);
  const roi = roundSignedHalfUpDiv((grossProfit - BigInt(input.verifiedAcquisitionCostMinor)) * 10000n, BigInt(input.verifiedAcquisitionCostMinor));
  return { status: "computed", verifiedGrossProfitMinor: safeSignedInteger(grossProfit, "verifiedGrossProfitMinor"), verifiedAcquisitionCostMinor: input.verifiedAcquisitionCostMinor, roiBps: safeSignedInteger(roi, "roiBps"), formulaVersion: "verified-gross-profit-roi.v1" };
}
```

- [ ] **Step 4: Run JPY/CNY/KWD, negative-margin, zero-cost, and range tests**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-roi-calculation-test.ts src/growth-money-test.ts`

Expected: PASS; expected golden case is 300%, actual golden case is 250%, and out-of-range signed ROI fails closed.

- [ ] **Step 5: Commit ROI math**

```bash
git add backend/src/acquisition-roi-calculation.ts backend/src/acquisition-roi-calculation-test.ts
git commit -m "feat: calculate expected and closed actual roi"
```

### Task 10: Implement closure attestations and immutable in-memory close/reopen state machine

**Files:**
- Create: `backend/src/acquisition-roi-closure.ts`
- Create: `backend/src/acquisition-roi-closure-repository.ts`
- Create: `backend/src/acquisition-roi-closure-test.ts`
- Modify: `backend/src/growth-roi-test-fixtures.ts`
- Test: `backend/src/financial-ledger-as-of-reader-test.ts`
- Test: `backend/src/acquisition-roi-closure-test.ts`

**Interfaces:**
- Consumes: Tasks 2–9 and Finance-owned `VerifiedFinancialLedgerSealedReader` from `GrowthFinanceServices.verifiedAsOf` (memory/MySQL implementations and historical tests are completed in Stage 3).
- Authorizes: `RoiClosureService.createAttestationAt`, `closeAt`, and `reopen`, plus their HTTP boundaries, require current `roi.close` in the service before idempotency/operation/evidence work; recovery uses `RoiClosureRecoveryAuthorizer` and repeats the same check. `getVersion` and cohort/Closure reads require the server-derived team/workspace Growth Performance visibility port. Sales and managers without these exact capabilities receive a closed error and zero writes.
- Produces: token-only `RoiClosureService.createAttestationAt/closeAt/reopen/getVersion`, recovery-only `RoiClosureCoordinator.resume`, `RoiClosureRepository`, internal persisted closure records, and closed public closure/snapshot projections. The HTTP boundary owns raw `asOf` validation/sealing and can call only the `*At` methods. Closure code receives verified cost/fact truth only from the injected Finance reader.

```ts
export type ClosureAspect = "acquisition_cost" | "revenue" | "cogs" | "cash" | "refund_bad_debt" | "attribution";
export type ClosureEvidenceRef =
  | { kind: "source_report"; sourceReportId: string; reportHash: string }
  | { kind: "ledger_entry"; ledgerType: "cost" | "financial"; ledgerEntryId: string; evidenceHash: string }
  | { kind: "verification"; ledgerType: "cost" | "financial"; ledgerEntryId: string; verificationEventId: string }
  | { kind: "allocation_set"; allocationKind: "attribution" | "settlement"; allocationSetId: string; version: number };
export interface RoiCoverageSnapshot {
  costCoverageBps: number; marginCoverageBps: number;
  cashCoverageBps: number; attributionCoverageBps: number;
  gapCodes: RoiGapCode[];
}
export interface ClosureAttestation {
  id: string; workspaceId: string; cohortId: string; currency: string;
  aspect: ClosureAspect; periodFrom: string; periodTo: string; asOf: string;
  declaredTotalMinor: number | null; sourceSystem: string; sourceCursor: string | null;
  sourceReportId: string | null; reportAllocationSetId: string | null;
  reportHash: string; evidenceRefs: ClosureEvidenceRef[]; status: "signed" | "superseded";
  signedBy: string; signedAt: string;
}
interface PersistedClosureAttestation extends ClosureAttestation {
  appendTemporalSequence: number;
  domainCommandHash: `sha256:${string}`;
  requestHash: `sha256:${string}`;
  requestedBy: string;
}
export interface RoiClosureSeries {
  id: string; workspaceId: string; cohortId: string; currency: string;
  status: "open" | "closed"; currentClosureVersionId: string | null;
  revision: number; updatedAt: string;
}
export interface RoiClosureVersion {
  id: string; workspaceId: string; cohortId: string; currency: string;
  version: number; asOf: string; status: "closed" | "superseded";
  previousClosureVersionId: string | null; formulaVersion: "verified-gross-profit-roi.v1";
  membershipSnapshotHash: string; attestationSetHash: string; factSetHash: string;
  costSetHash: string; allocationSetHash: string; settlementSetHash: string;
  closedBy: string; closedAt: string;
}
interface PersistedRoiClosureVersion extends Omit<RoiClosureVersion, "status"> {
  sealedCutoffTemporalSequence: number;
  appendTemporalSequence: number;
}
export type GrowthCommercialRatioResult<Formula extends string, ZeroReason extends string> =
  | { status: "computed"; bps: number; formulaVersion: Formula }
  | { status: "not_available"; reason: ZeroReason; formulaVersion: Formula };
export interface ClosedCommercialRatioSnapshot {
  verifiedContractWonMinor: number; allocatedPaymentMinor: number; netCashMinor: number; verifiedAcquisitionCostMinor: number;
  contractRoas: GrowthCommercialRatioResult<"contract-roas.v1", "zero_cost">;
  cashMultiple: GrowthCommercialRatioResult<"cash-multiple.v1", "zero_cost">;
  collectionRate: GrowthCommercialRatioResult<"collection-rate.v1", "zero_contract_amount">;
}
export interface RoiSnapshot {
  closureVersionId: string; sliceKey: "all" | `plan:${string}`; planId: string | null;
  memberCount: number; memberSetHash: string; computedMetrics: ClosedActualRoiResult;
  commercialRatios: ClosedCommercialRatioSnapshot;
  commercialAuthoritySetHash: `sha256:${string}`;
  coverage: RoiCoverageSnapshot; calculationHash: string;
}
export interface RoiSnapshotSliceMember {
  closureVersionId: string; sliceKey: "all" | `plan:${string}`;
  cohortMemberId: string; ownershipVersionId: string;
}
export interface RoiCommercialAuthorityEntry {
  closureVersionId: string; sliceKey: "all" | `plan:${string}`;
  candidateId: string; customerId: string; dealId: string; quoteVersionId: string;
  dealAuthorityRevision: number; contractWonFactId: string; amountMinor: number; currency: string;
  commercialAmountHash: `sha256:${string}`; commercialBindingHash: `sha256:${string}`;
  evidenceHash: `sha256:${string}`;
}
export interface RoiClosureOperation {
  id: string; workspaceId: string; cohortId: string; currency: string;
  inputHash: string; inputSnapshot: { cohortId: string; currency: string; effectiveAsOf: string; attestationIds: string[]; expectedSeriesRevision: number };
  sealedCutoffAudit: { initialTemporalSequence: number };
  expectedSeriesRevision: number; requestedBy: string;
  domainCommandHash: `sha256:${string}`; requestHash: `sha256:${string}`; idempotencyKeyHash: `sha256:${string}`;
  status: "queued" | "running" | "succeeded" | "failed";
  leaseOwner: string | null; leaseExpiresAt: string | null; fencingToken: number;
  closureVersionId: string | null; errorCode: RoiGapCode | "revision_mismatch" | "stale_fencing_token" | null;
  createdAt: string; updatedAt: string;
}
export interface RoiClosureRecoveryAuthorizer {
  authorize(operation: RoiClosureOperation): Promise<CommandContext>;
}
interface PersistedRoiClosureSeriesEvent {
  id: string; closureSeriesId: string; revision: number; eventType: "closed" | "reopened";
  closureVersionId: string; actorId: string; recordedAt: string; temporalSequence: number;
  domainCommandHash: `sha256:${string}` | null; requestHash: `sha256:${string}` | null;
}
export interface RoiSnapshotEntry {
  closureVersionId: string;
  sourceType: "cohort_member" | "attestation" | "cost" | "financial" | "verification" | "allocation_set" | "settlement_set";
  sourceId: string; effectiveAmountMinor: number | null; sourceHash: string;
}
export interface RoiClosureService {
  createAttestationAt(context: CommandContext, input: { cohortId: string; currency: string; aspect: ClosureAspect; periodFrom: string; periodTo: string; declaredTotalMinor: number | null; sourceSystem: string; sourceCursor: string | null; sourceReportId: string | null; reportAllocationSetId: string | null; reportHash: string; evidenceRefs: ClosureEvidenceRef[] }, cutoff: GrowthSealedReadCutoff): Promise<ClosureAttestation>;
  closeAt(context: CommandContext, input: { cohortId: string; currency: string; attestationIds: string[] }, cutoff: GrowthSealedReadCutoff): Promise<RoiClosureVersion>;
  reopen(context: CommandContext, closureVersionId: string): Promise<RoiClosureSeries>;
  getVersion(workspace: ActiveWorkspaceContext, closureVersionId: string): Promise<{ closure: RoiClosureVersion; snapshots: RoiSnapshot[]; sliceMembers: RoiSnapshotSliceMember[]; commercialAuthorities: RoiCommercialAuthorityEntry[]; entries: RoiSnapshotEntry[] } | null>;
}
export interface RoiClosureCoordinator {
  resume(operation: RoiClosureOperation): Promise<RoiClosureVersion>;
}
```

- [ ] **Step 1: Write failing closure immutability test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { RoiClosureService } from "./acquisition-roi-closure.js";
import { completeAdjacentCohortClosureFixture, completeClosureFixture, completeTwoCurrencyClosureFixture } from "./growth-roi-test-fixtures.js";

test("late facts require reopen and never mutate the first snapshot", async () => {
  const fixture = await completeClosureFixture({ currency: "CNY", costMinor: 200, revenueMinor: 1000, cogsMinor: 200, paymentMinor: 1000 });
  const service = new RoiClosureService(fixture.dependencies);
  const first = await fixture.close(service, { ...fixture.context("close-1"), expectedRevision: 1 }, { cohortId: fixture.cohortId, currency: "CNY", asOf: "2026-08-09T00:00:00.000Z", attestationIds: fixture.attestationIds });
  const before = await service.getVersion(fixture.workspace, first.id);
  await fixture.insertLateVerifiedRefund(100, "2026-08-09T01:00:00.000Z");
  await assert.rejects(() => fixture.close(service, { ...fixture.context("close-without-reopen"), expectedRevision: 2 }, { cohortId: fixture.cohortId, currency: "CNY", asOf: "2026-08-09T02:00:00.000Z", attestationIds: fixture.attestationIds }), /closure_series_closed/);
  await service.reopen({ ...fixture.context("reopen-1"), expectedRevision: 2 }, first.id);
  const after = await service.getVersion(fixture.workspace, first.id);
  assert.deepEqual(after?.snapshots, before?.snapshots);
  assert.deepEqual(after?.sliceMembers, before?.sliceMembers);
  assert.deepEqual(after?.commercialAuthorities, before?.commercialAuthorities);
  assert.deepEqual(after?.entries, before?.entries);
  assert.equal(before?.closure.status, "closed");
  assert.equal(after?.closure.status, "superseded");
});

test("CNY reopen does not change USD series", async () => {
  const fixture = await completeTwoCurrencyClosureFixture();
  const service = new RoiClosureService(fixture.dependencies);
  const cny = await service.reopen({ ...fixture.context("reopen-cny"), expectedRevision: fixture.cnyRevision }, fixture.cnyClosureId);
  const usd = await fixture.repository.getSeries("workspace-a", fixture.cohortId, "USD");
  assert.equal(cny.status, "open");
  assert.equal(usd?.status, "closed");
});

test("closure materializes immutable aggregate and per-plan actual ROI slices", async () => {
  const fixture = await completeClosureFixture({
    currency: "CNY",
    members: [
      { id: "member-a", firstPlanId: "plan-a", revenueMinor: 600, cogsMinor: 200, acquisitionCostMinor: 100 },
      { id: "member-b", firstPlanId: "plan-b", revenueMinor: 400, cogsMinor: 100, acquisitionCostMinor: 100 }
    ]
  });
  const service = new RoiClosureService(fixture.dependencies);
  const closure = await fixture.close(service, { ...fixture.context("close-slices"), expectedRevision: 1 }, fixture.closeInput);
  const frozen = await service.getVersion(fixture.workspace, closure.id);
  assert.deepEqual(frozen?.snapshots.map((snapshot) => snapshot.sliceKey), ["all", "plan:plan-a", "plan:plan-b"]);
  assert.equal(frozen?.snapshots.find((snapshot) => snapshot.sliceKey === "plan:plan-a")?.computedMetrics.status, "computed");
  assert.notEqual(
    frozen?.snapshots.find((snapshot) => snapshot.sliceKey === "all")?.calculationHash,
    frozen?.snapshots.find((snapshot) => snapshot.sliceKey === "plan:plan-a")?.calculationHash
  );
});

test("unallocated cohort-level shared cost does not block aggregate close but marks plan slices incomplete", async () => {
  const fixture = await completeClosureFixture({ sharedCohortCostMinor: 100, explicitPlanCostAllocations: [] });
  const service = new RoiClosureService(fixture.dependencies);
  const closure = await fixture.close(service, { ...fixture.context("close-shared-cost"), expectedRevision: 1 }, fixture.closeInput);
  const frozen = await service.getVersion(fixture.workspace, closure.id);
  assert.equal(frozen?.snapshots.find((snapshot) => snapshot.sliceKey === "all")?.computedMetrics.status, "computed");
  assert.deepEqual(
    frozen?.snapshots.filter((snapshot) => snapshot.planId !== null).map((snapshot) => snapshot.computedMetrics),
    [{ status: "not_computable", reason: "attribution_incomplete", formulaVersion: "verified-gross-profit-roi.v1" }]
  );
});

test("first catch-up after sealing still belongs to that source-authority cutoff", async () => {
  const fixture = await completeClosureFixture({ deferCohortProjection: true });
  const service = new RoiClosureService(fixture.dependencies);
  const closure = await fixture.close(service, { ...fixture.context("close-first-catchup"), expectedRevision: 1 }, fixture.closeInput);
  const frozen = await service.getVersion(fixture.workspace, closure.id);
  assert.equal(frozen?.snapshots.find((snapshot) => snapshot.sliceKey === "all")?.memberCount, fixture.authoritativeDiscoveryCount);
  assert.equal(fixture.sealReadCutoffCalls, 1);
  assert.equal(fixture.lastProjectedMember?.projectionRecordedAt > fixture.closeInput.asOf, true);
  assert.equal(fixture.lastProjectedMember?.sourceRecordedAt <= fixture.closeInput.asOf, true);
});

test("late earlier cross-cohort ownership never rewrites an already closed snapshot", async () => {
  const fixture = await completeAdjacentCohortClosureFixture({
    initial: { eventId: "event-late-window", discoveredAt: "2026-08-09T00:00:00.000Z", sourceRecordedAt: "2026-08-09T01:00:00.000Z", cohortId: "cohort-late" },
    lateEarlier: { eventId: "event-early-window", discoveredAt: "2026-08-07T00:00:00.000Z", sourceRecordedAt: "2026-08-10T01:00:00.000Z", cohortId: "cohort-early" }
  });
  const service = new RoiClosureService(fixture.dependencies);
  const oldCutoff = await fixture.seal("2026-08-09T23:59:59.999Z");
  await fixture.catchUp("cohort-late", oldCutoff);
  const closed = await fixture.closeAt(service, "cohort-late", oldCutoff, { expectedRevision: 1 });
  const frozenBefore = await service.getVersion(fixture.workspace, closed.id);

  await fixture.appendLateEarlierDiscovery();
  const newCutoff = await fixture.seal("2026-08-10T23:59:59.999Z");
  await fixture.catchUp("cohort-early", newCutoff);
  const frozenAfter = await service.getVersion(fixture.workspace, closed.id);

  assert.deepEqual(frozenAfter, frozenBefore);
  assert.deepEqual((await fixture.listMembersAt("cohort-late", oldCutoff)).map((row) => row.firstEventId), ["event-late-window"]);
  assert.equal((await fixture.listMembersAt("cohort-late", newCutoff)).length, 0);
  assert.deepEqual((await fixture.listMembersAt("cohort-early", newCutoff)).map((row) => row.firstEventId), ["event-early-window"]);
  assert.deepEqual(await fixture.readExactClosedSnapshot(closed.id, newCutoff), frozenBefore?.snapshots);
});

test("closure freezes three commercial ratios and their verified numerators", async () => {
  const fixture = await completeClosureFixture({ costMinor: 200, contractWonMinor: 1000, paymentMinor: 900, refundMinor: 100 });
  const service = new RoiClosureService(fixture.dependencies);
  const closure = await fixture.close(service, { ...fixture.context("close-ratios"), expectedRevision: 1 }, fixture.closeInput);
  const snapshot = (await service.getVersion(fixture.workspace, closure.id))?.snapshots.find((row) => row.sliceKey === "all");
  assert.deepEqual(snapshot?.commercialRatios, {
    verifiedContractWonMinor: 1000, allocatedPaymentMinor: 900, netCashMinor: 800, verifiedAcquisitionCostMinor: 200,
    contractRoas: { status: "computed", bps: 50_000, formulaVersion: "contract-roas.v1" },
    cashMultiple: { status: "computed", bps: 45_000, formulaVersion: "cash-multiple.v1" },
    collectionRate: { status: "computed", bps: 9_000, formulaVersion: "collection-rate.v1" }
  });
});

test("a later CRM rebinding cannot move a won quote into another cohort or plan slice", async () => {
  const fixture = await completeClosureFixture({
    wonBinding: { candidateId: "candidate-a", customerId: "customer-a", dealId: "deal-a", bindingHash: `sha256:${"a".repeat(64)}` },
    members: [{ id: "member-a", primaryCandidateId: "candidate-a", firstPlanId: "plan-a" }]
  });
  await fixture.rebindCurrentCrmChain({ candidateId: "candidate-b", customerId: "customer-b", dealId: "deal-a", bindingHash: `sha256:${"b".repeat(64)}` });
  const service = new RoiClosureService(fixture.dependencies);
  const closure = await fixture.close(service, { ...fixture.context("close-after-rebind"), expectedRevision: 1 }, fixture.closeInput);
  const frozen = await service.getVersion(fixture.workspace, closure.id);
  assert.deepEqual(frozen?.commercialAuthorities.map((row) => [row.candidateId, row.customerId, row.commercialBindingHash]), [
    ["candidate-a", "customer-a", `sha256:${"a".repeat(64)}`]
  ]);
  assert.deepEqual(frozen?.snapshots.map((row) => row.sliceKey), ["all", "plan:plan-a"]);
});

test("future or inverted attestation periods fail before idempotency or domain writes", async () => {
  const fixture = await completeClosureFixture({ serverNow: "2026-08-09T00:00:00.000Z" });
  const service = new RoiClosureService(fixture.dependencies);
  await assert.rejects(() => fixture.createAttestation(service, fixture.context("future-attestation"), {
    ...fixture.attestationInput, periodFrom: "2026-08-01T00:00:00.000Z",
    periodTo: "2026-08-09T00:00:01.001Z", asOf: "2026-08-09T00:00:01.001Z"
  }), /invalid_as_of/);
  assert.equal(fixture.idempotencyWrites + fixture.businessWrites, 0);
});

test("attestation, close, and reopen recover domain IDs after Foundation completion loss", async () => {
  const fixture = await completeClosureFixture({ failFoundationCompletionOncePerMutation: true });
  const service = new RoiClosureService(fixture.dependencies);
  await assert.rejects(() => fixture.createAttestation(service, fixture.context("attestation-loss"), fixture.attestationInput), /injected_completion_loss/);
  await fixture.expireFoundationLease();
  const attestation = await fixture.createAttestation(service, fixture.context("attestation-loss"), fixture.attestationInput);
  await assert.rejects(() => fixture.close(service, { ...fixture.context("close-loss"), expectedRevision: 1 }, { ...fixture.closeInput, attestationIds: [attestation.id] }), /injected_completion_loss/);
  await fixture.expireFoundationLease();
  const closure = await fixture.close(service, { ...fixture.context("close-loss"), expectedRevision: 1 }, { ...fixture.closeInput, attestationIds: [attestation.id] });
  await assert.rejects(() => service.reopen({ ...fixture.context("reopen-loss"), expectedRevision: 2 }, closure.id), /injected_completion_loss/);
  await fixture.expireFoundationLease();
  await service.reopen({ ...fixture.context("reopen-loss"), expectedRevision: 2 }, closure.id);
  assert.deepEqual(await fixture.domainCommandRowCounts(), { attestations: 1, closeOperations: 1, closureVersions: 1, reopenEvents: 1 });
});

test("closure mutation replay uses current authority and binds one key to one path resource", async () => {
  const fixture = await completeTwoCurrencyClosureFixture();
  const service = new RoiClosureService(fixture.dependencies);
  await service.reopen({ ...fixture.context("shared-reopen-key"), expectedRevision: fixture.cnyRevision }, fixture.cnyClosureId);
  await fixture.revoke("roi.close");
  await assert.rejects(() => service.reopen({ ...fixture.context("shared-reopen-key"), expectedRevision: fixture.cnyRevision }, fixture.cnyClosureId), /capability_forbidden/);
  await fixture.restore("roi.close");
  await assert.rejects(() => service.reopen({ ...fixture.context("shared-reopen-key"), expectedRevision: fixture.usdRevision }, fixture.usdClosureId), /idempotency_conflict/);
  assert.equal(await fixture.reopenEventCount(fixture.usdClosureId), 0);
});
```

The closure fixture injects the exact Finance reader. Add one consumer-boundary test that requests one attested cost ID plus revenue/cogs/refund/bad-debt fact IDs and asserts that any requested ID absent from the Finance as-of result becomes the matching closure gap; closure code cannot fall back to a repository or current status column. The Finance plan's memory/MySQL tests remain the sole owner of late-verification and late-reversal history semantics.

- [ ] **Step 2: Run closure tests to verify RED**

Run: `cd backend && NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/financial-ledger-as-of-reader-test.ts src/acquisition-roi-closure-test.ts`

Expected: FAIL because closure modules are absent.

- [ ] **Step 3: Implement signed completeness gates and immutable snapshot assembly**

Require signed attestations for `acquisition_cost`, `revenue`, `cogs`, `cash`, `refund_bad_debt`, and `attribution`. The HTTP command boundary captures server `commandStartedAt`, normalizes with the Foundation future-bound helper, seals that effective cutoff exactly once, removes raw `asOf`, and delegates to token-only `createAttestationAt` or `closeAt`. The service and nested readers cannot accept a naked time or reseal. Test fixtures use the same boundary helper rather than calling `*At` with a fabricated token. Validate `periodFrom < periodTo <= cutoff.effectiveAsOf <= signedAt`, currency/cohort, report hash, the report allocation selected by immutable lifecycle events at the cutoff, declared totals, membership snapshot, verified net cost/facts, binding hash, the attribution set selected by lifecycle at the cutoff, and per-revenue cash reconciliation. A client cannot pre-sign a future period: future `periodTo`, `asOf`, or `signedAt` injection returns `422 invalid_as_of` and writes no idempotency/domain row. Every attestation append transaction takes the temporal barrier first and freezes its global stamp. The public `ClosureAttestation` projector omits the internal append sequence and all command identity. `RoiClosureService` must not import stage-3 repositories or current ledger projections: after collecting exact referenced cost/fact IDs from frozen attestations and allocation graphs, `freezeCompleteEvidence` calls only the injected `VerifiedFinancialLedgerSealedReader.listVerifiedCostsAt(cutoff,input)` / `.listVerifiedFactsAt(cutoff,input)` and treats a missing requested ID as the matching closure gap.

All three public mutation entries use the one Task-2 executor exactly once. `createAttestationAt` owns the frozen template `/api/v1/acquisition/cohorts/:id/attestations` and delegates to private `createAttestationClaimed`; `closeAt` owns `/api/v1/acquisition/cohorts/:id/close` and delegates to private `closeClaimed`; `reopen` owns `/api/v1/acquisition/roi-closures/:closureVersionId/reopen` and delegates to private `reopenClaimed`. Their first service line requires current `roi.close`; their replay projector repeats current authority and validates the exact workspace/cohort/resource IDs returned by Foundation. Attestation rows, close operations, and reopened series events each carry their stable domain command hash/request identity under a unique workspace command probe. A claimed core first performs the indexed non-locking exact probe; a hit is read-only and returns the same IDs, while a miss enters the temporal-barrier-first append/operation transaction. The long close coordinator and recovery path never invoke the public wrapper or reserve Foundation idempotency again.

Close coordination uses three phases. The initial request boundary authorizes the current command, seals once, and invokes `closeAt` with that exact token. The public wrapper claims Foundation once; private `closeClaimed` creates/probes and claims the durable operation without resealing. A recovered operation instead calls `RoiClosureRecoveryAuthorizer` to resolve persisted `workspaceId/requestedBy` into a current server-owned concrete `CommandContext`, requires current `roi.close`, validates the persisted effective cutoff, seals that cutoff exactly once for that recovery attempt, and invokes the same private token-only execution core without Foundation reservation. The currently authorized `CommandContext`—from the initial request or recovery authorizer—is passed unchanged to the closure-internal `CohortClosureCatchUpPort.ensureForClosure(context,{closureOperationId,cohortId,cutoff})`. That narrow port binds cache repair to the existing close operation/fence and may call only the cohort coordinator's private claimed projection core; no public cohort catch-up entry exists, and it cannot create another HTTP command or synthesize capabilities. Publication receives only frozen audit identity `{actorId: context.actorId, requestedBy: operation.requestedBy, requestHash: operation.requestHash, domainCommandHash: operation.domainCommandHash}` rather than a `CommandContext`. Revocation in recovery is checked before this catch-up port, so denial performs zero authoritative-source reads, ownership/source/cache/checkpoint writes, or publication writes.

The short operation claim freezes `CommandContext.expectedRevision`, effective cutoff and initial seal sequence as audit metadata and obtains an internal lease/fence; catch-up, evidence reads and calculation run outside the publication transaction with heartbeat and pass the same token to every reader; a short publication transaction takes the temporal barrier first, revalidates the unexpired operation fence, series revision, discovery watermark and every frozen source version, allocates the append stamp, and writes closure state atomically. Recovery may have a greater seal audit sequence, but `inputHash`, operation identity, calculation/evidence hashes and DTOs use only effective cutoff plus frozen source identities and therefore remain byte-identical. It writes one aggregate `sliceKey="all"` snapshot, one immutable `sliceKey="plan:<firstPlanId>"` snapshot for every frozen plan represented by the members, and one entry per member/attestation/cost/fact/verification/allocation/settlement. Each slice calculation uses only the already-frozen member/source/fact/allocation/settlement graph and stores its own sorted membership, computed actual ROI, three commercial ratios, coverage, and calculation hash. For each slice, commercial authority is a code-point-sorted unique set of `{candidateId,customerId,dealId,quoteVersionId,dealAuthorityRevision,contractWonFactId,amountMinor,currency,commercialAmountHash,commercialBindingHash,evidenceHash}` copied from the verified FinancialFact and the won/lost event's immutable QuoteVersion `commercialBindingEvidence`. Every included Deal has exactly one verified `contract_won` fact whose amount/currency/hash and complete frozen binding exactly match that formal Quote authority; duplicate, missing, cross-currency, or current-binding-substitution entries fail closed. BigInt sums this full set (the aggregate may contain many Deals), while each plan slice selects Deals by the frozen `candidateId` membership and never by a mutable current CRM/Handoff binding. A post-win Deal/customer/candidate reassignment therefore cannot move historical revenue into another cohort or plan and cannot invalidate a correctly frozen historical fact. The ratios then freeze that verified contract-won total, allocated payment, net cash, acquisition cost, exact fact/source/binding hashes, and formula versions. A plan slice includes costs explicitly allocated to that `planId` plus candidate/run targets that resolve uniquely to its frozen members. A cohort-level allocation with no plan/candidate/run target is valid for the aggregate but is never spread silently across plans; affected plan slices freeze `not_computable: attribution_incomplete`. Only the aggregate slice is a close gate. Current source heads are used only as current command authorization/concurrency guards and never choose historical evidence. A later Growth Performance query reads the exact stored slice and never recalculates actual ROI or any commercial ratio.

Private `reopenClaimed` obtains its sole revision from the public wrapper's `requireExpectedRevision(context)`, probes the immutable reopen event by domain command hash, then on a miss allocates the temporal barrier before locking only the selected currency series. It increments revision and appends one immutable `reopened` series event referencing the old ClosureVersion and carrying the command identity. It never updates the version row or its snapshot/entries. Public/current and historical `status` are projections: reduce series events through the caller's sealed cutoff, returning `closed` before that reopen event is visible and `superseded` only at/after its `recordedAt`.

The minimum GREEN publication calls the actual calculator only after the frozen evidence hashes exist and writes the closed graph atomically:

```ts
async closeFromRequest(context: CommandContext, input: CloseRoiClosureInput): Promise<RoiClosureVersion> {
  requireGrowthCapabilities(context.workspace, ["roi.close"]);
  const commandStartedAt = this.clock.now();
  const effectiveAsOf = assertGrowthAsOfNotFuture(input.asOf, commandStartedAt);
  const cutoff = await this.temporalBarrier.sealReadCutoff(context.workspace, effectiveAsOf);
  const { asOf: _requestedAsOf, ...businessInput } = input;
  return this.closureService.closeAt(context, businessInput, cutoff);
}

async closeAt(context: CommandContext, input: Omit<CloseRoiClosureInput,"asOf">, cutoff: GrowthSealedReadCutoff): Promise<RoiClosureVersion> {
  requireGrowthCapabilities(context.workspace, ["roi.close"]);
  const expectedSeriesRevision = requireExpectedRevision(context);
  return this.commandExecutor.execute(context, {
    method: "POST",
    canonicalPath: "/api/v1/acquisition/cohorts/:id/close",
    resourceKind: "closure"
  }, {
    authorizeAndProject: (ids) => this.authorizeAndProjectClose(context, input.cohortId, ids),
    executeClaimed: (domainCommandHash) => this.closeClaimed(context, input, cutoff, expectedSeriesRevision, domainCommandHash)
  });
}

private async closeClaimed(context: CommandContext, input: Omit<CloseRoiClosureInput,"asOf">, cutoff: GrowthSealedReadCutoff, expectedSeriesRevision: number, domainCommandHash: `sha256:${string}`): Promise<RoiCommandExecutionIds> {
  const normalizedInput = { ...input, asOf: cutoff.effectiveAsOf };
  const operation = await this.operations.createOrReplay(context, normalizedInput, expectedSeriesRevision, domainCommandHash, {
    initialTemporalSequence: cutoff.temporalSequence
  }); // audit-only; inputHash excludes the sequence
  if (operation.status === "succeeded" && operation.closureVersionId !== null) {
    return { resourceId: operation.closureVersionId, operationId: operation.id };
  }
  const lease = await this.operations.claim(operation.id, crypto.randomUUID(), this.now(), 30_000);
  if (lease === null) throw new RoiClosureError("closure_in_progress", 409);
  const heartbeat = this.heartbeats.start(() => this.operations.renew(lease, this.now(), 30_000), 5_000);
  try {
    const caughtUp = await this.cohortClosureCatchUp.ensureForClosure(context, {
      closureOperationId: operation.id,
      cohortId: normalizedInput.cohortId,
      cutoff
    });
    const frozen = await this.freezeCompleteEvidence(context.workspace, normalizedInput, cutoff, caughtUp.sourceWatermark);
    const closureEvidence: ClosureCalculationEvidence = {
      membershipSnapshotHash: frozen.membershipSnapshotHash,
      attestationSetHash: frozen.attestationSetHash,
      factSetHash: frozen.factSetHash,
      costSetHash: frozen.costSetHash,
      allocationSetHash: frozen.allocationSetHash,
      settlementSetHash: frozen.settlementSetHash
    };
    const sliceInputs = this.buildFrozenSliceInputs(frozen);
    const computedSlices = sliceInputs.map((slice) => {
      const computedMetrics = calculateActualRoiForClosure({ ...slice.actualInputs, closureEvidence });
      const commercialAuthoritySetHash = hashCanonicalJson(
        [...slice.commercialAuthorities].sort((a, b) => {
          const left = `${a.dealId}\u0000${a.quoteVersionId}\u0000${a.dealAuthorityRevision}`;
          const right = `${b.dealId}\u0000${b.quoteVersionId}\u0000${b.dealAuthorityRevision}`;
          return left < right ? -1 : left > right ? 1 : 0;
        })
      );
      const commercialRatios: ClosedCommercialRatioSnapshot = {
        verifiedContractWonMinor: slice.commercialInputs.verifiedContractWonMinor,
        allocatedPaymentMinor: slice.commercialInputs.allocatedPaymentMinor,
        netCashMinor: slice.commercialInputs.netCashMinor,
        verifiedAcquisitionCostMinor: slice.commercialInputs.verifiedAcquisitionCostMinor,
        contractRoas: calculateContractRoas(slice.commercialInputs),
        cashMultiple: calculateCashMultiple(slice.commercialInputs),
        collectionRate: calculateCollectionRate(slice.commercialInputs)
      };
      if (slice.planId === null && computedMetrics.status !== "computed") throw new RoiClosureError(computedMetrics.reason, 422);
      const coverage: RoiCoverageSnapshot = { ...slice.coverage, gapCodes: computedMetrics.status === "computed" ? [] : [computedMetrics.reason] };
      return { ...slice, computedMetrics, commercialRatios, commercialAuthoritySetHash, coverage };
    });
    return await this.repository.transaction(async (tx) => {
      const publicationStamp = await this.temporalBarrier.allocateAppend(tx, context.workspace.workspaceId);
      await tx.assertCurrentOperationFence(operation.id, lease.leaseOwner, lease.fencingToken, this.now());
      const series = await tx.lockSeries(context.workspace.workspaceId, normalizedInput.cohortId, normalizedInput.currency);
      if (series.status !== "open") throw new RoiClosureError("closure_series_closed", 409);
      if (series.revision !== expectedSeriesRevision) throw new RoiClosureError("revision_mismatch", 412);
      await tx.revalidateDiscoveryWatermark(context.workspace, cutoff, caughtUp.sourceWatermark);
      await tx.revalidateFrozenEvidence(context.workspace, cutoff, frozen.sourceVersions, closureEvidence);
      const publicationAudit = { actorId: context.actorId, requestedBy: operation.requestedBy, requestHash: operation.requestHash, domainCommandHash: operation.domainCommandHash };
      const closure = await tx.appendClosureVersion({ series, input: normalizedInput, cutoff, publicationStamp, publicationAudit, closureEvidence, formulaVersion: "verified-gross-profit-roi.v1" });
      await tx.compareAndSwapClosedSeries(series.id, expectedSeriesRevision, closure.id);
      const snapshots = computedSlices.map((slice) => ({
        closureVersionId: closure.id,
        sliceKey: slice.planId === null ? "all" as const : `plan:${slice.planId}` as const,
        planId: slice.planId,
        memberCount: slice.memberRefs.length,
        memberSetHash: hashCanonicalJson([...slice.memberRefs].sort((a, b) => {
          const left = `${a.cohortMemberId}\u0000${a.ownershipVersionId}`;
          const right = `${b.cohortMemberId}\u0000${b.ownershipVersionId}`;
          return left < right ? -1 : left > right ? 1 : 0;
        })),
        computedMetrics: slice.computedMetrics,
        commercialRatios: slice.commercialRatios,
        commercialAuthoritySetHash: slice.commercialAuthoritySetHash,
        coverage: slice.coverage,
        calculationHash: hashCanonicalJson({ closureVersionId: closure.id, planId: slice.planId, memberSetHash: hashCanonicalJson([...slice.memberRefs].sort((a, b) => { const left = `${a.cohortMemberId}\u0000${a.ownershipVersionId}`; const right = `${b.cohortMemberId}\u0000${b.ownershipVersionId}`; return left < right ? -1 : left > right ? 1 : 0; })), computedMetrics: slice.computedMetrics, commercialRatios: slice.commercialRatios, commercialAuthoritySetHash: slice.commercialAuthoritySetHash, coverage: slice.coverage, evidenceHashes: closureEvidence, effectiveAsOf: cutoff.effectiveAsOf })
      }));
      const sliceMembers = computedSlices.flatMap((slice) => [...slice.memberRefs]
        .sort((a, b) => { const left = `${a.cohortMemberId}\u0000${a.ownershipVersionId}`; const right = `${b.cohortMemberId}\u0000${b.ownershipVersionId}`; return left < right ? -1 : left > right ? 1 : 0; })
        .map(({ cohortMemberId, ownershipVersionId }) => ({ closureVersionId: closure.id, sliceKey: slice.planId === null ? "all" as const : `plan:${slice.planId}` as const, cohortMemberId, ownershipVersionId })));
      await tx.appendSnapshots(snapshots, sliceMembers, frozen.entries);
      await tx.appendSeriesEvent(series.id, series.revision + 1, "closed", closure.id, publicationAudit, publicationStamp);
      await tx.completeOperation(operation.id, lease.leaseOwner, lease.fencingToken, closure.id, publicationStamp);
      return { resourceId: closure.id, operationId: operation.id };
    });
  } finally {
    await heartbeat.stop();
  }
}
```

`createOrReplay` canonicalizes `attestationIds` in code-point order and defines `inputHash = hashCanonicalJson({ cohortId, currency, effectiveAsOf, attestationIds, expectedSeriesRevision })`; `expectedSeriesRevision` comes only from `CommandContext`, while the first sealed temporal sequence is audit metadata rather than a replay discriminator. Thus a newly keyed close after reopen cannot match/replay an operation created against the old series revision, and recovery may reseal the identical effective cutoff without changing business identity. The operation freezes actor, request hash and idempotency identity; the public body can never supply revision, lease owner, lease expiry, fence, or cutoff token. Long reads and cohort catch-up happen outside the publication transaction under a renewable operation lease. `freezeCompleteEvidence` calls the token-only ownership reader after catch-up, filters ownership candidates only by authoritative `sourceRecordedAt<=cutoff.effectiveAsOf`, selects the minimum discovery tuple per subject, and freezes those exact candidate/version IDs; it never reads the membership head or filters on a later cache `projectionRecordedAt`. Its closed return type contains the immutable members with `firstPlanId`, authoritative discovery watermark, Finance-owned `VerifiedLedgerRow` values, exact contract-won Deal/QuoteVersion authority, allocation/settlement item rows, exact source versions, four numeric BPS coverage fields, six SHA-256 hashes, and `RoiSnapshotEntry[]`; it throws one enumerated `RoiGapCode` for every incomplete gate. The short publication transaction takes the temporal barrier first, then locks/asserts the operation is `running` with the exact owner/token and `leaseExpiresAt > now`, locks/CAS-updates the series by `status='open' AND revision=expectedSeriesRevision`, and rechecks the discovery watermark and every frozen source version before writing. There is no lease or fencing token on `RoiClosureSeries`; only the operation carries the long-running lease/fence. `buildFrozenSliceInputs` emits the aggregate slice first and then plan slices in code-point `firstPlanId` order, proving that every amount belongs to exactly one frozen `{cohortMemberId,ownershipVersionId}` pair before summation. Member-set hashes include both IDs, and slice membership streams both into `RoiSnapshotSliceMember` rows; no unbounded member-ID array is stored in one JSON cell. Neither function accepts an arbitrary object or caller-provided actual metric. Once published, the closure's snapshot/slice-member/source-entry rows remain byte-identical even if a later source candidate changes which cohort wins at a newer cutoff; only a reopened, newly published closure may freeze the newer ownership set.

- [ ] **Step 4: Verify all not-computable gates and exact snapshot hashes**

Run: `cd backend && NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/financial-ledger-as-of-reader-test.ts src/acquisition-roi-closure-test.ts src/acquisition-roi-calculation-test.ts src/financial-settlement-allocation-test.ts src/acquisition-attribution-allocation-test.ts`

Expected: PASS for missing cost, unverified gross profit, incomplete cash, incomplete attribution, currency mismatch, zero cost, source-report overclaim, late fact, and independent currency series.

- [ ] **Step 5: Commit in-memory closure**

```bash
git add backend/src/acquisition-roi-closure.ts backend/src/acquisition-roi-closure-repository.ts backend/src/acquisition-roi-closure-test.ts backend/src/growth-roi-test-fixtures.ts
git commit -m "feat: close immutable acquisition roi snapshots"
```

### Task 11: Persist closure snapshots and prove concurrent close/reopen fencing

**Files:**
- Create: `backend/src/acquisition-roi-closure-mysql-repository.ts`
- Create: `backend/src/growth-roi-closure-mysql-test.ts`
- Create: `backend/src/acquisition-roi-closure-recovery-sweeper.ts`
- Create: `backend/src/growth-roi-closure-recovery-mysql-test.ts`
- Modify: `backend/src/acquisition-cohort-mysql-repository.ts`
- Modify: `backend/src/growth-finance-mysql-test-support.ts`
- Modify: `backend/src/growth-finance-mysql.ts`
- Modify: `backend/package.json`
- Test: `backend/src/growth-roi-closure-mysql-test.ts`
- Test: `backend/src/growth-roi-closure-recovery-mysql-test.ts`

**Interfaces:**
- Consumes: Task 10 repository, Finance-owned `MysqlVerifiedFinancialLedgerSealedReader`, and the shared MySQL harness.
- Produces: `ROI_CLOSURE_MYSQL_SCHEMA_STATEMENTS`, `ensureRoiClosureMysqlSchema(pool)`, `MysqlRoiClosureRepository`, and `RoiClosureRecoverySweeper.start/stop/sweepOnce`. Once the parent table exists, the schema initializer adds the deferred composite foreign key from `(workspace_id,parent_closure_operation_id)` on `acquisition_cohort_catch_up_operations` to the same fields on `roi_closure_operations`, while preserving the Task-3 authority-kind/nullability check and parent index.

- [ ] **Step 1: Write failing close/reopen race test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";

test("same revision permits one close or reopen winner", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const complete = await fixture.completeClosure("CNY");
    const service = fixture.closureService();
    const results = await Promise.allSettled([
      fixture.close(service, { ...fixture.context("close-a"), expectedRevision: 1 }, complete.command),
      fixture.close(service, { ...fixture.context("close-b"), expectedRevision: 1 }, complete.command)
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    const versions = await fixture.closureRepository.listVersions("workspace-a", complete.cohortId, "CNY");
    assert.equal(versions.length, 1);
  });
});

test("crash after evidence freeze is reclaimed and publishes exactly one closure", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const complete = await fixture.completeClosure("CNY");
    await fixture.crashClosureAfterFreeze({ ...fixture.context("close-crash"), expectedRevision: 1 }, complete.command);
    await fixture.advanceClockPastClosureLease();
    await fixture.roiClosureRecoverySweeper().sweepOnce();
    assert.equal((await fixture.closureRepository.listVersions("workspace-a", complete.cohortId, "CNY")).length, 1);
    assert.equal((await fixture.closureOperationRepository.listSucceeded("workspace-a", complete.cohortId, "CNY")).length, 1);
    assert.equal(await fixture.countDuplicateSnapshotRows(), 0);
  });
});

test("recovery re-authorizes the requesting actor before any closure publication", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const complete = await fixture.completeClosure("CNY");
    await fixture.queueClosureThenCrash({ ...fixture.context("close-revoked"), expectedRevision: 1 }, complete.command);
    await fixture.revokeCapability("close-revoked", "roi.close");
    await fixture.advanceClockPastClosureLease();
    await fixture.roiClosureRecoverySweeper().sweepOnce();
    assert.equal((await fixture.closureRepository.listVersions("workspace-a", complete.cohortId, "CNY")).length, 0);
    assert.equal((await fixture.closureOperationRepository.requireLatest()).errorCode, "capability_forbidden");
    assert.deepEqual(await fixture.recoveryWorkCounts(), {
      authoritativeSourceReads: 0, catchUpOperations: 0, ownershipCandidates: 0,
      memberSources: 0, checkpoints: 0, ledgerReads: 0, publicationWrites: 0
    });
  });
});

test("cohort recovery rejects a missing failed superseded or mismatched parent closure", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    for (const parentState of ["missing", "failed", "superseded", "identity_mismatch"] as const) {
      const operation = await fixture.expiredClosureCatchUp({
        parentState, parentClosureOperationId: `close-parent-${parentState}`
      });
      await fixture.acquisitionCohortRecoverySweeper().sweepOnce();
      assert.equal((await fixture.catchUpOperation(operation.id)).status, "failed");
      assert.deepEqual(await fixture.catchUpWorkCounts(operation.id), {
        authoritativeSourceReads: 0, ownershipCandidates: 0,
        memberSources: 0, checkpoints: 0, cacheWrites: 0
      });
    }
  });
});

test("reopen followed by the same business close input uses the new series revision", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const complete = await fixture.completeClosure("CNY");
    const service = fixture.closureService();
    const first = await fixture.close(service, { ...fixture.context("close-v1"), expectedRevision: 1 }, complete.command);
    await service.reopen({ ...fixture.context("reopen-v1"), expectedRevision: 2 }, first.id);
    const second = await fixture.close(service, { ...fixture.context("close-v2"), expectedRevision: 3 }, complete.command);
    assert.notEqual(second.id, first.id);
    assert.deepEqual((await fixture.closureOperationRepository.listSucceeded("workspace-a", complete.cohortId, "CNY")).map((row) => row.expectedSeriesRevision), [1, 3]);
  });
});
```

- [ ] **Step 2: Run MySQL closure test to verify RED**

Run: `cd backend && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-roi:mysql`

Expected: FAIL until MySQL closure tables and methods exist.

- [ ] **Step 3: Implement append-only closure tables and transactional publication**

Inject the Finance module's exact `MysqlVerifiedFinancialLedgerSealedReader` via `GrowthFinanceServices.verifiedAsOf`; do not recreate its SQL or historical-prefix projector. ROI MySQL tests assert that Closure passes the exact branded cutoff plus attested IDs/currency and fails with the matching gap when any requested ID is absent. The Finance MySQL suite remains the sole owner of late verification, reversal, and correction time-travel parity.

The parent key for catch-up recovery is executable MySQL DDL, not prose-only: `roi_closure_operations` owns `UNIQUE KEY uk_roi_closure_operation_workspace_id (workspace_id,id)`. After both tables and indexes exist, `ensureRoiClosureMysqlSchema` adds the deferred `(workspace_id,parent_closure_operation_id)` foreign key with one fixed constraint name; a second initializer call is an idempotent no-op, while a differently shaped existing constraint fails closed. The real-MySQL schema test runs init twice, inspects `information_schema`, rejects a cross-workspace parent, and accepts `performance_read` with a null parent.

Create `closure_attestations`, `roi_closure_operations`, `roi_closure_series`, `roi_closure_series_events`, `roi_closure_versions`, `roi_snapshots`, `roi_snapshot_slice_members`, `roi_snapshot_commercial_authorities`, and `roi_snapshot_entries`. Every workspace column in this Stage-4 schema is `VARCHAR(191)` and rejects blank/`all`. Every append row stores the global `recorded_at/temporal_sequence`; series events use the publication/reopen stamp and closure `closed_at` is exactly its publication stamp. Attestations store non-null `domain_command_hash/request_hash/requested_by`; close operations store non-null `domain_command_hash/request_hash/idempotency_key_hash/requested_by`; reopened series events store non-null `domain_command_hash/request_hash` while closed events reuse the close operation audit identity but do not serve as a second probe. Add unique workspace command probes for attestation, close operation, and non-null reopen-event command hashes. `roi_closure_operations` also persists canonical business input, effective cutoff, initial seal sequence as audit-only metadata, expected series revision, status, lease owner/expiry/fence and result/error. Its canonical `input_hash` includes sorted attestation IDs, effective cutoff and `expected_series_revision`, but never a seal sequence; unique `(workspace_id,requested_by,idempotency_key_hash)` scopes caller idempotency correctly, unique `(workspace_id,domain_command_hash)` recovers a committed close after Foundation completion loss, while `(workspace_id,cohort_id,currency,expected_series_revision,input_hash)` makes business replay deterministic without allowing a post-reopen request to replay the old successful close. `roi_snapshots` stores `slice_key` (`all` or `plan:<id>`), nullable `plan_id`, `member_count`, `member_set_hash`, computed actual metrics, frozen commercial ratios and numerators, coverage, and its calculation hash; require uniqueness `(closure_version_id,slice_key)` so nullable SQL semantics cannot create two aggregate rows. `roi_snapshot_slice_members` stores one row per frozen slice/logical-member with the exact selected `ownership_version_id`; member-set hashes canonicalize both IDs, and no unbounded ID array is packed into JSON. `roi_snapshot_commercial_authorities` stores the exact per-slice Deal/QuoteVersion/authority revision/contract-won fact plus candidate/customer and frozen amount/binding/evidence hashes; current CRM rows are never stored or re-read as authority. Required uniqueness elsewhere: series `(workspace_id,cohort_id,currency)`, version `(workspace_id,cohort_id,currency,version)`, series revision `(closure_series_id,revision)`, one verified `contract_won` contribution per exact `(deal_id,quote_version_id,deal_authority_revision)`, commercial authority `(closure_version_id,slice_key,deal_id,quote_version_id,deal_authority_revision)`, slice member `(closure_version_id,slice_key,cohort_member_id)` plus an immutable foreign-key/reference to its `ownership_version_id`, and snapshot entry `(closure_version_id,source_type,source_id)`. Closure versions, snapshots, memberships, commercial authorities, and entries have no update methods; `closed|superseded` is always reduced from immutable series events at the reader's cutoff rather than stored as a mutable historical truth.

Use one MySQL transaction for the whole publication: allocate the Foundation global append stamp first, then lock/assert the operation ownership row, then `SELECT ... FOR UPDATE` the series and CAS only its status/revision. Keep the barrier and asserted operation row locked through immutable version/snapshot inserts and require the same operation owner/token again when marking that operation succeeded; do not copy or compare the operation token on the series. Reopen follows the same barrier-first lock order and receives a strictly later `recordedAt`, so `closedAt<=cutoff` historical selection cannot be rewritten by a later backdated close/reopen even when the database clock rolls back. Avoid JSON arrays of source IDs; store each source as `roi_snapshot_entries`.

The long-running coordinator does not hold this transaction while catching up or reading ledgers. `roi_closure_operations` is claimed in a short CAS transaction, heartbeated every five seconds, and reclaimed only after expiry with a strictly larger fencing token. `RoiClosureRecoverySweeper` scans queued/expired-running operations in bounded batches, isolates failures, calls the same coordinator execution path, and `stop()` waits for active work. Immediately after claim and before invoking `CohortClosureCatchUpPort` or any source/cache/ledger read, it calls the injected `RoiClosureRecoveryAuthorizer`, which resolves the persisted actor/workspace from current Foundation authority and requires current `roi.close`; stored capabilities are never trusted. Revocation marks a fenced terminal `capability_forbidden` failure with zero authoritative-source reads, catch-up-operation/checkpoint/ownership/member-source/cache writes, ledger reads, or Closure writes, while a still-authorized crash recovers exactly one. Permanent enumerated data gaps mark the operation `failed`; process loss or provider/database availability errors leave it recoverable. Publication first takes the workspace temporal barrier, then locks the operation row and requires `status='running'`, exact `lease_owner`, exact `fencing_token`, and `lease_expires_at > now`; it then locks/CAS-updates the series by expected revision. Publication and operation completion occur in the same short transaction, preventing ACK loss from creating a second closure. The series has no lease or fencing fields—the operation is the only long-running ownership record.

Replace `backend/package.json`'s stage-4 MySQL command with this cumulative, explicitly named suite:

```json
{
  "scripts": {
    "test:growth-roi:mysql": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/growth-roi-discovery-projection-mysql-test.ts src/growth-roi-cohort-mysql-test.ts src/growth-roi-cohort-recovery-mysql-test.ts src/growth-roi-attribution-mysql-test.ts src/growth-roi-settlement-mysql-test.ts src/growth-roi-closure-mysql-test.ts src/growth-roi-closure-recovery-mysql-test.ts"
  }
}
```

The minimum GREEN schema and CAS publication are:

```sql
CREATE TABLE roi_closure_operations (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(191) NOT NULL,
  cohort_id VARCHAR(64) NOT NULL,
  currency CHAR(3) NOT NULL,
  idempotency_key_hash CHAR(71) NOT NULL,
  request_hash CHAR(71) NOT NULL,
  domain_command_hash CHAR(71) NOT NULL,
  input_hash CHAR(71) NOT NULL,
  input_json JSON NOT NULL,
  expected_series_revision BIGINT UNSIGNED NOT NULL,
  requested_by VARCHAR(191) NOT NULL,
  status ENUM('queued','running','succeeded','failed') NOT NULL,
  lease_owner VARCHAR(128) NULL,
  lease_expires_at DATETIME(3) NULL,
  fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
  closure_version_id VARCHAR(64) NULL,
  error_code VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_roi_closure_operation_workspace_id (workspace_id,id),
  UNIQUE KEY uk_roi_closure_operation_idem (workspace_id,requested_by,idempotency_key_hash),
  UNIQUE KEY uk_roi_closure_operation_command (workspace_id,domain_command_hash),
  UNIQUE KEY uk_roi_closure_operation_input (workspace_id,cohort_id,currency,expected_series_revision,input_hash),
  KEY idx_roi_closure_recovery (status,lease_expires_at,created_at,id)
) ENGINE=InnoDB;
CREATE TABLE roi_closure_series (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(191) NOT NULL,
  cohort_id VARCHAR(64) NOT NULL,
  currency CHAR(3) NOT NULL,
  status ENUM('open','closed') NOT NULL,
  current_closure_version_id VARCHAR(64) NULL,
  revision BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uk_roi_series (workspace_id,cohort_id,currency)
) ENGINE=InnoDB;
CREATE TABLE roi_snapshot_entries (
  closure_version_id VARCHAR(64) NOT NULL,
  source_type VARCHAR(32) NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  effective_amount_minor DECIMAL(20,0) NULL,
  source_hash CHAR(71) NOT NULL,
  PRIMARY KEY (closure_version_id,source_type,source_id)
) ENGINE=InnoDB;
CREATE TABLE roi_snapshots (
  closure_version_id VARCHAR(64) NOT NULL,
  slice_key VARCHAR(160) NOT NULL,
  plan_id VARCHAR(128) NULL,
  member_count BIGINT UNSIGNED NOT NULL,
  member_set_hash CHAR(71) NOT NULL,
  computed_metrics_json JSON NOT NULL,
  commercial_ratios_json JSON NOT NULL,
  commercial_authority_set_hash CHAR(71) NOT NULL,
  coverage_json JSON NOT NULL,
  calculation_hash CHAR(71) NOT NULL,
  PRIMARY KEY (closure_version_id,slice_key)
) ENGINE=InnoDB;
CREATE TABLE roi_snapshot_slice_members (
  closure_version_id VARCHAR(64) NOT NULL,
  slice_key VARCHAR(160) NOT NULL,
  cohort_member_id VARCHAR(64) NOT NULL,
  ownership_version_id VARCHAR(64) NOT NULL,
  PRIMARY KEY (closure_version_id,slice_key,cohort_member_id),
  KEY idx_roi_slice_member_lookup (closure_version_id,cohort_member_id,slice_key)
) ENGINE=InnoDB;
CREATE TABLE roi_snapshot_commercial_authorities (
  closure_version_id VARCHAR(64) NOT NULL,
  slice_key VARCHAR(160) NOT NULL,
  candidate_id VARCHAR(64) NOT NULL,
  customer_id VARCHAR(64) NOT NULL,
  deal_id VARCHAR(64) NOT NULL,
  quote_version_id VARCHAR(64) NOT NULL,
  deal_authority_revision BIGINT UNSIGNED NOT NULL,
  contract_won_fact_id VARCHAR(64) NOT NULL,
  amount_minor DECIMAL(20,0) NOT NULL,
  currency CHAR(3) NOT NULL,
  commercial_amount_hash CHAR(71) NOT NULL,
  commercial_binding_hash CHAR(71) NOT NULL,
  evidence_hash CHAR(71) NOT NULL,
  PRIMARY KEY (closure_version_id,slice_key,deal_id,quote_version_id,deal_authority_revision),
  KEY idx_roi_commercial_candidate (closure_version_id,slice_key,candidate_id,deal_id)
) ENGINE=InnoDB;
```

```ts
const [operationRows] = await connection.execute<RowDataPacket[]>(
  `SELECT id FROM roi_closure_operations
   WHERE id=? AND workspace_id=? AND status='running'
     AND lease_owner=? AND fencing_token=? AND lease_expires_at>? FOR UPDATE`,
  [operationId, workspaceId, leaseOwner, fencingToken, now]
);
if (operationRows.length !== 1) throw new RoiClosureError("stale_fencing_token", 409);
const [result] = await connection.execute<ResultSetHeader>(
  `UPDATE roi_closure_series SET status='closed', current_closure_version_id=?, revision=revision+1
   WHERE id=? AND workspace_id=? AND status='open' AND revision=?`,
  [closureVersionId, seriesId, workspaceId, expectedRevision]
);
if (result.affectedRows !== 1) throw new RoiClosureError("revision_mismatch", 412);
```

- [ ] **Step 4: Verify two-connection atomicity and old snapshot reproducibility**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-roi-closure-test.ts && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-roi:mysql`

Expected: PASS; one close wins, failed close leaves no version/snapshot entries, and superseded version hashes remain identical after reopen.

- [ ] **Step 5: Commit MySQL closure**

```bash
git add backend/src/acquisition-roi-closure-mysql-repository.ts backend/src/growth-roi-closure-mysql-test.ts backend/src/acquisition-roi-closure-recovery-sweeper.ts backend/src/growth-roi-closure-recovery-mysql-test.ts backend/src/acquisition-cohort-mysql-repository.ts backend/src/growth-finance-mysql-test-support.ts backend/src/growth-finance-mysql.ts backend/package.json
git commit -m "feat: persist immutable roi closures"
```

### Task 12: Build database-backed expected/actual Growth Performance selection

**Files:**
- Create: `backend/src/acquisition-growth-performance-query.ts`
- Create: `backend/src/acquisition-growth-performance-mysql-query.ts`
- Create: `backend/src/acquisition-growth-performance-query-test.ts`
- Create: `backend/src/growth-roi-performance-mysql-test.ts`
- Modify: `backend/src/growth-finance-mysql-test-support.ts`
- Modify: `backend/src/growth-roi-test-fixtures.ts`
- Modify: `backend/package.json`
- Test: `backend/src/acquisition-growth-performance-query-test.ts`
- Test: `backend/src/growth-roi-performance-mysql-test.ts`

**Interfaces:**
- Consumes: `AuthoritativeQuoteAsOfReader.listContributionsAsOf`, cohort membership plus the internal `CohortProjectionReadCatchUpPort`, cost-estimate and attribution lifecycle readers reconstructed at the already boundary-validated cutoff, and immutable closure snapshots. Growth Performance uses only the private read-repair port; no public cohort catch-up command exists, and it never fabricates a `CommandContext`/`roi.close` capability.
- Produces: token-only `AcquisitionGrowthPerformanceQueryService.getAt`, actor-scoped `ExpectedRoiSalesOwnReader`, `RoiClosureEvidenceSealedReader`, `GrowthPerformanceDto`, and `MysqlGrowthPerformanceDataSource`; the data source must expose frozen cohort members plus every source-authority `AcquisitionCohortMemberSource` for those member IDs.

```ts
export interface GrowthPerformanceQuery {
  cohortId: string; currency: string; asOf: string;
  planId: string | null; closureVersionId: string | null;
}

export type ExpectedRoiCurrencyView = {
  currency: string; status: "computed" | "not_computable";
  reason: "cost_missing" | "attribution_incomplete" | "zero_estimated_cost" | null;
  roiBps: number | null;
  formulaVersion: "expected-gross-profit-roi.v1";
  quoteVersionIds: string[]; probabilityAssessmentIds: string[];
  costEstimateIds: string[];
} & (
  | { amountVisibility: "full"; probabilityWeightedGrossProfitMinor: number | null; attributedEstimatedCostMinor: number | null }
  | { amountVisibility: "redacted" }
);
export type ActualRoiCurrencyView =
  | ({ currency: string; status: "computed"; basis: "verified_gross_profit"; roiBps: number; costCoverageBps: number; marginCoverageBps: number; cashCoverageBps: number; attributionCoverageBps: number; closureVersionId: string; closureAsOf: string; formulaVersion: "verified-gross-profit-roi.v1" } & (
      | { amountVisibility: "full"; verifiedGrossProfitMinor: number; verifiedAcquisitionCostMinor: number }
      | { amountVisibility: "redacted" }
    ))
  | { currency: string; status: "not_computable"; reason: RoiGapCode; closureVersionId: string | null; closureAsOf: string | null; formulaVersion: "verified-gross-profit-roi.v1" };
export type CashCurrencyView = {
  currency: string; status: "complete" | "incomplete" | "not_available";
  contractRoas: GrowthCommercialRatioResult<"contract-roas.v1", "zero_cost">;
  cashMultiple: GrowthCommercialRatioResult<"cash-multiple.v1", "zero_cost">;
  collectionRate: GrowthCommercialRatioResult<"collection-rate.v1", "zero_contract_amount">;
} & (
  | { amountVisibility: "full"; verifiedContractWonMinor: number; verifiedAcquisitionCostMinor: number; allocatedPaymentMinor: number; allocatedRefundMinor: number; allocatedBadDebtMinor: number; netCashMinor: number }
  | { amountVisibility: "redacted" }
);

export interface GrowthPerformanceDto {
  cohortId: string; currency: string; planId: string | null; dataAsOf: string;
  memberIds: string[]; expectedRoiByCurrency: ExpectedRoiCurrencyView[];
  actualRoiByCurrency: ActualRoiCurrencyView[];
  cashByCurrency: CashCurrencyView[];
  coverage: RoiCoverageSnapshot; dataGaps: RoiGapCode[];
  closureVersionId: string | null; formulaVersion: string;
  calculationHash: string; membershipSnapshotHash: string | null;
}

export interface GrowthPerformanceQueryPage<Row> {
  rows: readonly Row[];
  truncated: boolean;
}
export interface PublishedClosureSelection {
  closure: RoiClosureVersion;
  truncated: boolean;
}
export interface GrowthPerformanceDataSource {
  listCohortMembersAsOf(workspaceId: string, cohortId: string, planId: string | null, cutoff: GrowthSealedReadCutoff): Promise<GrowthPerformanceQueryPage<AcquisitionCohortMember>>;
  listCohortMemberSourcesAsOf(workspaceId: string, cohortMemberIds: readonly string[], cutoff: GrowthSealedReadCutoff): Promise<GrowthPerformanceQueryPage<AcquisitionCohortMemberSource>>;
  selectPublishedClosure(workspaceId: string, cohortId: string, currency: string, cutoff: GrowthSealedReadCutoff): Promise<PublishedClosureSelection | null>;
  getExactPublishedClosure(workspaceId: string, cohortId: string, currency: string, closureVersionId: string, cutoff: GrowthSealedReadCutoff): Promise<PublishedClosureSelection | null>;
  readMaterializedSnapshot(workspaceId: string, closureVersionId: string, sliceKey: "all" | `plan:${string}`): Promise<RoiSnapshot | null>;
  readFrozenMembersForSlice(workspaceId: string, closureVersionId: string, sliceKey: "all" | `plan:${string}`): Promise<GrowthPerformanceQueryPage<RoiSnapshotSliceMember>>;
}

export interface AcquisitionGrowthPerformanceQueryService {
  getAt(context: ActiveWorkspaceContext, query: Omit<GrowthPerformanceQuery,"asOf">, cutoff: GrowthSealedReadCutoff): Promise<GrowthPerformanceDto>;
}
export interface ExpectedRoiSalesOwnReader {
  listOwnAt(context: ActiveWorkspaceContext, input: { currency: string; cutoff: GrowthSealedReadCutoff; limit: number }): Promise<readonly ExpectedRoiCurrencyView[]>;
}
export interface RoiClosureEvidenceSnapshot {
  closureVersionId: string; version: number; sliceKey: "all" | `plan:${string}`;
  status: "closed" | "superseded"; asOf: string; closedAt: string;
  calculationHash: `sha256:${string}`; membershipSnapshotHash: `sha256:${string}`;
}
export interface RoiClosureEvidenceSealedReader {
  getAt(context: ActiveWorkspaceContext, input: { closureVersionId: string; sliceKey: "all" | `plan:${string}`; cutoff: GrowthSealedReadCutoff }): Promise<RoiClosureEvidenceSnapshot | null>;
}
```

- [ ] **Step 1: Write failing snapshot-selection and plan-slice tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { AcquisitionGrowthPerformanceQueryService } from "./acquisition-growth-performance-query.js";
import { growthPerformanceFixture } from "./growth-roi-test-fixtures.js";

test("explicit closure is exact and asOf selects max timestamp then highest version", async () => {
  const fixture = growthPerformanceFixture({ closures: [
    { id: "closure-1", version: 1, asOf: "2026-08-08T00:00:00.000Z", status: "superseded", roiBps: 1000 },
    { id: "closure-2", version: 2, asOf: "2026-08-08T00:00:00.000Z", status: "closed", roiBps: 2000 },
    { id: "closure-3", version: 3, asOf: "2026-08-10T00:00:00.000Z", status: "closed", roiBps: 3000 }
  ] });
  const service = new AcquisitionGrowthPerformanceQueryService(fixture.dependencies);
  const selected = await service.getAt(fixture.workspace, { cohortId: "cohort-1", currency: "CNY", planId: null, closureVersionId: null }, await fixture.seal("2026-08-09T00:00:00.000Z"));
  assert.equal(selected.actualRoiByCurrency[0]?.closureVersionId, "closure-2");
  const exact = await service.getAt(fixture.workspace, { cohortId: "cohort-1", currency: "CNY", planId: null, closureVersionId: "closure-1" }, await fixture.seal("2026-08-11T00:00:00.000Z"));
  assert.equal(exact.actualRoiByCurrency[0]?.closureVersionId, "closure-1");
});

test("planId slices firstPlanId inside one snapshot", async () => {
  const fixture = growthPerformanceFixture({ members: [{ id: "member-a", firstPlanId: "plan-a" }, { id: "member-b", firstPlanId: "plan-b" }] });
  const service = new AcquisitionGrowthPerformanceQueryService(fixture.dependencies);
  const result = await service.getAt(fixture.workspace, { cohortId: "cohort-1", currency: "CNY", planId: "plan-a", closureVersionId: null }, await fixture.seal("2026-08-09T00:00:00.000Z"));
  assert.deepEqual(result.memberIds, ["member-a"]);
});

test("expected ROI includes every candidate source merged into one canonical member", async () => {
  const fixture = growthPerformanceFixture({
    members: [{ id: "member-a", primaryCandidateId: "candidate-primary", firstPlanId: "plan-a" }],
    memberSources: [{ cohortMemberId: "member-a", candidateId: "candidate-secondary" }],
    quoteCandidateId: "candidate-secondary"
  });
  const result = await new AcquisitionGrowthPerformanceQueryService(fixture.dependencies).getAt(fixture.workspace, {
    cohortId: "cohort-1", currency: "CNY", planId: "plan-a", closureVersionId: null
  }, await fixture.seal("2026-08-09T00:00:00.000Z"));
  assert.deepEqual(result.expectedRoiByCurrency[0]?.quoteVersionIds, ["quote-secondary"]);
});

test("a late backdated closure cannot rewrite an earlier data-as-of", async () => {
  const fixture = growthPerformanceFixture({ closures: [
    { id: "closure-late", version: 1, asOf: "2026-08-01T00:00:00.000Z", closedAt: "2026-08-10T00:00:00.000Z", status: "closed", roiBps: 1000 }
  ] });
  const service = new AcquisitionGrowthPerformanceQueryService(fixture.dependencies);
  const historical = await service.getAt(fixture.workspace, { cohortId: "cohort-1", currency: "CNY", planId: null, closureVersionId: null }, await fixture.seal("2026-08-05T00:00:00.000Z"));
  assert.equal(historical.actualRoiByCurrency[0]?.reason, "cohort_not_closed");
  const explicit = await service.getAt(fixture.workspace, { cohortId: "cohort-1", currency: "CNY", planId: null, closureVersionId: "closure-late" }, await fixture.seal("2026-08-05T00:00:00.000Z"));
  assert.equal(explicit.actualRoiByCurrency[0]?.reason, "cohort_not_closed");
});

test("reopen is append-only and does not rewrite closure status at an older cutoff", async () => {
  const fixture = growthPerformanceFixture({ closures: [
    { id: "closure-1", version: 1, asOf: "2026-08-08T00:00:00.000Z", closedAt: "2026-08-09T00:00:00.000Z" }
  ] });
  const oldCutoff = await fixture.seal("2026-08-09T00:00:00.000Z");
  const before = await fixture.closureEvidence.getAt(fixture.workspace, {
    closureVersionId: "closure-1", sliceKey: "all", cutoff: oldCutoff
  });
  await fixture.reopenAt("closure-1", "2026-08-10T00:00:00.000Z");
  assert.deepEqual(await fixture.closureEvidence.getAt(fixture.workspace, {
    closureVersionId: "closure-1", sliceKey: "all", cutoff: oldCutoff
  }), before);
  const after = await fixture.closureEvidence.getAt(fixture.workspace, {
    closureVersionId: "closure-1", sliceKey: "all", cutoff: await fixture.seal("2026-08-10T00:00:00.000Z")
  });
  assert.equal(after?.status, "superseded");
});

test("a manager can complete first read projection without inheriting roi.close", async () => {
  const fixture = growthPerformanceFixture({ deferCohortProjection: true });
  const manager = fixture.workspace({ actorId: "manager-1", capabilities: ["growth.performance.team.read"] });
  const result = await new AcquisitionGrowthPerformanceQueryService(fixture.dependencies).getAt(
    manager,
    { cohortId: "cohort-1", currency: "CNY", planId: null, closureVersionId: null },
    await fixture.sealAs(manager, "2026-08-09T00:00:00.000Z")
  );
  assert.equal(result.cohortId, "cohort-1");
  assert.equal(fixture.userCommandContextsCreated, 0);
  assert.equal(fixture.readCatchUpSystemCommands, 1);
  await assert.rejects(
    () => fixture.queryAsSalesWithoutVisibility(),
    /growth_performance_forbidden/
  );
  assert.equal(fixture.projectionWritesAfterDeniedSales, 0);
});

test("member-page overflow fails closed before source, quote, cost, or closure selection", async () => {
  const fixture = growthPerformanceFixture({ memberPage: { rows: [fixtureMember("member-a")], truncated: true } });
  const result = await new AcquisitionGrowthPerformanceQueryService(fixture.dependencies).getAt(
    fixture.workspace,
    { cohortId: "cohort-1", currency: "CNY", planId: null, closureVersionId: null },
    await fixture.seal("2026-08-09T00:00:00.000Z")
  );
  assert.equal(result.actualRoiByCurrency[0]?.reason, "query_truncated");
  assert.deepEqual(result.memberIds, []);
  assert.deepEqual(fixture.downstreamCalls(), { memberSources: 0, quotes: 0, costs: 0, closureSelector: 0, expectedBuilder: 0 });
});

test("member-source-page overflow fails closed before quote, cost, or closure selection", async () => {
  const fixture = growthPerformanceFixture({ memberSourcePage: { rows: [fixtureMemberSource("member-a", "candidate-a")], truncated: true } });
  const result = await new AcquisitionGrowthPerformanceQueryService(fixture.dependencies).getAt(
    fixture.workspace,
    { cohortId: "cohort-1", currency: "CNY", planId: null, closureVersionId: null },
    await fixture.seal("2026-08-09T00:00:00.000Z")
  );
  assert.equal(result.actualRoiByCurrency[0]?.reason, "query_truncated");
  assert.deepEqual(result.memberIds, []);
  assert.deepEqual(fixture.downstreamCalls(), { memberSources: 1, quotes: 0, costs: 0, closureSelector: 0, expectedBuilder: 0 });
});
```

- [ ] **Step 2: Run growth query tests to verify RED**

Run: `cd backend && NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/acquisition-growth-performance-query-test.ts`

Expected: FAIL because the growth-performance query does not exist.

- [ ] **Step 3: Implement independent expected and actual query paths**

The public router captures `readStartedAt`, clamps the request time, seals it once, and calls only `getAt` with that exact `GrowthSealedReadCutoff`. For actual: if `closureVersionId` is supplied, fetch exactly that closure and validate workspace/cohort/currency plus both `closure.asOf <= cutoff.effectiveAsOf` and `closure.closedAt <= cutoff.effectiveAsOf`; an exact future/backfilled-late publication returns `cohort_not_closed` and never falls back. Otherwise select published `closed | superseded` with both time gates, ordering `asOf DESC, version DESC`. Select the materialized snapshot by `slice_key = query.planId === null ? "all" : "plan:" + query.planId`; if the closure or exact slice is absent, return `cohort_not_closed`. Never invoke actual calculation or derive actual totals or commercial ratios from snapshot entries during a query.

For expected: after the outer query authorizes concrete team/workspace visibility, call only `CohortProjectionReadCatchUpPort.ensureAt(workspace,cohortId,cutoff)` with the same sealed token. That internal port rechecks the read scope, persists the authenticated actor as a `performance_read` catch-up requester, and may complete only idempotent membership/source cache projection through the private projection coordinator; it never calls a public command, grants the caller a capability, or accepts mutation input. Recovery reauthorizes that persisted actor before cache work. Then `listCohortMembersAsOf` ignores the operational head and cache timestamps: across all event-unique ownership candidates it first applies `sourceRecordedAt<=cutoff.effectiveAsOf`, selects the minimum `(discoveredAt,sourceRecordedAt,eventId)` per subject, and only then filters the selected candidate by requested cohort and optional `firstPlanId`. Fetch immutable `AcquisitionCohortMemberSource` rows using their source-authority timestamps, not later projection timestamps. Pass the de-duplicated union of every eligible `primaryCandidateId` and source `candidateId` plus the exact same token to `AuthoritativeQuoteAsOfReader.listContributionsAsOf`. Include only the one valid approved not-won/not-lost quote per Deal at the cutoff, and aggregate cost-estimate/allocation versions selected from immutable lifecycle events using that token. Never use a current source/membership head for historical expected ROI. A legacy percent probability is a data gap, not `percent * 100`. Return formula version, quote IDs, probability assessment IDs, calculation hash, data time, and coverage.

`ExpectedRoiSalesOwnReader` is the only sales-level portfolio path. It first derives candidate/Deal keys from frozen member sources, Quote assignee/binding authority, and the authenticated `context.actorId`, applies that ownership predicate in SQL before limits, and calculates only that actor's expected results. It never reuses cohort `all`/plan slices, never returns actual/cash data, and still applies `amountVisibility="redacted"` unless the current caller has `pricing.sensitive.read`. Manager/team and admin/workspace Growth Performance remain on the public capability-gated query. Tests prove two salespeople in one workspace cannot see each other's expected quotes, more than 100 other-owner rows cannot hide the caller's row, and capability downgrade reprojects the identical frozen expected set without money fields.

For member display in a plan slice, join only immutable `roi_snapshot_slice_members` rows for the selected `(closureVersionId,sliceKey)` to their exact frozen `(cohortMemberId,ownershipVersionId)` entries, and verify the canonical pair set hash/count against `RoiSnapshot.memberSetHash/memberCount`. Snapshot entries remain the audit trail, not a second calculation input. Never consult a current membership head, reselect first-touch at query time, or recompute actual values when answering a published closure.

`RoiClosureEvidenceSealedReader.getAt` is the only Advisor/reference-verification port for ROI snapshots and Closure versions. It consumes the same opaque cutoff, performs an exact workspace/closure/slice lookup, requires `closure.asOf<=cutoff.effectiveAsOf` and `closedAt<=cutoff.effectiveAsOf`, reduces immutable series events with `recordedAt<=cutoff.effectiveAsOf` to derive `closed|superseded`, and returns only version, slice key, calculation/membership hashes and times. It never reads a mutable version status, exposes money, falls back to the current series, scans repositories, or seals internally. Tests reject a future/backfilled-late closure, wrong slice/hash/workspace, and prove a later reopen does not alter an older exact evidence snapshot.

The MySQL source performs set-based joins/aggregates. Every bounded/multi-row method returns the typed `GrowthPerformanceQueryPage<Row> { rows, truncated }`, including `listCohortMembersAsOf`, `listCohortMemberSourcesAsOf`, and frozen slice members. Any protective `LIMIT + 1`, incomplete cursor/page, or aggregate guard sets `truncated=true`. The service checks each page immediately after retrieval and before using even one row; member/member-source truncation returns a closed empty-member `queryTruncatedDto`, with actual `not_computable: query_truncated`, and does not call quote/cost readers, expected builders, Closure selectors, snapshot readers, or calculators. Partial expected or actual results are forbidden. Do not instantiate or call `AcquisitionPerformanceQueryService`.

Replace `backend/package.json`'s stage-4 MySQL command with the final cumulative, explicitly named suite:

```json
{
  "scripts": {
    "test:growth-roi:mysql": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/growth-roi-discovery-projection-mysql-test.ts src/growth-roi-cohort-mysql-test.ts src/growth-roi-cohort-recovery-mysql-test.ts src/growth-roi-attribution-mysql-test.ts src/growth-roi-settlement-mysql-test.ts src/growth-roi-closure-mysql-test.ts src/growth-roi-closure-recovery-mysql-test.ts src/growth-roi-performance-mysql-test.ts"
  }
}
```

The minimum GREEN selection keeps actual and expected paths separate and never feeds current ledgers into actual ROI:

```ts
async getAt(workspace: ActiveWorkspaceContext, query: Omit<GrowthPerformanceQuery,"asOf">, cutoff: GrowthSealedReadCutoff): Promise<GrowthPerformanceDto> {
  await this.cohortReadCatchUp.ensureAt(workspace, query.cohortId, cutoff);
  const memberPage = await this.dataSource.listCohortMembersAsOf(workspace.workspaceId, query.cohortId, query.planId, cutoff);
  if (memberPage.truncated) return this.queryTruncatedDto(workspace, query, cutoff.effectiveAsOf);
  const members = memberPage.rows;
  const memberSourcePage = await this.dataSource.listCohortMemberSourcesAsOf(workspace.workspaceId, members.map((member) => member.id), cutoff);
  if (memberSourcePage.truncated) return this.queryTruncatedDto(workspace, query, cutoff.effectiveAsOf);
  const memberSources = memberSourcePage.rows;
  const candidateIds = [...new Set([
    ...members.map((member) => member.primaryCandidateId),
    ...memberSources.map((source) => source.candidateId)
  ])];
  const expected = await this.expectedReader.listContributionsAsOf(workspace, {
    candidateIds,
    currency: query.currency,
    cutoff
  });
  const expectedView = await this.buildExpectedView(workspace, query, cutoff, members, expected);
  const selected = query.closureVersionId === null
    ? await this.dataSource.selectPublishedClosure(workspace.workspaceId, query.cohortId, query.currency, cutoff)
    : await this.dataSource.getExactPublishedClosure(workspace.workspaceId, query.cohortId, query.currency, query.closureVersionId, cutoff);
  if (selected?.truncated === true) return this.notComputable(workspace, query, members, expectedView, "query_truncated");
  if (selected === null) return this.notComputable(workspace, query, members, expectedView, "cohort_not_closed");
  const sliceKey = query.planId === null ? "all" : `plan:${query.planId}`;
  const snapshot = await this.dataSource.readMaterializedSnapshot(workspace.workspaceId, selected.closure.id, sliceKey);
  if (snapshot === null) return this.notComputable(workspace, query, members, expectedView, "cohort_not_closed");
  const frozenMembers = await this.dataSource.readFrozenMembersForSlice(workspace.workspaceId, selected.closure.id, sliceKey);
  if (frozenMembers.truncated) return this.notComputable(workspace, query, members, expectedView, "query_truncated");
  return this.projectMaterializedSnapshot(query, cutoff.effectiveAsOf, expectedView, selected.closure, snapshot, frozenMembers.rows);
}
```

`selectPublishedClosure` queries immutable versions with `workspace_id=? AND cohort_id=? AND currency=? AND as_of<=? AND closed_at<=? ORDER BY as_of DESC, version DESC LIMIT 1`; it does not filter a mutable status column. `getExactPublishedClosure` adds exact closure ID and the same two time gates and never falls back. Both join/reduce `roi_closure_series_events` only through `recordedAt<=cutoff.effectiveAsOf` to project that selected version's status at the cutoff; a later reopen event cannot change an earlier query. `projectMaterializedSnapshot` accepts only the typed `RoiSnapshot` selected by exact `sliceKey` plus its frozen members and returns the closed `GrowthPerformanceDto`; it copies actual metrics and `calculationHash` byte-for-byte from that row. If `workspace.capabilities` lacks `pricing.sensitive.read`, it returns `amountVisibility="redacted"` for expected, actual, and cash sections and omits every gross-profit, cost, contract, payment, refund, bad-debt, and net-cash minor field while retaining ROI BPS, the three non-ROI ratio BPS/statuses, coverage, and closure evidence. Idempotent/tool replays retain the exact source IDs, effective cutoff and calculation hashes but re-project every section using the caller's current capabilities; capability downgrade clears previously visible amounts instead of returning a cached response.

- [ ] **Step 4: Verify time travel, truncation, plan slices, and MySQL aggregation**

Run: `cd backend && NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/acquisition-growth-performance-query-test.ts && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-roi:mysql`

Expected: PASS for exact superseded snapshot lookup, as-of tie breaking, plan slice, no-closure actual gap, and oversized query returning `query_truncated` rather than computed. Separate memory/MySQL cases overflow the member page and member-source page; each returns no partial member/expected/actual calculation and proves every downstream quote/cost/selector call count is zero.

- [ ] **Step 5: Commit Growth Performance query**

```bash
git add backend/src/acquisition-growth-performance-query.ts backend/src/acquisition-growth-performance-mysql-query.ts backend/src/acquisition-growth-performance-query-test.ts backend/src/growth-roi-performance-mysql-test.ts backend/src/growth-finance-mysql-test-support.ts backend/src/growth-roi-test-fixtures.ts backend/package.json
git commit -m "feat: query closed acquisition growth performance"
```

### Task 13: Register stage-4 routes against the frozen Growth contract

**Files:**
- Modify: `backend/src/growth-roi-module.ts`
- Modify: `backend/src/growth-roi-module-test.ts`
- Create: `backend/src/acquisition-cohort-router.ts`
- Create: `backend/src/acquisition-cohort-router-test.ts`
- Create: `backend/src/acquisition-attribution-allocation-router.ts`
- Create: `backend/src/acquisition-attribution-allocation-router-test.ts`
- Create: `backend/src/financial-settlement-allocation-router.ts`
- Create: `backend/src/financial-settlement-allocation-router-test.ts`
- Create: `backend/src/acquisition-roi-closure-router.ts`
- Create: `backend/src/acquisition-roi-closure-router-test.ts`
- Create: `backend/src/acquisition-growth-performance-router.ts`
- Create: `backend/src/acquisition-growth-performance-router-test.ts`
- Modify: `backend/src/growth-commercial-composition.ts`
- Create: `backend/src/growth-roi-openapi-response-conformance-test.ts`
- Create: `backend/src/growth-roi-contract-route-test.ts`
- Create: `backend/src/growth-roi-router-test-support.ts`
- Test: `backend/src/growth-roi-module-test.ts`
- Test: all five router tests, contract suites, and old performance tests.

**Interfaces:**
- Consumes: Tasks 1–12, C0 `GrowthCommercialModule`/private-service registry, Foundation's exact `GROWTH_FOUNDATION_SERVICES`, `assertGrowthAsOfNotFuture`, and command-context factory, Quote's exact `GROWTH_QUOTE_AUTHORITY_READERS`, Finance's exact `GROWTH_FINANCE_SERVICES`, frozen Growth contract bundle, and the single application-owned `GrowthCommercialToolPorts` instance.
- Produces: the final extension of Task 2's single `createGrowthRoiModule()`, `GROWTH_ROI_SERVICES: GrowthPrivateServiceKey<GrowthRoiServices>`, section-11.1 cohort/allocation/settlement/closure APIs, `GET /api/v1/acquisition/growth-performance`, and test-only `mountGrowthRoiRouters()` over the real Growth composition. It retains Task 2's exact discovery repository/source/writer and both ROI discovery private keys; it does not install a second ROI module or replace the projected writer. It registers no Pi tool; the later Advisor module requires this typed service and solely registers `get_growth_performance`/`list_financial_data_gaps`. `GrowthCommercialToolPorts` remains the C0 `register/execute` registry and gains no structural field.

```ts
export interface GrowthRoiServices {
  cohorts: AcquisitionCohortService;
  allocations: AttributionAllocationService;
  settlements: CashSettlementAllocationService;
  closures: RoiClosureService;
  growthPerformance: AcquisitionGrowthPerformanceQueryService;
  expectedSalesOwn: ExpectedRoiSalesOwnReader;
  closureEvidence: RoiClosureEvidenceSealedReader;
}
export interface GrowthRoiResources extends GrowthRoiServices {
  commandExecutor: RoiCommandExecutor;
  authoritativeDiscoveries: AuthoritativeDiscoverySource;
  acquisitionIntegrations: GrowthRoiAcquisitionIntegrations;
  sourceReportService: FinancialSourceReportService;
  cohortRecovery: AcquisitionCohortRecoverySweeper;
  closureRecovery: RoiClosureRecoverySweeper;
  closeRoiResources(): Promise<void>;
}
export interface GrowthRoiModuleOptions {
  /** Expands Task 2's factory; constructs exactly one discovery repository/writer and owns one reverse close stack. */
  createResources(input: {
    foundation: GrowthFoundationServices;
    quote: GrowthQuoteAuthorityReaders;
    finance: GrowthFinanceServices;
  }): Promise<GrowthRoiResources>;
}
```

- [ ] **Step 1: Write the failing public route and legacy compatibility test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mountGrowthRoiRouters } from "./growth-roi-router-test-support.js";

test("growth performance publishes closure metadata while legacy performance stays unchanged", async () => {
  const app = await mountGrowthRoiRouters();
  try {
    const growth = await app.request("/api/v1/acquisition/growth-performance?cohortId=cohort-1&currency=CNY&asOf=2026-08-09T00%3A00%3A00.000Z");
    assert.equal(growth.response.status, 200);
    assert.equal(growth.body.actualRoiByCurrency[0].status, "computed");
    assert.equal(growth.body.actualRoiByCurrency[0].closureVersionId, "closure-1");
    assert.equal(growth.body.formulaVersion, "verified-gross-profit-roi.v1");
    assert.match(growth.body.calculationHash, /^sha256:/u);
    assert.equal(JSON.stringify(growth.body).includes("temporalSequence"), false);
    assert.equal(JSON.stringify(growth.body).includes("cutoffTemporalSequence"), false);
    const legacy = await app.request("/api/v1/acquisition/performance?from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-09T00%3A00%3A00.000Z");
    assert.deepEqual(legacy.body.roi, { status: "not_computable", reason: "channel_cost_or_verified_margin_unavailable" });
  } finally { await app.close(); }
});

test("closing requires idempotency and If-Match", async () => {
  const app = await mountGrowthRoiRouters();
  try {
    const response = await app.request("/api/v1/acquisition/cohorts/cohort-1/close", { method: "POST", body: JSON.stringify({ currency: "CNY", asOf: "2026-08-09T00:00:00.000Z", attestationIds: [] }) });
    assert.equal(response.response.status, 400);
    assert.equal(response.body.error.code, "idempotency_key_required");
  } finally { await app.close(); }
});

test("growth performance redacts expected, actual, and cash amounts without pricing sensitive capability", async () => {
  const app = await mountGrowthRoiRouters({ capabilities: ["growth.performance.team.read"] });
  try {
    const result = await app.request("/api/v1/acquisition/growth-performance?cohortId=cohort-1&currency=CNY&asOf=2026-08-09T00%3A00%3A00.000Z");
    const actual = result.body.actualRoiByCurrency[0];
    const expected = result.body.expectedRoiByCurrency[0];
    const cash = result.body.cashByCurrency[0];
    assert.equal(actual.amountVisibility, "redacted");
    assert.equal(expected.amountVisibility, "redacted");
    assert.equal(cash.amountVisibility, "redacted");
    assert.equal("verifiedGrossProfitMinor" in actual, false);
    assert.equal("verifiedAcquisitionCostMinor" in actual, false);
    assert.equal("probabilityWeightedGrossProfitMinor" in expected, false);
    assert.equal("attributedEstimatedCostMinor" in expected, false);
    assert.equal("verifiedContractWonMinor" in cash, false);
    assert.equal("allocatedPaymentMinor" in cash, false);
    assert.equal("netCashMinor" in cash, false);
    assert.equal(cash.contractRoas.bps, 50_000);
    assert.equal(cash.cashMultiple.bps, 45_000);
    assert.equal(cash.collectionRate.bps, 9_000);
  } finally { await app.close(); }
});

test("command bodies cannot inject revision or worker lease state", async () => {
  const app = await mountGrowthRoiRouters();
  try {
    const response = await app.request("/api/v1/acquisition/cohorts/cohort-1/close", {
      method: "POST",
      headers: { "Idempotency-Key": "close-0001", "If-Match": "1" },
      body: JSON.stringify({ currency: "CNY", asOf: "2026-08-09T00:00:00.000Z", attestationIds: [], expectedRevision: 99, leaseOwner: "caller", fencingToken: 99 })
    });
    assert.equal(response.response.status, 400);
    assert.equal(response.body.error.code, "schema_validation_failed");
  } finally { await app.close(); }
});

test("public growth queries and closure share the frozen one-second as-of bound", async () => {
  const app = await mountGrowthRoiRouters({ serverNow: "2026-08-09T00:00:00.000Z" });
  try {
    const query = await app.request("/api/v1/acquisition/growth-performance?cohortId=cohort-1&currency=CNY&asOf=2026-08-09T00%3A00%3A01.001Z");
    assert.equal(query.response.status, 422);
    assert.equal(query.body.error.code, "invalid_as_of");
    const close = await app.request("/api/v1/acquisition/cohorts/cohort-1/close", {
      method: "POST", headers: { "Idempotency-Key": "future-close", "If-Match": "1" },
      body: JSON.stringify({ currency: "CNY", asOf: "2026-08-09T00:00:01.001Z", attestationIds: [] })
    });
    assert.equal(close.response.status, 422);
    assert.equal(close.body.error.code, "invalid_as_of");
    assert.equal(app.businessWrites, 0);
  } finally { await app.close(); }
});

test("one key cannot replay a command for a different path resource", async () => {
  const app = await mountGrowthRoiRouters();
  try {
    const first = await app.activateAttribution("allocation-a", { key: "activate-shared", revision: 1 });
    assert.equal(first.response.status, 200);
    const second = await app.activateAttribution("allocation-b", { key: "activate-shared", revision: 1 });
    assert.equal(second.response.status, 409);
    assert.equal(second.body.error.code, "idempotency_conflict");
    assert.equal(app.activatedIds.includes("allocation-b"), false);
  } finally { await app.close(); }
});
```

- [ ] **Step 2: Run routes/contracts to verify RED**

Run: `cd backend && NODE_ENV=test TZ=UTC JWT_SECRET=goodjob-growth-roi-router-test-secret-at-least-32-characters node --import tsx --test --test-concurrency=1 src/growth-roi-module-test.ts src/acquisition-cohort-router-test.ts src/acquisition-attribution-allocation-router-test.ts src/financial-settlement-allocation-router-test.ts src/acquisition-roi-closure-router-test.ts src/acquisition-growth-performance-router-test.ts src/acquisition-performance-router-test.ts`

Expected: FAIL because the C0-frozen stage-4 paths are not yet mounted and the route-conformance test reports missing handlers; the schemas already exist and are not changed here.

- [ ] **Step 3: Implement strict routes against C0's independent versioned schemas**

Mount exactly these endpoints:

```text
GET/POST /api/v1/acquisition/cohorts
GET /api/v1/acquisition/cohorts/:id
GET/POST /api/v1/acquisition/cohorts/:id/attestations
POST /api/v1/acquisition/cohorts/:id/close
GET /api/v1/acquisition/cohorts/:id/closures
POST /api/v1/acquisition/roi-closures/:closureVersionId/reopen
GET/POST /api/v1/acquisition/attribution-allocation-sets
GET /api/v1/acquisition/attribution-allocation-sets/:id
POST /api/v1/acquisition/attribution-allocation-sets/:id/activate
GET/POST /api/v1/finance/source-reports
GET /api/v1/finance/source-reports/:id
GET/POST /api/v1/finance/settlement-allocation-sets
GET /api/v1/finance/settlement-allocation-sets/:id
POST /api/v1/finance/settlement-allocation-sets/:id/activate
GET /api/v1/acquisition/growth-performance
```

All HTTP commands require `Idempotency-Key`; activation/close/reopen require `If-Match`. Service and route capability rules are exact: source-report/allocation/settlement draft uses `ledger.pending.create`; allocation/settlement activation uses `ledger.verify`; cohort create plus attestation/close/reopen uses `roi.close`; the two non-route catch-up adapters reuse the already-authorized Closure or Performance identity described in Task 2; public reads use the concrete team/workspace Growth Performance visibility port. No handler accepts a role/scope string, and replay/recovery repeats current service authorization. Focused route/service tests prove sales cannot enumerate or mutate these resources, manager can create only permitted pending drafts, ledger activation and ROI closure are denied without their exact capabilities with zero idempotency completion/operation/domain rows, and an authorized admin succeeds. At the first handler line, Growth Performance and Closure/attestation each capture their server start, call Foundation's `assertGrowthAsOfNotFuture` before any reader, reservation, operation, or business write, then seal the effective cutoff exactly once. Growth Performance passes the token to `growthPerformance.getAt`; Closure/attestation remove raw `asOf` and pass it to `closureService.closeAt`/`createAttestationAt`. Those services and every nested reader accept only the same branded token and cannot reseal. A value beyond the common tolerance returns `422 invalid_as_of`; Closure/attestation writes zero rows. Recovery is a separate execution boundary that reauthorizes the persisted operation and seals its persisted effective cutoff once before calling the same token-only core. Public Growth Performance returns closed full/redacted variants based on `pricing.sensitive.read`. Sales-own expected data is available only through the internal actor-scoped reader consumed by Advisor, never by weakening the public cohort query. Public closure/attestation DTO projectors are closed allow-lists and omit `temporalSequence`, `sealedCutoffTemporalSequence`, `appendTemporalSequence`, lease/fence and operation fields; those values remain internal audit metadata only. Error enums include `cost_missing`, `cost_not_closed`, `gross_profit_unverified`, `cash_reconciliation_incomplete`, `attribution_incomplete`, `multi_currency_without_fx`, `zero_estimated_cost`, `zero_cost`, `query_truncated`, and `cohort_not_closed`.

Register all stage-4 routers only inside the Task-2-created `createGrowthRoiModule().install({ router, privateServices })`. Task 13 extends that same module rather than declaring another factory/key. The module first calls `privateServices.require(GROWTH_FOUNDATION_SERVICES)`, `privateServices.require(GROWTH_QUOTE_AUTHORITY_READERS)`, and `privateServices.require(GROWTH_FINANCE_SERVICES)`, then constructs every ROI repository/service exactly once from those singleton graphs, including exactly one `MysqlAuthoritativeDiscoveryProjectionRepository` used as both writer and source. Every resource receives the exact Foundation temporal singleton and token-only authority readers. Missing services fail before resource construction. The production `createResources` factory is itself strongly exception-safe: it creates an idempotent reverse construction-order close stack before the first pool/repository/sweeper, registers each successful resource immediately, drains all prior entries exactly once if constructor N throws, and returns `GrowthRoiResources` only after the graph is complete. `closeRoiResources` reuses this same once-only stack. After resources, all three ROI private values, routes, and the Acquisition integration projection are ready, start `AcquisitionCohortRecoverySweeper` and then `RoiClosureRecoverySweeper` exactly once. If provision/mount/first start/second start fails, the module-local catch stops/drains anything started and closes every returned current-module resource before rethrowing; the outer composition then closes prior modules. It provides one frozen `GrowthRoiServices`, retains the frozen discovery services/integration from Task 2, mounts each route once, and registers no tool handler. `closeRoiResources` is module-local/idempotent: reject new work, stop/drain closure recovery, then cohort recovery, then close repositories in reverse construction order. Tests inject failure at every resource-construction position and assert earlier resources reverse-close exactly once with no provide/mount/timer; they also cover partial start, mount/provide failure, later-module failure, repeated close, active sweep drain, and recovery of one real expired cohort plus closure operation.

Retain Task 2's one `createGrowthRoiModule(...)` entry in C0's production-owned `growth-commercial-composition.ts`, immediately after Finance and before Advisor, and extend only that entry's final resources/routes. The same file's sole `projectIntegrations` must continue requiring `GROWTH_ROI_ACQUISITION_INTEGRATIONS` and copying its writer by reference; it must not install a second ROI module or project a source/reader in place of the writer. Task 2 already made the required C0 application type and `server.ts` injection changes; Task 13 does not add another field or call site. Do not add `cohorts` or `growthPerformance` properties to `GrowthCommercialToolPorts`, and do not instantiate services in the runtime bridge. Never reuse a shared `closeGrowthResources`; Finance and ROI each return their own close handle and C0 closes installed modules once in reverse order.

The module and sole composition edit are exact:

```ts
export const GROWTH_ROI_SERVICES = Object.freeze({
  id: Symbol("growth.roi.services"),
  description: "Growth ROI cohort, closure, and performance services"
}) satisfies GrowthPrivateServiceKey<GrowthRoiServices>;

export function createGrowthRoiModule(options: GrowthRoiModuleOptions): GrowthCommercialModule {
  let installed = false;
  return {
    name: "growth-roi",
    async install({ router, privateServices }) {
      if (installed) throw new Error("GROWTH_ROI_MODULE_ALREADY_INSTALLED");
      installed = true;
      const foundation = privateServices.require(GROWTH_FOUNDATION_SERVICES);
      const quote = privateServices.require(GROWTH_QUOTE_AUTHORITY_READERS);
      const finance = privateServices.require(GROWTH_FINANCE_SERVICES);
      let resources: GrowthRoiResources | null = null;
      try {
        resources = await options.createResources({ foundation, quote, finance });
        const services = Object.freeze({
          cohorts: resources.cohorts,
          allocations: resources.allocations,
          settlements: resources.settlements,
          closures: resources.closures,
          growthPerformance: resources.growthPerformance,
          expectedSalesOwn: resources.expectedSalesOwn,
          closureEvidence: resources.closureEvidence
        }) satisfies GrowthRoiServices;
        if (resources.acquisitionIntegrations.authoritativeDiscoveryProjectionWriter !== resources.authoritativeDiscoveries) {
          throw new Error("GROWTH_ROI_DISCOVERY_WRITER_SOURCE_IDENTITY_MISMATCH");
        }
        const discoveryServices = Object.freeze({
          commandExecutor: resources.commandExecutor,
          authoritativeDiscoveries: resources.authoritativeDiscoveries,
          acquisitionIntegrations: resources.acquisitionIntegrations
        }) satisfies GrowthRoiDiscoveryServices;
        privateServices.provide(GROWTH_ROI_DISCOVERY_SERVICES, discoveryServices);
        privateServices.provide(GROWTH_ROI_ACQUISITION_INTEGRATIONS, resources.acquisitionIntegrations);
        privateServices.provide(GROWTH_ROI_SERVICES, services);
        router.use("/api/v1/acquisition", createAcquisitionCohortRouter({ cohortService: services.cohorts, closureService: services.closures, workspaceContext: foundation.workspaceContext, commandContextFactory: foundation.commandContextFactory, temporalBarrier: foundation.temporalBarrier }));
        router.use("/api/v1/acquisition", createAttributionAllocationRouter({ allocationService: services.allocations, workspaceContext: foundation.workspaceContext, commandContextFactory: foundation.commandContextFactory }));
        router.use("/api/v1/finance", createFinancialSourceReportRouter({ sourceReportService: resources.sourceReportService, workspaceContext: foundation.workspaceContext, commandContextFactory: foundation.commandContextFactory }));
        router.use("/api/v1/finance", createFinancialSettlementAllocationRouter({ settlementService: services.settlements, workspaceContext: foundation.workspaceContext, commandContextFactory: foundation.commandContextFactory }));
        router.use("/api/v1/acquisition", createAcquisitionGrowthPerformanceRouter({ query: services.growthPerformance, workspaceContext: foundation.workspaceContext, temporalBarrier: foundation.temporalBarrier }));
        await resources.cohortRecovery.start();
        await resources.closureRecovery.start();
        return { close: () => resources!.closeRoiResources() };
      } catch (error) {
        if (resources !== null) await resources.closeRoiResources();
        throw error;
      }
    }
  };
}

function projectIntegrations(
  privateServices: GrowthPrivateServiceRegistry
): GrowthAcquisitionIntegrations {
  const foundation = privateServices.require(GROWTH_FOUNDATION_SERVICES);
  const quote = privateServices.require(GROWTH_QUOTE_ACQUISITION_INTEGRATIONS);
  const roi = privateServices.require(GROWTH_ROI_ACQUISITION_INTEGRATIONS);
  return Object.freeze({
    acquisitionWorkspace: foundation.acquisitionWorkspace,
    temporalBarrier: foundation.temporalBarrier,
    probabilityAssessments: quote.probabilityAssessments,
    quoteProjectedDocumentAuthority: quote.quoteProjectedDocumentAuthority,
    authoritativeDiscoveryProjectionWriter:
      roi.authoritativeDiscoveryProjectionWriter
  });
}

export function createGrowthCommercialComposition(
  dependencies: GrowthCommercialCompositionDependencies
): GrowthCommercialComposition<GrowthAcquisitionIntegrations> {
  return Object.freeze({
    modules: Object.freeze([
      createGrowthFoundationModule(dependencies),
      createGrowthCatalogModule(dependencies),
      createGrowthQuoteModule(dependencies),
      createGrowthFinanceModule(dependencies),
      createGrowthRoiModule(dependencies)
    ]),
    projectIntegrations
  });
}
```

`growth-roi-module-test.ts` installs the module against the real C0 private-service registry and asserts: missing Foundation, Quote, or Finance key throws before repository/route creation; `createResources` receives the exact `GROWTH_QUOTE_AUTHORITY_READERS` identity and its `authoritativeContributions` reader; all five router factories receive the reference-equal `foundation.workspaceContext`, and missing/non-concrete/`teamId="all"`/cross-workspace reads fail closed; one install mounts each method/path exactly once and registers zero tools; `GROWTH_ROI_SERVICES` returns the exact service instances used by the routers; `GROWTH_ROI_DISCOVERY_SERVICES.authoritativeDiscoveries`, `GROWTH_ROI_ACQUISITION_INTEGRATIONS.authoritativeDiscoveryProjectionWriter`, the final C0-projected field, and both Acquisition Run/domain consumers all reference the one `MysqlAuthoritativeDiscoveryProjectionRepository`; missing/partial/lookalike integration fails projection; a second provide is rejected; and repeated module close calls execute `closeRoiResources` once without closing Foundation, Quote, or Finance. At this stage the C0 composition test asserts Foundation→Catalog→Quote→Finance→ROI order, requires the ROI key in the final projector, and proves failed ROI install or final integration projection triggers reverse cleanup of already-installed modules; the following Advisor plan alone appends Advisor after ROI.

Each command router obtains `CommandContext` from the Foundation-owned `foundation.commandContextFactory`, rejects missing `Idempotency-Key`, parses `If-Match` into `expectedRevision`, and passes the same context object into the service. Every factory call includes the schema-validated closed path map: cohort collection `Object.freeze({})`; cohort detail/attestation/close `{id}`; closure reopen `{closureVersionId}`; attribution/settlement detail or activate `{id}`; source-report and settlement collection `Object.freeze({})`. Canonical paths retain the `:id`/`:closureVersionId` template while `pathParams` carries the concrete resource identity. Same key/body/revision across two IDs therefore returns `409 idempotency_conflict` before any domain write. Read routers obtain the identical `req.activeWorkspace` object through `foundation.workspaceContext`. No module option or router accepts a second context resolver, and no request body accepts `workspaceId`, `actorId`, capabilities, or computed metrics.

Use `backend/src/growth-roi-contract-route-test.ts` to compare mounted routes, methods, required headers, query parameters, and public DTO field sets against the already-frozen `growth-advisor-quote-roi.v1.yaml`. Use `backend/src/growth-roi-openapi-response-conformance-test.ts` with Ajv to validate real computed, every enumerated `not_computable`, 409, 412, and 422 response. Add a regression assertion that the old performance route and Pi tool expose no new fields and retain their old reason. A frozen Growth contract mismatch is returned to C0 ownership; this task must not create or edit schemas.

- [ ] **Step 4: Run focused, frozen-contract, full acquisition, MySQL, and build gates**

Run:

```bash
cd /Users/mac/Documents/外贸/GoodJob-1.09/.worktrees/goodjob-growth-advisor-quote-roi
npm run test:contracts
cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/growth-roi-module-test.ts src/growth-roi-contract-route-test.ts src/growth-roi-openapi-response-conformance-test.ts
cd ..
npm run test:growth-openapi --workspace backend
npm run check:growth-contract-release
npm run check:growth-contracts
npm run test:acquisition --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-roi:mysql --workspace backend
npm run build
git diff --check
```

Expected: every command exits 0; old performance remains compatible; Growth Performance reads published snapshots; `git diff --check` prints nothing.

- [ ] **Step 5: Commit the stage-4 public surface**

```bash
git add backend/src/growth-roi-module.ts backend/src/growth-roi-module-test.ts backend/src/acquisition-cohort-router.ts backend/src/acquisition-cohort-router-test.ts backend/src/acquisition-attribution-allocation-router.ts backend/src/acquisition-attribution-allocation-router-test.ts backend/src/financial-settlement-allocation-router.ts backend/src/financial-settlement-allocation-router-test.ts backend/src/acquisition-roi-closure-router.ts backend/src/acquisition-roi-closure-router-test.ts backend/src/acquisition-growth-performance-router.ts backend/src/acquisition-growth-performance-router-test.ts backend/src/growth-commercial-composition.ts backend/src/growth-roi-openapi-response-conformance-test.ts backend/src/growth-roi-contract-route-test.ts backend/src/growth-roi-router-test-support.ts
git commit -m "feat: register closed acquisition roi APIs"
```

## Execution Order and Review Gates

1. Tasks 1–3 establish canonical first-touch membership and must finish before attribution or closure.
2. Task 4 is pure deterministic math; Task 5 consumes it, and Task 6 proves persistent concurrency.
3. Tasks 7–8 establish per-revenue cash truth and must finish before close is allowed.
4. Task 9 is pure deterministic calculation; only Task 10 may call its actual-ROI function with closure authorization.
5. Tasks 10–11 freeze and persist immutable snapshots after all upstream gates pass.
6. Task 12 reads expected facts live and actual facts only from snapshot; it never computes actual from current ledgers.
7. Task 13 publishes after all memory and MySQL behavior suites pass and must retain the legacy performance contract unchanged.

The implementation is stage-4 complete only when a real cohort can be caught up without truncation, shared sources are exactly allocated, cash reconciles per revenue fact, a signed currency-specific closure produces one immutable actual ROI snapshot, and Growth Performance returns that snapshot with reproducible hashes. Incomplete data must produce an enumerated gap, never a computed actual ROI.
