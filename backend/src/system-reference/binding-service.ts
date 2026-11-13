import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { centralReaderSchema, type CentralReader } from './domain.js';
import { ReferenceAccessError, type ReferenceAuthorityReader } from './authority.js';
import type { BindingRecord, BindingRepository } from './binding-repository.js';
import type {ReferenceAuthorize} from './repository.js';

const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/u).refine(value => Buffer.from(value, 'base64url').toString('base64url') === value);
export const bindingCreateSchema = z.object({ challenge: secret }).strict();
export const bindingProofSchema = z.object({ verifier: secret }).strict();
export const bindingApproveSchema = z.object({ displayCode: z.string().regex(/^\d{8}$/u) }).strict();
const proofInput = bindingProofSchema.extend({ requestId: z.string().uuid() }).strict();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const denied = () => new ReferenceAccessError(403, 'reference_binding_invalid');
const readerEqual = (a: CentralReader, b: CentralReader) => a.subjectId === b.subjectId && a.workspaceId === b.workspaceId
  && a.authVersion === b.authVersion && a.authorityRevision === b.authorityRevision;
declare const readerAccessBrand:unique symbol;
export type ReferenceReaderAccess={readonly [readerAccessBrand]:true};
type ReaderProof=Readonly<{reader:Readonly<CentralReader>;bindingId:string;authorize:ReferenceAuthorize}>;
const accessProofs=new WeakMap<ReferenceReaderAccess,ReaderProof>();
/** Trusted service boundary only: JSON, a copied reader DTO, or an object clone is not a proof. */
export function referenceAccessProof(access:ReferenceReaderAccess):ReaderProof{
  const proof=accessProofs.get(access);if(!proof)throw new ReferenceAccessError(401,'reference_reader_invalid');return proof;
}

/** Trusted central assembly only. The identity comes from the normally
 * authenticated local scope, not an HTTP reader DTO or a client installation.
 * No binding/token is minted. All ordinary sessions of a subject/workspace
 * share the conservative binding-rate bucket, including across restarts. */
export async function createCentralSessionAccess(authority:ReferenceAuthorityReader,
  identity:{actorId:string;workspaceId:string;authVersion:number},ensure:()=>void=()=>{}):Promise<ReferenceReaderAccess>{
  ensure();
  const reader=Object.freeze(centralReaderSchema.parse(await authority.current(identity.actorId,identity.workspaceId)));
  ensure();if(reader.authVersion!==identity.authVersion)throw new ReferenceAccessError(401,'reference_reader_invalid');
  const access=Object.freeze({}) as ReferenceReaderAccess;
  const authorize:ReferenceAuthorize=async connection=>{
    ensure();const current=await authority.current(reader.subjectId,reader.workspaceId,connection);ensure();
    if(!readerEqual(reader,current))throw new ReferenceAccessError(401,'reference_reader_invalid');
  };
  accessProofs.set(access,Object.freeze({reader,bindingId:`central-session:${sha(JSON.stringify([reader.subjectId,reader.workspaceId]))}`,authorize}));
  return access;
}

