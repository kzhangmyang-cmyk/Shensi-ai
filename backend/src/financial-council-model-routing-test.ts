import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCallRecord } from "./model-providers/call-ledger.js";
import type { ModelConnection } from "./model-providers/types.js";
import {
  createFinancialCouncilModelRoutingPolicyVersion,
  normalizeFinancialCouncilModelRoutingPolicyInput,
  parseFinancialCouncilModelCallJobId,
  selectFinancialCouncilModelRoute,
  type FinancialCouncilModelPrice,
  type FinancialCouncilModelRoutingPolicyInput,
  type FinancialCouncilModelRoutingPolicyVersion,
  type FinancialCouncilRoleRoute
} from "./financial-council-model-routing.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { readFinancialCouncilModelRoutingRuntimeState } from
  "./model-providers/runtime.js";

const HASH = `sha256:${"a".repeat(64)}`;

function hasCode(code: string) {
  return (error: unknown) => (error as { code?: unknown })?.code === code;
}

function workspace(
  workspaceId = "team-1",
  actorId = "admin-1"
): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId,
    kind: "team" as const,
    actorId,
    role: "admin" as const,
    teamId: workspaceId,
    capabilities: Object.freeze([]),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

function route(
  overrides: Partial<FinancialCouncilRoleRoute> = {}
): FinancialCouncilRoleRoute {
  return {
    mode: "auto",
    primaryConnectionId: null,
    fallbackConnectionIds: [],
    preferenceWeightBps: 0,
    ...overrides
  };
}

function defaultRoles() {
  return {
    cfo: route(),
    finance: route(),
    profit: route(),
    cost: route(),
    cashflow: route(),
    tax: route()
  };
}

function routingInput(
  overrides: Partial<FinancialCouncilModelRoutingPolicyInput> = {}
): FinancialCouncilModelRoutingPolicyInput {
  return {
    roles: defaultRoles(),
    maxRunBudgetMinor: 100_000,
    maxRoleBudgetMinor: 30_000,
    requestTimeoutMs: 60_000,
    ...overrides
  };
}

function policy(
  inputOverrides: Partial<FinancialCouncilModelRoutingPolicyInput> = {}
): FinancialCouncilModelRoutingPolicyVersion {
  return createFinancialCouncilModelRoutingPolicyVersion({
    policyVersionId: "routing-policy-1",
    workspaceId: "team-1",
    revision: 1,
    status: "active",
    input: routingInput(inputOverrides),
    createdBy: "admin-1",
    createdAt: "2026-08-23T09:00:00.000Z"
  });
}

function connection(
  id: string,
  capabilities: Partial<ModelConnection["capabilitySnapshot"]> = {},
  overrides: Partial<ModelConnection> = {}
): ModelConnection {
  return {
    id,
    ownerId: "admin-1",
    teamId: "team-1",
    provider: "openai",
    model: "gpt-test",
    credentialVersion: 1,
    capabilitySnapshot: {
      structuredOutput: true,
      toolCalling: false,
      parallelToolCalling: false,
      streaming: false,
      modelListing: false,
      ...capabilities
    },
    capabilityCertificationHash: HASH,
    status: "active",
    createdAt: "2026-08-23T08:00:00.000Z",
    updatedAt: "2026-08-23T08:00:00.000Z",
    ...overrides
  };
}

function call(
  id: string,
  connectionId: string,
  options: {
    role?: "cfo" | "finance" | "profit" | "cost" | "cashflow" | "tax";
    runId?: string;
    jobId?: string;
    status?: "succeeded" | "failed";
    latencyMs?: number;
    amountMinor?: number;
    costKind?: "estimated" | "actual" | "unknown";
    createdAt?: string;
    ownerId?: string;
    teamId?: string;
  } = {}
): ModelCallRecord {
  const role = options.role ?? "finance";
  const status = options.status ?? "succeeded";
  return Object.freeze({
    id,
    ownerId: options.ownerId ?? "admin-1",
    teamId: options.teamId ?? "team-1",
    jobId: options.jobId
      ?? `financial-council:${options.runId ?? "run:with:colons"}:${role}:analyze:1`,
    attemptId: `attempt-${id}`,
    connectionId,
    credentialVersion: 1,
    capabilitySnapshotHash: HASH,
    provider: "openai" as const,
    baseUrlFingerprint: HASH,
    model: "gpt-test",
    promptVersion: "prompt.v1",
    schemaVersion: "schema.v1",
    requestId: `request-${id}`,
    providerRequestId: null,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 0,
    latencyMs: options.latencyMs ?? 100,
    status,
    error: status === "failed" ? {
      code: "provider_unavailable", status: 503, retryable: true,
      retryAfterMs: null
    } : null,
    cost: {
      amountMinor: options.amountMinor ?? 0,
      currency: "USD",
      kind: options.costKind ?? "unknown"
    },
    parameterHash: HASH,
    resultHash: HASH,
    createdAt: options.createdAt ?? "2026-08-23T09:00:00.000Z"
  });
}

