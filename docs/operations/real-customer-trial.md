# Real Customer Trial Runtime

This document is the current operating contract for the temporary Shensi
customer trial. The isolated runtime is publicly reachable when
`pnpm trial:status` reports `running: true`; that owner-only runtime state is the
authority for the current temporary origin. Never write a temporary tunnel URL,
password, token, cookie, provider key, browser profile, or crawl output into
tracked files.

Chat history, screenshots, bookmarks, logs, and archived documents may contain
expired Quick Tunnel origins. Never reopen or share one of those values: obtain
the current public origin from `pnpm trial:status` for every handoff. The
customer-visible local entry is `http://127.0.0.1:5608`; development and test
ports such as `5188`, `5388`, and `5588` are not substitutes.

## Goal and truthful product scope

The trial publishes the latest frontend and backend behind one temporary HTTPS
origin so one invited customer can see every feature developed so far. Visible
does not mean live: real API/MySQL surfaces remain real, while browser-local or
pending integrations remain visible and carry the exact label
`预览 · 待接入`. They never present fixture values as live customer results.

The source shell provides a home with acquisition, agent center and decision
simulation as primary entries. Its sidebar retains the following modules;
customer trial publication must be verified separately from source development:

- 首页
- 自动营销总览
- 获客中心
- 社媒对话
- 私域客户池
- 企业查询
- 智能体中心
- 星盘决策模拟
- 设置中心

The same sidebar exposes the six connected Growth/finance entries:

- `#growth/advisor`
- `#growth/catalog`
- `#growth/quotes`
- `#growth/finance`
- `#growth/roi`
- `#financial-council`

Real connected scope includes authenticated session/workspace authority, CRM and
private-domain records, Growth catalog/quote/finance/ROI flows supported by the
current backend, provider connections the operator has actually configured, and
the `#acquisition` MediaCrawler path for interactive login, plan approval, manual
keywords, controlled collection, persisted status/candidates/evidence, draft
review, and CRM conversion. In an authenticated real session, `#conversations`
is the public-evidence controlled outreach workspace for those same tasks. It
labels records as `真实 · 抖音公开互动`, never presents an official inbox or
two-party message thread, and never substitutes local seeded conversations.
`#growth/quotes` without a case shows a
customer-readable empty state; it does not invent a quote or expose
`quote_case_required`.

The browser-local conversion, automation, and overseas-marketing previews are
not product navigation destinations. Their historical hashes redirect to the
real quote workbench or agent center. AI-only
controls remain visible but explain that a healthy model connection is required.
Generic public-web acquisition remains an optional separate path; a missing
search or model provider never blocks manual-keyword MediaCrawler collection.

`#acquisition` and `#conversations` use the same server batch authority. The
conversations page reads overview/latest-run candidates, discovers the latest
batch by `runId + candidateId`, then loads that batch and its action receipts;
reload repeats those reads instead of relying on browser selection order. An
exact `https://www.douyin.com/video/{id}` candidate can create one single-
candidate pending batch, edit the exact comment and private-message draft, save a new
revision, and enter the shared review/final-approval flow. Profile-only public
evidence stays visible but its create CTA is disabled and it cannot create a
comment batch. The browser has no direct-send control and does not claim an
official Douyin inbox or DM API.

Outreach drafts can be edited and reviewed while the action gate is disabled.
In that default mode, final approval returns `503 outreach_actions_disabled`,
creates neither approval nor actions, and sends no comment or direct message.
A specific live trial may enable final outreach only after explicit user
authorization and a read-only audit proving that no historical action is queued
or reclaimable. Both backend and sidecar must then start with the flag enabled.
The first action confirmation queues comments only; it is not followed by a
browser-side send button. After the same candidate has a durable successful
comment receipt, the page unlocks a separate private-message review and second
confirmation. The private-message daily limit defaults to 20 and accepts
1–100, independently of the acquisition candidate limit (default 50, range
1–200). Plan approval for collection is a separate real authority and remains
available. Only a candidate backed by an exact Douyin video URL is selectable
for the initial comment flow. Profile-only
creator candidates stay visible but cannot be queued; final approval rechecks
the video target and Douyin profile target before writing any action.
Batch creation and final approval also require a succeeded/partial crawler job
whose terminal ingestion and current alias-generation projection are complete.
`outreach_candidate_projection_pending` is a safe wait state and creates no
actions; `outreach_candidate_projection_unavailable` requires a new successful
collection. Never work around either gate by approving a batch captured from a
live intermediate page.

## Isolated topology

The first pilot uses only these fixed loopback addresses:

| Component | Address | Rule |
| --- | --- | --- |
| MySQL | `127.0.0.1:3310` | dedicated `shensi_trial` database |
| Public gateway | `127.0.0.1:5608` | the only Quick Tunnel target |
| Frontend | `127.0.0.1:5610` | gateway upstream only |
| Backend | `127.0.0.1:5611` | production mode, MySQL store, gateway upstream only |
| MediaCrawler sidecar | `127.0.0.1:5612` | Docker-to-host loopback, private backend integration only |

