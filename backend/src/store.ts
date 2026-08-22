import {
  acquisitionOutcomeFeedback,
  agentJobIdempotencyAliases,
  agentJobs,
  aiModelConfigs,
  aiJobModelSnapshots,
  caseStudies,
  commissionCalculations,
  commissionExports,
  commissionItems,
  commissionProducts,
  commissionRules,
  companyProfiles,
  competitors,
  customerActivities,
  customers,
  dailyReportComments,
  dailyReports,
  dealEvents,
  deals,
  examAttempts,
  examQuestionLinks,
  examQuestions,
  exams,
  importExportJobs,
  internalMessages,
  knowledgeAssets,
  leadActivities,
  leadSourceConfigs,
  leadSourceEvents,
  leads,
  memos,
  monthlySalesRecords,
  ocrJobs,
  planTemplates,
  planTasks,
  problems,
  providerCatalog,
  providerConnections,
  providerRequestLogs,
  providerResponseCache,
  prospectCampaignEvents,
  prospectCampaigns,
  prospectCampaignVersions,
  prospectExecutionAttempts,
  prospectExecutionCheckpoints,
  prospectExecutionEvents,
  prospectExecutionKernelStates,
  prospectExecutionLeases,
  prospectExecutionPages,
  prospectExecutionThrottleBuckets,
  prospectStrategySourcePositions,
  prospectProviderRequestAccountingEvidence,
  prospectProviderRequestAttemptBindings,
  prospectProviderRequestDispatches,
  prospectProviderRequestEvents,
  prospectProviderRequestLedgers,
  prospectSourceRawBatches,
  prospectSourceRawHits,
  prospectSourceRawRecords,
  organizations,
  organizationAcceptedIdentifiers,
  organizationIdentityClaims,
  organizationIdentityConflicts,
  organizationIdentityConflictReviews,
  organizationIdentityEvents,
  organizationIdentityResolutions,
  organizationAliasFacts,
  organizationCanonicalMappings,
  organizationRelationFacts,
  organizationSourceBindings,
  companyVerificationSnapshots,
  prospectContactChannels,
  prospectContactVerificationSnapshots,
  prospectContactabilityDecisions,
  prospectContacts,
  prospectCoverageEvents,
  prospectEvidence,
  prospectIcpAssessmentSnapshots,
  prospectIcpPolicySnapshots,
  prospectSuppressionEvents,
  prospectTouchpoints,
  procurementSignals,
  dealRecommendations,
  customerIntelligenceSuggestions,
  tenantProspects,
  prospectRunEvents,
  prospectRunQueueChildBindings,
  prospectRunQueueParentBindings,
  prospectRunShards,
  prospectSearchRuns,
  prospectSchedules,
  prospectStrategies,
  prospectStrategyEvents,
  prospectStrategySuggestions,
  marketTradeObservations,
  modelConnectionActivationEvents,
  modelConnectionIdempotencyRecords,
  modelCredentialVersions,
  marketOpportunityBatches,
  marketOpportunitySnapshots,
  marketOpportunityCalculationEvents,
  reminders,
  salesRecordAudits,
  todos,
  tradeDocuments,
  users,
  wecomMessages,
  websiteOpportunities,
  whatsappBindings,
  whatsappMessages
} from "./data.js";
import type {
  ResolveOrganizationStrongIdentityPersistedInput,
  ResolveOrganizationStrongIdentityResult
} from "./organization-strong-identity.js";
import type {
  ReviewOrganizationIdentityConflictInput,
  ReviewOrganizationIdentityConflictResult
} from "./organization-identity-conflict-review.js";
import type {
  RecordOrganizationAliasInput,
  RecordOrganizationAliasResult,
  RecordOrganizationRelationInput,
  RecordOrganizationRelationResult
} from "./organization-relations.js";
import type {
  RecordProspectCoveragePersistedInput,
  RecordProspectCoverageResult,
  SetTenantProspectDispositionPersistedInput,
  SetTenantProspectDispositionResult
} from "./prospect-coverage-memory.js";
import {
  convertProspectToCustomer
} from "./prospect-customer-conversion.js";
import type {
  ConvertProspectToCustomerPersistedInput,
  ConvertProspectToCustomerResult
} from "./prospect-customer-conversion.js";
import {
  convertProspectToLead
} from "./prospect-lead-conversion.js";
import type {
  ConvertProspectToLeadPersistedInput,
  ConvertProspectToLeadResult
} from "./prospect-lead-conversion.js";
import {
  applyProspectQualificationCommand
} from "./prospect-qualification.js";
import {
  ensureProspectVerificationReport
} from "./prospect-verification.js";
import type {
  ProspectQualificationCommand,
  ProspectQualificationCommandResult
} from "./prospect-qualification.js";
import type { AcquisitionCustomerHandoff, AcquisitionCustomerHandoffOperation, AcquisitionOutcomeFeedback, AgentJob, AgentJobIdempotencyAlias, AiModelConfig, CaseStudy, CommissionCalculation, CommissionExport, CommissionItem, CommissionProduct, CommissionRule, Competitor, Customer, CustomerAcquisitionSourceEvent, CustomerActivity, CustomerIntelligenceSuggestion, CustomerOwnershipEvent, CustomerOwnershipMutationInput, CustomerOwnershipMutationResult, DailyReport, DailyReportComment, Deal, DealEvent, DealRecommendation, Exam, ExamAttempt, ExamQuestion, ExamQuestionLink, ImportExportJob, InternalMessage, KnowledgeAsset, Lead, LeadActivity, LeadSourceConfig, LeadSourceEvent, MarketOpportunityBatch, MarketOpportunityCalculationEvent, MarketOpportunitySnapshot, MarketTradeObservation, Memo, MonthlySalesRecord, OcrJob, Organization, OrganizationAcceptedIdentifier, OrganizationAliasFact, OrganizationCanonicalMapping, OrganizationIdentityClaim, OrganizationIdentityConflict, OrganizationIdentityConflictReview, OrganizationIdentityEvent, OrganizationIdentityResolution, OrganizationRelationFact, OrganizationSourceBinding, PlanTask, PlanTemplate, ProblemItem, ProcurementSignal, ProspectCampaign, ProspectCampaignEvent, ProspectCampaignVersion, ProspectCandidateProcessingState, ProspectCoverageEvent, ProspectExecutionAttempt, ProspectExecutionCheckpoint, ProspectExecutionEvent, ProspectExecutionKernelState, ProspectExecutionLease, ProspectExecutionPage, ProspectExecutionThrottleBucket, ProspectProviderRequestAccountingEvidence, ProspectProviderRequestAttemptBinding, ProspectProviderRequestDispatch, ProspectProviderRequestEvent, ProspectProviderRequestLedger, ProspectRunEvent, ProspectRunQueueChildBinding, ProspectRunQueueParentBinding, ProspectRunShard, ProspectSchedule, ProspectSearchRun, ProspectSourceRawBatch, ProspectSourceRawHit, ProspectSourceRawRecord, ProspectStrategy, ProspectStrategyEvent, ProspectStrategySourcePosition, ProspectStrategySuggestion, ProspectTouchpoint, ProviderCatalogItem, ProviderConnection, ProviderRequestLog, ProviderResponseCache, Reminder, SalesRecordAudit, TenantProspect, Todo, TradeDocument, User, WecomMessage, WebsiteOpportunity, WhatsAppMessage, WhatsAppBinding } from "./types.js";
import type {
  AcquisitionOutcomeReconciliationCheckpoint,
  AcquisitionOutcomeReconciliationDiagnostic,
  AcquisitionOutcomeReconciliationProcessedSource
} from "./types.js";
import { mutateCustomerOwnershipMemory } from "./customer-public-pool.js";
import type {
  AuthoritativeQuoteProjectionMutation,
  AuthoritativeQuoteProjectionMutationResult
} from "./quote-crm-command.js";
import type {
  CompanyVerificationSnapshot,
  ProspectContact,
  ProspectContactChannel,
  ProspectContactVerificationSnapshot,
  ProspectContactabilityDecision,
  ProspectEvidence,
  ProspectIcpAssessmentSnapshot,
  ProspectIcpPolicySnapshot,
  ProspectSuppressionEvent
} from "./types.js";
import type { CompanyProfile } from "./types.js";
import type {
  ModelConnection,
  ModelConnectionActivationEvent,
  ModelConnectionIdempotencyRecord,
  ModelConnectionScope,
  ModelCredentialVersion,
  StoredAiJobModelSnapshot
} from "./model-providers/types.js";
import type {
  ModelCallRecord
} from "./model-providers/call-ledger.js";
import type {
  ModelConnectionDeletionOptions
} from "./model-providers/connection-service.js";

