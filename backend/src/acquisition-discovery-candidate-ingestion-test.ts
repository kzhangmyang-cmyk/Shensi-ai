import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import XLSX from "xlsx-js-style";
import {
  acquisitionCandidateIdentityResolved
} from "./acquisition-domain.js";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import {
  AcquisitionDomainService
} from "./acquisition-domain-service.js";
import {
  AcquisitionDiscoveryOperationService,
  InMemoryAcquisitionDiscoveryOperationRepository
} from "./acquisition-discovery-operations.js";
import {
  AcquisitionIndividualSignalIngestionService
} from "./acquisition-individual-signal-ingestion.js";
import {
  AcquisitionIdentityResolutionService
} from "./acquisition-identity-resolution-service.js";
import {
  type AcquisitionJudgmentPort,
  AcquisitionToolExecutorError,
  ProductionAcquisitionAgentToolExecutor
} from "./acquisition-tool-executor.js";
import {
  InMemoryAcquisitionCandidateDirectory,
  InMemoryAcquisitionToolResultLedger
} from "./acquisition-tool-support-repositories.js";
import {
  createGrowthCommercialToolPorts
} from "./growth-commercial-application.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  createGrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";

const NOW = "2026-08-07T08:00:00.000Z";
const scope = {
  ownerId: "owner-import",
  teamId: "team-import",
  actorId: "user-import"
};

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixture(options: {
  judgments?: AcquisitionJudgmentPort;
} = {}) {
  let sequence = 0;
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
    now: () => NOW
  });
  const candidateDirectory = new InMemoryAcquisitionCandidateDirectory({
    now: () => NOW,
    identityAliases: repository
  });
  const individualSignals =
    new AcquisitionIndividualSignalIngestionService({
      domain,
      candidateDirectory
    });
  const operations = new AcquisitionDiscoveryOperationService({
    repository: new InMemoryAcquisitionDiscoveryOperationRepository(),
    evidence: domain,
    individualSignals,
    fetcher: {
      async fetch(sourceUrl) {
        return {
          finalUrl: sourceUrl,
          status: "succeeded" as const,
          accessStatus: "public_content" as const,
          httpStatus: 200,
          contentType: "text/html; charset=utf-8",
          title: "门店获客复盘",
          text: "门店最近获客成本高，正在了解新的获客方案。",
          rawArtifactHash: sha256(`raw:${sourceUrl}`),
          contentHash: sha256(`content:${sourceUrl}`)
        };
      }
    },
    masterSecret: "discovery-candidate-ingestion-test-secret-32-bytes",
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    now: () => NOW
  });
  const executor = new ProductionAcquisitionAgentToolExecutor({
    domain,
    growthToolPorts: createGrowthCommercialToolPorts(),
    search: {
      async search() {
        throw new Error("search is not used in this test");
      }
    },
    searchConnections: {
      async listActiveConnectionIds() {
        return [];
      }
    },
    candidateDirectory,
    priorityCandidates: {
      async listPriorityCandidates() {
        return [];
      }
    },
    reviewTasks: {
      async create() {
        throw new Error("review is not used in this test");
      },
      async get() {
        return null;
      }
    },
    actionExecutions: {
      async getVerifiedExecution() {
        return null;
      }
    },
    toolResults: new InMemoryAcquisitionToolResultLedger(),
    judgments: options.judgments,
    now: () => NOW
  });
  const identities = new AcquisitionIdentityResolutionService({ domain });
  return { domain, identities, operations, executor };
}

