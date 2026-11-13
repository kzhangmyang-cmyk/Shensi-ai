# Task 2 Report — Provider connection center state machine

## Result

Implemented the controller-level Provider Connection state machine without
adding drawer markup or styles. The public state contains only provider catalog
metadata, safe connection projections, selected IDs, mutation status, safe
health output, messages, and normalized errors.

The controller now supports concurrent catalog/connection loading, selection,
create/rotate, health testing, enable/disable, delete, and continuing the
preserved acquisition task. Only `search` connections that are both `active`
and `passed` can unblock plan generation.

## Security and lifecycle guarantees

- API Keys are accepted only as `saveProviderConnection` parameters, passed to
  the API write, and cleared from the local parameter references in `finally`.
- Create and rotate explicitly send `status: "disabled"`; rotate includes
  `baseUrl` only when the caller explicitly provides it.
- Disable sends `{ status: "disabled" }` and never includes an empty key.
- Public controller/advisor state and their JSON projections never contain the
  fixture keys used by tests.
- API errors are converted to bounded safe messages; raw upstream messages and
  request bodies are not copied into state or thrown to the UI layer.
- System-owned connections are rejected client-side for mutations.

## RED → GREEN evidence

Focused command used for the vertical slices:

```sh
cd frontend
node --import tsx --test --test-name-pattern='<case>' \
  src/features/ai-growth/controller.test.ts
```

Observed RED failures before the corresponding implementations included:

- active-but-untested incorrectly reached `awaiting_approval` instead of
  `connection_required`
- `openConnectionCenter`, `closeConnectionCenter`, selection/save, test,
  delete, and continue actions were absent
- close/reopen retained an old in-flight save lock (`1 !== 2` writes)
- a system connection incorrectly accepted a rotate request

Final focused GREEN:

```text
38 tests/subtests passed, 0 failed
```

Coverage includes search-only filtering, concurrent load, stale generations,
disabled create/rotate, secret non-retention, honest `ok:false`, passed-before-
enable gating, status-only disable, delete refresh, mutation de-duplication,
safe error recovery, and preserved Douyin task continuation.

## Changed files

- `frontend/src/features/ai-growth/controller.ts`
  - adds the explicit safe connection-center state and controller actions
  - centralizes mutation token, refresh, error, and duplicate-call handling
  - requires `active + passed + search` for healthy plan generation
- `frontend/src/features/ai-growth/controller.test.ts`
  - adds focused controller behavior and security regression coverage
- `.superpowers/sdd/2026-08-06-acquisition-provider-connection-center/progress.md`
- `.superpowers/sdd/2026-08-06-acquisition-provider-connection-center/task-2-report.md`

## Verification

- focused controller suite: 38 passed, 0 failed
- frontend unit suite: 119 passed, 0 failed
- frontend production build/typecheck: passed
- `git diff --check`: passed
- build retained only the pre-existing large-chunk warning

## Independent review

Passed with no Critical, Important, Minor, or otherwise actionable findings.
The reviewer found the health gate, stale guards, duplicate protection,
disabled lifecycle payloads, safe errors, system read-only checks, and key
non-retention compliant with the Task 2 brief.

## Scope

No drawer UI/styles, backend, OpenAPI, generated contract, or protected user
plan file was changed.
