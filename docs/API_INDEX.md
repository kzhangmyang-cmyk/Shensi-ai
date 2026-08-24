# API Index

## Contract authority

| Surface | Editable authority | Runtime evidence | Generated consumer |
| --- | --- | --- | --- |
| Acquisition v1 | `contracts/openapi/ai-acquisition.v1.yaml` and `contracts/json-schema/` | `backend/src/acquisition-openapi.ts`, acquisition routers, drift and response-conformance tests | `frontend/src/generated/ai-acquisition.ts` |
| Growth, quote, ROI, finance, council | `contracts/openapi/growth-advisor-quote-roi.v1.yaml` and `contracts/json-schema/` | `backend/src/growth-openapi.ts`, Growth module routers, drift and response-conformance tests | `frontend/src/generated/growth-advisor-quote-roi.ts` |
| Immutable Growth release | `contracts/releases/growth-advisor-quote-roi/1.0.12/` | `manifest.json` declares `contractVersion: 1.0.12`; release gates verify hashes | `frontend/contracts/pinned/growth-advisor-quote-roi/1.0.12/` |

Generated types are authoritative at the frontend/backend transport boundary.
Do not add parallel handwritten DTOs.

## Route families

- `/api/auth`, `/api/profile`, `/api/accounts`: session, profile, and account
  administration in `backend/src/server.ts`.
- `/api/customers`, `/api/leads`, `/api/deals`, `/api/todos`,
  `/api/commission`: CRM and operating routes in `backend/src/server.ts`.
- `/api/v1/acquisition`: plans, runs, shards, candidates, evidence, reviews,
  provider connections, Douyin QR login/workspace accounts, immutable Douyin
  automation policies, server-derived keyword suggestions, and run-now intents with distinct authoritative
  acquisition-run IDs, persisted run crawler status, run-scoped candidate
  feeds, visual reader, copilot, outcomes, performance, advisor, and
  ROI-related acquisition projections.
- `/api/v1/catalog`: catalog items, package versions, and pricing policies.
- `/api/v1/quotes`: quote cases, versions, approvals, publication, and deal
  decisions.
- `/api/v1/finance`: facts, imports, statement packages, council policy,
  routing policy, council runs, dispatch reads, and agent-center projections.
- `/api/v1/growth/bootstrap`: active workspace and enabled feature bootstrap.
- `/api/v1/ai/connections`: model connection lifecycle and activation.
- `/api/docs` and `/api/docs/openapi.json`: runtime-generated Swagger when
  enabled and authorized.

The legacy `/api/*` CRM route list is generated from Express registration in
`backend/src/swagger.ts`; it is not a substitute for the two versioned shared
contracts.

## Protocol conventions

Protected routes require an authenticated session or bearer identity. Browser
writes use the CSRF cookie/header pair. Contracted commands may additionally
require `Idempotency-Key`; versioned writes use `If-Match`/`ETag` where declared
by the OpenAPI document. Error shapes and authorization capabilities must come
from the contract or backend policy registry rather than frontend inference.

## Change workflow

1. Edit the relevant OpenAPI/JSON Schema source and backend runtime together.
2. Regenerate committed frontend types with
   `pnpm generate:frontend-contract-types`.
3. Run `pnpm check:acquisition-contracts` or
   `pnpm check:growth-contracts` as appropriate.
4. Run `pnpm check:generated-acquisition-types`, frontend tests, and the root
   build.
5. Publish a new immutable release for public Growth changes; never rewrite
   `1.0.12`.
