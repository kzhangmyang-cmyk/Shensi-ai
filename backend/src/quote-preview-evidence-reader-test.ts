import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalFixture,
  workspaceContextFixture
} from "./growth-quote-test-fixtures.js";

test("preview evidence verifies exact immutable identity and cutoff", async () => {
  const state = approvalFixture();
  const context = workspaceContextFixture("manager");
  const input = {
    quoteCaseId: state.formalVersion.quoteCaseId,
    previewIdentity: state.formalVersion.previewIdentity,
    inputSnapshotHash: state.formalVersion.inputSnapshotHash,
    calculationHash: state.formalVersion.calculationHash
  };
  const visible = await state.cutoff("2026-08-10T00:00:00.000Z");
  const evidence = await state.previewReader.verifyAt(context, input, visible);
  assert.equal(evidence?.quoteCaseId, state.formalVersion.quoteCaseId);
  assert.equal(evidence?.salesOwnerActorId, "sales-a");
  assert.deepEqual(evidence?.subjectEvidence, {
    candidateId: "candidate-1",
    customerId: "customer-1",
    dealId: "deal-1"
  });
  assert.equal(Object.isFrozen(evidence), true);

  assert.equal(await state.previewReader.verifyAt(context, {
    ...input,
    calculationHash: `sha256:${"f".repeat(64)}`
  }, visible), null);
});
