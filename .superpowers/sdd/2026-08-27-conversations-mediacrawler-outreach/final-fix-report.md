# Final Critical / Important fix report

Date: 2026-08-27

Implementation commit: `22b7225`

Scope: default-closed Douyin comment and direct-message path, recovery, runtime gating, canonical evidence selection, frontend approval safety, and current documentation.

No real Douyin comment, direct message, approval, CAPTCHA interaction, or action-enabled runtime was executed while producing this fix.

## Finding resolution

| Finding | Resolution | Safety result |
|---|---|---|
| 1. Real direct message controls and receipts | The adapter starts from the exact frozen `/user/{id}` page, requires one visible and uniquely matched DM entry, one editable Draft/contenteditable control, exact native `press_sequentially` readback, and one send button. Success requires a new stable platform message ID from a self/outgoing message whose exact text was absent from the baseline. Multiple selector candidates are treated as one candidate pool, so two distinct matching controls are ambiguous. A transition to an unbound `/messages` route, missing outgoing proof, or synthetic-only evidence fails closed. | No `evaluate`, clipboard injection, synthetic DM success, selector-priority guessing, or data-e2e-only receipt is accepted. |
| 2. Verification, login, risk and rate-limit detection | Added bounded, allowlisted probes for MediaCrawler-known CAPTCHA roots, visible CAPTCHA/login panels, exact Passport login redirects, risk warnings, and rate-limit states. The target and deadline are revalidated before fill and before the single click. | Verification is manual waiting only. There is no OCR, slider automation, stealth, screenshot solving, or target-authority widening. |
| 3. Canonical targets and evidence selection | Centralized raw-string canonical matchers for exact `https://www.douyin.com/video/{id}` comments and `https://www.douyin.com/user/{id}` DMs. The matchers reject query, fragment, userinfo, default ports, case variants, percent repairs, and parser normalization. Deterministic evidence selection prefers an exact video and uses an exact profile only for inspection/DM authority. Creation, revision, approval, worker revalidation, run projection, and UI eligibility use the same rule. | A profile can never become a comment target, and evidence ordering cannot change authority. |
| 4. Editor and command races | Draft edits no longer rebuild `innerHTML` on each input. Controller commands are single-flight, controls are disabled while busy, and authority snapshots bind revision/approval/content hashes. Conflict reload clears the command lock before publishing the reloaded state. Polling and conflict tests cover native sequential typing, focus preservation, and a deferred save-vs-approve race. | A visible but unsaved draft cannot approve the prior revision, and re-entrant actions cannot be silently dropped. |
| 5. External-write recovery | Semantic action hashes exclude `deadline_at`; stale successes are fence-rejected. The sidecar persists an immutable `started_at`/uncertain journal record before click, preserves it across timeout results, and never retries after a possibly completed click. Expired executions become `risk_paused`, not reclaimable work. A human-confirmed backend/UI reconciliation command is strictly read-only, accepts only the same paused action/login version/account handle, and records only one unique outgoing platform receipt newer than the original start. | Timeout, unavailable, ambiguous receipt, malformed journal, or crash-after-click stays frozen. Reconciliation never submits content or resumes the account/successors. This is not claimed as distributed exactly-once. |
| 6. MySQL stale-login starvation | Claim scanning advances stale-login rows instead of repeatedly skipping the first fixed window. Expired executing actions and the same account's queued/blocked actions are risk-paused consistently with the memory repository. SQL fixture tests cover more than 100 stale rows followed by an eligible row, fencing, and uncertain attempt outcomes. | Stale login rows do not permanently hide later eligible work; the claim path remains account-serialized and fail closed. The guarantee is intentionally limited to the reviewed stale-login case, not every possible queue state. |
| 7. Runtime safety | `trial:publish`/`trial:start` ignore ambient retained enablement and require the one-shot `--enable-outreach-after-empty-audit` flag. Before any action-enabled backend start, an owner-controlled read-only transaction aggregates all `queued`, `blocked_by_predecessor`, and `executing` rows; nonzero or unknown results refuse startup. Effective enablement is the explicit request AND a usable sidecar gateway. Bootstrap is always forced false, six-process status is recomputed, and failed verification tears down newly started processes. | Default remains false. No previous `trial.env` value implicitly authorizes actions, and no action-enabled runtime was started in this work. |
| 8. Minor/UI/docs/import coherence | Frontend accepts the supported flat/nested error envelopes but parses action lists strictly; platform cards and acquisition sections retain scroll ownership; Task 3 CTA literals use semantic variables. The four evidence/flow helper files and their consumers/tests were committed together. README, API index, architecture, deployment, module, project-status and real-trial guidance now describe the current closed rules, including `blocked_by_predecessor`. | The current reading path no longer overclaims an official Douyin API, automatic retry, or implicit runtime enablement. Unrelated model-connection work remains unstaged. |

