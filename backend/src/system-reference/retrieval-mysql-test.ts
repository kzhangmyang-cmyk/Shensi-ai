import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Pool,RowDataPacket} from 'mysql2/promise';
import {emptyPlatformState} from '../platform-admin-domain.js';
import {createMysqlReferenceAuthority} from './authority.js';
import {BindingService} from './binding-service.js';
import {initializeReferenceBindings,MysqlBindingRepository} from './mysql-bindings.js';
import {initializeReferenceSchema,MysqlReferenceRepository} from './mysql-repository.js';
import {createReferenceCrypto} from './crypto.js';
import {createReferenceTestDatabase} from './mysql-test-support.js';
import {ReferencePublication} from './publication.js';
import {SystemReferenceService} from './retrieval.js';
import {retrievalFixture} from './retrieval-test-support.js';
import {syntheticOwner as owner,syntheticReferenceKey} from './publication-fixture.js';
import type {ReferenceQuery,QueryResult} from './domain.js';
import type {ReferenceRepository} from './repository.js';
const input=():ReferenceQuery=>({vocabularyVersion:'finance-topics.v1',topicIds:['budget_variance'],role:'finance',requestId:randomUUID()});
const used=(r:QueryResult)=>{assert.equal(r.status,'used');if(r.status!=='used')throw Error('expected used');return r;};
async function setup(){
  const db=await createReferenceTestDatabase();let now=Date.UTC(2026,9,8);
  try{
    await db.pool.query('CREATE TABLE users (id VARCHAR(191) PRIMARY KEY,team_id VARCHAR(191),status VARCHAR(20),auth_version INT) ENGINE=InnoDB');
    await db.pool.query('CREATE TABLE platform_administration_state (id INT PRIMARY KEY,payload JSON NOT NULL) ENGINE=InnoDB');
    for(const id of [owner.userId,'reader','other'])await db.pool.execute('INSERT INTO users VALUES (?,?,?,?)',[id,'workspace','active',1]);
    const state=emptyPlatformState();state.revision=1;state.memberships=[{userId:owner.userId,role:'owner',status:'active',secretEncrypted:'synthetic-unused',lastOtpCounter:0,sessionVersion:1}];
    state.plans=[{id:'trial:1',code:'trial',version:1,features:['agents'],published:true,seatLimit:5,durationDays:7}];
    state.workspaces=[{id:'workspace',name:'Synthetic',contact:'',status:'active',planVersionId:'trial:1',startsAt:'2000-01-01T00:00:00Z',expiresAt:'2100-01-01T00:00:00Z',revision:1}];
    await db.pool.execute('INSERT INTO platform_administration_state VALUES (1,?)',[JSON.stringify(state)]);
    await initializeReferenceBindings(db.pool);await initializeReferenceSchema(db.pool);
    const authority=createMysqlReferenceAuthority(db.pool),crypto=createReferenceCrypto(syntheticReferenceKey),repo=new MysqlReferenceRepository(db.pool,crypto);
    const publication=new ReferencePublication(repo,authority),f=retrievalFixture();
    const connect=async(subject='reader',pool:Pool=db.pool)=>{
      const a=createMysqlReferenceAuthority(pool),b=new BindingService({repository:new MysqlBindingRepository(pool),authority:a,issuer:'https://reference.example.test',now:()=>now});
      const verifier=randomBytes(32).toString('base64url'),r=await b.create({challenge:createHash('sha256').update(verifier).digest('base64url')},'127.0.0.1');
      await b.approve(await a.current(subject,'workspace'),r.requestId,r.displayCode);const issued=await b.exchange({requestId:r.requestId,verifier});
      return {access:await b.authenticateAccess(issued.readerToken),ip:'127.0.0.1'};
    };
    const publish=async()=>{const key=randomUUID();let d=await publication.stageRelease(owner,f.manifest,key);
      for(const p of f.pages)d=await publication.stageSource(owner,d.id,p,d.revision,`${key}-${p.pageIndex}`);
      return publication.publishRelease(owner,d.id,d.revision,'synthetic publication',`${key}-publish`);
    };
    const release=await publish(),context=await connect(),service=new SystemReferenceService(repo,{corpusId:f.manifest.corpusId,now:()=>now});
    const rows=async()=>{const out:unknown[]=[];for(const table of ['grants','budgets','audits']){const [r]=await db.pool.execute<RowDataPacket[]>(`SELECT record_id,payload FROM system_reference_${table} WHERE corpus_id=? ORDER BY record_id`,[f.manifest.corpusId]);out.push(r);}return out;};
    return {db,repo,crypto,f,release,publication,publish,connect,context,service,rows,now:()=>now,time:(n:number)=>{now=n;}};
  }catch(error){await db.close();throw error;}
}
test('real publication to lexical query reopens exact citations and rejects cross-reader or superseded grants',async()=>{
  const e=await setup();try{
    const r=used(await e.service.query(e.context,input()));assert.equal(r.sources.length,1);assert.equal(r.sources[0].excerpt,e.f.parsed.chunks[0].text);
    const pool=e.db.openPool(),service=new SystemReferenceService(new MysqlReferenceRepository(pool,e.crypto),{corpusId:e.f.manifest.corpusId,now:e.now});
    const context=await e.connect('reader',pool);
    assert.deepEqual(await service.citation(context,r.grantId,r.sources[0].referenceId),r.sources[0]);
    assert.deepEqual(await service.check(context,r.grantId),{valid:true,grantId:r.grantId,releaseId:e.release.id});
    const other=await e.connect('other',pool);await assert.rejects(service.check(other,r.grantId),/not_found/);
    const next=await e.publish();await assert.rejects(service.check(context,r.grantId),/not_found/);
    assert.equal(used(await service.query(context,input())).releaseId,next.id);
  }finally{await e.db.close();}
});
test('real retrieval rolls back disclosure on audit failure and commit-time grant expiry',async()=>{
  const e=await setup();try{
    const before=await e.rows();
    await e.db.pool.query("CREATE TRIGGER fail_reader_audit BEFORE INSERT ON system_reference_audits FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic interruption'");
    await assert.rejects(e.service.query(e.context,input()),/reference_unavailable/);assert.deepEqual(await e.rows(),before);
    await e.db.pool.query('DROP TRIGGER fail_reader_audit');
    const r=used(await e.service.query(e.context,input())),base=e.now(),DAY=86400000;e.time(base+29*DAY);const context=await e.connect();
    const old=await e.rows(),fenced:ReferenceRepository={corpusForRelease:id=>e.repo.corpusForRelease(id),transaction:(corpus,auth,op)=>e.repo.transaction(corpus,auth,async tx=>{const value=await op(tx);e.time(base+30*DAY);return value;})};
    await assert.rejects(new SystemReferenceService(fenced,{corpusId:e.f.manifest.corpusId,now:e.now}).check(context,r.grantId),/grant_invalid/);
    assert.deepEqual(await e.rows(),old);
  }finally{await e.db.close();}
});
