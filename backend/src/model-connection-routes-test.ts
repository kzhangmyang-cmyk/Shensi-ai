import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { signToken } from "./auth.js";
import { app } from "./server.js";
import { getStore } from "./store.js";
import type {
  ModelCallRecord
} from "./model-providers/call-ledger.js";
import type { AiModelConfig } from "./types.js";

const store = getStore();
const originalConfigs = structuredClone(store.aiModelConfigs);
const originalCredentials = structuredClone(store.modelCredentialVersions);
const originalEvents = structuredClone(
  store.modelConnectionActivationEvents
);
const originalIdempotency = structuredClone(
  (store as unknown as {
    modelConnectionIdempotencyRecords?: unknown[];
  }).modelConnectionIdempotencyRecords || []
);
const originalCalls = structuredClone(store.modelCallRecords);
let server: ReturnType<typeof app.listen>;
let baseUrl = "";
let token = "";

before(() => {
  process.env.JWT_SECRET =
    "model-connection-route-test-secret-at-least-32-characters";
  const user = store.users.find((item) => item.id === "u_sales_shirley");
  if (!user) throw new Error("model connection route test user is missing");
  token = signToken({ ...user, authVersion: user.authVersion || 1 });
  server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("model connection route test server did not start");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  store.aiModelConfigs.splice(
    0,
    store.aiModelConfigs.length,
    ...originalConfigs
  );
  store.modelCredentialVersions.splice(
    0,
    store.modelCredentialVersions.length,
    ...originalCredentials
  );
  store.modelConnectionActivationEvents.splice(
    0,
    store.modelConnectionActivationEvents.length,
    ...originalEvents
  );
  const idempotencyStore = store as unknown as {
    modelConnectionIdempotencyRecords?: unknown[];
    pendingModelConnectionIdempotencyRecords?: unknown[];
  };
  idempotencyStore.modelConnectionIdempotencyRecords?.splice(
    0,
    idempotencyStore.modelConnectionIdempotencyRecords.length,
    ...originalIdempotency
  );
  idempotencyStore.pendingModelConnectionIdempotencyRecords?.splice(0);
  store.modelCallRecords.splice(
    0,
    store.modelCallRecords.length,
    ...originalCalls
  );
  store.pendingModelCallRecords.splice(0);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

async function request(
  path: string,
  init: RequestInit
) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });
  const json = await response.json().catch(() => null);
  return { response, json };
}

function modelCall(
  id: string,
  ownerId: string,
  teamId: string,
  createdAt: string
): ModelCallRecord {
  return {
    id,
    ownerId,
    teamId,
    jobId: `job_${id}`,
    attemptId: `attempt_${id}`,
    connectionId: `connection_${id}`,
    credentialVersion: 2,
    capabilitySnapshotHash: "sha256:capabilities",
    provider: "openai",
    baseUrlFingerprint: "sha256:endpoint",
    model: "gpt-test",
    promptVersion: "prompt.v1",
    schemaVersion: "schema.v1",
    requestId: `request_${id}`,
    providerRequestId: null,
    inputTokens: 5,
    outputTokens: 3,
    reasoningTokens: 0,
    latencyMs: 25,
    status: "succeeded",
    error: null,
    cost: {
      amountMinor: 0,
      currency: "USD",
      kind: "unknown"
    },
    parameterHash: "sha256:parameters",
    resultHash: "sha256:result",
    createdAt
  };
}

function legacyModelConfig(
  id: string,
  teamId: string,
  enabled = false
): AiModelConfig {
  return {
    id,
    provider: "custom-model-provider",
    protocol: "openai-compatible",
    name: id,
    baseUrl: "https://model.example.com/v1",
    model: "custom-model",
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
    ownerId: "u_sales_shirley",
    teamId,
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z"
  };
}

test("legacy model config list never crosses team scope", async () => {
  const hidden = legacyModelConfig(
    "legacy-config-hidden-list",
    "other-team",
    true
  );
  store.aiModelConfigs.push(hidden);
  try {
    const result = await request("/api/tools/ai-config", {
      method: "GET"
    });
    assert.equal(result.response.status, 200);
    assert.equal(
      result.json.configs.some(
        (item: { id: string }) => item.id === hidden.id
      ),
      false
    );
    assert.notEqual(result.json.config?.id, hidden.id);
  } finally {
    store.aiModelConfigs.splice(
      store.aiModelConfigs.findIndex((item) => item.id === hidden.id),
      1
    );
  }
});