The `shensi_trial_app@127.0.0.1` database account has privileges only on
`shensi_trial`. The gateway owns `/healthz` and sends only `/api` and `/api/*`
to the backend, upgrades `/douyin-live/{token}` to MediaCrawler over the
private sidecar network, and sends all other allowed application paths to the frontend. It
preserves cookies, CSRF headers, HTTP methods, and the HTTPS forwarded scheme.
MySQL, backend, and MediaCrawler are never direct tunnel targets.
MediaCrawler runs in Docker inside the dedicated Colima profile
`shensi-trial`. Its port publish includes literal host `127.0.0.1`; do not use a
wildcard or LAN address. Headed bundled Chromium runs on a per-login-session
Xvfb display with x11vnc bound to a random sidecar-loopback port. The public
page mounts noVNC/RFB inside the acquisition login dialog and mints a
short-lived, single-use token through
`POST /api/v1/acquisition/social-accounts/douyin/login-sessions/{sessionId}/live`
before connecting to the same-origin `/douyin-live/{token}` WebSocket. If the
live context is still starting, the public endpoint returns retryable HTTP
`409` `douyin_login_session_not_ready` and the embedded client automatically
remints for the same session/profile. The separate live-login tab is a backup.
The gateway exposes only that opaque upgrade;
VNC TCP, CDP, X11, browser-debug ports, cookies, browser security material, and
profiles never cross the sidecar boundary. A bounded JPEG plus normalized
click, bounded text, allowlisted key, and bounded scroll commands remain the
fallback. The sidecar opens the official login panel and activates QR login in
the background. A captured current QR is returned only with `qrStatus: ready`
and is rendered directly in the acquisition dialog; expired, network-error, or
verification states clear it. The customer can complete login from that QR or
use embedded noVNC/RFB, the backup tab, or JPEG interaction for supported
manual verification. “刷新二维码” sends one semantic `refresh_qr` command to
reload the same profile. If the official page reports an expired QR and exposes
exactly one visible “点击刷新” control, the sidecar clicks it once and waits in
the bounded QR window for the replacement image. It does not guess coordinates,
reconnect noVNC, or create a replacement login session.
An empty poll never replaces an already observed `expired`, `network_error`, or
`verification_required` with `opening`. For refresh troubleshooting, inspect
`douyin_login_refresh_network` only as a bounded aggregate of phase, hostname,
resource type, HTTP status or normalized network error. Those records never
contain URL paths, queries, headers, bodies, cookies, QR data or session IDs;
non-`douyin.com` hostnames are collapsed to `other`.
Login navigation and QR refresh wait for the bounded DOM-content-loaded
milestone before probing the official login controls.
If the official login UI is still unrecognized after refresh but no concrete
network failure is visible, expect HTTP 200 with `qrStatus: opening`; an
explicit page-level network failure may return `qrStatus: network_error`.
Verify that explicit session deletion still returns HTTP 204. HTTP 500/503 is
not an acceptable QR recovery state.
After an allowlisted official page is reached, the sidecar establishes the
display/context and worker VNC handle, and `AccountManager` registers that
context/generation before screenshot, DOM, QR, or panel preparation. If initial
preparation or a later poll/semantic refresh cannot produce the fallback JPEG,
expect the same nonterminal session with `loginPage: null`; `qrStatus` may
remain `opening`, and the noVNC context stays interactive. Null or an
unrecognized official login DOM is not `login_expired`. Only a fatal
browser/display/VNC failure or an unsafe page closes the attempt.
The browser worker keeps a 65-second deadline for the complete login-open
command. If initial navigation fails, it makes at most three attempts in the
same persistent context. Every attempt has a 10-second navigation timeout;
after a failure, the failed page is closed, a fresh page is created, and the
next attempt starts 500 milliseconds later. After
the third failure, the sidecar closes the failed page and reports only
`douyin_login_page_unavailable`. This retry does not restart the worker and
does not replay any comment or private-message command. The login-session
`GET` gateway timeout remains 70 seconds, so it can cover the bounded worker
poll without changing other MediaCrawler request timeouts.
The launcher passes the Colima VM's uppercase/lowercase `HTTP(S)_PROXY` and
`NO_PROXY` variables into the container for build tooling and ordinary HTTP
clients. Chromium connects directly by default; those generic variables do not
configure Playwright. Only an explicit `MEDIACRAWLER_BROWSER_PROXY` value is
eligible for Chromium, and the sidecar rejects malformed, credentialed, or
portless values before browser startup.

The existing services on `3307`, `5488`, `5492`, `5588`, and `5590` are
protected. Preparation, start, verification, and stop must not modify, signal,
or reuse them. The ordinary `./scripts/dev` ports `4491/4191/5191` and
`pnpm dev:real` ports `3307/4188/5188` are not trial endpoints or acceptance
evidence.

## Runtime files and permissions

The ignored default runtime root is `.runtime/real-trial/`:

```text
.runtime/real-trial/
  trial.env
  secrets/
    mediacrawler/
      service_secret
    ... other owner-only application secret files
  logs/
  pids/
  tools/
  release/
    frontend/
  state/
    mysql/
    mediacrawler/
      profile/
      output/
```

Runtime, state, secret, log, PID, and tool directories are `0700`; generated
credential and environment files are `0600`. `trial.env` is the current
generated runtime environment. Do not create or document a parallel
`.env.real-trial.local`; `.env.real.local` belongs to the older non-trial
wrapper. `release/frontend/` is a runtime-owned immutable snapshot for the
current process set. The preview never serves `frontend/dist`, so an ordinary
development or root build cannot silently change a running customer's login or
other frontend behavior.

