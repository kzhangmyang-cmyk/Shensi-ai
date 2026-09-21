import { createHash, randomUUID } from "node:crypto";
import {
  discoveryEvidencePublicSourceUrl,
  type DiscoveryEvidence,
  type DiscoveryEvidenceInput
} from "./acquisition-domain.js";
import type {
  AcquisitionCandidateIntelligenceOperation,
  AcquisitionCandidateIntelligenceOperationService
} from "./acquisition-candidate-intelligence-operations.js";
import type {
  DouyinIdentityEvidence,
  DouyinIdentityResolutionOutcome
} from "./acquisition-douyin-identity-consensus.js";
import {
  decideDouyinIdentityConsensus
} from "./acquisition-douyin-identity-consensus.js";
import type {
  AcquisitionDouyinPublicProfileDiscoveryPort
} from "./acquisition-douyin-public-profile-discovery.js";
import {
  classifyDouyinPublicSource
} from "./acquisition-douyin-public-source.js";
import type {
  CandidateIdentityConfirmationInput,
  AcquisitionIdentityResolutionService
} from "./acquisition-identity-resolution-service.js";
import {
  isVerifiedAcquisitionPublicProfileUrl,
  normalizeAcquisitionPublicUrl
} from "./acquisition-public-identity-resolver.js";
import type {
  SearchPublicSourcesPort,
  SearchPublicSourcesResponse
} from "./acquisition-tool-executor.js";
import { AcquisitionDomainError } from "./acquisition-domain-service.js";
import type {
  AcquisitionProviderConnectionSnapshot
} from "./acquisition-plan-run-repository.js";

export type AcquisitionDouyinIdentityResolutionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "requires_review"
  | "failed";

export type AcquisitionDouyinIdentityResolutionStage =
  | "public_page"
  | "independent_search"
  | "consensus_gate"
  | "identity_confirmation"
  | "intelligence_dispatch";

export interface AcquisitionDouyinIdentityResolutionScope {
  ownerId: string;
  teamId: string;
  actorId: string;
}

export interface AcquisitionDouyinIdentityResolutionOperation {
  id: string;
  ownerId: string;
  teamId: string;
  actorId: string;
  candidateId: string;
  candidateVersion: number;
  sourceEvidenceFingerprint: string;
  searchConnections: AcquisitionProviderConnectionSnapshot[];
  planSessionId: string | null;
  status: AcquisitionDouyinIdentityResolutionStatus;
  currentStage: AcquisitionDouyinIdentityResolutionStage | null;
  outcome: DouyinIdentityResolutionOutcome | null;
  retryable: boolean;
  canonicalProfileUrl: string | null;
  profileCandidates: Array<{
    publicProfileUrl: string;
    evidenceIds: string[];
  }>;
  evidence: DouyinIdentityEvidence[];
  intelligenceOperationId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AcquisitionDouyinIdentityResolutionOperationRecord
extends AcquisitionDouyinIdentityResolutionOperation {
  sourceEvidenceIds?: string[];
  idempotencyKeyHash: string;
  requestHash: string;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
}

export interface AcquisitionDouyinIdentityResolutionClaim {
  leaseOwner: string;
  leaseToken: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface AcquisitionDouyinIdentityResolutionHeartbeatScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface AcquisitionDouyinIdentityResolutionRecoveryQuery {
  now: string;
  limit: number;
}

export type AcquisitionDouyinIdentityResolutionOperationErrorCode =
  | "INVALID_REQUEST"
  | "RESOURCE_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "OPERATION_ALREADY_RUNNING";

export class AcquisitionDouyinIdentityResolutionOperationError extends Error {
  constructor(
    public readonly code: AcquisitionDouyinIdentityResolutionOperationErrorCode
  ) {
    super(code);
    this.name = "AcquisitionDouyinIdentityResolutionOperationError";
  }
}

type TenantScope = Pick<
  AcquisitionDouyinIdentityResolutionScope,
  "ownerId" | "teamId"
>;

export interface AcquisitionDouyinIdentityResolutionOperationRepository {
  findOperationByIdempotency(input: {
    ownerId: string;
    teamId: string;
    idempotencyKeyHash: string;
  }): Promise<AcquisitionDouyinIdentityResolutionOperationRecord | null>;
  createOperation(
    operation: AcquisitionDouyinIdentityResolutionOperationRecord
  ): Promise<{
    operation: AcquisitionDouyinIdentityResolutionOperationRecord;
    created: boolean;
  }>;
  getOperation(
    scope: TenantScope,
    id: string
  ): Promise<AcquisitionDouyinIdentityResolutionOperationRecord | null>;
  findLatestForCandidate(
    scope: TenantScope,
    candidateId: string
  ): Promise<AcquisitionDouyinIdentityResolutionOperationRecord | null>;
  findSucceededForCandidateAndPlanSession(
    scope: TenantScope,
    candidateId: string,
    planSessionId: string
  ): Promise<AcquisitionDouyinIdentityResolutionOperationRecord | null>;
  listRecoverableOperations(
    input: AcquisitionDouyinIdentityResolutionRecoveryQuery
  ): Promise<AcquisitionDouyinIdentityResolutionOperationRecord[]>;
  claimOperation(
    scope: TenantScope,
    id: string,
    claim: AcquisitionDouyinIdentityResolutionClaim
  ): Promise<{
    operation: AcquisitionDouyinIdentityResolutionOperationRecord | null;
    claimed: boolean;
  }>;
  saveOperation(
    operation: AcquisitionDouyinIdentityResolutionOperationRecord,
    leaseToken: string
  ): Promise<void>;
  renewLease(
    scope: TenantScope,
    id: string,
    leaseToken: string,
    input: { renewedAt: string; leaseExpiresAt: string }
  ): Promise<boolean>;
}

export interface AcquisitionDouyinIdentityResolutionEvidencePort {
  getEvidence(
    scope: AcquisitionDouyinIdentityResolutionScope,
    evidenceId: string
  ): Promise<DiscoveryEvidence | null>;
  appendEvidence?(
    scope: AcquisitionDouyinIdentityResolutionScope,
    input: DiscoveryEvidenceInput,
    idempotencyKey: string
  ): Promise<DiscoveryEvidence>;
}

export interface AcquisitionDouyinIdentityResolutionCandidatePort {
  getCandidate(
    scope: AcquisitionDouyinIdentityResolutionScope,
    candidateId: string
  ): Promise<{ id: string; version: number } | null>;
}

export interface AcquisitionDouyinIdentityResolutionIdentityPort {
  resolveCandidateIdentity(
    scope: AcquisitionDouyinIdentityResolutionScope,
    candidateId: string,
    input: CandidateIdentityConfirmationInput,
    idempotencyKey: string
  ): Promise<unknown>;
}

export interface AcquisitionDouyinIdentityResolutionIntelligencePort {
  createAfterIdentity(
    scope: AcquisitionDouyinIdentityResolutionScope,
    candidateId: string,
    idempotencyKey: string,
    options?: { trustedSessionId?: string }
  ): Promise<AcquisitionCandidateIntelligenceOperation>;
  execute(
    scope: AcquisitionDouyinIdentityResolutionScope,
    operationId: string,
    signal?: AbortSignal
  ): Promise<AcquisitionCandidateIntelligenceOperation>;
}

export interface AcquisitionDouyinIdentityResolutionCreateInput {
  candidateId: string;
  expectedCandidateVersion: number;
  sourceEvidenceIds: string[];
  searchConnections: AcquisitionProviderConnectionSnapshot[];
  planSessionId?: string | null;
}

export interface AcquisitionDouyinIdentityResolutionOperationServiceOptions {
  repository: AcquisitionDouyinIdentityResolutionOperationRepository;
  evidence: AcquisitionDouyinIdentityResolutionEvidencePort;
  candidates?: AcquisitionDouyinIdentityResolutionCandidatePort;
  discovery?: AcquisitionDouyinPublicProfileDiscoveryPort;
  search?: SearchPublicSourcesPort;
  validateSearchConnection?: (input: {
    scope: AcquisitionDouyinIdentityResolutionScope;
    connection: AcquisitionProviderConnectionSnapshot;
  }) => Promise<void>;
  identityResolution?: AcquisitionDouyinIdentityResolutionIdentityPort
    | Pick<AcquisitionIdentityResolutionService, "resolveCandidateIdentity">;
  candidateIntelligence?: AcquisitionDouyinIdentityResolutionIntelligencePort
    | Pick<
      AcquisitionCandidateIntelligenceOperationService,
      "createAfterIdentity" | "execute"
    >;
  workerId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatScheduler?: AcquisitionDouyinIdentityResolutionHeartbeatScheduler;
  leaseTokenFactory?: () => string;
  idFactory?: () => string;
  now?: () => string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredText(value: unknown, max = 200) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max) {
    throw new AcquisitionDouyinIdentityResolutionOperationError(
      "INVALID_REQUEST"
    );
  }
  return normalized;
}

function scope(raw: AcquisitionDouyinIdentityResolutionScope) {
  return {
    ownerId: requiredText(raw.ownerId, 100),
    teamId: requiredText(raw.teamId, 100),
    actorId: requiredText(raw.actorId, 100)
  };
}

function validIso(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_INVALID_CLOCK");
  }
  return new Date(timestamp).toISOString();
}

