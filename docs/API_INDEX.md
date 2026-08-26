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
  automation policies, optional model-backed keyword suggestions, and run-now intents with distinct authoritative
  acquisition-run IDs, persisted run crawler status with a closed activity
  observation (phase, keyword, browser mode, sequence) and closed candidate
  projection readiness (`pending`, `ready`, or `failed`), a null or stable
  runtime-normalized crawler failure code, run-scoped candidate feeds, immutable
  task overviews that retain the newest run status and separately identify the
  newest run with persisted candidate links,
  outreach batch revisions, human approval, and ordered comment-then-message
  action outbox reads with sanitized execution status, attempt count, receipt
  reference, occurrence time, and closed failure code;
  visual reader, copilot, outcomes,
  performance, advisor, and
  ROI-related acquisition projections.

`GET /api/v1/acquisition/runs/{runId}/candidates` keeps the generated response
type but the browser treats it as a closed trust boundary. The page, each
candidate, and its evidence must have exactly the declared keys; the client
enforces bounded page/text/cursor policy and rejects the whole response when an
evidence URL lacks a literal HTTP(S) authority and hostname or contains raw
credentials, backslashes, whitespace/control/format characters, malformed
percent escapes, or parser-repaired authority. The OpenAPI `sourceUrl` remains
`format: uri` and crawler `lastErrorCode` remains a bounded nullable string;
HTTP(S) URL closure and the stable crawler error allowlist are runtime defenses,
not parallel handwritten DTOs or generated enums.

Plan creation accepts an optional `executionMode`. Absence means the compatible
`generic` provider-operation mode. `douyin_mediacrawler` is Douyin-only and
uses empty provider/operation arrays, no model connection, and a nullable model
snapshot on its persisted Plan and Run. Its command path is plan create,
approval, automation GET/PUT, then `/plans/{planId}/run-now`; generic
`/plans/{id}/runs` rejects this mode. Manually supplied automation keywords do
not require a search API or AI model. Only `automation/keyword-suggestions`
requires the server-selected active model.
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

The sidecar `/internal/v1/*` health, account, crawl, result, acknowledgement,
and exact-action routes are service-to-service implementation interfaces, not
public APIs. They require the mounted bearer secret, accept only a private or
loopback backend connection, and are never routed by Nginx. Raw handles,
cookies, browser profiles, leases, raw ingestion state, and upstream payloads
must not be added to the acquisition OpenAPI surface.

## Protocol conventions

Protected routes require an authenticated session or bearer identity. Browser
writes use the CSRF cookie/header pair. Contracted commands may additionally
require `Idempotency-Key`; versioned writes use `If-Match`/`ETag` where declared
by the OpenAPI document. Error shapes and authorization capabilities must come
from the contract or backend policy registry rather than frontend inference.
Crawler repositories normalize unknown, legacy, and exception-derived failures
before persistence and public projection; raw messages or credentials are never
valid public error codes.

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
