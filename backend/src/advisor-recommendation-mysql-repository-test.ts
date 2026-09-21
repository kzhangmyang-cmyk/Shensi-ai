import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVISOR_RECOMMENDATION_MYSQL_SCHEMA_STATEMENTS
} from "./advisor-recommendation-mysql-repository.js";

test("advisor MySQL schema is idempotent DDL with generation uniqueness", () => {
  const ddl = ADVISOR_RECOMMENDATION_MYSQL_SCHEMA_STATEMENTS.join("\n");
  assert.match(ddl, /uk_advisor_generation/u);
  assert.match(ddl, /advisor_recommendation_events/u);
  assert.match(ddl, /aggregate_snapshot_json/u);
  assert.match(ddl, /PRIMARY KEY \(workspace_id, recommendation_id, event_revision\)/u);
});
