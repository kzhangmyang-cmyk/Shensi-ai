# Shensi Agent Instructions

## Required reading order
1. `README.md`
2. `docs/PROJECT_STATUS.md`
3. `docs/operations/real-customer-trial.md` before opening, publishing, or
   diagnosing the customer-visible trial
4. `docs/ARCHITECTURE.md`
5. The relevant file under `docs/modules/`
6. `docs/API_INDEX.md` for public-contract work
7. `docs/DATA_MIGRATION.md` or `docs/DEPLOYMENT.md` for other operations

## Current authority
- Work only from this repository.
- `docs/PROJECT_STATUS.md` is the sole current progress ledger.
- `docs/archive/` and `docs/superpowers/` are historical context, not execution authority.
- The customer-visible local trial has one entry point:
  `http://127.0.0.1:5608`. The current public trial origin is only the value
  reported by `pnpm trial:status` while it reports `running: true`.
- Source edits do not update either customer-visible surface. Run and verify
  `pnpm trial:publish` before describing local and public trial content as
  synchronized.
- Ports `5188`, `5388`, and `5588` are development or test surfaces, not
  customer entry points. Never reuse a Quick Tunnel URL from chat history,
  screenshots, bookmarks, logs, or archived documents.
- Do not invent frontend DTOs; use generated types from `contracts/`.

## Safety
- Never print, commit, or copy secrets into tracked files.
- Never overwrite the source database during migration.
- Preserve unrelated user changes.
- Use `apply_patch` for source edits and run the documented focused and aggregate gates.

## Required finish gates
- `./scripts/context-check`
- `pnpm test`
- `pnpm build`
- `git diff --check`
- Relevant deployment or migration verification when those surfaces change.

## Documentation synchronization
Behavior, contracts, data structures, interactions, deployment, and module
responsibilities must update their current documentation in the same change.
