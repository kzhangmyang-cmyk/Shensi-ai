import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createRoiRuntimeBinding } from "./runtime-binding";
import { createRoiController } from "./controller";
import type { AcquisitionCohort, GrowthPerformanceApi, GrowthPerformanceResponse, RoiQueryFilters } from "./api";
import type { GrowthHttpResponse } from "../http";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const response = <T>(body: T): GrowthHttpResponse<T> => ({ status: 200, etag: null, body });
const cohort = (id: string): AcquisitionCohort => ({
  id, workspaceId: "workspace-test", status: "active", platform: "douyin",
  cohortFrom: "2026-09-01T00:00:00.000Z", cohortTo: "2026-09-10T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z", definitionVersion: "v1", firstTouchRuleVersion: "v1"
});
function performance(filters: RoiQueryFilters): GrowthPerformanceResponse {
  return {
    query: { ...filters, planId: null, closureVersionId: null, sliceKey: "all" },
    expectedRoiByCurrency: [], actualRoiByCurrency: [], cashByCurrency: [],
    coverage: { costCoverageBps: 0, marginCoverageBps: 0, cashCoverageBps: 0, attributionCoverageBps: 0 },
    dataGaps: [], dataAsOf: filters.asOf
  };
}
function fixture(holdLists = false) {
  const { document, window } = parseHTML('<html><body><main id="host"></main></body></html>');
  // LinkeDOM omits the browser's select setter; no product behavior is stubbed.
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get(this: HTMLSelectElement) { return this.querySelector<HTMLOptionElement>("option[selected]")?.value ?? this.querySelector<HTMLOptionElement>("option")?.value ?? ""; },
    set(this: HTMLSelectElement, value: string) { for (const option of this.querySelectorAll("option")) {
      if (option.value === value) option.setAttribute("selected", "");
      else option.removeAttribute("selected");
    } }
  });
  const host = document.querySelector<HTMLElement>("#host")!;
  const queries: Array<ReturnType<typeof deferred<GrowthHttpResponse<GrowthPerformanceResponse>>> & { filters: RoiQueryFilters; signal?: AbortSignal }> = [];
  const lists: Array<ReturnType<typeof deferred<GrowthHttpResponse<{ items: readonly AcquisitionCohort[] }>>> & { signal?: AbortSignal }> = [];
  const api: GrowthPerformanceApi = {
    listCohorts({ signal }) {
      const request = { ...deferred<GrowthHttpResponse<{ items: readonly AcquisitionCohort[] }>>(), signal };
      lists.push(request);
      if (!holdLists) request.resolve(response({ items: [cohort(`cohort-${lists.length}`)] }));
      return request.promise;
    },
    getGrowthPerformance(filters, signal) {
      const request = { ...deferred<GrowthHttpResponse<GrowthPerformanceResponse>>(), filters, signal };
      queries.push(request);
      return request.promise; // Intentionally ignore abort so late-response protection is exercised.
    }
  };
  const binding = createRoiRuntimeBinding({
    getHost: () => host,
    createController: () => createRoiController({ api, hasFeature: () => true, hasCapability: () => true })
  });
  const mount = () => { const abort = new AbortController(); return { abort, done: binding.mount({ signal: abort.signal }) }; };
  const submit = (currency = "CNY") => {
    const form = host.querySelector<HTMLFormElement>("[data-roi-filters]");
    assert.ok(form);
    form.querySelector<HTMLSelectElement>("[data-roi-currency]")!.value = currency;
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  };
  return { binding, host, mount, queries, lists, submit };
}

for (const outcome of ["success", "failure"] as const) {
  test(`ROI remount keeps the new page after old query ${outcome}`, async () => {
    const f = fixture();
    await f.mount().done;
    f.submit();
    f.binding.unmount();
    assert.equal(f.queries[0].signal?.aborted, true);
    await f.mount().done;
    const before = f.host.innerHTML;
    if (outcome === "success") f.queries[0].resolve(response(performance(f.queries[0].filters)));
    else f.queries[0].reject(new Error("old-query-failed"));
    await flush();
    assert.equal(f.host.innerHTML, before);
    assert.equal(f.host.querySelector<HTMLSelectElement>("[data-roi-cohort]")?.value, "cohort-2");
    f.binding.destroy();
  });
}

