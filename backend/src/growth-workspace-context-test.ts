import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "express";
import {
  assertGrowthAcquisitionWorkspaceResolver,
  assertResolvedAcquisitionWorkspace,
  createGrowthAcquisitionWorkspaceResolver,
  createGrowthWorkspaceMiddleware,
  resolveActiveWorkspace,
  type ResolvedAcquisitionWorkspace
} from "./growth-workspace-context.js";
import type { SessionUser } from "./types.js";
import {
  requireExpectedRevision,
  type CommandContext
} from "./growth-command-context.js";

const baseUser: SessionUser = {
  id: "user-1",
  name: "销售",
  email: "sales@example.com",
  role: "sales",
  teamId: "team-a",
  avatar: "S",
  authVersion: 1
};

test("super admin all requires an authorized concrete workspace", async () => {
  const user = { ...baseUser, role: "super_admin" as const, teamId: "all" };
  const calls: string[] = [];
  const directory = {
    async canAccess(_user: SessionUser, workspaceId: string) {
      calls.push(workspaceId);
      return workspaceId === "team-b";
    }
  };
  assert.equal(await resolveActiveWorkspace(user, null, directory), null);
  assert.equal(await resolveActiveWorkspace(user, "all", directory), null);
  const selected = await resolveActiveWorkspace(user, "team-b", directory);
  assert.equal(selected?.workspaceId, "team-b");
  assert.equal(selected?.kind, "team");
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(await resolveActiveWorkspace(user, "team-c", directory), null);
  assert.deepEqual(calls, ["team-b", "team-c"]);
});

test("ordinary users default to their team and may select only their personal workspace", async () => {
  const directory = { async canAccess() { return false; } };
  assert.equal(
    (await resolveActiveWorkspace(baseUser, null, directory))?.workspaceId,
    "team-a"
  );
  assert.equal(
    (await resolveActiveWorkspace(baseUser, "personal:user-1", directory))?.kind,
    "personal"
  );
  assert.equal(await resolveActiveWorkspace(baseUser, "personal:user-2", directory), null);
  assert.equal(await resolveActiveWorkspace(baseUser, "team-b", directory), null);
});

test("another user's personal workspace is rejected before directory access", async () => {
  const calls: string[] = [];
  const directory = {
    async canAccess(_user: SessionUser, workspaceId: string) {
      calls.push(workspaceId);
      return workspaceId === "personal:user-2";
    }
  };

  assert.equal(
    await resolveActiveWorkspace(baseUser, "personal:user-2", directory),
    null
  );
  assert.deepEqual(calls, []);

  const superAdmin = {
    ...baseUser,
    role: "super_admin" as const,
    teamId: "all"
  };
  assert.equal(
    (await resolveActiveWorkspace(superAdmin, "team-b", {
      async canAccess(_user, workspaceId) {
        return workspaceId === "team-b";
      }
    }))?.workspaceId,
    "team-b"
  );
});

test("middleware reads only X-Workspace-Id and preserves authenticated authority", async () => {
  const seen: string[] = [];
  const headers: Record<string, string> = {
    "x-workspace-id": "team-b",
    "workspace-id": "attacker-workspace"
  };
  const middleware = createGrowthWorkspaceMiddleware({
    async canAccess(user, workspaceId) {
      seen.push(`${user.id}:${workspaceId}`);
      return workspaceId === "team-b";
    }
  });
  const req = {
    user: { ...baseUser, role: "admin" as const },
    headers,
    header(name: string) {
      return headers[name.toLowerCase()];
    }
  } as unknown as Request;
  await new Promise<void>((resolve, reject) => {
    middleware(req, {} as never, (error?: unknown) => error ? reject(error) : resolve());
  });
  assert.equal(req.activeWorkspace?.workspaceId, "team-b");
  assert.equal(req.activeWorkspace?.actorId, "user-1");
  assert.deepEqual(seen, ["user-1:team-b"]);
});

