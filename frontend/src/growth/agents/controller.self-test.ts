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
let destroyed = 0;
const real: RealAgentCenterController = {
  getState: () => realState,
  subscribe() { return () => undefined; },
  async selectStatement() {}, async previewStatements() {},
  acceptModelDataNotice() {}, async commitStatements() {}, async startCouncil() {},
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
