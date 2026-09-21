# Shensi

Shensi is a sales growth and operating-analysis system for international sales
teams. This repository is the canonical development path for the dark agent
center frontend, the Express domain API and workers, the MySQL persistence
layer, and the shared acquisition and Growth contracts.

## Canonical commands

Platform account administration and overseas-to-Alibaba launch planning are
documented in [launch readiness](docs/operations/account-admin-launch-readiness.md).
The source includes an independent `/admin.html` console for enterprises,
accounts, package versions and operations logs; see
[platform administration](docs/modules/platform-administration.md) for current
boundaries and remaining recovery/onboarding work. Trial/basic/pro start as
unpublished configurable drafts. Source implementation does not provision real
customer grants or a production deployment.

The desktop home presents acquisition, the agent center and decision simulation
as its three primary entries. More functions and the existing sidebar retain all
business modules. Recent acquisition task state is read-only on this page.
Its black-green showroom uses locally bundled pre-rendered sculptures with
bounded Canvas particles, static reduced-motion fallbacks and real DOM links;
see [home assets](frontend/public/assets/home/README.md). Daily updates use the
source development window, not a new installer.
The agent center and simulation share explicitly confirmed operating preferences
and saved-report reviews; see [shared capabilities](docs/modules/shared-agent-capabilities.md)
for implemented boundaries and remaining history/recovery work.

The desktop **星盘决策模拟** workspace accepts selected enterprise files,
shows source-linked baseline proposals and missing/conflicting fields, and asks
the user to confirm the operating baseline before five configured-model roles
analyze the sources. The integrated route then calculates 100 reproducible
operating paths and saves the report, source references, model attribution and
replay in actor/workspace-scoped encrypted MySQL storage. HTML export includes
all paths and assumptions. CSV/XLS/XLSX, text PDF and DOCX are supported;
scanned-PDF OCR is not implemented.
Saved replays explain monthly factors, cash flow and operating profit. Optional
explicit operating events replace (not compound) the corresponding background
factor and retain assumptions/provenance; overlapping same-factor events are
rejected. New reports save evidence-linked operating recommendations and optional
user-confirmed decision preferences; preferences rank existing outcomes without
changing profit. Explicit feedback proposes a candidate only, requiring confirmation.
Confirmed personal preferences can be saved across sessions, explicitly adopted
into new inputs, corrected, disabled, deleted and exported. Saved suggestions can
be claimed, planned and manually reviewed with same-metric actual/target comparison;
explicit feedback creates a candidate only while learning is enabled and needs a
separate confirmation. These encrypted personal records never rewrite report
snapshots or complete advisor/CRM actions. Automatic inference/training and
decision-style action rules remain unimplemented. See the
[factor coverage catalog](docs/modules/decision-factor-catalog.md).
Manual synthetic examples remain a separate
calculation route, not a substitute for agent analysis. Full native acceptance,
and the original startup mode remain in progress. Growth advisor, catalog,
quotes, finance, ROI and financial council remain fully retained, including
their navigation, APIs and data. Decision simulation is an independent added
workspace. See [decision simulation](docs/modules/decision-simulation.md).

Desktop development follows the fresh-local-database delivery sequence in
[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md): new database, real business
acceptance, agent/knowledge workflows, then an application update and legacy
retirement. Keep the latest frontend/backend and the old database intact; do not
run the historical Trial data migration for this route. `pnpm desktop:local`
starts the independent persistent MySQL database, the latest local Backend and
the Electron development window. It rebuilds/restarts that window without producing
App/DMG/ZIP installers. See
[`docs/desktop/macos-electron-client.md`](docs/desktop/macos-electron-client.md).
Use the registration page for a new independent workspace; old Trial accounts
and API keys are not copied. The database and its private configuration survive
application restarts. This local route does not require cloud resources.

The real desktop shell connects its primary actions to existing business flows:
create and follow up customers, manage customer-linked Todos, prepare social
outreach drafts, and open the current specialist chat or voice settings.
Catalog managers can create products/services and basic pricing drafts, then
explicitly activate those drafts. Quote list filters show case status separately
from version approvals. See [CRM](docs/modules/crm.md) and
[Growth workflows](docs/modules/growth-suite.md).

