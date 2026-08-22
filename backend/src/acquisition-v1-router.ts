import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response
} from "express";
import { z, ZodError, type ZodType } from "zod";
import {
  acquisitionCandidateIdentityResolved,
  type AcquisitionAuditEvent,
  type AcquisitionCandidate,
  type BattleCard,
  type CandidateStatus,
  type DiscoveryEvidence,
  type FinancialValueDecision,
  type LeadConversionRecord,
  type OutcomeFeedbackEvent,
  type QualificationDecision,
  type ResearchAttempt,
  type ReviewEvent
} from "./acquisition-domain.js";
import {
  normalizeOutcomeFeedbackEvent
} from "./acquisition-outcome-compatibility.js";
import {
  AcquisitionDomainError,
  type AcquisitionActorScope,
  type AcquisitionDomainService
} from "./acquisition-domain-service.js";
import {
  AcquisitionPrivateDomainHandoffError,
  type AcquisitionPrivateDomainHandoffService
} from "./acquisition-private-domain-handoff.js";
import {
  AcquisitionCopilotError,
  type AcquisitionCopilotMessage,
  type AcquisitionCopilotScope,
  type AcquisitionCopilotService,
  type AcquisitionCopilotSession,
  type AcquisitionCopilotTask
} from "./acquisition-copilot-service.js";
import type {
  AcquisitionPiModelSnapshot
} from "./acquisition-pi-agent.js";
import type {
  AcquisitionIdentityResolutionService
} from "./acquisition-identity-resolution-service.js";
import {
  isVerifiedAcquisitionPublicProfileUrl
} from "./acquisition-public-identity-resolver.js";
import { classifyDouyinPublicSource } from "./acquisition-douyin-public-source.js";
import { MODEL_PROVIDER_IDS } from "./model-providers/types.js";

const candidateStatuses = [
  "discovered",
  "unresolvable",
  "normalized",
  "qualified",
  "pending_review",
  "approved",
  "rejected",
  "do_not_contact",
  "needs_research",
  "converted_to_lead"
] as const satisfies readonly CandidateStatus[];

const CURSOR_VERSION = 1;
const DEVELOPMENT_CURSOR_SECRET = randomBytes(48).toString("base64url");

const idSchema = z.string().trim().min(1).max(255);
const idempotencyKeySchema = z.string().trim().min(1).max(200);
const nullableText = (max: number) => z.string().trim().max(max).nullable();
const requiredText = (max: number) => z.string().trim().min(1).max(max);
const httpsUrl = z.string().url().max(2_000).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}, "URL must use HTTPS without credentials");

const provenanceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("search_result"),
    provider: requiredText(100),
    providerConnectionId: requiredText(255).optional(),
    requestId: requiredText(500).optional(),
    providerRecordId: requiredText(255).optional(),
    queryText: requiredText(1_000),
    sourceUrl: z.string().url().max(2_000),
    resultRank: z.number().int().min(1).nullable(),
    sourceType: requiredText(100).optional()
  }).strict(),
  z.object({
    kind: z.literal("user_submitted_url"),
    sourceUrl: z.string().url().max(2_000),
    submittedBy: requiredText(100)
  }).strict(),
  z.object({
    kind: z.literal("controlled_public_page"),
    sourceUrl: httpsUrl.refine(
      (value) => isVerifiedAcquisitionPublicProfileUrl(value)
        && classifyDouyinPublicSource(value)?.sourceType === "profile",
      "sourceUrl must be a supported public profile URL"
    ),
    discoveredFromEvidenceId: idSchema,
    redirectChain: z.array(httpsUrl).min(1).max(4),
    extractorVersion: z.literal("douyin-public-profile-v1")
  }).strict(),
  z.object({
    kind: z.literal("import_artifact_row"),
    importBatchId: requiredText(100),
    artifactHash: requiredText(200),
    sheetName: requiredText(200),
    rowNumber: z.number().int().min(1)
  }).strict()
]);

const evidenceInputSchema = z.object({
  targetType: z.enum(["organization", "individual_signal"]),
  sourcePlatform: requiredText(100),
  sourceTitle: z.string().trim().max(500),
  sourceSnippet: z.string().trim().max(4_000),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  locale: requiredText(30),
  rawArtifactHash: requiredText(200),
  contentHash: requiredText(200),
  provenance: provenanceSchema,
  accessStatus: z.enum([
    "indexed_summary",
    "public_content",
    "user_supplied",
    "access_restricted"
  ]),
  supersedesEvidenceId: idSchema.nullable().optional()
}).strict();

const organizationCandidateInputSchema = z.object({
  subjectKind: z.literal("organization"),
  name: requiredText(200),
  domain: nullableText(255),
  region: nullableText(120),
  creditCode: nullableText(50),
  organizationId: idSchema,
  tenantProspectId: idSchema,
  evidenceIds: z.array(idSchema).min(1).max(500)
}).strict();

const individualCandidateInputSchema = z.object({
  subjectKind: z.literal("individual"),
  publicActorKey: requiredText(300),
  publicDisplayName: requiredText(200),
  publicProfileUrl: z.string().url().max(2_000),
  sourcePlatform: requiredText(100),
  demandSignalId: idSchema,
  demandCategory: requiredText(100),
  demandSummary: requiredText(2_000),
  locationHint: z.string().trim().max(200),
  buyingStage: z.enum([
    "awareness",
    "problem_defined",
    "solution_research",
    "comparison",
    "purchase_ready"
  ]),
  negativeSignals: z.array(requiredText(500)).max(100),
  individualPartyId: idSchema,
  evidenceIds: z.array(idSchema).min(1).max(500)
}).strict();

const candidateInputSchema = z.discriminatedUnion("subjectKind", [
  organizationCandidateInputSchema,
  individualCandidateInputSchema
]);

const qualificationInputSchema = z.object({
  decisionEngine: z.enum(["model", "rules"]),
  ruleVersion: requiredText(100),
  promptVersion: nullableText(100),
  modelProvider: nullableText(100),
  model: nullableText(200),
  dimensions: z.object({
    demandStrength: z.number().finite(),
    fit: z.number().finite(),
    identityConfidence: z.number().finite(),
    buyingStage: z.number().finite(),
    budgetPotential: z.number().finite(),
    decisionReachability: z.number().finite(),
    freshness: z.number().finite(),
    evidenceDiversity: z.number().finite(),
    negativeSignalRisk: z.number().finite(),
    contactRisk: z.number().finite()
  }).strict(),
  hardGates: z.object({
    hasOriginalSource: z.boolean(),
    identityResolved: z.boolean(),
    notDoNotContact: z.boolean(),
    noExplicitRejection: z.boolean(),
    publicDataOnly: z.boolean(),
    evidenceFresh: z.boolean(),
    schemaValid: z.boolean()
  }).strict(),
  evidenceExcerpts: z.record(idSchema, z.string().trim().max(4_000)),
  reasons: z.array(requiredText(2_000)).min(1).max(100)
}).strict();

