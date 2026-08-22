import { strict as assert } from "node:assert";
import {
  createConnectionCenterController,
  isConnectionCenterCloseControl,
  type ConnectionCenterApi
} from "./connection-controller";
import type {
  ModelConnectionCreateInput,
  SearchConnectionCreateInput
} from "./connection-api";

assert.equal(isConnectionCenterCloseControl("replicaConnectionCenterClose"), true);
assert.equal(isConnectionCenterCloseControl("replicaConnectionCenterDone"), true);
assert.equal(isConnectionCenterCloseControl("replicaConnectionCenterCancel"), true);
assert.equal(isConnectionCenterCloseControl("replicaRealTaskCancel"), false);

const eventTarget = new EventTarget();
const changed: Array<{ kind?: string; connectionId?: string }> = [];
eventTarget.addEventListener("goodjob:connections-changed", (event) => {
  changed.push(
    (event as CustomEvent<{ kind?: string; connectionId?: string }>).detail
  );
});

const modelCreateKeys: string[] = [];
let modelCreateAttempts = 0;
let activeModel = false;
let modelCreated = false;

const api: ConnectionCenterApi = {
  async listSearchProviders() {
    return [{
      id: "baidu_ai_search",
      kind: "search",
      displayName: "百度 AI 搜索",
      capabilities: ["public_web_search"]
    }];
  },
  async listSearchConnections() {
    return [];
  },
  async createSearchConnection(input: SearchConnectionCreateInput) {
    return {
      id: "search-1",
      providerId: input.providerId,
      kind: "search",
      status: "disabled",
      credentialVersion: 1,
      lastHealthStatus: "untested"
    };
  },
  async updateSearchConnection() {
    throw new Error("not used");
  },
  async testSearchConnection() {
    return { ok: true, message: "搜索连接测试通过" };
  },
  async deleteSearchConnection() {},
  async listModelEndpointProfiles() {
    return [{
      provider: "moonshot",
      endpointProfileId: "moonshot-workspace",
      region: "cn-workspace",
      baseUrl: null,
      requiresWorkspaceId: true,
      modelListPolicy: "separate_control_plane",
      officialReference: "https://platform.moonshot.cn/docs"
    }, {
      provider: "moonshot",
      endpointProfileId: "moonshot-cn",
      region: "cn",
      baseUrl: "https://api.moonshot.cn/v1",
      requiresWorkspaceId: false,
      modelListPolicy: "same_key",
      officialReference: "https://platform.moonshot.cn/docs"
    }];
  },
  async listModelConnections() {
    return modelCreated ? [{
      id: "model-1",
      provider: "moonshot",
      model: "kimi-k3",
      status: activeModel ? "active" : "inactive",
      credentialVersion: 1,
      capabilitySnapshot: { toolCalling: true }
    }] : [];
  },
  async createModelConnection(
    input: ModelConnectionCreateInput,
    stableKey?: string
  ) {
    assert.equal(input.active, false);
    modelCreateKeys.push(stableKey ?? "");
    modelCreateAttempts += 1;
    if (modelCreateAttempts === 1) throw new Error("网络暂时不可用");
    modelCreated = true;
    return {
      id: "model-1",
      provider: input.provider,
      model: input.model,
      status: "inactive",
      credentialVersion: 1,
      capabilitySnapshot: { toolCalling: true }
    };
  },
  async updateModelConnection() {
    throw new Error("not used");
  },
  async testModelConnection() {
    return { ok: true, message: "模型连接测试通过" };
  },
  async activateModelConnection(id, reason) {
    assert.equal(id, "model-1");
    assert.match(reason, /获客/);
    activeModel = true;
    return {
      id: "model-1",
      provider: "moonshot",
      model: "kimi-k3",
      status: "active",
      credentialVersion: 1,
      capabilitySnapshot: { toolCalling: true }
    };
  },
  async deleteModelConnection() {}
};

let keySerial = 0;
const controller = createConnectionCenterController({
  api,
  eventTarget,
  keyFactory: () => `controller-idempotency-${++keySerial}`,
  confirm: () => true
});

eventTarget.dispatchEvent(new CustomEvent("goodjob:connections-open-requested", {
  detail: { mode: "model", returnTo: "task-creation" }
}));
await controller.whenIdle();
assert.equal(controller.getState().mode, "model");
assert.equal(controller.getState().status, "ready");
assert.equal(controller.getState().selectedModelProfileId, "moonshot-cn");

const modelInput: ModelConnectionCreateInput = {
  provider: "moonshot",
  name: "Kimi 获客模型",
  baseUrl: "https://api.moonshot.cn/v1",
  model: "kimi-k3",
  apiKey: "test-only-model-secret"
};

await assert.rejects(
  () => controller.createModel(modelInput),
  /网络暂时不可用/
);
assert.match(controller.getState().error, /网络暂时不可用/);

await controller.createModel(modelInput);
assert.equal(modelCreateKeys[0], modelCreateKeys[1]);
assert.deepEqual(changed.at(-1), { kind: "model", connectionId: "model-1" });

await controller.createModel(modelInput);
assert.notEqual(modelCreateKeys[1], modelCreateKeys[2]);

await assert.rejects(
  () => controller.activateModel("model-1"),
  /测试模型连接/
);
await controller.testModel("model-1");
await controller.activateModel("model-1");
assert.equal(controller.getState().modelConnections[0]?.status, "active");
await assert.rejects(
  () => controller.rotateModel("model-1", { model: "kimi-k3" }),
  /正在启用的模型不能直接修改/
);
await assert.rejects(
  () => controller.deleteModel("model-1"),
  /正在启用的模型不能删除/
);

controller.destroy();
