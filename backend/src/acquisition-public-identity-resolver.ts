import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import {
  classifyDouyinPublicSource,
  type DouyinPublicSourceType
} from "./acquisition-douyin-public-source.js";

export const ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION =
  "acquisition-public-identity-v1";

export type AcquisitionPublicIdentityResolutionBasis =
  | "organization_domain"
  | "organization_credit_code"
  | "provider_public_actor"
  | "manual_binding";

export type AcquisitionPublicIdentityResolution =
  | {
      status: "resolved";
      basis: AcquisitionPublicIdentityResolutionBasis;
      reasonCode: null;
      resolverVersion: typeof ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION;
      partyId: string;
      dedupeKey: string;
      normalizedDomain: string | null;
      normalizedCreditCode: string | null;
      normalizedProfileUrl: string | null;
    }
  | {
      status: "needs_research";
      basis: null;
      reasonCode:
        | "insufficient_public_organization_identity"
        | "insufficient_provider_public_actor_identity";
      resolverVersion: typeof ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION;
      partyId: string;
      dedupeKey: string;
      normalizedDomain: null;
      normalizedCreditCode: null;
      normalizedProfileUrl: string | null;
    };

export type AcquisitionPublicIdentityDisposition = Pick<
  AcquisitionPublicIdentityResolution,
  "status" | "basis" | "reasonCode" | "resolverVersion"
>;

export type AcquisitionPublicIdentitySubject =
  | {
      kind: "organization";
      name: string;
      domain: string | null;
      region: string | null;
      creditCode: string | null;
    }
  | {
      kind: "individual";
      publicActorKey: string;
      publicProfileUrl: string;
      sourcePlatform: string;
    };

export interface ResolveAcquisitionPublicIdentityInput {
  ownerId: string;
  teamId: string;
  provider: string;
  sourceUrl: string;
  sourceType?: DouyinPublicSourceType;
  subject: AcquisitionPublicIdentitySubject;
}

const CREDIT_CODE_ALPHABET = "0123456789ABCDEFGHJKLMNPQRTUWXY";
const CREDIT_CODE_WEIGHTS = [
  1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28
] as const;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedText(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function scopedDigest(
  input: Pick<ResolveAcquisitionPublicIdentityInput, "ownerId" | "teamId">,
  purpose: string,
  identity: string,
  scope: "team" | "owner_team"
) {
  return sha256([
    ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION,
    scope,
    normalizedText(input.teamId),
    ...(scope === "owner_team" ? [normalizedText(input.ownerId)] : []),
    purpose,
    identity
  ].join("\u0000"));
}

function validDomainLabels(hostname: string) {
  if (hostname.length > 253
    || !hostname.includes(".")
    || hostname.startsWith(".")
    || hostname.endsWith(".")
    || hostname.includes("..")
    || isIP(hostname) !== 0) {
    return false;
  }
  return hostname.split(".").every((label) =>
    label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  );
}

export function normalizeAcquisitionPublicDomain(value: string | null) {
  const raw = normalizedText(value || "");
  if (!raw) return null;
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)
        ? raw
        : `https://${raw}`
    );
    if (!["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.port) {
      return null;
    }
    const asciiHostname = domainToASCII(
      url.hostname.replace(/\.$/u, "")
    ).toLocaleLowerCase("en-US");
    const hostname = asciiHostname.replace(/^www\./u, "");
    return validDomainLabels(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

export function normalizeAcquisitionPublicCreditCode(value: string | null) {
  const normalized = normalizedText(value || "")
    .replace(/\s+/gu, "")
    .toLocaleUpperCase("en-US");
  if (!/^[0-9A-HJ-NP-RTUWXY]{18}$/u.test(normalized)) return null;
  let sum = 0;
  for (let index = 0; index < CREDIT_CODE_WEIGHTS.length; index += 1) {
    const alphabetIndex = CREDIT_CODE_ALPHABET.indexOf(normalized[index]!);
    if (alphabetIndex < 0) return null;
    sum += alphabetIndex * CREDIT_CODE_WEIGHTS[index]!;
  }
  const expected = CREDIT_CODE_ALPHABET[(31 - (sum % 31)) % 31];
  return expected === normalized[17] ? normalized : null;
}

export function extractAcquisitionPublicCreditCode(text: string) {
  const normalized = text.normalize("NFKC");
  const matches = normalized.matchAll(
    /(?:统一社会信用代码|社会信用代码|信用代码)\s*[:：]?\s*([0-9A-HJ-NP-RTUWXY]{18})(?![0-9A-HJ-NP-RTUWXY])/giu
  );
  for (const match of matches) {
    const validated = normalizeAcquisitionPublicCreditCode(match[1] || null);
    if (validated) return validated;
  }
  return null;
}

const PRIVATE_URL_PARAMETER =
  /^(?:api[-_]?key|auth(?:orization)?|credential|email|mail|mobile|password|phone|secret|session|tel|token)$/iu;

export function normalizeAcquisitionPublicUrl(value: string) {
  try {
    const url = new URL(normalizedText(value));
    if (!["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password) {
      return null;
    }
    const hostname = domainToASCII(
      url.hostname.replace(/\.$/u, "")
    ).toLocaleLowerCase("en-US");
    if (!validDomainLabels(hostname)) return null;
    let decodedPath = url.pathname;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = decodeURIComponent(decodedPath);
      if (next === decodedPath) break;
      decodedPath = next;
    }
    if (/[^\s/@]+@[^\s/]+\.[^\s/]+/u.test(decodedPath)
      || /(?<!\d)\+?\d(?:[\s().-]*\d){6,14}(?!\d)/u.test(decodedPath)) {
      return null;
    }
    if ([...url.searchParams].some(([key, nested]) =>
      PRIVATE_URL_PARAMETER.test(key)
      || /[^\s@]+@[^\s@]+\.[^\s@]+/u.test(nested)
      || /(?<!\d)\+?\d(?:[\s().-]*\d){6,14}(?!\d)/u.test(nested)
    )) {
      return null;
    }
    url.hostname = hostname;
    url.hash = "";
    url.searchParams.sort();
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/u, "");
    }
    return url.toString();
  } catch {
    return null;
  }
}

