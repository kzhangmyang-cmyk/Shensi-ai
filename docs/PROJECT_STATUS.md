# Project Status

This file is the sole current progress ledger for the canonical `shensi`
repository. Test results are evidence only for the commit and environment in
which they were run; historical checkboxes and reports do not update this
ledger.

## Completed

- The standalone repository was created on `main`; its imported source commit
  and legacy repository are recorded in `docs/SOURCE_PROVENANCE.md`.
- The root source boundaries remain `frontend/`, `backend/`, and `contracts/`.
- The checked-in Growth contract release remains `1.0.12`.
- Growth real mode propagates the bootstrap-selected concrete workspace to all
  downstream requests. Product catalog, quote-case selection, finance cost
  estimates, ROI cohorts, advisor, agent center, and financial council routes
  therefore open inside the same authorized workspace; empty collections render
  as empty states. Expected HTTP/capability failures keep their real status and
  code instead of being collapsed into an internal error.
- The current AI reading path, machine-checkable context contract, and five
  module guides are present; older root `docs/superpowers/{plans,specs}` files
  are archived outside the current reading path.
- The obsolete unauthenticated surface has been replaced by the Shensi
  enterprise login. It starts with empty credentials, preserves the existing
  server authentication and CSRF interfaces, and restores only sessions
  validated by the server.
- The canonical production topology is `deploy/compose.yaml`: MySQL, backend,
  frontend, and a single public gateway service use an internal Compose
  network. Production backend persistence is MySQL only.
- Canonical `./scripts/dev`, `./scripts/deploy`, and `./scripts/verify`
  wrappers validate real MySQL/security configuration, fail closed for ports
  and production secret-file permissions, use file-only production settings,
  and keep verification output free of environment values.
- Encrypted backup, empty-target restore, source-to-`shensi` orchestration, and
  closed non-secret data-verification tooling are present. The tools stream
  through explicit child-process argument arrays, authenticate the complete
  anonymous ciphertext snapshot before restoring from that same FD, reject
  unsupported source objects and every target schema-object type, and never
  create a plaintext dump or provide a database-drop path. Verification uses
  allowlisted non-sensitive digests and aggregate ciphertext-row identities;
  password hashes and raw credential bytes are excluded.
- The restore-boundary database-copy stage from `shensi_sales` into the
  distinct `shensi` database completed at `a681c123`. Closed verification
  matched 237 tables and 170 rows plus stable identities, model projections,
  and aggregate encrypted-row identities. The first target-backend startup
  added one deterministic `system_migration` model-activation audit row; a
  second restart added nothing further. An operator-authorized target-only
  identity binding then preserved the restored connection owner/team and
  credential AAD while binding the supplied login to that owner. The bounded
  Task 7 verifier logged in once, loaded the exact restored
  `deepseek-v4-pro` connection, and made exactly one successful provider
  health call. That call added one immutable job snapshot and one model-call
  ledger row, leaving the current target at 237 tables and 173 rows while the
  unchanged source remains at 237 and 170. The task-owned backend was stopped
  and port `4192` released. Authenticated encrypted backups were retained and
  temporary migration accounts were removed. Current non-secret evidence is in
  `docs/migration/2026-08-24-live-migration-verification.md`.
- Task 7 is complete: its encrypted backup, distinct-target restore, closed
  restore-boundary comparison, isolated MySQL health, authenticated login,
  restored-connection visibility, and single bounded DeepSeek health gates
  all passed. No traffic cutover or legacy-process shutdown occurred.
- Acquisition publishes workspace-bound Douyin automation policy `GET`/`PUT`
  and idempotent run-now commands. Immutable policy versions sit behind a
  compare-and-swap head. Each durable automation intent freezes the approved
  plan, policy, active-account/login, local-date, and daily-budget identities
  and is transactionally bound to a distinct authoritative `AcquisitionRun`.
  The public result exposes both identities and never exposes the private
  MediaCrawler account handle.
