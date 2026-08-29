# Shensi

Shensi is a sales growth and operating-analysis system for international sales
teams. This repository is the canonical development path for the dark agent
center frontend, the Express domain API and workers, the MySQL persistence
layer, and the shared acquisition and Growth contracts.

## Canonical commands

For local MySQL-backed development, create the ignored file, replace its
placeholders with real local values, and then use the canonical wrappers:

```bash
cp .env.example .env.local
./scripts/dev
./scripts/verify
```

For production, provision the production secrets and configuration described
in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), then run:

```bash
cp .env.production.example .env.production.local
./scripts/deploy
```

## Isolated real-customer trial

The repository also provides one isolated, repeatable trial runtime. When
`pnpm trial:status` reports `running: true`, its reported temporary origin is
the only current public trial link. Operational and customer-interactive gates
are tracked in
[`docs/operations/real-customer-trial.md`](docs/operations/real-customer-trial.md)
and must remain truthful. Supply the customer password only through the
owner-controlled process environment or an owner-only password file; never put
it in a command, tracked file, or log.

```bash
pnpm trial:prepare
pnpm trial:start
pnpm trial:publish
pnpm trial:status
pnpm trial:verify
pnpm trial:stop
```

The fixed loopback ports are MySQL `3310`, gateway `5608`, frontend `5610`,
backend `5611`, and MediaCrawler `5612`. A Cloudflare Quick Tunnel publishes
only the gateway. The ignored default root is `.runtime/real-trial/`, including
the owner-only `trial.env`, secrets, logs, PID records, MySQL data, browser
profile, crawl-output, and isolated frontend release directories. The trial
preview serves only `.runtime/real-trial/release/frontend/`; an ordinary
development or repository-wide build therefore cannot replace the frontend of
an already running trial. `trial:status` reports the current
temporary origin; it may change after a tunnel restart and must not be copied
into tracked documentation. `trial:stop` validates the recorded command, PID,
and runtime nonce before terminating trial process groups and retains the
runtime data for an explicit retention decision.

Use `pnpm trial:publish` after verified source changes. It stops only the
recorded trial processes, rebuilds the frontend and backend from this worktree,
restarts the same retained MySQL/profile runtime, and verifies the new gateway.
The customer-facing local URL is `http://127.0.0.1:5608`; it and the temporary
HTTPS origin use the same frontend build, API, and database. Port `5588` is a
developer hot-reload server and is not the local customer-trial URL. Local and
public trial surfaces come from this same repository source, but editing the
worktree does not update the running trial until the separate explicit
`trial:publish` operation completes successfully.
The normal command always regenerates an action-disabled runtime, even if the
parent shell or retained `trial.env` contains an older true value. A separately
authorized one-shot action launch uses
`pnpm trial:publish --enable-outreach-after-empty-audit`; before any
action-enabled backend starts, the supervisor performs a read-only global
aggregate over `queued`, `blocked_by_predecessor`, and `executing` outreach
actions. A nonzero or unreadable result aborts startup and cleans up the newly
started processes. Trial `start` and `publish` alone also accept the exact
`--action-visual-locator=rapidocr` option. It selects the pinned
`uv run --frozen --extra visual-locator` sidecar command without authorizing
external writes; combine it with the one-shot action flag only when both
choices have been separately approved.

The trial build shows all nine primary modules—自动营销总览、获客中心、社媒对话、
私域客户池、成交工作台、智能体中心、自动工作流、外贸营销、设置中心—and the six
Growth/finance entries at `#growth/advisor`, `#growth/catalog`,
`#growth/quotes`, `#growth/finance`, `#growth/roi`, and `#financial-council`.
Real API/MySQL surfaces remain real. Browser-local or pending integrations are
visible and carry the exact label `预览 · 待接入`; their values are not live
customer results.

