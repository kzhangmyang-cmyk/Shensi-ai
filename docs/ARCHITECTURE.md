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
of the static frontend and backend; the API is reachable only through the
internal Compose network.

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

Long-running acquisition, finance-import, recommendation, and council work is
represented by persisted operations and recovery sweepers. Memory mode is a
development and focused-test implementation; MySQL mode is required for
restart, lease, transaction, and live-runtime evidence.

## Frontend composition

`frontend/src/app-session.ts` is the authenticated shell controller. Feature
code is grouped under `acquisition/`, `private-domain/`, `connections/`, and
`growth/`. Growth contains advisor, catalog, finance, quotes, ROI, agent-center,
and council controllers and views. Shared transport types are imported from
`frontend/src/generated/`, which is generated from `contracts/`; new DTOs must
not be hand-written in feature code.

## Persistence

The backend supports memory and MySQL stores. Core CRM tables and startup DDL
are maintained in `backend/src/mysql-store.ts` and `backend/schema.mysql.sql`.
Domain repositories also own idempotent `CREATE TABLE IF NOT EXISTS` statements
for acquisition, Growth, quote, finance, and council tables. Consequently,
database review must search both the central store and module repositories;
the static SQL file alone is not the complete current schema authority.

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
