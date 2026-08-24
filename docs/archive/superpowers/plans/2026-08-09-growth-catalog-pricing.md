# Growth Catalog and Pricing Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver tenant-isolated product, service, package, and versioned pricing-policy backends that can supply one traceable, deterministic commercial rule set to the quote workflow.

**Architecture:** CatalogItem, PricingPolicyVersion, PackageVersion, and PackageComponent use the dedicated append-oriented repository established in the foundation plan. Services own validation, capability projection, version state machines, and transaction commands; the catalog router owns only frozen-contract parsing, HTTP preconditions, idempotency, pagination, ETags, and error mapping. Money and quantity arithmetic is centralized in `growth-money.ts` and uses BigInt intermediates.

**Tech Stack:** TypeScript 5.7, Node.js 22 test runner, Express 4, Zod 3.23, MySQL 8 through mysql2 3.22, BigInt fixed-point arithmetic, frozen Growth OpenAPI release and JSON Schemas.

## Global Constraints

- Execute `docs/superpowers/plans/2026-08-09-growth-contract-and-frontend.md` Tasks 1-3 and `docs/superpowers/plans/2026-08-09-growth-foundation-and-authority.md` first.
- The frozen Growth OpenAPI release, schemas, `growth-openapi.ts`, bootstrap route, `growth-commercial-application.ts` base, `growth-commercial-runtime-bridge.ts`, and contract hash are owned only by `2026-08-09-growth-contract-and-frontend.md`; this plan only registers business services/router into the established application composition point and never creates or redefines a contract, bootstrap, application, or bridge.
- If runtime behavior cannot conform to the frozen contract, stop and publish a new contract release through the contract plan before changing the business router.
- Every repository read and write accepts one concrete `workspaceId`; nested Catalog, Package, Policy, and component references must match it.
- `super_admin/teamId="all"` cannot write without a concrete `ActiveWorkspaceContext`; the value `all` is never persisted.
- `catalog.read` is required for catalog and policy reads; `catalog.manage` is required for every catalog, package, or pricing mutation.
- Without `pricing.sensitive.read`, projections omit `unitStandardCostMinor`, `absoluteFloorUnitPriceMinor`, detailed margin thresholds, and order cost fields rather than returning zero or null substitutes.
- Every command uses `CommandContext`, reserves HTTP idempotency before business locks, and re-authorizes/re-projects replays. Foundation's canonical request hash includes the strictly parsed, key-sorted route `pathParams`; an ID is never represented only by the route template.
- Every Catalog business transaction consumes the same Foundation-owned `GrowthFoundationServices.temporalBarrier`. Its transaction adapter implements the exact `GrowthTemporalTransaction` methods `lockWorkspaceTemporalBarrierForUpdate`, `currentTimestamp3`, and `saveWorkspaceTemporalBarrier`; after HTTP reservation/current authorization, the workspace temporal barrier is the first business lock and remains held through commit. Every created/versioned/activated/retired Catalog append obtains its server `recordedAt/createdAt/updatedAt` only from `temporalBarrier.allocateAppend(tx,workspaceId)`, including successive allocations for multiple rows in one transaction. Catalog never implements another HLC or calls a per-stream clock as authority.
- Every mutable-resource command uses exact `If-Match` revision semantics and returns `ETag`; missing/stale preconditions return `428/412`.
- All prices and costs are ISO 4217 minor-unit safe integers; quantities are positive `quantityMicros` integers; BPS fields are integers from 0 through 10000 except absolute minimum gross margin, which is 0 through 9999.
- Money multiplication and division use BigInt intermediates with explicit `ROUND_HALF_UP` or ceiling; floating-point currency calculations are forbidden.
- One CatalogItem/currency/effective instant has at most one active PricingPolicyVersion.
- PricingPolicyVersion, active/retired PackageVersion, and historical component snapshots are immutable; changes create new versions.
- A package pricing policy freezes one exact active PackageVersion; changing components requires a new PackageVersion and a new PricingPolicyVersion.
- Package components must be same-workspace, same-currency, positive quantity, backed by valid exact policy versions, and acyclic.
- Catalog tables remain outside `CrmStore` arrays and `persistAll/replaceRows`.
- No business task edits `contracts/openapi/ai-acquisition.v1.yaml`, `backend/src/acquisition-openapi.ts`, or generated files under the legacy frontend.
- Real mode never reads catalog amounts from demo state.
- Every real Catalog MySQL concurrency suite uses `MYSQL_TEST_ADMIN_URL` to create and drop an isolated temporary database. The stable `test:growth-catalog` gate includes that suite, fails rather than skips when the variable is absent, and prints `MYSQL_INTEGRATION_EXECUTED:growth-catalog:<database>` only after real two-connection assertions complete.

---

### Task 1: Complete catalog repository commands and closed policy unions

**Files:**
- Modify: `backend/src/catalog-domain.ts`
- Modify: `backend/src/catalog-repository.ts`
- Modify: `backend/src/catalog-mysql-repository.ts`
- Create: `backend/src/catalog-repository-test.ts`
- Modify: `backend/src/catalog-mysql-repository-test.ts`

**Interfaces:**
- Consumes: foundation `CatalogItem`, `PricingPolicyVersion`, `PackageVersion`, `PackageComponent`, `ActiveWorkspaceContext`, `CommandContext`, the sole `growth-money.ts` fixed-point/ISO registry implementation, and the exact Foundation `GrowthTemporalTransaction`/`GrowthTemporalBarrier` ports. The repository transaction adapter, not a caller timestamp, owns append authority.
- Produces: the frozen v1 closed `ApprovalThresholds`, `SurchargePolicy`, and `GiftPolicy` objects; no index signature, old union variant, or unrecognized field is accepted.
- Produces: `CatalogListQuery { cursor: string | null; limit: number; sort: "code" | "name" | "updatedAt"; direction: "asc" | "desc"; type?: CatalogItem["type"]; status?: CatalogItem["status"] }`.
- Produces repository reads: `listCatalogItems(workspaceId, query)`, `findCatalogItem(workspaceId,id)`, `listPricingPolicies(workspaceId,query)`, `findPricingPolicyVersion(workspaceId,id)`, `listPackageVersions(workspaceId,itemId,query)`, `findPackageVersion(workspaceId,id)`, and `listPackageComponents(workspaceId,packageVersionId)`.
- Produces repository commands: `createCatalogItem(command)`, `updateCatalogItem(command)`, `retireCatalogItem(command)`, `createPricingPolicyDraft(command)`, `activatePricingPolicy(command)`, `retirePricingPolicy(command)`, `createPackageVersionDraft(command)`, `updatePackageVersionDraft(command)`, `activatePackageVersion(command)`, and `retirePackageVersion(command)`.
- Command results are discriminated unions: `{kind:"ok"; value; replayed:boolean}`, `{kind:"revision_conflict"; actualRevision:number}`, `{kind:"state_conflict"; code:string}`, or `{kind:"not_found"}`.
- Test-only `repositoryFixtures`, `createItemCommand`, `hash`, and `NOW` are defined locally in `catalog-repository-test.ts`; the fixture returns the same typed contract for memory and MySQL adapters.

