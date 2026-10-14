import assert from "node:assert/strict";
import test from "node:test";
import { enterpriseQueryInput, searchGleif } from "./enterprise-query-gleif.js";
const item = { id: "12345678901234567890", attributes: { entity: {
  legalName: { name: "公开测试企业" }, status: "ACTIVE", creationDate: "2010-01-02T00:00:00Z",
  legalAddress: { country: "CN", city: "上海", addressLines: ["公开登记地址"] }
}, registration: { lastUpdateDate: "2026-09-01T00:00:00Z" } } };
test("GLEIF uses fixed official origin, China filter, upstream pagination and LEI deduplication", async () => {
  const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, "https://api.gleif.org");
    assert.equal(parsed.searchParams.get("filter[entity.legalAddress.country]"), "CN");
    assert.equal(parsed.searchParams.get("page[number]"), "2");
    assert.equal(parsed.searchParams.get("page[size]"), "10");
    assert.equal(init?.redirect, "error");
    return Response.json({ data: [item, item], meta: { goldenCopy: { publishDate: "2026-09-14T00:00:00Z" }, pagination: { total: 21, currentPage: 2 } } });
  }) as typeof fetch;
  const result = await searchGleif({ keyword: "测试", page: 2 }, fetcher);
  assert.equal(result.items.length, 1); assert.equal(result.total, 21); assert.equal(result.page, 2);
  assert.equal(result.items[0].sourceUpdatedAt, "2026-09-01T00:00:00Z");
  assert.equal(result.items[0].contactInfo, ""); assert.equal(result.items[0].founded, "2010-01-02");
  assert.equal("tenantProspectId" in result.items[0], false);
});
test("invalid input, rate limits, malformed data and empty results remain distinct", async () => {
  assert.equal(enterpriseQueryInput.safeParse({ keyword: "a", page: 0 }).success, false);
  await assert.rejects(searchGleif({ keyword: "测试", page: 1 }, async () => new Response("", { status: 429 })), /GLEIF_RATE_LIMIT/);
  await assert.rejects(searchGleif({ keyword: "测试", page: 1 }, async () => Response.json({ data: [] })));
  const empty = await searchGleif({ keyword: "测试", page: 1 }, async () => Response.json({ data: [], meta: { goldenCopy: { publishDate: "2026-09-14" }, pagination: { total: 0, currentPage: 1 } } }));
  assert.deepEqual(empty.items, []); assert.equal(empty.total, 0);
});
test('registry identifiers and LEI renewal status are retained without inventing commercial fields', async () => {
  const source = structuredClone(item) as any;
  source.attributes.entity.registeredAs = '914101815686135204';
  source.attributes.entity.registeredAt = { id: 'RA000092' };
  source.attributes.entity.legalAddress.postalCode = '451200';
  source.attributes.registration.status = 'LAPSED';
  const result = await searchGleif({ keyword: '测试', page: 1 }, async () => Response.json({ data: [source], meta: { goldenCopy: { publishDate: '2026-09-14' }, pagination: { total: 1, currentPage: 1 } } }));
  assert.equal((result.items[0] as any).registryNumber, '914101815686135204');
  assert.equal((result.items[0] as any).registryAuthority, 'RA000092');
  assert.equal((result.items[0] as any).postalCode, '451200');
  assert.equal((result.items[0] as any).leiRegistrationStatus, 'LAPSED');
  assert.equal(result.items[0].contactInfo, '');
  assert.equal('capital' in result.items[0], false);
});
