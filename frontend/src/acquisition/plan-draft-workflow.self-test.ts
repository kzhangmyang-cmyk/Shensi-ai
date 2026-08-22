import { strict as assert } from "node:assert";
import {
  createPlanDraftWorkflow,
  type PlanDraftWorkflowApi
} from "./plan-draft-workflow";
import type { DouyinPlanInput } from "./task-creation-api";

const planDraft: DouyinPlanInput = {
  targetPlatform: "douyin" as const,
  name: "<厦门>企业服务获客",
  objective: "找到公开表达采购需求的企业和老板",
  icp: {
    industries: ["企业服务", "装修"],
    regions: ["厦门", "泉州"],
    organizationCriteria: ["公开询价", "寻找供应商"],
    individualCriteria: ["老板账号", "合作需求"],
    exclusionRules: ["明确拒绝联系"]
  },
  subjectChannels: { organization: true, individual: true },
  providerConnections: [
    { connectionId: "search-a", providerId: "brave", kind: "search" as const, status: "active" as const, credentialVersion: 1 },
    { connectionId: "search-b", providerId: "serper", kind: "search" as const, status: "active" as const, credentialVersion: 2 }
  ],
  operations: [
    { operationId: "a-org", subjectChannel: "organization" as const, kind: "search" as const, connectionId: "search-a", query: "site:douyin.com 企业服务 采购", allocatedBudget: { requests: 2, results: 10, amountMinor: 0, durationSeconds: 30 } },
    { operationId: "a-person", subjectChannel: "individual" as const, kind: "search" as const, connectionId: "search-a", query: "site:iesdouyin.com 老板 询价", allocatedBudget: { requests: 2, results: 10, amountMinor: 0, durationSeconds: 30 } },
    { operationId: "b-org", subjectChannel: "organization" as const, kind: "search" as const, connectionId: "search-b", query: "site:douyin.com 装修 找供应商", allocatedBudget: { requests: 2, results: 10, amountMinor: 0, durationSeconds: 30 } },
    { operationId: "b-person", subjectChannel: "individual" as const, kind: "search" as const, connectionId: "search-b", query: "site:iesdouyin.com 老板 合作", allocatedBudget: { requests: 2, results: 10, amountMinor: 0, durationSeconds: 30 } }
  ],
  budgetSnapshot: { billingCurrency: "CNY", maxRequests: 8, maxResults: 40, maxAmountMinor: 0, maxDurationSeconds: 120 },
  modelConnectionId: "model-a",
  stopConditions: { stopWhenBudgetExhausted: true, stopWhenNoMoreResults: true }
};

const persisted = new Map<string, string>();
const storageWrites: string[] = [];
const calls: Array<{ name: string; value?: unknown }> = [];
let polls = 0;
const api: PlanDraftWorkflowApi = {
  async createCopilotSession(input, idempotencyKey) {
    calls.push({ name: "session", value: { input, idempotencyKey } });
    return { id: "session-a" };
  },
  async createPlanDraftTask(sessionId, input, idempotencyKey) {
    calls.push({ name: "task", value: { sessionId, input, idempotencyKey } });
    return { id: "task-a", status: "queued", result: null };
  },
  async getCopilotTask(taskId) {
    calls.push({ name: "poll", value: taskId });
    polls += 1;
    return polls === 1
      ? { id: taskId, status: "running", result: null, errorCode: null }
      : { id: taskId, status: "succeeded", result: { summary: "已生成", planDraft }, errorCode: null };
  }
};

const workflow = createPlanDraftWorkflow(api, {
  storage: {
    getItem: (key) => persisted.get(key) ?? null,
    setItem: (key, value) => {
      storageWrites.push(value);
      persisted.set(key, value);
    },
    removeItem: (key) => persisted.delete(key)
  },
  idempotencyKeyFactory: (() => {
    let index = 0;
    return () => `plan-draft-key-${++index}`;
  })(),
  sleep: async () => undefined,
  now: (() => {
    let current = 0;
    return () => current += 50;
  })()
});

const result = await workflow.generate({
  modelConnectionId: "model-a",
  prompt: "帮我找厦门企业服务和装修行业的抖音公开商机"
});

