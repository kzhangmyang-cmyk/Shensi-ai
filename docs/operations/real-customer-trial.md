# Real Customer Trial Runtime

This document is the current operating contract for the temporary Shensi
customer trial. The isolated runtime is publicly reachable when
`pnpm trial:status` reports `running: true`; that owner-only runtime state is the
authority for the current temporary origin. Never write a temporary tunnel URL,
password, token, cookie, provider key, browser profile, or crawl output into
tracked files.

## Goal and truthful product scope

The trial publishes the latest frontend and backend behind one temporary HTTPS
origin so one invited customer can see every feature developed so far. Visible
does not mean live: real API/MySQL surfaces remain real, while browser-local or
pending integrations remain visible and carry the exact label
`预览 · 待接入`. They never present fixture values as live customer results.

All nine primary navigation entries are present:

- 自动营销总览
- 获客中心
- 社媒对话
- 私域客户池
- 成交工作台
- 智能体中心
- 自动工作流
- 外贸营销
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
the `#acquisition` MediaCrawler path for QR login, plan approval, manual
keywords, controlled collection, persisted status/candidates/evidence, draft
review, and CRM conversion. In an authenticated real session, `#conversations`
is the public-evidence controlled outreach workspace for those same tasks. It
labels records as `真实 · 抖音公开互动`, never presents an official inbox or
two-party message thread, and never substitutes local seeded conversations.
`#growth/quotes` without a case shows a
customer-readable empty state; it does not invent a quote or expose
`quote_case_required`.

The browser-local dashboard, conversion, automation, and overseas-marketing
presentations stay visible as `预览 · 待接入`; demo sessions also retain the
deterministic local conversations preview. AI-only
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
| MediaCrawler sidecar | `127.0.0.1:5612` | private backend integration only |

The `shensi_trial_app@127.0.0.1` database account has privileges only on
`shensi_trial`. The gateway owns `/healthz` and sends only `/api` and `/api/*`
to the backend; all other allowed application paths go to the frontend. It
preserves cookies, CSRF headers, HTTP methods, and the HTTPS forwarded scheme.
MySQL, backend, and MediaCrawler are never direct tunnel targets.

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
  logs/
  pids/
  tools/
  release/
    frontend/
  state/
    mysql/
    mediacrawler-profile/
    mediacrawler-output/
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
exact repeat. The configured fixed cloudflared binary is copied into `tools/`
only after its SHA-256 matches. Logs and status may expose bounded component
names, paths, PIDs, health, and the current temporary origin; they must never
expose environment values or secrets.

## Identities and login alias

- The customer receives tenant `admin` in `trial-pilot-001`, never
  `super_admin`.
- The visible login alias is `test`; the canonical backend email is
  `test@shensi.local`.
- Alias mapping exists only when `VITE_REAL_TRIAL` is exactly `true` and both
  `VITE_TRIAL_LOGIN_ALIAS` and `VITE_TRIAL_LOGIN_EMAIL` are non-empty.
- Matching trims and lowercases only the lookup key and requires an exact own
  alias property. A match submits the canonical email. Every unmatched identity
  is submitted byte-for-byte unchanged, and the password is never normalized or
  rewritten.
- Enabled but incomplete alias configuration fails before a login request. The
  backend `/api/auth/login` remains email-only; it does not natively accept a
  username.

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

The generated runtime uses visible standard Playwright Chrome:

```dotenv
MEDIACRAWLER_BROWSER_HEADLESS=false
MEDIACRAWLER_BROWSER_CHANNEL=chrome
DOUYIN_OUTREACH_ACTIONS_ENABLED=false
DOUYIN_ACTION_VISUAL_LOCATOR=disabled
```

The sidecar consumes `MEDIACRAWLER_SERVICE_SECRET_FILE`; raw secret environment
values are not a deployment interface.
The MediaCrawler encrypted volume, profile root, and crawl-output root point to
the dedicated trial state. `MEDIACRAWLER_CRAWL_OUTPUT_ROOT` must be absolute,
already exist, be a non-symlinked current-user-owned directory with exact mode
`0700`, and resolve strictly inside but not equal to
`MEDIACRAWLER_ENCRYPTED_VOLUME`. Profile and output roots are distinct. The
runner resolves one output root and uses it for both creation and cleanup, so
trial artifacts never fall back to a source-owned directory.

