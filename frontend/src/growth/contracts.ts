import type {
  components,
  operations,
  paths
} from "../generated/growth-advisor-quote-roi.js";

export const GROWTH_CONTRACT_NAME = "growth-advisor-quote-roi";
export const GROWTH_CONTRACT_VERSION = "1.0.10";

export type GrowthPaths = paths;
export type GrowthOperations = operations;
export type GrowthComponents = components;

export type GrowthBootstrapResponse = Omit<
  components["schemas"]["GrowthBootstrapResponse"],
  "$defs"
>;
export type GrowthCatalogItem = components["schemas"]["CatalogItem"];
export type GrowthPackageVersion = components["schemas"]["PackageVersion"];
export type GrowthPricingPolicyVersion =
  components["schemas"]["PricingPolicyVersion"];
export type GrowthQuoteCase = components["schemas"]["QuoteCase"];
export type GrowthQuoteVersion = components["schemas"]["QuoteVersion"];
export type GrowthQuoteApproval = components["schemas"]["QuoteApproval"];
export type GrowthFinancialDataGapView =
  components["schemas"]["FinancialDataGapView"];
export type GrowthAdvisorTodayQuery =
  components["schemas"]["AdvisorTodayResponse_AdvisorTodayQuery"];
export type GrowthAdvisorTodayResponse =
  Omit<components["schemas"]["AdvisorTodayResponse"], "$defs">;
export type GrowthAdvisorRecommendation =
  Omit<components["schemas"]["AdvisorRecommendation"], "$defs">;
export type GrowthAdvisorRecommendationTransitionInput =
  components["schemas"]["AdvisorRecommendationTransitionInput"];
export type GrowthAdvisorRecommendedAction =
  components["schemas"]["AdvisorRecommendation_AdvisorRecommendedAction"];

export type FinancialCouncilRun = Omit<
  components["schemas"]["FinancialCouncilRun"],
  "$defs"
>;
export type FinancialCouncilRunEvent =
  components["schemas"]["FinancialCouncilRunEvent"];
export type FinancialCouncilRunEventPagedResult =
  components["schemas"]["FinancialCouncilRunEventPagedResult"];
export type FinancialCouncilRunEventPage =
  FinancialCouncilRunEventPagedResult;
export type FinancialCouncilPolicyInput =
  components["schemas"]["FinancialCouncilPolicyInput"];
export type FinancialCouncilPolicyVersion =
  components["schemas"]["FinancialCouncilPolicyVersion"];
export type FinancialCouncilPolicy = FinancialCouncilPolicyVersion;
export type FinancialCouncilPortfolioRevisionInput =
  components["schemas"]["FinancialCouncilPortfolioRevisionInput"];
export type FinancialCouncilPortfolioRevision =
  components["schemas"]["FinancialCouncilPortfolioRevision"];
export type FinancialCouncilApproval =
  components["schemas"]["FinancialCouncilApproval"];
export type FinancialCouncilDispatchView =
  components["schemas"]["FinancialCouncilDispatchView"];
export type FinancialCouncilDispatchPagedResult =
  components["schemas"]["FinancialCouncilDispatchPagedResult"];
export type FinancialCouncilDispatchPage =
  FinancialCouncilDispatchPagedResult;
export type FinancialCouncilCandidateAction =
  components["schemas"]["CandidateAction"];
export type FinancialCouncilActionPortfolio =
  components["schemas"]["ActionPortfolio"];

export type GetAdvisorTodayOperation =
  operations["getAdvisorToday"];
export type AcceptAdvisorRecommendationOperation =
  operations["acceptAdvisorRecommendation"];
export type IgnoreAdvisorRecommendationOperation =
  operations["ignoreAdvisorRecommendation"];
export type CompleteAdvisorRecommendationOperation =
  operations["completeAdvisorRecommendation"];
export type CreateFinancialCouncilRunOperation =
  operations["createFinancialCouncilRun"];
export type GetFinancialCouncilRunOperation =
  operations["getFinancialCouncilRun"];
export type ListFinancialCouncilRunEventsOperation =
  operations["listFinancialCouncilRunEvents"];
export type GetFinancialCouncilPolicyOperation =
  operations["getFinancialCouncilPolicy"];
export type UpdateFinancialCouncilPolicyOperation =
  operations["updateFinancialCouncilPolicy"];
export type CreateFinancialCouncilPortfolioRevisionOperation =
  operations["createFinancialCouncilPortfolioRevision"];
export type ApproveFinancialCouncilPortfolioRevisionOperation =
  operations["approveFinancialCouncilPortfolioRevision"];
export type RejectFinancialCouncilRunOperation =
  operations["rejectFinancialCouncilRun"];
export type ListFinancialCouncilDispatchesOperation =
  operations["listFinancialCouncilDispatches"];
