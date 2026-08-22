import {
  createHash,
  randomUUID
} from "node:crypto";
import {
  acquisitionCandidateIdentityResolved,
  type AcquisitionCandidate
} from "./acquisition-domain.js";
import type {
  AcquisitionAgentToolExecutor,
  AcquisitionAgentToolName,
  AcquisitionToolExecutionInput
} from "./acquisition-pi-tools.js";
import {
  AcquisitionToolExecutorError,
  type AcquisitionToolExecutorErrorCode
} from "./acquisition-tool-executor.js";
import { canonicalJsonStringify } from "./canonical-json.js";

export type AcquisitionCandidateIntelligenceStage =
  | "research"
  | "qualification"
  | "battle_card";

export type AcquisitionCandidateIntelligenceOperationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export interface AcquisitionCandidateIntelligenceScope {
  ownerId: string;
  teamId: string;
  actorId: string;
}

export interface AcquisitionCandidateIntelligenceResearchFinding {
  label: string;
  content: string;
  evidenceIds: string[];
  confidence: number | null;
}

export interface AcquisitionCandidateIntelligenceResearch {
  summary: string;
  findings: AcquisitionCandidateIntelligenceResearchFinding[];
}

export interface AcquisitionCandidateIntelligenceQualification {
  grade: "S" | "A" | "B" | "C" | "D";
  score: number;
  hardGateFailures: string[];
  financialValueId: string;
}

export interface AcquisitionCandidateIntelligenceFailure {
  stage: AcquisitionCandidateIntelligenceStage;
  errorCode: string;
}

export interface AcquisitionCandidateIntelligenceOperation {
  id: string;
  ownerId: string;
  teamId: string;
  actorId: string;
  candidateId: string;
  sessionId: string;
  identityFingerprint: string;
  status: AcquisitionCandidateIntelligenceOperationStatus;
  currentStage: AcquisitionCandidateIntelligenceStage | null;
  completedStages: AcquisitionCandidateIntelligenceStage[];
  skippedStages: AcquisitionCandidateIntelligenceStage[];
  research: AcquisitionCandidateIntelligenceResearch | null;
  qualification: AcquisitionCandidateIntelligenceQualification | null;
  battleCardId: string | null;
  failure: AcquisitionCandidateIntelligenceFailure | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  failedAt: string | null;
}

export interface AcquisitionCandidateIntelligenceOperationRecord
extends AcquisitionCandidateIntelligenceOperation {
  idempotencyKeyHash: string;
  requestHash: string;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
}

