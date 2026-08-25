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
