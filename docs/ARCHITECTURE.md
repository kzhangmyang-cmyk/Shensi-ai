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

When configured, Douyin QR login crosses one private boundary: Express stores
workspace-scoped account/session/replay records, while the pinned
MediaCrawler sidecar owns raw browser profiles and Playwright in a killable
child process. Public DTOs expose neither the opaque upstream handle nor raw
browser state. Graceful sidecar restarts retain encrypted active profiles;
QR expiry removes only unconnected login attempts, while connected-account
metadata and profiles survive independently until explicit disconnect or
replacement. During reload, invalid durable account metadata is quarantined;
missing or malformed ephemeral QR metadata does not invalidate a connected
account.
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

Frozen intents materialize as one crawler job per workspace, plan, policy
version, and policy-local date. Separate alias tables bind every automation
intent and authoritative acquisition run to that shared job. The repository
records `scheduled` before an idempotent enqueue transition. Node owns random
fenced crawl and terminal-ingestion leases and persists each bounded normalized
record page together with its opaque cursor and unique cursor history,
rejecting cycles and non-null terminal cursors. Frozen creator/comment flags
filter disabled record kinds before persistence. Each stored record also keeps
the exact cursor of the page that produced it, so a terminal null job cursor
cannot erase evidence provenance. Real comment authors are normalized to a
bounded Douyin public profile and an explicit commenter discriminator; root or
empty actor identities are rejected. A private runner hook copies only the
bounded public actor fields from MediaCrawler's real author object before its
general-purpose JSONL privacy transform; an anonymous hash is not treated as a
public profile identity.

After a terminal page is durable, the ingestion worker writes evidence,
candidates, identity aliases, DNC/audit state, acquisition-run status, and
candidate-discovered run events through the existing domain and plan-run
repositories in one transaction. A committed retry is a no-op; a failed write
rolls the whole unit back. Only then does Node acknowledge the sidecar. The
durable acknowledgement timestamp starts the sidecar's 24-hour page-retention
clock and is safe to replay after a crash. The same sweep removes the runner's
private upstream capture directory. Backend retention removes only
unlinked evidence 90 days after ingestion, leaving candidate-linked evidence,
one-way DNC identity, and audit authority intact. Restarts resume from Node
cursors and ingestion leases; a late run alias replays only this projection,
not the crawl. Fair lane alternation and cross-workspace claim preference keep
queued crawl work from starving ingestion or another tenant. Browser routes
never proxy live sidecar state.

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

The outreach-batch service is the sole draft persistence owner. It freezes the
authoritative run, policy, account/login, candidate/evidence, model, selected
daily limit, exact message, and canonical hash identities into immutable batch
revisions. Human edits reuse the draft validator and append a revision without
changing source-model provenance. Approval is a human second confirmation,
not execution: one transaction rechecks account/login, candidate/evidence,
DNC, and the remaining account-local-date allowance; records the approval;
and writes an exact comment action followed by a blocked direct-message
action. Memory shares a reentrant coordinator with DNC writers. MySQL uses the
batch transaction connection for account and Task 6 final-authority locks,
replay, daily allowance, and action inserts, so a failed second insert rolls
back the whole approval.

The acquisition application owns a separate outreach-action worker and
expired-claim sweeper whenever the private MediaCrawler gateway is configured.
Claims are random-token leased and monotonically fenced, serialize each
account, and reserve persisted server-time eligibility before the sidecar call.
The repository enforces at least 60 seconds between account actions and at
least 180 seconds from a successful comment receipt to its direct-message
claim. The worker then revalidates the active account/login version, approved
batch and action hashes, candidate/evidence authority, predecessor receipt,
policy binding, and daily allowance. Only the frozen public video/profile URL
and exact approved text cross the private action port. Receipts commit under
the fence; an expired lease requeues exact replay, while stale completions are
rejected. Three consecutive failures, or a verification/rate-limit/account-
warning/login risk response, atomically pauses the account and all queued work.
The sidecar reuses only that account's authenticated profile, centralizes UI
selectors and closed page-state errors, clicks once, and never implements a
bypass path.

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
