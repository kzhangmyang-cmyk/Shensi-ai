import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVISOR_TOOL_NAMES,
  GrowthAdvisorAcquisitionToolDelegate,
  GrowthAdvisorToolExecutor,
  GrowthAdvisorToolReplayProjector,
  composeGrowthAcquisitionToolDelegates,
  type GrowthAdvisorToolResultEnvelope
} from "./growth-advisor-tools.js";
import {
  createAcquisitionAgentTools,
  type AcquisitionAgentIdentity,
  type AcquisitionToolExecutionInput
} from "./acquisition-pi-tools.js";
import {
  InMemoryAcquisitionToolAuditLedger
} from "./acquisition-pi-tools.js";
import type {
  AcquisitionToolResultLedgerPort,
  GrowthAcquisitionToolDelegate
} from "./acquisition-tool-executor.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { GrowthCommercialToolPorts } from "./growth-commercial-application.js";

const identity: AcquisitionAgentIdentity = Object.freeze({
  ownerId: "owner-1",
  teamId: "team-1",
  actorId: "sales-a",
  sessionId: "session-1"
});

const managerContext: ActiveWorkspaceContext = Object.freeze({
  workspaceId: "team-1",
  kind: "team",
  actorId: "sales-a",
  role: "sales",
  teamId: "team-1",
  capabilities: Object.freeze([
    "catalog.read",
    "pricing.sensitive.read",
    "growth.performance.team.read"
  ]),
  capabilityRegistryVersion: "growth-capabilities.v1"
});

test("advisor tools extend the existing quote tools and writes remain sequential", () => {
  const tools = createAcquisitionAgentTools({
    identity,
    executor: {
      async execute() {
        throw new Error("unused");
      }
    },
    audit: new InMemoryAcquisitionToolAuditLedger(),
    auditSecret: "growth-advisor-tools-test-secret-at-least-32-characters"
  });
  assert.deepEqual(
    tools
      .filter((tool) => ADVISOR_TOOL_NAMES.includes(tool.name as never))
      .map((tool) => [tool.name, tool.executionMode]),
    [
      ["get_growth_performance", "parallel"],
      ["list_financial_data_gaps", "parallel"],
      ["create_advisor_recommendation", "sequential"],
      ["create_sales_todo", "sequential"],
      ["record_recommendation_outcome", "sequential"]
    ]
  );
});

function ledgerFixture() {
  const calls: Array<{ toolName: string; idempotencyKey: string }> = [];
  const storedEnvelopes: GrowthAdvisorToolResultEnvelope[] = [];
  const ledger: AcquisitionToolResultLedgerPort = {
    async executeOnce<T>(input, operation) {
      calls.push({
        toolName: input.toolName,
        idempotencyKey: input.idempotencyKey
      });
      const value = await operation();
      if (value && typeof value === "object"
        && (value as { kind?: string }).kind
          === "growth_advisor_tool_result") {
        const envelope = value as GrowthAdvisorToolResultEnvelope;
        if (!storedEnvelopes.some((stored) =>
          stored.stableCallHash === envelope.stableCallHash)) {
          storedEnvelopes.push(structuredClone(envelope));
        }
      }
      return value;
    }
  };
  return { calls, storedEnvelopes, ledger };
}

function toolPortsFixture() {
  const calls: Array<{
    name: string;
    input: unknown;
    stableCallHash: string;
  }> = [];
  const ports: GrowthCommercialToolPorts = {
    register() {},
    async execute(call) {
      calls.push({
        name: call.name,
        input: call.input,
        stableCallHash: call.stableCallHash
      });
      if (call.name === "get_growth_performance") {
        return {
          cohortId: "cohort-1",
          currency: "CNY",
          planId: null,
          dataAsOf: "2026-08-09T08:00:00.000Z",
          expectedRoiByCurrency: [{
            currency: "CNY",
            status: "computed",
            reason: null,
            roiBps: 10_000,
            formulaVersion: "expected-gross-profit-roi.v1",
            amountVisibility: "full",
            probabilityWeightedGrossProfitMinor: 1_000_000,
            attributedEstimatedCostMinor: 500_000
          }],
          actualRoiByCurrency: [],
          cashByCurrency: [],
          dataGaps: [],
          formulaVersion: "growth-performance.v1"
        };
      }
      return { value: { id: "receipt-1" }, replayed: false };
    }
  };
  return { calls, ports };
}

test("advisor Growth replay bypasses the generic outer cache and applies current projection", async () => {
  const { calls, ports } = toolPortsFixture();
  const { calls: ledgerCalls, ledger, storedEnvelopes } = ledgerFixture();
  const executor = new GrowthAdvisorToolExecutor({
    toolPorts: ports,
    resultLedger: ledger,
    now: () => "2026-08-09T09:00:00.000Z"
  });
  const call = {
    name: "get_growth_performance" as const,
    input: { currency: "CNY", asOf: "2026-08-09T08:00:00.000Z" },
    stableCallHash: `sha256:${"a".repeat(64)}`
  };
  const first = await executor.executeResolved(call, managerContext, {
    identity,
    idempotencyKey: "stable-growth-read"
  });
  assert.equal(
    (first as { expectedRoiByCurrency: Array<{ amountVisibility: string }> })
      .expectedRoiByCurrency[0]?.amountVisibility,
    "full"
  );
  const downgraded: ActiveWorkspaceContext = Object.freeze({
    ...managerContext,
    capabilities: Object.freeze([
      "catalog.read",
      "growth.performance.team.read"
    ])
  });
  const replay = await executor.executeResolved(call, downgraded, {
    identity,
    idempotencyKey: "stable-growth-read"
  });
  assert.equal(
    (replay as { expectedRoiByCurrency: Array<{
      amountVisibility: string;
      probabilityWeightedGrossProfitMinor?: number;
    }> }).expectedRoiByCurrency[0]?.amountVisibility,
    "redacted"
  );
  assert.equal(
    "probabilityWeightedGrossProfitMinor" in (
      replay as { expectedRoiByCurrency: Array<Record<string, unknown>> }
    ).expectedRoiByCurrency[0]!,
    false
  );
  assert.equal(storedEnvelopes.length, 1);
  assert.equal(ledgerCalls.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.stableCallHash, `sha256:${"a".repeat(64)}`);
});

