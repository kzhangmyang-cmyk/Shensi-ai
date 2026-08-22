import type { DouyinPlanInput } from "./task-creation-api";

export interface CopilotPlanDraftTask {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  result: { summary: string; planDraft?: DouyinPlanInput } | null;
  errorCode?: string | null;
}

export interface PlanDraftWorkflowApi {
  createCopilotSession(input: { connectionId: string }, idempotencyKey: string, signal?: AbortSignal): Promise<{ id: string }>;
  createPlanDraftTask(sessionId: string, input: { message: string; responseMode: "plan_draft"; targetPlatform: "douyin" }, idempotencyKey: string, signal?: AbortSignal, expectedModelConnectionId?: string): Promise<CopilotPlanDraftTask>;
  getCopilotTask(taskId: string, modelConnectionId: string, signal?: AbortSignal): Promise<CopilotPlanDraftTask>;
}

export interface PlanDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredSession {
  modelConnectionId: string;
  sessionKey: string;
  sessionId?: string;
}

interface StoredTask {
  modelConnectionId: string;
  prompt: string;
  taskKey: string;
  taskId?: string;
}

interface StoredPlanDraftState {
  session?: StoredSession;
  task?: StoredTask;
}

export interface PlanDraftWorkflowOptions {
  storage?: PlanDraftStorage | null;
  idempotencyKeyFactory?: () => string;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  setDeadlineTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearDeadlineTimer?: (timer: unknown) => void;
}

const STORAGE_KEY = "goodjob.acquisition.plan-draft-workflow.v1";
const DEFAULT_TIMEOUT_MS = 120_000;

function requiredText(value: string, label: string, max = 20_000): string {
  const text = value.trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (text.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
  return text;
}

function defaultStorage(): PlanDraftStorage | null {
  return typeof sessionStorage === "undefined" ? null : sessionStorage;
}

function abortError(): DOMException {
  return new DOMException("已取消生成", "AbortError");
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function readStored(storage: PlanDraftStorage | null): StoredPlanDraftState {
  if (!storage) return {};
  try {
    const state = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") as StoredPlanDraftState;
    const session = state.session;
    const task = state.task;
    return {
      ...(session && typeof session.modelConnectionId === "string" && typeof session.sessionKey === "string"
        && (session.sessionId === undefined || typeof session.sessionId === "string") ? { session } : {}),
      ...(task && typeof task.modelConnectionId === "string" && typeof task.prompt === "string" && typeof task.taskKey === "string"
        && (task.taskId === undefined || typeof task.taskId === "string") ? { task } : {})
    };
  } catch {
    storage.removeItem(STORAGE_KEY);
    return {};
  }
}

function taskError(task: CopilotPlanDraftTask): Error {
  return new Error(task.errorCode
    ? `AI 计划生成失败：${task.errorCode}`
    : "AI 计划生成失败，请修改描述后重新生成");
}

export function createPlanDraftWorkflow(api: PlanDraftWorkflowApi, options: PlanDraftWorkflowOptions = {}) {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const idempotencyKeyFactory = options.idempotencyKeyFactory ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const setDeadlineTimer = options.setDeadlineTimer
    ?? ((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds));
  const clearDeadlineTimer = options.clearDeadlineTimer
    ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>));
  let activeController: AbortController | null = null;

  function save(state: StoredPlanDraftState): void {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function clearTask(state: StoredPlanDraftState): void {
    delete state.task;
    save(state);
  }

  function timeoutError(): Error {
    return new Error(`AI 计划生成超过 ${Math.ceil(timeoutMs / 1000)} 秒，请稍后重试`);
  }

  function complete(task: CopilotPlanDraftTask, state: StoredPlanDraftState): DouyinPlanInput | null {
    if (task.status === "succeeded") {
      const planDraft = task.result?.planDraft;
      if (!planDraft) throw new Error("AI 任务完成但未返回完整计划草稿");
      clearTask(state);
      return planDraft;
    }
    if (task.status === "failed" || task.status === "cancelled") {
      clearTask(state);
      throw taskError(task);
    }
    return null;
  }

  return {
    async generate(input: { modelConnectionId: string; prompt: string; signal?: AbortSignal }): Promise<{ planDraft: DouyinPlanInput }> {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      input.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      const modelConnectionId = requiredText(input.modelConnectionId, "AI 模型连接", 255);
      const prompt = requiredText(input.prompt, "一句话需求");
      const startedAt = now();
      const state = readStored(storage);
      let deadlineElapsed = false;
      const deadlineTimer = setDeadlineTimer(() => {
        deadlineElapsed = true;
        controller.abort();
      }, timeoutMs);
      const checkDeadline = (): void => {
        if (!deadlineElapsed && now() - startedAt >= timeoutMs) {
          deadlineElapsed = true;
          controller.abort();
        }
        if (deadlineElapsed) throw timeoutError();
        throwIfCancelled(controller.signal);
      };
      const awaitRequest = <T>(request: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const onAbort = () => {
          cleanup();
          reject(deadlineElapsed ? timeoutError() : abortError());
        };
        const cleanup = () => controller.signal.removeEventListener("abort", onAbort);
        if (controller.signal.aborted) {
          onAbort();
          return;
        }
        controller.signal.addEventListener("abort", onAbort, { once: true });
        void request.then((value) => {
          cleanup();
          resolve(value);
        }, (error) => {
          cleanup();
          reject(deadlineElapsed ? timeoutError() : error);
        });
      });
      try {
        checkDeadline();
        if (!state.session || state.session.modelConnectionId !== modelConnectionId) {
          state.session = { modelConnectionId, sessionKey: idempotencyKeyFactory() };
          delete state.task;
          save(state);
        }
        if (!state.session.sessionId) {
          const session = await awaitRequest(api.createCopilotSession(
            { connectionId: modelConnectionId }, state.session.sessionKey, controller.signal
          ));
          checkDeadline();
          state.session.sessionId = session.id;
          save(state);
        }
        if (!state.task || state.task.modelConnectionId !== modelConnectionId || state.task.prompt !== prompt) {
          state.task = { modelConnectionId, prompt, taskKey: idempotencyKeyFactory() };
          save(state);
        }
        if (!state.task.taskId) {
          const task = await awaitRequest(api.createPlanDraftTask(state.session.sessionId, {
            message: prompt, responseMode: "plan_draft", targetPlatform: "douyin"
          }, state.task.taskKey, controller.signal, modelConnectionId));
          checkDeadline();
          state.task.taskId = task.id;
          save(state);
          const planDraft = complete(task, state);
          if (planDraft) return { planDraft };
        }
        let attempt = 0;
        while (true) {
          checkDeadline();
          const task = await awaitRequest(api.getCopilotTask(state.task.taskId!, modelConnectionId, controller.signal));
          checkDeadline();
          const planDraft = complete(task, state);
          if (planDraft) return { planDraft };
          const backoff = Math.min(1_000 * 2 ** attempt, 8_000);
          attempt += 1;
          try {
            await sleep(backoff, controller.signal);
          } catch (error) {
            if (deadlineElapsed) throw timeoutError();
            if (controller.signal.aborted) throw abortError();
            throw error;
          }
          checkDeadline();
        }
      } finally {
        clearDeadlineTimer(deadlineTimer);
        if (activeController === controller) activeController = null;
      }
    },

    cancel(): void {
      activeController?.abort();
      activeController = null;
    },

    clear(): void {
      // Cancellation is deliberately non-destructive: session and pending task metadata
      // survive view changes and ambiguous network failures for idempotent recovery.
      this.cancel();
    }
  };
}