export interface AcquisitionCandidateIntelligenceClaim {
  leaseOwner: string;
  leaseToken: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface AcquisitionCandidateIntelligenceHeartbeatScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface AcquisitionCandidateIntelligenceRecoveryQuery {
  now: string;
  limit: number;
}

export interface AcquisitionCandidateIntelligenceRetryCommand {
  ownerId: string;
  teamId: string;
  operationId: string;
  idempotencyKeyHash: string;
  requestHash: string;
  createdAt: string;
}

export type AcquisitionCandidateIntelligenceOperationErrorCode =
  | "INVALID_REQUEST"
  | "RESOURCE_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "IDENTITY_NOT_RESOLVED"
  | "OPERATION_ALREADY_RUNNING";

export class AcquisitionCandidateIntelligenceOperationError extends Error {
  constructor(
    public readonly code:
      AcquisitionCandidateIntelligenceOperationErrorCode
  ) {
    super(code);
    this.name = "AcquisitionCandidateIntelligenceOperationError";
  }
}

export interface AcquisitionCandidateIntelligenceOperationRepository {
  findOperationByIdempotency(input: {
    ownerId: string;
    teamId: string;
    idempotencyKeyHash: string;
  }): Promise<AcquisitionCandidateIntelligenceOperationRecord | null>;
  createOperation(
    operation: AcquisitionCandidateIntelligenceOperationRecord
  ): Promise<{
    operation: AcquisitionCandidateIntelligenceOperationRecord;
    created: boolean;
  }>;
  getOperation(
    scope: Pick<AcquisitionCandidateIntelligenceScope, "ownerId" | "teamId">,
    id: string
  ): Promise<AcquisitionCandidateIntelligenceOperationRecord | null>;
  findLatestForCandidate(
    scope: Pick<AcquisitionCandidateIntelligenceScope, "ownerId" | "teamId">,
    candidateId: string
  ): Promise<AcquisitionCandidateIntelligenceOperationRecord | null>;
  registerRetryCommand(
    command: AcquisitionCandidateIntelligenceRetryCommand
  ): Promise<{
    command: AcquisitionCandidateIntelligenceRetryCommand;
    operation: AcquisitionCandidateIntelligenceOperationRecord;
    created: boolean;
  }>;
  listRecoverableOperations(
    input: AcquisitionCandidateIntelligenceRecoveryQuery
  ): Promise<AcquisitionCandidateIntelligenceOperationRecord[]>;
  claimOperation(
    scope: Pick<AcquisitionCandidateIntelligenceScope, "ownerId" | "teamId">,
    id: string,
    claim: AcquisitionCandidateIntelligenceClaim
  ): Promise<{
    operation: AcquisitionCandidateIntelligenceOperationRecord | null;
    claimed: boolean;
  }>;
  saveOperation(
    operation: AcquisitionCandidateIntelligenceOperationRecord,
    leaseToken: string
  ): Promise<void>;
  renewLease(
    scope: Pick<AcquisitionCandidateIntelligenceScope, "ownerId" | "teamId">,
    id: string,
    leaseToken: string,
    input: {
      renewedAt: string;
      leaseExpiresAt: string;
    }
  ): Promise<boolean>;
}

export interface AcquisitionCandidateIntelligenceCandidatePort {
  getCandidate(
    scope: AcquisitionCandidateIntelligenceScope,
    candidateId: string
  ): Promise<AcquisitionCandidate | null>;
}

export interface AcquisitionCandidateIntelligenceSessionFactory {
  createSession(input: {
    scope: AcquisitionCandidateIntelligenceScope;
    candidateId: string;
    idempotencyKey: string;
  }): Promise<{ sessionId: string }>;
}

export interface AcquisitionCandidateIntelligenceOperationServiceOptions {
  repository: AcquisitionCandidateIntelligenceOperationRepository;
  candidates: AcquisitionCandidateIntelligenceCandidatePort;
  sessionFactory: AcquisitionCandidateIntelligenceSessionFactory;
  executor: AcquisitionAgentToolExecutor;
  workerId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatScheduler?: AcquisitionCandidateIntelligenceHeartbeatScheduler;
  leaseTokenFactory?: () => string;
  idFactory?: () => string;
  now?: () => string;
}

const STAGES: readonly AcquisitionCandidateIntelligenceStage[] = [
  "research",
  "qualification",
  "battle_card"
];

const RESEARCH_QUESTIONS = Object.freeze([
  "该主体最近有哪些与目标产品相关的明确需求或经营变化？",
  "哪些公开信息支持或反驳采购可能性？",
  "可能参与采购决策的部门和商务角色有哪些？",
  "是否存在现有供应商、比价、拒绝联系或勿扰信号？"
]);

const GRADES = new Set(["S", "A", "B", "C", "D"]);
const MAX_RESEARCH_SUMMARY_LENGTH = 8_000;
const MAX_RESEARCH_FINDINGS = 100;
const MAX_RESEARCH_LABEL_LENGTH = 200;
const MAX_RESEARCH_CONTENT_LENGTH = 4_000;
const MAX_RESEARCH_EVIDENCE_IDS = 100;
const MAX_REFERENCE_ID_LENGTH = 255;
const TRUSTED_TOOL_ERROR_CODES = new Set<AcquisitionToolExecutorErrorCode>([
  "ABORTED",
  "INVALID_IDENTITY",
  "IDENTITY_RESEARCH_REQUIRED",
  "INVALID_PAYLOAD",
  "UNKNOWN_TOOL",
  "SEARCH_PROVIDER_CONNECTION_REQUIRED",
  "SEARCH_ALL_PROVIDERS_FAILED",
  "RESOURCE_NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_STATE",
  "HARD_GATE_BLOCKED",
  "EVIDENCE_REQUIRED",
  "STALE_DECISION",
  "CONVERSION_FAILED",
  "ELIGIBILITY_BLOCKED",
  "ACTION_NOT_EXECUTED",
  "ACTION_EXECUTION_MISMATCH",
  "INVALID_JUDGMENT_RESULT",
  "UNSUPPORTED_CURRENCY",
  "TOOL_EXECUTION_FAILED"
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableHash(value: unknown) {
  return `sha256:${hash(canonicalJsonStringify(value))}`;
}

function resolvedIdentityFingerprint(candidate: AcquisitionCandidate) {
  if (!acquisitionCandidateIdentityResolved(candidate)) return null;
  if (candidate.partyType === "organization"
    && candidate.partyRef.partyType === "organization"
    && candidate.profile.kind === "organization") {
    return stableHash({
      partyRef: candidate.partyRef,
      publicIdentity: {
        name: candidate.profile.name,
        domain: candidate.profile.domain,
        creditCode: candidate.profile.creditCode
      }
    });
  }
  if (candidate.partyType === "individual"
    && candidate.partyRef.partyType === "individual"
    && candidate.profile.kind === "individual") {
    return stableHash({
      partyRef: candidate.partyRef,
      publicIdentity: {
        publicActorKey: candidate.profile.publicActorKey,
        publicDisplayName: candidate.profile.publicDisplayName,
        publicProfileUrl: candidate.profile.publicProfileUrl,
        sourcePlatform: candidate.profile.sourcePlatform
      }
    });
  }
  return null;
}

function requiredText(value: unknown, max = 200) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) {
    throw new AcquisitionCandidateIntelligenceOperationError(
      "INVALID_REQUEST"
    );
  }
  return text;
}

function validScope(scope: AcquisitionCandidateIntelligenceScope) {
  return {
    ownerId: requiredText(scope.ownerId, 100),
    teamId: requiredText(scope.teamId, 100),
    actorId: requiredText(scope.actorId, 100)
  };
}

function validIso(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("ACQUISITION_CANDIDATE_INTELLIGENCE_INVALID_CLOCK");
  }
  return new Date(timestamp).toISOString();
}