const ACQUISITION_PUBLIC_PROFILE_RULES = [
  {
    rootHost: "xiaohongshu.com",
    path: /^\/user\/profile\/[^/]+\/?$/u
  },
  {
    rootHost: "douyin.com",
    path: /^\/user\/[^/]+\/?$/u
  },
  {
    rootHost: "weibo.com",
    path: /^\/(?:u\/[^/]+|[0-9]+)\/?$/u
  },
  {
    rootHost: "zhihu.com",
    path: /^\/people\/[^/]+\/?$/u
  },
  {
    rootHost: "linkedin.com",
    path: /^\/in\/[^/]+\/?$/u
  },
  {
    rootHost: "github.com",
    path: /^\/[^/]+\/?$/u
  }
] as const;

export function isVerifiedAcquisitionPublicProfileUrl(value: string | URL) {
  const normalized = normalizeAcquisitionPublicUrl(
    value instanceof URL ? value.toString() : value
  );
  if (!normalized) return false;
  const url = new URL(normalized);
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  return ACQUISITION_PUBLIC_PROFILE_RULES.some((rule) =>
    (hostname === rule.rootHost || hostname.endsWith(`.${rule.rootHost}`))
    && rule.path.test(url.pathname)
  );
}

function normalizedProvider(value: string) {
  return normalizedText(value).toLocaleLowerCase("en-US");
}

type DouyinCommentActorKey = {
  kind: "sec_uid" | "handle" | "comment" | "visual";
  normalized: string;
};

function strictDouyinCommentActorKey(value: string): DouyinCommentActorKey | null {
  const actorKey = value.normalize("NFKC").trim();
  const secUid = /^douyin:sec_uid:([A-Za-z0-9._~-]{1,128})$/u.exec(actorKey);
  if (secUid
    && !/^\+?\d(?:[\s().-]*\d){6,14}$/u.test(secUid[1]!)) {
    return { kind: "sec_uid", normalized: actorKey };
  }
  const handle = /^douyin:handle:([A-Za-z0-9._-]{1,64})$/u.exec(actorKey);
  if (handle
    && !/^\+?\d(?:[\s().-]*\d){6,14}$/u.test(handle[1]!)) {
    return {
      kind: "handle",
      normalized: `douyin:handle:${handle[1]!.toLocaleLowerCase("en-US")}`
    };
  }
  const comment =
    /^unmergeable:douyin:comment:([A-Za-z0-9._~-]{1,128})$/u.exec(actorKey);
  if (comment) return { kind: "comment", normalized: actorKey };
  const visual = /^unmergeable:douyin:visual:visual-observation:[a-f0-9]{64}$/u
    .exec(actorKey);
  return visual ? { kind: "visual", normalized: actorKey } : null;
}

export function normalizeAcquisitionDouyinCommentActorKey(value: string) {
  return strictDouyinCommentActorKey(value)?.normalized ?? null;
}

