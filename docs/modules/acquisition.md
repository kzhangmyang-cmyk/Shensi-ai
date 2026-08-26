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
`MEDIACRAWLER_SERVICE_SECRET_FILE`. That gateway enables collection only;
external outreach additionally requires
`DOUYIN_OUTREACH_ACTIONS_ENABLED` to be case-insensitively exactly `true` at
both backend and sidecar.

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
candidate budget. Each acquisition run and its authoritative automation intent
are validated as one pair before either alias can join that job. An exact pair
replay returns the existing job without a write; a run or intent reused in a
different pair fails closed. Every new pair increments `aliasGeneration`, and
`projectedAliasGeneration` identifies the latest pair set already projected.
Random 64-hex lease tokens and a monotonic fencing token reject exact-expiry,
stale, and same-worker ABA writes; the result cursor and its non-reusable history
advance only in the Node transaction that persists records. Frozen creator/
comment collection flags are enforced at both the sidecar normalization boundary
and repository persistence boundary. Terminal records retain their own input
page cursor even after the terminal job cursor becomes null. Comment records
derive a stable public actor from real MediaCrawler author fields and persist
`commenter`, while creator records persist `creator`; an empty or root Douyin
identity is invalid. The private runner captures only these bounded public actor
fields before upstream's general JSONL anonymization, and never turns
`creator_hash` into a profile URL.
The sidecar publishes complete immutable pages during a running crawl. The Node
worker pulls every advertised page, persists records and cursors first, then
idempotently projects available evidence, candidates and `candidate.discovered`
events while the authoritative run remains `running` with `completedAt: null`.
Every runner invocation confines its request, activity snapshot, and JSONL reads
to a random owner-only `0700` attempt directory below the job output root. A
resumed manager seeds record de-duplication from IDs in already persisted pages,
so it neither consumes stale attempt files nor republishes an existing record.
Live projection failure cannot erase the page; terminal ingestion replays all
persisted records. A sidecar interruption after any published record produces a
`partial` terminal job with those records and its bounded failure code intact.
Candidate-budget truncation remains durable across later pages and also ends as
`partial`. Late same-day authoritative pairs reopen only terminal ingestion and
project already persisted facts into the newly bound run without recrawling. An
exact pair replay does not reopen a succeeded projection. A pair added during a
running ingestion increments the generation and resets that generation's retry
budget without clearing the active lease; the current owner detects the change
and releases the job back to pending. A paused sidecar status records its last
safe activity, releases the crawl fence through retryable requeue, and resumes
on a later claim instead of polling and renewing forever. Crawler and ingestion
claims alternate under load and prefer another workspace when one is ready.

The worker performs a read-before-create lookup for the deterministic sidecar
job ID. A matching existing job is adopted, so restart recovery consumes its
retained pages instead of repeating the external crawl. The private gateway has
one narrow legacy compatibility rule: an activity-less `succeeded` or `partial`
descriptor is closed to `completed`, a null keyword, `headless`, and sequence
`1`. Live descriptors remain strict and must carry valid activity. Backend and
sidecar therefore move as one protocol unit; service health proves liveness,
not schema compatibility. Exhausting the backend retry budget leaves a crawler
job `paused`, and neither process restart nor lease sweeping requeues it. Only
an audited, workspace/job-scoped explicit requeue after compatibility validation
may resume that job.

Terminal jobs have a second random generation-bound ingestion claim. Its
transaction writes
`acquisition_discovery_evidence`, `acquisition_candidates`, candidate identity
aliases and audits through the existing acquisition domain repository, then
writes acquisition-run status and `candidate.discovered` events through the
existing plan-run repository. `acquisition_douyin_crawler_evidence_index`
enforces workspace content uniqueness and cross-job stable-record
supersession; `acquisition_douyin_do_not_contact` permanently retains only the
one-way platform identity hash and minimum policy reason.