- Acquisition plans now distinguish the compatible generic provider-operation
  mode from `douyin_mediacrawler`. A MediaCrawler plan is Douyin-only, carries
  no public-search provider, generic operation, model connection, or model
  snapshot, and can run only through the approved automation-policy/run-now
  path. Generic plans retain their existing provider, operation, trusted-model,
  and shard-run requirements. Manual MediaCrawler keywords therefore require
  neither a public-search API nor AI; server-generated keyword suggestions
  remain an optional AI-backed convenience.
- Authoritative Douyin runs feed one crawler job per workspace/plan/policy/day.
  Every run alias is validated together with its bound automation-intent alias.
  Exact pair replay performs no write, mixed or reused aliases fail closed, and
  each genuinely new pair increments a private alias generation for the shared
  daily job. Random fenced crawl and terminal-ingestion leases, transactional
  non-cyclic opaque cursor history, frozen record-kind filters, and bounded
  recovery have Memory/MySQL implementations. The sidecar publishes immutable
  pages during the crawl; Node consumes the advertised page count, persists each
  cursor/page first, and atomically projects evidence, candidates, identity
  aliases, audits, a running run state, and run-candidate links before terminal
  completion. A terminal startup snapshot is never written through the
  nonterminal activity path; completed activity becomes durable only with the
  advertised `done` page and terminal metadata transaction. Upstream interruption
  after published records produces a durable partial job instead of resetting
  the record count. Each runner invocation confines its request, activity, and
  JSONL files to a random owner-only `0700` attempt directory. Resumed jobs seed
  record de-duplication from IDs in persisted pages, so stale attempt files and
  repeated records are not republished; acknowledgement cleanup removes the
  whole job output root. Stable record edits supersede across jobs; content is
  unique per workspace. Each record and evidence row retains its exact page
  cursor and explicit creator/commenter discriminator.
- Terminal ingestion replays all persisted records under a generation-bound
  random fence. One serialized heartbeat renews the same lease through domain
  projection and sidecar acknowledgement; generation and lease authority are
  checked before projection, before acknowledgement, and after acknowledgement.
  A new alias pair does not clear an active ingestion lease: the owner defers
  the job to pending when it observes the changed generation, while the
  completion transaction also prevents a post-ack race from marking stale work
  ready. For a succeeded or partial crawl, candidate projection becomes ready
  only after ingestion succeeds and the projected generation equals the current
  alias generation. Late same-day pairs therefore project persisted facts into
  the added authoritative run without recrawling. Fair cross-workspace claims
  and alternating crawl/ingest lanes bound tenant and ingestion starvation.
- The private sidecar keeps result pages until Node durably ingests them and
  acknowledges the job. The acknowledgement timestamp survives restart and
  starts the 24-hour page and bounded upstream-capture cleanup clock. Public
  actor identity comes from the real author fields, never from the anonymous
  upstream `creator_hash`. Unlinked evidence is retained for 90
  days from backend ingestion; linked evidence, permanent one-way Douyin DNC
  identities, and audit records are preserved. Default run candidate feeds
  exclude DNC candidates; the same default exclusion applies to general and
  priority candidate readers. Existing MySQL installs backfill bound legacy
  intent JSON, separate old mixed aliases, widen run aliases to the core
  160-character run-ID boundary, and fail closed on unmappable rows. Hydration
  requires duplicate-free run/intent alias vectors of the same length, an
  explicit alias generation equal to that length, and a projected generation
  within it. A legacy single-pair succeeded job
  may infer a ready `1/1` projection only when both generation fields are
  absent. A half-migrated row with only one field, a multi-pair row missing
  either field, or an explicitly under-projected succeeded row is
  conservatively reopened for projection. Browsers
  read only persisted Node projections at
  `GET /api/v1/acquisition/runs/{runId}/crawler-status` and
  `GET /api/v1/acquisition/runs/{runId}/candidates`. Crawler failure persistence
  and public projection normalize unknown, legacy, or raw worker failures to a
  closed stable code; credential-bearing exception text is never stored or
  returned.
- The backend and Shensi sidecar adapter are operated as one private protocol
  unit. The crawler worker reads and adopts an existing deterministic sidecar
  job before considering create, so retained pages are projected without a
  repeated external crawl. Legacy compatibility is limited to terminal
  `succeeded`/`partial` descriptors without activity, which become the closed
  `completed` / `headless` / sequence `1` observation; live descriptors remain
  strict. Health proves liveness, not gateway/adapter schema compatibility.
  Backend jobs paused at their attempt limit require an audited explicit
  requeue and are not silently recovered by restart. MySQL `DATETIME(3)` values
  in this lifecycle use one UTC-derived, timezone-free driver binding format.
