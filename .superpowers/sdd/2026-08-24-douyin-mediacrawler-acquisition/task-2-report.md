# Task 2 report — QR login and workspace-scoped Douyin accounts

## Implementation

- Added a private MediaCrawler account manager and browser-state boundary. QR
  sessions use random opaque identifiers, service-owned profile directories
  (`0700`), expiry cleanup, and only pass a QR data URL / safe state onward.
- Extended the internal gateway with strict create/poll login-session parsing.
- Added workspace-scoped account domain, in-memory and MySQL repositories,
  account service, and four-route Express router. The public DTO strips the
  private opaque account handle and rejects cookie/profile/browser/secret
  fields.
- Mounted the router from the acquisition application when its trusted
  MediaCrawler gateway is configured; server-level acquisition authentication
  supplies the CSRF protection for mutation routes.
- Added both schema snapshots, editable OpenAPI paths, runtime OpenAPI paths,
  route inventory assertions, response conformance coverage, regenerated
  frontend types, and the MediaCrawler boundary documentation.

## TDD evidence

RED (before implementation):

```text
pytest: ModuleNotFoundError: No module named 'shensi_adapter.accounts'
node: ERR_MODULE_NOT_FOUND acquisition-social-account-repository.js
node: ERR_MODULE_NOT_FOUND acquisition-social-account-router.js
```

GREEN:

```text
uv run --directory services/media-crawler pytest tests/shensi_adapter/test_accounts.py -q
1 passed

pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/acquisition-social-account-test.ts \
  src/acquisition-social-account-mysql-repository-test.ts \
  src/acquisition-social-account-router-test.ts
4 passed
```

## Verification

- `pnpm --filter ./contracts test`: 91 passed.
- `pnpm check:acquisition-contracts`: completed successfully, including
  contract drift, security, acquisition OpenAPI, generated types, frontend
  build/tests, and Baota package checks.
- `pnpm --dir backend run build`: passed.
- `git diff --check`: passed.
- `pnpm --dir backend run test:acquisition` started once but hung in the
  existing serial `acquisition-application-test.ts` process after its emitted
  application tests; it was terminated after roughly 160 seconds. Focused,
  contract, build, and package gates passed independently.

## Self-review

- Public account/login schemas are closed and do not contain `accountHandle`,
  cookies, profile/browser paths, service URL, or secrets.
- Every account repository lookup/bind/disconnect is workspace-bound; one
  `(workspace_id, platform)` record is enforced in the MySQL DDL.
- Polling an active internal session atomically reuses/replaces the workspace
  record and exact active-session replay returns the sanitized existing view.
- Immutable Growth releases and unrelated lockfiles were not touched.

## Concerns

The real browser adapter remains an injected private deployment seam; this is
intentional because the pinned upstream login implementation is asynchronous
and licensed separately. Operators must provide the encrypted deployment
volume and the browser adapter implementation at deployment time.

## Fix round 1/5

RED evidence: the added different-active-handle test failed with `Missing
expected rejection`; the router integration test initially returned `412`
instead of the required cross-workspace `404`; and the contract gate initially
failed its security check because workspace resolution was placed before
authentication (`expected 401, got 503`).

GREEN evidence: account binding now uses an atomic repository transaction and
returns `douyin_active_account_conflict`; router integration passes workspace
isolation, POST replay (`200`, `Idempotency-Replayed: true`), and stale delete
(`412`); `pnpm --dir backend run test:security` passes; `pnpm --dir backend
run build` passes. The private service now has a pinned Playwright adapter,
encrypted-volume validation, locking/sweeping/disconnect cleanup, and server
composition installs authenticated workspace middleware before acquisition
routes. Repository session and replay records are durable across service
instances, with MySQL session/replay tables and fake-transaction rollback
coverage.

The requested aggregate was retried after these fixes. It completed all 34
`acquisition-application-test.ts` subtests successfully, including the final
runtime close test, but its Node test worker retained an idle handle for more
than 100 seconds and was terminated. This is the remaining aggregate-runner
blocker; all focused, security, contract, and build checks are green.

## Fix round 2/5

RED/GREEN: the dedicated router regression originally received a cross-workspace
`412` (not the required `404`); after separating not-found from conditional
failure, it passes create, exact `200` replay/header, cross-workspace `404`,
and stale `412`. The account service and fake MySQL transaction tests also
pass atomic active-handle conflict and persisted replay behavior.

The pinned browser adapter now owns Playwright entirely on a dedicated browser
thread; every sync route call is marshalled to that thread, and its open path
closes the persistent context on all navigation/locator/fetch/validation
failures. Deployment startup validates the encrypted profile volume and root;
the global ASGI app installs it only at startup, so imports/tests do not create
a browser or insecure temporary profile. The source-controlled Node bearer
secret fallback was removed: the integration is simply not mounted unless both
server-owned MediaCrawler environment values are present.

