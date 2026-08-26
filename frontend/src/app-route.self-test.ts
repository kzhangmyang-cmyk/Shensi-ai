import { strict as assert } from "node:assert";
import { normalizeAppHash } from "./app-route";
import { demoModuleFromHash } from "./demo/demo-router";

assert.equal(normalizeAppHash(""), "#agents");
assert.equal(normalizeAppHash("#"), "#agents");
assert.equal(normalizeAppHash("#dashboard"), "#dashboard");
assert.equal(demoModuleFromHash("#dashboard", "agents"), "dashboard");
assert.equal(normalizeAppHash("#unknown-old-crm"), "#agents");
assert.equal(normalizeAppHash("#agents"), "#agents");
assert.equal(normalizeAppHash("#growth/agents"), "#agents");
assert.equal(normalizeAppHash("growth/agents"), "#agents");
assert.equal(normalizeAppHash("#acquisition"), "#acquisition");
assert.equal(normalizeAppHash("#growth/agents/profit"), "#agents");
assert.equal(normalizeAppHash("#financial-council"), "#financial-council");
