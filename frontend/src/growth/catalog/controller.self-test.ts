import { strict as assert } from "node:assert";
import { GrowthApiError } from "../http";
import {
  createCatalogController,
  type CatalogPageState
} from "./controller";
import type { CatalogApi } from "./api";

function apiFixture(overrides: Partial<CatalogApi> = {}): CatalogApi {
  return {
    async listItems() {
      return {
        status: 200,
        etag: null,
        body: { items: [], nextCursor: null }
      } as never;
    },
    async getItem() {
      throw new Error("unused");
    },
    async listPackageVersions() {
      return {
        status: 200,
        etag: null,
        body: { items: [], nextCursor: null }
      } as never;
    },
    async listPricingPolicies() {
      return {
        status: 200,
        etag: null,
        body: { items: [], nextCursor: null }
      } as never;
    },
    async updateItem() {
      throw new Error("unused");
    },
    async updatePackageVersion() {
      throw new Error("unused");
    },
    async activatePackageVersion() {
      throw new Error("unused");
    },
    async retirePackageVersion() {
      throw new Error("unused");
    },
    async activatePricingPolicy() {
      throw new Error("unused");
    },
    async retirePricingPolicy() {
      throw new Error("unused");
    },
    ...overrides
  };
}

const capabilities = new Set(["catalog.read"]);
const controller = createCatalogController({
  api: apiFixture(),
  hasFeature: (feature) => feature === "catalog",
  hasCapability: (capability) => capabilities.has(capability)
});

const empty = await controller.load();
assert.equal(empty.kind, "empty");

capabilities.delete("catalog.read");
assert.deepEqual(await controller.load(), { kind: "forbidden" });

const conflicting = createCatalogController({
  api: apiFixture({
    async listItems() {
      throw new GrowthApiError(409, "idempotency_conflict");
    }
  }),
  hasFeature: () => true,
  hasCapability: () => true
});
assert.deepEqual(await conflicting.load(), {
  kind: "conflict",
  message: "idempotency_conflict"
});

const readyController = createCatalogController({
  api: apiFixture({
    async listItems() {
      return {
        status: 200,
        etag: null,
        body: {
          items: [{
            id: "item-1",
            workspaceId: "ws-1",
            code: "A",
            name: "产品",
            type: "product",
            status: "active",
            unit: "件",
            description: null,
            revision: 1,
            createdAt: "2026-08-09T08:00:00.000Z",
            updatedAt: "2026-08-09T08:00:00.000Z"
          }],
          nextCursor: null
        }
      } as never;
    }
  }),
  hasFeature: () => true,
  hasCapability: (capability) =>
    capability === "catalog.read"
    || capability === "pricing.sensitive.read"
});
const ready = await readyController.load() as Extract<
  CatalogPageState,
  { kind: "ready" }
>;
assert.equal(ready.kind, "ready");
assert.equal(ready.sensitive, true);
assert.match(controller.nextIdempotencyKey("catalog-activate"), /^catalog-activate:/u);
