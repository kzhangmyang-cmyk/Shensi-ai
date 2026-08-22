import { createHash, randomUUID } from "node:crypto";
import type {
  AcquisitionAuditEvent,
  AcquisitionBudgetLimit,
  AcquisitionBudgetUsage,
  AcquisitionExecutionIntent,
  AcquisitionExecutionIntentKind,
  AcquisitionIdempotencyRecord,
  AcquisitionOperationShard,
  AcquisitionPlan,
  AcquisitionPlanEvent,
  AcquisitionPlanPayload,
  AcquisitionPlanRunRepository,
  AcquisitionPlanRunRepositoryTransaction,
  AcquisitionPlanVersion,
  AcquisitionProviderConnectionSnapshot,
  AcquisitionRun,
  AcquisitionRunEvent,
  AcquisitionRunStatus,
  AcquisitionShardStatus,
  AcquisitionUsageIdempotencyRecord
} from "./acquisition-plan-run-repository.js";
import {
  intentNeedsRecovery
} from "./acquisition-plan-run-repository.js";
import {
  acquisitionPlanPayloadContractSchema
} from "./acquisition-plan-contract.js";
import type {
  AcquisitionShardPresentationResult
} from "./acquisition-plan-execution-worker.js";
import { planReadinessIssues } from "./acquisition-plan-readiness.js";

export { planReadinessIssues } from "./acquisition-plan-readiness.js";

export type {
  AcquisitionBudgetLimit,
  AcquisitionBudgetSnapshot,
  AcquisitionBudgetUsage,
  AcquisitionModelSnapshotRef,
  AcquisitionOperationKind,
  AcquisitionOperationShard,
  AcquisitionPlan,
  AcquisitionPlanOperation,
  AcquisitionPlanPayload,
  AcquisitionPlanStatus,
  AcquisitionProviderConnectionSnapshot,
  AcquisitionProviderKind,
  AcquisitionRun,
  AcquisitionRunStatus,
  AcquisitionShardStatus,
  AcquisitionSubjectChannel
} from "./acquisition-plan-run-repository.js";

export type AcquisitionPlanDraftInput = AcquisitionPlanPayload;

export interface AcquisitionScope {
  ownerId: string;
  teamId: string;
  actorId: string;
}

export interface AcquisitionExecutionPort {
  enqueue(input: {
    runId: string;
    shardIds: string[];
    dispatchKey: string;
  }): Promise<void>;
  requestPause(input: {
    runId: string;
    shardIds: string[];
    dispatchKey: string;
  }): Promise<void>;
  resume(input: {
    runId: string;
    shardIds: string[];
    dispatchKey: string;
  }): Promise<void>;
  requestCancel(input: {
    runId: string;
    shardIds: string[];
    dispatchKey: string;
  }): Promise<void>;
}

export class AcquisitionPlanRunError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "AcquisitionPlanRunError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type IdFactory = (prefix: string) => string;

export interface AcquisitionPlanRunServiceOptions {
  repository: AcquisitionPlanRunRepository;
  executionPort: AcquisitionExecutionPort;
  now?: () => string;
  idFactory?: IdFactory;
  validatePlanPayloadForApproval?: (
    scope: AcquisitionScope,
    payload: AcquisitionPlanPayload
  ) => Promise<void>;
}

const ZERO_USAGE: AcquisitionBudgetUsage = Object.freeze({
  requests: 0,
  results: 0,
  amountMinor: 0,
  durationSeconds: 0
});

const TERMINAL_SHARD_STATUSES = new Set<AcquisitionShardStatus>([
  "cancelled",
  "succeeded",
  "succeeded_empty",
  "partial_success",
  "failed",
  "budget_exhausted"
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function stableHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function planEtag(planId: string, revision: number) {
  return `"${planId}:${revision}"`;
}

function runEtag(runId: string, revision: number) {
  return `"${runId}:${revision}"`;
}

function assertScope(scope: AcquisitionScope) {
  if (!scope.ownerId.trim() || !scope.teamId.trim() || !scope.actorId.trim()) {
    throw new AcquisitionPlanRunError(
      400,
      "invalid_scope",
      "ownerId、teamId 和 actorId 均不能为空"
    );
  }
}

function resourceNotFound(resource: "plan" | "run" | "shard") {
  return new AcquisitionPlanRunError(
    404,
    "resource_not_found",
    `${resource} 不存在`
  );
}

function assertVisible(
  scope: AcquisitionScope,
  resource: { ownerId: string; teamId: string },
  kind: "plan" | "run" | "shard"
) {
  if (resource.ownerId !== scope.ownerId || resource.teamId !== scope.teamId) {
    throw resourceNotFound(kind);
  }
}

function assertIfMatch(actual: string, supplied: string) {
  if (!supplied?.trim()) {
    throw new AcquisitionPlanRunError(
      428,
      "precondition_required",
      "更新操作必须提供 If-Match/ETag"
    );
  }
  if (actual !== supplied.trim()) {
    throw new AcquisitionPlanRunError(
      412,
      "precondition_failed",
      "资源已被其他请求更新，请刷新后重试",
      { expected: actual, received: supplied.trim() }
    );
  }
}

function nonNegativeInteger(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

function validZeroEvidenceCandidatePartial(
  presentation: AcquisitionShardPresentationResult | undefined,
  shard: AcquisitionOperationShard
) {
  if (!presentation
    || !Array.isArray(presentation.providers)
    || !Array.isArray(presentation.providerFailures)
    || !Array.isArray(presentation.candidateIds)
    || !Array.isArray(presentation.processedCandidateIds)
    || !Array.isArray(presentation.battleCardCandidateIds)
    || !Array.isArray(presentation.candidateFailures)) {
    return false;
  }
  const nonEmpty = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const uniqueNonEmpty = (ids: unknown[]) =>
    ids.length > 0
    && ids.every(nonEmpty)
    && new Set(ids).size === ids.length;
  const candidateIds = presentation.candidateIds;
  const candidateIdSet = new Set(candidateIds);
  const failedCandidateIds = presentation.candidateFailures.map(
    (failure) => failure?.candidateId
  );
  return uniqueNonEmpty(candidateIds)
    && presentation.rawResultCount >= presentation.acceptedResultCount
    && presentation.duplicateResultCount
      <= presentation.acceptedResultCount
    && presentation.providers.every((provider) =>
      nonEmpty(provider?.providerConnectionId)
      && nonEmpty(provider.provider)
      && provider.status === "succeeded"
    )
    && presentation.providers.some((provider) =>
      provider?.providerConnectionId === shard.connection.connectionId
      && nonEmpty(provider.provider)
      && provider.status === "succeeded"
    )
    && presentation.providerFailures.every((failure) =>
      nonEmpty(failure?.providerConnectionId)
      && nonEmpty(failure.provider)
      && typeof failure.errorCode === "string"
      && /^[A-Z][A-Z0-9_]{0,127}$/.test(failure.errorCode)
      && (failure.retryAfterAt === null
        || (typeof failure.retryAfterAt === "string"
          && Number.isFinite(Date.parse(failure.retryAfterAt))))
    )
    && uniqueNonEmpty(failedCandidateIds)
    && failedCandidateIds.every((candidateId) =>
      candidateIdSet.has(candidateId))
    && presentation.candidateFailures.every((failure) =>
      ["research", "qualification", "battle_card"].includes(failure.stage)
      && typeof failure.errorCode === "string"
      && /^[A-Z][A-Z0-9_]{0,127}$/.test(failure.errorCode)
    )
    && new Set(presentation.processedCandidateIds).size
      === presentation.processedCandidateIds.length
    && presentation.processedCandidateIds.every((candidateId) =>
      nonEmpty(candidateId) && candidateIdSet.has(candidateId))
    && new Set(presentation.battleCardCandidateIds).size
      === presentation.battleCardCandidateIds.length
    && presentation.battleCardCandidateIds.every((candidateId) =>
      nonEmpty(candidateId)
      && presentation.processedCandidateIds.includes(candidateId));
}

function budgetFields(
  budget: AcquisitionBudgetLimit | AcquisitionBudgetUsage
) {
  return [
    ["requests", "maxRequests"],
    ["results", "maxResults"],
    ["amountMinor", "maxAmountMinor"],
    ["durationSeconds", "maxDurationSeconds"]
  ] as const;
}

function addUsage(
  current: AcquisitionBudgetUsage,
  delta: AcquisitionBudgetUsage
): AcquisitionBudgetUsage {
  return {
    requests: current.requests + delta.requests,
    results: current.results + delta.results,
    amountMinor: current.amountMinor + delta.amountMinor,
    durationSeconds: current.durationSeconds + delta.durationSeconds
  };
}

function exceedsBudget(
  usage: AcquisitionBudgetUsage,
  budget: AcquisitionBudgetLimit
) {
  return usage.requests > budget.maxRequests
    || usage.results > budget.maxResults
    || usage.amountMinor > budget.maxAmountMinor
    || usage.durationSeconds > budget.maxDurationSeconds;
}

function exceedsAllocation(
  usage: AcquisitionBudgetUsage,
  allocation: AcquisitionBudgetUsage
) {
  return usage.requests > allocation.requests
    || usage.results > allocation.results
    || usage.amountMinor > allocation.amountMinor
    || usage.durationSeconds > allocation.durationSeconds;
}

function ensureUsage(usage: AcquisitionBudgetUsage) {
  if (!budgetFields(usage).every(([usageField]) =>
    nonNegativeInteger(usage[usageField]))) {
    throw new AcquisitionPlanRunError(
      400,
      "invalid_budget_usage",
      "预算用量必须为非负安全整数"
    );
  }
  if (Object.values(usage).every((value) => value === 0)) {
    throw new AcquisitionPlanRunError(
      400,
      "invalid_budget_usage",
      "预算用量不能全部为零"
    );
  }
}

function mergePayload(
  current: AcquisitionPlanPayload,
  patch: Partial<AcquisitionPlanDraftInput>
) {
  const result = acquisitionPlanPayloadContractSchema.safeParse({
    ...current,
    ...patch
  });
  if (!result.success) {
    throw new AcquisitionPlanRunError(
      400,
      "invalid_plan_payload",
      "合并后的计划不符合完整计划约束",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message
        }))
      }
    );
  }
  return clone(result.data);
}

