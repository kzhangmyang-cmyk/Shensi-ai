import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { renderDouyinAutomationView } from "./douyin-automation-view";

const { document } = parseHTML("<main id='host'></main>");
const host = document.querySelector<HTMLElement>("#host")!;
renderDouyinAutomationView(host, {
  phase: "ready", planId: "plan-1", account: null, loginSession: null,
  policy: null, runIntent: null, crawlerStatus: null, candidates: [],
  selectedCandidateIds: [], error: null, closed: false
});
assert.match(host.textContent ?? "", /连接抖音账号/u);
assert.match(host.textContent ?? "", /每日候选人/u);
assert.doesNotMatch(host.innerHTML, /cookie|accountHandle|browserProfile/iu);
console.log(JSON.stringify({ ok: true, suite: "douyin-automation-view" }));
