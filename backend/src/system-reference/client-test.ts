import assert from 'node:assert/strict';
import test from 'node:test';
const origin = 'https://library.example.test';
const id = '11111111-1111-4111-8111-111111111111';
const releaseId = '22222222-2222-4222-8222-222222222222';
const token = Buffer.alloc(32, 7).toString('base64url');
const query = { vocabularyVersion: 'finance-topics.v1', topicIds: ['budget_variance'], role: 'finance', requestId: id } as const;
async function load() {
  const mod = await import('./client.js').catch(() => null);
  assert.ok(mod, 'bounded reference transport must be implemented'); return mod;
}
// Breaks caught: redirect credential leakage, unbounded/malformed body admission,
// retries, private query fields, and accepting an unrelated grant/citation.
test('transport pins canonical HTTPS, rejects ambiguous destinations and only test factory allows loopback', async () => {
  const { ReferenceTransport } = await load();
  for (const url of ['http://library.example.test', origin+'/', origin+'/path', origin+'?x=1', origin+'#x', 'https://u:p@library.example.test']) {
    assert.throws(() => new ReferenceTransport({ origin: url }));
  }
  assert.throws(() => new ReferenceTransport({ origin: 'http://127.0.0.1:1234' }));
  assert.doesNotThrow(() => new ReferenceTransport({ origin: 'http://127.0.0.1:1234', testOnlyLoopback: true }));
  assert.throws(() => new ReferenceTransport({ origin: 'http://localhost:1234', testOnlyLoopback: true }));
});
test('query emits only strict fixed-topic JSON and opaque reader authentication, never retries redirects or errors', async () => {
  const { ReferenceTransport } = await load(); let calls = 0;
  const transport = new ReferenceTransport({ origin, fetch: async (url, init) => {
    calls++; assert.equal(String(url), origin+'/api/v1/system-reference/query');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    assert.deepEqual(JSON.parse(String(init?.body)), query);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    return new Response(null, { status: 302, headers: { location: 'https://attacker.example' } });
  } });
  await assert.rejects(transport.reader(token).query({ ...query, topicIds: [...query.topicIds] })); assert.equal(calls, 1);
  await assert.rejects(transport.reader(token).query({ ...query, topicIds: [...query.topicIds], question: 'private' } as never)); assert.equal(calls, 1);
});
for (const kind of ['unknown','bytes','length','bad-json','mime','timeout','body-timeout','abort'] as const) test(`transport rejects ${kind} without releasing a response or retrying`, async () => {
  const { ReferenceTransport } = await load(); let calls = 0; let cancelled = false;
  const abort = new AbortController();
  const transport = new ReferenceTransport({ origin, timeoutMs: 25, fetch: async () => {
    calls++;
    if (kind === 'timeout') return new Promise<Response>(() => {});
    if (kind === 'body-timeout' || kind === 'abort') {
      if (kind === 'abort') queueMicrotask(() => abort.abort());
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: {'content-type':'application/json'} });
    }
    const body = kind === 'unknown' ? JSON.stringify({status:'no_match', sources:[], privateText:'secret'})
      : kind === 'bytes' ? ' '.repeat(262145) : kind === 'bad-json' ? '{' : JSON.stringify({status:'no_match',sources:[]});
    return new Response(body, {headers:{'content-type':kind === 'mime' ? 'text/html':'application/json', ...(kind === 'length'?{'content-length':'262145'}:{})}});
  } });
  await assert.rejects(transport.reader(token).query({ ...query,topicIds:[...query.topicIds] },abort.signal), /reference_/u);
  assert.equal(calls,1); if(kind === 'body-timeout' || kind === 'abort') assert.equal(cancelled,true);
});
test('strict binding responses and grant correlation are validated before returning', async () => {
  const { ReferenceTransport } = await load(); const seen: string[] = [];
  const transport = new ReferenceTransport({origin,fetch:async(url) => {
    seen.push(String(url)); return Response.json({valid:true,grantId:releaseId,releaseId});
  }});
  await assert.rejects(transport.reader(token).assertCurrent(id), /reference_/u);
  await assert.rejects(transport.reader(token).assertCurrent('../escape'), /reference_/u);
  assert.equal(seen.length,1);
  await assert.rejects(transport.create(token), /reference_/u);
});
test('success validates exact query and consumes empty cancellation response', async () => {
  const { ReferenceTransport } = await load();
  const transport = new ReferenceTransport({origin,fetch:async(url) => String(url).endsWith('/cancel')
    ? new Response(null,{status:204}) : Response.json({status:'no_match',sources:[]})});
  assert.deepEqual(await transport.reader(token).query({...query,topicIds:[...query.topicIds]}),{status:'no_match',sources:[]});
  await transport.cancel(id,token);
});
