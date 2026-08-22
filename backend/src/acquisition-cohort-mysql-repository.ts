import type mysql from "mysql2/promise";
import type { OutcomeAttributionInput } from "./acquisition-domain.js";
import type {
  AcquisitionCohort,
  AcquisitionCohortCatchUpOperation,
  AcquisitionCohortMember,
  AcquisitionCohortMemberSource,
  AcquisitionCohortMembershipVersion,
  AcquisitionCohortRepository,
  AuthoritativeDiscoveryEvent,
  CohortCatchUpResult,
  FirstTouchOutcome
} from "./acquisition-cohort-repository.js";
import {
  compareDiscoveryOrder,
  discoveryOrder
} from "./acquisition-cohort-repository.js";
import type { CanonicalSubjectResolution } from "./acquisition-canonical-subject.js";
import type { GrowthTemporalBarrier } from "./growth-temporal-barrier.js";
import {
  MysqlGrowthTemporalTransaction
} from "./growth-temporal-barrier-mysql-repository.js";

type MysqlRow = Record<string, unknown>;

export const ACQUISITION_COHORT_MYSQL_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS acquisition_cohort_platform_guards (
    workspace_id VARCHAR(191) NOT NULL,
    platform VARCHAR(64) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, platform)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_cohorts (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    platform VARCHAR(64) NOT NULL,
    cohort_from DATETIME(3) NOT NULL,
    cohort_to DATETIME(3) NOT NULL,
    definition_version VARCHAR(64) NOT NULL,
    first_touch_rule_version VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    domain_command_hash CHAR(71) NOT NULL,
    request_hash VARCHAR(255) NOT NULL,
    requested_by VARCHAR(191) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_cohort_window
      (workspace_id, platform, cohort_from, cohort_to),
    KEY ix_cohort_workspace (workspace_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_cohort_catch_up_operations (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    cohort_id VARCHAR(191) NOT NULL,
    cutoff_effective_as_of DATETIME(3) NOT NULL,
    initial_cutoff_temporal_sequence BIGINT UNSIGNED NOT NULL,
    requested_by VARCHAR(191) NOT NULL,
    authority_kind VARCHAR(32) NOT NULL,
    parent_closure_operation_id VARCHAR(191) NULL,
    request_identity_hash CHAR(71) NOT NULL,
    status VARCHAR(16) NOT NULL,
    checkpoint_source_recorded_at DATETIME(3) NULL,
    checkpoint_event_id VARCHAR(128) NULL,
    lease_owner VARCHAR(191) NULL,
    lease_expires_at DATETIME(3) NULL,
    fencing_token BIGINT UNSIGNED NOT NULL,
    error_code VARCHAR(64) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_cohort_catchup_request
      (workspace_id, authority_kind, request_identity_hash),
    KEY ix_cohort_catchup_boundary
      (workspace_id, cohort_id, cutoff_effective_as_of),
    KEY ix_cohort_catchup_parent_closure
      (workspace_id, parent_closure_operation_id),
    KEY ix_cohort_catchup_recovery (status, lease_expires_at, updated_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_canonical_subjects (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    platform VARCHAR(64) NOT NULL,
    subject_stable_key VARCHAR(255) NOT NULL,
    canonical_profile_url TEXT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_canonical_subject
      (workspace_id, platform, subject_stable_key)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_canonical_subject_aliases (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    subject_id VARCHAR(191) NOT NULL,
    alias_stable_key VARCHAR(255) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_subject_alias (workspace_id, alias_stable_key)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_cohort_members (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    platform VARCHAR(64) NOT NULL,
    subject_stable_key VARCHAR(255) NOT NULL,
    canonical_subject_id VARCHAR(191) NOT NULL,
    cohort_id VARCHAR(191) NOT NULL,
    UNIQUE KEY uk_first_touch_membership
      (workspace_id, platform, subject_stable_key)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_cohort_membership_heads (
    workspace_id VARCHAR(191) NOT NULL,
    platform VARCHAR(64) NOT NULL,
    subject_stable_key VARCHAR(255) NOT NULL,
    cohort_member_id VARCHAR(191) NOT NULL,
    head_version_id VARCHAR(191) NOT NULL,
    append_revision BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id, platform, subject_stable_key)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_cohort_membership_versions (
    id VARCHAR(191) NOT NULL,
    cohort_member_id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    platform VARCHAR(64) NOT NULL,
    subject_stable_key VARCHAR(255) NOT NULL,
    cohort_id VARCHAR(191) NOT NULL,
    append_revision BIGINT UNSIGNED NOT NULL,
    event_id VARCHAR(128) NOT NULL,
    candidate_id VARCHAR(128) NOT NULL,
    plan_id VARCHAR(191) NOT NULL,
    run_id VARCHAR(191) NOT NULL,
    discovered_at DATETIME(3) NOT NULL,
    source_recorded_at DATETIME(3) NOT NULL,
    source_temporal_sequence BIGINT UNSIGNED NOT NULL,
    attribution_snapshot JSON NOT NULL,
    became_head TINYINT(1) NOT NULL,
    previous_head_version_id VARCHAR(191) NULL,
    projection_recorded_at DATETIME(3) NOT NULL,
    projection_temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_membership_version_revision
      (cohort_member_id, append_revision),
    UNIQUE KEY uk_membership_version_event
      (cohort_member_id, event_id),
    KEY ix_membership_version_subject
      (workspace_id, subject_stable_key, source_recorded_at, discovered_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_cohort_member_sources (
    cohort_member_id VARCHAR(191) NOT NULL,
    event_id VARCHAR(128) NOT NULL,
    candidate_id VARCHAR(128) NOT NULL,
    evidence_id VARCHAR(191) NULL,
    owner_id VARCHAR(191) NOT NULL,
    discovered_at DATETIME(3) NOT NULL,
    source_recorded_at DATETIME(3) NOT NULL,
    source_temporal_sequence BIGINT UNSIGNED NOT NULL,
    projection_recorded_at DATETIME(3) NOT NULL,
    projection_temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (cohort_member_id, event_id)
  ) ENGINE=InnoDB`
] as const);

export async function ensureAcquisitionCohortMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  for (const statement of ACQUISITION_COHORT_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function cohort(row: MysqlRow): AcquisitionCohort {
  return Object.freeze({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    platform: String(row.platform),
    cohortFrom: String(row.cohort_from),
    cohortTo: String(row.cohort_to),
    definitionVersion: String(row.definition_version),
    firstTouchRuleVersion: String(row.first_touch_rule_version),
    status: String(row.status) as AcquisitionCohort["status"],
    createdAt: String(row.created_at),
    temporalSequence: Number(row.temporal_sequence),
    domainCommandHash: String(row.domain_command_hash) as `sha256:${string}`,
    requestHash: String(row.request_hash),
    requestedBy: String(row.requested_by)
  });
}

export class MysqlAcquisitionCohortRepository
implements AcquisitionCohortRepository {
  constructor(
    private readonly pool: mysql.Pool,
    private readonly barrier: GrowthTemporalBarrier
  ) {}

  async requireActive(workspaceId: string, cohortId: string) {
    const [rows] = await this.pool.query(
      `SELECT * FROM acquisition_cohorts
       WHERE id = ? AND workspace_id = ? AND status = 'active'`,
      [cohortId, workspaceId]
    );
    const row = (rows as MysqlRow[])[0];
    if (!row) throw new Error("cohort_not_found");
    return cohort(row);
  }

  async getCohort(workspaceId: string, cohortId: string) {
    const [rows] = await this.pool.query(
      `SELECT * FROM acquisition_cohorts
       WHERE id = ? AND workspace_id = ?`,
      [cohortId, workspaceId]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? cohort(row) : null;
  }

  async listCohorts(workspaceId: string) {
    const [rows] = await this.pool.query(
      `SELECT * FROM acquisition_cohorts WHERE workspace_id = ?`,
      [workspaceId]
    );
    return (rows as MysqlRow[]).map(cohort);
  }

  async createCohort(input: {
    id: string;
    workspaceId: string;
    platform: string;
    cohortFrom: string;
    cohortTo: string;
    definitionVersion: string;
    firstTouchRuleVersion: string;
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
    requestedBy: string;
    now: string;
  }) {
    const existing = await this.findCohortByDomainHash(
      input.workspaceId, input.domainCommandHash
    );
    if (existing) return existing;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        `INSERT INTO acquisition_cohort_platform_guards
           (workspace_id, platform) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE workspace_id = VALUES(workspace_id)`,
        [input.workspaceId, input.platform]
      );
      await connection.query(
        `SELECT revision FROM acquisition_cohort_platform_guards
         WHERE workspace_id = ? AND platform = ? FOR UPDATE`,
        [input.workspaceId, input.platform]
      );
      const temporal = new MysqlGrowthTemporalTransaction(connection);
      const stamp = await this.barrier.allocateAppend(
        temporal, input.workspaceId
      );
      await connection.query(
        `INSERT INTO acquisition_cohorts (
          id, workspace_id, platform, cohort_from, cohort_to,
          definition_version, first_touch_rule_version, status,
          created_at, temporal_sequence, domain_command_hash,
          request_hash, requested_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
        [input.id, input.workspaceId, input.platform, input.cohortFrom,
          input.cohortTo, input.definitionVersion,
          input.firstTouchRuleVersion, stamp.recordedAt,
          stamp.temporalSequence, input.domainCommandHash,
          input.requestHash, input.requestedBy]
      );
      await connection.commit();
      return (await this.requireActive(input.workspaceId, input.id))!;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async findCohortByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ) {
    const [rows] = await this.pool.query(
      `SELECT * FROM acquisition_cohorts
       WHERE workspace_id = ? AND domain_command_hash = ?`,
      [workspaceId, domainCommandHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? cohort(row) : null;
  }

  async upsertFirstTouch(input: {
    cohort: AcquisitionCohort;
    event: AuthoritativeDiscoveryEvent;
    resolution: CanonicalSubjectResolution;
    now: string;
  }): Promise<FirstTouchOutcome> {
    if (input.resolution.status !== "resolved"
      || input.resolution.subjectStableKey === null) {
      throw new Error("canonical_subject_unassignable");
    }
    const order = discoveryOrder(input.event);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const temporal = new MysqlGrowthTemporalTransaction(connection);
      const stamp = await this.barrier.allocateAppend(
        temporal, input.cohort.workspaceId
      );
      await connection.query(
        `INSERT INTO acquisition_canonical_subjects (
          id, workspace_id, platform, subject_stable_key,
          canonical_profile_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE workspace_id = VALUES(workspace_id)`,
        [`subject-${input.resolution.subjectStableKey}`,
          input.cohort.workspaceId, input.cohort.platform,
          input.resolution.subjectStableKey,
          input.resolution.canonicalProfileUrl, stamp.recordedAt]
      );
      await connection.query(
        `INSERT INTO acquisition_cohort_membership_heads (
          workspace_id, platform, subject_stable_key, cohort_member_id,
          head_version_id, append_revision
        ) VALUES (?, ?, ?, '', '', 0)
        ON DUPLICATE KEY UPDATE workspace_id = VALUES(workspace_id)`,
        [input.cohort.workspaceId, input.cohort.platform,
          input.resolution.subjectStableKey]
      );
      const [headRows] = await connection.query(
        `SELECT * FROM acquisition_cohort_membership_heads
         WHERE workspace_id = ? AND platform = ?
           AND subject_stable_key = ? FOR UPDATE`,
        [input.cohort.workspaceId, input.cohort.platform,
          input.resolution.subjectStableKey]
      );
      const head = (headRows as MysqlRow[])[0];
      const headVersionId = head?.head_version_id
        ? String(head.head_version_id) : null;
      let becameHead = headVersionId === null || headVersionId === "";
      let previousOrder: string | null = null;
      let appendRevision = 0;
      let previousHeadVersionId: string | null = null;
      if (!becameHead) {
        const [versionRows] = await connection.query(
          `SELECT * FROM acquisition_cohort_membership_versions
           WHERE id = ?`,
          [headVersionId]
        );
        const previous = (versionRows as MysqlRow[])[0];
        if (previous) {
          previousOrder = discoveryOrder({
            discoveredAt: String(previous.discovered_at),
            sourceRecordedAt: String(previous.source_recorded_at),
            eventId: String(previous.event_id)
          });
          appendRevision = Number(previous.append_revision);
          previousHeadVersionId = headVersionId;
          if (compareDiscoveryOrder(order, previousOrder) >= 0) {
            becameHead = false;
          } else {
            becameHead = true;
          }
        } else {
          becameHead = true;
        }
      }
      if (becameHead) {
        const memberId = `member-${input.resolution.subjectStableKey}`;
        const versionId = `version-${input.event.eventId}`;
        await connection.query(
          `INSERT INTO acquisition_cohort_members (
            id, workspace_id, platform, subject_stable_key,
            canonical_subject_id, cohort_id
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE cohort_id = VALUES(cohort_id)`,
          [memberId, input.cohort.workspaceId, input.cohort.platform,
            input.resolution.subjectStableKey,
            `subject-${input.resolution.subjectStableKey}`,
            input.cohort.id]
        );
        await connection.query(
          `INSERT INTO acquisition_cohort_membership_versions (
            id, cohort_member_id, workspace_id, platform,
            subject_stable_key, cohort_id, append_revision, event_id,
            candidate_id, plan_id, run_id, discovered_at,
            source_recorded_at, source_temporal_sequence,
            attribution_snapshot, became_head,
            previous_head_version_id, projection_recorded_at,
            projection_temporal_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [versionId, memberId, input.cohort.workspaceId,
            input.cohort.platform, input.resolution.subjectStableKey,
            input.cohort.id, (appendRevision) + 1, input.event.eventId,
            input.event.candidateId, input.event.planId, input.event.runId,
            input.event.discoveredAt, input.event.sourceRecordedAt,
            input.event.sourceTemporalSequence,
            JSON.stringify(input.event.attribution),
            becameHead ? 1 : 0, previousHeadVersionId,
            stamp.recordedAt, stamp.temporalSequence]
        );
        await connection.query(
          `INSERT INTO acquisition_cohort_membership_heads (
            workspace_id, platform, subject_stable_key, cohort_member_id,
            head_version_id, append_revision
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE cohort_member_id = VALUES(cohort_member_id),
            head_version_id = VALUES(head_version_id),
            append_revision = VALUES(append_revision)`,
          [input.cohort.workspaceId, input.cohort.platform,
            input.resolution.subjectStableKey, memberId, versionId,
            appendRevision + 1]
        );
        await this.appendSource(connection, memberId, input.event, stamp);
        await connection.commit();
        return appendRevision === 0 ? "inserted" : "reassigned";
      }
      const memberId = `member-${input.resolution.subjectStableKey}`;
      const versionId = `version-${input.event.eventId}`;
      await connection.query(
        `INSERT INTO acquisition_cohort_membership_versions (
          id, cohort_member_id, workspace_id, platform,
          subject_stable_key, cohort_id, append_revision, event_id,
          candidate_id, plan_id, run_id, discovered_at,
          source_recorded_at, source_temporal_sequence,
          attribution_snapshot, became_head,
          previous_head_version_id, projection_recorded_at,
          projection_temporal_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
        [versionId, memberId, input.cohort.workspaceId,
          input.cohort.platform, input.resolution.subjectStableKey,
          input.cohort.id, appendRevision + 1, input.event.eventId,
          input.event.candidateId, input.event.planId, input.event.runId,
          input.event.discoveredAt, input.event.sourceRecordedAt,
          input.event.sourceTemporalSequence,
          JSON.stringify(input.event.attribution),
          stamp.recordedAt, stamp.temporalSequence]
      );
      await this.appendSource(connection, memberId, input.event, stamp);
      await connection.commit();
      return "aliased";
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async appendSource(
    connection: mysql.PoolConnection,
    memberId: string,
    event: AuthoritativeDiscoveryEvent,
    stamp: { recordedAt: string; temporalSequence: number }
  ): Promise<void> {
    await connection.query(
      `INSERT INTO acquisition_cohort_member_sources (
        cohort_member_id, event_id, candidate_id, evidence_id, owner_id,
        discovered_at, source_recorded_at, source_temporal_sequence,
        projection_recorded_at, projection_temporal_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [memberId, event.eventId, event.candidateId, event.evidenceId,
        event.ownerId, event.discoveredAt, event.sourceRecordedAt,
        event.sourceTemporalSequence, stamp.recordedAt,
        stamp.temporalSequence]
    );
  }

  async listMembersAt(
    workspaceId: string,
    cohortId: string,
    cutoff: { effectiveAsOf: string }
  ): Promise<Array<AcquisitionCohortMember & {
    sources: AcquisitionCohortMemberSource[];
  }>> {
    const [rows] = await this.pool.query(
      `SELECT v.* FROM acquisition_cohort_membership_versions v
       JOIN (
         SELECT subject_stable_key,
           MIN(CONCAT_WS('\u0000', discovered_at, source_recorded_at, event_id))
             AS min_order
         FROM acquisition_cohort_membership_versions
         WHERE workspace_id = ? AND source_recorded_at <= ?
         GROUP BY subject_stable_key
       ) best ON best.subject_stable_key = v.subject_stable_key
         AND CONCAT_WS('\u0000', v.discovered_at, v.source_recorded_at,
           v.event_id) = best.min_order
       WHERE v.workspace_id = ? AND v.cohort_id = ?`,
      [workspaceId, cutoff.effectiveAsOf, workspaceId, cohortId]
    );
    return Promise.all((rows as MysqlRow[]).map(async (row) => {
      const [sourceRows] = await this.pool.query(
        `SELECT * FROM acquisition_cohort_member_sources
         WHERE cohort_member_id = ? AND source_recorded_at <= ?
         ORDER BY source_recorded_at ASC, event_id ASC`,
        [String(row.cohort_member_id), cutoff.effectiveAsOf]
      );
      return {
        id: String(row.cohort_member_id),
        cohortId: String(row.cohort_id),
        workspaceId: String(row.workspace_id),
        platform: String(row.platform),
        canonicalSubjectId: `subject-${String(row.subject_stable_key)}`,
        subjectStableKey: String(row.subject_stable_key),
        primaryCandidateId: String(row.candidate_id),
        firstEventId: String(row.event_id),
        firstDiscoveredAt: String(row.discovered_at),
        firstSourceRecordedAt: String(row.source_recorded_at),
        firstSourceTemporalSequence: Number(row.source_temporal_sequence),
        firstPlanId: String(row.plan_id),
        firstRunId: String(row.run_id),
        firstShardId: String(row.attribution_snapshot),
        attributionSnapshot: JSON.parse(
          String(row.attribution_snapshot)
        ) as OutcomeAttributionInput,
        ownershipVersionId: String(row.id),
        appendRevision: Number(row.append_revision),
        projectionRecordedAt: String(row.projection_recorded_at),
        projectionTemporalSequence: Number(
          row.projection_temporal_sequence
        ),
        sources: (sourceRows as MysqlRow[]).map((source) => ({
          cohortMemberId: String(source.cohort_member_id),
          eventId: String(source.event_id),
          candidateId: String(source.candidate_id),
          evidenceId: source.evidence_id === null
            ? null : String(source.evidence_id),
          ownerId: String(source.owner_id),
          discoveredAt: String(source.discovered_at),
          sourceRecordedAt: String(source.source_recorded_at),
          sourceTemporalSequence: Number(source.source_temporal_sequence),
          projectionRecordedAt: String(source.projection_recorded_at),
          projectionTemporalSequence: Number(
            source.projection_temporal_sequence
          )
        }))
      };
    }));
  }

  async listMembershipVersions(
    workspaceId: string
  ): Promise<AcquisitionCohortMembershipVersion[]> {
    const [rows] = await this.pool.query(
      `SELECT * FROM acquisition_cohort_membership_versions
       WHERE workspace_id = ? ORDER BY append_revision ASC`,
      [workspaceId]
    );
    return (rows as MysqlRow[]).map((row) => ({
      id: String(row.id),
      cohortMemberId: String(row.cohort_member_id),
      workspaceId: String(row.workspace_id),
      platform: String(row.platform),
      subjectStableKey: String(row.subject_stable_key),
      cohortId: String(row.cohort_id),
      appendRevision: Number(row.append_revision),
      eventId: String(row.event_id),
      candidateId: String(row.candidate_id),
      planId: String(row.plan_id),
      runId: String(row.run_id),
      discoveredAt: String(row.discovered_at),
      sourceRecordedAt: String(row.source_recorded_at),
      sourceTemporalSequence: Number(row.source_temporal_sequence),
      attributionSnapshot: JSON.parse(
        String(row.attribution_snapshot)
      ) as OutcomeAttributionInput,
      becameHead: Boolean(row.became_head),
      previousHeadVersionId: row.previous_head_version_id === null
        ? null : String(row.previous_head_version_id),
      projectionRecordedAt: String(row.projection_recorded_at),
      projectionTemporalSequence: Number(
        row.projection_temporal_sequence
      )
    }));
  }

  async listMemberSources(
    workspaceId: string
  ): Promise<AcquisitionCohortMemberSource[]> {
    const [rows] = await this.pool.query(
      `SELECT s.* FROM acquisition_cohort_member_sources s
       JOIN acquisition_cohort_members m
         ON m.id = s.cohort_member_id
       WHERE m.workspace_id = ?
       ORDER BY s.source_recorded_at ASC, s.event_id ASC`,
      [workspaceId]
    );
    return (rows as MysqlRow[]).map((row) => ({
      cohortMemberId: String(row.cohort_member_id),
      eventId: String(row.event_id),
      candidateId: String(row.candidate_id),
      evidenceId: row.evidence_id === null ? null : String(row.evidence_id),
      ownerId: String(row.owner_id),
      discoveredAt: String(row.discovered_at),
      sourceRecordedAt: String(row.source_recorded_at),
      sourceTemporalSequence: Number(row.source_temporal_sequence),
      projectionRecordedAt: String(row.projection_recorded_at),
      projectionTemporalSequence: Number(
        row.projection_temporal_sequence
      )
    }));
  }

  async createOrReplayCatchUp(input: {
    workspaceId: string;
    cohortId: string;
    cutoff: { effectiveAsOf: string; temporalSequence: number };
    requestedBy: string;
    authorityKind: "roi_close" | "performance_read";
    parentClosureOperationId: string | null;
    requestIdentity: string;
  }): Promise<AcquisitionCohortCatchUpOperation> {
    const requestIdentityHash = `sha256:${Buffer.from(
      input.requestIdentity
    ).toString("hex")}`;
    const [rows] = await this.pool.query(
      `SELECT * FROM acquisition_cohort_catch_up_operations
       WHERE workspace_id = ? AND authority_kind = ?
         AND request_identity_hash = ?`,
      [input.workspaceId, input.authorityKind, requestIdentityHash]
    );
    const existing = (rows as MysqlRow[])[0];
    if (existing) return this.catchUpOperation(existing);
    const id = `catchup-${requestIdentityHash.slice(0, 24)}`;
    await this.pool.query(
      `INSERT INTO acquisition_cohort_catch_up_operations (
        id, workspace_id, cohort_id, cutoff_effective_as_of,
        initial_cutoff_temporal_sequence, requested_by, authority_kind,
        parent_closure_operation_id, request_identity_hash, status,
        fencing_token, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
      [id, input.workspaceId, input.cohortId, input.cutoff.effectiveAsOf,
        input.cutoff.temporalSequence, input.requestedBy,
        input.authorityKind, input.parentClosureOperationId,
        requestIdentityHash, input.cutoff.effectiveAsOf]
    );
    return (await this.catchUpOperationById(id))!;
  }

  async claimCatchUp(
    operationId: string,
    workerId: string,
    now: string,
    leaseDurationMs: number
  ) {
    const [result] = await this.pool.query(
      `UPDATE acquisition_cohort_catch_up_operations
       SET status = 'running', lease_owner = ?,
         lease_expires_at = ?, fencing_token = fencing_token + 1,
         updated_at = ?
       WHERE id = ? AND (status = 'queued'
         OR (status = 'running' AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?))`,
      [workerId, new Date(Date.parse(now) + leaseDurationMs).toISOString(),
        now, operationId, now]
    );
    if (Number((result as { affectedRows?: unknown }).affectedRows ?? 0) !== 1) {
      return null;
    }
    return this.catchUpOperationById(operationId);
  }

  async readCheckpoint(
    operationId: string,
    lease: AcquisitionCohortCatchUpOperation
  ) {
    this.assertLive(operationId, lease);
    const operation = await this.catchUpOperationById(operationId);
    return operation?.checkpoint ?? null;
  }

  async advanceCheckpoint(
    operationId: string,
    checkpoint: { sourceRecordedAt: string; eventId: string } | null,
    lease: AcquisitionCohortCatchUpOperation
  ) {
    this.assertLive(operationId, lease);
    await this.pool.query(
      `UPDATE acquisition_cohort_catch_up_operations
       SET checkpoint_source_recorded_at = ?,
         checkpoint_event_id = ?, updated_at = ?
       WHERE id = ?`,
      [checkpoint?.sourceRecordedAt ?? null, checkpoint?.eventId ?? null,
        lease.leaseExpiresAt, operationId]
    );
  }

  async renewCatchUp(
    lease: AcquisitionCohortCatchUpOperation,
    now: string,
    leaseDurationMs: number
  ) {
    this.assertLive(lease.id, lease);
    await this.pool.query(
      `UPDATE acquisition_cohort_catch_up_operations
       SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND fencing_token = ?
         AND status = 'running'`,
      [new Date(Date.parse(now) + leaseDurationMs).toISOString(), now,
        lease.id, lease.leaseOwner, lease.fencingToken]
    );
  }

  async recordUnassignable(
    operationId: string,
    eventId: string,
    lease: AcquisitionCohortCatchUpOperation
  ) {
    this.assertLive(operationId, lease);
    void eventId;
  }

  async completeCatchUp(
    operationId: string,
    lease: AcquisitionCohortCatchUpOperation,
    result: CohortCatchUpResult
  ) {
    this.assertLive(operationId, lease);
    await this.pool.query(
      `UPDATE acquisition_cohort_catch_up_operations
       SET status = 'succeeded', lease_owner = NULL,
         lease_expires_at = NULL, updated_at = ?
       WHERE id = ?`,
      [lease.leaseExpiresAt, operationId]
    );
    void result;
  }

  async listCatchUpOperations(
    workspaceId: string
  ): Promise<AcquisitionCohortCatchUpOperation[]> {
    const [rows] = await this.pool.query(
      `SELECT * FROM acquisition_cohort_catch_up_operations
       WHERE workspace_id = ?`,
      [workspaceId]
    );
    return (rows as MysqlRow[]).map((row) => this.catchUpOperation(row));
  }

  private catchUpOperation(row: MysqlRow): AcquisitionCohortCatchUpOperation {
    return Object.freeze({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      cohortId: String(row.cohort_id),
      cutoffEffectiveAsOf: String(row.cutoff_effective_as_of),
      initialCutoffTemporalSequence: Number(
        row.initial_cutoff_temporal_sequence
      ),
      requestedBy: String(row.requested_by),
      authorityKind: String(row.authority_kind) as
        AcquisitionCohortCatchUpOperation["authorityKind"],
      parentClosureOperationId: row.parent_closure_operation_id === null
        ? null : String(row.parent_closure_operation_id),
      requestIdentityHash: String(row.request_identity_hash) as
        `sha256:${string}`,
      status: String(row.status) as
        AcquisitionCohortCatchUpOperation["status"],
      checkpoint: row.checkpoint_source_recorded_at === null
        ? null
        : {
            sourceRecordedAt: String(row.checkpoint_source_recorded_at),
            eventId: String(row.checkpoint_event_id)
          },
      leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
      leaseExpiresAt: row.lease_expires_at === null
        ? null : String(row.lease_expires_at),
      fencingToken: Number(row.fencing_token),
      errorCode: row.error_code === null
        ? null
        : String(row.error_code) as
            AcquisitionCohortCatchUpOperation["errorCode"]
    });
  }

  private async catchUpOperationById(
    operationId: string
  ): Promise<AcquisitionCohortCatchUpOperation | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM acquisition_cohort_catch_up_operations
       WHERE id = ?`,
      [operationId]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? this.catchUpOperation(row) : null;
  }

  private assertLive(
    operationId: string,
    lease: AcquisitionCohortCatchUpOperation
  ): void {
    void operationId;
    if (!lease.leaseOwner || lease.leaseExpiresAt === null) {
      throw new Error("stale_fencing_token");
    }
  }
}
