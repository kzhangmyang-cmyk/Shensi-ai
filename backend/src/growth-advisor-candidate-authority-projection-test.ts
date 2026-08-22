import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryAdvisorCandidateAuthorityRepository,
  advisorAuthorityEventFromInput,
  advisorAuthoritySnapshotHash,
  type AdvisorCandidateAuthorityProjectionInput
} from "./growth-advisor-candidate-authority-projection.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  AcquisitionDomainService,
  type AcquisitionActorScope
} from "./acquisition-domain-service.js";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import type { AcquisitionDomainRepository } from "./acquisition-domain-repository.js";
import type { DiscoveryEvidenceInput } from "./acquisition-domain.js";
import {
  createGrowthAcquisitionWorkspaceResolver,
  type GrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";
import {
  createProbabilityAssessmentQualificationService,
  type CreateAcquisitionApplicationOptions
} from "./acquisition-application.js";
import type { ProbabilityAssessmentWriter } from "./probability-assessment.js";
import type { GrowthTemporalTransactionRunner } from "./growth-temporal-barrier.js";

const WS_1 = "ws-1";
const WS_2 = "ws-2";

export function qualificationAuthorityEventFixture(
  overrides: Partial<AdvisorCandidateAuthorityProjectionInput> = {}
): AdvisorCandidateAuthorityProjectionInput {
  return Object.freeze({
    workspaceId: WS_1,
    workspaceBindingRevision: "membership-7",
    candidateId: "candidate-1",
    ownerId: "owner-1",
    teamId: "team-1",
    qualificationDecisionId: "qualification-1",
    qualificationDecisionVersion: "qualification-v1",
    qualificationSnapshotHash: `sha256:${"a".repeat(64)}`,
    financialValueDecisionId: "financial-value-1",
    financialValueDecisionVersion: "financial-value-v1",
    financialValueInputSnapshotHash: `sha256:${"b".repeat(64)}`,
    grade: "A",
    score: 78,
    evidence: Object.freeze([{
      evidenceId: "evidence-1",
      contentHash: `sha256:${"c".repeat(64)}`,
      fetchedAt: "2026-08-09T07:00:00.000Z"
    }]),
    ...overrides
  });
}

function authorityRepositoryFixture(
  options: { now?: string } = {}
) {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    options.now ?? "2026-08-09T09:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const repository = new InMemoryAdvisorCandidateAuthorityRepository({
    now: options.now ?? "2026-08-09T09:00:00.000Z",
    temporalTransactions: transactions,
    temporalBarrier: barrier
  });
  return { repository, transactions, barrier };
}

test("authority event freezes exact immutable projection fields", async () => {
  const { repository } = authorityRepositoryFixture();
  const event = await repository.append(qualificationAuthorityEventFixture());
  assert.deepEqual(
    Object.keys(event).sort(),
    [
      "candidateId",
      "eventSequence",
      "evidence",
      "financialValueDecisionId",
      "financialValueDecisionVersion",
      "financialValueInputSnapshotHash",
      "grade",
      "id",
      "ownerId",
      "qualificationDecisionId",
      "qualificationDecisionVersion",
      "qualificationSnapshotHash",
      "recordedAt",
      "score",
      "teamId",
      "temporalSequence",
      "workspaceBindingRevision",
      "workspaceId"
    ].sort()
  );
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.evidence[0]), true);
  assert.equal(event.eventSequence, 1);
  assert.equal(event.recordedAt, "2026-08-09T09:00:00.000Z");
  assert.equal(event.temporalSequence, 1);
  assert.match(advisorAuthoritySnapshotHash(event), /^sha256:[a-f0-9]{64}$/u);
});

test("authority repository rejects all and cross-scope workspace mappings", async () => {
  const { repository } = authorityRepositoryFixture();
  await assert.rejects(
    repository.append(qualificationAuthorityEventFixture({
      workspaceId: "all", teamId: "all"
    })),
    /growth_workspace_required/u
  );
  await assert.rejects(
    repository.append(qualificationAuthorityEventFixture({
      workspaceId: "  ", teamId: "team-1"
    })),
    /growth_workspace_required/u
  );
  await assert.rejects(
    repository.append(qualificationAuthorityEventFixture({
      workspaceId: WS_1, teamId: "all"
    })),
    /growth_workspace_required/u
  );
});