function publicOperation(
  operation: AcquisitionCandidateIntelligenceOperationRecord
): AcquisitionCandidateIntelligenceOperation {
  const {
    idempotencyKeyHash: _idempotencyKeyHash,
    requestHash: _requestHash,
    leaseOwner: _leaseOwner,
    leaseToken: _leaseToken,
    leaseExpiresAt: _leaseExpiresAt,
    ...value
  } = operation;
  return clone(value);
}

function idempotencyMapKey(input: {
  ownerId: string;
  teamId: string;
  idempotencyKeyHash: string;
}) {
  return [
    input.ownerId,
    input.teamId,
    input.idempotencyKeyHash
  ].join("\u001f");
}

function queuedForRetry(
  operation: AcquisitionCandidateIntelligenceOperationRecord,
  updatedAt: string
) {
  if (operation.status !== "failed") return clone(operation);
  return clone({
    ...operation,
    status: "queued" as const,
    currentStage: null,
    failure: null,
    updatedAt,
    completedAt: null,
    failedAt: null,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null
  });
}

export class InMemoryAcquisitionCandidateIntelligenceOperationRepository
implements AcquisitionCandidateIntelligenceOperationRepository {
  private readonly operations = new Map<
    string,
    AcquisitionCandidateIntelligenceOperationRecord
  >();
  private readonly idempotency = new Map<string, string>();
  private readonly retryIdempotency = new Map<
    string,
    AcquisitionCandidateIntelligenceRetryCommand
  >();

  async findOperationByIdempotency(input: {
    ownerId: string;
    teamId: string;
    idempotencyKeyHash: string;
  }) {
    const id = this.idempotency.get(idempotencyMapKey(input));
    return id ? clone(this.operations.get(id)!) : null;
  }

  async createOperation(
    operation: AcquisitionCandidateIntelligenceOperationRecord
  ) {
    const key = idempotencyMapKey(operation);
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.operations.get(existingId)!;
      if (existing.requestHash !== operation.requestHash) {
        throw new AcquisitionCandidateIntelligenceOperationError(
          "IDEMPOTENCY_CONFLICT"
        );
      }
      return { operation: clone(existing), created: false };
    }
    this.operations.set(operation.id, clone(operation));
    this.idempotency.set(key, operation.id);
    return { operation: clone(operation), created: true };
  }

  async getOperation(
    scope: Pick<AcquisitionCandidateIntelligenceScope, "ownerId" | "teamId">,
    id: string
  ) {
    const operation = this.operations.get(id);
    return operation
      && operation.ownerId === scope.ownerId
      && operation.teamId === scope.teamId
      ? clone(operation)
      : null;
  }

  async findLatestForCandidate(
    scope: Pick<AcquisitionCandidateIntelligenceScope, "ownerId" | "teamId">,
    candidateId: string
  ) {
    const latest = [...this.operations.values()]
      .filter((operation) =>
        operation.ownerId === scope.ownerId
        && operation.teamId === scope.teamId
        && operation.candidateId === candidateId)
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
        || right.id.localeCompare(left.id))[0];
    return latest ? clone(latest) : null;
  }

  async registerRetryCommand(
    command: AcquisitionCandidateIntelligenceRetryCommand
  ) {
    const key = idempotencyMapKey(command);
    const existing = this.retryIdempotency.get(key);
    if (existing) {
      if (existing.requestHash !== command.requestHash) {
        throw new AcquisitionCandidateIntelligenceOperationError(
          "IDEMPOTENCY_CONFLICT"
        );
      }
      const operation = this.operations.get(existing.operationId);
      if (!operation
        || operation.ownerId !== command.ownerId
        || operation.teamId !== command.teamId) {
        throw new AcquisitionCandidateIntelligenceOperationError(
          "RESOURCE_NOT_FOUND"
        );
      }
      return {
        command: clone(existing),
        operation: clone(operation),
        created: false
      };
    }
    const operation = this.operations.get(command.operationId);
    if (!operation
      || operation.ownerId !== command.ownerId
      || operation.teamId !== command.teamId) {
      throw new AcquisitionCandidateIntelligenceOperationError(
        "RESOURCE_NOT_FOUND"
      );
    }
    const retried = queuedForRetry(operation, command.createdAt);
    this.retryIdempotency.set(key, clone(command));
    this.operations.set(operation.id, clone(retried));
    return {
      command: clone(command),
      operation: retried,
      created: true
    };
  }

  async listRecoverableOperations(
    input: AcquisitionCandidateIntelligenceRecoveryQuery
  ) {
    return [...this.operations.values()]
      .filter((operation) =>
        operation.status === "queued"
        || (operation.status === "running"
          && Boolean(operation.leaseExpiresAt)
          && operation.leaseExpiresAt! <= input.now))
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id))
      .slice(0, input.limit)
      .map(clone);
  }

  async claimOperation(
    scope: Pick<AcquisitionCandidateIntelligenceScope, "ownerId" | "teamId">,
    id: string,
    claim: AcquisitionCandidateIntelligenceClaim
  ) {
    const operation = await this.getOperation(scope, id);
    if (!operation) return { operation: null, claimed: false };
    if (operation.status === "succeeded") {
      return { operation, claimed: false };
    }
    if (operation.status === "running"
      && (!operation.leaseExpiresAt
        || operation.leaseExpiresAt > claim.claimedAt)) {
      return { operation, claimed: false };
    }
    operation.status = "running";
    operation.startedAt ??= claim.claimedAt;
    operation.updatedAt = claim.claimedAt;
    operation.currentStage = null;
    operation.failure = null;
    operation.completedAt = null;
    operation.failedAt = null;
    operation.leaseOwner = claim.leaseOwner;
    operation.leaseToken = claim.leaseToken;
    operation.leaseExpiresAt = claim.leaseExpiresAt;
    this.operations.set(id, clone(operation));
    return { operation: clone(operation), claimed: true };
  }

  async saveOperation(
    operation: AcquisitionCandidateIntelligenceOperationRecord,
    leaseToken: string
  ) {
    const existing = this.operations.get(operation.id);
    if (!existing
      || existing.ownerId !== operation.ownerId
      || existing.teamId !== operation.teamId) {
      throw new AcquisitionCandidateIntelligenceOperationError(
        "RESOURCE_NOT_FOUND"
      );
    }
    if (existing.status !== "running"
      || existing.leaseToken !== leaseToken) {
      throw new AcquisitionCandidateIntelligenceOperationError(
        "OPERATION_ALREADY_RUNNING"
      );
    }
    const released = operation.status !== "running";
    this.operations.set(operation.id, clone({
      ...operation,
      leaseOwner: released ? null : existing.leaseOwner,
      leaseToken: released ? null : existing.leaseToken,
      leaseExpiresAt: released ? null : existing.leaseExpiresAt
    }));
  }

  async renewLease(
    scope: Pick<AcquisitionCandidateIntelligenceScope, "ownerId" | "teamId">,
    id: string,
    leaseToken: string,
    input: {
      renewedAt: string;
      leaseExpiresAt: string;
    }
  ) {
    const operation = this.operations.get(id);
    if (!operation
      || operation.ownerId !== scope.ownerId
      || operation.teamId !== scope.teamId
      || operation.status !== "running"
      || operation.leaseToken !== leaseToken
      || !operation.leaseExpiresAt
      || operation.leaseExpiresAt <= input.renewedAt) {
      return false;
    }
    operation.leaseExpiresAt = input.leaseExpiresAt;
    operation.updatedAt = input.renewedAt;
    this.operations.set(id, clone(operation));
    return true;
  }
}