test("legacy custom activation does not disable another team", async () => {
  const hidden = legacyModelConfig(
    "legacy-config-hidden-active",
    "other-team",
    true
  );
  store.aiModelConfigs.push(hidden);
  try {
    const result = await request("/api/tools/ai-config", {
      method: "POST",
      body: JSON.stringify({
        provider: "custom-model-provider",
        protocol: "openai-compatible",
        name: "Legacy scoped activation",
        baseUrl: "https://model.example.com/v1",
        model: "custom-model",
        apiKey: "legacy-scoped-test-key",
        enabled: true
      })
    });
    assert.equal(result.response.status, 200);
    assert.equal(hidden.enabled, true);
  } finally {
    store.aiModelConfigs.splice(
      0,
      store.aiModelConfigs.length,
      ...store.aiModelConfigs.filter(
        (item) => item.id === hidden.id
          ? false
          : item.name !== "Legacy scoped activation"
      )
    );
  }
});

test("legacy delete and test cannot target another team", async () => {
  const hiddenDelete = legacyModelConfig(
    "legacy-config-hidden-delete",
    "other-team"
  );
  const hiddenTest = legacyModelConfig(
    "legacy-config-hidden-test",
    "other-team"
  );
  store.aiModelConfigs.push(hiddenDelete, hiddenTest);
  try {
    const deleted = await request(
      `/api/tools/ai-config/${hiddenDelete.id}`,
      { method: "DELETE" }
    );
    assert.equal(deleted.response.status, 404);
    assert.ok(
      store.aiModelConfigs.some((item) => item.id === hiddenDelete.id)
    );

    const tested = await request("/api/tools/ai-config/test", {
      method: "POST",
      body: JSON.stringify({ id: hiddenTest.id })
    });
    assert.equal(tested.response.status, 400);
    assert.equal(tested.json.message, "请先保存模型地址和模型名称");
  } finally {
    store.aiModelConfigs.splice(
      0,
      store.aiModelConfigs.length,
      ...store.aiModelConfigs.filter(
        (item) => item.id !== hiddenDelete.id
          && item.id !== hiddenTest.id
      )
    );
  }
});

test("v1 model call list is owner-and-team scoped and newest first", async () => {
  store.modelCallRecords.push(
    modelCall(
      "call_visible_old",
      "u_sales_shirley",
      "europe",
      "2026-07-22T10:00:00.000Z"
    ),
    modelCall(
      "call_visible_new",
      "u_sales_shirley",
      "europe",
      "2026-07-23T10:00:00.000Z"
    ),
    modelCall(
      "call_other_owner",
      "u_other",
      "europe",
      "2026-07-24T10:00:00.000Z"
    ),
    modelCall(
      "call_other_team",
      "u_sales_shirley",
      "other-team",
      "2026-07-25T10:00:00.000Z"
    )
  );

  const result = await request("/api/v1/ai/calls?limit=10", {
    method: "GET"
  });

  assert.equal(result.response.status, 200);
  assert.deepEqual(
    result.json.items.map((item: { id: string }) => item.id),
    ["call_visible_new", "call_visible_old"]
  );
  assert.equal(result.json.nextCursor, null);
  assert.equal(JSON.stringify(result.json).includes("private prompt"), false);
});

test("v1 model call detail never crosses owner or team scope", async () => {
  const visible = modelCall(
    "call_detail_visible",
    "u_sales_shirley",
    "europe",
    "2026-07-23T10:00:00.000Z"
  );
  const hidden = modelCall(
    "call_detail_hidden",
    "u_other",
    "europe",
    "2026-07-23T11:00:00.000Z"
  );
  store.modelCallRecords.push(visible, hidden);

  const found = await request(
    "/api/v1/ai/calls/call_detail_visible",
    { method: "GET" }
  );
  assert.equal(found.response.status, 200);
  assert.equal(found.json.id, visible.id);

  const forbidden = await request(
    "/api/v1/ai/calls/call_detail_hidden",
    { method: "GET" }
  );
  assert.equal(forbidden.response.status, 404);
  assert.equal(forbidden.json.code, "model_call_not_found");
});

