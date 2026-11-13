# Acquisition

## Platform subscription execution authority

Platform-managed workspaces require active enterprise status, a published plan
with the outreach feature, and a current subscription before server or desktop
outreach claims. The server checks again immediately before its external
execution call; desktop checks again before accepting `started`, including
replayed starts. MySQL repository checks read the current durable platform
state under a shared transaction lock. Memory composition injects its own
store state and never reads a process-global customer registry. An unavailable
authority closes new execution.

Denied queued actions remain waiting. If authority changes after a server claim
but before dispatch, only that fenced, never-sent claim is released without a
failure receipt. Existing account spacing still applies on recovery. Ordinary
receipts and read-only reconciliation keep their existing ownership, lease and
idempotency checks and can complete after suspension or expiry; they do not
resend a platform action. Already dispatched external requests cannot be
retracted by a later subscription change. Existing workspaces absent from the
platform management registry retain their prior authorization behavior.

Queued server crawls check current `acquisition` entitlement immediately before
starting a new browser job; denial pauses the job with
`crawler_execution_forbidden`. Desktop preparation, claim and renewal use the
same fresh check. Existing sidecar status/results, terminal-page uploads and
completion remain available under their original ownership and lease checks,
so revoked subscriptions do not lose already collected results. Running server
crawls are not proactively cancelled by this gate. Acquisition model requests
also recheck `acquisition` before every provider attempt.

The retained prospect execution kernel skips revoked workspaces before claiming
queued provider jobs, preserving their queue state. It rechecks current
`acquisition` authority at the prepared-request dispatch boundary; denial does
not create a provider dispatch or overwrite a retained response. Response
settlement remains independent of subscription authority. Legacy AI lead search
also selects `acquisition`, including custom-protocol model transports.

## Outreach timing and receipt semantics

Direct messages have no product-imposed ten-minute cooldown. Account-level serial execution, approval binding, idempotency, platform backoff and risk/reconciliation holds still apply. The existing sixty-second comment spacing is unchanged. A queued action is approved but has not run; approval is not delivery. Comment success is shown as a confirmed platform receipt, not a guarantee of continuing public visibility. Old fixed cooldowns may be cleared only when tied to the exact successful message claim and unchanged failure-free account state; never clear platform or risk delays as part of this policy change.

## Responsibility

Plans and executes evidence-backed prospect discovery, provider calls,
candidate identity/qualification, authorized Douyin visual ingestion, copilot
work, controlled CRM conversion, outcome reconciliation, cost allocation, and
ROI projections.

## Entry Points

The acquisition workbench restores the latest run, not the latest run with
candidates. Overview refreshes must not replace an in-session run or startup
error. Starting a run clears previous runtime status and candidate selection;
startup failures stay visible and do not dispatch the saved-plan refresh.
Historical candidates and sending receipts remain accessible in Social
Conversations. Cold desktop collection resolves the persisted local login
identity before launch, requiring the task's exact login version; explicit
revocation and stale connector/account responses remain rejected.

Douyin candidate discovery has no count quota. New jobs persist
`candidateBudgetLimit: null` in their JSON payload; page ingestion also marks
continuing jobs unlimited and never discards records based on candidate count.
Terminal historical payloads without that field keep their recorded quota and
partial/error result. No historical records or statistics are rewritten.
`dailyCandidateLimit` remains a legacy frozen approval-budget compatibility
field, not a discovery cap; sending approvals and frequency rules are unchanged.
The plan form exposes no candidate quota. Candidate readers page until the
server exhausts its cursor, with cancellation and cycle detection, not a fixed
number of pages. Source/video/page/time task boundaries and stop controls remain.

Douyin discovery defaults to demand comments, not creator prospecting. Optional
creator collection retains video-author evidence only and never admits an author
as a prospect from their video description. Comment candidates retain the
commenter's own profile and the original video/comment evidence. Existing
historical candidates and saved collection settings are not rewritten.
Nested comment `user` identity and nickname take precedence over surrounding
video fields; flattened adapter records remain supported. Price and
recommendation questions can enter research, but every newly ingested candidate
remains `needs_research`. Keyword-only comments do not prove purchase intent.

- Backend composition: `backend/src/acquisition-application.ts` and
  `backend/src/acquisition-runtime-bridge.ts`.
- HTTP routes: `backend/src/acquisition-v1-router.ts`, the focused
  `acquisition-*-router.ts` files, and mount point in `backend/src/server.ts`.
- Contract builder: `backend/src/acquisition-openapi.ts`.
- Frontend: `frontend/src/acquisition/` and the `#acquisition` shell route.
- Worker entry: `backend/src/prospect-worker-entry.ts` for the older prospect
  execution queue integrated with the same CRM store.

## Candidate handoff to CRM

**核对并交接私域** opens the existing candidate detail from Acquisition or
Social Conversations with the real candidate, Plan, and candidate Run IDs. The
focused candidate view omits unrelated latest-run summaries, lists, and empty
states; it does not rewrite those run statistics. Its discovery pin comes from
the matching candidate event in that Run's presentation, paging with bounded
and non-repeating cursors. Every page must return the requested Run ID; closed
or replaced requests cannot overwrite the pin. Opening this focused view does
not attach/resume a visual reader or poll an unrelated run. This focused handoff
loads only candidate, public evidence, source Run and existing handoff; it does
not request qualification, financial scoring, identity AI, battle cards or review history.
Public-profile-only candidates can enter this review flow; outbound comment or
DM success is not required. Replaced or closed detail requests cannot select a
candidate after a newer Plan has opened. Users verify the name/source and current
account ownership, then explicitly create/link a customer and first follow-up.
No AI decision or qualification approval is required; old failed AI records do
not block entry. **关闭** never submits. The existing handoff endpoint accepts
`handoff_acquisition_candidate_v2` with empty legacy `decisionVersion`; this
path never calls the approved lead-conversion or intelligence services. It
atomically persists customer, lead, follow-up, source event and handoff using
the existing storage transaction and candidate-scoped idempotency. Source
Run/job/evidence authority is still verified; cross-owner/team links reject.
Intelligence is null (not fabricated scores), and the source snapshot remains
in the scoped lead source event. Customer defaults are ordinary unassessed CRM
values. The original v1 scoring workflow remains for shared CFO operations;
direct customers use ordinary CRM commercial workflows, not fabricated
qualified-acquisition attribution. Incomplete historical handoffs must resume
their frozen request to avoid duplicate customers; historical AI failure alone
does not constitute an incomplete handoff. Comment/DM approvals are unchanged.

`AcquisitionCandidateRunAttributionResolver` supports two explicit sources.
Generic discoveries retain `acquisition-run.v1` and their original provider
shard checks. Existing `candidate.discovered` events with
`source: douyin_crawler`, a real `jobId`, and `shardId: null` resolve to
`douyin-crawler.v1`, including stored Runs without `executionMode`. The trusted
workspace directory, persisted job/Run/Plan snapshot, scoped candidate/evidence,
and matching record ID/hash/public URL/actor are required. Re-observed content
may retain its original evidence provenance across jobs; the new job must
contain the matching record. The crawler variant has null shard, operation,
connection and provider fields and empty provider/query arrays.

The application injects the same attribution resolver into handoff, outcome
recording and CRM reconciliation. A client-supplied crawler attribution is
revalidated before outcome writes. Handoff and outcome storage remains JSON;
no historical discovery event, approval or customer is rewritten. Run snapshots
and enriched live outcomes have separate contract definitions so commercial
snapshots do not require fabricated model-decision metadata.

## Dependencies

Provider catalog/connections and public-source adapters, model gateway/tool
ports, tenant workspace context, CRM conversion ports, encrypted credential
services, MySQL repositories/named locks, Growth finance and ROI projections,
generated acquisition contract types, and the optional private
`services/media-crawler` Douyin login sidecar. The sidecar is enabled only when
the backend receives both `MEDIACRAWLER_BASE_URL` and
`MEDIACRAWLER_SERVICE_SECRET_FILE`. That gateway enables collection only;
external outreach uses independent strict approval, server-execution, and
desktop-execution gates. If any canonical split key is present, all three must
be exact lowercase `true`/`false` and override the legacy value. When none is
present, the Web/Trial compatibility adapter maps
`DOUYIN_OUTREACH_ACTIONS_ENABLED` to approvals and server execution while
keeping desktop execution false. Server execution additionally requires the
gateway and fails startup without it. Browser action targeting is DOM/ARIA-first. The
optional local fallback is selected with
`DOUYIN_ACTION_VISUAL_LOCATOR=rapidocr`; the default is `disabled`, and any
other value is a startup/configuration error. Visual MCP is development-only
diagnostics and is never an action-runtime dependency. Model providers do not
own browser control or approval authority. The fresh `desktop:local` launcher
enables approvals and desktop execution only; the retained server executor stays
off. Main maps the exact HTTP 503 `desktop_execution_disabled` response to
“桌面执行尚未启用”, not a network failure, and can observe later gate activation.

