# Growth Financial Ledgers and Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build append-only acquisition-cost and financial-fact ledgers, versioned estimates, verification/correction audit chains, and a secure, idempotent Excel/CSV preview-and-commit pipeline for stages 3.1–3.3.

**Architecture:** Keep estimated costs physically separate from verified actual ledgers. Put state transitions behind one repository contract with matching in-memory and MySQL implementations, project existing provider-request evidence through an explicit source adapter, and reuse one extracted secure spreadsheet parser for discovery and finance imports. Every command enters through the stage-0 workspace/capability/idempotency boundary; actual money is admitted only through positive immutable rows plus append-only verification events.

**Tech Stack:** TypeScript 5, Node.js test runner, `tsx`, Express, MySQL 8/InnoDB via `mysql2/promise`, `xlsx-js-style`, JSON Schema Draft 2020-12, OpenAPI 3.1, Ajv, npm workspaces.

## Global Constraints

- This plan starts only after stages 0–2 provide `ActiveWorkspaceContext` in `backend/src/growth-workspace-context.ts`, `CommandContext` in `backend/src/growth-command-context.ts`, `GrowthHttpIdempotencyRepository` in `backend/src/growth-http-idempotency-repository.ts`, its MySQL implementation, and fixed-point helpers in `backend/src/growth-money.ts`.
- Contract plan C0 exclusively creates and publishes `contracts/openapi/growth-advisor-quote-roi.v1.yaml`, all Growth JSON Schemas, release manifest/hash, `backend/src/growth-openapi.ts`, `backend/src/growth-commercial-application.ts`, `backend/src/growth-commercial-runtime-bridge.ts`, and Growth bootstrap. This plan consumes those artifacts and never edits `ai-acquisition.v1.yaml`, `acquisition-openapi.ts`, or legacy generated acquisition types.
- C0's application returns `{ handler, toolPorts: GrowthCommercialToolPorts, close }`. `GrowthCommercialRuntimeBridge` mirrors the existing acquisition bridge with `install/middleware/close`; server startup installs Growth first and injects `growthRuntime.toolPorts` into acquisition. Stage 3 composes one ledger/import service graph inside the Growth application but does not add structural properties or tool names to `toolPorts`; later Advisor handlers close over these same local services when they register their closed names.
- Consume `CommercialBindingVerifier` and `CommercialBindingSnapshot` from the quote plan's `backend/src/commercial-binding-snapshot.ts`; stage 3 must not create a second candidate/customer/deal binding model.
- Every persisted row uses one concrete authorized `workspaceId`; `teamId="all"` is never persisted, and every nested ID is checked against the same workspace.
- Every public Finance HTTP list/get/read/export requires at least `ledger.pending.create`; pending cost/fact creation, estimate draft/activate/supersede, import template/preview/commit and source-report draft also require `ledger.pending.create`. Verify, reject, reverse, correct and every financial authority decision require `ledger.verify`. Enforce these in the service/application boundary as well as the router, and re-authorize completed idempotency replay plus recovery execution against current membership/capabilities before projection or work. Frozen role names never grant implicitly: ordinary `sales`/`manager` fixtures lacking the capability are denied, while an `admin` succeeds only when its current concrete workspace context carries it. Internal token-only Finance readers used by Advisor/ROI apply their own authorized binding/visibility ports and are not accidentally wrapped in this HTTP base capability.
- Acquire the HTTP idempotency reservation before any business row lock. Every Finance write transaction implements Foundation's exact `GrowthTemporalTransaction`: `lockWorkspaceTemporalBarrierForUpdate(workspaceId)`, `currentTimestamp3()`, and `saveWorkspaceTemporalBarrier(workspaceId,expectedSequence,next)`. Its first business lock is always the concrete workspace temporal barrier, held through commit; only then may correction lock `LedgerSourceHead FOR UPDATE` → current ledger entry → current verification-event prefix. Preview, import operation/worker, estimate, cost, fact, verification, reversal and correction paths never invert this order.
- Finance consumes only the exact Foundation singleton `foundation.temporalBarrier`. The first append stamp in a transaction comes from `foundation.temporalBarrier.allocateAppend(tx,workspaceId)` before any domain lock; every additional immutable row/event in that transaction calls it again. Persist both returned `recordedAt` and `temporalSequence` on every append/evidence row. Request `attemptedAt`, lease-comparison `now`, calculation/business time, and append time are never conflated; Finance implements no local HLC or timestamp allocator.
- Foundation owns the opaque frozen `GrowthSealedReadCutoff { workspaceId; effectiveAsOf; temporalSequence }`. At the first line of a standalone public Finance `context + asOf` boundary, capture the server `readStartedAt`, obtain the authorized/clamped `effectiveAsOf = assertGrowthAsOfNotFuture(input.asOf,readStartedAt,1_000)`, and only then call `foundation.temporalBarrier.sealReadCutoff(context,effectiveAsOf)` exactly once; an invalid/far-future value fails before the barrier or any reader is called. Pass that exact token object to internal Finance sealed readers. Internal/Advisor/ROI readers accept only `GrowthSealedReadCutoff`, never call `sealReadCutoff`, never accept a second workspace/as-of, and reject an invalid/`all` token workspace. Sealing waits for earlier workspace writers and advances the global tail to at least the authorized effective cutoff, so every later append—including a brand-new stream under a regressing DB clock—is strictly after the token and cannot rewrite the result. A client clock can never advance the barrier beyond the server-frozen boundary.
- Every command route requires an 8–200 character `Idempotency-Key`; every mutable aggregate transition also requires `If-Match` with the current integer revision. Foundation's canonical hash includes strictly parsed, key-sorted route `pathParams`; entry/fact/preview/operation IDs are never represented only by a route template. Same key and canonical request hash replays; same key and a different path/body/revision hash returns `409 idempotency_conflict`.
- Finance services invoke only the Foundation free function `executeGrowthIdempotentCommand({ repository: foundation.httpIdempotency, reservation }, authorizeAndProject, execute)`; no Finance class adds or calls `this.httpIdempotency.execute`. Reservations freeze exact workspace/actor/method/canonical path/key/request hash/server attemptedAt/random request lease owner, and completed records store only the exact resource/operation IDs defined by each command.
- Long-running finance preview/commit operations use a lease owner, expiry, monotonic fencing token, heartbeat, and recovery scan. A stale worker must fail its fenced write.
- Every finance-import claim, renewal, row-result save, completion, and failure transition matches the exact `leaseOwner + fencingToken` and requires `leaseExpiresAt > now`; an expired worker fails closed even when no replacement has claimed yet. The production recovery sweeper owns start/stop/close lifecycle and waits for in-flight recovery before shutdown.
- Store all money as ISO 4217 currency plus positive JavaScript-safe integer minor units. Use `BigInt` for multiplication, division, BPS allocation, and decimal conversion; never persist or aggregate floating-point money.
- Read provider request cost from its raw MySQL `DECIMAL(18,6)` string through a dedicated source adapter. Do not use `ProspectProviderRequestAccountingEvidence.costAmount: number` from `backend/src/types.ts` as production accounting input.
- `AcquisitionCostEstimate` is never verified and can never become actual cost. An actual cost is a new `AcquisitionCostEntry` with verifiable provenance and an explicit reconciliation link.
- Estimate activation and supersession are immutable `AcquisitionCostEstimateLifecycleEvent` rows with source-level monotonic `eventSequence/revision` and explicit `effectiveAt`; current heads are command guards only. Historical readers reconstruct state from events and never answer `asOf` from the current active head.
- Original ledger amounts are positive. Rejection and reversal are events; correction is one transaction that reverses the verified current row, creates `sourceVersion + 1` pending row, and advances `LedgerSourceHead`.
- `LedgerVerificationEvent` projection is ordered only by per-entry monotonic `eventSequence` and `revision`; `recordedAt` and event ID are evidence, never authority or a tie-breaker. The pending row is lifecycle revision 1, first decision is sequence 1/revision 2, and reversal is sequence 2/revision 3.
- `FinancialFact` is the only actual financial ledger for ROI. `AcquisitionOutcome`, `DealEvent.payment`, `MonthlySalesRecord`, and AI `FinancialValueDecision` are not financial facts.
- Stage 4 consumes actual ledger truth only through immutable, frozen `VerifiedLedgerRow` snapshots. The `ledgerType` discriminant must preserve every cost/fact classification and authority/evidence identity needed to classify revenue, COGS, refund, bad debt, bind a fact to a cohort member, and verify an attestation; generic amount-only rows are forbidden.
- A financial fact attached to acquisition must freeze a verified `CommercialBindingSnapshot`, current `DealAuthoritativeQuote`, `quoteVersionId`, and commercial amount hash. Gross profit by itself is rejected; `revenue + grossProfit` may explicitly derive COGS.
- `businessOccurredAt` is supplied business time; `recordedAt` is server time. Time-zone-less spreadsheet dates use the tenant time zone and are normalized once.
- Repositories are dedicated append-only modules with `*_MYSQL_SCHEMA_STATEMENTS` and `ensure*Schema(pool)`. Do not add them to `backend/src/mysql-store.ts` `persistAll/replaceRows`.
- In-memory and MySQL repositories run the same behavior suite; concurrency claims additionally run against two real MySQL connections.
- Keep `backend/src/acquisition-performance-query.ts`, `backend/src/acquisition-performance-router.ts`, the old OpenAPI response, and the old Pi performance tool unchanged.
- All public schemas use `additionalProperties: false`; update runtime OpenAPI, published OpenAPI, schema registry, generated frontend types, response conformance tests, and contract drift tests together.
- Do not edit `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend` in this plan.

---

### Task 1: Define ledger records, source heads, verification projection, and deterministic source identities

**Files:**
- Create: `backend/src/financial-ledger-domain.ts`
- Create: `backend/src/financial-ledger-domain-test.ts`
- Modify: `backend/src/growth-money.ts`
- Test: `backend/src/financial-ledger-domain-test.ts`

**Interfaces:**
- Consumes: `assertCurrencyCode(value: string): string`, `assertMinorAmount(value: number): number`, `decimalMajorToMinor(value: string, currency: string): number`, and `roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint` from `backend/src/growth-money.ts`.
- Produces: `LedgerType`, `AcquisitionCostEntry`, `AcquisitionCostEstimate`, `AcquisitionCostEstimateLifecycleEvent`, `FinancialFact`, `LedgerVerificationEvent`, `LedgerSourceHead`, `ledgerEntryStatus(events)`, `costSourceIdentityRoot(input)`, `financialSourceIdentityRoot(input)`, and `ledgerEntryNetMinor(entry, events)`.

- [ ] **Step 1: Write the failing domain test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  costSourceIdentityRoot,
  ledgerEntryNetMinor,
  ledgerEntryStatus,
  type AcquisitionCostEntry,
  type LedgerVerificationEvent
} from "./financial-ledger-domain.js";

const entry: AcquisitionCostEntry = {
  id: "cost-1", workspaceId: "workspace-1", platform: "douyin",
  planId: null, runId: "run-1", providerId: "baidu-ai-search",
  category: "api", amountMinor: 1234, currency: "CNY",
  occurredAt: "2026-08-09T00:00:00.000Z",
  provenance: "provider_reported", sourceRef: "invoice:88",
  evidenceHash: "sha256:evidence", externalId: "provider-row-88",
  sourceIdentityRoot: "provider-request:evidence-88", sourceVersion: 1,
  businessOccurredAt: "2026-08-09T00:00:00.000Z",
  recordedAt: "2026-08-09T00:01:00.000Z", temporalSequence: 1,
  correctsCostEntryId: null, correctionGroupId: null,
  estimateReconciliationId: null, createdBy: "finance-1"
};

const verified: LedgerVerificationEvent = {
  id: "verification-z", workspaceId: "workspace-1", ledgerType: "cost",
  ledgerEntryId: "cost-1", eventType: "verified", reversesEventId: null,
  eventSequence: 1, revision: 2,
  correctionGroupId: null, reason: "invoice checked", decidedBy: "finance-2",
  recordedAt: "2026-08-09T00:02:00.000Z", temporalSequence: 2
};

test("source identity and verification projection are deterministic", () => {
  assert.equal(costSourceIdentityRoot({ kind: "provider_request", accountingEvidenceId: "evidence-88" }), "provider-request:evidence-88");
  assert.equal(ledgerEntryStatus([]), "pending");
  assert.equal(ledgerEntryStatus([verified]), "verified");
  assert.equal(ledgerEntryNetMinor(entry, [verified]), 1234);
  assert.equal(ledgerEntryNetMinor(entry, [verified, {
    ...verified, id: "verification-a", eventType: "reversed",
    reversesEventId: verified.id, eventSequence: 2, revision: 3,
    temporalSequence: 3
  }]), 0);
});

test("legacy equal-millisecond verify and reverse still decode by eventSequence", () => {
  const reversed: LedgerVerificationEvent = {
    ...verified, id: "verification-a", eventType: "reversed",
    reversesEventId: verified.id, eventSequence: 2, revision: 3,
    recordedAt: verified.recordedAt, temporalSequence: 3
  };
  assert.equal(ledgerEntryStatus([reversed, verified]), "reversed");
});

