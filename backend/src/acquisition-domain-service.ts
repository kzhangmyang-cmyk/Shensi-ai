import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import type {
  AcquisitionAuditEvent,
  AcquisitionCandidate,
  BattleCard,
  BattleCardClaim,
  BattleCardIntelligenceV2,
  BattleCardInput,
  BattleCardV1,
  BattleCardV2,
  CandidateIdentityResolutionCommitInput,
  CandidateIdentityResolutionResult,
  CandidateStatus,
  DiscoveryEvidence,
  DiscoveryEvidenceInput,
  FinancialValueDecision,
  FinancialValueInput,
  HardGateFailure,
  IdempotencyRecord,
  IndividualCandidateInput,
  IndividualDemandSignalMergeInput,
  LeadConversionIntent,
  LeadConversionRecord,
  LiveOutcomeFeedbackEvent,
  OrganizationCandidateInput,
  OutcomeInput,
  OutcomeFeedbackEvent,
  PartyRef,
  QualificationDecision,
  QualificationDimensions,
  QualificationHardGates,
  QualificationInput,
  ResearchAttempt,
  ReviewAction,
  ReviewEvent
} from "./acquisition-domain.js";
import {
  normalizeOutcomeFeedbackEvent
} from "./acquisition-outcome-compatibility.js";
import {
  isVerifiedAcquisitionPublicProfileUrl
} from "./acquisition-public-identity-resolver.js";
import { classifyDouyinPublicSource } from "./acquisition-douyin-public-source.js";
import type {
  AcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import {
  assertGrowthTemporalBarrier,
  type GrowthTemporalBarrier,
  type GrowthTemporalTransaction
} from "./growth-temporal-barrier.js";
import {
  assertGrowthAcquisitionWorkspaceResolver,
  type GrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";

export interface AcquisitionActorScope {
  ownerId: string;
  teamId: string;
  actorId: string;
}

export interface LeadConversionPort {
  createLead(request: {
    ownerId: string;
    teamId: string;
    actorId: string;
    candidateId: string;
    partyRef: PartyRef;
    decisionVersion: string;
    evidenceIds: string[];
    idempotencyKey: string;
  }): Promise<{
    leadId: string;
    partyRef: PartyRef;
  }>;
}

export type AcquisitionDomainErrorCode =
  | "invalid_request"
  | "capability_forbidden"
  | "resource_not_found"
  | "idempotency_conflict"
  | "identity_conflict"
  | "stale_candidate"
  | "invalid_state"
  | "hard_gate_blocked"
  | "evidence_required"
  | "stale_decision"
  | "conversion_failed";

export interface AcquisitionOutcomeWriteAuthority {
  capability: "acquisition.outcome.reconcile.internal";
  sourceStableKey: string;
}

const COMMERCIAL_OUTCOMES = new Set(["quoted", "won", "lost"] as const);

export class AcquisitionDomainError extends Error {
  constructor(
    public readonly code: AcquisitionDomainErrorCode,
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = "AcquisitionDomainError";
  }
}

export interface AcquisitionDomainServiceOptions {
  repository: AcquisitionDomainRepository;
  leadConversionPort: LeadConversionPort;
  growthAcquisitionWorkspace: GrowthAcquisitionWorkspaceResolver;
  growthTemporalBarrier: GrowthTemporalBarrier;
  idFactory?: (prefix: string) => string;
  now?: () => string;
}

const HARD_GATE_LABELS: Record<HardGateFailure, string> = {
  missing_original_source: "缺少原始来源",
  identity_unresolved: "主体身份未解决",
  do_not_contact: "主体已在勿扰范围",
  explicit_rejection: "存在明确拒绝",
  non_public_or_sensitive_data: "包含非公开或敏感数据",
  stale_evidence: "证据已过期",
  schema_invalid: "数据结构不合格"
};

const POSITIVE_DIMENSIONS: Array<{
  key: keyof QualificationDimensions;
  label: string;
  weight: number;
}> = [
  { key: "demandStrength", label: "需求明确度", weight: 0.22 },
  { key: "fit", label: "ICP/产品匹配", weight: 0.16 },
  { key: "identityConfidence", label: "主体身份可信度", weight: 0.10 },
  { key: "buyingStage", label: "购买阶段", weight: 0.16 },
  { key: "budgetPotential", label: "预算可能性", weight: 0.10 },
  { key: "decisionReachability", label: "决策链可达性", weight: 0.08 },
  { key: "freshness", label: "信号新鲜度", weight: 0.10 },
  { key: "evidenceDiversity", label: "多来源证据", weight: 0.08 }
];

const TERMINAL_RESEARCH_RESULTS = new Set([
  "completed",
  "no_new_evidence",
  "access_restricted",
  "failed"
]);

const BUYING_STAGE_RANK = Object.freeze({
  awareness: 0,
  problem_defined: 1,
  solution_research: 2,
  comparison: 3,
  purchase_ready: 4
} satisfies Record<IndividualDemandSignalMergeInput["buyingStage"], number>);

const DEMAND_SUMMARY_SEPARATOR = "\n\n---\n\n";

function mergeDemandSummaries(existing: string, incoming: string) {
  const summaries = [...new Set([
    ...existing.split(DEMAND_SUMMARY_SEPARATOR),
    incoming
  ].map((item) => item.trim()).filter(Boolean))];
  while (summaries.length > 1
    && summaries.join(DEMAND_SUMMARY_SEPARATOR).length > 2_000) {
    summaries.shift();
  }
  return summaries.join(DEMAND_SUMMARY_SEPARATOR).slice(0, 2_000);
}

function fail(
  code: AcquisitionDomainErrorCode,
  message: string,
  status = 409
): never {
  throw new AcquisitionDomainError(code, message, status);
}

function hash(value: unknown) {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value))
    .digest("hex")}`;
}

function idempotencyFingerprint(value: string) {
  return /^sha256:[a-f0-9]{64}$/iu.test(value)
    ? value.toLowerCase()
    : `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function bounded(value: number, min = 0, max = 100) {
  if (!Number.isFinite(value)) {
    fail("invalid_request", "评分输入必须是有限数值", 400);
  }
  return Math.min(max, Math.max(min, value));
}

function rounded(value: number) {
  return Math.round(value * 100) / 100;
}

function requiredText(value: unknown, label: string, max = 500) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) {
    fail("invalid_request", `${label}不能为空且不能超过 ${max} 个字符`, 400);
  }
  return text;
}

function optionalText(value: unknown, label: string, max = 500) {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(value, label, max);
}

function validIso(value: string, label: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    fail("invalid_request", `${label}必须是合法 ISO 8601 时间`, 400);
  }
  return new Date(timestamp).toISOString();
}

function validateOutcomeAttribution(
  attribution: OutcomeInput["attribution"]
) {
  if (attribution?.attributionVersion !== "acquisition-run.v1") {
    fail("invalid_request", "结果反馈归因版本无效", 400);
  }
  for (const [field, value] of Object.entries({
    runId: attribution.runId,
    planId: attribution.planId,
    planVersionId: attribution.planVersionId,
    planSnapshotHash: attribution.planSnapshotHash,
    discoveredEventId: attribution.discoveredEventId,
    shardId: attribution.shardId,
    operationId: attribution.operationId,
    connectionId: attribution.connectionId,
    providerId: attribution.providerId
  })) {
    requiredText(value, `结果反馈归因 ${field}`, 255);
  }
  if (!Number.isSafeInteger(attribution.planVersion)
    || attribution.planVersion < 1) {
    fail("invalid_request", "结果反馈归因 planVersion 无效", 400);
  }
  validIso(attribution.discoveredAt, "结果反馈归因发现时间");
}

function validUrl(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("invalid_request", `${label}必须是合法 URL`, 400);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    fail("invalid_request", `${label}只允许 HTTP 或 HTTPS`, 400);
  }
  return url.toString();
}

function gradeForQualification(score: number): QualificationDecision["grade"] {
  if (score >= 85) return "S";
  if (score >= 70) return "A";
  if (score >= 55) return "B";
  if (score >= 35) return "C";
  return "D";
}

function gradeForFinancialValue(score: number): FinancialValueDecision["grade"] {
  if (score >= 80) return "S";
  if (score >= 65) return "A";
  if (score >= 50) return "B";
  if (score >= 30) return "C";
  return "D";
}

function recommendedAction(
  grade: QualificationDecision["grade"]
): QualificationDecision["recommendedAction"] {
  if (grade === "S" || grade === "A") return "priority_review";
  if (grade === "B") return "public_response";
  if (grade === "C") return "observe";
  return "do_not_contact";
}