Focused GREEN: `uv run --directory services/media-crawler pytest
tests/shensi_adapter/test_accounts.py tests/shensi_adapter/test_contracts.py -q`
reported 4 passed; Node account tests reported 7 passed; backend build passed.

## Fix round 3/5 (partial; blocked before completion)

RED evidence:

```text
pytest tests/shensi_adapter/test_accounts.py:
KeyError on a fresh AccountManager after an active QR session (metadata was not durable).

tsx src/acquisition-social-account-test.ts:
concurrent idempotent creates issued 2 upstream QR sessions (expected 1).

tsx src/acquisition-social-account-router-test.ts:
second DELETE with the same key returned 412 (expected exact 200 replay).
```

GREEN evidence:

```text
uv run --directory services/media-crawler pytest tests/shensi_adapter/test_accounts.py -q
3 passed

pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/acquisition-social-account-test.ts \
  src/acquisition-social-account-router-test.ts \
  src/acquisition-social-account-mysql-repository-test.ts
8 passed

pnpm --dir backend run build
passed

pnpm --dir backend run test:security
passed

pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/acquisition-openapi-response-conformance-test.ts
8 passed
```

Implemented in this partial pass: persistent protected account-session metadata
with immediate profile cleanup and a periodic sweeper; bounded browser-thread
startup/command/shutdown handoff; ASGI lifespan ownership; in-memory semantic
reservation for concurrent POST and frozen DELETE replay; and service-side
gateway disconnect using the private upstream session id.

Not completed: real production authentication/CSRF composition coverage,
complete cross-process MySQL pending/reclaim state machine, the full browser
route/lifecycle failure matrix, docs update, and a clean acquisition aggregate.
The aggregate still emits every `acquisition-application-test.ts` assertion but
the Node worker remains alive with `Timeout`/pipe resources after the final
test. This was reproduced independently of the account tests and requires an
owner-level change to the existing acquisition runtime/test harness lifecycle.

## Fix round 4/5 (complete)

### RED evidence and diagnosis

The inherited implementation was replaced where its lifecycle and replay
boundaries were not recoverable. The focused RED suite first demonstrated five
Python lifecycle failures: graceful close deleted restart state, a raw browser
context escaped its owner, a timed-out browser thread remained live, shutdown
reported an unbounded/raw failure, and ASGI close deleted the active profile.
The focused Node RED suite demonstrated four independent durability/composition
failures: the production HTTP installer was not testable, a second process saw
a pending reservation as a terminal error, failed upstream creation left a
pending reservation behind, and a failed DELETE advanced the ETag so it could
not be retried. Actual HTTP response validation then failed on both 404 and 412
because the runtime OpenAPI emitted `nullable` without an OpenAPI 3.0 `type`.

The completed acquisition aggregate initially ran every assertion but retained
an idle handle. `async_hooks` attribution identified the growing resource as
the duration `Timeout` created by `acquisition-copilot-runner.ts:126`; the
reported `PipeWrap` resources were stable process stdio, not the leak. The
application close path waited for a model call without first aborting it. After
adding application-owned `AbortController` instances and a bounded abort/drain
phase, the worker exits. That aggregate also exposed four ordinary assertions
(two legacy Pi tool-snapshot assertions, the raw replay-key schema assertion,
and one stale fake-information-schema fixture); all were fixed without
weakening current exact snapshot validation.

A final Python verification caught one macOS race after the first green run:

```text
test_timed_out_browser_command_kills_playwright_descendants
PermissionError: [Errno 1] Operation not permitted
1 failed, 11 passed in 2.73s
```

The abnormal boundary had already sent group-wide `SIGTERM`, then raced a
second group-wide `SIGKILL` against the exiting group. Hard-stop now sends one
immediate group-wide `SIGKILL`, which is both a stronger timeout boundary and
removes the two-signal race. Five consecutive descendant-kill regressions and
the complete Python suite are green after that change.

### Implemented result

- Playwright and every persistent browser context are owned only by a spawned
  process in its own POSIX process group. Startup, create, poll, disconnect,
  command execution, and shutdown are bounded. Timeout/protocol failure kills
  the whole owned group, including Chromium descendants; callers retain only
  opaque handles.
- The deployment entry point validates that the encrypted volume already
  exists, is a real directory (not a symlink), has exact mode `0700`, and
  contains the configured profile root. Account/profile directories are
  repaired to `0700`; metadata and reloaded metadata are repaired to `0600`.
  Graceful ASGI shutdown closes browser resources and retains active metadata
  and profiles. Only expiry and explicit disconnect remove them.
