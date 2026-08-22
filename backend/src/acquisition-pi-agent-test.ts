import assert from "node:assert/strict";
import type {
  AgentEvent
} from "@earendil-works/pi-agent-core";
import {
  createAcquisitionPiAgent,
  type AcquisitionPiTurnInput,
  type AcquisitionPiTurnRuntime
} from "./acquisition-pi-agent.js";
import {
  InMemoryAcquisitionToolAuditLedger,
  type AcquisitionToolExecutionInput
} from "./acquisition-pi-tools.js";

const turns: AcquisitionPiTurnInput[] = [];
const runtime: AcquisitionPiTurnRuntime = {
  async run(input) {
    turns.push(input);
    if (turns.length === 1) {
      return {
        type: "tool_calls",
        providerRequestId: "provider-request-1",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 0
        },
        calls: [{
          id: "tool-call-1",
          name: "get_candidate_evidence",
          arguments: { candidateId: "candidate-a" }
        }]
      };
    }
    return {
      type: "text",
      providerRequestId: "provider-request-2",
      usage: {
        inputTokens: 140,
        outputTokens: 30,
        reasoningTokens: 4
      },
      text: "候选客户存在明确需求信号；结论基于已核验的公开证据。"
    };
  }
};

const toolExecutions: AcquisitionToolExecutionInput[] = [];
const audit = new InMemoryAcquisitionToolAuditLedger();
const agent = createAcquisitionPiAgent({
  identity: {
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "owner-a",
    sessionId: "copilot-a"
  },
  snapshot: {
    jobId: "job-a",
    connectionId: "connection-a",
    credentialVersion: 3,
    provider: "moonshot",
    model: "kimi-k2.5",
    promptVersion: "acquisition-copilot-v1",
    schemaVersion: "copilot-turn.v1",
    promptHash: "sha256:prompt-acquisition-copilot-v1",
    schemaHash: "sha256:schema-copilot-turn-v1",
    capabilitySnapshotHash: "capability-hash-a",
    baseUrlFingerprint: "base-url-hash-a"
  },
  runtime,
  toolExecutor: {
    async execute(input) {
      toolExecutions.push(input);
      return {
        candidateId: input.payload.candidateId,
        evidence: [{
          sourceUrl: "https://example.cn/procurement/1",
          summary: "公开采购需求"
        }]
      };
    }
  },
  toolAudit: audit,
  toolAuditSecret: "pi-agent-test-audit-secret-at-least-32-characters"
});

const events: AgentEvent[] = [];
agent.subscribe((event) => {
  events.push(event);
});

await agent.prompt("分析 candidate-a 是否值得跟进，并说明证据。");

assert.equal(turns.length, 2);
assert.equal(turns[0]?.snapshot.credentialVersion, 3);
assert.equal(turns[0]?.snapshot.connectionId, "connection-a");
assert.deepEqual(
  turns[0]?.tools.map((tool) => tool.name),
  [
    "search_public_sources",
    "get_candidate_evidence",
    "research_candidate",
    "qualify_candidate",
    "build_battle_card",
    "estimate_financial_value",
    "draft_connection_strategy",
    "list_priority_candidates",
    "create_review_task",
    "get_acquisition_performance",
    "list_catalog_items",
    "get_pricing_policy",
    "preview_quote",
    "create_quote_draft",
    "list_pending_quote_approvals",
    "get_quote_decision",
    "create_quote_approval_task",
    "get_growth_performance",
    "list_financial_data_gaps",
    "create_advisor_recommendation",
    "create_sales_todo",
    "record_recommendation_outcome"
  ]
);
assert.equal(toolExecutions.length, 1);
assert.equal(toolExecutions[0]?.identity.ownerId, "owner-a");
assert.equal(toolExecutions[0]?.payload.candidateId, "candidate-a");
assert.equal(
  turns[1]?.messages.some((message) => message.role === "toolResult"),
  true,
  "the gateway turn after a tool must receive the audited tool result"
);
assert.equal(
  agent.state.messages.some((message) =>
    message.role === "assistant"
    && message.content.some((content) =>
      content.type === "text"
      && content.text.includes("公开证据")
    )
  ),
  true
);
assert.equal(
  events.some((event) => event.type === "tool_execution_end"),
  true
);
assert.equal(
  (await audit.list({
    ownerId: "owner-a",
    teamId: "team-a",
    sessionId: "copilot-a"
  })).length,
  1
);

