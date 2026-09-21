import assert from "node:assert/strict";
import {
  AcquisitionCopilotService,
  InMemoryAcquisitionCopilotRepository,
  type AcquisitionCopilotRepository,
  type AcquisitionCopilotSession
} from "./acquisition-copilot-service.js";

const NOW = "2026-07-24T08:00:00.000Z";

function session(
  overrides: Partial<AcquisitionCopilotSession> = {}
): AcquisitionCopilotSession {
  return {
    id: "session-atomic-1",
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "actor-a",
    status: "active",
    modelSnapshot: {
      jobId: "job-a",
      connectionId: "connection-a",
      credentialVersion: 1,
      provider: "qwen",
      model: "qwen-plus",
      promptVersion: "acquisition-copilot-v1",
      schemaVersion: "copilot-turn.v1",
      promptHash: "sha256:prompt",
      schemaHash: "sha256:schema",
      capabilitySnapshotHash: "sha256:capability",
      baseUrlFingerprint: "sha256:base-url"
    },
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides
  };
}

const scope = {
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "actor-a"
};

function copilotService(
  repository: AcquisitionCopilotRepository,
  prefix: string
) {
  let sequence = 0;
  return new AcquisitionCopilotService({
    repository,
    idempotencySecret:
      "copilot-atomicity-secret-that-is-at-least-32-characters",
    runner: {
      async run(input) {
        return {
          newMessages: [{
            role: "user" as const,
            content: input.prompt,
            timestamp: 1
          }, {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "完成" }],
            api: "goodjob-gateway",
            provider: input.snapshot.provider,
            model: input.snapshot.model,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              reasoning: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0
              }
            },
            stopReason: "stop" as const,
            timestamp: 2
          }],
          result: { summary: "完成", toolNames: [] }
        };
      }
    },
    idFactory: (kind) => `${kind}-${prefix}-${++sequence}`,
    now: () => NOW
  });
}

