import {
  createHmac,
  randomUUID
} from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentMessage
} from "@earendil-works/pi-agent-core";
import type {
  AcquisitionPiModelSnapshot
} from "./acquisition-pi-agent.js";
import {
  acquisitionPublicPlanCreateSchema,
  type AcquisitionPublicPlanCreateInput
} from "./acquisition-plan-contract.js";
import type {
  AcquisitionTargetPlatform
} from "./acquisition-plan-run-repository.js";

export type AcquisitionCopilotResponseMode = "assistant" | "plan_draft";

export interface AcquisitionCopilotScope {
  ownerId: string;
  teamId: string;
  actorId: string;
}

export interface AcquisitionCopilotSession {
  id: string;
  ownerId: string;
  teamId: string;
  actorId: string;
  status: "active" | "completed" | "failed";
  modelSnapshot: AcquisitionPiModelSnapshot;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AcquisitionCopilotTask {
  id: string;
  ownerId: string;
  teamId: string;
  actorId: string;
  sessionId: string;
  kind: "message";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  prompt: string;
  responseMode?: AcquisitionCopilotResponseMode;
  targetPlatform?: AcquisitionTargetPlatform;
  inputMessageId?: string;
  result: {
    summary: string;
    toolNames: string[];
    planDraft?: AcquisitionPublicPlanCreateInput;
  } | null;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AcquisitionCopilotMessage {
  id: string;
  ownerId: string;
  teamId: string;
  sessionId: string;
  sequence: number;
  message: AgentMessage;
  createdAt: string;
}

export interface AcquisitionCopilotIdempotencyRecord {
  ownerId: string;
  teamId: string;
  operation: "create_session" | "enqueue_message" | "complete_session";
  keyHash: string;
  requestHash: string;
  resourceType: "session" | "task";
  resourceId: string;
  createdAt: string;
}

export interface AcquisitionCopilotRepository {
  transaction<T>(work: () => Promise<T>): Promise<T>;
  insertSession(session: AcquisitionCopilotSession): Promise<void>;
  saveSession(session: AcquisitionCopilotSession): Promise<void>;
  findSession(
    scope: Pick<AcquisitionCopilotScope, "ownerId" | "teamId">,
    sessionId: string
  ): Promise<AcquisitionCopilotSession | undefined>;
  insertTask(task: AcquisitionCopilotTask): Promise<void>;
  saveTask(task: AcquisitionCopilotTask): Promise<void>;
  findTask(
    scope: Pick<AcquisitionCopilotScope, "ownerId" | "teamId">,
    taskId: string
  ): Promise<AcquisitionCopilotTask | undefined>;
  claimTaskDispatch(
    scope: Pick<AcquisitionCopilotScope, "ownerId" | "teamId">,
    taskId: string
  ): Promise<boolean>;
  recoverInterruptedTasks(input: {
    now: string;
    staleRunningBefore: string;
  }): Promise<AcquisitionCopilotTask[]>;
  listTasks(
    scope: Pick<AcquisitionCopilotScope, "ownerId" | "teamId">,
    sessionId: string
  ): Promise<AcquisitionCopilotTask[]>;
  appendMessages(messages: AcquisitionCopilotMessage[]): Promise<void>;
  listMessages(
    scope: Pick<AcquisitionCopilotScope, "ownerId" | "teamId">,
    sessionId: string
  ): Promise<AcquisitionCopilotMessage[]>;
  findIdempotency(input: {
    ownerId: string;
    teamId: string;
    operation: AcquisitionCopilotIdempotencyRecord["operation"];
    keyHash: string;
  }): Promise<AcquisitionCopilotIdempotencyRecord | undefined>;
  appendIdempotency(
    record: AcquisitionCopilotIdempotencyRecord
  ): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface InMemoryAcquisitionCopilotState {
  sessions: Map<string, AcquisitionCopilotSession>;
  tasks: Map<string, AcquisitionCopilotTask>;
  taskDispatchClaims: Set<string>;
  messages: AcquisitionCopilotMessage[];
  idempotency: Map<string, AcquisitionCopilotIdempotencyRecord>;
}

function emptyCopilotState(): InMemoryAcquisitionCopilotState {
  return {
    sessions: new Map(),
    tasks: new Map(),
    taskDispatchClaims: new Set(),
    messages: [],
    idempotency: new Map()
  };
}

function cloneCopilotState(
  state: InMemoryAcquisitionCopilotState
): InMemoryAcquisitionCopilotState {
  return {
    sessions: new Map(
      [...state.sessions].map(([key, value]) => [key, clone(value)])
    ),
    tasks: new Map(
      [...state.tasks].map(([key, value]) => [key, clone(value)])
    ),
    taskDispatchClaims: new Set(state.taskDispatchClaims),
    messages: state.messages.map((message) => clone(message)),
    idempotency: new Map(
      [...state.idempotency].map(([key, value]) => [key, clone(value)])
    )
  };
}

export class InMemoryAcquisitionCopilotRepository
implements AcquisitionCopilotRepository {
  #state = emptyCopilotState();
  readonly #transactionContext =
    new AsyncLocalStorage<InMemoryAcquisitionCopilotState>();
  #transactionTail: Promise<void> = Promise.resolve();

  #currentState() {
    return this.#transactionContext.getStore() ?? this.#state;
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.#transactionContext.getStore()) return work();
    let release!: () => void;
    const previous = this.#transactionTail;
    this.#transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const draft = cloneCopilotState(this.#state);
    try {
      const result = await this.#transactionContext.run(draft, work);
      this.#state = draft;
      return result;
    } finally {
      release();
    }
  }

  async insertSession(session: AcquisitionCopilotSession) {
    const state = this.#currentState();
    if (state.sessions.has(session.id)) throw new Error("SESSION_EXISTS");
    state.sessions.set(session.id, clone(session));
  }

  async saveSession(session: AcquisitionCopilotSession) {
    const state = this.#currentState();
    if (!state.sessions.has(session.id)) throw new Error("SESSION_NOT_FOUND");
    state.sessions.set(session.id, clone(session));
  }

  async findSession(
    scope: Pick<AcquisitionCopilotScope, "ownerId" | "teamId">,
    sessionId: string
  ) {
    const session = this.#currentState().sessions.get(sessionId);
    return session
      && session.ownerId === scope.ownerId
      && session.teamId === scope.teamId
      ? clone(session)
      : undefined;
  }

  async insertTask(task: AcquisitionCopilotTask) {
    const state = this.#currentState();
    if (state.tasks.has(task.id)) throw new Error("TASK_EXISTS");
    state.tasks.set(task.id, clone(task));
  }

  async saveTask(task: AcquisitionCopilotTask) {
    const state = this.#currentState();
    if (!state.tasks.has(task.id)) throw new Error("TASK_NOT_FOUND");
    state.tasks.set(task.id, clone(task));
  }

  async findTask(
    scope: Pick<AcquisitionCopilotScope, "ownerId" | "teamId">,
    taskId: string
  ) {
    const task = this.#currentState().tasks.get(taskId);
    return task
      && task.ownerId === scope.ownerId
      && task.teamId === scope.teamId
      ? clone(task)
      : undefined;
  }

  async claimTaskDispatch(
    scope: Pick<AcquisitionCopilotScope, "ownerId" | "teamId">,
    taskId: string
  ) {
    const state = this.#currentState();
    const task = state.tasks.get(taskId);
    if (!task
      || task.ownerId !== scope.ownerId
      || task.teamId !== scope.teamId
      || task.status !== "queued") {
      return false;
    }
    const sessionAlreadyRunning = [...state.tasks.values()].some(
      (candidate) =>
        candidate.id !== task.id
        && candidate.ownerId === task.ownerId
        && candidate.teamId === task.teamId
        && candidate.sessionId === task.sessionId
        && candidate.status === "running"
    );
    if (sessionAlreadyRunning) return false;
    state.tasks.set(task.id, {
      ...task,
      status: "running",
      startedAt: new Date().toISOString()
    });
    return true;
  }

  async recoverInterruptedTasks(input: {
    now: string;
    staleRunningBefore: string;
  }) {
    const state = this.#currentState();
    const recoverable: AcquisitionCopilotTask[] = [];
    for (const [taskId, task] of state.tasks) {
      if (task.status === "queued") {
        state.taskDispatchClaims.delete(taskId);
        recoverable.push(clone(task));
        continue;
      }
      if (task.status === "running"
        && task.startedAt
        && Date.parse(task.startedAt)
          <= Date.parse(input.staleRunningBefore)) {
        state.tasks.set(taskId, {
          ...task,
          status: "failed",
          result: null,
          errorCode: "COPILOT_PROCESS_RESTARTED",
          completedAt: input.now
        });
      }
    }
    return recoverable.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id));
  }