test("a source identity rejects empty external keys", () => {
  assert.throws(
    () => costSourceIdentityRoot({ kind: "external", sourceSystem: "portal", externalId: "" }),
    /source_identity_invalid/
  );
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/financial-ledger-domain-test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `financial-ledger-domain.js`.

- [ ] **Step 3: Implement the closed ledger domain**

```ts
export type LedgerType = "cost" | "financial";
export type LedgerEntryStatus = "pending" | "verified" | "rejected" | "reversed";
export type VerifiedCostProvenance = "provider_reported" | "portal_export" | "invoice_confirmed" | "manual_verified";

export interface LedgerVerificationEvent {
  id: string; workspaceId: string; ledgerType: LedgerType; ledgerEntryId: string;
  eventType: "verified" | "rejected" | "reversed"; reversesEventId: string | null;
  eventSequence: number; revision: number;
  correctionGroupId: string | null; reason: string; decidedBy: string;
  recordedAt: string; temporalSequence: number;
}

export interface LedgerSourceHead {
  workspaceId: string; ledgerType: LedgerType; sourceIdentityRoot: string;
  currentLedgerEntryId: string; currentSourceVersion: number; revision: number;
}

export interface AcquisitionCostEntry {
  id: string; workspaceId: string; platform: string; planId: string | null;
  runId: string | null; providerId: string | null;
  category: "api" | "media" | "content" | "agency" | "operation";
  amountMinor: number; currency: string; occurredAt: string;
  provenance: VerifiedCostProvenance; sourceRef: string | null;
  evidenceHash: string; externalId: string | null; sourceIdentityRoot: string;
  sourceVersion: number; businessOccurredAt: string; recordedAt: string;
  temporalSequence: number;
  correctsCostEntryId: string | null; correctionGroupId: string | null;
  estimateReconciliationId: string | null; createdBy: string;
}

export interface AcquisitionCostEstimate {
  id: string; workspaceId: string; cohortId: string | null; planId: string | null;
  runId: string | null; amountMinor: number; currency: string;
  source: "approved_budget" | "plan_budget" | "provider_estimate" | "manual_estimate";
  sourceStableKey: string; version: number; status: "draft" | "active" | "superseded";
  sourceVersion: number; inputSnapshotHash: string; revision: number;
  validFrom: string; validTo: string; createdBy: string; createdAt: string;
  temporalSequence: number;
  activatedAt: string | null;
}

export interface AcquisitionCostEstimateLifecycleEvent {
  id: string; workspaceId: string; currency: string; sourceStableKey: string;
  estimateId: string; eventType: "activated" | "superseded";
  eventSequence: number; revision: number; effectiveAt: string;
  supersedesEstimateId: string | null; actorId: string; recordedAt: string;
  temporalSequence: number;
}

export type FinancialFactType = "contract_won" | "payment_received" | "revenue_recognized" | "cogs_recognized" | "refund" | "bad_debt_written_off";
export type FinancialFactProvenance = "portal_export" | "bank_statement" | "invoice_confirmed" | "manual_verified" | "derived_from_import";

export interface FinancialFact {
  id: string; workspaceId: string; candidateId: string | null;
  customerId: string | null; dealId: string | null; quoteVersionId: string | null;
  factType: FinancialFactType; amountMinor: number; currency: string;
  businessOccurredAt: string; recordedAt: string; temporalSequence: number;
  provenance: FinancialFactProvenance;
  sourceRef: string | null; evidenceHash: string; externalId: string | null;
  sourceIdentityRoot: string; sourceVersion: number;
  attributionSnapshot: OutcomeAttributionInput | null;
  // For acquisition-bound facts this is copied byte-for-byte from the
  // authoritative won/lost Quote event's formal-version snapshot. The current
  // binding verifier may authorize the command but may never replace this value.
  commercialBindingSnapshot: CommercialBindingSnapshot | null;
  commercialAmountHash: string | null; dealAuthorityRevision: number | null;
  correctsFactId: string | null;
  correctionGroupId: string | null; createdBy: string;
}

export function costSourceIdentityRoot(input:
  | { kind: "provider_request"; accountingEvidenceId: string }
  | { kind: "legacy_run_final"; runId: string; finalHash: string }
  | { kind: "external"; sourceSystem: string; externalId: string }
  | { kind: "import_row"; fileHash: string; sheetName: string; rowNumber: number }
): string {
  const text = (value: string) => {
    const normalized = value.trim();
    if (!normalized) throw new Error("source_identity_invalid");
    return normalized;
  };
  if (input.kind === "provider_request") return `provider-request:${text(input.accountingEvidenceId)}`;
  if (input.kind === "legacy_run_final") return `legacy-run-final:${text(input.runId)}:${text(input.finalHash)}`;
  if (input.kind === "external") return `external:${text(input.sourceSystem)}:${text(input.externalId)}`;
  if (!Number.isSafeInteger(input.rowNumber) || input.rowNumber < 1) throw new Error("source_identity_invalid");
  return `import:${text(input.fileHash)}:${text(input.sheetName)}:${input.rowNumber}`;
}

export function financialSourceIdentityRoot(input:
  | { kind: "external"; sourceSystem: string; factType: FinancialFactType; externalId: string }
  | { kind: "import_row"; fileHash: string; sheetName: string; rowNumber: number; factType: FinancialFactType }
): string {
  if (input.kind === "external") return costSourceIdentityRoot({ kind: "external", sourceSystem: `${input.sourceSystem}:${input.factType}`, externalId: input.externalId });
  return `${costSourceIdentityRoot({ kind: "import_row", fileHash: input.fileHash, sheetName: input.sheetName, rowNumber: input.rowNumber })}:${input.factType}`;
}

export function ledgerEntryStatus(events: readonly LedgerVerificationEvent[]): LedgerEntryStatus {
  const ordered = [...events].sort((a, b) => a.eventSequence - b.eventSequence);
  if (ordered.length === 0) return "pending";
  for (const [index, event] of ordered.entries()) {
    if (event.eventSequence !== index + 1 || event.revision !== index + 2) throw new Error("ledger_event_sequence_invalid");
    if (index > 0 && event.ledgerEntryId !== ordered[0]!.ledgerEntryId) throw new Error("ledger_event_sequence_invalid");
  }
  const decision = ordered[0]!;
  if (decision.eventType === "rejected") return "rejected";
  if (decision.eventType !== "verified") throw new Error("ledger_event_sequence_invalid");
  if (ordered.length === 1) return "verified";
  const reversal = ordered[1]!;
  if (ordered.length !== 2 || reversal.eventType !== "reversed" || reversal.reversesEventId !== decision.id) throw new Error("ledger_event_sequence_invalid");
  return "reversed";
}

export function ledgerEntryNetMinor(entry: { amountMinor: number }, events: readonly LedgerVerificationEvent[]) {
  return ledgerEntryStatus(events) === "verified" ? entry.amountMinor : 0;
}
```

At the top of the file import `OutcomeAttributionInput` from `acquisition-domain.ts` and `CommercialBindingSnapshot` from the stage-2 `commercial-binding-snapshot.ts`. Validate every created value with `assertCurrencyCode`, `assertMinorAmount`, positive `sourceVersion/version/revision`, and ISO timestamps. Extend the test file with executable `decimalMajorToMinor` assertions for CNY `12.34 → 1234`, JPY `12 → 12`, KWD `12.345 → 12345`, plus rejection of CNY `12.345`.

- [ ] **Step 4: Run the domain test to verify GREEN**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/financial-ledger-domain-test.ts`

Expected: PASS, including deterministic source identities, legal event projection, CNY/JPY/KWD conversion, and invalid-event rejection.

- [ ] **Step 5: Commit the domain boundary**

```bash
git add backend/src/financial-ledger-domain.ts backend/src/financial-ledger-domain-test.ts backend/src/growth-money.ts
git commit -m "feat: define append-only financial ledger domain"
```

### Task 2: Implement the shared repository contract and in-memory CostEntry lifecycle

**Files:**
- Create: `backend/src/financial-ledger-repository.ts`
- Create: `backend/src/financial-ledger-as-of-reader.ts`
- Create: `backend/src/financial-ledger-as-of-reader-test.ts`
- Create: `backend/src/acquisition-cost-ledger.ts`
- Create: `backend/src/growth-finance-test-fixtures.ts`
- Create: `backend/src/acquisition-cost-ledger-test.ts`
- Test: `backend/src/acquisition-cost-ledger-test.ts`
- Test: `backend/src/financial-ledger-as-of-reader-test.ts`

**Interfaces:**
- Consumes: `CommandContext`, the exact Foundation `GrowthFoundationServices` singleton (including its reference-stable `temporalBarrier`), free `executeGrowthIdempotentCommand`, Task 1 ledger types and `requireGrowthCapabilities(context.workspace, required[])` from stage 0.
- Consumes without redeclaration Foundation's exact `GrowthTemporalBarrier.allocateAppend(tx:GrowthTemporalTransaction,workspaceId:string):Promise<{recordedAt:string;temporalSequence:number}>`, `sealReadCutoff(context:ActiveWorkspaceContext,effectiveAsOf:string):Promise<GrowthSealedReadCutoff>`, and opaque frozen `GrowthSealedReadCutoff {workspaceId:string;effectiveAsOf:string;temporalSequence:number}`. Every checked-out Finance transaction structurally implements `lockWorkspaceTemporalBarrierForUpdate(workspaceId):Promise<{lastRecordedAt:string;temporalSequence:number}>`, `currentTimestamp3():Promise<string>`, and `saveWorkspaceTemporalBarrier(workspaceId,expectedSequence,next:{lastRecordedAt:string;temporalSequence:number}):Promise<void>`.
- Produces: `FinancialLedgerRepository`, `FinancialLedgerTransaction`, `InMemoryFinancialLedgerRepository`, `AcquisitionCostLedgerService.createPending/verify/reject/reverse/correct`, internal authoritative `VerifiedFinancialLedgerSealedReader`, boundary-only `VerifiedFinancialLedgerAsOfReader` implemented by `VerifiedFinancialLedgerAsOfBoundary`, discriminated `VerifiedLedgerRow`, `projectVerifiedCost`, `projectVerifiedFinancialFact`, and test-only `ledgerCommandContext(workspaceId, actorId, idempotencyKey?,expectedRevision?)` plus `foundationServicesFixture(overrides?)`.

```ts
export interface FinancialLedgerTransaction extends GrowthTemporalTransaction {
  getSourceHeadForUpdate(workspaceId: string, ledgerType: LedgerType, sourceIdentityRoot: string): Promise<LedgerSourceHead | null>;
  insertSourceHead(head: LedgerSourceHead): Promise<void>;
  compareAndSetSourceHead(expectedRevision: number, head: LedgerSourceHead): Promise<boolean>;
  getCostEntryForUpdate(workspaceId: string, id: string): Promise<AcquisitionCostEntry | null>;
  insertCostEntry(entry: AcquisitionCostEntry): Promise<void>;
  getFinancialFactForUpdate(workspaceId: string, id: string): Promise<FinancialFact | null>;
  insertFinancialFact(fact: FinancialFact): Promise<void>;
  listVerificationEventsForUpdate(workspaceId: string, ledgerType: LedgerType, ledgerEntryId: string): Promise<LedgerVerificationEvent[]>;
  appendVerificationEvent(event: LedgerVerificationEvent): Promise<void>;
  getCostEstimateForUpdate(workspaceId: string, id: string): Promise<AcquisitionCostEstimate | null>;
  insertCostEstimate(estimate: AcquisitionCostEstimate): Promise<void>;
  getActiveCostEstimateForUpdate(workspaceId: string, currency: string, sourceStableKey: string): Promise<AcquisitionCostEstimate | null>;
  listCostEstimateLifecycleEventsForUpdate(workspaceId: string, currency: string, sourceStableKey: string): Promise<AcquisitionCostEstimateLifecycleEvent[]>;
  appendCostEstimateLifecycleEvent(event: AcquisitionCostEstimateLifecycleEvent): Promise<void>;
  compareAndSetCostEstimateHead(input: { workspaceId: string; currency: string; sourceStableKey: string; expectedRevision: number; activeEstimateId: string | null; lastEventSequence: number }): Promise<boolean>;
}

export interface FinancialLedgerRepository {
  transaction<T>(work: (tx: FinancialLedgerTransaction) => Promise<T>): Promise<T>;
  getCostEntry(workspaceId: string, id: string): Promise<AcquisitionCostEntry | null>;
  getCostEntryBySource(workspaceId: string, sourceIdentityRoot: string): Promise<AcquisitionCostEntry | null>;
  getFinancialFact(workspaceId: string, id: string): Promise<FinancialFact | null>;
  getFinancialFactBySource(workspaceId: string, sourceIdentityRoot: string): Promise<FinancialFact | null>;
  getCostEstimate(workspaceId: string, id: string): Promise<AcquisitionCostEstimate | null>;
  listCostEstimateLifecycleEvents(workspaceId: string, currency: string, sourceStableKey: string, asOf: string): Promise<AcquisitionCostEstimateLifecycleEvent[]>;
}

export interface VerifiedLedgerSnapshotBase {
  readonly workspaceId: string; readonly entryId: string;
  readonly sourceIdentityRoot: string; readonly sourceVersion: number;
  readonly amountMinor: number; readonly netAmountMinor: number; readonly currency: string;
  readonly businessOccurredAt: string; readonly entryRecordedAt: string;
  readonly entryTemporalSequence: number;
  readonly sourceRef: string | null; readonly externalId: string | null;
  readonly correctionGroupId: string | null; readonly createdBy: string;
  readonly verificationEventId: string; readonly verificationRevision: number;
  readonly verificationRecordedAt: string; readonly verificationTemporalSequence: number;
  readonly verificationContentHash: `sha256:${string}`;
  readonly entryContentHash: `sha256:${string}`; readonly snapshotHash: `sha256:${string}`;
}

export interface VerifiedCostLedgerRow extends VerifiedLedgerSnapshotBase {
  readonly ledgerType: "cost";
  readonly platform: string; readonly planId: string | null; readonly runId: string | null;
  readonly providerId: string | null; readonly costCategory: AcquisitionCostEntry["category"];
  readonly provenance: VerifiedCostProvenance; readonly evidenceHash: string;
  readonly correctsCostEntryId: string | null; readonly estimateReconciliationId: string | null;
}

export interface VerifiedFinancialFactLedgerRow extends VerifiedLedgerSnapshotBase {
  readonly ledgerType: "financial"; readonly factType: FinancialFactType;
  readonly candidateId: string | null; readonly customerId: string | null;
  readonly dealId: string | null; readonly quoteVersionId: string | null;
  readonly provenance: FinancialFactProvenance; readonly evidenceHash: string;
  readonly attributionSnapshotHash: `sha256:${string}` | null;
  readonly commercialBindingHash: string | null;
  readonly commercialBindingSnapshotHash: `sha256:${string}` | null;
  readonly commercialAmountHash: string | null; readonly dealAuthorityRevision: number | null;
  readonly correctsFactId: string | null;
}

export type VerifiedLedgerRow = VerifiedCostLedgerRow | VerifiedFinancialFactLedgerRow;

export interface VerifiedFinancialLedgerSealedReader {
  getVerifiedAt(cutoff: GrowthSealedReadCutoff, input: {
    ledgerType: "cost" | "financial"; entryId: string;
    currency: string;
  }): Promise<VerifiedLedgerRow | null>;
  listVerifiedCostsAt(cutoff: GrowthSealedReadCutoff, input: {
    currency: string; entryIds: readonly string[];
  }): Promise<readonly VerifiedCostLedgerRow[]>;
  listVerifiedFactsAt(cutoff: GrowthSealedReadCutoff, input: {
    currency: string; entryIds: readonly string[];
  }): Promise<readonly VerifiedFinancialFactLedgerRow[]>;
}

export interface VerifiedFinancialLedgerAsOfReader {
  getVerifiedAt(context: ActiveWorkspaceContext, input: {
    ledgerType: "cost" | "financial"; entryId: string; currency: string; asOf: string;
  }): Promise<VerifiedLedgerRow | null>;
  listVerifiedCostsAsOf(context: ActiveWorkspaceContext, input: {
    currency: string; asOf: string; entryIds: readonly string[];
  }): Promise<readonly VerifiedCostLedgerRow[]>;
  listVerifiedFactsAsOf(context: ActiveWorkspaceContext, input: {
    currency: string; asOf: string; entryIds: readonly string[];
  }): Promise<readonly VerifiedFinancialFactLedgerRow[]>;
}
```

- [ ] **Step 1: Write the failing lifecycle test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryGrowthHttpIdempotencyRepository } from "./growth-http-idempotency-repository.js";
import { InMemoryFinancialLedgerRepository } from "./financial-ledger-repository.js";
import { AcquisitionCostLedgerService } from "./acquisition-cost-ledger.js";
import { ledgerEntryStatus } from "./financial-ledger-domain.js";
import {
  financeTemporalBarrierFixture,
  foundationServicesFixture,
  ledgerCommandContext,
  twoPendingCostEntriesFixture,
  verifiedCostLedgerFixture
} from "./growth-finance-test-fixtures.js";

test("verify and correct preserve an immutable source-version chain", async () => {
  const repository = new InMemoryFinancialLedgerRepository();
  const service = new AcquisitionCostLedgerService({
    repository,
    foundation: foundationServicesFixture({
      httpIdempotency: new InMemoryGrowthHttpIdempotencyRepository()
    }),
    now: () => "2026-08-09T01:00:00.000Z",
    requestExecutionId: () => "request-ledger-1"
  });
  const context = ledgerCommandContext("workspace-a", "finance-a");
  const created = await service.createPending(context, {
    platform: "douyin", planId: null, runId: null, providerId: null,
    category: "media", amountMinor: 10000, currency: "CNY",
    businessOccurredAt: "2026-08-08T00:00:00.000Z", provenance: "portal_export",
    sourceRef: "portal://row-1", evidenceHash: "sha256:row-1", externalId: "row-1",
    sourceIdentityRoot: "external:douyin-portal:row-1", estimateReconciliationId: null
  });
  await service.verify(ledgerCommandContext("workspace-a", "finance-a", "verify-cost-1", 1), { entryId: created.entry.id, reason: "portal total reconciled" });
  await assert.rejects(() => service.correct(
    ledgerCommandContext("workspace-a", "finance-a", "correct-cost-stale", 1), {
      entryId: created.entry.id, amountMinor: 12000,
      businessOccurredAt: "2026-08-08T00:00:00.000Z",
      evidenceHash: "sha256:row-1-corrected", sourceRef: "portal://row-1-reexport",
      reason: "provider reissued report"
    }), (error: unknown) => (error as { code?: string }).code
      === "ledger_revision_conflict");
  const corrected = await service.correct(ledgerCommandContext("workspace-a", "finance-a", "correct-cost-1", 2), {
    entryId: created.entry.id, amountMinor: 12000,
    businessOccurredAt: "2026-08-08T00:00:00.000Z", evidenceHash: "sha256:row-1-corrected",
    sourceRef: "portal://row-1-reexport", reason: "provider reissued report"
  });
  assert.equal(corrected.entry.sourceVersion, 2);
  assert.equal(corrected.entry.correctsCostEntryId, created.entry.id);
  assert.equal(ledgerEntryStatus(corrected.previousEvents), "reversed");
  assert.equal(ledgerEntryStatus(corrected.events), "pending");
});

test("reverse after verification requires current revision two", async () => {
  const state = verifiedCostLedgerFixture();
  await assert.rejects(() => state.service.reverse(
    ledgerCommandContext("workspace-a", "finance-a", "reverse-cost-stale", 1),
    { entryId: state.entry.id, reason: "stale attempt" }
  ), (error: unknown) => (error as { code?: string }).code
    === "ledger_revision_conflict");
  const reversed = await state.service.reverse(
    ledgerCommandContext("workspace-a", "finance-a", "reverse-cost-current", 2),
    { entryId: state.entry.id, reason: "invoice voided" }
  );
  assert.equal(reversed.events.at(-1)?.revision, 3);
});

test("a sealed cutoff excludes a later new stream when the database clock regresses", async () => {
  const state = financeTemporalBarrierFixture({
    workspaceId: "workspace-a", databaseNow: "2026-08-09T08:30:00.000Z"
  });
  const sealed = await state.foundation.temporalBarrier.sealReadCutoff(
    state.workspace, "2026-08-09T09:00:00.000Z"
  );
  state.setDatabaseNow("2026-08-09T08:00:00.000Z");
  const created = await state.service.createPending(
    ledgerCommandContext("workspace-a", "finance-a", "new-stream-after-cutoff"),
    state.newCostInput({ sourceIdentityRoot: "external:portal:never-seen-before" })
  );
  const verified = await state.service.verify(
    ledgerCommandContext("workspace-a", "finance-a", "verify-new-stream", 1),
    { entryId: created.entry.id, reason: "checked" }
  );
  assert.equal(created.entry.recordedAt, "2026-08-09T09:00:00.001Z");
  assert.equal(created.entry.temporalSequence, sealed.temporalSequence + 1);
  assert.equal(verified.events.at(-1)?.recordedAt, "2026-08-09T09:00:00.002Z");
  assert.ok((verified.events.at(-1)?.temporalSequence ?? 0) > created.entry.temporalSequence);
  assert.deepEqual(await state.sealedReader.listVerifiedCostsAt(sealed, {
    currency: "CNY", entryIds: [created.entry.id]
  }), []);
  assert.deepEqual(await state.sealedReader.listVerifiedCostsAt(sealed, {
    currency: "CNY", entryIds: [created.entry.id]
  }), []);
  const after = await state.foundation.temporalBarrier.sealReadCutoff(
    state.workspace, "2026-08-09T09:00:00.002Z"
  );
  assert.equal((await state.sealedReader.listVerifiedCostsAt(after, {
    currency: "CNY", entryIds: [created.entry.id]
  })).length, 1);
  assert.deepEqual(state.firstBusinessLockTrace(), [
    "temporal:workspace-a", "source:cost:external:portal:never-seen-before"
  ]);
});

test("one key cannot decide two ledger path IDs", async () => {
  const state = twoPendingCostEntriesFixture(["cost-a", "cost-b"]);
  await state.service.verify(ledgerCommandContext(
    "workspace-a", "finance-a", "verify-cross-id-0001", 1,
    { method: "POST", canonicalPath: "/api/v1/acquisition/cost-entries/:id/verify",
      pathParams: { id: "cost-a" }, payload: { reason: "checked" } }
  ), { entryId: "cost-a", reason: "checked" });
  await assert.rejects(() => state.service.verify(ledgerCommandContext(
    "workspace-a", "finance-a", "verify-cross-id-0001", 1,
    { method: "POST", canonicalPath: "/api/v1/acquisition/cost-entries/:id/verify",
      pathParams: { id: "cost-b" }, payload: { reason: "checked" } }
  ), { entryId: "cost-b", reason: "checked" }),
  (error: unknown) => (error as { code?: string }).code === "idempotency_conflict");
  assert.equal(await state.status("cost-b"), "pending");
});

test("a second decision and a self-conflicting idempotency replay are rejected", async () => {
  const repository = new InMemoryFinancialLedgerRepository();
  const service = new AcquisitionCostLedgerService({
    repository,
    foundation: foundationServicesFixture({
      httpIdempotency: new InMemoryGrowthHttpIdempotencyRepository()
    })
  });
  const context = ledgerCommandContext("workspace-a", "finance-a", "idem-cost-0001");
  const first = await service.createPending(context, {
    platform: "douyin", planId: null, runId: null, providerId: null,
    category: "media", amountMinor: 100, currency: "CNY",
    businessOccurredAt: "2026-08-08T00:00:00.000Z", provenance: "manual_verified",
    sourceRef: "voucher:1", evidenceHash: "sha256:voucher-1", externalId: "voucher-1",
    sourceIdentityRoot: "external:manual:voucher-1", estimateReconciliationId: null
  });
  await assert.rejects(() => service.createPending(context, {
    platform: "douyin", planId: null, runId: null, providerId: null,
    category: "media", amountMinor: 101, currency: "CNY",
    businessOccurredAt: "2026-08-08T00:00:00.000Z", provenance: "manual_verified",
    sourceRef: "voucher:1", evidenceHash: "sha256:voucher-1", externalId: "voucher-1",
    sourceIdentityRoot: "external:manual:voucher-1", estimateReconciliationId: null
  }), /idempotency_conflict/);
  assert.equal((await repository.getCostEntry("workspace-a", first.entry.id))?.amountMinor, 100);
});
```

In `financial-ledger-as-of-reader-test.ts`, pin both discriminated projections and historical time gates:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  financialFactProjectionFixture,
  verifiedFinancialFactAsOfFixture,
  verifiedLedgerReaderBoundaryFixture,
  verifiedLedgerAsOfFixture
} from "./growth-finance-test-fixtures.js";
import { projectVerifiedFinancialFact } from "./financial-ledger-as-of-reader.js";

test("verified as-of reads require both business time and recorded verification time", async () => {
  const state = verifiedLedgerAsOfFixture();
  assert.deepEqual(await state.reader.listVerifiedCostsAsOf(state.workspace, {
    currency: "CNY", entryIds: ["cost-1"], asOf: "2026-08-09T01:00:00.000Z"
  }), []);
  state.appendVerification({ recordedAt: "2026-08-09T02:00:00.000Z" });
  assert.deepEqual(await state.reader.listVerifiedCostsAsOf(state.workspace, {
    currency: "CNY", entryIds: ["cost-1"], asOf: "2026-08-09T01:00:00.000Z"
  }), []);
  assert.equal((await state.reader.listVerifiedCostsAsOf(state.workspace, {
    currency: "CNY", entryIds: ["cost-1"], asOf: "2026-08-09T03:00:00.000Z"
  }))[0]?.netAmountMinor, 10_000);
  state.appendReversal({ recordedAt: "2026-08-09T04:00:00.000Z" });
  assert.equal((await state.reader.listVerifiedCostsAsOf(state.workspace, {
    currency: "CNY", entryIds: ["cost-1"], asOf: "2026-08-09T03:00:00.000Z"
  }))[0]?.netAmountMinor, 10_000);
});

test("financial snapshots preserve ROI classification, member binding, and attestation evidence", async () => {
  const state = verifiedFinancialFactAsOfFixture({
    factType: "refund", candidateId: "candidate-1", customerId: "customer-1",
    dealId: "deal-1", quoteVersionId: "quote-1", evidenceHash: "sha256:refund-evidence",
    commercialBindingHash: "sha256:binding-1", commercialAmountHash: "sha256:commercial-1"
  });
  const [row] = await state.reader.listVerifiedFactsAsOf(state.workspace, {
    currency: "CNY", entryIds: ["refund-1"], asOf: "2026-08-09T03:00:00.000Z"
  });
  assert.ok(row);
  assert.equal(row.ledgerType, "financial");
  if (row.ledgerType !== "financial") throw new Error("expected_financial_snapshot");
  assert.deepEqual({
    factType: row.factType, candidateId: row.candidateId, customerId: row.customerId,
    dealId: row.dealId, quoteVersionId: row.quoteVersionId,
    commercialBindingHash: row.commercialBindingHash, evidenceHash: row.evidenceHash
  }, {
    factType: "refund", candidateId: "candidate-1", customerId: "customer-1",
    dealId: "deal-1", quoteVersionId: "quote-1",
    commercialBindingHash: "sha256:binding-1", evidenceHash: "sha256:refund-evidence"
  });
  assert.match(row.commercialBindingSnapshotHash ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.match(row.attributionSnapshotHash ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.match(row.snapshotHash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(row), true);
  assert.equal(Reflect.set(row, "factType", "revenue_recognized"), false);
});

test("every ROI-relevant financial classification survives immutable projection", () => {
  const fixture = financialFactProjectionFixture();
  const factTypes = ["revenue_recognized", "cogs_recognized", "refund", "bad_debt_written_off"] as const;
  const rows = factTypes.map((factType) => projectVerifiedFinancialFact({
    ...fixture.fact, id: `fact-${factType}`, factType
  }, {
    ...fixture.verification, ledgerEntryId: `fact-${factType}`
  }));
  assert.deepEqual(rows.map((row) => row.factType), factTypes);
  assert.equal(rows.every(Object.isFrozen), true);
});

test("exact ledger lookup requires the discriminant currency workspace and as-of", async () => {
  const state = verifiedLedgerAsOfFixture({
    sameIdAcrossLedgerTypes: "entry-shared",
    verificationRecordedAt: "2026-08-09T02:00:00.000Z"
  });
  const cost = await state.reader.getVerifiedAt(state.workspace, {
    ledgerType: "cost", entryId: "entry-shared", currency: "CNY",
    asOf: "2026-08-09T03:00:00.000Z"
  });
  const fact = await state.reader.getVerifiedAt(state.workspace, {
    ledgerType: "financial", entryId: "entry-shared", currency: "CNY",
    asOf: "2026-08-09T03:00:00.000Z"
  });
  assert.equal(cost?.ledgerType, "cost");
  assert.equal(fact?.ledgerType, "financial");
  assert.equal(await state.reader.getVerifiedAt(state.workspace, {
    ledgerType: "cost", entryId: "entry-shared", currency: "USD",
    asOf: "2026-08-09T03:00:00.000Z"
  }), null);
  assert.equal(await state.reader.getVerifiedAt(state.workspace, {
    ledgerType: "cost", entryId: "entry-shared", currency: "CNY",
    asOf: "2026-08-09T01:59:59.999Z"
  }), null);
  assert.equal(await state.reader.getVerifiedAt(state.otherWorkspace, {
    ledgerType: "cost", entryId: "entry-shared", currency: "CNY",
    asOf: "2026-08-09T03:00:00.000Z"
  }), null);
});

test("public ledger boundary seals once and forwards the exact opaque token", async () => {
  const state = verifiedLedgerReaderBoundaryFixture({
    serverNow: "2026-08-09T03:00:00.000Z"
  });
  const result = await state.publicReader.getVerifiedAt(state.workspace, {
    ledgerType: "cost", entryId: "cost-1", currency: "CNY",
    asOf: "2026-08-09T03:00:00.500Z"
  });
  assert.equal(result?.entryId, "cost-1");
  assert.equal(state.sealCallCount(), 1);
  assert.equal(state.lastFoundationEffectiveAsOf(), "2026-08-09T03:00:00.000Z");
  assert.strictEqual(state.lastDelegateCutoff(), state.foundationCutoff());
  assert.equal(state.internalSealCallCount(), 0);
});

test("public ledger boundary rejects a far-future cutoff before sealing", async () => {
  const state = verifiedLedgerReaderBoundaryFixture({
    serverNow: "2026-08-09T03:00:00.000Z"
  });
  await assert.rejects(() => state.publicReader.getVerifiedAt(state.workspace, {
    ledgerType: "cost", entryId: "cost-1", currency: "CNY",
    asOf: "2026-08-09T03:00:01.001Z"
  }), (error: unknown) => (error as { code?: string }).code === "invalid_as_of");
  assert.equal(state.sealCallCount(), 0);
  assert.equal(state.delegateCallCount(), 0);
});

test("sealed ledger reader derives scope only from the token", async () => {
  const state = verifiedLedgerReaderBoundaryFixture({
    duplicateEntryInWorkspace: "workspace-b"
  });
  const cutoffA = await state.seal("workspace-a", "2026-08-09T03:00:00.000Z");
  assert.equal((await state.sealedReader.getVerifiedAt(cutoffA, {
    ledgerType: "cost", entryId: "cost-1", currency: "CNY"
  }))?.workspaceId, "workspace-a");
  await assert.rejects(() => state.sealedReader.getVerifiedAt(
    state.foundationIssuedInvalidAllToken(),
    { ledgerType: "cost", entryId: "cost-1", currency: "CNY" }
  ), /invalid_workspace/);
  assert.equal(state.internalSealCallCount(), 0);
});
```

- [ ] **Step 2: Run the lifecycle test to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-cost-ledger-test.ts src/financial-ledger-as-of-reader-test.ts`

Expected: FAIL with missing `financial-ledger-repository.js` or missing `AcquisitionCostLedgerService`.

- [ ] **Step 3: Implement the smallest legal lifecycle**

Implement `InMemoryFinancialLedgerRepository.transaction()` by cloning state, running the callback against the clone, and swapping state only on success. Implement command methods with these exact transitions:

Create the reusable test context with the real stage-0 type so every subsequent test exercises concrete workspace/capability semantics:

```ts
import type { CommandContext } from "./growth-command-context.js";
import { canonicalGrowthRequestHash } from "./growth-http-idempotency-repository.js";

export function ledgerCommandContext(
  workspaceId: string,
  actorId: string,
  idempotencyKey = `ledger-${actorId}-0001`,
  expectedRevision: number | null = null,
  request: {
    method: "POST" | "PATCH";
    canonicalPath: string;
    pathParams: Readonly<Record<string, string>>;
    payload: unknown;
  } = { method: "POST", canonicalPath: "/test/financial-ledger",
    pathParams: Object.freeze({}), payload: Object.freeze({}) }
): CommandContext {
  return {
    workspace: {
      workspaceId, kind: "team", actorId, role: "admin", teamId: workspaceId,
      capabilities: ["ledger.pending.create", "ledger.verify", "roi.close", "growth.performance.workspace.read", "pricing.sensitive.read"],
      capabilityRegistryVersion: "growth-capabilities.v1"
    },
    actorId,
    idempotencyKey,
    requestHash: canonicalGrowthRequestHash({
      method: request.method, canonicalPath: request.canonicalPath,
      pathParams: Object.fromEntries(Object.entries(request.pathParams)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
      payload: request.payload, expectedRevision
    }),
    expectedRevision
  };
}
```

```ts
async verify(context: CommandContext, input: { entryId: string; reason: string }) {
  requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
  const expectedRevision = requireExpectedRevision(context);
  const attemptedAt = this.now();
  return executeGrowthIdempotentCommand({
    repository: this.foundation.httpIdempotency,
    reservation: {
      workspaceId: context.workspace.workspaceId, actorId: context.actorId,
      method: "POST", canonicalPath: "/api/v1/acquisition/cost-entries/:id/verify",
      key: context.idempotencyKey, requestHash: context.requestHash,
      attemptedAt, leaseOwner: this.requestExecutionId(), leaseDurationMs: 30_000
    }
  }, async (resourceId, operationId) => {
    requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
    if (resourceId !== input.entryId || operationId === null) {
      throw new FinancialLedgerError("idempotency_reference_invalid", 409);
    }
    return this.projectVerification(context.workspace, resourceId, operationId);
  }, async () => this.repository.transaction(async (tx) => {
    const stamp = await this.foundation.temporalBarrier.allocateAppend(
      tx, context.workspace.workspaceId
    );
    const entry = await requiredCostEntry(tx, context.workspace.workspaceId, input.entryId);
    const events = await tx.listVerificationEventsForUpdate(
      entry.workspaceId, "cost", entry.id
    );
    if (ledgerEntryStatus(events) !== "pending") throw new FinancialLedgerError("ledger_decision_already_recorded", 409);
    if (expectedRevision !== 1) throw new FinancialLedgerError("ledger_revision_conflict", 412);
    const event = verificationEvent(entry, "verified", context.actorId, input.reason,
      stamp.recordedAt, { eventSequence: 1, revision: 2,
        temporalSequence: stamp.temporalSequence });
    await tx.appendVerificationEvent(event);
    return { resourceId: entry.id, operationId: event.id };
  }));
}
```

Every command uses the Foundation free idempotency helper exactly as shown; service constructors receive the exact `foundation` singleton, not a repository-shaped object with an invented `.execute`, clock, or barrier. Public service `list/get` and create/replay projection first require current `ledger.pending.create`; verify/reject/reverse/correct and their replay projectors require current `ledger.verify`. Router checks are defense in depth and never replace these service checks. Internal `VerifiedFinancialLedgerSealedReader` remains a separate private authority port and does not call these HTTP/service capability gates. `attemptedAt` exists only for the Foundation HTTP reservation and is never copied into a ledger entry or verification event. Reservation identity uses the canonical route and current `CommandContext`; `leaseOwner` is a fresh server request execution UUID and never actor/client input. Store/project references are exact: create uses `{resourceId:entryId,operationId:null}`; verify/reject/reverse use `{resourceId:entryId,operationId:verificationEventId}`; correction uses `{resourceId:replacementEntryId,operationId:correctionGroupId}`. `authorizeAndProject` re-runs the operation-specific current capability/workspace authorization, rejects null/mismatched IDs, loads the referenced entry/event/group under the authorized workspace, verifies their relationship, and applies current sensitive-field projection; it never trusts a cached response body.

For every write, the execute callback enters `repository.transaction`, calls `foundation.temporalBarrier.allocateAppend(tx,workspaceId)` before its first source-head/entry/event/domain lock, and retains that workspace row lock until commit. `createPending` then locks/creates `LedgerSourceHead(revision=1,currentSourceVersion=1)` and inserts the immutable row with the returned `recordedAt/temporalSequence`, or returns the same resource for a matching domain command/source. Verify/reject/reverse then lock the entry plus its complete last-event prefix via `listVerificationEventsForUpdate` and append the event using the already allocated stamp. `appendVerificationEvent` rejects anything except the exact next `(eventSequence,revision)` pair. Sequence/revision remains the reducer tie-breaker for historical/legacy equal timestamps, but every new write has a unique workspace-global temporal sequence. Pending verify/reject requires current revision 1; verified reverse/correct requires current revision 2; after reversal the immutable old entry projects revision 3 and the correction replacement begins pending at revision 1. `correct` allocates the reversal stamp first, locks `LedgerSourceHead → entry → event prefix`, validates revision, then calls `allocateAppend` a second time for the replacement row; it inserts `sourceVersion+1`, advances the head, and persists both distinct stamps/sequences atomically. A stale expected revision rolls back the barrier allocation and performs zero events, rows, or source-head writes.

`VerifiedFinancialLedgerSealedReader` is the only Finance reader permitted for ROI closure and Advisor ledger-reference verification. It requires the Foundation-created `GrowthSealedReadCutoff`, derives workspace and cutoff only from that token, never calls `sealReadCutoff`, and rejects invalid/`all` workspace tokens before repository access. It selects immutable entries with `businessOccurredAt <= cutoff.effectiveAsOf` **and** `recordedAt <= cutoff.effectiveAsOf`, reduces only verification events with `recordedAt <= cutoff.effectiveAsOf` by `(eventSequence,revision)`, and emits a row only when the resulting state is verified with nonzero net amount. A verification or reversal recorded after the sealed cutoff cannot change that result. `getVerifiedAt` first switches on the closed `ledgerType`, performs one exact token-workspace/type/entry/currency lookup, then applies the same historical reducer; cost/fact rows with the same ID cannot collide, and a wrong type/currency/token workspace returns null. List methods validate bounded ID lists and stable-sort by `(businessOccurredAt,entryId)`. No method consults mutable current source heads to reconstruct history. The standalone `VerifiedFinancialLedgerAsOfBoundary` requires current `ledger.pending.create` before sealing/reading; the sealed reader itself deliberately has no HTTP capability dependency so authorized Advisor/ROI consumers cannot be denied or broadened by the public route policy.

`VerifiedFinancialLedgerAsOfReader` is a standalone HTTP/public compatibility wrapper only. At its first line each wrapper method freezes `readStartedAt=this.now()`, calls Foundation's shared `assertGrowthAsOfNotFuture(input.asOf,readStartedAt,1_000)` to obtain the authorized/clamped `effectiveAsOf`, calls `foundation.temporalBarrier.sealReadCutoff(context,effectiveAsOf)` exactly once, removes `asOf`, and delegates with the exact returned object to the corresponding sealed-reader method; it has no repository and cannot reseal through a nested wrapper. Invalid/far-future input performs zero barrier/repository calls, while tolerated skew is clamped to `readStartedAt`. ROI/Advisor receive the sealed reader directly after their own request boundary has created one shared token for all subsystem reads. Tests inject a counting barrier and identity-checking delegate to prove validation-before-seal, one seal, strict token object identity, no internal second seal, token-workspace isolation, and stable reuse of one token across multiple Finance reads.

Projection is closed and discriminated. Import `canonicalGrowthRequestHash` from the foundation, use it for every content hash, and freeze the final flat row before returning it. The financial branch must copy classification and authority fields from the immutable fact, never reconstruct them from current Deal/Quote state:

```ts
const contentHash = (value: unknown) => canonicalGrowthRequestHash(value) as `sha256:${string}`;

function verifiedBase(entry: AcquisitionCostEntry | FinancialFact, event: LedgerVerificationEvent) {
  return {
    workspaceId: entry.workspaceId, entryId: entry.id,
    sourceIdentityRoot: entry.sourceIdentityRoot, sourceVersion: entry.sourceVersion,
    amountMinor: entry.amountMinor, netAmountMinor: entry.amountMinor, currency: entry.currency,
    businessOccurredAt: entry.businessOccurredAt, entryRecordedAt: entry.recordedAt,
    entryTemporalSequence: entry.temporalSequence,
    sourceRef: entry.sourceRef, externalId: entry.externalId,
    correctionGroupId: entry.correctionGroupId, createdBy: entry.createdBy,
    verificationEventId: event.id, verificationRevision: event.revision,
    verificationRecordedAt: event.recordedAt,
    verificationTemporalSequence: event.temporalSequence,
    verificationContentHash: contentHash(event), entryContentHash: contentHash(entry)
  } as const;
}

export function projectVerifiedFinancialFact(entry: FinancialFact, event: LedgerVerificationEvent): VerifiedFinancialFactLedgerRow {
  const draft = {
    ...verifiedBase(entry, event), ledgerType: "financial" as const,
    factType: entry.factType, candidateId: entry.candidateId, customerId: entry.customerId,
    dealId: entry.dealId, quoteVersionId: entry.quoteVersionId,
    provenance: entry.provenance, evidenceHash: entry.evidenceHash,
    attributionSnapshotHash: entry.attributionSnapshot === null ? null : contentHash(entry.attributionSnapshot),
    commercialBindingHash: entry.commercialBindingSnapshot?.bindingHash ?? null,
    commercialBindingSnapshotHash: entry.commercialBindingSnapshot === null ? null : contentHash(entry.commercialBindingSnapshot),
    commercialAmountHash: entry.commercialAmountHash,
    dealAuthorityRevision: entry.dealAuthorityRevision,
    correctsFactId: entry.correctsFactId
  } as const;
  return Object.freeze({ ...draft, snapshotHash: contentHash(draft) });
}

export function projectVerifiedCost(entry: AcquisitionCostEntry, event: LedgerVerificationEvent): VerifiedCostLedgerRow {
  const draft = {
    ...verifiedBase(entry, event), ledgerType: "cost" as const,
    platform: entry.platform, planId: entry.planId, runId: entry.runId,
    providerId: entry.providerId, costCategory: entry.category,
    provenance: entry.provenance, evidenceHash: entry.evidenceHash,
    correctsCostEntryId: entry.correctsCostEntryId,
    estimateReconciliationId: entry.estimateReconciliationId
  } as const;
  return Object.freeze({ ...draft, snapshotHash: contentHash(draft) });
}
```

The reader invokes these projectors only after `ledgerEntryStatus(eventsAsOf) === "verified"`; the sole verification decision event in that valid prefix becomes the frozen verification evidence. Stage 4 switches exhaustively on `ledgerType`, and for `financial` switches on `factType`; it may compare candidate/customer/deal/quote, binding hashes, commercial amount hash and evidence hash to frozen cohort/attestation inputs without loading mutable ledgers.

- [ ] **Step 4: Run the lifecycle test and the stage-0 idempotency tests**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-cost-ledger-test.ts src/financial-ledger-as-of-reader-test.ts src/growth-http-idempotency-repository-test.ts`

Expected: PASS with no partially committed row after an injected exception.

- [ ] **Step 5: Commit the in-memory cost ledger**

```bash
git add backend/src/financial-ledger-repository.ts backend/src/financial-ledger-as-of-reader.ts backend/src/financial-ledger-as-of-reader-test.ts backend/src/acquisition-cost-ledger.ts backend/src/growth-finance-test-fixtures.ts backend/src/acquisition-cost-ledger-test.ts
git commit -m "feat: add acquisition cost ledger lifecycle"
```

### Task 3: Add append-only MySQL ledger storage and real concurrency parity

**Files:**
- Create: `backend/src/financial-ledger-mysql-repository.ts`
- Create: `backend/src/financial-ledger-as-of-mysql-reader.ts`
- Create: `backend/src/financial-ledger-as-of-mysql-reader-test.ts`
- Create: `backend/src/growth-finance-mysql-test-support.ts`
- Create: `backend/src/growth-finance-mysql.ts`
- Create: `backend/src/growth-finance-mysql-test.ts`
- Modify: `backend/package.json`
- Test: `backend/src/growth-finance-mysql-test.ts`
- Test: `backend/src/financial-ledger-as-of-mysql-reader-test.ts`

**Interfaces:**
- Consumes: `FinancialLedgerRepository` and `FinancialLedgerTransaction extends GrowthTemporalTransaction` from Task 2, the exact Foundation `GROWTH_TEMPORAL_BARRIER_MYSQL_SCHEMA_STATEMENTS`, `ensureGrowthTemporalBarrierMysqlSchema(pool)`, and singleton `GrowthTemporalBarrier` implementation.
- Produces: `FINANCIAL_LEDGER_MYSQL_SCHEMA_STATEMENTS`, `ensureFinancialLedgerMysqlSchema(pool)`, `MysqlFinancialLedgerRepository`, internal `MysqlVerifiedFinancialLedgerSealedReader`, and `withGrowthFinanceMysqlTestDatabase(testBody)` whose fixture exposes two independently checked-out connections and the exact Foundation barrier singleton for deterministic lock/cutoff tests. Public context/as-of tests wrap it in Task 2's `VerifiedFinancialLedgerAsOfBoundary`.

- [ ] **Step 1: Write the failing two-connection MySQL test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { AcquisitionCostLedgerService } from "./acquisition-cost-ledger.js";
import { MysqlFinancialLedgerRepository } from "./financial-ledger-mysql-repository.js";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";
import {
  foundationServicesFixture,
  ledgerCommandContext
} from "./growth-finance-test-fixtures.js";

test("MySQL permits only one concurrent correction of a source head", async () => {
  await withGrowthFinanceMysqlTestDatabase(async ({ pool, idempotency }) => {
    const service = new AcquisitionCostLedgerService({
      repository: new MysqlFinancialLedgerRepository(pool),
      foundation: foundationServicesFixture({ httpIdempotency: idempotency })
    });
    const context = ledgerCommandContext("workspace-a", "finance-a");
    const created = await service.createPending(context, {
      platform: "douyin", planId: null, runId: null, providerId: null,
      category: "media", amountMinor: 100, currency: "CNY",
      businessOccurredAt: "2026-08-08T00:00:00.000Z", provenance: "portal_export",
      sourceRef: "report:a", evidenceHash: "sha256:a", externalId: "a",
      sourceIdentityRoot: "external:portal:a", estimateReconciliationId: null
    });
    await service.verify(ledgerCommandContext("workspace-a", "finance-a", "verify-cost-mysql", 1), { entryId: created.entry.id, reason: "checked" });
    const attempts = await Promise.allSettled([101, 102].map((amountMinor, index) => service.correct(
      ledgerCommandContext("workspace-a", `finance-${index}`, `correction-key-${index}`, 2),
      { entryId: created.entry.id, amountMinor, businessOccurredAt: "2026-08-08T00:00:00.000Z", evidenceHash: `sha256:${amountMinor}`, sourceRef: `report:${amountMinor}`, reason: "reissue" }
    )));
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
  });
});

test("MySQL historical verification obeys the same dual as-of gate", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const { pool, seedHistoricalLedger } = fixture;
    await seedHistoricalLedger({
      entryId: "revenue-1", businessOccurredAt: "2026-08-01T00:00:00.000Z",
      recordedAt: "2026-08-01T01:00:00.000Z", amountMinor: 1000,
      factType: "revenue_recognized", candidateId: "candidate-1", customerId: "customer-1",
      dealId: "deal-1", quoteVersionId: "quote-1",
      commercialBindingHash: "sha256:binding-1", evidenceHash: "sha256:revenue-evidence",
      verificationRecordedAt: "2026-08-10T00:00:00.000Z",
      reversalRecordedAt: "2026-08-12T00:00:00.000Z"
    });
    const sealedReader = new MysqlVerifiedFinancialLedgerSealedReader(pool);
    const reader = new VerifiedFinancialLedgerAsOfBoundary({
      temporalBarrier: fixture.foundation.temporalBarrier,
      sealedReader
    });
    assert.deepEqual(await reader.listVerifiedFactsAsOf(workspaceContext(), {
      entryIds: ["revenue-1"], currency: "CNY", asOf: "2026-08-09T23:59:59.999Z"
    }), []);
    const [verified] = await reader.listVerifiedFactsAsOf(workspaceContext(), {
      entryIds: ["revenue-1"], currency: "CNY", asOf: "2026-08-11T00:00:00.000Z"
    });
    assert.equal(verified?.netAmountMinor, 1000);
    assert.equal(verified?.ledgerType, "financial");
    assert.equal(verified?.factType, "revenue_recognized");
    assert.equal(verified?.candidateId, "candidate-1");
    assert.equal(verified?.dealId, "deal-1");
    assert.match(verified?.commercialBindingSnapshotHash ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.equal(Object.isFrozen(verified), true);
    assert.deepEqual(await reader.listVerifiedFactsAsOf(workspaceContext(), {
      entryIds: ["revenue-1"], currency: "CNY", asOf: "2026-08-13T00:00:00.000Z"
    }), []);
  });
});

test("two MySQL connections keep a sealed cutoff stable across a new stream and rolled-back clock", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const workspace = fixture.workspaceContext("workspace-cutoff");
    await fixture.setSessionTimestamp3("a", "2026-08-09T09:00:00.000Z");
    await fixture.setSessionTimestamp3("b", "2026-08-09T08:59:55.000Z");
    const effectiveCutoff = await fixture.currentTimestamp3OnConnection("a");
    const sealed = await fixture.sealReadCutoffOnConnection(
      "a", workspace, effectiveCutoff
    );
    assert.equal(sealed.effectiveAsOf, effectiveCutoff);
    assert.ok((await fixture.currentTimestamp3OnConnection("b")) < effectiveCutoff);

    const service = fixture.costLedgerOnConnection("b");
    const created = await service.createPending(
      fixture.command("workspace-cutoff", "create-after-seal"),
      fixture.newCostInput({ sourceIdentityRoot: "external:portal:new-stream" })
    );
    await service.verify(
      fixture.command("workspace-cutoff", "verify-after-seal", 1),
      { entryId: created.entry.id, reason: "checked" }
    );
    assert.ok(created.entry.recordedAt > sealed.effectiveAsOf);
    assert.ok(created.entry.temporalSequence > sealed.temporalSequence);
    assert.deepEqual(await fixture.verifiedSealedReader.listVerifiedCostsAt(sealed, {
      currency: "CNY", entryIds: [created.entry.id]
    }), []);
    assert.deepEqual(await fixture.reReadOldCutoffAfterLaterAppend(
      sealed, created.entry.id
    ), []);
    assert.deepEqual(fixture.businessLockTrace("create-after-seal").slice(0, 2), [
      "temporal:workspace-cutoff", "source:cost:external:portal:new-stream"
    ]);
  });
});
```

- [ ] **Step 2: Run the MySQL test to verify RED**

Run: `cd backend && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-finance:mysql`

Expected: FAIL because `test:growth-finance:mysql` and `MysqlFinancialLedgerRepository` do not exist.

- [ ] **Step 3: Implement schema, transactions, and the isolated MySQL harness**

Create InnoDB tables `acquisition_cost_entries`, `acquisition_cost_estimates`, `acquisition_cost_estimate_heads`, `acquisition_cost_estimate_lifecycle_events`, `financial_facts`, `ledger_verification_events`, and `ledger_source_heads`. Install Foundation's `growth_workspace_temporal_barriers` schema before these tables. Every immutable Finance append table has non-null `recorded_at/created_at DATETIME(3)` and `temporal_sequence BIGINT UNSIGNED`; heads remain operational guards rather than temporal evidence. Use `BIGINT` for minor units, `JSON` only for immutable structured snapshots, and these mandatory unique keys:

```sql
UNIQUE KEY uk_ledger_source_version
  (workspace_id, ledger_type, source_identity_root, source_version),
UNIQUE KEY uk_ledger_source_head
  (workspace_id, ledger_type, source_identity_root),
UNIQUE KEY uk_ledger_single_decision
  (workspace_id, ledger_type, ledger_entry_id, event_sequence),
UNIQUE KEY uk_ledger_entry_revision
  (workspace_id, ledger_type, ledger_entry_id, revision),
UNIQUE KEY uk_cost_estimate_version
  (workspace_id, currency, source_stable_key, version),
UNIQUE KEY uk_cost_estimate_event_sequence
  (workspace_id, currency, source_stable_key, event_sequence),
UNIQUE KEY uk_cost_estimate_event_revision
  (workspace_id, currency, source_stable_key, revision)
```

Implement `transaction()` with a checked-out connection, `beginTransaction`, `commit`, rollback on error, and release in `finally`. The transaction adapter implements the exact three Foundation `GrowthTemporalTransaction` methods: it upserts/selects `growth_workspace_temporal_barriers` with `FOR UPDATE`, obtains `CURRENT_TIMESTAMP(3)` on that same connection, and CAS-saves the expected sequence without committing. Service code calls the Foundation singleton's `allocateAppend` before any domain read carrying `FOR UPDATE`; the barrier remains locked until the outer commit. Every later `*ForUpdate` method uses `FOR UPDATE`; `listVerificationEventsForUpdate` locks the exact entry's event prefix in `(event_sequence,revision)` order. Finance has no per-stream or repository-owned time allocator. Request-entry `attemptedAt` is never a business timestamp. `compareAndSetSourceHead` and `compareAndSetCostEstimateHead` update with `WHERE revision = ?` and require `affectedRows === 1`. Estimate rows and lifecycle rows are immutable; only the operational head is CAS-updated. Parse every MySQL `BIGINT`, including `temporal_sequence`, from string and reject values outside `Number.isSafeInteger`.

`MysqlVerifiedFinancialLedgerSealedReader` has no barrier dependency and cannot seal. It accepts only the exact Foundation token, derives workspace/type/currency/business/recorded cutoffs from it and the closed query, delegates to the exact Task-2 historical projector, and never joins a mutable current status/source head. Standalone public routes construct one `VerifiedFinancialLedgerAsOfBoundary` with the same Foundation `temporalBarrier` reference as command services; that boundary seals exactly once and passes the exact token object into the MySQL sealed reader. The two-connection fixture must prove: connection A seals `T` while the workspace has no target ledger stream; connection B's `CURRENT_TIMESTAMP(3)` is lower than `T`; B creates and verifies that new stream with stamps/sequences strictly after `T`; repeated reads using the original token on A remain byte-identical and exclude it. Instrumented memory and MySQL transaction adapters assert the first two business locks are `temporal:<workspace>` then the relevant source/entry domain guard.

The test harness must create `goodjob_growth_finance_<pid>_<random>` through mandatory `MYSQL_TEST_ADMIN_URL`, create a pool with `connectionLimit: 4`, reserve two independently checked-out connections for temporal/settings competition tests, run stage-0 idempotency, Foundation temporal-barrier and append-only workspace-settings schemas, plus ledger/import schemas, and always release both connections and drop the database in `finally`. Missing `MYSQL_TEST_ADMIN_URL` fails this explicit suite rather than silently skipping it.

Add this non-default test script so ordinary `test:acquisition` never requires MySQL:

```json
{
  "scripts": {
    "test:growth-finance:mysql": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/growth-finance-mysql-test.ts src/financial-ledger-as-of-mysql-reader-test.ts"
  }
}
```

- [ ] **Step 4: Verify MySQL and in-memory behavioral parity**

Run: `cd backend && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-finance:mysql && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-cost-ledger-test.ts`

Expected: PASS; one concurrent correction wins, the loser returns revision conflict, no duplicate version 2 exists, every write locks the workspace barrier first, and a later new-stream append under a DB clock behind sealed `T` remains invisible at `T`.

- [ ] **Step 5: Commit the MySQL ledger**

```bash
git add backend/src/financial-ledger-mysql-repository.ts backend/src/financial-ledger-as-of-mysql-reader.ts backend/src/financial-ledger-as-of-mysql-reader-test.ts backend/src/growth-finance-mysql-test-support.ts backend/src/growth-finance-mysql.ts backend/src/growth-finance-mysql-test.ts backend/package.json
git commit -m "feat: persist financial ledgers in mysql"
```

### Task 4: Implement versioned estimates and provider-request evidence projection

**Files:**
- Create: `backend/src/acquisition-cost-estimate-service.ts`
- Create: `backend/src/acquisition-cost-evidence-source.ts`
- Create: `backend/src/acquisition-cost-evidence-projection.ts`
- Create: `backend/src/acquisition-cost-estimate-as-of-reader.ts`
- Create: `backend/src/acquisition-cost-estimate-service-test.ts`
- Create: `backend/src/acquisition-cost-evidence-projection-test.ts`
- Create: `backend/src/acquisition-cost-estimate-as-of-reader-test.ts`
- Modify: `backend/src/financial-ledger-mysql-repository.ts`
- Test: `backend/src/acquisition-cost-estimate-service-test.ts`
- Test: `backend/src/acquisition-cost-evidence-projection-test.ts`
- Test: `backend/src/acquisition-cost-estimate-as-of-reader-test.ts`

**Interfaces:**
- Consumes: Task 2 repository, the exact Foundation `GrowthFoundationServices.temporalBarrier`, `decimalMajorToMinor`, current capability authorization, and existing provider accounting evidence tables.
- Produces: `AcquisitionCostEstimateService.createDraft/activate/supersede`, each requiring current `ledger.pending.create` in the service and replay projector; internal `AcquisitionCostEstimateSealedReader.getActiveAt`; boundary-only `AcquisitionCostEstimateAsOfReader.getActiveAsOf`, whose standalone public/HTTP use requires current `ledger.pending.create`; `ProviderRequestAccountingEvidenceSource.listAfter`; and `AcquisitionCostEvidenceProjector.projectAfter`, whose generated command passes through the same create service authorization. Private ROI/Advisor sealed reads do not inherit the HTTP capability gate.

```ts
export interface ProviderRequestAccountingEvidenceRow {
  id: string; workspaceId: string; ledgerId: string; runId: string;
  providerId: string; provenance: "provider_reported" | "unknown" | "estimated";
  costAmountMajor: string; currency: string; evidenceHash: string; recordedAt: string;
}

export interface ProviderRequestAccountingEvidenceSource {
  listAfter(workspaceId: string, checkpoint: { recordedAt: string; id: string } | null, limit: number): Promise<ProviderRequestAccountingEvidenceRow[]>;
}

export interface AcquisitionCostEstimateAsOfReader {
  getActiveAsOf(workspace: ActiveWorkspaceContext, input: { currency: string; sourceStableKey: string; asOf: string }): Promise<AcquisitionCostEstimate | null>;
}
export interface AcquisitionCostEstimateSealedReader {
  getActiveAt(cutoff: GrowthSealedReadCutoff, input: {
    currency: string; sourceStableKey: string;
  }): Promise<AcquisitionCostEstimate | null>;
}
```

- [ ] **Step 1: Write failing estimate and projection tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { AcquisitionCostEvidenceProjector } from "./acquisition-cost-evidence-projection.js";
import { activeCostEstimateIdAsOf } from "./acquisition-cost-estimate-as-of-reader.js";
import type { AcquisitionCostEstimateLifecycleEvent } from "./financial-ledger-domain.js";
import { InMemoryFinancialLedgerRepository } from "./financial-ledger-repository.js";

test("provider_reported becomes pending actual while estimated remains estimate-only", async () => {
  const repository = new InMemoryFinancialLedgerRepository();
  const projector = new AcquisitionCostEvidenceProjector({
    repository,
    source: { async listAfter() { return [
      { id: "ev-1", workspaceId: "workspace-a", ledgerId: "ledger-1", runId: "run-1", providerId: "baidu", provenance: "provider_reported", costAmountMajor: "1.23", currency: "CNY", evidenceHash: "sha256:1", recordedAt: "2026-08-09T00:00:00.000Z" },
      { id: "ev-2", workspaceId: "workspace-a", ledgerId: "ledger-2", runId: "run-1", providerId: "baidu", provenance: "estimated", costAmountMajor: "2.34", currency: "CNY", evidenceHash: "sha256:2", recordedAt: "2026-08-09T00:00:01.000Z" }
    ]; } }
  });
  const result = await projector.projectAfter("workspace-a", null, 100);
  assert.deepEqual(result, { projectedCostEntries: 1, projectedEstimates: 1, nextCheckpoint: { recordedAt: "2026-08-09T00:00:01.000Z", id: "ev-2" } });
  assert.equal((await repository.getCostEntryBySource("workspace-a", "provider-request:ev-1"))?.amountMinor, 123);
  assert.equal(await repository.getCostEntryBySource("workspace-a", "provider-request:ev-2"), null);
});

test("supersede and activate use successive persisted ticks and preserve the old cutoff", async () => {
  const events: AcquisitionCostEstimateLifecycleEvent[] = [
    { id: "event-1", workspaceId: "workspace-a", currency: "CNY", sourceStableKey: "plan:1", estimateId: "estimate-v1", eventType: "activated", eventSequence: 1, revision: 1, effectiveAt: "2026-08-01T00:00:00.000Z", supersedesEstimateId: null, actorId: "finance-a", recordedAt: "2026-08-01T00:00:00.000Z", temporalSequence: 1 },
    { id: "event-z", workspaceId: "workspace-a", currency: "CNY", sourceStableKey: "plan:1", estimateId: "estimate-v1", eventType: "superseded", eventSequence: 2, revision: 2, effectiveAt: "2026-08-09T00:00:00.000Z", supersedesEstimateId: null, actorId: "finance-a", recordedAt: "2026-08-09T00:00:00.000Z", temporalSequence: 2 },
    { id: "event-a", workspaceId: "workspace-a", currency: "CNY", sourceStableKey: "plan:1", estimateId: "estimate-v2", eventType: "activated", eventSequence: 3, revision: 3, effectiveAt: "2026-08-09T00:00:00.000Z", supersedesEstimateId: "estimate-v1", actorId: "finance-a", recordedAt: "2026-08-09T00:00:00.001Z", temporalSequence: 3 }
  ];
  assert.equal(activeCostEstimateIdAsOf(events, "2026-08-08T23:59:59.999Z"), "estimate-v1");
  assert.equal(activeCostEstimateIdAsOf(events, "2026-08-09T00:00:00.000Z"), null);
  assert.equal(activeCostEstimateIdAsOf(events, "2026-08-09T00:00:00.001Z"), "estimate-v2");
});
```

- [ ] **Step 2: Run the projection tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-cost-estimate-service-test.ts src/acquisition-cost-evidence-projection-test.ts src/acquisition-cost-estimate-as-of-reader-test.ts`

Expected: FAIL with missing projector and estimate service exports.

- [ ] **Step 3: Implement explicit source classification and estimate CAS**

Use `sourceStableKey = provider-request:<evidenceId>` for both provider-reported and estimated rows. Convert the raw decimal string through `decimalMajorToMinor`. `provider_reported` calls the same pending actual insertion primitive as Task 2; `unknown | estimated` creates a draft estimate and activates it. Projection persistence includes a `(workspace_id, source_kind, source_id)` checkpoint identity so replay is idempotent.

Draft creation and every activation/supersession transaction call `foundation.temporalBarrier.allocateAppend(tx,workspaceId)` before locking `(workspaceId,currency,sourceStableKey)`, so the workspace barrier is the first business lock and remains held to commit. Activation then locks the source head/event prefix, appends `superseded` for the previous active version and `activated` for the new version with exact next source-level `eventSequence/revision`, CASes the operational head, requires `If-Match`, and makes exactly one new active projection. Both lifecycle events may share business `effectiveAt`, but they receive successive barrier allocations and persist distinct workspace-global `recordedAt/temporalSequence`; a newly created draft row receives its own earlier/later allocation rather than sharing an event stamp. Sequence remains authoritative only for legacy equal-time decoding. Directly reject `sourceStableKey` collisions where plan/manual/provider labels describe the same economic cost but use different stable keys.

```ts
if (row.provenance === "provider_reported") {
  await this.costs.createProjectedPending(row, {
    sourceIdentityRoot: `provider-request:${row.id}`,
    amountMinor: decimalMajorToMinor(row.costAmountMajor, row.currency)
  });
  projectedCostEntries += 1;
} else {
  await this.estimates.createAndActivateProjected(row, {
    sourceStableKey: `provider-request:${row.id}`,
    amountMinor: decimalMajorToMinor(row.costAmountMajor, row.currency),
    source: "provider_estimate"
  });
  projectedEstimates += 1;
}
```

```ts
export function activeCostEstimateIdAsOf(events: readonly AcquisitionCostEstimateLifecycleEvent[], asOf: string): string | null {
  const recorded = events.filter((event) => event.recordedAt <= asOf).sort((a, b) => a.eventSequence - b.eventSequence);
  for (const [index, event] of recorded.entries()) {
    if (event.eventSequence !== index + 1 || event.revision !== index + 1) throw new Error("cost_estimate_history_invalid");
  }
  let activeEstimateId: string | null = null;
  for (const event of recorded.filter((event) => event.effectiveAt <= asOf).sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : a.effectiveAt > b.effectiveAt ? 1 : 0) || a.eventSequence - b.eventSequence)) {
    if (event.eventType === "superseded" && activeEstimateId !== event.estimateId) throw new Error("cost_estimate_history_invalid");
    activeEstimateId = event.eventType === "activated" ? event.estimateId : null;
  }
  return activeEstimateId;
}

export async function getActiveEstimateAt(
  repository: FinancialLedgerRepository,
  cutoff: GrowthSealedReadCutoff,
  input: { currency: string; sourceStableKey: string }
) {
  if (cutoff.workspaceId === "all" || cutoff.workspaceId.trim() === "") {
    throw new FinancialLedgerError("invalid_workspace", 403);
  }
  const events = await repository.listCostEstimateLifecycleEvents(
    cutoff.workspaceId, input.currency, input.sourceStableKey, cutoff.effectiveAsOf
  );
  const activeEstimateId = activeCostEstimateIdAsOf(events, cutoff.effectiveAsOf);
  return activeEstimateId === null ? null
    : repository.getCostEstimate(cutoff.workspaceId, activeEstimateId);
}
```

`AcquisitionCostEstimateAsOfReader` is a thin standalone public boundary: before exposing data it requires current `ledger.pending.create`, freezes `readStartedAt=this.now()`, derives the authorized/clamped `effectiveAsOf` with Foundation's `assertGrowthAsOfNotFuture(input.asOf,readStartedAt,1_000)`, seals that effective cutoff exactly once, strips `asOf`, and forwards the exact token to `AcquisitionCostEstimateSealedReader.getActiveAt`. Capability or invalid/far-future failure calls neither barrier nor repository. Internal ROI/Advisor work accepts only the sealed reader after its own scope authorization and reuses its request-wide token; neither the sealed reader nor the repository can call the barrier or HTTP capability gate.

- [ ] **Step 4: Verify estimate concurrency and projection idempotency**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-cost-estimate-service-test.ts src/acquisition-cost-evidence-projection-test.ts src/acquisition-cost-estimate-as-of-reader-test.ts && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-finance:mysql`

Expected: PASS; repeat projection creates no duplicate economic cost, two concurrent activations produce one active estimate, successive recorded ticks preserve the old `asOf`, and historical reduction follows sequence/revision.

- [ ] **Step 5: Commit estimates and provider projection**

```bash
git add backend/src/acquisition-cost-estimate-service.ts backend/src/acquisition-cost-evidence-source.ts backend/src/acquisition-cost-evidence-projection.ts backend/src/acquisition-cost-estimate-as-of-reader.ts backend/src/acquisition-cost-estimate-service-test.ts backend/src/acquisition-cost-evidence-projection-test.ts backend/src/acquisition-cost-estimate-as-of-reader-test.ts backend/src/financial-ledger-mysql-repository.ts
git commit -m "feat: project request evidence into cost ledgers"
```

### Task 5: Reuse authoritative commercial binding verification and implement FinancialFact lifecycle

**Files:**
- Create: `backend/src/financial-fact-ledger.ts`
- Create: `backend/src/financial-fact-ledger-test.ts`
- Modify: `backend/src/acquisition-crm-outcome-reconciliation.ts`
- Modify: `backend/src/acquisition-crm-outcome-reconciliation-test.ts`
- Modify: `backend/src/growth-finance-test-fixtures.ts`
- Test: `backend/src/financial-fact-ledger-test.ts`

**Interfaces:**
- Consumes: stage-2 `CommercialBindingVerifier.verify` only for current command authorization, frozen `CommercialBindingSnapshot`/`CommercialBindingEvidenceSnapshot`, Quote's sealed `DealAuthoritativeQuoteReader.getDecisionAt(context:ActiveWorkspaceContext,dealId:string,cutoff:GrowthSealedReadCutoff)` whose `AuthoritativeDealDecisionRef` carries both binding forms copied from the formal QuoteVersion, Task 2 ledger repository, Foundation-owned `safeMinor`, the exact Foundation services singleton including the same `temporalBarrier`, and free `executeGrowthIdempotentCommand`; all state changes reuse the Task-2 reservation/current-authorization/reference-projection boundary.
- Produces: `FinancialFactLedgerService.createPending/verify/reject/reverse/correct`, internal `FinancialFactLedgerAuthorityCommands`, and the one exported `deriveRevenueAndCogs`; it does not create a second binding verifier or money-range helper.
- `CreateFinancialFactInput` accepts candidate/customer/deal identity and source/accounting fields only; `quoteVersionId`, `commercialAmountHash`, `commercialBindingSnapshot`, `commercialBindingEvidence`, attribution snapshot, actor and workspace are server-derived authoritative fields and are rejected as extra request properties. For an acquisition-bound fact, `commercialBindingSnapshot` is always copied from `decision.commercialBindingSnapshot`; it is never the object returned by the current verifier.

```ts
export interface FinancialFactLedgerCommands {
  createPending(context: CommandContext, input: CreateFinancialFactInput): Promise<{ fact: FinancialFact; replayed: boolean }>;
  verify(context: CommandContext, input: { factId: string; reason: string }): Promise<FinancialFact>;
  reject(context: CommandContext, input: { factId: string; reason: string }): Promise<FinancialFact>;
  reverse(context: CommandContext, input: { factId: string; reason: string }): Promise<FinancialFact>;
  correct(context: CommandContext, input: { factId: string; replacement: CreateFinancialFactInput; reason: string }): Promise<{ reversed: FinancialFact; replacement: FinancialFact }>;
  get(workspace: ActiveWorkspaceContext, factId: string): Promise<FinancialFact | null>;
}
export interface FinancialFactLedgerAuthorityCommands {
  createPendingAt(context: CommandContext, cutoff: GrowthSealedReadCutoff,
    input: CreateFinancialFactInput): Promise<{ fact: FinancialFact; replayed: boolean }>;
  correctAt(context: CommandContext, cutoff: GrowthSealedReadCutoff,
    input: { factId: string; replacement: CreateFinancialFactInput; reason: string }
  ): Promise<{ reversed: FinancialFact; replacement: FinancialFact }>;
}
```

Import `CommercialBindingVerifier`, `CommercialBindingEvidenceSnapshot`, and `AuthoritativeDealDecisionRef` rather than redeclaring them. The verifier's `verify` method is a read-only **current-authorization** lookup and therefore accepts `ActiveWorkspaceContext`; its returned snapshot must have the exact input candidate/customer/deal IDs and its canonical seven evidence fields must equal `decision.commercialBindingEvidence`. It is discarded after that comparison. The fact persists the immutable `decision.commercialBindingSnapshot` copied from the formal QuoteVersion, and first proves its own canonical evidence projection equals `decision.commercialBindingEvidence`; no code may merge or rebuild it from current Handoff/Customer/Deal rows. Every FinancialFact state-changing command above accepts `CommandContext` so idempotency, request hash, actor, and `If-Match` revision cannot be bypassed.

- [ ] **Step 1: Write failing binding and fact tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  FinancialFactLedgerService,
  deriveRevenueAndCogs
} from "./financial-fact-ledger.js";
import { InMemoryFinancialLedgerRepository } from "./financial-ledger-repository.js";
import {
  financialFactFixture,
  foundationServicesFixture,
  ledgerCommandContext
} from "./growth-finance-test-fixtures.js";

test("an acquisition revenue fact freezes the authoritative commercial binding", async () => {
  const formalBindingSnapshot = {
    candidateId: "candidate-1", handoffId: "handoff-formal", leadId: "lead-formal",
    customerId: "customer-1", dealId: "deal-1", candidateVersion: 2,
    handoffContentHash: "sha256:h", dealContentHash: "sha256:d",
    bindingHashSchemaVersion: "commercial-binding.v1",
    attributionSnapshot: { attributionVersion: "acquisition-run.v1", runId: "run-formal" },
    bindingHash: "sha256:b", verifiedAt: "2026-08-08T02:00:00.000Z"
  };
  const binding = {
    async verify() { return {
      candidateId: "candidate-1", handoffId: "handoff-1", leadId: "lead-1",
      customerId: "customer-1", dealId: "deal-1", candidateVersion: 3,
      handoffContentHash: "sha256:h", dealContentHash: "sha256:d",
      bindingHashSchemaVersion: "commercial-binding.v1",
      attributionSnapshot: { attributionVersion: "acquisition-run.v1", runId: "run-1" },
      bindingHash: "sha256:b", verifiedAt: "2026-08-09T02:00:00.000Z"
    }; }
  };
  const dealQuoteReader = {
    async getDecisionAt() { return {
      type: "won", dealId: "deal-1", quoteCaseId: "case-1",
      quoteVersionId: "quote-1", commercialAmountHash: "sha256:commercial-1",
      currency: "CNY", quotedAmountMinor: 298000,
      commercialBindingEvidence: {
        candidateId: "candidate-1", customerId: "customer-1", dealId: "deal-1",
        handoffContentHash: "sha256:h", dealContentHash: "sha256:d",
        bindingHashSchemaVersion: "commercial-binding.v1", bindingHash: "sha256:b"
      },
      commercialBindingSnapshot: formalBindingSnapshot,
      authorityRevision: 3, decidedAt: "2026-08-08T00:00:00.000Z"
    }; }
  };
  const repository = new InMemoryFinancialLedgerRepository();
  const service = new FinancialFactLedgerService({
    repository, bindingVerifier: binding, dealQuoteReader,
    foundation: foundationServicesFixture()
  });
  const result = await service.createPending(ledgerCommandContext("workspace-a", "finance-a"), {
    candidateId: "candidate-1", customerId: "customer-1", dealId: "deal-1",
    factType: "revenue_recognized",
    amountMinor: 50000, currency: "CNY", businessOccurredAt: "2026-08-08T00:00:00.000Z",
    provenance: "invoice_confirmed", sourceRef: "invoice:1", evidenceHash: "sha256:invoice-1",
    externalId: "invoice-1", sourceIdentityRoot: "external:invoice:invoice-1"
  });
  assert.deepEqual(result.fact.commercialBindingSnapshot, formalBindingSnapshot);
  assert.notEqual(result.fact.commercialBindingSnapshot.verifiedAt,
    (await binding.verify()).verifiedAt);
  assert.equal(result.fact.quoteVersionId, "quote-1");
  assert.equal(result.fact.commercialAmountHash, "sha256:commercial-1");
  assert.equal(repository.countFinancialFacts(), 1);
});

test("contract_won amount and currency must equal the frozen won QuoteVersion", async () => {
  const state = financialFactFixture({
    dealDecision: {
      type: "won", dealId: "deal-1", quoteCaseId: "case-1",
      quoteVersionId: "quote-1", quotedAmountMinor: 298000, currency: "CNY",
      commercialAmountHash: "sha256:commercial-1", authorityRevision: 3,
      commercialBindingEvidence: {
        candidateId: "candidate-1", customerId: "customer-1", dealId: "deal-1",
        handoffContentHash: "sha256:h", dealContentHash: "sha256:d",
        bindingHashSchemaVersion: "commercial-binding.v1", bindingHash: "sha256:b"
      },
      commercialBindingSnapshot: {
        candidateId: "candidate-1", handoffId: "handoff-1", leadId: "lead-1",
        customerId: "customer-1", dealId: "deal-1", candidateVersion: 3,
        handoffContentHash: "sha256:h", dealContentHash: "sha256:d",
        bindingHashSchemaVersion: "commercial-binding.v1",
        attributionSnapshot: { attributionVersion: "acquisition-run.v1", runId: "run-1" },
        bindingHash: "sha256:b", verifiedAt: "2026-08-08T02:00:00.000Z"
      },
      decidedAt: "2026-08-08T00:00:00.000Z"
    }
  });
  await assert.rejects(() => state.service.createPending(state.command, {
    ...state.input, factType: "contract_won", amountMinor: 1, currency: "CNY"
  }), (error: unknown) => (error as { code?: string }).code
    === "financial_fact_conflict");
  await assert.rejects(() => state.service.createPending(state.commandWith({
    idempotencyKey: "contract-won-wrong-currency"
  }), {
    ...state.input, factType: "contract_won", amountMinor: 298000, currency: "USD"
  }), (error: unknown) => (error as { code?: string }).code
    === "financial_fact_conflict");
  assert.equal(state.repository.countFinancialFacts(), 0);
  const accepted = await state.service.createPending(state.commandWith({
    idempotencyKey: "contract-won-exact"
  }), {
    ...state.input, factType: "contract_won", amountMinor: 298000, currency: "CNY"
  });
  assert.equal(accepted.fact.amountMinor, 298000);
  assert.equal(accepted.fact.quoteVersionId, "quote-1");
  await state.service.verify(state.commandWith({
    idempotencyKey: "contract-won-verify", expectedRevision: 1
  }), { factId: accepted.fact.id, reason: "matched signed contract" });
  const beforeCorrection = state.repository.snapshotCounts();
  await assert.rejects(() => state.service.correct(state.commandWith({
    idempotencyKey: "contract-won-correct-wrong-amount", expectedRevision: 2
  }), {
    factId: accepted.fact.id,
    replacement: { ...state.input, factType: "contract_won",
      amountMinor: 297999, currency: "CNY" }, reason: "attempted change"
  }), (error: unknown) => (error as { code?: string }).code
    === "financial_fact_conflict");
  await assert.rejects(() => state.service.correct(state.commandWith({
    idempotencyKey: "contract-won-correct-wrong-currency", expectedRevision: 2
  }), {
    factId: accepted.fact.id,
    replacement: { ...state.input, factType: "contract_won",
      amountMinor: 298000, currency: "USD" }, reason: "attempted change"
  }), (error: unknown) => (error as { code?: string }).code
    === "financial_fact_conflict");
  assert.deepEqual(state.repository.snapshotCounts(), beforeCorrection);
  assert.equal((await state.service.get(state.workspace, accepted.fact.id))?.status,
    "verified");
});

test("current rebinding cannot rewrite the formal quote binding on create or correction", async () => {
  const state = financialFactFixture({ factType: "contract_won" });
  const accepted = await state.service.createPending(state.commandWith({
    idempotencyKey: "frozen-binding-original-create"
  }), state.input);
  await state.service.verify(state.commandWith({
    idempotencyKey: "frozen-binding-original-verify", expectedRevision: 1
  }), { factId: accepted.fact.id, reason: "matched formal binding" });
  const frozen = accepted.fact.commercialBindingSnapshot;
  const beforeRebind = state.repository.snapshotCounts();
  state.replaceCurrentBinding({
    candidateId: "candidate-rebound", customerId: "customer-rebound",
    dealId: "deal-1", handoffContentHash: "sha256:rebound-handoff",
    bindingHash: "sha256:rebound-binding"
  });
  await assert.rejects(() => state.service.createPending(state.commandWith({
    idempotencyKey: "frozen-binding-rebound-create"
  }), { ...state.input, externalId: "after-rebind",
    sourceIdentityRoot: "external:invoice:after-rebind" }),
  (error: unknown) => (error as { code?: string }).code
    === "financial_fact_conflict");
  await assert.rejects(() => state.service.correct(state.commandWith({
    idempotencyKey: "frozen-binding-rebound-correct", expectedRevision: 2
  }), { factId: accepted.fact.id, replacement: state.input,
    reason: "must not reattribute" }),
  (error: unknown) => (error as { code?: string }).code
    === "financial_fact_conflict");
  assert.deepEqual(state.repository.snapshotCounts(), beforeRebind);
  assert.deepEqual((await state.service.get(state.workspace, accepted.fact.id))
    ?.commercialBindingSnapshot, frozen);
  assert.equal(frozen?.candidateId, "candidate-1");
});

test("acquisition-bound fact command seals once and forwards the exact token", async () => {
  const state = financialFactFixture({ factType: "contract_won" });
  await state.service.createPending(state.command, state.input);
  assert.equal(state.foundationSealCallCount(), 1);
  assert.strictEqual(state.quoteReaderCutoffs()[0], state.lastFoundationCutoff());
  assert.equal(state.quoteReaderSealCallCount(), 0);
  assert.equal(state.internalCreateAtSealCallCount(), 0);
});

test("missing won authority or client-supplied quote fields creates zero facts", async () => {
  const fixture = financialFactFixture({ dealDecision: null });
  await assert.rejects(() => fixture.service.createPending(fixture.command, fixture.input), /authoritative_won_quote_required/);
  assert.equal(fixture.repository.countFinancialFacts(), 0);
  assert.throws(() => fixture.parseCreateBody({ ...fixture.input, quoteVersionId: "quote-client", commercialAmountHash: "sha256:client" }), /additionalProperties/);
  assert.equal(fixture.repository.countFinancialFacts(), 0);
});

test("revenue and signed gross profit derive COGS only through bigint", () => {
  assert.throws(() => deriveRevenueAndCogs({
    revenueMinor: null, grossProfitMinor: 100
  }), /revenue_required_for_gross_profit/);
  assert.deepEqual(deriveRevenueAndCogs({
    revenueMinor: 1000, grossProfitMinor: 400
  }), { revenueMinor: 1000, cogsMinor: 600 });
  assert.deepEqual(deriveRevenueAndCogs({
    revenueMinor: 1000, grossProfitMinor: -400
  }), { revenueMinor: 1000, cogsMinor: 1400 });
  assert.throws(() => deriveRevenueAndCogs({
    revenueMinor: 1000, grossProfitMinor: 1001
  }), (error: unknown) => (error as { code?: string }).code
    === "financial_fact_amount_invalid");
});

test("COGS derivation enforces signed and unsigned safe-integer boundaries", () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(deriveRevenueAndCogs({
    revenueMinor: max, grossProfitMinor: 0
  }), { revenueMinor: max, cogsMinor: max });
  assert.deepEqual(deriveRevenueAndCogs({
    revenueMinor: 0, grossProfitMinor: -max
  }), { revenueMinor: 0, cogsMinor: max });
  assert.throws(() => deriveRevenueAndCogs({
    revenueMinor: max, grossProfitMinor: -1
  }), (error: unknown) => (error as { code?: string }).code
    === "amount_out_of_range");
  assert.throws(() => deriveRevenueAndCogs({
    revenueMinor: 0, grossProfitMinor: max
  }), (error: unknown) => (error as { code?: string }).code
    === "financial_fact_amount_invalid");
  assert.throws(() => deriveRevenueAndCogs({
    revenueMinor: -1, grossProfitMinor: 0
  }), /financial_fact_amount_invalid/);
  assert.throws(() => deriveRevenueAndCogs({
    revenueMinor: max + 1, grossProfitMinor: 0
  }), /amount_out_of_range/);
});

test("verified financial fact correction and reversal require current revision two", async () => {
  const correction = financialFactFixture({ status: "verified", revision: 2 });
  await assert.rejects(() => correction.service.correct(
    correction.commandWith({ expectedRevision: 1, idempotencyKey: "fact-correct-stale" }),
    { factId: correction.fact.id, replacement: correction.replacement,
      reason: "bank correction" }
  ), (error: unknown) => (error as { code?: string }).code
    === "ledger_revision_conflict");
  const fixed = await correction.service.correct(
    correction.commandWith({ expectedRevision: 2, idempotencyKey: "fact-correct-current" }),
    { factId: correction.fact.id, replacement: correction.replacement,
      reason: "bank correction" }
  );
  assert.equal(fixed.replacement.sourceVersion, 2);

  const reversal = financialFactFixture({ status: "verified", revision: 2 });
  await assert.rejects(() => reversal.service.reverse(
    reversal.commandWith({ expectedRevision: 1, idempotencyKey: "fact-reverse-stale" }),
    { factId: reversal.fact.id, reason: "voided" }
  ), (error: unknown) => (error as { code?: string }).code
    === "ledger_revision_conflict");
  const reversed = await reversal.service.reverse(
    reversal.commandWith({ expectedRevision: 2, idempotencyKey: "fact-reverse-current" }),
    { factId: reversal.fact.id, reason: "voided" }
  );
  assert.equal(reversed.revision, 3);
});
```

- [ ] **Step 2: Run the financial fact tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/financial-fact-ledger-test.ts`

Expected: FAIL because the financial fact service module is absent.

- [ ] **Step 3: Implement one binding verifier and reuse it in reconciliation**

Inject the stage-2 verifier and Quote's sealed `DealAuthoritativeQuoteReader`; do not copy their hash, relationship, authority-reduction, or temporal-cutoff rules. Public `createPending/correct` are request boundaries: each acquisition-bound call freezes the server `commandStartedAt` before dependency reads, uses that trusted instant as `effectiveAuthorityAsOf`, calls `foundation.temporalBarrier.sealReadCutoff(context.workspace,effectiveAuthorityAsOf)` exactly once, and delegates to `createPendingAt/correctAt` with that exact `GrowthSealedReadCutoff`. No client/model/import field can supply or advance this authority time. The internal `*At` methods verify `cutoff.workspaceId===context.workspace.workspaceId`, pass the same token to every Quote authority lookup, and never seal. Finance import preview/commit, ROI, and Advisor already own a request token and invoke only these internal token methods. The Quote reader consumes the token and must not seal again. Require the authoritative decision type `won`; verify that its complete `commercialBindingSnapshot` canonically projects to its `commercialBindingEvidence`, then call the current binding verifier with the request's IDs only for current authorization. Require the verifier result's candidate/customer/deal IDs, handoff/deal hashes, schema version and binding hash to equal the decision evidence exactly, discard that result, and persist the decision's formal-version `commercialBindingSnapshot` together with its exact `quoteVersionId`, `currency`, `quotedAmountMinor`, `commercialAmountHash`, and `authorityRevision`. For `factType="contract_won"`, also require the input/replacement `amountMinor===decision.quotedAmountMinor` and `currency===decision.currency`; create and correct both reject any current/frozen binding or amount mismatch as `financial_fact_conflict` before a source head, reversal, replacement, or idempotency completion is written. Other acquisition-bound fact types retain their own accounting amount but carry the same frozen decision binding. The opaque authority cutoff is not the ledger row/event append time, and request/import adapters cannot supply either.

After authority validation, every fact write transaction first calls `foundation.temporalBarrier.allocateAppend(tx,workspaceId)`, thereby locking the workspace barrier before `LedgerSourceHead → fact → verification-event prefix`, and holds it through commit. Create/verify/reject/reverse persist the returned `recordedAt/temporalSequence` on their one immutable row/event. Correction uses the first allocation for the reversal, locks and validates the domain chain, then calls `allocateAppend` again for the replacement fact, so both records are globally ordered even with a new source and a regressing clock. Replace the reconciler's private ad-hoc relationship validation with the same verifier without changing reconciler output. A missing/mismatched current binding, a disagreement between the decision's full formal snapshot and seven-field evidence, a changed won decision, or a `contract_won` amount/currency mismatch rolls back any provisional barrier allocation, maps to `financial_fact_conflict`, and creates no ledger row. A successful command serializes the decision-carried formal snapshot byte-for-byte; it never serializes the current verifier result.

Implement financial lifecycle by reusing the shared source-head, verification, and Foundation free-idempotency primitives, but with `ledgerType="financial"`. Use exact completed references: create `{resourceId:factId,operationId:null}`, verify/reject/reverse `{resourceId:factId,operationId:verificationEventId}`, and correction `{resourceId:replacementFactId,operationId:correctionGroupId}`; current re-authorization validates the referenced event/group plus current command access, but response projection and historical ownership remain anchored to the persisted decision-carried formal binding. Pending verify/reject requires revision 1, and verified reverse/correct requires revision 2; stale commands write nothing. Only these fact types are accepted: `contract_won`, `payment_received`, `revenue_recognized`, `cogs_recognized`, `refund`, `bad_debt_written_off`. A `contract_won` correction must still match the same frozen won decision and formal binding exactly and cannot revise contract value or candidate/customer/deal attribution. Do not map `DealEvent.payment` automatically.

```ts
function requireUnsignedFinancialFactMinor(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new FinancialLedgerError("financial_fact_amount_invalid", 422);
  }
  if (!Number.isSafeInteger(value)) {
    throw new FinancialLedgerError("amount_out_of_range", 422);
  }
  return value;
}

function requireSignedFinancialFactMinor(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new FinancialLedgerError("financial_fact_amount_invalid", 422);
  }
  if (!Number.isSafeInteger(value)) {
    throw new FinancialLedgerError("amount_out_of_range", 422);
  }
  return value;
}

export function deriveRevenueAndCogs(input: {
  revenueMinor: number | null; grossProfitMinor: number | null;
}) {
  if (input.grossProfitMinor !== null && input.revenueMinor === null) {
    throw new FinancialLedgerError("revenue_required_for_gross_profit", 422);
  }
  if (input.revenueMinor === null) return null;
  const revenueMinor = requireUnsignedFinancialFactMinor(input.revenueMinor);
  if (input.grossProfitMinor === null) return { revenueMinor, cogsMinor: null };
  const grossProfitMinor = requireSignedFinancialFactMinor(input.grossProfitMinor);
  const cogs = BigInt(revenueMinor) - BigInt(grossProfitMinor);
  if (cogs < 0n) {
    throw new FinancialLedgerError("financial_fact_amount_invalid", 422);
  }
  return { revenueMinor, cogsMinor: safeMinor(cogs, "cogsMinor") };
}
```

This exported helper is the sole derivation path. Direct command normalization, create/correct replacements, finance-import preview, and commit-time revalidation all call it with the same inputs; none persists a client-supplied derived COGS. A zero derived COGS is valid arithmetic evidence but produces no zero-amount ledger row because actual ledger rows remain positive. `safeMinor` is imported from Foundation's `growth-money.ts`; do not catch/remap its overflow `amount_out_of_range`, subtract before converting both operands to `BigInt`, or introduce a second derivation-specific error code. Preview maps `financial_fact_amount_invalid`/`amount_out_of_range` to a row error; direct create/correct and commit retain the exact code, and every failure occurs before append allocation or ledger writes (a request-boundary cutoff seal may already have completed).

- [ ] **Step 4: Verify binding, lifecycle, and existing reconciliation behavior**

Run: `cd backend && NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/financial-fact-ledger-test.ts src/financial-ledger-as-of-reader-test.ts src/commercial-binding-snapshot-test.ts src/acquisition-crm-outcome-reconciliation-test.ts`

Expected: PASS; same-workspace but unrelated candidate/customer/deal is rejected, and existing reconciliation counts remain unchanged.

- [ ] **Step 5: Commit financial facts and shared binding**

```bash
git add backend/src/financial-fact-ledger.ts backend/src/financial-fact-ledger-test.ts backend/src/acquisition-crm-outcome-reconciliation.ts backend/src/acquisition-crm-outcome-reconciliation-test.ts backend/src/growth-finance-test-fixtures.ts
git commit -m "feat: add bound financial fact ledger"
```

### Task 6: Prove FinancialFact MySQL correction parity and append-only audit behavior

**Files:**
- Modify: `backend/src/financial-ledger-mysql-repository.ts`
- Modify: `backend/src/growth-finance-mysql-test.ts`
- Create: `backend/src/financial-ledger-repository-contract-test.ts`
- Test: `backend/src/financial-ledger-repository-contract-test.ts`
- Test: `backend/src/growth-finance-mysql-test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, and 5.
- Produces: `financialLedgerRepositoryContract(name, factory)` reusable by memory and MySQL tests.

- [ ] **Step 1: Add the failing repository contract suite**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialLedgerRepository } from "./financial-ledger-repository.js";

