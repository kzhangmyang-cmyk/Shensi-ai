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
generated acquisition contract types, and the optional private
`services/media-crawler` Douyin login sidecar. The sidecar is enabled only when
the backend receives both `MEDIACRAWLER_BASE_URL` and
`MEDIACRAWLER_SERVICE_SECRET`.

## Database Tables

Core families include `acquisition_plans`, `acquisition_plan_versions`,
`acquisition_runs`, `acquisition_operation_shards`,
`acquisition_discovery_evidence`, `acquisition_candidates`, identity aliases,
qualification/review/outcome/audit tables, provider operation tables, Douyin
comment/visual reader tables, and acquisition cohort/cost/allocation/ROI
tables. DDL is split across `acquisition-mysql-repositories.ts`, focused
`*-mysql-repository.ts` modules, and `mysql-store.ts`.

Douyin account login additionally uses `acquisition_social_accounts`,
`acquisition_social_account_sessions`, and
`acquisition_social_account_replays`. Replay rows are a durable leased,
fenced `pending`/`completed` state machine containing the semantic request
hash, exact response status/body/headers, timestamps, and expiry. MySQL
transactions commit a login session or disconnect together with its completed
replay; an expired lease can be reclaimed after a process crash.

Douyin automation uses the append-only
`acquisition_douyin_automation_policy_versions` authority, a separately
mutable policy head, hashed command replays, and
`acquisition_douyin_run_intents`. Policy publication and run-intent creation
use one authority predicate for Memory and MySQL: the current plan/version plus
the workspace-scoped active account and login-state version must still match at
commit. MySQL takes the existing plan row lock before checking command replay,
so concurrent identical new keys yield one write and one exact replay. Run
intents freeze the plan, policy, account, local date, and daily-budget
identities consumed by the scheduler and crawler.

## Public Interfaces

Authenticated `/api/v1/acquisition/*` routes cover plans, runs, presentation,
candidates, evidence, reviews, outcomes, performance, providers/connections,
operations, visual-reader sessions/artifacts, copilot, and advisor projections.
The Douyin account family provides QR-session create/poll, workspace account
list, and disconnect. POST and DELETE require authentication, the browser CSRF
cookie/header pair, and semantic `Idempotency-Key`; DELETE also requires the
current `If-Match`. Account handles, browser contexts, cookies, and profile
paths remain private.
The Douyin automation family provides `GET`/`PUT`
`/plans/{planId}/automation` and `POST /plans/{planId}/run-now`. Policy writes
require `If-Match` and `Idempotency-Key`; run-now requires
`Idempotency-Key` and an explicit JSON body (an empty object is valid). At
least one of creator or demand-comment collection must remain enabled. GET
returns a non-persisted server default only before the first immutable version
is published. Exact command replays return the frozen original result, while
the same key with changed semantics—including a changed normalized
`If-Match`—conflicts.
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

For QR login, provision an encrypted-at-rest directory before starting the
sidecar. `MEDIACRAWLER_ENCRYPTED_VOLUME` must name an existing, non-symlink
directory with exact mode `0700`; `MEDIACRAWLER_PROFILE_ROOT` must be inside
it. The sidecar corrects owned profile directories to `0700` and metadata to
`0600`. Playwright and every browser context live in one owned child process
group;
startup, commands, and shutdown are bounded, and a timed-out command hard
terminates that process. Graceful ASGI shutdown closes live browser handles
but retains safe active metadata/profile state for restart. Only explicit
disconnect or expiry deletes valid state. During reload, the sidecar treats
invalid, missing, malformed, symlinked, or unreadable metadata as quarantined
and deletes the affected profile instead of reconstructing a session.

## Known Limitations

Memory mode coordinates account and automation replays only inside one
application process and does not prove crash/restart recovery; production
account and automation idempotency require MySQL. Generic search is not guaranteed
to provide Douyin coverage, and authorized visual reading is intentionally
bounded to the visible, consented surface. Live-provider success cannot be
claimed without configured provider connections. Reserved schemas without
published routes remain non-interfaces.
