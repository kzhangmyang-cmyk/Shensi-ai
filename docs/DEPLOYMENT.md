# Deployment

## Production Docker Compose

The canonical production topology is `deploy/compose.yaml`. It runs five
services with separate internal application and MediaCrawler networks:

- `mysql` persists the `shensi` database in the `shensi_mysql` named volume.
- `backend` runs the MySQL-backed Express API on port 4188 inside that network.
- `media-crawler` runs the pinned Python 3.11/uv/Playwright service as UID/GID
  10001 with read-only code, a read-only root filesystem, bounded resources
  and shutdown, and no published port.
- `frontend` serves the built Vite assets on port 8080 inside that network.
- `gateway` is the only service with a published port and routes `/api/` to
  `backend`, all other requests to `frontend`, and `/healthz` locally.

The backend is not published to the host. It listens on `0.0.0.0` only so the
internal gateway can reach it; Compose's internal network is its network
boundary. The backend and MediaCrawler sidecar join the egress-enabled
`shensi_egress` network for approved outbound calls. Only the backend joins
both `shensi_internal` and the internal `shensi_mediacrawler` network. The
gateway never joins or routes that sidecar network. MySQL, frontend, and
gateway remain only on `shensi_internal`. Production always sets
`NODE_ENV=production` and `CRM_STORE=mysql`; memory/demo persistence is not a
production fallback.

The internal gateway has fixed address `172.30.0.4` on the private
`172.30.0.0/24` network. Compose sets `TRUSTED_PROXY_CIDRS=172.30.0.4/32` for
the backend, so Express trusts only that gateway hop plus loopback. Do not
widen this value or publish a backend port.

### Prerequisites

- Docker Engine with Docker Compose v2.
- The production configuration and the three secret files described below.
- Enough durable storage for the MySQL named volume and backups.
- An HTTPS reverse proxy or load balancer in front of the published gateway
  port when deploying beyond a trusted local network. Set its public origin in
  `CORS_ORIGINS` and keep `SESSION_COOKIE_SECURE=true`.

The images are built from frozen workspaces and run as non-root users. The
current image references are `mysql:8.4.11`, `node:22.22.3-bookworm-slim`,
`python:3.11.13-slim-bookworm`, `ghcr.io/astral-sh/uv:0.12.5`, and
`nginxinc/nginx-unprivileged:1.27-alpine`. The sidecar installs its frozen uv
environment and Playwright Chromium during the image build.

Use `./scripts/deploy` as the canonical production command. It accepts only
MySQL persistence with `CRM_SEED_DEVELOPMENT_DATA=false`, checks
`.env.production.local` has POSIX mode `0600`,
requires the security values and owner-only MySQL secret files of at least 32
bytes, confirms that the canonically URL-encoded `DATABASE_URL` password and
`SHENSI_MYSQL_APP_PASSWORD` agree
with `deploy/secrets/mysql_app_password`, then renders, builds, starts, and
health-checks Compose. It reports service state and public origin only; it
never prints configuration or secret values. Docker Engine/Compose absence is
a hard failure, not a successful deployment. The current execution environment
does not have Docker; see the blocked entry in `docs/PROJECT_STATUS.md` for
that recorded verification limitation.

### Configuration and secrets

`.env.production.local` and `deploy/secrets/` are ignored and must never be
committed. Start with `.env.production.example`, copy it to
`.env.production.local`, and replace every placeholder with distinct
production values. At minimum, set
the strong session, credential-encryption, job, cursor, claim, and domain
master secrets required by the backend.

Create the MySQL secret files with owner-only permissions. Do not paste the
generated values into shell history, tracked files, or logs.

```bash
umask 077
mkdir -p deploy/secrets
openssl rand -base64 36 | tr -d '\n' > deploy/secrets/mysql_app_password
openssl rand -base64 36 | tr -d '\n' > deploy/secrets/mysql_root_password
openssl rand -base64 36 | tr -d '\n' > deploy/secrets/mediacrawler_service_secret
chmod 0400 deploy/secrets/mediacrawler_service_secret
```

Set `DATABASE_URL` in `.env.production.local` to a URL whose user is
`shensi_app`, host is `mysql`, port is `3306`, and database is `shensi`. Its
password must be the exact newline-free content of `mysql_app_password`,
encoded exactly with JavaScript `encodeURIComponent` for a database URL. Keep
strong punctuation in the password; encode it instead of weakening it. After
copying `.env.production.example`, use this
deterministic command to update `DATABASE_URL` in the ignored production file
without printing the password or its encoded form:

