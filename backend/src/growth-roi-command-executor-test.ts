import assert from "node:assert/strict";
import test from "node:test";
import {
  FoundationRoiCommandExecutor,
  type RoiCommandExecutionIds
} from "./growth-roi-command-executor.js";
import {
  foundationServicesFixture
} from "./growth-finance-test-fixtures.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  canonicalGrowthRequestHash
} from "./growth-http-idempotency-repository.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { hashCanonicalJson } from "./growth-roi-command-executor.js";

interface DomainRow {
  resourceId: string;
  domainCommandHash: `sha256:${string}`;
}

async function roiCommandExecutorFixture(options: {
  failFirstCompletion?: boolean;
  leaseDurationMs?: number;
} = {}) {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T00:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const foundation = foundationServicesFixture({
    temporalTransactions: transactions,
    temporalBarrier: barrier
  });
  const capabilities: string[] = ["roi.close", "ledger.verify"];
  let clock = "2026-08-09T00:00:00.000Z";
  let completionFailures = 0;
  const originalComplete = foundation.httpIdempotency.complete.bind(
    foundation.httpIdempotency
  );
  foundation.httpIdempotency.complete = async (...args) => {
    if (options.failFirstCompletion && completionFailures === 0) {
      completionFailures += 1;
      throw new Error("injected_completion_loss");
    }
    return originalComplete(...args);
  };
  const domainRows: DomainRow[] = [];
  let businessAppendCalls = 0;
  const writesByResource = new Map<string, number>();
  const executor = new FoundationRoiCommandExecutor({
    foundation,
    now: () => clock
  });
  const context = (input: {
    key: string;
    requestHash: string;
    actorId?: string;
  }): CommandContext => Object.freeze({
    workspace: Object.freeze({
      workspaceId: "workspace-a",
      kind: "team",
      actorId: input.actorId ?? "admin-a",
      role: "admin",
      teamId: "workspace-a",
      capabilities: Object.freeze([...capabilities]),
      capabilityRegistryVersion: "growth-capabilities.v1"
    }) as ActiveWorkspaceContext,
    actorId: input.actorId ?? "admin-a",
    idempotencyKey: input.key,
    requestHash: input.requestHash,
    expectedRevision: null
  });
  const authorizeAndProject = async (ids: RoiCommandExecutionIds) => {
    if (!capabilities.includes("roi.close")) {
      throw Object.assign(new Error("capability_forbidden"), {
        code: "capability_forbidden"
      });
    }
    return { id: ids.resourceId ?? "" };
  };
  const insertOrProbe = async (
    domainCommandHash: `sha256:${string}`,
    resourceId = "allocation-set-stable"
  ): Promise<RoiCommandExecutionIds> => {
    const existing = domainRows.find((row) =>
      row.domainCommandHash === domainCommandHash);
    if (existing) {
      return { resourceId: existing.resourceId, operationId: null };
    }
    businessAppendCalls += 1;
    writesByResource.set(
      resourceId, (writesByResource.get(resourceId) ?? 0) + 1
    );
    domainRows.push({
      resourceId: "allocation-set-stable",
      domainCommandHash
    });
    return { resourceId: "allocation-set-stable", operationId: null };
  };
  return {
    executor,
    context,
    authorizeAndProject,
    insertOrProbe,
    domainRows,
    businessAppendCalls: () => businessAppendCalls,
    domainHashFor: (value: unknown) => hashCanonicalJson(value),
    revoke: (capability: string) => {
      const index = capabilities.indexOf(capability);
      if (index >= 0) capabilities.splice(index, 1);
    },
    advancePastLease: () => {
      clock = "2026-08-09T00:01:00.000Z";
      transactions.setDatabaseNow("2026-08-09T00:01:00.000Z");
    },
    async executeResource(
      resourceId: string,
      input: { key: string; capabilities?: string[] }
    ) {
      const requestHash = canonicalGrowthRequestHash({
        resourceId,
        key: input.key
      });
      return executor.execute(
        context({ key: input.key, requestHash }),
        {
          method: "POST",
          canonicalPath: "/api/v1/acquisition/attribution-allocation-sets",
          resourceKind: "attribution_set"
        },
        {
          authorizeAndProject: async (ids) => {
            if (!capabilities.includes("ledger.verify")) {
              throw Object.assign(new Error("capability_forbidden"), {
                code: "capability_forbidden"
              });
            }
            return { id: ids.resourceId ?? "" };
          },
          executeClaimed: (hash) => insertOrProbe(hash, resourceId)
        }
      );
    },
    businessWritesFor: (resourceId: string) =>
      writesByResource.get(resourceId) ?? 0
  };
}

test("business commit followed by lost Foundation completion reuses the domain command probe", async () => {
  const fixture = await roiCommandExecutorFixture({
    failFirstCompletion: true,
    leaseDurationMs: 1_000
  });
  const execute = () => fixture.executor.execute(
    fixture.context({
      key: "draft-1",
      requestHash: `sha256:${"a".repeat(64)}`
    }),
    {
      method: "POST",
      canonicalPath: "/api/v1/acquisition/attribution-allocation-sets",
      resourceKind: "attribution_set"
    },
    {
      authorizeAndProject: (ids) => fixture.authorizeAndProject(ids),
      executeClaimed: (domainCommandHash) =>
        fixture.insertOrProbe(domainCommandHash)
    }
  );
  await assert.rejects(execute(), /injected_completion_loss/);
  await fixture.advancePastLease();
  const replay = await execute();
  assert.equal(replay.id, "allocation-set-stable");
  assert.equal(fixture.domainRows.length, 1);
  assert.equal(fixture.businessAppendCalls(), 1);
});

test("completed replay reauthorizes and a reused key for another path resource conflicts", async () => {
  const fixture = await roiCommandExecutorFixture();
  await fixture.executeResource("allocation-a", {
    key: "activate-shared",
    capabilities: ["ledger.verify"]
  });
  fixture.revoke("ledger.verify");
  await assert.rejects(
    fixture.executeResource("allocation-a", {
      key: "activate-shared",
      capabilities: []
    }),
    /capability_forbidden/
  );
  await assert.rejects(
    fixture.executeResource("allocation-b", {
      key: "activate-shared",
      capabilities: ["ledger.verify"]
    }),
    /idempotency_conflict/
  );
  assert.equal(fixture.businessWritesFor("allocation-b"), 0);
});
