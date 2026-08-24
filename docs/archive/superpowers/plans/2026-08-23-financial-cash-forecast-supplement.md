# Financial Cash Forecast Supplement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-attested 30/90-day cash forecast to the verified three-statement package so the real Financial Council can safely reach optimization and approval without inventing future cash data.

**Architecture:** Keep the existing three-file preview unchanged. At commit time, accept an optional closed cash-forecast supplement, stamp its authority fields on the server, merge it into a new immutable verified package, and bind its hash through the existing package/run/snapshot/formula chain. Existing consent-only clients remain safe and produce `not_computable`; the real 1.0.12 frontend requires the supplement before commit.

**Tech Stack:** TypeScript, Node.js 22, Express, MySQL 8.4/InnoDB, JSON Schema/OpenAPI 3.1, generated TypeScript contracts, Vite, Playwright Chromium, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-23-financial-cash-forecast-supplement-design.md`

## Global Constraints

- Historical statements never synthesize 30/90-day forecasts; missing supplement remains `not_computable`.
- Currency, workspace, actor, `acceptedBy`, `acceptedAt`, source and hashes are server-owned.
- Public DTOs are closed and generated from immutable Growth contract `1.0.12`; release `1.0.11` remains byte-for-byte unchanged.
- Four forecast amounts are non-negative safe integers; receivables are explicit, dense, unique, at most 100 rows, and canonically ordered by UTF-8 binary bytes.
- Raw workbook, customer names and monetary values never enter logs, URL, storage, idempotency keys or public server projections.
- Approval continues to create internal drafts/todos only; no external finance write is introduced.
- Real-browser acceptance uses real session/CSRF/routes/MySQL and no Playwright request interception.
- Real provider acceptance remains a separate fail-closed gate; missing credentials are BLOCKED, never skipped or reported PASS.
- Fast mode remains active: no CodeRabbit or independent review task, but every production change requires observed RED, focused GREEN and final verification.
- Do not change root, backend or frontend lockfiles.

---

### Task 1: Define and validate the management cash forecast

**Files:**
- Modify: `backend/src/financial-statement-package.ts`
- Modify: `backend/src/financial-statement-package-test.ts`

**Interfaces:**
- Consumes: existing `FinancialStatementPackagePreview`, `BusinessReportInput`, `canonicalBusinessReportInput`, server `now()` and authenticated actor.
- Produces:
  - `FinancialCashForecastSupplementInput`
  - `FinancialCashForecastSupplement`
  - `FinancialCashForecastPublicView`
  - `canonicalFinancialCashForecastSupplement(...)`
  - `buildVerifiedFinancialStatementPackage(...)`
  - `FinancialStatementPackage.forecastStatus`
  - `FinancialStatementPackage.cashForecast`

- [ ] **Step 1: Write the closed-input RED tests.**

Add table-driven tests that name the production behavior explicitly:

```ts
test("management cash forecast is closed, deterministic and server stamped", () => {
  const value = canonicalFinancialCashForecastSupplement({
    forecastAsOf: "2026-08-16T08:09:00.000Z",
    expectedInflowsNext30DaysMinor: 100_000,
    expectedOutflowsNext30DaysMinor: 500_000,
    expectedInflowsNext31To90DaysMinor: 800_000,
    expectedOutflowsNext31To90DaysMinor: 300_000,
    receivables: [
      { customer: "客户 B", amountMinor: 300_000, daysOutstanding: 30 },
      { customer: "客户 A", amountMinor: 1_000_000, daysOutstanding: 120 }
    ],
    attestation: { accepted: true,
      noticeVersion: "financial-cash-forecast.v1" }
  }, { currency: "CNY", acceptedBy: "u_admin",
    acceptedAt: "2026-08-16T08:10:00.000Z", period: "2026-08-16" });
  assert.equal(value.source, "management_attested");
  assert.equal(value.acceptedBy, "u_admin");
  assert.deepEqual(value.receivables.map((row) => row.customer),
    ["客户 A", "客户 B"]);
  assert.match(value.forecastHash, /^sha256:[0-9a-f]{64}$/u);
});
```

Add rejection cases for an unknown key, accessor, sparse array, duplicate normalized customer, 101 rows, zero receivable amount, negative/fractional/unsafe money, days outside `0..3650`, future `forecastAsOf`, old `forecastAsOf`, wrong notice and client-supplied authority fields.

- [ ] **Step 2: Run the domain tests and verify RED.**

```bash
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/financial-statement-package-test.ts
```

Expected: FAIL because the cash-forecast types and canonicalizer do not exist.

- [ ] **Step 3: Implement the minimal canonicalizer.**

Use code-point length and `Buffer.compare(Buffer.from(value, "utf8"), ...)` for stable ordering. Read property descriptors once into an immutable copy before validation. Build the hash only from this closed server record:

```ts
const preimage = {
  source: "management_attested" as const,
  forecastAsOf,
  currency: context.currency,
  expectedInflowsNext30DaysMinor,
  expectedOutflowsNext30DaysMinor,
  expectedInflowsNext31To90DaysMinor,
  expectedOutflowsNext31To90DaysMinor,
  receivables,
  acceptedBy: context.acceptedBy,
  acceptedAt: context.acceptedAt,
  noticeVersion: "financial-cash-forecast.v1" as const
};
return immutableFinancialCouncilValue({
  ...preimage,
  forecastHash: financialCouncilCanonicalHash(preimage)
});
```

Do not accept `currency`, `acceptedBy`, `acceptedAt`, `source` or `forecastHash` in the browser input.

- [ ] **Step 4: Write the pure package-enrichment RED tests.**

```ts
test("forecast commit replaces only the not-computable marker", async () => {
  const value = buildVerifiedFinancialStatementPackage(previewFixture(), {
    packageId: "package-1", consent: consent("u_admin"),
    cashForecast: forecastRecordFixture(),
    createdAt: "2026-08-16T08:10:00.000Z"
  });
  assert.equal(value.forecastStatus, "computed");
  assert.equal("forecast" in value.businessReport.cashFlow!, false);
  assert.deepEqual(value.businessReport.cashFlow!.receivables, [
    { customer: "客户 A", amountMinor: 1_000_000, daysOutstanding: 120 }
  ]);
  assert.equal(value.cashForecast?.acceptedBy, "u_admin");
});

