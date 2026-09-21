import { decryptAgentJobPayload, encryptAgentJobPayload } from "./agent-job-security.js";
import {
  cancelAgentJob,
  completeAgentJob,
  enqueueAgentJob,
  findAgentJobByIdempotency,
  startAgentJob
} from "./agent-jobs.js";
import type { AcquisitionCandidate } from "./acquisition-domain.js";
import type { AcquisitionDomainService } from "./acquisition-domain-service.js";
import type { AcquisitionPlanDraftGenerator } from "./acquisition-plan-draft.js";
import type {
  AcquisitionModelSnapshotRef,
  AcquisitionPlanPayload,
  AcquisitionPlanRunRepository
} from "./acquisition-plan-run-repository.js";
import type {
  AcquisitionPlanRunService,
  AcquisitionScope
} from "./acquisition-plan-run-service.js";
import type { AcquisitionPrivateDomainHandoffService } from "./acquisition-private-domain-handoff.js";
import type { CrmStore } from "./store.js";
import type { AgentJob } from "./types.js";

export const CFO_ACQUISITION_WORKFLOW_JOB_TYPE =
  "cfo.acquisition.orchestrate";

export type CfoAcquisitionWorkflowStage =
  | "preparing_plan"
  | "awaiting_plan_approval"
  | "running_acquisition"
  | "awaiting_candidate_review"
  | "completed"
  | "completed_empty"
  | "cancelled"
  | "failed";

export interface CfoAcquisitionWorkflowView {
  workflowId: string;
  instruction: string;
  stage: CfoAcquisitionWorkflowStage;
  summary: string;
  planId: string | null;
  planEtag: string | null;
  planReview: {
    targetPlatform: string;
    objective: string;
    providers: Array<{ providerId: string; status: string }>;
    operations: Array<{
      kind: string;
      query: string;
      allocatedBudget: {
        requests: number;
        results: number;
        amountMinor: number;
        durationSeconds: number;
      };
    }>;
    budget: {
      currency: string;
      requests: number;
      results: number;
      amountMinor: number;
      durationSeconds: number;
    };
  } | null;
  runId: string | null;
  runStatus: string | null;
  candidates: Array<{
    candidateId: string;
    displayName: string;
    decisionVersion: string;
    discoveredEventId: string;
    decision: "pending" | "approved" | "rejected" | "do_not_contact";
    customerId: string | null;
    todoId: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
}

interface StoredWorkflowState extends CfoAcquisitionWorkflowView {}

interface CfoCandidateDecisionInput {
  candidateId: string;
  action: "approved" | "rejected" | "do_not_contact";
  reason: string | null;
  dueAt?: string;
  priority?: "high" | "medium" | "normal";
}

export interface CfoAcquisitionWorkflowDependencies {
  store: Pick<CrmStore,
    "users" | "agentJobs" | "agentJobIdempotencyAliases" | "persist">;
  planDraftGenerator: Pick<AcquisitionPlanDraftGenerator, "generate">;
  resolveModelSnapshot(
    scope: AcquisitionScope,
    input: { connectionId: string | null; idempotencyKey: string }
  ): Promise<AcquisitionModelSnapshotRef>;
  planService: Pick<AcquisitionPlanRunService,
    "createPlan" | "getPlan" | "approvePlan" | "createRun" | "getRun" |
    "cancelRun">;
  planRepository: Pick<AcquisitionPlanRunRepository,
    "listRunCandidateLinks">;
  domainService: Pick<AcquisitionDomainService,
    "getCandidate" | "reviewCandidate">;
  handoffService: Pick<AcquisitionPrivateDomainHandoffService, "create">;
  now?: () => string;
}

function assertScope(scope: AcquisitionScope) {
  if (!scope.ownerId.trim() || !scope.teamId.trim()
    || !scope.actorId.trim() || scope.ownerId !== scope.actorId) {
    throw new CfoAcquisitionWorkflowError(403, "cfo_workflow_scope_invalid");
  }
}

function publicState(state: StoredWorkflowState): CfoAcquisitionWorkflowView {
  return structuredClone(state);
}

function displayName(candidate: AcquisitionCandidate) {
  return candidate.profile.kind === "individual"
    ? candidate.profile.publicDisplayName
    : candidate.profile.name;
}

export class CfoAcquisitionWorkflowError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "CfoAcquisitionWorkflowError";
  }
}