One serialized heartbeat renews the ingestion claim through domain projection
and sidecar acknowledgement; timer renewal and synchronous authority checks
share the same in-flight promise. The worker revalidates the lease and alias
generation before projection, after projection but before acknowledgement, and
after acknowledgement. A pre-ack generation change skips acknowledgement and
defers the job. A change during acknowledgement is caught by the post-ack check
or by generation-aware completion, so stale work cannot publish `ready`.
Successful completion advances `projectedAliasGeneration` only to the exact
claimed generation. A failed renewal prevents stale completion. Repository
writes and hydration accept only stable crawler error codes, unknown or raw
worker failures become the appropriate generic crawler/ingestion code, and the
legacy internal partial code projects publicly as `mediacrawler_partial`.

## Public Interfaces

Authenticated `/api/v1/acquisition/*` routes cover plans, runs, presentation,
candidates, evidence, reviews, outcomes, performance, providers/connections,
operations, versioned outreach batches and their ordered action outbox,
visual-reader sessions/artifacts, copilot, and advisor projections.

Plan `executionMode` separates the existing provider-operation runtime from
private MediaCrawler collection. An omitted value is the legacy-compatible
`generic` mode and continues to require non-empty provider snapshots,
operations and a trusted model snapshot. A `douyin_mediacrawler` create must
declare `targetPlatform: douyin`, send empty `providerConnections` and
`operations`, and omit or null `modelConnectionId`; the persisted Plan and its
authoritative acquisition Run carry `modelSnapshotRef: null`. This exception
does not weaken generic plan readiness. A MediaCrawler plan follows `POST
/plans`, `POST /plans/{id}/approval`, `GET`/`PUT
/plans/{planId}/automation`, and `POST /plans/{planId}/run-now`. The generic
`POST /plans/{id}/runs` endpoint rejects this mode rather than creating a
zero-shard run.

The Douyin account family provides QR-session create/poll, workspace account
list, and disconnect. POST and DELETE require authentication, the browser CSRF
cookie/header pair, and semantic `Idempotency-Key`; DELETE also requires the
current `If-Match`. Account handles, browser contexts, cookies, and profile
paths remain private.
The Douyin automation family provides `GET`/`PUT`
`/plans/{planId}/automation`, `POST /plans/{planId}/automation/keyword-suggestions`,
and `POST /plans/{planId}/run-now`. Operators can type and save automation
keywords without a public-search API or AI connection. Keyword suggestions are
a separate optional convenience that requires an active AI model; callers
provide no business, workspace, or model authority. The server derives the
current plan objective/ICP, resolves the active official model snapshot, and
returns at most twenty NFKC-canonical editable keywords plus that frozen
snapshot identity. Keyword suggestions require an empty JSON object and
`Idempotency-Key`: exact retries replay the durable result, while a changed
server-derived plan revision conflicts. Policy writes
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
workspace-bound persisted projection. Its required `activity` observation has a
bounded phase, visible/headless browser mode, monotonic sequence, and a keyword
that is either null or an exact member of the frozen job keywords with at most
100 Unicode code points. MySQL hydration, repository mutation, and public
projection each revalidate this rule and fail closed on malformed persisted
activity. The dashboard can therefore explain collection without receiving a
raw URL or private browser identifier. It excludes the private account handle,
lease, raw cursor, records, live sidecar state, profile path, cookie, header,
selector, CDP/WebSocket endpoint, raw log, and raw ingestion state. Its
required `candidateProjectionState` is the closed `pending`, `ready`, or
`failed` summary of candidate projection: a successful or partial crawl remains
`pending` until terminal ingestion resolves, and paused, cancelled, or failed
crawls are `ready` because no later terminal projection is scheduled. In local
visible mode, the dedicated tab is a separate best-effort operator observation
mirror for the approved keyword and public video; it does not reuse the
collector page. At most one unfinished observation task runs outside the search
and comment collector's critical await path; a hung task can suppress later
mirror navigation but cannot block collection or create an unbounded backlog.
The deterministic MediaCrawler request client remains the data authority, and
observation navigation cannot fabricate results.

