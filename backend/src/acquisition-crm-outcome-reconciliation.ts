import { createHash } from "node:crypto";
import type {
  OutcomeAttributionInput,
  OutcomeEventType,
  OutcomeInput
} from "./acquisition-domain.js";
import type {
  AcquisitionActorScope,
  AcquisitionOutcomeWriteAuthority
} from "./acquisition-domain-service.js";
import type { AcquisitionDealBindingStore } from "./acquisition-deal-binding.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import { assertFrozenCommercialBinding } from "./authoritative-quote-reader.js";
import type { CommercialBindingVerifier } from "./commercial-binding-snapshot.js";
import type {
  DealAuthoritativeQuoteEvent,
  CommercialBindingEvidenceSnapshot,
  QuoteVersion
} from "./quote-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type {
  AcquisitionPlanRunRepository
} from "./acquisition-plan-run-repository.js";
import type {
  AcquisitionOutcomeReconciliationCheckpoint,
  AcquisitionOutcomeReconciliationDiagnostic,
  AcquisitionOutcomeReconciliationProcessedSource,
  Deal,
  DealEvent,
  LeadActivity,
  LeadSourceEvent
} from "./types.js";

type ReconciliationLead = AcquisitionDealBindingStore["leads"][number];
type ReconciliationDeal = Pick<
  Deal,
  "id" | "customerId" | "ownerId" | "teamId" | "amount" | "currency"
>;

export interface AcquisitionCandidateRunAttributionInput {
  runId: string;
  discoveredEventId: string;
  candidateId: string;
  evidenceIds: string[];
  qualificationDecisionId: string;
  decisionVersion: string;
  decisionSnapshotHash: string;
}

export class AcquisitionCandidateRunAttributionResolver {
  readonly #planRuns: Pick<
    AcquisitionPlanRunRepository,
    "getRun" | "listRunEvents" | "listRunShards"
  >;

  constructor(options: {
    planRuns: Pick<
      AcquisitionPlanRunRepository,
      "getRun" | "listRunEvents" | "listRunShards"
    >;
  }) {
    this.#planRuns = options.planRuns;
  }