const financialValueInputSchema = z.object({
  currency: z.string().trim().length(3),
  predictedDealAmountMinor: z.number().int().nonnegative(),
  grossMarginBps: z.number().int().min(0).max(10_000),
  closeProbabilityBps: z.number().int().min(0).max(10_000),
  acquisitionCostMinor: z.number().int().nonnegative(),
  salesCostMinor: z.number().int().nonnegative(),
  serviceCostMinor: z.number().int().nonnegative(),
  benchmarkDealAmountMinor: z.number().int().positive(),
  collectionDays: z.number().int().nonnegative(),
  creditRisk: z.number().finite().min(0).max(100),
  repeatPotential: z.number().finite().min(0).max(100),
  referralPotential: z.number().finite().min(0).max(100)
}).strict();

const qualifyBodySchema = z.object({
  qualification: qualificationInputSchema,
  financial: financialValueInputSchema
}).strict();

const battleCardClaimBodySchema = z.object({
  kind: z.enum(["fact", "inference", "unknown"]),
  text: requiredText(4_000),
  evidenceIds: z.array(idSchema).max(500),
  confidence: z.number().min(0).max(1).nullable()
}).strict();

const battleCardCommonBodyShape = {
  confidence: z.number().min(0).max(1),
  modelProvider: requiredText(100),
  model: requiredText(200),
  promptVersion: requiredText(100)
};

const battleCardBodySchema = z.union([z.object({
  schemaVersion: z.literal("battle-card.v1").optional(),
  sections: z.array(z.object({
    label: requiredText(120),
    kind: z.enum(["fact", "inference", "unknown"]),
    content: requiredText(4_000),
    evidenceIds: z.array(idSchema).max(500),
    confidence: z.number().min(0).max(1).nullable()
  }).strict()).min(1).max(100),
  ...battleCardCommonBodyShape
}).strict(), z.object({
  schemaVersion: z.literal("battle-card.v2"),
  intelligence: z.object({
    accountOverview: z.array(battleCardClaimBodySchema).max(100),
    needAssessment: z.array(battleCardClaimBodySchema).max(100),
    supplierHypotheses: z.array(battleCardClaimBodySchema).max(100),
    buyingCommittee: z.array(z.object({
      role: requiredText(200),
      priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      influence: z.enum([
        "decision_maker",
        "influencer",
        "user",
        "gatekeeper"
      ]),
      concerns: z.array(requiredText(500)).max(100),
      claim: battleCardClaimBodySchema
    }).strict()).max(100),
    procurementPreferences: z.array(battleCardClaimBodySchema).max(100),
    connectionStrategies: z.array(z.object({
      channel: z.enum([
        "public_reply",
        "wecom",
        "phone",
        "email",
        "referral"
      ]),
      targetRole: requiredText(200),
      rationale: battleCardClaimBodySchema,
      openingDraft: requiredText(8_000)
    }).strict()).max(100),
    roleSpecificOpeners: z.array(z.object({
      role: requiredText(200),
      channel: z.enum([
        "public_reply",
        "wecom",
        "phone",
        "email",
        "referral"
      ]),
      text: requiredText(8_000)
    }).strict()).max(100),
    doNotActions: z.array(requiredText(1_000)).max(100)
  }).strict(),
  ...battleCardCommonBodyShape
}).strict()]);

const reviewBodySchema = z.object({
  action: z.enum([
    "approved",
    "rejected",
    "do_not_contact",
    "needs_research",
    "reopen"
  ]),
  decisionVersion: requiredText(100),
  reason: nullableText(2_000)
}).strict();

const researchBodySchema = z.object({
  researchId: idSchema
}).strict();

const attachEvidenceBodySchema = z.object({
  evidenceId: idSchema
}).strict();

const identityConfirmationBodySchema = z.discriminatedUnion("subjectKind", [
  z.object({
    subjectKind: z.literal("organization"),
    domain: nullableText(255),
    creditCode: nullableText(50),
    evidenceIds: z.array(idSchema).min(1).max(100),
    rationale: requiredText(2_000)
  }).strict(),
  z.object({
    subjectKind: z.literal("individual"),
    publicProfileUrl: z.string().url().max(2_000),
    sourcePlatform: requiredText(100),
    evidenceIds: z.array(idSchema).min(1).max(100),
    rationale: requiredText(2_000)
  }).strict()
]);

const convertBodySchema = z.object({
  decisionVersion: requiredText(100)
}).strict();

const privateDomainHandoffBodySchema = z.object({
  operationCode: z.literal("handoff_acquisition_candidate_v1"),
  runId: idSchema,
  discoveredEventId: idSchema,
  decisionVersion: requiredText(100),
  mode: z.enum(["create_new", "link_existing"]),
  existingCustomerId: z.string().trim().max(255),
  followUp: z.object({
    title: requiredText(500),
    dueAt: z.string().datetime({ offset: true }),
    priority: z.enum(["high", "medium", "normal"])
  }).strict()
}).strict().superRefine((value, context) => {
  if (value.mode === "link_existing" && !value.existingCustomerId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["existingCustomerId"],
      message: "link_existing 必须提供 existingCustomerId"
    });
  }
  if (value.mode === "create_new" && value.existingCustomerId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["existingCustomerId"],
      message: "create_new 不接受 existingCustomerId"
    });
  }
});

