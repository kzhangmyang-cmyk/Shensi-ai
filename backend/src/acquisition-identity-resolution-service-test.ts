import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import {
  AcquisitionDomainError,
  AcquisitionDomainService,
  type AcquisitionActorScope
} from "./acquisition-domain-service.js";
import {
  AcquisitionIdentityResolutionService
} from "./acquisition-identity-resolution-service.js";
import {
  resolveAcquisitionPublicIdentity
} from "./acquisition-public-identity-resolver.js";
import {
  InMemoryAcquisitionCandidateDirectory
} from "./acquisition-tool-support-repositories.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  createGrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";

const scope: AcquisitionActorScope = {
  ownerId: "owner-identity",
  teamId: "team-identity",
  actorId: "human-reviewer"
};

function harness() {
  let sequence = 0;
  let tick = 0;
  const repository = new InMemoryAcquisitionDomainRepository();
  const domain = new AcquisitionDomainService({
    repository,
    leadConversionPort: {
      async createLead(input) {
        return {
          leadId: `lead-${input.candidateId}`,
          partyRef: input.partyRef
        };
      }
    },
    growthAcquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
      async resolve(input) {
        return input.ownerId === scope.ownerId
          && input.teamId === scope.teamId
          ? {
              workspaceId: scope.teamId,
              kind: "team" as const,
              bindingRevision: "binding-1"
            }
          : null;
      }
    }),
    growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner()
    ),
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    now: () => new Date(
      Date.parse("2026-07-24T06:00:00.000Z") + tick++
    ).toISOString()
  });
  const service = new AcquisitionIdentityResolutionService({
    domain
  });
  return { repository, domain, service };
}

async function unresolvedOrganization(
  domain: AcquisitionDomainService,
  suffix: string,
  sourceUrl = `https://${suffix}.example.cn/about`
) {
  const evidence = await domain.appendEvidence(scope, {
    targetType: "organization",
    sourcePlatform: "baidu_ai_search",
    sourceTitle: `${suffix}科技有限公司企业官网`,
    sourceSnippet: `${suffix}科技有限公司公开介绍`,
    publishedAt: "2026-07-24T05:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:raw-${suffix}`,
    contentHash: `sha256:content-${suffix}`,
    provenance: {
      kind: "search_result",
      provider: "baidu_ai_search",
      queryText: `${suffix} 企业官网`,
      sourceUrl,
      resultRank: 1
    },
    accessStatus: "public_content"
  }, `evidence:${suffix}`);
  const candidate = await domain.createOrganizationCandidate(scope, {
    name: `${suffix}科技有限公司`,
    domain: null,
    region: "福建厦门",
    creditCode: null,
    organizationId: `unresolved-org-${suffix}`,
    tenantProspectId: `prospect-${suffix}`,
    evidenceIds: [evidence.id]
  }, `candidate:${suffix}`);
  return { evidence, candidate };
}

async function unresolvedIndividual(domain: AcquisitionDomainService) {
  const profileUrl =
    "https://www.xiaohongshu.com/user/profile/public-business-owner";
  const evidence = await domain.appendEvidence(scope, {
    targetType: "individual_signal",
    sourcePlatform: "xiaohongshu",
    sourceTitle: "厦门门店主理人公开主页",
    sourceSnippet: "公开表达正在比较获客系统",
    publishedAt: "2026-07-24T05:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: "sha256:raw-individual",
    contentHash: "sha256:content-individual",
    provenance: {
      kind: "search_result",
      provider: "xiaohongshu",
      queryText: "厦门 门店 获客",
      sourceUrl: profileUrl,
      resultRank: 1
    },
    accessStatus: "public_content"
  }, "evidence:individual");
  const candidate = await domain.createIndividualCandidate(scope, {
    publicActorKey: "unresolved-public-signal:xiaohongshu:sha256:old",
    publicDisplayName: "厦门门店主理人",
    publicProfileUrl: profileUrl,
    sourcePlatform: "xiaohongshu",
    demandSignalId: "signal-individual",
    demandCategory: "门店获客",
    demandSummary: "正在比较获客系统",
    locationHint: "厦门",
    buyingStage: "comparison",
    negativeSignals: [],
    individualPartyId: "unresolved-individual-before-review",
    evidenceIds: [evidence.id]
  }, "candidate:individual");
  return { candidate, evidence, profileUrl };
}

