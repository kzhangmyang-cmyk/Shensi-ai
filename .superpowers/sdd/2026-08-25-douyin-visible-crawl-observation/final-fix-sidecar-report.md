# Final fix A — sidecar observation and terminal lifecycle

## Scope

Changed only the Python MediaCrawler sidecar, its adapter tests, and this
report. All browser/context/page objects used by tests are fakes; no real
browser, crawl, or Douyin request was started.

## RED

After adding the required behavior tests first, ran:

```bash
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py \
  services/media-crawler/tests/shensi_adapter/test_contracts.py
```

Key pre-implementation failures:

```text
primary_calls contained the approved search/video URLs
RuntimeError: observation_navigation_failed
AssertionError: collector page must not be used for observation
activity:starting_browser was emitted before launch_returned
queued activity was observed when the runner began
identical activity advanced sequence from 0 to 1
terminal activity remained queued rather than completed
9 failed, 24 passed in 0.89s
```

These failures exercised the requested independent behaviors: collector-page
reuse, observation-failure interference, synthetic opening activity, missing
synchronous start activity, repeated activity persistence, and incomplete
terminal activity. The terminal tests' direct completed-activity assertion
failed before their later atomic-descriptor assertions could execute in RED;
those descriptor assertions are recorded in the GREEN coverage below.

## Implementation

- The observer lazily creates one separate page through
  `crawler.browser_context.new_page()` and never navigates
  `crawler.context_page`.
- Observation page creation and navigation are best effort. Those failures are
  swallowed, while the wrapped search/comment operation keeps its original
  return or exception behavior. The observer does not close the page; the
  browser context owns cleanup.
- The observer wraps a successful standard `launch_browser` return to publish
  `opening_douyin`. The subprocess now emits `finalizing` only; it no longer
  emits synthetic `starting_browser`, synthetic pre-start `opening_douyin`, or
  `completed`.
- `CrawlJobManager` publishes `starting_browser` in the same persisted running
  transition before it invokes the runner. Equal phase/keyword/mode snapshots
  are ignored without a sequence or timestamp update.
- Successful and partial terminal transitions attach `completed` (null keyword,
  existing browser mode, next sequence) before one metadata persistence write.
  Cancellation and failure leave the last useful activity untouched.
- Final pages are written privately first but their terminal descriptor is held
  in memory until the same `job.json` write that records successful/partial
  terminal state and completed activity. No persisted running descriptor can
  advertise a final (`next_cursor: null`) page.

## GREEN

Focused tests and whitespace gate:

```bash
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py \
  services/media-crawler/tests/shensi_adapter/test_contracts.py
git diff --check
```

Output:

```text
.................................                                        [100%]
33 passed in 0.71s
```

All local adapter tests:

```bash
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/shensi_adapter
```

Output:

```text
....................................................................     [100%]
68 passed in 3.17s
```

## Self-review and limitations

- Separate observation-page tests verify both normal use and creation/navigation
  failures, including search and comment collection continuity.
- Launch-order testing verifies `opening_douyin` follows the real standard
  browser launch return rather than a pre-start synthetic write.
- Manager tests verify synchronous start visibility, identical activity no-op,
  successful/partial completion, and every captured persisted descriptor around
  the final page transition.
- Existing documentation already defines the sidecar as a private observation
  mirror and its browser-mode configuration; no public API or operator workflow
  changed, so no module/deployment document change was needed beyond this task
  report.
- The observation tab remains intentionally best-effort and can be unavailable
  without changing deterministic collection. It is not an activity event log;
  snapshots can still coalesce between runner polls by design.
