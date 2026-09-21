import { createHash } from "node:crypto";
import {
  discoveryEvidencePublicSourceUrl,
  type PartyRef
} from "./acquisition-domain.js";
import type {
  AcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import type {
  LeadConversionPort
} from "./acquisition-domain-service.js";
import type {
  AcquisitionHandoffIntelligence,
  Lead,
  LeadActivity,
  LeadSourceEvent
} from "./types.js";

export interface AcquisitionLeadStore {
  leads: Lead[];
  leadSourceEvents: LeadSourceEvent[];
  leadActivities: LeadActivity[];
  persist(): Promise<void>;
  persistMutation?<T>(mutation: () => {
    value: T;
    rollback(): void;
  }): Promise<T>;
  readBarrier(): Promise<void>;
}

export interface AcquisitionCrmLeadConversionPortOptions {
  repository: AcquisitionDomainRepository;
  store: AcquisitionLeadStore;
  now?: () => string;
}

function stableId(prefix: string, values: string[]) {
  return `${prefix}_${createHash("sha256")
    .update(values.join("\u001f"))
    .digest("hex")
    .slice(0, 40)}`;
}

function partyMatches(left: PartyRef, right: PartyRef) {
  if (left.partyType !== right.partyType) return false;
  if (left.partyType === "organization"
    && right.partyType === "organization") {
    return left.organizationId === right.organizationId
      && left.tenantProspectId === right.tenantProspectId;
  }
  return left.partyType === "individual"
    && right.partyType === "individual"
    && left.individualPartyId === right.individualPartyId;
}

function sourceUrl(
  evidence: Awaited<
    ReturnType<AcquisitionDomainRepository["findEvidence"]>
  >[]
) {
  for (const item of evidence) {
    if (!item) continue;
    const publicSourceUrl = discoveryEvidencePublicSourceUrl(item);
    if (publicSourceUrl) return publicSourceUrl;
  }
  return "";
}

function removeById<T extends { id: string }>(values: T[], id: string) {
  const index = values.findIndex((value) => value.id === id);
  if (index >= 0) values.splice(index, 1);
}

export class AcquisitionCrmLeadConversionPort
implements LeadConversionPort {
  readonly #repository: AcquisitionDomainRepository;
  readonly #store: AcquisitionLeadStore;
  readonly #now: () => string;
  readonly #inFlight = new Map<string, Promise<{
    leadId: string;
    partyRef: PartyRef;
  }>>();

  constructor(options: AcquisitionCrmLeadConversionPortOptions) {
    this.#repository = options.repository;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async createLead(
    request: Parameters<LeadConversionPort["createLead"]>[0]
  ) {
    const candidate = await this.#repository.findCandidate(
      request,
      request.candidateId
    );
    if (!candidate) throw new Error("ACQUISITION_CANDIDATE_NOT_FOUND");
    if (!partyMatches(candidate.partyRef, request.partyRef)) {
      throw new Error("ACQUISITION_PARTY_MISMATCH");
    }
    if (candidate.approvedDecisionVersion !== request.decisionVersion) {
      throw new Error("ACQUISITION_DECISION_MISMATCH");
    }
    const key = [
      request.ownerId,
      request.teamId,
      request.candidateId
    ].join("\u001f");
    const running = this.#inFlight.get(key);
    if (running) return await running;
    const operation = this.#createLead(request, candidate);
    this.#inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.#inFlight.get(key) === operation) this.#inFlight.delete(key);
    }
  }

  async #createLead(
    request: Parameters<LeadConversionPort["createLead"]>[0],
    candidate: NonNullable<
      Awaited<ReturnType<AcquisitionDomainRepository["findCandidate"]>>
    >
  ) {
    await this.#store.readBarrier();
    const priorEvent = this.#store.leadSourceEvents.find((event) =>
      event.ownerId === request.ownerId
      && event.teamId === request.teamId
      && event.channel === "ai_acquisition"
      && event.externalId === request.candidateId
    );
    const priorLead = priorEvent
      ? this.#store.leads.find((lead) =>
          lead.id === priorEvent.leadId
          && lead.ownerId === request.ownerId
          && lead.teamId === request.teamId
        )
      : undefined;

    const evidence = await Promise.all(request.evidenceIds.map(async (id) => {
      if (!candidate.evidenceIds.includes(id)) {
        throw new Error("ACQUISITION_EVIDENCE_MISMATCH");
      }
      const value = await this.#repository.findEvidence(request, id);
      if (!value) throw new Error("ACQUISITION_EVIDENCE_NOT_FOUND");
      return value;
    }));
    const financialValues = await this.#repository.listFinancialValues(
      request,
      candidate.id
    );
    const financial = financialValues
      .filter((value) =>
        value.qualificationDecisionId === candidate.latestDecisionId
      )
      .at(-1);
    const qualifications = await this.#repository.listQualificationDecisions(
      request,
      candidate.id
    );
    const qualification = qualifications.find((value) =>
      value.id === candidate.latestDecisionId
      && value.decisionVersion === request.decisionVersion
    );
    const createdAt = new Date(this.#now()).toISOString();
    const identity = [
      request.ownerId,
      request.teamId,
      request.candidateId
    ];
    const leadId = stableId("lead", identity);
    const sourceEventId = stableId("lse", identity);
    const activityId = stableId("la", identity);
    const company = candidate.profile.kind === "organization"
      ? candidate.profile.name
      : candidate.profile.publicDisplayName;
    const country = candidate.profile.kind === "organization"
      ? candidate.profile.region ?? ""
      : candidate.profile.locationHint;
    const intent = qualification?.grade === "S"
      || qualification?.grade === "A"
      ? "高"
      : qualification?.grade === "D"
        ? "低"
        : "中";
    const estimatedAmount = financial?.currency === "CNY"
      ? financial.expectedRevenueMinor / 100
      : 0;
    const publicSourceUrl = sourceUrl(evidence);
    const intelligence: AcquisitionHandoffIntelligence | null =
      qualification && financial
        ? {
            qualificationGrade: qualification.grade,
            qualificationScore: qualification.score,
            financialGrade: financial.grade,
            currency: financial.currency,
            expectedRevenueMinor: financial.expectedRevenueMinor,
            expectedGrossProfitMinor: financial.expectedGrossProfitMinor,
            expectedContributionMinor: financial.expectedContributionMinor
          }
        : null;
    const lead: Lead = {
      id: leadId,
      company,
      contact: candidate.profile.kind === "individual"
        ? candidate.profile.publicDisplayName
        : "",
      country,
      email: "",
      phone: "",
      wechat: "",
      source: "AI获客智能体",
      intent,
      stage: "待人工跟进",
      status: "new",
      ownerId: request.ownerId,
      teamId: request.teamId,
      estimatedAmount,
      nextFollowAt: "",
      lastActivityAt: createdAt,
      remark: `由已审核获客候选 ${candidate.id} 转入，证据 ${evidence.length} 条。`,
      convertedCustomerId: "",
      convertedDealId: "",
      sourceType: "outbound",
      sourceChannel: "ai_acquisition",
      sourceCampaign: request.decisionVersion,
      externalId: request.candidateId,
      sourceUrl: publicSourceUrl,
      createdAt
    };
    const sourceEvent: LeadSourceEvent = {
      id: sourceEventId,
      leadId,
      sourceType: "outbound",
      channel: "ai_acquisition",
      campaign: request.decisionVersion,
      externalId: request.candidateId,
      sourceUrl: publicSourceUrl,
      occurredAt: createdAt,
      receivedAt: createdAt,
      rawPayload: JSON.stringify({
        candidateId: candidate.id,
        partyType: candidate.partyType,
        decisionVersion: request.decisionVersion,
        evidenceIds: request.evidenceIds,
        intelligence,
        qualificationSnapshotHash: qualification?.snapshotHash ?? "",
        financialSnapshotHash: financial?.inputSnapshotHash ?? ""
      }),
      ownerId: request.ownerId,
      teamId: request.teamId
    };
    const activity: LeadActivity = {
      id: activityId,
      leadId,
      type: "system",
      content: `AI获客候选经人工审核后转为线索（${request.decisionVersion}）`,
      operatorId: request.actorId,
      nextFollowAt: "",
      createdAt
    };
    const existingLead = this.#store.leads.find((item) =>
      item.id === leadId
    ) ?? priorLead;
    if (existingLead && (
      existingLead.id !== leadId
      || existingLead.ownerId !== request.ownerId
      || existingLead.teamId !== request.teamId
      || existingLead.sourceChannel !== "ai_acquisition"
      || existingLead.externalId !== request.candidateId
    )) {
      throw new Error("ACQUISITION_LEAD_ID_COLLISION");
    }
    const existingSourceEvent = this.#store.leadSourceEvents.find((item) =>
      item.id === sourceEventId
      || (
        item.ownerId === request.ownerId
        && item.teamId === request.teamId
        && item.channel === "ai_acquisition"
        && item.externalId === request.candidateId
      )
    );
    if (existingSourceEvent && (
      existingSourceEvent.id !== sourceEventId
      || existingSourceEvent.leadId !== leadId
    )) {
      throw new Error("ACQUISITION_SOURCE_EVENT_COLLISION");
    }
    const existingActivity = this.#store.leadActivities.find((item) =>
      item.id === activityId
    );
    if (existingActivity && existingActivity.leadId !== leadId) {
      throw new Error("ACQUISITION_ACTIVITY_COLLISION");
    }
    if (existingLead && existingSourceEvent && existingActivity) {
      return {
        leadId,
        partyRef: structuredClone(candidate.partyRef)
      };
    }
    const apply = () => {
      const inserted = {
        lead: !existingLead,
        sourceEvent: !existingSourceEvent,
        activity: !existingActivity
      };
      if (inserted.lead) this.#store.leads.unshift(lead);
      if (inserted.sourceEvent) {
        this.#store.leadSourceEvents.unshift(sourceEvent);
      }
      if (inserted.activity) this.#store.leadActivities.unshift(activity);
      return {
        value: {
          leadId,
          partyRef: structuredClone(candidate.partyRef)
        },
        rollback: () => {
          if (inserted.lead) removeById(this.#store.leads, leadId);
          if (inserted.sourceEvent) {
            removeById(this.#store.leadSourceEvents, sourceEventId);
          }
          if (inserted.activity) {
            removeById(this.#store.leadActivities, activityId);
          }
        }
      };
    };
    if (this.#store.persistMutation) {
      return await this.#store.persistMutation(apply);
    }
    const mutation = apply();
    try {
      await this.#store.persist();
      return mutation.value;
    } catch (error) {
      mutation.rollback();
      throw error;
    }
  }
}
