import {z} from 'zod';
import type {PoolConnection} from 'mysql2/promise';
import {publicationManifestSchema,releaseDraftSchema} from './domain.js';
export type {ReferenceKind} from './crypto.js';
import type {ReferenceKind} from './crypto.js';
export type ReferenceAuthorize=(connection?:PoolConnection)=>Promise<void>;
export interface ReferenceTransaction {
  readonly connection?:PoolConnection;
  releaseIds(after:string|null,limit:number):Promise<string[]>;
  get<T>(kind:ReferenceKind,key:readonly string[],schema:z.ZodType<T>):Promise<T|null>;
  set(kind:ReferenceKind,key:readonly string[],value:unknown):Promise<void>;
}
export interface ReferenceRepository {
  corpusForRelease(id:string):Promise<string|null>;
  transaction<T>(corpusId:string,authorize:ReferenceAuthorize,operation:(transaction:ReferenceTransaction)=>Promise<T>):Promise<T>;
}
export const activeReferenceSchema=z.object({id:z.string().uuid().nullable(),revision:z.number().int().nonnegative().safe()}).strict();
export const referenceReleaseRecordSchema=releaseDraftSchema.extend({manifest:publicationManifestSchema,baseActiveReleaseId:z.string().uuid().nullable(),inputBytes:z.number().int().nonnegative().max(64*1024*1024)}).strict();
export type ReferenceReleaseRecord=z.infer<typeof referenceReleaseRecordSchema>;
export const referenceSourceRecordSchema=z.object({totalChunks:z.number().int().min(1).max(50000),receivedChunks:z.number().int().nonnegative().max(50000),complete:z.boolean(),indexedCharacters:z.number().int().nonnegative().safe()}).strict();
export const referenceCommandRecordSchema=z.object({hash:z.string().regex(/^[a-f0-9]{64}$/),releaseId:z.string().uuid()}).strict();
export const referenceChunkKey=(releaseId:string,sourceHash:string,order:number)=>[releaseId,sourceHash,String(order).padStart(5,'0')];
