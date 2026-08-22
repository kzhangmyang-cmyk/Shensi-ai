import { createHash } from "node:crypto";
import { z } from "zod";
import {
  discoveryEvidencePublicSourceUrl,
  type AcquisitionCandidate,
  type BattleCardInput,
  type DiscoveryEvidence,
  type DiscoveryEvidenceInput,
  type FinancialSummary,
  type FinancialValueDecision,
  type FinancialValueInput,
  type OutcomeEventType,
  type QualificationHardGates,
  type QualificationInput
} from "./acquisition-domain.js";
import {
  AcquisitionDomainError,
  type AcquisitionActorScope,
  AcquisitionDomainService
} from "./acquisition-domain-service.js";
import {
  ACQUISITION_AGENT_TOOL_NAMES,
  type AcquisitionAgentToolExecutor,
  type AcquisitionToolExecutionInput
} from "./acquisition-pi-tools.js";
import {
  ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION,
  acquisitionPublicIdentityDisposition,
  isSafeAcquisitionPublicActorKey,
  normalizeAcquisitionPublicCreditCode,
  normalizeAcquisitionPublicDomain,
  normalizeAcquisitionPublicUrl,
  resolveAcquisitionPublicIdentity,
  type AcquisitionPublicIdentityDisposition
} from "./acquisition-public-identity-resolver.js";
import type {
  DouyinPublicSourceType
} from "./acquisition-douyin-public-source.js";
import {
  AcquisitionIndividualSignalIngestionService,
  type AcquisitionIndividualSignalIngestionPort
} from "./acquisition-individual-signal-ingestion.js";
import type {
  AcquisitionPerformanceQueryService
} from "./acquisition-performance-query.js";
import {
  normalizeShanghaiPerformanceWindow
} from "./acquisition-performance-window.js";
import {
  assertGrowthCommercialToolPorts,
  type GrowthCommercialToolCall,
  type GrowthCommercialToolPorts
} from "./growth-commercial-application.js";
import type { CommandContext } from "./growth-command-context.js";

const TOOL_NAMES = new Set<string>(ACQUISITION_AGENT_TOOL_NAMES);
const GRADE_RANK = { S: 0, A: 1, B: 2, C: 3, D: 4 } as const;
const STRATEGY_VERSION = "acquisition-agent-tool.v1";

type SubjectKind = "organization" | "individual";
type Grade = keyof typeof GRADE_RANK;

export type AcquisitionToolExecutorErrorCode =
  | "ABORTED"
  | "INVALID_IDENTITY"
  | "IDENTITY_RESEARCH_REQUIRED"
  | "INVALID_PAYLOAD"
  | "UNKNOWN_TOOL"
  | "SEARCH_PROVIDER_CONNECTION_REQUIRED"
  | "SEARCH_ALL_PROVIDERS_FAILED"
  | "RESOURCE_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_STATE"
  | "HARD_GATE_BLOCKED"
  | "EVIDENCE_REQUIRED"
  | "STALE_DECISION"
  | "CONVERSION_FAILED"
  | "ELIGIBILITY_BLOCKED"
  | "ACTION_NOT_EXECUTED"
  | "ACTION_EXECUTION_MISMATCH"
  | "INVALID_JUDGMENT_RESULT"
  | "UNSUPPORTED_CURRENCY"
  | "LEGACY_OUTCOME_TOOL_READ_ONLY"
  | "TOOL_EXECUTION_FAILED";

export class AcquisitionToolExecutorError extends Error {
  constructor(public readonly code: AcquisitionToolExecutorErrorCode) {
    super(code);
    this.name = "AcquisitionToolExecutorError";
  }
}

export class AcquisitionToolIdempotencyConflictError extends Error {
  constructor() {
    super("IDEMPOTENCY_CONFLICT");
    this.name = "AcquisitionToolIdempotencyConflictError";
  }
}

export interface SearchPublicSourcesRequest {
  ownerId: string;
  teamId: string;
  actorId: string;
  sessionId: string;
  providerConnectionId: string;
  expectedConnection?: {
    readonly providerId: string;
    readonly credentialVersion: number;
  };
  query: string;
  subjectKinds: SubjectKind[];
  maxResults: number;
  signal?: AbortSignal;
}

export type SearchPublicSourceSubject =
  | {
      kind: "organization";
      name: string;
      domain: string | null;
      region: string | null;
      creditCode: string | null;
      organizationId?: string | null;
    }
  | {
      kind: "individual";
      publicActorKey: string;
      publicDisplayName: string;
      publicProfileUrl: string;
      sourcePlatform: string;
      demandCategory: string;
      demandSummary: string;
      locationHint: string;
      buyingStage:
        | "awareness"
        | "problem_defined"
        | "solution_research"
        | "comparison"
        | "purchase_ready";
      negativeSignals: string[];
      individualPartyId?: string | null;
    };

export interface SearchPublicSourceResult {
  providerRecordId: string;
  sourceUrl: string;
  sourcePlatform?: string;
  sourceType?: DouyinPublicSourceType;
  title: string;
  snippet: string;
  publishedAt: string | null;
  locale: string;
  rawArtifactHash: string;
  accessStatus:
    | "indexed_summary"
    | "public_content"
    | "access_restricted";
  subject: SearchPublicSourceSubject;
}

export interface SearchPublicSourcesResponse {
  providerConnectionId: string;
  providerCredentialVersion: number;
  provider: string;
  requestId: string;
  results: SearchPublicSourceResult[];
}

/**
 * This port must resolve only connections authorized for ownerId/teamId.
 * Implementations receive one selected connection per call so that one
 * provider failure cannot hide successful results from other providers.
 */
export interface SearchPublicSourcesPort {
  search(input: SearchPublicSourcesRequest): Promise<SearchPublicSourcesResponse>;
}

/**
 * Resolves only active search connections that belong to the supplied tenant
 * scope. Implementations must never return credentials or configuration.
 */
export interface AcquisitionSearchConnectionDirectoryPort {
  listActiveConnectionIds(scope: {
    ownerId: string;
    teamId: string;
  }): Promise<string[]>;
}

export interface AcquisitionCandidateIndexEntry {
  ownerId: string;
  teamId: string;
  candidateId: string;
  dedupeKey: string;
  partyType: SubjectKind;
  indexedAt: string;
}

/**
 * The directory is an index, never an authorization source. Every candidate
 * returned by it is re-read through AcquisitionDomainService under tenant scope.
 */
export interface AcquisitionCandidateDirectoryPort {
  /**
   * Must atomically serialize ownerId/teamId/dedupeKey and invoke
   * createCandidate at most once. A database implementation should use a
   * unique key plus transaction/row lock; find-then-insert is not compliant.
   */
  upsertCandidate(input: {
    ownerId: string;
    teamId: string;
    dedupeKey: string;
    partyType: SubjectKind;
    idempotencyKey: string;
    createCandidate: () => Promise<AcquisitionCandidate>;
  }): Promise<{
    entry: AcquisitionCandidateIndexEntry;
    created: boolean;
  }>;
}

export interface AcquisitionPriorityCandidateRow {
  candidateId: string;
  qualificationGrade: Grade | null;
  qualificationScore: number | null;
  financialScore: number | null;
  updatedAt: string;
}

/**
 * Filtering, joining, and sorting happen in storage before LIMIT. This avoids
 * fetching an arbitrary window and ranking it in memory.
 */
export interface AcquisitionPriorityCandidatePort {
  listPriorityCandidates(input: {
    ownerId: string;
    teamId: string;
    subjectKinds?: SubjectKind[];
    minimumGrade?: Grade;
    limit: number;
    sort: "qualification_and_financial_desc";
  }): Promise<AcquisitionPriorityCandidateRow[]>;
}

export type AcquisitionReviewTaskStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed";

export interface AcquisitionReviewTask {
  id: string;
  ownerId: string;
  teamId: string;
  actorId: string;
  sessionId: string;
  candidateId: string;
  proposedAction:
    | "public_reply"
    | "private_domain_invitation"
    | "phone_call"
    | "email"
    | "meeting"
    | "convert";
  rationale: string;
  idempotencyKey: string;
  status: AcquisitionReviewTaskStatus;
  createdAt: string;
}

/**
 * create() must implement durable idempotency on
 * ownerId/teamId/idempotencyKey. This port creates review work only; it has no
 * capability to send a message, place a call, add a friend, or convert a lead.
 */
