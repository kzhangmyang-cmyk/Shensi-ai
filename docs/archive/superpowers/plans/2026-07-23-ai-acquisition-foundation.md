# AI Acquisition Agent Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the executable contract, Node runtime baseline, BYOK connection invariants, and model-gateway foundation required by the complete AI acquisition agent.

**Architecture:** Add an isolated `contracts` workspace as the normative API boundary, then stabilize the existing 1.09 model configuration before adding a focused `model-providers` module. Existing `server.ts`, `mysql-store.ts`, and schema files are touched only by dedicated integration steps; all model calls are bound to immutable job snapshots and an append-only call ledger.

**Tech Stack:** Node.js `>=22.19.0`, npm workspaces, TypeScript 5.7, Express 4, MySQL 8, Zod 3, Node test runner, Ajv 8, Swagger Parser, `@earendil-works/pi-agent-core@0.81.1`.

## Global Constraints

- The design source of truth is `docs/superpowers/specs/2026-07-23-ai-acquisition-agent-design.md`.
- Customers provide official BYOK credentials; plaintext keys never appear in API responses or logs.
- A user may save multiple model connections but may have at most one active connection.
- A job snapshots `connectionId`, `credentialVersion`, provider, model, capabilities, Prompt version, and Schema version; switching the active connection affects only new jobs.
- No task-level model routing and no cross-provider automatic fallback.
- AI business outputs use versioned JSON Schema and retain evidence, confidence, rule version, Prompt version, and model attribution.
- `@earendil-works/pi-agent-core` and its transitive `pi-ai` dependency are pinned to `0.81.1`; Pi never selects providers or reads credentials.
- Existing `main` is never modified directly; work remains on `feature/ai-acquisition-agent-design` and later merges through `develop/ai-growth`.
- Production behavior is implemented test-first: RED, GREEN, then refactor.

---

## File Structure

```text
contracts/
├── package.json
├── README.md
├── openapi/ai-acquisition.v1.yaml
├── json-schema/*.v1.schema.json
├── examples/*.v1.json
└── test/{helpers,schema-registry,examples,openapi}.test.mjs

backend/src/model-providers/
├── types.ts
├── catalog.ts
├── connection-service.ts
├── job-snapshot.ts
├── call-ledger.ts
├── gateway.ts
└── adapters/openai-compatible.ts

backend/src/model-providers-test.ts
backend/src/model-connection-service-test.ts
backend/src/model-gateway-test.ts
backend/src/model-config-migration-test.ts
```

The contract workspace owns machine-readable boundaries. `model-providers` owns model catalog, connection behavior, immutable snapshots, calls, and adapters. Express routes and MySQL wiring delegate to these modules and do not contain model business rules.

---

### Task 1: Freeze the executable `ai-acquisition.v1` contract