function compareCodeUnits(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeStableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => [key, normalizeStableJson(item)]));
  }
  return value;
}

function stableHash(value: unknown) {
  return `sha256:${hash(JSON.stringify(normalizeStableJson(value)))}`;
}

function uniqueSortedIds(
  values: string[],
  options: { min: number; max: number }
) {
  if (!Array.isArray(values)
    || values.length < options.min
    || values.length > options.max) {
    throw new AcquisitionDouyinIdentityResolutionOperationError(
      "INVALID_REQUEST"
    );
  }
  const normalized = values.map((value) => requiredText(value, 255));
  if (new Set(normalized).size !== normalized.length) {
    throw new AcquisitionDouyinIdentityResolutionOperationError(
      "INVALID_REQUEST"
    );
  }
  return normalized.sort(compareCodeUnits);
}

function normalizedSearchConnections(
  values: AcquisitionProviderConnectionSnapshot[]
) {
  if (!Array.isArray(values) || values.length > 100) {
    throw new AcquisitionDouyinIdentityResolutionOperationError(
      "INVALID_REQUEST"
    );
  }
  const normalized = values.map((connection) => {
    if (!connection || typeof connection !== "object"
      || !Number.isSafeInteger(connection.credentialVersion)
      || connection.credentialVersion < 1
      || connection.kind !== "search"
      || connection.status !== "active") {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "INVALID_REQUEST"
      );
    }
    return {
      connectionId: requiredText(connection.connectionId, 255),
      providerId: requiredText(connection.providerId, 120),
      kind: "search" as const,
      status: "active" as const,
      credentialVersion: connection.credentialVersion
    };
  }).sort((left, right) =>
    compareCodeUnits(left.connectionId, right.connectionId));
  if (new Set(normalized.map((connection) => connection.connectionId)).size
    !== normalized.length) {
    throw new AcquisitionDouyinIdentityResolutionOperationError(
      "INVALID_REQUEST"
    );
  }
  return normalized;
}

function publicOperation(
  operation: AcquisitionDouyinIdentityResolutionOperationRecord
): AcquisitionDouyinIdentityResolutionOperation {
  const {
    sourceEvidenceIds: _sourceEvidenceIds,
    idempotencyKeyHash: _idempotencyKeyHash,
    requestHash: _requestHash,
    leaseOwner: _leaseOwner,
    leaseToken: _leaseToken,
    leaseExpiresAt: _leaseExpiresAt,
    ...value
  } = operation;
  return clone(value);
}

