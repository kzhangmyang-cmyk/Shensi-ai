import MiniSearch from 'minisearch';
import { createHash } from 'node:crypto';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { assertKnowledgeScope, knowledgeRoleSchema, type KnowledgeScope, type KnowledgeRole,
  type KnowledgeDocumentRecord, type KnowledgeVersionRecord, type KnowledgeChunk,
  type KnowledgeEvidence, type KnowledgeCitation } from './domain.js';
import type { KnowledgeRepository } from './repository.js';

const MAX_INPUT = 64 * 1024 * 1024;
const empty = (status: KnowledgeEvidence['status']): KnowledgeEvidence => ({ status, sources: [] });
const scopeKey = (ctx: KnowledgeScope) => JSON.stringify([ctx.workspaceId, ctx.actorId]);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const signature = (docs: KnowledgeDocumentRecord[]) => digest(docs.map(d => [d.id, d.revision, d.activeVersionId]).sort());
const stopWords = new Set(['你好', '您好', '谢谢', '你', '我', '我们', '请', '帮', '一下', '怎么', '如何', '什么', '是否', '的', '了', '吗', '做', '计划', '预测']);
let segmenter: Intl.Segmenter | undefined;
function tokenize(text: string): string[] {
  segmenter ??= new Intl.Segmenter('zh-CN', { granularity: 'word' });
  const normalized = text.normalize('NFKC').toLowerCase()
    .replace(/应收账款回收|现金回款|货款回收|资金回笼|回款/gu, '现金流');
  return [...new Set([...segmenter.segment(normalized)].filter(s => s.isWordLike && !stopWords.has(s.segment)).map(s => s.segment))];
}
type Entry = { document: KnowledgeDocumentRecord; version: KnowledgeVersionRecord; chunk: KnowledgeChunk };
type IndexRow = { id: string; title: string; chapter: string; text: string };
type Index = { engine: MiniSearch<IndexRow>; entries: Map<string, Entry>; bytes: number; signature: string };
export type KnowledgeRetrievalPort = Pick<KnowledgeRetriever, 'retrieve' | 'assertCurrent'>;
export interface KnowledgeRetrievalOptions { maxInputBytes?: number; authorizeScope?: (ctx: KnowledgeScope) => Promise<KnowledgeScope>; }

