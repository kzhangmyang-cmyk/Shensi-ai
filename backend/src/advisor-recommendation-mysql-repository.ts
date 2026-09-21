import type mysql from "mysql2/promise";
import type {
  AdvisorRecommendation,
  AdvisorRecommendationEvent
} from "./advisor-recommendation-domain.js";
import {
  applyAdvisorTransition
} from "./advisor-recommendation-domain.js";
import type {
  AdvisorRecommendationRepository,
  CommandResult,
  CursorPage,
  AdvisorRecommendationListAtQuery
} from "./advisor-recommendation-repository.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { GrowthTemporalBarrier } from "./growth-temporal-barrier.js";
import {
  MysqlGrowthTemporalTransaction
} from "./growth-temporal-barrier-mysql-repository.js";

type MysqlRow = Record<string, unknown>;

export const ADVISOR_RECOMMENDATION_MYSQL_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS advisor_recommendations (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    audience_role VARCHAR(32) NOT NULL,
    type VARCHAR(32) NOT NULL,
    summary TEXT NOT NULL,
    rationale TEXT NOT NULL,
    metric_refs_json JSON NOT NULL,
    evidence_refs_json JSON NOT NULL,
    entity_refs_json JSON NOT NULL,
    confidence_bps BIGINT UNSIGNED NOT NULL,
    risk_level VARCHAR(16) NOT NULL,
    recommended_action_json JSON NOT NULL,
    status VARCHAR(16) NOT NULL,
    assigned_to VARCHAR(191) NULL,
    accepted_by VARCHAR(191) NULL,
    accepted_at DATETIME(3) NULL,
    outcome_refs_json JSON NOT NULL,
    data_as_of DATETIME(3) NOT NULL,
    input_snapshot_hash CHAR(71) NOT NULL,
    model_snapshot_ref VARCHAR(191) NOT NULL,
    prompt_version VARCHAR(64) NOT NULL,
    schema_version VARCHAR(64) NOT NULL,
    generation_idempotency_key VARCHAR(191) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_advisor_generation
      (workspace_id, generation_idempotency_key)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS advisor_recommendation_events (
    recommendation_id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    event_revision BIGINT UNSIGNED NOT NULL,
    event_type VARCHAR(16) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    actor_id VARCHAR(191) NOT NULL,
    aggregate_snapshot_hash CHAR(71) NOT NULL,
    aggregate_snapshot_json JSON NOT NULL,
    PRIMARY KEY (workspace_id, recommendation_id, event_revision),
    KEY ix_advisor_event_time (workspace_id, recorded_at)
  ) ENGINE=InnoDB`
] as const);

export async function ensureAdvisorRecommendationMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  for (const statement of ADVISOR_RECOMMENDATION_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function recommendation(row: MysqlRow): AdvisorRecommendation {
  return Object.freeze({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    revision: Number(row.revision),
    audienceRole: String(row.audience_role) as AdvisorRecommendation["audienceRole"],
    type: String(row.type) as AdvisorRecommendation["type"],
    summary: String(row.summary),
    rationale: String(row.rationale),
    metricRefs: jsonValue(row.metric_refs_json) as
      AdvisorRecommendation["metricRefs"],
    evidenceRefs: jsonValue(row.evidence_refs_json) as
      AdvisorRecommendation["evidenceRefs"],
    entityRefs: jsonValue(row.entity_refs_json) as
      AdvisorRecommendation["entityRefs"],
    confidenceBps: Number(row.confidence_bps),
    riskLevel: String(row.risk_level) as AdvisorRecommendation["riskLevel"],
    recommendedAction: jsonValue(row.recommended_action_json) as
      AdvisorRecommendation["recommendedAction"],
    status: String(row.status) as AdvisorRecommendation["status"],
    assignedTo: row.assigned_to === null ? null : String(row.assigned_to),
    acceptedBy: row.accepted_by === null ? null : String(row.accepted_by),
    acceptedAt: row.accepted_at === null ? null : String(row.accepted_at),
    outcomeRefs: jsonValue(row.outcome_refs_json) as
      AdvisorRecommendation["outcomeRefs"],
    dataAsOf: String(row.data_as_of),
    inputSnapshotHash: String(row.input_snapshot_hash) as `sha256:${string}`,
    modelSnapshotRef: String(row.model_snapshot_ref),
    promptVersion: String(row.prompt_version),
    schemaVersion: String(row.schema_version) as
      AdvisorRecommendation["schemaVersion"],
    generationIdempotencyKey: String(row.generation_idempotency_key),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  });
}

export class MysqlAdvisorRecommendationRepository
implements AdvisorRecommendationRepository {
  constructor(
    private readonly pool: mysql.Pool,
    private readonly barrier: GrowthTemporalBarrier
  ) {}

  async create(
    command: CommandContext,
    aggregate: AdvisorRecommendation
  ): Promise<CommandResult<AdvisorRecommendation>> {
    await this.transaction(async ({ connection, temporal }) => {
      const stamp = await this.barrier.allocateAppend(
        temporal, aggregate.workspaceId
      );
      await connection.query(
        `INSERT INTO advisor_recommendations (
          id, workspace_id, revision, audience_role, type, summary,
          rationale, metric_refs_json, evidence_refs_json, entity_refs_json,
          confidence_bps, risk_level, recommended_action_json, status,
          assigned_to, accepted_by, accepted_at, outcome_refs_json,
          data_as_of, input_snapshot_hash, model_snapshot_ref,
          prompt_version, schema_version, generation_idempotency_key,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [aggregate.id, aggregate.workspaceId, aggregate.revision,
          aggregate.audienceRole, aggregate.type, aggregate.summary,
          aggregate.rationale, JSON.stringify(aggregate.metricRefs),
          JSON.stringify(aggregate.evidenceRefs),
          JSON.stringify(aggregate.entityRefs), aggregate.confidenceBps,
          aggregate.riskLevel, JSON.stringify(aggregate.recommendedAction),
          aggregate.status, aggregate.assignedTo, aggregate.acceptedBy,
          aggregate.acceptedAt, JSON.stringify(aggregate.outcomeRefs),
          aggregate.dataAsOf, aggregate.inputSnapshotHash,
          aggregate.modelSnapshotRef, aggregate.promptVersion,
          aggregate.schemaVersion, aggregate.generationIdempotencyKey,
          aggregate.expiresAt, stamp.recordedAt, stamp.recordedAt]
      );
      await this.appendEvent(connection, aggregate, "created",
        command.actorId, stamp);
    });
    return { value: aggregate, replayed: false };
  }

  async findById(
    context: ActiveWorkspaceContext,
    id: string
  ): Promise<AdvisorRecommendation | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM advisor_recommendations
       WHERE workspace_id = ? AND id = ?`,
      [context.workspaceId, id]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? recommendation(row) : null;
  }

  async listAt(
    context: ActiveWorkspaceContext,
    query: AdvisorRecommendationListAtQuery
  ): Promise<CursorPage<AdvisorRecommendation>> {
    if (query.cutoff.workspaceId !== context.workspaceId) {
      throw new Error("sealed_cutoff_workspace_mismatch");
    }
    const statuses = query.status;
    const placeholders = statuses.map(() => "?").join(",");
    const [rows] = await this.pool.query(
      `SELECT e.aggregate_snapshot_json FROM advisor_recommendation_events e
       JOIN (
         SELECT recommendation_id, MAX(event_revision) AS event_revision
         FROM advisor_recommendation_events
         WHERE workspace_id = ? AND recorded_at <= ?
         GROUP BY recommendation_id
       ) latest ON latest.recommendation_id = e.recommendation_id
         AND latest.event_revision = e.event_revision
       WHERE e.workspace_id = ? AND e.recorded_at <= ?
         AND JSON_UNQUOTE(JSON_EXTRACT(e.aggregate_snapshot_json, '$.status'))
           IN (${placeholders})
       ORDER BY e.recorded_at ASC, e.recommendation_id ASC
       LIMIT ?`,
      [context.workspaceId, query.cutoff.effectiveAsOf, context.workspaceId,
        query.cutoff.effectiveAsOf, ...statuses, query.limit]
    );
    const items = (rows as MysqlRow[]).map((row) =>
      jsonValue(row.aggregate_snapshot_json) as AdvisorRecommendation);
    return {
      items,
      nextCursor: null,
      hasMore: items.length === query.limit
    };
  }

  async listExpirable(
    asOf: string,
    limit: number
  ): Promise<readonly AdvisorRecommendation[]> {
    const [rows] = await this.pool.query(
      `SELECT * FROM advisor_recommendations
       WHERE status IN ('proposed', 'accepted') AND expires_at <= ?
       ORDER BY expires_at ASC, id ASC LIMIT ?`,
      [asOf, limit]
    );
    return (rows as MysqlRow[]).map(recommendation);
  }

  async transition(
    command: CommandContext,
    input: {
      recommendationId: string;
      kind: "accept" | "ignore" | "complete" | "expire";
      reason: string | null;
    }
  ): Promise<CommandResult<AdvisorRecommendation>> {
    const next = await this.transaction(async ({ connection, temporal }) => {
      const stamp = await this.barrier.allocateAppend(
        temporal, command.workspace.workspaceId
      );
      const [rows] = await connection.query(
        `SELECT * FROM advisor_recommendations
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [command.workspace.workspaceId, input.recommendationId]
      );
      const row = (rows as MysqlRow[])[0];
      if (!row) throw new Error("advisor_recommendation_not_found");
      const current = recommendation(row);
      const transitioned = applyAdvisorTransition(
        current,
        {
          recommendationId: input.recommendationId,
          kind: input.kind,
          reason: input.reason
        },
        { actorId: command.actorId, occurredAt: stamp.recordedAt }
      );
      await connection.query(
        `UPDATE advisor_recommendations
         SET revision = ?, status = ?, accepted_by = ?, accepted_at = ?,
           updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
        [transitioned.revision, transitioned.status, transitioned.acceptedBy,
          transitioned.acceptedAt, stamp.recordedAt,
          command.workspace.workspaceId, input.recommendationId]
      );
      await this.appendEvent(connection, transitioned, input.kind,
        command.actorId, stamp);
      return transitioned;
    });
    return { value: next, replayed: false };
  }

  private async appendEvent(
    connection: mysql.PoolConnection,
    aggregate: AdvisorRecommendation,
    eventType: string,
    actorId: string,
    stamp: { recordedAt: string; temporalSequence: number }
  ): Promise<void> {
    const hash = `sha256:${aggregate.id}`;
    await connection.query(
      `INSERT INTO advisor_recommendation_events (
        recommendation_id, workspace_id, event_revision, event_type,
        recorded_at, temporal_sequence, actor_id, aggregate_snapshot_hash,
        aggregate_snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [aggregate.id, aggregate.workspaceId, aggregate.revision, eventType,
        stamp.recordedAt, stamp.temporalSequence, actorId, hash,
        JSON.stringify(aggregate)]
    );
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
}
