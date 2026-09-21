import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import express from "express";
import { AcquisitionDomainService } from "./acquisition-domain-service.js";
import { InMemoryAcquisitionDomainRepository } from "./acquisition-domain-repository.js";
import {
  createAcquisitionApplication,
  createProbabilityAssessmentQualificationService
} from "./acquisition-application.js";
import {
  InMemoryAcquisitionPlanRunRepository,
  type AcquisitionOperationShard,
  type AcquisitionRun
} from "./acquisition-plan-run-repository.js";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import { createGrowthCommercialApplication } from "./growth-commercial-application.js";
import { createGrowthCommercialCompositionForStore } from "./growth-commercial-composition.js";
import { createGrowthPrivateServiceRegistry } from "./growth-commercial-private-services.js";
import type { CommandContext } from "./growth-command-context.js";
import { loadGrowthContractRelease } from "./growth-openapi.js";
import {
  GROWTH_CATALOG_SERVICES
} from "./growth-catalog-module.js";
import {
  GROWTH_QUOTE_SERVICES
} from "./growth-quote-module.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  bindingInputFixture,
  quoteInputFixture
} from "./growth-quote-test-fixtures.js";
import { createMemoryStore, type CrmStore } from "./store.js";

const WORKSPACE = "team-a";
const SALES = "sales-1";
const MANAGER = "manager-1";
const ADMIN = "admin-1";
const NOW = "2026-08-11T08:00:00.000Z";

function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function workspace(
  role: "sales" | "manager" | "admin",
  actorId: string
): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId: WORKSPACE,
    kind: "team",
    actorId,
    role,
    teamId: WORKSPACE,
    capabilities: capabilitiesForHumanRole(role),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

let commandSequence = 0;
function command(
  activeWorkspace: ActiveWorkspaceContext,
  expectedRevision: number | null,
  label: string
): CommandContext {
  commandSequence += 1;
  const key = `${label}-${commandSequence}`;
  return Object.freeze({
    workspace: activeWorkspace,
    actorId: activeWorkspace.actorId,
    idempotencyKey: key,
    requestHash: hash(key),
    expectedRevision
  });
}

function isolatedStore(): CrmStore {
  const users = [
    { id: SALES, role: "sales" as const },
    { id: MANAGER, role: "manager" as const },
    { id: ADMIN, role: "admin" as const }
  ].map(({ id, role }) => ({
    id, role, name: id, email: `${id}@example.test`, password: "unused",
    teamId: WORKSPACE, avatar: "", status: "active" as const, authVersion: 1
  }));
  return createMemoryStore({
    mode: "memory", users, companyProfiles: [], customers: [], leads: [],
    leadActivities: [], leadSourceEvents: [], todos: [], deals: [],
    dealEvents: [], tradeDocuments: [], acquisitionCustomerHandoffs: [],
    acquisitionCustomerHandoffOperations: [], acquisitionOutcomeFeedback: [],
    acquisitionOutcomeReconciliationDiagnostics: [],
    acquisitionOutcomeReconciliationCheckpoints: [],
    acquisitionOutcomeReconciliationProcessedSources: [],
    async persist() {}, async readBarrier() {}, async close() {}
  });
}

