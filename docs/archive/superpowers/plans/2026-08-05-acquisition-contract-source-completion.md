# AI Acquisition Contract Source Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Issue #01 by making the production OpenAPI builder, the published OpenAPI 3.1 contract, generated frontend transport types, and CI drift checks agree on the real AI-acquisition API.

**Architecture:** During migration, `backend/src/acquisition-openapi.ts` is the authority for the currently published production surface and the Express routers are the behavior evidence. A semantic test harness compares normalized production and static operations incrementally. Once every acquisition operation is green, `contracts/openapi/ai-acquisition.v1.yaml` becomes the release contract used to generate committed frontend transport types.

**Tech Stack:** TypeScript, Node test runner, `tsx` 4.22.4, OpenAPI 3.1, JSON Schema Draft 2020-12, `yaml` 2.8.1, `@apidevtools/swagger-parser` 10.1.1, `openapi-typescript` 7.13.0, npm workspaces, GitHub Actions.

## Global Constraints

- Never publish direct production writes for evidence creation, candidate creation/evidence attachment/research/qualification/battle-card generation, or outcome creation; the production OpenAPI intentionally hides these workflow-internal writes.
- Preserve `GET /api/v1/acquisition/evidence/{id}` and all currently published legacy reads.
- Preserve `BattleCardV1 | BattleCardV2`; existing V1 cards remain readable.
- Read operations allow `bearerAuth` or `cookieAuth`; writes allow `bearerAuth` or `cookieAuth + csrfToken`.
- `If-Match`, `ETag`, `Idempotency-Key`, replay headers, success codes, and error codes must reflect actual router behavior rather than a universal write template.
- Existing JSON Schema V1 resources remain backward compatible; new platform/action resources are separate closed schemas.
- Do not invent a fixed Douyin action-type enum before the platform capability matrix is approved; capability/action keys remain non-empty bounded strings.
- Generated TypeScript contains transport contracts only. Handwritten ViewModels, labels, currency formatting, and UI state stay outside generated code.
- Runtime JSON response validation is not part of Issue #01; generated TypeScript is compile-time protection only.
- Do not import production code from GPL or no-license reference repositories.
- Do not modify or stage `docs/superpowers/plans/2026-07-23-ai-model-adapters-and-pi.md`.

---

### Task 1: Semantic drift harness and approved-plan tracer

