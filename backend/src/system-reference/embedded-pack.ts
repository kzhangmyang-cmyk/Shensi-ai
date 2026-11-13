import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {z} from 'zod';
import {knowledgeRoleSchema,parsedKnowledgeSchema} from '../knowledge/domain.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const embeddedReferencePackSchema=z.object({version:z.literal(1),corpusId:z.string().uuid(),releaseId:z.string().uuid(),
  sources:z.array(z.object({sourceHash:hash,artifactHash:hash,title:z.string().min(1).max(300),
    roles:z.array(knowledgeRoleSchema).min(1).max(6),parsed:parsedKnowledgeSchema}).strict()).min(1).max(100)
}).strict().refine(v=>new Set(v.sources.map(s=>s.sourceHash)).size===v.sources.length,'duplicate_source');
export type EmbeddedReferencePack=z.infer<typeof embeddedReferencePackSchema>;

/** Trusted application resource, not an upload or a user-database export. */
export async function readEmbeddedReferencePack(path:string,expectedHash:string):Promise<EmbeddedReferencePack>{
  try{
    if(!isAbsolute(path)||!hash.safeParse(expectedHash).success)throw Error();
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=await file.stat();if(!stat.isFile()||stat.size<1||stat.size>64*1024*1024)throw Error();
      const bytes=await file.readFile();if(createHash('sha256').update(bytes).digest('hex')!==expectedHash)throw Error();
      return embeddedReferencePackSchema.parse(JSON.parse(gunzipSync(bytes,{maxOutputLength:64*1024*1024}).toString('utf8')));
    }finally{await file.close();}
  }catch{throw Error('reference_pack_invalid');}
}
