import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type mysql from "mysql2/promise";
import type {
  AcquisitionCandidate,
  AcquisitionCandidateIdentityAlias,
  DiscoveryEvidence
} from "./acquisition-domain.js";
import type {
  AcquisitionDomainRepository,
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import type {
  DouyinCrawlerCandidate,
  DouyinCrawlerEvidence,
  DouyinCrawlerEvidenceStore
} from "./acquisition-douyin-crawler-ingestion.js";
import type {
  MysqlAcquisitionDomainRepository,
  MysqlAcquisitionPlanRunRepository
} from "./acquisition-mysql-repositories.js";
import type {
  AcquisitionPlanRunRepositoryTransaction,
  AcquisitionRun,
  InMemoryAcquisitionPlanRunRepository
} from "./acquisition-plan-run-repository.js";

export const acquisitionDouyinCrawlerEvidenceIndexDdl = `CREATE TABLE IF NOT EXISTS acquisition_douyin_crawler_evidence_index (
  workspace_id VARCHAR(255) NOT NULL,
  content_hash CHAR(71) NOT NULL,
  platform_record_id VARCHAR(255) NOT NULL,
  evidence_id VARCHAR(255) NOT NULL,
  job_id VARCHAR(255) NOT NULL,
  source_url VARCHAR(2000) NOT NULL,
  observed_at DATETIME(3) NOT NULL,
  candidate_id VARCHAR(120) NULL,
  retain_until DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,content_hash),
  UNIQUE KEY acquisition_douyin_crawler_evidence_id (workspace_id,evidence_id),
  KEY acquisition_douyin_crawler_record_version (workspace_id,platform_record_id,observed_at,evidence_id),
  KEY acquisition_douyin_crawler_evidence_retention (candidate_id,retain_until),
  CONSTRAINT acquisition_douyin_crawler_evidence_authority FOREIGN KEY (evidence_id) REFERENCES acquisition_discovery_evidence(id) ON DELETE CASCADE,
  CONSTRAINT acquisition_douyin_crawler_evidence_job FOREIGN KEY (job_id) REFERENCES acquisition_crawler_jobs(id)
) ENGINE=InnoDB`;

export const acquisitionDouyinDoNotContactDdl = `CREATE TABLE IF NOT EXISTS acquisition_douyin_do_not_contact (
  workspace_id VARCHAR(255) NOT NULL,
  identity_hash CHAR(75) NOT NULL,
  reason VARCHAR(100) NOT NULL,
  first_observed_at DATETIME(3) NOT NULL,
  last_observed_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,identity_hash),
  CONSTRAINT acquisition_douyin_dnc_hash CHECK (identity_hash REGEXP '^dnc:sha256:[0-9a-f]{64}$')
) ENGINE=InnoDB`;

export async function ensureAcquisitionDouyinCrawlerIngestionMysqlSchema(
  pool: Pick<mysql.Pool, "query">
) {
  await pool.query(acquisitionDouyinCrawlerEvidenceIndexDdl);
  await pool.query(acquisitionDouyinDoNotContactDdl);
}

interface EvidenceIndex {
  workspaceId: string;
  contentHash: string;
  platformRecordId: string;
  evidenceId: string;
  jobId: string;
  sourceUrl: string;
  observedAt: string;
  candidateId: string | null;
  retainUntil: string;
  createdAt: string;
}

interface IngestionScope {
  workspaceId: string;
  ownerId: string;
  teamId: string;
  actorId: string;
  now?: string;
}

export interface AcquisitionDouyinEvidenceRetentionRepository {
  cleanupAllExpiredUnlinked(now: string, limit?: number): Promise<number>;
}

interface Context {
  scope: IngestionScope;
  plan: AcquisitionPlanRunRepositoryTransaction;
}

function clone<T>(value: T): T { return structuredClone(value); }
function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function iso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}
function candidateView(candidate: AcquisitionCandidate): DouyinCrawlerCandidate {
  if (candidate.profile.kind !== "individual") {
    throw new Error("douyin_candidate_identity_corrupt");
  }
  return {
    id: candidate.id,
    workspaceId: "",
    subjectStableKey: "",
    publicActorKey: candidate.profile.publicActorKey,
    displayName: candidate.profile.publicDisplayName,
    publicProfileUrl: candidate.profile.publicProfileUrl,
    buyingStage: candidate.profile.buyingStage,
    evidenceIds: [...candidate.evidenceIds],
    status: candidate.status === "do_not_contact"
      ? "do_not_contact" : "needs_research"
  };
}

