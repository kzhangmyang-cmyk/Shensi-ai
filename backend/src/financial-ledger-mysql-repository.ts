import type mysql from "mysql2/promise";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  ledgerEntryStatus,
  type AcquisitionCostEntry,
  type AcquisitionCostEstimate,
  type AcquisitionCostEstimateLifecycleEvent,
  type FinancialFact,
  type LedgerSourceHead,
  type LedgerType,
  type LedgerVerificationEvent
} from "./financial-ledger-domain.js";
import { assertFrozenCommercialBinding } from "./authoritative-quote-reader.js";
import type {
  FinancialLedgerRepository,
  FinancialLedgerTransaction
} from "./financial-ledger-repository.js";
import {
  assertConcreteGrowthWorkspaceId,
  type GrowthTemporalTransaction
} from "./growth-temporal-barrier.js";
import {
  ensureGrowthTemporalBarrierMysqlSchema,
  growthMysqlDate,
  growthMysqlInstant,
  MysqlGrowthTemporalTransaction
} from "./growth-temporal-barrier-mysql-repository.js";

type MysqlRow = Record<string, unknown>;
type QuerySource = Pick<mysql.Pool | mysql.PoolConnection, "query">;
type TransactionSource = mysql.Pool | mysql.PoolConnection;

export const FINANCIAL_LEDGER_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS acquisition_cost_entries (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    platform VARCHAR(191) NOT NULL,
    plan_id VARCHAR(191) NULL,
    run_id VARCHAR(191) NULL,
    provider_id VARCHAR(191) NULL,
    category VARCHAR(32) NOT NULL,
    amount_minor BIGINT NOT NULL,
    currency CHAR(3) NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    provenance VARCHAR(32) NOT NULL,
    source_ref TEXT NULL,
    evidence_hash VARCHAR(255) NOT NULL,
    external_id VARCHAR(191) NULL,
    ledger_type VARCHAR(16) NOT NULL DEFAULT 'cost',
    source_identity_root VARCHAR(512) NOT NULL,
    source_version BIGINT UNSIGNED NOT NULL,
    business_occurred_at DATETIME(3) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    corrects_cost_entry_id VARCHAR(191) NULL,
    correction_group_id VARCHAR(191) NULL,
    estimate_reconciliation_id VARCHAR(191) NULL,
    created_by VARCHAR(191) NOT NULL,
    PRIMARY KEY (workspace_id, id),
    UNIQUE KEY uk_ledger_source_version
      (workspace_id, ledger_type, source_identity_root, source_version),
    CONSTRAINT chk_cost_entry_ledger_type CHECK (ledger_type = 'cost'),
    KEY ix_cost_entry_temporal
      (workspace_id, currency, business_occurred_at, recorded_at, temporal_sequence)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_cost_estimates (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    cohort_id VARCHAR(191) NULL,
    plan_id VARCHAR(191) NULL,
    run_id VARCHAR(191) NULL,
    amount_minor BIGINT NOT NULL,
    currency CHAR(3) NOT NULL,
    source VARCHAR(32) NOT NULL,
    source_stable_key VARCHAR(512) NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    status VARCHAR(32) NOT NULL,
    source_version BIGINT UNSIGNED NOT NULL,
    input_snapshot_hash VARCHAR(255) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    valid_from DATETIME(3) NOT NULL,
    valid_to DATETIME(3) NULL,
    created_by VARCHAR(191) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    activated_at DATETIME(3) NULL,
    PRIMARY KEY (workspace_id, id),
    UNIQUE KEY uk_cost_estimate_version
      (workspace_id, currency, source_stable_key, version)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_cost_estimate_heads (
    workspace_id VARCHAR(191) NOT NULL,
    currency CHAR(3) NOT NULL,
    source_stable_key VARCHAR(512) NOT NULL,
    active_estimate_id VARCHAR(191) NULL,
    revision BIGINT UNSIGNED NOT NULL,
    last_event_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id, currency, source_stable_key)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_cost_estimate_lifecycle_events (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    currency CHAR(3) NOT NULL,
    source_stable_key VARCHAR(512) NOT NULL,
    estimate_id VARCHAR(191) NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    event_sequence BIGINT UNSIGNED NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    effective_at DATETIME(3) NOT NULL,
    supersedes_estimate_id VARCHAR(191) NULL,
    actor_id VARCHAR(191) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id, id),
    UNIQUE KEY uk_cost_estimate_event_sequence
      (workspace_id, currency, source_stable_key, event_sequence),
    UNIQUE KEY uk_cost_estimate_event_revision
      (workspace_id, currency, source_stable_key, revision)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_cost_evidence_projections (
    workspace_id VARCHAR(191) NOT NULL,
    source_kind VARCHAR(32) NOT NULL,
    source_id VARCHAR(191) NOT NULL,
    target_kind VARCHAR(32) NOT NULL,
    target_id VARCHAR(191) NOT NULL,
    evidence_fingerprint VARCHAR(255) NOT NULL,
    source_version BIGINT UNSIGNED NOT NULL,
    projected_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, source_kind, source_id),
    CONSTRAINT chk_cost_evidence_projection_source
      CHECK (source_kind = 'provider_request'),
    CONSTRAINT chk_cost_evidence_projection_target
      CHECK (target_kind IN ('cost_entry', 'estimate')),
    CONSTRAINT chk_cost_evidence_projection_version
      CHECK (source_version >= 1)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS financial_facts (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    candidate_id VARCHAR(191) NULL,
    customer_id VARCHAR(191) NULL,
    deal_id VARCHAR(191) NULL,
    quote_version_id VARCHAR(191) NULL,
    fact_type VARCHAR(32) NOT NULL,
    amount_minor BIGINT NOT NULL,
    currency CHAR(3) NOT NULL,
    business_occurred_at DATETIME(3) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    provenance VARCHAR(32) NOT NULL,
    source_ref TEXT NULL,
    evidence_hash VARCHAR(255) NOT NULL,
    external_id VARCHAR(191) NULL,
    ledger_type VARCHAR(16) NOT NULL DEFAULT 'financial',
    source_identity_root VARCHAR(512) NOT NULL,
    source_version BIGINT UNSIGNED NOT NULL,
    attribution_snapshot_json JSON NULL,
    commercial_binding_snapshot_json JSON NULL,
    commercial_amount_hash VARCHAR(255) NULL,
    deal_authority_revision BIGINT UNSIGNED NULL,
    corrects_fact_id VARCHAR(191) NULL,
    correction_group_id VARCHAR(191) NULL,
    created_by VARCHAR(191) NOT NULL,
    PRIMARY KEY (workspace_id, id),
    UNIQUE KEY uk_ledger_source_version
      (workspace_id, ledger_type, source_identity_root, source_version),
    CONSTRAINT chk_financial_fact_ledger_type CHECK (ledger_type = 'financial'),
    KEY ix_financial_fact_temporal
      (workspace_id, currency, business_occurred_at, recorded_at, temporal_sequence)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS ledger_verification_events (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    ledger_type VARCHAR(16) NOT NULL,
    ledger_entry_id VARCHAR(191) NOT NULL,
    event_type VARCHAR(16) NOT NULL,
    reverses_event_id VARCHAR(191) NULL,
    event_sequence BIGINT UNSIGNED NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    correction_group_id VARCHAR(191) NULL,
    reason TEXT NOT NULL,
    decided_by VARCHAR(191) NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id, ledger_type, id),
    UNIQUE KEY uk_ledger_single_decision
      (workspace_id, ledger_type, ledger_entry_id, event_sequence),
    UNIQUE KEY uk_ledger_entry_revision
      (workspace_id, ledger_type, ledger_entry_id, revision),
    KEY ix_ledger_event_temporal
      (workspace_id, ledger_type, ledger_entry_id, recorded_at, temporal_sequence)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS ledger_source_heads (
    workspace_id VARCHAR(191) NOT NULL,
    ledger_type VARCHAR(16) NOT NULL,
    source_identity_root VARCHAR(512) NOT NULL,
    current_ledger_entry_id VARCHAR(191) NOT NULL,
    current_source_version BIGINT UNSIGNED NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uk_ledger_source_head
      (workspace_id, ledger_type, source_identity_root)
  ) ENGINE=InnoDB`
] as const;

export async function ensureFinancialLedgerMysqlSchema(pool: mysql.Pool): Promise<void> {
  await ensureGrowthTemporalBarrierMysqlSchema(pool);
  for (const statement of FINANCIAL_LEDGER_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function textValue(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function nullableText(value: unknown, code: string): string | null {
  return value === null ? null : textValue(value, code);
}

function safeInteger(value: unknown, code: string, minimum = 0): number {
  if ((typeof value !== "string" && typeof value !== "number")
    || (typeof value === "string" && !/^-?\d+$/u.test(value))) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(code);
  return parsed;
}

function signedMinor(value: unknown): number {
  if ((typeof value !== "string" && typeof value !== "number")
    || (typeof value === "string" && !/^-?\d+$/u.test(value))) {
    throw new Error("invalid_ledger_amount_minor");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid_ledger_amount_minor");
  return parsed;
}

function parseSafeMinor(value: unknown, field: string): number {
  const text = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^[0-9]+$/u.test(text)) {
    throw new Error(`FINANCIAL_LEDGER_MYSQL_INTEGRITY:${field}`);
  }
  const amount = BigInt(text);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`FINANCIAL_LEDGER_MYSQL_INTEGRITY:${field}`);
  }
  return Number(amount);
}

function assertFrozenBindingIntegrity(
  snapshot: FinancialFact["commercialBindingSnapshot"]
): void {
  if (!snapshot) return;
  try {
    assertFrozenCommercialBinding(snapshot);
  } catch {
    throw new Error(
      "FINANCIAL_LEDGER_MYSQL_INTEGRITY:commercial_binding_snapshot_json"
    );
  }
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], code: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(code);
  return value as T;
}

function strictJson(value: unknown, code: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(code);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => strictJson(item, code));
  if (value && typeof value === "object"
    && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, strictJson(item, code)]));
  }
  throw new Error(code);
}

function structuredJson(value: unknown, code: string): Record<string, unknown> | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
    parsed = strictJson(parsed, code);
    const canonical = canonicalJsonStringify(parsed);
    if (!canonical) throw new Error(code);
    parsed = JSON.parse(canonical);
  } catch {
    throw new Error(code);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(code);
  return parsed as Record<string, unknown>;
}

function jsonForMysql(value: unknown): string | null {
  if (value === null) return null;
  try {
    const encoded = canonicalJsonStringify(strictJson(value, "invalid_ledger_json"));
    if (!encoded) throw new Error("invalid_ledger_json");
    JSON.parse(encoded);
    return encoded;
  } catch {
    throw new Error("invalid_ledger_json");
  }
}

function costEntry(row: MysqlRow): AcquisitionCostEntry {
  return Object.freeze({
    id: textValue(row.id, "invalid_cost_entry_row"),
    workspaceId: assertConcreteGrowthWorkspaceId(textValue(row.workspace_id, "invalid_cost_entry_row")),
    platform: textValue(row.platform, "invalid_cost_entry_row"),
    planId: nullableText(row.plan_id, "invalid_cost_entry_row"),
    runId: nullableText(row.run_id, "invalid_cost_entry_row"),
    providerId: nullableText(row.provider_id, "invalid_cost_entry_row"),
    category: enumValue(row.category, ["api", "media", "content", "agency", "operation"] as const, "invalid_cost_entry_row"),
    amountMinor: signedMinor(row.amount_minor),
    currency: textValue(row.currency, "invalid_cost_entry_row"),
    occurredAt: growthMysqlInstant(row.occurred_at),
    provenance: enumValue(row.provenance, ["provider_reported", "portal_export", "invoice_confirmed", "manual_verified"] as const, "invalid_cost_entry_row"),
    sourceRef: nullableText(row.source_ref, "invalid_cost_entry_row"),
    evidenceHash: textValue(row.evidence_hash, "invalid_cost_entry_row"),
    externalId: nullableText(row.external_id, "invalid_cost_entry_row"),
    sourceIdentityRoot: textValue(row.source_identity_root, "invalid_cost_entry_row"),
    sourceVersion: safeInteger(row.source_version, "invalid_ledger_source_version", 1),
    businessOccurredAt: growthMysqlInstant(row.business_occurred_at),
    recordedAt: growthMysqlInstant(row.recorded_at),
    temporalSequence: safeInteger(row.temporal_sequence, "invalid_growth_temporal_sequence", 1),
    correctsCostEntryId: nullableText(row.corrects_cost_entry_id, "invalid_cost_entry_row"),
    correctionGroupId: nullableText(row.correction_group_id, "invalid_cost_entry_row"),
    estimateReconciliationId: nullableText(row.estimate_reconciliation_id, "invalid_cost_entry_row"),
    createdBy: textValue(row.created_by, "invalid_cost_entry_row")
  });
}

function financialFact(row: MysqlRow): FinancialFact {
  const attributionSnapshot = structuredJson(row.attribution_snapshot_json, "invalid_financial_fact_json");
  const commercialBindingSnapshot = structuredJson(row.commercial_binding_snapshot_json, "invalid_financial_fact_json");
  const id = textValue(row.id, "invalid_financial_fact_row");
  const workspaceId = assertConcreteGrowthWorkspaceId(
    textValue(row.workspace_id, "invalid_financial_fact_row")
  );
  const fact = Object.freeze({
    id,
    workspaceId,
    candidateId: nullableText(row.candidate_id, "invalid_financial_fact_row"),
    customerId: nullableText(row.customer_id, "invalid_financial_fact_row"),
    dealId: nullableText(row.deal_id, "invalid_financial_fact_row"),
    quoteVersionId: nullableText(row.quote_version_id, "invalid_financial_fact_row"),
    factType: enumValue(row.fact_type, ["contract_won", "payment_received", "revenue_recognized", "cogs_recognized", "refund", "bad_debt_written_off"] as const, "invalid_financial_fact_row"),
    amountMinor: parseSafeMinor(row.amount_minor, "amount_minor"),
    currency: textValue(row.currency, "invalid_financial_fact_row"),
    businessOccurredAt: growthMysqlInstant(row.business_occurred_at),
    recordedAt: growthMysqlInstant(row.recorded_at),
    temporalSequence: safeInteger(row.temporal_sequence, "invalid_growth_temporal_sequence", 1),
    provenance: enumValue(row.provenance, ["portal_export", "bank_statement", "invoice_confirmed", "manual_verified", "derived_from_import"] as const, "invalid_financial_fact_row"),
    sourceRef: nullableText(row.source_ref, "invalid_financial_fact_row"),
    evidenceHash: textValue(row.evidence_hash, "invalid_financial_fact_row"),
    externalId: nullableText(row.external_id, "invalid_financial_fact_row"),
    sourceIdentityRoot: textValue(row.source_identity_root, "invalid_financial_fact_row"),
    sourceVersion: safeInteger(row.source_version, "invalid_ledger_source_version", 1),
    attributionSnapshot: attributionSnapshot as FinancialFact["attributionSnapshot"],
    commercialBindingSnapshot: commercialBindingSnapshot as
      FinancialFact["commercialBindingSnapshot"],
    commercialAmountHash: nullableText(row.commercial_amount_hash, "invalid_financial_fact_row"),
    dealAuthorityRevision: row.deal_authority_revision === null ? null : safeInteger(row.deal_authority_revision, "invalid_deal_authority_revision", 1),
    correctsFactId: nullableText(row.corrects_fact_id, "invalid_financial_fact_row"),
    correctionGroupId: nullableText(row.correction_group_id, "invalid_financial_fact_row"),
    createdBy: textValue(row.created_by, "invalid_financial_fact_row")
  });
  if (fact.workspaceId !== String(row.workspace_id)
    || fact.id !== String(row.id)) {
    throw new Error("FINANCIAL_LEDGER_MYSQL_INTEGRITY:financial_fact_scope");
  }
  assertFrozenBindingIntegrity(fact.commercialBindingSnapshot);
  return fact;
}

function verificationEvent(row: MysqlRow): LedgerVerificationEvent {
  return Object.freeze({
    id: textValue(row.id, "invalid_ledger_event_row"),
    workspaceId: assertConcreteGrowthWorkspaceId(textValue(row.workspace_id, "invalid_ledger_event_row")),
    ledgerType: enumValue(row.ledger_type, ["cost", "financial"] as const, "invalid_ledger_event_row"),
    ledgerEntryId: textValue(row.ledger_entry_id, "invalid_ledger_event_row"),
    eventType: enumValue(row.event_type, ["verified", "rejected", "reversed"] as const, "invalid_ledger_event_row"),
    reversesEventId: nullableText(row.reverses_event_id, "invalid_ledger_event_row"),
    eventSequence: safeInteger(row.event_sequence, "ledger_event_sequence_invalid", 1),
    revision: safeInteger(row.revision, "ledger_event_sequence_invalid", 2),
    correctionGroupId: nullableText(row.correction_group_id, "invalid_ledger_event_row"),
    reason: textValue(row.reason, "invalid_ledger_event_row"),
    decidedBy: textValue(row.decided_by, "invalid_ledger_event_row"),
    recordedAt: growthMysqlInstant(row.recorded_at),
    temporalSequence: safeInteger(row.temporal_sequence, "invalid_growth_temporal_sequence", 1)
  });
}

function sourceHead(row: MysqlRow): LedgerSourceHead {
  return Object.freeze({
    workspaceId: assertConcreteGrowthWorkspaceId(textValue(row.workspace_id, "invalid_ledger_source_head")),
    ledgerType: enumValue(row.ledger_type, ["cost", "financial"] as const, "invalid_ledger_source_head"),
    sourceIdentityRoot: textValue(row.source_identity_root, "invalid_ledger_source_head"),
    currentLedgerEntryId: textValue(row.current_ledger_entry_id, "invalid_ledger_source_head"),
    currentSourceVersion: safeInteger(row.current_source_version, "invalid_ledger_source_head", 1),
    revision: safeInteger(row.revision, "invalid_ledger_source_head", 1)
  });
}

function costEstimate(row: MysqlRow): AcquisitionCostEstimate {
  return Object.freeze({
    id: textValue(row.id, "invalid_cost_estimate_row"),
    workspaceId: assertConcreteGrowthWorkspaceId(textValue(row.workspace_id, "invalid_cost_estimate_row")),
    cohortId: nullableText(row.cohort_id, "invalid_cost_estimate_row"),
    planId: nullableText(row.plan_id, "invalid_cost_estimate_row"),
    runId: nullableText(row.run_id, "invalid_cost_estimate_row"),
    amountMinor: signedMinor(row.amount_minor),
    currency: textValue(row.currency, "invalid_cost_estimate_row"),
    source: enumValue(row.source, ["approved_budget", "plan_budget", "provider_estimate", "manual_estimate"] as const, "invalid_cost_estimate_row"),
    sourceStableKey: textValue(row.source_stable_key, "invalid_cost_estimate_row"),
    version: safeInteger(row.version, "invalid_cost_estimate_version", 1),
    status: enumValue(row.status, ["draft", "active", "superseded"] as const, "invalid_cost_estimate_row"),
    sourceVersion: safeInteger(row.source_version, "invalid_cost_estimate_version", 1),
    inputSnapshotHash: textValue(row.input_snapshot_hash, "invalid_cost_estimate_row"),
    revision: safeInteger(row.revision, "invalid_cost_estimate_revision", 1),
    validFrom: growthMysqlInstant(row.valid_from),
    validTo: row.valid_to === null ? null : growthMysqlInstant(row.valid_to),
    createdBy: textValue(row.created_by, "invalid_cost_estimate_row"),
    createdAt: growthMysqlInstant(row.created_at),
    temporalSequence: safeInteger(row.temporal_sequence, "invalid_growth_temporal_sequence", 1),
    activatedAt: row.activated_at === null ? null : growthMysqlInstant(row.activated_at)
  });
}

function estimateEvent(row: MysqlRow): AcquisitionCostEstimateLifecycleEvent {
  return Object.freeze({
    id: textValue(row.id, "invalid_cost_estimate_event_row"),
    workspaceId: assertConcreteGrowthWorkspaceId(textValue(row.workspace_id, "invalid_cost_estimate_event_row")),
    currency: textValue(row.currency, "invalid_cost_estimate_event_row"),
    sourceStableKey: textValue(row.source_stable_key, "invalid_cost_estimate_event_row"),
    estimateId: textValue(row.estimate_id, "invalid_cost_estimate_event_row"),
    eventType: enumValue(row.event_type, ["activated", "superseded"] as const, "invalid_cost_estimate_event_row"),
    eventSequence: safeInteger(row.event_sequence, "invalid_cost_estimate_event_sequence", 1),
    revision: safeInteger(row.revision, "invalid_cost_estimate_event_revision", 1),
    effectiveAt: growthMysqlInstant(row.effective_at),
    supersedesEstimateId: nullableText(row.supersedes_estimate_id, "invalid_cost_estimate_event_row"),
    actorId: textValue(row.actor_id, "invalid_cost_estimate_event_row"),
    recordedAt: growthMysqlInstant(row.recorded_at),
    temporalSequence: safeInteger(row.temporal_sequence, "invalid_growth_temporal_sequence", 1)
  });
}

function affectedRows(result: unknown): number {
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

async function one(source: QuerySource, sql: string, values: readonly unknown[]): Promise<MysqlRow | null> {
  const [rows] = await source.query(sql, [...values]);
  return (rows as MysqlRow[])[0] ?? null;
}

export class MysqlFinancialLedgerTransaction implements FinancialLedgerTransaction {
  private readonly temporal: GrowthTemporalTransaction;
  constructor(
    private readonly connection: mysql.PoolConnection,
    private readonly onLock?: (lock: string) => void
  ) {
    this.temporal = new MysqlGrowthTemporalTransaction(connection);
  }

  lockWorkspaceTemporalBarrierForUpdate(workspaceId: string) {
    this.onLock?.(`temporal:${workspaceId}`);
    return this.temporal.lockWorkspaceTemporalBarrierForUpdate(workspaceId);
  }
  currentTimestamp3() { return this.temporal.currentTimestamp3(); }
  saveWorkspaceTemporalBarrier(workspaceId: string, expectedSequence: number,
    next: { lastRecordedAt: string; temporalSequence: number }) {
    return this.temporal.saveWorkspaceTemporalBarrier(workspaceId, expectedSequence, next);
  }

  async getSourceHeadForUpdate(workspaceId: string, ledgerType: LedgerType, sourceIdentityRoot: string) {
    this.onLock?.(`source:${ledgerType}:${sourceIdentityRoot}`);
    const row = await one(this.connection,
      `SELECT * FROM ledger_source_heads
       WHERE workspace_id = ? AND ledger_type = ? AND source_identity_root = ?
       FOR UPDATE`, [assertConcreteGrowthWorkspaceId(workspaceId), ledgerType, sourceIdentityRoot]);
    return row ? sourceHead(row) : null;
  }
  async insertSourceHead(head: LedgerSourceHead) {
    safeInteger(head.currentSourceVersion, "invalid_ledger_source_head", 1);
    safeInteger(head.revision, "invalid_ledger_source_head", 1);
    await this.connection.query(
      `INSERT INTO ledger_source_heads (
        workspace_id, ledger_type, source_identity_root, current_ledger_entry_id,
        current_source_version, revision
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [head.workspaceId, head.ledgerType, head.sourceIdentityRoot,
        head.currentLedgerEntryId, head.currentSourceVersion, head.revision]);
  }
  async compareAndSetSourceHead(expectedRevision: number, head: LedgerSourceHead) {
    safeInteger(expectedRevision, "invalid_ledger_source_head", 1);
    safeInteger(head.currentSourceVersion, "invalid_ledger_source_head", 1);
    if (head.revision !== expectedRevision + 1) {
      throw new Error("invalid_ledger_source_head_revision");
    }
    const [result] = await this.connection.query(
      `UPDATE ledger_source_heads SET current_ledger_entry_id = ?,
        current_source_version = ?, revision = ?
       WHERE workspace_id = ? AND ledger_type = ? AND source_identity_root = ?
         AND revision = ?`,
      [head.currentLedgerEntryId, head.currentSourceVersion, head.revision,
        head.workspaceId, head.ledgerType, head.sourceIdentityRoot, expectedRevision]);
    return affectedRows(result) === 1;
  }
  async getCostEntryForUpdate(workspaceId: string, id: string) {
    this.onLock?.(`entry:cost:${id}`);
    const row = await one(this.connection,
      "SELECT * FROM acquisition_cost_entries WHERE workspace_id = ? AND id = ? FOR UPDATE",
      [assertConcreteGrowthWorkspaceId(workspaceId), id]);
    return row ? costEntry(row) : null;
  }
  async insertCostEntry(entry: AcquisitionCostEntry) {
    signedMinor(entry.amountMinor);
    safeInteger(entry.sourceVersion, "invalid_ledger_source_version", 1);
    safeInteger(entry.temporalSequence, "invalid_growth_temporal_sequence", 1);
    await this.connection.query(
      `INSERT INTO acquisition_cost_entries (
        id, workspace_id, platform, plan_id, run_id, provider_id, category,
        amount_minor, currency, occurred_at, provenance, source_ref, evidence_hash,
        external_id, source_identity_root, source_version, business_occurred_at,
        recorded_at, temporal_sequence, corrects_cost_entry_id, correction_group_id,
        estimate_reconciliation_id, created_by
      ) VALUES (${Array(23).fill("?").join(", ")})`,
      [entry.id, entry.workspaceId, entry.platform, entry.planId, entry.runId,
        entry.providerId, entry.category, entry.amountMinor, entry.currency,
        growthMysqlDate(entry.occurredAt), entry.provenance, entry.sourceRef,
        entry.evidenceHash, entry.externalId, entry.sourceIdentityRoot,
        entry.sourceVersion, growthMysqlDate(entry.businessOccurredAt),
        growthMysqlDate(entry.recordedAt), entry.temporalSequence,
        entry.correctsCostEntryId, entry.correctionGroupId,
        entry.estimateReconciliationId, entry.createdBy]);
  }
  async getFinancialFactForUpdate(workspaceId: string, id: string) {
    this.onLock?.(`entry:financial:${id}`);
    const row = await one(this.connection,
      "SELECT * FROM financial_facts WHERE workspace_id = ? AND id = ? FOR UPDATE",
      [assertConcreteGrowthWorkspaceId(workspaceId), id]);
    return row ? financialFact(row) : null;
  }
  async insertFinancialFact(fact: FinancialFact) {
    parseSafeMinor(fact.amountMinor, "amount_minor");
    safeInteger(fact.sourceVersion, "invalid_ledger_source_version", 1);
    safeInteger(fact.temporalSequence, "invalid_growth_temporal_sequence", 1);
    if (fact.dealAuthorityRevision !== null) {
      safeInteger(fact.dealAuthorityRevision, "invalid_deal_authority_revision", 1);
    }
    assertFrozenBindingIntegrity(fact.commercialBindingSnapshot);
    await this.connection.query(
      `INSERT INTO financial_facts (
        id, workspace_id, candidate_id, customer_id, deal_id, quote_version_id,
        fact_type, amount_minor, currency, business_occurred_at, recorded_at,
        temporal_sequence, provenance, source_ref, evidence_hash, external_id,
        source_identity_root, source_version, attribution_snapshot_json,
        commercial_binding_snapshot_json, commercial_amount_hash,
        deal_authority_revision, corrects_fact_id, correction_group_id, created_by
      ) VALUES (${Array(25).fill("?").join(", ")})`,
      [fact.id, fact.workspaceId, fact.candidateId, fact.customerId, fact.dealId,
        fact.quoteVersionId, fact.factType, fact.amountMinor, fact.currency,
        growthMysqlDate(fact.businessOccurredAt), growthMysqlDate(fact.recordedAt),
        fact.temporalSequence, fact.provenance, fact.sourceRef, fact.evidenceHash,
        fact.externalId, fact.sourceIdentityRoot, fact.sourceVersion,
        jsonForMysql(fact.attributionSnapshot), jsonForMysql(fact.commercialBindingSnapshot),
        fact.commercialAmountHash, fact.dealAuthorityRevision, fact.correctsFactId,
        fact.correctionGroupId, fact.createdBy]);
  }
  async listVerificationEventsForUpdate(workspaceId: string, ledgerType: LedgerType, ledgerEntryId: string) {
    this.onLock?.(`events:${ledgerType}:${ledgerEntryId}`);
    const [rows] = await this.connection.query(
      `SELECT * FROM ledger_verification_events
       WHERE workspace_id = ? AND ledger_type = ? AND ledger_entry_id = ?
       ORDER BY event_sequence ASC, revision ASC FOR UPDATE`,
      [assertConcreteGrowthWorkspaceId(workspaceId), ledgerType, ledgerEntryId]);
    const events = (rows as MysqlRow[]).map(verificationEvent);
    ledgerEntryStatus(events);
    return events;
  }
  async appendVerificationEvent(event: LedgerVerificationEvent) {
    safeInteger(event.eventSequence, "ledger_event_sequence_invalid", 1);
    safeInteger(event.revision, "ledger_event_sequence_invalid", 2);
    safeInteger(event.temporalSequence, "invalid_growth_temporal_sequence", 1);
    if (event.revision !== event.eventSequence + 1) {
      throw new Error("ledger_event_sequence_invalid");
    }
    await this.connection.query(
      `INSERT INTO ledger_verification_events (
        id, workspace_id, ledger_type, ledger_entry_id, event_type,
        reverses_event_id, event_sequence, revision, correction_group_id,
        reason, decided_by, recorded_at, temporal_sequence
      ) VALUES (${Array(13).fill("?").join(", ")})`,
      [event.id, event.workspaceId, event.ledgerType, event.ledgerEntryId,
        event.eventType, event.reversesEventId, event.eventSequence, event.revision,
        event.correctionGroupId, event.reason, event.decidedBy,
        growthMysqlDate(event.recordedAt), event.temporalSequence]);
  }
  async getCostEstimateForUpdate(workspaceId: string, id: string) {
    this.onLock?.(`estimate:${id}`);
    const row = await one(this.connection,
      "SELECT * FROM acquisition_cost_estimates WHERE workspace_id = ? AND id = ? FOR UPDATE",
      [assertConcreteGrowthWorkspaceId(workspaceId), id]);
    return row ? costEstimate(row) : null;
  }
  async insertCostEstimate(estimate: AcquisitionCostEstimate) {
    signedMinor(estimate.amountMinor);
    safeInteger(estimate.version, "invalid_cost_estimate_version", 1);
    safeInteger(estimate.sourceVersion, "invalid_cost_estimate_version", 1);
    safeInteger(estimate.revision, "invalid_cost_estimate_revision", 1);
    safeInteger(estimate.temporalSequence, "invalid_growth_temporal_sequence", 1);
    await this.connection.query(
      `INSERT INTO acquisition_cost_estimates (
        id, workspace_id, cohort_id, plan_id, run_id, amount_minor, currency,
        source, source_stable_key, version, status, source_version,
        input_snapshot_hash, revision, valid_from, valid_to, created_by, created_at,
        temporal_sequence, activated_at
      ) VALUES (${Array(20).fill("?").join(", ")})`,
      [estimate.id, estimate.workspaceId, estimate.cohortId, estimate.planId,
        estimate.runId, estimate.amountMinor, estimate.currency, estimate.source,
        estimate.sourceStableKey, estimate.version, estimate.status,
        estimate.sourceVersion, estimate.inputSnapshotHash, estimate.revision,
        growthMysqlDate(estimate.validFrom), estimate.validTo === null ? null : growthMysqlDate(estimate.validTo),
        estimate.createdBy, growthMysqlDate(estimate.createdAt), estimate.temporalSequence,
        estimate.activatedAt === null ? null : growthMysqlDate(estimate.activatedAt)]);
  }
  async getActiveCostEstimateForUpdate(workspaceId: string, currency: string, sourceStableKey: string) {
    this.onLock?.(`estimate-head:${currency}:${sourceStableKey}`);
    const head = await one(this.connection,
      `SELECT active_estimate_id FROM acquisition_cost_estimate_heads
       WHERE workspace_id = ? AND currency = ? AND source_stable_key = ? FOR UPDATE`,
      [assertConcreteGrowthWorkspaceId(workspaceId), currency, sourceStableKey]);
    if (!head?.active_estimate_id) return null;
    return this.getCostEstimateForUpdate(workspaceId,
      textValue(head.active_estimate_id, "invalid_cost_estimate_head"));
  }
  async listCostEstimateLifecycleEventsForUpdate(workspaceId: string, currency: string, sourceStableKey: string) {
    this.onLock?.(`estimate-events:${currency}:${sourceStableKey}`);
    const [rows] = await this.connection.query(
      `SELECT * FROM acquisition_cost_estimate_lifecycle_events
       WHERE workspace_id = ? AND currency = ? AND source_stable_key = ?
       ORDER BY event_sequence ASC, revision ASC FOR UPDATE`,
      [assertConcreteGrowthWorkspaceId(workspaceId), currency, sourceStableKey]);
    return (rows as MysqlRow[]).map(estimateEvent);
  }
  async appendCostEstimateLifecycleEvent(event: AcquisitionCostEstimateLifecycleEvent) {
    safeInteger(event.eventSequence, "invalid_cost_estimate_event_sequence", 1);
    safeInteger(event.revision, "invalid_cost_estimate_event_revision", 1);
    safeInteger(event.temporalSequence, "invalid_growth_temporal_sequence", 1);
    if (event.revision !== event.eventSequence) {
      throw new Error("cost_estimate_event_sequence_invalid");
    }
    await this.connection.query(
      `INSERT INTO acquisition_cost_estimate_lifecycle_events (
        id, workspace_id, currency, source_stable_key, estimate_id, event_type,
        event_sequence, revision, effective_at, supersedes_estimate_id, actor_id,
        recorded_at, temporal_sequence
      ) VALUES (${Array(13).fill("?").join(", ")})`,
      [event.id, event.workspaceId, event.currency, event.sourceStableKey,
        event.estimateId, event.eventType, event.eventSequence, event.revision,
        growthMysqlDate(event.effectiveAt), event.supersedesEstimateId, event.actorId,
        growthMysqlDate(event.recordedAt), event.temporalSequence]);
  }
  async compareAndSetCostEstimateHead(input: {
    workspaceId: string; currency: string; sourceStableKey: string;
    expectedRevision: number; activeEstimateId: string | null; lastEventSequence: number;
  }) {
    safeInteger(input.expectedRevision, "invalid_cost_estimate_head_revision");
    safeInteger(input.lastEventSequence, "invalid_cost_estimate_event_sequence");
    if (input.expectedRevision === 0) {
      try {
        const [result] = await this.connection.query(
          `INSERT INTO acquisition_cost_estimate_heads (
            workspace_id, currency, source_stable_key, active_estimate_id,
            revision, last_event_sequence
          ) VALUES (?, ?, ?, ?, 1, ?)`,
          [input.workspaceId, input.currency, input.sourceStableKey,
            input.activeEstimateId, input.lastEventSequence]);
        return affectedRows(result) === 1;
      } catch (error) {
        if ((error as { code?: unknown }).code === "ER_DUP_ENTRY") return false;
        throw error;
      }
    }
    const [result] = await this.connection.query(
      `UPDATE acquisition_cost_estimate_heads SET active_estimate_id = ?,
        revision = ?, last_event_sequence = ?
       WHERE workspace_id = ? AND currency = ? AND source_stable_key = ?
         AND revision = ?`,
      [input.activeEstimateId, input.expectedRevision + 1,
        input.lastEventSequence, input.workspaceId, input.currency,
        input.sourceStableKey, input.expectedRevision]);
    return affectedRows(result) === 1;
  }
}

function isPool(source: TransactionSource): source is mysql.Pool {
  return typeof (source as mysql.Pool).getConnection === "function";
}

export class MysqlFinancialLedgerRepository implements FinancialLedgerRepository {
  readonly lockTraces: string[][] = [];
  constructor(private readonly source: TransactionSource) {}

  async run<T>(work: (tx: GrowthTemporalTransaction) => Promise<T>): Promise<T> {
    return this.transaction((tx) => work(tx));
  }

  async transaction<T>(work: (tx: FinancialLedgerTransaction) => Promise<T>): Promise<T> {
    const connection = isPool(this.source) ? await this.source.getConnection() : this.source;
    const owned = isPool(this.source);
    const trace: string[] = [];
    this.lockTraces.push(trace);
    try {
      await connection.beginTransaction();
      const result = await work(new MysqlFinancialLedgerTransaction(
        connection, (lock) => trace.push(lock)
      ));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      if (owned) connection.release();
    }
  }

  private querySource(): QuerySource { return this.source; }
  async getCostEntry(workspaceId: string, id: string) {
    const row = await one(this.querySource(),
      "SELECT * FROM acquisition_cost_entries WHERE workspace_id = ? AND id = ?",
      [assertConcreteGrowthWorkspaceId(workspaceId), id]);
    return row ? costEntry(row) : null;
  }
  async getCostEntryBySource(workspaceId: string, sourceIdentityRoot: string) {
    const row = await one(this.querySource(),
      `SELECT entry.* FROM ledger_source_heads head
       JOIN acquisition_cost_entries entry
         ON entry.workspace_id = head.workspace_id
        AND entry.id = head.current_ledger_entry_id
       WHERE head.workspace_id = ? AND head.ledger_type = 'cost'
         AND head.source_identity_root = ?`,
      [assertConcreteGrowthWorkspaceId(workspaceId), sourceIdentityRoot]);
    return row ? costEntry(row) : null;
  }
  async getFinancialFact(workspaceId: string, id: string) {
    const row = await one(this.querySource(),
      "SELECT * FROM financial_facts WHERE workspace_id = ? AND id = ?",
      [assertConcreteGrowthWorkspaceId(workspaceId), id]);
    return row ? financialFact(row) : null;
  }
  async getFinancialFactBySource(workspaceId: string, sourceIdentityRoot: string) {
    const row = await one(this.querySource(),
      `SELECT fact.* FROM ledger_source_heads head
       JOIN financial_facts fact
         ON fact.workspace_id = head.workspace_id
        AND fact.id = head.current_ledger_entry_id
       WHERE head.workspace_id = ? AND head.ledger_type = 'financial'
         AND head.source_identity_root = ?`,
      [assertConcreteGrowthWorkspaceId(workspaceId), sourceIdentityRoot]);
    return row ? financialFact(row) : null;
  }
  async listFinancialFacts(workspaceId: string) {
    const [rows] = await this.querySource().query(
      `SELECT * FROM financial_facts
       WHERE workspace_id = ?
       ORDER BY business_occurred_at ASC, id ASC`,
      [assertConcreteGrowthWorkspaceId(workspaceId)]);
    return (rows as MysqlRow[]).map(financialFact);
  }
  async getCostEstimate(workspaceId: string, id: string) {
    const row = await one(this.querySource(),
      "SELECT * FROM acquisition_cost_estimates WHERE workspace_id = ? AND id = ?",
      [assertConcreteGrowthWorkspaceId(workspaceId), id]);
    return row ? costEstimate(row) : null;
  }
  async listCostEstimateLifecycleEvents(workspaceId: string, currency: string, sourceStableKey: string, asOf: string) {
    const [rows] = await this.querySource().query(
      `SELECT * FROM acquisition_cost_estimate_lifecycle_events
       WHERE workspace_id = ? AND currency = ? AND source_stable_key = ?
         AND recorded_at <= ? ORDER BY event_sequence ASC, revision ASC`,
      [assertConcreteGrowthWorkspaceId(workspaceId), currency, sourceStableKey,
        growthMysqlDate(asOf)]);
    return (rows as MysqlRow[]).map(estimateEvent);
  }
  async listVerificationEvents(workspaceId: string, ledgerType: LedgerType, ledgerEntryId: string) {
    const [rows] = await this.querySource().query(
      `SELECT * FROM ledger_verification_events
       WHERE workspace_id = ? AND ledger_type = ? AND ledger_entry_id = ?
       ORDER BY event_sequence ASC, revision ASC`,
      [assertConcreteGrowthWorkspaceId(workspaceId), ledgerType, ledgerEntryId]);
    const events = (rows as MysqlRow[]).map(verificationEvent);
    ledgerEntryStatus(events);
    return events;
  }

  async getProviderEvidenceProjection(workspaceId: string, sourceId: string) {
    const row = await one(this.querySource(),
      `SELECT target_kind, target_id, evidence_fingerprint, source_version
       FROM acquisition_cost_evidence_projections
       WHERE workspace_id = ? AND source_kind = 'provider_request'
         AND source_id = ?`,
      [assertConcreteGrowthWorkspaceId(workspaceId), sourceId]);
    if (!row) return null;
    return Object.freeze({
      targetKind: enumValue(row.target_kind, ["cost_entry", "estimate"] as const,
        "invalid_cost_evidence_projection_row"),
      targetId: textValue(row.target_id, "invalid_cost_evidence_projection_row"),
      evidenceFingerprint: textValue(
        row.evidence_fingerprint, "invalid_cost_evidence_projection_row"
      ),
      sourceVersion: safeInteger(
        row.source_version, "invalid_cost_evidence_projection_version", 1
      )
    });
  }

  async recordProviderEvidenceProjection(input: {
    workspaceId: string;
    sourceId: string;
    targetKind: "cost_entry" | "estimate";
    targetId: string;
    evidenceFingerprint: string;
    sourceVersion: number;
    projectedAt: string;
  }): Promise<void> {
    safeInteger(input.sourceVersion, "invalid_cost_evidence_projection_version", 1);
    try {
      await this.querySource().query(
        `INSERT INTO acquisition_cost_evidence_projections (
          workspace_id, source_kind, source_id, target_kind, target_id,
          evidence_fingerprint, source_version, projected_at
        ) VALUES (?, 'provider_request', ?, ?, ?, ?, ?, ?)`,
        [assertConcreteGrowthWorkspaceId(input.workspaceId), input.sourceId,
          input.targetKind, input.targetId, input.evidenceFingerprint,
          input.sourceVersion, growthMysqlDate(input.projectedAt)]
      );
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ER_DUP_ENTRY") throw error;
      const existing = await this.getProviderEvidenceProjection(
        input.workspaceId, input.sourceId
      );
      if (!existing || existing.targetKind !== input.targetKind
        || existing.targetId !== input.targetId
        || existing.evidenceFingerprint !== input.evidenceFingerprint
        || existing.sourceVersion !== input.sourceVersion) {
        throw new Error("cost_evidence_projection_conflict");
      }
    }
  }
}

export const financialLedgerMysqlRowParsers = Object.freeze({
  costEntry, financialFact, verificationEvent, costEstimate, estimateEvent
});
