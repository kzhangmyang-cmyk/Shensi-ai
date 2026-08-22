import { strict as assert } from "node:assert";
import { renderConnectionCenter } from "./connection-view";

const searchHtml = renderConnectionCenter({
  mode: "search",
  status: "ready",
  mutation: "idle",
  providers: [{
    id: "baidu_ai_search",
    kind: "search",
    displayName: "百度 AI 搜索",
    officialDocsUrl: "https://example.com/docs",
    requiresKey: true,
    capabilities: ["public_web_search"]
  }],
  searchConnections: [],
  modelProfiles: [],
  modelConnections: [],
  selectedProviderId: "baidu_ai_search",
  selectedModelProfileId: null,
  selectedModelConnectionId: null,
  message: "",
  error: "",
  modelHealth: {}
});

assert.match(searchHtml, /搜索数据源/);
assert.match(searchHtml, /百度 AI 搜索/);
assert.match(searchHtml, /type="password"/);
assert.match(searchHtml, /保存搜索连接/);

const modelHtml = renderConnectionCenter({
  mode: "model",
  status: "ready",
  mutation: "idle",
  providers: [],
  searchConnections: [],
  modelProfiles: [{
    provider: "moonshot",
    endpointProfileId: "moonshot-cn",
    region: "cn",
    baseUrl: "https://api.moonshot.cn/v1",
    requiresWorkspaceId: false,
    modelListPolicy: "same_key",
    officialReference: "https://platform.moonshot.cn/docs"
  }],
  modelConnections: [{
    id: "model-1",
    provider: "moonshot",
    model: "kimi-k3",
    status: "inactive",
    credentialVersion: 2,
    capabilitySnapshot: { toolCalling: true }
  }],
  selectedProviderId: null,
  selectedModelProfileId: null,
  selectedModelConnectionId: "model-1",
  message: "",
  error: "",
  modelHealth: { "model-1": { ok: true, message: "模型连接成功" } }
});

assert.match(modelHtml, /Kimi/);
assert.match(modelHtml, /支持工具调用/);
assert.match(modelHtml, /启用模型/);
assert.match(modelHtml, /模型连接成功/);
assert.equal(modelHtml.includes("model-secret"), false);

const unsupportedProfileHtml = renderConnectionCenter({
  mode: "model",
  status: "ready",
  mutation: "idle",
  providers: [],
  searchConnections: [],
  modelProfiles: [{
    provider: "qwen",
    endpointProfileId: "qwen-workspace-cn",
    region: "cn",
    baseUrl: null,
    requiresWorkspaceId: true,
    modelListPolicy: "separate_control_plane",
    officialReference: "https://help.aliyun.com/"
  }],
  modelConnections: [],
  selectedProviderId: null,
  selectedModelProfileId: "qwen-workspace-cn",
  selectedModelConnectionId: null,
  message: "",
  error: "",
  modelHealth: {}
});

assert.match(unsupportedProfileHtml, /暂不支持工作空间端点/);
assert.doesNotMatch(unsupportedProfileHtml, /data-connection-form="create-model"/);

const activeModelHtml = renderConnectionCenter({
  mode: "model",
  status: "ready",
  mutation: "idle",
  providers: [],
  searchConnections: [],
  modelProfiles: [],
  modelConnections: [{
    id: "active-model",
    provider: "zhipu",
    model: "glm-5.2",
    status: "active",
    credentialVersion: 1,
    capabilitySnapshot: { toolCalling: true }
  }],
  selectedProviderId: null,
  selectedModelProfileId: null,
  selectedModelConnectionId: "active-model",
  message: "",
  error: "",
  modelHealth: {}
});

assert.match(activeModelHtml, /切换到其他模型后才能删除/);
assert.doesNotMatch(activeModelHtml, /data-connection-action="delete-model"/);
assert.doesNotMatch(activeModelHtml, /data-connection-form="rotate-model"/);
