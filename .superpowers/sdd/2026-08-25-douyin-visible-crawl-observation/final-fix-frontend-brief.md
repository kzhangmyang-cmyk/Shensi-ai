# Final review fix C — frontend projection polling and safe observation UI

Base: backend final-fix commit (record in the implementation report)

## Scope

Modify the strict Douyin automation response decoder, controller, view, their
self-tests, the local HTTP fixture, and this fix report. Do not start a real
browser, crawl, comment, or direct message. Do not change the server contract;
consume the generated contract from final fix B.

## Required behavior

1. Accept the required closed `candidateProjectionState` field with the exact
   enum `pending | ready | failed` in the strict crawler-status decoder. Missing,
   unknown, and extra fields remain malformed.
2. Continue polling when the crawl itself is nonterminal **or** candidate
   projection is `pending`. Stop on `ready` or `failed`. A terminal crawl with
   zero candidates and projection `ready` is a legitimate completed result.
   Block a duplicate run while an earlier terminal crawl is still projection
   `pending`.
3. Add a controller test for the terminal-before-ingestion race: a first
   `succeeded + pending` response with an empty candidate page schedules another
   poll; a later `succeeded + ready` response, including a legitimate empty
   candidate page, stops polling.
4. The response privacy guard inspects forbidden **field names** recursively,
   never arbitrary string values. A valid keyword/activity such as
   `cookie packaging` must pass, while forbidden keys such as `cookie`,
   `accountHandle`, `browserProfile`, `leaseToken`, and `serviceSecret` fail at
   any nesting depth.
5. A queued activity always displays `等待浏览器启动`; it must not imply a
   headless browser is already running merely because the safe default mode is
   `headless`.
6. Render bounded, localized, state-aware messages for known
   `lastErrorCode` values and a safe generic fallback for unknown codes. Do not
   print raw snake-case error codes to the operator.
7. Avoid repeated assistive announcements on timestamp-only rerenders. Track
   the previously rendered activity sequence on the host, keep timestamp and
   attempt text outside the live region, set `aria-live="polite"` only when the
   activity sequence changes, and `aria-live="off"` for an identical sequence.
   The initial queued placeholder may announce once.
8. Update the local MediaCrawler HTTP fixture with both `activity` and
   `candidateProjectionState` so it matches the closed response contract.

## TDD and verification

- Add failing behavior tests first and record focused RED output before editing
  production code.
- Cover exact decoder closure, key-only recursive privacy, projection polling,
  duplicate-run blocking, queued copy, localized error copy, and live-region
  sequence behavior.
- Run focused frontend self-tests, the frontend TypeScript/build command used by
  the repository, generated-type freshness, and `git diff --check`.
- Write `final-fix-frontend-report.md` beside this brief with exact RED/GREEN
  evidence, self-review, and limitations. Force-add the brief/report and commit
  only scoped files.