The authorized shared-backend test route uses the root `render.yaml` for one
free Render API service and a fresh Aiven MySQL database with verified CA TLS.
The client also verifies the database hostname. This route is isolated from the
local desktop database, keeps automatic deploys off and
starts with desktop writes migration-locked. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md#free-render--aiven-test-deployment).

The real agent center (`#agents`) includes six-role specialist questions (CFO is the default). Questions and
recent text turns use the configured text model and the explicitly selected
read-only CSV/XLS/XLSX, text PDF or DOCX source, or the workspace's latest confirmed three-statement
package. **财务经营 / ROI / 财务委员会 → 使用当前模型分析并生成报告** makes partial enterprise documents available
without ledger commit or three complete statements. Expense-ledger commits and
unconfirmed statement previews are not implicitly question material. Use
**准备财务分析** to confirm three reports for formal council analysis. See
[original-source reading](docs/modules/finance-document-reading.md).
Product-owned skills supply sourced, deterministic facts and role-specific
methods. Monetary/ratio references are validated and rendered by the server;
models explain the evidence without receiving raw Minor integers. Choose one
role in the question panel; switching cancels stale work and clears the current
display. CFO completed text sessions remain in encrypted actor/workspace-scoped
history; its history/new-chat panel preserves unsent input and shows real
execution stages. Other roles keep page-local history.
All six support text, only CFO supports realtime voice. See
[role boundaries](docs/modules/agent-specialist-skills.md).
The financial council workspace restores saved runs and shows six independent
execution states, public evidence and bounded cross-review. Its detailed report
can be read and exported as HTML/PDF from the same saved report version;
unavailable data and degraded model summaries stay explicit. New runs use the
workspace's confirmed statement package, not chat text or ledger previews.
See [council collaboration and report boundaries](docs/modules/financial-council.md).
Use **智能体中心 → 和经营总管聊聊 → 语音服务设置** in the desktop app to
save a Beijing Bailian Key (business workspace ID is optional), replace/remove it, and
check the realtime connection. Settings are encrypted on this Mac and isolated
by Shensi workspace and actor; saving does not certify a working audio session.
The realtime adapter streams microphone/audio after explicit Start and a passed
connection check. Standalone greetings have a local conversational response;
business questions still use the authorized CFO and verified reports, even if
the voice model omits its tool call. Actual playback requires device acceptance.
The optional once-per-launch Mac greeting does not open a microphone. Its
enabled state, Ethan/Tina voice and fixed/random approved copy are device-local;
previewing a draft does not save it, while explicit persistence is atomic from
the active service's perspective.
See [`docs/modules/cfo-conversation.md`](docs/modules/cfo-conversation.md).

For the retained Web/Trial MySQL-backed development route, create the ignored file, replace its
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
the only current public trial link. `processesRunning` is true only when all six
owned service records and the owned MediaCrawler sidecar are running;
`publicReachable` is true only when the reported origin answers `/api/health`.
The aggregate `running` value requires both checks to be true. Operational and
customer-interactive gates are tracked in
[`docs/operations/real-customer-trial.md`](docs/operations/real-customer-trial.md)
and must remain truthful. Supply the customer password only through the
owner-controlled process environment or an owner-only password file; never put
it in a command, tracked file, or log.