test("a later qualification cannot backdate or rewrite an already-read candidate cutoff", async () => {
  const { repository } = authorityRepositoryFixture({
    now: "2026-08-09T09:00:00.000Z"
  });
  await repository.append(qualificationAuthorityEventFixture({
    candidateId: "candidate-1", qualificationDecisionVersion: "qualification-v1"
  }));
  const cutoff = await repository.seal(WS_1, "2026-08-09T09:00:00.000Z");
  const before = await repository.getAt(WS_1, "candidate-1", cutoff);
  repository.setNow("2026-08-09T08:00:00.000Z");
  await repository.append(qualificationAuthorityEventFixture({
    candidateId: "candidate-1", qualificationDecisionVersion: "qualification-v2"
  }));
  assert.deepEqual(
    await repository.getAt(
      WS_1, "candidate-1",
      await repository.seal(WS_1, "2026-08-09T09:00:00.000Z")
    ),
    before
  );
  assert.equal(
    (await repository.getAt(
      WS_1, "candidate-1",
      await repository.seal(WS_1, "2026-08-09T09:00:00.001Z")
    ))?.qualificationDecisionVersion,
    "qualification-v2"
  );
});

test("listAt reduces per-candidate sequence and never leaks across workspaces", async () => {
  const { repository } = authorityRepositoryFixture({
    now: "2026-08-09T09:00:00.000Z"
  });
  await repository.append(qualificationAuthorityEventFixture({
    candidateId: "candidate-1", qualificationDecisionVersion: "qualification-v1"
  }));
  repository.setNow("2026-08-09T09:00:01.000Z");
  await repository.append(qualificationAuthorityEventFixture({
    candidateId: "candidate-1", qualificationDecisionVersion: "qualification-v2"
  }));
  await repository.append(qualificationAuthorityEventFixture({
    candidateId: "candidate-2", qualificationDecisionVersion: "qualification-v1"
  }));
  await repository.append(qualificationAuthorityEventFixture({
    workspaceId: WS_2, teamId: "team-2", ownerId: "owner-2",
    candidateId: "candidate-3"
  }));
  const cutoff = await repository.seal(
    WS_1, "2026-08-09T09:00:01.500Z"
  );
  const rows = await repository.listAt(WS_1, cutoff);
  assert.deepEqual(
    rows.map((row) => [row.candidateId, row.qualificationDecisionVersion]),
    [["candidate-1", "qualification-v2"], ["candidate-2", "qualification-v1"]]
  );
  const older = await repository.seal(WS_1, "2026-08-09T09:00:00.500Z");
  assert.deepEqual(
    (await repository.listAt(WS_1, older)).map(
      (row) => [row.candidateId, row.qualificationDecisionVersion]
    ),
    [["candidate-1", "qualification-v1"]]
  );
  await assert.rejects(
    repository.getAt(WS_2, "candidate-1", cutoff),
    /sealed_cutoff_workspace_mismatch/u
  );
});

test("concurrent authority appends for one candidate get unique consecutive sequences", async () => {
  const { repository } = authorityRepositoryFixture({
    now: "2026-08-09T09:00:00.000Z"
  });
  const outcomes = await Promise.allSettled([
    repository.append(qualificationAuthorityEventFixture({
      candidateId: "candidate-guard", qualificationDecisionVersion: "v1"
    })),
    repository.append(qualificationAuthorityEventFixture({
      candidateId: "candidate-guard", qualificationDecisionVersion: "v2"
    }))
  ]);
  assert.equal(
    outcomes.filter((item) => item.status === "fulfilled").length,
    2
  );
  const cutoff = await repository.seal(
    WS_1, "2026-08-09T09:00:01.000Z"
  );
  const row = await repository.getAt(WS_1, "candidate-guard", cutoff);
  assert.equal(row?.qualificationDecisionVersion, "v2");
  assert.equal(row?.eventSequence, 2);
  const first = outcomes[0] as PromiseFulfilledResult<Awaited<
    ReturnType<InMemoryAdvisorCandidateAuthorityRepository["append"]>
  >>;
  const second = outcomes[1] as PromiseFulfilledResult<Awaited<
    ReturnType<InMemoryAdvisorCandidateAuthorityRepository["append"]>
  >>;
  assert.equal(first.value.eventSequence, 1);
  assert.equal(second.value.eventSequence, 2);
  assert.equal(second.value.temporalSequence, first.value.temporalSequence + 1);
});

const ownerScope: AcquisitionActorScope = {
  ownerId: "owner-1",
  teamId: "team-1",
  actorId: "owner-1"
};