abstract class AuthoritativeDouyinCrawlerIngestionRepository
implements DouyinCrawlerEvidenceStore {
  protected readonly context = new AsyncLocalStorage<Context>();

  constructor(protected readonly domain: AcquisitionDomainRepository) {}

  protected active() {
    const value = this.context.getStore();
    if (!value) throw new Error("douyin_ingestion_transaction_required");
    return value;
  }

  abstract transaction<T>(
    scope: IngestionScope,
    work: () => Promise<T>
  ): Promise<T>;
  protected abstract findIndexByContent(
    workspaceId: string,
    contentHash: string
  ): Promise<EvidenceIndex | null>;
  protected abstract findLatestIndexByRecord(
    workspaceId: string,
    platformRecordId: string
  ): Promise<EvidenceIndex | null>;
  protected abstract appendIndex(value: EvidenceIndex): Promise<void>;
  protected abstract updateIndexCandidate(
    workspaceId: string,
    evidenceId: string,
    candidateId: string
  ): Promise<void>;
  protected abstract findDnc(
    workspaceId: string,
    identityHash: string
  ): Promise<boolean>;
  protected abstract upsertDnc(
    workspaceId: string,
    identityHash: string,
    reason: string,
    now: string
  ): Promise<void>;
  protected abstract findExpiredUnlinkedIndexes(
    workspaceId: string,
    now: string,
    limit: number
  ): Promise<EvidenceIndex[]>;
  protected abstract deleteIndex(
    workspaceId: string,
    evidenceId: string
  ): Promise<void>;

  cleanupExpiredUnlinked(
    scope: IngestionScope,
    now: string,
    limit = 100
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000
      || !Number.isFinite(Date.parse(now))) {
      throw new TypeError("invalid_douyin_evidence_cleanup");
    }
    return this.transaction(scope, async () => {
      const indexes = await this.findExpiredUnlinkedIndexes(
        scope.workspaceId,
        now,
        limit
      );
      let deleted = 0;
      for (const index of indexes) {
        const removed = await this.domain.deleteEvidenceIfUnlinked(
          scope,
          index.evidenceId
        );
        if (!removed) continue;
        await this.deleteIndex(scope.workspaceId, index.evidenceId);
        deleted += 1;
      }
      return deleted;
    });
  }

  async findEvidenceByContentHash(workspaceId: string, contentHash: string) {
    const index = await this.findIndexByContent(workspaceId, contentHash);
    if (!index) return null;
    const evidence = await this.domain.findEvidence(this.active().scope, index.evidenceId);
    if (!evidence) throw new Error("douyin_evidence_index_corrupt");
    return this.evidenceView(evidence, index);
  }

  async findLatestEvidenceByRecord(
    workspaceId: string,
    _jobId: string,
    recordId: string
  ) {
    const index = await this.findLatestIndexByRecord(workspaceId, recordId);
    if (!index) return null;
    const evidence = await this.domain.findEvidence(this.active().scope, index.evidenceId);
    if (!evidence) throw new Error("douyin_evidence_index_corrupt");
    return this.evidenceView(evidence, index);
  }

  private evidenceView(
    evidence: DiscoveryEvidence,
    index: EvidenceIndex
  ): DouyinCrawlerEvidence {
    if (evidence.provenance.kind !== "mediacrawler_public_record") {
      throw new Error("douyin_evidence_provenance_corrupt");
    }
    return {
      id: evidence.id,
      workspaceId: index.workspaceId,
      contentHash: evidence.contentHash,
      platformRecordId: index.platformRecordId,
      sourceUrl: evidence.provenance.sourceUrl,
      sourceKeyword: evidence.sourceTitle,
      observedAt: evidence.publishedAt ?? evidence.fetchedAt,
      sourceSnippet: evidence.sourceSnippet,
      supersedesEvidenceId: evidence.supersedesEvidenceId,
      provenance: {
        kind: "mediacrawler_public_record",
        jobId: evidence.provenance.jobId,
        recordId: evidence.provenance.recordId,
        actorKind: evidence.provenance.actorKind,
        cursor: evidence.provenance.cursor,
        upstreamCommit: evidence.provenance.upstreamCommit
      }
    };
  }

  async appendEvidence(value: DouyinCrawlerEvidence) {
    const { scope } = this.active();
    if (scope.workspaceId !== value.workspaceId) {
      throw new Error("douyin_evidence_workspace_mismatch");
    }
    const fetchedAt = scope.now ?? new Date().toISOString();
    const evidence: DiscoveryEvidence = {
      id: value.id,
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      targetType: "individual_signal",
      sourcePlatform: "douyin",
      sourceTitle: value.sourceKeyword.slice(0, 500),
      sourceSnippet: value.sourceSnippet,
      publishedAt: value.observedAt,
      locale: "zh-CN",
      rawArtifactHash: value.contentHash,
      contentHash: value.contentHash,
      provenance: {
        ...value.provenance,
        sourceUrl: value.sourceUrl
      },
      accessStatus: "public_content",
      supersedesEvidenceId: value.supersedesEvidenceId,
      fetchedAt
    };
    await this.domain.appendEvidence(evidence);
    await this.appendIndex({
      workspaceId: value.workspaceId,
      contentHash: value.contentHash,
      platformRecordId: value.platformRecordId,
      evidenceId: value.id,
      jobId: value.provenance.jobId,
      sourceUrl: value.sourceUrl,
      observedAt: value.observedAt,
      candidateId: null,
      retainUntil: new Date(Date.parse(fetchedAt) + 90 * 86_400_000).toISOString(),
      createdAt: fetchedAt
    });
    return clone(value);
  }

  async findCandidateBySubjectKey(workspaceId: string, subjectStableKey: string) {
    const { scope } = this.active();
    if (workspaceId !== scope.workspaceId) return null;
    const alias = await this.domain.findCandidateIdentityAlias(scope, subjectStableKey);
    if (!alias) return null;
    const candidate = await this.domain.findCandidate(scope, alias.candidateId);
    if (!candidate) throw new Error("douyin_candidate_alias_corrupt");
    return { ...candidateView(candidate), workspaceId, subjectStableKey };
  }

  async saveCandidate(value: DouyinCrawlerCandidate) {
    const { scope } = this.active();
    if (scope.workspaceId !== value.workspaceId) {
      throw new Error("douyin_candidate_workspace_mismatch");
    }
    const current = await this.domain.findCandidate(scope, value.id);
    if (!current) {
      const now = scope.now ?? new Date().toISOString();
      const record: AcquisitionCandidate = {
        id: value.id,
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        partyType: "individual",
        partyRef: {
          partyType: "individual",
          individualPartyId: `douyin-${hash(value.publicActorKey).slice(0, 48)}`,
          demandSignalId: `douyin-signal-${hash(value.evidenceIds[0] ?? value.id).slice(0, 48)}`
        },
        profile: {
          kind: "individual",
          publicActorKey: value.publicActorKey,
          publicDisplayName: value.displayName,
          publicProfileUrl: value.publicProfileUrl,
          sourcePlatform: "douyin",
          demandCategory: "public_business_demand",
          demandSummary: "公开需求信号",
          locationHint: "",
          buyingStage: value.buyingStage,
          negativeSignals: []
        },
        evidenceIds: [...value.evidenceIds],
        status: value.status,
        latestDecisionId: null,
        latestDecisionVersion: null,
        approvedDecisionVersion: null,
        hardGateFailures: value.status === "do_not_contact"
          ? ["do_not_contact"] : [],
        leadId: null,
        createdAt: now,
        updatedAt: now,
        version: 1
      };
      await this.domain.insertCandidate(record);
      const alias: AcquisitionCandidateIdentityAlias = {
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        candidateId: record.id,
        partyType: "individual",
        basis: "provider_public_actor",
        dedupeKey: value.subjectStableKey,
        createdAt: now
      };
      await this.domain.bindCandidateIdentityAliases([alias]);
    } else {
      if (current.profile.kind !== "individual") {
        throw new Error("douyin_candidate_identity_conflict");
      }
      await this.domain.saveCandidate({
        ...current,
        profile: {
          ...current.profile,
          buyingStage: value.buyingStage
        },
        evidenceIds: [...value.evidenceIds],
        status: current.status === "do_not_contact"
          ? "do_not_contact" : value.status,
        hardGateFailures: current.status === "do_not_contact"
          || value.status === "do_not_contact"
          ? [...new Set([...current.hardGateFailures, "do_not_contact" as const])]
          : current.hardGateFailures,
        updatedAt: scope.now ?? new Date().toISOString(),
        version: current.version + 1
      });
    }
    for (const evidenceId of value.evidenceIds) {
      await this.updateIndexCandidate(scope.workspaceId, evidenceId, value.id);
    }
    return clone(value);
  }

  hasDoNotContact(workspaceId: string, identityHash: string) {
    return this.findDnc(workspaceId, identityHash);
  }

  retainDoNotContact(workspaceId: string, identityHash: string, reason = "policy") {
    const { scope } = this.active();
    const now = scope.now ?? new Date().toISOString();
    return this.upsertDnc(workspaceId, identityHash, reason, now)
      .then(async () => {
        const event = {
          id: `audit-dnc-${hash(`${workspaceId}\u0000${identityHash}\u0000${reason}`).slice(0, 48)}`,
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          candidateId: null,
          eventType: "douyin_do_not_contact_retained",
          fromStatus: null,
          toStatus: "do_not_contact" as const,
          actorId: scope.actorId,
          resourceId: identityHash,
          idempotencyKey: identityHash,
          payloadHash: hash(reason),
          payload: { identityHash, reason },
          createdAt: now
        };
        const prior = await this.domain.findAuditEvent(scope, event.id);
        if (!prior) {
          await this.domain.appendAuditEvent(event);
        }
      });
  }

  persistRunLinks(input: {
    job: {
      id: string;
      workspaceId: string;
      runIds: string[];
      planId: string;
      planVersionId: string;
      planSnapshotHash: string;
      state: string;
    };
    candidateIds: string[];
    evidenceCount: number;
    at: string;
  }) {
    const { scope, plan } = this.active();
    if (input.job.workspaceId !== scope.workspaceId) {
      throw new Error("douyin_ingestion_workspace_mismatch");
    }
    for (const runId of input.job.runIds) {
      const run = plan.getRun(runId);
      if (!run || run.ownerId !== scope.ownerId || run.teamId !== scope.teamId
        || run.planId !== input.job.planId
        || run.planVersionId !== input.job.planVersionId
        || run.planSnapshotHash !== input.job.planSnapshotHash) {
        throw new Error("douyin_ingestion_run_binding_mismatch");
      }
      const existing = plan.listRunEvents(runId);
      const linked = new Set(existing.filter((event) =>
        event.type === "candidate.discovered"
        && typeof event.data.candidateId === "string"
      ).map((event) => String(event.data.candidateId)));
      const candidateIds = [...new Set(input.candidateIds)].sort();
      const status = input.job.state === "partial"
        ? "partial_success" as const
        : input.evidenceCount > 0 ? "succeeded" as const : "succeeded_empty" as const;
      const hasCompletion = existing.some((event) => event.type === `run.${status}`);
      if (run.status === status
        && run.evidenceCount >= input.evidenceCount
        && candidateIds.every((candidateId) => linked.has(candidateId))
        && hasCompletion) {
        continue;
      }
      const updated: AcquisitionRun = {
        ...run,
        status,
        revision: run.revision + 1,
        etag: `"${run.id}:${run.revision + 1}"`,
        evidenceCount: Math.max(run.evidenceCount, input.evidenceCount),
        updatedBy: scope.actorId,
        updatedAt: input.at,
        completedAt: input.at
      };
      plan.putRun(updated);
      for (const candidateId of candidateIds) {
        if (linked.has(candidateId)) continue;
        plan.appendRunEvent({
          id: `are-douyin-candidate-${hash(`${run.id}\u0000${candidateId}`).slice(0, 48)}`,
          runId: run.id,
          shardId: null,
          ownerId: run.ownerId,
          teamId: run.teamId,
          type: "candidate.discovered",
          actorId: scope.actorId,
          revision: updated.revision,
          at: input.at,
          data: { candidateId, source: "douyin_crawler", jobId: input.job.id }
        });
      }
      if (!hasCompletion) {
        plan.appendRunEvent({
          id: `are-douyin-complete-${hash(run.id).slice(0, 48)}`,
          runId: run.id,
          shardId: null,
          ownerId: run.ownerId,
          teamId: run.teamId,
          type: `run.${status}`,
          actorId: scope.actorId,
          revision: updated.revision,
          at: input.at,
          data: { previousStatus: run.status, jobId: input.job.id }
        });
      }
    }
  }
}

