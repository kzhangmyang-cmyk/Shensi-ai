import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountEnterpriseQuery } from './view';
test('detail renders supplied registry fields and separates expired LEI renewal from company status', async () => {
  const { window, document } = parseHTML('<html><body><main></main></body></html>');
  const before = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window, document });
  const prototype = window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, 'elements');
  Object.defineProperty(prototype, 'elements', { configurable: true, get() { return { namedItem: (name: string) => this.querySelector(`[name="${name}"]`) }; } });
  try {
    mountEnterpriseQuery(document.querySelector('main') as unknown as HTMLElement, { list: async () => [{ id: 'public', company: '测试企业', business: '', country: '郑州市', website: '', contact: '', contactInfo: '', description: '', status: 'public_record', lei: '8368000RB6Q4GK2V6211', registryNumber: '914101815686135204', registryAuthority: 'RA000092', postalCode: '451200', leiRegistrationStatus: 'LAPSED' }], join: async () => { throw new Error('must not write'); } });
    await new Promise(resolve => setImmediate(resolve));
    document.querySelector('[data-company]')!.dispatchEvent(new window.Event('click', { bubbles: true }));
    const detail = document.querySelector('.enterprise-query-detail')!;
    for (const value of ['914101815686135204', 'RA000092', '451200', '不代表企业注销']) assert.ok(detail.textContent?.includes(value));
    assert.equal(detail.querySelector('[data-join]')!.hasAttribute('disabled'), true);
  } finally { if (original) Object.defineProperty(prototype, 'elements', original); else delete (prototype as any).elements; Object.assign(globalThis, before); }
});
