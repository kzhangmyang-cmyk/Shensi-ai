import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVISOR_ACTION_MYSQL_SCHEMA_STATEMENTS
} from "./advisor-action-operation-mysql-repository.js";

test("advisor action MySQL schema is idempotent DDL with stable-operation uniqueness", () => {
  const ddl = ADVISOR_ACTION_MYSQL_SCHEMA_STATEMENTS.join("\n");
  assert.match(ddl, /advisor_action_operations/u);
  assert.match(ddl, /advisor_action_receipts/u);
  assert.match(
    ddl,
    /UNIQUE KEY uk_advisor_action_operation/u
  );
  assert.match(
    ddl,
    /UNIQUE KEY uk_advisor_action_receipt_operation/u
  );
  assert.match(
    ddl,
    /UNIQUE KEY uk_advisor_action_receipt_hash/u
  );
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS/u);
  assert.match(ddl, /status IN \('queued','running','succeeded','failed'\)/u);
});
