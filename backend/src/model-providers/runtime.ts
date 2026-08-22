import { createHash, randomUUID } from "node:crypto";
import { decryptAiModelApiKey } from "../credential-security.js";
import type { AiModelConfig } from "../types.js";
import {
  AppendOnlyModelCallLedger
} from "./call-ledger.js";
import type {
  AppendOnlyModelCallLedgerOptions,
  ModelCallLedger,
  ModelCallRecord,
  NewModelCallRecord
} from "./call-ledger.js";
import {
  ActiveModelGateway,
  type ModelContentBundle
} from "./gateway.js";
import { createAiJobModelSnapshot } from "./job-snapshot.js";
import {
  modelConnectionFromAiConfig,
  normalizeModelBaseUrl
} from "./connection-service.js";
import type {
  ModelCredentialVersion,
  StoredAiJobModelSnapshot
} from "./types.js";
import {
  MODEL_PROVIDER_IDS
} from "./types.js";

export interface ModelRuntimeStore {
  aiModelConfigs: AiModelConfig[];
  modelCredentialVersions: ModelCredentialVersion[];
  aiJobModelSnapshots: StoredAiJobModelSnapshot[];
  pendingAiJobModelSnapshots: StoredAiJobModelSnapshot[];
  modelCallRecords: ModelCallRecord[];
  pendingModelCallRecords: ModelCallRecord[];
  persist?(): Promise<void>;
}

export interface BindActiveModelSnapshotInput {
  jobId: string;
  ownerId: string;
  teamId: string;
  promptVersion: string;
  schemaVersion: string;
  promptHash: string;
  schemaHash: string;
}

export interface BindModelConnectionSnapshotInput
  extends BindActiveModelSnapshotInput {
  connectionId: string;
}

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function bindActiveModelSnapshot(
  store: ModelRuntimeStore,
  input: BindActiveModelSnapshotInput
) {
  const existing = store.aiJobModelSnapshots.find(
    (item) => item.jobId === input.jobId
      && item.ownerId === input.ownerId
      && item.teamId === input.teamId
  );
  if (existing) return existing;
  const active = store.aiModelConfigs.find(
    (item) => item.ownerId === input.ownerId
      && item.teamId === input.teamId
      && item.enabled
      && MODEL_PROVIDER_IDS.includes(
        item.provider as (typeof MODEL_PROVIDER_IDS)[number]
      )
  );
  if (!active) {
    throw new Error("No active official model connection for AI job");
  }
  return bindModelConnectionSnapshot(store, {
    ...input,
    connectionId: active.id
  });
}

export type DurableModelRuntimeStore = ModelRuntimeStore & {
  persist(): Promise<void>;
};

const durableSnapshotBindingTails = new WeakMap<
  DurableModelRuntimeStore,
  Promise<void>
>();

function exactStoredSnapshotBinding(
  snapshot: StoredAiJobModelSnapshot,
  input: BindActiveModelSnapshotInput
) {
  return snapshot.jobId === input.jobId
    && snapshot.ownerId === input.ownerId
    && snapshot.teamId === input.teamId
    && snapshot.promptVersion === input.promptVersion
    && snapshot.schemaVersion === input.schemaVersion
    && snapshot.promptHash === input.promptHash
    && snapshot.schemaHash === input.schemaHash;
}

/**
 * Binds one immutable job identity and durably stores a new snapshot before
 * callers are allowed to contact the provider.
 */
export async function bindActiveModelSnapshotDurably(
  store: DurableModelRuntimeStore,
  input: BindActiveModelSnapshotInput
) {
  const predecessor = durableSnapshotBindingTails.get(store)
    ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  durableSnapshotBindingTails.set(store, predecessor.then(() => turn));
  await predecessor;
  try {
    const existing = store.aiJobModelSnapshots.find(
      (item) => item.jobId === input.jobId
    );
    if (existing && !exactStoredSnapshotBinding(existing, input)) {
      throw new Error("AI job snapshot immutable identity mismatch");
    }
    const snapshot = existing ?? bindActiveModelSnapshot(store, input);
    if (!exactStoredSnapshotBinding(snapshot, input)) {
      throw new Error("AI job snapshot immutable identity mismatch");
    }
    if (store.pendingAiJobModelSnapshots.some(
      (item) => item.jobId === snapshot.jobId
    )) {
      await store.persist();
    }
    return snapshot;
  } finally {
    release();
  }
}

