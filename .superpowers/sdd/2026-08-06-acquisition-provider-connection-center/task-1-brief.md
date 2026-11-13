# Task 1 Brief — Provider lifecycle frontend API

## Goal

Extend the AI Growth frontend API facade so the current Acquisition V1 provider catalog and Provider Connection lifecycle can be consumed without hand-written contract drift.

## Scope

- Modify `frontend/src/features/ai-growth/api.ts`.
- Add or modify focused frontend tests; prefer a dedicated `api.test.ts` if that keeps request-contract assertions isolated.
- Derive all request/response DTOs from `frontend/src/features/ai-growth/generated/ai-acquisition.ts`.
- Implement:
  - `listProviders()` GET `/api/v1/acquisition/providers`
  - `createProviderConnection(input, idempotencyKey)` POST collection
  - `getProviderConnection(id)` GET item
  - `updateProviderConnection(id, input)` PATCH item
  - `deleteProviderConnection(id)` DELETE item
  - `testProviderConnection(id)` POST item `/test`

## Exact Contract Rules

- Create uses existing POST helper and sends `Idempotency-Key` plus JSON content type.
- PATCH uses JSON content type only; no If-Match and no idempotency key because the current approved OpenAPI contract explicitly has neither.
- DELETE and TEST have no body and no write-specific headers.
- TEST HTTP 200 may contain `ok:false`; return it unchanged.
- Runtime 422/429/503 errors continue through existing generic error mapping; do not expand OpenAPI in this task.
- IDs must be URL-encoded using the existing segment helper.
- A 204 delete must not attempt to parse JSON. If current request abstraction cannot safely return void, make the smallest compatible adjustment with a regression test.

## Security Requirements

- No real keys in tests; use a conspicuous fixture such as `fixture-secret-never-log`.
- Never log request input or store it in module/global state.
- Public DTOs must not add `apiKey`, `baseUrl`, encrypted configuration or credential references.
- Do not read, modify, stage or commit `docs/superpowers/plans/2026-07-23-ai-model-adapters-and-pi.md`.

## Required Method

1. Write focused failing tests first and run them to show RED.
2. Implement the smallest API facade change.
3. Run the focused tests, frontend unit suite/type build and `git diff --check`.
4. Commit only Task 1 files plus this SDD metadata as `feat: connect acquisition provider lifecycle api`.
5. Write `task-1-report.md` with RED/GREEN commands, changed files and any follow-up risks.

## Acceptance

- Request spies prove exact URL, HTTP verb, headers and body for every method.
- Create uses the supplied idempotency key.
- PATCH/DELETE/TEST do not acquire invented concurrency or idempotency headers.
- DELETE 204 resolves successfully.
- TEST returns both `ok:true` and `ok:false` payloads honestly.
- TypeScript consumes generated DTOs with no duplicate manual shapes.
