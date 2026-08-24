# Shensi Agent Instructions

## Required reading order
1. `README.md`
2. `docs/PROJECT_STATUS.md`
3. `docs/ARCHITECTURE.md`
4. The relevant file under `docs/modules/`
5. `docs/API_INDEX.md` for public-contract work
6. `docs/DATA_MIGRATION.md` or `docs/DEPLOYMENT.md` for operations

## Current authority
- Work only from this repository.
- `docs/PROJECT_STATUS.md` is the sole current progress ledger.
- `docs/archive/` and `docs/superpowers/` are historical context, not execution authority.
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