export function financialLedgerRepositoryContract(name: string, factory: () => Promise<{
  repository: FinancialLedgerRepository;
  foundation: GrowthFoundationServices;
  close(): Promise<void>;
}>) {
  test(`${name}: rollback releases the first-lock barrier and leaves no partial correction`, async () => {
    const fixture = await factory();
    try {
      await assert.rejects(() => fixture.repository.transaction(async (tx) => {
        await fixture.foundation.temporalBarrier.allocateAppend(tx, "workspace-a");
        await tx.insertSourceHead({ workspaceId: "workspace-a", ledgerType: "financial", sourceIdentityRoot: "external:bank:p-1", currentLedgerEntryId: "fact-1", currentSourceVersion: 1, revision: 1 });
        throw new Error("inject-after-head");
      }), /inject-after-head/);
      assert.equal(await fixture.repository.getFinancialFact("workspace-a", "fact-1"), null);
    } finally { await fixture.close(); }
  });

  test(`${name}: workspace is part of every lookup`, async () => {
    const fixture = await factory();
    try {
      assert.equal(await fixture.repository.getFinancialFact("workspace-b", "fact-in-workspace-a"), null);
    } finally { await fixture.close(); }
  });
}
```

The contract factory includes `{repository,foundation,close}` where `foundation.temporalBarrier` is the exact singleton paired with that transaction adapter. Invoke it once with `InMemoryFinancialLedgerRepository` and once inside the real MySQL harness. Assert every write transaction trace starts with the temporal barrier, rollback restores both the domain rows and that transaction's append allocation, and a retry can acquire it. Add a two-connection financial correction race matching Task 3's cost correction race. The same real-MySQL suite seeds a won authority with frozen CNY amount plus formal CommercialBindingSnapshot/evidence, proves exact `contract_won` create succeeds and round-trips that event-carried snapshot byte-for-byte, and proves wrong amount/currency or a current Handoff/Customer/Deal rebinding on create/current-revision correction returns `financial_fact_conflict` with zero append/source-head/event/replacement changes. Mutating current binding rows after one accepted fact must not change that stored fact's original candidate/customer/deal. A prior request-boundary cutoff seal is permitted evidence, not a ledger append.

Add this real-MySQL derivation test to `growth-finance-mysql-test.ts`; `createDirectRevenueAndGrossProfit` and `correctDirectRevenueAndGrossProfit` are test-fixture calls through the same application normalization functions used by direct create/correct, not alternate arithmetic:

```ts
test("MySQL loss COGS round-trips and invalid direct create/correct write nothing", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const created = await fixture.createDirectRevenueAndGrossProfit({
      revenueMinor: 1000, grossProfitMinor: -400, currency: "CNY"
    });
    assert.deepEqual(await fixture.readFactAmounts(created.ids), [1000, 1400]);
    await fixture.verifyFacts(created.ids, { expectedRevision: 1 });
    const before = await fixture.financialLedgerCounts();
    await assert.rejects(() => fixture.createDirectRevenueAndGrossProfit({
      revenueMinor: 1000, grossProfitMinor: 1001, currency: "CNY"
    }), /financial_fact_amount_invalid/);
    await assert.rejects(() => fixture.correctDirectRevenueAndGrossProfit({
      ids: created.ids, expectedRevision: 2,
      revenueMinor: Number.MAX_SAFE_INTEGER, grossProfitMinor: -1,
      currency: "CNY"
    }), /amount_out_of_range/);
    assert.deepEqual(await fixture.financialLedgerCounts(), before);
  });
});
```

- [ ] **Step 2: Run the parity tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/financial-ledger-repository-contract-test.ts && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-finance:mysql`