The real-mode entry switches between login and public account registration and
never pre-fills credentials. Login accepts either a valid account name or an
email. Registration calls `POST /api/auth/register`; the account must be 3–32
characters, begin with a letter or digit, and otherwise contain only letters,
digits, `_`, or `-`, while the password must be 8–128 characters. The server
trims and lowercases the account, returns `409` for an existing account, and
limits registration to five attempts per observed client IP per hour. A
successful registration creates an active tenant `admin` in a newly generated
workspace and immediately issues the normal session and CSRF cookies. All
product modules remain visible, but that workspace starts with empty business
data and receives no copied provider/model credentials, Douyin login, candidate,
task, approval, comment, or private-message state from another tenant.

With `VITE_REAL_TRIAL=true`, `VITE_TRIAL_LOGIN_ALIAS` and
`VITE_TRIAL_LOGIN_EMAIL` contain position-matched comma-separated values. The
current trial continues to map `test` and `test2` to their `@shensi.local`
emails. Matching trims and lowercases the alias only; unmatched identities and
every password remain unchanged. Empty or unequal-length lists fail before a
network request. The backend itself accepts either a valid bare account or an
email. `test` and `test2` are tenant `admin` accounts in separate
`trial-pilot-001` and `trial-pilot-002` workspaces; neither is `super_admin`, and
their business data is isolated.
`test2` has its own persisted, read-only acquisition showcase snapshot so the
public trial exposes the same task, candidate, and evidence surfaces as `test`
without sharing operational state. The snapshot contains no provider or model
credentials, Douyin login/session, social account, crawler command, approval
batch, comment, or private-message action. `test2` must configure its own model
connection and scan its own Douyin login before any real operation.
Browser-only preview state is also keyed by the authenticated workspace and
user, so switching between the two trial accounts cannot reuse another
account's local demo edits.

## Start here

Read these files in order before changing the system:

