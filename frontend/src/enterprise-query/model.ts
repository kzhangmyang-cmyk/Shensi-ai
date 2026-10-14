import type { components } from "../generated/ai-acquisition";
import { matchesIndustry } from './industry';
import { matchesRegion } from './regions';
export type Enterprise = components["schemas"]["EnterpriseQueryRecord"] & {
  size?: string; founded?: string; creditCode?: string; capital?: string; operatingStatus?: string;
};
export type Filters = { keyword: string; region: string; industry: string; size: string };
export function filterEnterprises(items: Enterprise[], filters: Filters): Enterprise[] {
  const includes = (value: string, query: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  return items.filter(item => item.status !== "excluded"
    && includes([item.company, item.business, item.description].join(" "), filters.keyword)
    && (!filters.region || (/^\d{2,6}$/.test(filters.region) ? matchesRegion(item.country,filters.region) : item.country.trim() === filters.region))
    && (!filters.industry || (/^(?:[A-T]|\d{2,4})$/.test(filters.industry) ? matchesIndustry(item.business, filters.industry) : includes(item.business, filters.industry)))
    // The source does not provide staff size. Never infer a size from company name.
    && (!filters.size || item.size === filters.size));
}
