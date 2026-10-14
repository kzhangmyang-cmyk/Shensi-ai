import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import { KNOWLEDGE_MAX_BYTES, parsedKnowledgeSchema, type ParsedKnowledge, type KnowledgeLocator } from './domain.js';
import { createKnowledgeReader, type KnowledgeReader, type KnowledgeReaderScope } from './reader-gateway.js';

const warningSchema=z.array(z.string().min(1).max(80)).max(100);
export const preExtractedSourceSchema=z.object({
  sourcePath:z.string().refine(isAbsolute),artifactPath:z.string().refine(isAbsolute),expectedHash:z.string().regex(/^[a-f0-9]{64}$/u),
  expectedPages:z.number().int().min(1).max(1000),artifactHash:z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  warnings:warningSchema.optional()
}).strict();
export type PreExtractedSource=z.infer<typeof preExtractedSourceSchema>;
const manifestSchema=z.object({version:z.literal(1),scope:z.object({workspaceId:z.string().min(1).max(191),actorId:z.string().min(1).max(191)}).strict(),
  sources:z.array(preExtractedSourceSchema).min(1).max(100)}).strict().refine(value=>value.scope.actorId!=='all'&&value.scope.workspaceId!=='all');
export type PreExtractedManifest=z.infer<typeof manifestSchema>;
const provenance=z.object({page_no:z.number().int().min(1).max(1000),charspan:z.tuple([z.number().int().min(0),z.number().int().min(0)]).optional()}).passthrough();
const textItem=z.object({label:z.string(),text:z.string(),orig:z.string().optional(),prov:z.array(provenance).min(1).max(1000)}).passthrough();
const tableItem=z.object({prov:z.array(provenance).min(1).max(1000),data:z.object({table_cells:z.array(z.object({
  text:z.string(),start_row_offset_idx:z.number().int().min(0),start_col_offset_idx:z.number().int().min(0)
}).passthrough()).max(100000)}).passthrough()}).passthrough();
const child=z.object({$ref:z.string().regex(/^#\/(texts|tables|groups|pictures)\/\d+$/u)}).passthrough();
const group=z.object({children:z.array(child).max(100000)}).passthrough();
const documentSchema=z.object({schema_name:z.literal('DoclingDocument'),version:z.string().min(1).max(40),
  origin:z.object({filename:z.string(),mimetype:z.literal('application/pdf')}).passthrough(),
  pages:z.record(z.object({page_no:z.number().int().min(1).max(1000)}).passthrough()),body:group,
  groups:z.array(group).max(100000),texts:z.array(textItem).max(100000),tables:z.array(tableItem).max(10000),
  pictures:z.array(z.object({prov:z.array(provenance).optional()}).passthrough()).max(100000)
}).passthrough();
const failure=(code:string)=>new Error(`knowledge_${code}`);
async function checkedFile(path:string,max:number) {
  if(!isAbsolute(path))throw failure('source_invalid');const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>max)throw failure('source_invalid');return info;
}
export async function sourceSha256(path:string,signal?:AbortSignal):Promise<string>{
  await checkedFile(path,KNOWLEDGE_MAX_BYTES);signal?.throwIfAborted();const hash=createHash('sha256');
  for await(const buffer of createReadStream(path)){signal?.throwIfAborted();hash.update(buffer);}signal?.throwIfAborted();return hash.digest('hex');
}
export async function readPreExtractedManifest(path:string):Promise<z.infer<typeof manifestSchema>> {
  const info=await checkedFile(path,1024*1024);
  if(info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600)throw failure('manifest_private_required');
  const parsed=manifestSchema.safeParse(JSON.parse(await readFile(path,'utf8')));
  if(!parsed.success||new Set(parsed.data.sources.map(x=>x.expectedHash)).size!==parsed.data.sources.length)throw failure('manifest_invalid');
  return parsed.data;
}
/** Count is from the already physically verified manifest, bound to the same
 * original SHA-256. No PDF extraction, OCR, network or source modification. */
export async function validatePreExtractedSource(input:PreExtractedSource,signal?:AbortSignal):Promise<ParsedKnowledge> {
  const source=preExtractedSourceSchema.parse({sourcePath:input.sourcePath,artifactPath:input.artifactPath,
    expectedHash:input.expectedHash,expectedPages:input.expectedPages,...(input.artifactHash?{artifactHash:input.artifactHash}:{}),...(input.warnings?{warnings:input.warnings}:{})});
  if(await sourceSha256(source.sourcePath,signal)!==source.expectedHash)throw failure('source_hash_mismatch');
  await checkedFile(source.artifactPath,64*1024*1024);signal?.throwIfAborted();
  const bytes=await readFile(source.artifactPath);
  if(source.artifactHash&&createHash('sha256').update(bytes).digest('hex')!==source.artifactHash)throw failure('artifact_hash_mismatch');
  const parsed=documentSchema.safeParse(JSON.parse(bytes.toString('utf8')));
  if(!parsed.success)throw failure('provenance_invalid');const document=parsed.data;
  const keys=Object.keys(document.pages);
  if(document.origin.filename!==basename(source.sourcePath)||keys.length!==source.expectedPages
    ||Array.from({length:source.expectedPages},(_,i)=>String(i+1)).some(k=>document.pages[k]?.page_no!==Number(k)))throw failure('provenance_invalid');
  const warnings=new Set(source.warnings??[]);warnings.add('text_precision_unverified');
  if(document.pictures.length)warnings.add('figures_unverified');
  const chunks:ParsedKnowledge['chunks']=[],seenPages=new Set<number>(),visiting=new Set<string>(),seen=new Set<string>();
  let chapter:string|undefined,nodes=0;
  const checkPage=(page:number)=>{if(!document.pages[String(page)])throw failure('provenance_invalid');return page;};
  const append=(text:string,locator:KnowledgeLocator,quality:string[])=>{
    for(let start=0;start<text.length;){signal?.throwIfAborted();let end=Math.min(start+3500,text.length);
      if(end<text.length&&/[\uD800-\uDBFF]/u.test(text[end-1]))end--;
      const value=text.slice(start,end).trim();if(value){if(chunks.length>=50000)throw failure('reader_limit');
        chunks.push({order:chunks.length,text:value,locator:{...locator,...(chapter?{chapter}:{})},warnings:[...new Set([...(source.warnings??[]),'text_precision_unverified',...quality])].slice(0,100)});
        if(locator.page)seenPages.add(locator.page);}
      start=end;
    }
  };
  const walk=(children:z.infer<typeof child>[])=>{for(const reference of children){
    signal?.throwIfAborted();if(++nodes>100000||visiting.has(reference.$ref))throw failure('provenance_invalid');
    if(seen.has(reference.$ref))continue;const [,kind,id]=reference.$ref.split('/'),index=Number(id);visiting.add(reference.$ref);
    if(kind==='groups'){const current=document.groups[index];if(!current)throw failure('provenance_invalid');walk(current.children);}
    else if(kind==='texts'){
      const item=document.texts[index];if(!item)throw failure('provenance_invalid');
      if(item.label==='section_header'){chapter=item.text.trim().slice(0,300);warnings.add('chapter_unverified');}
      const quality=item.label==='formula'?['formula_unverified']:[];quality.forEach(x=>warnings.add(x));
      // Docling charspan indexes the original text, before list-marker normalization.
      const original=item.orig??item.text,characters=Array.from(original);
      for(const prov of item.prov){const page=checkPage(prov.page_no),span=prov.charspan;
        if(span&&(span[1]<span[0]||span[1]>characters.length))throw failure('provenance_invalid');
        append(span?characters.slice(span[0],span[1]).join(''):original,{page},[...quality,...(chapter?['chapter_unverified']:[])]);
      }
    }else if(kind==='tables'){
      const item=document.tables[index];if(!item)throw failure('provenance_invalid');item.prov.forEach(x=>checkPage(x.page_no));warnings.add('table_unverified');
      const quality=['table_unverified',...(item.prov.length>1?['multi_page_table_unverified']:[])];quality.forEach(x=>warnings.add(x));
      for(const cell of item.data.table_cells)append(cell.text,{page:item.prov[0].page_no,table:index+1,row:cell.start_row_offset_idx+1,column:cell.start_col_offset_idx+1},quality);
    }else{const picture=document.pictures[index];if(!picture)throw failure('provenance_invalid');picture.prov?.forEach(x=>checkPage(x.page_no));}
    visiting.delete(reference.$ref);seen.add(reference.$ref);
  }};
  walk(document.body.children);
  const missingPages=Array.from({length:source.expectedPages},(_,i)=>i+1).filter(page=>!seenPages.has(page));
  if(missingPages.length)warnings.add('partial_coverage');
  const result=parsedKnowledgeSchema.safeParse({parserVersion:`docling-${document.version}-reference-v1`,
    coverage:{totalPages:source.expectedPages,extractedPages:source.expectedPages-missingPages.length,missingPages},warnings:[...warnings].slice(0,100),chunks});
  if(!result.success)throw failure('provenance_invalid');signal?.throwIfAborted();return result.data;
}
export function createPreExtractedKnowledgeReader(options:{sources:PreExtractedSource[];scope:KnowledgeReaderScope;fallback:KnowledgeReader}):KnowledgeReader {
  const sources=new Map(options.sources.map(source=>[source.expectedHash,source]));
  return {async read(input,signal,scope){signal.throwIfAborted();
    if(!scope||scope.actorId!==options.scope.actorId||scope.workspaceId!==options.scope.workspaceId)return options.fallback.read(input,signal,scope);
    const source=input.format==='pdf'?sources.get(await sourceSha256(input.inputPath,signal)):undefined;
    return source?validatePreExtractedSource(source,signal):options.fallback.read(input,signal,scope);
  }};
}
export function createConfiguredKnowledgeReader(options:{python?:string;script?:string;manifest?:string}):KnowledgeReader {
  const fallback=createKnowledgeReader(options);if(!options.manifest)return fallback;
  let selected:Promise<KnowledgeReader>|undefined;
  return {async read(input,signal,scope){
    signal.throwIfAborted();
    const reader=await(selected??=readPreExtractedManifest(options.manifest!).then(manifest=>createPreExtractedKnowledgeReader({...manifest,fallback})));
    return reader.read(input,signal,scope);
  }};
}
