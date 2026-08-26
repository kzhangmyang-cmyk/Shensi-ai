# Architecture

## System shape

Shensi is a pnpm workspace with three stable source boundaries:

- `frontend/` is the React 19 and Vite browser application. `app-entry.ts`
  starts session restoration; `app-route.ts` normalizes the hash route to the
  agent center or a supported module; `growth/router.ts` owns Growth and
  financial-council deep links.
- `backend/` is the Express application. `src/server.ts` mounts legacy CRM and
  identity routes directly, then delegates Growth and acquisition routes to
  `GrowthCommercialRuntimeBridge` and `AcquisitionRuntimeBridge`.
- `contracts/` contains the editable OpenAPI and JSON Schema sources,
  immutable Growth releases, validation tests, and frontend type generation.

The browser calls same-origin `/api` routes. Vite proxies those requests during
development. Production Compose places a single public Nginx gateway in front
of the static frontend and backend. A separate internal-only network connects
the backend to the non-root MediaCrawler sidecar; that network never reaches
the gateway, and the sidecar publishes no host port. MySQL, backend, frontend,
sidecar, and gateway all retain separate runtime responsibilities.

## Backend composition

`backend/src/server.ts` owns cross-cutting HTTP behavior: Helmet, CORS, request
limits, rate limiting, authentication, CSRF enforcement, Swagger registration,
error translation, store creation, and process lifecycle.

The Growth composition in `growth-commercial-composition.ts` installs
foundation, catalog, quote, finance, ROI, advisor, and financial-council
modules into one authenticated router. Private services are exchanged through
the composition registry rather than exposed as frontend DTOs. The
acquisition application follows the same domain/service/repository pattern and
is mounted under `/api/v1/acquisition`.

The ready Growth bootstrap selects one authorized concrete workspace. The
browser carries that selection as `X-Workspace-Id` on every downstream Growth
request. Finance exposes the contract-backed cost-estimate collection from the
workspace ledger repository, and ROI exposes the contract-backed cohort
collection from its workspace repository. Expected Growth HTTP and capability
errors preserve their public status/code envelope; only unexpected failures
become `GROWTH_INTERNAL_ERROR`.

Douyin QR login crosses one private boundary: Express stores
workspace-scoped account/session/replay records, while the pinned
MediaCrawler sidecar owns raw browser profiles and Playwright in a killable
child process. Public DTOs expose neither the opaque upstream handle nor raw
browser state. Graceful sidecar restarts retain encrypted active profiles;
QR expiry removes only unconnected login attempts, while connected-account
metadata and profiles survive independently until explicit disconnect or
replacement. During reload, invalid durable account metadata is quarantined;
missing or malformed ephemeral QR metadata does not invalidate a connected
account.
With `MEDIACRAWLER_BROWSER_HEADLESS=false`, the sidecar opens a dedicated
standard-Playwright Douyin window for the local operator. Shensi explicitly
disables CDP. Production may set `MEDIACRAWLER_BROWSER_HEADLESS=true`; neither
mode changes the private browser-state boundary.
The automation service consumes that same workspace account repository without
exposing its private handle. It publishes immutable policy versions behind a
compare-and-swap head and creates idempotent automation intents that freeze the
approved plan version, policy version, account/login version, local date, and
daily-budget identity. Each intent has a distinct authoritative acquisition run
created from that exact approved plan/version/hash. MySQL commits the run,
queued run event, audit event, automation intent, binding, and command replay in
one transaction after locked authority validation. Memory composition uses one
shared transaction token across plan, account, and automation repositories and
provides the same all-or-nothing boundary.

The plan payload uses `executionMode` as the closed runtime discriminator.
Legacy rows without it are `generic` and retain provider-operation plus trusted
model-snapshot readiness. `douyin_mediacrawler` is an explicit Douyin-only
branch with empty provider/operation arrays and `modelSnapshotRef: null` on
both its frozen plan and authoritative run. It can be approved without a
public-search or AI connection, but it cannot enter the generic shard runner;
only the automation policy and `run-now` authority may launch collection.
Manual policy keywords are deterministic input. Model-backed keyword
suggestions remain an optional, separately authorized command.