On a clean runtime, set `SHENSI_TRIAL_CLOUDFLARED` to the absolute path of the
approved cloudflared binary. The supervisor verifies the pinned SHA-256 and
atomically installs it as `.runtime/real-trial/tools/cloudflared`; later starts
and publishes reuse that retained verified copy when the source environment
variable is absent. The tunnel always executes the runtime-owned copy.

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
only the gateway. MediaCrawler `5612` is published from Docker to the host's
`127.0.0.1` only; it is never a tunnel target. Its headed bundled Chromium runs
inside Linux Xvfb in the dedicated Colima profile `shensi-trial`, not as a Mac
browser window. Chromium uses the container's dedicated 1 GiB shared-memory
mount rather than Playwright's bounded `/tmp` fallback, so a full Douyin page
cannot exhaust the 128 MiB temporary filesystem. The trial launcher forwards
the Colima VM's uppercase and lowercase `HTTP(S)_PROXY` and `NO_PROXY` values
into the container for build tooling and ordinary HTTP clients. Those generic
variables do not configure Chromium. Without an explicit
`MEDIACRAWLER_BROWSER_PROXY`, the sidecar launches Chromium with
`--no-proxy-server`. With an explicit credential-free browser proxy, the
sidecar supplies only that origin through Playwright's `proxy.server` and does
not add the direct-connection flag; an invalid proxy origin fails startup. The
acquisition login dialog renders the sidecar-captured QR image directly when
the login session reports `qrStatus: ready`; it never reuses that image after
the session reports `expired`, `network_error`, or `verification_required`.
An empty browser poll cannot regress one of those explicit states to
`opening`; only new explicit evidence can advance it. A QR refresh records
bounded network aggregates for official `douyin.com` hosts (all other hosts
become `other`) and never records paths, queries, headers, bodies, cookies, QR
data, or session identifiers.
Login navigation and QR refresh wait for the bounded DOM-content-loaded
milestone before probing the official login controls, so the page is not
inspected while its initial document is still being committed.
The same dialog also embeds the noVNC/RFB control surface against a same-origin
`/douyin-live/{token}` WebSocket for interactive login and platform
verification. The authenticated public
`POST /api/v1/acquisition/social-accounts/douyin/login-sessions/{sessionId}/live`
operation issues a short-lived, single-use token bound to exactly that login
session. If that session's live browser context is still starting, the public
operation returns retryable HTTP `409` `douyin_login_session_not_ready`; the
embedded client waits and requests another one-time token for the same session
instead of creating another profile. The gateway upgrades only this token path to the sidecar; the
per-session x11vnc listener stays on sidecar loopback and no VNC TCP, X11,
CDP, cookie, browser security material, or generic browser-control endpoint is
published. The separate `#douyin-live-login?sessionId=...` tab and the bounded
JPEG plus normalized click, text, key, and scroll API are retained only as
backup login surfaces. A semantic `refresh_qr` interaction performs one bounded
reload against that same profile. If the official page exposes exactly one
visible “点击刷新” control for an expired QR, the sidecar clicks it once and
waits within the existing QR budget for a current QR; it never guesses a
coordinate. If the official login UI or QR cannot be recognized after a
refresh without concrete network-failure evidence, the same session remains
`opening` instead of being destroyed by an internal error; `network_error` is
reserved for an error observed on the official page. The operator can still
inspect or close the session normally. Reconnecting noVNC
and creating a new login session remain separate actions. All surfaces control the same
sidecar persistent profile later used by collection, comments, and private
messages; the original acquisition page continues polling the login session and
binds the workspace account only after authentication becomes `active`. A native Mac
process configured with `MEDIACRAWLER_BROWSER_DISPLAY=virtual` fails closed.
The ignored default root is `.runtime/real-trial/`, including the owner-only
`trial.env`, `secrets/mediacrawler/service_secret`, logs, PID records, MySQL
data, `state/mediacrawler/profile`, `state/mediacrawler/output`, and isolated
frontend release directories. The local customer entry and current public
origin traverse the same gateway, frontend release, backend runtime, and MySQL
database. The trial preview serves only
`.runtime/real-trial/release/frontend/`; an ordinary
development or repository-wide build therefore cannot replace the frontend of
an already running trial. `trial:status` reports the current
temporary origin; it may change after a tunnel restart and must not be copied
into tracked documentation. `trial:stop` validates the recorded command, PID,
and runtime nonce before terminating trial process groups, stops/removes only
the MediaCrawler container carrying the matching runtime-derived ownership
label, and retains the profile, login state, crawl output, database, and secrets
for an explicit retention decision.

Use `pnpm trial:publish` after verified source changes. It verifies or installs
the retained cloudflared copy before stopping anything; a missing source or
checksum failure leaves the current trial and status untouched. It then stops
only the recorded trial processes, rebuilds the frontend and backend from this
worktree,
restarts the same retained MySQL/profile runtime, and verifies the new gateway.
Public verification gives transient tunnel transport failures and non-healthy
gateway/backend responses a fixed bounded retry window; every request has its
own timeout. Authentication or internal-route isolation mismatches fail
immediately without retry.
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
`visual-locator` dependency group while building the sidecar image, without
authorizing external writes; combine it with the one-shot action flag only when
both choices have been separately approved.

The current shell shows seven primary modules—自动营销总览、获客中心、社媒对话、
私域客户池、企业查询、智能体中心、设置中心—and the six
Growth/finance entries at `#growth/advisor`, `#growth/catalog`,
`#growth/quotes`, `#growth/finance`, `#growth/roi`, and `#financial-council`.
The old browser-local conversion, workflow, and overseas-marketing previews are
not navigation destinations. Their historical hashes redirect to the real quote
workbench or agent center. Real API/MySQL surfaces remain authoritative.

