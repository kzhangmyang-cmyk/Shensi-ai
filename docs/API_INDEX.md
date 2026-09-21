# API Index

## Platform administration v1

`contracts/openapi/platform-admin.v1.yaml` generates
`frontend/src/generated/platform-admin.ts`. `/api/platform/v1` provides
POST/DELETE `/session`, GET `/overview?page=&q=`, POST `/enterprises`,
PATCH `/enterprises/{id}`, POST `/plans`, PATCH `/accounts/{id}`.
Mutations carry `{revision, reason, value}`; conflict returns 409. Business
authentication, independent MFA session and cookie CSRF apply. The account
actions are disable/enable/revoke; enterprise creation includes its primary
admin. See [module boundaries](modules/platform-administration.md).

- `GET /api/enterprise-query/gleif`：登录后只读查询中国LEI登记企业；参数 `keyword`（2–100字）、`page`（1–1000），十条一页。返回 `EnterpriseQueryPage`，路由契约为 `contracts/openapi/enterprise-query.v1.yaml`，共享生成模型在 acquisition v1，来源边界见 `modules/enterprise-data-sources.md`。

## Contract authority

Decision simulation v1 supports optional `options.events` (at most eight explicit templates). Start/duration must fit the horizon; duplicate templates, same-factor overlapping windows and wrong-direction values are rejected. Realized `shock.events` retain the replaced background value and input assumption. Fields are optional for historical records. All plans share these realized paths; see `contracts/openapi/decision-simulation.v1.yaml` and `modules/decision-factor-catalog.md`.

New decision reports persist optional `report.recommendations`: rule-backed simulation signals, evidence locations, proposed actions/mechanisms, prerequisites/costs, priority, owner role, timeframe and review metrics. Conditional sensitivity comparisons retain baseline and changed outcomes, not promised ROI. Historical GET does not synthesize absent recommendations; the desktop screen and HTML export read the saved version.

Optional `input.decisionPreferences` is an explicitly confirmed per-report snapshot (cash/profit/delivery priority, optional nonnegative cash floor, pilot/review preferences, feedback-candidate opt-in and confirmation source). `report.preferenceAssessment` ranks the existing plan summaries and checks sample cash floors without changing paths or profit. These fields are not a cross-run learning profile or an action engine.

Personal cross-session operating data uses `/api/v1/agent-memory/operating`;
`/api/v1/decision-simulations/memory` remains an alias to the same service and revision.
`POST /api/v1/finance/operating-memory-question` explicitly selects an enabled
personal operating profile by revision for a text question, with optional CFO
session CAS. Unknown domains are rejected; acquisition and voice do not use it.
The personal-memory operations are:
GET reads the authenticated actor/workspace aggregate; GET `/export` exports that
owner's complete preferences and reviews. PUT/DELETE `/profile`, PUT `/reviews`
and POST `/adopt` require `expectedRevision`; conflicts return 409, invalid input
422, and inaccessible reports/recommendations 404. Cookie CSRF and workspace
authentication remain the existing runtime boundary. No supplied actor/workspace
fields are accepted. Profile deletion retains manual reviews, the revision and
immutable report snapshots. Reviews require a saved plan before actual results;
manual observations are never advisor action receipts. Disabled learning clears
candidates and rejects adoption. See `DecisionMemory` and related generated types.

