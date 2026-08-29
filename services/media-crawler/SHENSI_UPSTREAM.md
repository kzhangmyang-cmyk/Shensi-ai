# Shensi MediaCrawler provenance

This subtree was imported from [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler.git) at commit `d6f7c5bb906b6dac40ddf343ef9e26438a3de092`.

The upstream `LICENSE` is retained verbatim at [LICENSE](LICENSE). Commercial authorization is held outside Git by the operator.

This repository also records that commercial authorization is held outside Git; no authorization evidence, credentials, or secrets are stored here.

To update the pinned subtree, review the target upstream commit and run from the Shensi repository root:

```bash
git subtree pull --prefix=services/media-crawler https://github.com/NanmiCoder/MediaCrawler.git <approved-commit> --squash
```

Shensi-owned code is isolated in `shensi_adapter/` and `tests/shensi_adapter/`; it provides the private service boundary without modifying upstream source files.

The adapter's authenticated internal Douyin QR endpoints keep browser profiles
and cookies inside the configured encrypted deployment volume.  They return an
opaque account handle only to the trusted acquisition backend; public account
API responses are deliberately sanitized and never include browser state. QR
attempt expiry is separate from the durable connected-account metadata and
profile, which survive restart until explicit disconnect or replacement.
After login, account authority comes only from one exact own-profile
`/user/{sec_uid}` link plus a bounded public nickname. The adapter hashes the
raw `sec_uid` into a `dyacct_<sha256>` handle and never returns or persists the
raw value. A process-safe global ledger assigns monotonically increasing login
versions across accounts and restarts; the backend uses that version to reject
older sessions after reconnect, disconnect, or risk pause. Action execution and
read-only reconciliation re-read the current authenticated identity before
opening a target, and a successful first-party comment-publish response must
identify the same account author.

The deployment must set both `MEDIACRAWLER_ENCRYPTED_VOLUME` and
`MEDIACRAWLER_PROFILE_ROOT`; startup rejects missing or out-of-volume profiles.
The adapter owns Playwright on one dedicated thread so FastAPI worker threads
never call a browser object directly.

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
disabled or not yet mounted before the editor contains text. A synchronous
guard rechecks the exact URL, sender,
editor text, and pinned control immediately before the single click. A
successful comment is bound either to the exact first-party
`/aweme/v1/web/comment/publish` POST request and its successful comment object,
or to a unique new stable-ID DOM item that is explicitly attributable to the
current account; unidentified or ownership-unknown matching text never proves
success. Verification, rate limiting, account warning, login expiry, missing
controls, ambiguous receipts, and timeout fail closed without alternate bypass
behavior. Durable action replay records store a request hash and sanitized
receipt, never raw message text, cookies, account handles, or browser profile
paths. Crawl and action jobs also take one process-safe lease on the resolved
persistent Chromium profile before starting; setup and thread-start failures
release that lease immediately. A failed action is never automatically
resubmitted. A comment with a verified success receipt or an ambiguous
post-submit receipt keeps its target page in front for ten seconds while the
same profile lease remains held. That review window performs no DOM selection,
input, or click and never upgrades an ambiguous result to success.

The action-job manager executes comments and authorized version-2 direct
messages. A direct-message action opens only its frozen public profile, binds
the allowlisted editor and submit control to the nearest visible conversation
panel with one canonical public marker for that exact candidate, enters the
exact approved text, and clicks once. Editor and submit are independently
pinned/tagged; the synchronous guard rechecks exact content and their shared
exact-recipient panel at dispatch. Guard rejection preserves the precise
content/control/sender/recipient closed code; receipt ambiguity is reserved for
a browser click failure that may already have dispatched. The frozen sender is
re-read from current
account chrome without navigation after target load/manual verification and
before input, submit, and receipt proof. Success requires one new unique
outgoing stable platform message ID inside the same exact-recipient panel;
matching text, an existing message, a switched sender/recipient, or an
identity-ambiguous conversation does not prove success. Node serializes the
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
states remain manual-only/fail-closed; this adapter contains no solver, token
injection, bypass service, or alternate write route.
