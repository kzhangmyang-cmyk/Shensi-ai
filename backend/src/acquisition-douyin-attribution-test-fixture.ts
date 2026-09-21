import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { InMemoryAcquisitionCrawlerJobRepository } from "./acquisition-crawler-job-repository.js";
import { normalizedDouyinContentHash, type NormalizedDouyinRecord } from "./acquisition-crawler-job.js";
import { InMemoryAcquisitionDomainRepository } from "./acquisition-domain-repository.js";
import { InMemoryAcquisitionDouyinCrawlerIngestionRepository } from "./acquisition-douyin-crawler-ingestion-repository.js";
import { ingestDouyinCrawlerPage } from "./acquisition-douyin-crawler-ingestion.js";
import {
  createDouyinCollectionAcquisitionRun,
  InMemoryAcquisitionPlanRunRepository,
  type AcquisitionPlan,
  type AcquisitionPlanPayload,
  type AcquisitionPlanVersion
} from "./acquisition-plan-run-repository.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import { createGrowthAcquisitionWorkspaceResolver } from "./growth-workspace-context.js";

const scope = Object.freeze({ ownerId: "owner-1", teamId: "team-1", actorId: "worker-1" });
const now = "2026-08-25T01:00:00.000Z";

function record(overrides: Partial<Omit<NormalizedDouyinRecord, "contentHash">> = {}): NormalizedDouyinRecord {
  const value = {
    recordId: "comment-handoff-1",
    kind: "comment" as const,
    actorKind: "commenter" as const,
    canonicalUrl: "https://www.douyin.com/video/7350000000000000001",
    publicDisplayName: "Public buyer",
    publicProfileUrl: "https://www.douyin.com/user/handoff-buyer-1",
    textExcerpt: "正在寻找门店获客方案，想咨询报价。",
    sourceKeyword: "门店获客",
    observedAt: now,
    ...overrides
  };
  return { ...value, contentHash: normalizedDouyinContentHash(value) };
}