class InvalidStageResultError extends Error {
  constructor(public readonly errorCode: string) {
    super(errorCode);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value);
}

function uniqueNormalizedStrings(
  values: string[],
  maxItems: number,
  maxLength: number
) {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = value.slice(0, maxLength);
    if (seen.has(item)) continue;
    seen.add(item);
    normalized.push(item);
    if (normalized.length >= maxItems) break;
  }
  return normalized;
}

function researchResult(value: unknown): AcquisitionCandidateIntelligenceResearch {
  if (!isRecord(value)
    || typeof value.summary !== "string"
    || !value.summary.trim()
    || !Array.isArray(value.findings)) {
    throw new InvalidStageResultError("INVALID_RESEARCH_RESULT");
  }
  const findings = value.findings
    .slice(0, MAX_RESEARCH_FINDINGS)
    .map((raw) => {
      if (!isRecord(raw)
        || typeof raw.label !== "string"
        || !raw.label.trim()
        || typeof raw.content !== "string"
        || !raw.content.trim()
        || !Array.isArray(raw.evidenceIds)
        || raw.evidenceIds.some((id) => typeof id !== "string" || !id.trim())
        || !(raw.confidence === null
          || (typeof raw.confidence === "number"
            && Number.isFinite(raw.confidence)
            && raw.confidence >= 0
            && raw.confidence <= 1))) {
        throw new InvalidStageResultError("INVALID_RESEARCH_RESULT");
      }
      return {
        label: raw.label.slice(0, MAX_RESEARCH_LABEL_LENGTH),
        content: raw.content.slice(0, MAX_RESEARCH_CONTENT_LENGTH),
        evidenceIds: uniqueNormalizedStrings(
          raw.evidenceIds as string[],
          MAX_RESEARCH_EVIDENCE_IDS,
          MAX_REFERENCE_ID_LENGTH
        ),
        confidence: raw.confidence as number | null
      };
    });
  return {
    summary: value.summary.slice(0, MAX_RESEARCH_SUMMARY_LENGTH),
    findings
  };
}