function normalizedDouyinProfileUrl(value: string) {
  const normalized = normalizeAcquisitionPublicUrl(value);
  return normalized
    && classifyDouyinPublicSource(normalized)?.sourceType === "profile"
    && isVerifiedAcquisitionPublicProfileUrl(normalized)
    ? normalized
    : null;
}

function discoveredPageProvesProfile(
  result: Extract<
    Awaited<ReturnType<AcquisitionDouyinPublicProfileDiscoveryPort["discover"]>>,
    { status: "succeeded" }
  >,
  publicProfileUrl: string
) {
  const finalRedirectUrl = normalizedDouyinProfileUrl(
    result.redirectChain.at(-1) ?? ""
  );
  const explicitProfileUrls = result.publicProfileUrls.map(
    normalizedDouyinProfileUrl
  );
  return finalRedirectUrl === publicProfileUrl
    && explicitProfileUrls.length > 0
    && explicitProfileUrls.every((url) => url === publicProfileUrl);
}

function boundedSearchQuery(evidence: DiscoveryEvidence) {
  const sourceUrl = discoveryEvidencePublicSourceUrl(evidence) ?? "";
  let videoId = "";
  try {
    videoId = /\/video\/([^/?#]+)/u.exec(new URL(sourceUrl).pathname)?.[1]
      ?? "";
  } catch {
    videoId = "";
  }
  return [
    videoId,
    sourceUrl,
    evidence.sourceTitle,
    evidence.sourceSnippet
  ]
    .map((value) => String(value).normalize("NFKC").replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 500)
    .trim();
}

function appendEvidenceKey(input: {
  requestHash: string;
  evidenceClass: "public" | "search";
  sourceEvidenceId: string;
  sourceUrl: string;
  provider?: string;
  providerConnectionId?: string;
  requestId?: string;
  providerRecordId?: string;
  resultRank?: number;
}) {
  return `douyin-identity:evidence:${stableHash(input)}`;
}

function validAuditedSearchResponse(
  response: SearchPublicSourcesResponse,
  connection: AcquisitionProviderConnectionSnapshot
) {
  return response.providerConnectionId === connection.connectionId
    && response.provider === connection.providerId
    && response.providerCredentialVersion === connection.credentialVersion
    && Boolean(response.requestId.trim());
}

function validPlanSessionId(value: string) {
  return /^acquisition-plan:[A-Za-z0-9._:-]{1,200}$/u.test(value);
}

function idempotencyMapKey(input: {
  ownerId: string;
  teamId: string;
  idempotencyKeyHash: string;
}) {
  return [input.ownerId, input.teamId, input.idempotencyKeyHash].join("\u001f");
}

export class InMemoryAcquisitionDouyinIdentityResolutionOperationRepository
implements AcquisitionDouyinIdentityResolutionOperationRepository {
  private readonly operations = new Map<
    string,
    AcquisitionDouyinIdentityResolutionOperationRecord
  >();
  private readonly idempotency = new Map<string, string>();

  async findOperationByIdempotency(input: {
    ownerId: string;
    teamId: string;
    idempotencyKeyHash: string;
  }) {
    const id = this.idempotency.get(idempotencyMapKey(input));
    return id ? clone(this.operations.get(id)!) : null;
  }

  async createOperation(
    operation: AcquisitionDouyinIdentityResolutionOperationRecord
  ) {
    const key = idempotencyMapKey(operation);
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.operations.get(existingId)!;
      if (existing.candidateId !== operation.candidateId) {
        throw new AcquisitionDouyinIdentityResolutionOperationError(
          "IDEMPOTENCY_CONFLICT"
        );
      }
      return { operation: clone(existing), created: false };
    }
    const candidateOperations = [...this.operations.values()]
      .filter((candidateOperation) =>
        candidateOperation.ownerId === operation.ownerId
        && candidateOperation.teamId === operation.teamId
        && candidateOperation.candidateId === operation.candidateId);
    const blocked = candidateOperations.some((candidateOperation) =>
      !(candidateOperation.status === "failed"
        && candidateOperation.retryable
        && candidateOperation.outcome === "provider_unavailable"));
    if (blocked) {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "OPERATION_ALREADY_RUNNING"
      );
    }
    this.operations.set(operation.id, clone(operation));
    this.idempotency.set(key, operation.id);
    return { operation: clone(operation), created: true };
  }

  async getOperation(rawScope: TenantScope, id: string) {
    const operation = this.operations.get(id);
    return operation
      && operation.ownerId === rawScope.ownerId
      && operation.teamId === rawScope.teamId
      ? clone(operation)
      : null;
  }

  async findLatestForCandidate(rawScope: TenantScope, candidateId: string) {
    const latest = [...this.operations.values()]
      .filter((operation) =>
        operation.ownerId === rawScope.ownerId
        && operation.teamId === rawScope.teamId
        && operation.candidateId === candidateId)
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
        || right.id.localeCompare(left.id))[0];
    return latest ? clone(latest) : null;
  }

  async findSucceededForCandidateAndPlanSession(
    rawScope: TenantScope,
    candidateId: string,
    planSessionId: string
  ) {
    const latest = [...this.operations.values()]
      .filter((operation) =>
        operation.ownerId === rawScope.ownerId
        && operation.teamId === rawScope.teamId
        && operation.candidateId === candidateId
        && operation.planSessionId === planSessionId
        && operation.status === "succeeded"
        && operation.intelligenceOperationId !== null)
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
        || right.id.localeCompare(left.id))[0];
    return latest ? clone(latest) : null;
  }

  async listRecoverableOperations(
    input: AcquisitionDouyinIdentityResolutionRecoveryQuery
  ) {
    return [...this.operations.values()]
      .filter((operation) =>
        operation.status === "queued"
        || (operation.status === "running"
          && operation.leaseExpiresAt !== null
          && operation.leaseExpiresAt <= input.now))
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id))
      .slice(0, input.limit)
      .map(clone);
  }

  async claimOperation(
    rawScope: TenantScope,
    id: string,
    claim: AcquisitionDouyinIdentityResolutionClaim
  ) {
    const stored = this.operations.get(id);
    if (!stored
      || stored.ownerId !== rawScope.ownerId
      || stored.teamId !== rawScope.teamId) {
      return { operation: null, claimed: false };
    }
    const operation = clone(stored);
    const claimable = operation.status === "queued"
      || (operation.status === "running"
        && operation.leaseExpiresAt !== null
        && operation.leaseExpiresAt <= claim.claimedAt);
    if (!claimable) return { operation, claimed: false };
    const claimed = clone({
      ...operation,
      status: "running" as const,
      updatedAt: claim.claimedAt,
      completedAt: null,
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
      leaseExpiresAt: claim.leaseExpiresAt
    });
    this.operations.set(id, clone(claimed));
    return { operation: claimed, claimed: true };
  }

  async saveOperation(
    operation: AcquisitionDouyinIdentityResolutionOperationRecord,
    leaseToken: string
  ) {
    const existing = this.operations.get(operation.id);
    if (!existing
      || existing.ownerId !== operation.ownerId
      || existing.teamId !== operation.teamId) {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "RESOURCE_NOT_FOUND"
      );
    }
    if (existing.status !== "running" || existing.leaseToken !== leaseToken) {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
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
    rawScope: TenantScope,
    id: string,
    leaseToken: string,
    input: { renewedAt: string; leaseExpiresAt: string }
  ) {
    const operation = this.operations.get(id);
    if (!operation
      || operation.ownerId !== rawScope.ownerId
      || operation.teamId !== rawScope.teamId
      || operation.status !== "running"
      || operation.leaseToken !== leaseToken
      || operation.leaseExpiresAt === null
      || operation.leaseExpiresAt <= input.renewedAt) {
      return false;
    }
    operation.leaseExpiresAt = input.leaseExpiresAt;
    operation.updatedAt = input.renewedAt;
    this.operations.set(id, clone(operation));
    return true;
  }
}

