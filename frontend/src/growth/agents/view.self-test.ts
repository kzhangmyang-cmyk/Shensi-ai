import { strict as assert } from "node:assert";
import {
  BUSINESS_AGENT_TEAM,
  businessAgentById
} from "./agents";
import { parseAgentsHash } from "./entry";
import {
  renderAgentDetail,
  renderAgentsOverview,
  renderCompanyPicker,
  renderDiagnosisReport
} from "./view";
import type { DiagnosisReport } from "./api";

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
