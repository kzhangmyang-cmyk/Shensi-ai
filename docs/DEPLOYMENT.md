# Deployment

## Xiaohongshu desktop development

The independent source integration uses `SHENSI_XHS_UPSTREAM_PATH` (absolute clean pinned checkout) and the locked `services/xiaohongshu/.venv` Python environment. See [adapter setup](../services/xiaohongshu/README.md). It does not reuse Douyin profiles or queues. `XHS_DESKTOP_SENDING_ENABLED` defaults false in both Main and Backend; `XHS_DAILY_LIMIT` defaults 20 and accepts 1–100. Do not enable real sends for offline verification. Backend MySQL startup initializes the independent encrypted `xiaohongshu_messaging` table using its existing pool; database errors abort composition, never fall back to memory. No new installer is required for development. Current live application has not been restarted for this integration.


For the single-instance persistent account service, fixed HTTPS, private operator
initialization, backup and rollback, use
[account cloud runbook](operations/account-admin-cloud-runbook.md) and
`deploy/compose.cloud.yaml`. This configuration is staged, not a deployed service.

## Platform operator bootstrap

The browser console is `/admin.html` in the standard frontend build and uses
same-origin `/api/platform/v1`. Render's API-only test Blueprint does not serve
this frontend; production needs the static frontend/gateway and HTTPS. Startup
adds `platform_administration_state` and `account_administration_audit`.
Preserve the single API instance lock.

Bootstrap is an offline maintenance operation. Stop the API, select the intended
production database, and privately supply
`SHENSI_PLATFORM_BOOTSTRAP_CONFIRM_DATABASE` matching its database name,
`SHENSI_PLATFORM_BOOTSTRAP_USER_ID` for an active non-super-admin account, and
`SHENSI_PLATFORM_BOOTSTRAP_TOTP_SECRET` from the operator's authenticator
(base32, 32–128 characters). Run `pnpm --dir backend platform:bootstrap-owner`
with `NODE_ENV=production` and existing database/security configuration.
Bootstrap acquires the API lock, rejects an existing owner and never prints
credentials. Restart the API and verify MFA at `/admin.html`.

Preserve stable `AGENT_JOB_ENCRYPTION_KEY` and `JWT_SECRET` in secret storage.
The former encrypts MFA along with existing protected payloads; never rotate
it as a recovery shortcut. Owner initialization makes new registrations pending;
existing unmanaged customers remain unchanged. Source tests did not initialize a real owner.

For lost operator MFA, stop the API and use the same production database and
stable keys with `SHENSI_PLATFORM_RECOVERY_CONFIRM_DATABASE` (exact database
name), `SHENSI_PLATFORM_RECOVERY_USER_ID`, privately supplied base32
`SHENSI_PLATFORM_RECOVERY_TOTP_SECRET`, and `SHENSI_PLATFORM_RECOVERY_REASON`.
Run `pnpm --dir backend exec tsx src/platform-admin-recover-mfa.ts` with
`NODE_ENV=production`. The CLI requires the exclusive API lock and atomically
replaces MFA, revokes both ordinary/operator sessions and appends an audit.
Restart the API and verify the new authenticator; distribute the new seed
privately. Customer recovery is separate: the console issues a 15-minute,
single-use token, consumed at `/admin.html#reset`.

## Isolated admin development

Build with `pnpm build`, then start this Mac's dedicated test environment:

```sh
DOCKER_HOST=unix:///Users/mac/.colima/shensi-trial/docker.sock node scripts/admin-preview-runtime.mjs start
```

Open `http://localhost:5681/preview-access` for synthetic operator credentials
and the current one-time authenticator code; open `/admin.html` for operations
or `/` for the actual customer application. Use separate browser profiles for
operator and customer sessions. The helper is loopback-only, checks Host/Origin
and must never be used as a production login/recovery mechanism.

The launcher creates its own labeled MySQL container/volume and database
`shensi_admin_preview`, validates engine/container/port identity on reuse, and
starts the full backend on loopback 5680 with gateway 5681. Its CORS allowlist
contains exactly the browser gateway origin and `http://127.0.0.1:5680`, because
the packaged desktop gateway rewrites Origin to its configured upstream API.
Arbitrary dynamic loopback origins are not allowed. Private configuration
in `.runtime/admin-preview/` persists across starts. No desktop/trial database
configuration is loaded; provider credentials are absent and all outreach
execution flags are disabled. Trial plan values used by acceptance are synthetic,
not commercial defaults. The gateway serves `frontend/dist`; rebuild frontend
changes and restart this isolated runtime for backend changes.

`node scripts/admin-preview-runtime.mjs stop` stops only the recorded, verified
preview listeners and retains its MySQL data. Do not delete its private config
or change engines to repair startup. This preview requires this computer and
Docker to remain running; it is not a public deployment.

Verification: `node --test scripts/admin-preview-runtime.test.mjs`, then
`pnpm --dir frontend exec tsx scripts/admin-preview-browser.mts` against the
running preview. The browser test creates clearly synthetic enterprises and
customers, checks real MySQL commits and saves screenshots/results under
`.runtime/admin-preview/artifacts/`. Credentials and sessions remain private
under the runtime directory, never in tracked documents.

Immediately after successful browser acceptance, run
`SHENSI_ADMIN_PREVIEW_MFA_ACCEPTANCE=1 pnpm --dir frontend exec tsx scripts/admin-preview-mfa-recovery.mts`
to validate offline MFA recovery. It stops/restarts only the verified preview,
updates its synthetic authenticator, rejects saved old sessions and old OTP,
and compares persisted enterprise/account/customer data. Run within the saved
operator session's 15-minute lifetime. Results are stored alongside browser
artifacts; the preview remains running with the new helper code after success.