A new outreach batch freezes the current active login version of the same
account that owns the finalized collection. The immutable crawler job retains
the source login version; a later login may produce a newly reviewed batch
without collecting the same public evidence again. Approval and execution still
require the exact frozen sender version, targets and evidence. Reconnecting
after batch creation does not rewrite or reactivate that batch: create a new
batch and confirm it separately. Sender versions older than the collection are
rejected. No source records, old approvals or action receipts are migrated.

Desktop claim uses the application's existing final-authority verifier through
`loadLockedCandidateAuthority`. The claim transaction owns the candidate,
evidence and do-not-contact locks; the application composition must supply this
loader as well as the ordinary read loaders. A missing locked loader rejects
the claim and is covered by the production-composition HTTP acceptance test.

The Sidecar has two explicit login runtimes. `SHENSI_RUNTIME_MODE=desktop`
selects `external_window`: Playwright opens a headed Chrome window on the local
desktop. `AccountManager` owns the API/business session and persistent
profile/identity metadata while `LocalBrowserSessionManager`, injected as its
BrowserState facade, exclusively owns the opaque worker/Context. The public
frontend only creates, polls/rechecks, or cancels that session. It neither
requests a live token nor mounts noVNC, and screenshots and QR extraction are
not login prerequisites. Desktop requests still pass through `AccountManager`,
but its global `RLock` protects only short session and authority state changes;
it is not held across launch, poll, execute, or reconcile browser I/O.
`SHENSI_RUNTIME_MODE=web` selects `remote_canvas` and
retains the Linux Xvfb/x11vnc/noVNC, `/live-sessions`, QR and JPEG compatibility
path. `MEDIACRAWLER_BROWSER_DISPLAY=operator|virtual` is a compatibility alias
and must agree with the canonical runtime mode.

Desktop state uses `SHENSI_USER_DATA_DIR` or the ignored default
`<repository>/.local-data`. The trusted backend derives a stable opaque
workspace key and sends it only to the Sidecar, which hashes it into a stable
profile directory. The public API exposes neither key nor profile path. After
LBSM detects authentication, it closes its login Context; `AccountManager` then
binds and persists the identity, and the same Profile is reused by the
MediaCrawler collection path. The separate Electron development packaging chain
exists. The Backend exposes the desktop outreach routes; Electron coordination
and enrollment are wired in source, while target-schema migration is pending. A
bounded native macOS smoke has verified a real external headed Chrome
launch, repeated-connect deduplication, session cancellation, and exact same-
Profile reuse after Sidecar restart. Current manual login, binding and collection
acceptance results are recorded in `docs/PROJECT_STATUS.md`.

Local platform authentication and Backend connection are separate milestones.
If an authenticated local session cannot complete because the Backend rejects
the client build or keeps desktop migration locked, the dialog retains the local
authenticated observation without marking the product account connected. It
shows the exact service recovery instruction inside the external login dialog
and stops automatic login polls; explicit recheck reuses the same session after
service repair. A string `error` of `desktop_client_build_not_admitted` (HTTP
409) or `desktop_client_migration_locked` (HTTP 503) is that instruction, not a
generic HTTP or Douyin outage. Device enrollment uses the same specific
admission copy instead of claiming the device is simply unregistered. After the
server is unlocked, another enrollment for the same workspace clears a stale
“后台暂未开放” banner and can finish account binding; that retry does not require
an app restart or a workspace change. Daily login diagnosis uses the paired desktop-local `start-ui`
launcher described in `docs/DEPLOYMENT.md`, preserving old outreach tasks.
The `start-ui` runtime deliberately disables approvals and desktop sending;
social conversations report desktop sending as disabled rather than asking for
a server executor. Normal `desktop:local` enables the approved desktop lane.
Before switching an acceptance runtime back to normal with retained queued
actions, inspect that queue and obtain the user's intended disposition.
Desktop execution leases expire after 90 seconds without renewal. A still-active
Douyin login alone does not restore an expired executor lease: claim renewal
rejects expired bindings. Use “重新检测本机登录” then “重新绑定本机账号”
in account management to explicitly renew the same-device binding. Successful
claims keep its lease alive; do not bypass the lease check or resume paused
historical batches when recovering a device. The approval view explains this
recovery path for `douyin_desktop_executor_invalid` and retains its diagnostic code.
An already connected desktop account offers “更新抖音登录” through the same
explicit browser flow, so fresh platform verification does not require first
disconnecting its saved account. Historical local records remain labeled as such.

Desktop login completion uses the same canonical bare 64-hex SHA-256 request
digest as other social-account operations, matching
`acquisition_social_account_replays.request_hash CHAR(64)`. Crawler/action
digests retain their separate `sha256:`-prefixed formats. The completed external
login dialog explains that login is saved and the browser window has closed;
the device-binding card separately reports whether this machine is bound.
`pnpm --dir backend test:desktop-login` covers this route/service boundary and
is included in the default Backend test command.

The desktop account card's “重新检测本机登录” uses the read-only
`checkDouyinLogin` IPC and the Sidecar's stable account-identity resolver. It
restores Main's collection identity cache without creating a login session,
opening/closing a browser, or incrementing the login version. Its result describes
the saved local login record, not a live platform-authentication guarantee.
“连接抖音” remains the explicit login flow; actual execution still verifies the
bound account in the browser.

The staged local action bridge has a bearer-protected stable identity resolver
and strict desktop execute/reconcile/acknowledgement transports. Desktop requests
use only the frozen canonical target and request hash; Web requests retain the
existing gateway shape. Request and receipt hashes share fixed Node/Python
vectors. Acknowledgement moves the exact completed journal to a sanitized
record, supporting lost-response retry without making the action executable
again. Main's private client validates all response keys and identity; it keeps
canonical millisecond receipt timestamps separate from ordinary Python
acknowledgement datetime precision. Main-only device credentials and two-account
recovery files are implemented. A separate Main-only central client implements
the canonical registration/claim/completion/recovery contract with fixed
authority headers, bounded transport and no automatic retry. Main connects these
clients/stores and real safeStorage to a two-lane coordinator, with Sidecar-ready
startup, read-only restart recovery and ordered shutdown. Main and its Renderer
gateway share one immutable build identity. Narrow Renderer IPC supplies verified
workspace/enrollment/binding metadata and receives sanitized status; Main has no
active context before authenticated bootstrap and clears it on logout. The latest
account card hosts the binding and explicit handoff flow. No installed-App update
or real send is implied. See `docs/desktop/macos-electron-client.md`.

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
cannot interleave.

Desktop Run Now reuses that same frozen run authority but persists the crawler
job with an explicit `executionTarget` of `desktop`; legacy rows default to
`server`. Server crawl and ingestion workers physically filter for `server`,
while the desktop API can claim only the exact workspace/job and hashed opaque
task capability. Desktop pages use the durable
`acquisition_crawler_desktop_page_replays` ledger: the same job/idempotency hash
and canonical request hash replays atomically, while changed content conflicts.
Terminal desktop pages enter the existing normalized-record ingestion and
candidate projection transaction without invoking the remote MediaCrawler
acknowledgement endpoint. The Renderer acknowledges the local Sidecar page set
only after this cloud projection is durable; cloud completion deliberately
leaves `acknowledgedAt` null because that field is not proof of the later local
cleanup.

During an active desktop run, the Renderer keeps the validated local collection
observation in that run's in-memory runtime. Its existing controller refresh
displays the local phase, keyword, observation time, and “本机公开记录” count
alongside the Backend's separate “已入库公开记录” count. Local observations must
match the current run, workspace, task and lifecycle generation; cancellation,
plan reload, workspace changes and synchronization failure invalidate them. They do not change durable
counts, candidate budgets, run completion, or approval eligibility. A locally
finished crawl is shown as waiting for result ingestion until the Backend
reports its terminal result. A completed browser phase no longer advertises an
open collection window or waits for another keyword. Restored historical runs use Backend observations;
this display cache is not persisted and does not add an IPC or API endpoint.

The plan form exposes `每次采集评论数` (default 100, editable 1–10000).
Saving freezes optional `limits.maxComments` into the next run's desktop task
or server crawler request; an already running task is not changed. The Sidecar
counts distinct normalized comment IDs across keywords/videos, excluding video
and creator records. It closes its owned runner at the target and writes the
final page before reporting success. Fewer available comments can also complete
normally; existing deadlines and video/page bounds still apply. Persisted IDs
are included when recovering a job. Local status exposes saved comment count
and that job's frozen target separately from public-record and candidate counts.
Older tasks without a target keep their original bounds and candidate discovery
remains unlimited. Desktop controls use authenticated `POST
/internal/v1/douyin/crawl-jobs/{jobId}/control/{pause|resume|stop}` through narrow
Main IPC. `controlState` distinguishes running/pausing/paused/stopping while
the job remains running and its cloud lease continues renewing. Pause suspends
only the owned worker process group, flushes pending records, and excludes the
suspension duration from the deadline. Resume continues the same process,
job/run and deduplication set. Stop wakes a suspended process, terminates that
owned process group, drains available output, saves the final page and reports
success for normal result ingestion. It does not call cancellation or create a
new run. Closing/restarting the app is not a resumable suspension; the existing
legacy `state=paused` restart-recovery behavior remains separate. Prolonged
pauses can still expire platform login or in-flight network requests.
Desktop result upload follows opaque cursors to the terminal page with cycle
detection, not the unrelated video-page limit.

