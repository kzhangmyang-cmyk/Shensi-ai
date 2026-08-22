export type PartyType = "organization" | "individual";

export type PartyRef =
  | {
      partyType: "organization";
      organizationId: string;
      tenantProspectId: string;
    }
  | {
      partyType: "individual";
      individualPartyId: string;
      demandSignalId: string;
    };

export type OrganizationPartyRef = Extract<
  PartyRef,
  { partyType: "organization" }
>;

export type CandidateStatus =
  | "discovered"
  | "unresolvable"
  | "normalized"
  | "qualified"
  | "pending_review"
  | "approved"
  | "rejected"
  | "do_not_contact"
  | "needs_research"
  | "converted_to_lead";

export type BuyingStage =
  | "awareness"
  | "problem_defined"
  | "solution_research"
  | "comparison"
  | "purchase_ready";

export type EvidenceProvenance =
  | {
      kind: "search_result";
      provider: string;
      providerConnectionId?: string;
      requestId?: string;
      providerRecordId?: string;
      queryText: string;
      sourceUrl: string;
      resultRank: number | null;
      sourceType?: string;
    }
  | {
      kind: "user_submitted_url";
      sourceUrl: string;
      submittedBy: string;
    }
  | {
      kind: "controlled_public_page";
      sourceUrl: string;
      discoveredFromEvidenceId: string;
      redirectChain: string[];
      extractorVersion: "douyin-public-profile-v1";
    }
  | {
      kind: "platform_public_event";
      sourceUrl: string;
      platformEventId: string;
      providerVersion: string;
      coverage: "public_top_level_sample";
    }
  | {
      kind: "authorized_visual_observation";
      sourceUrl: string;
      observationId: string;
      sessionId: string;
      extractionMethod: "dom" | "accessibility" | "ocr";
      visibleTextConfidence: number;
      coverage: "authorized_visible_top_level_sample";
      artifactId: string | null;
      domTextHash: string | null;
      ocrTextHash: string | null;
    }
  | {
      kind: "import_artifact_row";
      importBatchId: string;
      artifactHash: string;
      sheetName: string;
      rowNumber: number;
      sourceUrl?: string;
    };

export interface DiscoveryEvidenceInput {
  targetType: "organization" | "individual_signal";
  sourcePlatform: string;
  sourceTitle: string;
  sourceSnippet: string;
  publishedAt: string | null;
  locale: string;
  rawArtifactHash: string;
  contentHash: string;
  provenance: EvidenceProvenance;
  accessStatus:
    | "indexed_summary"
    | "public_content"
    | "user_supplied"
    | "access_restricted";
  supersedesEvidenceId?: string | null;
}

export interface DiscoveryEvidence extends DiscoveryEvidenceInput {
  id: string;
  ownerId: string;
  teamId: string;
  fetchedAt: string;
  supersedesEvidenceId: string | null;
}

export function discoveryEvidencePublicSourceUrl(
  evidence: Pick<DiscoveryEvidence, "provenance">
) {
  return evidence.provenance.kind === "import_artifact_row"
    ? null
    : evidence.provenance.sourceUrl;
}

export interface OrganizationCandidateProfile {
  kind: "organization";
  name: string;
  domain: string | null;
  region: string | null;
  creditCode: string | null;
}

export interface IndividualCandidateProfile {
  kind: "individual";
  publicActorKey: string;
  publicDisplayName: string;
  publicProfileUrl: string;
  sourcePlatform: string;
  demandCategory: string;
  demandSummary: string;
  locationHint: string;
  buyingStage: BuyingStage;
  negativeSignals: string[];
}

export type CandidateProfile =
  | OrganizationCandidateProfile
  | IndividualCandidateProfile;

export type CandidateIdentityResolutionBasis =
  | "organization_domain"
  | "organization_credit_code"
  | "provider_public_actor";

export interface CandidateIdentityResolutionCommitInput {
  expectedCandidateVersion: number;
  evidenceIds: string[];
  rationale: string;
  basis: CandidateIdentityResolutionBasis;
  resolverVersion: string;
  identityAliases: Array<{
    dedupeKey: string;
    basis: CandidateIdentityResolutionBasis;
  }>;
  partyRef: PartyRef;
  profile: CandidateProfile;
}

export interface CandidateIdentityResolutionResult {
  candidate: AcquisitionCandidate;
  resolution: {
    status: "resolved";
    basis: CandidateIdentityResolutionBasis;
    resolverVersion: string;
    evidenceIds: string[];
    resolvedAt: string;
    resolvedBy: string;
  };
}

