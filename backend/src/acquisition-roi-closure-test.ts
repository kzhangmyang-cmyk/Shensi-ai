import assert from "node:assert/strict";
import test from "node:test";
import {
  RoiClosureService
} from "./acquisition-roi-closure.js";
import {
  completeClosureFixture
} from "./growth-roi-test-fixtures.js";

test("late facts require reopen and never mutate the first snapshot", async () => {
  const fixture = await completeClosureFixture({
    currency: "CNY",
    costMinor: 200,
    revenueMinor: 1000,
    cogsMinor: 200,
    paymentMinor: 1000
  });
  const service = new RoiClosureService(fixture.dependencies);
  const first = await fixture.close(service, {
    ...fixture.context("close-1"),
    expectedRevision: 1
  }, {
    cohortId: fixture.cohortId,
    currency: "CNY",
    asOf: "2026-08-09T00:00:00.000Z",
    attestationIds: fixture.attestationIds
  });
  const before = await service.getVersion(fixture.workspace, first.id);
  await fixture.insertLateVerifiedRefund(100, "2026-08-09T01:00:00.000Z");
  await assert.rejects(
    () => fixture.close(service, {
      ...fixture.context("close-without-reopen"),
      expectedRevision: 2
    }, {
      cohortId: fixture.cohortId,
      currency: "CNY",
      asOf: "2026-08-09T02:00:00.000Z",
      attestationIds: fixture.attestationIds
    }),
    /closure_series_closed/
  );
  const reopened = await service.reopen({
    ...fixture.context("reopen-1"),
    expectedRevision: 2
  }, first.id);
  assert.equal(reopened.status, "open");
  const after = await service.getVersion(fixture.workspace, first.id);
  assert.deepEqual(after?.snapshots, before?.snapshots);
  assert.deepEqual(after?.sliceMembers, before?.sliceMembers);
  assert.deepEqual(after?.entries, before?.entries);
  assert.equal(before?.closure.status, "closed");
  assert.equal(after?.closure.status, "superseded");
});

test("closure freezes three commercial ratios and their verified numerators", async () => {
  const fixture = await completeClosureFixture({
    costMinor: 200,
    contractWonMinor: 1000,
    paymentMinor: 900,
    refundMinor: 100
  });
  const service = new RoiClosureService(fixture.dependencies);
  const closure = await fixture.close(service, {
    ...fixture.context("close-ratios"),
    expectedRevision: 1
  }, {
    cohortId: fixture.cohortId,
    currency: "CNY",
    asOf: "2026-08-09T00:00:00.000Z",
    attestationIds: fixture.attestationIds
  });
  const snapshot = (await service.getVersion(
    fixture.workspace, closure.id
  ))?.snapshots.find((row) => row.sliceKey === "all");
  assert.deepEqual(snapshot?.commercialRatios, {
    verifiedContractWonMinor: 1000,
    allocatedPaymentMinor: 900,
    netCashMinor: 800,
    verifiedAcquisitionCostMinor: 200,
    contractRoas: {
      status: "computed",
      bps: 50_000,
      formulaVersion: "contract-roas.v1"
    },
    cashMultiple: {
      status: "computed",
      bps: 45_000,
      formulaVersion: "cash-multiple.v1"
    },
    collectionRate: {
      status: "computed",
      bps: 9_000,
      formulaVersion: "collection-rate.v1"
    }
  });
});

test("attestation and close recover domain IDs after Foundation completion loss", async () => {
  const fixture = await completeClosureFixture({
    failFoundationCompletionOncePerMutation: true
  });
  const service = new RoiClosureService(fixture.dependencies);
  await assert.rejects(
    () => fixture.createAttestation(
      service, fixture.context("attestation-loss"), fixture.attestationInput
    ),
    /injected_completion_loss/
  );
  await fixture.expireFoundationLease();
  const attestation = await fixture.createAttestation(
    service, fixture.context("attestation-loss"), fixture.attestationInput
  );
  await assert.rejects(
    () => fixture.close(service, {
      ...fixture.context("close-loss"),
      expectedRevision: 1
    }, {
      cohortId: fixture.cohortId,
      currency: "CNY",
      asOf: "2026-08-09T00:00:00.000Z",
      attestationIds: fixture.attestationIds
    }),
    /injected_completion_loss/
  );
  await fixture.expireFoundationLease();
  const closure = await fixture.close(service, {
    ...fixture.context("close-loss"),
    expectedRevision: 1
  }, {
    cohortId: fixture.cohortId,
    currency: "CNY",
    asOf: "2026-08-09T00:00:00.000Z",
    attestationIds: fixture.attestationIds
  });
  assert.equal(closure.status, "closed");
  assert.deepEqual(await fixture.domainCommandRowCounts(), {
    attestations: 1,
    closeOperations: 1,
    closureVersions: 1,
    reopenEvents: 0
  });
});

test("future attestation periods fail before idempotency or domain writes", async () => {
  const fixture = await completeClosureFixture({
    serverNow: "2026-08-09T00:00:00.000Z"
  });
  const service = new RoiClosureService(fixture.dependencies);
  await assert.rejects(
    () => fixture.createAttestation(
      service,
      fixture.context("future-attestation"),
      {
        ...fixture.attestationInput,
        periodFrom: "2026-08-01T00:00:00.000Z",
        periodTo: "2026-08-09T00:00:01.001Z"
      }
    ),
    /invalid_as_of/
  );
  assert.equal(
    await fixture.repository.countAttestations(),
    6
  );
});
