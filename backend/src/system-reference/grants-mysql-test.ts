import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type {PoolConnection,RowDataPacket} from 'mysql2/promise';
import {emptyPlatformState} from '../platform-admin-domain.js';
import {createMysqlReferenceAuthority} from './authority.js';
import {createReferenceCrypto,referenceHash,type ReferenceCrypto} from './crypto.js';
import {initializeReferenceSchema,MysqlReferenceRepository} from './mysql-repository.js';
import {syntheticReferenceKey,fixtureHash} from './publication-fixture.js';
import {createReferenceTestDatabase} from './mysql-test-support.js';
import {consumeReferenceRate,recordReferenceGrant,assertReferenceGrant,readReferenceCitation,type ReferenceGrantCandidate} from './grants.js';
import type {CentralReader} from './domain.js';

// Persistence tests for internal transaction primitives only. Binding proof and
// current-publication validation belong to the subsequent D5 service tests.
const reader:CentralReader={subjectId:'synthetic-reader',workspaceId:'synthetic-workspace',authVersion:1,authorityRevision:1};
const DAY=86400000,base=Date.UTC(2026,9,8);
function candidate(n=0,length=30,indexedCharacters=2400000):ReferenceGrantCandidate{
  return {sourceHash:fixtureHash('synthetic-source'),chunkHash:fixtureHash(`synthetic-chunk-${n}-${length}`),
    excerpt:(`合成预算${n} `+'参'.repeat(length)).slice(0,length),sourceLabel:'仅合成来源',locator:{page:n+1,chapter:'预算'},
    warnings:['text_precision_unverified'],indexedCharacters};
}
async function setup(){
  const db=await createReferenceTestDatabase();
  try{
    await db.pool.query('CREATE TABLE users (id VARCHAR(191) PRIMARY KEY,team_id VARCHAR(191),status VARCHAR(20),auth_version INT) ENGINE=InnoDB');
    await db.pool.query('CREATE TABLE platform_administration_state (id INT PRIMARY KEY,payload JSON NOT NULL) ENGINE=InnoDB');
    await db.pool.execute('INSERT INTO users VALUES (?,?,?,?)',[reader.subjectId,reader.workspaceId,'active',1]);
    const state=emptyPlatformState();state.revision=1;
    state.plans=[{id:'trial:1',code:'trial',version:1,features:['agents'],published:true,seatLimit:5,durationDays:7}];
    state.workspaces=[{id:reader.workspaceId,name:'Synthetic',contact:'',status:'active',planVersionId:'trial:1',startsAt:'2000-01-01T00:00:00Z',expiresAt:'2100-01-01T00:00:00Z',revision:1}];
    await db.pool.execute('INSERT INTO platform_administration_state VALUES (1,?)',[JSON.stringify(state)]);
    await initializeReferenceSchema(db.pool);
    const crypto=createReferenceCrypto(syntheticReferenceKey),auditKeys=new Map<string,readonly string[]>();
    // Capture AAD keys, never mock encryption or store a second plaintext audit.
    const observedCrypto:ReferenceCrypto={open:crypto.open,seal(scope,value){if(scope.kind==='audit')auditKeys.set(referenceHash(scope.key),scope.key);return crypto.seal(scope,value);}};
    const repo=new MysqlReferenceRepository(db.pool,observedCrypto),authority=createMysqlReferenceAuthority(db.pool);
    const corpusId=randomUUID(),releaseId=randomUUID();
    const authorize=async(connection?:PoolConnection)=>{assert.ok(connection);assert.deepEqual(await authority.current(reader.subjectId,reader.workspaceId,connection),reader);};
    const query=(candidates:ReferenceGrantCandidate[],now=base,repository=repo,version=releaseId,bindingId='synthetic-binding')=>repository.transaction(corpusId,authorize,async tx=>{
      assert.equal(await consumeReferenceRate(tx,{subjectId:reader.subjectId,bindingId,ip:'127.0.0.1',operation:'query',now}),true);
      return recordReferenceGrant(tx,{reader,corpusId,releaseId:version,requestId:randomUUID(),candidates,now});
    });
    const rows=async(table:'grants'|'budgets'|'audits')=>{
      const [values]=await db.pool.execute<RowDataPacket[]>(`SELECT record_id,payload FROM system_reference_${table} WHERE corpus_id=? ORDER BY record_id`,[corpusId]);
      return values;
    };
    const usage=async()=>{
      const key=['source-usage',reader.subjectId,candidate().sourceHash],values=await rows('budgets');
      const row=values.find(v=>v.record_id===referenceHash(key));assert.ok(row);
      return crypto.open({corpusId,kind:'budget',key},row.payload) as {entries:Array<{chunkHash:string;length:number;at:number}>};
    };
    return {db,crypto,repo,corpusId,releaseId,authorize,query,rows,usage,auditKeys};
  }catch(error){await db.close();throw error;}
}
test('real MySQL reopens exact grants and encrypted accounting with closed safe audit',async()=>{
  const e=await setup();try{
    const c=candidate(),result=await e.query([c]);assert.equal(result.status,'used');if(result.status!=='used')return;
    const reopened=new MysqlReferenceRepository(e.db.openPool(),createReferenceCrypto(syntheticReferenceKey));
    const input={reader,corpusId:e.corpusId,releaseId:e.releaseId,grantId:result.grantId,now:base};
    const source=await reopened.transaction(e.corpusId,e.authorize,tx=>readReferenceCitation(tx,{...input,referenceId:result.sources[0].referenceId}));
    assert.deepEqual(source,result.sources[0]);assert.deepEqual(source.excerptRange,{start:0,end:30});
    assert.deepEqual({text:source.excerpt,hash:source.chunkHash,locator:source.locator,warnings:source.warnings},{text:c.excerpt,hash:c.chunkHash,locator:c.locator,warnings:c.warnings});
    assert.equal((await e.usage()).entries.length,1);assert.equal((await e.rows('budgets')).length,5);
    for(const table of ['grants','budgets','audits'] as const)for(const row of await e.rows(table)){assert.match(row.payload,/^sr1\./);assert.equal(row.payload.includes(c.excerpt),false);}
    const audits=await e.rows('audits');assert.equal(audits.length,1);const key=e.auditKeys.get(audits[0]!.record_id);assert.ok(key);
    const audit=e.crypto.open({corpusId:e.corpusId,kind:'audit',key},audits[0]!.payload) as Record<string,unknown>;
    assert.deepEqual(Object.keys(audit).sort(),['action','at','characters','reason','releaseId','requestId','sourceCount','subjectId','workspaceId'].sort());
    assert.equal(audit.reason,'released');assert.equal(audit.sourceCount,1);assert.equal(audit.characters,30);assert.equal(JSON.stringify(audit).includes(c.excerpt),false);
    await e.db.pool.execute('UPDATE users SET status=? WHERE id=?',['disabled',reader.subjectId]);
    await assert.rejects(reopened.transaction(e.corpusId,e.authorize,tx=>assertReferenceGrant(tx,input)),/reference_forbidden/);
  }finally{await e.db.close();}
});
test('real audit failure rolls back all query-rate buckets, disclosure, grant and audit',async()=>{
  const e=await setup();try{
    const snapshot=()=>Promise.all([e.rows('grants'),e.rows('budgets'),e.rows('audits')]),before=await snapshot();
    await e.db.pool.query("CREATE TRIGGER fail_reference_audit BEFORE INSERT ON system_reference_audits FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic interruption'");
    await assert.rejects(e.query([candidate()]),/persistence_unconfirmed/);assert.deepEqual(await snapshot(),before);
    await e.db.pool.query('DROP TRIGGER fail_reference_audit');
    assert.equal((await e.query([candidate()])).status,'used');assert.equal((await e.usage()).entries.length,1);
    assert.equal((await e.rows('grants')).length,1);assert.equal((await e.rows('budgets')).length,5);assert.equal((await e.rows('audits')).length,1);
  }finally{await e.db.close();}
});
test('real concurrent pools cannot release more than the final daily chunk allowance',async()=>{
  const e=await setup();try{
    await e.query(Array.from({length:6},(_,n)=>candidate(n)));await e.query(Array.from({length:5},(_,n)=>candidate(n+6)));
    const reopened=new MysqlReferenceRepository(e.db.openPool(),createReferenceCrypto(syntheticReferenceKey));
    const results=await Promise.all([e.query([candidate(11)]),e.query([candidate(12)],base,reopened)]);
    assert.deepEqual(results.map(r=>r.status).sort(),['rate_limited','used']);
    const entries=(await e.usage()).entries;assert.equal(entries.length,12);
    assert.equal(entries.filter(v=>[candidate(11).chunkHash,candidate(12).chunkHash].includes(v.chunkHash)).length,1);
    assert.equal((await e.rows('grants')).length,3);assert.equal((await e.rows('audits')).length,4);
    assert.equal((await e.query([candidate(13)],base,reopened,randomUUID(),'replacement-binding')).status,'rate_limited');
  }finally{await e.db.close();}
});
test('reopened SQL preserves rolling usage across bindings and releases until the exact thirty-day boundary',async()=>{
  const e=await setup();try{
    const old=await e.query([candidate(0,30,600)]);assert.equal(old.status,'used');if(old.status!=='used')return;
    const reopened=new MysqlReferenceRepository(e.db.openPool(),createReferenceCrypto(syntheticReferenceKey));
    const input={reader,corpusId:e.corpusId,releaseId:e.releaseId,grantId:old.grantId,now:base+30*DAY-1};
    assert.deepEqual(await reopened.transaction(e.corpusId,e.authorize,tx=>readReferenceCitation(tx,{...input,referenceId:old.sources[0].referenceId})),old.sources[0]);
    assert.equal((await e.query([candidate(1,1,600)],input.now,reopened,randomUUID(),'replacement-binding')).status,'rate_limited');
    await assert.rejects(reopened.transaction(e.corpusId,e.authorize,tx=>assertReferenceGrant(tx,{...input,now:base+30*DAY})),/grant_invalid/);
    assert.equal((await e.query([candidate(1,1,600)],base+30*DAY,reopened,randomUUID(),'replacement-binding')).status,'used');
    assert.deepEqual((await e.usage()).entries.map(({chunkHash,length,at})=>({chunkHash,length,at})),[{chunkHash:candidate(1,1,600).chunkHash,length:1,at:base+30*DAY}]);
  }finally{await e.db.close();}
});
