import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceFinancialCouncilToApproval,
  createFinancialCouncilIntegrationFixture,
  financialCouncilIntegrationCommand,
  financialCouncilIntegrationWorkspace
} from "./financial-council-integration-fixtures.js";

test("revision two remains readable through the public service", async () => {
  const fixture = await createFinancialCouncilIntegrationFixture();
  try {
    const awaiting = await advanceFinancialCouncilToApproval(fixture);
    const first = await fixture.service.getPortfolioRevision(
      financialCouncilIntegrationWorkspace(), awaiting.runId, 1
    );
    const selected = first.portfolios.find((row) =>
      row.kind === "balanced")!;
    const revised = await fixture.service.revisePortfolio(
      financialCouncilIntegrationCommand("readable-revise", awaiting.revision),
      {
        runId: awaiting.runId,
        baseRevision: 1,
        operations: Object.freeze([Object.freeze({
          kind: "remove_action" as const,
          actionId: selected.actionIds[0]!
        })])
      }
    );
    await fixture.service.approve(
      financialCouncilIntegrationCommand("readable-approve", awaiting.revision),
      {
        runId: awaiting.runId,
        portfolioRevision: revised.value.revision,
        portfolioKind: "balanced"
      }
    );

    const current = await fixture.service.getRun(
      financialCouncilIntegrationWorkspace(), awaiting.runId
    );
    assert.equal(current.status, "approved");
    assert.equal(current.latestPortfolioRevision, 2);
  } finally {
    await fixture.close();
  }
});

test("approved revision two dispatches only drafts without authority mutation",
  async () => {
    const fixture = await createFinancialCouncilIntegrationFixture();
    try {
      const authorityBefore = fixture.authorityReadHash();
      const awaiting = await advanceFinancialCouncilToApproval(fixture);
      assert.equal(awaiting.status, "awaiting_approval");
      const graph = await fixture.repository.getAuditGraph(
        financialCouncilIntegrationWorkspace(), awaiting.runId
      );
      assert.deepEqual(graph?.edges.map((edge) => edge.kind),
        ["risk_preference"]);
      const rebuttals = await fixture.repository.listRebuttalAttempts(
        financialCouncilIntegrationWorkspace(), awaiting.runId
      );
      assert.equal(rebuttals.length, 1);
      assert.equal(rebuttals[0]!.role, "cashflow");
      const first = await fixture.service.getPortfolioRevision(
        financialCouncilIntegrationWorkspace(), awaiting.runId, 1
      );
      const selected = first.portfolios.find((row) =>
        row.kind === "balanced")!;
      assert.ok(selected.actionIds.length > 1);
      const revised = await fixture.service.revisePortfolio(
        financialCouncilIntegrationCommand("revise", awaiting.revision),
        {
          runId: awaiting.runId,
          baseRevision: 1,
          operations: Object.freeze([Object.freeze({
            kind: "remove_action" as const,
            actionId: selected.actionIds[0]!
          })])
        }
      );
      assert.equal(revised.value.revision, 2);
      const approved = await fixture.service.approve(
        financialCouncilIntegrationCommand("approve", awaiting.revision),
        {
          runId: awaiting.runId,
          portfolioRevision: 2,
          portfolioKind: "balanced"
        }
      );
      assert.equal(approved.value.status, "approved");
      await fixture.dispatch.sweep();
      const dispatches = await fixture.service.listDispatches(
        financialCouncilIntegrationWorkspace(), awaiting.runId
      );
      assert.ok(dispatches.length > 0);
      assert.deepEqual([...new Set(dispatches.map((row) => row.status))],
        ["succeeded"]);
      assert.equal(dispatches.every((row) => row.receiptId !== null), true);
      assert.equal(fixture.authorityReadHash(), authorityBefore);
    } finally {
      await fixture.close();
    }
  });