MySQL takes the existing plan row lock before checking
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
Within an attempt, an existing `000-shensi-comments.jsonl` or
`000-shensi-creators.jsonl` is the sole source for that actor kind. The reader
must not merge a later snapshot of the upstream anonymized file into an older
public-capture snapshot; newly appended actors are read on the next poll.
Attempts without those captures retain the legacy reader path and strict actor
validation.
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
The manager closes its runner iterator before publishing a terminal result;
the runner terminates and reaps its own process group even when the consumer
fails during normalization or persistence. It waits for process-group exit,
not merely signal delivery or the parent worker's exit, before releasing the
Profile lease. Linux's read-only process-group probe treats a confirmed
zombie/dead-only group as stopped; unavailable or ambiguous inspection retains
ownership. It reads state and pgrp from `/proc/<pid>/stat`, never argv or env
([Linux stat field definitions](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)).
Delayed post-KILL cleanup emits one fixed diagnostic after three
seconds and retains ownership while waiting; it cannot publish a successful
terminal state. Manager shutdown still uses its bounded timeout.
Failure diagnostics contain only a fixed processing stage,
allowlisted code, retained-record count and, for upstream process exit, its
integer exit code. Raw exception text, tracebacks, records, keywords, Profile
paths and upstream stdout/stderr are not logged. Focused coverage is in
`test_crawl_jobs.py`, `test_crawl_failure_diagnostics.py` and `test_process_group.py`.
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

Saving an existing MediaCrawler plan persists its name before publishing the
automation policy. The frontend reads the current plan and ETag; a changed
approved name uses `POST /plans/{id}/revisions` with a name-only patch, then
approves that draft with its returned ETag. A pending draft uses `PATCH
/plans/{id}` only if its name differs and then approval; retries reuse that
draft. An unchanged approved name creates no plan revision. Other plan fields
remain intact. After approval the frontend reads the current automation ETag
and saves policy against the approved version, then refreshes the task overview.
Any failure stops the chain before a run is requested. “仅保存” never starts
collection or replaces existing run results; “保存并立即运行” requests a run
only after both plan and policy save succeed.

The Douyin account family provides login-session create/poll/cancel, workspace
account list, and disconnect in both runtimes. Its response always carries
`interactionSurface`, `runtimeState`, `authState`, `taskState`, `diagnostic`,
`screenshotAvailable`, and `qrAvailable`, so callers do not overload the
coarse account `state`. In `external_window`, the frontend displays the local
window instructions plus recheck/cancel controls and never calls live-window
mint or fallback interaction; `loginPage`, `qrImageDataUrl`, and `qrStatus` are
not required for progress.

In `remote_canvas`, the family additionally provides live-window mint and
fallback interaction. Login-session `POST`
immediately returns `awaiting_scan` with `loginPage: null` inside the short
gateway budget; the sidecar opens the official Douyin page asynchronously in one
persistent browser context. A later `GET` poll returns account state plus a
bounded viewport JPEG as `loginPage` for the fallback when capture succeeds.
If initial best-effort preparation, poll, or semantic refresh cannot capture
that fallback JPEG while the context is alive, it returns the same session with `loginPage: null`, preserves QR and
noVNC state, and does not map the attempt to `login_expired`; only a genuinely
terminal attempt does. A null page means only that the compatibility frame is
currently unavailable, either during secure-browser startup/preparation or
after a poll/refresh capture failure, and must not be rendered as “login page
opened” or “login expired.” The public contract retains exactly these safe
`failureCode`: `douyin_login_ui_unsupported`,
`douyin_verification_required`, `douyin_login_page_unavailable`,
`douyin_login_page_not_allowed`, `douyin_browser_unavailable`,
`douyin_browser_command_timeout`, or `douyin_login_open_failed`; raw adapter
exceptions never enter the public DTO. The current bootstrap closes only for a
browser/display/VNC failure or non-allowlisted page; an unrecognized official
login DOM stays interactive. Browser open runs
without holding the global state lock. Poll and interaction I/O serialize through
a per-session lease and must retain the matching generation/CAS authority. A
terminal result closes and flushes its browser context before CAS-persisting
account authority. Fatal open failure, disconnect, expiry, explicit close,
shutdown, a fresh start, and persistence failure clear unfinished work, leases,
and browser resources without replay. Bootstrap generation/stale checks prevent
older work from writing into or closing a replacement context. A new bootstrap
waits for the preceding thread to exit, and disconnect invalidates its
outstanding prepare work. The sidecar deliberately does not reuse an opening
session globally across tenants. Public request replay is scoped by workspace
plus `Idempotency-Key`; a separate workspace opening lease/fence ensures that
different keys, overlapping clients, and concurrent backend instances reuse one
unexpired upstream `awaiting_scan` session instead of starting another
bootstrap. Expired, terminal, missing, or cancelled sessions release the slot.
Cancellation removes the matching opening before the external disconnect. A
disconnect failure keeps the old session mapping for an explicit retry but does
not restore it as the workspace's reusable opening; a replacement opening is
isolated by its own session ID and cannot be deleted by the old retry.
Within the sidecar, successful cancellation is a two-phase lifecycle operation:
it synchronously invalidates the generation and unused live tokens and removes
the session from lookup, then delegates browser/context/profile teardown to
exactly one tracked owner. A live bootstrap performs its own teardown; otherwise
a tracked cleanup thread waits for any in-flight per-session/browser command.
This keeps `DELETE` independent of long best-effort preparation while preserving
eventual context close, profile deletion, shutdown joining, and failure
reporting. The frontend unmounts RFB before requesting cancellation.
The browser worker gives login open a
65-second command deadline. Its initial Douyin navigation makes no more than
three attempts in the same persistent context. Each attempt uses a 10-second
navigation timeout; after a failure, the failed page is closed, a fresh page is
created, and the next attempt starts 500 milliseconds later. After the third
failure it returns the safe
`douyin_login_page_unavailable` code. This page retry does not restart the
worker and is not an action retry; comment and private-message commands are
never replayed. The primary public control is
`POST /api/v1/acquisition/social-accounts/douyin/login-sessions/{sessionId}/live`.
It resolves the workspace-owned private session and returns only
`socketPath: /douyin-live/{token}` plus its expiry. The token is random,
short-lived, single-use, and bound to one login session/context generation.
The gateway upgrades only that same-origin path; after the sidecar consumes the
token it bridges binary frames to the session's loopback x11vnc listener. It
does not publish VNC TCP or expose the listener port to the browser.
When the token context is still starting, the upstream lifecycle conflict is
preserved at the public boundary as retryable HTTP `409`
`douyin_login_session_not_ready`; it is not collapsed into a generic service
failure. The embedded client waits and mints a fresh one-time token for the
same login session/profile. Login-session `GET` and interaction `POST` use the
gateway's dedicated 70-second transport timeout; other MediaCrawler calls retain their
existing shorter budgets.

