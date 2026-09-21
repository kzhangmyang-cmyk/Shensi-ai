import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { CatalogService } from "./catalog-service.js";
import { PricingPolicyService } from "./pricing-policy-service.js";
import { PackageVersionService } from "./package-version-service.js";
import { createCatalogRouter } from "./catalog-router.js";
import { InMemoryCatalogRepository } from "./catalog-repository.js";
import {
  InMemoryGrowthHttpIdempotencyRepository
} from "./growth-http-idempotency-repository.js";
import { commandContextFromRequest } from "./growth-http-preconditions.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";

const NOW = "2026-08-09T08:00:00.000Z";

function adminContext(workspaceId = "team-a"): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId,
    kind: "team",
    actorId: "admin-1",
    role: "admin",
    teamId: workspaceId,
    capabilities: capabilitiesForHumanRole("admin"),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

async function catalogRouterFixture() {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(NOW);
  const temporalBarrier = new DefaultGrowthTemporalBarrier(transactions);
  const repository = new InMemoryCatalogRepository({ transactions, temporalBarrier });
  let nextId = 0;
  const catalogService = new CatalogService({
    repository,
    idFactory: () => `item-${++nextId}`
  });
  let nextPolicyId = 0;
  const pricingPolicyService = new PricingPolicyService({
    repository,
    idFactory: () => `policy-${++nextPolicyId}`
  });
  let nextPackageId = 0;
  const packageVersionService = new PackageVersionService({
    repository,
    idFactory: () => `package-version-${++nextPackageId}`
  });
  const httpIdempotency = new InMemoryGrowthHttpIdempotencyRepository();
  let workspaceCalls = 0;
  let commandCalls = 0;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const context = adminContext(
      typeof req.header("X-Test-Workspace") === "string"
        ? req.header("X-Test-Workspace")!
        : "team-a"
    );
    req.activeWorkspace = req.header("X-Test-Role") === "sales"
      ? Object.freeze({
          ...context,
          role: "sales" as const,
          capabilities: capabilitiesForHumanRole("sales")
        })
      : context;
    next();
  });
  app.use("/api/v1/catalog", createCatalogRouter({
    catalogService,
    pricingPolicyService,
    packageVersionService,
    httpIdempotency,
    workspaceContext(req) {
      workspaceCalls += 1;
      return req.activeWorkspace!;
    },
    commandContextFactory(req, input) {
      commandCalls += 1;
      return commandContextFromRequest(req, input);
    }
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const request = async (
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      workspaceId?: string | null;
    } = {}
  ) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.workspaceId === null
          ? {} : { "X-Workspace-Id": options.workspaceId ?? "team-a" }),
        ...options.headers
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const body = await response.json();
    return { response, body };
  };
  return {
    repository,
    request,
    calls: () => ({ workspaceCalls, commandCalls }),
    close: () => new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()))
  };
}

