import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {emptyPlatformState} from '../platform-admin-domain.js';
import {createReferenceAuthorityReader} from './authority.js';
import {BindingService} from './binding-service.js';
import {TestBindingRepository} from './binding-test-support.js';
import {ReferencePublication} from './publication.js';
import {TestReferenceRepository} from './publication-test-support.js';
import {createReferenceCrypto,type ReferenceKind} from './crypto.js';
import {fixture,parsedFixtureHash,syntheticOwner,syntheticReferenceKey} from './publication-fixture.js';
import type {SourcePage} from './domain.js';

export function retrievalFixture(corpusId=randomUUID(),matches=1,length=40,count=31){
  const f=fixture(corpusId,count);f.manifest.sources[0].title='合成参考手册';
  f.parsed.warnings=['source_incomplete','text_precision_unverified'];
  f.parsed.chunks=f.parsed.chunks.map((c,n)=>({...c,text:(n<matches?`预算执行偏差分析步骤 ${n} `:`园林种植操作 ${n} `).padEnd(n<matches?length:Math.max(100,length),'树'),
    locator:{page:1,chapter:'合成章节'},warnings:['table_precision_unverified']}));
  f.manifest.sources[0].warnings=[...f.parsed.warnings];f.manifest.sources[0].parsedHash=parsedFixtureHash(f.parsed);
  f.pages=Array.from({length:Math.ceil(count/100)},(_,pageIndex)=>({sourceHash:f.manifest.sources[0].sourceHash,pageIndex,totalChunks:count,chunks:f.parsed.chunks.slice(pageIndex*100,(pageIndex+1)*100)}));
  return f;
}
export async function retrievalEnvironment(){
  let now=Date.UTC(2026,9,8);const crypto=createReferenceCrypto(syntheticReferenceKey),repo=new TestReferenceRepository(crypto),bindings=new TestBindingRepository();
  const state=emptyPlatformState();state.revision=1;
  state.plans=[{id:'trial:1',code:'trial',version:1,features:['agents'],published:true,seatLimit:5,durationDays:7}];
  state.workspaces=[{id:'workspace',name:'Synthetic',contact:'',status:'active',planVersionId:'trial:1',startsAt:'2000-01-01T00:00:00Z',expiresAt:'2100-01-01T00:00:00Z',revision:1}];
  const user={status:'active',authVersion:1};
  const authority=createReferenceAuthorityReader({now:()=>now,readSnapshot:async id=>({user:{id,teamId:'workspace',...user},platform:structuredClone(state)})});
  const binding=new BindingService({repository:bindings,authority,issuer:'https://reference.example.test',now:()=>now});
  const publication=new ReferencePublication(repo,{...authority,assertOwner:async()=>syntheticOwner});
  const connect=async(subject='reader')=>{
    const verifier=randomBytes(32).toString('base64url'),request=await binding.create({challenge:createHash('sha256').update(verifier).digest('base64url')},'127.0.0.1');
    await binding.approve(await authority.current(subject,'workspace'),request.requestId,request.displayCode);
    const issued=await binding.exchange({requestId:request.requestId,verifier});
    return {token:issued.readerToken,context:{access:await binding.authenticateAccess(issued.readerToken),ip:'127.0.0.1'},cancel:()=>binding.cancel({requestId:request.requestId,verifier})};
  };
  const publish=async(f:ReturnType<typeof retrievalFixture>,key=randomUUID())=>{
    let d=await publication.stageRelease(syntheticOwner,f.manifest,key);
    for(const page of f.pages as SourcePage[])d=await publication.stageSource(syntheticOwner,d.id,page,d.revision,`${key}-${page.sourceHash}-${page.pageIndex}`);
    return publication.publishRelease(syntheticOwner,d.id,d.revision,'synthetic test',`${key}-publish`);
  };
  const replace=(corpusId:string,kind:ReferenceKind,key:string[],value:unknown)=>repo.rows.set(JSON.stringify([corpusId,kind,key]),crypto.seal({corpusId,kind,key},value));
  const stored=(corpusId:string,kind:ReferenceKind,key:string[])=>crypto.open({corpusId,kind,key},repo.rows.get(JSON.stringify([corpusId,kind,key]))!);
  return {repo,bindings,binding,publication,publish,connect,replace,stored,user,state,time:(n:number)=>{now=n;},now:()=>now};
}