assert.equal(result.planDraft.providerConnections.length, 2);
assert.equal(result.planDraft.operations.length, 4);
assert.deepEqual(result.planDraft.operations.map((operation) => operation.query), planDraft.operations.map((operation) => operation.query));
assert.equal(calls[0]?.name, "session");
assert.deepEqual(calls[0]?.value, {
  input: { connectionId: "model-a" },
  idempotencyKey: "plan-draft-key-1"
});
assert.deepEqual(calls[1]?.value, {
  sessionId: "session-a",
  input: {
    message: "帮我找厦门企业服务和装修行业的抖音公开商机",
    responseMode: "plan_draft",
    targetPlatform: "douyin"
  },
  idempotencyKey: "plan-draft-key-2"
});
assert.equal(JSON.stringify(calls).includes("modelSnapshotRef"), false);
assert.equal(polls, 2);
const saved = storageWrites.find((value) => value.includes("session-a") && value.includes("task-a")) ?? "";
assert.match(saved, /session-a/);
assert.match(saved, /task-a/);
assert.match(saved, /model-a/);
assert.match(saved, /厦门企业服务/);
assert.equal(saved.includes("providerConnections"), false);
assert.equal(saved.includes("operations"), false);

let timeoutPolls = 0;
const timeoutWorkflow = createPlanDraftWorkflow({
  ...api,
  async getCopilotTask(taskId) {
    timeoutPolls += 1;
    return { id: taskId, status: "running", result: null, errorCode: null };
  }
}, {
  storage: null,
  sleep: async () => undefined,
  now: (() => {
    let current = 0;
    return () => current += 30_000;
  })()
});
await assert.rejects(
  () => timeoutWorkflow.generate({ modelConnectionId: "model-a", prompt: "生成计划" }),
  /120 秒/
);
assert.equal(timeoutPolls, 0, "超时必须从第一条请求开始计算，而非首次轮询后");

let reusableSessionCalls = 0;
let reusableTaskCalls = 0;
const reusableStorage = new Map<string, string>();
const reusableWorkflow = createPlanDraftWorkflow({
  async createCopilotSession() {
    reusableSessionCalls += 1;
    return { id: "reusable-session" };
  },
  async createPlanDraftTask(_sessionId, _input, _key) {
    reusableTaskCalls += 1;
    return { id: `reusable-task-${reusableTaskCalls}`, status: "succeeded", result: { summary: "完成", planDraft }, errorCode: null };
  },
  async getCopilotTask() {
    throw new Error("立即完成的任务不应轮询");
  }
}, {
  storage: {
    getItem: (key) => reusableStorage.get(key) ?? null,
    setItem: (key, value) => reusableStorage.set(key, value),
    removeItem: (key) => reusableStorage.delete(key)
  }
});
await reusableWorkflow.generate({ modelConnectionId: "model-a", prompt: "第一个草稿" });
await reusableWorkflow.generate({ modelConnectionId: "model-a", prompt: "第二个草稿" });
assert.equal(reusableSessionCalls, 1, "完成后必须复用同一模型的 Copilot 会话");
assert.equal(reusableTaskCalls, 2);

let observedSessionSignal: AbortSignal | undefined;
const cancellableWorkflow = createPlanDraftWorkflow({
  async createCopilotSession(_input, _key, signal) {
    observedSessionSignal = signal;
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("取消", "AbortError")), { once: true }));
  },
  async createPlanDraftTask() {
    throw new Error("取消的会话不能继续创建任务");
  },
  async getCopilotTask() {
    throw new Error("取消的会话不能轮询");
  }
}, { storage: null });
const sessionRun = cancellableWorkflow.generate({ modelConnectionId: "model-a", prompt: "取消会话创建" });
cancellableWorkflow.cancel();
assert.equal(observedSessionSignal?.aborted, true, "会话 POST 必须收到取消信号");
await assert.rejects(sessionRun, /AbortError/);

let observedTaskSignal: AbortSignal | undefined;
const taskCancellationWorkflow = createPlanDraftWorkflow({
  async createCopilotSession() { return { id: "session-task-cancel" }; },
  async createPlanDraftTask(_sessionId, _input, _key, signal) {
    observedTaskSignal = signal;
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("取消", "AbortError")), { once: true }));
  },
  async getCopilotTask() { throw new Error("任务 POST 取消后不得轮询"); }
}, { storage: null });
const taskRun = taskCancellationWorkflow.generate({ modelConnectionId: "model-a", prompt: "取消任务创建" });
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
taskCancellationWorkflow.cancel();
assert.equal(observedTaskSignal?.aborted, true, "任务 POST 必须收到取消信号");
await assert.rejects(taskRun, /AbortError/);

