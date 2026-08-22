import type {
  AuthoritativeDealDecisionRef
} from "./authoritative-quote-reader.js";
import type {
  AcquisitionCostEntry,
  FinancialFactType
} from "./financial-ledger-domain.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner,
  type GrowthTemporalTransaction,
  type GrowthTemporalBarrier,
  type GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";

export type FinanceImportKind = "acquisition_cost" | "financial_fact";

export type FinanceImportRowErrorCode =
  | "spreadsheet_formula_forbidden"
  | "verified_import_forbidden"
  | "required_field_missing"
  | "money_invalid"
  | "currency_invalid"
  | "business_time_invalid"
  | "commercial_binding_invalid"
  | "row_identity_conflict"
  | "financial_fact_conflict"
  | "financial_fact_amount_invalid"
  | "amount_out_of_range";

export type FinanceImportPublicNormalizedRow =
  | {
      kind: "acquisition_cost";
      category: AcquisitionCostEntry["category"];
      amountMinor: number;
      currency: string;
      businessOccurredAt: string;
      externalId: string | null;
      evidenceHash: string;
    }
  | {
      kind: "financial_fact";
      candidateId: string | null;
      customerId: string | null;
      dealId: string | null;
      currency: string;
      businessOccurredAt: string;
      externalId: string | null;
      evidenceHash: string;
      derivedFacts: Array<{
        factType: FinancialFactType;
        amountMinor: number;
        provenance?: "derived_from_import";
      }>;
    };

export type FinanceImportStoredNormalizedRow =
  | Extract<FinanceImportPublicNormalizedRow, { kind: "acquisition_cost" }>
  | (Extract<
        FinanceImportPublicNormalizedRow,
        { kind: "financial_fact" }
      > & {
        readonly authoritativeDecision: AuthoritativeDealDecisionRef | null;
        readonly derivationInputs?: {
          readonly revenueMinor: number | null;
          readonly grossProfitMinor: number | null;
        } | null;
      });

export interface FinanceImportPreviewRow {
  rowNumber: number;
  sheetName: string;
  status: "valid" | "invalid";
  sourceIdentityRoot: string;
  normalized: FinanceImportPublicNormalizedRow | null;
  errors: FinanceImportRowErrorCode[];
}

export interface FinanceImportStoredRow {
  readonly id: string;
  readonly previewId: string;
  readonly rowNumber: number;
  readonly sheetName: string;
  readonly status: "valid" | "invalid";
  readonly sourceIdentityRoot: string;
  readonly normalized: FinanceImportStoredNormalizedRow | null;
  readonly errors: readonly FinanceImportRowErrorCode[];
  readonly recordedAt: string;
  readonly temporalSequence: number;
}

export interface FinanceImportPreviewRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdBy: string;
  readonly previewRequestHash: string;
  readonly fileHash: string;
  readonly templateVersion: string;
  readonly kind: FinanceImportKind;
  readonly resolvedTimeZone: string;
  readonly workspaceSettingsRevision: string;
  readonly workspaceSettingsRecordedAt: string;
  readonly workspaceSettingsEventSequence: number;
  readonly validRows: number;
  readonly invalidRows: number;
  readonly authorityEffectiveAsOf: string;
  readonly authorityTemporalSequence: number;
  readonly createdAt: string;
  readonly temporalSequence: number;
}

export interface FinanceImportPreviewRecordInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdBy: string;
  readonly previewRequestHash: string;
  readonly fileHash: string;
  readonly templateVersion: string;
  readonly kind: FinanceImportKind;
  readonly resolvedTimeZone: string;
  readonly workspaceSettingsRevision: string;
  readonly workspaceSettingsRecordedAt: string;
  readonly workspaceSettingsEventSequence: number;
  readonly validRows: number;
  readonly invalidRows: number;
  readonly authorityEffectiveAsOf: string;
  readonly authorityTemporalSequence: number;
}

export interface FinanceImportStoredRowInput {
  readonly id: string;
  readonly previewId: string;
  readonly rowNumber: number;
  readonly sheetName: string;
  readonly status: "valid" | "invalid";
  readonly sourceIdentityRoot: string;
  readonly normalized: FinanceImportStoredNormalizedRow | null;
  readonly errors: readonly FinanceImportRowErrorCode[];
}

export interface FinanceImportOperation {
  readonly id: string;
  readonly previewId: string;
  readonly workspaceId: string;
  readonly requestingActorId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly previewRequestHash: string;
  readonly fileHash: string;
  readonly templateVersion: string;
  status: "queued" | "running" | "succeeded" | "partial_success" | "failed";
  validRows: number;
  invalidRows: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  resultCreatedIds: string[];
  lastErrorCode: string | null;
  createdAt: string;
  createdTemporalSequence: number;
  updatedAt: string;
  temporalSequence: number;
}

