# Task 5 report

Status: implemented and verified.

## RED evidence

The exact focused Task 5 command was run before production implementation. The
new approval/authority/evidence tests failed because the Task 5 fixture and
services did not exist, while the pre-existing repository and MySQL schema
tests remained green.

## Implementation

- Added human approval with formal-only authority, self-decision prevention,
  current capability-registry/grant checks, ID-scoped revision preconditions,
  current binding and pricing/gate revalidation, and Foundation HTTP
  idempotency replay.
- Added one barrier-first transaction for approval lifecycle, prior authority
  supersession, Approval decision, Deal authority event/current pointer, and
  the stable `quote-publication:<dealId>:<versionId>:<authorityRevision>`
  outbox operation. Memory and MySQL implementations preserve the immutable
  formal version and store crash-replay results exactly once.
- Added token-only Deal authority, terminal decision, expected-contribution,
  pending-approval, QuoteVersion-evidence, and preview-evidence readers. They
  validate the opaque Foundation cutoff against the concrete workspace and
  reduce append-only history by revision at `recordedAt <= effectiveAsOf`.
- Frozen authority and evidence projections copy the formal version's amount,
  currency, probability assessment, owner, subject, CommercialBindingSnapshot,
  seven-field binding evidence, and hashes. Readers validate canonical binding
  integrity and never consult current CRM ownership or mutable latest pointers.
- Added the exact frozen six-port `GrowthQuoteAuthorityReaders` private
  composite to the existing Quote module service graph and mounted the released
  approval routes with scoped If-Match, ETag, and replay headers.

## Verification

- Focused Task 5 + repository + module suite: 13 passed, 0 failed, 1 skipped.
- MySQL live contention: skipped fail-closed because `MYSQL_TEST_ADMIN_URL` is
  absent; no database was configured.
- Backend TypeScript build: passed.
- Contract suite: 58 passed.
- Frozen Growth 1.0.1 release check: passed.
- Growth OpenAPI/runtime suite: 34 passed.
- Security suite: passed (`ok: true`).

## Concerns

- The live MySQL contention/approval path remains unrun until a caller provides
  `MYSQL_TEST_ADMIN_URL`; schema/fake coverage, focused tests, and TypeScript
  build are green.
