import type {
  LegacyMigratedOutcomeFeedbackEvent,
  LegacyOutcomeAttribution,
  LiveOutcomeFeedbackEvent,
  OrganizationPartyRef,
  OutcomeFeedbackEvent
} from "./acquisition-domain.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function textList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0) : [];
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string");
}

function nullableStringProperty(
  value: Record<string, unknown>,
  property: string
) {
  return Object.prototype.hasOwnProperty.call(value, property)
    && (value[property] === null || typeof value[property] === "string");
}

function livePartyRef(value: unknown) {
  const item = record(value);
  return item.partyType === "organization"
    ? Boolean(text(item.organizationId) && text(item.tenantProspectId))
    : item.partyType === "individual"
      && Boolean(text(item.individualPartyId) && text(item.demandSignalId));
}

function organizationPartyRef(value: unknown): OrganizationPartyRef | null {
  const item = record(value);
  return item.partyType === "organization"
    && text(item.organizationId)
    && text(item.tenantProspectId)
    ? {
        partyType: "organization",
        organizationId: String(item.organizationId),
        tenantProspectId: String(item.tenantProspectId)
      }
    : null;
}

export function isFullLiveOutcome(
  value: unknown
): value is LiveOutcomeFeedbackEvent {
  const item = record(value);
  const attribution = record(item.attribution);
  return item.recordKind === "live"
    && livePartyRef(item.partyRef)
    && Boolean(text(item.candidateId))
    && attribution.attributionVersion === "acquisition-run.v1"
    && [
      "runId",
      "planId",
      "planVersionId",
      "planSnapshotHash",
      "discoveredEventId",
      "discoveredAt",
      "shardId",
      "operationId",
      "connectionId",
      "providerId"
    ].every((field) => text(attribution[field]))
    && Number.isSafeInteger(attribution.planVersion)
    && Number(attribution.planVersion) > 0
    && ["strategyVersion", "qualificationDecisionId", "decisionVersion",
      "decisionSnapshotHash", "ruleVersion"].every((field) =>
      typeof attribution[field] === "string")
    && ["evidenceIds", "providerIds", "queryIds"].every((field) =>
      stringList(attribution[field]))
    && ["modelProvider", "model", "promptVersion"].every((field) =>
      nullableStringProperty(attribution, field))
    && ["model", "rules"].includes(String(attribution.decisionEngine));
}

function legacyAttribution(value: unknown): LegacyOutcomeAttribution {
  const item = record(value);
  const decisionEngine = item.decisionEngine === "model"
    || item.decisionEngine === "rules"
    ? item.decisionEngine
    : null;
  return {
    runId: text(item.runId),
    evidenceIds: textList(item.evidenceIds),
    providerIds: textList(item.providerIds),
    queryIds: textList(item.queryIds),
    strategyVersion: text(item.strategyVersion),
    qualificationDecisionId: text(item.qualificationDecisionId),
    decisionVersion: text(item.decisionVersion),
    decisionSnapshotHash: text(item.decisionSnapshotHash),
    decisionEngine,
    ruleVersion: text(item.ruleVersion),
    modelProvider: text(item.modelProvider),
    model: text(item.model),
    promptVersion: text(item.promptVersion)
  };
}

export function normalizeOutcomeFeedbackEvent(
  value: OutcomeFeedbackEvent | Record<string, unknown>
): OutcomeFeedbackEvent {
  if (isFullLiveOutcome(value)) return structuredClone(value);
  if (value.recordKind === "legacy_migrated") {
    return structuredClone(value) as LegacyMigratedOutcomeFeedbackEvent;
  }
  const source = value as Record<string, unknown>;
  const individualParty = record(source.partyRef).partyType === "individual";
  return {
    id: String(source.id),
    ownerId: String(source.ownerId),
    teamId: String(source.teamId),
    leadId: text(source.leadId),
    customerId: text(source.customerId),
    eventType: source.eventType as LegacyMigratedOutcomeFeedbackEvent["eventType"],
    occurredAt: String(source.occurredAt),
    amount: source.amount
      ? structuredClone(source.amount) as LegacyMigratedOutcomeFeedbackEvent["amount"]
      : null,
    reasonCode: text(source.reasonCode),
    reasonText: text(source.reasonText),
    idempotencyKey: String(source.idempotencyKey),
    createdBy: String(source.createdBy),
    createdAt: String(source.createdAt),
    recordKind: "legacy_migrated",
    legacySourceId: `incomplete-live:${String(source.id)}`,
    partyRef: organizationPartyRef(source.partyRef),
    candidateId: text(source.candidateId),
    attribution: legacyAttribution(source.attribution),
    migrationWarnings: [
      "incomplete_live_attribution_normalized",
      ...(individualParty ? ["individual_party_ref_removed"] : [])
    ]
  };
}
