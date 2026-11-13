# Task 10 — Stage 2 vertical integration and failure-injection gate

## Status

Implemented the production-composition memory tracer and the fail-closed MySQL
release-gate entry point. The tracer uses the real Growth commercial
composition, Quote services, publication worker, Acquisition application and
Outcome reconciler. It proves the formal submitted version is the sole
financial/document authority and that replay after external-success/receipt or
checkpoint failures does not duplicate the PI, DealEvent, or Outcome.

The live MySQL gate was not run because `MYSQL_TEST_ADMIN_URL` is absent. This
is intentionally a hard release-gate failure, not a skip or memory fallback.

## RED -> GREEN evidence

1. RED: the production Quote private service registry did not expose the
   application-owned publication executor; the tracer observed `undefined`.
   GREEN: one `QuotePublicationWorker` is now constructed by the production
   Quote module and shared by the bounded release-gate seam and recovery
   sweeper.
2. RED: the production Acquisition runtime did not expose a bounded drain for
   its already-owned Outcome reconciler. GREEN: `runOutcomeReconciliation`
   delegates to the exact singleton `runTenant`; it creates neither another
   reconciler nor another timer.
3. RED: a real approval returned an approved projection, but a worker reread
   the in-memory repository as `submitted` and cancelled publication with
   `publication_version_not_approved`. GREEN: the approved projected version
   is atomically persisted in the same transaction map. Repository transaction
   snapshot/restore continues to roll it back on failure.
4. RED: a version produced by the real calculation service did not persist its
   frozen `lineSnapshot`, so publication could not project it. GREEN: version
   creation stores a structured clone of the calculation result's frozen
   snapshot; publication never recomputes from current Catalog state.

The two repository fixes above and the Acquisition bounded drain are the
explicitly approved minimal gate-required scope exceptions.

## Covered behavior

- Verified Douyin evidence/candidate -> Qualification v2 -> probability
  assessment (4321 BPS) -> trusted CRM handoff/customer/deal.
- Real Catalog item/policy -> QuoteCase -> Pi `preview_quote` on the same
  application singleton -> draft -> distinct formal submission -> human
  approval -> publication -> authoritative quote DealEvent -> quoted Outcome.
- Draft/formal IDs remain distinct; the draft has no probability snapshot and
  receives no PI, while the formal version receives the frozen probability and
  is the Deal authority.
- Publication recovery is injected after external PI success and after
  external CRM success. Stable receipts and fencing yield exactly one PI, one
  quote DealEvent and one quoted Outcome.
- Reconciliation is injected after the Outcome append and before checkpoint;
  transactional rollback/retry yields exactly one Outcome.
- Production module ownership and shutdown are exercised; application and
  Growth close paths complete in the focused tracer with no test-process leak.
- Existing Acquisition closed-loop coverage remains the gate for legacy quote
  event and won/lost stage bypass rejection.

## Frozen contract 1.0.2 decision

The frozen Growth 1.0.2 manifest is
`sha256:4b324daa8d100579658f8982553bf2b1b35bba58b4d5f0dd41f49d723b598e0f`.
Its publication GET response does not publish an `ETag`, while retry requires
`If-Match`. No header was invented and no frozen contract was edited. Internal
Pi/retry paths continue to derive the authority revision from persisted
authority/fencing (the Task 9 approach). The public HTTP discoverability gap is
recorded below as a remaining contract concern.

## Verification

- `growth-quote-vertical-integration-test.ts`: 4/4 pass.
- Quote non-live suite: 80 pass, 0 fail, 2 pre-existing live tests skipped.
- `test:growth-foundation`: 82/82 pass.
- Catalog non-live suite: 116/116 pass.
- `test:growth-openapi`: 38/38 pass.
- `check:growth-contracts`: 38/38 pass plus frozen-release check.
- `test:agent:pi`: pass (all five Pi groups).
- `acquisition-deal-closed-loop-integration-test.ts`: 1/1 pass; legacy
  commercial quote/stage bypass remains rejected.
- `test:security`: pass (`ok: true`).
- `npm run build --workspace backend`: pass.
- `git diff --check`: pass.
- `env -u MYSQL_TEST_ADMIN_URL npm run test:growth-quotes --workspace backend`:
  expected fail-closed result with 80 pass and the required
  `MYSQL_TEST_ADMIN_URL_REQUIRED:growth-quotes` failure; no live marker emitted.
- `test:acquisition`: its first 25 application tests passed, then the child
  process retained an open handle without advancing; the command was stopped
  after roughly two minutes and is not claimed as a passing gate. Focused
  Acquisition composition and the production vertical tracer pass.

## Concerns

1. The mandatory real-MySQL tracer/race/snapshot assertions remain unexecuted
   until CI supplies `MYSQL_TEST_ADMIN_URL`; this local result cannot certify
   live MySQL behavior or emit `MYSQL_INTEGRATION_EXECUTED:growth-quotes:`.
2. The initial MySQL gate installs isolated schemas and proves two physical
   connections plus the shared temporal allocator, but the complete live
   bind/approval/publication, lease-race, sealed-decision round-trip and corrupt
   JSON matrix still needs expansion and execution in the configured live gate.
3. Frozen 1.0.2 does not expose a publication GET `ETag`; external HTTP clients
   cannot discover the retry `If-Match` value from that response. Internal
   authority-revision retry remains the only conformant path.
4. The full Acquisition gate has a pre-existing/open-handle shutdown problem
   after its application test file; it must be diagnosed separately before the
   aggregate command can be counted green.
