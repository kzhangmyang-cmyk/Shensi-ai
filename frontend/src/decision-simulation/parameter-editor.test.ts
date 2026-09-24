import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { mountParameterEditor } from './parameter-editor';

test('Chinese receivable editor updates exact minor units without dropping advanced row fields', () => {
  const { document, window } = parseHTML('<main></main>');
  const host = document.querySelector('main')!;
  let raw = JSON.stringify([{ dueMonth: 2, amountMinor: 12345, extra: { note: '保留高级字段' } }]);
  mountParameterEditor(host, 'receivables', () => raw, value => { raw = value; });
  const amount = host.querySelector<HTMLInputElement>('[data-parameter="amountMinor"]')!;
  assert.equal(amount.value, '123.45');
  amount.value = '0.29'; amount.dispatchEvent(new window.Event('change'));
  assert.deepEqual(JSON.parse(raw), [{ dueMonth: 2, amountMinor: 29, extra: { note: '保留高级字段' } }]);
  amount.value = '1.234'; amount.dispatchEvent(new window.Event('change'));
  assert.equal(JSON.parse(raw)[0].amountMinor, 29, 'invalid fractional cents must not round silently');
  assert.match(host.textContent!, /两位小数/);
});

test('payable rows can be added and removed while malformed advanced JSON remains untouched', () => {
  const { document } = parseHTML('<main></main>'); const host = document.querySelector('main')!;
  let raw = '[]'; const panel = mountParameterEditor(host, 'payables', () => raw, value => { raw = value; });
  host.querySelector<HTMLButtonElement>('[data-parameter-add]')!.click();
  assert.deepEqual(JSON.parse(raw), [{ dueMonth: 1, amountMinor: 0 }]);
  host.querySelector<HTMLButtonElement>('[data-parameter-remove]')!.click(); assert.equal(raw, '[]');
  raw = '{ broken'; panel.sync();
  host.querySelector<HTMLButtonElement>('[data-parameter-add]')!.click();
  assert.equal(raw, '{ broken'); assert.ok(host.querySelector('[role=status]')!.textContent);
});

test('alternative editor preserves exact multipliers and only changes the selected plan field', () => {
  const { document, window } = parseHTML('<main></main>'); const host = document.querySelector('main')!;
  let raw = JSON.stringify([{ id: '扩容', demandMultiplier: 1.123456, capacityMultiplier: 1.3, priceMultiplier: 1,
    costMultiplier: 0.97, extraFixedCostMinor: 50000, extension: { unchanged: true } }]);
  mountParameterEditor(host, 'alternatives', () => raw, value => { raw = value; });
  const demand = host.querySelector<HTMLInputElement>('[data-parameter="demandMultiplier"]')!;
  assert.equal(demand.value, '1.123456');
  demand.value = '1.25'; demand.dispatchEvent(new window.Event('change'));
  assert.deepEqual(JSON.parse(raw)[0], { id: '扩容', demandMultiplier: 1.25, capacityMultiplier: 1.3, priceMultiplier: 1,
    costMultiplier: 0.97, extraFixedCostMinor: 50000, extension: { unchanged: true } });
  const cost = host.querySelector<HTMLInputElement>('[data-parameter="extraFixedCostMinor"]')!;
  assert.equal(cost.value, '500');
  host.querySelector<HTMLButtonElement>('[data-parameter-add]')!.click();
  host.querySelector<HTMLButtonElement>('[data-parameter-add]')!.click();
  host.querySelector<HTMLButtonElement>('[data-parameter-add]')!.click();
  assert.equal(JSON.parse(raw).length, 3, 'at most three alternative plans');
});

test('Chinese fluctuation controls retain event assumptions and advanced parameters', () => {
  const { document, window } = parseHTML('<main></main>'); const host = document.querySelector('main')!;
  const events = [{ template: 'sales_gain', probability: 0.2, assumption: '原事件' }];
  let raw = JSON.stringify({ seed: 7, samples: 100, months: 12, assumptions: { demand: [0.85, 1.15], procurement: [0.9, 1.1],
    collectionDelay: [0, 1], delivery: [0.85, 1], persistence: 0.4, commonWeight: 0.2, extension: 9 }, events, future: { keep: true } });
  mountParameterEditor(host, 'options', () => raw, value => { raw = value; });
  const demand = host.querySelector<HTMLInputElement>('[data-parameter="assumptions.demand.1"]')!;
  assert.equal(demand.value, '1.15'); demand.value = '1.234567'; demand.dispatchEvent(new window.Event('change'));
  const actual = JSON.parse(raw);
  assert.deepEqual(actual.assumptions.demand, [0.85, 1.234567]);
  assert.deepEqual(actual.events, events); assert.deepEqual(actual.future, { keep: true }); assert.equal(actual.assumptions.extension, 9);
  const delay = host.querySelector<HTMLInputElement>('[data-parameter="assumptions.collectionDelay.1"]')!;
  delay.value = '1.5'; delay.dispatchEvent(new window.Event('change'));
  assert.deepEqual(JSON.parse(raw).assumptions.collectionDelay, [0, 1]);
});

test('invalid visible input blocks form submission even if another field is valid', () => {
  const { document, window } = parseHTML('<main></main>'); const host = document.querySelector('main')!;
  let raw = '[{"dueMonth":1,"amountMinor":100}]';
  const editor = mountParameterEditor(host, 'receivables', () => raw, value => { raw = value; });
  const amount = host.querySelector<HTMLInputElement>('[data-parameter=amountMinor]')!;
  amount.value = '1.234'; amount.dispatchEvent(new window.Event('change'));
  const month = host.querySelector<HTMLInputElement>('[data-parameter=dueMonth]')!;
  month.value = '2'; month.dispatchEvent(new window.Event('change'));
  assert.equal(editor.validate(), false);
  amount.value = '1.23'; assert.equal(editor.validate(), true);
  assert.deepEqual(JSON.parse(raw), [{ dueMonth: 2, amountMinor: 123 }]);
});
