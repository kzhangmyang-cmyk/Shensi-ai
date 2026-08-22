import assert from "node:assert/strict";
import test from "node:test";
import { createGrowthWorkspaceMemberAssignabilityReader } from "./growth-workspace-member-assignability.js";
import { workspaceContextFixture } from "./growth-quote-test-fixtures.js";

test("assignment is resolved only from current trusted same-workspace sales membership", async () => {
  const members = [
    { id: "sales-a", teamId: "team-a", role: "sales" as const, status: "active" as const },
    { id: "sales-b", teamId: "team-b", role: "sales" as const, status: "active" as const },
    { id: "manager-b", teamId: "team-a", role: "manager" as const, status: "active" as const }
  ];
  const reader = createGrowthWorkspaceMemberAssignabilityReader({ members: () => members });
  assert.equal((await reader.assertAssignable(
    workspaceContextFixture("sales", undefined, "sales-a"), "sales-a"
  )).actorId, "sales-a");
  await assert.rejects(
    reader.assertAssignable(workspaceContextFixture("sales", undefined, "sales-a"), "sales-b"),
    (error: unknown) => (error as { code?: string }).code === "quote_assignee_forbidden"
  );
  await assert.rejects(
    reader.assertAssignable(workspaceContextFixture("manager", undefined, "manager-a"), "sales-b"),
    (error: unknown) => (error as { code?: string }).code === "quote_assignee_invalid"
  );
  await assert.rejects(
    reader.assertAssignable(workspaceContextFixture("manager", undefined, "manager-a"), "manager-b"),
    (error: unknown) => (error as { code?: string }).code === "quote_assignee_invalid"
  );
});

test("manager and admin may assign eligible sales while every other membership state fails closed", async () => {
  const members = [
    { id: "eligible", teamId: "team-a", role: "sales" as const, status: "active" as const },
    { id: "inactive", teamId: "team-a", role: "sales" as const, status: "disabled" as const },
    { id: "manager", teamId: "team-a", role: "manager" as const, status: "active" as const }
  ];
  const reader = createGrowthWorkspaceMemberAssignabilityReader({ members: () => members });
  for (const role of ["manager", "admin"] as const) {
    assert.equal((await reader.assertAssignable(
      workspaceContextFixture(role), "eligible"
    )).actorId, "eligible");
  }
  for (const actorId of ["inactive", "manager", "missing"]) {
    await assert.rejects(
      reader.assertAssignable(workspaceContextFixture("manager"), actorId),
      (error: unknown) => (error as { code?: string }).code
        === "quote_assignee_invalid"
    );
  }
  await assert.rejects(
    reader.assertAssignable(workspaceContextFixture("super_admin"), "eligible"),
    (error: unknown) => (error as { code?: string }).code
      === "quote_assignee_forbidden"
  );
});