export interface FinanceImportOperationInput {
  readonly id: string;
  readonly previewId: string;
  readonly workspaceId: string;
  readonly requestingActorId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly previewRequestHash: string;
  readonly fileHash: string;
  readonly templateVersion: string;
  readonly status: FinanceImportOperation["status"];
  readonly validRows: number;
  readonly invalidRows: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly fencingToken: number;
  readonly resultCreatedIds: readonly string[];
  readonly lastErrorCode: string | null;
}

export interface FinanceImportClaim {
  workspaceId: string;
  operationId: string;
  leaseOwner: string;
  leaseExpiresAt: string;
  fencingToken: number;
}

export interface FinanceImportRowResult {
  rowId: string;
  status: "created" | "replayed";
  createdLedgerIds: string[];
}

export interface FinanceImportOperationEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly eventType:
    | "queued"
    | "claimed"
    | "renewed"
    | "row_saved"
    | "completed"
    | "failed";
  readonly eventSequence: number;
  readonly revision: number;
  readonly leaseOwner: string | null;
  readonly fencingToken: number;
  readonly recordedAt: string;
  readonly temporalSequence: number;
}

export interface FinanceImportRepository {
  getPreview(
    previewId: string
  ): Promise<FinanceImportPreviewRecord | null>;
  appendPreview(
    record: FinanceImportPreviewRecordInput,
    rows: readonly FinanceImportStoredRowInput[]
  ): Promise<FinanceImportPreviewRecord>;
  getStoredRow(
    previewId: string,
    rowNumber: number
  ): Promise<FinanceImportStoredRow | null>;
  listStoredRows(previewId: string): Promise<FinanceImportStoredRow[]>;
  getOperation(operationId: string): Promise<FinanceImportOperation | null>;
  appendOperation(
    input: FinanceImportOperationInput
  ): Promise<FinanceImportOperation>;
}

export interface FinanceImportExecutionRepository
extends FinanceImportRepository {
  listRecoverable(now: string, limit: number): Promise<FinanceImportOperation[]>;
  claim(
    operationId: string,
    workerId: string,
    now: string,
    leaseExpiresAt: string
  ): Promise<FinanceImportClaim | null>;
  assertLiveClaim(claim: FinanceImportClaim, now: string): Promise<void>;
  renewLease(input: {
    operationId: string;
    leaseOwner: string;
    fencingToken: number;
    now: string;
    nextExpiry: string;
  }): Promise<boolean>;
  saveRowResult(
    claim: FinanceImportClaim,
    result: FinanceImportRowResult,
    now: string
  ): Promise<void>;
  complete(
    claim: FinanceImportClaim,
    result: { status: "succeeded" | "partial_success"; createdIds: string[] },
    now: string
  ): Promise<void>;
  fail(claim: FinanceImportClaim, errorCode: string, now: string): Promise<void>;
  listValidRows(operationId: string): Promise<FinanceImportStoredRow[]>;
  listRowResults(operationId: string): Promise<FinanceImportRowResult[]>;
  listOperationEvents(operationId: string): Promise<FinanceImportOperationEvent[]>;
}

function immutablePreviewRecord(
  record: FinanceImportPreviewRecord
): FinanceImportPreviewRecord {
  return Object.freeze({ ...record });
}

function immutableStoredRow(
  row: FinanceImportStoredRow
): FinanceImportStoredRow {
  return Object.freeze({
    ...row,
    errors: Object.freeze([...row.errors]),
    normalized: row.normalized === null
      ? null
      : Object.freeze(row.normalized)
  });
}

function immutableOperation(
  operation: FinanceImportOperation
): FinanceImportOperation {
  return Object.freeze({
    ...operation,
    resultCreatedIds: [...operation.resultCreatedIds]
  });
}

