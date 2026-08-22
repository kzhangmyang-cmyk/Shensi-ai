import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVISOR_CANDIDATE_AUTHORITY_MYSQL_SCHEMA_STATEMENTS
} from "./growth-advisor-candidate-authority-mysql-repository.js";

test("advisor candidate authority MySQL schema is idempotent DDL with per-candidate sequence", () => {
  const ddl = ADVISOR_CANDIDATE_AUTHORITY_MYSQL_SCHEMA_STATEMENTS.join("\n");
  assert.match(ddl, /advisor_candidate_authority_events/u);
  assert.match(
    ddl,
    /PRIMARY KEY \(workspace_id, candidate_id, event_sequence\)/u
  );
  assert.match(ddl, /chk_advisor_authority_workspace/u);
  assert.match(ddl, /chk_advisor_authority_team/u);
  assert.match(ddl, /evidence_json JSON NOT NULL/u);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS/u);
});
