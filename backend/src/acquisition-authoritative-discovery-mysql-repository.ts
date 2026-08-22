import type mysql from "mysql2/promise";
import type {
  AuthoritativeDiscoveryAppendInput,
  AuthoritativeDiscoveryProjectionRow,
  AuthoritativeDiscoveryProjectionWriter,
  AuthoritativeDiscoverySource
} from "./acquisition-authoritative-discovery-projection.js";
import type { ResolvedAcquisitionWorkspace } from "./growth-workspace-context.js";
import type { GrowthSealedReadCutoff } from "./growth-temporal-barrier.js";
import {
  type GrowthTemporalBarrier,
  type GrowthTemporalTransaction
} from "./growth-temporal-barrier.js";
import {
  growthMysqlDate,
  growthMysqlInstant,
  MysqlGrowthTemporalTransaction
} from "./growth-temporal-barrier-mysql-repository.js";
import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";

type MysqlRow = Record<string, unknown>;

export const AUTHORITATIVE_DISCOVERY_MYSQL_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS acquisition_authoritative_discovery_source_guards (
    workspace_id VARCHAR(191) NOT NULL,
    platform VARCHAR(64) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, platform)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_authoritative_discoveries (
    workspace_id VARCHAR(191) NOT NULL,
    platform VARCHAR(64) NOT NULL,
    event_id VARCHAR(128) NOT NULL,
    candidate_id VARCHAR(128) NOT NULL,
    owner_id VARCHAR(191) NOT NULL,
    discovered_at DATETIME(3) NOT NULL,
    source_recorded_at DATETIME(3) NOT NULL,
    source_temporal_sequence BIGINT UNSIGNED NOT NULL,
    origin ENUM('acquisition_run','candidate_ingestion') NOT NULL,
    canonical_subject_material JSON NOT NULL,
    attribution_snapshot JSON NOT NULL,
    payload_hash CHAR(71) NOT NULL,
    PRIMARY KEY (workspace_id, platform, event_id),
    KEY idx_authoritative_discovery_page
      (workspace_id, platform, source_recorded_at, event_id),
    KEY idx_authoritative_discovery_window
      (workspace_id, platform, discovered_at, source_recorded_at, event_id)
  ) ENGINE=InnoDB`
] as const);

export async function ensureAuthoritativeDiscoveryMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  for (const statement of AUTHORITATIVE_DISCOVERY_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function row(row: MysqlRow): AuthoritativeDiscoveryProjectionRow {
  return Object.freeze({
    eventId: String(row.event_id),
    platform: String(row.platform),
    candidateId: String(row.candidate_id),
    ownerId: String(row.owner_id),
    discoveredAt: growthMysqlInstant(row.discovered_at),
    sourceRecordedAt: growthMysqlInstant(row.source_recorded_at),
    sourceTemporalSequence: Number(row.source_temporal_sequence),
    origin: String(row.origin) as "acquisition_run" | "candidate_ingestion",
    material: jsonValue(
      row.canonical_subject_material
    ) as AuthoritativeDiscoveryAppendInput["material"],
    attribution: jsonValue(
      row.attribution_snapshot
    ) as AuthoritativeDiscoveryAppendInput["attribution"],
    payloadHash: String(row.payload_hash) as `sha256:${string}`,
    workspaceId: String(row.workspace_id)
  });
}

export interface AuthoritativeDiscoveryProjectionTransaction
extends GrowthTemporalTransaction {
  lockDiscoverySourceGuardForUpdate(
    workspaceId: string,
    platform: string
  ): Promise<void>;
  appendAuthoritativeDiscovery(
    row: AuthoritativeDiscoveryProjectionRow
  ): Promise<"inserted" | "replayed">;
}

function buildTransaction(
  connection: mysql.PoolConnection
): AuthoritativeDiscoveryProjectionTransaction {
  const temporal = new MysqlGrowthTemporalTransaction(connection);
  return {
    lockWorkspaceTemporalBarrierForUpdate: (workspaceId) =>
      temporal.lockWorkspaceTemporalBarrierForUpdate(workspaceId),
    currentTimestamp3: () => temporal.currentTimestamp3(),
    saveWorkspaceTemporalBarrier: (...args) =>
      temporal.saveWorkspaceTemporalBarrier(...args),
    lockDiscoverySourceGuardForUpdate: async (workspaceId, platform) => {
      await connection.query(
        `INSERT INTO acquisition_authoritative_discovery_source_guards
           (workspace_id, platform) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE workspace_id = VALUES(workspace_id)`,
        [workspaceId, platform]
      );
      await connection.query(
        `SELECT revision FROM acquisition_authoritative_discovery_source_guards
         WHERE workspace_id = ? AND platform = ? FOR UPDATE`,
        [workspaceId, platform]
      );
    },
    appendAuthoritativeDiscovery: async (discovery) => {
      const [rows] = await connection.query(
        `SELECT * FROM acquisition_authoritative_discoveries
         WHERE workspace_id = ? AND platform = ? AND event_id = ?`,
        [discovery.workspaceId, discovery.platform, discovery.eventId]
      );
      const existing = (rows as MysqlRow[])[0];
      if (existing) {
        const previous = row(existing);
        if (canonicalJsonStringify(previous)
          !== canonicalJsonStringify(discovery)) {
          throw new Error("authoritative_discovery_payload_conflict");
        }
        return "replayed";
      }
      await connection.query(
        `INSERT INTO acquisition_authoritative_discoveries (
          workspace_id, platform, event_id, candidate_id, owner_id,
          discovered_at, source_recorded_at, source_temporal_sequence,
          origin, canonical_subject_material, attribution_snapshot,
          payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [discovery.workspaceId, discovery.platform, discovery.eventId,
          discovery.candidateId, discovery.ownerId,
          growthMysqlDate(discovery.discoveredAt),
          growthMysqlDate(discovery.sourceRecordedAt),
          discovery.sourceTemporalSequence, discovery.origin,
          JSON.stringify(discovery.material),
          JSON.stringify(discovery.attribution),
          discovery.payloadHash]
      );
      return "inserted";
    }
  };
}