```bash
node -e 'const fs=require("node:fs"); const envPath=".env.production.local"; const password=fs.readFileSync("deploy/secrets/mysql_app_password","utf8"); if (!password || /[\r\n]/.test(password)) throw new Error("MYSQL_APP_PASSWORD_MUST_BE_NEWLINE_FREE"); const url=`mysql://shensi_app:${encodeURIComponent(password)}@mysql:3306/shensi`; const env=fs.readFileSync(envPath,"utf8"); if (!/^DATABASE_URL=.*$/m.test(env)) throw new Error("DATABASE_URL_REQUIRED"); fs.writeFileSync(envPath,env.replace(/^DATABASE_URL=.*$/m,`DATABASE_URL=${url}`));'
```

`SHENSI_HTTP_PORT` is optional and defaults to `8080`.

Set `SHENSI_MYSQL_APP_PASSWORD` in `.env.production.local` to the exact
newline-free content of `deploy/secrets/mysql_app_password`; the wrapper uses
it only for consistency validation and never prints it.

### Private Douyin MediaCrawler sidecar

The canonical Compose topology includes the pinned `services/media-crawler`
service. Compose gives the backend its internal URL and mounts the shared
secret file into backend and sidecar; raw secret environment values are not
accepted:

```dotenv
MEDIACRAWLER_BASE_URL=http://media-crawler:8899
MEDIACRAWLER_SERVICE_SECRET_FILE=/run/secrets/mediacrawler_service_secret
MEDIACRAWLER_CRAWL_OUTPUT_ROOT=/var/lib/shensi-mediacrawler/crawl-output
DOUYIN_OUTREACH_ACTIONS_ENABLED=false
```

The URL validator accepts only private/loopback plain HTTP targets. The secret
file must be regular, non-symlinked, owner-only, newline-free, and at least 32
non-whitespace bytes. Do not publish the sidecar or route browser-state traffic
through the public gateway.
The backend owns the crawler worker, expired-lease recovery, live and terminal
ingestion, and the evidence-retention lifecycle whenever this gateway is
configured. The sidecar advertises immutable completed pages while the crawl is
running; Node persists each page and may expose its candidates immediately. A
live projection failure leaves the page durable for terminal replay. Each runner
invocation creates a random owner-only `0700` attempt directory below its job
output root and reads request, activity, and JSONL files only from that attempt.
A resumed manager seeds its record de-duplication set from IDs already stored in
persisted pages. Result pages remain in the private sidecar until the backend's
authoritative terminal evidence/candidate/run-link transaction commits under
the current alias generation and the acknowledgement call succeeds. A terminal
activity returned by the startup call is never persisted through the
nonterminal activity mutation; only the advertised `done` page commits completed
activity, terminal metadata, and crawl-lease release together. A partial
terminal state retains every previously published page and its bounded failure
code.

Every terminal ingestion claim binds the current alias generation and runs one
serialized heartbeat through domain projection and acknowledgement. The worker
revalidates lease and generation before projection, before acknowledgement, and
after acknowledgement. Adding a newly bound run/intent pair increments the
generation but never clears an active ingestion lease; the current owner defers
the job to pending when it observes the change. Exact pair replay is a no-write
no-op, mixed or reused aliases fail closed, and generation-aware completion
prevents a pair added during acknowledgement from making stale work ready.
Worker and repository failures store only stable codes; raw exception or
credential-bearing text is not persisted or returned publicly.

The backend gateway and Shensi sidecar adapter are one private protocol unit.
Deploy and restart them from the same source revision; do not upgrade or
hot-reload only the backend while leaving an older sidecar process attached.
Before a create call, the worker reads the deterministic sidecar job ID and
adopts a matching existing job, including a terminal job with retained pages,
instead of starting a duplicate crawl. For already persisted compatibility
only, a `succeeded` or `partial` descriptor may omit activity; Node synthesizes
the closed terminal observation `completed` / `headless` / sequence `1`. Every
live descriptor still requires a valid activity object. The authenticated
health endpoint proves process liveness and pinned upstream provenance, not
adapter/gateway schema compatibility.

The persisted acknowledgement starts a 24-hour cleanup clock and is idempotent
across restarts. That sweep removes the complete job output root, including
normalized pages, all attempt directories, and the bounded private upstream
actor capture; it never treats upstream's anonymous `creator_hash` as a public
profile identity. Do not add an external cleanup that deletes unacknowledged
result pages. Backend cleanup removes only unlinked crawler evidence after 90
days; DNC and audit authority are not TTL data.

If an incompatible runtime leaves a Node crawler job `paused`, preserve the
encrypted state volume and every unacknowledged page. Stop new crawl dispatch,
restart backend and sidecar from the same revision, and verify the existing job
through a read-only protocol path. A job that has exhausted `maxAttempts` is not
made claimable by process restart or lease sweeping; it requires an audited,
workspace/job-scoped explicit requeue. The worker then adopts the existing
sidecar job, ingests its retained pages, commits candidate projection, and sends
the normal acknowledgement. Never recover by deleting the sidecar job,
acknowledging it manually, resetting the whole database, or creating a
replacement run that repeats the external crawl.

A configured gateway enables the backend crawler worker; it does not enable
external actions. The backend action worker/recovery sweeper and the sidecar
action manager exist only when `DOUYIN_OUTREACH_ACTIONS_ENABLED` is
case-insensitively exactly `true`. Leading/trailing spaces, `1`, `yes`, an empty
value, and omission all remain disabled. In that default state, final approval
returns `503 outreach_actions_disabled` before approval or action persistence,
the backend starts neither action process, and the sidecar returns the same
stable 503 before manager/executor lookup. Collection remains available.

Only a separately accepted action-enabled environment may use the private
sidecar action endpoint and existing encrypted authenticated profile; never
expose it through the public gateway. Node then owns account serialization,
fenced claims, persisted server-time delays, final authority revalidation,
daily limits, and receipts. The sidecar owns only the single exact browser
submission and closed platform-state detection. Platform verification, rate
limiting, account warnings, and login expiry pause the persisted social account
and all its queued actions; operators must resolve the account state through the
normal account lifecycle, never by bypassing the platform control.

On an existing MySQL installation, backend schema setup must complete before
workers start. It widens Douyin authoritative-run alias columns to 160
characters, backfills legacy automation JSON from
`acquisition_douyin_run_bindings`, separates legacy intent aliases from crawler
run aliases, and rebuilds the job alias projection. An unbound or ambiguous
legacy row stops startup with `acquisition_douyin_run_binding_migration_required`
or `crawler_job_alias_migration_required`; do not bypass that error or relabel
an intent ID as a run ID. Take the normal encrypted backup before applying the
migration.

Crawler generations remain private fields inside `payload_json`; no additional
table column is required. Hydration requires the run and intent alias vectors to
be duplicate-free, have the same length, and match an explicit
`aliasGeneration` exactly. A legacy succeeded payload with one pair may infer
`aliasGeneration=projectedAliasGeneration=1` only when both fields are absent.
A half-migrated payload with exactly one generation field, or a multi-pair
payload missing either field, is conservatively reopened as `pending` with
`projectedAliasGeneration=0`. An explicit succeeded payload whose projected
generation trails its alias generation is also claimable for repair. Malformed,
negative, forward, or vector-inconsistent generation values fail closed. Every
later create or replay still must match the authoritative run/intent binding
before an alias is accepted.

Existing installations also add outreach action target, lease, fence,
attempt, receipt, and failure columns plus the account-serialization and
attempt tables. An installation with legacy action rows but no frozen public
target stops schema setup with
`outreach_action_target_migration_required`; reconstruct or retire those rows
under an operator-reviewed migration before restart. Never infer a public
target from a private handle.

Before starting the sidecar, create and mount an encrypted-at-rest host
directory. It must already exist, must not be a symlink, and must have exact
POSIX mode `0700`. The profile root must remain beneath that mount. The crawl
output root must be absolute, already exist, be a non-symlinked directory owned
by the current runtime user with exact mode `0700`, and resolve strictly inside
but not equal to the encrypted volume:

```dotenv
MEDIACRAWLER_ENCRYPTED_VOLUME=/run/shensi-encrypted/mediacrawler
MEDIACRAWLER_PROFILE_ROOT=/run/shensi-encrypted/mediacrawler/profiles
MEDIACRAWLER_CRAWL_OUTPUT_ROOT=/run/shensi-encrypted/mediacrawler/crawl-output
```

The runner resolves one output root at construction and uses it for both job
creation and acknowledgement cleanup. Deployment must never fall back to the
source-local `.shensi-crawl-output` compatibility path. In Compose, the
corresponding container root is
`/var/lib/shensi-mediacrawler/crawl-output`. Create the host-side directory
with the correct UID/GID and mode before launch; do not rely on a bind mount to
silently create it with broader or wrong ownership.

Browser login mode is explicit:

```dotenv
# Local macOS operator login with installed Chrome
MEDIACRAWLER_BROWSER_HEADLESS=false
MEDIACRAWLER_BROWSER_CHANNEL=chrome
```

Douyin may return a verification interstitial instead of a QR to a headless
browser. With `MEDIACRAWLER_BROWSER_HEADLESS=false`, local operator login opens
a dedicated standard-Playwright Douyin window; Shensi explicitly disables CDP.
Production may set `MEDIACRAWLER_BROWSER_HEADLESS=true`. A server/container
deployment using visible login must provide and acceptance-test its chosen
standard-Playwright browser/display before claiming QR login support. The
Compose defaults remain headless and channel-neutral so an image never silently
assumes a host Chrome installation. Login-session creation allows 35 seconds
for cold browser startup; ordinary health and poll requests retain the shorter
gateway timeout.

The local visible tab is a separate best-effort operator observation mirror for
the approved keyword and public video. It is not the collector page: at most one
unfinished observation task runs outside the collector's critical await path.
A hung task may suppress later mirror movement but cannot interrupt collection
or create an unbounded navigation backlog. The MediaCrawler request client
remains the data authority, and observation navigation cannot fabricate
results. The browser dashboard polls the persisted Node projection, which
exposes only phase, a null or exact approved keyword of at most 100 Unicode code
points, visible/headless mode, monotonic sequence, and the closed
`candidateProjectionState` (`pending`, `ready`, or `failed`); it must not
expose raw URLs, profile paths, cookies, headers, selectors, CDP/WebSocket
endpoints, browser identifiers, raw logs, raw ingestion state, or leases. It
displays the localized phase, browser mode, keyword, attempt/update time, and
candidate allowance. Persisted hydration and public projection fail closed when
a non-null keyword is not frozen for the job or exceeds that bound. Every
dashboard refresh validates status before requesting candidates, so candidates
may appear before readiness; `ready` is the ordering boundary for the final
candidate read, and polling stops after the read paired with `ready` or `failed`.
A terminal `ready` response with zero candidates is valid. The frontend rejects
non-primitive enum values and accepts a candidate page only when its page,
candidate, and evidence objects contain exactly their public fields. Pages are
limited to 100 items; IDs/statuses are nonempty and display, excerpt, and
non-null cursor values obey their Unicode bounds. Evidence URLs must contain an
unmodified HTTP(S) authority and hostname with no credentials, backslashes,
whitespace/control/format characters, malformed percent escapes, or parser-
repaired authority. The pre-status queued placeholder announces only once per
outstanding run. Duplicate submission remains blocked while the current intent
is unobserved, nonterminal, or terminal with a `pending` projection. This has no
effect on comment or direct-message approval rules.

Compose bind-mounts that directory at `/var/lib/shensi-mediacrawler` and
refuses to create a missing host path. Stop the sidecar before backup or
restore. Copy browser state only with approved encrypted-at-rest backup
tooling, preserve ownership and exact `0700` mode, and never extract it into
an unencrypted staging directory.

Every owned directory is enforced as `0700` and metadata as `0600`. Browser
commands execute in an owned child process group with bounded startup, command, and
shutdown waits; timeout or protocol loss terminates that process and fails
closed. A graceful ASGI restart closes live browser handles while retaining
the protected profile and safe active metadata. Expiry and an authenticated
explicit disconnect delete valid profile state. On reload, invalid, missing,
malformed, symlinked, or unreadable session metadata is treated as quarantined
and its profile is deleted; it is never accepted as restart state. The
backend's MySQL replay rows preserve POST/DELETE results and reclaim abandoned
pending leases after a crash; memory mode is not a production substitute.

### Deploy and operate

From the repository root, validate the rendered configuration and build/start
the topology:

```bash
./scripts/deploy
```

The gateway health endpoint is `/healthz`; the backend container healthcheck
calls `/api/health`; MySQL is healthy after `mysqladmin ping` succeeds. View
service logs without exposing configuration values:

These liveness checks do not establish backend/sidecar protocol compatibility.
An upgrade is accepted only when both images were built from the same approved
revision and a bounded authenticated read of the private sidecar contract is
accepted by that revision's backend gateway. Do not print its bearer secret or
raw crawl records while performing the check.

Before deployment, the wrapper checks the host bind address `0.0.0.0`. It
allows that port to be held by the running gateway from this exact Compose
project for a redeploy, but rejects other owners. If `up -d` completes and the
bounded health checks fail, it runs `docker compose down --remove-orphans`
without volumes and reports only a stable cleanup result; it does not leave an
unhealthy topology running.

```bash
docker compose -f deploy/compose.yaml --env-file .env.production.local logs --follow --tail=100 gateway backend mysql
```

Stop the Compose deployment while retaining the database volume:

```bash
docker compose -f deploy/compose.yaml --env-file .env.production.local down
```

Do not add `--volumes` to a routine stop or rollback command.

### Upgrade, backup, and rollback

Before an upgrade, take and verify an access-controlled backup of the target
`shensi` database. At a minimum, keep a timestamped SQL dump in the ignored
`backups/` directory and verify it can be read by the approved restore
procedure. Encrypt the dump using the approved backup tooling before storing
it outside the deployment host:

```bash
mkdir -p backups
docker compose -f deploy/compose.yaml --env-file .env.production.local exec -T mysql \
  sh -c 'mysqldump -uroot -p"$(cat /run/secrets/mysql_root_password)" shensi' \
  > backups/shensi-before-upgrade.sql
