import type mysql from "mysql2/promise";
import {
  projectVerifiedCost,
  projectVerifiedFinancialFact,
  type VerifiedCostLedgerRow,
  type VerifiedFinancialFactLedgerRow,
  type WorkspaceVerifiedFinancialLedgerSealedReader,
  type VerifiedLedgerRow
} from "./financial-ledger-as-of-reader.js";
import { ledgerEntryStatus, type LedgerType } from "./financial-ledger-domain.js";
import { financialLedgerMysqlRowParsers } from "./financial-ledger-mysql-repository.js";
import {
  assertGrowthSealedReadCutoff,
  type GrowthSealedReadCutoff
} from "./growth-temporal-barrier.js";
import { growthMysqlDate } from "./growth-temporal-barrier-mysql-repository.js";

type MysqlRow = Record<string, unknown>;
const MAX_ENUMERATION_CANDIDATES = 500;

function concreteText(value: string, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function boundedEntryIds(entryIds: readonly string[]): readonly string[] {
  if (!Array.isArray(entryIds) || entryIds.length > 500) {
    throw new Error("invalid_ledger_entry_ids");
  }
  const normalized = entryIds.map((id) => concreteText(id, "invalid_ledger_entry_ids"));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("invalid_ledger_entry_ids");
  }
  return normalized;
}

function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("invalid_ledger_limit");
  }
  return limit;
}

function stableRows<T extends VerifiedLedgerRow>(rows: T[]): readonly T[] {
  return Object.freeze(rows.sort((left, right) =>
    Date.parse(left.businessOccurredAt) - Date.parse(right.businessOccurredAt)
    || left.entryId.localeCompare(right.entryId)));
}