test("package routes preserve released statuses, scoped ETags, and closed bodies", async () => {
  const app = await catalogRouterFixture();
  try {
    await app.repository.appendCatalogItem({
      id: "package-a", workspaceId: "team-a", type: "package", code: "PKG-A",
      name: "Package A", description: null, unit: "set", status: "active",
      revision: 1, createdBy: "admin-1", createdAt: NOW, updatedAt: NOW
    });
    await app.repository.appendCatalogItem({
      id: "component-a", workspaceId: "team-a", type: "service", code: "CMP-A",
      name: "Component A", description: null, unit: "unit", status: "active",
      revision: 1, createdBy: "admin-1", createdAt: NOW, updatedAt: NOW
    });
    await app.repository.appendPricingPolicyVersion({
      ...pricingBody,
      id: "component-policy-a", workspaceId: "team-a",
      catalogItemId: "component-a", version: 1, status: "active",
      source: "native", capabilityRegistryVersion: "growth-capabilities.v1",
      revision: 2, createdBy: "admin-1", createdAt: NOW
    });
    const body = {
      currency: "CNY", validFrom: NOW,
      validTo: "2026-09-09T08:00:00.000Z",
      components: [{
        componentCatalogItemId: "component-a",
        componentPricingPolicyVersionId: "component-policy-a",
        quantityMicros: 1_000_000
      }]
    };
    const created = await app.request(
      "POST", "/api/v1/catalog/packages/package-a/versions", {
        headers: {
          "Idempotency-Key": "package-create-1",
          "If-Match": '"catalog-item:package-a:1"'
        }, body
      }
    );
    assert.equal(created.response.status, 201);
    assert.equal(created.response.headers.get("etag"),
      '"package-version:package-version-1:1"');
    assert.equal("createdBy" in created.body, false);
    assert.deepEqual(Object.keys(created.body.components[0]).sort(), [
      "componentCatalogItemId", "componentPricingPolicyVersionId",
      "packageVersionId", "quantityMicros"
    ]);
    const replay = await app.request(
      "POST", "/api/v1/catalog/packages/package-a/versions", {
        headers: {
          "Idempotency-Key": "package-create-1",
          "If-Match": '"catalog-item:package-a:1"'
        }, body
      }
    );
    assert.equal(replay.response.status, 201);
    assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
    const activated = await app.request(
      "POST", `/api/v1/catalog/package-versions/${created.body.id}/activate`, {
        headers: {
          "Idempotency-Key": "package-activate-1",
          "If-Match": `"package-version:${created.body.id}:1"`
        }, body: {}
      }
    );
    assert.equal(activated.response.status, 200);
    assert.equal(activated.response.headers.get("etag"),
      `"package-version:${created.body.id}:2"`);
    const closed = await app.request(
      "PATCH", `/api/v1/catalog/package-versions/${created.body.id}`, {
        headers: {
          "Idempotency-Key": "package-closed-1",
          "If-Match": `"package-version:${created.body.id}:2"`
        }, body: { ...body, workspaceId: "team-b" }
      }
    );
    assert.equal(closed.response.status, 400);
    assert.equal(closed.body.code, "invalid_request");
  } finally {
    await app.close();
  }
});

const createBody = {
  type: "service",
  code: "SVC-001",
  name: "诊断服务",
  description: "获客诊断",
  unit: "次"
};

const pricingBody = {
  catalogItemId: "item-1",
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
  validFrom: NOW,
  validTo: "2026-09-09T08:00:00.000Z"
};

test("create replay keeps the released 201 and update requires an ID-scoped ETag", async () => {
  const app = await catalogRouterFixture();
  try {
    const first = await app.request("POST", "/api/v1/catalog/items", {
      headers: { "Idempotency-Key": "catalog-create-0001" },
      body: createBody
    });
    assert.equal(first.response.status, 201);
    assert.equal(first.response.headers.get("etag"), '"catalog-item:item-1:1"');
    assert.equal("createdBy" in first.body, false);
    const replay = await app.request("POST", "/api/v1/catalog/items", {
      headers: { "Idempotency-Key": "catalog-create-0001" },
      body: createBody
    });
    assert.equal(replay.response.status, 201);
    assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
    assert.equal(replay.body.id, first.body.id);
    const missing = await app.request(
      "PATCH",
      `/api/v1/catalog/items/${first.body.id}`,
      {
        headers: { "Idempotency-Key": "catalog-update-0001" },
        body: { name: "无并发保护" }
      }
    );
    assert.equal(missing.response.status, 428);
    assert.equal(missing.body.code, "revision_required");
    assert.deepEqual(app.calls(), { workspaceCalls: 0, commandCalls: 2 });
  } finally {
    await app.close();
  }
});

test("every Catalog operation rejects missing, blank, and all workspace headers before trusted adapters", async () => {
  const app = await catalogRouterFixture();
  try {
    const operations = [
      { method: "GET", path: "/api/v1/catalog/items" },
      {
        method: "POST",
        path: "/api/v1/catalog/items",
        body: createBody,
        headers: { "Idempotency-Key": "workspace-create" }
      },
      { method: "GET", path: "/api/v1/catalog/items/item-1" },
      {
        method: "PATCH",
        path: "/api/v1/catalog/items/item-1",
        body: { name: "Blocked" },
        headers: {
          "Idempotency-Key": "workspace-update",
          "If-Match": '"catalog-item:item-1:1"'
        }
      },
      {
        method: "POST",
        path: "/api/v1/catalog/items/item-1/retire",
        body: {},
        headers: {
          "Idempotency-Key": "workspace-retire",
          "If-Match": '"catalog-item:item-1:1"'
        }
      }
    ] as const;
    for (const workspaceId of [null, " ", "all"] as const) {
      for (const operation of operations) {
        const result = await app.request(operation.method, operation.path, {
          workspaceId,
          body: "body" in operation ? operation.body : undefined,
          headers: "headers" in operation ? operation.headers : undefined
        });
        assert.equal(result.response.status, 403);
        assert.equal(result.body.code, "workspace_required");
      }
    }
    assert.deepEqual(app.calls(), { workspaceCalls: 0, commandCalls: 0 });
  } finally {
    await app.close();
  }
});

