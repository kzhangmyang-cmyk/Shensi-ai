import type mysql from "mysql2/promise";
import {
  growthMysqlDate,
  growthMysqlInstant
} from "./growth-temporal-barrier-mysql-repository.js";
import { assertConcreteGrowthWorkspaceId } from "./growth-temporal-barrier.js";

export interface ProviderRequestAccountingEvidenceRow {
  id: string;
  workspaceId: string;
  ledgerId: string;
  runId: string;
  providerId: string;
  provenance: "provider_reported" | "unknown" | "estimated";
  costAmountMajor: string;
  currency: string;
  evidenceHash: string;
  recordedAt: string;
  readonly requestHash?: string;
  readonly responseHash?: string;
  readonly normalizedResultHash?: string;
  readonly ledgerVersion?: number;
  readonly evidenceSequence?: number;
  readonly estimationMethodVersion?: string;
}

export interface ProviderRequestAccountingEvidenceSource {
  listAfter(workspaceId: string, checkpoint: {
    recordedAt: string;
    id: string;
  } | null, limit: number): Promise<ProviderRequestAccountingEvidenceRow[]>;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function safeInteger(value: unknown, code: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

export class MysqlProviderRequestAccountingEvidenceSource
implements ProviderRequestAccountingEvidenceSource {
  constructor(private readonly source: Pick<mysql.Pool, "query">) {}

  async listAfter(workspaceId: string, checkpoint: {
    recordedAt: string;
    id: string;
  } | null, limit: number): Promise<ProviderRequestAccountingEvidenceRow[]> {
    const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("invalid_provider_evidence_limit");
    }
    const checkpointAt = growthMysqlDate(checkpoint === null
      ? "1970-01-01T00:00:00.000Z" : checkpoint.recordedAt);
    const checkpointId = checkpoint === null ? "" : stringValue(
      checkpoint.id, "invalid_provider_evidence_checkpoint"
    );
    const [rows] = await this.source.query(
      `SELECT evidence.id, evidence.team_id, evidence.ledger_id,
        evidence.provenance, CAST(evidence.cost_amount AS CHAR) AS cost_amount,
        evidence.currency, evidence.evidence_hash,
        evidence.estimation_method_version, evidence.sequence_no,
        evidence.created_at, ledger.run_id, ledger.provider_code,
        ledger.request_hash, ledger.response_hash,
        ledger.normalized_result_hash, ledger.version_no
       FROM prospect_provider_request_accounting_evidence evidence
       JOIN prospect_provider_request_ledgers ledger
         ON ledger.team_id = evidence.team_id AND ledger.id = evidence.ledger_id
       WHERE evidence.team_id = ?
         AND evidence.provenance IN ('provider_reported', 'unknown', 'estimated')
         AND evidence.cost_amount IS NOT NULL
         AND (evidence.created_at > ?
           OR (evidence.created_at = ? AND evidence.id > ?))
       ORDER BY evidence.created_at ASC, evidence.id ASC
       LIMIT ?`,
      [concrete, checkpointAt, checkpointAt, checkpointId, limit]
    );
    return (rows as Record<string, unknown>[]).map((row) => {
      const rawHash = stringValue(row.evidence_hash, "invalid_provider_evidence_row");
      const evidenceHash = rawHash.startsWith("sha256:") ? rawHash : `sha256:${rawHash}`;
      if (!/^sha256:[0-9a-f]{64}$/u.test(evidenceHash)) {
        throw new Error("invalid_provider_evidence_row");
      }
      const provenance = stringValue(row.provenance, "invalid_provider_evidence_row");
      if (provenance !== "provider_reported" && provenance !== "unknown"
        && provenance !== "estimated") throw new Error("invalid_provider_evidence_row");
      return Object.freeze({
        id: stringValue(row.id, "invalid_provider_evidence_row"),
        workspaceId: assertConcreteGrowthWorkspaceId(stringValue(
          row.team_id, "invalid_provider_evidence_row"
        )),
        ledgerId: stringValue(row.ledger_id, "invalid_provider_evidence_row"),
        runId: stringValue(row.run_id, "invalid_provider_evidence_row"),
        providerId: stringValue(row.provider_code, "invalid_provider_evidence_row"),
        provenance,
        costAmountMajor: stringValue(row.cost_amount, "invalid_provider_evidence_row"),
        currency: stringValue(row.currency, "invalid_provider_evidence_row"),
        evidenceHash,
        recordedAt: growthMysqlInstant(row.created_at),
        requestHash: stringValue(row.request_hash, "invalid_provider_evidence_row"),
        responseHash: stringValue(row.response_hash, "invalid_provider_evidence_row"),
        normalizedResultHash: stringValue(
          row.normalized_result_hash, "invalid_provider_evidence_row"
        ),
        ledgerVersion: safeInteger(row.version_no, "invalid_provider_evidence_row"),
        evidenceSequence: safeInteger(row.sequence_no, "invalid_provider_evidence_row"),
        estimationMethodVersion: typeof row.estimation_method_version === "string"
          ? row.estimation_method_version : ""
      });
    });
  }
}
