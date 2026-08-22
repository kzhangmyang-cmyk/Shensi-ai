import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { encryptAiModelApiKey } from "./credential-security.js";
import {
  bindActiveModelSnapshot,
  bindActiveModelSnapshotDurably,
  createActiveModelGatewayForSnapshot,
  createStoreModelCallLedger,
  resolveSnapshottedModelCredential
} from "./model-providers/runtime.js";
import type {
  ModelRuntimeStore
} from "./model-providers/runtime.js";
import type { AiModelConfig } from "./types.js";
import {
  callAiModelWithRuntime
} from "./ai-model-runtime.js";
import {
  setProviderHttpTestTransport
} from "./provider-http-client.js";

const createdAt = "2026-07-23T10:00:00.000Z";
const ownerId = "u_runtime";
const teamId = "t_runtime";
const companiesSchemaHash =
  `sha256:${createHash("sha256")
    .update("companies-schema.v1")
    .digest("hex")}`;

function contentHash(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function config(
  id: string,
  enabled: boolean,
  credentialVersion: number
): AiModelConfig {
  return {
    id,
    provider: "moonshot",
    protocol: "openai-compatible",
    name: id,
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    apiKey: "",
    enabled,
    temperature: 0.1,
    useLeadFinder: true,
    useWebsiteParse: true,
    useScoring: true,
    useEmailDraft: true,
    useExam: false,
    lastTestStatus: "untested",
    lastTestMessage: "",
    ownerId,
    teamId,
    credentialVersion,
    capabilitySnapshot: {
      structuredOutput: true,
      toolCalling: true,
      parallelToolCalling: false,
      streaming: true,
      modelListing: true
    },
    createdAt,
    updatedAt: createdAt
  };
}

function runtimeStore(): ModelRuntimeStore {
  const active = config("conn_active", true, 2);
  const old = config("conn_old", false, 1);
  return {
    aiModelConfigs: [active, old],
    modelCredentialVersions: [
      {
        connectionId: active.id,
        provider: "moonshot",
        ownerId,
        teamId,
        version: 1,
        credentialRef: "cred_active_v1",
        apiKeyEncrypted: encryptAiModelApiKey({
          id: active.id,
          provider: active.provider,
          ownerId,
          teamId
        }, "sk-active-v1"),
        keyMask: "e-v1",
        createdBy: ownerId,
        createdAt
      },
      {
        connectionId: active.id,
        provider: "moonshot",
        ownerId,
        teamId,
        version: 2,
        credentialRef: "cred_active_v2",
        apiKeyEncrypted: encryptAiModelApiKey({
          id: active.id,
          provider: active.provider,
          ownerId,
          teamId
        }, "sk-active-v2"),
        keyMask: "e-v2",
        createdBy: ownerId,
        createdAt
      }
    ],
    aiJobModelSnapshots: [],
    pendingAiJobModelSnapshots: [],
    modelCallRecords: [],
    pendingModelCallRecords: []
  };
}

test("binding an AI job snapshots the active connection once for all retries", () => {
  const store = runtimeStore();
  const first = bindActiveModelSnapshot(store, {
    jobId: "job_search_1",
    ownerId,
    teamId,
    promptVersion: "ai-search.v1",
    schemaVersion: "ai-search-result.v1",
    promptHash: contentHash("private prompt"),
    schemaHash: companiesSchemaHash
  });
  store.aiModelConfigs[0].enabled = false;
  store.aiModelConfigs[1].enabled = true;
  const retry = bindActiveModelSnapshot(store, {
    jobId: "job_search_1",
    ownerId,
    teamId,
    promptVersion: "changed-prompt-must-not-win",
    schemaVersion: "changed-schema-must-not-win",
    promptHash: contentHash("changed prompt"),
    schemaHash: contentHash("changed schema")
  });

  assert.deepEqual(retry, first);
  assert.equal(first.connectionId, "conn_active");
  assert.equal(first.credentialVersion, 2);
  assert.equal(first.promptVersion, "ai-search.v1");
  assert.equal(first.promptHash, contentHash("private prompt"));
  assert.equal(first.schemaHash, companiesSchemaHash);
  assert.equal(first.baseUrl, "https://api.moonshot.cn/v1");
  assert.match(
    first.baseUrlFingerprint || "",
    /^sha256:[0-9a-f]{64}$/
  );
  assert.equal(store.aiJobModelSnapshots.length, 1);
  assert.equal(store.pendingAiJobModelSnapshots.length, 1);
});

test("durable binding persists once and rejects immutable job identity drift", async () => {
  const store = runtimeStore();
  const persisted: string[] = [];
  let releaseFirstPersist!: () => void;
  let markFirstPersistStarted!: () => void;
  const firstPersistStarted = new Promise<void>((resolve) => {
    markFirstPersistStarted = resolve;
  });
  const holdFirstPersist = new Promise<void>((resolve) => {
    releaseFirstPersist = resolve;
  });
  const durableStore = {
    ...store,
    async persist() {
      persisted.push(
        `${this.pendingAiJobModelSnapshots.length}:`
        + `${this.pendingModelCallRecords.length}`
      );
      if (persisted.length === 1) {
        markFirstPersistStarted();
        await holdFirstPersist;
      }
      this.pendingAiJobModelSnapshots.splice(0);
      this.pendingModelCallRecords.splice(0);
    }
  };
  const input = {
    jobId: "job_durable_binding",
    ownerId,
    teamId,
    promptVersion: "financial-council-finance-analyze.v1",
    schemaVersion: "financial-council-specialist-output.v1",
    promptHash: contentHash("financial council prompt"),
    schemaHash: contentHash("financial council schema")
  };

  const firstBinding = bindActiveModelSnapshotDurably(durableStore, input);
  await firstPersistStarted;
  const concurrentReplay = bindActiveModelSnapshotDurably(durableStore, input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const callsBeforeRelease = persisted.length;
  releaseFirstPersist();
  const [first, replay] = await Promise.all([firstBinding, concurrentReplay]);
  assert.equal(replay, first);
  assert.equal(callsBeforeRelease, 1);
  assert.deepEqual(persisted, ["1:0"]);

  await assert.rejects(
    bindActiveModelSnapshotDurably(durableStore, {
      ...input,
      promptHash: contentHash("changed prompt")
    }),
    /immutable identity mismatch/i
  );
  assert.equal(store.aiJobModelSnapshots.length, 1);
});

test("credential resolution decrypts the exact snapshotted version", async () => {
  const store = runtimeStore();
  const snapshot = bindActiveModelSnapshot(store, {
    jobId: "job_credential_resolution",
    ownerId,
    teamId,
    promptVersion: "ai-search.v1",
    schemaVersion: "ai-search-result.v1",
    promptHash: contentHash("private prompt"),
    schemaHash: companiesSchemaHash
  });
  assert.equal(
    await resolveSnapshottedModelCredential(
      store,
      snapshot
    ),
    "sk-active-v2"
  );
  const unavailable = {
    ...snapshot,
    credentialVersion: 9
  };
  await assert.rejects(
    resolveSnapshottedModelCredential(store, unavailable),
    /credential version/i
  );
});

test("store ledger is append-only and queues only new records", () => {
  const store = runtimeStore();
  const ledger = createStoreModelCallLedger(store, {
    idFactory: () => "model_call_runtime",
    now: () => createdAt
  });
  const stored = ledger.append({
    ownerId,
    teamId,
    jobId: "job_search_1",
    attemptId: "attempt_1",
    connectionId: "conn_active",
    credentialVersion: 2,
    capabilitySnapshotHash: "sha256:capability",
    provider: "moonshot",
    baseUrlFingerprint: "sha256:base",
    model: "moonshot-v1-8k",
    promptVersion: "ai-search.v1",
    schemaVersion: "ai-search-result.v1",
    requestId: "request_1",
    providerRequestId: null,
    inputTokens: 3,
    outputTokens: 2,
    reasoningTokens: 0,
    latencyMs: 5,
    status: "succeeded",
    error: null,
    cost: {
      amountMinor: 0,
      currency: "USD",
      kind: "unknown"
    },
    parameterHash: "sha256:params",
    resultHash: "sha256:result"
  });
  assert.equal(store.modelCallRecords[0], stored);
  assert.equal(store.pendingModelCallRecords[0], stored);
  assert.throws(() => {
    (stored as { status: string }).status = "failed";
  }, TypeError);
});

test("runtime gateway uses the stored snapshot, exact credential, and durable ledger", async () => {
  const store = runtimeStore();
  const snapshot = bindActiveModelSnapshot(store, {
    jobId: "job_search_2",
    ownerId,
    teamId,
    promptVersion: "ai-search.v1",
    schemaVersion: "ai-search-result.v1",
    promptHash: contentHash("private prompt"),
    schemaHash: companiesSchemaHash
  });
  const requests: RequestInit[] = [];
  let requestedUrl = "";
  store.aiModelConfigs[0].baseUrl = "https://changed.invalid/v1";
  const gateway = createActiveModelGatewayForSnapshot(store, {
    storedSnapshot: snapshot,
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requests.push(init || {});
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: "{\"companies\":[]}"
          },
          finish_reason: "stop"
        }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 2
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const result = await gateway.generateStructured({
    prompt: "private prompt",
    schemaHash: companiesSchemaHash,
    schema: (await import("zod")).z.object({
      companies: (await import("zod")).z.array(
        (await import("zod")).z.unknown()
      )
    }).strict()
  });
  assert.deepEqual(result.value, { companies: [] });
  assert.equal(
    requestedUrl,
    "https://api.moonshot.cn/v1/chat/completions"
  );
  const authorization = new Headers(requests[0].headers)
    .get("authorization");
  assert.equal(authorization, "Bearer sk-active-v2");
  assert.equal(store.modelCallRecords.length, 1);
  assert.equal(store.pendingModelCallRecords.length, 1);
  assert.equal(
    JSON.stringify(store.modelCallRecords).includes("private prompt"),
    false
  );
  assert.equal(
    store.modelCallRecords[0].capabilitySnapshotHash,
    `sha256:${createHash("sha256")
      .update(JSON.stringify(snapshot.capabilitySnapshot))
      .digest("hex")}`
  );
});

test("runtime gateway rejects prompt or schema drift before credential resolution and HTTP", async () => {
  const store = runtimeStore();
  const snapshot = bindActiveModelSnapshot(store, {
    jobId: "job_hash_drift",
    ownerId,
    teamId,
    promptVersion: "ai-search.v1",
    schemaVersion: "ai-search-result.v1",
    promptHash: contentHash("frozen prompt"),
    schemaHash: companiesSchemaHash
  });
  let requests = 0;
  const gateway = createActiveModelGatewayForSnapshot(store, {
    storedSnapshot: snapshot,
    fetch: async () => {
      requests += 1;
      return new Response();
    }
  });

  await assert.rejects(
    gateway.generateStructured({
      prompt: "tampered prompt",
      schemaHash: companiesSchemaHash,
      schema: (await import("zod")).z.object({}).strict()
    }),
    /content hash|内容哈希|MODEL_CONTENT_HASH_MISMATCH/i
  );
  await assert.rejects(
    gateway.generateStructured({
      prompt: "frozen prompt",
      schemaHash: contentHash("tampered schema"),
      schema: (await import("zod")).z.object({}).strict()
    }),
    /content hash|内容哈希|MODEL_CONTENT_HASH_MISMATCH/i
  );
  assert.equal(requests, 0);
  assert.equal(store.modelCallRecords.length, 2);
});

test("runtime execution needs only the snapshot and immutable credential version", async () => {
  const store = runtimeStore();
  const snapshot = bindActiveModelSnapshot(store, {
    jobId: "job_without_live_config",
    ownerId,
    teamId,
    promptVersion: "ai-search.v1",
    schemaVersion: "ai-search-result.v1",
    promptHash: contentHash("private prompt"),
    schemaHash: companiesSchemaHash
  });
  store.aiModelConfigs.splice(0);
  const gateway = createActiveModelGatewayForSnapshot(store, {
    storedSnapshot: snapshot,
    fetch: async () => new Response(JSON.stringify({
      choices: [{
        message: { content: "{\"companies\":[]}" },
        finish_reason: "stop"
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  });

  const result = await gateway.generateStructured({
    prompt: "private prompt",
    schemaHash: companiesSchemaHash,
    schema: (await import("zod")).z.object({
      companies: (await import("zod")).z.array(
        (await import("zod")).z.unknown()
      )
    }).strict()
  });

  assert.deepEqual(result.value, { companies: [] });
});

test("snapshot normalizes the endpoint before storage, hashing, and requests", async () => {
  const store = runtimeStore();
  store.aiModelConfigs[0].baseUrl =
    "https://api.moonshot.cn/v1///";
  const snapshot = bindActiveModelSnapshot(store, {
    jobId: "job_normalized_endpoint",
    ownerId,
    teamId,
    promptVersion: "ai-search.v1",
    schemaVersion: "ai-search-result.v1",
    promptHash: contentHash("private prompt"),
    schemaHash: companiesSchemaHash
  });
  assert.equal(snapshot.baseUrl, "https://api.moonshot.cn/v1");
  assert.equal(
    snapshot.baseUrlFingerprint,
    contentHash("https://api.moonshot.cn/v1")
  );
  let requestedUrl = "";
  const gateway = createActiveModelGatewayForSnapshot(store, {
    storedSnapshot: snapshot,
    fetch: async (input) => {
      requestedUrl = String(input);
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
  });
  await gateway.generateStructured({
    prompt: "private prompt",
    schemaHash: companiesSchemaHash,
    schema: (await import("zod")).z.object({
      companies: (await import("zod")).z.array(
        (await import("zod")).z.unknown()
      )
    }).strict()
  });
  assert.equal(
    requestedUrl,
    "https://api.moonshot.cn/v1/chat/completions"
  );
});

function sseResponse(lines: string[]) {
  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

test("runtime stream persists its success ledger before completion", async () => {
  const store = runtimeStore();
  let persistCount = 0;
  const persistedStore = {
    ...store,
    async persist() {
      persistCount += 1;
      this.pendingAiJobModelSnapshots.splice(0);
      this.pendingModelCallRecords.splice(0);
    }
  };
  const prompt = "stream success";
  const snapshot = bindActiveModelSnapshot(persistedStore, {
    jobId: "job_stream_success",
    ownerId,
    teamId,
    promptVersion: "stream.v1",
    schemaVersion: "text-stream.v1",
    promptHash: contentHash(prompt),
    schemaHash: contentHash("text-stream.v1")
  });
  await persistedStore.persist();
  persistCount = 0;
  const gateway = createActiveModelGatewayForSnapshot(persistedStore, {
    storedSnapshot: snapshot,
    fetch: async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}",
      "",
      "data: [DONE]",
      ""
    ])
  });
  const events = [];
  for await (const event of gateway.streamText({
    prompt,
    schemaHash: contentHash("text-stream.v1")
  })) {
    events.push(event);
  }
  assert.deepEqual(events, [
    { type: "text_delta", delta: "ok" },
    { type: "done" }
  ]);
  assert.equal(persistCount, 1);
  assert.equal(store.modelCallRecords.at(-1)?.status, "succeeded");
  assert.equal(store.pendingModelCallRecords.length, 0);
});

test("runtime stream persists provider failures", async () => {
  const store = runtimeStore();
  let persistCount = 0;
  const persistedStore = {
    ...store,
    async persist() {
      persistCount += 1;
      this.pendingAiJobModelSnapshots.splice(0);
      this.pendingModelCallRecords.splice(0);
    }
  };
  const prompt = "stream failure";
  const snapshot = bindActiveModelSnapshot(persistedStore, {
    jobId: "job_stream_failure",
    ownerId,
    teamId,
    promptVersion: "stream.v1",
    schemaVersion: "text-stream.v1",
    promptHash: contentHash(prompt),
    schemaHash: contentHash("text-stream.v1")
  });
  await persistedStore.persist();
  persistCount = 0;
  const gateway = createActiveModelGatewayForSnapshot(persistedStore, {
    storedSnapshot: snapshot,
    fetch: async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("provider stream failed"));
        }
      }),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      }
    )
  });

  await assert.rejects(async () => {
    for await (const _event of gateway.streamText({
      prompt,
      schemaHash: contentHash("text-stream.v1")
    })) {
      // Consume until the provider stream fails.
    }
  });
  assert.equal(persistCount, 1);
  assert.equal(store.modelCallRecords.at(-1)?.status, "failed");
  assert.equal(store.pendingModelCallRecords.length, 0);
});

