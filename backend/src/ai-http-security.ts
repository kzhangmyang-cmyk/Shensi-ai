import type { ProviderNetworkPolicy } from "./provider-contract.js";
import {
  assertProviderBaseUrlAllowed,
  createProviderHttpClient
} from "./provider-http-client.js";
import {
  MODEL_ENDPOINT_PROFILES
} from "./model-providers/endpoint-profiles.js";

const AI_HTTP_TIMEOUT_MS = 120_000;
const AI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const OFFICIAL_STATIC_AI_ENDPOINTS = new Set(
  MODEL_ENDPOINT_PROFILES.flatMap((profile) =>
    profile.baseUrl ? [profile.baseUrl.replace(/\/+$/, "")] : []
  )
);

function aiNetworkPolicy(rawBaseUrl: string): ProviderNetworkPolicy {
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error("AI Base URL 格式不正确");
  }
  const basePath = baseUrl.pathname || "/";
  const normalizedBaseUrl = rawBaseUrl.replace(/\/+$/, "");
  return {
    allowedHosts: [baseUrl.hostname.toLocaleLowerCase()],
    allowedPathPrefixes: [basePath],
    allowedMethods: ["POST"],
    allowSyntheticProxyAddresses:
      OFFICIAL_STATIC_AI_ENDPOINTS.has(normalizedBaseUrl),
    timeoutMs: AI_HTTP_TIMEOUT_MS,
    maxResponseBytes: AI_MAX_RESPONSE_BYTES
  };
}

export function assertAiBaseUrlAllowed(rawBaseUrl: string) {
  const normalized = rawBaseUrl.replace(/\/+$/, "");
  assertProviderBaseUrlAllowed(normalized, aiNetworkPolicy(normalized));
  return normalized;
}

export function createAiHttpClient(rawBaseUrl: string) {
  const normalized = assertAiBaseUrlAllowed(rawBaseUrl);
  return createProviderHttpClient(aiNetworkPolicy(normalized));
}