export interface AcquisitionCandidateIdentityAlias {
  ownerId: string;
  teamId: string;
  candidateId: string;
  partyType: PartyType;
  basis: CandidateIdentityResolutionBasis;
  dedupeKey: string;
  createdAt: string;
}

export interface AcquisitionCandidate {
  id: string;
  ownerId: string;
  teamId: string;
  partyType: PartyType;
  partyRef: PartyRef;
  profile: CandidateProfile;
  evidenceIds: string[];
  status: CandidateStatus;
  latestDecisionId: string | null;
  latestDecisionVersion: string | null;
  approvedDecisionVersion: string | null;
  hardGateFailures: HardGateFailure[];
  leadId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export function acquisitionCandidateIdentityResolved(
  candidate: AcquisitionCandidate
) {
  if (candidate.partyType === "organization"
    && candidate.profile.kind === "organization"
    && candidate.partyRef.partyType === "organization") {
    return Boolean(
      candidate.profile.name
      && candidate.partyRef.organizationId
      && !candidate.partyRef.organizationId.startsWith("unresolved-org-")
    );
  }
  if (candidate.partyType === "individual"
    && candidate.profile.kind === "individual"
    && candidate.partyRef.partyType === "individual") {
    return Boolean(
      candidate.profile.publicActorKey
      && candidate.profile.publicProfileUrl
      && candidate.partyRef.individualPartyId
      && !candidate.partyRef.individualPartyId.startsWith(
        "unresolved-individual-"
      )
    );
  }
  return false;
}

export interface OrganizationCandidateInput {
  name: string;
  domain: string | null;
  region: string | null;
  creditCode: string | null;
  organizationId: string;
  tenantProspectId: string;
  evidenceIds: string[];
}

export interface IndividualCandidateInput {
  publicActorKey: string;
  publicDisplayName: string;
  publicProfileUrl: string;
  sourcePlatform: string;
  demandSignalId: string;
  demandCategory: string;
  demandSummary: string;
  locationHint: string;
  buyingStage: BuyingStage;
  negativeSignals: string[];
  individualPartyId: string;
  evidenceIds: string[];
  initialStatus?: "needs_research" | "do_not_contact";
}

/**
 * Internal command used when another public demand signal belongs to an
 * existing individual candidate. Identity-bearing profile fields are
 * deliberately absent so ingestion cannot overwrite resolved identity facts.
 */
export interface IndividualDemandSignalMergeInput {
  evidenceId: string;
  demandSummary: string;
  buyingStage: BuyingStage;
  negativeSignals: string[];
}

export interface QualificationDimensions {
  demandStrength: number;
  fit: number;
  identityConfidence: number;
  buyingStage: number;
  budgetPotential: number;
  decisionReachability: number;
  freshness: number;
  evidenceDiversity: number;
  negativeSignalRisk: number;
  contactRisk: number;
}

export interface QualificationHardGates {
  hasOriginalSource: boolean;
  identityResolved: boolean;
  notDoNotContact: boolean;
  noExplicitRejection: boolean;
  publicDataOnly: boolean;
  evidenceFresh: boolean;
  schemaValid: boolean;
}

export type HardGateFailure =
  | "missing_original_source"
  | "identity_unresolved"
  | "do_not_contact"
  | "explicit_rejection"
  | "non_public_or_sensitive_data"
  | "stale_evidence"
  | "schema_invalid";

export interface QualificationInput {
  decisionEngine: "model" | "rules";
  ruleVersion: string;
  promptVersion: string | null;
  modelProvider: string | null;
  model: string | null;
  dimensions: QualificationDimensions;
  hardGates: QualificationHardGates;
  evidenceExcerpts: Record<string, string>;
  reasons: string[];
}

export interface ScoredSignal {
  name: string;
  score: number;
}

export interface EvidenceReference {
  evidenceId: string;
  excerpt: string;
}

export interface QualificationDecision {
  id: string;
  ownerId: string;
  teamId: string;
  candidateId: string;
  decisionVersion: string;
  decisionEngine: "model" | "rules";
  grade: "S" | "A" | "B" | "C" | "D";
  score: number;
  recommendedAction:
    | "priority_review"
    | "public_response"
    | "nurture"
    | "observe"
    | "do_not_contact";
  evidence: EvidenceReference[];
  positiveSignals: ScoredSignal[];
  negativeSignals: ScoredSignal[];
  reasons: string[];
  confidence: number;
  ruleVersion: string;
  promptVersion: string | null;
  modelProvider: string | null;
  model: string | null;
  hardGateFailures: HardGateFailure[];
  snapshotHash: string;
  createdAt: string;
}

export interface FinancialValueInput {
  currency: string;
  predictedDealAmountMinor: number;
  grossMarginBps: number;
  closeProbabilityBps: number;
  acquisitionCostMinor: number;
  salesCostMinor: number;
  serviceCostMinor: number;
  benchmarkDealAmountMinor: number;
  collectionDays: number;
  creditRisk: number;
  repeatPotential: number;
  referralPotential: number;
}

export interface FinancialValueDecision {
  id: string;
  ownerId: string;
  teamId: string;
  candidateId: string;
  qualificationDecisionId: string;
  version: string;
  grade: "S" | "A" | "B" | "C" | "D";
  score: number;
  currency: string;
  expectedRevenueMinor: number;
  expectedGrossProfitMinor: number;
  expectedContributionMinor: number;
  factors: {
    profitability: number;
    cashFlow: number;
    creditQuality: number;
    repeatPotential: number;
    referralPotential: number;
    closeProbability: number;
  };
  inputSnapshotHash: string;
  createdAt: string;
}

export interface BattleCardSection {
  label: string;
  kind: "fact" | "inference" | "unknown";
  content: string;
  evidenceIds: string[];
  confidence: number | null;
}

export interface BattleCardClaim {
  kind: "fact" | "inference" | "unknown";
  text: string;
  evidenceIds: string[];
  confidence: number | null;
}

export interface BuyingRole {
  role: string;
  priority: 1 | 2 | 3;
  influence: "decision_maker" | "influencer" | "user" | "gatekeeper";
  concerns: string[];
  claim: BattleCardClaim;
}

export interface ConnectionStrategy {
  channel: "public_reply" | "wecom" | "phone" | "email" | "referral";
  targetRole: string;
  rationale: BattleCardClaim;
  openingDraft: string;
}

export interface RoleOpener {
  role: string;
  channel: ConnectionStrategy["channel"];
  text: string;
}

export interface FinancialSummary {
  decisionId: string;
  decisionVersion: string;
  grade: FinancialValueDecision["grade"];
  score: number;
  currency: string;
  expectedRevenueMinor: number;
  expectedGrossProfitMinor: number;
  expectedContributionMinor: number;
  factors: FinancialValueDecision["factors"];
}

export interface BattleCardIntelligenceV2 {
  accountOverview: BattleCardClaim[];
  needAssessment: BattleCardClaim[];
  supplierHypotheses: BattleCardClaim[];
  buyingCommittee: BuyingRole[];
  procurementPreferences: BattleCardClaim[];
  connectionStrategies: ConnectionStrategy[];
  roleSpecificOpeners: RoleOpener[];
  doNotActions: string[];
  financialSummary: FinancialSummary | null;
}

export interface BattleCardInputV1 {
  schemaVersion?: "battle-card.v1";
  sections: BattleCardSection[];
  confidence: number;
  modelProvider: string;
  model: string;
  promptVersion: string;
}

export interface BattleCardInputV2 {
  schemaVersion: "battle-card.v2";
  intelligence: Omit<BattleCardIntelligenceV2, "financialSummary">;
  confidence: number;
  modelProvider: string;
  model: string;
  promptVersion: string;
}

export type BattleCardInput = BattleCardInputV1 | BattleCardInputV2;

interface BattleCardBase {
  id: string;
  ownerId: string;
  teamId: string;
  candidateId: string;
  qualificationDecisionId: string;
  partyType: PartyType;
  version: string;
  evidenceIds: string[];
  confidence: number;
  modelProvider: string;
  model: string;
  promptVersion: string;
  snapshotHash: string;
  createdAt: string;
}

export interface BattleCardV1 extends BattleCardBase {
  schemaVersion?: "battle-card.v1";
  sections: BattleCardSection[];
}

export interface BattleCardV2 extends BattleCardBase {
  schemaVersion: "battle-card.v2";
  intelligence: BattleCardIntelligenceV2;
}

export type BattleCard = BattleCardV1 | BattleCardV2;

export type ReviewAction =
  | "approved"
  | "rejected"
  | "do_not_contact"
  | "needs_research"
  | "reopen";

export interface ReviewEvent {
  id: string;
  ownerId: string;
  teamId: string;
  candidateId: string;
  decisionVersion: string;
  action: ReviewAction;
  reason: string | null;
  reviewerId: string;
  idempotencyKey: string;
  createdAt: string;
}

export type ResearchStatus =
  | "pending"
  | "running"
  | "completed"
  | "no_new_evidence"
  | "access_restricted"
  | "failed";

export interface ResearchAttempt {
  id: string;
  ownerId: string;
  teamId: string;
  candidateId: string;
  requestedBy: string;
  requestReason: string;
  budgetVersion: string;
  status: ResearchStatus;
  newEvidenceIds: string[];
  terminationReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface LeadConversionRecord {
  id: string;
  ownerId: string;
  teamId: string;
  candidateId: string;
  decisionVersion: string;
  partyRef: PartyRef;
  leadId: string;
  reviewerId: string;
  idempotencyKey: string;
  evidenceSnapshotHash: string;
  createdAt: string;
}

export type LeadConversionIntentStatus =
  | "pending_crm"
  | "crm_committed"
  | "completed";

export interface LeadConversionIntent {
  id: string;
  ownerId: string;
  teamId: string;
  candidateId: string;
  decisionVersion: string;
  partyRef: PartyRef;
  reviewerId: string;
  idempotencyKey: string;
  evidenceIds: string[];
  evidenceSnapshotHash: string;
  status: LeadConversionIntentStatus;
  leadId: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type OutcomeEventType =
  | "validated"
  | "contacted"
  | "replied"
  | "rejected"
  | "do_not_contact"
  | "private_domain_entered"
  | "need_confirmed"
  | "quoted"
  | "won"
  | "lost"
  | "payment_received";

export interface OutcomeAttributionInput {
  attributionVersion: "acquisition-run.v1";
  runId: string;
  planId: string;
  planVersionId: string;
  planVersion: number;
  planSnapshotHash: string;
  discoveredEventId: string;
  discoveredAt: string;
  shardId: string;
  operationId: string;
  connectionId: string;
  providerId: string;
  evidenceIds: string[];
  providerIds: string[];
  queryIds: string[];
  strategyVersion: string;
  qualificationDecisionId: string;
  decisionVersion: string;
  decisionSnapshotHash: string;
}

export interface OutcomeInput {
  leadId: string | null;
  customerId: string | null;
  eventType: OutcomeEventType;
  occurredAt: string;
  amount: { amountMinor: number; currency: string } | null;
  reasonCode: string | null;
  reasonText: string | null;
  candidateId: string;
  idempotencyKey: string;
  attribution: OutcomeAttributionInput;
}

export interface LiveOutcomeFeedbackEvent {
  id: string;
  ownerId: string;
  teamId: string;
  leadId: string | null;
  customerId: string | null;
  eventType: OutcomeEventType;
  occurredAt: string;
  amount: { amountMinor: number; currency: string } | null;
  reasonCode: string | null;
  reasonText: string | null;
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
  recordKind: "live";
  partyRef: PartyRef;
  candidateId: string;
  attribution: OutcomeAttributionInput & {
    decisionEngine: "model" | "rules";
    ruleVersion: string;
    modelProvider: string | null;
    model: string | null;
    promptVersion: string | null;
  };
  snapshotHash: string;
}

export interface LegacyOutcomeAttribution {
  runId: string | null;
  evidenceIds: string[];
  providerIds: string[];
  queryIds: string[];
  strategyVersion: string | null;
  qualificationDecisionId: string | null;
  decisionVersion: string | null;
  decisionSnapshotHash: string | null;
  decisionEngine: "model" | "rules" | null;
  ruleVersion: string | null;
  modelProvider: string | null;
  model: string | null;
  promptVersion: string | null;
}

export interface LegacyMigratedOutcomeFeedbackEvent {
  id: string;
  ownerId: string;
  teamId: string;
  leadId: string | null;
  customerId: string | null;
  eventType: OutcomeEventType;
  occurredAt: string;
  amount: { amountMinor: number; currency: string } | null;
  reasonCode: string | null;
  reasonText: string | null;
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
  recordKind: "legacy_migrated";
  legacySourceId: string;
  partyRef: OrganizationPartyRef | null;
  candidateId: string | null;
  attribution: LegacyOutcomeAttribution;
  migrationWarnings: string[];
}

export type OutcomeFeedbackEvent =
  | LiveOutcomeFeedbackEvent
  | LegacyMigratedOutcomeFeedbackEvent;

export interface AcquisitionAuditEvent {
  id: string;
  ownerId: string;
  teamId: string;
  candidateId: string | null;
  actorId: string;
  eventType: string;
  fromStatus: CandidateStatus | null;
  toStatus: CandidateStatus | null;
  resourceId: string;
  idempotencyKey: string;
  payloadHash: string;
  createdAt: string;
}

export interface IdempotencyRecord {
  ownerId: string;
  teamId: string;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  result: unknown;
  createdAt: string;
}
