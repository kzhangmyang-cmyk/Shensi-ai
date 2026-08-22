import { randomUUID } from "node:crypto";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import {
  GrowthHttpError,
  type CommandContext
} from "./growth-command-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import {
  canonicalGrowthRequestHash,
  executeGrowthIdempotentCommand
} from "./growth-http-idempotency-repository.js";
import type { AcquisitionCostLedgerService } from "./acquisition-cost-ledger.js";
import type { FinancialFactLedgerService } from "./financial-fact-ledger.js";
import { deriveRevenueAndCogs } from "./financial-fact-ledger.js";
import type {
  AuthoritativeDealDecisionRef,
  DealAuthoritativeQuoteReader
} from "./authoritative-quote-reader.js";
import type { CommercialBindingVerifier } from "./commercial-binding-snapshot.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { GrowthSealedReadCutoff } from "./growth-temporal-barrier.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  costSourceIdentityRoot,
  financialSourceIdentityRoot,
  type FinancialFactType
} from "./financial-ledger-domain.js";
import {
  type FinanceImportClaim,
  type FinanceImportExecutionRepository,
  type FinanceImportOperation,
  type FinanceImportPreviewRecord,
  type FinanceImportRowResult,
  type FinanceImportStoredRow
} from "./finance-import-repository.js";
import {
  FinanceImportError
} from "./finance-import-service.js";

export interface FinanceImportWorkerDependencies {
  repository: FinanceImportExecutionRepository;
  foundation: GrowthFoundationServices;
  costLedger: AcquisitionCostLedgerService;
  financialFactLedger: Pick<
    FinancialFactLedgerService,
    "createPendingAt"
  >;
  bindingVerifier: Pick<CommercialBindingVerifier, "verify">;
  dealQuoteReader: Pick<DealAuthoritativeQuoteReader, "getDecisionAt">;
  now?: () => string;
  leaseDurationMs?: number;
  ids?: { next(): string };
}

export interface FinanceImportWorkerLike {
  claim(
    operationId: string,
    workerId: string,
    now: string
  ): Promise<FinanceImportClaim | null>;
  heartbeat(claim: FinanceImportClaim, now: string): Promise<FinanceImportClaim>;
  commit(
    context: CommandContext,
    claim: FinanceImportClaim
  ): Promise<{
    status: "succeeded" | "partial_success";
    createdIds: string[];
    replayed: boolean;
  }>;
  run(input: {
    operationId: string;
    workerId: string;
    authorize(operation: FinanceImportOperation): Promise<CommandContext>;
  }): Promise<{
    status: "succeeded" | "partial_success";
    createdIds: string[];
    replayed: boolean;
  }>;
  fail(claim: FinanceImportClaim, errorCode: string, now: string): Promise<void>;
  close(): Promise<void>;
}

export interface FinanceImportRecoveryAuthorizer {
  commandFor(operation: Readonly<FinanceImportOperation>): Promise<CommandContext>;
}

