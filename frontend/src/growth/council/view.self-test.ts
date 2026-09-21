import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { financialCouncilFixture } from "../../../tests/fixtures/growth-contract";
import type { FinancialCouncilControllerState } from "./controller";
import { renderFinancialCouncilWorkbench } from "./view";
import type { FinancialCouncilCollaboration } from "../contracts";
import { BUSINESS_AGENT_TEAM } from "../agents/agents";

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
{
  const document = parseHTML(renderFinancialCouncilWorkbench({ ...ready, run: null }, { capabilities: [], canExportPdf: true })).document;
  assert.ok(document.querySelector('[aria-label="报告与导出"]'));
  assert.equal(document.querySelector<HTMLButtonElement>('[data-council-action="download-html"]')?.disabled, true);
  assert.equal(document.querySelector<HTMLButtonElement>('[data-council-action="download-pdf"]')?.disabled, true);
  assert.match(document.textContent ?? document.documentElement.textContent ?? '', /先分析资料/);
}

for (const [status, expected] of [
  ["failed", "本次分析失败，未生成 CFO 诊断"],
  ["not_computable", "资料不足，当前无法生成可计算的 CFO 诊断"],
  ["stale", "资料已变更，本次诊断不再有效"],
  ["expired", "本次分析已失效"],
  ["rejected", "本次分析已被拒绝"]
] as const) {
  const terminalHtml = renderFinancialCouncilWorkbench({ ...ready, run: { ...ready.run!, status, consensusReport: null } }, { capabilities: [] });
  assert.ok(terminalHtml.includes(expected), `truthful CFO state for ${status}`);
  assert.doesNotMatch(terminalHtml, /诊断仍在生成中/);
}

const collaboration: FinancialCouncilCollaboration = {
  runId: ready.run!.runId, workspaceId: ready.run!.workspaceId, revision: ready.run!.revision,
  dataAsOf: ready.run!.dataAsOf, currency: "CNY", statementPackageId: "package-1",
  snapshotId: "snapshot-1", snapshotHash: "sha256:" + "a".repeat(64), policyVersionId: "policy-1",
  executionMode: "sequential", reviewRoundLimit: 1,
  roles: BUSINESS_AGENT_TEAM.map((agent, index) => ({ role: agent.id,
    state: (["waiting", "completed", "running", "missing_data", "failed", "degraded"] as const)[index]!,
    phase: "analysis", updatedAt: null, message: `真实状态 ${agent.id}`, reasonCode: null, findings: [], actions: [] })),
  events: [{ eventId: "event-1", role: "finance", phase: "analysis", state: "completed", occurredAt: ready.run!.dataAsOf,
    message: "公开结论 <script>", reasonCode: null, findingIds: ["finding-1"] }],
  reviews: [{ role: "cost", round: 1, findingId: "finding-1", peerFindingId: "finding-2", state: "upheld", summary: "保留成本异议", occurredAt: ready.run!.dataAsOf }],
  narrative: null, report: { reportId: "report-1", version: "financial-council-report.v1", title: "详细报告", complete: false, generatedAt: ready.run!.dataAsOf, sections: [] }
};
const collaborationHtml = renderFinancialCouncilWorkbench({ ...ready, collaboration }, { capabilities: [] });
assert.match(collaborationHtml, /data-council-role="profit"[^>]*data-role-state="running"/);
assert.match(collaborationHtml, /保留成本异议/);
assert.match(collaborationHtml, /公开结论 &lt;script&gt;/);
assert.match(collaborationHtml, /business-advisor-agents\/cfo.jpg/);
assert.match(collaborationHtml, /report-1/);
const updatingHtml = renderFinancialCouncilWorkbench({ ...ready, run: { ...ready.run!, revision: collaboration.revision + 1 }, collaboration }, { capabilities: [] });
assert.match(updatingHtml, /当前显示修订 .* 的协作记录与报告/);
assert.match(updatingHtml, /report-1/);

const html = renderFinancialCouncilWorkbench(ready, {
  capabilities: ["finance.council.approve"]
});
assert.equal(html.includes("growth-command-strip"), true);
const orderedHeadings = [
  "运行摘要", "六角色进度", "专家结论", "审计与异议", "CFO 诊断与数据缺口",
  "组合比较", "已选组合详情", "编辑并重新优化", ">人工审批</h3>", "派发回执"
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
assert.match(html, /暂不可计算/u);
assert.match(html, /需要人工复核/u);
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
    < blocked.indexOf(">人工审批</h3>"),
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
assert.match(createHtml, /完整报表不会显示在地址栏或页面正文中/u);
assert.match(createHtml, /准备资料/u);
assert.match(createHtml, /专项分析/u);
assert.match(createHtml, /汇总审阅/u);
assert.match(createHtml, /确认建议/u);

const onboardingHtml = renderFinancialCouncilWorkbench({
  ...ready,
  run: null,
  busy: null,
  error: null
}, { capabilities: [], canCreate: false });
assert.match(onboardingHtml, /资产负债表、利润表和现金流量表/u);
assert.match(onboardingHtml, /href="#agents"/u);
const onboardingDocument = parseHTML(onboardingHtml).document;
assert.deepEqual([...onboardingDocument.querySelectorAll('.council-preparation-table [role="row"]')]
  .filter(row => row.querySelector('a'))
  .map(row => [row.querySelector('.council-statement-name')?.textContent,
    row.querySelector('a')?.getAttribute('href')]), [
  ["资产负债表", "#agents"], ["利润表", "#agents"], ["现金流量表", "#agents"]
], "all three preparation links must open the statement-package preparation owner, not the finance ledger");
assert.ok([...onboardingDocument.querySelectorAll('.council-preparation-actions a, .council-review a')]
  .every(link => link.getAttribute('href') === '#agents'),
"surrounding preparation links use the same destination");
assert.equal(onboardingDocument.querySelector('.council-review a')?.classList.contains('growth-primary-link'),
  true, "the preparation action must reuse the existing styled link instead of browser defaults");
assert.match(onboardingHtml, /正式三表专项分析（可选）/u);
assert.match(onboardingHtml, /参与角色/u);
assert.match(onboardingHtml, /本次审阅/u);
assert.match(onboardingHtml, /查看资料要求/u);
assert.match(onboardingHtml, /<details class="council-history"[^>]*>/u);
assert.doesNotMatch(onboardingHtml, /<details class="council-history" open>/u);
assert.doesNotMatch(onboardingHtml, /council-entry-status/u);
assert.match(onboardingHtml, /class="council-step-connector"/u);
