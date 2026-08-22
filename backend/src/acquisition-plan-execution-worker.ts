import type {
  AcquisitionBudgetUsage,
  AcquisitionOperationKind,
  AcquisitionOperationShard,
  AcquisitionPlanRunRepository,
  AcquisitionRun
} from "./acquisition-plan-run-repository.js";
import {
  AcquisitionPlanRunError,
  type AcquisitionExecutionPort,
  type AcquisitionPlanRunService,
  type AcquisitionScope
} from "./acquisition-plan-run-service.js";

export type {
  AcquisitionExecutionPort,
} from "./acquisition-plan-run-service.js";

export interface AcquisitionShardProcessingInput {
  scope: AcquisitionScope;
  run: AcquisitionRun;
  shard: AcquisitionOperationShard;
  dispatchKey: string;
  signal: AbortSignal;
}

export interface AcquisitionShardProcessingResult {
  status:
    | "succeeded"
    | "succeeded_empty"
    | "partial_success"
    | "failed";
  evidenceCount: number;
  usage: AcquisitionBudgetUsage;
  presentation?: AcquisitionShardPresentationResult;
}

export interface AcquisitionShardPresentationResult {
  rawResultCount: number;
  acceptedResultCount: number;
  duplicateResultCount: number;
  failedResultCount: number;
  providers: Array<{
    providerConnectionId: string;
    provider: string;
    status: "succeeded";
  }>;
  providerFailures: Array<{
    providerConnectionId: string;
    provider: string;
    errorCode: string;
    retryAfterAt: string | null;
  }>;
  candidateIds: string[];
  processedCandidateIds: string[];
  battleCardCandidateIds: string[];
  candidateFailures: Array<{
    candidateId: string;
    stage: "research" | "qualification" | "battle_card";
    errorCode: string;
  }>;
}

export interface AcquisitionShardProcessorPort {
  process(
    input: AcquisitionShardProcessingInput
  ): Promise<AcquisitionShardProcessingResult>;
}

export type AcquisitionShardWorkerFailureCode =
  | "UNSUPPORTED_SHARD_OPERATION"
  | "SHARD_START_FAILED"
  | "SHARD_PROCESSING_FAILED"
  | "SHARD_RESULT_INVALID"
  | "SHARD_BUDGET_ACCOUNTING_FAILED"
  | "SHARD_COMPLETION_FAILED";

export interface AcquisitionShardWorkerFailure {
  code: AcquisitionShardWorkerFailureCode;
  phase: "start" | "process" | "budget" | "complete";
  runId: string;
  shardId: string;
  operationKind: AcquisitionOperationKind;
  errorName: string;
}

type ProcessorMap = Partial<Record<
  AcquisitionOperationKind,
  AcquisitionShardProcessorPort
>>;

export class AcquisitionShardProcessorRegistry {
  private readonly processors: ProcessorMap;

  constructor(processors: ProcessorMap) {
    this.processors = { ...processors };
    for (const [kind, processor] of Object.entries(this.processors)) {
      if (!processor || typeof processor.process !== "function") {
        throw new TypeError(`Invalid acquisition shard processor: ${kind}`);
      }
    }
  }

  resolve(kind: AcquisitionOperationKind) {
    return this.processors[kind] ?? null;
  }
}

export interface AcquisitionPlanExecutionWorkerOptions {
  repository: AcquisitionPlanRunRepository;
  processorRegistry: AcquisitionShardProcessorRegistry;
  maxConcurrency?: number;
  workerActorId?: string;
  onError?: (failure: AcquisitionShardWorkerFailure) => void;
}

interface QueuedShard {
  runId: string;
  shardId: string;
  dispatchKey: string;
}

type RequestedControl = "pause" | "cancel";

interface ActiveShard extends QueuedShard {
  controller: AbortController;
}

function shardKey(runId: string, shardId: string) {
  return `${runId}\u001f${shardId}`;
}