test("v1 connection create requires Idempotency-Key", async () => {
  const result = await request("/api/v1/ai/connections", {
    method: "POST",
    body: JSON.stringify({
      provider: "openai",
      name: "Idempotency test",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-test",
      apiKey: "route-test-secret"
    })
  });
  assert.equal(result.response.status, 400);
  assert.deepEqual(Object.keys(result.json).sort(), [
    "code",
    "details",
    "message",
    "requestId",
    "retryable"
  ]);
  assert.equal(result.json.code, "idempotency_key_required");
});

test("v1 exposes official endpoint choices without credentials", async () => {
  const result = await request("/api/v1/ai/endpoint-profiles", {
    method: "GET"
  });

  assert.equal(result.response.status, 200);
  assert.ok(result.json.items.some((item: {
    provider: string;
    endpointProfileId: string;
    baseUrl: string | null;
  }) =>
    item.provider === "moonshot"
    && item.endpointProfileId === "moonshot-cn"
    && item.baseUrl === "https://api.moonshot.cn/v1"
  ));
  assert.equal(JSON.stringify(result.json).includes("apiKey"), false);
});

test("v1 connection derives immutable official capability evidence", async () => {
  const result = await request("/api/v1/ai/connections", {
    method: "POST",
    headers: {
      "Idempotency-Key": "official-profile-derived-capabilities"
    },
    body: JSON.stringify({
      provider: "moonshot",
      name: "Kimi official profile",
      baseUrl: "https://api.moonshot.cn/v1/",
      model: "kimi-k3",
      apiKey: "moonshot-route-secret"
    })
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.json.endpointProfileId, "moonshot-cn");
  assert.equal(result.json.endpointRegion, "cn");
  assert.equal(result.json.adapterVersion, "official-openai-compatible.v1");
  assert.deepEqual(result.json.capabilitySnapshot, {
    structuredOutput: false,
    toolCalling: true,
    parallelToolCalling: false,
    streaming: true,
    modelListing: true
  });
  assert.match(
    result.json.capabilityCertificationHash,
    /^sha256:[a-f0-9]{64}$/
  );
});

test("v1 connection rejects arbitrary endpoints and user-declared capabilities", async () => {
  const arbitrary = await request("/api/v1/ai/connections", {
    method: "POST",
    headers: { "Idempotency-Key": "reject-arbitrary-model-endpoint" },
    body: JSON.stringify({
      provider: "moonshot",
      name: "Untrusted endpoint",
      baseUrl: "https://llm.example.test/v1",
      model: "kimi-k3",
      apiKey: "private-secret"
    })
  });
  assert.equal(arbitrary.response.status, 400);
  assert.equal(arbitrary.json.code, "invalid_official_endpoint");

  const declared = await request("/api/v1/ai/connections", {
    method: "POST",
    headers: { "Idempotency-Key": "reject-self-certified-capabilities" },
    body: JSON.stringify({
      provider: "openai",
      name: "Self certified",
      baseUrl: "https://api.openai.com/v1",
      model: "unknown-model",
      apiKey: "private-secret",
      capabilitySnapshot: {
        structuredOutput: true,
        toolCalling: true,
        parallelToolCalling: true,
        streaming: true,
        modelListing: true
      }
    })
  });
  assert.equal(declared.response.status, 400);
});

test("v1 connection create replays exactly and rejects conflicting reuse", async () => {
  const idempotencyKey = "connection-create-route-key";
  const apiKey = "route-private-key-4455";
  const body = {
    provider: "openai",
    name: "Idempotent create",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-idempotent",
    apiKey
  };
  const beforeCount = store.aiModelConfigs.filter(
    (item) => item.name === body.name
  ).length;
  const first = await request("/api/v1/ai/connections", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body)
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.json.ownerId, "u_sales_shirley");
  assert.equal(first.json.provider, body.provider);
  assert.equal(first.json.model, body.model);
  assert.equal(first.json.status, "inactive");
  assert.equal(first.json.credentialVersion, 1);
  assert.match(first.json.baseUrlFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(first.json).includes(apiKey), false);

  const replay = await request("/api/v1/ai/connections", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body)
  });
  assert.equal(replay.response.status, first.response.status);
  assert.deepEqual(replay.json, first.json);
  assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");
  assert.equal(
    store.aiModelConfigs.filter((item) => item.name === body.name).length,
    beforeCount + 1
  );

  const idempotencyRecords = (store as unknown as {
    modelConnectionIdempotencyRecords: Array<Record<string, unknown>>;
  }).modelConnectionIdempotencyRecords;
  const record = idempotencyRecords.at(-1);
  assert.match(String(record?.idempotencyKeyHash), /^[a-f0-9]{64}$/);
  assert.match(String(record?.requestFingerprint), /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(record).includes(idempotencyKey), false);
  assert.equal(JSON.stringify(record).includes(apiKey), false);

  const conflict = await request("/api/v1/ai/connections", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ ...body, model: "gpt-conflict" })
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.json.code, "idempotency_key_conflict");
  assert.deepEqual(Object.keys(conflict.json).sort(), [
    "code",
    "details",
    "message",
    "requestId",
    "retryable"
  ]);
  const repeatedConflict = await request("/api/v1/ai/connections", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ ...body, model: "gpt-conflict" })
  });
  assert.deepEqual(repeatedConflict.json, conflict.json);
});

