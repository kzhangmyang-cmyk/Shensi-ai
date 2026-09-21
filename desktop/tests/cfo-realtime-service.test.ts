import assert from 'node:assert/strict';
import test from 'node:test';

async function fixture(ask?: (signal: AbortSignal) => Promise<{ answer: string; model: string }>) {
  const module = await import('../src/main/cfo-realtime-service.ts').catch(() => null);
  assert.ok(module, 'voice configuration and session service must exist');
  const records = new Map<string, any>(); const events: any[] = []; const sent: any[] = []; const tools: any[] = []; const diagnostics: any[] = [];
  const connections: { receive: (e: any) => void; closed: boolean; history: any[] }[] = [];
  const service = new module.CfoRealtimeService({
    store: { load: async scope => records.get(JSON.stringify(scope)) ?? null,
      save: async (scope, value) => { records.set(JSON.stringify(scope), value); }, remove: async scope => { records.delete(JSON.stringify(scope)); } },
    connect: async (_settings, history, receive, signal) => {
      const entry = { receive, history, closed: false }; connections.push(entry);
      signal.addEventListener('abort', () => { entry.closed = true; });
      return { send: event => sent.push(event), close: () => { entry.closed = true; } };
    },
    ask: async (scope, input, signal) => { tools.push({ scope, input, signal }); return ask ? ask(signal) : { answer: '需要本期利润表，暂无数据不能计算。', model: 'original-business-model' }; },
    emit: event => events.push(event), diagnostic: value => diagnostics.push(value)
  });
  const scope = { workspaceId: 'ws', actorId: 'user' };
  return { service, scope, events, sent, tools, connections, diagnostics };
}

test('voice freezes the selected document ID and never accepts a provider-selected source', async t => {
  const { service, scope, connections, tools } = await fixture(); t.after(() => service.dispose());
  await service.save(scope, { apiKey: 'isolated-test-key', workspaceId: '' }); await service.check(scope);
  await service.start(scope, [], 'document-original');
  const peer = connections.at(-1)!;
  peer.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u', transcript: '解释原表收入成本' });
  assert.equal(tools[0]?.input.documentId, 'document-original');
  service.stop();
  await assert.rejects(service.start(scope, [], { documentId: 'other' }), /voice_input_invalid/);
  await service.start(scope, [], null);
  connections.at(-1)!.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u2', transcript: '读已确认报表' });
  assert.equal(tools.at(-1)?.input.documentId, null);
});

test('ASR starts one business computation before provider completion; later tool calls reuse it without opening audio early', async t => {
  const { service, scope, connections, events, sent, tools } = await fixture(); t.after(() => service.dispose());
  await service.save(scope, { apiKey: 'isolated-test-key', workspaceId: '' }); await service.check(scope);
  await service.start(scope, []); const peer = connections.at(-1)!;
  peer.receive({ type: 'response.created', response: { id: 'routing' } });
  peer.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u', transcript: '利润为什么不等于现金？' });
  assert.equal(tools.length, 1, 'business work must not wait for response.done');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(sent.some(e => e.type === 'response.create' || e.type === 'session.update'), false);
  peer.receive({ type: 'response.function_call_arguments.done', call_id: 'call1', name: 'ask_cfo', arguments: '{"question":"比较利润与现金"}' });
  peer.receive({ type: 'response.audio.delta', response_id: 'routing', delta: 'AAA=' });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(tools.length, 1); assert.equal(tools[0].input.question, '利润为什么不等于现金？');
  assert.equal(events.some(e => e.type === 'audio'), false);
  assert.equal(sent.some(e => e.type === 'conversation.item.create'), false);
  peer.receive({ type: 'response.done', response: { id: 'routing' } });
  assert.equal(sent.filter(e => e.type === 'conversation.item.create').length, 1);
});