function highIntentJudgments(): AcquisitionJudgmentPort {
  return {
    async qualify(input) {
      assert.equal(
        input.evidence.some((item) =>
          item.provenance.kind === "import_artifact_row"
        ),
        false
      );
      return {
        qualification: {
          decisionEngine: "rules",
          ruleVersion: input.policyVersion,
          promptVersion: null,
          modelProvider: null,
          model: null,
          dimensions: {
            demandStrength: 95,
            fit: 95,
            identityConfidence: 95,
            buyingStage: 90,
            budgetPotential: 80,
            decisionReachability: 80,
            freshness: 95,
            evidenceDiversity: 80,
            negativeSignalRisk: 0,
            contactRisk: 0
          },
          hardGates: {
            hasOriginalSource: false,
            identityResolved: false,
            notDoNotContact: false,
            noExplicitRejection: false,
            publicDataOnly: false,
            evidenceFresh: false,
            schemaValid: false
          },
          evidenceExcerpts: Object.fromEntries(input.evidence.map((item) => [
            item.id,
            item.sourceSnippet
          ])),
          reasons: ["受控公开主页证据显示明确的方案采购需求。"]
        },
        financial: {
          currency: "CNY",
          predictedDealAmountMinor: 100_000,
          grossMarginBps: 6_000,
          closeProbabilityBps: 7_000,
          acquisitionCostMinor: 5_000,
          salesCostMinor: 5_000,
          serviceCostMinor: 10_000,
          benchmarkDealAmountMinor: 100_000,
          collectionDays: 30,
          creditRisk: 10,
          repeatPotential: 80,
          referralPotential: 70
        }
      };
    },
    async buildBattleCard(input) {
      assert.equal(
        input.evidence.some((item) =>
          item.provenance.kind === "import_artifact_row"
        ),
        false
      );
      const publicEvidence = input.evidence.find((item) =>
        item.provenance.kind === "user_submitted_url"
        && item.accessStatus === "public_content"
      );
      assert.ok(publicEvidence);
      const fact = {
        kind: "fact" as const,
        text: publicEvidence.sourceSnippet,
        evidenceIds: [publicEvidence.id],
        confidence: 1
      };
      return {
        schemaVersion: "battle-card.v2",
        intelligence: {
          accountOverview: [fact],
          needAssessment: [fact],
          supplierHypotheses: [],
          buyingCommittee: [],
          procurementPreferences: [],
          connectionStrategies: [{
            channel: "public_reply",
            targetRole: "公开需求主体",
            rationale: fact,
            openingDraft: "建议人工基于已核验的公开需求做温和澄清。"
          }],
          roleSpecificOpeners: [],
          doNotActions: ["不自动触达"]
        },
        confidence: 0.9,
        modelProvider: "rules",
        model: "controlled-public-evidence-test",
        promptVersion: input.templateVersion
      };
    }
  };
}

test("a submitted Douyin video becomes persisted evidence plus an identity-gated individual candidate", async () => {
  const state = fixture();
  const created = await state.operations.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://www.douyin.com/video/7350000000000000001",
      subjectChannel: "individual"
    },
    "fetch-douyin-video"
  );
  assert.equal(created.evidenceCount, 0);
  assert.deepEqual(created.evidenceIds, []);
  assert.equal(created.candidateCount, 0);
  assert.deepEqual(created.candidateIds, []);

  const completed = await state.operations.executeContentFetchOperation(
    scope,
    created.id
  );

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.evidenceCount, 1);
  assert.equal(completed.candidateCount, 1);
  assert.equal(completed.evidenceCount, completed.evidenceIds.length);
  assert.equal(completed.candidateCount, completed.candidateIds.length);
  assert.equal(completed.evidenceIds.length, 1);
  assert.equal(completed.candidateIds.length, 1);

  const candidate = await state.domain.getCandidate(
    scope,
    completed.candidateIds[0]!
  );
  assert.equal(candidate.partyType, "individual");
  assert.equal(candidate.profile.kind, "individual");
  assert.equal(acquisitionCandidateIdentityResolved(candidate), false);
  assert.match(
    candidate.partyRef.partyType === "individual"
      ? candidate.partyRef.individualPartyId
      : "",
    /^unresolved-individual-/u
  );
  assert.deepEqual(candidate.evidenceIds, completed.evidenceIds);

  await assert.rejects(
    state.executor.execute({
      identity: {
        ...scope,
        sessionId: "submitted-douyin-video"
      },
      toolName: "qualify_candidate",
      toolCallId: "qualify-submitted-douyin-video",
      idempotencyKey: "qualify-submitted-douyin-video",
      payload: {
        candidateId: candidate.id,
        policyVersion: "qualification.v2"
      }
    }),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "IDENTITY_RESEARCH_REQUIRED"
  );
});

test("a customer-submitted Douyin profile still requires human identity verification", async () => {
  const state = fixture();
  const created = await state.operations.createContentFetchOperation(
    scope,
    {
      sourceUrl: "https://www.douyin.com/user/MS4wLjABAAAA-profile-signal",
      subjectChannel: "individual"
    },
    "fetch-douyin-profile-unresolved"
  );

  const completed = await state.operations.executeContentFetchOperation(
    scope,
    created.id
  );
  const candidate = await state.domain.getCandidate(
    scope,
    completed.candidateIds[0]!
  );

  assert.equal(candidate.partyType, "individual");
  assert.equal(acquisitionCandidateIdentityResolved(candidate), false);
  assert.match(
    candidate.partyRef.partyType === "individual"
      ? candidate.partyRef.individualPartyId
      : "",
    /^unresolved-individual-/u
  );
  await assert.rejects(
    state.executor.execute({
      identity: {
        ...scope,
        sessionId: "submitted-douyin-profile"
      },
      toolName: "qualify_candidate",
      toolCallId: "qualify-submitted-douyin-profile",
      idempotencyKey: "qualify-submitted-douyin-profile",
      payload: {
        candidateId: candidate.id,
        policyVersion: "qualification.v2"
      }
    }),
    (error: unknown) =>
      error instanceof AcquisitionToolExecutorError
      && error.code === "IDENTITY_RESEARCH_REQUIRED"
  );
});