test("v1 connection update requires Idempotency-Key", async () => {
  const config = store.aiModelConfigs.find(
    (item) => item.name === "Idempotent create"
  );
  assert.ok(config);
  const result = await request(`/api/v1/ai/connections/${config.id}`, {
    method: "PATCH",
    body: JSON.stringify({ model: "gpt-updated" })
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.json.code, "idempotency_key_required");
});

test("v1 connection update replays the typed result without rotating twice", async () => {
  const config = store.aiModelConfigs.find(
    (item) => item.name === "Idempotent create"
  );
  assert.ok(config);
  const credentialCount = store.modelCredentialVersions.filter(
    (item) => item.connectionId === config.id
  ).length;
  const body = {
    model: "gpt-updated-once",
    apiKey: "updated-route-secret-7788"
  };
  const first = await request(`/api/v1/ai/connections/${config.id}`, {
    method: "PATCH",
    headers: { "Idempotency-Key": "connection-update-route-key" },
    body: JSON.stringify(body)
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.json.id, config.id);
  assert.equal(first.json.model, body.model);
  assert.equal(first.json.credentialVersion, credentialCount + 1);
  assert.equal(JSON.stringify(first.json).includes(body.apiKey), false);

  const replay = await request(`/api/v1/ai/connections/${config.id}`, {
    method: "PATCH",
    headers: { "Idempotency-Key": "connection-update-route-key" },
    body: JSON.stringify(body)
  });
  assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(replay.json, first.json);
  assert.equal(
    store.modelCredentialVersions.filter(
      (item) => item.connectionId === config.id
    ).length,
    credentialCount + 1
  );

  const conflict = await request(
    `/api/v1/ai/connections/${config.id}`,
    {
      method: "PATCH",
      headers: { "Idempotency-Key": "connection-update-route-key" },
      body: JSON.stringify({ ...body, model: "gpt-conflicting-update" })
    }
  );
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.json.code, "idempotency_key_conflict");
});

test("v1 connection activation requires Idempotency-Key", async () => {
  const config = store.aiModelConfigs.find(
    (item) => item.name === "Idempotent create"
  );
  assert.ok(config);
  const eventCount = store.modelConnectionActivationEvents.length;
  const result = await request(
    `/api/v1/ai/connections/${config.id}/activate`,
    {
      method: "POST",
      body: JSON.stringify({ reason: "missing key must not activate" })
    }
  );
  assert.equal(result.response.status, 400);
  assert.equal(result.json.code, "idempotency_key_required");
  assert.equal(store.modelConnectionActivationEvents.length, eventCount);
});

test("v1 connection activation replays one audit event and typed result", async () => {
  const config = store.aiModelConfigs.find(
    (item) => item.name === "Idempotent create"
  );
  assert.ok(config);
  const eventCount = store.modelConnectionActivationEvents.length;
  const body = { reason: "activate exactly once" };
  const path = `/api/v1/ai/connections/${config.id}/activate`;
  const first = await request(path, {
    method: "POST",
    headers: { "Idempotency-Key": "connection-activate-route-key" },
    body: JSON.stringify(body)
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.json.id, config.id);
  assert.equal(first.json.status, "active");
  assert.equal(
    store.modelConnectionActivationEvents.length,
    eventCount + 1
  );

  const replay = await request(path, {
    method: "POST",
    headers: { "Idempotency-Key": "connection-activate-route-key" },
    body: JSON.stringify(body)
  });
  assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(replay.json, first.json);
  assert.equal(
    store.modelConnectionActivationEvents.length,
    eventCount + 1
  );

  const conflict = await request(path, {
    method: "POST",
    headers: { "Idempotency-Key": "connection-activate-route-key" },
    body: JSON.stringify({ reason: "different activation request" })
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.json.code, "idempotency_key_conflict");
});

test("v1 connection deletion requires Idempotency-Key", async () => {
  const created = await request("/api/v1/ai/connections", {
    method: "POST",
    headers: { "Idempotency-Key": "connection-delete-target-create-key" },
    body: JSON.stringify({
      provider: "openai",
      name: "Idempotent delete target",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-delete",
      apiKey: "delete-target-secret"
    })
  });
  assert.equal(created.response.status, 200);
  const result = await request(
    `/api/v1/ai/connections/${created.json.id}`,
    { method: "DELETE" }
  );
  assert.equal(result.response.status, 400);
  assert.equal(result.json.code, "idempotency_key_required");
  assert.ok(
    store.aiModelConfigs.some((item) => item.id === created.json.id)
  );
});

test("v1 connection deletion replays 200 empty body after removal", async () => {
  const config = store.aiModelConfigs.find(
    (item) => item.name === "Idempotent delete target"
  );
  assert.ok(config);
  const path = `/api/v1/ai/connections/${config.id}`;
  const first = await request(path, {
    method: "DELETE",
    headers: { "Idempotency-Key": "connection-delete-route-key" }
  });
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.json, {});
  assert.equal(
    store.aiModelConfigs.some((item) => item.id === config.id),
    false
  );
  assert.equal(
    store.modelCredentialVersions.some(
      (item) => item.connectionId === config.id
    ),
    false
  );

  const replay = await request(path, {
    method: "DELETE",
    headers: { "Idempotency-Key": "connection-delete-route-key" }
  });
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.json, {});
  assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");

  const conflict = await request(
    "/api/v1/ai/connections/different-connection",
    {
      method: "DELETE",
      headers: { "Idempotency-Key": "connection-delete-route-key" }
    }
  );
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.json.code, "idempotency_key_conflict");
});