  async listTasks(
    scope: Pick<AcquisitionCopilotScope, "ownerId" | "teamId">,
    sessionId: string
  ) {
    return [...this.#currentState().tasks.values()]
      .filter((task) =>
        task.ownerId === scope.ownerId
        && task.teamId === scope.teamId
        && task.sessionId === sessionId
      )
      .map((task) => clone(task));
  }

  async appendMessages(messages: AcquisitionCopilotMessage[]) {
    if (messages.length === 0) return;
    const state = this.#currentState();
    const first = messages[0]!;
    const session = state.sessions.get(first.sessionId);
    if (!session
      || session.ownerId !== first.ownerId
      || session.teamId !== first.teamId) {
      throw new Error("SESSION_NOT_FOUND");
    }
    const existingIds = new Set(state.messages.map((message) => message.id));
    for (const message of messages) {
      if (!Number.isSafeInteger(message.sequence) || message.sequence < 1) {
        throw new Error("COPILOT_MESSAGE_SEQUENCE_INVALID");
      }
      if (message.ownerId !== first.ownerId
        || message.teamId !== first.teamId
        || message.sessionId !== first.sessionId) {
        throw new Error("COPILOT_MESSAGE_SCOPE_MISMATCH");
      }
      if (existingIds.has(message.id)) throw new Error("MESSAGE_EXISTS");
      existingIds.add(message.id);
    }
    const maxSequence = state.messages
      .filter((message) =>
        message.ownerId === first.ownerId
        && message.teamId === first.teamId
        && message.sessionId === first.sessionId
      )
      .reduce((maximum, message) => Math.max(maximum, message.sequence), 0);
    state.messages.push(...messages.map((message, index) => clone({
      ...message,
      sequence: maxSequence + index + 1
    })));
  }

  async listMessages(
    scope: Pick<AcquisitionCopilotScope, "ownerId" | "teamId">,
    sessionId: string
  ) {
    return this.#currentState().messages
      .filter((message) =>
        message.ownerId === scope.ownerId
        && message.teamId === scope.teamId
        && message.sessionId === sessionId
      )
      .sort((left, right) => left.sequence - right.sequence)
      .map((message) => clone(message));
  }

  async findIdempotency(input: {
    ownerId: string;
    teamId: string;
    operation: AcquisitionCopilotIdempotencyRecord["operation"];
    keyHash: string;
  }) {
    const record = this.#currentState().idempotency.get([
      input.ownerId,
      input.teamId,
      input.operation,
      input.keyHash
    ].join(":"));
    return record ? clone(record) : undefined;
  }

  async appendIdempotency(record: AcquisitionCopilotIdempotencyRecord) {
    const state = this.#currentState();
    const key = [
      record.ownerId,
      record.teamId,
      record.operation,
      record.keyHash
    ].join(":");
    if (state.idempotency.has(key)) throw new Error("IDEMPOTENCY_EXISTS");
    state.idempotency.set(key, clone(record));
  }
}

