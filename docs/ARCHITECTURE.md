# Architecture

## System shape

Platform administration uses the separate `frontend/admin.html` entry and
`backend/src/platform-admin-router.ts` under `/api/platform/v1`. Its independent
MFA membership does not grant customer business roles. Users, platform authority
and audit commit in the existing serialized MySQL boundary; worker dispatch
reads fresh entitlements. See [platform administration](modules/platform-administration.md).

Shensi is a pnpm workspace with four source boundaries:

- `frontend/` is the React 19 and Vite browser application. `app-entry.ts`
  starts session restoration; `app-route.ts` normalizes the hash route to the
  home or a supported module; `growth/router.ts` owns Growth and
  financial-council deep links.
- `backend/` is the Express application. `src/server.ts` mounts legacy CRM and
  identity routes directly, then delegates Growth and acquisition routes to
  `GrowthCommercialRuntimeBridge` and `AcquisitionRuntimeBridge`.
- `contracts/` contains the editable OpenAPI and JSON Schema sources,
  immutable Growth releases, validation tests, and frontend type generation.
- `desktop/` contains Electron Main, its restricted Preload, the loopback
  Renderer/API gateway and local Sidecar supervision. It loads the latest
  frontend build; browser credentials and Profiles remain on the user's Mac.

Daily desktop development uses `pnpm desktop:local`: source Electron, the host
Backend and independent persistent MySQL. It rebuilds the development window,
not an installer. Its gateway forwards the Renderer’s same-origin `/api`
requests to that local Backend. A deployed desktop client can instead use an
approved remote business API; Alibaba deployment remains deferred.

The retained Web runtime calls same-origin `/api` routes. Vite proxies those requests during
Web development. Production Compose places a single public Nginx gateway in front
of the static frontend and backend. A separate internal-only network connects
the backend and the gateway to the non-root MediaCrawler sidecar. The gateway
uses that network only for the token-bound `/douyin-live/{token}` WebSocket;
sidecar HTTP APIs, VNC TCP, X11, and browser-debug ports are not published.
MySQL, backend, frontend, sidecar, and gateway all retain separate runtime
responsibilities.

## Browser acquisition runtime split

`services/media-crawler/shensi_adapter/runtime_config.py` resolves the browser
mode once at Sidecar startup. `SHENSI_RUNTIME_MODE=desktop` maps to
`interaction_surface=external_window`, a headed external Chrome window and a
`LocalBrowserSessionManager`. `AccountManager` continues to own the API/business
session and profile/identity persistence; the local manager is its BrowserState
facade and exclusively owns each opaque local worker and Browser Context. It
uses account-scoped lifecycle coordination and supports generation-fenced
recheck and cancellation. Desktop requests still enter through
`AccountManager`, but its global `RLock` covers only short session/authority
state transitions; launch, poll, execute, and reconcile browser I/O happen
outside that lock in the LBSM-owned worker. This branch has
no Xvfb, VNC, websockify, noVNC, live-session token, QR-image, or login-page
screenshot dependency.

Desktop data is rooted at the absolute `SHENSI_USER_DATA_DIR`, or at
`<repository>/.local-data` when the variable is absent. The trusted backend
derives `sha256("douyin-profile:" + workspaceId)` and sends that opaque
64-hex account key only to the private Sidecar. The Sidecar derives the stable
profile directory from that key; the public contract never exposes either key
or path. After LBSM detects authentication, it closes the login Context;
`AccountManager` then binds and persists the identity before the same Profile is
handed to the existing collection path.

The backend persists `interactionSurface` with each private login-session row.
Hydration treats a legacy row with no stored surface as `remote_canvas`; this
keeps pre-migration Web sessions on the remote path instead of guessing that an
external desktop window exists.

`SHENSI_RUNTIME_MODE=web` maps to
`interaction_surface=remote_canvas` and preserves the current Linux
Xvfb/x11vnc/noVNC path. Only this branch supports `/live-sessions`, the
same-origin token WebSocket, and the QR/JPEG compatibility controls. The legacy
`MEDIACRAWLER_BROWSER_DISPLAY=operator|virtual` alias remains accepted only
when it agrees with the canonical mode. Electron process supervision and
packaging sources exist under `desktop/`; ordinary fixes do not rebuild or
replace the installed application. Signing, distribution and actual acceptance
status are tracked in `docs/PROJECT_STATUS.md` and `docs/desktop/`.

Native macOS acceptance has verified external headed Chrome login, persisted
account binding, same-Profile recheck after a runtime restart, and collection
of public records into five selectable candidates. The collection retest
finished successfully locally with 1,308 public records; backend projection
stopped at the configured five-candidate budget. This does not verify separately
approved platform sends. The current evidence and remaining gates
are maintained in `docs/PROJECT_STATUS.md`.

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

The ready Growth bootstrap selects one authorized concrete workspace. The
browser carries that selection as `X-Workspace-Id` on every downstream Growth
request. Finance exposes the contract-backed cost-estimate collection from the
workspace ledger repository, and ROI exposes the contract-backed cohort
collection from its workspace repository. Expected Growth HTTP and capability
errors preserve their public status/code envelope; only unexpected failures
become `GROWTH_INTERNAL_ERROR`.

Douyin interactive login crosses one private boundary in both modes: Express stores
workspace-scoped account/session/replay records, while the pinned
MediaCrawler sidecar owns raw browser profiles and Playwright in a killable
child process. In `SHENSI_RUNTIME_MODE=web`, login-session creation is
asynchronous across this boundary:
`POST` immediately returns `awaiting_scan` with `loginPage: null`, the sidecar
opens the official Douyin page in the background without holding the global
state lock, and `GET` polling later returns account state plus a fixed-size JPEG
`loginPage` for the compatibility fallback when capture succeeds. If initial
best-effort preparation, a later poll, or semantic refresh cannot capture that JPEG while the browser context is
still alive, it returns the same session with `loginPage: null`, retains the
current QR state and noVNC context, and does not manufacture `login_expired`.
Only a genuinely terminal attempt maps to `login_expired`. A null page means
only that the compatibility frame is currently unavailable, either during
asynchronous startup/preparation or after a poll/refresh capture failure; it does
not prove that navigation completed or that login expired. Terminal failures
expose only the closed login
`failureCode` enum; raw Playwright and selector errors remain private.

