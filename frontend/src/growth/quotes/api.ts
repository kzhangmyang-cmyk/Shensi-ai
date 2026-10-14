import type { components } from "../../generated/growth-advisor-quote-roi";
import type {
  GrowthHttpClient,
  GrowthHttpRequestOptions,
  GrowthHttpResponse
} from "../http";

export type QuoteCase = Omit<
  components["schemas"]["QuoteCase"],
  "$defs"
>;
export type QuotePreviewInput =
  components["schemas"]["QuoteCase_QuotePreviewInput"];
export type QuoteCaseCreateInput =
  components["schemas"]["QuoteCase_QuoteCaseCreateInput"];
export type QuotePreviewIdentity =
  components["schemas"]["QuoteCase_QuotePreviewIdentity"];
export type QuotePreviewResult =
  components["schemas"]["QuoteCase_QuotePreviewResult"];
export type QuoteVersion = Omit<
  components["schemas"]["QuoteVersion"],
  "$defs"
>;
export type QuoteApproval = Omit<
  components["schemas"]["QuoteApproval"],
  "$defs"
>;
export type QuotePublicationOperation = Omit<
  components["schemas"]["QuotePublicationOperation"],
  "$defs"
>;

export interface QuoteApi {
  listCases(query: {
    limit: number;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<GrowthHttpResponse<{ items: readonly QuoteCase[] }>>;
  createCase(
    input: QuoteCaseCreateInput,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<QuoteCase>>;
  getCase(
    caseId: string,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<QuoteCase>>;
  previewQuote(
    caseId: string,
    input: QuotePreviewInput,
    etag: string,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<QuotePreviewResult>>;
  listVersions(
    caseId: string,
    query: { limit: number; cursor?: string; signal?: AbortSignal }
  ): Promise<GrowthHttpResponse<{ items: readonly QuoteVersion[] }>>;
  createVersion(
    caseId: string,
    input: {
      previewIdentity: QuotePreviewIdentity;
      quoteInput: QuotePreviewInput;
    },
    etag: string,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<QuoteVersion>>;
  getVersion(
    versionId: string,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<QuoteVersion>>;
  listApprovals(
    versionId: string,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<{ items: readonly QuoteApproval[] }>>;
  submitVersion(
    versionId: string,
    etag: string,
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<QuoteApproval>>;
  approveVersion(
    versionId: string,
    etag: string,
    idempotencyKey: string,
    reason: string
  ): Promise<GrowthHttpResponse<QuoteVersion>>;
  rejectVersion(
    versionId: string,
    etag: string,
    idempotencyKey: string,
    reason: string
  ): Promise<GrowthHttpResponse<QuoteApproval>>;
  getPublication(
    operationId: string,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<QuotePublicationOperation>>;
  retryPublication(
    operationId: string,
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<QuotePublicationOperation>>;
}

function commandOptions(
  etag: string,
  idempotencyKey: string
): GrowthHttpRequestOptions {
  return { method: "POST", ifMatch: etag, idempotencyKey };
}

export function createQuoteApi(http: GrowthHttpClient): QuoteApi {
  const api: QuoteApi = {
    async listCases(query) {
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.cursor) params.set("cursor", query.cursor);
      return http.request<{ items: readonly QuoteCase[] }>(
        `/api/v1/quotes/cases?${params}`,
        { signal: query.signal }
      );
    },
    async createCase(input, idempotencyKey, signal) {
      return http.request<QuoteCase>("/api/v1/quotes/cases", {
        method: "POST",
        body: input,
        idempotencyKey,
        signal
      });
    },
    async getCase(caseId, signal) {
      return http.request<QuoteCase>(
        `/api/v1/quotes/cases/${encodeURIComponent(caseId)}`,
        { signal }
      );
    },
    async previewQuote(caseId, input, etag, idempotencyKey, signal) {
      return http.request<QuotePreviewResult>(
        `/api/v1/quotes/cases/${encodeURIComponent(caseId)}/preview`,
        {
          method: "POST",
          body: input,
          ifMatch: etag,
          idempotencyKey,
          signal
        }
      );
    },
    async listVersions(caseId, query) {
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.cursor) params.set("cursor", query.cursor);
      return http.request<{ items: readonly QuoteVersion[] }>(
        `/api/v1/quotes/cases/${encodeURIComponent(caseId)}/versions?${params}`,
        { signal: query.signal }
      );
    },
    async createVersion(caseId, input, etag, idempotencyKey, signal) {
      return http.request<QuoteVersion>(
        `/api/v1/quotes/cases/${encodeURIComponent(caseId)}/versions`,
        {
          method: "POST",
          body: input,
          ifMatch: etag,
          idempotencyKey,
          signal
        }
      );
    },
    async getVersion(versionId, signal) {
      return http.request<QuoteVersion>(
        `/api/v1/quotes/versions/${encodeURIComponent(versionId)}`,
        { signal }
      );
    },
    async listApprovals(versionId, signal) {
      return http.request<{ items: readonly QuoteApproval[] }>(
        `/api/v1/quotes/versions/${encodeURIComponent(versionId)}/approvals`,
        { signal }
      );
    },
    async submitVersion(versionId, etag, idempotencyKey) {
      return http.request<QuoteApproval>(
        `/api/v1/quotes/versions/${encodeURIComponent(versionId)}/submit`,
        commandOptions(etag, idempotencyKey)
      );
    },
    async approveVersion(versionId, etag, idempotencyKey, reason) {
      return http.request<QuoteVersion>(
        `/api/v1/quotes/versions/${encodeURIComponent(versionId)}/approve`,
        { ...commandOptions(etag, idempotencyKey), body: { reason } }
      );
    },
    async rejectVersion(versionId, etag, idempotencyKey, reason) {
      return http.request<QuoteApproval>(
        `/api/v1/quotes/versions/${encodeURIComponent(versionId)}/reject`,
        { ...commandOptions(etag, idempotencyKey), body: { reason } }
      );
    },
    async getPublication(operationId, signal) {
      return http.request<QuotePublicationOperation>(
        `/api/v1/quotes/publication-operations/${encodeURIComponent(operationId)}`,
        { signal }
      );
    },
    async retryPublication(operationId, idempotencyKey) {
      return http.request<QuotePublicationOperation>(
        `/api/v1/quotes/publication-operations/${encodeURIComponent(operationId)}/retry`,
        { method: "POST", idempotencyKey }
      );
    }
  };
  return Object.freeze(api);
}