| Surface | Editable authority | Runtime evidence | Generated consumer |
| --- | --- | --- | --- |
| Acquisition v1 | `contracts/openapi/ai-acquisition.v1.yaml` and `contracts/json-schema/` | `backend/src/acquisition-openapi.ts`, acquisition routers, drift and response-conformance tests | `frontend/src/generated/ai-acquisition.ts` |
| Growth, quote, ROI, finance, council | `contracts/openapi/growth-advisor-quote-roi.v1.yaml` and `contracts/json-schema/` | `backend/src/growth-openapi.ts`, Growth module routers, drift and response-conformance tests | `frontend/src/generated/growth-advisor-quote-roi.ts` |
| CFO saved sessions | `/api/v1/finance/cfo-sessions`, `/{sessionId}`, `/{sessionId}/turns`; `cfo-session.v1.schema.json` | `financial-council-agent-center-router.ts`, scoped encrypted `cfo_conversation_sessions`; revision CAS on completed turns | History list/new chat; optional NDJSON real stages with terminal result/error |
| Immutable Growth release | `contracts/releases/growth-advisor-quote-roi/1.0.29/` | `manifest.json` declares `contractVersion: 1.0.29`; release gates verify hashes | `frontend/contracts/pinned/growth-advisor-quote-roi.openapi.json` and `.manifest.json` |

Generated types are authoritative at the frontend/backend transport boundary.
Do not add parallel handwritten DTOs.

## Route families

Growth 1.0.29 adds optional `additionalFiles` (at most nine) to the existing
document inspection request. Including the primary file, the decoded batch is
at most 5 MiB. Successful combined inspection returns optional `files` metadata
and file-prefixed original references; the selected conversation document ID
represents the entire selected set. A failed member prevents combined model
traffic; independent previews and retries remain available.

`POST /api/v1/finance/documents/inspect` accepts optional `analysisPurpose`
(`finance`, `roi`, `management`) in Growth 1.0.29. It selects a read-only analysis
question, not a ledger type or permission. Only explicit `readWithModel: true`
calls the configured model; original-source validation and actor/workspace
selection boundaries remain unchanged.

`GET /api/v1/finance/council-runs` lists current-workspace history with bounded
`after` / `limit`; `GET .../{runId}/events` uses event-ID cursors.
`GET .../{runId}/collaboration` supplies independently persisted six-role states,
public evidence and bounded cross-review, full CFO model/fallback provenance,
and an eight-section same-version detailed report. These reads require
`finance.council.run` and never create or approve downstream work. The desktop
`window.shensiCouncilReport.exportPdf` bridge exports static HTML rendered from
the same loaded report and uses only the native save-dialog path; its narrow
local protocol is in `desktop/src/shared/council-report.ts`.

`POST /api/v1/finance/cfo-conversation` accepts `question`, optional `role` (six roles; omitted = CFO), optional `documentId` and up to ten
user/assistant `history` turns. Authentication, cookie CSRF and
`finance.council.run` apply; workspace material and routing are server-resolved.
Returns answer, provider/model, closed verified-package or read-only-document provenance (or null) and time.
Nonempty `documentId` resolves only the exact actor/workspace-scoped source;
expired/missing/replaced IDs never fall back to a verified package. Null or omitted
IDs retain the existing verified-package semantics. No raw reports are accepted in this question body.
The internal CFO skill additionally receives package/parser/source versions and
prepares deterministic display facts and validates model fact references before returning plain text. Raw Minor values/reports are not included in the expression model context; client facts remain forbidden.
Rate limit: 12 requests per minute per workspace/actor. No automatic frontend retry; the model gateway allows one bounded structured-output repair. No
idempotency/ETag requirement, mutation command or audio transport. See
`docs/modules/cfo-conversation.md` and the generated Growth 1.0.29 DTOs.

`POST /api/v1/finance/documents/inspect` accepts the bounded original CSV/XLSX/PDF/DOCX JSON
envelope and `readWithModel`. False only inspects; true uses the configured model
and returns a selected short-lived source ID for later questions. Responses expose
original cells/coordinates, PDF page/item or DOCX paragraph/table-cell sources, regions, coverage uncertainty and sourced observations;
they never commit a ledger or create a verified package. Cookie CSRF applies.
`DELETE /api/v1/finance/documents/selection` rejects body/query and clears only this
actor/workspace, returning 204. See `docs/modules/finance-document-reading.md`.

