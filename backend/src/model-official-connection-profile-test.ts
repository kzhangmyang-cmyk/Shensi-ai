import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOfficialModelConnectionProfile,
  listOfficialModelEndpointOptions
} from "./model-providers/connection-profile.js";

test("official connection profile derives endpoint and capabilities from registry evidence", () => {
  const profile = buildOfficialModelConnectionProfile({
    provider: "moonshot",
    baseUrl: "https://api.moonshot.cn/v1/",
    model: "kimi-k3"
  });

  assert.equal(profile.endpointProfileId, "moonshot-cn");
  assert.equal(profile.region, "cn");
  assert.equal(profile.baseUrl, "https://api.moonshot.cn/v1");
  assert.equal(profile.workspaceId, null);
  assert.equal(profile.adapterVersion, "official-openai-compatible.v1");
  assert.deepEqual(profile.capabilitySnapshot, {
    structuredOutput: true,
    toolCalling: true,
    parallelToolCalling: true,
    streaming: true,
    modelListing: true
  });
  assert.equal(profile.certification.evidence?.model, "kimi-k3");
  assert.match(profile.certificationHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.capabilitySnapshot), true);
});

test("uncertified exact models remain conservative instead of trusting user claims", () => {
  const profile = buildOfficialModelConnectionProfile({
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "future-model-not-yet-certified"
  });

  assert.deepEqual(profile.capabilitySnapshot, {
    structuredOutput: false,
    toolCalling: false,
    parallelToolCalling: false,
    streaming: false,
    modelListing: true
  });
  assert.equal(profile.certification.evidence, null);
  assert.equal(
    profile.certification.capabilities.toolCalling,
    "unverified"
  );
});

test("workspace endpoints preserve the validated Qwen workspace identity", () => {
  const profile = buildOfficialModelConnectionProfile({
    provider: "qwen",
    baseUrl:
      "https://llm-workspace-7.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/",
    model: "qwen-plus"
  });

  assert.equal(
    profile.endpointProfileId,
    "qwen-ap-southeast-1-workspace"
  );
  assert.equal(profile.workspaceId, "llm-workspace-7");
  assert.equal(profile.region, "ap-southeast-1");
});

test("official endpoint options expose canonical public choices without mutable registry objects", () => {
  const options = listOfficialModelEndpointOptions();
  assert.ok(options.length >= 9);
  assert.ok(options.some((item) =>
    item.provider === "minimax"
    && item.endpointProfileId === "minimax-cn"
    && item.baseUrl === "https://api.minimaxi.com/v1"
  ));
  assert.ok(options.some((item) =>
    item.provider === "qwen"
    && item.requiresWorkspaceId
  ));
  assert.equal(Object.isFrozen(options), true);
  assert.equal(Object.isFrozen(options[0]), true);
});
