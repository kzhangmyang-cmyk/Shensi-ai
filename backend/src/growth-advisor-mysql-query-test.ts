import assert from "node:assert/strict";
import test from "node:test";
import {
  MysqlCandidateDisplayNameSource,
  MysqlCohortBindingVisibilitySource,
  MysqlQuoteBindingVisibilitySource,
  createMysqlAdvisorCandidateReaders,
  createMysqlAdvisorVisibilityResolver
} from "./growth-advisor-mysql-query.js";

test("MySQL advisor query adapters expose the sealed as-of surface without local seals", () => {
  assert.equal(typeof MysqlQuoteBindingVisibilitySource, "function");
  assert.equal(typeof MysqlCohortBindingVisibilitySource, "function");
  assert.equal(typeof MysqlCandidateDisplayNameSource, "function");
  assert.equal(typeof createMysqlAdvisorVisibilityResolver, "function");
  assert.equal(typeof createMysqlAdvisorCandidateReaders, "function");
});

test("MySQL quote binding source reads only formal versions at the sealed cutoff", () => {
  const source = new MysqlQuoteBindingVisibilitySource(
    {} as never
  );
  const sql = source.listVisibleBindings.toString();
  assert.match(sql, /quote_versions/u);
  assert.match(sql, /commercial_binding_snapshots/u);
  assert.match(sql, /version_kind = 'formal'/u);
  assert.match(sql, /recorded_at <= \?/u);
});

test("MySQL cohort visibility and display-name sources are bounded", () => {
  const cohorts = new MysqlCohortBindingVisibilitySource({} as never);
  const names = new MysqlCandidateDisplayNameSource({} as never);
  assert.equal(
    typeof cohorts.listVisibleCohorts,
    "function"
  );
  assert.equal(typeof names.listDisplayNames, "function");
});
