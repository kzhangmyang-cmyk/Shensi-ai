import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import type { RealDashboardSummary } from "./real-api";
import { renderRealDashboardView } from "./real-view";

export const realDashboardFixture: RealDashboardSummary = {
  scope: "本团队业务数据，本人待办",
  scopeLabels: { business: "本团队业务", todos: "本人待办" },
  updatedAt: "2026-09-07T08:00:00.000Z",
  periods: {
    today: {
      label: "今日", start: "2026-09-07", end: "2026-09-07", expectedDeals: 1,
      expectedAmounts: [{ currency: "CNY", amount: 12000 }], pendingTodos: 2,
      highPriorityTodos: 1, newLeads: 3,
      briefing: { title: "今日简报", description: "今日说明", basis: "今日依据", action: "今日行动", impact: "今日影响" }
    },
    week: {
      label: "本周", start: "2026-09-07", end: "2026-09-13", expectedDeals: 2,
      expectedAmounts: [{ currency: "CNY", amount: 42000 }], pendingTodos: 4,
      highPriorityTodos: 2, newLeads: 5,
      briefing: { title: "本周简报", description: "本周说明", basis: "本周依据", action: "本周行动", impact: "本周影响" }
    },
    month: {
      label: "本月", start: "2026-09-01", end: "2026-09-30", expectedDeals: 3,
      expectedAmounts: [{ currency: "CNY", amount: 96000 }], pendingTodos: 7,
      highPriorityTodos: 2, newLeads: 11,
      briefing: { title: "本月简报", description: "本月说明", basis: "本月依据", action: "本月行动", impact: "本月影响" }
    }
  },
  history: {
    period: "3m", label: "近三个月", start: "2026-06-07", end: "2026-09-07",
    buckets: [
      { key: "one", label: "06-07—07-06", start: "2026-06-07", end: "2026-07-06", newLeads: 12, expectedDeals: 2, expectedAmounts: [{ currency: "CNY", amount: 52000 }] },
      { key: "two", label: "07-07—08-06", start: "2026-07-07", end: "2026-08-06", newLeads: 18, expectedDeals: 3, expectedAmounts: [{ currency: "CNY", amount: 94000 }] },
      { key: "three", label: "08-07—09-07", start: "2026-08-07", end: "2026-09-07", newLeads: 21, expectedDeals: 4, expectedAmounts: [{ currency: "CNY", amount: 126000 }] }
    ],
    leadSources: [
      { source: "抖音", count: 30, share: 58.8 },
      { source: "转介", count: 21, share: 41.2 }
    ]
  },
  briefing: {
    title: "优先处理 <script>alert('brief')</script>",
    description: "真实数据简报", basis: "依据实际待办",
    action: "先跟进高金额商机", impact: "降低逾期风险", riskAmount: 18000,
    riskLabel: "团队风险金额", closableDeals: 2, closableAmount: 35000,
    closableAmounts: [{ currency: "CNY", amount: 35000 }], unreadWecom: 1
  },
  metrics: {
    customers: 18, riskCustomers: 4, todos: 7, overdueTodos: 2,
    forecastAmount: 376000,
    forecastAmounts: [{ currency: "CNY", amount: 276000 }, { currency: "USD", amount: 100000 }],
    wecomBoundRate: 61, pendingKnowledge: 3,
    examPassRate: 80, unfinishedExams: 1, customerCompleteness: 72
  },
  schedule: [{ time: "今天 16:00", title: "重发报价", subtitle: "中东项目", tone: "red" }],
  quality: { followHealth: 73, overdueRate: 29, avgResponseHours: 3.2 },
  leadFunnel: {
    stages: [
      { key: "entered", label: "进入系统", count: 100, conversionRate: 100 },
      { key: "pending", label: "待清洗", count: 80, conversionRate: 80 },
      { key: "valid", label: "有效线索", count: 40, conversionRate: 40 },
      { key: "customer", label: "已转客户", count: 10, conversionRate: 10 },
      { key: "deal", label: "已建商机", count: 5, conversionRate: 5 }
    ],
    todayAdded: 3, filteredOut: 2, dealConversionRate: 5
  },
  pipelineHealth: [
    { stage: "询盘", count: 5, amount: 140000, amounts: [{ currency: "CNY", amount: 140000 }], riskCount: 1, width: 100, tone: "amber" },
    { stage: "已联系", count: 3, amount: 126000, amounts: [{ currency: "USD", amount: 126000 }], riskCount: 0, width: 60, tone: "aqua" }
  ],
  todoInsights: {
    total: 7, overdue: 2, completionRate: 50, impactAmount: 86000,
    typeRows: [{ type: "customer", label: "客户", count: 4, risk: "高" }],
    weekLoad: [{ day: "一", count: 2 }], historyCount: 5, historyAmount: 42000
  },
  priorityTasks: [{
    id: "deal-1", customerId: "customer-1", title: "高金额商机",
    subtitle: "德国 · 谈判 · 120,000", score: 92,
    reason: "金额权重 40", action: "确认付款条件", tone: "red", badge: "逾期"
  }]
};