- [ ] **Step 1: Write failing repository parity tests**

```ts
test("memory and MySQL repositories reject a stale catalog revision", async () => {
  for (const repository of repositoryFixtures()) {
    await repository.createCatalogItem(createItemCommand({ id: "item-1" }));
    const first = await repository.updateCatalogItem({
      workspaceId: "team-a", id: "item-1", expectedRevision: 1,
      patch: { name: "新版名称" }, actorId: "admin-1",
      idempotencyKey: "item-update-0001", requestHash: hash({ name: "新版名称" })
    });
    assert.equal(first.kind, "ok");
    const stale = await repository.updateCatalogItem({
      workspaceId: "team-a", id: "item-1", expectedRevision: 1,
      patch: { name: "并发覆盖" }, actorId: "admin-2",
      idempotencyKey: "item-update-0002", requestHash: hash({ name: "并发覆盖" })
    });
    assert.deepEqual(stale, { kind: "revision_conflict", actualRevision: 2 });
  }
});
```

Add tests proving another workspace receives `not_found`, policy and package rows are clone-on-read, version numbers are allocated under one locked parent, and the MySQL implementation uses dedicated tables with `FOR UPDATE` rather than `persistAll/replaceRows`. Every command fixture observes `workspace_temporal_barrier` as the first business lock, persists the allocator's `recordedAt/temporalSequence`, and a multi-row command observes successive sequences; no command accepts a caller `now` as its append timestamp.

- [ ] **Step 2: Run the focused tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/catalog-repository-test.ts src/catalog-mysql-repository-test.ts`

Expected: FAIL because the foundation repository lacks the complete command surface.

- [ ] **Step 3: Implement closed domain unions**

```ts
export interface SurchargePolicy {
  kind: "region" | "delivery" | "payment_term";
  condition: string;
  fixedAmountMinor: number;
  unitAmountMinor: number;
}

export interface GiftPolicy {
  catalogItemId: string;
  unitStandardCostMinor: number;
  standardQuantityMicros: number;
  absoluteQuantityMicros: number;
  standardCostLimitMinor: number;
  absoluteCostLimitMinor: number;
}
```

Use the Foundation `ApprovalThresholds` object with its six named capability fields, `creditRiskThresholdBps`, and `manualEscalationEnabled`. A surcharge selects exactly one v1 condition kind (`region`, `delivery`, or `payment_term`) and carries both fixed and per-unit amounts. A gift policy references its catalog item and carries both ordinary/absolute quantity and cost limits.

- [ ] **Step 4: Implement repository commands and MySQL locking**

Every Catalog mutation begins a checked-out business transaction, locks Foundation's workspace temporal barrier before `catalog_items` or any other domain row, and holds it through commit. It then locks the `catalog_items` row; version allocation locks the parent CatalogItem, reads `MAX(version)`, and inserts one new immutable record. Each created/updated/version/lifecycle row receives only an `allocateAppend(tx,workspaceId)` result and stores both `recordedAt` and `temporalSequence`; commands that append multiple rows call it successively. Pricing activation and package activation commands accept validator callbacks from later services but own the transaction, so validation reads and state transition occur under the same locks. All repository queries include `workspace_id=?`; a mismatched nested record is never returned for service-side filtering.

- [ ] **Step 5: Verify GREEN**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/catalog-repository-test.ts src/catalog-mysql-repository-test.ts && npm run test:growth-foundation && npm run build`