function hardGateFailures(gates: QualificationHardGates) {
  const failures: HardGateFailure[] = [];
  if (!gates.hasOriginalSource) failures.push("missing_original_source");
  if (!gates.identityResolved) failures.push("identity_unresolved");
  if (!gates.notDoNotContact) failures.push("do_not_contact");
  if (!gates.noExplicitRejection) failures.push("explicit_rejection");
  if (!gates.publicDataOnly) failures.push("non_public_or_sensitive_data");
  if (!gates.evidenceFresh) failures.push("stale_evidence");
  if (!gates.schemaValid) failures.push("schema_invalid");
  return failures;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function battleCardClaim(
  raw: BattleCardClaim,
  label: string
): BattleCardClaim {
  const kind = raw.kind;
  if (!["fact", "inference", "unknown"].includes(kind)) {
    fail("invalid_request", `${label}类型无效`, 400);
  }
  const evidenceIds = [...new Set(raw.evidenceIds ?? [])];
  const confidence = raw.confidence === null
    ? null
    : bounded(raw.confidence, 0, 1);
  if (kind === "fact" && evidenceIds.length === 0) {
    fail("evidence_required", `${label}事实必须引用原始证据`, 422);
  }
  if (kind === "inference"
    && (evidenceIds.length === 0 || confidence === null)) {
    fail("evidence_required", `${label}推断必须引用证据并提供置信度`, 422);
  }
  if (kind === "unknown"
    && (evidenceIds.length > 0 || confidence !== null)) {
    fail("invalid_request", `${label}未知项不得引用证据或声明置信度`, 422);
  }
  return {
    kind,
    text: requiredText(raw.text, `${label}内容`, 4_000),
    evidenceIds,
    confidence
  };
}

function v2Claims(intelligence: BattleCardIntelligenceV2) {
  return [
    ...intelligence.accountOverview,
    ...intelligence.needAssessment,
    ...intelligence.supplierHypotheses,
    ...intelligence.procurementPreferences,
    ...intelligence.buyingCommittee.map((role) => role.claim),
    ...intelligence.connectionStrategies.map((strategy) =>
      strategy.rationale)
  ];
}

function financialSummary(
  decision: FinancialValueDecision
): BattleCardIntelligenceV2["financialSummary"] {
  return {
    decisionId: decision.id,
    decisionVersion: decision.version,
    grade: decision.grade,
    score: decision.score,
    currency: decision.currency,
    expectedRevenueMinor: decision.expectedRevenueMinor,
    expectedGrossProfitMinor: decision.expectedGrossProfitMinor,
    expectedContributionMinor: decision.expectedContributionMinor,
    factors: clone(decision.factors)
  };
}

export class AcquisitionDomainService {
  private readonly repository: AcquisitionDomainRepository;
  private readonly leadConversionPort: LeadConversionPort;
  private readonly growthAcquisitionWorkspace:
    GrowthAcquisitionWorkspaceResolver;
  private readonly growthTemporalBarrier: GrowthTemporalBarrier;
  private readonly idFactory: (prefix: string) => string;
  private readonly clock: () => string;
  private readonly inFlightIdempotency = new Map<string, {
    requestHash: string;
    promise: Promise<unknown>;
  }>();
  private readonly inFlightConversions = new Map<
    string,
    Promise<LeadConversionRecord>
  >();

  constructor(options: AcquisitionDomainServiceOptions) {
    this.repository = options.repository;
    this.leadConversionPort = options.leadConversionPort;
    this.growthAcquisitionWorkspace =
      assertGrowthAcquisitionWorkspaceResolver(
        options.growthAcquisitionWorkspace
      );
    this.growthTemporalBarrier = assertGrowthTemporalBarrier(
      options.growthTemporalBarrier
    );
    this.idFactory = options.idFactory
      ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`);
    this.clock = options.now ?? (() => new Date().toISOString());
  }

  resolveGrowthAcquisitionWorkspace(
    scope: Readonly<{ ownerId: string; teamId: string }>
  ) {
    return this.growthAcquisitionWorkspace.resolve(scope);
  }

  allocateGrowthAppend(
    transaction: GrowthTemporalTransaction,
    workspaceId: string
  ) {
    return this.growthTemporalBarrier.allocateAppend(
      transaction,
      workspaceId
    );
  }

  async appendEvidence(
    scope: AcquisitionActorScope,
    raw: DiscoveryEvidenceInput,
    idempotencyKey: string
  ) {
    this.validateScope(scope);
    const input = this.normalizeEvidenceInput(raw);
    if (input.provenance.kind === "authorized_visual_observation") {
      fail("invalid_request", "授权视觉证据必须使用受限写入边界", 400);
    }
    return this.idempotent(
      scope,
      "append_evidence",
      idempotencyKey,
      input,
      async () => {
        if (input.supersedesEvidenceId) {
          await this.requireEvidence(scope, input.supersedesEvidenceId);
        }
        if (input.provenance.kind === "controlled_public_page") {
          await this.requireEvidence(
            scope,
            input.provenance.discoveredFromEvidenceId
          );
        }
        const evidence: DiscoveryEvidence = {
          ...input,
          id: this.idFactory("evidence"),
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          fetchedAt: validIso(this.clock(), "证据抓取时间")
        };
        await this.repository.appendEvidence(evidence);
        await this.audit(scope, {
          candidateId: null,
          eventType: "evidence_appended",
          fromStatus: null,
          toStatus: null,
          resourceId: evidence.id,
          idempotencyKey,
          payload: input
        });
        return evidence;
      }
    );
  }

  /** Internal-only append boundary for immutable authorized visual facts. */
  async appendAuthorizedVisualEvidence(
    scope: AcquisitionActorScope,
    raw: DiscoveryEvidenceInput,
    literalEvidenceId: string,
    idempotencyKey: string
  ) {
    this.validateScope(scope);
    const input = this.normalizeEvidenceInput(raw);
    if (input.provenance.kind !== "authorized_visual_observation"
      || input.supersedesEvidenceId !== null
      || literalEvidenceId !== `visual:${input.provenance.observationId}`
        + `:evidence:${input.contentHash}`) {
      fail("invalid_request", "视觉证据 ID 无效", 400);
    }
    return this.idempotent(
      scope,
      "append_authorized_visual_evidence",
      idempotencyKey,
      { input, literalEvidenceId },
      async () => {
        const evidence: DiscoveryEvidence = {
          ...input,
          id: literalEvidenceId,
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          fetchedAt: validIso(this.clock(), "证据抓取时间")
        };
        await this.repository.appendEvidence(evidence);
        await this.audit(scope, {
          candidateId: null,
          eventType: "evidence_appended",
          fromStatus: null,
          toStatus: null,
          resourceId: evidence.id,
          idempotencyKey,
          payload: input
        });
        return evidence;
      }
    );
  }

  async getEvidence(scope: AcquisitionActorScope, evidenceId: string) {
    this.validateScope(scope);
    return this.requireEvidence(scope, evidenceId);
  }

  async createOrganizationCandidate(
    scope: AcquisitionActorScope,
    raw: OrganizationCandidateInput,
    idempotencyKey: string
  ) {
    this.validateScope(scope);
    const input: OrganizationCandidateInput = {
      name: requiredText(raw.name, "企业名称", 200),
      domain: optionalText(raw.domain, "企业域名", 255),
      region: optionalText(raw.region, "企业地区", 120),
      creditCode: optionalText(raw.creditCode, "统一社会信用代码", 50),
      organizationId: requiredText(raw.organizationId, "Organization ID", 100),
      tenantProspectId: requiredText(
        raw.tenantProspectId,
        "Tenant Prospect ID",
        100
      ),
      evidenceIds: this.uniqueIds(raw.evidenceIds, "企业证据")
    };
    return this.idempotent(
      scope,
      "create_organization_candidate",
      idempotencyKey,
      input,
      async () => {
        await this.validateEvidenceSet(scope, input.evidenceIds, "organization");
        const now = validIso(this.clock(), "候选创建时间");
        const candidate: AcquisitionCandidate = {
          id: this.idFactory("candidate"),
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          partyType: "organization",
          partyRef: {
            partyType: "organization",
            organizationId: input.organizationId,
            tenantProspectId: input.tenantProspectId
          },
          profile: {
            kind: "organization",
            name: input.name,
            domain: input.domain,
            region: input.region,
            creditCode: input.creditCode
          },
          evidenceIds: input.evidenceIds,
          status: "normalized",
          latestDecisionId: null,
          latestDecisionVersion: null,
          approvedDecisionVersion: null,
          hardGateFailures: [],
          leadId: null,
          createdAt: now,
          updatedAt: now,
          version: 1
        };
        await this.repository.insertCandidate(candidate);
        await this.audit(scope, {
          candidateId: candidate.id,
          eventType: "organization_candidate_normalized",
          fromStatus: null,
          toStatus: "normalized",
          resourceId: candidate.id,
          idempotencyKey,
          payload: candidate
        });
        return candidate;
      }
    );
  }

  async createIndividualCandidate(
    scope: AcquisitionActorScope,
    raw: IndividualCandidateInput,
    idempotencyKey: string,
    beforeCommit?: (candidate: AcquisitionCandidate) => Promise<void>
  ) {
    this.validateScope(scope);
    const profileUrl = validUrl(
      requiredText(raw.publicProfileUrl, "公开主页", 2_000),
      "公开主页"
    );
    const input: IndividualCandidateInput = {
      publicActorKey: requiredText(raw.publicActorKey, "公开账号标识", 300),
      publicDisplayName: requiredText(raw.publicDisplayName, "公开名称", 200),
      publicProfileUrl: profileUrl,
      sourcePlatform: requiredText(raw.sourcePlatform, "来源平台", 100),
      demandSignalId: requiredText(raw.demandSignalId, "需求信号 ID", 100),
      demandCategory: requiredText(raw.demandCategory, "需求分类", 100),
      demandSummary: requiredText(raw.demandSummary, "需求摘要", 2_000),
      locationHint: String(raw.locationHint ?? "").trim().slice(0, 200),
      buyingStage: raw.buyingStage,
      negativeSignals: (raw.negativeSignals ?? [])
        .map((item) => String(item).trim())
        .filter(Boolean),
      individualPartyId: requiredText(
        raw.individualPartyId,
        "Individual Party ID",
        100
      ),
      evidenceIds: this.uniqueIds(raw.evidenceIds, "个人需求证据"),
      ...(["needs_research", "do_not_contact"].includes(
        String(raw.initialStatus)
      )
        ? { initialStatus: raw.initialStatus }
        : {})
    };
    const validStages = new Set([
      "awareness",
      "problem_defined",
      "solution_research",
      "comparison",
      "purchase_ready"
    ]);
    if (!validStages.has(input.buyingStage)) {
      fail("invalid_request", "个人购买阶段无效", 400);
    }
    return this.idempotent(
      scope,
      "create_individual_candidate",
      idempotencyKey,
      input,
      async () => {
        await this.validateEvidenceSet(
          scope,
          input.evidenceIds,
          "individual_signal"
        );
        const now = validIso(this.clock(), "候选创建时间");
        const candidate: AcquisitionCandidate = {
          id: this.idFactory("candidate"),
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          partyType: "individual",
          partyRef: {
            partyType: "individual",
            individualPartyId: input.individualPartyId,
            demandSignalId: input.demandSignalId
          },
          profile: {
            kind: "individual",
            publicActorKey: input.publicActorKey,
            publicDisplayName: input.publicDisplayName,
            publicProfileUrl: input.publicProfileUrl,
            sourcePlatform: input.sourcePlatform,
            demandCategory: input.demandCategory,
            demandSummary: input.demandSummary,
            locationHint: input.locationHint,
            buyingStage: input.buyingStage,
            negativeSignals: input.negativeSignals
          },
          evidenceIds: input.evidenceIds,
          status: input.initialStatus ?? "normalized",
          latestDecisionId: null,
          latestDecisionVersion: null,
          approvedDecisionVersion: null,
          hardGateFailures: input.initialStatus === "do_not_contact"
            ? ["do_not_contact"]
            : [],
          leadId: null,
          createdAt: now,
          updatedAt: now,
          version: 1
        };
        await this.repository.insertCandidate(candidate);
        await this.audit(scope, {
          candidateId: candidate.id,
          eventType: input.initialStatus
            ? `individual_candidate_${input.initialStatus}`
            : "individual_candidate_normalized",
          fromStatus: null,
          toStatus: input.initialStatus ?? "normalized",
          resourceId: candidate.id,
          idempotencyKey,
          payload: candidate
        });
        await beforeCommit?.(clone(candidate));
        return candidate;
      }
    );
  }

  async getCandidate(scope: AcquisitionActorScope, candidateId: string) {
    this.validateScope(scope);
    return this.requireCandidate(scope, candidateId);
  }

  async applyResolvedCandidateIdentity(
    scope: AcquisitionActorScope,
    candidateId: string,
    raw: CandidateIdentityResolutionCommitInput,
    idempotencyKey: string
  ): Promise<CandidateIdentityResolutionResult> {
    this.validateScope(scope);
    const input: CandidateIdentityResolutionCommitInput = {
      expectedCandidateVersion: raw.expectedCandidateVersion,
      evidenceIds: this.uniqueIds(raw.evidenceIds, "身份核验证据"),
      rationale: requiredText(raw.rationale, "身份核验说明", 2_000),
      basis: raw.basis,
      resolverVersion: requiredText(
        raw.resolverVersion,
        "身份解析器版本",
        100
      ),
      identityAliases: (raw.identityAliases ?? []).map((alias) => ({
        dedupeKey: requiredText(alias.dedupeKey, "身份去重键", 4_000),
        basis: alias.basis
      })),
      partyRef: clone(raw.partyRef),
      profile: clone(raw.profile)
    };
    if (!Number.isSafeInteger(input.expectedCandidateVersion)
      || input.expectedCandidateVersion < 1) {
      fail("invalid_request", "候选版本必须是正整数", 400);
    }
    if (![
      "organization_domain",
      "organization_credit_code",
      "provider_public_actor"
    ].includes(input.basis)) {
      fail("invalid_request", "身份解析依据无效", 400);
    }
    if (input.identityAliases.length === 0
      || input.identityAliases.some((alias) => ![
        "organization_domain",
        "organization_credit_code",
        "provider_public_actor"
      ].includes(alias.basis))) {
      fail("invalid_request", "身份别名无效", 400);
    }
    return this.idempotent(
      scope,
      "resolve_candidate_identity",
      idempotencyKey,
      { candidateId, ...input },
      async () => {
        let candidate = await this.requireCandidate(scope, candidateId);
        if (candidate.version !== input.expectedCandidateVersion) {
          fail("stale_candidate", "候选已更新，请刷新后重新核验身份");
        }
        if (candidate.status === "converted_to_lead") {
          fail("invalid_state", `状态 ${candidate.status} 不能核验身份`);
        }
        if (candidate.status === "needs_research") {
          fail(
            "invalid_state",
            "候选仍有研究流程，需先完成或终止研究任务再确认身份"
          );
        }
        const unresolved = candidate.partyRef.partyType === "organization"
          ? candidate.partyRef.organizationId.startsWith("unresolved-org-")
          : candidate.partyRef.individualPartyId.startsWith(
              "unresolved-individual-"
            );
        if (!unresolved) {
          fail("invalid_state", "候选主体身份已经解决，不能重新绑定");
        }
        if (candidate.partyType !== input.partyRef.partyType
          || candidate.profile.kind !== input.profile.kind
          || candidate.partyType !== input.profile.kind) {
          fail("invalid_request", "身份核验结果与候选主体类型不一致", 400);
        }
        if (input.partyRef.partyType === "organization") {
          if (input.partyRef.organizationId.startsWith("unresolved-org-")
            || input.profile.kind !== "organization"
            || input.basis === "provider_public_actor") {
            fail("invalid_request", "企业身份核验结果无效", 400);
          }
        } else if (
          input.partyRef.individualPartyId.startsWith(
            "unresolved-individual-"
          )
          || input.profile.kind !== "individual"
          || input.basis !== "provider_public_actor"
        ) {
          fail("invalid_request", "个人公开身份核验结果无效", 400);
        }
        const expectedTarget = candidate.partyType === "organization"
          ? "organization"
          : "individual_signal";
        for (const evidenceId of input.evidenceIds) {
          const evidence = await this.requireEvidence(scope, evidenceId);
          if (evidence.targetType !== expectedTarget
            || evidence.accessStatus === "access_restricted"
            || evidence.provenance.kind === "import_artifact_row") {
            fail(
              "evidence_required",
              "身份核验只能使用同主体的可访问公开来源",
              422
            );
          }
        }
        const fromStatus = candidate.status;
        const previousDecisionVersion = candidate.latestDecisionVersion;
        const resolvedAt = validIso(this.clock(), "身份核验时间");
        try {
          await this.repository.bindCandidateIdentityAliases(
            input.identityAliases.map((alias) => ({
              ownerId: scope.ownerId,
              teamId: scope.teamId,
              candidateId: candidate.id,
              partyType: candidate.partyType,
              basis: alias.basis,
              dedupeKey: alias.dedupeKey,
              createdAt: resolvedAt
            }))
          );
        } catch (error) {
          if (error instanceof Error
            && error.message === "CANDIDATE_IDENTITY_ALIAS_CONFLICT") {
            fail(
              "identity_conflict",
              "该公开身份已经绑定到其他候选，请人工合并"
            );
          }
          throw error;
        }
        candidate = this.updateCandidate(candidate, {
          partyRef: input.partyRef,
          profile: input.profile,
          evidenceIds: [
            ...new Set([...candidate.evidenceIds, ...input.evidenceIds])
          ],
          status: candidate.status === "do_not_contact"
            ? "do_not_contact"
            : candidate.status === "rejected"
              ? "rejected"
              : "normalized",
          latestDecisionId: null,
          latestDecisionVersion: null,
          approvedDecisionVersion: null,
          hardGateFailures: []
        });
        await this.repository.saveCandidate(candidate);
        const resolution: CandidateIdentityResolutionResult["resolution"] = {
          status: "resolved",
          basis: input.basis,
          resolverVersion: input.resolverVersion,
          evidenceIds: input.evidenceIds,
          resolvedAt,
          resolvedBy: scope.actorId
        };
        await this.audit(scope, {
          candidateId: candidate.id,
          eventType: "candidate_identity_resolved",
          fromStatus,
          toStatus: candidate.status,
          resourceId: candidate.id,
          idempotencyKey,
          payload: {
            resolution,
            rationale: input.rationale,
            dedupeKeyHashes: input.identityAliases.map((alias) =>
              hash(alias.dedupeKey)
            ),
            previousDecisionVersion,
            partyRef: candidate.partyRef
          }
        });
        return { candidate, resolution };
      }
    );
  }

  async attachEvidenceToCandidate(
    scope: AcquisitionActorScope,
    candidateId: string,
    evidenceId: string,
    idempotencyKey: string
  ) {
    this.validateScope(scope);
    const input = {
      candidateId: requiredText(candidateId, "候选 ID", 100),
      evidenceId: requiredText(evidenceId, "证据 ID", 255)
    };
    return this.idempotent(
      scope,
      "attach_candidate_evidence",
      idempotencyKey,
      input,
      async () => {
        let candidate = await this.requireCandidate(scope, input.candidateId);
        if (["unresolvable", "converted_to_lead"]
          .includes(candidate.status)) {
          fail("invalid_state", `状态 ${candidate.status} 不能原地追加证据`);
        }
        if (candidate.status === "needs_research") {
          fail(
            "invalid_state",
            "补充研究中的证据必须通过研究任务完成命令追加"
          );
        }
        const evidence = await this.requireEvidence(scope, input.evidenceId);
        const expectedTarget = candidate.partyType === "organization"
          ? "organization"
          : "individual_signal";
        if (evidence.targetType !== expectedTarget) {
          fail("evidence_required", "新增证据与候选主体类型不匹配", 422);
        }
        if (candidate.evidenceIds.includes(evidence.id)) {
          return candidate;
        }
        const fromStatus = candidate.status;
        const previousDecisionVersion = candidate.latestDecisionVersion;
        const keepRejectedState = candidate.status === "rejected";
        const keepSuppressedState = candidate.status === "do_not_contact";
        candidate = this.updateCandidate(candidate, {
          evidenceIds: [...candidate.evidenceIds, evidence.id],
          status: keepSuppressedState ? "do_not_contact"
            : keepRejectedState ? "rejected" : (
            candidate.status === "approved" ? "pending_review" : "normalized"
          ),
          latestDecisionId: keepRejectedState || keepSuppressedState
            ? candidate.latestDecisionId
            : null,
          latestDecisionVersion: keepRejectedState || keepSuppressedState
            ? candidate.latestDecisionVersion
            : null,
          approvedDecisionVersion: null,
          hardGateFailures: keepSuppressedState
            ? [...candidate.hardGateFailures]
            : []
        });
        await this.repository.saveCandidate(candidate);
        await this.audit(scope, {
          candidateId: candidate.id,
          eventType: fromStatus === "approved"
            ? "approval_invalidated_by_new_evidence"
            : "candidate_evidence_attached",
          fromStatus,
          toStatus: candidate.status,
          resourceId: evidence.id,
          idempotencyKey,
          payload: {
            evidenceId: evidence.id,
            previousDecisionVersion
          }
        });
        return candidate;
      }
    );
  }

  async mergeIndividualDemandSignal(
    scope: AcquisitionActorScope,
    candidateId: string,
    raw: IndividualDemandSignalMergeInput,
    idempotencyKey: string,
    beforeCommit?: (candidate: AcquisitionCandidate) => Promise<void>
  ) {
    this.validateScope(scope);
    const buyingStage = raw.buyingStage;
    if (!Object.hasOwn(BUYING_STAGE_RANK, buyingStage)) {
      fail("invalid_request", "个人购买阶段无效", 400);
    }
    if (!Array.isArray(raw.negativeSignals)) {
      fail("invalid_request", "负向信号必须是数组", 400);
    }
    const input: IndividualDemandSignalMergeInput = {
      evidenceId: requiredText(raw.evidenceId, "证据 ID", 255),
      demandSummary: requiredText(raw.demandSummary, "需求摘要", 2_000),
      buyingStage,
      negativeSignals: [...new Set(raw.negativeSignals
        .map((item) => String(item).trim())
        .filter(Boolean))]
    };
    const normalizedCandidateId = requiredText(candidateId, "候选 ID", 100);
    return this.idempotent(
      scope,
      "merge_individual_demand_signal",
      idempotencyKey,
      { candidateId: normalizedCandidateId, ...input },
      async () => {
        let candidate = await this.requireCandidate(scope, normalizedCandidateId);
        if (candidate.partyType !== "individual"
          || candidate.profile.kind !== "individual") {
          fail("invalid_request", "只能合并个人需求信号", 400);
        }
        if (["unresolvable", "do_not_contact", "converted_to_lead"]
          .includes(candidate.status)) {
          fail("invalid_state", `状态 ${candidate.status} 不能原地合并需求信号`);
        }
        if (candidate.status === "needs_research") {
          fail(
            "invalid_state",
            "补充研究中的需求信号必须通过研究任务完成命令追加"
          );
        }
        const evidence = await this.requireEvidence(scope, input.evidenceId);
        if (evidence.targetType !== "individual_signal") {
          fail("evidence_required", "新增证据与个人需求信号不匹配", 422);
        }

        const previousProfile = candidate.profile;
        const demandSummary = mergeDemandSummaries(
          previousProfile.demandSummary,
          input.demandSummary
        );
        const negativeSignals = [...new Set([
          ...previousProfile.negativeSignals,
          ...input.negativeSignals
        ])];
        const nextBuyingStage = BUYING_STAGE_RANK[input.buyingStage]
          > BUYING_STAGE_RANK[previousProfile.buyingStage]
          ? input.buyingStage
          : previousProfile.buyingStage;
        const evidenceIds = candidate.evidenceIds.includes(evidence.id)
          ? candidate.evidenceIds
          : [...candidate.evidenceIds, evidence.id];
        const unchanged = demandSummary === previousProfile.demandSummary
          && nextBuyingStage === previousProfile.buyingStage
          && negativeSignals.length === previousProfile.negativeSignals.length
          && negativeSignals.every((value, index) =>
            value === previousProfile.negativeSignals[index])
          && evidenceIds.length === candidate.evidenceIds.length;
        if (unchanged) return candidate;

        const fromStatus = candidate.status;
        const previousDecisionVersion = candidate.latestDecisionVersion;
        const keepRejectedState = candidate.status === "rejected";
        candidate = this.updateCandidate(candidate, {
          profile: {
            ...previousProfile,
            demandSummary,
            buyingStage: nextBuyingStage,
            negativeSignals
          },
          evidenceIds,
          status: keepRejectedState ? "rejected" : (
            candidate.status === "approved" ? "pending_review" : "normalized"
          ),
          latestDecisionId: keepRejectedState
            ? candidate.latestDecisionId
            : null,
          latestDecisionVersion: keepRejectedState
            ? candidate.latestDecisionVersion
            : null,
          approvedDecisionVersion: null,
          hardGateFailures: []
        });
        await this.repository.saveCandidate(candidate);
        await this.audit(scope, {
          candidateId: candidate.id,
          eventType: fromStatus === "approved"
            ? "approval_invalidated_by_new_evidence"
            : "individual_demand_signal_merged",
          fromStatus,
          toStatus: candidate.status,
          resourceId: evidence.id,
          idempotencyKey,
          payload: {
            evidenceId: evidence.id,
            previousDecisionVersion,
            previousBuyingStage: previousProfile.buyingStage,
            buyingStage: nextBuyingStage,
            addedNegativeSignals: input.negativeSignals.filter((signal) =>
              !previousProfile.negativeSignals.includes(signal))
          }
        });
        await beforeCommit?.(clone(candidate));
        return candidate;
      }
    );
  }

  async qualifyCandidate(
    scope: AcquisitionActorScope,
    candidateId: string,
    rawQualification: QualificationInput,
    rawFinancial: FinancialValueInput,
    idempotencyKey: string
  ) {
    this.validateScope(scope);
    const workspace = await this.resolveGrowthAcquisitionWorkspace(scope);
    if (!workspace || workspace.workspaceId === "all"
      || scope.teamId === "all") {
      throw new Error("growth_workspace_required");
    }
    const request = {
      candidateId: requiredText(candidateId, "候选 ID", 100),
      qualification: rawQualification,
      financial: rawFinancial
    };
    const qualificationInputHash = hash(request) as `sha256:${string}`;
    return this.idempotent(
      scope,
      "qualify_candidate",
      idempotencyKey,
      request,
      async () => {
        let candidate = await this.requireCandidate(scope, request.candidateId);
        if (["unresolvable", "rejected", "do_not_contact", "converted_to_lead"]
          .includes(candidate.status)) {
          fail("invalid_state", `状态 ${candidate.status} 不能评分`);
        }
        const evidence = await Promise.all(
          candidate.evidenceIds.map((id) => this.requireEvidence(scope, id))
        );
        const previous = await this.repository.listQualificationDecisions(
          scope,
          candidate.id
        );
        const decision = this.buildQualificationDecision(
          scope,
          candidate,
          evidence,
          rawQualification,
          previous.length + 1
        );
        const financial = this.buildFinancialValueDecision(
          scope,
          candidate,
          decision,
          rawFinancial,
          previous.length + 1
        );
        const before = candidate.status;
        const qualified = this.updateCandidate(candidate, {
          status: "qualified",
          latestDecisionId: decision.id,
          latestDecisionVersion: decision.decisionVersion,
          approvedDecisionVersion: null,
          hardGateFailures: decision.hardGateFailures
        });
        const pendingReview = this.updateCandidate(qualified, {
          status: "pending_review"
        });
        const auditEvents = [
          this.buildAuditEvent(scope, {
            candidateId: candidate.id,
            eventType: "qualification_decision_appended",
            fromStatus: before,
            toStatus: "qualified",
            resourceId: decision.id,
            idempotencyKey,
            payload: decision
          }),
          this.buildAuditEvent(scope, {
            candidateId: candidate.id,
            eventType: "candidate_sent_to_human_review",
            fromStatus: "qualified",
            toStatus: "pending_review",
            resourceId: decision.id,
            idempotencyKey,
            payload: {
              decisionVersion: decision.decisionVersion,
              financialValueId: financial.id
            }
          })
        ];
        const bundle = await this.repository.commitQualificationBundle({
          workspace: {
            workspaceId: workspace.workspaceId,
            workspaceBindingRevision: workspace.bindingRevision
          },
          candidate: pendingReview,
          qualification: decision,
          financialValue: financial,
          auditEvents,
          authority: {
            workspaceId: workspace.workspaceId,
            workspaceBindingRevision: workspace.bindingRevision,
            candidateId: candidate.id,
            ownerId: scope.ownerId,
            teamId: scope.teamId,
            qualificationDecisionId: decision.id,
            qualificationDecisionVersion: decision.decisionVersion,
            qualificationSnapshotHash: decision.snapshotHash,
            financialValueDecisionId: financial.id,
            financialValueDecisionVersion: financial.version,
            financialValueInputSnapshotHash: financial.inputSnapshotHash,
            grade: decision.grade,
            score: decision.score,
            evidence: Object.freeze(evidence.map((item) => Object.freeze({
              evidenceId: item.id,
              contentHash: item.contentHash,
              fetchedAt: item.fetchedAt
            })))
          }
        });
        return {
          candidate: bundle.candidate,
          qualification: bundle.qualification,
          financialValue: bundle.financialValue,
          probabilityAssessmentSource: {
            closeProbabilityBps: rawFinancial.closeProbabilityBps,
            qualificationDecisionId: bundle.qualification.id,
            qualificationDecisionVersion:
              bundle.qualification.decisionVersion,
            qualificationInputHash,
            evidenceRefs: bundle.qualification.evidence.map(
              (item) => item.evidenceId
            ),
            ruleVersion: bundle.qualification.ruleVersion,
            modelSnapshotRef: bundle.qualification.decisionEngine === "model"
              ? hash({
                  modelProvider: bundle.qualification.modelProvider,
                  model: bundle.qualification.model,
                  promptVersion: bundle.qualification.promptVersion
                })
              : null,
            assessedAt: bundle.qualification.createdAt
          }
        };
      }
    );
  }

  async listQualificationDecisions(
    scope: AcquisitionActorScope,
    candidateId: string
  ) {
    await this.requireCandidate(scope, candidateId);
    return this.repository.listQualificationDecisions(scope, candidateId);
  }

  async getQualificationDecision(
    scope: AcquisitionActorScope,
    candidateId: string,
    decisionId: string
  ) {
    await this.requireCandidate(scope, candidateId);
    const result = await this.repository.findQualificationDecision(
      scope,
      candidateId,
      decisionId
    );
    if (!result) fail("resource_not_found", "资格决定不存在", 404);
    return result;
  }

  async listFinancialValueDecisions(
    scope: AcquisitionActorScope,
    candidateId: string
  ) {
    await this.requireCandidate(scope, candidateId);
    return this.repository.listFinancialValues(scope, candidateId);
  }

  async getCurrentFinancialValueDecision(
    scope: AcquisitionActorScope,
    candidateId: string
  ): Promise<FinancialValueDecision> {
    const candidate = await this.requireCandidate(scope, candidateId);
    if (!candidate.latestDecisionId) {
      fail("resource_not_found", "候选当前没有财务价值决定", 404);
    }
    const values = await this.repository.listFinancialValues(
      scope,
      candidateId
    );
    const current = values
      .filter((value) =>
        value.qualificationDecisionId === candidate.latestDecisionId)
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id))
      .at(-1);
    if (!current) {
      fail("resource_not_found", "候选当前没有财务价值决定", 404);
    }
    return current;
  }

  async createBattleCard(
    scope: AcquisitionActorScope,
    candidateId: string,
    raw: BattleCardInput,
    idempotencyKey: string
  ) {
    this.validateScope(scope);
    const request = { candidateId, ...raw };
    return this.idempotent(
      scope,
      "create_battle_card",
      idempotencyKey,
      request,
      async () => {
        const candidate = await this.requireCandidate(scope, candidateId);
        if (!candidate.latestDecisionId
          || !["pending_review", "approved"].includes(candidate.status)) {
          fail("invalid_state", "客户作战卡只能基于已评分候选生成");
        }
        const existing = await this.repository.listBattleCards(
          scope,
          candidate.id
        );
        type StoredFields =
          "id" | "ownerId" | "teamId" | "version"
          | "snapshotHash" | "createdAt";
        let material:
          | Omit<BattleCardV1, StoredFields>
          | Omit<BattleCardV2, StoredFields>;
        if (raw.schemaVersion === "battle-card.v2") {
          const input = raw.intelligence;
          const intelligence: Omit<
            BattleCardIntelligenceV2,
            "financialSummary"
          > = {
            accountOverview: input.accountOverview.map((claim, index) =>
              battleCardClaim(claim, `客户概况 ${index + 1}`)),
            needAssessment: input.needAssessment.map((claim, index) =>
              battleCardClaim(claim, `需求判断 ${index + 1}`)),
            supplierHypotheses: input.supplierHypotheses.map(
              (claim, index) =>
                battleCardClaim(claim, `供应商判断 ${index + 1}`)
            ),
            buyingCommittee: input.buyingCommittee.map((role, index) => {
              if (![1, 2, 3].includes(role.priority)
                || ![
                  "decision_maker",
                  "influencer",
                  "user",
                  "gatekeeper"
                ].includes(role.influence)) {
                fail("invalid_request", "决策链角色类型或优先级无效", 400);
              }
              return {
                role: requiredText(
                  role.role,
                  `决策链角色 ${index + 1}`,
                  200
                ),
                priority: role.priority,
                influence: role.influence,
                concerns: [...new Set(role.concerns.map((concern) =>
                  requiredText(concern, "决策角色关注点", 500)
                ))],
                claim: battleCardClaim(
                  role.claim,
                  `决策链依据 ${index + 1}`
                )
              };
            }),
            procurementPreferences: input.procurementPreferences.map(
              (claim, index) =>
                battleCardClaim(claim, `采购偏好 ${index + 1}`)
            ),
            connectionStrategies: input.connectionStrategies.map(
              (strategy, index) => {
                if (![
                  "public_reply",
                  "wecom",
                  "phone",
                  "email",
                  "referral"
                ].includes(strategy.channel)) {
                  fail("invalid_request", "连接策略渠道无效", 400);
                }
                return {
                  channel: strategy.channel,
                  targetRole: requiredText(
                    strategy.targetRole,
                    `连接策略目标角色 ${index + 1}`,
                    200
                  ),
                  rationale: battleCardClaim(
                    strategy.rationale,
                    `连接策略依据 ${index + 1}`
                  ),
                  openingDraft: requiredText(
                    strategy.openingDraft,
                    `连接策略开场 ${index + 1}`,
                    8_000
                  )
                };
              }
            ),
            roleSpecificOpeners: input.roleSpecificOpeners.map(
              (opener, index) => {
                if (![
                  "public_reply",
                  "wecom",
                  "phone",
                  "email",
                  "referral"
                ].includes(opener.channel)) {
                  fail("invalid_request", "角色话术渠道无效", 400);
                }
                return {
                  role: requiredText(
                    opener.role,
                    `角色话术角色 ${index + 1}`,
                    200
                  ),
                  channel: opener.channel,
                  text: requiredText(
                    opener.text,
                    `角色话术内容 ${index + 1}`,
                    8_000
                  )
                };
              }
            ),
            doNotActions: [...new Set(input.doNotActions.map((action) =>
              requiredText(action, "不建议动作", 1_000)
            ))]
          };
          const values = await this.repository.listFinancialValues(
            scope,
            candidate.id
          );
          const financial = values
            .filter((value) =>
              value.qualificationDecisionId === candidate.latestDecisionId)
            .sort((left, right) =>
              left.createdAt.localeCompare(right.createdAt)
              || left.id.localeCompare(right.id))
            .at(-1) ?? null;
          const completeIntelligence: BattleCardIntelligenceV2 = {
            ...intelligence,
            financialSummary: financial ? financialSummary(financial) : null
          };
          const evidenceIds = [...new Set(
            v2Claims(completeIntelligence).flatMap((claim) =>
              claim.evidenceIds)
          )];
          material = {
            candidateId: candidate.id,
            qualificationDecisionId: candidate.latestDecisionId,
            partyType: candidate.partyType,
            schemaVersion: "battle-card.v2",
            intelligence: completeIntelligence,
            evidenceIds,
            confidence: bounded(raw.confidence, 0, 1),
            modelProvider: requiredText(
              raw.modelProvider,
              "模型厂商",
              100
            ),
            model: requiredText(raw.model, "模型", 200),
            promptVersion: requiredText(
              raw.promptVersion,
              "Prompt 版本",
              100
            )
          };
        } else {
          if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
            fail("invalid_request", "客户作战卡至少需要一个分区", 400);
          }
          const sections = raw.sections.map((section) => ({
            label: requiredText(section.label, "作战卡标签", 120),
            kind: section.kind,
            content: requiredText(section.content, "作战卡内容", 4_000),
            evidenceIds: [...new Set(section.evidenceIds ?? [])],
            confidence: section.confidence === null
              ? null
              : bounded(section.confidence, 0, 1)
          }));
          for (const section of sections) {
            if (!["fact", "inference", "unknown"].includes(section.kind)) {
              fail("invalid_request", "作战卡分区类型无效", 400);
            }
            if ((section.kind === "fact" || section.kind === "inference")
              && section.evidenceIds.length === 0) {
              fail(
                "evidence_required",
                `${section.kind} 分区必须引用原始证据`,
                422
              );
            }
            if (section.kind === "inference"
              && section.confidence === null) {
              fail("invalid_request", "推断分区必须提供置信度", 422);
            }
          }
          material = {
            candidateId: candidate.id,
            qualificationDecisionId: candidate.latestDecisionId,
            partyType: candidate.partyType,
            sections,
            evidenceIds: [...new Set(
              sections.flatMap((section) => section.evidenceIds)
            )],
            confidence: bounded(raw.confidence, 0, 1),
            modelProvider: requiredText(
              raw.modelProvider,
              "模型厂商",
              100
            ),
            model: requiredText(raw.model, "模型", 200),
            promptVersion: requiredText(
              raw.promptVersion,
              "Prompt 版本",
              100
            )
          };
        }
        const evidenceIds = material.evidenceIds;
        if (evidenceIds.length === 0) {
          fail("evidence_required", "客户作战卡必须至少引用一条证据", 422);
        }
        for (const evidenceId of evidenceIds) {
          if (!candidate.evidenceIds.includes(evidenceId)) {
            fail("evidence_required", "作战卡引用了候选之外的证据", 422);
          }
          await this.requireEvidence(scope, evidenceId);
        }
        const now = validIso(this.clock(), "作战卡创建时间");
        const storedBase = {
          id: this.idFactory("battle-card"),
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          version: `battle-card-v${existing.length + 1}`,
          snapshotHash: hash(material),
          createdAt: now
        };
        const card: BattleCard = material.schemaVersion === "battle-card.v2"
          ? { ...storedBase, ...material }
          : { ...storedBase, ...material };
        await this.repository.appendBattleCard(card);
        await this.audit(scope, {
          candidateId: candidate.id,
          eventType: "battle_card_appended",
          fromStatus: candidate.status,
          toStatus: candidate.status,
          resourceId: card.id,
          idempotencyKey,
          payload: card
        });
        return card;
      }
    );
  }

  async listBattleCards(
    scope: AcquisitionActorScope,
    candidateId: string
  ) {
    await this.requireCandidate(scope, candidateId);
    return this.repository.listBattleCards(scope, candidateId);
  }

  async reviewCandidate(
    scope: AcquisitionActorScope,
    candidateId: string,
    raw: {
      action: ReviewAction;
      decisionVersion: string;
      reason: string | null;
      idempotencyKey: string;
    }
  ) {
    this.validateScope(scope);
    const input = {
      candidateId: requiredText(candidateId, "候选 ID", 100),
      action: raw.action,
      decisionVersion: requiredText(
        raw.decisionVersion,
        "资格决定版本",
        100
      ),
      reason: optionalText(raw.reason, "审核原因", 2_000)
    };
    return this.idempotent(
      scope,
      "review_candidate",
      raw.idempotencyKey,
      input,
      async () => {
        let candidate = await this.requireCandidate(scope, input.candidateId);
        this.assertCurrentDecision(candidate, input.decisionVersion);
        this.validateReviewTransition(candidate, input.action, input.reason);
        if (input.action === "approved"
          && candidate.hardGateFailures.length > 0) {
          fail(
            "hard_gate_blocked",
            `硬门禁未通过：${candidate.hardGateFailures
              .map((item) => HARD_GATE_LABELS[item]).join("、")}`
          );
        }
        if (input.action === "reopen") {
          const reviews = await this.repository.listReviewEvents(
            scope,
            candidate.id
          );
          const latestRejected = [...reviews].reverse()
            .find((item) => item.action === "rejected");
          const evidence = await Promise.all(
            candidate.evidenceIds.map((id) => this.requireEvidence(scope, id))
          );
          if (!latestRejected || !evidence.some(
            (item) => item.fetchedAt > latestRejected.createdAt
          )) {
            fail("invalid_state", "驳回候选只有在新增证据后才能重开");
          }
        }
        const now = validIso(this.clock(), "审核时间");
        const review: ReviewEvent = {
          id: this.idFactory("review"),
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          candidateId: candidate.id,
          decisionVersion: input.decisionVersion,
          action: input.action,
          reason: input.reason,
          reviewerId: scope.actorId,
          idempotencyKey: raw.idempotencyKey,
          createdAt: now
        };
        await this.repository.appendReviewEvent(review);

        const fromStatus = candidate.status;
        let research: ResearchAttempt | null = null;
        if (input.action === "approved") {
          candidate = this.updateCandidate(candidate, {
            status: "approved",
            approvedDecisionVersion: input.decisionVersion
          });
        } else if (input.action === "rejected") {
          candidate = this.updateCandidate(candidate, {
            status: "rejected",
            approvedDecisionVersion: null
          });
        } else if (input.action === "do_not_contact") {
          const hardGateFailures: HardGateFailure[] = [
            ...candidate.hardGateFailures
          ];
          if (!hardGateFailures.includes("do_not_contact")) {
            hardGateFailures.push("do_not_contact");
          }
          candidate = this.updateCandidate(candidate, {
            status: "do_not_contact",
            approvedDecisionVersion: null,
            hardGateFailures
          });
        } else if (input.action === "needs_research") {
          candidate = this.updateCandidate(candidate, {
            status: "needs_research",
            approvedDecisionVersion: null
          });
          const priorResearch = (await this.repository.listAuditEvents(
            scope,
            candidate.id
          )).filter((event) => event.eventType === "research_requested");
          research = {
            id: this.idFactory("research"),
            ownerId: scope.ownerId,
            teamId: scope.teamId,
            candidateId: candidate.id,
            requestedBy: scope.actorId,
            requestReason: input.reason!,
            budgetVersion: `research-budget-v${priorResearch.length + 1}`,
            status: "pending",
            newEvidenceIds: [],
            terminationReason: null,
            createdAt: now,
            startedAt: null,
            completedAt: null
          };
          await this.repository.appendResearchAttempt(research);
        } else {
          candidate = this.updateCandidate(candidate, {
            status: "normalized",
            approvedDecisionVersion: null
          });
        }
        await this.repository.saveCandidate(candidate);
        await this.audit(scope, {
          candidateId: candidate.id,
          eventType: input.action === "needs_research"
            ? "research_requested"
            : `candidate_${input.action}`,
          fromStatus,
          toStatus: candidate.status,
          resourceId: review.id,
          idempotencyKey: raw.idempotencyKey,
          payload: { review, research }
        });
        return { candidate, review, research };
      }
    );
  }

  async listReviewEvents(
    scope: AcquisitionActorScope,
    candidateId: string
  ) {
    await this.requireCandidate(scope, candidateId);
    return this.repository.listReviewEvents(scope, candidateId);
  }

  async startResearch(
    scope: AcquisitionActorScope,
    candidateId: string,
    researchId: string,
    idempotencyKey: string
  ) {
    this.validateScope(scope);
    return this.idempotent(
      scope,
      "start_research",
      idempotencyKey,
      { candidateId, researchId },
      async () => {
        const candidate = await this.requireCandidate(scope, candidateId);
        if (candidate.status !== "needs_research") {
          fail("invalid_state", "候选当前不处于补充研究状态");
        }
        const research = await this.requireResearch(
          scope,
          candidateId,
          researchId
        );
        if (research.status !== "pending") {
          fail("invalid_state", "只有待开始研究可以进入运行态");
        }
        const updated: ResearchAttempt = {
          ...research,
          status: "running",
          startedAt: validIso(this.clock(), "研究开始时间")
        };
        await this.repository.saveResearchAttempt(updated);
        await this.audit(scope, {
          candidateId,
          eventType: "research_started",
          fromStatus: candidate.status,
          toStatus: candidate.status,
          resourceId: researchId,
          idempotencyKey,
          payload: updated
        });
        return updated;
      }
    );
  }

  async completeResearch(
    scope: AcquisitionActorScope,
    candidateId: string,
    researchId: string,
    raw: {
      result:
        | "completed"
        | "no_new_evidence"
        | "access_restricted"
        | "failed";
      newEvidenceIds: string[];
      terminationReason: string | null;
    },
    idempotencyKey: string
  ) {
    this.validateScope(scope);
    return this.idempotent(
      scope,
      "complete_research",
      idempotencyKey,
      { candidateId, researchId, ...raw },
      async () => {
        let candidate = await this.requireCandidate(scope, candidateId);
        const research = await this.requireResearch(
          scope,
          candidateId,
          researchId
        );
        if (candidate.status !== "needs_research"
          || research.status !== "running") {
          fail("invalid_state", "只有运行中的补充研究可以完成");
        }
        if (!TERMINAL_RESEARCH_RESULTS.has(raw.result)) {
          fail("invalid_request", "研究终态无效", 400);
        }
        const evidenceIds = [...new Set(raw.newEvidenceIds ?? [])];
        if (raw.result === "completed" && evidenceIds.length === 0) {
          fail("evidence_required", "成功研究必须追加至少一条新证据", 422);
        }
        if (raw.result !== "completed" && !raw.terminationReason?.trim()) {
          fail("invalid_request", "未获得新证据时必须记录终止原因", 400);
        }
        for (const evidenceId of evidenceIds) {
          const evidence = await this.requireEvidence(scope, evidenceId);
          const expectedTarget = candidate.partyType === "organization"
            ? "organization"
            : "individual_signal";
          if (evidence.targetType !== expectedTarget) {
            fail("evidence_required", "研究证据与候选主体类型不匹配", 422);
          }
        }
        const completedAt = validIso(this.clock(), "研究完成时间");
        const updatedResearch: ResearchAttempt = {
          ...research,
          status: raw.result,
          newEvidenceIds: evidenceIds,
          terminationReason: raw.terminationReason?.trim() || null,
          completedAt
        };
        await this.repository.saveResearchAttempt(updatedResearch);
        const fromStatus = candidate.status;
        candidate = this.updateCandidate(candidate, {
          status: raw.result === "completed" ? "normalized" : "pending_review",
          evidenceIds: raw.result === "completed"
            ? [...new Set([...candidate.evidenceIds, ...evidenceIds])]
            : candidate.evidenceIds,
          approvedDecisionVersion: null
        });
        await this.repository.saveCandidate(candidate);
        await this.audit(scope, {
          candidateId,
          eventType: `research_${raw.result}`,
          fromStatus,
          toStatus: candidate.status,
          resourceId: researchId,
          idempotencyKey,
          payload: updatedResearch
        });
        return { candidate, research: updatedResearch };
      }
    );
  }

  async convertCandidate(
    scope: AcquisitionActorScope,
    candidateId: string,
    raw: {
      decisionVersion: string;
      idempotencyKey: string;
    }
  ) {
    this.validateScope(scope);
    const input = {
      candidateId: requiredText(candidateId, "候选 ID", 100),
      decisionVersion: requiredText(
        raw.decisionVersion,
        "资格决定版本",
        100
      )
    };
    const idempotencyKey = requiredText(
      raw.idempotencyKey,
      "Idempotency-Key",
      200
    );
    const flightKey = [
      scope.ownerId,
      scope.teamId,
      input.candidateId,
      idempotencyFingerprint(idempotencyKey)
    ].join("\u0000");
    const running = this.inFlightConversions.get(flightKey);
    if (running) return clone(await running);
    const operation = this.convertCandidateWithIntent(
      scope,
      input,
      idempotencyKey
    );
    this.inFlightConversions.set(flightKey, operation);
    try {
      return clone(await operation);
    } finally {
      if (this.inFlightConversions.get(flightKey) === operation) {
        this.inFlightConversions.delete(flightKey);
      }
    }
  }

  async reconcilePendingLeadConversions(limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      fail("invalid_request", "转换恢复批次数必须在 1 到 500 之间", 400);
    }
    const intents = await this.repository.listRecoverableConversionIntents(
      limit
    );
    let completed = 0;
    let failed = 0;
    for (const intent of intents) {
      const scope: AcquisitionActorScope = {
        ownerId: intent.ownerId,
        teamId: intent.teamId,
        actorId: intent.reviewerId
      };
      const flightKey = [
        intent.ownerId,
        intent.teamId,
        intent.candidateId,
        idempotencyFingerprint(intent.idempotencyKey)
      ].join("\u0000");
      const running = this.inFlightConversions.get(flightKey);
      const operation = running ?? this.resumeConversionIntent(scope, intent);
      if (!running) this.inFlightConversions.set(flightKey, operation);
      try {
        await operation;
        completed += 1;
      } catch {
        failed += 1;
      } finally {
        if (!running && this.inFlightConversions.get(flightKey) === operation) {
          this.inFlightConversions.delete(flightKey);
        }
      }
    }
    return {
      inspected: intents.length,
      completed,
      failed
    };
  }

  private async convertCandidateWithIntent(
    scope: AcquisitionActorScope,
    input: { candidateId: string; decisionVersion: string },
    idempotencyKey: string
  ) {
    const prepared = await this.prepareConversionIntent(
      scope,
      input,
      idempotencyKey
    );
    if (!("status" in prepared)) return prepared;
    return this.resumeConversionIntent(scope, prepared);
  }

  private async prepareConversionIntent(
    scope: AcquisitionActorScope,
    input: { candidateId: string; decisionVersion: string },
    idempotencyKey: string
  ): Promise<LeadConversionIntent | LeadConversionRecord> {
    const requestHash = hash(input);
    try {
      return await this.repository.transaction(async () => {
        const committedIdempotency = await this.repository.findIdempotency(
          scope,
          "convert_candidate",
          idempotencyKey
        );
        if (committedIdempotency) {
          if (committedIdempotency.requestHash !== requestHash) {
            fail(
              "idempotency_conflict",
              "同一 Idempotency-Key 已用于不同转换请求"
            );
          }
          const conversion = await this.repository.findConversion(
            scope,
            input.candidateId
          );
          if (!conversion
            || idempotencyFingerprint(conversion.idempotencyKey)
              !== idempotencyFingerprint(idempotencyKey)
            || conversion.decisionVersion !== input.decisionVersion) {
            fail(
              "conversion_failed",
              "转换幂等记录存在但领域转换尚未完整提交",
              502
            );
          }
          return conversion;
        }

        const existing = await this.repository.findConversionIntent(
          scope,
          input.candidateId
        );
        if (existing) {
          if (idempotencyFingerprint(existing.idempotencyKey)
              !== idempotencyFingerprint(idempotencyKey)
            || existing.decisionVersion !== input.decisionVersion) {
            fail(
              "idempotency_conflict",
              "该候选已有使用其他参数的转换意图"
            );
          }
          return existing;
        }

        const candidate = await this.requireCandidate(
          scope,
          input.candidateId
        );
        if (candidate.status !== "approved") {
          fail("invalid_state", "只有人工批准的候选可以转换为 CRM 线索");
        }
        if (candidate.approvedDecisionVersion !== input.decisionVersion
          || candidate.latestDecisionVersion !== input.decisionVersion) {
          fail("stale_decision", "审核批准的资格决定版本已失效");
        }
        if (candidate.hardGateFailures.length > 0) {
          fail("hard_gate_blocked", "硬门禁未通过，禁止转换");
        }
        const now = validIso(this.clock(), "转换意图创建时间");
        const intent: LeadConversionIntent = {
          id: this.idFactory("conversion-intent"),
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          candidateId: candidate.id,
          decisionVersion: input.decisionVersion,
          partyRef: clone(candidate.partyRef),
          reviewerId: scope.actorId,
          idempotencyKey,
          evidenceIds: [...candidate.evidenceIds],
          evidenceSnapshotHash: hash({
            candidateId: candidate.id,
            evidenceIds: candidate.evidenceIds,
            decisionVersion: input.decisionVersion
          }),
          status: "pending_crm",
          leadId: null,
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null
        };
        await this.repository.appendConversionIntent(intent);
        await this.audit(scope, {
          candidateId: candidate.id,
          eventType: "candidate_conversion_requested",
          fromStatus: candidate.status,
          toStatus: candidate.status,
          resourceId: intent.id,
          idempotencyKey,
          payload: {
            intentId: intent.id,
            decisionVersion: intent.decisionVersion,
            evidenceSnapshotHash: intent.evidenceSnapshotHash
          }
        });
        return intent;
      });
    } catch (error) {
      const existing = await this.repository.findConversionIntent(
        scope,
        input.candidateId
      );
      if (existing
        && idempotencyFingerprint(existing.idempotencyKey)
          === idempotencyFingerprint(idempotencyKey)
        && existing.decisionVersion === input.decisionVersion) {
        return existing;
      }
      throw error;
    }
  }

  private async resumeConversionIntent(
    scope: AcquisitionActorScope,
    prepared: LeadConversionIntent
  ): Promise<LeadConversionRecord> {
    let intent = await this.repository.findConversionIntent(
      scope,
      prepared.candidateId
    );
    if (!intent || intent.id !== prepared.id) {
      fail("conversion_failed", "转换意图不存在或租户范围不匹配", 502);
    }
    if (intent.status === "completed") {
      const completed = await this.repository.findConversion(
        scope,
        intent.candidateId
      );
      if (!completed || completed.leadId !== intent.leadId) {
        fail("conversion_failed", "转换意图已完成但转换记录不完整", 502);
      }
      return completed;
    }

    if (intent.status === "pending_crm") {
      const attemptAt = validIso(this.clock(), "CRM 转换尝试时间");
      let created: Awaited<ReturnType<LeadConversionPort["createLead"]>>;
      try {
        created = await this.leadConversionPort.createLead({
          ownerId: intent.ownerId,
          teamId: intent.teamId,
          actorId: intent.reviewerId,
          candidateId: intent.candidateId,
          partyRef: clone(intent.partyRef),
          decisionVersion: intent.decisionVersion,
          evidenceIds: [...intent.evidenceIds],
          idempotencyKey: intent.idempotencyKey
        });
        if (hash(created.partyRef) !== hash(intent.partyRef)) {
          throw new Error("CRM_PARTY_REF_MISMATCH");
        }
      } catch {
        try {
          await this.repository.transaction(async () => {
            const current = await this.repository.findConversionIntent(
              scope,
              intent!.candidateId
            );
            if (!current || current.status !== "pending_crm") return;
            await this.repository.saveConversionIntent({
              ...current,
              attemptCount: current.attemptCount + 1,
              lastAttemptAt: attemptAt,
              lastError: "CRM 线索转换失败",
              updatedAt: attemptAt
            });
          });
        } catch {
          // The durable pending intent remains recoverable even if telemetry
          // about this failed attempt cannot be persisted.
        }
        fail("conversion_failed", "CRM 线索转换失败", 502);
      }
      const leadId = requiredText(created.leadId, "CRM Lead ID", 100);
      try {
        intent = await this.repository.transaction(async () => {
          const current = await this.repository.findConversionIntent(
            scope,
            intent!.candidateId
          );
          if (!current) {
            fail("conversion_failed", "CRM 成功后转换意图丢失", 502);
          }
          if (current.status === "completed") return current;
          if (current.status === "crm_committed") {
            if (current.leadId !== leadId) {
              fail("conversion_failed", "CRM Lead ID 与已提交意图不一致", 502);
            }
            return current;
          }
          const committed: LeadConversionIntent = {
            ...current,
            status: "crm_committed",
            leadId,
            attemptCount: current.attemptCount + 1,
            lastAttemptAt: attemptAt,
            lastError: null,
            updatedAt: attemptAt
          };
          await this.repository.saveConversionIntent(committed);
          return committed;
        });
      } catch (error) {
        if (error instanceof AcquisitionDomainError) throw error;
        fail(
          "conversion_failed",
          "CRM 已创建线索，但转换意图提交失败；可安全重放恢复",
          502
        );
      }
    }

    try {
      return await this.finalizeConversionIntent(scope, intent);
    } catch (error) {
      if (error instanceof AcquisitionDomainError) throw error;
      fail(
        "conversion_failed",
        "CRM 已创建线索，但领域转换尚未完成；可安全重放恢复",
        502
      );
    }
  }

  private async finalizeConversionIntent(
    scope: AcquisitionActorScope,
    prepared: LeadConversionIntent
  ) {
    return this.repository.transaction(async () => {
      let intent = await this.repository.findConversionIntent(
        scope,
        prepared.candidateId
      );
      if (!intent || intent.id !== prepared.id) {
        fail("conversion_failed", "待完成的转换意图不存在", 502);
      }
      const existing = await this.repository.findConversion(
        scope,
        intent.candidateId
      );
      if (intent.status === "completed") {
        if (!existing || existing.leadId !== intent.leadId) {
          fail("conversion_failed", "已完成转换缺少一致的转换记录", 502);
        }
        return existing;
      }
      if (intent.status !== "crm_committed" || !intent.leadId) {
        fail("conversion_failed", "CRM 尚未提交，不能完成领域转换", 502);
      }

      const candidate = await this.requireCandidate(scope, intent.candidateId);
      let record = existing;
      const now = validIso(this.clock(), "转换完成时间");
      if (record) {
        if (record.leadId !== intent.leadId
          || record.decisionVersion !== intent.decisionVersion
          || hash(record.partyRef) !== hash(intent.partyRef)) {
          fail("conversion_failed", "已有转换记录与转换意图不一致", 502);
        }
      } else {
        record = {
          id: this.idFactory("conversion"),
          ownerId: intent.ownerId,
          teamId: intent.teamId,
          candidateId: intent.candidateId,
          decisionVersion: intent.decisionVersion,
          partyRef: clone(intent.partyRef),
          leadId: intent.leadId,
          reviewerId: intent.reviewerId,
          idempotencyKey: intent.idempotencyKey,
          evidenceSnapshotHash: intent.evidenceSnapshotHash,
          createdAt: now
        };
        await this.repository.appendConversion(record);
      }

      const fromStatus = candidate.status;
      if (candidate.status !== "converted_to_lead"
        || candidate.leadId !== record.leadId) {
        const converted = this.updateCandidate(candidate, {
          status: "converted_to_lead",
          leadId: record.leadId
        });
        await this.repository.saveCandidate(converted);
      }
      const audits = await this.repository.listAuditEvents(
        scope,
        candidate.id
      );
      if (!audits.some((event) =>
        event.eventType === "candidate_converted_to_lead"
        && event.resourceId === record!.id
      )) {
        await this.audit(scope, {
          candidateId: candidate.id,
          eventType: "candidate_converted_to_lead",
          fromStatus,
          toStatus: "converted_to_lead",
          resourceId: record.id,
          idempotencyKey: intent.idempotencyKey,
          payload: record
        });
      }
      intent = {
        ...intent,
        status: "completed",
        lastError: null,
        updatedAt: now,
        completedAt: now
      };
      await this.repository.saveConversionIntent(intent);
      const request = {
        candidateId: intent.candidateId,
        decisionVersion: intent.decisionVersion
      };
      const committedIdempotency = await this.repository.findIdempotency(
        scope,
        "convert_candidate",
        intent.idempotencyKey
      );
      if (!committedIdempotency) {
        await this.repository.appendIdempotency({
          ownerId: intent.ownerId,
          teamId: intent.teamId,
          operation: "convert_candidate",
          idempotencyKey: intent.idempotencyKey,
          requestHash: hash(request),
          result: clone(record),
          createdAt: now
        });
      } else if (committedIdempotency.requestHash !== hash(request)) {
        fail(
          "idempotency_conflict",
          "转换完成时发现 Idempotency-Key 请求摘要冲突"
        );
      }
      return record;
    });
  }

  async recordOutcome(
    scope: AcquisitionActorScope,
    raw: OutcomeInput,
    authority?: AcquisitionOutcomeWriteAuthority
  ) {
    this.validateScope(scope);
    if (COMMERCIAL_OUTCOMES.has(
      raw.eventType as "quoted" | "won" | "lost"
    ) && (authority?.capability
      !== "acquisition.outcome.reconcile.internal"
      || !authority.sourceStableKey.trim())) {
      fail(
        "capability_forbidden",
        "商业结果只能由 CRM Reconciler 写入",
        403
      );
    }
    validateOutcomeAttribution(raw.attribution);
    return this.idempotent(
      scope,
      "record_outcome",
      raw.idempotencyKey,
      raw,
      async () => {
        const candidate = await this.requireCandidate(scope, raw.candidateId);
        if (candidate.status !== "converted_to_lead") {
          fail("invalid_state", "只有已转换候选可以记录正式结果反馈");
        }
        if (raw.leadId && raw.leadId !== candidate.leadId) {
          fail("invalid_request", "结果反馈 Lead ID 与候选转换记录不一致", 400);
        }
        const decision = await this.repository.findQualificationDecision(
          scope,
          candidate.id,
          raw.attribution.qualificationDecisionId
        );
        if (!decision
          || decision.decisionVersion !== raw.attribution.decisionVersion
          || decision.snapshotHash !== raw.attribution.decisionSnapshotHash) {
          fail("stale_decision", "结果反馈的资格决定归因无效", 422);
        }
        if (!raw.attribution.evidenceIds.every(
          (id) => candidate.evidenceIds.includes(id)
        )) {
          fail("evidence_required", "结果反馈引用了候选之外的证据", 422);
        }
        for (const id of raw.attribution.evidenceIds) {
          await this.requireEvidence(scope, id);
        }
        const createdAt = validIso(this.clock(), "反馈创建时间");
        const material = {
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          leadId: raw.leadId,
          customerId: raw.customerId,
          eventType: raw.eventType,
          occurredAt: validIso(raw.occurredAt, "反馈发生时间"),
          amount: this.normalizeAmount(raw.amount),
          reasonCode: optionalText(raw.reasonCode, "结果原因代码", 100),
          reasonText: optionalText(raw.reasonText, "结果原因", 2_000),
          idempotencyKey: requiredText(
            raw.idempotencyKey,
            "Idempotency-Key",
            200
          ),
          createdBy: scope.actorId,
          createdAt,
          recordKind: "live" as const,
          partyRef: candidate.partyRef,
          candidateId: candidate.id,
          attribution: {
            ...raw.attribution,
            decisionEngine: decision.decisionEngine,
            ruleVersion: decision.ruleVersion,
            modelProvider: decision.modelProvider,
            model: decision.model,
            promptVersion: decision.promptVersion
          }
        };
        const outcome: LiveOutcomeFeedbackEvent = {
          id: this.idFactory("outcome"),
          ...material,
          snapshotHash: hash(material)
        };
        await this.repository.appendOutcome(outcome);
        await this.audit(scope, {
          candidateId: candidate.id,
          eventType: `outcome_${outcome.eventType}`,
          fromStatus: candidate.status,
          toStatus: candidate.status,
          resourceId: outcome.id,
          idempotencyKey: raw.idempotencyKey,
          payload: outcome
        });
        return outcome;
      }
    );
  }

  async listOutcomes(
    scope: AcquisitionActorScope,
    candidateId: string
  ) {
    await this.requireCandidate(scope, candidateId);
    return (await this.repository.listOutcomes(scope, candidateId))
      .map((outcome) => normalizeOutcomeFeedbackEvent(
        outcome as OutcomeFeedbackEvent
      ));
  }

  async listAuditEvents(
    scope: AcquisitionActorScope,
    candidateId: string | null
  ) {
    this.validateScope(scope);
    if (candidateId !== null) await this.requireCandidate(scope, candidateId);
    return this.repository.listAuditEvents(scope, candidateId);
  }

  private buildQualificationDecision(
    scope: AcquisitionActorScope,
    candidate: AcquisitionCandidate,
    evidence: DiscoveryEvidence[],
    raw: QualificationInput,
    sequence: number
  ): QualificationDecision {
    if (!["model", "rules"].includes(raw.decisionEngine)) {
      fail("invalid_request", "资格判断引擎无效", 400);
    }
    if (raw.decisionEngine === "rules"
      && (raw.promptVersion !== null
        || raw.modelProvider !== null
        || raw.model !== null)) {
      fail("invalid_request", "规则判断不能伪装为模型判断", 400);
    }
    if (raw.decisionEngine === "model"
      && (!raw.promptVersion || !raw.modelProvider || !raw.model)) {
      fail("invalid_request", "模型判断必须固化模型与 Prompt 版本", 400);
    }
    const dimensions: QualificationDimensions = {
      demandStrength: bounded(raw.dimensions.demandStrength),
      fit: bounded(raw.dimensions.fit),
      identityConfidence: bounded(raw.dimensions.identityConfidence),
      buyingStage: bounded(raw.dimensions.buyingStage),
      budgetPotential: bounded(raw.dimensions.budgetPotential),
      decisionReachability: bounded(raw.dimensions.decisionReachability),
      freshness: bounded(raw.dimensions.freshness),
      evidenceDiversity: bounded(raw.dimensions.evidenceDiversity),
      negativeSignalRisk: bounded(raw.dimensions.negativeSignalRisk),
      contactRisk: bounded(raw.dimensions.contactRisk)
    };
    const failures = hardGateFailures(raw.hardGates);
    const positiveSignals = POSITIVE_DIMENSIONS.map((item) => ({
      name: item.label,
      score: rounded(dimensions[item.key] * item.weight)
    }));
    const negativeSignals = [
      {
        name: "负向信号风险",
        score: rounded(-dimensions.negativeSignalRisk * 0.10)
      },
      {
        name: "触达风险",
        score: rounded(-dimensions.contactRisk * 0.05)
      }
    ];
    const rawScore = positiveSignals.reduce((sum, item) => sum + item.score, 0)
      + negativeSignals.reduce((sum, item) => sum + item.score, 0);
    const score = failures.length > 0 ? 0 : rounded(bounded(rawScore));
    const grade = failures.length > 0 ? "D" : gradeForQualification(score);
    const references = evidence.map((item) => ({
      evidenceId: item.id,
      excerpt: raw.evidenceExcerpts[item.id]?.trim()
        || item.sourceSnippet.slice(0, 500)
    }));
    const reasons = [
      ...raw.reasons.map((item) => item.trim()).filter(Boolean),
      ...failures.map((item) => `硬门禁：${HARD_GATE_LABELS[item]}`)
    ];
    if (reasons.length === 0) {
      fail("invalid_request", "资格判断至少需要一条理由", 400);
    }
    const material = {
      candidateId: candidate.id,
      decisionVersion: `decision-v${sequence}`,
      decisionEngine: raw.decisionEngine,
      grade,
      score,
      recommendedAction: failures.length > 0
        ? "do_not_contact" as const
        : recommendedAction(grade),
      evidence: references,
      positiveSignals,
      negativeSignals,
      reasons,
      confidence: failures.length > 0
        ? 1
        : rounded(Math.min(1, (score / 100) * 0.7 + Math.min(1, evidence.length / 3) * 0.3)),
      ruleVersion: requiredText(raw.ruleVersion, "规则版本", 100),
      promptVersion: raw.promptVersion,
      modelProvider: raw.modelProvider,
      model: raw.model,
      hardGateFailures: failures
    };
    return {
      id: this.idFactory("qualification"),
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      ...material,
      snapshotHash: hash(material),
      createdAt: validIso(this.clock(), "资格决定时间")
    };
  }

  private buildFinancialValueDecision(
    scope: AcquisitionActorScope,
    candidate: AcquisitionCandidate,
    qualification: QualificationDecision,
    raw: FinancialValueInput,
    sequence: number
  ): FinancialValueDecision {
    const currency = requiredText(raw.currency, "币种", 3).toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency)) {
      fail("invalid_request", "币种必须是三位 ISO 代码", 400);
    }
    const moneyFields = [
      raw.predictedDealAmountMinor,
      raw.acquisitionCostMinor,
      raw.salesCostMinor,
      raw.serviceCostMinor,
      raw.benchmarkDealAmountMinor
    ];
    if (moneyFields.some((value) => !Number.isInteger(value) || value < 0)
      || raw.benchmarkDealAmountMinor <= 0) {
      fail("invalid_request", "财务金额必须是非负整数最小货币单位", 400);
    }
    const closeProbability = bounded(raw.closeProbabilityBps, 0, 10_000);
    const grossMargin = bounded(raw.grossMarginBps, 0, 10_000);
    const expectedRevenueMinor = Math.round(
      raw.predictedDealAmountMinor * closeProbability / 10_000
    );
    const expectedGrossProfitMinor = Math.round(
      expectedRevenueMinor * grossMargin / 10_000
    );
    const expectedContributionMinor = expectedGrossProfitMinor
      - raw.acquisitionCostMinor
      - raw.salesCostMinor
      - raw.serviceCostMinor;
    const profitabilityTarget = raw.benchmarkDealAmountMinor * 0.30;
    const factors = {
      profitability: rounded(bounded(
        expectedContributionMinor / profitabilityTarget * 100
      )),
      cashFlow: rounded(bounded(100 - raw.collectionDays / 1.8)),
      creditQuality: rounded(bounded(100 - raw.creditRisk)),
      repeatPotential: rounded(bounded(raw.repeatPotential)),
      referralPotential: rounded(bounded(raw.referralPotential)),
      closeProbability: rounded(closeProbability / 100)
    };
    const score = rounded(
      factors.profitability * 0.40
      + factors.cashFlow * 0.15
      + factors.creditQuality * 0.15
      + factors.repeatPotential * 0.15
      + factors.referralPotential * 0.10
      + factors.closeProbability * 0.05
    );
    const material = {
      candidateId: candidate.id,
      qualificationDecisionId: qualification.id,
      version: `financial-value-v${sequence}`,
      grade: gradeForFinancialValue(score),
      score,
      currency,
      expectedRevenueMinor,
      expectedGrossProfitMinor,
      expectedContributionMinor,
      factors
    };
    return {
      id: this.idFactory("financial-value"),
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      ...material,
      inputSnapshotHash: hash({ input: raw, result: material }),
      createdAt: validIso(this.clock(), "财务价值决定时间")
    };
  }

  private normalizeEvidenceInput(
    raw: DiscoveryEvidenceInput
  ): Omit<DiscoveryEvidence, "id" | "ownerId" | "teamId" | "fetchedAt"> {
    if (!["organization", "individual_signal"].includes(raw.targetType)) {
      fail("invalid_request", "证据目标类型无效", 400);
    }
    const provenance = clone(raw.provenance);
    if (provenance.kind === "search_result") {
      provenance.provider = requiredText(provenance.provider, "搜索 Provider", 100);
      provenance.queryText = requiredText(provenance.queryText, "搜索查询", 1_000);
      provenance.sourceUrl = validUrl(provenance.sourceUrl, "来源 URL");
      if (provenance.sourceType !== undefined) {
        provenance.sourceType = requiredText(
          provenance.sourceType,
          "公开来源类型",
          100
        );
      }
      if (provenance.resultRank !== null
        && (!Number.isInteger(provenance.resultRank)
          || provenance.resultRank < 1)) {
        fail("invalid_request", "搜索结果排名无效", 400);
      }
    } else if (provenance.kind === "user_submitted_url") {
      provenance.sourceUrl = validUrl(provenance.sourceUrl, "来源 URL");
      provenance.submittedBy = requiredText(
        provenance.submittedBy,
        "提交人",
        100
      );
    } else if (provenance.kind === "controlled_public_page") {
      provenance.sourceUrl = validUrl(provenance.sourceUrl, "受控公开主页 URL");
      if (!provenance.sourceUrl.startsWith("https://")
        || !isVerifiedAcquisitionPublicProfileUrl(provenance.sourceUrl)
        || classifyDouyinPublicSource(provenance.sourceUrl)?.sourceType
          !== "profile") {
        fail("invalid_request", "受控公开主页 URL 无效", 400);
      }
      provenance.discoveredFromEvidenceId = requiredText(
        provenance.discoveredFromEvidenceId,
        "受控公开主页来源证据",
        255
      );
      if (provenance.extractorVersion !== "douyin-public-profile-v1") {
        fail("invalid_request", "受控公开主页提取器版本无效", 400);
      }
      if (!Array.isArray(provenance.redirectChain)
        || provenance.redirectChain.length < 1
        || provenance.redirectChain.length > 4) {
        fail("invalid_request", "受控公开主页重定向链无效", 400);
      }
      provenance.redirectChain = provenance.redirectChain.map((value) => {
        const normalized = validUrl(value, "受控公开主页重定向 URL");
        if (!normalized.startsWith("https://")) {
          fail("invalid_request", "受控公开主页重定向只允许 HTTPS", 400);
        }
        return normalized;
      });
    } else if (provenance.kind === "platform_public_event") {
      if (raw.targetType !== "individual_signal"
        || raw.accessStatus !== "public_content") {
        fail(
          "invalid_request",
          "平台公开事件证据只允许个人需求信号与公开内容",
          400
        );
      }
      const exactKeys = [
        "coverage", "kind", "platformEventId", "providerVersion", "sourceUrl"
      ];
      if (Object.keys(provenance).sort().join("\u0000")
        !== exactKeys.join("\u0000")) {
        fail("invalid_request", "平台公开事件 provenance 字段无效", 400);
      }
      provenance.sourceUrl = validUrl(provenance.sourceUrl, "平台事件来源 URL");
      provenance.platformEventId = requiredText(
        provenance.platformEventId,
        "平台事件 ID",
        255
      );
      provenance.providerVersion = requiredText(
        provenance.providerVersion,
        "平台 Provider 版本",
        255
      );
      if (provenance.coverage !== "public_top_level_sample") {
        fail("invalid_request", "平台公开事件覆盖范围无效", 400);
      }
    } else if (provenance.kind === "authorized_visual_observation") {
      if (raw.targetType !== "individual_signal"
        || raw.accessStatus !== "access_restricted"
        || raw.sourcePlatform !== "douyin"
        || !/^sha256:[a-f0-9]{64}$/u.test(raw.contentHash)
        || !/^sha256:[a-f0-9]{64}$/u.test(raw.rawArtifactHash)) {
        fail("invalid_request", "授权视觉证据目标或访问状态无效", 400);
      }
      const exactKeys = [
        "artifactId", "coverage", "domTextHash", "extractionMethod", "kind",
        "observationId", "ocrTextHash", "sessionId", "sourceUrl",
        "visibleTextConfidence"
      ];
      if (Object.keys(provenance).sort().join("\u0000")
        !== exactKeys.join("\u0000")) {
        fail("invalid_request", "授权视觉 provenance 字段无效", 400);
      }
      provenance.sourceUrl = validUrl(provenance.sourceUrl, "视觉观察来源 URL");
      provenance.observationId = requiredText(
        provenance.observationId,
        "视觉观察 ID",
        160
      );
      const suppliedSessionId = provenance.sessionId;
      provenance.sessionId = requiredText(provenance.sessionId, "视觉会话 ID", 160);
      const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
      if (!/^https:\/\/www\.douyin\.com\/video\/[1-9][0-9]{0,31}\/?$/u
        .test(provenance.sourceUrl)
        || !/^visual-observation:[a-f0-9]{64}$/u.test(
          provenance.observationId
        )
        || provenance.sessionId !== suppliedSessionId
        || !identifierPattern.test(provenance.sessionId)
        || !["dom", "accessibility", "ocr"].includes(
        provenance.extractionMethod
      )
        || typeof provenance.visibleTextConfidence !== "number"
        || !Number.isFinite(provenance.visibleTextConfidence)
        || provenance.visibleTextConfidence < 0
        || provenance.visibleTextConfidence > 1
        || provenance.coverage !== "authorized_visible_top_level_sample"
        || (provenance.artifactId !== null
          && (typeof provenance.artifactId !== "string"
            || !identifierPattern.test(provenance.artifactId)))
        || [provenance.domTextHash, provenance.ocrTextHash].some((value) =>
          value !== null && !/^sha256:[a-f0-9]{64}$/u.test(value))) {
        fail("invalid_request", "授权视觉 provenance 无效", 400);
      }
    } else if (provenance.kind === "import_artifact_row") {
      provenance.importBatchId = requiredText(
        provenance.importBatchId,
        "导入批次",
        100
      );
      provenance.artifactHash = requiredText(
        provenance.artifactHash,
        "导入制品哈希",
        200
      );
      provenance.sheetName = requiredText(provenance.sheetName, "Sheet", 200);
      if (!Number.isInteger(provenance.rowNumber) || provenance.rowNumber < 1) {
        fail("invalid_request", "导入行号无效", 400);
      }
      if (provenance.sourceUrl !== undefined) {
        provenance.sourceUrl = validUrl(
          provenance.sourceUrl,
          "导入行公开来源 URL"
        );
      }
    } else {
      fail("invalid_request", "证据 provenance 类型无效", 400);
    }
    if (![
      "indexed_summary",
      "public_content",
      "user_supplied",
      "access_restricted"
    ].includes(raw.accessStatus)) {
      fail("invalid_request", "证据访问状态无效", 400);
    }
    return {
      targetType: raw.targetType,
      sourcePlatform: requiredText(raw.sourcePlatform, "来源平台", 100),
      sourceTitle: String(raw.sourceTitle ?? "").trim().slice(0, 500),
      sourceSnippet: provenance.kind === "platform_public_event"
        ? String(raw.sourceSnippet ?? "").slice(0, 4_000)
        : String(raw.sourceSnippet ?? "").trim().slice(0, 4_000),
      publishedAt: raw.publishedAt
        ? validIso(raw.publishedAt, "证据发布时间")
        : null,
      locale: requiredText(raw.locale, "语言", 30),
      rawArtifactHash: requiredText(raw.rawArtifactHash, "原始制品哈希", 200),
      contentHash: requiredText(raw.contentHash, "内容哈希", 200),
      provenance,
      accessStatus: raw.accessStatus,
      supersedesEvidenceId: raw.supersedesEvidenceId
        ? requiredText(raw.supersedesEvidenceId, "被替代证据 ID", 100)
        : null
    };
  }

  private async validateEvidenceSet(
    scope: AcquisitionActorScope,
    evidenceIds: string[],
    expectedTarget: DiscoveryEvidence["targetType"]
  ) {
    for (const evidenceId of evidenceIds) {
      const evidence = await this.requireEvidence(scope, evidenceId);
      if (evidence.targetType !== expectedTarget) {
        fail("evidence_required", "候选与证据主体类型不一致", 422);
      }
    }
  }

  private uniqueIds(values: string[], label: string) {
    if (!Array.isArray(values)) {
      fail("invalid_request", `${label}必须是数组`, 400);
    }
    const ids = [...new Set(values.map((item) =>
      requiredText(item, `${label} ID`, 255)
    ))];
    if (ids.length === 0) {
      fail("evidence_required", `${label}至少需要一条`, 422);
    }
    return ids;
  }

  private validateReviewTransition(
    candidate: AcquisitionCandidate,
    action: ReviewAction,
    reason: string | null
  ) {
    if (!["approved", "rejected", "do_not_contact", "needs_research", "reopen"]
      .includes(action)) {
      fail("invalid_request", "审核动作无效", 400);
    }
    if (action === "reopen") {
      if (candidate.status !== "rejected") {
        fail("invalid_state", "只有已驳回候选可以显式重开");
      }
    } else if (candidate.status !== "pending_review") {
      fail("invalid_state", "候选当前不在待审核状态");
    }
    if (["rejected", "needs_research", "reopen"].includes(action) && !reason) {
      fail("invalid_request", "该审核动作必须填写原因", 400);
    }
  }

  private assertCurrentDecision(
    candidate: AcquisitionCandidate,
    decisionVersion: string
  ) {
    if (!candidate.latestDecisionVersion
      || candidate.latestDecisionVersion !== decisionVersion) {
      fail("stale_decision", "审核引用的资格决定已不是当前版本");
    }
  }

  private normalizeAmount(
    amount: { amountMinor: number; currency: string } | null
  ) {
    if (amount === null) return null;
    if (!Number.isSafeInteger(amount.amountMinor)
      || amount.amountMinor < 0) {
      fail(
        "invalid_request",
        "金额必须使用非负安全整数最小货币单位",
        400
      );
    }
    const currency = requiredText(amount.currency, "币种", 3).toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency)) {
      fail("invalid_request", "币种必须是三位 ISO 代码", 400);
    }
    return { amountMinor: amount.amountMinor, currency };
  }

  private updateCandidate(
    candidate: AcquisitionCandidate,
    changes: Partial<Pick<
      AcquisitionCandidate,
      | "status"
      | "partyRef"
      | "profile"
      | "latestDecisionId"
      | "latestDecisionVersion"
      | "approvedDecisionVersion"
      | "hardGateFailures"
      | "evidenceIds"
      | "leadId"
    >>
  ): AcquisitionCandidate {
    return {
      ...candidate,
      ...changes,
      updatedAt: validIso(this.clock(), "候选更新时间"),
      version: candidate.version + 1
    };
  }

  private async requireCandidate(
    scope: AcquisitionActorScope,
    candidateId: string
  ) {
    const candidate = await this.repository.findCandidate(
      scope,
      requiredText(candidateId, "候选 ID", 100)
    );
    if (!candidate) fail("resource_not_found", "候选不存在", 404);
    return candidate;
  }

  private async requireEvidence(
    scope: AcquisitionActorScope,
    evidenceId: string
  ) {
    const evidence = await this.repository.findEvidence(
      scope,
      requiredText(evidenceId, "证据 ID", 255)
    );
    if (!evidence) fail("resource_not_found", "证据不存在", 404);
    return evidence;
  }

  private async requireResearch(
    scope: AcquisitionActorScope,
    candidateId: string,
    researchId: string
  ) {
    const research = await this.repository.findResearchAttempt(
      scope,
      candidateId,
      researchId
    );
    if (!research) fail("resource_not_found", "研究任务不存在", 404);
    return research;
  }

  private validateScope(scope: AcquisitionActorScope) {
    requiredText(scope.ownerId, "Owner ID", 100);
    requiredText(scope.teamId, "Team ID", 100);
    requiredText(scope.actorId, "Actor ID", 100);
  }

  private async idempotent<T>(
    scope: AcquisitionActorScope,
    operation: string,
    idempotencyKey: string,
    request: unknown,
    execute: () => Promise<T>
  ): Promise<T> {
    const key = requiredText(idempotencyKey, "Idempotency-Key", 200);
    const requestHash = hash(request);
    const flightKey = [
      scope.ownerId,
      scope.teamId,
      operation,
      key
    ].join("\u0000");
    const inFlight = this.inFlightIdempotency.get(flightKey);
    if (inFlight) {
      if (inFlight.requestHash !== requestHash) {
        fail(
          "idempotency_conflict",
          "同一 Idempotency-Key 正在处理不同请求"
        );
      }
      return clone(await inFlight.promise as T);
    }
    const promise = this.repository.transaction(async () => {
      const existing = await this.repository.findIdempotency(
        scope,
        operation,
        key
      );
      if (existing) {
        if (existing.requestHash !== requestHash) {
          fail(
            "idempotency_conflict",
            "同一 Idempotency-Key 已用于不同请求"
          );
        }
        return clone(existing.result as T);
      }
      const result = await execute();
      const record: IdempotencyRecord = {
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        operation,
        idempotencyKey: key,
        requestHash,
        result: clone(result),
        createdAt: validIso(this.clock(), "幂等记录时间")
      };
      await this.repository.appendIdempotency(record);
      return clone(result);
    }).catch(async (error) => {
      const committed = await this.repository.findIdempotency(
        scope,
        operation,
        key
      );
      if (!committed) throw error;
      if (committed.requestHash !== requestHash) {
        fail(
          "idempotency_conflict",
          "同一 Idempotency-Key 已用于不同请求"
        );
      }
      return clone(committed.result as T);
    });
    this.inFlightIdempotency.set(flightKey, { requestHash, promise });
    try {
      return clone(await promise as T);
    } finally {
      const current = this.inFlightIdempotency.get(flightKey);
      if (current?.promise === promise) {
        this.inFlightIdempotency.delete(flightKey);
      }
    }
  }

  private async audit(
    scope: AcquisitionActorScope,
    input: {
      candidateId: string | null;
      eventType: string;
      fromStatus: CandidateStatus | null;
      toStatus: CandidateStatus | null;
      resourceId: string;
      idempotencyKey: string;
      payload: unknown;
    }
  ) {
    const event = this.buildAuditEvent(scope, input);
    await this.repository.appendAuditEvent(event);
    return event;
  }

  private buildAuditEvent(
    scope: AcquisitionActorScope,
    input: {
      candidateId: string | null;
      eventType: string;
      fromStatus: CandidateStatus | null;
      toStatus: CandidateStatus | null;
      resourceId: string;
      idempotencyKey: string;
      payload: unknown;
    }
  ): AcquisitionAuditEvent {
    const event: AcquisitionAuditEvent = {
      id: this.idFactory("audit"),
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      candidateId: input.candidateId,
      actorId: scope.actorId,
      eventType: input.eventType,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      resourceId: input.resourceId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: hash(input.payload),
      createdAt: validIso(this.clock(), "审计时间")
    };
    return event;
  }
}
