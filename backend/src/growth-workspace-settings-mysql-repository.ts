import type mysql from "mysql2/promise";
import {
  assertConcreteGrowthWorkspaceId,
  assertGrowthSealedReadCutoff,
  type GrowthSealedReadCutoff,
  type GrowthTemporalBarrier
} from "./growth-temporal-barrier.js";
import { MysqlGrowthTemporalTransaction, growthMysqlDate, growthMysqlInstant } from "./growth-temporal-barrier-mysql-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  GROWTH_WORKSPACE_SETTINGS_DEFAULT_RECORDED_AT,
  GROWTH_WORKSPACE_SETTINGS_DEFAULT_REVISION,
  GROWTH_WORKSPACE_SETTINGS_DEFAULT_TIME_ZONE,
  assertGrowthWorkspaceTimeZone,
  growthDefaultWorkspaceSettings,
  type GrowthTrustedWorkspaceSettingsAppender,
  type GrowthWorkspaceSettings,
  type GrowthWorkspaceSettingsReader
} from "./growth-workspace-settings.js";

type QuerySource = Pick<mysql.Pool | mysql.PoolConnection, "query">;
type MysqlRow = Record<string, unknown>;

export const GROWTH_WORKSPACE_SETTINGS_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS growth_workspace_settings_events (
    workspace_id VARCHAR(191) NOT NULL,
    event_sequence BIGINT UNSIGNED NOT NULL,
    revision VARCHAR(191) NOT NULL,
    time_zone VARCHAR(191) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, event_sequence),
    UNIQUE KEY uk_growth_workspace_settings_sequence
      (workspace_id, event_sequence),
    UNIQUE KEY uk_growth_workspace_settings_revision
      (workspace_id, revision),
    KEY idx_growth_workspace_settings_as_of
      (workspace_id, recorded_at, event_sequence),
    CONSTRAINT chk_growth_workspace_settings_workspace CHECK (
      workspace_id <> 'all' AND CHAR_LENGTH(TRIM(workspace_id)) > 0
    ),
    CONSTRAINT chk_growth_workspace_settings_sequence CHECK (
      event_sequence > 0
    )
  ) ENGINE=InnoDB`
] as const;

export async function ensureGrowthWorkspaceSettingsMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  for (const statement of GROWTH_WORKSPACE_SETTINGS_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function parseSettingsRow(row: MysqlRow): GrowthWorkspaceSettings {
  const timeZone = typeof row.time_zone === "string"
    ? assertGrowthWorkspaceTimeZone(row.time_zone)
    : (() => { throw new Error("invalid_workspace_time_zone"); })();
  const revision = typeof row.revision === "string" ? row.revision.trim() : "";
  const eventSequence = Number(row.event_sequence);
  if (!revision) throw new Error("invalid_workspace_settings_revision");
  if (!Number.isSafeInteger(eventSequence) || eventSequence < 1) {
    throw new Error("invalid_workspace_settings_event_sequence");
  }
  return Object.freeze({
    timeZone,
    revision,
    recordedAt: growthMysqlInstant(row.recorded_at),
    eventSequence
  });
}

async function firstSettings(
  source: QuerySource,
  sql: string,
  values: unknown[]
) {
  const [rows] = await source.query(sql, values);
  const row = (rows as MysqlRow[])[0];
  return row ? parseSettingsRow(row) : growthDefaultWorkspaceSettings();
}

export class MysqlGrowthWorkspaceSettingsRepository
implements GrowthWorkspaceSettingsReader, GrowthTrustedWorkspaceSettingsAppender {
  constructor(
    private readonly pool: mysql.Pool,
    private readonly temporalBarrier: GrowthTemporalBarrier
  ) {}

  get(context: ActiveWorkspaceContext): Promise<GrowthWorkspaceSettings> {
    const workspaceId = assertConcreteGrowthWorkspaceId(context.workspaceId);
    return firstSettings(
      this.pool,
      `SELECT time_zone, revision, recorded_at, event_sequence
       FROM growth_workspace_settings_events
       WHERE workspace_id = ?
       ORDER BY recorded_at DESC, event_sequence DESC
       LIMIT 1`,
      [workspaceId]
    );
  }

  getAt(
    context: ActiveWorkspaceContext,
    cutoff: GrowthSealedReadCutoff
  ): Promise<GrowthWorkspaceSettings> {
    const workspaceId = assertConcreteGrowthWorkspaceId(context.workspaceId);
    const trustedCutoff = assertGrowthSealedReadCutoff(cutoff, workspaceId);
    return firstSettings(
      this.pool,
      `SELECT time_zone, revision, recorded_at, event_sequence
       FROM growth_workspace_settings_events
       WHERE workspace_id = ? AND recorded_at <= ?
       ORDER BY recorded_at DESC, event_sequence DESC
       LIMIT 1`,
      [workspaceId, growthMysqlDate(trustedCutoff.effectiveAsOf)]
    );
  }

  async appendTrustedSettingsEvent(
    workspaceId: string,
    input: Readonly<{ timeZone: string; revision: string }>
  ): Promise<GrowthWorkspaceSettings> {
    const concreteWorkspaceId = assertConcreteGrowthWorkspaceId(workspaceId);
    const timeZone = assertGrowthWorkspaceTimeZone(input.timeZone);
    const revision = input.revision.trim();
    if (!revision) throw new Error("invalid_workspace_settings_revision");
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const stamp = await this.temporalBarrier.allocateAppend(
        new MysqlGrowthTemporalTransaction(connection),
        concreteWorkspaceId
      );
      await connection.query(
        `INSERT IGNORE INTO growth_workspace_settings_events (
          workspace_id, event_sequence, revision, time_zone, recorded_at
        ) VALUES (?, 1, ?, ?, ?)`,
        [
          concreteWorkspaceId,
          GROWTH_WORKSPACE_SETTINGS_DEFAULT_REVISION,
          GROWTH_WORKSPACE_SETTINGS_DEFAULT_TIME_ZONE,
          growthMysqlDate(GROWTH_WORKSPACE_SETTINGS_DEFAULT_RECORDED_AT)
        ]
      );
      const [rows] = await connection.query(
        `SELECT event_sequence, revision
         FROM growth_workspace_settings_events
         WHERE workspace_id = ?
         ORDER BY event_sequence DESC
         LIMIT 1
         FOR UPDATE`,
        [concreteWorkspaceId]
      );
      const last = (rows as MysqlRow[])[0];
      const lastSequence = Number(last?.event_sequence);
      if (!Number.isSafeInteger(lastSequence) || lastSequence < 1) {
        throw new Error("invalid_workspace_settings_event_sequence");
      }
      const eventSequence = lastSequence + 1;
      const event = Object.freeze({
        timeZone,
        revision,
        recordedAt: stamp.recordedAt,
        eventSequence
      });
      await connection.query(
        `INSERT INTO growth_workspace_settings_events (
          workspace_id, event_sequence, revision, time_zone, recorded_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          concreteWorkspaceId,
          eventSequence,
          revision,
          timeZone,
          growthMysqlDate(stamp.recordedAt)
        ]
      );
      await connection.commit();
      return event;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
