import {ReferenceAccessError} from './authority.js';
/** Process-wide raw input reservations, shared by candidate builders and future reader caches.
 * This bounds input bytes, not MiniSearch/V8 heap overhead. It is not a multi-API lock. */
export class ReferenceIndexBudget {
  private used=0;
  constructor(private readonly limit=64*1024*1024){
    if(!Number.isSafeInteger(limit)||limit<1||limit>64*1024*1024)throw Error('reference_index_configuration_invalid');
  }
  reserve(bytes:number):()=>void{
    if(!Number.isSafeInteger(bytes)||bytes<0||this.used+bytes>this.limit)throw new ReferenceAccessError(503,'reference_index_limit');
    this.used+=bytes;let released=false;
    return ()=>{if(!released){released=true;this.used-=bytes;}};
  }
}
export const referenceIndexBudget=new ReferenceIndexBudget();
