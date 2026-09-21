import { strict as assert } from "node:assert";
import { createSeedDemoState } from "./demo-seed";
import { buildDashboardModel, renderDashboardView } from "./demo-dashboard-view";

const state = createSeedDemoState();
const model = buildDashboardModel(state, new Date("2026-09-07T12:00:00.000Z"));

assert.deepEqual(model.period, {
  start: "2026-06-07",
  end: "2026-09-07",
  compareStart: "2026-03-07",
  compareEnd: "2026-06-06"
});
assert.equal(model.totalConversations, 5);
assert.equal(model.qualifiedConversations, 4);
assert.equal(model.activeOpportunities, 3);
assert.equal(model.pipelineAmount, 376_000);
assert.equal(model.quoteAmount, 245_000);
assert.equal(model.wonAmount, 0);
assert.equal(model.receiptsAvailable, false);
assert.equal(model.funnel[1]?.previousStageRate, 80);
assert.equal(model.funnel[2]?.previousStageRate, 100);
assert.equal(model.channelAmounts.reduce((sum, item) => sum + item.amount, 0), 376_000);

state.tasks[0].title = '<img src=x onerror=alert(1)>';
const main = { innerHTML: "" } as HTMLElement;
const inspector = { innerHTML: "" } as HTMLElement;
renderDashboardView(state, main, inspector, new Date("2026-09-07T12:00:00.000Z"));
assert.match(main.innerHTML, /2026-06-07\s*~\s*2026-09-07/u);
assert.match(main.innerHTML, /本地演示数据/u);
assert.match(main.innerHTML, /回款数据未接入/u);
assert.match(main.innerHTML, /较上一阶段/u);
assert.match(main.innerHTML, /data-demo-action="open-module"/u);
assert.equal(main.innerHTML.includes('<img src=x onerror=alert(1)>'), false);
assert.doesNotMatch(main.innerHTML, /收入趋势|回款趋势/u);
assert.match(inspector.innerHTML, /经营异常/u);