export class InMemoryFinanceImportRepository
implements FinanceImportExecutionRepository {
  private readonly transactions: GrowthTemporalTransactionRunner;
  private readonly barrier: GrowthTemporalBarrier;
  private readonly previews = new Map<string, FinanceImportPreviewRecord>();
  private readonly rows = new Map<string, FinanceImportStoredRow>();
  private readonly operations = new Map<string, FinanceImportOperation>();
  private readonly rowResults = new Map<string, FinanceImportRowResult[]>();
  private readonly operationEvents = new Map<string, FinanceImportOperationEvent[]>();
  private readonly writeLockTraces: string[][] = [];
  readonly savedRowFences: number[] = [];

  constructor(
    temporalTransactions?: GrowthTemporalTransactionRunner,
    temporalBarrier?: GrowthTemporalBarrier
  ) {
    this.transactions = temporalTransactions
      ?? new InMemoryGrowthTemporalTransactionRunner();
    this.barrier = temporalBarrier
      ?? new DefaultGrowthTemporalBarrier(this.transactions);
  }

  async getPreview(previewId: string): Promise<FinanceImportPreviewRecord | null> {
    return this.previews.get(previewId) ?? null;
  }

  async appendPreview(
    record: FinanceImportPreviewRecordInput,
    rows: readonly FinanceImportStoredRowInput[]
  ): Promise<FinanceImportPreviewRecord> {
    const stored = await this.transactions.run(async (tx) => {
      const previewStamp = await this.barrier.allocateAppend(
        tx, record.workspaceId
      );
      if (this.previews.has(record.id)) {
        throw new Error("finance_import_preview_exists");
      }
      const preview = immutablePreviewRecord({
        ...record,
        createdAt: previewStamp.recordedAt,
        temporalSequence: previewStamp.temporalSequence
      });
      const storedRows: FinanceImportStoredRow[] = [];
      for (const row of rows) {
        const stamp = await this.barrier.allocateAppend(
          tx, record.workspaceId
        );
        storedRows.push(immutableStoredRow({
          ...row,
          recordedAt: stamp.recordedAt,
          temporalSequence: stamp.temporalSequence
        }));
      }
      return { preview, storedRows };
    });
    this.previews.set(stored.preview.id, stored.preview);
    for (const row of stored.storedRows) {
      this.rows.set(`${row.previewId}\u0000${row.rowNumber}`, row);
    }
    return stored.preview;
  }

  async getStoredRow(
    previewId: string,
    rowNumber: number
  ): Promise<FinanceImportStoredRow | null> {
    return this.rows.get(`${previewId}\u0000${rowNumber}`) ?? null;
  }

  async listStoredRows(previewId: string): Promise<FinanceImportStoredRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.previewId === previewId)
      .sort((left, right) => left.rowNumber - right.rowNumber);
  }

  async getOperation(
    operationId: string
  ): Promise<FinanceImportOperation | null> {
    return this.operations.get(operationId) ?? null;
  }

  async appendOperation(
    input: FinanceImportOperationInput
  ): Promise<FinanceImportOperation> {
    const stamps = await this.transactions.run(async (tx) => {
      const trace = [`temporal:${input.workspaceId}`];
      this.writeLockTraces.push(trace);
      const allocated = await this.barrier.allocateAppend(
        tx, input.workspaceId
      );
      if (this.operations.has(input.id)) {
        throw new Error("finance_import_operation_exists");
      }
      const eventStamp = await this.barrier.allocateAppend(
        tx, input.workspaceId
      );
      return { allocated, eventStamp };
    });
    const operation = immutableOperation({
      ...input,
      resultCreatedIds: [...input.resultCreatedIds],
      createdAt: stamps.allocated.recordedAt,
      createdTemporalSequence: stamps.allocated.temporalSequence,
      updatedAt: stamps.allocated.recordedAt,
      temporalSequence: stamps.allocated.temporalSequence
    });
    this.operations.set(operation.id, operation);
    this.appendEvent(operation, "queued", null, 0, stamps.eventStamp);
    return operation;
  }

  private appendEvent(
    operation: FinanceImportOperation,
    eventType: FinanceImportOperationEvent["eventType"],
    leaseOwner: string | null,
    fencingToken: number,
    stamp: { recordedAt: string; temporalSequence: number }
  ): void {
    const events = this.operationEvents.get(operation.id) ?? [];
    const eventSequence = events.length + 1;
    const event: FinanceImportOperationEvent = Object.freeze({
      id: `${operation.id}:${eventType}:${eventSequence}`,
      workspaceId: operation.workspaceId,
      operationId: operation.id,
      eventType,
      eventSequence,
      revision: eventSequence,
      leaseOwner,
      fencingToken,
      recordedAt: stamp.recordedAt,
      temporalSequence: stamp.temporalSequence
    });
    events.push(event);
    this.operationEvents.set(operation.id, events);
  }

  async listRecoverable(
    now: string,
    limit: number
  ): Promise<FinanceImportOperation[]> {
    return [...this.operations.values()]
      .filter((operation) => operation.status === "queued"
        || (operation.status === "running"
          && operation.leaseExpiresAt !== null
          && operation.leaseExpiresAt <= now))
      .sort((left, right) =>
        left.updatedAt.localeCompare(right.updatedAt)
        || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  async claim(
    operationId: string,
    workerId: string,
    now: string,
    leaseExpiresAt: string
  ): Promise<FinanceImportClaim | null> {
    const result = await this.transactions.run(async (tx) => {
      const operation = this.operations.get(operationId);
      if (!operation) return null;
      const trace = [`temporal:${operation.workspaceId}`];
      this.writeLockTraces.push(trace);
      const stamp = await this.barrier.allocateAppend(
        tx, operation.workspaceId
      );
      const current = this.operations.get(operationId)!;
      const claimable = current.status === "queued"
        || (current.status === "running"
          && current.leaseExpiresAt !== null
          && current.leaseExpiresAt <= now);
      if (!claimable) return null;
      const next = immutableOperation({
        ...current,
        status: "running",
        leaseOwner: workerId,
        leaseExpiresAt,
        fencingToken: current.fencingToken + 1,
        updatedAt: stamp.recordedAt,
        temporalSequence: stamp.temporalSequence
      });
      this.operations.set(operationId, next);
      const eventStamp = await this.barrier.allocateAppend(
        tx, operation.workspaceId
      );
      return { next, eventStamp };
    });
    if (!result) return null;
    this.appendEvent(
      result.next, "claimed", workerId, result.next.fencingToken,
      result.eventStamp
    );
    return Object.freeze({
      workspaceId: result.next.workspaceId,
      operationId: result.next.id,
      leaseOwner: result.next.leaseOwner!,
      leaseExpiresAt: result.next.leaseExpiresAt!,
      fencingToken: result.next.fencingToken
    });
  }

  private async withLiveClaim(
    claim: FinanceImportClaim,
    now: string,
    work: (
      operation: FinanceImportOperation,
      tx: GrowthTemporalTransaction,
      stamp: { recordedAt: string; temporalSequence: number }
    ) => Promise<void>
  ): Promise<void> {
    await this.transactions.run(async (tx) => {
      const trace = [`temporal:${claim.workspaceId}`];
      this.writeLockTraces.push(trace);
      const stamp = await this.barrier.allocateAppend(
        tx, claim.workspaceId
      );
      const current = this.operations.get(claim.operationId);
      if (!current
        || current.workspaceId !== claim.workspaceId
        || current.leaseOwner !== claim.leaseOwner
        || current.fencingToken !== claim.fencingToken
        || current.status !== "running"
        || current.leaseExpiresAt === null
        || current.leaseExpiresAt <= now) {
        throw new Error("stale_fencing_token");
      }
      await work(current, tx, stamp);
    });
  }

  async assertLiveClaim(
    claim: FinanceImportClaim,
    now: string
  ): Promise<void> {
    const current = this.operations.get(claim.operationId);
    if (!current
      || current.workspaceId !== claim.workspaceId
      || current.leaseOwner !== claim.leaseOwner
      || current.fencingToken !== claim.fencingToken
      || current.status !== "running"
      || current.leaseExpiresAt === null
      || current.leaseExpiresAt <= now) {
      throw new Error("stale_fencing_token");
    }
  }

  async renewLease(input: {
    operationId: string;
    leaseOwner: string;
    fencingToken: number;
    now: string;
    nextExpiry: string;
  }): Promise<boolean> {
    let changed = false;
    let renewed: FinanceImportOperation | null = null;
    let eventStamp: { recordedAt: string; temporalSequence: number } | null =
      null;
    await this.transactions.run(async (tx) => {
      const current = this.operations.get(input.operationId);
      if (!current
        || current.leaseOwner !== input.leaseOwner
        || current.fencingToken !== input.fencingToken
        || current.status !== "running"
        || current.leaseExpiresAt === null
        || current.leaseExpiresAt <= input.now) {
        return;
      }
      const trace = [`temporal:${current.workspaceId}`];
      this.writeLockTraces.push(trace);
      const stamp = await this.barrier.allocateAppend(
        tx, current.workspaceId
      );
      renewed = immutableOperation({
        ...current,
        leaseExpiresAt: input.nextExpiry,
        updatedAt: stamp.recordedAt,
        temporalSequence: stamp.temporalSequence
      });
      this.operations.set(input.operationId, renewed);
      eventStamp = await this.barrier.allocateAppend(
        tx, current.workspaceId
      );
      changed = true;
    });
    if (changed && renewed && eventStamp) {
      this.appendEvent(
        renewed, "renewed", input.leaseOwner, input.fencingToken, eventStamp
      );
    }
    return changed;
  }

  async saveRowResult(
    claim: FinanceImportClaim,
    result: FinanceImportRowResult,
    now: string
  ): Promise<void> {
    let operation: FinanceImportOperation | null = null;
    let eventStamp: { recordedAt: string; temporalSequence: number } | null =
      null;
    await this.withLiveClaim(claim, now, async (current, tx) => {
      this.savedRowFences.push(claim.fencingToken);
      const results = this.rowResults.get(claim.operationId) ?? [];
      if (!results.some((item) => item.rowId === result.rowId)) {
        results.push(Object.freeze({
          ...result,
          createdLedgerIds: [...result.createdLedgerIds]
        }));
        this.rowResults.set(claim.operationId, results);
      }
      const eventStampAllocated = await this.barrier.allocateAppend(
        tx, claim.workspaceId
      );
      eventStamp = eventStampAllocated;
      operation = current;
    });
    if (operation && eventStamp) {
      this.appendEvent(
        operation, "row_saved", claim.leaseOwner, claim.fencingToken,
        eventStamp
      );
    }
  }

  async complete(
    claim: FinanceImportClaim,
    result: { status: "succeeded" | "partial_success"; createdIds: string[] },
    now: string
  ): Promise<void> {
    let operation: FinanceImportOperation | null = null;
    let eventStamp: { recordedAt: string; temporalSequence: number } | null =
      null;
    await this.withLiveClaim(claim, now, async (current, tx, stamp) => {
      const next = immutableOperation({
        ...current,
        status: result.status,
        resultCreatedIds: [...result.createdIds],
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: stamp.recordedAt,
        temporalSequence: stamp.temporalSequence
      });
      this.operations.set(claim.operationId, next);
      eventStamp = await this.barrier.allocateAppend(
        tx, claim.workspaceId
      );
      operation = next;
    });
    if (operation && eventStamp) {
      this.appendEvent(
        operation, "completed", null, claim.fencingToken, eventStamp
      );
    }
  }

  async fail(
    claim: FinanceImportClaim,
    errorCode: string,
    now: string
  ): Promise<void> {
    let operation: FinanceImportOperation | null = null;
    let eventStamp: { recordedAt: string; temporalSequence: number } | null =
      null;
    await this.withLiveClaim(claim, now, async (current, tx, stamp) => {
      const next = immutableOperation({
        ...current,
        status: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: errorCode,
        updatedAt: stamp.recordedAt,
        temporalSequence: stamp.temporalSequence
      });
      this.operations.set(claim.operationId, next);
      eventStamp = await this.barrier.allocateAppend(
        tx, claim.workspaceId
      );
      operation = next;
    });
    if (operation && eventStamp) {
      this.appendEvent(
        operation, "failed", null, claim.fencingToken, eventStamp
      );
    }
  }

  async listValidRows(operationId: string): Promise<FinanceImportStoredRow[]> {
    const operation = this.operations.get(operationId);
    if (!operation) return [];
    return (await this.listStoredRows(operation.previewId))
      .filter((row) => row.status === "valid");
  }

  async listRowResults(
    operationId: string
  ): Promise<FinanceImportRowResult[]> {
    return [...(this.rowResults.get(operationId) ?? [])];
  }

  async listOperationEvents(
    operationId: string
  ): Promise<FinanceImportOperationEvent[]> {
    return [...(this.operationEvents.get(operationId) ?? [])];
  }

  writeLockTracesSnapshot(): string[][] {
    return this.writeLockTraces.map((trace) => [...trace]);
  }

  replaceOperationPreviewId(
    operationId: string,
    previewId: string
  ): void {
    const current = this.operations.get(operationId);
    if (!current) throw new Error("finance_import_operation_not_found");
    this.operations.set(operationId, immutableOperation({
      ...current,
      previewId
    }));
  }

  countPreviews(): number {
    return this.previews.size;
  }

  countStoredRows(): number {
    return this.rows.size;
  }

  countOperations(): number {
    return this.operations.size;
  }

  countOperationsFor(previewId: string): number {
    return [...this.operations.values()]
      .filter((operation) => operation.previewId === previewId).length;
  }

  seedPreview(
    record: FinanceImportPreviewRecordInput,
    rows: readonly FinanceImportStoredRowInput[]
  ): FinanceImportPreviewRecord {
    const preview = immutablePreviewRecord({
      ...record,
      createdAt: record.authorityEffectiveAsOf,
      temporalSequence: record.authorityTemporalSequence
    });
    this.previews.set(preview.id, preview);
    for (const row of rows) {
      this.rows.set(`${row.previewId}\u0000${row.rowNumber}`, immutableStoredRow({
        ...row,
        recordedAt: record.authorityEffectiveAsOf,
        temporalSequence: record.authorityTemporalSequence
      }));
    }
    return preview;
  }
}