function acquisitionWorkspaceFor(
  mappings: ReadonlyMap<string, string>
): GrowthAcquisitionWorkspaceResolver {
  return createGrowthAcquisitionWorkspaceResolver({
    async resolve(scope) {
      if (scope.teamId === "all" || scope.teamId === "team-unmapped") {
        return null;
      }
      const workspaceId = mappings.get(scope.teamId);
      if (!workspaceId || workspaceId === "all") return null;
      return {
        workspaceId,
        kind: "team" as const,
        bindingRevision: "membership-7"
      };
    }
  });
}

function organizationInput(): DiscoveryEvidenceInput {
  return {
    targetType: "organization",
    sourcePlatform: "test",
    sourceTitle: "公开需求证据 org",
    sourceSnippet: "可核验的公开需求证据 org",
    publishedAt: null,
    locale: "zh-CN",
    rawArtifactHash: `sha256:${"e".repeat(64)}`,
    contentHash: `sha256:${"f".repeat(64)}`,
    provenance: {
      kind: "user_submitted_url",
      sourceUrl: "https://example.test/public-source",
      submittedBy: "owner-1"
    },
    accessStatus: "user_supplied"
  };
}

function strongQualification() {
  return {
    decisionEngine: "rules" as const,
    ruleVersion: "qualification-rules.v1",
    promptVersion: null,
    modelProvider: null,
    model: null,
    dimensions: {
      demandStrength: 92,
      fit: 88,
      identityConfidence: 95,
      buyingStage: 82,
      budgetPotential: 90,
      decisionReachability: 76,
      freshness: 85,
      evidenceDiversity: 70,
      negativeSignalRisk: 12,
      contactRisk: 8
    },
    hardGates: {
      identityResolved: true,
      decisionMakerReachable: true,
      fraudSignalsClean: true,
      noDoNotContact: true
    },
    reasons: ["公开需求匹配度高"],
    evidenceExcerpts: {}
  };
}

function healthyFinancialValue() {
  return {
    currency: "CNY",
    predictedDealAmountMinor: 1_000_000,
    grossMarginBps: 3_000,
    closeProbabilityBps: 5_000,
    acquisitionCostMinor: 20_000,
    salesCostMinor: 10_000,
    serviceCostMinor: 5_000,
    benchmarkDealAmountMinor: 500_000,
    collectionDays: 30,
    creditRisk: 10,
    repeatPotential: 70,
    referralPotential: 60
  };
}

export interface CandidateAuthorityProjectionFixture {
  readonly appended: Array<{ workspace: {
    workspaceId: string;
    workspaceBindingRevision: string;
  } }>;
  commitQualificationBundle(input: {
    ownerId: string;
    teamId: string;
    candidateId: string;
  }): Promise<void>;
  domainWritesFor(candidateId: string): number;
}

function countingRepository(
  delegate: InMemoryAcquisitionDomainRepository
): InMemoryAcquisitionDomainRepository {
  const counts = new Map<string, number>();
  const count = (candidateId: string) => {
    counts.set(candidateId, (counts.get(candidateId) ?? 0) + 1);
  };
  const wrapped = new Proxy(delegate, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function" || property === "writeCounts") {
        return value;
      }
      return async (...args: unknown[]) => {
        const method = String(property);
        const candidateId = typeof args[0] === "object" && args[0]
          ? (args[0] as { candidateId?: string }).candidateId
          : undefined;
        if (["appendQualificationDecision", "appendFinancialValue"]
          .includes(method) && candidateId) {
          count(candidateId);
        }
        return value.apply(target, args);
      };
    }
  }) as InMemoryAcquisitionDomainRepository;
  Object.defineProperty(wrapped, "writeCounts", {
    value: (candidateId: string) => counts.get(candidateId) ?? 0
  });
  return wrapped;
}