Package acceptance may explicitly save one verified test build SHA with
`node scripts/admin-preview-runtime.mjs admit <64-character-manifest-sha256>`.
The command validates only this preview's engine/container identity; restarting
the isolated runtime applies exact admission for that digest, retaining all four
outreach switches as false. It never modifies the desktop-local database identity.

## Desktop development operations

The decision module initializes the additive `decision_personal_memory` table on
normal Backend startup. Its encrypted actor/workspace aggregate shares the existing
encryption key lifecycle; do not rotate keys or create another database to enable
personal preferences/reviews. No existing report table or data is rewritten.

For frontend-only desktop acceptance with retained outreach tasks, run
`SHENSI_DOCKER_HOST=unix:///Users/mac/.colima/shensi-trial/docker.sock pnpm --dir desktop exec node --import tsx ../scripts/desktop-local-runtime.mjs start-ui`
on this configured Mac. `start-ui` uses the same validated database identity and
source Electron build as `desktop:local`, but disables outreach approval and both
server/desktop executors for that process. It does not modify queued tasks.
Other hosts must select their own existing validated engine, not copy this path.

Use this launcher for login-only diagnosis too: it rebuilds the client and gives
the same exact manifest digest to Backend 5638 while keeping retained outreach
tasks inactive. Restart the complete launcher after source changes, not Electron
alone. The 5680 admin-preview API is a separate synthetic-account environment,
not the daily acquisition backend; do not repoint the daily app there or copy
its accounts, secrets or browser profiles into desktop-local. If the UI reports
`desktop_client_build_not_admitted`, compare the running Main's manifest with
the running Backend admission before asking the user to scan again.

## Fresh local desktop development

The current delivery route provisions a new persistent local database from the
latest schema instead of migrating Trial business data. Keep Trial and its
database unchanged until replacement acceptance. New storage, database
credentials, encryption keys and ports must be independent; do not copy old
outreach queues or fabricate accepted-migration evidence. Alibaba production
deployment is deferred. The currently authorized cloud exercise is an isolated
free test deployment: a Render Docker Web Service for the central API and a
fresh Aiven for MySQL service. It must not copy the local desktop database or
outreach queues.

## Free Render + Aiven test deployment

The [account-admin launch readiness plan](operations/account-admin-launch-readiness.md)
defines the proposed overseas production and later Alibaba migration scope.
It does not change this test runtime. Production scaling must address both
worker ownership and legacy in-memory snapshot persistence; removing the API
singleton lock alone does not make concurrent API writers safe. A first
single-instance release may instead use a verified maintenance-window procedure.

`render.yaml` is the current code-defined entry. It builds only the Backend
Docker image, binds the API to Render's injected `PORT`, checks
`/api/health`, uses the free plan and keeps automatic deploys off. The
desktop-local Sidecar and visible Douyin browser remain on each Mac; they are
never moved into Render.

The current isolated test deployment uses Aiven MySQL service
`shensi-test-mysql` and Render service `shensi-api-test`; its public health
endpoint is `https://shensi-api-test.onrender.com/api/health`. The service URI
is stored only in Render's secret `DATABASE_URL`, and the Aiven CA certificate
is stored only in the multiline secret `MYSQL_SSL_CA`. The Blueprint fixes
`MYSQL_SSL_MODE=verify_ca`; startup fails closed if the CA is absent or not a
PEM certificate. The MySQL client removes Aiven's URI-only `ssl-mode` parameter
before passing the URL to mysql2, then verifies both the certificate chain and
the server hostname through explicit SSL options. Local Compose continues to
use `MYSQL_SSL_MODE=disabled`.
Secrets generated by Render are not committed. Do not put credentials in
`render.yaml` or in tracked `.env` files.

Aiven free MySQL enforces `sql_require_primary_key`. Runtime-created tables
must therefore declare a real primary key; do not disable this server rule.
The current schema includes composite primary keys for outreach action attempts
and financial-ledger source heads, and a full Backend startup against the empty
Aiven database is part of the integration gate.

Render must receive a private source without gaining access to unrelated
repositories. The preferred test route is a dedicated private repository with
the Render GitHub App limited to **Only select repositories** and only that
repository. Its deploy branch contains the root `package.json`, lockfile and
workspace manifest, `backend/`, `contracts/`,
`frontend/src/generated/ai-acquisition.ts`, `deploy/docker/backend.Dockerfile`,
`render.yaml`, and the root `.dockerignore`. Do not include `.env*`, backups,
runtime state, database exports, browser profiles, packaged desktop releases or
provider-key directories. The current working tree has no push-capable remote,
so cloud snapshots are pushed only from a disposable clone of the dedicated
private repository. The Render GitHub App is limited to that one repository.
Do not add a push-capable cloud remote to the canonical working tree.

`sync: false` in `render.yaml` prompts for required secrets when a Blueprint is
created. Updating an existing Blueprint does not re-prompt reliably: set changed
secrets directly on the existing Render service, save them, and verify startup
or health rather than treating masked bullets as proof that a value is present.

The current Backend holds a MySQL advisory lock for the complete API process.
Render's **Restart service** and rolling deploy paths start the replacement
before stopping the live instance, so the replacement correctly refuses to
start while that lock is held. For this isolated free test only, use **Suspend
Web Service**, wait for the suspended state, then **Resume Web Service** when a
true process restart is required. Do not disable the database lock merely to
make rolling deploy green. Before Alibaba production or any zero-downtime
deployment, replace the process-wide API singleton with explicit leader
election for the background workers that actually require exclusivity.

A private prebuilt image is the fallback, not the default. It must be built for
`linux/amd64`, pushed to a supported private registry, and exposed to Render
with pull-only credentials (for GHCR, a token limited to `read:packages`). This
route does not use `render.yaml` to build source and requires an explicit manual
redeploy whenever the image reference changes.

