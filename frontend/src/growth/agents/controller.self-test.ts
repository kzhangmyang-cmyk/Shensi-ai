import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { createAgentsController } from "./controller";
import type { GrowthHttpClient } from "../http";

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
