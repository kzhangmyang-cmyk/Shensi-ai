import type { ModelEndpointProfileId } from "./endpoint-profiles.js";
import type { ModelProviderId } from "./types.js";

export interface NormalizedProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
}

export interface ProviderResponseMetadata {
  providerRequestId: string | null;
  usage: NormalizedProviderUsage | null;
}

export interface ProviderResponseMetadataInput {
  headers?: HeadersInit;
  body: unknown;
}

export type ProviderErrorContract =
  | "documented_envelope"
  | "documented_business_status"
  | "http_status_only"
  | "shape_unverified";

export interface ProviderBusinessErrorInput {
  status: number;
  headers?: HeadersInit;
  body: unknown;
}

export interface NormalizedProviderBusinessError {
  provider: ModelProviderId;
  source: "http" | "business";
  httpStatus: number;
  code: string | null;
  type: string | null;
  message: string | null;
  providerRequestId: string | null;
  retryAfterMs: number | null;
}

export type ExactModelCapabilityName =
  | "chatCompletions"
  | "responses"
  | "streaming"
  | "toolCalling"
  | "parallelToolCalling"
  | "jsonObject"
  | "jsonSchema";

export type ExactModelCapabilityStatus =
  | "certified_supported"
  | "certified_unsupported"
  | "unverified";

export type ExactModelCapabilityStatuses = Readonly<
  Record<ExactModelCapabilityName, ExactModelCapabilityStatus>
>;

export interface ExactModelCapabilityEvidence {
  model: string;
  evidenceDate: string;
  officialReference: string;
}

export interface ExactModelCapabilityCertification {
  provider: ModelProviderId;
  profileId: ModelEndpointProfileId;
  model: string;
  capabilities: ExactModelCapabilityStatuses;
  evidence: Readonly<ExactModelCapabilityEvidence> | null;
}

export interface ExactModelCapabilityCertificationInput {
  profileId: ModelEndpointProfileId;
  model: string;
}

export interface LiveSmokeReadinessInput {
  profileId: ModelEndpointProfileId;
  model: string;
  credential?: string;
}

export type LiveSmokeReadiness =
  | {
      provider: ModelProviderId;
      profileId: ModelEndpointProfileId;
      model: string;
      status: "not_run";
      reason: "missing_api_key";
    }
  | {
      provider: ModelProviderId;
      profileId: ModelEndpointProfileId;
      model: string;
      status: "ready";
      reason: null;
    };

export interface OfficialModelAdapterRegistration {
  provider: ModelProviderId;
  endpointProfileIds: readonly ModelEndpointProfileId[];
  errorContract: ProviderErrorContract;
  extractResponseMetadata(
    input: ProviderResponseMetadataInput
  ): ProviderResponseMetadata;
  parseBusinessError(
    input: ProviderBusinessErrorInput
  ): NormalizedProviderBusinessError | null;
  certifyExactModelCapabilities(
    input: ExactModelCapabilityCertificationInput
  ): Readonly<ExactModelCapabilityCertification>;
  evaluateLiveSmokeReadiness(
    input: LiveSmokeReadinessInput
  ): Readonly<LiveSmokeReadiness>;
}
