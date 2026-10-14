import test from 'node:test';
import assert from 'node:assert/strict';
import {createReferenceAdminApi} from './admin-api';
import {releaseDetail,releaseId} from './admin-test-fixtures';
const json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
test('central account cookie changes fence both late metadata and subsequent writes',async()=>{
  let csrf='first',reads=0,writes=0,resolve!: (value:Response)=>void;
  const api=createReferenceAdminApi({csrf:()=>csrf,fetchImpl:async(_path,init)=>{
    if(init?.method==='POST'){writes++;return json({...releaseDetail.release,revision:3,status:'published'});}
    reads++;return await new Promise<Response>(done=>{resolve=done;});
  }});
  const signal=new AbortController().signal,pending=api.inspect(releaseId,signal);csrf='other';resolve(json(releaseDetail));
  await assert.rejects(pending);
  await assert.rejects(api.transition(releaseDetail.release,'publish',{reason:'合成测试'},'synthetic-key',signal));assert.equal(reads,1);assert.equal(writes,0);
});
test('metadata rejects extra content, inconsistent coverage and mismatched release identity',async()=>{
  for(const value of [{...releaseDetail,readerToken:'synthetic-forbidden'},
    {...releaseDetail,manifest:{...releaseDetail.manifest,sources:[{...releaseDetail.manifest.sources[0],coverage:{totalPages:3,extractedPages:3,missingPages:[3]}}]}},
    {...releaseDetail,release:{...releaseDetail.release,id:'99999999-9999-4999-8999-999999999999'}}]){
    const api=createReferenceAdminApi({csrf:()=> 'synthetic',fetchImpl:async()=>json(value)});
    await assert.rejects(api.inspect(releaseId,new AbortController().signal));
  }
});
test('committed command checks accept only the same operation, version, corpus and manifest',async()=>{
  const release={...releaseDetail.release,revision:3,status:'published'};
  const valid={operation:'publish',outcome:'committed',requestHash:'f'.repeat(64),release};
  const cases=[valid,{...valid,operation:'revoke'},...[
    {id:'99999999-9999-4999-8999-999999999999'},
    {corpusId:'99999999-9999-4999-8999-999999999999'},
    {manifestHash:'f'.repeat(64)},{revision:2},{status:'revoked'}
  ].map(change=>({...valid,release:{...release,...change}}))];
  for(const [index,value] of cases.entries()){
    let gets=0;
    const api=createReferenceAdminApi({csrf:()=> 'synthetic',fetchImpl:async(path,init)=>{
      gets++;assert.equal(init?.method,'GET');assert.equal(new Headers(init?.headers).get('Idempotency-Key'),'original-command');
      assert.equal(path,`/api/platform/v1/system-reference/commands/status?corpusId=${release.corpusId}&operation=publish`);return json(value);
    }});
    const result=api.commandStatus(releaseDetail.release,'publish','original-command',new AbortController().signal);
    if(index===0)assert.deepEqual(await result,valid);else await assert.rejects(result);
    assert.equal(gets,1);
  }
});