Expected: FAIL until the MySQL FinancialFact and transaction rollback paths implement the whole repository contract.

- [ ] **Step 3: Complete MySQL fact persistence and integrity decoding**

Implement insert/select/lock methods for all FinancialFact columns, storing `attribution_snapshot_json` and the decision-carried formal `commercial_binding_snapshot_json` as immutable JSON. On write and read, canonicalize its exact seven authority fields and require them to match the frozen won decision's binding evidence/hash schema; never rebuild the JSON from current CRM/Handoff rows. Validate required fields and workspace identity; fail closed with `FINANCIAL_LEDGER_MYSQL_INTEGRITY:<field>` rather than returning a partial record. Duplicate source version maps to `financial_fact_duplicate`; CAS loss maps to `ledger_revision_conflict`.

```ts
function parseSafeMinor(value: unknown, field: string) {
  const text = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^[0-9]+$/u.test(text)) throw new Error(`FINANCIAL_LEDGER_MYSQL_INTEGRITY:${field}`);
  const amount = BigInt(text);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`FINANCIAL_LEDGER_MYSQL_INTEGRITY:${field}`);
  return Number(amount);
}

interface MysqlFinancialFactRow {
  id: string; workspace_id: string; amount_minor: string | bigint;
  payload_json: string | object;
}

function parseFinancialFact(row: MysqlFinancialFactRow): FinancialFact {
  const fact = parsePayload(row.payload_json, "financial_fact") as FinancialFact;
  if (fact.workspaceId !== String(row.workspace_id) || fact.id !== String(row.id)) throw new Error("FINANCIAL_LEDGER_MYSQL_INTEGRITY:financial_fact_scope");
  return { ...fact, amountMinor: parseSafeMinor(row.amount_minor, "amount_minor") };
}
```