`POST /api/v1/acquisition/cfo-workflows/{id}/candidate-decisions/batch`
accepts 1–100 unique candidate decisions after the workflow reaches human
candidate review. The CFO panel uses one request for the selected
approvals. The server processes that ordered list inside the workflow's
existing serialization boundary and persists each candidate after the existing
review and CRM handoff services finish, so an exact retry skips completed
candidate decisions and does not duplicate Customer/Todo writes. The original
single-candidate decision endpoint remains available.

Acquisition outcome attribution is a closed source union: ordinary provider
discoveries use `acquisition-run.v1`; verified persisted crawler discoveries use
`douyin-crawler.v1` with a real `jobId`, null shard/operation/connection/provider
fields and empty provider/query arrays. The server resolves workspace, Run,
job and candidate/evidence bindings rather than trusting the submitted source.
`OutcomeAttributionInput` snapshots do not contain the extra decision metadata
required by live Outcome events. Commercial binding, ledger and cohort snapshots
accept both the base snapshot and the historical enriched representation.
`POST /api/v1/acquisition/candidates/{id}/private-domain-handoffs` also accepts
`operationCode: handoff_acquisition_candidate_v2` for explicit direct CRM intake,
with `decisionVersion: ""`. It verifies source/tenant authority but requires no
qualification or AI approval; `intelligence` is null. Customer, lead, Todo and
source snapshot persist together. Duplicate candidate submissions return the
existing customer. The v1 contract remains for the shared CFO qualification flow.

Desktop-only voice configuration uses the narrow `window.shensiCfoRealtime`
bridge; its command/event DTOs are in `desktop/src/shared/cfo-realtime.ts`, not
the HTTP Growth contract. Main rechecks the current app session and finance
workspace permission before settings/check/start. Only save accepts a Key;
the save input's provider `workspaceId` may be an empty string for the fixed
public Beijing endpoint. This does not change the required Shensi authorization
workspace in the outer command.
settings/save/check/remove responses contain no credential. The help command
opens one of two fixed official documentation URLs, never a supplied URL.

- `/api/auth`, `/api/profile`, `/api/accounts`: public registration and login,
  authenticated session/profile operations, and account administration in
  `backend/src/server.ts`. `POST /api/auth/register` accepts only
  `{ account, password }`. The trimmed, lowercased account is 3–32 characters,
  starts with a letter or digit, and otherwise contains only letters, digits,
  `_`, or `-`; the password is 8–128 characters. Success returns `201`, creates
  an active `admin` in a new workspace, and issues the same session/CSRF
  authority as login. A normalized duplicate returns `409`; the registration
  route is limited to five attempts per observed client IP per hour.
- `/api/customers`, `/api/leads`, `/api/deals`, `/api/todos`,
  `/api/commission`: CRM and operating routes in `backend/src/server.ts`.
- `/api/v1/acquisition`: plans, runs, shards, candidates, evidence, reviews,
  provider connections, workspace-scoped interactive Douyin login-session
  create/poll/interact/cancel and accounts, immutable Douyin
  automation policies, optional model-backed keyword suggestions, and run-now intents with distinct authoritative
  acquisition-run IDs, persisted run crawler status with a closed activity
  observation (phase, keyword, browser mode, sequence) and closed candidate
  projection readiness (`pending`, `ready`, or `failed`), a null or stable
  runtime-normalized crawler failure code, run-scoped candidate feeds, immutable
  task overviews that retain the newest run status and separately identify the
  newest run with persisted candidate links,
  outreach batch revisions, separate human confirmation for public comments
  and independent private messages, version-3 private-message authorization with
  current-login review, and backwards-
  compatible action outbox reads with sanitized execution status, attempt count, receipt
  reference, occurrence time, and closed failure code;
  visual reader, copilot, outcomes,
  performance, advisor, and
  ROI-related acquisition projections.