function hosts() {
  const { document } = parseHTML("<main id='main'></main><aside id='inspector'></aside>");
  return {
    main: document.querySelector<HTMLElement>("#main")!,
    inspector: document.querySelector<HTMLElement>("#inspector")!
  };
}

{
  const { main, inspector } = hosts();
  renderRealDashboardView({ status: "ready", summary: realDashboardFixture, error: null, period: "3m" }, main, inspector);
  const html = main.innerHTML + inspector.innerHTML;
  assert.match(html, /真实经营数据/u);
  assert.match(html, /本团队业务数据，本人待办/u);
  assert.match(html, /CNY 276,000/u);
  assert.match(html, /USD 100,000/u);
  assert.doesNotMatch(html, />376,000</u,
    "mixed currencies must not be displayed as a single forecast total");
  assert.equal((html.match(/暂无可用汇总/gu) ?? []).length, 2);
  assert.doesNotMatch(html, /接口未提供|沿用后端预测口径/u);
  assert.match(html, /较上一阶段 50%/u,
    "the real view must calculate adjacent conversion only across the serial funnel stages");
  assert.equal(
    Array.from(main.querySelectorAll(".demo-funnel-item")).some((item) =>
      item.textContent?.includes("待清洗")),
    false,
    "pending cleanup is a sibling status and must not be rendered as a serial funnel stage"
  );
  assert.match(html, /预计成交金额趋势/u);
  assert.match(html, /渠道贡献（线索数量）/u);
  assert.match(html, /real-dashboard-analysis-grid/u);
  assert.equal(main.querySelectorAll(".real-dashboard-analysis-panel").length, 3);
  assert.match(html, /预计成交 \/ 回款趋势/u);
  assert.match(html, /今日待办/u);
  assert.match(html, /data-real-dashboard-period="month"/u);
  assert.match(html, /data-private-domain-customer-id="customer-1"/u);
  assert.match(html, /is-multi-currency/u,
    "multi-currency totals should use readable independent value tokens");
  assert.match(html, /real-dashboard-task-rows/u,
    "the lower workspace should group real task rows separately from its header and footer");
  assert.match(html, /real-dashboard-task-footer[^>]*>.*共 1 项/su,
    "the task workspace footer must report the real schedule count");
  assert.doesNotMatch(html, /本地演示数据|DemoState|<script>/u);
  assert.match(html, /&lt;script&gt;/u);
}

{
  const { main, inspector } = hosts();
  const emptySummary: RealDashboardSummary = {
    ...realDashboardFixture,
    metrics: { ...realDashboardFixture.metrics, customers: 0, riskCustomers: 0, todos: 0 },
    history: {
      ...realDashboardFixture.history,
      buckets: realDashboardFixture.history.buckets.map((bucket) => ({
        ...bucket,
        newLeads: 0,
        expectedDeals: 0,
        expectedAmounts: []
      })),
      leadSources: []
    },
    leadFunnel: {
      ...realDashboardFixture.leadFunnel,
      stages: realDashboardFixture.leadFunnel.stages.map((stage) => ({
        ...stage,
        count: 0,
        conversionRate: 0
      })),
      todayAdded: 0,
      filteredOut: 0,
      dealConversionRate: 0
    },
    schedule: [],
    pipelineHealth: [],
    priorityTasks: []
  };
  renderRealDashboardView({ status: "ready", summary: emptySummary, error: null, period: "3m" }, main, inspector);
  assert.match(inspector.textContent ?? "", /暂无可判断的经营数据/u);
  assert.match(inspector.textContent ?? "", /不判断风险高低/u);
  assert.match(main.textContent ?? "", /暂无可判断的转化数据/u);
  assert.match(main.textContent ?? "", /当前没有待办/u);
  assert.match(main.textContent ?? "", /共 0 项/u,
    "an empty workspace should retain the same truthful task-count footer");
  assert.doesNotMatch(main.textContent ?? "", /服务器待办/u);
  assert.equal(main.querySelectorAll(".real-dashboard-funnel-stack").length, 0,
    "an empty workspace must not draw a zero-valued funnel as operating data");
  assert.doesNotMatch(inspector.textContent ?? "", /优先处理|\$0/u);
}

{
  const { main, inspector } = hosts();
  renderRealDashboardView({ status: "loading", summary: null, error: null, period: "3m" }, main, inspector);
  assert.match(main.textContent ?? "", /正在读取真实经营数据/u);
  renderRealDashboardView({ status: "error", summary: null, error: "dashboard_down", period: "3m" }, main, inspector);
  assert.match(main.innerHTML, /data-real-dashboard-action="retry"/u);
  assert.match(main.textContent ?? "", /dashboard_down/u);
}
