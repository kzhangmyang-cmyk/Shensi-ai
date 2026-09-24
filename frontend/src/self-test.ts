import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCfoRealtimeSessionTests } from './growth/agents/cfo-realtime-session.self-test';
import { runCfoConversationTests } from './growth/agents/cfo-conversation.self-test';
import './growth/agents/chat-attachments.self-test';
import './growth/agents/cfo-attachments.self-test';
import { runEnterpriseAnalysisTests } from './growth/finance/enterprise-analysis.self-test';
import './growth/agents/cfo-conversation-layout.self-test';
import './growth/agents/cfo-acquisition-progress.self-test';
import './growth/agents/cfo-acquisition-workflow-api.self-test';
import { runCfoVoiceSettingsTests } from './growth/agents/cfo-voice-settings.self-test';
import { runCfoRealtimeAudioTests } from './growth/agents/cfo-realtime-audio.self-test';
import { runCfoRealtimeClientTests } from './growth/agents/cfo-realtime-client.self-test';
await runCfoRealtimeClientTests();
await runCfoRealtimeAudioTests();
await runCfoVoiceSettingsTests();
await runCfoRealtimeSessionTests();
await runCfoConversationTests();
await runEnterpriseAnalysisTests();
// Static imports with top-level await overlap. These suites intentionally
// install a process-wide desktop runtime, so give each its own process instead
// of letting their fixture redirect concurrent Web controller tests to IPC.
for (const suite of [
  "./desktop/desktop-runtime.self-test.ts",
  "./acquisition/acquisition-browser-runtime.self-test.ts"
]) {
  execFileSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL(suite, import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit"
  });
}
import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import "./app-route.self-test";
import "./app-session.self-test";
import "./desktop/desktop-bridge.self-test";
import "./desktop/startup-splash.self-test";
import "./demo/demo-store.self-test";
import "./demo/demo-dashboard-view.self-test";
import "./demo/demo-router.self-test";
import "./dashboard/real-api.self-test";
import "./dashboard/real-view.self-test";
import "./dashboard/real-controller.self-test";
import "./dashboard/real-entry.self-test";
import "./replica-flow-selection.self-test";
import "./conversations/real-api.self-test";
import "./conversations/real-view.self-test";
import "./conversations/real-controller.self-test";
import "./conversations/real-entry.self-test";
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
import "./acquisition/detail-center-candidate-focus.self-test";
import "./acquisition/detail-center-entry.self-test";
import "./acquisition/detail-center-view.self-test";
import "./acquisition/visual-reader-api.self-test";
import "./acquisition/visual-reader-bridge.self-test";
import "./acquisition/visual-reader-controller.self-test";
import "./acquisition/performance-api.self-test";
import "./acquisition/performance-controller.self-test";
import "./acquisition/performance-view.self-test";
import "./acquisition/douyin-automation-api.self-test";
import "./acquisition/douyin-live-login.self-test";
import "./acquisition/douyin-live-login-entry.self-test";
import "./desktop/dev-api-proxy.self-test";
import "./acquisition/douyin-automation-controller.self-test";
import "./acquisition/douyin-plan-name.self-test";
import "./acquisition/douyin-automation-view.self-test";
import "./acquisition/outreach-batch-api.self-test";
import "./acquisition/outreach-batch-controller.self-test";
import "./acquisition/outreach-batch-selection.self-test";
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
import "./growth/finance/document-selection.self-test";
import "./growth/finance/import-workflow.self-test";
import "./growth/finance/controller.self-test";
import "./growth/finance/view.self-test";
import "./growth/roi/api.self-test";
import "./growth/roi/controller.self-test";
import "./growth/roi/view.self-test";
import "./growth/roi/tabs.self-test";
import "./growth/roi/runtime-binding.self-test";
import "./growth/roi/rendering-regression.self-test";
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
import "./growth/council/report.self-test";
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
assert.match(replicaStyles,
  /\.real-conversations-outreach-cta button\s*\{[^}]*color:\s*var\(--replica-on-accent\)/su);
