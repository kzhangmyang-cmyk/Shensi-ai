import type { GrowthHttpClient } from "../http";
import { BUSINESS_AGENT_TEAM } from './agents';
import { createFinanceApi } from '../finance/api';
import { importErrorMessage } from '../finance/import-workflow';
import { createGrowthHttpClient } from "../http";
import * as XLSX from "xlsx";
import {
  createBusinessAdvisorApi,
  type BusinessAdvisorApi,
  type BusinessReportInput,
  type DiagnosisReport,
  type ParsedCompanyResult,
  type StatementSheet
} from "./api";
import {
  demoAnalysisResult,
  demoDiagnosisReport,
  sampleBusinessReport
} from "./sample";
import {
  renderCompanyPicker,
  renderAgentConclusion,
  renderAgentDetail,
  renderAgentsOverview,
  renderRealAgentConversationSupport,
  renderRealAgentsOverview,
  renderDiagnosisReport
} from "./view";
import { parseAgentsHash } from "./entry";
import type { RealAgentCenterController } from "./real-controller";
import type {
  FinancialCouncilModelRoutingPolicyInput,
  FinancialStatementKind
} from "../contracts";

export interface AgentsControllerOptions {
  readonly http?: GrowthHttpClient;
  readonly host: HTMLElement;
  readonly input?: BusinessReportInput;
  readonly demo?: boolean;
  readonly real?: RealAgentCenterController;
  readonly conversation?: (host: HTMLElement) => { dispose(): void };
  /** Optional companion surface for the real financial preparation controls. */
  readonly supportHost?: HTMLElement;
  readonly session?: AgentsSessionState;
  readonly window?: Window;
}

export interface AgentsSessionState {
  activeInput?: BusinessReportInput;
  lastReport?: DiagnosisReport;
  sourceLabel?: string;
  importWarnings?: readonly string[];
}

export interface AgentsController {
  render(): void;
  dispose(): void;
}