The first cloud deployment stays in `migration_locked` desktop admission.
This permits health, registration/login and read-only verification without
letting an arbitrary or stale desktop build claim actions. Switch to `exact`
only when a specific packaged App build-manifest digest has passed the release
gate. A new workspace can then be registered through the existing login UI;
no development seed is created.

This free topology is for integration testing, not production acceptance.
Render free web services sleep after inactivity and have an ephemeral local
filesystem, while Aiven's free MySQL service has bounded CPU, memory, disk and
connection limits. Cloud success does not replace two-physical-Mac, WAN/TLS or
real-platform acceptance.

The cloud business smoke uses randomly generated test workspaces only. It logs
the same account into two independent HTTP cookie/CSRF clients, creates a test
customer with client A, reads and updates it with client B, proves a second
workspace cannot see it, logs out B without invalidating A, performs a full
suspend/resume, and proves A can still read the updated record. Delete the test
customer after the assertion; never reuse a real customer or copy the local
desktop database for this smoke. HTTP clients prove session/data semantics, not
two physical Macs.
The current non-secret result record is
[`operations/render-aiven-free-test-evidence.json`](operations/render-aiven-free-test-evidence.json).

`pnpm desktop:local` starts the fresh persistent development entry. Its fixed
Compose project is `shensi-desktop-local`, its database is `shensi_desktop`, and
its loopback MySQL/Backend ports are `3313`/`5638`. MySQL 8.4.11 alone runs in
Compose; the latest Backend runs on the host and Electron Main owns the local
Sidecar. There is no Web gateway, Vite, noVNC or new installer in this route.
`pnpm desktop:local:prepare` starts only MySQL; it does not initialize application
tables or prove application readiness. Normal Backend startup initializes the
current application schema. The source tests are `pnpm test:desktop-local`.

Private configuration is `.runtime/desktop-local/config.json` (mode `0600` in
a `0700` directory); independently generated keys and passwords are reused, not
rotated or copied from Trial. The named `shensi-desktop-local_mysql_data` volume
persists across restarts. Existing resources must match this profile's owner
label and Engine. There is no reset/delete command. A port conflict stops startup
without terminating other programs. Cmd+Q in the development app or Ctrl+C stops
its Backend; MySQL and its volume remain for the next launch.

The launcher supplies an allowlisted environment and `SHENSI_SKIP_LOCAL_ENV=true`
so the Backend does not load the repository's old `.env`. It disables demo seeds
and server workers/schedulers. Outreach approvals and desktop execution are
enabled; legacy/server outreach execution remains disabled. Main may claim only
actions separately confirmed by the user: comment approval never also approves
a private message. A new workspace has no inherited queue. Generated
bootstrap credentials remain in the private configuration; use registration for
a normal independent workspace. It builds the latest Main/Renderer, computes the
real development-manifest digest for exact client admission, then opens Electron
against `http://127.0.0.1:5638`. Source changes require restarting this launcher;
installed Shensi and its data remain untouched.

For a central HTTPS deployment serving both Apple Silicon and Intel clients, set
`SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256` to the chosen primary build and
put the other currently supported exact build digests in
`SHENSI_DESKTOP_ADDITIONAL_ADMITTED_BUILD_MANIFEST_SHA256S` as a comma-separated
list. The additional list is optional, accepts at most seven unique lowercase
64-hex digests, and is rejected in `migration_locked` mode. Remove superseded
digests after a controlled rollout; never use it as an authentication or tenant
authorization bypass.

Backend acceptance (not UI/platform acceptance) uses the current database:

```bash
# Once only: register two isolated test workspaces and save one marked customer.
pnpm --dir desktop exec node --import tsx ../scripts/desktop-local-acceptance.mjs seed
# Restart desktop:local, then verify the same accounts/data without new writes.
pnpm --dir desktop exec node --import tsx ../scripts/desktop-local-acceptance.mjs verify
# Exercise user enrollment -> Main device registration in the host timezone.
pnpm --dir desktop exec node --import tsx ../scripts/desktop-local-acceptance.mjs enrollment
```

The seed leaves two `local_check_*` accounts and one `本地数据库验收-*` customer
in the fresh database. Their generated credentials are never printed. The
`enrollment` phase also registers one stable test installation for the first
workspace without copying it into Electron's private credential store or binding
a social account. Run it with the normal host timezone: enrollment DATETIME
reads must preserve their stored UTC wall clock even outside UTC. The phases
test real MySQL/API behavior; window/real-platform tests are separate and require
an unlocked Mac and the applicable user confirmation.

`api:prepare` still prepares
the retained migration path using Trial secrets; `verify-empty` and the storage
verifiers own disposable test databases and must not be used as the durable
application database. Their schema tests remain useful for verifying fresh
initialization. The outreach initializer decodes one layer of MySQL CHECK
metadata quote escaping before validating the fixed predicates and enforcement;
the same comparison is used for preflight and repair decisions. Fresh schema
initialization and a no-repair second ensure must pass on actual MySQL before
claiming that the new database is ready.

Use the latest Electron development window for business acceptance; package and
replace the installed application only after the accepted delivery checkpoint.
The current sequence and stage evidence live in
[`PROJECT_STATUS.md`](PROJECT_STATUS.md).

## Desktop bridge activation boundary

The source desktop bridge includes enrollment, exact account binding, narrow
status IPC and the current acquisition UI. These changes do not install an app,
publish a trial or run a database migration. The fresh local desktop launcher
enables confirmed desktop actions as described above; deployment flags for the
retained Trial and future Alibaba runtime remain independent.
The current runtime topology below remains the operating reference until the
owned API-only migration is accepted. Production manifest generation, the
disposable MySQL fault matrix and real two-Mac acceptance remain pending.
Alibaba resources have not been provisioned; use the canonical
[Alibaba/two-Mac acceptance checklist](desktop/acceptance/aliyun-two-mac-checklist.md)
before activating cloud-backed desktop execution. No cloud resource is required for the
isolated Memory/fake-Sidecar regression tests.