const failingAgent = createAcquisitionPiAgent({
  identity: {
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "owner-a",
    sessionId: "copilot-failure"
  },
  snapshot: {
    jobId: "job-b",
    connectionId: "connection-a",
    credentialVersion: 3,
    provider: "moonshot",
    model: "kimi-k2.5",
    promptVersion: "acquisition-copilot-v1",
    schemaVersion: "copilot-turn.v1",
    promptHash: "sha256:prompt-acquisition-copilot-v1",
    schemaHash: "sha256:schema-copilot-turn-v1",
    capabilitySnapshotHash: "capability-hash-a",
    baseUrlFingerprint: "base-url-hash-a"
  },
  runtime: {
    async run() {
      throw new Error("MODEL_RATE_LIMITED apiKey=must-not-leak");
    }
  },
  toolExecutor: {
    async execute() {
      throw new Error("not expected");
    }
  },
  toolAudit: audit,
  toolAuditSecret: "pi-agent-test-audit-secret-at-least-32-characters"
});

await failingAgent.prompt("分析客户");
assert.equal(failingAgent.state.errorMessage, "MODEL_RATE_LIMITED");
assert.equal(
  JSON.stringify(failingAgent.state.messages).includes("must-not-leak"),
  false
);

assert.throws(
  () => createAcquisitionPiAgent({
    identity: {
      ownerId: "owner-a",
      teamId: "team-a",
      actorId: "owner-a",
      sessionId: "copilot-invalid"
    },
    snapshot: {
      jobId: "",
      connectionId: "connection-a",
      credentialVersion: 3,
      provider: "moonshot",
      model: "kimi-k2.5",
      promptVersion: "acquisition-copilot-v1",
      schemaVersion: "copilot-turn.v1",
      promptHash: "sha256:prompt-acquisition-copilot-v1",
      schemaHash: "sha256:schema-copilot-turn-v1",
      capabilitySnapshotHash: "capability-hash-a",
      baseUrlFingerprint: "base-url-hash-a"
    },
    runtime,
    toolExecutor: {
      async execute() {
        return {};
      }
    },
    toolAudit: audit,
    toolAuditSecret: "pi-agent-test-audit-secret-at-least-32-characters"
  }),
  /snapshot.jobId/
);

const restoredTranscript = [{
  role: "user" as const,
  content: "上一轮已要求只分析公开采购信号。",
  timestamp: 10
}];
const resumedAgent = createAcquisitionPiAgent({
  identity: {
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "owner-a",
    sessionId: "copilot-resumed"
  },
  snapshot: {
    jobId: "job-resumed",
    connectionId: "connection-a",
    credentialVersion: 3,
    provider: "moonshot",
    model: "kimi-k2.5",
    promptVersion: "acquisition-copilot-v1",
    schemaVersion: "copilot-turn.v1",
    promptHash: "sha256:prompt-acquisition-copilot-v1",
    schemaHash: "sha256:schema-copilot-turn-v1",
    capabilitySnapshotHash: "capability-hash-a",
    baseUrlFingerprint: "base-url-hash-a"
  },
  runtime,
  toolExecutor: {
    async execute() {
      return {};
    }
  },
  toolAudit: audit,
  toolAuditSecret: "pi-agent-test-audit-secret-at-least-32-characters",
  initialMessages: restoredTranscript
});
assert.deepEqual(resumedAgent.state.messages, restoredTranscript);
restoredTranscript[0]!.content = "调用者后续修改不得污染智能体状态";
assert.equal(
  resumedAgent.state.messages[0]?.role === "user"
    ? resumedAgent.state.messages[0].content
    : "",
  "上一轮已要求只分析公开采购信号。"
);

{
  let runtimeCalls = 0;
  let realToolExecutions = 0;
  const budgetAgent = createAcquisitionPiAgent({
    identity: {
      ownerId: "owner-a",
      teamId: "team-a",
      actorId: "owner-a",
      sessionId: "copilot-tool-budget"
    },
    snapshot: {
      jobId: "job-tool-budget",
      connectionId: "connection-a",
      credentialVersion: 3,
      provider: "moonshot",
      model: "kimi-k2.5",
      promptVersion: "acquisition-copilot-v1",
      schemaVersion: "copilot-turn.v1",
      promptHash: "sha256:prompt-acquisition-copilot-v1",
      schemaHash: "sha256:schema-copilot-turn-v1",
      capabilitySnapshotHash: "capability-hash-a",
      baseUrlFingerprint: "base-url-hash-a"
    },
    runtime: {
      async run() {
        runtimeCalls += 1;
        if (runtimeCalls === 1) {
          return {
            type: "tool_calls",
            providerRequestId: "provider-tool-budget",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              reasoningTokens: 0
            },
            calls: Array.from({ length: 33 }, (_, index) => ({
              id: `budget-tool-${index + 1}`,
              name: "get_candidate_evidence",
              arguments: { candidateId: `candidate-${index + 1}` }
            }))
          };
        }
        return {
          type: "text",
          providerRequestId: "provider-tool-budget-fallback",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            reasoningTokens: 0
          },
          text: "不应发起预算耗尽后的模型回合"
        };
      }
    },
    toolExecutor: {
      async execute() {
        realToolExecutions += 1;
        return {};
      }
    },
    toolAudit: new InMemoryAcquisitionToolAuditLedger(),
    toolAuditSecret:
      "pi-agent-tool-budget-secret-at-least-32-characters"
  });

  await budgetAgent.prompt("验证工具预算");

  assert.equal(
    realToolExecutions,
    32,
    "the 33rd tool call must be rejected before the real executor starts"
  );
  assert.equal(
    runtimeCalls,
    1,
    "tool budget exhaustion must terminate the run after the current batch"
  );
  assert.match(
    JSON.stringify(budgetAgent.state.messages),
    /AGENT_TOOL_BUDGET_EXHAUSTED/
  );
}

