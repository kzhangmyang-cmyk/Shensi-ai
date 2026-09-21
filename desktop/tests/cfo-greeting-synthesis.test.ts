import assert from 'node:assert/strict';
import test from 'node:test';

test('fixed greeting synthesis requests only the approved sentence and returns bounded PCM', async () => {
  const { synthesizeQwenGreeting } = await import('../src/main/cfo-greeting-synthesis.ts');
  const sent: any[] = []; let receive!: (event: Record<string, any>) => void;
  const pending = synthesizeQwenGreeting({ apiKey: 'fixture-key', workspaceId: '' }, '老板，你来啦。今天咱们先忙点什么？', new AbortController().signal, {
    connect: async (_settings, _history, onEvent) => {
      receive = onEvent;
      return { send: event => sent.push(event), close() {} };
    }
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const update = sent.shift();
  assert.equal(update.type, 'session.update');
  assert.deepEqual(update.session.tools, []);
  assert.match(update.session.instructions, /老板，你来啦/);
  // DashScope may omit an acknowledged empty tools array from session.updated.
  receive({ type: 'session.updated', session: { instructions: update.session.instructions } });
  assert.deepEqual(sent.shift(), { type: 'response.create' });
  receive({ type: 'response.created', response: { id: 'greeting-1' } });
  const pcm = Buffer.from([1, 2, 3, 4]);
  receive({ type: 'response.audio.delta', response_id: 'greeting-1', delta: pcm.toString('base64') });
  receive({ type: 'response.audio_transcript.done', response_id: 'greeting-1', transcript: '老板，你来啦。今天咱们先忙点什么？' });
  receive({ type: 'response.done', response: { id: 'greeting-1', status: 'completed' } });
  assert.deepEqual(await pending, pcm);
});

test('fixed greeting synthesis aborts without accepting late provider audio', async () => {
  const { synthesizeQwenGreeting } = await import('../src/main/cfo-greeting-synthesis.ts');
  let receive!: (event: Record<string, any>) => void; let closed = 0;
  const abort = new AbortController();
  const pending = synthesizeQwenGreeting({ apiKey: 'fixture-key', workspaceId: '' }, '固定问候', abort.signal, {
    connect: async (_settings, _history, onEvent) => { receive = onEvent; return { send() {}, close() { closed++; } }; }
  });
  await new Promise(resolve => setTimeout(resolve, 0)); abort.abort();
  receive({ type: 'response.audio.delta', response_id: 'late', delta: 'AQI=' });
  await assert.rejects(pending, /cfo_greeting_cancelled/);
  assert.equal(closed, 1);
});