test("consent-only commit preserves explicit not-computable cashflow", async () => {
  const value = buildVerifiedFinancialStatementPackage(previewFixture(), {
    packageId: "package-1", consent: consent("u_admin"),
    cashForecast: null, createdAt: "2026-08-16T08:10:00.000Z"
  });
  assert.equal(value.forecastStatus, "not_computable");
  assert.equal(value.cashForecast, null);
});
```

Also assert that the original preview is unchanged, `reportInputHash` changes only for enriched packages, and invalid supplements cannot produce a package.

- [ ] **Step 5: Run the domain tests and verify the enrichment RED.**

```bash
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/financial-statement-package-test.ts
```

Expected: FAIL because the pure verified-package builder does not exist.

- [ ] **Step 6: Implement the pure verified-package builder.**

`buildVerifiedFinancialStatementPackage` must clone the historical cash-flow row and replace only the marker:

```ts
const cashFlow = cashForecast === null
  ? preview.businessReport.cashFlow
  : {
      ...preview.businessReport.cashFlow,
      receivables: cashForecast.receivables,
      expectedInflowsNext30DaysMinor:
        cashForecast.expectedInflowsNext30DaysMinor,
      expectedOutflowsNext30DaysMinor:
        cashForecast.expectedOutflowsNext30DaysMinor,
      expectedInflowsNext31To90DaysMinor:
        cashForecast.expectedInflowsNext31To90DaysMinor,
      expectedOutflowsNext31To90DaysMinor:
        cashForecast.expectedOutflowsNext31To90DaysMinor
    };
```

Pass the resulting record to `canonicalBusinessReportInput`, recompute `reportInputHash`, then compute `packageHash` over the entire verified package preimage.

- [ ] **Step 7: Run focused GREEN and commit.**

```bash
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/financial-statement-package-test.ts
pnpm --filter ./backend build
git diff --check
git add backend/src/financial-statement-package.ts \
  backend/src/financial-statement-package-test.ts
