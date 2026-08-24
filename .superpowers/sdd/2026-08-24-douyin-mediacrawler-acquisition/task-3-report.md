# Task 3 report — Douyin automation policy and schedule commands

## Status

Complete. The carried browser-process ownership ruling and Task 3 are both
implemented, documented, committed, and verified. No Growth 1.0.11/1.0.12
release bytes or lockfiles changed.

## Commits

- `82fc2d9` — `fix(acquisition): preserve Douyin browser process ownership`
- `bc784b9` — `feat(acquisition): version Douyin automation policies`

## Carried breaker ruling: RED / GREEN

### RED

Added focused regressions in
`services/media-crawler/tests/shensi_adapter/test_accounts.py` for:

- a child startup handshake that returns the verified owned process-group ID;
- a dead worker whose descendant remains alive in the owned process group;
- `Process.is_alive()` raising, which must be treated as unknown rather than
  proof of death.

The old implementation failed the handshake assertion and did not signal the
stored process group when the worker was already dead or liveness inspection
raised.

### GREEN

`browser_state.py` now performs `setsid()` in the child, verifies
`getpgrp() == getpid()`, returns that PGID in the startup handshake, validates
it against the owned child PID in the parent, and stores it independently of
worker liveness. Every abnormal stop signals the verified group; liveness
inspection failure is unknown; the `Process` descriptor closes only after
explicit death.

Evidence:

- focused account/process tests: 6 passed;
- complete Python adapter suite: 21 passed.

## Task 3: RED / GREEN

### RED

Tests were written before the automation implementation. The focused command
failed because all three automation modules were missing. The contract gate
was 90/91 because GET/PUT automation and POST run-now were unpublished.
Application composition then had a separate RED proving automation was not
mounted without a MediaCrawler gateway. A later self-review regression also
proved plan-derived default keywords could fail on case-only duplicates, and
the contract drift gate proved its loader ignored PUT.

### GREEN

- Focused Task 3 suite: 17/17.
- Application suite including unconditional automation mounting: 29/29 in the
  focused four-file run.
- Exact editable/runtime contract drift: 18/18.
- Complete acquisition suite: 1030 tests, 1028 passed, 2 skipped, 0 failed.
- Complete acquisition contract gate: passed, including 91 contract tests,
  security, drift, response conformance, generated-type check, frontend build
  and tests, and Baota package evaluation.

## Delivered behavior

- Immutable `DouyinAutomationPolicyVersion` rows with a separately mutable
  compare-and-swap head; prior versions are never updated.
- Memory and MySQL repositories with workspace/plan scope, hashed idempotency
  keys, exact replay versus changed-request conflict, account/login binding,
  and durable frozen run intents.
- Server ownership of IDs, revisions, timestamps, ETags, hashes, active
  account/login-state bindings, local date, and daily-budget identity.
- GET returns a non-persisted default only before the first version. PUT
  requires `If-Match` and `Idempotency-Key`. Run-now freezes the approved plan,
  policy, account/login, local date, and daily budget and uses the same durable
  intent shape intended for Task 4 scheduling.
- Automation is always mounted; the Task 2 account router remains conditional
  and is not remounted. Both consume the same workspace-scoped account
  repository. Public DTOs never expose `accountHandle`.
- Closed editable and runtime OpenAPI schemas, failure-code enum, generated
  frontend types, response conformance, and exact PUT-aware contract drift.

## Persistence and files

New runtime modules:

- `backend/src/acquisition-douyin-automation.ts`
- `backend/src/acquisition-douyin-automation-repository.ts`
- `backend/src/acquisition-douyin-automation-mysql-repository.ts`
- `backend/src/acquisition-douyin-automation-service.ts`
- `backend/src/acquisition-douyin-automation-router.ts`

New tests:

- `backend/src/acquisition-douyin-automation-test.ts`
- `backend/src/acquisition-douyin-automation-mysql-repository-test.ts`
- `backend/src/acquisition-douyin-automation-router-test.ts`

Updated composition/authority/schema/contract surfaces:

- `backend/src/acquisition-application.ts`
- `backend/src/acquisition-plan-run-repository.ts`
- `backend/src/acquisition-openapi.ts`
- `backend/src/acquisition-openapi-contract-test-helpers.ts`
- `backend/schema.mysql.sql` and `backend/goodjob_crm.full.sql`
- `contracts/openapi/ai-acquisition.v1.yaml`
- `frontend/src/generated/ai-acquisition.ts`
- associated application, OpenAPI, drift, conformance, and contract tests.

The durable tables are:

- `acquisition_douyin_automation_policy_versions`
- `acquisition_douyin_automation_policy_heads`
- `acquisition_douyin_automation_command_replays`
- `acquisition_douyin_run_intents`

Current-truth documentation was synchronized in `docs/modules/acquisition.md`,
`docs/API_INDEX.md`, `docs/ARCHITECTURE.md`, and `docs/PROJECT_STATUS.md`.

## Final gates

- `uv run --directory services/media-crawler pytest tests/shensi_adapter -q`
  — 21 passed.
- Task 3 focused `tsx --test` command — 17 passed.
- `pnpm --filter ./backend test:acquisition` — 1028 passed, 2 skipped, 0
  failed.
- `pnpm check:acquisition-contracts` — passed.
- `pnpm --dir backend build` — passed.
- `pnpm --filter ./frontend test:types` — passed.
- `pnpm generate:frontend-contract-types` and generated check — passed.
- `git diff --check` — passed before the feature commit.

## Concerns / follow-up

- The MySQL transaction behavior is exercised with a stateful SQL harness,
  including append, CAS, exact replay/conflict, frozen intent, and hashed keys.
  No credentialed live-MySQL crash/restart test was available in this task;
  Task 4 should include its planned real persistence/recovery evidence.
- The frontend production build retains the repository's existing non-failing
  large-chunk warning. It is unrelated to these generated DTO additions.
