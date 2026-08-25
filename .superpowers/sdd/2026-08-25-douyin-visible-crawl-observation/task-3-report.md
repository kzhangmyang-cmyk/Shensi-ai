# Task 3 report — public crawl observation and dashboard

## Scope delivered

- Added the required, closed `activity` object to the acquisition crawler-status
  YAML contract and runtime OpenAPI mirror, then regenerated the frontend type.
- Added runtime and response-conformance coverage for the sanitized activity
  projection; it includes phase, current keyword, browser mode, and sequence
  without private browser state.
- Made the frontend reject malformed crawler activity, render the localized
  observation card, remove the completion percentage, and show a submitted
  queued/waiting placeholder before the first poll result.
- Disabled save-and-run while a crawler status is non-terminal and made the
  controller's direct `runNow()` path reject a duplicate launch as well.
- Updated `docs/API_INDEX.md` and `docs/modules/acquisition.md` for the new
  public contract and dashboard behavior.

## RED evidence

Tests were added before Task 3 production changes.

1. `pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 src/acquisition-crawler-job-router-test.ts src/acquisition-openapi-test.ts src/acquisition-openapi-response-conformance-test.ts`
   initially failed as intended: the response conformance test reported
   `additionalProperty: "activity"`, and the OpenAPI test reported that the
   required field was absent. The initial sandbox attempt also hit `EPERM` on
   test-only Express listeners; the same command was rerun with approved local
   listener permission and produced the two intended contract failures.
2. `pnpm --filter ./frontend test` initially failed as intended in
   `douyin-automation-view.self-test.ts`: the rendered text did not contain
   `可视窗口已打开`, proving the observation UI was missing. The initial sandbox
   attempt hit `EPERM` for tsx's temporary IPC socket; the approved local-IPC
   rerun produced the intended assertion failure.

## GREEN evidence

- `pnpm generate:frontend-contract-types` — passed; generated DTO was changed
  only by this generator.
- Focused backend command above — passed, 42 tests / 0 failures.
- `pnpm --filter ./frontend test` — passed, including the observation view,
  strict activity validator, and non-terminal direct-run guard (57 checks).
- `pnpm check:generated-acquisition-types` — passed.
- `pnpm --filter ./backend build` — passed.
- `pnpm --filter ./frontend build` — passed. Vite emitted its existing
  large-chunk warning only.
- `./scripts/context-check` — `SHENSI_CONTEXT_OK`.
- `pnpm test` — passed (contracts, backend, frontend, Baota package suite).
- `pnpm build` — passed.
- `git diff --check` — passed.

## Self-review

- The public DTO is closed at all three boundaries: canonical YAML, backend
  OpenAPI mirror, and frontend response validator.
- The UI consumes the generated `AcquisitionCrawlerStatus` alias; no parallel
  transport DTO was introduced.
- The observation card has no raw URL, account handle, browser profile, lease,
  cursor, or private browser identifier. It shows only localized allowed data.
- A non-terminal run disables the rendered action and makes direct controller
  invocation a no-op, while a newly submitted run has a non-fabricated waiting
  state until the first poll.

## Concerns

- No real browser, Douyin request, or live-provider operation was run.
- Test execution required approved local IPC/listener permissions because the
  sandbox disallows those test-only sockets; this did not require external
  network access.

## Fix round 1/5 — closed client status and outstanding first poll

### RED evidence

- Added behavior coverage before the implementation for malformed crawler
  status roots (extra `cursor`, invalid scalar values, a missing required
  field, and nested `activityObserved`), first-poll timeout retry/de-duplication,
  submitted waiting-state disablement, and polite/atomic status announcements.
- `pnpm --filter ./frontend test` failed as intended before the fix in
  `douyin-automation-view.self-test.ts` with `false !== true`: the rendered
  save-and-run control was still enabled when `runIntent` existed without a
  crawler status. That demonstrated the first-poll duplicate-launch gap.

### Fix and GREEN evidence

- `getCrawlerStatus` now requires the exact canonical root keyset and validates
  all required scalar, date-time, nullable, budget, state, and activity values.
  The activity validator rejects unknown nested keys and counts the keyword
  maximum in Unicode code points.
- A non-abort polling failure retains the submitted intent, schedules a status
  retry, and prevents both the rendered and direct launch paths from creating a
  second run. Retry refreshes the outstanding run instead of reloading away its
  intent.
- The live observation and queued placeholder are polite, atomic status
  announcements.
- `pnpm --filter ./frontend test` — passed (57 checks).
- Focused backend contract command — passed, 42 tests / 0 failures.
- `pnpm check:generated-acquisition-types`, backend build, frontend build, and
  `./scripts/context-check` — passed. The frontend build emitted only its
  existing large-chunk warning.
- `pnpm test`, `pnpm build`, and `git diff --check` — passed.

### Fix-round self-review

- The strict client validator rejects server-only root fields such as `cursor`
  and `activityObserved` before the value can reach controller or view state.
- Neither the retry path nor the timeout recovery introduces reload recovery,
  a latest-run endpoint, real-browser work, or any Douyin request.

## Fix round 2/5 — RFC3339 and one-run polling lifecycle

### RED evidence

- Added behavior coverage before implementation for RFC3339 Z/fraction/offset
  acceptance and date-only/impossible-date rejection; manual refresh racing a
  queued timer; and old terminal status followed by a new intent whose first
  poll fails.
- `pnpm --filter ./frontend test` failed as intended in the stale-status view
  regression: the UI rendered the old run's `采集完成` status instead of the
  new intent's `已提交采集，等待服务器返回首次观测状态` placeholder. The same
  test-first suite contains the date and deterministic scheduler regressions.

### Fix and GREEN evidence

- Replaced permissive `Date.parse` acceptance with bounded RFC3339 parsing:
  timezone is required, fractions are bounded, time/offset ranges are checked,
  and a normalized `Date` round-trip rejects impossible calendar dates.
- Poll scheduling now owns one generation/run-tagged pending timer and one
  active refresh flight. Manual refresh clears the pending timer, stale timer
  callbacks cannot clear a newer timer, and lifecycle reset invalidates the
  active flight.
- A new run intent clears prior status, candidates, and selection before its
  first refresh. Missing or run-ID-mismatched status is outstanding in both
  controller and view, which renders the queued placeholder and blocks another
  launch.
- `pnpm --filter ./frontend test` — passed (57 checks).
- Focused backend contract command — passed, 42 tests / 0 failures.
- `pnpm check:generated-acquisition-types`, backend/frontend builds, and
  `./scripts/context-check` — passed. The frontend build emitted only its
  existing large-chunk warning.
- `pnpm test`, `pnpm build`, and `git diff --check` — passed.

### Fix-round self-review

- No new endpoint, reload recovery, browser process, or external request was
  added. The single-flight guard is scoped to the current generation and run,
  so reset/close cannot let an older refresh mutate current state.