### Disposable bridge MySQL verification

`pnpm api:verify:multi-mac-crm:mysql` uses the same exact disposable-runtime
ownership boundary to validate two independent authenticated clients for one
account against the real MySQL store. It covers cross-client CRM read/update,
store restart durability, workspace isolation and session-independent logout.
It does not start Electron, contact Douyin, provision cloud infrastructure or
substitute for WAN/TLS and two-physical-Mac acceptance.

`pnpm api:verify:desktop-action-bridge:mysql` is the database-only Task 9
verification stage. Run it only with authorization to create and destroy a
fresh disposable container runtime. It reuses the storage verifier's shared
`disposable-5628-3312` owner lock, fresh secrets and MySQL volume on loopback
port `3312`. The fixed backend and desktop suites use actual MySQL repositories,
local service HTTP, two temporary device roots and recording fake Sidecars.
They do not start the packaged app, container Backend/Gateway or real Douyin.
Neither Trial nor retained API-only configuration is changed.

Disposable database startup checks MySQL through read-only Docker Engine
requests on the selected runtime socket. It requires one running `mysql`
container in the exact project and promoted owned network, then inspects
`State.Health.Status`; a running container alone is not ready. `starting` is
polled every 250 ms within the 60-second default deadline. Missing/unhealthy
health, identity drift or container replacement fails the run. Timeout cancels
the pending Engine request or poll delay before startup settles and cleanup
can proceed. Retained-runtime and explicitly injected health adapters are
unchanged.

The command supplies the private admin URL and matching lock nonce itself;
do not set a production database URL or run the low-level MySQL mode manually.
The child receives only the selected runtime's PATH and pinned Unix socket
(`SHENSI_DOCKER_HOST`) alongside the fixed test variables; unrelated parent
credentials and API configuration are not inherited. The child still performs
the full live owner/Engine check. Missing discovery inputs fail before taking
the shared lock or preparing a test runtime.
Both suites must emit their exact real-execution marker after their assertions;
skipped, partial and failed runs cannot pass. Child output is not echoed because
database errors can contain credentials or message contents. A failed child
emits `DESKTOP_ACTION_STORAGE_DIAGNOSTIC` with fixed suite/phase/code values,
allowlisted static schema objects, bounded statement ordinals, top-level TAP
failing-test numbers from stdout and process exit/signal metadata only.
Unlisted driver codes can retain a four-digit MySQL errno, not the driver message.
Indented assertion payloads and stderr cannot supply test numbers. MySQL
fixture setup distinguishes connect, database creation, each schema, seeding
and cleanup. Unknown error details stay redacted; diagnostics are not success
evidence. The retained
sanitized cleanup receipt is
`.runtime/api-only/evidence/desktop-action-bridge-mysql/<run-suffix>.json`, with
schema `shensi.desktop-action-bridge-mysql.cleanup-receipt`. It records the fixed
suite and result, not full runtime or platform acceptance. On interruption the
verifier waits for the active bounded phase to settle, starts no later phase,
then retains failure evidence and removes only the owner-validated disposable
project. Failed ownership/cleanup checks leave the lock/resources for inspection.

The full `pnpm api:verify:desktop-action-bridge` Backend/Gateway/browser operator
is not implemented yet. API-only activation and the full matrix remain required;
the `:mysql` stage does not substitute for them. The disposable MySQL bridge
stage passes with the independent-DM checks, including the real repositories
and fake Sidecar transport; current run evidence belongs in `PROJECT_STATUS.md`.
Never skip owner/schema validation or point tests at another database. Compose
must be discoverable on the launch PATH (this Mac uses
`/Users/mac/bin/docker-compose`); a missing executable fails before preparing
any test database. Historical failed matrix receipts remain diagnostic history,
not the current acceptance status.

### Isolated outreach schema reproduction

`node scripts/verify-desktop-action-storage.mjs outreach-schema` uses the same
disposable runtime, selected Engine, owner lock, fresh secrets and validated
cleanup. It runs only `backend/test/outreach-schema-mysql-test.ts`: create a
fresh random test database, initialize social-account and installation
prerequisites, then execute the real outreach initializer twice. The second
ensure must not issue repair mutations. No business rows are seeded, no HTTP
server or Sidecar starts, and no platform action is executed.

Use this entry only with disposable-environment authorization. Its own marker
`DESKTOP_ACTION_STORAGE_LIVE_TEST_EXECUTED:outreach-schema` is required after
assertions and test-database cleanup; default skipped runs cannot pass. Its
receipt is `.runtime/api-only/evidence/desktop-action-storage/<run-suffix>.json`
with suite `outreach-schema`, never bridge-matrix or full-runtime proof.
Statement ordinals count execute calls from the first outreach ensure onward;
application validation failures identify the static schema object instead.
If outreach validation fails, the child additionally projects its first CHECK
metadata result into five fixed objects: match count (`none`, `one`, `multiple`),
enforcement (`YES`, `NO`, `unknown`), and booleans for escaped quotes, matching
before quote decoding, and matching after one quote-decoding step. The parent
accepts only this closed structure for `outreach-schema`. It does not alter the
initializer, ignore invalid constraints or print raw metadata/SQL/credentials.

Job `job-mtoaksvj-3c26bd55` failed at the execution-target CHECK preflight after
all CREATE statements. Its failed receipt is `7ae27f3c394f.json`; owned temporary
resources were cleaned. The diagnostic run `job-mtoc86kp-76f93269` under the
approved fresh-database work then confirmed all five constraints were unique and
enforced, with escaped clauses matching the expected predicates after one
decoding step. Its failed receipt is `7aeb385c1d5e.json`. The corresponding
outreach source fix passed focused regression and real-MySQL revalidation in
`job-mtoceraq-07af969c`: `outreach-schema` initialized successfully and a second
ensure required no repair. The same job passed `pnpm test` and `pnpm build`.
These disposable schema tests do not create a persistent application database.

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
  `backend`, `/douyin-live/{token}` WebSocket upgrades to `media-crawler`, all
  other requests to `frontend`, and `/healthz` locally.

