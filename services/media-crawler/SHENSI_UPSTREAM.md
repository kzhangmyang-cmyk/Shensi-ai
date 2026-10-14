# Shensi MediaCrawler provenance

This subtree was imported from [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler.git) at commit `d6f7c5bb906b6dac40ddf343ef9e26438a3de092`.

The upstream `LICENSE` is retained verbatim at [LICENSE](LICENSE). Commercial authorization is held outside Git by the operator.

This repository also records that commercial authorization is held outside Git; no authorization evidence, credentials, or secrets are stored here.

To update the pinned subtree, review the target upstream commit and run from the Shensi repository root:

```bash
git subtree pull --prefix=services/media-crawler https://github.com/NanmiCoder/MediaCrawler.git <approved-commit> --squash
```

Shensi-owned code is isolated in `shensi_adapter/` and `tests/shensi_adapter/`; it provides the private service boundary without modifying upstream source files.

The authenticated direct-message transport vendors only the required modules
from `cv-cat/DouYin_Spider` under
`shensi_adapter/vendor/douyin_spider/`; its exact source commit and focused
scope are recorded in that directory's `UPSTREAM.md`. The pinned repository
currently exposes no `LICENSE`, and its README limits its stated purpose to
learning and technical research; no public open-source license was found. The
operator states that the author granted permission for this integration, with
the authorization evidence retained outside Git. Production dependencies
are declared directly in both `pyproject.toml` and `requirements.txt`:
`curl-cffi`, `ecdsa`, `loguru`, `beautifulsoup4`, and `protobuf>=5.27`. The
protobuf floor matches the checked-in generated message runtime. The production
image's existing
`COPY services/media-crawler/shensi_adapter /app/shensi_adapter` includes the
vendored package, so it needs no separate vendor copy step.

## Shensi browser runtime modes

The adapter's authenticated internal Douyin login endpoints keep browser
profiles, cookies, and security material inside the runtime-configured private
data root. Web deployments use the configured encrypted volume. Desktop mode
uses the absolute `SHENSI_USER_DATA_DIR`, or the ignored repository-local
`.local-data` root by default. The adapter returns an opaque account handle only
to the trusted acquisition backend; public account API responses are
deliberately sanitized and never include browser state, the backend's stable
workspace account key, or a profile path. Login-attempt expiry is separate from
durable connected-account metadata and profile state.

`SHENSI_RUNTIME_MODE=desktop` selects `interaction_surface=external_window` and
injects `LocalBrowserSessionManager` as `AccountManager`'s BrowserState facade.
`AccountManager` retains the API/business session and profile/identity
persistence; the local manager opens a headed Playwright Chrome window on the
user's desktop and exclusively owns the opaque worker and Context. On macOS,
this external-window launch explicitly enables Chromium's sandbox so Chrome is
not started with Playwright's default `--no-sandbox` flag; the Web/Linux remote
launch options remain unchanged. Desktop launch, poll, execute, and reconcile
still enter through `AccountManager`, but
its global `RLock` protects only short state/authority operations and is never
held across the browser I/O. The local manager reports split runtime/auth/task/
diagnostic status. It never starts Xvfb, x11vnc, websockify or noVNC, never
mints a live-session token, and reports no screenshot or QR dependency. The
frontend, including its direct live-login route, returns the external-window
flow before loading noVNC/RFB or calling the live-session API. A stable opaque
key derived by the backend from the authenticated workspace is hashed into the
per-workspace profile directory. Once the local manager detects login, it closes
the login Context; `AccountManager` then persists the identity and passes the
same profile through the existing account resolver to MediaCrawler collection.