test('interrupting speculative business work aborts it and drops its late result before a fresh turn', async t => {
  let resolve!: (value: { answer: string; model: string }) => void;
  const { service, scope, connections, events, sent, tools } = await fixture(() => new Promise(r => { resolve = r; }));
  t.after(() => service.dispose());
  await service.save(scope, { apiKey: 'isolated-test-key', workspaceId: '' }); await service.check(scope);
  await service.start(scope, []); const peer = connections.at(-1)!;
  peer.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u', transcript: '经营现金流呢？' });
  assert.equal(tools.length, 1);
  peer.receive({ type: 'input_audio_buffer.speech_started' });
  assert.equal(tools[0].signal.aborted, true);
  resolve({ answer: '不能泄漏到下一轮', model: 'fixture' }); await new Promise(r => setTimeout(r, 0));
  assert.equal(events.some(e => e.type === 'business'), false);
  assert.equal(sent.some(e => e.type === 'response.create'), false);
  connections.at(-1)!.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u2', transcript: '先看收入' });
  assert.equal(tools.length, 2);
});

test('controlled timing overlaps one-second provider routing with three-second business work', async t => {
  let now = 0; t.mock.method(Date, 'now', () => now);
  let resolve!: (value: { answer: string; model: string }) => void;
  const { service, scope, connections, sent, diagnostics } = await fixture(() => new Promise(r => { resolve = r; }));
  t.after(() => service.dispose());
  await service.save(scope, { apiKey: 'isolated-test-key', workspaceId: '' }); await service.check(scope);
  await service.start(scope, []); const peer = connections.at(-1)!;
  peer.receive({ type: 'input_audio_buffer.speech_stopped' });
  peer.receive({ type: 'response.created', response: { id: 'routing' } });
  peer.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u', transcript: '利润与现金的差别' });
  now = 1000; peer.receive({ type: 'response.done', response: { id: 'routing' } });
  assert.equal(sent.some(e => e.type === 'session.update'), false);
  now = 3000; resolve({ answer: '先核对现金流明细。', model: 'fixture' });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(diagnostics.find(e => e.stage === 'tool_started').elapsedMs, 0);
  assert.equal(diagnostics.find(e => e.stage === 'tool_completed').elapsedMs, 3000);
  assert.equal(diagnostics.filter(e => e.stage === 'tool_started').length, 1);
  assert.equal(sent.filter(e => e.type === 'session.update').length, 1);
  // Eligible at 3000ms instead of the former 1000 + 3000ms sequence.
  // This is a controlled scheduling regression, not a provider speed promise.
});