let observedPollSignal: AbortSignal | undefined;
const pollCancellationWorkflow = createPlanDraftWorkflow({
  async createCopilotSession() { return { id: "session-poll-cancel" }; },
  async createPlanDraftTask() { return { id: "task-poll-cancel", status: "queued", result: null, errorCode: null }; },
  async getCopilotTask(_taskId, _modelConnectionId, signal) {
    observedPollSignal = signal;
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("取消", "AbortError")), { once: true }));
  }
}, { storage: null });
const pollRun = pollCancellationWorkflow.generate({ modelConnectionId: "model-a", prompt: "取消轮询" });
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
pollCancellationWorkflow.cancel();
assert.equal(observedPollSignal?.aborted, true, "轮询 GET 必须收到取消信号");
await assert.rejects(pollRun, /AbortError/);

const recoveryStorage = new Map<string, string>();
recoveryStorage.set("goodjob.acquisition.plan-draft-workflow.v1", JSON.stringify({
  session: { modelConnectionId: "model-a", sessionKey: "stable-session-key", sessionId: "recovered-session" },
  task: { modelConnectionId: "model-a", prompt: "恢复中", taskKey: "stable-task-key", taskId: "recovered-task" }
}));
let recoveryPosts = 0;
const recoveryWorkflow = createPlanDraftWorkflow({
  async createCopilotSession() { recoveryPosts += 1; return { id: "unexpected" }; },
  async createPlanDraftTask() { recoveryPosts += 1; return { id: "unexpected", status: "queued", result: null, errorCode: null }; },
  async getCopilotTask(taskId) {
    assert.equal(taskId, "recovered-task");
    return { id: taskId, status: "succeeded", result: { summary: "恢复完成", planDraft }, errorCode: null };
  }
}, { storage: { getItem: (key) => recoveryStorage.get(key) ?? null, setItem: (key, value) => recoveryStorage.set(key, value), removeItem: (key) => recoveryStorage.delete(key) } });
await recoveryWorkflow.generate({ modelConnectionId: "model-a", prompt: "恢复中" });
assert.equal(recoveryPosts, 0, "持久化 pending task 必须直接恢复轮询");
assert.equal((recoveryStorage.get("goodjob.acquisition.plan-draft-workflow.v1") ?? "").includes("recovered-session"), true);
assert.equal((recoveryStorage.get("goodjob.acquisition.plan-draft-workflow.v1") ?? "").includes("recovered-task"), false);

const ambiguousStorage = new Map<string, string>();
const taskKeys: string[] = [];
let ambiguousAttempts = 0;
const ambiguousWorkflow = createPlanDraftWorkflow({
  async createCopilotSession() { return { id: "ambiguous-session" }; },
  async createPlanDraftTask(_sessionId, _input, key) {
    taskKeys.push(key);
    ambiguousAttempts += 1;
    if (ambiguousAttempts === 1) throw new TypeError("网络中断");
    return { id: "ambiguous-task", status: "succeeded", result: { summary: "恢复", planDraft }, errorCode: null };
  },
  async getCopilotTask() { throw new Error("立即成功不轮询"); }
}, { storage: { getItem: (key) => ambiguousStorage.get(key) ?? null, setItem: (key, value) => ambiguousStorage.set(key, value), removeItem: (key) => ambiguousStorage.delete(key) } });
await assert.rejects(() => ambiguousWorkflow.generate({ modelConnectionId: "model-a", prompt: "模糊失败" }), /网络中断/);
await ambiguousWorkflow.generate({ modelConnectionId: "model-a", prompt: "模糊失败" });
assert.deepEqual(taskKeys, [taskKeys[0], taskKeys[0]], "模糊网络失败恢复时必须复用任务幂等键");