export interface AcquisitionCopilotRunInput {
  ownerId: string;
  teamId: string;
  actorId: string;
  sessionId: string;
  snapshot: AcquisitionPiModelSnapshot;
  transcript: AgentMessage[];
  prompt: string;
  responseMode: AcquisitionCopilotResponseMode;
  targetPlatform?: AcquisitionTargetPlatform;
  signal?: AbortSignal;
}

export interface AcquisitionCopilotRunner {
  run(input: AcquisitionCopilotRunInput): Promise<{
    newMessages: AgentMessage[];
    result: {
      summary: string;
      toolNames: string[];
      planDraft?: AcquisitionPublicPlanCreateInput;
    };
  }>;
}

export type AcquisitionCopilotErrorCode =
  | "invalid_request"
  | "resource_not_found"
  | "invalid_state"
  | "idempotency_conflict";

export class AcquisitionCopilotError extends Error {
  constructor(
    public readonly code: AcquisitionCopilotErrorCode,
    message: string,
    public readonly status: 400 | 404 | 409
  ) {
    super(message);
    this.name = "AcquisitionCopilotError";
  }
}

export interface AcquisitionCopilotServiceOptions {
  repository: AcquisitionCopilotRepository;
  runner: AcquisitionCopilotRunner;
  idempotencySecret: string;
  idFactory?: (prefix: string) => string;
  now?: () => string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(object[key])}`
  ).join(",")}}`;
}