test('authorized transcript deltas stream once before playback, with per-stage timing and interruption isolation', async t => {
  const { service, scope, connections, events, sent, diagnostics } = await fixture(); t.after(() => service.dispose());
  await service.save(scope, { apiKey: 'isolated-test-key', workspaceId: '' }); await service.check(scope);
  const { sessionId } = await service.start(scope, []); const peer = connections.at(-1)!;
  peer.receive({ type: 'input_audio_buffer.speech_stopped' });
  peer.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u', transcript: '现金不等于利润吗？' });
  peer.receive({ type: 'response.created', response: { id: 'raw' } });
  peer.receive({ type: 'response.audio_transcript.delta', response_id: 'raw', event_id: 'untrusted', delta: '伪造数据' });
  assert.equal(events.some(e => e.type === 'transcript'), false);
  peer.receive({ type: 'response.done', response: { id: 'raw', status: 'completed' } });
  await new Promise(r => setTimeout(r, 0));
  peer.receive({ type: 'session.updated', session: sent.filter(e => e.type === 'session.update').at(-1).session });
  peer.receive({ type: 'response.created', response: { id: 'approved' } });
  const fragment = { type: 'response.audio_transcript.delta', response_id: 'approved', event_id: 'delta-1', delta: '需要' };
  peer.receive(fragment); peer.receive(fragment);
  peer.receive({ ...fragment, event_id: 'delta-2', delta: '利润表。' });
  assert.deepEqual(events.filter(e => e.type === 'transcript').map(e => e.text), ['需要', '需要利润表。']);
  assert.equal(events.some(e => e.type === 'response_done'), false);
  peer.receive({ type: 'response.audio.delta', response_id: 'approved', delta: Buffer.alloc(480).toString('base64') });
  service.played(sessionId, 'approved', 5, false);
  for (const stage of ['speech_stopped', 'input_transcribed', 'tool_started', 'tool_completed', 'controlled_reply_acknowledged', 'reply_audio_started', 'playback_started']) {
    const entry = diagnostics.find(e => e.stage === stage); assert.ok(entry, stage);
    assert.equal(typeof entry.elapsedMs, 'number'); assert.ok(entry.elapsedMs >= 0);
  }
  assert.doesNotMatch(JSON.stringify(diagnostics), /现金|利润表|delta-1|approved|isolated-test/);
  peer.receive({ type: 'input_audio_buffer.speech_started' }); await new Promise(r => setTimeout(r, 0));
  assert.ok(connections.at(-1)!.history.every((h: any) => h.role !== 'assistant'));
  peer.receive({ ...fragment, event_id: 'late', delta: '迟到' });
  assert.equal(events.filter(e => e.type === 'transcript').length, 2);
});
test('saving stays unverified, check makes ready, replacement invalidates and stop is bounded', async () => {
  const { service, scope, connections } = await fixture();
  assert.equal((await service.settings(scope)).state, 'not_configured');
  const saved = await service.save(scope, { apiKey: 'isolated-test-key', workspaceId: 'llm-test' });
  assert.equal(saved.state, 'saved'); assert.equal(JSON.stringify(saved).includes('isolated-test-key'), false);
  assert.equal(connections.length, 0);
  await assert.rejects(service.start(scope, []), /voice_not_ready/);
  assert.equal((await service.check(scope)).state, 'ready'); assert.equal(connections[0].closed, true);
  const { sessionId } = await service.start(scope, []); assert.ok(sessionId);
  await service.save(scope, { apiKey: 'replacement-key', workspaceId: 'llm-test' });
  assert.equal(connections[1].closed, true); assert.equal((await service.settings(scope)).state, 'saved');
  await service.remove(scope); assert.equal((await service.settings(scope)).state, 'not_configured');
});
test('only the controlled business tool enables audio; only completed playback becomes text history', async () => {
  const { service, scope, events, sent, tools, connections } = await fixture();
  await service.save(scope, { apiKey: 'isolated-test-key', workspaceId: 'llm-test' }); await service.check(scope);
  const { sessionId } = await service.start(scope, []); const peer = connections.at(-1)!;
  peer.receive({ type: 'response.created', response: { id: 'raw' } });
  peer.receive({ type: 'response.audio.delta', response_id: 'raw', delta: 'AAA=' });
  assert.equal(events.filter(e => e.type === 'audio').length, 0);
  peer.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '今年利润是多少？' });
  peer.receive({ type: 'response.function_call_arguments.done', response_id: 'raw', call_id: 'call1', name: 'ask_cfo', arguments: '{"question":"今年利润是多少？"}' });
  peer.receive({ type: 'response.done', response: { id: 'raw' } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(tools.length, 1); assert.deepEqual(tools[0].scope, scope);
  assert.equal(sent.find(e => e.type === 'conversation.item.create').item.type, 'function_call_output');
  peer.receive({ type: 'response.created', response: { id: 'approved' } });
  peer.receive({ type: 'response.audio.delta', response_id: 'approved', delta: Buffer.alloc(480).toString('base64') });
  peer.receive({ type: 'response.audio_transcript.done', response_id: 'approved', transcript: '需要本期利润表。' });
  peer.receive({ type: 'response.done', response: { id: 'approved' } });
  assert.equal(events.filter(e => e.type === 'audio').length, 1);
  service.played(sessionId, 'approved', 10, true);
  peer.receive({ type: 'input_audio_buffer.speech_started' });
  // Fully played output is reusable; generation text alone was never enough.
  peer.receive({ type: 'response.created', response: { id: 'next' } });
  peer.receive({ type: 'response.function_call_arguments.done', call_id: 'call2', name: 'ask_cfo', arguments: '{"question":"要哪一期？"}' });
  peer.receive({ type: 'response.done', response: { id: 'next' } });
  await new Promise(r => setTimeout(r, 0));
  assert.ok(tools[1].input.history.some((h: any) => h.role === 'assistant' && h.text === '需要本期利润表。'));
  service.stop(); assert.equal(peer.closed, true);
  assert.throws(() => service.audio(sessionId, 'AAA='), /voice_not_ready/);
});
test('interruption cancels tools, closes stale context, drops unplayed words, and ignores late audio', async () => {
  const { service, scope, connections, events } = await fixture();
  await service.save(scope, { apiKey: 'isolated-test-key', workspaceId: 'llm-test' }); await service.check(scope);
  const { sessionId } = await service.start(scope, []); const peer = connections.at(-1)!;
  peer.receive({ type: 'response.created', response: { id: 'r1' } });
  peer.receive({ type: 'input_audio_buffer.speech_started' });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(peer.closed, true); assert.equal(connections.length, 3);
  assert.deepEqual(connections.at(-1)!.history, []);
  peer.receive({ type: 'response.audio.delta', response_id: 'r1', delta: 'AAA=' });
  assert.equal(events.filter(e => e.type === 'audio').length, 0);
  assert.throws(() => service.audio('wrong-session', 'AAA='), /voice_not_ready/);
  assert.throws(() => service.audio(sessionId, 'not-base64'), /voice_input_invalid/);
  service.stop(); assert.equal(connections.at(-1)!.closed, true);
});
test('replacement during a pending credential read cannot certify a stale Key', async () => {
  const { CfoRealtimeService } = await import('../src/main/cfo-realtime-service.ts');
  let resolve!: (value: any) => void; let reading = true; let connected = 0;
  let saved = { apiKey: 'old-fixture-key', workspaceId: 'llm-fixture' };
  const old = { ...saved };
  const service = new CfoRealtimeService({ store: {
    load: async () => reading ? new Promise(r => { resolve = r; }) : { ...saved },
    save: async (_scope, value) => { saved = value as typeof saved; }, remove: async () => {}
  }, connect: async () => { connected++; return { send() {}, close() {} }; }, ask: async () => ({ answer: '', model: '' }), emit() {} });
  const scope = { workspaceId: 'shensi', actorId: 'actor' };
  const checking = service.check(scope); reading = false;
  await service.save(scope, { apiKey: 'new-fixture-key', workspaceId: 'llm-fixture' });
  resolve(old); await checking;
  assert.equal(connected, 0); assert.equal((await service.settings(scope)).state, 'saved'); service.dispose();
});