Every Douyin login-session response declares the interaction and lifecycle
contract independently through required `interactionSurface`, `runtimeState`,
`authState`, `taskState`, `diagnostic`, `screenshotAvailable`, and
`qrAvailable` fields. Clients must branch on `interactionSurface`, not infer a
runtime from `state`, `qrStatus`, or the presence of an image. For
`external_window`, the official page is already interactive in the local
headed browser; `loginPage`, `qrImageDataUrl`, and `qrStatus` may all be null,
both availability flags are false, and the client must not call the public
`.../{sessionId}/live` or interaction endpoints. It polls or explicitly
rechecks the base session and may cancel it with `DELETE`. The direct
`#douyin-live-login?sessionId=...` route fetches the base session first and, for
`external_window`, returns before loading noVNC/RFB or calling the live-session
API.

For `remote_canvas`, Douyin login-session responses use `loginPage: null` when the bounded JPEG is
not available during asynchronous startup or subsequent best-effort screenshot/
DOM preparation. Once an allowlisted official page has a registered
display/context, worker VNC handle, and context generation, a null frame does
not remove live-token/noVNC availability and is not a terminal login result. A
rendered page is present only when `loginPage` contains its bounded JPEG frame.
The required nullable `qrStatus` is one of `opening`,
`ready`, `expired`, `network_error`, or `verification_required` while awaiting
scan. `qrImageDataUrl` is non-null only with `ready`; every non-ready state
clears it. `POST .../{sessionId}/interactions` accepts the existing bounded
manual controls and semantic `{ "type": "refresh_qr" }`, which refreshes the
same session/profile once. An expired QR is refreshed only through a unique,
visible official “点击刷新” control; missing or ambiguous controls are never
replaced with a coordinate guess. The remote acquisition dialog uses
`POST /api/v1/acquisition/social-accounts/douyin/login-sessions/{sessionId}/live`
to mint a short-lived, single-use token for its primary embedded noVNC/RFB
surface. When the same login session exists but its live browser context is not
ready, this operation returns the standard error envelope with HTTP `409`, code
`douyin_login_session_not_ready`, and `retryable: true`; the frontend retries
the live mint against that same session/profile with one guarded retry cadence.
Create replay is scoped to workspace plus `Idempotency-Key`. The trusted
backend additionally coalesces different keys onto one unexpired pending login
per workspace with a repository lease/fence; it never crosses workspaces, and
cancelled, missing, expired, or terminal sessions free the slot. The sidecar
does not globally coalesce opening sessions across tenants. The separate
`#douyin-live-login` page and JPEG interaction routes are backup controls for
the same browser context. Login-session `GET` and interaction `POST` use a
70-second upstream gateway timeout; unrelated MediaCrawler routes keep their shorter transport
budgets. The client continues polling the same session after QR scan until it
becomes `active` or reaches a documented terminal state. Terminal login failures return a nullable closed
`failureCode`, and
`DELETE /api/v1/acquisition/social-accounts/douyin/login-sessions/{sessionId}`
cancels only that authenticated workspace-bound attempt with a `204` response.
The backend fences that attempt out of workspace reuse before requesting the
sidecar disconnect. If the disconnect fails, the API returns the sanitized
failure and retains the old session ID for a later cancel retry; create does not
reuse that uncertain session. A successful sidecar cancel commits logical
revocation first: the generation, registry entry, and unused live tokens are
invalidated without waiting for serialized screenshot, poll, or browser-close
I/O. Exactly one tracked bootstrap/cleanup owner then closes the context and
deletes its private profile; shutdown waits for that tracked teardown. The
normal frontend disconnects RFB before sending this `DELETE`.
If the local workspace mapping is absent the API returns `404`; if the mapped
sidecar session has already disappeared it returns `410
douyin_login_session_expired`; exact upstream not-interactive startup is `409
douyin_login_session_not_ready`; other sidecar failures are sanitized as `503
mediacrawler_unavailable`.

