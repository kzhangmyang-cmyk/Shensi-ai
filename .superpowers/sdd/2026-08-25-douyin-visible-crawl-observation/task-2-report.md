# Task 2 report: fenced Node activity persistence and private gateway

## Scope delivered

- Added the private `AcquisitionCrawlerActivity` snapshot to crawler jobs and
  the sanitized crawler-status producer. New jobs use the deterministic safe
  default: `queued`, no keyword, `headless`, sequence `0`.
- Added fenced `updateActivity(fence, { activity, now })` to Memory and MySQL
  repositories. It rejects malformed activity and non-frozen keywords, rejects
  lower sequences, treats an exact same-sequence replay as an idempotent
  no-op, and rejects a same-sequence conflicting snapshot.
- MySQL hydrates old JSON payloads with the safe default and stores the new
  snapshot in the existing `payload_json`; no schema change or migration was
  added.
- The private gateway strictly validates the nested snake_case sidecar
  activity object and maps it to camelCase. Unknown/private activity keys are
  rejected.
- The crawler worker saves activity after validating the start response and
  after every validated poll response, before terminal/page-limit handling.
  The zero-page worker test proves this does not depend on records arriving.

## TDD evidence

### RED

Command run before production edits:

```bash
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-mediacrawler-gateway-test.ts \
  src/acquisition-crawler-worker-test.ts \
  src/acquisition-crawler-job-test.ts \
  src/acquisition-crawler-job-mysql-repository-test.ts
```

It exited `1` as expected. The new behavior tests failed because activity was
missing: Memory raised `repository.updateActivity is not a function`; MySQL
and worker assertions observed `undefined` activity. The sandbox also denied
the existing fake loopback HTTP server with `listen EPERM`; that prevented the
gateway fixtures from running but did not contact any external host.

### GREEN

The identical focused command was re-run with approval for the local fake HTTP
listener. Result: `51` tests total, `50` passed, `0` failed, `1` skipped. The
skip is the existing live-MySQL test, which correctly requires
`MYSQL_TEST_ADMIN_URL` and does not provision a database implicitly.

The backend TypeScript check also passed:

```bash
pnpm --filter ./backend exec tsc --noEmit
```

## Changed files

- `backend/src/acquisition-crawler-job.ts`
- `backend/src/acquisition-crawler-job-repository.ts`
- `backend/src/acquisition-crawler-job-mysql-repository.ts`
- `backend/src/acquisition-mediacrawler-gateway.ts`
- `backend/src/acquisition-crawler-worker.ts`
- Focused tests in the corresponding four `*-test.ts` files.

## Self-review

- Activity contains only phase, frozen keyword/null, deployment mode, and a
  non-negative sequence; no account handle, browser data, or sidecar-private
  field enters Node persistence or the status projection.
- Both repository implementations use their existing transactional fenced
  mutation path, so stale writers cannot update activity.
- Same-sequence equal updates preserve `updatedAt`, allowing start/poll
  duplicate snapshots without converting a replay into a conflict.
- No browser was started and no Douyin host was contacted; gateway tests use a
  local fake server only.

## Concerns

- Live MySQL remains intentionally unexecuted without the explicitly supplied
  `MYSQL_TEST_ADMIN_URL`. The focused fake-MySQL test verifies JSON hydration
  and saved payload behavior without provisioning infrastructure.
- This task adds activity to the internal crawler-status producer as requested
  for the following task; its OpenAPI/UI exposure belongs to that follow-on
  work.

## Review fix round 1

### Added regression behavior

- A real-shaped first sidecar activity of `queued` / `null` / `visible` /
  sequence `0` now persists through the worker even when no result page exists.
- An internal persisted `activityObserved` sentinel distinguishes an
  unobserved conservative default from a real sidecar observation. The first
  valid snapshot, including equal `headless` sequence `0`, is saved and marks
  the sentinel; all later same-sequence changes remain conflicts.
- Exact replay comparison is field-based, so a reordered object with the same
  four activity values is a no-op. A higher sequence that changes none of the
  non-sequence activity fields is rejected.
- Legacy MySQL payloads are hydrated and saved through enqueue and crawl-claim
  paths, in addition to the existing read/locked paths.

### RED evidence

The focused command was run after adding only the new regression tests and
exited `1`: 5 failures, 46 passes, and the existing live-MySQL skip. It showed
the original defects directly: legacy enqueue/claim returned `undefined`
activity, an equal first seq-0 observation did not save the sentinel, reordered
keys raised `crawler_activity_sequence_conflict`, and the zero-page visible
worker remained at the conservative `headless` default.

### GREEN evidence

After the minimal sentinel, structural comparison, and hydration changes, the
same focused command passed: `52` tests total, `51` passed, `0` failed, and
the existing explicit-credential live-MySQL test was skipped. The backend
TypeScript check (`pnpm --filter ./backend exec tsc --noEmit`) and
`git diff --check` also passed.
