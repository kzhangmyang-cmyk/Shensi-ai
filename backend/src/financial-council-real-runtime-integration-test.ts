import assert from "node:assert/strict";
import test from "node:test";
import { MysqlFinancialCouncilDraftRepository } from
  "./financial-council-draft-mysql-repository.js";
import { completeFinancialCouncilIntegrationReport,
  createFinancialCouncilIntegrationFixture,
  financialCouncilIntegrationCommand,
  financialCouncilIntegrationPolicyInput,
  financialCouncilIntegrationWorkspace } from
  "./financial-council-integration-fixtures.js";
import { MysqlFinancialCouncilModelRoutingRepository,
  ensureFinancialCouncilModelRoutingMysqlSchema } from
  "./financial-council-model-routing-mysql-repository.js";
import { MysqlFinancialCouncilPolicyRepository } from
  "./financial-council-policy-mysql-repository.js";
import { MysqlFinancialCouncilRepository } from
  "./financial-council-mysql-repository.js";
import { createFinancialCouncilMysqlTestDatabase,
  requireFinancialCouncilMysqlTestAdminUrl } from
  "./financial-council-mysql-test-support.js";
import { routingPolicyVersion, routingPutCommand } from
  "./financial-council-model-routing-repository-contract-test.js";
import { financialCouncilCanonicalHash } from
  "./financial-council-domain.js";
import { MysqlFinancialStatementPackageRepository,
  ensureFinancialStatementPackageMysqlSchema } from
  "./financial-statement-package-mysql-repository.js";
import { FinancialStatementPackageService } from
  "./financial-statement-package-service.js";
import { previewFixture } from
  "./financial-statement-package-repository-contract-test.js";

requireFinancialCouncilMysqlTestAdminUrl("financial-council-real-runtime");