export interface AcquisitionReviewTaskPort {
  create(
    input: Omit<AcquisitionReviewTask, "id" | "status" | "createdAt">
  ): Promise<AcquisitionReviewTask>;
  get(
    scope: { ownerId: string; teamId: string },
    reviewTaskId: string
  ): Promise<AcquisitionReviewTask | null>;
}

export interface AcquisitionActionExecutionReceipt {
  executionId: string;
  ownerId: string;
  teamId: string;
  candidateId: string;
  reviewTaskId: string;
  proposedAction: AcquisitionReviewTask["proposedAction"];
  executedAt: string;
  credential: {
    issuer: string;
    credentialId: string;
    proofHash: string;
  };
}

/**
 * This read-only port verifies execution credentials produced by the separate
 * human/action worker. The acquisition agent never receives an execution port.
 */
export interface AcquisitionActionExecutionPort {
  getVerifiedExecution(
    scope: { ownerId: string; teamId: string },
    reviewTaskId: string
  ): Promise<AcquisitionActionExecutionReceipt | null>;
}

/**
 * Durable, atomic result ledger for every tool, including reads. Implementors
 * must key by owner/team/tool/idempotencyKey, compare requestHash, serialize
 * concurrent execution, and persist only successful results.
 */
export interface AcquisitionToolResultLedgerPort {
  executeOnce<T>(
    input: {
      ownerId: string;
      teamId: string;
      actorId: string;
      sessionId: string;
      toolName: string;
      idempotencyKey: string;
      requestHash: string;
    },
    operation: () => Promise<T>
  ): Promise<T>;
}

export interface AcquisitionResearchResult {
  summary: string;
  findings: Array<{
    label: string;
    content: string;
    evidenceIds: string[];
    confidence: number | null;
  }>;
}

export interface AcquisitionConnectionDraft {
  channel:
    | "public_reply"
    | "enterprise_wechat"
    | "phone"
    | "email"
    | "referral"
    | "meeting";
  draft: string;
  rationale: string;
}

/**
 * Optional model/rule extension point. Absence never causes optimistic
 * invention: the executor falls back to explicit conservative rules.
 */
export interface AcquisitionJudgmentPort {
  research?(input: {
    scope: AcquisitionActorScope;
    sessionId: string;
    candidate: AcquisitionCandidate;
    evidence: DiscoveryEvidence[];
    depth: "standard" | "deep";
    researchQuestions: string[];
    signal?: AbortSignal;
  }): Promise<AcquisitionResearchResult>;
  qualify?(input: {
    scope: AcquisitionActorScope;
    sessionId: string;
    candidate: AcquisitionCandidate;
    evidence: DiscoveryEvidence[];
    policyVersion: string;
    signal?: AbortSignal;
  }): Promise<{
    qualification: QualificationInput;
    financial: FinancialValueInput;
  }>;
  buildBattleCard?(input: {
    scope: AcquisitionActorScope;
    sessionId: string;
    candidate: AcquisitionCandidate;
    evidence: DiscoveryEvidence[];
    templateVersion: string;
    financialSummary: FinancialSummary | null;
    signal?: AbortSignal;
  }): Promise<BattleCardInput>;
  draftConnectionStrategy?(input: {
    scope: AcquisitionActorScope;
    sessionId: string;
    candidate: AcquisitionCandidate;
    evidence: DiscoveryEvidence[];
    targetRole: string;
    channels: AcquisitionConnectionDraft["channel"][];
    signal?: AbortSignal;
  }): Promise<AcquisitionConnectionDraft[]>;
}

export interface ProductionAcquisitionAgentToolExecutorOptions {
  domain: AcquisitionDomainService;
  growthToolPorts: GrowthCommercialToolPorts;
  growthCommercialTools?: GrowthAcquisitionToolDelegate;
  search: SearchPublicSourcesPort;
  searchConnections: AcquisitionSearchConnectionDirectoryPort;
  candidateDirectory: AcquisitionCandidateDirectoryPort;
  priorityCandidates: AcquisitionPriorityCandidatePort;
  reviewTasks: AcquisitionReviewTaskPort;
  actionExecutions: AcquisitionActionExecutionPort;
  toolResults: AcquisitionToolResultLedgerPort;
  individualSignals?: AcquisitionIndividualSignalIngestionPort;
  judgments?: AcquisitionJudgmentPort;
  performance?: Pick<AcquisitionPerformanceQueryService, "get">;
  now?: () => string;
  maxEvidenceAgeDays?: number;
}

/**
 * Domain-neutral Acquisition-owned seam for the single Growth delegate (or
 * later composite). It deliberately exposes no Quote or Advisor services.
 */
export interface GrowthAcquisitionToolDelegate {
  owns(toolName: string): boolean;
  execute(input: AcquisitionToolExecutionInput): Promise<unknown>;
}

const httpUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
});
const publicHttpUrl = httpUrl.refine(
  (value) => normalizeAcquisitionPublicUrl(value) !== null
);

const subjectKindsSchema = z.array(
  z.enum(["organization", "individual"])
).min(1).max(2).refine(
  (values) => new Set(values).size === values.length
);

const schemas = {
  search_public_sources: z.object({
    query: z.string().trim().min(2).max(1_000),
    providerConnectionIds: z.array(z.string().trim().min(1).max(255))
      .min(1).max(10).refine(
        (values) => new Set(values).size === values.length
      ).optional(),
    subjectKinds: subjectKindsSchema,
    maxResults: z.number().int().min(1).max(100)
  }).strict(),
  get_candidate_evidence: z.object({
    candidateId: z.string().trim().min(1).max(255)
  }).strict(),
  research_candidate: z.object({
    candidateId: z.string().trim().min(1).max(255),
    depth: z.enum(["standard", "deep"]),
    researchQuestions: z.array(z.string().trim().min(2).max(500))
      .max(12).optional()
  }).strict(),
  qualify_candidate: z.object({
    candidateId: z.string().trim().min(1).max(255),
    policyVersion: z.string().trim().min(1).max(100)
  }).strict(),
  build_battle_card: z.object({
    candidateId: z.string().trim().min(1).max(255),
    templateVersion: z.string().trim().min(1).max(100).optional()
  }).strict(),
  estimate_financial_value: z.object({
    candidateId: z.string().trim().min(1).max(255),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    policyVersion: z.string().trim().min(1).max(100).optional()
  }).strict(),
  draft_connection_strategy: z.object({
    candidateId: z.string().trim().min(1).max(255),
    targetRole: z.string().trim().min(1).max(100),
    channels: z.array(z.enum([
      "public_reply",
      "enterprise_wechat",
      "phone",
      "email",
      "referral",
      "meeting"
    ])).min(1).max(6).refine(
      (values) => new Set(values).size === values.length
    )
  }).strict(),
  list_priority_candidates: z.object({
    subjectKinds: subjectKindsSchema.optional(),
    minimumGrade: z.enum(["S", "A", "B", "C", "D"]).optional(),
    limit: z.number().int().min(1).max(100)
  }).strict(),
  create_review_task: z.object({
    candidateId: z.string().trim().min(1).max(255),
    proposedAction: z.enum([
      "public_reply",
      "private_domain_invitation",
      "phone_call",
      "email",
      "meeting",
      "convert"
    ]),
    rationale: z.string().trim().min(2).max(2_000)
  }).strict(),
  record_outcome: z.object({
    candidateId: z.string().trim().min(1).max(255),
    reviewTaskId: z.string().trim().min(1).max(255),
    outcome: z.enum([
      "contacted",
      "replied",
      "qualified",
      "converted",
      "won",
      "lost",
      "do_not_contact"
    ]),
    occurredAt: z.string().datetime({ offset: true }),
    amountMinor: z.number().int().nonnegative()
      .max(Number.MAX_SAFE_INTEGER).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/u).optional(),
    notes: z.string().max(2_000).optional()
  }).strict().superRefine((value, context) => {
    if ((value.amountMinor === undefined) !== (value.currency === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "amount and currency must be provided together"
      });
    }
  }),
  get_acquisition_performance: z.object({
    platform: z.enum(["douyin", "web"]).optional(),
    from: z.string(),
    to: z.string()
  }).strict().transform((value, context) => {
    const normalized = normalizeShanghaiPerformanceWindow(value);
    if (!normalized.ok) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [normalized.issue.field],
        message: normalized.issue.message
      });
      return z.NEVER;
    }
    return {
      platform: value.platform,
      from: normalized.value.fromInclusiveUtc,
      to: normalized.value.toInclusiveUtc
    };
  })
} as const;

