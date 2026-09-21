import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { exposeCfoRealtimeApi } from '../src/preload/cfo-realtime-api.ts';
import { registerCfoRealtimeIpc } from '../src/main/cfo-realtime-ipc.ts';
import { CfoRealtimeService } from '../src/main/cfo-realtime-service.ts';
import { createCfoRealtimeSettingsStore } from '../src/main/cfo-realtime-settings.ts';
import type { CfoRealtimeBridge } from '../src/shared/cfo-realtime.ts';

test('real Preload, IPC, service and encrypted store preserve distinct app/provider workspace fields', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cfo-config-flow-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = randomBytes(32);
  const store = createCfoRealtimeSettingsStore({ directory: join(directory, 'settings'), safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString(text) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', secret, iv);
      const ciphertext = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]); },
    decryptString(bytes) { const cipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(); }
  } });
  const service = new CfoRealtimeService({ store, connect: async () => { assert.fail('save must never call the provider'); },
    ask: async () => { assert.fail('save must never call a business model'); }, emit() {} });
  let handler!: (event: any, value: unknown) => Promise<any>;
  const sender = { mainFrame: { url: 'http://127.0.0.1:5555/#agents' }, isDestroyed: () => false };
  const scope = { actorId: 'fixture-actor', workspaceId: 'shensi-workspace-42' };
  const ipc = registerCfoRealtimeIpc({ service, localOrigin: 'http://127.0.0.1:5555', authorizedSender: () => sender,
    authorize: async workspaceId => { assert.equal(workspaceId, scope.workspaceId); return scope; }, openHelp: async () => {},
    ipcMain: { handle: (_channel, fn) => { handler = fn; }, removeHandler() {} } }); t.after(() => ipc.dispose());
  let api!: CfoRealtimeBridge;
  exposeCfoRealtimeApi({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value as CfoRealtimeBridge; } },
    ipcRenderer: { invoke: async (_channel, value) => structuredClone(await handler({ sender, senderFrame: sender.mainFrame }, structuredClone(value))),
      on() {}, removeListener() {} } });
  const form = { apiKey: 'sk-fixture-isolated-not-a-real-key', workspaceId: 'fixture-bailian-space' };
  const saved = await api.save(scope.workspaceId, form);
  assert.equal(saved.state, 'saved'); assert.equal(saved.workspaceId, form.workspaceId);
  assert.equal(saved.model, 'qwen3.5-omni-flash-realtime'); assert.equal(Object.hasOwn(saved, 'apiKey'), false);
  assert.equal((await store.load(scope))?.apiKey, form.apiKey);
  assert.equal(await store.load({ ...scope, workspaceId: form.workspaceId }), null);
  await assert.rejects(api.save(scope.workspaceId, { ...form, apiKey: '' }), /^Error: voice_key_invalid$/);
  await assert.rejects(api.save(scope.workspaceId, { ...form, workspaceId: 'https://wrong.test' }), /^Error: voice_workspace_invalid$/);
  const publicOnly = await api.save(scope.workspaceId, { ...form, workspaceId: '' });
  assert.equal(publicOnly.state, 'saved'); assert.equal(publicOnly.workspaceId, '');
  assert.equal((await store.load(scope))?.apiKey, form.apiKey);
  assert.equal((await api.settings(scope.workspaceId)).state, 'saved');
});

test('real Preload and IPC preserve document, explicit verified and legacy voice sources', async t => {
  const scope = { actorId: 'fixture-actor', workspaceId: 'fixture-workspace' };
  const sender = { mainFrame: { url: 'http://127.0.0.1:5555/#agents' }, isDestroyed: () => false };
  const starts: unknown[][] = [];
  let handler!: (event: any, value: unknown) => Promise<any>;
  const ipc = registerCfoRealtimeIpc({ localOrigin: 'http://127.0.0.1:5555', authorizedSender: () => sender,
    authorize: async workspaceId => { assert.equal(workspaceId, scope.workspaceId); return scope; }, openHelp: async () => {},
    service: { activeScope: null, start(...args: unknown[]) { starts.push(args); return { state: 'connected' }; }, stop() {}, dispose() {} } as any,
    ipcMain: { handle: (_channel, fn) => { handler = fn; }, removeHandler() {} } });
  t.after(() => ipc.dispose());
  let api!: CfoRealtimeBridge;
  exposeCfoRealtimeApi({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value as CfoRealtimeBridge; } },
    ipcRenderer: { invoke: async (_channel, value) => handler({ sender, senderFrame: sender.mainFrame }, structuredClone(value)),
      on() {}, removeListener() {} } });
  await api.start(scope.workspaceId, [], 'document-original');
  await api.start(scope.workspaceId, [], null);
  await api.start(scope.workspaceId, []);
  assert.deepEqual(starts, [[scope, [], 'document-original'], [scope, [], null], [scope, [], undefined]]);
});
