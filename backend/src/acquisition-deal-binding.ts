import type { OutcomeAttributionInput } from "./acquisition-domain.js";
import type { CrmStore } from "./store.js";
import type { AcquisitionCustomerHandoff, Lead } from "./types.js";

type AcquisitionDealBindingHandoffRow = Pick<
  AcquisitionCustomerHandoff,
  | "id"
  | "ownerId"
  | "teamId"
  | "candidateId"
  | "leadId"
  | "customerId"
  | "dealId"
  | "decisionVersion"
  | "acquisitionAttribution"
>;

type AcquisitionDealBindingLeadRow = Pick<
  Lead,
  | "id"
  | "ownerId"
  | "teamId"
  | "convertedCustomerId"
  | "convertedDealId"
  | "externalId"
>;

export interface AcquisitionDealBindingStore<
  Handoff extends AcquisitionDealBindingHandoffRow =
    AcquisitionDealBindingHandoffRow,
  BindingLead extends AcquisitionDealBindingLeadRow =
    AcquisitionDealBindingLeadRow
> {
  acquisitionCustomerHandoffs: Handoff[];
  leads: BindingLead[];
}

export interface TrustedAcquisitionDealBinding {
  handoff: AcquisitionCustomerHandoff;
  lead: Lead;
}

export type AcquisitionDealBindingLookup = {
  handoffId: string;
  leadId: string;
  ownerId: string;
  teamId: string;
  customerId: string;
} | {
  dealId: string;
};

function isTrustedAcquisitionAttribution(
  value: unknown
): value is OutcomeAttributionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attribution = value as Record<string, unknown>;
  const requiredTextFields = [
    "runId", "planId", "planVersionId", "planSnapshotHash",
    "discoveredEventId", "discoveredAt", "shardId", "operationId",
    "connectionId", "providerId", "strategyVersion",
    "qualificationDecisionId", "decisionVersion", "decisionSnapshotHash"
  ];
  const stringListFields = ["evidenceIds", "providerIds", "queryIds"];
  return attribution.attributionVersion === "acquisition-run.v1"
    && requiredTextFields.every((field) =>
      typeof attribution[field] === "string"
      && Boolean(String(attribution[field]).trim()))
    && Number.isSafeInteger(attribution.planVersion)
    && Number(attribution.planVersion) > 0
    && Number.isFinite(Date.parse(String(attribution.discoveredAt)))
    && stringListFields.every((field) =>
      Array.isArray(attribution[field])
      && (attribution[field] as unknown[]).every((item) =>
        typeof item === "string" && Boolean(item.trim())));
}

export function resolveTrustedAcquisitionDealBinding(
  store: Pick<CrmStore, "acquisitionCustomerHandoffs" | "leads">,
  lookup: AcquisitionDealBindingLookup
): TrustedAcquisitionDealBinding | null;
export function resolveTrustedAcquisitionDealBinding<
  Handoff extends AcquisitionDealBindingHandoffRow,
  BindingLead extends AcquisitionDealBindingLeadRow
>(
  store: AcquisitionDealBindingStore<Handoff, BindingLead>,
  lookup: AcquisitionDealBindingLookup
): { handoff: Handoff; lead: BindingLead } | null;
export function resolveTrustedAcquisitionDealBinding<
  Handoff extends AcquisitionDealBindingHandoffRow,
  BindingLead extends AcquisitionDealBindingLeadRow
>(
  store: AcquisitionDealBindingStore<Handoff, BindingLead>,
  lookup: AcquisitionDealBindingLookup
): { handoff: Handoff; lead: BindingLead } | null {
  const handoffs = store.acquisitionCustomerHandoffs.filter((handoff) =>
    "dealId" in lookup
      ? handoff.dealId === lookup.dealId
      : handoff.id === lookup.handoffId
        && handoff.leadId === lookup.leadId
        && handoff.ownerId === lookup.ownerId
        && handoff.teamId === lookup.teamId
        && handoff.customerId === lookup.customerId);
  if (handoffs.length !== 1) return null;
  const handoff = handoffs[0]!;
  if (!isTrustedAcquisitionAttribution(handoff.acquisitionAttribution)
    || handoff.acquisitionAttribution.decisionVersion
      !== handoff.decisionVersion) return null;
  const leads = store.leads.filter((lead) =>
    lead.id === handoff.leadId
    && lead.ownerId === handoff.ownerId
    && lead.teamId === handoff.teamId
    && lead.convertedCustomerId === handoff.customerId
    && lead.externalId === handoff.candidateId);
  if (leads.length !== 1) return null;
  const lead = leads[0]!;
  if ("dealId" in lookup && lead.convertedDealId !== lookup.dealId) return null;
  return { handoff, lead };
}