Expected: foundation fixed-point tests, repository parity, and build PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/catalog-domain.ts backend/src/catalog-repository.ts backend/src/catalog-repository-test.ts backend/src/catalog-mysql-repository.ts backend/src/catalog-mysql-repository-test.ts
git commit -m "feat: complete catalog persistence primitives"
```

### Task 2: CatalogItem service, capability projection, and HTTP routes

**Files:**
- Create: `backend/src/catalog-service.ts`
- Create: `backend/src/catalog-service-test.ts`
- Create: `backend/src/catalog-router.ts`
- Create: `backend/src/catalog-router-test.ts`
- Create: `backend/src/catalog-runtime-response-conformance-test.ts`
- Create: `backend/src/commission-catalog-projection.ts`
- Create: `backend/src/commission-catalog-projection-test.ts`
- Create: `backend/src/growth-catalog-module.ts`
- Create: `backend/src/growth-catalog-module-test.ts`
- Modify: `backend/src/growth-commercial-composition.ts`
- Modify: `backend/src/growth-commercial-composition-test.ts`
- Modify: `backend/src/growth-openapi-response-conformance-test.ts`
- Modify: `backend/src/server.ts`

**Interfaces:**
- Consumes: Task 1 repository, frozen Growth contract release `1.0.1`, `ActiveWorkspaceContext`, `CommandContext`, `requireGrowthCapabilities`, `executeGrowthIdempotentCommand`, `parseIfMatchRevision`, `setRevisionEtag`, and Foundation's exact `GROWTH_FOUNDATION_SERVICES` private key including singleton `httpIdempotency`, `workspaceContext: GrowthWorkspaceContextResolver`, `commandContextFactory: GrowthCommandContextFactory`, `temporalTransactions: GrowthTemporalTransactionRunner`, and `temporalBarrier: GrowthTemporalBarrier`. Catalog handlers never import/call `commandContextFromRequest` or create a replacement workspace resolver, transaction runner, or HLC.
- Consumes without redeclaration the exact Foundation ports `GrowthTemporalTransaction { lockWorkspaceTemporalBarrierForUpdate(workspaceId:string):Promise<{lastRecordedAt:string;temporalSequence:number}>; currentTimestamp3():Promise<string>; saveWorkspaceTemporalBarrier(workspaceId:string,expectedSequence:number,next:{lastRecordedAt:string;temporalSequence:number}):Promise<void> }`, opaque `GrowthSealedReadCutoff { workspaceId; effectiveAsOf; temporalSequence }`, and `GrowthTemporalBarrier { allocateAppend(tx:GrowthTemporalTransaction,workspaceId:string):Promise<{recordedAt:string;temporalSequence:number}>; sealReadCutoff(context:ActiveWorkspaceContext,effectiveAsOf:string):Promise<GrowthSealedReadCutoff> }`. Catalog's checked-out transaction implements the exact transaction port. The temporal row is locked before any Catalog/package graph/domain row and held until business commit. Catalog currently exposes no historical `recordedAt<=asOf` reader, so it never calls `sealReadCutoff`; any future such boundary must seal once and pass the opaque token to token-only internals.
- Produces: `CatalogService.list(context, query): Promise<CatalogPage>`, `.get(context,id): Promise<CatalogItemProjection>`, `.create(commandContext,input)`, `.update(commandContext,id,input)`, and `.retire(commandContext,id)`.
- Produces: `CatalogItemInput { type; code; name; description: string | null; unit }` and `CatalogItemPatch { name?; description?: string | null; unit? }`; code and type are immutable after creation.
- Produces the frozen transport-aligned `CatalogPage { items: CatalogItemProjection[]; nextAfter: string | null; hasMore: boolean }`. The service probes one row past the returned page using the same sort+ID cursor so a full final page does not falsely claim `hasMore`; the public query accepts only `cursor`, `limit`, and `sort`, maps `updatedAt` to descending order and `code|name` to ascending order, and never accepts unpublished `direction`, `type`, or `status` filters.
- Produces: `createCatalogRouter({ catalogService, pricingPolicyService?, packageVersionService?, httpIdempotency, workspaceContext, commandContextFactory }): Router`; this task mounts only CatalogItem handlers, and later tasks inject the other services into the same router factory. In production the HTTP idempotency repository and two request adapters are exact references read from `GROWTH_FOUNDATION_SERVICES`; `GrowthCatalogModuleOptions` has no fields that can replace them.
- Produces: `CommissionCatalogProjectionPort` with `projectProduct(context: ActiveWorkspaceContext, product: CommissionProduct): Promise<CommissionProduct>` and `assertCommercialPatchAllowed(context: ActiveWorkspaceContext, productId: string, patch: CommissionProductPatch): Promise<void>`. No link means unchanged legacy behavior; a `migrated` link projects linked policy price/cost/currency and rejects legacy mutations of those three fields with `409 catalog_projection_read_only`.
- Produces the first exact composite `GrowthCatalogServices { readonly catalogItems: CatalogService; readonly commissionCatalogProjection: CommissionCatalogProjectionPort }`, typed `GROWTH_CATALOG_SERVICES: GrowthPrivateServiceKey<GrowthCatalogServices>`, and `createGrowthCatalogModule(options): GrowthCommercialModule`; its installer constructs one repository/service graph, freezes this exact object with `Object.freeze`, mounts the catalog router once, provides the typed private service once, and returns its own idempotent close handle. Task 3 extends this same named interface/object with `pricingPolicies`, Task 4 extends and finally freezes it with `packageVersions` and `quoteCatalog`; no task creates a parallel composite or replaces an already-constructed service instance. HTTP uses that singleton now and Quote later requires the final same private object. This task does not add properties to or redefine the C0 `GrowthCommercialToolPorts` registry.
- Extends the narrow runtime integration projection with `commissionCatalogProjection: CommissionCatalogProjectionPort`; `server.ts` receives only this port and never constructs or opens a second catalog repository.
- Routes: `GET/POST /api/v1/catalog/items`, `GET/PATCH /api/v1/catalog/items/:id`, and `POST /api/v1/catalog/items/:id/retire`.
- Test-only `catalogFixture`, `catalogRouterFixture`, `salesContext`, and `salesCommandContext` are defined in the two task test files and return the exact service/router types above.

- [ ] **Step 1: Write failing service and router tests**

```ts
test("sales can read but cannot manage catalog items", async () => {
  const state = catalogFixture();
  const page = await state.service.list(salesContext(), {
    cursor: null, limit: 20, sort: "updatedAt", direction: "desc"
  });
  assert.equal(page.items.length, 1);
  await assert.rejects(
    state.service.create(salesCommandContext(), {
      type: "service", code: "SVC-001", name: "诊断服务",
      description: "获客诊断", unit: "次"
    }),
    (error: unknown) => (error as { code?: string }).code === "capability_forbidden"
  );
});

test("create is idempotent and update requires the latest ETag", async () => {
  const app = catalogRouterFixture();
  const first = await app.post("/api/v1/catalog/items")
    .set("Idempotency-Key", "catalog-create-0001")
    .send({
      type: "service", code: "SVC-001", name: "诊断服务",
      description: "获客诊断", unit: "次"
    }).expect(201);
  const replay = await app.post("/api/v1/catalog/items")
    .set("Idempotency-Key", "catalog-create-0001")
    .send({
      type: "service", code: "SVC-001", name: "诊断服务",
      description: "获客诊断", unit: "次"
    }).expect(200);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  await app.patch(`/api/v1/catalog/items/${first.body.id}`)
    .set("Idempotency-Key", "catalog-update-0001")
    .send({ name: "无并发保护" }).expect(428);
});

test("one idempotency key cannot cross catalog resource path IDs", async () => {
  const app = catalogRouterFixture({ items: ["item-a", "item-b"] });
  await app.patch("/api/v1/catalog/items/item-a")
    .set("Idempotency-Key", "catalog-cross-id-0001")
    .set("If-Match", '"catalog-item:item-a:1"')
    .send({ name: "A2" }).expect(200);
  await app.patch("/api/v1/catalog/items/item-b")
    .set("Idempotency-Key", "catalog-cross-id-0001")
    .set("If-Match", '"catalog-item:item-b:1"')
    .send({ name: "A2" }).expect(409).expect(({ body }) => {
      assert.equal(body.code, "idempotency_conflict");
    });
  assert.equal(app.item("item-b").revision, 1);
});
```

Add tests for duplicate code in one workspace (`409 catalog_code_conflict`), same code in another workspace, retired item immutability, cursor ordering, unknown request fields, no body/query workspace override, and `ETag: "catalog-item:<id>:<revision>"`.

Release `1.0.1` intentionally removes `If-Match` only from `createCatalogItem`, because no mutable resource revision exists before creation. Create still requires workspace, auth/CSRF, `Idempotency-Key`, and its strict body and passes `expectedRevision:null`. PATCH/retire continue to require the exact latest resource-scoped ETag.

In `commission-catalog-projection-test.ts`, migrate one CommissionProduct, then prove the projection reads price/cost/currency from its immutable linked PricingPolicyVersion, rejects a price/cost/currency patch, still permits name/commission-rule patches, cannot cross workspace boundaries, and leaves an unlinked legacy product unchanged. The test must assert the projection and Catalog HTTP service share the exact same repository instance supplied by `createGrowthCatalogModule`.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/catalog-service-test.ts src/catalog-router-test.ts`