The crawler-status `lastErrorCode` is null or a stable runtime allowlisted code.
Repository hydration and every crawler/ingestion failure mutation replace an
unrecognized or exception-derived value with a generic stable code; the public
projection maps the private legacy partial value to `mediacrawler_partial`.
Raw exception messages, URLs, credentials, and sidecar diagnostics are not
public error values. The OpenAPI field remains a bounded string rather than a
generated enum, so this runtime normalization is enforced by the backend.

The authenticated browser consumes these generated projections through
`douyin-automation-api.ts` and `outreach-batch-api.ts`; feature code does not
redeclare transport DTOs. Bounded field-level validation details from failed
plan requests are preserved by the transport error and the first field path
and reason are shown to the operator; malformed detail objects are discarded.
Outreach-batch creation publishes controlled errors for an ineligible
candidate, changed evidence, unavailable active model, provider throttling or
an invalid model draft. Provider response bodies and arbitrary exception
messages remain private. The browser accepts both the standard nested error
envelope and the batch routes' root-level `code`/`message` envelope, while
discarding non-string error values.
The `#acquisition` workspace preserves the existing
Shensi shell and session controller, presents QR connect/reconnect, editable
keywords, local schedule/timezone and the 1–200 daily limit (default 50), then
shows the persisted crawler observation (phase, browser mode, keyword, attempt,
localized update time and candidate allowance), creator/commenter candidates, public
evidence, DNC/exclusion state, exact comment/direct-message drafts and
sanitized receipts. Approval always requires an explicit second confirmation.
An ETag conflict reloads the latest revision before another approval attempt,
and logout, close or mode change aborts active requests and the single poller.
The task overview retains the latest authoritative run and separately publishes
`latestResultRunId`, the newest run with persisted candidate links. The newest
run continues to own the displayed task status. On controller load, including a
browser refresh or verified-session restoration, a stopped zero-result latest
run falls back only for candidate review to `latestResultRunId`; otherwise the
latest run ID becomes the independent `activeRunId` used to reload crawler
status and the run's candidate page. `activeRunId` is not a reconstructed
run-now intent; it is also the run authority used when the operator creates an
editable, pending-approval outreach batch from recovered candidates. It blocks
another run while recovery has not yet confirmed persisted status, while a
current intent has no first persisted observation, while its observed crawler
state is nonterminal, or while candidate projection is `pending`. Every refresh
validates crawler status before reading the candidate page. Live-projected
candidates may appear while the crawl is nonterminal or projection remains
`pending`; a validated `ready` status is the ordering boundary for the final
candidate read. A terminal `ready` response with zero candidates is valid, and
a candidate-read failure retains the validated terminal status while receiving
at most three exponentially backed-off retries. Success, run change, closure,
or exhaustion stops that retry loop. Paused, failed, and cancelled crawler jobs
project the matching recognizable state into every still-active authoritative
run alias. Restoring an acquisition run is observational: that restore alone
does not create or approve a batch and never submits a comment or direct message;
those external actions remain behind explicit second confirmation, the exact
backend/sidecar action flag, and the separate fenced executor. The real-customer
trial defaults that flag to false: drafts remain editable/reviewable, but final
approval returns `503 outreach_actions_disabled`, creates no actions, and sends
nothing. A specific trial may enable both processes only after explicit user
authorization and a global all-zero audit of `queued`,
`blocked_by_predecessor`, and `executing`. In that mode, the page's second
approval confirmation is the send authorization: approval atomically queues the
comment and predecessor-blocked direct message, and the worker may claim the
comment immediately after commit.
Only candidates whose persisted public evidence points to an exact
`https://www.douyin.com/video/{id}` URL can enter the comment-then-message
approval flow. Profile-only creator candidates remain clickable for evidence
inspection, while their outreach checkbox is disabled and labelled
`仅查看证据 · 缺少可评论视频`; inspecting a row never selects it for outreach.
The MediaCrawler creator capture retains the source `aweme_id`: normalization
uses that exact video as evidence while keeping `/user/{sec_uid}` as the direct-
message profile. If a candidate accumulates multiple evidence rows, both the
run feed and batch authority sort the frozen evidence IDs and prefer a valid
video. Legacy profile-only evidence remains inspectable but is never promoted
to a comment target; a fresh collection is required to obtain the missing
source-video binding.
The backend repeats
the exact video/profile target validation during batch creation, revision, and
final approval; invalid targets create no approval or action rows.
`#acquisition` and authenticated real-mode `#conversations` share this same
server batch, revision, approval, action, and receipt authority. The
conversations route is a public-evidence controlled outreach workspace, not an
official Douyin inbox or private-message thread. Selecting an eligible public
interaction calls
`GET /api/v1/acquisition/outreach-batches?runId={runId}&candidateId={candidateId}&limit=1`;
the latest returned head is then loaded through the batch GET. An empty list
permits creation of exactly one pending batch containing that candidate only.
Reload repeats overview → candidate page → candidate-scoped collection GET →
batch GET, so server `runId + candidateId` ownership, not session selection
order, recovers revisions and receipts. Profile-only evidence remains readable,
but does not call batch discovery and cannot create a comment batch.
The decoder accepts crawler state, activity phase, browser mode, and projection
state only as primitive strings in their closed enums. The candidate response is
also a closed trust boundary: the page is exactly `{items,nextCursor}`, each
item is exactly `{id,status,displayName,evidence}`, and evidence is exactly
`{sourceUrl,excerpt}`. A page contains at most 100 items. Candidate ID and status
are nonempty primitive strings, display names contain at most 200 Unicode code
points, excerpts at most 500, and a non-null cursor is nonempty and at most
8,192. The source URL must have a literal case-insensitive `http://` or
`https://` authority prefix and a hostname, contain no username/password,
backslash, Unicode whitespace, control/format character, or malformed percent
escape, and must not depend on URL-parser authority repair. Uppercase schemes
and Unicode path/query text remain valid. Extra page, candidate, or evidence
fields and any malformed member fail the complete read rather than yielding a
partial candidate set. The pre-status queued placeholder announces politely
once per outstanding run and is silent on same-run rerenders; status, no intent,
or a new run resets its token. These safeguards do not change comment or direct-
message approval rules.
The authorized public-link importer remains available only as a collapsed
fallback. Desktop renders a candidate table beside its inspector; mobile uses
one-column cards with document scrolling and no horizontal overflow.

