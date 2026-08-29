# SDD ledger — plan: docs/superpowers/plans/2026-08-27-conversations-mediacrawler-outreach.md

## Preflight

- Workspace: linked worktree `/Users/mac/Documents/新项目/shensi/.worktrees/douyin-mediacrawler-acquisition`, branch `feature/douyin-mediacrawler-acquisition`.
- Spec: `docs/superpowers/specs/2026-08-27-conversations-mediacrawler-outreach-design.md` is reachable and binding.
- Existing worktree is intentionally dirty with prior acquisition work; each task stages only its named files and must preserve unrelated edits.

### Cross-task interface and file scan

| Tasks | Producer / shared surface | Consumer / expected use | Finding / ruling |
|---|---|---|---|
| 1 → 2 | Repository/service `listByRunCandidate`, stable keyset page | Collection GET, signed cursor, OpenAPI | Clean; Task 2 must preserve Task 1 head-only ordering. |
| 2 → 3 | `OutreachBatchApi.listBatches()` and generated list contract | Conversation candidate recovery | Clean; server query is authority, session storage remains an optimization. |
| 2 ↔ 5 | Both modify `backend/src/acquisition-application.ts` | Route wiring and action-timeout wiring | Clean if Task 5 builds on Task 2 rather than replacing application dependencies. |
| 3 → 6 | Conversation controller/view approval flow | Browser fixture and E2E | Clean; Task 6 tests the public behavior without duplicating controller logic. |
| 4 → 5 | `detect_page_failure`, action controls, closed error codes; shared `douyin_actions.py`, gateway and worker files/tests | Bounded manual verification and timeout propagation | Clean dependency; Task 5 must retain Task 4 exact-target, exact-text and single-click checks after verification. |
| 4/5 → 6 | Sidecar behavior and receipt states | Docs and no-external-write E2E | Clean; E2E uses an HTTP fixture and does not claim to exercise live Douyin DOM. |
| 1–6 → 7 | Same Git revision, database and action authority | Trial publish and one user-confirmed live comment | Clean; Task 7 cannot begin until automatic verification is green. |

### Per-task consistency scan

| Task | Test/code/file agreement | Finding / ruling |
|---|---|---|
| 1 | In-memory + MySQL tests cover repository/service, DDL mirrors and indexes. | Clean. |
| 2 | Router/OpenAPI/client tests cover collection GET. | Conflict: spec says limit `1..50`; plan Step 1 says `1..100`. **Ruling: implement `1..50`** — the approved spec is binding; if wrong, clients requesting 51–100 will receive validation errors and need a later contract revision. |
| 3 | Store, eligibility, controller/view tests match composed approval UI. | Clean; exact video evidence remains the only enabled CTA. |
| 4 | RED/GREEN tests match real-structure control adapter and receipt proof. | File-list mismatch: Step 4 and commit include Python schema, Node gateway/worker and tests although the opening file list omits them. **Ruling: include those explicitly staged files in Task 4** — closed error-code propagation is required by the spec; if wrong, Task 4 diff is wider than the header list but still within its stated behavior. |
| 5 | Tests cover visible manual verification, no bypass and timeout propagation. | Potential wording tension with spec's controlled recovery. **Ruling: the bounded, same action-ID in-call re-probe is the controlled recovery for verification completed within the visible window; timeout remains `risk_paused` and never auto-reclaims** — if wrong, a separate operator resume endpoint will be required for post-timeout recovery. |
| 5 | The plan says to modify `test_browser_state.py`, but that file does not exist; browser-state coverage currently lives partly in `test_accounts.py`. | **Ruling: create `tests/shensi_adapter/test_browser_state.py` for the new timeout/recovery behavior and retain existing `test_accounts.py` coverage** — if wrong, the new test file adds a small dedicated test surface that could instead have lived in the older account test module. |
| 6 | Fixture/E2E/docs cover the integrated flow. | Fixture receipt timing is underspecified. **Ruling: fixture comment and DM receipts must preserve comment-first and at least 180-second ordering even though no sidecar is called** — if wrong, UI tests could pass while presenting an impossible action sequence. |
| 7 | Publish steps stop before approval and require user page confirmation. | Clean; Codex will not click final approval or solve platform verification. |

## Progress

- Baseline: backend outreach batch tests 17 passed / 1 declared MySQL skip; conversation controller/view self-tests passed after local IPC permission; MediaCrawler action/account tests 34 passed after correcting the planned new browser-state test filename.

