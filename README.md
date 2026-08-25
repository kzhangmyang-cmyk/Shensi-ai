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
`MEDIACRAWLER_BROWSER_CHANNEL=chrome` in `.env.local`; Chrome opens only for
the private account session and the QR is also rendered in `#acquisition`.
The first QR can take up to 35 seconds on a cold browser profile. The operator
must scan it manually; the application never treats a test fixture or a poll
count as proof of login.

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
before the crawl ends. A terminal replay finalizes the run and acknowledges the
sidecar; if the upstream browser stops after publishing records, the job stays
`partial` and those records remain available instead of being reset to zero.

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