const organizationSubjectSchema = z.object({
  kind: z.literal("organization"),
  name: z.string().trim().min(1).max(200),
  domain: z.string().trim().max(255).nullable(),
  region: z.string().trim().max(120).nullable(),
  creditCode: z.string().trim().max(50).nullable(),
  organizationId: z.string().trim().min(1).max(100).nullable().optional()
}).strict();

const individualSubjectSchema = z.object({
  kind: z.literal("individual"),
  publicActorKey: z.string().trim().min(1).max(300)
    .refine(isSafeAcquisitionPublicActorKey),
  publicDisplayName: z.string().trim().min(1).max(200),
  publicProfileUrl: publicHttpUrl,
  sourcePlatform: z.string().trim().min(1).max(100),
  demandCategory: z.string().trim().min(1).max(100),
  demandSummary: z.string().trim().min(1).max(2_000),
  locationHint: z.string().trim().max(200),
  buyingStage: z.enum([
    "awareness",
    "problem_defined",
    "solution_research",
    "comparison",
    "purchase_ready"
  ]),
  negativeSignals: z.array(z.string().trim().min(1).max(500)).max(50),
  individualPartyId: z.string().trim().min(1).max(100).nullable().optional()
}).strict();

const searchResultSchema = z.object({
  providerRecordId: z.string().trim().min(1).max(255),
  sourceUrl: publicHttpUrl,
  sourcePlatform: z.string().trim().min(1).max(100).optional(),
  sourceType: z.enum([
    "profile",
    "video",
    "comment_signal",
    "short_link",
    "other"
  ]).optional(),
  title: z.string().trim().max(500),
  snippet: z.string().trim().max(4_000),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  locale: z.string().trim().min(1).max(30),
  rawArtifactHash: z.string().regex(/^sha256:[a-f0-9]{64}$/iu),
  accessStatus: z.enum([
    "indexed_summary",
    "public_content",
    "access_restricted"
  ]),
  subject: z.discriminatedUnion("kind", [
    organizationSubjectSchema,
    individualSubjectSchema
  ])
}).strict().refine(
  (value) => Boolean(value.title || value.snippet),
  "title or snippet is required"
);

const searchResponseEnvelopeSchema = z.object({
  providerConnectionId: z.string().trim().min(1).max(255),
  providerCredentialVersion: z.number().int().positive()
    .max(Number.MAX_SAFE_INTEGER),
  provider: z.string().trim().min(1).max(100),
  requestId: z.string().trim().min(1).max(500),
  results: z.array(z.unknown()).max(100)
}).strict();

const researchJudgmentSchema = z.object({
  summary: z.string().trim().min(1).max(8_000),
  findings: z.array(z.object({
    label: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(4_000),
    evidenceIds: z.array(z.string().trim().min(1).max(100)).max(100),
    confidence: z.number().min(0).max(1).nullable()
  }).strict()).max(100)
}).strict();

const actionExecutionReceiptSchema = z.object({
  executionId: z.string().trim().min(1).max(255),
  ownerId: z.string().trim().min(1).max(100),
  teamId: z.string().trim().min(1).max(100),
  candidateId: z.string().trim().min(1).max(255),
  reviewTaskId: z.string().trim().min(1).max(255),
  proposedAction: z.enum([
    "public_reply",
    "private_domain_invitation",
    "phone_call",
    "email",
    "meeting",
    "convert"
  ]),
  executedAt: z.string().datetime({ offset: true }),
  credential: z.object({
    issuer: z.string().trim().min(1).max(255),
    credentialId: z.string().trim().min(1).max(255),
    proofHash: z.string().regex(/^sha256:[a-f0-9]{64}$/iu)
  }).strict()
}).strict();

const connectionDraftSchema = z.object({
  channel: z.enum([
    "public_reply",
    "enterprise_wechat",
    "phone",
    "email",
    "referral",
    "meeting"
  ]),
  draft: z.string().trim().min(1).max(8_000),
  rationale: z.string().trim().min(1).max(2_000)
}).strict();

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown) {
  return hash(JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(
        Object.entries(nested as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
      );
    }
    return nested;
  }));
}

function childIdempotencyKey(
  parent: string,
  operation: string,
  material: unknown
) {
  return `${parent}:${operation}:${hashJson(material).slice(0, 32)}`;
}

function abortError(): AcquisitionToolExecutorError {
  return new AcquisitionToolExecutorError("ABORTED");
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function toolError(
  code: AcquisitionToolExecutorErrorCode
): AcquisitionToolExecutorError {
  return new AcquisitionToolExecutorError(code);
}

function domainErrorCode(
  error: AcquisitionDomainError
): AcquisitionToolExecutorErrorCode {
  const mapping: Record<string, AcquisitionToolExecutorErrorCode> = {
    invalid_request: "INVALID_PAYLOAD",
    resource_not_found: "RESOURCE_NOT_FOUND",
    idempotency_conflict: "IDEMPOTENCY_CONFLICT",
    invalid_state: "INVALID_STATE",
    hard_gate_blocked: "HARD_GATE_BLOCKED",
    evidence_required: "EVIDENCE_REQUIRED",
    stale_decision: "STALE_DECISION",
    conversion_failed: "CONVERSION_FAILED"
  };
  return mapping[error.code] ?? "TOOL_EXECUTION_FAILED";
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function publicRecord<T extends Record<string, unknown>>(value: T) {
  const result = structuredClone(value);
  delete result.ownerId;
  delete result.teamId;
  return result;
}

export function normalizeAcquisitionRegion(value: string | null) {
  if (value === null) return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\s,，、/]+/gu, " ")
    .trim();
  return normalized || null;
}

function evidenceInput(
  response: SearchPublicSourcesResponse,
  result: SearchPublicSourceResult,
  query: string,
  rank: number
): DiscoveryEvidenceInput {
  return {
    targetType: result.subject.kind === "organization"
      ? "organization"
      : "individual_signal",
    sourcePlatform: result.sourcePlatform ?? response.provider,
    sourceTitle: result.title,
    sourceSnippet: result.snippet,
    publishedAt: result.publishedAt,
    locale: result.locale,
    rawArtifactHash: result.rawArtifactHash,
    contentHash: `sha256:${hashJson({
      sourceUrl: result.sourceUrl,
      title: result.title,
      snippet: result.snippet
    })}`,
    provenance: {
      kind: "search_result",
      provider: response.provider,
      providerConnectionId: response.providerConnectionId,
      requestId: response.requestId,
      providerRecordId: result.providerRecordId,
      queryText: query,
      sourceUrl: result.sourceUrl,
      resultRank: rank,
      sourceType: result.sourceType
    },
    accessStatus: result.accessStatus,
    supersedesEvidenceId: null
  };
}

function projectCandidate(
  candidate: AcquisitionCandidate,
  identityResolution?: AcquisitionPublicIdentityDisposition
) {
  const projected = publicRecord(
    candidate as unknown as Record<string, unknown>
  );
  return identityResolution
    ? { ...projected, identityResolution }
    : projected;
}

function projectEvidence(evidence: DiscoveryEvidence) {
  return publicRecord(evidence as unknown as Record<string, unknown>);
}

function defaultFinancial(currency = "CNY"): FinancialValueInput {
  return {
    currency,
    predictedDealAmountMinor: 0,
    grossMarginBps: 0,
    closeProbabilityBps: 1_000,
    acquisitionCostMinor: 0,
    salesCostMinor: 0,
    serviceCostMinor: 0,
    benchmarkDealAmountMinor: 1,
    collectionDays: 90,
    creditRisk: 50,
    repeatPotential: 10,
    referralPotential: 10
  };
}

function buyingStageScore(candidate: AcquisitionCandidate) {
  if (candidate.profile.kind === "organization") return 55;
  return {
    awareness: 20,
    problem_defined: 45,
    solution_research: 60,
    comparison: 75,
    purchase_ready: 90
  }[candidate.profile.buyingStage];
}

function publicDecisionEvidence(evidence: DiscoveryEvidence[]) {
  return evidence.filter((item) =>
    ["indexed_summary", "public_content"].includes(item.accessStatus)
    && item.provenance.kind !== "import_artifact_row"
    && discoveryEvidencePublicSourceUrl(item) !== null
  );
}

