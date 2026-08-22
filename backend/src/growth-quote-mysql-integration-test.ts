import assert from "node:assert/strict";
import test from "node:test";
import { MysqlGrowthTemporalTransaction } from "./growth-temporal-barrier-mysql-repository.js";
import type { QuoteCase } from "./quote-repository.js";
import {
  requireGrowthQuoteMysqlTestAdminUrl,
  withGrowthQuoteMysqlTestDatabase
} from "./growth-quote-mysql-test-support.js";

requireGrowthQuoteMysqlTestAdminUrl();

test("real MySQL Quote gate uses two connections and one temporal authority", async () => {
  await withGrowthQuoteMysqlTestDatabase(async ({ databaseName, pool,
    connectionA, connectionB, barrier, repository }) => {
    assert.notEqual(connectionA.threadId, connectionB.threadId);
    const quoteCase: QuoteCase = {
      id: "mysql-case-1", workspaceId: "mysql-workspace-1",
      candidateId: "candidate-1", customerId: null, dealId: null,
      assignedTo: "sales-1", status: "open", currentDraftVersionId: null,
      revision: 1, commercialBindingSnapshot: null,
      createdAt: "2026-08-11T08:00:00.000Z",
      updatedAt: "2026-08-11T08:00:00.000Z"
    };
    const created = await repository.createCase({
      workspaceId: quoteCase.workspaceId, actorId: "sales-1",
      commandKey: "mysql-case-create-1",
      requestHash: `sha256:${"1".repeat(64)}`,
      expectedRevision: null, quoteCase
    });
    assert.equal(created.quoteCase.id, quoteCase.id);
    await connectionA.beginTransaction();
    const first = await barrier.allocateAppend(
      new MysqlGrowthTemporalTransaction(connectionA),
      quoteCase.workspaceId
    );
    await connectionA.commit();
    await connectionB.beginTransaction();
    const second = await barrier.allocateAppend(
      new MysqlGrowthTemporalTransaction(connectionB),
      quoteCase.workspaceId
    );
    await connectionB.commit();
    assert.ok(second.recordedAt >= first.recordedAt);
    assert.ok(second.temporalSequence > first.temporalSequence);
    const [rows] = await pool.query(
      `SELECT temporal_sequence FROM growth_workspace_temporal_barriers
       WHERE workspace_id = ?`, [quoteCase.workspaceId]
    );
    assert.equal(Number((rows as Array<Record<string, unknown>>)[0]
      ?.temporal_sequence), second.temporalSequence);
    console.log(`MYSQL_INTEGRATION_EXECUTED:growth-quotes:${databaseName}`);
  });
});