Preparation generates independent JWT, encryption, cursor, claim, database,
gateway, and sidecar values. It preserves existing generated secrets on an
exact repeat. The container receives only the dedicated
`state/mediacrawler/` and `secrets/mediacrawler/` bind parents; MySQL state and
the other application secrets are outside its mount boundary. The configured
cloudflared source is selected in this order: an explicit supervisor option,
the absolute `SHENSI_TRIAL_CLOUDFLARED` path, then the retained
`tools/cloudflared` copy. Its pinned SHA-256 is verified before an atomic install
into the runtime tools directory, and the tunnel always executes that
runtime-owned copy. No temporary-directory source path is a runtime dependency.
Logs and status may expose bounded component names, paths, PIDs, health, and the
current temporary origin; they must never expose environment values or secrets.

## Identities and login alias

- `test` and `test2` are tenant `admin` accounts in `trial-pilot-001` and
  `trial-pilot-002` respectively; neither is `super_admin`, and their business
  data is isolated by workspace.
- The visible aliases are `test` and `test2`; their canonical backend emails
  are `test@shensi.local` and `test2@shensi.local`.
- Alias mapping exists only when `VITE_REAL_TRIAL` is exactly `true` and the
  comma-separated `VITE_TRIAL_LOGIN_ALIAS` and `VITE_TRIAL_LOGIN_EMAIL` lists
  are both non-empty and contain the same number of position-matched values.
- Matching trims and lowercases only the lookup key and requires an exact own
  alias property. A match submits the canonical email. Every unmatched identity
  is submitted byte-for-byte unchanged, and the password is never normalized or
  rewritten.
- Enabled but empty or unequal-length alias configuration fails before a login
  request. The backend `/api/auth/login` accepts either a public account name or
  an email address in its historical `email` request field; account names are
  normalized to the matching `@shensi.local` identity before lookup.

## Independent showcase data

`test2` uses an independent persisted acquisition showcase snapshot. It gives
the second workspace the same public task/candidate/evidence coverage as the
first trial account while keeping every operational identity and credential
separate. The snapshot is deliberately read-only: its plan is archived and it
contains only one completed historical run, run events, candidates, identity
aliases, and public discovery evidence.

Preview the exact bounded row counts without writing, then apply the snapshot:

```bash
pnpm trial:showcase -- --dry-run
pnpm trial:showcase
```

The command is transactional and deterministic. It accepts an empty target,
recognizes an exact prior replay, and refuses a non-empty partial or unrelated
target instead of merging or overwriting data. Its fixed allowlist excludes
users, provider/model credentials, Douyin accounts and login state, crawler
jobs and commands, automation policy, approval batches, comments, private
messages, outreach actions, DNC state, CRM, deals, finance, audit records, and
idempotency records. A real Douyin operation under `test2` therefore still
requires that account to scan its own login and pass the normal human approval
gates.

On a new empty database, the supervisor starts the backend once with an internal
random bootstrap super-admin, uses the real login/accounts APIs to create or
verify the tenant admin, stops the backend, removes every `INITIAL_ADMIN_*`
value from the child environment, and restarts it. Existing-account conflicts
are accepted only after exact email/role/team/status lookup and a successful
tenant-admin login with the supplied customer password.

Supply the customer password only through `SHENSI_TRIAL_APP_PASSWORD` in the
owner-controlled process environment or an owner-only file selected by
`SHENSI_TRIAL_APP_PASSWORD_FILE`. Do not put the value in a command line, shell
history, tracked file, report, status file, PID record, or log. A repeated
preparation with a different password fails closed rather than silently
rotating the customer credential.

## MediaCrawler filesystem and action boundaries

The generated runtime uses headed bundled Playwright Chromium inside the
dedicated `shensi-trial` Colima profile's Linux Xvfb display:

```dotenv
MEDIACRAWLER_BROWSER_HEADLESS=false
MEDIACRAWLER_BROWSER_CHANNEL=
MEDIACRAWLER_BROWSER_DISPLAY=virtual
DOUYIN_OUTREACH_ACTIONS_ENABLED=false
DOUYIN_OUTREACH_APPROVALS_ENABLED=false
DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED=false
DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED=false
SHENSI_DESKTOP_CLIENT_ADMISSION_MODE=migration_locked
SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256=
DOUYIN_ACTION_VISUAL_LOCATOR=disabled
```

The sidecar consumes `MEDIACRAWLER_SERVICE_SECRET_FILE`; raw secret environment
values are not a deployment interface. Its exact host path is
`.runtime/real-trial/secrets/mediacrawler/service_secret`.
The MediaCrawler encrypted volume, profile root, and crawl-output root point to
`state/mediacrawler/`, `state/mediacrawler/profile/`, and
`state/mediacrawler/output/` respectively.
`MEDIACRAWLER_CRAWL_OUTPUT_ROOT` must be absolute, already exist, be a
non-symlinked current-user-owned directory with exact mode `0700`, and resolve
strictly inside but not equal to
`MEDIACRAWLER_ENCRYPTED_VOLUME`. Profile and output roots are distinct. The
runner resolves one output root and uses it for both creation and cleanup, so
trial artifacts never fall back to a source-owned directory.

