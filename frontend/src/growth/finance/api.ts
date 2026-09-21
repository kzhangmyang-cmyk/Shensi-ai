import type { components } from "../../generated/growth-advisor-quote-roi";
import type {
  GrowthHttpClient,
  GrowthHttpResponse
} from "../http";

export type AcquisitionCostEntry = Omit<
  components["schemas"]["AcquisitionCostEntry"],
  "$defs"
>;
export type AcquisitionCostEstimate =
  components["schemas"]["AcquisitionCostEntry_AcquisitionCostEstimate"];
export type FinancialFact = Omit<
  components["schemas"]["FinancialFact"],
  "$defs"
>;
export type FinancialFactCorrectionInput =
  components["schemas"]["FinancialFact_FinancialFactCorrectionInput"];
export type FinancialFactCorrectionResult =
  components["schemas"]["FinancialFact_FinancialFactCorrectionResult"];
export type FinanceImportPreview =
  components["schemas"]["FinanceImportOperation_FinanceImportPreview"];
export type FinanceImportOperation = Omit<
  components["schemas"]["FinanceImportOperation"],
  "$defs"
>;
export type FinanceImportRowError =
  components["schemas"]["FinanceImportOperation_FinanceImportRowError"];
export type FinanceImportMapping = components["schemas"]["FinanceImportPreviewInput"]["mapping"];
export type FinanceDocumentInspection = Omit<components["schemas"]["FinanceDocumentInspection"], "$defs">;

export function financeImportFileIssue(file: Blob, filename: string): string | null {
  if (!/\.(csv|xlsx)$/iu.test(filename)) return "请选择 CSV 或 XLSX 文件，其他格式请先转换。";
  if (file.size === 0) return "文件为空，请选择包含数据的 CSV 或 XLSX 文件。";
  if (file.size > 5 * 1024 * 1024) return "文件超过 5 MB，请拆分后重新选择。";
  return null;
}
export function financeDocumentFileIssue(file: Blob, filename: string): string | null {
  if (/\.doc$/iu.test(filename)) return "旧版 DOC 暂不支持，请另存为 DOCX 后上传。";
  if (!/\.(csv|xls|xlsx|pdf|docx)$/iu.test(filename)) return "请选择 CSV、XLS、XLSX、含文字的 PDF 或 DOCX 文件。";
  if (file.size === 0) return "文件为空，请选择包含文字或数据的文件。";
  if (file.size > 5 * 1024 * 1024) return "文件超过 5 MB，请拆分后重新选择。";
  return null;
}