const outcomeBodySchema = z.object({
  leadId: idSchema.nullable(),
  customerId: idSchema.nullable(),
  eventType: z.enum([
    "validated",
    "contacted",
    "replied",
    "rejected",
    "do_not_contact",
    "private_domain_entered",
    "need_confirmed",
    "payment_received"
  ]),
  occurredAt: z.string().datetime({ offset: true }),
  amount: z.object({
    amountMinor: z.number().int(),
    currency: z.string().trim().length(3)
  }).strict().nullable(),
  reasonCode: nullableText(100),
  reasonText: nullableText(2_000),
  candidateId: idSchema,
  attribution: z.object({
    attributionVersion: z.literal("acquisition-run.v1"),
    runId: requiredText(255),
    planId: requiredText(255),
    planVersionId: requiredText(255),
    planVersion: z.number().int().min(1),
    planSnapshotHash: requiredText(255),
    discoveredEventId: requiredText(255),
    discoveredAt: z.string().datetime({ offset: true }),
    shardId: requiredText(255),
    operationId: requiredText(255),
    connectionId: requiredText(255),
    providerId: requiredText(255),
    evidenceIds: z.array(idSchema).max(500),
    providerIds: z.array(idSchema).max(100),
    queryIds: z.array(idSchema).max(500),
    strategyVersion: requiredText(100),
    qualificationDecisionId: idSchema,
    decisionVersion: requiredText(100),
    decisionSnapshotHash: requiredText(200)
  }).strict()
}).strict();

const modelSnapshotSchema = z.object({
  jobId: idSchema,
  connectionId: idSchema,
  credentialVersion: z.number().int().min(1),
  provider: z.enum(MODEL_PROVIDER_IDS),
  model: requiredText(200),
  promptVersion: requiredText(100),
  schemaVersion: requiredText(100),
  promptHash: z.string().trim().max(200).regex(/^sha256:.+$/),
  schemaHash: z.string().trim().max(200).regex(/^sha256:.+$/),
  capabilitySnapshotHash: requiredText(200),
  baseUrlFingerprint: requiredText(200)
}).strict();

const createCopilotSessionBodySchema = z.object({
  modelSnapshot: modelSnapshotSchema
}).strict();

const createBoundCopilotSessionBodySchema = z.object({
  connectionId: idSchema.nullable().optional()
}).strict();

const copilotMessageBodySchema = z.object({
  message: requiredText(20_000),
  responseMode: z.enum(["assistant", "plan_draft"]).default("assistant"),
  targetPlatform: z.enum(["douyin", "web"]).default("web")
}).strict();

const paginationQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(8_192).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).passthrough();

const cursorPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  endpoint: z.string().min(1).max(500),
  filterFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: z.string().min(1).max(1_000),
  position: z.string().min(1).max(2_048)
}).strict();

const candidateListQuerySchema = paginationQuerySchema.extend({
  subjectKind: z.enum(["organization", "individual"]).optional(),
  status: z.enum(candidateStatuses).optional()
}).strict();

const candidateScopedListQuerySchema = paginationQuerySchema.extend({
  candidateId: idSchema
}).strict();

const auditListQuerySchema = paginationQuerySchema.extend({
  candidateId: idSchema.optional()
}).strict();

export interface AcquisitionV1Page<T> {
  items: T[];
  nextCursor: string | null;
  snapshot: string;
}

export interface AcquisitionV1CandidateListQuery {
  cursor?: string;
  snapshot?: string;
  limit: number;
  subjectKind?: "organization" | "individual";
  status?: CandidateStatus;
}

export interface AcquisitionV1QueryPort {
  listCandidates(
    scope: Pick<AcquisitionActorScope, "ownerId" | "teamId">,
    query: AcquisitionV1CandidateListQuery
  ): Promise<AcquisitionV1Page<AcquisitionCandidate>>;
}

export interface AcquisitionV1RouterOptions {
  domainService: AcquisitionDomainService;
  identityResolutionService: AcquisitionIdentityResolutionService;
  copilotService: AcquisitionCopilotService;
  queryPort: AcquisitionV1QueryPort;
  requestIdFactory?: (prefix: string) => string;
  cursorSecret?: string;
  dispatchCopilotTask?: (
    scope: AcquisitionCopilotScope,
    taskId: string
  ) => void | Promise<void>;
  /**
   * Production callers should provide this resolver. When configured, the
   * public API accepts only an optional connectionId and the server binds all
   * immutable model/content identities. This prevents clients from inventing
   * credential versions, capability snapshots, or prompt/tool hashes.
   */
  resolveCopilotModelSnapshot?: (
    scope: AcquisitionCopilotScope,
    input: { connectionId: string | null }
  ) => Promise<AcquisitionPiModelSnapshot>;
  /**
   * Compatibility escape hatch for trusted, non-public import tooling only.
   * Production HTTP applications must leave this disabled so clients cannot
   * invent evidence, model decisions, battle cards, or revenue outcomes.
   */
  allowDirectDomainWrites?: boolean;
  privateDomainHandoffService?: Pick<
    AcquisitionPrivateDomainHandoffService,
    "create" | "get"
  >;
}

class AcquisitionV1HttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: unknown = null,
    readonly retryable = false
  ) {
    super(message);
    this.name = "AcquisitionV1HttpError";
  }
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function scopeFromRequest(req: Request): AcquisitionActorScope {
  const user = (req as Request & {
    user?: { id?: string; teamId?: string };
  }).user;
  if (!user?.id || !user.teamId) {
    throw new AcquisitionV1HttpError(
      "unauthorized",
      "需要登录后访问",
      401
    );
  }
  return {
    ownerId: user.id,
    teamId: user.teamId,
    actorId: user.id
  };
}

function idempotencyKey(req: Request) {
  const raw = req.header("Idempotency-Key");
  if (!raw) {
    throw new AcquisitionV1HttpError(
      "idempotency_key_required",
      "写操作必须提供 Idempotency-Key",
      400
    );
  }
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) {
    throw new AcquisitionV1HttpError(
      "invalid_idempotency_key",
      "Idempotency-Key 必须为 1 至 200 个字符",
      400
    );
  }
  return parsed.data;
}

function handoffIdempotencyKey(req: Request) {
  const value = idempotencyKey(req);
  if (value.length < 8) {
    throw new AcquisitionV1HttpError(
      "invalid_idempotency_key",
      "Idempotency-Key 必须为 8 至 200 个字符",
      400
    );
  }
  return value;
}

function expectedCandidateVersion(req: Request) {
  const raw = req.header("If-Match")?.trim() ?? "";
  const match = /^"candidate-v([1-9]\d*)"$/u.exec(raw);
  if (!match) {
    throw new AcquisitionV1HttpError(
      "candidate_version_required",
      '身份确认必须提供 If-Match: "candidate-v{version}"',
      428
    );
  }
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version)) {
    throw new AcquisitionV1HttpError(
      "invalid_candidate_version",
      "候选版本无效",
      400
    );
  }
  return version;
}

