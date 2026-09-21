import assert from 'node:assert/strict';
import test from 'node:test';
test('voice IPC denies foreign frames, rejects extra fields and derives scope from authenticated authority', async () => {
  const module = await import('../src/main/cfo-realtime-ipc.ts').catch(() => null);
  assert.ok(module, 'scoped realtime IPC must exist');
  let handler!: (event: any, value: any) => Promise<any>; const calls: any[] = [];
  const sender = { mainFrame: { url: 'http://127.0.0.1:5400/#agents' }, isDestroyed: () => false };
  const scope = { actorId: 'verified-user', workspaceId: 'verified-workspace' };
  const service = { settings: async (value: any) => { calls.push(value); return { state: 'saved' }; }, stop() {}, dispose() {}, activeScope: null };
  const ipc = module.registerCfoRealtimeIpc({ localOrigin: 'http://127.0.0.1:5400', service: service as any,
    authorizedSender: () => sender, authorize: async requested => {
      if (requested !== scope.workspaceId) throw new Error('voice_permission_denied'); return scope;
    }, openHelp: async () => {}, ipcMain: { handle: (_c, h) => { handler = h; }, removeHandler() {} } });
  const event = { sender, senderFrame: sender.mainFrame };
  await handler(event, { action: 'settings', workspaceId: scope.workspaceId });
  assert.deepEqual(calls, [scope]);
  await assert.rejects(handler(event, { action: 'settings', workspaceId: 'other' }), /voice_permission_denied/);
  await assert.rejects(handler(event, { action: 'settings', workspaceId: scope.workspaceId, apiKey: 'leak' }), /voice_input_invalid/);
  await assert.rejects(handler({ sender, senderFrame: { url: sender.mainFrame.url } }, { action: 'stop' }), /voice_sender_invalid/);
  sender.mainFrame.url = 'https://outside.test';
  await assert.rejects(handler(event, { action: 'settings', workspaceId: scope.workspaceId }), /voice_sender_invalid/);
  ipc.dispose();
});
test('Main authority uses the current app session and finance permission before exposing local settings', async () => {
  const { createCfoVoiceAuthority } = await import('../src/main/cfo-realtime-authority.ts');
  const calls: { url: string; init: any }[] = [];
  let loggedIn = true; let permitted = true; let materialExpired = false;
  const authority = createCfoVoiceAuthority({ localOrigin: 'http://127.0.0.1:5400', session: () => ({
    cookies: { get: async () => [{ name: 'gj_csrf', value: 'fixture-csrf' }] },
    fetch: async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ user: { id: 'actor-one' } }), { status: loggedIn ? 200 : 401 });
      if (url.endsWith('/council-agent-center')) return new Response(JSON.stringify({ capabilities: { canRun: permitted } }), { status: permitted ? 200 : 403 });
      if (materialExpired) return new Response(JSON.stringify({ code: 'finance_document_expired' }), { status: 409 });
      return new Response(JSON.stringify({ answer: '缺少报表', model: 'business-text-model', material: null }));
    }
  }) });
  assert.deepEqual(await authority.authorize('ws-one'), { workspaceId: 'ws-one', actorId: 'actor-one' });
  permitted = false; await assert.rejects(authority.authorize('ws-two'), /voice_permission_denied/);
  permitted = true; loggedIn = false; await assert.rejects(authority.authorize('ws-one'), /voice_auth_required/);
  loggedIn = true;
  await assert.rejects(authority.ask({ workspaceId: 'ws-one', actorId: 'different-user' }, { question: 'test', history: [] }, new AbortController().signal), /voice_auth_required/);
  const input = { question: '报表呢', history: [], documentId: 'document-original' };
  const answer = await authority.ask({ workspaceId: 'ws-one', actorId: 'actor-one' }, input, new AbortController().signal);
  assert.equal(answer.model, 'business-text-model');
  const post = calls.find(call => call.init.method === 'POST')!;
  assert.equal(post.init.headers['X-Workspace-Id'], 'ws-one'); assert.equal(post.init.headers['x-csrf-token'], 'fixture-csrf');
  assert.deepEqual(JSON.parse(post.init.body), input);
  materialExpired = true;
  await assert.rejects(authority.ask({ workspaceId: 'ws-one', actorId: 'actor-one' }, input, new AbortController().signal), /voice_material_unavailable/);
  assert.equal(calls.some(call => !call.url.startsWith('http://127.0.0.1:5400/api/')), false);
});
test('stop fences an earlier start still waiting for authentication', async () => {
  const { registerCfoRealtimeIpc } = await import('../src/main/cfo-realtime-ipc.ts');
  let handler!: (event: any, value: any) => Promise<any>; let authorize!: (value: any) => void; let started = 0;
  const sender = { mainFrame: { url: 'http://127.0.0.1:5400' }, isDestroyed: () => false };
  const ipc = registerCfoRealtimeIpc({ localOrigin: sender.mainFrame.url, authorizedSender: () => sender,
    authorize: async () => new Promise(r => { authorize = r; }), openHelp: async () => {},
    service: { activeScope: null, start() { started++; }, stop() {}, dispose() {} } as any,
    ipcMain: { handle: (_channel, value) => { handler = value; }, removeHandler() {} } });
  const event = { sender, senderFrame: sender.mainFrame };
  const pending = handler(event, { action: 'start', workspaceId: 'ws', history: [] });
  await handler(event, { action: 'stop' }); authorize({ actorId: 'actor', workspaceId: 'ws' });
  await assert.rejects(pending, /voice_not_ready/); assert.equal(started, 0); ipc.dispose();
});

test('voice IPC carries only the explicit source ID', async t => {
  const { registerCfoRealtimeIpc } = await import('../src/main/cfo-realtime-ipc.ts');
  let handler!: (event: any, value: any) => Promise<any>; const starts: unknown[][] = [];
  const sender = { mainFrame: { url: 'http://127.0.0.1:5400' }, isDestroyed: () => false };
  const scope = { actorId: 'actor', workspaceId: 'ws' };
  const ipc = registerCfoRealtimeIpc({ localOrigin: sender.mainFrame.url, authorizedSender: () => sender,
    authorize: async () => scope, openHelp: async () => {},
    service: { activeScope: null, start(...args: unknown[]) { starts.push(args); }, stop() {}, dispose() {} } as any,
    ipcMain: { handle: (_channel, value) => { handler = value; }, removeHandler() {} } });
  t.after(() => ipc.dispose()); const event = { sender, senderFrame: sender.mainFrame };
  await handler(event, { action: 'start', workspaceId: 'ws', history: [], documentId: 'document-original' });
  assert.deepEqual(starts, [[scope, [], 'document-original']]);
  await assert.rejects(handler(event, { action: 'start', workspaceId: 'ws', history: [], documentId: '' }), /voice_input_invalid/);
  await assert.rejects(handler(event, { action: 'start', workspaceId: 'ws', history: [], documentId: 'doc', cells: [] }), /voice_input_invalid/);
});