export function bindModelConnectionSnapshot(
  store: ModelRuntimeStore,
  input: BindModelConnectionSnapshotInput
) {
  const existing = store.aiJobModelSnapshots.find(
    (item) => item.jobId === input.jobId
      && item.ownerId === input.ownerId
      && item.teamId === input.teamId
  );
  if (existing) return existing;
  const config = store.aiModelConfigs.find(
    (item) => item.id === input.connectionId
      && item.ownerId === input.ownerId
      && item.teamId === input.teamId
  );
  if (!config) {
    throw new Error("Official model connection for AI job is unavailable");
  }
  if (!input.promptHash || !input.schemaHash) {
    throw new Error("AI job content hashes are required");
  }
  const connection = modelConnectionFromAiConfig(config);
  const normalizedBaseUrl = normalizeModelBaseUrl(config.baseUrl);
  const snapshot: StoredAiJobModelSnapshot = Object.freeze({
    ...createAiJobModelSnapshot(
      connection,
      config.credentialVersion || connection.credentialVersion,
      {
        promptVersion: input.promptVersion,
        schemaVersion: input.schemaVersion
      }
    ),
    jobId: input.jobId,
    ownerId: input.ownerId,
    teamId: input.teamId,
    baseUrl: normalizedBaseUrl,
    baseUrlFingerprint: sha256(normalizedBaseUrl),
    promptHash: input.promptHash,
    schemaHash: input.schemaHash,
    createdAt: new Date().toISOString()
  });
  store.aiJobModelSnapshots.push(snapshot);
  store.pendingAiJobModelSnapshots.push(snapshot);
  return snapshot;
}

export async function resolveSnapshottedModelCredential(
  store: Pick<
    ModelRuntimeStore,
    "modelCredentialVersions"
  >,
  snapshot: StoredAiJobModelSnapshot
) {
  const credential = store.modelCredentialVersions.find(
    (item) => item.connectionId === snapshot.connectionId
      && item.version === snapshot.credentialVersion
  );
  if (!credential) {
    throw new Error("Snapshotted credential version is unavailable");
  }
  if (!credential.provider
    || credential.provider !== snapshot.provider
    || credential.ownerId !== snapshot.ownerId
    || credential.teamId !== snapshot.teamId) {
    throw new Error("Snapshotted credential immutable identity mismatch");
  }
  return decryptAiModelApiKey({
    id: snapshot.connectionId,
    provider: snapshot.provider,
    ownerId: snapshot.ownerId,
    teamId: snapshot.teamId
  }, credential.apiKeyEncrypted);
}

export function createStoreModelCallLedger(
  store: Pick<
    ModelRuntimeStore,
    "modelCallRecords" | "pendingModelCallRecords"
  >,
  options: AppendOnlyModelCallLedgerOptions = {}
): ModelCallLedger {
  const allocator = new AppendOnlyModelCallLedger(options);
  return {
    append(record: NewModelCallRecord) {
      const stored = allocator.append(record);
      store.modelCallRecords.push(stored);
      store.pendingModelCallRecords.push(stored);
      return stored;
    },
    get records() {
      return Object.freeze([...store.modelCallRecords]);
    }
  };
}

export interface CreateActiveModelGatewayForSnapshotOptions {
  storedSnapshot: StoredAiJobModelSnapshot;
  fetch: typeof fetch;
  attemptIdFactory?: () => string;
  requestIdFactory?: () => string;
  now?: () => number;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  contentBundle?: ModelContentBundle;
}

export function createActiveModelGatewayForSnapshot(
  store: ModelRuntimeStore,
  options: CreateActiveModelGatewayForSnapshotOptions
) {
  if (!options.storedSnapshot.baseUrl
    || !options.storedSnapshot.baseUrlFingerprint) {
    throw new Error("Snapshotted model endpoint is unavailable");
  }
  if (!options.storedSnapshot.promptHash
    || !options.storedSnapshot.schemaHash) {
    throw new Error("Snapshotted model content hashes are unavailable");
  }
  const capabilitySnapshotHash = sha256(
    JSON.stringify(options.storedSnapshot.capabilitySnapshot)
  );
  return new ActiveModelGateway({
    snapshot: options.storedSnapshot,
    identity: {
      ownerId: options.storedSnapshot.ownerId,
      teamId: options.storedSnapshot.teamId,
      jobId: options.storedSnapshot.jobId
    },
    capabilitySnapshotHash,
    baseUrl: options.storedSnapshot.baseUrl,
    baseUrlFingerprint: options.storedSnapshot.baseUrlFingerprint,
    credentialResolver: () =>
      resolveSnapshottedModelCredential(store, options.storedSnapshot),
    fetch: options.fetch,
    ledger: createStoreModelCallLedger(store),
    persistAttempt: store.persist
      ? () => store.persist!()
      : undefined,
    attemptIdFactory:
      options.attemptIdFactory
      ?? (() => `model_attempt_${randomUUID()}`),
    requestIdFactory:
      options.requestIdFactory
      ?? (() => `model_request_${randomUUID()}`),
    now: options.now,
    requestTimeoutMs: options.requestTimeoutMs,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    contentBundle: options.contentBundle
  });
}
