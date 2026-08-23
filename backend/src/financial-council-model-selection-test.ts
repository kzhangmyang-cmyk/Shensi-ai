import assert from "node:assert/strict";
import test from "node:test";
import {
  RepositoryFinancialCouncilModelSelectionPort
} from "./financial-council-model-selection.js";
import { createFinancialCouncilModelRoutingPolicyVersion } from
  "./financial-council-model-routing.js";
import { repositoryRunFixture, workspace } from
  "./financial-council-repository-contract-test.js";
import type { ModelConnection } from "./model-providers/types.js";

const HASH = `sha256:${"a".repeat(64)}`;

function connection(id: string, status: "active" | "inactive" = "active"):
ModelConnection {
  return { id, ownerId: "manager-1", teamId: "ws-1", provider: "openai",
    model: "model", credentialVersion: 1, capabilitySnapshot: {
      structuredOutput: true, toolCalling: false, parallelToolCalling: false,
      streaming: false, modelListing: false },
    capabilityCertificationHash: HASH, status,
    createdAt: "2026-08-23T08:00:00.000Z",
    updatedAt: "2026-08-23T08:00:00.000Z" };
}

function policy(id: string, primary = "primary", fallbacks = ["fallback"]) {
  const auto = { mode: "auto" as const, primaryConnectionId: null,
    fallbackConnectionIds: [] as string[], preferenceWeightBps: 0 };
  return createFinancialCouncilModelRoutingPolicyVersion({
    policyVersionId: id, workspaceId: "ws-1", revision: id === "frozen" ? 1 : 2,
    status: id === "frozen" ? "superseded" : "active",
    input: { roles: { cfo: auto, finance: { mode: "pinned",
      primaryConnectionId: primary, fallbackConnectionIds: fallbacks,
      preferenceWeightBps: 0 }, profit: auto, cost: auto, cashflow: auto,
      tax: auto }, maxRunBudgetMinor: 100, maxRoleBudgetMinor: 50,
      requestTimeoutMs: 60_000 }, createdBy: "actor-1",
    createdAt: id === "frozen" ? "2026-08-23T08:00:00.000Z"
      : "2026-08-23T09:00:00.000Z"
  });
}

test("selection uses the run frozen policy and filters current eligibility", async () => {
  const activeWorkspace = workspace();
  const run = repositoryRunFixture({ modelRoutingPolicyVersionId: "frozen" });
  const selection = new RepositoryFinancialCouncilModelSelectionPort({
    repository: {
      async findRun() { return run; },
      async getAnalysisControl() { return { workspaceId: "ws-1", runId: run.runId,
        ownerId: "manager-1", teamId: "ws-1", lease: null,
        createdAt: run.createdAt }; }
    } as never,
    routingRepository: {
      async getCurrent() { return policy("current", "wrong-current", []); },
      async getVersion(_context, id) { return id === "frozen"
        ? policy("frozen") : null; }
    } as never,
    runtimeState: () => ({ connections: [connection("primary", "inactive"),
      connection("fallback")], recentCalls: [] })
  });
  const value = await selection.resolve({ workspace: activeWorkspace,
    ownerId: "manager-1", teamId: "ws-1", runId: run.runId, role: "finance",
    phase: "analyze" });
  assert.equal(value.routingPolicyVersionId, "frozen");
  assert.deepEqual(value.orderedConnectionIds, ["fallback"]);
});

test("selection rejects mismatched control and missing frozen policy before routing",
  async () => {
    const activeWorkspace = workspace();
    const run = repositoryRunFixture({ modelRoutingPolicyVersionId: "missing" });
    const create = (ownerId: string) =>
      new RepositoryFinancialCouncilModelSelectionPort({
        repository: { async findRun() { return run; },
          async getAnalysisControl() { return { workspaceId: "ws-1",
            runId: run.runId, ownerId, teamId: "ws-1", lease: null,
            createdAt: run.createdAt }; } } as never,
        routingRepository: { async getVersion() { return null; } } as never,
        runtimeState: () => ({ connections: [connection("primary")],
          recentCalls: [] })
      });
    await assert.rejects(create("attacker").resolve({ workspace: activeWorkspace,
      ownerId: "manager-1", teamId: "ws-1", runId: run.runId, role: "finance",
      phase: "analyze" }));
    await assert.rejects(create("manager-1").resolve({ workspace: activeWorkspace,
      ownerId: "manager-1", teamId: "ws-1", runId: run.runId, role: "finance",
      phase: "analyze" }), (error: unknown) =>
      (error as { code?: unknown }).code
        === "not_computable:model_connection_unavailable");
  });