The backend is not published to the host. It listens on `0.0.0.0` only so the
internal gateway can reach it; Compose's internal network is its network
boundary. The backend and MediaCrawler sidecar join the egress-enabled
`shensi_egress` network for approved outbound calls. The backend and gateway
join both `shensi_internal` and the internal `shensi_mediacrawler` network. The
gateway may route only the token-bound live-login WebSocket on that sidecar
network; it does not publish the sidecar HTTP API, VNC TCP, X11, or debug
surfaces. MySQL and frontend remain only on `shensi_internal`. Production always sets
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
environment, Playwright Chromium, Xvfb, and x11vnc during the image build. The
frontend pins `@novnc/novnc` `1.7.0`; no standalone noVNC server is deployed.

Use `./scripts/deploy` as the canonical production command. It accepts only
MySQL persistence with `CRM_SEED_DEVELOPMENT_DATA=false`, checks
`.env.production.local` has POSIX mode `0600`,
requires the security values and owner-only MySQL secret files of at least 32
bytes, confirms that the canonically URL-encoded `DATABASE_URL` password and
`SHENSI_MYSQL_APP_PASSWORD` agree
with `deploy/secrets/mysql_app_password`, then renders, builds, starts, and
health-checks Compose. It reports service state and public origin only; it
never prints configuration or secret values. Docker Engine/Compose absence is
a hard failure, not a successful deployment. The isolated customer-trial
supervisor uses Docker inside its dedicated Colima profile `shensi-trial`; that
does not substitute for rendering and validating the separate production
Compose topology on its target Docker environment.

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
DOUYIN_ACTION_VISUAL_LOCATOR=disabled
```

The URL validator accepts only private/loopback plain HTTP targets. The secret
file must be regular, non-symlinked, owner-only, newline-free, and at least 32
non-whitespace bytes. Do not publish the sidecar. The sole public browser-state
transport is the same-origin `/douyin-live/{token}` WebSocket described below;
every other sidecar route and the underlying VNC TCP listener remain private.
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
external actions. Backend approval, server execution and desktop execution use
the three explicit `DOUYIN_OUTREACH_*_ENABLED` roles shown in `.env.production.example`;
if one split flag is present, all three must be exact lowercase booleans. With
no split flags, the legacy adapter maps `DOUYIN_OUTREACH_ACTIONS_ENABLED` to
approval/server roles only. The Sidecar action manager still consumes that
legacy switch. Roles default closed. Disabled approval stops before persistence,
and locked desktop-client admission rejects gated HTTP mutations even earlier.
Collection remains available independently of action execution roles.

Only a separately accepted action-enabled environment may use the private
sidecar action endpoint and existing encrypted authenticated profile; never
expose it through the public gateway. Node then owns account serialization,
fenced claims, persisted server-time delays, final authority revalidation,
daily limits, and receipts. The sidecar owns only the single exact browser
submission and closed platform-state detection. Before calling the executor it
must commit the `started` journal with file and parent-directory `fsync`; either
barrier failing aborts before the platform write. Login-version and account-
binding metadata use the same crash-durable replace pattern. Comment approval and private-
message approval are separate commands. A version-2 private message is
claimable only after the same candidate's exact comment has a durable successful
receipt and the user provides the second confirmation. The account reserve is
at least 60 seconds for comments and ten minutes for private messages; the
private-message daily default is 20 with range 1–100, independently of the
acquisition default 50 with range 1–200. The frozen policy time zone derives the
approval local date; claim-time quota counts real attempts on the actual claim
local day, including retries, and resets only the next local day. The same batch
revision/candidate can never receive a second DM approval across dates. On one
account-local day, the same candidate also cannot receive another DM from a
different batch; a later local day may use a new batch without reopening the old
revision. The focused vendored `cv-cat/DouYin_Spider` transport authenticates
from the already-bound sidecar context, requires the canonical public
`/user/{sec_uid}` target to equal the API-resolved recipient, creates the
conversation, and sends the approved text once after repeated account-authority
checks. A deterministic UUIDv5 client message ID derives from the immutable
action ID. Only a hashed `douyin-im:<sha256>` receipt leaves the sidecar; a
post-send exception is ambiguous and is not retried. Raw text, conversation/
ticket IDs, cookies, security material, and raw `sec_uid` remain private. The
pinned source has no discovered public `LICENSE`; reuse is based on the
operator's statement of author permission, with evidence retained outside Git.
Platform verification, rate
limiting, account warnings, login expiry, expired external-write leases, and
uncertain receipts pause the persisted social account and related work;
operators must never bypass the platform control. For an uncertain exact
action, the authenticated page exposes a separate operator-confirmed read-only
reconciliation. It may store a unique existing post-start receipt, but it never
clicks a send control, requeues the action, or automatically resumes the
account/successor.

`DOUYIN_ACTION_VISUAL_LOCATOR` accepts only exact `disabled` or `rapidocr`.
Omission defaults to `disabled`; empty, padded, case-changed, or unknown values
fail startup/deployment validation. DOM/ARIA remains primary for comments. In
`rapidocr` mode the pinned local OCR runtime may suggest only a missing comment
entry/send control
before an exact allowlisted DOM rebind. It never chooses account, target,
editor, content, or receipt; screenshots and recognized text are not persisted
or logged. Visual MCP is development-only diagnostics, not a production
dependency. The browser action path remains model-provider neutral.

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
attempt tables. Version-2 private-message authorization fields, including the
authorization version, approver/timestamp, frozen daily limit/ordinal, stage
hash, and predecessor receipt binding, are nullable so old rows stay readable.
V3 uses the same nullable authorization fields with a null predecessor; no
schema migration or rewriting of old approvals is needed. Schema setup does
not backfill legacy direct-message rows; unversioned rows remain
unclaimable. An installation with legacy action rows but no frozen public
target stops schema setup with
`outreach_action_target_migration_required`; reconstruct or retire those rows
under an operator-reviewed migration before restart. Never infer a public
target from a private handle.

Legacy queued comments whose batch JSON predates `timeZone` are handled at claim
time before any attempt is consumed. MySQL recovers and persists the zone only
when the exact immutable policy version/hash and its plan, account, and login
binding all match. If that proof is unavailable, the comment and its blocked
successor are terminalized without consuming another attempt. Version-2 private messages are not
eligible for this compatibility path and still require an explicit frozen
batch time zone.

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

Browser login mode and display ownership are explicit. The generated isolated
public trial uses:

```dotenv
MEDIACRAWLER_BROWSER_HEADLESS=false
MEDIACRAWLER_BROWSER_CHANNEL=
MEDIACRAWLER_BROWSER_DISPLAY=virtual
```

Douyin may return a verification interstitial during login. For the trial,
headed bundled Chromium runs only under Linux Xvfb in
the dedicated Colima profile `shensi-trial`; it never opens installed Mac
Chrome. Each login attempt owns an isolated Xvfb display and x11vnc process.
x11vnc binds only to sidecar loopback with no password because it is reachable
only through the server's separate token boundary; its TCP port is never
published or placed in a public DTO. The authenticated application API starts
with the asynchronous login-session create flow: `POST` immediately returns
`awaiting_scan` with `loginPage: null`. Background open does not hold the global
state lock. Once navigation reaches an allowlisted official page, the sidecar
establishes display/context and the worker VNC handle, then registers the
context/generation under the `AccountManager` lock. Live-token minting is
available before the later best-effort screenshot, DOM, QR, and panel
preparation completes. A missing preparation frame leaves `loginPage: null`
and may leave `qrStatus: opening`; it does not close an otherwise interactive
context. Poll and interaction I/O
use a per-session lease with generation/CAS authority; terminal completion
closes and flushes the context before the matching CAS persists account
authority. The acquisition login dialog mounts noVNC/RFB inline as the default
interaction surface and calls
`POST /api/v1/acquisition/social-accounts/douyin/login-sessions/{sessionId}/live`.
That operation returns only a same-origin socket path and expiry backed by a
short-lived, single-use token bound to the workspace-owned sidecar session.
If the context is not ready, it returns retryable HTTP `409`
`douyin_login_session_not_ready`; the embedded client waits and remints a token
for the same session/profile. The separate Shensi live-login tab is a backup,
not a second browser authority.
The gateway upgrades `/douyin-live/{token}` and the sidecar consumes the token
before proxying binary frames to that session's loopback x11vnc listener. The
bounded JPEG plus normalized click, text, key, and scroll API is another
backup. The compatibility `qrImageDataUrl` contains a bounded QR data URL when
best-effort capture succeeds and is otherwise `null`. Login-session `GET` and
interaction `POST` use a dedicated 70-second gateway transport timeout; other
MediaCrawler requests keep their shorter defaults. After QR scan the frontend
continues polling the same session until the backend reports `active` or a
documented terminal result. The container
publishes only its HTTP API at host `127.0.0.1:5612`; it publishes no VNC TCP,
CDP, X11, or browser-debug port. The runtime provisions 1 GiB of `/dev/shm`, and the adapter
removes Playwright's `/tmp` shared-memory fallback so Douyin's page workload
does not consume the bounded temporary filesystem.
`MEDIACRAWLER_BROWSER_DISPLAY=virtual` requires Linux and a
valid X display, so the same configuration in a native Mac process fails before
browser startup. Ordinary local development may separately use operator display
mode and an installed browser channel; it is not the public-trial runtime.
Only a collection-only runtime with outreach disabled may set
`MEDIACRAWLER_BROWSER_HEADLESS=true`. An action-enabled deployment fails
preflight in headless mode, and parent/child IPC independently rejects a bypassed
action or reconciliation before page creation. A server/container
deployment using headed login must provide and acceptance-test its browser,
Xvfb, x11vnc, and WebSocket path before claiming interactive login support. The
Compose defaults remain headless, channel-neutral, virtual-display, and
action-disabled so an image never silently assumes a host Chrome installation.
Bootstrap generation/stale checks prevent an older result from overwriting or
closing a replacement context. A replacement waits for the preceding bootstrap
thread to exit, and disconnect invalidates outstanding preparation. The
sidecar does not globally reuse opening sessions across tenants. The public
backend scopes replay to workspace plus `Idempotency-Key` and maintains one
repository-backed opening lease/fence per workspace, so different keys or
backend instances reuse only an unexpired upstream `awaiting_scan` session.
Cancellation and terminal, expired, or missing state clear that slot. The
cancel path clears the matching slot before contacting the sidecar. If the
sidecar disconnect fails, the old session remains available only for another
cancel attempt and is not eligible for create-time reuse. The
sidecar's successful cancel invalidates its generation, registry entry, and
unused live tokens before waiting on browser I/O. A live bootstrap, or otherwise
one tracked cleanup thread, owns the eventual context close and private-profile
removal. Sidecar shutdown joins this tracked cleanup and reports failures. This
prevents a long best-effort screenshot/QR prepare or blocked poll from turning a
committed cancel into a gateway timeout; normal clients disconnect RFB before
the cancel call. The
frontend keeps a single connect in flight, disables replacement during
`opening`, retries live-mint `409` for the same session, and cleans up requests,
timers, and RFB on unmount. Login-session creation stays inside the
short gateway budget while bounded cold browser startup continues in the
background. Only browser/display/VNC failure or a non-allowlisted page is a
fatal open failure. That failure, disconnect, expiry, explicit close, shutdown,
a fresh start, and persistence failure clear unfinished work, leases, and
browser resources without replay.

CAPTCHA, slider, login-verification, and platform-warning states have no solver,
token injection, or alternate route. During login, the human handles them only
through embedded noVNC/RFB or backup controls in that same sidecar context.
Action-time verification follows the separate documented fail-closed/manual-
handoff rule. The isolated trial exposes neither its X display nor VNC TCP and
never triggers a Mac-window fallback.

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
| MediaCrawler | `127.0.0.1:5612` | Docker-to-host loopback; backend plus token-WS gateway only |

MediaCrawler is the one containerized component in this host-managed trial. The
supervisor creates/starts only the dedicated Colima profile `shensi-trial`,
builds the pinned image from the current worktree, and runs headed bundled
Chromium under Xvfb. The Docker publish address includes literal
`127.0.0.1`; a wildcard or LAN bind is invalid. Only gateway `5608` is sent to
the Quick Tunnel. The gateway carries the token-bound login WebSocket; no VNC
TCP, CDP, X11, or browser-debug port is published.

The ignored default root is `.runtime/real-trial/`. Preparation makes its
runtime, `secrets/`, `state/`, `release/`, `logs/`, `pids/`, and `tools/`
directories owner-only (`0700`) and writes credential/environment files as
`0600`. Current state paths are `state/mysql/`,
`state/mediacrawler/profile/`, and `state/mediacrawler/output/`; the dedicated
sidecar secret is `secrets/mediacrawler/service_secret`; the published frontend
snapshot is `release/frontend/`; and the generated environment is
`.runtime/real-trial/trial.env`. The container bind-mounts only the
`state/mediacrawler/` and `secrets/mediacrawler/` parents, so it cannot read the
trial MySQL state or other application secrets. No `.env.real.local`, ordinary
development state, source-local crawl output, or mutable `frontend/dist`
release is reused.

### Lifecycle commands

Provide `SHENSI_TRIAL_APP_PASSWORD` only through the current owner-controlled
process environment, or point `SHENSI_TRIAL_APP_PASSWORD_FILE` at a regular
owner-only file. Do not place the value in the command line, shell history,
tracked files, PID/status metadata, or logs. Repeated preparation preserves the
generated secrets and requires the same supplied customer password.
For a clean runtime, set `SHENSI_TRIAL_CLOUDFLARED` to an absolute approved
cloudflared binary path. Preparation verifies the pinned SHA-256 and atomically
installs `.runtime/real-trial/tools/cloudflared`. Subsequent commands may omit
the source variable and reuse that retained verified copy; the tunnel never
executes the external source path.

```bash
pnpm trial:prepare
pnpm trial:start
pnpm trial:publish
pnpm trial:status
pnpm trial:verify
pnpm trial:stop
```

`trial:prepare` refuses occupied fixed ports, creates the protected runtime,
generates independent production secrets, writes the canonical encoded MySQL
URL, and copies the configured fixed cloudflared binary only after its SHA-256
matches. A missing source on a clean runtime or a checksum mismatch fails with
a stable error. Before any public tunnel exists, `trial:start` creates or starts
the dedicated `shensi-trial` Colima profile and builds the requested sidecar image;
failure aborts rather than using a native browser. It then initializes a new
dedicated MySQL data directory, provisions the least-privilege
`shensi_trial_app@127.0.0.1`, obtains the Quick Tunnel HTTPS origin, injects that
origin plus the customer-facing local gateway `http://127.0.0.1:5608` into
backend CORS, and starts the loopback application stack. It bootstraps an internal random
super-admin only long enough to create or verify
`test@shensi.local` as tenant `admin` in `trial-pilot-001`; the backend is
restarted without `INITIAL_ADMIN_*`.

