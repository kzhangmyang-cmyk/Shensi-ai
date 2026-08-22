import type { components } from "../../generated/growth-advisor-quote-roi";
import type {
  GrowthHttpClient,
  GrowthHttpResponse
} from "../http";
import type {
  GrowthAdvisorRecommendation,
  GrowthAdvisorRecommendationTransitionInput,
  GrowthAdvisorTodayQuery,
  GrowthAdvisorTodayResponse
} from "../contracts";

export type AdvisorRecommendation = GrowthAdvisorRecommendation;
export type AdvisorTodayQuery = GrowthAdvisorTodayQuery;
export type AdvisorTodayResponse = GrowthAdvisorTodayResponse;
export type AdvisorRecommendationTransitionInput =
  GrowthAdvisorRecommendationTransitionInput;
export type PriorityCustomerView =
  components["schemas"]["AdvisorTodayResponse_PriorityCustomerView"];
export type PendingQuoteApprovalView =
  components["schemas"]["AdvisorTodayResponse_PendingQuoteApprovalView"];
export type FinancialDataGapView =
  components["schemas"]["AdvisorTodayResponse_FinancialDataGapView"];

const recommendationCommandPath = {
  accept: (id: string) =>
    `/api/v1/acquisition/advisor/recommendations/${encodeURIComponent(id)}/accept`,
  ignore: (id: string) =>
    `/api/v1/acquisition/advisor/recommendations/${encodeURIComponent(id)}/ignore`,
  complete: (id: string) =>
    `/api/v1/acquisition/advisor/recommendations/${encodeURIComponent(id)}/complete`
} as const;

export function advisorTodayPath(query: AdvisorTodayQuery): string {
  const params = new URLSearchParams({
    currency: query.currency,
    asOf: query.asOf
  });
  return `/api/v1/acquisition/advisor/today?${params.toString()}`;
}

export interface AdvisorApi {
  getToday(
    query: AdvisorTodayQuery,
    signal?: AbortSignal
  ): Promise<GrowthHttpResponse<AdvisorTodayResponse>>;
  decideRecommendation(
    action: "accept" | "ignore" | "complete",
    id: string,
    input: AdvisorRecommendationTransitionInput,
    etag: string,
    idempotencyKey: string
  ): Promise<GrowthHttpResponse<AdvisorRecommendation>>;
}

export function createAdvisorApi(http: GrowthHttpClient): AdvisorApi {
  const api: AdvisorApi = {
    async getToday(query, signal) {
      return http.request<AdvisorTodayResponse>(
        advisorTodayPath(query),
        { signal }
      );
    },
    async decideRecommendation(action, id, input, etag, idempotencyKey) {
      return http.request<AdvisorRecommendation>(
        recommendationCommandPath[action](id),
        {
          method: "POST",
          body: input,
          ifMatch: etag,
          idempotencyKey
        }
      );
    }
  };
  return Object.freeze(api);
}
