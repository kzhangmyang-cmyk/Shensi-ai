# Acquisition

## Responsibility

Plans and executes evidence-backed prospect discovery, provider calls,
candidate identity/qualification, authorized Douyin visual ingestion, copilot
work, controlled CRM conversion, outcome reconciliation, cost allocation, and
ROI projections.

## Entry Points

- Backend composition: `backend/src/acquisition-application.ts` and
  `backend/src/acquisition-runtime-bridge.ts`.
- HTTP routes: `backend/src/acquisition-v1-router.ts`, the focused
  `acquisition-*-router.ts` files, and mount point in `backend/src/server.ts`.
- Contract builder: `backend/src/acquisition-openapi.ts`.
- Frontend: `frontend/src/acquisition/` and the `#acquisition` shell route.
- Worker entry: `backend/src/prospect-worker-entry.ts` for the older prospect
  execution queue integrated with the same CRM store.

## Dependencies

Provider catalog/connections and public-source adapters, model gateway/tool
ports, tenant workspace context, CRM conversion ports, encrypted credential
services, MySQL repositories/named locks, Growth finance and ROI projections,
and generated acquisition contract types.

## Database Tables

Core families include `acquisition_plans`, `acquisition_plan_versions`,
`acquisition_runs`, `acquisition_operation_shards`,
`acquisition_discovery_evidence`, `acquisition_candidates`, identity aliases,
qualification/review/outcome/audit tables, provider operation tables, Douyin
comment/visual reader tables, and acquisition cohort/cost/allocation/ROI
tables. DDL is split across `acquisition-mysql-repositories.ts`, focused
`*-mysql-repository.ts` modules, and `mysql-store.ts`.

## Public Interfaces

Authenticated `/api/v1/acquisition/*` routes cover plans, runs, presentation,
candidates, evidence, reviews, outcomes, performance, providers/connections,
operations, visual-reader sessions/artifacts, copilot, and advisor projections.
The editable contract is `contracts/openapi/ai-acquisition.v1.yaml`; frontend
code consumes `frontend/src/generated/ai-acquisition.ts`.

## Tests

- Focused domain/runtime: `pnpm --filter ./backend test:acquisition`
- Contract parity/security: `pnpm check:acquisition-contracts`
- Frontend aggregate: `pnpm --filter ./frontend test`
- Browser flows: `pnpm test:e2e`

## Operational Checks

Use MySQL tests for transaction, restart, lease, and recovery claims. Provider
smokes require explicit local credentials; the Douyin live smoke is
`pnpm --filter ./backend smoke:douyin-public-comments`. Run the contract gate
after any route or DTO change and inspect logs for identifiers only, never raw
customer/comment text or credentials.

## Known Limitations

Memory mode does not prove durable recovery. Generic search is not guaranteed
to provide Douyin coverage, and authorized visual reading is intentionally
bounded to the visible, consented surface. Live-provider success cannot be
claimed without configured provider connections. Reserved schemas without
published routes remain non-interfaces.
