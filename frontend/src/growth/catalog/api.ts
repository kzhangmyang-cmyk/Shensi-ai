import type { components } from "../../generated/growth-advisor-quote-roi";
import type {
  GrowthHttpClient,
  GrowthHttpRequestOptions,
  GrowthHttpResponse
} from "../http";

export type CatalogItem = Omit<
  components["schemas"]["CatalogItem"],
  "$defs"
>;
export type CatalogItemPagedResult = Omit<
  components["schemas"]["CatalogItemPagedResult"],
  "$defs"
>;
export type PackageVersion = Omit<
  components["schemas"]["PackageVersion"],
  "$defs"
>;
export type PackageVersionPagedResult = Omit<
  components["schemas"]["PackageVersionPagedResult"],
  "$defs"
>;
export type PricingPolicyVersion = Omit<
  components["schemas"]["PricingPolicyVersion"],
  "$defs"
>;
export type PricingPolicyVersionPagedResult = Omit<
  components["schemas"]["PricingPolicyVersionPagedResult"],
  "$defs"
>;

export interface CatalogListQuery {
  limit: number;
  cursor?: string;
  status?: "active" | "retired";
  signal?: AbortSignal;
}

export interface CatalogApi {
  listItems(query: CatalogListQuery): Promise<GrowthHttpResponse<CatalogItemPagedResult>>;
  getItem(id: string, signal?: AbortSignal): Promise<GrowthHttpResponse<CatalogItem>>;
  listPackageVersions(
    itemId: string,
    query: { limit: number; cursor?: string; signal?: AbortSignal }
  ): Promise<GrowthHttpResponse<PackageVersionPagedResult>>;
  listPricingPolicies(
    query: { limit: number; cursor?: string; signal?: AbortSignal }
  ): Promise<GrowthHttpResponse<PricingPolicyVersionPagedResult>>;
  updateItem(
    id: string,
    etag: string,
    input: { name?: string; description?: string | null; unit?: string },
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<CatalogItem>>;
  updatePackageVersion(
    id: string,
    etag: string,
    input: { name?: string; description?: string | null },
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<PackageVersion>>;
  activatePackageVersion(
    id: string,
    etag: string,
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<PackageVersion>>;
  retirePackageVersion(
    id: string,
    etag: string,
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<PackageVersion>>;
  activatePricingPolicy(
    id: string,
    etag: string,
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<PricingPolicyVersion>>;
  retirePricingPolicy(
    id: string,
    etag: string,
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<PricingPolicyVersion>>;
}

function commandOptions(
  etag: string,
  idempotencyKey: string
): GrowthHttpRequestOptions {
  return { method: "POST", ifMatch: etag, idempotencyKey };
}

export function createCatalogApi(http: GrowthHttpClient): CatalogApi {
  const api: CatalogApi = {
    async listItems(query) {
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.status) params.set("status", query.status);
      return http.request<CatalogItemPagedResult>(
        `/api/v1/catalog/items?${params}`,
        { signal: query.signal }
      );
    },
    async getItem(id, signal) {
      return http.request<CatalogItem>(
        `/api/v1/catalog/items/${encodeURIComponent(id)}`,
        { signal }
      );
    },
    async listPackageVersions(itemId, query) {
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.cursor) params.set("cursor", query.cursor);
      return http.request<PackageVersionPagedResult>(
        `/api/v1/catalog/packages/${encodeURIComponent(itemId)}/versions?${params}`,
        { signal: query.signal }
      );
    },
    async listPricingPolicies(query) {
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.cursor) params.set("cursor", query.cursor);
      return http.request<PricingPolicyVersionPagedResult>(
        `/api/v1/catalog/pricing-policies?${params}`,
        { signal: query.signal }
      );
    },
    async updateItem(id, etag, input, idempotencyKey) {
      return http.request<CatalogItem>(
        `/api/v1/catalog/items/${encodeURIComponent(id)}`,
        { method: "PATCH", ifMatch: etag, idempotencyKey, body: input }
      );
    },
    async updatePackageVersion(id, etag, input, idempotencyKey) {
      return http.request<PackageVersion>(
        `/api/v1/catalog/package-versions/${encodeURIComponent(id)}`,
        { method: "PATCH", ifMatch: etag, idempotencyKey, body: input }
      );
    },
    async activatePackageVersion(id, etag, idempotencyKey) {
      return http.request<PackageVersion>(
        `/api/v1/catalog/package-versions/${encodeURIComponent(id)}/activate`,
        commandOptions(etag, idempotencyKey)
      );
    },
    async retirePackageVersion(id, etag, idempotencyKey) {
      return http.request<PackageVersion>(
        `/api/v1/catalog/package-versions/${encodeURIComponent(id)}/retire`,
        commandOptions(etag, idempotencyKey)
      );
    },
    async activatePricingPolicy(id, etag, idempotencyKey) {
      return http.request<PricingPolicyVersion>(
        `/api/v1/catalog/pricing-policies/${encodeURIComponent(id)}/activate`,
        commandOptions(etag, idempotencyKey)
      );
    },
    async retirePricingPolicy(id, etag, idempotencyKey) {
      return http.request<PricingPolicyVersion>(
        `/api/v1/catalog/pricing-policies/${encodeURIComponent(id)}/retire`,
        commandOptions(etag, idempotencyKey)
      );
    }
  };
  return Object.freeze(api);
}