test("omitted Catalog list limit uses the released default of 50", async () => {
  const app = await catalogRouterFixture();
  try {
    for (let index = 1; index <= 21; index += 1) {
      const created = await app.request("POST", "/api/v1/catalog/items", {
        headers: { "Idempotency-Key": `default-limit-${index}` },
        body: {
          ...createBody,
          code: `DEFAULT-${String(index).padStart(2, "0")}`,
          name: `Default ${index}`
        }
      });
      assert.equal(created.response.status, 201);
    }
    const listed = await app.request("GET", "/api/v1/catalog/items?sort=code");
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.items.length, 21);
    assert.equal(listed.body.hasMore, false);
  } finally {
    await app.close();
  }
});

test("one idempotency key cannot cross catalog resource path IDs", async () => {
  const app = await catalogRouterFixture();
  try {
    for (const item of [
      { ...createBody, code: "ITEM-A", name: "A" },
      { ...createBody, code: "ITEM-B", name: "B" }
    ]) {
      const result = await app.request("POST", "/api/v1/catalog/items", {
        headers: { "Idempotency-Key": `create-${item.code}` },
        body: item
      });
      assert.equal(result.response.status, 201);
    }
    const first = await app.request("PATCH", "/api/v1/catalog/items/item-1", {
      headers: {
        "Idempotency-Key": "catalog-cross-id-0001",
        "If-Match": '"catalog-item:item-1:1"'
      },
      body: { name: "A2" }
    });
    assert.equal(first.response.status, 200);
    const conflict = await app.request("PATCH", "/api/v1/catalog/items/item-2", {
      headers: {
        "Idempotency-Key": "catalog-cross-id-0001",
        "If-Match": '"catalog-item:item-2:1"'
      },
      body: { name: "A2" }
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.code, "idempotency_conflict");
    assert.equal((await app.repository.findCatalogItem("team-a", "item-2"))!.revision, 1);
  } finally {
    await app.close();
  }
});

test("request bodies and list queries are closed to the released 1.0.1 keys", async () => {
  const app = await catalogRouterFixture();
  try {
    const bodyOverride = await app.request("POST", "/api/v1/catalog/items", {
      headers: { "Idempotency-Key": "closed-body-0001" },
      body: { ...createBody, workspaceId: "team-b" }
    });
    assert.equal(bodyOverride.response.status, 400);
    assert.equal(bodyOverride.body.code, "invalid_request");
    const unpublished = await app.request(
      "GET",
      "/api/v1/catalog/items?sort=code&direction=desc&type=service"
    );
    assert.equal(unpublished.response.status, 403);
    assert.equal(unpublished.body.code, "invalid_request");
  } finally {
    await app.close();
  }
});

test("list/get use the sole workspace resolver and preserve nullable descriptions", async () => {
  const app = await catalogRouterFixture();
  try {
    const created = await app.request("POST", "/api/v1/catalog/items", {
      headers: { "Idempotency-Key": "nullable-create-0001" },
      body: { ...createBody, description: null }
    });
    assert.equal(created.response.status, 201);
    const listed = await app.request("GET", "/api/v1/catalog/items?limit=20&sort=updatedAt");
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.items[0].description, null);
    assert.deepEqual(Object.keys(listed.body).sort(), ["hasMore", "items", "nextAfter"]);
    const fetched = await app.request("GET", `/api/v1/catalog/items/${created.body.id}`);
    assert.equal(fetched.response.status, 200);
    assert.equal(fetched.response.headers.get("etag"), '"catalog-item:item-1:1"');
    assert.deepEqual(app.calls(), { workspaceCalls: 2, commandCalls: 1 });
  } finally {
    await app.close();
  }
});