export interface FinanceApi {
  clearDocumentSelection(signal?: AbortSignal): Promise<GrowthHttpResponse<void>>;
  inspectDocument(file: Blob, filename: string, readWithModel: boolean, signal?: AbortSignal,
    purpose?: 'finance' | 'roi' | 'management', additionalFiles?: readonly File[]): Promise<GrowthHttpResponse<FinanceDocumentInspection>>;
  listCostEntries(query: {
    limit: number;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<GrowthHttpResponse<{ items: readonly AcquisitionCostEntry[] }>>;
  listCostEstimates(query: {
    limit: number;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<GrowthHttpResponse<{ items: readonly AcquisitionCostEstimate[] }>>;
  verifyCostEntry(
    id: string,
    etag: string,
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<AcquisitionCostEntry>>;
  reverseCostEntry(
    id: string,
    etag: string,
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<AcquisitionCostEntry>>;
  listFinancialFacts(query: {
    limit: number;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<GrowthHttpResponse<{ items: readonly FinancialFact[] }>>;
  verifyFinancialFact(
    id: string,
    etag: string,
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<FinancialFact>>;
  correctFinancialFact(
    id: string,
    input: FinancialFactCorrectionInput,
    etag: string,
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<FinancialFactCorrectionResult>>;
  previewImport(
    kind: "acquisition_cost" | "financial_fact",
    file: Blob,
    filename: string,
    idempotencyKey: string,
    signal?: AbortSignal,
    mapping?: FinanceImportMapping
  ): Promise<GrowthHttpResponse<FinanceImportPreview>>;
  commitImport(
    previewId: string,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<FinanceImportOperation>>;
  getImport(
    operationId: string,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<FinanceImportOperation>>;
}

function importMediaType(filename: string):
  "text/csv"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" {
  if (filename.toLowerCase().endsWith(".csv")) {
    return "text/csv";
  }
  return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

async function blobToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function createFinanceApi(http: GrowthHttpClient): FinanceApi {
  const api: FinanceApi = {
    clearDocumentSelection(signal) {
      return http.request<void>("/api/v1/finance/documents/selection", { method: "DELETE", signal });
    },
    async inspectDocument(file, filename, readWithModel, signal, analysisPurpose, additionalFiles = []) {
      if (additionalFiles.length > 9 || file.size + additionalFiles.reduce((sum, item) => sum + item.size, 0) > 5 * 1024 * 1024) throw new Error('每批最多10份文件，合计不超过5MB。');
      const issue = financeDocumentFileIssue(file, filename);
      if (issue) throw new Error(issue);
      signal?.throwIfAborted();
      let contentBase64: string;
      try { contentBase64 = await blobToBase64(file); }
      catch { throw new Error("无法读取文件，请确认文件仍在本机且可访问，然后重新选择。"); }
      signal?.throwIfAborted();
      const body: components["schemas"]["FinanceDocumentInspectionInput"] = {
        fileName: filename,
        mediaType: /\.xls$/iu.test(filename) ? "application/vnd.ms-excel" : /\.pdf$/iu.test(filename) ? "application/pdf"
          : /\.docx$/iu.test(filename) ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : importMediaType(filename),
        contentBase64, readWithModel, ...(analysisPurpose ? { analysisPurpose } : {}),
        ...(additionalFiles.length ? { additionalFiles: await Promise.all(additionalFiles.map(async item => {
          const issue = financeDocumentFileIssue(item, item.name); if (issue) throw new Error(issue);
          return { fileName: item.name, mediaType: /\.xls$/iu.test(item.name) ? 'application/vnd.ms-excel' as const
            : /\.pdf$/iu.test(item.name) ? 'application/pdf' as const : /\.docx$/iu.test(item.name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const : importMediaType(item.name),
            contentBase64: await blobToBase64(item) };
        })) } : {})
      };
      return http.request<FinanceDocumentInspection>("/api/v1/finance/documents/inspect", { method: "POST", body, signal });
    },
    async listCostEntries(query) {
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.cursor) params.set("cursor", query.cursor);
      return http.request<{ items: readonly AcquisitionCostEntry[] }>(
        `/api/v1/acquisition/cost-entries?${params}`,
        { signal: query.signal }
      );
    },
    async listCostEstimates(query) {
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.cursor) params.set("cursor", query.cursor);
      return http.request<{ items: readonly AcquisitionCostEstimate[] }>(
        `/api/v1/acquisition/cost-estimates?${params}`,
        { signal: query.signal }
      );
    },
    async verifyCostEntry(id, etag, idempotencyKey) {
      return http.request<AcquisitionCostEntry>(
        `/api/v1/acquisition/cost-entries/${encodeURIComponent(id)}/verify`,
        { method: "POST", ifMatch: etag, idempotencyKey }
      );
    },
    async reverseCostEntry(id, etag, idempotencyKey) {
      return http.request<AcquisitionCostEntry>(
        `/api/v1/acquisition/cost-entries/${encodeURIComponent(id)}/reverse`,
        { method: "POST", ifMatch: etag, idempotencyKey }
      );
    },
    async listFinancialFacts(query) {
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.cursor) params.set("cursor", query.cursor);
      return http.request<{ items: readonly FinancialFact[] }>(
        `/api/v1/finance/facts?${params}`,
        { signal: query.signal }
      );
    },
    async verifyFinancialFact(id, etag, idempotencyKey) {
      return http.request<FinancialFact>(
        `/api/v1/finance/facts/${encodeURIComponent(id)}/verify`,
        { method: "POST", ifMatch: etag, idempotencyKey }
      );
    },
    async correctFinancialFact(id, input, etag, idempotencyKey) {
      return http.request<FinancialFactCorrectionResult>(
        `/api/v1/finance/facts/${encodeURIComponent(id)}/correct`,
        { method: "POST", body: input, ifMatch: etag, idempotencyKey }
      );
    },
    async previewImport(kind, file, filename, idempotencyKey, signal, mapping = {}) {
      const issue = financeImportFileIssue(file, filename);
      if (issue) throw new Error(issue);
      signal?.throwIfAborted();
      let contentBase64: string;
      try {
        contentBase64 = await blobToBase64(file);
      } catch {
        throw new Error("无法读取文件，请确认文件仍在本机且可访问，然后重新选择。");
      }
      signal?.throwIfAborted();
      return http.request<FinanceImportPreview>(
        `/api/v1/finance/imports/preview`,
        {
          method: "POST",
          body: {
            kind,
            fileName: filename,
            mediaType: importMediaType(filename),
            contentBase64,
            mapping
          },
          idempotencyKey,
          signal
        }
      );
    },
    async commitImport(previewId, idempotencyKey, signal) {
      return http.request<FinanceImportOperation>(
        `/api/v1/finance/imports/${encodeURIComponent(previewId)}/commit`,
        { method: "POST", idempotencyKey, signal }
      );
    },
    async getImport(operationId, signal) {
      return http.request<FinanceImportOperation>(
        `/api/v1/finance/imports/${encodeURIComponent(operationId)}`,
        { signal }
      );
    }
  };
  return Object.freeze(api);
}
