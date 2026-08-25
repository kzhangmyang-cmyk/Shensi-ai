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
cp .env.example .env.production.local
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
- Chrome for Playwright browser acceptance

Install dependencies with:

```bash
pnpm install --frozen-lockfile
```

Do not commit `.env` files, database dumps, credentials, customer data, or
provider encryption keys. Use `.env.example` only as a list of variable names.

## Local runtime

`./scripts/dev` reads `.env.local`, requires a real MySQL URL and the runtime
security keys, reserves API port `4191` and frontend port `5191` before either
process starts, and runs MySQL mode only. Vite uses `--strictPort`, so a port
race fails rather than selecting a different port. It forwards `SIGINT` and
`SIGTERM` to both child process trees and terminates them within a bounded
shutdown window.
Do not use memory mode as evidence for this runtime.

The following direct commands are retained for focused development work; they
are not the canonical runtime path:

```bash
pnpm --filter ./backend dev
pnpm --filter ./frontend dev
```

The authenticated acquisition API includes immutable Douyin outreach-batch
review and approval. Approval only persists the exact ordered
comment-then-direct-message outbox; the separate executor owns external
actions and is never invoked by the approval route.

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
