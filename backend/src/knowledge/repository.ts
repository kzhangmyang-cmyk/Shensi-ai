import type { KnowledgeScope, KnowledgeUploadInput, KnowledgeDocumentPatch, KnowledgeDocumentRecord,
  KnowledgeVersionRecord, KnowledgeChunk, KnowledgeRole, KnowledgeStatus, KnowledgeJobClaim, ParsedKnowledge } from './domain.js';

export interface KnowledgeListQuery { cursor?: string; limit: number; q?: string; role?: KnowledgeRole; status?: KnowledgeStatus; }
export interface KnowledgeDocumentPage { items: KnowledgeDocumentRecord[]; nextCursor: string | null; }
export interface KnowledgeUploadReceipt { storageKey: string; sourceHash: string; bytes: number; }
export interface KnowledgeRepository {
  createDocument(ctx: KnowledgeScope, input: KnowledgeUploadInput, key: string): Promise<{ document: KnowledgeDocumentRecord; version: KnowledgeVersionRecord }>;
  addVersion(ctx: KnowledgeScope, id: string, input: KnowledgeUploadInput, revision: number, key: string): Promise<KnowledgeVersionRecord>;
  listDocuments(ctx: KnowledgeScope, query: KnowledgeListQuery): Promise<KnowledgeDocumentPage>;
  getDocument(ctx: KnowledgeScope, id: string): Promise<KnowledgeDocumentRecord | null>;
  getVersion(ctx: KnowledgeScope, id: string, versionId: string): Promise<KnowledgeVersionRecord | null>;
  listChunks(ctx: KnowledgeScope, versionId: string): Promise<KnowledgeChunk[]>;
  listChunkPage(ctx: KnowledgeScope, versionId: string, afterOrder: number, limit: number): Promise<KnowledgeChunk[]>;
  /** Internal deletion compensation: ownership-checked, including an already deleted document. */
  listVersionsForCleanup(ctx: KnowledgeScope, documentId: string): Promise<KnowledgeVersionRecord[]>;
  mutateDocument(ctx: KnowledgeScope, id: string, patch: KnowledgeDocumentPatch, revision: number, key: string): Promise<KnowledgeDocumentRecord>;
  completeUpload(ctx: KnowledgeScope, versionId: string, receipt: KnowledgeUploadReceipt, revision: number, key: string): Promise<KnowledgeVersionRecord>;
  retryJob(ctx: KnowledgeScope, versionId: string, revision: number, key: string): Promise<KnowledgeVersionRecord>;
  cancelJob(ctx: KnowledgeScope, jobId: string): Promise<void>;
  claimJob(workerId: string, now: number, leaseMs: number): Promise<KnowledgeJobClaim | null>;
  renewClaim(claim: KnowledgeJobClaim, now: number, leaseMs: number): Promise<boolean>;
  commitParsed(ctx: KnowledgeScope, claim: KnowledgeJobClaim, parsed: ParsedKnowledge): Promise<KnowledgeVersionRecord>;
  failJob(ctx: KnowledgeScope, claim: KnowledgeJobClaim, code: string): Promise<void>;
  publishReady(ctx: KnowledgeScope, claim: KnowledgeJobClaim, revision: number): Promise<KnowledgeVersionRecord>;
}