test("runtime stream persists a consumer cancellation", async () => {
  const store = runtimeStore();
  let persistCount = 0;
  const persistedStore = {
    ...store,
    async persist() {
      persistCount += 1;
      this.pendingAiJobModelSnapshots.splice(0);
      this.pendingModelCallRecords.splice(0);
    }
  };
  const prompt = "stream cancellation";
  const snapshot = bindActiveModelSnapshot(persistedStore, {
    jobId: "job_stream_cancel",
    ownerId,
    teamId,
    promptVersion: "stream.v1",
    schemaVersion: "text-stream.v1",
    promptHash: contentHash(prompt),
    schemaHash: contentHash("text-stream.v1")
  });
  await persistedStore.persist();
  persistCount = 0;
  const encoder = new TextEncoder();
  const gateway = createActiveModelGatewayForSnapshot(persistedStore, {
    storedSnapshot: snapshot,
    fetch: async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"
          ));
        }
      }),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      }
    )
  });
  const iterator = gateway.streamText({
    prompt,
    schemaHash: contentHash("text-stream.v1")
  })[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return?.();

  assert.equal(persistCount, 1);
  assert.equal(
    store.modelCallRecords.at(-1)?.error?.code,
    "MODEL_STREAM_CANCELLED"
  );
  assert.equal(store.pendingModelCallRecords.length, 0);
});

