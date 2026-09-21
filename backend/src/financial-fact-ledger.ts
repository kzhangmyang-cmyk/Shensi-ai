import { randomUUID } from "node:crypto";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import {
  requireExpectedRevision,
  type CommandContext
} from "./growth-command-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import {
  canonicalGrowthRequestHash,
  executeGrowthIdempotentCommand
} from "./growth-http-idempotency-repository.js";
import {
  ledgerEntryStatus,
  type FinancialFact,
  type FinancialFactProvenance,
  type FinancialFactType,
  type LedgerSourceHead,
  type LedgerVerificationEvent
} from "./financial-ledger-domain.js";
import type {
  FinancialLedgerRepository,
  FinancialLedgerTransaction
} from "./financial-ledger-repository.js";
import { FinancialLedgerError } from "./acquisition-cost-ledger.js";
import { safeMinor } from "./growth-money.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  assertFrozenCommercialBinding,
  type AuthoritativeDealDecisionRef
} from "./authoritative-quote-reader.js";
import type {
  CommercialBindingSnapshot,
  CommercialBindingVerifier
} from "./commercial-binding-snapshot.js";
import {
  assertGrowthSealedReadCutoff,
  type GrowthSealedReadCutoff
} from "./growth-temporal-barrier.js";
import type { CommercialBindingEvidenceSnapshot } from "./quote-repository.js";
import { canonicalJsonStringify } from "./canonical-json.js";

const FINANCIAL_FACT_TYPES: ReadonlySet<FinancialFactType> =
  new Set<FinancialFactType>([
    "contract_won",
    "payment_received",
    "revenue_recognized",
    "cogs_recognized",
    "refund",
    "bad_debt_written_off"
  ]);

const FINANCIAL_FACT_PROVENANCES: ReadonlySet<FinancialFactProvenance> =
  new Set<FinancialFactProvenance>([
    "portal_export",
    "bank_statement",
    "invoice_confirmed",
    "manual_verified",
    "derived_from_import"
  ]);

const CREATE_FINANCIAL_FACT_FIELDS: ReadonlySet<string> = new Set([
  "candidateId",
  "customerId",
  "dealId",
  "factType",
  "amountMinor",
  "currency",
  "businessOccurredAt",
  "provenance",
  "sourceRef",
  "evidenceHash",
  "externalId",
  "sourceIdentityRoot"
]);

export interface CreateFinancialFactInput {
  readonly candidateId: string | null;
  readonly customerId: string | null;
  readonly dealId: string | null;
  readonly factType: FinancialFactType;
  readonly amountMinor: number;
  readonly currency: string;
  readonly businessOccurredAt: string;
  readonly provenance: FinancialFactProvenance;
  readonly sourceRef: string | null;
  readonly evidenceHash: string;
  readonly externalId: string | null;
  readonly sourceIdentityRoot: string;
}

export interface FinancialFactProjection extends FinancialFact {
  readonly events: readonly LedgerVerificationEvent[];
  readonly status: ReturnType<typeof ledgerEntryStatus>;
  readonly revision: number;
}

export interface FinancialFactLedgerCommands {
  createPending(
    context: CommandContext,
    input: CreateFinancialFactInput
  ): Promise<{ fact: FinancialFact; replayed: boolean }>;
  verify(
    context: CommandContext,
    input: { factId: string; reason: string }
  ): Promise<FinancialFactProjection>;
  reject(
    context: CommandContext,
    input: { factId: string; reason: string }
  ): Promise<FinancialFactProjection>;
  reverse(
    context: CommandContext,
    input: { factId: string; reason: string }
  ): Promise<FinancialFactProjection>;
  correct(
    context: CommandContext,
    input: {
      factId: string;
      replacement: CreateFinancialFactInput;
      reason: string;
    }
  ): Promise<{ reversed: FinancialFactProjection; replacement: FinancialFact }>;
  get(
    workspace: ActiveWorkspaceContext,
    factId: string
  ): Promise<FinancialFactProjection | null>;
}

export interface FinancialFactLedgerAuthorityCommands {
  createPendingAt(
    context: CommandContext,
    cutoff: GrowthSealedReadCutoff,
    input: CreateFinancialFactInput
  ): Promise<{ fact: FinancialFact; replayed: boolean }>;
  correctAt(
    context: CommandContext,
    cutoff: GrowthSealedReadCutoff,
    input: {
      factId: string;
      replacement: CreateFinancialFactInput;
      reason: string;
    }
  ): Promise<{ reversed: FinancialFactProjection; replacement: FinancialFact }>;
}