function qualificationResult(
  value: unknown
): AcquisitionCandidateIntelligenceQualification {
  if (!isRecord(value)
    || !isRecord(value.qualification)
    || !isRecord(value.financialValue)) {
    throw new InvalidStageResultError("INVALID_QUALIFICATION_RESULT");
  }
  const { grade, score, hardGateFailures } = value.qualification;
  const financialValueId = value.financialValue.id;
  if (typeof grade !== "string"
    || !GRADES.has(grade)
    || typeof score !== "number"
    || !Number.isFinite(score)
    || score < 0
    || score > 100
    || !Array.isArray(hardGateFailures)
    || hardGateFailures.some((failure) =>
      typeof failure !== "string" || !failure.trim())
    || typeof financialValueId !== "string"
    || !financialValueId.trim()) {
    throw new InvalidStageResultError("INVALID_QUALIFICATION_RESULT");
  }
  return {
    grade: grade as AcquisitionCandidateIntelligenceQualification["grade"],
    score,
    hardGateFailures: uniqueNormalizedStrings(
      hardGateFailures as string[],
      20,
      100
    ),
    financialValueId: financialValueId.slice(0, MAX_REFERENCE_ID_LENGTH)
  };
}

function battleCardId(value: unknown) {
  if (!isRecord(value)
    || !isRecord(value.battleCard)
    || typeof value.battleCard.id !== "string"
    || !value.battleCard.id.trim()) {
    throw new InvalidStageResultError("INVALID_BATTLE_CARD_RESULT");
  }
  return value.battleCard.id.slice(0, MAX_REFERENCE_ID_LENGTH);
}

function stableFailureCode(error: unknown) {
  if (error instanceof InvalidStageResultError) return error.errorCode;
  if (error instanceof AcquisitionToolExecutorError
    && TRUSTED_TOOL_ERROR_CODES.has(error.code)) {
    return error.code;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "ABORTED";
  }
  return "TOOL_EXECUTION_FAILED";
}

function stageIdempotencyKey(
  operation: AcquisitionCandidateIntelligenceOperation,
  stage: AcquisitionCandidateIntelligenceStage
) {
  return `candidate-intelligence-stage:${hash(canonicalJsonStringify({
    version: "candidate-intelligence-stage.v1",
    ownerId: operation.ownerId,
    teamId: operation.teamId,
    operationId: operation.id,
    candidateId: operation.candidateId,
    identityFingerprint: operation.identityFingerprint,
    stage
  })).slice(0, 48)}`;
}

function toolForStage(stage: AcquisitionCandidateIntelligenceStage): {
  toolName: AcquisitionAgentToolName;
  payload(candidateId: string): Record<string, unknown>;
} {
  if (stage === "research") {
    return {
      toolName: "research_candidate",
      payload: (candidateId) => ({
        candidateId,
        depth: "standard",
        researchQuestions: [...RESEARCH_QUESTIONS]
      })
    };
  }
  if (stage === "qualification") {
    return {
      toolName: "qualify_candidate",
      payload: (candidateId) => ({
        candidateId,
        policyVersion: "qualification.v2"
      })
    };
  }
  return {
    toolName: "build_battle_card",
    payload: (candidateId) => ({
      candidateId,
      templateVersion: "battle-card.v2"
    })
  };
}

function eligibleForBattleCard(
  qualification: AcquisitionCandidateIntelligenceQualification
) {
  return qualification.hardGateFailures.length === 0
    && (qualification.grade === "S"
      || qualification.grade === "A"
      || qualification.score >= 70);
}

export class AcquisitionCandidateIntelligenceOperationService {
  private readonly repository:
    AcquisitionCandidateIntelligenceOperationRepository;
  private readonly candidates: AcquisitionCandidateIntelligenceCandidatePort;
  private readonly sessionFactory:
    AcquisitionCandidateIntelligenceSessionFactory;
  private readonly executor: AcquisitionAgentToolExecutor;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatScheduler:
    AcquisitionCandidateIntelligenceHeartbeatScheduler;
  private readonly leaseTokenFactory: () => string;
  private readonly idFactory: () => string;
  private readonly now: () => string;
  private readonly running = new Map<
    string,
    Promise<AcquisitionCandidateIntelligenceOperation>
  >();