export class AcquisitionDouyinIdentityResolutionOperationService {
  private readonly repository:
    AcquisitionDouyinIdentityResolutionOperationRepository;
  private readonly evidence: AcquisitionDouyinIdentityResolutionEvidencePort;
  private readonly candidates:
    AcquisitionDouyinIdentityResolutionCandidatePort | null;
  private readonly discovery:
    AcquisitionDouyinPublicProfileDiscoveryPort | null;
  private readonly search: SearchPublicSourcesPort | null;
  private readonly validateSearchConnection: ((input: {
    scope: AcquisitionDouyinIdentityResolutionScope;
    connection: AcquisitionProviderConnectionSnapshot;
  }) => Promise<void>) | null;
  private readonly identityResolution:
    AcquisitionDouyinIdentityResolutionIdentityPort | null;
  private readonly candidateIntelligence:
    AcquisitionDouyinIdentityResolutionIntelligencePort | null;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatScheduler:
    AcquisitionDouyinIdentityResolutionHeartbeatScheduler;
  private readonly leaseTokenFactory: () => string;
  private readonly idFactory: () => string;
  private readonly now: () => string;
  private readonly running = new Map<
    string,
    Promise<AcquisitionDouyinIdentityResolutionOperation>
  >();

  constructor(options: AcquisitionDouyinIdentityResolutionOperationServiceOptions) {
    this.repository = options.repository;
    this.evidence = options.evidence;
    this.candidates = options.candidates ?? null;
    this.discovery = options.discovery ?? null;
    this.search = options.search ?? null;
    this.validateSearchConnection = options.validateSearchConnection ?? null;
    this.identityResolution = options.identityResolution ?? null;
    this.candidateIntelligence = options.candidateIntelligence ?? null;
    this.workerId = requiredText(
      options.workerId ?? `douyin-identity-worker-${randomUUID()}`,
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
      ?? (() => `douyin-identity-resolution-${randomUUID()}`);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async create(
    rawScope: AcquisitionDouyinIdentityResolutionScope,
    rawInput: AcquisitionDouyinIdentityResolutionCreateInput,
    idempotencyKeyInput: string
  ) {
    return (await this.createWithResult(
      rawScope,
      rawInput,
      idempotencyKeyInput
    )).operation;
  }

  async createWithResult(
    rawScope: AcquisitionDouyinIdentityResolutionScope,
    rawInput: AcquisitionDouyinIdentityResolutionCreateInput,
    idempotencyKeyInput: string
  ) {
    const validatedScope = scope(rawScope);
    const candidateId = requiredText(rawInput.candidateId, 120);
    const idempotencyKeyHash = hash(requiredText(idempotencyKeyInput, 200));
    const existing = await this.repository.findOperationByIdempotency({
      ownerId: validatedScope.ownerId,
      teamId: validatedScope.teamId,
      idempotencyKeyHash
    });
    if (existing) {
      if (existing.candidateId !== candidateId) {
        throw new AcquisitionDouyinIdentityResolutionOperationError(
          "IDEMPOTENCY_CONFLICT"
        );
      }
      return { operation: publicOperation(existing), replayed: true };
    }
    if (!Number.isSafeInteger(rawInput.expectedCandidateVersion)
      || rawInput.expectedCandidateVersion < 1) {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "INVALID_REQUEST"
      );
    }
    const sourceEvidenceIds = uniqueSortedIds(rawInput.sourceEvidenceIds, {
      min: 1,
      max: 500
    });
    const searchConnections = normalizedSearchConnections(
      rawInput.searchConnections
    );
    const planSessionId = rawInput.planSessionId === null
      || rawInput.planSessionId === undefined
      ? null
      : requiredText(rawInput.planSessionId, 255);
    if (planSessionId && !validPlanSessionId(planSessionId)) {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "INVALID_REQUEST"
      );
    }
    const sourceEvidence = await Promise.all(sourceEvidenceIds.map(async (id) => {
      const item = await this.evidence.getEvidence(validatedScope, id);
      if (!item) {
        throw new AcquisitionDouyinIdentityResolutionOperationError(
          "RESOURCE_NOT_FOUND"
        );
      }
      return {
        contentHash: requiredText(item.contentHash, 200),
        rawArtifactHash: requiredText(item.rawArtifactHash, 200)
      };
    }));
    const sortedSourceHashes = sourceEvidence.sort((left, right) =>
      compareCodeUnits(left.contentHash, right.contentHash)
      || compareCodeUnits(left.rawArtifactHash, right.rawArtifactHash));
    const sourceEvidenceFingerprint = stableHash(sortedSourceHashes);
    const requestHash = stableHash({
      candidateId,
      candidateVersion: rawInput.expectedCandidateVersion,
      sourceEvidence: sortedSourceHashes,
      searchConnections,
      planSessionId
    });
    const now = validIso(this.now());
    const operation: AcquisitionDouyinIdentityResolutionOperationRecord = {
      id: requiredText(this.idFactory(), 160),
      ...validatedScope,
      candidateId,
      candidateVersion: rawInput.expectedCandidateVersion,
      sourceEvidenceFingerprint,
      searchConnections,
      planSessionId,
      status: "queued",
      currentStage: null,
      outcome: null,
      retryable: false,
      canonicalProfileUrl: null,
      profileCandidates: [],
      evidence: [],
      intelligenceOperationId: null,
      sourceEvidenceIds,
      idempotencyKeyHash,
      requestHash,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };
    const result = await this.repository.createOperation(operation);
    return {
      operation: publicOperation(result.operation),
      replayed: !result.created
    };
  }

