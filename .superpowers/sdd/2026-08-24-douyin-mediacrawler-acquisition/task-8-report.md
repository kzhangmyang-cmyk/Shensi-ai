# Task 8 — Execute approved Douyin outreach with recovery and risk pause

Status: implemented and verified without a real Douyin action or credential.

## RED

The required focused tests were written before their implementation. The first
Python run failed because the action adapter did not exist. The first Node run
failed because the action worker/recovery and repository claim interfaces did
not exist. Subsequent counterexamples exposed and drove these fixes:

- the fake-page late-success case initially timed out before the final receipt
  read;
- a local MySQL run at 179.999 seconds incorrectly admitted a direct message
  because client/`DATETIME` conversion shortened the persisted delay;
- the acquisition aggregate rejected the stale action response-conformance
  fixture after execution fields became required.

## GREEN

- The Shensi-owned sidecar action port centralizes Douyin selectors and page
  state detection, accepts only exact public `https://www.douyin.com/video/*`
  or `/user/*` targets, reuses the durable authenticated profile and login
  version, fills the exact approved content, clicks once, and performs one
  bounded receipt poll including late success.
- Verification, rate-limit, account-warning, login-expiry, missing-control,
  deadline and timeout results use a closed error taxonomy. There is no
  alternate-selector or platform-control bypass. The durable replay wrapper
  stores only a semantic request digest and sanitized receipt; it never stores
  raw text, cookies, account handles, or profile paths.
- Node claims the earliest eligible approved action under a random 64-hex
  lease and monotonic fence, with one in-flight action per account. Persisted
  server time enforces at least 60 seconds between account actions and 180
  seconds from a successful comment receipt to the matching direct message,
  including restart and clock-skew cases.
- Immediately before the sidecar call, the worker revalidates the active
  account/login version, approved batch/action/content hashes, frozen public
  target, candidate revision/profile/evidence hashes, DNC, policy/job/daily-
  budget binding, predecessor receipt and daily allowance. Receipts and
  failures commit only under the current fence; stale completions are rejected
  and expired claims requeue exact replay.
- A comment must have a succeeded receipt before its message is eligible. A
  later message failure preserves the comment receipt. Three consecutive
  failures pause the account and all its work; verification, rate limit,
  account warning and login expiry pause immediately. MySQL commits the action,
  attempt, action-account and social-account risk state in one transaction.
- The acquisition application owns idempotent worker/sweeper start and bounded
  close whenever the private MediaCrawler gateway is configured. Memory and
  MySQL expose the same action projection needed by Task 9 without private
  handles, cookies, leases or browser state.

## Verification

- `uv run --directory services/media-crawler pytest tests/shensi_adapter/test_actions.py -q`:
  10 passed.
- `uv run --directory services/media-crawler pytest tests/shensi_adapter -q`:
  47 passed.
- `MYSQL_TEST_ADMIN_URL=mysql://root@127.0.0.1:33316/mysql pnpm --dir backend test:acquisition-outreach-actions`:
  9 passed, 0 failed, 0 skipped against isolated local MySQL 8.4.11. This
  includes restart persistence, receipt/predecessor timing, fencing, attempts,
  and atomic persisted social-account risk pause.
- Focused gateway/runtime OpenAPI/conformance command: 51 passed, 0 failed.
- `pnpm --filter ./backend test:acquisition`: 1,129 passed, 0 failed, 8 existing
  environment-gated tests skipped.
- `pnpm check:acquisition-contracts`: passed contracts, exact drift, security,
  runtime OpenAPI/conformance, generated-type freshness, frontend build/test,
  and Baota package 2/2.
- `pnpm build`: passed contracts, backend TypeScript and frontend production
  build. The only advisory is the existing Vite chunk-size warning.
- `pnpm check:context` returned `SHENSI_CONTEXT_OK`; `git diff --check` passed.

## Scope and documentation

The change adds the deterministic fake-page executor and durable private
action-job endpoint; Node Memory/MySQL claim, receipt, failure and recovery
authority; gateway/application lifecycle; mirrored MySQL DDL; safe public
action execution fields; editable/runtime OpenAPI and generated frontend type;
and focused/live integration tests. README, Architecture, API index,
Acquisition module, deployment guide, MediaCrawler provenance and current
project status describe the real execution, migration, risk-pause and no-
bypass boundaries.

## Concerns

No real Douyin comment or direct message was made, and no real account
credential was used. The browser behavior is proven only with deterministic
fake pages; real-account acceptance and any production/cutover authorization
remain separate operator-controlled work. Task 9 should consume only the
sanitized action projection delivered here.

## Commit

`feat(acquisition): execute approved Douyin outreach` (this report is included
in the commit; the exact immutable hash is supplied in the handoff).
