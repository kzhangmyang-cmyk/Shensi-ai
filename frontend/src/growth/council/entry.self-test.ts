import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { financialCouncilFixture } from "../../../tests/fixtures/growth-contract";
import { createFinancialCouncilWorkbenchEntry } from "./entry";
import type { FinancialCouncilControllerState } from "./controller";

const { document } = parseHTML("<div id=host></div>");
const host = document.querySelector<HTMLElement>("#host")!;
let state: FinancialCouncilControllerState = {
  run: null, events: null, policy: null, dispatches: null,
  selectedPortfolioKind: null, editDraft: null, busy: null, error: null,
  lastUpdatedAt: null
};
const listeners = new Set<(next: FinancialCouncilControllerState) => void>();
let createdDataAsOf: string | null = null;
let replacedHash: string | null = null;

const entry = createFinancialCouncilWorkbenchEntry({
  host,
  capabilities: ["finance.council.run", "finance.council.approve"],
  controller: {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async create(input) {
      createdDataAsOf = input.dataAsOf;
      state = { ...state, run: financialCouncilFixture.analyzing };
      listeners.forEach((listener) => listener(state));
    },
    async open() {}, selectPortfolio() {}, setEditDraft() {},
    async revise() {}, async approve() {}, async reject() {}, destroy() {}
  },
  createInput: async (dataAsOf) => ({
    currency: "CNY", dataAsOf,
    businessReport: financialCouncilFixture.awaitingApproval.businessReport,
    policyVersionId: "council-policy-v1"
  }),
  replaceHash(hash) { replacedHash = hash; }
});

await entry.mount();
const dataAsOf = host.querySelector<HTMLInputElement>("[data-council-data-as-of]")!;
dataAsOf.setAttribute("type", "text");
dataAsOf.value = "2026-08-16T08:00";
host.querySelector<HTMLButtonElement>("[data-council-action=create]")!.click();
await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.equal(createdDataAsOf, new Date("2026-08-16T08:00").toISOString());
assert.equal(replacedHash, "#financial-council/run/council-run-fixture");
assert.doesNotMatch(host.innerHTML, /示例外贸企业/u);
entry.dispose();
