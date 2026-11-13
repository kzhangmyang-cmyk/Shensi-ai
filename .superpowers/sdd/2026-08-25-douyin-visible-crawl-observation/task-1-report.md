# Task 1 report: Sidecar visible browser and sanitized activity

## Scope

Implemented the Task 1 sidecar layer only. No real crawl or Douyin request was
started.

## RED

Command:

```bash
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py \
  services/media-crawler/tests/shensi_adapter/test_contracts.py
```

Key output before implementation:

```text
ImportError: cannot import name 'CrawlActivity' from 'shensi_adapter.schemas'
2 errors during collection
```

This was the expected missing-contract failure for the new activity surface.

## GREEN

Command:

```bash
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py \
  services/media-crawler/tests/shensi_adapter/test_contracts.py
```

Final output:

```text
........................                                                 [100%]
24 passed in 0.55s
```

Also passed:

```bash
git diff --check
```

## Changes

- `services/media-crawler/shensi_adapter/schemas.py`
  - Added closed `CrawlActivity` and included it in every `CrawlJobView`.
- `services/media-crawler/shensi_adapter/crawl_jobs.py`
  - Added explicit standard-browser configuration (`ENABLE_CDP_MODE=False`,
    `CDP_CONNECT_EXISTING=False`, and matching `HEADLESS`/`CDP_HEADLESS`).
  - Added a narrow injected seam for browser/config testing.
  - Added allowlisted visual navigation for encoded Douyin search URLs and
    numeric Douyin video URLs, preserving wrapped return values.
  - Added atomically written, sanitized activity snapshots; the job manager
    validates a non-null keyword against its frozen request and persists its
    own monotonic sequence.
- `services/media-crawler/shensi_adapter/app.py`
  - Reused `MEDIACRAWLER_BROWSER_HEADLESS` for both QR login and crawl runner
    deployment configuration. No run-now option was added.
- `services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py`
  - Added visible-mode/CDP-disabled navigation test and activity validation /
    sequencing coverage.
- `services/media-crawler/tests/shensi_adapter/test_contracts.py`
  - Added closed contract coverage for a job view with activity.

## Self-review

- Confirmed activity snapshots contain only phase, approved request keyword
  (or `null`), and browser mode; the manager assigns the visible sequence.
- Confirmed the observer can navigate only to `www.douyin.com` encoded search
  or numeric video URLs and returns the wrapped upstream values unchanged.
- Confirmed the test seams use fake config/crawler/page objects and issue no
  external requests.
- No current documentation was changed: this is a private sidecar response
  addition and the task brief limits the implementation to the listed Task 1
  files; existing deployment/module documentation already defines the same
  browser-mode environment variable.

## Follow-up concern

Activity is intentionally a latest atomic snapshot, not an append-only event
log. Very short-lived intermediate phases can coalesce between runner polls;
the persisted view still remains sanitized and monotonic for every snapshot the
manager consumes.

## Fix round 1: lossless keywords and single-read activity polling

### Correction to the original RED evidence

The original collection-time `CrawlActivity` import failure was not behavior-
level evidence for the browser configuration, observer navigation, or snapshot
polling implementation. It should not be interpreted as such.

This fix round added the comma-keyword and atomic-replacement regression tests
first, then recorded a behavior-level RED baseline before restoring the minimal
fix. No initial-implementation evidence has been retroactively relabelled.

### Behavior-level RED baseline

Command:

```bash
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py \
  services/media-crawler/tests/shensi_adapter/test_contracts.py
```

Key output before this round's fix:

```text
AssertionError: assert 'seal, gasket' == 'seal%2C%20gasket'
AssertionError: opening_douyin != starting_browser
2 failed, 24 passed
```

The first failure proves the old comma-joined config transport was lossy at the
upstream split boundary. The second deterministically simulates an atomic
replacement between the old poller's two reads: it publishes the replacement
snapshot twice and drops the first snapshot.

### Fix and coverage

- The upstream `config.KEYWORDS` transport percent-encodes each frozen keyword
  before comma joining. The observer decodes it immediately before the real
  search call and resets `source_keyword_var` to the exact original value, so
  comma-containing public keyword semantics and stored source keyword remain
  unchanged.
- Activity polling reads and parses one captured snapshot string, so a replacement
  cannot make the same poll compare one payload and emit another.
- `test_execute_upstream_losslessly_transports_comma_keyword` covers the encoded
  transport, decoded upstream search value, exact observer URL, and source
  keyword restoration.
- `test_runner_reads_each_activity_snapshot_once_when_replaced_during_a_poll`
  covers deterministic replacement during polling and requires the two distinct
  snapshots exactly once each.

### GREEN

Command:

```bash
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py \
  services/media-crawler/tests/shensi_adapter/test_contracts.py
```

Output:

```text
..........................                                               [100%]
26 passed in 0.66s
```

`git diff --check` also passed.

### Post-hoc behavioral baseline and mutation checks

These checks validate the existing browser-observation tests' sensitivity; they
are explicitly post-hoc mutation evidence, not a replacement for the original
RED record.

1. Baseline command for
   `test_execute_upstream_disables_cdp_and_applies_configured_visible_mode`:
   `1 passed in 0.08s`.
2. Temporarily changed `ENABLE_CDP_MODE` to `True`; the same test failed with
   `AssertionError: assert True is False`. The production value was immediately
   restored to `False`.
3. Temporarily removed the comment observer's video navigation; the same test
   failed because `https://www.douyin.com/video/73001` was missing from recorded
   calls. The navigation wrapper was immediately restored.

No real crawler, browser, or Douyin request ran during these checks.

## Fix round 2: browser configuration and observer RED remediation

This is a fresh remediation cycle on the current branch. It does **not** alter
or relabel the historical record for the original implementation.

### Temporary behavior removal and RED

The tests were left unchanged. I temporarily changed only the Task 1 production
behavior under test:

- set CDP mode/connection to `True` and inverted `HEADLESS` / `CDP_HEADLESS`;
- removed the search and comment observer calls that navigate the visible page.

Focused command:

```bash
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py \
  services/media-crawler/tests/shensi_adapter/test_contracts.py
```

Genuine RED output:

```text
AssertionError: assert True is False
AssertionError: assert [] == ['https://www.douyin.com/search/seal%2C%20gasket?type=general']
2 failed, 24 passed in 0.64s
```

To let the original browser-config/navigation test reach both navigation
expectations, I restored only the browser configuration while keeping both
observer calls disabled, then ran:

```bash
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py::test_execute_upstream_disables_cdp_and_applies_configured_visible_mode
```

That test genuinely failed with:

```text
AssertionError: assert [] == [
  'https://www.douyin.com/search/%E8%A2%9C%E5%AD%90?type=general',
  'https://www.douyin.com/video/73001',
]
1 failed
```

### Restore and GREEN

I restored the exact production assignments:

```python
config.ENABLE_CDP_MODE = False
config.CDP_CONNECT_EXISTING = False
config.HEADLESS = headless
config.CDP_HEADLESS = headless
```

and restored both observer navigation calls. The final production files are
byte-identical to their pre-remediation state.

Final command:

```bash
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py \
  services/media-crawler/tests/shensi_adapter/test_contracts.py
git diff --check
```

Output:

```text
..........................                                               [100%]
26 passed in 0.64s
```

No real crawler, browser, or Douyin request ran in this remediation cycle.
