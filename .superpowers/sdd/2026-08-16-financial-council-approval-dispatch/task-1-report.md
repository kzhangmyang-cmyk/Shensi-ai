# P4 Task 1 report

Status: COMPLETE

Base: `8541f3b`

## Delivered

- Added the closed `select_portfolio`, `remove_action`, `restore_action` and
  `replace_action_parameters` edit algebra. Every action ID must already exist
  in the original server-validated candidate set; replacement accepts only
  bounded `ownerRole` and `durationDays`, while due dates not represented by
  the frozen action contract and all open/financial/provenance fields fail
  closed.
- Rebuilds the editable candidate set from original projected candidates and
  invokes the real optimizer once per successful edit. Dependency closure,
  twelve fixed hard constraints, balanced/cash-first/growth-first search and
  sensitivity are all recomputed; no old score, totals or forecasts are read.
- Added immutable revision metadata binding base revision, tenant-scoped
  idempotency identity, canonical request and operation hashes. Exact replay is
  stable, changed replay conflicts, stale run/portfolio revisions fail, and one
  concurrent base revision has one winner.
- Added atomic Memory/MySQL commit parity. The MySQL transaction locks the run,
  validates original-candidate provenance, inserts `(workspace,run,revision)`
  and advances the latest portfolio projection together. The additive schema
  migration replaces the old revision-one-only check.
- Wired `FinancialCouncilService.revisePortfolio` to the revision service and
  reused the P3 optimizer input/output projection helpers.

## RED -> GREEN evidence

1. Wished API RED: `0 pass / 1 fail`, missing
   `financial-portfolio-revision.js`; pure closed-edit GREEN: `5/5`.
2. Immutable repository RED: `122 pass / 2 fail / 2 skip`; both backends found
   a hard-coded child revision `1`. GREEN: `124 pass / 0 fail / 2 skip`.
3. Concurrent service RED: `14 pass / 1 fail`; both Memory edits crossed the
   validation await and committed. Post-validation CAS recheck GREEN: `15/15`.
4. MySQL migration harness RED: `70 pass / 1 fail / 2 skip`; fake schema parity
   did not recognize the additive ALTER. GREEN in the combined MySQL gate.

## Verification gates

- Pure edit focused suite: `5 pass`, `0 fail`.
- Service focused suite: `15 pass`, `0 fail`.
- Memory/MySQL/revision combined focused suite: `124 pass`, `0 fail`, `2`
  conditional live-MySQL skips.
- `npm run test:financial-council --workspace backend`: `287 pass`, `0 fail`,
  `1` conditional skip.
- `npm run test:financial-council:mysql --workspace backend`: `75 pass`,
  `0 fail`, `3` conditional live-MySQL skips.
- `npm run build --workspace backend`: pass.
- `git diff --check`: pass.

## Documentation ruling

No current README update is required. Task 1 adds an internal service and
repository capability; the HTTP route and frozen public contract remain for
P4 Task 5. This report is the synchronized current execution ledger.

## Remaining concern

`MYSQL_TEST_ADMIN_URL` was unavailable, so fake transactional parity passed but
the conditional live InnoDB paths were not exercised. Independent review and
CodeRabbit were intentionally skipped under user-selected fast mode.
