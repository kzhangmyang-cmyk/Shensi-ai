# Model Connections

## Responsibility

Manages tenant-scoped AI provider endpoints, encrypted credential versions,
capability certification, active/default connection selection, immutable job
snapshots, and audited model-call records used by acquisition and the financial
council.

## Entry Points

- HTTP lifecycle: `/api/v1/ai/connections` handlers in
  `backend/src/server.ts`.
- HTTP endpoint catalog: `GET /api/v1/ai/endpoint-profiles` returns the
  official endpoint profiles and their server-certified selectable models.
- Domain service: `backend/src/model-providers/connection-service.ts`.
- Endpoint registry/adapters: `backend/src/model-providers/endpoint-profiles.ts`
  and `backend/src/model-providers/adapters/`.
- Runtime gateway: `backend/src/model-providers/gateway.ts` and `runtime.ts`.
- Frontend settings: `frontend/src/connections/` and the `#settings` shell
  route.

## Dependencies

Authenticated owner/team scope, `CrmStore`, credential encryption helpers,
official provider endpoint profiles, idempotency storage, model capability
contracts, network allow-list validation, and consumers that snapshot a
connection before background work.

## Database Tables

`ai_model_configs`, `ai_model_credential_versions`,
`ai_model_connection_activation_events`, `ai_model_connection_idempotency`,
`ai_job_model_snapshots`, and `ai_model_call_records` are created and migrated
in `backend/src/mysql-store.ts` and represented in `backend/schema.mysql.sql`.

## Public Interfaces

`GET /api/v1/ai/endpoint-profiles`, `GET/POST /api/v1/ai/connections`,
`GET/PATCH/DELETE /api/v1/ai/connections/:id`, and `POST
/api/v1/ai/connections/:id/activate` are authenticated runtime routes. Each
endpoint-profile item contains the provider, endpoint identity, region,
official base URL or a null workspace URL, model-list policy, official
reference, and a closed `models` array of `{ id, displayName }` choices. The
list is server-certified configuration for selecting an exact model ID; it is
not a live provider model-list response. Public projections omit API keys and
expose fingerprints/capabilities rather than raw credentials. Financial-council
routing policy references connection IDs and snapshots through the Growth
contract.

Connection lifecycle commands keep their in-memory mutation, replay record,
persistence, and rollback inside the shared store queue. Model-backed Douyin
keyword commands use the explicit `persistenceScope: "result"` boundary instead:
snapshot resolution and model/audit persistence finish outside that queue,
then a short queued mutation stores the replay result. Both boundaries retain
the same command serialization, owner/team scope, fingerprint conflict check,
and durable replay. A failed result write removes its replay record; it cannot
undo a provider attempt that already completed, so retry may invoke the model
again. Never hold the store queue while awaiting `readBarrier()` or `persist()`
on the same store.

## Tests

- Connection, endpoint, gateway, and acquisition integration:
  `pnpm --filter ./backend test:acquisition`
- Published endpoint-profile contract and generated transport types:
  `pnpm check:acquisition-contracts`
- Focused gateway: `pnpm --filter ./backend test:model-gateway`
- Keyword serialization and replay: from `backend`, run
  `NODE_ENV=test node --import tsx --test src/acquisition-douyin-keyword-idempotency-test.ts src/model-connection-idempotency-test.ts`;
  the serialized-store application route cases are also in
  `src/acquisition-application-test.ts` and the acquisition aggregate.
- Backend security aggregate: `pnpm --filter ./backend test:security`
- Frontend connection UI: `pnpm --filter ./frontend test`

## Operational Checks

Provide encryption keys only through the ignored runtime environment. For a
live health/call check, verify tenant scope, endpoint allow-listing, decryption,
capability snapshot, provider timeout, and redacted logs. Migration acceptance
must prove an existing encrypted credential can still be used with the
preserved key; byte copying alone is insufficient.

## Known Limitations

The selectable model catalog is a versioned certification list and can lag a
provider's current inventory. Choosing an entry prevents an arbitrary or
misspelled model ID, but does not prove that an API key is valid, that the
tenant is entitled to the model, that quota remains, or that the provider is
currently available. Live provider tests remain required for those facts and
may be billable. Provider model listing, tool calling, and structured output
vary by endpoint profile. Losing or changing the external encryption key makes
stored credential versions unusable; the key is intentionally not recoverable
from Git.

DeepSeek V4 enables thinking mode by default, but its Chat Completions endpoint
rejects `tool_choice: required` while that mode is active. The official
OpenAI-compatible adapter therefore sends `thinking.type: disabled` only for
required DeepSeek tool calls. Text generation and other providers keep their
normal mode, and the server still validates the returned tool name and JSON
arguments before any acquisition action can be created.

Non-streaming model calls persist their success or failure ledger entry before
the gateway returns to business code. A later outreach-draft validation failure
therefore does not erase the provider attempt from the audit trail. If both the
provider call and audit persistence fail, both causes are retained rather than
replacing the provider error with a generic persistence error.
Storage failures use the internal `ModelLedgerPersistenceError` aggregate for
preflight, streaming and non-streaming attempts. Consumers can distinguish
them from provider availability errors without discarding either cause. The
financial council maps this to its existing non-retryable ledger-persistence
failure and does not perform a second flush that could hide the first failure.
