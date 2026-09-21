# Douyin Private-Message Agent Design

Date: 2026-08-28
Status: Approved for implementation
Owner: Shensi acquisition

## Objective

Extend the existing controlled Douyin outreach flow so a user can authorize a
private message only after the same candidate's public comment has a persisted
successful receipt. The private message remains editable until that second
explicit confirmation. The browser executor is provider-neutral: deterministic
DOM/ARIA controls remain primary, local OCR is an optional bounded locator, and
an external visual MCP is limited to development-time inspection rather than
being trusted as a production send authority.

## Product flow

1. Collection and candidate review remain unchanged.
2. The existing batch approval confirms and queues public comments only.
3. A candidate's private-message editor stays locked until that candidate's
   comment action is `succeeded` with a non-empty sanitized receipt.
4. The user edits the retained private-message draft, selects a daily
   private-message limit, checks a separate confirmation, and submits a new
   private-message approval command.
5. The server revalidates the batch, account/login version, candidate/evidence,
   DNC state, comment action and receipt, message content, per-day allowance,
   and idempotency authority in one transaction.
6. That transaction creates one authorized `direct_message` action per selected
   eligible candidate. It never executes the browser action in the HTTP request.
7. The existing fenced worker claims authorized private-message actions one at
   a time per account. The sidecar types the exact approved message and clicks
   once. A unique new outgoing platform message ID is required for success.
8. Verification, rate limits, account warnings, identity changes, login expiry,
   ambiguous targets, uncertain clicks, and uncertain receipts remain closed
   failures. They pause rather than retry an external write.

## Authorization model

The existing batch `approvalHash` is comment authorization only. It must no
longer be described as private-message authorization even though the batch
retains a generated private-message draft for later review.

The new command is:

```text
POST /api/v1/acquisition/outreach-batches/{batchId}/direct-messages/approve
```

It requires authentication, `acquisition.outreach.approve`, browser CSRF,
`If-Match`, `Idempotency-Key`, and a strict body:

```json
{
  "batchRevision": 1,
  "batchHash": "sha256:...",
  "commentApprovalHash": "sha256:...",
  "dailyLimit": 20,
  "candidates": [
    { "candidateId": "...", "directMessage": "..." }
  ],
  "confirm": true
}
```

The default `dailyLimit` in the browser is 20 and the server accepts only
integers from 1 through 100. This is a private-message allowance, separate from
the existing acquisition `dailyCandidateLimit` (default 50, range 1 through
200). A created private-message action reserves one daily ordinal permanently;
failed or risk-paused actions do not release that ordinal.

Each newly approved private-message action carries an internal/publicly
readable authorization marker:

- `authorizationVersion: 2`
- `approvedBy` and `approvedAt`
- `directMessageDailyLimit`
- `directMessageDailyOrdinal`
- a stage-specific `approvalHash`

The stage-specific hash binds the batch revision/hash, original comment
approval, candidate, account/login version, exact profile target, exact message
and content hash, predecessor comment action and receipt, daily limit/ordinal,
approver, approval time, and authorization version. Historical direct-message
rows without version 2 remain readable but are never claimable.

The endpoint returns the unchanged current batch with the standard replay
header. The browser then reloads the action list. The immutable action is the
durable approved private-message revision; before approval, edits are local to
the review form and changing an edit clears the confirmation checkbox.

## Repository and scheduling rules

- Memory and MySQL implement one atomic `approveDirectMessages` operation.
- The operation locks the current approved batch and its actions, verifies one
  successful comment predecessor per requested candidate, rejects any existing
  private-message action for that candidate, reserves consecutive daily
  ordinals, inserts all actions, and records the replay or rolls back everything.
- Existing unique `(workspace, account, local date, candidate, kind)` authority
  remains in force.
- Claims accept comments plus only `direct_message` actions whose
  `authorizationVersion` is 2, whose daily ordinal is inside the frozen limit,
  and whose predecessor is still succeeded with the same receipt.
- A single account has at most one executing action. Comment claims retain the
  existing minimum 60-second spacing. A private-message claim reserves a
  conservative 10-minute next-eligible interval before the external call; this
  is a safety interval, not an attempt to evade platform controls.
- The private-message approval endpoint requires the existing overall
  `DOUYIN_OUTREACH_ACTIONS_ENABLED=true` gate. Collection remains independent.

## Worker and sidecar rules

The Node worker revalidates a version-2 private-message authorization separately
from the comment batch approval. It verifies the predecessor action and receipt,
recomputes the direct-message approval hash, and reuses the existing account,
run, policy, candidate, evidence, DNC, target, lease, fence, receipt, and pause
checks.