The container publishes only its private HTTP API to host
`127.0.0.1:5612`. Each login session starts its own Xvfb/x11vnc pair. x11vnc
listens only on sidecar loopback; the gateway's private sidecar connection
proxies only the opaque token-bound WebSocket path. The normal page uses noVNC/RFB
embedded in the acquisition dialog, while the separate live-login tab, bounded
login frame, and four login commands remain backup controls for the same
browser context. It exposes no cookie,
browser security material, generic browser-control endpoint, VNC TCP, CDP,
X11, or debug port. The `virtual` display
mode validates Linux plus a local X display
before browser startup, and the same configuration fails closed in a native Mac
process instead of opening a host window.

The Backend has separate, exact lowercase approval/server/desktop flags; when
one is supplied, all three are required. The Sidecar still consumes the legacy
`DOUYIN_OUTREACH_ACTIONS_ENABLED` switch. A Backend configuration with no split
flags uses the bounded legacy server-only adapter.

The Trial supervisor emits all split flags explicitly and does not inherit
ambient desktop/admission settings. After the existing explicit authorization
and empty-queue audit, it maps the legacy setting to approval/server roles,
fixes desktop execution false, and fixes admission to `migration_locked` with
an empty digest. Bootstrap always runs with all roles false. Locked admission
blocks new gated HTTP mutations before approval handlers; it does not grant
desktop execution or cancel an existing server worker.
With the default action roles false:

- the backend rejects final approval before approval/action persistence;
- the backend creates neither the action claim worker nor recovery sweeper;
- the sidecar creates no action manager and returns the stable 503 before
  manager/executor lookup;
- the crawler worker and collection remain available.

The generated trial defaults the value to false. An explicitly authorized
action trial uses
`pnpm trial:publish --enable-outreach-after-empty-audit` for that one
publish. It performs a read-only global aggregate over `queued`,
`blocked_by_predecessor`, and `executing` before starting an action-enabled
backend; any nonzero or unknown result aborts and cleans up new processes. The
action worker starts immediately after the gate, so an approved queued comment
may be claimed as soon as approval commits. A separate confirmation may create
a version-2 direct-message action only after the same candidate's exact comment
has a durable successful receipt. Memory and MySQL claim only those v2 rows;
historical non-v2 rows stay readable, are not backfilled, and never reach the
browser. Account work is serialized, with at least 60 seconds reserved between
comments and ten minutes between private messages. MediaCrawler upstream is the
collection/browser foundation; comment and private-message execution are
Shensi extensions, not official Douyin APIs or upstream-native features. The
private-message executor uses only the focused vendored
`cv-cat/DouYin_Spider` modules. It authenticates from the already-bound sidecar
context without exporting cookies or security material, resolves the frozen
canonical `/user/{sec_uid}` target, requires the API-returned recipient
`sec_uid` to match exactly, revalidates account authority before conversation
creation and before send, and sends the approved text once. The immutable
action ID yields a deterministic UUIDv5 client message ID. Its sanitized
`douyin-im:<sha256>` receipt exposes no text, conversation/ticket ID, cookie,
security material, or raw `sec_uid`; a post-send exception is ambiguous and is
never retried.
For a comment, the visible action browser first looks for one unique editor. If
the editor is not mounted yet, it waits for one unique visible comment-input
container and one exact `留下你的精彩评论吧` entry, rechecks page risk, frozen URL,
sender, and deadline, and clicks that pinned entry once. This reversible
activation neither enters text nor publishes; a missing, unusable, or ambiguous
entry fails closed. The browser then waits for and pins the mounted editor,
enters the exact approved text, and verifies the readback. Only then does it
wait for and pin one unique usable send control. When the comment UI has no
semantic send control, it binds the exact editor for one unmodified Enter
keypress, which is the current first-party publish gesture. The synchronous
URL, sender, content, and control guard runs immediately before either dispatch.
The send control may
legitimately be disabled or not yet mounted before editor input; that state
alone is not a missing-control failure.
The batch freezes the policy time zone. DM approval uses the approval local day;
claim-time quota counts actual attempts on the claim local day, retries consume
that day, and reset occurs only on the next day. A second DM for the same batch
revision/candidate is permanently rejected even across dates.
Verification has no solver, token injection, third-party bypass, or alternate
write route. An ordinary operator-controlled local display may use the bounded
manual handoff when a verification page is detected immediately after initial
target navigation. The noVNC route is login-session-only and has already been
invalidated before an outreach action. The isolated trial has no remote control
for an action Xvfb display, so CAPTCHA, slider, login verification, and platform-warning states
require stopping the affected attempt and later starting a documented supported
flow; they never open Mac Chrome. A challenge that appears later fails closed
immediately. The enclosing defaults are a
150-second Node action deadline, 175-second gateway HTTP timeout, 170-second
browser-action IPC timeout, and 180-second minimum claim lease. Timeout pauses
risk. A deterministic comment failure may still close a predecessor-linked
historical direct-message row as `predecessor_failed`. An expired claim, malformed success receipt,
post-submit exception, or other uncertain external write is treated as
ambiguous, risk-pauses related account work, and is never automatically
retried. No deterministic or ambiguous failed action is automatically
resubmitted. The operator may use the page checkbox to request a strictly read-only
check for a unique post-start platform receipt of that same frozen comment or
version-2 private message; failure keeps it and related work paused, and success
does not resume the execution gate or successor. The login-backed social account
state and the outreach execution gate are read independently. Gate recovery
requires a second explicit confirmation with the current batch ETag/revision,
current login-state version,
the exact displayed pending action IDs, the full account-wide unresolved action
IDs, an idempotency key, and a reason of at least eight characters. Only approved
comments from that batch with `attempt_count=0` are eligible, and only an
`account_risk_paused` row can return to `queued`. An action carrying its own
`action_unavailable`, `douyin_action_timeout`, or
`douyin_action_receipt_ambiguous` result remains paused and is never resent.
For the exact same bound identity and login-state version, that transaction also
restores an `acquisition_social_accounts.state='risk_paused'` row to `active`;
disconnected, malformed, or stale-version account authority remains rejected.
Recovery fails closed if an action is executing, another batch has queued work,
the login version or batch authority changed, or either confirmed action list is
stale. The enabled action IDs, acknowledged uncertain IDs, actor, reason, request
hash, and recovery time are committed to the recovery ledger with the gate
change. If the exact current pending set is empty, recovery is allowed only after
the same full audit; it restores the account gate while recording an empty
`enabledActionIds` list and cannot requeue any terminal action. DOM/ARIA controls
are primary for comments. The generated trial keeps
`DOUYIN_ACTION_VISUAL_LOCATOR=disabled`; an explicit `rapidocr` runtime may use
the pinned local OCR dependencies only to suggest a missing comment entry/send
control before exact DOM rebind. It cannot choose identity, target, editor,
content, or receipt, and screenshots/recognized text are never persisted or
logged.
The action-enabled trial must use a visible browser. Comment submit controls are
pinned and guarded synchronously at click time against the exact URL and sender;
direct messages use the separate API-resolved exact-recipient binding above.
Visual MCP remains development-only diagnostics and the action path is model-
provider neutral. A login frame is not account authority; account connection does not
authorize collection; collection does not authorize external sending.
After the single comment submit, a verified success receipt or an ambiguous
post-submit receipt keeps the Douyin target page in front for ten seconds. In
the isolated trial the page remains private inside Xvfb and cannot be inspected
through the public application. No second click is made, the profile lease
remains held, and the Shensi durable receipt remains the success authority. An
ambiguous action appears as `结果待确认` and is never resent automatically.
An official comment response proves success only when the exact frozen request
text/video, first-party success status, and a stable returned comment ID all
bind. Returned text/video/author values must match when present. If Douyin
omits those optional echo fields, the frozen sender is revalidated after the
response instead. The browser waits for the official response body to finish
before parsing it. If that body is still unreadable, the same submission is not
repeated; success may be recovered only from a unique new self-owned stable-ID
comment visible in the bound target page.
During comment execution, the sidecar repeatedly revalidates the frozen sender
from the current page without navigating away. During private-message execution,
the focused transport instead repeats account-authority checks around exact
recipient resolution, conversation creation, and the single send; recipient or
account mismatch is a closed failure and never selects another conversation.

