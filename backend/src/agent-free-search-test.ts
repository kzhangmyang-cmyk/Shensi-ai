import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentWebResearchRuntime } from './agent-web-research-runtime.js';
import { workspace } from './financial-council-repository-contract-test.js';
import { decodeFreeSearch } from './agent-free-search.js';

test('search output preserves provider evidence and rejects malformed results',()=>{
  const result=decodeFreeSearch(JSON.stringify([{title:'来源',href:'https://example.org',body:'摘要'}]));
  assert.equal(result[0].snippet,'摘要'); assert.equal(result[0].url,'https://example.org');
  for(const raw of ['<html>error</html>','{}','[{"title":"x","href":"bad","body":"y"}]']) {
    assert.throws(()=>decodeFreeSearch(raw),/agent_web_search_unavailable/);
  }
});

test('unconfigured account can retrieve public evidence without a paid connection', async () => {
  const context = {...workspace('free-team'), actorId:'free-owner', teamId:'free-team', capabilities:['finance.council.run'] as const};
  const store = {providerConnections:[],providerCatalog:[],providerRequestLogs:[],async persist(){}};
  let calls=0;
  const runtime = createAgentWebResearchRuntime(store as never, {freeSearch:async (query:string, signal?:AbortSignal)=>{
    calls++; assert.equal(query,'公开现金流指引'); signal?.throwIfAborted();
    return [{title:'公开来源',url:'https://example.org/guide',snippet:'来源摘要',fetchedAt:'2026-09-25T00:00:00Z'}];
  }});
  const connections=await runtime.connections(context);
  assert.equal(connections.length,1);
  const result=await runtime.retrieve(context,{query:'公开现金流指引',connectionId:connections[0].id,role:'cashflow'});
  assert.equal(result.sources[0].id,'S1'); assert.equal(result.searchProvider,'duckduckgo'); assert.equal(calls,1);
  const stopped=new AbortController(); stopped.abort();
  await assert.rejects(runtime.retrieve(context,{query:'公开现金流指引',connectionId:connections[0].id,role:'cashflow'},stopped.signal));
  assert.equal(calls,1);
});
