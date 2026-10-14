import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import type {Pool,RowDataPacket} from 'mysql2/promise';
import {knowledgeContext} from '../../test/knowledge-fixture.js';
import {emptyPlatformState} from '../platform-admin-domain.js';
import {ReferenceAccessError} from './authority.js';
import {CompositeReferenceRetriever} from './composite-retrieval.js';
import {createReferenceCrypto,referenceHash} from './crypto.js';
import type {PreparedReferences,ReferenceRole,SystemReference} from './domain.js';
import type {EmbeddedReferencePack} from './embedded-pack.js';
import {EmbeddedReferenceService} from './embedded-reference.js';
import {createMysqlLocalReferenceIdentity} from './local-identity.js';
import {initializeReferenceSchema,MysqlReferenceRepository} from './mysql-repository.js';
import {createReferenceTestDatabase} from './mysql-test-support.js';

// Synthetic local identity + Composite + real SQL only: this is not an HTTP
// login, a live answer-model call, a real-book test or a mysqld restart claim.
const roles:ReferenceRole[]=['cfo','finance','cost','cashflow','profit','tax'];
const actors=['existing-local-user','new-local-user'];
const question='改善现金流应该先核对哪些收付款数据？';
const accessError=(status:number,code:string)=>(error:unknown)=>error instanceof ReferenceAccessError&&error.status===status&&error.code===code;
async function setup(){
  const db=await createReferenceTestDatabase(),secret=randomBytes(32).toString('hex');
  const pack:EmbeddedReferencePack={version:1,corpusId:randomUUID(),releaseId:randomUUID(),sources:[{
    sourceHash:'a'.repeat(64),artifactHash:'b'.repeat(64),title:'合成内置现金流参考',roles,
    parsed:{parserVersion:'fixture.v1',coverage:{totalPages:1,extractedPages:1,missingPages:[]},warnings:['text_precision_unverified'],
      chunks:[{order:0,text:'改善现金流需要先核对收付款的时间与预算差异。',locator:{page:1,chapter:'合成方法'},warnings:['table_precision_unverified']}]}
  }]};
  const state=emptyPlatformState();state.revision=1;
  state.plans=[{id:'synthetic:1',code:'trial',version:1,features:['agents'],published:true,seatLimit:5,durationDays:7}];
  state.workspaces=[{id:'team-a',name:'Synthetic',contact:'',status:'active',planVersionId:'synthetic:1',startsAt:'2000-01-01T00:00:00Z',expiresAt:'2100-01-01T00:00:00Z',revision:1}];
  const services:EmbeddedReferenceService[]=[];
  try{
    await db.pool.query('CREATE TABLE users (id VARCHAR(191) PRIMARY KEY,team_id VARCHAR(191),role VARCHAR(30),status VARCHAR(20),auth_version INT) ENGINE=InnoDB');
    await db.pool.query('CREATE TABLE platform_administration_state (id INT PRIMARY KEY,payload JSON NOT NULL) ENGINE=InnoDB');
    for(const actor of actors)await db.pool.execute('INSERT INTO users VALUES (?,?,?,?,?)',[actor,'team-a','admin','active',1]);
    await db.pool.execute('INSERT INTO platform_administration_state VALUES (1,?)',[JSON.stringify(state)]);
    await initializeReferenceSchema(db.pool);
    const serviceFor=(pool:Pool)=>{const service=new EmbeddedReferenceService({pack,repository:new MysqlReferenceRepository(pool,createReferenceCrypto(secret)),current:createMysqlLocalReferenceIdentity(pool)});services.push(service);return service;};
    const grantRows=async()=>{const [rows]=await db.pool.execute<RowDataPacket[]>('SELECT record_id,payload FROM system_reference_grants WHERE corpus_id=?',[pack.corpusId]);return rows;};
    return {db,pack,state,serviceFor,grantRows,async close(){for(const service of services)service.close();await db.close();}};
  }catch(error){await db.close();throw error;}
}
async function prepare(service:EmbeddedReferenceService,actor:string,role:ReferenceRole='cfo'){
  const ctx=knowledgeContext(actor),prepared=await new CompositeReferenceRetriever({embedded:service}).prepare(ctx,{question,role,knowledgeMode:'auto',referenceProtocol:'system-v1'});
  assert.equal(prepared.libraryStatus.system,'ready');assert.equal(prepared.evidence.status,'used');assert.equal(prepared.evidence.sources.length,1);
  const source=prepared.evidence.sources[0];assert.equal(source.sourceType,'system');if(source.sourceType!=='system')throw Error('system_source_required');
  await prepared.assertCurrent();return {ctx,prepared,source};
}