/** Isolated persisted collection/ingestion only: no CRM, model, browser, or sends. */
export async function createDouyinAttributionTestFixture(options: {
  legacyExecutionMode?: boolean;
} = {}) {
  const bindings = new Map([
    [JSON.stringify([scope.ownerId, scope.teamId]), {
      workspaceId: "workspace-1", kind: "team" as const, bindingRevision: "binding-v1"
    }]
  ]);
  const workspace = createGrowthAcquisitionWorkspaceResolver({
    async resolve(value) {
      return bindings.get(JSON.stringify([value.ownerId, value.teamId])) ?? null;
    }
  });
  const resolvedWorkspace = await workspace.resolve(scope);
  assert.ok(resolvedWorkspace);
  const workspaceId = resolvedWorkspace.workspaceId;
  const planRuns = new InMemoryAcquisitionPlanRunRepository();
  const domain = new InMemoryAcquisitionDomainRepository(planRuns);
  const jobs = new InMemoryAcquisitionCrawlerJobRepository();
  const repository = new InMemoryAcquisitionDouyinCrawlerIngestionRepository(domain, planRuns);
  const planPayload: AcquisitionPlanPayload = {
    ...(options.legacyExecutionMode ? {} : { executionMode: "douyin_mediacrawler" as const }),
    targetPlatform: "douyin",
    name: "Public collection attribution",
    objective: "Review public demand before a human CRM handoff",
    icp: {
      industries: ["industrial"], regions: ["CN"], organizationCriteria: [],
      individualCriteria: [], exclusionRules: []
    },
    subjectChannels: { organization: false, individual: true },
    providerConnections: [], operations: [], modelSnapshotRef: null,
    budgetSnapshot: {
      billingCurrency: "CNY", maxRequests: 100, maxResults: 200,
      maxAmountMinor: 10_000, maxDurationSeconds: 3_600
    },
    stopConditions: { stopWhenBudgetExhausted: true, stopWhenNoMoreResults: true }
  };
  const version: AcquisitionPlanVersion = {
    id: "plan-version-1", planId: "plan-1", ownerId: scope.ownerId,
    teamId: scope.teamId, version: 1, payload: planPayload,
    payloadHash: `sha256:${createHash("sha256").update(canonicalJsonStringify(planPayload)).digest("hex")}`,
    createdBy: scope.actorId, createdAt: now
  };
  const plan: AcquisitionPlan = {
    id: "plan-1", ownerId: scope.ownerId, teamId: scope.teamId,
    status: "approved", version: 1, revision: 2, etag: '"plan-1:2"',
    currentVersionId: version.id, approvedVersionId: version.id,
    approvedSnapshotHash: version.payloadHash, approvedBy: scope.actorId, approvedAt: now,
    budgetSnapshot: planPayload.budgetSnapshot, payload: planPayload,
    createdBy: scope.actorId, createdAt: now, updatedBy: scope.actorId, updatedAt: now
  };
  await planRuns.transaction((transaction) => {
    transaction.putPlan(plan);
    transaction.appendPlanVersion(version);
  });

  async function ingestRun(input: {
    runId: string;
    jobId: string;
    localDate: string;
    recordOverrides?: Partial<Omit<NormalizedDouyinRecord, "contentHash">>;
  }) {
    const automationIntentId = `intent-${input.runId}`;
    const dailyBudgetId = `sha256:${"b".repeat(64)}`;
    await planRuns.transaction((transaction) => {
      transaction.putRun(createDouyinCollectionAcquisitionRun({
        id: input.runId, automationIntentId, plan, version, dailyBudgetId,
        reason: null, actorId: scope.actorId, createdAt: now
      }).run);
    });
    await jobs.createOrGet({
      id: input.jobId, workspaceId, runId: input.runId, automationIntentId,
      planId: plan.id, planVersionId: version.id, planSnapshotHash: version.payloadHash,
      policyVersionId: "policy-version-1", policyHash: `sha256:${"a".repeat(64)}`,
      accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId,
      localDate: input.localDate, trigger: "run_now", dailyCandidateLimit: 50,
      keywords: ["门店获客"], collectCreators: true, collectDemandComments: true,
      limits: { maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3, maxDurationSeconds: 3_600 },
      createdAt: now
    });
    await jobs.enqueue(workspaceId, input.runId, now);
    const claim = await jobs.claimNext(scope.actorId, now, 60_000);
    assert.ok(claim);
    assert.equal(claim.job.id, input.jobId);
    const job = await jobs.persistPage(claim.fence, {
      expectedCursor: null, nextCursor: null, records: [record(input.recordOverrides)],
      done: true, now,
      terminalActivity: { phase: "completed", currentKeyword: null, browserMode: "visible", sequence: 1 }
    });
    await ingestDouyinCrawlerPage({
      crawlerJobs: jobs, repository, workspaceId, runId: input.runId,
      scope, now: () => now
    });
    const discovered = (await planRuns.listRunEvents(input.runId))
      .find((event) => event.type === "candidate.discovered");
    assert.ok(discovered);
    assert.equal(typeof discovered.data.candidateId, "string");
    const candidate = await domain.findCandidate(scope, String(discovered.data.candidateId));
    assert.ok(candidate);
    const evidence = await domain.findEvidence(scope, candidate.evidenceIds[0]!);
    assert.ok(evidence);
    return {
      job, discovered, candidate, evidence,
      input: {
        runId: input.runId, discoveredEventId: discovered.id, candidateId: candidate.id,
        evidenceIds: [...candidate.evidenceIds], qualificationDecisionId: "decision-handoff",
        decisionVersion: "qualification.v1", decisionSnapshotHash: `sha256:${"c".repeat(64)}`
      }
    };
  }

  const first = await ingestRun({
    runId: "run-1", jobId: "job-handoff-attribution", localDate: "2026-08-25"
  });
  return {
    scope, now, workspaceId, workspace, planRuns, domain, jobs, repository, plan, version,
    crawler: { jobs, domain, workspace }, first, ingestRun
  };
}
