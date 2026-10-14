import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash,randomUUID} from 'node:crypto';

test('an application book pack is read locally with exact source text and no user database',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'shensi-embedded-pack-'));
  try{
    const pack={version:1,corpusId:randomUUID(),releaseId:randomUUID(),sources:[{
      sourceHash:'a'.repeat(64),artifactHash:'b'.repeat(64),title:'合成参考书',roles:['cfo','finance'],
      parsed:{parserVersion:'fixture.v1',coverage:{totalPages:1,extractedPages:1,missingPages:[]},warnings:['text_precision_unverified'],
        chunks:[{order:0,text:'改善现金流需要核对收付款的时间。',locator:{page:1},warnings:[]}]}
    }]};
    const bytes=gzipSync(JSON.stringify(pack)),path=join(dir,'books.json.gz');await writeFile(path,bytes);
    const module=await import('./embedded-pack.js');
    const loaded=await module.readEmbeddedReferencePack(path,createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(loaded,pack);
    await assert.rejects(module.readEmbeddedReferencePack(path,'0'.repeat(64)),/reference_pack_invalid/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('the offline pack builder includes only approved derived sources, not source files or account scope',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'shensi-embedded-builder-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const sourcePath=join(dir,'synthetic.pdf'),artifactPath=join(dir,'artifact.json'),manifestPath=join(dir,'sources.json'),output=join(dir,'pack');
  const original='synthetic PDF identity',artifact=JSON.stringify({schema_name:'DoclingDocument',version:'1.10.0',
    origin:{filename:'synthetic.pdf',mimetype:'application/pdf'},pages:{'1':{page_no:1},'2':{page_no:2}},
    body:{children:[{$ref:'#/texts/0'}]},groups:[],pictures:[],tables:[],texts:[{label:'text',text:'合成现金流核对方法',prov:[{page_no:1}]}]});
  const hash=(x:string)=>createHash('sha256').update(x).digest('hex');
  await writeFile(sourcePath,original);await writeFile(artifactPath,artifact);
  await writeFile(manifestPath,JSON.stringify({version:1,scope:{actorId:'private-user',workspaceId:'private-workspace'},sources:[{
    sourcePath,artifactPath,expectedHash:hash(original),artifactHash:hash(artifact),expectedPages:2,warnings:['source_incomplete']
  }]}),{mode:0o600});
  const {buildEmbeddedReferencePack}=await import('../../scripts/build-embedded-reference-pack.js');
  const result=await buildEmbeddedReferencePack(manifestPath,output,1);
  const {readEmbeddedReferencePack}=await import('./embedded-pack.js');
  const loaded=await readEmbeddedReferencePack(join(output,'books.json.gz'),result.sha256),serialized=JSON.stringify(loaded);
  for(const value of [dir,original,'private-user','private-workspace'])assert.equal(serialized.includes(value),false);
  assert.equal(loaded.sources.length,1);assert.equal(loaded.sources[0].parsed.chunks[0].text,'合成现金流核对方法');
  assert.deepEqual(loaded.sources[0].roles,['cfo','finance','cost','cashflow','profit','tax']);
  assert.ok(loaded.sources[0].parsed.warnings.includes('source_incomplete'));
  assert.deepEqual(loaded.sources[0].parsed.coverage.missingPages,[2]);
  assert.equal(JSON.parse(await readFile(join(output,'manifest.json'),'utf8')).sha256,result.sha256);
  await assert.rejects(buildEmbeddedReferencePack(manifestPath,output,1));
  await assert.rejects(buildEmbeddedReferencePack(manifestPath,join(dir,'wrong-count'),21),/reference_pack_build_invalid/);
});