export class MysqlAuthoritativeDiscoveryProjectionRepository
implements AuthoritativeDiscoveryProjectionWriter, AuthoritativeDiscoverySource {
  constructor(
    private readonly pool: mysql.Pool,
    private readonly temporalBarrier: GrowthTemporalBarrier
  ) {}

  async appendBatchFirst(
    workspace: ResolvedAcquisitionWorkspace,
    events: readonly AuthoritativeDiscoveryAppendInput[]
  ): Promise<readonly AuthoritativeDiscoveryProjectionRow[]> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const tx = buildTransaction(connection);
      const sorted = [...events].sort((left, right) =>
        left.platform.localeCompare(right.platform)
        || left.eventId.localeCompare(right.eventId));
      const stamps: Array<{ recordedAt: string; temporalSequence: number }> = [];
      for (const event of sorted) {
        const stamp = await this.temporalBarrier.allocateAppend(
          tx,
          workspace.workspaceId
        );
        stamps.push(stamp);
      }
      const appended: AuthoritativeDiscoveryProjectionRow[] = [];
      const platforms = [...new Set(sorted.map((event) => event.platform))]
        .sort();
      for (const platform of platforms) {
        await tx.lockDiscoverySourceGuardForUpdate(
          workspace.workspaceId, platform
        );
      }
      for (let index = 0; index < sorted.length; index += 1) {
        const event = sorted[index]!;
        const stamp = stamps[index]!;
        const discovery: AuthoritativeDiscoveryProjectionRow = Object.freeze({
          ...event,
          workspaceId: workspace.workspaceId,
          sourceRecordedAt: stamp.recordedAt,
          sourceTemporalSequence: stamp.temporalSequence
        });
        await tx.appendAuthoritativeDiscovery(discovery);
        appended.push(discovery);
      }
      await connection.commit();
      return appended;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async listDiscoveries(
    workspaceId: string,
    query: {
      platform: string;
      from: string;
      to: string;
      cutoff: GrowthSealedReadCutoff;
      after: { sourceRecordedAt: string; eventId: string } | null;
      limit: number;
    }
  ) {
    if (query.cutoff.workspaceId !== workspaceId) {
      throw new Error("sealed_cutoff_workspace_mismatch");
    }
    const params: unknown[] = [
      workspaceId, query.platform, growthMysqlDate(query.from),
      growthMysqlDate(query.to), growthMysqlDate(query.cutoff.effectiveAsOf)
    ];
    let cursor = "";
    if (query.after) {
      cursor = "AND (source_recorded_at > ? OR (source_recorded_at = ? AND event_id > ?))";
      params.push(
        growthMysqlDate(query.after.sourceRecordedAt),
        growthMysqlDate(query.after.sourceRecordedAt),
        query.after.eventId
      );
    }
    params.push(query.limit + 1);
    const [rows] = await this.pool.query(
      `SELECT * FROM acquisition_authoritative_discoveries
       WHERE workspace_id = ? AND platform = ?
         AND discovered_at >= ? AND discovered_at < ?
         AND source_recorded_at <= ?
         ${cursor}
       ORDER BY source_recorded_at ASC, event_id ASC
       LIMIT ?`,
      params
    );
    const items = (rows as MysqlRow[]).map(row);
    const hasMore = items.length > query.limit;
    const page = hasMore ? items.slice(0, query.limit) : items;
    return {
      items: page.map((item) => ({
        eventId: item.eventId,
        candidateId: item.candidateId,
        ownerId: item.ownerId,
        discoveredAt: item.discoveredAt,
        sourceRecordedAt: item.sourceRecordedAt,
        sourceTemporalSequence: item.sourceTemporalSequence,
        material: item.material,
        attribution: item.attribution
      })),
      next: hasMore && page.length > 0
        ? {
            sourceRecordedAt: page[page.length - 1]!.sourceRecordedAt,
            eventId: page[page.length - 1]!.eventId
          }
        : null
    };
  }

  async getWatermark(
    workspaceId: string,
    query: { platform: string; cutoff: GrowthSealedReadCutoff }
  ) {
    if (query.cutoff.workspaceId !== workspaceId) {
      throw new Error("sealed_cutoff_workspace_mismatch");
    }
    const [rows] = await this.pool.query(
      `SELECT event_id, source_recorded_at, source_temporal_sequence
       FROM acquisition_authoritative_discoveries
       WHERE workspace_id = ? AND platform = ?
         AND source_recorded_at <= ?
       ORDER BY source_recorded_at ASC, event_id ASC`,
      [workspaceId, query.platform,
        growthMysqlDate(query.cutoff.effectiveAsOf)]
    );
    const selected = rows as MysqlRow[];
    const last = selected.at(-1);
    return {
      lastSourceRecordedAt: last
        ? growthMysqlInstant(last.source_recorded_at) : null,
      lastEventId: last ? String(last.event_id) : null,
      lastSourceTemporalSequence: last
        ? Number(last.source_temporal_sequence) : null,
      eventCount: selected.length,
      eventSetHash: `sha256:${createHash("sha256")
        .update(selected.map((row) =>
          `${row.event_id}\u0000${row.source_recorded_at}`).join("\u001f"))
        .digest("hex")}` as `sha256:${string}`
    };
  }
}
