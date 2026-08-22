import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import { resolveTrustedAcquisitionDealBinding } from "./acquisition-deal-binding.js";
import type { AcquisitionCandidate } from "./acquisition-domain.js";
import type { OutcomeAttributionInput } from "./acquisition-domain.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { AcquisitionCustomerHandoff, Customer, Deal, Lead } from "./types.js";

export const BINDING_HASH_SCHEMA_VERSION = "commercial-binding.v1" as const;
export type CommercialBindingHash = `sha256:${string}`;

export interface CommercialBindingSnapshot {
  readonly candidateId: string;
  readonly handoffId: string;
  readonly leadId: string | null;
  readonly customerId: string;
  readonly dealId: string;
  readonly candidateVersion: number;
  readonly handoffContentHash: CommercialBindingHash;
  readonly dealContentHash: CommercialBindingHash;
  readonly bindingHashSchemaVersion: typeof BINDING_HASH_SCHEMA_VERSION;
  readonly attributionSnapshot: OutcomeAttributionInput;
  readonly bindingHash: CommercialBindingHash;
  readonly verifiedAt: string;
}

export interface CommercialBindingInput {
  readonly candidate: Pick<AcquisitionCandidate,
    "id" | "ownerId" | "teamId" | "version">;
  readonly handoff: AcquisitionCustomerHandoff;
  readonly lead: Pick<Lead,
    "id" | "ownerId" | "teamId" | "convertedCustomerId"
    | "convertedDealId" | "externalId">;
  readonly customer: Pick<Customer, "id" | "ownerId" | "teamId">;
  readonly deal: Deal;
  readonly verifiedAt: string;
}

