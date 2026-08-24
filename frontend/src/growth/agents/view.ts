import {
  BUSINESS_AGENT_TEAM,
  businessAgentById,
  type BusinessAgent
} from "./agents";
import type {
  DiagnosisReport,
  ParsedCompanyResult
} from "./api";
import type { RealAgentCenterControllerState } from "./real-controller";
import {
  currentFinancialCashForecastDraftComplete,
  currentFinancialCashForecastDraftSnapshot
} from "./entry";

const REAL_ROLES = ["cfo", "finance", "profit", "cost", "cashflow", "tax"] as const;
const REAL_STATUS_LABELS = {
  not_connected: "未连接数据",
  ready: "数据已就绪",
  running: "分析中",
  waiting: "等待其他专家",
  completed: "已完成",
  manual_review: "需要人工复核",
  model_error: "模型连接异常"
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function agentAvatar(agent: BusinessAgent, loading: "eager" | "lazy" = "eager"): string {
  return `<span class="agent-avatar">
    <img class="agent-avatar-image" src="${escapeHtml(agent.avatarSrc)}"
      alt="${escapeHtml(`${agent.name}头像`)}" width="384" height="384"
      loading="${loading}" decoding="async" />
  </span>`;
}

function agentCard(agent: BusinessAgent, demo: boolean): string {
  const capabilities = agent.capabilities
    .map((item) => `<span class="agent-capability">${escapeHtml(item)}</span>`)
    .join("");
  const workbenchLink = demo
    ? `<a href="#growth/agents/${escapeHtml(agent.id)}"
         data-agents-demo-link="${escapeHtml(agent.id)}">进入工作台</a>`
    : `<a href="#growth/agents/${escapeHtml(agent.id)}">进入工作台</a>`;
  const status = agent.dataReady
    ? '<span class="agent-status agent-status-ready">数据就绪</span>'
    : '<span class="agent-status">待配置</span>';
  return `<article class="agent-card" data-agent-id="${escapeHtml(agent.id)}"
    style="--agent-accent:${agent.accent}">
    <header>
      ${agentAvatar(agent)}
      <div class="agent-card-identity">
        <h3>${escapeHtml(agent.name)}</h3>
        <p>${escapeHtml(agent.title)}</p>
      </div>
    </header>
    <p class="agent-summary">${escapeHtml(agent.summary)}</p>
    ${status}
    <div class="agent-capabilities">${capabilities}</div>
    <footer>
      <span>知识库：${escapeHtml(agent.knowledgeBase)}</span>
      ${workbenchLink}
    </footer>
  </article>`;
}

export interface AgentsOverviewOptions {
  readonly sourceLabel?: string;
  readonly showImport?: boolean;
  readonly demo?: boolean;
  readonly healthScoreBps?: number;
  readonly sources?: readonly string[];
}

function healthScoreMarkup(healthScoreBps?: number): string {
  if (healthScoreBps === undefined) {
    return `<div class="health-score-ring is-pending"
      aria-label="企业健康评分待生成" role="img">
      <strong>待生成</strong>
      <span>健康评分</span>
    </div>`;
  }
  const score = Math.max(0, Math.min(100, Math.round(healthScoreBps / 100)));
  return `<div class="health-score-ring" style="--health-score:${score}%"
    aria-label="企业健康评分 ${score} 分" role="img">
    <strong>${score}</strong>
    <span>/ 100</span>
  </div>`;
}

function dataSourceBadges(sources: readonly string[] = []): string {
  if (sources.length === 0) {
    return '<span class="data-source-empty">尚未连接经营数据</span>';
  }
  return sources.map((source) =>
    `<span class="data-source-badge">${escapeHtml(source)}</span>`
  ).join("");
}

function realFileField(
  state: RealAgentCenterControllerState,
  kind: keyof RealAgentCenterControllerState["files"],
  label: string
): string {
  const file = state.files[kind];
  return `<label class="statement-dropzone" data-statements-drop="${kind}">
    <input class="statements-file-input" type="file" accept=".xls,.xlsx"
      aria-label="${label}" data-statements-file="${kind}" />
    <span class="statement-file-type" aria-hidden="true">XLS</span>
    <span class="statement-file-copy"><strong>${label}</strong>
      <span>点击选择 xls / xlsx 文件</span></span>
    <span class="statement-file-name${file ? " has-file" : ""}"
      data-statements-file-name="${kind}">${file
        ? `${escapeHtml(file.name)} · ${file.size} bytes`
        : "未选择文件"}</span>
  </label>`;
}

function realRoutingDialog(state: RealAgentCenterControllerState): string {
  const editable = state.readiness?.capabilities.canManageRouting === true;
  const rows = REAL_ROLES.map((role) => {
    const preview = state.routingPreview.find((item) => item.role === role);
    const policy = state.routingPolicy?.roles[role];
    const options = preview?.orderedConnections ?? [];
    const optionMarkup = options.map((connection) =>
      `<option value="${escapeHtml(connection.connectionId)}" ${
        policy?.primaryConnectionId === connection.connectionId ? "selected" : ""}>
        ${escapeHtml(connection.displayName)} · ${escapeHtml(connection.model)}
      </option>`).join("");
    return `<fieldset class="routing-role" data-routing-role="${role}">
      <legend>${escapeHtml(businessAgentById(role)?.name ?? role)}</legend>
      <label>路由模式 <select data-routing-field="mode" ${editable ? "" : "disabled"}>
        <option value="auto" ${policy?.mode !== "pinned" ? "selected" : ""}>自动推荐</option>
        <option value="pinned" ${policy?.mode === "pinned" ? "selected" : ""}>管理员固定</option>
      </select></label>
      <label>主模型 <select data-routing-field="primary" ${editable ? "" : "disabled"}>
        <option value="">由服务端推荐</option>${optionMarkup}
      </select></label>
      <label>备用模型 <select data-routing-field="fallback" ${editable ? "" : "disabled"}>
        <option value="">无</option>${optionMarkup}
      </select></label>
      <p>${preview?.reasonCodes.map((code) => escapeHtml(code)).join(" · ")
        || "服务端尚未返回路由理由"}</p>
    </fieldset>`;
  }).join("");
  return `<dialog class="routing-dialog" data-routing-dialog aria-labelledby="routing-title">
    <form method="dialog"><header><h3 id="routing-title">六角色模型路由</h3>
      <button value="cancel" aria-label="关闭模型路由">×</button></header></form>
    <p>仅展示服务端认证通过的连接；不会显示密钥、提示词或财务请求正文。</p>
    <div class="routing-grid">${rows}</div>
    ${editable
      ? `<button type="button" data-routing-action="save">保存路由策略</button>`
      : "<p>当前账号为只读权限，不能修改路由策略。</p>"}
  </dialog>`;
}

function realAgentCard(
  state: RealAgentCenterControllerState,
  role: typeof REAL_ROLES[number]
): string {
  const agent = businessAgentById(role)!;
  const runRole = state.runAgents?.roles.find((item) => item.role === role);
  const readinessRole = state.readiness?.models.roles.find((item) => item.role === role);
  const fallback = runRole?.attempts.some((attempt) => attempt.status === "failed") === true;
  const preview = state.routingPreview.find((item) => item.role === role);
  const latestAttempt = runRole?.attempts.at(-1);
  const connectionName = latestAttempt?.connectionDisplayName
    ?? readinessRole?.connectionDisplayName
    ?? preview?.selectedConnection?.displayName;
  const status = runRole?.status ?? readinessRole?.status ?? "not_connected";
  const phase = runRole?.phase ?? null;
  return `<article class="agent-card real-agent-card" data-agent-id="${role}">
    <header>${agentAvatar(agent)}<div class="agent-card-identity">
      <h3>${escapeHtml(agent.name)}</h3><p>${escapeHtml(agent.title)}</p></div></header>
    <p class="agent-summary">${escapeHtml(agent.summary)}</p>
    <span class="agent-status ${status === "ready" || status === "completed"
      ? "agent-status-ready" : ""}">${REAL_STATUS_LABELS[status]}</span>
    <dl class="agent-server-projection">
      <div><dt>当前模型</dt><dd>${escapeHtml(connectionName ?? "暂未选择")}</dd></div>
      <div><dt>当前阶段</dt><dd>${escapeHtml(phase ?? "等待运行")}</dd></div>
      <div><dt>最近运行</dt><dd>${escapeHtml(state.readiness?.latestRun?.updatedAt ?? "暂无")}</dd></div>
    </dl>
    ${fallback ? '<span class="routing-fallback-badge">主模型失败，已使用备用模型</span>'
      : preview && preview.orderedConnections.length > 1
        ? '<span class="routing-fallback-badge">已配置备用模型</span>' : ""}
    ${role === "tax" ? '<p class="council-disclaimer">税务内容需要具备资质的专业人士人工复核，不构成税务意见。</p>' : ""}
  </article>`;
}

function cashForecastReceivableRows(): string {
  const snapshot = currentFinancialCashForecastDraftSnapshot();
  return (snapshot?.receivables ?? []).map((row, index) => {
    const position = index + 1;
    return `<fieldset class="cash-forecast-receivable" data-cash-forecast-receivable-row>
      <legend>应收账款 ${position}</legend>
      <label for="cash-forecast-customer-${position}">应收客户 ${position}</label>
      <input id="cash-forecast-customer-${position}" type="text" maxlength="255"
        autocomplete="off" data-cash-forecast-receivable-field="customer"
        value="${escapeHtml(row.customer)}">
      <label for="cash-forecast-amount-${position}">应收金额 ${position}</label>
      <input id="cash-forecast-amount-${position}" type="text" inputmode="decimal"
        autocomplete="off" data-cash-forecast-receivable-field="amount"
        value="${escapeHtml(row.amount)}">
      <label for="cash-forecast-days-${position}">逾期天数 ${position}</label>
      <input id="cash-forecast-days-${position}" type="text" inputmode="numeric"
        autocomplete="off" data-cash-forecast-receivable-field="daysOutstanding"
        value="${escapeHtml(row.daysOutstanding)}">
      <button type="button" data-cash-forecast-receivable-remove>
        删除应收账款 ${position}</button>
    </fieldset>`;
  }).join("");
}

function cashForecastForm(currency: "CNY" | "USD"): string {
  const snapshot = currentFinancialCashForecastDraftSnapshot();
  const amounts = snapshot?.amounts ?? {
    inflow30: "", outflow30: "", inflow31To90: "", outflow31To90: ""
  };
  const amount = (
    field: keyof typeof amounts,
    label: string
  ) => `<label for="cash-forecast-${field}">${label}</label>
    <div class="cash-forecast-money-control">
      <input id="cash-forecast-${field}" type="text" inputmode="decimal"
        autocomplete="off" data-cash-forecast-amount="${field}"
        value="${escapeHtml(amounts[field])}">
      <span aria-hidden="true">${currency}</span>
    </div>`;
  const rows = cashForecastReceivableRows();
  return `<section class="cash-forecast" aria-labelledby="cash-forecast-title">
    <header><span class="agents-overline">MANAGEMENT ATTESTATION</span>
      <h4 id="cash-forecast-title">未来现金预测</h4>
      <p>金额以 ${currency} 主币单位填写，提交时安全转换为分。</p></header>
    <div class="cash-forecast-amounts">
      ${amount("inflow30", "未来 30 天预计流入")}
      ${amount("outflow30", "未来 30 天预计流出")}
      ${amount("inflow31To90", "第 31–90 天预计流入")}
      ${amount("outflow31To90", "第 31–90 天预计流出")}
    </div>
    <section class="cash-forecast-receivables" aria-labelledby="cash-forecast-receivables-title">
      <header><h5 id="cash-forecast-receivables-title">应收账款与账龄</h5>
        <div><button type="button" data-cash-forecast-receivable-add>添加应收账款</button>
        <button type="button" data-cash-forecast-receivable-empty>当前没有应收账款</button></div>
      </header>
      <p data-cash-forecast-receivables-empty ${
        snapshot?.receivablesState === "empty" ? "" : "hidden"
      }>已确认：当前没有应收账款。</p>
      <div data-cash-forecast-receivables>${rows}</div>
    </section>
    <label class="cash-forecast-attestation">
      <input type="checkbox" data-cash-forecast-attestation ${
        snapshot?.attestationAccepted ? "checked" : ""
      }>
      我确认以上管理层现金预测真实、完整，并接受声明版本
      <strong>financial-cash-forecast.v1</strong>。
    </label>
  </section>`;
}

export function renderRealAgentsOverview(
  state: RealAgentCenterControllerState
): string {
  const selected = Object.values(state.files).filter(Boolean).length;
  const preview = state.statementPreview;
  const verified = state.statementPackage;
  const serviceMessage = state.error
    ? `<p class="growth-error" role="alert">真实财务服务未就绪：${escapeHtml(state.error)}</p>`
    : !state.readiness ? '<p class="agents-real-loading" role="status">正在连接真实财务服务…</p>' : "";
  return `<section class="growth-panel agents-home agents-real" data-agent-center-authority="real">
    <header class="agents-hero"><div class="agents-hero-copy">
      <span class="agents-eyebrow">REAL FINANCIAL COUNCIL</span>
      <h2>AI 经营顾问团队</h2><p>真实企业工作区 · 服务端财务权威</p></div>
      <div class="agents-hero-actions"><button type="button" data-routing-action="open">
        查看模型路由</button></div></header>
    ${serviceMessage}
    <section class="statements-import" aria-labelledby="real-statements-title">
      <header class="statements-import-heading"><div>
        <span class="agents-overline">THREE-REPORT ONBOARDING</span>
        <h3 id="real-statements-title">上传三张必需财务报表</h3>
        <p>依次完成预览、授权确认、提交验证和委员会运行。</p></div>
        <span class="statements-security">浏览器不持有原始工作簿内容</span></header>
      <div class="statements-import-fields">
        ${realFileField(state, "balance_sheet", "资产负债表")}
        ${realFileField(state, "income_statement", "利润表")}
        ${realFileField(state, "cash_flow_statement", "现金流量表")}
      </div>
      <p data-statements-selection>已选择 ${selected} / 3 份必需报表</p>
      <button type="button" data-real-action="preview" ${selected === 3 && !state.busy ? "" : "disabled"}>
        1. 服务端解析预览</button>
      ${preview ? `<section class="statement-preview" aria-labelledby="statement-preview-title">
        <h4 id="statement-preview-title">解析预览</h4>
        <dl><div><dt>企业</dt><dd>${escapeHtml(preview.companyName)}</dd></div>
          <div><dt>期间</dt><dd>${escapeHtml(preview.period)}</dd></div>
          <div><dt>币种</dt><dd>${escapeHtml(preview.currency)}</dd></div></dl>
        <h5>服务端警告与无效项</h5><ul>${preview.warningCodes.map((warning) =>
          `<li>${escapeHtml(warning)}</li>`).join("") || "<li>无警告</li>"}</ul>
        <p>标准化关键金额以服务端验证结果为准；未知项目显示“暂不可计算”。</p>
      </section>` : ""}
      ${preview && !verified ? cashForecastForm(preview.currency) : ""}
      <label class="financial-consent"><input type="checkbox" data-real-consent
        ${state.consentAccepted ? "checked" : ""} ${preview ? "" : "disabled"}>
        我确认标准化财务数据会传输给所选第三方模型供应商；已阅读
        <button type="button" data-routing-action="open">安全路由摘要</button>。</label>
      <div class="statements-import-actions">
        <button type="button" data-real-action="commit" ${preview && state.consentAccepted
          && currentFinancialCashForecastDraftComplete() && !state.busy ? "" : "disabled"}>
          2. 确认并提交验证</button>
        <button type="button" data-real-action="run" ${verified && state.readiness?.capabilities.canRun && !state.busy ? "" : "disabled"}>
          3. 启动财务委员会</button>
      </div>
      ${verified ? `<div class="statement-package-ready"><p>已验证：${escapeHtml(verified.companyName)} · ${escapeHtml(verified.period)}</p>${
        verified.cashForecast
          ? `<p>现金预测已确认 · 应收 ${verified.cashForecast.receivablesCount} 笔 · ${
            escapeHtml(verified.cashForecast.forecastAsOf)}</p>`
          : ""
      }</div>` : ""}
    </section>
    <section aria-labelledby="real-agents-title"><h3 id="real-agents-title">六角色服务端状态</h3>
      <div class="agents-grid">${REAL_ROLES.map((role) => realAgentCard(state, role)).join("")}</div>
    </section>
    ${realRoutingDialog(state)}
  </section>`;
}

export function renderAgentsOverview(
  options: AgentsOverviewOptions = {}
): string {
  const cards = BUSINESS_AGENT_TEAM
    .map((agent) => agentCard(agent, options.demo === true))
    .join("");
  return `<section class="growth-panel agents-home">
    <header class="agents-hero">
      <div class="agents-hero-copy">
        <span class="agents-eyebrow">BUSINESS ADVISOR CENTER</span>
        <h2>AI 经营顾问团队</h2>
        <p>没有请 CFO 的老板，也能拥有一支虚拟经营管理团队。
          ${options.demo ? '<span class="demo-badge">演示数据</span>' : ""}
        </p>
      </div>
      <div class="agents-hero-actions">
        <button type="button" class="agents-primary"
          data-agents-action="generate-report">生成经营诊断报告</button>
      </div>
    </header>
    <section class="agents-overview-strip" aria-label="经营数据概览">
      ${healthScoreMarkup(options.healthScoreBps)}
      <div class="agents-source-overview">
        <div class="agents-source-heading">
          <div>
            <span class="agents-overline">当前数据源</span>
            <strong>${escapeHtml(options.sourceLabel ?? "示例数据")}</strong>
          </div>
          <span class="agents-source-count">${options.sources?.length ?? 0} 项已连接</span>
        </div>
        <div class="data-source-badges">${dataSourceBadges(options.sources)}</div>
      </div>
    </section>
    ${options.showImport !== false ? `<section class="statements-import">
      <header class="statements-import-heading">
        <div>
          <span class="agents-overline">STATEMENT IMPORT</span>
          <h3>上传真实报表（xls / xlsx）</h3>
          <p>选择资产负债表与利润表各一份，系统解析后直接生成经营诊断报告。</p>
        </div>
        <span class="statements-security">文件仅用于本次经营分析</span>
      </header>
      <div class="statements-import-fields">
        <label class="statement-dropzone" data-statements-drop="balance">
          <input class="statements-file-input" type="file" accept=".xls,.xlsx"
            data-statements-file="balance" />
          <span class="statement-file-type" aria-hidden="true">XLS</span>
          <span class="statement-file-copy">
            <strong>资产负债表</strong>
            <span>点击选择，或拖入 xls / xlsx 文件</span>
          </span>
          <span class="statement-file-name" data-statements-file-name="balance">
            未选择文件
          </span>
        </label>
        <label class="statement-dropzone" data-statements-drop="income">
          <input class="statements-file-input" type="file" accept=".xls,.xlsx"
            data-statements-file="income" />
          <span class="statement-file-type" aria-hidden="true">XLS</span>
          <span class="statement-file-copy">
            <strong>利润表</strong>
            <span>点击选择，或拖入 xls / xlsx 文件</span>
          </span>
          <span class="statement-file-name" data-statements-file-name="income">
            未选择文件
          </span>
        </label>
      </div>
      <div class="statements-import-status">
        <p data-statements-selection>已选择 0 / 2 份必需报表</p>
        <p class="statements-feedback" data-statements-feedback
          aria-live="polite" role="status"></p>
      </div>
      <div class="statements-import-actions">
        <button type="button" data-agents-action="statements-diagnose">
          解析并生成诊断报告
        </button>
        <button type="button" class="statements-sample" data-agents-action="sample-report">
          改用示例数据
        </button>
      </div>
      <p class="statements-source">
        当前数据源：${escapeHtml(options.sourceLabel ?? "示例数据")}
      </p>
    </section>` : ""}
    <div class="agents-grid">${cards}</div>
  </section>`;
}

export function renderAgentDetail(agentId: string): string {
  const agent = businessAgentById(agentId);
  if (!agent) {
    return `<section class="growth-panel"><p class="growth-error">
      未知智能体：${escapeHtml(agentId)}</p></section>`;
  }
  const capabilities = agent.capabilities
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const promptExamples = agentPromptExamples(agent.id).map((question) =>
    `<button type="button" data-agent-question="${escapeHtml(question)}">
      ${escapeHtml(question)}
    </button>`
  ).join("");
  return `<section class="growth-panel agent-workbench">
    <a href="#growth/agents" class="agents-back">← 返回团队</a>
    <header style="--agent-accent:${agent.accent}">
      ${agentAvatar(agent, "eager")}
      <div>
        <span class="agents-overline">SPECIALIST WORKBENCH</span>
        <h2>${escapeHtml(agent.name)}</h2>
        <p>${escapeHtml(agent.title)}</p>
      </div>
      <span class="agent-status ${agent.dataReady ? "agent-status-ready" : ""}">
        ${agent.dataReady ? "数据就绪" : "待配置"}
      </span>
    </header>
    <div class="agent-workbench-grid">
      <aside class="agent-info">
        <h3>职责</h3>
        <p>${escapeHtml(agent.summary)}</p>
        <h3>能力</h3>
        <ul>${capabilities}</ul>
        <h3>专属知识库</h3>
        <p>${escapeHtml(agent.knowledgeBase)}</p>
      </aside>
      <section class="agent-chat">
        <div class="agent-chat-heading">
          <span class="agents-overline">ASK &amp; ANALYZE</span>
          <h3>向 ${escapeHtml(agent.name)} 提问</h3>
          <p>从示例开始，或直接描述你正在做的经营决策。</p>
        </div>
        <form data-agents-form="ask">
          <div class="agent-question-examples">
            <span>示例问题</span>
            <div>${promptExamples}</div>
          </div>
          <label class="agent-question-label" for="agents-ask-input">经营问题</label>
          <div class="agents-ask-row">
            <input id="agents-ask-input" name="question"
              data-agent-question-input placeholder="输入你的经营问题…" />
            <button type="submit">分析</button>
          </div>
        </form>
        <div class="agent-conclusion" data-agents-output>
          <div class="agent-answer-empty">
            <strong>等待你的问题</strong>
            <p>选择示例问题或输入问题后提交，这里会给出带来源引用的分析结论。</p>
          </div>
        </div>
      </section>
      <aside class="agent-actions">
        <h3>可执行动作</h3>
        <button type="button" data-agents-action="create-todo">生成跟进待办</button>
        <button type="button" data-agents-action="open-report">查看经营诊断报告</button>
        <button type="button" data-agents-action="open-data">补充经营数据</button>
      </aside>
    </div>
  </section>`;
}

function agentPromptExamples(id: string): readonly string[] {
  switch (id) {
    case "profit":
      return ["哪个产品是假利润？", "哪些产品值得加码？", "利润被哪些费用吃掉了？"];
    case "cashflow":
      return ["未来 30 天现金够不够？", "哪些应收最该先催？", "未来 90 天有资金缺口吗？"];
    case "cost":
      return ["本月材料成本率为什么从 35% 涨到 42%？", "成本异常发生在哪里？", "哪些费用可以优先压缩？"];
    case "tax":
      return ["有哪些税务健康风险？", "哪些发票问题最紧急？", "收入确认是否存在风险？"];
    case "finance":
      return ["公司财务健康吗？哪里在恶化？", "哪些指标需要优先关注？", "利润和现金是否背离？"];
    default:
      return ["今天最该先改什么？", "未来 90 天先做哪三件事？", "当前最大经营风险是什么？"];
  }
}

function minorText(minor: number): string {
  return `${(minor / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 0
  })} 元`;
}

export interface DiagnosisReportOptions {
  readonly sourceLabel?: string;
  readonly warnings?: readonly string[];
}

export function renderCompanyPicker(
  companies: readonly ParsedCompanyResult[]
): string {
  const items = companies.map((company, index) => {
    if (company.error) {
      return `<li class="company-picker-item company-picker-row company-picker-error has-error">
        <div class="company-picker-row-main">
          <span class="company-picker-name">${escapeHtml(company.companyName)}</span>
          <span class="company-picker-period">${escapeHtml(company.period)}</span>
        </div>
        <span class="company-picker-status">解析失败</span>
        <p class="company-picker-error-text">${escapeHtml(company.error)}</p>
      </li>`;
    }
    return `<li class="company-picker-item company-picker-row">
      <div class="company-picker-row-main">
        <span class="company-picker-name">${escapeHtml(company.companyName)}</span>
        <span class="company-picker-period">${escapeHtml(company.period)}</span>
      </div>
      <span class="company-picker-status company-picker-ready">已就绪</span>
      <button type="button" data-agents-action="pick-company"
        data-company-index="${index}">查看诊断报告</button>
    </li>`;
  }).join("");
  return `<section class="growth-panel company-picker">
    <a href="#growth/agents" class="agents-back">← 返回团队</a>
    <header class="company-picker-heading">
      <div>
        <span class="agents-overline">COMPANY MATCHING</span>
        <h2>报表解析完成</h2>
        <p>选择一家已就绪公司查看经营诊断报告。</p>
      </div>
      <strong>${companies.length} 家公司</strong>
    </header>
    <ol class="company-picker-list">${items}</ol>
  </section>`;
}

export function renderDiagnosisReport(
  report: DiagnosisReport,
  options: DiagnosisReportOptions = {}
): string {
  const issues = report.issues.map((item) =>
    `<li class="report-issue issue-${escapeHtml(item.level)}">
      <h4>
        <span class="issue-level issue-${escapeHtml(item.level)}">
          ${item.level === "red" ? "高风险" : "关注"}
        </span>
        ${item.category
          ? `<span class="issue-category">${escapeHtml(item.category)}</span>`
          : ""}
        ${escapeHtml(item.title)}
      </h4>
      <div class="report-issue-fields">
        <p><strong>原因</strong><span>${escapeHtml(item.reason)}</span></p>
        ${item.risk
          ? `<p><strong>风险</strong><span>${escapeHtml(item.risk)}</span></p>`
          : ""}
        <p><strong>建议</strong><span>${escapeHtml(item.suggestion)}</span></p>
      </div>
      ${item.evidence.length > 0
        ? `<details class="report-evidence">
            <summary>查看证据 <span>${item.evidence.length} 条</span></summary>
            <div class="report-evidence-body">
              <ul>${item.evidence.map((evidence) =>
                `<li>${escapeHtml(evidence)}</li>`).join("")}</ul>
            </div>
          </details>`
        : ""}
    </li>`).join("");
  const actions = report.actionPlan90Days.map((item) =>
    `<li data-timeline-month="${item.month}">
      <span class="report-timeline-marker" aria-hidden="true">0${item.month}</span>
      <div>
        <span>第 ${item.month} 月</span>
        <strong>${escapeHtml(item.action)}</strong>
      </div>
    </li>`).join("");
  return `<section class="growth-panel diagnosis-report">
    <a href="#growth/agents" class="agents-back">← 返回团队</a>
    <header class="report-heading">
      <div>
        <span class="agents-overline">BUSINESS DIAGNOSIS</span>
        <h2>《经营诊断报告》</h2>
        <p>${escapeHtml(report.companyName)} · ${escapeHtml(report.period)}</p>
        ${options.sourceLabel
          ? `<p class="report-source">数据源：${escapeHtml(options.sourceLabel)}</p>`
          : ""}
      </div>
      <span class="report-period">90 天行动版</span>
    </header>
    ${options.warnings && options.warnings.length > 0
      ? `<section class="report-block"><h3>数据说明</h3>
          <ul>${options.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </section>`
      : ""}
    <section class="report-overview">
      ${healthScoreMarkup(report.healthScoreBps)}
      <div class="report-summary-card">
        <span class="agents-overline">EXECUTIVE SUMMARY</span>
        <h3>经营结论</h3>
        <p class="diagnosis-summary">${escapeHtml(report.summary)}</p>
      </div>
    </section>
    <section class="report-block">
      <div class="report-block-heading">
        <h3>问题清单（按优先级）</h3>
        <span>${report.issues.length} 项问题</span>
      </div>
      <ol class="report-issues">${issues || "<li>本期未发现突出问题</li>"}</ol>
    </section>
    <section class="report-block">
      <h3>未来 90 天行动计划</h3>
      <ol class="report-timeline">${actions}</ol>
    </section>
    ${report.evidence.length > 0
      ? `<details class="report-evidence-chain">
          <summary>查看完整证据链 <span>${report.evidence.length} 条</span></summary>
          <div><ul>${report.evidence.map((item) =>
            `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>
        </details>`
      : ""}
  </section>`;
}

export function renderAgentConclusion(html: string): string {
  return `<div class="agent-conclusion">${html}</div>`;
}

export function minorTextForConclusion(minor: number): string {
  return minorText(minor);
}
