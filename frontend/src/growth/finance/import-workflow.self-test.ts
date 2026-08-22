import { strict as assert } from "node:assert";
import {
  createFinanceImportWorkflow,
  type FinanceImportState
} from "./import-workflow";
import type { FinanceApi } from "./api";

let commitCalls = 0;
let previewIdCalls = 0;
let pollCalls = 0;
const api: FinanceApi = {
  async listCostEntries() {
    throw new Error("unused");
  },
  async listCostEstimates() {
    throw new Error("unused");
  },
  async verifyCostEntry() {
    throw new Error("unused");
  },
  async reverseCostEntry() {
    throw new Error("unused");
  },
  async listFinancialFacts() {
    throw new Error("unused");
  },
  async verifyFinancialFact() {
    throw new Error("unused");
  },
  async correctFinancialFact() {
    throw new Error("unused");
  },
  async previewImport() {
    return {
      status: 200,
      etag: null,
      body: {
        previewId: "preview-1",
        kind: "acquisition_cost",
        totalRows: 5,
        acceptedRows: 3,
        rejectedRows: 2,
        errors: [{
          rowNumber: 2,
          code: "money_invalid",
          field: "amountMinor",
          message: "金额无效"
        }],
        expiresAt: "2026-08-10T08:00:00.000Z"
      }
    } as never;
  },
  async commitImport(previewId, idempotencyKey) {
    previewIdCalls += 1;
    assert.equal(previewId, "preview-1");
    assert.match(idempotencyKey, /^finance-commit:/u);
    commitCalls += 1;
    return {
      status: 200,
      etag: null,
      body: {
        id: "import-1",
        workspaceId: "ws-1",
        kind: "acquisition_cost",
        status: "queued",
        totalRows: 5,
        acceptedRows: 3,
        rejectedRows: 2,
        createdAt: "2026-08-09T08:00:00.000Z",
        completedAt: null
      }
    } as never;
  },
  async getImport(operationId) {
    pollCalls += 1;
    assert.equal(operationId, "import-1");
    if (pollCalls === 1) {
      return {
        status: 200,
        etag: null,
        body: {
          id: "import-1",
          workspaceId: "ws-1",
          kind: "acquisition_cost",
          status: "running",
          totalRows: 5,
          acceptedRows: 3,
          rejectedRows: 2,
          createdAt: "2026-08-09T08:00:00.000Z",
          completedAt: null
        }
      } as never;
    }
    return {
      status: 200,
      etag: null,
      body: {
        id: "import-1",
        workspaceId: "ws-1",
        kind: "acquisition_cost",
        status: "succeeded",
        totalRows: 5,
        acceptedRows: 3,
        rejectedRows: 2,
        createdAt: "2026-08-09T08:00:00.000Z",
        completedAt: "2026-08-09T08:00:05.000Z"
      }
    } as never;
  }
};

const workflow = createFinanceImportWorkflow(api);
const previewed = await workflow.preview(
  "acquisition_cost",
  new Blob(["a,b,c"]),
  "costs.xlsx",
  "finance-preview:key-1"
);
assert.equal(previewed.kind, "preview_ready");
assert.equal(previewed.preview.rejectedRows, 2);
assert.equal(previewed.preview.errors[0]?.code, "money_invalid");

const committed = await workflow.commit("preview-1", "finance-commit:key-1");
assert.equal(committed.kind, "succeeded");
assert.equal(commitCalls, 1);
assert.equal(pollCalls, 2);
assert.equal(previewIdCalls, 1);

const replayed = await workflow.commit("preview-1", "finance-commit:key-1");
assert.equal(replayed.kind, "succeeded");
assert.equal(commitCalls, 2);

const idle: FinanceImportState = { kind: "idle" };
assert.equal(idle.kind, "idle");
