import assert from 'node:assert/strict';
import {test} from 'node:test';
import ts from 'typescript';
import openapiTS,{astToString} from 'openapi-typescript';
import {normalizeOpenApiDefs} from './generate-growth-contract-types.mjs';
import {readFile} from 'node:fs/promises';
test('optional knowledge mode and nested reused warnings compile for legacy callers',async()=>{
  const document={openapi:'3.1.0',info:{title:'fixture',version:'1.0.0'},paths:{},components:{schemas:{
    Input:{type:'object',required:['question'],properties:{question:{type:'string'},knowledgeMode:{enum:['auto','off'],default:'off'},webSearchMode:{enum:['on','off']}}},
    Answer:{type:'object',properties:{knowledge:{type:'object',required:['warnings','sources'],properties:{warnings:{type:'array',items:{type:'string'}},sources:{type:'array',items:{type:'object',required:['warnings'],properties:{warnings:{$ref:'#/components/schemas/Answer/properties/knowledge/properties/warnings'}}}}}}}}
  }}};
  const source=astToString(await openapiTS(normalizeOpenApiDefs(document)))+'\nconst legacy:components["schemas"]["Input"]={question:"budget"};\nconst online:components["schemas"]["Input"]={question:"budget",webSearchMode:"on"};\nconst offline:components["schemas"]["Input"]={question:"budget",webSearchMode:"off"};\n// @ts-expect-error invalid search mode\nconst invalid:components["schemas"]["Input"]={question:"budget",webSearchMode:"auto"};\ndeclare const answer:NonNullable<components["schemas"]["Answer"]["knowledge"]>;\nconst warning:string[]=answer.sources[0].warnings;';
  const filename='/virtual-contract.ts';const options={strict:true,noEmit:true,skipLibCheck:true,target:ts.ScriptTarget.ES2020};const host=ts.createCompilerHost(options);
  const read=host.getSourceFile;host.getSourceFile=(file,language,...args)=>file===filename?ts.createSourceFile(file,source,language,true):read(file,language,...args);
  const program=ts.createProgram([filename],options,host);assert.deepEqual(ts.getPreEmitDiagnostics(program).map(error=>ts.flattenDiagnosticMessageText(error.messageText,' ')),[]);
});

test('the actual pinned Growth header stays optional, explicit and limited to system-v1', async () => {
  const generated = await readFile(new URL('../src/generated/growth-advisor-quote-roi.ts', import.meta.url), 'utf8');
  const source = generated + `
type Header = NonNullable<operations['getCfoSession']['parameters']['header']>;
const legacyReader: Header = {};
const supportedReader: Header = {'X-Shensi-Reference-Protocol': 'system-v1'};
// @ts-expect-error unsupported reference protocol
const unknownReader: Header = {'X-Shensi-Reference-Protocol': 'unknown'};
type Responses = operations['getCfoSession']['responses'];
declare const upgrade: Responses[409]['content']['application/json'];
if ('code' in upgrade) { const code: string = upgrade.code; }
declare const invalid: Responses[422]['content']['application/json'];
if ('retryable' in invalid) { const retryable: boolean = invalid.retryable; }
`;
  const filename = '/virtual-reader-contract.ts', options = {strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2020};
  const host = ts.createCompilerHost(options), read = host.getSourceFile;
  host.getSourceFile = (file, language, ...args) => file === filename ? ts.createSourceFile(file, source, language, true) : read(file, language, ...args);
  assert.deepEqual(ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host)).map(error => ts.flattenDiagnosticMessageText(error.messageText, ' ')), []);
});

test('a locator reused inside the source union compiles without indexing optional knowledge or schema-only items',async()=>{
  const document={openapi:'3.1.0',info:{title:'fixture',version:'1.0.0'},paths:{},components:{schemas:{
    Answer:{type:'object',properties:{knowledge:{type:'object',required:['sources'],properties:{sources:{type:'array',items:{oneOf:[
      {type:'object',required:['documentId','locator'],properties:{sourceType:{const:'private'},documentId:{type:'string'},locator:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,maximum:1000},chapter:{type:'string',maxLength:300}}}}},
      {type:'object',required:['sourceType','referenceId','locator'],properties:{sourceType:{const:'system'},referenceId:{type:'string'},locator:{$ref:'#/components/schemas/Answer/properties/knowledge/properties/sources/items/oneOf/0/properties/locator'}}}
    ]}}}}}}
  }}};
  const wire=JSON.stringify(document);
  const source=astToString(await openapiTS(normalizeOpenApiDefs(structuredClone(document))))+`
declare const answer:NonNullable<components['schemas']['Answer']['knowledge']>;
const page:number|undefined=answer.sources[0].locator.page;
if(answer.sources[0].sourceType==='system'){
  const reference:string=answer.sources[0].referenceId;
  // @ts-expect-error system must remain distinct from private
  const document=answer.sources[0].documentId;
}`;
  const filename='/virtual-union-contract.ts',options={strict:true,noEmit:true,skipLibCheck:true,target:ts.ScriptTarget.ES2020};
  const host=ts.createCompilerHost(options),read=host.getSourceFile;
  host.getSourceFile=(file,language,...args)=>file===filename?ts.createSourceFile(file,source,language,true):read(file,language,...args);
  assert.deepEqual(ts.getPreEmitDiagnostics(ts.createProgram([filename],options,host)).map(error=>ts.flattenDiagnosticMessageText(error.messageText,' ')),[]);
  assert.equal(JSON.stringify(document),wire);
});