`SHENSI_RUNTIME_MODE=web` selects `interaction_surface=remote_canvas` and keeps
the existing remote display implementation. In this mode, login startup opens
the official Douyin page in one persistent Playwright
context on a per-session Xvfb display. x11vnc listens only on a random sidecar
loopback port for that display. Once the page reaches an allowlisted official
Douyin host, the worker returns its context/VNC handle and `AccountManager`
registers the context plus generation under its lock. The internal
`POST /internal/v1/douyin/login-sessions/{session_id}/live-sessions` operation
creates a random, short-lived, single-use token bound to that context generation;
the public gateway may pass `/douyin-live/{token}` WebSocket frames to the
sidecar, which consumes the token before bridging to the loopback VNC socket.
Neither the VNC TCP port nor the X display is returned or published.
Screenshot, DOM, QR, and login-panel discovery are a separate best-effort
prepare operation after registration. A missing frame or unrecognized official
login DOM leaves the session interactive with `login_page=null` and possibly
`qr_status=opening`; it does not tear down the context. Only a browser,
display/VNC, or unsafe-page failure is terminal.
The login-open worker command retains its 65-second deadline. Initial Douyin
navigation makes at most three attempts inside that one command and persistent
context. Each attempt has a 10-second navigation timeout; after a failure the
failed page is closed, a fresh page is created, and the next attempt starts 500
milliseconds later. Exhaustion closes
the failed page and returns the closed
`douyin_login_page_unavailable` code without a raw browser exception. These
page-level retries do not restart the worker and never replay a comment or
private-message command.

Bootstrap work is generation-bound. A replacement waits for its predecessor
thread to exit, disconnect makes any outstanding prepare result stale, and a
stale result cannot overwrite or close the current context. The sidecar does
not wait for serialized prepare, poll, or browser-close I/O before committing a
cancel: it first removes the session and invalidates its generation and unused
live tokens. A live bootstrap then owns its deferred teardown; otherwise one
tracked cleanup thread waits for the per-session/browser command, closes the
context at most once, and removes the profile. Manager shutdown joins both
bootstrap and cleanup work and reports non-shutdown cleanup failures. An
already-claimed WebSocket from a non-cooperating client closes when the deferred
context close reaches it. The sidecar does
not globally reuse an opening session because it has no workspace authority.
The trusted public backend owns both `(workspace, Idempotency-Key)` replay and
a separate workspace opening lease/fence, so concurrent clients and backend
instances can reuse one valid pending upstream session when unload cleanup was
not delivered or another client overlaps. A completed unload DELETE removes
that session, so the next page creates a new one. Browser contexts are never
shared across tenants.

The adapter returns a bounded fixed-size JPEG viewport as `login_page` when
best-effort capture succeeds and otherwise returns `null` without discarding a
registered interactive context. It accepts normalized click, bounded text,
allowlisted key, and bounded scroll interactions as a compatibility fallback.
The compatibility field `qr_image_data_url` is a bounded QR data URL when
best-effort detection succeeds and otherwise `null`; live interaction never
depends on it. The sidecar rejects pages outside the
allowlisted official Douyin hosts. Interaction text is neither persisted nor
replayed. CAPTCHA, slider, verification, and platform warnings are handled only
by the human through the live tab or bounded fallback; the adapter has no solver,
token injection, bypass service, or alternate browser session.
After login, account authority comes only from one exact own-profile
`/user/{sec_uid}` link plus a bounded public nickname. The adapter hashes the
raw `sec_uid` into a `dyacct_<sha256>` handle and never returns or persists the
raw value. A process-safe global ledger assigns monotonically increasing login
versions across accounts and restarts; the backend uses that version to reject
older sessions after reconnect, disconnect, or risk pause. Action execution and
read-only reconciliation re-read the current authenticated identity before
opening a target, and a successful first-party comment-publish response must
identify the same account author.
The terminal login context is closed and flushed before binding, while its
persistent profile is retained and later reopened by MediaCrawler collection,
comment execution, and private-message execution for the bound account/version.

The Web deployment must set both `MEDIACRAWLER_ENCRYPTED_VOLUME` and
`MEDIACRAWLER_PROFILE_ROOT`; startup rejects missing or out-of-volume profiles.
The adapter owns Playwright on one dedicated thread so FastAPI worker threads
never call a browser object directly.

The repository contains the Electron process supervisor, development packaging
and gated signing/notarization tooling described in
`docs/desktop/macos-electron-client.md`. Public-release and native manual-login
acceptance remain separate from the fake-tested source bridge.

The Shensi desktop adapter restores identity from the existing account-key
Profile metadata and accepts a strict canonical target/request-hash envelope.
It converts that envelope into the existing action executor request; the Web
gateway and vendored executors retain their existing contract. Desktop action
capability uses the explicit `SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED` flag,
while Web retains `DOUYIN_OUTREACH_ACTIONS_ENABLED`. Main owns this local
capability; it does not replace central human approval, device binding or task
authority. Completed acknowledgement retains only a sanitized receipt tombstone
for exact retries and prevention of repeat execution. These additions do not
change upstream or vendored code or their license/provenance.

