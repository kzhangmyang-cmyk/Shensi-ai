import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clearGrowthDemoRouteClasses,
  growthRouteMeta,
  growthToolbarMeta,
  resetGrowthSurfaceScroll
} from "./entry";

assert.deepEqual(growthRouteMeta({ name: "advisor" }), {
  title: "增长顾问",
  subtitle: "今日经营建议与待办优先级"
});
assert.deepEqual(growthRouteMeta({ name: "catalog" }), {
  title: "客户目录",
  subtitle: "统一查看客户、线索与经营资料"
});
assert.deepEqual(growthRouteMeta({ name: "quote" }), {
  title: "报价工作台",
  subtitle: "基于客户需求生成、审批与追踪报价"
});
assert.deepEqual(growthRouteMeta({ name: "finance" }), {
  title: "财务经营",
  subtitle: "查看经营数据、归因与财务进度"
});
assert.deepEqual(growthRouteMeta({ name: "roi" }), {
  title: "ROI 经营分析",
  subtitle: "评估投入产出与增长效率"
});
assert.deepEqual(growthRouteMeta({ name: "financial-council" }), {
  title: "财务委员会",
  subtitle: "真实三表 · 六角色审计 · 人工审批"
});
assert.deepEqual(growthToolbarMeta({ name: "advisor" }), {
  showToolbar: true,
  searchPlaceholder: "搜索客户、商机或任务...",
  primaryAction: "查看今日待办"
});
assert.deepEqual(growthToolbarMeta({ name: "financial-council" }), {
  showToolbar: true,
  searchPlaceholder: "搜索客户、商机或任务...",
  primaryAction: "查看今日待办"
});
assert.deepEqual(growthToolbarMeta({ name: "finance" }), {
  showToolbar: false,
  searchPlaceholder: "",
  primaryAction: ""
});
const shellA = { scrollTop: 540 } as HTMLElement;
const shellB = { scrollTop: 180 } as HTMLElement;
const host = { scrollTop: 96 } as HTMLElement;
resetGrowthSurfaceScroll([shellA, shellB], host);
assert.deepEqual(
  [shellA.scrollTop, shellB.scrollTop, host.scrollTop],
  [0, 0, 0],
  "growth route changes must open each module at its top"
);
const inheritedDemoRouteClasses = new Set([
  "is-dashboard-route",
  "is-agents-route",
  "is-acquisition-route",
  "is-conversations-route",
  "is-private-domain-route",
  "is-settings-route",
  "is-single-pane-module"
]);
const shellWithInheritedDemoRoute = {
  classList: {
    remove: (...classes: string[]) => classes.forEach((name) => inheritedDemoRouteClasses.delete(name))
  }
} as unknown as HTMLElement;
clearGrowthDemoRouteClasses(shellWithInheritedDemoRoute);
assert.deepEqual(
  [...inheritedDemoRouteClasses],
  ["is-single-pane-module"],
  "Growth routes must clear every conflicting demo route hook, including settings, while retaining the shared single-pane shell mode"
);
const entrySource = readFileSync(fileURLToPath(new URL("./entry.ts", import.meta.url)), "utf8");
assert.doesNotMatch(
  entrySource,
  /route\.name === "quote" && !route\.quoteCaseId/u,
  "quote selection belongs to the real quote runtime, not an entry-layer placeholder"
);
assert.match(
  entrySource,
  /querySelectorAll<HTMLElement>\("\[data-replica-view\]"\)/u,
  "growth routes must clear the unrelated top-level navigation selection"
);
assert.match(
  entrySource,
  /classList\.toggle\("is-growth-route"/u,
  "growth routes must expand into the unused inspector column"
);
assert.match(
  entrySource,
  /if \(route\) clearGrowthDemoRouteClasses\(shell\)/u,
  "Growth routes must clear the demo router's mutually exclusive layout hooks"
);
assert.match(
  entrySource,
  /function currentGrowthShells\(\): HTMLElement\[\]/u,
  "growth routes must re-query the current shell nodes when synchronizing"
);
assert.match(
  entrySource,
  /const shells = currentGrowthShells\(\)/u,
  "growth routes must apply route classes to the current shell nodes"
);
assert.doesNotMatch(
  entrySource,
  /const shells = document\.querySelectorAll<HTMLElement>\("\.replica-shell"\)/u,
  "growth routes must not cache a stale shell node list at startup"
);
assert.doesNotMatch(
  entrySource,
  /searchRegion\.hidden = Boolean\(route\)/u,
  "growth routes must not hide the shared top search for every route"
);
assert.doesNotMatch(
  entrySource,
  /primaryAction\.hidden = Boolean\(route\)/u,
  "growth routes must not hide the shared today-task button for every route"
);
assert.match(
  entrySource,
  /growthToolbarMeta\(route\)/u,
  "growth routes must control toolbar visibility through a route-aware helper"
);
assert.match(
  entrySource,
  /searchRegion\.style\.display = toolbar\.showToolbar \? "" : "none"/u,
  "finance route must be able to suppress the shared toolbar with author-level display control"
);
assert.match(
  entrySource,
  /searchRegion\.style\.display = ""/u,
  "leaving growth must restore the shared search visibility"
);
assert.match(
  entrySource,
  /primaryAction\.style\.display = toolbar\.showToolbar \? "" : "none"/u,
  "finance route must be able to suppress the shared CTA with author-level display control"
);
assert.match(
  entrySource,
  /primaryAction\.style\.display = ""/u,
  "leaving growth must restore the shared CTA visibility"
);
assert.match(
  entrySource,
  /primaryActionLabel\.textContent = toolbar\.primaryAction/u,
  "growth routes must write the shared toolbar CTA label explicitly"
);
