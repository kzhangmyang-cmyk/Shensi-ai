# Task 4 report

Status: implemented and verified.

## RED evidence

The focused Task 4 command was run before production implementation. It failed
with `ERR_MODULE_NOT_FOUND` for `quote-version-service.js`, while the existing
repository tests remained green. This was the expected missing-feature failure.

## Implementation

- Added closed Quote preview/create inputs, deterministic server recalculation,
  immutable private preview evidence, and Foundation HTTP idempotency replay.
- Added Case-revision CAS draft creation with stable domain probes and immutable
  draft versions.
- Added formal submission as a distinct immutable version, with current
  ProbabilityAssessment.v2 validation, current commercial binding verification,
  fresh Catalog coverage/recalculation, lifecycle append, and pending approval.
- Added in-memory and MySQL repository mirrors. Both allocate the workspace
  temporal barrier before Case/version streams; MySQL adds unique stable-command,
  Case-version, and source-draft/formal constraints.
- Added Quote module service composition and HTTP adapters using the Foundation
  command-context factory, ID-scoped strong ETags, and `Idempotency-Replayed`.

## Verification

- Quote memory/fake/focused suite: 38 passed, 1 skipped.
- MySQL live contention: skipped fail-closed because `MYSQL_TEST_ADMIN_URL` is
  absent; no database was configured.
- Backend TypeScript build: passed.
- Contract suite: 58 passed.
- Frozen Growth release check: passed.
- Growth OpenAPI/runtime suite: 34 passed.
- Security suite: passed (`ok: true`).

## Concerns

- The live MySQL contention path remains unrun until a caller supplies
  `MYSQL_TEST_ADMIN_URL`; the schema/fake gate and TypeScript build are green.