**Files:**
- Create: `backend/src/acquisition-openapi-contract-test-helpers.ts`
- Create: `backend/src/acquisition-openapi-contract-drift-test.ts`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/auth.ts`
- Modify: `backend/src/security-test.ts`
- Modify: `backend/package.json`
- Modify: `package-lock.json`
- Modify: `contracts/json-schema/api-error.v1.schema.json`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `contracts/test/openapi.test.mjs`

**Interfaces:**
- Produces: `loadPublishedAcquisitionPaths(): Promise<Record<string, ContractPathItem>>`, where `ContractPathItem` is a test-only partial record of `get | post | patch | delete` operations.
- Produces: `operationSurface(operation)` returning normalized security, parameters with canonicalized schemas, dereferenced request schemas/media types, and dereferenced response statuses/headers/schemas/media types.
- Establishes canonical `POST /api/v1/acquisition/plans/{id}/approval`.

- [ ] **Step 1: Write a failing harness smoke test**

Create the drift-test file with a smoke test that imports the not-yet-created helper, loads the published YAML, and proves a known operation such as `GET /api/v1/acquisition/plans/{id}` can be normalized. The first failure is intentionally the missing helper module.

- [ ] **Step 2: Verify harness RED**

Run: `npm run test:contract-drift --workspace backend`

Expected: FAIL because `acquisition-openapi-contract-test-helpers.ts` does not exist.

- [ ] **Step 3: Implement the minimum compiling harness and verify its smoke test GREEN**

Add `yaml: "2.8.1"` and `@apidevtools/swagger-parser: "10.1.1"`, plus the dedicated backend script using `node --import tsx --test --test-concurrency=1 src/acquisition-openapi-contract-drift-test.ts`. Implement `loadPublishedAcquisitionPaths()` and `operationSurface()`. Dereference the static document and canonicalize OpenAPI 3.0 `nullable: true` to OpenAPI 3.1 null unions before schema equality; never compare source text.

Run: `npm run test:contract-drift --workspace backend`

Expected: PASS with the harness smoke test only.

- [ ] **Step 4: Add the failing approved-plan semantic comparison**

```ts
test("published plan approval matches the production contract", async () => {
  const published = await loadPublishedAcquisitionPaths();
  const production = createAcquisitionOpenApiPaths();
  const path = "/api/v1/acquisition/plans/{id}/approval";
  assert.equal(published["/api/v1/acquisition/plans/{id}/approve"], undefined);
  assert.deepEqual(
    operationSurface(published[path]!.post!),
    operationSurface(production[path]!.post!)
  );
  assert.deepEqual(
    published[path]!.post!.requestBody.content["application/json"].schema.required,
    ["decision", "reason"]
  );
  assert.ok(published[path]!.post!.responses["200"].headers.ETag);
});
```

- [ ] **Step 5: Verify contract RED**

Run: `npm run test:contract-drift --workspace backend`

Expected: FAIL because `/approval` is absent and `/approve` is still published.

- [ ] **Step 6: Implement the approval operation and real auth envelope**

In both OpenAPI sources publish `id` plus required `If-Match`, no idempotency key, write security alternatives, body `{ decision: "approve", reason: string }`, statuses `200/400/401/404/409/412/428/500`, a response `ETag`, and schema-equivalent success/error bodies.

Make `ApiError` backward-compatible with both existing flat and nested router envelopes using an explicit `oneOf`. Update `requireAuth` so unauthenticated, expired, disabled, and CSRF failures return the flat envelope with stable `code`, existing `message`, nullable `details`, request correlation ID, and `retryable: false`. Extend the real mounted-server security test to assert the acquisition 401/403 body against `ApiError`; this prevents builder↔YAML agreement from hiding actual middleware drift.

- [ ] **Step 7: Verify GREEN and regressions**

Run: `npm run test:contract-drift --workspace backend && npm run test:security --workspace backend && npm run test:contracts && npm run test:acquisition --workspace backend`

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add backend/src/acquisition-openapi-contract-test-helpers.ts backend/src/acquisition-openapi-contract-drift-test.ts backend/src/acquisition-openapi.ts backend/src/auth.ts backend/src/security-test.ts backend/package.json package-lock.json contracts/json-schema/api-error.v1.schema.json contracts/openapi/ai-acquisition.v1.yaml contracts/test/openapi.test.mjs
git commit -m "test: gate acquisition OpenAPI drift"
```

### Task 2: Plan, run, shard, presentation, and control contract alignment

**Files:**
- Create: `contracts/json-schema/acquisition-run-presentation.v1.schema.json`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `contracts/test/openapi.test.mjs`
- Modify: `contracts/test/schema-registry.test.mjs`
- Modify: `backend/src/acquisition-openapi-contract-drift-test.ts`
- Modify: `backend/src/acquisition-openapi.ts`

**Interfaces:**
- Consumes: Task 1 semantic harness.
- Produces canonical operations for plans, revisions, approval, nested run creation, run reads, shards, presentation, pause, resume, and cancel.

- [ ] **Step 1: Extend the drift test with the exact production inventory**

```ts
const planRunOperations = {
  "/api/v1/acquisition/plans": ["post"],
  "/api/v1/acquisition/plans/{id}": ["get", "patch"],
  "/api/v1/acquisition/plans/{id}/revisions": ["post"],
  "/api/v1/acquisition/plans/{id}/approval": ["post"],
  "/api/v1/acquisition/plans/{id}/runs": ["post"],
  "/api/v1/acquisition/runs/{id}": ["get"],
  "/api/v1/acquisition/runs/{id}/shards": ["get"],
  "/api/v1/acquisition/runs/{id}/presentation": ["get"],
  "/api/v1/acquisition/runs/{id}/pause": ["post"],
  "/api/v1/acquisition/runs/{id}/resume": ["post"],
  "/api/v1/acquisition/runs/{id}/cancel": ["post"]
};
```

Assert exact methods and `operationSurface` equality for every entry. Assert obsolete top-level `/runs`, `/operation-shards`, and plan `GET` list are absent. Assert create plan is `201`, create run is `202`, concurrency writes require `If-Match`, idempotent creation writes require `Idempotency-Key`, and presentation uses `after/limit` with `hasMore/nextAfter`.

- [ ] **Step 2: Verify RED**

Run: `npm run test:contract-drift --workspace backend`

Expected: FAIL on old paths, missing revisions/presentation, statuses, and concurrency headers.

- [ ] **Step 3: Synchronize schemas and both OpenAPI representations**

