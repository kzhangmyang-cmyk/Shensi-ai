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
- Customer-linked Todo HTTP regression: `pnpm --dir backend test:crm-todos`
- Frontend controller/view aggregate: `pnpm --filter ./frontend test`
- Real shell primary-action browser regression: `pnpm --dir frontend test:real-primary-actions`
- Full root gate: `pnpm test`
- Browser acceptance: `pnpm test:e2e`

## Operational Checks

Persistent behavior requires `CRM_STORE=mysql` and a real MySQL instance.
After schema or handoff changes, verify tenant visibility, audit/event writes,
acquisition conversion idempotency, deal/quote authority, and `/api/health`.

## Frontend Interaction

An acquisition candidate enters CRM through **核对并交接私域** in the
Acquisition evidence inspector or any Social Conversations candidate tab. This
opens the existing focused candidate detail with its real Plan, candidate, and
source Run IDs. Unrelated latest-run zero statistics and empty states are not
shown in this view. The historical discovery event is read from the specified
Run's presentation, not inferred from the current Plan's newest Run. This is a
frontend source pin, not a replacement for the server's scope, frozen snapshot,
and persisted evidence checks. Opening does not resume a browser reader,
qualify, approve, or create a customer automatically. The user completes
qualification and human review, then explicitly creates a customer or links an
existing scoped customer with a first follow-up task. Comment or private-message
success is not a prerequisite; this next step remains visible before approval.
`/convert` alone creates a Lead, not a customer.

The handoff retains the immutable Run discovery and qualification snapshot.
Ordinary search uses `acquisition-run.v1`; persisted Douyin crawler discoveries
use `douyin-crawler.v1` and the real job ID. Crawler source validation resolves
the trusted workspace and checks the job/Run/Plan freeze, candidate evidence
ownership, and matching persisted public record. No provider shard, operation,
connection, or provider ID is fabricated. CRM reconciliation revalidates the
same source before recording an outcome; live individual outcomes retain their
identity rather than being treated as legacy migration records.

Opening **私域客户池** reads the authenticated customer's visible CRM records
without selecting one automatically. The pool uses the full main workspace
until the user explicitly selects a row or arrives through a trusted deep link
that supplies a valid customer identifier. Only then does the right-side
inspector open. The inspector presents business fields such as the responsible
owner; internal customer identifiers remain in the application boundary and
are not rendered as a customer-facing fact.

**添加客户** opens the real customer form and calls the existing customer API.
Only a successful response refreshes the list and selects the new customer.
The inspector supports recording a follow-up, creating a customer-linked Todo,
and completing that Todo with an explicit result. Writes use the session CSRF
token and single-flight submission; failures retain the entered fields. Leaving
the page or selecting another customer fences late results from the old view.

`POST /api/todos` accepts `customerId` only after the same writable-customer
authorization used by other CRM writes. Cancelled Todos cannot be completed or
reopened through the completion or patch endpoints. Postponement is validated
before mutating the stored Todo, so an invalid reason cannot partially update it.

The real shell's primary actions use the current route: customer creation,
existing specialist chat, or preparation of a selected social candidate's draft.
**查看今日待办** waits for the real dashboard before focusing its Todo section;
it does not display a simulated success message.

## Known Limitations

Many CRM routes are registered in the large `server.ts` rather than isolated
routers, and their runtime Swagger is not the same artifact as the two
versioned contracts. Memory-mode data is process-local. The desktop login and
registration surface uses the real backend authentication routes; it does not
create or import CRM customers as a side effect of signing in.
