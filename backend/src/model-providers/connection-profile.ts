import { createHash } from "node:crypto";
import {
  MODEL_ENDPOINT_PROFILES,
  resolveModelEndpointProfile
} from "./endpoint-profiles.js";
import type {
  ModelEndpointProfileId
} from "./endpoint-profiles.js";
import {
  getOfficialModelAdapterRegistration
} from "./adapter-registry.js";
import type {
  ExactModelCapabilityCertification
} from "./official-adapter.js";
import type {
  ModelCapabilitySnapshot,
  ModelProviderId
} from "./types.js";

export interface OfficialModelConnectionProfile {
  provider: ModelProviderId;
  endpointProfileId: ModelEndpointProfileId;
  region: string;
  baseUrl: string;
  workspaceId: string | null;
  model: string;
  adapterVersion: "official-openai-compatible.v1";
  capabilitySnapshot: Readonly<ModelCapabilitySnapshot>;
  certification: Readonly<ExactModelCapabilityCertification>;
  certificationHash: string;
}

export interface OfficialModelEndpointOption {
  provider: ModelProviderId;
  endpointProfileId: ModelEndpointProfileId;
  region: string;
  baseUrl: string | null;
  requiresWorkspaceId: boolean;
  modelListPolicy: "same_key" | "not_exposed" | "separate_control_plane";
  officialReference: string;
}

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function supported(
  certification: Readonly<ExactModelCapabilityCertification>,
  capability: keyof ExactModelCapabilityCertification["capabilities"]
) {
  return certification.capabilities[capability] === "certified_supported";
}

export function buildOfficialModelConnectionProfile(input: {
  provider: ModelProviderId;
  baseUrl: string;
  model: string;
}): Readonly<OfficialModelConnectionProfile> {
  const endpoint = resolveModelEndpointProfile({
    provider: input.provider,
    baseUrl: input.baseUrl
  });
  const registration = getOfficialModelAdapterRegistration(input.provider);
  const certification = registration.certifyExactModelCapabilities({
    profileId: endpoint.id,
    model: input.model
  });
  const capabilitySnapshot = Object.freeze({
    structuredOutput:
      supported(certification, "jsonObject")
      || supported(certification, "jsonSchema"),
    toolCalling: supported(certification, "toolCalling"),
    parallelToolCalling: supported(
      certification,
      "parallelToolCalling"
    ),
    streaming: supported(certification, "streaming"),
    modelListing: endpoint.modelList.policy === "same_key"
  });
  const certificationHash = sha256(JSON.stringify({
    provider: input.provider,
    profileId: endpoint.id,
    model: input.model,
    capabilities: certification.capabilities,
    evidence: certification.evidence
  }));

  return Object.freeze({
    provider: input.provider,
    endpointProfileId: endpoint.id,
    region: endpoint.region,
    baseUrl: endpoint.baseUrl,
    workspaceId: endpoint.workspaceId,
    model: input.model,
    adapterVersion: "official-openai-compatible.v1" as const,
    capabilitySnapshot,
    certification,
    certificationHash
  });
}

export function listOfficialModelEndpointOptions(): readonly Readonly<
  OfficialModelEndpointOption
>[] {
  return Object.freeze(MODEL_ENDPOINT_PROFILES.map((profile) =>
    Object.freeze({
      provider: profile.provider,
      endpointProfileId: profile.id,
      region: profile.region,
      baseUrl: profile.baseUrl,
      requiresWorkspaceId: profile.hostPolicy.kind === "qwen_workspace",
      modelListPolicy: profile.modelList.policy,
      officialReference: profile.officialReference
    })
  ));
}