In Web `remote_canvas` mode, the primary interaction surface is an authenticated noVNC/RFB client embedded
inside the acquisition login dialog. It calls
`POST /api/v1/acquisition/social-accounts/douyin/login-sessions/{sessionId}/live`;
the backend resolves the workspace-owned upstream session and asks the sidecar
for a random, short-lived, single-use token. noVNC then connects through the
same-origin `/douyin-live/{token}` WebSocket. The gateway forwards only that
opaque token path, and the sidecar consumes the token before bridging binary
WebSocket frames to the per-session loopback x11vnc listener. The underlying
VNC TCP socket is never published. If the browser context is not ready to mint
that token, the public live endpoint preserves the lifecycle as retryable HTTP
`409` `douyin_login_session_not_ready`; the embedded client automatically waits
and mints another one-time token against the same login session/profile.
Reconnect obtains a new token; expiry,
session replacement, cancellation, terminal login, or browser-context cleanup
invalidates outstanding tokens.
After navigation reaches an allowlisted official Douyin page, the sidecar first
creates the display/context and worker VNC handle, then `AccountManager`
registers the context and generation under its lock. Live-token minting is
available from that point. Opening the login panel, activating QR login,
inspecting the DOM, and capturing the fixed viewport are subsequent best-effort
preparation. A
currently visible QR is exposed only as `qrStatus: ready` plus
`qrImageDataUrl`; the other closed QR states are `opening`, `expired`,
`network_error`, and `verification_required`, all without a stale QR image.
`opening` is only an absence-of-evidence startup state. Once a poll has
observed `expired`, `network_error`, or `verification_required`, a later empty
poll cannot regress that evidence back to `opening`; a new explicit QR state,
`ready` with a captured image, or authenticated `active` may advance it.
The user can scan the direct QR or complete supported manual verification
through embedded noVNC/RFB or a backup control. Initial navigation gets at most three attempts
inside the same persistent browser context and 65-second worker command. Each
attempt uses a 10-second timeout; after a failure, the failed page is closed, a
fresh page is created, and the next attempt starts 500 milliseconds later.
Exhaustion returns only
`douyin_login_page_unavailable`. The page-level retry does not restart the
worker or replay comment or private-message commands.
`DELETE` on the workspace-bound login-session resource cancels its sidecar
context and expires the public mapping. The UI uses that path on explicit dialog
close or account-level replacement. RFB reconnect does not cancel the session;
it only remints a token for the same session/profile. Poll and interaction
I/O may already own the serialized browser worker, so cancellation does not
wait for their close path. It first removes the session, invalidates its
generation and unused live tokens, then assigns teardown to the still-running
bootstrap or to one tracked cleanup thread. That owner eventually takes the
per-session I/O lease, closes the context at most once, and deletes the profile;
manager shutdown joins all tracked teardown. The normal UI disposes RFB before
issuing `DELETE`; an already-claimed socket from a non-cooperating client lasts
only until the deferred context close. Poll and interaction I/O otherwise
serialize through a per-session lease and retain generation/CAS authority.
A terminal result closes and flushes its browser context before the matching
generation CAS persists
account authority. Open failure, disconnect, expiry, explicit close, shutdown,
a fresh start, and persistence failure clear unfinished work, leases, and
browser resources without replay. Bootstrap generations make late results
stale, a replacement waits for its predecessor thread to leave the worker, and
disconnect invalidates outstanding preparation before removing the context.
The sidecar does not coalesce opening sessions globally because it has no
tenant authority. The public backend keeps replay scoped to
`(workspace, Idempotency-Key)` and additionally owns one workspace-scoped
opening lease/fence. Different keys or backend instances reuse only the same
unexpired upstream `awaiting_scan` session; terminal, expired, missing, or
cancelled sessions release the workspace slot. The new session, opening slot,
and request replay complete in one repository transaction. Cancellation removes
the matching opening fence before the sidecar disconnect; a failed disconnect
retains the old session for an explicit cancel retry without making it reusable
by a new create request. The frontend
independently enforces a single
in-flight connect, disables replacement while `opening`, retries live-mint
`409` for the same session, and aborts timers, requests, and RFB state on
unmount. The semantic `refresh_qr` interaction uses
one bounded page reload in the same session/profile. When the page reports an
expired QR, it clicks exactly one visible official “点击刷新” control and waits
within the same QR budget; missing or ambiguous controls do not fall back to
canvas coordinates. During that one refresh command, page listeners are scoped
to the command and then removed. Diagnostics retain only bounded aggregates of
phase, hostname, resource type, HTTP status or normalized `net::ERR_*` code;
only official `douyin.com` hosts are retained and every other host becomes
`other`. They never retain URL paths, queries, headers, bodies, cookies, QR
payloads or session identifiers. Failure to rebuild or recognize the official
login UI after refresh without concrete network evidence keeps `qrStatus:
opening` and preserves the session for inspection and normal cancellation;
`network_error` is reserved for a page-level network failure. This path does
not take the exceptional teardown path. A
prepare, poll, or refresh JPEG/DOM capture failure likewise returns
`loginPage: null` and may retain `qrStatus: opening` without erasing QR evidence
or destroying the live context. Only browser/display/VNC failure or an unsafe
non-allowlisted page is terminal. Semantic refresh never replaces the session.
Workspace-scoped
interaction commands also include normalized click, bounded text, allowlisted
key, and bounded scroll, and the text is neither persisted nor replayed. These
commands and the JPEG are fallback controls. In `remote_canvas`, the separate
`#douyin-live-login?sessionId=...` tab is also a backup and embedded noVNC/RFB
is the default. That route first reads the session surface and lazy-loads RFB
only for `remote_canvas`; a bookmarked `external_window` route returns before
loading the noVNC/RFB implementation, never requests `/live-sessions`, and
points back to the external Chrome flow.
Public DTOs expose neither the opaque upstream handle nor raw browser state.
The original acquisition page continues polling the same public login session
after the customer scans the QR code, and binds the returned account only after
the sidecar reports `active` authenticated identity. Login-session `GET` and
interaction `POST` have a 70-second gateway transport timeout to cover the
sidecar's bounded poll or QR refresh; unrelated MediaCrawler requests retain their shorter request budgets. Graceful
sidecar restarts retain encrypted active profiles; login expiry removes only
unconnected login attempts, while connected-account
metadata and profiles survive independently until explicit disconnect or
replacement. During reload, invalid durable account metadata is quarantined;
missing or malformed ephemeral login metadata does not invalidate a connected
account.
After terminal identity capture, the login Context is closed in both modes; Web
mode also closes its per-session display. The persistent profile remains.
Collection, comment, and private-message execution reopen that exact profile
under the bound account and login-state version; neither noVNC nor the fallback
creates a second authority.
After an authenticated state is observed, the sidecar derives the account
handle as `dyacct_<sha256>` from the exact own-profile `sec_uid` and returns a
bounded public nickname; the raw platform identifier never crosses the private
browser boundary. Login-state versions come from one process-safe global
monotonic ledger, not a per-account counter. The backend preserves a private
version high-water across active, risk-paused, and disconnected states, derives
same-account revisions and ETags under the repository lock, and risk-pauses by
an exact account-handle/login-version/revision/ETag compare-and-swap. An older
browser session therefore cannot resurrect a disconnected account, clear a
risk pause, or overwrite a newer reconnect.
The sidecar commits that global ledger, connected-account binding metadata, and
ephemeral login metadata with file and parent-directory `fsync` after an atomic
replace. Persistence failure prevents activation instead of exposing a version
that could disappear after a crash.
For the isolated trial, the only retained browser bind parent is
`.runtime/real-trial/state/mediacrawler/`, with `profile/` and `output/` below
it. The only sidecar secret bind parent is
`.runtime/real-trial/secrets/mediacrawler/`, containing `service_secret`; the
container cannot see MySQL state or the other application secrets. Container
identity and its ownership label derive from the retained runtime path. Stop and
failure cleanup may stop/remove only a container with that exact identity and
label, while leaving the profile, login metadata, crawl output, and secret files
on the host.
Browser placement is an explicit deployment boundary. Ordinary local operator
mode may combine `MEDIACRAWLER_BROWSER_HEADLESS=false` with an installed browser
channel and show a Mac window. The isolated public trial instead keeps
`MEDIACRAWLER_BROWSER_HEADLESS=false`, clears the channel, and runs the bundled
Chromium under Linux Xvfb in the dedicated Colima profile `shensi-trial`.
Its launcher propagates the Colima VM's uppercase/lowercase `HTTP(S)_PROXY` and
`NO_PROXY` environment into the container for build tooling and ordinary HTTP
clients. Chromium connects directly by default and does not infer browser
configuration from those generic variables. Only an explicitly configured,
credential-free `MEDIACRAWLER_BROWSER_PROXY` origin is validated and supplied
to Playwright as its browser proxy.
Docker publishes its private HTTP API only as host
`127.0.0.1:5612`; only the gateway on `5608` enters the Quick Tunnel. Each login
context owns an isolated Xvfb display and an x11vnc listener bound to sidecar
loopback. The public surface is only the authenticated live-token mint plus the
same-origin token WebSocket; VNC TCP, the X display, cookies, security material,
profile, CDP, and browser-debug endpoints remain private. The bounded login
frame and four interaction commands remain available as fallback. A native Mac
process that requests the virtual-display mode fails deployment preflight. A
collection-only production
runtime may set `MEDIACRAWLER_BROWSER_HEADLESS=true` while outreach is disabled.
A real-action runtime requires a headed browser: deployment preflight and both
sides of the browser IPC reject headless action or reconciliation before page
creation. CAPTCHA, slider, login-verification, and platform-warning states are
never solved or bypassed. In the isolated Web trial, login-time verification
remains a human interaction inside the same sidecar context through embedded
noVNC/RFB or backup controls; action-time verification follows the separate
fail-closed/manual-handoff boundary. That Web runtime never falls back to a Mac
window. The embedded view and
backup Shensi tab are clients for the server-owned context; directly opening Douyin in an unrelated
customer browser still cannot transfer its cookie into that context and is not
a login transport.
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

