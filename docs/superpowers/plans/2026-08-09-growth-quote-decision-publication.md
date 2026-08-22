# Growth Quote Decision and Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn one acquisition candidate or CRM Deal into a deterministic, immutable, human-approved authoritative QuoteVersion, then recoverably publish its PI and CRM event and expose controlled quote tools to the existing Pi agent.

**Architecture:** A pure quote calculator produces versioned hashes and approval gates from frozen catalog policy data; persistence services append QuoteCase, QuoteVersion, lifecycle, approval, Deal authority, and publication records through dedicated repositories. Every transaction first holds Foundation's workspace temporal barrier; approval then follows fixed domain lock order `DealAuthoritativeQuote → QuoteCase`. A leased/fenced Worker projects the approved version to legacy PI and CRM through specialized command ports, while the existing Outcome Reconciler remains the only commercial Outcome writer. The single Growth commercial application constructs catalog/quote services once and registers closed handlers on `GrowthCommercialToolPorts`; the existing Acquisition Pi runtime receives only that registry.

**Tech Stack:** TypeScript 5.7, Node.js 22 test runner, Express 4, Zod 3.23, TypeBox 1.1, MySQL 8 through mysql2 3.22, BigInt fixed point, SHA-256 canonical snapshots, existing Pi Agent Core 0.81, existing acquisition tool audit/idempotency runtime.

## Global Constraints

- Execute `docs/superpowers/plans/2026-08-09-growth-contract-and-frontend.md` Tasks 1-3, `2026-08-09-growth-foundation-and-authority.md`, and `2026-08-09-growth-catalog-pricing.md` first.
- The canonical Growth OpenAPI, JSON Schemas, release/hash, `growth-openapi.ts`, bootstrap, and runtime bridge belong only to the contract plan; this plan implements domain/router/application behavior and runtime response conformance against that frozen release.
- If a required response cannot conform to the frozen release, stop and publish a new release through C0 before changing runtime behavior.
- Do not modify `contracts/openapi/ai-acquisition.v1.yaml`, `backend/src/acquisition-openapi.ts`, or generated legacy frontend files.
- `QuoteVersion` is the only authoritative acquisition commercial quote; frontend and LLM inputs never supply calculated totals, floor, margin, contribution, approval result, or commercial hashes.
- Initial API accepts exactly one top-level CatalogItem; package components expand only into a frozen cost snapshot.
- Money is ISO 4217 minor-unit safe integer, quantity is positive `quantityMicros`, BPS is integer; all intermediate multiplication/division uses BigInt and the functions in `growth-money.ts`.
- Absolute floor compares `netProductAmountMinor` before surcharge; required surcharge cannot hide a below-floor product price.
- Hard blocks cannot be approved. Rule-compliant quotes still require confirmation by a different human. Exception approval requires all merged capabilities and also forbids self-decision.
- AI may preview, explain, save a draft, and create a human approval task; it cannot approve, reject on behalf of a human, change policy/floor/cost, publish PI, send a document, or mark a Deal won/lost.
- Every write uses `CommandContext`, `Idempotency-Key`, current capability checks, current-workspace projection, and a stable canonical request hash; mutable transitions additionally require exact `If-Match`. Foundation's hash includes strictly parsed, key-sorted `pathParams`; a Quote/Deal/Publication/PI ID is never represented only by the canonical route template.
- Every nested candidate/customer/deal/handoff/catalog/policy/assessment/quote reference must belong to the same concrete workspace and authoritative relationship chain.
- Candidate-only QuoteCase may hold drafts, but submission requires one frozen CommercialBindingSnapshot and a valid ProbabilityAssessment.v2.
- Legacy rounded-percentage FinancialValue decisions are marked `legacy_percent_precision`; they cannot be multiplied by 100 and cannot enter formal expected ROI.
- QuoteVersion content is immutable. Saving creates an immutable `draft` row with no probability snapshot; submitting never updates that row and instead appends a distinct immutable `formal` QuoteVersion that points to the source draft and freezes the current ProbabilityAssessment.v2. Status is reconstructed from each version's append-only QuoteLifecycleEvent revisions; Deal authority history is reconstructed from DealAuthoritativeQuoteEvent revisions, not timestamps.
- Calculation `effectiveAt`, client business `occurredAt`, request `attemptedAt`, and append `recordedAt` are distinct. Every Quote business transaction adapter implements Foundation's exact `GrowthTemporalTransaction`; after HTTP reservation/current authorization it calls `foundation.temporalBarrier.allocateAppend(tx,workspaceId)` only after the workspace temporal barrier is the first business lock, and holds that lock through commit. Preview evidence, Case/version, lifecycle, approval, Deal-authority, publication-operation/state-history, PI/CRM projection evidence and decision appends each receive a workspace-global strictly increasing `{recordedAt,temporalSequence}`; a multi-row transaction calls `allocateAppend` successively. Quote never implements another HLC or derives authority time from a stream/client/request clock. An HTTP/Pi/Advisor request boundary first derives the authorized Foundation effective cutoff (never an unchecked client-future value), calls `foundation.temporalBarrier.sealReadCutoff(context,effectiveAsOf)` exactly once, and receives the opaque Foundation-owned `GrowthSealedReadCutoff { workspaceId; effectiveAsOf; temporalSequence }`; it passes that same token by identity to every internal Quote as-of reader. Internal readers never seal again, never accept a raw cutoff string, validate token workspace against context, and query only `cutoff.effectiveAsOf`. The short seal waits for earlier writers and advances the workspace tail to at least the cutoff, so any later new-stream or clock-rollback append is strictly after it. Sequence/revision remains only a legacy decoder.
- Approval locks `DealAuthoritativeQuote` before `QuoteCase`; `(workspaceId,quoteVersionId,lifecycleRevision)` and `(workspaceId,dealId,authorityRevision)` are unique.
- Approval, supersession, authority pointer/event, approval decision, and QuotePublicationOperation are committed in one MySQL transaction.
- Publication side effects use `dealId + quoteVersionId + dealAuthorityRevision` and recheck current authority before every PI/CRM write.
- Worker lease/fencing, heartbeats, stale recovery, retries, and stable business keys must prevent duplicate PI, DealEvent, and Outcome under two workers, ACK loss, or crash recovery.
- Worker never writes Acquisition Outcome. Existing CRM Outcome Reconciler is the sole `DealEvent.quote/won/lost → Outcome` writer and requires the internal capability plus verified authority/hash.
- `won/lost` and `pre_quote_disqualified` execute only through `POST /api/v1/quotes/deals/:dealId/decision`; all relevant old Deal/PI/Outcome routes remain guarded.
- No new quote/catalog/outbox object is added to `CrmStore.persistAll/replaceRows`; legacy Deal/PI projections use specialized atomic store commands.
- The single runtime instance is created first, installed into `GrowthCommercialRuntimeBridge`, and its `growthRuntime.toolPorts` are injected into `createAcquisitionApplication`; Pi never constructs a second CatalogService or QuoteService.
- Close order is the reverse of startup: acquisition runtime, then growth runtime, then store.
- No external frontend implementation is included in this plan.
- Every real Quote MySQL concurrency/tracer suite uses `MYSQL_TEST_ADMIN_URL` to create and drop an isolated temporary database. The stable `test:growth-quotes` gate includes that suite, fails rather than skips when the variable is absent, and prints `MYSQL_INTEGRATION_EXECUTED:growth-quotes:<database>` only after real two-connection assertions complete.

---

### Task 1: Deterministic quote calculation and approval gate evaluation

**Files:**
- Create: `backend/src/quote-domain.ts`
- Create: `backend/src/quote-calculation-service.ts`
- Create: `backend/src/quote-calculation-service-test.ts`
- Create: `backend/src/growth-quote-test-fixtures.ts`

**Interfaces:**
- Consumes: `PricingPolicyVersion`, `PackageVersion`, `PackageComponent`, `GrowthCapability`, and all `growth-money.ts` functions.
- Produces: `QUOTE_FORMULA_VERSION = "quote-calculation.v1"`, `QUOTE_INPUT_SCHEMA_VERSION = "quote-input.v1"`, and `COMMERCIAL_AMOUNT_HASH_SCHEMA_VERSION = "commercial-amount.v1"`.
- Produces: `QuoteCalculationInput { workspaceId; catalogItemId; pricingPolicyVersionId; quantityMicros; offeredUnitPriceMinor; orderDiscountMinor; paymentTermDays; giftItems; surchargeContext; customerTargetPriceMinor; creditRiskBps; manualEscalation }`; package snapshots are trusted dependencies and never client input. The orchestration service supplies a server-recorded operation instant to Catalog validation instead of accepting a client pricing/effective timestamp.
- Produces: `QuoteCalculationDependencies { giftPolicies: readonly FrozenGiftPolicy[]; packageSnapshot: PackageCostSnapshot | null }`; a package snapshot carries the frozen total per-unit cost plus component evidence, but the calculator never adds component cost separately.
- Produces: `QuoteCalculationResult` with every approved design amount/BPS, `minimumAllowedQuotedAmountMinor`, `recommendedOpeningQuotedAmountMinor`, frozen line/package/gift/policy snapshots, `inputSnapshotHash`, `calculationHash`, `commercialAmountHash`, and `gate`.
- Produces: `createCommercialAmountHash({ currency, quotedAmountMinor, catalogItemId, quantityMicros, pricingPolicyVersionId, calculationHash }): \`sha256:${string}\`` over canonical JSON plus `COMMERCIAL_AMOUNT_HASH_SCHEMA_VERSION`; any amount/currency/version change changes the hash.
- Produces: `QuoteGate = { status:"hard_blocked"|"confirmation_required"|"exception_approval_required"; reasons: readonly QuoteApprovalReason[]; requiredCapabilities: readonly GrowthCapability[] }`.
- Produces: `QuoteCalculationService.preview(input, policy, dependencies): QuoteCalculationResult`; it is pure and has no clock, model, HTTP, or repository dependency.
- Produces shared tests: `quotePolicyFixture(overrides?)`, `quoteInputFixture(overrides?)`, `workspaceContextFixture(role, capabilities?, actorId?)`, and `commandContextFixture(overrides?)` from `growth-quote-test-fixtures.ts`; the optional actor ID is required by same-workspace multi-sales visibility tests and defaults deterministically when omitted.

- [ ] **Step 1: Write failing formula, edge, and gate tests**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { QuoteCalculationService } from "./quote-calculation-service.js";
import { quoteInputFixture, quotePolicyFixture } from "./growth-quote-test-fixtures.js";

