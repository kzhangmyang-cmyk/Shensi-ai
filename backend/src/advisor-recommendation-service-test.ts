import assert from "node:assert/strict";
import test from "node:test";
import {
  AdvisorRecommendationService,
  DefaultAdvisorReferenceVerifier,
  type AdvisorReferenceVerifierPorts
} from "./advisor-recommendation-service.js";
import {
  DefaultAdvisorVisibilityResolver
} from "./growth-advisor-query.js";
import {
  DefaultPriorityCandidateReader
} from "./growth-advisor-query.js";
import {
  InMemoryAdvisorCandidateAuthorityRepository
} from "./growth-advisor-candidate-authority-projection.js";
import {
  qualificationAuthorityEventFixture
} from "./growth-advisor-candidate-authority-projection-test.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  InMemoryAdvisorRecommendationRepository
} from "./advisor-recommendation-repository.js";
import {
  recommendationFixture
} from "./advisor-recommendation-domain-test.js";
import {
  stableAdvisorActionHash
} from "./advisor-action-operation.js";
import {
  createGrowthWorkspaceMemberAssignabilityReader
} from "./growth-workspace-member-assignability.js";
import { canonicalGrowthRequestHash } from "./growth-http-idempotency-repository.js";
import {
  FinancialCouncilApprovalProofIssuer,
  createFinancialCouncilApprovalRecord
} from "./financial-council-approval.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { AdvisorRecommendationCreateInput } from "./advisor-recommendation-service.js";

const managerWorkspace: ActiveWorkspaceContext = Object.freeze({
  workspaceId: "ws-1",
  kind: "team",
  actorId: "manager-1",
  role: "manager",
  teamId: "ws-1",
  capabilities: Object.freeze([
    "catalog.read",
    "pricing.sensitive.read",
    "growth.performance.team.read"
  ]),
  capabilityRegistryVersion: "growth-capabilities.v1"
});

function salesWorkspace(actorId: string): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId: "ws-1",
    kind: "team",
    actorId,
    role: "sales",
    teamId: "ws-1",
    capabilities: Object.freeze(["catalog.read"]),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

function command(
  key: string,
  workspace: ActiveWorkspaceContext,
  expectedRevision: number | null = null
): CommandContext {
  return Object.freeze({
    workspace,
    actorId: workspace.actorId,
    idempotencyKey: key,
    requestHash: canonicalGrowthRequestHash({ key }),
    expectedRevision
  });
}

