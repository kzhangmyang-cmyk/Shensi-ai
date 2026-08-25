# Douyin Visible Crawl Observation Design

## Goal

When a local MediaCrawler collection starts, open a dedicated visible Douyin
Chromium window and let the authenticated acquisition dashboard report the
current safe activity phase and approved keyword while collection continues.

## Runtime behavior

- The crawl subprocess uses standard Playwright, not CDP. This removes the
  existing wait for a user-managed debug port and does not expose a debugging
  endpoint.
- `MEDIACRAWLER_BROWSER_HEADLESS=false` selects a visible dedicated crawl
  window. Production can retain `true` for a background browser.
- The authenticated account profile is reused only after the login context has
  closed and released its profile lock.
- The visible tab follows the current approved search keyword and the public
  video whose comments are being collected. These navigations are an operator
  observation mirror; the deterministic MediaCrawler request client remains
  the collection authority.
- Observation navigation failures do not silently replace or fabricate crawl
  data. The normal crawler result and failure paths remain authoritative.

## Safe progress contract

The private sidecar and persisted Node projection exchange only:

```text
phase:
  queued | starting_browser | opening_douyin | searching |
  collecting_comments | finalizing | completed
currentKeyword: string | null
browserMode: visible | headless
sequence: non-negative integer
```

`currentKeyword` must be null or one of the immutable approved job keywords.
The sequence increases only when the activity changes. Node accepts progress
under the current crawler fence and rejects a lower sequence or a conflicting
value at the same sequence.

The contract never contains a URL, browser/context identifier, profile path,
cookie, header, selector, CDP port, WebSocket endpoint, or raw crawler log.
Browser routes continue to read only the MySQL/Memory job projection; they do
not proxy the live sidecar.

## User interface

The existing two-second status polling remains sufficient. The real-time card
shows the browser mode, translated activity phase, current keyword, update
time, and attempt number. It labels candidate usage as an allowance rather
than a completion percentage. While a run is non-terminal, another run-now
submission stays disabled. Comment and direct-message approval behavior is
unchanged.

## Failure and lifecycle rules

- A sidecar restart reloads its last sanitized activity from `job.json`.
- A Node restart reloads the corresponding activity from
  `acquisition_crawler_jobs.payload_json`.
- Terminal success/partial completion persists `completed`; cancellation or a
  closed failure retains the last useful activity beside the job state and
  failure code.
- The dedicated browser closes with the crawl subprocess. CAPTCHA,
  verification, rate limits, or account warnings are never bypassed.

## Verification boundary

Automated tests use fake pages/processes and must not contact Douyin. No live
crawl, comment, direct message, or CAPTCHA handling is part of this change.