function providerForOperation(
  connections: AcquisitionProviderConnectionSnapshot[],
  connectionId: string
) {
  const connection = connections.find(
    (candidate) => candidate.connectionId === connectionId
  );
  if (!connection) {
    throw new AcquisitionPlanRunError(
      409,
      "approved_snapshot_corrupt",
      "已审批版本引用了不存在的数据源连接",
      { connectionId }
    );
  }
  return clone(connection);
}

function evidenceCount(shards: AcquisitionOperationShard[]) {
  return shards.reduce((sum, shard) => sum + shard.evidenceCount, 0);
}

function allTerminal(shards: AcquisitionOperationShard[]) {
  return shards.every((shard) => TERMINAL_SHARD_STATUSES.has(shard.status));
}

function normalTerminalStatus(
  shards: AcquisitionOperationShard[]
): AcquisitionRunStatus {
  const acceptedEvidence = evidenceCount(shards);
  if (shards.some((shard) => shard.status === "partial_success")) {
    return "partial_success";
  }
  const degraded = shards.some((shard) =>
    shard.status === "failed"
    || shard.status === "budget_exhausted"
    || shard.status === "cancelled");
  if (degraded) return acceptedEvidence > 0 ? "partial_success" : "failed";
  return acceptedEvidence > 0 ? "succeeded" : "succeeded_empty";
}

function aggregateRunStatus(
  run: AcquisitionRun,
  shards: AcquisitionOperationShard[]
): AcquisitionRunStatus {
  if (run.terminationIntent === "budget_exhausted") {
    return allTerminal(shards) ? "budget_exhausted" : "cancel_requested";
  }
  if (run.terminationIntent === "cancelled") {
    return allTerminal(shards) ? "cancelled" : "cancel_requested";
  }
  if (run.status === "pause_requested") {
    const safe = shards.every((shard) =>
      TERMINAL_SHARD_STATUSES.has(shard.status)
      || shard.status === "paused");
    if (safe) return "paused";
  }
  if (allTerminal(shards)) return normalTerminalStatus(shards);
  if (shards.some((shard) =>
    shard.status === "running"
    || shard.status === "pause_requested"
    || shard.status === "cancel_requested")) {
    return run.status === "pause_requested"
      ? "pause_requested"
      : run.status === "cancel_requested"
        ? "cancel_requested"
        : "running";
  }
  return run.status;
}

export class AcquisitionPlanRunService {
  private readonly repository: AcquisitionPlanRunRepository;
  private readonly executionPort: AcquisitionExecutionPort;
  private readonly now: () => string;
  private readonly idFactory: IdFactory;
  private readonly validatePlanPayloadForApproval?: (
    scope: AcquisitionScope,
    payload: AcquisitionPlanPayload
  ) => Promise<void>;

  constructor(options: AcquisitionPlanRunServiceOptions) {
    this.repository = options.repository;
    this.executionPort = options.executionPort;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory
      ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.validatePlanPayloadForApproval =
      options.validatePlanPayloadForApproval;
  }

