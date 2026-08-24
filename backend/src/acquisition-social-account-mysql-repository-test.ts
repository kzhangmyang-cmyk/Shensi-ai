import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";
import { MysqlAcquisitionSocialAccountRepository } from "./acquisition-social-account-mysql-repository.js";

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

test("MySQL bind uses a transaction and rolls back a competing active handle", async () => {
  const calls: string[] = [];
  const connection = {
    async beginTransaction() { calls.push("begin"); }, async commit() { calls.push("commit"); }, async rollback() { calls.push("rollback"); }, release() { calls.push("release"); },
    async execute(sql: string) { calls.push(sql.startsWith("SELECT") ? "select" : "write"); return [[{ id: "a", workspace_id: "w", platform: "douyin", account_handle: "other", display_name: null, state: "active", login_state_version: 1, revision: 1, etag: '"account-v1"', last_validated_at: null, created_at: "x", updated_at: "x" }], []] as never; }
  };
  const repository = new MysqlAcquisitionSocialAccountRepository({ getConnection: async () => connection } as never);
  const result = await repository.bindActive({ id: "a", workspaceId: "w", platform: "douyin", accountHandle: "new", displayName: null, state: "active", loginStateVersion: 1, revision: 2, etag: '"account-v2"', lastValidatedAt: null, createdAt: "x", updatedAt: "x" });
  assert.equal(result, "active_handle_conflict");
  assert.deepEqual(calls, ["begin", "select", "rollback", "release"]);
});