test("human verified organization identity becomes qualifiable and replay is idempotent", async () => {
  const { domain, service } = harness();
  const { evidence, candidate } = await unresolvedOrganization(domain, "acme");

  const resolved = await service.resolveCandidateIdentity(
    scope,
    candidate.id,
    {
      expectedCandidateVersion: candidate.version,
      evidenceIds: [evidence.id],
      rationale: "官网页面与企业名称、主营业务一致，人工核验通过",
      subject: {
        kind: "organization",
        domain: "acme.example.cn",
        creditCode: null
      }
    },
    "resolve:acme"
  );

  assert.equal(resolved.resolution.status, "resolved");
  assert.equal(resolved.resolution.basis, "organization_domain");
  assert.equal(resolved.candidate.profile.kind, "organization");
  assert.equal(resolved.candidate.profile.domain, "acme.example.cn");
  assert.equal(resolved.candidate.partyRef.partyType, "organization");
  assert.doesNotMatch(
    resolved.candidate.partyRef.organizationId,
    /^unresolved-org-/
  );
  assert.equal(resolved.candidate.status, "normalized");
  assert.equal(resolved.candidate.version, candidate.version + 1);

  const replay = await service.resolveCandidateIdentity(
    scope,
    candidate.id,
    {
      expectedCandidateVersion: candidate.version,
      evidenceIds: [evidence.id],
      rationale: "官网页面与企业名称、主营业务一致，人工核验通过",
      subject: {
        kind: "organization",
        domain: "acme.example.cn",
        creditCode: null
      }
    },
    "resolve:acme"
  );
  assert.deepEqual(replay, resolved);

  const qualification = await domain.qualifyCandidate(
    scope,
    candidate.id,
    {
      decisionEngine: "rules",
      ruleVersion: "identity-resolution-test-v1",
      promptVersion: null,
      modelProvider: null,
      model: null,
      dimensions: {
        demandStrength: 80,
        fit: 80,
        identityConfidence: 95,
        buyingStage: 70,
        budgetPotential: 60,
        decisionReachability: 60,
        freshness: 90,
        evidenceDiversity: 50,
        negativeSignalRisk: 0,
        contactRisk: 0
      },
      hardGates: {
        hasOriginalSource: true,
        identityResolved: true,
        notDoNotContact: true,
        noExplicitRejection: true,
        publicDataOnly: true,
        evidenceFresh: true,
        schemaValid: true
      },
      evidenceExcerpts: {
        [evidence.id]: "acme 公司公开介绍"
      },
      reasons: ["主体已由人工基于公开官网完成核验"]
    },
    {
      currency: "CNY",
      predictedDealAmountMinor: 100_000,
      grossMarginBps: 5_000,
      closeProbabilityBps: 5_000,
      acquisitionCostMinor: 1_000,
      salesCostMinor: 2_000,
      serviceCostMinor: 10_000,
      benchmarkDealAmountMinor: 100_000,
      collectionDays: 15,
      creditRisk: 10,
      repeatPotential: 50,
      referralPotential: 50
    },
    "qualify:acme"
  );
  assert.equal(qualification.qualification.hardGateFailures.length, 0);
});

