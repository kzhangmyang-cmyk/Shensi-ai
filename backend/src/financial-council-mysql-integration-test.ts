import assert from "node:assert/strict";
import test from "node:test";
import { createFinancialCouncilDispatchRuntime } from
  "./financial-council-dispatch-runtime.js";
import { MysqlFinancialCouncilDraftRepository } from
  "./financial-council-draft-mysql-repository.js";
import {
  advanceFinancialCouncilToApproval,
  createFinancialCouncilIntegrationFixture,
  financialCouncilIntegrationCommand,
  financialCouncilIntegrationWorkspace
} from "./financial-council-integration-fixtures.js";
import { MysqlFinancialCouncilRepository } from
  "./financial-council-mysql-repository.js";
import {
  requireFinancialCouncilMysqlTestAdminUrl,
  withFinancialCouncilMysqlTestDatabase
} from "./financial-council-mysql-test-support.js";
import { MysqlFinancialCouncilPolicyRepository } from
  "./financial-council-policy-mysql-repository.js";

requireFinancialCouncilMysqlTestAdminUrl();

test("real MySQL council restarts between approval and draft dispatch", async () => {
  await withFinancialCouncilMysqlTestDatabase(async ({ databaseName, pool,
    connectionA, connectionB }) => {
    assert.notEqual(connectionA.threadId, connectionB.threadId);
    const repository = new MysqlFinancialCouncilRepository(pool);
    const policies = new MysqlFinancialCouncilPolicyRepository(pool);
    const drafts = new MysqlFinancialCouncilDraftRepository(pool);
    const fixture = await createFinancialCouncilIntegrationFixture({
      repository, policyRepository: policies, draftRepository: drafts
    });
    try {
      const authorityBefore = fixture.authorityReadHash();
      const awaiting = await advanceFinancialCouncilToApproval(fixture);
      assert.equal(awaiting.portfolios.length, 3);
      const graph = await repository.getAuditGraph(
        financialCouncilIntegrationWorkspace(), awaiting.runId
      );
      assert.deepEqual(graph?.edges.map((edge) => edge.kind),
        ["risk_preference"]);
      assert.equal((await repository.listRebuttalAttempts(
        financialCouncilIntegrationWorkspace(), awaiting.runId
      )).length, 1);
      const first = await fixture.service.getPortfolioRevision(
        financialCouncilIntegrationWorkspace(), awaiting.runId, 1
      );
      const balanced = first.portfolios.find((row) =>
        row.kind === "balanced")!;
      const revised = await fixture.service.revisePortfolio(
        financialCouncilIntegrationCommand("mysql-revise", awaiting.revision),
        {
          runId: awaiting.runId, baseRevision: 1,
          operations: Object.freeze([Object.freeze({
            kind: "remove_action" as const,
            actionId: balanced.actionIds[0]!
          })])
        }
      );
      await fixture.service.approve(
        financialCouncilIntegrationCommand("mysql-approve", awaiting.revision),
        { runId: awaiting.runId, portfolioRevision: revised.value.revision,
          portfolioKind: "balanced" }
      );

      await fixture.dispatch.close();
      const restartedRepository = new MysqlFinancialCouncilRepository(pool);
      const restartedDispatch = createFinancialCouncilDispatchRuntime({
        repository: restartedRepository,
        drafts: new MysqlFinancialCouncilDraftRepository(pool),
        workerId: "financial-council-mysql-restart",
        now: () => "2026-08-16T08:10:00.000Z",
        leaseTokenFactory: () => "4".repeat(64)
      });
      try {
        await restartedDispatch.sweep();
      } finally {
        await restartedDispatch.close();
      }
      const dispatches = await fixture.service.listDispatches(
        financialCouncilIntegrationWorkspace(), awaiting.runId
      );
      assert.equal(dispatches.length > 0, true);
      assert.equal(dispatches.every((row) => row.status === "succeeded"
        && row.receiptId !== null), true);
      assert.equal(fixture.authorityReadHash(), authorityBefore);
      console.log(
        `MYSQL_INTEGRATION_EXECUTED:financial-council:${databaseName}`
      );
    } finally {
      await fixture.close();
    }
  });
});