test("runtime stream preserves provider and ledger persistence failures", async () => {
  const store = runtimeStore();
  const prompt = "stream dual failure";
  const persistedStore = {
    ...store,
    async persist() {
      throw new Error("stream audit database unavailable");
    }
  };
  const snapshot = bindActiveModelSnapshot(persistedStore, {
    jobId: "job_stream_dual_failure",
    ownerId,
    teamId,
    promptVersion: "stream.v1",
    schemaVersion: "text-stream.v1",
    promptHash: contentHash(prompt),
    schemaHash: contentHash("text-stream.v1")
  });
  persistedStore.pendingAiJobModelSnapshots.splice(0);
  const gateway = createActiveModelGatewayForSnapshot(persistedStore, {
    storedSnapshot: snapshot,
    fetch: async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("provider stream failed"));
        }
      }),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      }
    )
  });

  await assert.rejects(
    async () => {
      for await (const _event of gateway.streamText({
        prompt,
        schemaHash: contentHash("text-stream.v1")
      })) {
        // Consume until the provider stream fails.
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /MODEL|provider|response/i);
      assert.match(
        String(error.errors[1]),
        /stream audit database unavailable/
      );
      return true;
    }
  );
  assert.equal(store.modelCallRecords.at(-1)?.status, "failed");
  assert.equal(store.pendingModelCallRecords.length, 1);
});

