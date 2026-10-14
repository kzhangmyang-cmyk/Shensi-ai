import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
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
assert.equal(salesHtml.includes("growth-command-strip"), true);
assert.equal(salesHtml.includes("catalog-workbench-grid"), true);
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
assert.match(managerHtml, /标价.*1,000\.00/u);
assert.equal(managerHtml.includes("data-action=\"activate-package\""), true);
assert.ok(managerHtml.includes("&quot;package-version:package-v1:2&quot;"),
  "lifecycle actions use the server's resource-bound revision ETag");
assert.ok(managerHtml.includes("&quot;pricing-policy:policy-1:3&quot;"));
assert.ok(renderCatalogPage({ kind: "empty", reason: "catalog_empty", canManage: true } as CatalogPageState)
  .includes('data-action="create-item"'), "a manager can create the first item in a new workspace");
for (const [status, activateDisabled, retireDisabled] of [
  ["draft", false, true], ["active", true, false], ["retired", true, true]
] as const) {
  const pkg = ready.packagesByItem.get("item-1")![0]!;
  const { document } = parseHTML(renderCatalogPage({ ...managerReady,
    packagesByItem: new Map([["item-1", [{ ...pkg, status }]]]),
    policies: [{ ...ready.policies[0]!, status }]
  }));
  assert.equal(document.querySelector('[data-action="activate-package"]')!.hasAttribute("disabled"), activateDisabled);
  assert.equal(document.querySelector('[data-action="retire-package"]')!.hasAttribute("disabled"), retireDisabled);
  assert.equal(document.querySelector('[data-action="activate-policy"]')!.hasAttribute("disabled"), activateDisabled);
}

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