test("v1 connection in-use deletion returns the contractual error header", async () => {
  const config = store.aiModelConfigs.find(
    (item) => item.name === "Idempotent create"
  );
  assert.ok(config);
  const result = await request(
    `/api/v1/ai/connections/${config.id}`,
    {
      method: "DELETE",
      headers: { "Idempotency-Key": "connection-in-use-delete-key" }
    }
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.json.code, "connection_in_use");
  assert.equal(
    result.response.headers.get("X-Error-Code"),
    "connection_in_use"
  );
  assert.deepEqual(Object.keys(result.json).sort(), [
    "code",
    "details",
    "message",
    "requestId",
    "retryable"
  ]);
});

test("v1 deletion honors the bounded activation-audit retention", async () => {
  const created = await request("/api/v1/ai/connections", {
    method: "POST",
    headers: { "Idempotency-Key": "audit-retention-create-key" },
    body: JSON.stringify({
      provider: "openai",
      name: "Audit retained delete target",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-audit-retained",
      apiKey: "audit-retention-secret"
    })
  });
  assert.equal(created.response.status, 200);
  store.modelConnectionActivationEvents.push({
    id: "route-audit-retention-event",
    ownerId: "u_sales_shirley",
    teamId: "europe",
    actorId: "u_sales_shirley",
    previousConnectionId: created.json.id,
    connectionId: "replacement-connection",
    reason: "recent switch",
    createdAt: new Date().toISOString()
  });

  const result = await request(
    `/api/v1/ai/connections/${created.json.id}`,
    {
      method: "DELETE",
      headers: { "Idempotency-Key": "audit-retention-delete-key" }
    }
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.json.code, "connection_in_use");
  assert.equal(
    result.response.headers.get("X-Error-Code"),
    "connection_in_use"
  );
  assert.ok(
    store.aiModelConfigs.some((item) => item.id === created.json.id)
  );
});