function candidateIdentityDisposition(
  candidate: AcquisitionCandidate
): AcquisitionPublicIdentityDisposition {
  if (candidate.profile.kind === "organization"
    && candidate.partyRef.partyType === "organization") {
    if (candidate.partyRef.organizationId.startsWith("unresolved-org-")) {
      return {
        status: "needs_research",
        basis: null,
        reasonCode: "insufficient_public_organization_identity",
        resolverVersion: ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION
      };
    }
    return {
      status: "resolved",
      basis: normalizeAcquisitionPublicDomain(candidate.profile.domain)
        ? "organization_domain"
        : normalizeAcquisitionPublicCreditCode(candidate.profile.creditCode)
          ? "organization_credit_code"
          : "manual_binding",
      reasonCode: null,
      resolverVersion: ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION
    };
  }
  if (candidate.profile.kind === "individual"
    && candidate.partyRef.partyType === "individual") {
    if (candidate.partyRef.individualPartyId.startsWith(
      "unresolved-individual-"
    )) {
      return {
        status: "needs_research",
        basis: null,
        reasonCode: "insufficient_provider_public_actor_identity",
        resolverVersion: ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION
      };
    }
    return {
      status: "resolved",
      basis: "provider_public_actor",
      reasonCode: null,
      resolverVersion: ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION
    };
  }
  return {
    status: "needs_research",
    basis: null,
    reasonCode: candidate.partyType === "organization"
      ? "insufficient_public_organization_identity"
      : "insufficient_provider_public_actor_identity",
    resolverVersion: ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION
  };
}

function deterministicHardGates(
  candidate: AcquisitionCandidate,
  evidence: DiscoveryEvidence[],
  now: string,
  maxEvidenceAgeDays: number
): QualificationHardGates {
  const decisionEvidence = publicDecisionEvidence(evidence);
  const negativeSignals = candidate.profile.kind === "individual"
    ? candidate.profile.negativeSignals
    : [];
  const rejectionPattern = /(?:不需要|别联系|不要联系|拒绝联系|请勿联系|勿扰)/u;
  const explicitRejection = negativeSignals.some((value) =>
    rejectionPattern.test(value)
  ) || evidence.some((item) => rejectionPattern.test(item.sourceSnippet));
  const nowMs = new Date(now).getTime();
  const maxAgeMs = maxEvidenceAgeDays * 86_400_000;
  const evidenceFresh = decisionEvidence.length > 0
    && decisionEvidence.every((item) => {
      const sourceTime = new Date(item.publishedAt ?? item.fetchedAt).getTime();
      return Number.isFinite(sourceTime)
        && Number.isFinite(nowMs)
        && nowMs >= sourceTime
        && nowMs - sourceTime <= maxAgeMs;
    });
  const schemaValid = decisionEvidence.length > 0
    && decisionEvidence.every((item) => {
      const sourceUrl = discoveryEvidencePublicSourceUrl(item);
      if (!sourceUrl
        || !/^sha256:[a-f0-9]{64}$/iu.test(item.rawArtifactHash)
        || !/^sha256:[a-f0-9]{64}$/iu.test(item.contentHash)) {
        return false;
      }
      try {
        return ["http:", "https:"].includes(new URL(sourceUrl).protocol);
      } catch {
        return false;
      }
    });
  return {
    hasOriginalSource: decisionEvidence.length > 0,
    identityResolved: candidate.profile.kind === "organization"
      && candidate.partyRef.partyType === "organization"
      ? Boolean(
          candidate.profile.name
          && candidate.partyRef.organizationId
          && !candidate.partyRef.organizationId.startsWith("unresolved-org-")
        )
      : candidate.profile.kind === "individual"
        && candidate.partyRef.partyType === "individual"
        ? Boolean(
            candidate.profile.publicActorKey
            && candidate.profile.publicProfileUrl
            && candidate.partyRef.individualPartyId
            && !candidate.partyRef.individualPartyId.startsWith(
              "unresolved-individual-"
            )
          )
        : false,
    notDoNotContact: candidate.status !== "do_not_contact",
    noExplicitRejection: !explicitRejection,
    publicDataOnly: decisionEvidence.length > 0,
    evidenceFresh,
    schemaValid
  };
}

function conservativeQualification(
  candidate: AcquisitionCandidate,
  evidence: DiscoveryEvidence[],
  policyVersion: string,
  hardGates: QualificationHardGates
): QualificationInput {
  const negativeSignals = candidate.profile.kind === "individual"
    ? candidate.profile.negativeSignals
    : [];
  const explicitRejection = negativeSignals.some((value) =>
    /(?:不需要|别联系|不要联系|拒绝|勿扰)/u.test(value)
  );
  const providers = new Set(evidence.map((item) =>
    item.provenance.kind === "search_result"
      ? item.provenance.provider
      : item.sourcePlatform
  ));
  return {
    decisionEngine: "rules",
    ruleVersion: policyVersion,
    promptVersion: null,
    modelProvider: null,
    model: null,
    dimensions: {
      demandStrength: candidate.profile.kind === "individual" ? 65 : 55,
      fit: 50,
      identityConfidence: 75,
      buyingStage: buyingStageScore(candidate),
      budgetPotential: 20,
      decisionReachability: 20,
      freshness: 70,
      evidenceDiversity: Math.min(80, providers.size * 30),
      negativeSignalRisk: explicitRejection ? 100 : 10,
      contactRisk: 35
    },
    hardGates,
    evidenceExcerpts: Object.fromEntries(
      evidence.map((item) => [item.id, item.sourceSnippet.slice(0, 500)])
    ),
    reasons: [
      "未配置模型判断端口，采用保守规则评分；未知预算、决策链和采购偏好不会被推断为高分。"
    ]
  };
}

function defaultBattleCard(
  evidence: DiscoveryEvidence[],
  templateVersion: string
): BattleCardInput {
  const first = evidence[0];
  if (!first) throw toolError("EVIDENCE_REQUIRED");
  if (templateVersion === "battle-card.v2") {
    const fact = {
      kind: "fact" as const,
      text: first.sourceSnippet || first.sourceTitle,
      evidenceIds: [first.id],
      confidence: 1
    };
    return {
      schemaVersion: "battle-card.v2",
      intelligence: {
        accountOverview: [fact],
        needAssessment: [fact],
        supplierHypotheses: [{
          kind: "unknown",
          text: "公开证据不足，需由销售或后续研究核验现有供应商。",
          evidenceIds: [],
          confidence: null
        }],
        buyingCommittee: [],
        procurementPreferences: [{
          kind: "unknown",
          text: "当前没有足够公开商务证据判断采购偏好。",
          evidenceIds: [],
          confidence: null
        }],
        connectionStrategies: [{
          channel: "public_reply",
          targetRole: "公开业务负责人",
          rationale: fact,
          openingDraft:
            "建议人工审核后，基于公开需求做温和澄清并提供诊断资料。"
        }],
        roleSpecificOpeners: [{
          role: "公开业务负责人",
          channel: "public_reply",
          text: "看到贵方公开提到相关业务需求，我们整理了一页诊断供参考。"
        }],
        doNotActions: [
          "不要臆测决策人身份、采购偏好或现有供应商",
          "不要自动私信、加好友或发送消息"
        ]
      },
      confidence: 0.45,
      modelProvider: "rules",
      model: "conservative-template",
      promptVersion: templateVersion
    };
  }
  return {
    schemaVersion: "battle-card.v1",
    sections: [
      {
        label: "公开需求证据",
        kind: "fact",
        content: first.sourceSnippet || first.sourceTitle,
        evidenceIds: [first.id],
        confidence: 1
      },
      {
        label: "现有供应商",
        kind: "unknown",
        content: "公开证据不足，需由销售或后续研究核验。",
        evidenceIds: [],
        confidence: null
      },
      {
        label: "关键决策人与采购偏好",
        kind: "unknown",
        content: "当前没有足够公开商务证据，不做个人性格或私生活推断。",
        evidenceIds: [],
        confidence: null
      }
    ],
    confidence: 0.45,
    modelProvider: "rules",
    model: "conservative-template",
    promptVersion: templateVersion
  };
}

function persistedFinancialSummary(
  decision: FinancialValueDecision
): FinancialSummary {
  return {
    decisionId: decision.id,
    decisionVersion: decision.version,
    grade: decision.grade,
    score: decision.score,
    currency: decision.currency,
    expectedRevenueMinor: decision.expectedRevenueMinor,
    expectedGrossProfitMinor: decision.expectedGrossProfitMinor,
    expectedContributionMinor: decision.expectedContributionMinor,
    factors: structuredClone(decision.factors)
  };
}

