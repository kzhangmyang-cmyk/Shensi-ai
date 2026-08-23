import type { BusinessCurrency, BusinessReportInput } from "./business-advisor/domain.js";

export type Sha256 = `sha256:${string}`;

export interface QuotePreviewInput {
  catalogItemId: string;
  pricingPolicyVersionId: string;
  quantityMicros: number;
  offeredUnitPriceMinor: number;
  orderDiscountMinor: number;
  paymentTermDays: number;
  giftItems: readonly {
    catalogItemId: string;
    quantityMicros: number;
  }[];
  surchargeContext: {
    region: string | null;
    deliveryMethod: string | null;
  };
  customerTargetPriceMinor: number | null;
  creditRiskBps: number | null;
  manualEscalation: boolean;
}

export interface QuotePreviewIdentity {
  inputSnapshotHash: Sha256;
  calculationHash: Sha256;
  pricingPolicyVersionId: string;
  pricingPolicyRevision: number;
  packageVersionId: string | null;
  formulaVersion: "quote-calculation.v1";
}

export type GrowthRoiSliceKey = "all" | `plan:${string}`;

export type FinancialDataGapCode =
  | "unverified_cost"
  | "unverified_financial_fact"
  | "missing_cogs"
  | "unmatched_payment"
  | "missing_commercial_binding"
  | "import_requires_review";

export type FinancialDataGapSourceType =
  | "cost_entry"
  | "financial_fact"
  | "finance_import"
  | "commercial_binding";

export type AdvisorRecommendedAction =
  | { kind: "open_candidate"; candidateId: string }
  | {
      kind: "create_quote_draft";
      quoteCaseId: string;
      quoteCaseRevision: number;
      quoteInput: QuotePreviewInput;
      previewIdentity: QuotePreviewIdentity;
    }
  | {
      kind: "create_quote_approval_task";
      quoteVersionId: string;
      quoteVersionRevision: number;
    }
  | { kind: "create_sales_todo"; customerId: string; dueAt: string }
  | { kind: "complete_cost_data"; cohortId: string }
  | { kind: "complete_financial_fact"; dealId: string };

export type AdvisorMetricRef =
  | {
      kind: "growth_performance";
      cohortId: string;
      currency: string;
      asOf: string;
      planId: string | null;
      closureVersionId: string | null;
      sliceKey: GrowthRoiSliceKey;
      calculationHash: Sha256;
    }
  | {
      kind: "quote_preview";
      quoteCaseId: string;
      previewIdentity: QuotePreviewIdentity;
      inputSnapshotHash: Sha256;
      calculationHash: Sha256;
    }
  | {
      kind: "priority_score";
      candidateId: string;
      qualificationDecisionId: string;
      qualificationDecisionVersion: string;
      inputSnapshotHash: Sha256;
    }
  | {
      kind: "financial_data_gap";
      gapCode: FinancialDataGapCode;
      sourceType: FinancialDataGapSourceType;
      sourceId: string;
      sourceSnapshotHash: Sha256;
      cohortId: string | null;
      currency: string;
      asOf: string;
    };

export type AdvisorEvidenceRef =
  | {
      kind: "candidate_evidence";
      candidateId: string;
      qualificationDecisionId: string;
      qualificationDecisionVersion: string;
      inputSnapshotHash: Sha256;
      evidenceId: string;
      contentHash: Sha256;
    }
  | {
      kind: "quote_version";
      quoteVersionId: string;
      lifecycleRevision: number;
      commercialAmountHash: Sha256;
    }
  | {
      kind: "ledger_entry";
      ledgerType: "cost" | "financial";
      ledgerEntryId: string;
      currency: string;
      verificationEventId: string;
      verificationRevision: number;
      evidenceHash: Sha256;
    }
  | {
      kind: "roi_snapshot";
      closureVersionId: string;
      version: number;
      sliceKey: GrowthRoiSliceKey;
      calculationHash: Sha256;
    };

export type AdvisorEntityRef =
  | {
      kind: "customer";
      id: string;
      quoteVersionId: string;
      handoffContentHash: Sha256;
      bindingHashSchemaVersion: string;
    }
  | {
      kind: "deal";
      id: string;
      quoteVersionId: string;
      dealContentHash: Sha256;
      bindingHashSchemaVersion: string;
      dealAuthorityRevision: number | null;
    }
  | {
      kind: "quote_version";
      id: string;
      lifecycleRevision: number;
      commercialAmountHash: Sha256;
    }
  | {
      kind: "closure_version";
      id: string;
      version: number;
      sliceKey: GrowthRoiSliceKey;
      calculationHash: Sha256;
    };