The real-mode entry switches between login and public account registration and
never pre-fills credentials. Startup checks `/api/auth/me` even when a new local
desktop port has no cached identity; only server-confirmed sessions restore the
workspace. Login accepts either a valid account name or an
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
`contracts/releases/growth-advisor-quote-roi/1.0.29/`.

## Prerequisites

- Node.js `22.22.3` (the root engine range is `>=22.22.3 <23`)
- pnpm `11.18.0`
- MySQL 8 for persistent and integration flows
- uv `0.12.5` and Playwright Chromium for focused MediaCrawler development
- Colima with the Docker runtime for the isolated trial's dedicated
  `shensi-trial` Linux profile; the trial image supplies Playwright Chromium
  and Xvfb
- Chrome only for explicitly local operator/browser acceptance, never as the
  isolated public trial's browser runtime

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

### Douyin browser runtime modes

The Sidecar resolves one browser strategy at startup. Set
`SHENSI_RUNTIME_MODE=desktop` for the native local path and pair it with the
compatible `MEDIACRAWLER_BROWSER_DISPLAY=operator` alias. This path opens a
headed Playwright Chrome window on the user's desktop and reports
`interactionSurface: external_window`. It does not start Xvfb, x11vnc,
websockify or noVNC, does not mint `/live-sessions`, and does not require a QR
image or login-page screenshot before the user can interact. The acquisition UI
polls the same session, offers an explicit login recheck and cancellation, and
does not mount the remote canvas. The direct `#douyin-live-login` route first
reads the session and, for `external_window`, returns the external-browser
guidance before importing the noVNC/RFB runtime or calling the live-session API.

Both modes still enter through `AccountManager`, which owns the API/business
session plus profile and identity persistence. In desktop mode it delegates the
opaque local handle to `LocalBrowserSessionManager`; only that manager's worker
owns and closes the Playwright Context. Cancellation invalidates the generation
and aborts only that worker. Expiry or cancellation does not delete the stable
desktop profile, and authentication closes the Context before `AccountManager`
binds and persists the returned identity. Desktop launch, poll, action, and
reconciliation still pass through `AccountManager`, but it holds its global
`RLock` only for short session/authority reads and writes, never across external
browser I/O. The retained Web `remote_canvas` path keeps its legacy locking and
remote-display lifecycle.

Desktop browser data lives beneath the absolute `SHENSI_USER_DATA_DIR` when it
is set, or beneath the ignored repository-local `.local-data/` directory by
default. The backend derives a stable opaque key from the authenticated
workspace; that key is sent only across the private Sidecar boundary and is
hashed again into a stable per-workspace profile directory. It is never exposed
by the public login API. Once authentication is detected, the login Context is
closed and the same profile is leased to MediaCrawler collection rather than
creating a second login authority.

Set `SHENSI_RUNTIME_MODE=web` with
`MEDIACRAWLER_BROWSER_DISPLAY=virtual` for the retained remote deployment path.
That path continues to use Xvfb/x11vnc and the token-bound noVNC
`remote_canvas`, including `/live-sessions` and the QR/JPEG compatibility
fields described below. Conflicting mode/display values fail startup. The
desktop strategy is a Sidecar and current-frontend vertical slice. The Electron
shell and deterministic host-architecture DMG/ZIP development packaging are
implemented under `dist/desktop/macos`; the current development artifact is
unsigned/ad-hoc and is not a public release. The fail-closed Developer ID and
notarytool path, temporary-icon release gate, bundled-resource contract, and
truthful architecture/installation gaps are documented in
`docs/desktop/macos-electron-client.md`. Day-to-day application work runs
`pnpm desktop:local` with the independent persistent local database, without producing
new installers. The current action-bridge source additionally requires a
production build-manifest producer before another packaged-App acceptance;
that packaging integration is pending and no existing installer was replaced.
Development packages accept that exact loopback form or a real
HTTPS origin; release accepts only real HTTPS, and all packaging modes reject
reserved placeholder hostnames. An isolated macOS process smoke has verified a real external headed
Chrome launch, repeated-connect deduplication, bounded session cancellation and
reuse of the exact same Profile after a Sidecar restart, without any
live-session/VNC process. It did not complete a human QR scan or manual
verification, detect an authenticated account, or run a real collection from
that Profile; those steps still require separate manual acceptance before the
migration can be called complete.

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

