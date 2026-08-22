# Acquisition Evidence Read OpenAPI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the already-running `GET /api/v1/acquisition/evidence/{id}` endpoint to the normative static OpenAPI v1 contract with a typed `DiscoveryEvidence` response.

**Architecture:** Treat `contracts/openapi/ai-acquisition.v1.yaml` as the normative public v1 contract for this slice. The Express route and runtime OpenAPI generator already expose the endpoint, so this change is additive contract synchronization only; it must not alter runtime behavior or remove legacy contract routes.

**Tech Stack:** OpenAPI 3.1 YAML, Node.js test runner, YAML parser, Swagger Parser, JSON Schema.

## Global Constraints

- Follow strict TDD: edit the test first, run it, and confirm it fails because the OpenAPI path is absent before editing YAML.
- Do not modify backend production code; the route and runtime OpenAPI entry already exist.
- Do not remove or rename any legacy static OpenAPI path in this slice.
- The endpoint is read-only, bearer-authenticated, and returns `#/components/schemas/DiscoveryEvidence` on HTTP 200.
- The path uses the existing required `#/components/parameters/id` path parameter and existing `ApiError` response on HTTP 401.
- Preserve the existing OpenAPI 3.1 and JSON Schema registry behavior.
- Do not stage or commit the pre-existing untracked file `docs/superpowers/plans/2026-07-23-ai-model-adapters-and-pi.md`.

---

### Task 1: Publish the evidence read endpoint in the static v1 contract

**Files:**
- Modify: `contracts/test/openapi.test.mjs`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`

**Interfaces:**
- Consumes: the existing runtime route `GET /api/v1/acquisition/evidence/:id` and existing `DiscoveryEvidence` OpenAPI component.
- Produces: the normative static operation `GET /api/v1/acquisition/evidence/{id}` with typed HTTP 200 and 401 responses.

- [ ] **Step 1: Write the failing contract assertion**

In `contracts/test/openapi.test.mjs`, add this literal entry to `section16`:

```js
"/api/v1/acquisition/evidence/{id}": ["get"],
```

Add this literal entry to `reads`:

```js
"/api/v1/acquisition/evidence/{id}": "DiscoveryEvidence",
```

These assertions deliberately reuse the existing behavior test so they verify exact path/method coverage, bearer security, typed authentication error, and the typed HTTP 200 response.

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
npm run test:contracts
```

Expected: FAIL in `OpenAPI exactly covers Section 16 with typed, authenticated responses` because the static document does not contain `/api/v1/acquisition/evidence/{id}`. A syntax error or unrelated failure does not count as RED.

- [ ] **Step 3: Add the minimal OpenAPI operation**

In `contracts/openapi/ai-acquisition.v1.yaml`, immediately after the import-operation detail path and before acquisition plans, add:

```yaml
  /api/v1/acquisition/evidence/{id}:
    parameters: [{ $ref: '#/components/parameters/id' }]
    get:
      <<: *read
      summary: Get discovery evidence
      responses:
        '200':
          description: Discovery evidence
          content:
            application/json:
              schema: { $ref: '#/components/schemas/DiscoveryEvidence' }
        '401': *apiError
```

Do not change anchors, shared schemas, other paths, or backend code.

- [ ] **Step 4: Run focused verification and verify GREEN**

Run:

```bash
npm run test:contracts
```

Expected: 9 tests pass, 0 fail.

- [ ] **Step 5: Run regression verification**

Run:

```bash
npm run test:acquisition --workspace backend
npm run build --workspace backend
git diff --check
```

Expected: all commands exit 0. The acquisition suite must retain all existing passing tests.

- [ ] **Step 6: Self-review and commit only the task files**

Confirm the diff contains only the two task files, then commit:

```bash
git add contracts/test/openapi.test.mjs contracts/openapi/ai-acquisition.v1.yaml
git commit -m "docs: publish acquisition evidence read contract"
```

The report must include the observed RED failure, the GREEN result, regression commands, commit SHA, and any concern.