The only trial CLI entry points for this optional runtime are
`pnpm trial:start --action-visual-locator=rapidocr` and
`pnpm trial:publish --action-visual-locator=rapidocr`. They build the sidecar
image with the pinned frozen `visual-locator` dependency group and do not enable
external actions. Both image variants run the same Xvfb/uvicorn entry point.
`prepare`, `status`, and `stop` reject the option. When real
outreach is separately authorized, the operator may combine the locator option
with `--enable-outreach-after-empty-audit`; neither option implies the other.

The connected account shown at final review must have a nonempty nickname and
the same account ID and login-state version frozen in the batch. Login binding
derives a one-way `dyacct_<sha256>` handle from the authenticated own-profile
identity and never returns raw `sec_uid`. Login versions are globally monotonic,
and the backend retains their private high-water after disconnect or risk
pause, so polling an older login session cannot restore authority. If any identity
check changes before execution or the official publish receipt names a
different author, the comment fails closed and related work is risk-paused.

## Lifecycle commands

From the repository root, with the customer password supplied out of band:

```bash
pnpm trial:prepare
pnpm trial:start
pnpm trial:publish
pnpm trial:status
pnpm trial:verify
pnpm trial:stop
```

On the first preparation for a clean runtime, set
`SHENSI_TRIAL_CLOUDFLARED` to the absolute path of the approved binary. Once it
has passed the pinned SHA-256 check, later commands reuse the retained
`.runtime/real-trial/tools/cloudflared` copy without requiring the original
source path.

### Prepare

`trial:prepare` refuses an occupied fixed port, unsafe runtime path/file state,
missing password input, mismatched repeated password, or cloudflared checksum
failure. A clean runtime with neither an approved source nor a retained copy
fails with `TRIAL_CLOUDFLARED_REQUIRED`. It creates the protected runtime and
canonical encoded MySQL URL without printing a credential.

### Start

Before starting MySQL or creating a public tunnel, `trial:start` creates or
starts only the dedicated Colima profile `shensi-trial` and builds the requested
MediaCrawler image from the current worktree. It never falls back to native Mac
Chrome. It then initializes the dedicated MySQL data directory, provisions the
least-privilege database/user, obtains the Quick Tunnel HTTPS origin before
backend startup, injects that origin and `http://127.0.0.1:5608` into
`CORS_ORIGINS`, provisions the tenant admin through the real API, and starts
only loopback listeners. Startup aborts on an unavailable Colima/Docker
dependency, failed image build, unhealthy dependency, or occupied port.

