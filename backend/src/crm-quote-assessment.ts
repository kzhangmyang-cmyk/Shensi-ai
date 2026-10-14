import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import type { Customer, Deal } from "./types.js";

export const CRM_QUOTE_ASSESSMENT_VERSION = "crm-quote-assessment.v1" as const;
export const CRM_QUOTE_AUTHORITY_VERSION = "crm-quote-authority.v1" as const;
export type CrmQuoteHash = `sha256:${string}`;

export interface CrmQuoteAssessmentInput {
  readonly demandConfirmed: boolean;
  readonly budgetConfirmed: boolean;
  readonly decisionMakerConfirmed: boolean;
  readonly closeProbabilityBps: number;
  readonly evidenceSummary: string;
}

export interface CrmQuoteAssessmentSnapshot extends CrmQuoteAssessmentInput {
  readonly sourceKind: "crm";
  readonly assessmentVersion: typeof CRM_QUOTE_ASSESSMENT_VERSION;
  readonly workspaceId: string;
  readonly customerId: string;
  readonly dealId: string;
  readonly assessedBy: string;
  readonly assessedAt: string;
  readonly inputSnapshotHash: CrmQuoteHash;
  readonly precision: "bps";
}

export interface CrmQuoteAuthoritySnapshot {
  readonly sourceKind: "crm";
  readonly workspaceId: string;
  readonly customerId: string;
  readonly dealId: string;
  readonly dealContentHash: CrmQuoteHash;
  readonly bindingHashSchemaVersion: typeof CRM_QUOTE_AUTHORITY_VERSION;
  readonly bindingHash: CrmQuoteHash;
  readonly assessment: CrmQuoteAssessmentSnapshot;
  readonly verifiedAt: string;
}

interface CrmQuoteAuthorityContext {
  readonly workspaceId: string;
  readonly actorId: string;
}

interface CrmQuoteAuthoritySource {
  readonly context: CrmQuoteAuthorityContext;
  readonly customer: Pick<Customer, "id" | "ownerId" | "teamId">;
  readonly deal: Deal;
}

