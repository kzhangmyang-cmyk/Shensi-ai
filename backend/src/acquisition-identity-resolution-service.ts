import { createHash } from "node:crypto";
import type {
  AcquisitionCandidate,
  CandidateIdentityResolutionCommitInput,
  CandidateIdentityResolutionResult,
  DiscoveryEvidence
} from "./acquisition-domain.js";
import {
  AcquisitionDomainError,
  type AcquisitionActorScope,
  type AcquisitionDomainService
} from "./acquisition-domain-service.js";
import {
  classifyDouyinPublicSource
} from "./acquisition-douyin-public-source.js";
import {
  ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION,
  extractAcquisitionPublicCreditCode,
  isVerifiedAcquisitionPublicProfileUrl,
  normalizeAcquisitionPublicCreditCode,
  normalizeAcquisitionPublicDomain,
  normalizeAcquisitionPublicUrl,
  resolveAcquisitionPublicIdentity
} from "./acquisition-public-identity-resolver.js";

export type CandidateIdentityConfirmationInput =
  | {
      expectedCandidateVersion: number;
      evidenceIds: string[];
      rationale: string;
      subject: {
        kind: "organization";
        domain: string | null;
        creditCode: string | null;
      };
    }
  | {
      expectedCandidateVersion: number;
      evidenceIds: string[];
      rationale: string;
      subject: {
        kind: "individual";
        publicProfileUrl: string;
        sourcePlatform: string;
      };
    };

export interface AcquisitionIdentityResolutionServiceOptions {
  domain: AcquisitionDomainService;
}

function domainError(
  code: "invalid_request" | "evidence_required",
  message: string,
  status: number
): never {
  throw new AcquisitionDomainError(code, message, status);
}

function requiredText(value: unknown, label: string, max: number) {
  const text = String(value ?? "").normalize("NFKC").trim();
  if (!text || text.length > max) {
    domainError(
      "invalid_request",
      `${label}不能为空且不能超过 ${max} 个字符`,
      400
    );
  }
  return text;
}

function uniqueIds(values: unknown) {
  if (!Array.isArray(values)) {
    domainError("invalid_request", "身份核验证据必须是数组", 400);
  }
  const ids = [...new Set(values.map((value) =>
    requiredText(value, "证据 ID", 100)
  ))];
  if (ids.length < 1 || ids.length > 100) {
    domainError("evidence_required", "身份核验需要 1 至 100 条证据", 422);
  }
  return ids;
}

function evidenceUrl(evidence: DiscoveryEvidence) {
  if (evidence.provenance.kind === "import_artifact_row") return null;
  return normalizeAcquisitionPublicUrl(evidence.provenance.sourceUrl);
}

function evidenceText(evidence: DiscoveryEvidence) {
  return `${evidence.sourceTitle}\n${evidence.sourceSnippet}`
    .normalize("NFKC")
    .replace(/\s+/gu, "");
}

function normalizedNameVariants(candidate: AcquisitionCandidate) {
  if (candidate.profile.kind !== "organization") return [];
  const full = candidate.profile.name
    .normalize("NFKC")
    .replace(/\s+/gu, "");
  const short = full.replace(
    /(?:有限责任公司|股份有限公司|有限公司|集团|公司|企业|机构|中心)$/u,
    ""
  );
  return [...new Set([full, short].filter((value) => value.length >= 2))];
}

function organizationNameIsProven(
  candidate: AcquisitionCandidate,
  evidence: DiscoveryEvidence[]
) {
  const variants = normalizedNameVariants(candidate);
  return variants.length > 0 && evidence.some((item) => {
    const text = evidenceText(item);
    return variants.some((name) => text.includes(name));
  });
}

function providerForEvidence(evidence: DiscoveryEvidence) {
  return evidence.provenance.kind === "search_result"
    ? evidence.provenance.provider
    : evidence.sourcePlatform;
}

function platformsForEvidence(evidence: DiscoveryEvidence) {
  const sourceUrl = evidenceUrl(evidence);
  const classified = sourceUrl
    ? classifyDouyinPublicSource(sourceUrl)
    : null;
  return new Set([
    evidence.sourcePlatform,
    providerForEvidence(evidence),
    classified?.sourcePlatform
  ].filter((value): value is string => Boolean(value)).map((value) =>
    value.toLocaleLowerCase("en-US")
  ));
}

function publicActorKey(platform: string, profileUrl: string) {
  const digest = createHash("sha256").update(profileUrl).digest("hex");
  return `public:${platform}:sha256:${digest}`;
}

export class AcquisitionIdentityResolutionService {
  private readonly domain: AcquisitionDomainService;

