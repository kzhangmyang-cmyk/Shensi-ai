import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createMysqlStore } from "../src/mysql-store.js";
import { hashModelCallValue } from
  "../src/model-providers/call-ledger.js";
import { ModelGatewayError } from "../src/model-providers/gateway.js";
import { bindModelConnectionSnapshotDurably,
  createActiveModelGatewayForSnapshot,
  readFinancialCouncilModelRoutingRuntimeState,
  type DurableModelRuntimeStore } from
  "../src/model-providers/runtime.js";
import type { ModelConnection } from "../src/model-providers/types.js";

const HASH = /^sha256:[0-9a-f]{64}$/u;
const OUTPUT_SCHEMA = z.object({ ok: z.literal(true) }).strict();
const SYSTEM_PROMPT = [
  "Return one minimal JSON object matching the supplied schema.",
  "Do not include explanations or business data."
].join("\n");
const USER_PROMPT = "Return {\"ok\":true}.";
const PROMPT_BINDING = Object.freeze({
  systemPrompt: SYSTEM_PROMPT,
  userPrompt: USER_PROMPT
});
const PROMPT_HASH = hashModelCallValue(PROMPT_BINDING);
const SCHEMA_HASH = hashModelCallValue(Object.freeze({
  type: "object", additionalProperties: false,
  required: Object.freeze(["ok"]), properties: Object.freeze({
    ok: Object.freeze({ const: true })
  })
}));

export interface LiveProviderSmokeStore {
  readonly connections: readonly ModelConnection[];
}
export interface LiveProviderPair {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly primary: ModelConnection;
  readonly fallback: ModelConnection;
}

export interface LiveProviderMetadata {
  readonly connectionId: string;
  readonly provider: string;
  readonly model: string;
  readonly requestId: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly status: "succeeded";
  readonly errorCode: null;
}

export type LiveProviderSmokePhase = "certification" | "fallback_drill";

export interface LiveProviderSmokeDependencies {
  invoke(connection: ModelConnection, phase: LiveProviderSmokePhase):
  Promise<LiveProviderMetadata>;
}

function readiness(code: string): never {
  const error = new Error(code);
  error.name = "FinancialCouncilLiveProviderReadinessError";
  throw error;
}

function connectionById(store: LiveProviderSmokeStore, id: string) {
  if (typeof id !== "string" || !id.trim()) {
    readiness("LIVE_PROVIDER_CONNECTION_IDS_REQUIRED");
  }
  const matches = store.connections.filter((item) => item.id === id);
  if (matches.length !== 1) readiness("LIVE_PROVIDER_CONNECTION_NOT_FOUND");
  return matches[0]!;
}

function certified(connection: ModelConnection) {
  if (connection.status !== "active") {
    readiness("LIVE_PROVIDER_CONNECTION_NOT_ACTIVE");
  }
  if (connection.capabilitySnapshot.structuredOutput !== true
    || !HASH.test(connection.capabilityCertificationHash ?? "")) {
    readiness("LIVE_PROVIDER_CONNECTION_NOT_CERTIFIED");
  }
  if (!connection.ownerId.trim() || !connection.teamId?.trim()) {
    readiness("LIVE_PROVIDER_CONNECTION_SCOPE_INVALID");
  }
}

export function resolveLiveProviderPair(
  store: LiveProviderSmokeStore,
  input: { readonly primaryConnectionId: string;
    readonly fallbackConnectionId: string }
): LiveProviderPair {
  if (input.primaryConnectionId === input.fallbackConnectionId) {
    readiness("LIVE_PROVIDER_PAIR_MUST_USE_DISTINCT_CONNECTIONS");
  }
  const primary = connectionById(store, input.primaryConnectionId);
  const fallback = connectionById(store, input.fallbackConnectionId);
  certified(primary); certified(fallback);
  if (primary.provider === fallback.provider) {
    readiness("LIVE_PROVIDER_PAIR_MUST_USE_DISTINCT_PROVIDERS");
  }
  if (primary.ownerId !== fallback.ownerId
    || primary.teamId !== fallback.teamId) {
    readiness("LIVE_PROVIDER_PAIR_WORKSPACE_MISMATCH");
  }
  return Object.freeze({ workspaceId: primary.teamId!,
    ownerId: primary.ownerId, primary, fallback });
}