```

After the backup, build and start all images with the deploy command above, then
check gateway, backend, MySQL, and the bounded private backend/sidecar contract
before accepting the upgrade. Backend and sidecar must move together even when
only one side's source appears to have changed. For rollback, stop the new
containers without removing `shensi_mysql`, return both backend and sidecar to
the previously approved repository/image revision, and run `up -d` with the same
production configuration. Restore a database backup only under the separate
approved restore/migration procedure; source databases remain read-only
migration inputs.

## Isolated real-customer trial

The real-customer trial is a separate local supervisor, not Production Compose,
`./scripts/dev`, or `pnpm dev:real`. Its tooling is available, but it is not a
published or accepted customer environment until every check in
`docs/operations/real-customer-trial.md` passes on the current revision.

### Fixed topology and runtime root

All five services bind loopback:

| Component | Address | Exposure |
| --- | --- | --- |
| MySQL | `127.0.0.1:3310` | private dedicated database |
| Gateway | `127.0.0.1:5608` | the only Quick Tunnel target |
| Frontend | `127.0.0.1:5610` | gateway upstream only |
| Backend | `127.0.0.1:5611` | gateway upstream only |
| MediaCrawler | `127.0.0.1:5612` | backend/private only |

The ignored default root is `.runtime/real-trial/`. Preparation makes its
runtime, `secrets/`, `state/`, `logs/`, `pids/`, and `tools/` directories
owner-only (`0700`) and writes credential/environment files as `0600`. Current
state paths are `state/mysql/`, `state/mediacrawler-profile/`, and
`state/mediacrawler-output/`; the generated environment is
`.runtime/real-trial/trial.env`. The profile and output paths are distinct
children of the encrypted state root. No `.env.real.local`, ordinary development
state, or source-local crawl output is reused.

### Lifecycle commands

Provide `SHENSI_TRIAL_APP_PASSWORD` only through the current owner-controlled
process environment, or point `SHENSI_TRIAL_APP_PASSWORD_FILE` at a regular
owner-only file. Do not place the value in the command line, shell history,
tracked files, PID/status metadata, or logs. Repeated preparation preserves the
generated secrets and requires the same supplied customer password.

```bash
pnpm trial:prepare
pnpm trial:start
pnpm trial:status
pnpm trial:verify
pnpm trial:stop
```

`trial:prepare` refuses occupied fixed ports, creates the protected runtime,
generates independent production secrets, writes the canonical encoded MySQL
URL, and copies the configured fixed cloudflared binary only after its SHA-256
matches. `trial:start` initializes a new dedicated MySQL data directory,
provisions the least-privilege `shensi_trial_app@127.0.0.1`, obtains the Quick
Tunnel HTTPS origin, injects that exact origin into backend CORS, and then
starts the loopback application stack. It bootstraps an internal random
super-admin only long enough to create or verify
`test@shensi.local` as tenant `admin` in `trial-pilot-001`; the backend is
restarted without `INITIAL_ADMIN_*`.

`trial:status` is the current authority for process state and the temporary
origin. Supply that origin to `trial:verify` through its requested process
environment without copying it into tracked documentation. A tunnel restart
may change it, and the trial is unavailable while the host sleeps or is
offline. `trial:stop` validates every recorded PID, command, and runtime nonce,
then terminates only matching trial process groups with bounded TERM/KILL
handling and removes live status. It does not stop the protected older services
or delete trial data.

### Login, action gate, and retention

The frontend alias is enabled only when `VITE_REAL_TRIAL=true`,
`VITE_TRIAL_LOGIN_ALIAS=test`, and
`VITE_TRIAL_LOGIN_EMAIL=test@shensi.local` are all complete. Only the exact
trim/lowercase alias match is mapped; unmatched identities and passwords remain
unchanged, and incomplete enabled configuration fails before login traffic. The
backend remains email-only and the customer receives tenant `admin`, never
`super_admin`.

The generated runtime fixes visible Chrome mode and
`DOUYIN_OUTREACH_ACTIONS_ENABLED=false`. QR readiness or account connection
does not authorize collection; collection does not authorize external sending.
Task 5 verifies that final outreach approval and the sidecar action route remain
fail-closed. It does not set the flag true.

Stopping preserves the dedicated MySQL data, encrypted profile, crawl state,
logs, and secrets. Before deleting the runtime root, export the trial database
and record whether the customer-approved Douyin profile is disconnected and
deleted or retained only in approved encrypted-at-rest storage. Never delete
the runtime tree merely to stop processes.

## Local and Baota entry points

Canonical local development uses the ignored `.env.local` with real MySQL and
the required runtime security keys:

```bash
cp .env.example .env.local
./scripts/dev
./scripts/verify
```

The development wrapper reserves `4491` for the private sidecar, `4191` for
the API, and `5191` for Vite before starting any process, forces
`CRM_STORE=mysql`, and gives Vite
`VITE_API_TARGET=http://127.0.0.1:4191`. `./scripts/verify` runs the context,
contract, backend-build, frontend-test/type/build, and local health gates;
keep the local runtime running while it performs its health checks.
These are ordinary integrated-development ports, not isolated trial ports.