function preview(input: {
  role?: "cfo" | "finance" | "profit" | "cost" | "cashflow" | "tax";
  policy?: FinancialCouncilModelRoutingPolicyVersion;
  connections?: readonly ModelConnection[];
  recentCalls?: readonly ModelCallRecord[];
  prices?: readonly FinancialCouncilModelPrice[];
  activeWorkspace?: ActiveWorkspaceContext;
}) {
  return selectFinancialCouncilModelRoute({
    role: input.role ?? "finance",
    policy: input.policy ?? policy(),
    connections: input.connections ?? [connection("model-a")],
    recentCalls: input.recentCalls ?? [],
    prices: input.prices ?? [],
    activeWorkspace: input.activeWorkspace ?? workspace()
  });
}

test("auto routing is deterministic and excludes uncertified connections", () => {
  const result = preview({
    role: "cashflow",
    policy: policy({
      roles: {
        ...defaultRoles(),
        cashflow: route()
      }
    }),
    connections: [
      connection("b"),
      connection("a"),
      connection("x", { structuredOutput: false }),
      connection("no-cert", {}, { capabilityCertificationHash: undefined })
    ]
  });
  assert.deepEqual(result.orderedConnectionIds, ["a", "b"]);
  assert.deepEqual(result.reasonCodes, [
    "structured_output_certified", "cost_unknown", "stable_tiebreak"
  ]);
});

test("pinned routing keeps one primary and no more than two fallbacks", () => {
  assert.throws(() => normalizeFinancialCouncilModelRoutingPolicyInput({
    ...routingInput(),
    roles: {
      ...routingInput().roles,
      finance: route({
        mode: "pinned",
        primaryConnectionId: "model-a",
        fallbackConnectionIds: ["model-a", "model-b", "model-c"]
      })
    }
  }), hasCode("financial_council_model_routing_invalid"));
});

test("closed policy validation rejects open objects, duplicate entries and unsafe bounds", () => {
  const invalid: unknown[] = [
    { ...routingInput(), extra: true },
    { ...routingInput(), maxRunBudgetMinor: Number.MAX_SAFE_INTEGER + 1 },
    { ...routingInput(), maxRoleBudgetMinor: -1 },
    { ...routingInput(), requestTimeoutMs: 0 },
    { ...routingInput(), roles: {
      ...defaultRoles(), finance: { ...route(), extra: true }
    } },
    { ...routingInput(), roles: {
      ...defaultRoles(), finance: route({ mode: "pinned",
        primaryConnectionId: "model-a",
        fallbackConnectionIds: ["model-b", "model-b"] })
    } },
    { ...routingInput(), roles: {
      ...defaultRoles(), finance: route({ preferenceWeightBps: 10_001 })
    } },
    { ...routingInput(), roles: {
      ...defaultRoles(), finance: route({ preferenceWeightBps: -1 })
    } }
  ];
  for (const value of invalid) {
    assert.throws(
      () => normalizeFinancialCouncilModelRoutingPolicyInput(value),
      hasCode("financial_council_model_routing_invalid")
    );
  }
});

test("normalized inputs and versions are deeply immutable", () => {
  const normalized = normalizeFinancialCouncilModelRoutingPolicyInput(
    routingInput()
  );
  const version = policy();
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.roles), true);
  assert.equal(Object.isFrozen(normalized.roles.finance), true);
  assert.equal(Object.isFrozen(normalized.roles.finance.fallbackConnectionIds),
    true);
  assert.equal(Object.isFrozen(version), true);
  assert.equal(Object.isFrozen(version.roles.tax), true);
  assert.match(version.policyHash, /^sha256:[0-9a-f]{64}$/u);
});