Outside the trial supervisor, both backend and sidecar enable outreach only
when `DOUYIN_OUTREACH_ACTIONS_ENABLED` is case-insensitively exactly `true`.
Whitespace, `1`, `yes`, an empty value, and omission remain false. The trial
supervisor does not treat an ambient or retained true value as authorization.
While false:

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
Shensi extensions, not official Douyin APIs or upstream-native features.
For a comment, the visible action browser first looks for one unique editor. If
the editor is not mounted yet, it waits for one unique visible comment-input
container and one exact `留下你的精彩评论吧` entry, rechecks page risk, frozen URL,
sender, and deadline, and clicks that pinned entry once. This reversible
activation neither enters text nor publishes; a missing, unusable, or ambiguous
entry fails closed. The browser then waits for and pins the mounted editor,
enters the exact approved text, and verifies the readback. Only then does it
wait for and pin one unique usable send control before the synchronous URL,
sender, content, and control guard and the single click. The send control may
legitimately be disabled or not yet mounted before editor input; that state
alone is not a missing-control failure.
The batch freezes the policy time zone. DM approval uses the approval local day;
claim-time quota counts actual attempts on the claim local day, retries consume
that day, and reset occurs only on the next day. A second DM for the same batch
revision/candidate is permanently rejected even across dates.
Visible verification is manual-only: when a verification page is detected
immediately after initial target navigation, Shensi waits up to 120 seconds and
revalidates the same action after the user completes it. A challenge that
appears later fails closed immediately. The enclosing defaults are a
150-second Node action deadline, 175-second gateway HTTP timeout, 170-second
browser-action IPC timeout, and 180-second minimum claim lease. Timeout pauses
risk; no solver, token injection, third-party bypass, or alternate write route
is allowed. A deterministic comment failure may still close a predecessor-linked
historical direct-message row as `predecessor_failed`. An expired claim, malformed success receipt,
post-submit exception, or other uncertain external write is treated as
ambiguous, risk-pauses related account work, and is never automatically
retried. No deterministic or ambiguous failed action is automatically
resubmitted. The operator may use the page checkbox to request a strictly read-only
check for a unique post-start platform receipt of that same frozen comment or
version-2 private message;
failure keeps it and related work paused, and success does not resume the
account or successor. DOM/ARIA controls are primary. The generated trial keeps
`DOUYIN_ACTION_VISUAL_LOCATOR=disabled`; an explicit `rapidocr` runtime may use
the pinned local OCR dependencies only to suggest a missing entry/send control
before exact DOM rebind. It cannot choose identity, recipient, editor, content,
or receipt, and screenshots/recognized text are never persisted or logged.
The action-enabled trial must use a visible browser. Submit controls are pinned
and guarded synchronously at click time against the exact URL, sender, and DM
recipient; DM receipt proof is one atomic snapshot of the same outgoing node.
Visual MCP remains development-only diagnostics and the action path is model-
provider neutral. QR display is not account authority; account connection does not
authorize collection; collection does not authorize external sending.
After the single comment submit, a verified success receipt or an ambiguous
post-submit receipt keeps the Douyin target page in front for ten seconds. Use
that interval only to inspect the platform page: no second click is made, the
profile lease remains held, and the Shensi durable receipt remains the success
authority. An ambiguous action appears as `结果待确认` and is never resent
automatically.
During an enabled action, the sidecar repeatedly revalidates the frozen sender
from the current page without navigating away. Private-message input, submit,
and receipt controls must also remain bound to one exact visible recipient panel
matching the frozen profile URL. An account switch, recipient switch, missing
marker, or ambiguous panel is a closed failure and is not an instruction to
retry or choose another conversation.

The only trial CLI entry points for this optional runtime are
`pnpm trial:start --action-visual-locator=rapidocr` and
`pnpm trial:publish --action-visual-locator=rapidocr`. They select the pinned
`uv run --frozen --extra visual-locator` sidecar command and do not enable
external actions. `prepare`, `status`, and `stop` reject the option. When real
outreach is separately authorized, the operator may combine the locator option
with `--enable-outreach-after-empty-audit`; neither option implies the other.

