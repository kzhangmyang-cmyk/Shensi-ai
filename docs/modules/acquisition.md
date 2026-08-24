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
`acquisition_douyin_run_intents`. `acquisition_douyin_run_bindings` maps each
automation intent to a distinct authoritative row in `acquisition_runs` for
the same frozen approved plan/version/hash. Policy publication and run-intent creation
use one authority predicate for Memory and MySQL: the current plan/version plus
the workspace-scoped active account and login-state version must still match at
commit. Memory composition gives plan, social-account, and automation
repositories one transaction coordinator: a short-lived token covers authority
validation and policy/run-intent persistence, so account/login or plan changes
cannot interleave. MySQL takes the existing plan row lock before checking
command replay, so concurrent identical new keys yield one write and one exact
replay. Run creation commits the authoritative run, queued event, audit,
intent, binding, and replay atomically. Run intents freeze the plan, policy,
account, local date, and daily-budget identities consumed by the scheduler and
crawler; intent IDs are never used as acquisition run IDs.

Crawler execution uses `acquisition_crawler_jobs`, authoritative
`acquisition_crawler_job_runs`, separate `acquisition_crawler_job_intents`, and
append-only `acquisition_crawler_job_records` plus unique cursor-history rows. Jobs are
persisted as `scheduled` before the idempotent enqueue transition makes them
claimable. A unique daily key makes scheduled and run-now triggers share one
candidate budget. Random 64-hex lease tokens and a monotonic fencing token
reject exact-expiry, stale, and same-worker ABA writes; the result cursor and
its non-reusable history advance only in the Node transaction that persists
records. Frozen creator/comment collection flags are enforced at both the
sidecar normalization boundary and repository persistence boundary. Terminal
records retain their own input page cursor even after the terminal job cursor
becomes null. Comment records derive a stable public actor from real
MediaCrawler author fields and persist `commenter`, while creator records
persist `creator`; an empty or root Douyin identity is invalid. The private
runner captures only these bounded public actor fields before upstream's
general JSONL anonymization, and never turns `creator_hash` into a profile URL.
Late same-day aliases reopen only terminal ingestion and project already
persisted facts into the newly bound authoritative run without recrawling.
Crawler and ingestion claims alternate under load and prefer another workspace
when one is ready.
Terminal
jobs have a second random fenced ingestion claim. Its transaction writes
`acquisition_discovery_evidence`, `acquisition_candidates`, candidate identity
aliases and audits through the existing acquisition domain repository, then
writes acquisition-run status and `candidate.discovered` events through the
existing plan-run repository. `acquisition_douyin_crawler_evidence_index`
enforces workspace content uniqueness and cross-job stable-record
supersession; `acquisition_douyin_do_not_contact` permanently retains only the
one-way platform identity hash and minimum policy reason.

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
`/plans/{planId}/automation`, `POST /plans/{planId}/automation/keyword-suggestions`,
and `POST /plans/{planId}/run-now`. Keyword suggestions take no caller business,
workspace, or model authority: the server derives the current plan objective/ICP,
resolves the active official model snapshot, and returns at most twenty NFKC-canonical
editable keywords plus that frozen snapshot identity. Policy writes
require `If-Match` and `Idempotency-Key`; run-now requires
`Idempotency-Key` and an explicit JSON body (an empty object is valid). At
least one of creator or demand-comment collection must remain enabled. GET
returns a non-persisted server default only before the first immutable version
is published. Exact command replays return the frozen original result, while
the same key with changed semantics—including a changed normalized
`If-Match`—conflicts.
The run-now response contains `id` for the automation intent and
`acquisitionRunId` for the authoritative run. Crawler status and candidate
routes take the latter. `GET /api/v1/acquisition/runs/{runId}/candidates`
returns 404 for a non-authoritative or foreign run ID and reads only persisted
run-candidate links. Run IDs are bounded to the authoritative 160-character
storage width. Its default feed excludes permanent DNC candidates, as do the
general candidate and priority-candidate feeds; explicit DNC-status reads are
reserved for audit/review paths.
The editable contract is `contracts/openapi/ai-acquisition.v1.yaml`; frontend
code consumes `frontend/src/generated/ai-acquisition.ts`.
`GET /api/v1/acquisition/runs/{runId}/crawler-status` returns only the closed,
workspace-bound persisted projection. It excludes the private account handle,
lease, raw cursor, records, and live sidecar state.

Outreach generation is a private service boundary until Task 7 creates a batch.
It loads only persisted workspace-owned candidates and their exact evidence,
rejects DNC/refusal/complaint/minor signals again before any model call, uses the
active official snapshot with closed structured output, and validates one-line,
bounded, evidence-grounded comment/direct-message text. URLs, phone numbers,
forbidden claims/words, unsupported claims, and malformed output are rejected.
The server recomputes the immutable content hash and discards raw model output;
Task 6 does not persist drafts or create a competing revision ledger.

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
but retains safe active metadata/profile state for restart. QR-session expiry
deletes only an unconnected login attempt; a connected account has independent
durable metadata and is removed only by explicit disconnect or replacement.
Malformed, symlinked, or unreadable durable account metadata is quarantined;
missing or malformed ephemeral QR metadata does not invalidate a valid
connected account.
Terminal crawler pages are immutable and replayable by opaque cursor until
Node atomically persists authoritative evidence/candidates/run links and sends
a durable acknowledgement. The acknowledgement timestamp, not a read or crawl
completion, starts the 24-hour cleanup clock. The sidecar sweeps acknowledged
pages and the corresponding private upstream capture at startup and
periodically, and uses one bounded deadline to stop its sweeper and all active
crawl workers. Failed/cancelled terminal metadata with no result pages may be
removed 24 hours after completion. Backend cleanup
removes unlinked crawler evidence 90 days after ingestion while preserving
linked evidence, DNC identity hashes, and audit events.

## Known Limitations

Memory mode coordinates account and automation replays only inside one
application process and does not prove crash/restart recovery; production
account and automation idempotency require MySQL. Generic search is not guaranteed
to provide Douyin coverage, and authorized visual reading is intentionally
bounded to the visible, consented surface. Live-provider success cannot be
claimed without configured provider connections. Reserved schemas without
published routes remain non-interfaces.