Frozen intents materialize as one crawler job per workspace, plan, policy
version, and policy-local date. Separate alias tables bind every automation
intent and authoritative acquisition run to that shared job, while the
repository validates them as one authoritative pair. The pair's exact replay
is a no-write no-op; a run or intent reused in another pair fails closed. A new
pair increments the job's private `aliasGeneration`, and terminal candidate
projection is current only when `projectedAliasGeneration` matches it. The
repository records `scheduled` before an idempotent enqueue transition. Node
owns random fenced crawl and terminal-ingestion leases and persists each bounded
normalized record page together with its opaque cursor and unique cursor
history, rejecting cycles and non-null terminal cursors. Frozen creator/comment
flags filter disabled record kinds before persistence. Each stored record also
keeps the exact cursor of the page that produced it, so a terminal null job
cursor cannot erase evidence provenance. Real comment authors are normalized to
a bounded Douyin public profile and an explicit commenter discriminator; root or
empty actor identities are rejected. A private runner hook copies only the
bounded public actor fields from MediaCrawler's real author object before its
general-purpose JSONL privacy transform; an anonymous hash is not treated as a
public profile identity.

While a crawl is running, the sidecar tails only complete physical-LF JSONL
records and publishes immutable nonterminal pages. Node pulls each advertised
page, atomically advances its opaque cursor, and projects available evidence,
candidates, identity aliases, DNC/audit state, a running acquisition-run state,
and candidate-discovered events through the existing domain and plan-run
repositories. A failed live projection does not discard the durable page; the
terminal ingestion lane replays all records as compensation. A committed retry
is a no-op, and a failed transactional projection rolls the whole projection
back. The final page records either `succeeded` or `partial`; partial jobs retain
all previously published records and their bounded failure code.

Terminal ingestion owns one generation-bound random fence and one serialized
in-flight lease renewal. Its heartbeat remains active through domain projection
and sidecar acknowledgement; the worker checks the live lease and alias
generation before projection, before acknowledgement, and after acknowledgement.
A pair added while ingestion is running increments the generation without
clearing the current lease. The owner that observes the mismatch releases the
job back to pending without starting acknowledgement; if the pair arrives during
acknowledgement, the post-ack check and completion transaction prevent the stale
generation from becoming ready. Only current-generation completion records
`projectedAliasGeneration`, `ingestedAt`, and `acknowledgedAt`. The durable
acknowledgement timestamp starts the sidecar's 24-hour page-retention clock and
is safe to replay after a crash. Unknown, legacy, or exception-derived crawler
failures are normalized to closed stable stored/public codes; raw error and
credential text never enters the projection.

The backend and Shensi sidecar adapter form one private versioned runtime
boundary even though the route prefix remains `/internal/v1`. Before issuing a
create request, the worker reads the deterministic sidecar job ID and adopts a
matching existing job. This read-before-create rule lets restart recovery reuse
published pages without repeating an external crawl. For compatibility with
already persisted legacy results, only a terminal `succeeded` or `partial`
descriptor may omit activity; the gateway closes that absence to `completed`, a
null keyword, `headless`, and sequence `1`. Missing activity on `queued`,
`running`, `paused`, `cancelled`, or `failed` remains an invalid response.
Sidecar health proves liveness and pinned upstream provenance, not
adapter/gateway protocol compatibility, so the two processes are deployed and
restarted from the same source revision.

Every runner invocation creates a random owner-only `0700` attempt directory
below its job output root and confines its request, activity, and JSONL reads to
that directory. A resumed manager seeds its record de-duplication set from IDs
in already persisted pages, so neither stale attempt files nor repeated upstream
records can be republished. The same sweep removes the entire job output root,
including every attempt and private upstream capture. Backend retention removes
only unlinked evidence 90 days after ingestion, leaving candidate-linked
evidence, one-way DNC identity, and audit authority intact. Restarts recover
expired running crawl leases and ingestion leases from Node cursors. A crawler
job that is already `paused` after exhausting its retry budget is not an
automatic restart candidate; only an audited, job-scoped explicit requeue may
make it claimable again. A late authoritative run/intent pair replays only this
projection, not the crawl. Fair lane alternation and cross-workspace
claim preference keep queued crawl work from starving ingestion or another
tenant. Browser routes never proxy live sidecar state. The manager publishes
`starting_browser` before consuming the runner and `opening_douyin` only after a
real browser launch; equivalent activity snapshots do not create false progress.
A terminal activity returned by crawl startup is not written by the nonterminal
activity mutation. For a successful or partial crawl, only the advertised
`done` page persists its descriptor, `completed` activity, terminal state, and
crawl-lease release in the same transaction, so no durable running job can
advertise a final page. A paused sidecar status retains the last safe nonterminal
activity, releases its fence through retryable requeue, and is resumed by a later
claim rather than held in an endless poll/renew loop.

