import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentWebResearchRuntime, createAgentConversationResearchRuntime } from './agent-web-research-runtime.js';
import { createDefaultProviderCatalog } from './provider-catalog.js';
import { workspace } from './financial-council-repository-contract-test.js';
import type { ProviderConnection } from './types.js';
import { encryptAiModelApiKey } from './credential-security.js';
import type { DurableModelRuntimeStore } from './model-providers/runtime.js';
import express from 'express';
import type {AddressInfo} from 'node:net';
import {createGrowthFinancialCouncilResources} from './growth-financial-council-module.js';
import {createFinancialCouncilAgentCenterRouter} from './financial-council-agent-center-router.js';
import {RepositoryVerifiedFinancialLedgerSealedReader} from './financial-ledger-as-of-reader.js';
import {AgentOperatingMemoryService} from './agent-operating-memory.js';
import {MemoryDecisionMemoryRepository} from './decision-memory-repository.js';

test('web runtime selects only current owned real search connections and preserves provider evidence', async () => {
  const context = { ...workspace('team-a'), actorId: 'owner-a', teamId: 'team-a', capabilities: ['finance.council.run'] as const };
  const connection = { id: 'real-search', providerId: 'tavily', ownerId: 'owner-a', teamId: 'team-a', scope: 'personal', status: 'active' } as ProviderConnection;
  let queries = 0; let persisted = 0;
  const store = { providerConnections: [connection, { ...connection, id: 'foreign', ownerId: 'other' }, { ...connection, id: 'fake', providerId: 'ai_search' }],
    providerCatalog: createDefaultProviderCatalog(), providerRequestLogs: [], async persist() { persisted++; } };
  const runtime = createAgentWebResearchRuntime(store as never, {
    executeSearch: async input => {
      queries++; assert.equal(input.query.goal, '政策公开资料'); assert.equal(input.query.customerType, '');
      assert.equal(input.query.productKeywords, ''); assert.equal(input.context.ownerId, context.actorId);
      input.onLogs([{ id: 'log-fixture', ownerId: context.actorId, teamId: context.teamId, connectionId: connection.id, providerId: 'tavily',
        runId: input.context.runId, runShardId: input.context.runShardId, requestFingerprint: 'a'.repeat(64), endpointCode: 'search', httpStatus: 200,
        attempt: 1, quotaUnits: 1, costAmount: 0, currency: '', durationMs: 1, responseSize: 50, errorCode: '', requestedAt: '2026-09-24T10:00:00Z' }]);
      return { records: [{ company: '公开依据', sourceUrl: 'https://example.org/source', description: '来自提供商的摘要', fetchedAt: '2026-09-24T10:00:00Z' }] } as never;
    },
    answer: async input => { assert.equal(input.sources[0].snippet, '来自提供商的摘要'); return { answer: '依据摘要，仍需核对原文。', citationIds: ['S1'], model: 'fixture', provider: 'fixture' }; }
  });
  assert.deepEqual((await runtime.connections(context)).map(item => item.id), ['real-search']);
  const result = await runtime.run(context, { query: '政策公开资料', connectionId: 'real-search', role: 'tax' });
  assert.equal(result.sources[0].fetchedAt, '2026-09-24T10:00:00.000Z');
  assert.equal(queries, 1); assert.equal(persisted, 1);
  await assert.rejects(runtime.run(context, { query: '政策公开资料', connectionId: 'foreign', role: 'tax' }));
  assert.equal(queries, 1);
});

