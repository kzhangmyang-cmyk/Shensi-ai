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
  createQuoteVersionFromCalculation,
  immutableQuoteValue,
  quoteSubjectEvidence,
  snapshotQuoteCalculation,
  type BindQuoteCaseDealCommand,
  type AppendQuotePreviewEvidenceCommand,
  type AppendQuoteVersionCommand,
  type AppendQuoteVersionResult,
  type CancelQuoteCaseCommand,
  type CloseQuoteCaseCommand,
  type CreateQuoteCaseCommand,
  type QuoteCase,
  type QuoteCaseCommandResult,
  type QuoteCaseListQuery,
  type QuoteRepository,
  type QuoteVersion,
  type QuotePreviewEvidenceRecord,
  type QuoteApproval,
  type QuoteApprovalEvent,
  type QuoteLifecycleEvent,
  type DealAuthoritativeQuote,
  type DealAuthoritativeQuoteEvent,
  type DecideQuoteApprovalCommand,
  type QuoteApprovalDecisionPersistenceResult,
  type QuotePublicationOperation,
  type QuotePublicationClaim,
  type QuotePublicationHistory,
  type DecideDealPersistenceCommand,
  type DealCommercialDecisionPersistenceResult,
  type CommercialBindingEvidenceSnapshot
} from "./quote-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import type { CommercialBindingSnapshot } from "./commercial-binding-snapshot.js";
import type { OutcomeAttributionInput } from "./acquisition-domain.js";
import type { Deal, DealEvent } from "./types.js";

type MysqlRow = Record<string, unknown>;

