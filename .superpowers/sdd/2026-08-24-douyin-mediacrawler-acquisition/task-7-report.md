# Task 7 — Immutable outreach batch approval and ordered action outbox

Status: implemented and verified.

## RED

The required focused command was run before implementation:

```bash
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/acquisition-outreach-batch-test.ts \
  src/acquisition-outreach-batch-mysql-repository-test.ts \
  src/acquisition-outreach-batch-router-test.ts
```

All three files failed with the expected `ERR_MODULE_NOT_FOUND` errors. Further
counterexamples were added before their fixes:

- a nested Memory authority transaction timed out with
  `memory_authority_deadlock`;
- the first local MySQL run failed with `ER_TOO_LONG_KEY`, proving the
  utf8mb4 composite daily key could not be deployed;
- the next MySQL run failed with `ER_TRUNCATED_WRONG_VALUE`, proving ISO
  timestamps could not be written directly to `DATETIME(3)`;
- application composition failed because the MySQL pool test double lacked
  the newly required schema `execute` boundary;
- the new exact eight-route contract-drift test exposed missing replay/428
  declarations and output-schema differences;
- lifecycle tests proved approval/pause/resume initially reused stale ETags;
- the final generated-type check correctly rejected stale output after the
  public response-header contract changed.

## GREEN

- Task 6 remains the sole draft generator and performs no persistence. Task 7
  is the sole persistence owner: it freezes run, selected policy and actual
  daily limit, account/login revision, candidates, evidence hashes and private
  authority, model provenance, exact content and hashes into candidate draft
  revision 1 and immutable batch revision 1.
- `PUT` removes/reselects candidates, reuses the Task 6 validator for edits,
  preserves the source model snapshot, recomputes hashes, increments changed
  draft revisions, and appends a new immutable batch revision.
- Approval is the explicit human second confirmation of the exact revision and
  canonical batch hash. Exact idempotent replay succeeds; changed semantics
  conflict. Account/login, DNC, candidate revision, evidence and the actual
  selected policy allowance are rechecked inside the approval transaction.
- Approval stores no external side effect. It atomically creates, per selected
  candidate, sequence-1 `comment/queued` followed by sequence-2
  `direct_message/blocked_by_predecessor`. A failed second insert rolls back
  the approval, replay and all action rows in both Memory and MySQL.
- Memory shares a reentrant transaction coordinator with candidate/DNC
  authority. MySQL serializes the account-local-date allowance, locks the
  account and reuses the batch connection for candidate/evidence/DNC authority,
  approval, replay and outbox writes. Indexed identifiers use ASCII/binary
  semantics and ISO timestamps are explicitly converted for `DATETIME(3)`.
- Revision and lifecycle writes use `If-Match`; approval, rejection, pause and
  resume rotate a hash-chain ETag. Two approvers have one winner. All reads and
  writes are workspace isolated and the mounted routes require authentication,
  the `acquisition.outreach.approve` capability and the application CSRF guard.
- Reject/pause/resume are state-checked and idempotent. Public projections omit
  private evidence text and actor/account handles. Eight routes are wired into
  the application, editable/runtime OpenAPI, exact drift and response
  conformance, and regenerated frontend types.

## Verification

- Final live focused/application command with
  `MYSQL_TEST_ADMIN_SOCKET=/Users/mac/.local/var/mysql-shensi-sales/mysql.sock`:
  47 passed, 0 failed, 0 skipped. It includes repeatable schema setup, restart
  persistence/exact replay, DDL mirror parity and rollback on the second action
  insert.
- `pnpm --filter ./backend test:acquisition`: 1,118 passed, 0 failed, 7
  unrelated environment-gated tests skipped.
- `pnpm check:acquisition-contracts`: passed: contracts 92/92, exact contract
  drift 19/19, security, runtime OpenAPI/conformance 41/41, generated type
  freshness, frontend build/self-test and Baota package 2/2.
- `pnpm build`: passed for contracts, backend TypeScript and frontend. The only
  output advisory is the pre-existing Vite chunk-size warning.
- `pnpm check:context` returned `SHENSI_CONTEXT_OK`; `git diff --check` passed.

## Scope and documentation

The change adds the batch domain/service, Memory/MySQL repositories, secure
router and tests; composes Task 6 and Task 3 authority at the application
boundary; adds four mirrored MySQL tables; publishes and generates the eight
public operations; and adds the approval capability. README, Architecture,
API index, Acquisition module, migration guide and current project status now
describe the real persistence, transaction and no-execution boundary.

## Concerns

Task 7 deliberately does not execute queued actions; Task 8 is the only future
consumer authorized to do so. No live provider or external Douyin action was
called. The local MySQL authority, restart and rollback paths were exercised;
there are no remaining Task 7 blockers.

## Commit

`feat(acquisition): approve immutable outreach batches` (this report is
included in the commit; the exact immutable hash is supplied in the handoff).