test("persisted routing identities match bounded ASCII schema columns", () => {
  assert.throws(() => createFinancialCouncilModelRoutingPolicyVersion({
    policyVersionId: "路由-1",
    workspaceId: "team-1",
    revision: 1,
    status: "active",
    input: routingInput(),
    createdBy: "admin-1",
    createdAt: "2026-08-23T09:00:00.000Z"
  }), hasCode("financial_council_model_routing_invalid"));
});

test("canonical financial council job IDs parse role fields from the right", () => {
  assert.deepEqual(parseFinancialCouncilModelCallJobId(
    "financial-council:run:with:colons:cashflow:rebut:2"
  ), {
    runId: "run:with:colons", role: "cashflow", phase: "rebut", attempt: 2
  });
  for (const invalid of [
    "financial-council:run:cashflow:1",
    "financial-council::cashflow:analyze:1",
    "financial-council:run:unknown:analyze:1",
    "financial-council:run:cashflow:analyze:01",
    "legacy:run:cashflow:analyze:1"
  ]) assert.equal(parseFinancialCouncilModelCallJobId(invalid), null);
});

test("only the latest thirty canonical calls in the same workspace and role score", () => {
  const recentCalls = Array.from({ length: 31 }, (_, index) => call(
    `good-${index}`, "good", {
      status: index === 0 ? "failed" : "succeeded",
      createdAt: `2026-08-23T09:${String(index).padStart(2, "0")}:00.000Z`
    }
  ));
  recentCalls.push(
    call("legacy", "bad", { status: "succeeded", latencyMs: 1,
      jobId: "financial-council:legacy-finance" }),
    call("other-role", "bad", { role: "tax", status: "succeeded" }),
    call("other-workspace", "bad", { status: "succeeded", teamId: "team-2" })
  );
  const result = preview({
    connections: [connection("bad"), connection("good")], recentCalls
  });
  assert.equal(result.selectedConnectionId, "good");
  assert.equal(result.reasonCodes.includes("recent_success_rate"), true);
});

test("success rate, P95 latency and consecutive failures affect auto ordering", () => {
  const result = preview({
    connections: [connection("fast"), connection("failing")],
    recentCalls: [
      call("1", "fast", { status: "succeeded", latencyMs: 20,
        createdAt: "2026-08-23T09:03:00.000Z" }),
      call("2", "fast", { status: "succeeded", latencyMs: 30,
        createdAt: "2026-08-23T09:02:00.000Z" }),
      call("3", "failing", { status: "failed", latencyMs: 500,
        createdAt: "2026-08-23T09:04:00.000Z" }),
      call("4", "failing", { status: "failed", latencyMs: 400,
        createdAt: "2026-08-23T09:01:00.000Z" })
    ]
  });
  assert.deepEqual(result.orderedConnectionIds, ["fast", "failing"]);
  assert.equal(result.reasonCodes.includes("recent_p95_latency"), true);
  assert.equal(result.reasonCodes.includes("consecutive_failure_penalty"), true);
});

test("known ledger cost and explicit prices rank cheaply without inventing unknown cost", () => {
  const known = preview({
    connections: [connection("cheap"), connection("costly")],
    recentCalls: [
      call("cheap-call", "cheap", { amountMinor: 1, costKind: "actual" }),
      call("costly-call", "costly", { amountMinor: 100, costKind: "estimated" })
    ]
  });
  assert.deepEqual(known.orderedConnectionIds, ["cheap", "costly"]);
  assert.equal(known.reasonCodes.includes("known_cost"), true);
  const priced = preview({
    connections: [connection("price-low"), connection("price-high")],
    prices: [
      { connectionId: "price-high", inputTokenPriceMinorPerMillion: 8_000,
        outputTokenPriceMinorPerMillion: 20_000,
        createdAt: "2026-08-23T08:00:00.000Z" },
      { connectionId: "price-low", inputTokenPriceMinorPerMillion: 100,
        outputTokenPriceMinorPerMillion: 500,
        createdAt: "2026-08-23T08:00:00.000Z" }
    ]
  });
  assert.deepEqual(priced.orderedConnectionIds, ["price-low", "price-high"]);
  assert.equal(priced.reasonCodes.includes("cost_unknown"), false);
});

