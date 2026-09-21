import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  bindAiSearchJobModelSnapshot
} from "./prospect-run-queue-bridge.js";
import {
  createAiSearchProvider,
  resolveAiSearchProviderFromSnapshot
} from "./ai-search-provider.js";
import {
  encryptAiModelApiKey
} from "./credential-security.js";
import type { CrmStore } from "./store.js";
import type { AiModelConfig } from "./types.js";

const now = "2026-07-23T11:00:00.000Z";
const boundAiSearchQuery = {
  goal: "find buyers",
  productKeywords: "lighting",
  countries: "China",
  industry: "manufacturing",
  customerType: "buyer",
  excludeKeywords: "",
  limit: 3
};

function officialConfig(
  id: string,
  enabled: boolean
): AiModelConfig {
  return {
    id,
    provider: "moonshot",
    protocol: "openai-compatible",
    name: id,
    baseUrl: `https://${id}.example/v1`,
    model: `${id}-model`,
    apiKey: "",
    enabled,
    temperature: 0.1,
    useLeadFinder: true,
    useWebsiteParse: false,
    useScoring: false,
    useEmailDraft: false,
    useExam: false,
    lastTestStatus: "passed",
    lastTestMessage: "",
    ownerId: "u1",
    teamId: "t1",
    credentialVersion: enabled ? 4 : 8,
    capabilitySnapshot: {
      structuredOutput: true,
      toolCalling: true,
      parallelToolCalling: false,
      streaming: true,
      modelListing: true
    },
    createdAt: now,
    updatedAt: now
  };
}

