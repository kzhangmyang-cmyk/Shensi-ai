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
  outreach batch revisions, separate human confirmation for public comments
  and post-comment private messages, version-2 action creation, and backwards-
  compatible action outbox reads with sanitized execution status, attempt count, receipt
  reference, occurrence time, and closed failure code;
  visual reader, copilot, outcomes,
  performance, advisor, and
  ROI-related acquisition projections.

`GET /api/v1/acquisition/outreach-batches?runId={runId}&candidateId={candidateId}&limit={1..50}&cursor={opaque}`
discovers current batch heads for one workspace/run/candidate in stable newest-
first order. It requires authentication plus `acquisition.outreach.approve`,
but no CSRF or idempotency header. The opaque cursor is bound to workspace,
run, and candidate. `#acquisition` and `#conversations` use this collection as
the shared server recovery authority; the conversations workspace reloads
overview, candidate evidence, this collection, then the selected batch GET.
It does not infer ownership from a locally remembered batch ID.
Each public batch candidate includes its frozen exact
`commentTargetPublicUrl` video and read-only `publicProfileUrl` candidate profile;
both participate in the batch hash so approval authorizes the targets shown to
the operator. The public DTO omits crawler-private `evidenceText` and
`publicActorKey`.

`POST /api/v1/acquisition/outreach-batches/{batchId}/direct-messages/approve`
is the separate private-message authorization command. It requires the same
authenticated outreach capability, cookie-session CSRF protection, semantic
idempotency, the current revision/ETag authority, and literal `confirm: true`.
Its idempotency fingerprint binds the `approve_direct_messages` operation, path
`batchId`, and exact request body: an exact retry on the same batch replays,
while reusing that key on another batch returns an idempotency conflict.
Its closed body supplies `batchRevision`, `batchHash`, `commentApprovalHash`, a
private-message `dailyLimit` from 1 through 100, and selected
`{candidateId,directMessage}` values. The default shown by clients is 20; it is
independent of the acquisition candidate limit (default 50, range 1–200). A
candidate is eligible only after its exact predecessor comment has a durable
successful receipt in the same batch. The command freezes that receipt, target,
text, approver, account/login version, daily ordinal, and version-2 stage hash,
then queues work; the route itself performs no browser write.

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

When one Douyin candidate has multiple persisted evidence rows, the run feed
deterministically prefers an exact `https://www.douyin.com/video/{id}` row.
Only when no such row exists does it expose a valid public profile as an
inspection fallback. Batch creation repeats the selection fail-closed and never
uses `/user/` as a comment target.

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
- `/api/v1/ai/endpoint-profiles`: official model endpoints and their
  server-certified selectable `{ id, displayName }` model choices.
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
MediaCrawler upstream is the collection/browser foundation. Exact comment and
version-2 direct-message execution are Shensi extensions behind this private
boundary; they must not be described as upstream-native features or official
Douyin APIs. The first confirmation creates comment actions only. After a
durable successful comment receipt, the separate command above may create one
version-2 direct-message action per confirmed candidate. Historical non-v2
direct-message rows remain readable audit data, are never backfilled, and are
not claimable. The executor serializes an account, reserves at least 60 seconds
between comments and ten minutes between private messages, and requires a
unique comment-publish receipt or new outgoing stable message ID respectively.
At the private browser boundary, the frozen sender is revalidated in place at
each irreversible checkpoint. Private-message input, submit, reconciliation,
and receipt proof additionally require one exact recipient marker matching the
frozen public profile target; ambiguous or changed bindings fail closed.
DOM/ARIA is the action-control authority; optional local RapidOCR may only
suggest a missing entry/send control before exact DOM rebind. Visual MCP remains
a development diagnostic, and no model provider receives browser-control or
approval authority.
The public acquisition contract includes
`POST /api/v1/acquisition/outreach-batches/{batchId}/actions/{actionId}/reconcile`.
It requires the outreach capability, CSRF for cookie sessions, an idempotency
key, the frozen batch revision/approval/content hashes, and literal human
confirmation. The command is read-only at the platform: it can record one
unique existing receipt for a `risk_paused` uncertain action but never submits
or retries content and never resumes paused work. A deterministic comment
failure may close a linked direct-message successor with `predecessor_failed`;
malformed claimed-success receipts and other uncertain writes fail closed as
ambiguous risk-paused outcomes.

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