MySQL `DATETIME(3)` parameters at this boundary are derived from the same UTC
instant and bound in the database driver's timezone-free date-time form. SQL
comparisons and lease/retention timestamps therefore do not mix ISO timezone
suffixes with MySQL date-time values.

The local visible tab is a separate best-effort observation mirror for the
approved keyword and public video, not a collection authority. It is created
from the crawl browser context without reusing the collector page. Observation
navigation uses at most one unfinished best-effort task outside the collector's
critical await path; a hung task suppresses later mirror navigation without
blocking search or comment collection or creating an unbounded backlog. The
deterministic MediaCrawler request client remains the data authority, and
navigation in that tab cannot fabricate records, evidence, or candidates. The
browser polls the persisted Node crawler-status projection rather than the
sidecar. Its closed public surface contains activity (phase, a null or exact
approved keyword of at most 100 Unicode code points, visible/headless mode, and
monotonic sequence) and
`candidateProjectionState` (`pending`, `ready`, or `failed`); it excludes raw
URLs, profile paths, cookies, headers, selectors, CDP/WebSocket endpoints,
browser identifiers, raw logs, ingestion state, and leases. MySQL hydration,
repository mutation, and public projection each fail closed when a non-null
activity keyword is outside the job's frozen keywords or exceeds that bound.

Private outreach generation is composed at the application boundary from that
same domain/DNC authority. Memory verification serializes with the DNC writer
through the shared plan-run transaction coordinator. MySQL takes candidate,
exact-evidence, and DNC primary-key/gap locks, then performs every authority
read through the same connection. The owned result is recursively frozen before
it can reach the later batch authority; generation does not persist a draft.
The default application constructs these adapters for the concrete Memory and
MySQL repositories. A custom domain or crawler repository supplies the same
tenant-scoped atomic guarantee through the explicit
`AcquisitionOutreachFinalAuthority` port. Missing custom authority does not
break unrelated application startup, but the private draft call fails closed
before model traffic. Draft safety recognizes real ASCII and IDN suffixes from
the pinned ICANN public-suffix data rather than treating every alphabetic final
label as a domain, so grounded names such as `Node.js` and `Qwen.VL` remain
usable while real domains stay prohibited.

The outreach-batch service is the sole draft persistence owner. Its candidate-
scoped collection read resolves current batch heads by workspace, run, and
candidate with a filter-bound opaque cursor; both acquisition and conversations
use that server query rather than a browser-known batch ID as recovery
authority. It freezes the
authoritative run, policy, account/login, candidate/evidence, model, selected
daily limit, exact message, and canonical hash identities into immutable batch
revisions. Human edits reuse the draft validator and append a revision without
changing source-model provenance. Approval is a human second confirmation,
not execution. Approval and action persistence are available only when the
runtime has both a configured MediaCrawler gateway and
`DOUYIN_OUTREACH_ACTIONS_ENABLED=true`; with the action gate disabled, approval
returns `503 outreach_actions_disabled` before approval, allowance, replay, or
action persistence. In an action-enabled runtime, one transaction rechecks
account/login, candidate/evidence, DNC, and the remaining account-local-date
allowance; records the approval; and writes an exact comment action followed by
a blocked direct-message action. Memory shares a reentrant coordinator with DNC
writers. MySQL uses the batch transaction connection for account and Task 6
final-authority locks, replay, daily allowance, and action inserts, so a failed
second insert rolls back the whole approval.