**Files:**
- Create: `contracts/package.json`
- Create: `contracts/README.md`
- Create: `contracts/openapi/ai-acquisition.v1.yaml`
- Create: `contracts/json-schema/api-error.v1.schema.json`
- Create: `contracts/json-schema/paged-result.v1.schema.json`
- Create: `contracts/json-schema/async-operation.v1.schema.json`
- Create: `contracts/json-schema/model-provider.v1.schema.json`
- Create: `contracts/json-schema/model-connection.v1.schema.json`
- Create: `contracts/json-schema/model-capability.v1.schema.json`
- Create: `contracts/json-schema/model-call-record.v1.schema.json`
- Create: `contracts/json-schema/discovery-provider.v1.schema.json`
- Create: `contracts/json-schema/provider-connection.v1.schema.json`
- Create: `contracts/json-schema/content-fetch-operation.v1.schema.json`
- Create: `contracts/json-schema/import-operation.v1.schema.json`
- Create: `contracts/json-schema/acquisition-plan.v1.schema.json`
- Create: `contracts/json-schema/acquisition-run.v1.schema.json`
- Create: `contracts/json-schema/acquisition-operation-shard.v1.schema.json`
- Create: `contracts/json-schema/discovery-evidence.v1.schema.json`
- Create: `contracts/json-schema/party-ref.v1.schema.json`
- Create: `contracts/json-schema/organization-candidate.v1.schema.json`
- Create: `contracts/json-schema/individual-demand-signal.v1.schema.json`
- Create: `contracts/json-schema/qualification-decision.v1.schema.json`
- Create: `contracts/json-schema/battle-card.v1.schema.json`
- Create: `contracts/json-schema/review-event.v1.schema.json`
- Create: `contracts/json-schema/outcome-feedback.v1.schema.json`
- Create: `contracts/json-schema/copilot-session.v1.schema.json`
- Create: `contracts/json-schema/copilot-task.v1.schema.json`
- Create: `contracts/examples/organization-flow.v1.json`
- Create: `contracts/examples/individual-flow.v1.json`
- Create: `contracts/examples/search-smoke-query.v1.json`
- Create: `contracts/test/helpers.mjs`
- Create: `contracts/test/schema-registry.test.mjs`
- Create: `contracts/test/examples.test.mjs`
- Create: `contracts/test/openapi.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Section 16 of the approved design specification.
- Produces: OpenAPI document `ai-acquisition.v1`, 24 JSON Schema documents, and valid organization/individual examples for all later tasks.

- [ ] **Step 1: Write contract tests before creating the contract files**

Create `contracts/test/schema-registry.test.mjs` with a registry test that requires exactly the approved schema basenames and compiles them with Ajv 2020:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { loadSchemaRegistry } from "./helpers.mjs";

const expected = [
  "api-error", "paged-result", "async-operation", "model-provider",
  "model-connection", "model-capability", "model-call-record",
  "discovery-provider", "provider-connection", "content-fetch-operation",
  "import-operation", "acquisition-plan", "acquisition-run",
  "acquisition-operation-shard", "discovery-evidence", "party-ref",
  "organization-candidate", "individual-demand-signal",
  "qualification-decision", "battle-card", "review-event",
  "outcome-feedback", "copilot-session", "copilot-task"
];

test("ai-acquisition.v1 exposes the complete unique schema registry", async () => {
  const registry = await loadSchemaRegistry();
  assert.deepEqual([...registry.names].sort(), [...expected].sort());
  assert.equal(registry.ids.size, expected.length);
  for (const validate of registry.validators.values()) {
    assert.equal(typeof validate, "function");
  }
});
```

Create `contracts/test/examples.test.mjs` with negative assertions for missing provenance and personal records using `company`:

```js
test("personal evidence cannot omit provenance or masquerade as a company", async () => {
  const { validateCase } = await loadContractHarness();
  assert.equal(validateCase("discovery-evidence", {
    id: "ev_invalid", targetType: "individual_signal"
  }).valid, false);
  assert.equal(validateCase("individual-demand-signal", {
    id: "person_invalid", company: "个人用户"
  }).valid, false);
});
```

