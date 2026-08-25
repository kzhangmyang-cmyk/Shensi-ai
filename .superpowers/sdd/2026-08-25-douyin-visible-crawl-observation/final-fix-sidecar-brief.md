# Final review fix A — sidecar observation and terminal lifecycle

Base: `1f71b97`

## Scope

Modify only the Python sidecar implementation/tests and this fix report.
Never launch a real browser or contact Douyin.

## Required behavior

1. The operator observation mirror must use a separate page created from the
   crawl browser context, never `crawler.context_page`. Failure to create or
   navigate that observation page is swallowed as an observation-only failure;
   the original search/comment collector must still run and return/raise its
   own result. The browser context owns cleanup of the observation page.
2. Publish `starting_browser` synchronously in the manager before consuming the
   runner. Wrap the real standard `launch_browser` completion to publish
   `opening_douyin`; remove the pre-`crawler.start()` synthetic opening write.
   Repeated identical phase/keyword/mode activity is a no-op and does not
   increment sequence or update time.
3. The subprocess publishes `finalizing` but not `completed`. The manager sets
   activity `completed` (null keyword, same mode, next sequence) in the same
   persisted terminal metadata transition for both `succeeded` and `partial`.
   Failure/cancellation retain the last useful activity.
4. A final `done` page descriptor and successful/partial terminal state/activity
   must be persisted together in `job.json`; there must be no externally
   observable `running` job that advertises a `done` final page.

## TDD and verification

- Add behavior tests first for separate-page use, search and comment navigation
  failure non-interference, real opening transition, repeated activity no-op,
  synchronous starting, successful and partial completed activity, and atomic
  final-page metadata. Witness and record RED before implementation.
- Run the focused Python command from Task 1, then all sidecar adapter tests if
  available, and `git diff --check`.
- Write `final-fix-sidecar-report.md` beside this brief with exact RED/GREEN
  evidence, self-review and limitations. Force-add it and commit only scoped
  files.