export class CfoAcquisitionWorkflowService {
  readonly #now: () => string;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(private readonly dependencies: CfoAcquisitionWorkflowDependencies) {
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async createDraft(scope: AcquisitionScope, input: {
    instruction: string;
    idempotencyKey: string;
  }): Promise<CfoAcquisitionWorkflowView> {
    assertScope(scope);
    const instruction = input.instruction.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!instruction || instruction.length > 20_000) {
      throw new CfoAcquisitionWorkflowError(422, "cfo_workflow_instruction_invalid");
    }
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new CfoAcquisitionWorkflowError(400, "cfo_workflow_idempotency_invalid");
    }
    const scopedIdempotencyKey = `${scope.ownerId}:${idempotencyKey}`;
    const existing = findAgentJobByIdempotency(this.dependencies.store as CrmStore, {
      teamId: scope.teamId,
      jobType: CFO_ACQUISITION_WORKFLOW_JOB_TYPE,
      idempotencyKey: scopedIdempotencyKey
    });
    if (existing) {
      const storedInstruction = String(decryptAgentJobPayload(
        existing, "input", existing.inputJsonEncrypted
      ).instruction ?? "");
      if (storedInstruction !== instruction) {
        throw new CfoAcquisitionWorkflowError(409, "cfo_workflow_idempotency_conflict");
      }
      return publicState(this.#readState(existing));
    }

    const createdAt = this.#now();
    const { job } = enqueueAgentJob(this.dependencies.store as CrmStore, {
      teamId: scope.teamId,
      ownerId: scope.ownerId,
      jobType: CFO_ACQUISITION_WORKFLOW_JOB_TYPE,
      aggregateType: "cfo_acquisition_workflow_v1",
      aggregateId: "cfo-acquisition-workflow",
      idempotencyKey: scopedIdempotencyKey,
      policyVersion: "cfo-acquisition-workflow.v1",
      input: { instruction }
    });
    const state: StoredWorkflowState = {
      workflowId: job.id,
      instruction,
      stage: "preparing_plan",
      summary: "正在生成可核对的获客计划。",
      planId: null,
      planEtag: null,
      planReview: null,
      runId: null,
      runStatus: null,
      candidates: [],
      createdAt,
      updatedAt: createdAt
    };
    this.#setState(job, state);
    await this.dependencies.store.persist();

    try {
      const generated = await this.dependencies.planDraftGenerator.generate({
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        actorId: scope.actorId,
        sessionId: job.id,
        transcript: [],
        prompt: instruction,
        targetPlatform: "douyin"
      });
      const connectionId = generated.planDraft.modelConnectionId ?? null;
      const snapshot = await this.dependencies.resolveModelSnapshot(scope, {
        connectionId,
        idempotencyKey: `cfo-workflow-snapshot:${job.id}`
      });
      const { modelConnectionId: _ignored, ...draft } = generated.planDraft;
      const plan = await this.dependencies.planService.createPlan(
        scope,
        { ...draft, modelSnapshotRef: snapshot } as AcquisitionPlanPayload,
        {
          idempotencyKey: `cfo-workflow-plan:${job.id}`,
          idempotencyDiscriminator: connectionId
        }
      );
      state.stage = "awaiting_plan_approval";
      state.summary = generated.summary;
      state.planId = plan.id;
      state.planEtag = plan.etag;
      state.planReview = {
        targetPlatform: plan.payload.targetPlatform ?? "web",
        objective: plan.payload.objective,
        providers: plan.payload.providerConnections.map((connection) => ({
          providerId: connection.providerId,
          status: connection.status
        })),
        operations: plan.payload.operations.map((operation) => ({
          kind: operation.kind,
          query: operation.query ?? "",
          allocatedBudget: structuredClone(operation.allocatedBudget)
        })),
        budget: {
          currency: plan.payload.budgetSnapshot.billingCurrency,
          requests: plan.payload.budgetSnapshot.maxRequests,
          results: plan.payload.budgetSnapshot.maxResults,
          amountMinor: plan.payload.budgetSnapshot.maxAmountMinor,
          durationSeconds: plan.payload.budgetSnapshot.maxDurationSeconds
        }
      };
      state.updatedAt = this.#now();
      this.#setState(job, state);
      await this.dependencies.store.persist();
      return publicState(state);
    } catch (error) {
      job.status = "failed";
      job.errorCode = "CFO_WORKFLOW_PLAN_PREPARATION_FAILED";
      job.errorMessage = "获客计划准备失败";
      job.finishedAt = this.#now();
      state.stage = "failed";
      state.summary = "获客计划准备失败，请检查搜索与模型连接。";
      state.updatedAt = job.finishedAt;
      this.#setState(job, state);
      await this.dependencies.store.persist();
      throw error;
    }
  }

  async get(
    scope: AcquisitionScope,
    workflowId: string
  ): Promise<CfoAcquisitionWorkflowView> {
    assertScope(scope);
    return publicState(this.#readState(this.#requireJob(scope, workflowId)));
  }

  async latest(scope: AcquisitionScope): Promise<CfoAcquisitionWorkflowView | null> {
    assertScope(scope);
    const job = this.dependencies.store.agentJobs
      .filter((item) => item.jobType === CFO_ACQUISITION_WORKFLOW_JOB_TYPE
        && item.ownerId === scope.ownerId
        && item.teamId === scope.teamId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return job ? publicState(this.#readState(job)) : null;
  }

  async approveAndRun(scope: AcquisitionScope, workflowId: string, input: {
    reason: string;
    idempotencyKey: string;
  }): Promise<CfoAcquisitionWorkflowView> {
    return this.#serialized(workflowId, async () => {
      assertScope(scope);
      if (!input.reason.trim()) {
        throw new CfoAcquisitionWorkflowError(422, "cfo_workflow_approval_reason_required");
      }
      if (input.idempotencyKey.trim().length < 8) {
        throw new CfoAcquisitionWorkflowError(400, "cfo_workflow_idempotency_invalid");
      }
      const job = this.#requireJob(scope, workflowId);
      const state = this.#readState(job);
      if (["running_acquisition", "awaiting_candidate_review", "completed", "completed_empty"]
        .includes(state.stage)) {
        return publicState(state);
      }
      if (state.stage === "cancelled") {
        throw new CfoAcquisitionWorkflowError(409, "cfo_workflow_cancelled");
      }
      if (state.stage !== "awaiting_plan_approval" || !state.planId) {
        throw new CfoAcquisitionWorkflowError(409, "cfo_workflow_not_approvable");
      }

      let plan = await this.dependencies.planService.getPlan(scope, state.planId);
      if (plan.status === "draft") {
        plan = await this.dependencies.planService.approvePlan(
          scope,
          state.planId,
          plan.etag,
          { decision: "approve", reason: input.reason.trim() }
        );
        state.planEtag = plan.etag;
        state.updatedAt = this.#now();
        this.#setState(job, state);
        await this.dependencies.store.persist();
      } else if (plan.status !== "approved") {
        throw new CfoAcquisitionWorkflowError(409, "cfo_workflow_plan_not_approved");
      }

      const run = await this.dependencies.planService.createRun(scope, state.planId, {
        idempotencyKey: `cfo-workflow-run:${job.id}`,
        reason: input.reason.trim()
      });
      if (job.status === "queued") startAgentJob(job);
      state.stage = "running_acquisition";
      state.summary = "获客任务已批准并在后台执行。";
      state.runId = run.id;
      state.runStatus = run.status;
      state.updatedAt = this.#now();
      this.#setState(job, state);
      await this.dependencies.store.persist();
      return publicState(state);
    });
  }

  async reconcile(
    scope: AcquisitionScope,
    workflowId: string
  ): Promise<CfoAcquisitionWorkflowView> {
    return this.#serialized(workflowId, async () => {
      assertScope(scope);
      const job = this.#requireJob(scope, workflowId);
      const state = this.#readState(job);
      if (state.stage !== "running_acquisition" || !state.runId) {
        return publicState(state);
      }
      const run = await this.dependencies.planService.getRun(scope, state.runId);
      state.runStatus = run.status;
      state.updatedAt = this.#now();
      if (!["succeeded", "succeeded_empty", "partial_success", "budget_exhausted", "failed", "cancelled"]
        .includes(run.status)) {
        this.#setState(job, state);
        await this.dependencies.store.persist();
        return publicState(state);
      }
      if (run.status === "cancelled") {
        if (["queued", "running", "retry_scheduled"].includes(job.status)) cancelAgentJob(job);
        state.stage = "cancelled";
        state.summary = "获客任务已取消。";
        this.#setState(job, state);
        await this.dependencies.store.persist();
        return publicState(state);
      }
      if (run.status === "failed") {
        job.status = "failed";
        job.errorCode = "CFO_WORKFLOW_ACQUISITION_FAILED";
        job.errorMessage = "获客执行失败";
        job.finishedAt = this.#now();
        state.stage = "failed";
        state.summary = "获客执行失败，请检查运行详情。";
        this.#setState(job, state);
        await this.dependencies.store.persist();
        return publicState(state);
      }

      const links = await this.dependencies.planRepository.listRunCandidateLinks(run.id);
      const byCandidate = new Map(links.map((link) => [link.candidateId, link]));
      const candidates = [] as StoredWorkflowState["candidates"];
      for (const [candidateId, link] of byCandidate) {
        const candidate = await this.dependencies.domainService.getCandidate(scope, candidateId);
        if (!candidate?.latestDecisionVersion) continue;
        candidates.push({
          candidateId,
          displayName: displayName(candidate),
          decisionVersion: candidate.latestDecisionVersion,
          discoveredEventId: link.eventId,
          decision: "pending",
          customerId: null,
          todoId: null
        });
      }
      state.candidates = candidates;
      state.stage = candidates.length > 0
        ? "awaiting_candidate_review"
        : "completed_empty";
      state.summary = candidates.length > 0
        ? `采集完成，${candidates.length} 位候选人等待人工决策。`
        : "采集完成，没有可进入人工决策的候选人。";
      state.updatedAt = this.#now();
      if (job.status === "running" && state.stage === "completed_empty") {
        completeAgentJob(job, state as unknown as Record<string, unknown>);
      } else {
        this.#setState(job, state);
      }
      await this.dependencies.store.persist();
      return publicState(state);
    });
  }

  async decideCandidate(scope: AcquisitionScope, workflowId: string, input: CfoCandidateDecisionInput & {
    idempotencyKey: string;
  }): Promise<CfoAcquisitionWorkflowView> {
    return this.#serialized(workflowId, async () => {
      assertScope(scope);
      if (input.idempotencyKey.trim().length < 8) {
        throw new CfoAcquisitionWorkflowError(400, "cfo_workflow_idempotency_invalid");
      }
      const job = this.#requireJob(scope, workflowId);
      const state = this.#readState(job);
      await this.#decideCandidateLocked(scope, job, state, input);
      return publicState(state);
    });
  }

  async decideCandidates(scope: AcquisitionScope, workflowId: string, input: {
    decisions: CfoCandidateDecisionInput[];
    idempotencyKey: string;
  }): Promise<CfoAcquisitionWorkflowView> {
    return this.#serialized(workflowId, async () => {
      assertScope(scope);
      if (input.idempotencyKey.trim().length < 8) {
        throw new CfoAcquisitionWorkflowError(400, "cfo_workflow_idempotency_invalid");
      }
      if (input.decisions.length < 1 || input.decisions.length > 100) {
        throw new CfoAcquisitionWorkflowError(400, "cfo_workflow_batch_size_invalid");
      }
      const candidateIds = input.decisions.map((decision) => decision.candidateId);
      if (new Set(candidateIds).size !== candidateIds.length) {
        throw new CfoAcquisitionWorkflowError(400, "cfo_workflow_batch_candidate_duplicate");
      }
      const job = this.#requireJob(scope, workflowId);
      const state = this.#readState(job);
      for (const decision of input.decisions) {
        await this.#decideCandidateLocked(scope, job, state, decision);
      }
      return publicState(state);
    });
  }

  async #decideCandidateLocked(
    scope: AcquisitionScope,
    job: AgentJob,
    state: StoredWorkflowState,
    input: CfoCandidateDecisionInput
  ) {
    if (state.stage === "cancelled") {
      throw new CfoAcquisitionWorkflowError(409, "cfo_workflow_cancelled");
    }
    const record = state.candidates.find((item) => item.candidateId === input.candidateId);
    if (!record) throw new CfoAcquisitionWorkflowError(404, "cfo_workflow_candidate_not_found");
    if (record.decision !== "pending") {
      if (record.decision !== input.action) {
        throw new CfoAcquisitionWorkflowError(409, "cfo_workflow_candidate_decision_conflict");
      }
      return;
    }
    if (state.stage !== "awaiting_candidate_review" || !state.runId) {
      throw new CfoAcquisitionWorkflowError(409, "cfo_workflow_not_reviewable");
    }
    await this.dependencies.domainService.reviewCandidate(scope, record.candidateId, {
      action: input.action,
      decisionVersion: record.decisionVersion,
      reason: input.reason,
      idempotencyKey: `cfo-workflow-review:${job.id}:${record.candidateId}:${input.action}`
    });
    if (input.action === "approved") {
      const handoff = await this.dependencies.handoffService.create(
        scope,
        record.candidateId,
        {
          operationCode: "handoff_acquisition_candidate_v1",
          runId: state.runId,
          discoveredEventId: record.discoveredEventId,
          decisionVersion: record.decisionVersion,
          mode: "create_new",
          existingCustomerId: "",
          followUp: {
            title: `跟进获客候选人：${record.displayName}`,
            dueAt: input.dueAt ?? new Date(Date.parse(this.#now()) + 86_400_000).toISOString(),
            priority: input.priority ?? "normal"
          }
        },
        `cfo-workflow-handoff:${job.id}:${record.candidateId}:approved`
      );
      record.customerId = handoff.customer.id;
      record.todoId = handoff.todo.id;
    }
    record.decision = input.action;
    const pending = state.candidates.filter((candidate) => candidate.decision === "pending").length;
    state.stage = pending === 0 ? "completed" : "awaiting_candidate_review";
    state.summary = pending === 0
      ? "候选人决策与 CRM 跟进已全部完成。"
      : `还有 ${pending} 位候选人等待人工决策。`;
    state.updatedAt = this.#now();
    if (job.status === "running" && state.stage === "completed") {
      completeAgentJob(job, state as unknown as Record<string, unknown>);
    } else {
      this.#setState(job, state);
    }
    await this.dependencies.store.persist();
  }

  async cancel(scope: AcquisitionScope, workflowId: string, input: {
    reason: string;
  }): Promise<CfoAcquisitionWorkflowView> {
    return this.#serialized(workflowId, async () => {
      assertScope(scope);
      const job = this.#requireJob(scope, workflowId);
      const state = this.#readState(job);
      if (state.stage === "cancelled") return publicState(state);
      if (["completed", "completed_empty", "failed"].includes(state.stage)) {
        throw new CfoAcquisitionWorkflowError(409, "cfo_workflow_not_cancellable");
      }
      state.stage = "cancelled";
      state.summary = "任务已取消，未开始的 CRM 写入不会执行。";
      state.updatedAt = this.#now();
      if (["queued", "running", "retry_scheduled"].includes(job.status)) cancelAgentJob(job);
      this.#setState(job, state);
      await this.dependencies.store.persist();
      if (state.runId) {
        try {
          const run = await this.dependencies.planService.getRun(scope, state.runId);
          if (!["succeeded", "succeeded_empty", "partial_success", "budget_exhausted", "failed", "cancelled"]
            .includes(run.status)) {
            await this.dependencies.planService.cancelRun(scope, run.id, run.etag, {
              reason: input.reason.trim() || "用户取消 CFO 获客任务"
            });
          }
        } catch {
          state.summary = "任务已在经营总管侧取消；远端运行取消状态等待后台核对。";
          state.updatedAt = this.#now();
          this.#setState(job, state);
          await this.dependencies.store.persist();
        }
      }
      return publicState(state);
    });
  }

  async reconcileRunningJobs() {
    const jobs = this.dependencies.store.agentJobs.filter((job) =>
      job.jobType === CFO_ACQUISITION_WORKFLOW_JOB_TYPE
      && job.status === "running"
    );
    for (const job of jobs) {
      try {
        await this.reconcile({
          ownerId: job.ownerId,
          teamId: job.teamId,
          actorId: job.ownerId
        }, job.id);
      } catch {
        // A single unavailable run must not block reconciliation for other owners.
      }
    }
  }

  #requireJob(scope: AcquisitionScope, workflowId: string) {
    const job = this.dependencies.store.agentJobs.find((item) =>
      item.id === workflowId
      && item.jobType === CFO_ACQUISITION_WORKFLOW_JOB_TYPE
      && item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
    );
    if (!job) throw new CfoAcquisitionWorkflowError(404, "cfo_workflow_not_found");
    return job;
  }

  async #serialized<T>(workflowId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(workflowId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#locks.set(workflowId, current);
    try {
      return await current;
    } finally {
      if (this.#locks.get(workflowId) === current) this.#locks.delete(workflowId);
    }
  }

  #readState(job: AgentJob): StoredWorkflowState {
    const value = decryptAgentJobPayload(job, "output", job.outputJsonEncrypted);
    if (value.workflowId !== job.id || value.instruction === undefined) {
      throw new CfoAcquisitionWorkflowError(409, "cfo_workflow_state_invalid");
    }
    return value as unknown as StoredWorkflowState;
  }

  #setState(job: AgentJob, state: StoredWorkflowState) {
    job.outputJsonEncrypted = encryptAgentJobPayload(
      job,
      "output",
      state as unknown as Record<string, unknown>
    );
  }
}
