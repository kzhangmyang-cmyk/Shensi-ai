# P2 Task 5 brief — recoverable specialist council orchestration

Status: COMPLETE — FAST MODE, no independent review

Base: `cc7fe9af607fcafe9cd2fd1172c22861739eee95`

Authoritative plan: `docs/superpowers/plans/2026-08-16-financial-council-specialists-audit.md`, Task 5.

## Required lifecycle

`claim -> snapshot_frozen→analyzing -> five durable role outcomes -> analyzing→auditing -> durable graph/rebuttals/dispositions -> auditing→synthesizing -> release lease`.

- Persist immutable internal owner/team analysis identity at create/freeze.
- Lease token is random 64-hex, attempt increments, exact expiry is stale, same-worker reclaim cannot accept old results.
- Thread exact lease token+attempt+time through all worker-owned artifact writes and transitions.
- Model logical attempt/job identity remains `1`; one retry is transport-only and total logical calls are at most ten.
- Finance/cashflow failure or unavailable cash hard constraint is terminal `not_computable`. Profit/cost/tax may continue only after deterministic no-hard-constraint proof and a durable redacted gap. Missing tax input is a gap, not fake tax output.
- Recovery queries existing analyze/rebut artifacts first, never creates a second round, and treats changed replay output as conflict.
- Module startup wires the real model port/coordinators/worker/sweeper; shutdown stops relay/sweeper, drains worker, then closes lower resources.
- Expand `test:financial-council` to include all P2 Task1–5 focused files.

## Authorized scope

All files listed in Task 5, including repository/MySQL parity, specialists/audit/rebuttal fencing, Growth composition/application tests, `backend/package.json`, Business Advisor README, and current implementation index/report/progress.

Strict RED→GREEN and fresh focused/full gates remain required. No independent review/CodeRabbit. Commit exact implementation when green.
