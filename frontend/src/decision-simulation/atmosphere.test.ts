import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { mountDecisionAtmosphere } from './atmosphere';

test('cosmic decoration stops for user preference, hidden page, inactive view and disposal', () => {
  const { document, window } = parseHTML('<html><body><main><header class="decision-hero"></header></main></body></html>');
  const root = document.querySelector('main')!;
  Object.defineProperty(root, 'getBoundingClientRect', { value: () => ({ width: 1200, height: 800 }) });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  const controller = mountDecisionAtmosphere(root);
  assert.equal(root.dataset.atmosphere, 'running');
  document.querySelector<HTMLButtonElement>('[data-atmosphere-toggle]')!.click();
  assert.equal(root.dataset.atmosphere, 'paused');
  document.querySelector<HTMLButtonElement>('[data-atmosphere-toggle]')!.click();
  controller.setActive(false); assert.equal(root.dataset.atmosphere, 'paused');
  controller.setActive(true); assert.equal(root.dataset.atmosphere, 'running');
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new window.Event('visibilitychange')); assert.equal(root.dataset.atmosphere, 'paused');
  controller.dispose(); controller.setActive(true); assert.equal(root.dataset.atmosphere, 'paused');
});
