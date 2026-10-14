import type mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { RoiClosureError } from "./acquisition-roi-closure.js";
import type {
  ClosureAttestation,
  RoiClosureRepository,
  RoiClosureSeries,
  RoiClosureVersion,
  RoiSnapshot,
  RoiSnapshotEntry,
  RoiSnapshotSliceMember
} from "./acquisition-roi-closure.js";
import type { GrowthTemporalBarrier } from "./growth-temporal-barrier.js";
import { assertGrowthSealedReadCutoff, type GrowthSealedReadCutoff } from "./growth-temporal-barrier.js";
import {
  MysqlGrowthTemporalTransaction,
  growthMysqlDate,
  growthMysqlInstant
} from "./growth-temporal-barrier-mysql-repository.js";

type MysqlRow = Record<string, unknown>;

export const ROI_CLOSURE_MYSQL_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS roi_closure_commands (
    workspace_id VARCHAR(191) NOT NULL,
    domain_command_hash CHAR(71) NOT NULL,
    closure_version_id VARCHAR(191) NOT NULL,
    request_hash VARCHAR(255) NOT NULL,
    requested_by VARCHAR(191) NOT NULL,
    PRIMARY KEY (workspace_id, domain_command_hash),
    UNIQUE KEY uk_roi_closure_command_version (closure_version_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS closure_attestations (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    cohort_id VARCHAR(191) NOT NULL,
    currency CHAR(3) NOT NULL,
    aspect VARCHAR(32) NOT NULL,
    period_from DATETIME(3) NOT NULL,
    period_to DATETIME(3) NOT NULL,
    as_of DATETIME(3) NOT NULL,
    declared_total_minor BIGINT NULL,
    source_system VARCHAR(191) NOT NULL,
    source_cursor VARCHAR(191) NULL,
    source_report_id VARCHAR(191) NULL,
    report_allocation_set_id VARCHAR(191) NULL,
    report_hash VARCHAR(255) NOT NULL,
    evidence_refs_json JSON NOT NULL,
    status VARCHAR(16) NOT NULL,
    signed_by VARCHAR(191) NOT NULL,
    signed_at DATETIME(3) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    domain_command_hash CHAR(71) NOT NULL,
    request_hash VARCHAR(255) NOT NULL,
    requested_by VARCHAR(191) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_closure_attestation_command
      (workspace_id, domain_command_hash),
    KEY ix_closure_attestation_cohort (workspace_id, cohort_id, currency)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS roi_closure_operations (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    cohort_id VARCHAR(191) NOT NULL,
    currency CHAR(3) NOT NULL,
    idempotency_key_hash CHAR(71) NOT NULL,
    request_hash CHAR(71) NOT NULL,
    domain_command_hash CHAR(71) NOT NULL,
    input_hash CHAR(71) NOT NULL,
    input_json JSON NOT NULL,
    expected_series_revision BIGINT UNSIGNED NOT NULL,
    requested_by VARCHAR(191) NOT NULL,
    status VARCHAR(16) NOT NULL,
    lease_owner VARCHAR(128) NULL,
    lease_expires_at DATETIME(3) NULL,
    fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
    closure_version_id VARCHAR(191) NULL,
    error_code VARCHAR(64) NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_roi_closure_operation_workspace_id (workspace_id, id),
    UNIQUE KEY uk_roi_closure_operation_idem
      (workspace_id, requested_by, idempotency_key_hash),
    UNIQUE KEY uk_roi_closure_operation_command
      (workspace_id, domain_command_hash),
    UNIQUE KEY uk_roi_closure_operation_input
      (workspace_id, cohort_id, currency, expected_series_revision,
       input_hash),
    KEY idx_roi_closure_recovery
      (status, lease_expires_at, created_at, id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS roi_closure_series (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    cohort_id VARCHAR(191) NOT NULL,
    currency CHAR(3) NOT NULL,
    status VARCHAR(16) NOT NULL,
    current_closure_version_id VARCHAR(191) NULL,
    revision BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uk_roi_series (workspace_id, cohort_id, currency)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS roi_closure_series_events (
    id VARCHAR(191) NOT NULL,
    closure_series_id VARCHAR(191) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    event_type VARCHAR(16) NOT NULL,
    closure_version_id VARCHAR(191) NOT NULL,
    actor_id VARCHAR(191) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    domain_command_hash CHAR(71) NULL,
    request_hash CHAR(71) NULL,
    PRIMARY KEY (closure_series_id, id),
    UNIQUE KEY uk_roi_series_revision (closure_series_id, revision),
    KEY ix_roi_series_event_version (closure_series_id, closure_version_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS roi_closure_versions (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    cohort_id VARCHAR(191) NOT NULL,
    currency CHAR(3) NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    as_of DATETIME(3) NOT NULL,
    previous_closure_version_id VARCHAR(191) NULL,
    formula_version VARCHAR(64) NOT NULL,
    membership_snapshot_hash CHAR(71) NOT NULL,
    attestation_set_hash CHAR(71) NOT NULL,
    fact_set_hash CHAR(71) NOT NULL,
    cost_set_hash CHAR(71) NOT NULL,
    allocation_set_hash CHAR(71) NOT NULL,
    settlement_set_hash CHAR(71) NOT NULL,
    closed_by VARCHAR(191) NOT NULL,
    closed_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_roi_closure_version
      (workspace_id, cohort_id, currency, version)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS roi_snapshots (
    closure_version_id VARCHAR(191) NOT NULL,
    slice_key VARCHAR(160) NOT NULL,
    plan_id VARCHAR(128) NULL,
    member_count BIGINT UNSIGNED NOT NULL,
    member_set_hash CHAR(71) NOT NULL,
    computed_metrics_json JSON NOT NULL,
    commercial_ratios_json JSON NOT NULL,
    commercial_authority_set_hash CHAR(71) NOT NULL,
    coverage_json JSON NOT NULL,
    calculation_hash CHAR(71) NOT NULL,
    PRIMARY KEY (closure_version_id, slice_key)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS roi_snapshot_slice_members (
    closure_version_id VARCHAR(191) NOT NULL,
    slice_key VARCHAR(160) NOT NULL,
    cohort_member_id VARCHAR(191) NOT NULL,
    ownership_version_id VARCHAR(191) NOT NULL,
    PRIMARY KEY (closure_version_id, slice_key, cohort_member_id),
    KEY idx_roi_slice_member_lookup
      (closure_version_id, cohort_member_id, slice_key)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS roi_snapshot_entries (
    closure_version_id VARCHAR(191) NOT NULL,
    source_type VARCHAR(32) NOT NULL,
    source_id VARCHAR(128) NOT NULL,
    effective_amount_minor BIGINT NULL,
    source_hash CHAR(71) NOT NULL,
    PRIMARY KEY (closure_version_id, source_type, source_id)
  ) ENGINE=InnoDB`
] as const);

export async function ensureRoiClosureMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  for (const statement of ROI_CLOSURE_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function attestation(row: MysqlRow): ClosureAttestation {
  return Object.freeze({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    cohortId: String(row.cohort_id),
    currency: String(row.currency),
    aspect: String(row.aspect) as ClosureAttestation["aspect"],
    periodFrom: growthMysqlInstant(row.period_from),
    periodTo: growthMysqlInstant(row.period_to),
    asOf: growthMysqlInstant(row.as_of),
    declaredTotalMinor: row.declared_total_minor === null
      ? null : Number(row.declared_total_minor),
    sourceSystem: String(row.source_system),
    sourceCursor: row.source_cursor === null ? null : String(row.source_cursor),
    sourceReportId: row.source_report_id === null
      ? null : String(row.source_report_id),
    reportAllocationSetId: row.report_allocation_set_id === null
      ? null : String(row.report_allocation_set_id),
    reportHash: String(row.report_hash),
    evidenceRefs: jsonValue(row.evidence_refs_json) as
      ClosureAttestation["evidenceRefs"],
    status: String(row.status) as ClosureAttestation["status"],
    signedBy: String(row.signed_by),
    signedAt: growthMysqlInstant(row.signed_at)
  });
}

function series(row: MysqlRow): RoiClosureSeries {
  return Object.freeze({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    cohortId: String(row.cohort_id),
    currency: String(row.currency),
    status: String(row.status) as RoiClosureSeries["status"],
    currentClosureVersionId: row.current_closure_version_id === null
      ? null : String(row.current_closure_version_id),
    revision: Number(row.revision),
    updatedAt: String(row.updated_at ?? row.recorded_at ?? "")
  });
}

function closureVersion(row: MysqlRow): RoiClosureVersion {
  return Object.freeze({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    cohortId: String(row.cohort_id),
    currency: String(row.currency),
    version: Number(row.version),
    asOf: growthMysqlInstant(row.as_of),
    status: Number(row.superseded ?? 0) === 1 ? "superseded" : "closed",
    previousClosureVersionId: row.previous_closure_version_id === null
      ? null : String(row.previous_closure_version_id),
    formulaVersion: "verified-gross-profit-roi.v1",
    membershipSnapshotHash: String(row.membership_snapshot_hash),
    attestationSetHash: String(row.attestation_set_hash),
    factSetHash: String(row.fact_set_hash),
    costSetHash: String(row.cost_set_hash),
    allocationSetHash: String(row.allocation_set_hash),
    settlementSetHash: String(row.settlement_set_hash),
    closedBy: String(row.closed_by),
    closedAt: growthMysqlInstant(row.closed_at)
  });
}

export class MysqlRoiClosureRepository implements RoiClosureRepository {
  constructor(
    private readonly pool: mysql.Pool,
    private readonly barrier: GrowthTemporalBarrier
  ) {}

  async selectPublishedVersionAt(
    workspaceId: string, cohortId: string, currency: string,
    cutoff: GrowthSealedReadCutoff, versionId?: string
  ): Promise<RoiClosureVersion | null> {
    assertGrowthSealedReadCutoff(cutoff, workspaceId);
    const date = growthMysqlDate(cutoff.effectiveAsOf);
    const [rows] = await this.pool.query(
      `SELECT v.*, EXISTS (
        SELECT 1 FROM roi_closure_series_events r WHERE r.closure_version_id = v.id
        AND r.event_type = 'reopened' AND r.recorded_at <= ? AND r.temporal_sequence <= ?
      ) AS superseded FROM roi_closure_versions v
      WHERE v.workspace_id = ? AND v.cohort_id = ? AND v.currency = ? AND v.closed_at <= ?
        AND (? IS NULL OR v.id = ?)
        AND EXISTS (SELECT 1 FROM roi_closure_series_events e
          WHERE e.closure_version_id = v.id AND e.event_type = 'closed'
            AND e.recorded_at <= ? AND e.temporal_sequence <= ?)
      ORDER BY v.closed_at DESC, v.version DESC LIMIT 1`,
      [date, cutoff.temporalSequence, workspaceId, cohortId, currency, date,
        versionId ?? null, versionId ?? null, date, cutoff.temporalSequence]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? closureVersion(row) : null;
  }

  private async transaction<T>(
    work: (tx: {
      connection: mysql.PoolConnection;
      temporal: MysqlGrowthTemporalTransaction;
    }) => Promise<T>
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const temporal = new MysqlGrowthTemporalTransaction(connection);
      const result = await work({ connection, temporal });
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getSeries(
    workspaceId: string,
    cohortId: string,
    currency: string
  ): Promise<RoiClosureSeries | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM roi_closure_series
       WHERE workspace_id = ? AND cohort_id = ? AND currency = ?`,
      [workspaceId, cohortId, currency]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? series(row) : null;
  }

  async getSeriesById(
    workspaceId: string,
    seriesId: string
  ): Promise<RoiClosureSeries | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM roi_closure_series
       WHERE workspace_id = ? AND id = ?`,
      [workspaceId, seriesId]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? series(row) : null;
  }

  async createSeries(series: RoiClosureSeries): Promise<void> {
    await this.pool.query(
      `INSERT INTO roi_closure_series (
        id, workspace_id, cohort_id, currency, status,
        current_closure_version_id, revision
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      [series.id, series.workspaceId, series.cohortId, series.currency,
        series.status, series.revision]
    );
  }

  async appendAttestation(
    input: ClosureAttestation,
    domainCommandHash: `sha256:${string}`
  ): Promise<ClosureAttestation> {
    await this.transaction(async ({ connection, temporal }) => {
      const stamp = await this.barrier.allocateAppend(
        temporal, input.workspaceId
      );
      await connection.query(
        `INSERT INTO closure_attestations (
          id, workspace_id, cohort_id, currency, aspect, period_from,
          period_to, as_of, declared_total_minor, source_system,
          source_cursor, source_report_id, report_allocation_set_id,
          report_hash, evidence_refs_json, status, signed_by, signed_at,
          recorded_at, temporal_sequence, domain_command_hash,
          request_hash, requested_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'signed',
          ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.workspaceId, input.cohortId, input.currency,
          input.aspect, growthMysqlDate(input.periodFrom), growthMysqlDate(input.periodTo), growthMysqlDate(input.asOf),
          input.declaredTotalMinor, input.sourceSystem, input.sourceCursor,
          input.sourceReportId, input.reportAllocationSetId,
          input.reportHash, JSON.stringify(input.evidenceRefs),
          input.signedBy, growthMysqlDate(input.signedAt), growthMysqlDate(stamp.recordedAt),
          stamp.temporalSequence, domainCommandHash, input.signedBy,
          input.signedBy]
      );
    });
    return input;
  }

  async findAttestationByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<ClosureAttestation | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM closure_attestations
       WHERE workspace_id = ? AND domain_command_hash = ?`,
      [workspaceId, domainCommandHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? attestation(row) : null;
  }

  async listAttestations(
    workspaceId: string,
    cohortId: string,
    currency: string
  ): Promise<ClosureAttestation[]> {
    const [rows] = await this.pool.query(
      `SELECT * FROM closure_attestations
       WHERE workspace_id = ? AND cohort_id = ? AND currency = ?`,
      [workspaceId, cohortId, currency]
    );
    return (rows as MysqlRow[]).map(attestation);
  }

  async appendClosureVersion(input: {
    version: RoiClosureVersion;
    series?: RoiClosureSeries;
    snapshots: RoiSnapshot[];
    sliceMembers: RoiSnapshotSliceMember[];
    entries: RoiSnapshotEntry[];
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
    requestedBy: string;
  }): Promise<RoiClosureVersion> {
    await this.transaction(async ({ connection, temporal }) => {
      const stamp = await this.barrier.allocateAppend(temporal, input.version.workspaceId);
      if (input.series && (input.series.workspaceId !== input.version.workspaceId
        || input.series.cohortId !== input.version.cohortId
        || input.series.currency !== input.version.currency)) {
        throw new RoiClosureError("closure_series_mismatch", 409);
      }
      await connection.query(
        `INSERT INTO roi_closure_commands (
          workspace_id, domain_command_hash, closure_version_id, request_hash, requested_by
        ) VALUES (?, ?, ?, ?, ?)`,
        [input.version.workspaceId, input.domainCommandHash, input.version.id,
          input.requestHash, input.requestedBy]
      );
      await connection.query(
        `INSERT INTO roi_closure_versions (
          id, workspace_id, cohort_id, currency, version, as_of,
          previous_closure_version_id, formula_version,
          membership_snapshot_hash, attestation_set_hash, fact_set_hash,
          cost_set_hash, allocation_set_hash, settlement_set_hash,
          closed_by, closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.version.id, input.version.workspaceId, input.version.cohortId,
          input.version.currency, input.version.version, growthMysqlDate(input.version.asOf),
          input.version.previousClosureVersionId,
          input.version.formulaVersion,
          input.version.membershipSnapshotHash,
          input.version.attestationSetHash, input.version.factSetHash,
          input.version.costSetHash, input.version.allocationSetHash,
          input.version.settlementSetHash, input.version.closedBy,
          growthMysqlDate(input.version.closedAt)]
      );
      for (const snapshot of input.snapshots) {
        await connection.query(
          `INSERT INTO roi_snapshots (
            closure_version_id, slice_key, plan_id, member_count,
            member_set_hash, computed_metrics_json, commercial_ratios_json,
            commercial_authority_set_hash, coverage_json, calculation_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [snapshot.closureVersionId, snapshot.sliceKey, snapshot.planId,
            snapshot.memberCount, snapshot.memberSetHash,
            JSON.stringify(snapshot.computedMetrics),
            JSON.stringify(snapshot.commercialRatios),
            snapshot.commercialAuthoritySetHash,
            JSON.stringify(snapshot.coverage), snapshot.calculationHash]
        );
      }
      for (const member of input.sliceMembers) {
        await connection.query(
          `INSERT INTO roi_snapshot_slice_members (
            closure_version_id, slice_key, cohort_member_id,
            ownership_version_id
          ) VALUES (?, ?, ?, ?)`,
          [member.closureVersionId, member.sliceKey, member.cohortMemberId,
            member.ownershipVersionId]
        );
      }
      for (const entry of input.entries) {
        await connection.query(
          `INSERT INTO roi_snapshot_entries (
            closure_version_id, source_type, source_id,
            effective_amount_minor, source_hash
          ) VALUES (?, ?, ?, ?, ?)`,
          [entry.closureVersionId, entry.sourceType, entry.sourceId,
            entry.effectiveAmountMinor, entry.sourceHash]
        );
      }
      if (input.series) {
        await this.closeInTransaction(connection, stamp, input.series, input.version.id);
      }
    });
    return input.version;
  }

  async findClosureVersionByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<RoiClosureVersion | null> {
    const [rows] = await this.pool.query(
      `SELECT v.*, EXISTS (
         SELECT 1 FROM roi_closure_series_events e
         WHERE e.closure_version_id = v.id AND e.event_type = 'reopened'
       ) AS superseded FROM roi_closure_versions v
       JOIN roi_closure_commands c ON c.closure_version_id = v.id
         AND c.workspace_id = v.workspace_id
       WHERE c.workspace_id = ? AND c.domain_command_hash = ?`,
      [workspaceId, domainCommandHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? closureVersion(row) : null;
  }

  async getVersion(
    workspaceId: string,
    id: string
  ): Promise<RoiClosureVersion | null> {
    const [rows] = await this.pool.query(
      `SELECT v.*, EXISTS (
         SELECT 1 FROM roi_closure_series_events e
         WHERE e.closure_version_id = v.id AND e.event_type = 'reopened'
       ) AS superseded FROM roi_closure_versions v
       WHERE v.workspace_id = ? AND v.id = ?`,
      [workspaceId, id]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? closureVersion(row) : null;
  }

  async listSnapshots(
    workspaceId: string,
    closureVersionId: string
  ): Promise<RoiSnapshot[]> {
    const [rows] = await this.pool.query(
      `SELECT s.* FROM roi_snapshots s
       JOIN roi_closure_versions v ON v.id = s.closure_version_id
       WHERE v.workspace_id = ? AND s.closure_version_id = ? ORDER BY s.slice_key ASC`,
      [workspaceId, closureVersionId]
    );
    return (rows as MysqlRow[]).map((row) => Object.freeze({
      closureVersionId: String(row.closure_version_id),
      sliceKey: String(row.slice_key) as RoiSnapshot["sliceKey"],
      planId: row.plan_id === null ? null : String(row.plan_id),
      memberCount: Number(row.member_count),
      memberSetHash: String(row.member_set_hash),
      computedMetrics: jsonValue(row.computed_metrics_json) as
        RoiSnapshot["computedMetrics"],
      commercialRatios: jsonValue(row.commercial_ratios_json) as
        RoiSnapshot["commercialRatios"],
      commercialAuthoritySetHash: String(row.commercial_authority_set_hash),
      coverage: jsonValue(row.coverage_json) as RoiSnapshot["coverage"],
      calculationHash: String(row.calculation_hash)
    }) as RoiSnapshot);
  }

  async listSliceMembers(
    workspaceId: string,
    closureVersionId: string
  ): Promise<RoiSnapshotSliceMember[]> {
    const [rows] = await this.pool.query(
      `SELECT s.* FROM roi_snapshot_slice_members s
       JOIN roi_closure_versions v ON v.id = s.closure_version_id
       WHERE v.workspace_id = ? AND s.closure_version_id = ?`,
      [workspaceId, closureVersionId]
    );
    return (rows as MysqlRow[]).map((row) => Object.freeze({
      closureVersionId: String(row.closure_version_id),
      sliceKey: String(row.slice_key) as RoiSnapshotSliceMember["sliceKey"],
      cohortMemberId: String(row.cohort_member_id),
      ownershipVersionId: String(row.ownership_version_id)
    }));
  }

  async listEntries(
    workspaceId: string,
    closureVersionId: string
  ): Promise<RoiSnapshotEntry[]> {
    const [rows] = await this.pool.query(
      `SELECT s.* FROM roi_snapshot_entries s
       JOIN roi_closure_versions v ON v.id = s.closure_version_id
       WHERE v.workspace_id = ? AND s.closure_version_id = ? ORDER BY s.source_type ASC, s.source_id ASC`,
      [workspaceId, closureVersionId]
    );
    return (rows as MysqlRow[]).map((row) => Object.freeze({
      closureVersionId: String(row.closure_version_id),
      sourceType: String(row.source_type) as RoiSnapshotEntry["sourceType"],
      sourceId: String(row.source_id),
      effectiveAmountMinor: row.effective_amount_minor === null
        ? null : Number(row.effective_amount_minor),
      sourceHash: String(row.source_hash)
    }));
  }

  async markClosed(
    series: RoiClosureSeries,
    closureVersionId: string
  ): Promise<RoiClosureSeries> {
    return this.transaction(async ({ connection, temporal }) => {
      const stamp = await this.barrier.allocateAppend(temporal, series.workspaceId);
      return this.closeInTransaction(connection, stamp, series, closureVersionId);
    });
  }

  private async closeInTransaction(
    connection: mysql.PoolConnection,
    stamp: { recordedAt: string; temporalSequence: number },
    series: RoiClosureSeries,
    closureVersionId: string
  ): Promise<RoiClosureSeries> {
      const [versions] = await connection.query(
        `SELECT closed_by FROM roi_closure_versions
         WHERE id = ? AND workspace_id = ? AND cohort_id = ? AND currency = ?`,
        [closureVersionId, series.workspaceId, series.cohortId, series.currency]
      );
      const version = (versions as MysqlRow[])[0];
      if (!version) throw new RoiClosureError("closure_not_found", 404);
      const [result] = await connection.query(
        `UPDATE roi_closure_series
         SET status = 'closed', current_closure_version_id = ?, revision = revision + 1
         WHERE id = ? AND workspace_id = ? AND cohort_id = ? AND currency = ?
           AND status = 'open' AND revision = ?`,
        [closureVersionId, series.id, series.workspaceId, series.cohortId, series.currency, series.revision]
      );
      if ((result as mysql.ResultSetHeader).affectedRows !== 1) {
        throw new RoiClosureError("revision_mismatch", 412);
      }
      await connection.query(
        `INSERT INTO roi_closure_series_events (
          id, closure_series_id, revision, event_type, closure_version_id,
          actor_id, recorded_at, temporal_sequence
        ) VALUES (?, ?, ?, 'closed', ?, ?, ?, ?)`,
        [randomUUID(), series.id, series.revision + 1, closureVersionId,
          version.closed_by, growthMysqlDate(stamp.recordedAt), stamp.temporalSequence]
      );
      return Object.freeze({ ...series, status: "closed" as const,
        currentClosureVersionId: closureVersionId, revision: series.revision + 1,
        updatedAt: stamp.recordedAt });
  }

  async appendReopenEvent(
    series: RoiClosureSeries,
    closureVersionId: string,
    domainCommandHash: `sha256:${string}`,
    actorId: string
  ): Promise<RoiClosureSeries> {
    return this.transaction(async ({ connection, temporal }) => {
      const stamp = await this.barrier.allocateAppend(temporal, series.workspaceId);
      const [result] = await connection.query(
        `UPDATE roi_closure_series
         SET status = 'open', revision = revision + 1
         WHERE id = ? AND workspace_id = ? AND cohort_id = ? AND currency = ?
           AND revision = ? AND status = 'closed' AND current_closure_version_id = ?`,
        [series.id, series.workspaceId, series.cohortId, series.currency,
          series.revision, closureVersionId]
      );
      if ((result as mysql.ResultSetHeader).affectedRows !== 1) {
        throw new RoiClosureError("revision_mismatch", 412);
      }
      await connection.query(
        `INSERT INTO roi_closure_series_events (
          id, closure_series_id, revision, event_type, closure_version_id,
          actor_id, recorded_at, temporal_sequence, domain_command_hash
        ) VALUES (?, ?, ?, 'reopened', ?, ?, ?, ?, ?)`,
        [randomUUID(), series.id, series.revision + 1, closureVersionId, actorId,
          growthMysqlDate(stamp.recordedAt), stamp.temporalSequence, domainCommandHash]
      );
      return Object.freeze({ ...series, status: "open" as const,
        revision: series.revision + 1, updatedAt: stamp.recordedAt });
    });
  }

  async findReopenByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<RoiClosureSeries | null> {
    const [rows] = await this.pool.query(
      `SELECT s.* FROM roi_closure_series_events e
       JOIN roi_closure_series s ON s.id = e.closure_series_id
       WHERE s.workspace_id = ? AND e.domain_command_hash = ?
       LIMIT 1`,
      [workspaceId, domainCommandHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? series(row) : null;
  }

  async countReopenEvents(closureVersionId: string): Promise<number> {
    const [rows] = await this.pool.query(
      `SELECT COUNT(*) AS count FROM roi_closure_series_events
       WHERE closure_version_id = ? AND event_type = 'reopened'`,
      [closureVersionId]
    );
    return Number((rows as Array<{ count: string }>)[0]?.count);
  }

  async countCloseOperations(): Promise<number> {
    const [rows] = await this.pool.query(
      `SELECT COUNT(*) AS count FROM roi_closure_operations`
    );
    return Number((rows as Array<{ count: string }>)[0]?.count);
  }

  async countClosureVersions(): Promise<number> {
    const [rows] = await this.pool.query(
      `SELECT COUNT(*) AS count FROM roi_closure_versions`
    );
    return Number((rows as Array<{ count: string }>)[0]?.count);
  }

  async countAttestations(): Promise<number> {
    const [rows] = await this.pool.query(
      `SELECT COUNT(*) AS count FROM closure_attestations`
    );
    return Number((rows as Array<{ count: string }>)[0]?.count);
  }

  async countTotalReopenEvents(): Promise<number> {
    const [rows] = await this.pool.query(
      `SELECT COUNT(*) AS count FROM roi_closure_series_events
       WHERE event_type = 'reopened'`
    );
    return Number((rows as Array<{ count: string }>)[0]?.count);
  }
}
