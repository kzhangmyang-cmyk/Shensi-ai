import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { GrowthHttpError } from '../growth-command-context.js';
import { assertKnowledgeScope, knowledgeUploadInputSchema, knowledgeDocumentPatchSchema, parsedKnowledgeSchema,
  type KnowledgeScope, type KnowledgeUploadInput, type KnowledgeDocumentRecord, type KnowledgeVersionRecord,
  type KnowledgeDocumentPatch, type KnowledgeChunk, type KnowledgeJobClaim, type ParsedKnowledge } from './domain.js';
import type { KnowledgeRepository, KnowledgeListQuery, KnowledgeUploadReceipt } from './repository.js';
import type { KnowledgeCrypto } from './crypto.js';

type Identity = Pick<KnowledgeScope, 'workspaceId' | 'actorId'>;
type Connection = Pool | PoolConnection;
type Row = RowDataPacket & { id: string; document_id?: string; version_id?: string; workspace_id: string; actor_id: string;
  payload: string; revision: number; enabled?: number; deleted?: number; status?: string; upload_complete?: number };
type JobRow = RowDataPacket & { job_id: string; document_id: string; version_id: string; workspace_id: string;
  actor_id: string; fence: number; lease_until: number; done: number; worker_id: string | null };
const scopeColumns = `workspace_id VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  actor_id VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL`;
export async function ensureKnowledgeMysqlSchema(pool: Pool): Promise<void> {
  const definitions = [
    `knowledge_documents (id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, ${scopeColumns},
      revision INT UNSIGNED NOT NULL, enabled TINYINT NOT NULL, deleted TINYINT NOT NULL,
      payload MEDIUMTEXT NOT NULL, INDEX knowledge_scope (workspace_id,actor_id,deleted,id))`,
    `knowledge_versions (id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, ${scopeColumns},
      document_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, revision INT UNSIGNED NOT NULL,
      status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, upload_complete TINYINT NOT NULL,
      payload MEDIUMTEXT NOT NULL, INDEX knowledge_version_scope (workspace_id,actor_id,document_id,id))`,
    `knowledge_chunks (id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, ${scopeColumns},
      version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, chunk_order INT UNSIGNED NOT NULL,
      payload MEDIUMTEXT NOT NULL, UNIQUE KEY knowledge_chunk_order (version_id,chunk_order),
      INDEX knowledge_chunk_scope (workspace_id,actor_id,version_id))`,
    `knowledge_jobs (job_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, ${scopeColumns},
      document_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, fence BIGINT UNSIGNED NOT NULL,
      lease_until BIGINT UNSIGNED NOT NULL, worker_id VARCHAR(160) NULL, done TINYINT NOT NULL,
      INDEX knowledge_job_claim (done,lease_until), INDEX knowledge_job_document (document_id,done))`,
    `knowledge_commands (id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, ${scopeColumns},
      input_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, payload MEDIUMTEXT NULL)`
  ];
  for (const definition of definitions) await pool.query(`CREATE TABLE IF NOT EXISTS ${definition}
    ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const notFound = () => new GrowthHttpError(404, 'knowledge_not_found');
function revision(actual: number, expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 1) throw new GrowthHttpError(428, 'revision_required');
  if (actual !== expected) throw new GrowthHttpError(412, 'revision_mismatch');
}
function parseUpload(raw: KnowledgeUploadInput) {
  const parsed = knowledgeUploadInputSchema.safeParse(raw);
  if (!parsed.success) throw new GrowthHttpError(400, 'knowledge_input_invalid'); return parsed.data;
}
export class MysqlKnowledgeRepository implements KnowledgeRepository {
  private readonly now: () => number;
  constructor(private readonly pool: Pool, private readonly crypto: KnowledgeCrypto, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }
  private aad(ctx: Identity, kind: string, id: string, versionId?: string) {
    return { workspaceId: ctx.workspaceId, actorId: ctx.actorId, kind, id, ...(versionId ? { versionId } : {}) };
  }
  private async transaction<T>(operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try { await connection.beginTransaction(); const result = await operation(connection); await connection.commit(); return result; }
    catch (error) { await connection.rollback().catch(() => {}); throw error; }
    finally { connection.release(); }
  }
  private async command<T>(ctx: KnowledgeScope, method: string, key: string, input: unknown,
    operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9_.:-]{1,191}$/u.test(key)) throw new GrowthHttpError(400, 'idempotency_key_invalid');
    const id = digest([ctx.workspaceId, ctx.actorId, method, key]), hash = digest(input);
    return this.transaction(async connection => {
      await connection.execute(`INSERT IGNORE INTO knowledge_commands (id,workspace_id,actor_id,input_hash,payload) VALUES (?,?,?,?,NULL)`,
        [id, ctx.workspaceId, ctx.actorId, hash]);
      const [rows] = await connection.execute<(RowDataPacket & { input_hash: string; payload: string | null })[]>(
        `SELECT input_hash,payload FROM knowledge_commands WHERE id=? AND workspace_id=? AND actor_id=? FOR UPDATE`,
        [id, ctx.workspaceId, ctx.actorId]);
      if (rows[0].input_hash !== hash) throw new GrowthHttpError(409, 'idempotency_conflict');
      if (rows[0].payload !== null) return this.crypto.open<T>(this.aad(ctx, 'command', id), rows[0].payload);
      const result = await operation(connection);
      await connection.execute(`UPDATE knowledge_commands SET payload=? WHERE id=?`, [this.crypto.seal(this.aad(ctx, 'command', id), result), id]);
      return structuredClone(result);
    });
  }
  private async document(connection: Connection, ctx: Identity, id: string, lock = false, allowDeleted = false) {
    const [rows] = await connection.execute<Row[]>(`SELECT * FROM knowledge_documents WHERE id=? AND workspace_id=? AND actor_id=?${lock ? ' FOR UPDATE' : ''}`,
      [id, ctx.workspaceId, ctx.actorId]);
    if (!rows.length) throw notFound(); const row = rows[0];
    const record = this.crypto.open<KnowledgeDocumentRecord>(this.aad(ctx, 'document', id), row.payload);
    if (record.id !== id || record.workspaceId !== ctx.workspaceId || record.actorId !== ctx.actorId
      || record.revision !== row.revision || record.enabled !== !!row.enabled || record.deleted !== !!row.deleted) throw new Error('knowledge_record_invalid');
    if (record.deleted && !allowDeleted) throw notFound(); return record;
  }
  private async version(connection: Connection, ctx: Identity, id: string, lock = false) {
    const [rows] = await connection.execute<Row[]>(`SELECT * FROM knowledge_versions WHERE id=? AND workspace_id=? AND actor_id=?${lock ? ' FOR UPDATE' : ''}`,
      [id, ctx.workspaceId, ctx.actorId]);
    if (!rows.length) throw notFound(); const row = rows[0];
    const record = this.crypto.open<KnowledgeVersionRecord>(this.aad(ctx, 'version', id, row.document_id), row.payload);
    if (record.id !== id || record.documentId !== row.document_id || record.workspaceId !== ctx.workspaceId || record.actorId !== ctx.actorId
      || record.revision !== row.revision || record.status !== row.status || record.uploadComplete !== !!row.upload_complete) throw new Error('knowledge_record_invalid');
    return record;
  }
  private async saveDocument(connection: PoolConnection, record: KnowledgeDocumentRecord, insert = false) {
    const payload = this.crypto.seal(this.aad(record, 'document', record.id), record);
    if (insert) await connection.execute(`INSERT INTO knowledge_documents (id,workspace_id,actor_id,revision,enabled,deleted,payload) VALUES (?,?,?,?,?,?,?)`,
      [record.id, record.workspaceId, record.actorId, record.revision, record.enabled, record.deleted, payload]);
    else await connection.execute(`UPDATE knowledge_documents SET revision=?,enabled=?,deleted=?,payload=? WHERE id=? AND workspace_id=? AND actor_id=?`,
      [record.revision, record.enabled, record.deleted, payload, record.id, record.workspaceId, record.actorId]);
  }
  private async saveVersion(connection: PoolConnection, record: KnowledgeVersionRecord, insert = false) {
    const payload = this.crypto.seal(this.aad(record, 'version', record.id, record.documentId), record);
    if (insert) await connection.execute(`INSERT INTO knowledge_versions (id,workspace_id,actor_id,document_id,revision,status,upload_complete,payload) VALUES (?,?,?,?,?,?,?,?)`,
      [record.id, record.workspaceId, record.actorId, record.documentId, record.revision, record.status, record.uploadComplete, payload]);
    else await connection.execute(`UPDATE knowledge_versions SET revision=?,status=?,upload_complete=?,payload=? WHERE id=? AND workspace_id=? AND actor_id=?`,
      [record.revision, record.status, record.uploadComplete, payload, record.id, record.workspaceId, record.actorId]);
  }
  private async newVersion(connection: PoolConnection, ctx: Identity, documentId: string, input: KnowledgeUploadInput) {
    const record: KnowledgeVersionRecord = { id: randomUUID(), documentId, ...ctx, revision: 1, jobId: null,
      filename: input.filename, format: input.format, bytes: input.bytes, sourceHash: null, uploadComplete: false,
      status: 'queued', coverage: null, warnings: [], failureCode: null, storageKey: null, parserVersion: null };
    await this.saveVersion(connection, record, true); return record;
  }
  private async invalidateJobs(connection: PoolConnection, ctx: Identity, documentId: string) {
    const [rows] = await connection.execute<JobRow[]>(`SELECT * FROM knowledge_jobs WHERE document_id=? AND workspace_id=? AND actor_id=? AND done=0 FOR UPDATE`,
      [documentId, ctx.workspaceId, ctx.actorId]);
    for (const job of rows) {
      const version = await this.version(connection, ctx, job.version_id, true);
      version.status = 'cancelled'; version.revision++;
      await this.saveVersion(connection, version);
      await connection.execute(`UPDATE knowledge_jobs SET fence=fence+1,done=1 WHERE job_id=?`, [job.job_id]);
      await connection.execute(`DELETE FROM knowledge_chunks WHERE version_id=? AND workspace_id=? AND actor_id=?`, [version.id, ctx.workspaceId, ctx.actorId]);
    }
  }
  async createDocument(ctx: KnowledgeScope, raw: KnowledgeUploadInput, key: string) {
    assertKnowledgeScope(ctx, 'knowledge.upload'); const input = parseUpload(raw);
    return this.command(ctx, 'create', key, input, async connection => {
      const id = randomUUID(), version = await this.newVersion(connection, { workspaceId: ctx.workspaceId, actorId: ctx.actorId }, id, input);
      const document: KnowledgeDocumentRecord = { id, workspaceId: ctx.workspaceId, actorId: ctx.actorId, revision: 1, title: input.title,
        sourceKind: input.sourceKind, roles: input.roles, enabled: true, deleted: false, activeVersionId: null,
        latestVersionId: version.id, updatedAt: new Date(this.now()).toISOString() };
      await this.saveDocument(connection, document, true); return { document, version };
    });
  }
  async addVersion(ctx: KnowledgeScope, id: string, raw: KnowledgeUploadInput, expected: number, key: string) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own'); const input = parseUpload(raw);
    return this.command(ctx, 'version', key, [id, input, expected], async connection => {
      const document = await this.document(connection, ctx, id, true); revision(document.revision, expected);
      await this.invalidateJobs(connection, ctx, id);
      const version = await this.newVersion(connection, { workspaceId: ctx.workspaceId, actorId: ctx.actorId }, id, input);
      document.latestVersionId = version.id; document.revision++; document.updatedAt = new Date(this.now()).toISOString();
      await this.saveDocument(connection, document); return version;
    });
  }
  async getDocument(ctx: KnowledgeScope, id: string) {
    assertKnowledgeScope(ctx, 'knowledge.read');
    try { return await this.document(this.pool, ctx, id); } catch (error) { if (error instanceof GrowthHttpError && error.status === 404) return null; throw error; }
  }
  async getVersion(ctx: KnowledgeScope, documentId: string, id: string) {
    assertKnowledgeScope(ctx, 'knowledge.read');
    if (!await this.getDocument(ctx, documentId)) return null;
    try { const value = await this.version(this.pool, ctx, id); return value.documentId === documentId ? value : null; }
    catch (error) { if (error instanceof GrowthHttpError && error.status === 404) return null; throw error; }
  }
  async listChunks(ctx: KnowledgeScope, id: string) {
    assertKnowledgeScope(ctx, 'knowledge.read');
    let version: KnowledgeVersionRecord;
    try { version = await this.version(this.pool, ctx, id); } catch (error) { if (error instanceof GrowthHttpError && error.status === 404) return []; throw error; }
    if (!await this.getDocument(ctx, version.documentId)) return [];
    const [rows] = await this.pool.execute<Row[]>(`SELECT * FROM knowledge_chunks WHERE version_id=? AND workspace_id=? AND actor_id=? ORDER BY chunk_order LIMIT 50000`,
      [id, ctx.workspaceId, ctx.actorId]);
    return rows.map(row => this.crypto.open<KnowledgeChunk>(this.aad(ctx, 'chunk', row.id, id), row.payload));
  }
  async listChunkPage(ctx: KnowledgeScope, id: string, afterOrder: number, limit: number) {
    assertKnowledgeScope(ctx, 'knowledge.read');
    if (!Number.isInteger(afterOrder) || afterOrder < -1 || !Number.isInteger(limit) || limit < 1 || limit > 101) throw new GrowthHttpError(400, 'knowledge_limit_invalid');
    let version: KnowledgeVersionRecord;
    try { version = await this.version(this.pool, ctx, id); } catch (error) { if (error instanceof GrowthHttpError && error.status === 404) return []; throw error; }
    if (!await this.getDocument(ctx, version.documentId)) return [];
    const [rows] = await this.pool.execute<Row[]>(`SELECT * FROM knowledge_chunks WHERE version_id=? AND workspace_id=? AND actor_id=? AND chunk_order>? ORDER BY chunk_order LIMIT ${limit}`,
      [id, ctx.workspaceId, ctx.actorId, afterOrder]);
    return rows.map(row => this.crypto.open<KnowledgeChunk>(this.aad(ctx, 'chunk', row.id, id), row.payload));
  }
  async listVersionsForCleanup(ctx: KnowledgeScope, documentId: string) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own'); await this.document(this.pool, ctx, documentId, false, true);
    const [rows] = await this.pool.execute<Row[]>(`SELECT * FROM knowledge_versions WHERE document_id=? AND workspace_id=? AND actor_id=?`,
      [documentId, ctx.workspaceId, ctx.actorId]);
    return rows.map(row => this.crypto.open<KnowledgeVersionRecord>(this.aad(ctx, 'version', row.id, documentId), row.payload));
  }
  async listDocuments(ctx: KnowledgeScope, query: KnowledgeListQuery) {
    assertKnowledgeScope(ctx, 'knowledge.read');
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new GrowthHttpError(400, 'knowledge_limit_invalid');
    const scope = digest([ctx.workspaceId, ctx.actorId, query.q ?? '', query.role ?? '', query.status ?? '']);
    let after = '';
    if (query.cursor) {
      try {
        const [body, signature, ...extra] = query.cursor.split('.');
        if (extra.length || !signature || !this.crypto.verifyCursor(body, signature)) throw new Error();
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (payload.scope !== scope || typeof payload.after !== 'string') throw new Error(); after = payload.after;
      } catch { throw new GrowthHttpError(400, 'knowledge_cursor_invalid'); }
    }
    const matches: KnowledgeDocumentRecord[] = [];
    while (matches.length <= query.limit) {
      const [rows] = await this.pool.execute<Row[]>(`SELECT * FROM knowledge_documents WHERE workspace_id=? AND actor_id=? AND deleted=0 AND id>? ORDER BY id LIMIT 100`,
        [ctx.workspaceId, ctx.actorId, after]);
      if (!rows.length) break;
      for (const row of rows) {
        after = row.id;
        const record = this.crypto.open<KnowledgeDocumentRecord>(this.aad(ctx, 'document', row.id), row.payload);
        if ((query.q && !record.title.toLocaleLowerCase().includes(query.q.toLocaleLowerCase())) || (query.role && !record.roles.includes(query.role))) continue;
        if (query.status && (await this.version(this.pool, ctx, record.latestVersionId)).status !== query.status) continue;
        matches.push(record); if (matches.length > query.limit) break;
      }
      if (rows.length < 100) break;
    }
    const items = matches.slice(0, query.limit); let nextCursor: string | null = null;
    if (matches.length > query.limit) {
      const body = Buffer.from(JSON.stringify({ scope, after: items.at(-1)!.id })).toString('base64url');
      nextCursor = `${body}.${this.crypto.signCursor(body)}`;
    }
    return { items, nextCursor };
  }
  async mutateDocument(ctx: KnowledgeScope, id: string, raw: KnowledgeDocumentPatch, expected: number, key: string) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own'); const parsed = knowledgeDocumentPatchSchema.safeParse(raw);
    if (!parsed.success) throw new GrowthHttpError(400, 'knowledge_input_invalid');
    return this.command(ctx, 'mutate', key, [id, parsed.data, expected], async connection => {
      const record = await this.document(connection, ctx, id, true); revision(record.revision, expected);
      Object.assign(record, parsed.data); record.revision++; record.updatedAt = new Date(this.now()).toISOString();
      if (!record.enabled || record.deleted) await this.invalidateJobs(connection, ctx, id);
      if (record.deleted) await connection.execute(`DELETE c FROM knowledge_chunks c JOIN knowledge_versions v ON v.id=c.version_id
        WHERE v.document_id=? AND c.workspace_id=? AND c.actor_id=?`, [id, ctx.workspaceId, ctx.actorId]);
      await this.saveDocument(connection, record); return record;
    });
  }
  private async insertJob(connection: PoolConnection, ctx: Identity, version: KnowledgeVersionRecord) {
    const id = randomUUID(); version.jobId = id;
    await connection.execute(`INSERT INTO knowledge_jobs (job_id,workspace_id,actor_id,document_id,version_id,fence,lease_until,worker_id,done) VALUES (?,?,?,?,?,0,0,NULL,0)`,
      [id, ctx.workspaceId, ctx.actorId, version.documentId, version.id]);
  }
  private async lockedVersion(connection: PoolConnection, ctx: Identity, id: string) {
    // Look up the immutable parent first; all writes lock parent → job/version.
    const initial = await this.version(connection, ctx, id);
    const document = await this.document(connection, ctx, initial.documentId, true);
    const version = await this.version(connection, ctx, id, true); return { document, version };
  }
  async completeUpload(ctx: KnowledgeScope, id: string, receipt: KnowledgeUploadReceipt, expected: number, key: string) {
    assertKnowledgeScope(ctx, 'knowledge.upload');
    return this.command(ctx, 'upload', key, [id, receipt, expected], async connection => {
      const { document, version } = await this.lockedVersion(connection, ctx, id); revision(version.revision, expected);
      if (version.uploadComplete || !document.enabled || document.latestVersionId !== id) throw new GrowthHttpError(409, 'knowledge_upload_invalid');
      if (!/^[a-f0-9]{64}$/u.test(receipt.sourceHash) || !/^[A-Za-z0-9_-]{1,191}$/u.test(receipt.storageKey) || receipt.bytes !== version.bytes) {
        throw new GrowthHttpError(400, 'knowledge_upload_invalid');
      }
      Object.assign(version, receipt, { uploadComplete: true, revision: version.revision + 1 });
      await this.insertJob(connection, ctx, version); await this.saveVersion(connection, version); return version;
    });
  }
  async retryJob(ctx: KnowledgeScope, id: string, expected: number, key: string) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own');
    return this.command(ctx, 'retry', key, [id, expected], async connection => {
      const { document, version } = await this.lockedVersion(connection, ctx, id); revision(version.revision, expected);
      if (!version.uploadComplete || !document.enabled || document.latestVersionId !== id || !['failed', 'cancelled'].includes(version.status)) {
        throw new GrowthHttpError(409, 'knowledge_retry_invalid');
      }
      await this.invalidateJobs(connection, ctx, document.id); version.status = 'queued'; version.failureCode = null; version.revision++;
      await this.insertJob(connection, ctx, version); await this.saveVersion(connection, version); return version;
    });
  }
  async cancelJob(ctx: KnowledgeScope, id: string) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own');
    const [initial] = await this.pool.execute<JobRow[]>(`SELECT * FROM knowledge_jobs WHERE job_id=? AND workspace_id=? AND actor_id=?`, [id, ctx.workspaceId, ctx.actorId]);
    if (!initial.length) throw notFound();
    await this.transaction(async connection => {
      await this.document(connection, ctx, initial[0].document_id, true);
      const [rows] = await connection.execute<JobRow[]>(`SELECT * FROM knowledge_jobs WHERE job_id=? FOR UPDATE`, [id]);
      if (!rows[0].done) {
        const version = await this.version(connection, ctx, rows[0].version_id, true); version.status = 'cancelled'; version.revision++;
        await this.saveVersion(connection, version);
        await connection.execute(`UPDATE knowledge_jobs SET done=1,fence=fence+1 WHERE job_id=?`, [id]);
        await connection.execute(`DELETE FROM knowledge_chunks WHERE version_id=? AND workspace_id=? AND actor_id=?`, [version.id, ctx.workspaceId, ctx.actorId]);
      }
    });
  }
  async claimJob(workerId: string, now: number, leaseMs: number) {
    if (!workerId || workerId.length > 160 || !Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new GrowthHttpError(400, 'knowledge_lease_invalid');
    }
    const [candidates] = await this.pool.execute<JobRow[]>(`SELECT * FROM knowledge_jobs WHERE done=0 AND lease_until<=? ORDER BY job_id LIMIT 100`, [now]);
    for (const candidate of candidates) {
      const ctx = { workspaceId: candidate.workspace_id, actorId: candidate.actor_id };
      const result = await this.transaction(async connection => {
        const document = await this.document(connection, ctx, candidate.document_id, true, true);
        const [rows] = await connection.execute<JobRow[]>(`SELECT * FROM knowledge_jobs WHERE job_id=? FOR UPDATE`, [candidate.job_id]);
        const job = rows[0], version = await this.version(connection, ctx, candidate.version_id, true);
        if (job.done || Number(job.lease_until) > now || document.deleted || !document.enabled || document.latestVersionId !== version.id || !version.uploadComplete) return null;
        const fence = Number(job.fence) + 1, leaseUntil = now + leaseMs;
        await connection.execute(`UPDATE knowledge_jobs SET fence=?,lease_until=?,worker_id=? WHERE job_id=?`, [fence, leaseUntil, workerId, job.job_id]);
        version.status = 'parsing'; version.revision++; await this.saveVersion(connection, version);
        await connection.execute(`DELETE FROM knowledge_chunks WHERE version_id=? AND workspace_id=? AND actor_id=?`, [version.id, ctx.workspaceId, ctx.actorId]);
        return { jobId: job.job_id, documentId: job.document_id, versionId: version.id, ...ctx, fence, leaseUntil };
      });
      if (result) return result;
    }
    return null;
  }
  private async currentClaim(connection: PoolConnection, claim: KnowledgeJobClaim, now: number) {
    const ctx = { workspaceId: claim.workspaceId, actorId: claim.actorId };
    let document: KnowledgeDocumentRecord;
    try { document = await this.document(connection, ctx, claim.documentId, true, true); }
    catch (error) { if (error instanceof GrowthHttpError && error.status === 404) return null; throw error; }
    const [rows] = await connection.execute<JobRow[]>(`SELECT * FROM knowledge_jobs WHERE job_id=? AND workspace_id=? AND actor_id=? FOR UPDATE`,
      [claim.jobId, ctx.workspaceId, ctx.actorId]);
    const job = rows[0];
    if (!job || job.done || Number(job.fence) !== claim.fence || Number(job.lease_until) <= now || job.document_id !== claim.documentId
      || job.version_id !== claim.versionId || document.deleted || !document.enabled || document.latestVersionId !== claim.versionId) return null;
    return { document, version: await this.version(connection, ctx, claim.versionId, true) };
  }
  private async authorizedClaim(connection: PoolConnection, ctx: KnowledgeScope, claim: KnowledgeJobClaim) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own');
    if (ctx.workspaceId !== claim.workspaceId || ctx.actorId !== claim.actorId) throw new GrowthHttpError(409, 'knowledge_stale_job');
    const value = await this.currentClaim(connection, claim, this.now());
    if (!value) throw new GrowthHttpError(409, 'knowledge_stale_job'); return value;
  }
  async renewClaim(claim: KnowledgeJobClaim, now: number, leaseMs: number) {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) return false;
    return this.transaction(async connection => {
      if (!await this.currentClaim(connection, claim, now)) return false;
      await connection.execute(`UPDATE knowledge_jobs SET lease_until=? WHERE job_id=?`, [now + leaseMs, claim.jobId]); return true;
    });
  }
  async commitParsed(ctx: KnowledgeScope, claim: KnowledgeJobClaim, raw: ParsedKnowledge) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own'); const parsed = parsedKnowledgeSchema.safeParse(raw);
    if (!parsed.success) throw new GrowthHttpError(400, 'knowledge_parse_invalid');
    return this.transaction(async connection => {
      const { version } = await this.authorizedClaim(connection, ctx, claim);
      if (version.status !== 'parsing') throw new GrowthHttpError(409, 'knowledge_stale_job');
      await connection.execute(`DELETE FROM knowledge_chunks WHERE version_id=? AND workspace_id=? AND actor_id=?`, [version.id, ctx.workspaceId, ctx.actorId]);
      // Bounded batches avoid both a giant SQL packet and one query per chunk.
      const chunks = parsed.data.chunks.map(chunk => ({ ...chunk, id: randomUUID(), versionId: version.id }));
      for (let start = 0; start < chunks.length; start += 100) {
        const batch = chunks.slice(start, start + 100), placeholders = batch.map(() => '(?,?,?,?,?,?)').join(',');
        const parameters = batch.flatMap(chunk => [chunk.id, ctx.workspaceId, ctx.actorId, version.id, chunk.order,
          this.crypto.seal(this.aad(ctx, 'chunk', chunk.id, version.id), chunk)]);
        await connection.query(`INSERT INTO knowledge_chunks (id,workspace_id,actor_id,version_id,chunk_order,payload) VALUES ${placeholders}`, parameters);
      }
      // A large parse may outlast its lease while holding locks. It must roll
      // back instead of publishing chunks that a newer worker can supersede.
      if (!await this.currentClaim(connection, claim, this.now())) throw new GrowthHttpError(409, 'knowledge_stale_job');
      version.coverage = parsed.data.coverage; version.warnings = parsed.data.warnings; version.parserVersion = parsed.data.parserVersion;
      version.status = 'indexing'; version.revision++; await this.saveVersion(connection, version); return version;
    });
  }
  async failJob(ctx: KnowledgeScope, claim: KnowledgeJobClaim, code: string) {
    assertKnowledgeScope(ctx, 'knowledge.manage_own');
    if (!/^[a-z0-9_]{1,80}$/u.test(code)) throw new GrowthHttpError(400, 'knowledge_failure_invalid');
    await this.transaction(async connection => {
      const { version } = await this.authorizedClaim(connection, ctx, claim);
      version.status = 'failed'; version.failureCode = code; version.revision++; await this.saveVersion(connection, version);
      await connection.execute(`UPDATE knowledge_jobs SET done=1 WHERE job_id=?`, [claim.jobId]);
      await connection.execute(`DELETE FROM knowledge_chunks WHERE version_id=? AND workspace_id=? AND actor_id=?`, [version.id, ctx.workspaceId, ctx.actorId]);
    });
  }
  async publishReady(ctx: KnowledgeScope, claim: KnowledgeJobClaim, expected: number) {
    return this.transaction(async connection => {
      const { document, version } = await this.authorizedClaim(connection, ctx, claim);
      if (version.status !== 'indexing') throw new GrowthHttpError(409, 'knowledge_not_indexed'); revision(version.revision, expected);
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id FROM knowledge_chunks WHERE version_id=? AND workspace_id=? AND actor_id=? LIMIT 1`,
        [version.id, ctx.workspaceId, ctx.actorId]);
      if (!rows.length) throw new GrowthHttpError(409, 'knowledge_not_indexed');
      version.status = 'ready'; version.revision++; document.activeVersionId = version.id; document.revision++; document.updatedAt = new Date(this.now()).toISOString();
      await this.saveVersion(connection, version); await this.saveDocument(connection, document);
      await connection.execute(`UPDATE knowledge_jobs SET done=1 WHERE job_id=?`, [claim.jobId]); return version;
    });
  }
}
