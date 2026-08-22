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

export interface FinanceApi {
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
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<FinanceImportPreview>>;
  commitImport(
    previewId: string,
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<FinanceImportOperation>>;
  getImport(
    operationId: string,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<FinanceImportOperation>>;
}

export function createFinanceApi(http: GrowthHttpClient): FinanceApi {
  const api: FinanceApi = {
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
    async previewImport(kind, file, filename, idempotencyKey, signal) {
      return http.request<FinanceImportPreview>(
        `/api/v1/finance/imports/preview`,
        {
          method: "POST",
          body: { kind, filename, contentLength: file.size },
          idempotencyKey,
          signal
        }
      );
    },
    async commitImport(previewId, idempotencyKey) {
      return http.request<FinanceImportOperation>(
        `/api/v1/finance/imports/${encodeURIComponent(previewId)}/commit`,
        { method: "POST", idempotencyKey }
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
