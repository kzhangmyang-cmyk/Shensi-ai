import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { GrowthHttpError } from '../growth-command-context.js';
import { assertKnowledgeScope, knowledgeUploadInputSchema, knowledgeDocumentPatchSchema, parsedKnowledgeSchema,
  type KnowledgeScope, type KnowledgeUploadInput, type KnowledgeDocumentRecord, type KnowledgeVersionRecord,
  type KnowledgeDocumentPatch, type KnowledgeChunk, type KnowledgeJob, type KnowledgeJobClaim, type ParsedKnowledge } from './domain.js';
import type { KnowledgeRepository, KnowledgeListQuery, KnowledgeUploadReceipt } from './repository.js';

const clone = <T>(value: T): T => structuredClone(value);
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export class MemoryKnowledgeRepository implements KnowledgeRepository {
  private readonly documents = new Map<string, KnowledgeDocumentRecord>();
  private readonly versions = new Map<string, KnowledgeVersionRecord>();
  private readonly chunks = new Map<string, KnowledgeChunk[]>();
  private readonly jobs = new Map<string, KnowledgeJob>();
  private readonly commands = new Map<string, { hash: string; result: unknown }>();
  private readonly now: () => number;
  private readonly cursorSecret: Buffer;
  constructor(options: { now?: () => number; cursorSecret?: Buffer } = {}) {
    this.now = options.now ?? Date.now; this.cursorSecret = options.cursorSecret ?? randomBytes(32);
  }
  private owns(ctx: KnowledgeScope, value: { workspaceId: string; actorId: string }) {
    return value.workspaceId === ctx.workspaceId && value.actorId === ctx.actorId;
  }
  private document(ctx: KnowledgeScope, id: string): KnowledgeDocumentRecord {
    const value = this.documents.get(id);
    if (!value || value.deleted || !this.owns(ctx, value)) throw new GrowthHttpError(404, 'knowledge_not_found');
    return value;
  }
  private version(ctx: KnowledgeScope, id: string): KnowledgeVersionRecord {
    const value = this.versions.get(id);
    if (!value || !this.owns(ctx, value)) throw new GrowthHttpError(404, 'knowledge_not_found');
    this.document(ctx, value.documentId); return value;
  }
  private revision(actual: number, expected: number) {
    if (!Number.isSafeInteger(expected) || expected < 1) throw new GrowthHttpError(428, 'revision_required');
    if (actual !== expected) throw new GrowthHttpError(412, 'revision_mismatch');
  }
  private command<T>(ctx: KnowledgeScope, method: string, key: string, input: unknown, operation: () => T): T {
    if (!/^[A-Za-z0-9_.:-]{1,191}$/u.test(key)) throw new GrowthHttpError(400, 'idempotency_key_invalid');
    const id = digest([ctx.workspaceId, ctx.actorId, method, key]), hash = digest(input);
    const previous = this.commands.get(id);
    if (previous) {
      if (previous.hash !== hash) throw new GrowthHttpError(409, 'idempotency_conflict');
      return clone(previous.result) as T;
    }
    const result = operation(); this.commands.set(id, { hash, result: clone(result) }); return clone(result);
  }
  private newVersion(ctx: KnowledgeScope, documentId: string, input: KnowledgeUploadInput) {
    const version: KnowledgeVersionRecord = { id: randomUUID(), documentId, workspaceId: ctx.workspaceId, actorId: ctx.actorId,
      revision: 1, jobId: null, filename: input.filename, format: input.format, bytes: input.bytes, sourceHash: null,
      uploadComplete: false, status: 'queued', coverage: null, warnings: [], failureCode: null,
      storageKey: null, parserVersion: null };
    this.versions.set(version.id, version); return version;
  }
  private invalidateJobs(documentId: string) {
    for (const job of this.jobs.values()) if (job.documentId === documentId && !job.done) {
      job.fence++; job.done = true;
      const version = this.versions.get(job.versionId)!;
      version.status = 'cancelled'; version.revision++;
      this.chunks.delete(version.id);
    }
  }
  async createDocument(ctx: KnowledgeScope, raw: KnowledgeUploadInput, key: string) {
    assertKnowledgeScope(ctx, 'knowledge.upload'); const parsed = knowledgeUploadInputSchema.safeParse(raw);
    if (!parsed.success) throw new GrowthHttpError(400, 'knowledge_input_invalid');
    return this.command(ctx, 'create', key, parsed.data, () => {
      const id = randomUUID(); const version = this.newVersion(ctx, id, parsed.data);
      const document: KnowledgeDocumentRecord = { id, revision: 1, title: parsed.data.title,
        sourceKind: parsed.data.sourceKind, roles: parsed.data.roles, enabled: true, deleted: false,
        activeVersionId: null, latestVersionId: version.id, workspaceId: ctx.workspaceId,
        actorId: ctx.actorId, updatedAt: new Date(this.now()).toISOString() };
      this.documents.set(id, document); return { document, version };
    });
  }
  async addVersion(ctx: KnowledgeScope, id: string, raw: KnowledgeUploadInput, revision: number, key: string) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own'); const parsed = knowledgeUploadInputSchema.safeParse(raw);
    if (!parsed.success) throw new GrowthHttpError(400, 'knowledge_input_invalid');
    this.document(ctx, id);
    return this.command(ctx, 'version', key, [id, parsed.data, revision], () => {
      const document = this.document(ctx, id); this.revision(document.revision, revision);
      this.invalidateJobs(id); const version = this.newVersion(ctx, id, parsed.data);
      document.latestVersionId = version.id; document.revision++; document.updatedAt = new Date(this.now()).toISOString();
      return version;
    });
  }
  async getDocument(ctx: KnowledgeScope, id: string) {
    assertKnowledgeScope(ctx, 'knowledge.read'); const record = this.documents.get(id);
    return record && !record.deleted && this.owns(ctx, record) ? clone(record) : null;
  }
  async getVersion(ctx: KnowledgeScope, id: string, versionId: string) {
    assertKnowledgeScope(ctx, 'knowledge.read'); if (!await this.getDocument(ctx, id)) return null;
    const record = this.versions.get(versionId);
    return record?.documentId === id && this.owns(ctx, record) ? clone(record) : null;
  }
  async listChunks(ctx: KnowledgeScope, versionId: string) {
    assertKnowledgeScope(ctx, 'knowledge.read'); const version = this.versions.get(versionId);
    if (!version || !await this.getVersion(ctx, version.documentId, versionId)) return [];
    return clone(this.chunks.get(versionId) ?? []);
  }
  async listDocuments(ctx: KnowledgeScope, query: KnowledgeListQuery) {
    assertKnowledgeScope(ctx, 'knowledge.read');
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new GrowthHttpError(400, 'knowledge_limit_invalid');
    const scope = digest([ctx.workspaceId, ctx.actorId, query.q ?? '', query.role ?? '', query.status ?? '']);
    let after = '';
    if (query.cursor) {
      try {
        const [body, signature, ...extra] = query.cursor.split('.');
        const expected = createHmac('sha256', this.cursorSecret).update(body).digest();
        const received = Buffer.from(signature, 'base64url');
        if (extra.length || received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error();
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (payload.scope !== scope || typeof payload.after !== 'string') throw new Error();
        after = payload.after;
      } catch { throw new GrowthHttpError(400, 'knowledge_cursor_invalid'); }
    }
    const values = [...this.documents.values()].filter(document => this.owns(ctx, document) && !document.deleted
      && document.id > after && (!query.q || document.title.toLocaleLowerCase().includes(query.q.toLocaleLowerCase()))
      && (!query.role || document.roles.includes(query.role))
      && (!query.status || this.versions.get(document.latestVersionId)?.status === query.status))
      .sort((a, b) => a.id.localeCompare(b.id));
    const items = values.slice(0, query.limit); let nextCursor: string | null = null;
    if (values.length > items.length) {
      const body = Buffer.from(JSON.stringify({ scope, after: items.at(-1)!.id })).toString('base64url');
      nextCursor = `${body}.${createHmac('sha256', this.cursorSecret).update(body).digest('base64url')}`;
    }
    return { items: clone(items), nextCursor };
  }
  async mutateDocument(ctx: KnowledgeScope, id: string, raw: KnowledgeDocumentPatch, revision: number, key: string) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own'); const parsed = knowledgeDocumentPatchSchema.safeParse(raw);
    if (!parsed.success) throw new GrowthHttpError(400, 'knowledge_input_invalid');
    return this.command(ctx, 'mutate', key, [id, parsed.data, revision], () => {
      const document = this.document(ctx, id); this.revision(document.revision, revision);
      Object.assign(document, parsed.data); document.revision++; document.updatedAt = new Date(this.now()).toISOString();
      if (document.deleted || !document.enabled) this.invalidateJobs(id);
      if (document.deleted) {
        for (const version of this.versions.values()) if (version.documentId === id) this.chunks.delete(version.id);
      }
      return document;
    });
  }
  async completeUpload(ctx: KnowledgeScope, id: string, receipt: KnowledgeUploadReceipt, revision: number, key: string) {
    assertKnowledgeScope(ctx, 'knowledge.upload'); this.version(ctx, id);
    return this.command(ctx, 'upload', key, [id, receipt, revision], () => {
      const version = this.version(ctx, id), document = this.document(ctx, version.documentId);
      this.revision(version.revision, revision);
      if (version.uploadComplete || !document.enabled || document.latestVersionId !== id) throw new GrowthHttpError(409, 'knowledge_upload_invalid');
      if (!/^[a-f0-9]{64}$/u.test(receipt.sourceHash) || !/^[A-Za-z0-9_-]{1,191}$/u.test(receipt.storageKey)
        || receipt.bytes !== version.bytes) throw new GrowthHttpError(400, 'knowledge_upload_invalid');
      Object.assign(version, receipt, { uploadComplete: true, revision: version.revision + 1 });
      const jobId = randomUUID(); version.jobId = jobId; this.jobs.set(jobId, { jobId, documentId: version.documentId, versionId: id,
        workspaceId: ctx.workspaceId, actorId: ctx.actorId, fence: 0, leaseUntil: 0, workerId: null, done: false });
      return version;
    });
  }
  async retryJob(ctx: KnowledgeScope, id: string, revision: number, key: string) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own'); this.version(ctx, id);
    return this.command(ctx, 'retry', key, [id, revision], () => {
      const version = this.version(ctx, id), document = this.document(ctx, version.documentId);
      this.revision(version.revision, revision);
      if (!version.uploadComplete || !document.enabled || document.latestVersionId !== id
        || !['failed', 'cancelled'].includes(version.status)) throw new GrowthHttpError(409, 'knowledge_retry_invalid');
      this.invalidateJobs(document.id); version.status = 'queued'; version.failureCode = null; version.revision++;
      const jobId = randomUUID(); version.jobId = jobId; this.jobs.set(jobId, { jobId, documentId: document.id, versionId: id,
        workspaceId: ctx.workspaceId, actorId: ctx.actorId, fence: 0, leaseUntil: 0, workerId: null, done: false });
      return version;
    });
  }
  async cancelJob(ctx: KnowledgeScope, id: string) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own'); const job = this.jobs.get(id);
    if (!job || !this.owns(ctx, job)) throw new GrowthHttpError(404, 'knowledge_not_found');
    this.document(ctx, job.documentId);
    if (!job.done) { job.done = true; job.fence++; const version = this.versions.get(job.versionId)!;
      version.status = 'cancelled'; version.revision++; this.chunks.delete(version.id); }
  }
  async claimJob(workerId: string, now: number, leaseMs: number) {
    if (!workerId || !Number.isSafeInteger(now) || leaseMs <= 0) throw new GrowthHttpError(400, 'knowledge_lease_invalid');
    for (const job of this.jobs.values()) {
      const document = this.documents.get(job.documentId)!, version = this.versions.get(job.versionId)!;
      if (job.done || job.leaseUntil > now || document.deleted || !document.enabled || document.latestVersionId !== version.id
        || !version.uploadComplete) continue;
      job.fence++; job.leaseUntil = now + leaseMs; job.workerId = workerId;
      version.status = 'parsing'; version.revision++; this.chunks.delete(version.id);
      const { done: _done, workerId: _workerId, ...claim } = job; return clone(claim);
    }
    return null;
  }
  private currentClaim(claim: KnowledgeJobClaim, now: number) {
    const job = this.jobs.get(claim.jobId), document = this.documents.get(claim.documentId);
    return job && !job.done && job.fence === claim.fence && job.leaseUntil > now
      && job.versionId === claim.versionId && job.documentId === claim.documentId
      && job.workspaceId === claim.workspaceId && job.actorId === claim.actorId
      && document && !document.deleted && document.enabled && document.latestVersionId === claim.versionId ? job : null;
  }
  private authorizedClaim(ctx: KnowledgeScope, claim: KnowledgeJobClaim) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own');
    if (!this.owns(ctx, claim) || !this.currentClaim(claim, this.now())) throw new GrowthHttpError(409, 'knowledge_stale_job');
    return this.versions.get(claim.versionId)!;
  }
  async renewClaim(claim: KnowledgeJobClaim, now: number, leaseMs: number) {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) return false;
    const job = this.currentClaim(claim, now); if (!job) return false;
    job.leaseUntil = now + leaseMs; return true;
  }
  async commitParsed(ctx: KnowledgeScope, claim: KnowledgeJobClaim, raw: ParsedKnowledge) {
    const version = this.authorizedClaim(ctx, claim), parsed = parsedKnowledgeSchema.safeParse(raw);
    if (!parsed.success) throw new GrowthHttpError(400, 'knowledge_parse_invalid');
    if (version.status !== 'parsing') throw new GrowthHttpError(409, 'knowledge_stale_job');
    const chunks = parsed.data.chunks.map(chunk => ({ ...chunk, id: randomUUID(), versionId: version.id }));
    this.chunks.set(version.id, chunks); version.coverage = parsed.data.coverage; version.warnings = parsed.data.warnings;
    version.parserVersion = parsed.data.parserVersion; version.status = 'indexing'; version.revision++; return clone(version);
  }
  async failJob(ctx: KnowledgeScope, claim: KnowledgeJobClaim, code: string) {
    const version = this.authorizedClaim(ctx, claim);
    if (!/^[a-z0-9_]{1,80}$/u.test(code)) throw new GrowthHttpError(400, 'knowledge_failure_invalid');
    version.status = 'failed'; version.failureCode = code; version.revision++; this.jobs.get(claim.jobId)!.done = true;
    this.chunks.delete(version.id);
  }
  async publishReady(ctx: KnowledgeScope, claim: KnowledgeJobClaim, revision: number) {
    const version = this.authorizedClaim(ctx, claim);
    if (version.status !== 'indexing' || !this.chunks.get(version.id)?.length) throw new GrowthHttpError(409, 'knowledge_not_indexed');
    this.revision(version.revision, revision);
    version.status = 'ready'; version.revision++; const document = this.document(ctx, version.documentId);
    document.activeVersionId = version.id; document.revision++; document.updatedAt = new Date(this.now()).toISOString();
    this.jobs.get(claim.jobId)!.done = true; return clone(version);
  }
}
