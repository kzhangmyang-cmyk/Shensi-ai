import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type {
  AgentMessage
} from "@earendil-works/pi-agent-core";
import {
  AcquisitionCopilotError,
  AcquisitionCopilotService,
  InMemoryAcquisitionCopilotRepository,
  type AcquisitionCopilotRunInput
} from "./acquisition-copilot-service.js";
import {
  acquisitionPublicPlanCreateSchema
} from "./acquisition-plan-contract.js";

const planDraft = {
  name: "Copilot 计划草稿",
  objective: "发现公开企业需求",
  icp: {
    industries: ["企业服务"],
    regions: ["中国"],
    organizationCriteria: ["公开采购需求"],
    individualCriteria: ["公开经营需求"],
    exclusionRules: ["明确拒绝联系"]
  },
  subjectChannels: {
    organization: true,
    individual: false
  },
  providerConnections: [{
    connectionId: "search-connection-a",
    providerId: "brave",
    kind: "search" as const,
    status: "active" as const,
    credentialVersion: 1
  }],
  operations: [{
    operationId: "operation-a",
    subjectChannel: "organization" as const,
    kind: "search" as const,
    connectionId: "search-connection-a",
    query: "企业服务 公开采购",
    allocatedBudget: {
      requests: 1,
      results: 10,
      amountMinor: 0,
      durationSeconds: 60
    }
  }],
  budgetSnapshot: {
    billingCurrency: "CNY",
    maxRequests: 1,
    maxResults: 10,
    maxAmountMinor: 0,
    maxDurationSeconds: 60
  },
  modelConnectionId: "connection-a",
  stopConditions: {
    stopWhenBudgetExhausted: true,
    stopWhenNoMoreResults: true
  }
};

const repository = new InMemoryAcquisitionCopilotRepository();
const idempotencySecret =
  "copilot-idempotency-test-secret-at-least-32-characters";
const runs: AcquisitionCopilotRunInput[] = [];
let releaseRun: (() => void) | undefined;
const waitForRelease = new Promise<void>((resolve) => {
  releaseRun = resolve;
});

const service = new AcquisitionCopilotService({
  repository,
  idempotencySecret,
  runner: {
    async run(input) {
      runs.push(input);
      if (input.prompt === "并发测试") await waitForRelease;
      if (input.prompt === "触发失败") {
        throw new Error("MODEL_RATE_LIMITED apiKey=must-not-leak");
      }
      if (input.prompt === "草稿失败") {
        throw new Error("PLAN_DRAFT_NOT_READY details=must-not-leak");
      }
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: input.prompt,
          timestamp: Date.parse("2026-07-24T01:00:00.000Z")
        },
        {
          role: "assistant",
          content: [{
            type: "text",
            text: `已分析：${input.prompt}`
          }],
          api: "goodjob-gateway",
          provider: input.snapshot.provider,
          model: input.snapshot.model,
          usage: {
            input: 10,
            output: 8,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: 18,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0
            }
          },
          stopReason: "stop",
          timestamp: Date.parse("2026-07-24T01:00:01.000Z")
        }
      ];
      return {
        newMessages: messages,
        result: {
          summary: `已分析：${input.prompt}`,
          toolNames: [],
          ...(input.responseMode === "plan_draft"
            ? {
                planDraft: {
                  ...structuredClone(planDraft),
                  targetPlatform: input.targetPlatform
                }
              }
            : {})
        }
      };
    }
  },
  idFactory: (() => {
    let sequence = 0;
    return (prefix) => `${prefix}-${++sequence}`;
  })(),
  now: (() => {
    let timestamp = Date.parse("2026-07-24T00:00:00.000Z");
    return () => new Date(timestamp++).toISOString();
  })()
});

const scope = {
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "owner-a"
};
const snapshot = {
  jobId: "job-a",
  connectionId: "connection-a",
  credentialVersion: 2,
  provider: "qwen" as const,
  model: "qwen-plus",
  promptVersion: "acquisition-copilot-v1",
  schemaVersion: "copilot-turn.v1",
  promptHash: "sha256:prompt-acquisition-copilot-v1",
  schemaHash: "sha256:schema-copilot-turn-v1",
  capabilitySnapshotHash: "capability-hash",
  baseUrlFingerprint: "base-url-hash"
};