The public login session has a required nullable `qrStatus` with the closed
values `opening`, `ready`, `expired`, `network_error`, and
`verification_required`. `qrImageDataUrl` is present only when the sidecar has
captured a currently visible QR image and reports `ready`; non-ready states
clear the image. During asynchronous startup both `loginPage` and
`qrImageDataUrl` are null and `qrStatus` is `opening`. The acquisition dialog
can therefore render a directly scannable QR without depending on a remote
canvas. An empty poll may initialize or retain `opening`, but it cannot erase
an already observed `expired`, `network_error`, or `verification_required`;
only explicit later evidence advances that state. It also exposes a semantic
`refresh_qr` interaction that performs one
bounded reload in the same workspace-scoped session/profile. A normal page
reopens the login panel, activates QR login, and probes the new QR. An expired
page is refreshed only by clicking a unique visible official “点击刷新” control
once and waiting in the same QR budget; the sidecar does not guess coordinates.
The refresh command emits only bounded, path-free network aggregates and
unregisters its diagnostic listeners before returning. If the refreshed
official page exposes neither a supported login panel nor an explicit
verification or network-failure state, the existing session remains `opening`;
it stays available for inspection, another explicit refresh, or normal
cancellation. `network_error` requires page-level network-failure evidence.
Once the allowlisted official page is reached, display/context, worker VNC
handle, and the locked `AccountManager` context/generation registration precede
all screenshot, DOM, QR, and panel preparation. If initial preparation, refresh,
or a later poll cannot capture the compatibility JPEG or identify the current
login DOM, the response carries `loginPage: null` on that same session, may
retain `qrStatus: opening`, and keeps the live noVNC context. The context is
closed only for a fatal browser/display/VNC error or a non-allowlisted page.
Normalized click, bounded
text, allowlisted key, and bounded scroll interactions remain available for
the JPEG fallback. Interaction text
is neither persisted nor replayed. Closing the dialog or replacing an unfinished
session calls `DELETE` on
`/api/v1/acquisition/social-accounts/douyin/login-sessions/{sessionId}`; it
cancels the matching upstream context and expires only that workspace-scoped
mapping. Session create,
interaction, and cancellation require authentication and the browser CSRF
cookie/header pair. Create also requires its semantic `Idempotency-Key`, while
interaction and cancellation are non-replayed commands. The separate account
disconnect requires both its semantic `Idempotency-Key` and current `If-Match`.
Account handles, browser contexts, cookies, security material, and
profile paths remain private. Only the token-bound login WebSocket is public;
VNC TCP, CDP, X11, browser-debug, and generic browser-control endpoints remain
private.
An active login result is bindable only when constrained authenticated page chrome
identifies exactly one own `/user/{sec_uid}` profile and one bounded public
nickname. The sidecar exports only a `dyacct_<sha256>` one-way handle, nickname,
and a globally monotonic positive `loginStateVersion`; raw `sec_uid` is neither
persisted nor returned. The backend keeps the greatest observed login version
as private durable high-water even after disconnect or risk pause. Same-account
reconnect revisions/ETags are derived inside the repository lock, and account
risk pause uses an exact identity CAS. Old sessions cannot reactivate an
inactive account or roll a newer reconnect back. Public account DTOs continue
to expose only the safe ID, state, nickname, login version, revision, and ETag.
A persisted `active` record is authoritative only when it contains a canonical
`dyacct_<sha256>` handle, a non-empty nickname, and a positive safe-integer
login-state version. A non-authoritative active record may be repaired
atomically only by a structurally valid login result whose version is strictly
greater than the durable high-water. Repair preserves the existing public
account ID and creation time, advances revision/ETag, and does not relax either
the valid-different-account conflict or rejection of equal and older sessions.
After terminal identity capture the context is closed and flushed, but the same
persistent profile remains the authority later reopened by collection, comment,
and private-message execution for that exact account/login version.
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
server-derived plan revision conflicts. The keyword command serializes replay
identity without holding the MySQL persistence queue during snapshot reads,
snapshot writes, or model attempt audit writes; only the completed replay result
uses a short queued mutation. Model configuration lifecycle writes keep their
original atomic mutation boundary. When the automation UI saves a business
name and keywords, it synchronizes generated plan context only if the Douyin
MediaCrawler objective and ICP still exactly match the plan's creation template.
It does not overwrite hand-written objective/ICP fields or historical Run
snapshots. Plan and automation saves remain separate existing API operations,
not an atomic transaction. Policy writes
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
Shensi shell and session controller, presents interactive Douyin connect/
reconnect, editable
keywords, local schedule/timezone and the 1–200 daily limit (default 50), then
shows the persisted crawler observation (phase, browser mode, keyword, attempt,
localized update time and candidate allowance), creator/commenter candidates, public
evidence, DNC/exclusion state, exact comment/direct-message drafts and
sanitized receipts. Approval always requires an explicit second confirmation.
Batch creation remains serialized in the browser until its request settles, so
rapid repeated clicks cannot create parallel batches. Only the explicit stale-
batch or ETag precondition codes reload the latest revision before another
approval attempt. Other 409 business outcomes, including the per-candidate
local-day outreach limit, keep the current batch and surface their localized
operator action instead of being presented as a revision conflict. Logout,
close or mode change aborts active requests and the single poller.
The task overview retains the latest authoritative run and separately publishes
`latestResultRunId`, the newest run with persisted candidate links. The newest
run continues to own the displayed task status. On controller load, including a
browser refresh or verified-session restoration, a stopped zero-result latest
run falls back only for candidate review to `latestResultRunId`; otherwise the
latest run ID becomes the independent `activeRunId` used to reload crawler
status and all of the run's candidate pages. `activeRunId` is not a reconstructed
run-now intent; it is also the run authority used when the operator creates an
editable, pending-approval outreach batch from recovered candidates. It blocks
another run while recovery has not yet confirmed persisted status, while a
current intent has no first persisted observation, while its observed crawler
state is nonterminal, or while candidate projection is `pending`. Every refresh
validates crawler status before reading the candidate pages. The controller follows
the server cursor, deduplicates by candidate ID, and stops on cancellation or run
change. Repeated cursors or the 100-page bound fail the read visibly rather than
presenting a partial first page as the complete result. Live-projected
candidates may appear while the crawl is nonterminal or projection remains
`pending`; a validated `ready` status is the ordering boundary for the final
candidate read. A terminal `ready` response with zero candidates is valid, and
a candidate-read failure retains the validated terminal status while receiving
at most three exponentially backed-off retries. Success, run change, closure,
or exhaustion stops that retry loop. A restored run may intentionally contain
persisted candidates without an `acquisition_crawler_job_runs` mapping, as in a
tenant-isolated read-only showcase snapshot. For that exact
`404 crawler_status_not_found` response, and only when there is no current
run-now intent, the controller reads all pages of the independent candidate projection once,
marks it as a historical result, and schedules no crawler-status retry. The UI
labels this state `历史采集结果`; timeouts, server failures and newly
submitted runs keep the normal error/retry behavior. Paused, failed, and cancelled crawler jobs
project the matching recognizable state into every still-active authoritative
run alias. Restoring an acquisition run is observational: that restore alone
does not create or approve a batch and never submits a comment or direct message;
those external actions remain behind explicit second confirmation, the exact
execution gate, and the separate fenced executor. The current real-customer
Web/Trial compatibility path deliberately keeps the legacy action flag and
defaults it to false: drafts remain editable/reviewable, but final
approval returns `503 outreach_actions_disabled`, creates no actions, and sends
nothing. A specific trial may enable both processes only after explicit user
authorization and a global all-zero audit of `queued`,
`blocked_by_predecessor`, and `executing`. In that mode, the page's second
approval confirmation is the send authorization: a new approval atomically
queues only the exact public comment, and the worker may claim it immediately
after commit. A separate private-message-specific human confirmation creates a
v3 action bound to the reviewed current sender/login, recipient, edited body and
quota. It does not require a comment or alter the comment's approval. Historical
v2 actions retain their original successful-predecessor rule.