  constructor(options: AcquisitionCandidateIntelligenceOperationServiceOptions) {
    this.repository = options.repository;
    this.candidates = options.candidates;
    this.sessionFactory = options.sessionFactory;
    this.executor = options.executor;
    this.workerId = requiredText(
      options.workerId ?? `candidate-intelligence-worker-${randomUUID()}`,
      160
    );
    this.leaseDurationMs = options.leaseDurationMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(this.leaseDurationMs)
      || this.leaseDurationMs < 10_000
      || this.leaseDurationMs > 24 * 60 * 60_000) {
      throw new TypeError(
        "leaseDurationMs must be between 10000 and 86400000"
      );
    }
    this.heartbeatIntervalMs = options.heartbeatIntervalMs
      ?? Math.max(1_000, Math.floor(this.leaseDurationMs / 3));
    if (!Number.isSafeInteger(this.heartbeatIntervalMs)
      || this.heartbeatIntervalMs < 1_000
      || this.heartbeatIntervalMs >= this.leaseDurationMs) {
      throw new TypeError(
        "heartbeatIntervalMs must be between 1000 and leaseDurationMs"
      );
    }
    this.heartbeatScheduler = options.heartbeatScheduler ?? {
      setInterval(callback, delayMs) {
        const timer = setInterval(callback, delayMs);
        timer.unref?.();
        return timer;
      },
      clearInterval(handle) {
        clearInterval(handle as NodeJS.Timeout);
      }
    };
    this.leaseTokenFactory = options.leaseTokenFactory ?? randomUUID;
    this.idFactory = options.idFactory
      ?? (() => `candidate-intelligence-${randomUUID()}`);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async createAfterIdentity(
    rawScope: AcquisitionCandidateIntelligenceScope,
    candidateIdInput: string,
    idempotencyKeyInput: string,
    options: { trustedSessionId?: string } = {}
  ) {
    const scope = validScope(rawScope);
    const candidateId = requiredText(candidateIdInput, 160);
    const idempotencyKey = requiredText(idempotencyKeyInput, 200);
    const trustedSessionId = options.trustedSessionId === undefined
      ? null
      : requiredText(options.trustedSessionId, 255);
    if (trustedSessionId
      && !/^acquisition-plan:[A-Za-z0-9._:-]{1,200}$/u.test(
        trustedSessionId
      )) {
      throw new AcquisitionCandidateIntelligenceOperationError(
        "INVALID_REQUEST"
      );
    }
    const idempotencyKeyHash = hash(idempotencyKey);
    const candidate = await this.candidates.getCandidate(scope, candidateId);
    if (!candidate) {
      throw new AcquisitionCandidateIntelligenceOperationError(
        "RESOURCE_NOT_FOUND"
      );
    }
    const identityFingerprint = resolvedIdentityFingerprint(candidate);
    if (!identityFingerprint) {
      throw new AcquisitionCandidateIntelligenceOperationError(
        "IDENTITY_NOT_RESOLVED"
      );
    }
    const requestHash = stableHash(trustedSessionId
      ? { candidateId, identityFingerprint, trustedSessionId }
      : { candidateId, identityFingerprint });
    const existing = await this.repository.findOperationByIdempotency({
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      idempotencyKeyHash
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new AcquisitionCandidateIntelligenceOperationError(
          "IDEMPOTENCY_CONFLICT"
        );
      }
      return publicOperation(existing);
    }
    const sessionId = trustedSessionId ?? requiredText((
      await this.sessionFactory.createSession({
        scope,
        candidateId,
        idempotencyKey:
          `candidate-intelligence-session:${idempotencyKeyHash}`
      })
    ).sessionId, 255);
    const now = validIso(this.now());
    const operation: AcquisitionCandidateIntelligenceOperationRecord = {
      id: requiredText(this.idFactory(), 160),
      ...scope,
      candidateId,
      sessionId,
      identityFingerprint,
      status: "queued",
      currentStage: null,
      completedStages: [],
      skippedStages: [],
      research: null,
      qualification: null,
      battleCardId: null,
      failure: null,
      idempotencyKeyHash,
      requestHash,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      completedAt: null,
      failedAt: null
    };
    const result = await this.repository.createOperation(operation);
    return publicOperation(result.operation);
  }

  async get(
    rawScope: AcquisitionCandidateIntelligenceScope,
    operationIdInput: string
  ) {
    const scope = validScope(rawScope);
    const operation = await this.repository.getOperation(
      scope,
      requiredText(operationIdInput, 160)
    );
    if (!operation) {
      throw new AcquisitionCandidateIntelligenceOperationError(
        "RESOURCE_NOT_FOUND"
      );
    }
    return publicOperation(operation);
  }

