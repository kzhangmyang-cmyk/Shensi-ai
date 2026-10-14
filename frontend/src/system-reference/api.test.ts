import assert from 'node:assert/strict';
import test from 'node:test';
import { systemCitationFixture as citation, connectionBeginFixture as begin } from './test-fixtures';
async function load() { const module = await import('./api').catch(() => null); assert.ok(module, 'safe generated-DTO reference API required'); return module; }
test('reference API sends only same-origin safe connection and exact grant paths with normal workspace/CSRF, once', async () => {
  const { createReferenceApi } = await load(); const sent: { path: string; init?: RequestInit }[] = [];
  const replies = [{ status: 'unbound', generation: 1 }, begin, { status: 'ready', generation: 2 }, citation, { status: 'unbound', generation: 3 }];
  const api = createReferenceApi({ workspaceId: () => 'workspace-test', csrf: () => 'test-csrf', fetchImpl: async (path, init) => {
    sent.push({ path, init }); return new Response(JSON.stringify(replies.shift()), { headers: { 'Content-Type': 'application/json' } });
  } });
  await api.status(); await api.begin(); await api.complete(begin.requestId); assert.deepEqual(await api.citation(citation.queryGrantId, citation.referenceId), citation); await api.unbind();
  assert.deepEqual(sent.map(s => [s.path, s.init?.method, s.init?.body]), [
    ['/api/v1/reference-connection', 'GET', undefined], ['/api/v1/reference-connection/begin', 'POST', '{}'],
    ['/api/v1/reference-connection/complete', 'POST', JSON.stringify({ requestId: begin.requestId })],
    [`/api/v1/reference-connection/grants/${citation.queryGrantId}/references/${citation.referenceId}`, 'GET', undefined],
    ['/api/v1/reference-connection', 'DELETE', undefined]
  ]);
  for (const { init } of sent) { const headers = new Headers(init?.headers); assert.equal(headers.get('X-Workspace-Id'), 'workspace-test');
    assert.equal(headers.has('authorization'), false); assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store');
    assert.equal(headers.get('x-csrf-token'), init?.method === 'GET' ? null : 'test-csrf'); }
});
test('reference API rejects arbitrary identifiers, missing workspace and pre-abort without network', async () => {
  const { createReferenceApi } = await load(); let calls = 0, workspace: string | null = 'workspace-test';
  const api = createReferenceApi({ workspaceId: () => workspace, csrf: () => 'test-csrf', fetchImpl: async () => { calls++; return new Response('{}'); } });
  for (const invalid of ['../content', 'https://other.example/', citation.queryGrantId + '?cursor=1']) {
    await assert.rejects(api.citation(invalid, citation.referenceId)); await assert.rejects(api.complete(invalid));
  }
  workspace = 'all'; await assert.rejects(api.status()); workspace = null; await assert.rejects(api.begin()); workspace = 'workspace-test';
  const controller = new AbortController(); controller.abort(); await assert.rejects(api.status(controller.signal)); assert.equal(calls, 0);
});
test('reference API refuses malformed or secret-bearing responses, swapped grants, range drift and oversized bodies', async () => {
  const { createReferenceApi, ReferenceApiError } = await load(); let reply: unknown;
  const invalid = (error: unknown) => error instanceof ReferenceApiError && error.code === 'reference_response_invalid';
  const api = createReferenceApi({ workspaceId: () => 'workspace-test', csrf: () => 'test-csrf', fetchImpl: async () => Response.json(reply) });
  for (const value of [{ status: 'ready', generation: 1, readerToken: 'secret' }, { status: 'embedded_ready', generation: 0, readerToken: 'secret' }, { status: 'embedded_unknown', generation: 0 }, { status: 'other', generation: 1 }, { status: 'ready', generation: -1 }]) {
    reply = value; await assert.rejects(api.status(), invalid);
  }
  for (const value of [{ ...begin, approvalUrl: 'javascript:alert(1)' }, { ...begin, approvalUrl: 'https://u:p@reference.example/' }, { ...begin, verifier: 'secret' },
    {...begin,approvalUrl:begin.approvalUrl.replace('reference-approval.html','elsewhere.html')},
    {...begin,approvalUrl:begin.approvalUrl.replace('01234567','76543210')},
    {...begin,approvalUrl:begin.approvalUrl+'&next=https://other.example'},
    {...begin,approvalUrl:begin.approvalUrl+'#private'},
    {...begin,approvalUrl:begin.approvalUrl+'&displayCode=01234567'}]) {
    reply = value; await assert.rejects(api.begin(), invalid);
  }
  for (const value of [{ ...citation, documentId: begin.requestId }, { ...citation, queryGrantId: begin.requestId }, { ...citation, excerptRange: { start: 0, end: 4 } }, { ...citation, excerpt: '\ud80012345' }, { ...citation, locator: { page: 0 } }]) {
    reply = value; await assert.rejects(api.citation(citation.queryGrantId, citation.referenceId), invalid);
  }
  reply = { padding: 'x'.repeat(262144) }; await assert.rejects(api.status(), invalid);
});
test('reference API stops promptly on cancellation even if a transport ignores abort and discards a late response', async () => {
  const {createReferenceApi}=await load(); let resolve!:(response:Response)=>void,calls=0; const controller=new AbortController();
  const api=createReferenceApi({workspaceId:()=> 'workspace-test',fetchImpl:async()=>{calls++;return new Promise<Response>(done=>{resolve=done;});}});
  const request=api.status(controller.signal);controller.abort();
  const outcome=await Promise.race([request.then(()=> 'released',()=> 'cancelled'),new Promise<string>(done=>setTimeout(()=>done('hung'),100))]);
  resolve(Response.json({status:'ready',generation:1}));assert.equal(outcome,'cancelled');assert.equal(calls,1);await assert.rejects(request);
});
test('reference API refuses redirected or non-JSON success responses',async()=>{
  const {createReferenceApi}=await load();
  for(const response of [new Response(JSON.stringify({status:'ready',generation:1})),Object.defineProperty(Response.json({status:'ready',generation:1}),'redirected',{value:true})]){
    const api=createReferenceApi({workspaceId:()=> 'workspace-test',fetchImpl:async()=>response});await assert.rejects(api.status());
  }
});
test('reference failures emit fixed messages and never retry network, authorization or quota failures', async () => {
  const { createReferenceApi, ReferenceApiError } = await load();
  for (const status of [401, 403, 404, 409, 429, 503]) {
    let calls = 0; const api = createReferenceApi({ workspaceId: () => 'workspace-test', fetchImpl: async () => {
      calls++; return new Response(JSON.stringify({ error: { code: 'arbitrary-private-value', message: 'private-body' } }), { status });
    } });
    await assert.rejects(api.status(), error => error instanceof ReferenceApiError && error.status === status && !error.message.includes('private'));
    assert.equal(calls, 1);
  }
  let calls = 0; const api = createReferenceApi({ workspaceId: () => 'workspace-test', csrf: () => 'test-csrf', fetchImpl: async () => { calls++; throw new Error('private-secret'); } });
  await assert.rejects(api.begin(), error => error instanceof ReferenceApiError && error.message === 'reference_unavailable'); assert.equal(calls, 1);
});