async function seedAttribution(
  repository: InMemoryAcquisitionPlanRunRepository,
  input: {
    candidateId: string;
    qualificationDecisionId: string;
    decisionVersion: string;
    decisionSnapshotHash: string;
    evidenceIds: string[];
  }
) {
  const run: AcquisitionRun = {
    id: "run-quote-1", ownerId: SALES, teamId: WORKSPACE,
    planId: "plan-quote-1", planVersionId: "plan-version-quote-1",
    planVersion: 1, planSnapshotHash: hash("plan"), parentRunId: null,
    status: "succeeded", terminationIntent: null, revision: 2,
    etag: '"run-quote-1:2"', budgetSnapshotId: "budget-quote-1",
    budgetSnapshot: { billingCurrency: "CNY", maxRequests: 1,
      maxResults: 1, maxAmountMinor: 100, maxDurationSeconds: 60 },
    budgetSnapshotHash: hash("budget"), billingCurrency: "CNY",
    modelSnapshotRef: {
      jobSnapshotId: "snapshot-quote-1", connectionId: "model-quote-1",
      credentialVersion: 1, provider: "rules", model: "rules-v1",
      capabilitySnapshotHash: hash("capability"),
      promptVersion: "acquisition.v1", schemaVersion: "acquisition-plan.v1",
      promptHash: hash("prompt"), schemaHash: hash("schema")
    },
    consumedBudget: { requests: 1, results: 1, amountMinor: 100,
      durationSeconds: 1 }, evidenceCount: 1, reason: null,
    createdBy: SALES, createdAt: NOW, updatedBy: SALES, updatedAt: NOW,
    completedAt: NOW
  };
  const shard: AcquisitionOperationShard = {
    id: "shard-quote-1", runId: run.id, ownerId: SALES,
    teamId: WORKSPACE, operationId: "operation-quote-1",
    parentShardId: null, subjectChannel: "organization", kind: "search",
    connection: { connectionId: "connection-quote-1", providerId: "douyin",
      kind: "search", status: "active", credentialVersion: 1 },
    query: "douyin verified buyer", sourceRef: "", status: "succeeded",
    budgetSnapshotId: run.budgetSnapshotId,
    allocatedBudget: { requests: 1, results: 1, amountMinor: 100,
      durationSeconds: 60 },
    consumedBudget: structuredClone(run.consumedBudget),
    modelSnapshotRef: run.modelSnapshotRef, evidenceCount: 1, revision: 2,
    createdAt: NOW, updatedAt: NOW, completedAt: NOW
  };
  repository.transaction((transaction) => {
    transaction.putRun(run);
    transaction.putShard(shard);
    transaction.appendRunEvent({
      id: "discovered-quote-1", runId: run.id, shardId: shard.id,
      ownerId: SALES, teamId: WORKSPACE, type: "candidate.discovered",
      actorId: SALES, revision: 2, at: NOW,
      data: { candidateId: input.candidateId,
        operationId: shard.operationId,
        connectionId: shard.connection.connectionId }
    });
  });
  return Object.freeze({
    attributionVersion: "acquisition-run.v1" as const,
    runId: run.id, planId: run.planId, planVersionId: run.planVersionId,
    planVersion: run.planVersion, planSnapshotHash: run.planSnapshotHash,
    discoveredEventId: "discovered-quote-1", discoveredAt: NOW,
    shardId: shard.id, operationId: shard.operationId,
    connectionId: shard.connection.connectionId,
    providerId: shard.connection.providerId,
    evidenceIds: input.evidenceIds, providerIds: ["douyin"],
    queryIds: [`operation:${shard.operationId}`],
    strategyVersion: "acquisition-plan-v1",
    qualificationDecisionId: input.qualificationDecisionId,
    decisionVersion: input.decisionVersion,
    decisionSnapshotHash: input.decisionSnapshotHash
  });
}