The same ordering boundary is enforced by the backend, not only by the page.
Batch creation requires a `succeeded` or `partial` crawler job whose terminal
ingestion is `succeeded` and whose `projectedAliasGeneration` equals the current
`aliasGeneration`. Final approval rechecks that condition and, on MySQL, locks
the crawler authority in the same transaction before inserting the comment action.
`outreach_candidate_projection_pending` means collection, terminal ingestion,
or a reopened alias projection is still in progress; it leaves a reviewed batch
unchanged and creates no action. `outreach_candidate_projection_unavailable`
means the crawl was paused, cancelled, failed, or terminal ingestion failed; a
new successful collection is required. If a later live page changed the same
actor's evidence before finalization, the earlier batch remains stale and a new
batch must be generated from the final candidate projection.
Only candidates whose persisted public evidence points to an exact
`https://www.douyin.com/video/{id}` URL can enter the initial comment
approval flow. Profile-only creator candidates remain clickable for evidence
inspection, while their outreach checkbox is disabled and labelled
`仅查看 · 缺少可评论视频`; commentable rows are labelled `可评论` plus their
current batch-selection state. Inspecting a row never selects it for outreach.
The MediaCrawler creator capture retains the source `aweme_id`: normalization
uses that exact video as evidence while keeping `/user/{sec_uid}` as the frozen
public candidate profile. If a candidate accumulates multiple evidence rows, both the
run feed and batch authority sort the frozen evidence IDs and prefer a valid
video. Legacy profile-only evidence remains inspectable but is never promoted
to a comment target; a fresh collection is required to obtain the missing
source-video binding.
The backend repeats the exact video/profile target validation during batch
creation, revision, and final approval; invalid targets create no approval or
action rows. Each batch candidate freezes its exact public comment video in
`commentTargetPublicUrl` and exact direct-message profile in
`publicProfileUrl`. Those two public targets remain in the public batch DTO and
participate in the batch hash, so the operator reviews the same targets that
final approval authorizes. Crawler-private `evidenceText` and `publicActorKey`
remain server-only and are removed from every public batch response.
The approval workspace renders the batch account display name, account ID,
login-state version, selected candidate display name, exact comment video, and
exact public candidate profile. It enables the comment confirmation only when
the currently connected account is active and its ID and login-state version
match the frozen batch authority. A missing or malformed public target, missing
account context, stale login version, or different account blocks the checkbox
and approval button. The comment editor enforces the 300-character contract
limit and disables comment confirmation while its visible draft is unsaved.
The independent 800-character private-message composer is available for awaiting
and approved batches, including candidates with no comment, queued or failed
comments and comments awaiting receipt reconciliation. It reviews the same
account's current active login, which may be newer than the frozen comment
batch. Edited DM text is bound by its own approval and does not require saving
a new comment-batch revision. It exposes exactly one private-message confirmation
and explicitly labelled queue command.
The private-message daily limit defaults to 50 and accepts 1–100; the server
revalidates the account's actual daily allowance at confirmation and never
silently truncates the visible candidate set. It is independent of the
acquisition candidate limit, whose default is 50 and range is 1–200. New crawler
jobs freeze the saved policy limit; new public-comment batches inherit that job's
limit and can review all 50 eligible candidates. Final confirmation creates one
comment action per selected candidate, not a private message. The account's
same-day approved usage reduces the remaining allowance, so 50 is a total limit,
not 50 additional comments after earlier approvals. Acquisition and social
candidate lists consume all result pages; neither truncates the people at five.
The crawler budget counts distinct non-video records before identity merging,
eligibility and DNC filtering, so a limit of 50 does not promise 50 unique people.
The UI distinguishes the observed run's frozen allowance from the current saved
plan limit, which applies to the next collection. Existing jobs, batches and
approved action limits remain unchanged. Action
details and receipts are collapsed by default. Each control states exactly
which real action it queues.
Batch/action states and closed platform failures are localized for the
operator, with the stable code available only in collapsed technical details.
The desktop coordinator's `idle` status means the executor is ready, not that
the selected action is queued. Only a persisted queued action says it is waiting
for pickup. `douyin_direct_message_unavailable` does not identify the recipient
as the cause: it can originate during local credential loading, initialization,
recipient lookup, conversation creation or a rejected send. Its UI copy remains
cause-neutral; existing receipts are not rewritten by presentation changes.
`#acquisition` and authenticated real-mode `#conversations` share this same
server batch, revision, approval, action, and receipt authority. The
conversations route defaults to a private-message workspace with a searchable
real-recipient list and independent composer. Public comments and send history
have separate tabs. The view renders one explicit surface (`comments`,
`direct_messages`, or `history`); it does not build a combined comment-then-DM
panel and hide its steps. Acquisition defaults to comment-only approval. The
private-message surface previews the current sender, exact selected recipient
and edited body before its separate confirmation; it contains no comment editor
or numbered acquisition step. Historical batch selection is available only in
the send-history surface, alongside actual receipts. Sender management opens
the acquisition account card's login/binding controls. It is not an official
Douyin inbox or private-message thread. Status updates preserve textarea identity,
focus, selection and local drafts. Search and tab renders read the current
controller state, including silent draft and daily-limit edits; the preview
updates its matching recipient's exact text immediately. Errors and result-uncertain states remain
visible. Loading a batch also reads its persisted action receipts when comments
are still awaiting approval, because independent DMs may already exist. The
editor waits for that initial read; an empty draft stops polling, while an
observed active action continues normal status polling without a write.
Selecting an eligible public
interaction calls
`GET /api/v1/acquisition/outreach-batches?runId={runId}&candidateId={candidateId}&limit=50`;
the latest returned head is loaded by default. A history selector loads an older
head through the existing batch GET, preserving access to uncertain actions even
when a newer draft exists. Every selection revalidates candidate/run ownership
and clears prior confirmation state; it never creates, approves or resends. An empty list
permits creation of exactly one pending batch containing that candidate only.
Reload follows the same candidate-run selection as the acquisition task model:
when the latest run is failed, paused, cancelled, or budget-exhausted, it uses
the server's `latestResultRunId` when available. A retained run is read through
the existing run GET and checked against the task's plan before its actual
status and time are displayed. Candidate reads follow the opaque `nextCursor`
until complete, with a 100-page and repeated-cursor bound; reaching either
bound displays an incomplete-results notice. A malformed page fails that run's
read and remains visible in its failure warning. Other runs still render.
Reload repeats overview → selected result run → candidate pages →
candidate-scoped collection GET → batch GET and action receipts, so server
`runId + candidateId` ownership, not session selection order, recovers revisions
and receipts. The candidate scope remains the overview's latest 20 tasks and
each task's selected result run; this is not a global history across all runs.
Profile-only evidence remains readable,
but does not call batch discovery and cannot create a comment batch.
The decoder accepts crawler state, activity phase, browser mode, and projection
state only as primitive strings in their closed enums. The candidate response is
also a closed trust boundary: the page is exactly `{items,nextCursor}`, each
item has required `{id,status,displayName,evidence}` and may additionally carry
the display-only public HTTPS hints `avatarUrl` and `coverUrl`; evidence is
exactly `{sourceUrl,excerpt}`. Both media fields are optional, never cause new
collection, and never change candidate, sender, approval, or action authority;
the decoder accepts them only as bounded HTTPS URLs without credentials,
backslashes, whitespace/control/format characters, or malformed percent
escapes, and the UI falls back to its generic icon when they are absent or fail
to load. A
page contains at most 100 items. Candidate ID and status
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

The real-mode primary action is `新建抖音采集计划`. In a workspace with no real
Douyin task, the detailed MediaCrawler stack stays collapsed so the task and
run summary remain the first workspace view; the primary action and the empty
task card's `任务设置` button explicitly reveal and focus that form. Once a real
task exists, its configuration remains available with that task. The form must
not list or validate public-search/model
connections. The lower `公开搜索增强（可选）` entry alone opens the legacy-
compatible generic wizard; those provider and tool-calling-model dependencies
are requirements of that optional execution mode, not prerequisites for
Douyin MediaCrawler collection. The wizard includes a no-API return action to
the primary form. Its AI-plan control stays disabled until both dependencies
are available and must not submit a request that is already known to fail. A
server-side `SEARCH_PROVIDER_CONNECTION_REQUIRED` race is rendered as this
same MediaCrawler guidance rather than a raw internal error code.

Douyin connect/reconnect is one frontend single-flight operation. While the
short login-session `POST` is pending or the current unfinished session remains
reusable, repeated calls reuse the current request/session instead of starting
another open. The UI selects its runtime only from `interactionSurface`. For
`external_window`, it renders the external-Chrome status, polls or explicitly
rechecks the base login session, and offers session cancellation; it neither
mounts noVNC nor calls the live-session or screenshot-interaction APIs. The
direct `#douyin-live-login?sessionId=...` route first fetches that session and
returns external-browser guidance before loading the noVNC/RFB implementation
or invoking `createLiveLoginSession`.

Expired/failed desktop login sessions are removed from the Renderer cache.
An exact Main session-unavailable response ends background polling; the next
explicit connect creates one new session instead of querying the retired ID.
Successful account disconnect also cancels the local desktop session, without
changing plan/keyword drafts or adding a second cancellation to Web disconnect.
The disconnect captures its local login ownership before the API request, so a
successful response cleans only that old login even after route exit. Failed
local cancellation retains the exact pending handle; explicit reconnect retries
that cleanup before starting another login. A failed account disconnect leaves
the local login intact. Ordinary route disposal is not an account logout.
Account identity changes clear old local-check messages. Main rejects identity
checks and status writes from a generation revoked by cancellation, a new login,
or a terminal session. A late failure cannot clear a newer identity. A confirmed closed
worker Context is terminal and releases its local session; transient detection
failures remain recoverable without closing the visible browser. The persistent
desktop Profile is retained for a subsequent explicit login.

For `remote_canvas`, the successful create response enters `awaiting_scan` with
`loginPage: null`. Component unmount aborts pending requests, clears retry
timers, disconnects RFB, and advances the client generation so late callbacks
cannot reconnect. The login dialog mounts noVNC/RFB inline as its primary
action surface. That embedded client mints a live token through the
authenticated public API and connects against the returned same-origin socket
path. A not-ready `409` schedules one guarded retry for the same session, and
manual reconnect cannot bypass that cadence. RFB reconnect also mints a new
one-time token rather than reusing an already consumed WebSocket URL. The
separate `#douyin-live-login?sessionId=...` page remains a new-tab backup for
this surface. The original acquisition page keeps its existing poller alive
after QR scan and waits for an active account, `login_expired`, or a safe
`failureCode`; successful login therefore binds on the original page without
copying browser state.

The screenshot UI is collapsed under `备用：使用截图控制登录`. It shows
“正在启动安全登录环境” only while the session is actually opening.
If an established session has `loginPage: null`, it reports that the fallback
screenshot is temporarily unavailable and does not claim that the page opened,
closed, or expired. Embedded RFB reconnect remains on the current login session
and only remints its consumed live token. Explicit dialog close cancels the
current session; an account-level refresh cancels an unfinished predecessor and
then creates one replacement. Fallback
click, text, key, and scroll commands all target the same sidecar browser
context used by noVNC. Pointer press/release is paired by the stable
workspace host rather than the replaceable screenshot node, so a polling render
cannot swallow the click; one short gesture submits once and a drag submits
nothing. While one pointer or scroll command is awaiting its replacement frame,
additional pointer and scroll input is ignored instead of queued; keyboard text
remains serialized for login fields. An `awaiting_scan` session whose expiry is
reached before a poll response, before an interaction, or through an HTTP 410
interaction response is normalized to `login_expired` and its stale frame is
removed. The dialog also exposes a stable semantic QR refresh control. It
reloads and refreshes the official login UI in the same unfinished login
session/profile; it does not replace that session merely because the fallback
frame expired or stopped responding. A not-yet-ready live context returns
retryable HTTP `409` `douyin_login_session_not_ready`; other sanitized
MediaCrawler login-gateway failures remain retryable HTTP `503`
`mediacrawler_unavailable`. Inside the sidecar, a faulted Playwright worker may restart
only before a new `open` or new `action` command. A command that was sent,
timed out, or has an ambiguous outcome is never replayed. Poll, close, and
reconciliation calls never revive a faulted worker, and an explicit browser
shutdown remains terminal. The background open has a bounded cold-start command
budget and each interaction returns a fresh frame. CAPTCHA, slider,
verification, and platform warnings require human handling in the displayed
login flow; the runtime never solves or bypasses them.

