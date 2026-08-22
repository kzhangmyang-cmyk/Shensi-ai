import type mysql from "mysql2/promise";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  FINANCIAL_COUNCIL_RUN_STATUSES,
  applyFinancialCouncilTransition,
  createFinancialCouncilRunEvent,
  financialCouncilAggregateHash,
  financialCouncilCanonicalJson,
  financialCouncilCanonicalHash,
  financialCouncilError,
  financialCouncilTransitionIsAllowed,
  immutableFinancialCouncilValue,
  type FinancialCouncilRun,
  type FinancialCouncilRunEvent,
  type FinancialCouncilTransitionKind,
  type FinancialSnapshotRecord
} from "./financial-council-domain.js";
import {
  assertFinancialSnapshotRecord,
  assertFinancialSnapshotFreezeTime,
  assertFinancialCouncilRunHistory,
  assertFinancialCouncilRunValue,
  assertFinancialSnapshotRecordValue,
  validateFinancialCouncilCreateMutation,
  validateFinancialCouncilCreateAndFreezeMutation,
  validateListRunnableFinancialCouncilRunsInput,
  validateFinancialCouncilStoreSnapshotMutation,
  validateFinancialCouncilTransitionMutation,
  validateFinancialCouncilSpecialistResult,
  validateFinancialCouncilConsensusReport,
  createFinancialCouncilPortfolioRevision,
  financialCouncilActionEditIsSafe,
  financialCouncilPortfolioCommandKeyHash,
  financialCouncilOptimizationRunHash,
  selectFinancialCouncilOptimizationCandidates,
  type FinancialCouncilCommandResult,
  type CreateAndFreezeFinancialCouncilRunInput,
  type FinancialCouncilRepository,
  type FinancialCouncilFindingDisposition,
  type FinancialCouncilRebuttalAttempt,
  type InitialFinancialCouncilFindingDisposition,
  type CompleteFinancialCouncilRebuttalInput,
  type ClaimFinancialCouncilAnalysisRunInput,
  type FinancialCouncilAnalysisControl,
  type FinancialCouncilAnalysisGap,
  type FinancialCouncilAnalysisLease,
  type FinancialCouncilDispatchAction,
  type FinancialCouncilLeaseWrite,
  type FinancialCouncilPortfolioRevision,
  type CommitFinancialCouncilPortfolioRevisionInput,
  type CommitFinancialCouncilApprovalDecisionInput,
  type PublishFinancialCouncilPortfolioRevisionInput,
  type FinancialCouncilSpecialistPhase,
  type FinancialCouncilSpecialistResult,
  type ListRunnableFinancialCouncilRunsInput,
  type StoreFrozenFinancialSnapshotInput,
  type TransitionFinancialCouncilRunInput,
  type VerifiedFinancialCouncilRunSnapshot
} from "./financial-council-repository.js";
import {
  assertFinancialCouncilApprovalRecord,
  createFinancialCouncilDispatchOutboxRows,
  type FinancialCouncilApprovalRecord,
  type FinancialCouncilDispatchOutboxRow
} from "./financial-council-approval.js";
import {
  claimFinancialCouncilDispatchOperation,
  completeFinancialCouncilDispatchOperation,
  createFinancialCouncilDispatchOperation,
  failFinancialCouncilDispatchOperation,
  type ClaimFinancialCouncilDispatchOperationInput,
  type FinancialCouncilDispatchLease,
  type FinancialCouncilDispatchOperation,
  type FinancialCouncilDispatchReceipt
} from "./financial-council-dispatch-operation.js";
import { MysqlGrowthTemporalTransaction } from
  "./growth-temporal-barrier-mysql-repository.js";
import type { FinancialCouncilAuditGraph } from
  "./financial-council-audit.js";
import {
  assertFinancialCouncilSpecialistResultAuthorized,
  type AuthorizedFinancialCouncilSpecialistResult
} from "./financial-council-finding-validator.js";
import { validateFinancialSnapshotForRun } from
  "./financial-council-snapshot.js";
import type {
  ConsensusReport,
  FinancialCouncilAgentRole,
  FinancialCouncilCandidateAction
} from "./growth-contract-types.js";
import type { FinancialCouncilRebutInput } from
  "./financial-council-model-port.js";

type MysqlRow = Record<string, unknown>;