test("calculates one top-level quote with deterministic integer formulas", () => {
  const result = new QuoteCalculationService().preview(
    quoteInputFixture({
      quantityMicros: 1_000_000,
      offeredUnitPriceMinor: 9_000,
      orderDiscountMinor: 0,
      paymentTermDays: 30
    }),
    quotePolicyFixture({
      listUnitPriceMinor: 10_000,
      unitStandardCostMinor: 6_000,
      defaultOrderDeliveryCostMinor: 1_000,
      defaultOrderSalesCostMinor: 500,
      defaultOrderServiceCostMinor: 200,
      absoluteFloorUnitPriceMinor: 7_000,
      absoluteMinimumGrossMarginBps: 1_000
    }),
    { giftPolicies: [], packageSnapshot: null }
  );
  assert.equal(result.listAmountMinor, 10_000);
  assert.equal(result.quotedAmountMinor, 9_000);
  assert.equal(result.estimatedFulfillmentCostMinor, 7_000);
  assert.equal(result.estimatedGrossProfitMinor, 2_000);
  assert.equal(result.grossMarginBps, 2_222);
  assert.equal(result.estimatedContributionMinor, 1_300);
  assert.equal(result.discountBps, 1_000);
  assert.equal(result.minimumAllowedQuotedAmountMinor, 7_778);
  assert.match(result.calculationHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(result.commercialAmountHash, /^sha256:[a-f0-9]{64}$/u);
});

test("fractional quantity floors use ceiling before surcharge", () => {
  const result = new QuoteCalculationService().preview(
    quoteInputFixture({
      quantityMicros: 1_500_000,
      offeredUnitPriceMinor: 333,
      orderDiscountMinor: 1,
      surchargeContext: { region: "CN-FJ", deliveryMethod: "onsite" }
    }),
    quotePolicyFixture({
      listUnitPriceMinor: 400,
      unitStandardCostMinor: 100,
      absoluteFloorUnitPriceMinor: 333,
      surchargePolicies: [{
        kind: "region", condition: "CN-FJ",
        fixedAmountMinor: 1_000, unitAmountMinor: 0
      }]
    }),
    { giftPolicies: [], packageSnapshot: null }
  );
  assert.equal(result.absoluteFloorAmountMinor, 500);
  assert.equal(result.netProductAmountMinor, 499);
  assert.equal(result.surchargeMinor, 1_000);
  assert.equal(result.gate.status, "hard_blocked");
  assert.equal(result.gate.reasons.some((reason) =>
    reason.code === "absolute_floor_breached"), true);
});

test("a non-positive quote returns only the closed diagnostic branch", () => {
  const result = new QuoteCalculationService().preview(
    quoteInputFixture({
      quantityMicros: 1_000_000,
      offeredUnitPriceMinor: 100,
      orderDiscountMinor: 250
    }),
    quotePolicyFixture(),
    { giftPolicies: [], packageSnapshot: null }
  );
  assert.equal(result.amountState, "non_positive_diagnostic");
  assert.equal(result.diagnosticNetProductAmountMinor, -150);
  assert.equal(result.diagnosticQuotedAmountMinor, -150);
  assert.equal(result.grossMarginBps, null);
  assert.equal(result.gate.status, "hard_blocked");
  assert.equal(result.gate.reasons[0]?.code, "quoted_amount_not_positive");
  assert.equal("netProductAmountMinor" in result, false);
  assert.equal("quotedAmountMinor" in result, false);
});
```

Add tests for JPY/CNY/KWD registries, quantity greater than one, 9999 BPS minimum margin, zero/negative quote, unsafe amount, invalid BPS, absolute discount/term/gift hard blocks, normal confirmation, combined discount+margin+payment+gift+credit+manual exception capabilities, required surcharge rules, package cost not double-counted, stable canonical hashes, commercial amount hash changing on amount/currency/policy/calculation changes, and property loops asserting hard-blocked output whenever net product or margin floor is breached.

Add an explicit package quantity test: with frozen package `totalUnitStandardCostMinor=5_000`, top-level `quantityMicros=1_500_000`, and component details summing to `4_000` per unit, `lineStandardCostMinor` is exactly `7_500`, never `5_000`, `6_000`, or `13_500`. Repeat at `quantityMicros=2_000_000` and assert `10_000`.

Add a signed-margin golden test with quoted amount `5_000`, fulfillment cost `6_000`, sales cost `200`, and service cost `300`: `estimatedGrossProfitMinor=-1_000`, `grossMarginBps=-2_000`, and `estimatedContributionMinor=-1_500`. Also prove a non-positive internal quoted result is projected to the closed `non_positive_diagnostic` branch before any division. Normal price, cost, discount, surcharge, and floor fields remain nonnegative; diagnostic signed intermediates are never QuoteVersion prices, and only profit, contribution, their ratios, plus the explicitly named diagnostic fields use signed-safe helpers.

Add boundary tests where each individual input is a safe integer but `offeredLineAmountMinor - orderDiscountMinor`, `netProductAmountMinor + surchargeMinor`, `lineStandardCostMinor + giftCostMinor + deliveryCostMinor`, or the 9999-BPS minimum-margin numerator/result would exceed the safe-integer range. Every case must fail closed with the exact `amount_out_of_range` code; no intermediate `Number(...)` conversion or unchecked number addition is permitted.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/quote-calculation-service-test.ts`

Expected: FAIL because `quote-domain.ts`, calculator, and quote fixtures do not exist.

- [ ] **Step 3: Implement the calculation core**

```ts
const listAmountMinor = multiplyQuantityMinor(
  policy.listUnitPriceMinor, input.quantityMicros, "half_up"
);
const offeredLineAmountMinor = multiplyQuantityMinor(
  input.offeredUnitPriceMinor, input.quantityMicros, "half_up"
);
const frozenUnitStandardCostMinor = dependencies.packageSnapshot
  ? dependencies.packageSnapshot.totalUnitStandardCostMinor
  : policy.unitStandardCostMinor;
const lineStandardCostMinor = multiplyQuantityMinor(
  frozenUnitStandardCostMinor, input.quantityMicros, "half_up"
);
const absoluteFloorAmountMinor = multiplyQuantityMinor(
  policy.absoluteFloorUnitPriceMinor, input.quantityMicros, "ceil"
);
const diagnosticNetProductAmountMinor = safeSignedInteger(
  BigInt(offeredLineAmountMinor) - BigInt(input.orderDiscountMinor),
  "diagnosticNetProductAmountMinor"
);
const diagnosticQuotedAmountMinor = safeSignedInteger(
  BigInt(diagnosticNetProductAmountMinor) + BigInt(surchargeMinor),
  "diagnosticQuotedAmountMinor"
);
const estimatedFulfillmentCostMinor = safeMinor(
  BigInt(lineStandardCostMinor) + BigInt(giftCostMinor)
    + BigInt(policy.defaultOrderDeliveryCostMinor),
  "estimatedFulfillmentCostMinor"
);
const minimumMarginPriceMinor = safeMinor(ceilDiv(
  BigInt(estimatedFulfillmentCostMinor) * 10_000n,
  BigInt(10_000 - policy.absoluteMinimumGrossMarginBps)
), "minimumMarginPriceMinor");
if (diagnosticNetProductAmountMinor <= 0 || diagnosticQuotedAmountMinor <= 0) {
  return nonPositiveDiagnosticQuoteResult({
    diagnosticNetProductAmountMinor,
    diagnosticQuotedAmountMinor,
    reason: diagnosticQuotedAmountMinor <= 0
      ? "quoted_amount_not_positive"
      : "net_product_amount_not_positive"
  });
}
const netProductAmountMinor = safeMinor(
  BigInt(diagnosticNetProductAmountMinor), "netProductAmountMinor"
);
const quotedAmountMinor = safeMinor(
  BigInt(diagnosticQuotedAmountMinor), "quotedAmountMinor"
);
const estimatedGrossProfitMinor = safeSignedInteger(
  BigInt(quotedAmountMinor) - BigInt(estimatedFulfillmentCostMinor),
  "estimatedGrossProfitMinor"
);
const grossMarginBps = safeSignedInteger(roundSignedHalfUpDiv(
  BigInt(estimatedGrossProfitMinor) * 10_000n,
  BigInt(quotedAmountMinor)
), "grossMarginBps");
const estimatedContributionMinor = safeSignedInteger(
  BigInt(estimatedGrossProfitMinor)
    - BigInt(policy.defaultOrderSalesCostMinor)
    - BigInt(policy.defaultOrderServiceCostMinor),
  "estimatedContributionMinor"
);
```

`nonPositiveDiagnosticQuoteResult` is the only constructor for the closed diagnostic `QuotePreviewResult` branch. It preserves allowlisted calculated inputs/costs, exposes only the explicitly named signed diagnostic intermediates, sets `grossMarginBps=null` because division by a non-positive quote is undefined, emits the hard-block reason, and omits the normal net/quoted price fields. Draft/formal creation, approval, publication, PI, CRM and ROI accept only `amountState:"actionable"` with `quotedAmountMinor>0`; passing a diagnostic identity fails `quote_not_actionable` with zero writes. Validate every request money/BPS/quantity input as a safe integer before its first `BigInt` conversion. Perform every subtraction, addition, ratio numerator and ceiling in `bigint`, then cross the runtime boundary exactly once through `safeMinor` for nonnegative price/cost amounts or `safeSignedInteger` for diagnostic/profit/contribution values. Import `roundSignedHalfUpDiv` and `safeSignedInteger` from the foundation-owned `growth-money.ts`; do not weaken the unsigned price helpers, use `Number(ceilDiv(...))`, or create a second rounding implementation. Compute gate reasons in a fixed code order, sort/deduplicate required capabilities, and hash canonical input plus exact policy/package/gift snapshots and formula/schema versions. Do not include timestamps in calculation hashes.

- [ ] **Step 4: Verify GREEN**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/quote-calculation-service-test.ts && npm run build`

Expected: formula and gate tests plus build PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/quote-domain.ts backend/src/quote-calculation-service.ts backend/src/quote-calculation-service-test.ts backend/src/growth-quote-test-fixtures.ts
git commit -m "feat: calculate authoritative quote previews"
```

### Task 2: Lossless ProbabilityAssessment.v2 capture

**Files:**
- Create: `backend/src/probability-assessment.ts`
- Create: `backend/src/probability-assessment-test.ts`
- Create: `backend/src/probability-assessment-mysql-repository.ts`
- Create: `backend/src/probability-assessment-mysql-repository-test.ts`
- Modify: `backend/src/growth-quote-test-fixtures.ts`
- Modify: `backend/src/acquisition-domain-repository.ts`
- Modify: `backend/src/acquisition-domain-repository-transaction-test.ts`
- Modify: `backend/src/acquisition-domain-service.ts`
- Modify: `backend/src/acquisition-domain-test.ts`
- Modify: `backend/src/acquisition-v1-router.ts`
- Modify: `backend/src/acquisition-v1-router-test.ts`
- Modify: `backend/src/acquisition-tool-executor.ts`
- Modify: `backend/src/acquisition-tool-executor-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`
- Create: `backend/src/growth-quote-module.ts`
- Create: `backend/src/growth-quote-module-test.ts`
- Modify: `backend/src/growth-commercial-composition.ts`
- Modify: `backend/src/server.ts`

**Interfaces:**
- Consumes: the raw `FinancialValueInput.closeProbabilityBps` committed by the single application-owned `AcquisitionDomainService.qualifyCandidate`, the stable qualification decision ID/version/input hash returned by `commitQualificationBundle`, evidence IDs, rule version, and bound model snapshot. The HTTP qualification route and Pi executor call that same service instance; neither owns an after-hook.
- Consumes: Foundation's exact `GROWTH_FOUNDATION_SERVICES` and Catalog's exact `GROWTH_CATALOG_SERVICES`; Quote must install after both and reuse their singleton HTTP/settings/catalog ports.
- Produces: `ProbabilityAssessmentV2 { id; workspaceId; candidateId; dealId; closeProbabilityBps; qualificationDecisionId; qualificationDecisionVersion; evidenceRefs; ruleVersion; modelSnapshotRef; inputSnapshotHash; assessedAt; recordedAt; temporalSequence; precision:"bps" }`; `assessedAt` is frozen qualification business evidence, while `recordedAt/temporalSequence` come only from Foundation's workspace barrier at the assessment append transaction.
- Produces: `ProbabilityAssessmentRepository.append(record)`, `.findCurrent(workspaceId,candidateId,dealId?)`, and `.bindDeal(workspaceId,id,dealId,bindingHash)` with memory/MySQL parity.
- Produces: `ProbabilityAssessmentWriter.recordFromQualification(input): Promise<ProbabilityAssessmentV2>`; stable identity is workspace+candidate+qualification decision ID+decision version+input hash.
- Produces one application-owned qualification wrapper around the raw `AcquisitionDomainService`: its `qualifyCandidate` first delegates to the domain service/atomic `commitQualificationBundle`, then on both a fresh commit and an idempotent domain replay invokes the same required `ProbabilityAssessmentWriter` with the bundle's persisted raw BPS and stable decision identity/hash before returning. `createAcquisitionApplication` injects this wrapped instance into both `createAcquisitionV1Router` and `ProductionAcquisitionAgentToolExecutor`; the raw service remains a local constructor variable and is never returned, mounted, or injected elsewhere. No executor/router-specific callback exists.
- Produces: `createProbabilityAssessmentRepository(options): ProbabilityAssessmentRepository & ProbabilityAssessmentWriter`; `createGrowthQuoteModule` creates this one persistence object and provides it under typed private key `GROWTH_PROBABILITY_ASSESSMENTS`. Task 6, after constructing the document validator, assembles the final typed `GROWTH_QUOTE_ACQUISITION_INTEGRATIONS` object containing this exact writer and that exact validator; only that complete private object may be consumed by final `projectIntegrations`. The task-local qualification wiring test may inject this exact writer directly while the module is being built incrementally, but final production composition has no untyped/partial writer lookup or fallback. The projected integration contains only narrow Acquisition/server ports, never repositories or the private registry. It is not exposed as a Pi tool and does not add a property or tool name to the C0 `GrowthCommercialToolPorts` registry. `server.ts` only passes projected ports to their consumers; it never constructs either repository. The later `GROWTH_QUOTE_AUTHORITY_READERS` key remains separate.
- Extends shared test fixtures with `probabilityRecordFixture`, `acquisitionExecutorFixture`, `acquisitionHttpFixture`, and `qualifyToolCall`.

- [ ] **Step 1: Write failing lossless-capture and legacy-rejection tests**

```ts
test("Pi and HTTP qualification share lossless assessment capture", async () => {
  const writes: ProbabilityAssessmentV2[] = [];
  const app = acquisitionExecutorFixture({
    closeProbabilityBps: 4_321,
    probabilityAssessments: {
      async recordFromQualification(input) {
        const record = probabilityRecordFixture({
          closeProbabilityBps: input.financial.closeProbabilityBps
        });
        writes.push(record);
        return record;
      }
    }
  });
  await app.executor.execute(qualifyToolCall("candidate-pi"));
  await app.http.post("/api/v1/acquisition/candidates/candidate-http/qualification")
    .set("Idempotency-Key", "qualify-http-v2-0001")
    .send(app.qualificationBody({ closeProbabilityBps: 4_321 })).expect(202);
  assert.equal(writes.length, 2);
  assert.equal(writes[0]?.closeProbabilityBps, 4_321);
  assert.equal(writes[1]?.closeProbabilityBps, 4_321);
  assert.equal(writes[0]?.precision, "bps");
});

test("legacy rounded percentages are ineligible for formal quote submission", () => {
  assert.throws(
    () => assertFormalProbabilityAssessment({
      source: "legacy_percent_precision", closeProbabilityPercent: 43
    }),
    (error: unknown) => (error as { code?: string }).code
      === "probability_assessment_v2_required"
  );
});
```

Add tests for 0 and 10000 BPS, cross-workspace reads, model/rule/evidence snapshot hash, deal binding once, temporal-barrier-first assessment/bind writes with persisted sequence, and MySQL unique identity contention. Add an exact crash fixture where `commitQualificationBundle` durably writes Candidate+QualificationDecision+FinancialValueDecision, the assessment append fails before returning, and the same HTTP or Pi idempotency replay obtains the stable persisted decision ID/version/input hash and repairs exactly one v2 row without a second qualification/financial decision. Run the mirror path through HTTP first then Pi replay and Pi first then HTTP replay; both must converge on one row and prove the raw undecorated domain service was never reachable from router, executor, or application result. A missing projected writer may preserve legacy qualification, but `QuoteVersionService.submit` must reject with `probability_assessment_v2_required`; it may not synthesize v2 from the legacy rounded projection.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/probability-assessment-test.ts src/probability-assessment-mysql-repository-test.ts src/acquisition-domain-repository-transaction-test.ts src/acquisition-domain-test.ts src/acquisition-v1-router-test.ts src/acquisition-tool-executor-test.ts src/acquisition-application-test.ts`

Expected: FAIL because the v2 assessment modules, atomic bundle identity, and shared application qualification wrapper are absent.

- [ ] **Step 3: Implement immutable v2 persistence**

```ts
export interface ProbabilityAssessmentWriter {
  recordFromQualification(input: {
    workspaceId: string;
    candidateId: string;
    dealId: string | null;
    qualificationDecisionId: string;
    qualificationDecisionVersion: string;
    qualificationInputHash: `sha256:${string}`;
    evidenceRefs: readonly string[];
    ruleVersion: string;
    modelSnapshotRef: string | null;
    financial: { closeProbabilityBps: number };
    assessedAt: string;
  }): Promise<ProbabilityAssessmentV2>;
}
```

Create dedicated `probability_assessments_v2` with indexed workspace/candidate/deal and unique stable decision/input hash. Its append transaction implements the exact Task-3 `GrowthTemporalTransaction`, takes Foundation's workspace temporal barrier as its first business lock, calls the same `foundation.temporalBarrier.allocateAppend`, persists `recordedAt/temporalSequence`, and holds the barrier through commit. `bindDeal` uses the same barrier-first order and may fill a null deal once after validating binding; it never changes probability, evidence, or qualification identity. Refactor the existing qualification persistence to one repository `commitQualificationBundle` that also uses the same temporal-barrier-first transaction and atomically commits Candidate, QualificationDecision, FinancialValueDecision and audit using deterministic decision IDs plus one canonical input hash; it allocates each append successively, and its idempotent replay returns that same frozen bundle, including the original `financial.closeProbabilityBps`, rather than rebuilding it from a public percentage projection.

- [ ] **Step 4: Wire one application qualification service without route/executor hooks**

After the raw domain service returns the frozen committed bundle, the application wrapper delegates one record call using that bundle's original `financial.closeProbabilityBps`; do not reconstruct from `result.financialValue.factors.closeProbability`. Always invoke the idempotent writer after a domain replay so retry repairs a missing v2 record, and do not mark/return the qualification operation successful until this append succeeds. `createGrowthQuoteModule.install` first requires `GROWTH_FOUNDATION_SERVICES` and `GROWTH_CATALOG_SERVICES`, then constructs the repository/writer once, provides it to the private registry, and returns `closeQuoteResources`; missing dependencies fail before any repository, route or tool registration. Task 6 later projects this same reference only through the complete Quote integration key. In `server.ts`, pass the final required `growthRuntime.integrations.probabilityAssessments` and `growthRuntime.toolPorts` into `createAcquisitionApplication`; the application owns the only wrapper and neither `server.ts`, router, nor executor reconstructs it. An incremental test without the writer may preserve legacy qualification but exposes no formal-v2 authority; final production `projectIntegrations` rejects a missing Quote integration key instead of producing a partial runtime. Submission's exact current-decision lookup always fails closed when no v2 row exists. Tests assert Foundation→Catalog→Quote order, repository identity across the private service/final integration projection/shared qualification write, HTTP/Pi object identity, retry repair after commit-before-append, and exactly-once close.

- [ ] **Step 5: Verify GREEN**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/probability-assessment-test.ts src/probability-assessment-mysql-repository-test.ts src/acquisition-domain-repository-transaction-test.ts src/acquisition-domain-test.ts src/acquisition-v1-router-test.ts src/acquisition-tool-executor-test.ts src/acquisition-application-test.ts && npm run test:acquisition`

Expected: lossless BPS tests and all acquisition tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/probability-assessment.ts backend/src/probability-assessment-test.ts backend/src/probability-assessment-mysql-repository.ts backend/src/probability-assessment-mysql-repository-test.ts backend/src/growth-quote-test-fixtures.ts backend/src/acquisition-domain-repository.ts backend/src/acquisition-domain-repository-transaction-test.ts backend/src/acquisition-domain-service.ts backend/src/acquisition-domain-test.ts backend/src/acquisition-v1-router.ts backend/src/acquisition-v1-router-test.ts backend/src/acquisition-tool-executor.ts backend/src/acquisition-tool-executor-test.ts backend/src/acquisition-application.ts backend/src/acquisition-application-test.ts backend/src/growth-quote-module.ts backend/src/growth-quote-module-test.ts backend/src/growth-commercial-composition.ts backend/src/server.ts
git commit -m "feat: preserve quote probability assessments"
```

### Task 3: Quote repository, CommercialBindingSnapshot, and QuoteCase lifecycle

**Files:**
- Create: `backend/src/quote-repository.ts`
- Create: `backend/src/quote-repository-test.ts`
- Create: `backend/src/quote-mysql-repository.ts`
- Create: `backend/src/quote-mysql-repository-test.ts`
- Create: `backend/src/commercial-binding-snapshot.ts`
- Create: `backend/src/commercial-binding-snapshot-test.ts`
- Create: `backend/src/quote-case-service.ts`
- Create: `backend/src/quote-case-service-test.ts`
- Create: `backend/src/growth-workspace-member-assignability.ts`
- Create: `backend/src/growth-workspace-member-assignability-test.ts`
- Modify: `backend/src/growth-quote-test-fixtures.ts`
- Modify: `backend/src/growth-quote-module.ts`
- Modify: `backend/src/growth-commercial-composition.ts`
- Modify: `backend/src/growth-commercial-composition-test.ts`

**Interfaces:**
- Consumes: extracted `resolveTrustedAcquisitionDealBinding`, candidate/domain repository, Customers/Deals, `ProbabilityAssessmentRepository`, workspace/capability/idempotency foundations.
- Consumes without redeclaration Foundation's exact `GrowthTemporalTransaction { lockWorkspaceTemporalBarrierForUpdate(workspaceId:string):Promise<{lastRecordedAt:string;temporalSequence:number}>; currentTimestamp3():Promise<string>; saveWorkspaceTemporalBarrier(workspaceId:string,expectedSequence:number,next:{lastRecordedAt:string;temporalSequence:number}):Promise<void> }`, opaque `GrowthSealedReadCutoff { workspaceId; effectiveAsOf; temporalSequence }`, and `GrowthTemporalBarrier { allocateAppend(tx:GrowthTemporalTransaction,workspaceId:string):Promise<{recordedAt:string;temporalSequence:number}>; sealReadCutoff(context:ActiveWorkspaceContext,effectiveAsOf:string):Promise<GrowthSealedReadCutoff> }`. Every checked-out Quote transaction implements that exact transaction port. The workspace temporal barrier is its first business lock and remains held through commit; every later Task reuses this adapter and the exact `foundation.temporalBarrier` singleton.
- Produces all approved-design quote persistence records: `QuoteCase`, `CommercialBindingSnapshot`, `DealAuthoritativeQuote`, `DealAuthoritativeQuoteEvent`, `QuoteVersion`, `QuoteLifecycleEvent`, `QuoteApproval`, and `QuotePublicationOperation`. Internal `QuoteVersion` persistence adds closed `versionKind:"draft"|"formal"`, `sourceDraftVersionId:string|null`, and `effectiveAt:string`; a formal row requires a non-null source draft and frozen ProbabilityAssessment.v2, while a draft requires both fields null. These authority fields need not be exposed by a public projection unless present in the frozen C0 schema.
- Produces: `BINDING_HASH_SCHEMA_VERSION = "commercial-binding.v1"`, `CommercialBindingSnapshot { candidateId; handoffId; leadId; customerId; dealId; candidateVersion; handoffContentHash; dealContentHash; bindingHashSchemaVersion; attributionSnapshot; bindingHash; verifiedAt }`, `createCommercialBindingSnapshot(input): CommercialBindingSnapshot`, and `verifyCommercialBindingSnapshot(snapshot,current): boolean`. Customer authority references use the existing exact `customerId + handoffContentHash + bindingHashSchemaVersion`; no parallel customer hash or mutable/current `ownershipVersion` field is introduced.
- Produces: `CommercialBindingVerifier.verify(context: ActiveWorkspaceContext, input: { candidateId: string; customerId: string; dealId: string }): Promise<CommercialBindingSnapshot>`; it reads the trusted handoff/Lead/Customer/Deal chain, checks current Deal authority when present, and creates or verifies the frozen snapshot. Financial/ROI stages consume this service rather than rebuilding binding logic.
- Produces: `QuoteRepository` memory implementation plus `MysqlQuoteRepository`; command methods own transactions and row locks rather than exposing a generic `save`.
- Produces shared internal `QuoteCommandExecution<T> { readonly value:T; readonly replayed:boolean }`. Every Quote mutation returns this wrapper so the HTTP adapter can set `Idempotency-Replayed` without serializing metadata; Pi/domain adapters unwrap only `.value`. `QuoteCaseService.list(context,query)` and `.get(context,id)` remain plain reads, while `.create(commandContext,input)`, `.bindDeal(commandContext,id,input)`, `.close(commandContext,id)`, and `.cancel(commandContext,id)` each return `Promise<QuoteCommandExecution<QuoteCase>>`; repository-local `QuoteCaseCommandResult` is projected before leaving the service.
- Produces: `QuoteCaseCreateInput { candidateId?: string; customerId?: string; dealId?: string; assignedTo: string }`; at least one subject reference is required.
- Produces trusted `GrowthWorkspaceMemberAssignabilityReader.assertAssignable(context: ActiveWorkspaceContext, assignedToActorId: string): Promise<{ actorId: string; workspaceId: string; role: "sales"; status: "active" }>` backed by the existing server user/member directory. A sales actor may assign only themselves; manager/admin may assign only an active eligible sales member in the same concrete workspace. Because the frozen capability registry has no separate assignment capability, no implicit string/role bypass is invented; adding delegated sales assignment later requires a new closed C0 capability release.
- `QuoteCaseService.create` uses Foundation's `executeGrowthIdempotentCommand`: after the required reservation, its current authorization step calls this reader before any Quote business lock or insert, freezes the returned `actorId` as the Case `assignedTo` and later `salesOwnerActorId`, and ignores no caller ID. A denied assignment releases the uncompleted reservation and leaves zero QuoteCase, lifecycle, or completed-idempotency rows. Composition constructs one read-only adapter over the trusted existing user directory and injects it into Quote; it is not a public/tool input and does not duplicate user persistence.
- Produces: `BindQuoteCaseDealInput { dealId: string }`; same-Deal replay is idempotent, any rebind is `quote_case_rebind_forbidden`.
- Extends shared test fixtures with `bindingInputFixture`, `dealFixture`, and `quoteCaseFixture`.

- [ ] **Step 1: Write failing binding and concurrent-case tests**

```ts
test("binding freezes the exact acquisition chain and excludes mutable money", () => {
  const snapshot = createCommercialBindingSnapshot(bindingInputFixture({
    deal: { ...dealFixture(), amount: 12345, currency: "CNY" }
  }));
  const changedMoney = bindingInputFixture({
    deal: { ...dealFixture(), amount: 99999, currency: "USD" }
  });
  assert.equal(snapshot.dealId, "deal-1");
  assert.equal(snapshot.candidateId, "candidate-1");
  assert.equal(snapshot.dealContentHash,
    createCommercialBindingSnapshot(changedMoney).dealContentHash);
  assert.match(snapshot.bindingHash, /^sha256:[a-f0-9]{64}$/u);
});

test("two candidate-only cases cannot bind the same Deal concurrently", async () => {
  const state = quoteCaseFixture({ cases: ["case-a", "case-b"] });
  const results = await Promise.all([
    state.service.bindDeal(commandContextFixture({
      idempotencyKey: "bind-case-a", expectedRevision: 1
    }), "case-a", { dealId: "deal-1" }),
    state.service.bindDeal(commandContextFixture({
      idempotencyKey: "bind-case-b", expectedRevision: 1
    }), "case-b", { dealId: "deal-1" })
  ].map((promise) => promise.then(() => "ok", (error) => error.code)));
  assert.deepEqual(results.sort(), ["deal_open_quote_case_conflict", "ok"]);
});

test("binding verifier rejects a stale or cross-workspace authority chain", async () => {
  const state = quoteCaseFixture({ authorityRevision: 3 });
  await assert.rejects(
    state.bindingVerifier.verify(
      workspaceContextFixture("manager"),
      { candidateId: "candidate-1", customerId: "customer-1", dealId: "deal-stale" }
    ),
    (error: unknown) => (error as { code?: string }).code
      === "commercial_binding_authority_mismatch"
  );
});

test("case assignment requires an eligible same-workspace sales owner", async () => {
  const state = quoteCaseFixture({
    members: [
      { actorId: "sales-a", workspaceId: "team-a", role: "sales", status: "active" },
      { actorId: "sales-b", workspaceId: "team-b", role: "sales", status: "active" }
    ]
  });
  await assert.rejects(() => state.service.create(commandContextFixture({
    actorId: "sales-a", role: "sales", idempotencyKey: "case-owner-peer"
  }), { candidateId: "candidate-1", assignedTo: "sales-peer" }),
  (error: unknown) => (error as { code?: string }).code
    === "quote_assignee_forbidden");
  await assert.rejects(() => state.service.create(commandContextFixture({
    actorId: "manager-a", role: "manager", idempotencyKey: "case-owner-cross"
  }), { candidateId: "candidate-1", assignedTo: "sales-b" }),
  (error: unknown) => (error as { code?: string }).code
    === "quote_assignee_invalid");
  await assert.rejects(() => state.service.create(commandContextFixture({
    actorId: "manager-a", role: "manager", idempotencyKey: "case-owner-missing"
  }), { candidateId: "candidate-1", assignedTo: "missing-user" }),
  (error: unknown) => (error as { code?: string }).code
    === "quote_assignee_invalid");
  assert.equal(await state.repository.countCases("team-a"), 0);
  const { value: own } = await state.service.create(commandContextFixture({
    actorId: "sales-a", role: "sales", idempotencyKey: "case-owner-self"
  }), { candidateId: "candidate-1", assignedTo: "sales-a" });
  assert.equal(own.assignedTo, "sales-a");
});
```

Add tests for at-least-one reference, cross-workspace reference, same-workspace but wrong handoff/customer/deal chain, candidate-only draft, one-time bind, same-Deal replay, binding the current ProbabilityAssessment, unique open Case per Deal, guard row creation at bind, close/cancel blocked by submitted/approved versions, cancel expiring drafts, sales self-assignment, sales assigning a peer, inactive/non-sales/nonmember/cross-workspace assignees, manager/admin assigning an eligible same-workspace sales member, zero QuoteCase/lifecycle writes and no completed idempotency row on assignment denial, owner identity remaining frozen after later user/team changes, and two real MySQL connections producing one bind winner.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/quote-repository-test.ts src/quote-mysql-repository-test.ts src/commercial-binding-snapshot-test.ts src/quote-case-service-test.ts`

Expected: FAIL because the quote repository, binding snapshot, and case service do not exist.

- [ ] **Step 3: Implement the append-only repository and schema**

Create dedicated tables for quote cases, binding snapshots, versions, line/gift/package snapshots, lifecycle events, approvals, Deal authority guards/events, publication operations, and quote command idempotency. Quote repository transactions reuse Foundation's temporal-barrier schema/port rather than creating a Quote clock table: barrier lock first, then fixed Quote domain locks, successive temporal allocations, commit while still holding the barrier. Enforce unique indexes for open Deal Case, version per Case, lifecycle revision, authority revision, active approval, publication stable key, and `(workspace_id,source_draft_version_id)` for formal submissions. Validate the draft/formal nullability invariant with repository decoding plus a database check where supported. Do not add these collections to `CrmStore`.

```ts
export interface QuoteRepository {
  listCases(workspaceId: string, query: QuoteCaseListQuery): Promise<QuoteCasePage>;
  findCase(workspaceId: string, id: string): Promise<QuoteCase | null>;
  createCase(command: CreateQuoteCaseCommand): Promise<QuoteCaseCommandResult>;
  bindCaseDeal(command: BindQuoteCaseDealCommand): Promise<QuoteCaseCommandResult>;
  closeCase(command: CloseQuoteCaseCommand): Promise<QuoteCaseCommandResult>;
  cancelCase(command: CancelQuoteCaseCommand): Promise<QuoteCaseCommandResult>;
}
```

Later tasks extend this same interface with version/approval/publication commands; they do not introduce a second quote repository.

- [ ] **Step 4: Implement strong binding and Case state rules**

`GrowthWorkspaceMemberAssignabilityReader` reads only active trusted members and derives workspace from `ActiveWorkspaceContext`; it accepts no caller workspace, role, or status. `QuoteCaseService.create` first lets Foundation reserve the HTTP idempotency command, then validates assignment as current authorization before entering the Quote transaction and freezes the returned sales actor identity; denial releases that uncompleted reservation. `CommercialBindingVerifier.verify` resolves exactly one trusted acquisition handoff and Lead under `context.workspaceId`, verifies the Customer/Deal chain and current Deal authority guard, then returns the canonical snapshot. Hash canonical handoff identity/source fields plus candidate version; hash only Deal identity/ownership/customer relationship fields into `dealContentHash`, excluding commercial amount. `bindingHash` includes `customerId`, `handoffContentHash`, `dealContentHash`, and `bindingHashSchemaVersion`. The verifier can revalidate a current command against current trusted rows, while as-of authority readers return the persisted frozen `customerId + handoffContentHash + bindingHashSchemaVersion` evidence and never invent a parallel customer hash or mutable ownership version. Bind in a transaction that locks/creates the Deal guard before locking the Case, rejects another open Case, appends the snapshot, binds the current v2 probability assessment, and increments Case revision. Pending-approval projection later reads `salesOwnerActorId` from this frozen validated Case assignment, never from a current user/team lookup.

- [ ] **Step 5: Verify GREEN**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/quote-repository-test.ts src/quote-mysql-repository-test.ts src/commercial-binding-snapshot-test.ts src/quote-case-service-test.ts && npm run build`

Expected: memory/MySQL parity, binding, Case lifecycle, and build PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/quote-repository.ts backend/src/quote-repository-test.ts backend/src/quote-mysql-repository.ts backend/src/quote-mysql-repository-test.ts backend/src/commercial-binding-snapshot.ts backend/src/commercial-binding-snapshot-test.ts backend/src/quote-case-service.ts backend/src/quote-case-service-test.ts backend/src/growth-workspace-member-assignability.ts backend/src/growth-workspace-member-assignability-test.ts backend/src/growth-quote-test-fixtures.ts backend/src/growth-quote-module.ts backend/src/growth-commercial-composition.ts backend/src/growth-commercial-composition-test.ts
git commit -m "feat: bind quote cases to trusted deals"
```

### Task 4: Preview, immutable QuoteVersion, submission, and approval request

**Files:**
- Create: `backend/src/quote-version-service.ts`
- Create: `backend/src/quote-version-service-test.ts`
- Modify: `backend/src/quote-repository.ts`
- Modify: `backend/src/quote-mysql-repository.ts`
- Modify: `backend/src/quote-repository-test.ts`
- Modify: `backend/src/quote-mysql-repository-test.ts`
- Modify: `backend/src/growth-quote-test-fixtures.ts`
- Modify: `backend/src/growth-quote-module.ts`

**Interfaces:**
- Consumes: calculator, the exact final Catalog-owned `GrowthCatalogServices { catalogItems; pricingPolicies; packageVersions; quoteCatalog; commissionCatalogProjection }`, QuoteRepository, ProbabilityAssessmentRepository, CommercialBindingSnapshot verifier, `CommandContext`, exact Foundation `GrowthFoundationServices` including singleton `temporalBarrier`, and free `executeGrowthIdempotentCommand`. Quote resolves policy/package authority only through `catalog.quoteCatalog.resolveAt`; it never consumes CatalogRepository, constructs a second Catalog service graph, or implements its own temporal allocator.
- Produces: `QuotePreviewInput` as the transport-safe subset of `QuoteCalculationInput`; it contains no calculated output fields.
- Produces: `QuotePreviewResult` with the frozen C0 `previewIdentity { inputSnapshotHash; calculationHash; pricingPolicyVersionId; pricingPolicyRevision; packageVersionId; formulaVersion }`; the server does not widen this transport object with an `effectiveAt` field.
- Produces exact immutable `QuoteSubjectEvidenceSnapshot { candidateId:string|null; customerId:string|null; dealId:string|null }` and internal append-only `QuotePreviewEvidenceRecord { id; workspaceId; quoteCaseId; quoteCaseRevision; salesOwnerActorId; subjectEvidence:QuoteSubjectEvidenceSnapshot; createdBy; requestHash; stableCommandHash; previewIdentity; frozenCalculationResult; inputSnapshotHash; calculationHash; effectiveAt; recordedAt; temporalSequence; evidenceHash }`. The Case lock supplies the frozen assigned sales actor and subject IDs; at least one subject ID is non-null and every non-null ID must match that Case's trusted binding. A successful preview claims Foundation HTTP idempotency, then atomically appends or reuses the deterministic command record after server calculation; the initial append locks the Case and requires `CommandContext.expectedRevision` to equal the current Case revision, while an exact completed replay performs current authorization and projects the already-frozen evidence without reapplying that historical precondition. This evidence is private and does not widen `QuotePreviewResult` or the frozen transport contract. Draft/formal QuoteVersion rows remain a second immutable evidence source for the same identity.
- Produces: `CreateQuoteVersionInput { previewIdentity; quoteInput }`; service recalculates and rejects any stale/mismatched preview.
- Extends the sole `QuoteRepository` with exact version commands used by this task: `getVersion(workspaceId,id)`, `listVersions(workspaceId,quoteCaseId)`, `findPreviewEvidence(workspaceId,id)`, `findPreviewEvidenceByStableCommandHash(workspaceId,stableCommandHash)`, `appendOrGetPreviewEvidence(command)`, `findDraftByStableCommandHash(workspaceId,stableCommandHash)`, and `appendVersionFromCalculation(command)`. The two stable-command lookups are private domain-idempotency probes; `getVersion` is the one exact ID lookup name used by services and tests.
- Produces: `QuoteVersionService.preview(commandContext:CommandContext,caseId,input):Promise<QuoteCommandExecution<QuotePreviewResult>>`, `.createVersion(commandContext,caseId,input):Promise<QuoteCommandExecution<QuoteVersion>>`, `.listVersions(context,caseId)`, `.getVersion(context,id)`, and `.submit(commandContext,draftVersionId):Promise<QuoteCommandExecution<{ sourceDraftVersion:QuoteVersion; submittedVersion:QuoteVersion; approval:QuoteApproval }>>`; router/tool adapters unwrap only `.value`, while HTTP sets `Idempotency-Replayed` from the sibling flag for both fresh and replayed commands.
- Submission leaves the source draft content/lifecycle untouched, allocates the next Case version under lock, appends one new immutable `formal` QuoteVersion with `sourceDraftVersionId`, exact copied/recalculated commercial snapshots, and frozen ProbabilityAssessment.v2 that matches the Candidate's current committed qualification decision ID/version/input hash, then appends that formal version's first `QuoteLifecycleEvent(fromStatus=null,toStatus="submitted")` and one active `QuoteApproval(status="pending", approvalKind, requiredCapabilities, triggeredRules, policySnapshotHash)`. A missing writer/row, a v2 row for an older decision, or any decision/hash mismatch is `probability_assessment_v2_required`; submission never derives it from the public/legacy percentage. Approval and every later authority/publication reference use only the formal `submittedVersion.id`.
- Extends shared test fixtures with `quoteVersionFixture`, `previewCommand(caseId,idempotencyKey,overrides?)` whose default `expectedRevision` is that fixture Case's current revision and whose canonical request hash contains the validated `{id:caseId}` path, and `managerContext`.

- [ ] **Step 1: Write failing server-recalculation and submission tests**

```ts
test("createVersion rejects client authoritative totals with zero writes", async () => {
  const state = quoteVersionFixture();
  const { value: preview } = await state.service.preview(
    previewCommand("case-1", "preview-reject-client-totals"),
    "case-1", quoteInputFixture()
  );
  await assert.rejects(
    state.service.createVersion(
      commandContextFixture({ expectedRevision: 1, idempotencyKey: "version-create-0001" }),
      "case-1",
      {
        previewIdentity: preview.previewIdentity,
        quoteInput: { ...quoteInputFixture(), quotedAmountMinor: 1 } as never
      }
    ),
    (error: unknown) => (error as { code?: string }).code
      === "quote_input_contains_authoritative_field"
  );
  assert.equal(await state.repository.countVersions("team-a", "case-1"), 0);
});

test("createVersion persists only the server recalculation", async () => {
  const state = quoteVersionFixture();
  const input = quoteInputFixture();
  const { value: preview } = await state.service.preview(
    previewCommand("case-1", "preview-create-server-result"), "case-1", input
  );
  const { value: created } = await state.service.createVersion(
    commandContextFixture({ expectedRevision: 1, idempotencyKey: "version-create-0002" }),
    "case-1", { previewIdentity: preview.previewIdentity, quoteInput: input }
  );
  assert.equal(created.quotedAmountMinor, preview.quotedAmountMinor);
  assert.equal(created.inputSnapshotHash, preview.inputSnapshotHash);
  assert.equal(Object.isFrozen(created.pricingPolicySnapshot), true);
});

test("submission requires Deal binding current v2 probability and non-hard-blocked calculation", async () => {
  const state = quoteVersionFixture({ boundDeal: false, assessment: null });
  await assert.rejects(
    state.service.submit(commandContextFixture({
      expectedRevision: 1, idempotencyKey: "version-submit-0001"
    }), "version-1"),
    (error: unknown) => (error as { code?: string }).code
      === "quote_deal_binding_required"
  );
  const legacy = quoteVersionFixture({ assessment: "legacy_percent_precision" });
  await assert.rejects(
    legacy.service.submit(commandContextFixture({
      expectedRevision: 1, idempotencyKey: "version-submit-0002"
    }), "version-1"),
    (error: unknown) => (error as { code?: string }).code
      === "probability_assessment_v2_required"
  );
});

test("submission appends a new immutable formal version and never fills the draft probability", async () => {
  const state = quoteVersionFixture({ closeProbabilityBps: 4_321 });
  const draftBefore = await state.repository.getVersion("team-a", "version-draft-1");
  const { value: result } = await state.service.submit(commandContextFixture({
    expectedRevision: draftBefore?.lifecycleRevision ?? 1,
    idempotencyKey: "version-submit-formal-0001"
  }), "version-draft-1");
  const draftAfter = await state.repository.getVersion("team-a", "version-draft-1");
  assert.deepEqual(draftAfter, draftBefore);
  assert.notEqual(result.submittedVersion.id, "version-draft-1");
  assert.equal(result.submittedVersion.versionKind, "formal");
  assert.equal(result.submittedVersion.sourceDraftVersionId, "version-draft-1");
  assert.equal(result.submittedVersion.probabilityAssessmentSnapshot?.closeProbabilityBps, 4_321);
  assert.equal(result.approval.quoteVersionId, result.submittedVersion.id);
});

test("preview create and submit all reject policy/package coverage gaps at their server quote instants", async () => {
  const state = quoteVersionFixture({
    policyWindow: ["2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
    packageWindow: ["2026-08-01T00:00:00.000Z", "2026-08-10T00:00:00.000Z"],
    now: "2026-08-15T00:00:00.000Z"
  });
  const input = quoteInputFixture();
  await assert.rejects(() => state.service.preview(
    previewCommand("case-1", "preview-package-gap"), "case-1", input
  ),
    (error: unknown) => (error as { code?: string }).code === "package_version_not_effective");
  await assert.rejects(() => state.service.createVersion(
    commandContextFixture({ expectedRevision: 1, idempotencyKey: "version-package-gap-create" }), "case-1",
    { previewIdentity: state.previewIdentityFor(input), quoteInput: input }
  ), (error: unknown) => (error as { code?: string }).code === "package_version_not_effective");
  await assert.rejects(() => state.service.submit(commandContextFixture({
    expectedRevision: 1, idempotencyKey: "version-package-gap-submit"
  }), "draft-with-package-gap"),
  (error: unknown) => (error as { code?: string }).code === "package_version_not_effective");
  assert.equal(await state.repository.countFormalVersions("team-a", "case-1"), 0);
});

test("successful preview records immutable evidence without changing the public result", async () => {
  const state = quoteVersionFixture({
    quoteEffectiveAt: "2026-08-09T08:00:00.000Z",
    previousPreviewEvidenceRecordedAt: "2026-08-09T08:00:10.000Z",
    previewAppendServerNow: "2026-08-09T08:00:10.000Z"
  });
  const command = previewCommand("case-1", "preview-evidence-record");
  const { value: result, replayed } = await state.service.preview(
    command,
    "case-1", quoteInputFixture()
  );
  assert.equal(replayed, false);
  const [evidence] = await state.repository.listPreviewEvidence(
    "team-a", "case-1", result.inputSnapshotHash, result.calculationHash
  );
  assert.ok(evidence);
  assert.deepEqual(evidence.previewIdentity, result.previewIdentity);
  assert.equal(evidence.effectiveAt, "2026-08-09T08:00:00.000Z");
  assert.equal(evidence.recordedAt, "2026-08-09T08:00:10.001Z");
  assert.equal("effectiveAt" in result, false);

  state.expireCurrentCatalogWindows();
  const replay = await state.service.preview(command, "case-1", quoteInputFixture());
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.value, result);
  assert.equal(state.catalogResolveCalls(), 1);

  state.revoke("manager-1", "quote.draft.create");
  await assert.rejects(() => state.service.preview(
    command, "case-1", quoteInputFixture()
  ), (error: unknown) => (error as { code?: string }).code
    === "capability_forbidden");
});

test("one preview idempotency key cannot target two Case path IDs", async () => {
  const state = quoteVersionFixture({ cases: ["case-a", "case-b"] });
  await state.service.preview(
    previewCommand("case-a", "preview-cross-case-key"),
    "case-a", quoteInputFixture()
  );
  await assert.rejects(() => state.service.preview(
    previewCommand("case-b", "preview-cross-case-key"),
    "case-b", quoteInputFixture()
  ), (error: unknown) => (error as { code?: string }).code
    === "idempotency_conflict");
  assert.equal(await state.repository.countPreviewEvidence("team-a", "case-b"), 0);
});

test("draft creation requires the exact Case revision and concurrent writers have one winner", async () => {
  const state = quoteVersionFixture({ caseRevision: 7, pauseDraftAfterCaseLock: true });
  const input = { previewIdentity: state.previewIdentityFor(quoteInputFixture()), quoteInput: quoteInputFixture() };
  await assert.rejects(
    state.service.createVersion(commandContextFixture({
      expectedRevision: null, idempotencyKey: "draft-missing-revision"
    }), "case-1", input),
    (error: unknown) => (error as { code?: string }).code === "revision_required"
  );
  await assert.rejects(
    state.service.createVersion(commandContextFixture({
      expectedRevision: 6, idempotencyKey: "draft-stale-revision"
    }), "case-1", input),
    (error: unknown) => (error as { code?: string }).code === "revision_conflict"
  );
  const first = state.service.createVersion(commandContextFixture({
    expectedRevision: 7, idempotencyKey: "draft-race-a"
  }), "case-1", input);
  await state.waitForDraftCaseLock();
  const second = state.service.createVersion(commandContextFixture({
    expectedRevision: 7, idempotencyKey: "draft-race-b"
  }), "case-1", input);
  state.releaseDraftCaseLock();
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes.filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((row) => row.status === "rejected"
    && (row.reason as { code?: string }).code === "revision_conflict").length, 1);
  assert.equal(await state.repository.countVersions("team-a", "case-1"), 1);
  assert.equal((await state.repository.findCase("team-a", "case-1"))?.revision, 8);
});

test("draft replay repairs HTTP completion without recalculating or bypassing current authorization", async () => {
  const state = quoteVersionFixture({
    caseRevision: 3, failHttpIdempotencyCompleteOnce: true
  });
  const command = commandContextFixture({
    expectedRevision: 3, idempotencyKey: "draft-commit-before-complete"
  });
  const input = {
    previewIdentity: state.previewIdentityFor(quoteInputFixture()),
    quoteInput: quoteInputFixture()
  };
  await assert.rejects(
    state.service.createVersion(command, "case-1", input),
    /simulated_http_completion_failure/
  );
  state.expireCurrentCatalogWindows();
  const replay = await state.service.createVersion(command, "case-1", input);
  assert.equal(replay.value.id, (await state.repository.listVersions("team-a", "case-1"))[0]?.id);
  assert.equal(replay.replayed, true);
  assert.equal(state.catalogResolveCalls(), 1);
  assert.equal(await state.repository.countVersions("team-a", "case-1"), 1);
  state.revoke(command.actorId, "quote.draft.create");
  await assert.rejects(
    state.service.createVersion(command, "case-1", input),
    (error: unknown) => (error as { code?: string }).code === "capability_forbidden"
  );
});
```

Add tests for one top-level item, stale policy revision/window, mismatched preview hash, missing/stale Case revision with zero preview evidence, immutable preview/draft/formal rows, sequential draft/formal version allocation, concurrent creates/submits with one formal row per source draft, preview commit-before-idempotency-complete recovery through its domain `stableCommandHash`, hard block rejection, confirmation vs combined exception approval, frozen original BPS, one active approval on the formal ID, lifecycle revision ordering within one millisecond, cross-workspace nested IDs, same-key cross-Case conflict, replay after capability loss, and Catalog private-key/service reference equality. Explicitly prove formal submission fails with `probability_assessment_v2_required` when the application ran without the required writer, when an assessment append previously failed, and when the only v2 row belongs to an older qualification decision/version/input hash; after idempotent qualification replay repairs the exact current row, the same submission may proceed and freezes 4321 BPS. The preview replay test first advances the Case revision after the committed result and proves that the same command still reauthorizes and returns the frozen evidence rather than reapplying the old `If-Match`; a new command carrying that stale revision fails. For a policy `[Aug 1, Sep 1)` referencing package `[Aug 1, Aug 10)`, preview/create/submit whose server operation instant is Aug 15 all fail with zero draft/formal versions or approvals even though the policy is effective. Add a clock-advance case in which preview and draft creation pass on Aug 9 but submission on Aug 10 fails, proving submission does not trust the earlier validation; a matching preview replay after that change still returns the frozen evidence result rather than recalculating.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/quote-version-service-test.ts src/quote-repository-test.ts src/quote-mysql-repository-test.ts`

Expected: FAIL because QuoteVersionService and repository version commands are absent.

- [ ] **Step 3: Implement preview and version creation**

```ts
async preview(
  context: CommandContext,
  quoteCaseId: string,
  input: QuotePreviewInput
): Promise<QuoteCommandExecution<QuotePreviewResult>> {
  requireGrowthCapabilities(context.workspace, ["quote.draft.create"]);
  const effectiveAt = this.now();
  const stableCommandHash = createQuotePreviewStableCommandHash({
    workspaceId: context.workspace.workspaceId, actorId: context.actorId,
    idempotencyKey: context.idempotencyKey, requestHash: context.requestHash
  });
  const result = await executeGrowthIdempotentCommand({
    repository: this.foundation.httpIdempotency,
    reservation: {
      workspaceId: context.workspace.workspaceId, actorId: context.actorId,
      method: "POST", canonicalPath: "/api/v1/quotes/cases/:id/preview",
      key: context.idempotencyKey, requestHash: context.requestHash,
      attemptedAt: effectiveAt, leaseOwner: this.requestExecutionId(),
      leaseDurationMs: 30_000
    }
  }, async (resourceId, operationId) => {
    requireGrowthCapabilities(context.workspace, ["quote.draft.create"]);
    await this.repository.assertCaseAccessible(
      context.workspace.workspaceId, quoteCaseId, context.actorId
    );
    if (resourceId === null || operationId !== null) {
      throw new QuoteVersionError("idempotency_reference_invalid");
    }
    const evidence = await this.repository.findPreviewEvidence(
      context.workspace.workspaceId, resourceId
    );
    if (!evidence || evidence.quoteCaseId !== quoteCaseId
      || evidence.createdBy !== context.actorId
      || evidence.requestHash !== context.requestHash
      || evidence.stableCommandHash !== stableCommandHash) {
      throw new QuoteVersionError("idempotency_reference_invalid");
    }
    return projectFrozenPreview(evidence, context.workspace.capabilities);
  }, async () => {
    if (context.expectedRevision === null) {
      throw new QuoteVersionError("precondition_required");
    }
    const committed = await this.repository.findPreviewEvidenceByStableCommandHash(
      context.workspace.workspaceId, stableCommandHash
    );
    if (committed) return { resourceId: committed.id, operationId: null };
    const authority = await this.catalog.quoteCatalog.resolveAt(context.workspace, {
      catalogItemId: input.catalogItemId,
      pricingPolicyVersionId: input.pricingPolicyVersionId,
      effectiveAt
    });
    const calculated = await this.recalculate(
      context.workspace, quoteCaseId, input, authority
    );
    const evidence = await this.repository.appendOrGetPreviewEvidence({
      workspaceId: context.workspace.workspaceId, quoteCaseId,
      expectedQuoteCaseRevision: context.expectedRevision,
      createdBy: context.actorId, requestHash: context.requestHash,
      stableCommandHash, effectiveAt, calculated,
      allocateRecordedAt: (tx) => this.foundation.temporalBarrier.allocateAppend(
        tx, context.workspace.workspaceId
      )
    });
    return { resourceId: evidence.id, operationId: null };
  });
  return result;
}

async createVersion(
  context: CommandContext,
  quoteCaseId: string,
  input: CreateQuoteVersionInput
) {
  requireGrowthCapabilities(context.workspace, ["quote.draft.create"]);
  const expectedCaseRevision = requireExpectedRevision(context);
  const quoteEffectiveAt = this.now();
  const stableCommandHash = createQuoteDraftStableCommandHash({
    workspaceId: context.workspace.workspaceId,
    actorId: context.actorId,
    quoteCaseId,
    expectedCaseRevision,
    idempotencyKey: context.idempotencyKey,
    requestHash: context.requestHash
  });
  const result = await executeGrowthIdempotentCommand({
    repository: this.foundation.httpIdempotency,
    reservation: {
      workspaceId: context.workspace.workspaceId, actorId: context.actorId,
      method: "POST", canonicalPath: "/api/v1/quotes/cases/:id/versions",
      key: context.idempotencyKey, requestHash: context.requestHash,
      attemptedAt: quoteEffectiveAt, leaseOwner: this.requestExecutionId(),
      leaseDurationMs: 30_000
    }
  }, async (resourceId, operationId) => {
    requireGrowthCapabilities(context.workspace, ["quote.draft.create"]);
    if (resourceId === null || operationId !== null) {
      throw new QuoteVersionError("idempotency_reference_invalid");
    }
    const frozen = await this.repository.getVersion(
      context.workspace.workspaceId, resourceId
    );
    if (!frozen || frozen.quoteCaseId !== quoteCaseId
      || frozen.versionKind !== "draft"
      || frozen.createdBy !== context.actorId
      || frozen.stableCommandHash !== stableCommandHash) {
      throw new QuoteVersionError("idempotency_reference_invalid");
    }
    await this.repository.assertCaseAccessible(
      context.workspace.workspaceId, quoteCaseId, context.actorId
    );
    return projectFrozenDraft(frozen, context.workspace.capabilities);
  }, async () => {
    const committed = await this.repository.findDraftByStableCommandHash(
      context.workspace.workspaceId, stableCommandHash
    );
    if (committed) return { resourceId: committed.id, operationId: null };
    const catalogAuthority = await this.catalog.quoteCatalog.resolveAt(
      context.workspace, {
        catalogItemId: input.quoteInput.catalogItemId,
        pricingPolicyVersionId: input.quoteInput.pricingPolicyVersionId,
        effectiveAt: quoteEffectiveAt
      }
    );
    const calculated = await this.recalculate(
      context.workspace, quoteCaseId, input.quoteInput, catalogAuthority
    );
    if (calculated.amountState !== "actionable") {
      throw new QuoteVersionError("quote_not_actionable");
    }
    if (calculated.inputSnapshotHash !== input.previewIdentity.inputSnapshotHash
      || calculated.calculationHash !== input.previewIdentity.calculationHash
      || calculated.pricingPolicySnapshot.id
        !== input.previewIdentity.pricingPolicyVersionId) {
      throw new QuoteVersionError("pricing_policy_stale");
    }
    const draft = await this.repository.appendVersionFromCalculation({
      workspaceId: context.workspace.workspaceId,
      quoteCaseId,
      expectedQuoteCaseRevision: expectedCaseRevision,
      stableCommandHash,
      versionKind: "draft",
      sourceDraftVersionId: null,
      effectiveAt: quoteEffectiveAt,
      calculated,
      probabilityAssessmentSnapshot: null,
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      allocateRecordedAt: (tx) => this.foundation.temporalBarrier.allocateAppend(
        tx, context.workspace.workspaceId
      )
    });
    return { resourceId: draft.id, operationId: null };
  });
  return result;
}
```

Parse `QuotePreviewInput` and `CreateQuoteVersionInput` with closed schemas (`additionalProperties:false`). If a body contains `quotedAmountMinor`, totals, floor, margin, contribution, gate, approval result, commercial hashes, or any client `effectiveAt`/pricing timestamp, fail with HTTP `400` / `quote_input_contains_authoritative_field` and perform zero business writes; do not silently ignore those fields. Preview, create, and submit each capture exactly one server calculation `effectiveAt` at command start and resolve the exact policy/package through the Catalog singleton at that operation instant. Preview and draft creation are commands: their HTTP routes and Pi handlers provide Foundation-built `CommandContext` values, and both use only the free `executeGrowthIdempotentCommand`. Each execute path first checks its domain-unique `stableCommandHash` so reservation reclaim after business commit never recalculates against a changed window. Preview then calculates, locks the Foundation workspace temporal barrier before Case/evidence rows, locks the Case preview-evidence stream, allocates immutable evidence through the barrier, and atomically appends/fetches it while holding the barrier to commit. Draft creation first calls `requireExpectedRevision(context)`; its business transaction takes the barrier, locks the Case, requires the Case to remain open/accessible with `case.revision===expectedCaseRevision`, appends or fetches only the exact stable domain command, and atomically CAS-increments the Case revision with the immutable draft append. A missing/stale revision, or the loser of two distinct commands based on the same revision, writes no draft/evidence/completed reservation. The expected revision is part of Foundation's canonical request identity and the domain stable hash but is never duplicated in the request body. Exact replay reauthorizes current Case access/capability and projects the frozen resource ID without reapplying the historical precondition; a different key/body/path/revision conflicts. Neither path copies command-start `effectiveAt`/reservation `attemptedAt` into `recordedAt`, and a cutoff sealed before the transaction remains unchanged even for a brand-new stream or regressing DB clock. Foundation completion stores only the internal resource ID. Draft creation persists its own operation instant as immutable internal `effectiveAt` but obtains append evidence time from the same workspace barrier; formal submission does likewise at its later operation. Persist calculated fields only from `calculated`. Freeze a component-expanded package snapshot but retain one top-level line item. A draft is permanently probability-null; only a separately appended formal submission may carry the snapshot.

- [ ] **Step 4: Implement atomic submission and approval request**

Submission captures one server calculation `quoteEffectiveAt` at command start and resolves Catalog policy/package authority at exactly that instant. Its business transaction first locks the Foundation workspace temporal barrier, then QuoteCase, source draft, binding, Candidate's current committed qualification bundle, assessment and the Case/formal lifecycle/approval stream tails. It verifies every immutable ID/hash, requires the locked v2 assessment's decision ID/version/input hash to equal that current committed bundle, and requires the exact policy/package to have been effective at `quoteEffectiveAt`, then recalculates the hard gate. A missing/mismatched assessment fails closed before any formal/lifecycle/approval append. While still holding the barrier it calls `temporalBarrier.allocateAppend` successively for the immutable formal-version creation evidence, submitted lifecycle event and pending approval, so all occupy strictly increasing workspace ticks even when every stream is new or the DB clock regresses. It appends a `formal` QuoteVersion whose commercial fields are copied only from that recalculation, whose internal `effectiveAt` equals `quoteEffectiveAt`, and whose probability snapshot freezes the exact current v2 assessment; its first `submitted` lifecycle event and pending approval use their own barrier-derived append records as `submittedAt`. It records the unique source-draft link and increments Case revision. It never updates the source draft row or lifecycle, Deal authority, or publication work. A concurrent second submission resolves to the same formal version only for an identical idempotent command; any different command returns `quote_draft_already_submitted` and creates zero additional rows.

- [ ] **Step 5: Verify GREEN**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/quote-version-service-test.ts src/quote-repository-test.ts src/quote-mysql-repository-test.ts && npm run build`

Expected: preview, version, submission, repository concurrency, and build PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/quote-version-service.ts backend/src/quote-version-service-test.ts backend/src/quote-repository.ts backend/src/quote-mysql-repository.ts backend/src/quote-repository-test.ts backend/src/quote-mysql-repository-test.ts backend/src/growth-quote-test-fixtures.ts backend/src/growth-quote-module.ts
git commit -m "feat: append and submit quote versions"
```

### Task 5: Human approval, Deal authority, Outbox, and as-of reader

**Files:**
- Create: `backend/src/quote-approval-service.ts`
- Create: `backend/src/quote-approval-service-test.ts`
- Create: `backend/src/authoritative-quote-reader.ts`
- Create: `backend/src/authoritative-quote-reader-test.ts`
- Create: `backend/src/quote-preview-evidence-reader.ts`
- Create: `backend/src/quote-preview-evidence-reader-test.ts`
- Modify: `backend/src/quote-repository.ts`
- Modify: `backend/src/quote-mysql-repository.ts`
- Modify: `backend/src/quote-repository-test.ts`
- Modify: `backend/src/quote-mysql-repository-test.ts`
- Modify: `backend/src/growth-quote-test-fixtures.ts`
- Modify: `backend/src/growth-quote-module.ts`

**Interfaces:**
- Consumes: immutable `formal` submitted QuoteVersion/Approval, `requireGrowthCapabilities`, binding verifier, exact policy/assessment snapshots, and repository fixed-order transaction. A draft ID is never approvable or authoritative.
- Consumes without redeclaration the exact Foundation opaque `GrowthSealedReadCutoff` and `GrowthTemporalBarrier.sealReadCutoff(context:ActiveWorkspaceContext,effectiveAsOf:string):Promise<GrowthSealedReadCutoff>`. Only the request-boundary adapter may call `sealReadCutoff`, exactly once per logical read request. Every internal `getAt`, `getDecisionAt`, `listContributionsAsOf`, `listPendingAsOf`, QuoteVersion-evidence and preview-evidence method instead requires that sealed token, rejects a token whose `workspaceId` differs from `context.workspaceId`, and passes the identical token/effective cutoff through repository work without resealing or reconstructing it.
- Produces exact `QuoteApprovalDecisionResult { quoteVersion; approval; authority; authorityEvent; lifecycleEvents; publicationOperation }`, plain read `QuoteApprovalService.listForVersion(context,versionId)`, plus `.approve(commandContext,versionId,{reason})`, `.reject(commandContext,versionId,{reason})`, and `.expire(commandContext,versionId,{reason})`, each returning `Promise<QuoteCommandExecution<QuoteApprovalDecisionResult>>` and preserving the helper's replay bit.
- Produces: `PendingQuoteApprovalSnapshot { quoteCaseId; quoteVersionId; approvalId; approvalKind; requiredCapabilities; lifecycleRevision; currency; quotedAmountMinor; estimatedGrossProfitMinor; estimatedContributionMinor; grossMarginBps; probabilityAssessmentId; closeProbabilityBps; commercialAmountHash; salesOwnerActorId; submittedBy; submittedAt; expiresAt }` where every probability/amount/hash field is copied from the same immutable formal QuoteVersion, `salesOwnerActorId` is frozen from that version's QuoteCase assignment plus CommercialBindingSnapshot, and `submittedBy` is frozen from the formal submission event; none is inferred from current CRM ownership or recalculated at read time. `QuoteApprovalAsOfReader.listPendingAsOf(context: ActiveWorkspaceContext, input: { cutoff: GrowthSealedReadCutoff; limit: number }): Promise<readonly PendingQuoteApprovalSnapshot[]>` reduces with `recordedAt<=cutoff.effectiveAsOf` and revision order, always scopes by `context.workspaceId`, returns only `salesOwnerActorId===context.actorId` for role `sales`, and permits `manager`/`admin`/`super_admin` to see the workspace set only through an existing authorized concrete `ActiveWorkspaceContext`; it never accepts a raw/requested owner/workspace/cutoff override and never treats `teamId="all"` as a workspace. Public/tool projection removes profit/margin/cost fields without current `pricing.sensitive.read`, but the internal frozen snapshot remains complete for authorized replay projection.
- Produces exact immutable `CommercialBindingEvidenceSnapshot { candidateId; customerId; dealId; handoffContentHash; dealContentHash; bindingHashSchemaVersion; bindingHash }` and `QuoteVersionEvidenceReader.getAt(context: ActiveWorkspaceContext, quoteVersionId: string, cutoff: GrowthSealedReadCutoff): Promise<QuoteVersionEvidenceSnapshot|null>` where the immutable snapshot includes `quoteCaseId`, `quoteVersionId`, `salesOwnerActorId`, `versionKind`, `sourceDraftVersionId`, `commercialBindingEvidence: CommercialBindingEvidenceSnapshot`, `probabilityAssessmentId`, `closeProbabilityBps`, `lifecycleRevision`, `status`, `currency`, `quotedAmountMinor`, `estimatedGrossProfitMinor`, `estimatedContributionMinor`, `grossMarginBps`, `inputSnapshotHash`, `calculationHash`, `commercialAmountHash`, and the effective lifecycle event identity/recordedAt. `salesOwnerActorId` is frozen from the same Case assignment as the version, and the binding evidence is copied exactly from the persisted CommercialBindingSnapshot frozen into the formal version, not current CRM/handoff ownership. Advisor consumes it through the existing `GrowthQuoteAuthorityReaders.quoteVersions` port and never opens QuoteRepository. These monetary/probability values are read from the frozen formal QuoteVersion only; the reader is an internal authority port, and public callers must still remove sensitive profit/margin fields unless `pricing.sensitive.read` is present.
- Produces exact `QuotePreviewEvidenceReader.verifyAt(context: ActiveWorkspaceContext, input: { quoteCaseId: string; previewIdentity: QuotePreviewIdentity; inputSnapshotHash: \`sha256:${string}\`; calculationHash: \`sha256:${string}\` }, cutoff: GrowthSealedReadCutoff): Promise<QuotePreviewEvidenceSnapshot|null>`. The returned immutable snapshot includes exact evidence identity/hash/timestamps plus frozen `quoteCaseId`, `salesOwnerActorId`, and `subjectEvidence:QuoteSubjectEvidenceSnapshot`. It matches every supplied field against either an append-only `QuotePreviewEvidenceRecord` or an immutable draft/formal QuoteVersion recorded no later than `cutoff.effectiveAsOf`; the version path reconstructs the same frozen owner/subject shape from its Case/binding evidence. It never reads a mutable Case, current Catalog head, or latest-version pointer. Wrong hash/identity/workspace/token, missing/mismatched owner/subject evidence, or evidence recorded after the cutoff returns null; corrupt duplicate evidence fails closed.
- Produces: `AuthoritativeQuoteRef { quoteCaseId; quoteVersionId; commercialAmountHash; authorityRevision }`.
- Produces: `DealAuthoritativeQuoteReader.getCurrent(context: ActiveWorkspaceContext,dealId: string): Promise<AuthoritativeQuoteRef|null>` and `.getAt(context: ActiveWorkspaceContext,dealId: string,cutoff: GrowthSealedReadCutoff): Promise<AuthoritativeQuoteRef|null>`; both derive tenancy from the authorized context and reconstruct authority by revisioned events, not wall-clock tie breaking.
- Produces: `AuthoritativeDealDecisionRef { type:"won"|"lost"; dealId; quoteCaseId; quoteVersionId; currency; quotedAmountMinor; commercialAmountHash; commercialBindingEvidence: CommercialBindingEvidenceSnapshot; commercialBindingSnapshot: CommercialBindingSnapshot; authorityRevision; decidedAt }` and `DealAuthoritativeQuoteReader.getDecisionAt(context: ActiveWorkspaceContext,dealId: string,cutoff: GrowthSealedReadCutoff): Promise<AuthoritativeDealDecisionRef|null>`. The won/lost authority event copies the complete persisted `CommercialBindingSnapshot` from the same immutable formal QuoteVersion and also stores its exact seven-field `commercialBindingEvidence` projection; reader integrity validation requires the two forms, Case/version IDs and binding hash/schema to agree before returning either. Unlike the cleared current pointer, this returns the quote amount/currency/hash/binding frozen by the terminal authority event. Financial facts must accept both commercial value and binding only from this reader, never from request IDs, current CRM/Handoff rows, mutable Deal fields, or a newly reconstructed snapshot.
- Produces: `AuthoritativeQuoteContribution { candidateId; dealId; quoteVersionId; currency; approvedQuoteGrossProfitMinor; closeProbabilityBps; probabilityAssessmentId; commercialAmountHash }`.
- Produces: `AuthoritativeQuoteAsOfReader.listContributionsAsOf(context: ActiveWorkspaceContext, input: { candidateIds: string[]; currency: string; cutoff: GrowthSealedReadCutoff }): Promise<AuthoritativeQuoteContribution[]>`; it reconstructs lifecycle plus Deal authority history at `cutoff.effectiveAsOf`, excludes won/lost/superseded quotes, and yields at most one authoritative contribution per Deal. This stage knows candidates through the frozen `CommercialBindingSnapshot` and has no dependency on the later cohort/member/first-plan domain.
- Produces: approval transaction result `{ quoteVersion; approval; authority; authorityEvent; lifecycleEvents; publicationOperation }`.
- Produces publication stable key `quote-publication:<dealId>:<quoteVersionId>:<authorityRevision>`.
- Produces: `GrowthQuoteAuthorityReaders { commercialBindingVerifier: CommercialBindingVerifier; dealAuthoritativeQuotes: DealAuthoritativeQuoteReader; authoritativeContributions: AuthoritativeQuoteAsOfReader; quoteApprovals: QuoteApprovalAsOfReader; quoteVersions: QuoteVersionEvidenceReader; quotePreviews: QuotePreviewEvidenceReader }` and typed `GROWTH_QUOTE_AUTHORITY_READERS: GrowthPrivateServiceKey<GrowthQuoteAuthorityReaders>`. Every historical method in this exact private composite is token-only. `createGrowthQuoteModule` provides the frozen exact composite once only after every listed reader is constructed; Finance and Advisor require this exact key, seal once at their request boundary, pass one token by identity, and never reach into Quote repositories/current-only methods.
- Extends shared test fixtures with `approvalFixture` and `managerDecisionContext`; fixture method `cutoff(asOf)` delegates to the fake Foundation barrier's `sealReadCutoff`/opaque-token factory and never fabricates a structurally equivalent token inside a Quote reader.

- [ ] **Step 1: Write failing self-approval, multi-capability, and cross-Case authority tests**

```ts
test("submitter cannot confirm or approve their own quote", async () => {
  const state = approvalFixture({ submittedBy: "manager-1" });
  await assert.rejects(
    state.service.approve(commandContextFixture({
      actorId: "manager-1", expectedRevision: 1,
      idempotencyKey: "approval-self-0001"
    }), "version-1", { reason: "同意" }),
    (error: unknown) => (error as { code?: string }).code
      === "approval_self_decision_forbidden"
  );
});

test("approval rejects the immutable source draft and accepts only its formal submission", async () => {
  const state = approvalFixture({
    sourceDraftVersionId: "version-draft-1", submittedVersionId: "version-formal-2"
  });
  await assert.rejects(() => state.service.approve(
    managerDecisionContext(), "version-draft-1", { reason: "批准" }
  ), (error: unknown) => (error as { code?: string }).code
    === "formal_quote_version_required");
  const { value: approved } = await state.service.approve(
    managerDecisionContext(), "version-formal-2", { reason: "批准" }
  );
  assert.equal(approved.quoteVersion.versionKind, "formal");
  assert.equal(approved.quoteVersion.sourceDraftVersionId, "version-draft-1");
});

test("exception decision requires every merged capability", async () => {
  const state = approvalFixture({ requiredCapabilities: [
    "quote.exception.discount.approve",
    "quote.exception.payment_terms.approve"
  ] });
  await assert.rejects(
    state.service.approve(commandContextFixture({
      capabilities: ["quote.exception.discount.approve"],
      expectedRevision: 1, idempotencyKey: "approval-caps-0001"
    }), "version-1", { reason: "同意" }),
    (error: unknown) => (error as { code?: string }).code === "capability_forbidden"
  );
});

test("approving a different Case supersedes the prior authoritative version atomically", async () => {
  const state = approvalFixture({
    currentAuthority: { quoteCaseId: "case-a", quoteVersionId: "version-a" },
    submitted: { quoteCaseId: "case-b", quoteVersionId: "version-b" }
  });
  const { value: result } = await state.service.approve(managerDecisionContext(),
    "version-b", { reason: "批准新方案" });
  assert.equal(result.authority.quoteVersionId, "version-b");
  assert.equal(result.authorityEvent.previousQuoteVersionId, "version-a");
  assert.equal(result.lifecycleEvents.some((event) =>
    event.quoteVersionId === "version-a" && event.toStatus === "superseded"), true);
  assert.equal(result.publicationOperation.status, "queued");
});

test("as-of reader uses revision order and excludes won or lost deals", async () => {
  const state = approvalFixture({
    authorityEvents: [
      { authorityRevision: 1, quoteVersionId: "version-a", kind: "approved",
        recordedAt: "2026-08-09T08:00:00.000Z" },
      { authorityRevision: 2, quoteVersionId: "version-b", kind: "approved",
        recordedAt: "2026-08-09T08:30:00.000Z" },
      { authorityRevision: 3, previousQuoteVersionId: "version-b",
        quoteVersionId: "version-b", kind: "won",
        currency: "CNY", quotedAmountMinor: 298_000,
        commercialAmountHash: `sha256:${"b".repeat(64)}`,
        recordedAt: "2026-08-09T09:00:00.000Z" }
    ]
  });
  const beforeWon = await state.asOfReader.listContributionsAsOf(
    workspaceContextFixture("manager"),
    { candidateIds: ["candidate-1"], currency: "CNY",
      cutoff: state.cutoff("2026-08-09T08:59:59.999Z") }
  );
  assert.deepEqual(beforeWon.map((row) => row.quoteVersionId), ["version-b"]);
  const afterWon = await state.asOfReader.listContributionsAsOf(
    workspaceContextFixture("manager"),
    { candidateIds: ["candidate-1"], currency: "CNY",
      cutoff: state.cutoff("2026-08-09T09:00:00.000Z") }
  );
  assert.deepEqual(afterWon, []);
});

test("legacy equal-millisecond authority events still decode by revision", async () => {
  const state = approvalFixture({
    authorityEvents: [
      { authorityRevision: 1, quoteVersionId: "version-a", kind: "approved",
        recordedAt: "2026-08-09T08:30:00.000Z" },
      { authorityRevision: 2, quoteVersionId: "version-b", kind: "approved",
        recordedAt: "2026-08-09T08:30:00.000Z" }
    ]
  });
  const current = await state.reader.getAt(
    workspaceContextFixture("manager"), "deal-1",
    state.cutoff("2026-08-09T08:30:00.000Z")
  );
  assert.equal(current?.quoteVersionId, "version-b");
  assert.equal(current?.authorityRevision, 2);
});

test("decision reader preserves the exact won quote after current pointer clears", async () => {
  const state = approvalFixture({
    currentAuthority: null,
    decisionEvent: {
      type: "won", dealId: "deal-1", quoteCaseId: "case-b",
      quoteVersionId: "version-b", currency: "CNY", quotedAmountMinor: 298_000,
      commercialAmountHash: `sha256:${"b".repeat(64)}`,
      commercialBindingEvidence: {
        candidateId: "candidate-1", customerId: "customer-1", dealId: "deal-1",
        handoffContentHash: `sha256:${"c".repeat(64)}`,
        dealContentHash: `sha256:${"d".repeat(64)}`,
        bindingHashSchemaVersion: "commercial-binding.v1",
        bindingHash: `sha256:${"e".repeat(64)}`
      },
      commercialBindingSnapshot: {
        candidateId: "candidate-1", handoffId: "handoff-1", leadId: "lead-1",
        customerId: "customer-1", dealId: "deal-1", candidateVersion: 3,
        handoffContentHash: `sha256:${"c".repeat(64)}`,
        dealContentHash: `sha256:${"d".repeat(64)}`,
        bindingHashSchemaVersion: "commercial-binding.v1",
        attributionSnapshot: { attributionVersion: "acquisition-run.v1", runId: "run-1" },
        bindingHash: `sha256:${"e".repeat(64)}`,
        verifiedAt: "2026-08-08T08:00:00.000Z"
      },
      authorityRevision: 3, decidedAt: "2026-08-09T09:00:00.000Z"
    }
  });
  assert.equal(await state.reader.getCurrent(
    workspaceContextFixture("manager"), "deal-1"
  ), null);
  assert.deepEqual(await state.reader.getDecisionAt(
    workspaceContextFixture("manager"), "deal-1",
    state.cutoff("2026-08-09T09:00:00.000Z")
  ), state.decisionEvent);
  assert.equal(state.decisionEvent.currency, "CNY");
  assert.equal(state.decisionEvent.quotedAmountMinor, 298_000);
  await state.mutateCurrentCrmAndHandoff({
    candidateId: "candidate-rebound", customerId: "customer-rebound",
    dealId: "deal-1", handoffContentHash: `sha256:${"f".repeat(64)}`
  });
  const afterRebinding = await state.reader.getDecisionAt(
    workspaceContextFixture("manager"), "deal-1",
    state.cutoff("2026-08-09T10:00:00.000Z")
  );
  assert.deepEqual(afterRebinding?.commercialBindingEvidence,
    state.decisionEvent.commercialBindingEvidence);
  assert.deepEqual(afterRebinding?.commercialBindingSnapshot,
    state.decisionEvent.commercialBindingSnapshot);
  assert.equal(afterRebinding?.commercialBindingEvidence.candidateId, "candidate-1");
});

test("approval and quote evidence readers preserve the historical as-of view", async () => {
  const state = approvalFixture({
    submittedAt: "2026-08-09T08:00:00.000Z",
    approvedAt: "2026-08-09T09:00:00.000Z",
    expiredAt: "2026-08-09T10:00:00.000Z"
  });
  const context = workspaceContextFixture("manager");
  const cutoff = state.cutoff("2026-08-09T08:30:00.000Z");
  const pending = await state.approvalAsOfReader.listPendingAsOf(context, {
    cutoff, limit: 100
  });
  assert.deepEqual(pending.map((row) => row.quoteVersionId), ["version-1"]);
  assert.equal(pending[0]?.currency, "CNY");
  assert.equal(pending[0]?.quotedAmountMinor, 298_000);
  assert.equal(pending[0]?.estimatedGrossProfitMinor, 280_000);
  assert.equal(pending[0]?.closeProbabilityBps, 4_321);
  const evidence = await state.quoteVersionEvidenceReader.getAt(
    context, "version-1", cutoff
  );
  assert.equal(evidence?.lifecycleRevision, 1);
  assert.equal(evidence?.status, "submitted");
  assert.equal(evidence?.versionKind, "formal");
  assert.equal(evidence?.sourceDraftVersionId, "version-draft-1");
  assert.equal(evidence?.salesOwnerActorId, "sales-1");
  assert.deepEqual(evidence?.commercialBindingEvidence, {
    candidateId: "candidate-1", customerId: "customer-1", dealId: "deal-1",
    handoffContentHash: state.frozenHandoffContentHash,
    dealContentHash: state.frozenDealContentHash,
    bindingHashSchemaVersion: "commercial-binding.v1",
    bindingHash: state.frozenBindingHash
  });
  assert.equal(Object.isFrozen(evidence?.commercialBindingEvidence), true);
  assert.equal(evidence?.closeProbabilityBps, 4_321);
  assert.equal(evidence?.currency, "CNY");
  assert.equal(evidence?.estimatedGrossProfitMinor, 280_000);
  await state.applyLaterApprovalAndExpiry();
  await state.mutateCurrentCrmAndHandoff({
    customerId: "customer-other", dealOwner: "sales-other",
    handoffContentHash: `sha256:${"f".repeat(64)}`
  });
  assert.deepEqual(await state.approvalAsOfReader.listPendingAsOf(context, {
    cutoff, limit: 100
  }), pending);
  assert.deepEqual(await state.quoteVersionEvidenceReader.getAt(
    context, "version-1", cutoff
  ), evidence);
});

test("quote evidence rejects inconsistent frozen binding identity and workspace", async () => {
  const wrongCustomer = approvalFixture({
    formalVersionCustomerId: "customer-2", bindingCustomerId: "customer-1"
  });
  await assert.rejects(() => wrongCustomer.quoteVersionEvidenceReader.getAt(
    workspaceContextFixture("manager"), "version-1",
    wrongCustomer.cutoff("2026-08-09T08:30:00.000Z")
  ), (error: unknown) => (error as { code?: string }).code
    === "commercial_binding_authority_mismatch");
  const wrongHash = approvalFixture({ persistedBindingHashValid: false });
  await assert.rejects(() => wrongHash.quoteVersionEvidenceReader.getAt(
    workspaceContextFixture("manager"), "version-1",
    wrongHash.cutoff("2026-08-09T08:30:00.000Z")
  ), (error: unknown) => (error as { code?: string }).code
    === "commercial_binding_hash_mismatch");
  const crossWorkspace = approvalFixture({ versionWorkspaceId: "team-b" });
  assert.equal(await crossWorkspace.quoteVersionEvidenceReader.getAt(
    workspaceContextFixture("manager"), "version-1",
    crossWorkspace.cutoff("2026-08-09T08:30:00.000Z")
  ), null);
});

test("preview evidence is historical and rejects a wrong hash or later record", async () => {
  const state = approvalFixture({
    previewEffectiveAt: "2026-08-09T08:00:00.000Z",
    previewRecordedAt: "2026-08-09T08:10:00.000Z",
    previewIdentity: statePreviewIdentityFixture()
  });
  const context = workspaceContextFixture("manager");
  const input = {
    quoteCaseId: "case-1",
    previewIdentity: state.previewIdentity,
    inputSnapshotHash: state.previewIdentity.inputSnapshotHash,
    calculationHash: state.previewIdentity.calculationHash
  };
  const beforeCutoff = state.cutoff("2026-08-09T08:05:00.000Z");
  const visibleCutoff = state.cutoff("2026-08-09T08:15:00.000Z");
  assert.equal(await state.quotePreviewEvidenceReader.verifyAt(
    context, input, beforeCutoff
  ), null);
  const frozen = await state.quotePreviewEvidenceReader.verifyAt(
    context, input, visibleCutoff
  );
  assert.ok(frozen);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(frozen.salesOwnerActorId, "sales-1");
  assert.deepEqual(frozen.subjectEvidence, {
    candidateId: "candidate-1", customerId: "customer-1", dealId: "deal-1"
  });
  await state.mutateCurrentCaseAndCatalogHeads();
  assert.deepEqual(await state.quotePreviewEvidenceReader.verifyAt(
    context, input, visibleCutoff
  ), frozen);
  assert.equal(await state.quotePreviewEvidenceReader.verifyAt(context, {
    ...input, calculationHash: `sha256:${"f".repeat(64)}`
  }, visibleCutoff), null);
  assert.equal(await state.quotePreviewEvidenceReader.verifyAt(
    context, input, state.cutoff("2026-08-09T08:09:59.999Z")
  ), null);
  await assert.rejects(() => state.quotePreviewEvidenceReader.verifyAt(
    state.otherWorkspace,
    input, visibleCutoff
  ), (error: unknown) => (error as { code?: string }).code
    === "sealed_cutoff_workspace_mismatch");
});

test("an in-flight preview cannot become visible at an already queried cutoff", async () => {
  const state = approvalFixture({
    pausePreviewBeforeAppend: true,
    previewEffectiveAt: "2026-08-09T08:00:00.000Z",
    previewAppendServerNow: "2026-08-09T07:00:00.000Z",
    noExistingPreviewStream: true
  });
  const command = previewCommand("case-1", "preview-after-old-cutoff");
  const pending = state.quoteVersionService.preview(
    command, "case-1", quoteInputFixture()
  );
  await state.waitForPreviewAppendPause();
  const input = state.previewEvidenceInputFor(quoteInputFixture());
  const oldAsOf = "2026-08-09T08:05:00.000Z";
  const oldCutoff = await state.requestBoundary.sealOnce(
    state.managerContext, oldAsOf
  );
  assert.equal(await state.quotePreviewEvidenceReader.verifyAt(
    state.managerContext, input, oldCutoff
  ), null);
  state.releasePreviewAppend();
  await pending;
  assert.equal(await state.quotePreviewEvidenceReader.verifyAt(
    state.managerContext, input, oldCutoff
  ), null);
  const afterCutoff = await state.requestBoundary.sealOnce(
    state.managerContext, "2026-08-09T08:05:00.001Z"
  );
  const after = await state.quotePreviewEvidenceReader.verifyAt(
    state.managerContext, input, afterCutoff
  );
  assert.equal(after?.recordedAt, "2026-08-09T08:05:00.001Z");
  assert.deepEqual(state.firstSealThenAppendLockTrace(), [
    "seal:temporal:team-a", "append:temporal:team-a", "append:quote-case:case-1"
  ]);
  assert.equal(state.sealCallCountFor(oldCutoff), 1);
});

test("request clock rollback cannot backdate approval or Deal decision events", async () => {
  const state = approvalFixture({
    submittedAt: "2026-08-09T09:00:00.000Z",
    approvalRequestAttemptedAt: "2026-08-09T08:00:00.000Z",
    approvalTransactionServerNow: "2026-08-09T09:00:00.000Z",
    decisionRequestAttemptedAt: "2026-08-09T07:00:00.000Z",
    decisionTransactionServerNow: "2026-08-09T09:00:00.001Z"
  });
  const context = workspaceContextFixture("manager");
  await state.approveFormal();
  const atSubmitted = state.cutoff("2026-08-09T09:00:00.000Z");
  const atApproved = state.cutoff("2026-08-09T09:00:00.001Z");
  assert.deepEqual((await state.approvalAsOfReader.listPendingAsOf(context, {
    cutoff: atSubmitted, limit: 100
  })).map((row) => row.quoteVersionId), ["version-1"]);
  assert.deepEqual(await state.approvalAsOfReader.listPendingAsOf(context, {
    cutoff: atApproved, limit: 100
  }), []);
  assert.equal((await state.quoteVersionEvidenceReader.getAt(
    context, "version-1", atSubmitted
  ))?.status, "submitted");
  await state.decideLost();
  assert.equal((await state.reader.getAt(
    context, "deal-1", atApproved
  ))?.quoteVersionId, "version-1");
  assert.equal((await state.reader.getDecisionAt(
    context, "deal-1", state.cutoff("2026-08-09T09:00:00.002Z")
  ))?.type, "lost");
  assert.deepEqual(state.appendedRecordedTimes(), [
    "2026-08-09T09:00:00.001Z", "2026-08-09T09:00:00.002Z"
  ]);
});

test("one request seals once and passes the identical opaque cutoff to all readers", async () => {
  const state = approvalFixture({ captureCutoffIdentity: true });
  const context = workspaceContextFixture("manager");
  await state.requestBoundary.readQuoteEvidence(context,
    "2026-08-09T08:30:00.000Z", async (cutoff) => {
      await state.approvalAsOfReader.listPendingAsOf(context, {
        cutoff, limit: 100
      });
      await state.quoteVersionEvidenceReader.getAt(
        context, "version-1", cutoff
      );
    });
  assert.equal(state.temporalBarrierSealCalls(), 1);
  assert.equal(state.readerCutoffArguments().length, 2);
  assert.equal(state.readerCutoffArguments()[0], state.readerCutoffArguments()[1]);
  await assert.rejects(() => state.quoteVersionEvidenceReader.getAt(
    state.otherWorkspace, "version-1", state.readerCutoffArguments()[0]!
  ), (error: unknown) => (error as { code?: string }).code
    === "sealed_cutoff_workspace_mismatch");
});

test("pending approval visibility isolates sales owners inside one workspace", async () => {
  const state = approvalFixture({
    pendingApprovals: [
      { quoteVersionId: "formal-sales-a", salesOwnerActorId: "sales-a",
        submittedBy: "sales-a" },
      { quoteVersionId: "formal-sales-b", salesOwnerActorId: "sales-b",
        submittedBy: "sales-b" }
    ]
  });
  const input = {
    cutoff: state.cutoff("2026-08-09T08:30:00.000Z"), limit: 100
  };
  assert.deepEqual((await state.approvalAsOfReader.listPendingAsOf(
    workspaceContextFixture("sales", undefined, "sales-a"), input
  )).map((row) => row.quoteVersionId), ["formal-sales-a"]);
  assert.deepEqual((await state.approvalAsOfReader.listPendingAsOf(
    workspaceContextFixture("manager"), input
  )).map((row) => row.quoteVersionId), ["formal-sales-a", "formal-sales-b"]);
});
```

Add tests for confirmation capability, unknown capability registry version, reason required on reject, one decision winner, duplicate decision, stale If-Match, hard-block recheck, binding/hash recheck, lock order observation, Deal already won, old operation superseded, current pointer uniqueness, formal-only approval/authority, source-draft immutability, event revisions within one millisecond, monotonic append time under a regressing request clock, `getCurrent/getAt/getDecisionAt`, lifecycle/authority events sharing one timestamp, won/lost decision binding preservation, won and lost expected-ROI exclusion, one contribution per Deal, currency/candidate filtering, same-workspace different-sales pending visibility, frozen owner/submitter identity despite later CRM reassignment, frozen commercial-binding evidence despite later Customer/Deal/Handoff changes, preview evidence from both the append-only preview record and immutable QuoteVersion fallback, wrong preview/customer/deal/handoff/binding hash rejection, evidence after `dataAsOf`, cross-workspace null, corrupt duplicate preview evidence, and two MySQL connections approving across Cases with one final authority.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/quote-approval-service-test.ts src/authoritative-quote-reader-test.ts src/quote-preview-evidence-reader-test.ts src/quote-repository-test.ts src/quote-mysql-repository-test.ts`

Expected: FAIL because approval service, authority reader, and approval transaction commands are absent.

- [ ] **Step 3: Implement capability and decision validation**

```ts
const required = approval.approvalKind === "confirmation"
  ? ["quote.confirm" as const]
  : approval.requiredCapabilities;
requireGrowthCapabilities(context.workspace, required);
if (approval.submittedBy === context.actorId) {
  throw new QuoteApprovalError("approval_self_decision_forbidden");
}
```

Reject unknown capability registry version/key before checking grants. Recalculate gate and binding hashes under the transaction. Approval reason may be optional for approve but must be nonblank for reject/expire.

- [ ] **Step 4: Implement the fixed-order approval transaction and reader**

The MySQL command begins by locking Foundation's workspace temporal barrier and holds it to commit; only then does it lock/insert `deal_authoritative_quotes` for the Deal and lock QuoteCase. It locks Approval/Version plus the last lifecycle, approval, authority and publication records in their fixed domain order, requires `versionKind="formal"`, a non-null `sourceDraftVersionId`, and an immutable v2 probability snapshot, then calls `temporalBarrier.allocateAppend` successively for every affected lifecycle/approval/authority/publication append. It supersedes an old current formal version and unfinished operation, writes those records at strictly increasing workspace ticks, writes the formal-version current pointer and commercial amount hash, decides Approval, appends queued PublicationOperation, and commits while still holding the barrier. A regressing request/process/database clock and a never-before-seen stream are irrelevant; revision remains only a legacy decoder. No PI, DealEvent, or Outcome is written in this transaction.

At the HTTP/Pi/Advisor read-request boundary, derive the authorized `effectiveAsOf`, call the exact Foundation `temporalBarrier.sealReadCutoff(context,effectiveAsOf)` once in its own short transaction, wait for every earlier workspace writer, and pass the returned opaque token unchanged to every internal authority reader used by that request. No reader calls Foundation again or accepts a raw string; each first verifies token/context workspace equality, then passes only `cutoff.effectiveAsOf` to repository queries. `DealAuthoritativeQuoteReader.getAt` selects Deal authority events with `recordedAt<=cutoff.effectiveAsOf`, orders by `authorityRevision DESC`, and applies the event state machine: approved/superseded may select the new current at that revision; expired/won/lost clear current after preserving event evidence. `getDecisionAt` reads the latest effective won/lost authority event and returns that event's frozen Case/version/hash even though the current pointer is null. `AuthoritativeQuoteAsOfReader.listContributionsAsOf` uses the same authority/lifecycle reducer, freezes the exact formal version's v2 probability assessment, and returns no expected contribution once won/lost is effective. `QuoteApprovalAsOfReader` and `QuoteVersionEvidenceReader` reduce append-only approval/lifecycle events using `recordedAt<=cutoff.effectiveAsOf` plus monotonic revision; they never inspect a mutable current status. The version evidence reader validates that formal Version, Case and persisted CommercialBindingSnapshot share workspace/Case/customer/deal identity, freezes the Case's `salesOwnerActorId`, and requires recomputing the exact `createCommercialBindingSnapshot` canonical schema/version from the stored snapshot to reproduce `bindingHash`; corrupt mismatches fail closed. It then freezes the exact seven-field `commercialBindingEvidence` object, so later CRM/Handoff or assignment changes cannot rewrite old owner/Customer/Deal refs. `QuotePreviewEvidenceReader` exact-matches the caller's closed preview identity plus both hashes against only an immutable preview evidence row or immutable QuoteVersion whose creation/lifecycle `recordedAt` is no later than the token cutoff, and returns the same frozen sales owner plus candidate/customer/deal subject IDs from that evidence source. Calculation `effectiveAt` never substitutes for the cutoff, and it never falls back to a current Case/catalog/version head. Pending approval rows join the immutable formal Version, its Case assignment, and binding snapshot as-of submission to freeze `salesOwnerActorId` and `submittedBy`; sales filtering is exact actor equality after workspace scope, while `manager`/`admin`/`super_admin` scope still comes only from a concrete `ActiveWorkspaceContext`. A later approve/reject/expire event, Deal reassignment, or brand-new stream with a regressing clock therefore cannot rewrite a sealed Advisor cutoff or expose another sales owner's quote. No reader iterates current QuoteCase status or uses timestamps to break legacy equal-time revisions. At module install, freeze the six exact typed reader ports in `GrowthQuoteAuthorityReaders` and provide `GROWTH_QUOTE_AUTHORITY_READERS`; private consumers receive the exact instances used by Quote HTTP/tools and the same Foundation temporal singleton. Tests spy on the boundary and every reader to prove one seal call and strict token object identity across a multi-reader request, and verify that two same-workspace sales actors receive distinct frozen owner/subject evidence for otherwise valid preview/version hashes.

- [ ] **Step 5: Verify GREEN**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/quote-approval-service-test.ts src/authoritative-quote-reader-test.ts src/quote-preview-evidence-reader-test.ts src/quote-repository-test.ts src/quote-mysql-repository-test.ts && npm run build`

Expected: approval, authority, as-of, concurrency, and build PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/quote-approval-service.ts backend/src/quote-approval-service-test.ts backend/src/authoritative-quote-reader.ts backend/src/authoritative-quote-reader-test.ts backend/src/quote-preview-evidence-reader.ts backend/src/quote-preview-evidence-reader-test.ts backend/src/quote-repository.ts backend/src/quote-mysql-repository.ts backend/src/quote-repository-test.ts backend/src/quote-mysql-repository-test.ts backend/src/growth-quote-test-fixtures.ts backend/src/growth-quote-module.ts
git commit -m "feat: approve one authoritative deal quote"
```

### Task 6: Recoverable PI and CRM publication Worker

**Files:**
- Create: `backend/src/quote-crm-command.ts`
- Create: `backend/src/quote-crm-command-mysql.ts`
- Create: `backend/src/quote-crm-command-test.ts`
- Create: `backend/src/quote-publication-worker.ts`
- Create: `backend/src/quote-publication-worker-test.ts`
- Create: `backend/src/quote-publication-recovery-sweeper.ts`
- Create: `backend/src/quote-publication-recovery-sweeper-test.ts`
- Create: `backend/src/quote-projected-document-authority.ts`
- Create: `backend/src/quote-projected-document-authority-test.ts`
- Modify: `backend/src/quote-repository.ts`
- Modify: `backend/src/quote-mysql-repository.ts`
- Modify: `backend/src/types.ts`
- Modify: `backend/src/store.ts`
- Modify: `backend/src/mysql-store.ts`
- Modify: `backend/src/growth-quote-module.ts`
- Modify: `backend/src/growth-commercial-composition.ts`
- Modify: `backend/src/growth-commercial-composition-test.ts`
- Modify: `backend/src/server.ts`

**Interfaces:**
- Consumes: queued QuotePublicationOperation, immutable approved QuoteVersion, current Deal authority, legacy Deal/DealEvent/TradeDocument tables, existing worker lease patterns, and the exact Foundation `foundation.temporalBarrier` singleton plus the Task-3 `GrowthTemporalTransaction` adapter. Claim, renew, PI/CRM record, finish, fail, retry, cancellation, and specialized PI/CRM projection transactions all take the workspace temporal barrier as their first business lock and hold it through commit; no publication repository owns a second clock/HLC.
- Produces: `QuoteCrmCommand.ensurePiProjection(input): Promise<{piDocumentId:string}>` and `.publishQuotedDeal(input): Promise<{dealEventId:string}>`.
- Produces: specialized `CrmStore.mutateAuthoritativeQuoteProjection(command)` with memory/MySQL implementations; it updates legacy Deal/PI projection atomically without invoking global `persistAll/replaceRows`.
- Produces: `QuotePublicationWorker.runOne(operationId)`; `.start()` is not used because scheduling belongs to the sweeper/application.
- Produces `QuotePublicationClaim { operationId; leaseOwner; fencingToken; leaseExpiresAt; authorityRevision }` and repository operations `claimPublication(operationId,workerId,now,nextExpiry)`, `renewPublicationLease(claim,now,nextExpiry)`, `recordPiPublished(claim,piDocumentId,now)`, `recordCrmPublished(claim,dealEventId,now)`, `finishPublication(claim,now)`, `failPublication(claim,errorCode,now)`, `listRecoverablePublications`, and human `retryPublication`; claim must return a freshly read `running` row with exact owner/token/revision and `leaseExpiresAt>now`, while every subsequent worker transition requires that same full live predicate.
- Imports and implements, without redeclaration or widening, the Foundation-owned seam `QuoteProjectedDocumentAction = "submit_approval"|"approve"|"send"|"export"`, `QuoteProjectedDocumentAuthority { documentId; documentRevision; dealId; quoteCaseId; quoteVersionId; commercialAmountHash; dealAuthorityRevision }`, and `QuoteProjectedDocumentAuthorityValidator.assertAuthorized(context: ActiveWorkspaceContext,input:{ documentId:string; action:QuoteProjectedDocumentAction; expectedDocumentRevision:number }): Promise<QuoteProjectedDocumentAuthority>`. Produces one validator instance with that exact signature. It requires a `quote_projection` PI, an immutable formal QuoteVersion with the exact frozen amount/currency/line/package/hash, a matching authority event/revision, current authority for submit/approve/send, and action-specific human capability (`quote.confirm` for approve; `quote.draft.create` for submit/send/export). `legacy_unverified` always fails; this validator is never a Pi/Advisor tool and exposes no mutation method.
- Produces exact frozen `GrowthQuoteAcquisitionIntegrations { readonly probabilityAssessments: ProbabilityAssessmentWriter; readonly quoteProjectedDocumentAuthority: QuoteProjectedDocumentAuthorityValidator }` and typed `GROWTH_QUOTE_ACQUISITION_INTEGRATIONS: GrowthPrivateServiceKey<GrowthQuoteAcquisitionIntegrations>`. `createGrowthQuoteModule.install` assembles/provides it once from the reference-identical Task-2 writer and this task's validator; it is distinct from `GROWTH_QUOTE_AUTHORITY_READERS`. C0 `projectIntegrations` requires this exact key and copies both values without wrapping into the final required `GrowthAcquisitionIntegrations.probabilityAssessments` and `.quoteProjectedDocumentAuthority`; absence, duplicate provide, or a partial/lookalike object is a hard composition failure, never an optional downgrade. `server.ts` passes the validator only to `assertLegacyCommercialWriteAllowed`; after successful validation, the existing human PI lifecycle handler performs the requested noncommercial transition with its normal exact document `If-Match`. It never receives QuoteRepository, Catalog services, authority-reader composite, or the private registry, and no route may change projected commercial fields.
- Produces: `QuotePublicationRecoverySweeper.start()` and idempotent `.close()`.
- Extends shared test fixtures with `publicationFixture`.

- [ ] **Step 1: Write failing idempotent side-effect and fencing tests**

```ts
test("two workers create one PI and one quote DealEvent", async () => {
  const state = publicationFixture({ operationStatus: "queued" });
  const results = await Promise.all([
    state.workerA.runOne("publication-1"),
    state.workerB.runOne("publication-1")
  ]);
  assert.equal(results.filter((result) => result.status === "succeeded").length, 1);
  assert.equal(state.piDocuments.filter((doc) =>
    doc.quoteVersionId === "version-1").length, 1);
  assert.equal(state.dealEvents.filter((event) =>
    event.quoteVersionIdSnapshot === "version-1" && event.type === "quote").length, 1);
  assert.equal(state.outcomes.length, 0);
});

test("stale Worker cannot publish after won/lost raises authority revision", async () => {
  const state = publicationFixture({ pauseAfterClaim: true });
  const pending = state.workerA.runOne("publication-1");
  await state.waitForClaim();
  await state.raiseDealAuthority("won");
  state.releaseWorker();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(state.dealEvents.some((event) => event.type === "quote"), false);
});

test("publication reacquires guard before operation and loses to won", async () => {
  const state = publicationFixture({ pauseBeforePiTransaction: true });
  const publishing = state.workerA.runOne("publication-1");
  await state.waitForClaimReleased();
  const decided = await state.decideWon();
  state.releasePiTransaction();
  const result = await publishing;
  assert.equal(decided.event.type, "won");
  assert.equal(result.status, "cancelled");
  assert.deepEqual(state.sideEffectLockOrder, [
    "workspace_temporal_barrier", "deal_authoritative_quote",
    "quote_publication_operation"
  ]);
  assert.equal(state.piDocuments.length, 0);
});

test("an expired claim before reclaim has zero side effects and cannot record failure", async () => {
  const state = publicationFixture({
    now: "2026-08-09T08:10:00.001Z",
    claimedLeaseExpiresAt: "2026-08-09T08:10:00.000Z",
    pauseAfterClaim: true
  });
  const result = await state.workerA.resumeClaimed("publication-1");
  assert.equal(result.status, "lease_lost");
  assert.equal(state.piDocuments.length, 0);
  assert.equal(state.dealEvents.length, 0);
  assert.equal(state.operationWritesAfterClaim(), 0);
});

test("valid quote projection permits the existing human workflow while legacy PI remains blocked", async () => {
  const state = publicationFixture({ projectionState: "current" });
  await state.humanPiLifecycle.submitForApproval(
    state.humanCommand("sales-1", 1), "pi-quote-1",
    state.quoteProjectedDocumentAuthority
  );
  await state.humanPiLifecycle.approve(
    state.humanCommand("manager-1", 2), "pi-quote-1", { note: "同意发送" },
    state.quoteProjectedDocumentAuthority
  );
  await state.humanPiLifecycle.export(
    state.humanCommand("sales-1", 3), "pi-quote-1", { format: "pdf" },
    state.quoteProjectedDocumentAuthority
  );
  assert.equal(state.document("pi-quote-1").commercialAuthority, "quote_projection");
  assert.equal(state.document("pi-quote-1").quotedAmountMinor, 29_800);
  await assert.rejects(() => state.humanPiLifecycle.submitForApproval(
    state.humanCommand("sales-1", 1), "pi-legacy-1",
    state.quoteProjectedDocumentAuthority
  ), (error: unknown) => (error as { code?: string }).code
    === "authoritative_quote_required");
  assert.equal(state.aiToolNames().some((name) => name.includes("document")
    || name.includes("send") || name.includes("export")), false);
});

test("Quote provides one complete reference-identical Acquisition integration", async () => {
  const state = publicationFixture();
  const installed = await state.installQuoteModule();
  const privateIntegration = state.privateServices.require(
    GROWTH_QUOTE_ACQUISITION_INTEGRATIONS
  );
  assert.equal(Object.isFrozen(privateIntegration), true);
  assert.strictEqual(privateIntegration.probabilityAssessments,
    state.probabilityAssessments);
  assert.strictEqual(privateIntegration.quoteProjectedDocumentAuthority,
    state.quoteProjectedDocumentAuthority);
  const projected = state.projectIntegrations();
  assert.strictEqual(projected.probabilityAssessments,
    privateIntegration.probabilityAssessments);
  assert.strictEqual(projected.quoteProjectedDocumentAuthority,
    privateIntegration.quoteProjectedDocumentAuthority);
  await installed.close();
});

test("missing duplicate or projection failure closes Quote once and leaks no timer", async () => {
  for (const failure of ["missing-key", "duplicate-key", "projection-failure"] as const) {
    const state = publicationFixture({ integrationFailure: failure });
    await assert.rejects(() => state.installAndProject(),
      /growth_quote_acquisition_integrations/);
    assert.equal(state.quoteCloseCount(), 1);
    assert.equal(state.activeSweeperTimers(), 0);
    assert.equal(state.projectedPartialIntegrationCount(), 0);
  }
});
```

Add tests for crash after PI before CRM, crash after CRM before ACK, heartbeat renewal, expired lease claim, expired-before-reclaim zero writes, wrong owner/fencing token/authority revision, lease expiry between PI and record, partial failure status, retry authorization, superseded operation, exact authority mismatch, stable PI/DealEvent IDs, old PI marked superseded, observed `workspace temporal barrier → Deal guard → operation → legacy rows` side-effect lock order, successive publication history/projection temporal allocations, concurrent won/lost cancellation, no Outcome direct call, two real MySQL connections racing every claim/renew/record/finish/fail path, sweeper `start()` called twice but one timer/immediate scan, sweeper close waiting for active jobs, and deliberately failing later-module-install plus missing/duplicate Quote integration-key and later integration-projection fixtures proving C0 awaits the already returned Quote close handle and leaves zero timers/partial integration. Inject failure at every Quote resource-constructor position and prove all previously constructed resources close in strict reverse order once with zero private provide, route mount, tool registration, or timer; also inject each later provide/register/mount/start position and reuse the same close handle. Assert the private integration and both of its properties are frozen/reference-identical to module singletons, the authority-reader composite does not contain them, and final C0 projection cannot replace either. For every worker mutation, assert the barrier is held through commit, `recordedAt/temporalSequence` comes from the exact Foundation allocator, and a claim that expires before reclaim produces zero side effects and zero state/history writes. Document tests cover missing/fabricated quote fields, stale/current authority revision, frozen-version/hash/amount mismatch, stale document `If-Match`, actor lacking the action capability, valid existing human submit/approve/send/export through the exact validator, legacy PI refusal, attempted commercial revision, validator singleton identity, and absence of any AI tool name for these actions.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/quote-crm-command-test.ts src/quote-publication-worker-test.ts src/quote-publication-recovery-sweeper-test.ts src/quote-projected-document-authority-test.ts`

Expected: FAIL because command ports and publication Worker modules do not exist.

- [ ] **Step 3: Implement specialized legacy projection commands**

```ts
export interface QuoteCrmCommand {
  ensurePiProjection(input: {
    workspaceId: string;
    dealId: string;
    quoteCaseId: string;
    quoteVersion: QuoteVersion;
    dealAuthorityRevision: number;
    commercialAmountHash: string;
    stableKey: string;
  }): Promise<{ piDocumentId: string }>;
  publishQuotedDeal(input: {
    workspaceId: string;
    dealId: string;
    quoteCaseId: string;
    quoteVersion: QuoteVersion;
    dealAuthorityRevision: number;
    commercialAmountHash: string;
    piDocumentId: string;
    actorId: string;
    stableKey: string;
  }): Promise<{ dealEventId: string }>;
}
```

PI is a read-only `quote_projection` with quote IDs/hash/revision, one top-level line plus package snapshot details, and a projection state `current|superseded`. Its existing document approval controls export/send only; no PI revision or PATCH may change commercial content. `QuoteProjectedDocumentAuthorityValidator` loads the document through the authorized workspace, requires `commercialAuthority="quote_projection"` and every non-null authority field, loads the exact immutable formal QuoteVersion plus authority event, compares document revision, Deal/Case/version/hash/revision, currency, amount, quantity, lines, package snapshot and current-state requirement, then requires the action capability. Foundation's existing human lifecycle route passes the exact current document revision/action to this validator and, only on success, applies its normal revision-CAS noncommercial lifecycle update; export renders the validator's frozen authority version. A `legacy_unverified` document never reaches a lifecycle write. `publishQuotedDeal` validates the current guard, atomically projects Deal product/quantity/unitPrice/amount/currency/amountType/stage and inserts one authoritative DealEvent snapshot. Implement MySQL through a dedicated transaction method on the store; update in-memory arrays only after DB success so later legacy persistence cannot erase the projection.

- [ ] **Step 4: Implement leases, fencing, recovery, and application lifecycle**

Every publication mutation owns a separate short business transaction whose first lock is Foundation's workspace temporal barrier and whose last action is commit/release. Claim then locks only its `QuotePublicationOperation`, obtains lease-comparison `now` from the transaction's `currentTimestamp3()` (not from an append timestamp), changes queued or expired-running to `running` with lease owner, future expiry, and a monotonically increasing fencing token, and calls `foundation.temporalBarrier.allocateAppend(tx,workspaceId)` for the immutable claim/state-history row. It reads back and returns a claim only if status is `running`, owner/token/authority revision match, and `leaseExpiresAt>now`; otherwise it rolls back/returns null. Each PI or CRM side-effect transaction locks in the global order `workspace temporal barrier → DealAuthoritativeQuote guard → QuotePublicationOperation → legacy Deal/PI rows`, revalidates authority revision and the complete live claim after the domain locks, and never waits for the Deal guard while holding the operation row. `renewPublicationLease`, `recordPiPublished`, `recordCrmPublished`, `finishPublication`, and `failPublication` each update only `WHERE status='running' AND lease_owner=? AND fencing_token=? AND authority_revision=? AND lease_expires_at>?`, require `affectedRows===1`, and compare expiry with transaction server `now`; memory parity uses the same predicate. A successful mutation calls `allocateAppend` for its immutable operation state/history record, and PI/CRM commands call it successively for projection evidence/DealEvent before commit, persisting both `recordedAt` and `temporalSequence`. Retry and cancellation transactions follow the same barrier-first order and allocations. Before any external or database PI action, before CRM, before recording either returned ID, before completion, and before failure recording, reload authority and require the live claim. An expired owner performs zero side effects and zero operation/history writes even when no replacement has reclaimed; transient failure then leaves the row recoverable. Cancellation/supersession or revision mismatch stops work. Persist each successful side-effect ID under a live claim before the next action. Retry only failed/partial_failure with a new fencing token and never resets successful IDs. Lease wall time and append authority time remain separate.

Construct one Worker and one sweeper inside `createGrowthQuoteModule`; the Worker, Quote repository, specialized legacy projection command and every state writer receive the exact same `foundation.temporalBarrier` reference, and the module test asserts strict singleton identity/nonreplaceability. Before constructing the first owned resource, create one module-local reverse-order close stack and its idempotent `closeQuoteResources=onceAsync(...)`; perform **every** constructor inside the same `try`, and immediately register each successfully constructed resource's close handle before constructing the next. Thus constructor N throwing closes N-1 through 1 in strict reverse order even though C0 cannot yet own a returned handle. The same enclosing catch covers every provide/register/mount/start action, awaits that one handle, attaches cleanup failures without replacing the original error, and rethrows. After constructing the Task-2 writer and validator, freeze/provide exactly one `GROWTH_QUOTE_ACQUISITION_INTEGRATIONS` object; duplicate/partial provision fails before start. Call `sweeper.start()` exactly once as the final successful action of Quote module installation, after Quote repositories/services/routes/tools/all private services and the integration object are ready. Do not wait for the application-level `projectIntegrations` pass: the module has no post-projection hook. `start()` itself is idempotent and owns one immediate scan plus one interval. As soon as install returns, C0 owns the same Quote close handle; if any later module install or the later integration-projection pass (which requires this key and copies both references atomically) fails, C0 reverse-closes installed modules and must await Quote close, leaving zero timers and no partial projected integration. The close stack includes sweeper stop, active task settlement, repositories/pool and every owned adapter in exact reverse construction order. Inject failure at each constructor and each private-service provide/router/tool registration/integration-key/start position: constructor failure yields zero provide/mount/tool/timer and closes all prior resources once; later failure uses the same handle; repeated close is a no-op. A later module/projection failure is handled only by C0 reverse-close. Do not start another Worker from Acquisition application. Project the exact singleton `ProbabilityAssessmentWriter` and `QuoteProjectedDocumentAuthorityValidator` only from the typed Quote integration object through `growth-commercial-composition.ts`; their identities must match the module fixtures, Acquisition wrapper/Foundation guard options, and `server.ts` injections.

- [ ] **Step 5: Verify GREEN**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/quote-crm-command-test.ts src/quote-publication-worker-test.ts src/quote-publication-recovery-sweeper-test.ts src/quote-projected-document-authority-test.ts src/growth-commercial-composition-test.ts && npm run build`

Expected: side-effect, fencing, recovery, and build PASS with one PI and DealEvent per authority revision.

- [ ] **Step 6: Commit**

```bash
git add backend/src/quote-crm-command.ts backend/src/quote-crm-command-mysql.ts backend/src/quote-crm-command-test.ts backend/src/quote-publication-worker.ts backend/src/quote-publication-worker-test.ts backend/src/quote-publication-recovery-sweeper.ts backend/src/quote-publication-recovery-sweeper-test.ts backend/src/quote-projected-document-authority.ts backend/src/quote-projected-document-authority-test.ts backend/src/quote-repository.ts backend/src/quote-mysql-repository.ts backend/src/types.ts backend/src/store.ts backend/src/mysql-store.ts backend/src/growth-quote-module.ts backend/src/growth-commercial-composition.ts backend/src/growth-commercial-composition-test.ts backend/src/server.ts
git commit -m "feat: recover quote PI and CRM publication"
```

### Task 7: Authoritative won/lost decision and Outcome reconciliation

**Files:**
- Create: `backend/src/deal-commercial-decision-service.ts`
- Create: `backend/src/deal-commercial-decision-service-test.ts`
- Modify: `backend/src/quote-crm-command.ts`
- Modify: `backend/src/quote-crm-command-mysql.ts`
- Modify: `backend/src/quote-repository.ts`
- Modify: `backend/src/quote-mysql-repository.ts`
- Modify: `backend/src/types.ts`
- Modify: `backend/src/acquisition-crm-outcome-reconciliation.ts`
- Modify: `backend/src/acquisition-crm-outcome-reconciliation-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/growth-quote-module.ts`

**Interfaces:**
- Consumes: Deal guard, authoritative QuoteVersion/hash, trusted binding, publication operations, internal Reconciler capability, and the exact Foundation `foundation.temporalBarrier` singleton/Task-3 transaction adapter. Decision transactions never sample or advance a domain-local clock.
- Produces: `DealCommercialDecisionInput = { type:"won"|"lost"; quoteVersionId:string; commercialAmountHash:string; reasonCode:string|null; reasonText:string|null; occurredAt:string } | { type:"pre_quote_disqualified"; reasonCode:string; reasonText:string|null; occurredAt:string }`.
- Produces exact `DealCommercialDecisionResult { deal; event; quoteCase; authorityRevision; cancelledPublicationOperationIds }` and `DealCommercialDecisionService.decide(commandContext,dealId,input):Promise<QuoteCommandExecution<DealCommercialDecisionResult>>`; the wrapper is internal transport metadata and never enters a DealEvent/Outcome DTO.
- Extends: `QuoteCrmCommand.decideDeal(input)` to atomically increment authority revision, cancel unfinished publication, update Deal stage/amount type, append authoritative won/lost or amountless pre-quote lost DealEvent, close QuoteCase, and clear current pointer.
- Extends DealEvent authority fields with `commercialAuthority: "legacy_unverified" | "quote_projection" | "pre_quote_disqualified"`, quote IDs/hash/revision, exact amount/currency snapshots, and for `won|lost` the formal QuoteVersion's exact frozen `commercialBindingEvidence` plus complete `commercialBindingSnapshot`. These binding fields are server-copied authority evidence and absent for `pre_quote_disqualified`/legacy records; no request DTO can set them.
- Strengthens: Reconciler accepts quoted/won/lost only with internal capability, current or historical authority event match, stable DealEvent key, valid binding, exact QuoteVersion amount/hash, and event authority revision.
- Extends shared test fixtures with `dealDecisionFixture` and `reconciliationFixture`.

- [ ] **Step 1: Write failing decision and tamper-reconciliation tests**

```ts
test("won requires the current authoritative version and amount hash", async () => {
  const state = dealDecisionFixture();
  await assert.rejects(
    state.service.decide(managerDecisionContext(), "deal-1", {
      type: "won", quoteVersionId: "version-old",
      commercialAmountHash: state.currentHash,
      reasonCode: null, reasonText: null, occurredAt: NOW
    }),
    (error: unknown) => (error as { code?: string }).code
      === "quote_version_conflict"
  );
  await assert.rejects(
    state.service.decide(managerDecisionContext(), "deal-1", {
      type: "won", quoteVersionId: "version-1",
      commercialAmountHash: `sha256:${"0".repeat(64)}`,
      reasonCode: null, reasonText: null, occurredAt: NOW
    }),
    (error: unknown) => (error as { code?: string }).code
      === "commercial_amount_hash_mismatch"
  );
});

test("pre-quote disqualification closes funnel without commercial amount", async () => {
  const state = dealDecisionFixture({ authority: null });
  const { value: result } = await state.service.decide(
    managerDecisionContext(), "deal-1", {
      type: "pre_quote_disqualified", reasonCode: "no_budget",
      reasonText: "客户暂无预算", occurredAt: NOW
    }
  );
  assert.equal(result.event.commercialAuthority, "pre_quote_disqualified");
  assert.equal(result.event.amountMinorSnapshot, null);
  assert.equal(result.event.quoteVersionIdSnapshot, null);
});

test("Reconciler rejects a tampered Deal amount hash and never writes Outcome", async () => {
  const state = reconciliationFixture({
    eventHash: `sha256:${"f".repeat(64)}`,
    authoritativeHash: `sha256:${"a".repeat(64)}`
  });
  const result = await state.reconciler.runTenant(state.scope);
  assert.equal(result.reconciled, 0);
  assert.equal(state.outcomes.length, 0);
  assert.equal(state.diagnostics[0]?.code, "commercial_authority_mismatch");
});
```

Add tests for quoted before Worker publication, lost after quote, lost with noncurrent version, repeated decision idempotency, won/lost race, concurrent Worker cancellation, pointer clearing, authority revision event, Case closing, no-authority won rejection, cross-binding rejection, public Outcome refusal, Reconciler-only capability, exactly-once stable event replay, and pre-quote lost Outcome excluded from ROI amount. Freeze the complete formal-version CommercialBindingSnapshot plus its exact seven-field evidence projection into the won/lost event, round-trip both through memory/MySQL, mutate/rebind the live Handoff/Customer/Deal afterward, and prove `getDecisionAt` still returns the original candidate/customer/deal/hashes while a corrupt event whose snapshot/evidence disagree fails closed. Observe `workspace temporal barrier → Deal guard → Quote/domain streams`, assert every decision/cancellation/lifecycle append receives a strictly increasing `temporalSequence`, and add a brand-new Deal/Case stream whose transaction clock is behind an already sealed cutoff: the later decision must remain invisible at the old cutoff and appear only after its barrier-allocated tick.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/deal-commercial-decision-service-test.ts src/acquisition-crm-outcome-reconciliation-test.ts`

Expected: FAIL because the decision service and authoritative Reconciler validation are absent.

- [ ] **Step 3: Implement the guarded decision transaction**

```ts
if (input.type !== "pre_quote_disqualified") {
  if (!authority?.quoteVersionId
    || authority.quoteVersionId !== input.quoteVersionId) {
    throw new DealCommercialDecisionError("quote_version_conflict");
  }
  if (authority.commercialAmountHash !== input.commercialAmountHash) {
    throw new DealCommercialDecisionError("commercial_amount_hash_mismatch");
  }
} else if (authority?.quoteVersionId) {
  throw new DealCommercialDecisionError("authoritative_quote_already_exists");
}
```

Begin the specialized command transaction by locking Foundation's workspace temporal barrier and keep it through commit; only then lock the Deal guard shared with approval and every affected authority/lifecycle/publication/legacy Deal stream in fixed domain order. Increment authority revision, and call `foundation.temporalBarrier.allocateAppend(tx,workspaceId)` successively for the won/lost authority event, publication cancellation history, DealEvent and Case lifecycle records, persisting each returned `recordedAt/temporalSequence`. The authority event freezes the prior current `quoteCaseId`, `quoteVersionId`, `currency`, `quotedAmountMinor`, `commercialAmountHash`, complete persisted `CommercialBindingSnapshot`, and exact `CommercialBindingEvidenceSnapshot` projection directly from the same immutable formal QuoteVersion. Before append, recompute/verify the binding hash and require Case, version, snapshot, evidence and Deal IDs to match. The same transaction updates Deal, closes Case, and clears only the mutable current pointer. A new Deal/Case stream and a regressing DB/process clock still allocate strictly after every previously sealed workspace cutoff. The request boundary seals once through Foundation and passes the resulting opaque `GrowthSealedReadCutoff` unchanged; `DealAuthoritativeQuoteReader.getDecisionAt` validates token/context workspace identity plus snapshot/evidence integrity, returns those event-frozen values, never reseals, and never reloads mutable Deal, Handoff, Customer, amount, currency, or binding. Client `occurredAt` remains separate business evidence and request `attemptedAt` remains idempotency evidence; neither becomes append `recordedAt`. Pre-quote decision carries no commercial amount or binding and requires a nonblank reason code.

- [ ] **Step 4: Validate authority inside the sole Reconciler**

For quote/won/lost, load the Deal authority event by event revision and QuoteVersion; compare Deal, Case, version, exact frozen binding snapshot/evidence/hash schema, amount, currency, and commercial hash. Pass `AcquisitionOutcomeWriteAuthority` only after validation, and attribute the outcome to the event-frozen candidate/customer/deal rather than current CRM ownership. Use `deal-event:<eventId>` as the stable key. A diagnostic skip remains retryable if publication is incomplete and permanent if any authority/binding/hash is invalid.

- [ ] **Step 5: Verify GREEN and legacy guards**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/deal-commercial-decision-service-test.ts src/acquisition-crm-outcome-reconciliation-test.ts src/commercial-authority-guard-test.ts && npm run test:acquisition`

Expected: decision/Reconciler/guard tests and all acquisition tests PASS; there is one Outcome writer.

- [ ] **Step 6: Commit**

```bash
git add backend/src/deal-commercial-decision-service.ts backend/src/deal-commercial-decision-service-test.ts backend/src/quote-crm-command.ts backend/src/quote-crm-command-mysql.ts backend/src/quote-repository.ts backend/src/quote-mysql-repository.ts backend/src/types.ts backend/src/acquisition-crm-outcome-reconciliation.ts backend/src/acquisition-crm-outcome-reconciliation-test.ts backend/src/acquisition-application.ts backend/src/growth-quote-module.ts
git commit -m "feat: decide authoritative acquisition deals"
```

### Task 8: Complete quote HTTP routes and frozen-contract response conformance

**Files:**
- Create: `backend/src/quote-router.ts`
- Create: `backend/src/quote-router-test.ts`
- Create: `backend/src/quote-runtime-response-conformance-test.ts`
- Modify: `backend/src/growth-openapi-response-conformance-test.ts`
- Modify: `backend/src/growth-quote-module.ts`

**Interfaces:**
- Consumes: QuoteCase, QuoteVersion, Approval, publication, and Deal decision services; the exact Foundation singleton request adapters `workspaceContext: GrowthWorkspaceContextResolver` and `commandContextFactory: GrowthCommandContextFactory`, plus the same `temporalBarrier: GrowthTemporalBarrier` already used by every Quote repository/service; frozen Growth quote schemas. It never imports/calls `commandContextFromRequest` directly or constructs a temporal adapter.
- Produces: `createQuoteRouter(options: { cases; versions; approvals; publications; decisions; workspaceContext: GrowthWorkspaceContextResolver; commandContextFactory: GrowthCommandContextFactory; temporalBarrier: Pick<GrowthTemporalBarrier,"sealReadCutoff"> }): Router` with the complete frozen route surface. `GrowthQuoteModuleOptions` cannot replace any request/temporal adapter; module install reads and passes the exact references from `GROWTH_FOUNDATION_SERVICES`.
- Produces routes: list/create/get/bind/close/cancel Case; preview/create/list/get Version; submit/approve/reject/expire; list approvals; get/retry PublicationOperation; decide Deal.
- Every list has frozen cursor/limit/sort query semantics; every resource response returns capability-aware projection and ETag where specified.
- `projectQuoteVersion(version,capabilities)` omits standard cost, floor, detailed fulfillment/sales/service cost, and detailed margin without `pricing.sensitive.read`; it never alters authoritative total/hash.
- Extends shared test fixtures with `quoteRouterFixture`.

- [ ] **Step 1: Write failing route state, header, and projection tests**

```ts
test("quote routes require idempotency and exact revision headers", async () => {
  const api = quoteRouterFixture();
  await api.post("/api/v1/quotes/cases").send({
    candidateId: "candidate-1", assignedTo: "sales-1"
  }).expect(400).expect(({ body }) => {
    assert.equal(body.code, "idempotency_key_required");
  });
  await api.post("/api/v1/quotes/versions/version-1/submit")
    .set("Idempotency-Key", "submit-route-0001")
    .send({}).expect(428).expect(({ body }) => {
      assert.equal(body.code, "revision_required");
    });
  await api.post("/api/v1/quotes/cases/case-1/preview")
    .set("Idempotency-Key", "preview-route-missing-revision")
    .send(quoteInputFixture()).expect(428).expect(({ body }) => {
      assert.equal(body.code, "revision_required");
    });
});

test("sales quote projection hides policy-sensitive amounts", async () => {
  const api = quoteRouterFixture({ role: "sales" });
  const response = await api.get("/api/v1/quotes/versions/version-1")
    .expect(200);
  assert.equal("estimatedFulfillmentCostMinor" in response.body, false);
  assert.equal("absoluteFloorAmountMinor" in response.body, false);
  assert.equal(response.body.quotedAmountMinor, 29_800);
  assert.match(response.body.commercialAmountHash, /^sha256:/u);
});

test("quote router uses the exact Foundation context adapters once per handler", async () => {
  const state = quoteRouterFixture({ captureFoundationAdapters: true });
  await state.api.get("/api/v1/quotes/versions/formal-2").expect(200);
  await state.api.post("/api/v1/quotes/versions/draft-1/submit")
    .set("Idempotency-Key", "submit-adapter-0001")
    .set("If-Match", '"quote-version:draft-1:1"').send({}).expect(201);
  assert.deepEqual(state.adapterCalls(), [
    { kind: "workspaceContext", sameReference: true },
    { kind: "commandContextFactory", sameReference: true,
      canonicalPath: "/api/v1/quotes/versions/:id/submit",
      pathParams: { id: "draft-1" } }
  ]);
  assert.equal("workspaceContext" in state.moduleOptions, false);
  assert.equal("commandContextFactory" in state.moduleOptions, false);
});

test("one idempotency key cannot submit two draft path IDs", async () => {
  const state = quoteRouterFixture({ drafts: ["draft-a", "draft-b"] });
  await state.api.post("/api/v1/quotes/versions/draft-a/submit")
    .set("Idempotency-Key", "submit-cross-id-0001")
    .set("If-Match", '"quote-version:draft-a:1"').send({}).expect(201);
  await state.api.post("/api/v1/quotes/versions/draft-b/submit")
    .set("Idempotency-Key", "submit-cross-id-0001")
    .set("If-Match", '"quote-version:draft-b:1"').send({}).expect(409)
    .expect(({ body }) => assert.equal(body.code, "idempotency_conflict"));
  assert.equal(state.formalVersionsFor("draft-b").length, 0);
});

test("preview route hashes its Case path and replays frozen evidence", async () => {
  const state = quoteRouterFixture({ cases: ["case-a", "case-b"] });
  await state.api.post("/api/v1/quotes/cases/case-a/preview")
    .set("Idempotency-Key", "preview-route-stale-case")
    .set("If-Match", '"quote-case:case-a:0"')
    .send(quoteInputFixture()).expect(412)
    .expect(({ body }) => assert.equal(body.code, "revision_conflict"));
  assert.equal(state.previewEvidenceFor("case-a").length, 0);
  const first = await state.api.post("/api/v1/quotes/cases/case-a/preview")
    .set("Idempotency-Key", "preview-route-cross-case")
    .set("If-Match", '"quote-case:case-a:1"')
    .send(quoteInputFixture()).expect(200);
  state.expireCurrentCatalogWindows();
  const replay = await state.api.post("/api/v1/quotes/cases/case-a/preview")
    .set("Idempotency-Key", "preview-route-cross-case")
    .set("If-Match", '"quote-case:case-a:1"')
    .send(quoteInputFixture()).expect(200)
    .expect("Idempotency-Replayed", "true");
  assert.deepEqual(replay.body, first.body);
  await state.api.post("/api/v1/quotes/cases/case-b/preview")
    .set("Idempotency-Key", "preview-route-cross-case")
    .set("If-Match", '"quote-case:case-b:1"')
    .send(quoteInputFixture()).expect(409)
    .expect(({ body }) => assert.equal(body.code, "idempotency_conflict"));
  assert.equal(state.previewEvidenceFor("case-b").length, 0);
});
```

Add tests for strict extra fields, body workspace injection, cross-workspace 404, replay after capability removal, ETag shapes, stale revision codes, hard-block response, self approval, reject reason, publication failed/retry, decision union validation, and every route/status in the frozen operation inventory.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/quote-router-test.ts src/quote-runtime-response-conformance-test.ts`

Expected: FAIL because Quote router and conformance cases do not exist.

- [ ] **Step 3: Implement strict route adapters**

```ts
router.post("/api/v1/quotes/versions/:id/approve", asyncRoute(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const body = approvalDecisionSchema.parse(req.body);
  const context = options.commandContextFactory(req, {
    canonicalPath: "/api/v1/quotes/versions/:id/approve",
    pathParams: Object.freeze({ id }),
    payload: body,
    expectedRevision: parseIfMatchRevision(req, `quote-version:${id}`)
  });
  const execution = await options.approvals.approve(
    context,
    id,
    body
  );
  const result = execution.value;
  if (execution.replayed) res.set("Idempotency-Replayed", "true");
  setRevisionEtag(res, "quote-version", result.quoteVersion.id,
    result.quoteVersion.lifecycleRevision);
  res.json(projectApprovalResult(result, context.workspace.capabilities));
}));
```

Implement all listed handlers with closed Zod schemas derived from the frozen transport contract. Read handlers obtain context only through `options.workspaceContext(req)`; a handler that delegates to any token-only historical reader first derives the authorized Foundation `effectiveAsOf`, calls `options.temporalBarrier.sealReadCutoff(context,effectiveAsOf)` exactly once at that request boundary, and passes the same opaque token to all participating readers. It never asks a service/reader to seal again or forwards an unchecked future client timestamp. Every evidence/domain write strictly parses every path parameter before calling only `options.commandContextFactory(req,{canonicalPath,pathParams,payload,expectedRevision})`, then reaches exactly one command-service boundary that invokes Foundation's free `executeGrowthIdempotentCommand`; the router never adds a second reservation. Case create/bind/close/cancel, preview, draft create, formal submit, approval/rejection/expiry, and won/lost decision each freeze one domain `stableCommandHash`, probe that durable business result before mutable Catalog/current-head work on a reclaimed reservation, complete Foundation with internal resource/operation IDs only, and reauthorize/reproject on every replay. A crash after any business commit but before HTTP completion therefore converges without a second Case/version/approval/authority event even when current Catalog windows changed; capability loss rejects projection without returning cached sensitive data. Worker publication remains on its own durable fenced operation, not the HTTP helper. Preview passes `{id}` plus ``expectedRevision: parseIfMatchRevision(req, `quote-case:${id}`)``; like every Quote write it receives `QuoteCommandExecution<T>`, serializes only `.value`, and sets `Idempotency-Replayed:true` exactly when `.replayed` is true. Every other revisioned Quote handler likewise builds `quote-case:${id}` or `quote-version:${id}` from the exact already parsed route variable; no handler parses a type-only scope. This matches the frozen frontend `previewQuote(caseId,input,etag,idempotencyKey)` contract without putting execution metadata in the body. On the first execution the repository locks the Case and enforces that revision before appending evidence. On an exact completed replay the helper still performs current workspace/capability/Case-access authorization but projects the referenced frozen evidence without treating a later Case revision as a stale replay. Use a closed frozen map with contract names (`{id}` or `{dealId}` as applicable); collection routes pass `{}`. Foundation includes sorted path params in `requestHash`, so cross-ID same-key attempts fail as `idempotency_conflict` during reservation and write nothing. No handler reconstructs workspace/actor/capability/hash/idempotency fields. Submit treats the path ID/ETag as the immutable source draft revision and returns/ETags the newly appended formal submitted version; approval routes accept only that formal ID. Business errors map to stable standard envelopes and precise status codes. Route tests cover fresh-then-replay headers for Case create, preview, draft create, formal submit, approval, and won/lost decision; each test uses the exact ID-scoped ETag (`"quote-case:<id>:<revision>"` or `"quote-version:<id>:<revision>"`), proves a same-revision ETag from another ID is rejected, and every replay reloads current authority and projects the frozen result rather than inferring the header from a cached DTO.

- [ ] **Step 4: Register once and validate real responses against the frozen release**

Mount `createQuoteRouter` only from `createGrowthQuoteModule.install({ router, privateServices, ... })`; require `GROWTH_FOUNDATION_SERVICES` first and pass `foundation.workspaceContext`, `foundation.commandContextFactory`, and `foundation.temporalBarrier` by exact identity, while all injected Quote services/repositories retain that same temporal reference. `GrowthQuoteModuleOptions` exposes none of those three adapters, so callers cannot replace them. Never edit the C0 application kernel or add a direct server mount. The module/router test captures all three references, asserts strict identity with Foundation, proves a multi-reader HTTP request seals once and forwards the same token, and rejects a lookalike temporal adapter through the options contract; a missing Foundation key fails before repository construction or route registration. The runtime conformance test starts the real composed router, exercises normal and error responses, and validates body/headers/status through the frozen schema loader. Append these real route cases to `growth-openapi-response-conformance-test.ts` without editing static contract or path builder.

- [ ] **Step 5: Verify GREEN**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/quote-router-test.ts src/quote-runtime-response-conformance-test.ts && npm run test:growth-openapi && npm run check:growth-contracts && npm run build`

Expected: all quote routes conform to the frozen release and build PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/quote-router.ts backend/src/quote-router-test.ts backend/src/quote-runtime-response-conformance-test.ts backend/src/growth-openapi-response-conformance-test.ts backend/src/growth-quote-module.ts
git commit -m "feat: expose quote decision API"
```

### Task 9: Controlled quote Pi tools through singleton Growth tool ports

**Files:**
- Create: `backend/src/growth-advisor-quote-tools.ts`
- Create: `backend/src/growth-advisor-quote-tools-test.ts`
- Modify: `backend/src/acquisition-pi-tools.ts`
- Modify: `backend/src/acquisition-pi-tools-test.ts`
- Modify: `backend/src/acquisition-tool-executor.ts`
- Modify: `backend/src/acquisition-tool-executor-test.ts`
- Modify: `backend/src/acquisition-pi-agent.ts`
- Modify: `backend/src/acquisition-pi-agent-test.ts`
- Modify: `backend/src/acquisition-model-content.ts`
- Modify: `backend/src/acquisition-model-content-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/growth-quote-module.ts`

**Interfaces:**
- Consumes: the singleton `GrowthCommercialToolPorts` from `growthRuntime.toolPorts`, the exact final Catalog private composite `GROWTH_CATALOG_SERVICES { catalogItems; pricingPolicies; packageVersions; quoteCatalog; commissionCatalogProjection }`, exact token-only `QuoteApprovalAsOfReader`/`QuoteVersionEvidenceReader`, the same Foundation `temporalBarrier`, exact projected `GrowthAcquisitionWorkspaceResolver`, the existing authenticated Copilot session/actor membership and current-capability authority, existing Pi exact allowlist, `AcquisitionToolResultLedgerPort`, audit ledger, model/prompt/schema snapshots, and quote command services from the same Quote module. The Acquisition adapter reloads one trusted `ActiveWorkspaceContext` from those authorities on every attempt; it never accepts workspace/role/capabilities from the tool payload, constructs current-only wrappers, or creates a second Catalog graph.
- Preserves the C0 `GrowthCommercialToolPorts` registry shape (`register`/`execute`) and registers seven handlers backed by the already-constructed catalog/quote services; it adds no `catalog`, `quotes`, or `probabilityAssessments` object properties.
- Solely owns these seven catalog/quote tool names: `list_catalog_items`, `get_pricing_policy`, `preview_quote`, `create_quote_draft`, `list_pending_quote_approvals`, `get_quote_decision`, and `create_quote_approval_task`. The Advisor plan owns its five performance/gap/recommendation/todo/outcome tools and must not redefine these seven.
- Produces: `GROWTH_QUOTE_TOOL_BLUEPRINTS` with independent versioned TypeBox schemas and exact execution mode. Its closed `preview_quote` input is `{ quoteCaseId; quoteCaseRevision; quoteInput }`, so the Pi command observes the same Case precondition as the frozen HTTP preview contract.
- Introduces in the Acquisition-owned executor module the domain-neutral seam `GrowthAcquisitionToolDelegate { owns(toolName:string):boolean; execute(input:AcquisitionToolExecutionInput):Promise<unknown> }`. This is the one production option type shared by the Quote child now and the later Advisor composite; it contains no Quote service/property and is not narrowed back to one child.
- Produces the child `GrowthQuoteAcquisitionToolDelegate implements GrowthAcquisitionToolDelegate` over exactly the seven frozen Quote tool names, plus its internal focused `GrowthAdvisorQuoteToolExecutor.executeResolved(call:GrowthCommercialToolCall,context:ActiveWorkspaceContext):Promise<unknown>`. The delegate verifies the persisted/authenticated Copilot identity, resolves its concrete workspace only through the projected `GrowthAcquisitionWorkspaceResolver`, reloads current membership/capabilities, validates actor/session/team consistency, derives the closed `GrowthCommercialToolCall` and stable call hash, and only then calls `executeResolved`. All IDs are same-workspace and every write derives a child `CommandContext` from that trusted `context.actorId`, `call.stableCallHash`, and the canonical parsed input. Its `owns` cannot accept an Advisor/non-Growth name or be configured by callers. At this stage that child may be injected directly because it satisfies the generic seam; the Advisor task later supplies one Acquisition-owned composite over the Quote and Advisor children, rejects overlapping ownership at construction, and remains the single option value.
- Produces internal `GrowthQuoteToolResultEnvelope { kind:"growth_quote_authority_snapshot"; toolName; workspaceId; dataAsOf; temporalSequence; authorityRefs; internalSnapshot; modelSnapshotRef; promptSnapshotRef; toolSchemaVersion; stableCallHash }` and `GrowthQuoteToolReplayProjector.authorizeAndProjectCached(context:ActiveWorkspaceContext,envelope:GrowthQuoteToolResultEnvelope):Promise<unknown>`. The focused executor is the **only** result-ledger owner for those seven calls: one invocation of the existing generic `AcquisitionToolResultLedgerPort.executeOnce` stores/returns this internal envelope on each fresh/replay attempt, and it never stores a caller-ready quote response. Immediately outside that one call, the focused executor unconditionally calls the projector for both paths, so replay cannot bypass current authorization/projection. This does not change the C0 `GrowthCommercialToolPorts` registry shape.
- Changes: `ProductionAcquisitionAgentToolExecutorOptions.growthCommercialTools?: GrowthAcquisitionToolDelegate`. Production `execute(input)` first keeps its existing identity/abort validation, then—before `TOOL_NAMES` parsing and its generic `toolResults.executeOnce`/dispatch path—checks `growthCommercialTools?.owns(input.toolName)` and directly returns `growthCommercialTools.execute(input)` for an owned name. Therefore the generic outer ledger is never entered for any Growth child owned by the injected delegate/composite and cannot cache a caller projection around a focused executor; non-Growth calls retain the existing outer ledger/audit behavior unchanged. The Quote child receives the existing result/audit ledgers and records the equivalent tool audit around its sole envelope-ledger call rather than nesting through production dispatch.
- Extends shared test fixtures with `quoteToolExecutorFixture`, `quoteToolCall`, and `previewIdentityFixture`.

- [ ] **Step 1: Write failing allowlist and authority-boundary tests**

```ts
test("quote tools expose preview draft and approval-task actions but no approval/send action", () => {
  const names = GROWTH_QUOTE_TOOL_BLUEPRINTS.map((tool) => tool.name);
  assert.deepEqual(names, [
    "list_catalog_items", "get_pricing_policy", "preview_quote",
    "create_quote_draft", "list_pending_quote_approvals",
    "get_quote_decision", "create_quote_approval_task"
  ]);
  assert.equal(names.includes("approve_quote" as never), false);
  assert.equal(names.includes("send_quote" as never), false);
  assert.equal(names.includes("mark_deal_won" as never), false);
});

test("preview_quote carries the exact Case revision into its child command", async () => {
  const calls: string[] = [];
  const commands: CommandContext[] = [];
  const executor = quoteToolExecutorFixture({ calls, commands });
  const result = await executor.execute(quoteToolCall("preview_quote", {
    quoteCaseId: "case-1", quoteCaseRevision: 3,
    quoteInput: quoteInputFixture()
  }), workspaceContextFixture("sales"));
  assert.equal(result.previewIdentity.inputSnapshotHash.startsWith("sha256:"), true);
  assert.deepEqual(calls, ["quotes.preview"]);
  assert.equal(commands[0]?.expectedRevision, 3);
});

test("create_quote_draft uses server calculation and cannot submit or approve", async () => {
  const calls: string[] = [];
  const commands: CommandContext[] = [];
  const executor = quoteToolExecutorFixture({ calls, commands });
  const result = await executor.execute(
    quoteToolCall("create_quote_draft", {
      quoteCaseId: "case-1",
      quoteCaseRevision: 1,
      quoteInput: quoteInputFixture(),
      previewIdentity: previewIdentityFixture()
    }),
    workspaceContextFixture("sales")
  );
  assert.equal(result.status, "draft");
  assert.deepEqual(calls, ["quotes.createDraft"]);
  assert.equal(commands[0]?.expectedRevision, 1);
  assert.equal(commands[0]?.workspace.workspaceId, "team-a");
  assert.equal(calls.includes("quotes.approve"), false);
});

test("stable pending-approval call keeps its frozen as-of result after later approval and expiry", async () => {
  const state = quoteToolExecutorFixture({
    now: "2026-08-09T08:30:00.000Z",
    pending: [{ quoteVersionId: "formal-2", lifecycleRevision: 1,
      commercialAmountHash: `sha256:${"c".repeat(64)}` }]
  });
  const call = quoteToolCall("list_pending_quote_approvals", { limit: 100 });
  const first = await state.executor.execute(call, workspaceContextFixture("sales"));
  await state.applyLaterApprovalAndExpiry("formal-2", "2026-08-09T09:00:00.000Z");
  const replay = await state.executor.execute(call, workspaceContextFixture("sales"));
  assert.deepEqual(replay, first);
  assert.equal(first.dataAsOf, "2026-08-09T08:30:00.000Z");
  assert.equal(first.items[0]?.quoteVersionId, "formal-2");
  assert.deepEqual(state.approvalReaderCalls(), [{
    cutoff: state.firstSealedCutoff(), limit: 100
  }]);
  assert.equal(state.temporalBarrierSealCalls(), 1);
  assert.equal(state.approvalReaderCalls()[0]?.cutoff, state.firstSealedCutoff());
});

test("production bypasses the outer cache and projects the envelope on every replay", async () => {
  const state = quoteToolExecutorFixture({ includeSensitiveAmounts: true });
  const call = quoteToolCall("get_quote_decision", { quoteVersionId: "formal-2" });
  state.setCapabilities("manager-1", ["quote.draft.create", "pricing.sensitive.read"]);
  const first = await state.productionExecutor.execute(
    state.acquisitionInput(call, "manager-1")
  );
  assert.equal(first.estimatedGrossProfitMinor, 280_000);
  state.setCapabilities("manager-1", ["quote.draft.create"]);
  const redactedReplay = await state.productionExecutor.execute(
    state.acquisitionInput(call, "manager-1")
  );
  assert.equal("estimatedGrossProfitMinor" in redactedReplay, false);
  assert.equal(redactedReplay.quoteVersionId, first.quoteVersionId);
  assert.equal(redactedReplay.dataAsOf, first.dataAsOf);
  assert.equal(state.resultLedgerStoredValue().kind,
    "growth_quote_authority_snapshot");
  assert.equal(state.genericOuterResultLedgerCalls(), 0);
  assert.equal(state.growthEnvelopeLedgerCalls(), 2);
  assert.equal(state.growthEnvelopeRows(), 1);
  assert.equal(state.genericOuterCachedBodies(), 0);
  assert.equal(state.projectorCalls(), 2);
  assert.equal(state.temporalBarrierSealCalls(), 1);
  state.setCapabilities("manager-1", []);
  await assert.rejects(() => state.productionExecutor.execute(
    state.acquisitionInput(call, "manager-1")
  ),
    /capability_forbidden/);
  assert.equal(state.genericOuterResultLedgerCalls(), 0);
  assert.equal(state.growthEnvelopeLedgerCalls(), 3);
  assert.equal(state.projectorCalls(), 3);
});
```

Add tests for closed schemas/additional properties, required positive `quoteCaseRevision` on `preview_quote`, same-workspace IDs, stable call hash and idempotent replay, current capability loss on replay, sensitive catalog projection, Catalog private-object/service identity, first `preview_quote` using current Case revision and server Catalog effective-window validation, a matching stable-call replay after the Case revision and policy/package windows change returning the exact frozen evidence without a second Catalog resolve or historical precondition recheck, a new stable call with stale Case revision failing with zero evidence, same-key cross-Case conflict, `create_quote_approval_task` returning the newly appended formal submitted version/approval while leaving its source draft immutable, frozen model/prompt/tool schema/`dataAsOf` metadata, later approve/reject/expire events not changing an old stable-call result, sales-owner isolation through `PendingQuoteApprovalSnapshot.salesOwnerActorId`, manager workspace scope, model failure not affecting quote services, and absence of finance/document/send mutation tools. For each true read tool, spy on Foundation and the token-only reader: the tool request boundary seals exactly once, passes the identical opaque token, rejects a cross-workspace token, and a stable-call replay uses the result ledger without a second seal. The ledger stores authority references plus a full internal frozen snapshot, never a caller-ready sensitive response: replay with base read capability but without `pricing.sensitive.read` succeeds with profit/margin/cost fields redacted under the current context, while loss of the base tool/read capability rejects and exposes no cached payload.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/growth-advisor-quote-tools-test.ts src/acquisition-pi-tools-test.ts src/acquisition-tool-executor-test.ts src/acquisition-pi-agent-test.ts src/acquisition-model-content-test.ts`

Expected: FAIL because quote tool blueprints/executor and Growth tool-port injection are absent.

- [ ] **Step 3: Implement focused schemas and delegation**

```ts
export interface GrowthAdvisorQuoteServices {
  catalog: GrowthCatalogServices;
  temporalBarrier: Pick<GrowthTemporalBarrier, "sealReadCutoff">;
  quotes: {
    preview(context: CommandContext, caseId: string, input: QuotePreviewInput): Promise<QuoteCommandExecution<QuotePreviewResult>>;
    createDraft(context: CommandContext, caseId: string, input: CreateQuoteVersionInput): Promise<QuoteCommandExecution<QuoteVersionProjection>>;
    submitDraft(context: CommandContext, draftVersionId: string): Promise<QuoteCommandExecution<{
      sourceDraftVersion: QuoteVersion; submittedVersion: QuoteVersion; approval: QuoteApproval;
    }>>;
    quoteApprovals: QuoteApprovalAsOfReader;
    quoteVersions: QuoteVersionEvidenceReader;
  };
}

export function registerGrowthAdvisorQuoteTools(
  toolPorts: GrowthCommercialToolPorts,
  services: GrowthAdvisorQuoteServices
): void;
```

`registerGrowthAdvisorQuoteTools` is called by `createGrowthQuoteModule.install` and registers each of the seven exact names once on the singleton registry; each handler closes over the module's singleton services, the reference-equal final Catalog composite, and the exact Foundation temporal barrier. Append matching blueprints to the existing exact Pi allowlist. Write-tool schemas carry only their relevant aggregate revision (`quoteCaseRevision` for both `preview_quote` and `create_quote_draft`, source-draft `quoteVersionRevision` for `create_quote_approval_task`). `preview_quote` is a Foundation-idempotent evidence-writing command: the executor parses and removes `quoteCaseRevision`, builds a child `CommandContext` with that exact `expectedRevision` plus request/idempotency identity derived from `stableCallHash`, then the handler calls `quotes.preview(childCommand,caseId,input)` and unwraps `.value`; Pi never serializes the service's `.replayed` flag because its focused result ledger owns tool replay metadata separately. First execution locks and checks the Case revision. A matching stable call reauthorizes current Case access/capability by evidence ID and returns that frozen calculation even if the Case revision or Catalog window later changes; capability loss fails instead of replaying cached output, and only a new command applies a new current precondition. The production-facing delegate accepts exactly one `AcquisitionToolExecutionInput`, resolves its trusted current context as specified above, strictly parses each revision where present, derives a closed `GrowthCommercialToolCall`, and invokes `executeResolved`; the focused executor removes the revision from the domain payload, constructs one child `CommandContext` whose `expectedRevision` is exactly that value, and calls `toolPorts.execute(call, childCommand)`. `create_quote_draft` and `create_quote_approval_task` likewise unwrap only `.value`; the latter invokes `submitDraft` and returns the distinct formal version/approval IDs, never approving. Each true read handler uses one server `effectiveAsOf=this.now()`, calls `services.temporalBarrier.sealReadCutoff(context,effectiveAsOf)` exactly once at the tool request boundary, and passes the returned token object unchanged. `list_pending_quote_approvals` calls only `quoteApprovals.listPendingAsOf(context,{cutoff,limit})`; `get_quote_decision` calls only `quoteVersions.getAt(context,versionId,cutoff)` and returns the frozen lifecycle revision/status/hash evidence. Include `dataAsOf=cutoff.effectiveAsOf`, `cutoff.temporalSequence`, exact lifecycle/approval revisions, commercial hash, model/prompt/tool-schema refs, stable call hash, authority IDs and the full internal frozen snapshot in `GrowthQuoteToolResultEnvelope`; do not store a previously projected response as replay authority. In `ProductionAcquisitionAgentToolExecutor.execute(input)`, keep the existing identity/abort checks, then perform the generic `growthCommercialTools.owns(input.toolName)` branch **before** `TOOL_NAMES`, payload parsing and the pre-existing generic `toolResults.executeOnce`; the Quote-stage child owns exactly seven names and the later composite owns the closed union of twelve. An owned call delegates directly with the same input and never enters that outer ledger or its dispatch callback. Inside the focused executor—and nowhere else for that call—invoke `resultLedger.executeOnce<GrowthQuoteToolResultEnvelope>(...)` exactly once, emit the existing audit from the frozen envelope/authority refs, then unconditionally call `replayProjector.authorizeAndProjectCached(currentContext,envelope)` after the ledger returns, whether the envelope was just produced or replayed. The projector re-requires current base capability, revalidates current resource/owner access against the stored authority refs, and applies the normal capability-aware projection; it performs no seal and no current-only selection query. Thus removal of `pricing.sensitive.read` redacts cost/profit/margin while preserving the same frozen `dataAsOf` and selected IDs; removal of the base tool/read capability rejects rather than returning any cached payload. Tests spy that an owned fresh/replay call performs zero generic-outer ledger calls, one focused-ledger invocation per attempt, one stored envelope total, no stored projected body, and one projector call per attempt; forged/missing Copilot actor/session/workspace binding fails before either ledger, while a non-Growth call still traverses the original generic ledger once. Other read tools construct a child command with `expectedRevision:null`. Never pass `ActiveWorkspaceContext` to the C0 `execute` port and never accept a second revision in a service input. Reuse the existing result ledger and audit schema; do not register a separate Agent runtime.

- [ ] **Step 4: Wire one runtime instance in the mandated startup order**

`createGrowthCommercialApplication` returns `{ handler, toolPorts, integrations, close }`. Its final projection requires `GROWTH_QUOTE_ACQUISITION_INTEGRATIONS` and copies the exact required `probabilityAssessments` and `quoteProjectedDocumentAuthority` references atomically; it never fetches either from `GROWTH_QUOTE_AUTHORITY_READERS` or leaves one optional. In `server.ts`: create the production composition and Growth runtime, install `GrowthCommercialRuntimeBridge`, then call `createAcquisitionApplication` with the exact probability writer, `growthRuntime.toolPorts`, `growthRuntime.integrations.acquisitionWorkspace`, and `growthRuntime.integrations.temporalBarrier`, while the existing PI guard receives the exact projected document validator, before installing Acquisition runtime. On projection/application failure and shutdown, close Acquisition first when created, Growth second, store last; a projection failure therefore invokes the already-owned Quote close and removes its sweeper timer. `server.ts` only coordinates references. `createAcquisitionApplication` constructs one `GrowthQuoteAcquisitionToolDelegate` child from those exact projected ports plus its existing authenticated Copilot actor/session membership authority, and that child constructs one focused `GrowthAdvisorQuoteToolExecutor`; during the Quote stage it is the generic production option value. The later Advisor task composes that same child with its five-name child into one `GrowthAcquisitionToolDelegate` and injects only the composite. Neither child/composite creates Catalog, Quote, assessment, document validation, publication, workspace, capability, or temporal authorities, and both receive the same existing result/audit ledger instances without adding a Production outer cache.

- [ ] **Step 5: Verify GREEN**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/growth-advisor-quote-tools-test.ts src/acquisition-pi-tools-test.ts src/acquisition-tool-executor-test.ts src/acquisition-pi-agent-test.ts src/acquisition-model-content-test.ts && npm run test:agent:pi && npm run build`

Expected: quote tools, all Pi suites, snapshot tests, and build PASS; no authority-changing tool exists.

- [ ] **Step 6: Commit**

```bash
git add backend/src/growth-advisor-quote-tools.ts backend/src/growth-advisor-quote-tools-test.ts backend/src/acquisition-pi-tools.ts backend/src/acquisition-pi-tools-test.ts backend/src/acquisition-tool-executor.ts backend/src/acquisition-tool-executor-test.ts backend/src/acquisition-pi-agent.ts backend/src/acquisition-pi-agent-test.ts backend/src/acquisition-model-content.ts backend/src/acquisition-model-content-test.ts backend/src/acquisition-application.ts backend/src/growth-quote-module.ts
git commit -m "feat: add controlled quote advisor tools"
```

### Task 10: Stage 2 vertical integration and failure-injection gate

**Files:**
- Create: `backend/src/growth-quote-vertical-integration-test.ts`
- Create: `backend/src/growth-quote-mysql-test-support.ts`
- Create: `backend/src/growth-quote-mysql-integration-test.ts`
- Modify: `backend/src/acquisition-deal-closed-loop-integration-test.ts`
- Modify: `backend/src/growth-quote-module.ts`
- Modify: `backend/src/acquisition-application-test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes every Stage 0-2 production interface and the real memory/MySQL runtime composition.
- Proves: one Douyin candidate → trusted CRM binding → QuoteCase → preview → version → human approval → PI → authoritative quote DealEvent → Reconciler quoted Outcome.
- Proves: legacy bypasses remain closed, AI never decides authority, and each failure injection recovers without duplicate PI/Event/Outcome.
- Produces no new domain abstraction; this task is the release gate.
- Test-only `growthQuoteIntegrationFixture` is defined in `growth-quote-vertical-integration-test.ts` and implements the typed harness methods used below.

- [ ] **Step 1: Write the failing complete tracer-bullet test**

```ts
test("Douyin candidate reaches one approved quote PI CRM event and Outcome", async () => {
  const app = await growthQuoteIntegrationFixture({ mode: "memory" });
  const candidate = await app.createVerifiedDouyinCandidate();
  const binding = await app.convertCandidateToTrustedDeal(candidate.id);
  const quoteCase = await app.quotes.createCase({
    candidateId: candidate.id,
    customerId: binding.customerId,
    dealId: binding.dealId,
    assignedTo: "sales-1"
  });
  const preview = await app.quotes.preview(quoteCase.id, quoteInputFixture());
  const version = await app.quotes.createVersion(
    quoteCase.id, preview.previewIdentity, quoteInputFixture()
  );
  const submission = await app.quotes.submit(version.id, "sales-1");
  const formal = submission.submittedVersion;
  assert.notEqual(formal.id, version.id);
  assert.equal((await app.quotes.getVersion(version.id)).probabilityAssessmentSnapshot, null);
  const approved = await app.quotes.approve(formal.id, "manager-1");
  await app.publication.drain(approved.publicationOperation.id);
  await app.reconciler.run();
  assert.equal(app.piDocumentsFor(formal.id).length, 1);
  assert.equal(app.dealEventsFor(formal.id, "quote").length, 1);
  assert.equal(app.outcomesFor(formal.id, "quoted").length, 1);
  assert.equal(app.authority(binding.dealId)?.quoteVersionId, formal.id);
  await app.close();
});
```

Add scenarios injecting failure after approval, after PI, after CRM event, and before Reconciler checkpoint; replay must yield one of each artifact. Add legacy Deal PATCH/stage/event/lost and arbitrary/`legacy_unverified` PI bypass assertions, valid `quote_projection` human submit/approve/send/export, commercial PI revision refusal, client total/hash tampering, AI approval/document-action attempt absence, draft-versus-formal ID authority, won/lost cancellation race, pre-quote disqualification, multiple lifecycle/publication appends at the same server tick advancing persisted workspace `recordedAt/temporalSequence` on every allocator call, legacy equal-time revision decoding, two Cases per Deal, same request idempotency, changed request conflict, package expiry between preview/draft and formal submission, and one mandatory MySQL-backed tracer bullet using `MYSQL_TEST_ADMIN_URL`.

- [ ] **Step 2: Run the tracer bullet to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/growth-quote-vertical-integration-test.ts`

Expected: FAIL on the first incomplete integration seam, with a named assertion identifying the missing artifact or duplicate.

- [ ] **Step 3: Add only the minimum composition fixes required by the tracer bullet**

Use the existing `growth-commercial-composition`, `createGrowthCommercialApplication`, and `createAcquisitionApplication` options to share store, binding directory, projected assessment port, tool ports, Workers, and Reconciler. Keep all domain logic in the Quote module services created by Tasks 1-9; this integration task may adjust typed dependency injection and shutdown wiring but cannot duplicate calculations, authority validation, or publication logic.

- [ ] **Step 4: Run all Stage 0-2 gates**

Implement `withGrowthQuoteMysqlTestDatabase` over `MYSQL_TEST_ADMIN_URL`: create isolated `goodjob_growth_quote_<pid>_<random>`, install Foundation temporal-barrier/Catalog/Quote plus legacy Deal/PI schemas, use at least two physical connections, and always drop the database in `finally`. Missing configuration throws `MYSQL_TEST_ADMIN_URL_REQUIRED:growth-quotes`; there is no skip or `TEST_MYSQL_URL` fallback. `growth-quote-mysql-integration-test.ts` runs the real bind/submit/approval/publication races, verifies strict live-lease predicates and the formal-version tracer bullet, and round-trips one won/lost event's complete formal CommercialBindingSnapshot plus exact seven-field evidence projection. After mutating/rebinding live Handoff/Customer/Deal rows, the same sealed decision reader must still return the original candidate/customer/deal/hashes; corrupt snapshot/evidence JSON fails closed. The suite also includes a two-connection unstable-cutoff case: connection A's request boundary seals one opaque cutoff T for a workspace with no prior preview/lifecycle stream while connection B's DB clock is behind T; B must lock the same barrier after A and allocate `recordedAt>T`, and the internal reader must remain unchanged when called again with the identical T token without another seal. It asserts every Quote transaction lock trace begins `workspace_temporal_barrier` before Deal/Case/publication/domain rows, successive multi-row appends advance `temporalSequence`, token/context workspace mismatches fail closed, and the boundary/reader spies observe one seal plus identical token object. It then prints `MYSQL_INTEGRATION_EXECUTED:growth-quotes:<database>` only after all assertions pass.

Add this stable suite only now that every referenced test file exists:

```json
{
  "scripts": {
    "test:growth-quotes": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/quote-calculation-service-test.ts src/probability-assessment-test.ts src/probability-assessment-mysql-repository-test.ts src/growth-quote-module-test.ts src/quote-repository-test.ts src/quote-mysql-repository-test.ts src/commercial-binding-snapshot-test.ts src/growth-workspace-member-assignability-test.ts src/quote-case-service-test.ts src/quote-version-service-test.ts src/quote-approval-service-test.ts src/authoritative-quote-reader-test.ts src/quote-preview-evidence-reader-test.ts src/quote-publication-worker-test.ts src/quote-publication-recovery-sweeper-test.ts src/quote-crm-command-test.ts src/quote-projected-document-authority-test.ts src/deal-commercial-decision-service-test.ts src/quote-router-test.ts src/quote-runtime-response-conformance-test.ts src/growth-advisor-quote-tools-test.ts src/growth-quote-vertical-integration-test.ts src/growth-quote-mysql-integration-test.ts"
  }
}
```

Run:

```bash
npm run test:growth-foundation --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-catalog --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-quotes --workspace backend
npm run test:growth-openapi --workspace backend
npm run test:agent:pi --workspace backend
npm run test:acquisition --workspace backend
npm run test:security --workspace backend
npm run check:growth-contracts
npm run build --workspace backend
git diff --check
```

Expected: every command exits 0; the frozen contract and runtime responses agree, all authority/fencing/concurrency tests pass, the tracer bullet contains one PI, one DealEvent, and one Outcome for the formal submitted version, and stdout contains `MYSQL_INTEGRATION_EXECUTED:growth-quotes:`. A missing `MYSQL_TEST_ADMIN_URL` is a hard failure, never a skipped release gate.

- [ ] **Step 5: Commit**

```bash
git add backend/src/growth-quote-vertical-integration-test.ts backend/src/growth-quote-mysql-test-support.ts backend/src/growth-quote-mysql-integration-test.ts backend/src/acquisition-deal-closed-loop-integration-test.ts backend/src/growth-quote-module.ts backend/src/acquisition-application-test.ts backend/package.json
git commit -m "test: prove authoritative quote publication loop"
```