The real-mode primary action is `新建抖音采集计划`. It focuses this
MediaCrawler form and must not list or validate public-search/model
connections. The lower `公开搜索增强（可选）` entry alone opens the legacy-
compatible generic wizard; those provider and tool-calling-model dependencies
are requirements of that optional execution mode, not prerequisites for
Douyin MediaCrawler collection. The wizard includes a no-API return action to
the primary form. Its AI-plan control stays disabled until both dependencies
are available and must not submit a request that is already known to fail. A
server-side `SEARCH_PROVIDER_CONNECTION_REQUIRED` race is rendered as this
same MediaCrawler guidance rather than a raw internal error code.

Outreach generation is a private service boundary consumed only by the batch
service. `POST /runs/{runId}/outreach-batches` persists its exact values as
candidate draft revision 1. Generation does not persist a draft or batch until
every selected candidate validates; the separate model-call audit ledger is
persisted for both successful and failed provider attempts.
It loads only persisted workspace-owned candidates and their exact evidence,
parses normalized refusal and age phrases again before any model call, uses the
active official snapshot with closed structured output, and validates one-line,
bounded comment/direct-message text. Only fixed safe template clauses may be
ungrounded; every other complete clause must occur in one approved evidence
record. The versioned model contract tells providers to copy evidence phrases
verbatim, enumerates the only permitted evidence prefixes and safe template
clauses, and closes `rationaleCodes` to `evidence_grounded`,
`public_need_signal`, and `manual_review_required`. The same constants drive
the final validator and the tool schema, so provider guidance cannot drift from
the server authority. If otherwise well-formed model prose fails only this final
grounding validation, the service first completes the atomic final-authority
check, then assembles a conservative review draft from one bounded exact segment
of the currently verified public evidence and the same fixed safe clauses. That
fallback is also required to pass the unchanged final validator, carries
`evidence_grounded` plus `manual_review_required`, and remains a pending human-
approval draft; it never approves or executes outreach. Gateway/tool-shape,
DNC, tenant, evidence-authority, and unsafe-content failures are not converted
into drafts, and no safe evidence segment still fails closed. Evidence rows are
never concatenated. URLs, Unicode/IDN/punycode
domains recognized by the pinned ICANN public-suffix data, phone numbers,
forbidden claims/words, and malformed output are rejected. Grounded dotted
product/technology names whose final label is not an ICANN suffix are allowed.
The application composes this service from the real domain and DNC repositories.
Memory verification shares the DNC writer's transaction coordinator; MySQL
locks the exact candidate, evidence rows, and DNC key/gap and loads them through
one connection. Custom repositories must inject an
`AcquisitionOutreachFinalAuthority` implementation with the same tenant-scoped
atomic guarantees. Without that port, unrelated application startup remains
available but Task 6 draft generation fails before model traffic. The returned
authority projection is deeply immutable. The server recomputes the immutable
content hash and discards raw model output; Task 6 does not persist drafts or
create a competing revision ledger.