export interface FinancialFactDealAuthorityReader {
  getDecisionAt(
    context: ActiveWorkspaceContext,
    dealId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<AuthoritativeDealDecisionRef | null>;
}

function requireUnsignedFinancialFactMinor(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new FinancialLedgerError("financial_fact_amount_invalid", 422);
  }
  if (!Number.isSafeInteger(value)) {
    throw new FinancialLedgerError("amount_out_of_range", 422);
  }
  return value;
}

function requireSignedFinancialFactMinor(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new FinancialLedgerError("financial_fact_amount_invalid", 422);
  }
  if (!Number.isSafeInteger(value)) {
    throw new FinancialLedgerError("amount_out_of_range", 422);
  }
  return value;
}

export function deriveRevenueAndCogs(input: {
  revenueMinor: number | null;
  grossProfitMinor: number | null;
}): { revenueMinor: number; cogsMinor: number | null } | null {
  if (input.grossProfitMinor !== null && input.revenueMinor === null) {
    throw new FinancialLedgerError(
      "revenue_required_for_gross_profit", 422
    );
  }
  if (input.revenueMinor === null) return null;
  const revenueMinor = requireUnsignedFinancialFactMinor(input.revenueMinor);
  if (input.grossProfitMinor === null) {
    return { revenueMinor, cogsMinor: null };
  }
  const grossProfitMinor = requireSignedFinancialFactMinor(
    input.grossProfitMinor
  );
  const cogs = BigInt(revenueMinor) - BigInt(grossProfitMinor);
  if (cogs < 0n) {
    throw new FinancialLedgerError("financial_fact_amount_invalid", 422);
  }
  return { revenueMinor, cogsMinor: safeMinor(cogs, "cogsMinor") };
}

function text(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new FinancialLedgerError(code, 422);
  return normalized;
}

function nullableText(value: string | null, code: string): string | null {
  return value === null ? null : text(value, code);
}

function timestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new FinancialLedgerError("invalid_ledger_timestamp", 422);
  }
  return new Date(time).toISOString();
}

export function parseCreateFinancialFactInput(
  rawInput: unknown
): CreateFinancialFactInput {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    throw new FinancialLedgerError("invalid_financial_fact_input", 422);
  }
  const input = rawInput as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!CREATE_FINANCIAL_FACT_FIELDS.has(key)) {
      throw new FinancialLedgerError(
        `additionalProperties: ${key}`, 422
      );
    }
  }
  const factType = input.factType;
  if (typeof factType !== "string"
    || !FINANCIAL_FACT_TYPES.has(factType as FinancialFactType)) {
    throw new FinancialLedgerError("invalid_financial_fact_type", 422);
  }
  const provenance = input.provenance;
  if (typeof provenance !== "string"
    || !FINANCIAL_FACT_PROVENANCES.has(
      provenance as FinancialFactProvenance
    )) {
    throw new FinancialLedgerError("invalid_financial_fact_provenance", 422);
  }
  const currency = text(
    typeof input.currency === "string" ? input.currency : "",
    "invalid_currency"
  ).toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new FinancialLedgerError("invalid_currency", 422);
  }
  return Object.freeze({
    candidateId: nullableText(
      typeof input.candidateId === "string" || input.candidateId === null
        ? input.candidateId : "",
      "invalid_candidate_id"
    ),
    customerId: nullableText(
      typeof input.customerId === "string" || input.customerId === null
        ? input.customerId : "",
      "invalid_customer_id"
    ),
    dealId: nullableText(
      typeof input.dealId === "string" || input.dealId === null
        ? input.dealId : "",
      "invalid_deal_id"
    ),
    factType: factType as FinancialFactType,
    amountMinor: requireUnsignedFinancialFactMinor(
      typeof input.amountMinor === "number" ? input.amountMinor : Number.NaN
    ),
    currency,
    businessOccurredAt: timestamp(
      typeof input.businessOccurredAt === "string"
        ? input.businessOccurredAt : ""
    ),
    provenance: provenance as FinancialFactProvenance,
    sourceRef: nullableText(
      typeof input.sourceRef === "string" || input.sourceRef === null
        ? input.sourceRef : "",
      "invalid_source_ref"
    ),
    evidenceHash: text(
      typeof input.evidenceHash === "string" ? input.evidenceHash : "",
      "invalid_evidence_hash"
    ),
    externalId: nullableText(
      typeof input.externalId === "string" || input.externalId === null
        ? input.externalId : "",
      "invalid_external_id"
    ),
    sourceIdentityRoot: text(
      typeof input.sourceIdentityRoot === "string"
        ? input.sourceIdentityRoot : "",
      "invalid_source_identity_root"
    )
  });
}

