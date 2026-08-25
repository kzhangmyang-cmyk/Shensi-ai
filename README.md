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
Do not use memory mode as evidence for this runtime.

Douyin currently serves a verification interstitial to the bundled headless
browser during QR-login startup. For local operator login, keep
`MEDIACRAWLER_BROWSER_HEADLESS=false` and
`MEDIACRAWLER_BROWSER_CHANNEL=chrome` in `.env.local`. This opens a dedicated
standard-Playwright Douyin window for the private account session; Shensi
explicitly disables CDP. Production may set
`MEDIACRAWLER_BROWSER_HEADLESS=true`. The first QR can take up to 35 seconds on
a cold browser profile. The operator must scan it manually; the application
never treats a test fixture or a poll count as proof of login.

The following direct commands are retained for focused development work; they
are not the canonical runtime path:

```bash
pnpm --filter ./backend dev
pnpm --filter ./frontend dev
```

The authenticated acquisition API includes immutable Douyin outreach-batch
review and approval. Approval only persists the exact ordered
comment-then-direct-message outbox; the separately leased executor owns
external actions and is never invoked by the approval route. When the private
MediaCrawler gateway is configured, the acquisition application owns the
fenced action worker and expired-claim sweeper lifecycle. The worker rechecks
the frozen approval/account/candidate/content/budget authority immediately
before asking the sidecar to submit exact approved text.

The authenticated `#acquisition` dashboard uses that authority for the primary
automatic Douyin workflow: QR account connection, editable local automation,
run progress, creator/commenter evidence review, revisioned exact-message
editing, explicit approval, pause/resume and sanitized action receipts. Public-
link import remains an authorized secondary fallback. The browser never
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
status is the ordering boundary for the final candidate-page read. Polling stops
after the candidate read paired with `ready` or `failed`, and zero candidates
with `ready` is a valid completed result. A validated terminal status remains
visible if that candidate read fails. The frontend accepts a candidate page only
when the page, every candidate, and every evidence object contain exactly their
public fields and stay within the endpoint's item and text bounds. Evidence URLs
must contain an unmodified HTTP(S) authority and hostname with no credentials,
backslashes, whitespace/control/format characters, or malformed percent escape.
The frontend also rejects non-primitive enums and announces the pre-status
queued placeholder only once per outstanding run. Another run stays blocked
until the current intent is observed and no longer pending; comment and direct-
message approval rules are unchanged.

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
unavailable. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) before treating any
local command as a production procedure.

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
