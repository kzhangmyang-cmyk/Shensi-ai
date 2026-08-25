# Final fix C — frontend report

Base backend final-fix commit: `72494b13d2fbbc1b6f484dbbd391438f7b357493` (`fix(acquisition): finalize crawler status projection`).

## Delivered

- The strict crawler-status decoder now requires exactly the closed
  `candidateProjectionState` enum: `pending`, `ready`, or `failed`.
- The response privacy guard recursively checks object field names only. It
  rejects forbidden names at any depth without treating safe content such as
  `cookie packaging` as secret material.
- Polling and launch blocking continue through a terminal crawl while the
  candidate projection is `pending`; a `ready` or `failed` projection stops
  polling. An empty terminal-ready candidate page is preserved as valid.
- The observation UI gives queued activity the truthful copy `等待浏览器启动`,
  provides bounded localized error messages, and announces activity only when
  its sequence changes. Attempt and timestamp stay outside the live region.
- Empty candidates with a pending projection show `正在整理候选人`, including a
  terminal crawler state before ingestion completes.
- The local MediaCrawler HTTP fixture now emits the complete status contract,
  including `candidateProjectionState` and `activity`.

## TDD evidence

RED was captured before production edits with the focused commands below:

```text
npx tsx src/acquisition/douyin-automation-api.self-test.ts
AcquisitionHttpError: 服务器返回了无法识别的数据
  at douyin-automation-api.ts:112
```

The decoder rejected the newly required projection field because its closed
shape had not yet been updated.

```text
npx tsx src/acquisition/douyin-automation-controller.self-test.ts
AssertionError: a terminal crawl with pending candidate ingestion must continue polling
0 !== 1
```

```text
npx tsx src/acquisition/douyin-automation-view.self-test.ts
AssertionError: expected /等待浏览器启动/
actual: 排队中后台浏览器运行中…
```

The added pending-projection candidate UI test also failed before its view
implementation:

```text
AssertionError: expected /正在整理候选人/
actual: 暂无候选人…
```

GREEN verification completed with:

```text
npx tsx src/acquisition/douyin-automation-api.self-test.ts
{"ok":true,"suite":"douyin-automation-api"}
npx tsx src/acquisition/douyin-automation-controller.self-test.ts
{"ok":true,"suite":"douyin-automation-controller"}
npx tsx src/acquisition/douyin-automation-view.self-test.ts
{"ok":true,"suite":"douyin-automation-view"}
npm run test:types
npm run build
npm run contract:check
git diff --check
```

All commands passed. The Vite build emitted its pre-existing chunk-size
advisory only; it did not fail the build.

## Follow-up ordering and accessibility fix

- `refreshRunFor` now awaits and validates crawler status before requesting
  candidates. It checks generation freshness after each await, so a ready
  status forms the ordering boundary for the candidate read and stale/aborted
  refreshes cannot publish either response.
- The controller regression gates the status response and proves that the
  candidate read remains at zero until that gate resolves; the following ready
  read then publishes the newly available candidate.
- A pending projection only shows `正在整理候选人` after a terminal crawler
  state. A running crawl continues to show `正在发现候选人` and never claims
  that records have already been saved.
- Strict projection decoding now requires a string before closed-enum
  membership, rejecting a JSON value such as `["ready"]`.
- Error announcements use a host-tracked error code independently of activity
  sequence: a new error is polite, an identical timestamp-only rerender is
  off, and clearing the error resets the token for a later announcement.

Follow-up RED evidence, before production edits:

```text
AssertionError: candidate reads must wait for the crawler status ordering boundary
1 !== 0

AssertionError: expected /正在发现候选人/
actual: 正在整理候选人公开记录已保存，候选人正在整理。

AssertionError: Missing expected rejection.
```

The final line is the strict decoder accepting `["ready"]`; the a11y test
then independently failed because a newly appearing ingestion error had no
explicit `aria-live="polite"` token.

Follow-up GREEN verification:

```text
npx tsx src/acquisition/douyin-automation-api.self-test.ts
{"ok":true,"suite":"douyin-automation-api"}
npx tsx src/acquisition/douyin-automation-controller.self-test.ts
{"ok":true,"suite":"douyin-automation-controller"}
npx tsx src/acquisition/douyin-automation-view.self-test.ts
{"ok":true,"suite":"douyin-automation-view"}
```

## Follow-up terminal candidate-read failure fix

`refreshRunFor` retains crawler status only after validating that it belongs to
the requested run. If the subsequent candidate read fails, it publishes that
known status with the bounded controller error state. Automatic refresh is now
scheduled only when no validated status exists or that status still requires
polling; a terminal `ready` or `failed` projection receives no automatic timer,
while the existing manual refresh path remains available.

RED evidence:

```text
AssertionError: a validated terminal status must survive a candidate-read failure
+ actual - expected
+ undefined
- 'succeeded'
```

GREEN verification includes the focused controller self-test plus the complete
frontend self-tests, TypeScript checks, production build, and `git diff --check`.

## Final decoder and queued-placeholder hardening

- The crawler status decoder now verifies that `state`, `activity.phase`, and
  `activity.browserMode` are primitive strings before closed-enum membership.
  Arrays, numbers, and objects fail closed rather than being coerced through
  `String(...)`.
- The pre-status queued placeholder keeps its own run token on the host. It is
  polite once per outstanding run and off on same-run rerenders; a matching
  status, no run intent, or a new intent resets the token as appropriate.

RED evidence before the production edits:

```text
douyin-automation-api.self-test.ts
AssertionError: Missing expected rejection.

douyin-automation-view.self-test.ts
AssertionError: the same pre-status run must not repeat its announcement
'polite' !== 'off'
```

Final GREEN verification:

```text
npx tsx src/acquisition/douyin-automation-api.self-test.ts
{"ok":true,"suite":"douyin-automation-api"}
npx tsx src/acquisition/douyin-automation-view.self-test.ts
{"ok":true,"suite":"douyin-automation-view"}
npx tsx src/acquisition/douyin-automation-controller.self-test.ts
{"ok":true,"suite":"douyin-automation-controller"}
```

## Self-review and limitations

- The decoder rejects only forbidden keys, recursively through records and
  arrays; it never inspects arbitrary value strings for secret-like words.
- Known error codes render fixed operator-safe copy. Unknown codes use a
  generic bounded message and are never shown verbatim.
- Verification uses local self-tests, TypeScript/build, and contract freshness
  only. No real browser, crawler, comment, direct message, or networked crawl
  was started.
