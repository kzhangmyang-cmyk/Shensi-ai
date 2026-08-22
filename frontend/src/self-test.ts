import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import "./demo/demo-store.self-test";
import { renderDashboardView } from "./demo/demo-dashboard-view";
import { createDemoStore } from "./demo/demo-store";
import { buildLeadFinderIntentChips, getLeadFinderLayoutMode } from "./lead-finder-layout";
import "./acquisition/runtime-model.self-test";
import "./acquisition/runtime-api.self-test";
import "./acquisition/runtime-presenter.self-test";
import "./acquisition/runtime.self-test";
import "./acquisition/task-creation-api.self-test";
import "./acquisition/task-creation-controller.self-test";
import "./acquisition/task-creation-workflow.self-test";
import "./acquisition/plan-draft-workflow.self-test";
import "./acquisition/plan-draft-view.self-test";
import "./acquisition/detail-center-api.self-test";
import "./acquisition/detail-center-controller.self-test";
import "./acquisition/detail-center-entry.self-test";
import "./acquisition/detail-center-view.self-test";
import "./acquisition/visual-reader-api.self-test";
import "./acquisition/visual-reader-bridge.self-test";
import "./acquisition/visual-reader-controller.self-test";
import "./acquisition/performance-api.self-test";
import "./acquisition/performance-controller.self-test";
import "./acquisition/performance-view.self-test";
import "./private-domain/runtime-api.self-test";
import "./private-domain/controller.self-test";
import "./private-domain/view.self-test";
import "./connections/connection-api.self-test";
import "./connections/connection-controller.self-test";
import "./growth/router.self-test";
import "./growth/mode.self-test";
import "./growth/http.self-test";
import "./growth/bootstrap-api.self-test";
import "./growth/runtime.self-test";
import "./growth/demo/adapter.self-test";
import "./growth/catalog/api.self-test";
import "./growth/catalog/controller.self-test";
import "./growth/catalog/view.self-test";
import "./growth/quotes/api.self-test";
import "./growth/quotes/entry.self-test";
import "./growth/quotes/controller.self-test";
import "./growth/quotes/view.self-test";
import "./growth/finance/api.self-test";
import "./growth/finance/import-workflow.self-test";
import "./growth/finance/controller.self-test";
import "./growth/finance/view.self-test";
import "./growth/roi/api.self-test";
import "./growth/roi/controller.self-test";
import "./growth/roi/view.self-test";
import "./growth/advisor/api.self-test";
import "./growth/advisor/copilot-workflow.self-test";
import "./growth/advisor/controller.self-test";
import "./growth/advisor/view.self-test";
import "./growth/agents/view.self-test";
import "./growth/council/api.self-test";
import "./growth/council/controller.self-test";
import "./growth/council/view.self-test";
import "./growth/council/entry.self-test";
import "./connections/connection-view.self-test";

assert.equal(getLeadFinderLayoutMode(0), "entry");
assert.equal(getLeadFinderLayoutMode(1), "results");
assert.deepEqual(
  buildLeadFinderIntentChips({
    goal: "德国的 LED 工业照明经销商",
    productKeywords: "LED 工业照明",
    countries: "德国, 奥地利",
    industry: "工业照明",
    customerType: "经销商 / Distributor"
  }),
  ["德国", "奥地利", "LED 工业照明", "工业照明", "经销商"]
);
assert.deepEqual(
  buildLeadFinderIntentChips({
    goal: "寻找北欧工业照明合作伙伴",
    productKeywords: "",
    countries: "",
    industry: "",
    customerType: ""
  }),
  ["寻找北欧工业照明合作伙伴"]
);

const dashboardStore = createDemoStore({ storage: null, now: () => "2026-07-29T09:00:00.000Z" });
dashboardStore.transferConversationToPrivate("conversation-douyin-lin");
const dashboardMain = { innerHTML: "", querySelectorAll: () => [] } as unknown as HTMLElement;
const dashboardInspector = { innerHTML: "" } as HTMLElement;
renderDashboardView(dashboardStore.getState(), dashboardMain, dashboardInspector);
assert.equal(
  dashboardMain.innerHTML.match(/<b>林女士<\/b>/g)?.length,
  1,
  "a transferred conversation and its private customer must occupy one priority position"
);
assert.equal(dashboardInspector.innerHTML.includes("设置中心 → 重置演示数据"), true);
assert.equal(dashboardInspector.innerHTML.includes("清除本站点存储"), false);

