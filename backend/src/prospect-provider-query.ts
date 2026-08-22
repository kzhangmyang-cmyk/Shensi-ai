import type { LeadQuery } from "./provider-contract.js";
import type {
  ProspectRunShard,
  ProspectSearchRun
} from "./types.js";

function joined(values: readonly string[]) {
  return values.map((item) => item.trim()).filter(Boolean).join(", ");
}

/**
 * Builds the provider request from the immutable run snapshot. AI search uses
 * acceptedCount=0 because its one-shot prompt is bound to the child job before
 * execution and must remain byte-identical across retries.
 */
export function buildProspectProviderLeadQuery(
  run: ProspectSearchRun,
  shard: ProspectRunShard,
  acceptedCount: number
): LeadQuery {
  const querySnapshot = run.executionSnapshot.resolvedQuery;
  const remaining = Math.max(
    1,
    shard.resultLimit - Math.max(0, acceptedCount)
  );
  return {
    goal: [
      run.executionSnapshot.campaign.name,
      joined(querySnapshot.purchaseScenarioTerms)
    ].filter(Boolean).join("；"),
    productKeywords: joined([
      ...querySnapshot.positiveKeywords,
      ...querySnapshot.synonyms
    ]),
    countries: joined(querySnapshot.countries),
    industry: joined(querySnapshot.industryTerms),
    customerType: joined(querySnapshot.customerTypes),
    excludeKeywords: joined(querySnapshot.exclusionKeywords),
    limit: Math.min(30, remaining)
  };
}
