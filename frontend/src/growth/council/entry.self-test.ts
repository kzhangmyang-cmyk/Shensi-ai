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
let openedLatest = false;
let retries = 0;

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
    async open() {}, async openLatest() { openedLatest = true; }, async loadMoreHistory() {}, async retry() { retries += 1; }, async createFromStatementPackage() {}, selectPortfolio() {}, setEditDraft() {},
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
assert.equal(openedLatest, true, "sidebar reopen must read current workspace history");
const dataAsOf = host.querySelector<HTMLInputElement>("[data-council-data-as-of]")!;
dataAsOf.setAttribute("type", "text");
dataAsOf.value = "2026-08-16T08:00";
host.querySelector<HTMLButtonElement>("[data-council-action=create]")!.click();
await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.equal(createdDataAsOf, new Date("2026-08-16T08:00").toISOString());
assert.equal(replacedHash, "#financial-council/run/council-run-fixture");
assert.doesNotMatch(host.innerHTML, /示例外贸企业/u);
const rejection = host.querySelector<HTMLTextAreaElement>("[data-council-rejection-reason]")!;
rejection.value = "暂不批准，保留编辑草稿";
const timeline = host.querySelector<HTMLDetailsElement>('[data-council-detail="timeline"]')!;
timeline.open = true;
const insertedControl = document.createElement("input");
insertedControl.value = "must-not-migrate-to-rejection";
rejection.before(insertedControl);
const insertedDetail = document.createElement("details");
host.prepend(insertedDetail);
listeners.forEach(listener => listener({ ...state, lastUpdatedAt: "2026-09-10T01:00:00Z" }));
assert.equal(host.querySelector<HTMLTextAreaElement>("[data-council-rejection-reason]")?.value, "暂不批准，保留编辑草稿");
assert.equal(host.querySelector<HTMLDetailsElement>('[data-council-detail="timeline"]')?.open, true);
listeners.forEach(listener => listener({ ...state, error: "partial unavailable" }));
host.querySelector<HTMLButtonElement>('[data-council-action="retry"]')!.click();
assert.equal(retries, 1);
entry.dispose();

function exportState(runId: string, reportId: string): FinancialCouncilControllerState {
  const run = { ...financialCouncilFixture.awaitingApproval, runId };
  return {
    run, events: null, policy: null, dispatches: null,
    selectedPortfolioKind: null, editDraft: null, busy: null, error: null, lastUpdatedAt: null,
    collaboration: {
      runId, workspaceId: run.workspaceId, revision: run.revision, dataAsOf: run.dataAsOf,
      currency: "CNY", statementPackageId: "package-1", snapshotId: "snapshot-1",
      snapshotHash: "sha256:" + "a".repeat(64), policyVersionId: "policy-1",
      executionMode: "sequential", reviewRoundLimit: 1, roles: [], events: [], reviews: [], narrative: null,
      report: {
        reportId, version: "financial-council-report.v1", title: `报告 ${reportId}`,
        complete: true, generatedAt: run.dataAsOf,
        sections: [{ id: "summary", title: "结论", paragraphs: [`快照 ${reportId}`], items: [] }]
      }
    }
  };
}

for (const transition of ["different-run", "new-report", "disposed", "same-report-poll"] as const) {
  for (const [outcome, expectedFeedback] of [
    ["saved", "PDF 已保存"], ["cancelled", "已取消保存"], ["failed", "PDF 导出失败，请重试。"]
  ] as const) {
    const { document: exportDocument } = parseHTML("<div id=export-host></div>");
    const exportHost = exportDocument.querySelector<HTMLElement>("#export-host")!;
    const exportWindow = exportDocument.defaultView!;
    const previousBridge = exportWindow.shensiCouncilReport;
    type ExportResult = Awaited<ReturnType<NonNullable<Window["shensiCouncilReport"]>["exportPdf"]>>;
    let resolveExport: (result: ExportResult) => void = () => { throw new Error("PDF export did not start"); };
    let rejectExport: (reason: Error) => void = () => { throw new Error("PDF export did not start"); };
    const capturedExports: { html: string; filename: string }[] = [];
    exportWindow.shensiCouncilReport = {
      exportPdf(input) {
        capturedExports.push(input);
        return new Promise<ExportResult>((resolve, reject) => { resolveExport = resolve; rejectExport = reject; });
      }
    };
    let exportCurrentState = exportState("run-A", "report-A");
    const exportListeners = new Set<(next: FinancialCouncilControllerState) => void>();
    const exportEntry = createFinancialCouncilWorkbenchEntry({
      host: exportHost, capabilities: [], replaceHash() {},
      controller: {
        getState: () => exportCurrentState,
        subscribe(listener) { exportListeners.add(listener); return () => exportListeners.delete(listener); },
        async create() {}, async open() {}, async openLatest() {}, async loadMoreHistory() {}, async retry() {},
        async createFromStatementPackage() {}, selectPortfolio() {}, setEditDraft() {},
        async revise() {}, async approve() {}, async reject() {}, destroy() {}
      }
    });
    try {
      await exportEntry.mount("run-A");
      exportHost.querySelector<HTMLButtonElement>('[data-council-action="download-pdf"]')!.click();
      assert.equal(capturedExports.length, 1);
      assert.equal(capturedExports[0]!.filename, "financial-council-report-A.pdf");
      assert.match(capturedExports[0]!.html, /快照 report-A/);
      if (transition === "disposed") exportEntry.dispose();
      else {
        exportCurrentState = exportState(transition === "different-run" ? "run-B" : "run-A",
          transition === "same-report-poll" ? "report-A" : "report-B");
        exportListeners.forEach(listener => listener(exportCurrentState));
      }
      const feedbackNode = exportHost.querySelector<HTMLElement>("[data-council-export-feedback]")!;
      assert.equal(feedbackNode.textContent, "");
      if (outcome === "failed") rejectExport(new Error("save failed"));
      else resolveExport({ status: outcome });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      assert.equal(feedbackNode.textContent, transition === "same-report-poll" ? expectedFeedback : "",
        `${outcome} PDF feedback must remain bound to its live run and report after ${transition}`);
      assert.equal(capturedExports.length, 1, "completion must not export the newly displayed report");
      assert.doesNotMatch(capturedExports[0]!.html, /report-B/);
    } finally {
      exportEntry.dispose();
      if (previousBridge) exportWindow.shensiCouncilReport = previousBridge;
      else delete exportWindow.shensiCouncilReport;
    }
  }
}