interface AnalysisResult {
  readonly indicators?: {
    readonly grossMarginBps?: number;
    readonly netMarginBps?: number;
    readonly quickRatioBps?: number;
    readonly receivableTurnover?: number;
    readonly inventoryTurnover?: number;
    readonly interestCoverage?: number;
    readonly receivableDays?: number;
    readonly cashCoverageMonths?: number;
    readonly debtRatioBps?: number;
    readonly cashCollectionRatioBps?: number;
    readonly cashProfitRatioBps?: number;
  };
  readonly products?: readonly {
    readonly name: string;
    readonly grossMarginBps: number;
    readonly trueMarginBps: number;
    readonly isFakeProfit: boolean;
  }[];
  readonly customers?: readonly {
    readonly name: string;
    readonly grade: string;
    readonly paymentDays: number;
  }[];
  readonly cashflow?: {
    readonly warning: readonly string[];
  };
  readonly cost?: {
    readonly anomaly: readonly string[];
  };
  readonly tax?: {
    readonly level: string;
    readonly findings: readonly { category: string; issue: string; level: string }[];
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function bpsText(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

interface AnalysisSummary {
  readonly conclusionHtml: string;
  readonly evidenceHtml: string;
  readonly actionsHtml: string;
}

function sourceBadgesForInput(input: BusinessReportInput | null): readonly string[] {
  if (!input) return Object.freeze([]);
  return Object.freeze([
    "资产负债表",
    "利润表",
    "现金流量表",
    ...(input.costDetail ? ["成本明细"] : []),
    ...(input.taxRisk ? ["税务风险"] : [])
  ]);
}

function summarizeAnalysis(agentId: string, result: AnalysisResult): AnalysisSummary {
  switch (agentId) {
    case "profit": {
      const fake = (result.products ?? []).filter((item) => item.isFakeProfit);
      const lines = (result.products ?? []).map((product) =>
        `<li>${escapeHtml(product.name)}：毛利率 ${bpsText(product.grossMarginBps)}，
          真实利润率 ${bpsText(product.trueMarginBps)}
          ${product.isFakeProfit ? "（假利润 ⚠）" : ""}</li>`).join("");
      return {
        conclusionHtml: fake.length > 0
          ? `<p>识别到 ${fake.length} 个假利润产品，收入规模没有转化为真实利润。</p>`
          : "<p>当前产品明细中未识别到假利润产品。</p>",
        evidenceHtml: `<p>按扣除售后、运费和销售费用后的真实利润排序：</p>
          <ul>${lines || "<li>无产品明细</li>"}</ul>
          ${fake.length > 0
            ? `<p>⚠ 假利润产品：${fake.map((item) => escapeHtml(item.name)).join("、")}</p>`
            : ""}`,
        actionsHtml: fake.length > 0
          ? "<ul><li>重新核算履约成本与销售费用</li><li>调整定价，或收缩无法改善的产品线</li></ul>"
          : "<p>继续按月复核产品真实利润率。</p>"
      };
    }
    case "cashflow": {
      const warnings = (result.cashflow?.warning ?? []);
      return {
        conclusionHtml: warnings.length > 0
          ? `<p class="growth-conflict">发现 ${warnings.length} 项现金流预警。</p>`
          : "<p>未来 90 天现金预测健康。</p>",
        evidenceHtml: warnings.length > 0
          ? `<ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
          : "<p>现有预测未触发现金流预警。</p>",
        actionsHtml: warnings.length > 0
          ? "<ul><li>优先催收超期应收</li><li>滚动更新未来 30 天收支计划</li></ul>"
          : "<p>保持每周更新收支预测。</p>"
      };
    }
    case "cost": {
      const anomalies = (result.cost?.anomaly ?? []);
      return {
        conclusionHtml: anomalies.length > 0
          ? `<p class="growth-conflict">发现 ${anomalies.length} 项成本异常。</p>`
          : "<p>未发现明显成本异常。</p>",
        evidenceHtml: anomalies.length > 0
          ? `<ul>${anomalies.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
          : "<p>当前成本指标处于既定区间。</p>",
        actionsHtml: anomalies.length > 0
          ? "<ul><li>核查采购价格、用量和产品结构变化</li><li>给异常成本项指定负责人</li></ul>"
          : "<p>继续监控材料与人工成本率。</p>"
      };
    }
    case "tax": {
      const tax = result.tax;
      if (!tax || tax.level === "green") {
        return {
          conclusionHtml: "<p>未发现税务风险点。</p>",
          evidenceHtml: "<p>当前税务检查结果为绿色。</p>",
          actionsHtml: "<p>按期复核发票、收入确认与成本真实性。</p>"
        };
      }
      const findings = (tax.findings ?? []).map((item) =>
        `<li>[${escapeHtml(item.level)}] ${escapeHtml(item.category)}：${escapeHtml(item.issue)}</li>`)
        .join("");
      return {
        conclusionHtml: `<p class="growth-conflict">税务风险等级：${escapeHtml(tax.level)}</p>`,
        evidenceHtml: `<ul>${findings}</ul>`,
        actionsHtml: "<ul><li>按风险等级建立整改清单</li><li>保留合同、发票和业务真实性证据</li></ul>"
      };
    }
    case "finance": {
      const indicators = result.indicators ?? {};
      return {
        conclusionHtml: "<p>已完成本期核心财务健康指标复核。</p>",
        evidenceHtml: `<ul>
          <li>毛利率 ${bpsText(indicators.grossMarginBps ?? 0)}</li>
          <li>净利率 ${bpsText(indicators.netMarginBps ?? 0)}</li>
          <li>速动比率 ${indicators.quickRatioBps !== undefined
            ? (indicators.quickRatioBps / 100).toFixed(1)
            : "0"}</li>
          <li>应收周转天数 ${indicators.receivableDays ?? 0} 天</li>
          <li>应收账款周转率 ${indicators.receivableTurnover ?? 0} 次</li>
          <li>存货周转率 ${indicators.inventoryTurnover ?? 0} 次</li>
          <li>利息保障倍数 ${indicators.interestCoverage ?? 0} 倍</li>
          <li>现金保障月数 ${indicators.cashCoverageMonths ?? 0} 个月</li>
          <li>资产负债率 ${bpsText(indicators.debtRatioBps ?? 0)}</li>
          <li>收现比 ${bpsText(indicators.cashCollectionRatioBps ?? 0)}</li>
          <li>净现比 ${bpsText(indicators.cashProfitRatioBps ?? 0)}</li>
        </ul>`,
        actionsHtml: "<p>优先处理恶化指标，并纳入未来 90 天行动计划。</p>"
      };
    }
    default:
      return {
        conclusionHtml: "<p>请先生成经营诊断报告。</p>",
        evidenceHtml: "<p>当前没有可引用的经营分析结果。</p>",
        actionsHtml: "<p>补充经营数据后重新分析。</p>"
      };
  }
}

function renderAnalysisAnswer(
  question: string,
  summary: AnalysisSummary
): string {
  return `<article class="agent-answer-card">
    <header class="agent-answer-question">
      <span>你的问题</span>
      <strong>${escapeHtml(question)}</strong>
    </header>
    <section class="agent-answer-section agent-answer-conclusion">
      <span>结论</span>
      ${summary.conclusionHtml}
    </section>
    <section class="agent-answer-section agent-answer-evidence report-evidence">
      <span>判断依据</span>
      ${summary.evidenceHtml}
    </section>
    <section class="agent-answer-section agent-answer-actions">
      <span>建议动作</span>
      ${summary.actionsHtml}
    </section>
  </article>`;
}

const REAL_ROLES = ["cfo", "finance", "profit", "cost", "cashflow", "tax"] as const;

function createRealAgentsController(
  options: AgentsControllerOptions & { readonly real: RealAgentCenterController }
): AgentsController {
  const windowPort = options.window ?? window;
  let disposed = false;
  let reports = options.host;
  let conversation: { dispose(): void } | undefined;
  let preparationOpen = false;
  type Candidate = { id: number; file: File; state: string; parsed?: boolean };
  const candidates = new Map<FinancialStatementKind, Candidate[]>(); let candidateId = 0;
  const candidateGeneration = new Map<FinancialStatementKind, number>();
  const candidateAborts = new Map<FinancialStatementKind, AbortController>();
  const documentApi = createFinanceApi(options.http ?? createGrowthHttpClient());
  if (options.conversation) {
    const chatHost = options.host.ownerDocument.createElement('div');
    reports = options.supportHost
      ?? options.host.ownerDocument.createElement('div');
    reports.classList.add('agents-support-workspace');
    options.host.replaceChildren(chatHost);
    if (!options.supportHost) options.host.append(reports);
    conversation = options.conversation(chatHost);
  }
  function setPreparationDialogOpen(open: boolean): void {
    const dialog = reports.querySelector<HTMLDialogElement>("[data-agent-preparation-dialog]");
    const trigger = reports.querySelector<HTMLButtonElement>(
      '[data-agent-preparation-action="open"]'
    );
    if (!dialog) return;
    if (open) {
      if (typeof dialog.showModal === "function") {
        if (!dialog.open) dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    } else if (typeof dialog.close === "function") {
      if (dialog.open) dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
    trigger?.setAttribute("aria-expanded", String(open));
  }

  const render = () => {
    if (disposed) return;
    reports.innerHTML = options.conversation
      ? renderRealAgentConversationSupport(options.real.getState())
      : renderRealAgentsOverview(options.real.getState());
    const selectedRole = options.host.querySelector<HTMLElement>('[data-cfo-role-choice][aria-pressed="true"]')?.dataset.cfoRoleChoice;
    const roleLabel = reports.querySelector<HTMLElement>('[data-cfo-inspector-role]');
    const role = BUSINESS_AGENT_TEAM.find(agent => agent.id === selectedRole);
    if (roleLabel && role) roleLabel.textContent = role.name.replace(/^AI\s*/u, '');
    for (const [kind, files] of candidates) {
      const field = reports.querySelector(`[data-statements-drop="${kind}"]`); if (!field) continue;
      const list = reports.ownerDocument.createElement('div');
      const hint = reports.ownerDocument.createElement('p'); hint.textContent = '同一表种可暂存多份；请明确选用一份用于本次正式三表，其他期间不会混入。'; list.append(hint);
      for (const item of files) {
        const row = reports.ownerDocument.createElement('div'); const text = reports.ownerDocument.createElement('span'); text.textContent = `${item.file.name} · ${item.state} `;
        const use = reports.ownerDocument.createElement('button'); use.type = 'button'; use.dataset.statementCandidate = String(item.id); use.dataset.candidateKind = kind; use.textContent = '选用 / 重试';
        const remove = reports.ownerDocument.createElement('button'); remove.type = 'button'; remove.dataset.statementCandidateRemove = String(item.id); remove.dataset.candidateKind = kind; remove.textContent = '移除';
        use.disabled = remove.disabled = candidateAborts.has(kind) || files.some(file => file.state === '读取中');
        row.append(text, use, remove); list.append(row);
      }
      field.after(list);
    }
    // A native modal cannot reliably live inside another open native modal.
    // The full preparation body contains the routing markup, but the routing
    // dialog itself is promoted to this support surface so either action can
    // be opened safely from the real conversation.
    if (options.conversation) {
      const routingDialog = reports.querySelector<HTMLDialogElement>(
        "[data-agent-preparation-dialog] [data-routing-dialog]"
      );
      if (routingDialog) reports.append(routingDialog);
    }
    if (preparationOpen) setPreparationDialogOpen(true);
  };
  const unsubscribe = options.real.subscribe(render);

  function openRouting(): void {
    if (preparationOpen) {
      preparationOpen = false;
      setPreparationDialogOpen(false);
    }
    const dialog = reports.querySelector<HTMLDialogElement>("[data-routing-dialog]");
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function routingInput(): FinancialCouncilModelRoutingPolicyInput | null {
    const policy = options.real.getState().routingPolicy;
    if (!policy) return null;
    const roles = Object.fromEntries(REAL_ROLES.map((role) => {
      const row = reports.querySelector<HTMLElement>(`[data-routing-role="${role}"]`);
      const mode = row?.querySelector<HTMLSelectElement>('[data-routing-field="mode"]')?.value;
      const primary = row?.querySelector<HTMLSelectElement>('[data-routing-field="primary"]')?.value ?? "";
      const fallback = row?.querySelector<HTMLSelectElement>('[data-routing-field="fallback"]')?.value ?? "";
      const original = policy.roles[role];
      return [role, mode === "pinned" ? {
        mode: "pinned" as const,
        primaryConnectionId: primary || null,
        fallbackConnectionIds: fallback && fallback !== primary ? [fallback] : [],
        preferenceWeightBps: original.preferenceWeightBps
      } : {
        mode: "auto" as const,
        primaryConnectionId: null,
        fallbackConnectionIds: [],
        preferenceWeightBps: original.preferenceWeightBps
      }];
    })) as FinancialCouncilModelRoutingPolicyInput["roles"];
    return {
      maxRoleBudgetMinor: policy.maxRoleBudgetMinor,
      maxRunBudgetMinor: policy.maxRunBudgetMinor,
      requestTimeoutMs: policy.requestTimeoutMs,
      roles
    };
  }

  function onChange(event: Event): void {
    if (disposed) return;
    const input = (event.target as HTMLElement | null)
      ?.closest<HTMLInputElement>("[data-statements-file]");
    if (input && reports.contains(input)) {
      const kind = input.dataset.statementsFile as FinancialStatementKind | undefined;
      if (kind) stageCandidates(kind, Array.from(input.files ?? []));
      return;
    }
    const consent = (event.target as HTMLElement | null)
      ?.closest<HTMLInputElement>("[data-real-consent]");
    if (consent && reports.contains(consent)) {
      options.real.acceptModelDataNotice(consent.checked);
    }
  }

  function onClick(event: MouseEvent): void {
    if (disposed) return;
    const candidateButton = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-statement-candidate], [data-statement-candidate-remove]');
    if (candidateButton && reports.contains(candidateButton)) {
      const kind = candidateButton.dataset.candidateKind as FinancialStatementKind;
      const files = candidates.get(kind) ?? []; const id = Number(candidateButton.dataset.statementCandidate ?? candidateButton.dataset.statementCandidateRemove);
      const item = files.find(file => file.id === id); if (!item) return;
      if (candidateButton.dataset.statementCandidateRemove) {
        candidateGeneration.set(kind, (candidateGeneration.get(kind) ?? 0) + 1);
        if (item.state === '已选用' || item.state === '读取中') options.real.clearStatement?.(kind);
        candidates.set(kind, files.filter(file => file !== item)); render();
      } else if (!item.parsed && files.length > 1) void inspectCandidates(kind, [item]);
      else void useCandidate(kind, item);
      return;
    }
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-real-action], [data-routing-action], [data-agent-preparation-action]"
    );
    if (!target || !reports.contains(target)) return;
    const preparationAction = target.dataset.agentPreparationAction;
    if (preparationAction === "open") {
      preparationOpen = true;
      setPreparationDialogOpen(true);
      return;
    }
    if (preparationAction === "close") {
      preparationOpen = false;
      setPreparationDialogOpen(false);
      return;
    }
    const routingAction = target.dataset.routingAction;
    if (routingAction === "open") {
      openRouting();
      return;
    }
    if (routingAction === "save") {
      const input = routingInput();
      if (input) void options.real.updateRouting(input);
      return;
    }
    switch (target.dataset.realAction) {
      case "preview": void options.real.previewStatements(); break;
      case "commit": void options.real.commitStatements(); break;
      case "run":
        void options.real.startCouncil().then(() => {
          if (disposed) return;
          const runId = options.real.getState().latestRun?.runId;
          if (runId) windowPort.location.hash = `#financial-council/run/${encodeURIComponent(runId)}`;
        });
        break;
    }
  }

  function onPreparationDialogClosed(event: Event): void {
    const dialog = event.target as HTMLDialogElement | null;
    if (dialog?.matches("[data-agent-preparation-dialog]")) {
      preparationOpen = false;
      const trigger = reports.querySelector<HTMLButtonElement>(
        '[data-agent-preparation-action="open"]'
      );
      trigger?.setAttribute("aria-expanded", "false");
    }
  }

  function stageCandidates(kind: FinancialStatementKind, files: File[]) {
    if (files.length > 10 || files.reduce((sum, file) => sum + file.size, 0) > 5 * 1024 * 1024) {
      const field = reports.querySelector(`[data-statements-drop="${kind}"]`); const notice = reports.ownerDocument.createElement('p'); notice.textContent = '每批最多10份，合计5MB；原选择保留。'; field?.after(notice); return;
    }
    candidateGeneration.set(kind, (candidateGeneration.get(kind) ?? 0) + 1);
    candidateAborts.get(kind)?.abort(); candidateAborts.delete(kind);
    options.real.clearStatement?.(kind);
    const selected = files.map(file => ({ id: ++candidateId, file, state: '待选用' })); candidates.set(kind, selected); render();
    if (selected.length === 1) void useCandidate(kind, selected[0]);
    else if (selected.length) void inspectCandidates(kind, selected);
  }
  async function inspectCandidates(kind: FinancialStatementKind, files: Candidate[]) {
    const epoch = candidateGeneration.get(kind); const abort = new AbortController(); candidateAborts.set(kind, abort);
    for (const item of files) {
      if (disposed || abort.signal.aborted || candidateGeneration.get(kind) !== epoch) break;
      item.state = '正在识别'; render();
      try {
        if (!/\.(xls|xlsx)$/iu.test(item.file.name)) throw new Error('请选择XLS或XLSX');
        const { body } = await documentApi.inspectDocument(item.file, item.file.name, false, abort.signal);
        if (disposed || abort.signal.aborted || candidateGeneration.get(kind) !== epoch) break;
        if (!body.cells.length) throw new Error('没有可识别来源');
        item.parsed = true; item.state = '识别成功，待选用';
      } catch (error) { if (!abort.signal.aborted) { item.parsed = false; item.state = `失败：${importErrorMessage(error)}`; } }
    }
    if (candidateAborts.get(kind) === abort) candidateAborts.delete(kind);
    if (!disposed) render();
  }
  async function useCandidate(kind: FinancialStatementKind, item: Candidate) {
    const epoch = (candidateGeneration.get(kind) ?? 0) + 1; candidateGeneration.set(kind, epoch);
    options.real.clearStatement?.(kind);
    if (!/\.(xls|xlsx)$/iu.test(item.file.name) || !item.file.size || item.file.size > 5 * 1024 * 1024) { item.state = '文件无效：请选择5MB内的XLS/XLSX'; render(); return; }
    for (const file of candidates.get(kind) ?? []) if (file !== item && file.state === '已选用') file.state = '识别成功，待选用';
    item.state = '读取中'; render(); await options.real.selectStatement(kind, item.file);
    if (disposed || candidateGeneration.get(kind) !== epoch) return;
    item.state = options.real.getState().files[kind]?.name === item.file.name ? '已选用' : '读取失败，可重试'; render();
  }
  function dropCandidates(event: DragEvent) {
    const zone = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-statements-drop]');
    if (!zone || !reports.contains(zone)) return; event.preventDefault();
    if (event.type === 'drop') stageCandidates(zone.dataset.statementsDrop as FinancialStatementKind, Array.from(event.dataTransfer?.files ?? []));
  }
  reports.addEventListener('dragover', dropCandidates); reports.addEventListener('drop', dropCandidates);
  reports.addEventListener("change", onChange);
  reports.addEventListener("click", onClick);
  reports.addEventListener("close", onPreparationDialogClosed, true);
  render();
  return Object.freeze({
    render,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      candidates.clear(); candidateGeneration.clear();
      for (const abort of candidateAborts.values()) abort.abort(); candidateAborts.clear();
      reports.removeEventListener('dragover', dropCandidates); reports.removeEventListener('drop', dropCandidates);
      reports.removeEventListener("change", onChange);
      reports.removeEventListener("click", onClick);
      reports.removeEventListener("close", onPreparationDialogClosed, true);
      options.real.destroy();
      conversation?.dispose();
      if (reports !== options.host) reports.replaceChildren();
      options.host.replaceChildren();
    }
  });
}

export function createAgentsController(
  options: AgentsControllerOptions
): AgentsController {
  if (options.real) {
    return createRealAgentsController({ ...options, real: options.real });
  }
  const windowPort = options.window ?? window;
  const api: BusinessAdvisorApi = createBusinessAdvisorApi(
    options.http ?? createGrowthHttpClient()
  );
  let activeInput: BusinessReportInput | null = options.input
    ?? options.session?.activeInput
    ?? (options.demo ? sampleBusinessReport() : null);
  let lastReport: DiagnosisReport | null = options.session?.lastReport ?? null;
  let sourceLabel = options.session?.sourceLabel ?? (options.demo ? "示例数据" : "");
  let importWarnings: readonly string[] = options.session?.importWarnings ?? [];
  let importedCompanies: readonly ParsedCompanyResult[] = [];
  let demoRoute: { view: "overview" } | { view: "report" }
    | { view: "detail"; agentId: string } | null = null;
  let disposed = false;
  let operationGeneration = 0;

  function persistSession(): void {
    if (!options.session) return;
    options.session.activeInput = activeInput ?? undefined;
    options.session.lastReport = lastReport ?? undefined;
    options.session.sourceLabel = sourceLabel;
    options.session.importWarnings = importWarnings;
  }

  function beginOperation(): number {
    operationGeneration += 1;
    return operationGeneration;
  }

  function canCommitOperation(generation: number): boolean {
    return !disposed
      && operationGeneration === generation
      && (options.demo || parseAgentsHash(windowPort.location.hash) !== null);
  }

  function mountView(html: string): void {
    options.host.innerHTML = html;
    options.host.scrollTop = 0;
    windowPort.scrollTo(0, 0);
  }

  function renderView(): void {
    const route = options.demo
      ? demoRoute
      : parseAgentsHash(windowPort.location.hash);
    if (options.demo) {
      if (route?.view === "detail") {
        mountView(renderAgentDetail(route.agentId));
      } else if (route?.view === "report" && lastReport) {
        mountView(renderDiagnosisReport(lastReport, {
          sourceLabel,
          warnings: importWarnings
        }));
      } else {
        mountView(renderAgentsOverview({
          sourceLabel,
          showImport: false,
          demo: true,
          healthScoreBps: lastReport?.healthScoreBps
            ?? demoDiagnosisReport().healthScoreBps,
          sources: sourceBadgesForInput(activeInput)
        }));
      }
      return;
    }
    if (route?.view === "detail") {
      mountView(renderAgentDetail(route.agentId));
    } else if (route?.view === "report" && lastReport) {
      mountView(renderDiagnosisReport(lastReport, {
        sourceLabel,
        warnings: importWarnings
      }));
    } else {
      mountView(renderAgentsOverview({
        sourceLabel,
        healthScoreBps: lastReport?.healthScoreBps,
        sources: sourceBadgesForInput(activeInput)
      }));
    }
  }

  function onHashChange(): void {
    if (disposed) return;
    operationGeneration += 1;
    renderView();
  }

  function setStatementFeedback(message: string, isError = false): void {
    const feedback = options.host.querySelector<HTMLElement>(
      "[data-statements-feedback]"
    );
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.toggle("is-error", isError);
  }

  function syncStatementSelection(): void {
    const inputs = Array.from(options.host.querySelectorAll<HTMLInputElement>(
      "[data-statements-file]"
    ));
    let selected = 0;
    for (const input of inputs) {
      const kind = input.dataset.statementsFile;
      if (!kind) continue;
      const file = input.files?.[0];
      if (file) selected += 1;
      const fileName = options.host.querySelector<HTMLElement>(
        `[data-statements-file-name="${kind}"]`
      );
      if (fileName) {
        fileName.textContent = file?.name ?? "未选择文件";
        fileName.classList.toggle("has-file", file !== undefined);
      }
    }
    const selection = options.host.querySelector<HTMLElement>(
      "[data-statements-selection]"
    );
    if (selection) {
      selection.textContent = `已选择 ${selected} / 2 份必需报表`;
    }
    setStatementFeedback(selected === 2 ? "报表已齐，可以开始解析" : "");
  }

  function statementDropzone(event: DragEvent): HTMLElement | null {
    const target = (event.target as HTMLElement | null)
      ?.closest<HTMLElement>("[data-statements-drop]");
    return target && options.host.contains(target) ? target : null;
  }

  function onStatementDragOver(event: DragEvent): void {
    const dropzone = statementDropzone(event);
    if (!dropzone) return;
    event.preventDefault();
    dropzone.classList.add("is-dragging");
  }

  function onStatementDragLeave(event: DragEvent): void {
    const dropzone = statementDropzone(event);
    if (!dropzone || dropzone.contains(event.relatedTarget as Node | null)) return;
    dropzone.classList.remove("is-dragging");
  }

  function onStatementDrop(event: DragEvent): void {
    const dropzone = statementDropzone(event);
    if (!dropzone) return;
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
    const file = event.dataTransfer?.files?.[0];
    const kind = dropzone.dataset.statementsDrop;
    const input = kind
      ? dropzone.querySelector<HTMLInputElement>(
        `[data-statements-file="${kind}"]`
      )
      : null;
    if (!file || !input) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function onChange(event: Event): void {
    const input = (event.target as HTMLElement | null)
      ?.closest<HTMLInputElement>("[data-statements-file]");
    if (!input || !options.host.contains(input)) return;
    syncStatementSelection();
  }

  function showDiagnosisReport(report: DiagnosisReport): void {
    if (disposed
      || (!options.demo && parseAgentsHash(windowPort.location.hash) === null)) return;
    lastReport = report;
    persistSession();
    if (options.demo) {
      demoRoute = { view: "report" };
    } else if (windowPort.location.hash !== "#growth/agents/report") {
      windowPort.history.pushState(null, "", "#growth/agents/report");
    }
    mountView(renderDiagnosisReport(report, {
      sourceLabel,
      warnings: importWarnings
    }));
  }

  async function handleReport(): Promise<void> {
    if (!options.demo && !activeInput) return;
    const generation = beginOperation();
    options.host.innerHTML = renderAgentConclusion("<p>正在生成经营诊断报告…</p>");
    try {
      const report = options.demo
        ? demoDiagnosisReport()
        : await api.diagnose(activeInput!);
      if (!canCommitOperation(generation)) return;
      showDiagnosisReport(report);
    } catch (error) {
      if (!canCommitOperation(generation)) return;
      options.host.innerHTML = renderAgentConclusion(
        `<p class="growth-error">生成失败：${escapeHtml(
          error instanceof Error ? error.message : String(error)
        )}</p>`
      );
    }
  }

  async function fileToSheets(file: File): Promise<readonly StatementSheet[]> {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    if (workbook.SheetNames.length === 0) {
      throw new Error(`无法读取文件：${file.name}`);
    }
    return Object.freeze(workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as (
        readonly (string | number | null)[]
      )[];
      return Object.freeze({
        name,
        rows: Object.freeze(rows)
      });
    }));
  }

  async function handleStatementsDiagnose(): Promise<void> {
    if (options.demo) {
      options.host.innerHTML = renderAgentConclusion(
        '<p class="growth-conflict">演示环境使用内置示例数据；登录真实环境后即可上传报表生成诊断。</p>'
      );
      return;
    }
    const generation = beginOperation();
    const balanceInput = options.host.querySelector<HTMLInputElement>(
      '[data-statements-file="balance"]'
    );
    const incomeInput = options.host.querySelector<HTMLInputElement>(
      '[data-statements-file="income"]'
    );
    const balanceFile = balanceInput?.files?.[0];
    const incomeFile = incomeInput?.files?.[0];
    if (!balanceFile || !incomeFile) {
      setStatementFeedback("请先选择资产负债表和利润表各一份", true);
      return;
    }
    options.host.innerHTML = renderAgentConclusion(
      "<p>正在解析报表并生成诊断报告…</p>"
    );
    try {
      const [balanceSheets, incomeSheets] = await Promise.all([
        fileToSheets(balanceFile),
        fileToSheets(incomeFile)
      ]);
      const result = await api.importStatements([
        ...balanceSheets,
        ...incomeSheets
      ]);
      if (!canCommitOperation(generation)) return;
      importedCompanies = result.companies;
      if (result.companies.length === 1 && result.companies[0].input) {
        showCompanyReport(result.companies[0]);
      } else if (result.companies.length === 0) {
        options.host.innerHTML = renderAgentConclusion(
          '<p class="growth-error">未识别到有效报表，请确认上传的是标准资产负债表与利润表</p>'
        );
      } else {
        mountView(renderCompanyPicker(result.companies));
      }
    } catch (error) {
      if (!canCommitOperation(generation)) return;
      options.host.innerHTML = renderAgentConclusion(
        `<p class="growth-error">解析失败：${escapeHtml(
          error instanceof Error ? error.message : String(error)
        )}</p>`
      );
    }
  }

  function showCompanyReport(company: ParsedCompanyResult): void {
    if (!company.input || !company.report) {
      options.host.innerHTML = renderAgentConclusion(
        `<p class="growth-error">${escapeHtml(company.error ?? "该公司无法生成诊断")}</p>`
      );
      return;
    }
    sourceLabel = `${company.companyName} · ${company.period}`;
    importWarnings = company.warnings;
    activeInput = company.input;
    showDiagnosisReport(company.report);
  }

  async function handleAsk(agentId: string, question: string): Promise<void> {
    if (!options.demo && !activeInput) return;
    const output = options.host.querySelector<HTMLElement>("[data-agents-output]");
    if (!output) return;
    output.innerHTML = '<div class="agent-answer-loading">正在分析…</div>';
    try {
      if (agentId === "cfo") {
        const report = options.demo
          ? demoDiagnosisReport()
          : await api.diagnose(activeInput!);
        output.innerHTML = renderAnalysisAnswer(question, {
          conclusionHtml: `<p>${escapeHtml(report.summary)}</p>`,
          evidenceHtml: `<ul>${report.issues.map((issue) =>
            `<li>${escapeHtml(issue.title)}</li>`).join("")}</ul>`,
          actionsHtml: `<ol>${report.actionPlan90Days.map((item) =>
            `<li>第 ${item.month} 月：${escapeHtml(item.action)}</li>`).join("")}</ol>
            <a href="#growth/agents/report" class="agents-back">查看完整报告</a>`
        });
        return;
      }
      const result = options.demo
        ? demoAnalysisResult() as AnalysisResult
        : await api.analyze(activeInput!) as AnalysisResult;
      output.innerHTML = renderAnalysisAnswer(
        question,
        summarizeAnalysis(agentId, result)
      );
    } catch (error) {
      output.innerHTML =
        `<p class="growth-error">分析失败：${escapeHtml(
          error instanceof Error ? error.message : String(error)
        )}</p>`;
    }
  }

  function onClick(event: MouseEvent): void {
    if (disposed) return;
    const rawTarget = event.target as HTMLElement | null;
    if (options.demo && rawTarget) {
      const demoLink = rawTarget.closest<HTMLElement>("[data-agents-demo-link]");
      if (demoLink?.dataset.agentsDemoLink) {
        event.preventDefault();
        demoRoute = { view: "detail", agentId: demoLink.dataset.agentsDemoLink };
        renderView();
        return;
      }
      const backLink = rawTarget.closest<HTMLElement>("a.agents-back");
      if (backLink) {
        event.preventDefault();
        demoRoute = backLink.getAttribute("href")?.includes("agents/report")
          ? { view: "report" }
          : { view: "overview" };
        renderView();
        return;
      }
    }
    if (rawTarget) {
      const questionExample = rawTarget.closest<HTMLElement>(
        "[data-agent-question]"
      );
      if (questionExample && options.host.contains(questionExample)) {
        const input = options.host.querySelector<HTMLInputElement>(
          "[data-agent-question-input]"
        );
        if (input) {
          input.value = questionExample.dataset.agentQuestion ?? "";
          input.focus();
        }
        return;
      }
    }
    const target = (event.target as HTMLElement | null)
      ?.closest<HTMLElement>("[data-agents-action], [data-agents-form]");
    if (!target || !options.host.contains(target)) return;
    const action = target.dataset.agentsAction;
    if (action === "generate-report" || action === "open-report") {
      void handleReport();
      return;
    }
    if (action === "statements-diagnose") {
      void handleStatementsDiagnose();
      return;
    }
    if (action === "sample-report") {
      if (!options.demo) return;
      const generation = beginOperation();
      sourceLabel = "示例数据";
      importWarnings = [];
      const sample = sampleBusinessReport();
      void (async () => {
        options.host.innerHTML = renderAgentConclusion(
          "<p>正在用示例数据生成诊断报告…</p>"
        );
        try {
          const report = await api.diagnose(sample);
          if (!canCommitOperation(generation)) return;
          showDiagnosisReport(report);
        } catch (error) {
          if (!canCommitOperation(generation)) return;
          options.host.innerHTML = renderAgentConclusion(
            `<p class="growth-error">生成失败：${escapeHtml(
              error instanceof Error ? error.message : String(error)
            )}</p>`
          );
        }
      })();
      return;
    }
    if (action === "pick-company") {
      const index = Number(target.dataset.companyIndex);
      const company = importedCompanies[index];
      if (company) showCompanyReport(company);
      return;
    }
    if (action === "create-todo") {
      windowPort.dispatchEvent(new CustomEvent("goodjob:todo-create-requested", {
        detail: { source: "business-advisor" }
      }));
      return;
    }
    if (action === "open-data") {
      windowPort.location.hash = "#growth/finance";
      return;
    }
  }

  function onSubmit(event: SubmitEvent): void {
    if (disposed) return;
    const form = event.target as HTMLFormElement | null;
    if (form?.dataset?.agentsForm !== "ask") return;
    event.preventDefault();
    const route = options.demo
      ? demoRoute
      : parseAgentsHash(windowPort.location.hash);
    if (!route || route.view !== "detail") return;
    const questionInput = form.querySelector<HTMLInputElement>(
      'input[name="question"]'
    );
    const question = questionInput?.value.trim() || "请分析本期经营";
    void handleAsk(route.agentId, question);
  }

  renderView();
  options.host.addEventListener("click", onClick);
  options.host.addEventListener("submit", onSubmit);
  options.host.addEventListener("change", onChange);
  options.host.addEventListener("dragover", onStatementDragOver);
  options.host.addEventListener("dragleave", onStatementDragLeave);
  options.host.addEventListener("drop", onStatementDrop);
  windowPort.addEventListener("hashchange", onHashChange);

  return Object.freeze({
    render: renderView,
    dispose() {
      disposed = true;
      operationGeneration += 1;
      options.host.removeEventListener("click", onClick);
      options.host.removeEventListener("submit", onSubmit);
      options.host.removeEventListener("change", onChange);
      options.host.removeEventListener("dragover", onStatementDragOver);
      options.host.removeEventListener("dragleave", onStatementDragLeave);
      options.host.removeEventListener("drop", onStatementDrop);
      windowPort.removeEventListener("hashchange", onHashChange);
    }
  });
}