export interface PersistedStoreMutation<T> {
  value: T;
  rollback(): void;
}

export interface AsyncPersistedStoreMutation<T> {
  value: T;
  rollback(): void | Promise<void>;
}

export interface CrmStore {
  mode: "memory" | "mysql";
  users: User[];
  companyProfiles: CompanyProfile[];
  dailyReports: DailyReport[];
  dailyReportComments: DailyReportComment[];
  internalMessages: InternalMessage[];
  customers: Customer[];
  customerOwnershipEvents: CustomerOwnershipEvent[];
  customerActivities: CustomerActivity[];
  customerAcquisitionSourceEvents: CustomerAcquisitionSourceEvent[];
  customerIntelligenceSuggestions: CustomerIntelligenceSuggestion[];
  acquisitionCustomerHandoffs: AcquisitionCustomerHandoff[];
  acquisitionCustomerHandoffOperations: AcquisitionCustomerHandoffOperation[];
  acquisitionOutcomeReconciliationDiagnostics:
    AcquisitionOutcomeReconciliationDiagnostic[];
  acquisitionOutcomeReconciliationCheckpoints:
    AcquisitionOutcomeReconciliationCheckpoint[];
  acquisitionOutcomeReconciliationProcessedSources:
    AcquisitionOutcomeReconciliationProcessedSource[];
  leads: Lead[];
  leadActivities: LeadActivity[];
  leadSourceEvents: LeadSourceEvent[];
  todos: Todo[];
  deals: Deal[];
  dealEvents: DealEvent[];
  reminders: Reminder[];
  knowledgeAssets: KnowledgeAsset[];
  exams: Exam[];
  examQuestions: ExamQuestion[];
  examQuestionLinks: ExamQuestionLink[];
  examAttempts: ExamAttempt[];
  importExportJobs: ImportExportJob[];
  tradeDocuments: TradeDocument[];
  wecomMessages: WecomMessage[];
  ocrJobs: OcrJob[];
  websiteOpportunities: WebsiteOpportunity[];
  aiModelConfigs: AiModelConfig[];
  modelCredentialVersions: ModelCredentialVersion[];
  pendingModelCredentialVersions: ModelCredentialVersion[];
  modelConnectionActivationEvents: ModelConnectionActivationEvent[];
  pendingModelConnectionActivationEvents:
    ModelConnectionActivationEvent[];
  aiJobModelSnapshots: StoredAiJobModelSnapshot[];
  pendingAiJobModelSnapshots: StoredAiJobModelSnapshot[];
  modelConnectionIdempotencyRecords: ModelConnectionIdempotencyRecord[];
  pendingModelConnectionIdempotencyRecords: ModelConnectionIdempotencyRecord[];
  modelCallRecords: ModelCallRecord[];
  pendingModelCallRecords: ModelCallRecord[];
  providerCatalog: ProviderCatalogItem[];
  providerConnections: ProviderConnection[];
  providerRequestLogs: ProviderRequestLog[];
  providerResponseCache: ProviderResponseCache[];
  marketTradeObservations: MarketTradeObservation[];
  marketOpportunityBatches: MarketOpportunityBatch[];
  marketOpportunitySnapshots: MarketOpportunitySnapshot[];
  marketOpportunityCalculationEvents: MarketOpportunityCalculationEvent[];
  agentJobs: AgentJob[];
  agentJobIdempotencyAliases: AgentJobIdempotencyAlias[];
  prospectCampaigns: ProspectCampaign[];
  prospectCampaignVersions: ProspectCampaignVersion[];
  prospectCampaignEvents: ProspectCampaignEvent[];
  prospectStrategies: ProspectStrategy[];
  prospectStrategyEvents: ProspectStrategyEvent[];
  prospectSchedules: ProspectSchedule[];
  prospectSearchRuns: ProspectSearchRun[];
  prospectRunShards: ProspectRunShard[];
  prospectRunEvents: ProspectRunEvent[];
  prospectRunQueueParentBindings: ProspectRunQueueParentBinding[];
  prospectRunQueueChildBindings: ProspectRunQueueChildBinding[];
  prospectExecutionKernelStates: ProspectExecutionKernelState[];
  prospectExecutionCheckpoints: ProspectExecutionCheckpoint[];
  prospectStrategySourcePositions: ProspectStrategySourcePosition[];
  prospectExecutionLeases: ProspectExecutionLease[];
  prospectExecutionAttempts: ProspectExecutionAttempt[];
  prospectProviderRequestLedgers: ProspectProviderRequestLedger[];
  prospectProviderRequestDispatches: ProspectProviderRequestDispatch[];
  prospectProviderRequestEvents: ProspectProviderRequestEvent[];
  prospectProviderRequestAttemptBindings: ProspectProviderRequestAttemptBinding[];
  prospectProviderRequestAccountingEvidence: ProspectProviderRequestAccountingEvidence[];
  prospectSourceRawBatches: ProspectSourceRawBatch[];
  prospectSourceRawRecords: ProspectSourceRawRecord[];
  prospectSourceRawHits: ProspectSourceRawHit[];
  prospectCandidateProcessingStates?: ProspectCandidateProcessingState[];
  organizations: Organization[];
  organizationIdentityClaims: OrganizationIdentityClaim[];
  organizationAcceptedIdentifiers: OrganizationAcceptedIdentifier[];
  organizationIdentityResolutions: OrganizationIdentityResolution[];
  organizationSourceBindings: OrganizationSourceBinding[];
  organizationIdentityConflicts: OrganizationIdentityConflict[];
  organizationIdentityConflictReviews: OrganizationIdentityConflictReview[];
  organizationCanonicalMappings: OrganizationCanonicalMapping[];
  organizationAliasFacts: OrganizationAliasFact[];
  organizationRelationFacts: OrganizationRelationFact[];
  organizationIdentityEvents: OrganizationIdentityEvent[];
  tenantProspects: TenantProspect[];
  prospectCoverageEvents: ProspectCoverageEvent[];
  prospectEvidence: ProspectEvidence[];
  companyVerificationSnapshots: CompanyVerificationSnapshot[];
  prospectIcpPolicySnapshots: ProspectIcpPolicySnapshot[];
  prospectIcpAssessmentSnapshots: ProspectIcpAssessmentSnapshot[];
  prospectContacts: ProspectContact[];
  prospectContactChannels: ProspectContactChannel[];
  prospectContactVerificationSnapshots:
    ProspectContactVerificationSnapshot[];
  prospectSuppressionEvents: ProspectSuppressionEvent[];
  prospectContactabilityDecisions: ProspectContactabilityDecision[];
  prospectTouchpoints: ProspectTouchpoint[];
  procurementSignals: ProcurementSignal[];
  dealRecommendations: DealRecommendation[];
  acquisitionOutcomeFeedback: AcquisitionOutcomeFeedback[];
  prospectStrategySuggestions: ProspectStrategySuggestion[];
  prospectExecutionPages: ProspectExecutionPage[];
  prospectExecutionEvents: ProspectExecutionEvent[];
  prospectExecutionThrottleBuckets: ProspectExecutionThrottleBucket[];
  leadSourceConfigs: LeadSourceConfig[];
  planTasks: PlanTask[];
  planTemplates: PlanTemplate[];
  problems: ProblemItem[];
  memos: Memo[];
  competitors: Competitor[];
  caseStudies: CaseStudy[];
  whatsappMessages: WhatsAppMessage[];
  whatsappBindings: WhatsAppBinding[];
  commissionProducts: CommissionProduct[];
  commissionRules: CommissionRule[];
  monthlySalesRecords: MonthlySalesRecord[];
  salesRecordAudits: SalesRecordAudit[];
  commissionCalculations: CommissionCalculation[];
  commissionItems: CommissionItem[];
  commissionExports: CommissionExport[];
  persist(): Promise<void>;
  activateModelConnection?(
    scope: ModelConnectionScope,
    connectionId: string,
    actorId: string,
    reason: string
  ): Promise<ModelConnection>;
  deleteModelConnection?(
    scope: ModelConnectionScope,
    connectionId: string,
    options?: ModelConnectionDeletionOptions
  ): Promise<ModelConnection>;
  persistMutation?<T>(
    mutation: () => PersistedStoreMutation<T>
  ): Promise<T>;
  persistAsyncMutation?<T>(
    mutation: () => Promise<AsyncPersistedStoreMutation<T>>
  ): Promise<T>;
  persistProspectExecutionMutation?<T>(
    mutation: () => PersistedStoreMutation<T>
  ): Promise<T>;
  persistProspectCandidateMutation?<T>(
    mutation: () => PersistedStoreMutation<T>
  ): Promise<T>;
  persistProspectCandidates?(candidateIds: string[]): Promise<void>;
  mutateCustomerOwnership?(
    input: CustomerOwnershipMutationInput
  ): Promise<CustomerOwnershipMutationResult>;
  mutateAuthoritativeQuoteProjection?(
    input: AuthoritativeQuoteProjectionMutation
  ): Promise<AuthoritativeQuoteProjectionMutationResult>;
  reloadProspectCandidates?(): Promise<void>;
  reloadProspectRuns?(): Promise<void>;
  resolveOrganizationStrongIdentity?(
    input: ResolveOrganizationStrongIdentityPersistedInput
  ): Promise<ResolveOrganizationStrongIdentityResult>;
  reloadOrganizationIdentityTeam?(teamId: string): Promise<void>;
  reviewOrganizationIdentityConflict?(
    input: ReviewOrganizationIdentityConflictInput
  ): Promise<ReviewOrganizationIdentityConflictResult>;
  reloadOrganizationIdentityConflictReviewTeam?(teamId: string): Promise<void>;
  recordOrganizationAlias?(
    input: RecordOrganizationAliasInput
  ): Promise<RecordOrganizationAliasResult>;
  recordOrganizationRelation?(
    input: RecordOrganizationRelationInput
  ): Promise<RecordOrganizationRelationResult>;
  reloadOrganizationRelationsTeam?(teamId: string): Promise<void>;
  recordProspectCoverage?(
    input: RecordProspectCoveragePersistedInput
  ): Promise<RecordProspectCoverageResult>;
  setTenantProspectDisposition?(
    input: SetTenantProspectDispositionPersistedInput
  ): Promise<SetTenantProspectDispositionResult>;
  convertProspectToLead?(
    input: ConvertProspectToLeadPersistedInput
  ): Promise<ConvertProspectToLeadResult>;
  convertProspectToCustomer?(
    input: ConvertProspectToCustomerPersistedInput
  ): Promise<ConvertProspectToCustomerResult>;
  reloadProspectCoverageTeam?(teamId: string): Promise<void>;
  applyProspectQualification?(
    input: ProspectQualificationCommand
  ): Promise<ProspectQualificationCommandResult>;
  reloadProspectQualificationTeam?(teamId: string): Promise<void>;
  readBarrier(): Promise<void>;
  close?(): Promise<void>;
}

