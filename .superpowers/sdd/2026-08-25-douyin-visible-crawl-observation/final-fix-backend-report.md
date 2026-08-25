# Final fix B — backend terminal, restart, and projection safety report

## Scope delivered

- A sidecar `paused` status now records its validated nonterminal activity,
  leaves the active fence through the existing retryable failure path, and
  returns. A later claim therefore starts the same sidecar job again instead
  of polling/renewing it forever.
- `PersistCrawlerPageInput` carries `terminalActivity`. Both repositories
  validate a completed phase with a null keyword, apply it under the existing
  fence in the same final-page transaction, then set terminal crawl state,
  ingestion pending, and clear the lease. The worker deliberately does not
  issue a separate terminal `updateActivity` call.
- MySQL hydration defaults only a missing legacy activity/sentinel. Existing
  activity must be the strict four-field shape and an existing sentinel must
  be boolean; malformed persisted JSON fails closed. Public status validates
  and explicitly projects activity rather than cloning an untrusted object.
- Public crawler status now has the closed
  `candidateProjectionState: pending | ready | failed` projection. It exposes
  neither the observation sentinel nor raw ingestion or lease data.
- Canonical and runtime OpenAPI match, the generated DTO was regenerated from
  the canonical contract, and the drift test now includes crawler status.

## TDD evidence

### RED

Before production changes, this focused command was run:

```sh
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-crawler-job-test.ts \
  src/acquisition-crawler-job-mysql-repository-test.ts \
  src/acquisition-crawler-worker-test.ts \
  src/acquisition-crawler-job-router-test.ts \
  src/acquisition-openapi-test.ts \
  src/acquisition-openapi-response-conformance-test.ts
```

It exited `1` with `77` passing, `11` failing, and one expected MySQL skip.
The failures demonstrated the missing behavior: paused status was polled a
second time, final page activity was not passed/persisted atomically, invalid
terminal activity did not roll back, corrupt MySQL activity/sentinel was
accepted, public status had no readiness field, and the runtime contract
rejected the new field.

### GREEN

After the minimal implementation and generator run, this final focused suite
passed:

```sh
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-crawler-job-test.ts \
  src/acquisition-crawler-job-mysql-repository-test.ts \
  src/acquisition-crawler-worker-test.ts \
  src/acquisition-crawler-job-router-test.ts \
  src/acquisition-openapi-test.ts \
  src/acquisition-openapi-response-conformance-test.ts \
  src/acquisition-openapi-contract-drift-test.ts \
  src/acquisition-mediacrawler-gateway-test.ts
```

Result: `121` passed, `0` failed, `1` expected skip (`MYSQL_TEST_ADMIN_URL`
was not provisioned). This includes Memory/MySQL terminal parity, rollback,
legacy corruption, restart, gateway strictness, public closure, zero-candidate
terminal ingestion, and every readiness transition.

Additional green gates:

```sh
pnpm generate:frontend-contract-types
pnpm --filter ./contracts test
pnpm --filter ./backend build
pnpm check:generated-acquisition-types
git diff --check
```

All passed: contracts `94/94`, backend TypeScript build passed, generated
types were current, and the diff had no whitespace errors.

## Files and test coverage

- `backend/src/acquisition-crawler-job.ts` — validated activity/sentinel,
  terminal activity rule, explicit closed status projection and readiness map.
- `backend/src/acquisition-crawler-job-repository.ts` and
  `backend/src/acquisition-crawler-job-mysql-repository.ts` — terminal
  transaction and strict MySQL legacy hydration.
- `backend/src/acquisition-crawler-worker.ts` — paused requeue and terminal
  activity handoff.
- Crawler repository/worker/router/OpenAPI tests — regression coverage for
  restart, atomic state changes, MySQL parity, malformed legacy payloads, and
  projection closure.
- `contracts/openapi/ai-acquisition.v1.yaml`,
  `backend/src/acquisition-openapi.ts`, and
  `frontend/src/generated/ai-acquisition.ts` — closed public contract and
  generated DTO.

## Self-review and follow-up

- No browser, Douyin service, or external network was contacted; gateway tests
  used local fixture servers only.
- The real MySQL integration test remains an intentional skip without
  `MYSQL_TEST_ADMIN_URL`; fake transaction tests cover the new MySQL paths.
- This brief explicitly excluded interactive frontend code. The generated DTO
  makes `candidateProjectionState` required, while the existing strict
  frontend decoder/controller/view need the separately scoped Fix C update.
  Those concurrent frontend files were deliberately not staged here.
- The parent scope limited this commit to Node, contract/generated, and report
  files. Current documentation should be updated by the follow-on frontend
  fix to describe the derived readiness field without exposing raw ingestion
  state.

## Whole-branch review follow-up — frozen activity keywords

The activity validator now rejects a non-null keyword over 100 Unicode code
points. A shared activity-for-keywords assertion is used when MySQL hydrates
an existing activity, when repositories apply activity, and before
`crawlerStatus()` creates the public projection. A non-null activity keyword
therefore must be one of the job's frozen keywords; null remains valid.

### RED

Tests were added before the code change and run with:

```sh
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-crawler-job-test.ts \
  src/acquisition-crawler-job-mysql-repository-test.ts
```

The command exited `1`: `37` passed, `3` failed, `1` expected MySQL skip.
The failures were the missing over-100-codepoint rejection, MySQL acceptance
of unapproved/overlong existing activity, and `crawlerStatus()` projection of
a tampered unapproved keyword.

### GREEN

The same focused command passed with `40` passed, `0` failed, and `1` expected
MySQL skip. The final broader backend-focused command passed with `111`
passed, `0` failed, and `1` expected MySQL skip:

```sh
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-crawler-job-test.ts \
  src/acquisition-crawler-job-mysql-repository-test.ts \
  src/acquisition-crawler-worker-test.ts \
  src/acquisition-crawler-job-router-test.ts \
  src/acquisition-openapi-test.ts \
  src/acquisition-openapi-response-conformance-test.ts \
  src/acquisition-openapi-contract-drift-test.ts
```

Coverage adds valid frozen/null cases plus unapproved and overlimit cases for
both MySQL hydration and public status. No browser, Douyin, or external
network was used.

## Whole-branch review follow-up — terminal ingestion lifecycle and public errors

### RED

The lifecycle regressions were added first and witnessed with:

```sh
NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 \
  src/acquisition-crawler-job-test.ts \
  src/acquisition-crawler-job-mysql-repository-test.ts \
  src/acquisition-crawler-worker-test.ts
```

It exited `1` with `51` passing, `12` failing, and `1` expected MySQL skip.
The failures covered terminal start activity being persisted outside the final
page transaction, raw credential-bearing worker/ingestion errors, stale and
alias-changed ingestion owners acknowledging the sidecar, absent serialized
heartbeats, alias-generation completion races, mixed run/intent replay, and
raw persisted error-code projection.

### GREEN

The same focused suite now passes after the minimal repository/worker changes:

```sh
NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 \
  src/acquisition-crawler-job-test.ts \
  src/acquisition-crawler-job-mysql-repository-test.ts \
  src/acquisition-crawler-worker-test.ts
```

Result: `66` passed, `0` failed, `1` expected skip
(`MYSQL_TEST_ADMIN_URL` was not provisioned). It includes the added MySQL
swept-fence seam, legacy generation hydration, authoritative run/intent
pairing, no-write exact replay, positive serialized heartbeat, and alias
arrival during acknowledgement.

The broader no-listener backend slice also passed:

```sh
NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 \
  src/acquisition-crawler-job-test.ts \
  src/acquisition-crawler-job-mysql-repository-test.ts \
  src/acquisition-crawler-worker-test.ts \
  src/acquisition-douyin-crawler-ingestion-test.ts \
  src/acquisition-douyin-crawler-ingestion-repository-test.ts \
  src/acquisition-douyin-scheduler-test.ts \
  src/acquisition-douyin-automation-test.ts \
  src/acquisition-douyin-automation-mysql-repository-test.ts
pnpm --filter ./backend build
```

The test slice reported `103` passed, `0` failed, and `4` intentional MySQL
environment skips; the TypeScript build passed.

### Files and behavior

- `backend/src/acquisition-crawler-job.ts` — private alias/projected generation
  fields and fences; status treats a stale projection generation as pending;
  public error codes are closed and the legacy internal partial code maps to a
  stable public code.
- `backend/src/acquisition-crawler-job-repository.ts` and
  `backend/src/acquisition-crawler-job-mysql-repository.ts` — pair-aware alias
  identity, exact replay no-ops, generation-aware completion/defer, serialized
  ingestion renewal, legacy generation/error hydration, and closed write
  boundaries. A new alias never clears a running ingestion lease.
- `backend/src/acquisition-crawler-worker.ts` — terminal start snapshots do
  not use nonterminal activity persistence; the worker heartbeats through
  domain projection and acknowledgement, revalidates generation before and
  after acknowledgement, and persists only generic public failure codes.
- Crawler and ingestion test fixtures now include the private generations and
  cover memory/MySQL parity, stale fencing, authority pairing, exact replay,
  terminal start retry, heartbeat serialization, and credential-redaction
  behavior.

### Self-review and concerns

- An alias added while ingestion is running increments `aliasGeneration` and
  resets the attempt count for that generation, but leaves the current lease
  intact. The current worker sees the changed generation at its next live
  fence, skips acknowledgement, and releases the job back to pending; a race
  after acknowledgement is still stopped by `completeIngestion`'s generation
  check.
- Heartbeats share one in-flight renewal promise, so timer and synchronous
  checks cannot overlap. A failed renewal prevents acknowledgement and a
  swept owner cannot complete.
- MySQL validates an authoritative intent-to-run binding for every pair,
  including exact replay. Deployments that inject this repository without
  first creating those bindings will now fail closed, which is intentional.
- A broad run including `acquisition-crawler-job-router-test.ts` was attempted
  but its fixture listener is denied by this sandbox (`listen EPERM`); all
  non-listener tests in that run passed. No browser, Douyin, external network,
  or real database was contacted. The live-MySQL checks remain skipped without
  `MYSQL_TEST_ADMIN_URL`.