function digest(secret: string, value: unknown) {
  return createHmac("sha256", secret)
    .update(stableJson(value))
    .digest("hex");
}

function safeErrorCode(error: unknown) {
  const raw = error instanceof Error ? error.message : "";
  return raw.match(/^[A-Z][A-Z0-9_]{2,63}/)?.[0]
    ?? "COPILOT_TASK_FAILED";
}

function stableErrorCode(value: unknown) {
  const code = requiredText(value, "errorCode", 64);
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) {
    throw new AcquisitionCopilotError(
      "invalid_request",
      "errorCode 必须是稳定的大写错误代码",
      400
    );
  }
  return code;
}

function requiredText(value: unknown, name: string, maxLength: number) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength) {
    throw new AcquisitionCopilotError(
      "invalid_request",
      `${name}不能为空且不能超过 ${maxLength} 个字符`,
      400
    );
  }
  return text;
}

function validScope(scope: AcquisitionCopilotScope) {
  requiredText(scope.ownerId, "ownerId", 100);
  requiredText(scope.teamId, "teamId", 100);
  requiredText(scope.actorId, "actorId", 100);
}

function validSnapshot(
  snapshot: AcquisitionPiModelSnapshot
): AcquisitionPiModelSnapshot {
  for (const [name, value] of Object.entries(snapshot)) {
    if (name === "credentialVersion") continue;
    requiredText(value, `modelSnapshot.${name}`, 500);
  }
  if (!Number.isInteger(snapshot.credentialVersion)
    || snapshot.credentialVersion < 1) {
    throw new AcquisitionCopilotError(
      "invalid_request",
      "modelSnapshot.credentialVersion 必须是正整数",
      400
    );
  }
  for (const [name, value] of [
    ["promptHash", snapshot.promptHash],
    ["schemaHash", snapshot.schemaHash]
  ] as const) {
    const hash = requiredText(value, `modelSnapshot.${name}`, 200);
    if (!hash.startsWith("sha256:")) {
      throw new AcquisitionCopilotError(
        "invalid_request",
        `modelSnapshot.${name} 必须使用 sha256: 内容身份`,
        400
      );
    }
  }
  return Object.freeze(clone(snapshot));
}

function sanitizedResult(input: {
  summary: string;
  toolNames: string[];
  planDraft?: AcquisitionPublicPlanCreateInput;
}) {
  return {
    summary: requiredText(input.summary, "任务摘要", 4_000),
    toolNames: [...new Set(input.toolNames
      .map((item) => String(item).trim())
      .filter(Boolean))]
      .slice(0, 50),
    ...(input.planDraft === undefined
      ? {}
      : {
          planDraft: acquisitionPublicPlanCreateSchema.parse(
            structuredClone(input.planDraft)
          )
        })
  };
}

export class AcquisitionCopilotService {
  readonly #repository: AcquisitionCopilotRepository;
  readonly #runner: AcquisitionCopilotRunner;
  readonly #secret: string;
  readonly #idFactory: (prefix: string) => string;
  readonly #now: () => string;
  readonly #inFlightTasks =
    new Map<string, Promise<AcquisitionCopilotTask>>();
  readonly #inFlightCommands =
    new Map<string, Promise<AcquisitionCopilotSession | AcquisitionCopilotTask>>();

