# Task 1 report — Complete trial frontend surface and login alias

## RED evidence

1. `pnpm --filter ./frontend test` first failed in the filesystem sandbox because `tsx` could not create its IPC pipe (`listen EPERM` under the temporary directory). Per the task instruction, the same command was rerun outside the filesystem sandbox.
2. The outside-sandbox RED run failed as intended after the alias test was added: `./app-session` did not export `resolveLoginIdentity`. This demonstrated that the real login controller did not yet implement the requested alias boundary.
3. After the dashboard/navigation tests were added, the RED run failed because `./demo-app` did not export `renderDashboardView`. The dashboard was therefore still a dead visible entry.
4. The preview-label RED run failed at `demo-store.self-test.ts:188` with `false !== true`, proving the local conversation surface had no `预览 · 待接入` label.
5. The routing-selection RED run failed because `./demo/demo-router` did not export `demoModuleFromHash`, proving the restored dashboard route was not exposed through the Demo router contract.

## GREEN verification

- `pnpm --filter ./frontend test` exited `0`; output included the acquisition, automation, outreach API/controller/view suites and `{ "ok": true, "checked": 57 }`.
- `pnpm --filter ./frontend test:types` exited `0` for application, test, and visual-reader TypeScript projects.
- `git diff --check` exited `0`.

## Changed files

- `frontend/index.html`
- `frontend/src/app-route.ts`
- `frontend/src/app-route.self-test.ts`
- `frontend/src/app-session.ts`
- `frontend/src/app-session.self-test.ts`
- `frontend/src/demo/demo-types.ts`
- `frontend/src/demo/demo-router.ts`
- `frontend/src/demo/demo-app.ts`
- `frontend/src/demo/demo-conversations-view.ts`
- `frontend/src/demo/demo-conversion-view.ts`
- `frontend/src/demo/demo-capabilities-view.ts`
- `frontend/src/demo/demo-store.ts`
- `frontend/src/demo/demo-store.self-test.ts`
- `frontend/src/demo/demo.css`
- `frontend/src/growth/entry.ts`
- `frontend/src/growth/entry.self-test.ts`
- `frontend/src/replica-dashboard.css`
- `frontend/src/self-test.ts`

## Commit

Final Task 1 commit: `HEAD` (the final handoff includes its resolved SHA).

## Self-review

- Login aliases are enabled only by `VITE_REAL_TRIAL === "true"` with non-empty alias and canonical email; injected equivalents support controller tests. Matching is trim/lowercase and exact, passwords are untouched, disabled mode keeps the submitted identifier, and incomplete enabled configuration rejects before `fetch`.
- `#dashboard` is a standalone Demo route and renders deterministic totals from `DemoState`; the original nine primary navigation entries remain and real acquisition remains accessible.
- The sidebar contains literal links for all six requested Growth routes. Growth route metadata drives titles/subtitles and active link state. A direct `#growth/quotes` visit without `case` stops before the Growth runtime and shows a customer-readable path to the catalog instead of `quote_case_required`.
- Local dashboard, conversations, conversion, automation, and overseas surfaces now expose `预览 · 待接入`; connected acquisition and real Growth labels remain distinct.
- Scope review found an unrelated in-progress edit at `docs/superpowers/plans/2026-08-26-real-customer-trial.md`; it was not staged or changed here. `frontend/README.md` contains now-stale route descriptions, so Task 4 documentation synchronization should update it rather than leave that change in this Task 1 commit.
