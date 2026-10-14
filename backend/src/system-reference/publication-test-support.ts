import type { ReferenceRepository, ReferenceTransaction, ReferenceKind, ReferenceAuthorize } from './repository.js';
import type { ReferenceCrypto } from './crypto.js';
import type { z } from 'zod';

/** Atomic external-storage double. No production memory fallback. */
export class TestReferenceRepository implements ReferenceRepository {
  rows = new Map<string,string>();
  fault: ((kind:ReferenceKind,key:readonly string[])=>void)|undefined;
  beforeCommit:(()=>Promise<void>)|undefined;
  private queue:Promise<unknown>=Promise.resolve();
  constructor(readonly crypto:ReferenceCrypto) {}
  async corpusForRelease(id:string){for(const key of this.rows.keys()){const [corpus,kind,parts]=JSON.parse(key);if(kind==='release'&&parts[0]==='release'&&parts[1]===id)return corpus as string;}return null;}
  transaction<T>(corpusId:string, authorize:ReferenceAuthorize, operation:(tx:ReferenceTransaction)=>Promise<T>):Promise<T> {
    const run=this.queue.catch(()=>undefined).then(async()=>{
      await authorize();const staged=new Map(this.rows);
      const tx:ReferenceTransaction={
        releaseIds:async(after,limit)=>[...staged.keys()].map(k=>JSON.parse(k)).filter(([corpus,kind,parts])=>corpus===corpusId&&kind==='release'&&parts[0]==='release'&&(!after||parts[1]>after)).map(([, ,parts])=>parts[1] as string).sort().slice(0,limit),
        get:async<V>(kind:ReferenceKind,key:readonly string[],schema:z.ZodType<V>)=>{
          const cipher=staged.get(JSON.stringify([corpusId,kind,key]));
          return cipher===undefined?null:schema.parse(this.crypto.open({corpusId,kind,key},cipher));
        },
        set:async(kind,key,value)=>{
          this.fault?.(kind,key);staged.set(JSON.stringify([corpusId,kind,key]),this.crypto.seal({corpusId,kind,key},value));
        }
      };
      const result=await operation(tx);await this.beforeCommit?.();await authorize();this.rows=staged;return result;
    });
    this.queue=run;return run;
  }
}