Expected: FAIL because the service and router do not exist.

- [ ] **Step 3: Implement the capability-aware service**

```ts
export class CatalogService {
  constructor(private readonly options: {
    repository: CatalogRepository;
    idFactory(prefix: string): string;
  }) {}

  async create(context: CommandContext, input: CatalogItemInput) {
    requireGrowthCapabilities(context.workspace, ["catalog.manage"]);
    return this.options.repository.createCatalogItem({
      workspaceId: context.workspace.workspaceId,
      id: this.options.idFactory("catalog-item"),
      ...input,
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash
    });
  }
}
```

Validate code as trimmed uppercase tenant-local identifier, require nonblank name/unit, preserve a nullable description, reject type/code changes on patch, and retain retired records for reads/history. Every service method derives workspace only from context. Status, revision, and all append timestamps are owned only by Task 1's repository transaction and Foundation temporal authority; the service has no business clock.

- [ ] **Step 4: Implement frozen-contract HTTP behavior and runtime conformance**

Use strict Zod request/query schemas that mirror frozen release `1.0.1`. Every read handler obtains its sole `ActiveWorkspaceContext` by calling the injected `workspaceContext(req)`. Every write handler first strictly parses each path ID, then calls the injected `commandContextFactory(req,{canonicalPath,pathParams,payload,expectedRevision})` exactly once; PATCH/retire call `parseIfMatchRevision` with the resource string `catalog-item:<actual-id>` and pass `pathParams:Object.freeze({id})`, while collection create passes `Object.freeze({})` and `expectedRevision:null` without reading `If-Match`. Foundation sorts the closed path map into the canonical hash. A reused key/body/revision against `item-a` then `item-b` therefore conflicts during reservation before Catalog reads or writes. The handler never calls `commandContextFromRequest`, accepts identity fields in the body, or reconstructs any context member. Every write invokes `executeGrowthIdempotentCommand` with the injected exact `httpIdempotency` before Catalog business reads/locks; on fresh and replay paths it reloads through `CatalogService.get` so current authorization applies. Set response ETags only through `setRevisionEtag(res,"catalog-item",item.id,item.revision)`, which emits `"catalog-item:<id>:<revision>"`. Map domain errors to the contract's standard error envelope.

`catalog-runtime-response-conformance-test.ts` starts the real router, exercises create/list/get/update/retire, and validates every status/body/header through the frozen Growth schema loader already used by `growth-openapi-response-conformance-test.ts`. Append the same real-route cases to the central response conformance suite without modifying static OpenAPI or schemas.

Implement `CommissionCatalogProjectionPort` over the module's repository. It derives workspace only from `ActiveWorkspaceContext`, follows only a `migrated` link, and verifies that the linked policy belongs to the same workspace and catalog item before projection. In `server.ts`, obtain the trusted workspace context through the C0 resolver, invoke `assertCommercialPatchAllowed` before the existing CommissionProduct commercial mutation, and invoke `projectProduct` on reads. The server coordinates the injected port only; missing Growth readiness fails closed for migrated-link operations and never falls back to stale legacy money.

- [ ] **Step 5: Install one typed Catalog module and verify GREEN**

Implement `createGrowthCatalogModule`. Its `install({ router, privateServices })` first requires `GROWTH_FOUNDATION_SERVICES`, passes the exact `foundation.httpIdempotency`, `foundation.workspaceSettings`, `foundation.workspaceContext`, `foundation.commandContextFactory`, `foundation.temporalTransactions`, and `foundation.temporalBarrier` references to its services/router/repository transaction adapter, mounts exactly one `/api/v1/catalog` router, freezes/provides the Task-2 `GrowthCatalogServices` object containing the exact `catalogItems` and `commissionCatalogProjection` instances, and returns `closeCatalogResources`; the memory repository receives the reference-identical Foundation runner and barrier and never creates a second temporal tail. It never edits the C0 application kernel or mounts catalog routes in `server.ts`. `GrowthCatalogModuleOptions` cannot inject request-context or temporal adapters. Missing Foundation services fail before repository construction or route mounting. After the first Catalog resource is constructed, installation runs construction/provide/mount inside a local `try/catch`; `closeCatalogResources` is idempotent and the catch awaits it before rethrowing, because C0 cannot own the current module's close handle until install returns. C0 still reverse-closes previously installed modules. Add that module once to the ordered array in `growth-commercial-composition.ts`, and extend `projectIntegrations` with only the same `commissionCatalogProjection` reference. `growth-catalog-module-test.ts` captures the router/service options and asserts strict reference equality to the Foundation singleton for `httpIdempotency`, both request adapters, `temporalTransactions`, and `temporalBarrier`, proves a lookalike adapter supplied through module options is rejected by TypeScript/excess-property contract, asserts one repository/service instance is shared by the router, projection and private key, duplicate installation fails before a second mount, the composite and its two fields are frozen, and two calls to runtime close invoke `closeCatalogResources` once. Inject failures separately in `privateServices.provide` and router mount after repository/service construction; each test proves the current Catalog resources close exactly once locally, the error propagates, and the C0 composition reverse-closes every previously returned module handle exactly once without double-closing Catalog. The composition test asserts Foundation precedes Catalog, the projected port is reference-equal to `GROWTH_CATALOG_SERVICES.commissionCatalogProjection`, and the private registry itself remains inaccessible.

For legacy Commission routes, `server.ts` owns a late-bound bridge containing the exact `createGrowthCommercialCompositionForStore(...).workspaceMiddleware` reference plus the projected `commissionCatalogProjection`. The bridge middleware is registered before Commission handlers, writes the trusted `req.activeWorkspace`, and passes that exact object to projection methods; handlers never call `legacyCommercialWorkspaceContext` or reconstruct capabilities from headers. A missing bridge fails closed for products marked migrated/linked while unlinked legacy test data retains old behavior. GET projects every visible product; PATCH calls `assertCommercialPatchAllowed` before mutation and projects the response afterward. Install/uninstall follows Growth runtime lifecycle and cannot leave a stale global port.

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/catalog-service-test.ts src/catalog-router-test.ts src/catalog-runtime-response-conformance-test.ts src/commission-catalog-projection-test.ts src/growth-catalog-module-test.ts && npm run test:growth-openapi && npm run build`

Expected: service/router/conformance, frozen contract parity, and build PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/catalog-service.ts backend/src/catalog-service-test.ts backend/src/catalog-router.ts backend/src/catalog-router-test.ts backend/src/catalog-runtime-response-conformance-test.ts backend/src/commission-catalog-projection.ts backend/src/commission-catalog-projection-test.ts backend/src/growth-catalog-module.ts backend/src/growth-catalog-module-test.ts backend/src/growth-commercial-composition.ts backend/src/growth-commercial-composition-test.ts backend/src/growth-openapi-response-conformance-test.ts backend/src/server.ts
git commit -m "feat: expose tenant catalog items"
```

