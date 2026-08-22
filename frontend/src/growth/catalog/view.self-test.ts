import { strict as assert } from "node:assert";
import { renderCatalogPage } from "./view";
import type { CatalogPageState } from "./controller";

const ready: Extract<CatalogPageState, { kind: "ready" }> = {
  kind: "ready",
  items: [{
    id: "item-1",
    workspaceId: "ws-1",
    code: "PRODUCT-A",
    name: "标准产品",
    type: "product",
    status: "active",
    unit: "件",
    description: null,
    revision: 1,
    createdAt: "2026-08-09T08:00:00.000Z",
    updatedAt: "2026-08-09T08:00:00.000Z"
  }],
  packagesByItem: new Map([["item-1", [{
    id: "package-v1",
    workspaceId: "ws-1",
    packageCatalogItemId: "item-1",
    status: "active",
    revision: 2,
    version: 1,
    currency: "CNY",
    components: [{
      packageVersionId: "package-v1",
      componentCatalogItemId: "item-1",
      componentPricingPolicyVersionId: "policy-1",
      quantityMicros: 1_000_000
    }],
    validFrom: "2026-08-09T08:00:00.000Z",
    validTo: null,
    createdAt: "2026-08-09T08:00:00.000Z",
    updatedAt: "2026-08-09T08:00:00.000Z"
  }]]]),
  policies: [{
    id: "policy-1",
    status: "active",
    revision: 3,
    currency: "CNY",
    listUnitPriceMinor: 100_000,
    validFrom: "2026-08-09T08:00:00.000Z"
  }],
  sensitive: false,
  canManage: false
};

const salesHtml = renderCatalogPage(ready);
assert.equal(salesHtml.includes("标准产品"), true);
assert.equal(salesHtml.includes("list 100000"), false);
assert.equal(salesHtml.includes("data-action=\"activate-package\""), false);
assert.equal(salesHtml.includes("absoluteFloorUnitPriceMinor"), false);

const managerReady: CatalogPageState = {
  kind: "ready",
  items: ready.items,
  packagesByItem: ready.packagesByItem,
  policies: ready.policies,
  sensitive: true,
  canManage: true
};
const managerHtml = renderCatalogPage(managerReady);
assert.equal(managerHtml.includes("list 100000"), true);
assert.equal(managerHtml.includes("data-action=\"activate-package\""), true);

const maliciousItems = [{
  ...ready.items[0]!,
  name: "<script>alert(1)</script>"
}];
const malicious: CatalogPageState = {
  kind: "ready",
  items: maliciousItems,
  packagesByItem: ready.packagesByItem,
  policies: ready.policies,
  sensitive: false,
  canManage: false
};
const escaped = renderCatalogPage(malicious);
assert.equal(escaped.includes("<script>alert(1)</script>"), false);
assert.equal(escaped.includes("&lt;script&gt;"), true);

assert.equal(renderCatalogPage({ kind: "forbidden" }).includes("无权"), true);
assert.equal(renderCatalogPage({
  kind: "conflict",
  message: "revision_conflict"
}).includes("revision_conflict"), true);
