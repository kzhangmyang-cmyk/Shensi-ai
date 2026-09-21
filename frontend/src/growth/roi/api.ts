import type { components } from "../../generated/growth-advisor-quote-roi";
import type {
  GrowthHttpClient,
  GrowthHttpResponse
} from "../http";

export type GrowthPerformanceQuery =
  components["schemas"]["GrowthPerformanceResponse_GrowthPerformanceQuery"];
export type GrowthPerformanceResponse = Omit<
  components["schemas"]["GrowthPerformanceResponse"],
  "$defs"
>;
export type ExpectedRoiCurrencyView =
  components["schemas"]["GrowthPerformanceResponse_ExpectedRoiCurrencyView"];
export type ActualRoiCurrencyView =
  components["schemas"]["GrowthPerformanceResponse_ActualRoiCurrencyView"];
export type CashCurrencyView =
  components["schemas"]["GrowthPerformanceResponse_CashCurrencyView"];
export type RoiCoverageSnapshot =
  components["schemas"]["GrowthPerformanceResponse_RoiCoverageSnapshot"];
export type RoiGapCode =
  components["schemas"]["GrowthPerformanceResponse_RoiGapCode"];
export type AcquisitionCohort = Omit<
  components["schemas"]["AcquisitionCohort"],
  "$defs"
>;

export interface RoiQueryFilters {
  cohortId: string;
  currency: string;
  asOf: string;
  planId?: string | null;
  closureVersionId?: string | null;
}

export function growthPerformancePath(query: RoiQueryFilters): string {
  const params = new URLSearchParams({
    cohortId: query.cohortId,
    currency: query.currency,
    asOf: query.asOf
  });
  if (query.planId) params.set("planId", query.planId);
  if (query.closureVersionId) {
    params.set("closureVersionId", query.closureVersionId);
  }
  return `/api/v1/acquisition/growth-performance?${params.toString()}`;
}

export interface GrowthPerformanceApi {
  getGrowthPerformance(
    query: RoiQueryFilters,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<GrowthPerformanceResponse>>;
  listCohorts(
    query: { limit: number; cursor?: string; signal?: AbortSignal }
  ): Promise<GrowthHttpResponse<{ items: readonly AcquisitionCohort[] }>>;
}

export function createGrowthPerformanceApi(
  http: GrowthHttpClient
): GrowthPerformanceApi {
  const api: GrowthPerformanceApi = {
    async getGrowthPerformance(query, signal) {
      return http.request<GrowthPerformanceResponse>(
        growthPerformancePath(query),
        { signal }
      );
    },
    async listCohorts(query) {
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.cursor) params.set("cursor", query.cursor);
      return http.request<{ items: readonly AcquisitionCohort[] }>(
        `/api/v1/acquisition/cohorts?${params}`,
        { signal: query.signal }
      );
    }
  };
  return Object.freeze(api);
}