test('two actual local identities use all six agents by default; encrypted grants reopen in a fresh service and pool',async()=>{
  const e=await setup();try{
    const before=JSON.stringify(e.pack),service=e.serviceFor(e.db.pool),records:{actor:string;source:SystemReference}[]=[];
    await service.ready();
    for(const actor of actors){
      assert.deepEqual(await service.status(knowledgeContext(actor)),{status:'embedded_ready',generation:0});
      for(const role of roles){
        const {source}=await prepare(service,actor,role),chunk=e.pack.sources[0].parsed.chunks[0];
        assert.equal(source.corpusId,e.pack.corpusId);assert.equal(source.releaseId,e.pack.releaseId);
        assert.equal(source.sourceHash,e.pack.sources[0].sourceHash);assert.equal(source.chunkHash,referenceHash(chunk));
        assert.equal(source.excerpt,chunk.text);assert.equal(source.sourceLabel,e.pack.sources[0].title);
        assert.deepEqual(source.locator,chunk.locator);assert.deepEqual(source.excerptRange,{start:0,end:chunk.text.length});
        assert.deepEqual(source.warnings,['text_precision_unverified','table_precision_unverified']);records.push({actor,source});
      }
    }
    const rows=await e.grantRows();assert.equal(rows.length,12);
    for(const row of rows){
      assert.match(row.record_id,/^[a-f0-9]{64}$/u);assert.match(row.payload,/^sr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
      for(const value of [e.pack.sources[0].parsed.chunks[0].text,e.pack.sources[0].title,...actors,...records.map(r=>r.source.queryGrantId)])assert.equal(row.payload.includes(value),false);
    }
    service.close();const reopened=e.serviceFor(e.db.openPool());
    for(const {actor,source} of records){
      assert.deepEqual(await reopened.citation(knowledgeContext(actor),source.queryGrantId,source.referenceId),source);
      await reopened.assertCurrent(knowledgeContext(actor),source.queryGrantId);
      const other=actors.find(value=>value!==actor)!;
      await assert.rejects(reopened.citation(knowledgeContext(other),source.queryGrantId,source.referenceId),accessError(404,'reference_not_found'));
      await assert.rejects(reopened.assertCurrent(knowledgeContext(other),source.queryGrantId),accessError(404,'reference_not_found'));
    }
    assert.equal((await e.grantRows()).length,12);assert.equal(JSON.stringify(e.pack),before);
    const [tables]=await e.db.pool.query<RowDataPacket[]>('SHOW TABLES');
    assert.equal(tables.some(row=>Object.values(row).some(value=>/binding|connection|knowledge_/u.test(String(value)))),false);
  }finally{await e.close();}
});

test('a one-connection real pool prepares and rereads grants without another checkout; auth-version changes revoke old grants',async()=>{
  const e=await setup();try{
    const service=e.serviceFor(e.db.openPool(1)),first=await prepare(service,actors[0]);
    assert.deepEqual(await service.citation(first.ctx,first.source.queryGrantId,first.source.referenceId),first.source);
    await e.db.pool.execute('UPDATE users SET auth_version=2 WHERE id=?',[actors[0]]);
    await assert.rejects(first.prepared.assertCurrent(),/knowledge_reference_stale/u);
    await assert.rejects(service.citation(first.ctx,first.source.queryGrantId,first.source.referenceId),accessError(404,'reference_not_found'));
    const next=await prepare(service,actors[0],'finance');assert.notEqual(next.source.queryGrantId,first.source.queryGrantId);
    assert.equal((await e.grantRows()).length,2);
  }finally{await e.close();}
});

test('durable account and workspace disablement deny existing citations and new preparation without deleting the readonly pack',async()=>{
  const e=await setup();try{
    const service=e.serviceFor(e.db.pool),first=await prepare(service,actors[0]),second=await prepare(service,actors[1]);
    const prepared:PreparedReferences=first.prepared;
    await e.db.pool.execute('UPDATE users SET status=? WHERE id=?',['disabled',actors[0]]);
    await assert.rejects(prepared.assertCurrent(),/knowledge_reference_stale/u);
    await assert.rejects(service.status(first.ctx),accessError(401,'reference_connection_changed'));
    await assert.rejects(service.citation(first.ctx,first.source.queryGrantId,first.source.referenceId),accessError(401,'reference_connection_changed'));
    await assert.rejects(prepare(service,actors[0]),/knowledge_reference_stale/u);
    assert.deepEqual(await service.citation(second.ctx,second.source.queryGrantId,second.source.referenceId),second.source);
    e.state.workspaces[0].status='suspended';e.state.revision++;
    await e.db.pool.execute('UPDATE platform_administration_state SET payload=? WHERE id=1',[JSON.stringify(e.state)]);
    await assert.rejects(second.prepared.assertCurrent(),/knowledge_reference_stale/u);
    await assert.rejects(service.citation(second.ctx,second.source.queryGrantId,second.source.referenceId),accessError(401,'reference_connection_changed'));
    await assert.rejects(prepare(service,actors[1]),/knowledge_reference_stale/u);
    assert.equal((await e.grantRows()).length,2);
  }finally{await e.close();}
});