The bounded native macOS smoke has verified a real external headed Chrome
launch, repeated-connect deduplication, session cancellation, and reuse of the
exact same Profile after a Sidecar restart. It did not complete a human QR scan
or manual verification, authenticate an account, or perform a real collection
from that Profile.

The isolated public trial runs this adapter only in Docker inside the dedicated
Colima profile `shensi-trial`. It uses headed bundled Chromium under Linux Xvfb
with an empty browser channel and a dedicated 1 GiB shared-memory mount; the
adapter removes Playwright's `/tmp` shared-memory fallback. It publishes the adapter API only to host
`127.0.0.1:5612`. The authenticated application normally uses noVNC over the
same-origin token WebSocket and retains the bounded login frame plus four
contracted interaction types as fallback. No cookie, browser security material,
browser profile, VNC TCP, X11, CDP, or browser-debug endpoint is published.
The gateway reaches the sidecar only on its private network and only for the
opaque `/douyin-live/{token}` upgrade. Virtual-display
configuration requires Linux plus a local X display
and fails closed in a native Mac process instead of opening a host window. The
trial binds only `.runtime/real-trial/state/mediacrawler/` (whose children are
`profile/` and `output/`) and
`.runtime/real-trial/secrets/mediacrawler/` (whose only secret is
`service_secret`). Its wrapper verifies a runtime-derived ownership label before
stopping/removing the exact container; profile and login state remain on the
host across normal stop.

Private crawl-job endpoints execute the pinned Douyin search API with an
account profile, frozen argument arrays, immutable creator/comment collection
flags, and a bounded deadline. User values are never interpolated into shell
text. Each runner invocation creates a random owner-only `0700` attempt
directory beneath the job output root and confines its request, activity, and
JSONL reads to that attempt, so stale files from an earlier invocation cannot be
emitted. Resumed jobs seed record de-duplication from IDs in already persisted
pages. Closed creator/video/comment records are filtered by the frozen flags and
stored as append-only opaque-cursor pages; reads do not acknowledge them.
Acknowledged terminal pages remain available for 24 hours, after which startup
and periodic retention sweeps remove the complete job root and all attempts.

The visible Douyin tab is a non-authoritative observation mirror. Search and
video navigation uses at most one unfinished best-effort task outside the
collector's critical await path; a hung navigation suppresses later mirror
movement without blocking collection or creating an unbounded task queue.

Private action-job endpoints reuse only the durable authenticated account
profile selected by the trusted backend. Shensi-owned selectors and page-state
detection are centralized in `shensi_adapter/douyin_action_controls.py`. The
comment executor opens the frozen public video URL, waits up to 15 seconds for
one unique allowlisted independent-video Draft.js editor while rechecking page
risk, the exact URL, sender, and the action deadline. When Douyin has not yet
mounted that editor, the adapter may click exactly once on the unique visible,
usable `留下你的精彩评论吧` entry inside the unique
`.comment-input-inner-container`; this activation only mounts the editor and
does not type or publish. Missing or ambiguous activation state fails closed,
without a page-wide, fuzzy, coordinate, OCR, or model fallback. The adapter then
pins and focuses the editor, enters the exact approved text through native
keyboard events, and reads it back exactly. Only after that input does it wait
for and pin one unique usable publish control; the publish control may be
disabled or not yet mounted before the editor contains text. If the current
comment UI has no semantic publish control, the adapter binds the same exact
editor for one unmodified Enter keypress, whose native handler issues the
first-party publish request. A synchronous guard rechecks the exact URL, sender,
editor text, and pinned control immediately before the single dispatch. A
successful comment is bound either to the exact first-party
`/aweme/v1/web/comment/publish` POST request and its successful comment object,
or to a unique new stable-ID DOM item that is explicitly attributable to the
current account; unidentified or ownership-unknown matching text never proves
success. The first-party response must bind the exact frozen request, success
status, and a stable comment ID. Returned text/video/author values must match
when present; omitted optional echo fields require sender revalidation after
the response. The adapter waits for official response-body completion. An
unreadable body never triggers another submit and may succeed only through a
unique new self-owned stable-ID DOM receipt on the bound page. Verification,
rate limiting, account warning, login expiry, missing
controls, ambiguous receipts, and timeout fail closed without alternate bypass
behavior. Durable action replay records store a request hash and sanitized
receipt, never raw message text, cookies, account handles, or browser profile
paths. Crawl and action jobs also take one process-safe lease on the resolved
persistent Chromium profile before starting; setup and thread-start failures
release that lease immediately. A failed action is never automatically
resubmitted. A comment with a verified success receipt or an ambiguous
post-submit receipt keeps its target page in front for ten seconds while the
same profile lease remains held. In the isolated trial the page remains private
inside Xvfb and is not visible on the Mac or public page because the login-only
live token has already been invalidated. That interval performs
no DOM selection, input, or click and never upgrades an ambiguous result to
success.
Pre-submit receipt baselines inspect ordinary comment cards as evidence
candidates and exclude editors only from their DOM tag, content-editable/role
state, or editor descendants; they do not call form-editability APIs on generic
comment containers.

