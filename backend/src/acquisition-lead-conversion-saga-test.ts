import assert from "node:assert/strict";
import test from "node:test";
import type {
  AcquisitionCandidate,
  DiscoveryEvidence,
  LeadConversionIntent
} from "./acquisition-domain.js";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import {
  AcquisitionDomainError,
  AcquisitionDomainService
} from "./acquisition-domain-service.js";
import {
  AcquisitionCrmLeadConversionPort,
  type AcquisitionLeadStore
} from "./acquisition-lead-conversion-port.js";
import {
  AcquisitionLeadConversionReconciliationService
} from "./acquisition-lead-conversion-reconciliation.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  createGrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";

const ownerScope = {
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "reviewer-a"
};

const otherScope = {
  ownerId: "owner-b",
  teamId: "team-b",
  actorId: "reviewer-b"
};

function candidate(
  id: string,
  scope = ownerScope
): AcquisitionCandidate {
  return {
    id,
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    partyType: "organization",
    partyRef: {
      partyType: "organization",
      organizationId: `org-${id}`,
      tenantProspectId: `prospect-${id}`
    },
    profile: {
      kind: "organization",
      name: `${id} 示例公司`,
      domain: `${id}.example.cn`,
      region: "厦门",
      creditCode: null
    },
    evidenceIds: [`evidence-${id}`],
    status: "approved",
    latestDecisionId: `qualification-${id}`,
    latestDecisionVersion: "decision-v1",
    approvedDecisionVersion: "decision-v1",
    hardGateFailures: [],
    leadId: null,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    version: 1
  };
}

function evidence(
  id: string,
  scope = ownerScope
): DiscoveryEvidence {
  return {
    id: `evidence-${id}`,
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    targetType: "organization",
    sourcePlatform: "baidu_ai_search",
    sourceTitle: "公开采购需求",
    sourceSnippet: "正在寻找企业服务系统",
    publishedAt: "2026-07-23T00:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:${"a".repeat(64)}`,
    contentHash: `sha256:${"b".repeat(64)}`,
    provenance: {
      kind: "search_result",
      provider: "baidu_ai_search",
      queryText: "企业服务 采购",
      sourceUrl: `https://${id}.example.cn/procurement`,
      resultRank: 1
    },
    accessStatus: "indexed_summary",
    supersedesEvidenceId: null,
    fetchedAt: "2026-07-24T00:00:00.000Z"
  };
}

function memoryStore(): AcquisitionLeadStore {
  return {
    leads: [],
    leadSourceEvents: [],
    leadActivities: [],
    async persist() {},
    async readBarrier() {}
  };
}

class FaultyRepository extends InMemoryAcquisitionDomainRepository {
  failNextConversionAppend = false;

  override async appendConversion(
    record: Parameters<
      InMemoryAcquisitionDomainRepository["appendConversion"]
    >[0]
  ) {
    if (this.failNextConversionAppend) {
      this.failNextConversionAppend = false;
      throw new Error("domain commit unavailable");
    }
    return super.appendConversion(record);
  }
}

async function seed(
  repository: InMemoryAcquisitionDomainRepository,
  item: AcquisitionCandidate,
  scope = ownerScope
) {
  await repository.appendEvidence(evidence(item.id, scope));
  await repository.insertCandidate(item);
}

function serviceFixture(
  repository: InMemoryAcquisitionDomainRepository,
  store: AcquisitionLeadStore,
  options: { failCrmAttempts?: number } = {}
) {
  const crm = new AcquisitionCrmLeadConversionPort({
    repository,
    store,
    now: () => "2026-07-24T08:00:00.000Z"
  });
  let remainingFailures = options.failCrmAttempts ?? 0;
  const service = new AcquisitionDomainService({
    repository,
    leadConversionPort: {
      async createLead(request) {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error("crm temporarily unavailable");
        }
        return crm.createLead(request);
      }
    },
    growthAcquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
      resolve: async () => null
    }),
    growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner()
    ),
    idFactory: (prefix) => `${prefix}-${crypto.randomUUID()}`,
    now: () => "2026-07-24T08:00:00.000Z"
  });
  return {
    service,
    reconciler: new AcquisitionLeadConversionReconciliationService({
      domainService: service
    })
  };
}

