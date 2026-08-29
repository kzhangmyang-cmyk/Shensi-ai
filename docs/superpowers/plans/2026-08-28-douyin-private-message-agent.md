# Douyin Private-Message Agent Implementation Plan

> Historical execution plan. Current progress authority remains
> `docs/PROJECT_STATUS.md`.

**Goal:** Add a provider-neutral, human-confirmed Douyin private-message action
after a proven successful comment, with a default daily private-message limit
of 20 (configurable 1–100), one-account serialization, deterministic execution,
and optional bounded local OCR fallback.

**Design:**
`docs/superpowers/specs/2026-08-28-douyin-private-message-agent-design.md`

**Architecture:** Reuse the current immutable outreach batch, ordered action
outbox, fenced worker, MediaCrawler profile owner, and receipt reconciliation.
Add a separate idempotent DM approval command that creates version-2 authorized
DM actions only after successful comment receipts. DOM/ARIA remains the primary
browser locator; optional RapidOCR can suggest exact entry/send controls after
missing-control failures and must be rebound to a verified DOM element.

**Global constraints:**

- Preserve every pre-existing dirty-worktree change; never reset, checkout, or
  overwrite a whole file from HEAD.
- Use `apply_patch` for source and documentation edits.
- Follow red/green/refactor for every behavior change.
- Never call a live Douyin action endpoint, click a real approval control, or
  publish/restart the public trial during implementation tests.
- No CAPTCHA/slider bypass, fingerprint modification, token injection, or
  automatic retry after an uncertain write.
- Keep acquisition candidate allowance at its existing default/range; the new
  20 and 1–100 values are private-message-specific.
- Update current README/status/architecture/API/module/deployment docs and the
  sidecar provenance guide before completion.
- Because the worktree already contains overlapping uncommitted user work,
  task checkpoints use exact file lists, focused diffs, task reports, and test
  evidence. Do not create broad commits that would absorb unrelated changes.

---

## Task 1: Define the version-2 direct-message authorization contract

**Files:**

