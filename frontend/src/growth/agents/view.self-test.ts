import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import {
  BUSINESS_AGENT_TEAM,
  businessAgentById
} from "./agents";
import { parseAgentsHash } from "./entry";
import {
  renderAgentDetail,
  renderAgentsOverview,
  renderRealAgentsOverview,
  renderCompanyPicker,
  renderDiagnosisReport
} from "./view";
import type { DiagnosisReport } from "./api";
import { createFinancialCashForecastDraft } from "./cash-forecast-draft";
import {
  activateFinancialCashForecastDraft,
  bindFinancialCashForecastDraft
} from "./entry";

assert.equal(BUSINESS_AGENT_TEAM.length, 6);
assert.equal(businessAgentById("profit")?.name, "利润分析");
assert.equal(
  BUSINESS_AGENT_TEAM.every((agent) =>
    agent.avatarSrc.startsWith("/assets/business-advisor-agents/")
  ),
  true
);
assert.equal(businessAgentById("missing"), null);

assert.deepEqual(parseAgentsHash("#growth/agents"), { view: "overview" });
assert.deepEqual(parseAgentsHash("#growth/agents/profit"), {
  view: "detail",
  agentId: "profit"
});
assert.equal(parseAgentsHash("#growth/advisor"), null);

const overview = renderAgentsOverview();
const overviewDom = parseHTML(overview).document;
assert.equal(overviewDom.querySelectorAll(".agent-card").length, 6);
assert.equal(
  overviewDom.querySelector(".agents-grid")?.getAttribute("aria-label"),
  "完整 6 位经营顾问"
);
assert.equal(overview.includes("AI 经营顾问团队"), true);
assert.equal(overview.includes("利润分析"), true);
assert.equal(overview.includes("data-agent-id=\"cashflow\""), true);
assert.equal(overview.match(/class="agent-avatar-image"/gu)?.length, 6);
assert.equal(overview.includes('alt="AI 经营总管头像"'), true);
assert.equal(overview.includes("生成经营诊断报告"), true);
assert.equal(overview.includes("上传真实报表（xls / xlsx）"), true);
assert.equal(overview.includes("data-statements-file=\"balance\""), true);
assert.equal(overview.includes('data-statements-drop="balance"'), true);
assert.equal(overview.includes('data-statements-file-name="balance"'), true);
assert.equal(overview.includes('data-statements-drop="income"'), true);
assert.equal(overview.includes("data-statements-feedback"), true);
assert.equal(overview.includes('aria-live="polite"'), true);
assert.equal(overview.includes("当前数据源：示例数据"), true);
assert.equal(overview.includes("<script>"), false);

const scoredOverview = renderAgentsOverview({
  sourceLabel: "示例企业经营数据",
  healthScoreBps: 4_600,
  sources: ["资产负债表", "利润表", "现金流量表"]
});
assert.equal(scoredOverview.includes('aria-label="企业健康评分 46 分"'), true);
assert.equal(scoredOverview.includes('class="health-score-ring"'), true);
assert.equal(scoredOverview.includes('class="data-source-badge"'), true);
assert.equal(scoredOverview.includes("资产负债表"), true);

const demoOverview = renderAgentsOverview({
  demo: true,
  showImport: false,
  sourceLabel: "演示数据"
});
assert.equal(demoOverview.includes("演示数据"), true);
assert.equal(demoOverview.includes("data-agents-demo-link=\"profit\""), true);
assert.equal(demoOverview.includes("上传真实报表（xls / xlsx）"), false);
assert.equal(demoOverview.includes("<script>"), false);