- [ ] **Step 4: Run memory/MySQL parity and build**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/financial-ledger-repository-contract-test.ts src/financial-fact-ledger-test.ts && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-finance:mysql && npm run build`

Expected: PASS and TypeScript build succeeds; memory and real MySQL both enforce the frozen won QuoteVersion amount/currency and formal commercial binding for every `contract_won` create/correct path.

- [ ] **Step 5: Commit repository parity**

```bash
git add backend/src/financial-ledger-mysql-repository.ts backend/src/growth-finance-mysql-test.ts backend/src/financial-ledger-repository-contract-test.ts
git commit -m "test: enforce financial ledger repository parity"
```

### Task 7: Extract the hardened spreadsheet artifact parser without weakening discovery imports

**Files:**
- Create: `backend/src/secure-spreadsheet-artifact.ts`
- Create: `backend/src/secure-spreadsheet-artifact-test.ts`
- Modify: `backend/src/acquisition-discovery-operations.ts`
- Modify: `backend/src/acquisition-discovery-operations-test.ts`
- Test: `backend/src/secure-spreadsheet-artifact-test.ts`
- Test: `backend/src/acquisition-discovery-operations-test.ts`

**Interfaces:**
- Consumes: the existing ZIP/XLSX/CSV protections currently private in `acquisition-discovery-operations.ts`.
- Produces: `parseSecureSpreadsheetArtifact(input): ParsedSpreadsheetArtifact` and `escapeSpreadsheetCell(value): string`.

```ts
export interface ParsedSpreadsheetArtifact {
  fileHash: string;
  mediaType: "text/csv" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  sheets: Array<{ name: string; rows: Array<Array<{ text: string; formula: string | null }>> }>;
}

export function parseSecureSpreadsheetArtifact(input: { content: Buffer; mediaType: string; limits: { maxBytes: number; maxSheets: number; maxRows: number; maxColumns: number; maxCellLength: number } }): ParsedSpreadsheetArtifact;
```

- [ ] **Step 1: Write the failing security extraction test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import XLSX from "xlsx-js-style";
import { escapeSpreadsheetCell, parseSecureSpreadsheetArtifact } from "./secure-spreadsheet-artifact.js";

test("finance parser exposes formulas so callers can reject them", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["amount"], [{ f: "1+1", v: 2 }]]), "Costs");
  const artifact = parseSecureSpreadsheetArtifact({
    content: XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    limits: { maxBytes: 5_000_000, maxSheets: 10, maxRows: 10_000, maxColumns: 100, maxCellLength: 10_000 }
  });
  assert.equal(artifact.sheets[0]?.rows[1]?.[0]?.formula, "1+1");
});

test("error export neutralizes spreadsheet formula injection", () => {
  assert.equal(escapeSpreadsheetCell("=HYPERLINK(\"https://evil\")"), "'=HYPERLINK(\"https://evil\")");
  assert.equal(escapeSpreadsheetCell("normal"), "normal");
});
```

- [ ] **Step 2: Run parser and discovery tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/secure-spreadsheet-artifact-test.ts src/acquisition-discovery-operations-test.ts`

Expected: FAIL because the extracted module does not exist.

- [ ] **Step 3: Move, export, and reuse the exact hardened parser**

Move the bounded ZIP range checks, EOCD search, Zip64 rejection, entry/path validation, compression-ratio checks, macro/external-link/embedding rejection, CSV state machine, and shape limits into the new module. Read XLSX with `cellFormula: true` so finance can reject formulas; discovery converts cells to text and retains its current public behavior. `escapeSpreadsheetCell` prefixes a single quote for trimmed values starting with `=`, `+`, `-`, or `@`.

```ts
export function escapeSpreadsheetCell(value: string) {
  return /^[=+\-@]/u.test(value.trimStart()) ? `'${value}` : value;
}

export function parseSecureSpreadsheetArtifact(input: SecureSpreadsheetArtifactInput): ParsedSpreadsheetArtifact {
  if (input.content.length > input.limits.maxBytes) throw new SecureSpreadsheetError("IMPORT_LIMIT_EXCEEDED");
  const fileHash = `sha256:${createHash("sha256").update(input.content).digest("hex")}`;
  const sheets = input.mediaType === "text/csv"
    ? parseCsvCells(input.content)
    : parseXlsxCellsAfterSafeZipValidation(input.content);
  assertSpreadsheetShape(sheets, input.limits);
  return { fileHash, mediaType: normalizedSpreadsheetMediaType(input.mediaType), sheets };
}
```

- [ ] **Step 4: Verify all previous malicious-artifact cases still pass**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/secure-spreadsheet-artifact-test.ts src/acquisition-discovery-operations-test.ts src/acquisition-discovery-operations-router-test.ts`

Expected: PASS for CSV quoting, Zip64, zip bomb, duplicate/path entries, macros, external links, encryption, formula visibility, and size limits.

- [ ] **Step 5: Commit the shared parser**

```bash
git add backend/src/secure-spreadsheet-artifact.ts backend/src/secure-spreadsheet-artifact-test.ts backend/src/acquisition-discovery-operations.ts backend/src/acquisition-discovery-operations-test.ts
git commit -m "refactor: share hardened spreadsheet parser"
```

### Task 8: Build versioned finance templates and deterministic preview validation

**Files:**
- Create: `backend/src/tenant-time.ts`
- Create: `backend/src/finance-import-service.ts`
- Create: `backend/src/finance-import-service-test.ts`
- Create: `backend/src/finance-import-repository.ts`
- Modify: `backend/src/growth-finance-test-fixtures.ts`
- Test: `backend/src/finance-import-service-test.ts`

**Interfaces:**
- Consumes: Task 7 parser, `growth-money.ts`, Task 1 domain, the exact Foundation `GrowthFoundationServices` singleton (including reference-identical token-only `workspaceSettings.getAt(context,cutoff)`, `httpIdempotency`, and `temporalBarrier`), free `executeGrowthIdempotentCommand`, `CommercialBindingVerifier`, and Quote's sealed `DealAuthoritativeQuoteReader.getDecisionAt(...,cutoff:GrowthSealedReadCutoff)`.
- Produces: `FinanceImportService.template(context,kind)`, `.preview(commandContext,input)`, `.get(context,operationId)`, and `.queueCommit(commandContext,previewId)`; every method requires current `ledger.pending.create` inside the service before any repository/template access, including completed replay projection and recovery-created command contexts. Also produces `FinanceImportRepository`, immutable `FinanceImportPreviewRecord`, internal-only `FinanceImportStoredRow`, executable `FinanceImportOperation`, and public projected `FinanceImportPreviewRow`.

```ts
export type FinanceImportKind = "acquisition_cost" | "financial_fact";
export interface FinanceImportPreviewCommand {
  kind: FinanceImportKind; fileName: string; mediaType: string; content: Buffer;
  mapping: Record<string, string>;
}
export type FinanceImportRowErrorCode =
  | "spreadsheet_formula_forbidden" | "verified_import_forbidden"
  | "required_field_missing" | "money_invalid" | "currency_invalid"
  | "business_time_invalid" | "commercial_binding_invalid" | "row_identity_conflict"
  | "financial_fact_conflict" | "financial_fact_amount_invalid" | "amount_out_of_range";
export type FinanceImportPublicNormalizedRow =
  | { kind: "acquisition_cost"; category: AcquisitionCostCategory; amountMinor: number; currency: string; businessOccurredAt: string; externalId: string | null; evidenceHash: string }
  | { kind: "financial_fact"; candidateId: string | null; customerId: string | null; dealId: string | null; currency: string; businessOccurredAt: string; externalId: string | null; evidenceHash: string; derivedFacts: Array<{ factType: FinancialFactType; amountMinor: number; provenance?: "derived_from_import" }> };
export type FinanceImportStoredNormalizedRow =
  | Extract<FinanceImportPublicNormalizedRow, { kind: "acquisition_cost" }>
  | (Extract<FinanceImportPublicNormalizedRow, { kind: "financial_fact" }> & {
      readonly authoritativeDecision: AuthoritativeDealDecisionRef | null;
    });
export interface FinanceImportPreviewRow {
  rowNumber: number; sheetName: string; status: "valid" | "invalid";
  sourceIdentityRoot: string; normalized: FinanceImportPublicNormalizedRow | null;
  errors: FinanceImportRowErrorCode[];
}
export interface FinanceImportStoredRow {
  readonly id: string; readonly previewId: string;
  readonly rowNumber: number; readonly sheetName: string;
  readonly status: "valid" | "invalid"; readonly sourceIdentityRoot: string;
  readonly normalized: FinanceImportStoredNormalizedRow | null;
  readonly errors: readonly FinanceImportRowErrorCode[];
  readonly recordedAt: string; readonly temporalSequence: number;
}
export interface FinanceImportPreviewResult {
  previewId: string; fileHash: string; status: "preview_ready" | "partial_success" | "failed";
  resolvedTimeZone: string; workspaceSettingsRevision: string;
  validRows: number; invalidRows: number;
  rows: FinanceImportPreviewRow[];
}
export interface FinanceImportPreviewRecord {
  readonly id: string; readonly workspaceId: string; readonly createdBy: string;
  readonly previewRequestHash: string; readonly fileHash: string; readonly templateVersion: string;
  readonly kind: FinanceImportKind; readonly resolvedTimeZone: string;
  readonly workspaceSettingsRevision: string;
  readonly workspaceSettingsRecordedAt: string;
  readonly workspaceSettingsEventSequence: number;
  readonly validRows: number; readonly invalidRows: number;
  readonly authorityEffectiveAsOf: string; readonly authorityTemporalSequence: number;
  readonly createdAt: string; readonly temporalSequence: number;
}
export interface FinanceImportOperation {
  readonly id: string; readonly previewId: string; readonly workspaceId: string;
  readonly requestingActorId: string; readonly idempotencyKey: string; readonly requestHash: string;
  readonly previewRequestHash: string; readonly fileHash: string; readonly templateVersion: string;
  status: "queued" | "running" | "succeeded" | "partial_success" | "failed";
  validRows: number; invalidRows: number;
  leaseOwner: string | null; leaseExpiresAt: string | null; fencingToken: number;
  resultCreatedIds: string[]; lastErrorCode: string | null;
  createdAt: string; createdTemporalSequence: number;
  updatedAt: string; temporalSequence: number;
}
```

- [ ] **Step 1: Write the failing preview test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { FinanceImportService, parseFinancePreviewBody } from "./finance-import-service.js";
import { InMemoryFinanceImportRepository } from "./finance-import-repository.js";
import {
  financePreviewFixture,
  foundationServicesFixture,
  ledgerCommandContext
} from "./growth-finance-test-fixtures.js";

test("preview separates valid rows, rejects verified and formula cells, and derives COGS", async () => {
  const csv = Buffer.from([
    "externalId,factType,amount,currency,businessOccurredAt,provenance,revenue,grossProfit,status",
    "bank-1,payment_received,100.00,CNY,2026-08-08T10:00:00+08:00,portal_export,,,pending",
    "invoice-1,revenue_recognized,1000.00,CNY,2026-08-08,derived_from_import,1000.00,400.00,pending",
    "bad-1,payment_received,=1+1,CNY,2026-08-08,portal_export,,,verified"
  ].join("\n"));
  const service = new FinanceImportService({
    repository: new InMemoryFinanceImportRepository(),
    foundation: foundationServicesFixture({
      timeZone: "Asia/Shanghai", settingsRevision: "settings-1"
    })
  });
  const preview = await service.preview(ledgerCommandContext("workspace-a", "finance-a"), {
    kind: "financial_fact", fileName: "facts.csv", mediaType: "text/csv", content: csv,
    mapping: { externalId: "externalId", factType: "factType", amount: "amount", currency: "currency", businessOccurredAt: "businessOccurredAt", provenance: "provenance", revenue: "revenue", grossProfit: "grossProfit", status: "status" }
  });
  assert.equal(preview.validRows, 2);
  assert.equal(preview.invalidRows, 1);
  const normalized = preview.rows[1]?.normalized;
  assert.equal(normalized?.kind, "financial_fact");
  if (normalized?.kind !== "financial_fact") throw new Error("expected_financial_fact_preview");
  assert.deepEqual(normalized.derivedFacts, [
    { factType: "revenue_recognized", amountMinor: 100000 },
    { factType: "cogs_recognized", amountMinor: 60000, provenance: "derived_from_import" }
  ]);
  assert.ok(preview.rows[2]?.errors.includes("spreadsheet_formula_forbidden"));
  assert.ok(preview.rows[2]?.errors.includes("verified_import_forbidden"));
  assert.equal(preview.resolvedTimeZone, "Asia/Shanghai");
  assert.equal(preview.workspaceSettingsRevision, "settings-1");
  assert.throws(() => parseFinancePreviewBody({ kind: "financial_fact", fileName: "facts.csv", mediaType: "text/csv", content: csv, mapping: {}, tenantTimeZone: "UTC" }), /additionalProperties/);
});

test("import preview shares bigint COGS derivation for loss invalid and overflow rows", async () => {
  const state = financePreviewFixture({
    financialRows: [
      { externalId: "loss", revenueMinor: 1000, grossProfitMinor: -400 },
      { externalId: "negative-cogs", revenueMinor: 1000, grossProfitMinor: 1001 },
      { externalId: "overflow", revenueMinor: Number.MAX_SAFE_INTEGER,
        grossProfitMinor: -1 }
    ]
  });
  const preview = await state.service.preview(state.command, state.input);
  assert.deepEqual(preview.rows[0]?.normalized?.kind === "financial_fact"
    ? preview.rows[0].normalized.derivedFacts : null, [
    { factType: "revenue_recognized", amountMinor: 1000 },
    { factType: "cogs_recognized", amountMinor: 1400,
      provenance: "derived_from_import" }
  ]);
  assert.ok(preview.rows[1]?.errors.includes("financial_fact_amount_invalid"));
  assert.ok(preview.rows[2]?.errors.includes("amount_out_of_range"));
  assert.equal(state.deriveHelperCallCount(), 3);
  assert.equal(state.countLedgerRows(), 0);
});

test("date-only values use trusted workspace timezone and DST ambiguity fails closed", async () => {
  const service = new FinanceImportService({
    repository: new InMemoryFinanceImportRepository(),
    foundation: foundationServicesFixture({
      timeZone: "America/New_York", settingsRevision: "settings-2"
    })
  });
  const result = await service.preview(ledgerCommandContext("workspace-a", "finance-a"), financePreviewFixture({ businessOccurredAt: "2026-11-01 01:30:00" }));
  assert.ok(result.rows[0]?.errors.includes("business_time_invalid"));
});

test("preview reads workspace timezone at the same sealed cutoff exactly once", async () => {
  const state = financePreviewFixture({
    timeZone: "Asia/Shanghai", settingsRevision: "settings-1",
    pauseAfterSeal: true, physicalConnections: 2
  });
  const oldPreviewPromise = state.service.preview(
    state.command("preview-old-settings"),
    state.input({ businessOccurredAt: "2026-08-09" })
  );
  await state.waitForPreviewSeal();
  await state.appendWorkspaceSettingsOnConnectionB({
    timeZone: "America/New_York", revision: "settings-2"
  });
  state.releasePreviewAfterSeal();
  const oldPreview = await oldPreviewPromise;
  const oldRecord = await state.repository.getPreview(oldPreview.previewId);
  assert.equal(oldPreview.resolvedTimeZone, "Asia/Shanghai");
  assert.equal(oldRecord?.workspaceSettingsRevision, "settings-1");
  assert.equal(oldRecord?.workspaceSettingsEventSequence, 1);
  assert.strictEqual(state.workspaceSettingsGetAtTokens()[0],
    state.previewCutoffs()[0]);

  const newPreview = await state.service.preview(
    state.command("preview-new-settings"),
    state.input({ businessOccurredAt: "2026-08-09" })
  );
  const newRecord = await state.repository.getPreview(newPreview.previewId);
  assert.equal(newPreview.resolvedTimeZone, "America/New_York");
  assert.equal(newRecord?.workspaceSettingsRevision, "settings-2");
  assert.equal(newRecord?.workspaceSettingsEventSequence, 2);
  assert.equal(state.previewSealCallCount("preview-old-settings"), 1);
  assert.equal(state.previewSealCallCount("preview-new-settings"), 1);
  assert.equal(state.workspaceSettingsCurrentGetCallCount(), 0);
});

test("contract_won import preview requires the frozen won amount and currency", async () => {
  const state = contractWonImportFixture({
    wonQuote: { type: "won", dealId: "deal-1", quoteCaseId: "case-1",
      quotedAmountMinor: 298000, currency: "CNY", quoteVersionId: "quote-1",
      commercialAmountHash: "sha256:commercial-1", authorityRevision: 3,
      commercialBindingEvidence: {
        candidateId: "candidate-1", customerId: "customer-1", dealId: "deal-1",
        handoffContentHash: "sha256:h", dealContentHash: "sha256:d",
        bindingHashSchemaVersion: "commercial-binding.v1", bindingHash: "sha256:b"
      },
      commercialBindingSnapshot: {
        candidateId: "candidate-1", handoffId: "handoff-1", leadId: "lead-1",
        customerId: "customer-1", dealId: "deal-1", candidateVersion: 3,
        handoffContentHash: "sha256:h", dealContentHash: "sha256:d",
        bindingHashSchemaVersion: "commercial-binding.v1",
        attributionSnapshot: { attributionVersion: "acquisition-run.v1", runId: "run-1" },
        bindingHash: "sha256:b", verifiedAt: "2026-08-08T02:00:00.000Z"
      },
      decidedAt: "2026-08-08T00:00:00.000Z" }
  });
  const wrongAmount = await state.service.preview(state.command("preview-wrong-amount"),
    state.input({ amountMinor: 1, currency: "CNY" }));
  const wrongCurrency = await state.service.preview(state.command("preview-wrong-currency"),
    state.input({ amountMinor: 298000, currency: "USD" }));
  assert.ok(wrongAmount.rows[0]?.errors.includes("financial_fact_conflict"));
  assert.ok(wrongCurrency.rows[0]?.errors.includes("financial_fact_conflict"));
  assert.equal(state.countLedgerRows(), 0);
  const exact = await state.service.preview(state.command("preview-exact-contract"),
    state.input({ amountMinor: 298000, currency: "CNY" }));
  assert.equal(exact.rows[0]?.status, "valid");
  const normalized = exact.rows[0]?.normalized;
  assert.equal(normalized?.kind, "financial_fact");
  if (normalized?.kind !== "financial_fact") throw new Error("expected_financial_fact");
  assert.equal("authoritativeDecision" in normalized, false);
  assert.equal("commercialBindingSnapshot" in normalized, false);
  const stored = await state.repository.getStoredRow(exact.previewId, 1);
  assert.equal(stored?.normalized?.kind, "financial_fact");
  if (stored?.normalized?.kind !== "financial_fact") {
    throw new Error("expected_stored_financial_fact");
  }
  assert.equal(stored.normalized.authoritativeDecision?.quotedAmountMinor, 298000);
  assert.equal(stored.normalized.authoritativeDecision?.commercialBindingEvidence.candidateId,
    "candidate-1");
  assert.equal(stored.normalized.authoritativeDecision?.commercialBindingSnapshot.bindingHash,
    "sha256:b");
});

test("import preview rejects current rebinding instead of reattributing the frozen decision", async () => {
  const state = contractWonImportFixture();
  state.replaceCurrentBinding({
    candidateId: "candidate-rebound", customerId: "customer-rebound",
    dealId: "deal-1", handoffContentHash: "sha256:rebound-handoff",
    bindingHash: "sha256:rebound-binding"
  });
  const preview = await state.service.preview(
    state.command("preview-rebound-binding"), state.input()
  );
  assert.ok(preview.rows[0]?.errors.includes("financial_fact_conflict"));
  assert.equal(preview.rows[0]?.normalized, null);
  assert.equal(state.countLedgerRows(), 0);
});

test("multi-row preview seals authority once and every Quote lookup sees one token", async () => {
  const state = contractWonImportFixture({ rows: 3 });
  await state.service.preview(state.command("preview-one-cutoff"), state.input());
  assert.equal(state.foundationSealCallCount(), 1);
  assert.equal(state.quoteReaderSealCallCount(), 0);
  assert.equal(state.quoteReaderCutoffs().length, 3);
  assert.equal(state.quoteReaderCutoffs().every(
    (cutoff) => cutoff === state.lastFoundationCutoff()
  ), true);
});

test("queueCommit replays by exact IDs with current authorization and blocks another actor", async () => {
  const state = financePreviewFixture({ createdBy: "finance-a" });
  const context = state.command({
    actorId: "finance-a", idempotencyKey: "finance-commit-0001"
  });
  const first = await state.service.queueCommit(context, state.previewId);
  const replay = await state.service.queueCommit(context, state.previewId);
  assert.equal(replay.operation.id, first.operation.id);
  assert.equal(replay.replayed, true);
  state.revoke("finance-a", "ledger.pending.create");
  await assert.rejects(() => state.service.queueCommit(context, state.previewId),
    (error: unknown) => (error as { code?: string }).code === "capability_forbidden");
  await assert.rejects(() => state.service.queueCommit(
    state.command({ actorId: "finance-b", idempotencyKey: "finance-commit-0002" }),
    state.previewId
  ), (error: unknown) => (error as { code?: string }).code
    === "finance_import_authority_mismatch");
  assert.equal(state.repository.countOperations(), 1);
});

test("one key cannot queue two preview path IDs", async () => {
  const state = financePreviewFixture({
    previews: ["preview-a", "preview-b"], createdBy: "finance-a"
  });
  const request = (previewId: string) => state.command({
    actorId: "finance-a", idempotencyKey: "finance-cross-preview-0001",
    method: "POST", canonicalPath: "/api/v1/finance/imports/:previewId/commit",
    pathParams: { previewId }, payload: {}
  });
  await state.service.queueCommit(request("preview-a"), "preview-a");
  await assert.rejects(() => state.service.queueCommit(
    request("preview-b"), "preview-b"
  ), (error: unknown) => (error as { code?: string }).code
    === "idempotency_conflict");
  assert.equal(state.repository.countOperationsFor("preview-b"), 0);
});
```

- [ ] **Step 2: Run preview tests to verify RED**

Run: `cd backend && NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/finance-import-service-test.ts`

Expected: FAIL because finance import service and repository modules are missing.

- [ ] **Step 3: Implement templates and preview-only normalization**

Provide immutable template versions `finance-cost-import.v1` and `finance-fact-import.v1` with Chinese and stable machine headers. Reject formulas before text normalization. At the first line of the preview request freeze the server `previewStartedAt`; use that trusted instant as `effectiveAuthorityAsOf`, call `foundation.temporalBarrier.sealReadCutoff(context.workspace,effectiveAuthorityAsOf)` exactly once, then call the token-only `this.foundation.workspaceSettings.getAt(context.workspace,cutoff)` once with that identical object. Freeze its validated `timeZone`, revision, `recordedAt`, `eventSequence`, plus the cutoff effective time/sequence on the preview record. Never call current `.get` in preview and never reseal inside settings or Quote readers. No spreadsheet/body/model value can supply or advance the cutoff. Reuse that exact token for every row's Quote authority lookup; the sealed Quote reader performs zero seals. Resolve a date-only value at `00:00:00` in that historical trusted zone; reject DST gaps/ambiguity rather than guessing. The public body schema has `additionalProperties:false` and no `tenantTimeZone`, authority as-of, cutoff token, settings revision, or event identity. A mandatory two-physical-connection memory/MySQL contract pauses after seal, appends a timezone setting on connection B, and proves the old preview still uses the old event while a newly sealed preview uses the new event; each preview seals once and `workspaceSettings.get` is never called. Identity is `workspace + source + factType/category + externalId`, else `fileHash + sheetName + rowNumber`; `evidenceHash` detects changed content for the same identity but never deduplicates unrelated rows.

Preview stores an immutable `FinanceImportPreviewRecord`, internal normalized rows, and errors but creates no cost/fact. Its calculation/authority lookup instant is separate from append time. After parsing/authority work and before any preview/domain `FOR UPDATE`, the repository transaction calls `foundation.temporalBarrier.allocateAppend(tx,workspaceId)` for the preview record, then locks the workspace/import-preview uniqueness stream and calls `allocateAppend` successively for every stored normalized/error row. It persists each returned `recordedAt/temporalSequence`, holds the barrier through the atomic commit, and never stores request-entry time as historical record time. `FinanceImportStoredRow` is the only DTO that may carry `authoritativeDecision` and its full binding; it never crosses HTTP/OpenAPI. A closed `projectFinanceImportPreviewRow(stored): FinanceImportPreviewRow` reconstructs the public allowlisted normalized union field-by-field and omits `authoritativeDecision`, both binding forms, quote/version/hash/revision authority and append fields. It does not use object spread. Runtime schema conformance and explicit `"authoritativeDecision" in row.normalized === false`/serialized-key tests cover preview, get-operation and completed replay responses. All normalized imported rows have pending status. `revenue + grossProfit` emits exactly one revenue and one derived COGS row; gross profit without revenue is invalid. A row without acquisition identity may remain unbound and cannot enter acquisition ROI. If any candidate/customer/deal identity is present, preview resolves the server-side won `AuthoritativeDealDecisionRef`, verifies its complete formal snapshot against its seven-field evidence, and calls `CommercialBindingVerifier` only to prove the row's current candidate/customer/deal IDs still match that frozen evidence exactly. It discards the current verifier snapshot and stores the decision—including its formal `commercialBindingSnapshot`—inside the immutable internal normalized row; missing, rebound, or inconsistent identity is `financial_fact_conflict`. For an imported `contract_won`, preview additionally requires the normalized amount/currency to equal the decision's frozen `quotedAmountMinor/currency`; any binding, amount, or currency mismatch marks that row invalid, persists no executable normalized fact for it, and no operation can create it. Templates and mappings contain no client-supplied quote version, commercial hash, or binding columns. Commit re-resolves the same decision at its one sealed cutoff and exact-matches quote ID/revision/hash/amount/currency plus the complete frozen binding evidence/snapshot against the internal preview row. It then invokes `FinancialFactLedgerAuthorityCommands.createPendingAt`, which repeats current-authorization/frozen-binding integrity before inserting a pending fact and persists only the decision-carried formal snapshot. Any change fails as `financial_fact_conflict` with zero ledger writes or row result.

`queueCommit(context, previewId)` is the sole transition from a preview into executable work. It loads the preview by exact ID, verifies `preview.workspaceId === context.workspace.workspaceId` and `preview.createdBy === context.actorId`, then creates one immutable `FinanceImportOperation` that freezes `previewId`, `previewRequestHash`, `fileHash`, `templateVersion`, `workspaceId`, `requestingActorId`, `idempotencyKey`, and canonical commit `requestHash` from the current server-built `CommandContext`. The operation and preview are separate records: a path parameter can select a preview only while queuing; workers never accept a preview ID. Matching HTTP idempotency replays return the existing operation, while a changed actor, workspace, preview, or request hash returns an authority/idempotency error before a claim or ledger write.

```ts
function financeImportRowIdentity(input: { workspaceId: string; source: string; discriminator: string; externalId: string | null; fileHash: string; sheetName: string; rowNumber: number }) {
  const stable = input.externalId?.trim()
    ? [input.workspaceId, input.source, input.discriminator, input.externalId.trim()]
    : [input.workspaceId, input.fileHash, input.sheetName, String(input.rowNumber), input.discriminator];
  return `finance-import-row:${createHash("sha256").update(stable.join("\u0000")).digest("hex")}`;
}