const created = await service.createSession(
  scope,
  snapshot,
  "create-session-a"
);
const replayed = await service.createSession(
  scope,
  snapshot,
  "create-session-a"
);
assert.equal(created.id, replayed.id);
assert.equal(created.status, "active");
assert.equal(created.modelSnapshot.credentialVersion, 2);
assert.equal(
  (created.modelSnapshot as typeof created.modelSnapshot & {
    promptHash: string;
  }).promptHash,
  "sha256:prompt-acquisition-copilot-v1"
);
assert.equal(
  JSON.stringify(created).includes("apiKey"),
  false,
  "session snapshots must never persist credentials"
);

function legacyDigest(value: unknown) {
  const stableJson = (input: unknown): string => {
    if (input === null || typeof input !== "object") {
      return JSON.stringify(input);
    }
    if (Array.isArray(input)) {
      return `[${input.map((item) => stableJson(item)).join(",")}]`;
    }
    const record = input as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(",")}}`;
  };
  return createHmac("sha256", idempotencySecret)
    .update(stableJson(value))
    .digest("hex");
}

const legacyTask = {
  id: "copilot-task-pre-platform-upgrade",
  ownerId: scope.ownerId,
  teamId: scope.teamId,
  actorId: scope.actorId,
  sessionId: created.id,
  kind: "message" as const,
  status: "queued" as const,
  prompt: "兼容升级前的默认网页任务",
  responseMode: "assistant" as const,
  result: null,
  errorCode: null,
  createdAt: "2026-07-23T23:59:59.000Z",
  startedAt: null,
  completedAt: null
};
await repository.transaction(async () => {
  await repository.insertTask(legacyTask);
  await repository.appendIdempotency({
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    operation: "enqueue_message",
    keyHash: legacyDigest("message-pre-platform-upgrade"),
    requestHash: legacyDigest({
      sessionId: created.id,
      prompt: legacyTask.prompt,
      responseMode: "assistant"
    }),
    resourceType: "task",
    resourceId: legacyTask.id,
    createdAt: legacyTask.createdAt
  });
});
const legacyTaskReplay = await service.enqueueMessage(
  scope,
  created.id,
  legacyTask.prompt,
  "message-pre-platform-upgrade"
);
assert.equal(
  legacyTaskReplay.id,
  legacyTask.id,
  "default web requests must replay idempotency records created before targetPlatform existed"
);
await assert.rejects(
  service.enqueueMessage(
    scope,
    created.id,
    legacyTask.prompt,
    "message-pre-platform-upgrade",
    "assistant",
    "douyin"
  ),
  (error: unknown) =>
    error instanceof AcquisitionCopilotError
    && error.code === "idempotency_conflict",
  "douyin must remain distinct from a legacy default-web idempotency record"
);
await repository.saveTask({
  ...legacyTask,
  status: "cancelled",
  completedAt: "2026-07-24T00:00:00.000Z"
});

await assert.rejects(
  service.createSession(
    scope,
    { ...snapshot, model: "qwen-max" },
    "create-session-a"
  ),
  (error: unknown) =>
    error instanceof AcquisitionCopilotError
    && error.code === "idempotency_conflict"
);
await assert.rejects(
  service.createSession(
    scope,
    { ...snapshot, promptHash: "" } as typeof snapshot,
    "create-session-missing-prompt-hash"
  ),
  (error: unknown) =>
    error instanceof AcquisitionCopilotError
    && error.code === "invalid_request"
);

const queued = await service.enqueueMessage(
  scope,
  created.id,
  "分析今天最值得跟进的客户",
  "message-a"
);
const queuedReplay = await service.enqueueMessage(
  scope,
  created.id,
  "分析今天最值得跟进的客户",
  "message-a"
);
assert.equal(queued.id, queuedReplay.id);
assert.equal(queued.status, "queued");
assert.equal(
  queued.responseMode,
  "assistant",
  "omitting responseMode must preserve the legacy assistant behavior"
);
assert.equal(
  queued.targetPlatform,
  "web",
  "omitting targetPlatform must preserve the legacy web behavior"
);
assert.equal(
  (await service.getTask(scope, queued.id)).targetPlatform,
  "web",
  "the target platform must round-trip through task persistence"
);

await assert.rejects(
  service.enqueueMessage(
    scope,
    created.id,
    "分析今天最值得跟进的客户",
    "message-a",
    "plan_draft"
  ),
  (error: unknown) =>
    error instanceof AcquisitionCopilotError
    && error.code === "idempotency_conflict"
);

await assert.rejects(
  service.enqueueMessage(
    scope,
    created.id,
    "分析今天最值得跟进的客户",
    "message-a",
    "assistant",
    "douyin"
  ),
  (error: unknown) =>
    error instanceof AcquisitionCopilotError
    && error.code === "idempotency_conflict"
);

const succeeded = await service.runTask(scope, queued.id);
assert.equal(succeeded.status, "succeeded");
assert.equal(succeeded.result?.summary, "已分析：分析今天最值得跟进的客户");
assert.equal(runs.length, 1);
assert.equal(runs[0]?.ownerId, "owner-a");
assert.equal(runs[0]?.teamId, "team-a");
assert.equal(runs[0]?.actorId, "owner-a");
assert.equal(runs[0]?.snapshot.connectionId, "connection-a");
assert.deepEqual(runs[0]?.transcript, []);
assert.equal(runs[0]?.responseMode, "assistant");
assert.equal(runs[0]?.targetPlatform, "web");
assert.equal((await service.listMessages(scope, created.id)).length, 2);
assert.equal(
  (await service.runTask(scope, queued.id)).id,
  queued.id,
  "terminal tasks must replay without running the model again"
);
assert.equal(runs.length, 1);

await assert.rejects(
  service.getSession(
    { ownerId: "owner-b", teamId: "team-a", actorId: "owner-b" },
    created.id
  ),
  (error: unknown) =>
    error instanceof AcquisitionCopilotError
    && error.code === "resource_not_found"
);

const concurrentTask = await service.enqueueMessage(
  scope,
  created.id,
  "并发测试",
  "message-concurrent"
);
const concurrentOne = service.runTask(scope, concurrentTask.id);
const concurrentTwo = service.runTask(scope, concurrentTask.id);
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(
  runs.filter((item) => item.prompt === "并发测试").length,
  1,
  "only one worker may claim a queued task"
);
releaseRun?.();
const concurrentResults = await Promise.all([concurrentOne, concurrentTwo]);
assert.deepEqual(
  concurrentResults.map((item) => item.status),
  ["succeeded", "succeeded"]
);

const failedTask = await service.enqueueMessage(
  scope,
  created.id,
  "触发失败",
  "message-failure"
);
const failed = await service.runTask(scope, failedTask.id);
assert.equal(failed.status, "failed");
assert.equal(failed.errorCode, "MODEL_RATE_LIMITED");
assert.equal(JSON.stringify(failed).includes("must-not-leak"), false);

const draftTask = await service.enqueueMessage(
  scope,
  created.id,
  "生成计划草稿",
  "message-plan-draft",
  "plan_draft",
  "douyin"
);
assert.equal(draftTask.responseMode, "plan_draft");
assert.equal(draftTask.targetPlatform, "douyin");
const generatedDraft = await service.runTask(scope, draftTask.id);
assert.equal(generatedDraft.status, "succeeded");
assert.deepEqual(
  acquisitionPublicPlanCreateSchema.parse(
    generatedDraft.result?.planDraft
  ),
  { ...planDraft, targetPlatform: "douyin" }
);
assert.equal(
  runs.find((input) => input.prompt === "生成计划草稿")?.targetPlatform,
  "douyin"
);

const failedDraftTask = await service.enqueueMessage(
  scope,
  created.id,
  "草稿失败",
  "message-plan-draft-failure",
  "plan_draft"
);
const failedDraft = await service.runTask(scope, failedDraftTask.id);
assert.equal(failedDraft.status, "failed");
assert.equal(failedDraft.errorCode, "PLAN_DRAFT_NOT_READY");
assert.equal(JSON.stringify(failedDraft).includes("must-not-leak"), false);

const singleFlightFirst = await service.enqueueMessage(
  scope,
  created.id,
  "同会话第一条派发",
  "message-single-flight-first"
);
const singleFlightSecond = await service.enqueueMessage(
  scope,
  created.id,
  "同会话第二条派发",
  "message-single-flight-second"
);
assert.equal(
  await service.claimTaskDispatch(scope, singleFlightFirst.id),
  true
);
assert.equal(
  (await service.getTask(scope, singleFlightFirst.id)).status,
  "running",
  "claiming a dispatch must atomically move the task to running"
);
assert.equal(
  await service.claimTaskDispatch(scope, singleFlightSecond.id),
  false,
  "a session may have only one running task"
);

const parallelSession = await service.createSession(
  scope,
  snapshot,
  "create-session-parallel"
);
const parallelTask = await service.enqueueMessage(
  scope,
  parallelSession.id,
  "不同会话可以并行",
  "message-parallel-session"
);
assert.equal(
  await service.claimTaskDispatch(scope, parallelTask.id),
  true,
  "different sessions may run concurrently"
);
await service.markDispatchFailed(
  scope,
  singleFlightFirst.id,
  "COPILOT_TEST_CLEANUP"
);
assert.equal(
  await service.claimTaskDispatch(scope, singleFlightSecond.id),
  true,
  "the next task may be claimed only after the first reaches a terminal state"
);
await service.markDispatchFailed(
  scope,
  singleFlightSecond.id,
  "COPILOT_TEST_CLEANUP"
);
await service.markDispatchFailed(
  scope,
  parallelTask.id,
  "COPILOT_TEST_CLEANUP"
);

const routerClaimedTask = await service.enqueueMessage(
  scope,
  created.id,
  "路由器已领取后执行",
  "message-router-claimed"
);
assert.equal(
  await service.claimTaskDispatch(scope, routerClaimedTask.id),
  true
);
assert.equal(
  (await service.runTask(scope, routerClaimedTask.id)).status,
  "succeeded",
  "runTask must accept a task that the router already moved to running"
);

const dispatchFailureTask = await service.enqueueMessage(
  scope,
  created.id,
  "派发失败测试",
  "message-dispatch-failure"
);
assert.equal(
  await service.claimTaskDispatch(scope, dispatchFailureTask.id),
  true
);
assert.equal(
  await service.claimTaskDispatch(scope, dispatchFailureTask.id),
  false,
  "an idempotency replay must not dispatch the same task twice"
);
await assert.rejects(
  service.claimTaskDispatch(
    { ownerId: "owner-b", teamId: "team-a", actorId: "owner-b" },
    dispatchFailureTask.id
  ),
  (error: unknown) =>
    error instanceof AcquisitionCopilotError
    && error.code === "resource_not_found"
);
const dispatchFailed = await service.markDispatchFailed(
  scope,
  dispatchFailureTask.id,
  "COPILOT_DISPATCH_FAILED"
);
assert.equal(dispatchFailed.status, "failed");
assert.equal(dispatchFailed.errorCode, "COPILOT_DISPATCH_FAILED");
assert.equal(
  JSON.stringify(dispatchFailed).includes("apiKey"),
  false,
  "dispatch failure records must contain only a stable error code"
);
assert.equal(
  (await service.markDispatchFailed(
    scope,
    dispatchFailureTask.id,
    "COPILOT_DISPATCH_FAILED"
  )).id,
  dispatchFailureTask.id,
  "the same terminal dispatch failure must be idempotent"
);

const runningDispatchFailureTask = await service.enqueueMessage(
  scope,
  created.id,
  "运行态派发失败测试",
  "message-running-dispatch-failure"
);
await repository.saveTask({
  ...runningDispatchFailureTask,
  status: "running",
  startedAt: "2026-07-24T02:00:00.000Z"
});
assert.equal(
  (await service.markDispatchFailed(
    scope,
    runningDispatchFailureTask.id,
    "COPILOT_DISPATCH_FAILED"
  )).status,
  "failed"
);

const recoveryQueuedTask = await service.enqueueMessage(
  scope,
  created.id,
  "重启后恢复排队任务",
  "message-recovery-queued"
);
const recoveryRunningTask = await service.enqueueMessage(
  scope,
  created.id,
  "重启后终结陈旧运行任务",
  "message-recovery-running"
);
await repository.saveTask({
  ...recoveryRunningTask,
  status: "running",
  startedAt: "2026-07-24T01:00:00.000Z"
});
const recoveredTasks = await service.recoverInterruptedTasks({
  staleRunningBefore: "2026-07-24T02:00:00.000Z"
});
assert.deepEqual(
  recoveredTasks.map((task) => task.id),
  [recoveryQueuedTask.id]
);
assert.equal(
  await service.claimTaskDispatch(scope, recoveryQueuedTask.id),
  true,
  "startup recovery must preserve queued task order and make it claimable"
);
await service.markDispatchFailed(
  scope,
  recoveryQueuedTask.id,
  "COPILOT_TEST_CLEANUP"
);
const recoveredRunning = await service.getTask(
  scope,
  recoveryRunningTask.id
);
assert.equal(recoveredRunning.status, "failed");
assert.equal(
  recoveredRunning.errorCode,
  "COPILOT_PROCESS_RESTARTED"
);

const completed = await service.completeSession(
  scope,
  created.id,
  "complete-session-a"
);
assert.equal(completed.status, "completed");
await assert.rejects(
  service.enqueueMessage(
    scope,
    created.id,
    "完成后不能继续",
    "message-after-complete"
  ),
  (error: unknown) =>
    error instanceof AcquisitionCopilotError
    && error.code === "invalid_state"
);

console.log("acquisition copilot service tests passed");