The MediaCrawler sidecar removes its unconditional private-message rejection
only after the request hash is verified and the protected account profile is
resolved under its profile lease. Its existing private-message executor remains
the action implementation:

- exact canonical `https://www.douyin.com/user/{id}` target;
- exact active account identity and login-state version, re-read without
  navigation after target load/manual verification and before input, submit,
  reconciliation, and receipt proof;
- one visible conversation panel whose canonical public recipient marker
  exactly matches the frozen `/user/{id}` target for editor, submit, and receipt;
- exact message input followed by content readback;
- independently pinned/tagged editor and submit nodes, with a synchronous click
  guard that rechecks exact approved content and their shared recipient panel;
- durable `started` journal before the single send click;
- baseline captured before the click;
- success only for one new, unique, explicitly outgoing message with a stable
  platform ID;
- no automatic retry after an uncertain write;
- read-only reconciliation only.

No CAPTCHA/slider solver, token injection, fingerprint manipulation, hidden
browser mode, or alternate write path is permitted. A visible verification
screen is completed only by the user.

## Visual locator strategy

The executor uses the smallest trusted strategy chain:

```text
DOM/ARIA selectors -> optional local RapidOCR locator -> manual takeover
```

Local OCR is model-provider neutral and is disabled by default. It is enabled
with `DOUYIN_ACTION_VISUAL_LOCATOR=rapidocr` and installed through the pinned
sidecar optional dependency group. OCR may locate only the exact labels
`发私信`, `私信`, and `发送` after deterministic selectors report a missing
control. It may not locate the editor, infer a target, inspect account identity,
or prove a receipt.

An OCR result is accepted only when it is a single bounded high-confidence
candidate inside the viewport. The point is rebound through `elementFromPoint`
to one visible, enabled DOM control whose normalized text and role match the
requested purpose. URL, risk page, identity, content, and deadline checks run
again before input and before send. Screenshots and recognized text are neither
logged nor persisted.

Microsoft Playwright MCP may be used with an isolated development profile for
read-only accessibility/screenshot/locator inspection. It is not connected to
the encrypted action profile and is not part of the production send chain,
because MCP tools include write capabilities and are not a security boundary.
The production action authority therefore remains deterministic Node plus the
private sidecar, independent of OpenAI, DeepSeek, Qwen, Kimi, or any other
language-model provider.

## Frontend behavior

The existing dark black-and-green Shensi visual system is preserved. The
outreach review keeps its current candidate cards, public target links, comment
editor, action status, receipts, and technical-detail disclosure.

After a candidate comment succeeds, its card adds a bounded private-message
review section containing:

- comment success receipt and approval prerequisite;
- exact public profile target;
- editable private-message textarea and 800-character counter;
- daily limit number input, default 20 and range 1 through 100;
- a separate confirmation checkbox;
- `确认并排队真实私信` as the only private-message approval CTA;
- queued/executing/succeeded/failed/risk-paused status and sanitized receipt.

Changing the textarea or daily limit clears confirmation. Candidates without a
successful comment receipt remain visibly locked. Existing private-message
actions are rendered from server authority and cannot be approved again. The
same shared controller/view behavior applies to `#acquisition` and the real
`#conversations` workspace.

Mobbin was requested for layout reference, but its MCP returned a paid-plan
gate in this environment. The implementation therefore uses the supplied
Shensi screenshots and existing CSS/components as the selected visual target;
no color, navigation, typography, or unrelated page redesign is introduced.

## Contract and persistence compatibility

- The existing action kind/status/predecessor fields remain compatible.
- New authorization fields are optional in the public schema so historical
  rows remain decodable; the executor requires them for every new DM claim.
- MySQL adds nullable authorization, approver, approval-time, daily-limit and
  ordinal columns. Existing rows are not backfilled or made executable.
- The OpenAPI YAML, runtime OpenAPI builder, generated frontend types, Memory
  repository, MySQL repository, static SQL snapshots, and response-conformance
  tests move together.

## Verification boundary

All automated tests use fixtures and fake pages. They may verify that exactly
one click would occur, but they must not connect to Douyin, approve a real batch,
or perform a real comment/private-message write. Local and public trial
publishing are separate operator actions after all source gates pass; this
implementation does not publish or enable the live action gate.

Required acceptance evidence includes focused backend tests, optional-live
MySQL tests when configured, sidecar Python tests, frontend self-tests, contract
generation/drift checks, the existing no-write browser fixture, repository-wide
context/test/build gates, and `git diff --check`.