function samePendingCommand(
  fact: FinancialFact,
  input: CreateFinancialFactInput
): boolean {
  return fact.candidateId === input.candidateId
    && fact.customerId === input.customerId
    && fact.dealId === input.dealId
    && fact.factType === input.factType
    && fact.amountMinor === input.amountMinor
    && fact.currency === input.currency
    && fact.businessOccurredAt === input.businessOccurredAt
    && fact.provenance === input.provenance
    && fact.sourceRef === input.sourceRef
    && fact.evidenceHash === input.evidenceHash
    && fact.externalId === input.externalId
    && fact.sourceIdentityRoot === input.sourceIdentityRoot;
}

function matchesCommercialBindingEvidence(
  verified: CommercialBindingSnapshot,
  evidence: CommercialBindingEvidenceSnapshot
): boolean {
  return verified.candidateId === evidence.candidateId
    && verified.customerId === evidence.customerId
    && verified.dealId === evidence.dealId
    && verified.handoffContentHash === evidence.handoffContentHash
    && verified.dealContentHash === evidence.dealContentHash
    && verified.bindingHashSchemaVersion === evidence.bindingHashSchemaVersion
    && verified.bindingHash === evidence.bindingHash;
}

function projectFinancialFact(
  fact: FinancialFact,
  events: readonly LedgerVerificationEvent[]
): FinancialFactProjection {
  return Object.freeze({
    ...fact,
    events: Object.freeze(events),
    status: ledgerEntryStatus(events),
    revision: fact.sourceVersion + events.length
  });
}

async function requiredFinancialFact(
  tx: FinancialLedgerTransaction,
  workspaceId: string,
  factId: string
): Promise<FinancialFact> {
  const fact = await tx.getFinancialFactForUpdate(workspaceId, factId);
  if (!fact) throw new FinancialLedgerError("financial_fact_not_found", 404);
  return fact;
}

function financialVerificationEvent(
  fact: FinancialFact,
  eventType: LedgerVerificationEvent["eventType"],
  decidedBy: string,
  reason: string,
  recordedAt: string,
  input: {
    id?: string;
    eventSequence: number;
    revision: number;
    temporalSequence: number;
    reversesEventId?: string | null;
    correctionGroupId?: string | null;
  }
): LedgerVerificationEvent {
  return Object.freeze({
    id: input.id ?? randomUUID(),
    workspaceId: fact.workspaceId,
    ledgerType: "financial",
    ledgerEntryId: fact.id,
    eventType,
    reversesEventId: input.reversesEventId ?? null,
    eventSequence: input.eventSequence,
    revision: input.revision,
    correctionGroupId: input.correctionGroupId ?? null,
    reason: text(reason, "invalid_ledger_reason"),
    decidedBy: text(decidedBy, "invalid_growth_actor_id"),
    recordedAt,
    temporalSequence: input.temporalSequence
  });
}

function financialFactRoute(
  event: "create" | "verify" | "reject" | "reverse" | "correct"
): string {
  return event === "create"
    ? "/api/v1/growth/financial-facts"
    : `/api/v1/growth/financial-facts/:id/${event}`;
}

function stableFinancialFactOperationId(
  context: CommandContext,
  operation: string
): string {
  return canonicalGrowthRequestHash({
    workspaceId: context.workspace.workspaceId,
    actorId: context.actorId,
    idempotencyKey: context.idempotencyKey,
    requestHash: context.requestHash,
    operation
  });
}

function isSameFinancialDecision(
  event: LedgerVerificationEvent,
  eventType: LedgerVerificationEvent["eventType"],
  actorId: string,
  reason: string
): boolean {
  return event.eventType === eventType
    && event.decidedBy === actorId
    && event.reason === reason.trim();
}