test("role preference is a deterministic role-level dimension, not connection preference", () => {
  const weightedPolicy = policy({ roles: {
    ...defaultRoles(), finance: route({ preferenceWeightBps: 2_500 })
  } });
  const result = preview({
    policy: weightedPolicy,
    connections: [connection("b"), connection("a")]
  });
  assert.deepEqual(result.orderedConnectionIds, ["a", "b"]);
  assert.equal(result.reasonCodes.includes("role_preference_weight"), true);
});

test("stable ties use UTF-8 binary connection ordering", () => {
  const result = preview({ connections: [
    connection("é"), connection("z"), connection("Z")
  ] });
  assert.deepEqual(result.orderedConnectionIds, ["Z", "z", "é"]);
});

test("workspace, active state and certification validity fail closed", () => {
  const result = preview({ connections: [
    connection("eligible"),
    connection("cross", {}, { teamId: "team-2" }),
    connection("inactive", {}, { status: "inactive" }),
    connection("disabled", {}, { status: "disabled" }),
    connection("malformed-cert", {}, { capabilityCertificationHash: "sha256:no" }),
    connection("unknown-provider", {}, { provider: "other" as never })
  ] });
  assert.deepEqual(result.orderedConnectionIds, ["eligible"]);
});

test("pinned routing preserves eligible primary and fallback order", () => {
  const pinned = policy({ roles: {
    ...defaultRoles(), finance: route({ mode: "pinned",
      primaryConnectionId: "primary",
      fallbackConnectionIds: ["fallback-2", "fallback-1"] })
  } });
  const result = preview({ policy: pinned, connections: [
    connection("fallback-1"), connection("primary"),
    connection("fallback-2"), connection("other")
  ] });
  assert.deepEqual(result.orderedConnectionIds,
    ["primary", "fallback-2", "fallback-1"]);
});

test("duplicate scorer arrays and unsafe call or price numbers are rejected", () => {
  for (const input of [
    { connections: [connection("same"), connection("same")] },
    { prices: [
      { connectionId: "model-a", inputTokenPriceMinorPerMillion: 1,
        outputTokenPriceMinorPerMillion: 1,
        createdAt: "2026-08-23T08:00:00.000Z" },
      { connectionId: "model-a", inputTokenPriceMinorPerMillion: 2,
        outputTokenPriceMinorPerMillion: 2,
        createdAt: "2026-08-23T09:00:00.000Z" }
    ] },
    { recentCalls: [call("duplicate", "model-a"),
      call("duplicate", "model-a")] },
    { recentCalls: [call("unsafe", "model-a", {
      latencyMs: Number.MAX_SAFE_INTEGER + 1
    })] }
  ]) {
    assert.throws(() => preview(input as never),
      hasCode("financial_council_model_routing_invalid"));
  }
});

test("runtime routing state snapshots official connections and durable ledger facts", () => {
  const record = call("runtime-call", "official");
  const state = readFinancialCouncilModelRoutingRuntimeState({
    aiModelConfigs: [
      { id: "official", provider: "openai", protocol: "openai-compatible",
        name: "Official", baseUrl: "https://api.openai.com/v1",
        model: "gpt-test", apiKey: "", enabled: true, temperature: 0,
        useLeadFinder: false, useWebsiteParse: false, useScoring: false,
        useEmailDraft: false, useExam: false, ownerId: "admin-1",
        teamId: "team-1", credentialVersion: 1,
        capabilitySnapshot: connection("official").capabilitySnapshot,
        capabilityCertificationHash: HASH,
        createdAt: "2026-08-23T08:00:00.000Z",
        updatedAt: "2026-08-23T08:00:00.000Z" },
      { id: "legacy", provider: "custom", protocol: "openai-compatible",
        name: "Legacy", baseUrl: "https://example.test/v1", model: "legacy",
        apiKey: "", enabled: true, temperature: 0, useLeadFinder: false,
        useWebsiteParse: false, useScoring: false, useEmailDraft: false,
        useExam: false, ownerId: "admin-1", teamId: "team-1",
        updatedAt: "2026-08-23T08:00:00.000Z" }
    ],
    modelCredentialVersions: [], aiJobModelSnapshots: [],
    pendingAiJobModelSnapshots: [], modelCallRecords: [record],
    pendingModelCallRecords: []
  });
  assert.deepEqual(state.connections.map((item) => item.id), ["official"]);
  assert.deepEqual(state.recentCalls, [record]);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.connections[0]?.capabilitySnapshot), true);
});