The acquisition application constructs and starts the separate outreach-action
worker and expired-claim sweeper only under that same two-part condition: the
private MediaCrawler gateway is configured and
`DOUYIN_OUTREACH_ACTIONS_ENABLED=true`. A configured gateway with the flag false
still supports collection but starts neither action process. Claims are random-
token leased and monotonically fenced, serialize each account, and reserve
persisted server-time eligibility before the sidecar call. The MySQL worker
pages through the stable ascending `(created_at,id)` claim order, rather than
re-reading one fixed window, so any full window of currently ineligible rows
cannot starve a later eligible action.
The repository enforces at least 60 seconds between account actions and at
least 180 seconds from a successful comment receipt to its direct-message
claim. The worker then revalidates the active account/login version, approved
batch and action hashes, candidate/evidence authority, predecessor receipt,
policy binding, and daily allowance. Only the frozen public video/profile URL
and exact approved text cross the private action port. Receipts commit under
the fence; an expired external-write lease moves the action and related account
work to `risk_paused`, while stale completions are rejected. There is no
distributed exactly-once claim. A durable pre-click journal prevents automatic
replay after a possible click, and an operator-confirmed read-only
reconciliation may mark only the same frozen action succeeded when the platform
exposes a unique post-start receipt. It never re-executes or automatically
resumes the account or successor. Three consecutive failures, or a
verification/rate-limit/account-
warning/login risk response, atomically pauses the account and all queued work.
The sidecar reuses only that account's authenticated profile, centralizes UI
selectors and closed page-state errors, clicks once, and never implements a
bypass path. MediaCrawler upstream remains the collection/browser foundation;
comment and private-message execution is a Shensi extension, not an upstream-
native or official Douyin inbox/API capability. Visible verification permits a
bounded, manual-only wait and full recheck of the same action. Current defaults
are 120 seconds for manual verification, 150 seconds for the Node action
deadline, 160 seconds for gateway HTTP, 170 seconds for browser-action IPC, and
a 180-second minimum claim lease. No solver, verification-token injection,
third-party bypass, alternate action ID, or automatic retry after an uncertain
receipt is allowed.
For direct messages the canonical profile page must expose one visible entry
into a same-page panel, one editable Draft editor, and one send button. Native
Playwright key presses must round-trip the exact text. Success requires one new
self/outgoing message with a stable platform ID and an allowlisted timestamp no
earlier than the journal start; a `/messages` route transition without a stable
recipient binding or any ambiguous DOM remains a closed failure.

Long-running acquisition, finance-import, recommendation, and council work is
represented by persisted operations and recovery sweepers. Memory mode is a
development and focused-test implementation; MySQL mode is required for
restart, lease, transaction, and live-runtime evidence.

## Frontend composition

`frontend/src/app-session.ts` is the authenticated shell controller. Feature
code is grouped under `acquisition/`, `conversations/`, `private-domain/`,
`connections/`, and `growth/`. Growth contains advisor, catalog, finance,
quotes, ROI, agent-center, and council controllers and views. Shared transport types are imported from
`frontend/src/generated/`, which is generated from `contracts/`; new DTOs must
not be hand-written in feature code.

The acquisition runtime composes account/login, automation/run and outreach-
batch controllers inside the single existing `.replica-shell`. The controllers
call only authenticated Node routes with browser CSRF, semantic idempotency and
ETag authority; they fence generations and abort requests/pollers on mode
change, logout and close. Automatic collection is the primary surface, while
the real-mode header action focuses the MediaCrawler plan form without loading
provider or model connections. The generic public-search wizard is a separate
optional enhancement with explicit search-API and tool-calling-model
requirements; authorized public-link import is a collapsed fallback. Private
MediaCrawler handles, cookies, profiles, leases and internal identifiers are not rendered.
For a current run, the dashboard polls only the persisted crawler-status
projection and localizes phase while showing browser mode, keyword, attempt and
update time, and candidate allowance. Each refresh validates crawler status
before its candidate-page request. Live-projected candidates can appear while
the crawler is nonterminal or projection is `pending`; a validated `ready`
snapshot is the ordering boundary for the final candidate-page read. Terminal
`ready` with zero candidates is valid, and a validated terminal status survives
a failed candidate read. That read receives at most three run- and generation-
fenced exponential-backoff retries, then stops. The task read model keeps the
newest authoritative run for truthful status and separately identifies the
newest run with persisted candidate links; stopped zero-result runs therefore do
not erase the last reviewable candidate set. The decoder requires primitive strings before accepting crawler state,
activity phase, browser mode, or projection-state enums. It accepts candidate
pages only with exact page, candidate, and evidence keys; at most 100 items; a
null or nonempty cursor of at most 8,192 Unicode code points; nonempty candidate
ID and status; and display name and excerpt bounds of 200 and 500 code points.
An evidence URL must have an unmodified raw HTTP(S) authority and hostname. Raw
credentials, backslashes, whitespace/control/format characters, malformed
percent escapes, and parser-repaired authority forms fail the whole response;
uppercase schemes and Unicode path/query text remain valid. The pre-status
queued live region is polite once per outstanding run and silent on same-run
rerenders; observing status, clearing the intent, or starting a new run resets
its token. A submitted intent without its first observation, an observed
nonterminal run, or a terminal run whose candidate projection is still
`pending` blocks duplicate submission in both the rendered control and
controller command path. This observation does not alter the existing comment
or direct-message approval authority.
The desktop candidate table and evidence inspector collapse to one-column
cards at the mobile breakpoint. Desktop scrolling belongs to the bounded
`.replica-shell`; mobile returns to document scrolling without horizontal
overflow.