After tests and build gates pass, `trial:publish` first verifies or installs the
runtime-owned cloudflared copy. Preflight failure leaves the current process
groups and status in place. A successful preflight then stops only the owned
trial process groups, preserves the dedicated MySQL and MediaCrawler state, rebuilds
from the current worktree, writes the frontend to the runtime-owned
`release/frontend/` snapshot, restarts the stack, and verifies the gateway. The
public verifier makes at most six attempts. Each fetch has a five-second
timeout, and only transport failures or non-healthy gateway/backend responses
enter the fixed `250ms`, `500ms`, `1s`, `2s`, `4s` retry schedule. Exhausted
transport failures report `TRIAL_PUBLIC_VERIFICATION_UNAVAILABLE`; exhausted
health responses report `TRIAL_GATEWAY_OR_BACKEND_UNHEALTHY`. Once both health
routes pass, an authentication response other than `401` or an internal-route
response other than `404` fails closed immediately and is never retried.
The customer-facing local origin is `http://127.0.0.1:5608`; it is the same runtime
as the temporary HTTPS origin. Development port `5588` is intentionally not a
published-trial endpoint. Local development and the published trial are built
from the same repository source, but source edits and ordinary builds do not
update a running trial: publishing is a separate explicit operation and may
issue a new tunnel origin.

