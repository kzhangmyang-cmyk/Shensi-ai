import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import express from "express";
import { CatalogService } from "./catalog-service.js";
import { PricingPolicyService } from "./pricing-policy-service.js";
import { PackageVersionService } from "./package-version-service.js";
import { createCatalogRouter } from "./catalog-router.js";
import { InMemoryCatalogRepository } from "./catalog-repository.js";
import {
  InMemoryGrowthHttpIdempotencyRepository,
  type GrowthHttpIdempotencyRepository
} from "./growth-http-idempotency-repository.js";
import { commandContextFromRequest } from "./growth-http-preconditions.js";
import { loadGrowthContractRelease } from "./growth-openapi.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";

function releasedValidators(): {
  item: ValidateFunction;
  page: ValidateFunction;
  pricingPolicy: ValidateFunction;
  pricingPolicyPage: ValidateFunction;
  packageVersion: ValidateFunction;
  packageVersionPage: ValidateFunction;
  assertOperationResponse(
    operationId: CatalogOperationId,
    status: number,
    body: unknown
  ): void;
} {
  const release = loadGrowthContractRelease();
  assert.equal(release.manifest.contractVersion, "1.0.10");
  const components = structuredClone(
    (release.document as Record<string, any>).components
  );
  delete components.schemas.PricingPolicyVersion.$id;
  delete components.schemas.PackageVersion.$id;
  const root = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    components
  };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const item = ajv.compile({
    ...root,
    $ref: "#/components/schemas/CatalogItem"
  });
  const page = ajv.compile({
    ...root,
    $ref: "#/components/schemas/CatalogItemPagedResult"
  });
  const apiError = ajv.compile({
    ...root,
    $ref: "#/components/schemas/ApiError"
  });
  const pricingPolicy = ajv.compile({
    ...root,
    $ref: "#/components/schemas/PricingPolicyVersion"
  });
  const pricingPolicyPage = ajv.compile({
    ...root,
    $ref: "#/components/schemas/PricingPolicyVersionPagedResult"
  });
  const packageVersion = ajv.compile({
    ...root,
    $ref: "#/components/schemas/PackageVersion"
  });
  const packageVersionPage = ajv.compile({
    ...root,
    $ref: "#/components/schemas/PackageVersionPagedResult"
  });
  const operationLocations: Record<CatalogOperationId, readonly [string, string]> = {
    listCatalogItems: ["/api/v1/catalog/items", "get"],
    createCatalogItem: ["/api/v1/catalog/items", "post"],
    getCatalogItem: ["/api/v1/catalog/items/{id}", "get"],
    updateCatalogItem: ["/api/v1/catalog/items/{id}", "patch"],
    retireCatalogItem: ["/api/v1/catalog/items/{id}/retire", "post"],
    listPricingPolicyVersions: ["/api/v1/catalog/pricing-policies", "get"],
    createPricingPolicyVersion: ["/api/v1/catalog/pricing-policies", "post"],
    getPricingPolicyVersion: ["/api/v1/catalog/pricing-policies/{id}", "get"],
    activatePricingPolicyVersion: [
      "/api/v1/catalog/pricing-policies/{id}/activate", "post"
    ],
    retirePricingPolicyVersion: [
      "/api/v1/catalog/pricing-policies/{id}/retire", "post"
    ],
    listPackageVersions: ["/api/v1/catalog/packages/{itemId}/versions", "get"],
    createPackageVersion: ["/api/v1/catalog/packages/{itemId}/versions", "post"],
    getPackageVersion: ["/api/v1/catalog/package-versions/{id}", "get"],
    updatePackageVersion: ["/api/v1/catalog/package-versions/{id}", "patch"],
    activatePackageVersion: [
      "/api/v1/catalog/package-versions/{id}/activate", "post"
    ],
    retirePackageVersion: [
      "/api/v1/catalog/package-versions/{id}/retire", "post"
    ]
  };
  return {
    item,
    page,
    pricingPolicy,
    pricingPolicyPage,
    packageVersion,
    packageVersionPage,
    assertOperationResponse(operationId, status, body) {
      const [path, method] = operationLocations[operationId];
      const operation = (release.document as Record<string, any>)
        .paths[path][method];
      assert.equal(operation.operationId, operationId);
      assert.ok(
        operation.responses[String(status)],
        `${operationId} does not release response status ${status}`
      );
      const validate = status >= 400 ? apiError
        : operationId === "listCatalogItems" ? page
        : operationId === "listPricingPolicyVersions" ? pricingPolicyPage
        : operationId === "listPackageVersions" ? packageVersionPage
        : operationId.includes("PackageVersion") ? packageVersion
        : operationId.includes("PricingPolicy") ? pricingPolicy
        : item;
      assert.equal(validate(body), true, JSON.stringify(validate.errors));
    }
  };
}