The plan payload uses `executionMode` as the closed runtime discriminator.
Legacy rows without it are `generic` and retain provider-operation plus trusted
model-snapshot readiness. `douyin_mediacrawler` is an explicit Douyin-only
branch with empty provider/operation arrays and `modelSnapshotRef: null` on
both its frozen plan and authoritative run. It can be approved without a
public-search or AI connection, but it cannot enter the generic shard runner;
only the automation policy and `run-now` authority may launch collection.
Manual policy keywords are deterministic input. Model-backed keyword
suggestions remain an optional, separately authorized command.

Frozen intents materialize as one crawler job per workspace, plan, policy
version, and policy-local date. Separate alias tables bind every automation
intent and authoritative acquisition run to that shared job, while the
repository validates them as one authoritative pair. The pair's exact replay
is a no-write no-op; a run or intent reused in another pair fails closed. A new
pair increments the job's private `aliasGeneration`, and terminal candidate
projection is current only when `projectedAliasGeneration` matches it. The
repository records `scheduled` before an idempotent enqueue transition. Node
owns random fenced crawl and terminal-ingestion leases and persists each bounded
normalized record page together with its opaque cursor and unique cursor
history, rejecting cycles and non-null terminal cursors. Frozen creator/comment
flags filter disabled record kinds before persistence. Each stored record also
keeps the exact cursor of the page that produced it, so a terminal null job
cursor cannot erase evidence provenance. Real comment authors are normalized to
a bounded Douyin public profile and an explicit commenter discriminator; root or
empty actor identities are rejected. A private runner hook copies only the
bounded public actor fields from MediaCrawler's real author object before its
general-purpose JSONL privacy transform; an anonymous hash is not treated as a
public profile identity.

