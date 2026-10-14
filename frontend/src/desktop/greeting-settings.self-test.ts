import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountGreetingSettings } from './greeting-settings';
import type { GreetingPreferences } from '../../../desktop/src/shared/cfo-voice';

export async function runGreetingSettingsTests() {
  const { document } = parseHTML(`<html><body data-session-workspace-id="workspace-1"><main>
    <input type="checkbox" data-greeting-enabled><button data-greeting-voice="male"></button>
    <button data-greeting-voice="female"></button><button data-greeting-preview></button>
    <input type="checkbox" data-greeting-random><button data-greeting-save></button>
    <span data-greeting-enabled-label></span>
    <span data-greeting-preference-status></span></main></body></html>`);
  const calls: unknown[] = [];
  const bridge = {
    status: async () => ({ muted: false, speaking: false, voice: 'female' as const, random: true }),
    setPreferences: async (preferences: GreetingPreferences) => { calls.push(['save', preferences]); return { ...preferences, speaking: false }; },
    preview: async (...args: [string, GreetingPreferences?]) => { calls.push(['preview', ...args]); return { muted: false, speaking: false, voice: 'male' as const, random: false }; },
    greet: async () => ({ muted: false, speaking: false, voice: 'female' as const, random: true }),
    stop: async () => ({ muted: false, speaking: false, voice: 'female' as const, random: true }),
    setMuted: async () => ({ muted: false, speaking: false, voice: 'female' as const, random: true })
  };
  const mounted = mountGreetingSettings(document.querySelector('main')!, bridge);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.querySelector<HTMLInputElement>('[data-greeting-enabled]')!.checked, true);
  assert.equal(document.querySelector('[data-greeting-enabled-label]')?.textContent, '已开启');
  assert.equal(document.querySelector('[data-greeting-voice=female]')!.getAttribute('aria-pressed'), 'true');
  const enabled = document.querySelector<HTMLInputElement>('[data-greeting-enabled]')!;
  enabled.checked = false;
  enabled.dispatchEvent(new document.defaultView!.Event('change'));
  assert.equal(document.querySelector('[data-greeting-enabled-label]')?.textContent, '已关闭');
  enabled.checked = true;
  enabled.dispatchEvent(new document.defaultView!.Event('change'));
  document.querySelector<HTMLButtonElement>('[data-greeting-voice=male]')!.click();
  document.querySelector<HTMLInputElement>('[data-greeting-random]')!.checked = false;
  document.querySelector<HTMLButtonElement>('[data-greeting-preview]')!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls[0], ['preview', 'workspace-1', { muted: false, voice: 'male', random: false }]);
  assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'save'), false,
    'preview must not persist an unsaved voice selection');
  document.querySelector<HTMLButtonElement>('[data-greeting-save]')!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls[1], ['save', { muted: false, voice: 'male', random: false }]);
  mounted.dispose();

  const pendingDom = parseHTML(`<html><body data-session-workspace-id="workspace-a"><main>
    <input type="checkbox" data-greeting-enabled><button data-greeting-voice="male"></button>
    <button data-greeting-voice="female"></button><button data-greeting-preview></button>
    <input type="checkbox" data-greeting-random><button data-greeting-save></button>
    <span data-greeting-preference-status></span></main></body></html>`).document;
  let releasePreview!: () => void; let stops = 0; const pendingCalls: unknown[] = [];
  const pending = mountGreetingSettings(pendingDom.querySelector('main')!, {
    status: async () => ({ muted: false, speaking: false, voice: 'female', random: false }),
    preview: async (...args: [string, GreetingPreferences?]) => { pendingCalls.push(args); await new Promise<void>(resolve => { releasePreview = resolve; }); return { muted: false, speaking: false, voice: 'female', random: false }; },
    greet: async () => ({ muted: false, speaking: false, voice: 'female', random: false }),
    stop: async () => { stops++; return { muted: false, speaking: false, voice: 'female', random: false }; },
    setMuted: async () => ({ muted: false, speaking: false, voice: 'female', random: false }),
    setPreferences: async value => ({ ...value, speaking: false })
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  pendingDom.querySelector<HTMLButtonElement>('[data-greeting-preview]')!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  pending.dispose(); pendingDom.body.dataset.sessionWorkspaceId = 'workspace-b'; releasePreview();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(pendingCalls, [['workspace-a', { muted: false, voice: 'female', random: false }]],
    'a preview must retain the workspace and draft captured at click time');
  assert.equal(stops, 1, 'disposing an in-flight preview must stop its output');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGreetingSettingsTests().then(() => console.log('greeting-settings self-test passed'));
}