type CatalogOperationId =
  | "listCatalogItems"
  | "createCatalogItem"
  | "getCatalogItem"
  | "updateCatalogItem"
  | "retireCatalogItem"
  | "listPricingPolicyVersions"
  | "createPricingPolicyVersion"
  | "getPricingPolicyVersion"
  | "activatePricingPolicyVersion"
  | "retirePricingPolicyVersion"
  | "listPackageVersions"
  | "createPackageVersion"
  | "getPackageVersion"
  | "updatePackageVersion"
  | "activatePackageVersion"
  | "retirePackageVersion";

export async function assertCatalogRuntimeResponsesConform(): Promise<void> {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  );
  const temporalBarrier = new DefaultGrowthTemporalBarrier(transactions);
  const repository = new InMemoryCatalogRepository({ transactions, temporalBarrier });
  const service = new CatalogService({
    repository,
    idFactory: () => "catalog-item-conformance"
  });
  const pricingPolicyService = new PricingPolicyService({
    repository,
    idFactory: () => "pricing-policy-conformance"
  });
  const packageVersionService = new PackageVersionService({
    repository,
    idFactory: () => "package-version-conformance"
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.header("X-Test-Role") === "sales" ? "sales" : "admin";
    req.activeWorkspace = Object.freeze({
      workspaceId: "team-a",
      kind: "team",
      actorId: "admin-1",
      role,
      teamId: "team-a",
      capabilities: capabilitiesForHumanRole(role),
      capabilityRegistryVersion: "growth-capabilities.v1"
    });
    next();
  });
  const storedIdempotency = new InMemoryGrowthHttpIdempotencyRepository();
  const httpIdempotency: GrowthHttpIdempotencyRepository = {
    async reserve(input) {
      if (input.key === "catalog-conformance-in-progress") {
        return { kind: "in_progress", retryAfterMs: 1_500 };
      }
      return storedIdempotency.reserve(input);
    },
    complete: (...args) => storedIdempotency.complete(...args),
    release: (...args) => storedIdempotency.release(...args)
  };
  app.use("/api/v1/catalog", createCatalogRouter({
    catalogService: service,
    pricingPolicyService,
    packageVersionService,
    httpIdempotency,
    workspaceContext: (req) => req.activeWorkspace!,
    commandContextFactory: commandContextFromRequest
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const call = async (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
      workspaceId: string | null = "team-a"
    ) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(workspaceId === null ? {} : { "X-Workspace-Id": workspaceId }),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { response, body: await response.json() };
    };
    const input = {
      type: "service",
      code: "SVC-CONFORMANCE",
      name: "Contract service",
      description: null,
      unit: "case"
    };
    const validators = releasedValidators();
    const created = await call(
      "POST",
      "/api/v1/catalog/items",
      input,
      { "Idempotency-Key": "catalog-conformance-create" }
    );
    assert.equal(created.response.status, 201);
    validators.assertOperationResponse(
      "createCatalogItem", created.response.status, created.body
    );
    assert.equal(
      validators.item(created.body),
      true,
      JSON.stringify(validators.item.errors)
    );
    assert.equal(
      created.response.headers.get("etag"),
      '"catalog-item:catalog-item-conformance:1"'
    );

    const replayed = await call(
      "POST",
      "/api/v1/catalog/items",
      input,
      { "Idempotency-Key": "catalog-conformance-create" }
    );
    assert.equal(replayed.response.status, 201);
    assert.equal(replayed.response.headers.get("idempotency-replayed"), "true");
    validators.assertOperationResponse(
      "createCatalogItem", replayed.response.status, replayed.body
    );

    const pricingInput = {
      catalogItemId: "catalog-item-conformance",
      packageVersionId: null,
      currency: "CNY",
      listUnitPriceMinor: 12_000,
      unitStandardCostMinor: 8_000,
      defaultOrderDeliveryCostMinor: 100,
      defaultOrderSalesCostMinor: 200,
      defaultOrderServiceCostMinor: 300,
      absoluteFloorUnitPriceMinor: 10_000,
      standardDiscountLimitBps: 500,
      absoluteDiscountLimitBps: 1_000,
      targetGrossMarginBps: 3_000,
      absoluteMinimumGrossMarginBps: 1_500,
      standardPaymentTermDays: 30,
      absolutePaymentTermDays: 60,
      approvalThresholds: {
        discountCapability: "quote.exception.discount.approve",
        marginCapability: "quote.exception.margin.approve",
        paymentTermsCapability: "quote.exception.payment_terms.approve",
        giftCapability: "quote.exception.gift.approve",
        creditCapability: "quote.exception.credit.approve",
        manualCapability: "quote.exception.manual.approve",
        creditRiskThresholdBps: 6_000,
        manualEscalationEnabled: true
      },
      surchargePolicies: [],
      giftPolicies: [],
      validFrom: "2026-08-09T08:00:00.000Z",
      validTo: "2026-09-09T08:00:00.000Z"
    };
    const pricingCreated = await call(
      "POST", "/api/v1/catalog/pricing-policies", pricingInput,
      { "Idempotency-Key": "pricing-conformance-create" }
    );
    assert.equal(pricingCreated.response.status, 201);
    validators.assertOperationResponse(
      "createPricingPolicyVersion",
      pricingCreated.response.status,
      pricingCreated.body
    );
    assert.equal(validators.pricingPolicy(pricingCreated.body), true,
      JSON.stringify(validators.pricingPolicy.errors));
    assert.equal(pricingCreated.response.headers.get("etag"),
      '"pricing-policy:pricing-policy-conformance:1"');
    const pricingListed = await call(
      "GET", "/api/v1/catalog/pricing-policies?sort=code&limit=20"
    );
    assert.equal(pricingListed.response.status, 200);
    validators.assertOperationResponse(
      "listPricingPolicyVersions",
      pricingListed.response.status,
      pricingListed.body
    );
    const pricingFetched = await call(
      "GET", "/api/v1/catalog/pricing-policies/pricing-policy-conformance"
    );
    assert.equal(pricingFetched.response.status, 200);
    validators.assertOperationResponse(
      "getPricingPolicyVersion",
      pricingFetched.response.status,
      pricingFetched.body
    );
    const pricingRedacted = await call(
      "GET", "/api/v1/catalog/pricing-policies/pricing-policy-conformance",
      undefined, { "X-Test-Role": "sales" }
    );
    assert.equal(pricingRedacted.response.status, 200);
    assert.equal(pricingRedacted.body.amountVisibility, "redacted");
    assert.equal("unitStandardCostMinor" in pricingRedacted.body, false);
    validators.assertOperationResponse(
      "getPricingPolicyVersion",
      pricingRedacted.response.status,
      pricingRedacted.body
    );
    const pricingActivated = await call(
      "POST",
      "/api/v1/catalog/pricing-policies/pricing-policy-conformance/activate",
      {}, {
        "Idempotency-Key": "pricing-conformance-activate",
        "If-Match": '"pricing-policy:pricing-policy-conformance:1"'
      }
    );
    assert.equal(pricingActivated.response.status, 200);
    validators.assertOperationResponse(
      "activatePricingPolicyVersion",
      pricingActivated.response.status,
      pricingActivated.body
    );
    const pricingRetired = await call(
      "POST",
      "/api/v1/catalog/pricing-policies/pricing-policy-conformance/retire",
      {}, {
        "Idempotency-Key": "pricing-conformance-retire",
        "If-Match": '"pricing-policy:pricing-policy-conformance:2"'
      }
    );
    assert.equal(pricingRetired.response.status, 200);
    validators.assertOperationResponse(
      "retirePricingPolicyVersion",
      pricingRetired.response.status,
      pricingRetired.body
    );

    await repository.appendCatalogItem({
      id: "package-conformance", workspaceId: "team-a", type: "package",
      code: "PKG-CONFORMANCE", name: "Contract package", description: null,
      unit: "set", status: "active", revision: 1, createdBy: "admin-1",
      createdAt: "2026-08-09T08:00:00.000Z",
      updatedAt: "2026-08-09T08:00:00.000Z"
    });
    await repository.appendCatalogItem({
      id: "component-conformance", workspaceId: "team-a", type: "service",
      code: "CMP-CONFORMANCE", name: "Contract component", description: null,
      unit: "unit", status: "active", revision: 1, createdBy: "admin-1",
      createdAt: "2026-08-09T08:00:00.000Z",
      updatedAt: "2026-08-09T08:00:00.000Z"
    });
    await repository.appendPricingPolicyVersion({
      ...pricingInput,
      id: "component-policy-conformance", workspaceId: "team-a",
      catalogItemId: "component-conformance", version: 1, status: "active",
      source: "native", capabilityRegistryVersion: "growth-capabilities.v1",
      revision: 2, createdBy: "admin-1",
      createdAt: "2026-08-09T08:00:00.000Z"
    });
    const packageInput = {
      currency: "CNY", validFrom: "2026-08-09T08:00:00.000Z",
      validTo: "2026-09-09T08:00:00.000Z",
      components: [{
        componentCatalogItemId: "component-conformance",
        componentPricingPolicyVersionId: "component-policy-conformance",
        quantityMicros: 1_000_000
      }]
    };
    const packageCreated = await call(
      "POST", "/api/v1/catalog/packages/package-conformance/versions",
      packageInput, {
        "Idempotency-Key": "package-conformance-create",
        "If-Match": '"catalog-item:package-conformance:1"'
      }
    );
    assert.equal(packageCreated.response.status, 201);
    validators.assertOperationResponse(
      "createPackageVersion", packageCreated.response.status, packageCreated.body
    );
    assert.equal(validators.packageVersion(packageCreated.body), true,
      JSON.stringify(validators.packageVersion.errors));
    const packageListed = await call(
      "GET", "/api/v1/catalog/packages/package-conformance/versions"
    );
    validators.assertOperationResponse(
      "listPackageVersions", packageListed.response.status, packageListed.body
    );
    const packageFetched = await call(
      "GET", "/api/v1/catalog/package-versions/package-version-conformance"
    );
    validators.assertOperationResponse(
      "getPackageVersion", packageFetched.response.status, packageFetched.body
    );
    const packageUpdated = await call(
      "PATCH", "/api/v1/catalog/package-versions/package-version-conformance",
      packageInput, {
        "Idempotency-Key": "package-conformance-update",
        "If-Match": '"package-version:package-version-conformance:1"'
      }
    );
    validators.assertOperationResponse(
      "updatePackageVersion", packageUpdated.response.status, packageUpdated.body
    );
    const packageActivated = await call(
      "POST",
      "/api/v1/catalog/package-versions/package-version-conformance/activate",
      {}, {
        "Idempotency-Key": "package-conformance-activate",
        "If-Match": '"package-version:package-version-conformance:2"'
      }
    );
    validators.assertOperationResponse(
      "activatePackageVersion", packageActivated.response.status,
      packageActivated.body
    );
    const packageRetired = await call(
      "POST", "/api/v1/catalog/package-versions/package-version-conformance/retire",
      {}, {
        "Idempotency-Key": "package-conformance-retire",
        "If-Match": '"package-version:package-version-conformance:3"'
      }
    );
    validators.assertOperationResponse(
      "retirePackageVersion", packageRetired.response.status, packageRetired.body
    );

    const listed = await call("GET", "/api/v1/catalog/items?sort=code&limit=20");
    assert.equal(listed.response.status, 200);
    validators.assertOperationResponse(
      "listCatalogItems", listed.response.status, listed.body
    );
    assert.equal(
      validators.page(listed.body),
      true,
      JSON.stringify(validators.page.errors)
    );

    const malformedCursor = await call(
      "GET",
      "/api/v1/catalog/items?cursor=not-a-cursor"
    );
    assert.equal(malformedCursor.response.status, 403);
    assert.equal(malformedCursor.body.code, "invalid_catalog_cursor");
    validators.assertOperationResponse(
      "listCatalogItems", malformedCursor.response.status, malformedCursor.body
    );

    const inProgress = await call(
      "POST",
      "/api/v1/catalog/items",
      { ...input, code: "SVC-IN-PROGRESS" },
      { "Idempotency-Key": "catalog-conformance-in-progress" }
    );
    assert.equal(inProgress.response.status, 409);
    assert.equal(inProgress.response.headers.get("retry-after"), "2");
    assert.equal(inProgress.body.code, "idempotency_in_progress");
    assert.equal(inProgress.body.retryable, true);
    validators.assertOperationResponse(
      "createCatalogItem", inProgress.response.status, inProgress.body
    );

    const fetched = await call(
      "GET",
      "/api/v1/catalog/items/catalog-item-conformance"
    );
    assert.equal(fetched.response.status, 200);
    validators.assertOperationResponse(
      "getCatalogItem", fetched.response.status, fetched.body
    );
    assert.equal(validators.item(fetched.body), true);

    const updated = await call(
      "PATCH",
      "/api/v1/catalog/items/catalog-item-conformance",
      { name: "Contract service v2" },
      {
        "Idempotency-Key": "catalog-conformance-update",
        "If-Match": '"catalog-item:catalog-item-conformance:1"'
      }
    );
    assert.equal(updated.response.status, 200);
    validators.assertOperationResponse(
      "updateCatalogItem", updated.response.status, updated.body
    );
    assert.equal(validators.item(updated.body), true);
    assert.equal(
      updated.response.headers.get("etag"),
      '"catalog-item:catalog-item-conformance:2"'
    );

    const retired = await call(
      "POST",
      "/api/v1/catalog/items/catalog-item-conformance/retire",
      {},
      {
        "Idempotency-Key": "catalog-conformance-retire",
        "If-Match": '"catalog-item:catalog-item-conformance:2"'
      }
    );
    assert.equal(retired.response.status, 200);
    validators.assertOperationResponse(
      "retireCatalogItem", retired.response.status, retired.body
    );
    assert.equal(validators.item(retired.body), true);
    assert.equal(retired.body.status, "retired");
    assert.equal(
      retired.response.headers.get("etag"),
      '"catalog-item:catalog-item-conformance:3"'
    );

    for (const operation of [
      ["listCatalogItems", "GET", "/api/v1/catalog/items", undefined, {}],
      ["createCatalogItem", "POST", "/api/v1/catalog/items", input,
        { "Idempotency-Key": "missing-workspace-create" }],
      ["getCatalogItem", "GET",
        "/api/v1/catalog/items/catalog-item-conformance", undefined, {}],
      ["updateCatalogItem", "PATCH",
        "/api/v1/catalog/items/catalog-item-conformance",
        { name: "Blocked" }, {
          "Idempotency-Key": "missing-workspace-update",
          "If-Match": '"catalog-item:catalog-item-conformance:3"'
        }],
      ["retireCatalogItem", "POST",
        "/api/v1/catalog/items/catalog-item-conformance/retire", {}, {
          "Idempotency-Key": "missing-workspace-retire",
          "If-Match": '"catalog-item:catalog-item-conformance:3"'
        }]
    ] as const) {
      const [operationId, method, path, body, headers] = operation;
      const missingWorkspace = await call(method, path, body, headers, null);
      assert.equal(missingWorkspace.response.status, 403);
      assert.equal(missingWorkspace.body.code, "workspace_required");
      validators.assertOperationResponse(
        operationId, missingWorkspace.response.status, missingWorkspace.body
      );
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
}

if (process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  test(
    "Catalog and pricing policy responses conform to release 1.0.1",
    assertCatalogRuntimeResponsesConform
  );
}