Douyin can serve verification during login. For operator login and every real outreach
action, keep
`MEDIACRAWLER_BROWSER_HEADLESS=false` and
`MEDIACRAWLER_BROWSER_CHANNEL=chrome` in `.env.local`. This starts the headed
Playwright context for the private account session; Shensi explicitly disables
CDP. In the isolated virtual-display runtime the operator controls that context
from the noVNC/RFB surface embedded in the acquisition login dialog. The
separate live-login tab and bounded JPEG interaction surface remain backups. A
collection-only production runtime may set
`MEDIACRAWLER_BROWSER_HEADLESS=true` only while external outreach remains
disabled. Enabling outreach with headless mode fails deployment preflight, and
the parent and browser child reject any bypassed action/reconciliation command
before opening a page. The remaining login-page, QR, VNC and live-token details
in this section describe only the Web `remote_canvas` path. Cold browser startup uses the dedicated bounded login
command budget without holding the login-session create request open. `POST`
immediately returns `awaiting_scan` with `loginPage: null` inside the short
gateway budget, the sidecar opens the official page in the background, and
subsequent `GET` polls return account state and, for the compatibility fallback,
a fresh fixed-size JPEG frame when capture succeeds. If initial best-effort
preparation, a later poll, or semantic refresh cannot capture that fallback
frame while the browser context is still alive, it returns the same session
with `loginPage: null`; it preserves
the QR state and noVNC context rather than manufacturing `login_expired` or
tearing the session down. Only a genuinely terminal attempt maps to
`login_expired`. Login-session `GET` and
`POST .../{sessionId}/interactions` use a dedicated 70-second gateway transport
timeout so the sidecar's bounded poll or QR refresh can complete; other
MediaCrawler requests keep their existing shorter
budgets. The browser worker keeps its 65-second login-open command deadline.
Within that command, initial page navigation makes at most three attempts. Each
attempt has a 10-second navigation timeout; after a failure, the failed page is
closed, a fresh page is created, and the next attempt starts 500 milliseconds
later.
Exhausting all three attempts returns only the safe
`douyin_login_page_unavailable` failure. This bounded navigation retry remains
inside the same persistent context and worker; it neither restarts the worker
nor replays a comment or private-message command. In that Web mode, the primary UI mints a
short-lived live token and mounts noVNC/RFB in the existing dialog against the
same-origin `/douyin-live/{token}` WebSocket.
When live context startup returns retryable HTTP `409`
`douyin_login_session_not_ready`, the embedded client automatically retries the
mint against the same session/profile. Once navigation reaches an allowlisted
official Douyin page, the sidecar first establishes the display/context and
worker VNC handle, then registers that context and its generation atomically in
`AccountManager`; live-token minting is available from that point. Screenshot,
DOM, QR, and login-panel discovery run afterward as best-effort preparation.
`loginPage: null` therefore means only that a compatibility screenshot is
currently unavailable, and `qrStatus: opening` may remain while preparation is
in progress or cannot recognize the current official UI. Neither value proves
that the context opened, closed, or expired, and a preparation failure does not
destroy an otherwise interactive noVNC context. Only browser/display/VNC
failure or navigation to a non-allowlisted page is terminal and carries one of
the contract's safe `failureCode` values; raw selector and browser exceptions
remain private. Closing the login dialog or starting a replacement login
cancels the previous workspace-scoped session through its public `DELETE`
endpoint. The frontend first disposes its RFB client. At the sidecar boundary,
cancel atomically invalidates the generation and unused live tokens and removes
the session from its registries before it waits on browser I/O. The active
bootstrap owns deferred teardown while it is alive; otherwise one tracked
cleanup thread waits for the per-session/browser command, closes the context at
most once, and removes the private profile. Manager shutdown joins both kinds
of tracked work and reports cleanup failures. Thus `DELETE` does not wait for a
long-running best-effort screenshot/QR preparation, while resource reclamation
remains observable and bounded at shutdown. A live WebSocket token already
claimed by a non-cooperating client is finally severed when that deferred
context close completes. Background open does not hold the global state lock. Poll and
interaction I/O use a
per-session lease plus generation/CAS authority; terminal completion closes and
flushes the browser context before CAS-persisting account authority. Generation
and stale-result checks isolate every bootstrap. A replacement waits for the
preceding bootstrap thread to exit; disconnect invalidates its generation, so
an old preparation result cannot overwrite or close the current context. Fatal
open failure, disconnect, expiry, explicit close, shutdown, a fresh start, and
persistence failure clear unfinished work and browser resources without replay.
The sidecar never globally reuses an opening session across tenants. Public
create replay remains scoped to `(workspace, Idempotency-Key)`. A separate
workspace-scoped opening lease and fencing token coalesces different create
keys, overlapping clients, and service instances onto the same unexpired upstream
`awaiting_scan` session; terminal, expired, missing, or explicitly cancelled
sessions release that slot before replacement. Cancellation fences the matching
opening before calling the sidecar; if that disconnect fails, the old session
remains addressable for a cancel retry but is never reopened for create-time
reuse. The frontend uses one in-flight
connect, disables replacement while `opening`, retries
live-mint `409` for the same session, and clears retries/RFB state on unmount.
The embedded noVNC/RFB view is the normal interactive surface. The separate
live-login tab and serialized click, text, key, and scroll commands are backups
that still complete login in that exact context. The original acquisition page
keeps polling the same session after the QR scan until the
server reports an active account; closing the backup live tab alone does not copy or
invent login authority. The system never treats a fixture, poll count, or
unrelated browser login as proof. An unsupported or changed login DOM leaves
the allowlisted official page interactive with `loginPage: null` and/or
`qrStatus: opening`; it is not a terminal browser failure. A later poll or
semantic refresh can restore the compatibility frame without replacing the
session.
The external-window configuration belongs only to the ordinary local
development runtime. The isolated public trial always uses the Web
`remote_canvas` path with headed bundled Chromium inside
the `shensi-trial` Linux/Xvfb container described above and never falls back to
installed Mac Chrome. Both the embedded view and its backup Shensi tab are
noVNC clients for the server-owned browser, not independent Douyin browser
sessions. Opening the public Douyin
site directly in another customer browser would still authenticate only that
browser and cannot complete the sidecar login session. A CAPTCHA, slider, login
verification, or platform warning
is never solved or bypassed. Login verification is handled by the human through
the bounded application interactions in the same sidecar context; action-time
verification follows the separate documented fail-closed/manual-handoff rule.
After a successful login, the backend accepts only a canonical one-way account
handle, a non-empty nickname, and a positive login-state version. If stored
active metadata is non-authoritative, only a strictly newer valid login result
can repair it; an equal or older login result and a valid different-account
binding still fail closed.

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
exactly one queued comment per selected candidate. Private messages have an
independent confirmation: v3 authorization binds the current active sender and
reviewed login version, selected recipient and exact edited body, without a
comment receipt or predecessor action. Awaiting and approved batches are
eligible; approving a private message does not approve or revise its comment
batch. Historical v2 actions retain their original predecessor rules. Neither HTTP approval
route performs the browser action; the separately leased executor owns both
action types. The private-message daily default is 20 with range 1–100; it is
separate from acquisition's daily candidate default 50 and range 1–200. A
configured private MediaCrawler gateway starts collection, but it does not
enable external actions. New deployments use three independent, strict
lowercase flags: `DOUYIN_OUTREACH_APPROVALS_ENABLED`,
`DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED`, and
`DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED`. If any split flag is present, all
three must be exactly `true` or `false`; they are authoritative and the legacy
flag cannot override them. If none is present, the current Web/Trial compatibility
adapter maps `DOUYIN_OUTREACH_ACTIONS_ENABLED` to approvals plus server execution
and keeps desktop execution false. Server execution without a constructed private
MediaCrawler gateway fails startup. Disabled approval fails before action
persistence, and each executor claims only its explicit target. The crawler worker
continues normally. The Trial supervisor emits all three split flags explicitly:
its authorized legacy setting maps to approvals/server, while desktop remains
false, client admission stays `migration_locked`, and the admitted digest stays
empty. The temporary bootstrap Backend always receives all roles disabled.
When explicitly enabled after separate live acceptance, the
worker rechecks the frozen approval/account/candidate/content/budget authority
immediately before asking the sidecar to submit exact approved text.
The action adapter submits only the exact approved text to the frozen canonical
`/video/{id}` or `/user/{sec_uid}` target. For a comment, the browser revalidates
the frozen sender from the current page header without navigation after target
load, after an initial-navigation manual verification handoff, before input,
before the single submit dispatch, and while proving the receipt. It first
locates one unique visible editor. If Douyin has lazy-mounted the editor, the
adapter first revalidates risk, URL, sender, and deadline, then clicks exactly
once on the unique exact `留下你的精彩评论吧` entry inside the unique comment-input
container. That activation neither types nor publishes; a missing or ambiguous
entry fails closed. It then pins the editor, enters the exact approved text, and
reads that text back before waiting for and pinning one unique usable submit
control. If the current comment UI exposes no semantic submit control, the
adapter binds the same exact Draft.js editor for one unmodified Enter keypress;
the native page handler has been verified to issue the first-party comment
publish request. A submit control may legitimately be disabled or not yet mounted
before editor input and is not an input-stage prerequisite. The concrete comment
editor and submit nodes are independently pinned and tagged. A synchronous
capture-phase click/keydown guard rechecks the exact approved editor text, URL,
and sender. Capture-guard rejection preserves the precise closed content,
control/URL, or sender code; `douyin_action_receipt_ambiguous` is reserved for a
platform write that may already have dispatched.
An official comment response must bind the exact approved request text/video,
a successful first-party status, and a stable returned comment ID. Returned
text, video, or author fields must match when present. When Douyin omits those
optional echo fields, the sender already bound before dispatch is revalidated
after the response before the receipt is accepted. The browser waits for the
response body before parsing it; an unreadable body never causes a second
submit and instead falls through to the existing unique new self-owned DOM
receipt proof. A private message uses the focused vendored
`cv-cat/DouYin_Spider` transport, not page DOM controls. It authenticates from
the bound persistent sidecar context, requires the exact public
`/user/{sec_uid}` target to match the API-resolved recipient, revalidates account
authority before conversation creation and again before send, then creates the
conversation and sends the approved text once. The immutable action ID yields a
deterministic UUIDv5 client message ID. Its sanitized
`douyin-im:<sha256>` receipt exposes no raw message, conversation/ticket ID,
cookie, browser security material, or `sec_uid`; a post-send exception is
ambiguous and is never retried. The pinned source exposes no public `LICENSE`;
reuse is based on the operator's statement of author permission, whose evidence
is retained outside Git.
After a comment has either a verified success receipt or an ambiguous
post-submit receipt, the target page is brought to the front and kept open for
ten seconds before the action context closes. In local operator mode this is a
best-effort review window; in the isolated trial it remains inside Xvfb and is
not visible on the Mac or public web page. It performs no additional click or
write, and only the durable platform receipt can mark the action successful.
Inside the Sidecar `ActionJobManager`, execute and reconcile acquire in-process
keyed locks in the fixed order action ID, then account handle, then acquire the
process-safe `ProfileLease`. The action-ID lock protects the receipt `.json` and
`.tmp` files, whose names depend only on the action ID, even if conflicting
requests present different accounts. The account lock serializes different
actions for one account; different action IDs on different accounts can run in
parallel when their Profiles are distinct. In desktop `external_window` mode,
`AccountManager` performs short `RLock`-protected authority checks before the
handoff and through the supplied validator, but does not hold that global lock
across execute/reconcile browser I/O. The LBSM command worker owns and closes
the action Context. The Web `remote_canvas` path retains the legacy
`AccountManager` command lock. Login versions are allocated from one
process-locked global monotonic ledger. The ledger, account
binding metadata, and login-session metadata are each committed with file and
parent-directory `fsync`; a sync failure cannot activate an account. Before the
external executor is called, the action manager durably commits its `started`
journal with the same file-plus-directory barrier. A journal sync failure aborts
before any platform click. Legacy server uncertainty remains `risk_paused`.
Desktop post-start `action_unavailable`, timeout, or receipt ambiguity becomes
`reconciliation_required`; an expired desktop claim with zero recorded platform
write attempts returns to `queued`, while an expired executing/count-one attempt
also becomes `reconciliation_required`. The bounded pre-journal
`douyin_profile_busy` case may return to `queued`, and explicit platform-risk
signals still pause the account. A same-device restart may receive a newly
process-bound, reconciliation-only capability containing the complete immutable
read-only action request (identity, target, content, hashes, deadline, original
lease, and binding/login versions). It cannot authorize `started` or a platform
write. Its observed receipt and the original receipt share one first-valid slot:
exact replay is stable, changed evidence conflicts, observed success releases only
the exact approved successor, and `action_unavailable` remains unresolved. A
separately audited recovery command may submit an exact empty pending
set after all current comments have already terminally failed; that operation
only restores the same-version account gate and enables no action. Any mismatch,
executing action, other queued batch, or unacknowledged uncertain result fails
closed. No failed action is automatically resubmitted. The worker serializes
all actions for one account, keeps at least 60
seconds between comment claims, and reserves ten minutes after a private-message
claim. The batch freezes the policy time zone; approval ordinals use the
approval local day, while claims count actual attempts on the real claim local
day. Retries consume that day's 1–100 allowance, the allowance resets only on the
next local day, and the same batch revision/candidate can never receive a second
DM approval even across days. On the same account-local day, the same candidate
also cannot receive another DM from a different batch; a later local day permits
a new batch while the original batch/revision remains permanently closed to a
second DM. Independently confirmed v3 DMs require the current reviewed sender,
selected profile and exact edited text, not a preceding comment. Awaiting and
approved batches are both eligible; DM approval never changes comment approval.
An old uncertain desktop comment no longer blocks these new DMs after its
execution receipt is durably recorded and execution/recovery leases have ended.
Active execution, login, DNC, quotas, risk pauses and idempotency remain enforced.
Historical v2 actions retain their exact predecessor receipt requirement.
Historical direct-message rows without v2 or v3 authorization remain
readable for audit compatibility but are never claimable or executable.