async function createServiceFixture() {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const authority = new InMemoryAdvisorCandidateAuthorityRepository({
    now: "2026-08-09T08:00:00.000Z",
    temporalTransactions: transactions,
    temporalBarrier: barrier
  });
  await authority.append(qualificationAuthorityEventFixture({
    candidateId: "candidate-1",
    ownerId: "sales-a",
    teamId: "ws-1",
    qualificationDecisionId: "qualification-1",
    qualificationDecisionVersion: "qualification-v1",
    qualificationSnapshotHash: `sha256:${"1".repeat(64)}`
  }));
  const visibility = new DefaultAdvisorVisibilityResolver({
    candidateAuthority: authority,
    quoteBindings: {
      async listVisibleBindings() {
        return Object.freeze([{
          quoteVersionId: "quote-v1",
          candidateId: "candidate-1",
          customerId: "customer-1",
          dealId: "deal-1",
          salesOwnerActorId: "sales-a",
          teamId: "ws-1"
        }]);
      }
    },
    cohortBindings: {
      async listVisibleCohorts() {
        return Object.freeze([]);
      }
    }
  });
  const candidateEvidence = new DefaultPriorityCandidateReader({
    candidateAuthority: authority,
    quoteBindings: {
      async listVisibleBindings() {
        return Object.freeze([]);
      }
    },
    displayNames: {
      async listDisplayNames() {
        return new Map([["candidate-1", "示例企业"]]);
      }
    }
  });
  const binding = {
    candidateId: "candidate-1",
    customerId: "customer-1",
    dealId: "deal-1",
    handoffContentHash: `sha256:${"2".repeat(64)}`,
    dealContentHash: `sha256:${"3".repeat(64)}`,
    bindingHashSchemaVersion: "commercial-binding.v1"
  };
  const ports: AdvisorReferenceVerifierPorts = {
    candidateEvidence,
    quote: {
      previews: {
        async verifyAt() {
          return {
            id: "preview-1",
            quoteCaseId: "quote-case-1",
            salesOwnerActorId: "sales-a",
            subjectEvidence: Object.freeze({
              candidateId: "candidate-1",
              customerId: "customer-1",
              dealId: "deal-1"
            }),
            previewIdentity: Object.freeze({
              inputSnapshotHash: `sha256:${"4".repeat(64)}`,
              calculationHash: `sha256:${"5".repeat(64)}`,
              pricingPolicyVersionId: "pricing-policy-v1",
              pricingPolicyRevision: 1,
              packageVersionId: "package-v1",
              formulaVersion: "quote-calculation.v1"
            }),
            inputSnapshotHash: `sha256:${"4".repeat(64)}`,
            calculationHash: `sha256:${"5".repeat(64)}`,
            effectiveAt: "2026-08-09T07:00:00.000Z",
            recordedAt: "2026-08-09T07:00:00.000Z",
            evidenceHash: `sha256:${"5".repeat(64)}`
          };
        }
      },
      quoteVersions: {
        async getAt() {
          return {
            quoteCaseId: "quote-case-1",
            quoteVersionId: "quote-v1",
            salesOwnerActorId: "sales-a",
            versionKind: "formal",
            sourceDraftVersionId: "draft-1",
            commercialBindingEvidence: Object.freeze(binding),
            probabilityAssessmentId: "assessment-1",
            closeProbabilityBps: 5_000,
            lifecycleRevision: 4,
            status: "submitted",
            currency: "CNY",
            quotedAmountMinor: 1_000_000,
            estimatedGrossProfitMinor: 280_000,
            grossMarginBps: 2_800,
            inputSnapshotHash: `sha256:${"6".repeat(64)}`,
            calculationHash: `sha256:${"7".repeat(64)}`,
            commercialAmountHash: `sha256:${"c".repeat(64)}`,
            lifecycleEventId: "lifecycle-1",
            recordedAt: "2026-08-09T07:00:00.000Z"
          };
        }
      },
      dealAuthoritativeQuotes: {
        async getAt() {
          return null;
        },
        async getDecisionAt() {
          return null;
        }
      }
    },
    finance: {
      async getVerifiedAt() {
        return null;
      },
      financialGaps: {
        async verifyAt() {
          return null;
        }
      }
    },
    roi: {
      growthPerformance: {
        async getAt() {
          return {
            cohortId: "cohort-1",
            currency: "CNY",
            planId: null,
            dataAsOf: "2026-08-09T08:00:00.000Z",
            memberIds: [],
            expectedRoiByCurrency: [],
            actualRoiByCurrency: [],
            cashByCurrency: [],
            coverage: {
              costCoverageBps: 0,
              marginCoverageBps: 0,
              cashCoverageBps: 0,
              attributionCoverageBps: 0,
              gapCodes: []
            },
            dataGaps: [],
            closureVersionId: null,
            formulaVersion: "growth-performance.v1",
            calculationHash: `sha256:${"8".repeat(64)}`,
            membershipSnapshotHash: null
          };
        }
      },
      closureEvidence: {
        async getAt() {
          return null;
        }
      }
    }
  };
  const repository = new InMemoryAdvisorRecommendationRepository();
  const receipts: Array<{
    id: string;
    recommendationId: string;
    recommendationRevision: number;
    stableActionHash: `sha256:${string}`;
    operationId: string;
  }> = [];
  const service = new AdvisorRecommendationService({
    repository,
    visibility,
    verifier: new DefaultAdvisorReferenceVerifier(ports),
    temporalBarrier: barrier,
    assignability: createGrowthWorkspaceMemberAssignabilityReader({
      members: () => [
        { id: "sales-a", teamId: "ws-1", role: "sales" as const,
          status: "active" as const },
        { id: "sales-b", teamId: "ws-1", role: "sales" as const,
          status: "active" as const }
      ]
    }),
    actionOperations: {
      async findByStableHash() {
        return null;
      },
      async listReceiptsFor() {
        return Object.freeze([...receipts]);
      }
    },
    now: () => "2026-08-09T09:00:00.000Z"
  });
  return {
    service,
    repository,
    barrier,
    authority,
    receipts,
    binding
  };
}

