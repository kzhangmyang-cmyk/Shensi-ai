import { createHash, randomUUID } from "node:crypto";
import {
  createCredentialRef,
  encryptAiModelApiKey
} from "../credential-security.js";
import {
  MODEL_PROVIDER_IDS,
  ModelConnectionError
} from "./types.js";
import type { AiModelConfig } from "../types.js";
import type {
  ModelConnection,
  ModelConnectionActivationEvent,
  ModelConnectionScope,
  ModelCredentialVersion,
  StoredAiJobModelSnapshot
} from "./types.js";

export const requiredNodeVersion = ">=22.19.0";

export function createAiModelConfigId() {
  return `ai_${randomUUID()}`;
}

export const EMPTY_MODEL_CAPABILITY_SNAPSHOT = Object.freeze({
  structuredOutput: false,
  toolCalling: false,
  parallelToolCalling: false,
  streaming: false,
  modelListing: false
});

export function normalizeModelBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function modelConnectionFromAiConfig(
  config: AiModelConfig
): ModelConnection {
  if (!MODEL_PROVIDER_IDS.includes(
    config.provider as (typeof MODEL_PROVIDER_IDS)[number]
  )) {
    throw new ModelConnectionError(
      "connection_not_found",
      "该旧版模型配置不属于受支持的官方 Provider",
      404
    );
  }
  return {
    id: config.id,
    ownerId: config.ownerId,
    teamId: config.teamId,
    provider: config.provider as ModelConnection["provider"],
    model: config.model,
    endpointProfileId: config.endpointProfileId,
    endpointRegion: config.endpointRegion,
    endpointWorkspaceId: config.endpointWorkspaceId || null,
    adapterVersion: config.adapterVersion,
    baseUrlFingerprint: `sha256:${createHash("sha256")
      .update(normalizeModelBaseUrl(config.baseUrl))
      .digest("hex")}`,
    credentialVersion: config.credentialVersion || 1,
    capabilitySnapshot: {
      ...EMPTY_MODEL_CAPABILITY_SNAPSHOT,
      ...(config.capabilitySnapshot || {})
    },
    capabilityCertificationHash: config.capabilityCertificationHash,
    status: config.enabled ? "active" : "inactive",
    createdAt: config.createdAt || config.updatedAt,
    updatedAt: config.updatedAt
  };
}

interface LegacyActiveConnection {
  id: string;
  ownerId: string;
  teamId: string;
  enabled: boolean;
  updatedAt: string;
}

function modelConnectionScopeKey(ownerId: string, teamId: string) {
  return JSON.stringify([ownerId, teamId]);
}

export function selectLegacyActiveConnectionIds(
  connections: LegacyActiveConnection[]
) {
  const selected = new Map<string, string>();
  const enabled = connections
    .filter((item) => item.enabled)
    .sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return left.updatedAt < right.updatedAt ? 1 : -1;
      }
      if (left.id === right.id) return 0;
      return left.id < right.id ? -1 : 1;
    });
  for (const item of enabled) {
    const scopeKey = modelConnectionScopeKey(item.ownerId, item.teamId);
    if (!selected.has(scopeKey)) selected.set(scopeKey, item.id);
  }
  return selected;
}

export interface ModelConnectionActivationStore {
  connections: ModelConnection[];
  activationEvents: ModelConnectionActivationEvent[];
  pendingActivationEvents?: ModelConnectionActivationEvent[];
  persist(): Promise<void>;
  activateModelConnectionTransaction?(
    scope: ModelConnectionScope,
    connectionId: string,
    actorId: string,
    reason: string
  ): Promise<ModelConnection>;
}

export async function activateModelConnection(
  store: ModelConnectionActivationStore,
  scope: ModelConnectionScope,
  connectionId: string,
  actorId: string,
  reason: string
) {
  if (store.activateModelConnectionTransaction) {
    return store.activateModelConnectionTransaction(
      scope,
      connectionId,
      actorId,
      reason
    );
  }
  const target = store.connections.find(
    (item) => item.id === connectionId
      && item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
  );
  if (!target) {
    throw new ModelConnectionError(
      "connection_not_found",
      "模型连接不存在或不属于当前用户",
      404
    );
  }
  const previous = store.connections.find(
    (item) => item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
      && item.status === "active"
  );
  const before = store.connections.map((item) => ({
    item,
    status: item.status,
    updatedAt: item.updatedAt
  }));
  const now = new Date().toISOString();
  for (const item of store.connections) {
    if (item.ownerId !== scope.ownerId || item.teamId !== scope.teamId) {
      continue;
    }
    item.status = item.id === target.id ? "active" : "inactive";
    item.updatedAt = now;
  }
  const event: ModelConnectionActivationEvent = {
    id: `mca_${randomUUID()}`,
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    actorId,
    previousConnectionId: previous?.id || null,
    connectionId: target.id,
    reason,
    createdAt: now
  };
  store.activationEvents.push(event);
  store.pendingActivationEvents?.push(event);
  try {
    await store.persist();
  } catch (error) {
    for (const state of before) {
      state.item.status = state.status;
      state.item.updatedAt = state.updatedAt;
    }
    store.activationEvents.pop();
    if (store.pendingActivationEvents?.at(-1) === event) {
      store.pendingActivationEvents.pop();
    }
    throw error;
  }
  return target;
}