function positiveInteger(value: unknown, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function validResult(
  result: AcquisitionShardProcessingResult
): result is AcquisitionShardProcessingResult {
  const usage = result?.usage;
  return Boolean(result)
    && [
      "succeeded",
      "succeeded_empty",
      "partial_success",
      "failed"
    ].includes(result.status)
    && Number.isSafeInteger(result.evidenceCount)
    && result.evidenceCount >= 0
    && Boolean(usage)
    && Object.values(usage).every(
      (value) => Number.isSafeInteger(value) && value >= 0
    )
    && Object.values(usage).some((value) => value > 0)
    && (result.status !== "succeeded" || result.evidenceCount > 0)
    && (result.status !== "succeeded_empty" || result.evidenceCount === 0)
    && (result.status !== "partial_success"
      || result.evidenceCount > 0
      || validZeroEvidenceCandidatePartial(result.presentation))
    && (result.status !== "failed" || result.evidenceCount === 0)
    && (!result.presentation || validPresentation(
      result.presentation,
      result.evidenceCount
    ));
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueIds(value: unknown) {
  return Array.isArray(value)
    && value.every(nonEmptyString)
    && new Set(value).size === value.length;
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).every((key) => allowed.includes(key));
}

function stableErrorCode(value: unknown) {
  return typeof value === "string"
    && /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
}

function idsBelongTo(
  ids: readonly unknown[],
  ownerIds: readonly string[]
) {
  const owners = new Set(ownerIds);
  return ids.every((id) =>
    typeof id === "string" && owners.has(id));
}

function validZeroEvidenceCandidatePartial(
  presentation: AcquisitionShardPresentationResult | undefined
) {
  if (!presentation) return false;
  return validPresentation(presentation, 0)
    && presentation.providers.length > 0
    && presentation.candidateIds.length > 0
    && presentation.candidateFailures.length > 0;
}

function isInvalidProcessorResult(error: unknown) {
  return Boolean(error)
    && typeof error === "object"
    && (error as { code?: unknown }).code === "INVALID_SEARCH_RESULT";
}

function validPresentation(
  presentation: AcquisitionShardPresentationResult,
  evidenceCount: number
) {
  const counts = [
    presentation.rawResultCount,
    presentation.acceptedResultCount,
    presentation.duplicateResultCount,
    presentation.failedResultCount
  ];
  const failedCandidateIds: unknown[] =
    Array.isArray(presentation.candidateFailures)
    ? presentation.candidateFailures.map((failure) =>
        failure && typeof failure === "object"
          ? (failure as { candidateId?: unknown }).candidateId
          : undefined)
    : [];
  return counts.every((count) => Number.isSafeInteger(count) && count >= 0)
    && presentation.acceptedResultCount === evidenceCount
    && presentation.rawResultCount >= presentation.acceptedResultCount
    && presentation.duplicateResultCount <= presentation.acceptedResultCount
    && uniqueIds(presentation.candidateIds)
    && uniqueIds(presentation.processedCandidateIds)
    && uniqueIds(presentation.battleCardCandidateIds)
    && idsBelongTo(
      presentation.processedCandidateIds,
      presentation.candidateIds
    )
    && idsBelongTo(
      presentation.battleCardCandidateIds,
      presentation.processedCandidateIds
    )
    && Array.isArray(presentation.providers)
    && presentation.providers.every((provider) =>
      hasOnlyKeys(provider, ["providerConnectionId", "provider", "status"])
      &&
      nonEmptyString(provider.providerConnectionId)
      && nonEmptyString(provider.provider)
      && provider.status === "succeeded"
    )
    && Array.isArray(presentation.providerFailures)
    && presentation.providerFailures.every((failure) =>
      hasOnlyKeys(failure, [
        "providerConnectionId",
        "provider",
        "errorCode",
        "retryAfterAt"
      ])
      &&
      nonEmptyString(failure.providerConnectionId)
      && nonEmptyString(failure.provider)
      && stableErrorCode(failure.errorCode)
      && (failure.retryAfterAt === null
        || (typeof failure.retryAfterAt === "string"
          && Number.isFinite(Date.parse(failure.retryAfterAt))))
    )
    && Array.isArray(presentation.candidateFailures)
    && uniqueIds(failedCandidateIds)
    && idsBelongTo(failedCandidateIds, presentation.candidateIds)
    && presentation.candidateFailures.every((failure) =>
      hasOnlyKeys(failure, ["candidateId", "stage", "errorCode"])
      &&
      nonEmptyString(failure.candidateId)
      && ["research", "qualification", "battle_card"].includes(
        failure.stage
      )
      && stableErrorCode(failure.errorCode)
    );
}

export class AcquisitionPlanExecutionWorker
implements AcquisitionExecutionPort {
  private readonly repository: AcquisitionPlanRunRepository;
  private readonly processorRegistry: AcquisitionShardProcessorRegistry;
  private readonly maxConcurrency: number;
  private readonly workerActorId: string;
  private readonly onError?: (
    failure: AcquisitionShardWorkerFailure
  ) => void;
  private readonly dispatchKeys = new Set<string>();
  private readonly queue: QueuedShard[] = [];
  private readonly activeShards = new Map<string, ActiveShard>();
  private readonly requestedControls = new Map<string, RequestedControl>();
  private readonly idleWaiters = new Set<() => void>();
  private service: AcquisitionPlanRunService | null = null;
  private activeCount = 0;
  private closed = false;
  private pumpScheduled = false;

  constructor(options: AcquisitionPlanExecutionWorkerOptions) {
    this.repository = options.repository;
    this.processorRegistry = options.processorRegistry;
    this.maxConcurrency = positiveInteger(options.maxConcurrency, 1);
    this.workerActorId = options.workerActorId?.trim()
      || "acquisition-plan-worker";
    this.onError = options.onError;
  }

  attachService(service: AcquisitionPlanRunService) {
    if (this.service && this.service !== service) {
      throw new Error("Acquisition plan run service is already attached");
    }
    this.service = service;
    return this;
  }

  async enqueue(input: {
    runId: string;
    shardIds: string[];
    dispatchKey: string;
  }) {
    this.queueDispatch(input);
  }

  async requestPause(input: {
    runId: string;
    shardIds: string[];
    dispatchKey: string;
  }) {
    this.requestControl(input, "pause");
  }

  async resume(input: {
    runId: string;
    shardIds: string[];
    dispatchKey: string;
  }) {
    this.queueDispatch(input);
  }

  async requestCancel(input: {
    runId: string;
    shardIds: string[];
    dispatchKey: string;
  }) {
    this.requestControl(input, "cancel");
  }

  async waitForIdle() {
    if (this.queue.length === 0 && this.activeCount === 0) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  async close() {
    if (this.closed) {
      await this.waitForIdle();
      return;
    }
    this.closed = true;
    await this.waitForIdle();
  }

  private queueDispatch(input: {
    runId: string;
    shardIds: string[];
    dispatchKey: string;
  }) {
    const dispatchKey = this.claimDispatch(input.dispatchKey);
    if (!dispatchKey) return;
    for (const shardId of [...new Set(input.shardIds)]) {
      if (!shardId?.trim()) continue;
      this.queue.push({
        runId: input.runId,
        shardId,
        dispatchKey
      });
    }
    this.schedulePump();
  }

  private requestControl(
    input: {
      runId: string;
      shardIds: string[];
      dispatchKey: string;
    },
    control: RequestedControl
  ) {
    if (!this.claimDispatch(input.dispatchKey)) return;
    for (const shardId of new Set(input.shardIds)) {
      const key = shardKey(input.runId, shardId);
      this.requestedControls.set(key, control);
      this.activeShards.get(key)?.controller.abort(
        new DOMException(
          control === "pause" ? "pause requested" : "cancel requested",
          "AbortError"
        )
      );
    }
  }

  private claimDispatch(dispatchKeyValue: string) {
    if (this.closed) throw new Error("Acquisition plan execution worker is closed");
    if (!this.service) {
      throw new Error("Acquisition plan run service is not attached");
    }
    const dispatchKey = dispatchKeyValue?.trim();
    if (!dispatchKey || this.dispatchKeys.has(dispatchKey)) return null;
    this.dispatchKeys.add(dispatchKey);
    return dispatchKey;
  }

  private schedulePump() {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump() {
    while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.activeCount += 1;
      void this.executeShard(task)
        .catch(() => undefined)
        .finally(() => {
          this.activeCount -= 1;
          this.pump();
          this.resolveIdle();
        });
    }
    this.resolveIdle();
  }

  private resolveIdle() {
    if (this.queue.length > 0 || this.activeCount > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private async executeShard(task: QueuedShard) {
    const service = this.service;
    if (!service) return;
    const key = shardKey(task.runId, task.shardId);
    const controller = new AbortController();
    let operationKind: AcquisitionOperationKind = "search";
    let phase: AcquisitionShardWorkerFailure["phase"] = "start";
    this.activeShards.set(key, { ...task, controller });
    try {
      const run = await this.repository.getRun(task.runId);
      const shard = (await this.repository.listRunShards(task.runId))
        .find((item) => item.id === task.shardId);
      if (!run || !shard) return;
      if (shard.status !== "queued"
        && shard.status !== "retry_scheduled") {
        return;
      }
      operationKind = shard.kind;
      const scope: AcquisitionScope = {
        ownerId: run.ownerId,
        teamId: run.teamId,
        actorId: this.workerActorId
      };
      const processor = this.processorRegistry.resolve(shard.kind);
      if (!processor) {
        this.reportFailure({
          code: "UNSUPPORTED_SHARD_OPERATION",
          phase: "process",
          runId: task.runId,
          shardId: task.shardId,
          operationKind,
          errorName: "AcquisitionShardProcessorUnsupportedError"
        });
        await this.failShard(service, scope, task);
        return;
      }

      await service.startShard(scope, task.runId, task.shardId);
      if (await this.settleRequestedControl(service, scope, task)) return;
      const startedRun = await this.repository.getRun(task.runId);
      const startedShard = (await this.repository.listRunShards(task.runId))
        .find((item) => item.id === task.shardId);
      if (!startedRun || !startedShard) return;
      phase = "process";
      const result = await processor.process({
        scope,
        run: startedRun,
        shard: startedShard,
        dispatchKey: task.dispatchKey,
        signal: controller.signal
      });
      if (await this.settleRequestedControl(service, scope, task)) return;
      if (!validResult(result)) {
        this.reportFailure({
          code: "SHARD_RESULT_INVALID",
          phase,
          runId: task.runId,
          shardId: task.shardId,
          operationKind,
          errorName: "TypeError"
        });
        throw new TypeError("Invalid acquisition shard processor result");
      }
      phase = "budget";
      await service.consumeShardBudget(
        scope,
        task.runId,
        task.shardId,
        {
          idempotencyKey:
            `acquisition-worker:${task.runId}:${task.shardId}:result-v1`,
          usage: result.usage
        }
      );
      if (await this.settleRequestedControl(service, scope, task)) return;
      const budgetedShard = (
        await this.repository.listRunShards(task.runId)
      ).find((item) => item.id === task.shardId);
      if (budgetedShard?.status === "budget_exhausted") return;
      phase = "complete";
      await service.completeShard(scope, task.runId, task.shardId, {
        status: result.status,
        evidenceCount: result.evidenceCount,
        presentation: result.presentation,
        idempotencyKey: task.dispatchKey
      });
    } catch (error) {
      const run = await this.repository.getRun(task.runId);
      if (!run) return;
      const scope: AcquisitionScope = {
        ownerId: run.ownerId,
        teamId: run.teamId,
        actorId: this.workerActorId
      };
      if (phase === "start"
        && error instanceof AcquisitionPlanRunError
        && error.code === "shard_not_startable") {
        return;
      }
      if (await this.settleRequestedControl(service, scope, task)) return;
      if (phase !== "process"
        || !(error instanceof TypeError
          && error.message === "Invalid acquisition shard processor result")) {
        this.reportFailure({
          code: phase === "start"
            ? "SHARD_START_FAILED"
            : phase === "process"
              ? isInvalidProcessorResult(error)
                ? "SHARD_RESULT_INVALID"
                : "SHARD_PROCESSING_FAILED"
              : phase === "budget"
                ? "SHARD_BUDGET_ACCOUNTING_FAILED"
                : "SHARD_COMPLETION_FAILED",
          phase,
          runId: task.runId,
          shardId: task.shardId,
          operationKind,
          errorName: error instanceof Error ? error.name : "Error"
        });
      }
      await this.failShard(service, scope, task, error);
    } finally {
      this.activeShards.delete(key);
      this.requestedControls.delete(key);
    }
  }

  private reportFailure(failure: AcquisitionShardWorkerFailure) {
    try {
      this.onError?.(Object.freeze({ ...failure }));
    } catch {
      // Error reporting is observational and must never stop queue progress.
    }
  }

  private async settleRequestedControl(
    service: AcquisitionPlanRunService,
    scope: AcquisitionScope,
    task: QueuedShard
  ) {
    const control = this.requestedControls.get(
      shardKey(task.runId, task.shardId)
    );
    if (!control) return false;
    const shard = (await this.repository.listRunShards(task.runId))
      .find((item) => item.id === task.shardId);
    if (control === "pause" && shard?.status === "pause_requested") {
      await service.acknowledgeShardPaused(
        scope,
        task.runId,
        task.shardId
      );
      return true;
    }
    if (control === "cancel" && shard?.status === "cancel_requested") {
      await service.acknowledgeShardCancelled(
        scope,
        task.runId,
        task.shardId
      );
      return true;
    }
    return shard?.status === "paused"
      || shard?.status === "cancelled";
  }

  private async failShard(
    service: AcquisitionPlanRunService,
    scope: AcquisitionScope,
    task: QueuedShard,
    cause?: unknown
  ) {
    try {
      const shard = (await this.repository.listRunShards(task.runId))
        .find((item) => item.id === task.shardId);
      if (shard?.status === "queued" || shard?.status === "retry_scheduled") {
        await service.startShard(scope, task.runId, task.shardId);
      }
      const current = (await this.repository.listRunShards(task.runId))
        .find((item) => item.id === task.shardId);
      if (current?.status === "running") {
        await service.completeShard(scope, task.runId, task.shardId, {
          status: "failed",
          evidenceCount: 0
        });
      }
    } catch (settlementError) {
      if (cause instanceof AcquisitionPlanRunError) return;
      if (settlementError instanceof AcquisitionPlanRunError) return;
      throw settlementError;
    }
  }
}
