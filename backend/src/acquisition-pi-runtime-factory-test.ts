import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  acquisitionPiModelSnapshotFromStored,
  bindActiveAcquisitionModelSnapshot,
  createAcquisitionPiRuntimeFactory
} from "./acquisition-pi-runtime-factory.js";
import {
  ACQUISITION_LEGACY_MODEL_CONTENT_BUNDLE,
  ACQUISITION_LEGACY_MODEL_CONTENT_HASHES,
  ACQUISITION_LEGACY_MODEL_PROMPT_VERSION,
  ACQUISITION_LEGACY_MODEL_SCHEMA_VERSION,
  ACQUISITION_MODEL_CONTENT_HASHES,
  ACQUISITION_MODEL_PROMPT_VERSION,
  ACQUISITION_MODEL_SCHEMA_VERSION,
  DEFAULT_ACQUISITION_PI_SYSTEM_PROMPT
} from "./acquisition-model-content.js";
import {
  acquisitionAgentToolDefinitions
} from "./acquisition-pi-tools.js";
import type {
  AcquisitionPiGatewayPort
} from "./acquisition-pi-gateway-runtime.js";
import type {
  StoredAiJobModelSnapshot
} from "./model-providers/types.js";

const storedSnapshot: StoredAiJobModelSnapshot = {
  jobId: "job-a",
  ownerId: "owner-a",
  teamId: "team-a",
  connectionId: "connection-a",
  credentialVersion: 4,
  provider: "moonshot",
  model: "kimi-k3",
  capabilitySnapshot: {
    structuredOutput: true,
    toolCalling: true,
    parallelToolCalling: true,
    streaming: true,
    modelListing: false
  },
  promptVersion: ACQUISITION_MODEL_PROMPT_VERSION,
  schemaVersion: ACQUISITION_MODEL_SCHEMA_VERSION,
  promptHash: ACQUISITION_MODEL_CONTENT_HASHES.promptHash,
  schemaHash: ACQUISITION_MODEL_CONTENT_HASHES.schemaHash,
  baseUrl: "https://api.moonshot.cn/v1",
  baseUrlFingerprint: "sha256:moonshot-base-url",
  createdAt: "2026-07-23T00:00:00.000Z"
};

const capabilitySnapshotHash = `sha256:${createHash("sha256")
  .update(JSON.stringify(storedSnapshot.capabilitySnapshot))
  .digest("hex")}`;

const gateway: AcquisitionPiGatewayPort = {
  async callTools() {
    return {
      toolCalls: [{
        id: "final-a",
        name: "__goodjob_submit_final_answer",
        arguments: {
          text: "已按冻结模型快照完成公开商机分析。"
        }
      }],
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        reasoningTokens: 0
      },
      providerRequestId: "provider-request-a"
    };
  }
};

const gatewaySnapshots: StoredAiJobModelSnapshot[] = [];
const factory = createAcquisitionPiRuntimeFactory({
  store: {
    aiJobModelSnapshots: [storedSnapshot]
  },
  gatewayFactory(snapshot) {
    gatewaySnapshots.push(structuredClone(snapshot));
    return gateway;
  }
});

const piSnapshot = {
  jobId: storedSnapshot.jobId,
  connectionId: storedSnapshot.connectionId,
  credentialVersion: storedSnapshot.credentialVersion,
  provider: storedSnapshot.provider,
  model: storedSnapshot.model,
  promptVersion: storedSnapshot.promptVersion,
  schemaVersion: storedSnapshot.schemaVersion,
  promptHash: storedSnapshot.promptHash,
  schemaHash: storedSnapshot.schemaHash,
  capabilitySnapshotHash,
  baseUrlFingerprint: storedSnapshot.baseUrlFingerprint
};

const runtime = await factory.create({
  identity: {
    ownerId: "owner-a",
    teamId: "team-a",
    actorId: "sales-a",
    sessionId: "session-a"
  },
  snapshot: piSnapshot
});