The public batch family provides candidate-scoped collection GET, create, read,
`PUT` revision, approve, reject, pause, resume, action-list, and exact-action
read-only reconciliation routes. The
collection GET requires `runId` and `candidateId`, accepts limit 1–50 plus an
opaque filter-bound cursor, returns only current head revisions in stable
descending order, and requires the outreach-approval capability without CSRF
or idempotency headers. Every mutation is authenticated,
CSRF-protected for cookie sessions, capability-gated by
`acquisition.outreach.approve`, and semantically idempotent; revision-bound
mutations also require the current `If-Match`. A human edit is validated by
the same Task 6 message validator, keeps the source model snapshot, recomputes
content hashes, and creates draft revision 2 inside a new immutable batch
revision. Approval and every lifecycle transition rotate the response ETag,
so a pre-transition `If-Match` cannot authorize later state changes. In an
explicitly action-enabled runtime, approval is the required human second
confirmation of the supplied revision and batch hash. It rechecks account/login,
candidate revision, evidence membership/hashes, DNC, the actual selected policy
limit, and exact Douyin video/profile action targets before atomically recording
the approver and exact content. It
creates, but does not execute, one `comment` action with sequence 1 and status
`queued`, followed by one `direct_message` action with sequence 2 and status
`blocked_by_predecessor` per selected candidate. Memory uses the shared
reentrant authority coordinator; MySQL locks the account and reuses one
connection for candidate/evidence/DNC locks, approval, replay, daily-limit
reservation, and both action inserts. A nested authority transaction on that
pre-bound connection restores and tenant-checks the ingestion scope before any
candidate/evidence/DNC lock. When the flag is missing or false,
approval returns `503 outreach_actions_disabled` before approval, replay,
allowance, or action persistence; this is not a dormant approved outbox.