function metadata(value: LiveProviderMetadata): LiveProviderMetadata {
  if (!value || Object.keys(value).sort().join("\0") !== [
    "connectionId", "provider", "model", "requestId", "latencyMs",
    "inputTokens", "outputTokens", "status", "errorCode"
  ].sort().join("\0") || value.status !== "succeeded"
    || value.errorCode !== null || !value.connectionId.trim()
    || !value.provider.trim() || !value.model.trim() || !value.requestId.trim()
    || ![value.latencyMs, value.inputTokens, value.outputTokens].every(
      (item) => Number.isSafeInteger(item) && item >= 0)) {
    readiness("LIVE_PROVIDER_RESULT_METADATA_INVALID");
  }
  return Object.freeze({ ...value });
}

export async function runLiveProviderSmoke(
  pair: LiveProviderPair,
  dependencies: LiveProviderSmokeDependencies
) {
  const primary = metadata(await dependencies.invoke(
    pair.primary, "certification"
  ));
  const fallback = metadata(await dependencies.invoke(
    pair.fallback, "certification"
  ));
  const attempt1 = Object.freeze({
    connectionId: pair.primary.id,
    provider: pair.primary.provider,
    model: pair.primary.model,
    attempt: 1,
    status: "failed" as const,
    errorCode: "LIVE_PROVIDER_INJECTED_RETRYABLE" as const,
    retryable: true as const,
    networkBytes: 0 as const
  });
  const attempt2 = metadata(await dependencies.invoke(
    pair.fallback, "fallback_drill"
  ));
  return Object.freeze({
    primary,
    fallback,
    structuredOutput: Object.freeze({ primary: true, fallback: true }),
    fallbackDrill: Object.freeze({ attempt1, attempt2 })
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) readiness(`${name}_REQUIRED`);
  return value;
}

function safeGatewayCode(error: unknown): string {
  return error instanceof ModelGatewayError
    ? error.code : "LIVE_PROVIDER_CALL_FAILED";
}

function createLiveInvoker(store: DurableModelRuntimeStore) {
  let sequence = 0;
  return async (connection: ModelConnection, phase: LiveProviderSmokePhase):
  Promise<LiveProviderMetadata> => {
    sequence += 1;
    const requestId = `financial-council-live-${randomUUID()}`;
    const jobId = `financial-council-live:${Date.now()}:${sequence}:${phase}`;
    const snapshot = await bindModelConnectionSnapshotDurably(store, {
      jobId, ownerId: connection.ownerId, teamId: connection.teamId!,
      connectionId: connection.id,
      promptVersion: "financial-council-live-smoke.v1",
      schemaVersion: "financial-council-live-smoke.v1",
      promptHash: PROMPT_HASH, schemaHash: SCHEMA_HASH
    });
    const startedAt = Date.now();
    try {
      const gateway = createActiveModelGatewayForSnapshot(store, {
        storedSnapshot: snapshot, fetch,
        requestIdFactory: () => requestId,
        requestTimeoutMs: 30_000
      });
      const result = await gateway.generateStructured({
        systemPrompt: SYSTEM_PROMPT, prompt: USER_PROMPT,
        schema: OUTPUT_SCHEMA, schemaHash: SCHEMA_HASH
      });
      if (result.value.ok !== true) readiness("LIVE_PROVIDER_OUTPUT_INVALID");
      return Object.freeze({ connectionId: connection.id,
        provider: connection.provider, model: connection.model, requestId,
        latencyMs: Math.max(0, Date.now() - startedAt),
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        status: "succeeded" as const, errorCode: null });
    } catch (error) {
      readiness(safeGatewayCode(error));
    }
  };
}

export async function main(): Promise<void> {
  requiredEnvironment("DATABASE_URL");
  const primaryConnectionId = requiredEnvironment(
    "FINANCIAL_COUNCIL_LIVE_PRIMARY_CONNECTION_ID"
  );
  const fallbackConnectionId = requiredEnvironment(
    "FINANCIAL_COUNCIL_LIVE_FALLBACK_CONNECTION_ID"
  );
  const store = await createMysqlStore() as DurableModelRuntimeStore & {
    close?: () => Promise<void>;
  };
  try {
    const runtime = readFinancialCouncilModelRoutingRuntimeState(store);
    const pair = resolveLiveProviderPair({ connections: runtime.connections }, {
      primaryConnectionId, fallbackConnectionId
    });
    const output = await runLiveProviderSmoke(pair, {
      invoke: createLiveInvoker(store)
    });
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } finally {
    await store.close?.();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const code = error instanceof Error
      && /^[A-Z0-9_:-]+$/u.test(error.message)
      ? error.message : "LIVE_PROVIDER_SMOKE_FAILED";
    process.stderr.write(`${JSON.stringify({
      event: "financial_council_live_provider_blocked", code
    })}\n`);
    process.exitCode = 1;
  });
}
