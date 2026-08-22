import { strict as assert } from "node:assert";
import { createConnectionSettingsApi } from "./connection-api";

const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
let keySerial = 0;
const api = createConnectionSettingsApi(async (input, init) => {
  calls.push({ input, init });
  const path = String(input);
  if (path === "/api/v1/acquisition/providers") {
    return Response.json({
      items: [{
        id: "baidu_ai_search",
        kind: "search",
        displayName: "百度 AI 搜索",
        requiresKey: true,
        defaultBaseUrl: "https://qianfan.baidubce.com",
        capabilities: ["public_web_search"]
      }],
      nextCursor: null
    });
  }
  if (path === "/api/v1/acquisition/provider-connections") {
    if (init?.method === "POST") {
      return Response.json({
        id: "search-1",
        providerId: "baidu_ai_search",
        kind: "search",
        status: "active",
        credentialVersion: 1,
        lastHealthStatus: "untested"
      }, { status: 201 });
    }
    return Response.json({ items: [], nextCursor: null });
  }
  if (path === "/api/v1/acquisition/provider-connections/search-1/test") {
    return Response.json({ ok: true, message: "连接测试通过" });
  }
  if (path === "/api/v1/ai/endpoint-profiles") {
    return Response.json({
      items: [{
        provider: "moonshot",
        endpointProfileId: "moonshot-cn",
        region: "cn",
        baseUrl: "https://api.moonshot.cn/v1",
        requiresWorkspaceId: false,
        modelListPolicy: "same_key",
        officialReference: "https://platform.moonshot.cn/docs"
      }],
      nextCursor: null
    });
  }
  if (path === "/api/v1/ai/connections") {
    if (init?.method === "POST") {
      return Response.json({
        id: "model-1",
        provider: "moonshot",
        model: "kimi-k3",
        status: "inactive",
        credentialVersion: 1,
        capabilitySnapshot: { toolCalling: true }
      });
    }
    return Response.json({ items: [], nextCursor: null });
  }
  if (path === "/api/tools/ai-config/test") {
    return Response.json({ ok: true, message: "模型连接成功" });
  }
  if (path === "/api/v1/ai/connections/model-1/activate") {
    return Response.json({
      id: "model-1",
      provider: "moonshot",
      model: "kimi-k3",
      status: "active",
      credentialVersion: 1,
      capabilitySnapshot: { toolCalling: true }
    });
  }
  if (path === "/api/v1/ai/connections/model-1") {
    return Response.json({});
  }
  return Response.json({ message: "unexpected" }, { status: 404 });
}, {
  cookieSource: () => "gj_csrf=csrf%2Fconnection",
  idempotencyKeyFactory: () => `connection-key-${++keySerial}`
});

const providers = await api.listSearchProviders();
assert.equal(providers[0]?.id, "baidu_ai_search");

await api.createSearchConnection({
  providerId: "baidu_ai_search",
  apiKey: "search-secret",
  status: "active"
});
await api.testSearchConnection("search-1");

const profiles = await api.listModelEndpointProfiles();
assert.equal(profiles[0]?.provider, "moonshot");

await api.createModelConnection({
  provider: "moonshot",
  name: "Kimi",
  baseUrl: "https://api.moonshot.cn/v1",
  model: "kimi-k3",
  apiKey: "model-secret"
});
await api.testModelConnection("model-1");
await api.activateModelConnection("model-1", "用于抶音获客任务");
await api.deleteModelConnection("model-1");

const searchCreate = calls.find((call) =>
  call.input === "/api/v1/acquisition/provider-connections"
  && call.init?.method === "POST");
assert.ok(searchCreate);
assert.equal(
  new Headers(searchCreate.init?.headers).get("idempotency-key"),
  "connection-key-1"
);
assert.equal(
  new Headers(searchCreate.init?.headers).get("x-csrf-token"),
  "csrf/connection"
);
assert.deepEqual(JSON.parse(String(searchCreate.init?.body)), {
  providerId: "baidu_ai_search",
  apiKey: "search-secret",
  status: "active"
});

const modelCreate = calls.find((call) =>
  call.input === "/api/v1/ai/connections" && call.init?.method === "POST");
assert.ok(modelCreate);
assert.equal(
  new Headers(modelCreate.init?.headers).get("idempotency-key"),
  "connection-key-2"
);
assert.equal(
  "capabilitySnapshot" in JSON.parse(String(modelCreate.init?.body)),
  false
);

const modelTest = calls.find((call) =>
  call.input === "/api/tools/ai-config/test");
assert.deepEqual(JSON.parse(String(modelTest?.init?.body)), { id: "model-1" });

const activate = calls.find((call) =>
  call.input === "/api/v1/ai/connections/model-1/activate");
assert.equal(
  new Headers(activate?.init?.headers).get("idempotency-key"),
  "connection-key-3"
);

const remove = calls.find((call) =>
  call.input === "/api/v1/ai/connections/model-1"
  && call.init?.method === "DELETE");
assert.equal(
  new Headers(remove?.init?.headers).get("idempotency-key"),
  "connection-key-4"
);
