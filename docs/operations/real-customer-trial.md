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
also reads those existing Douyin tasks' latest-run public candidate evidence.
It labels the records as `真实 · 抖音公开互动`, not as private messages or an
inbox, and never substitutes local seeded conversations. `#growth/quotes` without a case shows a
customer-readable empty state; it does not invent a quote or expose
`quote_case_required`.

The browser-local dashboard, conversion, automation, and overseas-marketing
presentations stay visible as `预览 · 待接入`; demo sessions also retain the
deterministic local conversations preview. AI-only
controls remain visible but explain that a healthy model connection is required.
Generic public-web acquisition remains an optional separate path; a missing
search or model provider never blocks manual-keyword MediaCrawler collection.

The real `#conversations` page is read-only. Its reply field and send button are
disabled and explain that the product has no connected official inbox, private-
message, comment, or reply API. The current outreach contract can list actions
only for a known batch ID and cannot discover a batch from an acquisition run;
the page therefore states that receipt limitation instead of guessing or
fabricating a receipt. Operators review any known approved batch in
`#acquisition`; the conversations page never creates, approves, or executes one.

Outreach drafts can be edited and reviewed, but this launch does not allow final
outreach approval. With the fixed disabled action gate, final approval returns
`503 outreach_actions_disabled`, creates neither approval nor actions, and sends
no comment or direct message. Plan approval for collection is a separate real
authority and remains available.

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
  state/
    mysql/
    mediacrawler-profile/
    mediacrawler-output/
```

Runtime, state, secret, log, PID, and tool directories are `0700`; generated
credential and environment files are `0600`. `trial.env` is the current
generated runtime environment. Do not create or document a parallel
`.env.real-trial.local`; `.env.real.local` belongs to the older non-trial
wrapper.

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

Both backend and sidecar enable outreach only when
`DOUYIN_OUTREACH_ACTIONS_ENABLED` is case-insensitively exactly `true`.
Whitespace, `1`, `yes`, an empty value, and omission remain false. While false:

- the backend rejects final approval before approval/action persistence;
- the backend creates neither the action claim worker nor recovery sweeper;
- the sidecar creates no action manager and returns the stable 503 before
  manager/executor lookup;
- the crawler worker and collection remain available.

This launch fixes the value to false. QR display is not account authority;
account connection does not authorize collection; collection does not authorize
external sending. Never bypass CAPTCHA, verification, rate limits, or platform
warnings.

## Lifecycle commands

From the repository root, with the customer password supplied out of band:

```bash
pnpm trial:prepare
pnpm trial:start
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
backend startup, injects that exact origin into `CORS_ORIGINS`, provisions the
tenant admin through the real API, and starts only loopback listeners. Startup
aborts on an unhealthy dependency or an occupied port.

### Status and verify

`trial:status` validates recorded PID/command/nonce authority before reporting a
component as running and is the authority for the current temporary origin.
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
2. `trial:prepare`, `trial:start`, `trial:status`, and `trial:verify` succeed;
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
8. Final outreach approval and the private sidecar action endpoint remain
   `outreach_actions_disabled`; no comment or direct message is sent.

The 2026-08-26 launch passed the fresh source gates, isolated startup/status,
local and public boundary verification, tenant-admin login, MySQL-backed CRM
write/restart/read, cleanup of the unique verification record, and public login
page checks. Six durable runtime processes are tracked: MySQL, backend,
MediaCrawler, frontend, gateway, and tunnel. The current temporary origin must
still be read from `trial:status`.

Customer-interactive acceptance remains bounded to the authenticated full-page
walk-through and an authorized Douyin QR scan followed by one manual-keyword
collection. Those steps require the customer to be present. External comment
and direct-message actions remain disabled and are not part of this launch. Do
not retire the older protected link until those customer-interactive checks are
complete.

## Retirement checklist

1. Run `trial:stop` and confirm only validated trial process groups stopped.
2. Keep the older protected services untouched until the new link has passed
   acceptance.
3. Export/verify the trial database and complete the approved profile-retention
   choice.
4. Retire an old static tunnel/link only after Task 5 acceptance.
5. Delete the ignored runtime root only after data and profile disposition is
   complete.

A future one-comment/one-message acceptance is a separate, action-time operator
authorization against a dedicated account and test-owned targets. It is not part
of this launch and never permits CAPTCHA or warning bypass.