function failOnce(
  repository: InMemoryAcquisitionCopilotRepository,
  method: keyof AcquisitionCopilotRepository,
  predicate: (args: unknown[]) => boolean = () => true
): AcquisitionCopilotRepository {
  let armed = true;
  return new Proxy(repository, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === method && typeof value === "function") {
        return async (...args: unknown[]) => {
          if (armed && predicate(args)) {
            armed = false;
            throw new Error(`SIMULATED_${String(method).toUpperCase()}_CRASH`);
          }
          return value.apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as AcquisitionCopilotRepository;
}

{
  const repository = new InMemoryAcquisitionCopilotRepository();
  await assert.rejects(
    repository.transaction(async () => {
      await repository.insertSession(session());
      throw new Error("SIMULATED_CRASH");
    }),
    /SIMULATED_CRASH/
  );
  assert.equal(
    await repository.findSession(
      { ownerId: "owner-a", teamId: "team-a" },
      "session-atomic-1"
    ),
    undefined,
    "a failed unit of work must not expose its partial session"
  );
}

{
  const repository = new InMemoryAcquisitionCopilotRepository();
  await repository.insertSession(session());
  await repository.appendMessages([{
    id: "message-rebase-1",
    ownerId: "owner-a",
    teamId: "team-a",
    sessionId: "session-atomic-1",
    sequence: 1,
    message: { role: "user", content: "第一条", timestamp: 1 },
    createdAt: NOW
  }]);
  await repository.appendMessages([{
    id: "message-rebase-2",
    ownerId: "owner-a",
    teamId: "team-a",
    sessionId: "session-atomic-1",
    sequence: 1,
    message: { role: "user", content: "并发后到达", timestamp: 2 },
    createdAt: NOW
  }]);
  assert.deepEqual(
    (await repository.listMessages(scope, "session-atomic-1"))
      .map((message) => message.sequence),
    [1, 2],
    "memory and MySQL repositories must serialize stale message sequences alike"
  );
}

{
  const repository = new InMemoryAcquisitionCopilotRepository();
  const setup = copilotService(repository, "complete-setup");
  const created = await setup.createSession(
    scope,
    session().modelSnapshot,
    "complete-setup-session"
  );
  const service = copilotService(
    failOnce(repository, "appendIdempotency"),
    "complete-crash"
  );
  await assert.rejects(
    service.completeSession(scope, created.id, "complete-atomic"),
    /SIMULATED_APPENDIDEMPOTENCY_CRASH/
  );
  assert.equal(
    (await service.getSession(scope, created.id)).status,
    "active",
    "session completion and its idempotency record must roll back together"
  );
}

{
  const repository = new InMemoryAcquisitionCopilotRepository();
  const setup = copilotService(repository, "enqueue-setup");
  const created = await setup.createSession(
    scope,
    session().modelSnapshot,
    "enqueue-session"
  );
  const service = copilotService(
    failOnce(repository, "insertTask"),
    "enqueue-crash"
  );
  await assert.rejects(
    service.enqueueMessage(
      scope,
      created.id,
      "这条用户消息不能成为孤儿",
      "enqueue-message"
    ),
    /SIMULATED_INSERTTASK_CRASH/
  );
  assert.deepEqual(
    await service.listMessages(scope, created.id),
    [],
    "the user message must roll back when its task cannot be created"
  );

  const replayed = await service.enqueueMessage(
    scope,
    created.id,
    "这条用户消息不能成为孤儿",
    "enqueue-message"
  );
  const persisted = await service.listMessages(scope, created.id);
  assert.equal(replayed.status, "queued");
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.message.role, "user");
  assert.equal(
    persisted[0]?.message.role === "user"
      ? persisted[0].message.content
      : null,
    "这条用户消息不能成为孤儿",
    "the accepted prompt must be visible with its durable queued task"
  );
}

{
  const repository = new InMemoryAcquisitionCopilotRepository();
  const service = copilotService(
    failOnce(
      repository,
      "saveTask",
      ([record]) =>
        (record as { status?: string } | undefined)?.status === "succeeded"
    ),
    "completion"
  );
  const created = await service.createSession(
    scope,
    session().modelSnapshot,
    "completion-session"
  );
  const queued = await service.enqueueMessage(
    scope,
    created.id,
    "验证终态原子提交",
    "completion-message"
  );
  const failed = await service.runTask(scope, queued.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "SIMULATED_SAVETASK_CRASH");
  const messages = await service.listMessages(scope, created.id);
  assert.equal(
    messages.some((record) => record.message.role === "assistant"),
    false,
    "assistant content and usage must roll back when task completion fails"
  );
  assert.equal(
    JSON.stringify(messages).includes("totalTokens"),
    false,
    "usage must never survive without the matching succeeded task"
  );
}

{
  const repository = new InMemoryAcquisitionCopilotRepository();
  const service = copilotService(
    failOnce(repository, "appendIdempotency"),
    "crash"
  );
  await assert.rejects(
    service.createSession(scope, session().modelSnapshot, "create-atomic"),
    /SIMULATED_APPENDIDEMPOTENCY_CRASH/
  );
  assert.equal(
    await repository.findSession(scope, "copilot-session-crash-1"),
    undefined,
    "session creation and its idempotency record must roll back together"
  );
}

{
  const repository = new InMemoryAcquisitionCopilotRepository();
  const left = copilotService(repository, "left");
  const right = copilotService(repository, "right");
  const [first, replay] = await Promise.all([
    left.createSession(scope, session().modelSnapshot, "shared-key"),
    right.createSession(scope, session().modelSnapshot, "shared-key")
  ]);
  assert.equal(
    first.id,
    replay.id,
    "independent service instances must replay the committed resource"
  );
  assert.equal(
    (await Promise.all([
      repository.findSession(scope, "copilot-session-left-1"),
      repository.findSession(scope, "copilot-session-right-1")
    ])).filter(Boolean).length,
    1,
    "a cross-process idempotency race must not leave an orphan resource"
  );
  const otherTenant = await right.createSession(
    {
      ownerId: "owner-b",
      teamId: "team-b",
      actorId: "actor-b"
    },
    session().modelSnapshot,
    "shared-key"
  );
  assert.notEqual(
    otherTenant.id,
    first.id,
    "idempotency replay must remain isolated by owner and team"
  );
}

console.log("acquisition copilot atomicity tests passed");
