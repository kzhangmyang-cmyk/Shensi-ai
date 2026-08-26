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
