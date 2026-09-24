# AI Acquisition v1 contracts

Platform account operations use the separate `openapi/platform-admin.v1.yaml`
contract under `/api/platform/v1`. `pnpm generate:platform-types` generates
`frontend/src/generated/platform-admin.ts`; `check:types` includes drift checks.
This API uses aggregate revision/reason commands, customer authentication plus
an independent MFA cookie, and existing cookie CSRF. It does not use Growth's
Idempotency-Key response replay protocol. It includes member creation and reset
issuance; the same contract also defines anonymous, rate-limited
`/api/auth/reset-password` consumption using a single-use token.
See `../docs/modules/platform-administration.md`.

This workspace is the normative, executable boundary for the AI acquisition
agent. JSON Schemas use Draft 2020-12 and OpenAPI describes authenticated
`/api/v1` operations.

## Growth CRM Quote and Financial Council 1.0.34

Text answers and saved assistant turns may contain `research`: completed public
query, provider, bounded sources, validated citation IDs and retrieval time.
Old turns remain valid without it. Sources are saved with the same conversation
revision as the answer; restoring history never starts another search.

Chat attachments use `attachmentScope` with a conversation UUID and role and require
`readWithModel:false`. A matching `conversationKey` accompanies the explicit document
ID on text questions. The authenticated attachment-clear endpoint removes exactly
that actor/workspace/conversation/role source; finance selections remain separate.

Growth `1.0.34` includes closed original CSV/XLSX/PDF/DOCX inspection and explicit short-lived read-only material selection for six-role questions. PDF sources use page/item references; DOCX uses paragraph/table-cell references without fabricated spreadsheet coordinates. `documentId` binds the exact actor/workspace source; missing or expired selections do not silently read a verified package. Null or omitted IDs retain the verified-package question path. Inspection returns bounded raw text/source references, not a verified BusinessReport. It preserves read-only council history and collaboration/report projections, independently persisted six-role states, cursor-based events, verified Douyin crawler attribution, human CRM quotation assessment and the Finance import JSON envelope. The closed council onboarding boundary includes routing
policy GET/PUT/POST-preview, statement package POST-preview/commit,
run-from-statement-package, agent-center, and per-run agent reads. Reads and
routing preview require `finance.council.run`; routing PUT requires
`finance.council.policy.manage`; statement commands require
`ledger.pending.create`. Those onboarding POST operations and the PUT require `Idempotency-Key`, the
PUT also requires `If-Match`, and the routing GET returns `ETag`. Exact replay
alone returns `Idempotency-Replayed: true`.

Statement commit accepts either the legacy consent-only body or consent plus a
closed `cashForecast`. The forecast contains four non-negative minor-unit
30/90-day totals, at most 100 explicit receivable rows, and the
`financial-cash-forecast.v1` management attestation. Currency, source,
accepting actor/time, and hashes remain server-owned. Consent-only commits stay
valid and return `forecastStatus: not_computable` with `cashForecast: null`.
Forecast-backed responses return only the attested totals, receivable count,
authority timestamps, and hash; customer-level receivable rows are never part
of the public projection.

All request and response DTOs reject unknown properties. Statement responses
exclude workbook bytes, base64, raw cells, and normalized business reports;
agent projections exclude credentials, prompts, provider bodies, and business
data. Earlier immutable releases remain byte-for-byte unchanged.

The read-only `POST /api/v1/finance/cfo-conversation` pilot accepts an actual
question and at most ten recent turns. It requires `finance.council.run` and
cookie CSRF, but no idempotency/ETag (it does not create a business command).
Company data is resolved by the server, not accepted in the question body. The response
has answer, model attribution, a closed verified-report or read-only-document provenance union (or null), and time. This route
does not advertise realtime audio. Schema: `cfo-conversation.v1.schema.json`.

## Single-source workflow

Outcome attribution has two closed source branches. `acquisition-run.v1`
requires nonempty shard, operation, connection and provider IDs and forbids
`jobId`. `douyin-crawler.v1` requires the real persisted `jobId`, explicit null
values for those four provider-operation fields, at least one evidence ID,
and empty `providerIds` and `queryIds`. Common run, plan version, discovery
event and qualification fields remain required. The backend resolves the
workspace/run/job/candidate/evidence chain; a syntactically valid attribution
does not grant write authority. Existing crawler discoveries with a persisted
job binding can be resolved without rewriting historical events or creating
fake provider operations.

