import type mysql from "mysql2/promise";
import {
  MysqlGrowthTemporalTransaction,
  growthMysqlDate,
  growthMysqlInstant
} from "./growth-temporal-barrier-mysql-repository.js";
import {
  assertConcreteGrowthWorkspaceId,
  assertGrowthTemporalBarrier,
  type GrowthTemporalBarrier
} from "./growth-temporal-barrier.js";
import {
  normalizeProbabilityAssessment,
  assertProbabilityAssessmentReplay,
  probabilityAssessmentId,
  type ProbabilityAssessmentHash,
  type ProbabilityAssessmentPersistence,
  type ProbabilityAssessmentQualificationInput,
  type ProbabilityAssessmentV2
} from "./probability-assessment.js";

type MysqlRow = Record<string, unknown>;

export const PROBABILITY_ASSESSMENT_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS probability_assessments_v2 (
    workspace_id VARCHAR(191) NOT NULL,
    id VARCHAR(191) NOT NULL,
    candidate_id VARCHAR(191) NOT NULL,
    deal_id VARCHAR(191) NULL,
    close_probability_bps INT UNSIGNED NOT NULL,
    qualification_decision_id VARCHAR(191) NOT NULL,
    qualification_decision_version VARCHAR(191) NOT NULL,
    evidence_refs_json JSON NOT NULL,
    rule_version VARCHAR(191) NOT NULL,
    model_snapshot_ref VARCHAR(255) NULL,
    input_snapshot_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    assessed_at DATETIME(3) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    precision ENUM('bps') NOT NULL,
    deal_binding_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,
    PRIMARY KEY (workspace_id, id),
    UNIQUE KEY uk_probability_assessment_identity (
      workspace_id,candidate_id,qualification_decision_id,
      qualification_decision_version,input_snapshot_hash
    ),
    KEY idx_probability_assessment_candidate (
      workspace_id,candidate_id,temporal_sequence
    ),
    KEY idx_probability_assessment_deal (
      workspace_id,deal_id,temporal_sequence
    ),
    CONSTRAINT chk_probability_assessment_bps
      CHECK (close_probability_bps BETWEEN 0 AND 10000),
    CONSTRAINT chk_probability_assessment_workspace
      CHECK (workspace_id <> 'all' AND CHAR_LENGTH(TRIM(workspace_id)) > 0),
    CONSTRAINT chk_probability_assessment_evidence_json
      CHECK (JSON_VALID(evidence_refs_json))
  ) ENGINE=InnoDB`
] as const;

export async function ensureProbabilityAssessmentMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  for (const statement of PROBABILITY_ASSESSMENT_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function safeSequence(value: unknown): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("invalid_probability_assessment_sequence");
  }
  return sequence;
}

function parseEvidence(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("invalid_probability_assessment_evidence");
  }
  return parsed;
}

function parse(row: MysqlRow): ProbabilityAssessmentV2 {
  return normalizeProbabilityAssessment({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    candidateId: String(row.candidate_id),
    dealId: row.deal_id === null ? null : String(row.deal_id),
    closeProbabilityBps: Number(row.close_probability_bps),
    qualificationDecisionId: String(row.qualification_decision_id),
    qualificationDecisionVersion: String(row.qualification_decision_version),
    evidenceRefs: parseEvidence(row.evidence_refs_json),
    ruleVersion: String(row.rule_version),
    modelSnapshotRef: row.model_snapshot_ref === null
      ? null : String(row.model_snapshot_ref),
    inputSnapshotHash: String(row.input_snapshot_hash) as ProbabilityAssessmentHash,
    assessedAt: growthMysqlInstant(row.assessed_at),
    recordedAt: growthMysqlInstant(row.recorded_at),
    temporalSequence: safeSequence(row.temporal_sequence),
    precision: String(row.precision) as "bps"
  });
}

export class MysqlProbabilityAssessmentRepository
implements ProbabilityAssessmentPersistence {
  private readonly temporalBarrier: GrowthTemporalBarrier;

  constructor(
    private readonly pool: mysql.Pool,
    temporalBarrier: GrowthTemporalBarrier
  ) {
    this.temporalBarrier = assertGrowthTemporalBarrier(temporalBarrier);
  }

  private async transaction<T>(work: (
    connection: mysql.PoolConnection,
    transaction: MysqlGrowthTemporalTransaction
  ) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(
        connection,
        new MysqlGrowthTemporalTransaction(connection)
      );
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async append(record: ProbabilityAssessmentV2) {
    const candidate = normalizeProbabilityAssessment(record);
    return this.transaction(async (connection, transaction) => {
      const stamp = await this.temporalBarrier.allocateAppend(
        transaction,
        candidate.workspaceId
      );
      const [existingRows] = await connection.query(
        `SELECT * FROM probability_assessments_v2
         WHERE workspace_id = ? AND candidate_id = ?
           AND qualification_decision_id = ?
           AND qualification_decision_version = ?
           AND input_snapshot_hash = ? FOR UPDATE`,
        [candidate.workspaceId, candidate.candidateId,
          candidate.qualificationDecisionId,
          candidate.qualificationDecisionVersion,
          candidate.inputSnapshotHash]
      );
      const existing = (existingRows as MysqlRow[])[0];
      if (existing) return assertProbabilityAssessmentReplay(
        parse(existing),
        candidate
      );
      const stored = normalizeProbabilityAssessment({ ...candidate, ...stamp });
      await connection.query(
        `INSERT INTO probability_assessments_v2 (
          workspace_id,id,candidate_id,deal_id,close_probability_bps,
          qualification_decision_id,qualification_decision_version,
          evidence_refs_json,rule_version,model_snapshot_ref,input_snapshot_hash,
          assessed_at,recorded_at,temporal_sequence,precision,deal_binding_hash
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
        [stored.workspaceId, stored.id, stored.candidateId, stored.dealId,
          stored.closeProbabilityBps, stored.qualificationDecisionId,
          stored.qualificationDecisionVersion, JSON.stringify(stored.evidenceRefs),
          stored.ruleVersion, stored.modelSnapshotRef, stored.inputSnapshotHash,
          growthMysqlDate(stored.assessedAt), growthMysqlDate(stored.recordedAt),
          stored.temporalSequence, stored.precision]
      );
      return stored;
    });
  }

  recordFromQualification(input: ProbabilityAssessmentQualificationInput) {
    return this.append({
      id: probabilityAssessmentId(input), workspaceId: input.workspaceId,
      candidateId: input.candidateId, dealId: input.dealId,
      closeProbabilityBps: input.financial.closeProbabilityBps,
      qualificationDecisionId: input.qualificationDecisionId,
      qualificationDecisionVersion: input.qualificationDecisionVersion,
      evidenceRefs: input.evidenceRefs, ruleVersion: input.ruleVersion,
      modelSnapshotRef: input.modelSnapshotRef,
      inputSnapshotHash: input.qualificationInputHash,
      assessedAt: input.assessedAt, recordedAt: input.assessedAt,
      temporalSequence: 1, precision: "bps"
    });
  }

  async findCurrent(workspaceId: string, candidateId: string, dealId?: string) {
    const values: unknown[] = [
      assertConcreteGrowthWorkspaceId(workspaceId), candidateId
    ];
    const deal = dealId === undefined ? "" : " AND deal_id = ?";
    if (dealId !== undefined) values.push(dealId);
    const [rows] = await this.pool.query(
      `SELECT * FROM probability_assessments_v2
       WHERE workspace_id = ? AND candidate_id = ?${deal}
       ORDER BY temporal_sequence DESC,id DESC LIMIT 1`,
      values
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parse(row) : null;
  }

  async bindDeal(
    workspaceId: string,
    id: string,
    dealId: string,
    bindingHash: ProbabilityAssessmentHash
  ) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    if (!id.trim()) {
      throw Object.assign(new Error("invalid_probability_assessment_id"), {
        code: "invalid_probability_assessment_id"
      });
    }
    if (!dealId.trim()) {
      throw Object.assign(new Error("invalid_probability_assessment_deal"), {
        code: "invalid_probability_assessment_deal"
      });
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(bindingHash)) {
      throw Object.assign(new Error("invalid_probability_assessment_hash"), {
        code: "invalid_probability_assessment_hash"
      });
    }
    return this.transaction(async (connection, transaction) => {
      const stamp = await this.temporalBarrier.allocateAppend(
        transaction,
        workspace
      );
      const [rows] = await connection.query(
        `SELECT * FROM probability_assessments_v2
         WHERE workspace_id = ? AND id = ? FOR UPDATE`,
        [workspace, id]
      );
      const row = (rows as MysqlRow[])[0];
      if (!row) throw new Error("probability_assessment_not_found");
      if (row.deal_id !== null) {
        if (String(row.deal_id) === dealId
          && String(row.deal_binding_hash) === bindingHash) return parse(row);
        throw new Error("probability_assessment_deal_already_bound");
      }
      await connection.query(
        `UPDATE probability_assessments_v2
         SET deal_id = ?, deal_binding_hash = ?, recorded_at = ?,
             temporal_sequence = ?
         WHERE workspace_id = ? AND id = ? AND deal_id IS NULL`,
        [dealId, bindingHash, growthMysqlDate(stamp.recordedAt),
          stamp.temporalSequence, workspace, id]
      );
      return parse({ ...row, deal_id: dealId, deal_binding_hash: bindingHash,
        recorded_at: stamp.recordedAt,
        temporal_sequence: stamp.temporalSequence });
    });
  }
}