test("CSV import keeps each Douyin source URL and idempotently links evidence to unresolved candidates", async () => {
  const state = fixture();
  const sourceUrl = "https://www.douyin.com/video/7350000000000000002";
  const csv = [
    "标题,摘要,平台,链接",
    `装修获客咨询,想了解下个月的获客方案,抖音,${sourceUrl}`,
    `缺少摘要,,抖音,https://www.douyin.com/video/7350000000000000999`
  ].join("\r\n");
  const created = await state.operations.createImportOperation(
    scope,
    {
      fileName: "douyin-signals.csv",
      mediaType: "text/csv",
      content: new TextEncoder().encode(csv),
      subjectChannel: "individual",
      columnMapping: {
        sourceTitle: "标题",
        sourceSnippet: "摘要",
        sourcePlatform: "平台",
        sourceUrl: "链接"
      }
    },
    "import-douyin-csv"
  );
  assert.equal(created.evidenceCount, 0);
  assert.deepEqual(created.evidenceIds, []);
  assert.equal(created.candidateCount, 0);
  assert.deepEqual(created.candidateIds, []);

  const completed = await state.operations.executeImportOperation(
    scope,
    created.id
  );

  assert.equal(completed.status, "partial_success");
  assert.equal(completed.rowCount, 2);
  assert.equal(completed.acceptedRowCount, 1);
  assert.equal(completed.errorRows.length, 1);
  assert.equal(completed.errorRows[0]?.rowNumber, 3);
  assert.equal(completed.evidenceCount, 1);
  assert.equal(completed.candidateCount, 1);
  assert.equal(completed.evidenceCount, completed.evidenceIds.length);
  assert.equal(completed.candidateCount, completed.candidateIds.length);
  assert.equal(completed.evidenceIds.length, 1);
  assert.equal(completed.candidateIds.length, 1);
  const evidence = await state.domain.getEvidence(
    scope,
    completed.evidenceIds[0]!
  );
  assert.deepEqual(evidence.provenance, {
    kind: "import_artifact_row",
    importBatchId: created.id,
    artifactHash: created.artifactHash,
    sheetName: "CSV",
    rowNumber: 2,
    sourceUrl
  });
  const candidate = await state.domain.getCandidate(
    scope,
    completed.candidateIds[0]!
  );
  assert.equal(acquisitionCandidateIdentityResolved(candidate), false);
  assert.deepEqual(candidate.evidenceIds, completed.evidenceIds);
  for (const [toolName, payload] of [
    ["qualify_candidate", {
      candidateId: candidate.id,
      policyVersion: "qualification.v2"
    }],
    ["estimate_financial_value", {
      candidateId: candidate.id,
      currency: "CNY"
    }],
    ["build_battle_card", {
      candidateId: candidate.id,
      templateVersion: "battle-card.v2"
    }]
  ] as const) {
    await assert.rejects(
      state.executor.execute({
        identity: {
          ...scope,
          sessionId: "imported-douyin-csv"
        },
        toolName,
        toolCallId: `${toolName}-imported-douyin-csv`,
        idempotencyKey: `${toolName}-imported-douyin-csv`,
        payload
      }),
      (error: unknown) =>
        error instanceof AcquisitionToolExecutorError
        && error.code === (toolName === "qualify_candidate"
          ? "IDENTITY_RESEARCH_REQUIRED"
          : "ELIGIBILITY_BLOCKED")
    );
  }

  const replay = await state.operations.executeImportOperation(
    scope,
    created.id
  );
  assert.deepEqual(replay.evidenceIds, completed.evidenceIds);
  assert.deepEqual(replay.candidateIds, completed.candidateIds);
});

