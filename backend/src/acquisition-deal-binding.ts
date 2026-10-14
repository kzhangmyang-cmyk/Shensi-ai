import { isOutcomeAttributionShape } from "./acquisition-outcome-attribution.js";
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
  if (!isOutcomeAttributionShape(handoff.acquisitionAttribution)
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
