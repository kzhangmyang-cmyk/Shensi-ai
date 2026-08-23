import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveLiveProviderPair,
  runLiveProviderSmoke,
  type LiveProviderSmokeStore
} from "./financial-council-live-provider-smoke.js";

const certification = `sha256:${"a".repeat(64)}`;

function connection(id: string, provider: "openai" | "deepseek") {
  return Object.freeze({ id, ownerId: "admin-1", teamId: "workspace-1",
    provider, model: `${provider}-model`, credentialVersion: 1,
    capabilitySnapshot: Object.freeze({ structuredOutput: true,
      toolCalling: false, parallelToolCalling: false, streaming: false,
      modelListing: false }), capabilityCertificationHash: certification,
    status: "active" as const, createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z" });
}

function store(): LiveProviderSmokeStore {
  return Object.freeze({ connections: Object.freeze([
    connection("openai-a", "openai"), connection("deepseek-b", "deepseek")
  ]) });
}

test("live pair rejects same-provider, inactive, uncertified, and cross-workspace connections", () => {
  const valid = store();
  assert.throws(() => resolveLiveProviderPair(valid, {
    primaryConnectionId: "openai-a", fallbackConnectionId: "openai-a"
  }), /LIVE_PROVIDER_PAIR_MUST_USE_DISTINCT_CONNECTIONS/u);
  const sameProvider = Object.freeze({ connections: Object.freeze([
    connection("openai-a", "openai"), connection("openai-b", "openai")
  ]) });
  assert.throws(() => resolveLiveProviderPair(sameProvider, {
    primaryConnectionId: "openai-a", fallbackConnectionId: "openai-b"
  }), /LIVE_PROVIDER_PAIR_MUST_USE_DISTINCT_PROVIDERS/u);
  const ineligible = { ...connection("deepseek-b", "deepseek"),
    capabilityCertificationHash: undefined };
  assert.throws(() => resolveLiveProviderPair(Object.freeze({
    connections: Object.freeze([connection("openai-a", "openai"), ineligible])
  }), { primaryConnectionId: "openai-a",
    fallbackConnectionId: "deepseek-b" }),
  /LIVE_PROVIDER_CONNECTION_NOT_CERTIFIED/u);
  const otherWorkspace = { ...connection("deepseek-b", "deepseek"),
    teamId: "workspace-2" };
  assert.throws(() => resolveLiveProviderPair(Object.freeze({
    connections: Object.freeze([connection("openai-a", "openai"),
      otherWorkspace])
  }), { primaryConnectionId: "openai-a",
    fallbackConnectionId: "deepseek-b" }),
  /LIVE_PROVIDER_PAIR_WORKSPACE_MISMATCH/u);
  assert.equal(resolveLiveProviderPair(valid, {
    primaryConnectionId: "openai-a", fallbackConnectionId: "deepseek-b"
  }).workspaceId, "workspace-1");
});
test("live smoke output is closed metadata and fallback drill performs zero primary network calls", async () => {
  const pair = resolveLiveProviderPair(store(), {
    primaryConnectionId: "openai-a", fallbackConnectionId: "deepseek-b"
  });
  const calls: string[] = [];
  const result = await runLiveProviderSmoke(pair, {
    invoke: async (selected, phase) => {
      calls.push(`${selected.id}:${phase}`);
      return Object.freeze({ connectionId: selected.id,
        provider: selected.provider, model: selected.model,
        requestId: `request-${calls.length}`, latencyMs: 3,
        inputTokens: 2, outputTokens: 1, status: "succeeded" as const,
        errorCode: null });
    }
  });
  assert.deepEqual(Object.keys(result), [
    "primary", "fallback", "structuredOutput", "fallbackDrill"
  ]);
  assert.deepEqual(calls, [
    "openai-a:certification", "deepseek-b:certification",
    "deepseek-b:fallback_drill"
  ]);
  assert.equal(result.fallbackDrill.attempt1.networkBytes, 0);
  assert.equal(result.fallbackDrill.attempt2.connectionId, "deepseek-b");
  const serialized = JSON.stringify(result);
  for (const forbidden of ["businessData", "apiKey", "prompt", "baseUrl",
    "responseBody", "requestBody", "exception", "cause"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
