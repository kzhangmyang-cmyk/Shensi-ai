import { createHash } from "node:crypto";
import {
  normalizeAcquisitionPublicCreditCode,
  normalizeAcquisitionPublicDomain
} from "./acquisition-public-identity-resolver.js";

export type CanonicalSubjectMaterial =
  | {
      kind: "individual";
      platform: string;
      publicActorKey: string;
      canonicalProfileUrl: string | null;
    }
  | {
      kind: "organization";
      platform: string;
      creditCode: string | null;
      domain: string | null;
    };

export interface CanonicalSubjectResolution {
  status: "resolved" | "unassignable";
  subjectStableKey: string | null;
  basis: "platform_public_actor" | "organization_credit_code"
    | "organization_domain" | null;
  canonicalProfileUrl: string | null;
  resolverVersion: "acquisition-canonical-subject.v1";
}

const RESOLVER_VERSION = "acquisition-canonical-subject.v1" as const;

function hash(parts: readonly string[]): string {
  return createHash("sha256")
    .update(parts.join("\u0000")).digest("hex");
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function unassignable(): CanonicalSubjectResolution {
  return {
    status: "unassignable",
    subjectStableKey: null,
    basis: null,
    canonicalProfileUrl: null,
    resolverVersion: RESOLVER_VERSION
  };
}

export function canonicalSubjectStableKey(
  workspaceId: string,
  material: CanonicalSubjectMaterial
): CanonicalSubjectResolution {
  const workspace = workspaceId.trim();
  const platform = normalized(material.platform);
  if (!workspace || !platform) return unassignable();
  if (material.kind === "individual") {
    const actor = normalized(material.publicActorKey);
    if (!actor) return unassignable();
    return {
      status: "resolved",
      subjectStableKey: `subject:${hash([
        workspace, platform, "individual", actor
      ])}`,
      basis: "platform_public_actor",
      canonicalProfileUrl: material.canonicalProfileUrl,
      resolverVersion: RESOLVER_VERSION
    };
  }
  const creditCode = normalizeAcquisitionPublicCreditCode(
    material.creditCode
  );
  const domain = normalizeAcquisitionPublicDomain(material.domain);
  const identity = creditCode
    ? ["credit", creditCode]
    : domain ? ["domain", domain] : null;
  if (!identity) return unassignable();
  return {
    status: "resolved",
    subjectStableKey: `subject:${hash([
      workspace, platform, ...identity
    ])}`,
    basis: creditCode
      ? "organization_credit_code"
      : "organization_domain",
    canonicalProfileUrl: null,
    resolverVersion: RESOLVER_VERSION
  };
}

export interface CanonicalSubjectCandidateMaterial {
  readonly platform?: string | null;
  readonly publicActorKey?: string | null;
  readonly canonicalProfileUrl?: string | null;
  readonly creditCode?: string | null;
  readonly domain?: string | null;
}

export class AcquisitionCanonicalSubjectResolver {
  resolve(
    workspaceId: string,
    candidate: CanonicalSubjectCandidateMaterial
  ): CanonicalSubjectResolution {
    const platform = candidate.platform ?? null;
    const publicActorKey = candidate.publicActorKey ?? null;
    if (publicActorKey && platform) {
      return canonicalSubjectStableKey(workspaceId, {
        kind: "individual",
        platform,
        publicActorKey,
        canonicalProfileUrl: candidate.canonicalProfileUrl ?? null
      });
    }
    return canonicalSubjectStableKey(workspaceId, {
      kind: "organization",
      platform: platform ?? "",
      creditCode: candidate.creditCode ?? null,
      domain: candidate.domain ?? null
    });
  }
}