assert.match(replicaStyles,
  /\.real-conversations-outreach-cta button:disabled\s*\{[^}]*background:\s*var\(--replica-control-disabled\)/su);

const prototypeDocument = parseHTML(prototype).document;
const acquisitionSections = Array.from(
  prototypeDocument.querySelectorAll<HTMLElement>(
    '[data-replica-module-panel="acquisition"] > section'
  )
);
const platformSelectorPosition = acquisitionSections.findIndex((section) =>
  section.querySelector("#replicaFlowStage") !== null
);
const automationWorkspacePosition = acquisitionSections.findIndex((section) =>
  section.id === "douyinAutomationWorkspace"
);
const performancePosition = acquisitionSections.findIndex((section) =>
  section.id === "replicaAcquisitionPerformance"
);
const platformSelector = prototypeDocument.querySelector<HTMLElement>("#replicaFlowStage");
const platformSelectorTitle = prototypeDocument.querySelector<HTMLElement>("#replicaFlowTitle");
assert.ok(platformSelectorPosition >= 0, "platform selector must remain in the acquisition page");
assert.ok(automationWorkspacePosition >= 0, "Douyin automation workspace must remain in the acquisition page");
assert.ok(performancePosition >= 0, "acquisition performance must remain in the acquisition page");
assert.ok(
  platformSelectorPosition < automationWorkspacePosition,
  "platform selection cards must appear before the selected platform workspace"
);
assert.ok(
  platformSelectorPosition < performancePosition,
  "platform selection cards must appear before platform-specific performance details"
);
assert.equal(platformSelectorTitle?.textContent?.trim(), "选择获客平台");
assert.equal(platformSelector?.getAttribute("aria-labelledby"), "replicaFlowTitle");
assert.match(
  replicaStyles,
  /@media \(min-width: 901px\) and \(max-width: 1399px\)/,
  "mid-sized desktop layout must free the platform carousel from the inspector column"
);
assert.match(
  replicaStyles,
  /\.replica-shell\[data-acquisition-mode="real"\] \.replica-board\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
  "real acquisition mode must give the platform selector a full-width decision row"
);
assert.match(
  replicaStyles,
  /\/\* Desktop application shell:[\s\S]*body\.is-authenticated[\s\S]*height:\s*100dvh;[\s\S]*overflow:\s*hidden;/u,
  "desktop shell must keep viewport scrolling out of the body"
);
assert.match(
  replicaStyles,
  /\/\* Desktop application shell:[\s\S]*\.replica-main,[\s\S]*\.replica-demo-main\s*\{[\s\S]*min-height:\s*0;[\s\S]*overflow-y:\s*auto;/u,
  "desktop content surfaces must own their vertical scrolling"
);
assert.ok(
  replicaStyles.lastIndexOf("/* Desktop application shell:")
    > replicaStyles.lastIndexOf("@media (max-width: 1599px)"),
  "desktop shell overrides must follow legacy fixed-height desktop rules"
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
  "Shensi · 多智能体增长与经营系统",
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

assert.doesNotMatch(
  prototype,
  /data-acquisition-mode="demo"/u,
  "desktop acquisition must not expose the retired demo-mode switch"
);

assert.doesNotMatch(prototype, /class="shell"/u);
assert.doesNotMatch(prototype, /id="dashboard"/u);
assert.doesNotMatch(prototype, /prototype-api\.ts/u);
assert.match(prototype, /data-replica-view="agents"/u);
assert.match(prototype, /id="demoModuleMain"/u);
const loginIdentityInput = prototypeDocument.querySelector<HTMLInputElement>("#loginEmail");
assert.ok(loginIdentityInput, "login must expose the account input");
assert.equal(loginIdentityInput.getAttribute("type"), "text");
assert.equal(loginIdentityInput.getAttribute("autocomplete"), "username");
assert.equal(loginIdentityInput.hasAttribute("required"), true);
assert.equal(loginIdentityInput.getAttribute("maxlength"), "320");

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