test("projector refuses base capability loss and re-reads the frozen snapshot", async () => {
  const projector = new GrowthAdvisorToolReplayProjector();
  const envelope: GrowthAdvisorToolResultEnvelope = {
    kind: "growth_advisor_tool_result",
    toolName: "get_growth_performance",
    workspaceId: "team-1",
    dataAsOf: "2026-08-09T08:00:00.000Z",
    authorityRefs: Object.freeze([]),
    internalSnapshot: Object.freeze({
      expectedRoiByCurrency: Object.freeze([]),
      actualRoiByCurrency: Object.freeze([])
    }),
    modelSnapshotRef: null,
    promptSnapshotRef: null,
    toolSchemaVersion: "growth-advisor-tool.v1",
    stableCallHash: `sha256:${"a".repeat(64)}`
  };
  const forbidden: ActiveWorkspaceContext = Object.freeze({
    ...managerContext,
    capabilities: Object.freeze(["catalog.read"])
  });
  assert.throws(
    () => projector.authorizeAndProjectCached(forbidden, envelope),
    /FORBIDDEN/u
  );
  const crossWorkspace = Object.freeze({
    ...managerContext,
    workspaceId: "other-workspace",
    teamId: "other-workspace"
  });
  assert.throws(
    () => projector.authorizeAndProjectCached(crossWorkspace, envelope),
    /FORBIDDEN/u
  );
});

test("one composite delegates twelve disjoint Growth names before the outer cache", async () => {
  const quoteCalls: string[] = [];
  const advisorCalls: string[] = [];
  const quoteDelegate: GrowthAcquisitionToolDelegate = {
    owns(name) {
      return ["list_catalog_items", "get_pricing_policy", "preview_quote",
        "create_quote_draft", "list_pending_quote_approvals",
        "get_quote_decision", "create_quote_approval_task"].includes(name);
    },
    async execute(input) {
      quoteCalls.push(input.toolName);
      return { delegated: "quote" };
    }
  };
  const advisorDelegate: GrowthAcquisitionToolDelegate = {
    owns(name) {
      return ADVISOR_TOOL_NAMES.includes(name as never);
    },
    async execute(input) {
      advisorCalls.push(input.toolName);
      return { delegated: "advisor" };
    }
  };
  const composite = composeGrowthAcquisitionToolDelegates(
    quoteDelegate, advisorDelegate
  );
  const names = [
    "list_catalog_items", "get_pricing_policy", "preview_quote",
    "create_quote_draft", "list_pending_quote_approvals",
    "get_quote_decision", "create_quote_approval_task",
    ...ADVISOR_TOOL_NAMES
  ];
  for (const name of names) {
    assert.equal(composite.owns(name), true);
    await composite.execute(toolInput(name));
  }
  assert.equal(quoteCalls.length, 7);
  assert.equal(advisorCalls.length, 5);
  const overlapping = {
    owns(name: string) {
      return name === "list_catalog_items";
    },
    async execute() {
      return null;
    }
  };
  assert.throws(
    () => composeGrowthAcquisitionToolDelegates(quoteDelegate, overlapping),
    /GROWTH_TOOL_DELEGATE_OWNERSHIP_OVERLAP/u
  );
});

function toolInput(name: string): AcquisitionToolExecutionInput {
  return {
    identity,
    toolName: name as never,
    toolCallId: "call-1",
    idempotencyKey: "key-1",
    payload: {}
  };
}

test("advisor delegate requires a trusted session and concrete workspace", async () => {
  const delegate = new GrowthAdvisorAcquisitionToolDelegate({
    workspaceResolver: {
      async resolve() {
        return {
          workspaceId: "team-1",
          kind: "team",
          bindingRevision: "binding-1",
          ownerId: identity.ownerId,
          teamId: identity.teamId
        };
      }
    } as never,
    sessions: {
      async findSession() {
        return undefined;
      }
    } as never,
    async resolveCurrentActor() {
      return {
        id: identity.actorId,
        teamId: identity.teamId,
        role: "sales",
        status: "active",
        capabilities: Object.freeze(["catalog.read"]),
        capabilityRegistryVersion: "growth-capabilities.v1"
      };
    },
    executor: {
      async executeResolved() {
        return { ok: true };
      }
    } as never
  });
  await assert.rejects(
    delegate.execute(toolInput("create_sales_todo")),
    /invalid_copilot_identity/u
  );
  assert.equal(delegate.owns("get_growth_performance"), true);
  assert.equal(delegate.owns("approve_quote"), false);
});
