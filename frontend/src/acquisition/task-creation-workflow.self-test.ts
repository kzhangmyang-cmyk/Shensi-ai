import { strict as assert } from "node:assert";
import { createTaskCreationWorkflow } from "./task-creation-workflow";
import type {
  ApiResource,
  DouyinPlanInput,
  PlanApprovalInput,
  RunCreateInput
} from "./task-creation-api";

let createCalls = 0;
let approvalCalls = 0;
let runCalls = 0;
const createKeys: string[] = [];
const runKeys: string[] = [];

const workflow = createTaskCreationWorkflow({
  async createPlan(
    _input: DouyinPlanInput,
    idempotencyKey: string
  ): Promise<ApiResource<Record<string, unknown>>> {
    createCalls += 1;
    createKeys.push(idempotencyKey);
    return { data: { id: "plan-resume-1" }, etag: '"plan:1"' };
  },
  async approvePlan(
    _planId: string,
    _etag: string,
    _input: PlanApprovalInput
  ): Promise<ApiResource<Record<string, unknown>>> {
    approvalCalls += 1;
    if (approvalCalls === 1) throw new Error("批准暂时失败");
    return { data: { id: "plan-resume-1" }, etag: '"plan:2"' };
  },
  async createRun(
    _planId: string,
    _input: RunCreateInput,
    idempotencyKey: string
  ): Promise<Record<string, unknown>> {
    runCalls += 1;
    runKeys.push(idempotencyKey);
    if (runCalls === 1) throw new Error("启动暂时失败");
    return { id: "run-resume-1", status: "queued" };
  }
}, (() => {
  let serial = 0;
  return () => `workflow-key-${++serial}`;
})());

const planInput = { targetPlatform: "douyin" } as DouyinPlanInput;
const attempt = {
  planInput,
  approval: { decision: "approve", reason: "人工批准" } as const,
  run: { reason: "人工启动" }
};

await assert.rejects(() => workflow.execute(attempt), /批准暂时失败/);
assert.equal(workflow.pendingPlanId(), "plan-resume-1");

await assert.rejects(() => workflow.execute(attempt), /启动暂时失败/);
const completed = await workflow.execute(attempt);

assert.equal(completed.run.id, "run-resume-1");
assert.equal(createCalls, 1);
assert.equal(approvalCalls, 2);
assert.equal(runCalls, 2);
assert.deepEqual(createKeys, ["workflow-key-1"]);
assert.deepEqual(runKeys, ["workflow-key-2", "workflow-key-2"]);
assert.equal(workflow.pendingPlanId(), null);
