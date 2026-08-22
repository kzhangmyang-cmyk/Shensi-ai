import assert from "node:assert/strict";
import test from "node:test";
import {
  AttributionAllocationService
} from "./acquisition-attribution-allocation.js";
import {
  activeAttributionSetIdAsOf
} from "./acquisition-attribution-allocation-as-of-reader.js";
import type {
  AttributionAllocationLifecycleEvent
} from "./acquisition-attribution-allocation.js";
import {
  allocationFixture
} from "./growth-roi-test-fixtures.js";

test("activation requires complete BPS and supersedes only the prior version", async () => {
  const fixture = allocationFixture();
  const service = new AttributionAllocationService(fixture.dependencies);
  const first = await service.createDraft(fixture.context, {
    sourceType: "cost_entry",
    sourceId: "cost-1",
    items: [
      {
        cohortId: "cohort-a", candidateId: null, planId: null, runId: null,
        allocationBps: 6000, allocationRule: "manual",
        ruleVersion: "manual.v1",
        evidenceRefs: [{
          kind: "ledger_source", ledgerType: "cost",
          ledgerEntryId: "cost-1", evidenceHash: "sha256:voucher-1"
        }],
        targetStableKey: "cohort-a"
      },
      {
        cohortId: "cohort-b", candidateId: null, planId: null, runId: null,
        allocationBps: 4000, allocationRule: "manual",
        ruleVersion: "manual.v1",
        evidenceRefs: [{
          kind: "ledger_source", ledgerType: "cost",
          ledgerEntryId: "cost-1", evidenceHash: "sha256:voucher-1"
        }],
        targetStableKey: "cohort-b"
      }
    ]
  });
  const active = await service.activate(
    { ...fixture.context, expectedRevision: 1 }, first.id
  );
  assert.equal(active.status, "active");
  const incomplete = await service.createDraft(
    fixture.context("incomplete-draft"),
    {
    sourceType: "cost_entry",
    sourceId: "cost-1",
    items: [{
      cohortId: "cohort-a", candidateId: null, planId: null, runId: null,
      allocationBps: 9000, allocationRule: "manual",
      ruleVersion: "manual.v1", evidenceRefs: [],
      targetStableKey: "cohort-a"
    }]
    }
  );
  await assert.rejects(
    () => service.activate(
      {
        ...fixture.context(
          "incomplete-activate",
          `sha256:${"c".repeat(64)}`
        ),
        expectedRevision: 1
      },
      incomplete.id
    ),
    /allocation_bps_incomplete/
  );
  assert.equal(
    (await service.get(fixture.context.workspace, active.id))?.status,
    "active"
  );
});

test("allocation replacement advances one recorded tick and preserves an already-read cutoff", () => {
  const events: AttributionAllocationLifecycleEvent[] = [
    {
      id: "event-1", workspaceId: "workspace-a",
      sourceType: "cost_estimate", sourceId: "estimate-1",
      allocationSetId: "set-v1", eventType: "activated",
      eventSequence: 1, revision: 1,
      effectiveAt: "2026-08-01T00:00:00.000Z",
      supersedesAllocationSetId: null, actorId: "finance-a",
      recordedAt: "2026-08-01T00:00:00.000Z", temporalSequence: 1
    },
    {
      id: "event-z", workspaceId: "workspace-a",
      sourceType: "cost_estimate", sourceId: "estimate-1",
      allocationSetId: "set-v1", eventType: "superseded",
      eventSequence: 2, revision: 2,
      effectiveAt: "2026-08-09T00:00:00.000Z",
      supersedesAllocationSetId: null, actorId: "finance-a",
      recordedAt: "2026-08-09T00:00:00.000Z", temporalSequence: 2
    },
    {
      id: "event-a", workspaceId: "workspace-a",
      sourceType: "cost_estimate", sourceId: "estimate-1",
      allocationSetId: "set-v2", eventType: "activated",
      eventSequence: 3, revision: 3,
      effectiveAt: "2026-08-09T00:00:00.000Z",
      supersedesAllocationSetId: "set-v1", actorId: "finance-a",
      recordedAt: "2026-08-09T00:00:00.001Z", temporalSequence: 3
    }
  ];
  assert.equal(
    activeAttributionSetIdAsOf(events, "2026-08-08T23:59:59.999Z"),
    "set-v1"
  );
  assert.equal(
    activeAttributionSetIdAsOf(events, "2026-08-09T00:00:00.000Z"),
    null
  );
  assert.equal(
    activeAttributionSetIdAsOf(events, "2026-08-09T00:00:00.001Z"),
    "set-v2"
  );
});

test("report, draft, and activation recover after business commit before Foundation completion", async () => {
  const fixture = allocationFixture({
    failFoundationCompletionOncePerMutation: true
  });
  const service = new AttributionAllocationService(fixture.dependencies);
  const reportService = fixture.financialSourceReports();
  await assert.rejects(
    () => reportService.create(
      fixture.context("report-ack-loss"), fixture.reportInput
    ),
    /injected_completion_loss/
  );
  await fixture.expireFoundationLease();
  const report = await reportService.create(
    fixture.context("report-ack-loss"), fixture.reportInput
  );
  await assert.rejects(
    () => service.createDraft(
      fixture.context("draft-ack-loss"),
      fixture.allocationDraft(report.id)
    ),
    /injected_completion_loss/
  );
  await fixture.expireFoundationLease();
  const draft = await service.createDraft(
    fixture.context("draft-ack-loss"),
    fixture.allocationDraft(report.id)
  );
  await assert.rejects(
    () => service.activate(
      { ...fixture.context("activate-ack-loss"), expectedRevision: 1 },
      draft.id
    ),
    /injected_completion_loss/
  );
  await fixture.expireFoundationLease();
  const active = await service.activate(
    { ...fixture.context("activate-ack-loss"), expectedRevision: 1 },
    draft.id
  );
  assert.equal(active.id, draft.id);
  assert.deepEqual(await fixture.domainCommandRowCounts(), {
    reports: 1,
    drafts: 1,
    activations: 1
  });
});

test("allocation replay reauthorizes and one key cannot cross resource IDs", async () => {
  const fixture = allocationFixture();
  const service = new AttributionAllocationService(fixture.dependencies);
  const [a, b] = await fixture.twoCompleteDrafts(service);
  await service.activate(
    { ...fixture.context("shared-key"), expectedRevision: 1 }, a.id
  );
  fixture.revoke("ledger.verify");
  await assert.rejects(
    () => service.activate(
      { ...fixture.context("shared-key"), expectedRevision: 1 }, a.id
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "capability_forbidden"
  );
  fixture.restore("ledger.verify");
  await assert.rejects(
    () => service.activate(
      {
        ...fixture.context(
          "shared-key",
          `sha256:${"d".repeat(64)}`
        ),
        expectedRevision: 1
      },
      b.id
    ),
    /idempotency_conflict/
  );
  assert.equal(await fixture.activationCount(b.id), 0);
});
