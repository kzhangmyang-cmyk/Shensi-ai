import { randomUUID } from 'node:crypto';
import { assertKnowledgeScope, type KnowledgeScope, type KnowledgeJobClaim } from './domain.js';
import type { KnowledgeRepository } from './repository.js';
import type { KnowledgeFileStore } from './file-store.js';
import type { KnowledgeReader } from './reader-gateway.js';

export interface KnowledgeIngestionOptions {
  repository: KnowledgeRepository; files: KnowledgeFileStore; reader: KnowledgeReader;
  authorizeJob(claim: KnowledgeJobClaim): Promise<KnowledgeScope>;
  indexVersion?: (ctx: KnowledgeScope, versionId: string) => Promise<void>;
  now?: () => number; renewIntervalMs?: number; maxDurationMs?: number;
}
/** One local parser, persisted claims and fresh authorization; no model calls. */
export class KnowledgeIngestionWorker {
  private readonly controller = new AbortController();
  private readonly workerId = randomUUID();
  private active: Promise<boolean> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private current: { jobId: string; controller: AbortController } | null = null;
  constructor(private readonly options: KnowledgeIngestionOptions) {}
  start(intervalMs = 2000): boolean {
    // Until a real index exists, do not reclaim/reparse indexing jobs forever.
    if (!this.options.indexVersion || this.controller.signal.aborted) return false;
    if (!this.timer) { this.timer = setInterval(() => { void this.runOnce().catch(() => {}); }, intervalMs); this.timer.unref(); void this.runOnce().catch(() => {}); }
    return true;
  }
  runOnce(signal?: AbortSignal): Promise<boolean> {
    if (this.active) return this.active;
    const pending = this.execute(signal).finally(() => { if (this.active === pending) this.active = null; });
    this.active = pending; return pending;
  }
  cancel(jobId: string): boolean {
    if (this.current?.jobId !== jobId) return false;
    this.current.controller.abort(new Error('knowledge_reader_cancelled')); return true;
  }
  private async authorize(claim: KnowledgeJobClaim) {
    const ctx = await this.options.authorizeJob(claim);
    assertKnowledgeScope(ctx, 'knowledge.read'); assertKnowledgeScope(ctx, 'knowledge.upload');
    if (ctx.actorId !== claim.actorId || ctx.workspaceId !== claim.workspaceId) throw new Error('knowledge_authorization_revoked');
    return ctx;
  }
  private async execute(signal?: AbortSignal) {
    if (this.controller.signal.aborted || signal?.aborted) return false;
    const now = this.options.now ?? Date.now, lease = 60_000;
    const claim = await this.options.repository.claimJob(this.workerId, now(), lease); if (!claim) return false;
    const own = new AbortController(), bounded = AbortSignal.any([own.signal, this.controller.signal, ...(signal ? [signal] : [])]);
    this.current = { jobId: claim.jobId, controller: own };
    let lostLease = false, renewing: Promise<void> | null = null;
    const heartbeat = setInterval(() => {
      if (renewing || bounded.aborted) return;
      renewing = (async () => {
        try {
          await this.authorize(claim);
          if (!await this.options.repository.renewClaim(claim, now(), lease)) throw new Error('knowledge_stale_job');
        } catch { lostLease = true; own.abort(new Error('knowledge_stale_job')); }
      })().finally(() => { renewing = null; });
    }, this.options.renewIntervalMs ?? 20_000);
    const deadline = setTimeout(() => own.abort(new Error('knowledge_reader_limit')), this.options.maxDurationMs ?? 60 * 60_000);
    try {
      let ctx = await this.authorize(claim);
      const version = await this.options.repository.getVersion(ctx, claim.documentId, claim.versionId);
      if (!version) throw new Error('knowledge_authorization_revoked');
      const parsed = await this.options.files.withOriginal(ctx, version,
        inputPath => this.options.reader.read({ inputPath, format: version.format, bytes: version.bytes }, bounded,
          {workspaceId:ctx.workspaceId,actorId:ctx.actorId}), bounded);
      bounded.throwIfAborted(); ctx = await this.authorize(claim);
      const indexed = await this.options.repository.commitParsed(ctx, claim, parsed);
      if (!this.options.indexVersion) return true; // explicit test/manual staging only
      await this.options.indexVersion(ctx, claim.versionId);
      bounded.throwIfAborted(); ctx = await this.authorize(claim);
      if (!await this.options.repository.renewClaim(claim, now(), lease)) throw new Error('knowledge_stale_job');
      await this.options.repository.publishReady(ctx, claim, indexed.revision); return true;
    } catch (error) {
      // Shutdown/client cancellation leaves the durable lease recoverable. A lost
      // lease must never mutate a newer worker's job, even to mark it failed.
      if (!lostLease && !this.controller.signal.aborted && !signal?.aborted) {
        try {
          const ctx = await this.authorize(claim), value = (error as { code?: string; message?: string }).code ?? (error as Error).message;
          const code = /^knowledge_[a-z0-9_]{1,60}$/u.test(value ?? '') ? value! : 'knowledge_parse_failed';
          await this.options.repository.failJob(ctx, claim, code);
        } catch { /* revoked/expired claims cannot be updated */ }
      }
      return false;
    } finally { clearInterval(heartbeat); clearTimeout(deadline); await renewing; if (this.current?.controller === own) this.current = null; }
  }
  async close() {
    if (this.timer) clearInterval(this.timer); this.timer = null; this.controller.abort(); await this.active;
  }
}
