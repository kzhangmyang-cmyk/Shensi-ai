import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { createAgentsController } from "./controller";
import type { GrowthHttpClient } from "../http";
import type { RealAgentCenterController, RealAgentCenterControllerState } from "./real-controller";

const parsed = parseHTML("<div id=host></div>");
Object.defineProperty(parsed.window, "location", {
  configurable: true,
  value: { hash: "#growth/agents" }
});
Object.defineProperty(parsed.window, "scrollTo", {
  configurable: true,
  value() {}
});

let requests = 0;
const http: GrowthHttpClient = {
  async request() {
    requests += 1;
    throw new Error("real agents controller must not use sample data");
  }
};
const host = parsed.document.querySelector<HTMLElement>("#host")!;
const controller = createAgentsController({
  host,
  http,
  demo: false,
  window: parsed.window as unknown as Window
});
const event = parsed.document.createEvent("Event");
event.initEvent("click", true, true);
host.querySelector<HTMLElement>('[data-agents-action="sample-report"]')
  ?.dispatchEvent(event);
await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.equal(requests, 0);
controller.dispose();

const realState: RealAgentCenterControllerState = {
  readiness: null, routingPolicy: null, routingPreview: [],
  files: { balance_sheet: null, income_statement: null, cash_flow_statement: null },
  statementPreview: null, statementPackage: null, latestRun: null, runAgents: null,
  consentAccepted: false, busy: null, error: "financial_council_unavailable"
};
let activeRealState = realState;
let destroyed = 0;
let selectedStatementKind: string | null = null;
let councilStarts = 0;
const realCallbacks: {
  listener: ((state: RealAgentCenterControllerState) => void) | null;
} = { listener: null };
const real: RealAgentCenterController = {
  getState: () => activeRealState,
  subscribe(listener) {
    realCallbacks.listener = listener;
    return () => { realCallbacks.listener = null; };
  },
  async selectStatement(kind) { selectedStatementKind = kind; }, async previewStatements() {},
  acceptModelDataNotice() {}, async commitStatements() {},
  async startCouncil() { councilStarts += 1; },
  async updateRouting() {}, close() {}, destroy() { destroyed += 1; }
};
host.replaceChildren();
const realView = createAgentsController({
  host, real, window: parsed.window as unknown as Window
});
assert.match(host.innerHTML, /data-agent-center-authority="real"/u);
assert.doesNotMatch(host.innerHTML, /sample-report|示例数据/u);
realView.dispose();
assert.equal(destroyed, 1);

