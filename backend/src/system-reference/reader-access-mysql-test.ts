import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Pool,RowDataPacket} from 'mysql2/promise';
import {emptyPlatformState} from '../platform-admin-domain.js';
import {createMysqlReferenceAuthority} from './authority.js';
import {BindingService,referenceAccessProof} from './binding-service.js';
import {initializeReferenceBindings,MysqlBindingRepository} from './mysql-bindings.js';
import {initializeReferenceSchema,MysqlReferenceRepository} from './mysql-repository.js';
import {createReferenceCrypto} from './crypto.js';
import {createReferenceTestDatabase} from './mysql-test-support.js';
import {syntheticReferenceKey,fixtureHash} from './publication-fixture.js';
import {consumeReferenceRate,recordReferenceGrant} from './grants.js';
const base=Date.UTC(2026,9,8),DAY=86400000;
async function setup(){
  const db=await createReferenceTestDatabase();let now=base;
  try{
    await db.pool.query('CREATE TABLE users (id VARCHAR(191) PRIMARY KEY,team_id VARCHAR(191),status VARCHAR(20),auth_version INT) ENGINE=InnoDB');
    await db.pool.query('CREATE TABLE platform_administration_state (id INT PRIMARY KEY,payload JSON NOT NULL) ENGINE=InnoDB');
    await db.pool.execute('INSERT INTO users VALUES (?,?,?,?)',['reader','workspace','active',1]);
    const state=emptyPlatformState();state.revision=1;
    state.plans=[{id:'trial:1',code:'trial',version:1,features:['agents'],published:true,seatLimit:5,durationDays:7}];
    state.workspaces=[{id:'workspace',name:'Synthetic',contact:'',status:'active',planVersionId:'trial:1',startsAt:'2000-01-01T00:00:00Z',expiresAt:'2100-01-01T00:00:00Z',revision:1}];
    await db.pool.execute('INSERT INTO platform_administration_state VALUES (1,?)',[JSON.stringify(state)]);
    await initializeReferenceBindings(db.pool);await initializeReferenceSchema(db.pool);
    const authority=createMysqlReferenceAuthority(db.pool),issuer='https://library.example.test';
    const binding=new BindingService({repository:new MysqlBindingRepository(db.pool),authority,issuer,now:()=>now});
    const verifier=randomBytes(32).toString('base64url'),request=await binding.create({challenge:createHash('sha256').update(verifier).digest('base64url')},'127.0.0.1');
    await binding.approve(await authority.current('reader','workspace'),request.requestId,request.displayCode);
    const issued=await binding.exchange({requestId:request.requestId,verifier}),corpusId=randomUUID(),releaseId=randomUUID();
    const repo=new MysqlReferenceRepository(db.pool,createReferenceCrypto(syntheticReferenceKey));
    const candidate={sourceHash:fixtureHash('synthetic-source'),chunkHash:fixtureHash('synthetic-chunk'),excerpt:'合成预算偏差参考',sourceLabel:'合成参考',locator:{page:1},warnings:['text_precision_unverified'],indexedCharacters:10000};
    const write=async(tx:Parameters<Parameters<typeof repo.transaction>[2]>[0],access:Awaited<ReturnType<typeof binding.authenticateAccess>>)=>{
      const p=referenceAccessProof(access);
      assert.equal(await consumeReferenceRate(tx,{subjectId:p.reader.subjectId,bindingId:p.bindingId,ip:'127.0.0.1',operation:'query',now}),true);
      return recordReferenceGrant(tx,{reader:p.reader,corpusId,releaseId,requestId:randomUUID(),candidates:[candidate],now});
    };
    const counts=async()=>{const out:number[]=[];for(const table of ['grants','budgets','audits']){const [rows]=await db.pool.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM system_reference_${table} WHERE corpus_id=?`,[corpusId]);out.push(Number(rows[0]!.n));}return out;};
    return {db,authority,issuer,binding,request,verifier,issued,repo,corpusId,write,counts,time:(n:number)=>{now=n;},clock:()=>now};
  }catch(error){await db.close();throw error;}
}
test('real binding and reference adapters reopen a proof, then durable cancellation blocks new grants',async()=>{
  const e=await setup();try{
    const pool=e.db.openPool(),binding=new BindingService({repository:new MysqlBindingRepository(pool),authority:createMysqlReferenceAuthority(pool),issuer:e.issuer,now:e.clock});
    const access=await binding.authenticateAccess(e.issued.readerToken),proof=referenceAccessProof(access);
    assert.equal((await e.repo.transaction(e.corpusId,proof.authorize,tx=>e.write(tx,access))).status,'used');
    assert.deepEqual(await e.counts(),[1,5,1]);
    await binding.cancel({requestId:e.request.requestId,verifier:e.verifier});
    await assert.rejects(e.repo.transaction(e.corpusId,proof.authorize,tx=>e.write(tx,access)),/reader_invalid/);
    await assert.rejects(e.binding.authenticateAccess(e.issued.readerToken),/reader_invalid/);
    assert.deepEqual(await e.counts(),[1,5,1]);
  }finally{await e.db.close();}
});
test('real binding shared lock remains held through grant commit; cancellation cannot jump ahead of its holder',async()=>{
  const e=await setup();let release:()=>void=()=>{};let pending:Promise<unknown>|undefined;
  try{
    const access=await e.binding.authenticateAccess(e.issued.readerToken),proof=referenceAccessProof(access);
    let entered:()=>void=()=>{};const inOperation=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{release=r;});
    pending=e.repo.transaction(e.corpusId,proof.authorize,async tx=>{const result=await e.write(tx,access);entered();await hold;return result;});
    // Avoid an unhandled rejection if the transaction unexpectedly fails before its barrier.
    await Promise.race([inOperation,pending.then(()=>{throw Error('transaction ended before barrier');})]);
    const separate=e.db.openPool();
    const timeoutPool=new Proxy(separate,{get(target,key){if(key==='getConnection')return async()=>{const c=await target.getConnection();await c.query('SET SESSION innodb_lock_wait_timeout=1');return c;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as Pool;
    const cancelling=new BindingService({repository:new MysqlBindingRepository(timeoutPool),authority:createMysqlReferenceAuthority(separate),issuer:e.issuer,now:e.clock});
    // A one-second session-local timeout proves an actual InnoDB lock conflict;
    // this is not a sleep-and-guess assertion or an automatic cancel retry.
    await assert.rejects(cancelling.cancel({requestId:e.request.requestId,verifier:e.verifier}),/persistence_unconfirmed/);
    release();const result=await pending;assert.equal((result as {status:string}).status,'used');assert.deepEqual(await e.counts(),[1,5,1]);
    // A distinct synthetic operation after the holder commits now cancels normally.
    await e.binding.cancel({requestId:e.request.requestId,verifier:e.verifier});
    await assert.rejects(e.repo.transaction(e.corpusId,proof.authorize,tx=>e.write(tx,access)),/reader_invalid/);
  }finally{release();await pending?.catch(()=>{});await e.db.close();}
});
test('real commit-time token expiry rolls back grants, all budget buckets and audit together',async()=>{
  const e=await setup();try{
    const access=await e.binding.authenticateAccess(e.issued.readerToken),proof=referenceAccessProof(access);
    await assert.rejects(e.repo.transaction(e.corpusId,proof.authorize,async tx=>{const result=await e.write(tx,access);e.time(base+7*DAY);return result;}),/reader_invalid/);
    assert.deepEqual(await e.counts(),[0,0,0]);
  }finally{await e.db.close();}
});