`outcome-feedback.v1.schema.json#/$defs/runAttribution` describes the frozen
source attribution used by handoffs. `liveAttribution` also requires the
qualification decision's engine, rule and nullable model metadata. Quote,
financial and cohort `snapshotAttribution` accepts either the base snapshot
or the historical complete live snapshot. A crawler cohort member has
`firstShardId: null`; a generic member still requires a nonempty shard ID.

`POST /api/v1/finance/documents/inspect` accepts fileName/mediaType/contentBase64/readWithModel and optional analysisPurpose/attachmentScope. Attachment scope requires readWithModel=false and binds the temporary source to conversation and role.
Pure inspection requires ledger creation or council-run permission; AI reading requires council-run permission.
`DELETE /api/v1/finance/documents/selection` clears only the authenticated actor/workspace's selection and rejects body/query.
These read/selection operations require cookie CSRF but no ledger idempotency/ETag headers.

`GET /api/v1/finance/public-research` lists owned real search connections; POST accepts only query/connectionId/role and returns a source-backed model answer with up to five source snippets, URLs, timestamps and validated citation IDs. Both require council-run permission and no query parameters. POST applies cookie CSRF and a six-per-minute actor/workspace limit; it accepts no private chat or file context. The response identifies evidence as search_index_snippets, not verified full-page content.

The current immutable Growth release is `releases/growth-advisor-quote-roi/1.0.34`.
After contract checks, publish with `pnpm build:growth-contract-release`, import
it with `pnpm --filter ./frontend contract:import --release ../contracts/releases/growth-advisor-quote-roi/1.0.34`,
then regenerate Growth types with `pnpm --filter ./frontend contract:generate`.
Never overwrite an existing release directory with different bytes.

During migration, every implemented operation must remain semantically equal
to the production builder in `backend/src/acquisition-openapi.ts`. The
repository gate compares the dereferenced production and static surfaces for
the implemented-path allowlist; a runtime-backed contract change is not
complete while that parity check is red.

After `pnpm check:acquisition-contracts` is green, the static OpenAPI 3.1
document in `openapi/ai-acquisition.v1.yaml` is the release and transport-type
generation contract. Start release-contract changes there and regenerate the
committed frontend and Electron Main transport types with
`pnpm generate:frontend-contract-types`. Runtime-backed operations update
the production builder and routes in the same change. An implementation plan
may explicitly reserve a contract-only route before its service lands; such a
route stays outside the drift allowlist until implementation, while any
already-implemented response it extends must retain parity. Run
`pnpm check:generated-acquisition-types` to detect stale or absent generated
output without modifying repository files. Both commands include
`frontend/src/generated/ai-acquisition.ts` and
`desktop/src/generated/ai-acquisition.d.ts`; the desktop declaration uses the
same generator and schema, not a separate protocol definition. The dedicated
`pnpm --filter ./contracts generate:desktop-types` and `check:desktop-types`
commands operate on the desktop output alone.

## Acquisition plan execution modes

The optional plan `executionMode` defaults semantically to `generic` when it is
absent, preserving stored v1 plans and runs. Generic create requests keep the
provider-operation contract. `douyin_mediacrawler` is an explicit Douyin-only
branch: create requests carry empty `providerConnections` and `operations` and
omit or null `modelConnectionId`; persisted plans and their authoritative runs
carry `modelSnapshotRef: null`. Collection then uses plan approval,
automation GET/PUT, and `/plans/{planId}/run-now`. The generic
`/plans/{id}/runs` command is not valid for this mode. Manual automation
keywords have no search-provider or model dependency; the optional
`automation/keyword-suggestions` command retains its active-model requirement.

## Desktop Douyin synchronization

The desktop flow uses seven authenticated, active-workspace operations: one
bounded login completion, one desktop Run Now preparation, and exact job claim,
lease, page upload, completion, and cancellation operations. Cookie-authenticated
writes require CSRF protection. Login completion, desktop Run Now, and page
upload also require an `Idempotency-Key`.

Desktop Run Now returns a bounded collection task and one opaque per-job
capability. That capability is accepted only through the
`X-Shensi-Desktop-Task-Token` request header on job operations; it is never a
query parameter or request-body field. All request and success DTOs are closed.
They permit only bounded public Douyin identity and normalized public-result
data, and exclude cookies, browser/Profile paths, commands, executable names,
and Sidecar connection material.