  async createPlan(
    scope: AcquisitionScope,
    input: AcquisitionPlanDraftInput,
    options: {
      idempotencyKey?: string;
      idempotencyDiscriminator?: string | null;
    } = {}
  ) {
    assertScope(scope);
    const payload = clone(input);
    const idempotencyKey = options.idempotencyKey?.trim() || null;
    if (idempotencyKey && (
      idempotencyKey.length < 8
      || idempotencyKey.length > 200
    )) {
      throw new AcquisitionPlanRunError(
        400,
        "invalid_idempotency_key",
        "创建计划的幂等键必须为 8 到 200 个字符"
      );
    }
    const requestHash = stableHash({
      payload,
      idempotencyDiscriminator:
        options.idempotencyDiscriminator ?? null
    });
    const scopeKey = idempotencyKey
      ? [
          scope.teamId,
          scope.ownerId,
          "create_plan",
          idempotencyKey
        ].join("\u001f")
      : null;
    const now = this.now();
    return this.repository.transaction((transaction) => {
      if (scopeKey) {
        const existing = transaction.getIdempotency(scopeKey);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new AcquisitionPlanRunError(
              409,
              "idempotency_conflict",
              "同一幂等键已用于不同的创建计划请求"
            );
          }
          if (existing.resultType !== "plan") {
            throw new AcquisitionPlanRunError(
              409,
              "idempotency_record_corrupt",
              "幂等记录类型与创建计划请求不一致"
            );
          }
          const existingPlan = transaction.getPlan(existing.resultId);
          if (!existingPlan) {
            throw new AcquisitionPlanRunError(
              409,
              "idempotency_record_corrupt",
              "幂等记录指向的计划不存在"
            );
          }
          assertVisible(scope, existingPlan, "plan");
          return existingPlan;
        }
      }
      const planId = this.idFactory("ap");
      const versionId = this.idFactory("apv");
      const version: AcquisitionPlanVersion = {
        id: versionId,
        planId,
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        version: 1,
        payload,
        payloadHash: stableHash(payload),
        createdBy: scope.actorId,
        createdAt: now
      };
      const plan: AcquisitionPlan = {
        id: planId,
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        status: "draft",
        version: 1,
        revision: 1,
        etag: planEtag(planId, 1),
        currentVersionId: versionId,
        approvedVersionId: null,
        approvedSnapshotHash: null,
        approvedBy: null,
        approvedAt: null,
        budgetSnapshot: clone(payload.budgetSnapshot),
        payload,
        createdBy: scope.actorId,
        createdAt: now,
        updatedBy: scope.actorId,
        updatedAt: now
      };
      transaction.appendPlanVersion(version);
      transaction.putPlan(plan);
      this.appendPlanEvent(transaction, plan, "plan.created", scope, now, {
        versionId,
        payloadHash: version.payloadHash
      });
      this.appendAudit(
        transaction,
        scope,
        "plan.create",
        "plan",
        plan.id,
        null,
        stableHash(plan),
        now,
        { versionId }
      );
      if (scopeKey) {
        transaction.putIdempotency({
          scopeKey,
          requestHash,
          resultType: "plan",
          resultId: plan.id,
          createdAt: now
        });
      }
      return plan;
    });
  }

  async getPlan(scope: AcquisitionScope, planId: string) {
    assertScope(scope);
    const plan = await this.repository.getPlan(planId);
    if (!plan) throw resourceNotFound("plan");
    assertVisible(scope, plan, "plan");
    return plan;
  }

  async updatePlan(
    scope: AcquisitionScope,
    planId: string,
    ifMatch: string,
    patch: Partial<AcquisitionPlanDraftInput>
  ) {
    assertScope(scope);
    return this.repository.transaction((transaction) => {
      const plan = this.visiblePlan(transaction, scope, planId);
      if (plan.status === "approved") {
        throw new AcquisitionPlanRunError(
          409,
          "approved_plan_is_frozen",
          "已审批计划不可直接修改，请创建新的计划版本"
        );
      }
      if (plan.status !== "draft") {
        throw new AcquisitionPlanRunError(
          409,
          "plan_not_editable",
          "当前计划状态不可编辑"
        );
      }
      assertIfMatch(plan.etag, ifMatch);
      return this.appendPlanRevision(
        transaction,
        scope,
        plan,
        mergePayload(plan.payload, patch),
        "plan.updated"
      );
    });
  }

  async createPlanRevision(
    scope: AcquisitionScope,
    planId: string,
    ifMatch: string,
    patch: Partial<AcquisitionPlanDraftInput>
  ) {
    assertScope(scope);
    return this.repository.transaction((transaction) => {
      const plan = this.visiblePlan(transaction, scope, planId);
      if (plan.status !== "approved") {
        throw new AcquisitionPlanRunError(
          409,
          "approved_plan_required_for_revision",
          "只有已审批计划可以派生新的待审批版本"
        );
      }
      assertIfMatch(plan.etag, ifMatch);
      return this.appendPlanRevision(
        transaction,
        scope,
        plan,
        mergePayload(plan.payload, patch),
        "plan.revision_created"
      );
    });
  }

  async approvePlan(
    scope: AcquisitionScope,
    planId: string,
    ifMatch: string,
    approval: {
      decision: "approve";
      reason: string;
    }
  ) {
    assertScope(scope);
    if (approval.decision !== "approve" || !approval.reason?.trim()) {
      throw new AcquisitionPlanRunError(
        400,
        "explicit_human_approval_required",
        "计划执行前必须记录人工批准决定和理由"
      );
    }
    const pending = await this.getPlan(scope, planId);
    if (pending.status !== "draft") {
      throw new AcquisitionPlanRunError(
        409,
        "plan_not_draft",
        "只有草稿计划可以审批"
      );
    }
    assertIfMatch(pending.etag, ifMatch);
    const pendingIssues = planReadinessIssues(pending.payload);
    if (pendingIssues.length > 0) {
      throw new AcquisitionPlanRunError(
        409,
        "plan_not_ready",
        "计划尚未满足人工审批条件",
        { issues: pendingIssues }
      );
    }
    if (this.validatePlanPayloadForApproval) {
      try {
        await this.validatePlanPayloadForApproval(
          scope,
          clone(pending.payload)
        );
      } catch (error) {
        if (error instanceof AcquisitionPlanRunError) throw error;
        throw new AcquisitionPlanRunError(
          503,
          "plan_approval_validation_failed",
          "可信模型快照校验暂时不可用"
        );
      }
    }
    return this.repository.transaction((transaction) => {
      const current = this.visiblePlan(transaction, scope, planId);
      if (current.status !== "draft") {
        throw new AcquisitionPlanRunError(
          409,
          "plan_not_draft",
          "只有草稿计划可以审批"
        );
      }
      assertIfMatch(current.etag, ifMatch);
      const issues = planReadinessIssues(current.payload);
      if (issues.length > 0) {
        throw new AcquisitionPlanRunError(
          409,
          "plan_not_ready",
          "计划尚未满足人工审批条件",
          { issues }
        );
      }
      const version = transaction.getPlanVersion(current.currentVersionId);
      if (!version) {
        throw new AcquisitionPlanRunError(
          409,
          "approved_snapshot_corrupt",
          "计划当前版本不存在"
        );
      }
      const now = this.now();
      const beforeHash = stableHash(current);
      const revision = current.revision + 1;
      const approved: AcquisitionPlan = {
        ...current,
        status: "approved",
        revision,
        etag: planEtag(current.id, revision),
        approvedVersionId: version.id,
        approvedSnapshotHash: version.payloadHash,
        approvedBy: scope.actorId,
        approvedAt: now,
        updatedBy: scope.actorId,
        updatedAt: now
      };
      transaction.putPlan(approved);
      this.appendPlanEvent(
        transaction,
        approved,
        "plan.approved",
        scope,
        now,
        {
          decision: "approve",
          reason: approval.reason.trim(),
          approvedVersionId: version.id,
          approvedSnapshotHash: version.payloadHash
        }
      );
      this.appendAudit(
        transaction,
        scope,
        "plan.approve",
        "plan",
        approved.id,
        beforeHash,
        stableHash(approved),
        now,
        {
          reason: approval.reason.trim(),
          approvedVersionId: version.id
        }
      );
      return approved;
    });
  }

  async createRun(
    scope: AcquisitionScope,
    planId: string,
    input: {
      idempotencyKey: string;
      parentRunId?: string;
      reason?: string;
    }
  ) {
    assertScope(scope);
    const idempotencyKey = input.idempotencyKey?.trim();
    if (!idempotencyKey || idempotencyKey.length < 8) {
      throw new AcquisitionPlanRunError(
        400,
        "invalid_idempotency_key",
        "创建运行必须提供至少 8 个字符的幂等键"
      );
    }
    const requestHash = stableHash({
      planId,
      parentRunId: input.parentRunId ?? null,
      reason: input.reason?.trim() ?? null
    });
    const scopeKey = [
      scope.teamId,
      scope.ownerId,
      "create_run",
      idempotencyKey
    ].join("\u001f");
    const result = await this.repository.transaction((transaction) => {
      const existing = transaction.getIdempotency(scopeKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new AcquisitionPlanRunError(
            409,
            "idempotency_conflict",
            "同一幂等键已用于不同的创建运行请求"
          );
        }
        if (existing.resultType !== "run") {
          throw new AcquisitionPlanRunError(
            409,
            "idempotency_record_corrupt",
            "幂等记录类型与创建运行请求不一致"
          );
        }
        const run = transaction.getRun(existing.resultId);
        if (!run) {
          throw new AcquisitionPlanRunError(
            409,
            "idempotency_record_corrupt",
            "幂等记录指向的运行不存在"
          );
        }
        assertVisible(scope, run, "run");
        return {
          run,
          shards: transaction.listRunShards(run.id),
          created: false,
          intentIds: transaction.listRunExecutionIntents(run.id)
            .filter((intent) => intent.kind === "enqueue")
            .map((intent) => intent.id)
        };
      }

      const plan = this.visiblePlan(transaction, scope, planId);
      if (plan.status !== "approved"
        || !plan.approvedVersionId
        || !plan.approvedSnapshotHash) {
        throw new AcquisitionPlanRunError(
          409,
          "plan_not_approved",
          "只有经过明确人工批准的计划才能创建运行"
        );
      }
      const version = transaction.getPlanVersion(plan.approvedVersionId);
      if (!version || version.payloadHash !== plan.approvedSnapshotHash) {
        throw new AcquisitionPlanRunError(
          409,
          "approved_snapshot_corrupt",
          "已审批计划快照不完整或哈希不匹配"
        );
      }
      const readinessIssues = planReadinessIssues(version.payload);
      if (readinessIssues.length > 0) {
        throw new AcquisitionPlanRunError(
          409,
          "plan_not_ready",
          "已审批计划快照不再满足运行条件",
          { issues: readinessIssues }
        );
      }

      let parentRun: AcquisitionRun | null = null;
      if (input.parentRunId) {
        parentRun = transaction.getRun(input.parentRunId);
        if (!parentRun) throw resourceNotFound("run");
        assertVisible(scope, parentRun, "run");
        if (parentRun.planId !== plan.id) {
          throw new AcquisitionPlanRunError(
            409,
            "parent_run_plan_mismatch",
            "续跑必须使用同一个计划的新版预算"
          );
        }
        if (parentRun.status !== "budget_exhausted") {
          throw new AcquisitionPlanRunError(
            409,
            "parent_run_not_budget_exhausted",
            "只有预算耗尽的运行可以通过新版计划续跑"
          );
        }
        if (parentRun.planVersionId === version.id) {
          throw new AcquisitionPlanRunError(
            409,
            "new_approved_plan_version_required",
            "预算耗尽后必须创建并批准新的计划预算版本"
          );
        }
      }

      const now = this.now();
      const runId = this.idFactory("ar");
      const budgetSnapshotId = this.idFactory("abs");
      const run: AcquisitionRun = {
        id: runId,
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        planId: plan.id,
        planVersionId: version.id,
        planVersion: version.version,
        planSnapshotHash: version.payloadHash,
        parentRunId: parentRun?.id ?? null,
        status: "queued",
        terminationIntent: null,
        revision: 1,
        etag: runEtag(runId, 1),
        budgetSnapshotId,
        budgetSnapshot: clone(version.payload.budgetSnapshot),
        budgetSnapshotHash: stableHash(version.payload.budgetSnapshot),
        billingCurrency: version.payload.budgetSnapshot.billingCurrency,
        modelSnapshotRef: clone(version.payload.modelSnapshotRef),
        consumedBudget: clone(ZERO_USAGE),
        evidenceCount: 0,
        reason: input.reason?.trim() || null,
        createdBy: scope.actorId,
        createdAt: now,
        updatedBy: scope.actorId,
        updatedAt: now,
        completedAt: null
      };
      const shards = version.payload.operations.map((operation) => {
        const shard: AcquisitionOperationShard = {
          id: this.idFactory("aos"),
          runId,
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          operationId: operation.operationId,
          parentShardId: null,
          subjectChannel: operation.subjectChannel,
          kind: operation.kind,
          connection: providerForOperation(
            version.payload.providerConnections,
            operation.connectionId
          ),
          query: operation.query?.trim() || null,
          sourceRef: operation.sourceRef?.trim()
            || operation.query?.trim()
            || operation.connectionId,
          status: "queued",
          budgetSnapshotId,
          allocatedBudget: clone(operation.allocatedBudget),
          consumedBudget: clone(ZERO_USAGE),
          modelSnapshotRef: clone(version.payload.modelSnapshotRef),
          evidenceCount: 0,
          completionIdempotencyKey: undefined,
          completionRequestHash: undefined,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          completedAt: null
        };
        transaction.putShard(shard);
        this.appendRunEvent(
          transaction,
          run,
          "shard.queued",
          scope,
          now,
          { operationId: operation.operationId, kind: operation.kind },
          shard.id
        );
        return shard;
      });
      transaction.putRun(run);
      this.appendRunEvent(transaction, run, "run.queued", scope, now, {
        planVersionId: version.id,
        planSnapshotHash: version.payloadHash,
        budgetSnapshotId,
        parentRunId: parentRun?.id ?? null,
        dispatchMode: "queue_only_no_outreach"
      });
      const enqueueIntent = this.putExecutionIntent(
        transaction,
        run,
        "enqueue",
        shards.map((shard) => shard.id),
        now,
        `acquisition-run:${run.id}:${run.planSnapshotHash}`
      );
      this.appendAudit(
        transaction,
        scope,
        "run.create",
        "run",
        run.id,
        null,
        stableHash(run),
        now,
        {
          planVersionId: version.id,
          parentRunId: parentRun?.id ?? null
        }
      );
      const idempotency: AcquisitionIdempotencyRecord = {
        scopeKey,
        requestHash,
        resultType: "run",
        resultId: run.id,
        createdAt: now
      };
      transaction.putIdempotency(idempotency);
      return {
        run,
        shards,
        created: true,
        intentIds: [enqueueIntent.id]
      };
    });

    for (const intentId of result.intentIds) {
      await this.dispatchExecutionIntent(scope, intentId);
    }
    return result.run;
  }

  async getRun(scope: AcquisitionScope, runId: string) {
    assertScope(scope);
    const run = await this.repository.getRun(runId);
    if (!run) throw resourceNotFound("run");
    assertVisible(scope, run, "run");
    return run;
  }

  async listRunShards(scope: AcquisitionScope, runId: string) {
    await this.getRun(scope, runId);
    return this.repository.listRunShards(runId);
  }

  async dispatchPendingExecutionIntents(
    scope: AcquisitionScope,
    runId: string
  ) {
    assertScope(scope);
    const intentIds = await this.repository.transaction((transaction) => {
      this.visibleRun(transaction, scope, runId);
      return transaction.listRunExecutionIntents(runId)
        .filter((intent) => intent.status !== "dispatched")
        .map((intent) => intent.id);
    });
    for (const intentId of intentIds) {
      await this.dispatchExecutionIntent(scope, intentId);
    }
    return this.getRun(scope, runId);
  }

  /**
   * Internal recovery sweep. It intentionally scans all tenant scopes through
   * the repository and reconstructs a scope from each persisted intent; it is
   * never exposed as an HTTP operation.
   */
  async recoverExecutionIntents(actorId: string) {
    const recoveryActorId = actorId?.trim();
    if (!recoveryActorId || recoveryActorId.length > 255) {
      throw new TypeError("A valid recovery actor id is required");
    }
    const snapshots = await this.repository.listRecoverableExecutionIntents(
      this.now()
    );
    let recovered = 0;
    let firstFailure: unknown;
    for (const snapshot of snapshots) {
      const scope: AcquisitionScope = {
        ownerId: snapshot.ownerId,
        teamId: snapshot.teamId,
        actorId: recoveryActorId
      };
      try {
        const intentId = await this.repository.transaction((transaction) => {
          const current = transaction.getExecutionIntent(snapshot.id);
          if (!current
            || current.ownerId !== snapshot.ownerId
            || current.teamId !== snapshot.teamId) {
            return null;
          }
          const run = this.visibleRun(
            transaction,
            scope,
            current.runId
          );
          const now = this.now();
          if (!intentNeedsRecovery(
            current,
            transaction.listRunShards(run.id),
            now
          )) {
            return null;
          }
          transaction.putExecutionIntent({
            ...current,
            status: "pending",
            leaseUntil: null,
            lastError: current.lastError,
            updatedAt: now
          });
          this.appendRunEvent(
            transaction,
            run,
            "execution.recovery_scheduled",
            scope,
            now,
            {
              intentId: current.id,
              kind: current.kind,
              previousStatus: current.status
            }
          );
          return current.id;
        });
        if (!intentId) continue;
        await this.dispatchExecutionIntent(scope, intentId);
        recovered += 1;
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (firstFailure) throw firstFailure;
    return recovered;
  }

  async startShard(
    scope: AcquisitionScope,
    runId: string,
    shardId: string
  ) {
    assertScope(scope);
    return this.repository.transaction((transaction) => {
      const run = this.visibleRun(transaction, scope, runId);
      const shard = this.visibleShard(transaction, scope, run, shardId);
      if (run.status !== "queued" && run.status !== "running") {
        throw new AcquisitionPlanRunError(
          409,
          "run_not_startable",
          "当前运行状态不能启动分片",
          { status: run.status }
        );
      }
      if (shard.status !== "queued"
        && shard.status !== "retry_scheduled") {
        throw new AcquisitionPlanRunError(
          409,
          "shard_not_startable",
          "当前分片状态不能启动",
          { status: shard.status }
        );
      }
      const now = this.now();
      const beforeHash = stableHash(run);
      const updatedShard: AcquisitionOperationShard = {
        ...shard,
        status: "running",
        revision: shard.revision + 1,
        updatedAt: now
      };
      const updatedRun = this.touchRun({
        ...run,
        status: "running"
      }, scope, now);
      transaction.putShard(updatedShard);
      transaction.putRun(updatedRun);
      this.appendRunEvent(
        transaction,
        updatedRun,
        "shard.started",
        scope,
        now,
        {},
        shard.id
      );
      if (run.status !== updatedRun.status) {
        this.appendRunEvent(
          transaction,
          updatedRun,
          "run.started",
          scope,
          now,
          {}
        );
      }
      this.appendAudit(
        transaction,
        scope,
        "shard.start",
        "shard",
        shard.id,
        stableHash(shard),
        stableHash(updatedShard),
        now,
        { runBeforeHash: beforeHash, runAfterHash: stableHash(updatedRun) }
      );
      return updatedRun;
    });
  }

  async consumeShardBudget(
    scope: AcquisitionScope,
    runId: string,
    shardId: string,
    input: {
      idempotencyKey: string;
      usage: AcquisitionBudgetUsage;
    }
  ) {
    assertScope(scope);
    ensureUsage(input.usage);
    const key = input.idempotencyKey?.trim();
    if (!key || key.length < 8) {
      throw new AcquisitionPlanRunError(
        400,
        "invalid_idempotency_key",
        "预算入账必须提供至少 8 个字符的幂等键"
      );
    }
    const requestHash = stableHash(input.usage);
    const scopeKey = [
      scope.teamId,
      scope.ownerId,
      runId,
      shardId,
      "consume_budget",
      key
    ].join("\u001f");

    const result = await this.repository.transaction((transaction) => {
      const currentRun = this.visibleRun(transaction, scope, runId);
      const currentShard = this.visibleShard(
        transaction,
        scope,
        currentRun,
        shardId
      );
      const existing = transaction.getUsageIdempotency(scopeKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new AcquisitionPlanRunError(
            409,
            "idempotency_conflict",
            "同一预算幂等键已用于不同用量"
          );
        }
        return {
          run: currentRun,
          intentIds: transaction.listRunExecutionIntents(currentRun.id)
            .filter((intent) => intent.kind === "cancel"
              && intent.status !== "dispatched")
            .map((intent) => intent.id)
        };
      }
      if (!["running", "pause_requested", "cancel_requested"]
        .includes(currentShard.status)) {
        throw new AcquisitionPlanRunError(
          409,
          "shard_not_consumable",
          "只有正在执行或等待安全点的分片可以入账",
          { status: currentShard.status }
        );
      }

      const now = this.now();
      const nextRunUsage = addUsage(
        currentRun.consumedBudget,
        input.usage
      );
      const nextShardUsage = addUsage(
        currentShard.consumedBudget,
        input.usage
      );
      const idempotency: AcquisitionUsageIdempotencyRecord = {
        scopeKey,
        requestHash,
        runId,
        createdAt: now
      };

      if (exceedsBudget(nextRunUsage, currentRun.budgetSnapshot)) {
        transaction.putUsageIdempotency(idempotency);
        const cancelShardIds = transaction.listRunShards(currentRun.id)
          .filter((shard) => shard.id !== currentShard.id
            && (
              shard.status === "running"
              || shard.status === "pause_requested"
              || shard.status === "cancel_requested"
            ))
          .map((shard) => shard.id);
        const run = this.exhaustRunBudget(
          transaction,
          scope,
          currentRun,
          currentShard,
          now,
          input.usage
        );
        const intentIds = cancelShardIds.length > 0
          ? [this.putExecutionIntent(
            transaction,
            run,
            "cancel",
            cancelShardIds,
            now
          ).id]
          : [];
        return { run, intentIds };
      }
      if (exceedsAllocation(
        nextShardUsage,
        currentShard.allocatedBudget
      )) {
        transaction.putUsageIdempotency(idempotency);
        const run = this.exhaustShardBudget(
          transaction,
          scope,
          currentRun,
          currentShard,
          now,
          input.usage
        );
        return { run, intentIds: [] as string[] };
      }

      const updatedShard: AcquisitionOperationShard = {
        ...currentShard,
        consumedBudget: nextShardUsage,
        revision: currentShard.revision + 1,
        updatedAt: now
      };
      const updatedRun = this.touchRun({
        ...currentRun,
        consumedBudget: nextRunUsage
      }, scope, now);
      transaction.putUsageIdempotency(idempotency);
      transaction.putShard(updatedShard);
      transaction.putRun(updatedRun);
      this.appendRunEvent(
        transaction,
        updatedRun,
        "shard.budget_consumed",
        scope,
        now,
        {
          delta: clone(input.usage),
          shardConsumedBudget: clone(nextShardUsage),
          runConsumedBudget: clone(nextRunUsage)
        },
        currentShard.id
      );
      this.appendAudit(
        transaction,
        scope,
        "shard.consume_budget",
        "shard",
        currentShard.id,
        stableHash(currentShard),
        stableHash(updatedShard),
        now,
        { delta: clone(input.usage), idempotencyKey: key }
      );
      return { run: updatedRun, intentIds: [] as string[] };
    });
    for (const intentId of result.intentIds) {
      await this.dispatchExecutionIntent(scope, intentId);
    }
    return result.run;
  }

  async completeShard(
    scope: AcquisitionScope,
    runId: string,
    shardId: string,
    input: {
      status:
        | "succeeded"
        | "succeeded_empty"
        | "partial_success"
        | "failed"
        | "cancelled";
      evidenceCount: number;
      presentation?: AcquisitionShardPresentationResult;
      idempotencyKey?: string;
    }
  ) {
    assertScope(scope);
    const idempotencyKey = input.idempotencyKey?.trim();
    if (input.idempotencyKey !== undefined
      && (!idempotencyKey || idempotencyKey.length < 8)) {
      throw new AcquisitionPlanRunError(
        400,
        "invalid_idempotency_key",
        "分片结算幂等键必须至少包含 8 个字符"
      );
    }
    const completionRequestHash = stableHash({
      status: input.status,
      evidenceCount: input.evidenceCount,
      presentation: input.presentation ?? null
    });
    if (!nonNegativeInteger(input.evidenceCount)) {
      throw new AcquisitionPlanRunError(
        400,
        "invalid_evidence_count",
        "evidenceCount 必须为非负安全整数"
      );
    }
    if (input.status === "succeeded" && input.evidenceCount === 0) {
      throw new AcquisitionPlanRunError(
        400,
        "invalid_shard_result",
        "succeeded 分片必须至少接受一条证据"
      );
    }
    if (input.status === "succeeded_empty" && input.evidenceCount !== 0) {
      throw new AcquisitionPlanRunError(
        400,
        "invalid_shard_result",
        "succeeded_empty 分片不能包含证据"
      );
    }
    if (input.status === "partial_success"
      && input.evidenceCount === 0
      && !input.presentation) {
      throw new AcquisitionPlanRunError(
        400,
        "invalid_shard_result",
        "零证据 partial_success 必须包含可验证的候选处理失败"
      );
    }
    if (input.presentation
      && (!nonNegativeInteger(input.presentation.rawResultCount)
        || !nonNegativeInteger(input.presentation.acceptedResultCount)
        || !nonNegativeInteger(input.presentation.duplicateResultCount)
        || !nonNegativeInteger(input.presentation.failedResultCount)
        || input.presentation.acceptedResultCount !== input.evidenceCount)) {
      throw new AcquisitionPlanRunError(
        400,
        "invalid_shard_result",
        "presentation 计数必须与已接受证据一致"
      );
    }
    return this.repository.transaction((transaction) => {
      const run = this.visibleRun(transaction, scope, runId);
      const shard = this.visibleShard(transaction, scope, run, shardId);
      if (idempotencyKey
        && shard.completionIdempotencyKey === idempotencyKey) {
        if (shard.completionRequestHash !== completionRequestHash) {
          throw new AcquisitionPlanRunError(
            409,
            "idempotency_conflict",
            "同一分片结算幂等键已用于不同请求"
          );
        }
        return run;
      }
      if (!["running", "pause_requested", "cancel_requested"]
        .includes(shard.status)) {
        throw new AcquisitionPlanRunError(
          409,
          "shard_not_completable",
          "当前分片状态不能结算",
          { status: shard.status }
        );
      }
      if (input.status === "cancelled"
        && shard.status !== "cancel_requested") {
        throw new AcquisitionPlanRunError(
          409,
          "cancel_not_requested",
          "分片只有在收到取消请求后才能结算为 cancelled"
        );
      }
      if (shard.status === "cancel_requested"
        && input.status !== "cancelled") {
        throw new AcquisitionPlanRunError(
          409,
          "cancelled_result_required",
          "等待取消的分片只能结算为 cancelled"
        );
      }
      if (input.status === "partial_success"
        && input.evidenceCount === 0
        && !validZeroEvidenceCandidatePartial(
          input.presentation,
          shard
        )) {
        throw new AcquisitionPlanRunError(
          400,
          "invalid_shard_result",
          "零证据 partial_success 必须来自成功 Provider 的真实候选失败"
        );
      }
      const now = this.now();
      const providerFailure = input.presentation?.providerFailures.find(
        (failure) =>
          failure.providerConnectionId === shard.connection.connectionId
      );
      const updatedShard: AcquisitionOperationShard = {
        ...shard,
        status: input.status,
        evidenceCount: input.evidenceCount,
        completionIdempotencyKey: idempotencyKey,
        completionRequestHash: idempotencyKey ? completionRequestHash : undefined,
        revision: shard.revision + 1,
        updatedAt: now,
        completedAt: now
      };
      transaction.putShard(updatedShard);
      const shards = transaction.listRunShards(run.id);
      const nextStatus = aggregateRunStatus(run, shards);
      const updatedRun = this.touchRun({
        ...run,
        status: nextStatus,
        evidenceCount: evidenceCount(shards),
        completedAt: this.completedAt(nextStatus, now)
      }, scope, now);
      transaction.putRun(updatedRun);
      this.appendRunEvent(
        transaction,
        updatedRun,
        `shard.${input.status}`,
        scope,
        now,
        input.presentation
          ? {
              rawResultCount: input.presentation.rawResultCount,
              acceptedResultCount: input.presentation.acceptedResultCount,
              duplicateResultCount: input.presentation.duplicateResultCount,
              failedResultCount: input.presentation.failedResultCount,
              ...(providerFailure
                ? {
                    errorCode: providerFailure.errorCode,
                    retryAfterAt: providerFailure.retryAfterAt
                  }
                : {})
            }
          : { evidenceCount: input.evidenceCount },
        shard.id
      );
      for (const candidateId of [
        ...new Set(input.presentation?.candidateIds ?? [])
      ].sort()) {
        this.appendRunEvent(
          transaction,
          updatedRun,
          "candidate.discovered",
          scope,
          now,
          {
            candidateId,
            operationId: shard.operationId,
            connectionId: shard.connection.connectionId
          },
          shard.id
        );
      }
      this.appendAggregateRunEvent(
        transaction,
        scope,
        run,
        updatedRun,
        now
      );
      this.appendAudit(
        transaction,
        scope,
        "shard.complete",
        "shard",
        shard.id,
        stableHash(shard),
        stableHash(updatedShard),
        now,
        input.presentation
          ? {
              resultStatus: input.status,
              rawResultCount: input.presentation.rawResultCount,
              acceptedResultCount: input.presentation.acceptedResultCount,
              duplicateResultCount: input.presentation.duplicateResultCount,
              failedResultCount: input.presentation.failedResultCount,
              ...(providerFailure
                ? {
                    errorCode: providerFailure.errorCode,
                    retryAfterAt: providerFailure.retryAfterAt
                  }
                : {})
            }
          : { resultStatus: input.status, evidenceCount: input.evidenceCount }
      );
      return updatedRun;
    });
  }

  async pauseRun(
    scope: AcquisitionScope,
    runId: string,
    ifMatch: string,
    input: { reason: string }
  ) {
    assertScope(scope);
    const result = await this.repository.transaction((transaction) => {
      const run = this.visibleRun(transaction, scope, runId);
      assertIfMatch(run.etag, ifMatch);
      if (run.status === "paused") {
        return { run, intentIds: [] as string[] };
      }
      if (run.status !== "queued" && run.status !== "running") {
        throw new AcquisitionPlanRunError(
          409,
          "run_not_pausable",
          "当前运行状态不能暂停",
          { status: run.status }
        );
      }
      const now = this.now();
      const shards = transaction.listRunShards(run.id);
      const runningShardIds: string[] = [];
      for (const shard of shards) {
        let status = shard.status;
        if (status === "running") {
          status = "pause_requested";
          runningShardIds.push(shard.id);
        } else if (status === "queued" || status === "retry_scheduled") {
          status = "paused";
        }
        if (status !== shard.status) {
          transaction.putShard({
            ...shard,
            status,
            revision: shard.revision + 1,
            updatedAt: now
          });
          this.appendRunEvent(
            transaction,
            run,
            status === "paused" ? "shard.paused" : "shard.pause_requested",
            scope,
            now,
            {},
            shard.id
          );
        }
      }
      const nextShards = transaction.listRunShards(run.id);
      const nextStatus = nextShards.every((shard) =>
        TERMINAL_SHARD_STATUSES.has(shard.status)
        || shard.status === "paused")
        ? "paused"
        : "pause_requested";
      const updatedRun = this.touchRun({
        ...run,
        status: nextStatus
      }, scope, now);
      transaction.putRun(updatedRun);
      this.appendRunEvent(
        transaction,
        updatedRun,
        nextStatus === "paused" ? "run.paused" : "run.pause_requested",
        scope,
        now,
        { reason: input.reason?.trim() || null }
      );
      this.appendAudit(
        transaction,
        scope,
        "run.pause",
        "run",
        run.id,
        stableHash(run),
        stableHash(updatedRun),
        now,
        { reason: input.reason?.trim() || null }
      );
      const intent = this.putExecutionIntent(
        transaction,
        updatedRun,
        "pause",
        runningShardIds,
        now
      );
      return {
        run: updatedRun,
        intentIds: [intent.id]
      };
    });
    for (const intentId of result.intentIds) {
      await this.dispatchExecutionIntent(scope, intentId);
    }
    return result.run;
  }

  async acknowledgeShardPaused(
    scope: AcquisitionScope,
    runId: string,
    shardId: string
  ) {
    assertScope(scope);
    return this.repository.transaction((transaction) => {
      const run = this.visibleRun(transaction, scope, runId);
      const shard = this.visibleShard(transaction, scope, run, shardId);
      if (run.status !== "pause_requested"
        || shard.status !== "pause_requested") {
        throw new AcquisitionPlanRunError(
          409,
          "pause_ack_not_expected",
          "当前分片没有待确认的暂停请求"
        );
      }
      const now = this.now();
      const updatedShard: AcquisitionOperationShard = {
        ...shard,
        status: "paused",
        revision: shard.revision + 1,
        updatedAt: now
      };
      transaction.putShard(updatedShard);
      const shards = transaction.listRunShards(run.id);
      const status = aggregateRunStatus(run, shards);
      const updatedRun = this.touchRun({
        ...run,
        status
      }, scope, now);
      transaction.putRun(updatedRun);
      this.appendRunEvent(
        transaction,
        updatedRun,
        "shard.paused",
        scope,
        now,
        {},
        shard.id
      );
      this.appendAggregateRunEvent(
        transaction,
        scope,
        run,
        updatedRun,
        now
      );
      return updatedRun;
    });
  }

  async resumeRun(
    scope: AcquisitionScope,
    runId: string,
    ifMatch: string,
    input: { reason: string }
  ) {
    assertScope(scope);
    const result = await this.repository.transaction((transaction) => {
      const run = this.visibleRun(transaction, scope, runId);
      if (run.status === "budget_exhausted") {
        throw new AcquisitionPlanRunError(
          409,
          "budget_revision_requires_new_run",
          "预算耗尽的运行不能原地恢复，必须批准新预算版本并创建新运行"
        );
      }
      assertIfMatch(run.etag, ifMatch);
      if (run.status !== "paused") {
        throw new AcquisitionPlanRunError(
          409,
          "run_not_resumable",
          "只有 paused 运行可以恢复",
          { status: run.status }
        );
      }
      const now = this.now();
      const shardIds: string[] = [];
      for (const shard of transaction.listRunShards(run.id)) {
        if (shard.status !== "paused") continue;
        shardIds.push(shard.id);
        transaction.putShard({
          ...shard,
          status: "queued",
          revision: shard.revision + 1,
          updatedAt: now
        });
        this.appendRunEvent(
          transaction,
          run,
          "shard.resumed",
          scope,
          now,
          {},
          shard.id
        );
      }
      const updatedRun = this.touchRun({
        ...run,
        status: "queued",
        terminationIntent: null
      }, scope, now);
      transaction.putRun(updatedRun);
      this.appendRunEvent(
        transaction,
        updatedRun,
        "run.resumed",
        scope,
        now,
        { reason: input.reason?.trim() || null }
      );
      this.appendAudit(
        transaction,
        scope,
        "run.resume",
        "run",
        run.id,
        stableHash(run),
        stableHash(updatedRun),
        now,
        {
          reason: input.reason?.trim() || null,
          consumedBudgetPreserved: clone(run.consumedBudget)
        }
      );
      const intent = this.putExecutionIntent(
        transaction,
        updatedRun,
        "resume",
        shardIds,
        now
      );
      return { run: updatedRun, intentIds: [intent.id] };
    });
    for (const intentId of result.intentIds) {
      await this.dispatchExecutionIntent(scope, intentId);
    }
    return result.run;
  }

  async cancelRun(
    scope: AcquisitionScope,
    runId: string,
    ifMatch: string,
    input: { reason: string }
  ) {
    assertScope(scope);
    const result = await this.repository.transaction((transaction) => {
        const run = this.visibleRun(transaction, scope, runId);
        assertIfMatch(run.etag, ifMatch);
        if (run.status === "cancelled") {
          return { run, intentIds: [] as string[] };
        }
        if ([
          "succeeded",
          "succeeded_empty",
          "partial_success",
          "failed",
          "budget_exhausted"
        ].includes(run.status)) {
          throw new AcquisitionPlanRunError(
            409,
            "run_not_cancellable",
            "终态运行不能取消",
            { status: run.status }
          );
        }
        const now = this.now();
        const runningShardIds: string[] = [];
        for (const shard of transaction.listRunShards(run.id)) {
          let status = shard.status;
          let completedAt = shard.completedAt;
          if (status === "running" || status === "pause_requested") {
            status = "cancel_requested";
            runningShardIds.push(shard.id);
          } else if (
            status === "queued"
            || status === "retry_scheduled"
            || status === "paused"
          ) {
            status = "cancelled";
            completedAt = now;
          }
          if (status !== shard.status) {
            transaction.putShard({
              ...shard,
              status,
              completedAt,
              revision: shard.revision + 1,
              updatedAt: now
            });
            this.appendRunEvent(
              transaction,
              run,
              status === "cancelled"
                ? "shard.cancelled"
                : "shard.cancel_requested",
              scope,
              now,
              {},
              shard.id
            );
          }
        }
        const shards = transaction.listRunShards(run.id);
        const status = runningShardIds.length > 0
          ? "cancel_requested"
          : "cancelled";
        const updatedRun = this.touchRun({
          ...run,
          status,
          terminationIntent: "cancelled",
          evidenceCount: evidenceCount(shards),
          completedAt: status === "cancelled" ? now : null
        }, scope, now);
        transaction.putRun(updatedRun);
        this.appendRunEvent(
          transaction,
          updatedRun,
          status === "cancelled" ? "run.cancelled" : "run.cancel_requested",
          scope,
          now,
          { reason: input.reason?.trim() || null }
        );
        this.appendAudit(
          transaction,
          scope,
          "run.cancel",
          "run",
          run.id,
          stableHash(run),
          stableHash(updatedRun),
          now,
          { reason: input.reason?.trim() || null }
        );
        const intent = this.putExecutionIntent(
          transaction,
          updatedRun,
          "cancel",
          runningShardIds,
          now
        );
        return {
          run: updatedRun,
          intentIds: [intent.id]
        };
      });
    for (const intentId of result.intentIds) {
      await this.dispatchExecutionIntent(scope, intentId);
    }
    return result.run;
  }

  async acknowledgeShardCancelled(
    scope: AcquisitionScope,
    runId: string,
    shardId: string
  ) {
    assertScope(scope);
    return this.repository.transaction((transaction) => {
      const run = this.visibleRun(transaction, scope, runId);
      const shard = this.visibleShard(transaction, scope, run, shardId);
      if (shard.status !== "cancel_requested") {
        throw new AcquisitionPlanRunError(
          409,
          "cancel_ack_not_expected",
          "当前分片没有待确认的取消请求"
        );
      }
      const now = this.now();
      const updatedShard: AcquisitionOperationShard = {
        ...shard,
        status: "cancelled",
        revision: shard.revision + 1,
        updatedAt: now,
        completedAt: now
      };
      transaction.putShard(updatedShard);
      const shards = transaction.listRunShards(run.id);
      const status = aggregateRunStatus(run, shards);
      const updatedRun = this.touchRun({
        ...run,
        status,
        evidenceCount: evidenceCount(shards),
        completedAt: this.completedAt(status, now)
      }, scope, now);
      transaction.putRun(updatedRun);
      this.appendRunEvent(
        transaction,
        updatedRun,
        "shard.cancelled",
        scope,
        now,
        {},
        shard.id
      );
      this.appendAggregateRunEvent(
        transaction,
        scope,
        run,
        updatedRun,
        now
      );
      return updatedRun;
    });
  }

  private putExecutionIntent(
    transaction: AcquisitionPlanRunRepositoryTransaction,
    run: AcquisitionRun,
    kind: AcquisitionExecutionIntentKind,
    shardIds: string[],
    now: string,
    dispatchKey?: string
  ) {
    const intentId = this.idFactory("aei");
    const intent: AcquisitionExecutionIntent = {
      id: intentId,
      runId: run.id,
      ownerId: run.ownerId,
      teamId: run.teamId,
      kind,
      payload: {
        runId: run.id,
        shardIds: [...shardIds],
        dispatchKey: dispatchKey ?? `acquisition-control:${intentId}`
      },
      status: "pending",
      attempts: 0,
      leaseUntil: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    };
    transaction.putExecutionIntent(intent);
    this.appendRunEvent(
      transaction,
      run,
      "execution.intent_recorded",
      {
        ownerId: run.ownerId,
        teamId: run.teamId,
        actorId: run.updatedBy
      },
      now,
      { intentId: intent.id, kind }
    );
    return intent;
  }

  private async dispatchExecutionIntent(
    scope: AcquisitionScope,
    intentId: string
  ) {
    const claim = await this.repository.transaction((transaction) => {
      const intent = transaction.getExecutionIntent(intentId);
      if (!intent) {
        throw new AcquisitionPlanRunError(
          409,
          "execution_intent_not_found",
          "执行意图不存在"
        );
      }
      assertVisible(scope, intent, "run");
      const run = this.visibleRun(transaction, scope, intent.runId);
      if (intent.status === "dispatched") return null;
      const now = this.now();
      if (intent.status === "dispatching"
        && intent.leaseUntil
        && Date.parse(intent.leaseUntil) > Date.parse(now)) {
        return null;
      }
      const claimed: AcquisitionExecutionIntent = {
        ...intent,
        status: "dispatching",
        attempts: intent.attempts + 1,
        leaseUntil: new Date(Date.parse(now) + 60_000).toISOString(),
        lastError: null,
        updatedAt: now
      };
      transaction.putExecutionIntent(claimed);
      this.appendRunEvent(
        transaction,
        run,
        "execution.dispatch_started",
        scope,
        now,
        {
          intentId: intent.id,
          kind: intent.kind,
          attempt: claimed.attempts
        }
      );
      return claimed;
    });
    if (!claim) return;

    try {
      if (claim.kind === "enqueue") {
        if (!claim.payload.dispatchKey) {
          throw new AcquisitionPlanRunError(
            409,
            "execution_intent_corrupt",
            "入队意图缺少 dispatchKey"
          );
        }
        await this.executionPort.enqueue({
          runId: claim.runId,
          shardIds: claim.payload.shardIds,
          dispatchKey: claim.payload.dispatchKey
        });
      } else if (claim.kind === "pause") {
        await this.executionPort.requestPause({
          runId: claim.runId,
          shardIds: claim.payload.shardIds,
          dispatchKey: claim.payload.dispatchKey
        });
      } else if (claim.kind === "resume") {
        await this.executionPort.resume({
          runId: claim.runId,
          shardIds: claim.payload.shardIds,
          dispatchKey: claim.payload.dispatchKey
        });
      } else {
        await this.executionPort.requestCancel({
          runId: claim.runId,
          shardIds: claim.payload.shardIds,
          dispatchKey: claim.payload.dispatchKey
        });
      }
    } catch (error) {
      await this.repository.transaction((transaction) => {
        const current = transaction.getExecutionIntent(claim.id);
        if (!current
          || current.status !== "dispatching"
          || current.attempts !== claim.attempts) {
          return;
        }
        const run = this.visibleRun(transaction, scope, current.runId);
        const now = this.now();
        transaction.putExecutionIntent({
          ...current,
          status: "pending",
          leaseUntil: null,
          lastError: error instanceof Error ? error.name : "Error",
          updatedAt: now
        });
        this.appendRunEvent(
          transaction,
          run,
          "execution.dispatch_failed",
          scope,
          now,
          {
            intentId: current.id,
            kind: current.kind,
            attempt: current.attempts,
            errorType: error instanceof Error ? error.name : "Error"
          }
        );
      });
      throw error;
    }

    await this.repository.transaction((transaction) => {
      const current = transaction.getExecutionIntent(claim.id);
      if (!current
        || current.status !== "dispatching"
        || current.attempts !== claim.attempts) {
        return;
      }
      const run = this.visibleRun(transaction, scope, current.runId);
      const now = this.now();
      transaction.putExecutionIntent({
        ...current,
        status: "dispatched",
        leaseUntil: null,
        lastError: null,
        updatedAt: now
      });
      this.appendRunEvent(
        transaction,
        run,
        "execution.dispatched",
        scope,
        now,
        {
          intentId: current.id,
          kind: current.kind,
          attempt: current.attempts
        }
      );
    });
  }

  private appendPlanRevision(
    transaction: AcquisitionPlanRunRepositoryTransaction,
    scope: AcquisitionScope,
    current: AcquisitionPlan,
    payload: AcquisitionPlanPayload,
    eventType: string
  ) {
    const now = this.now();
    const versionNumber = current.version + 1;
    const versionId = this.idFactory("apv");
    const version: AcquisitionPlanVersion = {
      id: versionId,
      planId: current.id,
      ownerId: current.ownerId,
      teamId: current.teamId,
      version: versionNumber,
      payload,
      payloadHash: stableHash(payload),
      createdBy: scope.actorId,
      createdAt: now
    };
    const revision = current.revision + 1;
    const updated: AcquisitionPlan = {
      ...current,
      status: "draft",
      version: versionNumber,
      revision,
      etag: planEtag(current.id, revision),
      currentVersionId: versionId,
      budgetSnapshot: clone(payload.budgetSnapshot),
      payload,
      updatedBy: scope.actorId,
      updatedAt: now
    };
    transaction.appendPlanVersion(version);
    transaction.putPlan(updated);
    this.appendPlanEvent(
      transaction,
      updated,
      eventType,
      scope,
      now,
      { versionId, payloadHash: version.payloadHash }
    );
    this.appendAudit(
      transaction,
      scope,
      eventType === "plan.updated"
        ? "plan.update"
        : "plan.create_revision",
      "plan",
      current.id,
      stableHash(current),
      stableHash(updated),
      now,
      { versionId }
    );
    return updated;
  }

  private exhaustShardBudget(
    transaction: AcquisitionPlanRunRepositoryTransaction,
    scope: AcquisitionScope,
    run: AcquisitionRun,
    shard: AcquisitionOperationShard,
    now: string,
    rejectedUsage: AcquisitionBudgetUsage
  ) {
    const exhaustedShard: AcquisitionOperationShard = {
      ...shard,
      status: "budget_exhausted",
      revision: shard.revision + 1,
      updatedAt: now,
      completedAt: now
    };
    transaction.putShard(exhaustedShard);
    const shards = transaction.listRunShards(run.id);
    const status = aggregateRunStatus(run, shards);
    const updatedRun = this.touchRun({
      ...run,
      status,
      evidenceCount: evidenceCount(shards),
      completedAt: this.completedAt(status, now)
    }, scope, now);
    transaction.putRun(updatedRun);
    this.appendRunEvent(
      transaction,
      updatedRun,
      "shard.budget_exhausted",
      scope,
      now,
      {
        rejectedUsage: clone(rejectedUsage),
        consumedBudget: clone(shard.consumedBudget),
        allocatedBudget: clone(shard.allocatedBudget),
        scope: "shard"
      },
      shard.id
    );
    this.appendAggregateRunEvent(
      transaction,
      scope,
      run,
      updatedRun,
      now
    );
    this.appendAudit(
      transaction,
      scope,
      "shard.budget_exhausted",
      "shard",
      shard.id,
      stableHash(shard),
      stableHash(exhaustedShard),
      now,
      { rejectedUsage: clone(rejectedUsage) }
    );
    return updatedRun;
  }

  private exhaustRunBudget(
    transaction: AcquisitionPlanRunRepositoryTransaction,
    scope: AcquisitionScope,
    run: AcquisitionRun,
    trigger: AcquisitionOperationShard,
    now: string,
    rejectedUsage: AcquisitionBudgetUsage
  ) {
    const triggerShard: AcquisitionOperationShard = {
      ...trigger,
      status: "budget_exhausted",
      revision: trigger.revision + 1,
      updatedAt: now,
      completedAt: now
    };
    transaction.putShard(triggerShard);
    this.appendRunEvent(
      transaction,
      run,
      "shard.budget_exhausted",
      scope,
      now,
      {
        rejectedUsage: clone(rejectedUsage),
        consumedBudget: clone(trigger.consumedBudget),
        allocatedBudget: clone(trigger.allocatedBudget),
        scope: "run"
      },
      trigger.id
    );
    for (const shard of transaction.listRunShards(run.id)) {
      if (shard.id === trigger.id
        || TERMINAL_SHARD_STATUSES.has(shard.status)) {
        continue;
      }
      let status: AcquisitionShardStatus;
      let completedAt = shard.completedAt;
      if (shard.status === "running"
        || shard.status === "pause_requested"
        || shard.status === "cancel_requested") {
        status = "cancel_requested";
      } else {
        status = "cancelled";
        completedAt = now;
      }
      transaction.putShard({
        ...shard,
        status,
        completedAt,
        revision: shard.revision + 1,
        updatedAt: now
      });
      this.appendRunEvent(
        transaction,
        run,
        status === "cancel_requested"
          ? "shard.cancel_requested"
          : "shard.cancelled",
        scope,
        now,
        { reason: "run_budget_exhausted" },
        shard.id
      );
    }
    const shards = transaction.listRunShards(run.id);
    const hasPendingCancellation = shards.some(
      (shard) => shard.status === "cancel_requested"
    );
    const status: AcquisitionRunStatus = hasPendingCancellation
      ? "cancel_requested"
      : "budget_exhausted";
    const updatedRun = this.touchRun({
      ...run,
      status,
      terminationIntent: "budget_exhausted",
      evidenceCount: evidenceCount(shards),
      completedAt: status === "budget_exhausted" ? now : null
    }, scope, now);
    transaction.putRun(updatedRun);
    this.appendRunEvent(
      transaction,
      updatedRun,
      status === "budget_exhausted"
        ? "run.budget_exhausted"
        : "run.budget_exhaustion_requested",
      scope,
      now,
      {
        rejectedUsage: clone(rejectedUsage),
        consumedBudget: clone(run.consumedBudget),
        budgetSnapshot: clone(run.budgetSnapshot)
      }
    );
    this.appendAudit(
      transaction,
      scope,
      "run.budget_exhausted",
      "run",
      run.id,
      stableHash(run),
      stableHash(updatedRun),
      now,
      { rejectedUsage: clone(rejectedUsage) }
    );
    return updatedRun;
  }

  private visiblePlan(
    transaction: AcquisitionPlanRunRepositoryTransaction,
    scope: AcquisitionScope,
    planId: string
  ) {
    const plan = transaction.getPlan(planId);
    if (!plan) throw resourceNotFound("plan");
    assertVisible(scope, plan, "plan");
    return plan;
  }

  private visibleRun(
    transaction: AcquisitionPlanRunRepositoryTransaction,
    scope: AcquisitionScope,
    runId: string
  ) {
    const run = transaction.getRun(runId);
    if (!run) throw resourceNotFound("run");
    assertVisible(scope, run, "run");
    return run;
  }

  private visibleShard(
    transaction: AcquisitionPlanRunRepositoryTransaction,
    scope: AcquisitionScope,
    run: AcquisitionRun,
    shardId: string
  ) {
    const shard = transaction.getShard(shardId);
    if (!shard || shard.runId !== run.id) throw resourceNotFound("shard");
    assertVisible(scope, shard, "shard");
    return shard;
  }

  private touchRun(
    run: AcquisitionRun,
    scope: AcquisitionScope,
    now: string
  ): AcquisitionRun {
    const revision = run.revision + 1;
    return {
      ...run,
      revision,
      etag: runEtag(run.id, revision),
      updatedBy: scope.actorId,
      updatedAt: now
    };
  }

  private completedAt(status: AcquisitionRunStatus, now: string) {
    return [
      "cancelled",
      "succeeded",
      "succeeded_empty",
      "partial_success",
      "failed",
      "budget_exhausted"
    ].includes(status)
      ? now
      : null;
  }

  private appendPlanEvent(
    transaction: AcquisitionPlanRunRepositoryTransaction,
    plan: AcquisitionPlan,
    type: string,
    scope: AcquisitionScope,
    at: string,
    data: Record<string, unknown>
  ) {
    const event: AcquisitionPlanEvent = {
      id: this.idFactory("ape"),
      planId: plan.id,
      ownerId: plan.ownerId,
      teamId: plan.teamId,
      type,
      actorId: scope.actorId,
      revision: plan.revision,
      at,
      data: clone(data)
    };
    transaction.appendPlanEvent(event);
  }

  private appendRunEvent(
    transaction: AcquisitionPlanRunRepositoryTransaction,
    run: AcquisitionRun,
    type: string,
    scope: AcquisitionScope,
    at: string,
    data: Record<string, unknown>,
    shardId: string | null = null
  ) {
    const event: AcquisitionRunEvent = {
      id: this.idFactory("are"),
      runId: run.id,
      shardId,
      ownerId: run.ownerId,
      teamId: run.teamId,
      type,
      actorId: scope.actorId,
      revision: run.revision,
      at,
      data: clone(data)
    };
    transaction.appendRunEvent(event);
  }

  private appendAggregateRunEvent(
    transaction: AcquisitionPlanRunRepositoryTransaction,
    scope: AcquisitionScope,
    before: AcquisitionRun,
    after: AcquisitionRun,
    at: string
  ) {
    if (before.status === after.status) return;
    this.appendRunEvent(
      transaction,
      after,
      `run.${after.status}`,
      scope,
      at,
      { previousStatus: before.status }
    );
  }

  private appendAudit(
    transaction: AcquisitionPlanRunRepositoryTransaction,
    scope: AcquisitionScope,
    action: string,
    targetType: "plan" | "run" | "shard",
    targetId: string,
    beforeHash: string | null,
    afterHash: string | null,
    at: string,
    data: Record<string, unknown>
  ) {
    const event: AcquisitionAuditEvent = {
      id: this.idFactory("aae"),
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      actorId: scope.actorId,
      action,
      targetType,
      targetId,
      beforeHash,
      afterHash,
      at,
      data: clone(data)
    };
    transaction.appendAuditEvent(event);
  }
}