export async function growthQuoteIntegrationFixture(
  options: { mode: "memory" }
) {
  assert.equal(options.mode, "memory");
  const store = isolatedStore();
  const domainRepository = new InMemoryAcquisitionDomainRepository();
  const planRunRepository = new InMemoryAcquisitionPlanRunRepository();
  domainRepository.bindPresentationRunRepository(planRunRepository);
  let domain: AcquisitionDomainService | null = null;
  const production = createGrowthCommercialCompositionForStore({
    store,
    findCandidate: async (workspaceId, candidateId) => {
      if (!domain || workspaceId !== WORKSPACE) return null;
      return domain.getCandidate({ ownerId: SALES, teamId: WORKSPACE,
        actorId: SALES }, candidateId).catch(() => null);
    }
  });
  const privateServices = createGrowthPrivateServiceRegistry();
  const growth = await createGrowthCommercialApplication({
    manifest: loadGrowthContractRelease().manifest,
    requireAuth: ((_req, _res, next) => next()) as express.RequestHandler,
    workspaceMiddleware: production.workspaceMiddleware,
    enabledFeatures: () => [], composition: production.composition,
    createPrivateServices: () => privateServices
  });
  const quoteServices = privateServices.require(GROWTH_QUOTE_SERVICES);
  const catalog = privateServices.require(GROWTH_CATALOG_SERVICES);
  assert.ok(quoteServices.publicationWorker);
  let timestamp = Date.parse(NOW);
  const rawDomain = new AcquisitionDomainService({
    repository: domainRepository,
    leadConversionPort: {
      async createLead() {
        return { leadId: "lead-quote-1",
          partyRef: (await domain!.getCandidate({ ownerId: SALES,
            teamId: WORKSPACE, actorId: SALES }, "candidate-quote-1")).partyRef };
      }
    },
    growthAcquisitionWorkspace: growth.integrations.acquisitionWorkspace,
    growthTemporalBarrier: growth.integrations.temporalBarrier,
    idFactory: (prefix) => prefix === "candidate"
      ? "candidate-quote-1" : `${prefix}-quote-${++commandSequence}`,
    now: () => new Date(timestamp++).toISOString()
  });
  domain = createProbabilityAssessmentQualificationService(
    rawDomain,
    growth.integrations.probabilityAssessments
  );
  let acquisition: Awaited<ReturnType<typeof createAcquisitionApplication>>
    | null = null;
  const sales = workspace("sales", SALES);
  const manager = workspace("manager", MANAGER);
  const admin = workspace("admin", ADMIN);

  async function createVerifiedDouyinCandidate() {
    const evidence = await domain!.appendEvidence({ ownerId: SALES,
      teamId: WORKSPACE, actorId: SALES }, {
      targetType: "organization", sourcePlatform: "douyin",
      sourceTitle: "Douyin verified buyer", sourceSnippet: "public demand",
      publishedAt: NOW, locale: "zh-CN", rawArtifactHash: hash("raw"),
      contentHash: hash("content"), provenance: {
        kind: "search_result", provider: "douyin", queryText: "buyer",
        sourceUrl: "https://www.douyin.com/user/verified-buyer", resultRank: 1
      }, accessStatus: "public_content"
    }, "evidence-douyin-1");
    const created = await domain!.createOrganizationCandidate({
      ownerId: SALES, teamId: WORKSPACE, actorId: SALES
    }, {
      name: "Douyin Buyer", domain: "douyin-buyer.example", region: "CN",
      creditCode: null, organizationId: "org-douyin-1",
      tenantProspectId: "prospect-douyin-1", evidenceIds: [evidence.id]
    }, "candidate-douyin-1");
    const qualified = await domain!.qualifyCandidate({ ownerId: SALES,
      teamId: WORKSPACE, actorId: SALES }, created.id, {
      decisionEngine: "rules", ruleVersion: "qualification-rules.v2",
      promptVersion: null, modelProvider: null, model: null,
      dimensions: { demandStrength: 95, fit: 90, identityConfidence: 95,
        buyingStage: 90, budgetPotential: 80, decisionReachability: 75,
        freshness: 95, evidenceDiversity: 80, negativeSignalRisk: 0,
        contactRisk: 5 },
      hardGates: { hasOriginalSource: true, identityResolved: true,
        notDoNotContact: true, noExplicitRejection: true,
        publicDataOnly: true, evidenceFresh: true, schemaValid: true },
      evidenceExcerpts: { [evidence.id]: "public demand" },
      reasons: ["verified public demand"]
    }, {
      currency: "CNY", predictedDealAmountMinor: 5_000_000,
      grossMarginBps: 6_000, closeProbabilityBps: 4_321,
      acquisitionCostMinor: 100_000, salesCostMinor: 100_000,
      serviceCostMinor: 300_000, benchmarkDealAmountMinor: 5_000_000,
      collectionDays: 15, creditRisk: 10, repeatPotential: 90,
      referralPotential: 80
    }, "qualification-douyin-1");
    await domain!.reviewCandidate({ ownerId: SALES, teamId: WORKSPACE,
      actorId: MANAGER }, created.id, { action: "approved",
      decisionVersion: qualified.qualification.decisionVersion,
      reason: "verified", idempotencyKey: "review-douyin-1" });
    await domain!.convertCandidate({ ownerId: SALES, teamId: WORKSPACE,
      actorId: MANAGER }, created.id, {
      decisionVersion: qualified.qualification.decisionVersion,
      idempotencyKey: "convert-douyin-1"
    });
    return { ...(await domain!.getCandidate({ ownerId: SALES,
      teamId: WORKSPACE, actorId: SALES }, created.id)), evidence, qualified };
  }

  async function convertCandidateToTrustedDeal(candidateId: string) {
    const candidate = await domain!.getCandidate({ ownerId: SALES,
      teamId: WORKSPACE, actorId: SALES }, candidateId);
    const decisions = await domain!.listQualificationDecisions({
      ownerId: SALES, teamId: WORKSPACE, actorId: SALES
    }, candidate.id);
    const latest = decisions.at(-1)!;
    const attribution = await seedAttribution(planRunRepository, {
      candidateId, qualificationDecisionId: latest.id,
      decisionVersion: latest.decisionVersion,
      decisionSnapshotHash: latest.snapshotHash,
      evidenceIds: candidate.evidenceIds
    });
    const base = bindingInputFixture();
    const customerId = "customer-quote-1";
    const dealId = "deal-quote-1";
    store.leads.push({ ...base.lead, id: "lead-quote-1",
      ownerId: SALES, teamId: WORKSPACE, externalId: candidate.id,
      convertedCustomerId: customerId, convertedDealId: dealId });
    store.customers.push({ ...base.customer, id: customerId,
      ownerId: SALES, teamId: WORKSPACE });
    store.deals.push({ ...base.deal, id: dealId, customerId,
      ownerId: SALES, teamId: WORKSPACE, stage: "已联系" });
    store.acquisitionCustomerHandoffs.push({ ...base.handoff,
      id: "handoff-quote-1", ownerId: SALES, teamId: WORKSPACE,
      candidateId: candidate.id, leadId: "lead-quote-1", customerId,
      dealId, decisionVersion: latest.decisionVersion,
      acquisitionAttribution: attribution });
    acquisition = await createAcquisitionApplication({
      store, masterSecret: "growth-quote-integration-secret-at-least-32-bytes",
      growthToolPorts: growth.toolPorts,
      acquisitionWorkspace: growth.integrations.acquisitionWorkspace,
      growthTemporalBarrier: growth.integrations.temporalBarrier,
      probabilityAssessments: growth.integrations.probabilityAssessments,
      quoteProjectedDocumentAuthority:
        growth.integrations.quoteProjectedDocumentAuthority,
      domainRepository, planRunRepository,
      outcomeReconciliationIntervalMs: 60_000
    });
    return { customerId, dealId };
  }

  async function seedCatalog() {
    const item = await catalog.catalogItems.create(
      command(admin, null, "catalog-create"),
      { type: "service", code: "QUOTE-SVC", name: "Quote Service",
        description: null, unit: "case" }
    );
    const draft = await catalog.pricingPolicies.createDraft(
      command(admin, null, "policy-create"), {
        catalogItemId: item.id, packageVersionId: null, currency: "CNY",
        listUnitPriceMinor: 10_000, unitStandardCostMinor: 6_000,
        defaultOrderDeliveryCostMinor: 100,
        defaultOrderSalesCostMinor: 100,
        defaultOrderServiceCostMinor: 100,
        absoluteFloorUnitPriceMinor: 7_000,
        standardDiscountLimitBps: 1_000,
        absoluteDiscountLimitBps: 3_000,
        targetGrossMarginBps: 3_000,
        absoluteMinimumGrossMarginBps: 1_000,
        standardPaymentTermDays: 30, absolutePaymentTermDays: 90,
        approvalThresholds: {
          discountCapability: "quote.exception.discount.approve",
          marginCapability: "quote.exception.margin.approve",
          paymentTermsCapability: "quote.exception.payment_terms.approve",
          giftCapability: "quote.exception.gift.approve",
          creditCapability: "quote.exception.credit.approve",
          manualCapability: "quote.exception.manual.approve",
          creditRiskThresholdBps: 5_000, manualEscalationEnabled: true
        }, surchargePolicies: [], giftPolicies: [],
        validFrom: "2026-01-01T00:00:00.000Z", validTo: null
      });
    const policy = await catalog.pricingPolicies.activate(
      command(admin, draft.revision, "policy-activate"), draft.id
    );
    return { item, policy };
  }

  return {
    store, createVerifiedDouyinCandidate, convertCandidateToTrustedDeal,
    quotes: {
      async createCase(input: Parameters<typeof quoteServices.quoteCases.create>[1]) {
        return (await quoteServices.quoteCases.create(
          command(sales, null, "case-create"), input)).value;
      },
      async preview(caseId: string) {
        const quoteCase = await quoteServices.quoteCases.get(sales, caseId);
        const seeded = await seedCatalog();
        const { workspaceId: _workspaceId, ...input } = quoteInputFixture({
          catalogItemId: seeded.item.id,
          pricingPolicyVersionId: seeded.policy.id
        });
        const preview = await growth.toolPorts.execute({
          name: "preview_quote",
          input: { quoteCaseId: caseId, quoteInput: input },
          stableCallHash: hash(`pi-preview-${caseId}`)
        }, command(sales, quoteCase.revision, "quote-preview")) as Awaited<
          ReturnType<typeof quoteServices.quoteVersions.preview>
        >["value"];
        return { ...preview, quoteInput: input };
      },
      async createVersion(caseId: string, previewIdentity: any,
        quoteInput: any) {
        const quoteCase = await quoteServices.quoteCases.get(sales, caseId);
        return (await quoteServices.quoteVersions.createVersion(
          command(sales, quoteCase.revision, "quote-draft"), caseId,
          { previewIdentity, quoteInput }
        )).value;
      },
      async submit(versionId: string) {
        const version = await quoteServices.quoteVersions.getVersion(
          sales, versionId
        );
        return (await quoteServices.quoteVersions.submit(
          command(sales, version.lifecycleRevision, "quote-submit"), versionId
        )).value;
      },
      async approve(versionId: string) {
        const version = await quoteServices.quoteVersions.getVersion(
          manager, versionId
        );
        return (await quoteServices.quoteApprovals.approve(
          command(manager, version.lifecycleRevision, "quote-approve"),
          versionId, { reason: "approved by human manager" }
        )).value;
      },
      getVersion: (id: string) => quoteServices.quoteVersions.getVersion(sales, id)
    },
    publication: {
      async drain(id: string) {
        const result = await quoteServices.publicationWorker!.runOne(id);
        assert.equal(result.status, "succeeded", JSON.stringify({
          operation: await quoteServices.repository.getPublication(id),
          version: await quoteServices.repository.getVersion(
            WORKSPACE,
            (await quoteServices.repository.getPublication(id))!.quoteVersionId
          ),
          authority: await quoteServices.repository.findCurrentDealAuthority(
            WORKSPACE,
            (await quoteServices.repository.getPublication(id))!.dealId
          )
        }));
      },
      async drainAfterExternalSuccess(id: string, kind: "pi" | "crm") {
        const original = store.mutateAuthoritativeQuoteProjection!;
        let injected = false;
        store.mutateAuthoritativeQuoteProjection = async (input) => {
          const result = await original(input);
          if (!injected && input.kind === kind) {
            injected = true;
            throw Object.assign(new Error(`injected_after_${kind}`), {
              code: `injected_after_${kind}`
            });
          }
          return result;
        };
        try {
          const failed = await quoteServices.publicationWorker!.runOne(id);
          assert.ok(["failed", "partial_failure"].includes(failed.status));
        } finally {
          store.mutateAuthoritativeQuoteProjection = original;
        }
        await quoteServices.repository.retryPublication(id, manager,
          new Date().toISOString());
        const recovered = await quoteServices.publicationWorker!.runOne(id);
        assert.equal(recovered.status, "succeeded");
      }
    },
    reconciler: {
      async run() {
        assert.ok(acquisition);
        return acquisition.runOutcomeReconciliation({
          ownerId: SALES, teamId: WORKSPACE
        });
      },
      async failAfterOutcomeWriteOnce() {
        assert.ok(acquisition);
        const original = domainRepository.appendOutcome.bind(domainRepository);
        let injected = false;
        domainRepository.appendOutcome = async (event) => {
          await original(event);
          if (!injected) {
            injected = true;
            throw new Error("injected_before_reconciler_checkpoint");
          }
        };
        try {
          const failed = await acquisition.runOutcomeReconciliation({
            ownerId: SALES, teamId: WORKSPACE
          });
          assert.equal(failed.failed, 1);
        } finally {
          domainRepository.appendOutcome = original;
        }
        return acquisition.runOutcomeReconciliation({
          ownerId: SALES, teamId: WORKSPACE
        });
      }
    },
    piDocumentsFor: (versionId: string) => store.tradeDocuments.filter(
      (row) => row.quoteVersionId === versionId),
    dealEventsFor: (versionId: string, type: string) => store.dealEvents.filter(
      (row) => row.quoteVersionIdSnapshot === versionId && row.type === type),
    outcomesFor: async (candidateId: string, type: string) =>
      (await domainRepository.listOutcomes({ ownerId: SALES,
        teamId: WORKSPACE }, candidateId)).filter((row) => row.eventType === type),
    authority: (dealId: string) => quoteServices.repository
      .findCurrentDealAuthority(WORKSPACE, dealId),
    async close() {
      await acquisition?.close();
      await growth.close();
    }
  };
}