export class BindingService {
  private readonly now: () => number;
  constructor(private readonly options: { authority: ReferenceAuthorityReader; repository: BindingRepository; issuer: string; now?: () => number }) {
    const issuer = new URL(options.issuer);
    if (issuer.protocol !== 'https:' || issuer.origin !== options.issuer || issuer.username || issuer.password) throw new Error('reference_issuer_invalid');
    this.now = options.now ?? Date.now;
  }
  async create(input: { challenge: string }, _ip: string) {
    const { challenge } = bindingCreateSchema.parse(input);
    const now = this.now();
    const row: BindingRecord = { id: randomUUID(), challenge, displayCode: String(randomInt(100000000)).padStart(8, '0'),
      issuer: this.options.issuer, purpose: 'system-reference-reader', status: 'pending', createdAt: now, expiresAt: now + 300000,
      generation: 1, reader: null, tokenHash: null, tokenExpiresAt: null };
    await this.options.repository.insert(row);
    return { requestId: row.id, displayCode: row.displayCode, expiresAt: new Date(row.expiresAt).toISOString() };
  }
  private valid(row: BindingRecord | null): row is BindingRecord {
    return !!row && row.issuer === this.options.issuer && row.purpose === 'system-reference-reader';
  }
  private expire(row: BindingRecord) {
    if ((row.status === 'pending' || row.status === 'approved') && this.now() >= row.expiresAt) row.status = 'expired';
    return row.status === 'expired';
  }
  async approve(reader: CentralReader, requestId: string, displayCode: string): Promise<void> {
    centralReaderSchema.parse(reader); z.string().uuid().parse(requestId); bindingApproveSchema.parse({ displayCode });
    const error = await this.options.repository.transaction(requestId, async (row, connection) => {
      if (!this.valid(row) || this.expire(row) || row.status !== 'pending' || !equal(row.displayCode, displayCode)) return denied();
      const current = await this.options.authority.current(reader.subjectId, reader.workspaceId, connection);
      if (!readerEqual(current, reader)) return denied();
      row.reader = current; row.status = 'approved'; return null;
    });
    if (error) throw error;
  }
  async exchange(input: { requestId: string; verifier: string }) {
    const { requestId, verifier } = proofInput.parse(input);
    const result = await this.options.repository.transaction(requestId, async (row, connection) => {
      if (!this.valid(row) || !equal(createHash('sha256').update(verifier).digest('base64url'), row.challenge)) return denied();
      if (this.expire(row) || row.status !== 'approved' || !row.reader) return denied();
      const current = await this.options.authority.current(row.reader.subjectId, row.reader.workspaceId, connection);
      if (!readerEqual(current, row.reader)) return denied();
      const readerToken = randomBytes(32).toString('base64url');
      row.status = 'consumed'; row.tokenHash = sha(readerToken); row.tokenExpiresAt = this.now() + 7 * 86400000;
      return { readerToken, reader: current, expiresAt: new Date(row.tokenExpiresAt).toISOString() };
    });
    if (result instanceof Error) throw result;
    return result;
  }
  async cancel(input: { requestId: string; verifier: string }): Promise<void> {
    const { requestId, verifier } = proofInput.parse(input);
    const error = await this.options.repository.transaction(requestId, async row => {
      if (!this.valid(row) || !equal(createHash('sha256').update(verifier).digest('base64url'), row.challenge)) return denied();
      if (row.status !== 'cancelled') { row.status = 'cancelled'; row.generation++; }
      return null; // Retain hash/tombstone so lost exchange cannot revive a credential.
    });
    if (error) throw error;
  }
  private async authenticateSnapshot(token:string){
    if (!secret.safeParse(token).success) throw new ReferenceAccessError(401, 'reference_reader_invalid');
    const hash = sha(token), id = await this.options.repository.findToken(hash);
    if (!id) throw new ReferenceAccessError(401, 'reference_reader_invalid');
    return this.options.repository.transaction(id, async (row, connection) => {
      if (!this.valid(row) || row.status !== 'consumed' || row.tokenHash !== hash || !row.tokenExpiresAt || this.now() >= row.tokenExpiresAt || !row.reader) throw new ReferenceAccessError(401, 'reference_reader_invalid');
      const current = await this.options.authority.current(row.reader.subjectId, row.reader.workspaceId, connection);
      if (current.authVersion !== row.reader.authVersion || this.now() >= row.tokenExpiresAt) throw new ReferenceAccessError(401, 'reference_reader_invalid');
      return {reader:current,bindingId:id,generation:row.generation,tokenExpiresAt:row.tokenExpiresAt,hash};
    });
  }
  async authenticate(token:string):Promise<CentralReader>{return (await this.authenticateSnapshot(token)).reader;}
  async authenticateAccess(token:string):Promise<ReferenceReaderAccess>{
    const snapshot=await this.authenticateSnapshot(token),reader=Object.freeze({...snapshot.reader});
    const access=Object.freeze({}) as ReferenceReaderAccess;
    const authorize:ReferenceAuthorize=async connection=>{
      const row=await this.options.repository.readForReferenceTransaction(snapshot.bindingId,connection);
      if(!this.valid(row)||row.status!=='consumed'||row.generation!==snapshot.generation||row.tokenHash!==snapshot.hash
        ||!row.tokenExpiresAt||row.tokenExpiresAt!==snapshot.tokenExpiresAt||this.now()>=row.tokenExpiresAt||!row.reader||row.reader.subjectId!==reader.subjectId
        ||row.reader.workspaceId!==reader.workspaceId||row.reader.authVersion!==reader.authVersion)throw new ReferenceAccessError(401,'reference_reader_invalid');
      const current=await this.options.authority.current(reader.subjectId,reader.workspaceId,connection);
      if(!readerEqual(current,reader)||this.now()>=row.tokenExpiresAt)throw new ReferenceAccessError(401,'reference_reader_invalid');
    };
    accessProofs.set(access,Object.freeze({reader,bindingId:snapshot.bindingId,authorize}));return access;
  }
}
