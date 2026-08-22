import type mysql from "mysql2/promise";
import type {
  AttributionAllocationItemInput,
  AttributionAllocationLifecycleEvent,
  AttributionAllocationSet
} from "./acquisition-attribution-allocation.js";
import type { FinancialSourceReport } from "./financial-source-report.js";
import type { GrowthTemporalBarrier } from "./growth-temporal-barrier.js";
import {
  MysqlGrowthTemporalTransaction
} from "./growth-temporal-barrier-mysql-repository.js";

type MysqlRow = Record<string, unknown>;

export const ATTRIBUTION_ALLOCATION_MYSQL_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS financial_source_reports (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    currency CHAR(3) NOT NULL,
    source_system VARCHAR(191) NOT NULL,
    source_cursor VARCHAR(191) NULL,
    report_hash CHAR(71) NOT NULL,
    declared_total_minor BIGINT NOT NULL,
    period_from DATETIME(3) NOT NULL,
    period_to DATETIME(3) NOT NULL,
    created_by VARCHAR(191) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    domain_command_hash CHAR(71) NOT NULL,
    request_hash VARCHAR(255) NOT NULL,
    requested_by VARCHAR(191) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_source_report_hash (workspace_id, report_hash),
    UNIQUE KEY uk_source_report_command (workspace_id, domain_command_hash)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS attribution_allocation_source_heads (
    workspace_id VARCHAR(191) NOT NULL,
    source_type VARCHAR(32) NOT NULL,
    source_id VARCHAR(191) NOT NULL,
    active_allocation_set_id VARCHAR(191) NULL,
    revision BIGINT UNSIGNED NOT NULL,
    last_event_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id, source_type, source_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS attribution_allocation_sets (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    source_type VARCHAR(32) NOT NULL,
    source_id VARCHAR(191) NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    status VARCHAR(16) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    created_by VARCHAR(191) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    activated_by VARCHAR(191) NULL,
    activated_at DATETIME(3) NULL,
    create_domain_command_hash CHAR(71) NOT NULL,
    create_request_hash VARCHAR(255) NOT NULL,
    requested_by VARCHAR(191) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_allocation_source_version
      (workspace_id, source_type, source_id, version),
    UNIQUE KEY uk_allocation_create_command
      (workspace_id, create_domain_command_hash),
    KEY ix_allocation_source (workspace_id, source_type, source_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS attribution_allocation_items (
    allocation_set_id VARCHAR(191) NOT NULL,
    target_stable_key VARCHAR(255) NOT NULL,
    cohort_id VARCHAR(191) NOT NULL,
    candidate_id VARCHAR(191) NULL,
    plan_id VARCHAR(191) NULL,
    run_id VARCHAR(191) NULL,
    allocation_bps BIGINT UNSIGNED NOT NULL,
    allocation_rule VARCHAR(32) NOT NULL,
    rule_version VARCHAR(64) NOT NULL,
    evidence_refs_json JSON NOT NULL,
    effective_amount_minor BIGINT NOT NULL,
    PRIMARY KEY (allocation_set_id, target_stable_key)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS attribution_allocation_lifecycle_events (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    source_type VARCHAR(32) NOT NULL,
    source_id VARCHAR(191) NOT NULL,
    allocation_set_id VARCHAR(191) NOT NULL,
    event_type VARCHAR(16) NOT NULL,
    event_sequence BIGINT UNSIGNED NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    effective_at DATETIME(3) NOT NULL,
    supersedes_allocation_set_id VARCHAR(191) NULL,
    actor_id VARCHAR(191) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    activation_domain_command_hash CHAR(71) NULL,
    activation_request_hash VARCHAR(255) NULL,
    requested_by VARCHAR(191) NULL,
    PRIMARY KEY (workspace_id, source_type, source_id, id),
    UNIQUE KEY uk_allocation_event_sequence
      (workspace_id, source_type, source_id, event_sequence),
    UNIQUE KEY uk_allocation_event_revision
      (workspace_id, source_type, source_id, revision),
    UNIQUE KEY uk_allocation_activation_command
      (workspace_id, activation_domain_command_hash)
  ) ENGINE=InnoDB`
] as const);

export async function ensureAttributionAllocationMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  for (const statement of ATTRIBUTION_ALLOCATION_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function report(row: MysqlRow): FinancialSourceReport {
  return Object.freeze({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    currency: String(row.currency),
    sourceSystem: String(row.source_system),
    sourceCursor: row.source_cursor === null ? null : String(row.source_cursor),
    reportHash: String(row.report_hash),
    declaredTotalMinor: Number(row.declared_total_minor),
    periodFrom: String(row.period_from),
    periodTo: String(row.period_to),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at)
  });
}

function allocationSet(row: MysqlRow): AttributionAllocationSet {
  return Object.freeze({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sourceType: String(row.source_type) as AttributionAllocationSet["sourceType"],
    sourceId: String(row.source_id),
    version: Number(row.version),
    status: String(row.status) as AttributionAllocationSet["status"],
    revision: Number(row.revision),
    items: [],
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    activatedBy: row.activated_by === null ? null : String(row.activated_by),
    activatedAt: row.activated_at === null ? null : String(row.activated_at)
  });
}

function lifecycleEvent(row: MysqlRow): AttributionAllocationLifecycleEvent {
  return Object.freeze({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sourceType: String(row.source_type) as AttributionAllocationSet["sourceType"],
    sourceId: String(row.source_id),
    allocationSetId: String(row.allocation_set_id),
    eventType: String(row.event_type) as
      AttributionAllocationLifecycleEvent["eventType"],
    eventSequence: Number(row.event_sequence),
    revision: Number(row.revision),
    effectiveAt: String(row.effective_at),
    supersedesAllocationSetId: row.supersedes_allocation_set_id === null
      ? null : String(row.supersedes_allocation_set_id),
    actorId: String(row.actor_id),
    recordedAt: String(row.recorded_at),
    temporalSequence: Number(row.temporal_sequence)
  });
}

export class MysqlAttributionAllocationRepository {
  constructor(
    private readonly pool: mysql.Pool,
    private readonly barrier: GrowthTemporalBarrier
  ) {}

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

  async createReport(input: {
    id: string;
    workspaceId: string;
    currency: string;
    sourceSystem: string;
    sourceCursor: string | null;
    reportHash: string;
    declaredTotalMinor: number;
    periodFrom: string;
    periodTo: string;
    createdBy: string;
    createdAt: string;
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
    requestedBy: string;
  }): Promise<FinancialSourceReport> {
    await this.transaction(async ({ connection, temporal }) => {
      const stamp = await this.barrier.allocateAppend(
        temporal, input.workspaceId
      );
      await connection.query(
        `INSERT INTO financial_source_reports (
          id, workspace_id, currency, source_system, source_cursor,
          report_hash, declared_total_minor, period_from, period_to,
          created_by, created_at, domain_command_hash, request_hash,
          requested_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.workspaceId, input.currency, input.sourceSystem,
          input.sourceCursor, input.reportHash, input.declaredTotalMinor,
          input.periodFrom, input.periodTo, input.createdBy,
          stamp.recordedAt, input.domainCommandHash, input.requestHash,
          input.requestedBy]
      );
    });
    return (await this.getReport(input.workspaceId, input.id))!;
  }

  async findReportByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<FinancialSourceReport | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM financial_source_reports
       WHERE workspace_id = ? AND domain_command_hash = ?`,
      [workspaceId, domainCommandHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? report(row) : null;
  }

  async getReport(
    workspaceId: string,
    id: string
  ): Promise<FinancialSourceReport | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM financial_source_reports
       WHERE workspace_id = ? AND id = ?`,
      [workspaceId, id]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? report(row) : null;
  }

  async createDraft(input: {
    id: string;
    workspaceId: string;
    sourceType: AttributionAllocationSet["sourceType"];
    sourceId: string;
    version: number;
    items: AttributionAllocationItemInput[];
    createdBy: string;
    createdAt: string;
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
    requestedBy: string;
  }): Promise<AttributionAllocationSet> {
    await this.transaction(async ({ connection, temporal }) => {
      await this.barrier.allocateAppend(temporal, input.workspaceId);
      await connection.query(
        `INSERT INTO attribution_allocation_sets (
          id, workspace_id, source_type, source_id, version, status,
          revision, created_by, created_at, activated_by, activated_at,
          create_domain_command_hash, create_request_hash, requested_by
        ) VALUES (?, ?, ?, ?, ?, 'draft', 1, ?, ?, NULL, NULL, ?, ?, ?)`,
        [input.id, input.workspaceId, input.sourceType, input.sourceId,
          input.version, input.createdBy, input.createdAt,
          input.domainCommandHash, input.requestHash, input.requestedBy]
      );
      for (const item of input.items) {
        await connection.query(
          `INSERT INTO attribution_allocation_items (
            allocation_set_id, target_stable_key, cohort_id, candidate_id,
            plan_id, run_id, allocation_bps, allocation_rule, rule_version,
            evidence_refs_json, effective_amount_minor
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          [input.id, item.targetStableKey, item.cohortId, item.candidateId,
            item.planId, item.runId, item.allocationBps,
            item.allocationRule, item.ruleVersion,
            JSON.stringify(item.evidenceRefs)]
        );
      }
    });
    return (await this.getSet(input.workspaceId, input.id))!;
  }

  async findDraftByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<AttributionAllocationSet | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM attribution_allocation_sets
       WHERE workspace_id = ? AND create_domain_command_hash = ?`,
      [workspaceId, domainCommandHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? this.withItems(workspaceId, allocationSet(row)) : null;
  }

  async getSet(
    workspaceId: string,
    id: string
  ): Promise<AttributionAllocationSet | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM attribution_allocation_sets
       WHERE workspace_id = ? AND id = ?`,
      [workspaceId, id]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? this.withItems(workspaceId, allocationSet(row)) : null;
  }

  private async withItems(
    workspaceId: string,
    set: AttributionAllocationSet
  ): Promise<AttributionAllocationSet> {
    const [rows] = await this.pool.query(
      `SELECT * FROM attribution_allocation_items
       WHERE allocation_set_id = ? ORDER BY target_stable_key ASC`,
      [set.id]
    );
    const items = (rows as MysqlRow[]).map((row) => Object.freeze({
      cohortId: String(row.cohort_id),
      candidateId: row.candidate_id === null ? null : String(row.candidate_id),
      planId: row.plan_id === null ? null : String(row.plan_id),
      runId: row.run_id === null ? null : String(row.run_id),
      allocationBps: Number(row.allocation_bps),
      allocationRule: String(row.allocation_rule) as
        AttributionAllocationItemInput["allocationRule"],
      ruleVersion: String(row.rule_version),
      evidenceRefs: jsonValue(row.evidence_refs_json) as
        AttributionAllocationItemInput["evidenceRefs"],
      targetStableKey: String(row.target_stable_key),
      effectiveAmountMinor: Number(row.effective_amount_minor)
    }));
    return Object.freeze({ ...set, items });
  }

  async publishActiveSet(
    workspaceId: string,
    setId: string,
    expectedHeadRevision: number
  ): Promise<AttributionAllocationSet> {
    return this.transaction(async ({ connection, temporal }) => {
      const firstStamp = await this.barrier.allocateAppend(
        temporal, workspaceId
      );
      const [draftRows] = await connection.query(
        `SELECT * FROM attribution_allocation_sets
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [workspaceId, setId]
      );
      const draftRow = (draftRows as MysqlRow[])[0];
      if (!draftRow) {
        throw Object.assign(new Error("allocation_set_not_found"), {
          code: "allocation_set_not_found", status: 404
        });
      }
      const draft = allocationSet(draftRow);
      const [headRows] = await connection.query(
        `SELECT * FROM attribution_allocation_source_heads
         WHERE workspace_id = ? AND source_type = ? AND source_id = ?
         FOR UPDATE`,
        [workspaceId, draft.sourceType, draft.sourceId]
      );
      const headRow = (headRows as MysqlRow[])[0];
      const head = headRow
        ? {
            activeAllocationSetId: headRow.active_allocation_set_id === null
              ? null : String(headRow.active_allocation_set_id),
            revision: Number(headRow.revision),
            lastEventSequence: Number(headRow.last_event_sequence)
          }
        : {
            activeAllocationSetId: null,
            revision: 1,
            lastEventSequence: 0
          };
      if (head.revision !== expectedHeadRevision) {
        throw Object.assign(new Error("revision_mismatch"), {
          code: "revision_mismatch", status: 412
        });
      }
      const [itemRows] = await connection.query(
        `SELECT * FROM attribution_allocation_items
         WHERE allocation_set_id = ?`,
        [setId]
      );
      const items = itemRows as MysqlRow[];
      const bps = items.reduce(
        (sum, item) => sum + Number(item.allocation_bps), 0
      );
      if (bps !== 10_000) {
        throw Object.assign(new Error("allocation_bps_incomplete"), {
          code: "allocation_bps_incomplete", status: 422
        });
      }
      let nextSequence = head.lastEventSequence;
      let activationStamp = firstStamp;
      if (head.activeAllocationSetId !== null) {
        nextSequence += 1;
        await connection.query(
          `INSERT INTO attribution_allocation_lifecycle_events (
            id, workspace_id, source_type, source_id, allocation_set_id,
            event_type, event_sequence, revision, effective_at,
            supersedes_allocation_set_id, actor_id, recorded_at,
            temporal_sequence, activation_domain_command_hash,
            activation_request_hash, requested_by
          ) VALUES (?, ?, ?, ?, ?, 'superseded', ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL)`,
          [`${setId}-superseded-${nextSequence}`, workspaceId,
            draft.sourceType, draft.sourceId, head.activeAllocationSetId,
            nextSequence, nextSequence, firstStamp.recordedAt,
            draft.createdBy, firstStamp.recordedAt,
            firstStamp.temporalSequence]
        );
        activationStamp = await this.barrier.allocateAppend(
          temporal, workspaceId
        );
      }
      nextSequence += 1;
      await connection.query(
        `INSERT INTO attribution_allocation_lifecycle_events (
          id, workspace_id, source_type, source_id, allocation_set_id,
          event_type, event_sequence, revision, effective_at,
          supersedes_allocation_set_id, actor_id, recorded_at,
          temporal_sequence, activation_domain_command_hash,
          activation_request_hash, requested_by
        ) VALUES (?, ?, ?, ?, ?, 'activated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`${setId}-activated-${nextSequence}`, workspaceId,
          draft.sourceType, draft.sourceId, setId,
          nextSequence, nextSequence, activationStamp.recordedAt,
          head.activeAllocationSetId, draft.createdBy,
          activationStamp.recordedAt, activationStamp.temporalSequence,
          null, null, null]
      );
      await connection.query(
        `INSERT INTO attribution_allocation_source_heads (
          workspace_id, source_type, source_id, active_allocation_set_id,
          revision, last_event_sequence
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          active_allocation_set_id = VALUES(active_allocation_set_id),
          revision = VALUES(revision),
          last_event_sequence = VALUES(last_event_sequence)`,
        [workspaceId, draft.sourceType, draft.sourceId, setId,
          head.revision + 1, nextSequence]
      );
      await connection.query(
        `UPDATE attribution_allocation_sets
         SET status = 'active', revision = ?, activated_by = ?,
           activated_at = ?
         WHERE workspace_id = ? AND id = ?`,
        [head.revision + 1, draft.createdBy, activationStamp.recordedAt,
          workspaceId, setId]
      );
      return (await this.getSet(workspaceId, setId))!;
    });
  }

  async findActivationByDomainCommandHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<AttributionAllocationSet | null> {
    const [rows] = await this.pool.query(
      `SELECT s.* FROM attribution_allocation_lifecycle_events e
       JOIN attribution_allocation_sets s
         ON s.id = e.allocation_set_id AND s.workspace_id = e.workspace_id
       WHERE e.workspace_id = ? AND e.activation_domain_command_hash = ?`,
      [workspaceId, domainCommandHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? this.withItems(workspaceId, allocationSet(row)) : null;
  }

  async listActiveSets(
    workspaceId: string,
    sourceType: AttributionAllocationSet["sourceType"],
    sourceId: string
  ): Promise<AttributionAllocationSet[]> {
    const [rows] = await this.pool.query(
      `SELECT * FROM attribution_allocation_sets
       WHERE workspace_id = ? AND source_type = ? AND source_id = ?
         AND status = 'active'`,
      [workspaceId, sourceType, sourceId]
    );
    return Promise.all((rows as MysqlRow[]).map((row) =>
      this.withItems(workspaceId, allocationSet(row))));
  }

  async listLifecycleEvents(
    workspaceId: string,
    sourceType: AttributionAllocationSet["sourceType"],
    sourceId: string
  ): Promise<AttributionAllocationLifecycleEvent[]> {
    const [rows] = await this.pool.query(
      `SELECT * FROM attribution_allocation_lifecycle_events
       WHERE workspace_id = ? AND source_type = ? AND source_id = ?
       ORDER BY event_sequence ASC`,
      [workspaceId, sourceType, sourceId]
    );
    return (rows as MysqlRow[]).map(lifecycleEvent);
  }

  async get(
    workspaceId: string,
    id: string
  ): Promise<AttributionAllocationSet | null> {
    return this.getSet(workspaceId, id);
  }

  async activate(input: {
    workspaceId: string;
    allocationSetId: string;
    expectedRevision: number;
    amounts: Array<{ targetStableKey: string; amountMinor: number }>;
    activatedBy: string;
    activatedAt: string;
    temporalSequence: number;
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
  }): Promise<AttributionAllocationSet> {
    void input.amounts;
    void input.activatedBy;
    void input.activatedAt;
    void input.temporalSequence;
    void input.domainCommandHash;
    void input.requestHash;
    return this.publishActiveSet(
      input.workspaceId, input.allocationSetId, input.expectedRevision
    );
  }

  async activationCount(allocationSetId: string): Promise<number> {
    const [rows] = await this.pool.query(
      `SELECT COUNT(*) AS count FROM attribution_allocation_lifecycle_events
       WHERE allocation_set_id = ? AND event_type = 'activated'`,
      [allocationSetId]
    );
    return Number((rows as Array<{ count: string }>)[0]?.count);
  }
}