function defaultConnectionDrafts(
  channels: AcquisitionConnectionDraft["channel"][],
  targetRole: string
): AcquisitionConnectionDraft[] {
  const drafts: Record<
    AcquisitionConnectionDraft["channel"],
    { draft: string; rationale: string }
  > = {
    public_reply: {
      draft: `您好，看到贵方公开提到相关业务需求。若方便，${targetRole}可补充当前目标与使用场景，我们可以先提供一份匹配度诊断供评估。`,
      rationale: "只基于公开需求做温和澄清，不索取私密信息。"
    },
    enterprise_wechat: {
      draft: "如您愿意进一步沟通，可由您主动选择企业微信等官方渠道；建议先确认需求范围，再安排人工顾问。",
      rationale: "由客户主动选择合规私域入口，必须经人工审核。"
    },
    phone: {
      draft: "建议人工先核验公开商务号码与联系授权，再以需求确认和诊断为开场，不直接推销或报价。",
      rationale: "这里只生成销售准备建议，不拨打电话。"
    },
    email: {
      draft: "主题：关于公开业务需求的一页诊断建议\n正文：您好，我们基于贵方公开信息整理了初步诊断。如该需求仍有效，可由您回复确认，我们再提供适配建议。",
      rationale: "只生成草稿，不发送邮件。"
    },
    referral: {
      draft: `如存在已授权的共同商务联系人，可请其先确认${targetRole}是否愿意了解诊断建议，再由人工跟进。`,
      rationale: "先征得意愿，不利用非公开关系数据。"
    },
    meeting: {
      draft: "建议由人工发起一个 20 分钟需求诊断会议邀请，议程仅包含现状、目标、数据口径与下一步。",
      rationale: "只提供会议策略草稿，不创建或发送邀请。"
    }
  };
  return channels.map((channel) => ({ channel, ...drafts[channel] }));
}

function mapOutcome(
  outcome:
    | "contacted"
    | "replied"
    | "qualified"
    | "converted"
    | "won"
    | "lost"
    | "do_not_contact"
): OutcomeEventType {
  if (outcome === "qualified") return "need_confirmed";
  if (outcome === "converted") return "private_domain_entered";
  return outcome;
}

function actionSupportsOutcome(
  action: AcquisitionReviewTask["proposedAction"],
  outcome:
    | "contacted"
    | "replied"
    | "qualified"
    | "converted"
    | "won"
    | "lost"
    | "do_not_contact"
) {
  const contactActions = new Set<AcquisitionReviewTask["proposedAction"]>([
    "public_reply",
    "private_domain_invitation",
    "phone_call",
    "email",
    "meeting"
  ]);
  if (["contacted", "replied", "qualified", "do_not_contact"].includes(outcome)) {
    return contactActions.has(action);
  }
  if (outcome === "converted") {
    return action === "private_domain_invitation" || action === "convert";
  }
  return action === "convert";
}

const ISO_4217_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  CNY: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  MOP: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  CHF: 2,
  JPY: 0,
  KRW: 0,
  VND: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3
});

export function iso4217CurrencyExponent(currency: string) {
  return ISO_4217_EXPONENT[currency.toUpperCase()] ?? null;
}

