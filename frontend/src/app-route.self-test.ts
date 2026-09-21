import { strict as assert } from "node:assert";
import { douyinLiveLoginSessionId, normalizeAppHash } from "./app-route";
import { demoModuleFromHash } from "./demo/demo-router";

assert.equal(normalizeAppHash(""), "#home");
assert.equal(normalizeAppHash("#"), "#home");
assert.equal(normalizeAppHash("#home"), "#home");
assert.equal(normalizeAppHash("#dashboard"), "#dashboard");
assert.equal(normalizeAppHash("#enterprise-query"), "#enterprise-query");
assert.equal(demoModuleFromHash("#dashboard", "agents"), "dashboard");
assert.equal(normalizeAppHash("#unknown-old-crm"), "#agents");
assert.equal(normalizeAppHash("#agents"), "#agents");
assert.equal(normalizeAppHash("#growth/agents"), "#agents");
assert.equal(normalizeAppHash("growth/agents"), "#agents");
assert.equal(normalizeAppHash("#acquisition"), "#acquisition");
assert.equal(normalizeAppHash("#conversion"), "#growth/quotes");
assert.equal(normalizeAppHash("#scripts"), "#agents");
assert.equal(normalizeAppHash("#trade-marketing"), "#agents");
assert.equal(
  normalizeAppHash("#douyin-live-login?sessionId=login%2F1"),
  "#douyin-live-login?sessionId=login%2F1"
);
assert.equal(douyinLiveLoginSessionId("#douyin-live-login?sessionId=login%2F1"), "login/1");
assert.equal(douyinLiveLoginSessionId("#douyin-live-login"), null);
assert.equal(douyinLiveLoginSessionId("#acquisition?sessionId=login%2F1"), null);
assert.equal(normalizeAppHash("#growth/agents/profit"), "#agents");
assert.equal(normalizeAppHash("#financial-council"), "#financial-council");
