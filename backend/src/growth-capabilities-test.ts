import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GROWTH_CAPABILITIES,
  GROWTH_CAPABILITY_REGISTRY_VERSION,
  capabilitiesForHumanRole,
  requireGrowthCapabilities
} from "./growth-capabilities.js";

test("human grants are closed and never include the reconciler identity", () => {
  assert.equal(GROWTH_CAPABILITY_REGISTRY_VERSION, "growth-capabilities.v1");
  assert.deepEqual(capabilitiesForHumanRole("sales"), [
    "catalog.read",
    "quote.draft.create"
  ]);
  assert.equal(capabilitiesForHumanRole("manager").includes(
    "finance.council.run"
  ), false);
  assert.equal(capabilitiesForHumanRole("admin").includes(
    "finance.council.run"
  ), true);
  assert.equal(capabilitiesForHumanRole("admin").includes(
    "finance.council.approve"
  ), true);
  assert.equal(capabilitiesForHumanRole("admin").includes(
    "finance.council.policy.manage"
  ), true);
  assert.equal(capabilitiesForHumanRole("super_admin").includes(
    "finance.council.run"
  ), true);
  assert.equal(capabilitiesForHumanRole("manager").includes(
    "finance.council.approve"
  ), false);
  for (const role of ["sales", "manager", "admin", "super_admin"] as const) {
    const grants = capabilitiesForHumanRole(role);
    assert.equal(
      grants.includes("acquisition.outcome.reconcile.internal"),
      false
    );
    assert.ok(grants.every((grant) => GROWTH_CAPABILITIES.includes(grant)));
    assert.equal(Object.isFrozen(grants), true);
  }
});

test("a missing capability fails closed with the shared authorization code", () => {
  assert.throws(
    () => requireGrowthCapabilities({
      workspaceId: "team-a",
      kind: "team",
      actorId: "user-1",
      role: "sales",
      teamId: "team-a",
      capabilities: capabilitiesForHumanRole("sales"),
      capabilityRegistryVersion: "growth-capabilities.v1"
    }, ["catalog.manage"]),
    (error: unknown) => (error as { code?: string }).code ===
      "capability_forbidden"
  );
});

test("all required capabilities must be granted", () => {
  const context = {
    workspaceId: "team-a",
    kind: "team" as const,
    actorId: "manager-1",
    role: "manager" as const,
    teamId: "team-a",
    capabilities: capabilitiesForHumanRole("manager"),
    capabilityRegistryVersion: "growth-capabilities.v1"
  };
  assert.doesNotThrow(() => requireGrowthCapabilities(context, [
    "catalog.read",
    "quote.confirm"
  ]));
  assert.throws(() => requireGrowthCapabilities(context, [
    "catalog.read",
    "catalog.manage"
  ]));
});