test("identity resolution rejects unsupported proof, stale versions, and cross-tenant access", async () => {
  const { domain, service } = harness();
  const { evidence, candidate } = await unresolvedOrganization(domain, "proof");

  await assert.rejects(
    service.resolveCandidateIdentity(scope, candidate.id, {
      expectedCandidateVersion: candidate.version,
      evidenceIds: [evidence.id],
      rationale: "来源与声明官网不一致",
      subject: {
        kind: "organization",
        domain: "different.example.cn",
        creditCode: null
      }
    }, "resolve:wrong-proof"),
    (error: unknown) => error instanceof AcquisitionDomainError
      && error.code === "evidence_required"
  );

  await assert.rejects(
    service.resolveCandidateIdentity(scope, candidate.id, {
      expectedCandidateVersion: candidate.version + 1,
      evidenceIds: [evidence.id],
      rationale: "使用过期页面提交",
      subject: {
        kind: "organization",
        domain: "proof.example.cn",
        creditCode: null
      }
    }, "resolve:stale"),
    (error: unknown) => error instanceof AcquisitionDomainError
      && error.code === "stale_candidate"
  );

  await assert.rejects(
    service.resolveCandidateIdentity({
      ownerId: "other-owner",
      teamId: scope.teamId,
      actorId: "intruder"
    }, candidate.id, {
      expectedCandidateVersion: candidate.version,
      evidenceIds: [evidence.id],
      rationale: "跨租户尝试",
      subject: {
        kind: "organization",
        domain: "proof.example.cn",
        creditCode: null
      }
    }, "resolve:intruder"),
    (error: unknown) => error instanceof AcquisitionDomainError
      && error.code === "resource_not_found"
  );
});

test("resolved identity dedupe binding rejects a second candidate claiming the same organization", async () => {
  const { domain, service } = harness();
  const first = await unresolvedOrganization(domain, "shared");
  const second = await unresolvedOrganization(
    domain,
    "other",
    "https://shared.example.cn/contact"
  );

  await service.resolveCandidateIdentity(scope, first.candidate.id, {
    expectedCandidateVersion: first.candidate.version,
    evidenceIds: [first.evidence.id],
    rationale: "首次官网核验",
    subject: {
      kind: "organization",
      domain: "shared.example.cn",
      creditCode: null
    }
  }, "resolve:shared:first");

  await assert.rejects(
    service.resolveCandidateIdentity(scope, second.candidate.id, {
      expectedCandidateVersion: second.candidate.version,
      evidenceIds: [second.evidence.id],
      rationale: "第二条候选尝试声明相同主体",
      subject: {
        kind: "organization",
        domain: "shared.example.cn",
        creditCode: null
      }
    }, "resolve:shared:second"),
    (error: unknown) => error instanceof AcquisitionDomainError
      && error.code === "identity_conflict"
  );
});

test("future searches reuse the candidate through its resolved identity alias", async () => {
  const { repository, domain, service } = harness();
  const original = await unresolvedOrganization(domain, "alias");
  const resolved = await service.resolveCandidateIdentity(
    scope,
    original.candidate.id,
    {
      expectedCandidateVersion: original.candidate.version,
      evidenceIds: [original.evidence.id],
      rationale: "核验官网并绑定强身份别名",
      subject: {
        kind: "organization",
        domain: "alias.example.cn",
        creditCode: null
      }
    },
    "resolve:alias"
  );
  const identity = resolveAcquisitionPublicIdentity({
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    provider: "baidu_ai_search",
    sourceUrl: "https://alias.example.cn/about",
    subject: {
      kind: "organization",
      name: "alias科技有限公司",
      domain: "alias.example.cn",
      region: "福建厦门",
      creditCode: null
    }
  });
  assert.equal(identity.status, "resolved");

  const directory = new InMemoryAcquisitionCandidateDirectory({
    identityAliases: repository
  });
  let createCalls = 0;
  const upsert = await directory.upsertCandidate({
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    dedupeKey: identity.dedupeKey,
    partyType: "organization",
    idempotencyKey: "future-search",
    createCandidate: async () => {
      createCalls += 1;
      return resolved.candidate;
    }
  });
  assert.equal(upsert.created, false);
  assert.equal(createCalls, 0);
  assert.equal(upsert.entry.candidateId, original.candidate.id);
});