for (const outcome of ["success", "failure"] as const) {
  test(`ROI latest query wins when the older request ends with ${outcome}`, async () => {
    const f = fixture();
    await f.mount().done;
    f.submit();
    f.submit();
    assert.equal(f.queries.length, 1, "duplicate pending query is not submitted twice");
    f.submit("USD");
    assert.equal(f.queries[0].signal?.aborted, true);
    assert.equal(f.queries.length, 2);
    f.queries[1].resolve(response(performance(f.queries[1].filters)));
    await flush();
    const newest = f.host.innerHTML;
    if (outcome === "success") f.queries[0].resolve(response(performance(f.queries[0].filters)));
    else f.queries[0].reject(new Error("old-query-failed"));
    await flush();
    assert.equal(f.host.innerHTML, newest);
    assert.equal(f.host.querySelector<HTMLSelectElement>("[data-roi-currency]")?.value, "USD");
    f.binding.destroy();
  });
}

test("ROI query error retains filters and supports retry", async () => {
  const f = fixture();
  await f.mount().done;
  f.submit("EUR");
  f.queries[0].reject(new Error("查询暂时失败"));
  await flush();
  assert.match(f.host.textContent ?? "", /查询暂时失败/u);
  assert.equal(f.host.querySelector<HTMLSelectElement>("[data-roi-currency]")?.value, "EUR");
  f.submit("EUR");
  assert.equal(f.queries.length, 2);
  f.queries[1].resolve(response(performance(f.queries[1].filters)));
  await flush();
  assert.equal(f.host.querySelector('[role="alert"]'), null);
  f.binding.destroy();
});

test("ROI delayed cohort load cannot contaminate a later mount", async () => {
  const f = fixture(true);
  const old = f.mount();
  const fresh = f.mount();
  assert.equal(f.lists[0].signal?.aborted, true);
  f.lists[1].resolve(response({ items: [cohort("new-cohort")] }));
  await fresh.done;
  const before = f.host.innerHTML;
  f.lists[0].resolve(response({ items: [cohort("old-cohort")] }));
  await old.done;
  assert.equal(f.host.innerHTML, before);
  f.submit();
  f.queries[0].resolve(response(performance(f.queries[0].filters)));
  await flush();
  assert.equal(f.host.querySelector<HTMLSelectElement>("[data-roi-cohort]")?.value, "new-cohort");
  f.binding.destroy();
});

test("ROI route cancellation stops requests and detaches events before unmount", async () => {
  const f = fixture();
  const page = f.mount();
  await page.done;
  f.submit();
  page.abort.abort();
  assert.equal(f.queries[0].signal?.aborted, true);
  const before = f.host.innerHTML;
  f.queries[0].reject(new Error("late-after-route-abort"));
  await flush();
  f.submit("USD");
  assert.equal(f.queries.length, 1);
  assert.equal(f.host.querySelector('[role="alert"]'), null);
  // The test's simulated user changed only the select; no response rendered.
  assert.equal(f.host.textContent, parseHTML(before).document.documentElement.textContent);
  f.binding.destroy();
});

test("ROI destroy makes late responses and future mounts inert", async () => {
  const f = fixture();
  await f.mount().done;
  f.submit();
  f.binding.destroy();
  f.host.innerHTML = "<p>下一模块</p>";
  f.queries[0].resolve(response(performance(f.queries[0].filters)));
  await flush();
  await f.mount().done;
  assert.equal(f.host.innerHTML, "<p>下一模块</p>");
  assert.equal(f.queries[0].signal?.aborted, true);
  assert.equal(f.lists.length, 1);
});