export type FinancialCouncilActionKind =
  | "collect_receivable"
  | "review_loss_product_pricing"
  | "reduce_cost_anomaly"
  | "prepare_cash_reserve_budget"
  | "complete_financial_data"
  | "schedule_tax_review";

export type FinancialCouncilRunStatus =
  | "created"
  | "snapshot_frozen"
  | "analyzing"
  | "auditing"
  | "synthesizing"
  | "optimizing"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "stale"
  | "expired"
  | "failed"
  | "not_computable";

export type FinancialCouncilAgentRole =
  | "finance"
  | "profit"
  | "cost"
  | "cashflow"
  | "tax";

export type FinancialCouncilPortfolioKind =
  | "balanced"
  | "cash_first"
  | "growth_first";

export interface FinancialCouncilScenarioMoney {
  conservative: number;
  base: number;
  optimistic: number;
}

export interface FinancialCouncilScenarioBps {
  conservative: number;
  base: number;
  optimistic: number;
}

export interface FinancialCouncilCreateInput {
  currency: BusinessCurrency;
  dataAsOf: string;
  businessReport: BusinessReportInput;
  policyVersionId: string;
}

export interface FinancialCouncilCandidateAction {
  actionId: string;
  kind: FinancialCouncilActionKind;
  sourceFindingIds: readonly string[];
  ownerRole: FinancialCouncilAgentRole;
  subjectRef: string | null;
  explanation: string;
  durationDays: number;
  prerequisites: readonly string[];
  mutuallyExclusiveWith: readonly string[];
  cashImpact: FinancialCouncilScenarioMoney;
  profitImpact: FinancialCouncilScenarioMoney;
  riskReductionBps: FinancialCouncilScenarioBps;
  budgetCostMinor: number;
  capacityUnits: number;
  confidenceBps: number;
  requiredCapabilities: readonly string[];
  requiresHumanApproval: true;
}

export interface FinancialCouncilRunEvent {
  eventId: string;
  runId: string;
  revision: number;
  fromStatus: FinancialCouncilRunStatus | null;
  toStatus: FinancialCouncilRunStatus;
  reasonCode: string | null;
  occurredAt: string;
}

export type FinancialCouncilEvidenceSource =
  | "crm"
  | "quote"
  | "financial_fact"
  | "acquisition_cost"
  | "roi"
  | "business_report";

export interface FinancialCouncilEvidenceRef {
  source: FinancialCouncilEvidenceSource;
  sourceId: string;
  contentHash: Sha256;
}

export type FinancialCouncilSnapshotSource =
  | "crm"
  | "quote"
  | "financial_fact"
  | "acquisition_cost"
  | "roi";

export interface FinancialCouncilSourceVersion {
  source: FinancialCouncilSnapshotSource;
  sourceId: string;
  version: number;
  contentHash: Sha256;
}

export type FinancialCouncilConflictKind =
  | "formula"
  | "evidence"
  | "definition"
  | "action_exclusivity"
  | "resource_competition"
  | "risk_preference";

export type FinancialCouncilConflictStatus = "unresolved" | "resolved" | "withdrawn";

export interface FinancialCouncilConflict {
  conflictId: string;
  type: FinancialCouncilConflictKind;
  findingIds: readonly string[];
  status: FinancialCouncilConflictStatus;
}

export interface FinancialCouncilFinding {
  findingId: string;
  runId: string;
  snapshotId: string;
  agentRole: FinancialCouncilAgentRole;
  conclusion: string;
  evidenceRefs: readonly FinancialCouncilEvidenceRef[];
  formulaRef: { formulaVersion: string; inputHash: Sha256; resultHash: Sha256 } | null;
  confidenceBps: number;
  severity: "info" | "warning" | "critical";
  assumptions: readonly string[];
  missingData: readonly FinancialCouncilDataGap[];
  candidateActionIds: readonly string[];
}

export interface FinancialCouncilDataGap {
  code: "unverified_cost" | "unverified_financial_fact" | "missing_cogs" | "unmatched_payment" | "missing_commercial_binding" | "import_requires_review";
  source: "crm" | "quote" | "financial_fact" | "acquisition_cost" | "roi" | "business_report";
  sourceId: string | null;
  description: string;
}

export interface FinancialCouncilActionPortfolio {
  portfolioId: string;
  runId: string;
  revision: number;
  kind: FinancialCouncilPortfolioKind;
  actionIds: readonly string[];
  actions: readonly FinancialCouncilCandidateAction[];
  hardConstraints: readonly { code: string; satisfied: boolean; reason: string | null }[];
  objectiveScoreBps: number;
  scenarioForecast: { cashImpact: FinancialCouncilScenarioMoney; profitImpact: FinancialCouncilScenarioMoney; riskReductionBps: FinancialCouncilScenarioBps };
  sensitivityAnalysis: readonly { factor: string; impactBps: number }[];
  rejectedActions: readonly { actionId: string; reasonCode: string; reason: string }[];
  requiredApprovalCapabilities: readonly string[];
  expiresAt: string;
  createdAt: string;
}