interface CreateCrmQuoteAuthorityInput extends CrmQuoteAuthoritySource {
  readonly assessment: CrmQuoteAssessmentInput;
  readonly verifiedAt: string;
}

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function hash(value: unknown): CrmQuoteHash {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value) ?? "")
    .digest("hex")}`;
}

function instant(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail("invalid_crm_quote_assessment_time");
  return date.toISOString();
}

function dealAuthority(deal: Deal) {
  return {
    id: deal.id,
    customerId: deal.customerId,
    title: deal.title,
    stage: deal.stage,
    product: deal.product,
    quantity: deal.quantity,
    unitPrice: deal.unitPrice,
    amount: deal.amount,
    currency: deal.currency,
    amountType: deal.amountType,
    ownerId: deal.ownerId,
    teamId: deal.teamId,
    nextAction: deal.nextAction,
    nextActionAt: deal.nextActionAt,
    expectedCloseAt: deal.expectedCloseAt,
    stageChangedAt: deal.stageChangedAt
  };
}

function assertSource(input: CrmQuoteAuthoritySource): void {
  const { context, customer, deal } = input;
  if (!context.workspaceId.trim() || context.workspaceId === "all"
    || !context.actorId.trim()
    || customer.teamId !== context.workspaceId
    || deal.teamId !== context.workspaceId
    || deal.customerId !== customer.id
    || customer.ownerId !== deal.ownerId) {
    fail("crm_quote_authority_mismatch");
  }
}

function assessmentInput(input: CrmQuoteAssessmentInput) {
  const evidenceSummary = input.evidenceSummary.trim();
  if (typeof input.demandConfirmed !== "boolean"
    || typeof input.budgetConfirmed !== "boolean"
    || typeof input.decisionMakerConfirmed !== "boolean"
    || !evidenceSummary || evidenceSummary.length > 1_000
    || !Number.isSafeInteger(input.closeProbabilityBps)
    || input.closeProbabilityBps < 0 || input.closeProbabilityBps > 10_000) {
    fail("invalid_crm_quote_assessment");
  }
  return {
    demandConfirmed: input.demandConfirmed,
    budgetConfirmed: input.budgetConfirmed,
    decisionMakerConfirmed: input.decisionMakerConfirmed,
    closeProbabilityBps: input.closeProbabilityBps,
    evidenceSummary
  };
}

export function isCrmQuoteAuthoritySnapshot(
  value: unknown
): value is CrmQuoteAuthoritySnapshot {
  return Boolean(value && typeof value === "object"
    && Reflect.get(value, "sourceKind") === "crm"
    && Reflect.get(value, "bindingHashSchemaVersion")
      === CRM_QUOTE_AUTHORITY_VERSION);
}

export function isCrmQuoteAssessmentSnapshot(
  value: unknown
): value is CrmQuoteAssessmentSnapshot {
  return Boolean(value && typeof value === "object"
    && Reflect.get(value, "sourceKind") === "crm"
    && Reflect.get(value, "assessmentVersion")
      === CRM_QUOTE_ASSESSMENT_VERSION
    && Reflect.get(value, "precision") === "bps");
}

export function createCrmQuoteAuthoritySnapshot(
  input: CreateCrmQuoteAuthorityInput
): CrmQuoteAuthoritySnapshot {
  assertSource(input);
  if (input.context.actorId !== input.deal.ownerId) {
    fail("crm_quote_authority_mismatch");
  }
  const assessedAt = instant(input.verifiedAt);
  const normalized = assessmentInput(input.assessment);
  const assessmentIdentity = {
    assessmentVersion: CRM_QUOTE_ASSESSMENT_VERSION,
    workspaceId: input.context.workspaceId,
    customerId: input.customer.id,
    dealId: input.deal.id,
    assessedBy: input.context.actorId,
    assessedAt,
    ...normalized
  };
  const assessment = Object.freeze({
    sourceKind: "crm" as const,
    ...assessmentIdentity,
    inputSnapshotHash: hash(assessmentIdentity),
    precision: "bps" as const
  });
  const dealContentHash = hash(dealAuthority(input.deal));
  const bindingHash = hash({
    bindingHashSchemaVersion: CRM_QUOTE_AUTHORITY_VERSION,
    workspaceId: input.context.workspaceId,
    customerId: input.customer.id,
    dealId: input.deal.id,
    dealContentHash,
    assessmentHash: assessment.inputSnapshotHash
  });
  return Object.freeze({
    sourceKind: "crm",
    workspaceId: input.context.workspaceId,
    customerId: input.customer.id,
    dealId: input.deal.id,
    dealContentHash,
    bindingHashSchemaVersion: CRM_QUOTE_AUTHORITY_VERSION,
    bindingHash,
    assessment,
    verifiedAt: assessedAt
  });
}

export function verifyCrmQuoteAuthoritySnapshot(
  snapshot: CrmQuoteAuthoritySnapshot,
  current: CrmQuoteAuthoritySource
): boolean {
  try {
    assertSource(current);
    if (!isCrmQuoteAuthoritySnapshot(snapshot)
      || snapshot.workspaceId !== current.context.workspaceId
      || snapshot.customerId !== current.customer.id
      || snapshot.dealId !== current.deal.id
      || snapshot.assessment.assessedBy !== current.deal.ownerId) {
      return false;
    }
    const recreated = createCrmQuoteAuthoritySnapshot({
      ...current,
      context: {
        workspaceId: current.context.workspaceId,
        actorId: snapshot.assessment.assessedBy
      },
      assessment: snapshot.assessment,
      verifiedAt: snapshot.verifiedAt
    });
    return recreated.dealContentHash === snapshot.dealContentHash
      && recreated.assessment.inputSnapshotHash
        === snapshot.assessment.inputSnapshotHash
      && recreated.bindingHash === snapshot.bindingHash;
  } catch {
    return false;
  }
}

export class CrmQuoteAuthorityVerifier {
  constructor(private readonly source: {
    readonly customers: Customer[];
    readonly deals: Deal[];
  }, private readonly now: () => string = () => new Date().toISOString()) {}

  create(context: CrmQuoteAuthorityContext, input: {
    customerId: string;
    dealId: string;
    assessment: CrmQuoteAssessmentInput;
  }): CrmQuoteAuthoritySnapshot {
    const customer = this.source.customers.find((row) => row.id === input.customerId
      && row.teamId === context.workspaceId);
    const deal = this.source.deals.find((row) => row.id === input.dealId
      && row.teamId === context.workspaceId);
    if (!customer || !deal) fail("crm_quote_authority_mismatch");
    return createCrmQuoteAuthoritySnapshot({
      context,
      customer,
      deal,
      assessment: input.assessment,
      verifiedAt: this.now()
    });
  }

  verify(context: CrmQuoteAuthorityContext,
    snapshot: CrmQuoteAuthoritySnapshot): CrmQuoteAuthoritySnapshot {
    const customer = this.source.customers.find((row) => row.id === snapshot.customerId
      && row.teamId === context.workspaceId);
    const deal = this.source.deals.find((row) => row.id === snapshot.dealId
      && row.teamId === context.workspaceId);
    if (!customer || !deal || !verifyCrmQuoteAuthoritySnapshot(snapshot, {
      context,
      customer,
      deal
    })) fail("crm_quote_authority_mismatch");
    return snapshot;
  }
}