function setCandidateEtag(
  res: Response,
  candidate: Pick<AcquisitionCandidate, "version">
) {
  res.setHeader("ETag", `"candidate-v${candidate.version}"`);
}

function requestId(res: Response) {
  return String(res.locals.acquisitionRequestId);
}

function sendError(error: unknown, res: Response) {
  let code = "internal_error";
  let message = "服务暂时不可用";
  let details: unknown = null;
  let status = 500;
  let retryable = false;

  if (error instanceof ZodError) {
    code = "invalid_request";
    message = "请求参数不符合接口契约";
    status = 400;
    details = {
      issues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.join("."),
        message: issue.message
      }))
    };
  } else if (error instanceof AcquisitionV1HttpError) {
    ({ code, message, details, status, retryable } = error);
  } else if (
    error instanceof AcquisitionDomainError
    || error instanceof AcquisitionCopilotError
  ) {
    code = error.code;
    message = error.message;
    status = error.status;
    retryable = error.status === 429 || error.status >= 500;
  } else if (error instanceof AcquisitionPrivateDomainHandoffError) {
    code = error.code;
    message = error.message;
    status = error.status;
    retryable = error.status >= 500;
  }

  res.status(status).json({
    code,
    message,
    details,
    requestId: requestId(res),
    retryable
  });
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>
) {
  return (req: Request, res: Response, _next: NextFunction) => {
    void handler(req, res).catch((error) => sendError(error, res));
  };
}

function publicEvidence(evidence: DiscoveryEvidence) {
  return {
    id: evidence.id,
    targetType: evidence.targetType,
    sourcePlatform: evidence.sourcePlatform,
    sourceTitle: evidence.sourceTitle,
    sourceSnippet: evidence.sourceSnippet,
    publishedAt: evidence.publishedAt,
    fetchedAt: evidence.fetchedAt,
    locale: evidence.locale,
    rawArtifactHash: evidence.rawArtifactHash,
    contentHash: evidence.contentHash,
    provenance: structuredClone(evidence.provenance),
    accessStatus: evidence.accessStatus
  };
}

function publicCandidate(candidate: AcquisitionCandidate) {
  const common = {
    subjectKind: candidate.profile.kind,
    status: candidate.status,
    version: candidate.version,
    identityResolved: acquisitionCandidateIdentityResolved(candidate),
    latestDecisionVersion: candidate.latestDecisionVersion,
    approvedDecisionVersion: candidate.approvedDecisionVersion,
    updatedAt: candidate.updatedAt
  };
  if (candidate.profile.kind === "organization") {
    return {
      id: candidate.id,
      name: candidate.profile.name,
      domain: candidate.profile.domain,
      region: candidate.profile.region,
      creditCode: candidate.profile.creditCode,
      evidenceIds: [...candidate.evidenceIds],
      ...common,
      createdAt: candidate.createdAt
    };
  }
  return {
    id: candidate.id,
    publicActorKey: candidate.profile.publicActorKey,
    publicDisplayName: candidate.profile.publicDisplayName,
    publicProfileUrl: candidate.profile.publicProfileUrl,
    sourcePlatform: candidate.profile.sourcePlatform,
    evidenceIds: [...candidate.evidenceIds],
    demandCategory: candidate.profile.demandCategory,
    demandSummary: candidate.profile.demandSummary,
    locationHint: candidate.profile.locationHint,
    buyingStage: candidate.profile.buyingStage,
    negativeSignals: [...candidate.profile.negativeSignals],
    ...common,
    firstSeenAt: candidate.createdAt,
    lastSeenAt: candidate.updatedAt
  };
}

function publicQualification(decision: QualificationDecision) {
  return {
    id: decision.id,
    candidateId: decision.candidateId,
    decisionVersion: decision.decisionVersion,
    decisionEngine: decision.decisionEngine,
    grade: decision.grade,
    score: decision.score,
    recommendedAction: decision.recommendedAction,
    evidence: structuredClone(decision.evidence),
    positiveSignals: structuredClone(decision.positiveSignals),
    negativeSignals: structuredClone(decision.negativeSignals),
    reasons: [...decision.reasons],
    confidence: decision.confidence,
    ruleVersion: decision.ruleVersion,
    promptVersion: decision.promptVersion,
    modelProvider: decision.modelProvider,
    model: decision.model,
    hardGateFailures: [...decision.hardGateFailures],
    createdAt: decision.createdAt
  };
}

function publicFinancialValue(decision: FinancialValueDecision) {
  return {
    id: decision.id,
    candidateId: decision.candidateId,
    qualificationDecisionId: decision.qualificationDecisionId,
    version: decision.version,
    grade: decision.grade,
    score: decision.score,
    currency: decision.currency,
    expectedRevenueMinor: decision.expectedRevenueMinor,
    expectedGrossProfitMinor: decision.expectedGrossProfitMinor,
    expectedContributionMinor: decision.expectedContributionMinor,
    factors: structuredClone(decision.factors),
    createdAt: decision.createdAt
  };
}

function publicBattleCard(card: BattleCard) {
  const common = {
    id: card.id,
    candidateId: card.candidateId,
    qualificationDecisionId: card.qualificationDecisionId,
    partyType: card.partyType,
    evidenceIds: [...card.evidenceIds],
    confidence: card.confidence,
    modelProvider: card.modelProvider,
    model: card.model,
    promptVersion: card.promptVersion,
    createdAt: card.createdAt,
    schemaVersion: card.schemaVersion ?? "battle-card.v1"
  };
  if (card.schemaVersion === "battle-card.v2") {
    return {
      ...common,
      intelligence: structuredClone(card.intelligence)
    };
  }
  return {
    ...common,
    sections: card.sections.map((section) => ({
      label: section.label,
      kind: section.kind,
      content: section.content,
      ...(section.evidenceIds.length > 0
        ? { evidenceIds: [...section.evidenceIds] }
        : {}),
      ...(section.confidence !== null
        ? { confidence: section.confidence }
        : {})
    })),
    intelligence: null
  };
}

function publicReview(review: ReviewEvent) {
  return {
    id: review.id,
    candidateId: review.candidateId,
    decisionVersion: review.decisionVersion,
    action: review.action,
    reason: review.reason,
    reviewerId: review.reviewerId,
    idempotencyKey: review.idempotencyKey,
    createdAt: review.createdAt
  };
}