`trial:status` is the current authority for process/container state and the
temporary origin. It reports `processesRunning: true` only when all six owned
service records and the owned MediaCrawler sidecar are running, and reports
`publicReachable: true` only when the temporary origin answers `/api/health`.
The aggregate `running` value is true only when both checks pass. Supply that
origin to `trial:verify` through its requested process environment without
copying it into tracked documentation. A tunnel restart may change it, and the
trial is unavailable while the host sleeps or is offline. `trial:stop`
validates every recorded PID, command, and runtime nonce, then terminates only
matching trial process groups with bounded TERM/KILL
handling. For MediaCrawler it also verifies the container name and
runtime-derived ownership label before stopping/removing that exact container;
a label mismatch fails closed. Stop removes live status but retains the browser
profile, login metadata, crawl output, MySQL, logs, and secrets. It does not stop
the dedicated Colima profile, protected older services, or unrelated containers.

### Login, action gate, and retention

The real-mode account form offers login and public registration and must ship
with empty fields. `POST /api/auth/register` accepts an account of 3–32
characters whose first character is a letter or digit and whose remaining
characters are letters, digits, `_`, or `-`, plus a password of 8–128
characters. The server trims and lowercases the account. It returns `409` for a
normalized duplicate and limits the route to five attempts per observed client
IP per hour after trusted-proxy resolution. A successful request persists an
active tenant `admin` with a newly generated workspace, sends the normal session
and CSRF cookies, and lets the frontend enter that workspace immediately. Its
navigation shows the complete product, but all business collections begin
empty. Provisioning must not copy provider/model credentials, Douyin sessions
or social accounts, candidates/evidence, crawler or automation tasks, approval
batches, outreach actions, CRM, Growth, deal, or finance rows from any existing
tenant.