Define the closed Draft 2020-12 presentation schema. Presentation requires `run`, `providers`, `summary`, `candidateEvents`, `nextAfter`, and `hasMore`; `financialValue` remains nullable and currency totals remain separate rows. `POST /plans/{id}/revisions` returns the updated `AcquisitionPlan` with status `201`; do not publish a separate revision response DTO. Register the presentation component and update operation bodies/responses without changing Express behavior.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:contract-drift --workspace backend && npm run test:contracts && npm run test:acquisition --workspace backend`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add contracts backend/src/acquisition-openapi.ts backend/src/acquisition-openapi-contract-drift-test.ts
git commit -m "docs: align acquisition plan and run contracts"
```

### Task 3: Provider, content-fetch, and import contract alignment

**Files:**
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `contracts/test/openapi.test.mjs`
- Modify: `backend/src/acquisition-openapi-contract-drift-test.ts`
- Modify: `backend/src/acquisition-openapi.ts`

**Interfaces:**
- Consumes: Task 1 semantic harness.
- Produces the production discovery-operation surface without legacy `/fetch-operations` aliases.

- [ ] **Step 1: Add failing surface and status tests**

```ts
const discoveryOperations = {
  "/api/v1/acquisition/providers": ["get"],
  "/api/v1/acquisition/provider-connections": ["get", "post"],
  "/api/v1/acquisition/provider-connections/{id}": ["get", "patch", "delete"],
  "/api/v1/acquisition/provider-connections/{id}/test": ["post"],
  "/api/v1/acquisition/content-fetch-operations": ["get", "post"],
  "/api/v1/acquisition/content-fetch-operations/{id}": ["get"],
  "/api/v1/acquisition/import-operations": ["get", "post"],
  "/api/v1/acquisition/import-operations/{id}": ["get"]
};
```

Also assert provider connection create exposes `201` and replay `200` with `Idempotency-Replayed`, delete exposes `204` without an idempotency header, connection test exposes synchronous `200`, and import accepts exactly `text/csv`, XLSX, and `application/octet-stream`. Assert `application/json` is documented as unsupported and the real router returns `415 unsupported_media_type`.

- [ ] **Step 2: Verify RED**

Run: `npm run test:contract-drift --workspace backend`

Expected: FAIL on `/fetch-operations`, missing list methods, and incorrect statuses.

- [ ] **Step 3: Update the static release contract and production documentation gaps**

Replace the obsolete fetch paths, publish collection reads, copy the strict production filters/request media types, and document actual replay/delete/test behavior. Do not add unsupported optimistic concurrency to provider PATCH; document the current operation surface faithfully.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm run test:contract-drift --workspace backend && npm run test:contracts && npm run test:acquisition --workspace backend`

```bash
git add contracts/openapi/ai-acquisition.v1.yaml contracts/test/openapi.test.mjs backend/src/acquisition-openapi-contract-drift-test.ts backend/src/acquisition-openapi.ts
git commit -m "docs: align acquisition discovery contracts"
```

### Task 4: Candidate, financial-value, review, conversion, outcome-read, and Copilot alignment

**Files:**
- Create: `contracts/json-schema/financial-value-decision.v1.schema.json`
- Create: `contracts/json-schema/copilot-message.v1.schema.json`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `contracts/test/openapi.test.mjs`
- Modify: `contracts/test/schema-registry.test.mjs`
- Modify: `backend/src/acquisition-openapi-contract-drift-test.ts`
- Modify: `backend/src/acquisition-openapi.ts`

**Interfaces:**
- Produces the complete safe public candidate/Copilot/read surface.
- Preserves `DiscoveryEvidence`, `QualificationDecision`, `BattleCard`, `ReviewEvent`, and `OutcomeFeedback` response contracts.

- [ ] **Step 1: Write the failing inventory and safety assertions**

Assert semantic and dereferenced-schema parity for evidence GET, candidate list/detail/evidence, identity confirmation, qualification GET, financial-value GET, battle-card GET, reviews GET, review POST, convert POST, outcomes GET, audit GET, Copilot session create/read, messages GET/POST, and task GET. Assert static OpenAPI does not publish POST evidence, POST candidates, candidate evidence attachment/research/qualification/battle-card, or POST outcomes.

```ts
assert.equal(published["/api/v1/acquisition/candidates/{id}/financial-value"]?.get !== undefined, true);
assert.equal(published["/api/v1/acquisition/copilot/sessions/{id}/messages"]?.get !== undefined, true);
assert.equal(published["/api/v1/acquisition/evidence/{id}"]?.get !== undefined, true);
for (const path of blockedDirectWrites) assert.equal(published[path]?.post, undefined);
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:contract-drift --workspace backend`

Expected: FAIL on missing reads, identity confirmation, and forbidden published writes.

- [ ] **Step 3: Implement closed response contracts and synchronized operations**

Financial values exactly match the current public projection: `id`, `candidateId`, `qualificationDecisionId`, `version`, `grade`, `score`, `currency`, integer `expectedRevenueMinor`, `expectedGrossProfitMinor`, `expectedContributionMinor`, the six numeric `factors`, and `createdAt`; absence remains a `404` rather than invented nullable risk/status fields. Copilot messages require message identity, session, role, content, created time, and task linkage when present. Keep identity confirmation `If-Match` pattern and idempotency semantics from production.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm run test:contract-drift --workspace backend && npm run test:contracts && npm run test:acquisition --workspace backend`