const prototype = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const apiLayer = readFileSync(new URL("./prototype-api.ts", import.meta.url), "utf8");
const m1Layout = readFileSync(new URL("./m1-layout.css", import.meta.url), "utf8");
const replicaStyles = readFileSync(new URL("./replica-dashboard.css", import.meta.url), "utf8");
const replicaBehavior = readFileSync(new URL("./replica-dashboard.ts", import.meta.url), "utf8");
const demoApp = readFileSync(new URL("./demo/demo-app.ts", import.meta.url), "utf8");
const demoRouter = readFileSync(new URL("./demo/demo-router.ts", import.meta.url), "utf8");
const demoDashboardView = readFileSync(new URL("./demo/demo-dashboard-view.ts", import.meta.url), "utf8");
const demoCapabilitiesView = readFileSync(
  new URL("./demo/demo-capabilities-view.ts", import.meta.url),
  "utf8"
);
const acquisitionRuntime = readFileSync(
  new URL("./acquisition/runtime.ts", import.meta.url),
  "utf8"
);

for (const customerFacingSource of [
  prototype,
  replicaBehavior,
  demoRouter,
  demoCapabilitiesView,
  acquisitionRuntime
]) {
  assert.doesNotMatch(
    customerFacingSource,
    /脚本/u,
    "customer-facing automation terminology must use 工作流 instead of 脚本"
  );
}

const required = [
  "login-screen",
  "business-dashboard",
  "id=\"forecast\"",
  "data-priority-filter=\"all\"",
  "dashboardPriorityFilter",
  "todo-board",
  "report-deck",
  "id=\"knowledge\"",
  "id=\"exam\"",
  "id=\"tools\"",
  "id=\"settings\"",
  "prototype-api.ts",
  "/api/auth/login",
  "/api/dashboard/summary",
  "DASHBOARD_LIVE_REFRESH_MS",
  "refreshVisibleDashboard",
  "requestDashboardRefresh",
  "/api/knowledge/assets",
  "/api/exams",
  "/api/tools/ocr/jobs/ocr1/sync-lead",
  "/api/lead-finder/providers",
  "/api/lead-finder/search",
  "/api/lead-finder/source-config",
  "/conversion-preview",
  "转为客户",
  "createDeal",
  "pipelineAmount",
  "/api/leads?trash=true",
  "sourceEvents",
  "leadPermanentConfirmInput",
  "加入线索中心",
  "leadSourceCenterButton",
  "leadSourceChips",
  "openLeadSourceCenter",
  "ai_search",
  "data-view=\"commission\"",
  "id=\"commission\"",
  "commissionSyncDealsButton",
  "commissionRecalculateButton",
  "/api/commission/products",
  "/api/commission/sales-records",
  "/api/commission/calculations/recalculate",
  "renderCommission",
  "m1-layout.css",
  "id=\"allToolsMenu\"",
  "class=\"lead-taskbar\"",
  "lead-workbench-header",
  "lead-search-row",
  "lead-inline-summary",
  "lead-list-toolbar",
  "leadFinderTaskButton",
  "leadMoreConditionsButton",
  "id=\"leadFinderIntentChips\"",
  "data-layout-state=\"entry\"",
  "renderLeadFinderLayout",
  "buildLeadFinderIntentChips",
  "replica-shell",
  "id=\"replicaTaskModal\"",
  "id=\"replicaSearchInput\"",
  "id=\"replicaNewTaskButton\"",
  "id=\"replicaFlowTrack\"",
  "data-flow-task-id=\"ACQ-DOUYIN-01\"",
  "replica-dashboard.ts",
  "replica-dashboard.css",
  "data-replica-scope=\"all\"",
  "data-replica-scope=\"agent\"",
  "data-replica-tool=\"filter\"",
  "replicaCompleteTask",
  "GoodJob 自动营销系统",
  "data-replica-view=\"trade-marketing\"",
  "ACQ-DOUYIN-01",
  "ACQ-XHS-01",
  "ACQ-KUAISHOU-01",
  "ACQ-WECHAT-01",
  "ACQ-WEIBO-01",
  "id=\"replicaTaskMode\"",
  "同步私域",
  "id=\"demoModuleMain\"",
  "id=\"demoModuleInspector\"",
  "data-replica-module-panel=\"acquisition\"",
  "data-acquisition-mode=\"real\"",
  "data-acquisition-mode=\"demo\"",
  "id=\"replicaRealTaskGroup\"",
  "id=\"replicaRunMetrics\"",
  "id=\"replicaRealTaskModal\"",
  "id=\"replicaRealTaskForm\"",
  "id=\"replicaRealTaskModeAi\"",
  "id=\"replicaRealTaskModeManual\"",
  "id=\"replicaRealAiPrompt\"",
  "id=\"replicaRealAiGenerate\"",
  "id=\"replicaRealAiDraft\"",
  "id=\"replicaRealSearchConnection\"",
  "id=\"replicaRealModelConnection\"",
  "id=\"replicaRealConnectionsConfigure\"",
  "id=\"replicaConnectionCenter\"",
  "id=\"replicaConnectionCenterBody\"",
  "id=\"replicaAcquisitionDetailCenter\"",
  "id=\"replicaAcquisitionDetailCenterBody\"",
  "src/demo/demo-app.ts",
  "src/demo/demo.css",
  "renderDashboardView",
  "data-demo-action=\"open-module\"",
  "今日业务漏斗",
  "最近业务活动"
];