  async findLatestForCandidate(
    rawScope: AcquisitionCandidateIntelligenceScope,
    candidateIdInput: string
  ) {
    const scope = validScope(rawScope);
    const operation = await this.repository.findLatestForCandidate(
      scope,
      requiredText(candidateIdInput, 160)
    );
    return operation ? publicOperation(operation) : null;
  }

  async requestRetry(
    rawScope: AcquisitionCandidateIntelligenceScope,
    operationIdInput: string,
    idempotencyKeyInput: string
  ) {
    const scope = validScope(rawScope);
    const operationId = requiredText(operationIdInput, 160);
    const idempotencyKey = requiredText(idempotencyKeyInput, 200);
    const command: AcquisitionCandidateIntelligenceRetryCommand = {
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      operationId,
      idempotencyKeyHash: hash(idempotencyKey),
      requestHash: stableHash({ operationId }),
      createdAt: validIso(this.now())
    };
    const registered = await this.repository.registerRetryCommand(command);
    return {
      operation: publicOperation(registered.operation),
      shouldDispatch: registered.created
    };
  }

  async listRecoverableOperations(options: { limit?: number } = {}) {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AcquisitionCandidateIntelligenceOperationError(
        "INVALID_REQUEST"
      );
    }
    const operations = await this.repository.listRecoverableOperations({
      now: validIso(this.now()),
      limit
    });
    return operations.map(publicOperation);
  }

  execute(
    rawScope: AcquisitionCandidateIntelligenceScope,
    operationIdInput: string,
    signal?: AbortSignal
  ) {
    const scope = validScope(rawScope);
    const operationId = requiredText(operationIdInput, 160);
    const key = [scope.ownerId, scope.teamId, operationId].join("\u001f");
    const existing = this.running.get(key);
    if (existing) return existing;
    const running = this.executeClaimed(scope, operationId, signal);
    this.running.set(key, running);
    void running.then(
      () => this.running.delete(key),
      () => this.running.delete(key)
    );
    return running;
  }

  private nextClaim(): AcquisitionCandidateIntelligenceClaim {
    const claimedAt = validIso(this.now());
    return {
      leaseOwner: this.workerId,
      leaseToken: requiredText(this.leaseTokenFactory(), 200),
      claimedAt,
      leaseExpiresAt: new Date(
        Date.parse(claimedAt) + this.leaseDurationMs
      ).toISOString()
    };
  }

  private async assertIdentityBinding(
    operation: AcquisitionCandidateIntelligenceOperationRecord
  ) {
    const candidate = await this.candidates.getCandidate(
      {
        ownerId: operation.ownerId,
        teamId: operation.teamId,
        actorId: operation.actorId
      },
      operation.candidateId
    );
    if (!candidate
      || resolvedIdentityFingerprint(candidate)
        !== operation.identityFingerprint) {
      throw new InvalidStageResultError("IDENTITY_BINDING_CHANGED");
    }
  }

  private async executeToolWithHeartbeat(
    operation: AcquisitionCandidateIntelligenceOperationRecord,
    leaseToken: string,
    execution: AcquisitionToolExecutionInput,
    externalSignal?: AbortSignal
  ) {
    const controller = new AbortController();
    let leaseLost = false;
    let stopped = false;
    let heartbeatInFlight: Promise<void> | null = null;
    let rejectOnAbort!: (error: unknown) => void;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = reject;
    });
    const abort = (reason: unknown) => {
      if (controller.signal.aborted) return;
      controller.abort(reason);
      rejectOnAbort(reason);
    };
    const onExternalAbort = () => abort(
      externalSignal?.reason instanceof Error
        ? externalSignal.reason
        : new DOMException("aborted", "AbortError")
    );
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener("abort", onExternalAbort, {
      once: true
    });

    const heartbeat = () => {
      if (stopped || heartbeatInFlight) return;
      heartbeatInFlight = (async () => {
        try {
          const renewedAt = validIso(this.now());
          const renewed = await this.repository.renewLease(
            {
              ownerId: operation.ownerId,
              teamId: operation.teamId
            },
            operation.id,
            leaseToken,
            {
              renewedAt,
              leaseExpiresAt: new Date(
                Date.parse(renewedAt) + this.leaseDurationMs
              ).toISOString()
            }
          );
          if (!renewed) {
            leaseLost = true;
            abort(new AcquisitionCandidateIntelligenceOperationError(
              "OPERATION_ALREADY_RUNNING"
            ));
          }
        } catch {
          leaseLost = true;
          abort(new AcquisitionCandidateIntelligenceOperationError(
            "OPERATION_ALREADY_RUNNING"
          ));
        }
      })().finally(() => {
        heartbeatInFlight = null;
      });
    };
    const heartbeatHandle = this.heartbeatScheduler.setInterval(
      heartbeat,
      this.heartbeatIntervalMs
    );
    try {
      const executionPromise = this.executor.execute({
        ...execution,
        signal: controller.signal
      });
      const value = await Promise.race([executionPromise, abortPromise]);
      if (heartbeatInFlight) await heartbeatInFlight;
      if (leaseLost) {
        throw new AcquisitionCandidateIntelligenceOperationError(
          "OPERATION_ALREADY_RUNNING"
        );
      }
      if (externalSignal?.aborted) {
        throw externalSignal.reason instanceof Error
          ? externalSignal.reason
          : new DOMException("aborted", "AbortError");
      }
      return value;
    } catch (error) {
      if (heartbeatInFlight) await heartbeatInFlight;
      if (leaseLost) {
        throw new AcquisitionCandidateIntelligenceOperationError(
          "OPERATION_ALREADY_RUNNING"
        );
      }
      throw error;
    } finally {
      stopped = true;
      this.heartbeatScheduler.clearInterval(heartbeatHandle);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async executeClaimed(
    scope: AcquisitionCandidateIntelligenceScope,
    operationId: string,
    signal?: AbortSignal
  ): Promise<AcquisitionCandidateIntelligenceOperation> {
    const claimed = await this.repository.claimOperation(
      scope,
      operationId,
      this.nextClaim()
    );
    if (!claimed.operation) {
      throw new AcquisitionCandidateIntelligenceOperationError(
        "RESOURCE_NOT_FOUND"
      );
    }
    if (!claimed.claimed) {
      if (claimed.operation.status === "succeeded") {
        return publicOperation(claimed.operation);
      }
      throw new AcquisitionCandidateIntelligenceOperationError(
        "OPERATION_ALREADY_RUNNING"
      );
    }
    const operation = claimed.operation;
    const leaseToken = operation.leaseToken;
    if (!leaseToken) {
      throw new Error(
        "ACQUISITION_CANDIDATE_INTELLIGENCE_MISSING_LEASE_TOKEN"
      );
    }

    for (const stage of STAGES) {
      if (operation.completedStages.includes(stage)
        || operation.skippedStages.includes(stage)) {
        continue;
      }
      if (stage === "battle_card"
        && operation.qualification
        && !eligibleForBattleCard(operation.qualification)) {
        operation.skippedStages.push(stage);
        operation.currentStage = null;
        operation.updatedAt = validIso(this.now());
        await this.repository.saveOperation(operation, leaseToken);
        continue;
      }
      operation.currentStage = stage;
      operation.failure = null;
      operation.failedAt = null;
      operation.updatedAt = validIso(this.now());
      await this.repository.saveOperation(operation, leaseToken);
      try {
        await this.assertIdentityBinding(operation);
        if (signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        const blueprint = toolForStage(stage);
        const idempotencyKey = stageIdempotencyKey(operation, stage);
        const execution: AcquisitionToolExecutionInput = {
          identity: {
            ownerId: operation.ownerId,
            teamId: operation.teamId,
            actorId: operation.actorId,
            sessionId: operation.sessionId
          },
          toolName: blueprint.toolName,
          toolCallId: idempotencyKey,
          idempotencyKey,
          payload: blueprint.payload(operation.candidateId),
          signal: undefined
        };
        const value = await this.executeToolWithHeartbeat(
          operation,
          leaseToken,
          execution,
          signal
        );
        if (signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        if (stage === "research") {
          operation.research = researchResult(value);
        } else if (stage === "qualification") {
          operation.qualification = qualificationResult(value);
        } else {
          operation.battleCardId = battleCardId(value);
        }
        operation.completedStages.push(stage);
        operation.currentStage = null;
        operation.updatedAt = validIso(this.now());
        await this.repository.saveOperation(operation, leaseToken);
      } catch (error) {
        if (error instanceof AcquisitionCandidateIntelligenceOperationError
          && error.code === "OPERATION_ALREADY_RUNNING") {
          throw error;
        }
        const failedAt = validIso(this.now());
        operation.status = "failed";
        operation.failure = {
          stage,
          errorCode: stableFailureCode(error)
        };
        operation.currentStage = stage;
        operation.updatedAt = failedAt;
        operation.completedAt = null;
        operation.failedAt = failedAt;
        await this.repository.saveOperation(operation, leaseToken);
        return publicOperation(operation);
      }
    }

    const completedAt = validIso(this.now());
    operation.status = "succeeded";
    operation.currentStage = null;
    operation.failure = null;
    operation.failedAt = null;
    operation.updatedAt = completedAt;
    operation.completedAt = completedAt;
    await this.repository.saveOperation(operation, leaseToken);
    return publicOperation(operation);
  }
}
