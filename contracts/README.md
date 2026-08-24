# AI Acquisition v1 contracts

This workspace is the normative, executable boundary for the AI acquisition
agent. JSON Schemas use Draft 2020-12 and OpenAPI describes authenticated
`/api/v1` operations.

## Growth Financial Council 1.0.12

Growth `1.0.12` publishes the closed council onboarding boundary: routing
policy GET/PUT/POST-preview, statement package POST-preview/commit,
run-from-statement-package, agent-center, and per-run agent reads. Reads and
routing preview require `finance.council.run`; routing PUT requires
`finance.council.policy.manage`; statement commands require
`ledger.pending.create`. Every POST and the PUT require `Idempotency-Key`, the
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
data. The immutable `1.0.11` release remains byte-for-byte unchanged.

## Single-source workflow

During migration, every implemented operation must remain semantically equal
to the production builder in `backend/src/acquisition-openapi.ts`. The
repository gate compares the dereferenced production and static surfaces for
the implemented-path allowlist; a runtime-backed contract change is not
complete while that parity check is red.

After `pnpm check:acquisition-contracts` is green, the static OpenAPI 3.1
document in `openapi/ai-acquisition.v1.yaml` is the release and frontend-type
generation contract. Start release-contract changes there and regenerate the
committed frontend transport types with
`pnpm generate:frontend-contract-types`. Runtime-backed operations update
the production builder and routes in the same change. An implementation plan
may explicitly reserve a contract-only route before its service lands; such a
route stays outside the drift allowlist until implementation, while any
already-implemented response it extends must retain parity. Run
`pnpm check:generated-acquisition-types` to detect stale or absent generated
output without modifying repository files.

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

Run `npm run check:acquisition-contracts` from the repository root before
changing any producer or consumer.

Only backwards-compatible optional fields may be added to v1 artifacts.
