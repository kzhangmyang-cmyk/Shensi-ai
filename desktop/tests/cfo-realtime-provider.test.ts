import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';

test('realtime detection requires session acknowledgement, configures audio/tools and sends no audio automatically', async t => {
  const module = await import('../src/main/cfo-realtime-provider.ts').catch(() => null);
  assert.ok(module, 'official realtime transport must exist');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server.once('listening', r));
  t.after(() => { for (const c of server.clients) c.terminate(); server.close(); });
  const received: any[] = []; let peer!: WebSocket; let connected = false;
  server.on('connection', socket => { peer = socket;
    socket.on('message', bytes => received.push(JSON.parse(bytes.toString())));
    socket.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture-session' } })); });
  const abort = new AbortController();
  const pending = module.openQwenRealtime({ apiKey: 'fixture-secret', workspaceId: 'llm-fixture' }, [], () => {}, abort.signal, {
    socket: (url, apiKey) => {
      assert.equal(url, 'wss://llm-fixture.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-flash-realtime');
      return new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    }
  }).then(p => { connected = true; return p; });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(connected, false); assert.equal(received.length, 1);
  const config = received[0];
  assert.equal(config.type, 'session.update');
  assert.equal(config.session.audio.input.format.sample_rate, 16000);
  assert.equal(config.session.audio.output.format.sample_rate, 24000);
  assert.equal(config.session.turn_detection.type, 'semantic_vad');
  assert.equal(config.session.tools[0].function.name, 'ask_cfo');
  assert.equal(config.session.tool_choice, undefined);
  peer.send(JSON.stringify({ type: 'session.updated', session: config.session }));
  const port = await pending;
  assert.equal(connected, true); assert.equal(received.length, 1);
  port.send({ type: 'response.cancel' }); port.close();
  await new Promise(r => setTimeout(r, 30));
  assert.ok(received.some(m => m.type === 'response.cancel'));
  assert.ok(!received.some(m => m.type === 'input_audio_buffer.append'));
});

test('provider timeout and untrusted provider error never reveal the credential or raw exception', async t => {
  const { openQwenRealtime } = await import('../src/main/cfo-realtime-provider.ts');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server.once('listening', r));
  t.after(() => { for (const c of server.clients) c.terminate(); server.close(); });
  const socket = () => new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const settings = { apiKey: 'never-echo-this-key', workspaceId: 'llm-fixture' };
  await assert.rejects(openQwenRealtime(settings, [], () => {}, new AbortController().signal,
    { socket, timeoutMs: 30 }), /^Error: voice_network_failed$/);
  server.on('connection', ws => ws.send(JSON.stringify({ type: 'error', error: { code: 'InvalidApiKey', message: settings.apiKey } })));
  await assert.rejects(openQwenRealtime(settings, [], () => {}, new AbortController().signal,
    { socket, timeoutMs: 500 }), /^Error: voice_credentials_failed$/);
});
test('a mismatched audio acknowledgement cannot pass the connection check', async t => {
  const { openQwenRealtime } = await import('../src/main/cfo-realtime-provider.ts');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { for (const peer of server.clients) peer.terminate(); server.close(); });
  server.on('connection', peer => {
    peer.send(JSON.stringify({ type: 'session.created' }));
    peer.on('message', bytes => { const { session } = JSON.parse(bytes.toString());
      session.audio.output.format.type = 'wav'; peer.send(JSON.stringify({ type: 'session.updated', session })); });
  });
  await assert.rejects(openQwenRealtime({ apiKey: 'fixture-key', workspaceId: 'fixture-workspace' }, [], () => {}, new AbortController().signal,
    { socket: () => new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`) }), /^Error: voice_protocol_failed$/);
});

test('failed realtime handshakes expose only closed stage diagnostics, never provider text or credentials', async t => {
  const { openQwenRealtime } = await import('../src/main/cfo-realtime-provider.ts');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { for (const peer of server.clients) peer.terminate(); server.close(); });
  const diagnostics: unknown[] = [];
  server.on('connection', peer => {
    peer.send(JSON.stringify({ type: 'session.created' }));
    peer.once('message', () => peer.send(JSON.stringify({ type: 'error', error: {
      code: 'invalid_value', param: 'session.modalities', message: 'never-echo-fixture-key-or-space'
    } })));
  });
  await assert.rejects(openQwenRealtime({ apiKey: 'never-echo-fixture-key-or-space', workspaceId: 'fixture-space' }, [], () => {}, new AbortController().signal, {
    socket: () => new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`),
    onDiagnostic: value => diagnostics.push(value)
  }), /^Error: voice_protocol_failed$/);
  assert.deepEqual(diagnostics, [{ stage: 'session_update_sent', reason: 'provider_error', providerCode: 'invalidvalue',
    parameter: 'session.modalities', messageKind: 'other' }]);
});

