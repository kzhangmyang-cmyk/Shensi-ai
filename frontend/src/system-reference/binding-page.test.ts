import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

const pending = { requestId: '11111111-1111-4111-8111-111111111111', displayCode: '01234567', expiresAt: '2099-10-08T00:05:00Z' };
async function mount() { const module = await import('./binding-page').catch(() => null); assert.ok(module, 'explicit approval page required'); return module.mountReferenceBindingApproval; }
const tick = () => new Promise(resolve => setImmediate(resolve));
test('central approval shows account and matching code, requires explicit confirmation and never auto-sends', async () => {
  const render = await mount(), { document } = parseHTML('<html><body><main></main></body></html>'); const host = document.querySelector('main')!;
  assert.ok(document.defaultView);
  const sent: unknown[] = [];
  const view = render(host, { pending, account: () => ({ subjectId: 'central-user', label: '<img src=x onerror=alert(1)>中央账号' }),
    approve: async (id, input) => { sent.push({ id, input }); } });
  assert.match(host.textContent!, /01234567/); assert.match(host.textContent!, /中央账号/); assert.equal(host.querySelector('img'), null);
  await tick(); assert.equal(sent.length, 0);
  const button = host.querySelector('button')!; assert.equal(button.disabled, true);
  const checkbox = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  checkbox.checked = true; checkbox.dispatchEvent(new document.defaultView.Event('change'));
  button.click(); await tick(); button.click(); await tick();
  assert.deepEqual(sent, [{ id: pending.requestId, input: { displayCode: '01234567' } }]);
  assert.match(host.textContent!, /已批准/); view.dispose();
});
test('central account change or disposal prevents approval or a late success from reviving the old account', async () => {
  const render = await mount(), { document } = parseHTML('<html><body><main></main></body></html>'); const host = document.querySelector('main')!;
  assert.ok(document.defaultView);
  let account = { subjectId: 'first', label: 'First' }, sent = 0; let complete!: () => void;
  const view = render(host, { pending, account: () => account, approve: async () => { sent++; await new Promise<void>(resolve => { complete = resolve; }); } });
  const checkbox = host.querySelector<HTMLInputElement>('input')!; checkbox.checked = true; checkbox.dispatchEvent(new document.defaultView.Event('change'));
  account = { subjectId: 'second', label: 'Second' }; host.querySelector('button')!.click(); await tick();
  assert.equal(sent, 0); assert.doesNotMatch(host.textContent!, /已批准/); view.dispose();
  const active = render(host, { pending, account: () => account, approve: async () => { sent++; await new Promise<void>(resolve => { complete = resolve; }); } });
  const next = host.querySelector<HTMLInputElement>('input')!; next.checked = true; next.dispatchEvent(new document.defaultView.Event('change'));
  host.querySelector('button')!.click(); await tick(); active.dispose(); complete(); await tick(); assert.equal(host.textContent, '');
});
