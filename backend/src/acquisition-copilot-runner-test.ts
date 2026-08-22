import assert from "node:assert/strict";
import type {
  AgentMessage
} from "@earendil-works/pi-agent-core";
import type {
  AcquisitionPiTurnInput
} from "./acquisition-pi-agent.js";
import {
  createPiAcquisitionCopilotRunner,
  createRoutedAcquisitionCopilotRunner,
  type AcquisitionPiRuntimeFactoryInput
} from "./acquisition-copilot-runner.js";
import type {
  AcquisitionPlanDraftGenerator
} from "./acquisition-plan-draft.js";
import {
  InMemoryAcquisitionToolAuditLedger,
  type AcquisitionToolExecutionInput
} from "./acquisition-pi-tools.js";

const snapshot = {
  jobId: "job-runner-a",
  connectionId: "connection-runner-a",
  credentialVersion: 2,
  provider: "zhipu" as const,
  model: "glm-5",
  promptVersion: "acquisition-copilot-v1",
  schemaVersion: "copilot-turn.v1",
  promptHash: "sha256:prompt-acquisition-copilot-v1",
  schemaHash: "sha256:schema-copilot-turn-v1",
  capabilitySnapshotHash: "capability-runner-a",
  baseUrlFingerprint: "base-url-runner-a"
};

const previousTranscript: AgentMessage[] = [{
  role: "user",
  content: "上一轮先确认了目标行业。",
  timestamp: 1
}, {
  role: "assistant",
  content: [{
    type: "text",
    text: "目标行业为企业服务。"
  }],
  api: "goodjob-gateway",
  provider: "zhipu",
  model: "glm-5",
  usage: {
    input: 5,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 10,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0
    }
  },
  stopReason: "stop",
  timestamp: 2
}];

const runtimeFactoryInputs: AcquisitionPiRuntimeFactoryInput[] = [];
const turns: AcquisitionPiTurnInput[] = [];
const executions: AcquisitionToolExecutionInput[] = [];
const audit = new InMemoryAcquisitionToolAuditLedger();

const runner = createPiAcquisitionCopilotRunner({
  runtimeFactory: {
    async create(input) {
      runtimeFactoryInputs.push(input);
      return {
        async run(turn) {
          turns.push(turn);
          if (turns.length === 1) {
            return {
              type: "tool_calls",
              calls: [{
                id: "candidate-evidence-call-1",
                name: "get_candidate_evidence",
                arguments: { candidateId: "candidate-a" }
              }],
              usage: {
                inputTokens: 20,
                outputTokens: 10,
                reasoningTokens: 0
              },
              providerRequestId: "glm-request-1"
            };
          }
          return {
            type: "text",
            text: "candidate-a 有两条可核验需求证据，建议进入人工审核。",
            usage: {
              inputTokens: 30,
              outputTokens: 12,
              reasoningTokens: 1
            },
            providerRequestId: "glm-request-2"
          };
        }
      };
    }
  },
  toolExecutor: {
    async execute(input) {
      executions.push(input);
      return {
        candidateId: "candidate-a",
        evidence: [{
          sourceUrl: "https://example.cn/public/1",
          excerpt: "公开采购需求"
        }]
      };
    }
  },
  toolAudit: audit,
  toolAuditSecret: "copilot-runner-audit-secret-at-least-32-characters"
});

const response = await runner.run({
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "sales-a",
  sessionId: "session-a",
  snapshot,
  transcript: previousTranscript,
  prompt: "分析 candidate-a，并说明下一步。",
  responseMode: "assistant"
});

assert.deepEqual(runtimeFactoryInputs, [{
  identity: {
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "sales-a",
    sessionId: "session-a"
  },
  snapshot
}]);
assert.equal(turns.length, 2);
assert.equal(
  turns[0]?.messages.some((message) =>
    message.role === "user"
    && message.content === "上一轮先确认了目标行业。"
  ),
  true,
  "the snapshotted runner must restore the persisted transcript"
);
assert.equal(executions.length, 1);
assert.equal(executions[0]?.identity.actorId, "sales-a");
assert.equal(response.newMessages[0]?.role, "user");
assert.equal(
  response.newMessages.some((message) =>
    message.role === "user"
    && message.content === "上一轮先确认了目标行业。"
  ),
  false,
  "only messages created by this task may be persisted again"
);
assert.deepEqual(response.result, {
  summary: "candidate-a 有两条可核验需求证据，建议进入人工审核。",
  toolNames: ["get_candidate_evidence"]
});
assert.equal(
  (await audit.list({
    ownerId: "owner-a",
    teamId: "team-a",
    sessionId: "session-a"
  })).length,
  1
);