- Douyin keyword suggestions now derive business and ICP context, workspace,
  and the active official model snapshot on the server. Draft generation is a
  private application-composed boundary backed by the real domain and DNC
  repositories. It parses normalized refusal/minor phrases, binds candidate
  revision/evidence hashes to the snapshot, rejects ICANN-recognized ASCII,
  Unicode/IDN, and punycode domains while allowing grounded dotted product
  names without a public TLD, and permits only fixed safe template clauses or
  complete phrases grounded in one evidence row. Memory shares the DNC writer
  coordinator; MySQL locks and reads candidate, exact evidence, and the DNC
  key/gap on one connection. Custom domain/crawler repositories may inject the
  same tenant-scoped atomic final-authority port; without one, application
  startup remains compatible and only Task 6 draft generation fails closed
  before model traffic. The service returns a deeply immutable authority
  projection, recomputes immutable content hashes, and discards raw model
  output. Draft persistence remains exclusively with the later outreach-batch
  revision authority.
- Outreach batches persist those Task 6 values as immutable candidate draft
  revision 1 and append validated human edits as revision 2 without changing
  source-model provenance. Public create/read/revise/approve/reject/pause/
  resume/action routes enforce workspace, capability, CSRF, idempotency, and
  ETag authority. When external actions are explicitly enabled, approval is the
  required human second confirmation and executes nothing: after account/login,
  DNC, candidate/evidence, and selected policy-limit rechecks, it atomically
  stores the approval plus an exact queued comment and predecessor-blocked
  direct message per candidate. Memory and MySQL roll back approval if either
  action insert fails; MySQL reuses one locked authority transaction connection.
  When the action gate is disabled, final approval returns
  `503 outreach_actions_disabled` before approval or action persistence.
- Approved outreach actions now execute through an application-owned fenced
  worker and recovery sweeper only when the private MediaCrawler gateway is
  configured and `DOUYIN_OUTREACH_ACTIONS_ENABLED` is case-insensitively
  exactly `true` at both backend and sidecar. Every other value is disabled:
  the backend starts neither action claimant nor recovery sweeper, the sidecar
  returns a stable 503 before manager/executor lookup, and the crawler worker
  continues normally. Enabled claims serialize each account and persist
  server-time delays of at least 60 seconds between actions and 180 seconds
  from comment receipt to direct message. The worker revalidates active
  account/login, approval,
  candidate/evidence, DNC, content, predecessor, policy/job/budget, and daily
  allowance authority before each call. The sidecar reuses the encrypted
  authenticated profile, submits the exact approved text once to the frozen
  public target, and returns a sanitized receipt. Fenced recovery prevents
  stale writes; three consecutive failures or an immediate platform-risk state
  pause the account and all queued work. Focused fake-page, Memory, and live
  MySQL 8.4 gates exercise this behavior without making a real Douyin action.