The application constructs and starts its action recovery sweeper and claim
worker only when the private gateway is configured and the action flag is
exactly enabled. The deployment sidecar likewise constructs no
`ActionJobManager` while disabled and rejects the action route before manager or
executor lookup; its crawler worker remains available. When enabled, the action
worker claims the earliest eligible action under a random lease and monotonic
fence, with one in-flight action per account. Before the private sidecar call it
rechecks the active account/login version, approval and action
hashes, candidate revision/evidence hashes, DNC, policy/job/budget bindings,
predecessor receipt, daily allowance, and persisted delay. Server timestamps
enforce at least 60 seconds between any account actions and 180 seconds from a
comment receipt to its matching direct message across restart or clock skew.
The sidecar receives only the frozen public video/profile URL and exact
approved text, reuses the account's authenticated browser profile, submits
once, and returns a sanitized platform receipt reference. MediaCrawler upstream
provides the collection/browser foundation; comment and private-message
execution is a Shensi extension and is not an official inbox or upstream-
native action API. In visible mode, CAPTCHA, slider, login verification, and
platform warnings permit only a bounded wait for the user to complete the
challenge, followed by full revalidation of the same action. There is no
solver, token injection, alternate write path, or bypass service. The current
defaults are 120 seconds for manual verification, 150 seconds for the Node
action deadline, 160 seconds for gateway HTTP, 170 seconds for browser-action
IPC, and a 180-second minimum claim lease. Timeout remains a closed
`risk_paused` result rather than authorizing a new action. Direct messages start
at the canonical frozen `/user/{id}` page and support only a unique visible
same-page panel, Draft editor, and send button. Native keyboard input must
round-trip exactly; receipt proof must be a new self/outgoing stable-ID message
with an allowlisted platform timestamp after the durable action start. An
unbound `/messages` route transition or ambiguous DOM fails closed. Other verification,
rate-limit, account-warning, login-expiry, missing-control, and timeout states
are closed failures; no alternate selector or bypass route is attempted. A
comment receipt remains succeeded if the later message fails. Three
consecutive failures, and immediate account-risk failures, persistently pause
the account and all its queued work. Expired external-write claims and uncertain
outcomes are moved to `risk_paused`, never swept for replay, and stale
completions cannot overwrite the current fence. The page offers an explicit
operator checkbox for strictly read-only reconciliation of that same frozen
action. Unique post-start proof can mark only it succeeded; no proof stays
frozen, and the account/successor are not automatically resumed.

## Tests

- Focused domain/runtime: `pnpm --filter ./backend test:acquisition`
- Focused outreach actions (live MySQL when configured):
  `pnpm --filter ./backend test:acquisition-outreach-actions`
- Contract parity/security: `pnpm check:acquisition-contracts`
- Frontend aggregate: `pnpm --filter ./frontend test`
- Browser flows: `pnpm test:e2e`

## Operational Checks

Use `pnpm test:task10:mysql` for the isolated live-MySQL restart/race/rollback
gate and `pnpm test:task10:browser` for the deterministic no-route-interception
browser flow. Use MySQL tests for transaction, restart, lease, and recovery claims. Provider
smokes require explicit local credentials; the Douyin live smoke is
`pnpm --filter ./backend smoke:douyin-public-comments`. Run the contract gate
after any route or DTO change and inspect logs for identifiers only, never raw
customer/comment text or credentials.