  async resolve(
    scope: { ownerId: string; teamId: string },
    input: AcquisitionCandidateRunAttributionInput
  ): Promise<OutcomeAttributionInput | null> {
    const run = await this.#planRuns.getRun(input.runId);
    if (!run
      || run.ownerId !== scope.ownerId
      || run.teamId !== scope.teamId) return null;
    const event = (await this.#planRuns.listRunEvents(run.id))
      .find((item) =>
        item.id === input.discoveredEventId
        && item.runId === run.id
        && item.ownerId === scope.ownerId
        && item.teamId === scope.teamId
        && item.type === "candidate.discovered"
        && item.data.candidateId === input.candidateId
        && isText(item.data.operationId)
        && isText(item.data.connectionId)
        && isText(item.shardId));
    if (!event?.shardId) return null;
    const shard = (await this.#planRuns.listRunShards(run.id)).find((item) =>
      item.id === event.shardId
      && item.runId === run.id
      && item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
      && item.operationId === event.data.operationId
      && item.connection.connectionId === event.data.connectionId);
    if (!shard) return null;
    return {
      attributionVersion: "acquisition-run.v1",
      runId: run.id,
      planId: run.planId,
      planVersionId: run.planVersionId,
      planVersion: run.planVersion,
      planSnapshotHash: run.planSnapshotHash,
      discoveredEventId: event.id,
      discoveredAt: event.at,
      shardId: shard.id,
      operationId: shard.operationId,
      connectionId: shard.connection.connectionId,
      providerId: shard.connection.providerId,
      evidenceIds: [...new Set(input.evidenceIds)],
      providerIds: [shard.connection.providerId],
      queryIds: [`operation:${shard.operationId}`],
      strategyVersion: `acquisition-plan-v${run.planVersion}`,
      qualificationDecisionId: input.qualificationDecisionId,
      decisionVersion: input.decisionVersion,
      decisionSnapshotHash: input.decisionSnapshotHash
    };
  }
}

export interface AcquisitionCrmOutcomeReconciliationStore {
  leads: ReconciliationLead[];
  leadActivities: LeadActivity[];
  leadSourceEvents: LeadSourceEvent[];
  acquisitionCustomerHandoffs:
    AcquisitionDealBindingStore["acquisitionCustomerHandoffs"];
  deals: ReconciliationDeal[];
  dealEvents: DealEvent[];
  acquisitionOutcomeReconciliationDiagnostics:
    AcquisitionOutcomeReconciliationDiagnostic[];
  acquisitionOutcomeReconciliationCheckpoints:
    AcquisitionOutcomeReconciliationCheckpoint[];
  acquisitionOutcomeReconciliationProcessedSources:
    AcquisitionOutcomeReconciliationProcessedSource[];
  persist(): Promise<void>;
  readBarrier(): Promise<void>;
}

export interface AcquisitionOutcomeRecorder {
  recordOutcome(
    scope: AcquisitionActorScope,
    input: OutcomeInput,
    authority?: AcquisitionOutcomeWriteAuthority
  ): Promise<unknown>;
}

export interface AcquisitionCommercialOutcomeAuthority {
  getVersion(workspaceId: string, id: string): Promise<QuoteVersion | null>;
  listAuthorityEvents(workspaceId: string, dealId?: string):
    Promise<readonly DealAuthoritativeQuoteEvent[]>;
}

export interface AcquisitionCrmOutcomeReconciliationResult {
  scanned: number;
  reconciled: number;
  skipped: number;
  failed: number;
  lastReconciledAt: string;
}

const CONTACT_ACTIVITY_TYPES = new Set<LeadActivity["type"]>([
  "call",
  "wechat",
  "whatsapp",
  "linkedin",
  "email",
  "meeting"
]);

const DEAL_OUTCOMES: Partial<Record<DealEvent["type"], OutcomeEventType>> = {
  quote: "quoted",
  won: "won",
  lost: "lost"
};

function diagnosticId(sourceKind: string, sourceId: string, code: string) {
  return `acq_reconcile_${createHash("sha256")
    .update([sourceKind, sourceId, code].join("\u001f"))
    .digest("hex")
    .slice(0, 40)}`;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

type ReconciledOutcomeAttribution = OutcomeAttributionInput & Required<Pick<
  OutcomeAttributionInput,
  | "planId"
  | "planVersionId"
  | "planVersion"
  | "planSnapshotHash"
  | "discoveredEventId"
  | "discoveredAt"
  | "shardId"
  | "operationId"
  | "connectionId"
  | "providerId"
>>;

function validAttribution(value: unknown): value is ReconciledOutcomeAttribution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const textFields = [
    "runId",
    "attributionVersion",
    "planId",
    "planVersionId",
    "planSnapshotHash",
    "discoveredEventId",
    "discoveredAt",
    "shardId",
    "operationId",
    "connectionId",
    "providerId",
    "strategyVersion",
    "qualificationDecisionId",
    "decisionVersion",
    "decisionSnapshotHash"
  ];
  return textFields.every((field) => isText(item[field]))
    && item.attributionVersion === "acquisition-run.v1"
    && Number.isSafeInteger(item.planVersion)
    && Number(item.planVersion) > 0
    && ["evidenceIds", "providerIds", "queryIds"].every((field) =>
      Array.isArray(item[field])
      && (item[field] as unknown[]).every(isText));
}

function amountForDealEvent(event: DealEvent) {
  if (!Number.isSafeInteger(event.amountMinorSnapshot)
    || Number(event.amountMinorSnapshot) < 0) return null;
  const currency = event.currencySnapshot?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  return { amountMinor: Number(event.amountMinorSnapshot), currency };
}

function matchesCommercialBindingEvidence(
  verified: { candidateId: string; customerId: string; dealId: string;
    handoffContentHash: string; dealContentHash: string;
    bindingHashSchemaVersion: string; bindingHash: string },
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

export class AcquisitionCrmOutcomeReconciliationService {
  readonly #store: AcquisitionCrmOutcomeReconciliationStore;
  readonly #outcomeRecorder: AcquisitionOutcomeRecorder;
  readonly #planRuns: Pick<
    AcquisitionPlanRunRepository,
    "getRun" | "listRunEvents" | "listRunShards"
  >;
  readonly #now: () => string;
  readonly #commercialAuthority: AcquisitionCommercialOutcomeAuthority | null;
  readonly #bindingVerifier: Pick<CommercialBindingVerifier, "verify"> | null;

  constructor(options: {
    store: AcquisitionCrmOutcomeReconciliationStore;
    outcomeRecorder: AcquisitionOutcomeRecorder;
    planRuns: Pick<
      AcquisitionPlanRunRepository,
      "getRun" | "listRunEvents" | "listRunShards"
    >;
    commercialAuthority?: AcquisitionCommercialOutcomeAuthority;
    bindingVerifier?: Pick<CommercialBindingVerifier, "verify"> | null;
    now?: () => string;
  }) {
    this.#store = options.store;
    this.#outcomeRecorder = options.outcomeRecorder;
    this.#planRuns = options.planRuns;
    this.#commercialAuthority = options.commercialAuthority ?? null;
    this.#bindingVerifier = options.bindingVerifier ?? null;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async runTenant(
    scope: { ownerId: string; teamId: string },
    options: { limit?: number } = {}
  ) {
    await this.#store.readBarrier();
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError("limit must be between 1 and 500");
    }
    const processed = new Set(
      this.#store.acquisitionOutcomeReconciliationProcessedSources
        .filter((item) =>
          item.ownerId === scope.ownerId && item.teamId === scope.teamId)
        .map((item) => `${item.sourceKind}\u001f${item.sourceId}`)
    );
    const tenantLeadIds = new Set(this.#store.leads
      .filter((lead) =>
        lead.ownerId === scope.ownerId && lead.teamId === scope.teamId)
      .map((lead) => lead.id));
    const tenantDealIds = new Set(this.#store.deals
      .filter((deal) =>
        deal.ownerId === scope.ownerId && deal.teamId === scope.teamId)
      .map((deal) => deal.id));
    const sources = [
      ...this.#store.leadActivities
        .filter((event) => tenantLeadIds.has(event.leadId))
        .map((event) => ({
          sourceKind: "lead_activity" as const,
          event,
          occurredAt: event.createdAt
        })),
      ...this.#store.dealEvents
        .filter((event) =>
          (event.ownerIdSnapshot === scope.ownerId
            && event.teamIdSnapshot === scope.teamId)
          || ((!event.ownerIdSnapshot || !event.teamIdSnapshot)
            && tenantDealIds.has(event.dealId)))
        .map((event) => ({
          sourceKind: "deal_event" as const,
          event,
          occurredAt: event.createdAt
        }))
    ].filter((item) =>
      !processed.has(`${item.sourceKind}\u001f${item.event.id}`))
      .sort((left, right) =>
        left.occurredAt.localeCompare(right.occurredAt)
        || left.sourceKind.localeCompare(right.sourceKind)
        || left.event.id.localeCompare(right.event.id))
      .slice(0, limit);
    const result: AcquisitionCrmOutcomeReconciliationResult = {
      scanned: sources.length,
      reconciled: 0,
      skipped: 0,
      failed: 0,
      lastReconciledAt: new Date(this.#now()).toISOString()
    };
    for (const source of sources) {
      const mapped = await (source.sourceKind === "lead_activity"
        ? this.#leadActivityInput(source.event as LeadActivity)
        : this.#dealEventInput(source.event as DealEvent));
      let advance = true;
      if (!mapped) {
        result.skipped += 1;
      } else if ("diagnostic" in mapped && mapped.diagnostic) {
        await this.#recordDiagnostic(mapped.diagnostic, result.lastReconciledAt);
        result.skipped += 1;
      } else {
        try {
          const authority = source.sourceKind === "deal_event"
            ? {
              capability: "acquisition.outcome.reconcile.internal" as const,
              sourceStableKey: `deal-event:${source.event.id}`
            }
            : undefined;
          await this.#outcomeRecorder.recordOutcome(
            mapped.scope,
            mapped.input,
            authority
          );
          result.reconciled += 1;
        } catch (error) {
          result.failed += 1;
          advance = false;
          await this.#recordDiagnostic({
            ownerId: mapped.scope.ownerId,
            teamId: mapped.scope.teamId,
            sourceKind: source.sourceKind,
            sourceId: source.event.id,
            candidateId: mapped.input.candidateId,
            code: "outcome_write_failed",
            message: error instanceof Error
              ? error.message
              : "Outcome write failed",
            occurredAt: source.occurredAt
          }, result.lastReconciledAt);
        }
      }
      if (!advance) break;
      await this.#markProcessed(scope, source, result.lastReconciledAt);
    }
    return result;
  }