test("trusted acquisition resolution freezes the exact persisted scope and binding", async () => {
  const scopes: Array<Readonly<{ ownerId: string; teamId: string }>> = [];
  const resolver = createGrowthAcquisitionWorkspaceResolver({
    async resolve(scope) {
      scopes.push(scope);
      if (scope.ownerId === "owner-1" && scope.teamId === "team-a") {
        return {
          workspaceId: "team-a",
          kind: "team" as const,
          bindingRevision: "binding-7"
        };
      }
      return null;
    }
  });
  const resolved = await resolver.resolve({ ownerId: "owner-1", teamId: "team-a" });
  assert.deepEqual(resolved && {
    workspaceId: resolved.workspaceId,
    kind: resolved.kind,
    bindingRevision: resolved.bindingRevision,
    ownerId: resolved.ownerId,
    teamId: resolved.teamId
  }, {
    workspaceId: "team-a",
    kind: "team",
    bindingRevision: "binding-7",
    ownerId: "owner-1",
    teamId: "team-a"
  });
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(assertResolvedAcquisitionWorkspace(resolved), resolved);
  assert.deepEqual(scopes, [{ ownerId: "owner-1", teamId: "team-a" }]);
});

test("a personal acquisition workspace is accepted only from an explicit exact binding", async () => {
  const resolver = createGrowthAcquisitionWorkspaceResolver({
    async resolve(scope) {
      return scope.ownerId === "owner-1" && scope.teamId === "team-a"
        ? {
            workspaceId: "personal:owner-1",
            kind: "personal" as const,
            bindingRevision: "binding-personal-1"
          }
        : null;
    }
  });
  assert.equal(
    (await resolver.resolve({ ownerId: "owner-1", teamId: "team-a" }))?.workspaceId,
    "personal:owner-1"
  );
  assert.equal(
    await resolver.resolve({ ownerId: "owner-2", teamId: "team-a" }),
    null
  );
});

test("invalid acquisition scopes and directory responses fail closed", async () => {
  let calls = 0;
  const resolver = createGrowthAcquisitionWorkspaceResolver({
    async resolve() {
      calls += 1;
      return { workspaceId: "all", kind: "team", bindingRevision: "binding-1" };
    }
  });
  assert.equal(await resolver.resolve({ ownerId: "owner-1", teamId: "all" }), null);
  assert.equal(await resolver.resolve({ ownerId: " ", teamId: "team-a" }), null);
  assert.equal(calls, 0);
  assert.equal(await resolver.resolve({ ownerId: "owner-1", teamId: "team-a" }), null);
  assert.equal(calls, 1);
});

test("fabricated acquisition workspace values do not have runtime provenance", () => {
  const forged = Object.freeze({
    workspaceId: "team-a",
    kind: "team" as const,
    bindingRevision: "binding-1",
    ownerId: "owner-1",
    teamId: "team-a"
  }) as ResolvedAcquisitionWorkspace;
  assert.throws(
    () => assertResolvedAcquisitionWorkspace(forged),
    /invalid_resolved_acquisition_workspace/
  );
});

test("only Foundation-issued acquisition workspace resolvers have provenance", () => {
  const resolver = createGrowthAcquisitionWorkspaceResolver({
    resolve: async () => null
  });
  assert.equal(assertGrowthAcquisitionWorkspaceResolver(resolver), resolver);
  assert.throws(
    () => assertGrowthAcquisitionWorkspaceResolver(Object.freeze({
      resolve: resolver.resolve.bind(resolver)
    })),
    /invalid_growth_acquisition_workspace_resolver/u
  );
});

test("the command context is the sole positive expected revision authority", async () => {
  const activeWorkspace = await resolveActiveWorkspace(
    baseUser,
    null,
    { async canAccess() { return false; } }
  );
  assert.ok(activeWorkspace);
  const command = (expectedRevision: number | null): CommandContext => ({
    workspace: activeWorkspace,
    actorId: activeWorkspace.actorId,
    idempotencyKey: "command-1",
    requestHash: `sha256:${"a".repeat(64)}`,
    expectedRevision
  });
  assert.equal(requireExpectedRevision(command(7)), 7);
  for (const invalid of [null, 0, -1, 1.5]) {
    assert.throws(
      () => requireExpectedRevision(command(invalid)),
      (error: unknown) => (error as { status?: number; code?: string }).status === 428
        && (error as { code?: string }).code === "revision_required"
    );
  }
});
