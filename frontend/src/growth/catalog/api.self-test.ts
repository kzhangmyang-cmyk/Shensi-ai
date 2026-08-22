import { strict as assert } from "node:assert";
import {
  createCatalogApi
} from "./api";
import type {
  GrowthHttpClient,
  GrowthHttpRequestOptions
} from "../http";

const calls: Array<{ path: string; options?: GrowthHttpRequestOptions }> = [];
const http: GrowthHttpClient = {
  async request(path, options) {
    calls.push({ path, options });
    return {
      body: { id: "package-v1", status: "active", revision: 2 },
      etag: '"2"',
      requestId: "req-1"
    } as never;
  }
};

const api = createCatalogApi(http);
await api.activatePackageVersion(
  "package-v1", '"1"', "catalog-activate:key-1"
);
assert.deepEqual(calls[0], {
  path: "/api/v1/catalog/package-versions/package-v1/activate",
  options: {
    method: "POST",
    ifMatch: '"1"',
    idempotencyKey: "catalog-activate:key-1"
  }
});

await api.listItems({ limit: 20, status: "active" });
assert.equal(
  calls[1]?.path,
  "/api/v1/catalog/items?limit=20&status=active"
);

await api.retirePricingPolicy("policy-1", '"3"', "catalog-retire:key-2");
assert.equal(
  calls[2]?.path,
  "/api/v1/catalog/pricing-policies/policy-1/retire"
);
assert.deepEqual(calls[2]?.options, {
  method: "POST",
  ifMatch: '"3"',
  idempotencyKey: "catalog-retire:key-2"
});
