# Task 2 Brief — Connection center state machine

## Goal

Add a deterministic controller-level Provider Connection state machine so the
AI Growth workspace can load, create, test, enable/disable, rotate and delete
official search connections while preserving the user's current acquisition
task.

## Scope

- Modify `frontend/src/features/ai-growth/controller.ts`.
- Modify `frontend/src/features/ai-growth/types.ts` only if shared public state
  types are genuinely needed.
- Modify focused `frontend/src/features/ai-growth/controller.test.ts` tests.
- Do not build the final drawer markup/styles yet; Task 3 owns presentation.

## Required State and Controller Actions

- Safe state contains only catalog metadata, safe connection projections,
  selected provider/connection IDs, mutation status, safe health result,
  message and error. It must never contain API Key or a masked copy.
- Expose controller methods for:
  - `getConnectionCenter()`
  - `openConnectionCenter()` / `closeConnectionCenter()`
  - provider/connection selection
  - create or rotate, accepting API Key only as a method argument
  - test
  - enable/disable
  - delete
  - continue the preserved task after a healthy connection exists
- Opening loads catalog and connections concurrently. A close/reopen generation
  guard must ignore stale responses.
- Catalog and working connection lists include only `kind === "search"` for the
  connection-center workflow. System content-fetch/import entries must not be
  counted as search connections.

## Lifecycle Rules

- Create explicitly sends `status: "disabled"`; an untested connection must
  never become usable merely because the backend create default is active.
- Rotate sends `{apiKey, status:"disabled"}` (and baseUrl only when explicitly
  provided) so the new credential version returns to an untested disabled
  state.
- Test returns `ok:false` honestly and refreshes the safe connection list after
  completion. It does not auto-enable a failed connection.
- Enable is client-guarded until the current connection reports
  `lastHealthStatus === "passed"`; successful enable refreshes the list.
- Disable uses status-only PATCH and never sends an empty `apiKey`.
- Delete only targets a personal connection selected from safe projections;
  system connections are rejected client-side.
- `healthyConnections` must require `kind === "search"`, `status === "active"`
  and `lastHealthStatus === "passed"`.
- `continueAfterConnection()` closes the center and invokes normal submit only
  after a healthy connection exists. It must preserve `taskText`,
  `targetPlatform`, `templateId`, route, and plan input state.

## Concurrency and Errors

- All open/load and mutation responses use a connection-center generation or
  mutation token so stale completion after close/reopen cannot overwrite newer
  state.
- Prevent duplicate mutation calls while a mutation is in flight.
- Reuse the same create idempotency key for one in-flight/retried save action;
  a distinct user save creates a new key.
- Errors are mapped to safe UI text through existing error helpers. Never place
  request bodies, raw upstream errors or credentials into state/toasts.
- API Key is a local call parameter only. Clear any local reference in `finally`
  and never serialize it.

## TDD Cases

1. Existing active-but-untested connection still blocks submit; active+passed
   permits plan generation.
2. Open loads only search catalog/connections and preserves task/platform/
   template.
3. Close then reopen ignores late results from the first open.
4. Create sends disabled and stores no secret in `getState()`,
   `getConnectionCenter()` or JSON serialization.
5. Test `ok:false` remains failed and cannot enable; test passed then enable
   produces a healthy connection.
6. Disable is status-only; rotate is disabled and clears health readiness;
   delete refreshes state.
7. Duplicate clicks while saving/testing/updating/deleting do not issue duplicate
   requests.
8. Continue only works with an active+passed search connection and then follows
   the existing plan-draft path with the original Douyin task payload.

## Required Method

1. Write failing controller tests first and run RED.
2. Implement the smallest state machine without presentation changes.
3. Run focused controller tests, complete frontend unit suite, production build
   and `git diff --check`.
4. Obtain independent review, address actionable findings, and commit scoped
   files as `feat: manage acquisition provider connections`.
5. Write `task-2-report.md` and update `progress.md`.

## Protected File

Do not read, modify, stage or commit
`docs/superpowers/plans/2026-07-23-ai-model-adapters-and-pi.md`.