The platform connection, capability, generic event envelope, Douyin comment
event, action-policy, and action-receipt components are schema reservations
only. They have no published routes until their implementations land in Issues
#06, #07, and #10. `DouyinCommentEvent` is the strict concrete payload behind
the generic envelope references for an `experimental_public_sample` provider;
its coverage is `public_top_level_sample`, it contains no avatar, and it does
not represent complete comment coverage. Runtime response-body validation is
also outside this migration and remains a future hardening step; the current
gate validates release schemas, builder parity, generated output, the frontend
consumer, and the packaged production start path.

## Authorized visual reader contracts

The release contract reserves an authenticated, explicitly authorized visual
reader API under `/api/v1/acquisition/visual-reader-*`. The six visual routes
and the existing Run Presentation route are implemented and remain in
static/runtime parity. The backend session/service/repository boundary,
external read-only browser reader, and Task 7 durable ingestion/projection boundary
are implemented and await independent Task 7 review. A session can read only currently visible top-level comment cards
from an exact `https://www.douyin.com/video/<digits>` page. DOM and accessibility
facts are preferred, OCR is a bounded fallback, and `vision` is reserved in the
enum but remains disabled until a separate connector and data-transfer review.

Session creation accepts only `runId` and `artifactUploadEnabled`. The server
derives the Plan, PlanVersion, platform, authorization clock, expiry, coverage,
and final limits. Limits are closed at 10 videos, 30 observations per video, 5
scrolls, 10 OCR calls, and 120,000 ms. A batch contains at most 20 observations
and at most 5 optional redacted WebP crops; visible text is bounded to 2,000
characters and each decoded crop to 256 KiB. Client submissions cannot provide
server-owned observation or hash fields and reject unknown fields such as
Cookie, headers, network responses, HTML, browser configuration, fingerprints,
avatar URLs, or full-page screenshots.
Each submission and normalized observation has required nullable `domTextHash` and
`ocrTextHash` fields in canonical `sha256:<64 lowercase hex>` form. They persist the
client's text-source provenance without replacing the normalized observation's separate,
server-owned `textHash`. The service and repository require the hash corresponding to the
final DOM/accessibility/OCR extraction method to equal the normalized visible text.

JSON Schema validates Douyin source URLs, video IDs, public profile links,
`secUid` values, and session IDs independently. Because Draft 2020-12 cannot
compare sibling values, the service must verify that the URL video segment
equals `videoId`, a public profile agrees with `secUid`, and route, session, and
normalized observation session IDs agree before persistence. No `$data` or
custom schema keyword is used.

The artifact read returns only `image/webp` binary with `private, no-store`,
`nosniff`, and restrictive CSP headers. Raw page screenshots, image bytes in
JSON, authentication material, private messages, comments, likes, follows,
publishing, and CRM write actions are outside the contract. Run Presentation
keeps its existing seven public-comment automation steps and may add one
server-derived `authorizedVisualReader` summary with exactly five visual steps;
absence remains valid for older Runs and Runs without a visual session. The
summary keeps one controlling session for compatibility and requires
`sessionCount`, `aggregateStatus`, and capped `aggregateUsage` across at most
1,000 scoped Run sessions. The controller is the newest active session, or the
latest terminal session by authorization time and session ID. Work totals come
from an untruncated repository aggregate; zero observations is
`no_visible_comments`, never a customer conclusion.

Every accepted normalized observation atomically queues one durable visual
ingestion item before downstream processing. Automatic processing creates the
literal Evidence ID `visual:<observationId>:evidence:<textHash>` with closed
`authorized_visual_observation` provenance and restricted access. Generic
Evidence append cannot create that provenance. Public-event promotion requires
a complete verified Douyin public-comment input and reuses the existing public
comment ingestion saga; otherwise visual-only identity stays isolated or enters
manual review. Visual work completion shares the existing acquisition unit of
work, while a separate leased recovery sweeper retries persisted work without
logging observation text or personal fields. Every claim receives a fresh
opaque lease token and incremented attempt generation; completion and failure
must atomically match both values and finish strictly before lease expiry, so an
expired or exact-expiry result cannot commit after the same worker reclaims the
observation. Fresh queued work has attempt zero; running, retry, and terminal
work requires at least one claim attempt, and contradictory stored lifecycle
facts fail closed.