git commit -m "feat(finance): attest management cash forecasts"
```

---

### Task 2: Persist the enriched package atomically in Memory and MySQL

**Files:**
- Modify: `backend/src/financial-statement-package-service.ts`
- Modify: `backend/src/financial-statement-package-service-test.ts`
- Modify: `backend/src/financial-statement-package-repository.ts`
- Modify: `backend/src/financial-statement-package-repository-contract-test.ts`
- Modify: `backend/src/financial-statement-package-repository-test.ts`
- Modify: `backend/src/financial-statement-package-mysql-repository.ts`
- Modify: `backend/src/financial-statement-package-mysql-repository-test.ts`
- Modify: `backend/src/financial-statement-package-mysql-integration-test.ts`

**Interfaces:**
- Consumes: Task 1 canonical supplement and `buildVerifiedFinancialStatementPackage`.
- Produces: identical Memory/MySQL commit, replay, read and tamper behavior; no new SQL table or raw-data column.

- [ ] **Step 1: Extend the shared repository contract tests and prove RED.**

Add one shared case used by both implementations:

```ts
test(`${label}: forecast commit is immutable and exact-replay safe`, async () => {
  await repository.appendPreview(previewFixture());
  const first = await repository.commitPreview(commitFixture({
    cashForecast: forecastRecordFixture()
  }));
  const replay = await repository.commitPreview(commitFixture({
    cashForecast: forecastRecordFixture()
  }));
  assert.equal(first.value.forecastStatus, "computed");
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.packageHash, first.value.packageHash);
  await assert.rejects(() => repository.commitPreview(commitFixture({
    requestHash: HASH("changed"), cashForecast: changedForecastRecordFixture()
  })), rejected("financial_statement_idempotency_conflict"));
});
```

Add read corruption cases for changed `forecastHash`, changed amount with re-signed package hash, changed `acceptedBy`, duplicate receivable and mismatched `reportInputHash`. Each must return `financial_statement_package_tampered` or `financial_statement_package_integrity`, never a parser exception.

Add service cases proving it stamps `acceptedBy=context.actorId`, `acceptedAt=this.now()`, preview currency and preview period, forwards one canonical supplement, leaves consent-only commits not-computable, and performs zero repository writes for invalid input.

Run:

```bash
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/financial-statement-package-service-test.ts \
  src/financial-statement-package-repository-test.ts \
  src/financial-statement-package-mysql-repository-test.ts
```

Expected: RED because repository commit ignores the supplement and read validation is only outer-hash validation.

- [ ] **Step 2: Make Memory use the shared verified-package builder.**

Extend `CommitFinancialStatementPackageInput` with:

```ts
readonly cashForecast: FinancialCashForecastSupplement | null;
```

After locking preview and before any write, call the shared builder. Strengthen `assertPackage` to revalidate the closed supplement, enriched business report, `reportInputHash`, forecast status and package hash. Preserve the current serial section and zero mutation on every rejection.

`FinancialStatementPackageService.commit` must first canonicalize the browser input with server authority, then pass the canonical supplement or `null` to the repository. The package ID remains bound to workspace, preview and request hash; no raw field is added to the ID.

- [ ] **Step 3: Make MySQL use the same builder inside one transaction.**

After `SELECT ... FOR UPDATE`, build the package from the locked preview and canonical supplement, then insert package, idempotency response and `committed_package_id` before commit. Do not alter the three-table DDL. Ensure every error after the package insert rolls back all three mutations.

- [ ] **Step 4: Add fake-MySQL rollback and parser GREEN tests.**

Inject failures after:

1. package insert;
2. idempotency insert;
3. preview update.

For each failure, assert preview remains uncommitted, package count stays zero and retry succeeds with one canonical package. Add a self-rehashed malformed supplement row and assert the parser rejects it.

- [ ] **Step 5: Add the live two-connection integration case.**

In `financial-statement-package-mysql-integration-test.ts`, use the existing owned random database helper and two distinct `CONNECTION_ID()` values. Race two exact commit requests and assert one creation plus one exact replay; race changed forecasts and assert one winner plus one conflict. Re-open a second pool and verify forecast/package/report hashes and accepted authority fields are identical.

- [ ] **Step 6: Run focused GREEN and commit.**

```bash
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/financial-statement-package-service-test.ts \
  src/financial-statement-package-repository-test.ts \
  src/financial-statement-package-mysql-repository-test.ts
pnpm --filter ./backend test:financial-statements
pnpm --filter ./backend build
git diff --check
git add backend/src/financial-statement-package-service.ts \
  backend/src/financial-statement-package-service-test.ts \
  backend/src/financial-statement-package-repository.ts \
  backend/src/financial-statement-package-repository-contract-test.ts \
  backend/src/financial-statement-package-repository-test.ts \
  backend/src/financial-statement-package-mysql-repository.ts \
  backend/src/financial-statement-package-mysql-repository-test.ts \
  backend/src/financial-statement-package-mysql-integration-test.ts