test("replay repairs domain state after CRM committed but final domain commit failed", async () => {
  const repository = new FaultyRepository();
  const store = memoryStore();
  const item = candidate("candidate-domain-failure");
  await seed(repository, item);
  const firstRuntime = serviceFixture(repository, store);
  repository.failNextConversionAppend = true;

  await assert.rejects(
    () => firstRuntime.service.convertCandidate(ownerScope, item.id, {
      decisionVersion: "decision-v1",
      idempotencyKey: "convert-domain-failure"
    }),
    (error: unknown) => (
      error instanceof AcquisitionDomainError
      && error.code === "conversion_failed"
    )
  );

  assert.equal(store.leads.length, 1);
  assert.equal(store.leadSourceEvents.length, 1);
  assert.equal(store.leadActivities.length, 1);
  assert.equal(
    (await repository.findCandidate(ownerScope, item.id))?.status,
    "approved"
  );
  assert.equal(
    (await repository.findConversionIntent(ownerScope, item.id))?.status,
    "crm_committed"
  );
  assert.equal(await repository.findConversion(ownerScope, item.id), null);

  const restarted = serviceFixture(repository, store);
  const replay = await restarted.service.convertCandidate(ownerScope, item.id, {
    decisionVersion: "decision-v1",
    idempotencyKey: "convert-domain-failure"
  });

  assert.equal(store.leads.length, 1);
  assert.equal(store.leadSourceEvents.length, 1);
  assert.equal(store.leadActivities.length, 1);
  assert.equal(replay.leadId, store.leads[0]?.id);
  assert.equal(
    (await repository.findCandidate(ownerScope, item.id))?.status,
    "converted_to_lead"
  );
  assert.equal(
    (await repository.findConversionIntent(ownerScope, item.id))?.status,
    "completed"
  );
  assert.equal(
    (await repository.listAuditEvents(ownerScope, item.id))
      .filter((event) => event.eventType === "candidate_converted_to_lead")
      .length,
    1
  );
});

test("a durable pending intent is recovered after a temporary CRM failure", async () => {
  const repository = new InMemoryAcquisitionDomainRepository();
  const store = memoryStore();
  const item = candidate("candidate-crm-failure");
  await seed(repository, item);
  const firstRuntime = serviceFixture(repository, store, {
    failCrmAttempts: 1
  });

  await assert.rejects(
    () => firstRuntime.service.convertCandidate(ownerScope, item.id, {
      decisionVersion: "decision-v1",
      idempotencyKey: "convert-crm-failure"
    }),
    (error: unknown) => (
      error instanceof AcquisitionDomainError
      && error.code === "conversion_failed"
    )
  );
  const pending = await repository.findConversionIntent(ownerScope, item.id);
  assert.equal(pending?.status, "pending_crm");
  assert.equal(pending?.attemptCount, 1);
  assert.match(pending?.lastError ?? "", /CRM 线索转换失败/);
  assert.equal(store.leads.length, 0);

  const restarted = serviceFixture(repository, store);
  const summary = await restarted.reconciler.runOnce({ limit: 10 });

  assert.deepEqual(summary, {
    inspected: 1,
    completed: 1,
    failed: 0
  });
  assert.equal(store.leads.length, 1);
  assert.equal(store.leadSourceEvents.length, 1);
  assert.equal(store.leadActivities.length, 1);
  assert.equal(
    (await repository.findCandidate(ownerScope, item.id))?.status,
    "converted_to_lead"
  );
});

test("concurrent and restarted replays converge to one scoped conversion", async () => {
  const repository = new InMemoryAcquisitionDomainRepository();
  const store = memoryStore();
  const item = candidate("candidate-concurrent");
  await seed(repository, item);
  const runtime = serviceFixture(repository, store);
  const request = {
    decisionVersion: "decision-v1",
    idempotencyKey: "convert-concurrent"
  };

  const [left, right] = await Promise.all([
    runtime.service.convertCandidate(ownerScope, item.id, request),
    runtime.service.convertCandidate(ownerScope, item.id, request)
  ]);
  const restarted = serviceFixture(repository, store);
  const replay = await restarted.service.convertCandidate(
    ownerScope,
    item.id,
    request
  );

  assert.equal(left.id, right.id);
  assert.equal(left.id, replay.id);
  assert.equal(store.leads.length, 1);
  assert.equal(store.leadSourceEvents.length, 1);
  assert.equal(store.leadActivities.length, 1);
  assert.equal(
    (await repository.listRecoverableConversionIntents(10)).length,
    0
  );
});

test("conversion intents and reconciliation preserve tenant isolation", async () => {
  const repository = new InMemoryAcquisitionDomainRepository();
  const store = memoryStore();
  const ownerCandidate = candidate("shared-id", ownerScope);
  const otherCandidate = candidate("other-id", otherScope);
  await seed(repository, ownerCandidate, ownerScope);
  await seed(repository, otherCandidate, otherScope);
  const ownerRuntime = serviceFixture(repository, store, {
    failCrmAttempts: 1
  });

  await assert.rejects(() => ownerRuntime.service.convertCandidate(
    ownerScope,
    ownerCandidate.id,
    {
      decisionVersion: "decision-v1",
      idempotencyKey: "convert-owner"
    }
  ));

  assert.equal(
    await repository.findConversionIntent(otherScope, ownerCandidate.id),
    null
  );
  assert.equal(
    (await repository.findCandidate(otherScope, otherCandidate.id))?.status,
    "approved"
  );
  assert.equal(
    (await repository.listRecoverableConversionIntents(10))
      .filter((intent: LeadConversionIntent) =>
        intent.ownerId === otherScope.ownerId
      )
      .length,
    0
  );
});
