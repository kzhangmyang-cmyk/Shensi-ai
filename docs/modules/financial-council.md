# Financial Council

## Responsibility

Builds a financial snapshot from authoritative facts or a statement package,
runs specialist analysis and audit/rebuttal, derives CFO consensus and
portfolio scenarios, requires human approval, and dispatches only controlled
draft/todo operations with durable receipts.

## Entry Points

- Composition: `backend/src/growth-financial-council-module.ts`.
- Domain/API: `backend/src/financial-council-service.ts` and
  `backend/src/financial-council-router.ts`.
- Supporting routers: policy, model-routing, statement-package, and
  agent-center `financial-council-*-router.ts` files.
- Workers: analysis, optimization, dispatch, and their recovery sweepers.
- Frontend: `frontend/src/growth/council/` and
  `frontend/src/growth/agents/`, routed by `frontend/src/growth/router.ts`.

## Dependencies

Growth workspace/capability context, finance facts and statement packages,
advisor and acquisition projections, model connection snapshots/gateway,
Growth HTTP idempotency, MySQL repositories, and the immutable Growth contract
release `1.0.12`.

## Database Tables

Repository DDL owns `financial_council_runs`, run events and snapshots,
specialist/audit/rebuttal/consensus facts, portfolio revisions, policy
versions, model-routing versions, dispatch operations/events/receipts,
`financial_council_drafts`, and financial statement package tables. Inspect
`financial-council-mysql-repository.ts` and the focused policy, routing, draft,
dispatch, and statement-package repositories for exact columns.

## Public Interfaces

Contracted routes are under `/api/v1/finance/council-runs`,
`/api/v1/finance/council-policy`,
`/api/v1/finance/council-model-routing-policy`,
`/api/v1/finance/statement-packages`, and the finance agent-center reads. The
editable contract is `growth-advisor-quote-roi.v1.yaml`; release `1.0.12`
contains the current immutable public snapshot.

## Tests

- Full council domain suite: `pnpm test:financial-council`
- Vertical slice: `pnpm --filter ./backend test:financial-council:vertical`
- MySQL suite: `pnpm --filter ./backend test:financial-council:mysql`
- Real-runtime integration: `pnpm --filter ./backend test:financial-council:real-runtime`
- Real browser: `pnpm test:e2e:financial-council:real`

## Operational Checks

Follow `docs/operations/financial-council-real-runtime.md`. Real-runtime and
browser evidence require `MYSQL_TEST_ADMIN_URL`; live-provider smoke additionally
requires valid model connection IDs and decryption keys. Verify restart
recovery, approval authority, revision identity, dispatch idempotency, and that
no provider payload or business data leaks through agent-center projections.

## Known Limitations

Consent-only statement packages intentionally remain `not_computable` without
an attested cash forecast. Live-provider behavior is unverified when local
credentials are absent, and memory suites do not prove MySQL concurrency or
cross-process recovery. Approval creates controlled downstream work; it does
not grant unrestricted autonomous execution.