export class FinancialFactLedgerService
implements FinancialFactLedgerCommands, FinancialFactLedgerAuthorityCommands {
  private readonly repository: FinancialLedgerRepository;
  private readonly foundation: GrowthFoundationServices;
  private readonly bindingVerifier: Pick<CommercialBindingVerifier, "verify">;
  private readonly dealQuoteReader: FinancialFactDealAuthorityReader;
  private readonly now: () => string;
  private readonly requestExecutionId: () => string;

  constructor(input: {
    repository: FinancialLedgerRepository;
    foundation: GrowthFoundationServices;
    bindingVerifier: Pick<CommercialBindingVerifier, "verify">;
    dealQuoteReader: FinancialFactDealAuthorityReader;
    now?: () => string;
    requestExecutionId?: () => string;
  }) {
    this.repository = input.repository;
    this.foundation = input.foundation;
    this.bindingVerifier = input.bindingVerifier;
    this.dealQuoteReader = input.dealQuoteReader;
    this.now = input.now ?? (() => new Date().toISOString());
    this.requestExecutionId = input.requestExecutionId ?? randomUUID;
  }

  private reservation(context: CommandContext, canonicalPath: string) {
    return {
      repository: this.foundation.httpIdempotency,
      reservation: {
        workspaceId: context.workspace.workspaceId,
        actorId: context.actorId,
        method: "POST",
        canonicalPath,
        key: context.idempotencyKey,
        requestHash: context.requestHash,
        attemptedAt: this.now(),
        leaseOwner: this.requestExecutionId(),
        leaseDurationMs: 30_000
      }
    } as const;
  }

  private async events(workspaceId: string, factId: string) {
    return this.repository.transaction((tx) =>
      tx.listVerificationEventsForUpdate(workspaceId, "financial", factId));
  }

  private async resolveWonAuthority(
    context: CommandContext,
    cutoff: GrowthSealedReadCutoff,
    input: CreateFinancialFactInput,
    frozen: FinancialFact | null
  ): Promise<AuthoritativeDealDecisionRef | null> {
    if (!input.candidateId || !input.customerId || !input.dealId) {
      if (input.factType === "contract_won") {
        throw new FinancialLedgerError(
          "authoritative_won_quote_required", 422
        );
      }
      return null;
    }
    const decision = await this.dealQuoteReader.getDecisionAt(
      context.workspace, input.dealId, cutoff
    );
    if (!decision || decision.type !== "won") {
      throw new FinancialLedgerError(
        "authoritative_won_quote_required", 422
      );
    }
    const evidence = decision.commercialBindingEvidence;
    if (evidence.candidateId !== input.candidateId
      || evidence.customerId !== input.customerId
      || evidence.dealId !== input.dealId) {
      throw new FinancialLedgerError("financial_fact_conflict", 409);
    }
    assertFrozenCommercialBinding(
      decision.commercialBindingSnapshot, evidence
    );
    const verified = await this.bindingVerifier.verify(context.workspace, {
      candidateId: input.candidateId,
      customerId: input.customerId,
      dealId: input.dealId
    });
    if (!matchesCommercialBindingEvidence(verified, evidence)) {
      throw new FinancialLedgerError("financial_fact_conflict", 409);
    }
    if (input.factType === "contract_won"
      && (input.amountMinor !== decision.quotedAmountMinor
        || input.currency !== decision.currency)) {
      throw new FinancialLedgerError("financial_fact_conflict", 409);
    }
    if (frozen
      && canonicalJsonStringify(decision.commercialBindingSnapshot)
        !== canonicalJsonStringify(frozen.commercialBindingSnapshot)) {
      throw new FinancialLedgerError("financial_fact_conflict", 409);
    }
    return decision;
  }

  private async projectCreate(
    context: CommandContext,
    resourceId: string | null,
    operationId: string | null,
    expected: CreateFinancialFactInput
  ): Promise<FinancialFact> {
    requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
    if (!resourceId || operationId !== null) {
      throw new FinancialLedgerError("idempotency_reference_invalid", 409);
    }
    const fact = await this.repository.getFinancialFact(
      context.workspace.workspaceId, resourceId
    );
    if (!fact || !samePendingCommand(fact, expected)) {
      throw new FinancialLedgerError("idempotency_conflict", 409);
    }
    return fact;
  }

  private async projectDecision(
    context: CommandContext,
    resourceId: string | null,
    operationId: string | null,
    factId: string,
    eventType: LedgerVerificationEvent["eventType"]
  ): Promise<FinancialFactProjection> {
    requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
    if (resourceId !== factId || !operationId) {
      throw new FinancialLedgerError("idempotency_reference_invalid", 409);
    }
    const fact = await this.repository.getFinancialFact(
      context.workspace.workspaceId, factId
    );
    if (!fact) {
      throw new FinancialLedgerError("idempotency_reference_invalid", 409);
    }
    const events = await this.events(fact.workspaceId, fact.id);
    const operation = events.find((event) => event.id === operationId);
    if (!operation || operation.eventType !== eventType
      || operation.ledgerEntryId !== fact.id) {
      throw new FinancialLedgerError("idempotency_reference_invalid", 409);
    }
    return projectFinancialFact(fact, events);
  }

  async get(
    workspace: ActiveWorkspaceContext,
    factId: string
  ): Promise<FinancialFactProjection | null> {
    requireGrowthCapabilities(workspace, ["ledger.pending.create"]);
    const fact = await this.repository.getFinancialFact(
      workspace.workspaceId, text(factId, "invalid_financial_fact_id")
    );
    if (!fact) return null;
    return projectFinancialFact(
      fact, await this.events(fact.workspaceId, fact.id)
    );
  }

  async createPending(
    context: CommandContext,
    rawInput: CreateFinancialFactInput
  ): Promise<{ fact: FinancialFact; replayed: boolean }> {
    requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
    const input = parseCreateFinancialFactInput(rawInput);
    const cutoff = await this.foundation.temporalBarrier.sealReadCutoff(
      context.workspace, this.now()
    );
    return this.createPendingAt(context, cutoff, input);
  }

  async createPendingAt(
    context: CommandContext,
    cutoff: GrowthSealedReadCutoff,
    rawInput: CreateFinancialFactInput
  ): Promise<{ fact: FinancialFact; replayed: boolean }> {
    requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
    const trustedCutoff = assertGrowthSealedReadCutoff(
      cutoff, context.workspace.workspaceId
    );
    const input = parseCreateFinancialFactInput(rawInput);
    const execution = await executeGrowthIdempotentCommand(
      this.reservation(context, financialFactRoute("create")),
      (resourceId, operationId) => this.projectCreate(
        context, resourceId, operationId, input
      ),
      async () => this.repository.transaction(async (tx) => {
        const stamp = await this.foundation.temporalBarrier.allocateAppend(
          tx, context.workspace.workspaceId
        );
        const currentHead = await tx.getSourceHeadForUpdate(
          context.workspace.workspaceId, "financial", input.sourceIdentityRoot
        );
        if (currentHead) {
          const current = await requiredFinancialFact(
            tx, context.workspace.workspaceId,
            currentHead.currentLedgerEntryId
          );
          if (!samePendingCommand(current, input)) {
            throw new FinancialLedgerError("ledger_source_conflict", 409);
          }
          return { resourceId: current.id, operationId: null };
        }
        const authority = await this.resolveWonAuthority(
          context, trustedCutoff, input, null
        );
        const binding = authority?.commercialBindingSnapshot ?? null;
        const fact = Object.freeze({
          id: randomUUID(),
          workspaceId: context.workspace.workspaceId,
          candidateId: input.candidateId,
          customerId: input.customerId,
          dealId: input.dealId,
          quoteVersionId: authority?.quoteVersionId ?? null,
          factType: input.factType,
          amountMinor: input.amountMinor,
          currency: input.currency,
          businessOccurredAt: input.businessOccurredAt,
          recordedAt: stamp.recordedAt,
          temporalSequence: stamp.temporalSequence,
          provenance: input.provenance,
          sourceRef: input.sourceRef,
          evidenceHash: input.evidenceHash,
          externalId: input.externalId,
          sourceIdentityRoot: input.sourceIdentityRoot,
          sourceVersion: 1,
          attributionSnapshot: binding?.attributionSnapshot ?? null,
          commercialBindingSnapshot: binding
            ? structuredClone(binding) : null,
          commercialAmountHash: authority?.commercialAmountHash ?? null,
          dealAuthorityRevision: authority?.authorityRevision ?? null,
          correctsFactId: null,
          correctionGroupId: null,
          createdBy: context.actorId
        }) satisfies FinancialFact;
        const head = Object.freeze({
          workspaceId: fact.workspaceId,
          ledgerType: "financial",
          sourceIdentityRoot: fact.sourceIdentityRoot,
          currentLedgerEntryId: fact.id,
          currentSourceVersion: 1,
          revision: 1
        }) satisfies LedgerSourceHead;
        await tx.insertSourceHead(head);
        await tx.insertFinancialFact(fact);
        return { resourceId: fact.id, operationId: null };
      })
    );
    return { fact: execution.value, replayed: execution.replayed };
  }

  async verify(
    context: CommandContext,
    input: { factId: string; reason: string }
  ): Promise<FinancialFactProjection> {
    return this.decidePending(context, input, "verified");
  }

  async reject(
    context: CommandContext,
    input: { factId: string; reason: string }
  ): Promise<FinancialFactProjection> {
    return this.decidePending(context, input, "rejected");
  }

  private async decidePending(
    context: CommandContext,
    input: { factId: string; reason: string },
    eventType: "verified" | "rejected"
  ): Promise<FinancialFactProjection> {
    requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
    const expectedRevision = requireExpectedRevision(context);
    const factId = text(input.factId, "invalid_financial_fact_id");
    const operationId = stableFinancialFactOperationId(context, eventType);
    const execution = await executeGrowthIdempotentCommand(
      this.reservation(
        context,
        financialFactRoute(eventType === "verified" ? "verify" : "reject")
      ),
      (resourceId, operationId) => this.projectDecision(
        context, resourceId, operationId, factId, eventType
      ),
      async () => this.repository.transaction(async (tx) => {
        const stamp = await this.foundation.temporalBarrier.allocateAppend(
          tx, context.workspace.workspaceId
        );
        const fact = await requiredFinancialFact(
          tx, context.workspace.workspaceId, factId
        );
        const events = await tx.listVerificationEventsForUpdate(
          fact.workspaceId, "financial", fact.id
        );
        const existing = events.find((event) => event.id === operationId);
        if (existing) {
          if (!isSameFinancialDecision(
            existing, eventType, context.actorId, input.reason
          )) {
            throw new FinancialLedgerError(
              "idempotency_reference_invalid", 409
            );
          }
          return { resourceId: fact.id, operationId: existing.id };
        }
        if (ledgerEntryStatus(events) !== "pending") {
          throw new FinancialLedgerError(
            "ledger_decision_already_recorded", 409
          );
        }
        if (expectedRevision !== fact.sourceVersion + events.length) {
          throw new FinancialLedgerError("ledger_revision_conflict", 412);
        }
        const event = financialVerificationEvent(
          fact, eventType, context.actorId, input.reason, stamp.recordedAt,
          {
            id: operationId,
            eventSequence: 1,
            revision: 2,
            temporalSequence: stamp.temporalSequence
          }
        );
        await tx.appendVerificationEvent(event);
        return { resourceId: fact.id, operationId: event.id };
      })
    );
    return execution.value;
  }

  async reverse(
    context: CommandContext,
    input: { factId: string; reason: string }
  ): Promise<FinancialFactProjection> {
    requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
    const expectedRevision = requireExpectedRevision(context);
    const factId = text(input.factId, "invalid_financial_fact_id");
    const operationId = stableFinancialFactOperationId(context, "reversed");
    const execution = await executeGrowthIdempotentCommand(
      this.reservation(context, financialFactRoute("reverse")),
      (resourceId, operationId) => this.projectDecision(
        context, resourceId, operationId, factId, "reversed"
      ),
      async () => this.repository.transaction(async (tx) => {
        const stamp = await this.foundation.temporalBarrier.allocateAppend(
          tx, context.workspace.workspaceId
        );
        const fact = await requiredFinancialFact(
          tx, context.workspace.workspaceId, factId
        );
        const events = await tx.listVerificationEventsForUpdate(
          fact.workspaceId, "financial", fact.id
        );
        const existing = events.find((event) => event.id === operationId);
        if (existing) {
          if (!isSameFinancialDecision(
            existing, "reversed", context.actorId, input.reason
          )) {
            throw new FinancialLedgerError(
              "idempotency_reference_invalid", 409
            );
          }
          return { resourceId: fact.id, operationId: existing.id };
        }
        if (ledgerEntryStatus(events) !== "verified") {
          throw new FinancialLedgerError("ledger_not_verified", 409);
        }
        if (expectedRevision !== fact.sourceVersion + events.length) {
          throw new FinancialLedgerError("ledger_revision_conflict", 412);
        }
        const verified = events[0]!;
        const event = financialVerificationEvent(
          fact, "reversed", context.actorId, input.reason, stamp.recordedAt,
          {
            id: operationId,
            eventSequence: 2,
            revision: 3,
            temporalSequence: stamp.temporalSequence,
            reversesEventId: verified.id
          }
        );
        await tx.appendVerificationEvent(event);
        return { resourceId: fact.id, operationId: event.id };
      })
    );
    return execution.value;
  }

  async correct(
    context: CommandContext,
    input: {
      factId: string;
      replacement: CreateFinancialFactInput;
      reason: string;
    }
  ): Promise<{ reversed: FinancialFactProjection; replacement: FinancialFact }> {
    requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
    const cutoff = await this.foundation.temporalBarrier.sealReadCutoff(
      context.workspace, this.now()
    );
    return this.correctAt(context, cutoff, input);
  }

  async correctAt(
    context: CommandContext,
    cutoff: GrowthSealedReadCutoff,
    input: {
      factId: string;
      replacement: CreateFinancialFactInput;
      reason: string;
    }
  ): Promise<{ reversed: FinancialFactProjection; replacement: FinancialFact }> {
    requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
    const trustedCutoff = assertGrowthSealedReadCutoff(
      cutoff, context.workspace.workspaceId
    );
    const expectedRevision = requireExpectedRevision(context);
    const factId = text(input.factId, "invalid_financial_fact_id");
    const reason = input.reason;
    const replacementInput = parseCreateFinancialFactInput(input.replacement);
    const correctionGroupId = stableFinancialFactOperationId(
      context, "correction-group"
    );
    const reversalOperationId = stableFinancialFactOperationId(
      context, "correction-reversal"
    );
    const replacementFactId = stableFinancialFactOperationId(
      context, "correction-replacement"
    );
    const execution = await executeGrowthIdempotentCommand(
      this.reservation(context, financialFactRoute("correct")),
      async (resourceId, operationId) => {
        requireGrowthCapabilities(context.workspace, ["ledger.verify"]);
        if (!resourceId || !operationId) {
          throw new FinancialLedgerError("idempotency_reference_invalid", 409);
        }
        const replacement = await this.repository.getFinancialFact(
          context.workspace.workspaceId, resourceId
        );
        if (!replacement || replacement.correctionGroupId !== operationId
          || replacement.correctsFactId !== factId
          || !samePendingCommand(replacement, replacementInput)) {
          throw new FinancialLedgerError("idempotency_reference_invalid", 409);
        }
        const oldFact = await this.repository.getFinancialFact(
          context.workspace.workspaceId, factId
        );
        if (!oldFact) {
          throw new FinancialLedgerError("idempotency_reference_invalid", 409);
        }
        const [replacementEvents, oldEvents] = await Promise.all([
          this.events(replacement.workspaceId, replacement.id),
          this.events(oldFact.workspaceId, oldFact.id)
        ]);
        if (!oldEvents.some((event) =>
          event.eventType === "reversed"
          && event.correctionGroupId === operationId)) {
          throw new FinancialLedgerError("idempotency_reference_invalid", 409);
        }
        return Object.freeze({
          reversed: projectFinancialFact(oldFact, oldEvents),
          replacement
        });
      },
      async () => {
        const probe = await this.repository.getFinancialFact(
          context.workspace.workspaceId, factId
        );
        if (!probe) {
          throw new FinancialLedgerError("financial_fact_not_found", 404);
        }
        return this.repository.transaction(async (tx) => {
          const reversalStamp = await this.foundation.temporalBarrier
            .allocateAppend(tx, context.workspace.workspaceId);
          const head = await tx.getSourceHeadForUpdate(
            context.workspace.workspaceId, "financial",
            probe.sourceIdentityRoot
          );
          const oldFact = await requiredFinancialFact(
            tx, context.workspace.workspaceId, probe.id
          );
          if (oldFact.sourceIdentityRoot !== probe.sourceIdentityRoot
            || oldFact.sourceVersion !== probe.sourceVersion) {
            throw new FinancialLedgerError("ledger_source_conflict", 409);
          }
          const oldEvents = await tx.listVerificationEventsForUpdate(
            oldFact.workspaceId, "financial", oldFact.id
          );
          const existingReversal = oldEvents.find(
            (event) => event.id === reversalOperationId
          );
          if (existingReversal) {
            if (!isSameFinancialDecision(
              existingReversal, "reversed", context.actorId, reason
            ) || existingReversal.correctionGroupId !== correctionGroupId) {
              throw new FinancialLedgerError(
                "idempotency_reference_invalid", 409
              );
            }
            const replacement = await requiredFinancialFact(
              tx, context.workspace.workspaceId, replacementFactId
            );
            if (!head || head.currentLedgerEntryId !== replacement.id
              || replacement.correctsFactId !== oldFact.id
              || replacement.correctionGroupId !== correctionGroupId
              || !samePendingCommand(replacement, replacementInput)) {
              throw new FinancialLedgerError(
                "idempotency_reference_invalid", 409
              );
            }
            return {
              resourceId: replacement.id,
              operationId: correctionGroupId
            };
          }
          if (!head || head.currentLedgerEntryId !== probe.id
            || head.currentSourceVersion !== probe.sourceVersion) {
            throw new FinancialLedgerError("ledger_source_conflict", 409);
          }
          if (ledgerEntryStatus(oldEvents) !== "verified") {
            throw new FinancialLedgerError("ledger_not_verified", 409);
          }
          if (expectedRevision !== oldFact.sourceVersion + oldEvents.length) {
            throw new FinancialLedgerError("ledger_revision_conflict", 412);
          }
          if (replacementInput.candidateId !== oldFact.candidateId
            || replacementInput.customerId !== oldFact.customerId
            || replacementInput.dealId !== oldFact.dealId) {
            throw new FinancialLedgerError("financial_fact_conflict", 409);
          }
          if (replacementInput.sourceIdentityRoot
            !== oldFact.sourceIdentityRoot) {
            throw new FinancialLedgerError("ledger_source_conflict", 409);
          }
          await this.resolveWonAuthority(
            context, trustedCutoff, replacementInput, oldFact
          );
          const reversal = financialVerificationEvent(
            oldFact, "reversed", context.actorId, reason,
            reversalStamp.recordedAt,
            {
              id: reversalOperationId,
              eventSequence: 2,
              revision: 3,
              temporalSequence: reversalStamp.temporalSequence,
              reversesEventId: oldEvents[0]!.id,
              correctionGroupId
            }
          );
          await tx.appendVerificationEvent(reversal);
          const replacementStamp = await this.foundation.temporalBarrier
            .allocateAppend(tx, context.workspace.workspaceId);
          const replacement = Object.freeze({
            id: replacementFactId,
            workspaceId: oldFact.workspaceId,
            candidateId: oldFact.candidateId,
            customerId: oldFact.customerId,
            dealId: oldFact.dealId,
            quoteVersionId: oldFact.quoteVersionId,
            factType: replacementInput.factType,
            amountMinor: replacementInput.amountMinor,
            currency: replacementInput.currency,
            businessOccurredAt: replacementInput.businessOccurredAt,
            recordedAt: replacementStamp.recordedAt,
            temporalSequence: replacementStamp.temporalSequence,
            provenance: replacementInput.provenance,
            sourceRef: replacementInput.sourceRef,
            evidenceHash: replacementInput.evidenceHash,
            externalId: replacementInput.externalId,
            sourceIdentityRoot: oldFact.sourceIdentityRoot,
            sourceVersion: oldFact.sourceVersion + 1,
            attributionSnapshot: oldFact.attributionSnapshot,
            commercialBindingSnapshot: oldFact.commercialBindingSnapshot,
            commercialAmountHash: oldFact.commercialAmountHash,
            dealAuthorityRevision: oldFact.dealAuthorityRevision,
            correctsFactId: oldFact.id,
            correctionGroupId,
            createdBy: context.actorId
          }) satisfies FinancialFact;
          await tx.insertFinancialFact(replacement);
          const advanced = await tx.compareAndSetSourceHead(head.revision, {
            ...head,
            currentLedgerEntryId: replacement.id,
            currentSourceVersion: replacement.sourceVersion,
            revision: head.revision + 1
          });
          if (!advanced) {
            throw new FinancialLedgerError("ledger_source_conflict", 409);
          }
          return {
            resourceId: replacement.id,
            operationId: correctionGroupId
          };
        });
      }
    );
    return execution.value;
  }
}