export interface FinancialCouncilApproval {
  approvalId: string;
  runId: string;
  portfolioRevision: number;
  portfolioKind: FinancialCouncilPortfolioKind;
  status: "approved" | "rejected";
  approvedActionIds: readonly string[];
  requiredCapabilities: readonly string[];
  reason: string | null;
  approvedAt: string;
}

export interface FinancialCouncilPolicyInput {
  currency: BusinessCurrency;
  balancedWeightsBps: { cash: number; profit: number; risk: number; strategic: number };
  minimumCashReserveMinor: number;
  dueDebtMinor: number;
  necessaryOutflowMinor: number;
  budgetLimitMinor: number;
  capacityLimitUnits: number;
  durationLimitDays: number;
  minimumActionConfidenceBps: number;
  actionCoefficientVersion: string;
}

export interface FinancialCouncilRun {
  runId: string;
  workspaceId: string;
  currency: BusinessCurrency;
  status: FinancialCouncilRunStatus;
  revision: number;
  dataAsOf: string;
  businessReport: BusinessReportInput;
  policyVersionId: string;
  snapshotId: string;
  snapshotHash: Sha256;
  consensusReport: ConsensusReport | null;
  portfolios: readonly FinancialCouncilActionPortfolio[];
  latestPortfolioRevision: number | null;
  approval: FinancialCouncilApproval | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface FinancialSnapshotView {
  snapshotId: string;
  runId: string;
  workspaceId: string;
  dataAsOf: string;
  currency: BusinessCurrency;
  businessReport: BusinessReportInput;
  sourceVersions: readonly FinancialCouncilSourceVersion[];
  dataGaps: readonly FinancialCouncilDataGap[];
  redactionLevel: "full" | "redacted";
  snapshotHash: Sha256;
  createdAt: string;
}

export interface ConsensusReport {
  reportId: string;
  runId: string;
  snapshotId: string;
  acceptedFindings: readonly FinancialCouncilFinding[];
  minorityFindings: readonly FinancialCouncilFinding[];
  rejectedFindings: readonly FinancialCouncilFinding[];
  unresolvedConflicts: readonly FinancialCouncilConflict[];
  dataGaps: readonly FinancialCouncilDataGap[];
  overallDiagnosis: string;
  inputVersionHash: Sha256;
  createdAt: string;
}

export interface FinancialCouncilPolicyVersion extends FinancialCouncilPolicyInput {
  policyVersionId: string;
  workspaceId: string;
  version: number;
  revision: number;
  policyHash: Sha256;
  createdAt: string;
}

export interface PortfolioRevisionInput {
  baseRevision: number;
  kind: FinancialCouncilPortfolioKind;
  actionIds: readonly string[];
}

export interface FinancialCouncilDispatchView {
  dispatchId: string;
  runId: string;
  approvalId: string;
  actionId: string;
  status: "pending" | "dispatched" | "failed";
  receiptId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinancialCouncilRunEventPagedResult {
  items: readonly FinancialCouncilRunEvent[];
  nextAfter: string | null;
  hasMore: boolean;
}

export interface FinancialCouncilDispatchPagedResult {
  items: readonly FinancialCouncilDispatchView[];
  nextAfter: string | null;
  hasMore: boolean;
}

export type CandidateAction = FinancialCouncilCandidateAction;
export type ActionPortfolio = FinancialCouncilActionPortfolio;

export type FinancialCouncilModelRole =
  | "cfo" | "finance" | "profit" | "cost" | "cashflow" | "tax";
export type FinancialCouncilCenterStatus = "not_connected" | "ready"
  | "running" | "waiting" | "completed" | "manual_review" | "model_error";
export type FinancialCouncilModelProvider = "openai" | "moonshot" | "minimax"
  | "zhipu" | "deepseek" | "qwen" | "doubao" | "hunyuan" | "qianfan";
export type FinancialCouncilAttemptErrorCode = "MODEL_RATE_LIMITED"
  | "MODEL_TIMEOUT" | "MODEL_UNAVAILABLE" | "MODEL_AUTH_FAILED"
  | "MODEL_OUTPUT_INVALID" | "MODEL_POLICY_CONFLICT" | "MODEL_ERROR";

export interface CreateCouncilRunFromPackageInput {
  statementPackageId: string;
  policyVersionId: string;
}

export type FinancialCouncilModelRoleRoute =
  | { mode: "auto"; primaryConnectionId: null; fallbackConnectionIds: readonly [];
      preferenceWeightBps: number }
  | { mode: "pinned"; primaryConnectionId: string;
      fallbackConnectionIds: readonly string[]; preferenceWeightBps: number };
export type FinancialCouncilModelRoutingRoles = Readonly<Record<
  FinancialCouncilModelRole, FinancialCouncilModelRoleRoute>>;
export interface FinancialCouncilModelRoutingPolicyInput {
  roles: FinancialCouncilModelRoutingRoles;
  maxRunBudgetMinor: number;
  maxRoleBudgetMinor: number;
  requestTimeoutMs: number;
}
export interface FinancialCouncilModelRoutingPolicyView
extends FinancialCouncilModelRoutingPolicyInput {
  policyVersionId: string;
  revision: number;
  createdAt: string;
}
export interface FinancialCouncilPublicModelConnection {
  connectionId: string;
  provider: FinancialCouncilModelProvider;
  model: string;
  displayName: string;
}
export interface FinancialCouncilModelRoutePreview {
  role: FinancialCouncilModelRole;
  orderedConnections: readonly FinancialCouncilPublicModelConnection[];
  selectedConnection: FinancialCouncilPublicModelConnection | null;
  reasonCodes: readonly ("structured_output_certified" | "recent_success_rate"
    | "recent_p95_latency" | "known_cost" | "cost_unknown"
    | "consecutive_failure_penalty" | "role_preference_weight"
    | "stable_tiebreak")[];
  missingCapabilities: readonly ("structured_output_certified"
    | "pinned_connection_eligible")[];
}

export type FinancialStatementKind = "balance_sheet" | "income_statement"
  | "cash_flow_statement";
export interface FinancialStatementUpload<K extends FinancialStatementKind> {
  kind: K;
  fileName: string;
  mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  contentBase64: string;
}
export interface FinancialStatementPackagePreviewInput {
  statements: readonly [FinancialStatementUpload<"balance_sheet">,
    FinancialStatementUpload<"income_statement">,
    FinancialStatementUpload<"cash_flow_statement">];
}
export interface FinancialStatementConsentInput {
  consent: { accepted: true; noticeVersion: "financial-model-data.v1" };
}
export interface FinancialStatementSourceView {
  kind: FinancialStatementKind;
  fileName: string;
  fileHash: Sha256;
  mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  sheetNames: readonly string[];
}
interface FinancialStatementPackageCommonView {
  companyName: string;
  currency: BusinessCurrency;
  period: string;
  sourceFiles: readonly FinancialStatementSourceView[];
  parserVersion: "financial-statements.v2";
  warningCodes: readonly string[];
  createdAt: string;
}
export interface FinancialStatementPackagePreviewView
extends FinancialStatementPackageCommonView {
  previewId: string;
  status: "preview";
  expiresAt: string;
}
export interface FinancialStatementPackageView
extends FinancialStatementPackageCommonView {
  packageId: string;
  status: "verified";
  expiresAt: null;
}

export interface FinancialCouncilAgentRoleView {
  role: FinancialCouncilModelRole;
  status: FinancialCouncilCenterStatus;
  provider: string | null;
  model: string | null;
  connectionDisplayName: string | null;
}
export interface FinancialCouncilLatestRunView {
  runId: string;
  status: FinancialCouncilRunStatus;
  revision: number;
  updatedAt: string;
}
export interface FinancialCouncilAgentCenterView {
  data: { status: "not_connected" | "ready"; packageId: string | null;
    companyName: string | null; period: string | null; verifiedAt: string | null;
    warningCodes: readonly string[] };
  models: { status: "not_connected" | "ready";
    routingPolicyVersionId: string | null;
    roles: readonly FinancialCouncilAgentRoleView[] };
  latestRun: FinancialCouncilLatestRunView | null;
  capabilities: { canRun: boolean; canApprove: boolean;
    canManageRouting: boolean };
}
export interface FinancialCouncilModelAttemptView {
  attempt: number;
  provider: string;
  model: string;
  connectionDisplayName: string;
  status: "succeeded" | "failed";
  errorCode: FinancialCouncilAttemptErrorCode | null;
  startedAt: string | null;
  completedAt: string | null;
}
export interface FinancialCouncilRunAgentView {
  role: FinancialCouncilModelRole;
  phase: "analysis" | "consensus";
  status: FinancialCouncilCenterStatus;
  attempts: readonly FinancialCouncilModelAttemptView[];
}
export interface FinancialCouncilRunAgentsView
extends FinancialCouncilLatestRunView {
  roles: readonly FinancialCouncilRunAgentView[];
}