/** Rebuildable local lexical references: no model, embeddings, network or plaintext index files. */
export class KnowledgeRetriever {
  private readonly caches = new Map<string, Index>();
  private readonly generations = new Map<string, number>();
  private readonly builds = new Set<Index>();
  private readonly proofs = new WeakMap<KnowledgeEvidence, { key: string; role: KnowledgeRole; digest: string; entries: Entry[] }>();
  private readonly limit: number;
  private closed = false;
  constructor(private readonly repository: KnowledgeRepository, private readonly options: KnowledgeRetrievalOptions = {}) {
    this.limit = Math.min(MAX_INPUT, options.maxInputBytes ?? MAX_INPUT);
    if (!Number.isSafeInteger(this.limit) || this.limit < 1) throw new Error('knowledge_index_configuration_invalid');
  }
  invalidate(ctx: KnowledgeScope, _documentId: string): void {
    const key = scopeKey(ctx); this.caches.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }
  close(): void { this.closed = true; this.caches.clear(); }
  private check(ctx: KnowledgeScope, signal?: AbortSignal) {
    signal?.throwIfAborted(); assertKnowledgeScope(ctx, 'knowledge.read');
    if (this.closed) throw new Error('knowledge_index_closed');
  }
  private async authorize(ctx: KnowledgeScope, signal?: AbortSignal) {
    this.check(ctx, signal);
    const current = await this.options.authorizeScope?.(ctx) ?? ctx;
    if (scopeKey(current) !== scopeKey(ctx)) throw new Error('knowledge_authorization_revoked');
    this.check(current, signal); return current;
  }
  private async documents(ctx: KnowledgeScope, signal?: AbortSignal, includePending = false) {
    const docs: KnowledgeDocumentRecord[] = [], cursors = new Set<string>();
    let cursor: string | undefined, count = 0, bytes = 0;
    do {
      await this.authorize(ctx, signal);
      const page = await this.repository.listDocuments(ctx, { limit: 100, cursor });
      for (const document of page.items) {
        bytes += Buffer.byteLength(JSON.stringify(document)); count++;
        if (bytes > this.limit || count > 10000) throw new Error('knowledge_index_limit');
        if (document.enabled && !document.deleted && (includePending || document.activeVersionId)) docs.push(document);
      }
      if (page.nextCursor && cursors.has(page.nextCursor)) throw new Error('knowledge_index_invalid');
      if (page.nextCursor) cursors.add(page.nextCursor);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    this.check(ctx, signal); return docs;
  }
  private reserve(index: Index, bytes: number) {
    if (index.bytes + bytes > this.limit) throw new Error('knowledge_index_limit');
    const used = () => [...this.caches.values(), ...this.builds].reduce((n, i) => n + i.bytes, 0);
    while (used() + bytes > this.limit && this.caches.size) this.caches.delete(this.caches.keys().next().value!);
    if (used() + bytes > this.limit) throw new Error('knowledge_index_limit');
    index.bytes += bytes;
  }
  private async build(ctx: KnowledgeScope, docs: KnowledgeDocumentRecord[], signal?: AbortSignal, stagingId?: string): Promise<Index> {
    const index: Index = { engine: new MiniSearch<IndexRow>({ fields: ['title', 'chapter', 'text'], tokenize, processTerm: term => term,
      logger: () => {}, autoVacuum: false }), entries: new Map(), bytes: 0, signature: signature(docs) };
    this.builds.add(index); let complete = false;
    try {
      for (const document of docs) {
        this.check(ctx, signal);
        const version = await this.repository.getVersion(ctx, document.id, document.activeVersionId!);
        const expectedStatus = version?.id === stagingId ? 'indexing' : 'ready';
        if (!version || version.status !== expectedStatus || !version.uploadComplete || !version.sourceHash) throw new Error('knowledge_index_stale');
        this.reserve(index, Buffer.byteLength(JSON.stringify([document, version])));
        let after = -1, count = 0;
        for (;;) {
          await this.authorize(ctx, signal);
          const chunks = await this.repository.listChunkPage(ctx, version.id, after, 100);
          if (!chunks.length) break;
          for (const chunk of chunks) {
            if (chunk.versionId !== version.id || chunk.order <= after || ++count > 50000 || index.entries.has(chunk.id)) throw new Error('knowledge_index_invalid');
            this.reserve(index, Buffer.byteLength(JSON.stringify(chunk)) + Buffer.byteLength(document.title) + Buffer.byteLength(chunk.locator.chapter ?? ''));
            index.engine.add({ id: chunk.id, title: document.title, chapter: chunk.locator.chapter ?? '', text: chunk.text });
            index.entries.set(chunk.id, { document, version, chunk }); after = chunk.order;
          }
          await yieldToLoop(undefined, { signal });
        }
        if (!count) throw new Error('knowledge_index_empty');
        const current = await this.repository.getVersion(ctx, document.id, version.id);
        if (!current || current.status !== expectedStatus || current.revision !== version.revision) throw new Error('knowledge_index_stale');
      }
      this.check(ctx, signal); complete = true; return index;
    } finally { if (!complete) this.builds.delete(index); }
  }
  async indexVersion(ctx: KnowledgeScope, versionId: string): Promise<void> {
    ctx = await this.authorize(ctx);
    const pageDocs = await this.documents(ctx, undefined, true);
    const document = pageDocs.find(d => d.latestVersionId === versionId && d.enabled && !d.deleted);
    if (!document) throw new Error('knowledge_index_stale');
    const docs = pageDocs.filter(d => d.enabled && !d.deleted && d.activeVersionId && d.id !== document.id);
    docs.push({ ...document, activeVersionId: versionId });
    // Validate a complete candidate including the staged replacement; never
    // serve indexing content or switch the repository's active version here.
    const candidate = await this.build(ctx, docs, undefined, versionId);
    try { await this.authorize(ctx); this.invalidate(ctx, document.id); }
    finally { this.builds.delete(candidate); }
  }
  /** Model completion is a second release boundary, independent of the cache. */
  async assertCurrent(ctx: KnowledgeScope, input: { role: KnowledgeRole; evidence: KnowledgeEvidence }, signal?: AbortSignal): Promise<void> {
    try {
      ctx = await this.authorize(ctx, signal);
      if (input.evidence.status !== 'used') {
        if (input.evidence.sources.length) throw new Error('invalid evidence');
        return;
      }
      const proof = this.proofs.get(input.evidence), key = scopeKey(ctx), generation = this.generations.get(key) ?? 0;
      if (!proof || proof.key !== key || proof.role !== input.role || proof.digest !== digest(input.evidence)) throw new Error('invalid evidence');
      for (const entry of proof.entries) {
        const version = await this.repository.getVersion(ctx, entry.document.id, entry.version.id);
        if (!version || version.status !== 'ready' || version.sourceHash !== entry.version.sourceHash || version.revision !== entry.version.revision) throw new Error('stale version');
      }
      for (const entry of proof.entries) {
        const document = await this.repository.getDocument(ctx, entry.document.id);
        if (!document || !document.enabled || document.deleted || !document.roles.includes(input.role)
          || document.activeVersionId !== entry.version.id || document.revision !== entry.document.revision) throw new Error('stale document');
      }
      await this.authorize(ctx, signal);
      if ((this.generations.get(key) ?? 0) !== generation) throw new Error('stale release');
    } catch {
      signal?.throwIfAborted();
      throw new Error('knowledge_reference_stale');
    }
  }
  async retrieve(ctx: KnowledgeScope, input: { question: string; role: KnowledgeRole }, signal?: AbortSignal): Promise<KnowledgeEvidence> {
    signal?.throwIfAborted(); assertKnowledgeScope(ctx, 'knowledge.read');
    if (typeof input.question !== 'string' || input.question.length > 8000 || !knowledgeRoleSchema.safeParse(input.role).success) throw new Error('knowledge_query_invalid');
    let candidate: Index | undefined;
    try {
      ctx = await this.authorize(ctx, signal);
      if (!tokenize(input.question).length) return empty('no_match');
      const key = scopeKey(ctx), generation = this.generations.get(key) ?? 0, docs = await this.documents(ctx, signal);
      const fingerprint = signature(docs);
      let index = this.caches.get(key);
      if (!index || index.signature !== fingerprint) {
        this.caches.delete(key); index = candidate = await this.build(ctx, docs, signal);
        if ((this.generations.get(key) ?? 0) !== generation || signature(await this.documents(ctx, signal)) !== fingerprint) return empty('unavailable');
        this.builds.delete(index); this.caches.set(key, index);
      }
      // LRU touch; a cache is disposable and at most two concrete scopes exist.
      this.caches.delete(key); this.caches.set(key, index);
      while (this.caches.size > 2) this.caches.delete(this.caches.keys().next().value!);
      const identifiers = tokenize(input.question).filter(term => /^[a-z0-9]*\d{4,}[a-z0-9]*$/u.test(term));
      const hits = index.engine.search(input.question, { combineWith: 'OR', prefix: false, fuzzy: false, boost: { title: 2, chapter: 1.5 },
        filter: result => index!.entries.get(String(result.id))?.document.roles.includes(input.role) === true && identifiers.every(id => result.terms.includes(id)) });
      const candidates: Entry[] = [], seen = new Set<string>(); let used = 0;
      for (const hit of hits) {
        this.check(ctx, signal); const entry = index.entries.get(String(hit.id)); if (!entry) continue;
        const duplicate = entry.chunk.text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
        if (seen.has(duplicate) || used + entry.chunk.text.length > 12000) continue;
        seen.add(duplicate); used += entry.chunk.text.length; candidates.push(entry); if (candidates.length === 6) break;
      }
      const sources: KnowledgeCitation[] = [], released: Entry[] = [];
      // Check versions first, then every document in a final pass: a tombstone
      // arriving during a version read must not release the cached excerpt.
      const valid: Entry[] = [];
      for (const entry of candidates) {
        const version = await this.repository.getVersion(ctx, entry.document.id, entry.version.id);
        if (version?.status === 'ready' && version.sourceHash === entry.version.sourceHash && version.revision === entry.version.revision) valid.push(entry);
      }
      for (const entry of valid) {
        const document = await this.repository.getDocument(ctx, entry.document.id);
        if (!document?.enabled || document.deleted || document.activeVersionId !== entry.version.id || document.revision !== entry.document.revision || !document.roles.includes(input.role)) continue;
        released.push(entry);
        sources.push({ sourceId: `K${sources.length + 1}`, documentId: document.id, versionId: entry.version.id,
          sourceHash: entry.version.sourceHash!, chunkId: entry.chunk.id, sourceLabel: `${document.title} · ${entry.version.filename}`,
          locator: structuredClone(entry.chunk.locator), excerpt: entry.chunk.text,
          warnings: [...new Set([...entry.version.warnings, ...entry.chunk.warnings])].slice(0, 100) });
      }
      this.check(ctx, signal);
      if ((this.generations.get(key) ?? 0) !== generation) return empty('unavailable');
      if (sources.length && signature(await this.documents(ctx, signal)) !== fingerprint) return empty('unavailable');
      await this.authorize(ctx, signal);
      const evidence: KnowledgeEvidence = { status: sources.length ? 'used' : 'no_match', sources };
      if (sources.length) this.proofs.set(evidence, { key, role: input.role, digest: digest(evidence), entries: released });
      return evidence;
    } catch (error) {
      signal?.throwIfAborted(); assertKnowledgeScope(ctx, 'knowledge.read');
      return empty('unavailable'); // never disclose database/file details or fake no-match
    } finally { if (candidate) this.builds.delete(candidate); }
  }
}
