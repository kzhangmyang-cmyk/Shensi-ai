import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { GrowthHttpError } from '../growth-command-context.js';
import { assertKnowledgeScope, documentProjection, versionProjection, KNOWLEDGE_MAX_BYTES,
  type KnowledgeScope, type KnowledgeVersionRecord, type KnowledgeUploadInput, type KnowledgeDocumentPatch } from './domain.js';
import type { KnowledgeRepository, KnowledgeListQuery } from './repository.js';
import type { KnowledgeCrypto } from './crypto.js';
import type { KnowledgeFileStore } from './file-store.js';

type Resources = { repository: KnowledgeRepository; files: KnowledgeFileStore; crypto: KnowledgeCrypto };
async function checkSignature(path: string, format: KnowledgeVersionRecord['format']) {
  const handle = await open(path, 'r'); let prefix: Buffer;
  try { const buffer = Buffer.alloc(1024); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); prefix = buffer.subarray(0, bytesRead); }
  finally { await handle.close(); }
  if (format === 'pdf' && !prefix.toString('latin1').includes('%PDF-')) throw new GrowthHttpError(415, 'knowledge_signature_invalid');
  if (['docx', 'xlsx'].includes(format) && !prefix.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new GrowthHttpError(415, 'knowledge_signature_invalid');
  if (['txt', 'md', 'csv'].includes(format)) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      for await (const chunk of createReadStream(path)) {
        if (chunk.includes(0)) throw new Error(); decoder.decode(chunk, { stream: true });
      }
      decoder.decode();
    } catch { throw new GrowthHttpError(415, 'knowledge_text_encoding_invalid'); }
  }
}
export class KnowledgeService {
  private readonly controllers = new Set<AbortController>();
  private closed = false;
  constructor(private readonly options: Resources | { reason: string }, private readonly cancelProcessing?: (id: string) => void) {}
  availability() {
    return { available: !this.closed && 'repository' in this.options, reason: this.closed ? 'knowledge_service_closed' : 'reason' in this.options ? this.options.reason : null };
  }
  private resources(): Resources {
    if (this.closed || !('repository' in this.options)) throw new GrowthHttpError(503, this.availability().reason!); return this.options;
  }
  async create(ctx: KnowledgeScope, input: KnowledgeUploadInput, key: string) {
    assertKnowledgeScope(ctx, 'knowledge.upload');
    const value = await this.resources().repository.createDocument(ctx, input, key);
    return { document: documentProjection(value.document), version: versionProjection(value.version) };
  }
  async list(ctx: KnowledgeScope, query: KnowledgeListQuery) {
    assertKnowledgeScope(ctx, 'knowledge.read'); const page = await this.resources().repository.listDocuments(ctx, query);
    return { items: page.items.map(documentProjection), nextCursor: page.nextCursor };
  }
  async get(ctx: KnowledgeScope, id: string) {
    assertKnowledgeScope(ctx, 'knowledge.read'); const document = await this.resources().repository.getDocument(ctx, id);
    if (!document) throw new GrowthHttpError(404, 'knowledge_not_found'); return documentProjection(document);
  }
  async getVersionRecord(ctx: KnowledgeScope, id: string, versionId: string) {
    assertKnowledgeScope(ctx, 'knowledge.read'); const version = await this.resources().repository.getVersion(ctx, id, versionId);
    if (!version) throw new GrowthHttpError(404, 'knowledge_not_found'); return version;
  }
  async getVersion(ctx: KnowledgeScope, id: string, versionId: string) { return versionProjection(await this.getVersionRecord(ctx, id, versionId)); }
  async patch(ctx: KnowledgeScope, id: string, patch: KnowledgeDocumentPatch, revision: number, key: string) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own');
    return documentProjection(await this.resources().repository.mutateDocument(ctx, id, patch, revision, key));
  }
  async replace(ctx: KnowledgeScope, id: string, input: KnowledgeUploadInput, revision: number, key: string) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own');
    return versionProjection(await this.resources().repository.addVersion(ctx, id, input, revision, key));
  }
  async delete(ctx: KnowledgeScope, id: string, revision: number, key: string) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own'); const { repository, files } = this.resources();
    const versions = await repository.listVersionsForCleanup(ctx, id);
    await repository.mutateDocument(ctx, id, { deleted: true }, revision, key);
    // An exact manual retry can still enumerate the actor's tombstoned versions,
    // but no read/download/retrieval API can expose them again.
    for (const version of versions) await files.removeOriginal(ctx, version);
  }
  async acceptOriginal(ctx: KnowledgeScope, id: string, versionId: string, source: Readable, revision: number, key: string, signal?: AbortSignal) {
    assertKnowledgeScope(ctx, 'knowledge.upload');
    if (!Number.isSafeInteger(revision) || revision < 1) throw new GrowthHttpError(428, 'revision_required');
    if (!/^[A-Za-z0-9_.:-]{1,191}$/u.test(key)) throw new GrowthHttpError(400, 'idempotency_key_invalid');
    const { repository, files } = this.resources(), version = await this.getVersionRecord(ctx, id, versionId);
    const controller = new AbortController(); this.controllers.add(controller);
    const bounded = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const abortSource = () => source.destroy(new Error('knowledge_upload_interrupted'));
    bounded.addEventListener('abort', abortSource, { once: true });
    let receipt: { storageKey: string; sourceHash: string; bytes: number } | undefined;
    try {
      bounded.throwIfAborted();
      if (version.uploadComplete) {
        // An explicit replay validates the incoming bytes but never creates a
        // second file or accepts a different body under the same command key.
        let bytes = 0; const hash = createHash('sha256');
        for await (const chunk of source) {
          bounded.throwIfAborted(); bytes += Buffer.byteLength(chunk);
          if (bytes > KNOWLEDGE_MAX_BYTES) throw new GrowthHttpError(413, 'knowledge_upload_too_large'); hash.update(chunk);
        }
        if (bytes !== version.bytes || hash.digest('hex') !== version.sourceHash) throw new GrowthHttpError(409, 'idempotency_conflict');
        return versionProjection(await repository.completeUpload(ctx, versionId, { storageKey: version.storageKey!, sourceHash: version.sourceHash!, bytes }, revision, key));
      }
      if (version.revision !== revision) throw new GrowthHttpError(412, 'revision_mismatch');
      receipt = await files.writeOriginal(ctx, version, source, bounded);
      await files.withOriginal(ctx, { ...version, ...receipt, uploadComplete: true }, path => checkSignature(path, version.format), bounded);
      bounded.throwIfAborted();
      return versionProjection(await repository.completeUpload(ctx, versionId, receipt, revision, key));
    } catch (error) {
      if (receipt) {
        // Never delete a possibly committed original after a network/DB error.
        // Only a successful read proving this key is unreferenced permits cleanup.
        try {
          const current = await repository.getVersion(ctx, id, versionId);
          if (!current || current.storageKey !== receipt.storageKey) await files.removeOriginal(ctx, { ...version, ...receipt });
        } catch { /* Keep encrypted copy for explicit status reconciliation. */ }
      }
      if (error instanceof GrowthHttpError) throw error;
      if (bounded.aborted) throw new GrowthHttpError(408, 'knowledge_upload_interrupted');
      if ((error as Error).message === 'knowledge_upload_too_large') throw new GrowthHttpError(413, 'knowledge_upload_too_large');
      if ((error as Error).message === 'knowledge_upload_size_invalid') throw new GrowthHttpError(400, 'knowledge_upload_size_invalid');
      throw new GrowthHttpError(503, 'knowledge_upload_unavailable');
    } finally { bounded.removeEventListener('abort', abortSource); this.controllers.delete(controller); }
  }
  async withOriginal<T>(ctx: KnowledgeScope, id: string, versionId: string, consume: (path: string, version: KnowledgeVersionRecord) => Promise<T>, signal?: AbortSignal) {
    const version = await this.getVersionRecord(ctx, id, versionId);
    if (!version.uploadComplete) throw new GrowthHttpError(409, 'knowledge_original_unavailable');
    return this.resources().files.withOriginal(ctx, version, async path => {
      // Recheck scope/tombstone after authentication and before releasing bytes.
      await this.getVersionRecord(ctx, id, versionId); return consume(path, version);
    }, signal);
  }
  async chunks(ctx: KnowledgeScope, id: string, versionId: string, query: { cursor?: string; limit: number }) {
    await this.getVersionRecord(ctx, id, versionId); const { repository, crypto } = this.resources(); let after = -1;
    const scope = JSON.stringify([ctx.workspaceId, ctx.actorId, id, versionId]);
    if (query.cursor) {
      try {
        const [body, signature, ...extra] = query.cursor.split('.'); if (extra.length || !crypto.verifyCursor(body, signature)) throw new Error();
        const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (value.scope !== scope || !Number.isInteger(value.after) || value.after < 0) throw new Error(); after = value.after;
      } catch { throw new GrowthHttpError(400, 'knowledge_cursor_invalid'); }
    }
    const values = await repository.listChunkPage(ctx, versionId, after, query.limit + 1), items = values.slice(0, query.limit);
    let nextCursor: string | null = null;
    if (values.length > query.limit) { const body = Buffer.from(JSON.stringify({ scope, after: items.at(-1)!.order })).toString('base64url'); nextCursor = `${body}.${crypto.signCursor(body)}`; }
    return { items, nextCursor };
  }
  async retry(ctx: KnowledgeScope, id: string, versionId: string, revision: number, key: string) {
    await this.getVersionRecord(ctx, id, versionId); return versionProjection(await this.resources().repository.retryJob(ctx, versionId, revision, key));
  }
  async cancel(ctx: KnowledgeScope, id: string) { await this.resources().repository.cancelJob(ctx, id); this.cancelProcessing?.(id); }
  async close() { this.closed = true; for (const controller of this.controllers) controller.abort(); }
}
