import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentConversationResearch } from './agent-conversation-research.js';
import { AgentWebResearchService } from './agent-web-research.js';
import { FINANCIAL_COUNCIL_MODEL_ROLES } from './financial-council-model-routing.js';
import { workspace } from './financial-council-repository-contract-test.js';
const context = { ...workspace('research-plan'), capabilities: ['finance.council.run'] as const };
const source = {title:'公开政策',url:'https://example.org/policy',snippet:'公开摘要',fetchedAt:'2026-09-25T00:00:00Z'};

for (const role of FINANCIAL_COUNCIL_MODEL_ROLES) {
  test(`${role}: ordinary questions do not search; current questions retrieve once without another answer`, async () => {
    let searches=0; const planned: unknown[]=[];
    const retrieval=new AgentWebResearchService({
      connections:async()=>[{id:'configured',provider:'fixture',name:'搜索'}],
      search:async input=>{searches++;assert.equal(input.query,'增值税政策 中国 最新');return {provider:'fixture',sources:[source]};},
      answer:async()=>{throw new Error('ordinary chat must own the answer');}
    });
    const service=new AgentConversationResearch({retrieval,plan:async input=>{
      planned.push(input);
      return input.question==='解释现金流' ? {kind:'not_needed'} : {kind:'search',topic:'增值税政策',region:'中国',freshness:'最新'};
    }});
    assert.equal(await service.prepare({context,role,question:'解释现金流'}),null);
    assert.equal(searches,0);
    const result=await service.prepare({context,role,question:'最新增值税政策是什么'});
    assert.equal(result?.sources[0].url,source.url);assert.equal(searches,1);
    assert.equal(planned.length,2);
  });
}

test('private question fragments and malicious model plans never reach the search provider',async()=>{
  let searches=0;let plans=0;
  const retrieval=new AgentWebResearchService({connections:async()=>[{id:'configured',provider:'fixture',name:'搜索'}],
    search:async()=>{searches++;return {provider:'fixture',sources:[source]};},answer:async()=>{throw Error('unused');}});
  const service=new AgentConversationResearch({retrieval,plan:async()=>{plans++;return {kind:'search',topic:'private@example.org',region:'',freshness:''};}});
  for(const question of ['查询 private@example.org 的资料','账号：internal-user，查询政策','内部流水标识 998877.66 元，帮我联网','API key: synthetic-secret，查一下']) {
    await assert.rejects(service.prepare({context,role:'cfo',question}),/agent_research_public_topic_required/);
  }
  assert.equal(plans,0);assert.equal(searches,0);
  await assert.rejects(service.prepare({context,role:'cfo',question:'最新政策'}),/agent_research_public_topic_required/);
  assert.equal(plans,1);assert.equal(searches,0);
});

test('clarification, missing connections and cancelled planning never issue searches',async()=>{
  let searches=0;
  const retrieval=new AgentWebResearchService({connections:async()=>[],search:async()=>{searches++;return {provider:'fixture',sources:[source]};},answer:async()=>{throw Error('unused');}});
  const clarify=new AgentConversationResearch({retrieval,plan:async()=>({kind:'clarify',question:'需要哪项公开政策？'})});
  await assert.rejects(clarify.prepare({context,role:'cfo',question:'那项现在怎样'}),/agent_research_public_topic_required/);
  const controller=new AbortController();
  const cancelled=new AgentConversationResearch({retrieval,plan:async()=>{controller.abort();return {kind:'search',topic:'公开政策',region:'',freshness:''};}});
  await assert.rejects(cancelled.prepare({context,role:'cfo',question:'最新政策',signal:controller.signal}),{name:'AbortError'});
  const missing=new AgentConversationResearch({retrieval,plan:async()=>({kind:'search',topic:'公开政策',region:'',freshness:''})});
  await assert.rejects(missing.prepare({context,role:'cfo',question:'最新政策'}),/agent_web_connection_unavailable/);
  assert.equal(searches,0);
});

test('provider timeout is reported with a stable code and is never retried',async()=>{
  let attempts=0;
  const retrieval=new AgentWebResearchService({connections:async()=>[{id:'configured',provider:'fixture',name:'搜索'}],
    search:async()=>{attempts++;throw Error('provider timeout with private diagnostics');},answer:async()=>{throw Error('unused');}});
  const service=new AgentConversationResearch({retrieval,plan:async()=>({kind:'search',topic:'公开政策',region:'',freshness:''})});
  await assert.rejects(service.prepare({context,role:'cfo',question:'最新政策'}),/agent_web_search_unavailable/);
  assert.equal(attempts,1);
});

test('private internal analysis stays available without planning or public search', async () => {
  const retrieval = new AgentWebResearchService({connections:async()=>[],
    search:async()=>assert.fail('private search'),answer:async()=>assert.fail('unused')});
  const service = new AgentConversationResearch({retrieval,plan:async()=>assert.fail('private planner')});
  assert.equal(await service.prepare({context,role:'cfo',question:'内部费用 998877.66 元，应该如何控制？'}), null);
  assert.equal(await service.prepare({context,role:'cfo',question:'内部报销政策如何优化？'}), null);
  assert.equal(await service.prepare({context,role:'cfo',question:'内部现行补贴制度有哪些风险？'}), null);
  await assert.rejects(service.prepare({context,role:'cfo',question:'内部费用 998877.66 元，联网查最新补贴'}), /public_topic_required/);
});

test('abbreviated and Chinese private amounts are blocked both before planning and in plans',async()=>{
  let plans=0;let searches=0;
  const retrieval=new AgentWebResearchService({connections:async()=>[{id:'search',provider:'fixture',name:'搜索'}],
    search:async()=>{searches++;return {provider:'fixture',sources:[source]};},answer:async()=>assert.fail('unused')});
  let plannedTopic='公开政策';
  const service=new AgentConversationResearch({retrieval,plan:async()=>{plans++;return {kind:'search',topic:plannedTopic,region:'',freshness:'最新'};}});
  for(const amount of ['营收120万','收入十二万元','余额120港元','费用１２０万','revenue 120 million','成本120']){
    await assert.rejects(service.prepare({context,role:'cfo',question:`我们本月${amount}，联网查询补贴`}),/public_topic_required/);
  }
  assert.equal(plans,0);assert.equal(searches,0);
  for(const topic of ['月营收120万企业补贴','十二万元企业补贴','费用１２０万']){
    plannedTopic=topic;
    await assert.rejects(service.prepare({context,role:'cfo',question:'联网查询补贴'}),/public_topic_required/);
  }
  assert.equal(searches,0);
});

test('failed or malformed planning is explicit and never reaches retrieval', async () => {
  const retrieval = new AgentWebResearchService({connections:async()=>assert.fail('no retrieval'),
    search:async()=>assert.fail('no search'),answer:async()=>assert.fail('unused')});
  for (const raw of [{}, {kind:'search',topic:'',region:'',freshness:''}, {kind:'not_needed',extra:'unsafe'}]) {
    await assert.rejects(new AgentConversationResearch({retrieval,plan:async()=>raw})
      .prepare({context,role:'tax',question:'最新税务政策'}), /agent_research_plan_invalid/);
  }
  await assert.rejects(new AgentConversationResearch({retrieval,plan:async()=>{throw Error('secret diagnostics');}})
    .prepare({context,role:'tax',question:'最新税务政策'}), /agent_research_plan_unavailable/);
});
