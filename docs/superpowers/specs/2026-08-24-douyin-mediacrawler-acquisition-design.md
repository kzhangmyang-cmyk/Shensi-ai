# Douyin MediaCrawler Acquisition Design

Status: approved in conversation; awaiting final written-spec review

Date: 2026-08-24

Repository: `shensi`
Scope: Douyin only

## 1. Purpose

Shensi will add a real, recoverable Douyin acquisition flow backed by an
authorized MediaCrawler runtime. The first release discovers public Douyin
videos, creators, and demand-bearing comments; turns those signals into
workspace-scoped candidates; generates candidate-specific outreach drafts;
requires one approval per batch; and then executes at most one public comment
and one direct message per approved candidate.

The default daily limit is 50 candidates per connected Douyin account. A
customer may choose a value from 1 through 200. Collection may run on a daily
schedule or by an explicit "run now" command. Outreach never starts merely
because collection completed.

## 2. Third-party provenance and license boundary

The authorized source is
[`NanmiCoder/MediaCrawler`](https://github.com/NanmiCoder/MediaCrawler), pinned
initially to upstream commit
`d6f7c5bb906b6dac40ddf343ef9e26438a3de092`. MediaCrawler carries the
`NON-COMMERCIAL LEARNING LICENSE 1.1`; the operator has stated that written
commercial authorization has been obtained. The implementation must preserve
the upstream copyright and license notices and record the authorized fork,
upstream commit, and authorization reference in the third-party provenance
document. The authorization document itself must not be committed if it
contains private legal or contact information.

MediaCrawler is imported as a pinned, authorized fork under
`services/media-crawler/`. Shensi-specific changes live in a small adapter and
extension layer with a documented upstream merge procedure. Upstream source is
not copied into the Node backend.

## 3. Goals

- Connect one Douyin account per workspace through a Shensi-rendered QR login
  flow.
- Keep browser credentials and the persistent browser profile outside public
  APIs and outside the Node process.
- Generate editable search keywords from the customer's business, product,
  and ideal-customer profile.
- Collect both relevant video creators and commenters who express a potential
  business need.
- Normalize, deduplicate, score, and persist candidates through the existing
  acquisition evidence and candidate pipeline.
- Filter explicit refusal and do-not-contact signals before drafting outreach.
- Generate one evidence-grounded comment and one direct-message draft per
  candidate.
- Require a version-bound batch approval before any external write.
- Execute comment first and direct message second, with durable idempotency,
  receipts, minimum delays, and restart recovery.
- Pause safely on verification, authentication, rate-limit, or account-risk
  signals; never attempt to bypass platform verification.
- Preserve a platform-neutral boundary so Kuaishou and other MediaCrawler
  platforms can be added later without changing the Douyin business contract.

## 4. Non-goals

- Supporting Kuaishou, Xiaohongshu, Bilibili, Weibo, Tieba, or Zhihu in the
  first release.
- Running unapproved comments or direct messages.
- Circumventing CAPTCHA, sliding verification, access controls, account
  warnings, robots directives, or platform restrictions.
- Bulk scraping without a workspace plan, daily limit, audit trail, and stop
  conditions.
- Returning raw cookies, browser storage, full browser profiles, or raw
  credential-bearing logs to Shensi clients.
- Replacing the existing Shensi candidate, CRM conversion, attribution, or ROI
  subsystems.

## 5. Architecture

The production topology adds one internal Python service and one persistent
encrypted browser-state volume:

```text
Shensi frontend
      |
      v
Shensi Node backend -----------------------------------+
  plans, schedules, runs, candidates, approvals,       |
  action outbox, AI drafts, audit, CRM conversion      |
      | internal authenticated commands/results         |
      v                                                  |
MediaCrawler service                                    |
  QR login, browser profile, Douyin search,             |
  creator/comment collection, approved action executor  |
      |                                                  |
      +---------------- Douyin --------------------------+
```

Only the Node backend is a public business API. The MediaCrawler service is
reachable only on the private deployment network and authenticates every Node
request with a rotated service credential. It accepts closed request schemas
and returns closed result/error schemas. It does not connect directly to the
Shensi MySQL schema.

The Node backend remains the durable authority for workspace ownership,
campaign versions, schedules, limits, candidate identity, approvals, action
ordering, idempotency, and audit. The Python service owns browser processes,
the encrypted login profile, collection mechanics, and one-at-a-time Douyin
browser actions.

## 6. Component boundaries

### 6.1 Authorized MediaCrawler fork

The fork retains the existing Douyin crawler and FastAPI process-management
capabilities. A Shensi adapter adds:

- workspace-opaque account handles;
- QR-session creation and sanitized QR/status reads;
- encrypted per-account persistent browser directories;
- closed crawl-job commands and cursor-based normalized results;
- closed single-action commands for an approved comment or direct message;
- health, readiness, heartbeat, cancellation, and bounded shutdown;
- structured error codes without raw page bodies, cookies, or message text in
  logs.

The upstream crawler remains responsible for search, video, creator, and
comment reads. The action executor is a Shensi extension and must not be
presented as an upstream MediaCrawler feature.

### 6.2 Node integration gateway

A dedicated `DouyinMediaCrawlerGateway` translates Shensi commands to the
internal service. It enforces timeouts, response schemas, account/workspace
bindings, result-size limits, content hashes, and cancellation. It never
accepts a service URL or account handle from a browser request.

### 6.3 Durable orchestration

Existing acquisition plans, runs, operation shards, discovery evidence, and
candidates remain authoritative. New repositories bind crawler jobs and
outreach batches/actions to those records. Workers use random lease tokens,
strict expiries, fenced writes, bounded retries, and restart sweepers.

### 6.4 AI generation

The existing active model gateway generates:

- editable discovery keywords from the business and ideal-customer profile;
- demand summaries and candidate scores from normalized public evidence;
- one candidate-specific comment and one direct message.

Prompts contain only the minimum evidence required for the candidate. Model
output cannot approve or execute an action. Server validation enforces length,
forbidden claims, forbidden words, opt-out handling, and exact candidate and
evidence bindings.

## 7. Login and account lifecycle

One workspace may connect one Douyin account in the first release.

Account states are:

```text
disconnected -> awaiting_scan -> active
awaiting_scan -> expired
active -> login_expired | risk_paused | disconnected
login_expired -> awaiting_scan
risk_paused -> active only after explicit operator recovery
```

The frontend requests a login session from Node. Node requests an opaque QR
session from MediaCrawler and returns only a short-lived QR representation,
expiry time, and status. After the scan, Node stores the opaque account handle,
display label, login-state version, and validation timestamps. Raw cookies,
local storage, and browser profile paths never cross the internal gateway.

Browser state is stored in a service-owned encrypted volume. Disconnecting an
account cancels owned jobs, invalidates its handle, removes its browser state,
and leaves historical acquisition evidence and audit records intact.

## 8. Collection lifecycle

Each enabled plan stores an immutable automation version containing:

- generated and customer-edited keywords;
- daily execution time and timezone;
- daily candidate limit, default 50 and range 1 through 200;
- collection of creators and demand-bearing commenters enabled;
- maximum videos, comments per video, pages, duration, and request budget;
- negative-signal and forbidden-topic policy versions;
- connected account and login-state version;
- model snapshot used to produce keywords and scoring policy.

Collection job states are:

```text
scheduled -> queued -> running -> succeeded
                         |       -> partial
                         |       -> failed
                         +------ -> paused
queued | running -> cancelled
```

The scheduler creates at most one daily run for a plan version. "Run now" uses
a separate idempotency key but the same daily candidate budget. MediaCrawler
runs with one browser concurrency per account. Results are pulled by cursor and
acknowledged only after the Node transaction persists their normalized
evidence and cursor.

Every normalized result contains a platform record ID, type, canonical public
URL, public display fields, bounded text excerpt, source keyword, observed
time, upstream content hash, and job identity. Node rejects cross-job,
cross-account, duplicate, reordered-cursor, oversized, or malformed results.

## 9. Candidate qualification

Creators and commenters enter the existing canonical-subject and discovery
evidence pipeline. Qualification uses public evidence only and records why a
candidate was selected. It must:

- deduplicate stable platform identities and canonical URLs;
- bind every summary and score to persisted evidence hashes;
- distinguish creator and commenter candidates;
- suppress already-contacted identities according to the retention policy;
- reject candidates carrying refusal, do-not-contact, complaint, minor, or
  otherwise prohibited signals;
- avoid treating follower count, engagement, or AI inference as verified
  company identity;
- permit human exclusion and permanent do-not-contact marking.

## 10. Approval and action lifecycle

An outreach batch freezes the candidate set, evidence hashes, exact comment and
direct-message drafts, policy version, model snapshot, daily limit, and batch
content hash.

Batch states are:

```text
draft -> awaiting_approval -> approved
                         |-> rejected
                         |-> expired
approved -> paused -> approved
approved -> completed
```

Editing a candidate selection or any message creates a new batch revision and
invalidates approval of the prior revision. Approval requires an authenticated
session, CSRF, `Idempotency-Key`, current ETag/If-Match, and the applicable
capability. The approval transaction writes one immutable approval record and
one ordered outbox pair per selected candidate.

Action states are:

```text
comment_queued -> commenting -> commented
                              -> failed | risk_paused
commented -> message_waiting -> messaging -> succeeded
                                          -> failed | risk_paused
```

Each candidate receives at most one comment and one direct message for the
approved batch. A message cannot be claimed until the matching comment receipt
exists and the minimum delay has elapsed. Retries reuse the exact frozen
content and idempotency identity. A message failure never repeats a successful
comment.

The executor uses one account action at a time. The backend enforces a minimum
outbound interval and may slow down further after transient failures. CAPTCHA,
sliding verification, login expiry, platform rate limiting, account warning,
or three consecutive execution failures pauses all actions for the account.

## 11. Public API

The first contract version adds these route families under
`/api/v1/acquisition`:

- `POST /social-accounts/douyin/login-sessions`
- `GET /social-accounts/douyin/login-sessions/{sessionId}`
- `GET /social-accounts/douyin`
- `DELETE /social-accounts/{accountId}`
- `GET /plans/{planId}/automation`
- `PUT /plans/{planId}/automation`
- `POST /plans/{planId}/automation/keyword-suggestions`
- `POST /plans/{planId}/run-now`
- `GET /runs/{runId}/crawler-status`
- `GET /runs/{runId}/candidates`
- `POST /runs/{runId}/outreach-batches`
- `GET /outreach-batches/{batchId}`
- `PUT /outreach-batches/{batchId}`
- `POST /outreach-batches/{batchId}/approve`
- `POST /outreach-batches/{batchId}/reject`
- `POST /outreach-batches/{batchId}/pause`
- `POST /outreach-batches/{batchId}/resume`
- `GET /outreach-batches/{batchId}/actions`

All browser inputs are closed schemas. Mutation routes require authentication,
CSRF, capability checks, semantic idempotency, and conditional revision where
applicable. Public responses expose safe display data, evidence links, closed
status/error enums, content hashes, and receipts; they never expose cookies,
browser paths, service credentials, raw platform responses, or unbounded logs.

## 12. New persistence

The minimal new MySQL families are:

- `acquisition_social_accounts`
- `acquisition_douyin_automation_policy_versions`
- `acquisition_crawler_jobs`
- `acquisition_crawler_job_cursors`
- `acquisition_outreach_batches`
- `acquisition_outreach_batch_candidates`
- `acquisition_outreach_actions`
- `acquisition_outreach_action_attempts`

Foreign keys or verified application-level bindings connect these records to
the existing workspace, plan version, run, operation shard, candidate,
evidence, provider/model snapshot, and audit identities. All timestamps are
server owned. Unique keys cover workspace/platform account, scheduled daily
run, job/result cursor, batch revision, approval command, and action
idempotency. MySQL transactions provide exact replay or conflict semantics.

## 13. Frontend experience

The existing `#acquisition` black shell gains six real surfaces:

1. **Douyin account card** — disconnected, waiting for scan, active, login
   expired, or risk paused; QR modal and disconnect/reconnect controls.
2. **Automation setup** — business/ICP summary, generated editable keywords,
   daily time, timezone, and candidate limit with 50 recommended.
3. **Live collection run** — current keyword, videos inspected, comments read,
   candidates found, duplicates removed, refusals filtered, and safe pause
   reason.
4. **Candidate workspace** — creator/commenter type, public identity, demand
   summary, score, evidence, source link, exclusion, and do-not-contact.
5. **Batch approval** — selected candidates, exact editable comment and
   message, supporting evidence, today's remaining limit, estimated duration,
   and explicit approval confirmation.
6. **Execution timeline** — queued comment, comment receipt, waiting interval,
   message receipt, failures, pause, and recovery controls.

Desktop uses a candidate table with an evidence inspector. Mobile uses a
single-column card flow. Loading, empty, expired, unauthorized, conflict,
paused, and partial-result states are explicit. Refresh, logout, browser close,
and backend restart reload server-authoritative state.

## 14. Closed failure contract

The public contract maps internal failures to safe codes including:

- `douyin_account_not_connected`
- `douyin_login_session_expired`
- `douyin_login_expired`
- `douyin_verification_required`
- `douyin_rate_limited`
- `douyin_account_risk_paused`
- `douyin_collection_partial`
- `douyin_collection_failed`
- `candidate_evidence_invalid`
- `outreach_batch_stale`
- `outreach_daily_limit_exhausted`
- `outreach_comment_failed`
- `outreach_message_failed`
- `outreach_account_paused`

Provider exception strings, URLs containing tokens, raw response bodies, page
HTML, cookies, and message contents are excluded from general logs. Operators
receive identifiers, stage, code, timestamps, attempt count, and safe metrics.

## 15. Security, privacy, and platform controls

- MediaCrawler is private-network only and runs without MySQL application
  credentials.
- Browser profiles are encrypted at rest and separated by opaque workspace
  account handles.
- Service credentials come from protected deployment secret files and rotate
  independently from customer login state.
- Node validates every sidecar response and binds it to the expected account,
  job, cursor, and content hash.
- Raw comments are retained only as bounded evidence required for qualification
  and audit. Current documentation must define the retention duration before
  production enablement.
- Do-not-contact identities are retained as one-way platform-scoped identity
  hashes plus the minimum audit reason.
- Message generation receives no cookie, browser, credential, or unrelated
  candidate data.
- Production has per-account concurrency one, daily candidate range 1 through
  200, server-owned minimum action delay, and automatic risk pause.
- No code attempts to defeat CAPTCHA, sliding verification, platform access
  controls, or account warnings.

## 16. Deployment

The root deployment gains a `media-crawler` service built from Python 3.11
with `uv`, Playwright browser dependencies, a health check, a private network,
read-only application code, a writable encrypted browser-state volume, bounded
CPU/memory, and graceful shutdown. It has no public gateway route.

Development wrappers verify Python, `uv`, Playwright, the pinned fork, service
secret availability, ports, and state-directory permissions. Production
verification checks Node-to-sidecar health without printing credentials. The
deployment guide includes QR-login operation, state backup rules, version
upgrade procedure, risk-pause recovery, and rollback to collection-disabled
mode.

## 17. Testing strategy

### 17.1 Python service

- request/response schema and service authentication;
- QR lifecycle and no-cookie responses;
- Douyin result normalization, bounds, cursor replay, and cancellation;
- action ordering and exact-content replay;
- process shutdown, browser cleanup, timeout, and structured errors;
- fixtures for verification, login expiry, rate limiting, and account warning.

### 17.2 Node backend

- domain state machines and canonical hashes;
- repository parity for Memory and MySQL;
- transaction rollback, exact replay, changed-command conflict, two-worker
  lease races, expiry fencing, and restart recovery;
- cross-workspace/account/job rejection;
- candidate evidence, opt-out, deduplication, and already-contacted rules;
- approval revision invalidation and message-after-comment enforcement;
- route authentication, CSRF, capability, idempotency, ETag, error mapping,
  OpenAPI drift, and response conformance.

### 17.3 Frontend

- QR/account lifecycle;
- keyword editing, schedule, timezone, and limit validation;
- collection progress and all closed failure states;
- candidate exclusion and do-not-contact;
- exact draft preview/edit/revision behavior;
- stale approval reload, pause/resume, and receipt rendering;
- desktop/mobile accessibility, keyboard flow, no overflow, and lifecycle
  cancellation.

### 17.4 Acceptance

A no-route-interception browser test runs Shensi, MySQL, and the MediaCrawler
service. Final external acceptance uses a dedicated Douyin test account and
requires the operator to scan the QR code. It must prove:

- login survives a controlled service restart;
- one scheduled or run-now crawl collects real creator and comment evidence;
- candidates are deduplicated and explicit refusal is excluded;
- no external action occurs before batch approval;
- one approved test candidate receives the exact approved comment and then the
  exact approved direct message;
- receipts survive Node and Python restarts without duplicate actions;
- verification/rate-limit fixtures pause instead of bypassing;
- logs and public APIs contain no cookie, browser profile, service secret, or
  raw credential data.

No production-ready claim is permitted until the dedicated-account external
acceptance succeeds. Tests must not contact unrelated real users.

## 18. Delivery sequence

1. Pin the authorized fork, record provenance, add the isolated service build,
   and establish closed internal contracts.
2. Implement QR login and account lifecycle end to end.
3. Implement crawl jobs, scheduling, normalization, existing-pipeline
   ingestion, candidates, and collection UI.
4. Implement AI keywords and outreach drafts with policy validation.
5. Implement versioned batch approval and durable action outbox.
6. Implement the single-action Douyin executor, pause/recovery, and receipts.
7. Publish updated acquisition contracts and generated frontend types.
8. Complete restart, browser, MySQL, deployment, privacy, documentation, and
   dedicated-account acceptance gates.

Each step must begin with a failing behavior test and finish with focused and
aggregate verification. No step may weaken existing workspace, credential,
provider, acquisition, CRM, financial, or immutable-release contracts.

## 19. Documentation updates required during implementation

- root `README.md` and deployment guide;
- `docs/PROJECT_STATUS.md` as the sole current progress ledger;
- `docs/ARCHITECTURE.md`;
- `docs/modules/acquisition.md`;
- third-party provenance and license inventory;
- MediaCrawler service README and upstream-update procedure;
- current OpenAPI/release documentation;
- frontend operator instructions and risk-pause troubleshooting.

Historical plans and reports must not be presented as current operating
instructions.

## 20. Acceptance summary

The feature is complete only when a Shensi customer can connect a dedicated
Douyin account by QR, schedule an automatic bounded crawl, receive creator and
demand-comment candidates, review exact AI drafts, approve one immutable batch,
observe comment-then-message receipts, and recover the same state after service
restart without duplicate external actions or credential exposure.