## TDD evidence

Focused tests were made RED before the corresponding minimal implementation. Review-specific RED cases included:

- two distinct selector candidates each matching one real control (previously the first selector won);
- hidden duplicates and hidden-only fixture fallthrough;
- a no-data-e2e outgoing DM receipt and a mismatched/unbound conversation route;
- malformed/naive immutable journal timestamps;
- timeout completion recorded as ordinary failure instead of uncertain;
- timeout then read-only reconciliation using the original `started_at`;
- a `risk_paused` same-version account unable to reconcile while inactive/disconnected/stale versions remain rejected;
- a conflict reload publishing ready state while the old single-flight command lock was still held;
- mixed/malformed evidence order, changed-deadline replay, stale-success fence, crash-after-click-before-persist, more than 100 stale MySQL rows, and all four runtime gate combinations.

All of those focused suites were GREEN before the aggregate runs below.

## Verification evidence

Working-tree verification (before selective staging):

- `git diff --check`: clean.
- context check: `SHENSI_CONTEXT_OK`.
- backend acquisition suite: 1,262 passed, 11 explicit live-MySQL skips, 0 failed.
- backend outreach action gate: 15 passed, 1 explicit live-MySQL skip.
- sidecar adapter suite: 165 passed.
- frontend self-tests: 57 checked; type checks and production build passed (existing bundle-size warning only).
- runtime tests: 22 passed.
- contracts: 96 passed; generated types check passed.
- backend OpenAPI: 42 passed; contract drift: 19 passed.
- localhost-only Playwright acquisition spec: 3 passed (scroll, integrated flow, conversation recovery); the fixture performs no external writes.

Selective-index verification method:

1. Stage only the acquisition/outreach paths and selected hunks; leave model-connection files and its mixed API/CSS/generated hunks unstaged.
2. Export the exact Git index using `git checkout-index --prefix=/private/tmp/shensi-cached-finalfix.L9f4sG/ -a`.
3. Link the existing local dependency directories into that temporary snapshot; do not install or fetch packages.
4. Run tests and builds from the snapshot with direct local binaries. Loopback-binding tests were granted only local test execution permission; no public listener or external action runtime was started.

Exact-index results:

- backend acquisition suite: 1,258 passed, 11 explicit live-MySQL skips, 0 failed.
- backend TypeScript build: passed.
- sidecar adapter suite: 165 passed.
- frontend: 57 checked; all three type configurations and production build passed.
- runtime: 22 passed.
- published contract: 9 passed; generated acquisition types matched.
- combined backend OpenAPI/response/drift set: 61 passed.
- `git diff --cached --check` and `git diff --check`: clean.

The live-MySQL integration remains an explicit skip because no isolated `MYSQL_TEST_ADMIN_URL` or socket was configured. Repository/SQL fixture tests cover the reviewed query and transition semantics; this report does not represent an unrun live database test as passed.

## Open-source research boundary

- NanmiCoder/MediaCrawler supplied the known CAPTCHA selector observations used for bounded detection.
- MIT-licensed WorldMargin2/DouYinSpark supplied only conservative selector ideas for a chat editor/send control.
- Lozzi1910/Douyin-mcp had no usable license and was observation-only.

No stealth logic, `evaluate`/`execCommand`, clipboard injection, CAPTCHA bypass, or unlicensed implementation was copied.

## Honest residual risk / Task 7 boundary

- The live Douyin DOM has not been exercised in this fix. If the current site routes DM entry to `/messages` without a stable recipient binding, the implementation intentionally returns a closed unavailable/ambiguous error instead of pretending success.
- The operator reconciliation flow can only prove a unique existing outgoing receipt newer than the durable attempt start; it cannot reconstruct a receipt that the platform does not expose. Such actions remain paused for audit and cannot be resent automatically.
- No claim of distributed exactly-once delivery is made. Durable intent, fencing, one-click discipline, uncertain-state freezing, and read-only reconciliation reduce duplicate risk but do not turn an external website into a transactional participant.
- Task 7 still requires the user to inspect the exact final page checkbox and click approval. Codex must not click it, solve verification, or enable an action runtime on the user's behalf.

With those boundaries, the default-closed path is ready to enter Task 7; Task 7 itself is not complete.