assert.equal(
  replicaBehavior.includes("startAcquisitionRuntime"),
  true,
  "missing real acquisition runtime bootstrap"
);
assert.equal(
  replicaBehavior.includes("startConnectionCenter"),
  true,
  "missing connection center bootstrap"
);
assert.equal(
  replicaBehavior.includes("startAcquisitionDetailCenter"),
  true,
  "missing acquisition detail center bootstrap"
);
assert.equal(
  demoRouter.includes("hashchange"),
  true,
  "hash navigation must update the visible module without a page reload"
);

const leadFinderMarkupRequired = [
  "class=\"lead-taskbar\"",
  "class=\"lead-workbench-header\"",
  "class=\"lead-search-row\"",
  "class=\"lead-inline-summary\"",
  "class=\"lead-list-toolbar\"",
  "id=\"leadFinderTaskButton\"",
  "id=\"leadMoreConditionsButton\"",
  "id=\"leadFinderIntentChips\"",
  "id=\"leadFinderAdvancedSettings\"",
  "id=\"leadFinderQueuePanel\"",
  "id=\"leadFinderAiBadge\"",
  "data-layout-state=\"entry\""
];

const uniqueLeadFinderIds = [
  "leadFinderTaskButton",
  "leadMoreConditionsButton",
  "leadFinderAdvancedSettings",
  "leadFinderQueuePanel",
  "leadFinderAiBadge"
];

for (const token of required) {
  if (
    !prototype.includes(token)
    && !apiLayer.includes(token)
    && !m1Layout.includes(token)
    && !replicaStyles.includes(token)
    && !replicaBehavior.includes(token)
    && !demoDashboardView.includes(token)
  ) throw new Error(`missing ${token}`);
}

for (const token of leadFinderMarkupRequired) {
  if (!prototype.includes(token)) throw new Error(`missing lead finder HTML markup ${token}`);
}

for (const id of uniqueLeadFinderIds) {
  const matches = prototype.match(new RegExp(`id=["']${id}["']`, "g")) || [];
  assert.equal(matches.length, 1, `expected exactly one #${id} in HTML`);
}

if (!prototype.includes(".report-hero") || !prototype.includes(".ocr-workbench") || !prototype.includes(".account-grid")) {
  throw new Error("missing high fidelity prototype styles");
}

assert.match(replicaBehavior, /function isAcquisitionActive\(\): boolean/,
  "missing acquisition active-panel guard");
assert.match(replicaBehavior, /#replicaNewTaskButton[\s\S]*if \(!isAcquisitionActive\(\)\) return;/,
  "missing acquisition guard for the legacy primary action");
assert.match(replicaBehavior, /taskForm\?\.addEventListener\("submit", \(event\) => \{[\s\S]*if \(!isAcquisitionActive\(\)\) \{\s*modal\?\.close\(\);\s*return;/,
  "missing acquisition guard for legacy task submission");
assert.ok(!demoApp.includes('shell.addEventListener("change"'),
  "demo app must not rerender on every native change event");

console.log(JSON.stringify({ ok: true, checked: required.length + leadFinderMarkupRequired.length + uniqueLeadFinderIds.length + 4 }, null, 2));