test('HTTP handshake rejection retains the safe provider category without logging the response body', async t => {
  const { openQwenRealtime } = await import('../src/main/cfo-realtime-provider.ts');
  const server = createServer((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'ModelNotFound', message: 'model not found: private-fixture-space-and-key' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const diagnostics: unknown[] = [];
  await assert.rejects(openQwenRealtime({ apiKey: 'private-fixture-space-and-key', workspaceId: 'fixture-space' }, [], () => {}, new AbortController().signal, {
    socket: () => new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`),
    onDiagnostic: value => diagnostics.push(value)
  }), /^Error: voice_protocol_failed$/);
  assert.deepEqual(diagnostics, [{ stage: 'websocket_connecting', reason: 'http_rejected', httpStatus: 400,
    providerCode: 'modelnotfound', parameter: 'other', messageKind: 'model_unavailable',
    contentType: 'json', responseFormat: 'json', sourceServer: 'other', viaPresent: false,
    errorCode: 'ModelNotFound', detail: 'model not found: [redacted]' }]);
});

test('HTML gateway rejection is distinguishable without leaking echoed private values or URLs', async t => {
  const { openQwenRealtime } = await import('../src/main/cfo-realtime-provider.ts');
  const apiKey = 'sk-fixture-private-secret'; const workspaceId = 'fixture-private-space';
  const server = createServer((_req, res) => {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', server: 'Tengine', via: 'private-gateway.test' });
    res.end(`<html><head><style>secret-style</style></head><body><h1>400 Bad Request</h1>
      <p>The plain HTTP request was sent to HTTPS port.</p><p>${apiKey} ${workspaceId}</p>
      <p>https://${workspaceId}.example.test/path?key=${apiKey}</p><p>RequestId: eab34cb5-9550-4edc-922a-fcdb09037fe4</p>
      <script>secret-script</script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const diagnostics: any[] = [];
  await assert.rejects(openQwenRealtime({ apiKey, workspaceId }, [], () => {}, new AbortController().signal, {
    socket: () => new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`), onDiagnostic: value => diagnostics.push(value)
  }), /^Error: voice_protocol_failed$/);
  assert.equal(diagnostics[0].contentType, 'html'); assert.equal(diagnostics[0].responseFormat, 'html');
  assert.equal(diagnostics[0].sourceServer, 'tengine'); assert.equal(diagnostics[0].viaPresent, true);
  assert.match(diagnostics[0].detail, /plain HTTP request was sent to HTTPS port/);
  for (const forbidden of [apiKey, workspaceId, 'https://', 'private-gateway.test', 'eab34cb5', 'secret-script', 'secret-style'])
    assert.ok(!JSON.stringify(diagnostics).includes(forbidden));
});

test('official Beijing DashScope comparison keeps the same model and Bearer credential without opening audio', async t => {
  const { openQwenRealtime } = await import('../src/main/cfo-realtime-provider.ts');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { for (const peer of server.clients) peer.terminate(); server.close(); });
  const messages: any[] = [];
  server.on('connection', peer => {
    peer.send(JSON.stringify({ type: 'session.created' }));
    peer.on('message', bytes => { const event = JSON.parse(bytes.toString()); messages.push(event);
      peer.send(JSON.stringify({ type: 'session.updated', session: event.session })); });
  });
  const port = await openQwenRealtime({ apiKey: 'fixture-key', workspaceId: 'fixture-space' }, [], () => {}, new AbortController().signal, {
    endpoint: 'dashscope', socket: (url, key) => {
      assert.equal(url, 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-flash-realtime');
      assert.equal(key, 'fixture-key');
      return new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }
  });
  port.close(); assert.equal(messages.length, 1); assert.equal(messages[0].type, 'session.update');
});