### Publish verified changes

After the acceptance gates pass, `trial:publish` is the single refresh path for
an already prepared trial. Before stopping anything, it verifies or installs
the runtime-owned cloudflared copy. Missing or unverified tooling leaves the
existing process groups and status untouched. It then validates and stops only
the recorded process groups, keeps `.runtime/real-trial/state/` intact, rebuilds frontend and backend
from the current worktree, writes the frontend into the isolated
`.runtime/real-trial/release/frontend/` snapshot, restarts the complete loopback
stack, and runs the bounded gateway verification. A new Quick Tunnel origin may
be issued and must be read from `trial:status`.

The customer-facing local URL and public origin use the same published frontend
build, backend runtime, sidecar image, and MySQL database. Development source is
not a live two-way synchronization channel: editing the worktree changes neither
view until the operator explicitly runs and verifies `trial:publish`.

Account reconnect must be triggered once. The UI disables the reconnect control
during the short create request and while the current unfinished session remains
in `qrStatus: opening` without a terminal failure. `POST` immediately returns
`awaiting_scan` with
`loginPage: null`; the sidecar opens the official page in the background outside
the global state lock. During that opening phase the UI says the secure
environment is starting, not that the page has opened. `GET` polling later shows
a bounded JPEG fallback when capture succeeds. If a later poll or semantic
refresh cannot capture only that frame, the response keeps the same session,
QR state, and noVNC context with `loginPage: null`; null alone does not map the
attempt to `login_expired`. Only a genuinely terminal attempt may return
`login_expired` with an optional safe `failureCode`. The primary control mounts
noVNC/RFB inside the dialog; its
authenticated `POST .../{sessionId}/live` obtains a new single-use socket token.
A retryable `409` `douyin_login_session_not_ready` waits and remints against
the same session/profile. RFB reconnect may also request another token after a
disconnect; it never reuses the consumed WebSocket URL. The new-tab route is a
backup for that same context.
Closing the dialog sends the workspace-scoped login-session `DELETE`; an
account-level reconnect cancels an unfinished predecessor before creating its
replacement, while RFB reconnect stays on the current session/profile. Poll and
interaction may still own the serialized browser worker when cancel arrives.
The UI therefore unmounts RFB first, and the sidecar then commits logical
revocation (session/generation/unused-token removal) before assigning eventual
context close and profile deletion to one tracked bootstrap or cleanup thread.
Do not diagnose a fast `204` as proof that browser close was synchronous; use
the cleanup logs or shutdown result when validating reclamation. A previously
claimed socket from a non-cooperating client closes when deferred context
teardown reaches it. Poll and interaction I/O otherwise use a per-session lease
with generation/CAS authority. Terminal
completion closes and flushes the browser context before the matching CAS
persists account authority. Open failure,
disconnect, expiry, explicit close, shutdown, a fresh start, and persistence
failure clear unfinished work, leases, and browser resources without replay.
Bootstrap generation/stale checks isolate old results. A replacement waits for
the preceding bootstrap thread to exit, and disconnect invalidates its pending
preparation so that it cannot overwrite or close the next context. The sidecar
does not reuse an opening session globally across tenants. The public backend
scopes replay to workspace plus `Idempotency-Key` and uses a repository-backed
workspace opening lease/fence to reuse one unexpired upstream `awaiting_scan`
session across different keys or backend instances. Cancellation and terminal,
expired, or missing upstream state release the slot before a replacement.
Cancellation fences the old opening before the sidecar call; if that call
fails, retry cancellation with the same old session ID while a new create stays
isolated from it. The embedded
client keeps one connect in flight, retries a live-mint `409` only for the same
session, and clears requests, retry timers, and RFB state on unmount. The server
returns retryable HTTP `409` `douyin_login_session_not_ready` while
a valid live context is still starting; other private-browser gateway failures
remain retryable HTTP `503` `mediacrawler_unavailable`. A later fresh login attempt may restart a failed
browser, but it never replays a previously sent browser, comment, private-message,
or reconciliation command. Each browser command remains bounded. If the page
shows an error, inspect the stable public code and sidecar log before another
manual attempt rather than repeatedly clicking reconnect.
The normal public-trial login embeds a Shensi noVNC/RFB client for the
server-owned Xvfb/Playwright context; its backup tab controls that same context.
Neither is a separate customer-side Douyin session:
opening the public Douyin site directly in another tab would retain its cookie
on the customer's device and cannot authorize the sidecar profile. The original
acquisition page keeps polling the login session after QR scan and binds the
account only after the sidecar reports `active` authenticated identity. This
login-session `GET` and interaction `POST` use a dedicated 70-second gateway
transport timeout; other MediaCrawler requests keep their shorter defaults.

Use `http://127.0.0.1:5608` for the customer-facing local view. That local URL
and the reported HTTPS origin both traverse the same gateway to frontend `5610`
and backend `5611`. The Vite development server on `5588` is only a developer
hot-reload surface and is never evidence that the published trial was updated.

### Status and verify