test('standalone spoken greetings recover without an autonomous tool call, and repeat turns remain independent', async t => {
  const { service, scope, connections, events, sent, tools } = await fixture(); t.after(() => service.dispose());
  await service.save(scope, { apiKey: 'isolated-test-key', workspaceId: '' }); await service.check(scope);
  const { sessionId } = await service.start(scope, []); const peer = connections.at(-1)!;
  for (const n of [1, 2]) {
    peer.receive({ type: 'input_audio_buffer.speech_started' });
    peer.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: `hello-${n}`, transcript: '你好啊。' });
    peer.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: `hello-${n}`, transcript: '你好啊。' });
    peer.receive({ type: 'response.created', response: { id: `raw-${n}` } });
    peer.receive({ type: 'response.audio.delta', response_id: `raw-${n}`, delta: 'AAA=' });
    peer.receive({ type: 'response.done', response: { id: `raw-${n}`, status: 'completed' } });
    await new Promise(r => setTimeout(r, 0));
    assert.equal(events.some(e => e.code === 'voice_tool_required'), false, 'a greeting must not be rejected for skipping a tool');
    const update = sent.filter(e => e.type === 'session.update').at(-1);
    assert.ok(update, 'the controlled greeting is submitted for voice rendering');
    assert.match(update.session.instructions, /你好，有什么可以帮你/); assert.deepEqual(update.session.tools, []);
    const creates = sent.filter(e => e.type === 'response.create').length;
    peer.receive({ type: 'session.updated', session: { instructions: 'stale instructions', tools: [] } });
    assert.equal(sent.filter(e => e.type === 'response.create').length, creates);
    peer.receive({ type: 'session.updated', session: update.session });
    assert.equal(sent.filter(e => e.type === 'response.create').length, creates + 1);
    peer.receive({ type: 'response.created', response: { id: `greeting-${n}` } });
    peer.receive({ type: 'response.audio.delta', response_id: `greeting-${n}`, delta: Buffer.alloc(480).toString('base64') });
    peer.receive({ type: 'response.audio_transcript.done', response_id: `greeting-${n}`, transcript: '你好，有什么可以帮你？' });
    peer.receive({ type: 'response.done', response: { id: `greeting-${n}`, status: 'completed' } });
    service.played(sessionId, `greeting-${n}`, 10, true);
  }
  assert.equal(tools.length, 0); assert.equal(events.filter(e => e.type === 'user').length, 2);
  assert.equal(events.filter(e => e.type === 'audio').length, 2);
  assert.equal(events.filter(e => e.type === 'response_done' && e.text.includes('你好')).length, 2);
});