git commit -m "feat(finance): persist forecast-bound statement packages"
```

The live integration is conditional only in the ordinary aggregate script. During final acceptance it must be run with the existing short-lived least-privilege MySQL account and produce no skip.

---

### Task 3: Publish the 1.0.12 contract and close the runtime route

**Files:**
- Modify: `backend/src/financial-statement-package-router.ts`
- Modify: `backend/src/financial-statement-package-router-test.ts`
- Modify: `contracts/json-schema/finance-import-operation.v1.schema.json`
- Modify: `contracts/openapi/growth-advisor-quote-roi.v1.yaml`
- Modify: `contracts/test/schema-registry.test.mjs`
- Modify: `contracts/test/growth-openapi.test.mjs`
- Modify: `contracts/test/growth-contract-release.test.mjs`
- Modify: `contracts/test/generated-types.test.mjs`
- Create: `contracts/releases/growth-advisor-quote-roi/1.0.12/openapi.json`
- Create: `contracts/releases/growth-advisor-quote-roi/1.0.12/manifest.json`
- Modify: `backend/src/growth-contract-types-test.ts`
- Modify: `backend/src/growth-openapi-test.ts`
- Modify: `backend/src/growth-openapi-contract-drift-test.ts`
- Modify: `backend/src/growth-openapi-response-conformance-test.ts`
- Modify: `backend/src/catalog-runtime-response-conformance-test.ts`
- Modify: `backend/src/quote-runtime-response-conformance-test.ts`
- Modify: `backend/src/financial-council-router-test.ts`
- Modify: `frontend/scripts/check-growth-contract.mjs`
- Modify: `frontend/contracts/pinned/growth-advisor-quote-roi.openapi.json`
- Modify: `frontend/contracts/pinned/growth-advisor-quote-roi.manifest.json`
- Modify: `frontend/src/generated/growth-advisor-quote-roi.ts`
- Modify: `frontend/src/growth/contracts.ts`
- Modify: `frontend/tests/fixtures/growth-contract.ts`
- Modify: `frontend/tests/fixtures/growth-contract.self-test.ts`
- Modify: `contracts/README.md`

**Interfaces:**
- Consumes: Task 1/2 domain and public projection.
- Produces: immutable Growth release `1.0.12`, exact runtime/static/generated parity, and commit body that accepts exactly consent-only or consent+cashForecast.

- [ ] **Step 1: Write contract and router RED tests.**

```js
test("1.0.12 exposes a closed management cash forecast", async () => {
  const commit = schema.$defs.FinancialStatementConsentInput;
  assert.deepEqual(commit.required.sort(), ["consent"]);
  assert.equal(commit.properties.cashForecast.$ref,
    "#/$defs/FinancialCashForecastSupplementInput");
  assert.equal(schema.$defs.FinancialCashForecastSupplementInput
    .properties.receivables.maxItems, 100);
});
```

```ts
test("commit forwards only a closed forecast with server authority", async () => {
  const response = await requestCommit({
    consent: { accepted: true, noticeVersion: "financial-model-data.v1" },
    cashForecast: forecastBody()
  });
  assert.equal(response.status, 201);
  assert.equal(recorded.cashForecast.currency, undefined);
  assert.equal(recorded.cashForecast.acceptedBy, undefined);
  assert.equal(response.body.cashForecast.receivablesCount, 1);
  assert.equal(JSON.stringify(response.body).includes("客户 A"), false);
});
```

Add negative router cases for extra root/supplement/attestation/receivable keys, client authority fields, 101 rows, unsafe numbers, future timestamp, missing consent and changed idempotent replay.

- [ ] **Step 2: Run and verify RED.**

```bash
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/financial-statement-package-router-test.ts
pnpm test:contracts
```

Expected: router rejects the new field and the editable schema still reports 1.0.11.

- [ ] **Step 3: Implement the exact runtime parser and public projection.**

Accept only these two root key sets:

```ts
const keys = Object.keys(req.body).sort().join("\0");
if (keys !== "consent" && keys !== "cashForecast\0consent") {
  throw new GrowthHttpError(422, "financial_statement_input_invalid");
}
```

The router forwards only the closed browser input. The service owns all authority fields. `project(...)` returns `forecastStatus` and the sanitized `cashForecast` summary, never receivable rows.

- [ ] **Step 4: Update JSON Schema and OpenAPI to 1.0.12.**

Define `FinancialCashForecastReceivableInput`, `FinancialCashForecastSupplementInput`, `FinancialCashForecastPublicView`, add optional `cashForecast` to `FinancialStatementConsentInput`, and require `forecastStatus` plus nullable `cashForecast` in the package response. Use JSON Schema integer bounds and `additionalProperties:false` at every object level.

Advance `info.version` to `1.0.12`. Update all current-version assertions; do not edit `contracts/releases/.../1.0.11`.

- [ ] **Step 5: Generate and import the immutable release.**

```bash
git diff --exit-code 16d2062 -- \
  contracts/releases/growth-advisor-quote-roi/1.0.11