Outreach generation is a private service boundary consumed only by the batch
service. `POST /runs/{runId}/outreach-batches` persists its exact values as
candidate draft revision 1. Generation does not persist a draft or batch until
every selected candidate validates; the separate model-call audit ledger is
persisted for both successful and failed provider attempts.
It loads only persisted workspace-owned candidates and their exact evidence,
parses normalized refusal and age phrases again before any model call, uses the
active official snapshot with closed structured output, and validates one-line,
bounded comment/direct-message text. Comments retain the verbatim-evidence and
fixed-safe-clause validator. New private-message drafts use a natural two- or
three-sentence greeting, one source-grounded topic and a relaxed invitation, not
a company introduction or sales pitch. The model may paraphrase private messages;
their language is not forced through the comment phrase whitelist.

The existing model gateway receives the recipient name, each exact evidence
excerpt and `provenance.actorKind`, plus its actual search keyword (stored by
MediaCrawler in `DiscoveryEvidence.sourceTitle`, not a video title). Associated
video excerpts are read only from the same workspace/job's persisted normalized
records with the exact same video URL. They remain separately attributed to the
video author. A commenter's words must not become the author's words or vice
versa; keywords are search context, never the recipient's claimed needs. Missing
video/role/keyword context is represented as absent/unknown, not invented. No
extra crawling is performed by draft generation.

One bounded second call through the same gateway reviews the natural DM's facts,
source attribution and tone. Only a well-formed affirmative review citing existing
evidence IDs permits the generated text; non-factual generic greetings may cite
no IDs. This is model-assisted review, not a guarantee of semantic correctness,
and human editing/confirmation remains required. Negative, malformed or unavailable
review returns a source-only conversational fallback after the final atomic
authority check, preserving a valid original comment. Unknown attribution uses
a generic greeting/invitation instead of asserting what the recipient published.
An invalid comment still uses the existing exact-source comment fallback. No safe
comment evidence segment, initial gateway/tool-shape failure, DNC, tenant or final
evidence-authority failure still stops generation. There are no model retry loops.
`rationaleCodes` remain closed to `evidence_grounded`, `public_need_signal` and
`manual_review_required`; fallback includes the manual-review code.

Active prompt/schema bundles are v8/v9; immutable v7/v8 and older content remain
registered for their existing snapshot hashes. Only new generation uses the new
rules. Reading/editing existing drafts does not regenerate them, and historical
actions, approval snapshots and receipts are not rewritten. Evidence rows are
never concatenated to manufacture a quote. URLs, Unicode/IDN/punycode
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
or idempotency headers. The MySQL repository validates its internal limit as a
safe integer before embedding the bounded `limit + 1` literal in the query;
this avoids MySQL 8.4/mysql2 prepared-statement rejection of `LIMIT ?` without
allowing caller-controlled SQL. Unexpected router failures return only the
stable `outreach_internal_error` envelope and emit a request-scoped diagnostic
containing method, path, request ID, stable code, and error class, never the
exception message or credentials. Every mutation is authenticated,
CSRF-protected for cookie sessions, capability-gated by
`acquisition.outreach.approve`, and semantically idempotent; revision-bound
mutations also require the current `If-Match`. A human edit uses the manual
message validator: nonempty 300/800-character bounds, safety checks and frozen
candidate/evidence authority remain enforced, but generated-comment verbatim
grounding is not imposed on conversational human wording. Manual PUT never
regenerates model content; invalid edits return `outreach_manual_draft_invalid`
with an editing message, not an AI-provider failure. It keeps the source model snapshot, recomputes
content hashes, and creates draft revision 2 inside a new immutable batch
revision. Approval and every lifecycle transition rotate the response ETag,
so a pre-transition `If-Match` cannot authorize later state changes. In an
explicitly action-enabled runtime, approval is the required human second
confirmation of the supplied revision and batch hash. It rechecks account/login,
candidate revision, evidence membership/hashes, DNC, the actual selected policy
limit, and exact Douyin video/profile action targets before atomically recording
the approver and exact content. It
creates, but does not execute, exactly one `comment` action with sequence 1 and
status `queued` per selected candidate. The distinct
`POST /api/v1/acquisition/outreach-batches/{batchId}/direct-messages/approve`
command accepts awaiting or approved batches independently of comment status.
Its v3 authorization freezes the exact selected profile, edited private-message
text, current reviewed sender/login, approver and daily limit/ordinal; its
predecessor is null. It does not revise the frozen batch or approve a comment.
The retained legacy v2 request/rows still require their exact successful comment
receipt. Historical unversioned direct-message rows remain readable through the existing action
contract, are not backfilled, and are never claimable. Memory uses the shared
reentrant authority coordinator; MySQL locks the account and reuses one
connection for candidate/evidence/DNC locks, approval, replay, daily-limit
reservation, and the comment action insert. A nested authority transaction on that
pre-bound connection restores and tenant-checks the ingestion scope before any
candidate/evidence/DNC lock. When the flag is missing or false,
approval returns `503 outreach_actions_disabled` before approval, replay,
allowance, or action persistence; this is not a dormant approved outbox.

