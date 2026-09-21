import assert from "node:assert/strict";
import test from "node:test";
import { MysqlFinancialCouncilDraftRepository } from
  "./financial-council-draft-mysql-repository.js";
import { completeFinancialCouncilIntegrationReport,
  createFinancialCouncilIntegrationFixture,
  financialCouncilIntegrationCommand,
  financialCouncilIntegrationForecastInput,
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
import { buildFinancialFormulaCatalog } from
  "./financial-council-formulas.js";
import { MysqlFinancialStatementPackageRepository,
  ensureFinancialStatementPackageMysqlSchema } from
  "./financial-statement-package-mysql-repository.js";
import { FinancialStatementPackageService } from
  "./financial-statement-package-service.js";
import { previewFixture } from
  "./financial-statement-package-repository-contract-test.js";

requireFinancialCouncilMysqlTestAdminUrl("financial-council-real-runtime");

function cashFormulaIdentity(input: Parameters<
  typeof buildFinancialFormulaCatalog
>[0]) {
  const ids = new Set(["cashflow_forecast", "eligible_overdue_receivable",
    "cash_shortfall"]);
  return buildFinancialFormulaCatalog(input).formulaResults
    .filter((row) => ids.has(row.formulaId))
    .map((row) => Object.freeze({ formulaId: row.formulaId,
      inputHash: row.inputHash, resultHash: row.resultHash }));
}

test("one owned MySQL database survives two runtime instances from package to draft receipts", async () => {
  const database = await createFinancialCouncilMysqlTestDatabase();
  let firstPool: ReturnType<typeof database.openPool> | undefined;
  let secondPool: ReturnType<typeof database.openPool> | undefined;
  try {
    firstPool = database.openPool();
    const [firstConnectionRows] = await firstPool.query(
      "SELECT CONNECTION_ID() AS connectionId"
    );
    const firstConnectionId = Number((firstConnectionRows as Array<{
      connectionId: number;
    }>)[0]!.connectionId);
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
      repository: statementRepository,
      now: () => "2026-08-16T08:09:00.000Z"
    });
    const base = previewFixture();
    const report = completeFinancialCouncilIntegrationReport();
    const period = base.period;
    const businessReport = Object.freeze({ ...report, period,
      balanceSheet: Object.freeze({ ...report.balanceSheet, period }),
      incomeStatement: Object.freeze({ ...report.incomeStatement, period }),
      cashFlow: Object.freeze({
        period,
        openingCashMinor: report.cashFlow!.openingCashMinor,
        operatingInflowMinor: report.cashFlow!.operatingInflowMinor,
        operatingOutflowMinor: report.cashFlow!.operatingOutflowMinor,
        investingNetMinor: report.cashFlow!.investingNetMinor,
        financingNetMinor: report.cashFlow!.financingNetMinor,
        forecast: Object.freeze({ status: "not_computable" as const,
          reason: "source_statements_do_not_provide_forecast" as const })
      })
    });
    const preimage = { ...base, workspaceId: "council-e2e", businessReport,
      reportInputHash: financialCouncilCanonicalHash(businessReport) };
    const { previewHash: _ignored, ...withoutHash } = preimage;
    const preview = Object.freeze({ ...withoutHash,
      previewHash: financialCouncilCanonicalHash(withoutHash) });
    await statementRepository.appendPreview(preview);
    const committed = await statements.commit({
      workspaceId: preview.workspaceId, actorId: "actor-a",
      idempotencyKey: "restart-package",
      requestHash: `sha256:${"2".repeat(64)}`
    }, { previewId: preview.previewId, consent: { accepted: true,
        noticeVersion: "financial-model-data.v1", acceptedBy: "actor-a",
        acceptedAt: "2026-08-16T08:09:00.000Z" },
      cashForecast: financialCouncilIntegrationForecastInput()
    });
    assert.equal(committed.value.forecastStatus, "computed");
    assert.match(committed.value.cashForecast!.forecastHash,
      /^sha256:[0-9a-f]{64}$/u);
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
      await first.pipeline.wake((await firstRepository.findRun(
        financialCouncilIntegrationWorkspace(), runId))!);
      const run1 = await first.service.getRun(
        financialCouncilIntegrationWorkspace(), runId
      );
      assert.equal(run1.status, "awaiting_approval");
      const frozen = (await firstRepository.getVerifiedRunSnapshot(
        financialCouncilIntegrationWorkspace(), runId
      ))!;
      const formulaIdentity = cashFormulaIdentity({
        snapshot: frozen.snapshot,
        businessReport: committed.value.businessReport,
        policy: Object.freeze({
          formulaPolicyVersion: "financial-council-formula-policy.v1" as const,
          minimumProductMarginBps: 1_000,
          minimumCashReserveMinor: 900_000
        })
      });
      assert.equal(formulaIdentity.length, 3);
      const portfolio = await first.service.getPortfolioRevision(
        financialCouncilIntegrationWorkspace(), runId, 1
      );
      frozenIdentity = [committed.value.packageId,
        committed.value.packageHash, committed.value.reportInputHash,
        committed.value.cashForecast!.forecastHash,
        created.value.statementPackageId,
        created.value.statementPackageHash, created.value.policyVersionId,
        created.value.modelRoutingPolicyVersionId,
        frozen.snapshot.snapshotId, frozen.snapshot.snapshotHash,
        formulaIdentity, portfolio.revisionId, portfolio.outputHash];
    } finally {
      await first.close();
      await firstPool.end();
      firstPool = undefined;
    }

    secondPool = database.openPool();
    const [secondConnectionRows] = await secondPool.query(
      "SELECT CONNECTION_ID() AS connectionId"
    );
    const secondConnectionId = Number((secondConnectionRows as Array<{
      connectionId: number;
    }>)[0]!.connectionId);
    assert.notEqual(secondConnectionId, firstConnectionId,
      "runtime restart must use a distinct physical MySQL connection");
    const secondRepository = new MysqlFinancialCouncilRepository(secondPool);
    const secondStatements = new FinancialStatementPackageService({
      repository: new MysqlFinancialStatementPackageRepository(secondPool)
    });
    const second = await createFinancialCouncilIntegrationFixture({
      repository: secondRepository,
      policyRepository: new MysqlFinancialCouncilPolicyRepository(secondPool),
      draftRepository: new MysqlFinancialCouncilDraftRepository(secondPool),
      statementPackageRepository: secondStatements, modelRoutingRepository:
        new MysqlFinancialCouncilModelRoutingRepository(secondPool)
    });
    try {
      const restored = await second.service.getRun(
        financialCouncilIntegrationWorkspace(), runId!
      );
      const restoredSnapshot = await secondRepository.getVerifiedRunSnapshot(
        financialCouncilIntegrationWorkspace(), runId!
      );
      const restoredPackage = await secondStatements.getVerified({
        workspaceId: "council-e2e", actorId: "actor-a"
      }, committed.value.packageId);
      const restoredPortfolio = await second.service.getPortfolioRevision(
        financialCouncilIntegrationWorkspace(), runId!, 1
      );
      const restoredFormulaIdentity = cashFormulaIdentity({
        snapshot: restoredSnapshot!.snapshot,
        businessReport: restoredPackage.businessReport,
        policy: Object.freeze({
          formulaPolicyVersion: "financial-council-formula-policy.v1" as const,
          minimumProductMarginBps: 1_000,
          minimumCashReserveMinor: 900_000
        })
      });
      assert.deepEqual([restoredPackage.packageId,
        restoredPackage.packageHash, restoredPackage.reportInputHash,
        restoredPackage.cashForecast!.forecastHash,
        restored.statementPackageId,
        restored.statementPackageHash, restored.policyVersionId,
        restored.modelRoutingPolicyVersionId,
        restoredSnapshot?.snapshot.snapshotId,
        restoredSnapshot?.snapshot.snapshotHash,
        restoredFormulaIdentity, restoredPortfolio.revisionId,
        restoredPortfolio.outputHash], frozenIdentity!);
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
      const approval = await second.service.approve(financialCouncilIntegrationCommand(
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
      assert.equal(dispatches.every((row) =>
        row.approvalId === approval.value.approvalId), true);
      assert.equal((await second.service.getApproval(
        financialCouncilIntegrationWorkspace(), approval.value.approvalId
      )).approvalHash, approval.value.approvalHash);
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
