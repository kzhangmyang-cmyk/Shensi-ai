import { strict as assert } from "node:assert";
import {
  createFinanceImportWorkflow,
  type FinanceImportState
} from "./import-workflow";
import type { FinanceApi } from "./api";
import { GrowthApiError } from "../http";

let commitCalls = 0;
let previewIdCalls = 0;
let pollCalls = 0;
const api: FinanceApi = {
  async clearChatAttachment() { throw new Error('unused'); },
  async clearDocumentSelection() { throw new Error('unused'); },
  async inspectDocument(_file, filename, readWithModel) {
    return { status: 200, etag: null, body: { documentId: 'document-1', fileName: filename, fileHash: `sha256:${'a'.repeat(64)}`, expiresAt: '2026-09-11T00:00:00Z', selectedForConversation: readWithModel,
      classification: 'unknown', cells: [], regions: [], missingStatements: ['balance_sheet'], uncertain: [], observations: [], modelStatus: readWithModel ? 'unavailable' : 'not_requested' } };
  },
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
for (const [code, expected] of [
  ['finance_document_text_unavailable', /可复制文字.*OCR/s],
  ['finance_document_password_required', /加密.*解除密码/s],
  ['finance_document_encrypted', /加密.*解除密码/s],
  ['finance_document_format_unsupported', /格式暂不支持.*PDF.*DOCX/s],
  ['finance_document_format_invalid', /格式.*损坏/s],
  ['finance_document_artifact_invalid', /格式.*损坏/s],
  ['finance_document_limit_exceeded', /限制.*拆分/s],
  ['finance_document_timeout', /超时.*重试/s]
] as const) {
  const failing = createFinanceImportWorkflow({ ...api, async inspectDocument() { throw new GrowthApiError(422, code); } });
  const result = await failing.inspect(new Blob(['fixture']), 'report.pdf', false);
  assert.equal(result.kind, 'failed');
  assert.match(result.kind === 'failed' ? result.message : '', expected);
}
const inspected = await workflow.inspect(new Blob(['data']), 'original.csv', false);
assert.equal(inspected.kind, 'document_ready');
assert.equal(inspected.kind === 'document_ready' && inspected.document.selectedForConversation, false);
const modelUnavailable = await workflow.inspect(new Blob(['data']), 'original.csv', true);
assert.equal(modelUnavailable.kind === 'document_ready' && modelUnavailable.document.modelStatus, 'unavailable', 'model unavailable still preserves readonly source preview');
assert.equal(commitCalls, 0, 'inspection must never commit ledger data');
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

let observedPollSignal: AbortSignal | undefined;
let markPollStarted!: () => void;
const pollStarted = new Promise<void>(resolve => { markPollStarted = resolve; });
const cancellable = createFinanceImportWorkflow({
  ...api,
  async getImport(_id, signal) {
    observedPollSignal = signal;
    markPollStarted();
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }
});
const routeAbort = new AbortController();
const polling = cancellable.poll("operation-on-old-route", routeAbort.signal);
await pollStarted;
routeAbort.abort();
const cancelled = await polling;
assert.equal(observedPollSignal?.aborted, true, "route disposal must abort the in-flight polling request");
assert.equal(cancelled.kind, "failed");
assert.match(cancelled.message, /导入已取消/u);