pnpm build:growth-contract-release
pnpm test:contracts
pnpm --filter ./frontend contract:import -- --release \
  ../contracts/releases/growth-advisor-quote-roi/1.0.12
pnpm --filter ./frontend contract:generate
pnpm --filter ./frontend contract:check
pnpm --filter ./frontend test:growth:fixture
```

Update `frontend/scripts/check-growth-contract.mjs` to pin `1.0.12`, and add generated-derived aliases in `frontend/src/growth/contracts.ts`; do not duplicate the DTO manually.

- [ ] **Step 6: Run public-boundary GREEN gates.**

```bash
pnpm test:contracts
pnpm check:growth-contract-release
pnpm --filter ./backend test:growth-openapi
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/financial-statement-package-router-test.ts \
  src/growth-openapi-response-conformance-test.ts
pnpm --filter ./frontend test:types
git diff --check
git diff --exit-code 16d2062 -- \
  contracts/releases/growth-advisor-quote-roi/1.0.11
```

- [ ] **Step 7: Update contract docs and commit.**

Update `contracts/README.md` so `1.0.12` is the current release and accurately states that old consent-only commits remain not-computable.

```bash
git add backend/src/financial-statement-package-router* \
  backend/src/growth-contract-types-test.ts backend/src/growth-openapi* \
  backend/src/catalog-runtime-response-conformance-test.ts \
  backend/src/quote-runtime-response-conformance-test.ts \
  backend/src/financial-council-router-test.ts \
  contracts/json-schema/finance-import-operation.v1.schema.json \
  contracts/openapi/growth-advisor-quote-roi.v1.yaml \
  contracts/releases/growth-advisor-quote-roi/1.0.12 \
  contracts/test contracts/README.md \
  frontend/scripts/check-growth-contract.mjs frontend/contracts/pinned \
  frontend/src/generated/growth-advisor-quote-roi.ts \
  frontend/src/growth/contracts.ts frontend/tests/fixtures
git commit -m "feat(finance): publish cash forecast contract"
```

---

### Task 4: Add the private forecast form and real frontend control

**Files:**
- Create: `frontend/src/growth/agents/cash-forecast-draft.ts`
- Create: `frontend/src/growth/agents/cash-forecast-draft.self-test.ts`
- Modify: `frontend/src/growth/agents/real-api.ts`
- Modify: `frontend/src/growth/agents/real-api.self-test.ts`
- Modify: `frontend/src/growth/agents/real-controller.ts`
- Modify: `frontend/src/growth/agents/real-controller.self-test.ts`
- Modify: `frontend/src/growth/agents/entry.ts`
- Modify: `frontend/src/growth/agents/view.ts`
- Modify: `frontend/src/growth/agents/view.self-test.ts`
- Modify: `frontend/src/growth/styles.css`

**Interfaces:**
- Consumes: generated `FinancialCashForecastSupplementInput` and 1.0.12 package view.
- Produces: decimal-string form controller, closed API request, lifecycle-safe private draft, and accessible responsive UI.

- [ ] **Step 1: Write decimal parsing and private-draft RED tests.**

```ts
test("money parser converts decimal major units without floating point", () => {
  assert.equal(parseMajorMoneyToMinor("0"), 0);
  assert.equal(parseMajorMoneyToMinor("12345.67"), 1_234_567);
  for (const value of ["-1", "1.001", "1e3", "NaN", " 1 ", ""]) {
    assert.throws(() => parseMajorMoneyToMinor(value), /cash_forecast_invalid/u);
  }
});