test("Douyin candidate reaches one approved quote PI CRM event and Outcome", async () => {
  const app = await growthQuoteIntegrationFixture({ mode: "memory" });
  try {
    const candidate = await app.createVerifiedDouyinCandidate();
    const binding = await app.convertCandidateToTrustedDeal(candidate.id);
    const quoteCase = await app.quotes.createCase({ candidateId: candidate.id,
      customerId: binding.customerId, dealId: binding.dealId,
      assignedTo: SALES });
    const preview = await app.quotes.preview(quoteCase.id);
    const version = await app.quotes.createVersion(
      quoteCase.id, preview.previewIdentity, preview.quoteInput
    );
    const submission = await app.quotes.submit(version.id);
    const formal = submission.submittedVersion;
    assert.notEqual(formal.id, version.id);
    assert.equal((await app.quotes.getVersion(version.id))
      .probabilityAssessmentSnapshot, null);
    assert.equal(formal.probabilityAssessmentSnapshot?.closeProbabilityBps,
      4_321);
    const approved = await app.quotes.approve(formal.id);
    await app.publication.drain(approved.publicationOperation.id);
    await app.reconciler.run();
    assert.equal(app.piDocumentsFor(formal.id).length, 1);
    assert.equal(app.dealEventsFor(formal.id, "quote").length, 1);
    assert.equal((await app.outcomesFor(candidate.id, "quoted")).length, 1);
    assert.equal((await app.authority(binding.dealId))?.quoteVersionId,
      formal.id);
    assert.equal(app.piDocumentsFor(version.id).length, 0,
      "financial/document consumers must never receive the source draft id");
  } finally {
    await app.close();
  }
});

