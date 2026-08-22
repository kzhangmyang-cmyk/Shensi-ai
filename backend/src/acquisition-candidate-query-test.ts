import assert from "node:assert/strict";
import type {
  AcquisitionCandidate
} from "./acquisition-domain.js";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";

const scope = { ownerId: "owner-a", teamId: "team-a" };

function candidate(input: {
  id: string;
  subject: "organization" | "individual";
  status: AcquisitionCandidate["status"];
  updatedAt: string;
  ownerId?: string;
  teamId?: string;
}): AcquisitionCandidate {
  const base = {
    id: input.id,
    ownerId: input.ownerId ?? scope.ownerId,
    teamId: input.teamId ?? scope.teamId,
    evidenceIds: [`evidence-${input.id}`],
    status: input.status,
    latestDecisionId: null,
    latestDecisionVersion: null,
    approvedDecisionVersion: null,
    hardGateFailures: [],
    leadId: null,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: input.updatedAt,
    version: 1
  };
  if (input.subject === "organization") {
    return {
      ...base,
      partyType: "organization",
      partyRef: {
        partyType: "organization",
        organizationId: `org-${input.id}`,
        tenantProspectId: `prospect-${input.id}`
      },
      profile: {
        kind: "organization",
        name: input.id,
        domain: null,
        region: "中国",
        creditCode: null
      }
    };
  }
  return {
    ...base,
    partyType: "individual",
    partyRef: {
      partyType: "individual",
      individualPartyId: `party-${input.id}`,
      demandSignalId: `signal-${input.id}`
    },
    profile: {
      kind: "individual",
      publicActorKey: `actor-${input.id}`,
      publicDisplayName: input.id,
      publicProfileUrl: `https://example.cn/${input.id}`,
      sourcePlatform: "baidu_ai_search",
      demandCategory: "公开采购",
      demandSummary: "公开表达采购需求",
      locationHint: "中国",
      buyingStage: "solution_research",
      negativeSignals: []
    }
  };
}

const repository = new InMemoryAcquisitionDomainRepository();
await repository.insertCandidate(candidate({
  id: "candidate-old",
  subject: "organization",
  status: "normalized",
  updatedAt: "2026-07-23T01:00:00.000Z"
}));
await repository.insertCandidate(candidate({
  id: "candidate-new",
  subject: "organization",
  status: "qualified",
  updatedAt: "2026-07-23T03:00:00.000Z"
}));
await repository.insertCandidate(candidate({
  id: "candidate-middle",
  subject: "individual",
  status: "normalized",
  updatedAt: "2026-07-23T02:00:00.000Z"
}));
await repository.insertCandidate(candidate({
  id: "candidate-cross-tenant",
  subject: "organization",
  status: "normalized",
  updatedAt: "2026-07-23T04:00:00.000Z",
  ownerId: "owner-b"
}));

const first = await repository.listCandidates(scope, {
  limit: 2
});
assert.deepEqual(
  first.items.map((item) => item.id),
  ["candidate-new", "candidate-middle"]
);
assert.equal(first.nextCursor, "2");
assert.match(first.snapshot, /^[a-f0-9]{64}$/);

const second = await repository.listCandidates(scope, {
  limit: 2,
  cursor: first.nextCursor ?? undefined,
  snapshot: first.snapshot
});
assert.deepEqual(
  second.items.map((item) => item.id),
  ["candidate-old"]
);
assert.equal(second.nextCursor, null);
assert.equal(second.snapshot, first.snapshot);

const organizations = await repository.listCandidates(scope, {
  limit: 10,
  subjectKind: "organization",
  status: "normalized"
});
assert.deepEqual(
  organizations.items.map((item) => item.id),
  ["candidate-old"]
);

await repository.saveCandidate({
  ...(await repository.findCandidate(scope, "candidate-old"))!,
  status: "qualified",
  updatedAt: "2026-07-23T05:00:00.000Z",
  version: 2
});
await assert.rejects(
  () => repository.listCandidates(scope, {
    limit: 2,
    cursor: first.nextCursor ?? undefined,
    snapshot: first.snapshot
  }),
  /CANDIDATE_SNAPSHOT_CHANGED/
);

console.log("acquisition candidate query tests passed");
