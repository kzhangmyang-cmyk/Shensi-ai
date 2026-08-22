import { strict as assert } from "node:assert";
import { financialCouncilFixture } from "../../../tests/fixtures/growth-contract";
import type { FinancialCouncilControllerState } from "./controller";
import { renderFinancialCouncilWorkbench } from "./view";

const ready: FinancialCouncilControllerState = {
  run: financialCouncilFixture.awaitingApproval,
  events: null,
  policy: null,
  dispatches: null,
  selectedPortfolioKind: "balanced",
  editDraft: null,
  busy: null,
  error: null,
  lastUpdatedAt: "2026-08-16T08:00:01.000Z"
};

const html = renderFinancialCouncilWorkbench(ready, {
  capabilities: ["finance.council.approve"]
});
const orderedHeadings = [
  "运行摘要", "专家结论", "审计与异议", "CFO 诊断与数据缺口",
  "组合比较", "已选组合详情", "编辑并重新优化", "人工审批", "派发回执"
];
let position = -1;
for (const heading of orderedHeadings) {
  const next = html.indexOf(heading);
  assert.ok(next > position, `expected ${heading} in fixed reading order`);
  position = next;
}
assert.match(html, /<fieldset[^>]*>\s*<legend>选择组合<\/legend>/u);
assert.match(html, /type="radio"[^>]*value="balanced"/u);
assert.match(html, /type="radio"[^>]*value="cash_first"/u);
assert.match(html, /type="radio"[^>]*value="growth_first"/u);
assert.match(html, /data-council-action="remove-action"/u);
assert.match(html, /data-council-action="restore-action"/u);
assert.match(html, /data-council-action="replace-action-parameters"/u);
assert.match(html, /data-council-action="revise"/u);
assert.match(html, /data-council-action="approve"/u);
assert.match(html, /data-council-action="reject"/u);
assert.match(html, /税务相关内容须由具备资质的专业人士复核/u);
assert.match(html, /只创建草稿和待办，不执行任何财务动作/u);
assert.doesNotMatch(html, /<script>/u);
assert.doesNotMatch(html, /"businessReport"/u);

const escaped = renderFinancialCouncilWorkbench({
  ...ready,
  run: {
    ...financialCouncilFixture.awaitingApproval,
    consensusReport: {
      ...financialCouncilFixture.awaitingApproval.consensusReport!,
      overallDiagnosis: "<script>must-not-run()</script>"
    }
  }
}, { capabilities: ["finance.council.approve"] });
assert.match(escaped, /&lt;script&gt;must-not-run\(\)&lt;\/script&gt;/u);
assert.doesNotMatch(escaped, /<script>/u);

const blocked = renderFinancialCouncilWorkbench({
  ...ready,
  run: financialCouncilFixture.emptyFeasiblePortfolios,
  selectedPortfolioKind: "balanced"
}, { capabilities: [] });
assert.match(blocked, /没有候选动作能满足最低现金储备约束/u);
assert.match(blocked, /无权批准该组合/u);
assert.match(blocked, /data-council-action="approve"[^>]*disabled/u);
assert.ok(
  blocked.indexOf("没有候选动作能满足最低现金储备约束")
    < blocked.indexOf("人工审批"),
  "cash blocker must remain above approval"
);

const stale = renderFinancialCouncilWorkbench({
  ...ready,
  run: financialCouncilFixture.stale
}, { capabilities: ["finance.council.approve"] });
assert.match(stale, /该运行已过期或数据已失效/u);
assert.match(stale, /data-council-action="approve"[^>]*disabled/u);

const notComputable = renderFinancialCouncilWorkbench({
  ...ready,
  run: financialCouncilFixture.notComputable
}, { capabilities: ["finance.council.approve"] });
assert.match(notComputable, /当前结果不可计算/u);
assert.match(notComputable, /关键财务事实尚未验证/u);
assert.doesNotMatch(notComputable, /详细金额已脱敏/u);

const createHtml = renderFinancialCouncilWorkbench({
  ...ready,
  run: null,
  busy: null,
  error: null
}, { capabilities: ["finance.council.run"], canCreate: true });
assert.match(createHtml, /data-council-action="create"/u);
assert.match(createHtml, /data-council-data-as-of/u);
assert.match(createHtml, /不会在浏览器存储、URL 或页面中展示完整报表/u);
