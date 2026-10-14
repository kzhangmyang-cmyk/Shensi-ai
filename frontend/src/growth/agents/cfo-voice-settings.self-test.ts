import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountCfoVoiceSettings } from './cfo-voice-settings';
import type { CfoRealtimeBridge, VoiceSettingsView } from '../../../../desktop/src/shared/cfo-realtime';

export async function runCfoVoiceSettingsTests() {
  const { document } = parseHTML('<html><body><main></main></body></html>');
  const host = document.querySelector('main')!;
  let state: VoiceSettingsView = { state: 'not_configured', configured: false, workspaceId: '', model: 'qwen3.5-omni-flash-realtime', region: 'cn-beijing', checkedAt: null };
  const calls: any[] = [];
  const bridge: CfoRealtimeBridge = { start: async () => ({ sessionId: 'fixture' }), audio: async () => {}, played: async () => {}, stop: async () => {}, onEvent: () => () => {}, settings: async () => state, save: async (scope, input) => {
    calls.push({ scope, input: { ...input } }); state = { ...state, configured: true, workspaceId: input.workspaceId, state: 'saved' }; return state;
  }, check: async () => { calls.push('check'); return state = { ...state, state: 'credentials_failed' }; },
  remove: async () => state = { ...state, configured: false, workspaceId: '', state: 'not_configured' },
  help: async () => {} };
  const view = mountCfoVoiceSettings({ host, workspace: () => 'shensi-ws', scope: () => 'shensi-ws:actor', bridge });
  const tick = () => new Promise(r => setTimeout(r, 0));
  host.querySelector<HTMLButtonElement>('[data-voice-settings]')!.click(); await tick();
  const key = host.querySelector<HTMLInputElement>('[name=apiKey]')!;
  assert.equal(key.type, 'password'); assert.equal(key.value, '');
  assert.equal(host.querySelector('[name=workspaceId]')!.hasAttribute('required'), false,
    'the supported public endpoint must not require a workspace hostname');
  assert.match(host.textContent!, /实时语音服务配置/); assert.match(host.textContent!, /百炼业务空间 ID/);
  host.querySelector<HTMLInputElement>('[name=workspaceId]')!.value = '';
  key.value = 'fixture-key-not-a-real-secret';
  host.querySelector('form')!.dispatchEvent(new document.defaultView!.Event('submit', { cancelable: true })); await tick();
  assert.equal(calls[0].scope, 'shensi-ws'); assert.equal(calls[0].input.apiKey, 'fixture-key-not-a-real-secret');
  assert.equal(calls[0].input.workspaceId, '', 'saving only the Key must reach the authorized bridge');
  assert.equal(key.value, ''); assert.match(host.textContent!, /已保存，尚未检测/);
  assert.doesNotMatch(host.innerHTML, /fixture-key-not-a-real-secret/); assert.equal(calls.length, 1);
  host.querySelector<HTMLButtonElement>('[data-voice-check]')!.click(); await tick();
  assert.match(host.textContent!, /API Key 无效/); assert.equal(calls[1], 'check');
  host.querySelector<HTMLButtonElement>('[data-voice-remove]')!.click(); await tick();
  assert.match(host.textContent!, /尚未配置/);
  key.value = 'fixture-key-not-a-real-secret'; workspaceInput().value = 'https://not-a-workspace.example';
  const count = calls.length;
  host.querySelector('form')!.dispatchEvent(new document.defaultView!.Event('submit', { cancelable: true })); await tick();
  assert.equal(calls.length, count); assert.match(host.textContent!, /业务空间 ID 格式/);
  assert.equal(key.value, 'fixture-key-not-a-real-secret', 'invalid workspace must not wipe the masked Key');
  workspaceInput().value = 'fixture-workspace'; bridge.save = async () => { throw new Error('voice_storage_unavailable'); };
  host.querySelector('form')!.dispatchEvent(new document.defaultView!.Event('submit', { cancelable: true })); await tick();
  assert.equal(key.value, 'fixture-key-not-a-real-secret', 'storage failure must preserve the local masked input');
  host.querySelector<HTMLButtonElement>('[data-voice-close]')!.click(); assert.equal(key.value, ''); view.dispose();
  function workspaceInput() { return host.querySelector<HTMLInputElement>('[name=workspaceId]')!; }
}
