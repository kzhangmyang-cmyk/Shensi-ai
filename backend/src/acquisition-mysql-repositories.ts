import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import type {
  AcquisitionAuditEvent as DomainAuditEvent,
  AcquisitionCandidate,
  AcquisitionCandidateIdentityAlias,
  BattleCard,
  DiscoveryEvidence,
  FinancialValueDecision,
  IdempotencyRecord as DomainIdempotencyRecord,
  LeadConversionIntent,
  LeadConversionRecord,
  LiveOutcomeFeedbackEvent,
  OutcomeFeedbackEvent,
  QualificationDecision,
  ResearchAttempt,
  ReviewEvent
} from "./acquisition-domain.js";
import type {
  AcquisitionCandidateListPage,
  AcquisitionCandidateListQuery,
  AcquisitionDataScope,
  AcquisitionDomainRepository,
  AcquisitionPresentationCandidateSnapshot,
  AcquisitionPresentationCandidateSummary,
  AcquisitionPresentationEventCursor
} from "./acquisition-domain-repository.js";
import {
  releaseAcquisitionMysqlConnection,
  releaseAcquisitionMysqlNamedLocks
} from "./acquisition-mysql-named-lock.js";
import type {
  AcquisitionCopilotIdempotencyRecord,
  AcquisitionCopilotMessage,
  AcquisitionCopilotRepository,
  AcquisitionCopilotScope,
  AcquisitionCopilotSession,
  AcquisitionCopilotTask
} from "./acquisition-copilot-service.js";
import type {
  AcquisitionAuditEvent,
  AcquisitionExecutionIntent,
  AcquisitionIdempotencyRecord,
  AcquisitionOperationShard,
  AcquisitionPlan,
  AcquisitionPlanEvent,
  AcquisitionPlanRunRepository,
  AcquisitionPlanRunRepositoryTransaction,
  AcquisitionPlanVersion,
  AcquisitionRun,
  AcquisitionRunListQuery,
  AcquisitionRunCandidateLink,
  AcquisitionRunEvent,
  AcquisitionRunEventPageQuery,
  AcquisitionRunPresentationExecution,
  AcquisitionUsageIdempotencyRecord
} from "./acquisition-plan-run-repository.js";
import {
  intentNeedsRecovery
} from "./acquisition-plan-run-repository.js";
import type {
  QualificationBundleCommit,
  QualificationBundleResult
} from "./acquisition-domain-repository.js";
import {
  MysqlGrowthTemporalBarrier,
  MysqlGrowthTemporalTransaction,
  growthMysqlDate
} from "./growth-temporal-barrier-mysql-repository.js";
import {
  assertGrowthTemporalBarrier,
  type GrowthTemporalBarrier
} from "./growth-temporal-barrier.js";
import type {
  MysqlAdvisorCandidateAuthorityRepository
} from "./growth-advisor-candidate-authority-mysql-repository.js";

type QuerySource = Pick<mysql.Pool | mysql.PoolConnection, "query">;
type Scope = Pick<AcquisitionCopilotScope, "ownerId" | "teamId">;
type MysqlRow = Record<string, unknown>;

export const ACQUISITION_EVIDENCE_ID_SQL_WIDTH = 255;

const SENSITIVE_KEY =
  /(?:password|authorization|(?:api|secret|private)[_-]?key|(?:access|refresh|bearer)[_-]?token|client[_-]?secret|credential[_-]?plaintext)$/i;