test("official compatibility runtime delegates to the gateway and durable ledger", async () => {
  const store = runtimeStore();
  const ordering: string[] = [];
  const persistedStore = {
    ...store,
    async persist() {
      ordering.push(`persist:${this.pendingAiJobModelSnapshots.length}:`
        + `${this.pendingModelCallRecords.length}`);
      this.pendingAiJobModelSnapshots.splice(0);
      this.pendingModelCallRecords.splice(0);
    }
  };
  const active = store.aiModelConfigs[0];
  const content = await callAiModelWithRuntime(
    persistedStore,
    active,
    "return json",
    4_000,
    async () => {
      ordering.push("fetch");
      return new Response(JSON.stringify({
        choices: [{
          message: { content: "{\"ok\":true}" },
          finish_reason: "stop"
        }],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 1
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },
    {
      jobId: "job_compatibility",
      promptVersion: "legacy-json.v1",
      schemaVersion: "legacy-json-object.v1"
    }
  );
  assert.equal(content, "{\"ok\":true}");
  assert.equal(store.aiJobModelSnapshots.length, 1);
  assert.equal(store.modelCallRecords.length, 1);
  assert.equal(store.modelCallRecords[0].jobId, "job_compatibility");
  assert.deepEqual(ordering, [
    "persist:1:0",
    "fetch",
    "persist:0:1"
  ]);
});

test("compatibility retries keep the snapshotted endpoint after live config mutation", async (t) => {
  const store = runtimeStore();
  const active = store.aiModelConfigs[0];
  let persistCount = 0;
  const persistedStore = {
    ...store,
    async persist() {
      persistCount += 1;
      this.pendingAiJobModelSnapshots.splice(0);
      this.pendingModelCallRecords.splice(0);
      if (persistCount === 1) {
        active.baseUrl = "https://changed.invalid/v1";
      }
    }
  };
  let requestedUrl = "";
  setProviderHttpTestTransport(async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({
      choices: [{
        message: { content: "{\"ok\":true}" },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 1
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  t.after(() => setProviderHttpTestTransport(null));

  const content = await callAiModelWithRuntime(
    persistedStore,
    active,
    "return json",
    4_000,
    undefined,
    {
      jobId: "job_endpoint_retry",
      promptVersion: "legacy-json.v1",
      schemaVersion: "legacy-json-object.v1"
    }
  );

  assert.equal(content, "{\"ok\":true}");
  assert.equal(
    requestedUrl,
    "https://api.moonshot.cn/v1/chat/completions"
  );
  assert.equal(
    store.aiJobModelSnapshots[0].baseUrl,
    "https://api.moonshot.cn/v1"
  );
});

test("compatibility runtime reports provider and audit persistence failures together", async () => {
  const store = runtimeStore();
  let persistCount = 0;
  const persistedStore = {
    ...store,
    async persist() {
      persistCount += 1;
      if (persistCount === 1) {
        this.pendingAiJobModelSnapshots.splice(0);
        return;
      }
      throw new Error("audit database unavailable");
    }
  };

  await assert.rejects(
    callAiModelWithRuntime(
      persistedStore,
      store.aiModelConfigs[0],
      "return json",
      4_000,
      async () => new Response(
        JSON.stringify({ error: { message: "provider rejected" } }),
        {
          status: 503,
          headers: { "content-type": "application/json" }
        }
      ),
      {
        jobId: "job_dual_failure",
        promptVersion: "legacy-json.v1",
        schemaVersion: "legacy-json-object.v1"
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /503|provider|服务/i);
      assert.match(String(error.errors[1]), /audit database unavailable/);
      return true;
    }
  );
  assert.equal(store.modelCallRecords.length, 1);
  assert.equal(store.modelCallRecords[0].status, "failed");
});