`GET /api/v1/acquisition/outreach-batches?runId={runId}&candidateId={candidateId}&limit={1..50}&cursor={opaque}`
discovers current batch heads for one workspace/run/candidate in stable newest-
first order. It requires authentication plus `acquisition.outreach.approve`,
but no CSRF or idempotency header. The opaque cursor is bound to workspace,
run, and candidate. `#acquisition` and `#conversations` use this collection as
the shared server recovery authority; the conversations workspace reloads
overview, candidate evidence, this collection, then the selected batch GET.
It does not infer ownership from a locally remembered batch ID.
Each public batch candidate includes its frozen exact
`commentTargetPublicUrl` video and read-only `publicProfileUrl` candidate profile;
both participate in the batch hash so approval authorizes the targets shown to
the operator. The public DTO omits crawler-private `evidenceText` and
`publicActorKey`.

`POST /api/v1/acquisition/outreach-batches/{batchId}/direct-messages/approve`
is the separate private-message authorization command. It requires the same
authenticated outreach capability, cookie-session CSRF protection, semantic
idempotency, the current revision/ETag authority, and literal `confirm: true`.
Its idempotency fingerprint binds the `approve_direct_messages` operation, path
`batchId`, and exact request body: an exact retry on the same batch replays,
while reusing that key on another batch returns an idempotency conflict.
Its closed body supplies `batchRevision`, `batchHash`, `accountLoginStateVersion`, a
private-message `dailyLimit` from 1 through 100, and selected
`{candidateId,directMessage}` values. The default shown by clients is 50; it is
independent of the acquisition candidate limit (default 50, range 1–200). A
candidate can be confirmed in an awaiting or approved batch without a comment
receipt. The command freezes the current reviewed sender login, exact profile,
edited text, approver and daily ordinal in a version-3 action with no predecessor.
It leaves the batch revision, ETag and comment approval unchanged. The route
itself performs no browser write. The retained legacy request with
`commentApprovalHash` still creates v2 authority and requires its exact succeeded
predecessor; clients must never combine both authorization forms.

`GET /api/v1/acquisition/runs/{runId}/candidates` keeps the generated response
type but the browser treats it as a closed trust boundary. The page, each
candidate, and its evidence must have exactly the declared keys; candidate
objects require `id/status/displayName/evidence` and may include optional,
display-only public HTTPS `avatarUrl` and `coverUrl` hints. Their absence has no
effect on collection, candidate selection, sender validation, approval, or any
action; clients retain the generic visual fallback. The hints use the same
bounded, credential-free URL hygiene as public evidence, while requiring HTTPS.
The client
enforces bounded page/text/cursor policy and rejects the whole response when an
evidence URL lacks a literal HTTP(S) authority and hostname or contains raw
credentials, backslashes, whitespace/control/format characters, malformed
percent escapes, or parser-repaired authority. The OpenAPI `sourceUrl` remains
`format: uri` and crawler `lastErrorCode` remains a bounded nullable string;
HTTP(S) URL closure and the stable crawler error allowlist are runtime defenses,
not parallel handwritten DTOs or generated enums.

When one Douyin candidate has multiple persisted evidence rows, the run feed
deterministically prefers an exact `https://www.douyin.com/video/{id}` row.
Only when no such row exists does it expose a valid public profile as an
inspection fallback. Batch creation repeats the selection fail-closed and never
uses `/user/` as a comment target.

Plan creation accepts an optional `executionMode`. Absence means the compatible
`generic` provider-operation mode. `douyin_mediacrawler` is Douyin-only and
uses empty provider/operation arrays, no model connection, and a nullable model
snapshot on its persisted Plan and Run. Its command path is plan create,
approval, automation GET/PUT, then `/plans/{planId}/run-now`; generic
`/plans/{id}/runs` rejects this mode. Manually supplied automation keywords do
not require a search API or AI model. Only `automation/keyword-suggestions`
requires the server-selected active model.
- `/api/v1/catalog`: catalog items, package versions, and pricing policies.
- `/api/v1/quotes`: quote cases, versions, approvals, publication, and deal
  decisions.