  async get(rawScope: AcquisitionDouyinIdentityResolutionScope, idInput: string) {
    const validatedScope = scope(rawScope);
    const operation = await this.repository.getOperation(
      validatedScope,
      requiredText(idInput, 160)
    );
    return operation ? publicOperation(operation) : null;
  }

  async findIdempotentReplay(
    rawScope: AcquisitionDouyinIdentityResolutionScope,
    candidateIdInput: string,
    idempotencyKeyInput: string
  ) {
    const validatedScope = scope(rawScope);
    const candidateId = requiredText(candidateIdInput, 120);
    const operation = await this.repository.findOperationByIdempotency({
      ownerId: validatedScope.ownerId,
      teamId: validatedScope.teamId,
      idempotencyKeyHash: hash(requiredText(idempotencyKeyInput, 200))
    });
    if (operation && operation.candidateId !== candidateId) {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "IDEMPOTENCY_CONFLICT"
      );
    }
    return operation ? publicOperation(operation) : null;
  }

  async findLatestForCandidate(
    rawScope: AcquisitionDouyinIdentityResolutionScope,
    candidateIdInput: string
  ) {
    const validatedScope = scope(rawScope);
    const operation = await this.repository.findLatestForCandidate(
      validatedScope,
      requiredText(candidateIdInput, 120)
    );
    return operation ? publicOperation(operation) : null;
  }

  async findSucceededForCandidateAndPlanSession(
    rawScope: AcquisitionDouyinIdentityResolutionScope,
    candidateIdInput: string,
    planSessionIdInput: string
  ) {
    const validatedScope = scope(rawScope);
    const planSessionId = requiredText(planSessionIdInput, 255);
    if (!validPlanSessionId(planSessionId)) {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "INVALID_REQUEST"
      );
    }
    const operation = await this.repository
      .findSucceededForCandidateAndPlanSession(
        validatedScope,
        requiredText(candidateIdInput, 120),
        planSessionId
      );
    return operation ? publicOperation(operation) : null;
  }

  async listRecoverableOperations(options: { limit: number }) {
    if (!Number.isSafeInteger(options.limit)
      || options.limit < 1
      || options.limit > 100) {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "INVALID_REQUEST"
      );
    }
    const operations = await this.repository.listRecoverableOperations({
      now: validIso(this.now()),
      limit: options.limit
    });
    return operations.map(publicOperation);
  }

  execute(
    rawScope: AcquisitionDouyinIdentityResolutionScope,
    operationIdInput: string,
    signal?: AbortSignal
  ) {
    const validatedScope = scope(rawScope);
    const operationId = requiredText(operationIdInput, 160);
    const key = [
      validatedScope.ownerId,
      validatedScope.teamId,
      operationId
    ].join("\u001f");
    const current = this.running.get(key);
    if (current) return current;
    const running = this.executeClaimed(
      validatedScope,
      operationId,
      signal
    );
    this.running.set(key, running);
    void running.then(
      () => this.running.delete(key),
      () => this.running.delete(key)
    );
    return running;
  }

  private async executeClaimed(
    validatedScope: AcquisitionDouyinIdentityResolutionScope,
    operationId: string,
    signal?: AbortSignal
  ) {
    const dependencies = {
      candidates: this.candidates,
      discovery: this.discovery,
      search: this.search,
      validateSearchConnection: this.validateSearchConnection,
      appendEvidence: this.evidence.appendEvidence,
      identityResolution: this.identityResolution,
      candidateIntelligence: this.candidateIntelligence
    };
    if (!dependencies.candidates
      || !dependencies.discovery
      || !dependencies.search
      || !dependencies.validateSearchConnection
      || !dependencies.appendEvidence
      || !dependencies.identityResolution
      || !dependencies.candidateIntelligence) {
      throw new Error(
        "ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_EXECUTION_NOT_CONFIGURED"
      );
    }
    const candidateIntelligence = dependencies.candidateIntelligence;
    const identityResolution = dependencies.identityResolution;
    if (signal?.aborted) throw signal.reason;
    const persisted = await this.repository.getOperation(
      validatedScope,
      operationId
    );
    if (!persisted) {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "RESOURCE_NOT_FOUND"
      );
    }
    if (persisted.planSessionId
      && !validPlanSessionId(persisted.planSessionId)) {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "INVALID_REQUEST"
      );
    }
    const claimedAt = validIso(this.now());
    const claimed = await this.repository.claimOperation(
      validatedScope,
      operationId,
      {
        leaseOwner: this.workerId,
        leaseToken: requiredText(this.leaseTokenFactory(), 200),
        claimedAt,
        leaseExpiresAt: new Date(
          Date.parse(claimedAt) + this.leaseDurationMs
        ).toISOString()
      }
    );
    if (!claimed.operation) {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "RESOURCE_NOT_FOUND"
      );
    }
    if (!claimed.claimed) {
      if (["succeeded", "requires_review", "failed"].includes(
        claimed.operation.status
      )) {
        return publicOperation(claimed.operation);
      }
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "OPERATION_ALREADY_RUNNING"
      );
    }
    const operation = claimed.operation;
    const leaseToken = operation.leaseToken;
    if (!leaseToken) {
      throw new Error(
        "ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MISSING_LEASE_TOKEN"
      );
    }
    if (operation.planSessionId
      && !validPlanSessionId(operation.planSessionId)) {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "INVALID_REQUEST"
      );
    }
    const controller = new AbortController();
    let stopped = false;
    let leaseLost = false;
    let heartbeatInFlight: Promise<void> | null = null;
    const abort = (reason: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const onExternalAbort = () => abort(
      signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("aborted", "AbortError")
    );
    if (signal?.aborted) onExternalAbort();
    else signal?.addEventListener("abort", onExternalAbort, { once: true });
    const heartbeat = () => {
      if (stopped || heartbeatInFlight) return;
      heartbeatInFlight = (async () => {
        try {
          const renewedAt = validIso(this.now());
          const leaseExpiresAt = new Date(
            Date.parse(renewedAt) + this.leaseDurationMs
          ).toISOString();
          const renewed = await this.repository.renewLease(
            validatedScope,
            operation.id,
            leaseToken,
            {
              renewedAt,
              leaseExpiresAt
            }
          );
          if (!renewed) {
            leaseLost = true;
            abort(new AcquisitionDouyinIdentityResolutionOperationError(
              "OPERATION_ALREADY_RUNNING"
            ));
          } else {
            operation.leaseExpiresAt = leaseExpiresAt;
          }
        } catch {
          leaseLost = true;
          abort(new AcquisitionDouyinIdentityResolutionOperationError(
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
    const assertLease = async () => {
      if (heartbeatInFlight) await heartbeatInFlight;
      if (leaseLost) {
        throw new AcquisitionDouyinIdentityResolutionOperationError(
          "OPERATION_ALREADY_RUNNING"
        );
      }
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new DOMException("aborted", "AbortError");
      }
      try {
        const renewedAt = validIso(this.now());
        const leaseExpiresAt = new Date(
          Date.parse(renewedAt) + this.leaseDurationMs
        ).toISOString();
        const renewed = await this.repository.renewLease(
          validatedScope,
          operation.id,
          leaseToken,
          {
            renewedAt,
            leaseExpiresAt
          }
        );
        if (!renewed) {
          throw new AcquisitionDouyinIdentityResolutionOperationError(
            "OPERATION_ALREADY_RUNNING"
          );
        }
        operation.leaseExpiresAt = leaseExpiresAt;
      } catch {
        leaseLost = true;
        const error = new AcquisitionDouyinIdentityResolutionOperationError(
          "OPERATION_ALREADY_RUNNING"
        );
        abort(error);
        throw error;
      }
    };
    const executionSignal = controller.signal;
    const saveRunning = async (
      currentStage: AcquisitionDouyinIdentityResolutionStage
    ) => {
      await assertLease();
      operation.currentStage = currentStage;
      operation.updatedAt = validIso(this.now());
      await this.repository.saveOperation(operation, leaseToken);
    };
    const finish = async (
      outcome: DouyinIdentityResolutionOutcome,
      decision: {
        canonicalProfileUrl: string | null;
        profileCandidates: AcquisitionDouyinIdentityResolutionOperation[
          "profileCandidates"
        ];
      }
    ) => {
      await assertLease();
      operation.status = outcome === "verified_consensus"
        ? "succeeded"
        : outcome === "provider_unavailable"
          ? "failed"
          : "requires_review";
      operation.outcome = outcome;
      operation.retryable = outcome === "provider_unavailable";
      operation.canonicalProfileUrl = decision.canonicalProfileUrl;
      operation.profileCandidates = decision.profileCandidates;
      operation.currentStage = null;
      operation.updatedAt = validIso(this.now());
      operation.completedAt = operation.updatedAt;
      await this.repository.saveOperation(operation, leaseToken);
      return publicOperation(operation);
    };
    const dispatchIntelligence = async () => {
      let intelligence: AcquisitionCandidateIntelligenceOperation;
      if (operation.intelligenceOperationId) {
        await assertLease();
        intelligence = await candidateIntelligence.execute(
          validatedScope,
          operation.intelligenceOperationId,
          executionSignal
        );
      } else {
        await assertLease();
        intelligence = await candidateIntelligence
          .createAfterIdentity(
            validatedScope,
            operation.candidateId,
            `douyin-identity:intelligence:${operation.requestHash}`,
            operation.planSessionId
              ? { trustedSessionId: operation.planSessionId }
              : {}
          );
        operation.intelligenceOperationId = intelligence.id;
        operation.updatedAt = validIso(this.now());
        await assertLease();
        await this.repository.saveOperation(operation, leaseToken);
        await assertLease();
        intelligence = await candidateIntelligence.execute(
          validatedScope,
          intelligence.id,
          executionSignal
        );
      }
      return intelligence;
    };
    const commitIdentity = async (decision: {
      canonicalProfileUrl: string;
      profileCandidates: AcquisitionDouyinIdentityResolutionOperation[
        "profileCandidates"
      ];
    }): Promise<"stale_candidate" | "conflicting" | null> => {
      const verifiedEvidenceIds = decision.profileCandidates.find((item) =>
        item.publicProfileUrl === decision.canonicalProfileUrl
      )?.evidenceIds ?? [];
      await assertLease();
      try {
        await identityResolution.resolveCandidateIdentity(
          validatedScope,
          operation.candidateId,
          {
            expectedCandidateVersion: operation.candidateVersion,
            evidenceIds: verifiedEvidenceIds,
            rationale: "抖音公开页与独立搜索结果共同指向唯一公开主页。",
            subject: {
              kind: "individual",
              publicProfileUrl: decision.canonicalProfileUrl,
              sourcePlatform: "douyin"
            }
          },
          `douyin-identity:commit:${operation.requestHash}`
        );
      } catch (error) {
        if (error instanceof AcquisitionDomainError) {
          if (error.code === "stale_candidate") return "stale_candidate";
          if (error.code === "identity_conflict") return "conflicting";
        }
        throw error;
      }
      return null;
    };

    try {
    if (operation.currentStage === "identity_confirmation"
      && operation.outcome === "verified_consensus"
      && operation.canonicalProfileUrl) {
      const decision = {
        canonicalProfileUrl: operation.canonicalProfileUrl,
        profileCandidates: operation.profileCandidates
      };
      const commitOutcome = await commitIdentity(decision);
      if (commitOutcome) {
        return finish(commitOutcome, {
          canonicalProfileUrl: null,
          profileCandidates: commitOutcome === "conflicting"
            ? decision.profileCandidates
            : []
        });
      }
      await saveRunning("intelligence_dispatch");
      await dispatchIntelligence();
      return finish("verified_consensus", decision);
    }
    if (operation.currentStage === "intelligence_dispatch"
      && operation.outcome === "verified_consensus"
      && operation.canonicalProfileUrl) {
      await dispatchIntelligence();
      return finish("verified_consensus", {
        canonicalProfileUrl: operation.canonicalProfileUrl,
        profileCandidates: operation.profileCandidates
      });
    }

    const sourceEvidenceIds = operation.sourceEvidenceIds ?? [];
    const sources = await Promise.all(sourceEvidenceIds.map(async (id) => {
      const item = await this.evidence.getEvidence(validatedScope, id);
      if (!item) {
        throw new AcquisitionDouyinIdentityResolutionOperationError(
          "RESOURCE_NOT_FOUND"
        );
      }
      return item;
    }));
    const collected: DouyinIdentityEvidence[] = [];

    await saveRunning("public_page");
    for (const source of sources) {
      if (executionSignal.aborted) throw executionSignal.reason;
      const sourceUrl = discoveryEvidencePublicSourceUrl(source);
      if (!sourceUrl) continue;
      const discovered = await dependencies.discovery.discover({
        sourceUrl,
        sourceEvidenceId: source.id,
        signal: executionSignal
      });
      if (discovered.status !== "succeeded") {
        if (discovered.status !== "not_found") {
          collected.push({
            evidenceId: source.id,
            evidenceClass: "douyin_public_page",
            publicProfileUrl: "",
            sourceUrl,
            sourceFingerprint: source.rawArtifactHash,
            accessStatus: discovered.status,
            fetchedAt: validIso(this.now())
          });
        }
        continue;
      }
      for (const explicitUrl of discovered.publicProfileUrls) {
        const publicProfileUrl = normalizedDouyinProfileUrl(explicitUrl);
        if (!publicProfileUrl) continue;
        const profile = await dependencies.discovery.discover({
          sourceUrl: publicProfileUrl,
          sourceEvidenceId: source.id,
          signal: executionSignal
        });
        if (profile.status !== "succeeded") {
          if (profile.status !== "not_found") {
            collected.push({
              evidenceId: source.id,
              evidenceClass: "douyin_public_page",
              publicProfileUrl,
              sourceUrl: publicProfileUrl,
              sourceFingerprint: source.rawArtifactHash,
              accessStatus: profile.status,
              fetchedAt: validIso(this.now())
            });
          }
          continue;
        }
        if (!discoveredPageProvesProfile(profile, publicProfileUrl)) {
          collected.push({
            evidenceId: source.id,
            evidenceClass: "douyin_public_page",
            publicProfileUrl,
            sourceUrl: publicProfileUrl,
            sourceFingerprint: profile.rawArtifactHash,
            accessStatus: "redirect_not_allowed",
            fetchedAt: validIso(this.now())
          });
          continue;
        }
        await assertLease();
        const created = await dependencies.appendEvidence.call(
          this.evidence,
          validatedScope,
          {
            targetType: "individual_signal",
            sourcePlatform: "douyin",
            sourceTitle: source.sourceTitle,
            sourceSnippet: source.sourceSnippet,
            publishedAt: source.publishedAt,
            locale: source.locale,
            rawArtifactHash: profile.rawArtifactHash,
            contentHash: profile.contentHash,
            provenance: {
              kind: "controlled_public_page",
              sourceUrl: publicProfileUrl,
              discoveredFromEvidenceId: source.id,
              redirectChain: profile.redirectChain,
              extractorVersion: "douyin-public-profile-v1"
            },
            accessStatus: "public_content",
            supersedesEvidenceId: null
          },
          appendEvidenceKey({
            requestHash: operation.requestHash,
            evidenceClass: "public",
            sourceEvidenceId: source.id,
            sourceUrl: publicProfileUrl
          })
        );
        collected.push({
          evidenceId: created.id,
          evidenceClass: "douyin_public_page",
          publicProfileUrl,
          sourceUrl: publicProfileUrl,
          sourceFingerprint: profile.rawArtifactHash,
          accessStatus: "public_content",
          fetchedAt: created.fetchedAt
        });
      }
    }

    await saveRunning("independent_search");
    let validSearchResponses = 0;
    for (const source of sources) {
      const query = boundedSearchQuery(source);
      if (!query) continue;
      for (const connection of operation.searchConnections) {
        if (executionSignal.aborted) throw executionSignal.reason;
        let response: SearchPublicSourcesResponse;
        try {
          await dependencies.validateSearchConnection({
            scope: validatedScope,
            connection
          });
          await assertLease();
          response = await dependencies.search.search({
            ...validatedScope,
            sessionId: operation.planSessionId
              ?? `douyin-identity-search:${operation.requestHash}`,
            providerConnectionId: connection.connectionId,
            expectedConnection: {
              providerId: connection.providerId,
              credentialVersion: connection.credentialVersion
            },
            query,
            subjectKinds: ["individual"],
            maxResults: 10,
            signal: executionSignal
          });
        } catch {
          continue;
        }
        if (!validAuditedSearchResponse(
          response,
          connection
        )) {
          continue;
        }
        validSearchResponses += 1;
        for (let index = 0; index < response.results.slice(0, 10).length; index += 1) {
          const result = response.results[index]!;
          const publicProfileUrl = normalizedDouyinProfileUrl(
            result.sourceUrl
          );
          if (!publicProfileUrl
            || !result.providerRecordId.trim()
            || result.accessStatus === "access_restricted") {
            continue;
          }
          await assertLease();
          const created = await dependencies.appendEvidence.call(
            this.evidence,
            validatedScope,
            {
              targetType: "individual_signal",
              sourcePlatform: "douyin",
              sourceTitle: result.title,
              sourceSnippet: result.snippet,
              publishedAt: result.publishedAt,
              locale: result.locale,
              rawArtifactHash: result.rawArtifactHash,
              contentHash: stableHash({
                sourceUrl: publicProfileUrl,
                title: result.title,
                snippet: result.snippet
              }),
              provenance: {
                kind: "search_result",
                provider: response.provider,
                providerConnectionId: response.providerConnectionId,
                requestId: response.requestId,
                providerRecordId: result.providerRecordId,
                queryText: query,
                sourceUrl: publicProfileUrl,
                resultRank: index + 1,
                sourceType: "profile"
              },
              accessStatus: result.accessStatus,
              supersedesEvidenceId: null
            },
            appendEvidenceKey({
              requestHash: operation.requestHash,
              evidenceClass: "search",
              sourceEvidenceId: source.id,
              sourceUrl: publicProfileUrl,
              provider: response.provider,
              providerConnectionId: connection.connectionId,
              requestId: response.requestId,
              providerRecordId: result.providerRecordId,
              resultRank: index + 1
            })
          );
          collected.push({
            evidenceId: created.id,
            evidenceClass: "independent_search_result",
            publicProfileUrl,
            sourceUrl: publicProfileUrl,
            sourceFingerprint: result.rawArtifactHash,
            accessStatus: result.accessStatus,
            fetchedAt: created.fetchedAt
          });
        }
      }
    }
    if (validSearchResponses === 0) {
      collected.push({
        evidenceId: operation.id,
        evidenceClass: "independent_search_result",
        publicProfileUrl: "",
        sourceUrl: "",
        sourceFingerprint: operation.requestHash,
        accessStatus: "provider_unavailable",
        fetchedAt: validIso(this.now())
      });
    }

    await saveRunning("consensus_gate");
    const candidate = await dependencies.candidates.getCandidate(
      validatedScope,
      operation.candidateId
    );
    if (!candidate) {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "RESOURCE_NOT_FOUND"
      );
    }
    const decision = decideDouyinIdentityConsensus({
      expectedCandidateVersion: operation.candidateVersion,
      currentCandidateVersion: candidate.version,
      evidence: collected
    });
    operation.evidence = collected;
    operation.outcome = decision.outcome;
    operation.canonicalProfileUrl = decision.canonicalProfileUrl;
    operation.profileCandidates = decision.profileCandidates;
    operation.updatedAt = validIso(this.now());
    await assertLease();
    await this.repository.saveOperation(operation, leaseToken);
    if (decision.outcome !== "verified_consensus"
      || !decision.canonicalProfileUrl) {
      return finish(decision.outcome, decision);
    }

    await saveRunning("identity_confirmation");
    const latestCandidate = await dependencies.candidates.getCandidate(
      validatedScope,
      operation.candidateId
    );
    if (!latestCandidate) {
      throw new AcquisitionDouyinIdentityResolutionOperationError(
        "RESOURCE_NOT_FOUND"
      );
    }
    if (latestCandidate.version !== operation.candidateVersion) {
      return finish("stale_candidate", {
        canonicalProfileUrl: null,
        profileCandidates: []
      });
    }
    const commitDecision = {
      canonicalProfileUrl: decision.canonicalProfileUrl,
      profileCandidates: decision.profileCandidates
    };
    const commitOutcome = await commitIdentity(commitDecision);
    if (commitOutcome) {
      return finish(commitOutcome, {
        canonicalProfileUrl: null,
        profileCandidates: commitOutcome === "conflicting"
          ? commitDecision.profileCandidates
          : []
      });
    }

    await saveRunning("intelligence_dispatch");
    await dispatchIntelligence();
    return finish("verified_consensus", decision);
    } finally {
      stopped = true;
      this.heartbeatScheduler.clearInterval(heartbeatHandle);
      if (heartbeatInFlight) await heartbeatInFlight;
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