{
  const assistantCalls: unknown[] = [];
  const generatorCalls: Parameters<
    AcquisitionPlanDraftGenerator["generate"]
  >[0][] = [];
  const draft = {
    targetPlatform: "douyin" as const,
    name: "Runner 计划草稿",
    objective: "发现公开企业需求",
    icp: {
      industries: ["企业服务"],
      regions: ["中国"],
      organizationCriteria: ["公开采购需求"],
      individualCriteria: ["公开经营需求"],
      exclusionRules: []
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
    modelConnectionId: "connection-runner-a",
    stopConditions: {
      stopWhenBudgetExhausted: true,
      stopWhenNoMoreResults: true
    }
  };
  const assistantResult = {
    newMessages: [{
      role: "user" as const,
      content: "普通分析",
      timestamp: 10
    }, previousTranscript[1]!],
    result: {
      summary: "完全委托的普通分析",
      toolNames: ["get_candidate_evidence"]
    }
  };
  const routed = createRoutedAcquisitionCopilotRunner({
    assistantRunner: {
      async run(input) {
        assistantCalls.push(input);
        return assistantResult;
      }
    },
    planDraftGenerator: {
      async generate(input) {
        generatorCalls.push(input);
        return {
          summary: "已生成 Runner 计划草稿",
          planDraft: structuredClone(draft),
          assistantMessage: {
            ...previousTranscript[1]!,
            content: [{
              type: "text",
              text: "已生成 Runner 计划草稿"
            }]
          }
        };
      }
    }
  });
  const assistantResponse = await routed.run({
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "sales-a",
    sessionId: "session-assistant",
    snapshot,
    transcript: previousTranscript,
    prompt: "普通分析",
    responseMode: "assistant"
  });
  assert.equal(assistantResponse, assistantResult);
  assert.equal(assistantCalls.length, 1);
  assert.equal(generatorCalls.length, 0);

  const draftResponse = await routed.run({
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "sales-a",
    sessionId: "session-plan-draft",
    snapshot,
    transcript: previousTranscript,
    prompt: "生成获客计划草稿",
    responseMode: "plan_draft",
    targetPlatform: "douyin"
  });
  assert.equal(assistantCalls.length, 1);
  assert.equal(generatorCalls.length, 1);
  assert.deepEqual(generatorCalls[0], {
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "sales-a",
    sessionId: "session-plan-draft",
    transcript: previousTranscript,
    prompt: "生成获客计划草稿",
    targetPlatform: "douyin"
  });
  assert.deepEqual(
    draftResponse.newMessages.map((message) => message.role),
    ["user", "assistant"]
  );
  const draftUserMessage = draftResponse.newMessages[0];
  assert.equal(draftUserMessage?.role, "user");
  assert.equal(
    draftUserMessage?.role === "user"
      ? draftUserMessage.content
      : null,
    "生成获客计划草稿"
  );
  assert.deepEqual(draftResponse.result, {
    summary: "已生成 Runner 计划草稿",
    toolNames: [],
    planDraft: draft
  });
}

{
  const failingRunner = createPiAcquisitionCopilotRunner({
    runtimeFactory: {
      async create() {
        return {
          async run() {
            throw new Error("MODEL_RATE_LIMITED apiKey=must-not-leak");
          }
        };
      }
    },
    toolExecutor: {
      async execute() {
        return {};
      }
    },
    toolAudit: audit,
    toolAuditSecret:
      "copilot-runner-failure-secret-at-least-32-characters"
  });
  await assert.rejects(
    () => failingRunner.run({
      ownerId: "owner-a",
      teamId: "team-a",
      actorId: "sales-a",
      sessionId: "session-failure",
      snapshot,
      transcript: [],
      prompt: "触发失败",
      responseMode: "assistant"
    }),
    (error: unknown) =>
      error instanceof Error
      && error.message === "MODEL_RATE_LIMITED"
      && !error.message.includes("must-not-leak")
  );
}

{
  const timeoutRunner = createPiAcquisitionCopilotRunner({
    runtimeFactory: {
      async create() {
        return {
          async run(input) {
            return new Promise((_, reject) => {
              input.signal?.addEventListener("abort", () => {
                reject(new DOMException("aborted", "AbortError"));
              }, { once: true });
            });
          }
        };
      }
    },
    toolExecutor: {
      async execute() {
        throw new Error("not expected");
      }
    },
    toolAudit: audit,
    toolAuditSecret:
      "copilot-runner-timeout-secret-at-least-32-characters",
    runLimits: {
      maxToolCalls: 32,
      maxModelTurns: 16,
      maxDurationMs: 10,
      maxTotalTokens: 200_000
    }
  });

  await assert.rejects(
    () => timeoutRunner.run({
      ownerId: "owner-a",
      teamId: "team-a",
      actorId: "sales-a",
      sessionId: "session-timeout",
      snapshot,
      transcript: [],
      prompt: "等待超时",
      responseMode: "assistant"
    }),
    (error: unknown) =>
      error instanceof Error
      && error.message === "AGENT_DURATION_EXHAUSTED"
  );
}

{
  let runtimeCalls = 0;
  const externalAbort = new AbortController();
  externalAbort.abort();
  const cancelledRunner = createPiAcquisitionCopilotRunner({
    runtimeFactory: {
      async create() {
        return {
          async run() {
            runtimeCalls += 1;
            return {
              type: "text",
              text: "不应运行",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                reasoningTokens: 0
              },
              providerRequestId: null
            };
          }
        };
      }
    },
    toolExecutor: {
      async execute() {
        throw new Error("not expected");
      }
    },
    toolAudit: audit,
    toolAuditSecret:
      "copilot-runner-cancel-secret-at-least-32-characters",
    runLimits: {
      maxToolCalls: 32,
      maxModelTurns: 16,
      maxDurationMs: 1,
      maxTotalTokens: 200_000
    }
  });

  await assert.rejects(
    () => cancelledRunner.run({
      ownerId: "owner-a",
      teamId: "team-a",
      actorId: "sales-a",
      sessionId: "session-cancelled",
      snapshot,
      transcript: [],
      prompt: "外部取消优先",
      responseMode: "assistant",
      signal: externalAbort.signal
    }),
    (error: unknown) =>
      error instanceof Error
      && error.message === "MODEL_STREAM_ABORTED"
  );
  assert.equal(runtimeCalls, 0);
}

console.log("acquisition copilot runner tests passed");