function validRecommendationInput(
  overrides: Partial<AdvisorRecommendationCreateInput> = {}
): AdvisorRecommendationCreateInput {
  return {
    audienceRole: "manager",
    type: "quote_risk",
    summary: "审批即将过期的报价",
    rationale: "报价版本 quote-v1 即将到期",
    metricRefs: Object.freeze([{
      kind: "priority_score",
      candidateId: "candidate-1",
      qualificationDecisionId: "qualification-1",
      qualificationDecisionVersion: "qualification-v1",
      inputSnapshotHash: `sha256:${"1".repeat(64)}`
    }]),
    evidenceRefs: Object.freeze([]),
    entityRefs: Object.freeze([{
      kind: "quote_version",
      id: "quote-v1",
      lifecycleRevision: 4,
      commercialAmountHash: `sha256:${"c".repeat(64)}`
    }]),
    confidenceBps: 8_700,
    riskLevel: "high",
    recommendedAction: {
      kind: "create_quote_approval_task",
      quoteVersionId: "quote-v1",
      quoteVersionRevision: 4
    },
    assignedTo: null,
    dataAsOf: "2026-08-09T08:00:00.000Z",
    modelSnapshotRef: "model-snapshot-7",
    promptVersion: "growth-advisor.v1",
    generationIdempotencyKey: "generation-1",
    ...overrides
  };
}

test("creation freezes verified references and model snapshot", async () => {
  const fixture = await createServiceFixture();
  const created = await fixture.service.create(
    command("recommend-1", managerWorkspace),
    validRecommendationInput()
  );
  assert.equal(created.status, "proposed");
  assert.equal(created.modelSnapshotRef, "model-snapshot-7");
  assert.match(created.inputSnapshotHash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(created.metricRefs), true);
  assert.equal(Object.isFrozen(created.recommendedAction), true);
  assert.equal(created.dataAsOf, "2026-08-09T08:00:00.000Z");
  assert.equal(
    (await fixture.repository.findById(managerWorkspace, created.id))
      ?.revision,
    1
  );
});