const roles = ["cfo", "finance", "profit", "cost", "cashflow", "tax"] as const;
const autoRoute = {
  mode: "auto" as const, primaryConnectionId: null, fallbackConnectionIds: [] as string[],
  preferenceWeightBps: 0
};
const realOverview = renderRealAgentsOverview({
  readiness: {
    capabilities: { canApprove: true, canManageRouting: true, canRun: true },
    data: { status: "not_connected", packageId: null, companyName: null,
      period: null, verifiedAt: null, warningCodes: [] },
    models: { status: "ready", routingPolicyVersionId: "policy-1", roles: roles.map((role) => ({
      role, status: role === "tax" ? "manual_review" : "ready",
      connectionDisplayName: `<${role}>`, provider: "openai", model: "gpt-5"
    })) },
    latestRun: null
  },
  routingPolicy: {
    policyVersionId: "policy-1", revision: 1,
    maxRoleBudgetMinor: 1_000, maxRunBudgetMinor: 6_000,
    requestTimeoutMs: 30_000, createdAt: "2026-08-23T00:00:00.000Z",
    roles: { cfo: autoRoute, finance: autoRoute, profit: autoRoute,
      cost: autoRoute, cashflow: autoRoute, tax: autoRoute }
  },
  routingPreview: roles.map((role) => ({
    role,
    selectedConnection: { connectionId: `${role}-1`, displayName: `${role}主模型`,
      provider: "openai", model: "gpt-5" },
    orderedConnections: [
      { connectionId: `${role}-1`, displayName: `${role}主模型`, provider: "openai", model: "gpt-5" },
      { connectionId: `${role}-2`, displayName: `${role}备用模型`, provider: "deepseek", model: "deepseek-chat" }
    ],
    reasonCodes: ["structured_output_certified"], missingCapabilities: []
  })),
  files: { balance_sheet: null, income_statement: null, cash_flow_statement: null },
  statementPreview: null, statementPackage: null, latestRun: null, runAgents: null,
  consentAccepted: false, busy: null, error: null
});
const realOverviewDom = parseHTML(realOverview).document;
assert.equal(realOverviewDom.querySelectorAll(".real-agent-card").length, 6);
assert.equal(
  realOverviewDom.querySelector(".agents-grid")?.getAttribute("aria-label"),
  "完整 6 位经营顾问"
);
for (const kind of ["balance_sheet", "income_statement", "cash_flow_statement"]) {
  assert.match(realOverview, new RegExp(`data-statements-file="${kind}"`, "u"));
}
assert.match(realOverview, /已选择 0 \/ 3 份必需报表/u);
assert.doesNotMatch(realOverview, /sample-report|示例数据/u);
assert.deepEqual(
  roles.map((role) => realOverview.indexOf(`data-agent-id="${role}"`)).every(
    (position, index, all) => position >= 0 && (index === 0 || position > all[index - 1])
  ),
  true
);
assert.match(realOverview, /需要人工复核/u);
assert.match(realOverview, /备用/u);
assert.match(realOverview, /标准化财务数据会传输给所选第三方模型供应商/u);
assert.match(realOverview, /data-real-consent/u);
assert.match(realOverview, /data-routing-action="open"/u);
assert.match(realOverview, /data-routing-action="save"/u);
assert.doesNotMatch(realOverview, /<tax>/u);
assert.match(realOverview, /&lt;tax&gt;/u);
assert.doesNotMatch(realOverview, /apiKey|prompt|rawWorkbook/u);

const forecastDraft = createFinancialCashForecastDraft();
forecastDraft.setAmount("inflow30", "1000.00");
forecastDraft.setAmount("outflow30", "5000.00");
forecastDraft.setAmount("inflow31To90", "8000.00");
forecastDraft.setAmount("outflow31To90", "3000.00");
forecastDraft.addReceivable({
  customer: "私密客户 A", amount: "10000.00", daysOutstanding: "120"
});
forecastDraft.setAttestation(true);
const deactivateForecast = activateFinancialCashForecastDraft(forecastDraft);
const forecastOverview = renderRealAgentsOverview({
  readiness: null, routingPolicy: null, routingPreview: [],
  files: { balance_sheet: null, income_statement: null, cash_flow_statement: null },
  statementPreview: {
    previewId: "preview-1", status: "preview", companyName: "公司", period: "2026-07",
    currency: "CNY", parserVersion: "financial-statements.v2", sourceFiles: [],
    warningCodes: [], createdAt: "2026-08-23T00:00:00.000Z",
    expiresAt: "2026-08-23T00:30:00.000Z"
  },
  statementPackage: null, latestRun: null, runAgents: null,
  consentAccepted: true, busy: null, error: null
});
assert.match(forecastOverview, /未来 30 天预计流入/u);
assert.match(forecastOverview, /第 31–90 天预计流出/u);
assert.match(forecastOverview, /data-cash-forecast-receivable-add/u);
assert.match(forecastOverview, /当前没有应收账款/u);
assert.match(forecastOverview, /financial-cash-forecast\.v1/u);
assert.match(forecastOverview, /inputmode="decimal"/u);
assert.match(forecastOverview, /inputmode="numeric"/u);
assert.doesNotMatch(forecastOverview, /data-[^=\s]+="[^"]*(?:私密客户 A|10000\.00)/u);
assert.doesNotMatch(forecastOverview, /id="[^"]*(?:私密客户 A|10000\.00)/u);
const forecastDom = parseHTML(forecastOverview);
const unbindForecast = bindFinancialCashForecastDraft(forecastDom.document, forecastDraft);
const forecastEvent = (type: string) => new forecastDom.window.Event(type, { bubbles: true });
const inflow = forecastDom.document.querySelector<HTMLInputElement>(
  '[data-cash-forecast-amount="inflow30"]'
)!;
const commit = forecastDom.document.querySelector<HTMLButtonElement>('[data-real-action="commit"]')!;
forecastDom.document.querySelector<HTMLInputElement>("[data-real-consent]")!.checked = true;
inflow.value = "";
inflow.dispatchEvent(forecastEvent("input"));
assert.equal(commit.disabled, true);
inflow.value = "1000.00";
inflow.dispatchEvent(forecastEvent("input"));
assert.equal(commit.disabled, false);
forecastDom.document.querySelector<HTMLButtonElement>(
  "[data-cash-forecast-receivable-empty]"
)!.dispatchEvent(forecastEvent("click"));
assert.equal(forecastDraft.toInput("2026-08-16T08:09:00.000Z").receivables.length, 0);
forecastDom.document.querySelector<HTMLButtonElement>(
  "[data-cash-forecast-receivable-add]"
)!.dispatchEvent(forecastEvent("click"));
assert.equal(commit.disabled, true);
for (const [field, value] of [
  ["customer", "DOM客户"], ["amount", "12.34"], ["daysOutstanding", "90"]
] as const) {
  const input = forecastDom.document.querySelector<HTMLInputElement>(
    `[data-cash-forecast-receivable-field="${field}"]`
  )!;
  input.value = value;
  input.dispatchEvent(forecastEvent("input"));
}
assert.equal(commit.disabled, false);
assert.deepEqual(forecastDraft.toInput("2026-08-16T08:09:00.000Z").receivables, [{
  customer: "DOM客户", amountMinor: 1_234, daysOutstanding: 90
}]);
unbindForecast();
forecastDraft.clear();
assert.doesNotMatch(renderRealAgentsOverview({
  readiness: null, routingPolicy: null, routingPreview: [],
  files: { balance_sheet: null, income_statement: null, cash_flow_statement: null },
  statementPreview: null, statementPackage: null, latestRun: null, runAgents: null,
  consentAccepted: false, busy: null, error: null
}), /私密客户 A|10000\.00/u);
deactivateForecast();