test('configured model gateway receives only public sources and rejects invented citations', async () => {
  const previous = process.env.PROVIDER_CREDENTIAL_KEY; process.env.PROVIDER_CREDENTIAL_KEY = 'isolated-web-research-fixture-key';
  try {
    const context = { ...workspace('web-model'), actorId: 'fixture-owner', teamId: 'web-model', capabilities: ['finance.council.run'] as const };
    const config = { id: 'web-fixture-model', provider: 'moonshot', protocol: 'openai-compatible', name: 'fixture',
      baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', apiKey: '', enabled: true, temperature: 0.1,
      useLeadFinder: false, useWebsiteParse: false, useScoring: false, useEmailDraft: false, useExam: false,
      lastTestStatus: 'untested', lastTestMessage: '', ownerId: context.actorId, teamId: context.teamId, credentialVersion: 1,
      capabilitySnapshot: { structuredOutput: true, toolCalling: true, parallelToolCalling: false, streaming: true, modelListing: true },
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as const;
    const models: DurableModelRuntimeStore = { aiModelConfigs: [config], modelCredentialVersions: [{ connectionId: config.id, provider: config.provider,
      ownerId: config.ownerId, teamId: config.teamId, version: 1, credentialRef: 'fixture-v1', apiKeyEncrypted: encryptAiModelApiKey(config, 'synthetic-key-only'),
      keyMask: 'fixture', createdBy: context.actorId, createdAt: config.createdAt }], aiJobModelSnapshots: [], pendingAiJobModelSnapshots: [], modelCallRecords: [], pendingModelCallRecords: [], async persist() {} };
    const store = { ...models, providerConnections: [{ id: 'search', providerId: 'tavily', ownerId: context.actorId, teamId: context.teamId, scope: 'personal', status: 'active' } as ProviderConnection], providerCatalog: createDefaultProviderCatalog(), providerRequestLogs: [] };
    let invalid = false; let modelCalls = 0;
    const service = createAgentWebResearchRuntime(store, {
      executeSearch: async input => {
        input.onLogs([{ id: `log-${modelCalls}`, ownerId: context.actorId, teamId: context.teamId, connectionId: 'search', providerId: 'tavily', runId: input.context.runId,
          runShardId: input.context.runShardId, requestFingerprint: 'a'.repeat(64), endpointCode: 'search', httpStatus: 200, attempt: 1, quotaUnits: 1,
          costAmount: 0, currency: '', durationMs: 1, responseSize: 50, errorCode: '', requestedAt: '2026-09-24T10:00:00Z' }]);
        return { records: [{ company: '公开方法', sourceUrl: 'https://example.org/method', description: '方法摘要', fetchedAt: '2026-09-24T10:00:00Z' }] } as never;
      },
      modelFetch: async (_url, init) => {
        modelCalls++; const outgoing = JSON.parse(String(init?.body));
        const firstUser = outgoing.messages.find((item: any) => item.role === 'user');
        const payload = JSON.parse(firstUser.content.replace(/^BEGIN_UNTRUSTED_DATA\n/, '').replace(/\nEND_UNTRUSTED_DATA$/, ''));
        assert.deepEqual(Object.keys(payload).sort(), ['evidenceKind', 'question', 'sources']);
        assert.equal(payload.sources[0].url, 'https://example.org/method');
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: '公开方法建议核对来源。', citationIds: [invalid ? 'S9' : 'S1'] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    const result = await service.run(context, { query: '公开方法', connectionId: 'search', role: 'cost' });
    assert.equal(result.model, 'moonshot-v1-8k'); assert.deepEqual(result.citationIds, ['S1']); assert.equal(modelCalls, 1);
    invalid = true;
    await assert.rejects(service.run(context, { query: '公开方法', connectionId: 'search', role: 'cost' }));
    let planningCalls = 0;
    const conversation = createAgentConversationResearchRuntime(store, {
      executeSearch: async () => { throw new Error('ordinary question must not search'); },
      modelFetch: async (_url, init) => {
        planningCalls++;
        const outgoing = JSON.parse(String(init?.body));
        const user = outgoing.messages.find((item: any) => item.role === 'user');
        const payload = JSON.parse(user.content.replace(/^BEGIN_UNTRUSTED_DATA\n/, '').replace(/\nEND_UNTRUSTED_DATA$/, ''));
        assert.deepEqual(payload, { question: '解释现金流' });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({kind:'not_needed'}) }, finish_reason:'stop' }],
          usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2} }), {status:200,headers:{'content-type':'application/json'}});
      }
    });
    assert.equal(await conversation.prepare({context,role:'cfo',question:'解释现金流',history:['私密记录'],attachments:['附件秘密']} as never),null);
    assert.equal(planningCalls,1);

    // Full production resource ownership and HTTP ingress, with only network IO replaced.
    let searches=0;const plannerPayloads:any[]=[];const answerPayloads:any[]=[];
    const operatingMemory=new AgentOperatingMemoryService(new MemoryDecisionMemoryRepository(),{} as never);
    await operatingMemory.saveProfile(context,{expectedRevision:0,enabled:true,preferences:{priority:'cash',cashFloorMinor:99887766,
      pilotFirst:true,reviewCadence:'weekly',learningEnabled:false,confirmedFrom:'self_report'}});
    const resources=await createGrowthFinancialCouncilResources({mode:'memory',modelStore:store,webResearchStore:store as never,operatingMemory,
      foundation:{} as never,advisor:{today:Object.freeze({getToday(){throw Error('unused');},getTodayAt(){throw Error('unused');},sealTodayCutoff(){throw Error('unused');}})},
      finance:{verifiedAsOf:new RepositoryVerifiedFinancialLedgerSealedReader({} as never)} as never,wakeSink:{async wake(){}},
      modelFetch:async(_url,init)=>{
        const outgoing=JSON.parse(String(init?.body));const user=outgoing.messages.find((m:any)=>m.role==='user').content;
        const payload=JSON.parse(user.replace(/^BEGIN_UNTRUSTED_DATA\n/,'').replace(/\nEND_UNTRUSTED_DATA$/,''));
        const planning=!('history' in payload);
        let value:unknown;
        if(planning){plannerPayloads.push(payload);assert.ok(Object.keys(payload).every(k=>['question','previousPublicTopic'].includes(k)));
          const rules=outgoing.messages.find((m:any)=>m.role==='system').content;
          for(const example of ['{"kind":"not_needed"}','{"kind":"clarify","question":"需要澄清的问题"}','{"kind":"search","topic":"公开主题","region":"","freshness":""}']) assert.ok(rules.includes(example),'planner receives the exact JSON alternatives');
          assert.match(rules,/明确要求.{0,30}联网.{0,100}search/u,'explicit public search must take priority over the general-knowledge shortcut in the model request');
          value=payload.question==='解释现金流'?{kind:'not_needed'}:{kind:'search',topic:'公共政策',region:'中国',freshness:'最新'};
        }else{answerPayloads.push(payload);
          if(payload.publicEvidence && !payload.cells) {
            const rules=outgoing.messages.find((m:any)=>m.role==='system').content;
            assert.doesNotMatch(rules,/只有 answer 字段|仅含answer/,'public evidence must not receive contradictory answer-only instructions');
            assert.match(rules,/"answer".*"citationIds"/u,'model needs an exact example of the public-answer schema');
          }
          value=payload.cells
          ?{observations:[{template:'原文为{{cell:1:2:2}}，政策适用需另核对。',sourceRefs:['cell:1:2:2']}],...(payload.publicEvidence?{citationIds:['S1']}:{})}
          :{answer:'依据现有资料核对口径与适用范围。',...(payload.publicEvidence?{citationIds:['S1']}:{})};}
        return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200,headers:{'content-type':'application/json'}});
      },executeSearch:async input=>{
        searches++;assert.equal(input.query.goal,'公共政策 中国 最新');
        for(const secret of ['998877.66','private@example.org','附件秘密'])assert.equal(JSON.stringify(input.query).includes(secret),false);
        input.onLogs([{id:`full-${searches}`,ownerId:context.actorId,teamId:context.teamId,connectionId:'search',providerId:'tavily',runId:input.context.runId,
          runShardId:input.context.runShardId,requestFingerprint:'a'.repeat(64),endpointCode:'search',httpStatus:200,attempt:1,quotaUnits:1,costAmount:0,currency:'',durationMs:1,responseSize:50,errorCode:'',requestedAt:'2026-09-25T00:00:00Z'}]);
        return {records:[{company:'公开政策',sourceUrl:'https://example.org/policy',description:'政策摘要',fetchedAt:'2026-09-25T00:00:00Z'}]} as never;
      }});
    const app=express();app.use(express.json());app.use('/api/v1/finance',createFinancialCouncilAgentCenterRouter({center:resources.agentCenter,workspaceContext:()=>context}));
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/finance`;
    const post=async(path:string,body:unknown)=>{const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
    try{
      assert.ok(resources.webResearch);
      const ordinary=await post('/cfo-conversation',{question:'解释现金流',history:[]});assert.equal(ordinary.research,undefined);assert.equal(searches,0);
      for(const role of ['cfo','finance','profit','cost','cashflow','tax']){
        const result=await post('/cfo-conversation',{role,question:'最新公共政策',history:[{role:'user',text:'附件秘密 private@example.org'}]});
        assert.equal(result.research.sources[0].url,'https://example.org/policy');
      }
      assert.equal(searches,6);
      const attachment=await resources.documents.inspect(context,{fileName:'private.csv',mediaType:'text/csv',contentBase64:Buffer.from('项目,金额\n附件秘密,998877.66\n').toString('base64'),readWithModel:false,
        attachmentScope:{conversationKey:'12345678-1234-4234-8234-123456789012',role:'tax'}});
      const documentAnswer=await post('/cfo-conversation',{role:'tax',question:'最新公共政策对资料的影响',history:[],documentId:attachment.documentId,conversationKey:'12345678-1234-4234-8234-123456789012'});
      assert.match(documentAnswer.answer,/998877.66/);assert.equal(documentAnswer.research.citationIds[0],'S1');
      const session=await post('/cfo-sessions',{documentId:null});
      const reply=await post(`/cfo-sessions/${session.sessionId}/turns`,{question:'最新公共政策',documentId:null,revision:1});
      const restored=await (await fetch(base+`/cfo-sessions/${session.sessionId}`)).json();
      assert.deepEqual(restored.turns[1].research,reply.answer.research);
      const selected=await post('/operating-memory-question',{selection:{domain:'operating',revision:1},input:{question:'最新公共政策',role:'cost',history:[]}});
      assert.equal(selected.answer.research.status,'completed');assert.equal(answerPayloads.at(-1).personalTradeoffs.priority,'cash');
      assert.equal(searches,9);
      for(const payload of plannerPayloads)for(const secret of ['998877.66','private@example.org','附件秘密','cashFloorMinor'])assert.equal(JSON.stringify(payload).includes(secret),false);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await resources.relay.close();await resources.closeFinancialCouncilResources();}
  } finally { if (previous === undefined) delete process.env.PROVIDER_CREDENTIAL_KEY; else process.env.PROVIDER_CREDENTIAL_KEY = previous; }
});
