import assert from "node:assert/strict";
import test from "node:test";

import { runAcquisitionMysqlRestartProof } from "./acquisition-mysql-restart-proof.js";

const adminUrl = process.env.MYSQL_TEST_ADMIN_URL?.trim();
if (!adminUrl) {
  throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED");
}

test("two physical MySQL connections preserve acquisition identities, serialize a lease race, and roll back atomically", async () => {
  const result = await runAcquisitionMysqlRestartProof(adminUrl);
  assert.deepEqual(result.families, [
    "account", "policy", "job_cursor", "candidate_evidence", "batch_action"
  ]);
  assert.equal(result.restartRecovered, true);
  assert.equal(result.raceHadSingleWinner, true);
  assert.equal(result.rollbackWasAtomic, true);
});