function safePublicActorKey(value: string) {
  const actorKey = normalizedText(value);
  const douyinCommentActorKey = strictDouyinCommentActorKey(value);
  if (douyinCommentActorKey) return douyinCommentActorKey.normalized;
  const opaqueHashKey =
    /^public:[a-z0-9._:-]+:sha256:[a-f0-9]{64}$/iu.test(actorKey);
  const unresolvedOpaqueHashKey =
    /^unresolved-public-signal:[a-z0-9._-]+:sha256:[a-f0-9]{64}$/u
      .test(actorKey);
  const publicNamespace = actorKey
    .toLocaleLowerCase("en-US")
    .startsWith("public:");
  if (!actorKey
    || actorKey.length > 300
    || (!publicNamespace && !unresolvedOpaqueHashKey)
    || /(?:mailto:|tel:|[^\s@]+@[^\s@]+\.[^\s@]+)/iu.test(actorKey)
    || (!opaqueHashKey
      && !unresolvedOpaqueHashKey
      && /\+?\d(?:[\s().-]*\d){6,14}/u.test(actorKey))) {
    return null;
  }
  return actorKey.toLocaleLowerCase("en-US");
}

const ADAPTER_GENERATED_PUBLIC_ACTOR_KEY =
  /^(public|unresolved-public-signal):([a-z0-9._-]+):sha256:([a-f0-9]{64})$/u;
const ADAPTER_GENERATED_PUBLIC_ACTOR_KEY_IGNORE_CASE =
  /^(public|unresolved-public-signal):([a-z0-9._-]+):sha256:([a-f0-9]{64})$/iu;

function publicActorIdentityMaterial(input: {
  publicActorKey: string;
  provider: string;
  sourcePlatform: string;
  sourceUrl: string;
}) {
  const actorKey = normalizedText(input.publicActorKey);
  const match = ADAPTER_GENERATED_PUBLIC_ACTOR_KEY.exec(actorKey);
  const keyPlatform = normalizedProvider(match?.[2] || "");
  const normalizedSourceUrl = normalizeAcquisitionPublicUrl(input.sourceUrl);
  const expectedHash = normalizedSourceUrl ? sha256(normalizedSourceUrl) : "";
  if (match
    && match[3] === expectedHash
    && (keyPlatform === input.provider
      || keyPlatform === input.sourcePlatform)) {
    return {
      actorKey: `${match[1]}:${input.provider}:sha256:${expectedHash}`,
      sourcePlatform: input.provider
    };
  }
  if (match || ADAPTER_GENERATED_PUBLIC_ACTOR_KEY_IGNORE_CASE.test(actorKey)) {
    return {
      actorKey: "",
      sourcePlatform: input.sourcePlatform
    };
  }
  return {
    actorKey: input.publicActorKey,
    sourcePlatform: input.sourcePlatform
  };
}

export function isSafeAcquisitionPublicActorKey(value: string) {
  return safePublicActorKey(value) !== null;
}

function disposition(
  resolution: AcquisitionPublicIdentityResolution
): AcquisitionPublicIdentityDisposition {
  return {
    status: resolution.status,
    basis: resolution.basis,
    reasonCode: resolution.reasonCode,
    resolverVersion: resolution.resolverVersion
  };
}

export function acquisitionPublicIdentityDisposition(
  resolution: AcquisitionPublicIdentityResolution
) {
  return disposition(resolution);
}