export function candidateAuthorityProjectionFixture(): CandidateAuthorityProjectionFixture & {
  readonly repository: AcquisitionDomainRepository;
  readonly service: AcquisitionDomainService;
} {
  const appended: CandidateAuthorityProjectionFixture["appended"] = [];
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const authority = new InMemoryAdvisorCandidateAuthorityRepository({
    now: "2026-08-09T08:00:00.000Z",
    temporalTransactions: transactions,
    temporalBarrier: barrier
  });
  const repository = new InMemoryAcquisitionDomainRepository({
    temporalTransactions: transactions,
    temporalBarrier: barrier,
    advisorAuthority: authority
  });
  const counted = countingRepository(repository);
  const service = new AcquisitionDomainService({
    repository: counted,
    leadConversionPort: {
      async createLead() {
        return { leadId: "lead-1", partyRef: {
          partyType: "organization", organizationRef: { name: "org" }
        } };
      }
    },
    growthAcquisitionWorkspace: acquisitionWorkspaceFor(
      new Map([["team-1", WS_1]])
    ),
    growthTemporalBarrier: barrier,
    idFactory: (prefix) => `${prefix}-1`,
    now: () => "2026-08-09T08:00:00.000Z"
  });
  return {
    repository: counted,
    service,
    appended,
    async commitQualificationBundle(input) {
      const resolved = await service.resolveGrowthAcquisitionWorkspace({
        ownerId: input.ownerId,
        teamId: input.teamId
      });
      if (!resolved || resolved.workspaceId === "all"
        || input.teamId === "all") {
        throw new Error("growth_workspace_required");
      }
      const scope = {
        ownerId: input.ownerId,
        teamId: input.teamId,
        actorId: input.ownerId
      };
      const evidence = await service.appendEvidence(
        scope,
        organizationInput(),
        `evidence:${input.candidateId}`
      );
      const candidate = await service.createOrganizationCandidate(
        scope,
        {
          name: "公开需求企业",
          domain: "example.test",
          region: "CN",
          creditCode: null,
          organizationId: `org-${input.candidateId}`,
          tenantProspectId: `tenant-${input.candidateId}`,
          evidenceIds: [evidence.id]
        },
        `candidate:${input.candidateId}`
      );
      await service.qualifyCandidate(
        { ownerId: input.ownerId, teamId: input.teamId, actorId: input.ownerId },
        candidate.id,
        strongQualification(),
        healthyFinancialValue(),
        `qualify:${input.candidateId}`
      );
      const authorityRows = await authority.listAt(
        input.teamId === "team-unmapped" || input.teamId === "all"
          ? "missing"
          : WS_1,
        await barrier.sealReadCutoff(
          Object.freeze({
            workspaceId: input.teamId === "team-unmapped" || input.teamId === "all"
              ? "missing"
              : WS_1,
            kind: "team",
            actorId: input.ownerId,
            role: "admin",
            teamId: input.teamId,
            capabilities: Object.freeze([]),
            capabilityRegistryVersion: "growth-capabilities.v1"
          }),
          "2026-08-09T08:00:00.500Z"
        )
      );
      for (const row of authorityRows) {
        appended.push({
          workspace: {
            workspaceId: row.workspaceId,
            workspaceBindingRevision: row.workspaceBindingRevision
          }
        });
      }
    },
    domainWritesFor(candidateId) {
      return (
        counted as unknown as {
          writeCounts(candidateId: string): number;
        }
      ).writeCounts(candidateId);
    }
  };
}