While a crawl is running, the sidecar tails only complete physical-LF JSONL
records and publishes immutable nonterminal pages. Node pulls each advertised
page, atomically advances its opaque cursor, and projects available evidence,
candidates, identity aliases, DNC/audit state, a running acquisition-run state,
and candidate-discovered events through the existing domain and plan-run
repositories. A failed live projection does not discard the durable page; the
terminal ingestion lane replays all records as compensation. A committed retry
is a no-op, and a failed transactional projection rolls the whole projection
back. The final page records either `succeeded` or `partial`; partial jobs retain
all previously published records and their bounded failure code.

Terminal ingestion owns one generation-bound random fence and one serialized
in-flight lease renewal. Its heartbeat remains active through domain projection
and sidecar acknowledgement; the worker checks the live lease and alias
generation before projection, before acknowledgement, and after acknowledgement.
A pair added while ingestion is running increments the generation without
clearing the current lease. The owner that observes the mismatch releases the
job back to pending without starting acknowledgement; if the pair arrives during
acknowledgement, the post-ack check and completion transaction prevent the stale
generation from becoming ready. Only current-generation completion records
`projectedAliasGeneration`, `ingestedAt`, and `acknowledgedAt`. The durable
acknowledgement timestamp starts the sidecar's 24-hour page-retention clock and
is safe to replay after a crash. Unknown, legacy, or exception-derived crawler
failures are normalized to closed stable stored/public codes; raw error and
credential text never enters the projection.

The backend and Shensi sidecar adapter form one private versioned runtime
boundary even though the route prefix remains `/internal/v1`. Before issuing a
create request, the worker reads the deterministic sidecar job ID and adopts a
matching existing job. This read-before-create rule lets restart recovery reuse
published pages without repeating an external crawl. For compatibility with
already persisted legacy results, only a terminal `succeeded` or `partial`
descriptor may omit activity; the gateway closes that absence to `completed`, a
null keyword, `headless`, and sequence `1`. Missing activity on `queued`,
`running`, `paused`, `cancelled`, or `failed` remains an invalid response.
Sidecar health proves liveness and pinned upstream provenance, not
adapter/gateway protocol compatibility, so the two processes are deployed and
restarted from the same source revision.

Every runner invocation creates a random owner-only `0700` attempt directory
below its job output root and confines its request, activity, and JSONL reads to
that directory. A resumed manager seeds its record de-duplication set from IDs
in already persisted pages, so neither stale attempt files nor repeated upstream
records can be republished. The same sweep removes the entire job output root,
including every attempt and private upstream capture. Backend retention removes
only unlinked evidence 90 days after ingestion, leaving candidate-linked
evidence, one-way DNC identity, and audit authority intact. Restarts recover
expired running crawl leases and ingestion leases from Node cursors. A crawler
job that is already `paused` after exhausting its retry budget is not an
automatic restart candidate; only an audited, job-scoped explicit requeue may
make it claimable again. A late authoritative run/intent pair replays only this
projection, not the crawl. Fair lane alternation and cross-workspace
claim preference keep queued crawl work from starving ingestion or another
tenant. Browser routes never proxy live sidecar state. The manager publishes
`starting_browser` before consuming the runner and `opening_douyin` only after a
real browser launch; equivalent activity snapshots do not create false progress.
A terminal activity returned by crawl startup is not written by the nonterminal
activity mutation. For a successful or partial crawl, only the advertised
`done` page persists its descriptor, `completed` activity, terminal state, and
crawl-lease release in the same transaction, so no durable running job can
advertise a final page. A paused sidecar status retains the last safe nonterminal
activity, releases its fence through retryable requeue, and is resumed by a later
claim rather than held in an endless poll/renew loop.

MySQL `DATETIME(3)` parameters at this boundary are derived from the same UTC
instant and bound in the database driver's timezone-free date-time form. SQL
comparisons and lease/retention timestamps therefore do not mix ISO timezone
suffixes with MySQL date-time values.

The local visible tab is a separate best-effort observation mirror for the
approved keyword and public video, not a collection authority. It is created
from the crawl browser context without reusing the collector page. Observation
navigation uses at most one unfinished best-effort task outside the collector's
critical await path; a hung task suppresses later mirror navigation without
blocking search or comment collection or creating an unbounded backlog. The
deterministic MediaCrawler request client remains the data authority, and
navigation in that tab cannot fabricate records, evidence, or candidates. The
browser polls the persisted Node crawler-status projection rather than the
sidecar. Its closed public surface contains activity (phase, a null or exact
approved keyword of at most 100 Unicode code points, visible/headless mode, and
monotonic sequence) and
`candidateProjectionState` (`pending`, `ready`, or `failed`); it excludes raw
URLs, profile paths, cookies, headers, selectors, CDP/WebSocket endpoints,
browser identifiers, raw logs, ingestion state, and leases. MySQL hydration,
repository mutation, and public projection each fail closed when a non-null
activity keyword is outside the job's frozen keywords or exceeds that bound.

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