`trial:status` validates recorded PID/command/nonce and owned-container authority
before reporting a component as running and is the authority for the current
temporary origin. `processesRunning` requires all six owned service records and
the owned MediaCrawler sidecar to be running. `publicReachable` requires the
temporary origin to answer `/api/health`; aggregate `running` is true only when
both checks pass. The supervisor starts the backend and frontend preview from
their built/runtime executables. MediaCrawler starts through one nonce-bearing
host wrapper which launches the selected image in `shensi-trial`, follows its
logs, and waits for that exact container. Disabled and RapidOCR images use the
same Xvfb/uvicorn runtime; only the frozen optional dependency group differs.
The recorded wrapper is the process-group leader:
normal stop, bootstrap replacement, verification failure, and partial-start
cleanup signal the complete group with `SIGTERM`, then use `SIGKILL` only after
the container's graceful stop budget if needed. The sidecar wrapper stops by
exact container ID after verifying the runtime-derived ownership label; failure
cleanup applies the same check so an SSH/log follower exit cannot leave an owned
container behind or remove an unrelated one.
For PID metadata, start removes only records whose PID no longer exists;
any live PID with a different command or nonce remains recorded and blocks the
start rather than being replaced or signalled.
`trial:verify` reads that owner-only runtime status by default; an explicit
operator-supplied origin is only an override, and neither value belongs in a
tracked document.
`trial:verify` is a bounded runtime check. It makes at most six attempts, gives
each fetch a five-second timeout, and retries only transport failures or
non-healthy gateway/backend responses on the fixed `250ms`, `500ms`, `1s`,
`2s`, `4s` schedule. Exhaustion returns
`TRIAL_PUBLIC_VERIFICATION_UNAVAILABLE` for transport failures or
`TRIAL_GATEWAY_OR_BACKEND_UNHEALTHY` for health responses without printing the
origin. After both health routes pass, protected-route authentication and
internal-route isolation mismatches fail closed immediately without retry. The
check is not a substitute for the complete Task 5 acceptance checklist.

The Quick Tunnel origin may change after a tunnel restart. The trial is
unavailable while the Mac sleeps or is offline; the URL is not a permanent
domain or an acceptance record.

### Stop

`trial:stop` operates only on recorded trial process groups and the exact
runtime-owned MediaCrawler container. Before TERM and again before any bounded
KILL escalation, it verifies the recorded PID, expected command, and runtime
nonce against the live process. Container stop/removal also requires its
runtime-derived name and ownership label. A mismatch or PID reuse fails closed
instead of signalling an unrelated process or container. Stop removes live
status but retains the protected profile, login metadata, crawl output, MySQL,
logs, and secrets; it does not stop the `shensi-trial` profile itself.

## Customer-data retention and retirement

Stopping the stack does not delete the dedicated MySQL data, browser profile,
crawl state, logs, or secrets. The normal application lifecycle still applies:

- an acknowledged sidecar job starts its 24-hour result cleanup clock;
- unlinked crawler evidence is removed 90 days after backend ingestion;
- linked evidence, permanent DNC identity hashes, and audit authority are not
  removed by that 90-day cleanup.

Before removing `.runtime/real-trial/`, record the customer's retention choice,
export the database with approved encrypted tooling, and either disconnect and
delete the Douyin profile through the normal account lifecycle or preserve it
only in approved encrypted-at-rest storage. Do not delete the runtime tree as a
stop shortcut and do not extract its state into unencrypted staging.

## Acceptance gate

The temporary link is customer-ready only after fresh evidence from the current
tree proves all of the following:

1. `./scripts/context-check`, focused frontend/MediaCrawler/runtime tests,
   `pnpm test`, `pnpm build`, and `git diff --check` pass.
2. `trial:prepare`, `trial:start`, `trial:publish`, `trial:status`, and
   `trial:verify` succeed;
   all protected older services remain unchanged.
3. An unauthenticated protected API returns `401`; `test` logs into the exact
   tenant admin; a CSRF-protected write succeeds; logout invalidates the session.
4. A CRM record persists after restarting only the trial backend, and a second
   temporary tenant cannot read it; that verification tenant is then removed or
   disabled.
5. Public traffic cannot reach MediaCrawler/internal routes, backend API docs,
   source files, runtime files, or secret files. MySQL/backend/sidecar remain
   loopback-only. Container inspection shows MediaCrawler bound only to host
   `127.0.0.1:5612`, with no VNC TCP/CDP/X/debug publish, and login-session
   creation causes no native Mac browser process or window. A plain HTTP request,
   malformed token, reused token, or expired token cannot open `/douyin-live/*`.
6. Every developed primary and Growth module is reachable. Real surfaces use
   persisted authority; every preview/pending surface visibly says
   `预览 · 待接入`; normal body scrolling and navigation work.