The Backend composes desktop installation enrollment, registration, account
binding, claim, completion, and recovery routes with the Memory/MySQL fencing
and recovery services. Memory repositories share both transaction coordination
and the exact account/installation/action references; MySQL repositories use
the application-owned pool. Acquisition mutations pass desktop build admission
before JSON parsing. Enrollment and binding retain user-session/workspace
checks; device operations require their installation credential. The three
approval/server/desktop execution settings remain independent. Renderer enrollment
and account binding use the current desktop bridge; the target-schema upgrade remains pending. The
installed app has not yet received this action bridge.

The staged desktop transport reopens persisted account identity by the same
workspace-derived login Profile key after a Sidecar restart. Its private action requests
validate the frozen canonical target and cross-language request hash before
executor entry. Completed receipt acknowledgement is idempotent across restarts;
a sanitized acknowledgement record prevents an already-acknowledged action from
executing again. Main's local client maps only the action projection, not central
credentials, and checks exact receipt identity and hash. Main-only installation,
Keychain-backed credential storage and two-account recovery journals are connected
to Main's coordinator and startup/shutdown lifecycle. The Main-only
central client implements registration, claim, completion and recovery against
the same generated contracts as the frontend, with bounded requests, strict
response checks and no automatic retry. Its origin/build identity must come
from Main's single immutable build-manifest read; development and production both
use the Main static Renderer gateway. Development builds the latest frontend
once per launch, without Vite/HMR or packaging. The coordinator restores durable
actions before new claims, never executes a recovered write fence, and drains
before Sidecar shutdown. The authenticated Renderer enrolls the installation,
records centrally confirmed account bindings, and selects its workspace through
five narrow invokes plus one status event. It cannot submit action content or
invoke execution. The existing acquisition card displays device status and an
explicit, blocked-while-unresolved device handoff. Main survives Renderer reload;
logout clears its workspace context. Long-offline recovery requires a confirmed
same-device rebind when the 90-second binding lease has expired. Production manifest generation and
the target upgrade are still pending. These source changes do not update the
installed app or enable a central execution role.

The authenticated `#acquisition` dashboard uses that authority for the primary
controlled Douyin collection workflow: interactive account connection, editable local
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
approve or execute an action: comments require batch authority and human
confirmation, while a new private message requires its own current sender,
recipient, exact-body and quota confirmation, independently of comment status.

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
The guarded desktop bridge database stage is
`pnpm api:verify:desktop-action-bridge:mysql`; it creates an owned disposable
MySQL runtime only when explicitly run. See its [scope and cleanup rules](docs/DEPLOYMENT.md#disposable-bridge-mysql-verification).
It is not the full Backend/Gateway/browser or real-platform acceptance gate.

## Current work

Use [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) for completed, active,
blocked, and next work. Update it in the same change whenever those facts move.