The outreach-batch service is the sole draft persistence owner. Its candidate-
scoped collection read resolves current batch heads by workspace, run, and
candidate with a filter-bound opaque cursor; both acquisition and conversations
use that server query rather than a browser-known batch ID as recovery
authority. It freezes the
authoritative run, policy, account/login, candidate/evidence, model, selected
daily limit, exact message, and canonical hash identities into immutable batch
revisions. Human edits reuse the draft validator and append a revision without
changing source-model provenance. Approval is a human second confirmation, not
execution. Approval, server execution, and desktop execution use independent
strict gates. If any of `DOUYIN_OUTREACH_APPROVALS_ENABLED`,
`DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED`, or
`DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED` is present, all three are required
as exact lowercase `true`/`false` and override the legacy flag. If none is
present, the Web/Trial compatibility adapter maps
`DOUYIN_OUTREACH_ACTIONS_ENABLED` to approval plus server execution and fixes
desktop execution false. Server execution without a constructed MediaCrawler
gateway fails startup. With approval disabled, approval returns
`503 outreach_actions_disabled` before approval, allowance, replay, or action
persistence. In an approval-enabled runtime, one transaction rechecks
account/login, candidate/evidence, DNC, and the remaining account-local-date
allowance; records the comment-specific approval; and writes exactly one comment
action. The separate direct-message command rechecks current batch/account/
candidate/DNC authority and independently writes version-3 direct-message
actions from awaiting or approved batches. Its hash binds the exact target,
edited content, approver, private-message daily limit/ordinal and reviewed
current login version. It has no predecessor and never changes comment approval
or the batch's frozen login. Historical v2 authorization remains receipt-linked.
The batch hash also freezes the policy time zone. Approval ordinals derive from
the approval instant in that zone; claim authority separately counts real
attempts made on the claim instant's local day. Retries consume that day's
allowance, the next local day resets it, and a batch-revision/candidate may have
only one private-message action for its lifetime, regardless of date. Within one
account-local day, the same candidate is also unique across batches; a new batch
may be approved on a later local day without reopening the old revision.
Memory shares a reentrant coordinator with DNC writers. MySQL uses the batch
transaction connection for account and Task 6 final-authority locks, replay,
the action-specific daily allowance, and inserts.

For a legacy queued comment whose batch payload predates the frozen `timeZone`,
MySQL claim first resolves the exact immutable policy version and hash plus the
plan, account, and login binding in the same transaction, then persists the
recovered zone before consuming an attempt. If that authority cannot be proven,
the comment and blocked successor become terminal without consuming another
attempt. Version-2
private messages are never upgraded this way and remain strictly dependent on
an explicit frozen batch time zone.

The acquisition application constructs the legacy outreach-action worker only
when the server-execution gate is enabled and the private MediaCrawler gateway
exists. A configured gateway with server execution false still supports
collection. Desktop work is stored with an explicit desktop target and is never
claimed by that worker. Claims are random-
token leased and monotonically fenced, serialize each account, and reserve
persisted server-time eligibility before the sidecar call. The MySQL worker
pages through the stable ascending `(created_at,id)` claim order, rather than
re-reading one fixed window, so any full window of currently ineligible rows
cannot starve a later eligible action.
The repository enforces at least 60 seconds between account comment actions and
a ten-minute next-eligible reservation for each private-message claim. Memory
and MySQL claim comments plus explicitly authorized v2/v3 direct messages whose
daily ordinal is within its frozen 1–100 limit. V2 requires the same succeeded
predecessor; v3 requires its own exact approval hash and current sender login.
Historical unversioned direct-message rows remain
readable but are not backfilled and are never claimable. The worker then
revalidates the active account/login version, approved
batch and action hashes, candidate/evidence authority, policy binding, and
daily allowance. Only the frozen public target and exact approved action text
cross the private action port. Receipts commit under the fence and stale
completions are rejected. Legacy server uncertainty remains `risk_paused`.
Desktop post-start unavailable, timeout, or ambiguity becomes
`reconciliation_required`; the sweeper requeues only an expired zero-write
desktop claim, while an expired executing/count-one attempt also reconciles.
Pre-journal `douyin_profile_busy` may requeue and explicit risk still pauses.
There is no distributed exactly-once claim. A durable pre-click journal prevents
automatic replay after a possible click. Its temp file is flushed and `fsync`ed,
atomically replaced, and followed by a parent-directory `fsync` before the
executor is called; any barrier failure aborts before the platform write.
Same-device restart recovery validates the original durable fence plus current
installation/binding/login and returns a fresh-process, reconciliation-only
capability over the full immutable read-only action request. It cannot authorize
`started` or platform execution. Crash-recovery and original receipts arbitrate one
first-valid slot: exact replay is stable, changed evidence conflicts, observed
success releases only the exact approved successor, and `action_unavailable`
remains unresolved. Explicit user-requested receipt observations are discovered
by device claim even after local journal cleanup. They use the same read-only
capability and identity/fence validation, but retain separate observation
provenance in the human request's private `desktopDispatch` JSON, never replacing
a committed ambiguous original receipt. The original write count remains one;
only a verified receipt resolves the action, and unresolved observation never
authorizes another send. Account recovery may carry an exact empty
pending set only when the locked database snapshot also has no current or other-
batch queued/executing work; that transaction clears the gate, enables no action,
and records the empty set plus every acknowledged uncertain action. Three consecutive failures, or a
verification/rate-limit/account-
warning/login risk response, atomically pauses the account and all queued work.

The acquisition composition mounts desktop enrollment, registration, binding,
claim, completion, and recovery routes with the shared action-authority resolver.
Memory startup validates the exact bidirectional account/installation/action
references and common coordinator. MySQL installation and action repositories
use the application pool. Desktop-only execution does not require a remote
MediaCrawler gateway. The server rejects locked or unadmitted acquisition
mutations before body parsing; the four exact device-only POST transports
retain device authentication while enrollment and binding retain browser
authentication, CSRF, workspace and capability checks. A non-cacheable authenticated
binding read returns the exact generation, lease, relative ownership and unresolved
action state; it does not renew or mutate the binding. The target-schema upgrade
remains separate integration work.