The real-session `#conversations` controller composes the same acquisition
public-evidence and outreach-batch authorities. It first reads the Douyin-
filtered task overview, then the first candidate page for each latest run. It
renders these records as public evidence, never as an official platform inbox
or two-party message transcript. For an eligible exact-video candidate it
lists batches by `runId + candidateId`, loads the newest current batch, and
reuses `OutreachBatchController` for exact-text revision, final confirmation,
action polling, and receipts. If the collection is empty, create is limited to
that one candidate. Profile-only evidence remains readable but does not issue a
batch list/create command. Reload repeats overview → candidate → collection GET
→ batch GET, making server authority independent of session selection order.
Run-level failures stay visible as partial-read warnings, a non-null candidate
cursor is disclosed as an incomplete page, and no local seed is used as
fallback. Route deactivation, logout, or another load aborts/stales the prior
generation. The browser contains no direct-send path: final approval only
queues actions when both server/sidecar gates are enabled, and the separate
fenced worker performs any platform click.

## Persistence

The backend supports memory and MySQL stores. Core CRM tables and startup DDL
are maintained in `backend/src/mysql-store.ts` and `backend/schema.mysql.sql`.
Domain repositories also own idempotent `CREATE TABLE IF NOT EXISTS` statements
for acquisition, Growth, quote, finance, and council tables. Consequently,
database review must search both the central store and module repositories;
the static SQL file alone is not the complete current schema authority.
The MySQL Growth finance composition runs the financial-ledger, finance-import,
and statement-package schema initializers before mounting their routes. Adding a
repository-owned table without wiring its initializer into that composition is
therefore a startup regression, even when the DDL itself is present and valid.

Credentials are stored as encrypted versions or opaque references. Runtime
keys such as `PROVIDER_CREDENTIAL_KEY`, `AGENT_JOB_ENCRYPTION_KEY`, and domain
master secrets are external configuration and must never enter Git or logs.

## Contract boundary

`contracts/openapi/ai-acquisition.v1.yaml` and
`contracts/openapi/growth-advisor-quote-roi.v1.yaml` are the editable shared
contracts. Backend builders and response-conformance tests guard runtime
parity. `contracts/releases/growth-advisor-quote-roi/1.0.12/` is immutable;
changing public Growth behavior requires the release workflow, not editing the
release bytes in place. See `docs/API_INDEX.md`.

## Operational boundaries

- The canonical repository is this checkout, not the legacy import source.
- The retained legacy real-runtime database is `shensi_sales`. The isolated
  canonical target database is the distinct `shensi`; no traffic cutover has
  occurred.
- `deploy/compose.yaml` defines the production MySQL, backend, frontend, and
  gateway topology. Only the gateway publishes HTTP; MySQL, frontend, and the
  gateway use the internal Compose network only, while the backend also has a
  separate egress network for outbound integrations.
- `scripts/backup`, `scripts/restore`, `scripts/migrate-data`, and
  `scripts/verify-data.mjs` provide encrypted source-to-new-target migration
  tooling. Restore authenticates an unlinked ciphertext snapshot and passes
  that same open FD to OpenSSL before any MySQL client starts. Backup rejects
  source views, routines, and events because the migration has an absolute
  no-DROP policy. Verification reports only allowlisted non-sensitive integrity
  and aggregate ciphertext-identity digests. The authorized restore-boundary
  migration has run: source and target matched at 237 tables and 170 rows. The
  first target-backend start added one deterministic, idempotent
  `system_migration` model-activation audit event. The completed Task 7
  credential-health gate added one immutable model job snapshot and one
  model-call ledger row, leaving the current target at 237 tables and 173 rows
  while the preserved source remains at 237 and 170. Task 7 authenticated once,
  loaded the exact restored `deepseek-v4-pro` connection, and completed exactly
  one bounded provider-health request. No cutover has run; see
  `docs/DATA_MIGRATION.md` and the current status ledger.
- Source databases are read-only migration inputs. Restore and verification
  must use a distinct target and keep rollback artifacts recoverable.