export function qualificationWrapperFixture() {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const authority = new InMemoryAdvisorCandidateAuthorityRepository({
    now: "2026-08-09T08:00:00.000Z",
    temporalTransactions: transactions,
    temporalBarrier: barrier
  });
  const repository = new InMemoryAcquisitionDomainRepository({
    temporalTransactions: transactions,
    temporalBarrier: barrier,
    advisorAuthority: authority
  });
  const probabilityRows = new Map<string, number>();
  const probabilityWriter: ProbabilityAssessmentWriter = {
    async recordFromQualification(input) {
      const key = [
        input.workspaceId,
        input.candidateId,
        input.qualificationDecisionId,
        input.qualificationDecisionVersion,
        input.qualificationInputHash
      ].join("\u0000");
      probabilityRows.set(key, (probabilityRows.get(key) ?? 0) + 1);
      return {
        id: `assessment-${key}`,
        workspaceId: input.workspaceId,
        candidateId: input.candidateId,
        dealId: null,
        closeProbabilityBps: input.financial.closeProbabilityBps,
        qualificationDecisionId: input.qualificationDecisionId,
        qualificationDecisionVersion: input.qualificationDecisionVersion,
        evidenceRefs: Object.freeze([...input.evidenceRefs]),
        ruleVersion: input.ruleVersion,
        modelSnapshotRef: input.modelSnapshotRef,
        inputSnapshotHash: input.qualificationInputHash,
        assessedAt: input.assessedAt,
        recordedAt: input.assessedAt,
        temporalSequence: 1,
        precision: "bps"
      };
    }
  };
  const raw = new AcquisitionDomainService({
    repository,
    leadConversionPort: {
      async createLead() {
        return { leadId: "lead-1", partyRef: {
          partyType: "organization", organizationRef: { name: "org" }
        } };
      }
    },
    growthAcquisitionWorkspace: acquisitionWorkspaceFor(
      new Map([["team-1", WS_1]])
    ),
    growthTemporalBarrier: barrier,
    idFactory: (prefix) => `${prefix}-1`,
    now: () => "2026-08-09T08:00:00.000Z"
  });
  const wrapped = createProbabilityAssessmentQualificationService(
    raw, probabilityWriter
  );
  return {
    authority,
    repository,
    wrapped,
    async counts() {
      const scope = { ownerId: ownerScope.ownerId, teamId: ownerScope.teamId };
      const candidates = await repository.listCandidates(scope, { limit: 100 });
      return {
        candidates: candidates.items.length,
        qualificationDecisions: (
          await repository.listQualificationDecisions(scope, "candidate-1")
        ).length,
        financialValueDecisions: (
          await repository.listFinancialValues(scope, "candidate-1")
        ).length,
        probabilityAssessmentsV2: probabilityRows.size,
        advisorAuthorityEvents: [...authority.events.values()].reduce(
          (sum, rows) => sum + rows.length, 0
        )
      };
    },
    async qualifyThroughHttp() {
      const evidence = await wrapped.appendEvidence(
        ownerScope, organizationInput(), "evidence:http"
      );
      await wrapped.createOrganizationCandidate(
        ownerScope,
        {
          name: "公开需求企业",
          domain: "example.test",
          region: "CN",
          creditCode: null,
          organizationId: "org-candidate-1",
          tenantProspectId: "tenant-candidate-1",
          evidenceIds: [evidence.id]
        },
        "candidate:http"
      );
      await wrapped.qualifyCandidate(
        ownerScope, "candidate-1", strongQualification(),
        healthyFinancialValue(), "shared-idempotency"
      );
    },
    async qualifyThroughPi() {
      await wrapped.qualifyCandidate(
        ownerScope, "candidate-1", strongQualification(),
        healthyFinancialValue(), "shared-idempotency"
      );
    }
  };
}

test("qualification authority requires one trusted concrete workspace mapping", async () => {
  const fixture = candidateAuthorityProjectionFixture();
  await fixture.commitQualificationBundle({
    ownerId: "owner-1", teamId: "team-1", candidateId: "candidate-1"
  });
  assert.deepEqual(fixture.appended[0]?.workspace, {
    workspaceId: WS_1,
    workspaceBindingRevision: "membership-7"
  });
  await assert.rejects(
    fixture.commitQualificationBundle({
      ownerId: "owner-1", teamId: "all", candidateId: "candidate-all"
    }),
    /growth_workspace_required/u
  );
  await assert.rejects(
    fixture.commitQualificationBundle({
      ownerId: "owner-1", teamId: "team-unmapped", candidateId: "candidate-2"
    }),
    /growth_workspace_required/u
  );
  assert.equal(fixture.domainWritesFor("candidate-all"), 0);
  assert.equal(fixture.domainWritesFor("candidate-2"), 0);
});

test("HTTP and Pi qualification replay one B2 bundle, v2 assessment, and authority event", async () => {
  const fixture = qualificationWrapperFixture();
  await fixture.qualifyThroughHttp();
  await fixture.qualifyThroughPi();
  assert.deepEqual(await fixture.counts(), {
    candidates: 1,
    qualificationDecisions: 1,
    financialValueDecisions: 1,
    probabilityAssessmentsV2: 1,
    advisorAuthorityEvents: 1
  });
});

test("authority event helper rejects malformed sequences and workspace ids", () => {
  const stamp = { recordedAt: "2026-08-09T08:00:00.000Z", temporalSequence: 1 };
  assert.throws(
    () => advisorAuthorityEventFromInput(
      qualificationAuthorityEventFixture(), stamp, 0
    ),
    /advisor_candidate_authority_sequence_invalid/u
  );
  assert.throws(
    () => advisorAuthorityEventFromInput(
      qualificationAuthorityEventFixture({ workspaceId: "all" }),
      stamp,
      1
    ),
    /growth_workspace_required/u
  );
  const event = advisorAuthorityEventFromInput(
    qualificationAuthorityEventFixture(), stamp, 1
  );
  assert.equal(event.id, `advisor-authority-${WS_1}-candidate-1-1`);
});

// Keep the imported option type referenced so the fixture surface stays
// aligned with the application boundary when it gains bundle wiring.
export type AcquisitionBundleApplicationOptions = CreateAcquisitionApplicationOptions;
export type AdvisorFixtureTemporalRunner = GrowthTemporalTransactionRunner;
