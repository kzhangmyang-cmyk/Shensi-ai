# Acquisition Model Content and Judgments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely run dynamic acquisition turns and four model judgment
operations through an immutable official BYOK snapshot.

**Architecture:** `ActiveModelGateway` retains its existing literal request
path and gains an opt-in trusted content-bundle path. Acquisition code owns one
versioned bundle; factories verify persisted snapshot hashes against it, while
bound requests provide only registry IDs and canonical dynamic data.

**Tech Stack:** TypeScript 5.7, Node.js 22, Zod 3, Node assert/tsx tests.

## Global Constraints

- Do not change `server.ts`, MySQL repositories, or files owned by other agents.
- Preserve existing direct gateway callers.
- Use the persisted owner/team-scoped snapshot and exact credential version.
- Never create evidence, review tasks, conversions, or outreach.
- Never send private data or credentials to the model.
- Store money in integer minor units and rates in basis points.
- Every production behavior starts with a failing test.

---

### Task 1: Trusted acquisition content bundle

**Files:**
- Create: `backend/src/acquisition-model-content.ts`
- Modify: `backend/src/model-providers/gateway.ts`
- Modify: `backend/src/model-providers/runtime.ts`
- Test: `backend/src/model-gateway-test.ts`

**Interfaces:**
- Produces: `ModelContentBundle`, `modelContentBundleHashes()`, and bound
  `callTools` requests containing `{ promptId, toolSchemaId, dynamicData }`.
- Preserves: literal `{ prompt, tools, schemaHash }` calls.

- [ ] Write a gateway test whose snapshot hashes the bundle and whose bound
  request contains no literal prompt or tools.
- [ ] Run it and observe failure because bound requests are unsupported.
- [ ] Implement canonical bundle hashing, registered lookup, gateway rendering,
  and construction-time hash verification.
- [ ] Run the focused gateway test and existing gateway regression suite.

### Task 2: Pi binding and factory authority

**Files:**
- Modify: `backend/src/acquisition-pi-tools.ts`
- Modify: `backend/src/acquisition-pi-agent.ts`
- Modify: `backend/src/acquisition-pi-gateway-runtime.ts`
- Modify: `backend/src/acquisition-pi-runtime-factory.ts`
- Test: `backend/src/acquisition-pi-gateway-runtime-test.ts`
- Test: `backend/src/acquisition-pi-runtime-factory-test.ts`

**Interfaces:**
- Produces: `ACQUISITION_MODEL_CONTENT_BUNDLE`,
  `ACQUISITION_MODEL_CONTENT_HASHES`, and a factory-created runtime using that
  bundle.

- [ ] Add a failing runtime test asserting a bound registry request and no
  caller-controlled literal prompt/schema.
- [ ] Add a failing factory test rejecting a persisted snapshot whose hashes do
  not equal the server bundle.
- [ ] Export immutable tool definitions, define the acquisition prompt/schema
  bundle, and validate Pi-provided tools against it.
- [ ] Inject the bundle into the production gateway and use persisted snapshot
  data rather than client-owned content.
- [ ] Run focused Pi and gateway tests.

### Task 3: Structured acquisition judgment port

**Files:**
- Create: `backend/src/acquisition-judgment-port.ts`
- Create: `backend/src/acquisition-judgment-port-test.ts`

**Interfaces:**
- Produces:
  `createAcquisitionJudgmentPort({ identity, snapshot, gateway })` implementing
  `research`, `qualify`, `buildBattleCard`, and
  `draftConnectionStrategy`.

- [ ] Write failing tests for the four methods and inspect their bound gateway
  requests.
- [ ] Implement one discriminated Zod schema and the minimal four method
  projections.
- [ ] Add failing tests for unknown evidence IDs, fact/inference/unknown
  separation, sensitive-data rejection, amount units, tenant scope, and
  requested-channel equality.
- [ ] Implement the safety validators and stable failures.
- [ ] Run the focused judgment and executor regression tests.

### Task 4: Verification and handoff

**Files:**
- Modify only files listed above if verification exposes an in-scope defect.

- [ ] Run all focused acquisition/Pi/gateway tests.
- [ ] Run backend TypeScript build.
- [ ] Run `git diff --check` and inspect the complete diff for unrelated files.
- [ ] Request independent code review and address important findings.
- [ ] Commit only this task's files and report the binding/migration interface.