  constructor(options: AcquisitionIdentityResolutionServiceOptions) {
    this.domain = options.domain;
  }

  async resolveCandidateIdentity(
    scope: AcquisitionActorScope,
    candidateId: string,
    raw: CandidateIdentityConfirmationInput,
    idempotencyKey: string
  ): Promise<CandidateIdentityResolutionResult> {
    const candidate = await this.domain.getCandidate(scope, candidateId);
    const evidenceIds = uniqueIds(raw.evidenceIds);
    const evidence = await Promise.all(
      evidenceIds.map((id) => this.domain.getEvidence(scope, id))
    );
    const expectedTarget = candidate.partyType === "organization"
      ? "organization"
      : "individual_signal";
    if (evidence.some((item) =>
      item.targetType !== expectedTarget
      || item.accessStatus === "access_restricted"
      || item.provenance.kind === "import_artifact_row"
      || !evidenceUrl(item)
    )) {
      domainError(
        "evidence_required",
        "身份核验只能使用同主体、可访问且带公开 URL 的证据",
        422
      );
    }
    const rationale = requiredText(raw.rationale, "身份核验说明", 2_000);
    const commit = raw.subject.kind === "organization"
      ? this.organizationCommit(scope, candidate, evidence, {
          expectedCandidateVersion: raw.expectedCandidateVersion,
          evidenceIds,
          rationale,
          domain: raw.subject.domain,
          creditCode: raw.subject.creditCode
        })
      : this.individualCommit(scope, candidate, evidence, {
          expectedCandidateVersion: raw.expectedCandidateVersion,
          evidenceIds,
          rationale,
          publicProfileUrl: raw.subject.publicProfileUrl,
          sourcePlatform: raw.subject.sourcePlatform
        });
    return this.domain.applyResolvedCandidateIdentity(
      scope,
      candidateId,
      commit,
      idempotencyKey
    );
  }

  private organizationCommit(
    scope: AcquisitionActorScope,
    candidate: AcquisitionCandidate,
    evidence: DiscoveryEvidence[],
    input: {
      expectedCandidateVersion: number;
      evidenceIds: string[];
      rationale: string;
      domain: string | null;
      creditCode: string | null;
    }
  ): CandidateIdentityResolutionCommitInput {
    if (candidate.profile.kind !== "organization"
      || candidate.partyRef.partyType !== "organization") {
      domainError("invalid_request", "候选不是企业主体", 400);
    }
    if (!organizationNameIsProven(candidate, evidence)) {
      domainError(
        "evidence_required",
        "公开证据未包含候选企业名称，不能确认企业身份",
        422
      );
    }
    const normalizedDomain = input.domain
      ? normalizeAcquisitionPublicDomain(input.domain)
      : null;
    const normalizedCreditCode = input.creditCode
      ? normalizeAcquisitionPublicCreditCode(input.creditCode)
      : null;
    if (input.domain && !normalizedDomain) {
      domainError("invalid_request", "企业官网域名无效", 400);
    }
    if (input.creditCode && !normalizedCreditCode) {
      domainError("invalid_request", "统一社会信用代码校验失败", 400);
    }
    if (!normalizedDomain && !normalizedCreditCode) {
      domainError(
        "invalid_request",
        "企业身份至少需要已核验官网或统一社会信用代码",
        400
      );
    }
    if (normalizedDomain && !evidence.some((item) => {
      const url = evidenceUrl(item);
      return url
        ? normalizeAcquisitionPublicDomain(new URL(url).hostname)
          === normalizedDomain
        : false;
    })) {
      domainError(
        "evidence_required",
        "所选公开证据 URL 与声明的企业官网不一致",
        422
      );
    }
    if (normalizedCreditCode && !evidence.some((item) =>
      extractAcquisitionPublicCreditCode(
        `${item.sourceTitle}\n${item.sourceSnippet}`
      ) === normalizedCreditCode
    )) {
      domainError(
        "evidence_required",
        "所选公开证据未标明相同的统一社会信用代码",
        422
      );
    }

    const source = evidence[0]!;
    const aliases = [];
    if (normalizedDomain) {
      const resolution = resolveAcquisitionPublicIdentity({
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        provider: providerForEvidence(source),
        sourceUrl: evidenceUrl(source)!,
        subject: {
          kind: "organization",
          name: candidate.profile.name,
          domain: normalizedDomain,
          region: candidate.profile.region,
          creditCode: null
        }
      });
      if (resolution.status !== "resolved"
        || resolution.basis !== "organization_domain") {
        domainError("invalid_request", "企业官网身份解析失败", 400);
      }
      aliases.push({
        dedupeKey: resolution.dedupeKey,
        basis: resolution.basis
      });
    }
    let canonical = normalizedDomain
      ? resolveAcquisitionPublicIdentity({
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          provider: providerForEvidence(source),
          sourceUrl: evidenceUrl(source)!,
          subject: {
            kind: "organization",
            name: candidate.profile.name,
            domain: normalizedDomain,
            region: candidate.profile.region,
            creditCode: null
          }
        })
      : null;
    if (normalizedCreditCode) {
      const resolution = resolveAcquisitionPublicIdentity({
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        provider: providerForEvidence(source),
        sourceUrl: evidenceUrl(source)!,
        subject: {
          kind: "organization",
          name: candidate.profile.name,
          domain: null,
          region: candidate.profile.region,
          creditCode: normalizedCreditCode
        }
      });
      if (resolution.status !== "resolved"
        || resolution.basis !== "organization_credit_code") {
        domainError("invalid_request", "企业信用代码身份解析失败", 400);
      }
      aliases.push({
        dedupeKey: resolution.dedupeKey,
        basis: resolution.basis
      });
      canonical = resolution;
    }
    if (!canonical
      || canonical.status !== "resolved"
      || (
        canonical.basis !== "organization_domain"
        && canonical.basis !== "organization_credit_code"
      )) {
      domainError("invalid_request", "企业身份解析失败", 400);
    }
    return {
      expectedCandidateVersion: input.expectedCandidateVersion,
      evidenceIds: input.evidenceIds,
      rationale: input.rationale,
      basis: canonical.basis,
      resolverVersion: canonical.resolverVersion,
      identityAliases: aliases,
      partyRef: {
        partyType: "organization",
        organizationId: canonical.partyId,
        tenantProspectId: candidate.partyRef.tenantProspectId
      },
      profile: {
        ...candidate.profile,
        domain: normalizedDomain,
        creditCode: normalizedCreditCode
      }
    };
  }