```bash
git add contracts backend/src/acquisition-openapi.ts backend/src/acquisition-openapi-contract-drift-test.ts
git commit -m "docs: align acquisition candidate and copilot contracts"
```

### Task 5: Platform and action placeholder schema registry

**Files:**
- Create: `contracts/json-schema/platform-connection.v1.schema.json`
- Create: `contracts/json-schema/platform-capability-snapshot.v1.schema.json`
- Create: `contracts/json-schema/platform-event.v1.schema.json`
- Create: `contracts/json-schema/action-policy.v1.schema.json`
- Create: `contracts/json-schema/action-receipt.v1.schema.json`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `contracts/test/schema-registry.test.mjs`

**Interfaces:**
- Produces OpenAPI components `PlatformConnection`, `PlatformCapabilitySnapshot`, `PlatformEvent`, `ActionPolicy`, and `ActionReceipt` without publishing routes before Issues #06/#07/#10.

- [ ] **Step 1: Add failing registry and valid/invalid fixture tests**

Add the five filenames to the exact registry. For every schema validate one canonical object and one forbidden mutation. In particular assert capability/action keys accept `"future_official_capability"`, reject empty strings, `ActionPolicy` accepts only `auto_allowed | review_required | blocked`, and `ActionReceipt` requires immutable request/result hashes plus normalized outcome.

- [ ] **Step 2: Verify RED**

Run: `npm run test:contracts`

Expected: FAIL because all five schema files/components are absent.

- [ ] **Step 3: Create closed Draft 2020-12 schemas**

`PlatformConnection` stores tenant/team, connector/platform/account refs, scopes, credential version, sync mode/cursor, status, expiry, limits, and capability snapshot ref. `PlatformCapabilitySnapshot` stores connection/credential version, captured/expiry times, and string-keyed capability entries. `PlatformEvent` stores immutable platform/account/content/event/subject refs, hashes, occurrence/capture times, authorization snapshot, dedupe key, and access status. `ActionPolicy` stores plan/rule-bundle refs and per-action decisions. `ActionReceipt` stores intent/decision/job/connection/snapshot refs, idempotency key, external ID, normalized outcome/error, hashes, and timestamps.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm run test:contracts && npm run test:contract-drift --workspace backend`

```bash
git add contracts
git commit -m "feat: publish platform action placeholder contracts"
```

### Task 6: Deterministic generated frontend transport types

**Files:**
- Create: `frontend/src/features/ai-growth/generated/ai-acquisition.ts`
- Create: `frontend/src/features/ai-growth/contract-adapters.test.ts`
- Create: `contracts/scripts/generate-frontend-contract-types.mjs`
- Create: `contracts/test/generated-types.test.mjs`
- Modify: `frontend/src/features/ai-growth/api.ts`
- Modify: `frontend/src/features/ai-growth/types.ts`
- Modify: `contracts/package.json`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces root script `generate:frontend-contract-types`.
- Produces committed OpenAPI-generated `paths`, `components`, and `operations` types.
- Keeps `AdvisorState`, `*Vm`, demo records, and ViewModel mapping handwritten.

- [ ] **Step 1: Add a failing generated-type adapter test**

```ts
import type { components, paths } from "./generated/ai-acquisition.js";
const evidence: components["schemas"]["DiscoveryEvidence"] = {
  id: "evidence_1",
  targetType: "organization",
  sourcePlatform: "douyin",
  sourceTitle: "公开页面",
  sourceSnippet: "公开摘要",
  publishedAt: null,
  fetchedAt: "2026-08-05T00:00:00Z",
  locale: "zh-CN",
  rawArtifactHash: "sha256:raw",
  contentHash: "sha256:content",
  provenance: {
    kind: "user_submitted_url",
    sourceUrl: "https://www.douyin.com/video/1",
    submittedBy: "user_1"
  },
  accessStatus: "public_content"
};
const approval: paths["/api/v1/acquisition/plans/{id}/approval"]["post"]["requestBody"]["content"]["application/json"] = {
  decision: "approve",
  reason: "人工确认"
};
void evidence;
void approval;
```

The fixture must also prove an invalid decision fails with `// @ts-expect-error`. Run the frontend compiler before generation and observe the missing-module failure.