Desktop Sidecar HTTP uses a distinct strict action envelope with
`canonical_target_public_url` and `request_hash`; the Web/internal executor
request remains compatible with the existing server gateway. The envelope is
validated before profile resolution, leasing or journaling, then projected into
the existing executor. `account-identities/resolve` reloads the stable account
metadata without exposing Profile paths. The exact completed receipt moves to a
sanitized acknowledgement record after central acknowledgement, so an identical
cleanup retry or execute replay after restart cannot dispatch a second write.
Main has private local action/identity/acknowledgement clients and atomic
installation, encrypted credential and per-account recovery stores. Its separate
central API client uses the generated canonical transport DTOs for registration,
claim, completion and recovery, with Main-owned origin/build identity, fixed
authority headers, one bounded HTTP budget and no automatic retry. None exposes
an action execution method through Preload. Main connects these stores to its
two-lane coordinator only after Sidecar readiness and drains it before stopping
the Sidecar. Recovered actions use read-only authority; only an exact central
`released` proof removes an unstarted claim, and a central-accepted pre-journal
busy receipt skips the nonexistent Sidecar acknowledgement. Central-started
actions without a reliable Sidecar journal remain pending reconciliation.
Main uses the same immutable build-manifest digest for its client and Renderer
proxy, including the static development gateway. Existing login IPC Profile keys
are workspace-derived; the coordinator reuses that mapping while central account
lanes remain keyed by social-account ID. `DesktopEnrollmentService` reuses the
coordinator's installation and encrypted credential stores. Preload exposes only
installation info, enrollment, confirmed binding recording, workspace selection,
status reading and one status event. Every invoke validates the exact sender,
top-level frame, local origin and closed payload. Renderer authentication controls
workspace selection; reload/dispose does not own or stop Main execution. Status
events contain only safe states, timestamps, kind, reconciliation count and relative
ownership. The UI retains independent comment/DM approval. An expired binding lease
requires authenticated same-device rebind before recovery; action guards are not
relaxed. The packaged manifest producer and live acceptance remain pending.

Because architecture is part of that canonical manifest, an Apple Silicon build
and an Intel build have different exact digests even when produced from the same
source. Backend exact admission therefore uses one required primary digest and a
bounded list of at most seven additional exact digests. This permits only an
explicit arm64/x64 pair or controlled rolling-version overlap; it does not permit
ranges or wildcards and does not replace installation authentication, workspace
authorization, account binding, approval, or generation fencing.
The sidecar reuses only that account's authenticated profile. Comment-editor
activation is a separate reversible DOM stage: only one visible
`.comment-input-inner-container` containing one exact
`留下你的精彩评论吧` entry may receive one activation click after authority
revalidation. It neither types nor publishes, and missing or ambiguous binding
fails closed without visual or fuzzy fallback. At the Sidecar action boundary,
`ActionJobManager` acquires its in-process keyed action-ID lock first, then its
account-handle lock, and only then the process-safe `ProfileLease`. Receipt
paths and their `.tmp` files are derived only from the action ID, so the first
lock serializes the same action ID even when requests name different accounts.
The second serializes different actions for one account; different action IDs
for different accounts can execute concurrently when their Profiles differ.
For desktop `external_window`, `AccountManager` performs short global-`RLock`
authority reads before handoff and in the validator callback, without holding
that lock across execute/reconcile browser I/O; the LBSM worker owns and closes
the command Context. The Web `remote_canvas` path keeps the legacy
`AccountManager` command lock. The login-state ledger uses an interprocess lock
and a single global monotonic version. Comment editors and semantic submit controls are pinned to concrete ElementHandles
and receive independent random one-use markers. A comment page without a
semantic submit control uses the same exact editor as a guarded unmodified-Enter
dispatch control. A synchronous capture-phase guard requires the same tagged
editor and exact approved content while rechecking the target URL and sender.
Comments require a unique first-party publish receipt. Capture rejection keeps
the precise content/control/sender closed code; receipt ambiguity is reserved
for a platform write that may already have dispatched. The comment
receipt requires the exact approved request text/video, success status, and a
stable returned comment ID. Response text/video/author values must match when
present; omitted optional echo fields are accepted only after the frozen sender
is revalidated following the response. Response parsing waits for body
completion; an unreadable body performs no second dispatch and may succeed only
through the same unique new self-owned DOM receipt proof. Direct messages use
the focused vendored `cv-cat/DouYin_Spider` transport instead of DOM controls.
The adapter authenticates from the existing bound context without exporting
cookies or security material, resolves the canonical `/user/{sec_uid}` target,
requires the returned recipient `sec_uid` to match exactly, and revalidates
account authority before conversation creation and before the one text send. A
UUIDv5 client message ID is deterministically derived from the immutable action
ID. Success returns only a hashed `douyin-im:<sha256>` receipt; raw content,
conversation/ticket IDs, cookies, security material, and raw `sec_uid` stay
private. A post-send exception is ambiguous and is never retried. The pinned
source exposes no public `LICENSE`; the operator states that the author granted
permission, with evidence retained outside Git. DOM/ARIA
controls are primary for comments. Optional
local RapidOCR is constructed only for `DOUYIN_ACTION_VISUAL_LOCATOR=rapidocr`
and may suggest only missing exact comment entry/send controls before a verified DOM
rebind; screenshots and recognized text are not persisted or logged. It never
selects identity, target, editor, content, or receipt. MediaCrawler upstream
remains the collection/browser foundation; action execution is a Shensi
extension, not an upstream-native or official Douyin API capability. Visible
verification detected immediately after initial target navigation permits a
bounded, manual-only wait and full recheck of the same action; a challenge that
appears later fails closed immediately. Current defaults
are 120 seconds for manual verification, 150 seconds for the Node action
deadline, 175 seconds for gateway HTTP, and 170 seconds for browser-action IPC.
The desktop central lease is the 60–330 second action-deadline delta plus 30
seconds (90–360 seconds total); the retained server worker keeps its 180-second
minimum. No solver, verification-token injection,
third-party bypass, alternate action ID, or automatic retry after an uncertain
receipt is allowed. Read-only reconciliation can inspect an existing receipt,
but it cannot send, requeue, or create new authority. Visual MCP stays outside
the encrypted action profile as a development diagnostic; runtime execution is
model-provider neutral.