Create `contracts/test/openapi.test.mjs` to assert `/api/v1/ai/connections`, `/api/v1/acquisition/runs`, `/api/v1/acquisition/candidates/{id}/review`, and Copilot routes exist, all operations declare Bearer authentication, writes declare `Idempotency-Key`, and long operations expose `202`.

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
npm install
npm run test --workspace contracts
```

Expected: FAIL because `contracts/package.json`, the schema registry, OpenAPI, and examples do not exist.

- [ ] **Step 3: Create the contract workspace and normative artifacts**

Use this package definition:

```json
{
  "name": "goodjob-ai-acquisition-contracts",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/*.test.mjs"
  },
  "devDependencies": {
    "@apidevtools/swagger-parser": "10.1.1",
    "ajv": "8.17.1",
    "ajv-formats": "3.0.1",
    "yaml": "2.8.1"
  }
}
```

Every schema must declare Draft 2020-12, a unique `$id` ending in its filename, `additionalProperties: false` for business objects, and the exact discriminators from the design. `outcome-feedback` must distinguish `live` from `legacy_migrated`; `discovery-evidence` must distinguish search, submitted URL, and import row provenance. OpenAPI must define every path in Section 16, Bearer auth, cursor pagination, `Idempotency-Key`, `AsyncOperation`, and the unified API error.

Add `contracts` to root workspaces, add `test:contracts`, and run contract tests first in root `test`.

- [ ] **Step 4: Run contract and regression gates**

Run:

```bash
npm run test:contracts
npm run build
npm test
git diff --check
```

Expected: all commands exit 0; contract output reports 24 compiled schemas, 3 valid examples, and valid OpenAPI.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json contracts
git commit -m "feat: freeze AI acquisition v1 contracts"
```

---

### Task 2: Upgrade the runtime floor and stabilize model configuration IDs

**Files:**
- Modify: `package.json`
- Modify: `backend/package.json`
- Modify: `frontend/package.json`
- Modify: `deploy-ubuntu.sh`
- Modify: `deploy/baota/BAOTA-INSTALL.txt`
- Modify: `deploy/baota/install-baota.sh`
- Create: `backend/src/model-config-migration-test.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/schema.mysql.sql`
- Modify: `backend/src/mysql-store.ts`

**Interfaces:**
- Consumes: Node `>=22.19.0` and UUID requirements from the design.
- Produces: deterministic UUID IDs and a runtime/deployment floor compatible with Pi 0.81.1.

- [ ] **Step 1: Write failing UUID and runtime tests**

Create `backend/src/model-config-migration-test.ts`:

```ts
import assert from "node:assert/strict";
import { createAiModelConfigId, requiredNodeVersion } from "./model-providers/connection-service.js";

assert.equal(requiredNodeVersion, ">=22.19.0");
const ids = new Set(Array.from({ length: 2_000 }, () => createAiModelConfigId()));
assert.equal(ids.size, 2_000);
for (const id of ids) {
  assert.match(id, /^ai_[0-9a-f-]{36}$/);
}
console.log(JSON.stringify({ ok: true, ids: ids.size }));
```

- [ ] **Step 2: Verify RED**

Run:

```bash
NODE_ENV=test npx tsx backend/src/model-config-migration-test.ts
```

Expected: FAIL with module/function not found.

- [ ] **Step 3: Implement the runtime floor and UUID factory**

Create `backend/src/model-providers/connection-service.ts` with:

```ts
import { randomUUID } from "node:crypto";

export const requiredNodeVersion = ">=22.19.0";
export function createAiModelConfigId() {
  return `ai_${randomUUID()}`;
}
```

Use `createAiModelConfigId()` in the AI configuration create route. Add `"engines": { "node": ">=22.19.0" }` to all workspace packages. Change Ubuntu NodeSource to `node_22.x`, require major 22 and minor 19 or newer, and update both deployment documents to `22.19+`.

- [ ] **Step 4: Verify GREEN and deployment text**

Run:

```bash
NODE_ENV=test npx tsx backend/src/model-config-migration-test.ts
rg -n "22\\.19|node_22" package.json backend/package.json frontend/package.json deploy-ubuntu.sh deploy/baota
npm run build
npm test
```

Expected: UUID test reports 2,000 unique IDs; all runtime locations require 22.19+; build and baseline tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json backend/package.json frontend/package.json deploy-ubuntu.sh deploy/baota backend/src/model-providers/connection-service.ts backend/src/model-config-migration-test.ts backend/src/server.ts backend/schema.mysql.sql backend/src/mysql-store.ts
git commit -m "fix: stabilize AI config IDs and Node runtime"
```

---

### Task 3: Enforce BYOK connection activation and immutable job snapshots

**Files:**
- Create: `backend/src/model-providers/types.ts`
- Modify: `backend/src/model-providers/connection-service.ts`
- Create: `backend/src/model-providers/job-snapshot.ts`
- Create: `backend/src/model-connection-service-test.ts`
- Modify: `backend/src/types.ts`
- Modify: `backend/src/store.ts`
- Modify: `backend/schema.mysql.sql`
- Modify: `backend/src/mysql-store.ts`
- Modify: `backend/src/server.ts`

**Interfaces:**
- Consumes: `ModelConnection`, `ModelCapabilitySnapshot`, and `AiJobModelSnapshot` contract schemas.
- Produces: `activateModelConnection(store, scope, id, actorId, reason)` and `createAiJobModelSnapshot(connection, credentialVersion, versions)`.

- [ ] **Step 1: Write failing single-active and snapshot tests**

```ts
const first = createConnection({ ownerId: "u1", provider: "moonshot", active: true });
const second = createConnection({ ownerId: "u1", provider: "zhipu", active: false });
activateModelConnection(store, { ownerId: "u1", teamId: "t1" }, second.id, "u1", "switch");
assert.equal(store.connections.filter(item => item.ownerId === "u1" && item.active).length, 1);
assert.equal(store.connections.find(item => item.id === second.id)?.active, true);

const snapshot = createAiJobModelSnapshot(second, 3, {
  promptVersion: "lead-plan.v1",
  schemaVersion: "acquisition-plan.v1"
});
activateModelConnection(store, { ownerId: "u1", teamId: "t1" }, first.id, "u1", "switch back");
assert.equal(snapshot.connectionId, second.id);
assert.equal(snapshot.credentialVersion, 3);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
NODE_ENV=test npx tsx backend/src/model-connection-service-test.ts
```

Expected: FAIL because activation and snapshot services do not exist.

- [ ] **Step 3: Implement connection, credential version, and audit services**

Define exact provider IDs, capability statuses, encrypted credential version references, activation events, and snapshots in `types.ts`. Activation must execute as one MySQL transaction and use a database invariant that prevents more than one active row per owner. Existing multiple-enabled data migrates by `updated_at DESC, id ASC`; old encrypted keys become credential version 1. Updating a key creates a new version, and deleting an in-use connection returns `connection_in_use`.

- [ ] **Step 4: Verify GREEN and migrations**

Run:

```bash
NODE_ENV=test npx tsx backend/src/model-connection-service-test.ts
npm run test:security --workspace backend
npm run build
npm test
```

Expected: activation, snapshot immutability, masking, and connection-in-use cases pass; no plaintext key appears.

- [ ] **Step 5: Commit**

```bash
git add backend/src/model-providers backend/src/model-connection-service-test.ts backend/src/types.ts backend/src/store.ts backend/schema.mysql.sql backend/src/mysql-store.ts backend/src/server.ts
git commit -m "feat: add immutable BYOK model connections"
```

---

### Task 4: Add the provider catalog, active model gateway, and call ledger

**Files:**
- Create: `backend/src/model-providers/catalog.ts`
- Create: `backend/src/model-providers/call-ledger.ts`
- Create: `backend/src/model-providers/gateway.ts`
- Create: `backend/src/model-providers/adapters/openai-compatible.ts`
- Create: `backend/src/model-gateway-test.ts`
- Modify: `backend/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `AiJobModelSnapshot` from Task 3.
- Produces: `ActiveModelGateway.healthCheck`, `listModels`, `generateStructured`, `callTools`, `streamText`, and append-only `ModelCallRecord`.

- [ ] **Step 1: Write failing gateway tests**

Use a local injected `fetch` that returns deterministic OpenAI-compatible responses. Assert structured JSON validates, tool calls normalize, 429 is retryable without changing `connectionId`, and every ledger attempt includes:

```ts
{
  ownerId: "u1",
  teamId: "t1",
  jobId: "job_1",
  attemptId: "attempt_1",
  connectionId: "conn_moonshot",
  credentialVersion: 2,
  capabilitySnapshotHash: "cap_hash"
}
```

Then switch the active connection in the store and retry the same job; assert the second attempt still uses `conn_moonshot` and credential version 2.

- [ ] **Step 2: Verify RED**

Run:

```bash
NODE_ENV=test npx tsx backend/src/model-gateway-test.ts
```

Expected: FAIL because the gateway and ledger do not exist.

- [ ] **Step 3: Implement the minimal gateway and catalog**

The catalog must contain exactly:

```ts
[
  "openai", "moonshot", "minimax", "zhipu", "deepseek",
  "qwen", "doubao", "hunyuan", "qianfan"
]
```

`generateStructured` validates the requested Schema, performs one same-model repair attempt, and then fails with `MODEL_SCHEMA_INVALID`. `callTools` rejects before the network call unless the certified model has `toolCalling = supported`. The call ledger stores hashes and metadata only, never raw Prompt/output or credentials.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
NODE_ENV=test npx tsx backend/src/model-gateway-test.ts
npm run test:security --workspace backend
npm run build
npm test
```

Expected: deterministic gateway tests, security tests, build, and baseline tests all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/model-providers backend/src/model-gateway-test.ts backend/package.json package-lock.json
git commit -m "feat: add auditable active model gateway"
```

---

## Foundation Completion Gate

Run:

```bash
npm run test:contracts
NODE_ENV=test npx tsx backend/src/model-config-migration-test.ts
NODE_ENV=test npx tsx backend/src/model-connection-service-test.ts
NODE_ENV=test npx tsx backend/src/model-gateway-test.ts
npm run test:security --workspace backend
npm run build
npm test
git diff --check
```

All commands must exit 0 before the model-adapter, discovery-pipeline, intelligence, CRM, Copilot, and UI implementation plans begin.
