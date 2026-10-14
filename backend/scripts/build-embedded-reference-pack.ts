import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {basename,extname,isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {readPreExtractedManifest,validatePreExtractedSource} from '../src/knowledge/pre-extracted-reader.js';
import {embeddedReferencePackSchema,type EmbeddedReferencePack} from '../src/system-reference/embedded-pack.js';

/** Offline allowlist build. Does not connect to a database, model or network. */
export async function buildEmbeddedReferencePack(manifestPath:string,output:string,expectedCount=21){
  try{
    if(!isAbsolute(manifestPath)||!isAbsolute(output)||!Number.isSafeInteger(expectedCount)||expectedCount<1||expectedCount>100)throw Error();
    const manifest=await readPreExtractedManifest(manifestPath);
    if(manifest.sources.length!==expectedCount)throw Error();
    const sources:EmbeddedReferencePack['sources']=[];
    for(const source of manifest.sources){
      if(!source.artifactHash)throw Error();
      const parsed=await validatePreExtractedSource(source);
      if(parsed.coverage.totalPages===null||parsed.coverage.extractedPages===null)throw Error();
      sources.push({sourceHash:source.expectedHash,artifactHash:source.artifactHash,
        title:basename(source.sourcePath,extname(source.sourcePath)),roles:['cfo','finance','cost','cashflow','profit','tax'],
        parsed});
    }
    const pack=embeddedReferencePackSchema.parse({version:1,corpusId:randomUUID(),releaseId:randomUUID(),sources});
    const raw=Buffer.from(JSON.stringify(pack));if(raw.length>64*1024*1024)throw Error();
    const bytes=gzipSync(raw),sha256=createHash('sha256').update(bytes).digest('hex');
    const metadata={version:1,file:'books.json.gz',sha256,sourceCount:pack.sources.length,corpusId:pack.corpusId,releaseId:pack.releaseId};
    // A build never overwrites an existing release or its manifest.
    await mkdir(output,{mode:0o700});
    await writeFile(join(output,'books.json.gz'),bytes,{mode:0o600,flag:'wx'});
    await writeFile(join(output,'manifest.json'),JSON.stringify(metadata)+'\n',{mode:0o600,flag:'wx'});
    return {...metadata,compressedBytes:bytes.length,uncompressedBytes:raw.length,
      chunks:pack.sources.reduce((n,s)=>n+s.parsed.chunks.length,0),
      physicalPages:pack.sources.reduce((n,s)=>n+(s.parsed.coverage.totalPages??0),0),
      indexedPages:pack.sources.reduce((n,s)=>n+(s.parsed.coverage.extractedPages??0),0)};
  }catch{throw Error('reference_pack_build_invalid');}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [manifestPath,output,...extra]=process.argv.slice(2);
  if(!manifestPath||!output||extra.length){process.stderr.write('reference_pack_build_arguments\n');process.exitCode=1;}
  else buildEmbeddedReferencePack(manifestPath,output).then(result=>process.stdout.write(JSON.stringify(result)+'\n'))
    .catch(()=>{process.stderr.write('reference_pack_build_invalid\n');process.exitCode=1;});
}