For comments, a verified success receipt or an ambiguous post-submit receipt
also opens a ten-second, best-effort operator review window before the visible
action context closes. The same profile lease remains held, and this window
only brings the page forward and waits: it does not inspect, edit, click,
reconcile, or establish success.

Long-running acquisition, finance-import, recommendation, and council work is
represented by persisted operations and recovery sweepers. Memory mode is a
development and focused-test implementation; MySQL mode is required for
restart, lease, transaction, and live-runtime evidence.

## Frontend composition

The real `#agents` entry mounts a persistent six-role question panel beside the
report controller, so report refreshes do not replace the question editor.
`FinancialCouncilAgentCenter.ask` resolves either an explicit short-lived
`documentId` for the authenticated actor/workspace or, when absent/null, the
workspace's latest confirmed, verified three-statement package. It calls
`prepareSpecialistSkill` for the selected role before the scoped durable model gateway. The product-owned
Markdown skill is loaded at runtime with normalized, sourced financial facts;
its asset is copied alongside compiled Backend code. All roles support text; CFO voice business
questions share the same method path. Raw Minor data is withheld from the
expression model; numeric fact references are validated and rendered server-side; no new agent framework or company-memory
write is added. Desktop startup greeting uses a separate,
main-frame-only `shensiCfoVoice` bridge and fixed macOS speech command.
Ledger imports, unconfirmed previews and raw uploaded files are not automatic
question-answer material. The explicit “让 AI 读取” operation selects parsed
original cells or PDF/DOCX text through the shared `FinanceDocumentService` owned by the council
module. CSV/XLSX sources preserve physical coordinates and cached-formula status;
the bounded PDF/DOCX worker preserves page/item, paragraph or table-cell positions,
with lossless UTF-16-offset segments for long text. Image-only files require OCR
outside this reader; neither document scripts nor Word fields are executed.
The worker uses deployed package assets, including non-ASCII filesystem paths, and
does not start another knowledge base, model route or verified-statement pipeline. Sources
remain bounded in memory for one hour, and never become verified packages or
ledger entries. Expired/replaced/cleared IDs fail instead of falling back to old
reports. All six roles retain their skills; document reading does not require
complete statements, while formal council runs still require verified three-table
material. See `docs/modules/finance-document-reading.md`.

Financial import forms keep the selected File in page memory across rerenders,
revoke stale previews on file/type changes, and stop submit propagation to the
demo shell. Preview never commits a ledger entry. Main's renderer proxy and the
Backend JSON parser admit larger bodies only for exact POST requests to
`/api/v1/finance/imports/preview` and `/api/v1/finance/documents/inspect`
(7,056,044 bytes each), and
`/api/v1/finance/statement-packages/preview` (21,037,060 bytes). These budgets
cover Base64 for one or three raw 5 MiB files plus 64 KiB JSON metadata; ordinary
request limits and authentication are unchanged. The import services still
enforce decoded size and spreadsheet limits. Statement Base64 uses exact
round-trip validation instead of a repeated-group regex that can exhaust the
stack on a valid multi-MiB file.
The exact document-inspection and CFO-question POST routes have a 130-second
Main upstream budget for the existing bounded model call and repair; other
routes retain ten seconds. Inspection admits an 8 MiB response for the bounded
cell inventory, not an unrestricted response stream. Normal page changes retain
the selected document ID in account/workspace-scoped memory; identity changes
and logout clear it. File handles remain owned by the financial page.

The separate `shensiCfoRealtime` bridge validates current authentication and
finance permission through the local gateway. Main holds encrypted per-actor /
workspace Bailian settings and the bounded public Beijing realtime WebSocket;
the optional provider workspace is not part of its hostname. Read IPC returns
only configuration presence, workspace and check status, never the saved Key.
Explicit Start connects an AudioWorklet PCM input and Web Audio output through
the restricted bridge and freezes the selected document ID for that session.
Each business question rechecks current authentication; the voice provider cannot
choose a different source. Business audio requires the current CFO read-only answer;
full-utterance standalone greetings may use a local conversational reply. A
missing provider tool call is resolved by Main from the actual transcription,
then an acknowledged per-turn instructions update produces the audio readout.
ASR starts one shared business computation in parallel with provider routing,
without opening the audio gate early. Transcript deltas update the same compact
role-avatar bubble; only fully played text enters history.
Barge-in replaces the provider context with confirmed playback history;
no unsupported provider truncate command is sent. Settings and handshake checks
do not request a microphone. Real device/provider acceptance and future signed
release audio permissions: `docs/modules/cfo-conversation.md`.

`frontend/src/app-session.ts` is the authenticated shell controller. Feature
code is grouped under `acquisition/`, `conversations/`, `private-domain/`,
`connections/`, and `growth/`. Growth contains advisor, catalog, finance,
quotes, ROI, agent-center, and council controllers and views. Shared transport types are imported from
`frontend/src/generated/`, which is generated from `contracts/`; new DTOs must
not be hand-written in feature code.