Acquisition plans may optionally version a `douyinPublicCommentSample` policy.
Legacy plans without it remain valid and sampling is disabled by absence. An
enabled policy requires `targetPlatform: douyin` and is bounded to 20 videos,
100 comments per video, and 5 pages per video. It must also version at least one
active `content_fetch` provider connection whose provider ID is exactly
`experimental_public_sample`; runtime execution must apply the stricter of
these plan values and its server limits. Plan create, update, and revision
request contracts expose the same four-field policy; create requests enforce
the provider binding directly, while mutations are validated after merging
with the current plan.

Run execution resolves that policy from the immutable plan version. Search
shards enrich only complete `search_result` evidence bound to the current
provider connection, exact query, owner and team whose provenance contains a
direct Douyin video URL. The Run worker asks the tool executor for this internal
tenant-scoped projection; ordinary tool responses continue to omit owner and
team fields. Provider HTTP retries consume the real request budget, including
responses that fail JSON, payload, normalization or source validation;
cross-page comment and cursor state is local to one enrichment call. Comment
candidates are merged and deduplicated before the existing candidate pipeline.

Content-fetch page execution and caller-scoped comment enrichment are separate
durable facts. Each direct or Run/shard caller has a persisted policy, remaining
budget, lease, retry/backoff state and terminal summary. An explicit user create
persists the fixed one-video, 30-comment, three-page standalone intent in the
same operation write; Run callers retain their own immutable Run/shard context.
Startup and periodic recovery resume pending executions without caller replay,
isolate poison work, and never expose these internal execution records or
leases in public responses. Other non-Run background work does not start
comment sampling. The built-in connection is accepted only with canonical ID
`douyin-public-comments`, provider `experimental_public_sample`, active
`content_fetch` kind and credential version 1.

The standalone sampling intent is part of the immutable versioned request hash,
so replaying one idempotency key with a different intent fails closed. A base
page fetch that fails or has no final URL terminally fails its claimed comment
execution with `BASE_CONTENT_FETCH_FAILED`; recovery never reclaims that
context. Repositories admit at most 1000 caller executions per operation, and
MySQL reads validate deterministic execution identity plus every queued,
running, succeeded and failed state/lease combination before returning a row.

Every terminal per-video fetch attempt persists its bounded first-result
projection: transport requests, duration, event/evidence/candidate identifiers
and aggregate counts. Exact replay aggregates that projection without another
Provider or ingestion call, including after a MySQL restart or when the visible
comments later change. Legacy terminal attempts without the optional projection remain
readable and use their already-persisted terminal counters conservatively;
they are never silently refetched.

Public operations expose only the caller-appropriate bounded
`commentSampleSummary`. `candidateCount` exactly equals the unique
`candidateIds` length; `partial_success` preserves original page evidence and
successful comment results. `no_public_comments` remains an explanatory empty
coverage result and does not increment failed-result counts. MySQL startup uses
a dedicated advisory-locked migration session before recovery and upgrades the
legacy content-fetch status check before workers can persist partial success.

Run presentation exposes a fixed seven-step automation projection plus at most
50 latest public comment signals. Candidate pagination keeps its signed cursor;
the comment window is independent and cannot move that cursor. The immutable
plan version must be a Douyin plan with public comment sampling enabled;
otherwise all seven comment-automation steps are explicitly skipped. Discovery
times come from persisted `shard.started` and terminal shard events, fetch times
come from fetch attempts, and steps without their own lifecycle facts return
null timestamps rather than borrowing another step's clock.

Run totals aggregate every attempt, including attempt 101 and later, while
candidate and signal fact reads use a 10,000-item hard guard. Valid demand is
reclassified from the immutable comment event and excludes negative or
do-not-contact candidates. Unresolved actors are deduplicated by the aggregated
public actor candidate across the whole Run. A comment card is published only
when its scoped candidate and evidence both exist, the candidate owns the
evidence ID, and the evidence matches the event's platform, access status,
content hash, provider version, coverage, platform comment ID, and source URL.
The candidate must be an individual whose strict Douyin secUid, normalized
handle, or comment-scoped public actor key identifies the same event actor.
Only S/A decisions without hard-gate failures or do-not-contact state count as
high intent; an unresolved strong public signal remains explicitly marked as
needing identity research. Comment projections never expose an avatar.

Public Douyin comments enter the acquisition domain as immutable comment
events and `DiscoveryEvidence` with `platform_public_event` provenance. That
provenance is closed to the public source URL, platform comment ID, provider
version, and `public_top_level_sample` coverage; it is valid only for an
`individual_signal` with `public_content` access. Candidate aggregation treats
`douyin:sec_uid:*` as a stable public key that still needs identity research,
uses normalized `douyin:handle:*` only as a temporary key, and isolates
identity-less comments with `unmergeable:douyin:comment:*`. None of these keys
asserts a verified customer identity.