const result = await runtime.run({
  snapshot: piSnapshot,
  systemPrompt: DEFAULT_ACQUISITION_PI_SYSTEM_PROMPT,
  messages: [{
    role: "user",
    content: "分析中国市场商机",
    timestamp: 1
  }],
  tools: acquisitionAgentToolDefinitions()
});
assert.equal(result.type, "text");
assert.equal(gatewaySnapshots.length, 1);
assert.equal(gatewaySnapshots[0]?.jobId, "job-a");

{
  const legacySnapshot: StoredAiJobModelSnapshot = {
    ...storedSnapshot,
    jobId: "job-legacy-assistant",
    promptVersion: ACQUISITION_LEGACY_MODEL_PROMPT_VERSION,
    schemaVersion: ACQUISITION_LEGACY_MODEL_SCHEMA_VERSION,
    ...ACQUISITION_LEGACY_MODEL_CONTENT_HASHES
  };
  let selectedLegacyBundle = false;
  const legacyFactory = createAcquisitionPiRuntimeFactory({
    store: { aiJobModelSnapshots: [legacySnapshot] },
    gatewayFactory(snapshot, contentBundle) {
      assert.equal(snapshot.jobId, legacySnapshot.jobId);
      selectedLegacyBundle =
        contentBundle === ACQUISITION_LEGACY_MODEL_CONTENT_BUNDLE;
      return gateway;
    }
  });
  const legacyPiSnapshot =
    acquisitionPiModelSnapshotFromStored(legacySnapshot);
  const legacyRuntime = await legacyFactory.create({
    identity: {
      ownerId: legacySnapshot.ownerId,
      teamId: legacySnapshot.teamId,
      actorId: "sales-legacy",
      sessionId: "session-legacy"
    },
    snapshot: legacyPiSnapshot
  });
  const legacyResult = await legacyRuntime.run({
    snapshot: legacyPiSnapshot,
    systemPrompt: DEFAULT_ACQUISITION_PI_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: "继续旧会话中的普通获客分析",
      timestamp: 1
    }],
    tools: acquisitionAgentToolDefinitions()
  });
  assert.equal(selectedLegacyBundle, true);
  assert.equal(legacyResult.type, "text");
}

await assert.rejects(
  () => factory.create({
    identity: {
      ownerId: "owner-b",
      teamId: "team-a",
      actorId: "sales-b",
      sessionId: "session-b"
    },
    snapshot: piSnapshot
  }),
  /MODEL_SNAPSHOT_UNAVAILABLE/
);

await assert.rejects(
  () => factory.create({
    identity: {
      ownerId: "owner-a",
      teamId: "team-a",
      actorId: "sales-a",
      sessionId: "session-c"
    },
    snapshot: {
      ...piSnapshot,
      promptHash: "sha256:tampered-prompt"
    }
  }),
  /MODEL_SNAPSHOT_MISMATCH/
);

await assert.rejects(
  () => createAcquisitionPiRuntimeFactory({
    store: {
      aiJobModelSnapshots: [{
        ...storedSnapshot,
        capabilitySnapshot: {
          ...storedSnapshot.capabilitySnapshot,
          toolCalling: false
        }
      }]
    },
    gatewayFactory() {
      return gateway;
    }
  }).create({
    identity: {
      ownerId: "owner-a",
      teamId: "team-a",
      actorId: "sales-a",
      sessionId: "session-d"
    },
    snapshot: {
      ...piSnapshot,
      capabilitySnapshotHash: `sha256:${createHash("sha256")
        .update(JSON.stringify({
          ...storedSnapshot.capabilitySnapshot,
          toolCalling: false
        }))
        .digest("hex")}`
    }
  }),
  /MODEL_TOOL_CALLING_UNAVAILABLE/
);