export class InMemoryAcquisitionDouyinCrawlerIngestionRepository
extends AuthoritativeDouyinCrawlerIngestionRepository {
  private indexes = new Map<string, EvidenceIndex>();
  private dnc = new Map<string, { reason: string; first: string; last: string }>();
  private knownScopes = new Map<string, IngestionScope>();

  constructor(
    domain: InMemoryAcquisitionDomainRepository,
    private readonly planRuns: InMemoryAcquisitionPlanRunRepository
  ) { super(domain); }

  transaction<T>(scope: IngestionScope, work: () => Promise<T>) {
    this.knownScopes.set(scope.workspaceId, clone(scope));
    const beforeIndexes = clone(this.indexes);
    const beforeDnc = clone(this.dnc);
    return (this.domain as InMemoryAcquisitionDomainRepository).transaction(() =>
      this.planRuns.transaction((plan) => this.context.run({ scope, plan }, work))
    ).catch((error) => {
      this.indexes = beforeIndexes;
      this.dnc = beforeDnc;
      throw error;
    });
  }
  async cleanupAllExpiredUnlinked(now: string, limit = 100) {
    let deleted = 0;
    for (const scope of this.knownScopes.values()) {
      if (deleted >= limit) break;
      deleted += await this.cleanupExpiredUnlinked(scope, now, limit - deleted);
    }
    return deleted;
  }
  async lockOutreachDraftAuthority(
    scope: Pick<IngestionScope, "workspaceId" | "ownerId" | "teamId">,
    _candidateId: string,
    _evidenceIds: readonly string[],
    _identityHash: string
  ) {
    const active = this.active().scope;
    if (active.workspaceId !== scope.workspaceId
      || active.ownerId !== scope.ownerId
      || active.teamId !== scope.teamId) {
      throw new Error("outreach_authority_scope_mismatch");
    }
  }
  private key(workspaceId: string, value: string) { return `${workspaceId}\u0000${value}`; }
  protected async findIndexByContent(workspaceId: string, contentHash: string) {
    return clone(this.indexes.get(this.key(workspaceId, contentHash)) ?? null);
  }
  protected async findLatestIndexByRecord(workspaceId: string, recordId: string) {
    return clone([...this.indexes.values()].filter((value) =>
      value.workspaceId === workspaceId && value.platformRecordId === recordId
    ).sort((left, right) => right.observedAt.localeCompare(left.observedAt)
      || right.evidenceId.localeCompare(left.evidenceId))[0] ?? null);
  }
  protected async appendIndex(value: EvidenceIndex) {
    const key = this.key(value.workspaceId, value.contentHash);
    if (this.indexes.has(key)) throw new Error("douyin_evidence_content_conflict");
    this.indexes.set(key, clone(value));
  }
  protected async updateIndexCandidate(workspaceId: string, evidenceId: string, candidateId: string) {
    const index = [...this.indexes.values()].find((value) =>
      value.workspaceId === workspaceId && value.evidenceId === evidenceId);
    if (index) index.candidateId = candidateId;
  }
  protected async findDnc(workspaceId: string, identityHash: string) {
    return this.dnc.has(this.key(workspaceId, identityHash));
  }
  protected async upsertDnc(workspaceId: string, identityHash: string, reason: string, now: string) {
    const key = this.key(workspaceId, identityHash);
    const existing = this.dnc.get(key);
    this.dnc.set(key, existing
      ? { ...existing, reason, last: now }
      : { reason, first: now, last: now });
  }
  protected async findExpiredUnlinkedIndexes(
    workspaceId: string,
    now: string,
    limit: number
  ) {
    return [...this.indexes.values()]
      .filter((value) => value.workspaceId === workspaceId
        && value.candidateId === null && value.retainUntil <= now)
      .sort((left, right) => left.retainUntil.localeCompare(right.retainUntil)
        || left.evidenceId.localeCompare(right.evidenceId))
      .slice(0, limit)
      .map(clone);
  }
  protected async deleteIndex(workspaceId: string, evidenceId: string) {
    for (const [key, value] of this.indexes) {
      if (value.workspaceId === workspaceId && value.evidenceId === evidenceId) {
        this.indexes.delete(key);
      }
    }
  }
}

