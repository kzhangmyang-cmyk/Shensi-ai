import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnterpriseCapture } from '../src/shared/enterprise-browser.ts';
const card = { company: '测试企业', sourceUrl: 'https://aiqicha.baidu.com/company_detail_123', capital: '100万元', founded: '2020-01-01' };
const payload = () => ({ version: 1, sourceUrl: 'https://aiqicha.baidu.com/s?q=test', capturedAt: new Date().toISOString(), items: [card, card] });
test('validates a current-page capture and deduplicates source identities', () => {
  const result = validateEnterpriseCapture(payload());
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].company, '测试企业');
  assert.equal('cookie' in result, false);
});
test('rejects foreign domains, oversized lists, unknown fields and stale data', () => {
  assert.throws(() => validateEnterpriseCapture({ ...payload(), sourceUrl: 'https://evil.test/s' }));
  assert.throws(() => validateEnterpriseCapture({ ...payload(), items: Array(41).fill(card) }));
  assert.throws(() => validateEnterpriseCapture({ ...payload(), cookie: 'secret' }));
  assert.throws(() => validateEnterpriseCapture({ ...payload(), capturedAt: '2020-01-01T00:00:00Z' }));
  assert.throws(() => validateEnterpriseCapture({ ...payload(), items: [{ ...card, sourceUrl: 'https://aiqicha.baidu.com.evil.test/company_detail_123' }] }));
});
test('visible headings without public detail links retain distinct company names', () => {
  const result = validateEnterpriseCapture({ ...payload(), items: [{ company: '企业甲', sourceUrl: 'https://aiqicha.baidu.com/s' }, { company: '企业乙', sourceUrl: 'https://aiqicha.baidu.com/s' }] });
  assert.equal(result.items.length, 2);
});