test("draft clears raw values on commit, close and replacement preview", () => {
  const draft = createFinancialCashForecastDraft();
  draft.setAmount("inflow30", "123.45");
  draft.addReceivable({ customer: "客户 A", amount: "10.00",
    daysOutstanding: "120" });
  assert.equal(draft.toInput("2026-08-16T08:09:00.000Z")
    .receivables[0]!.amountMinor, 1_000);
  draft.clear();
  assert.equal(JSON.stringify(draft.snapshot()).includes("客户 A"), false);
});
```

Run:

```bash
pnpm --dir frontend exec tsx \
  src/growth/agents/cash-forecast-draft.self-test.ts
```

Expected: module missing.

- [ ] **Step 2: Implement the isolated draft controller.**

Store raw strings only inside the closure. Expose `snapshot()` for immediate form rendering, `isComplete()`, `toInput(forecastAsOf)`, `clear()` and field mutators. Never call `Number`, `parseFloat` or arithmetic on a floating-point major-unit value; parse with `/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/u` and construct minor units from integer strings.

- [ ] **Step 3: Write real API/controller RED tests.**

Assert the exact body sent by `commitStatements`:

```ts
assert.deepEqual(request.body, {
  consent: { accepted: true, noticeVersion: "financial-model-data.v1" },
  cashForecast: {
    forecastAsOf: "2026-08-16T08:09:00.000Z",
    expectedInflowsNext30DaysMinor: 100_000,
    expectedOutflowsNext30DaysMinor: 500_000,
    expectedInflowsNext31To90DaysMinor: 800_000,
    expectedOutflowsNext31To90DaysMinor: 300_000,
    receivables: [{ customer: "客户 A", amountMinor: 1_000_000,
      daysOutstanding: 120 }],
    attestation: { accepted: true,
      noticeVersion: "financial-cash-forecast.v1" }
  }
});
```

Add controller cases for incomplete forecast, changed preview, commit retry same semantic hash, 409/412 preserving draft, success clearing draft, request A finishing after request B, close/destroy/logout abort, and package response with malformed forecast summary.

- [ ] **Step 4: Run and prove RED.**

```bash
pnpm --dir frontend exec tsx src/growth/agents/real-api.self-test.ts
pnpm --dir frontend exec tsx src/growth/agents/real-controller.self-test.ts
```

Expected: commit API/controller still sends consent only.

- [ ] **Step 5: Implement API, controller and lifecycle.**

Change `RealAgentCenterApi.commitStatements` to accept the generated commit DTO. Change controller commit to require one already parsed `FinancialCashForecastSupplementInput`; its semantic idempotency input contains a local SHA-256 digest of the canonical supplement, never raw customer/amount text. Success, close, destroy, logout and new preview clear the draft; 409/412 retain it.

- [ ] **Step 6: Write the view/entry RED tests.**

Assert exact labels and controls:

```ts
assert.match(html, /未来 30 天预计流入/u);
assert.match(html, /第 31–90 天预计流出/u);
assert.match(html, /data-cash-forecast-receivable-add/u);
assert.match(html, /当前没有应收账款/u);
assert.match(html, /financial-cash-forecast\.v1/u);
```

Assert commit is disabled until four amounts, explicit receivables state and attestation are complete. Assert customer and amounts never appear in `data-*`, URL, storage or console and are absent after commit.

- [ ] **Step 7: Implement accessible responsive UI.**

Render the forecast section only after preview. Use labeled `inputmode="decimal"` text inputs for money, `inputmode="numeric"` for aging, add/remove row controls, an explicit empty-receivables choice, and the attestation checkbox. Keep the current black shell, focus visibility and one-column layout at 390px. Do not put raw values into element IDs or data attributes.

- [ ] **Step 8: Run frontend GREEN and commit.**

```bash
pnpm --dir frontend exec tsx \
  src/growth/agents/cash-forecast-draft.self-test.ts
pnpm --dir frontend exec tsx src/growth/agents/real-api.self-test.ts
pnpm --dir frontend exec tsx src/growth/agents/real-controller.self-test.ts
pnpm --dir frontend exec tsx src/growth/agents/view.self-test.ts
pnpm --filter ./frontend test
pnpm --filter ./frontend test:types
pnpm --filter ./frontend build
git diff --check
git add frontend/src/growth/agents/cash-forecast-draft* \
  frontend/src/growth/agents/real-api* \
  frontend/src/growth/agents/real-controller* \
  frontend/src/growth/agents/entry.ts frontend/src/growth/agents/view* \
  frontend/src/growth/styles.css