test("queue bridge binds ai_search child jobs to one immutable model snapshot", () => {
  const store = {
    aiModelConfigs: [
      officialConfig("active", true),
      officialConfig("inactive", false)
    ],
    aiJobModelSnapshots: [],
    pendingAiJobModelSnapshots: []
  } as unknown as CrmStore;
  const first = bindAiSearchJobModelSnapshot(store, {
    providerCode: "ai_search",
    jobId: "job_ai_search",
    ownerId: "u1",
    teamId: "t1",
    query: boundAiSearchQuery
  });
  store.aiModelConfigs[0].enabled = false;
  store.aiModelConfigs[1].enabled = true;
  const retry = bindAiSearchJobModelSnapshot(store, {
    providerCode: "ai_search",
    jobId: "job_ai_search",
    ownerId: "u1",
    teamId: "t1",
    query: boundAiSearchQuery
  });

  assert.deepEqual(retry, first);
  assert.equal(first?.connectionId, "active");
  assert.equal(first?.credentialVersion, 4);
  assert.equal(first?.baseUrl, "https://active.example/v1");
  assert.equal(first?.promptVersion, "ai-search.v1");
  assert.equal(first?.schemaVersion, "ai-search-result.v1");
  assert.match(first?.promptHash || "", /^sha256:[0-9a-f]{64}$/);
  assert.match(first?.schemaHash || "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(store.aiJobModelSnapshots.length, 1);
  assert.equal(store.pendingAiJobModelSnapshots.length, 1);
});

test("queue bridge ignores enabled legacy configs when selecting the official lead-finder model", () => {
  const legacy = {
    ...officialConfig("legacy", true),
    provider: "custom-openai-compatible"
  };
  const official = officialConfig("official", true);
  const store = {
    aiModelConfigs: [legacy, official],
    aiJobModelSnapshots: [],
    pendingAiJobModelSnapshots: []
  } as unknown as CrmStore;

  const snapshot = bindAiSearchJobModelSnapshot(store, {
    providerCode: "ai_search",
    jobId: "job_official_ai_search",
    ownerId: "u1",
    teamId: "t1",
    query: boundAiSearchQuery
  });

  assert.equal(snapshot?.connectionId, "official");
  assert.equal(snapshot?.provider, "moonshot");
});

test("queue bridge rejects multiple active official lead-finder models", () => {
  const store = {
    aiModelConfigs: [
      officialConfig("active-a", true),
      officialConfig("active-b", true)
    ],
    aiJobModelSnapshots: [],
    pendingAiJobModelSnapshots: []
  } as unknown as CrmStore;

  assert.throws(
    () => bindAiSearchJobModelSnapshot(store, {
      providerCode: "ai_search",
      jobId: "job_ambiguous_ai_search",
      ownerId: "u1",
      teamId: "t1",
      query: boundAiSearchQuery
    }),
    /multiple|ambiguous|多个|唯一/i
  );
  assert.equal(store.aiJobModelSnapshots.length, 0);
});

test("queue bridge does not create model snapshots for non-AI providers", () => {
  const store = {
    aiModelConfigs: [],
    aiJobModelSnapshots: [],
    pendingAiJobModelSnapshots: []
  } as unknown as CrmStore;
  assert.equal(bindAiSearchJobModelSnapshot(store, {
    providerCode: "serper",
    jobId: "job_serper",
    ownerId: "u1",
    teamId: "t1"
  }), null);
  assert.equal(store.aiJobModelSnapshots.length, 0);
});

test("worker resolves ai_search from the child job snapshot instead of live active config", () => {
  const active = officialConfig("active", true);
  const next = officialConfig("next", false);
  const store = {
    aiModelConfigs: [active, next],
    aiJobModelSnapshots: [],
    pendingAiJobModelSnapshots: [],
    prospectRunQueueChildBindings: [{
      id: "binding_1",
      teamId: "t1",
      runId: "run_1",
      shardId: "shard_1",
      ownerId: "u1",
      jobId: "job_ai_search",
      jobType: "prospect.provider.fetch",
      parentJobId: "job_parent",
      bridgeVersion: "v1",
      executionSnapshotHash: "sha256:run",
      bindingHash: "sha256:binding",
      createdAt: now
    }]
  } as unknown as CrmStore;
  const snapshot = bindAiSearchJobModelSnapshot(store, {
    providerCode: "ai_search",
    jobId: "job_ai_search",
    ownerId: "u1",
    teamId: "t1",
    query: boundAiSearchQuery
  });
  assert.ok(snapshot);
  store.pendingAiJobModelSnapshots.splice(0);
  active.enabled = false;
  active.baseUrl = "https://mutated.invalid/v1";
  next.enabled = true;

  const resolved = resolveAiSearchProviderFromSnapshot(store, {
    providerCode: "ai_search",
    runId: "run_1",
    shardId: "shard_1",
    ownerId: "u1",
    teamId: "t1"
  });

  assert.ok(resolved);
  assert.equal(resolved.provider.defaultBaseUrl, "https://active.example/v1");
  assert.deepEqual(resolved.credential, {
    apiKey: "",
    baseUrl: "https://active.example/v1"
  });
});

test("worker refuses ai_search dispatch without its immutable child-job snapshot", () => {
  const store = {
    aiModelConfigs: [officialConfig("active", true)],
    aiJobModelSnapshots: [],
    pendingAiJobModelSnapshots: [],
    prospectRunQueueChildBindings: [{
      id: "binding_1",
      teamId: "t1",
      runId: "run_1",
      shardId: "shard_1",
      ownerId: "u1",
      jobId: "job_missing_snapshot",
      jobType: "prospect.provider.fetch",
      parentJobId: "job_parent",
      bridgeVersion: "v1",
      executionSnapshotHash: "sha256:run",
      bindingHash: "sha256:binding",
      createdAt: now
    }]
  } as unknown as CrmStore;

  assert.equal(resolveAiSearchProviderFromSnapshot(store, {
    providerCode: "ai_search",
    runId: "run_1",
    shardId: "shard_1",
    ownerId: "u1",
    teamId: "t1"
  }), undefined);
});

function executableAiSearchStore() {
  const active = officialConfig("active", true);
  const store = {
    aiModelConfigs: [active],
    modelCredentialVersions: [{
      connectionId: active.id,
      provider: "moonshot",
      ownerId: active.ownerId,
      teamId: active.teamId,
      version: active.credentialVersion,
      credentialRef: "credential_active_v4",
      apiKeyEncrypted: encryptAiModelApiKey({
        id: active.id,
        provider: active.provider,
        ownerId: active.ownerId,
        teamId: active.teamId
      }, "sk-active-v4"),
      keyMask: "e-v4",
      createdBy: active.ownerId,
      createdAt: now
    }],
    aiJobModelSnapshots: [],
    pendingAiJobModelSnapshots: [],
    modelCallRecords: [],
    pendingModelCallRecords: [],
    async persist(this: CrmStore) {
      this.pendingAiJobModelSnapshots.splice(0);
      this.pendingModelCallRecords.splice(0);
    }
  } as unknown as CrmStore;
  return { active, store };
}

test("AI search rejects prompt drift from its immutable job snapshot before HTTP", async () => {
  const { store } = executableAiSearchStore();
  const snapshot = bindAiSearchJobModelSnapshot(store, {
    providerCode: "ai_search",
    jobId: "job_ai_search_prompt_drift",
    ownerId: "u1",
    teamId: "t1",
    query: boundAiSearchQuery
  });
  assert.ok(snapshot);
  await store.persist();
  let networkCalls = 0;
  const provider = createAiSearchProvider(store, snapshot);

  await assert.rejects(
    provider.search!(
      {
        query: {
          goal: "tampered goal",
          productKeywords: ["lighting"],
          countries: ["China"],
          industries: ["manufacturing"],
          customerTypes: ["buyer"],
          excludeKeywords: [],
          limit: 3
        },
        cursor: ""
      },
      { apiKey: "", baseUrl: snapshot.baseUrl },
      {
        http: {
          async fetch() {
            networkCalls += 1;
            return new Response(JSON.stringify({
              choices: [{
                message: { content: "{\"companies\":[]}" },
                finish_reason: "stop"
              }]
            }), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
        }
      }
    ),
    /content hash|内容哈希|MODEL_CONTENT_HASH_MISMATCH/i
  );
  assert.equal(networkCalls, 0);
});

test("AI search accepts null for optional model result strings", async () => {
  const { store } = executableAiSearchStore();
  const snapshot = bindAiSearchJobModelSnapshot(store, {
    providerCode: "ai_search",
    jobId: "job_ai_search_nullable_result",
    ownerId: "u1",
    teamId: "t1",
    query: boundAiSearchQuery
  });
  assert.ok(snapshot);
  await store.persist();
  let networkCalls = 0;
  const provider = createAiSearchProvider(store, snapshot);
  const result = await provider.search!(
    {
      query: {
        goal: "find buyers",
        productKeywords: ["lighting"],
        countries: ["China"],
        industries: ["manufacturing"],
        customerTypes: ["buyer"],
        excludeKeywords: [],
        limit: 3
      },
      cursor: ""
    },
    { apiKey: "", baseUrl: snapshot.baseUrl },
    {
      http: {
        async fetch() {
          networkCalls += 1;
          return new Response(JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  companies: [{
                    company: "Nullable Lighting",
                    website: null,
                    country: null,
                    business: null,
                    description: null
                  }]
                })
              },
              finish_reason: "stop"
            }]
          }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      }
    }
  );

  assert.equal(networkCalls, 1);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].officialWebsite, "");
  assert.equal(result.records[0].country, "China");
  assert.equal(result.records[0].business, "lighting");
});

