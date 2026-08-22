# P2 Task 5 report — recoverable specialist council orchestration

Status: COMPLETE

## Outcome

- Added a durable analysis control plane with immutable private owner/team
  identity, random 64-hex lease tokens, incrementing reclaim attempts and
  strict expiry (`completedAt == leaseExpiresAt` is stale). Token plus attempt
  prevents same-worker ABA while model job attempt remains exactly `1`.
- Fenced every worker-owned run transition, specialist result, redacted gap,
  audit graph, rebuttal reservation/completion and finding-disposition write.
  Memory and MySQL enforce the fence at the mutation boundary; MySQL locks the
  control row in the same transaction as the artifact write.
- Added the recoverable worker and sweeper. Duplicate wakes single-flight,
  restarts reuse durable analyze results, graphs and rebuttal reservations,
  changed replay conflicts, and no path creates round two. Each role has a
  60-second default deadline and at most one transport retry without changing
  logical identity; five analyze plus at most five rebuttal jobs bound the
  logical model-call budget to ten.
- Finance and cashflow are terminal hard-constraint roles. Profit, cost or tax
  may be absent only after the deterministic role projection proves no missing
  hard-constraint or action-formula dependency; the worker then stores a closed
  gap with `detail:null`. Missing tax input stores `tax_input_missing` and does
  not call the tax model or fabricate a tax finding.
- Production Growth composition now supplies the existing durable official
  model runtime store. The module creates the real model port, coordinators,
  worker, recovery sweeper and relay. Shutdown closes relay first, then stops
  the sweeper, drains worker runs and finally releases lower resources.
- Expanded `test:financial-council` from the P1 subset to all focused P2 Task
  1–5 files.

## TDD evidence

- Initial focused RED: two expected missing-module failures for the analysis
  worker and recovery sweeper; the pre-existing module suite remained 18/18.
- First worker/sweeper GREEN: 6/6. Expanded counterexamples cover exact expiry,
  same-worker ABA, all artifact fences, duplicate wake, process restart,
  transport retry identity, timeout, partial and critical role failures,
  missing tax input, log redaction and actual post-model completion-time
  fencing at exact lease expiry.
- MySQL analysis control parity covers identity, exact-expiry recovery, reclaim
  attempt/token, ABA rejection and closed gap persistence; the fake executable
  transaction harness now models all eleven runtime tables.

## Verification

- Focused worker/recovery/service/module: 38/38 passed.
- MySQL repository: 62 passed / 2 conditional live-InnoDB skips.
- Aggregate P2: 213/213 passed.
- Business Advisor: 28/28 passed.
- Growth Advisor: 99/99 passed.
- Growth production composition/application integration: 15/15 passed.
- Root backend/frontend build and `git diff --check`: passed.

`MYSQL_TEST_ADMIN_URL` is not configured, so the two real InnoDB cases remain
explicit conditional skips; executable transaction/schema parity is green.

Fast mode explicitly waived independent review and CodeRabbit. P2 is complete;
P3–P5 remain pending, so the full Financial Council product is not complete.