test("one owned MySQL database survives two runtime instances from package to draft receipts", async () => {
  const database = await createFinancialCouncilMysqlTestDatabase();
  let firstPool: ReturnType<typeof database.openPool> | undefined;
  let secondPool: ReturnType<typeof database.openPool> | undefined;
  try {
    firstPool = database.openPool();
    await Promise.all([
      ensureFinancialCouncilModelRoutingMysqlSchema(firstPool),
      ensureFinancialStatementPackageMysqlSchema(firstPool)
    ]);
    const firstRepository = new MysqlFinancialCouncilRepository(firstPool);
    const firstPolicies = new MysqlFinancialCouncilPolicyRepository(firstPool);
    const firstDrafts = new MysqlFinancialCouncilDraftRepository(firstPool);
    const firstRouting = new MysqlFinancialCouncilModelRoutingRepository(
      firstPool
    );
    const statementRepository = new MysqlFinancialStatementPackageRepository(
      firstPool
    );
    const statements = new FinancialStatementPackageService({
      repository: statementRepository
    });
    const base = previewFixture();
    const businessReport = completeFinancialCouncilIntegrationReport();
    const preimage = { ...base, workspaceId: "council-e2e", businessReport,
      reportInputHash: financialCouncilCanonicalHash(businessReport) };
    const { previewHash: _ignored, ...withoutHash } = preimage;
    const preview = Object.freeze({ ...withoutHash,
      previewHash: financialCouncilCanonicalHash(withoutHash) });
    await statementRepository.appendPreview(preview);
    const committed = await statementRepository.commitPreview({
      workspaceId: preview.workspaceId, previewId: preview.previewId,
      packageId: "package-restart", consent: { accepted: true,
        noticeVersion: "financial-model-data.v1", acceptedBy: "actor-a",
        acceptedAt: "2026-08-16T08:09:00.000Z" },
      idempotencyKeyHash: `sha256:${"1".repeat(64)}`,
      requestHash: `sha256:${"2".repeat(64)}`,
      createdAt: "2026-08-16T08:09:00.000Z"
    });
    await firstRouting.put(routingPutCommand({ workspaceId: "council-e2e",
      actorId: "council-admin" }), routingPolicyVersion("council-e2e", 1, {
      createdBy: "council-admin"
    }));
    const first = await createFinancialCouncilIntegrationFixture({
      repository: firstRepository, policyRepository: firstPolicies,
      draftRepository: firstDrafts,
      statementPackageRepository: statements,
      modelRoutingRepository: firstRouting
    });
    let runId: string;
    let frozenIdentity: readonly unknown[];
    try {
      const currentPolicy = await first.service.getPolicy(
        financialCouncilIntegrationWorkspace()
      );
      const policy = await first.service.updatePolicy(
        financialCouncilIntegrationCommand("restart-policy",
          currentPolicy.revision), financialCouncilIntegrationPolicyInput()
      );
      const created = await first.service.createRunFromStatementPackage(
        financialCouncilIntegrationCommand("restart-run", null), {
          statementPackageId: committed.value.packageId,
          policyVersionId: policy.value.policyVersionId
        }
      );
      runId = created.value.runId;
      const firstLease = (await firstRepository.claimAnalysisRun({
        workspaceId: "council-e2e", runId, workerId: "first-runtime",
        leaseToken: "a".repeat(64),
        claimedAt: "2026-08-16T08:10:00.000Z",
        leaseExpiresAt: "2026-08-16T08:11:00.000Z"
      }))!;
      await assert.rejects(firstRepository.transitionRunWithLease(firstLease, {
        kind: "analyzing", occurredAt: "2026-08-16T08:11:00.000Z",
        reasonCode: null
      }), (error: unknown) => (error as { code?: unknown }).code ===
        "financial_council_lease_stale");
      const secondLease = (await firstRepository.claimAnalysisRun({
        workspaceId: "council-e2e", runId, workerId: "first-runtime",
        leaseToken: "b".repeat(64),
        claimedAt: "2026-08-16T08:11:00.000Z",
        leaseExpiresAt: "2026-08-16T08:12:00.000Z"
      }))!;
      await assert.rejects(firstRepository.transitionRunWithLease(firstLease, {
        kind: "analyzing", occurredAt: "2026-08-16T08:10:30.000Z",
        reasonCode: null
      }), (error: unknown) => (error as { code?: unknown }).code ===
        "financial_council_lease_stale");
      await firstRepository.releaseAnalysisLease(secondLease,
        "2026-08-16T08:11:00.001Z");
      const frozen = await firstRepository.getVerifiedRunSnapshot(
        financialCouncilIntegrationWorkspace(), runId
      );
      frozenIdentity = [created.value.statementPackageId,
        created.value.statementPackageHash, created.value.policyVersionId,
        created.value.modelRoutingPolicyVersionId, frozen?.snapshot.snapshotId,
        frozen?.snapshot.snapshotHash];
      await first.pipeline.wake((await firstRepository.findRun(
        financialCouncilIntegrationWorkspace(), runId))!);
      assert.equal((await first.service.getRun(
        financialCouncilIntegrationWorkspace(), runId)).status,
      "awaiting_approval");
    } finally {
      await first.close();
      await firstPool.end();
      firstPool = undefined;
    }

    secondPool = database.openPool();
    const secondRepository = new MysqlFinancialCouncilRepository(secondPool);
    const second = await createFinancialCouncilIntegrationFixture({
      repository: secondRepository,
      policyRepository: new MysqlFinancialCouncilPolicyRepository(secondPool),
      draftRepository: new MysqlFinancialCouncilDraftRepository(secondPool),
      statementPackageRepository: new FinancialStatementPackageService({
        repository: new MysqlFinancialStatementPackageRepository(secondPool)
      }), modelRoutingRepository:
        new MysqlFinancialCouncilModelRoutingRepository(secondPool)
    });
    try {
      const restored = await second.service.getRun(
        financialCouncilIntegrationWorkspace(), runId!
      );
      const restoredSnapshot = await secondRepository.getVerifiedRunSnapshot(
        financialCouncilIntegrationWorkspace(), runId!
      );
      assert.deepEqual([restored.statementPackageId,
        restored.statementPackageHash, restored.policyVersionId,
        restored.modelRoutingPolicyVersionId,
        restoredSnapshot?.snapshot.snapshotId,
        restoredSnapshot?.snapshot.snapshotHash], frozenIdentity!);
      const portfolio = await second.service.getPortfolioRevision(
        financialCouncilIntegrationWorkspace(), runId!, 1
      );
      const balanced = portfolio.portfolios.find((row) =>
        row.kind === "balanced")!;
      const revision = await second.service.revisePortfolio(
        financialCouncilIntegrationCommand("restart-revise",
          restored.revision), { runId: runId!, baseRevision: 1,
          operations: Object.freeze([Object.freeze({
            kind: "remove_action" as const,
            actionId: balanced.actionIds[0]!
          })]) }
      );
      await second.service.approve(financialCouncilIntegrationCommand(
        "restart-approve", restored.revision), { runId: runId!,
        portfolioRevision: revision.value.revision,
        portfolioKind: "balanced" });
      await second.dispatch.sweep();
      const dispatches = await second.service.listDispatches(
        financialCouncilIntegrationWorkspace(), runId!
      );
      assert.equal(dispatches.length > 0, true);
      assert.equal(dispatches.every((row) => row.status === "succeeded"
        && row.receiptId !== null), true);
      const outboxAgain = await second.service.listDispatches(
        financialCouncilIntegrationWorkspace(), runId!
      );
      assert.deepEqual(outboxAgain, dispatches);
    } finally {
      await second.close();
      await secondPool.end();
      secondPool = undefined;
    }
  } finally {
    await firstPool?.end().catch(() => undefined);
    await secondPool?.end().catch(() => undefined);
    await database.close();
  }
});
