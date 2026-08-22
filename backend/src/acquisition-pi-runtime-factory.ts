import { createHash } from "node:crypto";
import {
  createAiHttpClient
} from "./ai-http-security.js";
import type {
  AcquisitionPiRuntimeFactory,
  AcquisitionPiRuntimeFactoryInput
} from "./acquisition-copilot-runner.js";
import {
  ActiveModelGatewayAcquisitionPiRuntime,
  type AcquisitionPiGatewayPort
} from "./acquisition-pi-gateway-runtime.js";
import {
  ACQUISITION_MODEL_CONTENT_HASHES,
  ACQUISITION_MODEL_PROMPT_VERSION,
  ACQUISITION_MODEL_SCHEMA_VERSION,
  DEFAULT_ACQUISITION_PI_SYSTEM_PROMPT,
  acquisitionModelContentForSnapshot
} from "./acquisition-model-content.js";
import {
  bindActiveModelSnapshot,
  bindModelConnectionSnapshot,
  createActiveModelGatewayForSnapshot,
  type ModelRuntimeStore
} from "./model-providers/runtime.js";
import {
  modelContentBundleHashes,
  type ModelContentBundle
} from "./model-providers/gateway.js";
import type {
  StoredAiJobModelSnapshot
} from "./model-providers/types.js";

export type AcquisitionModelSnapshotStore =
  Pick<ModelRuntimeStore, "aiJobModelSnapshots">
  & Partial<ModelRuntimeStore>;

export interface BindActiveAcquisitionModelSnapshotInput {
  jobId: string;
  ownerId: string;
  teamId: string;
  connectionId?: string;
}

/**
 * Server-side acquisition session/job binder. Callers supply only trusted
 * scope and the server-generated job id; model and content identities come
 * from the active official connection and this server bundle.
 */
export function bindActiveAcquisitionModelSnapshot(
  store: ModelRuntimeStore,
  input: BindActiveAcquisitionModelSnapshotInput
) {
  const content = {
    jobId: input.jobId,
    ownerId: input.ownerId,
    teamId: input.teamId,
    promptVersion: ACQUISITION_MODEL_PROMPT_VERSION,
    schemaVersion: ACQUISITION_MODEL_SCHEMA_VERSION,
    promptHash: ACQUISITION_MODEL_CONTENT_HASHES.promptHash,
    schemaHash: ACQUISITION_MODEL_CONTENT_HASHES.schemaHash
  };
  return input.connectionId
    ? bindModelConnectionSnapshot(store, {
        ...content,
        connectionId: input.connectionId
      })
    : bindActiveModelSnapshot(store, content);
}

export interface CreateAcquisitionPiRuntimeFactoryOptions {
  store: AcquisitionModelSnapshotStore;
  gatewayFactory?: (
    snapshot: StoredAiJobModelSnapshot,
    contentBundle: ModelContentBundle
  ) => AcquisitionPiGatewayPort;
  contentBundle?: ModelContentBundle;
  systemPrompt?: string;
}

