import { strict as assert } from "node:assert";
import { createFinanceApi } from "./api";
import type {
  GrowthHttpClient,
  GrowthHttpRequestOptions
} from "../http";
import type { FinancialFactCorrectionInput } from "./api";

const calls: Array<{ path: string; options?: GrowthHttpRequestOptions }> = [];
const http: GrowthHttpClient = {
  async request(path, options) {
    calls.push({ path, options });
    return {
      status: 200,
      etag: '"2"',
      body: { id: "fact-1", status: "verified", revision: 3 }
    } as never;
  }
};

const api = createFinanceApi(http);
const expectedCorrection: FinancialFactCorrectionInput = {
  reason: "银行回单金额录入错误",
  replacement: {
    factType: "payment_received",
    amountMinor: 125_000,
    currency: "CNY",
    businessOccurredAt: "2026-08-09T01:00:00.000Z",
    provenance: "manual_verified",
    evidenceHash: `sha256:${"e".repeat(64)}`,
    candidateId: null,
    customerId: null,
    dealId: null,
    externalId: null,
    sourceIdentityRoot: "fact-1",
    sourceRef: null
  }
};
await api.correctFinancialFact(
  "fact-1",
  expectedCorrection,
  '"fact-3"',
  "finance-correct:key-1"
);
assert.deepEqual(calls[0], {
  path: "/api/v1/finance/facts/fact-1/correct",
  options: {
    method: "POST",
    body: expectedCorrection,
    ifMatch: '"fact-3"',
    idempotencyKey: "finance-correct:key-1"
  }
});

await api.verifyCostEntry("cost-1", '"1"', "finance-verify:key-1");
assert.equal(
  calls[1]?.path,
  "/api/v1/acquisition/cost-entries/cost-1/verify"
);

await api.previewImport(
  "acquisition_cost",
  new Blob(["abc"], { type: "text/csv" }),
  "costs.csv",
  "finance-preview:key-1"
);
assert.deepEqual(calls[2], {
  path: "/api/v1/finance/imports/preview",
  options: {
    method: "POST",
    body: {
      kind: "acquisition_cost",
      fileName: "costs.csv",
      mediaType: "text/csv",
      contentBase64: "YWJj",
      mapping: {}
    },
    idempotencyKey: "finance-preview:key-1",
    signal: undefined
  }
});

for (const [file, name, message] of [
  [new Blob(["invalid"]), "not-supported.pdf", /请选择 CSV 或 XLSX/u],
  [new Blob([]), "empty.csv", /文件为空/u],
  [new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]), "large.csv", /超过 5 MB/u]
] as const) {
  await assert.rejects(api.previewImport("acquisition_cost", file, name, "invalid-file"), message);
}
assert.equal(calls.length, 3, "invalid files must not reach the API");

class UnreadableFile extends Blob {
  async arrayBuffer(): Promise<ArrayBuffer> { throw new DOMException("unavailable", "NotReadableError"); }
}
await assert.rejects(api.previewImport("acquisition_cost", new UnreadableFile(["data"]), "moved.csv", "unreadable"), /无法读取文件/u);
assert.equal(calls.length, 3);

await api.previewImport("acquisition_cost", new Blob(["abc"]), "中文账本.csv", "explicit-mapping", undefined, { amount: "实际金额", currency: "币种" });
assert.deepEqual((calls[3]?.options?.body as { mapping: unknown }).mapping, { amount: "实际金额", currency: "币种" }, "preview must forward the user's explicit column choices");

const aborted = new AbortController();
aborted.abort();
await assert.rejects(api.previewImport("acquisition_cost", new Blob(["data"]), "cost.csv", "aborted", aborted.signal), { name: "AbortError" });
assert.equal(calls.length, 4);

await api.inspectDocument(new Blob(['原始数据']), '原表.csv', false);
assert.deepEqual(calls[4], { path: '/api/v1/finance/documents/inspect', options: {
  method: 'POST', body: { fileName: '原表.csv', mediaType: 'text/csv', contentBase64: Buffer.from('原始数据').toString('base64'), readWithModel: false }, signal: undefined
} });
await api.inspectDocument(new Blob(['原始数据']), '原表.csv', true);
assert.equal((calls[5]?.options?.body as { readWithModel: boolean }).readWithModel, true);
await assert.rejects(api.inspectDocument(new Blob(['data']), '原表.csv', false, aborted.signal), { name: 'AbortError' });
assert.equal(calls.length, 6);
await api.clearDocumentSelection();
assert.deepEqual(calls[6], { path: '/api/v1/finance/documents/selection', options: { method: 'DELETE', signal: undefined } });
for (const [name, mediaType] of [
  ['旧版报表.XLS', 'application/vnd.ms-excel'],
  ['原始报告.PDF', 'application/pdf'],
  ['原始报告.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
]) {
  await api.inspectDocument(new Blob(['synthetic original bytes']), name!, false);
  assert.deepEqual(calls.at(-1)?.options?.body, { fileName: name, mediaType, contentBase64: Buffer.from('synthetic original bytes').toString('base64'), readWithModel: false });
  const requestCountBeforeRejectedImport: number = calls.length;
  await assert.rejects(api.previewImport('financial_fact', new Blob(['fixture']), name!, 'must-not-import'), /CSV 或 XLSX/);
  assert.equal(calls.length, requestCountBeforeRejectedImport, 'PDF/DOCX must never reach ledger preview');
}
await assert.rejects(api.inspectDocument(new Blob(['fixture']), '旧版.doc', false), /另存为 DOCX/);
const attachmentScope = { conversationKey: '12345678-1234-4234-8234-123456789012', role: 'cost' as const };
await api.inspectDocument(new Blob(['来源']), '聊天.csv', false, undefined, undefined, [], attachmentScope);
assert.deepEqual((calls.at(-1)?.options?.body as { attachmentScope: unknown }).attachmentScope, attachmentScope);
const beforeForbiddenModel = calls.length;
await assert.rejects(api.inspectDocument(new Blob(['来源']), '聊天.csv', true, undefined, undefined, [], attachmentScope));
assert.equal(calls.length, beforeForbiddenModel, 'attachment parsing cannot authorize model traffic');
const clearInput = { ...attachmentScope, documentId: '22345678-1234-4234-8234-123456789012' };
await api.clearChatAttachment(clearInput);
assert.deepEqual(calls.at(-1), { path: '/api/v1/finance/documents/attachments/clear', options: { method: 'POST', body: clearInput, signal: undefined } });