The application constructs and starts its action recovery sweeper and claim
worker only when the private gateway is configured and the action flag is
exactly enabled. The deployment sidecar likewise constructs no
`ActionJobManager` while disabled and rejects the action route before manager or
executor lookup; its crawler worker remains available. When enabled, the action
worker claims the earliest eligible comment or authorized version-2 direct
message under a random lease and monotonic fence, with one in-flight action per
account. The MySQL claim scan advances by the ordered `(created_at,id)` keyset
until it finds eligible work, so a complete window of future-delayed, risk-
paused, busy, stale-authority, or over-limit actions cannot indefinitely hide a
later eligible action. Direct messages require version 2, their frozen 1–100
daily ordinal, and the same successful predecessor receipt at claim time.
Before the private sidecar call it
rechecks the active account/login version, approval and action
hashes, candidate revision/evidence hashes, DNC, policy/job/budget bindings,
daily allowance, and persisted delay. Server timestamps enforce at least 60
seconds between comment actions and reserve at least ten minutes between
private messages across restart or clock skew.
The batch privately freezes its policy time zone. DM approval computes the
ordinal from `approvedAt` in that zone; each claim separately counts real
attempts on the claim instant's local day, so a cross-midnight action cannot
reuse the prior day's execution budget, retries consume the current day's
allowance, and reset occurs only on the next local day. Memory and MySQL
permanently reject a second DM for the same workspace/batch/revision/candidate,
even when a new approval key is used on a later date. They also reserve one DM
per workspace/account/local-date/candidate across different batches. For a
historical MySQL comment batch whose JSON predates the frozen `timeZone`, claim
loads only the batch's exact immutable policy version, verifies its row and
payload policy hashes plus plan/account bindings, and persists that policy time
zone into the batch before creating an attempt. If that authority cannot be
proved, the comment and its blocked successor are terminalized before claim.
Version-2 direct messages never receive this compatibility upgrade and remain
unclaimable unless their batch already carries the frozen time zone.
The sidecar receives only the frozen public target and exact approved action
text, reuses the account's authenticated browser profile, submits once, and
returns a sanitized platform receipt reference. A comment succeeds only with a
unique first-party publish receipt. A private message uses the focused vendored
`cv-cat/DouYin_Spider` transport rather than page DOM controls: it authenticates
from the already-bound sidecar context at execution time, parses the canonical
`/user/{sec_uid}` target, resolves the recipient through the focused API binding,
and omits nameless browser cookies from the transport Cookie header without
changing the persistent Profile. Named cookies retain delimiter/type validation
and at least one valid login cookie is still required. The transport
requires the returned `sec_uid` to match exactly before conversation
creation. It revalidates sender/account authority before conversation creation
and again before sending the one exact approved text. Its deterministic UUIDv5
client message ID is derived from the immutable action ID, and the returned
`douyin-im:<sha256>` receipt reference exposes neither message text,
conversation IDs, cookies, browser security material, nor raw `sec_uid`. A
pre-send failure is closed as unavailable; an exception after sending begins is
ambiguous and is never retried. `browser_state._execute_action` owns the action's
persistent browser Context and keeps it open throughout the synchronous DM
transport and sender rechecks. On return or error the transport closes its auth
session, then the wrapper closes its Context in `finally`; credential extraction
failure also reaches the wrapper cleanup without making a transport call. The
private-message result is displayed in Shensi's persisted action receipt, not by
leaving an open Douyin conversation in the temporary action browser. Window
closure alone therefore does not distinguish success from failure. Comment response proof requires
the exact frozen request text/video, success status, and a stable comment ID;
returned text/video/author values must match when present, while omitted
optional echo fields require a post-response sender revalidation. Response
parsing waits for body completion. If the body remains unreadable, the adapter
does not submit again and accepts only the existing unique new self-owned DOM
receipt proof. `ActionJobManager` acquires its in-process keyed locks in the
fixed order action ID, then account handle, before acquiring the process-safe
`ProfileLease`. The action-ID lock protects the receipt journal and `.tmp` path,
which are derived only from that ID, even when conflicting requests name
different accounts. The account lock serializes different actions for one
account, while different action IDs for different accounts can progress in
parallel when their Profiles differ. Desktop `external_window` execution and
reconciliation still pass through `AccountManager`, but only short authority
reads use its global `RLock`; the lock is released before LBSM-owned browser I/O
and is reacquired by validator callbacks at irreversible checkpoints. The LBSM
command worker owns and closes its Context. The Web `remote_canvas` path retains
the legacy `AccountManager` command lock. Login-state versions come from a
process-locked global monotonic ledger. Ledger, account
binding, and login metadata use atomic replace plus file and parent-directory
`fsync`; a sync failure cannot activate account authority. Before invoking the
external executor, the sidecar similarly commits the action's `started` journal
through both durability barriers, and aborts before any platform write if either
fails.
Douyin's lazy-mounted comment composer is activated only when no allowlisted
editor exists: the adapter requires one visible `.comment-input-inner-container`
and one exact `留下你的精彩评论吧` entry, revalidates target/sender/risk/deadline,
and clicks that pinned entry at most once. Activation does not type or publish;
missing or ambiguous state fails closed without page-wide, fuzzy, coordinate,
OCR, or model selection. The mounted editor and any semantic submit control are
pinned to concrete ElementHandles and independently tagged with random one-use
markers. If no semantic comment submit exists, the exact editor is also the
guarded dispatch control for one unmodified Enter keypress. A synchronous
capture-phase click/keydown guard rechecks the exact approved comment editor
content, URL, and sender at dispatch. Guard rejection reports content,
control/URL, or sender drift with its corresponding closed code. Receipt
ambiguity is reserved for a platform write that may already have dispatched.
Direct messages do not use these DOM controls; they use the separate exact
`sec_uid`/recipient binding and deterministic client-message identity described
above. MediaCrawler upstream provides
the collection/browser foundation; both action executors are Shensi extensions
and are not official or upstream-native action APIs. DOM/ARIA controls are
primary for comment execution. When explicitly configured, local RapidOCR may
suggest only a missing comment entry/send control before the adapter rebinds it
to the exact allowlisted DOM target; OCR never selects identity, recipient,
editor, content, or receipt, and
screenshots/recognized text are not persisted or logged. On an ordinary
operator-controlled local display, verification after initial target navigation
permits the bounded user-completion wait, followed by full revalidation of the
same action. A comment's post-submit receipt observer also recognizes the visible
“接收短信验证码” prompt and existing verification markers. It brings the same
page to the front and waits for human completion before checking receipts. The
wait is capped by both the configured manual-verification budget and the action's
remaining deadline; it does not reserve a fresh deadline after submission.
After the prompt clears, sender and exact target are revalidated and only the
existing official response or unique DOM receipt may establish success. No
editor write, second submit, or verification-control interaction is allowed.
Closing the window, expiration, or changed authority during that post-submit
wait yields receipt ambiguity and read-only reconciliation, not another send.
Clearing the prompt alone is not proof of delivery. Closed diagnostic events
record waiting/cleared/unresolved and failure code, never SMS data or page text.
The token-bound noVNC path is
login-session-only and is invalidated when login completes; it does not attach
to later comment or private-message action contexts. The isolated trial therefore
has no remote action-control surface: CAPTCHA, slider, login verification, or
platform warning during an action requires stopping that attempt and later
starting a documented supported flow; it never opens Mac Chrome. This isolated
remote mode does not provide the local operator's action-verification handoff.
There is no
solver, token injection, alternate write path, or bypass service. The current
defaults are 120 seconds for manual verification, 150 seconds for the Node
action deadline, 175 seconds for gateway HTTP, and 170 seconds for browser-action
IPC. Desktop central leases equal the 60–330 second action-deadline delta plus
30 seconds (90–360 seconds total); the retained server worker keeps its
180-second minimum. Server timeout retains the legacy
`risk_paused` result. Desktop post-start timeout, `action_unavailable`, and
receipt ambiguity become `reconciliation_required`; the desktop sweeper requeues
only an expired claim whose recorded platform-write count is zero, while an
expired executing/count-one attempt also reconciles. Pre-journal
`douyin_profile_busy` may requeue, and explicit risk still pauses. Historical unversioned
direct-message rows remain read-only compatibility data and are never claimed.
An independently confirmed v3 DM does not wait for an old uncertain desktop
comment after its completed execution receipt has been durably recorded and
all execution/recovery leases have ended. The uncertain comment stays unchanged
and is never retried. Claimed/executing actions, unsettled executions, active
read-only observation/recovery and account risk pauses still serialize the
account. Legacy v2 and uncertain DM actions retain their existing blocking rules.
After a comment returns either a verified success receipt or an ambiguous
post-submit receipt, its target page stays in front for ten seconds before the
headed browser context closes. In the isolated trial that page remains private
inside Xvfb rather than appearing on the Mac or public page. The interval holds
the profile lease, performs no additional DOM read/write or click, and cannot
turn an ambiguous result into success.
Verification outside these bounded local comment handoffs,
rate-limit, account-warning, login-expiry, missing-control, and timeout states
are closed failures; no alternate selector or bypass route is attempted. A
deterministic comment failure may still close a predecessor-linked direct-
message row as `predecessor_failed`; it never authorizes that message. A
malformed success receipt or a post-submit exception follows the target-specific
policy above and never authorizes a second write. Three consecutive failures and
immediate account-risk failures persistently pause the account and all its queued
work. Stale completions cannot overwrite the current fence. Same-device restart
recovery checks the original attempt plus current installation/binding/login and
issues a new-process, reconciliation-only capability containing the full immutable
read-only action request: account identity, kind, canonical target, exact content,
approved/request hashes, a fresh bounded recovery deadline, the original lease,
and binding/login versions.
It cannot authorize `started` or a write. Crash recovery's observed receipt and the original
receipt share one first-valid slot; exact replay is stable, changed evidence
conflicts, success releases only the exact approved DM successor, and
`action_unavailable` remains unresolved.

Explicit human receipt requests have a separate MySQL-backed observation path.
The existing device claim poll discovers them without relying on a surviving
Main journal, returning only `kind: reconcile` and `reconcile_only` authority.
Current installation and account binding, original account handle/write fence
and frozen approval/content must still match. A human request may observe the
same account after its login version advances: the task retains the original
`loginStateVersion` and semantic hash and adds `observationLoginStateVersion`.
The reconcile-only token binds both versions; only the Sidecar reconcile route
accepts the additional observation version and uses it for current Profile and
in-browser authority checks. Execute rejects this observation projection.
The current same-device binding generation can advance with that re-login;
the original action and attempt must still match each other's original binding
generation. The observation token is bound to the current generation and cannot
be used by another device or after the current binding changes.
Automatic journal recovery and all writes still require the original login;
queued old-login writes require fresh approval. Another live observation lease cannot be
replaced. The human request retains its original snapshot and a private
`desktopDispatch` observation record. It does not overwrite a previously
committed ambiguous attempt receipt. Only an observed success resolves the
action; unavailable/ambiguous observations finish that request but leave the
action and its account lane unresolved. No new platform-write attempt is added.
Sidecar may read the original acknowledged uncertain tombstone to recover the
not-before timestamp; it invokes the read-only adapter and leaves that tombstone
unchanged. A completed or expired human claim key cannot fall through into a new
write claim. Explicit platform risk pauses and independent DM approval remain.

Desktop claim authorization is not a preview followed by a compensating release.
The repository locks the installation, social binding, account serialization row,
and deterministic action rows, then invokes the sole candidate/evidence/DNC
authority resolver over that transaction-bound frozen snapshot before any claim,
attempt, quota, cooldown, or replay effect can commit. Rejection or resolver
failure rolls the entire claim transaction back.

