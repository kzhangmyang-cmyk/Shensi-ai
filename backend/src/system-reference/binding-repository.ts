import type { PoolConnection } from 'mysql2/promise';
import { z } from 'zod';
import { centralReaderSchema } from './domain.js';

export const bindingRecordSchema = z.object({
  id: z.string().uuid(), challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), displayCode: z.string().regex(/^\d{8}$/u),
  issuer: z.string().url(), purpose: z.literal('system-reference-reader'),
  status: z.enum(['pending', 'approved', 'consumed', 'cancelled', 'expired']),
  createdAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().nonnegative().safe(),
  generation: z.number().int().min(1).safe(), reader: centralReaderSchema.nullable(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), tokenExpiresAt: z.number().int().nonnegative().safe().nullable()
}).strict();
export type BindingRecord = z.infer<typeof bindingRecordSchema>;
export interface BindingRepository {
  insert(record: BindingRecord): Promise<void>;
  transaction<T>(id: string, operation: (record: BindingRecord | null, connection?: PoolConnection) => Promise<T>): Promise<T>;
  findToken(hash: string): Promise<string | null>;
  /** Borrow the corpus transaction; keep the binding lock until its caller commits. */
  readForReferenceTransaction(id:string,connection?:PoolConnection):Promise<BindingRecord|null>;
}
