# Final review fix B — Node terminal, restart, projection safety/readiness

Base: `1f71b97`

## Scope

Modify Node crawler domain/repositories/worker/gateway-adjacent tests, public
OpenAPI sources/tests, generated frontend DTO, and this fix report. Do not edit
the interactive frontend controller/view/API implementation in this fix. Never
run a real browser or contact Douyin.

## Required behavior

1. When the sidecar reports `paused`, persist its last safe activity, release
   the current fence through the existing retryable failure/requeue path, and
   return so a later claim calls `startCrawlJob` and resumes the paused sidecar
   job. It must not poll/renew forever.
2. Add terminal activity to `PersistCrawlerPageInput` and apply it inside the
   same Memory/MySQL fenced transaction as the final page, terminal state,
   ingestion-pending state and lease release. For terminal sidecar status, the
   worker must not persist activity separately first; it passes the validated
   completed activity with the final page. Failed/cancelled/paused statuses
   retain/update the last useful nonterminal activity before transitioning.
   Enforce a completed/null-keyword terminal activity.
3. MySQL hydration must validate an existing activity as a strict four-field
   `AcquisitionCrawlerActivity` and validate the internal observation sentinel.
   Missing legacy activity gets the safe default; invalid/extra-field activity
   fails closed. `crawlerStatus()` validates then projects the four activity
   fields explicitly, never `structuredClone` of an untrusted object.
4. Add required public `candidateProjectionState: pending | ready | failed` to
   `AcquisitionCrawlerStatus`, canonical/runtime OpenAPI and generated frontend
   types. Map `succeeded`/`partial` jobs to pending until terminal ingestion is
   succeeded, ready after it succeeds, failed after it exhausts retries. Map
   paused/cancelled/failed crawl states to ready because no later terminal
   projection is scheduled; scheduled/queued/running remain pending.
5. Keep the public status closed; never expose `activityObserved`, ingestion
   leases, raw ingestion state, or private fields.

## TDD and verification

- Tests first and witnessed RED for paused restart, terminal activity/page
  atomicity and rollback, Memory/MySQL parity, corrupt/extra legacy activity,
  explicit public projection, and projection readiness transitions including
  a legitimate zero-candidate terminal ingestion.
- Update all closed contract/router/conformance fixtures and regenerate types
  only through `pnpm generate:frontend-contract-types`.
- Run focused crawler suites, acquisition contract suites, TypeScript build,
  generated-type check and `git diff --check`.
- Write `final-fix-backend-report.md` beside this brief; force-add and commit
  only scoped files.