{
  const staleStoredSnapshot = {
    ...storedSnapshot,
    jobId: "job-stale-content",
    promptHash: "sha256:stale-server-prompt-bundle",
    schemaHash: "sha256:stale-server-schema-bundle"
  };
  const staleClientSnapshot = {
    ...piSnapshot,
    jobId: staleStoredSnapshot.jobId,
    promptHash: staleStoredSnapshot.promptHash,
    schemaHash: staleStoredSnapshot.schemaHash
  };
  await assert.rejects(
    () => createAcquisitionPiRuntimeFactory({
      store: {
        aiJobModelSnapshots: [staleStoredSnapshot]
      },
      gatewayFactory() {
        return gateway;
      }
    }).create({
      identity: {
        ownerId: "owner-a",
        teamId: "team-a",
        actorId: "sales-a",
        sessionId: "session-stale-content"
      },
      snapshot: staleClientSnapshot
    }),
    /MODEL_CONTENT_HASH_MISMATCH/
  );
}

{
  const store = {
    aiModelConfigs: [{
      id: "connection-bound-server-side",
      ownerId: "owner-a",
      teamId: "team-a",
      provider: "moonshot",
      protocol: "openai-compatible" as const,
      name: "server-bound",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k3",
      apiKey: "",
      enabled: true,
      temperature: 0,
      useLeadFinder: true,
      useWebsiteParse: true,
      useScoring: true,
      useEmailDraft: true,
      useExam: false,
      lastTestStatus: "passed" as const,
      lastTestMessage: "",
      credentialVersion: 4,
      capabilitySnapshot: storedSnapshot.capabilitySnapshot,
      createdAt: storedSnapshot.createdAt,
      updatedAt: storedSnapshot.createdAt
    }, {
      id: "connection-selected-server-side",
      ownerId: "owner-a",
      teamId: "team-a",
      provider: "qwen",
      protocol: "openai-compatible" as const,
      name: "server-selected",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      apiKey: "",
      enabled: false,
      temperature: 0,
      useLeadFinder: true,
      useWebsiteParse: true,
      useScoring: true,
      useEmailDraft: true,
      useExam: false,
      lastTestStatus: "passed" as const,
      lastTestMessage: "",
      credentialVersion: 7,
      capabilitySnapshot: storedSnapshot.capabilitySnapshot,
      createdAt: storedSnapshot.createdAt,
      updatedAt: storedSnapshot.createdAt
    }],
    modelCredentialVersions: [],
    aiJobModelSnapshots: [],
    pendingAiJobModelSnapshots: [],
    modelCallRecords: [],
    pendingModelCallRecords: []
  };
  const bound = bindActiveAcquisitionModelSnapshot(store, {
    jobId: "job-server-bound",
    ownerId: "owner-a",
    teamId: "team-a"
  });
  assert.equal(bound.connectionId, "connection-bound-server-side");
  assert.equal(bound.credentialVersion, 4);
  assert.equal(bound.promptVersion, ACQUISITION_MODEL_PROMPT_VERSION);
  assert.equal(bound.schemaVersion, ACQUISITION_MODEL_SCHEMA_VERSION);
  assert.deepEqual({
    promptHash: bound.promptHash,
    schemaHash: bound.schemaHash
  }, ACQUISITION_MODEL_CONTENT_HASHES);
  const selected = bindActiveAcquisitionModelSnapshot(store, {
    jobId: "job-server-selected",
    ownerId: "owner-a",
    teamId: "team-a",
    connectionId: "connection-selected-server-side"
  } as Parameters<typeof bindActiveAcquisitionModelSnapshot>[1]);
  assert.equal(selected.connectionId, "connection-selected-server-side");
  assert.equal(selected.credentialVersion, 7);
  assert.deepEqual({
    promptHash: selected.promptHash,
    schemaHash: selected.schemaHash
  }, ACQUISITION_MODEL_CONTENT_HASHES);
}

console.log("acquisition Pi runtime factory tests passed");