const sessionAmbiguousStorage = new Map<string, string>();
const sessionKeys: string[] = [];
let sessionAmbiguousAttempts = 0;
const sessionAmbiguousWorkflow = createPlanDraftWorkflow({
  async createCopilotSession(_input, key) {
    sessionKeys.push(key);
    sessionAmbiguousAttempts += 1;
    if (sessionAmbiguousAttempts === 1) throw new TypeError("会话网络中断");
    return { id: "restored-session" };
  },
  async createPlanDraftTask() { return { id: "restored-task", status: "succeeded", result: { summary: "恢复", planDraft }, errorCode: null }; },
  async getCopilotTask() { throw new Error("立即成功不轮询"); }
}, { storage: { getItem: (key) => sessionAmbiguousStorage.get(key) ?? null, setItem: (key, value) => sessionAmbiguousStorage.set(key, value), removeItem: (key) => sessionAmbiguousStorage.delete(key) } });
await assert.rejects(() => sessionAmbiguousWorkflow.generate({ modelConnectionId: "model-a", prompt: "会话模糊失败" }), /会话网络中断/);
await sessionAmbiguousWorkflow.generate({ modelConnectionId: "model-a", prompt: "会话模糊失败" });
assert.deepEqual(sessionKeys, [sessionKeys[0], sessionKeys[0]], "模糊会话创建恢复时必须复用会话幂等键");

const backoffs: number[] = [];
let backoffPolls = 0;
const backoffWorkflow = createPlanDraftWorkflow({
  async createCopilotSession() { return { id: "backoff-session" }; },
  async createPlanDraftTask() { return { id: "backoff-task", status: "queued", result: null, errorCode: null }; },
  async getCopilotTask(taskId) {
    backoffPolls += 1;
    return backoffPolls < 3
      ? { id: taskId, status: "running", result: null, errorCode: null }
      : { id: taskId, status: "succeeded", result: { summary: "退避完成", planDraft }, errorCode: null };
  }
}, { storage: null, sleep: async (milliseconds) => { backoffs.push(milliseconds); } });
await backoffWorkflow.generate({ modelConnectionId: "model-a", prompt: "验证退避" });
assert.deepEqual(backoffs, [1_000, 2_000]);

for (const status of ["failed", "cancelled"] as const) {
  const terminalStorage = new Map<string, string>();
  const terminalWorkflow = createPlanDraftWorkflow({
    async createCopilotSession() { return { id: `session-${status}` }; },
    async createPlanDraftTask() { return { id: `task-${status}`, status, result: null, errorCode: `TASK_${status.toUpperCase()}` }; },
    async getCopilotTask() { throw new Error("终态任务不应轮询"); }
  }, { storage: { getItem: (key) => terminalStorage.get(key) ?? null, setItem: (key, value) => terminalStorage.set(key, value), removeItem: (key) => terminalStorage.delete(key) } });
  await assert.rejects(
    () => terminalWorkflow.generate({ modelConnectionId: "model-a", prompt: `终态 ${status}` }),
    new RegExp(`TASK_${status.toUpperCase()}`)
  );
  const remaining = terminalStorage.get("goodjob.acquisition.plan-draft-workflow.v1") ?? "";
  assert.equal(remaining.includes(`session-${status}`), true, "终态后应保留可复用会话");
  assert.equal(remaining.includes(`task-${status}`), false, "终态后必须移除 pending task");
}

const configuredTimeoutWorkflow = createPlanDraftWorkflow({
  async createCopilotSession() { return { id: "timeout-session" }; },
  async createPlanDraftTask() { return { id: "timeout-task", status: "queued", result: null, errorCode: null }; },
  async getCopilotTask(taskId) { return { id: taskId, status: "running", result: null, errorCode: null }; }
}, {
  storage: null,
  timeoutMs: 2_000,
  sleep: async () => undefined,
  now: (() => { let clock = 0; return () => clock += 1_000; })()
});
await assert.rejects(
  () => configuredTimeoutWorkflow.generate({ modelConnectionId: "model-a", prompt: "自定义超时" }),
  /2 秒/
);

