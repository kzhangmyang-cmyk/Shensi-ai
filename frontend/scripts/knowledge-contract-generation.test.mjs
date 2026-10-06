import assert from 'node:assert/strict';
import {test} from 'node:test';
import ts from 'typescript';
import openapiTS,{astToString} from 'openapi-typescript';
import {normalizeOpenApiDefs} from './generate-growth-contract-types.mjs';
test('optional knowledge mode and nested reused warnings compile for legacy callers',async()=>{
  const document={openapi:'3.1.0',info:{title:'fixture',version:'1.0.0'},paths:{},components:{schemas:{
    Input:{type:'object',required:['question'],properties:{question:{type:'string'},knowledgeMode:{enum:['auto','off'],default:'off'}}},
    Answer:{type:'object',properties:{knowledge:{type:'object',required:['warnings','sources'],properties:{warnings:{type:'array',items:{type:'string'}},sources:{type:'array',items:{type:'object',required:['warnings'],properties:{warnings:{$ref:'#/components/schemas/Answer/properties/knowledge/properties/warnings'}}}}}}}}
  }}};
  const source=astToString(await openapiTS(normalizeOpenApiDefs(document)))+'\nconst legacy:components["schemas"]["Input"]={question:"budget"};\ndeclare const answer:NonNullable<components["schemas"]["Answer"]["knowledge"]>;\nconst warning:string[]=answer.sources[0].warnings;';
  const filename='/virtual-contract.ts';const options={strict:true,noEmit:true,skipLibCheck:true,target:ts.ScriptTarget.ES2020};const host=ts.createCompilerHost(options);
  const read=host.getSourceFile;host.getSourceFile=(file,language,...args)=>file===filename?ts.createSourceFile(file,source,language,true):read(file,language,...args);
  const program=ts.createProgram([filename],options,host);assert.deepEqual(ts.getPreEmitDiagnostics(program).map(error=>ts.flattenDiagnosticMessageText(error.messageText,' ')),[]);
});