- Task 1: fix round 1/5 (2 addressed, 0 open — canonical UTC anchor; isolated live-MySQL cross-page coverage; commits `30ef5ba..f5f0a20`)
- Task 1: complete (commits `1aef6fb..f5f0a20`, review clean)
- Task 2: fix round 1/5 (2 addressed, 0 open — closed recursive client shape; explicit capability 403 contract; commits `e97eda0..91a8770`)
- Task 2: complete (commits `f5f0a20..91a8770`, review clean; spec max-limit ruling applied as 50)
- Task 3: in progress (base `91a8770`, implementer `/root/task3_conversations_workspace`)
- Task 3: minor (deferred): new conversation CTA CSS uses two literal dark colors instead of existing theme variables; final whole-branch review must triage before finish.
- Task 3: fix round 1/5 (1 addressed, 0 open — stale/wrong outreach recovery hidden and rejected; commits `ca362f9..9a77b0b`)
- Task 3: complete (commits `91a8770..9a77b0b`, review clean except 1 deferred Minor)
- Task 4: in progress (base `9a77b0b`, implementer `/root/task4_douyin_action_controls`; schema/gateway/worker scope ruling applied)
- Task 4: Ruling: propagate the three closed action failure codes through runtime OpenAPI, published YAML, generated frontend types, and their contract tests because action receipts publicly expose this enum — this widens Task 4 beyond its header list; if wrong, the diff includes contract synchronization that could have been deferred to Task 6.
- Task 4: Ruling: the brief's `test_app.py` command points to a nonexistent file; use the existing `test_contracts.py` plus focused/all sidecar tests — if wrong, coverage lives under a different filename but exercises the same public schema boundary.
- Task 4: fix round 1/5 (6 addressed, 0 open — new receipt identity, strict receipt/editor checks, raw control uniqueness, typed IPC, final URL revalidation; commits `1ca8701..29bb3ff`)
- Task 4: complete (commits `9a77b0b..29bb3ff`, review clean)
- Task 5: in progress (base `29bb3ff`, implementer `/root/task5_manual_verification`; bounded in-call recovery + new browser-state test rulings applied)
- Task 5: Ruling: production claim lease minimum is `manual verification + 60s` (`action deadline + 30s`, equivalently browser action IPC budget + 10s) so the five-second recovery sweeper cannot reclaim an active handoff; unsafe explicit leases fail construction — if wrong, long-lived claims recover roughly 150s later than the old default after a hard process loss.
- Task 5: fix round 1/5 (2 addressed, 0 open — 180-second claim fencing/fence-loss handling; final pre-fill and pre-submit page-state gates; commits `6498413..8c03e94`)
- Task 5: complete (commits `29bb3ff..8c03e94`, independent review clean)
- Task 6: fix round 1/5 (4 addressed, 0 open — stale-412 reconfirmation, complete request-attempt ledger, gated architecture truth, recovered revision proof; commits `6ad20cf..ca74d1c`)
- Task 6: complete (commits `8c03e94..ca74d1c`, independent review clean; no external platform write)
- Integration: desktop Chrome scroll-owner reconciliation complete (`cc7904a`; 3/3 Playwright scenarios on working tree and exact index snapshot; independent review clean; no documentation change required).
- Final Critical/Important fix: complete (`22b7225`; report `.superpowers/sdd/2026-08-27-conversations-mediacrawler-outreach/final-fix-report.md`). All eight final-review groups are resolved to a fail-closed Task 7 boundary: unique native DM controls/outgoing receipts; bounded manual verification probes; central raw canonical targets and deterministic evidence; editor/single-flight authority; durable uncertain-write fencing plus operator-confirmed read-only reconciliation; stale-login MySQL window progress; one-shot two-gate runtime authorization with global read-only queue audit; and current UI/error/docs/import coherence. No external write or action-enabled runtime was executed.
- Final fix verification: working tree backend 1,262 pass / 11 explicit live-MySQL skips; sidecar 165 pass; frontend 57 + types/build; runtime 22; contracts 96 + generated check; OpenAPI 42; drift 19; localhost Playwright 3; context check and diff checks clean. Exact selective-index snapshot (`git checkout-index` into `/private/tmp`, local dependencies only) independently passed backend 1,258 / 11 explicit live-MySQL skips, backend build, sidecar 165, frontend 57 + three type configs/build, runtime 22, contract 9 + generated check, combined backend OpenAPI/response/drift 61, and cached diff check. Unrelated model-connection changes remain outside `22b7225`.
- Final re-review follow-up: two publish blockers were reproduced RED and fixed. MySQL claim scanning now advances through the complete ordered keyset instead of only repeating the first 100 rows when non-stale ineligible work fills the window; partial-start and bootstrap cleanup now use the owned process-group signaler in production so bounded `SIGKILL` cannot orphan the wrapped service. Focused repository tests passed 10 with 3 explicit live-MySQL skips, runtime passed 23, the complete acquisition suite passed 1,263 with 11 explicit skips, backend build/context/diff checks passed, and an exact staged snapshot independently passed the focused repository/runtime/build checks. No external action or action-enabled runtime was executed.
- Final fix residual ruling: live Douyin DOM and live MySQL were not available in this repair pass. Unbound `/messages` DM routing, unprovable outgoing receipts, malformed/missing journals, and every uncertain external write remain closed/risk-paused; no distributed exactly-once claim is made. Task 7 still requires the user's visible checkbox-and-click approval, and Codex must not perform it.
- Task 7: pending
- Task 7 preparation: MySQL 8.4 candidate-scoped reads now use a repository-
  validated bounded literal `LIMIT`; initially empty action pages continue a
  bounded receipt poll; the approval workspace displays account, public target,
  exact text, limits, dirty state, localized status/failure, and an explicit
  real-comment confirmation. Unknown router failures emit redacted request-
  scoped diagnostics. Focused backend, frontend, sidecar, contract, type, and
  build gates pass without any external Douyin write.