const conversationHost = parsed.document.createElement("div");
const supportHost = parsed.document.createElement("aside");
supportHost.className = "replica-demo-inspector";
let conversationDisposed = 0;
const realConversationView = createAgentsController({
  host: conversationHost,
  http: { request: async (_path: string, request: { body?: { fileName?: string } }) => ({ body: { cells: request.body?.fileName === '本期.xlsx' ? [] : [{ text: 'synthetic' }] } }) } as any,
  supportHost,
  real,
  window: parsed.window as unknown as Window,
  conversation(chatHost) {
    chatHost.innerHTML = '<section data-cfo-chat>真实经营总管问答</section>';
    return { dispose() { conversationDisposed += 1; } };
  }
});
assert.match(conversationHost.innerHTML, /data-cfo-chat/u);
assert.doesNotMatch(
  conversationHost.innerHTML,
  /data-agent-center-authority/u,
  "financial controls must not replace the active conversation workspace"
);
assert.match(supportHost.innerHTML, /data-agent-center-authority="real"/u);
assert.equal(
  supportHost.classList.contains("replica-demo-inspector"),
  true,
  "mounting support controls must retain the shell's inspector layout hook"
);
assert.ok(
  supportHost.querySelector(".cfo-chat-inspector"),
  "the normal inspector must retain current role, workspace and related-work context"
);
assert.equal(
  supportHost.querySelector(".agent-preparation-inspector [data-statements-file]"),
  null,
  "three report fields must not crowd the narrow inspector before the user expands preparation"
);
const preparationButton = supportHost.querySelector<HTMLButtonElement>(
  '[data-agent-preparation-action="open"]'
);
assert.ok(preparationButton, "financial preparation must remain obvious from the compact inspector");
preparationButton!.dispatchEvent(new parsed.window.Event("click", { bubbles: true }));
const preparationDialog = supportHost.querySelector<HTMLDialogElement>(
  "[data-agent-preparation-dialog]"
);
assert.equal(preparationDialog?.hasAttribute("open"), true);
assert.equal(preparationButton!.getAttribute("aria-expanded"), "true");
const statementInput = preparationDialog?.querySelector<HTMLInputElement>(
  '[data-statements-file="balance_sheet"]'
);
assert.ok(statementInput, "the real report import controls must be mounted with chat");
Object.defineProperty(statementInput, "files", {
  configurable: true,
  value: [new File(['synthetic'], 'test.xlsx')]
});
statementInput!.dispatchEvent(new parsed.window.Event("change", { bubbles: true }));
assert.equal(selectedStatementKind, "balance_sheet");
selectedStatementKind = null;
const batchInput = supportHost.querySelector<HTMLInputElement>('[data-statements-file="balance_sheet"]')!;
Object.defineProperty(batchInput, 'files', { configurable: true, value: [new File(['old'], '旧期.xlsx'), new File(['new'], '本期.xlsx')] });
batchInput.dispatchEvent(new parsed.window.Event('change', { bubbles: true }));
assert.equal(selectedStatementKind, null, 'same-kind batch must not silently take first or last');
assert.equal(supportHost.querySelectorAll('[data-statement-candidate]').length, 2);
await new Promise(resolve => setTimeout(resolve, 10));
assert.ok(supportHost.textContent?.includes('失败：'), 'invalid candidate displays its own error');
supportHost.querySelector<HTMLButtonElement>('[data-statement-candidate]')!.click();
assert.equal(selectedStatementKind, 'balance_sheet', 'explicit candidate selection uses existing formal workflow');
assert.ok(supportHost.textContent?.includes('失败：'), 'choosing a valid candidate preserves other file errors');
activeRealState = {
  ...realState,
  readiness: {
    capabilities: { canApprove: true, canManageRouting: true, canRun: true },
    data: { status: "not_connected", packageId: null, companyName: null,
      period: null, verifiedAt: null, warningCodes: [] },
    models: { status: "ready", routingPolicyVersionId: "policy-1", roles: [] },
    latestRun: null
  },
  statementPackage: {
    packageId: "pkg-test", companyName: "测试企业", period: "2026-09",
    currency: "CNY", cashForecast: null
  } as unknown as RealAgentCenterControllerState["statementPackage"]
};
realCallbacks.listener?.(activeRealState);
assert.ok(
  supportHost.querySelector('[data-agent-preparation-dialog] [data-real-action="run"]'),
  "the real council run control must be mounted with chat"
);
assert.equal(
  supportHost.querySelector<HTMLDialogElement>("[data-agent-preparation-dialog]")
    ?.hasAttribute("open"),
  true,
  "the financial preparation dialog must stay open while its controller refreshes state"
);
const runButton = supportHost.querySelector<HTMLButtonElement>(
  '[data-agent-preparation-dialog] [data-real-action="run"]'
);
assert.equal(runButton?.disabled, false, "a verified package keeps the run control reachable");
runButton?.dispatchEvent(new parsed.window.Event("click", { bubbles: true }));
assert.equal(councilStarts, 1, "the real council run event must reach its controller");
const routingButton = supportHost.querySelector<HTMLElement>(
  "[data-agent-preparation-dialog]"
)?.querySelector<HTMLElement>(
  '[data-routing-action="open"]'
);
assert.ok(routingButton);
routingButton!.dispatchEvent(new parsed.window.Event("click", { bubbles: true }));
assert.equal(
  supportHost.querySelector<HTMLDialogElement>("[data-routing-dialog]")
    ?.hasAttribute("open"),
  true,
  "the mounted support workspace must receive real-agent controls"
);
assert.equal(
  supportHost.querySelector<HTMLDialogElement>("[data-agent-preparation-dialog]")
    ?.hasAttribute("open"),
  false,
  "opening model routing closes preparation instead of nesting native dialogs"
);
supportHost.querySelector<HTMLButtonElement>('[data-routing-action="close"]')
  ?.dispatchEvent(new parsed.window.Event("click", { bubbles: true }));
supportHost.querySelector<HTMLButtonElement>('[data-agent-preparation-action="open"]')
  ?.dispatchEvent(new parsed.window.Event("click", { bubbles: true }));
supportHost.querySelector<HTMLButtonElement>('[data-agent-preparation-action="close"]')
  ?.dispatchEvent(new parsed.window.Event("click", { bubbles: true }));
assert.equal(
  supportHost.querySelector<HTMLDialogElement>("[data-agent-preparation-dialog]")
    ?.hasAttribute("open"),
  false,
  "closing preparation returns to the compact inspector"
);
realConversationView.dispose();
assert.equal(conversationDisposed, 1);
assert.equal(conversationHost.childElementCount, 0);
assert.equal(supportHost.childElementCount, 0);
