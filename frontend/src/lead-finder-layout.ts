export type LeadFinderLayoutMode = "entry" | "results";

export interface LeadFinderIntentInput {
  goal: string;
  productKeywords: string;
  countries: string;
  industry: string;
  customerType: string;
}

function splitTerms(value: string) {
  return value
    .split(/,|，|\/|、/)
    .map((term) => term.trim())
    .filter(Boolean);
}

export function getLeadFinderLayoutMode(resultCount: number): LeadFinderLayoutMode {
  return Number.isFinite(resultCount) && resultCount > 0 ? "results" : "entry";
}

export function buildLeadFinderIntentChips(input: LeadFinderIntentInput): string[] {
  const structured = [
    ...splitTerms(input.countries),
    ...splitTerms(input.productKeywords),
    ...splitTerms(input.industry),
    ...splitTerms(input.customerType).slice(0, 1)
  ];
  const unique = structured.filter((term, index) => structured.indexOf(term) === index).slice(0, 5);
  if (unique.length) return unique;
  const goal = input.goal.trim();
  return goal ? [goal.length > 28 ? `${goal.slice(0, 28)}…` : goal] : [];
}