- The public router is covered through the real server composition: real test
  login cookies, real session/CSRF validation, and the production workspace
  resolver. Anonymous mutation is 401, bad CSRF is 403, the authenticated
  workspace succeeds, and an arbitrary `x-workspace` cannot cross the tenant
  boundary.
- POST and DELETE use a durable pending/completed replay state machine with a
  semantic request hash, hashed idempotency key, exact response JSON/status/
  replay headers, timestamps, replay expiry, leases, and fencing tokens.
  Same-key concurrent processes make one upstream call; failures release the
  claim, crashes reclaim after lease expiry, and expired completed rows can be
  reused safely.
- Login-session persistence and replay completion share one transaction.
  DELETE performs idempotent upstream cleanup before one fenced local account +
  replay transaction. An upstream failure changes neither local state nor ETag;
  a local transaction failure rolls back and releases its reservation, and a
  retry tolerates upstream 404 without a stale-ETag dead end.
- Memory and MySQL implementations have stateful parity tests. Both schema
  snapshots contain `upstream_session_id` and the complete replay schema. The
  runtime migration introspects existing tables, adds every missing column,
  hashes and removes the legacy raw idempotency key, replaces its primary key,
  makes replay JSON nullable, and backfills pending/completed state.
- Response conformance now exercises real Express HTTP responses: fresh POST
  201, exact POST replay 200/body/header, DELETE 404 and 412 envelopes, and
  DELETE 200. The editable OpenAPI, runtime OpenAPI, tests, and generated
  frontend types agree on replay headers.
- The current acquisition, architecture, API index, deployment, and environment
  documentation now states the private encrypted mount requirements, explicit
  sidecar configuration, restart retention, expiry/disconnect deletion, and
  bounded fail-closed process lifecycle. Canonical Compose still does not
  provision the MediaCrawler sidecar, so the account routes remain unmounted
  unless operators provide its private base URL and service secret.

### Exact GREEN verification

```bash
uv run --directory services/media-crawler pytest tests/shensi_adapter -q
```

```text
............                                                             [100%]
12 passed in 2.41s
```

```bash
for run in 1 2 3 4 5; do uv run --directory services/media-crawler \
  pytest tests/shensi_adapter/test_accounts.py -q \
  -k timed_out_browser_command_kills_playwright_descendants || exit 1; done
```

```text
1 passed, 8 deselected in 1.02s
1 passed, 8 deselected in 1.02s
1 passed, 8 deselected in 1.01s
1 passed, 8 deselected in 1.02s
1 passed, 8 deselected in 1.02s
```

```bash
NODE_ENV=test TZ=UTC \
JWT_SECRET=goodjob-acquisition-test-secret-at-least-32-characters \
ACQUISITION_MASTER_SECRET=goodjob-acquisition-master-test-secret-at-least-32-bytes \
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/acquisition-social-account-test.ts \
  src/acquisition-social-account-mysql-repository-test.ts \
  src/acquisition-social-account-router-test.ts
```

```text
1..17
# tests 17
# pass 16
# fail 0
# skipped 1
# duration_ms 2550.371708
```

The single explicit skip is:

```text
MYSQL_TEST_ADMIN_URL is required; no database is provisioned implicitly
```

```bash
pnpm --dir backend run test:acquisition
```

```text
1..962
# tests 1008
# pass 1006
# fail 0
# cancelled 0
# skipped 2
# todo 0
# duration_ms 49433.515458
```

```bash
pnpm check:acquisition-contracts
```

```text
contract tests: 91 passed, 0 failed
contract drift tests: 18 passed, 0 failed
security: { "ok": true }
acquisition OpenAPI: 32 passed, 0 failed
generated acquisition types: current
frontend production build: passed (existing chunk-size warning only)
frontend self-test: { "ok": true, "checked": 56 }
Baota package: 2 passed, 0 failed
exit 0
```

```bash
pnpm --dir backend run test:security
pnpm --dir backend run build
git diff --check
```

```text
security: { "ok": true }
$ tsc -p tsconfig.json
git diff --check: no output
all exit 0
```

The live MySQL test is implemented and conditionally provisions an isolated
database for restart replay, completed-replay expiry, crashed-lease reclaim,
and transaction rollback. It was not executed because
`MYSQL_TEST_ADMIN_URL` is not present in this environment. Stateful fake MySQL
transaction/restart parity ran for every build. A real Douyin/Playwright login
was also not live-smoked; all browser lifecycle regressions use a process-owned
fake Playwright boundary. No Growth 1.0.11/1.0.12 release file or lockfile was
modified.
