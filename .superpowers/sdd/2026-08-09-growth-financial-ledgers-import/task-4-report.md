# Finance Task 4 implementation report

Date: 2026-08-11

## Status

DONE

Commit message: `feat: project request evidence into cost ledgers`

## Delivered scope

- Added append-only acquisition-cost estimate draft, activate, supersede, and
  current-authorized idempotent replay services. Draft identity, version,
  source version, revision, actor, and temporal stamps are server-owned.
- Every draft/lifecycle transaction enters Foundation's exact workspace
  temporal barrier first. Replacements append supersede and activate events on
  successive persisted ticks and CAS only the operational head.
- Added deterministic provider-accounting evidence keyset reads, preserving
  decimal strings and freezing request/result hashes, evidence sequence,
  ledger version, and estimation-method version.
- Provider-reported evidence uses the existing pending-cost service;
  unknown/estimated evidence creates and activates an estimate. Both derive
  `provider-request:<evidenceId>` internally and use Foundation idempotency.
- Added the MySQL `(workspace_id, source_kind, source_id)` projection identity
  with immutable fingerprint, target, and source version conflict checks.
- Added token-only estimate history reads plus the capability-gated public
  as-of boundary. The boundary seals once and forwards the exact Foundation
  token; the sealed reader never authorizes or reseals.

## RED/GREEN evidence

- Initial exact focused RED: `ERR_MODULE_NOT_FOUND` for the provider evidence
  projector.
- Historical reader RED: `ERR_MODULE_NOT_FOUND` for the estimate as-of reader.
- Focused final GREEN: 11/11. Coverage includes source classification,
  fixed-point overflow, repeat projection, three successive immutable
  versions, concurrent activation single winner, current authorization on
  replay, exact token forwarding, forged-token rejection, and old-cutoff
  stability.

## Final non-live verification

- Task 4 focused suite: PASS, 11/11.
- Task 2 memory regression: PASS, 15/15.
- Task 3 fake-MySQL/schema regression: PASS, 5/5.
- `npm run test:growth-foundation`: PASS, 82/82.
- `npm run test:growth-openapi`: PASS, 38/38.
- `npm run test:contract-drift`: PASS, 16/16.
- `npm run test:security`: PASS (`"ok": true`).
- `npm run check:growth-contract-release`: PASS.
- `npm run build` in `backend`: PASS.
- `git diff --check`: PASS.

## Live MySQL gate

`MYSQL_TEST_ADMIN_URL` is absent. The explicit live suite was invoked and
failed closed with `MYSQL_TEST_ADMIN_URL_REQUIRED:growth-finance`; its three
live tests remain unrun. No database was configured or substituted.

## Self-review

- Production/test changes are limited to the eight brief-listed files; this
  report is the only additional task artifact.
- Estimate rows and lifecycle rows are insert-only. Historical reduction uses
  immutable prefixes and excludes later temporal sequences even if timestamps
  are adversarial.
- Money conversion consumes original decimal text and uses the shared BigInt
  implementation before any write. MySQL BIGINT parsing remains safe-integer
  fail-closed.
- Provider source identity and all revisions are derived server-side. A
  provenance flip between estimate and actual for the same evidence identity
  fails closed rather than double-counting.
- Foundation services, Task 2 repositories, and the existing cost service are
  reused directly; no second temporal or Finance service graph was added.

## Concerns

No code or contract blocker. Real MySQL concurrency remains an explicitly
unrun external gate because the required administrator URL was not supplied.
