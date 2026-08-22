import assert from "node:assert/strict";
import type {
  AgentTool
} from "@earendil-works/pi-agent-core";
import {
  InMemoryAcquisitionToolAuditLedger,
  createAcquisitionAgentTools,
  type AcquisitionAgentToolExecutor,
  type AcquisitionToolExecutionInput,
  type AcquisitionToolAuditLedger
} from "./acquisition-pi-tools.js";

const EXPECTED_TOOLS = [
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
] as const;

function byName(tools: AgentTool[], name: string) {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

const calls: AcquisitionToolExecutionInput[] = [];
const executor: AcquisitionAgentToolExecutor = {
  async execute(input) {
    calls.push(input);
    if (input.toolName === "get_acquisition_performance"
      && input.payload.from === "2026-07-24") {
      const error = new Error("OUTCOME_REJECTED secret=should-not-leak");
      error.name = "AcquisitionToolExecutionError";
      throw error;
    }
    return {
      ok: true,
      toolName: input.toolName,
      candidateId: input.payload.candidateId ?? null,
      apiKey: "sk-must-be-redacted",
      nested: {
        authorization: "Bearer must-be-redacted",
        publicSummary: "safe"
      }
    };
  }
};

const audit = new InMemoryAcquisitionToolAuditLedger();
const tools = createAcquisitionAgentTools({
  identity: {
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "owner-a",
    sessionId: "copilot-session-a"
  },
  executor,
  audit,
  auditSecret: "test-acquisition-tool-audit-secret-at-least-32-bytes",
  now: (() => {
    let value = Date.parse("2026-07-24T00:00:00.000Z");
    return () => value++;
  })()
});

assert.deepEqual(
  tools.map((tool) => tool.name),
  EXPECTED_TOOLS,
  "Pi must receive the exact Acquisition and controlled Quote allowlist"
);
assert.equal(
  tools.some((tool) => ["bash", "shell", "read_file", "write_file", "database"].includes(tool.name)),
  false,
  "Pi must never receive general host authority"
);
for (const tool of tools) {
  assert.equal(
    (tool.parameters as { additionalProperties?: unknown }).additionalProperties,
    false,
    `${tool.name} must reject undeclared arguments`
  );
}

await byName(tools, "search_public_sources").execute(
  "call-search-1",
  {
    query: "厦门 装修公司 招聘 销售",
    providerConnectionIds: ["connection-baidu"],
    subjectKinds: ["organization", "individual"],
    maxResults: 20
  },
  undefined
);

const searchRequired = (
  byName(tools, "search_public_sources").parameters as {
    required?: string[];
  }
).required ?? [];
assert.equal(
  searchRequired.includes("providerConnectionIds"),
  false,
  "the customer-facing agent must be able to use active connections automatically"
);

assert.equal(calls.length, 1);
assert.deepEqual(calls[0]?.identity, {
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "owner-a",
  sessionId: "copilot-session-a"
});
assert.equal(calls[0]?.toolName, "search_public_sources");
assert.equal(calls[0]?.toolCallId, "call-search-1");
assert.match(calls[0]?.idempotencyKey ?? "", /^pi-tool:/);
assert.equal(
  byName(tools, "search_public_sources").executionMode,
  "parallel"
);
assert.equal(
  byName(tools, "create_review_task").executionMode,
  "sequential"
);
assert.equal(
  byName(tools, "get_acquisition_performance").executionMode,
  "parallel"
);
assert.equal(tools.some((tool) => tool.name === "record_outcome"), false);
const performanceProperties = (
  byName(tools, "get_acquisition_performance").parameters as {
    properties?: Record<string, unknown>;
  }
).properties ?? {};
assert.deepEqual(Object.keys(performanceProperties).sort(), [
  "from",
  "platform",
  "to"
]);
assert.deepEqual(performanceProperties.from, {
  type: "string",
  minLength: 10,
  maxLength: 10,
  format: "date"
});
assert.deepEqual(performanceProperties.to, {
  type: "string",
  minLength: 10,
  maxLength: 10,
  format: "date"
});

await byName(tools, "get_acquisition_performance").execute(
  "call-performance-date-only",
  {
    platform: "douyin",
    from: "2026-08-01",
    to: "2026-08-07"
  },
  undefined
);
assert.deepEqual(calls.at(-1)?.payload, {
  platform: "douyin",
  from: "2026-08-01",
  to: "2026-08-07"
});

const evidenceResult = await byName(tools, "get_candidate_evidence").execute(
  "call-evidence-1",
  { candidateId: "candidate-a" },
  undefined
);
const evidenceText = evidenceResult.content
  .filter((item) => item.type === "text")
  .map((item) => item.text)
  .join("");
assert.equal(evidenceText.includes("sk-must-be-redacted"), false);
assert.equal(evidenceText.includes("Bearer must-be-redacted"), false);
assert.equal(evidenceText.includes("[REDACTED]"), true);
assert.equal(evidenceText.includes("publicSummary"), true);

let releaseBlockingAudit: (() => void) | undefined;
let blockingAuditStarted = false;
const blockingAudit: AcquisitionToolAuditLedger = {
  append() {
    blockingAuditStarted = true;
    return new Promise<void>((resolve) => {
      releaseBlockingAudit = resolve;
    });
  },
  async list() {
    return [];
  }
};
const toolsWithBlockingAudit = createAcquisitionAgentTools({
  identity: {
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "owner-a",
    sessionId: "copilot-session-blocking-audit"
  },
  executor: {
    async execute() {
      return { ok: true };
    }
  },
  audit: blockingAudit,
  auditSecret: "test-blocking-tool-audit-secret-at-least-32-bytes"
});
let blockingToolSettled = false;
const blockingToolExecution = byName(
  toolsWithBlockingAudit,
  "get_candidate_evidence"
).execute(
  "call-blocking-audit",
  { candidateId: "candidate-a" },
  undefined
).finally(() => {
  blockingToolSettled = true;
});
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(blockingAuditStarted, true);
assert.equal(
  blockingToolSettled,
  false,
  "a tool result must not return to Pi before its audit record is durable"
);
assert.ok(releaseBlockingAudit);
releaseBlockingAudit();
await blockingToolExecution;

let rejectingAuditAttempts = 0;
const rejectingAudit: AcquisitionToolAuditLedger = {
  async append() {
    rejectingAuditAttempts += 1;
    throw new Error("mysql password=must-not-leak");
  },
  async list() {
    return [];
  }
};
const toolsWithRejectingAudit = createAcquisitionAgentTools({
  identity: {
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "owner-a",
    sessionId: "copilot-session-rejecting-audit"
  },
  executor: {
    async execute() {
      return { ok: true };
    }
  },
  audit: rejectingAudit,
  auditSecret: "test-rejecting-tool-audit-secret-at-least-32-bytes"
});
await assert.rejects(
  () => byName(
    toolsWithRejectingAudit,
    "get_candidate_evidence"
  ).execute(
    "call-rejecting-audit",
    { candidateId: "candidate-a" },
    undefined
  ),
  (error: unknown) =>
    error instanceof Error
    && error.message === "ACQUISITION_TOOL_AUDIT_WRITE_FAILED"
    && !error.message.includes("must-not-leak")
);
assert.equal(
  rejectingAuditAttempts,
  1,
  "an audit storage failure must fail closed without a second misleading audit"
);

const abortController = new AbortController();
abortController.abort();
const beforeAbortCalls = calls.length;
await assert.rejects(
  () => byName(tools, "qualify_candidate").execute(
    "call-aborted",
    { candidateId: "candidate-a", policyVersion: "qualification-v1" },
    abortController.signal
  ),
  (error: unknown) => error instanceof DOMException && error.name === "AbortError"
);
assert.equal(calls.length, beforeAbortCalls);

await assert.rejects(
  () => byName(tools, "get_acquisition_performance").execute(
    "call-failure-1",
    {
      from: "2026-07-24",
      to: "2026-07-24"
    },
    undefined
  ),
  /OUTCOME_REJECTED/
);

const records = await audit.list({
  ownerId: "owner-a",
  teamId: "team-a",
  sessionId: "copilot-session-a"
});
assert.equal(records.length, 5);
assert.deepEqual(records.map((item) => item.status), [
  "succeeded",
  "succeeded",
  "succeeded",
  "aborted",
  "failed"
]);
for (const record of records) {
  assert.equal(record.ownerId, "owner-a");
  assert.equal(record.teamId, "team-a");
  assert.equal(record.sessionId, "copilot-session-a");
  assert.match(record.parameterHash, /^[a-f0-9]{64}$/);
  assert.equal(
    JSON.stringify(record).includes("sk-must-be-redacted"),
    false
  );
  assert.equal(
    JSON.stringify(record).includes("should-not-leak"),
    false
  );
}

assert.deepEqual(
  await audit.list({
    ownerId: "other-owner",
    teamId: "team-a",
    sessionId: "copilot-session-a"
  }),
  [],
  "audit reads must be owner/team isolated"
);

assert.throws(
  () => createAcquisitionAgentTools({
    identity: {
      ownerId: "owner-a",
      teamId: "team-a",
      actorId: "owner-a",
      sessionId: "copilot-session-a"
    },
    executor,
    audit,
    auditSecret: "too-short"
  }),
  /auditSecret/
);

console.log("acquisition Pi tool boundary tests passed");