const sessionDeadlineCallbacks: Array<() => void> = [];
let sessionDeadlineAborted = false;
const sessionDeadlineWorkflow = createPlanDraftWorkflow({
  async createCopilotSession(_input, _key, signal) {
    return new Promise((_, reject) => signal?.addEventListener("abort", () => {
      sessionDeadlineAborted = true;
      reject(new DOMException("请求已取消", "AbortError"));
    }, { once: true }));
  },
  async createPlanDraftTask() { throw new Error("超时的会话不得创建任务"); },
  async getCopilotTask() { throw new Error("超时的会话不得轮询"); }
}, {
  storage: null,
  timeoutMs: 2_000,
  now: () => 0,
  setDeadlineTimer: (callback: () => void) => {
    sessionDeadlineCallbacks.push(callback);
    return callback;
  },
  clearDeadlineTimer: () => undefined
} as never);
const sessionDeadlineRun = sessionDeadlineWorkflow.generate({ modelConnectionId: "model-a", prompt: "会话无限等待" });
assert.equal(sessionDeadlineCallbacks.length, 1, "首个 POST 前必须注册 deadline timer");
sessionDeadlineCallbacks[0]!();
await assert.rejects(sessionDeadlineRun, /2 秒/);
assert.equal(sessionDeadlineAborted, true, "deadline 必须主动 abort 首个 POST");

const pollDeadlineCallbacks: Array<() => void> = [];
let pollDeadlineAborted = false;
let markPollDeadlineStarted: (() => void) | undefined;
const pollDeadlineStarted = new Promise<void>((resolve) => { markPollDeadlineStarted = resolve; });
const pollDeadlineWorkflow = createPlanDraftWorkflow({
  async createCopilotSession() { return { id: "deadline-poll-session" }; },
  async createPlanDraftTask() { return { id: "deadline-poll-task", status: "queued", result: null, errorCode: null }; },
  async getCopilotTask(_taskId, _modelConnectionId, signal) {
    markPollDeadlineStarted?.();
    return new Promise((_, reject) => signal?.addEventListener("abort", () => {
      pollDeadlineAborted = true;
      reject(new DOMException("请求已取消", "AbortError"));
    }, { once: true }));
  }
}, {
  storage: null,
  timeoutMs: 2_000,
  now: () => 0,
  setDeadlineTimer: (callback: () => void) => {
    pollDeadlineCallbacks.push(callback);
    return callback;
  },
  clearDeadlineTimer: () => undefined
} as never);
const pollDeadlineRun = pollDeadlineWorkflow.generate({ modelConnectionId: "model-a", prompt: "轮询无限等待" });
await pollDeadlineStarted;
assert.equal(pollDeadlineCallbacks.length, 1, "poll GET 前必须已有 deadline timer");
pollDeadlineCallbacks[0]!();
await assert.rejects(pollDeadlineRun, /2 秒/);
assert.equal(pollDeadlineAborted, true, "deadline 必须主动 abort poll GET");

const backoffDeadlineCallbacks: Array<() => void> = [];
let backoffSleepStarted: (() => void) | undefined;
const backoffSleepStartedPromise = new Promise<void>((resolve) => { backoffSleepStarted = resolve; });
let backoffDeadlinePolls = 0;
const backoffDeadlineWorkflow = createPlanDraftWorkflow({
  async createCopilotSession() { return { id: "backoff-deadline-session" }; },
  async createPlanDraftTask() { return { id: "backoff-deadline-task", status: "queued", result: null, errorCode: null }; },
  async getCopilotTask(taskId) {
    backoffDeadlinePolls += 1;
    return { id: taskId, status: "running", result: null, errorCode: null };
  }
}, {
  storage: null,
  timeoutMs: 2_000,
  now: () => 0,
  sleep: async (_milliseconds, signal) => new Promise((_, reject) => {
    backoffSleepStarted?.();
    signal.addEventListener("abort", () => reject(new DOMException("请求已取消", "AbortError")), { once: true });
  }),
  setDeadlineTimer: (callback: () => void) => {
    backoffDeadlineCallbacks.push(callback);
    return callback;
  },
  clearDeadlineTimer: () => undefined
});
const backoffDeadlineRun = backoffDeadlineWorkflow.generate({ modelConnectionId: "model-a", prompt: "退避时超时" });
await backoffSleepStartedPromise;
backoffDeadlineCallbacks[0]!();
await assert.rejects(backoffDeadlineRun, /2 秒/);
assert.equal(backoffDeadlinePolls, 1, "deadline 在 backoff 时不得继续下一次轮询");