export function resolveAcquisitionPublicIdentity(
  input: ResolveAcquisitionPublicIdentityInput
): AcquisitionPublicIdentityResolution {
  if (input.subject.kind === "organization") {
    const normalizedDomain = normalizeAcquisitionPublicDomain(
      input.subject.domain
    );
    const normalizedCreditCode = normalizeAcquisitionPublicCreditCode(
      input.subject.creditCode
    );
    const basis = normalizedDomain
      ? "organization_domain" as const
      : normalizedCreditCode
        ? "organization_credit_code" as const
        : null;
    if (basis) {
      const identity = basis === "organization_domain"
        ? normalizedDomain!
        : normalizedCreditCode!;
      const digest = scopedDigest(input, basis, identity, "team");
      return {
        status: "resolved",
        basis,
        reasonCode: null,
        resolverVersion: ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION,
        partyId: `public-org-${digest.slice(0, 24)}`,
        dedupeKey: `organization:${basis}:sha256:${digest}`,
        normalizedDomain,
        normalizedCreditCode,
        normalizedProfileUrl: null
      };
    }

    const weakMaterial = [
      normalizedProvider(input.provider),
      normalizeAcquisitionPublicUrl(input.sourceUrl)
        || normalizedText(input.sourceUrl),
      normalizedText(input.subject.name).toLocaleLowerCase("und"),
      normalizedText(input.subject.region || "").toLocaleLowerCase("und")
    ].join("\u0000");
    const digest = scopedDigest(
      input,
      "unresolved_organization",
      weakMaterial,
      "team"
    );
    return {
      status: "needs_research",
      basis: null,
      reasonCode: "insufficient_public_organization_identity",
      resolverVersion: ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION,
      partyId: `unresolved-org-${digest.slice(0, 24)}`,
      dedupeKey: `organization:needs_research:sha256:${digest}`,
      normalizedDomain: null,
      normalizedCreditCode: null,
      normalizedProfileUrl: null
    };
  }

  const normalizedProfileUrl = normalizeAcquisitionPublicUrl(
    input.subject.publicProfileUrl
  );
  const provider = normalizedProvider(input.provider);
  const sourcePlatform = normalizedProvider(input.subject.sourcePlatform);
  const identityMaterial = publicActorIdentityMaterial({
    publicActorKey: input.subject.publicActorKey,
    provider,
    sourcePlatform,
    sourceUrl: input.sourceUrl
  });
  const actorKey = safePublicActorKey(identityMaterial.actorKey);
  const douyinCommentActorKey = actorKey
    ? strictDouyinCommentActorKey(actorKey)
    : null;
  const resolvedActorKey = actorKey?.startsWith("public:")
    ? actorKey
    : null;
  const identitySourcePlatform = identityMaterial.sourcePlatform;
  const douyinClassification = normalizedProfileUrl
    ? classifyDouyinPublicSource(normalizedProfileUrl)
    : null;
  const isDouyinSource = sourcePlatform === "douyin"
    || douyinClassification !== null;
  const isDouyinCommentActorContext = Boolean(
    douyinCommentActorKey
    && sourcePlatform === "douyin"
    && (provider === "douyin" || provider === "experimental_public_sample")
    && douyinClassification !== null
  );
  const isStableDouyinProfile = !isDouyinSource || (
    douyinClassification?.sourceType === "profile"
    && (input.sourceType === undefined || input.sourceType === "profile")
    && isVerifiedAcquisitionPublicProfileUrl(normalizedProfileUrl || "")
  );
  if (provider
    && sourcePlatform
    && (resolvedActorKey
      || (isDouyinCommentActorContext
        && douyinCommentActorKey?.kind === "sec_uid"))
    && normalizedProfileUrl
    && isStableDouyinProfile) {
    const digest = scopedDigest(
      input,
      "provider_public_actor",
      [
        provider,
        identitySourcePlatform,
        resolvedActorKey || douyinCommentActorKey!.normalized,
        normalizedProfileUrl
      ].join("\u0000"),
      "owner_team"
    );
    return {
      status: "resolved",
      basis: "provider_public_actor",
      reasonCode: null,
      resolverVersion: ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION,
      partyId: `public-individual-${digest.slice(0, 24)}`,
      dedupeKey: `individual:provider_public_actor:sha256:${digest}`,
      normalizedDomain: null,
      normalizedCreditCode: null,
      normalizedProfileUrl
    };
  }

  if (isDouyinCommentActorContext) {
    const digest = scopedDigest(
      input,
      `douyin_comment_${douyinCommentActorKey!.kind}`,
      douyinCommentActorKey!.normalized,
      "owner_team"
    );
    return {
      status: "needs_research",
      basis: null,
      reasonCode: "insufficient_provider_public_actor_identity",
      resolverVersion: ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION,
      partyId: `unresolved-individual-${digest.slice(0, 24)}`,
      dedupeKey: `individual:needs_research:sha256:${digest}`,
      normalizedDomain: null,
      normalizedCreditCode: null,
      normalizedProfileUrl
    };
  }

  const digest = scopedDigest(
    input,
    "unresolved_individual",
    [
      provider,
      identitySourcePlatform,
      actorKey || "",
      normalizedProfileUrl || "",
      normalizeAcquisitionPublicUrl(input.sourceUrl)
        || normalizedText(input.sourceUrl)
    ].join("\u0000"),
    "owner_team"
  );
  return {
    status: "needs_research",
    basis: null,
    reasonCode: "insufficient_provider_public_actor_identity",
    resolverVersion: ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION,
    partyId: `unresolved-individual-${digest.slice(0, 24)}`,
    dedupeKey: `individual:needs_research:sha256:${digest}`,
    normalizedDomain: null,
    normalizedCreditCode: null,
    normalizedProfileUrl
  };
}