const detail = renderAgentDetail("profit");
assert.equal(detail.includes("找出钱到底赚在哪"), true);
assert.equal(detail.includes('alt="利润分析头像"'), true);
assert.equal(detail.includes("哪个产品是假利润？"), true);
assert.equal(detail.includes("data-agents-form=\"ask\""), true);
assert.equal(detail.includes('data-agent-question="哪个产品是假利润？"'), true);
assert.equal(detail.includes('class="agent-question-examples"'), true);
assert.equal(detail.includes('class="agent-answer-empty"'), true);
assert.equal(detail.includes("管理会计 · 贡献毛利"), true);
assert.equal(detail.includes("<script>"), false);

assert.equal(renderAgentDetail("unknown-agent").includes("未知智能体"), true);

const report: DiagnosisReport = {
  companyName: "示例贸易公司",
  period: "2026-08",
  healthScoreBps: 4_600,
  summary: "本期经营存在需要关注的问题。",
  issues: [{
    category: "利润",
    level: "red",
    title: "存在假利润产品",
    reason: "产品 A 扣除费用后真实利润率过低",
    risk: "假利润产品会虚增收入规模、掩盖真实盈利结构",
    suggestion: "调整定价或收缩产品线",
    evidence: ["假利润产品：产品 A"]
  }],
  actionPlan90Days: [
    { month: 1, action: "清理低质产品" },
    { month: 2, action: "调整报价" },
    { month: 3, action: "建立月度经营分析会" }
  ],
  evidence: ["假利润产品：产品 A"]
};
const reportHtml = renderDiagnosisReport(report);
assert.equal(reportHtml.includes("《经营诊断报告》"), true);
assert.equal(reportHtml.includes("46"), true);
assert.equal(reportHtml.includes("问题清单（按优先级）"), true);
assert.equal(reportHtml.includes("高风险"), true);
assert.equal(reportHtml.includes("利润"), true);
assert.equal(reportHtml.includes("假利润产品会虚增收入规模、掩盖真实盈利结构"), true);
assert.equal(reportHtml.includes("未来 90 天行动计划"), true);
assert.equal(reportHtml.includes("假利润产品：产品 A"), true);
assert.equal(reportHtml.includes('aria-label="企业健康评分 46 分"'), true);
assert.equal(reportHtml.includes('class="report-issue issue-red"'), true);
assert.equal(reportHtml.includes('<details class="report-evidence"'), true);
assert.equal(reportHtml.includes('class="report-timeline"'), true);
assert.equal(reportHtml.includes('class="diagnosis-summary"'), true);
assert.equal(reportHtml.includes("<script>"), false);

const reportWithSource = renderDiagnosisReport(report, {
  sourceLabel: "河南元能信息科技有限公司 · 2026-06",
  warnings: ["未提供现金流量表"]
});
assert.equal(reportWithSource.includes("数据源：河南元能信息科技有限公司 · 2026-06"), true);
assert.equal(reportWithSource.includes("未提供现金流量表"), true);

const picker = renderCompanyPicker([
  {
    companyName: "河南元能信息科技有限公司",
    period: "2026-06",
    warnings: [],
    report
  },
  {
    companyName: "坏公司",
    period: "unknown-period",
    warnings: [],
    error: "资产负债表勾稽不平",
    errorCode: "statement_unbalanced"
  }
]);
assert.equal(picker.includes("报表解析完成"), true);
assert.equal(picker.includes("河南元能信息科技有限公司"), true);
assert.equal(picker.includes("查看诊断报告"), true);
assert.equal(picker.includes("解析失败"), true);
assert.equal(picker.includes("资产负债表勾稽不平"), true);
assert.equal(picker.includes('class="company-picker-list"'), true);
assert.equal(picker.includes("company-picker-row"), true);
assert.equal(picker.includes("has-error"), true);
assert.equal(picker.includes("<script>"), false);