- The authenticated `#acquisition` dashboard now makes controlled Douyin
  collection the primary workflow. With no existing task it still loads the
  workspace account and can create, approve, configure, and optionally run a
  MediaCrawler-only plan from a plan name plus manual keywords. It connects or
  reconnects a workspace account by expiring QR session, edits and enables
  keywords/local schedule/timezone/daily candidate limit, starts one run-now
  command, and renders only persisted crawler status, creator/commenter
  candidates and public evidence. Task overview hydration preserves the latest
  authoritative run ID; refresh or verified-session restoration uses it as an
  independent `activeRunId` to reload crawler status and candidates. That run
  ID also scopes creation of an editable pending-approval batch without
  fabricating a new run-now intent. A duplicate run remains blocked until the
  recovered persisted state is confirmed. Recovery itself creates or approves
  no batch and sends no comment or direct message; those actions still require
  explicit second confirmation, the explicit backend/sidecar action gate, and
  the fenced executor. The real-customer trial fixes that gate to false. The
  separate generic
  public-search entry is labelled as an optional enhancement with its
  search-API and AI dependencies.
  The real-mode header action focuses the MediaCrawler form without requesting
  those connections, and the optional wizard can return directly to that
  no-API form. Missing optional connections disable AI-plan generation before
  any request; the corresponding server race is translated into MediaCrawler
  guidance instead of exposing its internal error code. Rejected plan payloads
  preserve bounded backend validation details and show the first field path
  and reason instead of only the generic contract-error message.
  Candidate selection creates an editable outreach batch; revision conflicts
  reload current authority before another review. In an action-enabled runtime,
  explicit approval, pause/resume, and sanitized comment/direct-message receipts
  survive page reload. In this trial final approval remains unavailable and no
  action is created. Authorized
  public-link import remains a collapsed secondary fallback. The existing
  Shensi shell, session/CSRF behavior and accessible navigation are preserved;
  desktop uses a table with evidence inspector, while narrow viewports use
  one-column candidate cards and normal body scrolling.
- An authenticated real session now routes `#conversations` to a read-only
  Douyin public-interaction projection instead of the browser-local seeded
  inbox. It reads the existing acquisition overview and each task's latest-run
  candidate page, renders the persisted public excerpt and source link as
  candidate evidence, and reports failed runs or an unconsumed next cursor
  without substituting demo rows. The surface explicitly says it is not a
  platform private-message inbox. Its reply field and send button are disabled;
  no comment, reply, or direct-message command is wired. The existing outreach
  API can read actions only when a batch ID is already known and has no
  run-to-batch listing route, so this page states that receipt boundary rather
  than guessing or fabricating receipts. Demo sessions retain the deterministic
  local conversation preview.
- Visible local MediaCrawler observation is a dedicated standard-Playwright
  Douyin window when `MEDIACRAWLER_BROWSER_HEADLESS=false`; Shensi disables CDP,
  while production may set headless mode to `true`. Its visible tab is a
  separate best-effort mirror of the approved keyword and public video, not the
  collector page. It uses at most one unfinished observation task outside the
  collector's critical path, so a hung mirror cannot block collection or create
  an unbounded navigation backlog. The deterministic request client remains the
  data authority, so observation navigation cannot create results. The manager
  publishes truthful launch activity, deduplicates equivalent snapshots,
  atomically persists a final-page descriptor with completed terminal activity,
  and requeues safely paused sidecar work for a later resume. The persisted
  public crawler status is closed to activity (phase, a null or exact approved
  keyword of at most 100 Unicode code points, visible/headless mode, and
  monotonic sequence) plus `candidateProjectionState` (`pending`, `ready`, or
  `failed`); hydration and public projection revalidate the keyword, and the
  response excludes raw ingestion state, leases, raw URLs, profile paths,
  cookies, headers, selectors, CDP/WebSocket endpoints, browser identifiers, and
  raw logs. Every dashboard refresh validates status before reading candidates,
  so live candidates may appear before readiness; `ready` is the ordering
  boundary for the final candidate read. Zero candidates with terminal `ready`
  is valid, and a candidate-read failure does not discard a validated terminal
  status; it receives at most three exponentially backed-off retries before the
  poller stops. Paused, failed, and cancelled crawler jobs now project the same
  recognizable state into active authoritative run aliases. Overview keeps the
  newest run status while also publishing the latest run with persisted candidate
  links, so a newer stopped zero-result run cannot hide prior candidates. The frontend rejects
  non-primitive enum values and recursively accepts candidate pages only when
  the page is exactly `{items,nextCursor}`, each candidate is exactly
  `{id,status,displayName,evidence}`, and evidence is exactly
  `{sourceUrl,excerpt}`. Pages contain at most 100 candidates; IDs and statuses
  are nonempty, display/excerpt/cursor values obey their Unicode bounds, and a
  non-null cursor is nonempty. Evidence URLs require a raw HTTP(S) authority and
  hostname and reject credentials, backslashes, whitespace/control/format
  characters, malformed percent escapes, and parser-repaired authority forms.
  The pre-status queued placeholder announces once per outstanding run. The UI
  prevents duplicate submission until the current intent is observed and no
  longer pending. Manual automation keywords still require neither a public-
  search API nor AI. Comment and direct-message approval remains human approved;
  no automatic external action was run.