export const memoryStore: CrmStore = {
  mode: "memory",
  users,
  companyProfiles,
  dailyReports,
  dailyReportComments,
  internalMessages,
  customers,
  customerOwnershipEvents: [],
  customerActivities,
  customerAcquisitionSourceEvents: [],
  customerIntelligenceSuggestions,
  acquisitionCustomerHandoffs: [],
  acquisitionCustomerHandoffOperations: [],
  acquisitionOutcomeReconciliationDiagnostics: [],
  acquisitionOutcomeReconciliationCheckpoints: [],
  acquisitionOutcomeReconciliationProcessedSources: [],
  leads,
  leadActivities,
  leadSourceEvents,
  todos,
  deals,
  dealEvents,
  reminders,
  knowledgeAssets,
  exams,
  examQuestions,
  examQuestionLinks,
  examAttempts,
  importExportJobs,
  tradeDocuments,
  wecomMessages,
  ocrJobs,
  websiteOpportunities: websiteOpportunities.map((item) =>
    ensureProspectVerificationReport(item)
  ),
  aiModelConfigs,
  modelCredentialVersions,
  pendingModelCredentialVersions: [],
  modelConnectionActivationEvents,
  pendingModelConnectionActivationEvents: [],
  aiJobModelSnapshots,
  pendingAiJobModelSnapshots: [],
  modelConnectionIdempotencyRecords,
  pendingModelConnectionIdempotencyRecords: [],
  modelCallRecords: [],
  pendingModelCallRecords: [],
  providerCatalog,
  providerConnections,
  providerRequestLogs,
  providerResponseCache,
  marketTradeObservations,
  marketOpportunityBatches,
  marketOpportunitySnapshots,
  marketOpportunityCalculationEvents,
  agentJobs,
  agentJobIdempotencyAliases,
    prospectCampaigns,
    prospectCampaignVersions,
    prospectCampaignEvents,
    prospectStrategies,
    prospectStrategyEvents,
    prospectSchedules,
    prospectSearchRuns,
    prospectRunShards,
    prospectRunEvents,
    prospectRunQueueParentBindings,
    prospectRunQueueChildBindings,
    prospectExecutionKernelStates,
    prospectExecutionCheckpoints,
    prospectStrategySourcePositions,
    prospectExecutionLeases,
    prospectExecutionAttempts,
    prospectProviderRequestLedgers,
    prospectProviderRequestDispatches,
    prospectProviderRequestEvents,
    prospectProviderRequestAttemptBindings,
    prospectProviderRequestAccountingEvidence,
    prospectSourceRawBatches,
    prospectSourceRawRecords,
    prospectSourceRawHits,
    prospectCandidateProcessingStates: [],
    organizations,
    organizationIdentityClaims,
    organizationAcceptedIdentifiers,
    organizationIdentityResolutions,
    organizationSourceBindings,
    organizationIdentityConflicts,
    organizationIdentityConflictReviews,
    organizationCanonicalMappings,
    organizationAliasFacts,
    organizationRelationFacts,
    organizationIdentityEvents,
    tenantProspects,
    prospectCoverageEvents,
    prospectEvidence,
    companyVerificationSnapshots,
    prospectIcpPolicySnapshots,
    prospectIcpAssessmentSnapshots,
    prospectContacts,
    prospectContactChannels,
    prospectContactVerificationSnapshots,
    prospectSuppressionEvents,
    prospectContactabilityDecisions,
    prospectTouchpoints,
    procurementSignals,
    dealRecommendations,
    acquisitionOutcomeFeedback,
    prospectStrategySuggestions,
    prospectExecutionPages,
    prospectExecutionEvents,
    prospectExecutionThrottleBuckets,
  leadSourceConfigs,
  planTasks,
  planTemplates,
  problems,
  memos,
  competitors,
  caseStudies,
  whatsappMessages,
  whatsappBindings,
  commissionProducts,
  commissionRules,
  monthlySalesRecords,
  salesRecordAudits,
  commissionCalculations,
  commissionItems,
  commissionExports,
  async persist() {
    // Memory mode intentionally keeps current in-process state only.
    memoryStore.pendingModelCredentialVersions.splice(0);
    memoryStore.pendingModelConnectionActivationEvents.splice(0);
    memoryStore.pendingAiJobModelSnapshots.splice(0);
    memoryStore.pendingModelConnectionIdempotencyRecords.splice(0);
    memoryStore.pendingModelCallRecords.splice(0);
  },
  async mutateCustomerOwnership(input) {
    return mutateCustomerOwnershipMemory(memoryStore, input);
  },
  async mutateAuthoritativeQuoteProjection(input) {
    return mutateAuthoritativeQuoteProjectionMemory(memoryStore, input);
  },
  async reloadOrganizationIdentityTeam() {
    // Memory mode already reads the current in-process identity state.
  },
  async reloadOrganizationIdentityConflictReviewTeam() {
    // Memory mode already reads the current in-process review state.
  },
  async reloadOrganizationRelationsTeam() {
    // Memory mode already reads the current in-process organization facts.
  },
  async reloadProspectCoverageTeam() {
    // Memory mode already reads the current in-process coverage state.
  },
  async convertProspectToLead(input) {
    const coverageSecret =
      process.env.PROSPECT_COVERAGE_MASTER_SECRET
      || process.env.ORGANIZATION_IDENTITY_MASTER_SECRET
      || "";
    return convertProspectToLead(memoryStore, {
      ...input,
      coverageSecret
    });
  },
  async convertProspectToCustomer(input) {
    const coverageSecret =
      process.env.PROSPECT_COVERAGE_MASTER_SECRET
      || process.env.ORGANIZATION_IDENTITY_MASTER_SECRET
      || "";
    return convertProspectToCustomer(memoryStore, {
      ...input,
      coverageSecret
    });
  },
  async applyProspectQualification(input) {
    return applyProspectQualificationCommand(memoryStore, input);
  },
  async reloadProspectQualificationTeam() {
    // Memory mode already reads the current in-process qualification state.
  },
  async readBarrier() {
    // Memory mode has no asynchronous persistence queue.
  },
  async close() {
    // Memory mode has no external resources.
  }
};