The frontend aliases are enabled only when `VITE_REAL_TRIAL=true` and the
comma-separated `VITE_TRIAL_LOGIN_ALIAS` and `VITE_TRIAL_LOGIN_EMAIL` lists are
both non-empty with equal lengths. The current values map `test,test2` to
`test@shensi.local,test2@shensi.local` positionally. Only exact trim/lowercase
alias matches are mapped; unmatched identities and passwords remain unchanged,
and incomplete enabled configuration fails before login traffic. The backend
also accepts a valid bare account or an email. `test` and `test2` are tenant
`admin` accounts in separate `trial-pilot-001` and `trial-pilot-002` workspaces;
neither is `super_admin`.
The second workspace's acquisition showcase is populated with
`pnpm trial:showcase`. This deterministic transaction copies only an archived
plan, one completed run, candidates, identity aliases, and public discovery
evidence with newly generated IDs and rebound ownership. It refuses a partial
or unrelated non-empty target and never copies credentials, social login
state, crawler commands, approval/outreach queues, CRM, deals, or finance data.
Use `pnpm trial:showcase -- --dry-run` before a first write. Both the loopback
and temporary HTTPS origins traverse the same gateway, frontend build, backend
runtime, sidecar image, and MySQL workspace, so this persisted snapshot is
visible through both without maintaining a second public build or data copy.

The generated runtime uses headed bundled Chromium inside the private Linux
Xvfb display and defaults `DOUYIN_OUTREACH_ACTIONS_ENABLED=false` and
`DOUYIN_ACTION_VISUAL_LOCATOR=disabled`. It returns the bounded login frame to
the public application page without exporting cookies, security material, the
browser, or display. Login-page readiness or
account connection does not authorize collection; collection does not authorize
external sending.
The public trial launch verifies that final outreach approval and the sidecar
action route remain fail-closed by default. Ambient and retained
`DOUYIN_OUTREACH_ACTIONS_ENABLED=true` values do not grant trial authorization.
Trial emits explicit approval/server roles matching its authorized legacy
setting, desktop execution false, admission `migration_locked` and an empty
admitted digest. Its temporary bootstrap Backend always has all roles false;
ambient desktop/admission settings cannot enable it. An action-enabled server
role does not unlock new HTTP mutations or authorize desktop claims.
After explicit authorization, publish that specific trial with
`pnpm trial:publish --enable-outreach-after-empty-audit`. Before any
action-enabled backend starts, the supervisor runs a read-only global aggregate
over all `queued`, `blocked_by_predecessor`, and `executing` rows. Any nonzero,
malformed, or unavailable result aborts and cleans up the new processes.
The action transport allows 175 seconds around the 150-second action deadline.
For a comment with verified success or an ambiguous post-submit receipt, the
sidecar uses ten seconds of that budget to keep the target page in front while
retaining the profile lease. In the isolated trial that page remains inside Xvfb
and is not an operator-visible Mac window; the interval does not perform another
platform action or establish success.

Only `trial:start` and `trial:publish` accept the trusted exact option
`--action-visual-locator=rapidocr`. It builds the same container image with the
pinned frozen `visual-locator` dependency group; the ordinary image omits that
optional group. Both variants run the same Xvfb/uvicorn entry point. The locator
option neither enables outreach nor replaces the separate empty-audit flag.
`prepare`, `status`, and `stop` reject it.

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
Its login-input guard accepts optional placeholder hints on the current empty
account/password controls, but still rejects prefills or missing required
attributes. The isolated package test checks these failures before building its
temporary archive; it does not install or publish a customer runtime.

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
account has no unrelated audience or target, complete login through the
workspace-scoped interactive page, and never bypass CAPTCHA, slider,
verification, rate-limit, or account-warning state. The
executor's bounded manual handoff applies only to an operator-controlled local
display when verification is detected immediately after initial target
navigation. The isolated trial's Xvfb has no remote-control endpoint, so any such
challenge stops that attempt; a later challenge always stops immediately. Immediately before
approval, the user must see the selected account, target URL and exact test
comment and give action-time confirmation. Without that confirmation, do not
approve the batch and do not send the comment. Private-message acceptance is an
independent checkpoint and does not require sending a comment: show the current
sender, selected profile, exact edited text and 1–100 daily limit, then require
explicit confirmation before queuing the v3 message. Keep any uncertain comment
unchanged and never resend it as a test prerequisite. Historical unversioned direct-message rows remain read-only,
are not backfilled, and are never claimed. The owned
ordinary-development UI is `http://127.0.0.1:5191/#acquisition`. The isolated
trial local UI goes through `http://127.0.0.1:5608/#acquisition`, and its
customer-facing entry is the current temporary HTTPS origin reported by
`trial:status`. Automated verification stops before both confirmation controls;
each real action is a later, separately authorized manual acceptance step.
Production acceptance uses the configured HTTPS `CORS_ORIGINS` origin with
`#acquisition` appended.
