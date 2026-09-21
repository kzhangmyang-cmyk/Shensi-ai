import assert from "node:assert/strict";
import test from "node:test";
import {
  withGrowthAdvisorMysqlTestDatabase
} from "./growth-advisor-mysql-test-support.js";
import {
  MysqlGrowthTemporalBarrier,
  MysqlGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier-mysql-repository.js";
import {
  MysqlAdvisorCandidateAuthorityRepository
} from "./growth-advisor-candidate-authority-mysql-repository.js";
import {
  MysqlAdvisorActionOperationRepository
} from "./advisor-action-operation-mysql-repository.js";

const authorityInput = {
  workspaceId: "ws-1",
  workspaceBindingRevision: "membership-7",
  candidateId: "candidate-1",
  ownerId: "owner-1",
  teamId: "team-1",
  qualificationDecisionId: "qualification-1",
  qualificationDecisionVersion: "qualification-v1",
  qualificationSnapshotHash: `sha256:${"a".repeat(64)}`,
  financialValueDecisionId: "financial-value-1",
  financialValueDecisionVersion: "financial-value-v1",
  financialValueInputSnapshotHash: `sha256:${"b".repeat(64)}`,
  grade: "A",
  score: 80,
  evidence: Object.freeze([{
    evidenceId: "evidence-1",
    contentHash: `sha256:${"c".repeat(64)}`,
    fetchedAt: "2026-08-09T07:00:00.000Z"
  }])
};

test("growth advisor MySQL suite requires a real MYSQL_TEST_ADMIN_URL", async () => {
  if (process.env.MYSQL_TEST_ADMIN_URL?.trim()) {
    await withGrowthAdvisorMysqlTestDatabase(async ({
      pool,
      connectionA,
      connectionB
    }) => {
      const barrier = new MysqlGrowthTemporalBarrier(
        new MysqlGrowthTemporalTransactionRunner(pool)
      );
      const authority = new MysqlAdvisorCandidateAuthorityRepository(
        pool, barrier
      );
      const first = await authority.append(authorityInput);
      const second = await authority.append(authorityInput);
      assert.equal(first.eventSequence, 1);
      assert.equal(second.eventSequence, 2);
      assert.ok(second.temporalSequence > first.temporalSequence);

      const actions = new MysqlAdvisorActionOperationRepository(pool, barrier);
      const operation = await actions.enqueue({
        workspace: {
          workspaceId: "ws-1",
          kind: "team",
          actorId: "manager-1",
          role: "manager",
          teamId: "ws-1",
          capabilities: Object.freeze([]),
          capabilityRegistryVersion: "growth-capabilities.v1"
        },
        actorId: "manager-1",
        idempotencyKey: "enqueue-1",
        requestHash: `sha256:${"d".repeat(64)}`,
        expectedRevision: 2
      }, {
        recommendationId: "recommendation-1",
        recommendationRevision: 2,
        requestingActorId: "manager-1",
        stableActionHash: `sha256:${"e".repeat(64)}`,
        frozenAction: {
          kind: "create_sales_todo",
          customerId: "customer-1",
          dueAt: "2026-08-10T08:00:00.000Z"
        }
      });
      const claim = await actions.claim(operation.id, {
        leaseOwner: "worker-a",
        leaseDurationMs: 1_000,
        now: "2026-08-09T08:00:00.000Z"
      });
      assert.ok(claim);
      await assert.rejects(
        actions.complete(claim, {
          id: "receipt-stale",
          operationId: operation.id,
          workspaceId: "ws-1",
          recommendationId: "recommendation-1",
          recommendationRevision: 2,
          stableActionHash: `sha256:${"e".repeat(64)}`,
          actionKind: "create_sales_todo",
          resourceRefs: Object.freeze([]),
          contentHash: `sha256:${"f".repeat(64)}`,
          createdAt: "2026-08-09T08:00:00.000Z"
        }, "2026-08-09T08:00:01.001Z"),
        (error: unknown) =>
          (error as { code?: string }).code === "stale_advisor_action_fence"
      );
    });
    process.stdout.write(
      "GROWTH_REAL_MYSQL advisor connections=2 tests=5\n"
    );
    return;
  }
  await assert.rejects(
    withGrowthAdvisorMysqlTestDatabase(async () => {
      throw new Error("must not run without a database");
    }),
    /MYSQL_TEST_ADMIN_URL_REQUIRED:growth-advisor/u
  );
});