- `/api/v1/finance`: facts, imports, statement packages, council policy,
  routing policy, council runs, dispatch reads, and agent-center projections.
- `/api/v1/growth/bootstrap`: active workspace and enabled feature bootstrap.
- `/api/v1/ai/endpoint-profiles`: official model endpoints and their
  server-certified selectable `{ id, displayName }` model choices.
- `/api/v1/ai/connections`: model connection lifecycle and activation.
- `/api/docs` and `/api/docs/openapi.json`: runtime-generated Swagger when
  enabled and authorized.

The legacy `/api/*` CRM route list is generated from Express registration in
`backend/src/swagger.ts`; it is not a substitute for the two versioned shared
contracts.

The sidecar `/internal/v1/*` health, account, crawl, result, acknowledgement,
and exact-action routes are service-to-service implementation interfaces, not
public APIs. They require the mounted bearer secret, accept only a private or
loopback backend connection, and are never routed by Nginx. Raw handles,
cookies, browser profiles, leases, raw ingestion state, and upstream payloads
must not be added to the acquisition OpenAPI surface.
The login-create call may additionally carry the backend-generated stable
workspace account key on this private boundary. It is an implementation input
used to select a durable desktop profile and must never be added to the public
request or response schema.
Desktop login and action calls still enter the Sidecar through `AccountManager`,
which owns business-session/profile/identity persistence. Its global `RLock`
covers short state and authority checks only in `external_window`; it is not held
across browser I/O. `LocalBrowserSessionManager` owns and closes the opaque
worker/Context. The retained `remote_canvas` implementation keeps its legacy
AccountManager command-lock behavior.
MediaCrawler upstream is the collection/browser foundation. Exact comment and
version-2 direct-message execution are Shensi extensions behind this private
boundary; they must not be described as upstream-native features or official
Douyin APIs. Approval, server execution, and desktop execution have three
independent strict lowercase boolean gates. Any present canonical split key
requires all three; when none is present, the bounded legacy Web/Trial adapter
enables approvals and server execution together and leaves desktop execution
off. Server execution additionally requires the private MediaCrawler gateway.
Comment confirmation creates comment actions only. The separate command above
creates an independently confirmed v3 direct-message action per selected
candidate; it never approves or retries comments. Historical v2 actions retain
their exact comment receipt dependency. Historical unversioned
direct-message rows remain readable audit data, are never backfilled, and are
not claimable. `ActionJobManager` takes in-process keyed locks in the fixed order
action ID then account handle, followed by the process-safe `ProfileLease`.
This serializes one action ID across conflicting account inputs because the
receipt and `.tmp` paths depend only on that ID, serializes different actions on
one account, and still allows different action IDs on different accounts and
Profiles to proceed concurrently. The executor reserves at least 60 seconds
between comments and ten minutes between private messages, and requires a unique
comment-publish receipt or new outgoing stable message ID respectively.
At the private browser boundary, the frozen sender is revalidated in place at
each irreversible checkpoint. Private-message input, submit, reconciliation,
and receipt proof additionally require one exact recipient marker matching the
frozen public profile target; ambiguous or changed bindings fail closed.
DOM/ARIA is the action-control authority; optional local RapidOCR may only
suggest a missing entry/send control before exact DOM rebind. Visual MCP remains
a development diagnostic, and no model provider receives browser-control or
approval authority.
Task 5 completes the internal desktop claim/start/receipt/sweep/recovery core.
The claim repository runs the sole candidate/evidence/DNC authority
resolver inside the locked claim transaction before any claim effect commits.
Its restart response contains the complete immutable read-only action request, a
fresh bounded recovery deadline, and a fresh-process reconciliation-only
capability; that capability can neither start nor write. Original and observed
receipts share a first-valid slot,
with exact replay and changed-evidence conflict. Desktop zero-write expired claims
may requeue, count-one/post-start uncertainty reconciles, and server uncertainty
retains the legacy risk pause. The public contract and production application
expose these desktop bridge routes beneath `/api/v1/acquisition`:

| Method | Path | Authentication |
| --- | --- | --- |
| POST | `/desktop-installations/enrollments` | User session or bearer; cookie sessions require CSRF |
| POST | `/desktop-installations/register` | One-time enrollment token and idempotency key |
| GET | `/social-accounts/{accountId}/desktop-binding?installationId=…` | User session or bearer, workspace capability and active registered installation for that user/team |
| POST | `/social-accounts/{accountId}/desktop-binding` | User session or bearer; cookie sessions require CSRF |
| POST | `/desktop-outreach-actions/claim` | Active installation ID and device token |
| POST | `/desktop-outreach-actions/{actionId}/complete` | Active installation ID, device token, and task token |
| POST | `/desktop-outreach-actions/{actionId}/reconcile` | Active installation ID and device token; task token forbidden |

Every mutation requires the admitted desktop build digest before JSON parsing or
authentication. Admission is a compatibility check, not a substitute for
authentication, workspace membership, approval, or execution fencing. Locked
admission returns `503 desktop_client_migration_locked`; exact admission rejects
missing, duplicate, malformed, or mismatched digests with
`409 desktop_client_build_not_admitted`. Exact mode has one required primary
digest and may carry at most seven unique additional exact digests for a bounded
arm64/x64 or rolling-version overlap. It is still an allowlist: unknown builds
remain rejected, and an additional digest does not bypass any later tenant,
device, approval or execution check. Claim also forbids a task-token header.
The strict completion and recovery snapshots, phase-dependent receipt fields,
and response unions are defined in `contracts/openapi/ai-acquisition.v1.yaml`
and generated into both frontend and desktop clients. The binding GET returns
`DesktopBindingStatus` with exact generation, lease expiry, relative ownership and
whether unresolved actions prevent handoff; it is `Cache-Control: no-store` and
does not expose device hashes or account handles. POST still rechecks all authority
transactionally. Public action DTOs include `executionTarget` (historical server
responses may omit it), `claimed`, and `reconciliation_required`.

The existing public acquisition contract includes
`POST /api/v1/acquisition/outreach-batches/{batchId}/actions/{actionId}/reconcile`.
It requires the outreach capability, CSRF for cookie sessions, an idempotency
key, the frozen batch revision/approval/content hashes, and literal human
confirmation. The command is read-only at the platform: it can record one
unique existing receipt for a `risk_paused` uncertain action but never submits
or retries content and never resumes paused work. A deterministic comment
failure may close a linked direct-message successor with `predecessor_failed`;
malformed claimed-success receipts and other uncertain writes fail closed as
ambiguous risk-paused outcomes.
For desktop-target actions this authenticated user route records a durable
human reconciliation request and never calls the platform gateway. The device's
existing `POST /desktop-outreach-actions/claim` can return `kind: reconcile`
with a `DesktopOutreachReconciliationTask`, bounded `reconcile_only` token,
`serverTime` and `replayed`. This path discovers requests even without a Main
journal and checks the exact workspace/device/account/current-login/binding/original
attempt and frozen approval/content. It never calls started or execute.
The human request's private JSON retains its original snapshot and adds
`desktopDispatch` (generation, process hash, deadline, hashed claim key/request,
and eventual observed receipt/hash/result). Original attempt receipts remain
immutable. An observed success resolves the action; unavailable/ambiguous
observation remains `reconciliation_required`, with no resubmission. The same
completed/expired human claim key returns replayed empty, never a new write.
These JSON metadata additions require no DDL change. Non-human crash recovery
continues to use the original first-valid receipt slot.
For a human-requested observation after a same-account re-login,
`DesktopOutreachReconciliationTask.observationLoginStateVersion` carries the
current login version while `loginStateVersion` and `taskRequestHash` retain the
original immutable action. The read-only token binds both; completion uses the
observation version. Both HTTP claim and reconcile response projections preserve
this optional field; ordinary write-task responses do not include it.
The private Sidecar `/reconcile` request accepts
`observation_login_state_version`; the execute route rejects it. Account handle
and installation identity must remain identical. The observation uses the current
same-device binding generation; the action/attempt retain their matching original
binding generation and write fence.
This does not restore old write approvals or authorize an automatic resend.
The separate device completion transport carries both start and receipt
commands; device recovery is reconciliation-only and cannot authorize another
platform write. Device recovery includes a closed `released` response with
`actionId`, `taskRequestHash`, `originalLeaseVersion` and `replayed`, but no
receipt/token. It releases only the matching unstarted local claim after
central revocation, not a completed receipt or newer lease. Central durable
start evidence can issue read-only recovery even when Main's phase still says
`claimed`. Electron enrollment/binding/context/status IPC and current-page UI are
implemented in source; target-schema operational acceptance remains pending.
Binding leases are still required for recovery; after long offline periods the
authenticated user must rebind this device rather than bypass the lease guard.

