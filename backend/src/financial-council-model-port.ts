import type { FinancialActionHypothesis } from "./financial-council-action-projector.js";
import type {
  FinancialCouncilAgentRole,
  FinancialCouncilConflictKind
} from "./growth-contract-types.js";
import type {
  ModelProviderId
} from "./model-providers/types.js";

export type FinancialCouncilModelPhase = "analyze" | "rebut" | "synthesize";
export type FinancialCouncilModelRole = FinancialCouncilAgentRole | "cfo";

export interface FinancialCfoFindingProjection {
  readonly findingId: string;
  readonly agentRole: FinancialCouncilAgentRole;
  readonly conclusion: string;
  readonly severity: "info" | "warning" | "critical";
  readonly evidenceRefIds: readonly string[];
  readonly formulaRefId: string | null;
}

export interface FinancialCfoNarrativeInput {
  readonly ownerId: string;
  readonly teamId: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly auditHash: `sha256:${string}`;
  readonly attempt: number;
  readonly acceptedFindings: readonly FinancialCfoFindingProjection[];
  readonly minorityFindings: readonly FinancialCfoFindingProjection[];
  readonly rejectedFindingIds: readonly string[];
  readonly unresolvedConflicts: readonly {
    readonly conflictId: string;
    readonly type: FinancialCouncilConflictKind;
    readonly findingIds: readonly string[];
    readonly status: "unresolved";
  }[];
  readonly dataGapRefs: readonly string[];
}

export interface FinancialCfoNarrativeOutput {
  readonly overallDiagnosis: string;
  readonly priorityFindingIds: readonly string[];
  readonly minorityFindingIds: readonly string[];
  readonly riskNotes: readonly string[];
}

export interface FinancialCfoNarrative extends FinancialCfoNarrativeOutput {
  readonly narrativeStatus:
    | "model_valid"
    | "model_unavailable"
    | "model_invalid";
}

export interface FinancialCouncilModelAllowlist {
  readonly evidenceRefIds: readonly string[];
  readonly formulaRefIds: readonly string[];
  readonly findingIds: readonly string[];
  readonly subjectRefs: readonly string[];
  readonly dataGapRefs: readonly string[];
}

export interface FinancialCouncilAnalyzeInput {
  readonly ownerId: string;
  readonly teamId: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly role: FinancialCouncilAgentRole;
  readonly attempt: number;
  readonly allowlist: FinancialCouncilModelAllowlist;
  /** Minimal role projection. Every string in this value is untrusted data. */
  readonly businessData: unknown;
}

export interface FinancialCouncilRebutInput
  extends FinancialCouncilAnalyzeInput {
  /** The only finding identity this rebuttal may uphold, revise, or withdraw. */
  readonly targetFindingId: string;
  /** Exact conflict projection. Every string in this value is untrusted data. */
  readonly conflictData: unknown;
}

export interface FinancialCouncilFindingDraft {
  readonly findingId: string;
  readonly conclusion: string;
  readonly evidenceRefs: readonly string[];
  readonly formulaRef: string | null;
  readonly confidenceBps: number;
  readonly severity: "info" | "warning" | "critical";
  readonly assumptions: readonly string[];
  readonly missingDataRefs: readonly string[];
}

export interface FinancialCouncilAnalyzeOutput {
  readonly findingDrafts: readonly FinancialCouncilFindingDraft[];
  readonly actionHypotheses: readonly FinancialActionHypothesis[];
}

export interface FinancialCouncilRebutOutput {
  readonly decision: "uphold" | "revise" | "withdraw";
  readonly findingId: string;
  readonly evidenceRefs: readonly string[];
  readonly replacement: FinancialCouncilFindingDraft | null;
  readonly explanation: string;
}

export interface FinancialCouncilModelBinding {
  readonly jobId: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly role: FinancialCouncilModelRole;
  readonly phase: FinancialCouncilModelPhase;
  readonly attempt: number;
  readonly connectionId: string;
  readonly credentialVersion: number;
  readonly provider: ModelProviderId;
  readonly model: string;
  readonly capabilitySnapshotHash: `sha256:${string}`;
  readonly baseUrlFingerprint: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly contentHash: `sha256:${string}`;
  readonly promptHash: `sha256:${string}`;
  readonly schemaHash: `sha256:${string}`;
}

export interface FinancialCouncilModelResult<Value> {
  readonly value: Value;
  readonly binding: FinancialCouncilModelBinding;
  readonly repaired: boolean;
  readonly providerRequestId: string | null;
}

export interface FinancialCouncilModelPort {
  analyze(
    input: FinancialCouncilAnalyzeInput
  ): Promise<FinancialCouncilModelResult<FinancialCouncilAnalyzeOutput>>;
  rebut(
    input: FinancialCouncilRebutInput
  ): Promise<FinancialCouncilModelResult<FinancialCouncilRebutOutput>>;
  synthesize(
    input: FinancialCfoNarrativeInput
  ): Promise<FinancialCfoNarrativeOutput>;
}

export type FinancialCouncilModelFailureCode =
  | "financial_council_model_input_invalid"
  | "financial_council_model_snapshot_mismatch"
  | "financial_council_model_snapshot_persistence_failed"
  | "financial_council_model_output_invalid"
  | "financial_council_model_timeout"
  | "financial_council_model_rate_limited"
  | "financial_council_model_provider_failed"
  | "financial_council_model_ledger_persistence_failed"
  | "not_computable:model_connection_unavailable"
  | "not_computable:model_credential_unavailable"
  | "not_computable:model_structured_output_unavailable";

export class FinancialCouncilModelError extends Error {
  constructor(
    public readonly code: FinancialCouncilModelFailureCode,
    public readonly retryable: boolean,
    public readonly retryAfterMs: number | null = null,
    options?: ErrorOptions
  ) {
    super(code, options);
    this.name = "FinancialCouncilModelError";
  }
}
