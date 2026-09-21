import assert from "node:assert/strict";
import test from "node:test";
import {
  FinancialCouncilModelRoutingService
} from "./financial-council-model-routing-service.js";
import {
  createFinancialCouncilModelRoutingPolicyVersion,
  type FinancialCouncilModelRoutingPolicyInput
} from "./financial-council-model-routing.js";
import { InMemoryFinancialCouncilModelRoutingRepository } from
  "./financial-council-model-routing-repository.js";
import { workspace } from "./financial-council-repository-contract-test.js";

const NOW = "2026-08-23T08:00:00.000Z";
const ROLES = ["cfo", "finance", "profit", "cost", "cashflow", "tax"] as const;

function input(primaryConnectionId: string | null = null):
FinancialCouncilModelRoutingPolicyInput {
  return Object.freeze({
    roles: Object.freeze(Object.fromEntries(ROLES.map((role) => [role,
      Object.freeze(primaryConnectionId === null ? {
        mode: "auto", primaryConnectionId: null, fallbackConnectionIds: [],
        preferenceWeightBps: 0
      } : {
        mode: "pinned", primaryConnectionId, fallbackConnectionIds: [],
        preferenceWeightBps: 0
      })])) as FinancialCouncilModelRoutingPolicyInput["roles"]),
    maxRunBudgetMinor: 10_000,
    maxRoleBudgetMinor: 1_000,
    requestTimeoutMs: 30_000
  });
}

function connection(id: string, teamId = "ws-1") {
  return Object.freeze({
    id, ownerId: "owner-1", teamId, provider: "deepseek" as const,
    model: "deepseek-chat", credentialVersion: 1,
    capabilitySnapshot: Object.freeze({ structuredOutput: true,
      toolCalling: false, parallelToolCalling: false, streaming: false,
      modelListing: false }),
    capabilityCertificationHash: `sha256:${"a".repeat(64)}`,
    status: "active" as const, createdAt: NOW, updatedAt: NOW
  });
}

test("routing service creates a scoped version and previews without provider calls", async () => {
  const context = Object.freeze({ ...workspace("ws-1"), role: "admin" as const,
    capabilities: Object.freeze(["finance.council.run" as const,
      "finance.council.policy.manage" as const]) });
  let providerCalls = 0;
  const service = new FinancialCouncilModelRoutingService({
    repository: new InMemoryFinancialCouncilModelRoutingRepository(),
    runtimeState: () => ({ connections: [connection("connection-1")],
      recentCalls: [] }),
    now: () => NOW,
    ids: { next: () => "routing-policy-1" },
    providerCall: () => { providerCalls += 1; }
  } as never);
  const created = await service.put({
    workspace: context, actorId: context.actorId,
    idempotencyKey: "routing-key-1", requestHash: `sha256:${"b".repeat(64)}`,
    expectedRevision: null
  }, input());
  assert.equal(created.value.revision, 1);
  assert.equal(created.replayed, false);
  const preview = await service.preview(context);
  assert.deepEqual(preview.map((item) => item.role), ROLES);
  assert.equal(preview[0]?.selectedConnection?.connectionId, "connection-1");
  assert.equal(preview[0]?.selectedConnection?.displayName, "deepseek-chat");
  assert.equal(providerCalls, 0);
});

test("routing service rejects a browser-selected connection outside server scope", async () => {
  const context = Object.freeze({ ...workspace("ws-1"), role: "admin" as const,
    capabilities: Object.freeze(["finance.council.run" as const,
      "finance.council.policy.manage" as const]) });
  const repository = new InMemoryFinancialCouncilModelRoutingRepository();
  const service = new FinancialCouncilModelRoutingService({
    repository,
    runtimeState: () => ({ connections: [connection("other", "ws-2")],
      recentCalls: [] }), now: () => NOW, ids: { next: () => "policy-1" }
  });
  await assert.rejects(service.put({ workspace: context,
    actorId: context.actorId, idempotencyKey: "routing-key-2",
    requestHash: `sha256:${"c".repeat(64)}`, expectedRevision: null
  }, input("other")), { code: "financial_council_model_connection_ineligible" });
});
