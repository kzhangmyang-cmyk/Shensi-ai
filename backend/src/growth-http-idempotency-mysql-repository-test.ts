import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GROWTH_HTTP_IDEMPOTENCY_MYSQL_SCHEMA_STATEMENTS,
  MysqlGrowthHttpIdempotencyRepository
} from "./growth-http-idempotency-mysql-repository.js";
import type { GrowthHttpIdempotencyReservationInput } from "./growth-http-idempotency-repository.js";

const input: GrowthHttpIdempotencyReservationInput = { workspaceId: "team-a", actorId: "user-1", method: "POST", canonicalPath: "/api/v1/quotes/cases", key: "case-key-0001", requestHash: `sha256:${"a".repeat(64)}`, attemptedAt: "2026-08-09T08:00:00.000Z", leaseOwner: "request-a", leaseDurationMs: 30_000 };

test("MySQL schema scopes a hashed key and never stores response JSON", () => {
  const schema = GROWTH_HTTP_IDEMPOTENCY_MYSQL_SCHEMA_STATEMENTS.join("\n");
  assert.match(schema, /workspace_id, actor_id, method, canonical_path, idempotency_key_hash/u);
  assert.doesNotMatch(schema, /response_json/u);
});

test("MySQL reservation persists before a caller can execute business work", async () => {
  const queries: string[] = [];
  const connection = {
    beginTransaction: async () => { queries.push("begin"); }, commit: async () => { queries.push("commit"); }, rollback: async () => {}, release: () => {},
    query: async (sql: string) => { queries.push(sql); return sql.includes("SELECT") ? [[{ id: "reservation-1", request_hash: input.requestHash, status: "reserved", lease_owner: "request-a", lease_expires_at: "2026-08-09 07:59:59.000", fencing_token: 1, resource_id: null, operation_id: null }], []] : [{ affectedRows: 1 }, []]; }
  };
  const pool = { getConnection: async () => connection };
  const repository = new MysqlGrowthHttpIdempotencyRepository(pool as never, () => "reservation-1");
  const result = await repository.reserve(input);
  assert.equal(result.kind, "claimed");
  assert.match(queries[1] ?? "", /INSERT INTO growth_http_idempotency/u);
});
