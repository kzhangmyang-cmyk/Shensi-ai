# P2 Task 4 brief — deterministic audit graph and one rebuttal

Status: COMPLETE — FAST MODE, no independent review

Base: `dbc24213ef9c30bc944f22527349131afd27e095`

Authoritative plan: `docs/superpowers/plans/2026-08-16-financial-council-specialists-audit.md`, Task 4.

## Required outcome

- Build a canonical conflict graph from verified specialist results only; input order cannot change edges or graph hash.
- Preserve closed public kind `action_exclusivity`. Formula/evidence/permission failures are never majority-voted.
- Structural `resource_competition` uses a canonical shared subject/resource signature; numeric capacity is P3 scope.
- Each role gets at most one round-1 rebuttal. Select one directed target by conflict precedence, then edge/finding ID. Other unresolved conflicts remain unresolved and block associated actions.
- Persist rebuttal reservation/input hash before `model.rebut`, reuse the same immutable job/content on restart, and allow exact completion replay only.
- Persist graph, rebuttal attempts, and final dispositions with Memory/MySQL parity, tenant/run/snapshot binding, rollback, and no round 2.

## Authorized files

- `backend/src/financial-council-audit.ts`
- `backend/src/financial-council-audit-test.ts`
- `backend/src/financial-council-rebuttal.ts`
- `backend/src/financial-council-rebuttal-test.ts`
- `backend/src/financial-council-repository.ts`
- `backend/src/financial-council-repository-contract-test.ts`
- `backend/src/financial-council-repository-test.ts`
- `backend/src/financial-council-mysql-repository.ts`
- `backend/src/financial-council-mysql-repository-test.ts`
- current plan plus this brief/report/progress ledger

Strict RED→GREEN remains required. Fast mode skips independent review, but not focused tests, Memory/MySQL parity, P1 regression, backend build, or diff-check. Commit exact scope when green.
