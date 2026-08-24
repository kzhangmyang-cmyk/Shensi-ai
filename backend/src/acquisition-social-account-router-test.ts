import assert from "node:assert/strict";
import test from "node:test";
import { createAcquisitionSocialAccountRouter } from "./acquisition-social-account-router.js";

test("router module exposes the workspace-scoped account router", () => {
  assert.equal(typeof createAcquisitionSocialAccountRouter, "function");
});