  private individualCommit(
    scope: AcquisitionActorScope,
    candidate: AcquisitionCandidate,
    evidence: DiscoveryEvidence[],
    input: {
      expectedCandidateVersion: number;
      evidenceIds: string[];
      rationale: string;
      publicProfileUrl: string;
      sourcePlatform: string;
    }
  ): CandidateIdentityResolutionCommitInput {
    if (candidate.profile.kind !== "individual"
      || candidate.partyRef.partyType !== "individual") {
      domainError("invalid_request", "候选不是个人公开需求主体", 400);
    }
    const profileUrl = normalizeAcquisitionPublicUrl(input.publicProfileUrl);
    if (!profileUrl
      || !isVerifiedAcquisitionPublicProfileUrl(profileUrl)) {
      domainError("invalid_request", "公开主页不在支持的平台或路径范围", 400);
    }
    const sourcePlatform = requiredText(
      input.sourcePlatform,
      "公开平台",
      100
    ).toLocaleLowerCase("en-US");
    const matchingEvidence = evidence.find((item) =>
      evidenceUrl(item) === profileUrl
      && platformsForEvidence(item).has(sourcePlatform)
    );
    if (!matchingEvidence) {
      domainError(
        "evidence_required",
        "所选公开证据与声明的个人公开主页、平台不一致",
        422
      );
    }
    const actorKey = publicActorKey(sourcePlatform, profileUrl);
    const resolution = resolveAcquisitionPublicIdentity({
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      provider: sourcePlatform,
      sourceUrl: profileUrl,
      subject: {
        kind: "individual",
        publicActorKey: actorKey,
        publicProfileUrl: profileUrl,
        sourcePlatform
      }
    });
    if (resolution.status !== "resolved"
      || resolution.basis !== "provider_public_actor") {
      domainError("invalid_request", "个人公开身份解析失败", 400);
    }
    return {
      expectedCandidateVersion: input.expectedCandidateVersion,
      evidenceIds: input.evidenceIds,
      rationale: input.rationale,
      basis: resolution.basis,
      resolverVersion:
        ACQUISITION_PUBLIC_IDENTITY_RESOLVER_VERSION,
      identityAliases: [{
        dedupeKey: resolution.dedupeKey,
        basis: resolution.basis
      }],
      partyRef: {
        partyType: "individual",
        individualPartyId: resolution.partyId,
        demandSignalId: candidate.partyRef.demandSignalId
      },
      profile: {
        ...candidate.profile,
        publicActorKey: actorKey,
        publicProfileUrl: profileUrl,
        sourcePlatform
      }
    };
  }
}