function rejectFormulaCells(row: readonly { formula: string | null; text: string }[]) {
  if (row.some((cell) => cell.formula !== null || /^[=+\-@]/u.test(cell.text.trimStart()))) {
    throw new FinanceImportRowError("spreadsheet_formula_forbidden");
  }
}

async function queueCommit(
  context: CommandContext,
  previewId: string
): Promise<{ operation: FinanceImportOperation; replayed: boolean }> {
  requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
  const attemptedAt = this.now();
  const result = await executeGrowthIdempotentCommand({
    repository: this.foundation.httpIdempotency,
    reservation: {
      workspaceId: context.workspace.workspaceId, actorId: context.actorId,
      method: "POST", canonicalPath: "/api/v1/finance/imports/:previewId/commit",
      key: context.idempotencyKey, requestHash: context.requestHash,
      attemptedAt, leaseOwner: this.requestExecutionId(), leaseDurationMs: 30_000
    }
  }, async (resourceId, operationId) => {
    requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
    if (resourceId !== previewId || operationId === null) {
      throw new FinanceImportError("idempotency_reference_invalid", 409);
    }
    const operation = await this.repository.getOperation(operationId);
    const preview = await this.repository.getPreview(previewId);
    if (!preview || !operation
      || preview.workspaceId !== context.workspace.workspaceId
      || preview.createdBy !== context.actorId
      || operation.previewId !== preview.id
      || operation.workspaceId !== preview.workspaceId
      || operation.requestingActorId !== context.actorId) {
      throw new FinanceImportError("finance_import_authority_mismatch", 403);
    }
    return this.projectOperation(context.workspace, operation);
  }, async () => {
    const preview = await this.repository.getPreview(previewId);
    if (!preview
      || preview.workspaceId !== context.workspace.workspaceId
      || preview.createdBy !== context.actorId) {
      throw new FinanceImportError("finance_import_authority_mismatch", 403);
    }
    const operation = await this.repository.appendOperation(Object.freeze({
      id: this.ids.next(), previewId: preview.id,
      workspaceId: preview.workspaceId, requestingActorId: context.actorId,
      idempotencyKey: context.idempotencyKey, requestHash: context.requestHash,
      previewRequestHash: preview.previewRequestHash,
      fileHash: preview.fileHash, templateVersion: preview.templateVersion,
      status: "queued" as const, validRows: preview.validRows, invalidRows: preview.invalidRows,
      leaseOwner: null, leaseExpiresAt: null, fencingToken: 0,
      resultCreatedIds: [], lastErrorCode: null
    }));
    return { resourceId: preview.id, operationId: operation.id };
  });
  return { operation: result.value, replayed: result.replayed };
}
```

There is no Finance-owned idempotency wrapper. `attemptedAt` above is reservation-only. `appendOperation` owns one transaction that first calls `foundation.temporalBarrier.allocateAppend(tx,preview.workspaceId)`, then locks the preview's operation/uniqueness stream, and fills `createdAt/updatedAt` plus `createdTemporalSequence/temporalSequence` from that one stamp before inserting. It holds the temporal lock through commit and never samples a Finance-local clock. `authorizeAndProject` receives only Foundation's persisted IDs, re-requires current capability, requires `resourceId===previewId`, loads `operationId`, verifies the complete preview/operation/workspace/requesting-actor relationship, and applies the current authorized projection. The execute callback returns only `{resourceId:preview.id,operationId:operation.id}`. A replay after capability revocation or by another actor performs zero barrier/domain/claim/row-result/ledger writes and never returns a cached response body.

- [ ] **Step 4: Verify preview, timezone, and partial-result behavior**

Run: `cd backend && NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/finance-import-service-test.ts src/secure-spreadsheet-artifact-test.ts`

Expected: PASS with two valid rows, one invalid row, no ledger writes, stable source identities, and explicit timezone normalization.

- [ ] **Step 5: Commit finance preview**

```bash
git add backend/src/tenant-time.ts backend/src/finance-import-service.ts backend/src/finance-import-service-test.ts backend/src/finance-import-repository.ts backend/src/growth-finance-test-fixtures.ts
git commit -m "feat: preview finance spreadsheet imports"
```

### Task 9: Persist preview/commit operations with fencing, one-time commit, and safe error export

**Files:**
- Create: `backend/src/finance-import-mysql-repository.ts`
- Create: `backend/src/finance-import-worker.ts`
- Create: `backend/src/finance-import-worker-test.ts`
- Create: `backend/src/finance-import-recovery-sweeper.ts`
- Create: `backend/src/finance-import-recovery-sweeper-test.ts`
- Create: `backend/src/growth-finance-import-mysql-test.ts`
- Modify: `backend/src/finance-import-service.ts`
- Modify: `backend/src/growth-finance-test-fixtures.ts`
- Modify: `backend/src/growth-finance-mysql.ts`
- Modify: `backend/src/growth-finance-mysql-test.ts`
- Modify: `backend/package.json`
- Test: `backend/src/finance-import-worker-test.ts`
- Test: `backend/src/finance-import-recovery-sweeper-test.ts`
- Test: `backend/src/growth-finance-import-mysql-test.ts`

**Interfaces:**
- Consumes: Task 8 preview records, Task 2 cost/fact services, the exact same Foundation `GrowthFoundationServices.temporalBarrier`, current workspace/capability resolution for recovery re-authorization, and the shared MySQL harness.
- Produces: `FINANCE_IMPORT_MYSQL_SCHEMA_STATEMENTS`, `ensureFinanceImportMysqlSchema(pool)`, immutable `FinanceImportOperationEvent`, `MysqlFinanceImportRepository`, `FinanceImportWorker.claim/heartbeat/commit/run/close`, production `FinanceImportRecoverySweeper.start/stop/sweepOnce/close`, and test-only `createFinanceImportFixture()` that persists one valid preview row with a five-minute lease.

```ts
export interface FinanceImportClaim {
  workspaceId: string; operationId: string; leaseOwner: string;
  leaseExpiresAt: string; fencingToken: number;
}
export interface FinanceImportRowResult {
  rowId: string; status: "created" | "replayed"; createdLedgerIds: string[];
}
export interface FinanceImportOperationEvent {
  readonly id: string; readonly workspaceId: string; readonly operationId: string;
  readonly eventType: "queued" | "claimed" | "renewed" | "row_saved" | "completed" | "failed";
  readonly eventSequence: number; readonly revision: number;
  readonly leaseOwner: string | null; readonly fencingToken: number;
  readonly recordedAt: string; readonly temporalSequence: number;
}
export interface FinanceImportExecutionRepository {
  getPreview(previewId: string): Promise<FinanceImportPreviewRecord | null>;
  getOperation(operationId: string): Promise<FinanceImportOperation | null>;
  listRecoverable(now: string, limit: number): Promise<FinanceImportOperation[]>;
  claim(operationId: string, workerId: string, now: string, leaseExpiresAt: string): Promise<FinanceImportClaim | null>;
  assertLiveClaim(claim: FinanceImportClaim, now: string): Promise<void>;
  renewLease(input: { operationId: string; leaseOwner: string; fencingToken: number; now: string; nextExpiry: string }): Promise<boolean>;
  saveRowResult(claim: FinanceImportClaim, result: FinanceImportRowResult, now: string): Promise<void>;
  complete(claim: FinanceImportClaim, result: { status: "succeeded" | "partial_success"; createdIds: string[] }, now: string): Promise<void>;
  fail(claim: FinanceImportClaim, errorCode: string, now: string): Promise<void>;
}
export interface FinanceImportWorker {
  claim(operationId: string, workerId: string, now: string): Promise<FinanceImportClaim | null>;
  heartbeat(claim: FinanceImportClaim, now: string): Promise<FinanceImportClaim>;
  commit(context: CommandContext, claim: FinanceImportClaim): Promise<{ status: "succeeded" | "partial_success"; createdIds: string[]; replayed: boolean }>;
  run(input: { operationId: string; workerId: string; authorize(operation: FinanceImportOperation): Promise<CommandContext> }): Promise<{ status: "succeeded" | "partial_success"; createdIds: string[]; replayed: boolean }>;
  fail(claim: FinanceImportClaim, errorCode: string, now: string): Promise<void>;
  close(): Promise<void>;
}
export interface FinanceImportRecoveryAuthorizer {
  commandFor(operation: Readonly<FinanceImportOperation>): Promise<CommandContext>;
}
export interface FinanceImportRecoverySweeper {
  start(): void;
  sweepOnce(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write the failing lease and one-time commit test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { FinanceImportWorker } from "./finance-import-worker.js";
import { createFinanceImportFixture } from "./growth-finance-test-fixtures.js";

test("stale fencing tokens cannot commit and replay creates no duplicate facts", async () => {
  const fixture = await createFinanceImportFixture();
  const worker = new FinanceImportWorker(fixture.dependencies);
  const first = await worker.claim(fixture.operationId, "worker-a", "2026-08-09T00:00:00.000Z");
  assert.ok(first);
  fixture.setNow("2026-08-09T00:10:00.000Z");
  await assert.rejects(() => worker.heartbeat(first, fixture.now()), /stale_fencing_token/);
  await assert.rejects(() => worker.commit(fixture.context, first), /stale_fencing_token/);
  const second = await worker.claim(fixture.operationId, "worker-b", "2026-08-09T00:10:00.000Z");
  assert.ok(second && second.fencingToken > first.fencingToken);
  const committed = await worker.commit(fixture.context, second);
  const replay = await worker.commit(fixture.context, second);
  assert.equal(committed.createdIds.length, 1);
  assert.deepEqual(replay, { ...committed, replayed: true });
});

test("heartbeat renews an unexpired claim and every row save uses the renewed fence", async () => {
  const fixture = await createFinanceImportFixture({ rows: 2 });
  const worker = new FinanceImportWorker(fixture.dependencies);
  const claim = await worker.claim(fixture.operationId, "worker-a", "2026-08-09T00:00:00.000Z");
  assert.ok(claim);
  fixture.setNow("2026-08-09T00:04:00.000Z");
  const renewed = await worker.heartbeat(claim, fixture.now());
  assert.ok(renewed.leaseExpiresAt > claim.leaseExpiresAt);
  fixture.setNow("2026-08-09T00:06:00.000Z");
  const result = await worker.commit(fixture.context, renewed);
  assert.equal(result.createdIds.length, 2);
  assert.deepEqual(fixture.savedRowFences(), [renewed.fencingToken, renewed.fencingToken]);
});

test("every import transition takes the workspace barrier first and appends a global sequence", async () => {
  const fixture = await createFinanceImportFixture({ rows: 1 });
  const worker = new FinanceImportWorker(fixture.dependencies);
  const claim = await worker.claim(fixture.operationId, "worker-temporal", fixture.now());
  assert.ok(claim);
  const renewed = await worker.heartbeat(claim, fixture.advanceNowBy(60_000));
  await worker.commit(fixture.context, renewed);
  const events = await fixture.operationEvents();
  assert.deepEqual(events.map((event) => event.eventType), [
    "queued", "claimed", "renewed", "row_saved", "completed"
  ]);
  assert.equal(events.every((event, index) => index === 0
    || event.temporalSequence > events[index - 1]!.temporalSequence), true);
  assert.equal(events.every((event, index) => index === 0
    || event.recordedAt > events[index - 1]!.recordedAt), true);
  assert.equal(fixture.writeLockTraces().every(
    (trace) => trace[0] === "temporal:workspace-a"
  ), true);
  assert.equal(fixture.commitBoundarySealCallCount(), 1);
  assert.equal(fixture.internalFactSealCallCount(), 0);
  assert.equal(fixture.quoteReaderSealCallCount(), 0);
  assert.equal(fixture.authorityCutoffs().every(
    (cutoff) => cutoff === fixture.lastCommitBoundaryCutoff()
  ), true);
});

test("commit authority is frozen and identity substitution performs zero writes", async () => {
  const cases = [
    ["cross-workspace", { workspaceId: "workspace-b" }],
    ["changed-actor", { actorId: "finance-b" }],
    ["changed-idempotency-key", { idempotencyKey: "different-commit-identity" }],
    ["tampered-request-hash", { requestHash: "sha256:tampered" }]
  ] as const;
  for (const [name, contextPatch] of cases) {
    const fixture = await createFinanceImportFixture();
    const worker = new FinanceImportWorker(fixture.dependencies);
    const claim = await worker.claim(fixture.operationId, `worker-${name}`, fixture.now());
    assert.ok(claim);
    await assert.rejects(
      () => worker.commit(fixture.commandContext(contextPatch), claim),
      /finance_import_authority_mismatch/
    );
    assert.equal(await fixture.countCreatedLedgerRows(), 0);
    assert.equal(await fixture.countSavedRowResults(), 0);
  }

  const switchedPreview = await createFinanceImportFixture();
  switchedPreview.replaceOperationPreviewId("preview-from-another-operation");
  const worker = new FinanceImportWorker(switchedPreview.dependencies);
  const claim = await worker.claim(switchedPreview.operationId, "worker-preview-swap", switchedPreview.now());
  assert.ok(claim);
  await assert.rejects(() => worker.commit(switchedPreview.context, claim), /finance_import_preview_mismatch/);
  assert.equal(await switchedPreview.countCreatedLedgerRows(), 0);
  assert.equal(await switchedPreview.countSavedRowResults(), 0);
});

test("commit revalidates the frozen contract_won amount and currency", async () => {
  const fixture = await createFinanceImportFixture({
    factType: "contract_won", amountMinor: 298000, currency: "CNY",
    wonQuote: { quoteVersionId: "quote-1", quotedAmountMinor: 298000,
      currency: "CNY", commercialAmountHash: "sha256:commercial-1",
      commercialBindingEvidence: {
        candidateId: "candidate-1", customerId: "customer-1", dealId: "deal-1",
        handoffContentHash: "sha256:h", dealContentHash: "sha256:d",
        bindingHashSchemaVersion: "commercial-binding.v1", bindingHash: "sha256:b"
      },
      commercialBindingSnapshot: {
        candidateId: "candidate-1", handoffId: "handoff-1", leadId: "lead-1",
        customerId: "customer-1", dealId: "deal-1", candidateVersion: 3,
        handoffContentHash: "sha256:h", dealContentHash: "sha256:d",
        bindingHashSchemaVersion: "commercial-binding.v1",
        attributionSnapshot: { attributionVersion: "acquisition-run.v1", runId: "run-1" },
        bindingHash: "sha256:b", verifiedAt: "2026-08-08T02:00:00.000Z"
      },
      authorityRevision: 3 }
  });
  fixture.replaceWonAuthority({ quoteVersionId: "quote-2",
    quotedAmountMinor: 320000, currency: "CNY",
    commercialAmountHash: "sha256:commercial-2", authorityRevision: 4 });
  const worker = new FinanceImportWorker(fixture.dependencies);
  const claim = await worker.claim(fixture.operationId, "worker-authority-change", fixture.now());
  assert.ok(claim);
  await assert.rejects(() => worker.commit(fixture.context, claim),
    (error: unknown) => (error as { code?: string }).code
      === "financial_fact_conflict");
  assert.equal(await fixture.countCreatedLedgerRows(), 0);
  assert.equal(await fixture.countSavedRowResults(), 0);
});

test("commit rejects current rebinding while preserving the preview's formal binding", async () => {
  const fixture = await createFinanceImportFixture({
    factType: "contract_won", amountMinor: 298000, currency: "CNY"
  });
  const frozenDecision = await fixture.normalizedAuthoritativeDecision();
  fixture.replaceCurrentBinding({
    candidateId: "candidate-rebound", customerId: "customer-rebound",
    dealId: "deal-1", handoffContentHash: "sha256:rebound-handoff",
    bindingHash: "sha256:rebound-binding"
  });
  const worker = new FinanceImportWorker(fixture.dependencies);
  const claim = await worker.claim(
    fixture.operationId, "worker-binding-rebound", fixture.now()
  );
  assert.ok(claim);
  await assert.rejects(() => worker.commit(fixture.context, claim),
    (error: unknown) => (error as { code?: string }).code
      === "financial_fact_conflict");
  assert.equal(frozenDecision.commercialBindingEvidence.candidateId, "candidate-1");
  assert.equal(await fixture.countCreatedLedgerRows(), 0);
  assert.equal(await fixture.countSavedRowResults(), 0);
});

test("commit re-runs shared bigint COGS derivation before any ledger write", async () => {
  const cases = [
    { revenueMinor: 1000, grossProfitMinor: 1001,
      code: "financial_fact_amount_invalid" },
    { revenueMinor: Number.MAX_SAFE_INTEGER, grossProfitMinor: -1,
      code: "amount_out_of_range" }
  ] as const;
  for (const current of cases) {
    const fixture = await createFinanceImportFixture({
      revenueMinor: current.revenueMinor,
      grossProfitMinor: current.grossProfitMinor,
      bypassPreviewForCommitIntegrityTest: true
    });
    const worker = new FinanceImportWorker(fixture.dependencies);
    const claim = await worker.claim(
      fixture.operationId, `worker-${current.code}`, fixture.now()
    );
    assert.ok(claim);
    await assert.rejects(() => worker.commit(fixture.context, claim),
      (error: unknown) => (error as { code?: string }).code === current.code);
    assert.equal(await fixture.countCreatedLedgerRows(), 0);
    assert.equal(await fixture.countSavedRowResults(), 0);
  }
});
```

In `finance-import-recovery-sweeper-test.ts`, verify the production lifecycle with a deterministic scheduler:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createFinanceImportFixture } from "./growth-finance-test-fixtures.js";

test("recovery reclaims an expired operation and stop waits for in-flight work", async () => {
  const fixture = await createFinanceImportFixture({ status: "running", expiredOwner: "dead-worker" });
  const sweeper = fixture.recoverySweeper({ workerId: "finance-recovery-1", intervalMs: 5_000 });
  sweeper.start();
  const sweep = sweeper.sweepOnce();
  await fixture.waitUntilRecoveryClaimed();
  const stopping = sweeper.stop();
  assert.equal(fixture.stopResolved(stopping), false);
  fixture.releaseRecoveryRow();
  await sweep;
  await stopping;
  assert.equal((await fixture.operation()).status, "succeeded");
  assert.ok((await fixture.operation()).fencingToken > fixture.expiredFencingToken);
  await sweeper.close();
  await sweeper.close();
  assert.equal(fixture.activeTimerCount(), 0);
});

test("one failed recovery is isolated from the next recoverable operation", async () => {
  const fixture = await createFinanceImportFixture({ operations: ["bad-preview", "good-preview"] });
  fixture.failAuthorizationFor("bad-preview");
  await fixture.recoverySweeper({ workerId: "finance-recovery-1", intervalMs: 5_000 }).sweepOnce();
  assert.equal((await fixture.operation("bad-preview")).status, "failed");
  assert.equal((await fixture.operation("good-preview")).status, "succeeded");
});

test("recovery reauthorizes current ledger capability before claim work", async () => {
  const fixture = await createFinanceImportFixture({
    status: "running", expiredOwner: "dead-worker",
    requestingActorId: "finance-admin"
  });
  fixture.revoke("finance-admin", "ledger.pending.create");
  const before = fixture.domainAndRowResultWriteCounts();
  await fixture.recoverySweeper({
    workerId: "finance-recovery-current-auth", intervalMs: 5_000
  }).sweepOnce();
  assert.equal((await fixture.operation()).lastErrorCode, "capability_forbidden");
  assert.deepEqual(fixture.domainAndRowResultWriteCounts(), before);
  assert.equal(await fixture.countCreatedLedgerRows(), 0);
  assert.equal(await fixture.countSavedRowResults(), 0);
});

test("recovery rebuilds only the frozen operation identity and rejects a swapped preview", async () => {
  const fixture = await createFinanceImportFixture({ status: "running", expiredOwner: "dead-worker" });
  fixture.replaceOperationPreviewId("preview-from-another-workspace");
  await fixture.recoverySweeper({ workerId: "finance-recovery-1", intervalMs: 5_000 }).sweepOnce();
  assert.deepEqual(fixture.recoveryAuthorizationInputs(), [{ operationId: fixture.operationId }]);
  assert.deepEqual(fixture.lastRecoveryContextIdentity(), fixture.frozenOperationContextIdentity());
  assert.equal(await fixture.countCreatedLedgerRows(), 0);
  assert.equal(await fixture.countSavedRowResults(), 0);
  assert.equal((await fixture.operation()).lastErrorCode, "finance_import_preview_mismatch");
});
```

In `growth-finance-import-mysql-test.ts`, prove the same fence/expiry rules across real connections:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";

test("MySQL expired owner cannot renew or save after a higher-fence reclaim", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const operationId = await fixture.insertFinanceImportOperation({ status: "queued", rows: 1 });
    const workerA = fixture.financeImportWorker({ connection: "a" });
    const workerB = fixture.financeImportWorker({ connection: "b" });
    const first = await workerA.claim(operationId, "worker-a", "2026-08-09T00:00:00.000Z");
    assert.ok(first);
    fixture.setNow("2026-08-09T00:10:00.000Z");
    const second = await workerB.claim(operationId, "worker-b", fixture.now());
    assert.ok(second && second.fencingToken > first.fencingToken);
    await assert.rejects(() => workerA.heartbeat(first, fixture.now()), /stale_fencing_token/);
    await assert.rejects(() => fixture.importRepository.saveRowResult(first, fixture.rowResult(), fixture.now()), /stale_fencing_token/);
    const completed = await workerB.commit(fixture.commandContext(operationId), second);
    assert.equal(completed.createdIds.length, 1);
    assert.equal(await fixture.countCreatedLedgerRows(operationId), 1);
  });
});

test("MySQL import claim renew row-save and completion share the global temporal order", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const operationId = await fixture.insertFinanceImportOperation({
      status: "queued", rows: 1
    });
    const worker = fixture.financeImportWorker({ connection: "b" });
    const claim = await worker.claim(operationId, "worker-order", fixture.now());
    assert.ok(claim);
    const renewed = await worker.heartbeat(claim, fixture.advanceNowBy(60_000));
    await worker.commit(fixture.commandContext(operationId), renewed);
    const events = await fixture.listImportOperationEvents(operationId);
    assert.deepEqual(events.map((event) => event.eventType), [
      "queued", "claimed", "renewed", "row_saved", "completed"
    ]);
    assert.equal(events.every((event, index) => index === 0
      || event.temporalSequence > events[index - 1]!.temporalSequence), true);
    assert.equal(fixture.writeLockTraces(operationId).every(
      (trace) => trace[0] === "temporal:workspace-a"
    ), true);
  });
});

test("MySQL recovery sweeper reclaims an expired operation exactly once", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const operationId = await fixture.insertFinanceImportOperation({ status: "running", expiredOwner: "dead-worker", rows: 1 });
    await fixture.financeImportRecoverySweeper().sweepOnce();
    assert.equal((await fixture.importRepository.getOperation(operationId))?.status, "succeeded");
    assert.equal(await fixture.countCreatedLedgerRows(operationId), 1);
  });
});

test("MySQL rejects operation/preview hash substitution before any ledger write", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const operationId = await fixture.insertFinanceImportOperation({ status: "queued", rows: 1 });
    await assert.rejects(
      () => fixture.tamperOperationPreviewLink(operationId, { fileHash: "sha256:other-file" }),
      /finance_import_preview_identity_fk/
    );
    assert.equal(await fixture.countCreatedLedgerRows(operationId), 0);
    assert.equal(await fixture.countFinanceImportRowResults(operationId), 0);
  });
});

test("MySQL preview seals once and reads workspace settings at that token", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const settings1 = await fixture.appendWorkspaceSettings({
      connection: "a", timeZone: "Asia/Shanghai", revision: "settings-1"
    });
    const oldPreviewPromise = fixture.previewOnConnection("a", {
      idempotencyKey: "mysql-preview-settings-old",
      businessOccurredAt: "2026-08-09", pauseAfterSeal: true
    });
    await fixture.waitForPreviewSeal("mysql-preview-settings-old");
    const settings2 = await fixture.appendWorkspaceSettings({
      connection: "b", timeZone: "America/New_York", revision: "settings-2"
    });
    fixture.releasePreviewAfterSeal("mysql-preview-settings-old");
    const oldPreview = await oldPreviewPromise;
    const newPreview = await fixture.previewOnConnection("a", {
      idempotencyKey: "mysql-preview-settings-new",
      businessOccurredAt: "2026-08-09"
    });
    assert.equal(oldPreview.resolvedTimeZone, "Asia/Shanghai");
    assert.equal(newPreview.resolvedTimeZone, "America/New_York");
    assert.deepEqual(await fixture.previewSettingsEvidence(oldPreview.previewId), {
      revision: settings1.revision, eventSequence: settings1.eventSequence
    });
    assert.deepEqual(await fixture.previewSettingsEvidence(newPreview.previewId), {
      revision: settings2.revision, eventSequence: settings2.eventSequence
    });
    assert.deepEqual(fixture.previewSealCounts(), [1, 1]);
    assert.equal(fixture.workspaceSettingsCurrentGetCallCount(), 0);
    assert.equal(fixture.workspaceSettingsGetAtTokenIdentityMatches(), true);
  });
});

test("MySQL import preview and commit enforce frozen contract value and binding", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const wrongAmountPreview = await fixture.previewContractWon({
      amountMinor: 1, currency: "CNY"
    });
    const wrongCurrencyPreview = await fixture.previewContractWon({
      amountMinor: 298000, currency: "USD"
    });
    assert.ok(wrongAmountPreview.rows[0]?.errors.includes(
      "financial_fact_conflict"
    ));
    assert.ok(wrongCurrencyPreview.rows[0]?.errors.includes(
      "financial_fact_conflict"
    ));
    assert.equal(await fixture.countCreatedLedgerRows(), 0);
    assert.equal(await fixture.countQueuedOperationsForPreview(
      wrongAmountPreview.previewId
    ), 0);
    assert.equal(await fixture.countQueuedOperationsForPreview(
      wrongCurrencyPreview.previewId
    ), 0);

    const operationId = await fixture.insertFinanceImportOperation({
      status: "queued", factType: "contract_won", amountMinor: 298000,
      currency: "CNY", rows: 1
    });
    await fixture.replaceWonAuthority({ quotedAmountMinor: 320000,
      currency: "CNY", quoteVersionId: "quote-2", authorityRevision: 4 });
    const worker = fixture.financeImportWorker({ connection: "a" });
    const claim = await worker.claim(operationId, "worker-contract-won", fixture.now());
    assert.ok(claim);
    await assert.rejects(() => worker.commit(
      fixture.commandContext(operationId), claim
    ), (error: unknown) => (error as { code?: string }).code
      === "financial_fact_conflict");
    assert.equal(await fixture.countCreatedLedgerRows(operationId), 0);
    assert.equal(await fixture.countFinanceImportRowResults(operationId), 0);

    const reboundOperationId = await fixture.insertFinanceImportOperation({
      status: "queued", factType: "contract_won", amountMinor: 298000,
      currency: "CNY", rows: 1, frozenCandidateId: "candidate-1"
    });
    await fixture.restoreWonAuthorityFor("quote-1");
    await fixture.replaceCurrentBinding({
      candidateId: "candidate-rebound", customerId: "customer-rebound",
      dealId: "deal-1", handoffContentHash: "sha256:rebound-handoff",
      bindingHash: "sha256:rebound-binding"
    });
    const reboundClaim = await worker.claim(
      reboundOperationId, "worker-contract-binding", fixture.now()
    );
    assert.ok(reboundClaim);
    await assert.rejects(() => worker.commit(
      fixture.commandContext(reboundOperationId), reboundClaim
    ), (error: unknown) => (error as { code?: string }).code
      === "financial_fact_conflict");
    assert.equal(await fixture.countCreatedLedgerRows(reboundOperationId), 0);
    assert.equal(await fixture.countFinanceImportRowResults(reboundOperationId), 0);
  });
});