export async function assertFinanceImportAuthority(
  context: CommandContext,
  operation: Readonly<FinanceImportOperation>,
  repository: FinanceImportExecutionRepository
): Promise<FinanceImportPreviewRecord> {
  if (context.workspace.workspaceId !== operation.workspaceId
    || context.actorId !== operation.requestingActorId
    || context.idempotencyKey !== operation.idempotencyKey
    || context.requestHash !== operation.requestHash) {
    throw new FinanceImportError("finance_import_authority_mismatch", 403);
  }
  const preview = await repository.getPreview(operation.previewId);
  if (!preview
    || preview.id !== operation.previewId
    || preview.workspaceId !== operation.workspaceId
    || preview.createdBy !== operation.requestingActorId
    || preview.previewRequestHash !== operation.previewRequestHash
    || preview.fileHash !== operation.fileHash
    || preview.templateVersion !== operation.templateVersion) {
    throw new FinanceImportError("finance_import_preview_mismatch", 409);
  }
  return preview;
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

class FinanceImportLeaseHeartbeat {
  private claim: FinanceImportClaim;
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewal: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private stopped = false;

  constructor(private readonly options: {
    initialClaim: FinanceImportClaim;
    intervalMs: number;
    now(): string;
    renew(claim: FinanceImportClaim, now: string): Promise<FinanceImportClaim>;
  }) {
    this.claim = options.initialClaim;
  }

  start(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = setInterval(() => {
      this.renewal = this.renewal.then(async () => {
        if (this.failure !== null) return;
        try {
          this.claim = await this.options.renew(
            this.claim, this.options.now()
          );
        } catch (error) {
          this.failure = error;
        }
      });
    }, this.options.intervalMs);
  }

  async requireLive(now: string): Promise<FinanceImportClaim> {
    await this.renewal;
    if (this.failure !== null) throw this.failure;
    if (this.claim.leaseExpiresAt <= now) {
      throw new FinanceImportError("stale_fencing_token", 409);
    }
    return this.claim;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.renewal;
  }
}

export class FinanceImportWorker implements FinanceImportWorkerLike {
  private readonly repository: FinanceImportExecutionRepository;
  private readonly foundation: GrowthFoundationServices;
  private readonly costLedger: AcquisitionCostLedgerService;
  private readonly financialFactLedger: FinanceImportWorkerDependencies[
    "financialFactLedger"
  ];
  private readonly bindingVerifier: Pick<CommercialBindingVerifier, "verify">;
  private readonly dealQuoteReader: Pick<
    DealAuthoritativeQuoteReader,
    "getDecisionAt"
  >;
  private readonly now: () => string;
  private readonly leaseDurationMs: number;
  private readonly ids: { next(): string };
  private readonly activeRuns = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly dependencies: FinanceImportWorkerDependencies) {
    this.repository = dependencies.repository;
    this.foundation = dependencies.foundation;
    this.costLedger = dependencies.costLedger;
    this.financialFactLedger = dependencies.financialFactLedger;
    this.bindingVerifier = dependencies.bindingVerifier;
    this.dealQuoteReader = dependencies.dealQuoteReader;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.leaseDurationMs = dependencies.leaseDurationMs ?? 5 * 60_000;
    this.ids = dependencies.ids ?? { next: randomUUID };
  }

  async claim(
    operationId: string,
    workerId: string,
    now: string
  ): Promise<FinanceImportClaim | null> {
    return this.repository.claim(
      operationId,
      workerId,
      now,
      addMilliseconds(now, this.leaseDurationMs)
    );
  }

  async heartbeat(
    claim: FinanceImportClaim,
    now: string
  ): Promise<FinanceImportClaim> {
    const nextExpiry = addMilliseconds(now, this.leaseDurationMs);
    const changed = await this.repository.renewLease({
      operationId: claim.operationId,
      leaseOwner: claim.leaseOwner,
      fencingToken: claim.fencingToken,
      now,
      nextExpiry
    });
    if (!changed) throw new FinanceImportError("stale_fencing_token", 409);
    return Object.freeze({ ...claim, leaseExpiresAt: nextExpiry });
  }

  async fail(
    claim: FinanceImportClaim,
    errorCode: string,
    now: string
  ): Promise<void> {
    await this.repository.fail(claim, errorCode, now);
  }

  async commit(
    context: CommandContext,
    claim: FinanceImportClaim
  ): Promise<{
    status: "succeeded" | "partial_success";
    createdIds: string[];
    replayed: boolean;
  }> {
    if (this.closed) {
      throw new FinanceImportError("finance_import_worker_closed", 409);
    }
    const operation = await this.repository.getOperation(claim.operationId);
    if (!operation) {
      throw new FinanceImportError("finance_import_not_found", 404);
    }
    await assertFinanceImportAuthority(
      context, operation, this.repository
    );
    if (operation.status === "succeeded"
      || operation.status === "partial_success") {
      return {
        status: operation.status,
        createdIds: [...operation.resultCreatedIds],
        replayed: true
      };
    }
    await this.repository.assertLiveClaim(claim, this.now());
    return this.commitRows(context, operation, claim);
  }

  private async commitRows(
    context: CommandContext,
    operation: FinanceImportOperation,
    initialClaim: FinanceImportClaim
  ): Promise<{
    status: "succeeded" | "partial_success";
    createdIds: string[];
    replayed: boolean;
  }> {
    const heartbeat = new FinanceImportLeaseHeartbeat({
      initialClaim,
      intervalMs: Math.floor(this.leaseDurationMs / 3),
      now: this.now,
      renew: (claim, now) => this.heartbeat(claim, now)
    });
    heartbeat.start();
    const createdIds: string[] = [];
    try {
      const commitStartedAt = this.now();
      const cutoff = await this.foundation.temporalBarrier.sealReadCutoff(
        context.workspace, commitStartedAt
      );
      const rows = await this.repository.listValidRows(operation.id);
      for (const row of rows) {
        const liveClaim = await heartbeat.requireLive(this.now());
        const rowResult = await this.createLedgerRowsWithStableIdentity({
          context,
          operation,
          row,
          cutoff
        });
        const liveClaimAfter = await heartbeat.requireLive(this.now());
        await this.repository.saveRowResult(
          liveClaimAfter, rowResult, this.now()
        );
        createdIds.push(...rowResult.createdLedgerIds);
      }
      const liveClaim = await heartbeat.requireLive(this.now());
      const result = {
        status: operation.invalidRows === 0
          ? "succeeded" as const
          : "partial_success" as const,
        createdIds
      };
      await this.repository.complete(liveClaim, result, this.now());
      return { ...result, replayed: false };
    } finally {
      await heartbeat.stop();
    }
  }

  private async createLedgerRowsWithStableIdentity(input: {
    context: CommandContext;
    operation: FinanceImportOperation;
    row: FinanceImportStoredRow;
    cutoff: GrowthSealedReadCutoff;
  }): Promise<FinanceImportRowResult> {
    const { context, operation, row } = input;
    const normalized = row.normalized;
    if (!normalized) {
      throw new FinanceImportError("finance_import_row_invalid", 409);
    }
    const rowContext: CommandContext = Object.freeze({
      workspace: context.workspace,
      actorId: operation.requestingActorId,
      idempotencyKey: `finance-import:${operation.id}:${row.id}`,
      requestHash: canonicalGrowthRequestHash({
        operationId: operation.id,
        rowId: row.id,
        sourceIdentityRoot: row.sourceIdentityRoot
      }),
      expectedRevision: null
    });
    const createdLedgerIds: string[] = [];
    let replayed = false;
    if (normalized.kind === "acquisition_cost") {
      const created = await this.costLedger.createPending(rowContext, {
        platform: "import",
        planId: null,
        runId: null,
        providerId: null,
        category: normalized.category,
        amountMinor: normalized.amountMinor,
        currency: normalized.currency,
        businessOccurredAt: normalized.businessOccurredAt,
        provenance: "portal_export",
        sourceRef: null,
        evidenceHash: normalized.evidenceHash,
        externalId: normalized.externalId,
        sourceIdentityRoot: costSourceIdentityRoot({
          kind: "import_row",
          fileHash: operation.fileHash,
          sheetName: row.sheetName,
          rowNumber: row.rowNumber
        }),
        estimateReconciliationId: null
      });
      createdLedgerIds.push(created.entry.id);
    } else {
      await this.assertRowAuthorityUnchanged(
        context, operation, row, input.cutoff
      );
      let derivedFacts = normalized.derivedFacts;
      if (normalized.derivationInputs) {
        const derived = deriveRevenueAndCogs(normalized.derivationInputs);
        if (!derived) {
          throw new FinanceImportError(
            "financial_fact_amount_invalid", 422
          );
        }
        derivedFacts = [{
          factType: "revenue_recognized",
          amountMinor: derived.revenueMinor
        }];
        if (derived.cogsMinor !== null) {
          derivedFacts.push({
            factType: "cogs_recognized",
            amountMinor: derived.cogsMinor,
            provenance: "derived_from_import"
          });
        }
      }
      for (const derivedFact of derivedFacts) {
        const factInput = {
          candidateId: normalized.candidateId,
          customerId: normalized.customerId,
          dealId: normalized.dealId,
          factType: derivedFact.factType as FinancialFactType,
          amountMinor: derivedFact.amountMinor,
          currency: normalized.currency,
          businessOccurredAt: normalized.businessOccurredAt,
          provenance: "derived_from_import",
          sourceRef: null,
          evidenceHash: normalized.evidenceHash,
          externalId: normalized.externalId,
          sourceIdentityRoot: financialSourceIdentityRoot({
            kind: "import_row",
            fileHash: operation.fileHash,
            sheetName: row.sheetName,
            rowNumber: row.rowNumber,
            factType: derivedFact.factType
          })
        } as const;
        const created = await this.financialFactLedger.createPendingAt(
          rowContext, input.cutoff, factInput
        );
        if (created.replayed) replayed = true;
        createdLedgerIds.push(created.fact.id);
      }
    }
    return Object.freeze({
      rowId: row.id,
      status: replayed ? "replayed" : "created",
      createdLedgerIds: [...createdLedgerIds]
    });
  }

  private async assertRowAuthorityUnchanged(
    context: CommandContext,
    operation: FinanceImportOperation,
    row: FinanceImportStoredRow,
    cutoff: GrowthSealedReadCutoff
  ): Promise<void> {
    const normalized = row.normalized;
    if (normalized?.kind !== "financial_fact") return;
    const frozen = normalized.authoritativeDecision;
    if (!frozen) return;
    if (!frozen.dealId) {
      throw new FinanceImportError("financial_fact_conflict", 409);
    }
    const decision = await this.dealQuoteReader.getDecisionAt(
      context.workspace, frozen.dealId, cutoff
    );
    if (!decision || decision.type !== "won"
      || decision.quoteVersionId !== frozen.quoteVersionId
      || decision.authorityRevision !== frozen.authorityRevision
      || decision.commercialAmountHash !== frozen.commercialAmountHash
      || decision.quotedAmountMinor !== frozen.quotedAmountMinor
      || decision.currency !== frozen.currency
      || canonicalJsonStringify(decision.commercialBindingEvidence)
        !== canonicalJsonStringify(frozen.commercialBindingEvidence)
      || canonicalJsonStringify(decision.commercialBindingSnapshot)
        !== canonicalJsonStringify(frozen.commercialBindingSnapshot)) {
      throw new FinanceImportError("financial_fact_conflict", 409);
    }
    const verified = await this.bindingVerifier.verify(
      context.workspace, {
        candidateId: frozen.commercialBindingEvidence.candidateId,
        customerId: frozen.commercialBindingEvidence.customerId,
        dealId: frozen.commercialBindingEvidence.dealId
      }
    );
    if (verified.candidateId
        !== frozen.commercialBindingEvidence.candidateId
      || verified.customerId
        !== frozen.commercialBindingEvidence.customerId
      || verified.dealId !== frozen.commercialBindingEvidence.dealId
      || verified.handoffContentHash
        !== frozen.commercialBindingEvidence.handoffContentHash
      || verified.dealContentHash
        !== frozen.commercialBindingEvidence.dealContentHash
      || verified.bindingHashSchemaVersion
        !== frozen.commercialBindingEvidence.bindingHashSchemaVersion
      || verified.bindingHash
        !== frozen.commercialBindingEvidence.bindingHash) {
      throw new FinanceImportError("financial_fact_conflict", 409);
    }
  }

  async run(input: {
    operationId: string;
    workerId: string;
    authorize(operation: FinanceImportOperation): Promise<CommandContext>;
  }): Promise<{
    status: "succeeded" | "partial_success";
    createdIds: string[];
    replayed: boolean;
  }> {
    const claim = await this.claim(
      input.operationId, input.workerId, this.now()
    );
    if (!claim) {
      throw new FinanceImportError("finance_import_not_claimable", 409);
    }
    const operation = await this.repository.getOperation(input.operationId);
    if (!operation) {
      throw new FinanceImportError("finance_import_not_found", 404);
    }
    let context: CommandContext;
    try {
      context = await input.authorize(operation);
    } catch (error) {
      if (isPermanentAuthorizationDenial(error)) {
        const code = (error as { code?: string }).code
          ?? "authorization_revoked";
        await this.repository.fail(claim, code, this.now());
        throw error;
      }
      throw error;
    }
    const run = this.commit(context, claim);
    this.activeRuns.add(run);
    try {
      return await run.catch(async (error) => {
        if (isPermanentAuthorizationDenial(error)) {
          const code = (error as { code?: string }).code
            ?? "authorization_revoked";
          await this.repository.fail(claim, code, this.now());
        }
        throw error;
      });
    } finally {
      this.activeRuns.delete(run);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.activeRuns]);
  }
}

function isPermanentAuthorizationDenial(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "capability_forbidden"
    || code === "finance_import_authority_mismatch"
    || code === "finance_import_preview_mismatch";
}

export class CurrentFinanceImportRecoveryAuthorizer {
  constructor(private readonly resolveWorkspaceActor: (
    workspaceId: string,
    actorId: string
  ) => Promise<ActiveWorkspaceContext>) {}

  async commandFor(
    operation: Readonly<FinanceImportOperation>
  ): Promise<CommandContext> {
    const resolved = await this.resolveWorkspaceActor(
      operation.workspaceId, operation.requestingActorId
    );
    requireGrowthCapabilities(resolved, ["ledger.pending.create"]);
    return Object.freeze({
      workspace: resolved,
      actorId: operation.requestingActorId,
      idempotencyKey: operation.idempotencyKey,
      requestHash: operation.requestHash,
      expectedRevision: null
    });
  }
}