async function approvedPublication(app: Awaited<ReturnType<
  typeof growthQuoteIntegrationFixture
>>) {
  const candidate = await app.createVerifiedDouyinCandidate();
  const binding = await app.convertCandidateToTrustedDeal(candidate.id);
  const quoteCase = await app.quotes.createCase({ candidateId: candidate.id,
    customerId: binding.customerId, dealId: binding.dealId,
    assignedTo: SALES });
  const preview = await app.quotes.preview(quoteCase.id);
  const draft = await app.quotes.createVersion(quoteCase.id,
    preview.previewIdentity, preview.quoteInput);
  const formal = (await app.quotes.submit(draft.id)).submittedVersion;
  const approved = await app.quotes.approve(formal.id);
  return { candidate, binding, draft, formal, approved };
}

for (const failure of ["pi", "crm"] as const) {
  test(`publication recovers after external ${failure.toUpperCase()} success without duplicates`, async () => {
    const app = await growthQuoteIntegrationFixture({ mode: "memory" });
    try {
      const state = await approvedPublication(app);
      await app.publication.drainAfterExternalSuccess(
        state.approved.publicationOperation.id,
        failure
      );
      await app.reconciler.run();
      assert.equal(app.piDocumentsFor(state.formal.id).length, 1);
      assert.equal(app.dealEventsFor(state.formal.id, "quote").length, 1);
      assert.equal((await app.outcomesFor(state.candidate.id, "quoted")).length,
        1);
    } finally {
      await app.close();
    }
  });
}

test("reconciler retries a committed publication after failure before checkpoint", async () => {
  const app = await growthQuoteIntegrationFixture({ mode: "memory" });
  try {
    const state = await approvedPublication(app);
    await app.publication.drain(state.approved.publicationOperation.id);
    const recovered = await app.reconciler.failAfterOutcomeWriteOnce();
    assert.equal(recovered.reconciled, 1);
    assert.equal((await app.outcomesFor(state.candidate.id, "quoted")).length,
      1);
  } finally {
    await app.close();
  }
});