test('business and contextual follow-ups without tool calls still use the authenticated original business model', async t => {
  for (const question of ['你好，我们今年利润是多少？', '继续', '好的']) {
    const { service, scope, connections, events, sent, tools } = await fixture(); t.after(() => service.dispose());
    await service.save(scope, { apiKey: 'isolated-test-key', workspaceId: '' }); await service.check(scope);
    const history = [{ role: 'assistant', text: '你要看本期利润吗？' }];
    await service.start(scope, history); const peer = connections.at(-1)!;
    peer.receive({ type: 'response.created', response: { id: 'untrusted' } });
    peer.receive({ type: 'response.audio.delta', response_id: 'untrusted', delta: 'AAA=' });
    peer.receive({ type: 'response.done', response: { id: 'untrusted', status: 'completed' } });
    // ASR can complete after response.done. It must not be lost or require repeating.
    peer.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late-asr', transcript: question });
    await new Promise(r => setTimeout(r, 0));
    assert.equal(tools.length, 1); assert.deepEqual(tools[0].scope, scope);
    assert.deepEqual(tools[0].input, { question, history });
    assert.equal(events.filter(e => e.type === 'audio').length, 0);
    assert.equal(events.some(e => e.code === 'voice_tool_required'), false);
    const update = sent.filter(e => e.type === 'session.update').at(-1); assert.ok(update);
    assert.match(update.session.instructions, /需要本期利润表，暂无数据不能计算/);
    peer.receive({ type: 'session.updated', session: update.session });
    peer.receive({ type: 'response.created', response: { id: 'verified' } });
    peer.receive({ type: 'response.audio.delta', response_id: 'verified', delta: 'AAA=' });
    assert.equal(events.filter(e => e.type === 'audio').length, 1);
    assert.equal(events.find(e => e.type === 'business')?.model, 'original-business-model');
  }
});

test('interruption fences an unacknowledged fallback and never replays its reply into the next turn', async t => {
  const { service, scope, connections, events, sent } = await fixture(); t.after(() => service.dispose());
  await service.save(scope, { apiKey: 'isolated-test-key', workspaceId: '' }); await service.check(scope);
  await service.start(scope, []); const peer = connections.at(-1)!;
  peer.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'hello', transcript: '你好' });
  peer.receive({ type: 'response.created', response: { id: 'untrusted' } });
  peer.receive({ type: 'response.done', response: { id: 'untrusted', status: 'completed' } });
  await new Promise(r => setTimeout(r, 0));
  const update = sent.filter(e => e.type === 'session.update').at(-1); assert.ok(update);
  peer.receive({ type: 'input_audio_buffer.speech_started' }); await new Promise(r => setTimeout(r, 0));
  assert.equal(peer.closed, true);
  peer.receive({ type: 'session.updated', session: update.session });
  peer.receive({ type: 'response.created', response: { id: 'late' } });
  peer.receive({ type: 'response.audio.delta', response_id: 'late', delta: 'AAA=' });
  assert.equal(sent.some(e => e.type === 'response.create'), false);
  assert.equal(events.some(e => e.type === 'audio'), false);
});