  async #leadActivityInput(activity: LeadActivity) {
    if (!CONTACT_ACTIVITY_TYPES.has(activity.type)) return null;
    const lead = this.#store.leads.find((item) => item.id === activity.leadId);
    if (!lead) return null;
    return this.#outcomeInput({
      sourceKind: "lead_activity",
      sourceId: activity.id,
      lead,
      customerId: lead.convertedCustomerId || null,
      eventType: "contacted",
      occurredAt: activity.createdAt,
      amount: null,
      reasonText: activity.content
    });
  }

  async #dealEventInput(event: DealEvent) {
    const eventType = DEAL_OUTCOMES[event.type];
    if (!eventType) return null;
    const deal = this.#store.deals.find((item) => item.id === event.dealId);
    const ownerId = event.ownerIdSnapshot || deal?.ownerId || "";
    const teamId = event.teamIdSnapshot || deal?.teamId || "";
    const commercialAuthority = event.commercialAuthority
      ?? "legacy_unverified";
    if (commercialAuthority === "pre_quote_disqualified") return null;
    const exactQuoteProjection = commercialAuthority === "quote_projection"
      && Boolean(event.quoteCaseIdSnapshot?.trim())
      && Boolean(event.quoteVersionIdSnapshot?.trim())
      && /^sha256:[0-9a-f]{64}$/.test(event.commercialAmountHash ?? "")
      && Number.isSafeInteger(event.dealAuthorityRevisionSnapshot)
      && Number(event.dealAuthorityRevisionSnapshot) > 0;
    if (!exactQuoteProjection) {
      return ownerId && teamId ? { diagnostic: {
        ownerId,
        teamId,
        sourceKind: "deal_event" as const,
        sourceId: event.id,
        candidateId: event.candidateIdSnapshot ?? null,
        code: "commercial_authority_unverified" as const,
        message: "DealEvent does not carry verified Quote projection authority",
        occurredAt: event.createdAt
      } } : null;
    }
    const completeSnapshot = Boolean(event.ownerIdSnapshot
      && event.teamIdSnapshot && event.customerIdSnapshot
      && event.leadIdSnapshot && event.handoffIdSnapshot
      && event.candidateIdSnapshot && amountForDealEvent(event)
      && event.commercialBindingSnapshot
      && event.commercialBindingEvidence);
    if (!completeSnapshot) {
      return ownerId && teamId ? { diagnostic: {
        ownerId,
        teamId,
        sourceKind: "deal_event" as const,
        sourceId: event.id,
        candidateId: event.candidateIdSnapshot ?? null,
        code: "commercial_authority_mismatch" as const,
        message: "DealEvent is missing its frozen commercial authority",
        occurredAt: event.createdAt
      } } : null;
    }
    const snapshot = event.commercialBindingSnapshot!;
    const evidence = event.commercialBindingEvidence!;
    const amount = amountForDealEvent(event)!;
    let authorityEvent: DealAuthoritativeQuoteEvent | undefined;
    let version: QuoteVersion | null = null;
    try {
      assertFrozenCommercialBinding(snapshot, evidence);
      authorityEvent = (await this.#commercialAuthority?.listAuthorityEvents(
        event.teamIdSnapshot!, event.dealId))?.find((item) =>
          item.authorityRevision === event.dealAuthorityRevisionSnapshot);
      version = this.#commercialAuthority
        ? await this.#commercialAuthority.getVersion(
            event.teamIdSnapshot!, event.quoteVersionIdSnapshot!)
        : null;
    } catch {
      authorityEvent = undefined;
    }
    const expectedAuthorityType = event.type === "quote" ? "approved"
      : event.type;
    const bindingMatches = await this.#persistedBindingMatches(
      event, snapshot, evidence
    );
    const exactAuthority = authorityEvent
      && authorityEvent.eventType === expectedAuthorityType
      && authorityEvent.dealId === event.dealId
      && authorityEvent.quoteCaseId === event.quoteCaseIdSnapshot
      && authorityEvent.quoteVersionId === event.quoteVersionIdSnapshot
      && authorityEvent.commercialAmountHash === event.commercialAmountHash
      && authorityEvent.currency === amount.currency
      && authorityEvent.quotedAmountMinor === amount.amountMinor
      && canonicalJsonStringify(authorityEvent.commercialBindingSnapshot)
        === canonicalJsonStringify(snapshot)
      && canonicalJsonStringify(authorityEvent.commercialBindingEvidence)
        === canonicalJsonStringify(evidence)
      && version?.versionKind === "formal"
      && version.quoteCaseId === event.quoteCaseIdSnapshot
      && version.commercialAmountHash === event.commercialAmountHash
      && version.currency === amount.currency
      && version.quotedAmountMinor === amount.amountMinor
      && canonicalJsonStringify(version.commercialBindingSnapshot)
        === canonicalJsonStringify(snapshot)
      && bindingMatches;
    if (!exactAuthority) {
      return { diagnostic: {
        ownerId: event.ownerIdSnapshot!,
        teamId: event.teamIdSnapshot!,
        sourceKind: "deal_event" as const,
        sourceId: event.id,
        candidateId: event.candidateIdSnapshot,
        code: "commercial_authority_mismatch" as const,
        message: "DealEvent does not match an immutable Quote authority event",
        occurredAt: event.createdAt
      } };
    }
    return this.#outcomeInput({
      sourceKind: "deal_event",
      sourceId: event.id,
      lead: {
        id: event.leadIdSnapshot!, ownerId: event.ownerIdSnapshot!,
        teamId: event.teamIdSnapshot!,
        convertedCustomerId: event.customerIdSnapshot!,
        convertedDealId: event.dealId,
        externalId: event.candidateIdSnapshot!
      },
      customerId: event.customerIdSnapshot,
      eventType,
      occurredAt: event.occurredAt ?? event.createdAt,
      amount,
      reasonText: event.reasonText ?? event.content,
      frozenCandidateId: snapshot.candidateId,
      frozenAttribution: snapshot.attributionSnapshot
    });
  }

  async #persistedBindingMatches(
    event: DealEvent,
    snapshot: NonNullable<DealEvent["commercialBindingSnapshot"]>,
    evidence: NonNullable<DealEvent["commercialBindingEvidence"]>
  ): Promise<boolean> {
    if (!this.#bindingVerifier) {
      return snapshot.dealId === event.dealId
        && snapshot.customerId === event.customerIdSnapshot
        && snapshot.candidateId === event.candidateIdSnapshot
        && snapshot.leadId === event.leadIdSnapshot
        && snapshot.handoffId === event.handoffIdSnapshot
        && evidence.dealId === event.dealId
        && evidence.customerId === event.customerIdSnapshot
        && evidence.candidateId === event.candidateIdSnapshot;
    }
    try {
      const verified = await this.#bindingVerifier.verify(
        { workspaceId: event.teamIdSnapshot! } as ActiveWorkspaceContext,
        {
          candidateId: event.candidateIdSnapshot!,
          customerId: event.customerIdSnapshot!,
          dealId: event.dealId
        }
      );
      return matchesCommercialBindingEvidence(verified, evidence);
    } catch {
      return false;
    }
  }

  async #outcomeInput(input: {
    sourceKind: "lead_activity" | "deal_event";
    sourceId: string;
    lead: ReconciliationLead;
    customerId: string | null;
    eventType: OutcomeEventType;
    occurredAt: string;
    amount: OutcomeInput["amount"];
    reasonText: string;
    frozenCandidateId?: string;
    frozenAttribution?: OutcomeAttributionInput;
  }) {
    const source = this.#store.leadSourceEvents
      .filter((item) =>
        item.leadId === input.lead.id
        && item.channel === "acquisition_private_domain_handoff_snapshot")
      .sort((left, right) =>
        right.receivedAt.localeCompare(left.receivedAt)
        || right.id.localeCompare(left.id))[0];
    const baseDiagnostic = {
      ownerId: input.lead.ownerId,
      teamId: input.lead.teamId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      candidateId: source?.externalId ?? null,
      occurredAt: input.occurredAt
    };
    if (!source && !input.frozenAttribution) {
      return { diagnostic: {
        ...baseDiagnostic,
        code: "attribution_missing" as const,
        message: "Acquisition handoff attribution is missing"
      } };
    }
    if (source && (source.ownerId !== input.lead.ownerId
      || source.teamId !== input.lead.teamId)) {
      return { diagnostic: {
        ...baseDiagnostic,
        code: "attribution_cross_tenant" as const,
        message: "Acquisition handoff attribution crosses tenant scope"
      } };
    }
    let payload: Record<string, unknown>;
    try {
      payload = source
        ? JSON.parse(source.rawPayload) as Record<string, unknown>
        : {};
    } catch {
      payload = {};
    }
    const candidateId = input.frozenCandidateId ?? (isText(payload.candidateId)
      ? payload.candidateId
      : source?.externalId ?? "");
    const acquisitionAttribution = input.frozenAttribution
      ?? payload.acquisitionAttribution;
    if (!candidateId
      || (!input.frozenCandidateId && candidateId !== source?.externalId)
      || candidateId !== input.lead.externalId
      || !validAttribution(acquisitionAttribution)) {
      return { diagnostic: {
        ...baseDiagnostic,
        candidateId: candidateId || null,
        code: acquisitionAttribution === null
          ? "attribution_missing" as const
          : "attribution_invalid" as const,
        message: "Acquisition handoff attribution is absent or invalid"
      } };
    }
    const attributionValidation = await this.#validateAttribution(
      { ownerId: input.lead.ownerId, teamId: input.lead.teamId },
      candidateId,
      acquisitionAttribution
    );
    if (attributionValidation) {
      return { diagnostic: {
        ...baseDiagnostic,
        candidateId,
        code: attributionValidation,
        message: "Persisted acquisition attribution chain does not match"
      } };
    }
    const scope: AcquisitionActorScope = {
      ownerId: input.lead.ownerId,
      teamId: input.lead.teamId,
      actorId: "acquisition-crm-reconciliation"
    };
    const outcome: OutcomeInput = {
      leadId: input.lead.id,
      customerId: input.customerId,
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      amount: input.amount,
      reasonCode: `crm_${input.sourceKind}_${input.eventType}`,
      reasonText: input.reasonText || null,
      candidateId,
      idempotencyKey: `crm:${input.sourceKind.replace("_", "-")}:${input.sourceId}`,
      attribution: structuredClone(acquisitionAttribution)
    };
    return { scope, input: outcome };
  }

  async #validateAttribution(
    scope: { ownerId: string; teamId: string },
    candidateId: string,
    attribution: ReconciledOutcomeAttribution
  ): Promise<"attribution_invalid" | "attribution_cross_tenant" | null> {
    const run = await this.#planRuns.getRun(attribution.runId);
    if (!run) return "attribution_invalid";
    if (run.ownerId !== scope.ownerId || run.teamId !== scope.teamId) {
      return "attribution_cross_tenant";
    }
    if (run.planId !== attribution.planId
      || run.planVersionId !== attribution.planVersionId
      || run.planVersion !== attribution.planVersion
      || run.planSnapshotHash !== attribution.planSnapshotHash) {
      return "attribution_invalid";
    }
    const event = (await this.#planRuns.listRunEvents(run.id)).find((item) =>
      item.id === attribution.discoveredEventId
      && item.runId === run.id
      && item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
      && item.type === "candidate.discovered"
      && item.shardId === attribution.shardId
      && item.at === attribution.discoveredAt
      && item.data.candidateId === candidateId
      && item.data.operationId === attribution.operationId
      && item.data.connectionId === attribution.connectionId);
    if (!event) return "attribution_invalid";
    const shard = (await this.#planRuns.listRunShards(run.id)).find((item) =>
      item.id === attribution.shardId
      && item.runId === run.id
      && item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
      && item.operationId === attribution.operationId
      && item.connection.connectionId === attribution.connectionId
      && item.connection.providerId === attribution.providerId);
    if (!shard
      || !attribution.providerIds.includes(attribution.providerId)
      || !attribution.queryIds.includes(`operation:${attribution.operationId}`)) {
      return "attribution_invalid";
    }
    return null;
  }

  async #recordDiagnostic(
    input: Omit<AcquisitionOutcomeReconciliationDiagnostic, "id" | "createdAt">,
    createdAt: string
  ) {
    const id = diagnosticId(input.sourceKind, input.sourceId, input.code);
    if (this.#store.acquisitionOutcomeReconciliationDiagnostics.some(
      (item) => item.id === id
    )) return;
    const diagnostic = {
      id,
      ...input,
      message: input.message.slice(0, 500),
      createdAt
    };
    this.#store.acquisitionOutcomeReconciliationDiagnostics.push(diagnostic);
    try {
      await this.#store.persist();
    } catch (error) {
      const index = this.#store.acquisitionOutcomeReconciliationDiagnostics
        .findIndex((item) => item.id === diagnostic.id);
      if (index >= 0) {
        this.#store.acquisitionOutcomeReconciliationDiagnostics.splice(index, 1);
      }
      throw error;
    }
  }

  async #markProcessed(
    scope: { ownerId: string; teamId: string },
    source: {
      occurredAt: string;
      sourceKind: "lead_activity" | "deal_event";
      event: { id: string };
    },
    processedAt: string
  ) {
    const ledger = this.#store.acquisitionOutcomeReconciliationProcessedSources;
    const processed = {
      ...scope,
      sourceKind: source.sourceKind,
      sourceId: source.event.id,
      occurredAt: source.occurredAt,
      processedAt
    };
    ledger.push(processed);
    const checkpoints = this.#store.acquisitionOutcomeReconciliationCheckpoints;
    const index = checkpoints.findIndex((item) =>
      item.ownerId === scope.ownerId && item.teamId === scope.teamId);
    const previous = index >= 0 ? structuredClone(checkpoints[index]) : null;
    const previousCursor = previous
      ? [
          previous.cursorOccurredAt,
          previous.cursorSourceKind,
          previous.cursorSourceId
        ].join("\u001f")
      : "";
    const sourceCursor = [
      source.occurredAt,
      source.sourceKind,
      source.event.id
    ].join("\u001f");
    const cursor = previous && previousCursor > sourceCursor
      ? {
          cursorOccurredAt: previous.cursorOccurredAt,
          cursorSourceKind: previous.cursorSourceKind,
          cursorSourceId: previous.cursorSourceId
        }
      : {
          cursorOccurredAt: source.occurredAt,
          cursorSourceKind: source.sourceKind,
          cursorSourceId: source.event.id
        };
    const next = { ...scope, ...cursor, updatedAt: processedAt };
    if (index >= 0) checkpoints[index] = next;
    else checkpoints.push(next);
    try {
      await this.#store.persist();
    } catch (error) {
      const ledgerIndex = ledger.findIndex((item) =>
        item.ownerId === processed.ownerId
        && item.teamId === processed.teamId
        && item.sourceKind === processed.sourceKind
        && item.sourceId === processed.sourceId);
      if (ledgerIndex >= 0) ledger.splice(ledgerIndex, 1);
      if (index >= 0 && previous) checkpoints[index] = previous;
      else checkpoints.pop();
      throw error;
    }
  }
}