The connected account shown at final review must have a nonempty nickname and
the same account ID and login-state version frozen in the batch. QR binding
derives a one-way `dyacct_<sha256>` handle from the authenticated own-profile
identity and never returns raw `sec_uid`. Login versions are globally monotonic,
and the backend retains their private high-water after disconnect or risk
pause, so polling an older QR session cannot restore authority. If any identity
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

### Prepare

`trial:prepare` refuses an occupied fixed port, unsafe runtime path/file state,
missing password input, mismatched repeated password, or cloudflared checksum
failure. It creates the protected runtime and canonical encoded MySQL URL
without printing a credential.

### Start

`trial:start` starts a newly initialized MySQL data directory first, provisions
the least-privilege database/user, obtains the Quick Tunnel HTTPS origin before
backend startup, injects that origin and `http://127.0.0.1:5608` into
`CORS_ORIGINS`, provisions the tenant admin through the real API, and starts
only loopback listeners. Startup aborts on an unhealthy dependency or an
occupied port.

### Publish verified changes

After the acceptance gates pass, `trial:publish` is the single refresh path for
an already prepared trial. It validates and stops only the recorded process
groups, keeps `.runtime/real-trial/state/` intact, rebuilds frontend and backend
from the current worktree, writes the frontend into the isolated
`.runtime/real-trial/release/frontend/` snapshot, restarts the complete loopback
stack, and runs the bounded gateway verification. A new Quick Tunnel origin may
be issued and must be read from `trial:status`.

Local development and the trial use the same repository source. They are not a
live two-way synchronization channel: editing source changes neither a running
trial nor its tunnel until the operator explicitly runs and verifies
`trial:publish`.

Use `http://127.0.0.1:5608` for the customer-facing local view. That local URL
and the reported HTTPS origin both traverse the same gateway to frontend `5610`
and backend `5611`. The Vite development server on `5588` is only a developer
hot-reload surface and is never evidence that the published trial was updated.

### Status and verify

`trial:status` validates recorded PID/command/nonce authority before reporting a
component as running and is the authority for the current temporary origin.
The supervisor starts the backend and frontend preview from their built/runtime
executables. With visual locating disabled, MediaCrawler also starts from the
absolute `.venv/bin/uvicorn`; the explicit RapidOCR mode instead starts one
owned `uv run --frozen --extra visual-locator` child. In both modes the recorded
nonce-bearing wrapper owns the complete descendant process group. The wrapper
is the process-group leader:
normal stop, bootstrap replacement, verification failure, and partial-start
cleanup signal the complete group with `SIGTERM`, then use `SIGKILL` after the
bounded wait if needed, so killing a wrapper cannot leave its service behind.
Start removes only records whose PID no longer exists;
any live PID with a different command or nonce remains recorded and blocks the
start rather than being replaced or signalled.
`trial:verify` reads that owner-only runtime status by default; an explicit
operator-supplied origin is only an override, and neither value belongs in a
tracked document.
`trial:verify` is a bounded runtime check, not a substitute for the complete
Task 5 acceptance checklist.

The Quick Tunnel origin may change after a tunnel restart. The trial is
unavailable while the Mac sleeps or is offline; the URL is not a permanent
domain or an acceptance record.

### Stop

`trial:stop` operates only on recorded trial process groups. Before TERM and
again before any bounded KILL escalation, it verifies the recorded PID,
expected command, and runtime nonce against the live process. A mismatch or PID
reuse fails closed instead of signalling an unrelated process. Stop removes
live status but retains the protected runtime data.

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
   loopback-only.
6. Every developed primary and Growth module is reachable. Real surfaces use
   persisted authority; every preview/pending surface visibly says
   `预览 · 待接入`; normal body scrolling and navigation work.
7. Douyin QR creation and polling work. If the customer is absent, stop at the
   visible QR-ready state. After an authorized scan, one manual-keyword
   collection produces candidates that persist after refresh.
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
walk-through and an authorized Douyin QR scan followed by one manual-keyword
collection. External comments require a separately recorded user authorization
plus the page's comment-specific confirmation. A private message additionally
requires that comment's durable success receipt and its own separately recorded
action-time confirmation. Historical non-v2 rows are read-only and cannot be
claimed or executed. Publish and automated verification stop before both
confirmation controls; only the user may cross either in the corresponding
action-time acceptance. Do not retire the older
protected link until those customer-interactive checks are complete.

## Retirement checklist

1. Run `trial:stop` and confirm only validated trial process groups stopped.
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
