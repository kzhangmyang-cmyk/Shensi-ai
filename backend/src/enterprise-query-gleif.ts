import { z } from "zod";

const record = z.object({ id: z.string().regex(/^[A-Z0-9]{20}$/), attributes: z.object({
  entity: z.object({ legalName: z.object({ name: z.string() }), status: z.string(),
    registeredAs: z.string().nullable().optional(), registeredAt: z.object({ id: z.string().nullable().optional() }).optional(),
    creationDate: z.string().nullable().optional(), legalAddress: z.object({
      country: z.string(), city: z.string(), addressLines: z.array(z.string()), postalCode: z.string().nullable().optional()
    }) }), registration: z.object({ lastUpdateDate: z.string(), status: z.string().optional() })
}) });
const responseSchema = z.object({ data: z.array(record).max(10), meta: z.object({
  goldenCopy: z.object({ publishDate: z.string() }),
  pagination: z.object({ total: z.number().int().nonnegative(), currentPage: z.number().int().positive() })
}) });
export const enterpriseQueryInput = z.object({ keyword: z.string().trim().min(2).max(100),
  page: z.coerce.number().int().min(1).max(1000).default(1) });

export async function searchGleif(input: z.infer<typeof enterpriseQueryInput>, fetcher: typeof fetch = fetch) {
  const { keyword, page } = enterpriseQueryInput.parse(input);
  const url = new URL("https://api.gleif.org/api/v1/lei-records");
  url.searchParams.set("filter[entity.legalName]", keyword);
  url.searchParams.set("filter[entity.legalAddress.country]", "CN");
  url.searchParams.set("page[number]", String(page)); url.searchParams.set("page[size]", "10");
  const response = await fetcher(url, { signal: AbortSignal.timeout(10000), redirect: "error", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(response.status === 429 ? "GLEIF_RATE_LIMIT" : "GLEIF_UNAVAILABLE");
  const parsed = responseSchema.parse(await response.json());
  const seen = new Set<string>();
  const items = parsed.data.filter(item => !seen.has(item.id) && Boolean(seen.add(item.id))).map(({ id, attributes: a }) => ({
    id: `gleif:${id}`, lei: id, company: a.entity.legalName.name, business: "", country: a.entity.legalAddress.city || "中国",
    website: "", contact: "", contactInfo: "", description: "", status: "public_record",
    address: a.entity.legalAddress.addressLines.join("，"), founded: a.entity.creationDate?.slice(0,10) || "",
    registryNumber: a.entity.registeredAs || '', registryAuthority: a.entity.registeredAt?.id || '',
    postalCode: a.entity.legalAddress.postalCode || '', leiRegistrationStatus: a.registration.status || '',
    operatingStatus: a.entity.status === "ACTIVE" ? "活跃（LEI实体状态）" : a.entity.status,
    sourceLabel: "GLEIF · 中国LEI登记企业 · CC0", sourceUpdatedAt: a.registration.lastUpdateDate
  }));
  return { items, total: parsed.meta.pagination.total, page: parsed.meta.pagination.currentPage, updatedAt: parsed.meta.goldenCopy.publishDate };
}
