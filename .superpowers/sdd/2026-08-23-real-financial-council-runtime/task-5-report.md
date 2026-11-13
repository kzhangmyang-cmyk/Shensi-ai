# Task 5 Report — Closed Council Onboarding APIs and Growth 1.0.11

## Outcome

Published the closed routing-policy, three-statement package, run-from-package,
agent-center, and per-run agent-attempt APIs. Runtime composition uses the
workspace-scoped repositories and official connection runtime state; no
frontend controller/view was added. Growth `1.0.11` is generated, pinned, and
consumed by generated frontend and canonical backend types.

## TDD evidence

- Contract RED: `pnpm test:contracts` rejected source version `1.0.10` and all
  seven absent onboarding paths before contract implementation.
- Code RED: focused runs first failed on the absent routing service,
  agent-center, three router modules, repository latest queries, and
  run-from-package route. The runtime statement tuple negative then proved RED
  as `200 !== 422`; create-if-absent routing proved RED as `400 !== 200`.
- GREEN: repository/package contracts 54/54; combined repository, service,
  router, module, and composition focus 56/56; final new public-boundary focus
  9/9.

## Public boundary

- Routing GET/preview and center reads require `finance.council.run`; routing
  PUT requires `finance.council.policy.manage`; statement preview/commit
  require `ledger.pending.create`; run-from-package requires
  `finance.council.run`.
- Every POST and the routing PUT require `Idempotency-Key`. Only exact replay
  emits `Idempotency-Replayed: true`; changed replay conflicts. Routing PUT
  additionally requires `If-Match`; `If-Match: *` is create-if-absent only.
  Routing GET returns the revision ETag.
- Read routes reject request bodies. Routing preview is POST with exact `{}`
  and performs no provider call. Browser workspace/actor/capability fields and
  arbitrary connection authority are rejected and reauthorized server-side.
- All request/response DTOs are closed. Statement responses exclude bytes,
  base64, raw cells, hashes, and normalized reports. Agent projections exclude
  credentials, API keys, prompts, provider bodies, and business data.
- Attempt `startedAt` comes only from a valid durable call `createdAt`;
  `completedAt` is derived only from terminal call time plus safe latency,
  otherwise null. Roles are always `cfo, finance, profit, cost, cashflow, tax`.
- Approval semantics are unchanged: approval creates controlled drafts,
  todos, or later approval tasks and does not mutate authoritative finance,
  quote, or CRM facts.

## Repository additions

- Council latest-run lookup is exact `{limit:1}`, workspace-scoped, ordered by
  `createdAt` then `runId`, includes terminal runs, and revalidates the full
  stored aggregate before returning.
- Statement latest-verified lookup is exact `{limit:1}`, workspace-scoped,
  ordered by `createdAt` then `packageId`, and reparses/revalidates the stored
  package before returning. Memory and fake-MySQL parity cover tenant isolation,
  deterministic order, closed limit, and tamper fail-closed behavior.

## Contract, release, and generated artifacts

- Contract suite: final aggregate 90/90; focused registry suite 35/35.
- Runtime/static Growth OpenAPI parity, response conformance, Swagger
  projection, and lifecycle gate: 44/44.
- Frontend pinned check and generated-type check pass; fixture suite 6/6 and
  frontend typecheck pass.
- `1.0.10` remains byte-for-byte unchanged:
  - `openapi.json` SHA-256 `dcbbc8e43c0ba43cd8e628cb49bd43f8f1a77810d3f864c83e11f4ac2fa0aee3`
  - `manifest.json` SHA-256 `7847d8507706dac314de6e41d0f37bc30ad34b277efa3b67408993406afc8e03`
- `1.0.11` release bytes:
  - `openapi.json` SHA-256 `bf569b15d0ecadd36a925e9e13d82c595489580904cce5cd9f8131a5586e68c1`
  - `manifest.json` SHA-256 `7d045e0b2c1b3cba88ffa365bd902aaf22c203b93f4f58f24c67d67da3b97be1`
- The frontend import command was once invoked through pnpm with the wrong
  separator and mechanically removed unrelated lock entries. The lockfile was
  restored with `apply_patch`; it has no diff from BASE and is not staged.

## Verification

- `pnpm test:contracts`: 90/90 pass.
- `pnpm --filter ./backend test:growth-openapi`: 44/44 pass.
- `pnpm test:financial-council`: 366 pass, 2 skipped live-MySQL tests, 0 fail.
- `pnpm check:growth-contract-release`: pass.
- `pnpm --filter ./frontend test:types`: pass.
- `pnpm --filter ./backend build`: pass.
- `git diff --check`: pass.
- No live MySQL claim: `MYSQL_TEST_ADMIN_URL` was not supplied. Fake/parity,
  contract, generated-type, and build evidence is reported instead.

## Documentation and self-review

Updated root, contract, backend Financial Council, and frontend current-entry
READMEs to `1.0.11`, the exact public endpoints/capabilities, sanitized data
boundary, and draft-only approval rule.

Self-review found and closed two boundary gaps: statement tuple order/nested
unknown fields are now enforced at runtime, and first routing policy creation
uses standard `If-Match: *` without relaxing revision updates. OpenAPI 3.1
keeps exact `prefixItems`; the runtime OpenAPI 3.0 projection uses `items.oneOf`
plus explicit exact-prefix vendor metadata, while the router enforces order.
No new public DTO exposes Task 3/4 internal routing/package bindings or
multi-active/default connection state.

## Commit

Planned commit: `feat(finance): expose real council onboarding APIs`.
