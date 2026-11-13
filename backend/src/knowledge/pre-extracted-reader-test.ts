import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validatePreExtractedSource, createPreExtractedKnowledgeReader } from './pre-extracted-reader.js';

// Breaks caught: wrong-source reuse, lost physical provenance/quality, fabricated
// coverage, and reparsing a known source instead of the authorized local artifact.
async function fixture(t: test.TestContext) {
  const root=await mkdtemp(join(tmpdir(),'knowledge-reference-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const sourcePath=join(root,'reference.pdf'),artifactPath=join(root,'document.json');
  const original=Buffer.from('%PDF-1.7\nsynthetic source identity; physical-page count was preverified\n');
  await writeFile(sourcePath,original,{mode:0o600});
  const document={schema_name:'DoclingDocument',version:'1.10.0',origin:{filename:'reference.pdf',mimetype:'application/pdf'},
    pages:{'1':{page_no:1},'2':{page_no:2},'3':{page_no:3}},groups:[],pictures:[],
    body:{children:[{$ref:'#/texts/0'},{$ref:'#/texts/1'},{$ref:'#/tables/0'},{$ref:'#/texts/2'}]},
    texts:[{label:'section_header',text:'预算方法',prov:[{page_no:1,charspan:[0,4]}]},
      {label:'text',text:'预算需要结合企业实际经营条件。',prov:[{page_no:1,charspan:[0,15]}]},
      {label:'formula',text:'合成公式，需核对。',prov:[{page_no:3,charspan:[0,9]}]}],
    tables:[{label:'table',prov:[{page_no:2,charspan:[0,0]}],data:{table_cells:[{text:'合成待核对金额',start_row_offset_idx:0,start_col_offset_idx:1}]}}]};
  await writeFile(artifactPath,JSON.stringify(document),{mode:0o600});
  return {sourcePath,artifactPath,expectedHash:createHash('sha256').update(original).digest('hex'),expectedPages:3,
    warnings:['ocr_unverified','source_incomplete'],original,document};
}
test('pre-extracted imports preserve physical provenance and uncertainty without modifying the source',async t=>{
  const f=await fixture(t),parsed=await validatePreExtractedSource(f);
  assert.deepEqual(parsed.coverage,{totalPages:3,extractedPages:3,missingPages:[]});
  assert.ok(parsed.warnings.includes('table_unverified'));assert.ok(parsed.warnings.includes('source_incomplete'));
  assert.deepEqual(parsed.chunks.map(x=>x.locator.page),[1,1,2,3]);
  assert.equal(parsed.chunks[1].locator.chapter,'预算方法');
  assert.equal(parsed.chunks[2].locator.row,1);assert.equal(parsed.chunks[2].locator.column,2);
  assert.ok(parsed.chunks[3].warnings.includes('formula_unverified'));
  assert.deepEqual(await readFile(f.sourcePath),f.original);
});
test('known sources bypass OCR, unknown sources use the normal reader, and changed originals cannot reuse artifacts',async t=>{
  const f=await fixture(t);let ocrCalls=0;const previous=await validatePreExtractedSource(f);
  const fallback={async read(){ocrCalls++;return previous;}};
  const scope={workspaceId:'ws-one',actorId:'actor-one'};
  const reader=createPreExtractedKnowledgeReader({sources:[f],fallback,scope});
  await reader.read({inputPath:f.sourcePath,format:'pdf',bytes:f.original.length},new AbortController().signal,scope);
  assert.equal(ocrCalls,0);
  await reader.read({inputPath:f.sourcePath,format:'pdf',bytes:f.original.length},new AbortController().signal,{...scope,actorId:'actor-two'});
  assert.equal(ocrCalls,1,'another actor cannot reuse the private pre-extraction');
  await writeFile(f.sourcePath,Buffer.concat([f.original,Buffer.from('changed')]));
  await assert.rejects(validatePreExtractedSource(f),/knowledge_source_hash/);
  await reader.read({inputPath:f.sourcePath,format:'pdf',bytes:f.original.length+7},new AbortController().signal);
  assert.equal(ocrCalls,2);
});
test('missing text pages are explicit and wrong-page or wrong-file provenance is refused',async t=>{
  const f=await fixture(t);
  f.document.texts.pop();f.document.body.children.pop();
  await writeFile(f.artifactPath,JSON.stringify(f.document));
  const parsed=await validatePreExtractedSource(f);
  assert.deepEqual(parsed.coverage,{totalPages:3,extractedPages:2,missingPages:[3]});
  assert.ok(parsed.warnings.includes('partial_coverage'));assert.equal(parsed.chunks.some(x=>x.locator.page===3),false);
  f.document.texts[1].prov[0].page_no=4;await writeFile(f.artifactPath,JSON.stringify(f.document));
  await assert.rejects(validatePreExtractedSource(f),/knowledge_provenance/);
  f.document.texts[1].prov[0].page_no=1;f.document.origin.filename='different.pdf';
  await writeFile(f.artifactPath,JSON.stringify(f.document));await assert.rejects(validatePreExtractedSource(f),/knowledge_provenance/);
});
test('short or cyclic artifacts fail rather than inventing pages/chapters; long text retains bounded exact chunks',async t=>{
  const f=await fixture(t);delete (f.document.pages as Record<string,unknown>)['3'];
  await writeFile(f.artifactPath,JSON.stringify(f.document));await assert.rejects(validatePreExtractedSource(f),/knowledge_provenance/);
  f.document.pages['3']={page_no:3};
  f.document.texts[1].text='需要结合情况。'.repeat(700);f.document.texts[1].prov[0].charspan=[0,f.document.texts[1].text.length];
  await writeFile(f.artifactPath,JSON.stringify(f.document));const parsed=await validatePreExtractedSource(f);
  assert.ok(parsed.chunks.every(x=>x.text.length<=4000));assert.equal(parsed.chunks.filter(x=>x.locator.page===1).slice(1).map(x=>x.text).join(''),f.document.texts[1].text);
  f.document.groups.push({self_ref:'#/groups/0',children:[{$ref:'#/groups/0'}]} as never);
  f.document.body.children.push({$ref:'#/groups/0'});await writeFile(f.artifactPath,JSON.stringify(f.document));
  await assert.rejects(validatePreExtractedSource(f),/knowledge_provenance/);
});
test('Docling spans refer to original list-item text, not its normalized text without a marker',async t=>{
  const f=await fixture(t);
  Object.assign(f.document.texts[1],{label:'list_item',orig:'• 原文需要核对。',text:'原文需要核对。',prov:[{page_no:1,charspan:[0,9]}]});
  await writeFile(f.artifactPath,JSON.stringify(f.document));
  const parsed=await validatePreExtractedSource(f);assert.equal(parsed.chunks[1].text,'• 原文需要核对。');
});
