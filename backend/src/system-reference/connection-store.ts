import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { bindingProofSchema } from './binding-service.js';
import { ReferenceAccessError } from './authority.js';

const identity = z.string().min(1).max(191);
export const connectionScopeSchema = z.object({ backendInstanceId: identity, workspaceId: identity, actorId: identity,
  authVersion: z.number().int().positive().safe(), generation: z.number().int().nonnegative().safe(), issuer: z.string().url().max(2048) }).strict();
export type ConnectionScope = z.infer<typeof connectionScopeSchema>;
export const connectionSecretsSchema = z.object({ verifier: bindingProofSchema.shape.verifier, readerToken: bindingProofSchema.shape.verifier.optional() }).strict();
const slotSchema = z.object({ scope: connectionScopeSchema, status: z.enum(['pending','unconfirmed','ready']),
  requestId: z.string().uuid().nullable(), sealed: z.string().max(4096), expiresAt: z.number().int().positive().safe(),
  centralAccountLabel: identity.optional() }).strict();
export type ConnectionSlot = z.infer<typeof slotSchema>;
const tombstoneSchema = z.object({ scope: connectionScopeSchema, requestId: z.string().uuid().nullable(), sealed: z.string().max(4096).nullable(),
  expiresAt: z.number().int().positive().safe(), retainUntil: z.number().int().positive().safe(), cancelled: z.boolean() }).strict();
export type ConnectionTombstone = z.infer<typeof tombstoneSchema>;
export const connectionRecordSchema = z.object({ backendInstanceId: identity, actorId: identity, generation: z.number().int().nonnegative().safe(),
  connections: z.array(slotSchema).max(100), tombstones: z.array(tombstoneSchema).max(1000) }).strict().refine(row =>
  new Set(row.connections.map(slot=>slot.scope.workspaceId)).size===row.connections.length
  && [...row.connections,...row.tombstones].every(slot=>slot.scope.backendInstanceId===row.backendInstanceId && slot.scope.actorId===row.actorId && slot.scope.generation<=row.generation));
export type ConnectionRecord = z.infer<typeof connectionRecordSchema>;
export interface ConnectionStore {
  transaction<T>(backendInstanceId: string, actorId: string, operation: (row: ConnectionRecord) => Promise<T>): Promise<T>;
}
/** Explicit stable host secret; no JWT/database/random fallback. */
export function createConnectionCrypto(secret: string) {
  if (typeof secret !== 'string' || secret.trim().length<32) throw new Error('reference_key_required');
  const key=Buffer.from(hkdfSync('sha256',secret,'shensi.system-reference.connection.v1','credential',32));
  const aad=(scope:ConnectionScope)=>{connectionScopeSchema.parse(scope);return Buffer.from(JSON.stringify(['reference-connection.v1',scope.backendInstanceId,scope.workspaceId,scope.actorId,scope.authVersion,scope.generation,scope.issuer]));};
  return Object.freeze({
    seal(scope:ConnectionScope,value:z.infer<typeof connectionSecretsSchema>) {
      const plain=connectionSecretsSchema.parse(value),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(scope));
      const payload=Buffer.concat([cipher.update(JSON.stringify(plain),'utf8'),cipher.final()]);
      return ['r1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),payload.toString('base64url')].join('.');
    },
    open(scope:ConnectionScope,sealed:string) {
      try {
        const [version,iv,tag,payload,...rest]=sealed.split('.');if(version!=='r1'||rest.length||!payload)throw Error();
        const nonce=Buffer.from(iv,'base64url'),authTag=Buffer.from(tag,'base64url');if(nonce.length!==12||authTag.length!==16)throw Error();
        const cipher=createDecipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad(scope));cipher.setAuthTag(authTag);
        return connectionSecretsSchema.parse(JSON.parse(Buffer.concat([cipher.update(Buffer.from(payload,'base64url')),cipher.final()]).toString('utf8')));
      } catch {throw new ReferenceAccessError(503,'reference_credential_invalid');}
    }
  });
}