Each provider capture keeps the real provider-page `rawArtifactHash` on its
immutable observation. The event repository also persists the first exact,
bounded public text, observation ID, page artifact hash, publication context,
and public actor/source context for every `eventId + textHash` content version.
Discovery evidence is built from that persisted first version: its
`sourceSnippet` preserves the exact bounded public text and its
`rawArtifactHash` references the real first provider-page artifact. Later page
artifacts for the same event/text hash therefore produce byte-equivalent
evidence while each observation remains traceable to its own provider page.
Candidate identity facts always come from the stored immutable event.

Comment ingestion combines a durable restartable saga with a shared completion
unit of work. The event repository first atomically stores the event,
observation, content version, and pending saga. Evidence, Domain idempotency,
candidate/audit state, candidate-directory entry, Run link, and committed saga
then complete together: memory compositions use coordinated serialized
snapshots and MySQL compositions use one connection and one database
transaction across Domain, event, and directory repositories. A completion
failure restores every successful projection to its prior state while retaining
the pending saga for a restart-safe recovery sweeper; callers do not need to
replay the ingestion request. Pending work is excluded from successful Run
projections.
An exact retry resumes from deterministic step identities. Later signals for an
existing individual candidate append evidence, merge bounded deduplicated
demand summaries, advance buying stage only by its explicit order, and retain a
stable union of negative signal codes without overwriting identity facts.

Recovery persists only stable non-PII error codes. Diagnostic callbacks receive
a bounded envelope containing the recovery stage, attempt, and irreversible
saga hash, never the source error, comment, actor identifier, source URL,
message, or stack. MySQL startup applies schema before the first sweep; legacy
saga columns are discovered through `information_schema.columns` and migrated
with fixed allowlisted `ALTER TABLE` statements. A dedicated connection holds a
fixed migration advisory lock across table creation, column backfill, and exact
pending-index inspection/rebuild, so concurrent application startup re-reads
completed state instead of racing DDL. Advisory-lock cleanup requires
`RELEASE_LOCK` to return exactly `1`; any cleanup error poisons and destroys the
session instead of returning it to the pool. Memory completion and standalone
individual ingestion use the same `CandidateDirectory -> Domain -> Events`
lock order; nested repository transactions reuse their active context.

### Desktop outreach bridge

The canonical acquisition OpenAPI publishes installation enrollment and
registration, account binding, device claim/completion/recovery and a read-only
binding-status GET. The Backend OpenAPI builder consumes these six canonical
mutations plus the scoped read; frontend and desktop types are generated from
the same file. Do not maintain an independent
Renderer DTO or a second abbreviated recovery request.

All six mutations require the admitted build digest. Enrollment and binding use
user authentication and cookie CSRF; registration uses its enrollment token;
device operations use installation ID and device token. Completion additionally
requires a task token; claim and recovery reject that header. Build admission
does not grant any of these authorities. The recovery request is a strict
phase union: only `sidecar_completed` requires and permits `receiptHash`.
Device credentials and task tokens never appear in public action projections.

Binding status requires user/workspace capability and that user's active
installation. Its closed projection contains only `accountId`, `executorMode`,
`bindingGeneration`, `leaseExpiresAt`, `ownedByInstallation` and
`hasUnresolvedActions`; it never renews the lease or returns a device hash/handle.
Public actions expose persisted `executionTarget` (optional for historical
server responses) and the existing `claimed`/`reconciliation_required` states.

The unreleased desktop bridge recovery response is the closed union
`waiting | terminal | released | reconcile | not_authorized`. `released` carries
the exact action ID, task request hash and original lease version; it proves
only that this old claim never started and its authority was revoked. It has no
receipt or task token and cannot authorize a platform write. Both generated
consumers and the actual router projection must change together. Durable central
start/receipt evidence can recover a lagging local `claimed` phase; it cannot
restore the old write fence.

Run `npm run check:acquisition-contracts` from the repository root before
changing any producer or consumer.

Changes to v1 artifacts must preserve existing valid shapes. Additive optional
fields or explicitly versioned source branches must retain each existing
branch's validation and ship with regenerated consumers and a new immutable
Growth release when shared Growth schemas change.
