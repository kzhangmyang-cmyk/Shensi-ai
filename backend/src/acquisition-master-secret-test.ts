import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAcquisitionMasterSecret
} from "./acquisition-master-secret.js";

const DEDICATED =
  "dedicated-acquisition-master-secret-at-least-32-bytes";
const JWT = "jwt-secret-at-least-32-bytes-for-development-only";

test("production requires an independent acquisition master secret", () => {
  assert.throws(
    () => resolveAcquisitionMasterSecret({
      nodeEnv: "production",
      acquisitionMasterSecret: "",
      jwtSecret: JWT
    }),
    /ACQUISITION_MASTER_SECRET/u
  );
  assert.equal(
    resolveAcquisitionMasterSecret({
      nodeEnv: "production",
      acquisitionMasterSecret: DEDICATED,
      jwtSecret: JWT
    }),
    DEDICATED
  );
});

test("development and test may explicitly fall back to JWT secret", () => {
  assert.equal(
    resolveAcquisitionMasterSecret({
      nodeEnv: "development",
      acquisitionMasterSecret: "",
      jwtSecret: JWT
    }),
    JWT
  );
  assert.equal(
    resolveAcquisitionMasterSecret({
      nodeEnv: "test",
      acquisitionMasterSecret: "",
      jwtSecret: JWT
    }),
    JWT
  );
});

test("all environments reject weak or whitespace-only secrets", () => {
  for (const nodeEnv of ["production", "development", "test"]) {
    assert.throws(
      () => resolveAcquisitionMasterSecret({
        nodeEnv,
        acquisitionMasterSecret: " ".repeat(64),
        jwtSecret: "short"
      }),
      /ACQUISITION_MASTER_SECRET|32/u
    );
  }
});