### Task 3: Versioned pricing policies and sensitive-field projection

**Files:**
- Create: `backend/src/pricing-policy-service.ts`
- Create: `backend/src/pricing-policy-service-test.ts`
- Modify: `backend/src/catalog-router.ts`
- Modify: `backend/src/catalog-router-test.ts`
- Modify: `backend/src/catalog-runtime-response-conformance-test.ts`
- Modify: `backend/src/catalog-repository.ts`
- Modify: `backend/src/catalog-mysql-repository.ts`
- Modify: `backend/src/growth-catalog-module.ts`
- Modify: `backend/src/growth-catalog-module-test.ts`

**Interfaces:**
- Consumes: Tasks 1-2, capability registry, and the frozen `PricingPolicyVersion` transport contract.
- Produces: `PricingPolicyDraftInput` with all approved-design integer price/cost/discount/margin/payment fields, closed `approvalThresholds`, `surchargePolicies`, `giftPolicies`, `validFrom`, `validTo`, `currency`, and optional `packageVersionId`.
- Produces: `PricingPolicyService.list(context,query)`, `.get(context,id)`, `.createDraft(commandContext,input)`, `.activate(commandContext,id)`, and `.retire(commandContext,id)`.
- Produces: `projectPricingPolicy(policy, capabilities): PricingPolicyProjection`; sensitive fields are absent without `pricing.sensitive.read`.
- Produces: `requiredCapabilitiesForPolicy(policy): readonly GrowthCapability[]`; activation rejects every unknown rule/capability with `invalid_approval_rule`.
- Evolves the sole private composite to the exact shape `GrowthCatalogServices { readonly catalogItems: CatalogService; readonly pricingPolicies: PricingPolicyService; readonly commissionCatalogProjection: CommissionCatalogProjectionPort }`. `createGrowthCatalogModule` constructs `PricingPolicyService` once, injects that reference into the existing router, freezes a newly assembled complete object under the same `GROWTH_CATALOG_SERVICES` key, and tests reference equality; it does not wrap, reconstruct, or duplicate the Task-2 services.
- Routes: `GET/POST /api/v1/catalog/pricing-policies`, `GET /api/v1/catalog/pricing-policies/:id`, `POST .../:id/activate`, and `POST .../:id/retire`.
- Test-only `pricingFixture`, `managerContext`, and `adminCommand` are defined locally in `pricing-policy-service-test.ts`.

- [ ] **Step 1: Write failing policy-state and projection tests**

```ts
test("sales projection cannot observe cost floor or detailed margin", async () => {
  const state = pricingFixture({ status: "active" });
  const sales = await state.service.get(salesContext(), "policy-1");
  assert.equal("unitStandardCostMinor" in sales, false);
  assert.equal("absoluteFloorUnitPriceMinor" in sales, false);
  assert.equal("absoluteMinimumGrossMarginBps" in sales, false);
  const manager = await state.service.get(managerContext(), "policy-1");
  assert.equal(manager.unitStandardCostMinor, 8_000);
  assert.equal(manager.absoluteFloorUnitPriceMinor, 10_000);
});

test("activation rejects overlap and unknown approval capability", async () => {
  const state = pricingFixture({ existingActiveWindow: [NOW, null] });
  await assert.rejects(
    state.service.activate(adminCommand({ expectedRevision: 1 }), "policy-2"),
    (error: unknown) => (error as { code?: string }).code === "pricing_window_overlap"
  );
  const invalid = pricingFixture({
    requiredCapability: "quote.exception.unknown.approve"
  });
  await assert.rejects(
    invalid.service.activate(adminCommand({ expectedRevision: 1 }), "policy-1"),
    (error: unknown) => (error as { code?: string }).code === "invalid_approval_rule"
  );
});
```

Add tests for `listUnitPriceMinor>0`, safe integer range, currency format, BPS bounds, absolute limits not weaker than standard thresholds, valid half-open effective window, immutable active/retired rows, one active policy per item/currency/overlap, package policy requiring exact active PackageVersion, and two-connection MySQL activation contention with one winner.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/pricing-policy-service-test.ts src/catalog-router-test.ts`

Expected: FAIL because `PricingPolicyService` and policy routes are absent.

- [ ] **Step 3: Implement closed validation and immutable versioning**

```ts
const APPROVAL_CAPABILITIES = Object.freeze({
  discountCapability: "quote.exception.discount.approve",
  marginCapability: "quote.exception.margin.approve",
  paymentTermsCapability: "quote.exception.payment_terms.approve",
  giftCapability: "quote.exception.gift.approve",
  creditCapability: "quote.exception.credit.approve",
  manualCapability: "quote.exception.manual.approve"
} as const satisfies Partial<ApprovalThresholds>);

export function requiredCapabilitiesForPolicy(policy: PricingPolicyVersion) {
  const thresholds = policy.approvalThresholds;
  for (const [field, required] of Object.entries(APPROVAL_CAPABILITIES)) {
    if (thresholds[field as keyof typeof APPROVAL_CAPABILITIES] !== required) {
      throw Object.assign(new Error("invalid approval capability mapping"), {
        code: "invalid_approval_rule"
      });
    }
  }
  return Object.freeze([
    thresholds.discountCapability,
    thresholds.marginCapability,
    thresholds.paymentTermsCapability,
    thresholds.giftCapability,
    thresholds.creditCapability,
    thresholds.manualCapability
  ]);
}
```

Create always appends a draft with the next parent-locked version. Activation locks CatalogItem, validates the draft and its exact referenced PackageVersion when applicable, rejects active overlap, stores capability registry version, moves the draft to active, and increments revision. Retirement only moves active to retired and never changes commercial content.

- [ ] **Step 4: Add policy routes and current-capability replay projection**

Implement strict bodies, cursor list, ETags, idempotency, `If-Match`, error codes, and explicit response projectors. The Full projector adds `amountVisibility: "full"` and strips internal `capabilityRegistryVersion`. The Redacted projector adds `amountVisibility: "redacted"`, strips that internal audit field, and strips every sensitive field declared absent by the frozen v1 RedactedProjection schema. A replay after a user's sensitive capability is removed reloads and returns the redacted object; it never returns the first response body.

- [ ] **Step 5: Verify GREEN**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/pricing-policy-service-test.ts src/catalog-router-test.ts src/catalog-runtime-response-conformance-test.ts && npm run build`