export class ProductionAcquisitionAgentToolExecutor
implements AcquisitionAgentToolExecutor {
  private readonly domain: AcquisitionDomainService;
  private readonly growthToolPorts: GrowthCommercialToolPorts;
  private readonly growthCommercialTools?: GrowthAcquisitionToolDelegate;
  private readonly search: SearchPublicSourcesPort;
  private readonly searchConnections: AcquisitionSearchConnectionDirectoryPort;
  private readonly directory: AcquisitionCandidateDirectoryPort;
  private readonly priorityCandidates: AcquisitionPriorityCandidatePort;
  private readonly reviewTasks: AcquisitionReviewTaskPort;
  private readonly actionExecutions: AcquisitionActionExecutionPort;
  private readonly toolResults: AcquisitionToolResultLedgerPort;
  private readonly individualSignals: AcquisitionIndividualSignalIngestionPort;
  private readonly judgments?: AcquisitionJudgmentPort;
  private readonly performance?: Pick<AcquisitionPerformanceQueryService, "get">;
  private readonly now: () => string;
  private readonly maxEvidenceAgeDays: number;

  constructor(options: ProductionAcquisitionAgentToolExecutorOptions) {
    this.domain = options.domain;
    this.growthToolPorts = assertGrowthCommercialToolPorts(
      options.growthToolPorts
    );
    this.growthCommercialTools = options.growthCommercialTools;
    this.search = options.search;
    this.searchConnections = options.searchConnections;
    this.directory = options.candidateDirectory;
    this.priorityCandidates = options.priorityCandidates;
    this.reviewTasks = options.reviewTasks;
    this.actionExecutions = options.actionExecutions;
    this.toolResults = options.toolResults;
    this.individualSignals = options.individualSignals
      ?? new AcquisitionIndividualSignalIngestionService({
        domain: options.domain,
        candidateDirectory: options.candidateDirectory
      });
    this.judgments = options.judgments;
    this.performance = options.performance;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxEvidenceAgeDays = options.maxEvidenceAgeDays ?? 90;
    if (!Number.isInteger(this.maxEvidenceAgeDays)
      || this.maxEvidenceAgeDays < 1
      || this.maxEvidenceAgeDays > 3_650) {
      throw new TypeError("maxEvidenceAgeDays must be an integer from 1 to 3650");
    }
  }

  executeGrowthTool(
    call: GrowthCommercialToolCall,
    command: CommandContext
  ): Promise<unknown> {
    return this.growthToolPorts.execute(call, command);
  }

  async execute(input: AcquisitionToolExecutionInput): Promise<unknown> {
    try {
      this.validateIdentity(input);
      assertNotAborted(input.signal);
    } catch (error) {
      if (error instanceof AcquisitionToolExecutorError) throw error;
      if (isAbort(error) || input.signal?.aborted) throw abortError();
      throw toolError("TOOL_EXECUTION_FAILED");
    }
    if (this.growthCommercialTools?.owns(input.toolName)) {
      return this.growthCommercialTools.execute(input);
    }
    try {
      if (!TOOL_NAMES.has(input.toolName)) {
        throw toolError("UNKNOWN_TOOL");
      }
      const payload = this.parsePayload(input.toolName, input.payload);
      return await this.toolResults.executeOnce({
        ...input.identity,
        toolName: input.toolName,
        idempotencyKey: input.idempotencyKey,
        requestHash: `sha256:${hashJson({
          toolName: input.toolName,
          payload,
          resultProjection: input.resultProjection ?? "public"
        })}`
      }, () => this.dispatch(input, payload));
    } catch (error) {
      if (error instanceof AcquisitionToolExecutorError) throw error;
      if (error instanceof AcquisitionToolIdempotencyConflictError) {
        throw toolError("IDEMPOTENCY_CONFLICT");
      }
      if (isAbort(error) || input.signal?.aborted) throw abortError();
      if (error instanceof AcquisitionDomainError) {
        throw toolError(domainErrorCode(error));
      }
      throw toolError("TOOL_EXECUTION_FAILED");
    }
  }

  private async dispatch(
    input: AcquisitionToolExecutionInput,
    payload: unknown
  ): Promise<unknown> {
    switch (input.toolName) {
      case "search_public_sources":
        return this.searchPublicSources(input, payload as z.infer<
          typeof schemas.search_public_sources
        >);
      case "get_candidate_evidence":
        return this.getCandidateEvidence(input, payload as z.infer<
          typeof schemas.get_candidate_evidence
        >);
      case "research_candidate":
        return this.researchCandidate(input, payload as z.infer<
          typeof schemas.research_candidate
        >);
      case "qualify_candidate":
        return this.qualifyCandidate(input, payload as z.infer<
          typeof schemas.qualify_candidate
        >);
      case "build_battle_card":
        return this.buildBattleCard(input, payload as z.infer<
          typeof schemas.build_battle_card
        >);
      case "estimate_financial_value":
        return this.estimateFinancialValue(input, payload as z.infer<
          typeof schemas.estimate_financial_value
        >);
      case "draft_connection_strategy":
        return this.draftConnectionStrategy(
          input,
          payload as z.infer<typeof schemas.draft_connection_strategy>
        );
      case "list_priority_candidates":
        return this.listPriorityCandidates(
          input,
          payload as z.infer<typeof schemas.list_priority_candidates>
        );
      case "create_review_task":
        return this.createReviewTask(input, payload as z.infer<
          typeof schemas.create_review_task
        >);
      case "record_outcome":
        return this.recordOutcome(input, payload as z.infer<
          typeof schemas.record_outcome
        >);
      case "get_acquisition_performance":
        if (!this.performance) throw toolError("TOOL_EXECUTION_FAILED");
        return this.performance.get({
          ownerId: input.identity.ownerId,
          teamId: input.identity.teamId
        }, payload as z.infer<typeof schemas.get_acquisition_performance>);
      default:
        throw toolError("UNKNOWN_TOOL");
    }
  }

  private validateIdentity(input: AcquisitionToolExecutionInput) {
    const values: Array<[unknown, number]> = [
      [input.identity.ownerId, 100],
      [input.identity.teamId, 100],
      [input.identity.actorId, 100],
      [input.identity.sessionId, 200],
      [input.toolCallId, 500],
      [input.idempotencyKey, 120]
    ];
    if (values.some(([value, maximum]) =>
      typeof value !== "string" || !value.trim() || value.length > maximum
    )) {
      throw toolError("INVALID_IDENTITY");
    }
  }

  private parsePayload(toolName: string, payload: Record<string, unknown>) {
    const schema = schemas[toolName as keyof typeof schemas];
    if (!schema) throw toolError("UNKNOWN_TOOL");
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw toolError("INVALID_PAYLOAD");
    return parsed.data;
  }

  private scope(input: AcquisitionToolExecutionInput): AcquisitionActorScope {
    return {
      ownerId: input.identity.ownerId,
      teamId: input.identity.teamId,
      actorId: input.identity.actorId
    };
  }

  private async loadEligibleCandidate(
    input: AcquisitionToolExecutionInput,
    candidateId: string,
    operation:
      | "research"
      | "qualify"
      | "battle_card"
      | "financial_value"
      | "connection_strategy"
      | "review_task"
  ) {
    const scope = this.scope(input);
    const candidate = await this.domain.getCandidate(scope, candidateId);
    const allEvidence = await this.evidenceForCandidate(scope, candidate);
    const allowedStatuses: Record<typeof operation, Set<string>> = {
      research: new Set([
        "normalized",
        "qualified",
        "pending_review",
        "approved",
        "needs_research"
      ]),
      qualify: new Set([
        "normalized",
        "qualified",
        "pending_review",
        "approved"
      ]),
      battle_card: new Set(["pending_review", "approved"]),
      financial_value: new Set(["pending_review", "approved"]),
      connection_strategy: new Set(["pending_review", "approved"]),
      review_task: new Set(["approved"])
    };
    if (!allowedStatuses[operation].has(candidate.status)
      || allEvidence.length === 0) {
      throw toolError("ELIGIBILITY_BLOCKED");
    }
    const hardGates = deterministicHardGates(
      candidate,
      allEvidence,
      this.now(),
      this.maxEvidenceAgeDays
    );
    const failedGates = Object.entries(hardGates)
      .filter(([, passed]) => !passed)
      .map(([gate]) => gate as keyof QualificationHardGates);
    if (operation === "qualify"
      && failedGates.includes("identityResolved")) {
      throw toolError("IDENTITY_RESEARCH_REQUIRED");
    }
    const researchCanResolveIdentity = operation === "research"
      && failedGates.every((gate) => gate === "identityResolved");
    const requiresPassedGates = operation !== "qualify"
      && !researchCanResolveIdentity;
    if (requiresPassedGates && failedGates.length > 0) {
      throw toolError("ELIGIBILITY_BLOCKED");
    }
    if (["battle_card", "financial_value", "connection_strategy", "review_task"]
      .includes(operation)
      && !candidate.latestDecisionId) {
      throw toolError("ELIGIBILITY_BLOCKED");
    }
    if (operation === "review_task"
      && candidate.approvedDecisionVersion !== candidate.latestDecisionVersion) {
      throw toolError("ELIGIBILITY_BLOCKED");
    }
    const evidence = publicDecisionEvidence(allEvidence);
    return { scope, candidate, evidence, hardGates };
  }

  private async searchPublicSources(
    input: AcquisitionToolExecutionInput,
    payload: z.infer<typeof schemas.search_public_sources>
  ) {
    assertNotAborted(input.signal);
    const configuredConnectionIds = payload.providerConnectionIds
      ?? await this.searchConnections.listActiveConnectionIds({
        ownerId: input.identity.ownerId,
        teamId: input.identity.teamId
      });
    assertNotAborted(input.signal);
    const providerConnectionIds = [...new Set(
      configuredConnectionIds
        .filter((value): value is string =>
          typeof value === "string"
          && value.trim().length > 0
          && value.trim().length <= 255
        )
        .map((value) => value.trim())
    )].slice(0, 10);
    if (providerConnectionIds.length === 0) {
      throw toolError("SEARCH_PROVIDER_CONNECTION_REQUIRED");
    }
    const requests = providerConnectionIds.map(
      (providerConnectionId): SearchPublicSourcesRequest => ({
        ...input.identity,
        providerConnectionId,
        query: payload.query,
        subjectKinds: [...payload.subjectKinds],
        maxResults: payload.maxResults,
        signal: input.signal
      })
    );
    const settled = await Promise.allSettled(
      requests.map((request) => this.search.search(request))
    );
    assertNotAborted(input.signal);

    const successes: Array<z.infer<typeof searchResponseEnvelopeSchema>> = [];
    const providerFailures: Array<{
      providerConnectionId: string;
      provider: string;
      errorCode: "SEARCH_PROVIDER_FAILED" | "SEARCH_PROVIDER_INVALID_RESPONSE";
      retryAfterAt: string | null;
    }> = [];
    for (let index = 0; index < settled.length; index += 1) {
      const item = settled[index]!;
      const request = requests[index]!;
      if (item.status === "rejected") {
        if (isAbort(item.reason)) throw abortError();
        providerFailures.push({
          providerConnectionId: request.providerConnectionId,
          provider: "unknown",
          errorCode: "SEARCH_PROVIDER_FAILED",
          retryAfterAt: null
        });
        continue;
      }
      const parsed = searchResponseEnvelopeSchema.safeParse(item.value);
      if (!parsed.success
        || parsed.data.providerConnectionId !== request.providerConnectionId) {
        providerFailures.push({
          providerConnectionId: request.providerConnectionId,
          provider: "unknown",
          errorCode: "SEARCH_PROVIDER_INVALID_RESPONSE",
          retryAfterAt: null
        });
        continue;
      }
      successes.push(parsed.data);
    }
    if (successes.length === 0) {
      throw toolError("SEARCH_ALL_PROVIDERS_FAILED");
    }

    const scope = this.scope(input);
    const evidence: DiscoveryEvidence[] = [];
    const candidates = new Map<string, AcquisitionCandidate>();
    const identityResolutions = new Map<
      string,
      AcquisitionPublicIdentityDisposition
    >();
    const ingestFailures: Array<{
      providerConnectionId: string;
      resultIndex: number;
      errorCode:
        | "SEARCH_RESULT_INVALID"
        | "EVIDENCE_INGEST_FAILED"
        | "CANDIDATE_UPSERT_FAILED";
    }> = [];
    let rawResultCount = 0;
    let acceptedResultCount = 0;
    let duplicateResultCount = 0;
    const candidateIds = new Set<string>();
    for (const response of successes) {
      rawResultCount += response.results.length;
      for (let index = 0; index < response.results.length; index += 1) {
        if (acceptedResultCount >= payload.maxResults) break;
        assertNotAborted(input.signal);
        const parsedResult = searchResultSchema.safeParse(
          response.results[index]
        );
        if (!parsedResult.success) {
          ingestFailures.push({
            providerConnectionId: response.providerConnectionId,
            resultIndex: index,
            errorCode: "SEARCH_RESULT_INVALID"
          });
          continue;
        }
        const result = parsedResult.data;
        if (!payload.subjectKinds.includes(result.subject.kind)) continue;
        const identityResolution = resolveAcquisitionPublicIdentity({
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          provider: response.provider,
          sourceUrl: result.sourceUrl,
          sourceType: result.sourceType,
          subject: result.subject
        });
        const dedupeKey = identityResolution.dedupeKey;
        const rawEvidence = evidenceInput(
          response as SearchPublicSourcesResponse,
          result,
          payload.query,
          index + 1
        );
        let createdEvidence: DiscoveryEvidence;
        try {
          createdEvidence = await this.domain.appendEvidence(
            scope,
            rawEvidence,
            childIdempotencyKey(input.idempotencyKey, "evidence", {
              providerConnectionId: response.providerConnectionId,
              sourceUrl: result.sourceUrl,
              targetType: rawEvidence.targetType,
              dedupeKey
            })
          );
        } catch (error) {
          if (input.signal?.aborted || isAbort(error)) throw abortError();
          ingestFailures.push({
            providerConnectionId: response.providerConnectionId,
            resultIndex: index,
            errorCode: "EVIDENCE_INGEST_FAILED"
          });
          continue;
        }
        evidence.push(createdEvidence);
        acceptedResultCount += 1;

        let candidate: AcquisitionCandidate;
        let candidateCreated = false;
        let candidateIdentityResolution = identityResolution;
        try {
          if (result.subject.kind === "individual") {
            const ingested = await this.individualSignals.ingest({
              scope,
              provider: response.provider,
              sourceUrl: result.sourceUrl,
              sourceType: result.sourceType,
              subject: {
                publicActorKey: result.subject.publicActorKey,
                publicDisplayName: result.subject.publicDisplayName,
                publicProfileUrl: result.subject.publicProfileUrl,
                sourcePlatform: result.subject.sourcePlatform,
                demandCategory: result.subject.demandCategory,
                demandSummary: result.subject.demandSummary,
                locationHint: normalizeAcquisitionRegion(
                  result.subject.locationHint
                ) ?? "",
                buyingStage: result.subject.buyingStage,
                negativeSignals: [...result.subject.negativeSignals]
              },
              evidence: createdEvidence,
              idempotencyKey: input.idempotencyKey
            });
            candidate = ingested.candidate;
            candidateCreated = ingested.created;
            candidateIdentityResolution = ingested.identityResolution;
          } else {
            const organizationSubject = result.subject;
            const stable = hash(dedupeKey).slice(0, 24);
            const upsert = await this.directory.upsertCandidate({
              ownerId: scope.ownerId,
              teamId: scope.teamId,
              dedupeKey,
              partyType: "organization",
              idempotencyKey: childIdempotencyKey(
                input.idempotencyKey,
                "candidate-upsert",
                { dedupeKey }
              ),
              createCandidate: async () =>
                this.domain.createOrganizationCandidate(
                  scope,
                  {
                    name: organizationSubject.name,
                    domain: identityResolution.normalizedDomain,
                    region: normalizeAcquisitionRegion(
                      organizationSubject.region
                    ),
                    creditCode: identityResolution.normalizedCreditCode,
                    organizationId: identityResolution.partyId,
                    tenantProspectId: `prospect-${stable}`,
                    evidenceIds: [createdEvidence.id]
                  },
                  childIdempotencyKey(input.idempotencyKey, "candidate", {
                    dedupeKey,
                    partyType: "organization"
                  })
                )
            });
            candidateCreated = upsert.created;
            candidate = await this.domain.getCandidate(
              scope,
              upsert.entry.candidateId
            );
            if (!upsert.created) {
              candidate = await this.domain.attachEvidenceToCandidate(
                scope,
                candidate.id,
                createdEvidence.id,
                childIdempotencyKey(
                  input.idempotencyKey,
                  "attach-evidence",
                  {
                    candidateId: candidate.id,
                    evidenceId: createdEvidence.id
                  }
                )
              );
            }
          }
          if (!candidateCreated) duplicateResultCount += 1;
        } catch (error) {
          if (input.signal?.aborted || isAbort(error)) throw abortError();
          ingestFailures.push({
            providerConnectionId: response.providerConnectionId,
            resultIndex: index,
            errorCode: "CANDIDATE_UPSERT_FAILED"
          });
          continue;
        }
        candidates.set(candidate.id, candidate);
        candidateIds.add(candidate.id);
        identityResolutions.set(
          candidate.id,
          acquisitionPublicIdentityDisposition(candidateIdentityResolution)
        );
      }
      if (acceptedResultCount >= payload.maxResults) break;
    }
    return {
      status: providerFailures.length > 0 || ingestFailures.length > 0
        ? "partial"
        : "succeeded",
      query: payload.query,
      providers: successes.map((item) => ({
        providerConnectionId: item.providerConnectionId,
        provider: item.provider,
        requestId: item.requestId,
        status: "succeeded"
      })),
      providerFailures,
      ingestFailures,
      evidence: evidence.map((item) =>
        input.resultProjection === "internal_run"
          ? structuredClone(item)
          : projectEvidence(item)
      ),
      candidates: [...candidates.values()].map((candidate) =>
        projectCandidate(candidate, identityResolutions.get(candidate.id))
      ),
      rawResultCount,
      acceptedResultCount,
      duplicateResultCount,
      failedResultCount: ingestFailures.length,
      candidateIds: [...candidateIds].sort(),
      outreachExecuted: false
    };
  }

  private async evidenceForCandidate(
    scope: AcquisitionActorScope,
    candidate: AcquisitionCandidate
  ) {
    return Promise.all(
      candidate.evidenceIds.map((id) => this.domain.getEvidence(scope, id))
    );
  }

  private async getCandidateEvidence(
    input: AcquisitionToolExecutionInput,
    payload: z.infer<typeof schemas.get_candidate_evidence>
  ) {
    const scope = this.scope(input);
    const candidate = await this.domain.getCandidate(scope, payload.candidateId);
    const evidence = await this.evidenceForCandidate(scope, candidate);
    return {
      candidate: projectCandidate(
        candidate,
        candidateIdentityDisposition(candidate)
      ),
      evidence: evidence.map(projectEvidence),
      evidenceCount: evidence.length,
      outreachExecuted: false
    };
  }

  private async researchCandidate(
    input: AcquisitionToolExecutionInput,
    payload: z.infer<typeof schemas.research_candidate>
  ) {
    const {
      scope,
      candidate,
      evidence,
      hardGates
    } = await this.loadEligibleCandidate(
      input,
      payload.candidateId,
      "research"
    );
    const rawResult = this.judgments?.research
      ? await this.judgments.research({
          scope,
          sessionId: input.identity.sessionId,
          candidate,
          evidence,
          depth: payload.depth,
          researchQuestions: payload.researchQuestions ?? [],
          signal: input.signal
        })
      : {
          summary: "未配置研究判断端口，仅整理现有公开证据，不生成未经证实的事实。",
          findings: evidence.map((item) => ({
            label: item.sourceTitle || "公开来源",
            content: item.sourceSnippet,
            evidenceIds: [item.id],
            confidence: 1
          }))
        };
    assertNotAborted(input.signal);
    const parsed = researchJudgmentSchema.safeParse(rawResult);
    if (!parsed.success) throw toolError("INVALID_JUDGMENT_RESULT");
    const allowedEvidenceIds = new Set(evidence.map((item) => item.id));
    if (parsed.data.findings.some((finding) =>
      finding.evidenceIds.some((id) => !allowedEvidenceIds.has(id))
    )) {
      throw toolError("INVALID_JUDGMENT_RESULT");
    }
    return {
      candidateId: candidate.id,
      depth: payload.depth,
      mode: this.judgments?.research ? "judgment_port" : "conservative_rules",
      summary: parsed.data.summary,
      findings: parsed.data.findings,
      newEvidence: [],
      newEvidenceCount: 0,
      formalEvidenceCreationAllowed: false,
      requiresIdentityResearch: !hardGates.identityResolved,
      requiresHumanVerification: true,
      outreachExecuted: false
    };
  }

  private async qualifyCandidate(
    input: AcquisitionToolExecutionInput,
    payload: z.infer<typeof schemas.qualify_candidate>
  ) {
    const {
      scope,
      candidate,
      evidence,
      hardGates
    } = await this.loadEligibleCandidate(
      input,
      payload.candidateId,
      "qualify"
    );
    const rawDecision = this.judgments?.qualify
      ? await this.judgments.qualify({
          scope,
          sessionId: input.identity.sessionId,
          candidate,
          evidence,
          policyVersion: payload.policyVersion,
          signal: input.signal
        })
      : {
          qualification: conservativeQualification(
            candidate,
            evidence,
            payload.policyVersion,
            hardGates
          ),
          financial: defaultFinancial()
        };
    assertNotAborted(input.signal);
    const decision = {
      qualification: {
        ...rawDecision.qualification,
        ruleVersion: payload.policyVersion,
        hardGates,
        reasons: [
          ...rawDecision.qualification.reasons,
          "确定性硬门禁由系统基于当前候选与正式证据重算，模型输入不能覆盖。"
        ]
      },
      financial: rawDecision.financial
    };
    const result = await this.domain.qualifyCandidate(
      scope,
      candidate.id,
      decision.qualification,
      decision.financial,
      input.idempotencyKey
    );
    return {
      candidate: projectCandidate(result.candidate),
      qualification: publicRecord(
        result.qualification as unknown as Record<string, unknown>
      ),
      financialValue: publicRecord(
        result.financialValue as unknown as Record<string, unknown>
      ),
      mode: this.judgments?.qualify ? "judgment_port" : "conservative_rules",
      outreachExecuted: false
    };
  }

  private async buildBattleCard(
    input: AcquisitionToolExecutionInput,
    payload: z.infer<typeof schemas.build_battle_card>
  ) {
    const {
      scope,
      candidate,
      evidence
    } = await this.loadEligibleCandidate(
      input,
      payload.candidateId,
      "battle_card"
    );
    const templateVersion = payload.templateVersion ?? "battle-card.v1";
    const financialSummary = persistedFinancialSummary(
      await this.domain.getCurrentFinancialValueDecision(
        scope,
        candidate.id
      )
    );
    const cardInput = this.judgments?.buildBattleCard
      ? await this.judgments.buildBattleCard({
          scope,
          sessionId: input.identity.sessionId,
          candidate,
          evidence,
          templateVersion,
          financialSummary,
          signal: input.signal
        })
      : defaultBattleCard(evidence, templateVersion);
    assertNotAborted(input.signal);
    const card = await this.domain.createBattleCard(
      scope,
      candidate.id,
      cardInput,
      input.idempotencyKey
    );
    return {
      battleCard: publicRecord(card as unknown as Record<string, unknown>),
      mode: this.judgments?.buildBattleCard
        ? "judgment_port"
        : "conservative_rules",
      requiresHumanVerification: true,
      outreachExecuted: false
    };
  }

  private async estimateFinancialValue(
    input: AcquisitionToolExecutionInput,
    payload: z.infer<typeof schemas.estimate_financial_value>
  ) {
    const { scope } = await this.loadEligibleCandidate(
      input,
      payload.candidateId,
      "financial_value"
    );
    const values = await this.domain.listFinancialValueDecisions(
      scope,
      payload.candidateId
    );
    const financialValue = values.at(-1);
    if (!financialValue) {
      return {
        candidateId: payload.candidateId,
        persisted: false,
        status: "insufficient_data",
        currency: payload.currency,
        policyVersion: payload.policyVersion ?? "financial-rules.v1",
        conservativeAssumption: defaultFinancial(payload.currency),
        reasons: [
          "尚无与资格决定绑定的财务价值记录，不能凭空估算客单价、毛利或回款。"
        ],
        outreachExecuted: false
      };
    }
    return {
      candidateId: payload.candidateId,
      persisted: true,
      status: "available",
      requestedCurrency: payload.currency,
      currencyMismatch: financialValue.currency !== payload.currency,
      financialValue: publicRecord(
        financialValue as unknown as Record<string, unknown>
      ),
      outreachExecuted: false
    };
  }

  private async draftConnectionStrategy(
    input: AcquisitionToolExecutionInput,
    payload: z.infer<typeof schemas.draft_connection_strategy>
  ) {
    const {
      scope,
      candidate,
      evidence
    } = await this.loadEligibleCandidate(
      input,
      payload.candidateId,
      "connection_strategy"
    );
    const rawDrafts = this.judgments?.draftConnectionStrategy
      ? await this.judgments.draftConnectionStrategy({
          scope,
          sessionId: input.identity.sessionId,
          candidate,
          evidence,
          targetRole: payload.targetRole,
          channels: payload.channels,
          signal: input.signal
        })
      : defaultConnectionDrafts(payload.channels, payload.targetRole);
    assertNotAborted(input.signal);
    const parsedDrafts = z.array(connectionDraftSchema)
      .min(1).max(6).safeParse(rawDrafts);
    if (!parsedDrafts.success
      || parsedDrafts.data.length !== payload.channels.length
      || new Set(parsedDrafts.data.map((item) => item.channel)).size
        !== parsedDrafts.data.length
      || parsedDrafts.data.some((item) =>
        !payload.channels.includes(item.channel)
      )) {
      throw toolError("INVALID_JUDGMENT_RESULT");
    }
    return {
      candidateId: candidate.id,
      targetRole: payload.targetRole,
      drafts: parsedDrafts.data,
      evidenceIds: evidence.map((item) => item.id),
      mode: this.judgments?.draftConnectionStrategy
        ? "judgment_port"
        : "conservative_rules",
      requiresHumanReview: true,
      outreachExecuted: false
    };
  }

  private async listPriorityCandidates(
    input: AcquisitionToolExecutionInput,
    payload: z.infer<typeof schemas.list_priority_candidates>
  ) {
    const scope = this.scope(input);
    const rowsFromStorage = await this.priorityCandidates.listPriorityCandidates({
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      subjectKinds: payload.subjectKinds,
      minimumGrade: payload.minimumGrade,
      limit: payload.limit,
      sort: "qualification_and_financial_desc"
    });
    const rows: Array<{
      candidate: AcquisitionCandidate;
      qualification: Awaited<
        ReturnType<AcquisitionDomainService["listQualificationDecisions"]>
      >[number] | null;
      financialValue: Awaited<
        ReturnType<AcquisitionDomainService["listFinancialValueDecisions"]>
      >[number] | null;
    }> = [];
    const seen = new Set<string>();
    for (const stored of rowsFromStorage) {
      assertNotAborted(input.signal);
      if (seen.has(stored.candidateId)) continue;
      try {
        const candidate = await this.domain.getCandidate(
          scope,
          stored.candidateId
        );
        if (payload.subjectKinds
          && !payload.subjectKinds.includes(candidate.partyType)) {
          continue;
        }
        const qualifications = await this.domain.listQualificationDecisions(
          scope,
          candidate.id
        );
        const values = await this.domain.listFinancialValueDecisions(
          scope,
          candidate.id
        );
        const qualification = qualifications.at(-1) ?? null;
        if ((qualification?.grade ?? null) !== stored.qualificationGrade
          || (qualification?.score ?? null) !== stored.qualificationScore
          || (values.at(-1)?.score ?? null) !== stored.financialScore) {
          continue;
        }
        if (payload.minimumGrade
          && (!qualification
            || GRADE_RANK[qualification.grade]
              > GRADE_RANK[payload.minimumGrade])) {
          continue;
        }
        rows.push({
          candidate,
          qualification,
          financialValue: values.at(-1) ?? null
        });
        seen.add(candidate.id);
      } catch (error) {
        if (error instanceof AcquisitionDomainError
          && error.code === "resource_not_found") {
          continue;
        }
        throw error;
      }
    }
    return {
      candidates: rows.map((row) => ({
        candidate: projectCandidate(row.candidate),
        qualification: row.qualification
          ? publicRecord(
              row.qualification as unknown as Record<string, unknown>
            )
          : null,
        financialValue: row.financialValue
          ? publicRecord(
              row.financialValue as unknown as Record<string, unknown>
            )
          : null
      })),
      requestedLimit: payload.limit,
      outreachExecuted: false
    };
  }

  private async createReviewTask(
    input: AcquisitionToolExecutionInput,
    payload: z.infer<typeof schemas.create_review_task>
  ) {
    const {
      scope,
      candidate
    } = await this.loadEligibleCandidate(
      input,
      payload.candidateId,
      "review_task"
    );
    const reviewTask = await this.reviewTasks.create({
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      actorId: scope.actorId,
      sessionId: input.identity.sessionId,
      candidateId: candidate.id,
      proposedAction: payload.proposedAction,
      rationale: payload.rationale,
      idempotencyKey: input.idempotencyKey
    });
    if (reviewTask.ownerId !== scope.ownerId
      || reviewTask.teamId !== scope.teamId
      || reviewTask.candidateId !== candidate.id
      || reviewTask.proposedAction !== payload.proposedAction
      || reviewTask.idempotencyKey !== input.idempotencyKey
      || reviewTask.status !== "pending") {
      throw toolError("TOOL_EXECUTION_FAILED");
    }
    return {
      reviewTask: publicRecord(
        reviewTask as unknown as Record<string, unknown>
      ),
      requiresHumanReview: true,
      outreachExecuted: false
    };
  }

  private async recordOutcome(
    _input: AcquisitionToolExecutionInput,
    _payload: z.infer<typeof schemas.record_outcome>
  ) {
    throw toolError("LEGACY_OUTCOME_TOOL_READ_ONLY");
  }
}