export class MysqlVerifiedFinancialLedgerSealedReader
implements WorkspaceVerifiedFinancialLedgerSealedReader {
  constructor(private readonly source: Pick<mysql.Pool | mysql.PoolConnection, "query">) {}

  private trusted(cutoff: GrowthSealedReadCutoff): GrowthSealedReadCutoff {
    if (!cutoff || typeof cutoff.workspaceId !== "string") {
      throw new Error("invalid_growth_sealed_read_cutoff");
    }
    return assertGrowthSealedReadCutoff(cutoff, cutoff.workspaceId);
  }

  private async entry(
    cutoff: GrowthSealedReadCutoff,
    ledgerType: LedgerType,
    entryId: string,
    currency: string
  ) {
    const table = ledgerType === "cost" ? "acquisition_cost_entries" : "financial_facts";
    const [rows] = await this.source.query(
      `SELECT * FROM ${table}
       WHERE workspace_id = ? AND id = ? AND currency = ? AND amount_minor <> 0
         AND business_occurred_at <= ? AND recorded_at <= ?
         AND temporal_sequence <= ?`,
      [cutoff.workspaceId, entryId, currency, growthMysqlDate(cutoff.effectiveAsOf),
        growthMysqlDate(cutoff.effectiveAsOf), cutoff.temporalSequence]
    );
    const row = (rows as MysqlRow[])[0];
    if (!row) return null;
    return ledgerType === "cost"
      ? financialLedgerMysqlRowParsers.costEntry(row)
      : financialLedgerMysqlRowParsers.financialFact(row);
  }

  private async verifiedEvent(
    cutoff: GrowthSealedReadCutoff,
    ledgerType: LedgerType,
    entryId: string
  ) {
    const [rows] = await this.source.query(
      `SELECT * FROM ledger_verification_events
       WHERE workspace_id = ? AND ledger_type = ? AND ledger_entry_id = ?
         AND recorded_at <= ? AND temporal_sequence <= ?
       ORDER BY event_sequence ASC, revision ASC`,
      [cutoff.workspaceId, ledgerType, entryId,
        growthMysqlDate(cutoff.effectiveAsOf), cutoff.temporalSequence]
    );
    const events = (rows as MysqlRow[]).map(
      financialLedgerMysqlRowParsers.verificationEvent
    );
    if (ledgerEntryStatus(events) !== "verified") return null;
    return events.find((event) => event.eventType === "verified") ?? null;
  }

  async getVerifiedAt(cutoff: GrowthSealedReadCutoff, input: {
    ledgerType: "cost" | "financial";
    entryId: string;
    currency: string;
  }): Promise<VerifiedLedgerRow | null> {
    const trusted = this.trusted(cutoff);
    const entryId = concreteText(input.entryId, "invalid_ledger_entry_id");
    const currency = concreteText(input.currency, "invalid_currency");
    if (input.ledgerType !== "cost" && input.ledgerType !== "financial") {
      throw new Error("invalid_ledger_type");
    }
    const entry = await this.entry(trusted, input.ledgerType, entryId, currency);
    if (!entry) return null;
    const event = await this.verifiedEvent(trusted, input.ledgerType, entryId);
    if (!event) return null;
    return input.ledgerType === "cost"
      ? projectVerifiedCost(entry as Parameters<typeof projectVerifiedCost>[0], event)
      : projectVerifiedFinancialFact(
        entry as Parameters<typeof projectVerifiedFinancialFact>[0], event
      );
  }

  async listVerifiedCostsAt(cutoff: GrowthSealedReadCutoff, input: {
    currency: string;
    entryIds: readonly string[];
  }): Promise<readonly VerifiedCostLedgerRow[]> {
    const trusted = this.trusted(cutoff);
    const currency = concreteText(input.currency, "invalid_currency");
    const rows = await Promise.all(boundedEntryIds(input.entryIds).map(async (entryId) => {
      const row = await this.getVerifiedAt(trusted, {
        ledgerType: "cost", entryId, currency
      });
      return row?.ledgerType === "cost" ? row : null;
    }));
    return stableRows(rows.filter((row): row is VerifiedCostLedgerRow => row !== null));
  }

  async listVerifiedFactsAt(cutoff: GrowthSealedReadCutoff, input: {
    currency: string;
    entryIds: readonly string[];
  }): Promise<readonly VerifiedFinancialFactLedgerRow[]> {
    const trusted = this.trusted(cutoff);
    const currency = concreteText(input.currency, "invalid_currency");
    const rows = await Promise.all(boundedEntryIds(input.entryIds).map(async (entryId) => {
      const row = await this.getVerifiedAt(trusted, {
        ledgerType: "financial", entryId, currency
      });
      return row?.ledgerType === "financial" ? row : null;
    }));
    return stableRows(rows.filter(
      (row): row is VerifiedFinancialFactLedgerRow => row !== null
    ));
  }

  async listWorkspaceVerifiedFactsAt(cutoff: GrowthSealedReadCutoff, input: {
    currency: string;
    limit: number;
  }): Promise<readonly VerifiedFinancialFactLedgerRow[]> {
    const trusted = this.trusted(cutoff);
    const currency = concreteText(input.currency, "invalid_currency");
    const limit = boundedLimit(input.limit);
    const [candidateRows] = await this.source.query(
      `SELECT * FROM financial_facts
       WHERE workspace_id = ? AND currency = ? AND amount_minor <> 0
         AND business_occurred_at <= ? AND recorded_at <= ?
         AND temporal_sequence <= ?
       ORDER BY business_occurred_at ASC, id ASC
       LIMIT ?`,
      [trusted.workspaceId, currency,
        growthMysqlDate(trusted.effectiveAsOf),
        growthMysqlDate(trusted.effectiveAsOf), trusted.temporalSequence,
        MAX_ENUMERATION_CANDIDATES + 1]
    );
    const candidates = candidateRows as MysqlRow[];
    if (candidates.length > MAX_ENUMERATION_CANDIDATES) {
      throw new Error("verified_financial_fact_query_truncated");
    }
    const verified = await Promise.all(candidates.map(async (candidate) => {
      const entry = financialLedgerMysqlRowParsers.financialFact(candidate);
      const event = await this.verifiedEvent(
        trusted, "financial", entry.id
      );
      return event ? projectVerifiedFinancialFact(entry, event) : null;
    }));
    return Object.freeze(stableRows(verified.filter(
      (row): row is VerifiedFinancialFactLedgerRow => row !== null
    )).slice(0, limit));
  }
}
