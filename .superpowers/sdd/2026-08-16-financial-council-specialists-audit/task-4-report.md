# P2 Task 4 report — deterministic audit graph and one rebuttal

Status: COMPLETE

Base: `dbc24213ef9c30bc944f22527349131afd27e095`

## Outcome

- Added a canonical UTF-8-byte-ordered conflict graph over exactly five
  validator-authorized Task 3 analyze results bound to one tenant, run and
  frozen snapshot. Input order cannot alter edges, edge IDs or the graph hash.
- Kept the public conflict kind closed as `action_exclusivity`. Formula and
  evidence mismatches remain unresolved blockers rather than votes; permission
  failures cannot enter the graph because the public entry requires Task 3's
  in-process authorization provenance.
- Added deterministic structural detection for formula, evidence, definition,
  action exclusivity, shared subject/capability resource competition and risk
  preference conflicts. Numeric capacity policy remains outside P2.
- Added one directed round-1 target per role using the required precedence,
  then canonical edge/finding ordering. Unselected conflicts remain in each
  finding's blocking set and no round 2 is accepted.
- Added immutable pre-provider reservations. Restart reuses the persisted input,
  job and content identity; exact completed results replay without another model
  call, while changed inputs, bindings or outputs conflict.
- Added atomic Memory/MySQL persistence for audit graph plus initial
  dispositions and for rebuttal completion plus final disposition. Runtime
  schema now owns `financial_council_audit_graphs`,
  `financial_council_rebuttal_attempts` and
  `financial_council_finding_dispositions` with tenant/run/snapshot binding.

## TDD and recovery evidence

- RED was observed for the missing audit and rebuttal modules, the six-to-nine
  table schema change, absent fake-MySQL graph queries, missing rollback, direct
  content-binding acceptance, cross-run graph input and changed graph replay.
- Joint examples cover profitable-but-cash-negative, high gross margin with
  negative true profit, high ROI with incomplete evidence, shared structural
  capacity, unrelated findings, definition/risk preference conflicts and a
  rebuttal timeout.
- Recovery covers reservation before provider call, timeout with reservation
  retained, restart with byte-identical input, completion replay after a crash,
  changed completion rejection and round-2 rejection.
- Memory/MySQL repository contracts cover exact graph/rebuttal replay, changed
  replay conflict and final disposition parity. Fake executable MySQL tests
  cover graph/disposition rollback and all nine runtime tables.

## Verification

- Direct Task 4 plus Memory/MySQL repository parity: `110 passed / 2
  conditional live-InnoDB skips`.
- Existing P1 Financial Council suite: `107/107` passed.
- MySQL repository gate: `61 passed / 2 conditional live-InnoDB skips`.
- Backend TypeScript build and `git diff --check`: passed.

`MYSQL_TEST_ADMIN_URL` is not configured, so real InnoDB cases remain explicit
conditional skips; fake executable transaction and parser parity is green.

## Review and documentation audit

Fast mode explicitly waived independent review and CodeRabbit. These modules
remain internal and are not wired to the public HTTP surface until Task 5, so no
README, OpenAPI or generated contract update is required. The authoritative
plan, Task 4 brief/report and progress ledger contain the current rules.
