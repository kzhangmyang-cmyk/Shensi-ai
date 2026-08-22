import assert from "node:assert/strict";
import test from "node:test";
import {
  FinancialCouncilSourceVerifier
} from "./financial-council-source-verifier.js";
import {
  financialCouncilCanonicalHash,
  type FinancialCouncilRun
} from "./financial-council-domain.js";
import type {
  FinancialCouncilAuthoritySnapshot,
  FinancialCouncilVerifiedFactView
} from "./financial-council-authority-reader.js";
import type { FinancialSnapshot } from "./financial-council-snapshot.js";
import {
  builderSnapshotFixture,
  repositoryRunFixture,
  workspace
} from "./financial-council-repository-contract-test.js";

const NOW = "2026-08-16T10:00:00.000Z";
const SHA = (character: string) =>
  `sha256:${character.repeat(64)}` as `sha256:${string}`;

function verifiedFact(overrides: Partial<FinancialCouncilVerifiedFactView> = {}):
FinancialCouncilVerifiedFactView {
  return Object.freeze({
    entryId: "fact-1",
    sourceVersion: 1,
    factType: "payment_received",
    currency: "CNY",
    businessOccurredAt: "2026-08-15T06:00:00.000Z",
    entryRecordedAt: "2026-08-15T07:00:00.000Z",
    verificationRevision: 2,
    verificationRecordedAt: "2026-08-15T08:00:00.000Z",
    snapshotHash: SHA("a"),
    amountVisibility: "redacted",
    ...overrides
  });
}

function currentAuthority(
  snapshot: FinancialSnapshot,
  fact: FinancialCouncilVerifiedFactView
): FinancialCouncilAuthoritySnapshot {
  const projection = {
    ...snapshot.authority,
    dataAsOf: NOW,
    verifiedFinancialFacts: Object.freeze([fact])
  };
  const { sourceSnapshotHash: _oldHash, ...preimage } = projection;
  return Object.freeze({
    ...preimage,
    sourceSnapshotHash: financialCouncilCanonicalHash(preimage)
  });
}

test("a changed verified-fact source version and hash makes the snapshot stale",
async () => {
  const run = repositoryRunFixture({
    workspaceId: "ws-1",
    status: "snapshot_frozen",
    revision: 2
  }) as FinancialCouncilRun;
  const record = await builderSnapshotFixture(run, [verifiedFact()]);
  const snapshot = record.snapshot as unknown as FinancialSnapshot;
  const verifier = new FinancialCouncilSourceVerifier({
    cutoffIssuer: {
      async sealTodayCutoff(context, effectiveAsOf) {
        return Object.freeze({
          workspaceId: context.workspaceId,
          effectiveAsOf,
          temporalSequence: 7
        }) as never;
      }
    },
    authority: {
      async readAt() {
        return currentAuthority(snapshot, verifiedFact({
          sourceVersion: 2,
          snapshotHash: SHA("b")
        }));
      }
    },
    workspaceResolver: {
      async resolve(scope) {
        return Object.freeze({
          workspaceId: "ws-1",
          kind: "team",
          bindingRevision: "binding-2",
          ownerId: scope.ownerId,
          teamId: scope.teamId
        }) as never;
      }
    },
    now: () => NOW
  });

  await assert.rejects(
    verifier.verifyCurrentSources(workspace("ws-1"), snapshot, {
      workspaceId: "ws-1",
      ownerId: "manager-1",
      teamId: "ws-1"
    }),
    (error: unknown) => (error as { code?: unknown }).code
      === "financial_council_source_stale"
  );
});

test("a changed current owner/team/workspace binding fails closed", async () => {
  const run = repositoryRunFixture({
    workspaceId: "ws-1", status: "snapshot_frozen", revision: 2
  }) as FinancialCouncilRun;
  const record = await builderSnapshotFixture(run, [verifiedFact()]);
  const snapshot = record.snapshot as unknown as FinancialSnapshot;
  let authorityReads = 0;
  const verifier = new FinancialCouncilSourceVerifier({
    cutoffIssuer: {
      async sealTodayCutoff() { throw new Error("must_not_reach_cutoff"); }
    },
    authority: {
      async readAt() { authorityReads += 1; return snapshot.authority; }
    },
    workspaceResolver: {
      async resolve() {
        return Object.freeze({
          workspaceId: "ws-2",
          kind: "team",
          bindingRevision: "binding-3",
          ownerId: "manager-1",
          teamId: "ws-2"
        }) as never;
      }
    },
    now: () => NOW
  });

  await assert.rejects(verifier.verifyCurrentSources(
    workspace("ws-1"), snapshot, {
      workspaceId: "ws-1", ownerId: "manager-1", teamId: "ws-1"
    }
  ), (error: unknown) => (error as { code?: unknown }).code
      === "financial_council_workspace_stale");
  assert.equal(authorityReads, 0);
});
