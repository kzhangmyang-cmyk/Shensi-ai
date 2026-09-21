import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import manifest from "../../../contracts/pinned/growth-advisor-quote-roi.manifest.json";

test("real catalog binds lifecycle and first-item creation, preserves failed drafts, and ignores late results", async () => {
  const { document, window } = parseHTML('<html><body><main id="demoModuleMain"></main><aside id="inspector"></aside></body></html>');
  Object.assign(window, { location: { hash: "#not-growth" } });
  const globals = ["document", "window", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLFormElement", "Event", "CustomEvent", "FormData", "fetch"];
  const original = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class HtmlFormData {
    values = new Map<string, string>();
    constructor(form: HTMLFormElement) {
      for (const field of form.querySelectorAll<HTMLInputElement>("[name]")) {
        this.values.set(field.name, field.value ?? field.querySelector("option")?.getAttribute("value") ?? field.getAttribute("value") ?? "");
      }
    }
    get(name: string) { return this.values.get(name) ?? null; }
  }
  for (const key of globals.filter(key => key !== "fetch")) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true,
      value: key === "document" ? document : key === "window" ? window : key === "FormData" ? HtmlFormData : (window as any)[key] });
  }
  const stamp = "2026-09-10T00:00:00.000Z";
  let items: any[] = [{ id: "item-1", workspaceId: "workspace-1", code: "A", name: "测试产品", type: "product", status: "active", unit: "件", description: null, revision: 1, createdAt: stamp, updatedAt: stamp }];
  const pkg = { id: "package-1", workspaceId: "workspace-1", packageCatalogItemId: "item-1", status: "draft", revision: 1, version: 1, currency: "CNY", components: [], validFrom: stamp, validTo: null, createdAt: stamp, updatedAt: stamp };
  const policy = { id: "policy-1", workspaceId: "workspace-1", catalogItemId: "item-1", packageVersionId: null, status: "draft", revision: 1, version: 1, currency: "CNY", listUnitPriceMinor: 12500, standardDiscountLimitBps: 0, absoluteDiscountLimitBps: 0, standardPaymentTermDays: 0, absolutePaymentTermDays: 0, surchargePolicies: [], validFrom: stamp, validTo: null, source: "native", amountVisibility: "redacted", createdAt: stamp, createdBy: "actor-1" };
  const writes: { path: string; headers: Headers; body: any }[] = [];
  let creationFails = false;
  let pricingResponseLost = true;
  const pricingCommitted = new Map<string, any>();
  let delayed: (() => Response) | null = null;
  let resolveLate: ((response: Response) => void) | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "GET") {
      if (url.startsWith("/api/customers")) return Response.json({ customers: [] });
      if (url === "/api/todos") return Response.json({ todos: [] });
      if (url.startsWith("/api/v1/catalog/items?")) return Response.json({ items, nextCursor: null });
      if (url.startsWith("/api/v1/catalog/packages/")) return Response.json({ items: [pkg], nextCursor: null });
      if (url.startsWith("/api/v1/catalog/pricing-policies?")) return Response.json({ items: items.length ? [policy, ...pricingCommitted.values()] : [], nextCursor: null });
      throw new Error(`Unexpected read: ${url}`);
    }
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    writes.push({ path: url, headers, body });
    assert.ok(headers.get("Idempotency-Key"));
    assert.equal(headers.get("X-Workspace-Id"), "workspace-1");
    if (url.includes("/package-versions/")) {
      assert.equal(headers.get("If-Match"), `"package-version:package-1:${pkg.revision}"`);
      pkg.status = url.endsWith("/activate") ? "active" : "retired"; pkg.revision++;
      return Response.json(pkg);
    }
    if (url.endsWith("/policy-1/activate")) {
      assert.equal(headers.get("If-Match"), '"pricing-policy:policy-1:1"');
      policy.status = "active"; policy.revision++;
      return Response.json(policy);
    }
    if (url === "/api/v1/catalog/pricing-policies") {
      const key = headers.get("Idempotency-Key")!;
      if (!pricingCommitted.has(key)) pricingCommitted.set(key, { ...policy, ...body, id: "policy-2", revision: 1, status: "draft" });
      if (pricingResponseLost) { pricingResponseLost = false; throw new TypeError("Failed to fetch"); }
      return Response.json(pricingCommitted.get(key), { status: 201 });
    }
    if (url.endsWith("/policy-2/activate")) {
      assert.equal(headers.get("If-Match"), '"pricing-policy:policy-2:1"');
      const created = [...pricingCommitted.values()][0]; created.status = "active"; created.revision++;
      return Response.json(created);
    }
    assert.equal(url, "/api/v1/catalog/items");
    if (creationFails) return Response.json({ code: "catalog_code_conflict" }, { status: 409 });
    const result = () => { items = [{ ...items[0], ...body, id: "created-1", status: "active", revision: 1 }]; return Response.json(items[0], { status: 201 }); };
    if (delayed) return new Promise<Response>(resolve => { resolveLate = resolve; delayed = result; });
    return result();
  };
  const runtime = await import("../runtime");
  const registry = new runtime.GrowthPageRegistry();
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  const click = (selector: string) => {
    const button = document.querySelector<HTMLElement>(selector);
    assert.ok(button, `Missing ${selector}`);
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
  };
  try {
    const mode = await runtime.startGrowthRuntime({ registry, bootstrapLoader: { async load() {
      return { status: "ready", workspaceId: "workspace-1", contractVersion: manifest.contractVersion, contractHash: manifest.contractHash,
        features: ["catalog"], capabilities: ["catalog.read", "catalog.manage", "pricing.sensitive.read"] };
    } } });
    const context = () => { const abort = new AbortController(); return { route: { name: "catalog" as const }, mode, signal: abort.signal, abort: () => abort.abort() }; };
    const catalog = registry.get("catalog")!;
    await catalog.mount(context() as any);
    click('[data-action="activate-package"]'); await flush();
    assert.equal(writes.length, 1, "visible activation must execute a real command");
    assert.equal(pkg.status, "active");
    assert.equal(document.querySelector('[data-action="activate-package"]')?.hasAttribute("disabled"), true);
    click('[data-action="retire-package"]'); await flush();
    assert.equal(pkg.status, "retired");
    click('[data-action="activate-policy"]'); await flush();
    assert.equal(policy.status, "active");
    await catalog.unmount?.(); items = [];
    await catalog.mount(context() as any);
    click('[data-action="create-item"]');
    const fill = (name: string, value: string) => { (document.querySelector(`[name="${name}"]`) as HTMLInputElement).value = value; };
    fill("code", "NEW"); fill("name", "新产品"); fill("unit", "件");
    const submit = () => document.querySelector("[data-catalog-form]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    creationFails = true; submit(); await flush();
    assert.match(document.querySelector("[data-catalog-feedback]")!.textContent!, /冲突|已存在/u);
    assert.equal((document.querySelector('[name="name"]') as HTMLInputElement).value, "新产品");
    creationFails = false; submit(); submit(); await flush();
    assert.equal(writes.filter(write => write.path === "/api/v1/catalog/items").length, 2, "one failed and one successful attempt, no duplicate pending submit");
    assert.match(document.querySelector(".catalog-items")!.textContent!, /新产品/u);
    click('[data-action="create-policy"]');
    fill("price", "123.45"); fill("cost", "67.89"); fill("floor", "90.12");
    submit(); await flush();
    submit(); await flush();
    assert.equal(pricingCommitted.size, 1, "retry after committed-but-lost response must not create another policy");
    const policyAttempts = writes.filter(write => write.path === "/api/v1/catalog/pricing-policies");
    assert.equal(policyAttempts[0].headers.get("Idempotency-Key"), policyAttempts[1].headers.get("Idempotency-Key"));
    assert.deepEqual(policyAttempts[0].body, policyAttempts[1].body, "validFrom is frozen across the retry");
    const pricingWrite = writes.find(write => write.path === "/api/v1/catalog/pricing-policies");
    assert.ok(pricingWrite, "a created product can receive a real draft pricing policy");
    assert.equal(pricingWrite.body.catalogItemId, "created-1");
    assert.equal(pricingWrite.body.listUnitPriceMinor, 12345);
    assert.equal(pricingWrite.body.unitStandardCostMinor, 6789);
    assert.equal(pricingWrite.body.absoluteFloorUnitPriceMinor, 9012);
    assert.equal(pricingWrite.body.targetGrossMarginBps, 2000);
    assert.equal(pricingWrite.body.packageVersionId, null);
    assert.equal(writes.filter(write => write.path.endsWith("/activate")).length, 2, "creating a policy must not activate it automatically");
    click('[data-action="activate-policy"][data-id="policy-2"]'); await flush();
    assert.equal([...pricingCommitted.values()][0].status, "active");
    click('[data-action="create-item"]'); fill("code", "LATE"); fill("name", "旧页晚到"); fill("unit", "件");
    delayed = () => Response.json({}); submit(); await flush();
    await catalog.unmount?.();
    document.querySelector("#demoModuleMain")!.innerHTML = "新页面";
    resolveLate!(delayed!()); await flush();
    assert.equal(document.querySelector("#demoModuleMain")!.textContent, "新页面");
  } finally {
    await runtime.resetGrowthRuntime();
    for (const key of globals) { const value = original.get(key); if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
