# CRM

## Responsibility

Owns customers, leads, deals, activities, tasks, reminders, reports,
commission records, outreach, trade documents, and the controlled handoff from
acquisition candidates into commercial records.

## Entry Points

- HTTP and application orchestration: `backend/src/server.ts`.
- Store boundary: `backend/src/store.ts`, `backend/src/mysql-store.ts`, and
  `backend/src/memory-store.ts`.
- Frontend shell: `frontend/src/app-session.ts`, with private-domain and
  conversion flows in `frontend/src/private-domain/` and shell modules in
  `frontend/src/replica-dashboard.ts`.
- Acquisition handoff ports: `backend/src/acquisition-lead-conversion-port.ts`
  and `backend/src/acquisition-private-domain-handoff.ts`.

## Dependencies

Identity/role guards in `auth.ts`, the active `CrmStore`, MySQL persistence,
email and messaging integrations, provider/acquisition projections, catalog
authority for commission products, and quote authority for commercial
decisions.

## Database Tables

`customers`, `customer_activities`, `leads`, `lead_activities`,
`lead_source_events`, `deals`, `deal_events`, `todos`, `plan_tasks`,
`plan_templates`, `reminders`, trade-document tables, and the
`commission_*`/`monthly_sales_records` families are created or upgraded by
`backend/src/mysql-store.ts`; the tracked baseline is
`backend/schema.mysql.sql`.

## Public Interfaces

Authenticated legacy runtime routes include `/api/customers`, `/api/leads`,
`/api/deals`, `/api/todos`, `/api/plan-*`, `/api/reminders`,
`/api/commission`, `/api/trade-documents`, `/api/dashboard`, and
`/api/reports`. `backend/src/swagger.ts` derives their runtime OpenAPI view.
Cross-domain Growth and acquisition DTOs remain governed by `contracts/`.

## Tests

- Backend CRM/security aggregate: `pnpm --filter ./backend test`
- Frontend controller/view aggregate: `pnpm --filter ./frontend test`
- Full root gate: `pnpm test`
- Browser acceptance: `pnpm test:e2e`

## Operational Checks

Persistent behavior requires `CRM_STORE=mysql` and a real MySQL instance.
After schema or handoff changes, verify tenant visibility, audit/event writes,
acquisition conversion idempotency, deal/quote authority, and `/api/health`.

## Known Limitations

Many CRM routes are registered in the large `server.ts` rather than isolated
routers, and their runtime Swagger is not the same artifact as the two
versioned contracts. Memory-mode data is process-local. The current login
surface is scheduled for replacement and should not be treated as the final
Shensi enterprise interaction.
