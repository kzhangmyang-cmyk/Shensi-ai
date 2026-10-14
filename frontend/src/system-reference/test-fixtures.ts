import type { components } from '../generated/system-reference';
export const systemCitationFixture: components['schemas']['SystemReference'] = {
  sourceType: 'system', sourceId: 'K2',
  queryGrantId: '11111111-1111-4111-8111-111111111111', referenceId: '22222222-2222-4222-8222-222222222222',
  corpusId: '33333333-3333-4333-8333-333333333333', releaseId: '44444444-4444-4444-8444-444444444444',
  referenceKey: 'system:44444444-4444-4444-8444-444444444444:22222222-2222-4222-8222-222222222222',
  sourceHash: 'a'.repeat(64), chunkHash: 'b'.repeat(64), excerpt: '合成预算参考', excerptRange: { start: 0, end: 6 },
  sourceLabel: '<img src=x>合成参考', locator: { page: 17, chapter: '预算方法' }, warnings: ['ocr_unverified', 'table_unverified']
};
export const connectionBeginFixture: components['schemas']['ConnectionBegin'] = {
  requestId: '55555555-5555-4555-8555-555555555555', displayCode: '01234567', expiresAt: '2099-10-08T00:05:00Z',
  approvalUrl: 'https://reference.example/reference-approval.html?requestId=55555555-5555-4555-8555-555555555555&displayCode=01234567'
};