- [ ] **Step 2: Verify RED**

Run: `npm run build --workspace frontend`

Expected: FAIL because `generated/ai-acquisition.ts` does not exist.

- [ ] **Step 3: Pin and run generation**

Add `openapi-typescript: "7.13.0"` to the contracts workspace. Implement a deterministic script with this interface:

```text
node scripts/generate-frontend-contract-types.mjs [--check] [--input <yaml>] [--output <ts>]
```

Defaults point to the canonical YAML and committed frontend output. `--check` renders in memory and exits non-zero when the target is absent or stale; without it the script writes the generated bytes. Test the script against a temporary output: absent check fails, write succeeds, unchanged check succeeds, a corrupted output check fails. Define:

```json
"generate:types": "node scripts/generate-frontend-contract-types.mjs",
"check:types": "node scripts/generate-frontend-contract-types.mjs --check"
```

Root `generate:frontend-contract-types` delegates to `generate:types`, and root `check:generated-acquisition-types` delegates to `check:types` in the contracts workspace. Replace only duplicated transport DTOs in `api.ts`/`types.ts` with aliases or indexed generated operation/component types; preserve handwritten ViewModels.

- [ ] **Step 4: Verify GREEN and deterministic output**

Run: `npm run generate:frontend-contract-types && npm run check:generated-acquisition-types && npm run build --workspace frontend && npm run test --workspace frontend`

Expected: generation is stable, build and tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json contracts/package.json frontend/src/features/ai-growth
git commit -m "feat: generate acquisition frontend contract types"
```

### Task 7: Repository contract-drift CI and final verification

**Files:**
- Create: `.github/workflows/acquisition-contracts.yml`
- Create: `.nvmrc`
- Modify: `package.json`
- Modify: `contracts/README.md`
- Modify: `docs/product/2026-08-05-douyin-ai-acquisition-github-issues.md`

**Interfaces:**
- Produces root script `check:acquisition-contracts`.
- Produces a CI gate that fails on semantic drift or stale generated types.

- [ ] **Step 1: Promote the tested clean-generation check to the root gate**

Define root `check:generated-acquisition-types` as `npm run check:types --workspace contracts`. The Task 6 temporary-output test proves stale and absent outputs fail without mutating repository files.

- [ ] **Step 2: Add the root gate and workflow**

Pin `.nvmrc` to `22.22.3` and add root `engines.node` as `>=22.22.3 <23`. `check:acquisition-contracts` runs contract tests, backend semantic drift test, generated-file check, frontend build, and frontend tests. The GitHub workflow uses `actions/checkout@v4`, `actions/setup-node@v4` with `node-version-file: .nvmrc` and npm cache, `npm ci`, then `npm run check:acquisition-contracts`.

- [ ] **Step 3: Document the single-source workflow**

Document that production builder parity is required during migration, static OpenAPI 3.1 is the release/generation contract after the gate is green, platform routes are added only with their implementation Issues, and runtime response validation is later hardening. Mark Issue #01 complete without changing other Issue states.

- [ ] **Step 4: Run final verification**

Run:

```bash
npm run check:acquisition-contracts
npm test
npm run build
git diff --check c1e7223e21773dec69ec244afa59061ed636d319..HEAD
git status --short
```

Expected: all checks pass; only the pre-existing untracked `docs/superpowers/plans/2026-07-23-ai-model-adapters-and-pi.md` remains outside commits.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/acquisition-contracts.yml .nvmrc package.json contracts/README.md docs/product/2026-08-05-douyin-ai-acquisition-github-issues.md
git commit -m "ci: enforce acquisition contract source"
```