function publicResearch(research: ResearchAttempt | null) {
  if (!research) return null;
  return {
    id: research.id,
    candidateId: research.candidateId,
    requestReason: research.requestReason,
    budgetVersion: research.budgetVersion,
    status: research.status,
    newEvidenceIds: [...research.newEvidenceIds],
    terminationReason: research.terminationReason,
    createdAt: research.createdAt,
    startedAt: research.startedAt,
    completedAt: research.completedAt
  };
}

function publicConversion(record: LeadConversionRecord) {
  return {
    id: record.id,
    candidateId: record.candidateId,
    decisionVersion: record.decisionVersion,
    partyRef: structuredClone(record.partyRef),
    leadId: record.leadId,
    reviewerId: record.reviewerId,
    evidenceSnapshotHash: record.evidenceSnapshotHash,
    createdAt: record.createdAt
  };
}

function publicPrivateDomainHandoff(
  result: Awaited<ReturnType<AcquisitionPrivateDomainHandoffService["get"]>>
) {
  if ("inProgress" in result) {
    return {
      replayed: false,
      inProgress: structuredClone(result.inProgress)
    };
  }
  return {
    replayed: result.replayed,
    handoff: {
      id: result.handoff.id,
      candidateId: result.handoff.candidateId,
      leadId: result.handoff.leadId,
      customerId: result.handoff.customerId,
      todoId: result.handoff.todoId,
      runId: result.handoff.acquisitionAttribution?.runId ?? null,
      discoveredEventId:
        result.handoff.acquisitionAttribution?.discoveredEventId ?? null,
      decisionVersion: result.handoff.decisionVersion,
      createdAt: result.handoff.createdAt
    },
    lead: structuredClone(result.lead),
    customer: structuredClone(result.customer),
    todo: structuredClone(result.todo),
    intelligence: structuredClone(result.intelligence),
    ...(result.recovery
      ? { recovery: structuredClone(result.recovery) }
      : {})
  };
}

function publicOutcome(outcome: OutcomeFeedbackEvent) {
  const normalized = normalizeOutcomeFeedbackEvent(outcome);
  const common = {
    id: normalized.id,
    ownerId: normalized.ownerId,
    teamId: normalized.teamId,
    leadId: normalized.leadId,
    customerId: normalized.customerId,
    eventType: normalized.eventType,
    occurredAt: normalized.occurredAt,
    amount: normalized.amount ? { ...normalized.amount } : null,
    reasonCode: normalized.reasonCode,
    reasonText: normalized.reasonText,
    idempotencyKey: normalized.idempotencyKey,
    createdBy: normalized.createdBy,
    createdAt: normalized.createdAt,
    recordKind: normalized.recordKind,
    partyRef: structuredClone(normalized.partyRef),
    candidateId: normalized.candidateId,
    attribution: structuredClone(normalized.attribution)
  };
  return normalized.recordKind === "legacy_migrated"
    ? {
        ...common,
        legacySourceId: normalized.legacySourceId,
        migrationWarnings: [...normalized.migrationWarnings]
      }
    : common;
}

function publicAudit(event: AcquisitionAuditEvent) {
  return {
    id: event.id,
    candidateId: event.candidateId,
    actorId: event.actorId,
    eventType: event.eventType,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    resourceId: event.resourceId,
    createdAt: event.createdAt
  };
}

function publicSession(session: AcquisitionCopilotSession) {
  return {
    id: session.id,
    ownerId: session.ownerId,
    teamId: session.teamId,
    status: session.status,
    modelSnapshot: {
      connectionId: session.modelSnapshot.connectionId,
      credentialVersion: session.modelSnapshot.credentialVersion,
      provider: session.modelSnapshot.provider,
      model: session.modelSnapshot.model,
      promptVersion: session.modelSnapshot.promptVersion,
      schemaVersion: session.modelSnapshot.schemaVersion,
      promptHash: session.modelSnapshot.promptHash,
      schemaHash: session.modelSnapshot.schemaHash
    },
    createdAt: session.createdAt
  };
}

function publicTask(task: AcquisitionCopilotTask) {
  return {
    id: task.id,
    sessionId: task.sessionId,
    kind: task.kind,
    status: task.status,
    responseMode: task.responseMode ?? "assistant",
    targetPlatform: task.targetPlatform ?? "web",
    result: task.result ? structuredClone(task.result) : null,
    errorCode: task.errorCode,
    createdAt: task.createdAt,
    completedAt: task.completedAt
  };
}

function publicMessage(message: AcquisitionCopilotMessage) {
  return {
    id: message.id,
    sessionId: message.sessionId,
    sequence: message.sequence,
    message: structuredClone(message.message),
    createdAt: message.createdAt
  };
}