Expected: pricing domain, routes, frozen response conformance, and the accumulated catalog suite PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/pricing-policy-service.ts backend/src/pricing-policy-service-test.ts backend/src/catalog-router.ts backend/src/catalog-router-test.ts backend/src/catalog-runtime-response-conformance-test.ts backend/src/catalog-repository.ts backend/src/catalog-mysql-repository.ts backend/src/growth-catalog-module.ts backend/src/growth-catalog-module-test.ts
git commit -m "feat: add immutable pricing policy versions"
```

### Task 4: Package versions, component graph validation, and Stage 1 integration

**Files:**
- Create: `backend/src/package-version-service.ts`
- Create: `backend/src/package-version-service-test.ts`
- Create: `backend/src/quote-catalog-reader.ts`
- Create: `backend/src/quote-catalog-reader-test.ts`
- Create: `backend/src/growth-catalog-mysql-test-support.ts`
- Create: `backend/src/growth-catalog-mysql-integration-test.ts`
- Modify: `backend/src/catalog-router.ts`
- Modify: `backend/src/catalog-router-test.ts`
- Modify: `backend/src/catalog-runtime-response-conformance-test.ts`
- Modify: `backend/src/pricing-policy-service.ts`
- Modify: `backend/src/catalog-repository.ts`
- Modify: `backend/src/catalog-mysql-repository.ts`
- Modify: `backend/src/growth-catalog-module.ts`
- Modify: `backend/src/growth-catalog-module-test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes: Catalog and policy services/repository, `growth-money.ts`, frozen PackageVersion contract, capability/workspace/idempotency/precondition foundations.
- Produces: `PackageComponentInput { componentCatalogItemId: string; componentPricingPolicyVersionId: string; quantityMicros: number }`.
- Produces: `PackageVersionDraftInput { currency: string; validFrom: string; validTo: string | null; components: readonly PackageComponentInput[] }`.
- Produces: `PackageVersionService.list(context,itemId,query)`, `.get(context,id)`, `.createDraft(commandContext,itemId,input)`, `.updateDraft(commandContext,id,input)`, `.activate(commandContext,id)`, and `.retire(commandContext,id)`.
- Produces: `validatePackageGraph(repository, workspaceId, rootItemId, components): Promise<void>` and `calculateFrozenComponentUnitCost(components: readonly { unitStandardCostMinor: number; quantityMicros: number }[]): number`.
- Produces one repository-owned workspace graph serialization boundary `withPackageGraphGuard(workspaceId,command)`. After Foundation reservation/current authorization, every transaction first locks Foundation's workspace temporal barrier and holds it through commit; memory then uses one package-graph mutex per concrete workspace, while MySQL next inserts/locks one `catalog_package_graph_guards(workspace_id)` row as the first Catalog-domain lock. It then locks the complete referenced CatalogItem, PackageVersion, PricingPolicyVersion, component-edge, active-window and cost-snapshot rows in fixed table order and code-point ID order (`a < b ? -1 : a > b ? 1 : 0`, never `localeCompare`). Every package create/update/activate/retire, package-policy activation, and every PricingPolicy retirement runs inside this boundary—even when an unlocked preflight would appear unrelated—because a concurrent package activation may create the reference. Each command rereads the locked rows, reruns DFS, currency, status, effective-window, overlap and in-use validation after the locks, and allocates each append through the already-held temporal barrier. No caller may run an unlocked preflight and treat it as authority.
- Produces internal-only `PackageCostSnapshot { workspaceId; pricingPolicyVersionId; packageVersionId; componentUnitStandardCostMinor; packageOwnUnitServiceCostMinor; totalUnitStandardCostMinor; componentSnapshotHash; components }`, stored transactionally when a package pricing policy activates; it is not a second public pricing field.
- Extends `CatalogRepository` with `findPackageCostSnapshot(workspaceId,pricingPolicyVersionId): Promise<PackageCostSnapshot|null>` and an internal package-policy activation command that atomically freezes the snapshot and activates the policy; callers cannot append a snapshot independently.
- Produces exact `QuoteCatalogReader.resolveAt(context: ActiveWorkspaceContext, input: { catalogItemId: string; pricingPolicyVersionId: string; effectiveAt: string }): Promise<{ catalogItem: CatalogItem; pricingPolicy: PricingPolicyVersion; packageVersion: PackageVersion | null; packageCostSnapshot: PackageCostSnapshot | null }>`; it requires the policy window and, for a package, the referenced PackageVersion window to both contain the actual quote `effectiveAt` under half-open `[validFrom,validTo)` semantics. It rejects an inactive, retired-at-that-time, cross-workspace, currency-mismatched, missing-snapshot, or out-of-window package with `package_version_not_effective`, even when the policy itself is still effective.
- Finalizes and freezes the sole composite as `GrowthCatalogServices { readonly catalogItems: CatalogService; readonly pricingPolicies: PricingPolicyService; readonly packageVersions: PackageVersionService; readonly quoteCatalog: QuoteCatalogReader; readonly commissionCatalogProjection: CommissionCatalogProjectionPort }`. This exact shape is the only Catalog dependency consumed by Quote; no repository and no nullable/incomplete service slot crosses the module boundary.
- Routes: `GET/POST /api/v1/catalog/packages/:itemId/versions`, `GET/PATCH /api/v1/catalog/package-versions/:id`, `POST .../:id/activate`, and `POST .../:id/retire`.
- Tightens: `PricingPolicyService.activate` accepts a package item only when `packageVersionId` names an active same-currency version whose validity covers the policy validity start.
- Test-only `packageFixture`, `packageGraphFixture`, and `adminCommand` are defined locally in `package-version-service-test.ts`, including the frozen-component/snapshot expectations used below.

- [ ] **Step 1: Write failing package graph, immutability, and concurrency tests**