The acquisition runtime composes account/login, automation/run and outreach-
batch controllers inside the single existing `.replica-shell`. The controllers
call only authenticated Node routes with browser CSRF, semantic idempotency and
ETag authority; they fence generations and abort requests/pollers on mode
change, logout and close. Automatic collection is the primary surface, while
the real-mode header action focuses the MediaCrawler plan form without loading
provider or model connections. The generic public-search wizard is a separate
optional enhancement with explicit search-API and tool-calling-model
requirements; authorized public-link import is a collapsed fallback. Private
MediaCrawler handles, cookies, profiles, leases and internal identifiers are not rendered.
For a current run, the dashboard polls only the persisted crawler-status
projection and localizes phase while showing browser mode, keyword, attempt and
update time, and candidate allowance. Each refresh validates crawler status
before its candidate-page request. Live-projected candidates can appear while
the crawler is nonterminal or projection is `pending`; a validated `ready`
snapshot is the ordering boundary for the final candidate-page read. Terminal
`ready` with zero candidates is valid, and a validated terminal status survives
a failed candidate read. That read receives at most three run- and generation-
fenced exponential-backoff retries, then stops. The task read model keeps the
newest authoritative run for truthful status and separately identifies the
newest run with persisted candidate links; stopped zero-result runs therefore do
not erase the last reviewable candidate set. The decoder requires primitive strings before accepting crawler state,
activity phase, browser mode, or projection-state enums. It accepts candidate
pages only with exact page, candidate, and evidence keys; at most 100 items; a
null or nonempty cursor of at most 8,192 Unicode code points; nonempty candidate
ID and status; and display name and excerpt bounds of 200 and 500 code points.
An evidence URL must have an unmodified raw HTTP(S) authority and hostname. Raw
credentials, backslashes, whitespace/control/format characters, malformed
percent escapes, and parser-repaired authority forms fail the whole response;
uppercase schemes and Unicode path/query text remain valid. The pre-status
queued live region is polite once per outstanding run and silent on same-run
rerenders; observing status, clearing the intent, or starting a new run resets
its token. A submitted intent without its first observation, an observed
nonterminal run, or a terminal run whose candidate projection is still
`pending` blocks duplicate submission in both the rendered control and
controller command path. This observation does not alter the existing comment
or direct-message approval authority.
The desktop candidate table and evidence inspector collapse to one-column
cards at the mobile breakpoint. Desktop scrolling belongs to the bounded
`.replica-shell`; mobile returns to document scrolling without horizontal
overflow.

The real-session `#conversations` controller composes the same acquisition
public-evidence and outreach-batch authorities. It first reads the Douyin-
filtered task overview and reuses the Acquisition overview's `candidateRunId`
selection. A stopped zero-result latest run keeps its latest persisted result
run available. The older run is read and checked against its task/plan before
its candidates are loaded. Opaque cursors are followed through all available
candidate pages, with cancellation, duplicate-cursor detection and a 100-page
bound. This covers the overview's latest 20 tasks and each task's selected result
run, not every historical run. It renders these records in a searchable recipient list alongside the independent
private-message composer. Public comments and send records have separate tabs.
`OutreachBatchViewContext.surface` selects comment-only, private-message-only or
receipt-only markup at render time; the old combined frontend module is not
retained behind CSS or post-render DOM filtering. Acquisition uses the
comment-only surface. The private-message preview reads the currently edited
body and selected recipient before explicit approval, while historical batch
selection remains in send records;
it never invents an official platform inbox or two-party message transcript.
For an eligible exact-video candidate it
lists the latest 50 batches by `runId + candidateId`, loads the newest current batch, and
reuses `OutreachBatchController` for exact-text revision, final confirmation,
action polling, and receipts. If the collection is empty, create is limited to
that one candidate. Profile-only evidence remains readable but does not issue a
batch list/create command. Reload repeats overview → candidate → collection GET
→ batch GET, making server authority independent of session selection order.
Run-level failures stay visible as partial-read warnings; reaching the page
bound or a repeated cursor is disclosed as an incomplete read. No local seed is used as
fallback. Route deactivation, logout, or another load aborts/stales the prior
generation. Parent rendering preserves the nested composer subtree so status
polling does not detach focused editors. The Renderer contains no platform-write path. Comments and private
messages have independent confirmation paths; a DM requires no comment receipt
and defaults to a daily limit of 20 (range
1–100), independent of the acquisition candidate default 50 (range 1–200).
Only the separately fenced executor performs the approved platform operation.
In the desktop route, Main claims the action and passes it to the existing local
Sidecar comment or DouyinSpider private-message executor; server execution remains
disabled for daily desktop development.

## Persistence

The backend supports memory and MySQL stores. Core CRM tables and startup DDL
are maintained in `backend/src/mysql-store.ts` and `backend/schema.mysql.sql`.
Domain repositories also own idempotent `CREATE TABLE IF NOT EXISTS` statements
for acquisition, Growth, quote, finance, and council tables. Consequently,
database review must search both the central store and module repositories;
the static SQL file alone is not the complete current schema authority.
The MySQL Growth finance composition runs the financial-ledger, finance-import,
and statement-package schema initializers before mounting their routes. Adding a
repository-owned table without wiring its initializer into that composition is
therefore a startup regression, even when the DDL itself is present and valid.

Credentials are stored as encrypted versions or opaque references. Runtime
keys such as `PROVIDER_CREDENTIAL_KEY`, `AGENT_JOB_ENCRYPTION_KEY`, and domain
master secrets are external configuration and must never enter Git or logs.

## Contract boundary

`contracts/openapi/ai-acquisition.v1.yaml` and
`contracts/openapi/growth-advisor-quote-roi.v1.yaml` are the editable shared
contracts. Backend builders and response-conformance tests guard runtime
parity. `contracts/releases/growth-advisor-quote-roi/1.0.19/` is immutable;
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