export function createModelCredentialVersion(
  credentials: ModelCredentialVersion[],
  connection: ModelConnection,
  apiKey: string,
  actorId: string,
  now = new Date().toISOString(),
  pendingCredentials?: ModelCredentialVersion[]
) {
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) {
    throw new ModelConnectionError(
      "credential_not_found",
      "API Key 不能为空",
      404
    );
  }
  const existingVersions = credentials
    .filter((item) => item.connectionId === connection.id)
    .map((item) => item.version);
  const version = existingVersions.length
    ? Math.max(...existingVersions) + 1
    : 1;
  const teamId = connection.teamId || "";
  const credential: ModelCredentialVersion = {
    connectionId: connection.id,
    provider: connection.provider,
    ownerId: connection.ownerId,
    teamId,
    version,
    credentialRef: createCredentialRef(),
    apiKeyEncrypted: encryptAiModelApiKey({
      id: connection.id,
      provider: connection.provider,
      ownerId: connection.ownerId,
      teamId
    }, normalizedKey),
    keyMask: normalizedKey.slice(-4),
    createdBy: actorId,
    createdAt: now
  };
  credentials.push(credential);
  pendingCredentials?.push(credential);
  connection.credentialVersion = version;
  connection.updatedAt = now;
  return credential;
}

export function toPublicModelConnection(
  connection: ModelConnection,
  credential?: ModelCredentialVersion
) {
  return {
    ...connection,
    hasKey: Boolean(credential),
    apiKey: credential ? `****${credential.keyMask}` : ""
  };
}

interface ModelConnectionDeletionStore {
  connections: ModelConnection[];
  jobSnapshots: StoredAiJobModelSnapshot[];
  activationEvents?: ModelConnectionActivationEvent[];
  persist(): Promise<void>;
  deleteModelConnectionTransaction?(
    scope: ModelConnectionScope,
    connectionId: string,
    options?: ModelConnectionDeletionOptions
  ): Promise<ModelConnection>;
}

export const DEFAULT_MODEL_CONNECTION_ACTIVATION_AUDIT_RETENTION_MS =
  90 * 24 * 60 * 60 * 1_000;

export interface ModelConnectionDeletionOptions {
  now?: () => Date;
  activationAuditRetentionMs?: number;
}

export async function deleteModelConnection(
  store: ModelConnectionDeletionStore,
  scope: ModelConnectionScope,
  connectionId: string,
  options: ModelConnectionDeletionOptions = {}
) {
  if (store.deleteModelConnectionTransaction) {
    return store.deleteModelConnectionTransaction(
      scope,
      connectionId,
      options
    );
  }
  const index = store.connections.findIndex(
    (item) => item.id === connectionId
      && item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
  );
  if (index < 0) {
    throw new ModelConnectionError(
      "connection_not_found",
      "模型连接不存在或不属于当前用户",
      404
    );
  }
  const retentionMs =
    Number.isFinite(options.activationAuditRetentionMs)
      && Number(options.activationAuditRetentionMs) >= 0
      ? Number(options.activationAuditRetentionMs)
      : DEFAULT_MODEL_CONNECTION_ACTIVATION_AUDIT_RETENTION_MS;
  const nowMs = (options.now?.() || new Date()).getTime();
  const retainedByAudit = (store.activationEvents || []).some(
    (item) => item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
      && (
        item.connectionId === connectionId
        || item.previousConnectionId === connectionId
      )
      && new Date(item.createdAt).getTime() + retentionMs > nowMs
  );
  if (store.connections[index].status === "active"
    || store.jobSnapshots.some(
    (item) => item.connectionId === connectionId
      && item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
    )
    || retainedByAudit) {
    throw new ModelConnectionError(
      "connection_in_use",
      "模型连接仍在启用、被任务快照引用或处于激活审计保留期",
      409
    );
  }
  const [removed] = store.connections.splice(index, 1);
  try {
    await store.persist();
  } catch (error) {
    store.connections.splice(index, 0, removed);
    throw error;
  }
  return removed;
}
