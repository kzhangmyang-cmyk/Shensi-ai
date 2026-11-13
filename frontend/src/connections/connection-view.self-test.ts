import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { renderConnectionCenter } from "./connection-view";
import type { ModelEndpointProfile } from "./connection-api";

interface ModelOptionFixture {
  id: string;
  displayName: string;
}

type ModelEndpointProfileFixture = Omit<ModelEndpointProfile, "models"> & {
  models: ModelOptionFixture[];
};

function endpointProfile(
  profile: Omit<ModelEndpointProfile, "models">,
  models: ModelOptionFixture[] = []
): ModelEndpointProfileFixture {
  return { ...profile, models };
}

const deepseekModels = [{
  id: "deepseek-v4-pro",
  displayName: "DeepSeek V4 Pro"
}, {
  id: "deepseek-v4-flash",
  displayName: "DeepSeek V4 Flash"
}];

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

const createModelHtml = renderConnectionCenter({
  mode: "model",
  status: "ready",
  mutation: "idle",
  providers: [],
  searchConnections: [],
  modelProfiles: [endpointProfile({
    provider: "deepseek",
    endpointProfileId: "deepseek-global",
    region: "global",
    baseUrl: "https://api.deepseek.com",
    requiresWorkspaceId: false,
    modelListPolicy: "same_key",
    officialReference: "https://api-docs.deepseek.com/"
  }, deepseekModels)],
  modelConnections: [],
  selectedProviderId: null,
  selectedModelProfileId: "deepseek-global",
  selectedModelConnectionId: null,
  message: "",
  error: "",
  modelHealth: {}
});
const createModelDocument = parseHTML(createModelHtml).document;
const createModelSelect = createModelDocument.querySelector(
  'form[data-connection-form="create-model"] select[name="model"]'
);
assert.ok(createModelSelect, "创建 AI 连接必须用服务端模型列表渲染下拉框");
assert.equal(createModelSelect.hasAttribute("required"), true);
assert.deepEqual(
  [...createModelSelect.querySelectorAll("option")].map((option) => ({
    value: option.getAttribute("value"),
    label: option.textContent?.trim()
  })),
  deepseekModels.map((model) => ({ value: model.id, label: model.displayName }))
);
assert.equal(
  createModelDocument.querySelector(
    'form[data-connection-form="create-model"] input[name="model"]'
  ),
  null
);

const emptyModelListHtml = renderConnectionCenter({
  mode: "model",
  status: "ready",
  mutation: "idle",
  providers: [],
  searchConnections: [],
  modelProfiles: [endpointProfile({
    provider: "deepseek",
    endpointProfileId: "deepseek-global",
    region: "global",
    baseUrl: "https://api.deepseek.com",
    requiresWorkspaceId: false,
    modelListPolicy: "same_key",
    officialReference: "https://api-docs.deepseek.com/"
  })],
  modelConnections: [],
  selectedProviderId: null,
  selectedModelProfileId: "deepseek-global",
  selectedModelConnectionId: null,
  message: "",
  error: "",
  modelHealth: {}
});
const emptyModelListDocument = parseHTML(emptyModelListHtml).document;
const emptyModelListForm = emptyModelListDocument.querySelector(
  'form[data-connection-form="create-model"]'
);
assert.ok(emptyModelListForm);
assert.equal(
  emptyModelListForm.querySelector('select[name="model"]')?.hasAttribute(
    "disabled"
  ),
  true
);
assert.equal(
  emptyModelListForm.querySelector('button[type="submit"]')?.hasAttribute(
    "disabled"
  ),
  true
);
assert.match(emptyModelListForm.textContent ?? "", /暂无可选的已认证模型/);

const rotateLegacyModelHtml = renderConnectionCenter({
  mode: "model",
  status: "ready",
  mutation: "idle",
  providers: [],
  searchConnections: [],
  modelProfiles: [endpointProfile({
    provider: "deepseek",
    endpointProfileId: "deepseek-global",
    region: "global",
    baseUrl: "https://api.deepseek.com",
    requiresWorkspaceId: false,
    modelListPolicy: "same_key",
    officialReference: "https://api-docs.deepseek.com/"
  }, deepseekModels)],
  modelConnections: [{
    id: "legacy-deepseek",
    provider: "deepseek",
    model: "deepseekv4",
    endpointProfileId: "deepseek-global",
    status: "inactive",
    credentialVersion: 1,
    capabilitySnapshot: { toolCalling: false }
  }],
  selectedProviderId: null,
  selectedModelProfileId: null,
  selectedModelConnectionId: "legacy-deepseek",
  message: "",
  error: "",
  modelHealth: {}
});
const rotateLegacyModelDocument = parseHTML(rotateLegacyModelHtml).document;
const rotateLegacyModelSelect = rotateLegacyModelDocument.querySelector(
  'form[data-connection-form="rotate-model"] select[name="model"]'
);
assert.ok(rotateLegacyModelSelect, "更新 AI 连接必须用服务端模型列表渲染下拉框");
assert.equal(rotateLegacyModelSelect.hasAttribute("required"), true);
const legacyPlaceholder = rotateLegacyModelSelect.querySelector(
  'option[value=""][selected]'
);
assert.ok(legacyPlaceholder, "旧的未认证模型必须先显示为空值占位项并要求重新选择");
assert.equal(legacyPlaceholder.hasAttribute("disabled"), true);
assert.match(legacyPlaceholder.textContent ?? "", /deepseekv4/);
assert.equal(
  rotateLegacyModelSelect.querySelector('option[value="deepseekv4"]'),
  null
);
assert.deepEqual(
  [...rotateLegacyModelSelect.querySelectorAll("option")]
    .map((option) => option.getAttribute("value"))
    .filter(Boolean),
  deepseekModels.map((model) => model.id)
);
assert.equal(
  rotateLegacyModelDocument.querySelector(
    'form[data-connection-form="rotate-model"] input[name="model"]'
  ),
  null
);

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
    officialReference: "https://platform.moonshot.cn/docs",
    models: [{ id: "kimi-k3", displayName: "Kimi K3" }]
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
    officialReference: "https://help.aliyun.com/",
    models: []
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

assert.match(activeModelHtml, /data-connection-action="deactivate-model"/);
assert.match(activeModelHtml, /停用模型/);
assert.match(activeModelHtml, /停用后可删除/);
assert.doesNotMatch(activeModelHtml, /data-connection-action="delete-model"/);
assert.doesNotMatch(activeModelHtml, /data-connection-form="rotate-model"/);