test("every embedded asOf must equal the one recommendation cutoff", async () => {
  const fixture = await createServiceFixture();
  await assert.rejects(
    fixture.service.create(
      command("mixed-asof", managerWorkspace),
      validRecommendationInput({
        metricRefs: Object.freeze([{
          kind: "growth_performance",
          cohortId: "cohort-1",
          currency: "CNY",
          asOf: "2026-08-09T08:00:00.001Z",
          planId: null,
          closureVersionId: null,
          sliceKey: "all",
          calculationHash: `sha256:${"8".repeat(64)}`
        }])
      })
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "advisor_reference_invalid"
  );
});

test("accept does not execute an unapproved or unsupported action", async () => {
  const fixture = await createServiceFixture();
  const created = await fixture.service.create(
    command("recommend-accept", managerWorkspace),
    validRecommendationInput()
  );
  const accepted = await fixture.service.accept(
    command("accept-1", managerWorkspace, 1),
    created.id
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.revision, 2);
});

test("sales cannot transition another sales owner's recommendation", async () => {
  const fixture = await createServiceFixture();
  const stored = recommendationFixture({
    id: "recommendation-sales-a",
    workspaceId: "ws-1",
    assignedTo: "sales-a",
    audienceRole: "sales",
    status: "proposed",
    revision: 1
  });
  fixture.repository.seed(stored);
  await assert.rejects(
    fixture.service.accept(
      command("cross-sales", salesWorkspace("sales-b"), 1),
      stored.id
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "advisor_recommendation_forbidden"
  );
});

test("complete accepts no caller outcome refs and attaches only its exact persisted receipt", async () => {
  const fixture = await createServiceFixture();
  const stored = recommendationFixture({
    id: "recommendation-complete",
    workspaceId: "ws-1",
    assignedTo: "sales-a",
    audienceRole: "sales",
    status: "accepted",
    revision: 2
  });
  fixture.repository.seed(stored);
  const stableHash = stableAdvisorActionHash({
    workspaceId: stored.workspaceId,
    recommendationId: stored.id,
    recommendationRevision: stored.revision,
    recommendedAction: stored.recommendedAction,
    bindingSnapshotHash: stored.inputSnapshotHash
  });
  fixture.receipts.push({
    id: "receipt-1",
    recommendationId: stored.id,
    recommendationRevision: 2,
    stableActionHash: stableHash,
    operationId: "operation-1"
  });
  const completed = await fixture.service.complete(
    command("complete", salesWorkspace("sales-a"), 2),
    stored.id
  );
  assert.deepEqual(completed.outcomeRefs, [
    { kind: "action_receipt", id: "receipt-1" }
  ]);
  await assert.rejects(
    () => fixture.service.complete(
      command("fake", salesWorkspace("sales-a"), 2),
      stored.id,
      [{ kind: "action_receipt", id: "other" }] as never
    ),
    /schema_validation_failed|too_many_arguments/u
  );
});

test("missing or swapped receipts fail completion with zero transition", async () => {
  const fixture = await createServiceFixture();
  const stored = recommendationFixture({
    id: "recommendation-orphan",
    workspaceId: "ws-1",
    assignedTo: "sales-a",
    audienceRole: "sales",
    status: "accepted",
    revision: 2
  });
  fixture.repository.seed(stored);
  await assert.rejects(
    fixture.service.complete(
      command("complete-orphan", salesWorkspace("sales-a"), 2),
      stored.id
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "advisor_recommendation_forbidden"
  );
});

test("council accepted creation rejects a structural lookalike proof", async () => {
  const fixture = await createServiceFixture();
  const proofs = new FinancialCouncilApprovalProofIssuer({
    async getApproval() { return null; }
  });

  await assert.rejects(
    () => fixture.service.createAcceptedFromCouncil(
      command("council-proof", managerWorkspace),
      { councilActionId: `sha256:${"a".repeat(64)}`,
        recommendation: validRecommendationInput() },
      { approvalId: `sha256:${"b".repeat(64)}` }, proofs
    ),
    (error: unknown) => (error as { code?: string }).code
      === "financial_council_approval_proof_invalid"
  );
});

test("verified council proof creates one accepted recommendation through normal reference validation", async () => {
  const fixture = await createServiceFixture();
  const approval = createFinancialCouncilApprovalRecord({
    workspaceId: "ws-1", runId: "run-1", portfolioRevision: 2,
    portfolioKind: "balanced", approvedActionIds: [`sha256:${"a".repeat(64)}`],
    approvedActionHashes: [{ actionId: `sha256:${"a".repeat(64)}`,
      actionHash: `sha256:${"0".repeat(64)}` }],
    requiredCapabilities: ["finance.council.approve"], approverId: "manager-1",
    portfolioOutputHash: `sha256:${"b".repeat(64)}`, snapshotId: "snapshot-1",
    snapshotHash: `sha256:${"c".repeat(64)}`, policyVersionId: "policy-1",
    policyHash: `sha256:${"d".repeat(64)}`, sourceSetHash: `sha256:${"e".repeat(64)}`,
    commandKeyHash: `sha256:${"f".repeat(64)}`,
    commandRequestHash: `sha256:${"1".repeat(64)}`, status: "approved",
    reason: null, approvedAt: "2026-08-09T08:00:00.000Z"
  });
  const proofs = new FinancialCouncilApprovalProofIssuer({
    async getApproval() { return approval; }
  });
  const proof = await proofs.issue({ workspaceId: "ws-1", runId: "run-1",
    approvalId: approval.approvalId, actionId: `sha256:${"a".repeat(64)}` });

  const created = await fixture.service.createAcceptedFromCouncil(
    command("caller-controlled-key", managerWorkspace), {
      councilActionId: proof.actionId,
      recommendation: validRecommendationInput({ generationIdempotencyKey: "ignored" })
    }, proof, proofs
  );
  const replay = await fixture.service.createAcceptedFromCouncil(
    command("changed-caller-key", managerWorkspace), {
      councilActionId: proof.actionId,
      recommendation: validRecommendationInput({ generationIdempotencyKey: "other" })
    }, proof, proofs
  );

  assert.equal(created.status, "accepted");
  assert.equal(created.acceptedBy, "manager-1");
  assert.equal(replay.id, created.id);
  assert.equal(replay.status, "accepted");
});

test("council dispatch probes its accepted recommendation before stable replay", async () => {
  const fixture = await createServiceFixture();
  const approval = createFinancialCouncilApprovalRecord({
    workspaceId: "ws-1", runId: "run-1", portfolioRevision: 2,
    portfolioKind: "balanced", approvedActionIds: [`sha256:${"a".repeat(64)}`],
    approvedActionHashes: [{ actionId: `sha256:${"a".repeat(64)}`,
      actionHash: `sha256:${"0".repeat(64)}` }],
    requiredCapabilities: ["finance.council.approve"], approverId: "manager-1",
    portfolioOutputHash: `sha256:${"b".repeat(64)}`, snapshotId: "snapshot-1",
    snapshotHash: `sha256:${"c".repeat(64)}`, policyVersionId: "policy-1",
    policyHash: `sha256:${"d".repeat(64)}`, sourceSetHash: `sha256:${"e".repeat(64)}`,
    commandKeyHash: `sha256:${"f".repeat(64)}`,
    commandRequestHash: `sha256:${"1".repeat(64)}`, status: "approved",
    reason: null, approvedAt: "2026-08-09T08:00:00.000Z"
  });
  const proofs = new FinancialCouncilApprovalProofIssuer({
    async getApproval() { return approval; }
  });
  const proof = await proofs.issue({ workspaceId: "ws-1", runId: "run-1",
    approvalId: approval.approvalId, actionId: `sha256:${"a".repeat(64)}` });
  const dispatchHash = `sha256:${"9".repeat(64)}` as `sha256:${string}`;

  assert.equal(await fixture.service.probeByDispatchHash(
    managerWorkspace, dispatchHash
  ), null);
  const created = await fixture.service.createFromApprovedDispatch(
    command("caller-controlled-key", managerWorkspace), {
      dispatchHash, councilActionId: proof.actionId,
      recommendation: validRecommendationInput({ generationIdempotencyKey: "ignored" })
    }, proof, proofs
  );
  const replay = await fixture.service.createFromApprovedDispatch(
    command("changed-caller-key", managerWorkspace), {
      dispatchHash, councilActionId: proof.actionId,
      recommendation: validRecommendationInput({ generationIdempotencyKey: "other" })
    }, proof, proofs
  );

  assert.deepEqual(replay.resourceRefs, created.resourceRefs);
  assert.match(created.contentHash, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(await fixture.service.probeByDispatchHash(
    managerWorkspace, dispatchHash
  ), created);
});
