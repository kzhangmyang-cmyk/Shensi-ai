import type mysql from "mysql2/promise";
import type {
  CashSettlementAllocationItemInput,
  CashSettlementAllocationLifecycleEvent,
  CashSettlementAllocationRepository,
  CashSettlementAllocationSet
} from "./financial-settlement-allocation.js";
import type { GrowthTemporalBarrier } from "./growth-temporal-barrier.js";
import {
  MysqlGrowthTemporalTransaction
} from "./growth-temporal-barrier-mysql-repository.js";

type MysqlRow = Record<string, unknown>;

export const FINANCIAL_SETTLEMENT_MYSQL_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS cash_settlement_deal_guards (
    workspace_id VARCHAR(191) NOT NULL,
    deal_id VARCHAR(191) NOT NULL,
    currency CHAR(3) NOT NULL,
    PRIMARY KEY (workspace_id, deal_id, currency)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS cash_settlement_source_heads (
    workspace_id VARCHAR(191) NOT NULL,
    source_fact_id VARCHAR(191) NOT NULL,
    active_allocation_set_id VARCHAR(191) NULL,
    revision BIGINT UNSIGNED NOT NULL,
    last_event_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id, source_fact_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS cash_settlement_allocation_sets (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    source_fact_id VARCHAR(191) NOT NULL,
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
    UNIQUE KEY uk_settlement_source_version
      (workspace_id, source_fact_id, version),
    UNIQUE KEY uk_settlement_create_command
      (workspace_id, create_domain_command_hash),
    KEY ix_settlement_source (workspace_id, source_fact_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS cash_settlement_allocation_items (
    id VARCHAR(191) NOT NULL,
    allocation_set_id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    target_revenue_fact_id VARCHAR(191) NOT NULL,
    deal_id VARCHAR(191) NOT NULL,
    quote_version_id VARCHAR(191) NOT NULL,
    amount_minor BIGINT NOT NULL,
    currency CHAR(3) NOT NULL,
    original_payment_fact_id VARCHAR(191) NULL,
    original_payment_allocation_set_id VARCHAR(191) NULL,
    original_payment_allocation_item_id VARCHAR(191) NULL,
    commercial_binding_snapshot_json JSON NOT NULL,
    PRIMARY KEY (id),
    KEY ix_settlement_item_set (allocation_set_id),
    KEY ix_settlement_item_payment (original_payment_allocation_item_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS cash_settlement_allocation_lifecycle_events (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    source_fact_id VARCHAR(191) NOT NULL,
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
    PRIMARY KEY (workspace_id, source_fact_id, id),
    UNIQUE KEY uk_settlement_event_sequence
      (workspace_id, source_fact_id, event_sequence),
    UNIQUE KEY uk_settlement_event_revision
      (workspace_id, source_fact_id, revision),
    UNIQUE KEY uk_settlement_activation_command
      (workspace_id, activation_domain_command_hash)
  ) ENGINE=InnoDB`
] as const);

export async function ensureFinancialSettlementMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  for (const statement of FINANCIAL_SETTLEMENT_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function settlementSet(row: MysqlRow): CashSettlementAllocationSet {
  return Object.freeze({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sourceFactId: String(row.source_fact_id),
    version: Number(row.version),
    status: String(row.status) as CashSettlementAllocationSet["status"],
    revision: Number(row.revision),
    items: [],
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    activatedBy: row.activated_by === null ? null : String(row.activated_by),
    activatedAt: row.activated_at === null ? null : String(row.activated_at)
  });
}

function lifecycleEvent(row: MysqlRow): CashSettlementAllocationLifecycleEvent {
  return Object.freeze({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sourceFactId: String(row.source_fact_id),
    allocationSetId: String(row.allocation_set_id),
    eventType: String(row.event_type) as
      CashSettlementAllocationLifecycleEvent["eventType"],
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

export class MysqlFinancialSettlementRepository
implements CashSettlementAllocationRepository {
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

  async createDraft(input: {
    id: string;
    workspaceId: string;
    sourceFactId: string;
    version: number;
    items: CashSettlementAllocationItemInput[];
    createdBy: string;
    createdAt: string;
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
    requestedBy: string;
  }): Promise<CashSettlementAllocationSet> {
    await this.transaction(async ({ connection, temporal }) => {
      await this.barrier.allocateAppend(temporal, input.workspaceId);
      await connection.query(
        `INSERT INTO cash_settlement_allocation_sets (
          id, workspace_id, source_fact_id, version, status, revision,
          created_by, created_at, activated_by, activated_at,
          create_domain_command_hash, create_request_hash, requested_by
        ) VALUES (?, ?, ?, ?, 'draft', 1, ?, ?, NULL, NULL, ?, ?, ?)`,
        [input.id, input.workspaceId, input.sourceFactId, input.version,
          input.createdBy, input.createdAt, input.domainCommandHash,
          input.requestHash, input.requestedBy]
      );
      for (const item of input.items) {
        await connection.query(
          `INSERT INTO cash_settlement_allocation_items (
            id, allocation_set_id, workspace_id, target_revenue_fact_id,
            deal_id, quote_version_id, amount_minor, currency,
            original_payment_fact_id, original_payment_allocation_set_id,
            original_payment_allocation_item_id,
            commercial_binding_snapshot_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [`item-${input.id}-${item.targetRevenueFactId}`, input.id,
            input.workspaceId, item.targetRevenueFactId, item.dealId,
            item.quoteVersionId, item.amountMinor, item.currency,
            item.originalPaymentFactId,
            item.originalPaymentAllocationSetId,
            item.originalPaymentAllocationItemId,
            JSON.stringify(item.commercialBindingSnapshot)]
        );
      }
    });
    return (await this.get(input.workspaceId, input.id))!;
  }

  async findDraftByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<CashSettlementAllocationSet | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM cash_settlement_allocation_sets
       WHERE workspace_id = ? AND create_domain_command_hash = ?`,
      [workspaceId, domainCommandHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? this.withItems(workspaceId, settlementSet(row)) : null;
  }

  async get(
    workspaceId: string,
    id: string
  ): Promise<CashSettlementAllocationSet | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM cash_settlement_allocation_sets
       WHERE workspace_id = ? AND id = ?`,
      [workspaceId, id]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? this.withItems(workspaceId, settlementSet(row)) : null;
  }

  private async withItems(
    workspaceId: string,
    set: CashSettlementAllocationSet
  ): Promise<CashSettlementAllocationSet> {
    const [rows] = await this.pool.query(
      `SELECT * FROM cash_settlement_allocation_items
       WHERE allocation_set_id = ? ORDER BY target_revenue_fact_id ASC`,
      [set.id]
    );
    const items = (rows as MysqlRow[]).map((row) => {
      const binding = jsonValue(
        row.commercial_binding_snapshot_json
      );
      return Object.freeze({
        id: String(row.id),
        targetRevenueFactId: String(row.target_revenue_fact_id),
        dealId: String(row.deal_id),
        quoteVersionId: String(row.quote_version_id),
        amountMinor: Number(row.amount_minor),
        currency: String(row.currency),
        originalPaymentFactId: row.original_payment_fact_id === null
          ? null : String(row.original_payment_fact_id),
        originalPaymentAllocationSetId:
          row.original_payment_allocation_set_id === null
            ? null : String(row.original_payment_allocation_set_id),
        originalPaymentAllocationItemId:
          row.original_payment_allocation_item_id === null
            ? null : String(row.original_payment_allocation_item_id),
        commercialBindingSnapshot: binding as
          CashSettlementAllocationItemInput["commercialBindingSnapshot"]
      }) as CashSettlementAllocationItemInput & { id: string };
    });
    return Object.freeze({ ...set, items: items as Array<
      CashSettlementAllocationItemInput & { id: string }
    > });
  }

  async activate(input: {
    workspaceId: string;
    allocationSetId: string;
    expectedRevision: number;
    activatedBy: string;
    activatedAt: string;
    temporalSequence: number;
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
  }): Promise<CashSettlementAllocationSet> {
    return this.transaction(async ({ connection, temporal }) => {
      const firstStamp = await this.barrier.allocateAppend(
        temporal, input.workspaceId
      );
      const [draftRows] = await connection.query(
        `SELECT * FROM cash_settlement_allocation_sets
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [input.workspaceId, input.allocationSetId]
      );
      const draftRow = (draftRows as MysqlRow[])[0];
      if (!draftRow) {
        throw Object.assign(new Error("settlement_set_not_found"), {
          code: "settlement_set_not_found", status: 404
        });
      }
      const draft = settlementSet(draftRow);
      const [itemRows] = await connection.query(
        `SELECT * FROM cash_settlement_allocation_items
         WHERE allocation_set_id = ?`,
        [input.allocationSetId]
      );
      const items = itemRows as MysqlRow[];
      const dealId = String(items[0]?.deal_id ?? "");
      const currency = String(items[0]?.currency ?? "CNY");
      await connection.query(
        `INSERT INTO cash_settlement_deal_guards
           (workspace_id, deal_id, currency) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE workspace_id = VALUES(workspace_id)`,
        [input.workspaceId, dealId, currency]
      );
      await connection.query(
        `SELECT workspace_id FROM cash_settlement_deal_guards
         WHERE workspace_id = ? AND deal_id = ? AND currency = ? FOR UPDATE`,
        [input.workspaceId, dealId, currency]
      );
      const [headRows] = await connection.query(
        `SELECT * FROM cash_settlement_source_heads
         WHERE workspace_id = ? AND source_fact_id = ? FOR UPDATE`,
        [input.workspaceId, draft.sourceFactId]
      );
      const headRow = (headRows as MysqlRow[])[0];
      const head = headRow
        ? {
            activeAllocationSetId:
              headRow.active_allocation_set_id === null
                ? null : String(headRow.active_allocation_set_id),
            revision: Number(headRow.revision),
            lastEventSequence: Number(headRow.last_event_sequence)
          }
        : {
            activeAllocationSetId: null,
            revision: 1,
            lastEventSequence: 0
          };
      if (head.revision !== input.expectedRevision) {
        throw Object.assign(new Error("revision_mismatch"), {
          code: "revision_mismatch", status: 412
        });
      }
      let nextSequence = head.lastEventSequence;
      let activationStamp = firstStamp;
      if (head.activeAllocationSetId !== null) {
        nextSequence += 1;
        await connection.query(
          `INSERT INTO cash_settlement_allocation_lifecycle_events (
            id, workspace_id, source_fact_id, allocation_set_id,
            event_type, event_sequence, revision, effective_at,
            supersedes_allocation_set_id, actor_id, recorded_at,
            temporal_sequence, activation_domain_command_hash,
            activation_request_hash, requested_by
          ) VALUES (?, ?, ?, ?, 'superseded', ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL)`,
          [`${input.allocationSetId}-sup-${nextSequence}`,
            input.workspaceId, draft.sourceFactId,
            head.activeAllocationSetId, nextSequence, nextSequence,
            firstStamp.recordedAt, input.activatedBy,
            firstStamp.recordedAt, firstStamp.temporalSequence]
        );
        activationStamp = await this.barrier.allocateAppend(
          temporal, input.workspaceId
        );
      }
      nextSequence += 1;
      await connection.query(
        `INSERT INTO cash_settlement_allocation_lifecycle_events (
          id, workspace_id, source_fact_id, allocation_set_id,
          event_type, event_sequence, revision, effective_at,
          supersedes_allocation_set_id, actor_id, recorded_at,
          temporal_sequence, activation_domain_command_hash,
          activation_request_hash, requested_by
        ) VALUES (?, ?, ?, ?, 'activated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`${input.allocationSetId}-act-${nextSequence}`,
          input.workspaceId, draft.sourceFactId, input.allocationSetId,
          nextSequence, nextSequence, activationStamp.recordedAt,
          head.activeAllocationSetId, input.activatedBy,
          activationStamp.recordedAt, activationStamp.temporalSequence,
          input.domainCommandHash, input.requestHash, input.activatedBy]
      );
      await connection.query(
        `INSERT INTO cash_settlement_source_heads (
          workspace_id, source_fact_id, active_allocation_set_id,
          revision, last_event_sequence
        ) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          active_allocation_set_id = VALUES(active_allocation_set_id),
          revision = VALUES(revision),
          last_event_sequence = VALUES(last_event_sequence)`,
        [input.workspaceId, draft.sourceFactId, input.allocationSetId,
          head.revision + 1, nextSequence]
      );
      await connection.query(
        `UPDATE cash_settlement_allocation_sets
         SET status = 'active', revision = ?, activated_by = ?,
           activated_at = ?
         WHERE workspace_id = ? AND id = ?`,
        [head.revision + 1, input.activatedBy, activationStamp.recordedAt,
          input.workspaceId, input.allocationSetId]
      );
      return (await this.get(input.workspaceId, input.allocationSetId))!;
    });
  }

  async findActivationByDomainCommandHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<CashSettlementAllocationSet | null> {
    const [rows] = await this.pool.query(
      `SELECT s.* FROM cash_settlement_allocation_lifecycle_events e
       JOIN cash_settlement_allocation_sets s
         ON s.id = e.allocation_set_id AND s.workspace_id = e.workspace_id
       WHERE e.workspace_id = ? AND e.activation_domain_command_hash = ?`,
      [workspaceId, domainCommandHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? this.withItems(workspaceId, settlementSet(row)) : null;
  }

  async listLifecycleEvents(
    workspaceId: string,
    sourceFactId: string
  ): Promise<CashSettlementAllocationLifecycleEvent[]> {
    const [rows] = await this.pool.query(
      `SELECT * FROM cash_settlement_allocation_lifecycle_events
       WHERE workspace_id = ? AND source_fact_id = ?
       ORDER BY event_sequence ASC`,
      [workspaceId, sourceFactId]
    );
    return (rows as MysqlRow[]).map(lifecycleEvent);
  }

  async activationCount(allocationSetId: string): Promise<number> {
    const [rows] = await this.pool.query(
      `SELECT COUNT(*) AS count FROM cash_settlement_allocation_lifecycle_events
       WHERE allocation_set_id = ? AND event_type = 'activated'`,
      [allocationSetId]
    );
    return Number((rows as Array<{ count: string }>)[0]?.count);
  }

  async listSets(workspaceId: string): Promise<CashSettlementAllocationSet[]> {
    const [rows] = await this.pool.query(
      `SELECT * FROM cash_settlement_allocation_sets
       WHERE workspace_id = ?`,
      [workspaceId]
    );
    return Promise.all((rows as MysqlRow[]).map((row) =>
      this.withItems(workspaceId, settlementSet(row))));
  }
}