7. Douyin login creation first returns `awaiting_scan`, `qrStatus: opening`,
   `loginPage: null`, and `qrImageDataUrl: null`. Confirm that this state says
   the secure login environment is starting and does not claim that the page
   opened. Poll until the same session returns either `ready` with a directly
   rendered QR image, or the exact `expired`, `network_error`, or
   `verification_required` state without an old QR image. Confirm that
   an empty follow-up poll does not regress one of those explicit states to
   `opening`, and that `ready` is never returned without a QR image. Confirm that
   `refresh_qr` makes one bounded refresh against the same profile. Use the same
   session to force or simulate a later poll/refresh fallback-frame capture
   failure: it must return `loginPage: null` without a terminal `failureCode` or
   `login_expired`, retain the last explicit QR state and live noVNC context, and
   allow a subsequent poll to restore the JPEG. Repeat the same check during
   initial best-effort preparation: the already registered context must remain
   available to live-token minting and noVNC. Separately inject a fatal
   browser/display/VNC failure or unsafe page and verify that it closes the
   attempt. Use the embedded Shensi live-login surface and
   confirm its authenticated
   live-mint response returns only the same-origin socket path/expiry, and confirm noVNC can click,
   type, scan, and refresh the official login page. The original acquisition
   page must continue polling the same session through QR scan and bind the
   account only after `active`. A not-ready live mint must surface retryable
   HTTP `409` and recover automatically without replacing the session/profile.
   Rapid reconnect clicks during create/opening must yield one current session;
   unmounting the login view must cancel its timer/request/RFB activity. Two
   workspaces with different idempotency authority must never share a sidecar
   login context.
   The new-tab and collapsed JPEG backups must still target that same context without
   starting another open. A connected
   terminal result is authoritative only after the context has been closed and
   flushed and the matching generation CAS has persisted the account.
   If the customer is absent, stop before entering credentials or completing
   platform verification. After the customer completes the login in that
   live or fallback surface, one manual-keyword collection produces candidates that
   persist after refresh. CAPTCHA, slider, verification, or warning requires the
   human to complete the supported flow; it never authorizes a solver, bypass,
   VNC TCP/CDP exposure, unrelated browser login, or Mac Chrome fallback.
   Closing an unfinished dialog must return `204` from the login-session
   `DELETE`, remove that attempt from the UI, and prevent its later poll result
   from restoring the dialog.
8. In the default disabled mode, final outreach approval and the private sidecar
   action endpoint remain `outreach_actions_disabled`. In an explicitly
   authorized enabled trial, verify the empty action queue before startup and
   never use a real action request as an automated health probe. Automated
   `trial:publish` / `trial:verify` acceptance may read, create, edit, save, and
   reload a pending batch to verify the confirmation gate, but it stops before
   the final user approval and therefore queues no external action. Select only
   candidates marked as backed by a commentable video; profile-only rows must
   remain clickable for evidence inspection while their outreach controls stay
   disabled and no candidate-scoped batch is created for them.
   Before the user crosses comment approval, the page must visibly show the
   connected account, account ID, login-state version, exact public target
   video, the candidate's read-only public profile, exact comment text, current
   comment character count, remaining comment allowance, and the explicit
   notice that private-message approval stays locked until a durable successful
   comment receipt. The account must be active,
   and its ID and login-state version must match the frozen batch authority.
   Either public target being missing or malformed, any account mismatch, or
   any unsaved edit must disable the confirmation checkbox and final button.
   The crawler status must be terminal with candidate projection `ready` before
   creating the reviewed batch. A projection-pending approval must keep the
   batch awaiting approval, show the Chinese waiting state, and leave the
   action queue empty.
   The first button must say it queues a real comment. After the receipt is
   durable, the private-message panel must show the same account/profile,
   predecessor receipt binding, editable text up to 800 characters, remaining
   independent daily allowance, and a distinct confirmation that queues a real
   version-2 private message. Automated verification crosses neither
   confirmation. Machine status/error codes may appear only inside collapsed
   technical details. The public batch
   candidate exposes the frozen public video/profile targets needed for this
   review, but never `evidenceText` or `publicActorKey`.

The 2026-08-26 launch passed the fresh source gates, isolated startup/status,
local and public boundary verification, tenant-admin login, MySQL-backed CRM
write/restart/read, cleanup of the unique verification record, and public login
page checks. Six durable runtime processes are tracked: MySQL, backend,
MediaCrawler, frontend, gateway, and tunnel. The current temporary origin must
still be read from `trial:status`.

Customer-interactive acceptance requires the authenticated full-page
walk-through and an authorized interactive Douyin login followed by one manual-keyword
collection. External comments require a separately recorded user authorization
plus the page's comment-specific confirmation. A private message additionally
requires that comment's durable success receipt and its own separately recorded
action-time confirmation. Historical non-v2 rows are read-only and cannot be
claimed or executed. Publish and automated verification stop before both
confirmation controls; only the user may cross either in the corresponding
action-time acceptance. Do not retire the older
protected link until those customer-interactive checks are complete.

## Retirement checklist

1. Run `trial:stop` and confirm only validated trial process groups and the
   matching labeled MediaCrawler container stopped; the retained profile and
   login state remain present.
2. Keep the older protected services untouched until the new link has passed
   acceptance.
3. Export/verify the trial database and complete the approved profile-retention
   choice.
4. Retire an old static tunnel/link only after Task 5 acceptance.
5. Delete the ignored runtime root only after data and profile disposition is
   complete.

Automated launch verification does not send private messages. A separately
authorized version-2 private-message acceptance may run in this trial only as
an action-time operator step against a dedicated account and test-owned targets,
after the same candidate's durable successful comment receipt and the second
confirmation. It never permits CAPTCHA, slider, verification, or warning bypass.
