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
- Daily desktop work uses `pnpm desktop:local`: independent persistent MySQL,
  latest host Backend and source Electron. Do not copy old Trial data/keys or
  package another App/DMG/ZIP for ordinary fixes. See `docs/DEPLOYMENT.md`.
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
Every product UI change must support and separately validate both black/green
and blue/white themes, at wide and narrow widths. Check text contrast and
selected, disabled, error and success states; a single-theme pass is not acceptance.

Behavior, contracts, data structures, interactions, deployment, and module
responsibilities must update their current documentation in the same change.

## Private GitHub source backup
- After each verified product change, synchronize the latest rebuildable source to
  the existing private `kzhangmyang-cmyk/Shensi-ai` repository on `main`.
- Use its curated source snapshot as the publishing workspace. Do not push this
  development checkout wholesale: it has local runtime data and a separate Git
  history. Review changed paths and run secret/data exclusion checks first.
- Never include environment secrets, account notes, customer files, databases,
  browser profiles, logs, screenshots of real data, build outputs or installers.
- Report the pushed revision only after GitHub confirms it; a local copy or
  unpushed commit is not a completed backup.