test("AI search reports provider and audit persistence failures together", async () => {
  const active = officialConfig("active", true);
  const store = {
    aiModelConfigs: [active],
    modelCredentialVersions: [{
      connectionId: active.id,
      provider: "moonshot",
      ownerId: active.ownerId,
      teamId: active.teamId,
      version: active.credentialVersion,
      credentialRef: "credential_active_v4",
      apiKeyEncrypted: encryptAiModelApiKey({
        id: active.id,
        provider: active.provider,
        ownerId: active.ownerId,
        teamId: active.teamId
      }, "sk-active-v4"),
      keyMask: "e-v4",
      createdBy: active.ownerId,
      createdAt: now
    }],
    aiJobModelSnapshots: [],
    pendingAiJobModelSnapshots: [],
    modelCallRecords: [],
    pendingModelCallRecords: [],
    async persist() {
      throw new Error("AI search audit database unavailable");
    }
  } as unknown as CrmStore;
  const snapshot = bindAiSearchJobModelSnapshot(store, {
    providerCode: "ai_search",
    jobId: "job_ai_search_dual_failure",
    ownerId: "u1",
    teamId: "t1",
    query: boundAiSearchQuery
  });
  assert.ok(snapshot);
  store.pendingAiJobModelSnapshots.splice(0);
  const provider = createAiSearchProvider(store, snapshot);

  await assert.rejects(
    provider.search!(
      {
        query: {
          goal: "find buyers",
          productKeywords: ["lighting"],
          countries: ["China"],
          industries: ["manufacturing"],
          customerTypes: ["buyer"],
          excludeKeywords: [],
          limit: 3
        },
        cursor: ""
      },
      { apiKey: "", baseUrl: snapshot.baseUrl },
      {
        http: {
          async fetch() {
            return new Response(
              JSON.stringify({ error: { message: "provider unavailable" } }),
              {
                status: 503,
                headers: { "content-type": "application/json" }
              }
            );
          }
        }
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /503|provider|服务/i);
      assert.match(
        String(error.errors[1]),
        /AI search audit database unavailable/
      );
      return true;
    }
  );
  assert.equal(store.modelCallRecords.length, 1);
  assert.equal(store.modelCallRecords[0].status, "failed");
});

test("production AI search paths cannot regress to live-config direct model HTTP", () => {
  const serverSource = readFileSync(
    new URL("./server.ts", import.meta.url),
    "utf8"
  );
  const workerSource = readFileSync(
    new URL("./prospect-worker-service.ts", import.meta.url),
    "utf8"
  );

  assert.match(
    serverSource,
    /from "\.\/ai-model-runtime\.js"/
  );
  assert.doesNotMatch(
    serverSource,
    /\nasync function callAiModel\(/
  );
  assert.doesNotMatch(
    serverSource,
    /\nasync function aiGenerateLeads\(/
  );
  assert.doesNotMatch(
    serverSource,
    /createAiHttpClient/
  );
  assert.match(
    workerSource,
    /resolveAiSearchProviderFromSnapshot\(this\.store, request\)/
  );
  assert.doesNotMatch(
    workerSource,
    /this\.store\.aiModelConfigs/
  );
});