function capabilityHash(snapshot: StoredAiJobModelSnapshot) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(snapshot.capabilitySnapshot))
    .digest("hex")}`;
}

function requireCompleteModelRuntimeStore(
  store: AcquisitionModelSnapshotStore
): ModelRuntimeStore {
  const arrays = [
    "aiModelConfigs",
    "modelCredentialVersions",
    "pendingAiJobModelSnapshots",
    "modelCallRecords",
    "pendingModelCallRecords"
  ] as const;
  for (const key of arrays) {
    if (!Array.isArray(store[key])) {
      throw new Error("MODEL_RUNTIME_STORE_INCOMPLETE");
    }
  }
  return store as ModelRuntimeStore;
}

function gatewayForContentBundle(
  store: AcquisitionModelSnapshotStore,
  snapshot: StoredAiJobModelSnapshot,
  contentBundle: ModelContentBundle
) {
  const completeStore = requireCompleteModelRuntimeStore(store);
  const client = createAiHttpClient(snapshot.baseUrl);
  return createActiveModelGatewayForSnapshot(completeStore, {
    storedSnapshot: snapshot,
    contentBundle,
    fetch: ((url: string | URL | Request, init?: RequestInit) =>
      client.fetch(String(url), init)) as typeof fetch
  });
}

export function createAcquisitionModelGatewayForSnapshot(
  store: AcquisitionModelSnapshotStore,
  snapshot: StoredAiJobModelSnapshot
) {
  const contentBundle = acquisitionModelContentForSnapshot(snapshot);
  return gatewayForContentBundle(
    store,
    snapshot,
    contentBundle
  );
}

function snapshotMatches(
  stored: StoredAiJobModelSnapshot,
  requested: Parameters<AcquisitionPiRuntimeFactory["create"]>[0]["snapshot"]
) {
  return stored.jobId === requested.jobId
    && stored.connectionId === requested.connectionId
    && stored.credentialVersion === requested.credentialVersion
    && stored.provider === requested.provider
    && stored.model === requested.model
    && stored.promptVersion === requested.promptVersion
    && stored.schemaVersion === requested.schemaVersion
    && stored.promptHash === requested.promptHash
    && stored.schemaHash === requested.schemaHash
    && capabilityHash(stored) === requested.capabilitySnapshotHash
    && stored.baseUrlFingerprint === requested.baseUrlFingerprint;
}

export function acquisitionPiModelSnapshotFromStored(
  stored: StoredAiJobModelSnapshot
) {
  return Object.freeze({
    jobId: stored.jobId,
    connectionId: stored.connectionId,
    credentialVersion: stored.credentialVersion,
    provider: stored.provider,
    model: stored.model,
    promptVersion: stored.promptVersion,
    schemaVersion: stored.schemaVersion,
    promptHash: stored.promptHash,
    schemaHash: stored.schemaHash,
    capabilitySnapshotHash: capabilityHash(stored),
    baseUrlFingerprint: stored.baseUrlFingerprint
  });
}

function resolveSnapshot(
  store: AcquisitionModelSnapshotStore,
  input: AcquisitionPiRuntimeFactoryInput
) {
  const stored = store.aiJobModelSnapshots.find((snapshot) =>
    snapshot.jobId === input.snapshot.jobId
    && snapshot.ownerId === input.identity.ownerId
    && snapshot.teamId === input.identity.teamId
  );
  if (!stored) {
    throw new Error("MODEL_SNAPSHOT_UNAVAILABLE");
  }
  if (!snapshotMatches(stored, input.snapshot)) {
    throw new Error("MODEL_SNAPSHOT_MISMATCH");
  }
  acquisitionModelContentForSnapshot(stored);
  if (!stored.capabilitySnapshot.toolCalling) {
    throw new Error("MODEL_TOOL_CALLING_UNAVAILABLE");
  }
  return structuredClone(stored);
}

export function resolveStoredAcquisitionModelSnapshot(
  store: AcquisitionModelSnapshotStore,
  input: AcquisitionPiRuntimeFactoryInput
) {
  return resolveSnapshot(store, input);
}

export function createAcquisitionPiRuntimeFactory(
  options: CreateAcquisitionPiRuntimeFactoryOptions
): AcquisitionPiRuntimeFactory {
  const systemPrompt = options.systemPrompt?.trim()
    || DEFAULT_ACQUISITION_PI_SYSTEM_PROMPT;
  return {
    async create(input) {
      const immutableSnapshot = resolveSnapshot(options.store, input);
      const registeredContentBundle =
        acquisitionModelContentForSnapshot(immutableSnapshot);
      const contentBundle =
        options.contentBundle ?? registeredContentBundle;
      const contentHashes = modelContentBundleHashes(contentBundle);
      if (immutableSnapshot.promptHash !== contentHashes.promptHash
        || immutableSnapshot.schemaHash !== contentHashes.schemaHash) {
        throw new Error("MODEL_CONTENT_HASH_MISMATCH");
      }
      const gateway = options.gatewayFactory
        ? options.gatewayFactory(immutableSnapshot, contentBundle)
        : gatewayForContentBundle(
            options.store,
            immutableSnapshot,
            contentBundle
          );
      return new ActiveModelGatewayAcquisitionPiRuntime({
        snapshot: structuredClone(input.snapshot),
        gateway,
        contentBundle,
        systemPrompt
      });
    }
  };
}