export function createMemoryStore(overrides: Partial<CrmStore> = {}): CrmStore {
  const store = {
    ...memoryStore,
    ...overrides
  } as CrmStore;
  store.mutateAuthoritativeQuoteProjection = async (input) =>
    mutateAuthoritativeQuoteProjectionMemory(store, input);
  return store;
}

function mutateAuthoritativeQuoteProjectionMemory(
  store: Pick<CrmStore, "deals" | "dealEvents" | "tradeDocuments"
    | "customers" | "companyProfiles">,
  input: AuthoritativeQuoteProjectionMutation
): AuthoritativeQuoteProjectionMutationResult {
  const deal = store.deals.find((row) => row.id === input.dealId
    && row.teamId === input.workspaceId);
  if (!deal) throw new Error("authoritative_projection_deal_not_found");
  if (input.quoteVersion.versionKind !== "formal"
    || input.quoteVersion.id === ""
    || input.quoteVersion.workspaceId !== input.workspaceId
    || input.quoteVersion.quoteCaseId !== input.quoteCaseId
    || input.quoteVersion.commercialAmountHash !== input.commercialAmountHash) {
    throw new Error("authoritative_projection_version_mismatch");
  }
  const line = input.quoteVersion.lineSnapshot as Record<string, unknown>;
  const quantity = Number(line.quantityMicros) / 1_000_000;
  const unitPrice = Number(line.offeredUnitPriceMinor) / 100;
  const quotedAmountMinor = Number(input.quoteVersion.quotedAmountMinor);
  if (!Number.isFinite(quantity) || quantity <= 0
    || !Number.isSafeInteger(quotedAmountMinor) || quotedAmountMinor <= 0
    || !Number.isFinite(unitPrice) || unitPrice < 0) {
    throw new Error("authoritative_projection_amount_invalid");
  }
  if (input.kind === "pi") {
    const existing = store.tradeDocuments.find((row) => row.id === input.stableId);
    if (existing) {
      if (existing.quoteVersionId !== input.quoteVersion.id
        || existing.commercialAmountHash !== input.commercialAmountHash
        || existing.dealAuthorityRevision !== input.dealAuthorityRevision) {
        throw new Error("authoritative_projection_stable_key_conflict");
      }
      return { kind: "pi", document: existing };
    }
    const customer = store.customers.find((row) => row.id === deal.customerId);
    const company = store.companyProfiles.find((row) =>
      row.teamId === input.workspaceId);
    for (let index = 0; index < store.tradeDocuments.length; index += 1) {
      const document = store.tradeDocuments[index]!;
      if (document.teamId === input.workspaceId
        && document.dealId === input.dealId
        && document.type === "PI"
        && document.commercialAuthority === "quote_projection"
        && document.projectionState === "current") {
        store.tradeDocuments[index] = { ...document,
          projectionState: "superseded", updatedAt: input.recordedAt };
      }
    }
    const document = Object.freeze({
      id: input.stableId, customerId: deal.customerId, dealId: deal.id,
      revision: 1, commercialAuthority: "quote_projection" as const,
      quoteCaseId: input.quoteCaseId, quoteVersionId: input.quoteVersion.id,
      commercialAmountHash: input.commercialAmountHash,
      dealAuthorityRevision: input.dealAuthorityRevision,
      projectionState: "current" as const, quotedAmountMinor,
      quoteLineSnapshot: Object.freeze(structuredClone(line)),
      quotePackageSnapshot: structuredClone(
        input.quoteVersion.packageSnapshot ?? null
      ),
      recordedAt: input.recordedAt, temporalSequence: input.temporalSequence,
      type: "PI" as const, title: `PI ${input.quoteVersion.id}`,
      number: input.stableId, issueDate: input.recordedAt.slice(0, 10),
      buyer: customer?.billingName || customer?.company || "",
      buyerAddress: customer?.billingAddress || "",
      buyerContact: customer?.documentContact || customer?.contact || "",
      seller: company?.companyName || "", sellerAddress: company?.address || "",
      currency: String(input.quoteVersion.currency),
      incoterm: customer?.defaultIncoterm || "FOB",
      paymentTerm: customer?.defaultPaymentTerm || "", shippingMethod: "",
      portLoading: "", portDischarge: customer?.defaultPortDischarge || "",
      validityDate: "", bankInfo: "", notes: "",
      templateStyle: "executive" as const, status: "draft" as const,
      audits: [], sendRecords: [], ownerId: deal.ownerId,
      teamId: deal.teamId, updatedAt: input.recordedAt,
      items: [{ id: `${input.stableId}-line-1`,
        product: String(line.catalogItemId), model: "", hsCode: "", quantity,
        unit: "PCS", unitPrice, originCountry: "", weightKg: 0,
        packageCount: 0 }]
    });
    store.tradeDocuments.push(document);
    return { kind: "pi", document };
  }
  const existing = store.dealEvents.find((row) => row.id === input.stableId);
  if (existing) {
    if (existing.quoteVersionIdSnapshot !== input.quoteVersion.id
      || existing.commercialAmountHash !== input.commercialAmountHash
      || existing.dealAuthorityRevisionSnapshot
        !== input.dealAuthorityRevision) {
      throw new Error("authoritative_projection_stable_key_conflict");
    }
    return { kind: "crm", event: existing };
  }
  const previousStage = deal.stage;
  Object.assign(deal, {
    product: String(line.catalogItemId), quantity, unitPrice,
    amount: quotedAmountMinor / 100,
    currency: String(input.quoteVersion.currency), amountType: "quoted",
    stage: "已报价", stageChangedAt: input.recordedAt
  });
  const event = Object.freeze({
    id: input.stableId, dealId: deal.id, type: "quote" as const,
    content: "Authoritative quote published", operatorId: input.actorId,
    ownerIdSnapshot: deal.ownerId, teamIdSnapshot: deal.teamId,
    customerIdSnapshot: deal.customerId, leadIdSnapshot: null,
    handoffIdSnapshot: null, candidateIdSnapshot: null,
    amountMinorSnapshot: quotedAmountMinor,
    currencySnapshot: String(input.quoteVersion.currency),
    commercialAuthority: "quote_projection" as const,
    quoteCaseIdSnapshot: input.quoteCaseId,
    quoteVersionIdSnapshot: input.quoteVersion.id,
    commercialAmountHash: input.commercialAmountHash,
    dealAuthorityRevisionSnapshot: input.dealAuthorityRevision,
    fromStage: previousStage, toStage: "已报价" as const,
    relatedDocumentId: input.piDocumentId, recordedAt: input.recordedAt,
    temporalSequence: input.temporalSequence, createdAt: input.recordedAt
  });
  store.dealEvents.push(event);
  return { kind: "crm", event };
}

let activeStore: CrmStore = memoryStore;

export function getStore() {
  return activeStore;
}

export function setStore(store: CrmStore) {
  activeStore = store;
}