1. [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) — the sole current work ledger.
2. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — runtime and source boundaries.
3. The relevant guide in [`docs/modules/`](docs/modules/).
4. [`docs/API_INDEX.md`](docs/API_INDEX.md) for API or DTO changes.
5. [`docs/DATA_MIGRATION.md`](docs/DATA_MIGRATION.md) or
   [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for operational work.

`docs/archive/` and `docs/superpowers/` are non-authoritative history. The
legacy source repository is identified in
[`docs/SOURCE_PROVENANCE.md`](docs/SOURCE_PROVENANCE.md); do not develop or
deploy from that source.

## Repository layout

```text
frontend/    React/Vite agent-center application and Playwright tests
backend/     Express API, domain services, workers, and MySQL repositories
contracts/   OpenAPI, JSON Schema, immutable releases, and type generation
deploy/      Production Compose topology and existing Baota packaging/scripts
docs/        Current-state, module, operations, product, and archived material
scripts/     Repository entry points and verification wrappers
tools/       Cross-workspace tests and release gates
```

Keep `frontend/`, `backend/`, and `contracts/` at the repository root. The
editable contracts under `contracts/` and their generated frontend types are
the authority for shared DTOs. The current immutable Growth release is
`contracts/releases/growth-advisor-quote-roi/1.0.12/`.

## Prerequisites

- Node.js `22.22.3` (the root engine range is `>=22.22.3 <23`)
- pnpm `11.18.0`
- MySQL 8 for persistent and integration flows
- uv `0.12.5` and Playwright Chromium for the private MediaCrawler sidecar
- Chrome for Playwright browser acceptance

Install dependencies with:

```bash
pnpm install --frozen-lockfile
```

Do not commit `.env` files, database dumps, credentials, customer data, or
provider encryption keys. Use `.env.example` only as a list of variable names.

## Local runtime

`./scripts/dev` reads `.env.local`, requires a real MySQL URL, runtime security
keys, an owner-only MediaCrawler secret file and a pre-existing encrypted state
directory with mode `0700`. It reserves private sidecar port `4491`, API port
`4191`, and frontend port `5191` before starting the Python sidecar, MySQL-backed
Node runtime/workers, and Vite. Vite uses `--strictPort`, so a port race fails
rather than selecting a different port. The wrapper forwards `SIGINT` and
`SIGTERM` to all child process trees and force-terminates them after a bounded
shutdown window.
This is the ordinary integrated development runtime, not the isolated customer
trial; do not use its ports, database, state, PID files, or tunnel as trial
evidence. Do not use memory mode as evidence for either runtime.

Deployment MediaCrawler must also receive
`MEDIACRAWLER_CRAWL_OUTPUT_ROOT`. It must be an absolute, existing,
non-symlinked, current-user-owned directory with exact mode `0700`, resolve
strictly inside `MEDIACRAWLER_ENCRYPTED_VOLUME`, and not equal the volume root.
Runner creation and acknowledgement cleanup use that same resolved root, so
trial or deployment output never falls back to the source-local compatibility
directory.

The Node and Vite development children may reload source, but the Python
MediaCrawler sidecar does not auto-reload. Treat the backend gateway and the
Shensi sidecar adapter as one private protocol unit: after changing either
side's crawl schemas, gateway parsing, or job lifecycle code, stop the complete
wrapper, let every child exit, and restart `./scripts/dev`. A liveness health
response does not prove that the two processes implement the same protocol.

Douyin currently serves a verification interstitial to the bundled headless
browser during QR-login startup. For operator login and every real outreach
action, keep
`MEDIACRAWLER_BROWSER_HEADLESS=false` and
`MEDIACRAWLER_BROWSER_CHANNEL=chrome` in `.env.local`. This opens a dedicated
standard-Playwright Douyin window for the private account session; Shensi
explicitly disables CDP. A collection-only production runtime may set
`MEDIACRAWLER_BROWSER_HEADLESS=true` only while external outreach remains
disabled. Enabling outreach with headless mode fails deployment preflight, and
the parent and browser child reject any bypassed action/reconciliation command
before opening a page. The first QR can take up to 35 seconds on
a cold browser profile. The operator must scan it manually; the application
never treats a test fixture or a poll count as proof of login.
After a successful scan, the backend accepts only a canonical one-way account
handle, a non-empty nickname, and a positive login-state version. If stored
active metadata is non-authoritative, only a strictly newer valid scan can
repair it; an equal or older scan and a valid different-account binding still
fail closed.

The following direct commands are retained for focused development work; they
are not the canonical runtime path:

```bash
pnpm --filter ./backend dev
pnpm --filter ./frontend dev
```

Those commands start only the named process. They neither start nor reload the
private sidecar and must not be attached to an older independently running
sidecar as evidence for the controlled Douyin collection workflow.

The authenticated acquisition API includes immutable Douyin outreach-batch
review and two separate approval commands. When external actions are explicitly
enabled, the first confirmation records the exact approved batch and persists
exactly one queued comment per selected candidate. Only after that same
candidate's comment has a durable successful receipt can a second human
confirmation queue one version-2 private-message action. Neither HTTP approval
route performs the browser action; the separately leased executor owns both
action types. The private-message daily default is 20 with range 1–100; it is
separate from acquisition's daily candidate default 50 and range 1–200. A
configured private MediaCrawler gateway starts collection, but it does not
enable external actions. Both backend and sidecar enable outreach only when
`DOUYIN_OUTREACH_ACTIONS_ENABLED` is case-insensitively exactly `true`; spaces,
`1`, `yes`, an empty value, and omission remain disabled. While disabled, final
approval returns `503 outreach_actions_disabled` before approval or action
persistence, the backend starts neither its action worker nor recovery sweeper,
and the sidecar returns the same stable 503 before manager/executor lookup. The
crawler worker continues normally. When explicitly enabled after separate live
acceptance, the worker rechecks the frozen approval/account/candidate/content/
budget authority immediately before asking the sidecar to submit exact approved
text.
The action adapter starts from the frozen canonical `/video/{id}` or `/user/{id}`
page and submits only the exact approved text. The browser revalidates the
frozen sender from the current page header without navigation after target load,
after an initial-navigation manual verification handoff, before input, before
the single submit click, and while proving the receipt. For a comment, it first
locates one unique visible editor. If Douyin has lazy-mounted the editor, the
adapter first revalidates risk, URL, sender, and deadline, then clicks exactly
once on the unique exact `留下你的精彩评论吧` entry inside the unique comment-input
container. That activation neither types nor publishes; a missing or ambiguous
entry fails closed. It then pins the editor, enters the exact approved text, and
reads that text back before waiting for and pinning one unique usable submit
control. The submit control may legitimately be disabled or not yet mounted
before editor input and is not an input-stage prerequisite. A private-message
editor, submit control, and receipt
must each belong to one visible conversation panel whose exact public recipient
marker matches the frozen `/user/{id}` target; missing, ambiguous, changed, or
noncanonical recipient markers fail closed. The concrete editor and submit nodes
are independently pinned and tagged. A synchronous capture-phase click guard
rechecks the exact approved editor text, URL, sender, and (for a DM) recipient;
the DM editor must remain in the submit's exact-recipient panel, so text/editor
replacement or an account/conversation switch is blocked before dispatch.
Capture-guard rejection preserves the precise closed code: content drift is
`douyin_action_content_mismatch`, URL/control drift is
`douyin_action_control_missing`, sender drift is
`douyin_account_identity_changed`, and DM recipient/panel drift is
`douyin_direct_message_unavailable`. `douyin_action_receipt_ambiguous` is
reserved for click failures that may already have reached the platform.
After a comment has either a verified success receipt or an ambiguous
post-submit receipt, the visible target page is brought to the front and kept
open for ten seconds before the action context closes. This is an operator-only
review window: it performs no additional click or write, and only the durable
platform receipt can mark the action successful.
DM receipt proof is one atomic snapshot of the same pinned visible outgoing
message node, exact text, stable message ID, sender, and recipient. The account
authority lease spans the complete browser command, while login versions are
allocated from one process-locked global monotonic ledger. The ledger, account
binding metadata, and login-session metadata are each committed with file and
parent-directory `fsync`; a sync failure cannot activate an account. Before the
external executor is called, the action manager durably commits its `started`
journal with the same file-plus-directory barrier. A journal sync failure aborts
before any platform click. An expired claim, timeout,
unavailable result, or ambiguous post-click receipt is never requeued: the exact
action and related account work remain `risk_paused`. After separately checking
the platform, the operator may explicitly confirm a strictly read-only
reconciliation of that same frozen action. Unique proof marks only that action
succeeded; no proof keeps it frozen, and neither path automatically resumes the
account. No failed action is automatically resubmitted. The worker serializes
all actions for one account, keeps at least 60
seconds between comment claims, and reserves ten minutes after a private-message
claim. The batch freezes the policy time zone; approval ordinals use the
approval local day, while claims count actual attempts on the real claim local
day. Retries consume that day's 1–100 allowance, the allowance resets only on the
next local day, and the same batch revision/candidate can never receive a second
DM approval even across days. On the same account-local day, the same candidate
also cannot receive another DM from a different batch; a later local day permits
a new batch while the original batch/revision remains permanently closed to a
second DM. Historical direct-message rows without version-2 authorization remain
readable for audit compatibility but are never claimable or executable.

The authenticated `#acquisition` dashboard uses that authority for the primary
controlled Douyin collection workflow: QR account connection, editable local
automation, run progress, creator/commenter evidence review, and revisioned
exact-message drafting. Public-link import remains an authorized secondary
fallback. Trial generation defaults all external outreach execution to
disabled. A specifically authorized trial may enable it only through the
one-shot CLI flag after a global empty audit of
`queued`, `blocked_by_predecessor`, and `executing`; ambient or retained
environment values are not authorization. Collection alone never authorizes
external sending, and comment approval and private-message approval remain
distinct human decisions in an enabled runtime.
The browser never
receives MediaCrawler cookies, account handles, browser profiles or leases.
Completed MediaCrawler JSONL records are published as immutable pages while a
crawl is still running. The backend persists each available page and projects
its evidence and candidates immediately, so the dashboard can show candidates
before the crawl ends. Every runner invocation uses a random owner-only `0700`
attempt directory beneath the job output root; request, activity, and JSONL
reads stay inside that attempt, so stale files cannot be replayed by a restart.
On resume, the manager seeds record de-duplication from IDs already present in
persisted pages. Acknowledgement cleanup removes the enclosing job root and all
of its attempt directories. If the upstream browser stops after publishing
records, the job stays `partial` and those records remain available instead of
being reset to zero. A terminal activity returned by crawl startup is never
persisted through the nonterminal activity path: only the advertised `done`
page records its descriptor, completed activity, terminal state, pending
candidate projection, and crawl-lease release in one transaction.

Before creating a sidecar crawl, the Node worker reads the deterministic job ID
and adopts a matching existing job. A restart can therefore ingest retained
pages from a running or terminal job without repeating the crawl. The private
gateway accepts an activity-less legacy descriptor only when its state is
`succeeded` or `partial`, synthesizing the closed terminal observation
`completed` / `headless` / sequence `1`; every live descriptor still requires a
valid explicit activity object. A backend crawler job that has exhausted its
attempts remains `paused` across restart and is not silently reclaimed. Resume
requires an audited, job-scoped explicit requeue after protocol compatibility
has been verified. Do not create a replacement run, delete unacknowledged pages,
or acknowledge the sidecar manually as a recovery shortcut.

Every authoritative acquisition run and its bound automation intent form one
alias pair for the shared daily crawler job. An exact pair replay is a no-write
no-op, a mixed or reused alias fails closed, and a genuinely new pair increments
the private alias generation. Hydration requires duplicate-free run and intent
alias vectors of the same length, any explicit alias generation equal to that
shared length, and any explicit projected generation within it. A legacy
succeeded job with one pair may infer generation `1/1`
only when both generation fields are absent. A row with only one generation
field, or a multi-pair row missing either field, is conservatively returned to
pending with projected generation zero; an explicitly under-projected
succeeded generation is also reopened for repair. If terminal ingestion is
already running, a new pair leaves that lease intact; the current owner detects
the generation change and defers the job to pending. A single serialized heartbeat
keeps the ingestion lease alive through domain projection and sidecar
acknowledgement. Generation and lease authority are checked before projection,
before acknowledgement, and again afterwards, and only completion for the
current generation makes the candidate projection ready. Worker and repository
failures persist only closed stable codes, never raw exception or credential-
bearing text. A safely paused sidecar job releases its crawl fence through
retryable requeue and resumes on a later claim instead of being renewed
indefinitely.

When local visible mode is used, its dedicated tab is a separate best-effort
operator observation mirror for the approved keyword and public video. At most
one unfinished observation-navigation task exists, and it runs outside the
search/comment collector's critical await path. A hung or failed mirror may
suppress later mirror movement but cannot fabricate results, delay collection,
or stop the deterministic MediaCrawler request client. The dashboard polls only
the persisted Node projection: localized phase, a null or exact approved keyword
of at most 100 Unicode code points, visible/headless mode, monotonic sequence,
attempt and update time, candidate allowance, and the closed
`candidateProjectionState` (`pending`, `ready`, or `failed`). Persisted hydration
and public projection revalidate that keyword. The browser never receives a raw
URL, profile path, cookie, header, selector, browser identifier, CDP/WebSocket
endpoint, raw log, ingestion state, or lease data.

Every dashboard refresh validates crawler status before requesting the candidate
page. Live-projected candidates may therefore appear while the crawl is
nonterminal or candidate projection is still `pending`; a validated `ready`
status is the ordering boundary for the final candidate-page read. Zero
candidates with `ready` is a valid completed result. A validated terminal status
remains visible if that candidate read fails; the candidate read then retries at
most three times with exponential backoff and stops immediately after success or
after the bound is exhausted. Paused, failed, and cancelled crawler jobs project
the same recognizable stop state into every still-active authoritative run
alias. Task overview hydration carries both the latest authoritative run and the
latest run with persisted candidate links across refresh and verified-session
restoration. The latest status remains visible; when a newer stopped run has no
candidates, the frontend reloads the latest result run for candidate review and
batch scoping. It does not
reconstruct a run-now intent, and another run stays blocked until restored
status has been confirmed. Restoration creates or approves no batch and sends
no comment or direct message. The frontend accepts a candidate page only
when the page, every candidate, and every evidence object contain exactly their
public fields and stay within the endpoint's item and text bounds. Evidence URLs
must contain an unmodified HTTP(S) authority and hostname with no credentials,
backslashes, whitespace/control/format characters, or malformed percent escape.
The frontend also rejects non-primitive enums and announces the pre-status
queued placeholder only once per outstanding run. That observation cannot
approve or execute an action: comment approval still requires current batch
authority and human confirmation, and a private message additionally requires
that candidate's successful comment receipt plus its own confirmation.

DOM/ARIA lookup is the production browser default. The optional pinned local
RapidOCR fallback is selected only with
`DOUYIN_ACTION_VISUAL_LOCATOR=rapidocr`, runs after a missing entry/send
control, and must rebind one exact OCR suggestion to a visible enabled DOM
control. It never chooses the target or editor, verifies content or receipts,
or logs/persists screenshots or recognized text. Visual MCP tooling is limited
to development diagnostics, and action execution does not depend on an AI
model provider.

The real-mode header action `新建抖音采集计划` scrolls to and focuses the
MediaCrawler plan form; it does not open the provider-connection wizard or
request search/model connections. `公开搜索增强（可选）` is a separate
secondary entry and retains its own search-API plus tool-calling-model
requirements. Its wizard always offers a return to the no-API MediaCrawler
form.

MediaCrawler-only plans declare
`executionMode: "douyin_mediacrawler"`. They are created with empty
`providerConnections` and `operations`, no `modelConnectionId`, and a
server-persisted `modelSnapshotRef: null`; no public-search API or AI model is
needed to enter manual automation keywords. The authenticated sequence is
`POST /api/v1/acquisition/plans`, plan approval, `GET`/`PUT` of the plan's
`/automation` policy, then `POST /plans/{planId}/run-now`. The optional
`/automation/keyword-suggestions` command still requires an active AI model.
The generic `/plans/{id}/runs` operation is not a MediaCrawler launch path.
Omitting `executionMode` retains the compatible `generic` provider-operation
behavior.

The repository also exposes MySQL-backed development:

```bash
pnpm --filter ./backend dev:mysql
pnpm --filter ./frontend dev
```

For the existing real-local wrapper, configure the ignored
`.env.real.local`, provision the fixed local database account, then start both
processes:

```bash
pnpm setup:mysql:local
pnpm dev:real
```

That wrapper currently targets `127.0.0.1:3307`, database `shensi_sales`, API
port `4188`, and frontend port `5188`. It fails closed when MySQL is
unavailable. It starts only the backend and frontend; MediaCrawler work requires
a separately managed sidecar from the same source revision, so `./scripts/dev`
remains the canonical integrated path. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) before treating any local command as a
production procedure. It is also not the isolated customer trial and must not
lend its database, state, ports, processes, or tunnel to trial acceptance.

## Verification

Run the current-context check before module work and all aggregate gates before
claiming a repository-wide change is complete:

```bash
./scripts/verify
./scripts/context-check
pnpm test
pnpm build
git diff --check
```

Useful focused gates include:

```bash
pnpm test:layout
pnpm check:acquisition-contracts
pnpm check:growth-contracts
pnpm test:financial-council
pnpm test:e2e
```

Real MySQL and live-provider checks require their documented local credentials
and must not be replaced with memory-mode evidence. Module-specific commands
and limitations are recorded under [`docs/modules/`](docs/modules/).

## Current work

Use [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) for completed, active,
blocked, and next work. Update it in the same change whenever those facts move.