- Modify: `backend/src/acquisition-outreach-batch.ts`
- Modify: `backend/src/acquisition-outreach-batch-service.ts`
- Modify: `backend/src/acquisition-outreach-batch-router.ts`
- Modify: `backend/src/acquisition-outreach-batch-test.ts`
- Modify: `backend/src/acquisition-outreach-batch-router-test.ts`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`
- Modify: `backend/src/acquisition-openapi-response-conformance-test.ts`
- Modify: `contracts/test/openapi.test.mjs`
- Generate: `frontend/src/generated/ai-acquisition.ts`

**Step 1 — RED:** Add tests proving the existing comment approval still creates
only comment actions, the new DM approval rejects comments without a successful
receipt, rejects missing/false confirmation and daily limits 0/101, and accepts
1/20/100 only after exact comment success. Add hash tests proving edits,
predecessor receipt, account/login version, target, daily ordinal, and approver
change the DM approval hash.

**Step 2 — RED:** Add router/OpenAPI tests for the new endpoint, strict request,
headers, capability/CSRF/idempotency/ETag behavior, optional historical action
fields, and response conformance. Run the focused tests and record the expected
failures.

**Step 3 — GREEN:** Add the authorization metadata and canonical DM approval
hash. Implement service validation and the strict router command without
executing an action. Update both OpenAPI authorities and regenerate the frontend
types.

**Step 4 — VERIFY:** Run the focused batch/router/OpenAPI/contract/generated
type tests. Record commands and results in the task report.

## Task 2: Persist, reserve, claim, and revalidate approved DM actions

**Files:**

- Modify: `backend/src/acquisition-outreach-batch-repository.ts`
- Modify: `backend/src/acquisition-outreach-batch-mysql-repository.ts`
- Modify: `backend/src/acquisition-outreach-batch-mysql-repository-test.ts`
- Modify: `backend/src/acquisition-outreach-action-mysql-integration-test.ts`
- Modify: `backend/src/acquisition-outreach-action-worker.ts`
- Modify: `backend/src/acquisition-outreach-action-worker-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/schema.mysql.sql`
- Modify: `backend/goodjob_crm.full.sql`

**Step 1 — RED:** Add Memory and MySQL tests for an atomic DM approval replay,
batch rollback on insert failure, per-day ordinals, 1–100 allowance enforcement,
duplicate-candidate rejection, predecessor receipt locking, and historical DM
rows remaining unclaimable.

**Step 2 — RED:** Add claim/worker tests proving only authorization version 2 is
claimable, predecessor success is required, stale receipt/hash/account/batch
authority fails closed, the DM claim reserves a ten-minute next-eligible time,
and the worker forwards the exact approved DM once.

**Step 3 — GREEN:** Add the repository operation and nullable MySQL columns,
insert version-2 actions atomically, expand the claim query/application checks,
restore kind-neutral worker execution, and branch application authority between
comment approval and DM stage approval.

**Step 4 — VERIFY:** Run the focused Memory, MySQL repository, MySQL integration,
worker, schema and application tests. Live MySQL tests may report documented
skip only when their required local admin configuration is absent.

## Task 3: Enable deterministic sidecar DM execution and bounded local OCR

**Files:**

- Add: `services/media-crawler/shensi_adapter/visual_locator.py`
- Add: `services/media-crawler/tests/shensi_adapter/test_visual_locator.py`
- Modify: `services/media-crawler/shensi_adapter/action_jobs.py`
- Modify: `services/media-crawler/shensi_adapter/browser_state.py`
- Modify: `services/media-crawler/shensi_adapter/douyin_action_controls.py`
- Modify: `services/media-crawler/shensi_adapter/douyin_actions.py`
- Modify: `services/media-crawler/tests/shensi_adapter/test_actions.py`
- Modify: `services/media-crawler/tests/shensi_adapter/test_browser_state.py`
- Modify: `services/media-crawler/tests/shensi_adapter/test_douyin_action_controls.py`
- Modify: `services/media-crawler/pyproject.toml`
- Modify: `services/media-crawler/uv.lock`
- Modify: `services/media-crawler/.env.example`
- Modify: `services/media-crawler/Dockerfile.shensi`

**Step 1 — RED:** Add action-manager tests proving DM now passes the same hash,
profile lease, `started` journal and replay boundary as comments, while the
global action flag remains enforced by the HTTP composition before manager
lookup.

**Step 2 — RED:** Add fake-page DM tests for exact target, exact editor readback,
one click, unique outgoing stable message ID, ambiguous/timeout freeze, and
read-only reconciliation. No test may use a real browser profile or network.

**Step 3 — RED:** Add visual-locator tests for normalized exact Chinese labels,
confidence, viewport/coordinate bounds, image/candidate limits, deadline,
dependency failure, DOM-first behavior, exact DOM rebind, and no OCR fallback
for ambiguity/risk/identity/content/receipt failures.

**Step 4 — GREEN:** Remove only the unconditional DM rejection, add the private
visual locator port and optional pinned RapidOCR adapter, construct it inside
the browser child process, and use it only for missing entry/send controls.
Keep composer and receipt verification DOM-only.

**Step 5 — VERIFY:** Run the focused Python tests and the sidecar aggregate test.
Confirm no screenshot/OCR text is written to action journals or test output.

## Task 4: Build the two-stage Shensi review UI

**Files:**

- Modify: `frontend/src/acquisition/outreach-batch-api.ts`
- Modify: `frontend/src/acquisition/outreach-batch-api.self-test.ts`
- Modify: `frontend/src/acquisition/outreach-batch-controller.ts`
- Modify: `frontend/src/acquisition/outreach-batch-controller.self-test.ts`
- Modify: `frontend/src/acquisition/outreach-batch-view.ts`
- Modify: `frontend/src/acquisition/outreach-batch-view.self-test.ts`
- Modify: `frontend/src/acquisition/runtime.ts`
- Modify: `frontend/src/conversations/real-controller.self-test.ts`
- Modify: `frontend/src/conversations/real-view.self-test.ts`
- Modify: `frontend/src/replica-dashboard.css`
- Modify: `frontend/tests/douyin-mediacrawler-acquisition.spec.ts`
- Modify: `frontend/tests/fixtures/douyin-mediacrawler-http-fixture.ts`

**Visual target:** Supplied Shensi outreach screenshots and the current dark
card system. Mobbin search was attempted but unavailable behind its paid-plan
gate; do not invent a new visual direction.

**Step 1 — RED:** Add API decoder/command tests for the new endpoint and optional
authorization fields. Add controller tests proving comment success unlocks
only that candidate, editing message/limit clears confirmation, default 20 and
1/100 boundaries work, repeated confirmation is fenced/idempotent, and stale
loads cannot overwrite newer actions.

**Step 2 — RED:** Add view tests for the locked, editable, dirty, approving,
queued, succeeded, failed and risk-paused states. Verify separate labels and
confirmation from the existing real-comment approval, 800-character count,
exact profile target, and responsive semantic controls.

**Step 3 — GREEN:** Implement API/controller state and the shared acquisition /
conversations view. Extend existing black/gray/green CSS tokens only; keep body
scrolling and current breakpoints intact.

**Step 4 — GREEN:** Rewrite the no-write browser fixture from the obsolete
auto-DM timeline to comment success followed by a distinct DM confirmation.
The fixture may observe a queued action but never invoke a live sidecar.

**Step 5 — DESIGN QA:** Run the app in the existing project, capture the same
desktop/narrow states as the supplied reference, compare layout, fix P0/P1/P2
issues, and record `design-qa.md` with `final result: passed`. Use the in-app
browser selected for this Codex Desktop task; do not publish.

## Task 5: Synchronize operations, provenance, and current project truth

**Files:**

- Modify: `README.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/modules/acquisition.md`
- Modify: `docs/API_INDEX.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/operations/real-customer-trial.md`
- Modify: `frontend/README.md`
- Modify: `services/media-crawler/SHENSI_UPSTREAM.md`
- Modify: `.env.example`
- Modify: `.env.production.example`
- Modify: `deploy/compose.yaml`
- Modify: `scripts/real-trial-runtime.mjs`
- Modify: `scripts/real-trial-runtime.test.mjs`
- Modify: third-party notice/provenance files discovered by repository search

**Step 1 — RED:** Extend configuration/deployment contract tests for the visual
locator enum, default-disabled OCR, version-2 DM authorization migration, and
the unchanged default action-disabled trial.

**Step 2 — GREEN:** Update runtime examples and current docs in present-tense
language. State clearly that local/public builds use the same source, publishing
is separate, actions default disabled, DM needs successful comment plus a second
human confirmation, OCR is optional/local, visual MCP is diagnostic only, and
no model provider is required for execution.

**Step 3 — VERIFY:** Run documentation/layout/deployment/provenance tests and
search the current reading path for obsolete claims that all private messages
are unavailable. Historical plans may retain background only when clearly
non-authoritative.

## Task 6: Fresh aggregate verification and handoff

**Step 1:** Run `./scripts/context-check`.

**Step 2:** Run the focused backend, sidecar, frontend, contract, generated-type,
deployment, and fixture tests recorded above.

**Step 3:** Run `pnpm test`.

**Step 4:** Run `pnpm build`.

**Step 5:** Run `git diff --check` and inspect the exact final diff/status for
unrelated or secret-bearing changes.

**Step 6:** Perform a final read-only review against the design and current
docs. Do not call a real Douyin action, publish the trial, push, merge, or enable
an action gate as part of automated verification.

