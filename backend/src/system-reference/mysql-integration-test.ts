import assert from 'node:assert/strict';
import test from 'node:test';
import type {Pool,PoolConnection,RowDataPacket} from 'mysql2/promise';
import {z} from 'zod';
import {emptyPlatformState} from '../platform-admin-domain.js';
import {createMysqlReferenceAuthority,ReferenceAccessError} from './authority.js';
import {createReferenceCrypto,referenceHash} from './crypto.js';
import {initializeReferenceSchema,MysqlReferenceRepository} from './mysql-repository.js';
import {ReferencePublication} from './publication.js';
import {fixture,syntheticOwner as owner,syntheticReferenceKey} from './publication-fixture.js';
import {createReferenceTestDatabase} from './mysql-test-support.js';
import type {ReferenceRepository} from './repository.js';
async function setup(){
  const db=await createReferenceTestDatabase();
  try{
    await db.pool.query('CREATE TABLE users (id VARCHAR(191) PRIMARY KEY,team_id VARCHAR(191),status VARCHAR(20),auth_version INT) ENGINE=InnoDB');
    await db.pool.query('CREATE TABLE platform_administration_state (id INT PRIMARY KEY,payload JSON NOT NULL) ENGINE=InnoDB');
    await db.pool.execute('INSERT INTO users VALUES (?,?,?,?)',[owner.userId,'synthetic-owner-space','active',1]);
    const state=emptyPlatformState();state.revision=1;state.memberships=[{userId:owner.userId,role:'owner',status:'active',secretEncrypted:'synthetic-unused',lastOtpCounter:0,sessionVersion:1}];
    await db.pool.execute('INSERT INTO platform_administration_state VALUES (1,?)',[JSON.stringify(state)]);
    await initializeReferenceSchema(db.pool);const crypto=createReferenceCrypto(syntheticReferenceKey);
    const repo=new MysqlReferenceRepository(db.pool,crypto),authority=createMysqlReferenceAuthority(db.pool);
    return {db,repo,authority,crypto,state,service:new ReferencePublication(repo,authority)};
  }catch(error){await db.close();throw error;}
}
async function ready(env:Awaited<ReturnType<typeof setup>>,f=fixture(),key='manifest'){
  let d=await env.service.stageRelease(owner,f.manifest,key);
  for(const p of f.pages)d=await env.service.stageSource(owner,d.id,p,d.revision,`${key}-p-${p.pageIndex}`);
  assert.equal(d.status,'ready');return d;
}
test('real MySQL stores only ciphertext and reopens published pointer, chunks, manifest and audit',async()=>{
  const env=await setup();try{
    const f=fixture(undefined,101);let d=await ready(env,f);d=await env.service.publishRelease(owner,d.id,d.revision,'synthetic acceptance','publish');
    const reopened=env.db.openPool(),crypto=createReferenceCrypto(syntheticReferenceKey),repo=new MysqlReferenceRepository(reopened,crypto);
    const service=new ReferencePublication(repo,createMysqlReferenceAuthority(reopened));
    assert.deepEqual(await service.inspect(owner,d.id),{release:d,manifest:f.manifest,activeReleaseId:d.id,sources:[{sourceHash:f.pages[0]!.sourceHash,totalChunks:101,receivedChunks:101,complete:true}]});
    assert.deepEqual(await service.list(owner,f.manifest.corpusId,1),{items:[d],activeReleaseId:d.id,nextCursor:null});
    assert.deepEqual(await service.inspectCommand(owner,f.manifest.corpusId,'stage','manifest'),{operation:'stage',outcome:'committed',requestHash:d.manifestHash,release:d});
    assert.deepEqual(await service.inspectCommand(owner,f.manifest.corpusId,'stage','not-attempted'),{operation:'stage',outcome:'not_observed'});
    const [tables]=await reopened.query<RowDataPacket[]>('SHOW TABLES');assert.equal(tables.length,9);
    const [chunks]=await reopened.query<RowDataPacket[]>('SELECT payload FROM system_reference_chunks');assert.equal(chunks.length,101);
    for(const row of chunks){assert.match(row.payload,/^sr1\./);assert.equal(row.payload.includes(f.parsed.chunks[0]!.text),false);}
    const [audits]=await reopened.query<RowDataPacket[]>('SELECT payload FROM system_reference_audits');assert.equal(audits.length,1);assert.match(audits[0]!.payload,/^sr1\./);
    const authorize=async(c?:PoolConnection)=>{assert.deepEqual(await env.authority.assertOwner(owner.userId,c),owner);};
    const schema=z.object({count:z.number()}).strict();
    await repo.transaction(f.manifest.corpusId,authorize,async tx=>{await tx.set('grant',['synthetic-grant'],{count:1});await tx.set('budget',['synthetic-budget'],{count:1});});
    await assert.rejects(repo.transaction(f.manifest.corpusId,authorize,async tx=>{await tx.set('grant',['synthetic-grant'],{count:2});await tx.set('budget',['synthetic-budget'],{count:2});throw new ReferenceAccessError(409,'synthetic_rollback');}),/synthetic_rollback/);
    assert.deepEqual(await repo.transaction(f.manifest.corpusId,authorize,async tx=>[await tx.get('grant',['synthetic-grant'],schema),await tx.get('budget',['synthetic-budget'],schema)]),[{count:1},{count:1}]);
  }finally{await env.db.close();}
});
test('real concurrent connections create one idempotent draft and only one competing candidate can publish',async()=>{
  const env=await setup();try{
    const a=await env.db.pool.getConnection(),b=await env.db.pool.getConnection();assert.notEqual(a.threadId,b.threadId);a.release();b.release();
    const f=fixture();const [x,y]=await Promise.all([env.service.stageRelease(owner,f.manifest,'same'),env.service.stageRelease(owner,f.manifest,'same')]);assert.equal(x.id,y.id);
    const xReady=await env.service.stageSource(owner,x.id,f.pages[0],x.revision,'p0'),other=await ready(env,f,'other');
    const listed=await env.service.list(owner,f.manifest.corpusId,1);assert.equal(listed.items.length,1);assert.ok(listed.nextCursor);
    const next=await env.service.list(owner,f.manifest.corpusId,1,listed.nextCursor);assert.equal(next.items.length,1);assert.equal(next.nextCursor,null);assert.notEqual(next.items[0]!.id,listed.items[0]!.id);
    assert.deepEqual(new Set([...listed.items,...next.items].map(x=>x.id)),new Set([x.id,other.id]));
    const results=await Promise.allSettled([env.service.publishRelease(owner,xReady.id,xReady.revision,'first','p1'),env.service.publishRelease(owner,other.id,other.revision,'second','p2')]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected').length,1);
    const rejected=results.find(x=>x.status==='rejected');assert.ok(rejected?.status==='rejected');assert.match(String(rejected.reason),/publication_conflict/);
    const [rows]=await env.db.pool.query<RowDataPacket[]>('SELECT payload FROM system_reference_audits');assert.equal(rows.length,1);
  }finally{await env.db.close();}
});
test('real audit-write interruption rolls back pointer and new release, retaining the old active version',async()=>{
  const env=await setup();try{
    const f=fixture();let old=await ready(env,f,'old');old=await env.service.publishRelease(owner,old.id,old.revision,'old','old-p');
    const candidate=await ready(env,f,'candidate');
    await env.db.pool.query("CREATE TRIGGER fail_reference_audit BEFORE INSERT ON system_reference_audits FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic interruption'");
    await assert.rejects(env.service.publishRelease(owner,candidate.id,candidate.revision,'new','new-p'),/persistence_unconfirmed/);
    await env.db.pool.query('DROP TRIGGER fail_reference_audit');
    const reopened=env.db.openPool(),service=new ReferencePublication(new MysqlReferenceRepository(reopened,env.crypto),createMysqlReferenceAuthority(reopened));
    const current=await service.inspect(owner,candidate.id);assert.equal(current.activeReleaseId,old.id);assert.equal(current.release.status,'ready');assert.equal(current.release.revision,candidate.revision);
    const [commands]=await reopened.execute<RowDataPacket[]>('SELECT record_id FROM system_reference_commands WHERE corpus_id=? AND record_id=?',[f.manifest.corpusId,referenceHash([owner.userId,'publish','new-p'])]);assert.equal(commands.length,0);
  }finally{await env.db.close();}
});
test('real transaction rechecks owner at commit and denies platform operators without writing a release',async()=>{
  const env=await setup();try{
    const d=await ready(env);let pending=false;
    const authority=createMysqlReferenceAuthority(env.db.pool,()=>pending);
    const fenced:ReferenceRepository={corpusForRelease:id=>env.repo.corpusForRelease(id),transaction:(corpus,authorize,op)=>env.repo.transaction(corpus,authorize,async tx=>{const result=await op(tx);pending=true;return result;})};
    await assert.rejects(new ReferencePublication(fenced,authority).publishRelease(owner,d.id,d.revision,'pending owner change','p'),/reference_forbidden/);pending=false;
    assert.equal((await env.service.inspect(owner,d.id)).activeReleaseId,null);
    env.state.memberships[0]!.role='operator';env.state.revision++;
    await env.db.pool.execute('UPDATE platform_administration_state SET payload=? WHERE id=1',[JSON.stringify(env.state)]);
    await assert.rejects(env.service.stageRelease(owner,fixture().manifest,'operator'),/owner_required/);
  }finally{await env.db.close();}
});
test('real commit followed by lost acknowledgement reports unknown once and reopens exactly one committed audit',async()=>{
  const env=await setup();try{
    const d=await ready(env);let commits=0;
    const pool=new Proxy(env.db.pool,{get(target,property){if(property==='getConnection')return async()=>{
      const connection=await target.getConnection();return new Proxy(connection,{get(c,key){if(key==='commit')return async()=>{commits++;await c.commit();throw Error('synthetic lost commit acknowledgement');};const value=Reflect.get(c,key);return typeof value==='function'?value.bind(c):value;}});
    };const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}}) as Pool;
    const service=new ReferencePublication(new MysqlReferenceRepository(pool,env.crypto),env.authority);
    await assert.rejects(service.publishRelease(owner,d.id,d.revision,'single attempt','unknown-p'),/persistence_unconfirmed/);assert.equal(commits,1);
    const reopened=env.db.openPool(),checked=new ReferencePublication(new MysqlReferenceRepository(reopened,env.crypto),createMysqlReferenceAuthority(reopened));
    assert.equal((await checked.inspect(owner,d.id)).release.status,'published');
    const [audits]=await reopened.query<RowDataPacket[]>('SELECT payload FROM system_reference_audits');assert.equal(audits.length,1);
  }finally{await env.db.close();}
});
