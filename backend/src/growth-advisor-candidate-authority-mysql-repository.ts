import type mysql from "mysql2/promise";
import {
  MysqlGrowthTemporalBarrier,
  MysqlGrowthTemporalTransaction,
  MysqlGrowthTemporalTransactionRunner,
  growthMysqlDate,
  growthMysqlInstant
} from "./growth-temporal-barrier-mysql-repository.js";
import {
  assertGrowthSealedReadCutoff,
  assertGrowthTemporalBarrier,
  type GrowthSealedReadCutoff,
  type GrowthTemporalBarrier
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  advisorAuthorityEventFromInput,
  type AdvisorAuthorityAppendStamp,
  type AdvisorCandidateAuthorityEvent,
  type AdvisorCandidateAuthorityProjectionInput,
  type AdvisorCandidateAuthorityRepository
} from "./growth-advisor-candidate-authority-projection.js";

type MysqlRow = Record<string, unknown>;

export const ADVISOR_CANDIDATE_AUTHORITY_MYSQL_SCHEMA_STATEMENTS =
  Object.freeze([
    `CREATE TABLE IF NOT EXISTS advisor_candidate_authority_events (
      workspace_id VARCHAR(191) NOT NULL,
      candidate_id VARCHAR(191) NOT NULL,
      event_sequence BIGINT UNSIGNED NOT NULL,
      id VARCHAR(255) NOT NULL,
      workspace_binding_revision VARCHAR(191) NOT NULL,
      recorded_at DATETIME(3) NOT NULL,
      temporal_sequence BIGINT UNSIGNED NOT NULL,
      owner_id VARCHAR(191) NOT NULL,
      team_id VARCHAR(191) NOT NULL,
      qualification_decision_id VARCHAR(191) NOT NULL,
      qualification_decision_version VARCHAR(191) NOT NULL,
      qualification_snapshot_hash CHAR(71) NOT NULL,
      financial_value_decision_id VARCHAR(191) NOT NULL,
      financial_value_decision_version VARCHAR(191) NOT NULL,
      financial_value_input_snapshot_hash CHAR(71) NOT NULL,
      grade VARCHAR(8) NOT NULL,
      score BIGINT NOT NULL,
      evidence_json JSON NOT NULL,
      PRIMARY KEY (workspace_id, candidate_id, event_sequence),
      UNIQUE KEY uk_advisor_authority_event_id (workspace_id, id),
      KEY ix_advisor_authority_time (workspace_id, recorded_at),
      CONSTRAINT chk_advisor_authority_workspace CHECK (
        workspace_id <> 'all' AND CHAR_LENGTH(TRIM(workspace_id)) > 0
      ),
      CONSTRAINT chk_advisor_authority_team CHECK (
        team_id <> 'all' AND CHAR_LENGTH(TRIM(team_id)) > 0
      )
    ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS advisor_candidate_authority_backfill_runs (
    run_key VARCHAR(64) PRIMARY KEY,
    run_hash CHAR(71) NOT NULL,
    cursor_value VARCHAR(64) NULL,
    updated_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB`
  ] as const);

export async function ensureAdvisorCandidateAuthorityMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  for (const statement of ADVISOR_CANDIDATE_AUTHORITY_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function authorityRow(row: MysqlRow): AdvisorCandidateAuthorityEvent {
  const evidence = JSON.parse(String(row.evidence_json)) as Array<{
    evidenceId: string;
    contentHash: string;
    fetchedAt: string;
  }>;
  return Object.freeze({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    workspaceBindingRevision: String(row.workspace_binding_revision),
    candidateId: String(row.candidate_id),
    eventSequence: Number(row.event_sequence),
    recordedAt: growthMysqlInstant(row.recorded_at),
    temporalSequence: Number(row.temporal_sequence),
    ownerId: String(row.owner_id),
    teamId: String(row.team_id),
    qualificationDecisionId: String(row.qualification_decision_id),
    qualificationDecisionVersion: String(
      row.qualification_decision_version
    ),
    qualificationSnapshotHash: String(
      row.qualification_snapshot_hash
    ) as `sha256:${string}`,
    financialValueDecisionId: String(row.financial_value_decision_id),
    financialValueDecisionVersion: String(
      row.financial_value_decision_version
    ),
    financialValueInputSnapshotHash: String(
      row.financial_value_input_snapshot_hash
    ) as `sha256:${string}`,
    grade: String(row.grade),
    score: Number(row.score),
    evidence: Object.freeze(evidence.map((item) =>
      Object.freeze({
        evidenceId: item.evidenceId,
        contentHash: item.contentHash,
        fetchedAt: item.fetchedAt
      })))
  });
}

function authorityValues(event: AdvisorCandidateAuthorityEvent) {
  return [
    event.workspaceId,
    event.candidateId,
    event.eventSequence,
    event.id,
    event.workspaceBindingRevision,
    growthMysqlDate(event.recordedAt),
    event.temporalSequence,
    event.ownerId,
    event.teamId,
    event.qualificationDecisionId,
    event.qualificationDecisionVersion,
    event.qualificationSnapshotHash,
    event.financialValueDecisionId,
    event.financialValueDecisionVersion,
    event.financialValueInputSnapshotHash,
    event.grade,
    event.score,
    JSON.stringify(event.evidence)
  ];
}

export class MysqlAdvisorCandidateAuthorityRepository
implements AdvisorCandidateAuthorityRepository {
  private readonly transactions: MysqlGrowthTemporalTransactionRunner;
  private readonly barrier: GrowthTemporalBarrier;

  constructor(
    private readonly pool: mysql.Pool,
    temporalBarrier?: GrowthTemporalBarrier
  ) {
    this.transactions = new MysqlGrowthTemporalTransactionRunner(pool);
    this.barrier = temporalBarrier
      ? assertGrowthTemporalBarrier(temporalBarrier)
      : new MysqlGrowthTemporalBarrier(this.transactions);
  }

  async append(
    input: AdvisorCandidateAuthorityProjectionInput
  ): Promise<AdvisorCandidateAuthorityEvent> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const event = await this.insertWithinConnection(
        connection, input
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

  /** Inserts one authority event on an already-open connection/transaction.
   *  The caller (acquisition qualification bundle) holds the workspace
   *  temporal barrier and the per-candidate guard; this helper only persists
   *  the row with the caller-allocated stamp. */
  async insertWithinConnection(
    connection: mysql.PoolConnection,
    input: AdvisorCandidateAuthorityProjectionInput
  ): Promise<AdvisorCandidateAuthorityEvent> {
    const temporal = new MysqlGrowthTemporalTransaction(connection);
    const stamp = await this.barrier.allocateAppend(
      temporal, input.workspaceId
    );
    return this.insertWithStamp(connection, input, stamp);
  }

  /** Persists a row using a caller-allocated stamp without allocating a new
   *  barrier tick. */
  async insertWithStamp(
    connection: mysql.PoolConnection,
    input: AdvisorCandidateAuthorityProjectionInput,
    stamp: AdvisorAuthorityAppendStamp
  ): Promise<AdvisorCandidateAuthorityEvent> {
    const [existingRows] = await connection.query(
      `SELECT * FROM advisor_candidate_authority_events
       WHERE workspace_id = ? AND candidate_id = ?
       ORDER BY event_sequence DESC LIMIT 1`,
      [input.workspaceId, input.candidateId]
    );
    const rows = existingRows as MysqlRow[];
    const eventSequence = rows.length > 0
      ? Number(rows[0]!.event_sequence) + 1
      : 1;
    const event = advisorAuthorityEventFromInput(
      input, stamp, eventSequence
    );
    await connection.query(
      `INSERT INTO advisor_candidate_authority_events
       (workspace_id, candidate_id, event_sequence, id,
        workspace_binding_revision, recorded_at, temporal_sequence,
        owner_id, team_id, qualification_decision_id,
        qualification_decision_version, qualification_snapshot_hash,
        financial_value_decision_id, financial_value_decision_version,
        financial_value_input_snapshot_hash, grade, score, evidence_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      authorityValues(event)
    );
    return event;
  }

  async getAt(
    workspaceId: string,
    candidateId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<AdvisorCandidateAuthorityEvent | null> {
    assertGrowthSealedReadCutoff(cutoff, workspaceId);
    const [rows] = await this.pool.query(
      `SELECT * FROM advisor_candidate_authority_events
       WHERE workspace_id = ? AND candidate_id = ?
         AND recorded_at <= ?
       ORDER BY event_sequence DESC LIMIT 1`,
      [workspaceId, candidateId, growthMysqlDate(cutoff.effectiveAsOf)]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? authorityRow(row) : null;
  }

  async listAt(
    workspaceId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<readonly AdvisorCandidateAuthorityEvent[]> {
    assertGrowthSealedReadCutoff(cutoff, workspaceId);
    const [rows] = await this.pool.query(
      `SELECT a.* FROM advisor_candidate_authority_events a
       INNER JOIN (
         SELECT candidate_id, MAX(event_sequence) AS latest_sequence
         FROM advisor_candidate_authority_events
         WHERE workspace_id = ? AND recorded_at <= ?
         GROUP BY candidate_id
       ) b ON b.candidate_id = a.candidate_id
         AND b.latest_sequence = a.event_sequence
       WHERE a.workspace_id = ?
       ORDER BY a.candidate_id ASC`,
      [workspaceId, growthMysqlDate(cutoff.effectiveAsOf), workspaceId]
    );
    return Object.freeze((rows as MysqlRow[]).map(authorityRow));
  }

  async seal(
    workspaceId: string,
    asOf: string
  ): Promise<GrowthSealedReadCutoff> {
    const context: ActiveWorkspaceContext = Object.freeze({
      workspaceId,
      kind: "team",
      actorId: "advisor",
      role: "admin",
      teamId: workspaceId,
      capabilities: Object.freeze([]),
      capabilityRegistryVersion: "growth-capabilities.v1"
    });
    return this.barrier.sealReadCutoff(context, asOf);
  }
}
