import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import "./app-route.self-test";
import "./app-session.self-test";
import "./demo/demo-store.self-test";
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
import "./acquisition/douyin-automation-api.self-test";
import "./acquisition/douyin-automation-controller.self-test";
import "./acquisition/douyin-automation-view.self-test";
import "./acquisition/outreach-batch-api.self-test";
import "./acquisition/outreach-batch-controller.self-test";
import "./acquisition/outreach-batch-view.self-test";
import "./private-domain/runtime-api.self-test";
import "./private-domain/controller.self-test";
import "./private-domain/view.self-test";
import "./private-domain/deal-create-controller.self-test";
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
import "./growth/agents/real-api.self-test";
import "./growth/agents/real-controller.self-test";
import "./growth/agents/controller.self-test";
import "./growth/council/api.self-test";
import "./growth/council/controller.self-test";
import "./growth/council/view.self-test";
import "./growth/council/entry.self-test";
import "./connections/connection-view.self-test";
import "./growth/entry.self-test";

const prototype = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const replicaStyles = readFileSync(new URL("./replica-dashboard.css", import.meta.url), "utf8");
const replicaBehavior = readFileSync(new URL("./replica-dashboard.ts", import.meta.url), "utf8");
const demoApp = readFileSync(new URL("./demo/demo-app.ts", import.meta.url), "utf8");
const demoRouter = readFileSync(new URL("./demo/demo-router.ts", import.meta.url), "utf8");
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
  "src/app-shell.css",
  "src/app-entry.ts",
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
  "id=\"replicaUseMediaCrawler\"",
  "id=\"replicaConnectionCenter\"",
  "id=\"replicaConnectionCenterBody\"",
  "id=\"replicaAcquisitionDetailCenter\"",
  "id=\"replicaAcquisitionDetailCenterBody\"",
  "src/demo/demo-app.ts",
  "src/demo/demo.css"
];

assert.doesNotMatch(prototype, /class="shell"/u);
assert.doesNotMatch(prototype, /id="dashboard"/u);
assert.doesNotMatch(prototype, /prototype-api\.ts/u);
assert.match(prototype, /data-replica-view="agents"/u);
assert.match(prototype, /id="demoModuleMain"/u);
assert.match(prototype, /type="text" autocomplete="username" required maxlength="320"/u);

for (const growthLink of [
  "#growth/advisor",
  "#growth/catalog",
  "#growth/quotes",
  "#growth/finance",
  "#growth/roi",
  "#financial-council"
]) {
  assert.match(prototype, new RegExp(`href="${growthLink.replace("/", "\\/")}"`, "u"));
}

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

for (const token of required) {
  if (
    !prototype.includes(token)
    && !replicaStyles.includes(token)
    && !replicaBehavior.includes(token)
  ) throw new Error(`missing ${token}`);
}

assert.match(replicaBehavior, /function isAcquisitionActive\(\): boolean/,
  "missing acquisition active-panel guard");
assert.match(replicaBehavior, /#replicaNewTaskButton[\s\S]*if \(!isAcquisitionActive\(\)\) return;/,
  "missing acquisition guard for the legacy primary action");
assert.match(replicaBehavior, /taskForm\?\.addEventListener\("submit", \(event\) => \{[\s\S]*if \(!isAcquisitionActive\(\)\) \{\s*modal\?\.close\(\);\s*return;/,
  "missing acquisition guard for legacy task submission");
assert.ok(!demoApp.includes('shell.addEventListener("change"'),
  "demo app must not rerender on every native change event");

console.log(JSON.stringify({ ok: true, checked: required.length + 9 }, null, 2));