git commit -m "feat(frontend): collect attested cash forecasts"
```

---

### Task 5: Prove restart-safe forecast identity in real MySQL

**Files:**
- Modify: `backend/src/financial-council-real-runtime-integration-test.ts`
- Modify: `backend/src/financial-council-real-e2e-server.ts`
- Modify: `backend/src/financial-council-real-e2e-server-test.ts`
- Modify: `backend/src/financial-council-integration-fixtures.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes: forecast-bound package repository and existing real-runtime owned-database harness.
- Produces: real MySQL evidence for package/forecast/run/snapshot/formula/portfolio/approval/receipt identity across two runtime instances.

- [ ] **Step 1: Write the real-runtime RED.**

Extend the existing test so its package commit includes `forecastInput()` and asserts:

```ts
assert.equal(package1.forecastStatus, "computed");
assert.match(package1.cashForecast!.forecastHash, /^sha256:[0-9a-f]{64}$/u);
assert.equal(run1.status, "awaiting_approval");
await runtime1.close();
const runtime2 = await openRuntime(sameOwnedDatabase);
assert.equal((await runtime2.packages.getVerified(workspaceId,
  package1.packageId))!.cashForecast!.forecastHash,
  package1.cashForecast!.forecastHash);
assert.equal((await runtime2.council.getRun(workspace, run1.runId))
  .snapshotHash, run1.snapshotHash);
```

Expected initial failure: the test cannot pass a supplement through the current real harness or the run still becomes `not_computable`.

- [ ] **Step 2: Update deterministic acceptance fixtures.**

Create one shared forecast fixture with nonzero 30/90 values and one >90-day receivable. The real server must not auto-attach it; only the browser POST may supply it. The server readiness response remains metadata-only and contains no forecast amount or customer.

- [ ] **Step 3: Run the live MySQL harness with a short-lived account.**

Use the existing socket-root helper pattern: random username/password in one shell, grant only `shensi_financial_council\_%`, export the temporary admin URL to the child command, and trap `DROP USER`. Never echo the password or persist it.

Run:

```bash
pnpm --filter ./backend test:financial-council:real-runtime
```

Expected: all real-runtime tests pass with zero skip; `CONNECTION_ID()` proves distinct physical connections.

- [ ] **Step 4: Run server and aggregate GREEN gates.**

```bash
pnpm --filter ./backend test:financial-council:real-e2e-server
pnpm --filter ./backend test:financial-statements
pnpm --filter ./backend test:financial-council
pnpm --filter ./backend build
git diff --check
```

- [ ] **Step 5: Commit the real-runtime harness.**

```bash
git add backend/src/financial-council-real-runtime-integration-test.ts \
  backend/src/financial-council-real-e2e-server.ts \
  backend/src/financial-council-real-e2e-server-test.ts \
  backend/src/financial-council-integration-fixtures.ts backend/package.json
git commit -m "test(finance): verify forecast identity across restart"
```

---

### Task 6: Complete the no-intercept browser acceptance and current docs

**Files:**
- Modify: `frontend/tests/financial-council-real-runtime.spec.ts`
- Modify: `frontend/playwright.financial-council-real-runtime.config.ts` only if timeout/startup evidence requires it
- Modify: `frontend/package.json` only if the existing script cannot run the final spec
- Modify: `README.md`
- Modify: `backend/src/business-advisor/README.md`
- Modify: `frontend/README.md`
- Modify: `docs/operations/financial-council-real-runtime.md`
- Modify: `docs/superpowers/specs/2026-08-23-real-financial-council-runtime-design.md`
- Modify: `docs/superpowers/specs/2026-08-23-financial-cash-forecast-supplement-design.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: real browser proof of the whole deterministic financial workflow and honest final documentation.

- [ ] **Step 1: Extend the browser spec and verify RED.**

After the three-statement preview, fill:

```ts
await page.getByLabel("未来 30 天预计流入").fill("1000.00");
await page.getByLabel("未来 30 天预计流出").fill("5000.00");
await page.getByLabel("第 31–90 天预计流入").fill("8000.00");
await page.getByLabel("第 31–90 天预计流出").fill("3000.00");
await page.getByRole("button", { name: "添加应收账款" }).click();
await page.getByLabel("应收客户 1").fill("验收客户 A");
await page.getByLabel("应收金额 1").fill("10000.00");
await page.getByLabel("逾期天数 1").fill("120");
await page.getByLabel(/管理层现金预测/u).check();
```

Then continue the existing assertions for five specialists, exactly one rebuttal, three portfolios, revision 2, balanced approval, succeeded receipt, reload identity and no raw workbook sentinel.

Run with the temporary MySQL account:

```bash
pnpm test:e2e:financial-council:real-runtime
```

Expected initial failure: forecast controls do not exist or the package remains not-computable.

- [ ] **Step 2: Add privacy, keyboard and viewport assertions.**

Assert no browser interception statically:

```bash
if rg -n 'page\.route|context\.route|route\.(fulfill|fallback|abort)' \
  frontend/tests/financial-council-real-runtime.spec.ts; then exit 1; fi