test("MySQL import round-trips loss COGS and invalid arithmetic writes zero", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const lossOperation = await fixture.insertFinanceImportOperation({
      status: "queued", revenueMinor: 1000, grossProfitMinor: -400, rows: 1
    });
    const worker = fixture.financeImportWorker({ connection: "b" });
    const lossClaim = await worker.claim(
      lossOperation, "worker-loss", fixture.now()
    );
    assert.ok(lossClaim);
    const committed = await worker.commit(
      fixture.commandContext(lossOperation), lossClaim
    );
    assert.deepEqual(await fixture.readFactAmounts(committed.createdIds), [1000, 1400]);

    for (const invalid of [
      { revenueMinor: 1000, grossProfitMinor: 1001,
        code: "financial_fact_amount_invalid" },
      { revenueMinor: Number.MAX_SAFE_INTEGER, grossProfitMinor: -1,
        code: "amount_out_of_range" }
    ] as const) {
      const operationId = await fixture.insertFinanceImportOperation({
        status: "queued", ...invalid, rows: 1,
        bypassPreviewForCommitIntegrityTest: true
      });
      const claim = await worker.claim(
        operationId, `worker-${invalid.code}`, fixture.now()
      );
      assert.ok(claim);
      await assert.rejects(() => worker.commit(
        fixture.commandContext(operationId), claim
      ), (error: unknown) => (error as { code?: string }).code === invalid.code);
      assert.equal(await fixture.countCreatedLedgerRows(operationId), 0);
      assert.equal(await fixture.countFinanceImportRowResults(operationId), 0);
    }
  });
});
```

- [ ] **Step 2: Run worker tests to verify RED**

Run: `cd backend && NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/finance-import-worker-test.ts src/finance-import-recovery-sweeper-test.ts`

Expected: FAIL because `FinanceImportWorker`, `FinanceImportRecoverySweeper`, and their production lifecycle do not exist.

- [ ] **Step 3: Implement durable operations, row identities, and fenced writes**

Create separate `finance_import_previews`, `finance_import_operations`, `finance_import_rows`, append-only `finance_import_row_results`, and append-only `finance_import_operation_events`. A preview is immutable and stores its workspace/creator, preview request hash, file hash, template version, kind, normalized settings identity, counts, and its Foundation-owned `created_at/temporal_sequence`; every immutable row likewise stores its own `recorded_at/temporal_sequence`. The executable operation references one `preview_id` and immutably copies the preview's `workspace_id`, `preview_request_hash`, `file_hash`, and `template_version` together with the committing `requesting_actor_id`, `idempotency_key`, and canonical `request_hash`; repository updates never expose those authority columns. Give previews a unique `(id,workspace_id,preview_request_hash,file_hash,template_version)` key and operations an exact composite foreign key to it, plus unique `(workspace_id,requesting_actor_id,idempotency_key)` and `(workspace_id,requesting_actor_id,request_hash,preview_id)` constraints. It additionally stores status, counts, lease fields, fencing token, immutable result IDs, summary, `created_at/created_temporal_sequence`, and latest `updated_at/temporal_sequence`. Row results and operation events each persist non-null `recorded_at DATETIME(3), temporal_sequence BIGINT UNSIGNED`; operation events have unique `(workspace_id,operation_id,event_sequence)` and `(workspace_id,operation_id,revision)`. Add an index on `(status,lease_expires_at,updated_at,id)` for bounded recovery scans.

Every preview creation, queue, claim/reclaim, renewal, row-result save, completion, and failure transaction first calls the exact singleton `foundation.temporalBarrier.allocateAppend(tx,workspaceId)` before locking a preview/operation/row and holds the barrier through commit. The transaction uses lease-comparison `now` only in strict expiry predicates; it uses the allocation's `recordedAt/temporalSequence` for `updated_at`, immutable row results, and the matching operation event. A transaction that appends both a row result and an operation event calls `allocateAppend` successively and updates the operation to the final stamp. `MysqlFinanceImportRepository.claim` may claim `queued`, or reclaim `running` only when `lease_expires_at <= now`; after the temporal allocation it locks/CASes the operation, sets the new owner, increments `fencing_token`, writes a future expiry, appends `claimed`, then reads back a row matching that exact owner/token with `lease_expires_at > now`. `renew`, `saveRowResult`, `complete`, and `fail` reject unless status is `running`, owner/token exactly match the claim, and stored expiry is strictly later than supplied server `now`. An expired worker therefore cannot renew or save even before another worker arrives. Never trust a timestamp from the HTTP body and never derive append time from `now`.

The worker writes each valid row through the cost/fact service using a stable row command identity, records created IDs, and commits partial success. Its public method is exactly `commit(context,claim)`: there is no caller-supplied preview ID, workspace, actor, lease owner, fence, authority time, or cutoff token. At the first line it freezes the server `commitStartedAt` and uses that trusted instant as `effectiveAuthorityAsOf`. Before starting a heartbeat or ledger call it loads the claimed operation and referenced immutable preview, verifies the current context and every frozen identity field with `assertFinanceImportAuthority`, and fails closed on any mismatch. At this commit/run boundary it calls `foundation.temporalBarrier.sealReadCutoff(context.workspace,effectiveAuthorityAsOf)` exactly once and reuses the exact returned token for every row authority check and `FinancialFactLedgerAuthorityCommands.createPendingAt`; neither the worker loop, the `*At` command, nor Quote sealed reader may seal again. Immediately before each acquisition-bound ledger call it re-resolves the won decision with that token and requires the row's frozen quote version/revision/hash/amount/currency and both formal binding representations to exact-match token-scoped authority; it also requires the current verifier IDs/hashes to equal that frozen evidence. It passes the decision-carried formal snapshot to the FinancialFact service and never substitutes the current verifier result. A mismatch raises `financial_fact_conflict` before the ledger call and no row-result is saved. `commit` starts one serialized heartbeat loop at one third of the five-minute lease, updates its current claim only after a fenced renewal succeeds, and calls `requireLiveClaim()` immediately before every authority check, every ledger call, and every row-result save. Heartbeat failure aborts the run; an already-created ledger row is safe because recovery reuses the row's stable domain idempotency key before saving its result. A terminal matching replay is read-only and performs no seal, but still re-authorizes and validates operation/preview identity before returning immutable stored IDs; it never renews or writes under an expired claim. `close()` rejects new runs, cancels heartbeat timers and waits for all active commits. It never retries an invalid row and never creates a verified ledger event. Error export emits CSV with every cell passed through `escapeSpreadsheetCell` and never includes raw credential or original binary content.

`FinanceImportRecoverySweeper.start()` is idempotent, schedules an immediate sweep plus a fixed interval, and never overlaps its own `sweepOnce`. Each sweep reads a bounded stable `(updatedAt,id)` page of queued or expired-running operations and calls `worker.run({ operationId, workerId, authorize })`. `run` claims first, then passes the persisted operation—not any caller workspace or preview input—to `FinanceImportRecoveryAuthorizer.commandFor(operation)`. That server-side authorizer re-resolves the frozen workspace/requesting actor against current authority and creates a stable `CommandContext` with the operation's frozen idempotency key/request hash; it cannot accept or override workspace, actor, preview, file hash, template version, or request identity. The worker then performs the same operation/preview authority assertion used by initial execution. Revoked authority, `finance_import_authority_mismatch`, and `finance_import_preview_mismatch` are recorded as fenced terminal failures while the claim is still unexpired; process/database availability errors leave the operation running until lease expiry. One operation failure never stops the remaining batch. `stop()` clears the timer and awaits all in-flight sweeps; `close()` is idempotent and delegates to `stop()`.

```ts
async function assertCurrentFinanceImportClaim(tx: FinanceImportTransaction, claim: FinanceImportClaim, now: string) {
  const operation = await tx.getOperationForUpdate(claim.operationId);
  if (!operation
    || operation.workspaceId !== claim.workspaceId
    || operation.leaseOwner !== claim.leaseOwner
    || operation.fencingToken !== claim.fencingToken
    || operation.status !== "running"
    || operation.leaseExpiresAt === null
    || operation.leaseExpiresAt <= now) {
    throw new FinanceImportError("stale_fencing_token", 409);
  }
  return operation;
}

async function assertFinanceImportAuthority(
  context: CommandContext,
  operation: Readonly<FinanceImportOperation>,
  repository: FinanceImportExecutionRepository
): Promise<FinanceImportPreviewRecord> {
  if (context.workspace.workspaceId !== operation.workspaceId
    || context.actorId !== operation.requestingActorId
    || context.idempotencyKey !== operation.idempotencyKey
    || context.requestHash !== operation.requestHash) {
    throw new FinanceImportError("finance_import_authority_mismatch", 403);
  }
  const preview = await repository.getPreview(operation.previewId);
  if (!preview
    || preview.id !== operation.previewId
    || preview.workspaceId !== operation.workspaceId
    || preview.createdBy !== operation.requestingActorId
    || preview.previewRequestHash !== operation.previewRequestHash
    || preview.fileHash !== operation.fileHash
    || preview.templateVersion !== operation.templateVersion) {
    throw new FinanceImportError("finance_import_preview_mismatch", 409);
  }
  return preview;
}

async function commit(context: CommandContext, claim: FinanceImportClaim) {
  const operation = await this.repository.getOperation(claim.operationId);
  if (!operation) throw new FinanceImportError("finance_import_not_found", 404);
  await assertFinanceImportAuthority(context, operation, this.repository);
  if (operation.status === "succeeded" || operation.status === "partial_success") {
    return { status: operation.status, createdIds: [...operation.resultCreatedIds], replayed: true };
  }
  await this.repository.assertLiveClaim(claim, this.now());
  return this.commitRows(context, operation, claim);
}

class CurrentFinanceImportRecoveryAuthorizer implements FinanceImportRecoveryAuthorizer {
  constructor(private readonly resolveWorkspaceActor: (
    workspaceId: string,
    actorId: string
  ) => Promise<ActiveWorkspaceContext>) {}

  async commandFor(operation: Readonly<FinanceImportOperation>): Promise<CommandContext> {
    const workspace = await this.resolveWorkspaceActor(operation.workspaceId, operation.requestingActorId);
    requireGrowthCapabilities(workspace, ["ledger.pending.create"]);
    return Object.freeze({
      workspace,
      actorId: operation.requestingActorId,
      idempotencyKey: operation.idempotencyKey,
      requestHash: operation.requestHash,
      expectedRevision: null
    });
  }
}

async function saveRowResult(claim: FinanceImportClaim, result: FinanceImportRowResult, now: string) {
  return this.repository.transaction(async (tx) => {
    const rowStamp = await this.foundation.temporalBarrier.allocateAppend(
      tx, claim.workspaceId
    );
    await assertCurrentFinanceImportClaim(tx, claim, now);
    await tx.saveRowResult(claim.operationId, result, rowStamp);
    const eventStamp = await this.foundation.temporalBarrier.allocateAppend(
      tx, claim.workspaceId
    );
    await tx.appendOperationEvent(operationEvent(
      claim, "row_saved", eventStamp
    ));
  });
}

async function renew(claim: FinanceImportClaim, now: string): Promise<FinanceImportClaim> {
  const nextExpiry = addMilliseconds(now, this.leaseDurationMs);
  const changed = await this.repository.renewLease({
    operationId: claim.operationId, leaseOwner: claim.leaseOwner,
    fencingToken: claim.fencingToken, now, nextExpiry
  });
  if (!changed) throw new FinanceImportError("stale_fencing_token", 409);
  return { ...claim, leaseExpiresAt: nextExpiry };
}

class FinanceImportLeaseHeartbeat {
  private claim: FinanceImportClaim;
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewal: Promise<void> = Promise.resolve();
  private failure: unknown = null;

  constructor(private readonly options: {
    initialClaim: FinanceImportClaim; intervalMs: number; now(): string;
    renew(claim: FinanceImportClaim, now: string): Promise<FinanceImportClaim>;
  }) { this.claim = options.initialClaim; }

  start() {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.renewal = this.renewal.then(async () => {
        if (this.failure !== null) return;
        try { this.claim = await this.options.renew(this.claim, this.options.now()); }
        catch (error) { this.failure = error; }
      });
    }, this.options.intervalMs);
  }

  async requireLive(now: string): Promise<FinanceImportClaim> {
    await this.renewal;
    if (this.failure !== null) throw this.failure;
    if (this.claim.leaseExpiresAt <= now) throw new FinanceImportError("stale_fencing_token", 409);
    return this.claim;
  }

  async stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.renewal;
  }
}

async function commitRows(context: CommandContext, operation: FinanceImportOperation, initialClaim: FinanceImportClaim) {
  const heartbeat = new FinanceImportLeaseHeartbeat({
    initialClaim, intervalMs: Math.floor(this.leaseDurationMs / 3),
    now: this.now, renew: (claim, now) => this.heartbeat(claim, now)
  });
  heartbeat.start();
  const createdIds: string[] = [];
  try {
    for (const row of await this.repository.listValidRows(operation.id)) {
      await heartbeat.requireLive(this.now());
      const rowResult = await this.createLedgerRowsWithStableIdentity(context, operation, row);
      const liveClaim = await heartbeat.requireLive(this.now());
      await this.repository.saveRowResult(liveClaim, rowResult, this.now());
      createdIds.push(...rowResult.createdLedgerIds);
    }
    const liveClaim = await heartbeat.requireLive(this.now());
    const result = { status: operation.invalidRows === 0 ? "succeeded" as const : "partial_success" as const, createdIds };
    await this.repository.complete(liveClaim, result, this.now());
    return { ...result, replayed: false };
  } finally {
    await heartbeat.stop();
  }
}

function renderImportErrors(rows: readonly FinanceImportRow[]) {
  const header = ["sheetName", "rowNumber", "sourceIdentityRoot", "errors"];
  const values = rows.filter((row) => row.status === "invalid").map((row) => [row.sheetName, String(row.rowNumber), row.sourceIdentityRoot, row.errors.join("|")]);
  return [header, ...values].map((row) => row.map((cell) => `"${escapeSpreadsheetCell(cell).replaceAll('"', '""')}"`).join(",")).join("\r\n");
}
```

The MySQL updates encode the same invariant rather than relying only on application checks:

```sql
UPDATE finance_import_operations
SET lease_expires_at = ?, updated_at = ?
WHERE id = ? AND status = 'running' AND lease_owner = ? AND fencing_token = ?
  AND lease_expires_at > ?;

UPDATE finance_import_operations
SET status = ?, result_json = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
WHERE id = ? AND status = 'running' AND lease_owner = ? AND fencing_token = ?
  AND lease_expires_at > ?;