function bindingError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function hash(value: unknown): CommercialBindingHash {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value) ?? "")
    .digest("hex")}`;
}

function frozenAttribution(value: OutcomeAttributionInput | null) {
  if (!value) throw bindingError("commercial_binding_authority_mismatch");
  return Object.freeze(structuredClone(value));
}

function assertChain(input: CommercialBindingInput): void {
  const { candidate, handoff, lead, customer, deal } = input;
  const workspace = candidate.teamId;
  if (!workspace.trim() || workspace === "all"
    || handoff.teamId !== workspace || lead.teamId !== workspace
    || customer.teamId !== workspace || deal.teamId !== workspace
    || handoff.ownerId !== candidate.ownerId || lead.ownerId !== candidate.ownerId
    || customer.ownerId !== candidate.ownerId || deal.ownerId !== candidate.ownerId
    || handoff.candidateId !== candidate.id || handoff.leadId !== lead.id
    || handoff.customerId !== customer.id || handoff.dealId !== deal.id
    || lead.externalId !== candidate.id
    || lead.convertedCustomerId !== customer.id
    || lead.convertedDealId !== deal.id || deal.customerId !== customer.id
    || !Number.isSafeInteger(candidate.version) || candidate.version < 1) {
    throw bindingError("commercial_binding_authority_mismatch");
  }
}

function handoffAuthority(input: CommercialBindingInput) {
  return {
    id: input.handoff.id,
    ownerId: input.handoff.ownerId,
    teamId: input.handoff.teamId,
    candidateId: input.handoff.candidateId,
    leadId: input.handoff.leadId,
    customerId: input.handoff.customerId,
    dealId: input.handoff.dealId ?? null,
    decisionVersion: input.handoff.decisionVersion,
    mode: input.handoff.mode,
    processingKeyHash: input.handoff.processingKeyHash,
    acceptedProcessingKeyHashes: input.handoff.acceptedProcessingKeyHashes,
    requestHash: input.handoff.requestHash,
    qualificationSnapshotHash: input.handoff.qualificationSnapshotHash,
    financialSnapshotHash: input.handoff.financialSnapshotHash,
    acquisitionAttribution: input.handoff.acquisitionAttribution,
    createdAt: input.handoff.createdAt,
    candidateVersion: input.candidate.version
  };
}

function dealAuthority(input: CommercialBindingInput) {
  return {
    id: input.deal.id,
    customerId: input.deal.customerId,
    ownerId: input.deal.ownerId,
    teamId: input.deal.teamId
  };
}

export function createCommercialBindingSnapshot(
  input: CommercialBindingInput
): CommercialBindingSnapshot {
  assertChain(input);
  const attributionSnapshot = frozenAttribution(
    input.handoff.acquisitionAttribution
  );
  const handoffContentHash = hash(handoffAuthority(input));
  const dealContentHash = hash(dealAuthority(input));
  const bindingHash = hash({
    customerId: input.customer.id,
    handoffContentHash,
    dealContentHash,
    bindingHashSchemaVersion: BINDING_HASH_SCHEMA_VERSION
  });
  return Object.freeze({
    candidateId: input.candidate.id,
    handoffId: input.handoff.id,
    leadId: input.lead.id || null,
    customerId: input.customer.id,
    dealId: input.deal.id,
    candidateVersion: input.candidate.version,
    handoffContentHash,
    dealContentHash,
    bindingHashSchemaVersion: BINDING_HASH_SCHEMA_VERSION,
    attributionSnapshot,
    bindingHash,
    verifiedAt: new Date(input.verifiedAt).toISOString()
  });
}

export function verifyCommercialBindingSnapshot(
  snapshot: CommercialBindingSnapshot,
  current: CommercialBindingInput
): boolean {
  try {
    const expected = createCommercialBindingSnapshot(current);
    return snapshot.candidateId === expected.candidateId
      && snapshot.handoffId === expected.handoffId
      && snapshot.leadId === expected.leadId
      && snapshot.customerId === expected.customerId
      && snapshot.dealId === expected.dealId
      && snapshot.candidateVersion === expected.candidateVersion
      && snapshot.handoffContentHash === expected.handoffContentHash
      && snapshot.dealContentHash === expected.dealContentHash
      && snapshot.bindingHashSchemaVersion === BINDING_HASH_SCHEMA_VERSION
      && snapshot.bindingHash === expected.bindingHash;
  } catch {
    return false;
  }
}

export interface CommercialBindingAuthoritySource {
  readonly acquisitionCustomerHandoffs: AcquisitionCustomerHandoff[];
  readonly leads: Lead[];
  readonly customers: Customer[];
  readonly deals: Deal[];
  findCandidate(
    workspaceId: string,
    candidateId: string
  ): Promise<Pick<AcquisitionCandidate, "id" | "ownerId" | "teamId" | "version"> | null>;
  findCurrentDealAuthority?(workspaceId: string, dealId: string): Promise<{
    workspaceId: string;
    dealId: string;
    customerId: string;
    dealContentHash: CommercialBindingHash;
    authorityRevision: number;
  } | null>;
}

export class CommercialBindingVerifier {
  constructor(
    private readonly source: CommercialBindingAuthoritySource,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async verify(
    context: ActiveWorkspaceContext,
    input: { candidateId: string; customerId: string; dealId: string }
  ): Promise<CommercialBindingSnapshot> {
    const candidate = await this.source.findCandidate(
      context.workspaceId,
      input.candidateId
    );
    const trusted = resolveTrustedAcquisitionDealBinding(this.source, {
      dealId: input.dealId
    });
    const customers = this.source.customers.filter((row) =>
      row.id === input.customerId && row.teamId === context.workspaceId);
    const deals = this.source.deals.filter((row) =>
      row.id === input.dealId && row.teamId === context.workspaceId);
    if (!candidate || candidate.teamId !== context.workspaceId
      || candidate.id !== input.candidateId || !trusted
      || trusted.handoff.candidateId !== input.candidateId
      || trusted.handoff.customerId !== input.customerId
      || customers.length !== 1 || deals.length !== 1) {
      throw bindingError("commercial_binding_authority_mismatch");
    }
    const current: CommercialBindingInput = {
      candidate,
      handoff: trusted.handoff,
      lead: trusted.lead,
      customer: customers[0]!,
      deal: deals[0]!,
      verifiedAt: this.now()
    };
    const snapshot = createCommercialBindingSnapshot(current);
    const authority = await this.source.findCurrentDealAuthority?.(
      context.workspaceId,
      input.dealId
    );
    if (authority && (authority.workspaceId !== context.workspaceId
      || authority.dealId !== input.dealId
      || authority.customerId !== input.customerId
      || authority.dealContentHash !== snapshot.dealContentHash
      || !Number.isSafeInteger(authority.authorityRevision)
      || authority.authorityRevision < 1)) {
      throw bindingError("commercial_binding_authority_mismatch");
    }
    return snapshot;
  }
}