function operation(input: {
  id: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  resourceId: string | null;
  createdAt: string;
  completedAt: string | null;
}) {
  return {
    ...input,
    error: null
  };
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  ).join(",")}}`;
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function invalidCursor(): never {
  throw new AcquisitionV1HttpError(
    "invalid_cursor",
    "分页游标无效、已过期或不属于当前查询",
    400
  );
}

function cursorScopeContext(
  scope: Pick<AcquisitionActorScope, "ownerId" | "teamId">,
  endpoint: string
) {
  return [scope.ownerId, scope.teamId, endpoint].join("\u001f");
}

function cursorSignature(
  secret: string,
  encodedPayload: string,
  context: string
) {
  return createHmac("sha256", secret)
    .update(context)
    .update("\n")
    .update(encodedPayload)
    .digest("base64url");
}

function validSignature(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

interface CursorBinding {
  secret: string;
  scope: Pick<AcquisitionActorScope, "ownerId" | "teamId">;
  endpoint: string;
  filters: unknown;
}

type CursorPayload = z.infer<typeof cursorPayloadSchema>;

function encodeCursor(
  payload: Omit<CursorPayload, "v" | "endpoint" | "filterFingerprint">,
  binding: CursorBinding
) {
  const fullPayload: CursorPayload = {
    v: CURSOR_VERSION,
    endpoint: binding.endpoint,
    filterFingerprint: fingerprint(binding.filters),
    ...payload
  };
  const encoded = Buffer.from(
    JSON.stringify(fullPayload),
    "utf8"
  ).toString("base64url");
  return `${encoded}.${cursorSignature(
    binding.secret,
    encoded,
    cursorScopeContext(binding.scope, binding.endpoint)
  )}`;
}

function decodeCursor(value: string, binding: CursorBinding) {
  const [encoded, signature, ...rest] = value.split(".");
  if (!encoded || !signature || rest.length !== 0) invalidCursor();
  const expected = cursorSignature(
    binding.secret,
    encoded,
    cursorScopeContext(binding.scope, binding.endpoint)
  );
  if (!validSignature(signature, expected)) invalidCursor();
  let payload: CursorPayload;
  try {
    payload = cursorPayloadSchema.parse(JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ));
  } catch {
    return invalidCursor();
  }
  if (payload.endpoint !== binding.endpoint
    || payload.filterFingerprint !== fingerprint(binding.filters)) {
    return invalidCursor();
  }
  return payload;
}

function offsetFromPosition(position: string) {
  if (!/^(0|[1-9]\d*)$/.test(position)) return invalidCursor();
  const offset = Number(position);
  if (!Number.isSafeInteger(offset) || offset < 0) return invalidCursor();
  return offset;
}

function page<T>(
  values: T[],
  query: { cursor?: string; limit: number },
  project: (value: T) => unknown,
  binding: CursorBinding
) {
  const projected = values.map(project);
  const snapshot = fingerprint(projected);
  const cursor = query.cursor
    ? decodeCursor(query.cursor, binding)
    : null;
  if (cursor && cursor.snapshot !== snapshot) invalidCursor();
  const offset = cursor ? offsetFromPosition(cursor.position) : 0;
  const items = projected.slice(offset, offset + query.limit);
  const nextOffset = offset + items.length;
  return {
    items,
    nextCursor: nextOffset < projected.length
      ? encodeCursor({
        snapshot,
        position: String(nextOffset)
      }, binding)
      : null
  };
}

function configuredCursorSecret(explicit: string | undefined) {
  const configured = explicit?.trim()
    || process.env.ACQUISITION_V1_CURSOR_SECRET?.trim()
    || "";
  if (configured && configured.length < 32) {
    throw new TypeError(
      "Acquisition v1 cursor secret must contain at least 32 characters"
    );
  }
  if (!configured && process.env.NODE_ENV === "production") {
    throw new TypeError(
      "ACQUISITION_V1_CURSOR_SECRET is required in production"
    );
  }
  return configured || DEVELOPMENT_CURSOR_SECRET;
}

function withPagination<T extends { cursor?: string; limit?: number }>(
  query: T
): T & { limit: number } {
  return {
    ...query,
    limit: query.limit ?? 50
  };
}

function latest<T>(values: T[], message: string): T {
  const value = values.at(-1);
  if (!value) {
    throw new AcquisitionV1HttpError(
      "resource_not_found",
      message,
      404
    );
  }
  return value;
}

export function createAcquisitionV1Router(
  options: AcquisitionV1RouterOptions
) {
  const router = Router();
  const cursorSecret = configuredCursorSecret(options.cursorSecret);
  const idFactory =
    options.requestIdFactory ?? ((prefix: string) => `${prefix}_${randomUUID()}`);
  const dispatch = options.dispatchCopilotTask
    ?? ((scope: AcquisitionCopilotScope, taskId: string) =>
      options.copilotService.runTask(scope, taskId).then(() => undefined));
  const requireDirectDomainWrites: RequestHandler = (_req, res, next) => {
    if (options.allowDirectDomainWrites === true) {
      next();
      return;
    }
    sendError(new AcquisitionV1HttpError(
      "direct_domain_write_disabled",
      "该数据只能由受控获客任务或可信业务集成写入",
      403
    ), res);
  };

  router.use("/api/v1/acquisition", (_req, res, next) => {
    const id = idFactory("request");
    res.locals.acquisitionRequestId = id;
    res.setHeader("X-Request-Id", id);
    next();
  });

  router.use("/api/v1/acquisition", (req, res, next) => {
    try {
      scopeFromRequest(req);
      next();
    } catch (error) {
      sendError(error, res);
    }
  });

  router.post(
    "/api/v1/acquisition/evidence",
    requireDirectDomainWrites,
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const result = await options.domainService.appendEvidence(
        scope,
        parse(evidenceInputSchema, req.body),
        idempotencyKey(req)
      );
      res.status(201).json(publicEvidence(result));
    })
  );

  router.get(
    "/api/v1/acquisition/evidence/:id",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const result = await options.domainService.getEvidence(
        scope,
        parse(idSchema, req.params.id)
      );
      res.json(publicEvidence(result));
    })
  );

  router.post(
    "/api/v1/acquisition/candidates",
    requireDirectDomainWrites,
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const body = parse(candidateInputSchema, req.body);
      const key = idempotencyKey(req);
      const result = body.subjectKind === "organization"
        ? await options.domainService.createOrganizationCandidate(
          scope,
          {
            name: body.name,
            domain: body.domain,
            region: body.region,
            creditCode: body.creditCode,
            organizationId: body.organizationId,
            tenantProspectId: body.tenantProspectId,
            evidenceIds: body.evidenceIds
          },
          key
        )
        : await options.domainService.createIndividualCandidate(
          scope,
          {
            publicActorKey: body.publicActorKey,
            publicDisplayName: body.publicDisplayName,
            publicProfileUrl: body.publicProfileUrl,
            sourcePlatform: body.sourcePlatform,
            demandSignalId: body.demandSignalId,
            demandCategory: body.demandCategory,
            demandSummary: body.demandSummary,
            locationHint: body.locationHint,
            buyingStage: body.buyingStage,
            negativeSignals: body.negativeSignals,
            individualPartyId: body.individualPartyId,
            evidenceIds: body.evidenceIds
          },
          key
        );
      res.status(201).json(publicCandidate(result));
    })
  );

  router.get("/api/v1/acquisition/candidates", asyncRoute(async (req, res) => {
    const scope = scopeFromRequest(req);
    const query = withPagination(
      parse(candidateListQuerySchema, req.query)
    );
    const binding: CursorBinding = {
      secret: cursorSecret,
      scope,
      endpoint: "candidates",
      filters: {
        subjectKind: query.subjectKind ?? null,
        status: query.status ?? null
      }
    };
    const cursor = query.cursor ? decodeCursor(query.cursor, binding) : null;
    const result = await options.queryPort.listCandidates(scope, {
      limit: query.limit,
      subjectKind: query.subjectKind,
      status: query.status,
      cursor: cursor?.position,
      snapshot: cursor?.snapshot
    });
    const snapshot = String(result.snapshot ?? "").trim();
    if (!snapshot || snapshot.length > 1_000) {
      throw new AcquisitionV1HttpError(
        "invalid_query_port_response",
        "候选查询服务返回了无效的数据快照",
        500,
        null,
        true
      );
    }
    if (cursor && cursor.snapshot !== snapshot) invalidCursor();
    if (result.nextCursor
      && (result.nextCursor.length > 2_048 || !result.nextCursor.trim())) {
      throw new AcquisitionV1HttpError(
        "invalid_query_port_response",
        "候选查询服务返回了无效的分页位置",
        500,
        null,
        true
      );
    }
    res.json({
      items: result.items
        .filter((candidate) =>
          candidate.ownerId === scope.ownerId
          && candidate.teamId === scope.teamId
        )
        .map(publicCandidate),
      nextCursor: result.nextCursor
        ? encodeCursor({
          snapshot,
          position: result.nextCursor
        }, binding)
        : null
    });
  }));

  router.get(
    "/api/v1/acquisition/candidates/:id",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const candidate = await options.domainService.getCandidate(
        scope,
        parse(idSchema, req.params.id)
      );
      setCandidateEtag(res, candidate);
      res.json(publicCandidate(candidate));
    })
  );

  router.get(
    "/api/v1/acquisition/candidates/:id/evidence",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const query = withPagination(
        parse(paginationQuerySchema.strict(), req.query)
      );
      const candidate = await options.domainService.getCandidate(
        scope,
        parse(idSchema, req.params.id)
      );
      const evidence = await Promise.all(candidate.evidenceIds.map((id) =>
        options.domainService.getEvidence(scope, id)
      ));
      res.json(page(evidence, query, publicEvidence, {
        secret: cursorSecret,
        scope,
        endpoint: `candidate_evidence:${candidate.id}`,
        filters: { candidateId: candidate.id }
      }));
    })
  );

  router.post(
    "/api/v1/acquisition/candidates/:id/identity-confirmation",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const candidateId = parse(idSchema, req.params.id);
      const body = parse(identityConfirmationBodySchema, req.body);
      const common = {
        expectedCandidateVersion: expectedCandidateVersion(req),
        evidenceIds: body.evidenceIds,
        rationale: body.rationale
      };
      const result = await options.identityResolutionService
        .resolveCandidateIdentity(
          scope,
          candidateId,
          body.subjectKind === "organization"
            ? {
                ...common,
                subject: {
                  kind: "organization",
                  domain: body.domain,
                  creditCode: body.creditCode
                }
              }
            : {
                ...common,
                subject: {
                  kind: "individual",
                  publicProfileUrl: body.publicProfileUrl,
                  sourcePlatform: body.sourcePlatform
                }
              },
          idempotencyKey(req)
        );
      setCandidateEtag(res, result.candidate);
      res.json({
        candidate: publicCandidate(result.candidate),
        resolution: result.resolution
      });
    })
  );

  router.post(
    "/api/v1/acquisition/candidates/:id/evidence",
    requireDirectDomainWrites,
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const body = parse(attachEvidenceBodySchema, req.body);
      const candidate = await options.domainService.attachEvidenceToCandidate(
        scope,
        parse(idSchema, req.params.id),
        body.evidenceId,
        idempotencyKey(req)
      );
      res.json(publicCandidate(candidate));
    })
  );

  router.post(
    "/api/v1/acquisition/candidates/:id/research",
    requireDirectDomainWrites,
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const body = parse(researchBodySchema, req.body);
      const research = await options.domainService.startResearch(
        scope,
        parse(idSchema, req.params.id),
        body.researchId,
        idempotencyKey(req)
      );
      res.status(202).json(operation({
        id: research.id,
        kind: "candidate_research",
        status: "running",
        resourceId: research.id,
        createdAt: research.createdAt,
        completedAt: null
      }));
    })
  );

  router.get(
    "/api/v1/acquisition/candidates/:id/qualification",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const candidateId = parse(idSchema, req.params.id);
      const candidate = await options.domainService.getCandidate(
        scope,
        candidateId
      );
      if (!candidate.latestDecisionId) {
        throw new AcquisitionV1HttpError(
          "resource_not_found",
          "候选当前没有有效的资格决定",
          404
        );
      }
      const decision = await options.domainService.getQualificationDecision(
        scope,
        candidateId,
        candidate.latestDecisionId
      );
      res.json(publicQualification(decision));
    })
  );

  router.post(
    "/api/v1/acquisition/candidates/:id/qualification",
    requireDirectDomainWrites,
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const body = parse(qualifyBodySchema, req.body);
      const result = await options.domainService.qualifyCandidate(
        scope,
        parse(idSchema, req.params.id),
        body.qualification,
        body.financial,
        idempotencyKey(req)
      );
      res.status(202).json(operation({
        id: result.qualification.id,
        kind: "candidate_qualification",
        status: "succeeded",
        resourceId: result.qualification.id,
        createdAt: result.qualification.createdAt,
        completedAt: result.qualification.createdAt
      }));
    })
  );

  router.get(
    "/api/v1/acquisition/candidates/:id/financial-value",
    asyncRoute(async (req, res) => {
      const decision =
        await options.domainService.getCurrentFinancialValueDecision(
          scopeFromRequest(req),
          parse(idSchema, req.params.id)
        );
      res.json(publicFinancialValue(decision));
    })
  );

  router.get(
    "/api/v1/acquisition/candidates/:id/battle-card",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const candidate = await options.domainService.getCandidate(
        scope,
        parse(idSchema, req.params.id)
      );
      if (!candidate.latestDecisionId) {
        throw new AcquisitionV1HttpError(
          "resource_not_found",
          "候选当前没有有效的客户作战卡",
          404
        );
      }
      const cards = await options.domainService.listBattleCards(
        scope,
        candidate.id
      );
      res.json(publicBattleCard(latest(
        cards.filter((card) =>
          card.qualificationDecisionId === candidate.latestDecisionId
        ),
        "候选当前没有有效的客户作战卡"
      )));
    })
  );

  router.post(
    "/api/v1/acquisition/candidates/:id/battle-card",
    requireDirectDomainWrites,
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const card = await options.domainService.createBattleCard(
        scope,
        parse(idSchema, req.params.id),
        parse(battleCardBodySchema, req.body),
        idempotencyKey(req)
      );
      res.status(202).json(operation({
        id: card.id,
        kind: "battle_card_generation",
        status: "succeeded",
        resourceId: card.id,
        createdAt: card.createdAt,
        completedAt: card.createdAt
      }));
    })
  );

  router.get(
    "/api/v1/acquisition/candidates/:id/reviews",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const query = withPagination(
        parse(paginationQuerySchema.strict(), req.query)
      );
      const candidateId = parse(idSchema, req.params.id);
      const reviews = await options.domainService.listReviewEvents(
        scope,
        candidateId
      );
      res.json(page(reviews, query, publicReview, {
        secret: cursorSecret,
        scope,
        endpoint: `candidate_reviews:${candidateId}`,
        filters: { candidateId }
      }));
    })
  );

  router.post(
    "/api/v1/acquisition/candidates/:id/review",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const body = parse(reviewBodySchema, req.body);
      const result = await options.domainService.reviewCandidate(
        scope,
        parse(idSchema, req.params.id),
        {
          ...body,
          idempotencyKey: idempotencyKey(req)
        }
      );
      res.json({
        candidate: publicCandidate(result.candidate),
        review: publicReview(result.review),
        research: publicResearch(result.research)
      });
    })
  );

  router.post(
    "/api/v1/acquisition/candidates/:id/convert",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const body = parse(convertBodySchema, req.body);
      const conversion = await options.domainService.convertCandidate(
        scope,
        parse(idSchema, req.params.id),
        {
          decisionVersion: body.decisionVersion,
          idempotencyKey: idempotencyKey(req)
        }
      );
      res.json(publicConversion(conversion));
    })
  );

  if (options.privateDomainHandoffService) {
    router.post(
      "/api/v1/acquisition/candidates/:id/private-domain-handoffs",
      asyncRoute(async (req, res) => {
        const scope = scopeFromRequest(req);
        const result = await options.privateDomainHandoffService!.create(
          scope,
          parse(idSchema, req.params.id),
          parse(privateDomainHandoffBodySchema, req.body),
          handoffIdempotencyKey(req)
        );
        if (result.replayed) {
          res.setHeader("Idempotency-Replayed", "true");
        }
        res.json(publicPrivateDomainHandoff(result));
      })
    );

    router.get(
      "/api/v1/acquisition/candidates/:id/private-domain-handoff",
      asyncRoute(async (req, res) => {
        const result = await options.privateDomainHandoffService!.get(
          scopeFromRequest(req),
          parse(idSchema, req.params.id)
        );
        res.json(publicPrivateDomainHandoff(result));
      })
    );
  }

  router.post(
    "/api/v1/acquisition/outcomes",
    requireDirectDomainWrites,
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const body = parse(outcomeBodySchema, req.body);
      const outcome = await options.domainService.recordOutcome(scope, {
        ...body,
        idempotencyKey: idempotencyKey(req)
      });
      res.status(201).json(publicOutcome(outcome));
    })
  );

  router.get("/api/v1/acquisition/outcomes", asyncRoute(async (req, res) => {
    const scope = scopeFromRequest(req);
    const query = withPagination(
      parse(candidateScopedListQuerySchema, req.query)
    );
    const outcomes = await options.domainService.listOutcomes(
      scope,
      query.candidateId
    );
    res.json(page(outcomes, query, publicOutcome, {
      secret: cursorSecret,
      scope,
      endpoint: "outcomes",
      filters: { candidateId: query.candidateId }
    }));
  }));

  router.get(
    "/api/v1/acquisition/audit-events",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const query = withPagination(
        parse(auditListQuerySchema, req.query)
      );
      const events = await options.domainService.listAuditEvents(
        scope,
        query.candidateId ?? null
      );
      res.json(page(events, query, publicAudit, {
        secret: cursorSecret,
        scope,
        endpoint: "audit_events",
        filters: { candidateId: query.candidateId ?? null }
      }));
    })
  );

  router.post(
    "/api/v1/acquisition/copilot/sessions",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const snapshot = options.resolveCopilotModelSnapshot
        ? await options.resolveCopilotModelSnapshot(
          scope,
          {
            connectionId:
              parse(createBoundCopilotSessionBodySchema, req.body)
                .connectionId ?? null
          }
        )
        : parse(createCopilotSessionBodySchema, req.body).modelSnapshot;
      const session = await options.copilotService.createSession(
        scope,
        snapshot,
        idempotencyKey(req)
      );
      res.status(202).json(operation({
        id: session.id,
        kind: "copilot_session_creation",
        status: "succeeded",
        resourceId: session.id,
        createdAt: session.createdAt,
        completedAt: session.createdAt
      }));
    })
  );

  router.get(
    "/api/v1/acquisition/copilot/sessions/:id",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const session = await options.copilotService.getSession(
        scope,
        parse(idSchema, req.params.id)
      );
      res.json(publicSession(session));
    })
  );

  router.get(
    "/api/v1/acquisition/copilot/sessions/:id/messages",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const query = withPagination(
        parse(paginationQuerySchema.strict(), req.query)
      );
      const sessionId = parse(idSchema, req.params.id);
      const messages = await options.copilotService.listMessages(
        scope,
        sessionId
      );
      res.json(page(messages, query, publicMessage, {
        secret: cursorSecret,
        scope,
        endpoint: `copilot_messages:${sessionId}`,
        filters: { sessionId }
      }));
    })
  );

  router.post(
    "/api/v1/acquisition/copilot/sessions/:id/messages",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const body = parse(copilotMessageBodySchema, req.body);
      const task = await options.copilotService.enqueueMessage(
        scope,
        parse(idSchema, req.params.id),
        body.message,
        idempotencyKey(req),
        body.responseMode,
        body.targetPlatform
      );
      const claimed = await options.copilotService.claimTaskDispatch(
        scope,
        task.id
      );
      res.status(202).json(publicTask(task));
      if (claimed) {
        queueMicrotask(() => {
          void Promise.resolve()
            .then(() => dispatch(scope, task.id))
            .catch(() => options.copilotService.markDispatchFailed(
              scope,
              task.id,
              "COPILOT_DISPATCH_FAILED"
            ))
            .catch(() => undefined);
        });
      }
    })
  );

  router.get(
    "/api/v1/acquisition/copilot/tasks/:id",
    asyncRoute(async (req, res) => {
      const scope = scopeFromRequest(req);
      const task = await options.copilotService.getTask(
        scope,
        parse(idSchema, req.params.id)
      );
      res.json(publicTask(task));
    })
  );

  return router;
}