{
  let runtimeCalls = 0;
  let realToolExecutions = 0;
  const budgetAgent = createAcquisitionPiAgent({
    identity: {
      ownerId: "owner-a",
      teamId: "team-a",
      actorId: "owner-a",
      sessionId: "copilot-turn-budget"
    },
    snapshot: {
      jobId: "job-turn-budget",
      connectionId: "connection-a",
      credentialVersion: 3,
      provider: "moonshot",
      model: "kimi-k2.5",
      promptVersion: "acquisition-copilot-v1",
      schemaVersion: "copilot-turn.v1",
      promptHash: "sha256:prompt-acquisition-copilot-v1",
      schemaHash: "sha256:schema-copilot-turn-v1",
      capabilitySnapshotHash: "capability-hash-a",
      baseUrlFingerprint: "base-url-hash-a"
    },
    runtime: {
      async run() {
        runtimeCalls += 1;
        if (runtimeCalls <= 16) {
          return {
            type: "tool_calls",
            providerRequestId: `provider-turn-${runtimeCalls}`,
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              reasoningTokens: 1
            },
            calls: [{
              id: `turn-budget-tool-${runtimeCalls}`,
              name: "get_candidate_evidence",
              arguments: { candidateId: "candidate-a" }
            }]
          };
        }
        return {
          type: "text",
          providerRequestId: "provider-turn-17",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            reasoningTokens: 1
          },
          text: "不应启动第十七个模型回合"
        };
      }
    },
    toolExecutor: {
      async execute() {
        realToolExecutions += 1;
        return {};
      }
    },
    toolAudit: new InMemoryAcquisitionToolAuditLedger(),
    toolAuditSecret:
      "pi-agent-turn-budget-secret-at-least-32-characters"
  });

  await budgetAgent.prompt("验证模型回合预算");

  assert.equal(runtimeCalls, 16);
  assert.equal(realToolExecutions, 16);
  assert.equal(
    budgetAgent.state.errorMessage,
    "AGENT_TURN_BUDGET_EXHAUSTED"
  );
}

{
  let runtimeCalls = 0;
  const budgetAgent = createAcquisitionPiAgent({
    identity: {
      ownerId: "owner-a",
      teamId: "team-a",
      actorId: "owner-a",
      sessionId: "copilot-token-budget"
    },
    snapshot: {
      jobId: "job-token-budget",
      connectionId: "connection-a",
      credentialVersion: 3,
      provider: "moonshot",
      model: "kimi-k2.5",
      promptVersion: "acquisition-copilot-v1",
      schemaVersion: "copilot-turn.v1",
      promptHash: "sha256:prompt-acquisition-copilot-v1",
      schemaHash: "sha256:schema-copilot-turn-v1",
      capabilitySnapshotHash: "capability-hash-a",
      baseUrlFingerprint: "base-url-hash-a"
    },
    runtime: {
      async run() {
        runtimeCalls += 1;
        return {
          type: "text",
          providerRequestId: "provider-token-budget",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            reasoningTokens: 200_000
          },
          text: "不应接受超过总 token 预算的模型结果"
        };
      }
    },
    toolExecutor: {
      async execute() {
        return {};
      }
    },
    toolAudit: new InMemoryAcquisitionToolAuditLedger(),
    toolAuditSecret:
      "pi-agent-token-budget-secret-at-least-32-characters"
  });

  await budgetAgent.prompt("验证 token 预算");

  assert.equal(runtimeCalls, 1);
  assert.equal(
    budgetAgent.state.errorMessage,
    "AGENT_TOKEN_BUDGET_EXHAUSTED"
  );
}

console.log("acquisition Pi agent tests passed");
