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
```

The URL validator accepts only private/loopback plain HTTP targets. The secret
file must be regular, non-symlinked, owner-only, newline-free, and at least 32
non-whitespace bytes. Do not publish the sidecar or route browser-state traffic
through the public gateway.
The backend owns the crawler worker, expired-lease recovery, live and terminal
ingestion, and the evidence-retention lifecycle whenever this gateway is
configured. The sidecar advertises immutable completed pages while the crawl is
running; Node persists each page and may expose its candidates immediately. A
live projection failure leaves the page durable for terminal replay. Result
pages remain in the private sidecar until the backend's authoritative terminal
evidence/candidate/run-link transaction commits and the acknowledgement call
succeeds. A partial terminal state retains every previously published page and
its bounded failure code. The persisted acknowledgement starts a 24-hour
cleanup clock and is idempotent across restarts. That sweep removes both
normalized pages and the
bounded private upstream actor capture; it never treats upstream's anonymous
`creator_hash` as a public profile identity. Do not add an external cleanup
that deletes unacknowledged result pages. Backend cleanup removes only unlinked
crawler evidence after 90 days; DNC and audit authority are not TTL data.

The same configured gateway enables the backend-owned outreach-action worker
and expired-claim sweeper. The sidecar action endpoint is private and must use
the existing encrypted authenticated profile; do not expose it through the
public gateway. Node owns account serialization, fenced claims, persisted
server-time delays, final authority revalidation, daily limits, and receipts.
The sidecar owns only the single exact browser submission and closed platform
state detection. Platform verification, rate limiting, account warnings, and
login expiry pause the persisted social account and all its queued actions;
operators must resolve the account state through the normal account lifecycle,
never by bypassing the platform control.

On an existing MySQL installation, backend schema setup must complete before
workers start. It widens Douyin authoritative-run alias columns to 160
characters, backfills legacy automation JSON from
`acquisition_douyin_run_bindings`, separates legacy intent aliases from crawler
run aliases, and rebuilds the job alias projection. An unbound or ambiguous
legacy row stops startup with `acquisition_douyin_run_binding_migration_required`
or `crawler_job_alias_migration_required`; do not bypass that error or relabel
an intent ID as a run ID. Take the normal encrypted backup before applying the
migration.

Existing installations also add outreach action target, lease, fence,
attempt, receipt, and failure columns plus the account-serialization and
attempt tables. An installation with legacy action rows but no frozen public
target stops schema setup with
`outreach_action_target_migration_required`; reconstruct or retire those rows
under an operator-reviewed migration before restart. Never infer a public
target from a private handle.

Before starting the sidecar, create and mount an encrypted-at-rest host
directory. It must already exist, must not be a symlink, and must have exact
POSIX mode `0700`. The profile root must remain beneath that mount:

```dotenv
MEDIACRAWLER_ENCRYPTED_VOLUME=/run/shensi-encrypted/mediacrawler
MEDIACRAWLER_PROFILE_ROOT=/run/shensi-encrypted/mediacrawler/profiles
```

Browser login mode is explicit:

```dotenv
# Local macOS operator login with installed Chrome
MEDIACRAWLER_BROWSER_HEADLESS=false
MEDIACRAWLER_BROWSER_CHANNEL=chrome
```

Douyin may return a verification interstitial instead of a QR to a headless
browser. A server/container deployment must therefore provide and acceptance-
test its chosen visible browser/display or CDP arrangement before claiming QR
login support. The Compose defaults remain headless and channel-neutral so an
image never silently assumes a host Chrome installation. Login-session
creation allows 35 seconds for cold browser startup; ordinary health and poll
requests retain the shorter gateway timeout.

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

After the backup, build and start the new images with the deploy command above,
then check gateway, backend, and MySQL health before accepting the upgrade.
For rollback, stop the new containers without removing `shensi_mysql`, return
to the previously approved repository/image revision, and run `up -d` with the
same production configuration. Restore a database backup only under the
separate approved restore/migration procedure; source databases remain
read-only migration inputs.

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

The following root scripts remain useful for focused work:

```bash
pnpm --filter ./backend dev
pnpm --filter ./backend dev:mysql
pnpm --filter ./frontend dev
pnpm setup:mysql:local
pnpm dev:real
```

`pnpm dev:real` uses the ignored `.env.real.local`, MySQL on `127.0.0.1:3307`,
database `shensi_sales`, API port `4188`, and Vite port `5188`. It is not the
production Compose procedure.

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
local UI is `http://127.0.0.1:5191/#acquisition`; production acceptance uses the
configured HTTPS `CORS_ORIGINS` origin with `#acquisition` appended.
