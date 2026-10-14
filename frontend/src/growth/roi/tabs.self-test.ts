import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { renderRoiPage } from "./view";
import { activateRoiTab, moveRoiTabWithKey } from "./tabs";

const { document } = parseHTML("<html><body><main id=\"host\"></main></body></html>");
const host = document.querySelector<HTMLElement>("#host");
assert.ok(host);
host.innerHTML = renderRoiPage({
  kind: "ready",
  cohorts: [],
  filters: null,
  performance: null
});

const tabs = [...host.querySelectorAll<HTMLButtonElement>("[data-roi-tab]")];
const panels = [...host.querySelectorAll<HTMLElement>("[data-roi-panel]")];
assert.equal(tabs.length, 3);
assert.equal(panels.length, 3);

for (const tab of tabs) {
  const panelId = tab.getAttribute("aria-controls");
  assert.ok(panelId, "each ROI tab must name its panel");
  const panel: HTMLElement | null = host.querySelector<HTMLElement>(`#${panelId}`);
  assert.ok(panel, "each ROI tab must control a rendered panel");
  assert.equal(tab.getAttribute("role"), "tab");
  assert.equal(panel.getAttribute("role"), "tabpanel");
  assert.equal(panel.getAttribute("aria-labelledby"), tab.id);
}

assert.equal(tabs[0]?.getAttribute("aria-selected"), "true");
assert.equal(tabs[0]?.getAttribute("tabindex"), "0");
assert.equal(tabs[1]?.getAttribute("aria-selected"), "false");
assert.equal(tabs[1]?.getAttribute("tabindex"), "-1");
assert.equal(panels[0]?.hidden, false);
assert.equal(panels[1]?.hidden, true);

const focusCalls: string[] = [];
tabs.forEach((tab) => {
  tab.focus = () => { focusCalls.push(tab.dataset.roiTab ?? ""); };
});

assert.equal(moveRoiTabWithKey(host, tabs[0]!, "ArrowRight"), true);
assert.equal(tabs[1]?.getAttribute("aria-selected"), "true");
assert.equal(tabs[1]?.getAttribute("tabindex"), "0");
assert.equal(panels[1]?.hidden, false);
assert.equal(panels[0]?.hidden, true);
assert.deepEqual(focusCalls, ["actual"]);

assert.equal(moveRoiTabWithKey(host, tabs[1]!, "ArrowLeft"), true);
assert.equal(tabs[0]?.getAttribute("aria-selected"), "true");
assert.deepEqual(focusCalls, ["actual", "expected"]);

assert.equal(moveRoiTabWithKey(host, tabs[0]!, "ArrowLeft"), true);
assert.equal(tabs[2]?.getAttribute("aria-selected"), "true");
assert.deepEqual(focusCalls, ["actual", "expected", "cash"]);
assert.equal(moveRoiTabWithKey(host, tabs[2]!, "ArrowRight"), true);
assert.equal(tabs[0]?.getAttribute("aria-selected"), "true");
assert.deepEqual(focusCalls, ["actual", "expected", "cash", "expected"]);

assert.equal(moveRoiTabWithKey(host, tabs[0]!, "End"), true);
assert.equal(tabs[2]?.getAttribute("aria-selected"), "true");
assert.equal(moveRoiTabWithKey(host, tabs[2]!, "Home"), true);
assert.equal(tabs[0]?.getAttribute("aria-selected"), "true");
assert.equal(moveRoiTabWithKey(host, tabs[2]!, "Enter"), false);

assert.equal(activateRoiTab(host, "actual"), true);
assert.equal(tabs[1]?.getAttribute("aria-selected"), "true");
assert.equal(activateRoiTab(host, "unknown"), false);
