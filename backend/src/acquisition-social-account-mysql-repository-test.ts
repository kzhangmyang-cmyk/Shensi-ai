import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";

test("repository rejects raw cookie and profile fields and retains a restart-readable safe record", async () => {
  const repository = new InMemoryAcquisitionSocialAccountRepository();
  await assert.rejects(repository.upsert({ id: "a", workspaceId: "w", platform: "douyin", accountHandle: "h", displayName: null,
    state: "active", loginStateVersion: 1, revision: 1, etag: '"account-v1"', lastValidatedAt: null,
    createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z", cookies: "nope" } as never));
  await repository.upsert({ id: "a", workspaceId: "w", platform: "douyin", accountHandle: "h", displayName: null,
    state: "active", loginStateVersion: 1, revision: 1, etag: '"account-v1"', lastValidatedAt: null,
    createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" });
  const stored = await repository.findByWorkspaceAndPlatform("w", "douyin");
  assert.equal(stored?.accountHandle, "h");
  assert.equal((stored as Record<string, unknown>).cookies, undefined);
});