- The complete trial frontend surface is present. All nine primary entries are
  visible: 自动营销总览、获客中心、社媒对话、私域客户池、成交工作台、智能体中心、
  自动工作流、外贸营销、设置中心. The sidebar also exposes
  `#growth/advisor`, `#growth/catalog`, `#growth/quotes`, `#growth/finance`,
  `#growth/roi`, and `#financial-council`. Real API/MySQL pages retain their
  authority; local-only and pending integrations remain visible with the exact
  `预览 · 待接入` label and never present local fixture values as live results.
  A trial-only exact alias maps `test` to `test@shensi.local` only when all three
  Vite trial values are complete; unmatched identities and passwords remain
  unchanged, and incomplete enabled configuration fails before login traffic.
- Deployment MediaCrawler now requires an absolute, existing, non-symlinked,
  current-user-owned `0700` `MEDIACRAWLER_CRAWL_OUTPUT_ROOT` strictly inside,
  and not equal to, `MEDIACRAWLER_ENCRYPTED_VOLUME`. Runner creation and cleanup
  use that one resolved root. The Compose and development boundaries pass the
  same root and default the two-layer action gate to false.
- The isolated trial tooling is available through `trial:prepare`,
  `trial:start`, `trial:status`, `trial:verify`, and `trial:stop`. It uses the
  ignored `.runtime/real-trial/` root and fixed loopback ports `3310`, `5608`,
  `5610`, `5611`, and `5612`; only gateway `5608` is eligible for the temporary
  Quick Tunnel. Runtime, secret/state, log, PID, MySQL, profile, and crawl-output
  paths are owner-only. Each long-running service is launched under a detached
  nonce-bearing wrapper; status and stop compare its exact macOS `ps` command
  line before signalling the process group. Stop waits after TERM, revalidates
  before any bounded KILL escalation, and does not repurpose the protected older
  local services. `trial:verify` reads the owner-only runtime status origin by
  default rather than requiring an additional environment value.
- The 2026-08-25 visible-Chrome QR login and later 305-record/13-candidate
  ingestion recovery remain useful **pre-trial historical local evidence**.
  They used an earlier local runtime, made no comment or direct-message action,
  and are not acceptance evidence for the isolated trial ports or public link.

## Active

- The isolated real-customer stack is running behind a temporary HTTPS origin
  reported only by `pnpm trial:status`. Fresh source/build gates, six-process
  lifecycle status, local/public route isolation, tenant-admin login, and a
  MySQL-backed CRM write/restart/read/cleanup cycle passed on 2026-08-26. The
  public browser shows the current Shensi login surface.
- Authenticated full-page visual inspection and an authorized Douyin QR
  scan/manual-keyword collection remain customer-interactive acceptance work;
  they do not authorize an external comment or direct message.
- Dedicated-account external-action acceptance remains outside this launch.
  `DOUYIN_OUTREACH_ACTIONS_ENABLED=false` is fixed for the trial; no CAPTCHA is
  automated and no real comment or direct message is authorized.

## Blocked

- Docker Engine and Docker Compose are unavailable in the current execution
  environment (`docker` is absent from `PATH`; Colima is installed but reports
  `colima is not running`), so Compose rendering and image builds remain an
  exact production-deployment blocker requiring a Docker-equipped environment.
  This does not block the separate non-Docker local trial supervisor.

## Next

1. Have the customer log in through the current `trial:status` origin and finish
   the authenticated all-module visual walk-through.
2. Stop at QR-ready if the customer is not present. After an authorized scan,
   verify one manual-keyword collection and persisted candidates while keeping
   the external-action flag false.
3. Only after those checks pass may the operator retire the old static link;
   `trial:stop` must stop only validated trial process groups and retain data
   until the documented export/profile retention decision is complete.
4. Separately, in a Docker-equipped environment, render and build production
   Compose and inspect its private networks and health/shutdown behavior.

The two executing design/plan documents are retained under
`docs/superpowers/` until final acceptance, but they are not progress authority.