```ts
test("package activation rejects direct and indirect cycles", async () => {
  const direct = packageFixture({ root: "package-a", component: "package-a" });
  await assert.rejects(
    direct.service.activate(adminCommand({ expectedRevision: 1 }), "pv-a"),
    (error: unknown) => (error as { code?: string }).code === "package_cycle"
  );
  const indirect = packageGraphFixture([
    ["package-a", "package-b"], ["package-b", "package-c"],
    ["package-c", "package-a"]
  ]);
  await assert.rejects(
    indirect.service.activate(adminCommand({ expectedRevision: 1 }), "pv-a"),
    (error: unknown) => (error as { code?: string }).code === "package_cycle"
  );
});

test("only draft package versions are editable and concurrent activation has one winner", async () => {
  const state = packageFixture({ twoOverlappingDrafts: true });
  const results = await Promise.all([
    state.service.activate(adminCommand({
      expectedRevision: 1, idempotencyKey: "package-activate-a"
    }), "pv-a"),
    state.service.activate(adminCommand({
      expectedRevision: 1, idempotencyKey: "package-activate-b"
    }), "pv-b")
  ].map((promise) => promise.then(() => "ok", (error) => error.code)));
  assert.deepEqual(results.sort(), ["ok", "package_window_overlap"]);
  await assert.rejects(
    state.service.updateDraft(adminCommand({ expectedRevision: 2 }), "pv-a", {
      currency: "CNY", validFrom: NOW, validTo: null, components: []
    }),
    (error: unknown) => (error as { code?: string }).code === "package_version_immutable"
  );
});

test("package policy freezes declared total cost without losing or double-counting own service cost", async () => {
  const state = packageFixture({
    componentCosts: [
      { unitStandardCostMinor: 2_000, quantityMicros: 1_500_000 },
      { unitStandardCostMinor: 1_000, quantityMicros: 1_000_000 }
    ],
    declaredTotalUnitStandardCostMinor: 5_000,
    defaultOrderServiceCostMinor: 600
  });
  const policy = await state.pricing.activate(
    adminCommand({ expectedRevision: 1 }), "policy-package-1"
  );
  assert.equal(policy.unitStandardCostMinor, 5_000);
  assert.deepEqual(await state.repository.findPackageCostSnapshot(
    "team-a", "policy-package-1"
  ), {
    workspaceId: "team-a",
    pricingPolicyVersionId: "policy-package-1",
    packageVersionId: "pv-a",
    componentUnitStandardCostMinor: 4_000,
    packageOwnUnitServiceCostMinor: 1_000,
    totalUnitStandardCostMinor: 5_000,
    componentSnapshotHash: state.expectedComponentSnapshotHash,
    components: state.expectedFrozenComponents
  });
  assert.equal(policy.defaultOrderServiceCostMinor, 600);
});

test("package policy cannot declare total unit cost below frozen component cost", async () => {
  const state = packageFixture({
    componentCosts: [{ unitStandardCostMinor: 3_000, quantityMicros: 2_000_000 }],
    declaredTotalUnitStandardCostMinor: 5_999
  });
  await assert.rejects(
    state.pricing.activate(adminCommand({ expectedRevision: 1 }), "policy-package-1"),
    (error: unknown) => (error as { code?: string }).code
      === "package_total_cost_below_component_cost"
  );
});

test("quote effectiveAt must be covered by the exact package version, not only the policy start", async () => {
  const state = packageFixture({
    policyWindow: ["2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
    packageWindow: ["2026-08-01T00:00:00.000Z", "2026-08-10T00:00:00.000Z"]
  });
  await state.pricing.activate(
    adminCommand({ expectedRevision: 1 }), "policy-package-1"
  );
  assert.ok(await state.quoteCatalog.resolveAt(state.workspace, {
    catalogItemId: "package-a", pricingPolicyVersionId: "policy-package-1",
    effectiveAt: "2026-08-09T23:59:59.999Z"
  }));
  await assert.rejects(() => state.quoteCatalog.resolveAt(state.workspace, {
    catalogItemId: "package-a", pricingPolicyVersionId: "policy-package-1",
    effectiveAt: "2026-08-10T00:00:00.000Z"
  }), (error: unknown) => (error as { code?: string }).code
    === "package_version_not_effective");
});

test("concurrent opposite package edges cannot both activate", async () => {
  const state = packageGraphFixture([
    ["package-a", "package-b"], ["package-b", "package-a"]
  ], { bothDraft: true });
  const results = await Promise.all([
    state.service.activate(adminCommand({
      expectedRevision: 1, idempotencyKey: "activate-a-to-b"
    }), "pv-a"),
    state.service.activate(adminCommand({
      expectedRevision: 1, idempotencyKey: "activate-b-to-a"
    }), "pv-b")
  ].map((promise) => promise.then(() => "ok", (error) => error.code)));
  assert.deepEqual(results.sort(), ["ok", "package_cycle"]);
  assert.equal(await state.repository.activePackageGraphIsAcyclic("team-a"), true);
  assert.deepEqual(state.graphGuardLockOrder(), [
    "temporal:team-a", "guard:team-a", "items:code-point", "versions:code-point",
    "policies:code-point", "edges:code-point", "windows:code-point",
    "snapshots:code-point"
  ]);
});

test("component policy retirement and package activation are one serializable decision", async () => {
  const state = packageFixture({ pauseAfterGraphGuard: true });
  const results = await Promise.all([
    state.service.activate(adminCommand({
      expectedRevision: 1, idempotencyKey: "activate-against-retire"
    }), "pv-a"),
    state.pricing.retire(adminCommand({
      expectedRevision: 2, idempotencyKey: "retire-against-activate"
    }), "component-policy-1")
  ].map((promise) => promise.then(() => "ok", (error) => error.code)));
  assert.equal(results.filter((result) => result === "ok").length, 1);
  assert.ok(results.includes("component_policy_not_active")
    || results.includes("pricing_policy_in_use_by_active_package"));
  assert.equal(await state.repository.hasActivePackageWithRetiredPolicy("team-a"), false);
});
```