export const QUOTE_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS quote_cases (
    workspace_id VARCHAR(191) NOT NULL,
    id VARCHAR(191) NOT NULL,
    candidate_id VARCHAR(191) NULL,
    customer_id VARCHAR(191) NULL,
    deal_id VARCHAR(191) NULL,
    assigned_to VARCHAR(191) NOT NULL,
    status ENUM('open','closed','cancelled') NOT NULL,
    current_draft_version_id VARCHAR(191) NULL,
    revision BIGINT UNSIGNED NOT NULL,
    binding_snapshot_id VARCHAR(191) NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    open_deal_id VARCHAR(191) GENERATED ALWAYS AS (
      CASE WHEN status = 'open' THEN deal_id ELSE NULL END
    ) STORED,
    PRIMARY KEY (workspace_id,id),
    UNIQUE KEY uk_quote_open_deal (workspace_id,open_deal_id),
    KEY idx_quote_case_list (workspace_id,status,id),
    CONSTRAINT chk_quote_case_subject CHECK (
      candidate_id IS NOT NULL OR customer_id IS NOT NULL OR deal_id IS NOT NULL
    ),
    CONSTRAINT chk_quote_case_workspace CHECK (
      workspace_id <> 'all' AND CHAR_LENGTH(TRIM(workspace_id)) > 0
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS commercial_binding_snapshots (
    workspace_id VARCHAR(191) NOT NULL,
    id VARCHAR(191) NOT NULL,
    quote_case_id VARCHAR(191) NOT NULL,
    candidate_id VARCHAR(191) NOT NULL,
    handoff_id VARCHAR(191) NOT NULL,
    lead_id VARCHAR(191) NULL,
    customer_id VARCHAR(191) NOT NULL,
    deal_id VARCHAR(191) NOT NULL,
    candidate_version BIGINT UNSIGNED NOT NULL,
    handoff_content_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    deal_content_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    binding_hash_schema_version VARCHAR(64) NOT NULL,
    attribution_snapshot_json JSON NOT NULL,
    binding_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    verified_at DATETIME(3) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id,id),
    UNIQUE KEY uk_quote_case_binding (workspace_id,quote_case_id),
    KEY idx_quote_binding_deal (workspace_id,deal_id),
    CONSTRAINT chk_quote_binding_attribution CHECK (
      JSON_VALID(attribution_snapshot_json)
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS quote_versions (
    workspace_id VARCHAR(191) NOT NULL,
    id VARCHAR(191) NOT NULL,
    quote_case_id VARCHAR(191) NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    version_kind ENUM('draft','formal') NOT NULL,
    source_draft_version_id VARCHAR(191) NULL,
    probability_assessment_json JSON NULL,
    frozen_version_json JSON NOT NULL,
    effective_at DATETIME(3) NOT NULL,
    created_by VARCHAR(191) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    stable_command_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (workspace_id,id),
    UNIQUE KEY uk_quote_case_version (workspace_id,quote_case_id,version),
    UNIQUE KEY uk_quote_version_stable (workspace_id,stable_command_hash),
    UNIQUE KEY uk_quote_formal_source_draft (workspace_id,source_draft_version_id),
    CONSTRAINT chk_quote_version_authority CHECK ((version_kind = 'draft'
      AND source_draft_version_id IS NULL AND probability_assessment_json IS NULL)
      OR (version_kind = 'formal' AND source_draft_version_id IS NOT NULL
        AND probability_assessment_json IS NOT NULL)),
    CONSTRAINT chk_quote_version_json CHECK (JSON_VALID(frozen_version_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS quote_preview_evidence (
    workspace_id VARCHAR(191) NOT NULL,
    id VARCHAR(191) NOT NULL,
    quote_case_id VARCHAR(191) NOT NULL,
    quote_case_revision BIGINT UNSIGNED NOT NULL,
    created_by VARCHAR(191) NOT NULL,
    request_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    stable_command_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    input_snapshot_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    calculation_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    evidence_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    effective_at DATETIME(3) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    evidence_json JSON NOT NULL,
    PRIMARY KEY (workspace_id,id),
    UNIQUE KEY uk_quote_preview_stable (workspace_id,stable_command_hash),
    KEY idx_quote_preview_identity
      (workspace_id,quote_case_id,input_snapshot_hash,calculation_hash),
    CONSTRAINT chk_quote_preview_json CHECK (JSON_VALID(evidence_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS quote_version_line_snapshots (
    workspace_id VARCHAR(191) NOT NULL, quote_version_id VARCHAR(191) NOT NULL,
    line_number INT UNSIGNED NOT NULL, snapshot_json JSON NOT NULL,
    PRIMARY KEY (workspace_id,quote_version_id,line_number),
    CONSTRAINT chk_quote_line_snapshot_json CHECK (JSON_VALID(snapshot_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS quote_version_gift_snapshots (
    workspace_id VARCHAR(191) NOT NULL, quote_version_id VARCHAR(191) NOT NULL,
    gift_number INT UNSIGNED NOT NULL, snapshot_json JSON NOT NULL,
    PRIMARY KEY (workspace_id,quote_version_id,gift_number),
    CONSTRAINT chk_quote_gift_snapshot_json CHECK (JSON_VALID(snapshot_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS quote_version_package_snapshots (
    workspace_id VARCHAR(191) NOT NULL, quote_version_id VARCHAR(191) NOT NULL,
    package_version_id VARCHAR(191) NOT NULL, snapshot_json JSON NOT NULL,
    PRIMARY KEY (workspace_id,quote_version_id,package_version_id),
    CONSTRAINT chk_quote_package_snapshot_json CHECK (JSON_VALID(snapshot_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS quote_lifecycle_events (
    workspace_id VARCHAR(191) NOT NULL, id VARCHAR(191) NOT NULL,
    quote_case_id VARCHAR(191) NOT NULL, quote_version_id VARCHAR(191) NULL,
    lifecycle_stream_id VARCHAR(191) GENERATED ALWAYS AS (
      COALESCE(quote_version_id,'__case__')
    ) STORED,
    lifecycle_revision BIGINT UNSIGNED NOT NULL,
    from_status VARCHAR(32) NULL, to_status VARCHAR(32) NOT NULL,
    event_type VARCHAR(64) NOT NULL, actor_id VARCHAR(191) NOT NULL,
    recorded_at DATETIME(3) NOT NULL, temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id,id),
    UNIQUE KEY uk_quote_lifecycle_revision
      (workspace_id,quote_case_id,lifecycle_stream_id,lifecycle_revision),
    KEY idx_quote_lifecycle_current
      (workspace_id,quote_case_id,quote_version_id,lifecycle_revision)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS quote_approvals (
    workspace_id VARCHAR(191) NOT NULL, id VARCHAR(191) NOT NULL,
    quote_version_id VARCHAR(191) NOT NULL,
    status ENUM('pending','approved','rejected','cancelled') NOT NULL,
    approval_kind ENUM('confirmation','exception') NOT NULL,
    approval_json JSON NOT NULL,
    active_quote_version_id VARCHAR(191) GENERATED ALWAYS AS (
      CASE WHEN status = 'pending' THEN quote_version_id ELSE NULL END
    ) STORED,
    recorded_at DATETIME(3) NOT NULL, temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id,id),
    UNIQUE KEY uk_quote_active_approval (workspace_id,active_quote_version_id),
    CONSTRAINT chk_quote_approval_json CHECK (JSON_VALID(approval_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS quote_approval_events (
    workspace_id VARCHAR(191) NOT NULL, id VARCHAR(191) NOT NULL,
    quote_version_id VARCHAR(191) NOT NULL, approval_id VARCHAR(191) NOT NULL,
    approval_revision BIGINT UNSIGNED NOT NULL, status VARCHAR(32) NOT NULL,
    event_json JSON NOT NULL, recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id,id),
    UNIQUE KEY uk_quote_approval_revision
      (workspace_id,approval_id,approval_revision),
    KEY idx_quote_approval_as_of
      (workspace_id,quote_version_id,recorded_at,approval_revision),
    CONSTRAINT chk_quote_approval_event_json CHECK (JSON_VALID(event_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS deal_authoritative_quotes (
    workspace_id VARCHAR(191) NOT NULL, deal_id VARCHAR(191) NOT NULL,
    open_quote_case_id VARCHAR(191) NULL, quote_version_id VARCHAR(191) NULL,
    commercial_amount_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,
    authority_revision BIGINT UNSIGNED NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id,deal_id),
    UNIQUE KEY uk_deal_open_quote_case (workspace_id,open_quote_case_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS deal_authoritative_quote_events (
    workspace_id VARCHAR(191) NOT NULL, id VARCHAR(191) NOT NULL,
    deal_id VARCHAR(191) NOT NULL, authority_revision BIGINT UNSIGNED NOT NULL,
    quote_case_id VARCHAR(191) NOT NULL, quote_version_id VARCHAR(191) NULL,
    event_type VARCHAR(64) NOT NULL,
    recorded_at DATETIME(3) NOT NULL, temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id,id),
    UNIQUE KEY uk_deal_authority_revision
      (workspace_id,deal_id,authority_revision)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS deal_authoritative_quote_event_payloads (
    workspace_id VARCHAR(191) NOT NULL, event_id VARCHAR(191) NOT NULL,
    event_json JSON NOT NULL,
    PRIMARY KEY (workspace_id,event_id),
    CONSTRAINT chk_deal_authority_event_payload_json CHECK (
      JSON_VALID(event_json)
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS quote_publication_operations (
    workspace_id VARCHAR(191) NOT NULL, id VARCHAR(191) NOT NULL,
    quote_case_id VARCHAR(191) NOT NULL, quote_version_id VARCHAR(191) NOT NULL,
    deal_id VARCHAR(191) NOT NULL, stable_key_hash CHAR(71) NOT NULL,
    status VARCHAR(32) NOT NULL,
    authority_revision BIGINT UNSIGNED NOT NULL,
    lease_owner VARCHAR(191) NULL,
    fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
    lease_expires_at DATETIME(3) NULL,
    pi_document_id VARCHAR(191) NULL,
    deal_event_id VARCHAR(191) NULL,
    operation_json JSON NOT NULL,
    recorded_at DATETIME(3) NOT NULL, temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id,id),
    UNIQUE KEY uk_quote_publication_stable (workspace_id,stable_key_hash),
    CONSTRAINT chk_quote_publication_json CHECK (JSON_VALID(operation_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS quote_publication_history (
    workspace_id VARCHAR(191) NOT NULL, id VARCHAR(191) NOT NULL,
    operation_id VARCHAR(191) NOT NULL, status VARCHAR(32) NOT NULL,
    lease_owner VARCHAR(191) NULL, fencing_token BIGINT UNSIGNED NOT NULL,
    authority_revision BIGINT UNSIGNED NOT NULL,
    pi_document_id VARCHAR(191) NULL, deal_event_id VARCHAR(191) NULL,
    error_code VARCHAR(191) NULL, actor_id VARCHAR(191) NULL,
    recorded_at DATETIME(3) NOT NULL, temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id,id),
    KEY idx_quote_publication_history (workspace_id,operation_id,temporal_sequence)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS quote_command_idempotency (
    workspace_id VARCHAR(191) NOT NULL, command_key VARCHAR(255) NOT NULL,
    request_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    quote_case_id VARCHAR(191) NOT NULL, completed_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id,command_key)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS quote_approval_command_results (
    workspace_id VARCHAR(191) NOT NULL,
    stable_command_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    decision_json JSON NOT NULL, completed_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id,stable_command_hash),
    CONSTRAINT chk_quote_approval_decision_json CHECK (JSON_VALID(decision_json))
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS deal_commercial_decision_results (
    workspace_id VARCHAR(191) NOT NULL,
    stable_command_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_id VARCHAR(191) NOT NULL, decision_json JSON NOT NULL,
    completed_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id,stable_command_hash),
    UNIQUE KEY uk_deal_commercial_decision_event (workspace_id,event_id),
    CONSTRAINT chk_deal_commercial_decision_json CHECK (
      JSON_VALID(decision_json)
    )
  ) ENGINE=InnoDB`,
  `ALTER TABLE deal_events
    ADD COLUMN IF NOT EXISTS commercial_binding_evidence_json JSON NULL,
    ADD COLUMN IF NOT EXISTS commercial_binding_snapshot_json JSON NULL,
    ADD COLUMN IF NOT EXISTS decision_reason_code VARCHAR(191) NULL,
    ADD COLUMN IF NOT EXISTS decision_reason_text TEXT NULL,
    ADD COLUMN IF NOT EXISTS decision_occurred_at DATETIME(3) NULL,
    ADD COLUMN IF NOT EXISTS decision_authority_revision BIGINT UNSIGNED NULL`,
  `ALTER TABLE quote_publication_operations
    ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'queued',
    ADD COLUMN IF NOT EXISTS authority_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lease_owner VARCHAR(191) NULL,
    ADD COLUMN IF NOT EXISTS fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lease_expires_at DATETIME(3) NULL,
    ADD COLUMN IF NOT EXISTS pi_document_id VARCHAR(191) NULL,
    ADD COLUMN IF NOT EXISTS deal_event_id VARCHAR(191) NULL`,
  `UPDATE quote_publication_operations SET
     status = JSON_UNQUOTE(JSON_EXTRACT(operation_json,'$.status')),
     authority_revision = CAST(JSON_UNQUOTE(JSON_EXTRACT(
       operation_json,'$.dealAuthorityRevision')) AS UNSIGNED),
     lease_owner = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(
       operation_json,'$.leaseOwner')),'null'),
     fencing_token = COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(
       operation_json,'$.fencingToken')) AS UNSIGNED),0),
     lease_expires_at = STR_TO_DATE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(
       operation_json,'$.leaseExpiresAt')),'null'),'%Y-%m-%dT%H:%i:%s.%fZ'),
     pi_document_id = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(
       operation_json,'$.piDocumentId')),'null'),
     deal_event_id = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(
       operation_json,'$.dealEventId')),'null')
   WHERE authority_revision = 0`
] as const;

export async function ensureQuoteMysqlSchema(pool: mysql.Pool): Promise<void> {
  for (const statement of QUOTE_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function quoteError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function hash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value) ?? "")
    .digest("hex")}`;
}

function parseVersionRow(row: MysqlRow): QuoteVersion {
  return immutableQuoteValue(json<QuoteVersion>(row.frozen_version_json));
}

function parseEvidenceRow(row: MysqlRow): QuotePreviewEvidenceRecord {
  return immutableQuoteValue(
    json<QuotePreviewEvidenceRecord>(row.evidence_json)
  );
}

function parseApprovalRow(row: MysqlRow): QuoteApproval {
  return immutableQuoteValue(json<QuoteApproval>(row.approval_json));
}

function parseLifecycleRow(row: MysqlRow): QuoteLifecycleEvent {
  return immutableQuoteValue({
    id: String(row.id), workspaceId: String(row.workspace_id),
    quoteCaseId: String(row.quote_case_id),
    quoteVersionId: row.quote_version_id === null
      ? null : String(row.quote_version_id),
    revision: Number(row.lifecycle_revision),
    fromStatus: row.from_status === null ? null
      : String(row.from_status) as QuoteLifecycleEvent["fromStatus"],
    toStatus: String(row.to_status) as QuoteLifecycleEvent["toStatus"],
    eventType: String(row.event_type) as QuoteLifecycleEvent["eventType"],
    actorId: String(row.actor_id),
    recordedAt: growthMysqlInstant(row.recorded_at),
    temporalSequence: Number(row.temporal_sequence)
  });
}

function parseAuthorityEventRow(row: MysqlRow): DealAuthoritativeQuoteEvent {
  if (row.event_json) {
    return immutableQuoteValue(json<DealAuthoritativeQuoteEvent>(row.event_json));
  }
  return immutableQuoteValue({
    id: String(row.id), workspaceId: String(row.workspace_id),
    dealId: String(row.deal_id), authorityRevision: Number(row.authority_revision),
    quoteCaseId: String(row.quote_case_id),
    quoteVersionId: row.quote_version_id === null
      ? null : String(row.quote_version_id),
    eventType: String(row.event_type) as DealAuthoritativeQuoteEvent["eventType"],
    recordedAt: growthMysqlInstant(row.recorded_at),
    temporalSequence: Number(row.temporal_sequence)
  });
}

function parseAuthorityRow(row: MysqlRow): DealAuthoritativeQuote {
  return immutableQuoteValue({
    workspaceId: String(row.workspace_id), dealId: String(row.deal_id),
    openQuoteCaseId: row.open_quote_case_id === null
      ? null : String(row.open_quote_case_id),
    quoteVersionId: row.quote_version_id === null
      ? null : String(row.quote_version_id),
    commercialAmountHash: row.commercial_amount_hash === null
      ? null : String(row.commercial_amount_hash) as `sha256:${string}`,
    authorityRevision: Number(row.authority_revision),
    updatedAt: growthMysqlInstant(row.updated_at)
  });
}

function parsePublicationRow(row: MysqlRow): QuotePublicationOperation {
  const stored = immutableQuoteValue(json<QuotePublicationOperation>(
    row.operation_json
  ));
  return immutableQuoteValue({ ...stored,
    status: String(row.status ?? stored.status) as
      QuotePublicationOperation["status"],
    dealAuthorityRevision: Number(row.authority_revision
      ?? stored.dealAuthorityRevision),
    leaseOwner: row.lease_owner === undefined
      ? stored.leaseOwner ?? null
      : row.lease_owner === null ? null : String(row.lease_owner),
    fencingToken: Number(row.fencing_token ?? stored.fencingToken ?? 0),
    leaseExpiresAt: row.lease_expires_at === undefined
      ? stored.leaseExpiresAt ?? null
      : row.lease_expires_at === null ? null
        : growthMysqlInstant(row.lease_expires_at),
    piDocumentId: row.pi_document_id === undefined
      ? stored.piDocumentId : row.pi_document_id === null ? null
        : String(row.pi_document_id),
    dealEventId: row.deal_event_id === undefined
      ? stored.dealEventId : row.deal_event_id === null ? null
        : String(row.deal_event_id)
  });
}

function bindingFromRow(row: MysqlRow): CommercialBindingSnapshot | null {
  if (row.binding_snapshot_id === null || row.binding_snapshot_id === undefined) {
    return null;
  }
  return Object.freeze({
    candidateId: String(row.binding_candidate_id),
    handoffId: String(row.handoff_id),
    leadId: row.binding_lead_id === null ? null : String(row.binding_lead_id),
    customerId: String(row.binding_customer_id),
    dealId: String(row.binding_deal_id),
    candidateVersion: Number(row.candidate_version),
    handoffContentHash: String(row.handoff_content_hash) as `sha256:${string}`,
    dealContentHash: String(row.deal_content_hash) as `sha256:${string}`,
    bindingHashSchemaVersion: String(row.binding_hash_schema_version) as "commercial-binding.v1",
    attributionSnapshot: json<OutcomeAttributionInput>(row.attribution_snapshot_json),
    bindingHash: String(row.binding_hash) as `sha256:${string}`,
    verifiedAt: growthMysqlInstant(row.verified_at)
  });
}

function parseCase(row: MysqlRow): QuoteCase {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw quoteError("invalid_quote_case_revision");
  }
  return Object.freeze({
    id: String(row.id), workspaceId: String(row.workspace_id),
    candidateId: row.candidate_id === null ? null : String(row.candidate_id),
    customerId: row.customer_id === null ? null : String(row.customer_id),
    dealId: row.deal_id === null ? null : String(row.deal_id),
    assignedTo: String(row.assigned_to),
    status: String(row.status) as QuoteCase["status"],
    currentDraftVersionId: row.current_draft_version_id === null
      ? null : String(row.current_draft_version_id),
    revision, commercialBindingSnapshot: bindingFromRow(row),
    createdAt: growthMysqlInstant(row.created_at),
    updatedAt: growthMysqlInstant(row.updated_at)
  });
}

const CASE_SELECT = `SELECT qc.*, cbs.id AS binding_snapshot_id,
  cbs.candidate_id AS binding_candidate_id, cbs.handoff_id,
  cbs.lead_id AS binding_lead_id, cbs.customer_id AS binding_customer_id,
  cbs.deal_id AS binding_deal_id, cbs.candidate_version,
  cbs.handoff_content_hash, cbs.deal_content_hash,
  cbs.binding_hash_schema_version, cbs.attribution_snapshot_json,
  cbs.binding_hash, cbs.verified_at
  FROM quote_cases qc LEFT JOIN commercial_binding_snapshots cbs
    ON cbs.workspace_id = qc.workspace_id
    AND cbs.id = qc.binding_snapshot_id`;

function affectedRows(result: unknown) {
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

function duplicate(error: unknown) {
  return (error as { code?: string }).code === "ER_DUP_ENTRY";
}

export class MysqlQuoteRepository implements QuoteRepository {
  private readonly temporalBarrier: GrowthTemporalBarrier;

  constructor(private readonly pool: mysql.Pool, temporalBarrier: GrowthTemporalBarrier) {
    this.temporalBarrier = assertGrowthTemporalBarrier(temporalBarrier);
  }

  private async transaction<T>(work: (
    connection: mysql.PoolConnection,
    temporal: MysqlGrowthTemporalTransaction
  ) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection,
        new MysqlGrowthTemporalTransaction(connection));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async publicationWorkspace(operationId: string) {
    const [rows] = await this.pool.query(
      `SELECT workspace_id FROM quote_publication_operations WHERE id = ?`,
      [operationId]
    );
    const matches = rows as MysqlRow[];
    if (matches.length > 1) throw quoteError("publication_identity_ambiguous");
    return matches[0] ? String(matches[0].workspace_id) : null;
  }

  private async lockedPublication(
    connection: mysql.PoolConnection,
    workspaceId: string,
    operationId: string
  ) {
    const [rows] = await connection.query(
      `SELECT * FROM quote_publication_operations
       WHERE workspace_id = ? AND id = ? FOR UPDATE`,
      [workspaceId, operationId]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parsePublicationRow(row) : null;
  }

  private async appendPublicationHistory(
    connection: mysql.PoolConnection,
    temporal: MysqlGrowthTemporalTransaction,
    operation: QuotePublicationOperation,
    errorCode: string | null,
    actorId: string | null
  ) {
    const stamp = await this.temporalBarrier.allocateAppend(
      temporal,
      operation.workspaceId
    );
    const history: QuotePublicationHistory = immutableQuoteValue({
      id: `quote-publication-history-${operation.workspaceId}-${stamp.temporalSequence}`,
      workspaceId: operation.workspaceId, operationId: operation.id,
      status: operation.status, leaseOwner: operation.leaseOwner,
      fencingToken: operation.fencingToken,
      authorityRevision: operation.dealAuthorityRevision,
      piDocumentId: operation.piDocumentId,
      dealEventId: operation.dealEventId, errorCode, actorId, ...stamp
    });
    await connection.query(
      `INSERT INTO quote_publication_history
       (workspace_id,id,operation_id,status,lease_owner,fencing_token,
        authority_revision,pi_document_id,deal_event_id,error_code,actor_id,
        recorded_at,temporal_sequence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [history.workspaceId, history.id, history.operationId, history.status,
        history.leaseOwner, history.fencingToken, history.authorityRevision,
        history.piDocumentId, history.dealEventId, history.errorCode,
        history.actorId, growthMysqlDate(history.recordedAt),
        history.temporalSequence]
    );
    return stamp;
  }

  private async receipt(
    connection: mysql.PoolConnection,
    workspaceId: string,
    commandKey: string,
    requestHash: string
  ): Promise<string | null> {
    const [rows] = await connection.query(
      `SELECT request_hash,quote_case_id FROM quote_command_idempotency
       WHERE workspace_id = ? AND command_key = ? FOR UPDATE`,
      [workspaceId, commandKey]
    );
    const row = (rows as MysqlRow[])[0];
    if (!row) return null;
    if (String(row.request_hash) !== requestHash) {
      throw quoteError("quote_command_identity_conflict");
    }
    return String(row.quote_case_id);
  }

  private async load(
    connection: mysql.PoolConnection | mysql.Pool,
    workspaceId: string,
    id: string,
    forUpdate = false
  ) {
    const [rows] = await connection.query(
      `${CASE_SELECT} WHERE qc.workspace_id = ? AND qc.id = ?${forUpdate ? " FOR UPDATE" : ""}`,
      [workspaceId, id]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parseCase(row) : null;
  }

  private async complete(
    connection: mysql.PoolConnection,
    command: { workspaceId: string; commandKey: string; requestHash: string },
    quoteCaseId: string,
    completedAt: string
  ) {
    await connection.query(
      `INSERT INTO quote_command_idempotency
       (workspace_id,command_key,request_hash,quote_case_id,completed_at)
       VALUES (?,?,?,?,?)`,
      [command.workspaceId, command.commandKey, command.requestHash,
        quoteCaseId, growthMysqlDate(completedAt)]
    );
  }

  async listCases(workspaceId: string, query: QuoteCaseListQuery) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const where = ["qc.workspace_id = ?"];
    const values: unknown[] = [workspace];
    if (query.status) { where.push("qc.status = ?"); values.push(query.status); }
    if (query.assignedTo) { where.push("qc.assigned_to = ?"); values.push(query.assignedTo); }
    if (query.dealId) { where.push("qc.deal_id = ?"); values.push(query.dealId); }
    if (query.cursor) { where.push("qc.id > ?"); values.push(query.cursor); }
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    values.push(limit + 1);
    const [rows] = await this.pool.query(
      `${CASE_SELECT} WHERE ${where.join(" AND ")}
       ORDER BY qc.id LIMIT ?`, values
    );
    const parsed = (rows as MysqlRow[]).map(parseCase);
    return Object.freeze({
      items: Object.freeze(parsed.slice(0, limit)),
      nextCursor: parsed.length > limit ? parsed[limit - 1]!.id : null
    });
  }

  findCase(workspaceId: string, id: string) {
    return this.load(this.pool, assertConcreteGrowthWorkspaceId(workspaceId), id);
  }

  async assertCaseAccessible(workspaceId: string, id: string, actorId: string) {
    if (!actorId.trim()) throw quoteError("invalid_growth_actor_id");
    const quoteCase = await this.findCase(workspaceId, id);
    if (!quoteCase) throw quoteError("quote_case_not_found");
    return quoteCase;
  }

  private async loadVersion(
    connection: mysql.Pool | mysql.PoolConnection,
    workspaceId: string,
    id: string,
    forUpdate = false
  ) {
    const [rows] = await connection.query(
      `SELECT frozen_version_json FROM quote_versions
       WHERE workspace_id = ? AND id = ?${forUpdate ? " FOR UPDATE" : ""}`,
      [workspaceId, id]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parseVersionRow(row) : null;
  }

  getVersion(workspaceId: string, id: string) {
    return this.loadVersion(this.pool,
      assertConcreteGrowthWorkspaceId(workspaceId), id);
  }

  async listVersions(workspaceId: string, quoteCaseId: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const [rows] = await this.pool.query(
      `SELECT frozen_version_json FROM quote_versions
       WHERE workspace_id = ? AND quote_case_id = ? ORDER BY version`,
      [workspace, quoteCaseId]
    );
    return Object.freeze((rows as MysqlRow[]).map(parseVersionRow));
  }

  async listApprovals(workspaceId: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const [rows] = await this.pool.query(
      `SELECT approval_json FROM quote_approvals
       WHERE workspace_id = ? ORDER BY recorded_at,id`, [workspace]
    );
    return Object.freeze((rows as MysqlRow[]).map(parseApprovalRow));
  }

  async listApprovalEvents(workspaceId: string, quoteVersionId?: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const [rows] = await this.pool.query(
      `SELECT event_json FROM quote_approval_events
       WHERE workspace_id = ?${quoteVersionId ? " AND quote_version_id = ?" : ""}
       ORDER BY approval_revision`, quoteVersionId
        ? [workspace, quoteVersionId] : [workspace]
    );
    return Object.freeze((rows as MysqlRow[]).map((row) =>
      immutableQuoteValue(json<QuoteApprovalEvent>(row.event_json))));
  }

  async listLifecycleEvents(workspaceId: string, quoteVersionId?: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const [rows] = await this.pool.query(
      `SELECT * FROM quote_lifecycle_events
       WHERE workspace_id = ?${quoteVersionId ? " AND quote_version_id = ?" : ""}
       ORDER BY lifecycle_revision`, quoteVersionId
        ? [workspace, quoteVersionId] : [workspace]
    );
    return Object.freeze((rows as MysqlRow[]).map(parseLifecycleRow));
  }

  async listAuthorityEvents(workspaceId: string, dealId?: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const [rows] = await this.pool.query(
      `SELECT daqe.*,payload.event_json
       FROM deal_authoritative_quote_events daqe
       LEFT JOIN deal_authoritative_quote_event_payloads payload
         ON payload.workspace_id = daqe.workspace_id
        AND payload.event_id = daqe.id
       WHERE daqe.workspace_id = ?${dealId ? " AND daqe.deal_id = ?" : ""}
       ORDER BY daqe.authority_revision`, dealId
        ? [workspace, dealId] : [workspace]
    );
    return Object.freeze((rows as MysqlRow[]).map(parseAuthorityEventRow));
  }

  async listPreviewEvidenceAsOf(
    workspaceId: string,
    quoteCaseId: string,
    effectiveAsOf: string
  ) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const [rows] = await this.pool.query(
      `SELECT evidence_json FROM quote_preview_evidence
       WHERE workspace_id = ? AND quote_case_id = ? AND recorded_at <= ?
       ORDER BY temporal_sequence`,
      [workspace, quoteCaseId, growthMysqlDate(effectiveAsOf)]
    );
    return Object.freeze((rows as MysqlRow[]).map(parseEvidenceRow));
  }

  async findCurrentDealAuthority(workspaceId: string, dealId: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const [rows] = await this.pool.query(
      `SELECT * FROM deal_authoritative_quotes
       WHERE workspace_id = ? AND deal_id = ?`, [workspace, dealId]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parseAuthorityRow(row) : null;
  }

  async findApprovalDecisionByStableCommandHash(
    workspaceId: string,
    stableCommandHash: string
  ) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const [rows] = await this.pool.query(
      `SELECT decision_json FROM quote_approval_command_results
       WHERE workspace_id = ? AND stable_command_hash = ?`,
      [workspace, stableCommandHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? immutableQuoteValue(
      json<QuoteApprovalDecisionPersistenceResult>(row.decision_json)
    ) : null;
  }

  async findDealDecisionByStableCommandHash(
    workspaceId: string,
    stableCommandHash: string
  ) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const [rows] = await this.pool.query(
      `SELECT decision_json FROM deal_commercial_decision_results
       WHERE workspace_id = ? AND stable_command_hash = ?`,
      [workspace, stableCommandHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? immutableQuoteValue(
      json<DealCommercialDecisionPersistenceResult>(row.decision_json)
    ) : null;
  }

  async decideDeal(
    command: DecideDealPersistenceCommand
  ): Promise<DealCommercialDecisionPersistenceResult> {
    const workspaceId = assertConcreteGrowthWorkspaceId(command.workspaceId);
    return this.transaction(async (connection, temporal) => {
      const authorityStamp = await this.temporalBarrier.allocateAppend(
        temporal, workspaceId
      );
      const [replayRows] = await connection.query(
        `SELECT request_hash,decision_json
         FROM deal_commercial_decision_results
         WHERE workspace_id = ? AND stable_command_hash = ? FOR UPDATE`,
        [workspaceId, command.stableCommandHash]
      );
      const replay = (replayRows as MysqlRow[])[0];
      if (replay) {
        if (String(replay.request_hash) !== command.requestHash) {
          throw quoteError("quote_command_identity_conflict");
        }
        return immutableQuoteValue(
          json<DealCommercialDecisionPersistenceResult>(replay.decision_json)
        );
      }
      const [guardRows] = await connection.query(
        `SELECT * FROM deal_authoritative_quotes
         WHERE workspace_id = ? AND deal_id = ? FOR UPDATE`,
        [workspaceId, command.dealId]
      );
      const guard = (guardRows as MysqlRow[])[0] ?? null;
      const currentRevision = guard ? Number(guard.authority_revision) : 0;
      if (command.expectedAuthorityRevision !== Math.max(1, currentRevision)) {
        throw quoteError("revision_conflict");
      }
      const [terminalRows] = await connection.query(
        `SELECT id FROM deal_authoritative_quote_events
         WHERE workspace_id = ? AND deal_id = ?
           AND event_type IN ('won','lost') LIMIT 1 FOR UPDATE`,
        [workspaceId, command.dealId]
      );
      if ((terminalRows as MysqlRow[]).length) {
        throw quoteError("deal_already_decided");
      }
      const commercial = command.input.type !== "pre_quote_disqualified";
      if (commercial && (!guard?.quote_version_id
        || guard.quote_version_id !== command.input.quoteVersionId)) {
        throw quoteError("quote_version_conflict");
      }
      if (commercial && guard!.commercial_amount_hash
        !== command.input.commercialAmountHash) {
        throw quoteError("commercial_amount_hash_mismatch");
      }
      if (!commercial && guard?.quote_version_id) {
        throw quoteError("authoritative_quote_already_exists");
      }
      const [dealRows] = await connection.query(
        `SELECT * FROM deals WHERE id = ? AND team_id = ? FOR UPDATE`,
        [command.dealId, workspaceId]
      );
      const dealRow = (dealRows as MysqlRow[])[0];
      if (!dealRow) throw quoteError("deal_not_found");
      let quoteCase: QuoteCase | null = null;
      if (guard?.open_quote_case_id) {
        quoteCase = await this.load(connection, workspaceId,
          String(guard.open_quote_case_id), true);
      } else {
        const [caseRows] = await connection.query(
          `${CASE_SELECT} WHERE qc.workspace_id = ? AND qc.deal_id = ?
           AND qc.status = 'open' LIMIT 1 FOR UPDATE`,
          [workspaceId, command.dealId]
        );
        quoteCase = (caseRows as MysqlRow[])[0]
          ? parseCase((caseRows as MysqlRow[])[0]!) : null;
      }
      const version = commercial
        ? await this.loadVersion(connection, workspaceId,
            command.input.quoteVersionId, true)
        : null;
      let binding: CommercialBindingSnapshot | null = null;
      let evidence: CommercialBindingEvidenceSnapshot | null = null;
      let amountMinor: number | null = null;
      let currency: string | null = null;
      if (commercial) {
        binding = version?.commercialBindingSnapshot as
          CommercialBindingSnapshot | null;
        amountMinor = Number(version?.quotedAmountMinor);
        currency = String(version?.currency ?? "").toUpperCase();
        const expectedBindingHash = binding ? hash({
          customerId: binding.customerId,
          handoffContentHash: binding.handoffContentHash,
          dealContentHash: binding.dealContentHash,
          bindingHashSchemaVersion: binding.bindingHashSchemaVersion
        }) : null;
        if (!version || version.versionKind !== "formal"
          || version.status !== "approved" || !quoteCase
          || quoteCase.id !== version.quoteCaseId
          || quoteCase.dealId !== command.dealId || !binding
          || canonicalJsonStringify(quoteCase.commercialBindingSnapshot)
            !== canonicalJsonStringify(binding)
          || binding.bindingHash !== expectedBindingHash
          || binding.bindingHashSchemaVersion !== "commercial-binding.v1"
          || !Number.isSafeInteger(amountMinor) || amountMinor <= 0
          || !/^[A-Z]{3}$/u.test(currency)
          || version.commercialAmountHash
            !== command.input.commercialAmountHash) {
          throw quoteError("commercial_binding_authority_mismatch");
        }
        evidence = immutableQuoteValue({ candidateId: binding.candidateId,
          customerId: binding.customerId, dealId: binding.dealId,
          handoffContentHash: binding.handoffContentHash,
          dealContentHash: binding.dealContentHash,
          bindingHashSchemaVersion: binding.bindingHashSchemaVersion,
          bindingHash: binding.bindingHash });
      }
      const authorityRevision = currentRevision + 1;
      const eventType = command.input.type === "won" ? "won" : "lost";
      const authorityEvent: DealAuthoritativeQuoteEvent = immutableQuoteValue({
        id: `deal-authority-${workspaceId}-${authorityStamp.temporalSequence}`,
        workspaceId, dealId: command.dealId, authorityRevision,
        quoteCaseId: quoteCase?.id ?? "",
        quoteVersionId: commercial ? command.input.quoteVersionId : null,
        previousQuoteVersionId: guard?.quote_version_id
          ? String(guard.quote_version_id) : null,
        eventType, ...(commercial ? { currency: currency!,
          quotedAmountMinor: amountMinor!,
          commercialAmountHash: command.input.commercialAmountHash,
          commercialBindingEvidence: evidence!,
          commercialBindingSnapshot: binding! } : {}),
        reasonCode: command.input.reasonCode,
        reasonText: command.input.reasonText,
        decisionCommandHash: command.stableCommandHash,
        decidedAt: command.input.occurredAt, ...authorityStamp
      });
      await connection.query(
        `INSERT INTO deal_authoritative_quote_events
         (workspace_id,id,deal_id,authority_revision,quote_case_id,
          quote_version_id,event_type,recorded_at,temporal_sequence)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [workspaceId, authorityEvent.id, command.dealId, authorityRevision,
          authorityEvent.quoteCaseId, authorityEvent.quoteVersionId, eventType,
          growthMysqlDate(authorityStamp.recordedAt),
          authorityStamp.temporalSequence]
      );
      await connection.query(
        `INSERT INTO deal_authoritative_quote_event_payloads
         (workspace_id,event_id,event_json) VALUES (?,?,?)`,
        [workspaceId, authorityEvent.id, JSON.stringify(authorityEvent)]
      );
      const [operationRows] = await connection.query(
        `SELECT * FROM quote_publication_operations
         WHERE workspace_id = ? AND deal_id = ?
           AND status IN ('queued','running','partial_failure','failed')
         FOR UPDATE`, [workspaceId, command.dealId]
      );
      const cancelledPublicationOperationIds: string[] = [];
      for (const row of operationRows as MysqlRow[]) {
        const operation = parsePublicationRow(row);
        const cancelled = immutableQuoteValue({ ...operation,
          status: "cancelled" as const, leaseOwner: null,
          leaseExpiresAt: null, lastErrorCode: "deal_decided",
          updatedAt: authorityStamp.recordedAt });
        await connection.query(
          `UPDATE quote_publication_operations SET status = 'cancelled',
           lease_owner = NULL,lease_expires_at = NULL,operation_json = ?
           WHERE workspace_id = ? AND id = ?`,
          [JSON.stringify(cancelled), workspaceId, operation.id]
        );
        await this.appendPublicationHistory(connection, temporal, cancelled,
          "deal_decided", command.actorId);
        cancelledPublicationOperationIds.push(operation.id);
      }
      const dealEventStamp = await this.temporalBarrier.allocateAppend(
        temporal, workspaceId
      );
      const eventId = `deal-decision-${command.stableCommandHash.slice(7, 47)}`;
      await connection.query(
        `UPDATE deals SET stage = ?,amount_type = ?,
         amount = IF(?,?/100,amount),currency = IF(?,?,currency),
         stage_changed_at = ?,closed_at = ?,won_reason = ?,
         lost_reason_category = ?,lost_reason = ?
         WHERE id = ? AND team_id = ?`,
        [eventType === "won" ? "成交" : "丢单",
          command.input.type === "won" ? "won" : commercial
            ? "quoted" : "estimate", commercial, amountMinor, commercial,
          currency, growthMysqlDate(dealEventStamp.recordedAt),
          growthMysqlDate(command.input.occurredAt),
          eventType === "won" ? command.input.reasonText : null,
          eventType === "lost" ? command.input.reasonCode : null,
          eventType === "lost" ? command.input.reasonText : null,
          command.dealId, workspaceId]
      );
      await connection.query(
        `INSERT INTO deal_events
         (id,deal_id,event_type,content,operator_id,owner_id_snapshot,
          team_id_snapshot,customer_id_snapshot,lead_id_snapshot,
          handoff_id_snapshot,candidate_id_snapshot,amount_minor_snapshot,
          currency_snapshot,commercial_authority,quote_case_id_snapshot,
          quote_version_id_snapshot,commercial_amount_hash,
          deal_authority_revision_snapshot,commercial_binding_evidence_json,
          commercial_binding_snapshot_json,decision_reason_code,
          decision_reason_text,decision_occurred_at,
          decision_authority_revision,recorded_at,temporal_sequence,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [eventId, command.dealId, eventType,
          command.input.reasonText ?? command.input.reasonCode ?? "",
          command.actorId, dealRow.owner_id, workspaceId,
          commercial ? binding!.customerId : dealRow.customer_id,
          commercial ? binding!.leadId : null,
          commercial ? binding!.handoffId : null,
          commercial ? binding!.candidateId : null,
          commercial ? amountMinor : null, commercial ? currency : null,
          commercial ? "quote_projection" : "pre_quote_disqualified",
          quoteCase?.id ?? null,
          commercial ? command.input.quoteVersionId : null,
          commercial ? command.input.commercialAmountHash : null,
          authorityRevision, commercial ? JSON.stringify(evidence) : null,
          commercial ? JSON.stringify(binding) : null,
          command.input.reasonCode, command.input.reasonText,
          growthMysqlDate(command.input.occurredAt), authorityRevision,
          growthMysqlDate(dealEventStamp.recordedAt),
          dealEventStamp.temporalSequence,
          growthMysqlDate(dealEventStamp.recordedAt)]
      );
      let closedCase = quoteCase;
      if (quoteCase) {
        const lifecycleStamp = await this.temporalBarrier.allocateAppend(
          temporal, workspaceId
        );
        closedCase = immutableQuoteValue({ ...quoteCase, status: "closed",
          currentDraftVersionId: null, revision: quoteCase.revision + 1,
          updatedAt: lifecycleStamp.recordedAt });
        await connection.query(
          `UPDATE quote_cases SET status = 'closed',
           current_draft_version_id = NULL,revision = ?,updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
          [closedCase.revision, growthMysqlDate(closedCase.updatedAt),
            workspaceId, quoteCase.id]
        );
        await connection.query(
          `INSERT INTO quote_lifecycle_events
           (workspace_id,id,quote_case_id,quote_version_id,lifecycle_revision,
            from_status,to_status,event_type,actor_id,recorded_at,
            temporal_sequence) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [workspaceId,
            `quote-lifecycle-${workspaceId}-${lifecycleStamp.temporalSequence}`,
            quoteCase.id, commercial ? command.input.quoteVersionId : null,
            closedCase.revision, quoteCase.status, "closed", "case_closed",
            command.actorId, growthMysqlDate(lifecycleStamp.recordedAt),
            lifecycleStamp.temporalSequence]
        );
      }
      await connection.query(
        `INSERT INTO deal_authoritative_quotes
         (workspace_id,deal_id,open_quote_case_id,quote_version_id,
          commercial_amount_hash,authority_revision,updated_at)
         VALUES (?,?,NULL,NULL,NULL,?,?) AS next
         ON DUPLICATE KEY UPDATE open_quote_case_id = NULL,
          quote_version_id = NULL,commercial_amount_hash = NULL,
          authority_revision = next.authority_revision,
          updated_at = next.updated_at`,
        [workspaceId, command.dealId, authorityRevision,
          growthMysqlDate(authorityStamp.recordedAt)]
      );
      const deal: Deal = {
        id: command.dealId, customerId: String(dealRow.customer_id),
        title: String(dealRow.title ?? ""),
        stage: eventType === "won" ? "成交" : "丢单",
        product: String(dealRow.product ?? ""),
        quantity: Number(dealRow.quantity ?? 0),
        unitPrice: Number(dealRow.unit_price ?? 0),
        amount: commercial ? amountMinor! / 100 : Number(dealRow.amount ?? 0),
        currency: commercial ? currency! : String(dealRow.currency ?? "USD"),
        amountType: command.input.type === "won" ? "won"
          : commercial ? "quoted" : "estimate",
        ownerId: String(dealRow.owner_id), teamId: workspaceId,
        nextAction: String(dealRow.next_action ?? ""),
        nextActionAt: growthMysqlInstant(dealRow.next_action_at ??
          command.input.occurredAt),
        expectedCloseAt: growthMysqlInstant(dealRow.expected_close_at ??
          command.input.occurredAt),
        stageChangedAt: dealEventStamp.recordedAt,
        closedAt: command.input.occurredAt
      };
      const event: DealEvent = immutableQuoteValue({
        id: eventId, dealId: command.dealId, type: eventType,
        content: command.input.reasonText ?? command.input.reasonCode ?? "",
        operatorId: command.actorId, ownerIdSnapshot: deal.ownerId,
        teamIdSnapshot: workspaceId,
        customerIdSnapshot: commercial ? binding!.customerId : deal.customerId,
        leadIdSnapshot: commercial ? binding!.leadId : null,
        handoffIdSnapshot: commercial ? binding!.handoffId : null,
        candidateIdSnapshot: commercial ? binding!.candidateId : null,
        amountMinorSnapshot: commercial ? amountMinor : null,
        currencySnapshot: commercial ? currency : null,
        commercialAuthority: commercial ? "quote_projection"
          : "pre_quote_disqualified",
        quoteCaseIdSnapshot: quoteCase?.id ?? null,
        quoteVersionIdSnapshot: commercial ? command.input.quoteVersionId : null,
        commercialAmountHash: commercial
          ? command.input.commercialAmountHash : null,
        dealAuthorityRevisionSnapshot: authorityRevision,
        authorityRevision,
        commercialBindingEvidence: commercial ? evidence : null,
        commercialBindingSnapshot: commercial ? binding : null,
        reasonCode: command.input.reasonCode,
        reasonText: command.input.reasonText,
        occurredAt: command.input.occurredAt,
        recordedAt: dealEventStamp.recordedAt,
        temporalSequence: dealEventStamp.temporalSequence,
        createdAt: dealEventStamp.recordedAt
      });
      const result = immutableQuoteValue({ deal: {
        id: deal.id, customerId: deal.customerId, stage: deal.stage,
        amountType: deal.amountType, ownerId: deal.ownerId,
        teamId: deal.teamId
      }, event,
        quoteCase: closedCase, authorityRevision,
        cancelledPublicationOperationIds: Object.freeze(
          cancelledPublicationOperationIds) });
      await connection.query(
        `INSERT INTO deal_commercial_decision_results
         (workspace_id,stable_command_hash,request_hash,event_id,decision_json,
          completed_at) VALUES (?,?,?,?,?,?)`,
        [workspaceId, command.stableCommandHash, command.requestHash,
          event.id, JSON.stringify(result),
          growthMysqlDate(authorityStamp.recordedAt)]
      );
      return result;
    });
  }

  private async loadEvidence(
    connection: mysql.Pool | mysql.PoolConnection,
    workspaceId: string,
    column: "id" | "stable_command_hash",
    value: string,
    forUpdate = false
  ) {
    const [rows] = await connection.query(
      `SELECT evidence_json FROM quote_preview_evidence
       WHERE workspace_id = ? AND ${column} = ?${forUpdate ? " FOR UPDATE" : ""}`,
      [workspaceId, value]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parseEvidenceRow(row) : null;
  }

  findPreviewEvidence(workspaceId: string, id: string) {
    return this.loadEvidence(this.pool,
      assertConcreteGrowthWorkspaceId(workspaceId), "id", id);
  }

  findPreviewEvidenceByStableCommandHash(
    workspaceId: string,
    stableCommandHash: string
  ) {
    return this.loadEvidence(this.pool,
      assertConcreteGrowthWorkspaceId(workspaceId),
      "stable_command_hash", stableCommandHash);
  }

  async appendOrGetPreviewEvidence(command: AppendQuotePreviewEvidenceCommand) {
    const workspace = assertConcreteGrowthWorkspaceId(command.workspaceId);
    return this.transaction(async (connection, temporal) => {
      const stamp = await this.temporalBarrier.allocateAppend(temporal, workspace);
      const existing = await this.loadEvidence(connection, workspace,
        "stable_command_hash", command.stableCommandHash, true);
      if (existing) return existing;
      const quoteCase = await this.load(connection, workspace,
        command.quoteCaseId, true);
      if (!quoteCase) throw quoteError("quote_case_not_found");
      if (quoteCase.status !== "open") throw quoteError("quote_case_not_open");
      if (quoteCase.revision !== command.expectedQuoteCaseRevision) {
        throw quoteError("revision_conflict");
      }
      const subjectEvidence = quoteSubjectEvidence(quoteCase);
      const identity = {
        workspaceId: workspace, quoteCaseId: quoteCase.id,
        quoteCaseRevision: quoteCase.revision,
        salesOwnerActorId: quoteCase.assignedTo, subjectEvidence,
        createdBy: command.createdBy, requestHash: command.requestHash,
        stableCommandHash: command.stableCommandHash,
        previewIdentity: command.calculated.previewIdentity,
        inputSnapshotHash: command.calculated.inputSnapshotHash,
        calculationHash: command.calculated.calculationHash,
        effectiveAt: command.effectiveAt, ...stamp
      };
      const evidence: QuotePreviewEvidenceRecord = immutableQuoteValue({
        id: `quote-preview-${command.stableCommandHash.slice(7)}`,
        ...identity,
        frozenCalculationResult: snapshotQuoteCalculation(command.calculated),
        evidenceHash: hash({ schemaVersion: "quote-preview-evidence.v1", ...identity })
      });
      await connection.query(
        `INSERT INTO quote_preview_evidence
         (workspace_id,id,quote_case_id,quote_case_revision,created_by,
          request_hash,stable_command_hash,input_snapshot_hash,calculation_hash,
          evidence_hash,effective_at,recorded_at,temporal_sequence,evidence_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [workspace, evidence.id, evidence.quoteCaseId,
          evidence.quoteCaseRevision, evidence.createdBy, evidence.requestHash,
          evidence.stableCommandHash, evidence.inputSnapshotHash,
          evidence.calculationHash, evidence.evidenceHash,
          growthMysqlDate(evidence.effectiveAt), growthMysqlDate(evidence.recordedAt),
          evidence.temporalSequence, JSON.stringify(evidence)]
      );
      return evidence;
    });
  }

  async findDraftByStableCommandHash(workspaceId: string, stableCommandHash: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const [rows] = await this.pool.query(
      `SELECT frozen_version_json FROM quote_versions
       WHERE workspace_id = ? AND stable_command_hash = ? AND version_kind = 'draft'`,
      [workspace, stableCommandHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parseVersionRow(row) : null;
  }

  async getApproval(workspaceId: string, id: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const [rows] = await this.pool.query(
      `SELECT approval_json FROM quote_approvals
       WHERE workspace_id = ? AND id = ?`, [workspace, id]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parseApprovalRow(row) : null;
  }

  async findApprovalByQuoteVersion(workspaceId: string, quoteVersionId: string) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const [rows] = await this.pool.query(
      `SELECT approval_json FROM quote_approvals
       WHERE workspace_id = ? AND quote_version_id = ?
       ORDER BY recorded_at DESC LIMIT 1`, [workspace, quoteVersionId]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? parseApprovalRow(row) : null;
  }

  async appendVersionFromCalculation(
    command: AppendQuoteVersionCommand
  ): Promise<AppendQuoteVersionResult> {
    const workspace = assertConcreteGrowthWorkspaceId(command.workspaceId);
    try {
      return await this.transaction(async (connection, temporal) => {
        const versionStamp = await this.temporalBarrier.allocateAppend(
          temporal, workspace
        );
        const [stableRows] = await connection.query(
          `SELECT frozen_version_json FROM quote_versions
           WHERE workspace_id = ? AND stable_command_hash = ? FOR UPDATE`,
          [workspace, command.stableCommandHash]
        );
        const stable = (stableRows as MysqlRow[])[0];
        if (stable) {
          const version = parseVersionRow(stable);
          const [approvalRows] = await connection.query(
            `SELECT approval_json FROM quote_approvals
             WHERE workspace_id = ? AND quote_version_id = ? LIMIT 1`,
            [workspace, version.id]
          );
          const approvalRow = (approvalRows as MysqlRow[])[0];
          return { version,
            approval: approvalRow ? parseApprovalRow(approvalRow) : null };
        }
        const quoteCase = await this.load(connection, workspace,
          command.quoteCaseId, true);
        if (!quoteCase) throw quoteError("quote_case_not_found");
        if (quoteCase.status !== "open") throw quoteError("quote_case_not_open");
        let sourceDraft: QuoteVersion | null = null;
        if (command.versionKind === "draft") {
          if (quoteCase.revision !== command.expectedQuoteCaseRevision) {
            throw quoteError("revision_conflict");
          }
          if (command.sourceDraftVersionId !== null
            || command.probabilityAssessmentSnapshot !== null) {
            throw quoteError("invalid_quote_version_authority");
          }
        } else {
          if (!command.sourceDraftVersionId
            || !command.probabilityAssessmentSnapshot || !command.approval) {
            throw quoteError("invalid_quote_version_authority");
          }
          sourceDraft = await this.loadVersion(connection, workspace,
            command.sourceDraftVersionId, true);
          if (!sourceDraft || sourceDraft.quoteCaseId !== quoteCase.id
            || sourceDraft.versionKind !== "draft") {
            throw quoteError("quote_draft_not_found");
          }
          if (sourceDraft.lifecycleRevision !== command.expectedQuoteCaseRevision) {
            throw quoteError("revision_conflict");
          }
          const [formalRows] = await connection.query(
            `SELECT id FROM quote_versions WHERE workspace_id = ?
             AND source_draft_version_id = ? FOR UPDATE`,
            [workspace, sourceDraft.id]
          );
          if ((formalRows as MysqlRow[]).length) {
            throw quoteError("quote_draft_already_submitted");
          }
        }
        const [tailRows] = await connection.query(
          `SELECT COALESCE(MAX(version),0) AS version FROM quote_versions
           WHERE workspace_id = ? AND quote_case_id = ? FOR UPDATE`,
          [workspace, quoteCase.id]
        );
        const nextVersion = Number((tailRows as MysqlRow[])[0]!.version) + 1;
        const id = `${command.versionKind === "draft" ? "quote-draft" : "quote-formal"}-${command.stableCommandHash.slice(7)}`;
        const version = createQuoteVersionFromCalculation({
          id, quoteCase, version: nextVersion, versionKind: command.versionKind,
          sourceDraftVersionId: sourceDraft?.id ?? null,
          probabilityAssessmentSnapshot: command.probabilityAssessmentSnapshot,
          calculated: command.calculated, actorId: command.actorId,
          effectiveAt: command.effectiveAt,
          recordedAt: versionStamp.recordedAt,
          temporalSequence: versionStamp.temporalSequence,
          stableCommandHash: command.stableCommandHash,
          requestHash: command.requestHash
        });
        await connection.query(
          `INSERT INTO quote_versions
           (workspace_id,id,quote_case_id,version,version_kind,
            source_draft_version_id,probability_assessment_json,
            frozen_version_json,effective_at,created_by,created_at,recorded_at,
            temporal_sequence,stable_command_hash,request_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [workspace, version.id, quoteCase.id, version.version,
            version.versionKind, version.sourceDraftVersionId,
            version.probabilityAssessmentSnapshot
              ? JSON.stringify(version.probabilityAssessmentSnapshot) : null,
            JSON.stringify(version), growthMysqlDate(version.effectiveAt),
            version.createdBy, growthMysqlDate(version.createdAt),
            growthMysqlDate(version.recordedAt), version.temporalSequence,
            command.stableCommandHash, command.requestHash]
        );
        const lineItems = version.lineItems as readonly unknown[];
        for (const [index, line] of lineItems.entries()) {
          await connection.query(
            `INSERT INTO quote_version_line_snapshots
             (workspace_id,quote_version_id,line_number,snapshot_json)
             VALUES (?,?,?,?)`, [workspace, version.id, index + 1,
              JSON.stringify(line)]
          );
        }
        const giftItems = version.giftItems as readonly unknown[];
        for (const [index, gift] of giftItems.entries()) {
          await connection.query(
            `INSERT INTO quote_version_gift_snapshots
             (workspace_id,quote_version_id,gift_number,snapshot_json)
             VALUES (?,?,?,?)`, [workspace, version.id, index + 1,
              JSON.stringify(gift)]
          );
        }
        const packageSnapshot = version.packageSnapshot;
        if (packageSnapshot && typeof packageSnapshot === "object") {
          await connection.query(
            `INSERT INTO quote_version_package_snapshots
             (workspace_id,quote_version_id,package_version_id,snapshot_json)
             VALUES (?,?,?,?)`, [workspace, version.id,
              String(Reflect.get(packageSnapshot, "packageVersionId")),
              JSON.stringify(packageSnapshot)]
          );
        }
        let approval: QuoteApproval | null = null;
        if (command.versionKind === "formal") {
          const lifecycleStamp = await this.temporalBarrier.allocateAppend(
            temporal, workspace
          );
          await this.insertLifecycle(connection, {
            workspaceId: workspace, quoteCaseId: quoteCase.id,
            quoteVersionId: version.id, revision: 1, fromStatus: null,
            toStatus: "submitted", eventType: "version_transition",
            actorId: command.actorId
          }, lifecycleStamp);
          const approvalStamp = await this.temporalBarrier.allocateAppend(
            temporal, workspace
          );
          approval = immutableQuoteValue({
            id: `quote-approval-${workspace}-${approvalStamp.temporalSequence}`,
            workspaceId: workspace, quoteVersionId: version.id,
            status: "pending", approvalKind: command.approval!.approvalKind,
            requiredCapabilities: [...command.approval!.requiredCapabilities],
            triggeredRules: [...command.approval!.triggeredRules],
            pricingPolicyVersionId: command.approval!.pricingPolicyVersionId,
            policySnapshotHash: command.approval!.policySnapshotHash,
            capabilityRegistryVersion: command.approval!.capabilityRegistryVersion,
            submittedBy: command.actorId, submittedAt: approvalStamp.recordedAt,
            decidedBy: null, decidedAt: null, reason: null
          });
          await connection.query(
            `INSERT INTO quote_approvals
             (workspace_id,id,quote_version_id,status,approval_kind,
              approval_json,recorded_at,temporal_sequence)
             VALUES (?,?,?,'pending',?,?,?,?)`,
            [workspace, approval.id, version.id, approval.approvalKind,
              JSON.stringify(approval), growthMysqlDate(approvalStamp.recordedAt),
              approvalStamp.temporalSequence]
          );
        }
        const [updated] = await connection.query(
          `UPDATE quote_cases SET current_draft_version_id = ?,
           revision = revision + 1,updated_at = ?
           WHERE workspace_id = ? AND id = ? AND revision = ?`,
          [command.versionKind === "draft" ? version.id
            : quoteCase.currentDraftVersionId,
            growthMysqlDate(versionStamp.recordedAt), workspace, quoteCase.id,
            quoteCase.revision]
        );
        if (affectedRows(updated) !== 1) throw quoteError("revision_conflict");
        return { version, approval };
      });
    } catch (error) {
      if (duplicate(error)) {
        throw quoteError(command.versionKind === "formal"
          ? "quote_draft_already_submitted" : "revision_conflict");
      }
      throw error;
    }
  }

  async decideApproval(
    command: DecideQuoteApprovalCommand
  ): Promise<QuoteApprovalDecisionPersistenceResult> {
    const workspace = assertConcreteGrowthWorkspaceId(command.workspaceId);
    try {
      return await this.transaction(async (connection, temporal) => {
        const firstStamp = await this.temporalBarrier.allocateAppend(
          temporal, workspace
        );
        const [replayRows] = await connection.query(
          `SELECT request_hash,decision_json FROM quote_approval_command_results
           WHERE workspace_id = ? AND stable_command_hash = ? FOR UPDATE`,
          [workspace, command.stableCommandHash]
        );
        const replay = (replayRows as MysqlRow[])[0];
        if (replay) {
          if (String(replay.request_hash) !== command.requestHash) {
            throw quoteError("quote_command_identity_conflict");
          }
          return immutableQuoteValue(
            json<QuoteApprovalDecisionPersistenceResult>(replay.decision_json)
          );
        }
        const discoveredVersion = await this.loadVersion(connection, workspace,
          command.quoteVersionId);
        if (!discoveredVersion) throw quoteError("quote_version_not_found");
        const discoveredCase = await this.load(connection, workspace,
          discoveredVersion.quoteCaseId);
        if (!discoveredCase?.dealId) {
          throw quoteError("quote_deal_binding_required");
        }

        // Fixed domain order: Foundation temporal barrier, Deal guard, Case,
        // Approval/Version, lifecycle/authority/publication streams.
        await connection.query(
          `INSERT INTO deal_authoritative_quotes
           (workspace_id,deal_id,open_quote_case_id,quote_version_id,
            commercial_amount_hash,authority_revision,updated_at)
           VALUES (?,?,NULL,NULL,NULL,0,?)
           ON DUPLICATE KEY UPDATE deal_id = VALUES(deal_id)`,
          [workspace, discoveredCase.dealId,
            growthMysqlDate(firstStamp.recordedAt)]
        );
        const [guardRows] = await connection.query(
          `SELECT * FROM deal_authoritative_quotes
           WHERE workspace_id = ? AND deal_id = ? FOR UPDATE`,
          [workspace, discoveredCase.dealId]
        );
        const guardRow = (guardRows as MysqlRow[])[0]!;
        const quoteCase = await this.load(connection, workspace,
          discoveredVersion.quoteCaseId, true);
        if (!quoteCase || quoteCase.dealId !== discoveredCase.dealId) {
          throw quoteError("commercial_binding_authority_mismatch");
        }
        const [approvalRows] = await connection.query(
          `SELECT * FROM quote_approvals
           WHERE workspace_id = ? AND quote_version_id = ? FOR UPDATE`,
          [workspace, command.quoteVersionId]
        );
        const approvalRow = (approvalRows as MysqlRow[])[0];
        if (!approvalRow) throw quoteError("quote_approval_not_found");
        const approval = parseApprovalRow(approvalRow);
        const version = await this.loadVersion(connection, workspace,
          command.quoteVersionId, true);
        if (!version || version.versionKind !== "formal"
          || !version.sourceDraftVersionId
          || version.probabilityAssessmentSnapshot?.precision !== "bps") {
          throw quoteError("formal_quote_version_required");
        }
        const [lifecycleRows] = await connection.query(
          `SELECT * FROM quote_lifecycle_events
           WHERE workspace_id = ? AND quote_case_id = ?
             AND quote_version_id = ?
           ORDER BY lifecycle_revision DESC LIMIT 1 FOR UPDATE`,
          [workspace, quoteCase.id, version.id]
        );
        const currentLifecycleRow = (lifecycleRows as MysqlRow[])[0];
        const [lastAuthorityRows] = await connection.query(
          `SELECT event_type FROM deal_authoritative_quote_events
           WHERE workspace_id = ? AND deal_id = ?
           ORDER BY authority_revision DESC LIMIT 1 FOR UPDATE`,
          [workspace, quoteCase.dealId]
        );
        const lastAuthorityType = (lastAuthorityRows as MysqlRow[])[0]
          ?.event_type;
        if (lastAuthorityType === "won" || lastAuthorityType === "lost") {
          throw quoteError("deal_already_decided");
        }
        const currentRevision = currentLifecycleRow
          ? Number(currentLifecycleRow.lifecycle_revision)
          : version.lifecycleRevision;
        if (currentRevision !== command.expectedRevision) {
          throw quoteError("revision_conflict");
        }
        if (approval.status !== "pending") {
          throw quoteError("quote_approval_already_decided");
        }
        const gate = version.gate as { status?: string } | undefined;
        if (gate?.status === "hard_blocked") {
          throw quoteError("quote_hard_blocked");
        }
        const binding = version.commercialBindingSnapshot as
          CommercialBindingSnapshot | null;
        if (!binding || binding.dealId !== quoteCase.dealId
          || binding.customerId !== quoteCase.customerId
          || binding.candidateId !== quoteCase.candidateId
          || command.verifiedBindingSnapshot.bindingHash !== binding.bindingHash
          || command.verifiedBindingSnapshot.dealContentHash
            !== binding.dealContentHash
          || command.verifiedBindingSnapshot.handoffContentHash
            !== binding.handoffContentHash) {
          throw quoteError("commercial_binding_authority_mismatch");
        }

        const lifecycleEvents: QuoteLifecycleEvent[] = [];
        const previousQuoteVersionId = guardRow.quote_version_id === null
          ? null : String(guardRow.quote_version_id);
        if (command.decision === "approve" && previousQuoteVersionId
          && previousQuoteVersionId !== version.id) {
          const [previousRows] = await connection.query(
            `SELECT qv.frozen_version_json,
              COALESCE(MAX(qle.lifecycle_revision),1) AS lifecycle_revision
             FROM quote_versions qv LEFT JOIN quote_lifecycle_events qle
               ON qle.workspace_id = qv.workspace_id
              AND qle.quote_version_id = qv.id
             WHERE qv.workspace_id = ? AND qv.id = ?
             GROUP BY qv.frozen_version_json FOR UPDATE`,
            [workspace, previousQuoteVersionId]
          );
          const previousRow = (previousRows as MysqlRow[])[0];
          if (previousRow) {
            const previous = parseVersionRow(previousRow);
            const previousRevision = Number(previousRow.lifecycle_revision) + 1;
            const event = immutableQuoteValue({
              id: `quote-lifecycle-${workspace}-${firstStamp.temporalSequence}`,
              workspaceId: workspace, quoteCaseId: previous.quoteCaseId,
              quoteVersionId: previous.id, revision: previousRevision,
              fromStatus: "approved" as const, toStatus: "superseded" as const,
              eventType: "version_transition" as const,
              actorId: command.actorId, ...firstStamp
            });
            await this.insertLifecycle(connection, event, firstStamp);
            lifecycleEvents.push(event);
          }
          const [oldOperationRows] = await connection.query(
            `SELECT operation_json FROM quote_publication_operations
             WHERE workspace_id = ? AND deal_id = ? AND quote_version_id = ?
             ORDER BY recorded_at DESC LIMIT 1 FOR UPDATE`,
            [workspace, quoteCase.dealId, previousQuoteVersionId]
          );
          const oldOperationRow = (oldOperationRows as MysqlRow[])[0];
          if (oldOperationRow) {
            const old = json<QuotePublicationOperation>(
              oldOperationRow.operation_json
            );
            if (old.status !== "succeeded" && old.status !== "cancelled") {
              await connection.query(
                `UPDATE quote_publication_operations SET operation_json = ?
                 WHERE workspace_id = ? AND id = ?`,
                [JSON.stringify({ ...old, status: "superseded",
                  updatedAt: firstStamp.recordedAt }), workspace, old.id]
              );
            }
          }
        }
        const decisionStamp = lifecycleEvents.length
          ? await this.temporalBarrier.allocateAppend(temporal, workspace)
          : firstStamp;
        const nextStatus = command.decision === "approve" ? "approved" as const
          : command.decision === "reject" ? "rejected" as const
            : "expired" as const;
        const lifecycle = immutableQuoteValue({
          id: `quote-lifecycle-${workspace}-${decisionStamp.temporalSequence}`,
          workspaceId: workspace, quoteCaseId: quoteCase.id,
          quoteVersionId: version.id, revision: currentRevision + 1,
          fromStatus: "submitted" as const, toStatus: nextStatus,
          eventType: "version_transition" as const, actorId: command.actorId,
          ...decisionStamp
        });
        await this.insertLifecycle(connection, lifecycle, decisionStamp);
        lifecycleEvents.push(lifecycle);

        const approvalStamp = await this.temporalBarrier.allocateAppend(
          temporal, workspace
        );
        const approvalStatus = command.decision === "approve"
          ? "approved" as const : command.decision === "reject"
            ? "rejected" as const : "cancelled" as const;
        const decidedApproval = immutableQuoteValue({ ...approval,
          status: approvalStatus, decidedBy: command.actorId,
          decidedAt: approvalStamp.recordedAt, reason: command.reason });
        await connection.query(
          `UPDATE quote_approvals SET status = ?,approval_json = ?
           WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
          [approvalStatus, JSON.stringify(decidedApproval), workspace,
            approval.id]
        );
        const approvalEvent = immutableQuoteValue({
          id: `quote-approval-event-${workspace}-${approvalStamp.temporalSequence}`,
          workspaceId: workspace, quoteVersionId: version.id,
          approvalId: approval.id, revision: 2, status: approvalStatus,
          actorId: command.actorId, reason: command.reason, ...approvalStamp
        });
        await connection.query(
          `INSERT INTO quote_approval_events
           (workspace_id,id,quote_version_id,approval_id,approval_revision,
            status,event_json,recorded_at,temporal_sequence)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [workspace, approvalEvent.id, version.id, approval.id, 2,
            approvalStatus, JSON.stringify(approvalEvent),
            growthMysqlDate(approvalStamp.recordedAt),
            approvalStamp.temporalSequence]
        );

        const authorityStamp = await this.temporalBarrier.allocateAppend(
          temporal, workspace
        );
        const authorityRevision = Number(guardRow.authority_revision) + 1;
        const commercialAmountHash = String(version.commercialAmountHash) as
          `sha256:${string}`;
        const evidence = immutableQuoteValue({
          candidateId: binding.candidateId, customerId: binding.customerId,
          dealId: binding.dealId,
          handoffContentHash: binding.handoffContentHash,
          dealContentHash: binding.dealContentHash,
          bindingHashSchemaVersion: binding.bindingHashSchemaVersion,
          bindingHash: binding.bindingHash
        });
        const authorityEvent = immutableQuoteValue({
          id: `deal-authority-${workspace}-${authorityStamp.temporalSequence}`,
          workspaceId: workspace, dealId: quoteCase.dealId, authorityRevision,
          quoteCaseId: quoteCase.id, quoteVersionId: version.id,
          previousQuoteVersionId,
          eventType: command.decision === "approve" ? "approved" as const
            : command.decision === "reject" ? "rejected" as const
              : "expired" as const,
          currency: String(version.currency),
          quotedAmountMinor: Number(version.quotedAmountMinor),
          commercialAmountHash, commercialBindingEvidence: evidence,
          commercialBindingSnapshot: immutableQuoteValue(
            structuredClone(binding)
          ),
          decidedAt: authorityStamp.recordedAt, ...authorityStamp
        });
        await connection.query(
          `INSERT INTO deal_authoritative_quote_events
           (workspace_id,id,deal_id,authority_revision,quote_case_id,
            quote_version_id,event_type,recorded_at,temporal_sequence)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [workspace, authorityEvent.id, quoteCase.dealId, authorityRevision,
            quoteCase.id, version.id, authorityEvent.eventType,
            growthMysqlDate(authorityStamp.recordedAt),
            authorityStamp.temporalSequence]
        );
        await connection.query(
          `INSERT INTO deal_authoritative_quote_event_payloads
           (workspace_id,event_id,event_json) VALUES (?,?,?)`,
          [workspace, authorityEvent.id, JSON.stringify(authorityEvent)]
        );
        await connection.query(
          `UPDATE deal_authoritative_quotes SET open_quote_case_id = ?,
           quote_version_id = ?,commercial_amount_hash = ?,
           authority_revision = ?,updated_at = ?
           WHERE workspace_id = ? AND deal_id = ?`,
          [quoteCase.id, command.decision === "approve" ? version.id : null,
            command.decision === "approve" ? commercialAmountHash : null,
            authorityRevision, growthMysqlDate(authorityStamp.recordedAt),
            workspace, quoteCase.dealId]
        );
        const authority: DealAuthoritativeQuote = immutableQuoteValue({
          workspaceId: workspace, dealId: quoteCase.dealId,
          openQuoteCaseId: quoteCase.id,
          quoteVersionId: command.decision === "approve" ? version.id : null,
          commercialAmountHash: command.decision === "approve"
            ? commercialAmountHash : null,
          authorityRevision, updatedAt: authorityStamp.recordedAt
        });

        const publicationStamp = await this.temporalBarrier.allocateAppend(
          temporal, workspace
        );
        const stableKey = `quote-publication:${quoteCase.dealId}:${version.id}:${authorityRevision}`;
        const publicationOperation: QuotePublicationOperation =
          immutableQuoteValue({
            id: `quote-publication-${workspace}-${publicationStamp.temporalSequence}`,
            workspaceId: workspace, quoteCaseId: quoteCase.id,
            quoteVersionId: version.id, dealId: quoteCase.dealId,
            dealAuthorityRevision: authorityRevision, commercialAmountHash,
            status: command.decision === "approve" ? "queued" as const
              : "cancelled" as const,
            piDocumentId: null, dealEventId: null, attempts: 0,
            lastErrorCode: null, idempotencyKey: stableKey,
            leaseOwner: null, fencingToken: 0, leaseExpiresAt: null,
            createdAt: publicationStamp.recordedAt,
            updatedAt: publicationStamp.recordedAt
          });
        await connection.query(
          `INSERT INTO quote_publication_operations
           (workspace_id,id,quote_case_id,quote_version_id,deal_id,
            stable_key_hash,status,authority_revision,lease_owner,fencing_token,
            lease_expires_at,pi_document_id,deal_event_id,operation_json,
            recorded_at,temporal_sequence)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [workspace, publicationOperation.id, quoteCase.id, version.id,
            quoteCase.dealId, hash(stableKey), publicationOperation.status,
            authorityRevision, null, 0, null, null, null,
            JSON.stringify(publicationOperation),
            growthMysqlDate(publicationStamp.recordedAt),
            publicationStamp.temporalSequence]
        );
        const projectedVersion = immutableQuoteValue({ ...version,
          status: nextStatus, lifecycleRevision: currentRevision + 1 });
        const result: QuoteApprovalDecisionPersistenceResult =
          immutableQuoteValue({ quoteVersion: projectedVersion,
            approval: decidedApproval, authority, authorityEvent,
            lifecycleEvents: Object.freeze(lifecycleEvents),
            publicationOperation });
        await connection.query(
          `INSERT INTO quote_approval_command_results
           (workspace_id,stable_command_hash,request_hash,decision_json,completed_at)
           VALUES (?,?,?,?,?)`,
          [workspace, command.stableCommandHash, command.requestHash,
            JSON.stringify(result), growthMysqlDate(publicationStamp.recordedAt)]
        );
        return result;
      });
    } catch (error) {
      if (duplicate(error)) {
        const replay = await this.findApprovalDecisionByStableCommandHash(
          workspace, command.stableCommandHash
        );
        if (replay) return replay;
      }
      throw error;
    }
  }

  async createCase(command: CreateQuoteCaseCommand) {
    const workspace = assertConcreteGrowthWorkspaceId(command.workspaceId);
    try {
      return await this.transaction(async (connection, temporal) => {
        const stamp = await this.temporalBarrier.allocateAppend(temporal, workspace);
        const replayId = await this.receipt(connection, workspace,
          command.commandKey, command.requestHash);
        if (replayId) return {
          quoteCase: (await this.load(connection, workspace, replayId))!,
          replayed: true
        };
        const value = command.quoteCase;
        if (value.workspaceId !== workspace || value.status !== "open"
          || value.revision !== 1
          || (!value.candidateId && !value.customerId && !value.dealId)) {
          throw quoteError("invalid_quote_case_create");
        }
        let bindingId: string | null = null;
        if (value.dealId) {
          if (!command.bindingSnapshot || !command.probabilityAssessment) {
            throw quoteError("commercial_binding_required");
          }
          await connection.query(
            `INSERT INTO deal_authoritative_quotes
             (workspace_id,deal_id,open_quote_case_id,quote_version_id,
              commercial_amount_hash,authority_revision,updated_at)
             VALUES (?,?,NULL,NULL,NULL,0,?)
             ON DUPLICATE KEY UPDATE deal_id = VALUES(deal_id)`,
            [workspace, value.dealId, growthMysqlDate(stamp.recordedAt)]
          );
          const [guardRows] = await connection.query(
            `SELECT open_quote_case_id FROM deal_authoritative_quotes
             WHERE workspace_id = ? AND deal_id = ? FOR UPDATE`,
            [workspace, value.dealId]
          );
          if ((guardRows as MysqlRow[])[0]?.open_quote_case_id) {
            throw quoteError("deal_open_quote_case_conflict");
          }
          bindingId = `binding-${value.id}`;
          const bindingStamp = await this.temporalBarrier.allocateAppend(
            temporal,
            workspace
          );
          await this.insertBinding(connection, workspace, value.id, bindingId,
            command.bindingSnapshot, bindingStamp);
          await connection.query(
            `UPDATE deal_authoritative_quotes SET open_quote_case_id = ?,
             authority_revision = authority_revision + 1,updated_at = ?
             WHERE workspace_id = ? AND deal_id = ?`,
            [value.id, growthMysqlDate(stamp.recordedAt), workspace, value.dealId]
          );
        }
        await connection.query(
          `INSERT INTO quote_cases
           (workspace_id,id,candidate_id,customer_id,deal_id,assigned_to,status,
            current_draft_version_id,revision,binding_snapshot_id,created_at,updated_at)
           VALUES (?,?,?,?,?,?, 'open',NULL,1,?,?,?)`,
          [workspace, value.id, value.candidateId, value.customerId,
            value.dealId, value.assignedTo, bindingId,
            growthMysqlDate(stamp.recordedAt), growthMysqlDate(stamp.recordedAt)]
        );
        const lifecycleStamp = await this.temporalBarrier.allocateAppend(
          temporal,
          workspace
        );
        await this.insertLifecycle(connection, {
          workspaceId: workspace, quoteCaseId: value.id, quoteVersionId: null,
          revision: 1, fromStatus: null, toStatus: "open",
          eventType: "case_created", actorId: command.actorId
        }, lifecycleStamp);
        if (value.dealId) {
          const authorityStamp = await this.temporalBarrier.allocateAppend(
            temporal,
            workspace
          );
          await connection.query(
            `INSERT INTO deal_authoritative_quote_events
             (workspace_id,id,deal_id,authority_revision,quote_case_id,
              quote_version_id,event_type,recorded_at,temporal_sequence)
             VALUES (?,?,?,?,?,NULL,'case_bound',?,?)`,
            [workspace,
              `deal-authority-${workspace}-${authorityStamp.temporalSequence}`,
              value.dealId, 1, value.id, growthMysqlDate(authorityStamp.recordedAt),
              authorityStamp.temporalSequence]
          );
        }
        await this.complete(connection, command, value.id, stamp.recordedAt);
        return { quoteCase: (await this.load(connection, workspace, value.id))!,
          replayed: false };
      });
    } catch (error) {
      if (duplicate(error)) throw quoteError(valueConflictCode(command.quoteCase.dealId));
      throw error;
    }
  }

  private async insertBinding(
    connection: mysql.PoolConnection,
    workspaceId: string,
    quoteCaseId: string,
    id: string,
    snapshot: CommercialBindingSnapshot,
    stamp: { recordedAt: string; temporalSequence: number }
  ) {
    await connection.query(
      `INSERT INTO commercial_binding_snapshots
       (workspace_id,id,quote_case_id,candidate_id,handoff_id,lead_id,customer_id,
        deal_id,candidate_version,handoff_content_hash,deal_content_hash,
        binding_hash_schema_version,attribution_snapshot_json,binding_hash,
        verified_at,recorded_at,temporal_sequence)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [workspaceId, id, quoteCaseId, snapshot.candidateId, snapshot.handoffId,
        snapshot.leadId, snapshot.customerId, snapshot.dealId,
        snapshot.candidateVersion, snapshot.handoffContentHash,
        snapshot.dealContentHash, snapshot.bindingHashSchemaVersion,
        JSON.stringify(snapshot.attributionSnapshot), snapshot.bindingHash,
        growthMysqlDate(snapshot.verifiedAt), growthMysqlDate(stamp.recordedAt),
        stamp.temporalSequence]
    );
  }

  private async insertLifecycle(
    connection: mysql.PoolConnection,
    event: { workspaceId: string; quoteCaseId: string; quoteVersionId: string | null;
      revision: number; fromStatus: string | null; toStatus: string;
      eventType: string; actorId: string },
    stamp: { recordedAt: string; temporalSequence: number }
  ) {
    await connection.query(
      `INSERT INTO quote_lifecycle_events
       (workspace_id,id,quote_case_id,quote_version_id,lifecycle_revision,
        from_status,to_status,event_type,actor_id,recorded_at,temporal_sequence)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [event.workspaceId,
        `quote-lifecycle-${event.workspaceId}-${stamp.temporalSequence}`,
        event.quoteCaseId, event.quoteVersionId, event.revision,
        event.fromStatus, event.toStatus, event.eventType, event.actorId,
        growthMysqlDate(stamp.recordedAt), stamp.temporalSequence]
    );
  }

  async bindCaseDeal(command: BindQuoteCaseDealCommand) {
    const workspace = assertConcreteGrowthWorkspaceId(command.workspaceId);
    try {
      return await this.transaction(async (connection, temporal) => {
        const caseStamp = await this.temporalBarrier.allocateAppend(temporal, workspace);
        const replayId = await this.receipt(connection, workspace,
          command.commandKey, command.requestHash);
        if (replayId) return { quoteCase: (await this.load(connection, workspace, replayId))!, replayed: true };
        await connection.query(
          `INSERT INTO deal_authoritative_quotes
           (workspace_id,deal_id,open_quote_case_id,quote_version_id,
            commercial_amount_hash,authority_revision,updated_at)
           VALUES (?,?,NULL,NULL,NULL,0,?)
           ON DUPLICATE KEY UPDATE deal_id = VALUES(deal_id)`,
          [workspace, command.dealId, growthMysqlDate(caseStamp.recordedAt)]
        );
        const [guardRows] = await connection.query(
          `SELECT * FROM deal_authoritative_quotes
           WHERE workspace_id = ? AND deal_id = ? FOR UPDATE`,
          [workspace, command.dealId]
        );
        const guard = (guardRows as MysqlRow[])[0]!;
        if (guard.open_quote_case_id
          && String(guard.open_quote_case_id) !== command.quoteCaseId) {
          throw quoteError("deal_open_quote_case_conflict");
        }
        const current = await this.load(connection, workspace,
          command.quoteCaseId, true);
        if (!current) throw quoteError("quote_case_not_found");
        if (current.revision !== command.expectedRevision) {
          throw quoteError(command.expectedRevision === null
            ? "revision_required" : "quote_case_revision_conflict");
        }
        if (current.status !== "open") throw quoteError("quote_case_not_open");
        if (current.dealId) {
          if (current.dealId !== command.dealId) {
            throw quoteError("quote_case_rebind_forbidden");
          }
          await this.complete(connection, command, current.id, caseStamp.recordedAt);
          return { quoteCase: current, replayed: true };
        }
        if (command.bindingSnapshot.candidateId !== current.candidateId
          || command.probabilityAssessment.candidateId !== current.candidateId
          || command.probabilityAssessment.dealId !== command.dealId) {
          throw quoteError("commercial_binding_authority_mismatch");
        }
        const bindingId = `binding-${current.id}`;
        const bindingStamp = await this.temporalBarrier.allocateAppend(
          temporal,
          workspace
        );
        await this.insertBinding(connection, workspace, current.id, bindingId,
          command.bindingSnapshot, bindingStamp);
        const [result] = await connection.query(
          `UPDATE quote_cases SET customer_id = ?,deal_id = ?,binding_snapshot_id = ?,
           revision = revision + 1,updated_at = ?
           WHERE workspace_id = ? AND id = ? AND revision = ? AND deal_id IS NULL`,
          [command.bindingSnapshot.customerId, command.dealId, bindingId,
            growthMysqlDate(caseStamp.recordedAt), workspace, current.id,
            command.expectedRevision]
        );
        if (affectedRows(result) !== 1) throw quoteError("quote_case_revision_conflict");
        const nextAuthorityRevision = Number(guard.authority_revision) + 1;
        await connection.query(
          `UPDATE deal_authoritative_quotes SET open_quote_case_id = ?,
           authority_revision = ?,updated_at = ?
           WHERE workspace_id = ? AND deal_id = ?`,
          [current.id, nextAuthorityRevision, growthMysqlDate(caseStamp.recordedAt),
            workspace, command.dealId]
        );
        const lifecycleStamp = await this.temporalBarrier.allocateAppend(
          temporal,
          workspace
        );
        await this.insertLifecycle(connection, {
          workspaceId: workspace, quoteCaseId: current.id, quoteVersionId: null,
          revision: current.revision + 1, fromStatus: "open", toStatus: "open",
          eventType: "deal_bound", actorId: command.actorId
        }, lifecycleStamp);
        const authorityStamp = await this.temporalBarrier.allocateAppend(temporal, workspace);
        await connection.query(
          `INSERT INTO deal_authoritative_quote_events
           (workspace_id,id,deal_id,authority_revision,quote_case_id,
            quote_version_id,event_type,recorded_at,temporal_sequence)
           VALUES (?,?,?,?,?,NULL,'case_bound',?,?)`,
          [workspace, `deal-authority-${workspace}-${authorityStamp.temporalSequence}`,
            command.dealId, nextAuthorityRevision, current.id,
            growthMysqlDate(authorityStamp.recordedAt), authorityStamp.temporalSequence]
        );
        await this.complete(connection, command, current.id, authorityStamp.recordedAt);
        return { quoteCase: (await this.load(connection, workspace, current.id))!, replayed: false };
      });
    } catch (error) {
      if (duplicate(error)) throw quoteError("deal_open_quote_case_conflict");
      throw error;
    }
  }

  private async terminal(
    command: CloseQuoteCaseCommand | CancelQuoteCaseCommand,
    status: "closed" | "cancelled"
  ): Promise<QuoteCaseCommandResult> {
    const workspace = assertConcreteGrowthWorkspaceId(command.workspaceId);
    return this.transaction(async (connection, temporal) => {
      const stamp = await this.temporalBarrier.allocateAppend(temporal, workspace);
      const replayId = await this.receipt(connection, workspace,
        command.commandKey, command.requestHash);
      if (replayId) return { quoteCase: (await this.load(connection, workspace, replayId))!, replayed: true };
      const [identityRows] = await connection.query(
        `SELECT deal_id FROM quote_cases WHERE workspace_id = ? AND id = ?`,
        [workspace, command.quoteCaseId]
      );
      const dealId = (identityRows as MysqlRow[])[0]?.deal_id;
      if (dealId) {
        await connection.query(
          `SELECT deal_id FROM deal_authoritative_quotes
           WHERE workspace_id = ? AND deal_id = ? FOR UPDATE`,
          [workspace, dealId]
        );
      }
      const current = await this.load(connection, workspace, command.quoteCaseId, true);
      if (!current) throw quoteError("quote_case_not_found");
      if (current.revision !== command.expectedRevision) {
        throw quoteError(command.expectedRevision === null
          ? "revision_required" : "quote_case_revision_conflict");
      }
      if (current.status !== "open") throw quoteError("quote_case_not_open");
      const [activeRows] = await connection.query(
        `SELECT qv.id FROM quote_versions qv
         JOIN quote_lifecycle_events qle ON qle.workspace_id = qv.workspace_id
          AND qle.quote_version_id = qv.id
         WHERE qv.workspace_id = ? AND qv.quote_case_id = ?
          AND qv.version_kind = 'formal'
          AND qle.to_status IN ('submitted','approved')
         ORDER BY qle.lifecycle_revision DESC LIMIT 1 FOR UPDATE`,
        [workspace, current.id]
      );
      if ((activeRows as MysqlRow[]).length) {
        throw quoteError("quote_case_has_active_formal_version");
      }
      if (status === "cancelled") {
        const [draftRows] = await connection.query(
          `SELECT qv.id,COALESCE(MAX(qle.lifecycle_revision),0) AS revision
           FROM quote_versions qv LEFT JOIN quote_lifecycle_events qle
            ON qle.workspace_id = qv.workspace_id AND qle.quote_version_id = qv.id
           WHERE qv.workspace_id = ? AND qv.quote_case_id = ?
            AND qv.version_kind = 'draft'
           GROUP BY qv.id FOR UPDATE`,
          [workspace, current.id]
        );
        for (const row of draftRows as MysqlRow[]) {
          const versionStamp = await this.temporalBarrier.allocateAppend(temporal, workspace);
          await this.insertLifecycle(connection, {
            workspaceId: workspace, quoteCaseId: current.id,
            quoteVersionId: String(row.id), revision: Number(row.revision) + 1,
            fromStatus: "draft", toStatus: "expired",
            eventType: "version_expired", actorId: command.actorId
          }, versionStamp);
        }
      }
      const [result] = await connection.query(
        `UPDATE quote_cases SET status = ?,revision = revision + 1,updated_at = ?
         WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'open'`,
        [status, growthMysqlDate(stamp.recordedAt), workspace, current.id,
          command.expectedRevision]
      );
      if (affectedRows(result) !== 1) throw quoteError("quote_case_revision_conflict");
      const lifecycleStamp = await this.temporalBarrier.allocateAppend(
        temporal,
        workspace
      );
      await this.insertLifecycle(connection, {
        workspaceId: workspace, quoteCaseId: current.id, quoteVersionId: null,
        revision: current.revision + 1, fromStatus: "open", toStatus: status,
        eventType: status === "closed" ? "case_closed" : "case_cancelled",
        actorId: command.actorId
      }, lifecycleStamp);
      if (current.dealId) {
        await connection.query(
          `UPDATE deal_authoritative_quotes SET open_quote_case_id = NULL,
           authority_revision = authority_revision + 1,updated_at = ?
           WHERE workspace_id = ? AND deal_id = ? AND open_quote_case_id = ?`,
          [growthMysqlDate(stamp.recordedAt), workspace, current.dealId, current.id]
        );
      }
      await this.complete(connection, command, current.id, stamp.recordedAt);
      return { quoteCase: (await this.load(connection, workspace, current.id))!, replayed: false };
    });
  }

  closeCase(command: CloseQuoteCaseCommand) { return this.terminal(command, "closed"); }
  cancelCase(command: CancelQuoteCaseCommand) { return this.terminal(command, "cancelled"); }

  async getPublication(operationId: string) {
    const [rows] = await this.pool.query(
      `SELECT * FROM quote_publication_operations WHERE id = ?`, [operationId]
    );
    const matches = rows as MysqlRow[];
    if (matches.length > 1) throw quoteError("publication_identity_ambiguous");
    return matches[0] ? parsePublicationRow(matches[0]) : null;
  }

  async claimPublication(operationId: string, workerId: string, _now: string,
    nextExpiry: string): Promise<QuotePublicationClaim | null> {
    const workspace = await this.publicationWorkspace(operationId);
    if (!workspace) return null;
    return this.transaction(async (connection, temporal) => {
      await temporal.lockWorkspaceTemporalBarrierForUpdate(workspace);
      const databaseNow = await temporal.currentTimestamp3();
      const current = await this.lockedPublication(connection, workspace,
        operationId);
      if (!current) return null;
      const recoverable = current.status === "queued" || current.status === "failed"
        || current.status === "partial_failure" || current.status === "running"
          && current.leaseExpiresAt !== null
          && Date.parse(current.leaseExpiresAt) <= Date.parse(databaseNow);
      if (!recoverable || Date.parse(nextExpiry) <= Date.parse(databaseNow)) {
        return null;
      }
      const running: QuotePublicationOperation = immutableQuoteValue({ ...current,
        status: "running", leaseOwner: workerId,
        fencingToken: current.fencingToken + 1, leaseExpiresAt: nextExpiry,
        attempts: current.attempts + 1, lastErrorCode: null,
        updatedAt: databaseNow
      });
      const stamp = await this.appendPublicationHistory(connection, temporal,
        running, null, null);
      const [updated] = await connection.query(
        `UPDATE quote_publication_operations SET status = 'running',
         lease_owner = ?,fencing_token = ?,lease_expires_at = ?,
         pi_document_id = ?,deal_event_id = ?,operation_json = ?,recorded_at = ?,
         temporal_sequence = ? WHERE workspace_id = ? AND id = ?`,
        [workerId, running.fencingToken, growthMysqlDate(nextExpiry),
          running.piDocumentId, running.dealEventId, JSON.stringify(running),
          growthMysqlDate(stamp.recordedAt), stamp.temporalSequence, workspace,
          operationId]
      );
      if (affectedRows(updated) !== 1) throw quoteError("publication_claim_lost");
      const reread = await this.lockedPublication(connection, workspace,
        operationId);
      if (!reread || reread.status !== "running"
        || reread.leaseOwner !== workerId
        || reread.fencingToken !== running.fencingToken
        || reread.dealAuthorityRevision !== current.dealAuthorityRevision
        || !reread.leaseExpiresAt
        || Date.parse(reread.leaseExpiresAt) <= Date.parse(databaseNow)) {
        throw quoteError("publication_claim_readback_failed");
      }
      return Object.freeze({ operationId, leaseOwner: workerId,
        fencingToken: reread.fencingToken,
        leaseExpiresAt: reread.leaseExpiresAt,
        authorityRevision: reread.dealAuthorityRevision });
    });
  }

  private async transitionPublication(
    claim: QuotePublicationClaim,
    change: (operation: QuotePublicationOperation, databaseNow: string) =>
      QuotePublicationOperation,
    errorCode: string | null = null
  ) {
    const workspace = await this.publicationWorkspace(claim.operationId);
    if (!workspace) return false;
    return this.transaction(async (connection, temporal) => {
      await temporal.lockWorkspaceTemporalBarrierForUpdate(workspace);
      const databaseNow = await temporal.currentTimestamp3();
      const current = await this.lockedPublication(connection, workspace,
        claim.operationId);
      if (!current || current.status !== "running"
        || current.leaseOwner !== claim.leaseOwner
        || current.fencingToken !== claim.fencingToken
        || current.dealAuthorityRevision !== claim.authorityRevision
        || !current.leaseExpiresAt
        || Date.parse(current.leaseExpiresAt) <= Date.parse(databaseNow)) {
        return false;
      }
      const next = immutableQuoteValue(change(current, databaseNow));
      const stamp = await this.appendPublicationHistory(connection, temporal,
        next, errorCode, null);
      const [updated] = await connection.query(
        `UPDATE quote_publication_operations SET status = ?,lease_owner = ?,
         fencing_token = ?,lease_expires_at = ?,pi_document_id = ?,
         deal_event_id = ?,operation_json = ?,recorded_at = ?,temporal_sequence = ?
         WHERE workspace_id = ? AND id = ? AND status = 'running'
           AND lease_owner = ? AND fencing_token = ? AND authority_revision = ?
           AND lease_expires_at > ?`,
        [next.status, next.leaseOwner, next.fencingToken,
          next.leaseExpiresAt ? growthMysqlDate(next.leaseExpiresAt) : null,
          next.piDocumentId, next.dealEventId, JSON.stringify(next),
          growthMysqlDate(stamp.recordedAt), stamp.temporalSequence, workspace,
          claim.operationId, claim.leaseOwner, claim.fencingToken,
          claim.authorityRevision, growthMysqlDate(databaseNow)]
      );
      if (affectedRows(updated) !== 1) {
        throw quoteError("publication_fence_lost_after_lock");
      }
      return true;
    });
  }

  renewPublicationLease(claim: QuotePublicationClaim, _now: string,
    nextExpiry: string) {
    return this.transitionPublication(claim, (operation, databaseNow) => {
      if (Date.parse(nextExpiry) <= Date.parse(databaseNow)) {
        throw quoteError("invalid_publication_lease_expiry");
      }
      return { ...operation, leaseExpiresAt: nextExpiry,
        updatedAt: databaseNow };
    });
  }

  recordPiPublished(claim: QuotePublicationClaim, piDocumentId: string,
    _now: string) {
    return this.transitionPublication(claim, (operation, databaseNow) => ({
      ...operation, piDocumentId: operation.piDocumentId || piDocumentId,
      updatedAt: databaseNow
    }));
  }

  recordCrmPublished(claim: QuotePublicationClaim, dealEventId: string,
    _now: string) {
    return this.transitionPublication(claim, (operation, databaseNow) => ({
      ...operation, dealEventId: operation.dealEventId || dealEventId,
      updatedAt: databaseNow
    }));
  }

  finishPublication(claim: QuotePublicationClaim, _now: string) {
    return this.transitionPublication(claim, (operation, databaseNow) => {
      if (!operation.piDocumentId || !operation.dealEventId) {
        throw quoteError("publication_receipts_incomplete");
      }
      return { ...operation, status: "succeeded", leaseOwner: null,
        leaseExpiresAt: null, updatedAt: databaseNow };
    });
  }

  failPublication(claim: QuotePublicationClaim, errorCode: string, _now: string) {
    return this.transitionPublication(claim, (operation, databaseNow) => ({
      ...operation, status: operation.piDocumentId || operation.dealEventId
        ? "partial_failure" : "failed", leaseOwner: null,
      leaseExpiresAt: null, lastErrorCode: errorCode, updatedAt: databaseNow
    }), errorCode);
  }

  cancelPublication(claim: QuotePublicationClaim, errorCode: string,
    _now: string) {
    return this.transitionPublication(claim, (operation, databaseNow) => ({
      ...operation, status: errorCode === "publication_superseded"
        ? "superseded" : "cancelled", leaseOwner: null, leaseExpiresAt: null,
      lastErrorCode: errorCode, updatedAt: databaseNow
    }), errorCode);
  }

  async isPublicationAuthorityCurrent(claim: QuotePublicationClaim) {
    const operation = await this.getPublication(claim.operationId);
    if (!operation) return false;
    const authority = await this.findCurrentDealAuthority(
      operation.workspaceId,
      operation.dealId
    );
    return Boolean(authority
      && authority.authorityRevision === claim.authorityRevision
      && authority.openQuoteCaseId === operation.quoteCaseId
      && authority.quoteVersionId === operation.quoteVersionId
      && authority.commercialAmountHash === operation.commercialAmountHash);
  }

  async listRecoverablePublications(now?: string, limit = 100) {
    const [rows] = await this.pool.query(
      `SELECT * FROM quote_publication_operations
       WHERE status IN ('queued','failed','partial_failure')
          OR (status = 'running' AND lease_expires_at <= COALESCE(?,CURRENT_TIMESTAMP(3)))
       ORDER BY recorded_at,id LIMIT ?`,
      [now ? growthMysqlDate(now) : null, Math.max(0, limit)]
    );
    return Object.freeze((rows as MysqlRow[]).map(parsePublicationRow));
  }

  async retryPublication(operationId: string, context: ActiveWorkspaceContext,
    _now: string) {
    requireGrowthCapabilities(context, ["quote.confirm"]);
    const workspace = await this.publicationWorkspace(operationId);
    if (!workspace) throw quoteError("publication_not_found");
    if (workspace !== context.workspaceId) {
      throw quoteError("publication_workspace_mismatch");
    }
    return this.transaction(async (connection, temporal) => {
      await temporal.lockWorkspaceTemporalBarrierForUpdate(workspace);
      const databaseNow = await temporal.currentTimestamp3();
      const current = await this.lockedPublication(connection, workspace,
        operationId);
      if (!current || current.status !== "failed"
        && current.status !== "partial_failure") {
        throw quoteError("publication_not_retryable");
      }
      const queued: QuotePublicationOperation = immutableQuoteValue({ ...current,
        status: "queued", leaseOwner: null, leaseExpiresAt: null,
        fencingToken: current.fencingToken + 1, lastErrorCode: null,
        updatedAt: databaseNow
      });
      const stamp = await this.appendPublicationHistory(connection, temporal,
        queued, null, context.actorId);
      await connection.query(
        `UPDATE quote_publication_operations SET status = 'queued',
         lease_owner = NULL,lease_expires_at = NULL,fencing_token = ?,
         operation_json = ?,recorded_at = ?,temporal_sequence = ?
         WHERE workspace_id = ? AND id = ? AND status IN ('failed','partial_failure')`,
        [queued.fencingToken, JSON.stringify(queued),
          growthMysqlDate(stamp.recordedAt), stamp.temporalSequence,
          workspace, operationId]
      );
      return queued;
    });
  }

  async listPublicationHistory(operationId: string) {
    const [rows] = await this.pool.query(
      `SELECT * FROM quote_publication_history WHERE operation_id = ?
       ORDER BY temporal_sequence`, [operationId]
    );
    return Object.freeze((rows as MysqlRow[]).map((row) =>
      immutableQuoteValue({
        id: String(row.id), workspaceId: String(row.workspace_id), operationId,
        status: String(row.status) as QuotePublicationOperation["status"],
        leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
        fencingToken: Number(row.fencing_token),
        authorityRevision: Number(row.authority_revision),
        piDocumentId: row.pi_document_id === null
          ? null : String(row.pi_document_id),
        dealEventId: row.deal_event_id === null
          ? null : String(row.deal_event_id),
        errorCode: row.error_code === null ? null : String(row.error_code),
        actorId: row.actor_id === null ? null : String(row.actor_id),
        recordedAt: growthMysqlInstant(row.recorded_at),
        temporalSequence: Number(row.temporal_sequence)
      })));
  }
}

function valueConflictCode(dealId: string | null) {
  return dealId ? "deal_open_quote_case_conflict" : "quote_case_identity_conflict";
}