  constructor(options: AcquisitionCopilotServiceOptions) {
    if (options.idempotencySecret.length < 32) {
      throw new TypeError(
        "idempotencySecret must contain at least 32 characters"
      );
    }
    this.#repository = options.repository;
    this.#runner = options.runner;
    this.#secret = options.idempotencySecret;
    this.#idFactory =
      options.idFactory ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async createSession(
    scope: AcquisitionCopilotScope,
    rawSnapshot: AcquisitionPiModelSnapshot,
    idempotencyKey: string
  ) {
    validScope(scope);
    const snapshot = validSnapshot(rawSnapshot);
    return this.#idempotent(
      scope,
      "create_session",
      idempotencyKey,
      snapshot,
      "session",
      async () => {
        const now = this.#now();
        const session: AcquisitionCopilotSession = {
          id: this.#idFactory("copilot-session"),
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          actorId: scope.actorId,
          status: "active",
          modelSnapshot: snapshot,
          createdAt: now,
          updatedAt: now,
          completedAt: null
        };
        await this.#repository.insertSession(session);
        return session;
      }
    ) as Promise<AcquisitionCopilotSession>;
  }

  async getSession(scope: AcquisitionCopilotScope, sessionId: string) {
    validScope(scope);
    const session = await this.#repository.findSession(
      scope,
      requiredText(sessionId, "sessionId", 255)
    );
    if (!session) {
      throw new AcquisitionCopilotError(
        "resource_not_found",
        "智能体会话不存在",
        404
      );
    }
    return session;
  }

  async enqueueMessage(
    scope: AcquisitionCopilotScope,
    sessionId: string,
    rawPrompt: string,
    idempotencyKey: string,
    responseMode: AcquisitionCopilotResponseMode = "assistant",
    targetPlatform: AcquisitionTargetPlatform = "web"
  ) {
    validScope(scope);
    const prompt = requiredText(rawPrompt, "message", 20_000);
    const session = await this.getSession(scope, sessionId);
    if (session.status !== "active") {
      throw new AcquisitionCopilotError(
        "invalid_state",
        "只有 active 会话可以接收新消息",
        409
      );
    }
    return this.#idempotent(
      scope,
      "enqueue_message",
      idempotencyKey,
      targetPlatform === "web"
        ? { sessionId: session.id, prompt, responseMode }
        : { sessionId: session.id, prompt, responseMode, targetPlatform },
      "task",
      async () => {
        const now = this.#now();
        const taskId = this.#idFactory("copilot-task");
        const inputMessageId = this.#idFactory("copilot-message");
        const task: AcquisitionCopilotTask = {
          id: taskId,
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          actorId: scope.actorId,
          sessionId: session.id,
          kind: "message",
          status: "queued",
          prompt,
          responseMode,
          targetPlatform,
          inputMessageId,
          result: null,
          errorCode: null,
          createdAt: now,
          startedAt: null,
          completedAt: null
        };
        const existing = await this.#repository.listMessages(
          scope,
          session.id
        );
        await this.#repository.appendMessages([{
          id: inputMessageId,
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          sessionId: session.id,
          sequence: existing.length + 1,
          message: {
            role: "user",
            content: prompt,
            timestamp: Date.parse(now)
          },
          createdAt: now
        }]);
        await this.#repository.insertTask(task);
        return task;
      }
    ) as Promise<AcquisitionCopilotTask>;
  }

  async claimTaskDispatch(
    scope: AcquisitionCopilotScope,
    taskId: string
  ) {
    validScope(scope);
    const task = await this.#requireTask(scope, taskId);
    if (task.status !== "queued") return false;
    return this.#repository.claimTaskDispatch(scope, task.id);
  }

  async recoverInterruptedTasks(input: {
    staleRunningBefore: string;
  }) {
    const cutoff = new Date(input.staleRunningBefore);
    if (!Number.isFinite(cutoff.getTime())) {
      throw new AcquisitionCopilotError(
        "invalid_request",
        "staleRunningBefore 必须是有效时间",
        400
      );
    }
    return this.#repository.recoverInterruptedTasks({
      now: this.#now(),
      staleRunningBefore: cutoff.toISOString()
    });
  }

  async markDispatchFailed(
    scope: AcquisitionCopilotScope,
    taskId: string,
    rawErrorCode: string
  ) {
    validScope(scope);
    const errorCode = stableErrorCode(rawErrorCode);
    const task = await this.#requireTask(scope, taskId);
    if (task.status === "failed" && task.errorCode === errorCode) {
      return task;
    }
    if (task.status !== "queued" && task.status !== "running") {
      throw new AcquisitionCopilotError(
        "invalid_state",
        "只有 queued 或 running 任务可以记录派发失败",
        409
      );
    }
    const failed: AcquisitionCopilotTask = {
      ...task,
      status: "failed",
      result: null,
      errorCode,
      completedAt: this.#now()
    };
    await this.#repository.saveTask(failed);
    return failed;
  }

  runTask(scope: AcquisitionCopilotScope, taskId: string) {
    validScope(scope);
    const normalizedTaskId = requiredText(taskId, "taskId", 255);
    const inFlight = this.#inFlightTasks.get(normalizedTaskId);
    if (inFlight) return inFlight.then(clone);
    const run = this.#executeTask(scope, normalizedTaskId);
    this.#inFlightTasks.set(normalizedTaskId, run);
    void run.finally(() => {
      this.#inFlightTasks.delete(normalizedTaskId);
    }).catch(() => undefined);
    return run.then(clone);
  }

  async getTask(scope: AcquisitionCopilotScope, taskId: string) {
    validScope(scope);
    return this.#requireTask(scope, taskId);
  }

  async listMessages(scope: AcquisitionCopilotScope, sessionId: string) {
    validScope(scope);
    const session = await this.getSession(scope, sessionId);
    return this.#repository.listMessages(scope, session.id);
  }

  async completeSession(
    scope: AcquisitionCopilotScope,
    sessionId: string,
    idempotencyKey: string
  ) {
    validScope(scope);
    const session = await this.getSession(scope, sessionId);
    return this.#idempotent(
      scope,
      "complete_session",
      idempotencyKey,
      { sessionId: session.id },
      "session",
      async () => {
        if (session.status === "completed") return session;
        if (session.status !== "active") {
          throw new AcquisitionCopilotError(
            "invalid_state",
            "当前会话不能完成",
            409
          );
        }
        const tasks = await this.#repository.listTasks(scope, session.id);
        if (tasks.some((task) =>
          task.status === "queued" || task.status === "running"
        )) {
          throw new AcquisitionCopilotError(
            "invalid_state",
            "仍有未完成的智能体任务",
            409
          );
        }
        const now = this.#now();
        const completed: AcquisitionCopilotSession = {
          ...session,
          status: "completed",
          updatedAt: now,
          completedAt: now
        };
        await this.#repository.saveSession(completed);
        return completed;
      }
    ) as Promise<AcquisitionCopilotSession>;
  }

  async #executeTask(
    scope: AcquisitionCopilotScope,
    taskId: string
  ): Promise<AcquisitionCopilotTask> {
    let task = await this.#requireTask(scope, taskId);
    if (["succeeded", "failed", "cancelled"].includes(task.status)) {
      return task;
    }
    const session = await this.getSession(scope, task.sessionId);
    if (session.status !== "active") {
      throw new AcquisitionCopilotError(
        "invalid_state",
        "智能体会话已结束",
        409
      );
    }
    if (task.status === "queued") {
      const claimed = await this.#repository.claimTaskDispatch(
        scope,
        task.id
      );
      if (!claimed) {
        throw new AcquisitionCopilotError(
          "invalid_state",
          "同一会话已有智能体任务正在执行",
          409
        );
      }
      task = await this.#requireTask(scope, task.id);
    }
    if (task.status !== "running") {
      throw new AcquisitionCopilotError(
        "invalid_state",
        "智能体任务已被其他执行器领取",
        409
      );
    }
    try {
      const existing = await this.#repository.listMessages(
        scope,
        session.id
      );
      const sessionTasks = await this.#repository.listTasks(
        scope,
        session.id
      );
      const pendingInputMessageIds = new Set(
        sessionTasks
          .filter((candidate) =>
            candidate.status === "queued" || candidate.status === "running"
          )
          .map((candidate) => candidate.inputMessageId)
          .filter((id): id is string => Boolean(id))
      );
      const response = await this.#runner.run({
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        actorId: scope.actorId,
        sessionId: session.id,
        snapshot: clone(session.modelSnapshot),
        transcript: existing
          .filter((record) => !pendingInputMessageIds.has(record.id))
          .map((record) => clone(record.message)),
        prompt: task.prompt,
        responseMode: task.responseMode ?? "assistant",
        targetPlatform: task.targetPlatform ?? "web"
      });
      this.#validateNewMessages(response.newMessages, task.prompt);
      const startSequence = existing.length;
      const newMessages = task.inputMessageId
        ? response.newMessages.slice(1)
        : response.newMessages;
      const messages = newMessages.map(
        (message, index): AcquisitionCopilotMessage => ({
          id: this.#idFactory("copilot-message"),
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          sessionId: session.id,
          sequence: startSequence + index + 1,
          message: clone(message),
          createdAt: this.#now()
        })
      );
      task = {
        ...task,
        status: "succeeded",
        result: sanitizedResult(response.result),
        errorCode: null,
        completedAt: this.#now()
      };
      await this.#repository.transaction(async () => {
        await this.#repository.appendMessages(messages);
        await this.#repository.saveTask(task);
      });
      return task;
    } catch (error) {
      task = {
        ...task,
        status: "failed",
        result: null,
        errorCode: safeErrorCode(error),
        completedAt: this.#now()
      };
      await this.#repository.saveTask(task);
      return task;
    }
  }

  #validateNewMessages(messages: AgentMessage[], prompt: string) {
    if (!Array.isArray(messages) || messages.length < 2) {
      throw new Error("COPILOT_TRANSCRIPT_INVALID");
    }
    const first = messages[0];
    if (!first || first.role !== "user" || first.content !== prompt) {
      throw new Error("COPILOT_TRANSCRIPT_INVALID");
    }
    const final = messages[messages.length - 1];
    if (!final || final.role !== "assistant") {
      throw new Error("COPILOT_TRANSCRIPT_INVALID");
    }
  }

  async #requireTask(scope: AcquisitionCopilotScope, taskId: string) {
    const task = await this.#repository.findTask(
      scope,
      requiredText(taskId, "taskId", 255)
    );
    if (!task) {
      throw new AcquisitionCopilotError(
        "resource_not_found",
        "智能体任务不存在",
        404
      );
    }
    return task;
  }

  async #idempotent(
    scope: AcquisitionCopilotScope,
    operation: AcquisitionCopilotIdempotencyRecord["operation"],
    rawKey: string,
    request: unknown,
    resourceType: AcquisitionCopilotIdempotencyRecord["resourceType"],
    create: () => Promise<AcquisitionCopilotSession | AcquisitionCopilotTask>
  ) {
    const key = requiredText(rawKey, "Idempotency-Key", 255);
    const keyHash = digest(this.#secret, key);
    const requestHash = digest(this.#secret, request);
    const commandKey = [
      scope.ownerId,
      scope.teamId,
      operation,
      keyHash
    ].join(":");
    const active = this.#inFlightCommands.get(commandKey);
    if (active) {
      const resource = await active;
      const record = await this.#repository.findIdempotency({
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        operation,
        keyHash
      });
      if (record && record.requestHash !== requestHash) {
        throw new AcquisitionCopilotError(
          "idempotency_conflict",
          "相同 Idempotency-Key 对应了不同请求",
          409
        );
      }
      return clone(resource);
    }
    const replay = async (
      existing: AcquisitionCopilotIdempotencyRecord
    ) => {
      if (existing.requestHash !== requestHash) {
        throw new AcquisitionCopilotError(
          "idempotency_conflict",
          "相同 Idempotency-Key 对应了不同请求",
          409
        );
      }
      if (existing.resourceType === "session") {
        return this.getSession(scope, existing.resourceId);
      }
      return this.#requireTask(scope, existing.resourceId);
    };
    const command = (async () => {
      try {
        return await this.#repository.transaction(async () => {
          const existing = await this.#repository.findIdempotency({
            ownerId: scope.ownerId,
            teamId: scope.teamId,
            operation,
            keyHash
          });
          if (existing) return replay(existing);
          const resource = await create();
          await this.#repository.appendIdempotency({
            ownerId: scope.ownerId,
            teamId: scope.teamId,
            operation,
            keyHash,
            requestHash,
            resourceType,
            resourceId: resource.id,
            createdAt: this.#now()
          });
          return resource;
        });
      } catch (error) {
        const committed = await this.#repository.findIdempotency({
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          operation,
          keyHash
        });
        if (committed) return replay(committed);
        throw error;
      }
    })();
    this.#inFlightCommands.set(commandKey, command);
    try {
      return clone(await command);
    } finally {
      this.#inFlightCommands.delete(commandKey);
    }
  }
}