## Protocol conventions

Decision simulation uses `contracts/openapi/decision-simulation.v1.yaml` and
`frontend/src/generated/decision-simulation.ts`:

- `POST /api/v1/decision-simulations/preparations` parses 1–10 selected files
  (combined binary size at most 5 MiB), returning original references and
  unconfirmed numeric candidates. It does not invoke a model.
- `GET /api/v1/decision-simulations/preparations/{id}` reads the same actor's
  transient preparation and real five-role execution states. Preparations expire
  after one hour and are lost on backend restart; completed reports persist.
- `POST /api/v1/decision-simulations/preparations/{id}/analyze` requires literal
  `confirm: true` plus the corrected simulation input. It authorizes source text
  to the configured model, returns 202 and starts five-role analysis followed by
  exactly 100 sample paths. Exact repeated input does not restart a running or
  completed task; a failed task can be explicitly retried with the same input,
  re-running all five roles. Changed input conflicts. Provider failures stay
  failures rather than generated reports; there is no automatic retry loop.
- `POST /api/v1/decision-simulations` is the separate manual calculation route.
  `GET` on that collection lists recent records; `GET /{runId}` reads an immutable
  saved report without regeneration. Records may include source/agent evidence;
  older manual records need not contain it.

All these paths require the existing authenticated workspace and actor.
Cookie writes retain CSRF protection. Uploads use the existing document-reading
capability; model keys stay server-side. These operations do not write CRM,
verified finance or outreach queues.

Protected routes require an authenticated session or bearer identity. The
health, login, registration, logout, and signed webhook exceptions are declared
by backend policy; public registration grants no authority over any existing
workspace. Browser writes use the CSRF cookie/header pair. Contracted commands
may additionally require `Idempotency-Key`; versioned writes use
`If-Match`/`ETag` where declared by the OpenAPI document. Error shapes and
authorization capabilities must come from the contract or backend policy
registry rather than frontend inference.
Crawler repositories normalize unknown, legacy, and exception-derived failures
before persistence and public projection; raw messages or credentials are never
valid public error codes.

## Change workflow

1. Edit the relevant OpenAPI/JSON Schema source and backend runtime together.
2. Regenerate committed frontend types with
   `pnpm generate:frontend-contract-types`.
3. Run `pnpm check:acquisition-contracts` or
   `pnpm check:growth-contracts` as appropriate.
4. Run `pnpm check:generated-acquisition-types`, frontend tests, and the root
   build.
5. Publish a new immutable release for public Growth changes; never rewrite
   `1.0.19`.