```

In both statements, the assigned `updated_at` and matching operation-event `recorded_at` come from `allocateAppend`; the final predicate parameter is the independent lease-comparison `now`. Both statements require `affectedRows === 1`; `assertLiveClaim` and `saveRowResult` use the same predicates after their transaction has allocated/locked the workspace barrier and then locked the operation row. Claim/reclaim first performs a nonlocking exact-ID lookup only to discover the persisted concrete workspace, allocates the barrier for that workspace, locks/rereads the operation, and rejects if its workspace changed or is `all`; it then uses `UPDATE ... fencing_token=fencing_token+1 WHERE id=? AND workspace_id=? AND (status='queued' OR (status='running' AND lease_expires_at<=?))`, followed by an exact workspace/owner/token/unexpired read. The returned `FinanceImportClaim.workspaceId` is server-derived and every subsequent worker transition revalidates it against the locked operation. The claim query never joins through a caller-provided preview ID; operation-to-preview linkage is verified after the claim and before any ledger write.

Implement the production sweeper without overlapping intervals or detached shutdown work:

```ts
export class FinanceImportRecoverySweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: {
    repository: FinanceImportExecutionRepository; worker: FinanceImportWorker;
    authorizer: FinanceImportRecoveryAuthorizer; workerId: string;
    intervalMs: number; batchSize: number; now(): string;
    onError(error: unknown, operationId: string | null): void;
  }) {}

  start() {
    if (this.closed) throw new Error("finance_import_recovery_closed");
    if (this.timer !== null) return;
    void this.sweepOnce().catch((error) => this.options.onError(error, null));
    this.timer = setInterval(() => {
      void this.sweepOnce().catch((error) => this.options.onError(error, null));
    }, this.options.intervalMs);
  }

  async sweepOnce(): Promise<void> {
    if (this.closed) return;
    if (this.inFlight !== null) return this.inFlight;
    const run = async () => {
      const operations = await this.options.repository.listRecoverable(this.options.now(), this.options.batchSize);
      for (const operation of operations) {
        try {
          await this.options.worker.run({
            operationId: operation.id, workerId: this.options.workerId,
            authorize: (current) => this.options.authorizer.commandFor(current)
          });
        } catch (error) {
          this.options.onError(error, operation.id);
        }
      }
    };
    this.inFlight = run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  close(): Promise<void> {
    if (this.closePromise === null) {
      this.closed = true;
      this.closePromise = this.stop();
    }
    return this.closePromise;
  }
}
```

`FinanceImportWorker.run` claims before invoking `authorize`. If current authorization fails with the enumerated permanent denial, it calls `fail(claim, "authorization_revoked", now)` while the claim is still unexpired. Frozen operation/preview authority mismatches are failed with their exact closed code under that same live fence; transient failures are not marked terminal. `FinanceImportWorker.close` is also idempotent and waits for the active-run set after stopping every run-owned heartbeat.

Add exact scripts to `backend/package.json`. The unit script owns memory worker/recovery behavior; the MySQL script remains cumulative with Tasks 3/6 and adds the real import lease suite:

```json
{
  "scripts": {
    "test:growth-finance:imports": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/finance-import-service-test.ts src/finance-import-worker-test.ts src/finance-import-recovery-sweeper-test.ts",
    "test:growth-finance:mysql": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/growth-finance-mysql-test.ts src/financial-ledger-as-of-mysql-reader-test.ts src/growth-finance-import-mysql-test.ts"
  }
}
```

- [ ] **Step 4: Verify memory, MySQL, recovery, and duplicate commit behavior**

Run: `cd backend && npm run test:growth-finance:imports && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-finance:mysql`

Expected: PASS; expired/stale workers cannot renew, save or complete; heartbeat keeps a live multi-row commit leased; recovery reclaims with a higher fence exactly once; stop/close await active work; ACK-loss replay returns existing IDs; and a repeated spreadsheet creates zero duplicate facts.

- [ ] **Step 5: Commit durable imports**

```bash
git add backend/src/finance-import-mysql-repository.ts backend/src/finance-import-worker.ts backend/src/finance-import-worker-test.ts backend/src/finance-import-recovery-sweeper.ts backend/src/finance-import-recovery-sweeper-test.ts backend/src/growth-finance-import-mysql-test.ts backend/src/finance-import-service.ts backend/src/growth-finance-test-fixtures.ts backend/src/growth-finance-mysql.ts backend/src/growth-finance-mysql-test.ts backend/package.json
git commit -m "feat: commit finance imports idempotently"
```

### Task 10: Register ledger/import routes against the frozen Growth contract without changing old performance

**Files:**
- Create: `backend/src/acquisition-cost-ledger-router.ts`
- Create: `backend/src/acquisition-cost-ledger-router-test.ts`
- Create: `backend/src/financial-fact-router.ts`
- Create: `backend/src/financial-fact-router-test.ts`
- Create: `backend/src/finance-import-router.ts`
- Create: `backend/src/finance-import-router-test.ts`
- Create: `backend/src/financial-data-gap-reader.ts`
- Create: `backend/src/financial-data-gap-reader-test.ts`
- Create: `backend/src/growth-finance-module.ts`
- Create: `backend/src/growth-finance-module-test.ts`
- Modify: `backend/src/growth-commercial-composition.ts`
- Create: `backend/src/growth-finance-openapi-response-conformance-test.ts`
- Create: `backend/src/growth-finance-contract-route-test.ts`
- Create: `backend/src/growth-finance-router-test-support.ts`
- Modify: `backend/package.json`
- Test: the three new router tests and existing contract suites.

**Interfaces:**
- Consumes: Tasks 2–9; Foundation's exact `GROWTH_FOUNDATION_SERVICES`, including reference-identical `workspaceContext`, `commandContextFactory`, and `temporalBarrier`; Quote's exact `GROWTH_QUOTE_AUTHORITY_READERS`; C0 router middleware for workspace, capability, idempotency, and `If-Match`; the already-frozen Growth OpenAPI/Schema bundle and its sole backend TypeScript declarations `FinancialDataGapCode` and `FinancialDataGapSourceType` from `growth-contract-types.ts`; and C0's single `GrowthCommercialToolPorts` instance. Finance imports those two exact closed unions without redeclaring, aliasing, widening, or generating a second owner.
- Produces immutable `FinancialDataGap { code: FinancialDataGapCode; sourceType: FinancialDataGapSourceType; sourceId; candidateId; customerId; dealId; cohortId: string|null; currency; businessOccurredAt; recordedAt; sourceSnapshotHash }`, server-derived `FinancialDataGapVisibilityKeys { candidateIds:readonly string[]; customerIds:readonly string[]; dealIds:readonly string[]; cohortIds:readonly string[] }`, and internal exact-token `FinancialDataGapSealedReader`: `listForBindingsAt(context:ActiveWorkspaceContext,input:{visibility:FinancialDataGapVisibilityKeys;currency:string;cutoff:GrowthSealedReadCutoff;limit:number}):Promise<readonly FinancialDataGap[]>`; `verifyAt(context:ActiveWorkspaceContext,input:{visibility:FinancialDataGapVisibilityKeys;sourceType:FinancialDataGapSourceType;sourceId:string;gapCode:FinancialDataGapCode;currency:string;cutoff:GrowthSealedReadCutoff;sourceSnapshotHash:\`sha256:${string}\`;cohortId:string|null}):Promise<FinancialDataGap|null>`. Visibility keys come only from an already-authorized server association/binding projection, never from the model/ref/public body. It also produces boundary-only `FinancialDataGapAsOfReader.listForBindingsAsOf(context,{currency,asOf,limit})` and `.verifyAsOf(context,{sourceType,sourceId,gapCode,currency,asOf,sourceSnapshotHash,cohortId})`; neither public input contains any visibility ID, and each wrapper derives the four sets from current server authority, seals once, and delegates with the exact token. The imported C0 gap-code member set remains exactly `unverified_cost | unverified_financial_fact | missing_cogs | unmatched_payment | missing_commercial_binding | import_requires_review`, and the source-type member set remains exactly `cost_entry | financial_fact | finance_import | commercial_binding`. Both sealed methods require at least one non-null row binding and require **every** non-null `candidateId`, `customerId`, `dealId`, and `cohortId` to occur in its corresponding authorized set; an OR match on only one field never authorizes a mixed-binding row. `verifyAt` performs an indexed/unbounded authority lookup by exact source discriminant and ID, validates every supplied field plus derived nullable cohort association, then applies that all-non-null-fields rule; an all-empty scope or unbound row returns null without scanning. It never calls or truncates through `listForBindingsAt(limit<=100)`. Both sealed methods require `context.workspaceId===cutoff.workspaceId`, validate bounded/deduplicated visibility sets, are workspace-scoped/historical, and never seal again.
- Produces: all stage-3 endpoints listed in section 11.1, strict public DTO projections, typed `GROWTH_FINANCE_SERVICES: GrowthPrivateServiceKey<GrowthFinanceServices>`, `createGrowthFinanceModule(options): GrowthCommercialModule`, test-only `mountGrowthFinanceRouters()` returning `{ request(path, init), close() }`, and the final cumulative `test:growth-finance:mysql` script consumed by the release gate. `GrowthFinanceServices { costLedger; financialFacts; imports; verifiedAsOf: VerifiedFinancialLedgerSealedReader; financialGaps: FinancialDataGapSealedReader }` is provided only through the application-private registry; the module privately owns separate public as-of wrappers for HTTP, plus the running import worker/recovery lifecycle, while the runtime's public `GrowthCommercialToolPorts` remains the C0 `register/execute` registry.

Concrete gap implementations are `MysqlFinancialDataGapSealedReader` (no barrier dependency) and `FinancialDataGapAsOfBoundary` (the sole gap wrapper holding `foundation.temporalBarrier`).

```ts
export interface GrowthFinanceModuleOptions {
  recoveryAuthorizer: FinanceImportRecoveryAuthorizer;
  processWorkerId: string;
  recoveryIntervalMs?: number;
  recoveryBatchSize?: number;
  now?: () => string;
  onRecoveryError?: (error: unknown, operationId: string | null) => void;
}
```

- [ ] **Step 1: Write the failing route/compatibility test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mountGrowthFinanceRouters } from "./growth-finance-router-test-support.js";

test("cost create requires idempotency, verify requires If-Match, and old performance is unchanged", async () => {
  const app = await mountGrowthFinanceRouters();
  try {
    const missingKey = await app.request("/api/v1/acquisition/cost-entries", { method: "POST", body: JSON.stringify({}) });
    assert.equal(missingKey.response.status, 400);
    assert.equal(missingKey.body.error.code, "idempotency_key_required");
    const missingMatch = await app.request("/api/v1/acquisition/cost-entries/cost-1/verify", { method: "POST", headers: { "Idempotency-Key": "verify-cost-0001" }, body: JSON.stringify({ reason: "checked" }) });
    assert.equal(missingMatch.response.status, 428);
    const oldPerformance = await app.request("/api/v1/acquisition/performance?from=2026-08-01T00:00:00.000Z&to=2026-08-09T00:00:00.000Z");
    assert.deepEqual(oldPerformance.body.roi, { status: "not_computable", reason: "channel_cost_or_verified_margin_unavailable" });
  } finally { await app.close(); }
});

test("Finance HTTP and services enforce current ledger capabilities independent of role", async () => {
  for (const role of ["sales", "manager"] as const) {
    const denied = await mountGrowthFinanceRouters({ role, capabilities: [] });
    try {
      const before = denied.domainWriteCounts();
      assert.equal((await denied.request(
        "/api/v1/acquisition/cost-entries"
      )).response.status, 403);
      assert.equal((await denied.request(
        "/api/v1/finance/import-templates/financial_fact"
      )).response.status, 403);
      assert.equal((await denied.request(
        "/api/v1/finance/imports/preview", {
          method: "POST", headers: { "Idempotency-Key": `preview-${role}-denied` },
          body: denied.validPreviewBody()
        }
      )).response.status, 403);
      assert.deepEqual(denied.domainWriteCounts(), before);
    } finally { await denied.close(); }
  }

  const admin = await mountGrowthFinanceRouters({
    role: "admin", capabilities: ["ledger.pending.create"]
  });
  try {
    assert.equal((await admin.request(
      "/api/v1/acquisition/cost-entries"
    )).response.status, 200);
    const created = await admin.createPendingCost("current-capability-key");
    assert.equal((await admin.request(
      `/api/v1/acquisition/cost-entries/${created.id}/verify`, {
        method: "POST", headers: {
          "Idempotency-Key": "verify-without-capability", "If-Match": created.etag
        }, body: JSON.stringify({ reason: "checked" })
      }
    )).response.status, 403);
    admin.grant("ledger.verify");
    assert.equal((await admin.verifyCost(created.id, created.etag)).response.status, 200);
    admin.revoke("ledger.pending.create");
    const beforeReplay = admin.domainWriteCounts();
    assert.equal((await admin.createPendingCost(
      "current-capability-key"
    )).response.status, 403);
    assert.deepEqual(admin.domainWriteCounts(), beforeReplay);
  } finally { await admin.close(); }
});

test("import preview get and replay never expose stored quote authority or binding", async () => {
  const app = await mountGrowthFinanceRouters({
    role: "admin", capabilities: ["ledger.pending.create"]
  });
  try {
    const first = await app.previewContractWon("preview-public-projection");
    const replay = await app.previewContractWon("preview-public-projection");
    const queued = await app.commitPreview(
      first.body.previewId, "commit-public-projection"
    );
    const fetched = await app.request(
      `/api/v1/finance/imports/${queued.body.operationId}`
    );
    for (const response of [first, replay, queued, fetched]) {
      const serialized = JSON.stringify(response.body);
      assert.equal(serialized.includes("authoritativeDecision"), false);
      assert.equal(serialized.includes("commercialBindingSnapshot"), false);
      assert.equal(serialized.includes("commercialBindingEvidence"), false);
      assert.equal(serialized.includes("commercialAmountHash"), false);
      assert.equal(serialized.includes("authorityRevision"), false);
      assert.equal(serialized.includes("temporalSequence"), false);
    }
    assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");
    assert.equal(app.internalStoredRow(first.body.previewId, 1)
      .normalized.authoritativeDecision.quoteVersionId, "quote-1");
  } finally { await app.close(); }
});

test("financial gaps are historical, workspace scoped and source backed", async () => {
  const fixture = await financeGapFixture();
  await fixture.recordPendingRevenueWithoutCogs({ recordedAt: "2026-08-09T08:00:00.000Z" });
  const before = await fixture.publicReader.listForBindingsAsOf(fixture.workspace, {
    currency: "CNY", asOf: "2026-08-09T08:30:00.000Z", limit: 100
  });
  assert.deepEqual(before.map((gap) => gap.code), [
    "unverified_financial_fact", "missing_cogs"
  ]);
  await fixture.verifyRevenueAndRecordCogs({ recordedAt: "2026-08-09T09:00:00.000Z" });
  assert.deepEqual(await fixture.publicReader.listForBindingsAsOf(fixture.workspace, {
    currency: "CNY", asOf: "2026-08-09T08:30:00.000Z", limit: 100
  }), before);
  assert.deepEqual(await fixture.publicReader.listForBindingsAsOf(fixture.otherWorkspace, {
    currency: "CNY", asOf: "2026-08-09T10:00:00.000Z", limit: 100
  }), []);
});

test("financial gap reader rejects an unknown persisted source discriminant", async () => {
  const fixture = await financeGapFixture();
  await fixture.seedRawGap({
    code: "unverified_cost", sourceType: "provider_request_unknown",
    sourceId: "raw-1", recordedAt: "2026-08-09T08:00:00.000Z"
  });
  await assert.rejects(() => fixture.publicReader.listForBindingsAsOf(fixture.workspace, {
    currency: "CNY",
    asOf: "2026-08-09T09:00:00.000Z", limit: 100
  }), (error: unknown) => (error as { code?: string }).code
    === "financial_data_gap_source_invalid");
});

test("exact gap verification is not limited by the first list page", async () => {
  const fixture = await financeGapFixture();
  const seeded = await fixture.seedGapPage({ count: 101, currency: "CNY" });
  const target = seeded[100]!;
  fixture.authorizeCurrentContextFor(target);
  const page = await fixture.publicReader.listForBindingsAsOf(fixture.workspace, {
    currency: "CNY",
    asOf: "2026-08-09T09:00:00.000Z", limit: 100
  });
  assert.equal(page.some((gap) => gap.sourceId === target.sourceId), false);
  assert.deepEqual(await fixture.publicReader.verifyAsOf(fixture.workspace, {
    sourceType: target.sourceType, sourceId: target.sourceId,
    gapCode: target.code, currency: target.currency,
    asOf: "2026-08-09T09:00:00.000Z",
    sourceSnapshotHash: target.sourceSnapshotHash,
    cohortId: target.derivedCohortId
  }), target.publicGap);
});

test("exact gap verification rejects a wrong type currency hash cohort or workspace", async () => {
  const fixture = await financeGapFixture();
  const target = await fixture.seedOneGap({
    sourceType: "financial_fact", sourceId: "fact-1",
    code: "missing_cogs", currency: "CNY", cohortId: "cohort-1"
  });
  const exact = {
    sourceType: target.sourceType, sourceId: target.sourceId,
    gapCode: target.code, currency: target.currency,
    asOf: "2026-08-09T09:00:00.000Z",
    sourceSnapshotHash: target.sourceSnapshotHash, cohortId: "cohort-1"
  } as const;
  assert.equal(await fixture.publicReader.verifyAsOf(fixture.workspace, {
    ...exact, sourceType: "cost_entry"
  }), null);
  assert.equal(await fixture.publicReader.verifyAsOf(fixture.workspace, {
    ...exact, currency: "USD"
  }), null);
  assert.equal(await fixture.publicReader.verifyAsOf(fixture.workspace, {
    ...exact, sourceSnapshotHash: `sha256:${"f".repeat(64)}`
  }), null);
  assert.equal(await fixture.publicReader.verifyAsOf(fixture.workspace, {
    ...exact, cohortId: "cohort-other"
  }), null);
  assert.equal(await fixture.publicReader.verifyAsOf(fixture.otherWorkspace, exact), null);
});

test("binding filters run before limit so other users' first 100 gaps cannot hide mine", async () => {
  const fixture = await financeGapFixture();
  await fixture.seedUnrelatedBindingGaps({ count: 150, currency: "CNY" });
  const mine = await fixture.seedOneGap({
    sourceType: "financial_fact", sourceId: "fact-mine",
    code: "missing_cogs", currency: "CNY", cohortId: "cohort-mine",
    candidateId: "candidate-mine", customerId: "customer-mine",
    dealId: "deal-mine"
  });
  fixture.authorizeCurrentContextFor(mine);
  const visible = await fixture.publicReader.listForBindingsAsOf(fixture.workspace, {
    currency: "CNY",
    asOf: "2026-08-09T09:00:00.000Z", limit: 10
  });
  assert.deepEqual(visible, [mine.publicGap]);
  assert.equal(fixture.lastQueryFilteredBindingsBeforeLimit(), true);
});

test("mixed mine and other-sales bindings fail list and exact verification", async () => {
  const fixture = await financeGapFixture();
  const mixed = await fixture.seedOneGap({
    sourceType: "financial_fact", sourceId: "fact-mixed",
    code: "missing_cogs", currency: "CNY", cohortId: "cohort-other",
    candidateId: "candidate-mine", customerId: "customer-other",
    dealId: "deal-other"
  });
  const authorized = {
    candidateIds: ["candidate-mine"], customerIds: ["customer-mine"],
    dealIds: ["deal-mine"],
    cohortIds: ["cohort-mine"]
  };
  fixture.authorizeCurrentContextFor(authorized);
  assert.deepEqual(await fixture.publicReader.listForBindingsAsOf(
    fixture.workspace, { currency: "CNY",
      asOf: "2026-08-09T09:00:00.000Z", limit: 100 }
  ), []);
  assert.equal(await fixture.publicReader.verifyAsOf(fixture.workspace, {
    sourceType: mixed.sourceType, sourceId: mixed.sourceId,
    gapCode: mixed.code, currency: mixed.currency,
    asOf: "2026-08-09T09:00:00.000Z",
    sourceSnapshotHash: mixed.sourceSnapshotHash,
    cohortId: mixed.derivedCohortId
  }), null);
});

test("sealed gap reader reuses token identity and rejects cross-team token/context mismatch", async () => {
  const fixture = await financeGapFixture({ duplicateBindingsAcrossTeams: true });
  const cutoffA = await fixture.seal(
    fixture.workspace, "2026-08-09T09:00:00.000Z"
  );
  const visible = await fixture.sealedReader.listForBindingsAt(fixture.workspace, {
    visibility: {
      candidateIds: ["candidate-shared"], customerIds: ["customer-shared"],
      dealIds: ["deal-shared"], cohortIds: ["cohort-shared"]
    }, currency: "CNY", cutoff: cutoffA, limit: 100
  });
  assert.equal(visible.every((gap) => gap.sourceId.startsWith("team-a:")), true);
  assert.strictEqual(fixture.lastSealedReaderToken(), cutoffA);
  assert.equal(fixture.internalSealCallCount(), 0);
  await assert.rejects(() => fixture.sealedReader.listForBindingsAt(
    fixture.otherWorkspace, {
      visibility: {
        candidateIds: ["candidate-shared"], customerIds: ["customer-shared"],
        dealIds: ["deal-shared"], cohortIds: ["cohort-shared"]
      }, currency: "CNY", cutoff: cutoffA, limit: 100
    }
  ), /sealed_cutoff_workspace_mismatch/);
});

test("public gap wrapper seals exactly once and forwards the same token", async () => {
  const fixture = await financeGapFixture();
  await fixture.publicReader.listForBindingsAsOf(fixture.workspace, {
    currency: "CNY",
    asOf: "2026-08-09T09:00:00.000Z", limit: 100
  });
  assert.equal(fixture.publicSealCallCount(), 1);
  assert.strictEqual(fixture.lastSealedReaderToken(), fixture.lastFoundationToken());
  assert.equal(fixture.internalSealCallCount(), 0);
});
```

- [ ] **Step 2: Run route and contract tests to verify RED**

Run: `cd backend && NODE_ENV=test TZ=UTC JWT_SECRET=goodjob-growth-finance-router-test-secret-at-least-32-characters node --import tsx --test --test-concurrency=1 src/financial-data-gap-reader-test.ts src/growth-finance-module-test.ts src/acquisition-cost-ledger-router-test.ts src/financial-fact-router-test.ts src/finance-import-router-test.ts src/acquisition-performance-router-test.ts`

Expected: FAIL because the C0-frozen paths are not yet mounted; the public schemas already exist and remain unchanged in this task.

- [ ] **Step 3: Implement routes and public projections against C0's frozen contract**

Mount exactly these endpoint families:

```text
GET/POST /api/v1/acquisition/cost-entries
GET/POST /api/v1/acquisition/cost-estimates
POST /api/v1/acquisition/cost-estimates/:id/activate
POST /api/v1/acquisition/cost-estimates/:id/supersede
POST /api/v1/acquisition/cost-entries/:id/verify|reject|reverse|correct
GET/POST /api/v1/finance/facts
POST /api/v1/finance/facts/:id/verify|reject|reverse|correct
GET /api/v1/finance/import-templates/:kind
POST /api/v1/finance/imports/preview
POST /api/v1/finance/imports/:previewId/commit
GET /api/v1/finance/imports/:id
GET /api/v1/finance/imports/:id/errors
```

Use standard error envelopes and closed error codes: `financial_fact_duplicate`, `financial_fact_unverified`, `financial_fact_conflict`, `financial_fact_amount_invalid`, `amount_out_of_range`, `ledger_revision_conflict`, `ledger_decision_already_recorded`, `ledger_reversal_exceeds_balance`, `import_partial_success`, `stale_fencing_token`, `finance_import_authority_mismatch`, and `finance_import_preview_mismatch`. Return `Idempotency-Replayed: true` on matching replay. List endpoints use cursor pagination and concrete workspace scope.

Apply one closed capability matrix before any repository/domain call and repeat it in the invoked service/application boundary: every Finance HTTP `GET`, list, import-template/error export, and source-report read requires `ledger.pending.create`; cost/fact pending create, estimate draft/activate/supersede, import preview/commit, and source-report draft require `ledger.pending.create`; cost/fact verify/reject/reverse/correct require `ledger.verify`. Role names do not substitute for a current capability. A `sales` or `manager` without the exact capability receives `403 capability_forbidden` with zero reads that expose Finance data and zero writes; an `admin` succeeds only when its current concrete workspace context contains the capability. `authorizeAndProject` on every completed idempotency replay and `FinanceImportRecoveryAuthorizer.commandFor` on every recovered operation re-resolve current membership/capabilities and apply the same matrix before returning/claiming/writing. Revocation after the original success therefore blocks replay/recovery without leaking the frozen response or creating a new event. These HTTP/application checks are not applied to `GROWTH_FINANCE_SERVICES.verifiedAsOf` or `.financialGaps`: Advisor/ROI reach those token-only readers only after their own workspace/binding visibility authorization, and the readers retain exact binding-before-limit isolation rather than accepting an HTTP capability shortcut.

The commit route treats `:previewId` only as input to `FinanceImportService.queueCommit(context, previewId)`. That method verifies and freezes the preview/authority identity into an operation, after which the route claims by `operation.id` and calls only `worker.commit(context, claim)`. Neither the router body nor any Pi/tool input exposes workspace, actor, request hash, preview hash/version, lease owner, or fencing token. A matching request replay returns the frozen operation after current re-authorization; cross-workspace, changed-actor, changed-preview, or changed-hash attempts perform zero claim, row-result, or ledger writes.

`FinancialDataGapSealedReader` has no barrier dependency. It validates `context.workspaceId===input.cutoff.workspaceId`, derives temporal scope only from the exact token, and reduces the same append-only cost/fact/import/binding lifecycle events used by authoritative readers using only `cutoff.effectiveAsOf`, applying both `businessOccurredAt<=effectiveAsOf` and `recordedAt<=effectiveAsOf`. It maps only to the four exact `FinancialDataGapSourceType` values: cost rows → `cost_entry`, fact/payment/COGS rows → `financial_fact`, preview/operation rows → `finance_import`, and binding validation evidence → `commercial_binding`. Unknown decoded source values fail closed with `financial_data_gap_source_invalid` rather than widening or returning raw storage text.

`listForBindingsAt` validates bounded/deduplicated `visibility.candidateIds`, `.customerIds`, `.dealIds`, and `.cohortIds`, derives workspace only from the matching context/token, and returns `[]` without scanning when all four authorized sets are empty. Before stable `(recordedAt,sourceType,sourceId,code)` ordering and `LIMIT <= 100`, its SQL applies `workspace_id + currency + recorded/business cutoff`, requires at least one non-null binding, and uses conjunctions of `(candidate_id IS NULL OR candidate_id IN authorizedCandidates)`, `(customer_id IS NULL OR customer_id IN authorizedCustomers)`, `(deal_id IS NULL OR deal_id IN authorizedDeals)`, and `(cohort_id IS NULL OR cohort_id IN authorizedCohorts)`; it never authorizes a row merely because one of several bindings matches, and never globally limits then filters in memory. Thus more than 100 unrelated gaps cannot hide an authorized user's gap. `verifyAt` uses an indexed exact `(workspaceId,sourceType,sourceId)` source lookup, reconstructs that source at the token cutoff, then applies the identical all-non-null-bindings predicate before comparing exact gap code/hash/cohort association. A guessed same-workspace source belonging only to another sales actor, a customer-only row for another sales actor, and mixed rows such as `candidateId=mine` plus `customerId|dealId|cohortId=otherSales` all return null. The memory/MySQL contract suite covers every mixed combination plus the inverse and requires zero leaked rows. It never scans a page or accepts a raw/unknown source type. `FinancialDataGapAsOfReader` is the only object that receives `foundation.temporalBarrier`; each standalone public/HTTP method first requires current `ledger.pending.create`, derives visibility from current server authority, freezes `readStartedAt=this.now()`, obtains the authorized/clamped `effectiveAsOf` through `assertGrowthAsOfNotFuture(input.asOf,readStartedAt,1_000)`, seals exactly once, and forwards the identical token into the sealed reader. Capability or invalid/far-future input performs zero barrier/reader calls. The internal `FinancialDataGapSealedReader` has no HTTP capability dependency and is reached by Advisor only after its binding/visibility authorization. Neither reader infers a missing amount with AI. A later verify/reverse/correct/import event is effective only at or after its workspace-global `recordedAt/temporalSequence` and cannot alter the sealed result.

`createGrowthFinanceModule.install({ router, privateServices })` first requires the exact Foundation-owned `GROWTH_FOUNDATION_SERVICES` and Quote-owned `GROWTH_QUOTE_AUTHORITY_READERS`, uses Foundation's HTTP idempotency/settings/temporal barrier plus Quote's `commercialBindingVerifier`/`dealAuthoritativeQuotes`, then constructs ledger, sealed readers, public as-of wrappers, import repository/worker and recovery sweeper exactly once. Every Finance write service/transaction adapter and public as-of wrapper receives the exact same `foundation.temporalBarrier` reference; internal sealed readers receive no barrier and therefore cannot reseal. `GrowthFinanceModuleOptions` cannot replace it or inject another temporal/HLC adapter. The production composition supplies `options.recoveryAuthorizer`, which resolves the persisted workspace/requesting actor against current C0 authorization and never trusts a stored capability list. Missing either private key fails before repository construction, timer start, or route mounting.

Before constructing the first Finance-owned resource, create one reverse-order close stack plus its idempotent `closeFinanceResources=onceAsync(...)`. Run **every** constructor and every provide/mount/start action inside the same local `try`; immediately after each successful constructor, push that resource's close handle before constructing the next. If constructor N throws, the catch drains N-1 through 1 in strict reverse order, rethrows the original error with cleanup failures attached, and leaves zero private provide, route mount, worker/heartbeat, or timer. After construction, provide services, mount all three routers, and call `recoverySweeper.start()` as the final fallible installation action. Any later failure awaits the same close handle, which stops/drains a partially started sweeper, waits for worker heartbeats/in-flight commits, and closes readers/repositories/pool once. A failed application graph is never returned or published; the success path returns that same handle. Add this module once after Quote in `growth-commercial-composition.ts`. Do not modify the C0 application kernel, mount a second handler in `server.ts`, create services in `growth-commercial-runtime-bridge.ts`, or add finance properties to `GrowthCommercialToolPorts`.

The minimal GREEN composition is one edit to the C0-owned application graph:

```ts
const ownedCloseStack: Array<() => void | Promise<void>> = [];
const closeFinanceResources = onceAsync(async () => {
  const failures: unknown[] = [];
  for (let index = ownedCloseStack.length - 1; index >= 0; index -= 1) {
    try { await ownedCloseStack[index]!(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, "growth_finance_close_failed");
});

try {
  const pool = await options.createPool();
  ownedCloseStack.push(() => pool.end());

  const repositories = await options.createRepositories({
    pool, foundation, quoteAuthorityReaders
  });
  ownedCloseStack.push(() => repositories.close());
  const {
    costLedger, financialFacts, imports, importRepository
  } = repositories;

  const verifiedAsOf = new MysqlVerifiedFinancialLedgerSealedReader(pool);
  const verifiedPublicAsOf = new VerifiedFinancialLedgerAsOfBoundary({
    temporalBarrier: foundation.temporalBarrier,
    sealedReader: verifiedAsOf
  });
  const financialGaps = new MysqlFinancialDataGapSealedReader({
    pool, verifiedLedger: verifiedAsOf
  });
  const financialGapsPublicAsOf = new FinancialDataGapAsOfBoundary({
    temporalBarrier: foundation.temporalBarrier,
    sealedReader: financialGaps
  });

  const importWorker = new FinanceImportWorker({
    repository: importRepository,
    authority: options.importAuthority,
    foundation
  });
  ownedCloseStack.push(() => importWorker.close());

  const recoverySweeper = new FinanceImportRecoverySweeper({
    repository: importRepository,
    worker: importWorker,
    authorizer: options.recoveryAuthorizer,
    workerId: options.processWorkerId,
    intervalMs: options.recoveryIntervalMs ?? 5_000,
    batchSize: options.recoveryBatchSize ?? 25,
    now: options.now ?? (() => new Date().toISOString()),
    onError: options.onRecoveryError ?? (() => undefined)
  });
  ownedCloseStack.push(() => recoverySweeper.close());

  const acquisitionRouter = createAcquisitionCostLedgerRouter({
    costLedger, workspaceContext: foundation.workspaceContext,
    commandContextFactory: foundation.commandContextFactory,
    verifiedPublicAsOf
  });
  const financialFactRouter = createFinancialFactRouter({
    financialFacts, workspaceContext: foundation.workspaceContext,
    commandContextFactory: foundation.commandContextFactory,
    verifiedPublicAsOf, financialGapsPublicAsOf
  });
  const financeImportRouter = createFinanceImportRouter({
    imports, workspaceContext: foundation.workspaceContext,
    commandContextFactory: foundation.commandContextFactory
  });
  const financeServices: GrowthFinanceServices = Object.freeze({
    costLedger, financialFacts, imports, verifiedAsOf, financialGaps
  });
  privateServices.provide(GROWTH_FINANCE_SERVICES, financeServices);
  router.use("/api/v1/acquisition", acquisitionRouter);
  router.use("/api/v1/finance", financialFactRouter);
  router.use("/api/v1/finance", financeImportRouter);
  recoverySweeper.start(); // last fallible installation action
  return { close: closeFinanceResources };
} catch (installationError) {
  let cleanupError: unknown;
  try { await closeFinanceResources(); }
  catch (error) { cleanupError = error; }
  if (cleanupError !== undefined && installationError instanceof Error) {
    Object.defineProperty(installationError, "cleanupError", { value: cleanupError });
  }
  throw installationError;
}
```

`growth-finance-module-test.ts` asserts all three routers receive the exact Foundation `workspaceContext` and `commandContextFactory` references by identity, every write service/transaction adapter/public as-of wrapper captures the exact `foundation.temporalBarrier` object, internal sealed readers capture no barrier, and `GrowthFinanceModuleOptions` cannot replace any Foundation adapter. It rejects a structurally identical lookalike barrier and proves no Finance-owned HLC/barrier is constructed. `GROWTH_FINANCE_SERVICES.verifiedAsOf` and `.financialGaps` are the exact sealed singleton readers used by Advisor, including identity of `getVerifiedAt`/`verifyAt` rather than public wrappers or list-page adapters. Counting/spy tests prove the public wrapper seals once, the sealed reader sees the same token object, and a shared Advisor token causes zero Finance seal calls. The sweeper starts exactly once and only after successful provide plus all mounts; a missing Foundation/Quote private key mounts no routes and starts no timer; a second module installation is rejected. Inject failure at every owned constructor position, then independently at `privateServices.provide`, each router mount, and `recoverySweeper.start` (including start-after-timer-allocation). Constructor N failure must leave zero provide/mount/tool/timer and close N-1 through 1 in strict reverse order once; every later failure uses the same handle, leaves zero timers, and closes all current resources once. Application shutdown waits for an in-flight recovered import before closing the repository. Repeated runtime `close()` calls, and calling the returned close after an installation cleanup attempt, leave zero timers and execute every owned close handle once.

Replace the earlier incremental MySQL script with this final cumulative, explicitly named release suite only after every referenced test file exists:

```json
{
  "scripts": {
    "test:growth-finance:mysql": "NODE_ENV=test TZ=UTC JWT_SECRET=goodjob-growth-finance-test-secret-at-least-32-characters node --import tsx --test --test-concurrency=1 src/financial-ledger-domain-test.ts src/acquisition-cost-ledger-test.ts src/financial-ledger-as-of-reader-test.ts src/growth-finance-mysql-test.ts src/financial-ledger-as-of-mysql-reader-test.ts src/acquisition-cost-estimate-service-test.ts src/acquisition-cost-evidence-projection-test.ts src/acquisition-cost-estimate-as-of-reader-test.ts src/financial-fact-ledger-test.ts src/financial-ledger-repository-contract-test.ts src/secure-spreadsheet-artifact-test.ts src/finance-import-service-test.ts src/finance-import-worker-test.ts src/finance-import-recovery-sweeper-test.ts src/growth-finance-import-mysql-test.ts src/financial-data-gap-reader-test.ts src/growth-finance-module-test.ts src/acquisition-cost-ledger-router-test.ts src/financial-fact-router-test.ts src/finance-import-router-test.ts src/growth-finance-contract-route-test.ts src/growth-finance-openapi-response-conformance-test.ts"
  }
}
```

Command routers build `CommandContext` only through `foundation.commandContextFactory` and never accept workspace, actor, capability, idempotency hash, or expected revision from JSON bodies. Each router strictly parses path identifiers before the factory call and passes a closed frozen `pathParams` map: cost/fact/estimate actions use `{id}`, import commit uses `{previewId}`, import read/error uses `{id}`, and collection routes use `{}`. The Foundation factory key-sorts that map into `requestHash`; same key/body/revision against `cost-a` then `cost-b`, `fact-a` then `fact-b`, or `preview-a` then `preview-b` returns `idempotency_conflict` before any second domain/operation write. Read ports obtain the identical `req.activeWorkspace` through `foundation.workspaceContext`, re-authorize on every replay, and project only capability-permitted fields. `GrowthFinanceModuleOptions` cannot inject replacement request-context factories.

Use `backend/src/growth-finance-contract-route-test.ts` to load `contracts/openapi/growth-advisor-quote-roi.v1.yaml`, assert every mounted method/path/required header already exists, and fail if implementation DTO keys diverge from the frozen schema. Use `backend/src/growth-finance-openapi-response-conformance-test.ts` with Ajv to validate real 200/201/409/412/422 responses. A schema mismatch is a C0 contract defect that must be fixed in the C0 plan, not by adding a second schema here. Do not add any stage-3 property to the old performance response.

- [ ] **Step 4: Run focused routes, frozen-contract conformance, full acquisition tests, and build**

Run:

```bash
cd /Users/mac/Documents/外贸/GoodJob-1.09/.worktrees/goodjob-growth-advisor-quote-roi
npm run test:contracts
cd backend && npm run test:growth-finance:imports && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-finance:mysql && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/growth-finance-module-test.ts src/growth-finance-contract-route-test.ts src/growth-finance-openapi-response-conformance-test.ts
cd ..
npm run test:growth-openapi --workspace backend
npm run check:growth-contract-release
npm run check:growth-contracts
npm run test:acquisition --workspace backend
npm run build
git diff --check
```

Expected: every command exits 0; `git diff --check` prints nothing; old `/performance` contract and response tests remain byte-for-byte behaviorally compatible.

- [ ] **Step 5: Commit the stage-3 public surface**

```bash
git add backend/src/acquisition-cost-ledger-router.ts backend/src/acquisition-cost-ledger-router-test.ts backend/src/financial-fact-router.ts backend/src/financial-fact-router-test.ts backend/src/finance-import-router.ts backend/src/finance-import-router-test.ts backend/src/financial-data-gap-reader.ts backend/src/financial-data-gap-reader-test.ts backend/src/growth-finance-module.ts backend/src/growth-finance-module-test.ts backend/src/growth-commercial-composition.ts backend/src/growth-finance-openapi-response-conformance-test.ts backend/src/growth-finance-contract-route-test.ts backend/src/growth-finance-router-test-support.ts backend/package.json
git commit -m "feat: register growth finance ledger APIs"
```

## Execution Order and Review Gates

1. Tasks 1–3 establish the shared append-only ledger and MySQL concurrency semantics.
2. Task 4 may begin after Task 3; it must finish before stage-4 expected-cost aggregation.
3. Tasks 5–6 require stage-2 authoritative quote and binding ports and must finish before any actual ROI work.
4. Task 7 is a behavior-preserving extraction and must be reviewed independently before finance import code uses it.
5. Tasks 8–9 build preview then fenced commit; Task 9 cannot bypass Task 2/5 services.
6. Task 10 publishes only after Tasks 1–9 pass in both memory and MySQL.

The implementation is stage-3 complete only when a manually entered or imported positive cost/fact is pending, auditable, verifiable, reversible/correctable without mutation, replay-safe, workspace-isolated, and visible through a strict contract. No stage-3 result may claim actual ROI.