test("controlled public profile verification unlocks an imported Douyin candidate without trusting the import row", async () => {
  const state = fixture({ judgments: highIntentJudgments() });
  const importedUrl =
    "https://www.douyin.com/video/7350000000000000004";
  const profileUrl =
    "https://www.douyin.com/user/MS4wLjABAAAA-verified-import";
  const csv = [
    "标题,摘要,平台,链接",
    `门店获客咨询,正在寻找新的获客方案,抖音,${importedUrl}`
  ].join("\r\n");
  const imported = await state.operations.createImportOperation(
    scope,
    {
      fileName: "verified-douyin-signal.csv",
      mediaType: "text/csv",
      content: new TextEncoder().encode(csv),
      subjectChannel: "individual",
      columnMapping: {
        sourceTitle: "标题",
        sourceSnippet: "摘要",
        sourcePlatform: "平台",
        sourceUrl: "链接"
      }
    },
    "import-verified-douyin-signal"
  );
  const completedImport = await state.operations.executeImportOperation(
    scope,
    imported.id
  );
  const candidateId = completedImport.candidateIds[0]!;

  const fetched = await state.operations.createContentFetchOperation(
    scope,
    {
      sourceUrl: profileUrl,
      subjectChannel: "individual"
    },
    "fetch-verified-douyin-profile"
  );
  const completedFetch = await state.operations.executeContentFetchOperation(
    scope,
    fetched.id
  );
  const beforeConfirmation = await state.domain.getCandidate(
    scope,
    candidateId
  );
  const confirmed = await state.identities.resolveCandidateIdentity(
    scope,
    candidateId,
    {
      expectedCandidateVersion: beforeConfirmation.version,
      evidenceIds: [completedFetch.evidenceIds[0]!],
      rationale: "受控抓取的抖音公开主页与需求主体一致。",
      subject: {
        kind: "individual",
        publicProfileUrl: profileUrl,
        sourcePlatform: "douyin"
      }
    },
    "confirm-verified-douyin-import"
  );
  assert.equal(acquisitionCandidateIdentityResolved(confirmed.candidate), true);

  const qualification = await state.executor.execute({
    identity: {
      ...scope,
      sessionId: "verified-douyin-import"
    },
    toolName: "qualify_candidate",
    toolCallId: "qualify-verified-douyin-import",
    idempotencyKey: "qualify-verified-douyin-import",
    payload: {
      candidateId,
      policyVersion: "qualification.v2"
    }
  }) as {
    qualification: {
      grade: string;
      hardGateFailures: string[];
    };
  };
  assert.equal(
    qualification.qualification.hardGateFailures.includes(
      "non_public_or_sensitive_data"
    ),
    false
  );
  assert.notEqual(qualification.qualification.grade, "D");

  const battleCard = await state.executor.execute({
    identity: {
      ...scope,
      sessionId: "verified-douyin-import"
    },
    toolName: "build_battle_card",
    toolCallId: "battle-card-verified-douyin-import",
    idempotencyKey: "battle-card-verified-douyin-import",
    payload: {
      candidateId,
      templateVersion: "battle-card.v2"
    }
  }) as { battleCard: { candidateId: string } };
  assert.equal(battleCard.battleCard.candidateId, candidateId);
});

test("XLSX import uses the same unresolved Douyin candidate pipeline", async () => {
  const state = fixture();
  const sourceUrl = "https://v.douyin.com/douyinSignal03/";
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["标题", "摘要", "链接"],
      ["门店获客短链", "获客成本高，需要方案", sourceUrl]
    ]),
    "抖音信号"
  );
  const content = Buffer.from(XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx"
  }) as Buffer);
  const created = await state.operations.createImportOperation(
    scope,
    {
      fileName: "douyin-signals.xlsx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content,
      subjectChannel: "individual",
      columnMapping: {
        sourceTitle: "标题",
        sourceSnippet: "摘要",
        sourceUrl: "链接"
      }
    },
    "import-douyin-xlsx"
  );

  const completed = await state.operations.executeImportOperation(
    scope,
    created.id
  );

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.evidenceCount, 1);
  assert.equal(completed.candidateCount, 1);
  assert.equal(completed.evidenceCount, completed.evidenceIds.length);
  assert.equal(completed.candidateCount, completed.candidateIds.length);
  const evidence = await state.domain.getEvidence(
    scope,
    completed.evidenceIds[0]!
  );
  assert.equal(
    evidence.provenance.kind === "import_artifact_row"
      ? evidence.provenance.sourceUrl
      : null,
    sourceUrl
  );
  const candidate = await state.domain.getCandidate(
    scope,
    completed.candidateIds[0]!
  );
  assert.equal(acquisitionCandidateIdentityResolved(candidate), false);
  assert.equal(
    candidate.profile.kind === "individual"
      ? candidate.profile.sourcePlatform
      : null,
    "douyin"
  );
});