Add tests for non-package parent, empty components, nonpositive quantity, duplicate component target, cross-workspace item/policy, currency mismatch, inactive or expired exact component policy, deterministic component cost with fractional quantity, one active overlapping package version per item/currency, same-revision concurrent PATCH with one winner, policy activation freezing the exact PackageVersion ID, effective instants exactly at both window boundaries, and a PricingPolicyVersion whose window extends beyond its PackageVersion. Add guard coverage tests for package draft create/update, activate/retire, package-policy activate, and every component/noncomponent PricingPolicy retire; each asserts the temporal barrier is first and the graph guard is the first Catalog-domain lock, referenced IDs use deterministic code-point order, validation is repeated after locking, and denial writes no version/policy/edge/snapshot. Include a policy that appears unrelated before locking while a competing package activation adds it, proving the retire cannot bypass the guard. Retiring a PackageVersion referenced by an active package policy fails `package_version_in_use`; retiring a component policy referenced by any active PackageVersion fails `pricing_policy_in_use_by_active_package`, so callers retire dependants first. Assert the final `GrowthCatalogServices` object is frozen and its router, commission projection, `quoteCatalog`, private-key lookup, and later Quote consumer all observe the exact same service/repository instances.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/package-version-service-test.ts src/catalog-router-test.ts`

Expected: FAIL because PackageVersionService and package routes are absent.

- [ ] **Step 3: Implement graph validation and frozen cost**

```ts
export async function validatePackageGraph(
  repository: Pick<CatalogRepository,
    "findCatalogItem" | "listPackageComponents" | "findPackageVersion">,
  workspaceId: string,
  rootItemId: string,
  components: readonly PackageComponentInput[]
) {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  async function visit(itemId: string): Promise<void> {
    if (visiting.has(itemId)) throw new PackageVersionError("package_cycle");
    if (visited.has(itemId)) return;
    visiting.add(itemId);
    for (const component of await activePackageComponents(
      repository, workspaceId, itemId, components, rootItemId
    )) await visit(component.componentCatalogItemId);
    visiting.delete(itemId);
    visited.add(itemId);
  }
  await visit(rootItemId);
}
```

Calculate `componentUnitStandardCostMinor` once from each frozen component policy's `unitStandardCostMinor × quantityMicros` using half-up rounding and safe BigInt summation. The package policy draft's public `unitStandardCostMinor` is the declared **total** per-unit standard cost. Activation rejects totals below the component cost, derives `packageOwnUnitServiceCostMinor = unitStandardCostMinor - componentUnitStandardCostMinor`, and freezes both values plus the exact component policy/quantity snapshot and hash in `PackageCostSnapshot`. `defaultOrderServiceCostMinor` remains a separate per-quote contribution-cost field and is never folded into the package unit cost. Quote calculation multiplies the frozen total `unitStandardCostMinor` by top-level quantity exactly once; it does not expand or add component cost again.

- [ ] **Step 4: Implement package routes and transaction checks**

Only draft accepts PATCH. Every graph-affecting command first enters Foundation's workspace temporal barrier, next enters the same workspace graph guard, then discovers the referenced transitive closure, locks each row class in the fixed order and each class by code-point ID, rereads all states, and only then reruns DFS/window/currency/overlap/in-use checks. PackageVersion activation validates the locked package CatalogItem and exact locked component item/policy records, then obtains its append timestamp/sequence from `temporalBarrier.allocateAppend` and transitions revision. PricingPolicy activation for a package validates that the exact locked PackageVersion is active and effective at the policy start, calculates and freezes `PackageCostSnapshot` in the same transaction, allocates successive temporal records for snapshot/policy rows, then activates the policy; a longer policy window does not silently extend the package window. Every PricingPolicy retirement and every PackageVersion retirement uses this same temporal→graph order and cannot invalidate an active dependent; no preflight may skip the guard, and the losing side of an activation-versus-retire race writes nothing. `QuoteCatalogReader.resolveAt` repeats policy/package/currency/snapshot validation for the actual quote `effectiveAt`, so preview/create/submit cannot rely only on policy activation-time validation. Successful retirement preserves all immutable components and cost snapshots. Add all route responses to the frozen runtime conformance suite.

- [ ] **Step 5: Run Stage 1 gates**

Implement `withGrowthCatalogMysqlTestDatabase` over `MYSQL_TEST_ADMIN_URL`: derive an isolated `goodjob_growth_catalog_<pid>_<random>` database, use a pool with at least two physical connections, install Foundation temporal-barrier/Catalog schemas including `catalog_package_graph_guards`, and always drop it in `finally`. The helper throws `MYSQL_TEST_ADMIN_URL_REQUIRED:growth-catalog` before test registration when the variable is absent; there is no skip branch. `growth-catalog-mysql-integration-test.ts` runs the real concurrent policy/package activation and same-revision PATCH races plus two-connection `A→B` versus `B→A` activation and package-activation versus PricingPolicy-retire races, including a retire whose pre-lock snapshot showed no package reference. It asserts the Foundation temporal barrier is the first business lock and the workspace graph guard is next, no deadlock/timeout is accepted as a business result, exactly one conflicting graph transition wins, the loser observes locked current state and writes nothing, every committed Catalog append has a strictly increasing workspace `temporalSequence/recordedAt`, the final graph is acyclic with no active dependency on a retired policy, then prints `MYSQL_INTEGRATION_EXECUTED:growth-catalog:<database>` only after assertions pass.

Add this stable suite only now that every referenced test file exists:

```json
{
  "scripts": {
    "test:growth-catalog": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/growth-money-test.ts src/catalog-repository-test.ts src/catalog-mysql-repository-test.ts src/catalog-service-test.ts src/catalog-router-test.ts src/commission-catalog-projection-test.ts src/growth-catalog-module-test.ts src/pricing-policy-service-test.ts src/package-version-service-test.ts src/quote-catalog-reader-test.ts src/catalog-runtime-response-conformance-test.ts src/growth-catalog-mysql-integration-test.ts"
  }
}
```

Run:

```bash
npm run test:growth-foundation --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-catalog --workspace backend
npm run test:growth-openapi --workspace backend
npm run check:growth-contracts
npm run build --workspace backend
git diff --check
```

Expected: every command exits 0; catalog and package responses conform to the frozen release, sensitive fields are omitted without capability, MySQL concurrency tests produce one activation winner, and stdout contains one `MYSQL_INTEGRATION_EXECUTED:growth-catalog:` proof marker. A missing `MYSQL_TEST_ADMIN_URL` is a hard failure, never a skipped release gate.

- [ ] **Step 6: Commit**

```bash
git add backend/src/package-version-service.ts backend/src/package-version-service-test.ts backend/src/quote-catalog-reader.ts backend/src/quote-catalog-reader-test.ts backend/src/growth-catalog-mysql-test-support.ts backend/src/growth-catalog-mysql-integration-test.ts backend/src/catalog-router.ts backend/src/catalog-router-test.ts backend/src/catalog-runtime-response-conformance-test.ts backend/src/pricing-policy-service.ts backend/src/catalog-repository.ts backend/src/catalog-mysql-repository.ts backend/src/growth-catalog-module.ts backend/src/growth-catalog-module-test.ts backend/package.json
git commit -m "feat: activate versioned catalog packages"
```