export class MysqlAcquisitionDouyinCrawlerIngestionRepository
extends AuthoritativeDouyinCrawlerIngestionRepository {
  private readonly mysqlContext = new AsyncLocalStorage<mysql.PoolConnection>();
  constructor(
    private readonly pool: mysql.Pool,
    domain: MysqlAcquisitionDomainRepository,
    private readonly planRuns: MysqlAcquisitionPlanRunRepository
  ) { super(domain); }

  private source() { return this.mysqlContext.getStore() ?? this.pool; }
  async transaction<T>(scope: IngestionScope, work: () => Promise<T>) {
    const active = this.mysqlContext.getStore();
    if (active) return work();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await this.mysqlContext.run(connection, () =>
        (this.domain as MysqlAcquisitionDomainRepository)
          .withTransactionConnection(connection, () =>
            this.planRuns.withTransactionConnection(connection, () =>
              this.planRuns.transaction((plan) =>
                this.context.run({ scope, plan }, work))
            )
          )
      );
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }
  async cleanupAllExpiredUnlinked(now: string, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000
      || !Number.isFinite(Date.parse(now))) {
      throw new TypeError("invalid_douyin_evidence_cleanup");
    }
    const [rows] = await this.pool.query(
      `SELECT DISTINCT i.workspace_id,e.owner_id,e.team_id
       FROM acquisition_douyin_crawler_evidence_index i
       INNER JOIN acquisition_discovery_evidence e ON e.id=i.evidence_id
       WHERE i.candidate_id IS NULL AND i.retain_until<=?
       ORDER BY i.workspace_id LIMIT ?`,
      [now, limit]
    );
    let deleted = 0;
    for (const row of rows as Record<string, unknown>[]) {
      if (deleted >= limit) break;
      deleted += await this.cleanupExpiredUnlinked({
        workspaceId: String(row.workspace_id),
        ownerId: String(row.owner_id),
        teamId: String(row.team_id),
        actorId: "douyin-evidence-retention-sweeper"
      }, now, limit - deleted);
    }
    return deleted;
  }
  async lockOutreachDraftAuthority(
    scope: Pick<IngestionScope, "workspaceId" | "ownerId" | "teamId">,
    candidateId: string,
    evidenceIds: readonly string[],
    identityHash: string
  ) {
    const active = this.active().scope;
    if (active.workspaceId !== scope.workspaceId
      || active.ownerId !== scope.ownerId
      || active.teamId !== scope.teamId) {
      throw new Error("outreach_authority_scope_mismatch");
    }
    await this.source().query(
      `SELECT id FROM acquisition_candidates
       WHERE id=? AND owner_id=? AND team_id=? FOR UPDATE`,
      [candidateId, scope.ownerId, scope.teamId]
    );
    for (const evidenceId of [...evidenceIds].sort()) {
      await this.source().query(
        `SELECT id FROM acquisition_discovery_evidence
         WHERE id=? AND owner_id=? AND team_id=? FOR UPDATE`,
        [evidenceId, scope.ownerId, scope.teamId]
      );
    }
    await this.source().query(
      `SELECT identity_hash FROM acquisition_douyin_do_not_contact
       WHERE workspace_id=? AND identity_hash=? FOR UPDATE`,
      [scope.workspaceId, identityHash]
    );
  }
  protected async findIndexByContent(workspaceId: string, contentHash: string) {
    const [rows] = await this.source().query(
      `SELECT * FROM acquisition_douyin_crawler_evidence_index
       WHERE workspace_id=? AND content_hash=? LIMIT 1`,
      [workspaceId, contentHash]
    );
    return this.index((rows as Record<string, unknown>[])[0]);
  }
  protected async findLatestIndexByRecord(workspaceId: string, recordId: string) {
    const [rows] = await this.source().query(
      `SELECT * FROM acquisition_douyin_crawler_evidence_index
       WHERE workspace_id=? AND platform_record_id=?
       ORDER BY observed_at DESC,evidence_id DESC LIMIT 1`,
      [workspaceId, recordId]
    );
    return this.index((rows as Record<string, unknown>[])[0]);
  }
  private index(row: Record<string, unknown> | undefined): EvidenceIndex | null {
    return row ? {
      workspaceId: String(row.workspace_id), contentHash: String(row.content_hash),
      platformRecordId: String(row.platform_record_id), evidenceId: String(row.evidence_id),
      jobId: String(row.job_id), sourceUrl: String(row.source_url),
      observedAt: iso(row.observed_at), candidateId: row.candidate_id ? String(row.candidate_id) : null,
      retainUntil: iso(row.retain_until), createdAt: iso(row.created_at)
    } : null;
  }
  protected async appendIndex(value: EvidenceIndex) {
    await this.source().query(
      `INSERT INTO acquisition_douyin_crawler_evidence_index
       (workspace_id,content_hash,platform_record_id,evidence_id,job_id,
        source_url,observed_at,candidate_id,retain_until,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [value.workspaceId, value.contentHash, value.platformRecordId,
        value.evidenceId, value.jobId, value.sourceUrl, value.observedAt,
        value.candidateId, value.retainUntil, value.createdAt]
    );
  }
  protected async updateIndexCandidate(workspaceId: string, evidenceId: string, candidateId: string) {
    await this.source().query(
      `UPDATE acquisition_douyin_crawler_evidence_index SET candidate_id=?
       WHERE workspace_id=? AND evidence_id=?`,
      [candidateId, workspaceId, evidenceId]
    );
  }
  protected async findDnc(workspaceId: string, identityHash: string) {
    const [rows] = await this.source().query(
      `SELECT identity_hash FROM acquisition_douyin_do_not_contact
       WHERE workspace_id=? AND identity_hash=? LIMIT 1`,
      [workspaceId, identityHash]
    );
    return (rows as unknown[]).length > 0;
  }
  protected async upsertDnc(workspaceId: string, identityHash: string, reason: string, now: string) {
    await this.source().query(
      `INSERT INTO acquisition_douyin_do_not_contact
       (workspace_id,identity_hash,reason,first_observed_at,last_observed_at)
       VALUES (?,?,?,?,?) AS incoming
       ON DUPLICATE KEY UPDATE reason=incoming.reason,
         last_observed_at=incoming.last_observed_at`,
      [workspaceId, identityHash, reason, now, now]
    );
  }
  protected async findExpiredUnlinkedIndexes(
    workspaceId: string,
    now: string,
    limit: number
  ) {
    const [rows] = await this.source().query(
      `SELECT * FROM acquisition_douyin_crawler_evidence_index
       WHERE workspace_id=? AND candidate_id IS NULL AND retain_until<=?
       ORDER BY retain_until,evidence_id LIMIT ? FOR UPDATE SKIP LOCKED`,
      [workspaceId, now, limit]
    );
    return (rows as Record<string, unknown>[])
      .map((row) => this.index(row))
      .filter((value): value is EvidenceIndex => Boolean(value));
  }
  protected async deleteIndex(workspaceId: string, evidenceId: string) {
    await this.source().query(
      `DELETE FROM acquisition_douyin_crawler_evidence_index
       WHERE workspace_id=? AND evidence_id=?`,
      [workspaceId, evidenceId]
    );
  }
}
