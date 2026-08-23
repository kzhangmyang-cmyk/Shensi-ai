# Task 3 Report — Real Financial Council routed model runtime

## Status

Implemented the real, server-owned role routing loop for analyze, rebut and
synthesize. A run freezes one historical routing-policy version, selection is
workspace/control/run scoped, each ordered provider attempt binds an official
snapshot durably before traffic, and only the narrowly classified provider
timeout/429/5xx/unavailable failures may advance to the next of at most three
connections. The same change migrates model connections from one-enabled to
multiple-enabled/one-internal-default without changing the public DTO.

Commit message: `feat(finance): route council roles across model providers`
(the report is included in that commit).

## TDD evidence

### Core routed runtime RED

- The brief's literal command, `npm exec --workspace backend -- ...`, exited
  before tests with `No workspaces found`; this repository is pnpm-based.
- The equivalent pnpm command over the six brief files was then run and gave
  an effective RED: 184 tests total, 180 pass, 2 skip, 2 fail. The new routed
  port and selection modules did not exist.
- The exact-route gateway test also failed against the old active-default
  binding: the requested fallback connection was not the snapshotted winner.

### Core routed runtime GREEN

- `financial-council-routed-model-port-test.ts` plus
  `financial-council-model-selection-test.ts`: 10/10 pass during the focused
  loop.
- `financial-council-model-gateway-test.ts`: 47/47 pass during the focused
  gateway loop.
- Final Task 3 focused command over routed port, selection, gateway,
  specialists, CFO, service, Memory repository, fake-MySQL repository and
  module construction: 222 tests, 220 pass, 0 fail, 2 explicit live-InnoDB
  skips.
- Worker/integration command covering analysis, rebuttal, optimization,
  specialists, CFO and vertical integration: 25/25 pass.

### Multiple-active / single-default RED → GREEN

- RED: Memory activation disabled the former active connection instead of
  retaining it, and legacy active binding selected the first enabled row
  instead of the sole default. Both load-bearing assertions failed.
- GREEN: `NODE_ENV=test pnpm --dir backend exec tsx --test
  --test-concurrency=1 src/model-connection-service-test.ts
  src/model-runtime-integration-test.ts` — 24/24 pass.
- Static schema contract now proves `is_default`, generated
  `default_owner_team_key`, and a unique default-only index. The migration
  removes the old active-only index/column, keeps every enabled row, and
  deterministically promotes the previous enabled legacy row to default.

## Closed-loop behavior

### Analyze, rebut and synthesize

- `RoutedFinancialCouncilModelPort` is the only owner of the primary plus two
  fallback budget for all three phases. Analysis/rebuttal worker-local retries
  were removed, so attempts cannot fan out or exceed 1..3.
- The final specialist/rebuttal/CFO model result carries the winning job,
  attempt, exact connection and frozen policy/reason identity. Repository
  validators accept only attempts 1..3 and bind the job suffix to that attempt.
- A durable fence re-parses the existing Task 2 right-sided job identity after
  both provider resolve and reject. A lower attempt cannot commit after a
  higher attempt snapshot exists.

### Fallback, recovery and failure classification

- Ordered routes are deduplicated and truncated to three. Only model timeout,
  rate limit, or provider failure marked retryable can advance. Auth,
  capability, structured/schema/content/hash, empty/malformed output, snapshot
  persistence, and ledger persistence errors stop immediately.
- Every attempt uses durable exact-connection snapshot binding before provider
  traffic. The same job/content/connection reuses the immutable snapshot after
  restart; changed content or connection identity conflicts before traffic.
- A missing or removed selected connection fails closed before traffic. Failed
  call persistence must complete before fallback; failed ledger persistence is
  non-retryable.

### Run binding and public boundary

- Creation reads the real active workspace's current routing policy and stores
  required internal `modelRoutingPolicyVersionId`. Exact create replay retains
  the old version after current policy advances.
- Selection re-loads the run and analysis control through the authenticated
  workspace, checks workspace/owner/team/run identity, loads the exact frozen
  historical policy, and reuses Task 2 routing/scoring/call-job parsing.
- Legacy generic runs receive `legacy-unroutable` and cannot claim a usable
  routing policy. Browser create input cannot supply the internal field.
- Run and event public projections strip the routing-policy version. API keys,
  credential material, prompts and provider bodies are absent from run/result
  projection and logs.

## Memory / MySQL parity

- Closed Memory and MySQL validators/hash material include the frozen routing
  version; the MySQL denormalized column must equal canonical `run_json`.
- Existing `financial_council_runs` tables add the ASCII column under the
  Financial Council schema lock, backfill the explicit legacy sentinel, then
  remove the temporary SQL default.
- Fake MySQL plus Memory/service parity gate: 137 tests, 135 pass, 0 fail,
  2 explicit live-InnoDB skips.
- Model connection Memory and MySQL activation now keep other connections
  enabled and atomically move only `is_default`. Old generic snapshot binding
  chooses enabled+default; Financial Council routing sees all enabled,
  certified connections.

## Verification gates

- `pnpm test:financial-council`: 363 tests, 361 pass, 0 fail, 2 explicit live
  MySQL skips.
- `pnpm --filter ./backend test:financial-council:mysql`: 95 tests observed,
  90 pass, 4 skip, 1 harness-process failure because
  `MYSQL_TEST_ADMIN_URL` is absent (`MYSQL_TEST_ADMIN_URL_REQUIRED`); fake
  parser/transaction tests all passed.
- `pnpm --filter ./backend build`: pass (`tsc -p tsconfig.json`).
- `git diff --check`: pass.

## Files and documentation

- Added the routed port and repository-backed selection modules with direct
  tests; wired gateway, three phase callers, service/domain/repositories and
  module composition.
- Added the internal default migration to `schema.mysql.sql`,
  `goodjob_crm.full.sql`, `mysql-store.ts`, types, connection service/runtime
  and server bridge, with direct Memory/runtime/schema/live-MySQL test updates.
- Updated the authoritative runtime design's Model Connection section to state
  the current multiple-active/single-default rule. Historical July design and
  plan documents remain historical and were not rewritten. No API/OpenAPI/UI
  contract changed, so those documents require no update.

## Self-review and concerns

- Reviewed staged scope for credentials/prompt/provider-body leakage, duplicate
  job parsing/scoring, retry fan-out, public routing-field leakage, schema
  migration ordering and Memory/MySQL activation parity. `isDefault` is an
  internal, non-enumerable connection property and is omitted from public DTOs.
- Live provider persistence and live Financial Council MySQL integration could
  not run without `MYSQL_TEST_ADMIN_URL`/`DATABASE_URL`/`MYSQL_URL`; this is the
  only Task 3 environment gap.
- `model-connection-routes-test.ts` has one pre-existing unrelated Moonshot
  `kimi-k3` capability expectation mismatch (17 pass, 1 fail): the current
  profile returns structured/parallel capability true while the old test
  expects false. Per controller ruling, Task 3 does not change product
  capability semantics.