test("human confirmation derives an individual actor key only for an exact approved public profile", async () => {
  const { domain, service } = harness();
  const original = await unresolvedIndividual(domain);
  const resolved = await service.resolveCandidateIdentity(
    scope,
    original.candidate.id,
    {
      expectedCandidateVersion: original.candidate.version,
      evidenceIds: [original.evidence.id],
      rationale: "人工核验小红书公开商务主页",
      subject: {
        kind: "individual",
        publicProfileUrl: original.profileUrl,
        sourcePlatform: "xiaohongshu"
      }
    },
    "resolve:individual"
  );
  assert.equal(resolved.resolution.basis, "provider_public_actor");
  assert.equal(resolved.candidate.profile.kind, "individual");
  assert.match(
    resolved.candidate.profile.publicActorKey,
    /^public:xiaohongshu:sha256:[a-f0-9]{64}$/u
  );
  assert.equal(resolved.candidate.partyRef.partyType, "individual");
  assert.doesNotMatch(
    resolved.candidate.partyRef.individualPartyId,
    /^unresolved-individual-/
  );

  const second = await unresolvedIndividual(domain);
  await assert.rejects(
    service.resolveCandidateIdentity(scope, second.candidate.id, {
      expectedCandidateVersion: second.candidate.version,
      evidenceIds: [second.evidence.id],
      rationale: "不受支持的公开页",
      subject: {
        kind: "individual",
        publicProfileUrl: "https://example.cn/user/public-business-owner",
        sourcePlatform: "example"
      }
    }, "resolve:individual:unsupported"),
    (error: unknown) => error instanceof AcquisitionDomainError
      && error.code === "invalid_request"
  );
});

test("a verified credit code becomes canonical while domain and credit aliases both resolve", async () => {
  const { repository, domain, service } = harness();
  const creditCode = "91350200MA2Y5E7E0M";
  const evidence = await domain.appendEvidence(scope, {
    targetType: "organization",
    sourcePlatform: "baidu_ai_search",
    sourceTitle: "dual科技有限公司企业官网",
    sourceSnippet: `dual科技有限公司，统一社会信用代码：${creditCode}`,
    publishedAt: "2026-07-24T05:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: "sha256:raw-dual",
    contentHash: "sha256:content-dual",
    provenance: {
      kind: "search_result",
      provider: "baidu_ai_search",
      queryText: "dual科技有限公司 官网",
      sourceUrl: "https://dual.example.cn/about",
      resultRank: 1
    },
    accessStatus: "public_content"
  }, "evidence:dual");
  const candidate = await domain.createOrganizationCandidate(scope, {
    name: "dual科技有限公司",
    domain: null,
    region: "福建厦门",
    creditCode: null,
    organizationId: "unresolved-org-dual",
    tenantProspectId: "prospect-dual",
    evidenceIds: [evidence.id]
  }, "candidate:dual");

  const result = await service.resolveCandidateIdentity(
    scope,
    candidate.id,
    {
      expectedCandidateVersion: candidate.version,
      evidenceIds: [evidence.id],
      rationale: "官网与国家统一社会信用代码均核验通过",
      subject: {
        kind: "organization",
        domain: "dual.example.cn",
        creditCode
      }
    },
    "resolve:dual"
  );
  assert.equal(
    result.resolution.basis,
    "organization_credit_code"
  );
  for (const subject of [
    {
      kind: "organization" as const,
      name: "dual科技有限公司",
      domain: "dual.example.cn",
      region: "福建厦门",
      creditCode: null
    },
    {
      kind: "organization" as const,
      name: "dual科技有限公司",
      domain: null,
      region: "福建厦门",
      creditCode
    }
  ]) {
    const identity = resolveAcquisitionPublicIdentity({
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      provider: "baidu_ai_search",
      sourceUrl: "https://dual.example.cn/about",
      subject
    });
    assert.equal(identity.status, "resolved");
    const alias = await repository.findCandidateIdentityAlias(
      scope,
      identity.dedupeKey
    );
    assert.equal(alias?.candidateId, candidate.id);
  }
});
