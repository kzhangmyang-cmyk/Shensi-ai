# Task 3 report — Trusted CommercialBinding and QuoteCase lifecycle

## Outcome

- Added memory and MySQL Quote repositories for the approved Quote streams:
  Cases, immutable binding snapshots, draft/formal version storage, line/gift/
  package snapshots, lifecycle and Deal-authority events, approvals, publication
  operations, and domain command receipts.
- Every Quote mutation acquires the shared Foundation temporal barrier before
  Quote domain locks. Memory mutations hold a post-barrier workspace gate through
  runner completion and restore all Quote state on commit failure; MySQL mutations
  keep the caller connection, Deal guard, Case locks, and barrier through commit.
- Added canonical `commercial-binding.v1` hashing. The frozen acquisition chain
  includes candidate version and trusted handoff/Lead attribution; Deal hashes
  include identity/customer/owner/workspace authority and exclude amount/currency.
- Added current-authority verification, one-time Deal binding, one-open-Case-per-
  Deal guards, current ProbabilityAssessment.v2 binding, revision CAS, same-Deal
  replay, rebind rejection, and close/cancel rules with draft expiration.
- Added Foundation HTTP idempotency wrappers returning sibling `{ value,
  replayed }` metadata. Assignment is checked after reservation and before Quote
  business locks against the server user directory; denied assignments release
  the reservation and write no Quote rows.
- Production composition now installs Foundation → Catalog → Quote and injects
  read-only trusted member/CRM adapters. Candidate lookup is an explicit server
  repository adapter and fails closed when absent; no caller tenant/owner value
  substitutes for the trusted workspace context.

## TDD evidence

- Initial RED: the prescribed focused command failed only on missing
  `commercial-binding-snapshot`, `quote-mysql-repository`, and `quoteCaseFixture`
  exports (`ERR_MODULE_NOT_FOUND` / missing export).
- Initial GREEN: binding, assignment, Case lifecycle, repository concurrency,
  MySQL schema, module, composition, and build passed.
- Rollback RED: a runner failure after business work left one Case instead of zero
  (`1 !== 0`).
- Rollback GREEN: the same test now proves Case, lifecycle, and completed command
  receipt all remain zero after the failed transaction.

## Verification

- Focused Quote/module/composition suite: passed; live MySQL contention is one
  explicit skip because no admin URL is configured.
- TypeScript backend build: passed.
- Growth Foundation fake/memory suite: 82 passed, 0 failed.
- Growth Catalog fake/memory suite: 116 passed, 0 failed.
- ProbabilityAssessment.v2/Quote module regression: 13 passed, 0 failed,
  1 live-MySQL skip.
- Contract repository: 58 passed, 0 failed.
- Frozen Growth release check: passed.
- Growth OpenAPI/runtime suite: 34 passed, 0 failed.
- Security suite: passed (`ok: true`).
- `git diff --check`: passed.

## Live gate

`MYSQL_TEST_ADMIN_URL` is absent. No database was installed, configured, or
started. The two-physical-connection Quote contention test is present and remains
explicitly fail-closed/unrun until that admin URL is supplied.