export const FINANCIAL_COUNCIL_MYSQL_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS financial_council_runs (
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    creation_key_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    status VARCHAR(32) NOT NULL,
    snapshot_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    snapshot_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,
    run_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (workspace_id, run_id),
    UNIQUE KEY uk_financial_council_creation
      (workspace_id, creation_key_hash),
    CONSTRAINT chk_financial_council_run_json CHECK (JSON_VALID(run_json)),
    CONSTRAINT chk_financial_council_run_status CHECK (status IN
      ('created','snapshot_frozen','analyzing','auditing','synthesizing',
       'optimizing','awaiting_approval','approved','rejected','stale','expired',
       'failed','not_computable'))
  ) ENGINE=InnoDB`,
  `ALTER TABLE financial_council_runs
     DROP CHECK chk_financial_council_run_status,
     ADD CONSTRAINT chk_financial_council_run_status CHECK (status IN
       ('created','snapshot_frozen','analyzing','auditing','synthesizing',
        'optimizing','awaiting_approval','approved','rejected','stale','expired',
        'failed','not_computable'))`,
  `CREATE TABLE IF NOT EXISTS financial_council_run_events (
    event_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    from_status VARCHAR(32) NULL,
    to_status VARCHAR(32) NOT NULL,
    reason_code VARCHAR(200) NULL,
    occurred_at DATETIME(3) NOT NULL,
    actor_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    aggregate_snapshot_hash CHAR(71)
      CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    aggregate_snapshot_json LONGTEXT
      CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (workspace_id, run_id, revision),
    UNIQUE KEY uk_financial_council_event_id (workspace_id, event_id),
    CONSTRAINT fk_financial_council_event_run
      FOREIGN KEY (workspace_id, run_id)
      REFERENCES financial_council_runs (workspace_id, run_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_council_event_json
      CHECK (JSON_VALID(aggregate_snapshot_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_council_snapshots (
    snapshot_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    snapshot_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    snapshot_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, snapshot_id),
    UNIQUE KEY uk_financial_council_snapshot_run (workspace_id, run_id),
    CONSTRAINT fk_financial_council_snapshot_run
      FOREIGN KEY (workspace_id, run_id)
      REFERENCES financial_council_runs (workspace_id, run_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_council_snapshot_json
      CHECK (JSON_VALID(snapshot_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_council_specialist_results (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    role VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    phase VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    result_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    snapshot_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    snapshot_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    result_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    result_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, run_id, role, phase),
    UNIQUE KEY uk_financial_council_specialist_result_id
      (workspace_id, result_id),
    CONSTRAINT fk_financial_council_specialist_run
      FOREIGN KEY (workspace_id, run_id)
      REFERENCES financial_council_runs (workspace_id, run_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_financial_council_specialist_snapshot
      FOREIGN KEY (workspace_id, snapshot_id)
      REFERENCES financial_council_snapshots (workspace_id, snapshot_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_council_specialist_role CHECK
      (role IN ('finance','profit','cost','cashflow','tax')),
    CONSTRAINT chk_financial_council_specialist_phase CHECK
      (phase IN ('analyze','rebut')),
    CONSTRAINT chk_financial_council_specialist_json
      CHECK (JSON_VALID(result_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_council_findings (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    finding_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    role VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    phase VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    snapshot_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    finding_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (workspace_id, run_id, role, phase, finding_id),
    CONSTRAINT fk_financial_council_finding_result
      FOREIGN KEY (workspace_id, run_id, role, phase)
      REFERENCES financial_council_specialist_results
        (workspace_id, run_id, role, phase)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_council_finding_json
      CHECK (JSON_VALID(finding_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_council_candidate_actions (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    action_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    role VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    phase VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    snapshot_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    action_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (workspace_id, run_id, role, phase, action_id),
    CONSTRAINT fk_financial_council_action_result
      FOREIGN KEY (workspace_id, run_id, role, phase)
      REFERENCES financial_council_specialist_results
        (workspace_id, run_id, role, phase)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_council_action_json
      CHECK (JSON_VALID(action_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_council_audit_graphs (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    snapshot_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    snapshot_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    graph_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    graph_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    graph_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (workspace_id, run_id),
    UNIQUE KEY uk_financial_council_audit_graph (workspace_id, graph_id),
    CONSTRAINT fk_financial_council_audit_run FOREIGN KEY (workspace_id, run_id)
      REFERENCES financial_council_runs (workspace_id, run_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_council_audit_json CHECK (JSON_VALID(graph_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_council_rebuttal_attempts (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    role VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    round_number TINYINT UNSIGNED NOT NULL,
    attempt_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    input_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    attempt_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (workspace_id, run_id, role, round_number),
    UNIQUE KEY uk_financial_council_rebuttal_attempt (workspace_id, attempt_id),
    CONSTRAINT fk_financial_council_rebuttal_graph FOREIGN KEY (workspace_id, run_id)
      REFERENCES financial_council_audit_graphs (workspace_id, run_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_council_rebuttal_round CHECK (round_number = 1),
    CONSTRAINT chk_financial_council_rebuttal_status
      CHECK (status IN ('reserved','completed')),
    CONSTRAINT chk_financial_council_rebuttal_json CHECK (JSON_VALID(attempt_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_council_finding_dispositions (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    finding_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    role VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    disposition_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    disposition_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (workspace_id, run_id, finding_id),
    CONSTRAINT fk_financial_council_disposition_graph FOREIGN KEY (workspace_id, run_id)
      REFERENCES financial_council_audit_graphs (workspace_id, run_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_council_disposition_status
      CHECK (status IN ('unresolved','upheld','revised','withdrawn')),
    CONSTRAINT chk_financial_council_disposition_json
      CHECK (JSON_VALID(disposition_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_council_consensus_reports (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    snapshot_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    audit_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    report_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    report_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, run_id),
    UNIQUE KEY uk_financial_council_consensus_report
      (workspace_id, report_id),
    CONSTRAINT fk_financial_council_consensus_graph
      FOREIGN KEY (workspace_id, run_id)
      REFERENCES financial_council_audit_graphs (workspace_id, run_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_council_consensus_json
      CHECK (JSON_VALID(report_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_council_portfolio_revisions (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    revision_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    run_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    snapshot_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    snapshot_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    audit_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    policy_version_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    policy_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    consensus_report_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    candidate_set_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    output_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    revision_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, run_id, revision),
    UNIQUE KEY uk_financial_council_portfolio_revision
      (workspace_id, revision_id),
    CONSTRAINT fk_financial_council_portfolio_consensus
      FOREIGN KEY (workspace_id, run_id)
      REFERENCES financial_council_consensus_reports (workspace_id, run_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_council_portfolio_revision CHECK (revision >= 1),
    CONSTRAINT chk_financial_council_portfolio_json
      CHECK (JSON_VALID(revision_json))
  ) ENGINE=InnoDB`,
  `ALTER TABLE financial_council_portfolio_revisions
     DROP CHECK chk_financial_council_portfolio_revision,
     ADD CONSTRAINT chk_financial_council_portfolio_revision
       CHECK (revision >= 1)`,
  `CREATE TABLE IF NOT EXISTS financial_council_approvals (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    approval_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    approval_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    command_key_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    command_request_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    approval_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    approved_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, run_id),
    UNIQUE KEY uk_financial_council_approval_id (workspace_id, approval_id),
    UNIQUE KEY uk_financial_council_approval_command
      (workspace_id, command_key_hash),
    CONSTRAINT fk_financial_council_approval_run
      FOREIGN KEY (workspace_id, run_id)
      REFERENCES financial_council_runs (workspace_id, run_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_council_approval_json
      CHECK (JSON_VALID(approval_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_council_dispatch_outbox (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    dispatch_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    approval_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    dispatch_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, dispatch_id),
    UNIQUE KEY uk_financial_council_dispatch_action
      (workspace_id, approval_id, action_id),
    CONSTRAINT fk_financial_council_dispatch_approval
      FOREIGN KEY (workspace_id, run_id)
      REFERENCES financial_council_approvals (workspace_id, run_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_council_dispatch_status
      CHECK (status IN ('queued')),
    CONSTRAINT chk_financial_council_dispatch_json
      CHECK (JSON_VALID(dispatch_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_council_dispatch_operations (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    dispatch_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    attempt BIGINT UNSIGNED NOT NULL,
    lease_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    lease_expires_at DATETIME(3) NULL,
    operation_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    receipt_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    PRIMARY KEY (workspace_id, dispatch_id),
    CONSTRAINT fk_financial_council_dispatch_operation_outbox
      FOREIGN KEY (workspace_id, dispatch_id)
      REFERENCES financial_council_dispatch_outbox (workspace_id, dispatch_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_council_dispatch_operation_status CHECK
      (status IN ('queued','running','retry','succeeded','failed')),
    CONSTRAINT chk_financial_council_dispatch_operation_json CHECK (JSON_VALID(operation_json)),
    CONSTRAINT chk_financial_council_dispatch_receipt_json CHECK
      (receipt_json IS NULL OR JSON_VALID(receipt_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_council_analysis_controls (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    owner_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    team_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    lease_worker_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    lease_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    attempt BIGINT UNSIGNED NOT NULL DEFAULT 0,
    claimed_at DATETIME(3) NULL,
    lease_expires_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, run_id),
    CONSTRAINT fk_financial_council_analysis_control_run
      FOREIGN KEY (workspace_id, run_id)
      REFERENCES financial_council_runs (workspace_id, run_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_council_analysis_gaps (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    role VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    gap_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    gap_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, run_id, role),
    CONSTRAINT fk_financial_council_analysis_gap_control
      FOREIGN KEY (workspace_id, run_id)
      REFERENCES financial_council_analysis_controls (workspace_id, run_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_financial_council_analysis_gap_role
      CHECK (role IN ('profit','cost','tax')),
    CONSTRAINT chk_financial_council_analysis_gap_json CHECK (JSON_VALID(gap_json))
  ) ENGINE=InnoDB`
] as const);

const FINANCIAL_COUNCIL_SCHEMA_LOCK = "financial:council-schema:v1";
const HASH = /^sha256:[0-9a-f]{64}$/u;
const STATUSES = new Set<string>(FINANCIAL_COUNCIL_RUN_STATUSES);
const SPECIALIST_ROLES = new Set<string>([
  "finance", "profit", "cost", "cashflow", "tax"
]);
const SPECIALIST_PHASES = new Set<string>(["analyze", "rebut"]);
const EVENT_SELECT = `SELECT event_id, run_id, workspace_id, revision,
  from_status, to_status, reason_code,
  DATE_FORMAT(occurred_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS occurred_at,
  actor_id, aggregate_snapshot_hash, aggregate_snapshot_json
  FROM financial_council_run_events`;
const SNAPSHOT_SELECT = `SELECT snapshot_id, run_id, workspace_id,
  snapshot_hash, snapshot_json,
  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
  FROM financial_council_snapshots`;

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function poison(connection: mysql.PoolConnection): void {
  try {
    connection.destroy();
  } catch {
    // A poisoned MySQL session must never return to the pool.
  }
}

export async function ensureFinancialCouncilMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  const connection = await pool.getConnection();
  let acquired = false;
  let poisoned = false;
  try {
    try {
      const [rows] = await connection.query(
        "SELECT GET_LOCK(?, ?) AS lock_acquired",
        [FINANCIAL_COUNCIL_SCHEMA_LOCK, 30]
      );
      const row = Array.isArray(rows)
        ? rows[0] as MysqlRow | undefined
        : undefined;
      if (Number(row?.lock_acquired) !== 1) throw new Error();
      acquired = true;
    } catch {
      poison(connection);
      poisoned = true;
      throw codedError("financial_council_schema_lock_failed");
    }
    for (const statement of FINANCIAL_COUNCIL_MYSQL_SCHEMA_STATEMENTS) {
      await connection.query(statement);
    }
  } finally {
    if (acquired) {
      try {
        const [rows] = await connection.query(
          "SELECT RELEASE_LOCK(?) AS lock_released",
          [FINANCIAL_COUNCIL_SCHEMA_LOCK]
        );
        const row = Array.isArray(rows)
          ? rows[0] as MysqlRow | undefined
          : undefined;
        if (Number(row?.lock_released) !== 1) throw new Error();
      } catch {
        if (!poisoned) poison(connection);
        poisoned = true;
        throw codedError("financial_council_schema_lock_failed");
      }
    }
    if (!poisoned) connection.release();
  }
}

function integrity(): never {
  throw codedError("financial_council_mysql_integrity");
}

function canonical(value: unknown): string {
  return financialCouncilCanonicalJson(value);
}

function duplicateEntry(error: unknown): boolean {
  const value = error as { code?: unknown; errno?: unknown } | null;
  return value?.code === "ER_DUP_ENTRY" || value?.errno === 1062;
}

function transientCreateRace(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { errno?: unknown; code?: unknown };
  return candidate.errno === 1213 || candidate.errno === 1205
    || candidate.code === "ER_LOCK_DEADLOCK"
    || candidate.code === "ER_LOCK_WAIT_TIMEOUT";
}

function affectedRows(result: unknown): number {
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

function rowString(row: MysqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) integrity();
  return value;
}

function rowNullableString(row: MysqlRow, key: string): string | null {
  return row[key] === null ? null : rowString(row, key);
}

function rowInteger(row: MysqlRow, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 1) integrity();
  return value;
}

function parseAnalysisControl(row: MysqlRow): FinancialCouncilAnalysisControl {
  const workspaceId = rowString(row, "workspace_id");
  const runId = rowString(row, "run_id");
  const workerId = rowNullableString(row, "lease_worker_id");
  const leaseToken = rowNullableString(row, "lease_token");
  const attempt = Number(row.attempt);
  if (!Number.isSafeInteger(attempt) || attempt < 0) integrity();
  const claimedAt = row.claimed_at === null ? null : isoDate(row.claimed_at);
  const leaseExpiresAt = row.lease_expires_at === null
    ? null : isoDate(row.lease_expires_at);
  if ((workerId === null) !== (leaseToken === null)
    || (workerId === null) !== (claimedAt === null)
    || (workerId === null) !== (leaseExpiresAt === null)
    || (leaseToken !== null && !/^[0-9a-f]{64}$/u.test(leaseToken))) integrity();
  return immutableFinancialCouncilValue({
    workspaceId,
    runId,
    ownerId: rowString(row, "owner_id"),
    teamId: rowString(row, "team_id"),
    lease: workerId === null ? null : {
      workspaceId, runId, workerId, leaseToken: leaseToken!, attempt,
      claimedAt: claimedAt!, leaseExpiresAt: leaseExpiresAt!
    },
    createdAt: isoDate(row.created_at)
  });
}

function parseAnalysisGap(row: MysqlRow): FinancialCouncilAnalysisGap {
  const raw = jsonObject(row.gap_json) as unknown as FinancialCouncilAnalysisGap;
  const { gapHash: _hash, ...preimage } = raw;
  if (rowString(row, "workspace_id") !== raw.workspaceId
    || rowString(row, "run_id") !== raw.runId
    || rowString(row, "role") !== raw.role
    || rowString(row, "code") !== raw.code
    || rowString(row, "gap_hash") !== raw.gapHash
    || isoDate(row.created_at) !== raw.createdAt
    || raw.detail !== null
    || raw.gapHash !== financialCouncilCanonicalHash(preimage)) integrity();
  return immutableFinancialCouncilValue(raw);
}

function isoDate(value: unknown): string {
  const normalized = value instanceof Date
    ? value.toISOString()
    : typeof value === "string"
        && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
  if (typeof normalized !== "string") integrity();
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) integrity();
  return date.toISOString();
}

function sqlDate(value: string): string {
  const iso = isoDate(value);
  if (iso !== value) {
    throw financialCouncilError("financial_council_timestamp_invalid");
  }
  return iso.slice(0, 23).replace("T", " ");
}

function assertNoDuplicateJsonObjectKeys(value: unknown): void {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) return;
  const raw = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const stack: Array<
    | { type: "object"; keys: Set<string>; expectsKey: boolean }
    | { type: "array" }
  > = [];
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character === '"') {
      const start = index;
      let escaped = false;
      for (index += 1; index < raw.length; index += 1) {
        const nested = raw[index]!;
        if (escaped) escaped = false;
        else if (nested === "\\") escaped = true;
        else if (nested === '"') break;
      }
      if (index >= raw.length) integrity();
      const frame = stack.at(-1);
      if (frame?.type === "object" && frame.expectsKey) {
        const key = JSON.parse(raw.slice(start, index + 1)) as unknown;
        if (typeof key !== "string" || frame.keys.has(key)) integrity();
        frame.keys.add(key);
        let colon = index + 1;
        while (/\s/u.test(raw[colon] ?? "")) colon += 1;
        if (raw[colon] !== ":") integrity();
        frame.expectsKey = false;
      }
      continue;
    }
    if (character === "{") {
      stack.push({ type: "object", keys: new Set(), expectsKey: true });
    } else if (character === "[") {
      stack.push({ type: "array" });
    } else if (character === "}") {
      if (stack.pop()?.type !== "object") integrity();
    } else if (character === "]") {
      if (stack.pop()?.type !== "array") integrity();
    } else if (character === ",") {
      const frame = stack.at(-1);
      if (frame?.type === "object") frame.expectsKey = true;
    }
  }
  if (stack.length !== 0) integrity();
}

function jsonObject(value: unknown): Record<string, unknown> {
  try {
    assertNoDuplicateJsonObjectKeys(value);
    const parsed = Buffer.isBuffer(value)
      ? JSON.parse(value.toString("utf8"))
      : typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      integrity();
    }
    return parsed as Record<string, unknown>;
  } catch {
    integrity();
  }
}

function exactKeys(value: unknown, keys: readonly string[]):
asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\u0000")
      !== [...keys].sort().join("\u0000")) {
    integrity();
  }
}

const RUN_KEYS = [
  "runId", "workspaceId", "creationKeyHash", "requestHash", "currency",
  "status", "revision", "dataAsOf", "businessReport", "policyVersionId",
  "snapshotId", "snapshotHash", "consensusReport", "portfolios",
  "latestPortfolioRevision", "approval", "createdAt", "updatedAt", "expiresAt"
] as const;

function parseRun(row: MysqlRow): FinancialCouncilRun {
  try {
    const value = jsonObject(row.run_json);
    assertFinancialCouncilRunValue(value);
    exactKeys(value, RUN_KEYS);
    if (typeof value.runId !== "string" || !value.runId
      || typeof value.workspaceId !== "string" || !value.workspaceId
      || typeof value.creationKeyHash !== "string" || !HASH.test(value.creationKeyHash)
      || typeof value.requestHash !== "string" || !HASH.test(value.requestHash)
      || (value.currency !== "CNY" && value.currency !== "USD")
      || typeof value.status !== "string" || !STATUSES.has(value.status)
      || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
      || typeof value.dataAsOf !== "string" || isoDate(value.dataAsOf) !== value.dataAsOf
      || typeof value.policyVersionId !== "string" || !value.policyVersionId
      || (value.snapshotId !== null
        && (typeof value.snapshotId !== "string" || !value.snapshotId))
      || (value.snapshotHash !== null
        && (typeof value.snapshotHash !== "string" || !HASH.test(value.snapshotHash)))
      || (value.snapshotId === null) !== (value.snapshotHash === null)
      || typeof value.createdAt !== "string" || isoDate(value.createdAt) !== value.createdAt
      || typeof value.updatedAt !== "string" || isoDate(value.updatedAt) !== value.updatedAt
      || typeof value.expiresAt !== "string" || isoDate(value.expiresAt) !== value.expiresAt) {
      integrity();
    }
    const aggregate = immutableFinancialCouncilValue(value) as unknown as
      FinancialCouncilRun;
    if (aggregate.runId !== rowString(row, "run_id")
      || aggregate.workspaceId !== rowString(row, "workspace_id")
      || aggregate.creationKeyHash !== rowString(row, "creation_key_hash")
      || aggregate.requestHash !== rowString(row, "request_hash")
      || aggregate.revision !== rowInteger(row, "revision")
      || aggregate.status !== rowString(row, "status")
      || aggregate.snapshotId !== rowNullableString(row, "snapshot_id")
      || aggregate.snapshotHash !== rowNullableString(row, "snapshot_hash")) {
      integrity();
    }
    return aggregate;
  } catch {
    integrity();
  }
}

function parseEvent(row: MysqlRow): FinancialCouncilRunEvent {
  try {
    const aggregate = parseRun({
      run_json: row.aggregate_snapshot_json,
      run_id: row.run_id,
      workspace_id: row.workspace_id,
      creation_key_hash: jsonObject(row.aggregate_snapshot_json).creationKeyHash,
      request_hash: jsonObject(row.aggregate_snapshot_json).requestHash,
      revision: row.revision,
      status: row.to_status,
      snapshot_id: jsonObject(row.aggregate_snapshot_json).snapshotId,
      snapshot_hash: jsonObject(row.aggregate_snapshot_json).snapshotHash
    });
    const revision = rowInteger(row, "revision");
    const fromStatus = rowNullableString(row, "from_status");
    const toStatus = rowString(row, "to_status");
    const hash = rowString(row, "aggregate_snapshot_hash");
    const occurredAt = isoDate(row.occurred_at);
    if ((fromStatus !== null && !STATUSES.has(fromStatus))
      || !STATUSES.has(toStatus)
      || !HASH.test(hash)
      || rowString(row, "event_id") !== `${aggregate.runId}:${revision}`
      || aggregate.revision !== revision
      || aggregate.status !== toStatus
      || hash !== financialCouncilAggregateHash(aggregate)
      || (revision === 1) !== (fromStatus === null)) {
      integrity();
    }
    return immutableFinancialCouncilValue({
      eventId: rowString(row, "event_id"),
      runId: aggregate.runId,
      workspaceId: aggregate.workspaceId,
      revision,
      fromStatus: fromStatus as FinancialCouncilRunEvent["fromStatus"],
      toStatus: toStatus as FinancialCouncilRunEvent["toStatus"],
      reasonCode: rowNullableString(row, "reason_code"),
      occurredAt,
      actorId: rowString(row, "actor_id"),
      aggregateSnapshotHash: hash as `sha256:${string}`,
      aggregateSnapshot: aggregate
    });
  } catch {
    integrity();
  }
}

function parseSnapshot(row: MysqlRow): FinancialSnapshotRecord {
  try {
    const snapshot = jsonObject(row.snapshot_json);
    const snapshotId = rowString(row, "snapshot_id");
    const runId = rowString(row, "run_id");
    const workspaceId = rowString(row, "workspace_id");
    const snapshotHash = rowString(row, "snapshot_hash");
    const nestedHash = snapshot.snapshotHash;
    const { snapshotHash: _snapshotHash, ...preimage } = snapshot;
    if (!HASH.test(snapshotHash)
      || snapshot.snapshotId !== snapshotId
      || snapshot.runId !== runId
      || snapshot.workspaceId !== workspaceId
      || nestedHash !== snapshotHash
      || financialCouncilCanonicalHash(preimage) !== snapshotHash) {
      integrity();
    }
    const record = immutableFinancialCouncilValue({
      snapshotId,
      runId,
      workspaceId,
      snapshotHash: snapshotHash as `sha256:${string}`,
      snapshot,
      createdAt: isoDate(row.created_at)
    });
    assertFinancialSnapshotRecordValue(record);
    return record;
  } catch {
    integrity();
  }
}

function assertStoredSnapshot(
  run: FinancialCouncilRun,
  snapshot: FinancialSnapshotRecord,
  events: readonly FinancialCouncilRunEvent[]
): void {
  try {
    assertFinancialSnapshotRecord(run, snapshot);
    assertFinancialSnapshotFreezeTime(snapshot, events, integrity);
  } catch {
    integrity();
  }
}

function parseSpecialistResult(
  row: MysqlRow,
  findingRows: readonly MysqlRow[],
  actionRows: readonly MysqlRow[]
): FinancialCouncilSpecialistResult {
  try {
    const result = validateFinancialCouncilSpecialistResult(
      jsonObject(row.result_json)
    );
    if (result.workspaceId !== rowString(row, "workspace_id")
      || result.runId !== rowString(row, "run_id")
      || result.role !== rowString(row, "role")
      || result.phase !== rowString(row, "phase")
      || result.resultId !== rowString(row, "result_id")
      || result.snapshotId !== rowString(row, "snapshot_id")
      || result.snapshotHash !== rowString(row, "snapshot_hash")
      || result.resultHash !== rowString(row, "result_hash")
      || result.createdAt !== isoDate(row.created_at)) integrity();
    const findings = findingRows.map((findingRow) => {
      const value = jsonObject(findingRow.finding_json);
      if (rowString(findingRow, "workspace_id") !== result.workspaceId
        || rowString(findingRow, "run_id") !== result.runId
        || rowString(findingRow, "role") !== result.role
        || rowString(findingRow, "phase") !== result.phase
        || rowString(findingRow, "snapshot_id") !== result.snapshotId
        || rowString(findingRow, "finding_id") !== value.findingId) {
        integrity();
      }
      return value;
    }).sort((left, right) => Buffer.compare(
      Buffer.from(String(left.findingId), "utf8"),
      Buffer.from(String(right.findingId), "utf8")
    ));
    const actions = actionRows.map((actionRow) => {
      const value = jsonObject(actionRow.action_json);
      if (rowString(actionRow, "workspace_id") !== result.workspaceId
        || rowString(actionRow, "run_id") !== result.runId
        || rowString(actionRow, "role") !== result.role
        || rowString(actionRow, "phase") !== result.phase
        || rowString(actionRow, "snapshot_id") !== result.snapshotId
        || rowString(actionRow, "action_id") !== value.actionId) {
        integrity();
      }
      return value;
    }).sort((left, right) => Buffer.compare(
      Buffer.from(String(left.actionId), "utf8"),
      Buffer.from(String(right.actionId), "utf8")
    ));
    const expectedFindings = [...result.findings].sort((left, right) =>
      Buffer.compare(Buffer.from(left.findingId, "utf8"),
        Buffer.from(right.findingId, "utf8")));
    const expectedActions = [...result.actions].sort((left, right) =>
      Buffer.compare(Buffer.from(left.actionId, "utf8"),
        Buffer.from(right.actionId, "utf8")));
    if (canonical(findings) !== canonical(expectedFindings)
      || canonical(actions) !== canonical(expectedActions)) integrity();
    return result;
  } catch {
    integrity();
  }
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function rebuttalContentHash(input: FinancialCouncilRebutInput):
`sha256:${string}` {
  return financialCouncilCanonicalHash({
    allowlist: input.allowlist,
    businessData: input.businessData,
    targetFindingId: input.targetFindingId,
    conflictData: input.conflictData
  });
}

function parseAuditGraphRow(row: MysqlRow): FinancialCouncilAuditGraph {
  const rawGraph = jsonObject(row.graph_json);
  exactKeys(rawGraph, ["graphId", "workspaceId", "runId", "snapshotId",
    "snapshotHash", "edges", "graphHash"]);
  if (!Array.isArray(rawGraph.edges)) integrity();
  for (const edge of rawGraph.edges) exactKeys(edge, ["edgeId", "kind",
    "findingIds", "sharedRefs", "status", "validatorReason"]);
  const graph = immutableFinancialCouncilValue(rawGraph) as
    unknown as FinancialCouncilAuditGraph;
  const expectedHash = financialCouncilCanonicalHash({
    workspaceId: graph.workspaceId, runId: graph.runId,
    snapshotId: graph.snapshotId, snapshotHash: graph.snapshotHash,
    edges: graph.edges
  });
  if (rowString(row, "workspace_id") !== graph.workspaceId
    || rowString(row, "run_id") !== graph.runId
    || rowString(row, "snapshot_id") !== graph.snapshotId
    || rowString(row, "snapshot_hash") !== graph.snapshotHash
    || rowString(row, "graph_id") !== graph.graphId
    || rowString(row, "graph_hash") !== graph.graphHash
    || graph.graphId !== expectedHash || graph.graphHash !== expectedHash) {
    integrity();
  }
  return graph;
}

function parseRebuttalAttemptRow(row: MysqlRow):
FinancialCouncilRebuttalAttempt {
  const rawAttempt = jsonObject(row.attempt_json);
  exactKeys(rawAttempt, ["attemptId", "workspaceId", "runId", "snapshotId",
    "snapshotHash", "graphId", "role", "round", "edgeId",
    "targetFindingId", "inputHash", "input", "status", "result",
    "outputHash", "createdAt", "completedAt", "attemptHash"]);
  exactKeys(rawAttempt.input, ["ownerId", "teamId", "runId", "snapshotId",
    "snapshotHash", "role", "attempt", "allowlist", "businessData",
    "targetFindingId", "conflictData"]);
  exactKeys((rawAttempt.input as Record<string, unknown>).allowlist,
    ["evidenceRefIds", "formulaRefIds", "findingIds", "subjectRefs",
      "dataGapRefs"]);
  const attempt = immutableFinancialCouncilValue(rawAttempt) as unknown as
    FinancialCouncilRebuttalAttempt;
  const { attemptHash: _hash, ...preimage } = attempt;
  if (rowString(row, "workspace_id") !== attempt.workspaceId
    || rowString(row, "run_id") !== attempt.runId
    || rowString(row, "role") !== attempt.role
    || rowInteger(row, "round_number") !== attempt.round
    || rowString(row, "attempt_id") !== attempt.attemptId
    || rowString(row, "input_hash") !== attempt.inputHash
    || rowString(row, "status") !== attempt.status
    || attempt.round !== 1
    || attempt.inputHash !== financialCouncilCanonicalHash(attempt.input)
    || attempt.attemptHash !== financialCouncilCanonicalHash(preimage)) {
    integrity();
  }
  return attempt;
}

function parseDispositionRow(row: MysqlRow): FinancialCouncilFindingDisposition {
  const rawDisposition = jsonObject(row.disposition_json);
  exactKeys(rawDisposition, ["workspaceId", "runId", "snapshotId",
    "snapshotHash", "graphId", "findingId", "role", "status",
    "blockingConflictIds", "updatedAt", "dispositionHash"]);
  const disposition = immutableFinancialCouncilValue(rawDisposition) as
    unknown as FinancialCouncilFindingDisposition;
  const { dispositionHash: _hash, ...preimage } = disposition;
  if (rowString(row, "workspace_id") !== disposition.workspaceId
    || rowString(row, "run_id") !== disposition.runId
    || rowString(row, "finding_id") !== disposition.findingId
    || rowString(row, "role") !== disposition.role
    || rowString(row, "status") !== disposition.status
    || rowString(row, "disposition_hash") !== disposition.dispositionHash
    || disposition.dispositionHash !== financialCouncilCanonicalHash(preimage)) {
    integrity();
  }
  return disposition;
}

function parseConsensusRow(row: MysqlRow): ConsensusReport {
  const raw = jsonObject(row.report_json);
  exactKeys(raw, ["reportId", "runId", "snapshotId", "acceptedFindings",
    "minorityFindings", "rejectedFindings", "unresolvedConflicts",
    "dataGaps", "overallDiagnosis", "inputVersionHash", "createdAt"]);
  const report = immutableFinancialCouncilValue(raw) as unknown as
    ConsensusReport;
  if (rowString(row, "run_id") !== report.runId
    || rowString(row, "snapshot_id") !== report.snapshotId
    || rowString(row, "audit_hash") !== report.inputVersionHash
    || rowString(row, "report_id") !== report.reportId
    || isoDate(row.created_at) !== report.createdAt) integrity();
  return report;
}

function parsePortfolioRevision(row: MysqlRow): FinancialCouncilPortfolioRevision {
  try {
    const raw = jsonObject(row.revision_json) as unknown as
      FinancialCouncilPortfolioRevision;
    const { revisionId: _revisionId, outputHash: _outputHash, ...input } = raw;
    const revision = createFinancialCouncilPortfolioRevision(input);
    if (canonical(revision) !== canonical(raw)
      || revision.workspaceId !== rowString(row, "workspace_id")
      || revision.runId !== rowString(row, "run_id")
      || revision.revision !== rowInteger(row, "revision")
      || revision.revisionId !== rowString(row, "revision_id")
      || revision.runHash !== rowString(row, "run_hash")
      || revision.snapshotId !== rowString(row, "snapshot_id")
      || revision.snapshotHash !== rowString(row, "snapshot_hash")
      || revision.auditHash !== rowString(row, "audit_hash")
      || revision.policyVersionId !== rowString(row, "policy_version_id")
      || revision.policyHash !== rowString(row, "policy_hash")
      || revision.consensusReportId !== rowString(row, "consensus_report_id")
      || revision.candidateSetHash !== rowString(row, "candidate_set_hash")
      || revision.outputHash !== rowString(row, "output_hash")
      || revision.createdAt !== isoDate(row.created_at)) integrity();
    return revision;
  } catch {
    integrity();
  }
}

function parseApproval(row: MysqlRow): FinancialCouncilApprovalRecord {
  try {
    const approval = immutableFinancialCouncilValue(
      jsonObject(row.approval_json)
    ) as unknown as FinancialCouncilApprovalRecord;
    assertFinancialCouncilApprovalRecord(approval);
    if (approval.workspaceId !== rowString(row, "workspace_id")
      || approval.runId !== rowString(row, "run_id")
      || approval.approvalId !== rowString(row, "approval_id")
      || approval.approvalHash !== rowString(row, "approval_hash")
      || approval.commandKeyHash !== rowString(row, "command_key_hash")
      || approval.commandRequestHash !== rowString(row, "command_request_hash")
      || approval.approvedAt !== isoDate(row.approved_at)) integrity();
    return approval;
  } catch {
    integrity();
  }
}

function parseDispatch(row: MysqlRow): FinancialCouncilDispatchOutboxRow {
  try {
    const value = immutableFinancialCouncilValue(
      jsonObject(row.dispatch_json)
    ) as unknown as FinancialCouncilDispatchOutboxRow;
    if (value.workspaceId !== rowString(row, "workspace_id")
      || value.dispatchId !== rowString(row, "dispatch_id")
      || value.runId !== rowString(row, "run_id")
      || value.approvalId !== rowString(row, "approval_id")
      || value.actionId !== rowString(row, "action_id")
      || value.status !== "queued" || value.attempt !== 0
      || value.createdAt !== isoDate(row.created_at)
      || value.updatedAt !== isoDate(row.updated_at)) integrity();
    return value;
  } catch {
    integrity();
  }
}

function expectedRevision(command: CommandContext): number {
  return command.expectedRevision as number;
}

function runBeforePortfolioEditOverlay(
  run: FinancialCouncilRun,
  events: readonly FinancialCouncilRunEvent[]
): FinancialCouncilRun {
  const eventRun = events.at(-1)?.aggregateSnapshot;
  return eventRun?.status === "awaiting_approval"
    && run.status === "awaiting_approval"
    && eventRun.revision === run.revision
    && (run.latestPortfolioRevision ?? 0) > (eventRun.latestPortfolioRevision ?? 0)
    ? eventRun : run;
}

export class MysqlFinancialCouncilRepository
implements FinancialCouncilRepository {
  constructor(private readonly pool: mysql.Pool) {}

  async createAndFreezeRun(
    command: CommandContext,
    input: CreateAndFreezeFinancialCouncilRunInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>> {
    ({ command, input } = validateFinancialCouncilCreateAndFreezeMutation(
      command, input
    ));
    const { aggregate, snapshot, occurredAt } = input;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.transaction(async (connection) => {
        const existing = await this.readVerifiedFrozenByCreationKey(
          connection, aggregate.workspaceId, aggregate.creationKeyHash,
          aggregate.requestHash, true
        );
        if (existing) return { value: existing, replayed: true };
        const created = immutableFinancialCouncilValue(aggregate);
        const withSnapshot = immutableFinancialCouncilValue({
          ...created,
          snapshotId: snapshot.snapshotId,
          snapshotHash: snapshot.snapshotHash
        });
        const frozen = applyFinancialCouncilTransition(withSnapshot, {
          kind: "snapshot_frozen", occurredAt, actorId: command.actorId
        });
        await connection.query(
          `INSERT INTO financial_council_runs (
             run_id, workspace_id, creation_key_hash, request_hash, revision,
             status, snapshot_id, snapshot_hash, run_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [frozen.runId, frozen.workspaceId, frozen.creationKeyHash,
            frozen.requestHash, frozen.revision, frozen.status,
            frozen.snapshotId, frozen.snapshotHash, canonical(frozen)]
        );
        await this.appendEvent(connection, createFinancialCouncilRunEvent(
          created, {
            fromStatus: null, reasonCode: null,
            occurredAt: created.createdAt, actorId: command.actorId
          }
        ));
        await connection.query(
          `INSERT INTO financial_council_snapshots (
             snapshot_id, run_id, workspace_id, snapshot_hash, snapshot_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          [snapshot.snapshotId, snapshot.runId, snapshot.workspaceId,
            snapshot.snapshotHash, canonical(snapshot.snapshot),
            sqlDate(snapshot.createdAt)]
        );
        await connection.query(
          `INSERT INTO financial_council_analysis_controls (
             workspace_id, run_id, owner_id, team_id, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
          [frozen.workspaceId, frozen.runId, command.actorId,
            command.workspace.teamId, sqlDate(occurredAt)]
        );
        await this.appendEvent(connection, createFinancialCouncilRunEvent(
          frozen, {
            fromStatus: "created", reasonCode: null,
            occurredAt, actorId: command.actorId
          }
        ));
        return { value: frozen, replayed: false };
        });
      } catch (error) {
        if (transientCreateRace(error)) {
          const existing = await this.transaction((connection) =>
            this.readVerifiedFrozenByCreationKey(
              connection, aggregate.workspaceId, aggregate.creationKeyHash,
              aggregate.requestHash, false
            ), true
          );
          if (existing) return { value: existing, replayed: true };
          if (attempt < 3) continue;
        }
        if (!duplicateEntry(error)) throw error;
        const existing = await this.transaction((connection) =>
          this.readVerifiedFrozenByCreationKey(
            connection, aggregate.workspaceId, aggregate.creationKeyHash,
            aggregate.requestHash, false
          ), true
        );
        if (!existing) {
          throw financialCouncilError("financial_council_run_conflict");
        }
        return { value: existing, replayed: true };
      }
    }
    throw financialCouncilError("financial_council_run_conflict");
  }

  async findFrozenRunByCreationKey(
    context: ActiveWorkspaceContext,
    creationKeyHash: string,
    requestHash: string
  ): Promise<FinancialCouncilRun | null> {
    if (!HASH.test(creationKeyHash) || !HASH.test(requestHash)) {
      throw financialCouncilError("financial_council_input_invalid");
    }
    return this.transaction((connection) =>
      this.readVerifiedFrozenByCreationKey(
        connection, context.workspaceId, creationKeyHash, requestHash, false
      ), true
    );
  }

  async createRun(
    command: CommandContext,
    aggregate: FinancialCouncilRun
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>> {
    ({ command, aggregate } = validateFinancialCouncilCreateMutation(
      command, aggregate
    ));
    try {
      return await this.transaction(async (connection) => {
        const existing = await this.findByCreationKey(
          connection, aggregate.workspaceId, aggregate.creationKeyHash, true
        );
        if (existing) {
          await this.verifyStoredRun(connection, existing);
          return this.replay(existing, aggregate.requestHash);
        }
        const stored = immutableFinancialCouncilValue(aggregate);
        await connection.query(
          `INSERT INTO financial_council_runs (
             run_id, workspace_id, creation_key_hash, request_hash, revision,
             status, snapshot_id, snapshot_hash, run_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [stored.runId, stored.workspaceId, stored.creationKeyHash,
            stored.requestHash, stored.revision, stored.status,
            stored.snapshotId, stored.snapshotHash, canonical(stored)]
        );
        await connection.query(
          `INSERT INTO financial_council_analysis_controls (
             workspace_id, run_id, owner_id, team_id, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
          [stored.workspaceId, stored.runId, command.actorId,
            command.workspace.teamId, sqlDate(stored.createdAt)]
        );
        await this.appendEvent(connection, createFinancialCouncilRunEvent(stored, {
          fromStatus: null,
          reasonCode: null,
          occurredAt: stored.createdAt,
          actorId: command.actorId
        }));
        return { value: stored, replayed: false };
      });
    } catch (error) {
      if (!duplicateEntry(error)) throw error;
      return this.transaction(async (connection) => {
        const existing = await this.findByCreationKey(
          connection, aggregate.workspaceId, aggregate.creationKeyHash, false
        );
        if (!existing) {
          throw financialCouncilError("financial_council_run_conflict");
        }
        await this.verifyStoredRun(connection, existing);
        return this.replay(existing, aggregate.requestHash);
      }, true);
    }
  }

  async findRun(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<FinancialCouncilRun | null> {
    return (await this.readVerifiedHistory(context, runId))?.run ?? null;
  }

  async getVerifiedRunSnapshot(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<VerifiedFinancialCouncilRunSnapshot | null> {
    return this.transaction(async (connection) => {
      const [runRows] = await connection.query(
        `SELECT * FROM financial_council_runs
         WHERE workspace_id = ? AND run_id = ?`,
        [context.workspaceId, runId]
      );
      const row = (runRows as MysqlRow[])[0];
      if (!row) return null;
      const run = parseRun(row);
      const events = await this.verifyStoredRun(connection, run);
      const [snapshotRows] = await connection.query(
        `${SNAPSHOT_SELECT}
         WHERE workspace_id = ? AND run_id = ?`,
        [context.workspaceId, runId]
      );
      const snapshotRow = (snapshotRows as MysqlRow[])[0];
      if (!snapshotRow) integrity();
      const record = parseSnapshot(snapshotRow);
      assertStoredSnapshot(run, record, events);
      return immutableFinancialCouncilValue({
        run,
        snapshot: validateFinancialSnapshotForRun(record.snapshot, run)
      });
    }, true);
  }

  async listEvents(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<readonly FinancialCouncilRunEvent[]> {
    return (await this.readVerifiedHistory(context, runId))?.events
      ?? Object.freeze([]);
  }

  async storeFrozenSnapshot(
    command: CommandContext,
    input: StoreFrozenFinancialSnapshotInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>> {
    ({ command, input } = validateFinancialCouncilStoreSnapshotMutation(
      command, input
    ));
    const revision = expectedRevision(command);
    return this.transaction(async (connection) => {
      const current = await this.findByRunId(
        connection, command.workspace.workspaceId, input.runId, true
      );
      if (!current) {
        throw financialCouncilError("financial_council_run_not_found");
      }
      if (current.revision !== revision) {
        throw financialCouncilError("financial_council_revision_conflict");
      }
      assertFinancialSnapshotRecord(current, input.snapshot);
      const [existingRows] = await connection.query(
        `${SNAPSHOT_SELECT}
         WHERE workspace_id = ? AND run_id = ? FOR UPDATE`,
        [current.workspaceId, current.runId]
      );
      const existingRow = (existingRows as MysqlRow[])[0];
      if (existingRow) {
        parseSnapshot(existingRow);
        throw financialCouncilError("financial_council_snapshot_conflict");
      }
      try {
        await connection.query(
          `INSERT INTO financial_council_snapshots (
             snapshot_id, run_id, workspace_id, snapshot_hash, snapshot_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          [input.snapshot.snapshotId, input.snapshot.runId,
            input.snapshot.workspaceId, input.snapshot.snapshotHash,
            canonical(input.snapshot.snapshot), sqlDate(input.snapshot.createdAt)]
        );
      } catch (error) {
        if (duplicateEntry(error)) {
          throw financialCouncilError("financial_council_snapshot_conflict");
        }
        throw error;
      }
      const withSnapshot = immutableFinancialCouncilValue({
        ...current,
        snapshotId: input.snapshot.snapshotId,
        snapshotHash: input.snapshot.snapshotHash
      });
      const next = applyFinancialCouncilTransition(withSnapshot, {
        kind: "snapshot_frozen",
        occurredAt: input.occurredAt,
        actorId: command.actorId
      });
      await this.updateRun(connection, current, next);
      await this.appendEvent(connection, createFinancialCouncilRunEvent(next, {
        fromStatus: current.status,
        reasonCode: null,
        occurredAt: input.occurredAt,
        actorId: command.actorId
      }));
      return { value: next, replayed: false };
    });
  }

  async transitionRun(
    command: CommandContext,
    input: TransitionFinancialCouncilRunInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>> {
    ({ command, input } = validateFinancialCouncilTransitionMutation(
      command, input
    ));
    if (input.kind === "snapshot_frozen") {
      throw financialCouncilError("financial_council_transition_invalid");
    }
    const revision = expectedRevision(command);
    return this.transaction(async (connection) => {
      const current = await this.findByRunId(
        connection, command.workspace.workspaceId, input.runId, true
      );
      if (!current) {
        throw financialCouncilError("financial_council_run_not_found");
      }
      if (current.revision !== revision) {
        throw financialCouncilError("financial_council_revision_conflict");
      }
      const next = applyFinancialCouncilTransition(current, {
        kind: input.kind,
        occurredAt: input.occurredAt,
        actorId: command.actorId
      });
      await this.updateRun(connection, current, next);
      await this.appendEvent(connection, createFinancialCouncilRunEvent(next, {
        fromStatus: current.status,
        reasonCode: input.reasonCode,
        occurredAt: input.occurredAt,
        actorId: command.actorId
      }));
      return { value: next, replayed: false };
    });
  }

  async listRunnableRuns(
    input: ListRunnableFinancialCouncilRunsInput
  ): Promise<readonly FinancialCouncilRun[]> {
    input = validateListRunnableFinancialCouncilRunsInput(input);
    return this.transaction(async (connection) => {
      const [rows] = await connection.query(
        `SELECT * FROM financial_council_runs
         WHERE status = 'snapshot_frozen'
           AND (? IS NULL OR BINARY workspace_id > BINARY ?
             OR (BINARY workspace_id = BINARY ?
               AND BINARY run_id > BINARY ?))
         ORDER BY BINARY workspace_id ASC, BINARY run_id ASC LIMIT ?`,
        [
          input.after?.workspaceId ?? null,
          input.after?.workspaceId ?? null,
          input.after?.workspaceId ?? null,
          input.after?.runId ?? null,
          input.limit
        ]
      );
      const runs: FinancialCouncilRun[] = [];
      for (const row of rows as MysqlRow[]) {
        const run = parseRun(row);
        if (run.status !== "snapshot_frozen") integrity();
        const [eventRows] = await connection.query(
          `${EVENT_SELECT}
           WHERE workspace_id = ? AND run_id = ? ORDER BY revision ASC`,
          [run.workspaceId, run.runId]
        );
        const events = Object.freeze((eventRows as MysqlRow[]).map(parseEvent));
        assertFinancialCouncilRunHistory(run, events, integrity);
        const [snapshotRows] = await connection.query(
          `${SNAPSHOT_SELECT}
           WHERE workspace_id = ? AND run_id = ?`,
          [run.workspaceId, run.runId]
        );
        const snapshotRow = (snapshotRows as MysqlRow[])[0];
        if (!snapshotRow) integrity();
        const snapshot = parseSnapshot(snapshotRow);
        assertStoredSnapshot(run, snapshot, events);
        runs.push(run);
      }
      return Object.freeze(runs);
    }, true);
  }

  async getAnalysisControl(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<FinancialCouncilAnalysisControl | null> {
    return this.transaction(async (connection) => {
      const [rows] = await connection.query(
        `SELECT * FROM financial_council_analysis_controls
         WHERE workspace_id = ? AND run_id = ?`,
        [context.workspaceId, runId]
      );
      const row = (rows as MysqlRow[])[0];
      return row ? parseAnalysisControl(row) : null;
    }, true);
  }

  async claimAnalysisRun(
    input: ClaimFinancialCouncilAnalysisRunInput
  ): Promise<FinancialCouncilAnalysisLease | null> {
    if (!/^[0-9a-f]{64}$/u.test(input.leaseToken)
      || !input.workerId.trim()
      || Date.parse(input.leaseExpiresAt) <= Date.parse(input.claimedAt)) {
      throw financialCouncilError("financial_council_lease_invalid");
    }
    return this.transaction(async (connection) => {
      const current = await this.readAnalysisControl(
        connection, input.workspaceId, input.runId, true
      );
      const run = await this.findByRunId(
        connection, input.workspaceId, input.runId, true
      );
      if (!current || !run || !["snapshot_frozen", "analyzing", "auditing",
        "synthesizing", "optimizing"].includes(run.status)) return null;
      if (current.lease && Date.parse(current.lease.leaseExpiresAt)
        > Date.parse(input.claimedAt)) return null;
      const lease = immutableFinancialCouncilValue({
        ...input, attempt: (current.lease?.attempt ?? 0) + 1
      });
      const [result] = await connection.query(
        `UPDATE financial_council_analysis_controls
         SET lease_worker_id = ?, lease_token = ?, attempt = ?,
           claimed_at = ?, lease_expires_at = ?
         WHERE workspace_id = ? AND run_id = ?`,
        [lease.workerId, lease.leaseToken, lease.attempt,
          sqlDate(lease.claimedAt), sqlDate(lease.leaseExpiresAt),
          lease.workspaceId, lease.runId]
      );
      if (affectedRows(result) !== 1) {
        throw financialCouncilError("financial_council_lease_stale");
      }
      return lease;
    });
  }

  async releaseAnalysisLease(
    lease: FinancialCouncilAnalysisLease,
    releasedAt: string
  ): Promise<void> {
    await this.transaction(async (connection) => {
      await this.assertLiveAnalysisLease(connection, lease, releasedAt);
      const [result] = await connection.query(
        `UPDATE financial_council_analysis_controls
         SET lease_worker_id = NULL, lease_token = NULL,
           claimed_at = NULL, lease_expires_at = NULL
         WHERE workspace_id = ? AND run_id = ? AND lease_token = ?
           AND attempt = ?`,
        [lease.workspaceId, lease.runId, lease.leaseToken, lease.attempt]
      );
      if (affectedRows(result) !== 1) {
        throw financialCouncilError("financial_council_lease_stale");
      }
    });
  }

  async transitionRunWithLease(
    lease: FinancialCouncilAnalysisLease,
    input: Omit<TransitionFinancialCouncilRunInput, "runId">
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>> {
    return this.transaction(async (connection) => {
      const control = await this.assertLiveAnalysisLease(
        connection, lease, input.occurredAt
      );
      const current = await this.findByRunId(
        connection, lease.workspaceId, lease.runId, true
      );
      if (!current) throw financialCouncilError("financial_council_run_not_found");
      const next = applyFinancialCouncilTransition(current, {
        kind: input.kind, occurredAt: input.occurredAt,
        actorId: control.ownerId
      });
      await this.updateRun(connection, current, next);
      await this.appendEvent(connection, createFinancialCouncilRunEvent(next, {
        fromStatus: current.status, reasonCode: input.reasonCode,
        occurredAt: input.occurredAt, actorId: control.ownerId
      }));
      return { value: next, replayed: false };
    });
  }

  async listRecoverableAnalysisRuns(
    now: string,
    limit: number
  ): Promise<readonly FinancialCouncilRun[]> {
    return this.transaction(async (connection) => {
      const [rows] = await connection.query(
        `SELECT r.* FROM financial_council_runs r
         INNER JOIN financial_council_analysis_controls c
           ON c.workspace_id = r.workspace_id AND c.run_id = r.run_id
         WHERE r.status IN
           ('snapshot_frozen','analyzing','auditing','synthesizing','optimizing')
           AND (c.lease_expires_at IS NULL OR c.lease_expires_at <= ?)
         ORDER BY BINARY r.workspace_id ASC, BINARY r.run_id ASC LIMIT ?`,
        [sqlDate(now), limit]
      );
      return Object.freeze((rows as MysqlRow[]).map(parseRun));
    }, true);
  }

  async storeAnalysisGap(
    lease: FinancialCouncilAnalysisLease,
    gap: FinancialCouncilAnalysisGap
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilAnalysisGap>> {
    return this.transaction(async (connection) => {
      await this.assertLiveAnalysisLease(connection, lease, gap.createdAt);
      const [rows] = await connection.query(
        `SELECT * FROM financial_council_analysis_gaps
         WHERE workspace_id = ? AND run_id = ? AND role = ? FOR UPDATE`,
        [gap.workspaceId, gap.runId, gap.role]
      );
      const row = (rows as MysqlRow[])[0];
      if (row) {
        const existing = parseAnalysisGap(row);
        if (canonical(existing) !== canonical(gap)) {
          throw financialCouncilError("financial_council_analysis_gap_conflict");
        }
        return { value: existing, replayed: true };
      }
      const { gapHash: _hash, ...preimage } = gap;
      if (gap.workspaceId !== lease.workspaceId || gap.runId !== lease.runId
        || !["profit", "cost", "tax"].includes(gap.role)
        || !["specialist_unavailable", "tax_input_missing"].includes(gap.code)
        || gap.detail !== null
        || gap.gapHash !== financialCouncilCanonicalHash(preimage)) {
        throw financialCouncilError("financial_council_analysis_gap_invalid");
      }
      await connection.query(
        `INSERT INTO financial_council_analysis_gaps (
           workspace_id, run_id, role, code, gap_hash, gap_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [gap.workspaceId, gap.runId, gap.role, gap.code, gap.gapHash,
          canonical(gap), sqlDate(gap.createdAt)]
      );
      return { value: immutableFinancialCouncilValue(gap), replayed: false };
    });
  }

  async listAnalysisGaps(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<readonly FinancialCouncilAnalysisGap[]> {
    return this.transaction(async (connection) => {
      const [rows] = await connection.query(
        `SELECT * FROM financial_council_analysis_gaps
         WHERE workspace_id = ? AND run_id = ? ORDER BY BINARY role ASC`,
        [context.workspaceId, runId]
      );
      return Object.freeze((rows as MysqlRow[]).map(parseAnalysisGap));
    }, true);
  }

  async storeSpecialistResult(
    context: ActiveWorkspaceContext,
    rawResult: AuthorizedFinancialCouncilSpecialistResult,
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<
  AuthorizedFinancialCouncilSpecialistResult>> {
    assertFinancialCouncilSpecialistResultAuthorized(rawResult);
    const result = validateFinancialCouncilSpecialistResult(rawResult);
    if (result.workspaceId !== context.workspaceId) {
      throw financialCouncilError("financial_council_specialist_result_invalid");
    }
    try {
      return await this.transaction(async (connection) => {
        if (write) await this.assertLiveAnalysisLease(
          connection, write.lease, write.completedAt
        );
        const run = await this.findByRunId(
          connection, context.workspaceId, result.runId, true
        );
        if (!run) throw financialCouncilError("financial_council_run_not_found");
        const events = await this.verifyStoredRun(connection, run);
        const [snapshotRows] = await connection.query(
          `${SNAPSHOT_SELECT}
           WHERE workspace_id = ? AND run_id = ? FOR UPDATE`,
          [context.workspaceId, result.runId]
        );
        const snapshotRow = (snapshotRows as MysqlRow[])[0];
        if (!snapshotRow) integrity();
        const snapshot = parseSnapshot(snapshotRow);
        assertStoredSnapshot(run, snapshot, events);
        if (result.snapshotId !== snapshot.snapshotId
          || result.snapshotHash !== snapshot.snapshotHash
          || Date.parse(result.createdAt) < Date.parse(run.updatedAt)
          || Date.parse(result.createdAt) > Date.parse(run.expiresAt)
          || Date.parse(result.createdAt) > Date.now() + 1_000) {
          throw financialCouncilError(
            "financial_council_specialist_result_invalid"
          );
        }
        const existing = await this.readSpecialistResult(
          connection, result.workspaceId, result.runId,
          result.role, result.phase, true
        );
        if (existing) {
          if (canonical(existing) !== canonical(result)) {
            throw financialCouncilError("financial_council_specialist_conflict");
          }
          return { value: rawResult, replayed: true };
        }
        await connection.query(
          `INSERT INTO financial_council_specialist_results (
             workspace_id, run_id, role, phase, result_id, snapshot_id,
             snapshot_hash, result_hash, result_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [result.workspaceId, result.runId, result.role, result.phase,
            result.resultId, result.snapshotId, result.snapshotHash,
            result.resultHash, canonical(result), sqlDate(result.createdAt)]
        );
        for (const finding of result.findings) {
          await connection.query(
            `INSERT INTO financial_council_findings (
               workspace_id, run_id, finding_id, role, phase, snapshot_id,
               finding_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [result.workspaceId, result.runId, finding.findingId, result.role,
              result.phase, result.snapshotId, canonical(finding)]
          );
        }
        for (const action of result.actions) {
          await connection.query(
            `INSERT INTO financial_council_candidate_actions (
               workspace_id, run_id, action_id, role, phase, snapshot_id,
               action_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [result.workspaceId, result.runId, action.actionId, result.role,
              result.phase, result.snapshotId, canonical(action)]
          );
        }
        return { value: rawResult, replayed: false };
      });
    } catch (error) {
      if (!duplicateEntry(error)) throw error;
      const existing = await this.getSpecialistResult(
        context, result.runId, result.role, result.phase
      );
      if (existing && canonical(existing) === canonical(result)) {
        return { value: rawResult, replayed: true };
      }
      throw financialCouncilError("financial_council_specialist_conflict");
    }
  }

  async getSpecialistResult(
    context: ActiveWorkspaceContext,
    runId: string,
    role: FinancialCouncilAgentRole,
    phase: FinancialCouncilSpecialistPhase
  ): Promise<FinancialCouncilSpecialistResult | null> {
    if (!SPECIALIST_ROLES.has(role) || !SPECIALIST_PHASES.has(phase)) {
      throw financialCouncilError("financial_council_specialist_result_invalid");
    }
    return this.transaction(async (connection) => {
      const run = await this.findByRunId(
        connection, context.workspaceId, runId, false
      );
      const result = await this.readSpecialistResult(
        connection, context.workspaceId, runId, role, phase, false
      );
      if (!run) {
        if (result) integrity();
        return null;
      }
      await this.verifyStoredRun(connection, run);
      if (result && (result.snapshotId !== run.snapshotId
        || result.snapshotHash !== run.snapshotHash)) integrity();
      return result;
    }, true);
  }

  async listSpecialistResults(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<readonly FinancialCouncilSpecialistResult[]> {
    return this.transaction(async (connection) => {
      const run = await this.findByRunId(
        connection, context.workspaceId, runId, false
      );
      const [rows] = await connection.query(
        `SELECT workspace_id, run_id, role, phase, result_id, snapshot_id,
                snapshot_hash, result_hash, result_json,
                DATE_FORMAT(created_at,
                  '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
         FROM financial_council_specialist_results
         WHERE workspace_id = ? AND run_id = ?
         ORDER BY CASE role
           WHEN 'finance' THEN 1 WHEN 'profit' THEN 2 WHEN 'cost' THEN 3
           WHEN 'cashflow' THEN 4 WHEN 'tax' THEN 5 ELSE 6 END, phase ASC`,
        [context.workspaceId, runId]
      );
      if (!run) {
        if ((rows as MysqlRow[]).length !== 0) integrity();
        return Object.freeze([]);
      }
      await this.verifyStoredRun(connection, run);
      const results: FinancialCouncilSpecialistResult[] = [];
      for (const row of rows as MysqlRow[]) {
        const result = await this.readSpecialistResultByRow(connection, row);
        if (result.snapshotId !== run.snapshotId
          || result.snapshotHash !== run.snapshotHash) integrity();
        results.push(result);
      }
      return Object.freeze(results);
    }, true);
  }

  async storeAuditGraph(
    context: ActiveWorkspaceContext,
    graph: FinancialCouncilAuditGraph,
    dispositions: readonly InitialFinancialCouncilFindingDisposition[],
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilAuditGraph>> {
    return this.transaction(async (connection) => {
      if (write) await this.assertLiveAnalysisLease(
        connection, write.lease, write.completedAt
      );
      const run = await this.findByRunId(
        connection, context.workspaceId, graph.runId, true
      );
      if (!run) throw financialCouncilError("financial_council_run_not_found");
      await this.verifyStoredRun(connection, run);
      const expectedHash = financialCouncilCanonicalHash({
        workspaceId: graph.workspaceId, runId: graph.runId,
        snapshotId: graph.snapshotId, snapshotHash: graph.snapshotHash,
        edges: graph.edges
      });
      if (graph.workspaceId !== context.workspaceId
        || graph.snapshotId !== run.snapshotId
        || graph.snapshotHash !== run.snapshotHash
        || graph.graphId !== expectedHash || graph.graphHash !== expectedHash
        || new Set(dispositions.map((item) => item.findingId)).size
          !== dispositions.length
        || dispositions.some((item) => item.status !== "unresolved"
          || !SPECIALIST_ROLES.has(item.role)
          || item.blockingConflictIds.some((id) => !graph.edges.some((edge) =>
            edge.edgeId === id && edge.findingIds.includes(item.findingId))))) {
        throw financialCouncilError("financial_council_audit_invalid");
      }
      const existing = await this.readAuditGraph(
        connection, context.workspaceId, graph.runId, true
      );
      if (existing) {
        const [storedDispositionRows] = await connection.query(
          `SELECT * FROM financial_council_finding_dispositions
           WHERE workspace_id = ? AND run_id = ? ORDER BY BINARY finding_id ASC`,
          [context.workspaceId, graph.runId]
        );
        const storedDispositions = (storedDispositionRows as MysqlRow[])
          .map(parseDispositionRow).map((item) => ({
            findingId: item.findingId, role: item.role,
            status: "unresolved", blockingConflictIds: item.blockingConflictIds
          }));
        if (canonical(existing) !== canonical(graph)
          || canonical(storedDispositions) !== canonical([...dispositions]
            .sort((left, right) => utf8Compare(
              left.findingId, right.findingId
            )))) {
          throw financialCouncilError("financial_council_audit_conflict");
        }
        return { value: existing, replayed: true };
      }
      await connection.query(
        `INSERT INTO financial_council_audit_graphs (
           workspace_id, run_id, snapshot_id, snapshot_hash, graph_id,
           graph_hash, graph_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [graph.workspaceId, graph.runId, graph.snapshotId, graph.snapshotHash,
          graph.graphId, graph.graphHash, canonical(graph)]
      );
      for (const item of dispositions) {
        const stable = { workspaceId: context.workspaceId, runId: graph.runId,
          snapshotId: graph.snapshotId, snapshotHash: graph.snapshotHash,
          graphId: graph.graphId, findingId: item.findingId, role: item.role,
          status: item.status, blockingConflictIds: [...item.blockingConflictIds]
            .sort(utf8Compare), updatedAt: run.updatedAt };
        const disposition = { ...stable,
          dispositionHash: financialCouncilCanonicalHash(stable) };
        await connection.query(
          `INSERT INTO financial_council_finding_dispositions (
             workspace_id, run_id, finding_id, role, status,
             disposition_hash, disposition_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [context.workspaceId, graph.runId, item.findingId, item.role,
            item.status, disposition.dispositionHash, canonical(disposition)]
        );
      }
      return { value: graph, replayed: false };
    });
  }

  async getAuditGraph(context: ActiveWorkspaceContext, runId: string):
  Promise<FinancialCouncilAuditGraph | null> {
    return this.transaction((connection) => this.readAuditGraph(
      connection, context.workspaceId, runId, false
    ), true);
  }

  async reserveRebuttalAttempt(
    context: ActiveWorkspaceContext,
    attempt: FinancialCouncilRebuttalAttempt,
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRebuttalAttempt>> {
    if (attempt.workspaceId !== context.workspaceId || attempt.round !== 1
      || attempt.status !== "reserved" || attempt.result !== null
      || attempt.outputHash !== null || attempt.completedAt !== null
      || attempt.inputHash !== financialCouncilCanonicalHash(attempt.input)) {
      throw financialCouncilError("financial_council_rebuttal_invalid");
    }
    const { attemptHash: _hash, ...preimage } = attempt;
    if (attempt.attemptHash !== financialCouncilCanonicalHash(preimage)) {
      throw financialCouncilError("financial_council_rebuttal_invalid");
    }
    try {
      return await this.transaction(async (connection) => {
        if (write) await this.assertLiveAnalysisLease(
          connection, write.lease, write.completedAt
        );
        const graph = await this.readAuditGraph(
          connection, context.workspaceId, attempt.runId, false
        );
        if (!graph || graph.graphId !== attempt.graphId
          || graph.snapshotId !== attempt.snapshotId
          || graph.snapshotHash !== attempt.snapshotHash
          || !graph.edges.some((edge) => edge.edgeId === attempt.edgeId
            && edge.findingIds.includes(attempt.targetFindingId))) {
          throw financialCouncilError("financial_council_rebuttal_invalid");
        }
        const existing = await this.readRebuttalAttempt(connection,
          context.workspaceId, attempt.runId, attempt.role, 1, true);
        if (existing) {
          if (existing.attemptId !== attempt.attemptId
            || existing.inputHash !== attempt.inputHash
            || existing.edgeId !== attempt.edgeId) {
            throw financialCouncilError("financial_council_rebuttal_conflict");
          }
          return { value: existing, replayed: true };
        }
        await connection.query(
          `INSERT INTO financial_council_rebuttal_attempts (
             workspace_id, run_id, role, round_number, attempt_id, input_hash,
             status, attempt_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [attempt.workspaceId, attempt.runId, attempt.role, 1,
            attempt.attemptId, attempt.inputHash, attempt.status,
            canonical(attempt)]
        );
        return { value: attempt, replayed: false };
      });
    } catch (error) {
      if (!duplicateEntry(error)) throw error;
      const existing = await this.getRebuttalAttempt(
        context, attempt.runId, attempt.role, 1
      );
      if (existing && existing.attemptId === attempt.attemptId
        && existing.inputHash === attempt.inputHash
        && existing.edgeId === attempt.edgeId) {
        return { value: existing, replayed: true };
      }
      throw financialCouncilError("financial_council_rebuttal_conflict");
    }
  }

  async getRebuttalAttempt(
    context: ActiveWorkspaceContext, runId: string,
    role: FinancialCouncilAgentRole, round: number
  ): Promise<FinancialCouncilRebuttalAttempt | null> {
    if (!SPECIALIST_ROLES.has(role) || round !== 1) {
      throw financialCouncilError("financial_council_rebuttal_invalid");
    }
    return this.transaction((connection) => this.readRebuttalAttempt(
      connection, context.workspaceId, runId, role, round, false
    ), true);
  }

  async listRebuttalAttempts(context: ActiveWorkspaceContext, runId: string):
  Promise<readonly FinancialCouncilRebuttalAttempt[]> {
    return this.transaction(async (connection) => {
      const [rows] = await connection.query(
        `SELECT * FROM financial_council_rebuttal_attempts
         WHERE workspace_id = ? AND run_id = ?
         ORDER BY BINARY role ASC, round_number ASC`,
        [context.workspaceId, runId]
      );
      return Object.freeze((rows as MysqlRow[]).map(parseRebuttalAttemptRow));
    }, true);
  }

  async completeRebuttalAttempt(
    context: ActiveWorkspaceContext,
    input: CompleteFinancialCouncilRebuttalInput,
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRebuttalAttempt>> {
    return this.transaction(async (connection) => {
      if (write) await this.assertLiveAnalysisLease(
        connection, write.lease, write.completedAt
      );
      const [rows] = await connection.query(
        `SELECT * FROM financial_council_rebuttal_attempts
         WHERE workspace_id = ? AND attempt_id = ? FOR UPDATE`,
        [context.workspaceId, input.attemptId]
      );
      const currentRow = (rows as MysqlRow[])[0];
      if (!currentRow) {
        throw financialCouncilError("financial_council_rebuttal_conflict");
      }
      const current = parseRebuttalAttemptRow(currentRow);
      const outputHash = financialCouncilCanonicalHash(input.result.value);
      if (current.inputHash !== input.inputHash) {
        throw financialCouncilError("financial_council_rebuttal_conflict");
      }
      if (current.status === "completed") {
        if (current.outputHash !== outputHash
          || canonical(current.result) !== canonical(input.result)) {
          throw financialCouncilError("financial_council_rebuttal_conflict");
        }
        return { value: current, replayed: true };
      }
      if (input.result.binding.jobId
          !== `financial-council:${current.runId}:${current.role}:rebut:1`
        || input.result.binding.contentHash !== rebuttalContentHash(current.input)
        || input.result.binding.runId !== current.runId
        || input.result.binding.snapshotId !== current.snapshotId
        || input.result.binding.snapshotHash !== current.snapshotHash
        || input.result.binding.role !== current.role
        || input.result.binding.phase !== "rebut"
        || input.result.binding.attempt !== 1
        || input.result.value.findingId !== current.targetFindingId) {
        throw financialCouncilError("financial_council_rebuttal_invalid");
      }
      const stable = { ...current, status: "completed" as const,
        result: input.result, outputHash, completedAt: input.completedAt };
      const { attemptHash: _oldAttemptHash, ...attemptPreimage } = stable;
      const completed = { ...attemptPreimage,
        attemptHash: financialCouncilCanonicalHash(attemptPreimage) };
      const [dispositionRows] = await connection.query(
        `SELECT * FROM financial_council_finding_dispositions
         WHERE workspace_id = ? AND run_id = ? AND finding_id = ? FOR UPDATE`,
        [context.workspaceId, current.runId, current.targetFindingId]
      );
      const dispositionRow = (dispositionRows as MysqlRow[])[0];
      if (!dispositionRow) integrity();
      const disposition = parseDispositionRow(dispositionRow);
      const expectedStatus = input.result.value.decision === "withdraw"
        ? "withdrawn" : input.result.value.decision === "revise"
          ? "revised" : "upheld";
      const expectedBlocking = input.result.value.decision === "withdraw" ? []
        : input.result.value.decision === "revise"
          ? disposition.blockingConflictIds.filter((id) => id !== current.edgeId)
          : [...disposition.blockingConflictIds];
      if (input.disposition.status !== expectedStatus
        || canonical([...input.disposition.blockingConflictIds]
          .sort(utf8Compare)) !== canonical(expectedBlocking.sort(utf8Compare))) {
        throw financialCouncilError("financial_council_rebuttal_invalid");
      }
      const changed = { ...disposition, status: input.disposition.status,
        blockingConflictIds: [...input.disposition.blockingConflictIds]
          .sort(utf8Compare), updatedAt: input.completedAt };
      const { dispositionHash: _oldDispositionHash, ...dispositionPreimage }
        = changed;
      const completedDisposition = { ...dispositionPreimage,
        dispositionHash: financialCouncilCanonicalHash(dispositionPreimage) };
      await connection.query(
        `UPDATE financial_council_rebuttal_attempts
         SET status = ?, attempt_json = ?
         WHERE workspace_id = ? AND run_id = ? AND role = ? AND round_number = 1`,
        ["completed", canonical(completed), context.workspaceId,
          current.runId, current.role]
      );
      await connection.query(
        `UPDATE financial_council_finding_dispositions
         SET status = ?, disposition_hash = ?, disposition_json = ?
         WHERE workspace_id = ? AND run_id = ? AND finding_id = ?`,
        [completedDisposition.status, completedDisposition.dispositionHash,
          canonical(completedDisposition), context.workspaceId, current.runId,
          current.targetFindingId]
      );
      return { value: completed, replayed: false };
    });
  }

  async listFindingDispositions(
    context: ActiveWorkspaceContext, runId: string
  ): Promise<readonly FinancialCouncilFindingDisposition[]> {
    return this.transaction(async (connection) => {
      const [rows] = await connection.query(
        `SELECT * FROM financial_council_finding_dispositions
         WHERE workspace_id = ? AND run_id = ? ORDER BY BINARY finding_id ASC`,
        [context.workspaceId, runId]
      );
      return Object.freeze((rows as MysqlRow[]).map(parseDispositionRow));
    }, true);
  }

  async storeConsensus(
    context: ActiveWorkspaceContext,
    rawConsensus: ConsensusReport,
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<ConsensusReport>> {
    const consensus = immutableFinancialCouncilValue(rawConsensus);
    try {
      return await this.transaction(async (connection) => {
        if (write) {
          await this.assertLiveAnalysisLease(
            connection, write.lease, write.completedAt
          );
          if (write.lease.workspaceId !== context.workspaceId
            || write.lease.runId !== consensus.runId) {
            throw financialCouncilError("financial_council_lease_stale");
          }
        }
        const validated = await this.validateConsensus(
          connection, context, consensus, true, false
        );
        const existing = await this.readConsensus(
          connection, context.workspaceId, validated.runId, true
        );
        if (existing) {
          await this.validateConsensus(connection, context, existing,
            true, true);
          if (canonical(existing) !== canonical(validated)) {
            throw financialCouncilError("financial_council_consensus_conflict");
          }
          return { value: existing, replayed: true };
        }
        await connection.query(
          `INSERT INTO financial_council_consensus_reports (
             workspace_id, run_id, snapshot_id, audit_hash, report_id,
             report_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [context.workspaceId, validated.runId, validated.snapshotId,
            validated.inputVersionHash, validated.reportId,
            canonical(validated), sqlDate(validated.createdAt)]
        );
        return { value: validated, replayed: false };
      });
    } catch (error) {
      if (!duplicateEntry(error)) throw error;
      const existing = await this.getConsensus(context, consensus.runId);
      if (existing && canonical(existing) === canonical(consensus)) {
        return { value: existing, replayed: true };
      }
      throw financialCouncilError("financial_council_consensus_conflict");
    }
  }

  async getConsensus(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<ConsensusReport | null> {
    return this.transaction(async (connection) => {
      const report = await this.readConsensus(
        connection, context.workspaceId, runId, false
      );
      if (!report) return null;
      return this.validateConsensus(connection, context, report, false, true);
    }, true);
  }

  async storePortfolioRevision(
    rawRevision: FinancialCouncilPortfolioRevision,
    write: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilPortfolioRevision>> {
    const revision = immutableFinancialCouncilValue(rawRevision);
    try {
      return await this.transaction(async (connection) => {
        await this.assertLiveAnalysisLease(
          connection, write.lease, write.completedAt
        );
        if (revision.workspaceId !== write.lease.workspaceId
          || revision.runId !== write.lease.runId) {
          throw financialCouncilError("financial_council_lease_stale");
        }
        const run = await this.findByRunId(
          connection, write.lease.workspaceId, write.lease.runId, true
        );
        if (!run || run.status !== "optimizing") {
          throw financialCouncilError("financial_council_portfolio_state_invalid");
        }
        await this.validatePortfolioRevision(connection, revision, true, false);
        const existing = await this.readPortfolioRevision(
          connection, revision.workspaceId, revision.runId,
          revision.revision, true
        );
        if (existing) {
          await this.validatePortfolioRevision(connection, existing, true, true);
          if (canonical(existing) !== canonical(revision)) {
            throw financialCouncilError("financial_council_portfolio_conflict");
          }
          return { value: existing, replayed: true };
        }
        await connection.query(
          `INSERT INTO financial_council_portfolio_revisions (
             workspace_id, run_id, revision, revision_id, run_hash,
             snapshot_id, snapshot_hash, audit_hash, policy_version_id,
             policy_hash, consensus_report_id, candidate_set_hash, output_hash,
             revision_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [revision.workspaceId, revision.runId, revision.revision,
            revision.revisionId, revision.runHash, revision.snapshotId,
            revision.snapshotHash, revision.auditHash,
            revision.policyVersionId, revision.policyHash,
            revision.consensusReportId, revision.candidateSetHash,
            revision.outputHash, canonical(revision),
            sqlDate(revision.createdAt)]
        );
        return { value: revision, replayed: false };
      });
    } catch (error) {
      if (!duplicateEntry(error)) throw error;
      const existing = await this.transaction(async (connection) => {
        const stored = await this.readPortfolioRevision(
          connection, revision.workspaceId, revision.runId,
          revision.revision, false
        );
        if (stored) {
          await this.validatePortfolioRevision(
            connection, stored, false, true
          );
        }
        return stored;
      }, true);
      if (existing && canonical(existing) === canonical(revision)) {
        return { value: existing, replayed: true };
      }
      throw financialCouncilError("financial_council_portfolio_conflict");
    }
  }

  async getPortfolioRevision(
    context: ActiveWorkspaceContext,
    runId: string,
    revision: number
  ): Promise<FinancialCouncilPortfolioRevision | null> {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw financialCouncilError("financial_council_input_invalid");
    }
    return this.transaction(async (connection) => {
      const stored = await this.readPortfolioRevision(
        connection, context.workspaceId, runId, revision, false
      );
      if (stored) {
        await this.validatePortfolioRevision(connection, stored, false, true);
      }
      return stored;
    }, true);
  }

  async commitPortfolioRevision(
    command: CommandContext,
    rawInput: CommitFinancialCouncilPortfolioRevisionInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilPortfolioRevision>> {
    const revision = immutableFinancialCouncilValue(rawInput?.revision);
    if (!command || revision.workspaceId !== command.workspace?.workspaceId
      || command.actorId !== command.workspace.actorId
      || revision.commandRequestHash !== command.requestHash
      || revision.commandKeyHash
        !== financialCouncilPortfolioCommandKeyHash(command)
      || !Number.isSafeInteger(command.expectedRevision)) {
      throw financialCouncilError("financial_council_input_invalid");
    }
    try {
      return await this.transaction(async (connection) => {
        const current = await this.findByRunId(
          connection, revision.workspaceId, revision.runId, true
        );
        if (!current) {
          throw financialCouncilError("financial_council_run_not_found");
        }
        if (current.status !== "awaiting_approval") {
          throw financialCouncilError("financial_council_portfolio_state_invalid");
        }
        const existing = await this.readPortfolioRevision(connection,
          revision.workspaceId, revision.runId, revision.revision, true);
        if (existing) {
          await this.validatePortfolioRevision(connection, existing, true, true);
          if (existing.commandKeyHash === revision.commandKeyHash
            && existing.commandRequestHash === revision.commandRequestHash
            && canonical(existing) === canonical(revision)) {
            return { value: existing, replayed: true };
          }
          if (existing.commandKeyHash === revision.commandKeyHash) {
            throw financialCouncilError("financial_council_idempotency_conflict");
          }
          throw financialCouncilError(
            "financial_council_portfolio_revision_conflict"
          );
        }
        if (current.revision !== expectedRevision(command)) {
          throw financialCouncilError("financial_council_revision_conflict");
        }
        if (current.latestPortfolioRevision !== revision.baseRevision) {
          throw financialCouncilError(
            "financial_council_portfolio_revision_conflict"
          );
        }
        await this.validatePortfolioRevision(connection, revision, true, false);
        await connection.query(
          `INSERT INTO financial_council_portfolio_revisions (
             workspace_id, run_id, revision, revision_id, run_hash,
             snapshot_id, snapshot_hash, audit_hash, policy_version_id,
             policy_hash, consensus_report_id, candidate_set_hash, output_hash,
             revision_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [revision.workspaceId, revision.runId, revision.revision,
            revision.revisionId, revision.runHash, revision.snapshotId,
            revision.snapshotHash, revision.auditHash,
            revision.policyVersionId, revision.policyHash,
            revision.consensusReportId, revision.candidateSetHash,
            revision.outputHash, canonical(revision), sqlDate(revision.createdAt)]
        );
        await this.updateRun(connection, current,
          immutableFinancialCouncilValue({
            ...current, portfolios: revision.portfolios,
            latestPortfolioRevision: revision.revision
          }));
        return { value: revision, replayed: false };
      });
    } catch (error) {
      if (!duplicateEntry(error)) throw error;
      const existing = await this.getPortfolioRevision(
        command.workspace, revision.runId, revision.revision
      );
      if (existing && existing.commandKeyHash === revision.commandKeyHash
        && existing.commandRequestHash === revision.commandRequestHash
        && canonical(existing) === canonical(revision)) {
        return { value: existing, replayed: true };
      }
      throw financialCouncilError("financial_council_portfolio_revision_conflict");
    }
  }

  async commitApprovalDecision(
    command: CommandContext,
    input: CommitFinancialCouncilApprovalDecisionInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilApprovalRecord>> {
    assertFinancialCouncilApprovalRecord(input.approval);
    const approval = input.approval;
    if (!Number.isSafeInteger(input.verifiedTemporalSequence)
      || input.verifiedTemporalSequence < 0
      || command.actorId !== command.workspace.actorId
      || command.workspace.workspaceId !== approval.workspaceId
      || command.requestHash !== approval.commandRequestHash
      || financialCouncilPortfolioCommandKeyHash(command)
        !== approval.commandKeyHash) {
      throw financialCouncilError("financial_council_input_invalid");
    }
    const expectedOutbox = createFinancialCouncilDispatchOutboxRows(approval);
    if (canonical(expectedOutbox) !== canonical(input.outbox)) {
      throw financialCouncilError("financial_council_input_invalid");
    }
    try {
      return await this.transaction(async (connection) => {
        const tail = await new MysqlGrowthTemporalTransaction(connection)
          .lockWorkspaceTemporalBarrierForUpdate(approval.workspaceId);
        if (tail.temporalSequence !== input.verifiedTemporalSequence) {
          throw financialCouncilError("financial_council_source_stale");
        }
        const [policyRows] = await connection.query(
          `SELECT h.active_policy_version_id, v.policy_json
           FROM financial_council_policy_heads h
           JOIN financial_council_policy_versions v
             ON v.workspace_id = h.workspace_id
            AND v.policy_version_id = h.active_policy_version_id
           WHERE h.workspace_id = ? FOR UPDATE`,
          [approval.workspaceId]
        );
        const policyRow = (policyRows as MysqlRow[])[0];
        const activePolicy = policyRow
          ? jsonObject(policyRow.policy_json) : null;
        if (!activePolicy
          || activePolicy.policyVersionId !== approval.policyVersionId
          || activePolicy.policyHash !== approval.policyHash) {
          throw financialCouncilError("financial_council_policy_stale");
        }
        const existing = await this.readApprovalByRun(
          connection, approval.workspaceId, approval.runId, true
        );
        if (existing) {
          if (existing.commandKeyHash === approval.commandKeyHash
            && existing.commandRequestHash === approval.commandRequestHash) {
            return { value: existing, replayed: true };
          }
          if (existing.commandKeyHash === approval.commandKeyHash) {
            throw financialCouncilError("financial_council_idempotency_conflict");
          }
          throw financialCouncilError("financial_council_approval_conflict");
        }
        const current = await this.findByRunId(
          connection, approval.workspaceId, approval.runId, true
        );
        if (!current) throw financialCouncilError(
          "financial_council_run_not_found"
        );
        if (current.status !== "awaiting_approval") {
          throw financialCouncilError("financial_council_approval_state_invalid");
        }
        if (current.revision !== expectedRevision(command)) {
          throw financialCouncilError("financial_council_revision_conflict");
        }
        if (current.latestPortfolioRevision !== approval.portfolioRevision) {
          throw financialCouncilError(
            "financial_council_portfolio_revision_conflict"
          );
        }
        const revision = await this.readPortfolioRevision(connection,
          approval.workspaceId, approval.runId,
          approval.portfolioRevision, true);
        if (!revision) throw financialCouncilError(
          "financial_council_portfolio_not_found"
        );
        await this.validatePortfolioRevision(connection, revision, true, true);
        const portfolio = revision.portfolios.find((row) =>
          row.kind === approval.portfolioKind);
        const expectedCapabilities = portfolio && [...new Set([
          "finance.council.approve", ...portfolio.requiredApprovalCapabilities
        ])];
        if (!portfolio
          || approval.portfolioOutputHash
            !== financialCouncilCanonicalHash(portfolio)
          || approval.snapshotId !== revision.snapshotId
          || approval.snapshotHash !== revision.snapshotHash
          || approval.policyVersionId !== revision.policyVersionId
          || approval.policyHash !== revision.policyHash
          || canonical(approval.requiredCapabilities)
            !== canonical(expectedCapabilities)
          || (approval.status === "approved"
            && (canonical(approval.approvedActionIds)
                !== canonical(portfolio.actionIds)
              || canonical(approval.approvedActionHashes)
                !== canonical(portfolio.actions.map((action) => ({
                  actionId: action.actionId,
                  actionHash: financialCouncilCanonicalHash(action)
                })))
              || portfolio.actionIds.length === 0
              || portfolio.hardConstraints.some((row) => !row.satisfied)))) {
          throw financialCouncilError("financial_council_approval_invalid");
        }
        const publicApproval = immutableFinancialCouncilValue({
          approvalId: approval.approvalId,
          runId: approval.runId,
          portfolioRevision: approval.portfolioRevision,
          portfolioKind: approval.portfolioKind,
          status: approval.status,
          approvedActionIds: approval.approvedActionIds,
          requiredCapabilities: approval.requiredCapabilities,
          reason: approval.reason,
          approvedAt: approval.approvedAt
        });
        const next = applyFinancialCouncilTransition(
          immutableFinancialCouncilValue({ ...current,
            approval: publicApproval }), {
            kind: approval.status,
            occurredAt: approval.approvedAt,
            actorId: approval.approverId
          }
        );
        await connection.query(
          `INSERT INTO financial_council_approvals (
             workspace_id, run_id, approval_id, approval_hash,
             command_key_hash, command_request_hash, approval_json, approved_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [approval.workspaceId, approval.runId, approval.approvalId,
            approval.approvalHash, approval.commandKeyHash,
            approval.commandRequestHash, canonical(approval),
            sqlDate(approval.approvedAt)]
        );
        for (const row of input.outbox) {
          await connection.query(
            `INSERT INTO financial_council_dispatch_outbox (
               workspace_id, dispatch_id, run_id, approval_id, action_id,
               status, dispatch_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [row.workspaceId, row.dispatchId, row.runId, row.approvalId,
              row.actionId, row.status, canonical(row), sqlDate(row.createdAt),
              sqlDate(row.updatedAt)]
          );
        }
        await this.updateRun(connection, current, next);
        await this.appendEvent(connection, createFinancialCouncilRunEvent(next, {
          fromStatus: current.status,
          reasonCode: approval.reason,
          occurredAt: approval.approvedAt,
          actorId: approval.approverId
        }));
        return { value: approval, replayed: false };
      });
    } catch (error) {
      if (!duplicateEntry(error)) throw error;
      const existing = await this.getApproval(
        command.workspace, approval.approvalId
      );
      if (existing?.commandKeyHash === approval.commandKeyHash
        && existing.commandRequestHash === approval.commandRequestHash) {
        return { value: existing, replayed: true };
      }
      throw financialCouncilError("financial_council_approval_conflict");
    }
  }

  async getApproval(
    context: Pick<ActiveWorkspaceContext, "workspaceId">,
    approvalId: string
  ): Promise<FinancialCouncilApprovalRecord | null> {
    return this.transaction(async (connection) => {
      const [rows] = await connection.query(
        `SELECT *, DATE_FORMAT(approved_at, '%Y-%m-%dT%H:%i:%s.%fZ')
           AS approved_at
         FROM financial_council_approvals
         WHERE workspace_id = ? AND approval_id = ?`,
        [context.workspaceId, approvalId]
      );
      const row = (rows as MysqlRow[])[0];
      return row ? parseApproval(row) : null;
    }, true);
  }

  async listDispatchOutbox(
    context: Pick<ActiveWorkspaceContext, "workspaceId">,
    runId: string
  ): Promise<readonly FinancialCouncilDispatchOutboxRow[]> {
    return this.transaction(async (connection) => {
      const [rows] = await connection.query(
        `SELECT *,
           DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
           DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at
         FROM financial_council_dispatch_outbox
         WHERE workspace_id = ? AND run_id = ? ORDER BY action_id`,
        [context.workspaceId, runId]
      );
      const outbox = (rows as MysqlRow[]).map(parseDispatch);
      if (outbox.length) {
        const approval = await this.readApprovalByRun(
          connection, context.workspaceId, runId, false
        );
        if (!approval || canonical(outbox)
          !== canonical(createFinancialCouncilDispatchOutboxRows(approval))) {
          integrity();
        }
      }
      return Object.freeze(outbox);
    }, true);
  }

  async claimDispatchOperation(input: ClaimFinancialCouncilDispatchOperationInput & {
    readonly workspaceId: string; readonly dispatchId: string;
  }): Promise<FinancialCouncilDispatchLease | null> {
    return this.transaction(async (connection) => {
      const [seedRows] = await connection.query(
        `SELECT * FROM financial_council_dispatch_outbox
         WHERE workspace_id = ? AND dispatch_id = ? FOR UPDATE`,
        [input.workspaceId, input.dispatchId]
      );
      const seedRow = (seedRows as MysqlRow[])[0];
      if (!seedRow) return null;
      const seed = parseDispatch(seedRow);
      const [approvalRows] = await connection.query(
        `SELECT *, DATE_FORMAT(approved_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS approved_at FROM financial_council_approvals
         WHERE workspace_id = ? AND approval_id = ? FOR UPDATE`,
        [seed.workspaceId, seed.approvalId]
      );
      const approvalRow = (approvalRows as MysqlRow[])[0];
      if (!approvalRow || parseApproval(approvalRow).status !== "approved") {
        throw financialCouncilError("financial_council_dispatch_stale");
      }
      const [operationRows] = await connection.query(
        `SELECT operation_json FROM financial_council_dispatch_operations
         WHERE workspace_id = ? AND dispatch_id = ? FOR UPDATE`,
        [seed.workspaceId, seed.dispatchId]
      );
      const row = (operationRows as MysqlRow[])[0];
      const current = row ? jsonObject(row.operation_json) as unknown as FinancialCouncilDispatchOperation
        : createFinancialCouncilDispatchOperation({
            dispatchId: seed.dispatchId, workspaceId: seed.workspaceId,
            runId: seed.runId, approvalId: seed.approvalId,
            approvalHash: seed.approvalHash, portfolioRevision: seed.portfolioRevision,
            portfolioKind: seed.portfolioKind, actionId: seed.actionId,
            actionHash: seed.actionHash, resultHash: seed.resultHash,
            portfolioOutputHash: seed.portfolioOutputHash, createdAt: seed.createdAt
          });
      const claimed = claimFinancialCouncilDispatchOperation(current, input);
      if (!claimed) return null;
      if (row) {
        await connection.query(`UPDATE financial_council_dispatch_operations
          SET status = ?, attempt = ?, lease_token = ?, lease_expires_at = ?, operation_json = ?
          WHERE workspace_id = ? AND dispatch_id = ?`,
        [claimed.operation.status, claimed.operation.attempt, claimed.operation.leaseToken,
          sqlDate(claimed.operation.leaseExpiresAt!), canonical(claimed.operation),
          seed.workspaceId, seed.dispatchId]);
      } else {
        await connection.query(`INSERT INTO financial_council_dispatch_operations
          (workspace_id, dispatch_id, status, attempt, lease_token, lease_expires_at, operation_json, receipt_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        [seed.workspaceId, seed.dispatchId, claimed.operation.status,
          claimed.operation.attempt, claimed.operation.leaseToken,
          sqlDate(claimed.operation.leaseExpiresAt!), canonical(claimed.operation)]);
      }
      return claimed.lease;
    });
  }

  async getDispatchOperation(context: Pick<ActiveWorkspaceContext, "workspaceId">,
    dispatchId: string): Promise<FinancialCouncilDispatchOperation | null> {
    return this.transaction(async (connection) => {
      const [rows] = await connection.query(`SELECT operation_json
        FROM financial_council_dispatch_operations WHERE workspace_id = ? AND dispatch_id = ?`,
      [context.workspaceId, dispatchId]);
      const row = (rows as MysqlRow[])[0];
      return row ? jsonObject(row.operation_json) as unknown as FinancialCouncilDispatchOperation : null;
    }, true);
  }

  async loadDispatchAction(
    context: Pick<ActiveWorkspaceContext, "workspaceId">,
    dispatchId: string
  ): Promise<FinancialCouncilDispatchAction> {
    return this.transaction(async (connection) => {
      const [outboxRows] = await connection.query(
        `SELECT *,
           DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
           DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at
         FROM financial_council_dispatch_outbox
         WHERE workspace_id = ? AND dispatch_id = ?`,
        [context.workspaceId, dispatchId]
      );
      const outboxRow = (outboxRows as MysqlRow[])[0];
      const [operationRows] = await connection.query(
        `SELECT operation_json FROM financial_council_dispatch_operations
         WHERE workspace_id = ? AND dispatch_id = ?`,
        [context.workspaceId, dispatchId]
      );
      const operationRow = (operationRows as MysqlRow[])[0];
      if (!outboxRow || !operationRow) {
        throw financialCouncilError("financial_council_dispatch_stale");
      }
      const seed = parseDispatch(outboxRow);
      const operation = immutableFinancialCouncilValue(
        jsonObject(operationRow.operation_json)
      ) as unknown as FinancialCouncilDispatchOperation;
      const approval = await this.readApprovalByRun(
        connection, seed.workspaceId, seed.runId, false
      );
      const revision = await this.readPortfolioRevision(
        connection, seed.workspaceId, seed.runId,
        seed.portfolioRevision, false
      );
      if (!approval || approval.status !== "approved" || !revision) {
        throw financialCouncilError("financial_council_dispatch_stale");
      }
      await this.validatePortfolioRevision(connection, revision, false, true);
      const portfolio = revision.portfolios.find((row) =>
        row.kind === seed.portfolioKind
      );
      const action = portfolio?.actions.find((row) =>
        row.actionId === seed.actionId
      ) as FinancialCouncilCandidateAction | undefined;
      if (!portfolio || !action
        || approval.approvalId !== seed.approvalId
        || approval.approvalHash !== seed.approvalHash
        || !approval.approvedActionIds.includes(seed.actionId)
        || financialCouncilCanonicalHash(portfolio)
          !== seed.portfolioOutputHash
        || financialCouncilCanonicalHash(action) !== seed.actionHash
        || operation.dispatchId !== seed.dispatchId
        || operation.workspaceId !== seed.workspaceId
        || operation.runId !== seed.runId
        || operation.approvalId !== seed.approvalId
        || operation.approvalHash !== seed.approvalHash
        || operation.portfolioRevision !== seed.portfolioRevision
        || operation.portfolioKind !== seed.portfolioKind
        || operation.actionId !== seed.actionId
        || operation.actionHash !== seed.actionHash
        || operation.resultHash !== seed.resultHash
        || operation.portfolioOutputHash !== seed.portfolioOutputHash) {
        throw financialCouncilError("financial_council_dispatch_stale");
      }
      return immutableFinancialCouncilValue({ operation, action });
    }, true);
  }

  async completeDispatchOperation(lease: FinancialCouncilDispatchLease,
    receipt: FinancialCouncilDispatchReceipt, completedAt: string): Promise<void> {
    await this.transaction(async (connection) => {
      const operation = await this.readDispatchOperation(connection, lease, true);
      if (receipt.dispatchId !== operation.dispatchId || receipt.workspaceId !== operation.workspaceId
        || receipt.dispatchHash !== operation.dispatchHash) {
        throw financialCouncilError("financial_council_dispatch_receipt_invalid");
      }
      const next = completeFinancialCouncilDispatchOperation(operation, {
        workerId: lease.workerId, leaseToken: lease.leaseToken, attempt: lease.attempt,
        completedAt, receiptId: receipt.receiptId
      });
      await this.saveDispatchOperation(connection, next, receipt);
    });
  }

  async failDispatchOperation(lease: FinancialCouncilDispatchLease, input: {
    readonly errorCode: string; readonly retryable: boolean; readonly completedAt: string;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      const operation = await this.readDispatchOperation(connection, lease, true);
      const next = failFinancialCouncilDispatchOperation(operation, {
        workerId: lease.workerId, leaseToken: lease.leaseToken, attempt: lease.attempt,
        ...input
      });
      await this.saveDispatchOperation(connection, next, null);
    });
  }

  async listRecoverableDispatches(now: string, limit: number): Promise<readonly {
    workspaceId: string; dispatchId: `sha256:${string}`;
  }[]> {
    return this.transaction(async (connection) => {
      const [rows] = await connection.query(`SELECT o.workspace_id, o.dispatch_id
        FROM financial_council_dispatch_outbox o
        LEFT JOIN financial_council_dispatch_operations p
          ON p.workspace_id = o.workspace_id AND p.dispatch_id = o.dispatch_id
        WHERE p.dispatch_id IS NULL OR p.status IN ('queued','retry')
          OR (p.status = 'running' AND p.lease_expires_at <= ?)
        ORDER BY BINARY o.workspace_id, BINARY o.dispatch_id LIMIT ?`,
      [sqlDate(now), limit]);
      return Object.freeze((rows as MysqlRow[]).map((row) => Object.freeze({
        workspaceId: rowString(row, "workspace_id"),
        dispatchId: rowString(row, "dispatch_id") as `sha256:${string}`
      })));
    }, true);
  }

  private async readDispatchOperation(connection: mysql.PoolConnection,
    lease: FinancialCouncilDispatchLease, lock: boolean): Promise<FinancialCouncilDispatchOperation> {
    const [rows] = await connection.query(`SELECT operation_json
      FROM financial_council_dispatch_operations WHERE workspace_id = ? AND dispatch_id = ?${lock ? " FOR UPDATE" : ""}`,
    [lease.workspaceId, lease.dispatchId]);
    const row = (rows as MysqlRow[])[0];
    if (!row) throw financialCouncilError("financial_council_dispatch_not_found");
    return jsonObject(row.operation_json) as unknown as FinancialCouncilDispatchOperation;
  }

  private async saveDispatchOperation(connection: mysql.PoolConnection,
    operation: FinancialCouncilDispatchOperation, receipt: FinancialCouncilDispatchReceipt | null): Promise<void> {
    await connection.query(`UPDATE financial_council_dispatch_operations
      SET status = ?, attempt = ?, lease_token = ?, lease_expires_at = ?, operation_json = ?, receipt_json = COALESCE(?, receipt_json)
      WHERE workspace_id = ? AND dispatch_id = ?`,
    [operation.status, operation.attempt, operation.leaseToken,
      operation.leaseExpiresAt === null ? null : sqlDate(operation.leaseExpiresAt),
      canonical(operation), receipt === null ? null : canonical(receipt),
      operation.workspaceId, operation.dispatchId]);
  }

  async publishPortfolioRevisionWithLease(
    lease: FinancialCouncilAnalysisLease,
    input: PublishFinancialCouncilPortfolioRevisionInput
  ): Promise<FinancialCouncilCommandResult<FinancialCouncilRun>> {
    return this.transaction(async (connection) => {
      const control = await this.assertLiveAnalysisLease(
        connection, lease, input.occurredAt
      );
      if (input.revision !== 1 || !HASH.test(input.expectedOutputHash)) {
        throw financialCouncilError("financial_council_portfolio_invalid");
      }
      const current = await this.findByRunId(
        connection, lease.workspaceId, lease.runId, true
      );
      if (!current || current.status !== "optimizing") {
        throw financialCouncilError("financial_council_portfolio_state_invalid");
      }
      const revision = await this.readPortfolioRevision(
        connection, lease.workspaceId, lease.runId, input.revision, true
      );
      if (!revision) {
        throw financialCouncilError("financial_council_portfolio_not_found");
      }
      await this.validatePortfolioRevision(connection, revision, true, true);
      if (revision.outputHash !== input.expectedOutputHash) {
        throw financialCouncilError("financial_council_portfolio_integrity");
      }
      const consensus = await this.readConsensus(
        connection, lease.workspaceId, lease.runId, true
      );
      if (!consensus || consensus.reportId !== revision.consensusReportId) {
        integrity();
      }
      const attached = immutableFinancialCouncilValue({
        ...current,
        consensusReport: consensus,
        portfolios: revision.portfolios,
        latestPortfolioRevision: revision.revision
      });
      const next = applyFinancialCouncilTransition(attached, {
        kind: "awaiting_approval",
        occurredAt: input.occurredAt,
        actorId: control.ownerId
      });
      await this.updateRun(connection, current, next);
      await this.appendEvent(connection, createFinancialCouncilRunEvent(next, {
        fromStatus: current.status,
        reasonCode: null,
        occurredAt: input.occurredAt,
        actorId: control.ownerId
      }));
      return { value: next, replayed: false };
    });
  }

  private replay(
    existing: FinancialCouncilRun,
    requestHash: string
  ): FinancialCouncilCommandResult<FinancialCouncilRun> {
    if (existing.requestHash !== requestHash) {
      throw financialCouncilError("financial_council_idempotency_conflict");
    }
    return { value: existing, replayed: true };
  }

  private async readPortfolioRevision(
    source: Pick<mysql.Pool, "query">,
    workspaceId: string,
    runId: string,
    revision: number,
    lock: boolean
  ): Promise<FinancialCouncilPortfolioRevision | null> {
    const [rows] = await source.query(
      `SELECT workspace_id, run_id, revision, revision_id, run_hash,
              snapshot_id, snapshot_hash, audit_hash, policy_version_id,
              policy_hash, consensus_report_id, candidate_set_hash,
              output_hash, revision_json,
              DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
       FROM financial_council_portfolio_revisions
       WHERE workspace_id = ? AND run_id = ? AND revision = ?`
        + (lock ? " FOR UPDATE" : ""),
      [workspaceId, runId, revision]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parsePortfolioRevision(row) : null;
  }

  private async readApprovalByRun(
    source: Pick<mysql.Pool, "query">,
    workspaceId: string,
    runId: string,
    lock: boolean
  ): Promise<FinancialCouncilApprovalRecord | null> {
    const [rows] = await source.query(
      `SELECT *, DATE_FORMAT(approved_at, '%Y-%m-%dT%H:%i:%s.%fZ')
         AS approved_at
       FROM financial_council_approvals
       WHERE workspace_id = ? AND run_id = ?${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, runId]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parseApproval(row) : null;
  }

  private async readAllSpecialistResults(
    source: Pick<mysql.Pool, "query">,
    workspaceId: string,
    runId: string
  ): Promise<readonly FinancialCouncilSpecialistResult[]> {
    const [rows] = await source.query(
      `SELECT workspace_id, run_id, role, phase, result_id, snapshot_id,
              snapshot_hash, result_hash, result_json,
              DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
       FROM financial_council_specialist_results
       WHERE workspace_id = ? AND run_id = ?
       ORDER BY CASE role
         WHEN 'finance' THEN 1 WHEN 'profit' THEN 2 WHEN 'cost' THEN 3
         WHEN 'cashflow' THEN 4 WHEN 'tax' THEN 5 ELSE 6 END, phase ASC`,
      [workspaceId, runId]
    );
    const results: FinancialCouncilSpecialistResult[] = [];
    for (const row of rows as MysqlRow[]) {
      results.push(await this.readSpecialistResultByRow(source, row));
    }
    return Object.freeze(results);
  }

  private async validatePortfolioRevision(
    source: Pick<mysql.Pool, "query">,
    rawRevision: FinancialCouncilPortfolioRevision,
    lock: boolean,
    stored: boolean
  ): Promise<FinancialCouncilPortfolioRevision> {
    try {
      const { revisionId: _revisionId, outputHash: _outputHash, ...input } =
        immutableFinancialCouncilValue(rawRevision);
      const revision = createFinancialCouncilPortfolioRevision(input);
      if (canonical(revision) !== canonical(rawRevision)) {
        throw financialCouncilError("financial_council_portfolio_invalid");
      }
      const run = await this.findByRunId(
        source, revision.workspaceId, revision.runId, lock
      );
      const consensus = await this.readConsensus(
        source, revision.workspaceId, revision.runId, lock
      );
      const graph = await this.readAuditGraph(
        source, revision.workspaceId, revision.runId, lock
      );
      const results = await this.readAllSpecialistResults(
        source, revision.workspaceId, revision.runId
      );
      if (!run || !consensus || !graph) {
        throw financialCouncilError("financial_council_portfolio_invalid");
      }
      const candidates = selectFinancialCouncilOptimizationCandidates(
        consensus, results
      );
      if (revision.runHash !== financialCouncilOptimizationRunHash(run)
        || revision.snapshotId !== run.snapshotId
        || revision.snapshotHash !== run.snapshotHash
        || revision.auditHash !== graph.graphHash
        || revision.policyVersionId !== run.policyVersionId
        || revision.consensusReportId !== consensus.reportId
        || revision.candidateSetHash !== financialCouncilCanonicalHash(candidates)
        || Date.parse(revision.createdAt) < Date.parse(consensus.createdAt)
        || Date.parse(revision.createdAt) > Date.parse(run.expiresAt)) {
        throw financialCouncilError("financial_council_portfolio_invalid");
      }
      const byId = new Map(candidates.map((action) => [action.actionId, action]));
      for (const portfolio of revision.portfolios) {
        for (const action of portfolio.actions) {
          const original = byId.get(action.actionId);
          if (!original || !financialCouncilActionEditIsSafe(original, action)) {
            throw financialCouncilError("financial_council_portfolio_invalid");
          }
        }
      }
      return revision;
    } catch (error) {
      if (stored) integrity();
      if ((error as { code?: unknown } | null)?.code
        === "financial_council_portfolio_invalid") throw error;
      throw financialCouncilError("financial_council_portfolio_invalid");
    }
  }

  private async validateConsensus(
    connection: mysql.PoolConnection,
    context: ActiveWorkspaceContext,
    report: ConsensusReport,
    lock: boolean,
    stored: boolean
  ): Promise<ConsensusReport> {
    try {
      const run = await this.findByRunId(
        connection, context.workspaceId, report.runId, lock
      );
      const graph = await this.readAuditGraph(
        connection, context.workspaceId, report.runId, lock
      );
      if (!run || !graph) {
        if (stored) integrity();
        throw financialCouncilError("financial_council_consensus_invalid");
      }
      await this.verifyStoredRun(connection, run);
      const [snapshotRows] = await connection.query(
        `${SNAPSHOT_SELECT}
         WHERE workspace_id = ? AND run_id = ?${lock ? " FOR UPDATE" : ""}`,
        [context.workspaceId, report.runId]
      );
      const snapshotRow = (snapshotRows as MysqlRow[])[0];
      if (!snapshotRow) integrity();
      const snapshot = parseSnapshot(snapshotRow);
      const [dispositionRows] = await connection.query(
        `SELECT * FROM financial_council_finding_dispositions
         WHERE workspace_id = ? AND run_id = ?
         ORDER BY BINARY finding_id ASC${lock ? " FOR UPDATE" : ""}`,
        [context.workspaceId, report.runId]
      );
      const dispositions = (dispositionRows as MysqlRow[])
        .map(parseDispositionRow);
      const [resultRows] = await connection.query(
        `SELECT workspace_id, run_id, role, phase, result_id, snapshot_id,
                snapshot_hash, result_hash, result_json,
                DATE_FORMAT(created_at,
                  '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
         FROM financial_council_specialist_results
         WHERE workspace_id = ? AND run_id = ?
         ORDER BY CASE role
           WHEN 'finance' THEN 1 WHEN 'profit' THEN 2 WHEN 'cost' THEN 3
           WHEN 'cashflow' THEN 4 WHEN 'tax' THEN 5 ELSE 6 END, phase ASC`,
        [context.workspaceId, report.runId]
      );
      const results: FinancialCouncilSpecialistResult[] = [];
      for (const row of resultRows as MysqlRow[]) {
        results.push(await this.readSpecialistResultByRow(connection, row));
      }
      return validateFinancialCouncilConsensusReport(report, {
        graph,
        findings: results.filter((result) => result.phase === "analyze")
          .flatMap((result) => result.findings),
        dispositions,
        dataGaps: validateFinancialSnapshotForRun(
          snapshot.snapshot, run
        ).dataGaps,
        earliestCreatedAt: snapshot.createdAt,
        expiresAt: run.expiresAt
      });
    } catch (error) {
      if (stored) integrity();
      throw error;
    }
  }

  private async readConsensus(
    source: Pick<mysql.Pool, "query">,
    workspaceId: string,
    runId: string,
    lock: boolean
  ): Promise<ConsensusReport | null> {
    const [rows] = await source.query(
      `SELECT workspace_id, run_id, snapshot_id, audit_hash, report_id,
              report_json,
              DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
       FROM financial_council_consensus_reports
       WHERE workspace_id = ? AND run_id = ?${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, runId]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parseConsensusRow(row) : null;
  }

  private async readAuditGraph(
    source: Pick<mysql.Pool, "query">,
    workspaceId: string,
    runId: string,
    lock: boolean
  ): Promise<FinancialCouncilAuditGraph | null> {
    const [rows] = await source.query(
      `SELECT * FROM financial_council_audit_graphs
       WHERE workspace_id = ? AND run_id = ?${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, runId]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parseAuditGraphRow(row) : null;
  }

  private async readRebuttalAttempt(
    source: Pick<mysql.Pool, "query">,
    workspaceId: string,
    runId: string,
    role: FinancialCouncilAgentRole,
    round: number,
    lock: boolean
  ): Promise<FinancialCouncilRebuttalAttempt | null> {
    const [rows] = await source.query(
      `SELECT * FROM financial_council_rebuttal_attempts
       WHERE workspace_id = ? AND run_id = ? AND role = ?
         AND round_number = ?${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, runId, role, round]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parseRebuttalAttemptRow(row) : null;
  }

  private async readSpecialistResult(
    source: Pick<mysql.Pool, "query">,
    workspaceId: string,
    runId: string,
    role: FinancialCouncilAgentRole,
    phase: FinancialCouncilSpecialistPhase,
    lock: boolean
  ): Promise<FinancialCouncilSpecialistResult | null> {
    const [rows] = await source.query(
      `SELECT workspace_id, run_id, role, phase, result_id, snapshot_id,
              snapshot_hash, result_hash, result_json,
              DATE_FORMAT(created_at,
                '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
       FROM financial_council_specialist_results
       WHERE workspace_id = ? AND run_id = ? AND role = ? AND phase = ?`
        + (lock ? " FOR UPDATE" : ""),
      [workspaceId, runId, role, phase]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? this.readSpecialistResultByRow(source, row) : null;
  }

  private async readSpecialistResultByRow(
    source: Pick<mysql.Pool, "query">,
    row: MysqlRow
  ): Promise<FinancialCouncilSpecialistResult> {
    const values = [rowString(row, "workspace_id"), rowString(row, "run_id"),
      rowString(row, "role"), rowString(row, "phase")];
    const [findingRows] = await source.query(
      `SELECT * FROM financial_council_findings
       WHERE workspace_id = ? AND run_id = ? AND role = ? AND phase = ?
       ORDER BY BINARY finding_id ASC`, values
    );
    const [actionRows] = await source.query(
      `SELECT * FROM financial_council_candidate_actions
       WHERE workspace_id = ? AND run_id = ? AND role = ? AND phase = ?
       ORDER BY BINARY action_id ASC`, values
    );
    return parseSpecialistResult(
      row, findingRows as MysqlRow[], actionRows as MysqlRow[]
    );
  }

  private async readVerifiedFrozenByCreationKey(
    connection: mysql.PoolConnection,
    workspaceId: string,
    creationKeyHash: string,
    requestHash: string,
    lock: boolean
  ): Promise<FinancialCouncilRun | null> {
    const existing = await this.findByCreationKey(
      connection, workspaceId, creationKeyHash, lock
    );
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw financialCouncilError("financial_council_idempotency_conflict");
    }
    if (existing.status === "created" || existing.revision < 2
      || existing.snapshotId === null || existing.snapshotHash === null) {
      integrity();
    }
    await this.verifyStoredRun(connection, existing);
    return existing;
  }

  private async verifyStoredRun(
    source: Pick<mysql.Pool, "query">,
    run: FinancialCouncilRun,
    suppliedEventRows?: readonly MysqlRow[]
  ): Promise<readonly FinancialCouncilRunEvent[]> {
    const eventRows = suppliedEventRows ?? (await source.query(
      `${EVENT_SELECT}
       WHERE workspace_id = ? AND run_id = ? ORDER BY revision ASC`,
      [run.workspaceId, run.runId]
    ))[0] as MysqlRow[];
    const events = Object.freeze(eventRows.map(parseEvent));
    assertFinancialCouncilRunHistory(
      runBeforePortfolioEditOverlay(run, events), events, integrity
    );
    let snapshotRecord: FinancialSnapshotRecord | null = null;
    if (run.snapshotId !== null) {
      const [snapshotRows] = await source.query(
        `${SNAPSHOT_SELECT}
         WHERE workspace_id = ? AND run_id = ?`,
        [run.workspaceId, run.runId]
      );
      const snapshotRow = (snapshotRows as MysqlRow[])[0];
      if (!snapshotRow) integrity();
      snapshotRecord = parseSnapshot(snapshotRow);
      assertStoredSnapshot(run, snapshotRecord, events);
    } else if (run.status !== "created") {
      integrity();
    }
    if (run.latestPortfolioRevision !== null) {
      const revision = await this.readPortfolioRevision(
        source, run.workspaceId, run.runId, run.latestPortfolioRevision, false
      );
      if (!revision) integrity();
      await this.validatePortfolioRevision(source, revision, false, true);
      const consensus = await this.readConsensus(
        source, run.workspaceId, run.runId, false
      );
      if (!consensus
        || canonical(run.consensusReport) !== canonical(consensus)
        || canonical(run.portfolios) !== canonical(revision.portfolios)
        || revision.consensusReportId !== consensus.reportId) integrity();
      const graph = await this.readAuditGraph(
        source, run.workspaceId, run.runId, false
      );
      const [dispositionRows] = await source.query(
        `SELECT * FROM financial_council_finding_dispositions
         WHERE workspace_id = ? AND run_id = ?
         ORDER BY BINARY finding_id ASC`,
        [run.workspaceId, run.runId]
      );
      const results = await this.readAllSpecialistResults(
        source, run.workspaceId, run.runId
      );
      if (!graph || !snapshotRecord) integrity();
      try {
        validateFinancialCouncilConsensusReport(consensus, {
          graph,
          findings: results.filter((result) => result.phase === "analyze")
            .flatMap((result) => result.findings),
          dispositions: (dispositionRows as MysqlRow[])
            .map(parseDispositionRow),
          dataGaps: validateFinancialSnapshotForRun(
            snapshotRecord.snapshot, run
          ).dataGaps,
          earliestCreatedAt: snapshotRecord.createdAt,
          expiresAt: run.expiresAt
        });
      } catch {
        integrity();
      }
    }
    return events;
  }

  private async readVerifiedHistory(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<{
    readonly run: FinancialCouncilRun;
    readonly events: readonly FinancialCouncilRunEvent[];
  } | null> {
    return this.transaction(async (connection) => {
      const [runRows] = await connection.query(
        `SELECT * FROM financial_council_runs
         WHERE workspace_id = ? AND run_id = ?`,
        [context.workspaceId, runId]
      );
      const [eventRows] = await connection.query(
        `${EVENT_SELECT}
         WHERE workspace_id = ? AND run_id = ? ORDER BY revision ASC`,
        [context.workspaceId, runId]
      );
      const runRow = (runRows as MysqlRow[])[0];
      const rawEvents = eventRows as MysqlRow[];
      if (!runRow) {
        if (rawEvents.length !== 0) integrity();
        return null;
      }
      const run = parseRun(runRow);
      const events = await this.verifyStoredRun(connection, run, rawEvents);
      return Object.freeze({ run, events });
    }, true);
  }

  private async findByCreationKey(
    source: Pick<mysql.Pool, "query">,
    workspaceId: string,
    creationKeyHash: string,
    lock: boolean
  ): Promise<FinancialCouncilRun | null> {
    const [rows] = await source.query(
      `SELECT * FROM financial_council_runs
       WHERE workspace_id = ? AND creation_key_hash = ?${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, creationKeyHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parseRun(row) : null;
  }

  private async readAnalysisControl(
    source: Pick<mysql.Pool, "query">,
    workspaceId: string,
    runId: string,
    lock: boolean
  ): Promise<FinancialCouncilAnalysisControl | null> {
    const [rows] = await source.query(
      `SELECT * FROM financial_council_analysis_controls
       WHERE workspace_id = ? AND run_id = ?${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, runId]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parseAnalysisControl(row) : null;
  }

  private async assertLiveAnalysisLease(
    source: Pick<mysql.Pool, "query">,
    lease: FinancialCouncilAnalysisLease,
    completedAt: string
  ): Promise<FinancialCouncilAnalysisControl> {
    const control = await this.readAnalysisControl(
      source, lease.workspaceId, lease.runId, true
    );
    const current = control?.lease;
    if (!control || !current || current.workerId !== lease.workerId
      || current.leaseToken !== lease.leaseToken
      || current.attempt !== lease.attempt
      || current.claimedAt !== lease.claimedAt
      || current.leaseExpiresAt !== lease.leaseExpiresAt
      || Date.parse(completedAt) >= Date.parse(current.leaseExpiresAt)) {
      throw financialCouncilError("financial_council_lease_stale");
    }
    return control;
  }

  private async findByRunId(
    source: Pick<mysql.Pool, "query">,
    workspaceId: string,
    runId: string,
    lock: boolean
  ): Promise<FinancialCouncilRun | null> {
    const [rows] = await source.query(
      `SELECT * FROM financial_council_runs
       WHERE workspace_id = ? AND run_id = ?${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, runId]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parseRun(row) : null;
  }

  private async updateRun(
    connection: mysql.PoolConnection,
    current: FinancialCouncilRun,
    next: FinancialCouncilRun
  ): Promise<void> {
    const [result] = await connection.query(
      `UPDATE financial_council_runs
       SET revision = ?, status = ?, snapshot_id = ?, snapshot_hash = ?,
         run_json = ?
       WHERE workspace_id = ? AND run_id = ? AND revision = ?`,
      [next.revision, next.status, next.snapshotId, next.snapshotHash,
        canonical(next), next.workspaceId, next.runId, current.revision]
    );
    if (affectedRows(result) !== 1) {
      throw financialCouncilError("financial_council_revision_conflict");
    }
  }

  private async appendEvent(
    connection: mysql.PoolConnection,
    event: FinancialCouncilRunEvent
  ): Promise<void> {
    await connection.query(
      `INSERT INTO financial_council_run_events (
         event_id, run_id, workspace_id, revision, from_status, to_status,
         reason_code, occurred_at, actor_id, aggregate_snapshot_hash,
         aggregate_snapshot_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.eventId, event.runId, event.workspaceId, event.revision,
        event.fromStatus, event.toStatus, event.reasonCode,
        sqlDate(event.occurredAt), event.actorId, event.aggregateSnapshotHash,
        canonical(event.aggregateSnapshot)]
    );
  }

  private async transaction<T>(
    work: (connection: mysql.PoolConnection) => Promise<T>,
    consistentSnapshot = false
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    let poisoned = false;
    try {
      if (consistentSnapshot) {
        await connection.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"
        );
      }
      await connection.beginTransaction();
      try {
        const result = await work(connection);
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          poison(connection);
          poisoned = true;
        }
        throw error;
      }
    } finally {
      if (!poisoned) connection.release();
    }
  }
}