For QR login, provision an encrypted-at-rest directory before starting the
sidecar. `MEDIACRAWLER_ENCRYPTED_VOLUME` must name an existing, non-symlink
directory with exact mode `0700`; `MEDIACRAWLER_PROFILE_ROOT` must be inside
it. `MEDIACRAWLER_CRAWL_OUTPUT_ROOT` must be absolute, already exist, be a
non-symlinked current-user-owned directory with exact mode `0700`, and resolve
strictly inside but not equal to that encrypted volume. The runner resolves it
once and uses the same root for attempt/job creation and acknowledgement
cleanup; deployment never writes to the source-local compatibility directory.
`MEDIACRAWLER_SERVICE_SECRET_FILE` must name a non-symlinked, owner-only,
newline-free secret file of at least 32 bytes; a raw secret environment value
is rejected. The sidecar corrects owned profile directories to `0700` and metadata to
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
The browser launch mode is configured by `MEDIACRAWLER_BROWSER_HEADLESS` and
optional `MEDIACRAWLER_BROWSER_CHANNEL`. Local real-QR acceptance uses visible
installed Chrome (`false` / `chrome`) in a dedicated standard-Playwright
Douyin window because Douyin can replace the QR with a verification interstitial
in headless mode. Shensi explicitly disables CDP; production may set
`MEDIACRAWLER_BROWSER_HEADLESS=true`. Login creation has a dedicated
35-second gateway deadline and the adapter waits up to 25 seconds for a cold-
start QR; short health and polling deadlines are unchanged. A displayed QR is
not account authority: only the private browser session observing an actual
authenticated state publishes a connected account.
Running and terminal crawler pages are immutable and replayable by opaque
cursor. Node consumes only the sidecar-advertised page count, persists each
page before live projection, and sends a durable acknowledgement only after the
terminal evidence/candidate/run-link projection succeeds under the current
alias generation. A terminal activity returned by crawl startup is never saved
as a nonterminal update; the completed activity, final descriptor, terminal
state, and crawl-lease release commit only with the advertised `done` page. The
ingestion worker keeps one serialized heartbeat active and verifies its fence
before projection, before acknowledgement, and after acknowledgement. The
acknowledgement timestamp, not a read or crawl completion, starts the 24-hour
cleanup clock.
The sidecar sweeps an acknowledged job's entire output root, including every
attempt directory and private upstream capture, at startup and periodically,
and uses one bounded deadline to stop its sweeper and all active crawl workers.
Failed/cancelled terminal metadata with no result pages may be removed 24 hours
after completion. Backend cleanup
removes unlinked crawler evidence 90 days after ingestion while preserving
linked evidence, DNC identity hashes, and audit events.

The authenticated `#acquisition` route is the real persisted collection
surface. It shares the product shell with visible browser-local and pending
integrations; those surfaces use `预览 · 待接入` and must not be interpreted as
acquisition results. The authoritative live/preview matrix and isolated trial
lifecycle are maintained in `docs/operations/real-customer-trial.md`.

The platform carousel precedes the selected platform workspace. Douyin is the
only enabled real acquisition card; Kuaishou, Xiaohongshu, Weibo, and WeChat
remain visible as dark `待接入` cards. Pointer, wheel, drag, and keyboard
navigation skip those disabled cards, so a pending integration cannot replace
the selected real Douyin context or expose hidden demo task detail. In real
mode the selector owns a full-width decision row, the real task list follows
it, and the selected platform workspace follows the task list. Mid-sized
desktop layouts hide the secondary inspector so all five cards remain visible
without changing the product's dark visual system.

For a trial-disabled action check, leave
`DOUYIN_OUTREACH_ACTIONS_ENABLED=false`, confirm crawler status still advances,
confirm final batch approval returns the stable 503, and confirm no queued test
fixture is claimed. For an explicitly authorized action trial, first confirm the
global action table has no `queued`, `blocked_by_predecessor`, or `executing`
work, then use the supervisor's one-shot
`--enable-outreach-after-empty-audit` flag so both processes receive the same
effective gate. Ambient or retained true values are ignored by the trial
supervisor. Do not enable the flag merely to pass trial acceptance.

For an incompatible backend/sidecar runtime, treat `crawler_worker_failed` as a
closed boundary failure rather than evidence that no records were collected.
Stop new dispatch, preserve the encrypted sidecar state and unacknowledged
pages, restart both processes from one revision, and use a sanitized read-only
job/status check. If the Node job is paused at its attempt limit, use only the
reviewed explicit requeue path. The worker must adopt the existing sidecar job,
project retained records, and perform the normal acknowledgement; do not delete
the job, manually acknowledge it, reset unrelated data, or create a new run to
force another crawl. Logs and reports include bounded counts and stable codes,
never raw collected text, account handles, credentials, browser profiles, or
private paths.

## Known Limitations

Memory mode coordinates account, automation, and outreach approval only inside one
application process and does not prove crash/restart recovery; production
account, automation, and outreach idempotency require MySQL. Generic search is not guaranteed
to provide Douyin coverage, and authorized visual reading is intentionally
bounded to the visible, consented surface. Live-provider success cannot be
claimed without configured provider connections. Reserved schemas without
published routes remain non-interfaces.
