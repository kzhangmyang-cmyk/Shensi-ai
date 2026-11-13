import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import ts from 'typescript';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const generator=path.join(root,'scripts/generate-frontend-contract-types.mjs');
function diagnostics(source){
  const filename='/virtual-knowledge-consumer.ts',options={strict:true,noEmit:true,skipLibCheck:true,target:ts.ScriptTarget.ES2020};
  const host=ts.createCompilerHost(options),read=host.getSourceFile;
  host.getSourceFile=(file,language,...args)=>file===filename?ts.createSourceFile(file,source,language,true):read(file,language,...args);
  return ts.getPreEmitDiagnostics(ts.createProgram([filename],options,host)).map(error=>ts.flattenDiagnosticMessageText(error.messageText,' '));
}
async function generate(input,consumer){
  const directory=await mkdtemp(path.join(tmpdir(),'shensi-knowledge-types-'));
  try{
    const source=typeof input==='string'?input:path.join(directory,'input.json');
    if(typeof input!=='string')await writeFile(source,JSON.stringify(input));
    const output=path.join(directory,'output.ts');
    const original=await readFile(source,'utf8');
    const result=spawnSync(process.execPath,[generator,'--input',source,'--output',output],{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.equal(await readFile(source,'utf8'),original,'generation must not rewrite wire input');
    assert.deepEqual(diagnostics((await readFile(output,'utf8'))+'\n'+consumer),[]);
  }finally{await rm(directory,{recursive:true,force:true});}
}
test('decision CFO input remains compatible when legacy callers omit reference mode',async()=>{
  const dependencies=['json-schema/cfo-conversation.v1.schema.json','json-schema/knowledge.v1.schema.json'];
  const originals=await Promise.all(dependencies.map(file=>readFile(path.join(root,file),'utf8')));
  await generate(path.join(root,'openapi/decision-simulation.v1.yaml'),
    'const legacy:components["schemas"]["$defs-Input"]={role:"cfo",question:"budget",history:[]};');
  assert.deepEqual(await Promise.all(dependencies.map(file=>readFile(path.join(root,file),'utf8'))),originals,'transitive wire schemas must stay unchanged');
});
test('only optional knowledge mode defaults relax, without changing required mode or unrelated defaults',async()=>{
  await generate({openapi:'3.1.0',info:{title:'fixture',version:'1.0.0'},paths:{},components:{schemas:{
    Optional:{type:'object',required:['question'],properties:{question:{type:'string'},knowledgeMode:{type:'string',enum:['auto','off'],default:'off'},role:{type:'string',default:'cfo'}}},
    Mandatory:{type:'object',required:['knowledgeMode'],properties:{knowledgeMode:{type:'string',enum:['auto','off'],default:'off'}}}
  }}},
  'const legacy:components["schemas"]["Optional"]={question:"budget",role:"cfo"};\n'+
  '// @ts-expect-error required mode must stay required\nconst missingMode:components["schemas"]["Mandatory"]={};\n'+
  '// @ts-expect-error unrelated default inference is unchanged\nconst missingRole:components["schemas"]["Optional"]={question:"budget"};');
});

test('generated system references require explicit source discrimination and keep safe connection DTO closed',async()=>{
  await generate(path.join(root,'openapi/system-reference.v1.yaml'), `
type Sources = components['schemas']['ReferenceCitation'];
declare const citation: Sources;
if (citation.sourceType === 'system') {
  const grant: string = citation.queryGrantId;
  // @ts-expect-error system references cannot open a private document
  const document = citation.documentId;
} else { const document: string = citation.documentId; }
const connection: components['schemas']['ConnectionStatus'] = {status:'unbound',generation:0};
// @ts-expect-error credentials are not safe renderer connection state
const leaked: components['schemas']['ConnectionStatus'] = {status:'ready',generation:1,readerToken:'secret'};
// @ts-expect-error raw company questions cannot be sent to central query
const query: components['schemas']['ReferenceQuery'] = {vocabularyVersion:'finance-topics.v1',topicIds:['budget_variance'],role:'cfo',requestId:'id',question:'private'};
`);
});

test('new topic protocol stays optional for generated legacy and explicit text callers',async()=>{
  await generate(path.join(root,'openapi/decision-simulation.v1.yaml'), `
const legacy: components['schemas']['$defs-Input'] = {role:'cfo',question:'budget',history:[]};
const current: components['schemas']['$defs-Input'] = {...legacy,referenceProtocol:'system-v1',referenceTopicIds:['budget_variance']};
// @ts-expect-error arbitrary topic cannot carry private text
const unknown: components['schemas']['$defs-Input'] = {...legacy,referenceProtocol:'system-v1',referenceTopicIds:['private-company']};
`);
});
