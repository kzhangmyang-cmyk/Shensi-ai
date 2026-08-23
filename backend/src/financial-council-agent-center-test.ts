import assert from "node:assert/strict";
import test from "node:test";
import { FinancialCouncilAgentCenter } from
  "./financial-council-agent-center.js";
import { workspace } from "./financial-council-repository-contract-test.js";

const T1 = "2026-08-23T08:00:00.000Z";
const T2 = "2026-08-23T08:00:01.000Z";

function context() {
  return Object.freeze({ ...workspace("ws-1"), role: "admin" as const,
    capabilities: Object.freeze(["finance.council.run" as const,
      "finance.council.approve" as const,
      "finance.council.policy.manage" as const]) });
}

function call(overrides: Record<string, unknown>) {
  return {
    id: "call-1", ownerId: "owner-1", teamId: "ws-1",
    jobId: "financial-council:run-1:finance:analysis:1",
    attemptId: "attempt-1", connectionId: "connection-1",
    credentialVersion: 1, capabilitySnapshotHash: `sha256:${"a".repeat(64)}`,
    provider: "deepseek", baseUrlFingerprint: `sha256:${"b".repeat(64)}`,
    model: "deepseek-chat", promptVersion: "prompt.v1",
    schemaVersion: "schema.v1", requestId: "request-1",
    providerRequestId: null, inputTokens: 1, outputTokens: 1,
    reasoningTokens: 0, latencyMs: 1_000, status: "failed",
    error: { code: "MODEL_RATE_LIMITED", status: 429, retryable: true,
      retryAfterMs: null },
    cost: { amountMinor: 0, currency: "CNY", kind: "unknown" },
    parameterHash: `sha256:${"c".repeat(64)}`,
    resultHash: `sha256:${"d".repeat(64)}`, createdAt: T1,
    ...overrides
  };
}

test("agent center exposes sanitized exact ordered attempts", async () => {
  const center = new FinancialCouncilAgentCenter({
    latestPackage: { async getLatestVerified() { return {
      packageId: "package-1", companyName: "ACME", period: "2026-07",
      createdAt: T1, warnings: []
    }; } },
    latestRun: { async findLatestRun() { return {
      runId: "run-1", workspaceId: "ws-1", status: "analyzing", revision: 3,
      modelRoutingPolicyVersionId: "routing-1", updatedAt: T2
    }; } },
    routing: { async getCurrent() { return { policyVersionId: "routing-1" }; } },
    runtimeState: () => ({
      connections: [{ id: "connection-1", ownerId: "owner-1",
        teamId: "ws-1", provider: "deepseek", model: "deepseek-chat",
        name: "DeepSeek 主连接", apiKey: "must-not-leak", credentialVersion: 1,
        status: "active", capabilitySnapshot: { structuredOutput: true } }],
      recentCalls: [call({}), call({ id: "call-2", attemptId: "attempt-2",
        jobId: "financial-council:run-1:finance:analysis:2",
        provider: "qwen", model: "qwen-plus", status: "succeeded",
        error: null, createdAt: T2, latencyMs: 1_000 })]
    })
  } as never);
  const view = await center.getRunAgents(context(), "run-1");
  assert.deepEqual(view.roles.map((role) => role.role),
    ["cfo", "finance", "profit", "cost", "cashflow", "tax"]);
  assert.deepEqual(view.roles[1]?.attempts, [{
    attempt: 1, provider: "deepseek", model: "deepseek-chat",
    connectionDisplayName: "DeepSeek 主连接", status: "failed",
    errorCode: "MODEL_RATE_LIMITED", startedAt: T1, completedAt: T2
  }, {
    attempt: 2, provider: "qwen", model: "qwen-plus",
    connectionDisplayName: "DeepSeek 主连接", status: "succeeded",
    errorCode: null, startedAt: T2, completedAt: "2026-08-23T08:00:02.000Z"
  }]);
  const serialized = JSON.stringify(view);
  for (const forbidden of ["apiKey", "credential", "prompt", "businessData",
    "businessReport", "modelRoutingPolicyVersionId"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("agent center nulls unsafe derived completion time and hides cross-workspace runs", async () => {
  const center = new FinancialCouncilAgentCenter({
    latestPackage: { async getLatestVerified() { return null; } },
    latestRun: { async findLatestRun() { return { runId: "run-1",
      workspaceId: "ws-2", status: "approved", revision: 4, updatedAt: T2 }; } },
    routing: { async getCurrent() { return null; } },
    runtimeState: () => ({ connections: [], recentCalls: [call({
      latencyMs: Number.MAX_SAFE_INTEGER, createdAt: "malformed"
    })] })
  } as never);
  const overview = await center.get(context());
  assert.equal(overview.latestRun, null);
  await assert.rejects(center.getRunAgents(context(), "run-1"),
    { code: "financial_council_run_not_found" });
});