The application exposes this fencing, receipt, sweep, recovery, and human-audit
core through desktop installation and action routes. Installation membership is
re-read from the active exact user/team/workspace tuple. Memory startup rejects
disconnected or mismatched repository authority references even when their
coordinator is shared. The MySQL repositories share the application pool.
Enrollment, registration and binding remain available when desktop execution is
disabled; claim, complete and reconcile return the stable disabled response.
Enrollment replay and consumption read the UTC DATETIME fields as SQL-formatted
text, not mysql2 host-local Date values. The 60-second expiry therefore has the
same meaning on UTC and non-UTC hosts; exact expiry still rejects registration.
Acquisition build admission runs before body parsing. User enrollment/binding
and device action authentication remain distinct. The current acquisition account
card enrolls the device, reads exact central binding state and records successful
bindings through Main's narrow bridge. An explicit handoff is disabled while
unresolved actions exist. Shared action presentation distinguishes desktop/server
targets, keeps comment and DM confirmations separate, and never changes focus or
scroll on status events. Renderer reload only resubscribes; logout clears Main's
workspace. Long-offline recovery needs an authenticated same-device rebind after
the 90-second binding lease expires. Target-schema migration and live acceptance
remain pending; UI state is not evidence of a platform send.

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
customer/comment text or credentials. Real overview and performance reads begin
only after the server-authoritative session publishes an authenticated state;
the unauthenticated Shensi login must not generate protected-route 401 traffic.

For interactive login, provision an encrypted-at-rest directory before starting the
sidecar. `MEDIACRAWLER_ENCRYPTED_VOLUME` must name an existing, non-symlink
directory with exact mode `0700`; `MEDIACRAWLER_PROFILE_ROOT` must be inside
it. `MEDIACRAWLER_CRAWL_OUTPUT_ROOT` must be absolute, already exist, be a
non-symlinked current-user-owned directory with exact mode `0700`, and resolve
strictly inside but not equal to that encrypted volume. The runner resolves it
once and uses the same root for attempt/job creation and acknowledgement
cleanup; deployment never writes to the source-local compatibility directory.
`MEDIACRAWLER_SERVICE_SECRET_FILE` must name a non-symlinked, owner-only,
newline-free secret file of at least 32 bytes; a raw secret environment value
is rejected. In the isolated trial these paths are
`.runtime/real-trial/state/mediacrawler/{profile,output}` and
`.runtime/real-trial/secrets/mediacrawler/service_secret`; Docker receives only
the two dedicated `mediacrawler/` bind parents, not MySQL state or other
application secrets. The sidecar corrects owned profile directories to `0700` and metadata to
`0600`. Playwright and every browser context live in one owned child process
group;
startup, commands, and shutdown are bounded, and a timed-out command hard
terminates that process. Graceful ASGI shutdown closes live browser handles
but retains safe active metadata/profile state for restart. Login-session expiry
deletes only an unconnected login attempt; a connected account has independent
durable metadata and is removed only by explicit disconnect or replacement.
Malformed, symlinked, or unreadable durable account metadata is quarantined;
missing or malformed ephemeral login metadata does not invalidate a valid
connected account.
The trial's host wrapper derives the container name and ownership label from the
retained runtime path. Stop and failure cleanup verify that label before
stopping/removing the exact container, while retaining its host-side profile,
login metadata, crawl output, and service-secret file. An unrelated container or
label mismatch is never force-removed.
The browser launch mode is configured by `MEDIACRAWLER_BROWSER_HEADLESS`,
`MEDIACRAWLER_BROWSER_CHANNEL`, and `MEDIACRAWLER_BROWSER_DISPLAY`. Ordinary
local operator acceptance may use headed installed Chrome. The isolated public
trial instead uses `false`, an empty channel, and `virtual`: bundled Chromium
runs headed under Linux Xvfb inside the dedicated Colima profile
`shensi-trial`, and Docker publishes only the sidecar HTTP API to host
`127.0.0.1:5612`. Chromium uses the container's 1 GiB `/dev/shm` instead of
Playwright's bounded `/tmp` fallback. The trial launcher propagates uppercase
and lowercase `HTTP(S)_PROXY` and `NO_PROXY` from the Colima VM into the
container for build tooling and ordinary HTTP clients. Chromium connects
directly by default and never infers a browser proxy from those generic
variables. Only an explicit `MEDIACRAWLER_BROWSER_PROXY` value is validated as
a credential-free `http`, `https`, or `socks5` origin with an explicit port and
passed as Playwright's browser `proxy.server`. The authenticated public page
mounts the normal interactive noVNC/RFB login inside the acquisition dialog. Each login
context has its own Xvfb display and x11vnc listener on sidecar loopback. The
frontend mints a short-lived, single-use token through the public live endpoint
and connects only to the same-origin `/douyin-live/{token}` WebSocket; the VNC
TCP listener, X display, CDP, cookies, profile, and browser security material
never leave the sidecar. The separate Shensi live-login tab and a bounded JPEG
login frame with the contracted click, text, key, and scroll commands remain
available as backups. Both the embedded view and backup tab control the
server-owned context. Opening Douyin directly in
a separate customer browser cannot authorize it because browser security state
is never copied into the server-owned profile.
Virtual mode requires Linux plus a valid X display and fails closed in a native
Mac process. A collection-only production runtime may set
`MEDIACRAWLER_BROWSER_HEADLESS=true` while outreach is disabled; an
action-enabled runtime must use headed mode and otherwise fails startup and both
parent/child action IPC checks. Login-session `POST` returns `awaiting_scan` with
`loginPage: null` within the short gateway budget. The adapter's bounded browser
command continues asynchronously without holding the global state lock. During
that phase a null value means the compatibility frame is not yet available,
not “opened.” After an allowlisted official
Douyin page opens, the adapter makes it available through noVNC and also
captures its fixed-size JPEG viewport for fallback polling. Preparation may
best-effort activate a supported official login entry and QR mode when the
current page exposes a safe recognized target; otherwise the user opens the panel and
completes login through embedded noVNC/RFB or a backup control. A failed navigation closes
that page and performs the one
short retry on a new page in the same persistent context. Polling can instead
map a failed or cleaned-up attempt to `login_expired` with a safe `failureCode`.
Poll and interaction I/O use a per-session lease plus
generation/CAS authority. Terminal
completion closes and flushes the context before the matching CAS persists account
authority. Fatal open failure, disconnect, expiry, explicit close, shutdown, a
fresh start, and persistence failure clear unfinished work, leases, and browser
resources without replay. After the official allowlisted page opens, the
display/context and VNC handle are registered before best-effort screenshot and
DOM preparation. A missing first or later compatibility frame therefore returns
`loginPage: null` on the same session and preserves QR state and noVNC context;
only browser/display/VNC failure or an unsafe page closes it.
The sidecar rejects navigation outside the allowlisted official Douyin hosts;
malformed frames, unsupported UI, and unavailable pages return stable adapter
failures rather than raw locator timeouts. Health and ordinary MediaCrawler
requests retain the gateway's short default; login-session `GET` and interaction
`POST` use the dedicated 70-second timeout. A displayed frame is not account authority: only the same
private browser context observing an actual authenticated state publishes a
connected account. Verification pages are completed by the human through the
bounded login interactions and are never solved, bypassed, or delegated to an
unrelated browser session.
Action localization is configured separately with
`DOUYIN_ACTION_VISUAL_LOCATOR=disabled|rapidocr`. Omission is exactly
`disabled`; empty, padded, case-changed, or unknown values fail configuration.
The `rapidocr` option requires the pinned optional local OCR dependencies in the
sidecar image/runtime. It does not change the external action gate or permit
verification bypass.
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

The platform carousel precedes the selected platform workspace. All five cards
can be browsed using arrows, side-card clicks, horizontal wheel/swipe and
keyboard navigation. Only Douyin supports real acquisition; Kuaishou,
Xiaohongshu, Weibo and WeChat retain dark `待接入` cards even when centered.
Browsing a pending card updates its position and `当前浏览 · 待接入` label, not
the selected real task, workspace, approval or execution capability. It cannot
expose hidden demo task detail. Data refresh and resize retain the browsed card.
The existing 480ms transform transition and reduced-motion preference remain.
In real
mode the selector owns a full-width decision row, the real task list follows
it, and the selected platform workspace follows the task list. Mid-sized
desktop layouts hide the secondary inspector so all five cards remain visible
without changing the product's dark visual system.

For a compatibility-mode trial-disabled action check, leave
`DOUYIN_OUTREACH_ACTIONS_ENABLED=false`, confirm crawler status still advances,
confirm final batch approval returns the stable 503, and confirm no queued test
fixture is claimed. For an explicitly authorized action trial, first confirm the
global action table has no `queued`, `blocked_by_predecessor`, or `executing`
work, then use the supervisor's one-shot
`--enable-outreach-after-empty-audit` flag so both processes receive the same
effective gate. Ambient or retained true values are ignored by the trial
supervisor. Trial preparation emits
`DOUYIN_ACTION_VISUAL_LOCATOR=disabled`; using `rapidocr` is a separate explicit
runtime choice through the exact `trial:start` or `trial:publish`
`--action-visual-locator=rapidocr` option. It never implies action
authorization, and the ordinary disabled path keeps its existing sidecar
command. Do not enable the flag
merely to pass trial acceptance.

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