```

In Chromium assert 1440, 1366, 1024 and 390 widths have zero horizontal overflow; Tab/Space can reach all forecast inputs, attestation and commit. Before commit, raw values may exist only in form controls. After commit/reload, customer name and raw amount strings must be absent from DOM text/HTML, URL, localStorage, sessionStorage and captured console.

- [ ] **Step 3: Run the browser GREEN twice.**

Run the real no-intercept spec twice against separate owned random databases. Both runs must pass without retry. Do not use `reuseExistingServer`, request interception or a pre-seeded verified package.

- [ ] **Step 4: Run the full release gate.**

```bash
pnpm test:contracts
pnpm check:growth-contracts
pnpm --filter ./backend test:financial-statements
pnpm --filter ./backend test:financial-council
pnpm --filter ./frontend test
pnpm --filter ./frontend test:types
pnpm build
git diff --check
git diff --exit-code 16d2062 -- \
  contracts/releases/growth-advisor-quote-roi/1.0.11
git diff --exit-code 16d2062 -- pnpm-lock.yaml \
  backend/package-lock.json frontend/pnpm-lock.yaml package-lock.json
```

Run `pnpm --filter ./backend test:financial-council:live-providers` once. With missing external configuration, require a metadata-only nonzero `BLOCKED` result; do not alter it into PASS or skip.

- [ ] **Step 5: Synchronize current documentation.**

Set current contract to `1.0.12`, describe the four forecast totals, explicit receivables and management attestation, and remove the old statement that three-statement onboarding cannot reach approval. Preserve the truthful status “真实供应商验收待凭据” until the actual provider smoke passes.

- [ ] **Step 6: Final secret and scope audit.**

```bash
git diff 16d2062..HEAD --check
if git diff 16d2062..HEAD -- . ':!*.md' | \
  rg -n 'sk-[A-Za-z0-9]|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|mysql://[^[:space:]]+:[^[:space:]@]+@'; then exit 1; fi
git status --short
```

Expected: no secret marker, no lockfile change and only planned files/commits.

- [ ] **Step 7: Commit docs and browser acceptance.**

```bash
git add frontend/tests/financial-council-real-runtime.spec.ts \
  frontend/playwright.financial-council-real-runtime.config.ts \
  frontend/package.json README.md backend/src/business-advisor/README.md \
  frontend/README.md docs/operations/financial-council-real-runtime.md \
  docs/superpowers/specs/2026-08-23-real-financial-council-runtime-design.md \
  docs/superpowers/specs/2026-08-23-financial-cash-forecast-supplement-design.md
git commit -m "test(finance): accept forecast-backed council runs"
```

If the Playwright config or frontend package script has no content change, omit it from staging rather than creating mechanical churn.

---

## Completion Criteria

- [ ] Consent-only three-statement packages still produce `not_computable` without an integrity error.
- [ ] Attested forecast packages produce deterministic cash-flow formulas and reach `awaiting_approval`.
- [ ] Memory and MySQL match for validation, commit, replay, conflicts, rollback, reads and tamper rejection.
- [ ] Forecast authority and hashes survive a full runtime restart.
- [ ] Growth `1.0.12` is static/runtime/generated equivalent and `1.0.11` is byte-identical to baseline.
- [ ] The real black-shell frontend collects the forecast without floating-point conversion or persistent raw data leakage.
- [ ] No-intercept Chromium completes preview, forecast, run, revision 2, approval, dispatch receipt and reload twice.
- [ ] Real MySQL tests run with distinct physical connections and zero skip under the temporary account.
- [ ] Real provider gate remains honestly PASS or BLOCKED according to configured credentials.
- [ ] All current README, operations and design documents describe the implemented truth.
- [ ] Worktree is clean, lockfiles unchanged and no secret appears in commits or logs.