test("pricing create and lifecycle replay keep released statuses, ID ETags, and current projection", async () => {
  const app = await catalogRouterFixture();
  try {
    const item = await app.request("POST", "/api/v1/catalog/items", {
      headers: { "Idempotency-Key": "pricing-parent-create" },
      body: createBody
    });
    assert.equal(item.response.status, 201);
    const created = await app.request("POST", "/api/v1/catalog/pricing-policies", {
      headers: { "Idempotency-Key": "pricing-create" },
      body: pricingBody
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.response.headers.get("etag"), '"pricing-policy:policy-1:1"');
    assert.equal(created.body.amountVisibility, "full");
    assert.equal("capabilityRegistryVersion" in created.body, false);
    const createReplay = await app.request(
      "POST", "/api/v1/catalog/pricing-policies", {
        headers: {
          "Idempotency-Key": "pricing-create",
          "X-Test-Role": "sales"
        },
        body: pricingBody
      }
    );
    assert.equal(createReplay.response.status, 201);
    assert.equal(createReplay.response.headers.get("idempotency-replayed"), "true");
    assert.equal(createReplay.body.amountVisibility, "redacted");
    assert.equal("unitStandardCostMinor" in createReplay.body, false);
    const activated = await app.request(
      "POST", "/api/v1/catalog/pricing-policies/policy-1/activate", {
        headers: {
          "Idempotency-Key": "pricing-activate",
          "If-Match": '"pricing-policy:policy-1:1"'
        },
        body: {}
      }
    );
    assert.equal(activated.response.status, 200);
    assert.equal(activated.response.headers.get("etag"), '"pricing-policy:policy-1:2"');
    const activateReplay = await app.request(
      "POST", "/api/v1/catalog/pricing-policies/policy-1/activate", {
        headers: {
          "Idempotency-Key": "pricing-activate",
          "If-Match": '"pricing-policy:policy-1:1"',
          "X-Test-Role": "sales"
        },
        body: {}
      }
    );
    assert.equal(activateReplay.response.status, 200);
    assert.equal(activateReplay.response.headers.get("idempotency-replayed"), "true");
    assert.equal(activateReplay.body.amountVisibility, "redacted");
    assert.equal("approvalThresholds" in activateReplay.body, false);
  } finally {
    await app.close();
  }
});

test("every pricing policy route rejects absent workspace identity before adapters", async () => {
  const app = await catalogRouterFixture();
  try {
    const operations = [
      { method: "GET", path: "/api/v1/catalog/pricing-policies" },
      {
        method: "POST", path: "/api/v1/catalog/pricing-policies",
        body: pricingBody, headers: { "Idempotency-Key": "missing-pricing-create" }
      },
      { method: "GET", path: "/api/v1/catalog/pricing-policies/policy-1" },
      {
        method: "POST", path: "/api/v1/catalog/pricing-policies/policy-1/activate",
        body: {}, headers: {
          "Idempotency-Key": "missing-pricing-activate",
          "If-Match": '"pricing-policy:policy-1:1"'
        }
      },
      {
        method: "POST", path: "/api/v1/catalog/pricing-policies/policy-1/retire",
        body: {}, headers: {
          "Idempotency-Key": "missing-pricing-retire",
          "If-Match": '"pricing-policy:policy-1:1"'
        }
      }
    ] as const;
    const before = app.calls();
    for (const workspaceId of [null, " ", "all"] as const) {
      for (const operation of operations) {
        const result = await app.request(operation.method, operation.path, {
          workspaceId,
          body: "body" in operation ? operation.body : undefined,
          headers: "headers" in operation ? operation.headers : undefined
        });
        assert.equal(result.response.status, 403);
        assert.equal(result.body.code, "workspace_required");
      }
    }
    assert.deepEqual(app.calls(), before);
  } finally {
    await app.close();
  }
});

test("pricing policy bodies and queries reject unpublished keys", async () => {
  const app = await catalogRouterFixture();
  try {
    const bodyOverride = await app.request(
      "POST", "/api/v1/catalog/pricing-policies", {
        headers: { "Idempotency-Key": "closed-pricing-body" },
        body: { ...pricingBody, workspaceId: "team-b" }
      }
    );
    assert.equal(bodyOverride.response.status, 400);
    assert.equal(bodyOverride.body.code, "invalid_request");
    const queryOverride = await app.request(
      "GET", "/api/v1/catalog/pricing-policies?status=active"
    );
    assert.equal(queryOverride.response.status, 403);
    assert.equal(queryOverride.body.code, "invalid_request");
  } finally {
    await app.close();
  }
});
