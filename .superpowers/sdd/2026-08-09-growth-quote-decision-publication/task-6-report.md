# Task 6 report

Status: implemented and verified.

## RED evidence

The exact Task 6 focused command was run before production implementation.
All four new test entry points failed with `ERR_MODULE_NOT_FOUND` for the
missing command, worker, recovery sweeper, and projected-document authority
modules.

## Implementation

- Added barrier-first publication claims with owner, monotonically increasing
  fencing token, live lease expiry, authority revision, immutable temporal
  history, heartbeat renewal, fenced PI/CRM receipts, finish/fail/cancel,
  recoverable scanning, and capability-protected human retry in memory and
  MySQL repositories.
- Added stable PI and DealEvent projection commands. They preserve one
  `quote_projection` PI and one authoritative quote event per publication key,
  freeze the approved QuoteVersion's commercial fields, supersede older PI
  projections, update Deal commercial fields atomically, and keep MySQL's
  in-memory cache aligned so legacy persistence cannot erase the projection.
- Added a recoverable worker and idempotent sweeper. The worker rechecks current
  Deal authority and its live claim around every side effect and receipt,
  resumes partial operations from stable external IDs, and never calls Outcome
  directly. The sweeper owns one immediate scan, one interval, and waits for
  active jobs during idempotent close.
- Added the Foundation-owned projected-document validator without redeclaring
  its seam. It requires an exact formal approved QuoteVersion, authority event,
  frozen amount/currency/line/package/hash, action-specific capability,
  document revision, and current authority for submit/approve/send; legacy and
  fabricated PI documents fail closed.
- Added the frozen `GROWTH_QUOTE_ACQUISITION_INTEGRATIONS` private service and
  exact reference projection into Acquisition. Quote constructs and starts the
  sweeper only after its services/routes/private integration are ready, and
  its existing close handle stops the timer and waits for jobs. The existing
  server bridge already passed only the projected-document validator into the
  legacy human PI guard, so no new server mutation was required.

## Verification

- Focused Task 6 plus repository/module/legacy authority suite: 27 passed,
  0 failed, 1 skipped.
- MySQL live contention: skipped fail-closed because `MYSQL_TEST_ADMIN_URL` is
  absent; no database was configured.
- Backend TypeScript build: passed.
- Growth OpenAPI/runtime suite: 36 passed.
- Acquisition contract drift suite: 16 passed.
- Security suite: passed (`ok: true`).
- Diff whitespace check: passed.

## Concerns

- Live MySQL claim/renew/record/finish/fail contention and crash-recovery paths
  remain unrun until `MYSQL_TEST_ADMIN_URL` is supplied. Schema/fake coverage,
  focused memory coverage, contract suites, security, and TypeScript build are
  green.