Read-only comment reconciliation observes the page's own completed first-party
`GET /aweme/v1/web/comment/list/` responses before navigating to the frozen video.
It waits up to ten seconds (and never beyond the action deadline) for delayed
comments. The bounded observation accepts only one stable comment ID with exact
video, text, authenticated author and an absolute `create_time` at or after the
original attempt; replies, older comments and conflicting IDs do not qualify.
This uses the response fields already consumed by the vendored MediaCrawler
client/store, not relative visible timestamps or invented DOM ownership fields.
It neither signs/replays list requests nor clicks/types/submits, detaches the
listener on every exit, and logs only a count when no proof was found. A missing
proof stays uncertain and is never an instruction to resend.

The action-job manager executes comments and authorized version-2 direct
messages. It acquires its in-process keyed locks in the fixed order action ID,
then account handle, and only then acquires the process-safe `ProfileLease`.
The action-ID lock protects receipt `.json`/`.tmp` paths derived only from that
ID even when conflicting requests name different accounts; the account lock
serializes different actions on one account, while different action IDs on
different accounts can proceed concurrently when their Profiles differ. In
desktop `external_window`, `AccountManager` performs only short global-`RLock`
authority checks around this handoff and validator callbacks; it does not hold
that lock across browser execution/reconciliation. The LBSM command worker owns
and closes the action Context. Web `remote_canvas` retains the legacy
AccountManager command lock. Direct messages use the focused vendored `cv-cat/DouYin_Spider`
transport rather than page DOM controls. At execution time the adapter reads
the already-bound persistent context's cookies, security storage, and browser
fingerprint without exporting them, authenticates the focused transport, parses
the frozen canonical `/user/{sec_uid}` target, resolves the recipient, and
requires an exact returned `sec_uid` match before creating a conversation. It
revalidates sender/account authority before conversation creation and again
before sending the exact approved text once. The immutable action ID produces a
deterministic UUIDv5 client message ID. Success returns only a hashed
`douyin-im:<sha256>` receipt reference; raw text, conversation/ticket IDs,
cookies, browser security material, and raw `sec_uid` never cross the sidecar
boundary. A known pre-send failure is closed as unavailable, while any exception
after the send begins is ambiguous and is never retried. Node serializes the
account and requires at least 60 seconds between
comments and ten minutes between private messages. It claims a private message
only when version-2 authorization, the frozen 1–100 daily ordinal, and the same-
candidate successful predecessor comment receipt still match. Historical non-
v2 direct-message rows remain readable, are never backfilled, and never reach
this executor.

DOM/ARIA selectors remain the action-control authority. The exact runtime
configuration `DOUYIN_ACTION_VISUAL_LOCATOR=rapidocr` enables the pinned optional
`visual-locator` dependency group (`rapidocr==3.9.2`,
`onnxruntime==1.29.0`); omission defaults to `disabled`, and every other value
fails configuration. Local OCR may suggest only a missing entry/send control,
after which the adapter must rebind the point to the exact allowlisted DOM
control. It cannot select an account, target, recipient, editor, content, or
receipt. Screenshots and recognized text are not persisted or logged. Visual
MCP is development-only diagnostics and no model provider participates in the
action runtime. CAPTCHA, slider, verification, rate-limit, and account-warning
states remain fail-closed; this adapter contains no solver, token injection,
bypass service, or alternate write route. An ordinary operator-controlled local
display may use the bounded documented manual handoff. The isolated trial
exposes no live control surface for action contexts, so a challenge requires stopping the
affected attempt and later starting a supported flow, never falling back to a
Mac browser window.