- Task 7 preparation Ruling: expose the frozen `publicProfileUrl` and
  `commentTargetPublicUrl` in the public batch DTO and bind both into the batch
  hash, while continuing to remove private `publicActorKey` and `evidenceText`.
  The page reviews the same public targets that approval authorizes instead of
  reconstructing them from a potentially newer candidate feed. If wrong, this
  widens the public batch contract by two already-public URLs and requires
  contract consumers to update, but avoids authorizing a stale or hidden target.
- Task 7 preparation Ruling: final confirmation requires exact frozen video and
  profile targets plus a currently active account whose ID and
  `loginStateVersion` match the batch; missing context or any mismatch disables
  confirmation. If wrong, a delayed account-context refresh can temporarily
  block a valid approval and the operator must refresh, rather than risk using a
  different login session.
- Task 7 preparation Ruling: a deterministic comment failure closes only its
  direct-message successor as `predecessor_failed`. If wrong, a platform result
  later proved successful would require a separate audited operator recovery,
  but no failed comment can strand or release a private message silently.
- Task 7 preparation Ruling: malformed claimed-success receipts, post-submit
  exceptions, and all other uncertain write outcomes are ambiguous and
  `risk_paused`, never converted into a deterministic rejection or automatic
  retry. If wrong, operators must perform read-only reconciliation for more
  cases, but the system never converts unknown delivery into duplicate writes.
- Task 7 preparation Ruling: read-only reconciliation may prove only the frozen
  action and does not automatically resume the account or its successor; an
  explicit audited recovery entry remains a follow-up gap. If wrong, a proven
  comment can remain operationally paused until that entry exists, but
  reconciliation cannot silently authorize the next external write.
- Task 7 preparation Ruling: action polling may wait through at most 20 empty
  pages (about 60 seconds at the production interval) after approval. If wrong,
  exceptionally delayed outbox visibility requires a manual refresh, while an
  unbounded browser poll is still avoided.
- Task 7 preparation Ruling: every load or manual refresh advances a polling
  epoch; responses and timers from an older epoch are ignored. If wrong, a slow
  stale request may require another refresh to observe its result, while it
  cannot overwrite newer authority or create a competing poll chain.
- Task 7 preparation Ruling: live-page candidates are review-only until the
  crawler is `succeeded` or `partial`, terminal ingestion is `succeeded`, and
  the projected alias generation equals the current generation. Creation and
  final approval both recheck this boundary; MySQL approval locks it inside the
  action-insert transaction. If wrong, an operator must wait for final
  projection and regenerate a batch whose same-actor evidence changed, rather
  than risk approving a draft against evidence that a later page can mutate.
- Task 7 preparation: `outreach_candidate_projection_pending` keeps a reviewed
  batch unchanged and queues no action; the frontend presents it as a Chinese
  waiting state rather than an ETag conflict. Paused, cancelled, failed, or
  ingestion-failed crawls return
  `outreach_candidate_projection_unavailable` and require a new run.
- Task 7 preparation Ruling: current final approval creates exactly one queued
  `comment` action per selected candidate and never creates the formerly
  predecessor-blocked `direct_message` successor. The batch and action schemas
  continue to read historical direct-message data, while the frontend keeps the
  retained draft read-only and explicitly states that private messaging is
  unavailable for this batch. If wrong, private messaging requires a later
  explicitly authorized interface revision and live DOM/receipt evidence rather
  than silently inheriting the comment approval.
- Task 7 preparation Ruling: historical nonterminal `direct_message` rows are
  readable audit data only. Memory and MySQL claims accept `comment` rows only;
  the worker rejects a hostile claimed direct message before authority lookup,
  and the sidecar persists `douyin_direct_message_unavailable` before profile
  resolution or browser execution. The frontend labels these rows as historical,
  read-only, and disabled. If wrong, a future private-message release must remove
  all three independent gates under a new authorization and receipt contract;
  no existing historical row can become executable by changing one flag.
- Task 7 preparation Ruling: a QR scan becomes account authority only after the
  browser proves one exact own-profile identity and a real nickname. The
  sidecar exports `dyacct_<sha256>` instead of raw `sec_uid` and assigns every
  successful connection a globally monotonic login-state version. The backend
  retains a private durable version high-water across active, risk-paused, and
  disconnected states; same-account revision/ETag changes are derived under the
  repository lock, and risk pause is an exact identity CAS. If wrong, an
  operator may need a fresh QR session, while an old session can never revive
  or overwrite newer authority.
- Task 7 preparation Ruling: comment execution and read-only reconciliation
  re-prove the current authenticated account before target navigation. A
  successful official comment-publish response must bind the exact frozen
  aweme, exact text, stable comment ID, and the same account author; any mismatch
  becomes `douyin_account_identity_changed` and pauses related work without a
  second click.