The following root scripts remain useful for focused work:

```bash
pnpm --filter ./backend dev
pnpm --filter ./backend dev:mysql
pnpm --filter ./frontend dev
pnpm setup:mysql:local
pnpm dev:real
```

These focused commands do not start or reload MediaCrawler. They must not be
combined with an independently running sidecar of unknown revision for an
integrated acquisition check. Python adapter or private gateway changes require
stopping the complete local process tree and restarting `./scripts/dev`.

`pnpm dev:real` uses the ignored `.env.real.local`, MySQL on `127.0.0.1:3307`,
database `shensi_sales`, API port `4188`, and Vite port `5188`. It is not the
production Compose procedure and starts only backend plus frontend. It is also
not the isolated trial; do not reuse its data, state, processes, or tunnel as
trial evidence.

`deploy/baota/` remains the existing Linux/Baota package path. Its upgrade
mode uses `REUSE_EXISTING_DATABASE=true`; `REPLACE_DATABASE=true` is a
destructive reset. The package builder requires its external ignored bootstrap
archive and checksum. Do not run destructive installer modes as a verification
shortcut.

## Verification

Deployment-affecting changes require:

```bash
./scripts/context-check
pnpm test
pnpm build
pnpm test:baota-package
node --test tools/deployment-contract.test.mjs
node --test tools/mediacrawler-deployment.test.mjs tools/mediacrawler-provenance.test.mjs
pnpm test:task10:mysql
pnpm test:task10:browser
docker compose -f deploy/compose.yaml --env-file .env.production.example config --quiet
git diff --check
```

MySQL, Chromium, live-provider, Docker build, and running-container checks
need their corresponding local services. A memory-mode test does not prove a
MySQL migration or a production deployment.

### Dedicated-account external acceptance checkpoint

Deterministic verification does not authorize a real Douyin action. External
acceptance starts only after an operator supplies a dedicated test account and
displays the exact test-owned video/profile URLs. The operator must verify the
account has no unrelated audience or target, manually scan the QR, and stop on
CAPTCHA, verification, rate-limit, or account-warning state. Immediately before
approval, the user must see the selected account, target URL, exact test comment
and exact test direct message and give action-time confirmation. Without that
confirmation, do not approve the batch and do not send either action. The owned
ordinary-development UI is `http://127.0.0.1:5191/#acquisition`. The isolated
trial local UI goes through `http://127.0.0.1:5608/#acquisition`, and its
customer-facing entry is the current temporary HTTPS origin reported by
`trial:status`. This launch accepts only the disabled-action boundary; the
one-comment/one-message procedure remains a later, separately authorized gate.
Production acceptance uses the configured HTTPS `CORS_ORIGINS` origin with
`#acquisition` appended.
