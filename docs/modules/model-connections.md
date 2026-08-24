# Model Connections

## Responsibility

Manages tenant-scoped AI provider endpoints, encrypted credential versions,
capability certification, active/default connection selection, immutable job
snapshots, and audited model-call records used by acquisition and the financial
council.

## Entry Points

- HTTP lifecycle: `/api/v1/ai/connections` handlers in
  `backend/src/server.ts`.
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

`GET/POST /api/v1/ai/connections`, `GET/PATCH/DELETE
/api/v1/ai/connections/:id`, and `POST
/api/v1/ai/connections/:id/activate` are authenticated runtime routes. Public
projections omit API keys and expose fingerprints/capabilities rather than raw
credentials. Financial-council routing policy references connection IDs and
snapshots through the Growth contract.

## Tests

- Connection, endpoint, gateway, and acquisition integration:
  `pnpm --filter ./backend test:acquisition`
- Focused gateway: `pnpm --filter ./backend test:model-gateway`
- Backend security aggregate: `pnpm --filter ./backend test:security`
- Frontend connection UI: `pnpm --filter ./frontend test`

## Operational Checks

Provide encryption keys only through the ignored runtime environment. For a
live health/call check, verify tenant scope, endpoint allow-listing, decryption,
capability snapshot, provider timeout, and redacted logs. Migration acceptance
must prove an existing encrypted credential can still be used with the
preserved key; byte copying alone is insufficient.

## Known Limitations

Provider availability, model listing, tool calling, and structured output vary
by endpoint profile and cannot be inferred from a saved connection. Live
provider tests require billable external credentials. Losing or changing the
external encryption key makes stored credential versions unusable; the key is
intentionally not recoverable from Git.