export const ACQUISITION_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS acquisition_discovery_evidence (
    id VARCHAR(255) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_evidence_scope (owner_id, team_id, id),
    KEY idx_acquisition_evidence_scope_time (owner_id, team_id, created_at, id)
  ) ENGINE=InnoDB`,
  `ALTER TABLE acquisition_discovery_evidence
    MODIFY COLUMN id VARCHAR(255) NOT NULL`,
  `CREATE TABLE IF NOT EXISTS acquisition_candidates (
    id VARCHAR(120) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_candidate_scope (owner_id, team_id, id),
    KEY idx_acquisition_candidate_scope_time (owner_id, team_id, updated_at, id),
    CONSTRAINT chk_acquisition_candidate_version CHECK (version >= 1)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_candidate_identity_aliases (
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    dedupe_key_hash CHAR(64) NOT NULL,
    candidate_id VARCHAR(120) NOT NULL,
    party_type VARCHAR(20) NOT NULL,
    basis VARCHAR(40) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (owner_id, team_id, dedupe_key_hash),
    KEY idx_acquisition_identity_alias_candidate
      (owner_id, team_id, candidate_id, created_at),
    CONSTRAINT fk_acquisition_identity_alias_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_acquisition_identity_alias_party_type
      CHECK (party_type IN ('organization','individual')),
    CONSTRAINT chk_acquisition_identity_alias_basis CHECK (
      basis IN (
        'organization_domain',
        'organization_credit_code',
        'provider_public_actor'
      )
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_qualification_decisions (
    id VARCHAR(120) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    candidate_id VARCHAR(120) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_qualification_scope (owner_id, team_id, id),
    KEY idx_acquisition_qualification_candidate
      (owner_id, team_id, candidate_id, created_at, id),
    CONSTRAINT fk_acquisition_qualification_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_financial_values (
    id VARCHAR(120) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    candidate_id VARCHAR(120) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_financial_scope (owner_id, team_id, id),
    KEY idx_acquisition_financial_candidate
      (owner_id, team_id, candidate_id, created_at, id),
    CONSTRAINT fk_acquisition_financial_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_battle_cards (
    id VARCHAR(120) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    candidate_id VARCHAR(120) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_battle_card_scope (owner_id, team_id, id),
    KEY idx_acquisition_battle_card_candidate
      (owner_id, team_id, candidate_id, created_at, id),
    CONSTRAINT fk_acquisition_battle_card_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_review_events (
    id VARCHAR(120) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    candidate_id VARCHAR(120) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_review_scope (owner_id, team_id, id),
    UNIQUE KEY uk_acquisition_review_idempotency
      (owner_id, team_id, candidate_id, idempotency_key_hash),
    KEY idx_acquisition_review_candidate
      (owner_id, team_id, candidate_id, created_at, id),
    CONSTRAINT fk_acquisition_review_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_research_attempts (
    id VARCHAR(120) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    candidate_id VARCHAR(120) NOT NULL,
    status VARCHAR(30) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_research_scope (owner_id, team_id, id),
    KEY idx_acquisition_research_candidate
      (owner_id, team_id, candidate_id, created_at, id),
    CONSTRAINT fk_acquisition_research_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_acquisition_research_status CHECK (
      status IN (
        'pending','running','completed','no_new_evidence',
        'access_restricted','failed'
      )
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_conversion_intents (
    id VARCHAR(120) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    candidate_id VARCHAR(120) NOT NULL,
    status VARCHAR(30) NOT NULL,
    attempt_count BIGINT UNSIGNED NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    completed_at DATETIME(3) NULL,
    UNIQUE KEY uk_acquisition_conversion_intent_scope
      (owner_id, team_id, id),
    UNIQUE KEY uk_acquisition_conversion_intent_candidate
      (owner_id, team_id, candidate_id),
    UNIQUE KEY uk_acquisition_conversion_intent_idempotency
      (owner_id, team_id, idempotency_key_hash),
    KEY idx_acquisition_conversion_intent_recovery
      (status, updated_at, id),
    CONSTRAINT fk_acquisition_conversion_intent_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_acquisition_conversion_intent_status CHECK (
      status IN ('pending_crm','crm_committed','completed')
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_conversions (
    id VARCHAR(120) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    candidate_id VARCHAR(120) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_conversion_scope (owner_id, team_id, id),
    UNIQUE KEY uk_acquisition_conversion_candidate
      (owner_id, team_id, candidate_id),
    UNIQUE KEY uk_acquisition_conversion_idempotency
      (owner_id, team_id, idempotency_key_hash),
    CONSTRAINT fk_acquisition_conversion_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_outcomes (
    id VARCHAR(120) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    candidate_id VARCHAR(120) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    payload_json JSON NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_outcome_scope (owner_id, team_id, id),
    UNIQUE KEY uk_acquisition_outcome_idempotency
      (owner_id, team_id, idempotency_key_hash),
    KEY idx_acquisition_outcome_candidate
      (owner_id, team_id, candidate_id, occurred_at, id),
    CONSTRAINT fk_acquisition_outcome_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_domain_audit_events (
    id VARCHAR(120) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    candidate_id VARCHAR(120) NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_domain_audit_scope (owner_id, team_id, id),
    KEY idx_acquisition_domain_audit_candidate
      (owner_id, team_id, candidate_id, created_at, id),
    CONSTRAINT fk_acquisition_domain_audit_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_domain_idempotency (
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    operation_name VARCHAR(120) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (owner_id, team_id, operation_name, idempotency_key_hash),
    UNIQUE KEY uk_acquisition_domain_idempotency
      (owner_id, team_id, operation_name, idempotency_key_hash)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_copilot_sessions (
    id VARCHAR(160) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    actor_id VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    completed_at DATETIME(3) NULL,
    UNIQUE KEY uk_acquisition_copilot_session_scope (owner_id, team_id, id),
    KEY idx_acquisition_copilot_session_scope
      (owner_id, team_id, updated_at, id),
    CONSTRAINT chk_acquisition_copilot_session_status
      CHECK (status IN ('active','completed','failed'))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_copilot_tasks (
    id VARCHAR(160) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    actor_id VARCHAR(100) NOT NULL,
    session_id VARCHAR(160) NOT NULL,
    status VARCHAR(20) NOT NULL,
    payload_json JSON NOT NULL,
    dispatch_claimed_at DATETIME(3) NULL,
    dispatch_lease_until DATETIME(3) NULL,
    dispatch_attempts BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL,
    started_at DATETIME(3) NULL,
    completed_at DATETIME(3) NULL,
    UNIQUE KEY uk_acquisition_copilot_task_scope (owner_id, team_id, id),
    KEY idx_acquisition_copilot_task_session
      (owner_id, team_id, session_id, created_at, id),
    KEY idx_acquisition_copilot_task_dispatch
      (owner_id, team_id, status, dispatch_lease_until, id),
    CONSTRAINT fk_acquisition_copilot_task_session
      FOREIGN KEY (owner_id, team_id, session_id)
      REFERENCES acquisition_copilot_sessions (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_acquisition_copilot_task_status CHECK (
      status IN ('queued','running','succeeded','failed','cancelled')
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_copilot_messages (
    id VARCHAR(160) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    session_id VARCHAR(160) NOT NULL,
    sequence_no BIGINT UNSIGNED NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_copilot_message_scope (owner_id, team_id, id),
    UNIQUE KEY uk_acquisition_copilot_message_sequence
      (owner_id, team_id, session_id, sequence_no),
    KEY idx_acquisition_copilot_message_session
      (owner_id, team_id, session_id, sequence_no, id),
    CONSTRAINT fk_acquisition_copilot_message_session
      FOREIGN KEY (owner_id, team_id, session_id)
      REFERENCES acquisition_copilot_sessions (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_acquisition_copilot_message_sequence CHECK (sequence_no >= 1)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_copilot_idempotency (
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    operation_name VARCHAR(40) NOT NULL,
    key_hash CHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (owner_id, team_id, operation_name, key_hash),
    UNIQUE KEY uk_acquisition_copilot_idempotency
      (owner_id, team_id, operation_name, key_hash)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_plan_run_transaction_guard (
    id TINYINT PRIMARY KEY,
    updated_at DATETIME(3) NOT NULL,
    CONSTRAINT chk_acquisition_plan_run_guard CHECK (id = 1)
  ) ENGINE=InnoDB`,
  `INSERT INTO acquisition_plan_run_transaction_guard (id, updated_at)
   VALUES (1, UTC_TIMESTAMP(3))
   ON DUPLICATE KEY UPDATE id = VALUES(id)`,
  `CREATE TABLE IF NOT EXISTS acquisition_plans (
    id VARCHAR(160) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_plan_scope (owner_id, team_id, id),
    KEY idx_acquisition_plan_scope (owner_id, team_id, updated_at, id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_plan_versions (
    id VARCHAR(160) PRIMARY KEY,
    plan_id VARCHAR(160) NOT NULL,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    version_no BIGINT UNSIGNED NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_plan_version_scope (owner_id, team_id, id),
    UNIQUE KEY uk_acquisition_plan_version_number
      (owner_id, team_id, plan_id, version_no),
    UNIQUE KEY uk_acquisition_plan_version_identity
      (owner_id, team_id, plan_id, id),
    KEY idx_acquisition_plan_version_plan
      (owner_id, team_id, plan_id, version_no, id),
    CONSTRAINT fk_acquisition_plan_version_plan
      FOREIGN KEY (owner_id, team_id, plan_id)
      REFERENCES acquisition_plans (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_runs (
    id VARCHAR(160) PRIMARY KEY,
    plan_id VARCHAR(160) NOT NULL,
    plan_version_id VARCHAR(160) NOT NULL,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    plan_snapshot_hash CHAR(64) NOT NULL,
    budget_snapshot_hash CHAR(64) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    completed_at DATETIME(3) NULL,
    UNIQUE KEY uk_acquisition_run_scope (owner_id, team_id, id),
    KEY idx_acquisition_run_plan (owner_id, team_id, plan_id, created_at, id),
    CONSTRAINT fk_acquisition_run_plan
      FOREIGN KEY (owner_id, team_id, plan_id)
      REFERENCES acquisition_plans (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_acquisition_run_plan_version
      FOREIGN KEY (owner_id, team_id, plan_id, plan_version_id)
      REFERENCES acquisition_plan_versions (owner_id, team_id, plan_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_operation_shards (
    id VARCHAR(160) PRIMARY KEY,
    run_id VARCHAR(160) NOT NULL,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    completed_at DATETIME(3) NULL,
    UNIQUE KEY uk_acquisition_shard_scope (owner_id, team_id, id),
    KEY idx_acquisition_shard_run
      (owner_id, team_id, run_id, created_at, id),
    CONSTRAINT fk_acquisition_shard_run
      FOREIGN KEY (owner_id, team_id, run_id)
      REFERENCES acquisition_runs (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_plan_events (
    id VARCHAR(160) PRIMARY KEY,
    plan_id VARCHAR(160) NOT NULL,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    payload_json JSON NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_plan_event_scope (owner_id, team_id, id),
    KEY idx_acquisition_plan_event_plan
      (owner_id, team_id, plan_id, revision, occurred_at, id),
    CONSTRAINT fk_acquisition_plan_event_plan
      FOREIGN KEY (owner_id, team_id, plan_id)
      REFERENCES acquisition_plans (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_run_events (
    id VARCHAR(160) PRIMARY KEY,
    run_id VARCHAR(160) NOT NULL,
    shard_id VARCHAR(160) NULL,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    payload_json JSON NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_run_event_scope (owner_id, team_id, id),
    KEY idx_acquisition_run_event_run
      (owner_id, team_id, run_id, revision, occurred_at, id),
    CONSTRAINT fk_acquisition_run_event_run
      FOREIGN KEY (owner_id, team_id, run_id)
      REFERENCES acquisition_runs (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_plan_run_audit_events (
    id VARCHAR(160) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    target_type VARCHAR(20) NOT NULL,
    target_id VARCHAR(160) NOT NULL,
    payload_json JSON NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_plan_run_audit_scope (owner_id, team_id, id),
    KEY idx_acquisition_plan_run_audit_target
      (owner_id, team_id, target_type, target_id, occurred_at, id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_run_idempotency (
    scope_key_hash CHAR(64) PRIMARY KEY,
    request_hash CHAR(64) NOT NULL,
    result_id VARCHAR(160) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_run_idempotency (scope_key_hash, request_hash)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_usage_idempotency (
    scope_key_hash CHAR(64) PRIMARY KEY,
    request_hash CHAR(64) NOT NULL,
    run_id VARCHAR(160) NOT NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_usage_idempotency
      (scope_key_hash, request_hash)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_execution_intents (
    id VARCHAR(160) PRIMARY KEY,
    run_id VARCHAR(160) NOT NULL,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL,
    attempts BIGINT UNSIGNED NOT NULL,
    payload_json JSON NOT NULL,
    lease_until DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_execution_intent_scope (owner_id, team_id, id),
    KEY idx_acquisition_execution_intent_run
      (owner_id, team_id, run_id, created_at, id),
    CONSTRAINT fk_acquisition_execution_intent_run
      FOREIGN KEY (owner_id, team_id, run_id)
      REFERENCES acquisition_runs (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_acquisition_execution_intent_status
      CHECK (status IN ('pending','dispatching','dispatched'))
  ) ENGINE=InnoDB`
] as const;

export async function ensureAcquisitionMysqlSchema(pool: mysql.Pool) {
  for (const statement of ACQUISITION_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mysqlDate(value: string | null) {
  if (value === null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("ACQUISITION_MYSQL_INVALID_DATE");
  }
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function mysqlIso(value: unknown, resource: string) {
  const date = value instanceof Date
    ? value
    : new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`ACQUISITION_MYSQL_INTEGRITY:${resource}:invalid_date`);
  }
  return date.toISOString();
}

function mysqlUtcIso(value: unknown, resource: string) {
  return mysqlIso(
    typeof value === "string"
      && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value,
    resource
  );
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function redactedKey(value: string) {
  return /^sha256:[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : `sha256:${hash(value)}`;
}

function idempotencyKeyHash(value: string) {
  return redactedKey(value).slice("sha256:".length);
}

function assertNoPlaintextSecrets(
  value: unknown,
  seen = new WeakSet<object>()
): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoPlaintextSecrets(item, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key) && entry !== null && entry !== "") {
      throw new Error("ACQUISITION_PLAINTEXT_SECRET_REJECTED");
    }
    assertNoPlaintextSecrets(entry, seen);
  }
}

function json(value: unknown) {
  assertNoPlaintextSecrets(value);
  return JSON.stringify(value, (key, entry) => {
    if ((key === "idempotencyKey" || key === "scopeKey")
      && typeof entry === "string") {
      return redactedKey(entry);
    }
    return entry;
  });
}

function restoreIdempotencyKey<T>(value: T, rawKey: string): T {
  const redacted = redactedKey(rawKey);
  const restore = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(restore);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).map(([key, item]) => [
        key,
        key === "idempotencyKey" && item === redacted
          ? rawKey
          : restore(item)
      ])
    );
  };
  return restore(value) as T;
}

function parseJson(value: unknown, resource: string): unknown {
  try {
    const parsed = typeof value === "string"
      ? JSON.parse(value)
      : Buffer.isBuffer(value)
        ? JSON.parse(value.toString("utf8"))
        : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    assertNoPlaintextSecrets(parsed);
    return parsed;
  } catch {
    throw new Error(`ACQUISITION_MYSQL_INTEGRITY:${resource}:invalid_json`);
  }
}

function requiredString(
  value: unknown,
  name: string,
  resource: string
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`ACQUISITION_MYSQL_INTEGRITY:${resource}:${name}`);
  }
  return value;
}

function ownedPayload<T extends { id: string; ownerId: string; teamId: string }>(
  row: MysqlRow,
  resource: string
): T {
  const value = parseJson(row.payload_json, resource) as T;
  const rowId = requiredString(row.id, "row_id", resource);
  const rowOwner = requiredString(row.owner_id, "row_owner", resource);
  const rowTeam = requiredString(row.team_id, "row_team", resource);
  if (value.id !== rowId
    || value.ownerId !== rowOwner
    || value.teamId !== rowTeam) {
    throw new Error(`ACQUISITION_MYSQL_INTEGRITY:${resource}:scope_mismatch`);
  }
  const object = value as unknown as Record<string, unknown>;
  const numericColumns = [
    ["version", "version"],
    ["version_no", "version"],
    ["revision", "revision"],
    ["attempts", "attempts"],
    ["attempt_count", "attemptCount"]
  ] as const;
  for (const [column, field] of numericColumns) {
    if (row[column] !== undefined
      && Number(row[column]) !== Number(object[field])) {
      throw new Error(
        `ACQUISITION_MYSQL_INTEGRITY:${resource}:${field}_mismatch`
      );
    }
  }
  const stringColumns = [
    ["candidate_id", "candidateId"],
    ["session_id", "sessionId"],
    ["plan_id", "planId"],
    ["plan_version_id", "planVersionId"],
    ["run_id", "runId"],
    ["plan_snapshot_hash", "planSnapshotHash"],
    ["budget_snapshot_hash", "budgetSnapshotHash"],
    ["actor_id", "actorId"],
    ["status", "status"]
  ] as const;
  for (const [column, field] of stringColumns) {
    if (row[column] !== undefined
      && String(row[column] ?? "") !== String(object[field] ?? "")) {
      throw new Error(
        `ACQUISITION_MYSQL_INTEGRITY:${resource}:${field}_mismatch`
      );
    }
  }
  return clone(value);
}

function unscopedPayload<T extends { id: string }>(
  row: MysqlRow,
  resource: string
): T {
  const value = parseJson(row.payload_json, resource) as T;
  if (value.id !== requiredString(row.id, "row_id", resource)) {
    throw new Error(`ACQUISITION_MYSQL_INTEGRITY:${resource}:id_mismatch`);
  }
  return clone(value);
}

async function rows(
  source: QuerySource,
  sql: string,
  values: unknown[] = []
): Promise<MysqlRow[]> {
  const [result] = await source.query(sql, values);
  if (!Array.isArray(result)) return [];
  return result as MysqlRow[];
}

async function affected(
  source: QuerySource,
  sql: string,
  values: unknown[] = []
) {
  const [result] = await source.query(sql, values);
  return Number((result as mysql.ResultSetHeader).affectedRows || 0);
}

async function insertOwned(
  source: QuerySource,
  table: string,
  record: { id: string; ownerId: string; teamId: string },
  createdAt: string,
  extraColumns: string[] = [],
  extraValues: unknown[] = []
) {
  const columns = [
    "id", "owner_id", "team_id", ...extraColumns, "payload_json", "created_at"
  ];
  const placeholders = columns.map(() => "?").join(", ");
  await source.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
    [
      record.id,
      record.ownerId,
      record.teamId,
      ...extraValues,
      json(record),
      mysqlDate(createdAt)
    ]
  );
}

export class MysqlAcquisitionDomainRepository
implements AcquisitionDomainRepository {
  private readonly transactionContext =
    new AsyncLocalStorage<{
      source: mysql.PoolConnection;
      candidateIdentityLocks: string[];
    }>();
  private readonly temporalBarrier: GrowthTemporalBarrier;

  constructor(
    private readonly pool: mysql.Pool,
    options: {
      temporalBarrier?: GrowthTemporalBarrier;
      advisorAuthority?: Pick<
        MysqlAdvisorCandidateAuthorityRepository,
        "insertWithStamp"
      >;
    } = {}
  ) {
    this.temporalBarrier = options.temporalBarrier
      ? assertGrowthTemporalBarrier(options.temporalBarrier)
      : new MysqlGrowthTemporalBarrier(pool);
    this.advisorAuthority = options.advisorAuthority ?? null;
  }

  private readonly advisorAuthority: Pick<
    MysqlAdvisorCandidateAuthorityRepository,
    "insertWithStamp"
  > | null;

  private source() {
    return this.transactionContext.getStore()?.source ?? this.pool;
  }

  async withTransactionConnection<T>(
    connection: mysql.PoolConnection,
    work: () => Promise<T>
  ) {
    if (this.transactionContext.getStore()) return work();
    const context = {
      source: connection,
      candidateIdentityLocks: [] as string[]
    };
    try {
      return await this.transactionContext.run(context, work);
    } finally {
      await releaseAcquisitionMysqlNamedLocks(
        connection,
        context.candidateIdentityLocks
      );
    }
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) return work();
    const connection = await this.pool.getConnection();
    const context = {
      source: connection,
      candidateIdentityLocks: [] as string[]
    };
    try {
      await connection.beginTransaction();
      const result = await this.transactionContext.run(context, work);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      try {
        await releaseAcquisitionMysqlNamedLocks(
          connection,
          context.candidateIdentityLocks
        );
      } finally {
        releaseAcquisitionMysqlConnection(connection);
      }
    }
  }

  private async findOwned<T extends { id: string; ownerId: string; teamId: string }>(
    table: string,
    scope: AcquisitionDataScope,
    id: string,
    resource: string
  ): Promise<T | null> {
    const result = await rows(
      this.source(),
      `SELECT *
       FROM ${table}
       WHERE id = ? AND owner_id = ? AND team_id = ?
       LIMIT 1`,
      [id, scope.ownerId, scope.teamId]
    );
    return result[0] ? ownedPayload<T>(result[0], resource) : null;
  }

  private async listByCandidate<
    T extends { id: string; ownerId: string; teamId: string }
  >(
    table: string,
    scope: AcquisitionDataScope,
    candidateId: string,
    resource: string,
    timeColumn = "created_at"
  ): Promise<T[]> {
    const result = await rows(
      this.source(),
      `SELECT *
       FROM ${table}
       WHERE candidate_id = ? AND owner_id = ? AND team_id = ?
       ORDER BY ${timeColumn}, id`,
      [candidateId, scope.ownerId, scope.teamId]
    );
    return result.map((row) => ownedPayload<T>(row, resource));
  }

  findEvidence(scope: AcquisitionDataScope, evidenceId: string) {
    return this.findOwned<DiscoveryEvidence>(
      "acquisition_discovery_evidence",
      scope,
      evidenceId,
      "evidence"
    );
  }

  appendEvidence(record: DiscoveryEvidence) {
    return insertOwned(
      this.source(),
      "acquisition_discovery_evidence",
      record,
      record.fetchedAt
    );
  }

  findCandidate(scope: AcquisitionDataScope, candidateId: string) {
    return this.findOwned<AcquisitionCandidate>(
      "acquisition_candidates",
      scope,
      candidateId,
      "candidate"
    );
  }

  async listCandidates(
    scope: AcquisitionDataScope,
    query: AcquisitionCandidateListQuery
  ): Promise<AcquisitionCandidateListPage> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw new Error("CANDIDATE_LIMIT_INVALID");
    }
    const cursor = query.cursor ?? "0";
    if (!/^(0|[1-9]\d*)$/.test(cursor)) {
      throw new Error("CANDIDATE_CURSOR_INVALID");
    }
    const offset = Number(cursor);
    if (!Number.isSafeInteger(offset)) {
      throw new Error("CANDIDATE_CURSOR_INVALID");
    }
    const where = ["owner_id = ?", "team_id = ?"];
    const values: unknown[] = [scope.ownerId, scope.teamId];
    if (query.subjectKind) {
      where.push(
        "JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.profile.kind')) = ?"
      );
      values.push(query.subjectKind);
    }
    if (query.status) {
      where.push(
        "JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.status')) = ?"
      );
      values.push(query.status);
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const statistics = await rows(
        connection,
        `SELECT COUNT(*) AS total_count,
                MAX(updated_at) AS max_updated_at,
                COALESCE(SUM(version), 0) AS version_sum
         FROM acquisition_candidates
         WHERE ${where.join(" AND ")}`,
        values
      );
      const statistic = statistics[0] ?? {};
      const total = Number(statistic.total_count ?? 0);
      const maxUpdatedAt = statistic.max_updated_at instanceof Date
        ? statistic.max_updated_at.toISOString()
        : String(statistic.max_updated_at ?? "");
      const snapshot = createHash("sha256")
        .update(JSON.stringify({
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          subjectKind: query.subjectKind ?? null,
          status: query.status ?? null,
          total,
          maxUpdatedAt,
          versionSum: String(statistic.version_sum ?? "0")
        }))
        .digest("hex");
      if (query.snapshot && query.snapshot !== snapshot) {
        throw new Error("CANDIDATE_SNAPSHOT_CHANGED");
      }
      const pageRows = await rows(
        connection,
        `SELECT *
         FROM acquisition_candidates
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC, id ASC
         LIMIT ? OFFSET ?`,
        [...values, query.limit, offset]
      );
      const items = pageRows.map((row) =>
        ownedPayload<AcquisitionCandidate>(row, "candidate")
      );
      await connection.commit();
      const nextOffset = offset + items.length;
      return {
        items,
        nextCursor: nextOffset < total ? String(nextOffset) : null,
        snapshot
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async insertCandidate(record: AcquisitionCandidate) {
    if (!Number.isSafeInteger(record.version) || record.version < 1) {
      throw new Error("ACQUISITION_CANDIDATE_VERSION_INVALID");
    }
    await this.source().query(
      `INSERT INTO acquisition_candidates
       (id, owner_id, team_id, version, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.ownerId,
        record.teamId,
        record.version,
        json(record),
        mysqlDate(record.createdAt),
        mysqlDate(record.updatedAt)
      ]
    );
  }

  async saveCandidate(record: AcquisitionCandidate) {
    if (!Number.isSafeInteger(record.version) || record.version < 2) {
      throw new Error("ACQUISITION_CANDIDATE_VERSION_INVALID");
    }
    const count = await affected(
      this.source(),
      `UPDATE acquisition_candidates
       SET version = ?, payload_json = ?, updated_at = ?
       WHERE id = ? AND owner_id = ? AND team_id = ? AND version = ?`,
      [
        record.version,
        json(record),
        mysqlDate(record.updatedAt),
        record.id,
        record.ownerId,
        record.teamId,
        record.version - 1
      ]
    );
    if (count !== 1) throw new Error("CANDIDATE_VERSION_CONFLICT");
  }

  async findCandidateIdentityAlias(
    scope: AcquisitionDataScope,
    dedupeKey: string
  ) {
    const result = await rows(
      this.source(),
      `SELECT candidate_id, party_type, basis, created_at
       FROM acquisition_candidate_identity_aliases
       WHERE owner_id = ? AND team_id = ? AND dedupe_key_hash = ?
       LIMIT 1`,
      [scope.ownerId, scope.teamId, hash(dedupeKey)]
    );
    const row = result[0];
    if (!row) return null;
    return {
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      candidateId: requiredString(
        row.candidate_id,
        "candidate_id",
        "candidate_identity_alias"
      ),
      partyType: requiredString(
        row.party_type,
        "party_type",
        "candidate_identity_alias"
      ) as AcquisitionCandidateIdentityAlias["partyType"],
      basis: requiredString(
        row.basis,
        "basis",
        "candidate_identity_alias"
      ) as AcquisitionCandidateIdentityAlias["basis"],
      dedupeKey,
      createdAt: mysqlIso(row.created_at, "candidate_identity_alias")
    };
  }

  async bindCandidateIdentityAliases(
    aliases: AcquisitionCandidateIdentityAlias[]
  ) {
    const context = this.transactionContext.getStore();
    if (!context) {
      throw new Error("CANDIDATE_IDENTITY_ALIAS_REQUIRES_TRANSACTION");
    }
    const sorted = [...aliases].sort((left, right) =>
      hash(left.dedupeKey).localeCompare(hash(right.dedupeKey))
    );
    for (const alias of sorted) {
      const dedupeKeyHash = hash(alias.dedupeKey);
      const lockName = `acq-candidate:${hash([
        alias.ownerId,
        alias.teamId,
        dedupeKeyHash
      ].join("\u0000")).slice(0, 50)}`;
      if (!context.candidateIdentityLocks.includes(lockName)) {
        const lockRows = await rows(
          context.source,
          "SELECT GET_LOCK(?, 30) AS lock_acquired",
          [lockName]
        );
        if (Number(lockRows[0]?.lock_acquired) !== 1) {
          throw new Error("CANDIDATE_IDENTITY_ALIAS_LOCK_TIMEOUT");
        }
        context.candidateIdentityLocks.push(lockName);
      }
      const aliasRows = await rows(
        context.source,
        `SELECT candidate_id, party_type
         FROM acquisition_candidate_identity_aliases
         WHERE owner_id = ? AND team_id = ? AND dedupe_key_hash = ?
         LIMIT 1`,
        [alias.ownerId, alias.teamId, dedupeKeyHash]
      );
      const directoryRows = await rows(
        context.source,
        `SELECT candidate_id, party_type
         FROM acquisition_candidate_directory
         WHERE owner_id = ? AND team_id = ? AND dedupe_key_hash = ?
         LIMIT 1`,
        [alias.ownerId, alias.teamId, dedupeKeyHash]
      );
      const existing = aliasRows[0] ?? directoryRows[0];
      if (existing && (
        String(existing.candidate_id) !== alias.candidateId
        || String(existing.party_type) !== alias.partyType
      )) {
        throw new Error("CANDIDATE_IDENTITY_ALIAS_CONFLICT");
      }
      if (!aliasRows[0]) {
        await context.source.query(
          `INSERT INTO acquisition_candidate_identity_aliases
           (owner_id, team_id, dedupe_key_hash, candidate_id, party_type,
            basis, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            alias.ownerId,
            alias.teamId,
            dedupeKeyHash,
            alias.candidateId,
            alias.partyType,
            alias.basis,
            mysqlDate(alias.createdAt)
          ]
        );
      }
    }
  }

  appendQualificationDecision(record: QualificationDecision) {
    return insertOwned(
      this.source(),
      "acquisition_qualification_decisions",
      record,
      record.createdAt,
      ["candidate_id"],
      [record.candidateId]
    );
  }

  async commitQualificationBundle(
    input: QualificationBundleCommit
  ): Promise<QualificationBundleResult> {
    const workspaceId = input.workspace.workspaceId.trim();
    if (!workspaceId || workspaceId === "all"
      || input.candidate.teamId === "all"
      || input.qualification.teamId === "all"
      || input.financialValue.teamId === "all") {
      throw new Error("growth_workspace_required");
    }
    const scope = {
      ownerId: input.candidate.ownerId,
      teamId: input.candidate.teamId
    };
    return this.transaction(async () => {
      const context = this.transactionContext.getStore();
      if (!context) throw new Error("GROWTH_BUNDLE_REQUIRES_TRANSACTION");
      const temporal = new MysqlGrowthTemporalTransaction(context.source);
      const stamp = await this.temporalBarrier.allocateAppend(
        temporal, workspaceId
      );
      const lockName = `acq-qualify:${hash([
        workspaceId,
        input.candidate.id
      ].join("\u0000")).slice(0, 50)}`;
      if (!context.candidateIdentityLocks.includes(lockName)) {
        const lockRows = await rows(
          context.source,
          "SELECT GET_LOCK(?, 30) AS lock_acquired",
          [lockName]
        );
        if (Number(lockRows[0]?.lock_acquired) !== 1) {
          throw new Error("ACQUISITION_QUALIFICATION_LOCK_TIMEOUT");
        }
        context.candidateIdentityLocks.push(lockName);
      }
      const candidateRows = await rows(
        context.source,
        `SELECT * FROM acquisition_candidates
         WHERE id = ? AND owner_id = ? AND team_id = ?
         LIMIT 1`,
        [input.candidate.id, scope.ownerId, scope.teamId]
      );
      if (!candidateRows[0]) throw new Error("growth_workspace_mismatch");
      const previous = await rows(
        context.source,
        `SELECT id FROM acquisition_qualification_decisions
         WHERE candidate_id = ? AND owner_id = ? AND team_id = ?
         ORDER BY created_at, id`,
        [input.candidate.id, scope.ownerId, scope.teamId]
      );
      const expectedSequence = previous.length + 1;
      if (input.qualification.decisionVersion
          !== `decision-v${expectedSequence}`
        || input.financialValue.version
          !== `financial-value-v${expectedSequence}`) {
        throw new Error("stale_decision");
      }
      for (const reference of input.qualification.evidence) {
        const evidence = await rows(
          context.source,
          `SELECT id FROM acquisition_discovery_evidence
           WHERE id = ? AND owner_id = ? AND team_id = ?
           LIMIT 1`,
          [reference.evidenceId, scope.ownerId, scope.teamId]
        );
        if (!evidence[0]) throw new Error("growth_workspace_mismatch");
      }
      for (const reference of input.authority.evidence) {
        const evidence = await rows(
          context.source,
          `SELECT * FROM acquisition_discovery_evidence
           WHERE id = ? AND owner_id = ? AND team_id = ?
           LIMIT 1`,
          [reference.evidenceId, scope.ownerId, scope.teamId]
        );
        const row = evidence[0];
        const payload = row
          ? parseJson(row.payload_json, "evidence") as DiscoveryEvidence
          : null;
        if (!payload
          || payload.contentHash !== reference.contentHash
          || payload.fetchedAt !== reference.fetchedAt) {
          throw new Error("growth_workspace_mismatch");
        }
      }
      await this.saveCandidate(input.candidate);
      await insertOwned(
        context.source,
        "acquisition_qualification_decisions",
        input.qualification,
        input.qualification.createdAt,
        ["candidate_id"],
        [input.candidate.id]
      );
      await insertOwned(
        context.source,
        "acquisition_financial_values",
        input.financialValue,
        input.financialValue.createdAt,
        ["candidate_id"],
        [input.candidate.id]
      );
      for (const event of input.auditEvents) {
        if (event.ownerId !== scope.ownerId
          || event.teamId !== scope.teamId
          || event.candidateId !== input.candidate.id) {
          throw new Error("growth_workspace_mismatch");
        }
        await insertOwned(
          context.source,
          "acquisition_domain_audit_events",
          event,
          event.createdAt,
          ["candidate_id"],
          [input.candidate.id]
        );
      }
      if (!this.advisorAuthority) {
        throw new Error("advisor_candidate_authority_repository_required");
      }
      const authorityEvent = await this.advisorAuthority.insertWithStamp(
        context.source, input.authority, stamp
      );
      return {
        candidate: clone(input.candidate),
        qualification: clone(input.qualification),
        financialValue: clone(input.financialValue),
        authorityEvent
      };
    });
  }

  async findQualificationDecision(
    scope: AcquisitionDataScope,
    candidateId: string,
    decisionId: string
  ) {
    const result = await rows(
      this.source(),
      `SELECT *
       FROM acquisition_qualification_decisions
       WHERE id = ? AND candidate_id = ?
         AND owner_id = ? AND team_id = ?
       LIMIT 1`,
      [decisionId, candidateId, scope.ownerId, scope.teamId]
    );
    return result[0]
      ? ownedPayload<QualificationDecision>(result[0], "qualification")
      : null;
  }

  listQualificationDecisions(scope: AcquisitionDataScope, candidateId: string) {
    return this.listByCandidate<QualificationDecision>(
      "acquisition_qualification_decisions",
      scope,
      candidateId,
      "qualification"
    );
  }

  appendFinancialValue(record: FinancialValueDecision) {
    return insertOwned(
      this.source(),
      "acquisition_financial_values",
      record,
      record.createdAt,
      ["candidate_id"],
      [record.candidateId]
    );
  }

  listFinancialValues(scope: AcquisitionDataScope, candidateId: string) {
    return this.listByCandidate<FinancialValueDecision>(
      "acquisition_financial_values",
      scope,
      candidateId,
      "financial_value"
    );
  }

  appendBattleCard(record: BattleCard) {
    return insertOwned(
      this.source(),
      "acquisition_battle_cards",
      record,
      record.createdAt,
      ["candidate_id"],
      [record.candidateId]
    );
  }

  listBattleCards(scope: AcquisitionDataScope, candidateId: string) {
    return this.listByCandidate<BattleCard>(
      "acquisition_battle_cards",
      scope,
      candidateId,
      "battle_card"
    );
  }

  appendReviewEvent(record: ReviewEvent) {
    return insertOwned(
      this.source(),
      "acquisition_review_events",
      record,
      record.createdAt,
      ["candidate_id", "idempotency_key_hash"],
      [record.candidateId, hash(record.idempotencyKey)]
    );
  }

  listReviewEvents(scope: AcquisitionDataScope, candidateId: string) {
    return this.listByCandidate<ReviewEvent>(
      "acquisition_review_events",
      scope,
      candidateId,
      "review_event"
    );
  }

  async appendResearchAttempt(record: ResearchAttempt) {
    await this.source().query(
      `INSERT INTO acquisition_research_attempts
       (id, owner_id, team_id, candidate_id, status,
        payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.ownerId,
        record.teamId,
        record.candidateId,
        record.status,
        json(record),
        mysqlDate(record.createdAt),
        mysqlDate(record.completedAt ?? record.startedAt ?? record.createdAt)
      ]
    );
  }

  async saveResearchAttempt(record: ResearchAttempt) {
    const previousStatuses = record.status === "running"
      ? ["pending"]
      : record.status === "failed"
        ? ["pending", "running"]
        : ["running"];
    const statusSql = previousStatuses
      .map((status) => `'${status}'`)
      .join(", ");
    const count = await affected(
      this.source(),
      `UPDATE acquisition_research_attempts
       SET status = ?, payload_json = ?, updated_at = ?
       WHERE id = ? AND candidate_id = ?
         AND owner_id = ? AND team_id = ?
         AND status IN (${statusSql})`,
      [
        record.status,
        json(record),
        mysqlDate(record.completedAt ?? record.startedAt ?? record.createdAt),
        record.id,
        record.candidateId,
        record.ownerId,
        record.teamId
      ]
    );
    if (count !== 1) throw new Error("RESEARCH_ATTEMPT_NOT_FOUND");
  }

  async findResearchAttempt(
    scope: AcquisitionDataScope,
    candidateId: string,
    researchId: string
  ) {
    const result = await rows(
      this.source(),
      `SELECT *
       FROM acquisition_research_attempts
       WHERE id = ? AND candidate_id = ?
         AND owner_id = ? AND team_id = ?
       LIMIT 1`,
      [researchId, candidateId, scope.ownerId, scope.teamId]
    );
    return result[0]
      ? ownedPayload<ResearchAttempt>(result[0], "research_attempt")
      : null;
  }

  async appendConversionIntent(record: LeadConversionIntent) {
    await this.source().query(
      `INSERT INTO acquisition_conversion_intents
       (id, owner_id, team_id, candidate_id, status, attempt_count,
        idempotency_key_hash, payload_json, created_at, updated_at,
        completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.ownerId,
        record.teamId,
        record.candidateId,
        record.status,
        record.attemptCount,
        idempotencyKeyHash(record.idempotencyKey),
        json(record),
        mysqlDate(record.createdAt),
        mysqlDate(record.updatedAt),
        mysqlDate(record.completedAt)
      ]
    );
  }

  async saveConversionIntent(record: LeadConversionIntent) {
    const count = await affected(
      this.source(),
      `UPDATE acquisition_conversion_intents
       SET status = ?, attempt_count = ?, payload_json = ?,
           updated_at = ?, completed_at = ?
       WHERE id = ? AND candidate_id = ?
         AND owner_id = ? AND team_id = ?`,
      [
        record.status,
        record.attemptCount,
        json(record),
        mysqlDate(record.updatedAt),
        mysqlDate(record.completedAt),
        record.id,
        record.candidateId,
        record.ownerId,
        record.teamId
      ]
    );
    if (count !== 1) throw new Error("CONVERSION_INTENT_NOT_FOUND");
  }

  async findConversionIntent(
    scope: AcquisitionDataScope,
    candidateId: string
  ) {
    const result = await rows(
      this.source(),
      `SELECT *
       FROM acquisition_conversion_intents
       WHERE candidate_id = ? AND owner_id = ? AND team_id = ?
       LIMIT 1`,
      [candidateId, scope.ownerId, scope.teamId]
    );
    return result[0]
      ? ownedPayload<LeadConversionIntent>(result[0], "conversion_intent")
      : null;
  }

  async listRecoverableConversionIntents(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("CONVERSION_INTENT_LIMIT_INVALID");
    }
    const result = await rows(
      this.source(),
      `SELECT *
       FROM acquisition_conversion_intents
       WHERE status IN ('pending_crm', 'crm_committed')
       ORDER BY updated_at, id
       LIMIT ?`,
      [limit]
    );
    return result.map((row) =>
      ownedPayload<LeadConversionIntent>(row, "conversion_intent")
    );
  }

  appendConversion(record: LeadConversionRecord) {
    return insertOwned(
      this.source(),
      "acquisition_conversions",
      record,
      record.createdAt,
      ["candidate_id", "idempotency_key_hash"],
      [record.candidateId, idempotencyKeyHash(record.idempotencyKey)]
    );
  }

  async findConversion(scope: AcquisitionDataScope, candidateId: string) {
    const result = await rows(
      this.source(),
      `SELECT *
       FROM acquisition_conversions
       WHERE candidate_id = ? AND owner_id = ? AND team_id = ?
       ORDER BY created_at, id
       LIMIT 1`,
      [candidateId, scope.ownerId, scope.teamId]
    );
    return result[0]
      ? ownedPayload<LeadConversionRecord>(result[0], "conversion")
      : null;
  }

  async appendOutcome(record: LiveOutcomeFeedbackEvent) {
    await this.source().query(
      `INSERT INTO acquisition_outcomes
       (id, owner_id, team_id, candidate_id, idempotency_key_hash,
        payload_json, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.ownerId,
        record.teamId,
        record.candidateId,
        hash(record.idempotencyKey),
        json(record),
        mysqlDate(record.occurredAt),
        mysqlDate(record.createdAt)
      ]
    );
  }

  listOutcomes(scope: AcquisitionDataScope, candidateId: string) {
    return this.listByCandidate<OutcomeFeedbackEvent>(
      "acquisition_outcomes",
      scope,
      candidateId,
      "outcome",
      "occurred_at"
    );
  }

  appendAuditEvent(record: DomainAuditEvent) {
    return insertOwned(
      this.source(),
      "acquisition_domain_audit_events",
      record,
      record.createdAt,
      ["candidate_id"],
      [record.candidateId]
    );
  }

  async listAuditEvents(
    scope: AcquisitionDataScope,
    candidateId: string | null
  ) {
    const candidateClause = candidateId === null
      ? ""
      : " AND candidate_id = ?";
    const values = candidateId === null
      ? [scope.ownerId, scope.teamId]
      : [scope.ownerId, scope.teamId, candidateId];
    const result = await rows(
      this.source(),
      `SELECT *
       FROM acquisition_domain_audit_events
       WHERE owner_id = ? AND team_id = ?${candidateClause}
       ORDER BY created_at, id`,
      values
    );
    return result.map((row) =>
      ownedPayload<DomainAuditEvent>(row, "domain_audit"));
  }

  async listPresentationAuditEvents(
    scope: AcquisitionDataScope,
    query: {
      runId: string;
      after?: AcquisitionPresentationEventCursor;
      limit: number;
    }
  ) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
      throw new Error("PRESENTATION_AUDIT_LIMIT_INVALID");
    }
    const cursorClause = query.after
      ? ` AND (
            a.created_at > ?
            OR (a.created_at = ? AND a.id > ?)
          )`
      : "";
    const values: unknown[] = [
      query.runId,
      scope.ownerId,
      scope.teamId,
      scope.ownerId,
      scope.teamId
    ];
    if (query.after) {
      values.push(
        mysqlDate(query.after.createdAt),
        mysqlDate(query.after.createdAt),
        query.after.eventId
      );
    }
    values.push(query.limit);
    const result = await rows(
      this.source(),
      `WITH discovered_candidates AS (
         SELECT candidate_id, discovered_at, event_id
         FROM (
           SELECT
             JSON_UNQUOTE(
               JSON_EXTRACT(e.payload_json, '$.data.candidateId')
             ) AS candidate_id,
             e.occurred_at AS discovered_at,
             e.id AS event_id,
             ROW_NUMBER() OVER (
               PARTITION BY JSON_UNQUOTE(
                 JSON_EXTRACT(e.payload_json, '$.data.candidateId')
               )
               ORDER BY e.occurred_at, e.id
             ) AS candidate_row
           FROM acquisition_run_events e
           WHERE e.run_id = ?
             AND e.owner_id = ?
             AND e.team_id = ?
             AND JSON_UNQUOTE(
               JSON_EXTRACT(e.payload_json, '$.type')
             ) = 'candidate.discovered'
         ) ranked
         WHERE candidate_row = 1
       )
       SELECT a.*
       FROM acquisition_domain_audit_events a
       INNER JOIN discovered_candidates links
         ON links.candidate_id = a.candidate_id
       WHERE a.owner_id = ? AND a.team_id = ?
         AND (
           a.created_at > links.discovered_at
           OR (
             a.created_at = links.discovered_at
             AND a.id > links.event_id
           )
         )${cursorClause}
       ORDER BY a.created_at, a.id
       LIMIT ?`,
      values
    );
    return result.map((row) =>
      ownedPayload<DomainAuditEvent>(row, "domain_audit"));
  }

  async getPresentationCandidateSnapshots(
    scope: AcquisitionDataScope,
    candidateIds: string[]
  ): Promise<AcquisitionPresentationCandidateSnapshot[]> {
    const ids = [...new Set(candidateIds)];
    if (ids.length === 0) return [];
    const idSetJson = json(ids.map((candidateId) => ({ candidateId })));
    const candidates = (await rows(
      this.source(),
      `SELECT c.*
       FROM acquisition_candidates c
       INNER JOIN JSON_TABLE(
         ?,
         '$[*]' COLUMNS(
           candidate_id VARCHAR(120) PATH '$.candidateId'
         )
       ) ids ON ids.candidate_id = c.id
       WHERE c.owner_id = ? AND c.team_id = ?`,
      [idSetJson, scope.ownerId, scope.teamId]
    )).map((row) =>
      ownedPayload<AcquisitionCandidate>(row, "candidate"));
    const qualifications = (await rows(
      this.source(),
      `SELECT q.*
       FROM acquisition_qualification_decisions q
       INNER JOIN JSON_TABLE(
         ?,
         '$[*]' COLUMNS(
           candidate_id VARCHAR(120) PATH '$.candidateId'
         )
       ) ids ON ids.candidate_id = q.candidate_id
       WHERE q.owner_id = ? AND q.team_id = ?`,
      [idSetJson, scope.ownerId, scope.teamId]
    )).map((row) =>
      ownedPayload<QualificationDecision>(row, "qualification"));
    const financialValues = (await rows(
      this.source(),
      `SELECT f.*
       FROM acquisition_financial_values f
       INNER JOIN JSON_TABLE(
         ?,
         '$[*]' COLUMNS(
           candidate_id VARCHAR(120) PATH '$.candidateId'
         )
       ) ids ON ids.candidate_id = f.candidate_id
       WHERE f.owner_id = ? AND f.team_id = ?`,
      [idSetJson, scope.ownerId, scope.teamId]
    )).map((row) =>
      ownedPayload<FinancialValueDecision>(row, "financial_value"));
    const evidenceIds = [
      ...new Set(candidates.flatMap((candidate) => candidate.evidenceIds))
    ];
    const evidence = evidenceIds.length === 0
      ? []
      : (await rows(
          this.source(),
          `SELECT e.*
           FROM acquisition_discovery_evidence e
           INNER JOIN JSON_TABLE(
             ?,
             '$[*]' COLUMNS(
               evidence_id VARCHAR(${ACQUISITION_EVIDENCE_ID_SQL_WIDTH}) PATH '$.evidenceId'
             )
           ) ids ON ids.evidence_id = e.id
           WHERE e.owner_id = ? AND e.team_id = ?`,
          [
            json(evidenceIds.map((evidenceId) => ({ evidenceId }))),
            scope.ownerId,
            scope.teamId
          ]
        )).map((row) =>
          ownedPayload<DiscoveryEvidence>(row, "evidence"));
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    const qualificationById = new Map(
      qualifications.map((item) => [item.id, item])
    );
    return candidates.map((candidate) => {
      const matchedQualification = candidate.latestDecisionId
        ? qualificationById.get(candidate.latestDecisionId) ?? null
        : null;
      const qualification = matchedQualification?.candidateId === candidate.id
        ? matchedQualification
        : null;
      const financial = qualification
        ? financialValues
            .filter((item) =>
              item.candidateId === candidate.id
              && item.qualificationDecisionId === qualification.id
            )
            .sort((left, right) =>
              left.createdAt.localeCompare(right.createdAt)
              || left.id.localeCompare(right.id)
            )
            .at(-1) ?? null
        : null;
      return {
        candidate,
        qualification,
        financial,
        sourcePlatforms: [
          ...new Set(candidate.evidenceIds.flatMap((evidenceId) => {
            const item = evidenceById.get(evidenceId);
            return item ? [item.sourcePlatform] : [];
          }))
        ].sort()
      };
    });
  }

  async getPresentationEvidenceSnapshots(
    scope: AcquisitionDataScope,
    evidenceIds: string[]
  ): Promise<DiscoveryEvidence[]> {
    const ids = [...new Set(evidenceIds)];
    if (ids.length === 0) return [];
    return (await rows(
      this.source(),
      `SELECT e.*
       FROM acquisition_discovery_evidence e
       INNER JOIN JSON_TABLE(
         ?,
         '$[*]' COLUMNS(
           evidence_id VARCHAR(${ACQUISITION_EVIDENCE_ID_SQL_WIDTH}) PATH '$.evidenceId'
         )
       ) ids ON ids.evidence_id = e.id
       WHERE e.owner_id = ? AND e.team_id = ?`,
      [
        json(ids.map((evidenceId) => ({ evidenceId }))),
        scope.ownerId,
        scope.teamId
      ]
    )).map((row) => ownedPayload<DiscoveryEvidence>(row, "evidence"));
  }

  async getPresentationCandidateSummary(
    scope: AcquisitionDataScope,
    runId: string
  ): Promise<AcquisitionPresentationCandidateSummary> {
    const result = await rows(
      this.source(),
      `WITH candidate_ids AS (
         SELECT DISTINCT JSON_UNQUOTE(
           JSON_EXTRACT(e.payload_json, '$.data.candidateId')
         ) AS candidate_id
         FROM acquisition_run_events e
         WHERE e.run_id = ?
           AND e.owner_id = ?
           AND e.team_id = ?
           AND JSON_UNQUOTE(
             JSON_EXTRACT(e.payload_json, '$.type')
           ) = 'candidate.discovered'
       ),
       current_values AS (
         SELECT
           c.id AS candidate_id,
           c.payload_json AS candidate_json,
           q.id AS qualification_id,
           q.payload_json AS qualification_json,
           f.id AS financial_id,
           f.payload_json AS financial_json,
           ROW_NUMBER() OVER (
             PARTITION BY c.id
             ORDER BY f.created_at DESC, f.id DESC
           ) AS financial_row
         FROM candidate_ids ids
         INNER JOIN acquisition_candidates c
           ON c.id = ids.candidate_id
          AND c.owner_id = ?
          AND c.team_id = ?
         LEFT JOIN acquisition_qualification_decisions q
           ON q.id = JSON_UNQUOTE(
             JSON_EXTRACT(c.payload_json, '$.latestDecisionId')
           )
          AND q.candidate_id = c.id
          AND q.owner_id = c.owner_id
          AND q.team_id = c.team_id
         LEFT JOIN acquisition_financial_values f
           ON f.candidate_id = c.id
          AND f.owner_id = c.owner_id
          AND f.team_id = c.team_id
          AND JSON_UNQUOTE(
            JSON_EXTRACT(
              f.payload_json,
              '$.qualificationDecisionId'
            )
          ) = q.id
       ),
       latest_values AS (
         SELECT
           *,
           JSON_UNQUOTE(
             JSON_EXTRACT(qualification_json, '$.grade')
           ) AS qualification_grade,
           (
             JSON_UNQUOTE(
               JSON_EXTRACT(qualification_json, '$.grade')
             ) IN ('S', 'A')
             AND JSON_LENGTH(
               JSON_EXTRACT(qualification_json, '$.hardGateFailures')
             ) = 0
             AND JSON_UNQUOTE(
               JSON_EXTRACT(candidate_json, '$.status')
             ) <> 'do_not_contact'
           ) AS is_high_intent,
           CASE
             WHEN financial_id IS NOT NULL
              AND JSON_UNQUOTE(
                JSON_EXTRACT(qualification_json, '$.grade')
              ) IN ('S', 'A')
              AND JSON_LENGTH(
                JSON_EXTRACT(qualification_json, '$.hardGateFailures')
              ) = 0
              AND JSON_UNQUOTE(
                JSON_EXTRACT(candidate_json, '$.status')
              ) <> 'do_not_contact'
             THEN JSON_UNQUOTE(
               JSON_EXTRACT(financial_json, '$.currency')
             )
             ELSE NULL
           END AS revenue_currency
         FROM current_values
         WHERE financial_row = 1
       )
       SELECT
         revenue_currency,
         COUNT(*) AS deduped_count,
         SUM(
           JSON_UNQUOTE(
             JSON_EXTRACT(candidate_json, '$.profile.kind')
           ) = 'organization'
         ) AS organization_count,
         SUM(
           qualification_grade IN ('S', 'A', 'B')
           AND JSON_LENGTH(
             JSON_EXTRACT(
               qualification_json,
               '$.hardGateFailures'
             )
           ) = 0
           AND JSON_UNQUOTE(
             JSON_EXTRACT(candidate_json, '$.status')
           ) <> 'do_not_contact'
         ) AS valid_count,
         SUM(is_high_intent) AS high_intent_count,
         SUM(
           is_high_intent
           AND financial_id IS NOT NULL
         ) AS financial_evaluated_count,
         SUM(
           is_high_intent
           AND financial_id IS NULL
         ) AS financial_pending_count,
         SUM(
           CASE
             WHEN revenue_currency IS NOT NULL
             THEN CAST(
               JSON_UNQUOTE(
                 JSON_EXTRACT(
                   financial_json,
                   '$.expectedRevenueMinor'
                 )
               ) AS SIGNED
             )
             ELSE 0
           END
         ) AS expected_revenue_minor
       FROM latest_values
       GROUP BY revenue_currency
       ORDER BY revenue_currency`,
      [
        runId,
        scope.ownerId,
        scope.teamId,
        scope.ownerId,
        scope.teamId
      ]
    );
    const totals = result.reduce<Omit<
      AcquisitionPresentationCandidateSummary,
      "expectedRevenueByCurrency"
    >>((summary, row) => ({
      organizationsFound:
        summary.organizationsFound + Number(row.organization_count ?? 0),
      dedupedCandidates:
        summary.dedupedCandidates + Number(row.deduped_count ?? 0),
      validOpportunities:
        summary.validOpportunities + Number(row.valid_count ?? 0),
      highIntent:
        summary.highIntent + Number(row.high_intent_count ?? 0),
      financialEvaluatedHighIntentCount:
        summary.financialEvaluatedHighIntentCount
        + Number(row.financial_evaluated_count ?? 0),
      financialPendingHighIntentCount:
        summary.financialPendingHighIntentCount
        + Number(row.financial_pending_count ?? 0)
    }), {
      organizationsFound: 0,
      dedupedCandidates: 0,
      validOpportunities: 0,
      highIntent: 0,
      financialEvaluatedHighIntentCount: 0,
      financialPendingHighIntentCount: 0
    });
    return {
      ...totals,
      expectedRevenueByCurrency: result.flatMap((row) =>
        typeof row.revenue_currency === "string" && row.revenue_currency
          ? [{
              currency: row.revenue_currency,
              amountMinor: Number(row.expected_revenue_minor ?? 0)
            }]
          : []
      )
    };
  }

  async findIdempotency(
    scope: AcquisitionDataScope,
    operation: string,
    idempotencyKey: string
  ) {
    const result = await rows(
      this.source(),
      `SELECT owner_id, team_id, payload_json
       FROM acquisition_domain_idempotency
       WHERE owner_id = ? AND team_id = ?
         AND operation_name = ? AND idempotency_key_hash = ?
       LIMIT 1`,
      [
        scope.ownerId,
        scope.teamId,
        operation,
        idempotencyKeyHash(idempotencyKey)
      ]
    );
    if (!result[0]) return null;
    const value = parseJson(
      result[0].payload_json,
      "domain_idempotency"
    ) as DomainIdempotencyRecord;
    if (value.ownerId !== scope.ownerId
      || value.teamId !== scope.teamId
      || value.operation !== operation
      || value.idempotencyKey !== redactedKey(idempotencyKey)) {
      throw new Error(
        "ACQUISITION_MYSQL_INTEGRITY:domain_idempotency:scope_mismatch"
      );
    }
    return restoreIdempotencyKey(clone(value), idempotencyKey);
  }

  async appendIdempotency(record: DomainIdempotencyRecord) {
    await this.source().query(
      `INSERT INTO acquisition_domain_idempotency
       (owner_id, team_id, operation_name, idempotency_key_hash,
        request_hash, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.ownerId,
        record.teamId,
        record.operation,
        idempotencyKeyHash(record.idempotencyKey),
        record.requestHash,
        json(record),
        mysqlDate(record.createdAt)
      ]
    );
  }
}

export class MysqlAcquisitionCopilotRepository
implements AcquisitionCopilotRepository {
  private readonly transactionContext =
    new AsyncLocalStorage<QuerySource>();

  constructor(private readonly pool: mysql.Pool) {}

  private source() {
    return this.transactionContext.getStore() ?? this.pool;
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) return work();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await this.transactionContext.run(connection, work);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async insertSession(record: AcquisitionCopilotSession) {
    await this.source().query(
      `INSERT INTO acquisition_copilot_sessions
       (id, owner_id, team_id, actor_id, status, payload_json,
        created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.ownerId,
        record.teamId,
        record.actorId,
        record.status,
        json(record),
        mysqlDate(record.createdAt),
        mysqlDate(record.updatedAt),
        mysqlDate(record.completedAt)
      ]
    );
  }

  async saveSession(record: AcquisitionCopilotSession) {
    const previousStatuses = record.status === "active"
      ? ["active"]
      : ["active"];
    const statusSql = previousStatuses
      .map((status) => `'${status}'`)
      .join(", ");
    const count = await affected(
      this.source(),
      `UPDATE acquisition_copilot_sessions
       SET status = ?, payload_json = ?,
           updated_at = ?, completed_at = ?
       WHERE id = ? AND owner_id = ? AND team_id = ?
         AND actor_id = ? AND status IN (${statusSql})`,
      [
        record.status,
        json(record),
        mysqlDate(record.updatedAt),
        mysqlDate(record.completedAt),
        record.id,
        record.ownerId,
        record.teamId,
        record.actorId
      ]
    );
    if (count !== 1) throw new Error("SESSION_NOT_FOUND");
  }

  async findSession(scope: Scope, sessionId: string) {
    const result = await rows(
      this.source(),
      `SELECT *
       FROM acquisition_copilot_sessions
       WHERE id = ? AND owner_id = ? AND team_id = ?
       LIMIT 1`,
      [sessionId, scope.ownerId, scope.teamId]
    );
    return result[0]
      ? ownedPayload<AcquisitionCopilotSession>(result[0], "copilot_session")
      : undefined;
  }

  async insertTask(record: AcquisitionCopilotTask) {
    await this.source().query(
      `INSERT INTO acquisition_copilot_tasks
       (id, owner_id, team_id, actor_id, session_id, status, payload_json,
        dispatch_claimed_at, dispatch_lease_until, dispatch_attempts,
        created_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)`,
      [
        record.id,
        record.ownerId,
        record.teamId,
        record.actorId,
        record.sessionId,
        record.status,
        json(record),
        mysqlDate(record.createdAt),
        mysqlDate(record.startedAt),
        mysqlDate(record.completedAt)
      ]
    );
  }

  async saveTask(record: AcquisitionCopilotTask) {
    const previousStatuses = record.status === "running"
      ? ["queued"]
      : record.status === "succeeded"
        ? ["running"]
        : record.status === "failed" || record.status === "cancelled"
          ? ["queued", "running"]
          : [];
    if (previousStatuses.length === 0) {
      throw new Error("TASK_STATE_TRANSITION_INVALID");
    }
    const statusSql = previousStatuses
      .map((status) => `'${status}'`)
      .join(", ");
    const count = await affected(
      this.source(),
      `UPDATE acquisition_copilot_tasks
       SET status = ?, payload_json = ?,
           started_at = ?, completed_at = ?
       WHERE id = ? AND owner_id = ? AND team_id = ?
         AND actor_id = ? AND session_id = ?
         AND status IN (${statusSql})`,
      [
        record.status,
        json(record),
        mysqlDate(record.startedAt),
        mysqlDate(record.completedAt),
        record.id,
        record.ownerId,
        record.teamId,
        record.actorId,
        record.sessionId
      ]
    );
    if (count !== 1) throw new Error("TASK_NOT_FOUND");
  }

  async findTask(scope: Scope, taskId: string) {
    const result = await rows(
      this.source(),
      `SELECT *
       FROM acquisition_copilot_tasks
       WHERE id = ? AND owner_id = ? AND team_id = ?
       LIMIT 1`,
      [taskId, scope.ownerId, scope.teamId]
    );
    return result[0]
      ? ownedPayload<AcquisitionCopilotTask>(result[0], "copilot_task")
      : undefined;
  }

  async claimTaskDispatch(scope: Scope, taskId: string) {
    return this.transaction(async () => {
      const targetRows = await rows(
        this.source(),
        `SELECT *
         FROM acquisition_copilot_tasks
         WHERE id = ? AND owner_id = ? AND team_id = ?
           AND status = 'queued'
         LIMIT 1
         FOR UPDATE`,
        [taskId, scope.ownerId, scope.teamId]
      );
      if (!targetRows[0]) return false;
      const task = ownedPayload<AcquisitionCopilotTask>(
        targetRows[0],
        "copilot_task"
      );
      const sessionRows = await rows(
        this.source(),
        `SELECT id
         FROM acquisition_copilot_sessions
         WHERE id = ? AND owner_id = ? AND team_id = ?
         LIMIT 1
         FOR UPDATE`,
        [task.sessionId, scope.ownerId, scope.teamId]
      );
      if (!sessionRows[0]) throw new Error("SESSION_NOT_FOUND");
      const active = await rows(
        this.source(),
        `SELECT id
         FROM acquisition_copilot_tasks
         WHERE session_id = ? AND owner_id = ? AND team_id = ?
           AND status = 'running'
         LIMIT 1`,
        [task.sessionId, scope.ownerId, scope.teamId]
      );
      if (active.length > 0) return false;

      const startedAt = new Date().toISOString();
      const claimed: AcquisitionCopilotTask = {
        ...task,
        status: "running",
        startedAt
      };
      const count = await affected(
        this.source(),
        `UPDATE acquisition_copilot_tasks
         SET status = 'running',
             payload_json = ?,
             started_at = ?,
             dispatch_claimed_at = UTC_TIMESTAMP(3),
             dispatch_lease_until =
               DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE),
             dispatch_attempts = dispatch_attempts + 1
         WHERE id = ? AND owner_id = ? AND team_id = ?
           AND actor_id = ? AND session_id = ?
           AND status = 'queued'`,
        [
          json(claimed),
          mysqlDate(startedAt),
          claimed.id,
          claimed.ownerId,
          claimed.teamId,
          claimed.actorId,
          claimed.sessionId
        ]
      );
      return count === 1;
    });
  }

  async recoverInterruptedTasks(input: {
    now: string;
    staleRunningBefore: string;
  }) {
    const result = await rows(
      this.source(),
      `SELECT *
       FROM acquisition_copilot_tasks
       WHERE (
         status = 'queued'
         AND (
           dispatch_lease_until IS NULL
           OR dispatch_lease_until <= ?
         )
       ) OR (
         status = 'running'
         AND started_at IS NOT NULL
         AND started_at <= ?
       )
       ORDER BY created_at, id`,
      [
        mysqlDate(input.now),
        mysqlDate(input.staleRunningBefore)
      ]
    );
    const tasks = result.map((row) =>
      ownedPayload<AcquisitionCopilotTask>(row, "copilot_task"));
    const queued: AcquisitionCopilotTask[] = [];
    for (const task of tasks) {
      if (task.status === "queued") {
        const released = await affected(
          this.source(),
          `UPDATE acquisition_copilot_tasks
           SET dispatch_claimed_at = NULL,
               dispatch_lease_until = NULL
           WHERE id = ? AND owner_id = ? AND team_id = ?
             AND status = 'queued'
             AND (
               dispatch_lease_until IS NULL
               OR dispatch_lease_until <= ?
             )`,
          [
            task.id,
            task.ownerId,
            task.teamId,
            mysqlDate(input.now)
          ]
        );
        if (released === 1) queued.push(task);
        continue;
      }
      const failed: AcquisitionCopilotTask = {
        ...task,
        status: "failed",
        result: null,
        errorCode: "COPILOT_PROCESS_RESTARTED",
        completedAt: input.now
      };
      await affected(
        this.source(),
        `UPDATE acquisition_copilot_tasks
         SET status = 'failed',
             payload_json = ?,
             completed_at = ?
         WHERE id = ? AND owner_id = ? AND team_id = ?
           AND status = 'running'
           AND started_at IS NOT NULL
           AND started_at <= ?`,
        [
          json(failed),
          mysqlDate(failed.completedAt),
          failed.id,
          failed.ownerId,
          failed.teamId,
          mysqlDate(input.staleRunningBefore)
        ]
      );
    }
    return queued;
  }

  async listTasks(scope: Scope, sessionId: string) {
    const result = await rows(
      this.source(),
      `SELECT *
       FROM acquisition_copilot_tasks
       WHERE session_id = ? AND owner_id = ? AND team_id = ?
       ORDER BY created_at, id`,
      [sessionId, scope.ownerId, scope.teamId]
    );
    return result.map((row) =>
      ownedPayload<AcquisitionCopilotTask>(row, "copilot_task"));
  }

  async appendMessages(
    records: AcquisitionCopilotMessage[]
  ): Promise<void> {
    if (records.length === 0) return;
    const scope = {
      ownerId: records[0]!.ownerId,
      teamId: records[0]!.teamId,
      sessionId: records[0]!.sessionId
    };
    const messageIds = new Set<string>();
    for (const record of records) {
      if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) {
        throw new Error("COPILOT_MESSAGE_SEQUENCE_INVALID");
      }
      if (record.ownerId !== scope.ownerId
        || record.teamId !== scope.teamId
        || record.sessionId !== scope.sessionId) {
        throw new Error("COPILOT_MESSAGE_SCOPE_MISMATCH");
      }
      if (messageIds.has(record.id)) throw new Error("MESSAGE_EXISTS");
      messageIds.add(record.id);
    }
    if (!this.transactionContext.getStore()) {
      await this.transaction(() => this.appendMessages(records));
      return;
    }
    const source = this.source();
    const sessionRows = await rows(
      source,
      `SELECT id
       FROM acquisition_copilot_sessions
       WHERE id = ? AND owner_id = ? AND team_id = ?
       FOR UPDATE`,
      [scope.sessionId, scope.ownerId, scope.teamId]
    );
    if (!sessionRows[0]) throw new Error("SESSION_NOT_FOUND");
    const sequenceRows = await rows(
      source,
      `SELECT COALESCE(MAX(sequence_no), 0) AS max_sequence
       FROM acquisition_copilot_messages
       WHERE session_id = ? AND owner_id = ? AND team_id = ?`,
      [scope.sessionId, scope.ownerId, scope.teamId]
    );
    const maxSequence = Number(sequenceRows[0]?.max_sequence ?? 0);
    if (!Number.isSafeInteger(maxSequence) || maxSequence < 0) {
      throw new Error(
        "ACQUISITION_MYSQL_INTEGRITY:copilot_message:max_sequence"
      );
    }
    const rebased = records.map((record, index) => ({
      ...record,
      sequence: maxSequence + index + 1
    }));
    const placeholders = rebased
      .map(() => "(?, ?, ?, ?, ?, ?, ?)")
      .join(", ");
    await source.query(
      `INSERT INTO acquisition_copilot_messages
       (id, owner_id, team_id, session_id, sequence_no,
        payload_json, created_at)
       VALUES ${placeholders}`,
      rebased.flatMap((record) => [
        record.id,
        record.ownerId,
        record.teamId,
        record.sessionId,
        record.sequence,
        json(record),
        mysqlDate(record.createdAt)
      ])
    );
  }

  async listMessages(scope: Scope, sessionId: string) {
    const result = await rows(
      this.source(),
      `SELECT id, owner_id, team_id, session_id, sequence_no, payload_json
       FROM acquisition_copilot_messages
       WHERE session_id = ? AND owner_id = ? AND team_id = ?
       ORDER BY sequence_no, id`,
      [sessionId, scope.ownerId, scope.teamId]
    );
    return result.map((row) => {
      const message = ownedPayload<AcquisitionCopilotMessage>(
        row,
        "copilot_message"
      );
      if (message.sessionId !== row.session_id
        || message.sequence !== Number(row.sequence_no)
        || !Number.isSafeInteger(message.sequence)
        || message.sequence < 1) {
        throw new Error(
          "ACQUISITION_MYSQL_INTEGRITY:copilot_message:sequence_mismatch"
        );
      }
      return message;
    });
  }

  async findIdempotency(input: {
    ownerId: string;
    teamId: string;
    operation: AcquisitionCopilotIdempotencyRecord["operation"];
    keyHash: string;
  }) {
    const result = await rows(
      this.source(),
      `SELECT owner_id, team_id, operation_name, key_hash, payload_json
       FROM acquisition_copilot_idempotency
       WHERE owner_id = ? AND team_id = ?
         AND operation_name = ? AND key_hash = ?
       LIMIT 1`,
      [input.ownerId, input.teamId, input.operation, input.keyHash]
    );
    if (!result[0]) return undefined;
    const record = parseJson(
      result[0].payload_json,
      "copilot_idempotency"
    ) as AcquisitionCopilotIdempotencyRecord;
    if (record.ownerId !== input.ownerId
      || record.teamId !== input.teamId
      || record.operation !== input.operation
      || record.keyHash !== input.keyHash) {
      throw new Error(
        "ACQUISITION_MYSQL_INTEGRITY:copilot_idempotency:scope_mismatch"
      );
    }
    return clone(record);
  }

  async appendIdempotency(record: AcquisitionCopilotIdempotencyRecord) {
    await this.source().query(
      `INSERT INTO acquisition_copilot_idempotency
       (owner_id, team_id, operation_name, key_hash,
        request_hash, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.ownerId,
        record.teamId,
        record.operation,
        record.keyHash,
        record.requestHash,
        json(record),
        mysqlDate(record.createdAt)
      ]
    );
  }
}

interface PlanRunState {
  plans: Map<string, AcquisitionPlan>;
  versions: Map<string, AcquisitionPlanVersion>;
  runs: Map<string, AcquisitionRun>;
  shards: Map<string, AcquisitionOperationShard>;
  planEvents: Map<string, AcquisitionPlanEvent>;
  runEvents: Map<string, AcquisitionRunEvent>;
  audits: Map<string, AcquisitionAuditEvent>;
  idempotency: Map<string, AcquisitionIdempotencyRecord>;
  usageIdempotency: Map<string, AcquisitionUsageIdempotencyRecord>;
  intents: Map<string, AcquisitionExecutionIntent>;
}

function emptyPlanRunState(): PlanRunState {
  return {
    plans: new Map(),
    versions: new Map(),
    runs: new Map(),
    shards: new Map(),
    planEvents: new Map(),
    runEvents: new Map(),
    audits: new Map(),
    idempotency: new Map(),
    usageIdempotency: new Map(),
    intents: new Map()
  };
}

function mapOwnedRows<T extends { id: string; ownerId: string; teamId: string }>(
  input: MysqlRow[],
  resource: string
) {
  return new Map(input.map((row) => {
    const value = ownedPayload<T>(row, resource);
    return [value.id, value];
  }));
}

function transactionView(
  state: PlanRunState
): AcquisitionPlanRunRepositoryTransaction {
  return {
    getPlan: (id) => clone(state.plans.get(id) ?? null),
    putPlan: (value) => state.plans.set(value.id, clone(value)),
    appendPlanVersion: (value) => {
      if (state.versions.has(value.id)) {
        throw new Error(`Plan version already exists: ${value.id}`);
      }
      state.versions.set(value.id, clone(value));
    },
    getPlanVersion: (id) => clone(state.versions.get(id) ?? null),
    getRun: (id) => clone(state.runs.get(id) ?? null),
    putRun: (value) => state.runs.set(value.id, clone(value)),
    getShard: (id) => clone(state.shards.get(id) ?? null),
    putShard: (value) => state.shards.set(value.id, clone(value)),
    listRunShards: (runId) => [...state.shards.values()]
      .filter((value) => value.runId === runId)
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id))
      .map(clone),
    appendPlanEvent: (value) => {
      if (state.planEvents.has(value.id)) {
        throw new Error(`Plan event already exists: ${value.id}`);
      }
      state.planEvents.set(value.id, clone(value));
    },
    appendRunEvent: (value) => {
      if (state.runEvents.has(value.id)) {
        throw new Error(`Run event already exists: ${value.id}`);
      }
      state.runEvents.set(value.id, clone(value));
    },
    appendAuditEvent: (value) => {
      if (state.audits.has(value.id)) {
        throw new Error(`Audit event already exists: ${value.id}`);
      }
      state.audits.set(value.id, clone(value));
    },
    getIdempotency: (key) =>
      clone(state.idempotency.get(hash(key)) ?? null),
    putIdempotency: (value) => {
      const keyHash = hash(value.scopeKey);
      if (state.idempotency.has(keyHash)) {
        throw new Error(`Idempotency record already exists: ${value.scopeKey}`);
      }
      state.idempotency.set(keyHash, clone(value));
    },
    getUsageIdempotency: (key) =>
      clone(state.usageIdempotency.get(hash(key)) ?? null),
    putUsageIdempotency: (value) => {
      const keyHash = hash(value.scopeKey);
      if (state.usageIdempotency.has(keyHash)) {
        throw new Error(
          `Usage idempotency record already exists: ${value.scopeKey}`
        );
      }
      state.usageIdempotency.set(keyHash, clone(value));
    },
    getExecutionIntent: (id) => clone(state.intents.get(id) ?? null),
    putExecutionIntent: (value) => state.intents.set(value.id, clone(value)),
    listRunExecutionIntents: (runId) => [...state.intents.values()]
      .filter((value) => value.runId === runId)
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id))
      .map(clone)
  };
}

async function loadPlanRunState(
  source: QuerySource
): Promise<PlanRunState> {
  const state = emptyPlanRunState();
  state.plans = mapOwnedRows<AcquisitionPlan>(
    await rows(source, `SELECT *
                        FROM acquisition_plans FOR UPDATE`),
    "plan"
  );
  state.versions = mapOwnedRows<AcquisitionPlanVersion>(
    await rows(source, `SELECT *
                        FROM acquisition_plan_versions FOR UPDATE`),
    "plan_version"
  );
  state.runs = mapOwnedRows<AcquisitionRun>(
    await rows(source, `SELECT *
                        FROM acquisition_runs FOR UPDATE`),
    "run"
  );
  state.shards = mapOwnedRows<AcquisitionOperationShard>(
    await rows(source, `SELECT *
                        FROM acquisition_operation_shards FOR UPDATE`),
    "shard"
  );
  state.planEvents = mapOwnedRows<AcquisitionPlanEvent>(
    await rows(source, `SELECT *
                        FROM acquisition_plan_events FOR UPDATE`),
    "plan_event"
  );
  state.runEvents = mapOwnedRows<AcquisitionRunEvent>(
    await rows(source, `SELECT *
                        FROM acquisition_run_events FOR UPDATE`),
    "run_event"
  );
  state.audits = mapOwnedRows<AcquisitionAuditEvent>(
    await rows(source, `SELECT *
                        FROM acquisition_plan_run_audit_events FOR UPDATE`),
    "plan_run_audit"
  );
  for (const row of await rows(
    source,
    `SELECT scope_key_hash, payload_json
     FROM acquisition_run_idempotency FOR UPDATE`
  )) {
    const value = parseJson(
      row.payload_json,
      "run_idempotency"
    ) as AcquisitionIdempotencyRecord;
    const scopeKeyHash = requiredString(
      row.scope_key_hash,
      "scope_key_hash",
      "run_idempotency"
    );
    if (value.scopeKey !== `sha256:${scopeKeyHash}`) {
      throw new Error(
        "ACQUISITION_MYSQL_INTEGRITY:run_idempotency:key_mismatch"
      );
    }
    state.idempotency.set(scopeKeyHash, clone(value));
  }
  for (const row of await rows(
    source,
    `SELECT scope_key_hash, payload_json
     FROM acquisition_usage_idempotency FOR UPDATE`
  )) {
    const value = parseJson(
      row.payload_json,
      "usage_idempotency"
    ) as AcquisitionUsageIdempotencyRecord;
    const scopeKeyHash = requiredString(
      row.scope_key_hash,
      "scope_key_hash",
      "usage_idempotency"
    );
    if (value.scopeKey !== `sha256:${scopeKeyHash}`) {
      throw new Error(
        "ACQUISITION_MYSQL_INTEGRITY:usage_idempotency:key_mismatch"
      );
    }
    state.usageIdempotency.set(scopeKeyHash, clone(value));
  }
  state.intents = mapOwnedRows<AcquisitionExecutionIntent>(
    await rows(source, `SELECT *
                        FROM acquisition_execution_intents FOR UPDATE`),
    "execution_intent"
  );
  return state;
}

function newValues<T>(
  before: Map<string, T>,
  after: Map<string, T>
): T[] {
  return [...after.entries()]
    .filter(([id]) => !before.has(id))
    .map(([, value]) => clone(value));
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertImmutableScope(
  before: { ownerId: string; teamId: string },
  after: { ownerId: string; teamId: string },
  resource: string
) {
  if (before.ownerId !== after.ownerId || before.teamId !== after.teamId) {
    throw new Error(`ACQUISITION_MYSQL_SCOPE_IMMUTABLE:${resource}`);
  }
}

function assertRevisionAdvanced(
  before: { revision: number },
  after: { revision: number },
  resource: string
) {
  if (!Number.isSafeInteger(after.revision)
    || after.revision <= before.revision) {
    throw new Error(`ACQUISITION_MYSQL_REVISION_CONFLICT:${resource}`);
  }
}

async function persistPlans(
  source: QuerySource,
  before: PlanRunState,
  after: PlanRunState
) {
  for (const value of after.plans.values()) {
    const previous = before.plans.get(value.id);
    if (!previous) {
      await source.query(
        `INSERT INTO acquisition_plans
         (id, owner_id, team_id, revision, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          value.id,
          value.ownerId,
          value.teamId,
          value.revision,
          json(value),
          mysqlDate(value.createdAt),
          mysqlDate(value.updatedAt)
        ]
      );
      continue;
    }
    if (sameJson(previous, value)) continue;
    assertImmutableScope(previous, value, "plan");
    assertRevisionAdvanced(previous, value, "plan");
    const count = await affected(
      source,
      `UPDATE acquisition_plans
       SET revision = ?, payload_json = ?, updated_at = ?
       WHERE id = ? AND owner_id = ? AND team_id = ? AND revision = ?`,
      [
        value.revision,
        json(value),
        mysqlDate(value.updatedAt),
        value.id,
        value.ownerId,
        value.teamId,
        previous.revision
      ]
    );
    if (count !== 1) throw new Error("ACQUISITION_MYSQL_PLAN_CONFLICT");
  }
}

async function persistRuns(
  source: QuerySource,
  before: PlanRunState,
  after: PlanRunState
) {
  for (const value of after.runs.values()) {
    const previous = before.runs.get(value.id);
    if (!previous) {
      await source.query(
        `INSERT INTO acquisition_runs
         (id, plan_id, plan_version_id, owner_id, team_id, revision,
          plan_snapshot_hash, budget_snapshot_hash, payload_json,
          created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          value.id,
          value.planId,
          value.planVersionId,
          value.ownerId,
          value.teamId,
          value.revision,
          value.planSnapshotHash,
          value.budgetSnapshotHash,
          json(value),
          mysqlDate(value.createdAt),
          mysqlDate(value.updatedAt),
          mysqlDate(value.completedAt)
        ]
      );
      continue;
    }
    if (sameJson(previous, value)) continue;
    assertImmutableScope(previous, value, "run");
    assertRevisionAdvanced(previous, value, "run");
    if (previous.planId !== value.planId
      || previous.planVersionId !== value.planVersionId
      || previous.planSnapshotHash !== value.planSnapshotHash
      || previous.budgetSnapshotHash !== value.budgetSnapshotHash) {
      throw new Error("ACQUISITION_MYSQL_PARENT_IMMUTABLE:run");
    }
    const count = await affected(
      source,
      `UPDATE acquisition_runs
       SET revision = ?, payload_json = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND plan_id = ? AND plan_version_id = ?
         AND plan_snapshot_hash = ? AND budget_snapshot_hash = ?
         AND owner_id = ? AND team_id = ? AND revision = ?`,
      [
        value.revision,
        json(value),
        mysqlDate(value.updatedAt),
        mysqlDate(value.completedAt),
        value.id,
        value.planId,
        value.planVersionId,
        value.planSnapshotHash,
        value.budgetSnapshotHash,
        value.ownerId,
        value.teamId,
        previous.revision
      ]
    );
    if (count !== 1) throw new Error("ACQUISITION_MYSQL_RUN_CONFLICT");
  }
}

async function persistShards(
  source: QuerySource,
  before: PlanRunState,
  after: PlanRunState
) {
  for (const value of after.shards.values()) {
    const previous = before.shards.get(value.id);
    if (!previous) {
      await source.query(
        `INSERT INTO acquisition_operation_shards
         (id, run_id, owner_id, team_id, revision, payload_json,
          created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          value.id,
          value.runId,
          value.ownerId,
          value.teamId,
          value.revision,
          json(value),
          mysqlDate(value.createdAt),
          mysqlDate(value.updatedAt),
          mysqlDate(value.completedAt)
        ]
      );
      continue;
    }
    if (sameJson(previous, value)) continue;
    assertImmutableScope(previous, value, "shard");
    assertRevisionAdvanced(previous, value, "shard");
    if (previous.runId !== value.runId) {
      throw new Error("ACQUISITION_MYSQL_PARENT_IMMUTABLE:shard");
    }
    const count = await affected(
      source,
      `UPDATE acquisition_operation_shards
       SET revision = ?, payload_json = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND run_id = ?
         AND owner_id = ? AND team_id = ? AND revision = ?`,
      [
        value.revision,
        json(value),
        mysqlDate(value.updatedAt),
        mysqlDate(value.completedAt),
        value.id,
        value.runId,
        value.ownerId,
        value.teamId,
        previous.revision
      ]
    );
    if (count !== 1) throw new Error("ACQUISITION_MYSQL_SHARD_CONFLICT");
  }
}

async function persistIntents(
  source: QuerySource,
  before: PlanRunState,
  after: PlanRunState
) {
  for (const value of after.intents.values()) {
    const previous = before.intents.get(value.id);
    if (!previous) {
      await source.query(
        `INSERT INTO acquisition_execution_intents
         (id, run_id, owner_id, team_id, status, attempts, payload_json,
          lease_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          value.id,
          value.runId,
          value.ownerId,
          value.teamId,
          value.status,
          value.attempts,
          json(value),
          mysqlDate(value.leaseUntil),
          mysqlDate(value.createdAt),
          mysqlDate(value.updatedAt)
        ]
      );
      continue;
    }
    if (sameJson(previous, value)) continue;
    assertImmutableScope(previous, value, "execution_intent");
    if (previous.runId !== value.runId) {
      throw new Error("ACQUISITION_MYSQL_PARENT_IMMUTABLE:execution_intent");
    }
    const count = await affected(
      source,
      `UPDATE acquisition_execution_intents
       SET status = ?, attempts = ?, payload_json = ?,
           lease_until = ?, updated_at = ?
       WHERE id = ? AND run_id = ? AND owner_id = ? AND team_id = ?`,
      [
        value.status,
        value.attempts,
        json(value),
        mysqlDate(value.leaseUntil),
        mysqlDate(value.updatedAt),
        value.id,
        value.runId,
        value.ownerId,
        value.teamId
      ]
    );
    if (count !== 1) {
      throw new Error("ACQUISITION_MYSQL_EXECUTION_INTENT_CONFLICT");
    }
  }
}

async function appendPlanRunChanges(
  source: QuerySource,
  before: PlanRunState,
  after: PlanRunState
) {
  await persistPlans(source, before, after);
  for (const value of newValues(before.versions, after.versions)) {
    await insertOwned(
      source,
      "acquisition_plan_versions",
      value,
      value.createdAt,
      ["plan_id", "version_no"],
      [value.planId, value.version]
    );
  }
  await persistRuns(source, before, after);
  await persistShards(source, before, after);
  await persistIntents(source, before, after);
  for (const value of newValues(before.planEvents, after.planEvents)) {
    await insertOwned(
      source,
      "acquisition_plan_events",
      value,
      value.at,
      ["plan_id", "revision", "occurred_at"],
      [value.planId, value.revision, mysqlDate(value.at)]
    );
  }
  for (const value of newValues(before.runEvents, after.runEvents)) {
    await insertOwned(
      source,
      "acquisition_run_events",
      value,
      value.at,
      ["run_id", "shard_id", "revision", "occurred_at"],
      [value.runId, value.shardId, value.revision, mysqlDate(value.at)]
    );
  }
  for (const value of newValues(before.audits, after.audits)) {
    await insertOwned(
      source,
      "acquisition_plan_run_audit_events",
      value,
      value.at,
      ["target_type", "target_id", "occurred_at"],
      [value.targetType, value.targetId, mysqlDate(value.at)]
    );
  }
  for (const value of newValues(before.idempotency, after.idempotency)) {
    await source.query(
      `INSERT INTO acquisition_run_idempotency
       (scope_key_hash, request_hash, result_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        hash(value.scopeKey),
        value.requestHash,
        value.resultId,
        json(value),
        mysqlDate(value.createdAt)
      ]
    );
  }
  for (const value of newValues(
    before.usageIdempotency,
    after.usageIdempotency
  )) {
    await source.query(
      `INSERT INTO acquisition_usage_idempotency
       (scope_key_hash, request_hash, run_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        hash(value.scopeKey),
        value.requestHash,
        value.runId,
        json(value),
        mysqlDate(value.createdAt)
      ]
    );
  }
}

export class MysqlAcquisitionPlanRunRepository
implements AcquisitionPlanRunRepository {
  constructor(private readonly pool: mysql.Pool) {}

  async transaction<T>(
    work: (
      transaction: AcquisitionPlanRunRepositoryTransaction
    ) => Promise<T> | T
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        `SELECT id FROM acquisition_plan_run_transaction_guard
         WHERE id = 1 FOR UPDATE`
      );
      const before = await loadPlanRunState(connection);
      const after = clone(before);
      const result = await work(transactionView(after));
      await appendPlanRunChanges(connection, before, after);
      await connection.query(
        `UPDATE acquisition_plan_run_transaction_guard
         SET updated_at = UTC_TIMESTAMP(3) WHERE id = 1`
      );
      await connection.commit();
      return clone(result);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async findOwned<T extends { id: string; ownerId: string; teamId: string }>(
    table: string,
    id: string,
    resource: string
  ): Promise<T | null> {
    const result = await rows(
      this.pool,
      `SELECT id, owner_id, team_id, payload_json
       FROM ${table}
       WHERE id = ?
       LIMIT 1`,
      [id]
    );
    return result[0] ? ownedPayload<T>(result[0], resource) : null;
  }

  async listPlans(scope: { ownerId: string; teamId: string }) {
    const result = await rows(
      this.pool,
      `SELECT * FROM acquisition_plans
       WHERE owner_id = ? AND team_id = ?
       ORDER BY updated_at DESC, id DESC`,
      [scope.ownerId, scope.teamId]
    );
    return result.map((row) => ownedPayload<AcquisitionPlan>(row, "plan"));
  }

  getPlan(id: string) {
    return this.findOwned<AcquisitionPlan>("acquisition_plans", id, "plan");
  }

  getPlanVersion(id: string) {
    return this.findOwned<AcquisitionPlanVersion>(
      "acquisition_plan_versions",
      id,
      "plan_version"
    );
  }

  async listPlanVersions(planId: string) {
    const result = await rows(
      this.pool,
      `SELECT v.*
       FROM acquisition_plan_versions v
       INNER JOIN acquisition_plans p
         ON p.id = v.plan_id
        AND p.owner_id = v.owner_id
        AND p.team_id = v.team_id
       WHERE v.plan_id = ?
       ORDER BY v.version_no, v.id`,
      [planId]
    );
    return result.map((row) =>
      ownedPayload<AcquisitionPlanVersion>(row, "plan_version"));
  }

  async listRuns(
    scope: { ownerId: string; teamId: string },
    query?: AcquisitionRunListQuery
  ) {
    if (!query) {
      const result = await rows(
        this.pool,
        `SELECT * FROM acquisition_runs
         WHERE owner_id = ? AND team_id = ?
         ORDER BY updated_at DESC, id DESC`,
        [scope.ownerId, scope.teamId]
      );
      return result.map((row) => ownedPayload<AcquisitionRun>(row, "run"));
    }
    const platformJoin = query.targetPlatform
      ? `INNER JOIN acquisition_plan_versions v
           ON v.id = r.plan_version_id
          AND v.plan_id = r.plan_id
          AND v.owner_id = r.owner_id
          AND v.team_id = r.team_id`
      : "";
    const platformPredicate = query.targetPlatform
      ? `AND JSON_UNQUOTE(
           JSON_EXTRACT(v.payload_json, '$.payload.targetPlatform')
         ) = ?`
      : "";
    const values: unknown[] = [scope.ownerId, scope.teamId];
    if (query.targetPlatform) values.push(query.targetPlatform);
    values.push(mysqlDate(query.createdAtOnOrBefore), query.limit);
    const result = await rows(
      this.pool,
      `SELECT r.* FROM acquisition_runs r
       ${platformJoin}
       WHERE r.owner_id = ? AND r.team_id = ?
       ${platformPredicate}
         AND r.created_at <= ?
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ?`,
      values
    );
    return result.map((row) => ownedPayload<AcquisitionRun>(row, "run"));
  }

  getRun(id: string) {
    return this.findOwned<AcquisitionRun>("acquisition_runs", id, "run");
  }

  async listRunShards(runId: string) {
    const result = await rows(
      this.pool,
      `SELECT s.*
       FROM acquisition_operation_shards s
       INNER JOIN acquisition_runs r
         ON r.id = s.run_id
        AND r.owner_id = s.owner_id
        AND r.team_id = s.team_id
       WHERE s.run_id = ?
       ORDER BY s.created_at, s.id`,
      [runId]
    );
    return result.map((row) =>
      ownedPayload<AcquisitionOperationShard>(row, "shard"));
  }

  async listPlanEvents(planId: string) {
    const result = await rows(
      this.pool,
      `SELECT e.*
       FROM acquisition_plan_events e
       INNER JOIN acquisition_plans p
         ON p.id = e.plan_id
        AND p.owner_id = e.owner_id
        AND p.team_id = e.team_id
       WHERE e.plan_id = ?
       ORDER BY e.revision, e.occurred_at, e.id`,
      [planId]
    );
    return result.map((row) =>
      ownedPayload<AcquisitionPlanEvent>(row, "plan_event"));
  }

  async listRunEvents(runId: string) {
    const result = await rows(
      this.pool,
      `SELECT e.*
       FROM acquisition_run_events e
       INNER JOIN acquisition_runs r
         ON r.id = e.run_id
        AND r.owner_id = e.owner_id
        AND r.team_id = e.team_id
       WHERE e.run_id = ?
       ORDER BY e.revision, e.occurred_at, e.id`,
      [runId]
    );
    return result.map((row) =>
      ownedPayload<AcquisitionRunEvent>(row, "run_event"));
  }

  async listRunCandidateLinks(
    runId: string
  ): Promise<AcquisitionRunCandidateLink[]> {
    const result = await rows(
      this.pool,
      `SELECT candidate_id, occurred_at, event_id
       FROM (
         SELECT
           JSON_UNQUOTE(
             JSON_EXTRACT(e.payload_json, '$.data.candidateId')
           ) AS candidate_id,
           e.occurred_at,
           e.id AS event_id,
           ROW_NUMBER() OVER (
             PARTITION BY JSON_UNQUOTE(
               JSON_EXTRACT(e.payload_json, '$.data.candidateId')
             )
             ORDER BY e.occurred_at, e.id
           ) AS candidate_row
         FROM acquisition_run_events e
         INNER JOIN acquisition_runs r
           ON r.id = e.run_id
          AND r.owner_id = e.owner_id
          AND r.team_id = e.team_id
         WHERE e.run_id = ?
           AND JSON_UNQUOTE(
             JSON_EXTRACT(e.payload_json, '$.type')
           ) = 'candidate.discovered'
       ) discovered
       WHERE candidate_row = 1
       ORDER BY occurred_at, event_id`,
      [runId]
    );
    return result.map((row) => ({
      candidateId: requiredString(
        row.candidate_id,
        "candidate_id",
        "run_candidate_link"
      ),
      createdAt: mysqlIso(row.occurred_at, "run_candidate_link"),
      eventId: requiredString(
        row.event_id,
        "event_id",
        "run_candidate_link"
      )
    }));
  }

  async listRunCandidateEventsPage(
    runId: string,
    query: AcquisitionRunEventPageQuery
  ) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
      throw new Error("RUN_CANDIDATE_EVENT_LIMIT_INVALID");
    }
    const cursorClause = query.after
      ? ` AND (
            e.occurred_at > ?
            OR (e.occurred_at = ? AND e.id > ?)
          )`
      : "";
    const values: unknown[] = [runId];
    if (query.after) {
      values.push(
        mysqlDate(query.after.createdAt),
        mysqlDate(query.after.createdAt),
        query.after.eventId
      );
    }
    values.push(query.limit);
    const result = await rows(
      this.pool,
      `SELECT e.*
       FROM acquisition_run_events e
       INNER JOIN acquisition_runs r
         ON r.id = e.run_id
        AND r.owner_id = e.owner_id
        AND r.team_id = e.team_id
       WHERE e.run_id = ?
         AND JSON_UNQUOTE(
           JSON_EXTRACT(e.payload_json, '$.type')
         ) = 'candidate.discovered'${cursorClause}
       ORDER BY e.occurred_at, e.id
       LIMIT ?`,
      values
    );
    return result.map((row) =>
      ownedPayload<AcquisitionRunEvent>(row, "run_event"));
  }

  async getRunPresentationExecution(
    runId: string
  ): Promise<AcquisitionRunPresentationExecution> {
    const result = await rows(
      this.pool,
       `WITH terminal_events AS (
         SELECT shard_id, payload_json, occurred_at
         FROM (
           SELECT
             e.shard_id,
             e.payload_json,
             e.occurred_at,
             ROW_NUMBER() OVER (
               PARTITION BY e.shard_id
               ORDER BY e.occurred_at DESC, e.id DESC
             ) AS terminal_row
           FROM acquisition_run_events e
           WHERE e.run_id = ?
             AND JSON_UNQUOTE(
               JSON_EXTRACT(e.payload_json, '$.type')
             ) IN (
               'shard.succeeded',
               'shard.succeeded_empty',
               'shard.partial_success',
               'shard.failed',
               'shard.cancelled'
             )
         ) ranked
         WHERE terminal_row = 1
       ),
       started_shards AS (
         SELECT shard_id, occurred_at
         FROM (
           SELECT e.shard_id, e.occurred_at,
             ROW_NUMBER() OVER (
               PARTITION BY e.shard_id
               ORDER BY e.occurred_at, e.id
             ) AS started_row
           FROM acquisition_run_events e
           WHERE e.run_id = ?
             AND JSON_UNQUOTE(
               JSON_EXTRACT(e.payload_json, '$.type')
             ) = 'shard.started'
         ) ranked
         WHERE started_row = 1
       )
       SELECT
         s.*,
         terminal_events.payload_json AS terminal_payload_json,
         DATE_FORMAT(
           terminal_events.occurred_at,
           '%Y-%m-%d %H:%i:%s.%f'
         ) AS terminal_occurred_at,
         DATE_FORMAT(
           started_shards.occurred_at,
           '%Y-%m-%d %H:%i:%s.%f'
         ) AS started_occurred_at,
         CASE
           WHEN started_shards.shard_id IS NULL THEN 0
           ELSE 1
         END AS has_started
       FROM acquisition_operation_shards s
       INNER JOIN acquisition_runs r
         ON r.id = s.run_id
        AND r.owner_id = s.owner_id
        AND r.team_id = s.team_id
       LEFT JOIN terminal_events ON terminal_events.shard_id = s.id
       LEFT JOIN started_shards ON started_shards.shard_id = s.id
       WHERE s.run_id = ?
       ORDER BY s.created_at, s.id`,
      [runId, runId, runId]
    );
    const sources = new Set<string>();
    let pagesAnalyzed = 0;
    const providers = result.map((row) => {
      const shard = ownedPayload<AcquisitionOperationShard>(
        row,
        "presentation_shard"
      );
      const terminal = row.terminal_payload_json === null
        || row.terminal_payload_json === undefined
        ? null
        : parseJson(
            row.terminal_payload_json,
            "presentation_terminal_event"
          ) as unknown as AcquisitionRunEvent;
      if (
        terminal
        && (
          terminal.runId !== runId
          || terminal.shardId !== shard.id
          || terminal.ownerId !== shard.ownerId
          || terminal.teamId !== shard.teamId
        )
      ) {
        throw new Error(
          "ACQUISITION_MYSQL_INTEGRITY:presentation_terminal_event:scope_mismatch"
        );
      }
      if (Number(row.has_started) === 1) {
        sources.add(
          `${shard.connection.providerId}\u0000`
          + shard.connection.connectionId
        );
      }
      pagesAnalyzed += shard.consumedBudget.results;
      const count = (field: string) => {
        const value = terminal?.data[field];
        return Number.isSafeInteger(value) && Number(value) >= 0
          ? Number(value)
          : 0;
      };
      const text = (field: string) => {
        const value = terminal?.data[field];
        return typeof value === "string" && value ? value : null;
      };
      return {
        shardId: shard.id,
        connectionId: shard.connection.connectionId,
        providerId: shard.connection.providerId,
        status: shard.status,
        rawResultCount: count("rawResultCount"),
        acceptedResultCount: count("acceptedResultCount"),
        duplicateResultCount: count("duplicateResultCount"),
        failedResultCount: count("failedResultCount"),
        errorCode: text("errorCode"),
        retryAfterAt: text("retryAfterAt"),
        startedAt: row.started_occurred_at === null
          || row.started_occurred_at === undefined
          ? null
          : mysqlUtcIso(row.started_occurred_at, "started_occurred_at"),
        completedAt: row.terminal_occurred_at === null
          || row.terminal_occurred_at === undefined
          ? null
          : mysqlUtcIso(row.terminal_occurred_at, "terminal_occurred_at")
      };
    });
    return {
      providers,
      sourcesSearched: sources.size,
      pagesAnalyzed
    };
  }

  async listRunExecutionIntents(runId: string) {
    const result = await rows(
      this.pool,
      `SELECT i.*
       FROM acquisition_execution_intents i
       INNER JOIN acquisition_runs r
         ON r.id = i.run_id
        AND r.owner_id = i.owner_id
        AND r.team_id = i.team_id
       WHERE i.run_id = ?
       ORDER BY i.created_at, i.id`,
      [runId]
    );
    return result.map((row) =>
      ownedPayload<AcquisitionExecutionIntent>(row, "execution_intent"));
  }

  async listRecoverableExecutionIntents(now: string) {
    const result = await rows(
      this.pool,
      `SELECT i.*
       FROM acquisition_execution_intents i
       INNER JOIN acquisition_runs r
         ON r.id = i.run_id
        AND r.owner_id = i.owner_id
        AND r.team_id = i.team_id
       WHERE i.status = 'pending'
          OR (i.status = 'dispatching'
              AND (i.lease_until IS NULL OR i.lease_until <= ?))
          OR i.status = 'dispatched'
       ORDER BY i.created_at, i.id`,
      [mysqlDate(now)]
    );
    const intents = result.map((row) =>
      ownedPayload<AcquisitionExecutionIntent>(row, "execution_intent"));
    const shardsByRun = new Map<string, AcquisitionOperationShard[]>();
    for (const intent of intents) {
      if (!shardsByRun.has(intent.runId)) {
        shardsByRun.set(
          intent.runId,
          await this.listRunShards(intent.runId)
        );
      }
    }
    return intents.filter((intent) =>
      intentNeedsRecovery(
        intent,
        shardsByRun.get(intent.runId) ?? [],
        now
      ));
  }

  async listAuditEvents(scope: { ownerId: string; teamId: string }) {
    const result = await rows(
      this.pool,
      `SELECT *
       FROM acquisition_plan_run_audit_events
       WHERE owner_id = ? AND team_id = ?
       ORDER BY occurred_at, id`,
      [scope.ownerId, scope.teamId]
    );
    return result.map((row) =>
      ownedPayload<AcquisitionAuditEvent>(row, "plan_run_audit"));
  }
}

export function createMysqlAcquisitionRepositories(
  pool: mysql.Pool,
  options: {
    temporalBarrier?: GrowthTemporalBarrier;
    advisorAuthority?: Pick<
      MysqlAdvisorCandidateAuthorityRepository,
      "insertWithStamp"
    >;
  } = {}
) {
  return {
    domain: new MysqlAcquisitionDomainRepository(pool, options),
    copilot: new MysqlAcquisitionCopilotRepository(pool),
    planRun: new MysqlAcquisitionPlanRunRepository(pool)
  };
}
