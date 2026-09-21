import type {
  ApiResource,
  DouyinPlanInput,
  PlanApprovalInput,
  RunCreateInput
} from "./task-creation-api";

export interface TaskCreationWorkflowApi {
  createPlan(
    input: DouyinPlanInput,
    idempotencyKey: string
  ): Promise<ApiResource<Record<string, unknown>>>;
  approvePlan(
    planId: string,
    etag: string,
    input: PlanApprovalInput
  ): Promise<ApiResource<Record<string, unknown>>>;
  createRun(
    planId: string,
    input: RunCreateInput,
    idempotencyKey: string
  ): Promise<Record<string, unknown>>;
}

export interface TaskCreationWorkflowInput {
  planInput: DouyinPlanInput;
  approval: PlanApprovalInput;
  run: RunCreateInput;
  onStage?: (
    stage: "creating-plan" | "approving-plan" | "creating-run"
  ) => void;
}

export interface TaskCreationWorkflowResult {
  plan: ApiResource<Record<string, unknown>>;
  approval: ApiResource<Record<string, unknown>>;
  run: Record<string, unknown>;
}

interface PendingWorkflow {
  signature: string;
  planKey: string;
  runKey: string;
  plan?: ApiResource<Record<string, unknown>>;
  planId?: string;
  approval?: ApiResource<Record<string, unknown>>;
  approvedPlanId?: string;
}

function resourceId(
  resource: ApiResource<Record<string, unknown>>,
  fallback = ""
): string {
  return typeof resource.data.id === "string" ? resource.data.id : fallback;
}

export function createTaskCreationWorkflow(
  api: TaskCreationWorkflowApi,
  idempotencyKeyFactory: () => string = () => globalThis.crypto.randomUUID()
) {
  let pending: PendingWorkflow | null = null;

  return {
    async execute(
      input: TaskCreationWorkflowInput
    ): Promise<TaskCreationWorkflowResult> {
      const signature = JSON.stringify(input.planInput);
      if (!pending || pending.signature !== signature) {
        pending = {
          signature,
          planKey: idempotencyKeyFactory(),
          runKey: idempotencyKeyFactory()
        };
      }

      if (!pending.plan || !pending.planId) {
        input.onStage?.("creating-plan");
        pending.plan = await api.createPlan(input.planInput, pending.planKey);
        pending.planId = resourceId(pending.plan);
        if (!pending.planId || !pending.plan.etag) {
          throw new Error("计划创建成功，但响应缺少计划 ID 或 ETag");
        }
      }

      if (!pending.approval || !pending.approvedPlanId) {
        input.onStage?.("approving-plan");
        pending.approval = await api.approvePlan(
          pending.planId,
          pending.plan.etag!,
          input.approval
        );
        pending.approvedPlanId = resourceId(
          pending.approval,
          pending.planId
        );
      }

      input.onStage?.("creating-run");
      const run = await api.createRun(
        pending.approvedPlanId,
        input.run,
        pending.runKey
      );
      const result: TaskCreationWorkflowResult = {
        plan: pending.plan,
        approval: pending.approval,
        run
      };
      pending = null;
      return result;
    },

    pendingPlanId(): string | null {
      return pending?.planId ?? null;
    },

    reset(): void {
      pending = null;
    }
  };
}
