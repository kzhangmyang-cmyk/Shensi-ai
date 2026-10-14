import {createHash,createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {ReferenceAccessError} from './authority.js';
export const referenceKindSchema=z.enum(['release','source','chunk','command','grant','budget','audit']);
export type ReferenceKind=z.infer<typeof referenceKindSchema>;
const scopeSchema=z.object({corpusId:z.string().uuid(),kind:referenceKindSchema,key:z.array(z.string().min(1).max(191)).min(1).max(6)}).strict();
export type ReferenceCryptoScope=z.infer<typeof scopeSchema>;
export function canonicalJson(value:unknown):string {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
  if(typeof value==='object'&&value!==null&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null))
    return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJson((value as Record<string,unknown>)[key])).join(',')+'}';
  throw new ReferenceAccessError(400,'reference_value_invalid');
}
export const referenceHash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export interface ReferenceCrypto {seal(scope:{corpusId:string;kind:ReferenceKind;key:readonly string[]},value:unknown):string;open(scope:{corpusId:string;kind:ReferenceKind;key:readonly string[]},sealed:string):unknown;}
export function createReferenceCrypto(secret:string):ReferenceCrypto {
  if(typeof secret!=='string'||secret.length<32)throw new Error('reference_crypto_configuration_invalid');
  const keys=new Map<ReferenceKind,Buffer>();
  const key=(kind:ReferenceKind)=>{let result=keys.get(kind);if(!result){result=Buffer.from(hkdfSync('sha256',Buffer.from(secret),'shensi.system-reference.storage.v1',kind,32));keys.set(kind,result);}return result;};
  const aad=(scope:Parameters<ReferenceCrypto['seal']>[0])=>Buffer.from(canonicalJson(scopeSchema.parse(scope)));
  return {
    seal(scope,value){const data=Buffer.from(canonicalJson(value));if(data.length>2*1024*1024)throw new ReferenceAccessError(400,'reference_record_limit');
      const context=aad(scope),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(scope.kind),iv);cipher.setAAD(context);
      return ['sr1',iv.toString('base64url'),Buffer.concat([cipher.update(data),cipher.final()]).toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');},
    open(scope,sealed){try{const context=aad(scope),parts=sealed.split('.');if(parts.length!==4||parts[0]!=='sr1'||sealed.length>3*1024*1024)throw Error();
      const [iv,data,tag]=parts.slice(1).map(part=>{if(!/^[A-Za-z0-9_-]+$/.test(part))throw Error();const b=Buffer.from(part,'base64url');if(b.toString('base64url')!==part)throw Error();return b;});
      if(iv.length!==12||tag.length!==16)throw Error();const cipher=createDecipheriv('aes-256-gcm',key(scope.kind),iv);cipher.setAAD(context);cipher.setAuthTag(tag);
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat([cipher.update(data),cipher.final()])));
    }catch{throw new ReferenceAccessError(503,'reference_authentication_invalid');}}
  };
}
