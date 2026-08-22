import { createAcquisitionApi } from "./runtime-api";
import type {
  AcquisitionImportOperation,
  AcquisitionTaskDetail
} from "./runtime-api";
import {
  importItemStatus,
  importOperationStatus,
  importOutcomeFromOperation,
  publicDouyinUrl,
  publicUrlsCsv
} from "./runtime-import";
import {
  buildAcquisitionOverviewModel,
  type AcquisitionMetricModel,
  type AcquisitionOverviewModel,
  type AcquisitionRunStatus
} from "./runtime-model";
import {
  renderPublicDouyinImportPanel,
  renderRealTaskRows,
  type PublicDouyinImportPanelState
} from "./runtime-presenter";
import { acquisitionCandidateDetailRequest } from "./detail-center-entry";

type AcquisitionMode = "demo" | "real";
type RuntimeState = "loading" | "ready" | "error" | "unauthorized";

interface ModeChangedDetail {
  mode: AcquisitionMode;
  phase: "selected" | "loaded" | "error";
}

interface TaskSelectedDetail {
  planId?: unknown;
}

const FLOW_CARD_IDS = [
  "replicaFlowCardDouyin",
  "replicaFlowCardKuaishou",
  "replicaFlowCardXhs",
  "replicaFlowCardWeibo",
  "replicaFlowCardWechat"
] as const;

const METRIC_DESCRIPTIONS = [
  "后端返回的真实任务总数",
  "排队、运行或正在取消的任务",
  "成功、无结果或部分成功的任务",
  "失败、暂停、取消或预算耗尽的任务"
] as const;

const TERMINAL_IMPORT_STATUSES = new Set([
  "succeeded",
  "partial_success",
  "failed"
]);

const ACTIVE_RUN_STATUSES = new Set<AcquisitionRunStatus>([
  "queued",
  "running",
  "pause_requested",
  "cancel_requested"
]);
const OVERVIEW_POLL_BASE_DELAY_MS = 2_000;
const OVERVIEW_POLL_MAX_DELAY_MS = 30_000;

let started = false;
let waitingForDom = false;

export function snapshotDisabledStates(
  elements: Array<{ disabled: boolean } | null>
): () => void {
  const snapshots = elements.flatMap((element) => (
    element ? [{ element, disabled: element.disabled }] : []
  ));
  return () => {
    snapshots.forEach(({ element, disabled }) => {
      element.disabled = disabled;
    });
  };
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setText(id: string, value: string | number): void {
  const element = byId(id);
  if (element) element.textContent = String(value);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "未知错误";
  return (message || "未知错误").slice(0, 300);
}

function idempotencyKey(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${random}`;
}

function initialPublicImportState(): PublicDouyinImportPanelState {
  return {
    visible: false,
    urlText: "",
    status: "idle",
    message: null,
    results: [],
    outcome: null
  };
}

function isUnauthorizedMessage(message: string): boolean {
  return /(?:^|\b)401(?:\b|$)|unauthori[sz]ed|未登录|请先登录|登录已失效/i.test(message);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character] ?? character);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded} 秒`;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder === 0 ? `${minutes} 分钟` : `${minutes} 分 ${remainder} 秒`;
}

function defaultMode(): AcquisitionMode {
  const noConfiguredBackend = import.meta.env.DEV
    && !import.meta.env.VITE_API_TARGET?.trim();
  return noConfiguredBackend ? "demo" : "real";
}

function initialiseRuntime(): void {
  const shell = document.querySelector<HTMLElement>(".replica-shell");
  if (!shell) return;
  const runtimeShell = shell;

  const api = createAcquisitionApi();
  const restoreActions: Array<() => void> = [];
  let mode: AcquisitionMode = defaultMode();
  let overviewRequestVersion = 0;
  let detailRequestVersion = 0;
  let importRequestVersion = 0;
  let publicImport = initialPublicImportState();
  let urlImportOperation: Promise<void> | null = null;
  let overviewPollTimer: number | null = null;
  let overviewPollAttempt = 0;
  let lastOverviewHadActiveRuns = false;

  const rememberText = (id: string): void => {
    const element = byId(id);
    if (!element) return;
    const text = element.textContent;
    restoreActions.push(() => {
      element.textContent = text;
    });
  };

  const rememberHtml = (id: string): void => {
    const element = byId(id);
    if (!element) return;
    const html = element.innerHTML;
    restoreActions.push(() => {
      element.innerHTML = html;
    });
  };

  const rememberHidden = (element: HTMLElement | null): void => {
    if (!element) return;
    const hidden = element.hidden;
    restoreActions.push(() => {
      element.hidden = hidden;
    });
  };

  const rememberClass = (element: HTMLElement | null): void => {
    if (!element) return;
    const className = element.className;
    restoreActions.push(() => {
      element.className = className;
    });
  };

  const rememberAttribute = (
    element: HTMLElement | null,
    attribute: string
  ): void => {
    if (!element) return;
    const value = element.getAttribute(attribute);
    restoreActions.push(() => {
      if (value === null) element.removeAttribute(attribute);
      else element.setAttribute(attribute, value);
    });
  };

  const textSnapshotIds = [
    "replicaAcquisitionModeBadge",
    "replicaAcquisitionRuntimeStatus",
    "replicaRealTaskCount",
    "replicaScopeAllLabel",
    "replicaScopeAgentLabel",
    "replicaScopeScriptLabel",
    "replicaStatusLabel",
    "replicaInspectorTitle",
    "replicaDetailId",
    "replicaDetailNameText",
    "replicaDetailSummary",
    "replicaDetailOwner",
    "replicaDetailProject",
    "replicaDetailDue",
    "replicaDetailStatus",
    "replicaDetailPriority",
    "replicaDetailPriorityText",
    "replicaDetailOwnerLabel",
    "replicaDetailProjectLabel",
    "replicaDetailDueLabel",
    "replicaDetailStatusLabel",
    "replicaDetailPriorityLabel",
    "replicaDetailTagsLabel",
    "replicaAdviceTitle",
    "replicaAdvicePrimary",
    "replicaAdviceSecondary",
    "replicaAdviceButton",
    "replicaEditTaskLabel",
    "replicaCompleteTaskLabel",
    "replicaRunEvidence",
    "replicaRunRequests",
    "replicaRunResults",
    "replicaRunDuration"
  ];
  for (let index = 0; index < 4; index += 1) {
    textSnapshotIds.push(
      `replicaMetricLabel${index}`,
      `replicaMetricUnit${index}`
    );
    textSnapshotIds.push(
      index === 2 && byId("replicaCompletedCount")
        ? "replicaCompletedCount"
        : `replicaMetricValue${index}`
    );
  }
  textSnapshotIds.forEach(rememberText);
  [
    "replicaRealTaskList",
    "replicaDetailTags",
    "replicaMetricChange0",
    "replicaMetricChange1",
    "replicaMetricChange2",
    "replicaMetricChange3"
  ].forEach(rememberHtml);

  const modeBadge = byId("replicaAcquisitionModeBadge");
  const runtimeStatus = byId("replicaAcquisitionRuntimeStatus");
  const realTaskGroup = byId("replicaRealTaskGroup");
  const realTaskList = byId("replicaRealTaskList");
  const runMetrics = byId("replicaRunMetrics");
  const demoTimeline = byId("replicaDemoTimeline");
  const publicImportHost = document.createElement("div");
  publicImportHost.id = "replicaPublicDouyinImportHost";
  publicImportHost.hidden = true;
  demoTimeline?.before(publicImportHost);
  const demoTaskGroups = Array.from(
    document.querySelectorAll<HTMLElement>("[data-acquisition-demo-task-group]")
  );
  const modeButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-acquisition-mode]")
  );
  const flowCards = FLOW_CARD_IDS
    .map((id) => byId<HTMLButtonElement>(id))
    .filter((card): card is HTMLButtonElement => card !== null);
  const detailActionButtons = [
    byId<HTMLButtonElement>("replicaEditTask"),
    byId<HTMLButtonElement>("replicaCompleteTask")
  ];

  rememberHidden(runtimeStatus);
  rememberHidden(realTaskGroup);
  rememberHidden(runMetrics);
  rememberHidden(demoTimeline);
  demoTaskGroups.forEach(rememberHidden);
  rememberClass(modeBadge);
  rememberClass(runtimeStatus);
  rememberAttribute(runtimeStatus, "data-state");
  rememberAttribute(realTaskList, "aria-busy");
  restoreActions.push(snapshotDisabledStates(detailActionButtons));
  modeButtons.forEach((button) => {
    rememberClass(button);
    rememberAttribute(button, "aria-selected");
    rememberAttribute(button, "aria-pressed");
  });
  flowCards.forEach((card) => {
    rememberClass(card);
    rememberAttribute(card, "aria-disabled");
    rememberAttribute(card, "data-acquisition-pending");
    rememberAttribute(card, "data-flow-state");
    rememberAttribute(card, "data-flow-task-id");
    const count = card.querySelector<HTMLElement>(".replica-flow-card-count strong");
    const unit = card.querySelector<HTMLElement>(".replica-flow-card-count small");
    const state = card.querySelector<HTMLElement>(".replica-flow-card-state");
    [count, unit, state].forEach((element) => {
      if (!element) return;
      const text = element.textContent;
      restoreActions.push(() => {
        element.textContent = text;
      });
    });
  });

  const hadInitialMode = Object.prototype.hasOwnProperty.call(
    runtimeShell.dataset,
    "acquisitionMode"
  );
  const initialMode = runtimeShell.dataset.acquisitionMode;
  restoreActions.push(() => {
    if (hadInitialMode) runtimeShell.dataset.acquisitionMode = initialMode ?? "";
    else delete runtimeShell.dataset.acquisitionMode;
  });

  function restoreInitialDom(): void {
    for (const restore of restoreActions) restore();
  }

  function dispatchModeChanged(phase: ModeChangedDetail["phase"]): void {
    document.dispatchEvent(new CustomEvent<ModeChangedDetail>(
      "goodjob:acquisition-mode-changed",
      { detail: { mode, phase } }
    ));
  }

  function updateModeButtons(): void {
    modeButtons.forEach((button) => {
      const active = button.dataset.acquisitionMode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function setRuntimeStatus(text: string, state: RuntimeState): void {
    if (!runtimeStatus) return;
    runtimeStatus.hidden = false;
    runtimeStatus.dataset.state = state;
    runtimeStatus.classList.toggle("is-loading", state === "loading");
    runtimeStatus.classList.toggle(
      "is-error",
      state === "error" || state === "unauthorized"
    );
    runtimeStatus.textContent = text;
  }

  function renderPublicImport(): void {
    publicImport.visible = mode === "real";
    publicImportHost.hidden = mode !== "real";
    publicImportHost.innerHTML = renderPublicDouyinImportPanel(publicImport);
  }

  function setRunMetricValues(
    evidence: string | number,
    requests: string | number,
    results: string | number,
    duration: string
  ): void {
    if (runMetrics) runMetrics.hidden = false;
    setText("replicaRunEvidence", evidence);
    setText("replicaRunRequests", requests);
    setText("replicaRunResults", results);
    setText("replicaRunDuration", duration);
  }

  function setMetricValue(index: number, value: string | number): void {
    const element = byId(`replicaMetricValue${index}`);
    if (!element) return;
    const legacyCompleted = element.querySelector<HTMLElement>(
      "#replicaCompletedCount"
    );
    if (legacyCompleted) legacyCompleted.textContent = String(value);
    else element.textContent = String(value);
  }

  function setRealMetrics(metrics?: AcquisitionMetricModel[]): void {
    for (let index = 0; index < 4; index += 1) {
      const metric = metrics?.[index];
      setText("replicaMetricLabel" + index, metric?.label ?? [
        "真实任务",
        "运行中",
        "已完成",
        "需关注"
      ][index] ?? "真实指标");
      setMetricValue(index, metric?.value ?? "—");
      setText("replicaMetricUnit" + index, "项");
      setText(
        "replicaMetricChange" + index,
        metrics ? METRIC_DESCRIPTIONS[index] : "正在读取真实接口"
      );
    }
  }

  function setRealInspectorShell(statusText: string): void {
    setText("replicaScopeAllLabel", "全部真实任务");
    setText("replicaScopeAgentLabel", "智能体执行");
    setText("replicaScopeScriptLabel", "工作流任务");
    setText("replicaStatusLabel", "真实状态");
    setText("replicaInspectorTitle", "抖音真实获客任务详情");
    setText("replicaDetailOwnerLabel", "执行主体");
    setText("replicaDetailProjectLabel", "真实平台");
    setText("replicaDetailDueLabel", "更新时间");
    setText("replicaDetailStatusLabel", "运行状态");
    setText("replicaDetailPriorityLabel", "AI 研判");
    setText("replicaDetailTagsLabel", "发现方式");
    setText("replicaAdviceTitle", "AI 研判提示");
    setText("replicaAdvicePrimary", "公开证据不等于意向客户，需经 AI 评分和人工审核。");
    setText("replicaAdviceSecondary", "真实模式只展示后端已保存的任务、证据和运行消耗。");
    setText("replicaAdviceButton", "查看研判说明");
    setText("replicaEditTaskLabel", "查看计划详情");
    setText("replicaCompleteTaskLabel", "AI 候选研判");
    const planButton = byId<HTMLButtonElement>("replicaEditTask");
    const candidateButton = byId<HTMLButtonElement>("replicaCompleteTask");
    if (planButton) planButton.disabled = true;
    if (candidateButton) candidateButton.disabled = true;

    setText("replicaDetailId", "--");
    setText("replicaDetailNameText", "尚未选择真实抖音任务");
    setText("replicaDetailSummary", statusText);
    setText("replicaDetailOwner", "真实运行服务");
    setText("replicaDetailProject", "抖音");
    setText("replicaDetailDue", "—");
    setText("replicaDetailStatus", statusText);
    setText("replicaDetailPriority", "真实任务");
    setText("replicaDetailPriorityText", "待研判");
    const tags = byId("replicaDetailTags");
    if (tags) tags.innerHTML = "<span>等待真实数据</span>";
  }

  function enforceRealVisibility(): void {
    if (mode !== "real") return;
    demoTaskGroups.forEach((group) => {
      if (!group.hidden) group.hidden = true;
    });
    if (demoTimeline && !demoTimeline.hidden) demoTimeline.hidden = true;
    if (realTaskGroup?.hidden) realTaskGroup.hidden = false;
    if (runMetrics?.hidden) runMetrics.hidden = false;
    if (publicImportHost.hidden) publicImportHost.hidden = false;
  }

  function renderTaskListState(
    icon: string,
    title: string,
    description: string,
    error = false
  ): void {
    if (!realTaskList) return;
    realTaskList.innerHTML = `
      <div class="replica-real-empty${error ? " is-error" : ""}" role="status">
        <i class="ph ${escapeHtml(icon)}" aria-hidden="true"></i>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(description)}</span>
      </div>
    `;
  }

  function setFlowCardRealState(
    taskCount: number | "loading" | "error",
    firstTaskId = ""
  ): void {
    flowCards.forEach((card) => {
      const isDouyin = card.id === "replicaFlowCardDouyin";
      const count = card.querySelector<HTMLElement>(".replica-flow-card-count strong");
      const unit = card.querySelector<HTMLElement>(".replica-flow-card-count small");
      const state = card.querySelector<HTMLElement>(".replica-flow-card-state");

      if (isDouyin) {
        card.classList.remove("is-unavailable");
        card.removeAttribute("aria-disabled");
        card.removeAttribute("data-acquisition-pending");
        card.dataset.flowTaskId = firstTaskId;
        card.dataset.flowState = taskCount === "loading"
          ? "正在连接"
          : taskCount === "error"
            ? "接口异常"
            : taskCount > 0 ? "真实任务" : "暂无任务";
        if (count) {
          count.textContent = typeof taskCount === "number"
            ? String(taskCount)
            : "—";
        }
        if (unit) unit.textContent = "项任务";
        if (state) state.textContent = card.dataset.flowState;
        return;
      }

      card.classList.add("is-unavailable");
      card.setAttribute("aria-disabled", "true");
      card.dataset.acquisitionPending = "true";
      card.dataset.flowTaskId = "";
      card.dataset.flowState = "待接入";
      if (count) count.textContent = "—";
      if (unit) unit.textContent = "待接入";
      if (state) state.textContent = "待接入";
    });
  }

  function clearOverviewPollTimer(): void {
    if (overviewPollTimer === null) return;
    window.clearTimeout(overviewPollTimer);
    overviewPollTimer = null;
  }

  function stopOverviewPolling(): void {
    clearOverviewPollTimer();
    overviewPollAttempt = 0;
    lastOverviewHadActiveRuns = false;
  }

  function scheduleOverviewPoll(active: boolean): void {
    clearOverviewPollTimer();
    lastOverviewHadActiveRuns = active;
    if (!active
      || mode !== "real"
      || !document.body.classList.contains("is-authenticated")) {
      if (!active) overviewPollAttempt = 0;
      return;
    }
    const delay = Math.min(
      OVERVIEW_POLL_BASE_DELAY_MS * (2 ** overviewPollAttempt),
      OVERVIEW_POLL_MAX_DELAY_MS
    );
    overviewPollTimer = window.setTimeout(() => {
      overviewPollTimer = null;
      overviewPollAttempt += 1;
      void refreshOverview({ background: true, resetPollAttempt: false });
    }, delay);
  }

  function renderOverview(model: AcquisitionOverviewModel): void {
    const totalTaskCount = model.metrics[0]?.value ?? model.tasks.length;
    setRealMetrics(model.metrics);
    setText("replicaRealTaskCount", model.tasks.length);
    if (realTaskList) {
      realTaskList.setAttribute("aria-busy", "false");
      realTaskList.innerHTML = renderRealTaskRows(model.tasks);
    }
    setFlowCardRealState(totalTaskCount, model.tasks[0]?.id ?? "");
    setRuntimeStatus(
      `已连接真实接口 · ${totalTaskCount} 项抖音任务 · ${formatTimestamp(model.generatedAt)} 更新`,
      "ready"
    );
    if (model.tasks.length === 0) {
      setRealInspectorShell("后端当前没有抖音获客任务。");
      setRunMetricValues(0, 0, 0, "0 秒");
    }
    scheduleOverviewPoll(model.tasks.some((task) =>
      task.status !== null && ACTIVE_RUN_STATUSES.has(task.status)
    ));
  }

  function showLoadingState(): void {
    if (modeBadge) {
      modeBadge.textContent = "真实运行";
      modeBadge.classList.add("is-real");
    }
    setRealMetrics();
    setText("replicaRealTaskCount", "—");
    setRuntimeStatus("正在读取真实抖音获客任务…", "loading");
    setRealInspectorShell("正在读取真实任务…");
    setRunMetricValues("—", "—", "—", "—");
    setFlowCardRealState("loading");
    if (realTaskList) realTaskList.setAttribute("aria-busy", "true");
    renderTaskListState(
      "ph-spinner-gap",
      "正在读取真实任务",
      "系统正在连接获客后端，不会用演示数据替代。"
    );
  }

  function showErrorState(error: unknown): void {
    const message = safeErrorMessage(error);
    const unauthorized = isUnauthorizedMessage(message);
    const state: RuntimeState = unauthorized ? "unauthorized" : "error";
    const title = unauthorized ? "请先登录真实账号" : "真实接口加载失败";
    const description = unauthorized
      ? "登录后系统会自动重新读取抖音获客任务。"
      : message;
    if (modeBadge) {
      modeBadge.textContent = unauthorized ? "真实运行 · 待登录" : "真实运行 · 异常";
      modeBadge.classList.add("is-real");
    }
    setRealMetrics();
    setText("replicaRealTaskCount", "—");
    setRuntimeStatus(
      unauthorized ? "请先登录真实账号后查看抖音获客任务。" : `真实接口加载失败：${message}`,
      state
    );
    setRealInspectorShell(description);
    setRunMetricValues("—", "—", "—", "—");
    setFlowCardRealState("error");
    if (realTaskList) realTaskList.setAttribute("aria-busy", "false");
    renderTaskListState(
      unauthorized ? "ph-lock-key" : "ph-warning-circle",
      title,
      description,
      true
    );
  }

  async function refreshOverview(options: {
    background?: boolean;
    resetPollAttempt?: boolean;
  } = {}): Promise<void> {
    if (mode !== "real") return;
    clearOverviewPollTimer();
    if (options.resetPollAttempt !== false) overviewPollAttempt = 0;
    const requestVersion = ++overviewRequestVersion;
    if (options.background !== true) showLoadingState();
    try {
      const overview = await api.getOverview();
      if (mode !== "real" || requestVersion !== overviewRequestVersion) return;
      renderOverview(buildAcquisitionOverviewModel(overview));
      dispatchModeChanged("loaded");
      enforceRealVisibility();
    } catch (error) {
      if (mode !== "real" || requestVersion !== overviewRequestVersion) return;
      showErrorState(error);
      dispatchModeChanged("error");
      enforceRealVisibility();
      const message = safeErrorMessage(error);
      if (lastOverviewHadActiveRuns && !isUnauthorizedMessage(message)) {
        scheduleOverviewPoll(true);
      } else {
        stopOverviewPolling();
      }
    }
  }

  async function waitForImportTerminal(
    operation: AcquisitionImportOperation,
    requestVersion: number
  ): Promise<AcquisitionImportOperation | null> {
    let current = operation;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (mode !== "real" || requestVersion !== importRequestVersion) {
        return null;
      }
      if (TERMINAL_IMPORT_STATUSES.has(importOperationStatus(current) ?? "")) {
        return current;
      }
      await new Promise((resolve) => window.setTimeout(
        resolve,
        attempt < 4 ? 700 : 1_500
      ));
      current = await api.getImportOperation(current.id);
      const operationId = typeof current.id === "string" ? current.id : null;
      publicImport = {
        ...publicImport,
        status: "uploading",
        results: publicImport.results.map((item) =>
          item.status === "failed"
            ? item
            : {
                ...item,
                status: importItemStatus(current),
                operationId
              }),
        message: "导入任务处理中，主体仍待核验"
      };
      renderPublicImport();
    }
    return current;
  }

  async function submitPublicImportUrls(): Promise<void> {
    if (urlImportOperation) return urlImportOperation;
    const rawRows = publicImport.urlText
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
    const uniqueRows = [...new Set(rawRows)];
    if (uniqueRows.length === 0) {
      publicImport = {
        ...publicImport,
        status: "failed",
        message: "请至少粘贴一个公开抖音链接",
        results: [],
        outcome: null
      };
      renderPublicImport();
      return;
    }
    const checked = uniqueRows.map((sourceUrl) => ({
      sourceUrl,
      result: publicDouyinUrl(sourceUrl)
    }));
    const validUrls = checked.flatMap(({ result }) =>
      result.ok ? [result.value] : []);
    const initialResults = checked.map(({ sourceUrl, result }) => ({
      sourceUrl: result.ok ? result.value : sourceUrl,
      status: result.ok ? "queued" as const : "failed" as const,
      operationId: null,
      errorMessage: result.ok ? null : result.message
    }));
    if (validUrls.length === 0) {
      publicImport = {
        ...publicImport,
        status: "failed",
        results: initialResults,
        outcome: null,
        message: "没有可提交的公开抖音链接"
      };
      renderPublicImport();
      return;
    }
    publicImport = {
      ...publicImport,
      status: "uploading",
      results: initialResults,
      outcome: null,
      message: "正在形成用户提交证据，主体仍待核验"
    };
    renderPublicImport();
    const requestVersion = ++importRequestVersion;
    const operation = (async () => {
      try {
        const created = await api.createImportOperation({
          fileName: `douyin-public-urls-${Date.now()}.csv`,
          mediaType: "text/csv",
          content: publicUrlsCsv(validUrls),
          subjectChannel: "individual",
          mapping: {
            sourceTitle: "标题",
            sourceSnippet: "摘要",
            sourcePlatform: "平台",
            sourceUrl: "链接"
          }
        }, idempotencyKey("goodjob-douyin-public-url-import"));
        const terminal = await waitForImportTerminal(created, requestVersion);
        if (!terminal || mode !== "real" || requestVersion !== importRequestVersion) return;
        const operationId = typeof terminal.id === "string" ? terminal.id : null;
        const outcome = importOutcomeFromOperation(terminal);
        const errorsByUrl = new Map<string, string>();
        for (const error of outcome.rowErrors) {
          const sourceUrl = validUrls[error.rowNumber - 2];
          if (sourceUrl) errorsByUrl.set(sourceUrl, error.message);
        }
        const terminalStatus = importOperationStatus(terminal);
        publicImport = {
          ...publicImport,
          status: terminalStatus === "failed"
            ? "failed"
            : initialResults.some((item) => item.status === "failed")
              || terminalStatus === "partial_success"
              ? "partial"
              : "completed",
          results: initialResults.map((item) =>
            item.status === "failed"
              ? item
              : errorsByUrl.has(item.sourceUrl)
                ? {
                    ...item,
                    status: "failed",
                    operationId,
                    errorMessage: errorsByUrl.get(item.sourceUrl) ?? null
                  }
                : {
                    ...item,
                    status: importItemStatus(terminal),
                    operationId,
                    errorMessage: terminalStatus === "failed"
                      ? "导入任务处理失败"
                      : null
                  }),
          outcome,
          message: terminalStatus === "failed"
            ? "公开链接导入任务处理失败"
            : "导入完成，已形成用户提交证据；主体仍待核验"
        };
        renderPublicImport();
        document.dispatchEvent(new CustomEvent("goodjob:acquisition-refresh-requested"));
      } catch (error) {
        if (mode !== "real" || requestVersion !== importRequestVersion) return;
        publicImport = {
          ...publicImport,
          status: "failed",
          results: initialResults.map((item) =>
            item.status === "failed"
              ? item
              : {
                  ...item,
                  status: "failed",
                  errorMessage: safeErrorMessage(error)
                }),
          outcome: null,
          message: "公开链接导入失败"
        };
        renderPublicImport();
        throw error;
      }
    })();
    urlImportOperation = operation;
    const clear = () => {
      if (urlImportOperation === operation) urlImportOperation = null;
    };
    void operation.then(clear, clear);
    return operation;
  }

  function renderRunMetrics(detail: AcquisitionTaskDetail): void {
    const latestRun = detail.latestRun;
    if (!latestRun) {
      setRunMetricValues(0, 0, 0, "0 秒");
      setRuntimeStatus(
        `真实任务「${detail.task.name}」已建立，但尚未运行。`,
        "ready"
      );
      return;
    }
    setRunMetricValues(
      latestRun.evidenceCount,
      latestRun.consumedBudget.requests,
      latestRun.consumedBudget.results,
      formatDuration(latestRun.consumedBudget.durationSeconds)
    );
    setRuntimeStatus(
      `已读取「${detail.task.name}」的真实运行详情 · ${latestRun.evidenceCount} 条公开证据`,
      "ready"
    );
  }

  async function loadTaskDetail(planId: string): Promise<void> {
    if (mode !== "real" || !planId) return;
    const requestVersion = ++detailRequestVersion;
    setRunMetricValues("—", "—", "—", "—");
    setRuntimeStatus("正在读取真实任务运行详情…", "loading");
    try {
      const detail = await api.getTask(planId);
      if (mode !== "real" || requestVersion !== detailRequestVersion) return;
      renderRunMetrics(detail);
    } catch (error) {
      if (mode !== "real" || requestVersion !== detailRequestVersion) return;
      const message = safeErrorMessage(error);
      setRunMetricValues("—", "—", "—", "—");
      setRuntimeStatus(
        isUnauthorizedMessage(message)
          ? "请先登录真实账号后查看任务运行详情。"
          : `真实任务详情加载失败：${message}`,
        isUnauthorizedMessage(message) ? "unauthorized" : "error"
      );
    }
  }

  function applyRealMode(): void {
    restoreInitialDom();
    runtimeShell.dataset.acquisitionMode = "real";
    updateModeButtons();
    demoTaskGroups.forEach((group) => {
      group.hidden = true;
    });
    if (demoTimeline) demoTimeline.hidden = true;
    if (realTaskGroup) realTaskGroup.hidden = false;
    if (runMetrics) runMetrics.hidden = false;
    dispatchModeChanged("selected");
    renderPublicImport();
    enforceRealVisibility();
    void refreshOverview();
  }

  function applyDemoMode(): void {
    stopOverviewPolling();
    overviewRequestVersion += 1;
    detailRequestVersion += 1;
    importRequestVersion += 1;
    restoreInitialDom();
    runtimeShell.dataset.acquisitionMode = "demo";
    updateModeButtons();
    publicImport = { ...publicImport, visible: false };
    renderPublicImport();
    dispatchModeChanged("selected");
  }

  function setMode(nextMode: AcquisitionMode): void {
    mode = nextMode;
    if (mode === "real") applyRealMode();
    else applyDemoMode();
  }

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const selected = button.dataset.acquisitionMode;
      if (selected === "demo" || selected === "real") setMode(selected);
    });
  });

  document.addEventListener("goodjob:acquisition-task-selected", (event) => {
    const planId = (event as CustomEvent<TaskSelectedDetail>).detail?.planId;
    if (typeof planId === "string" && planId.trim()) {
      void loadTaskDetail(planId.trim());
    }
  });

  document.addEventListener("goodjob:acquisition-refresh-requested", () => {
    void refreshOverview();
  });

  publicImportHost.addEventListener("input", (event) => {
    const target = event.target as HTMLTextAreaElement | null;
    if (!target?.matches("[data-acquisition-import-url-input]")) return;
    publicImport = {
      ...publicImport,
      urlText: target.value,
      status: publicImport.status === "uploading" ? "uploading" : "idle",
      message: publicImport.status === "uploading" ? publicImport.message : null
    };
    const submit = publicImportHost.querySelector<HTMLButtonElement>(
      "[data-acquisition-import-action=\"submit-urls\"]"
    );
    if (submit) submit.disabled = !target.value.trim()
      || publicImport.status === "uploading";
  });

  publicImportHost.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-acquisition-import-action]"
    );
    if (!target || !publicImportHost.contains(target)) return;
    const action = target.dataset.acquisitionImportAction;
    if (action === "submit-urls") {
      const input = publicImportHost.querySelector<HTMLTextAreaElement>(
        "[data-acquisition-import-url-input]"
      );
      publicImport = { ...publicImport, urlText: input?.value ?? "" };
      void submitPublicImportUrls().catch((error) => {
        document.dispatchEvent(new CustomEvent("goodjob:acquisition-notify", {
          detail: { message: safeErrorMessage(error) }
        }));
      });
      return;
    }
    if (action === "verify-identity") {
      const candidateId = target.dataset.candidateId?.trim();
      const selectedPlanId =
        document.querySelector<HTMLElement>("[data-acquisition-real-task=\"true\"].active")
          ?.dataset.acquisitionPlanId
        ?? document.querySelector<HTMLElement>("[data-acquisition-real-task=\"true\"]")
          ?.dataset.acquisitionPlanId
        ?? "";
      if (!candidateId) {
        document.dispatchEvent(new CustomEvent("goodjob:acquisition-notify", {
          detail: { message: "待核验候选 ID 缺失，请刷新后重试" }
        }));
        return;
      }
      const detail = acquisitionCandidateDetailRequest(candidateId, selectedPlanId);
      if (!detail) return;
      document.dispatchEvent(new CustomEvent(
        "goodjob:acquisition-detail-open-requested",
        {
          detail
        }
      ));
    }
  });

  let wasAuthenticated = document.body.classList.contains("is-authenticated");
  const authObserver = new MutationObserver(() => {
    const isAuthenticated = document.body.classList.contains("is-authenticated");
    if (mode === "real" && isAuthenticated && !wasAuthenticated) {
      void refreshOverview();
    }
    if (mode === "real" && !isAuthenticated && wasAuthenticated) {
      stopOverviewPolling();
      overviewRequestVersion += 1;
      detailRequestVersion += 1;
      importRequestVersion += 1;
      showErrorState(new Error("未登录"));
      enforceRealVisibility();
    }
    wasAuthenticated = isAuthenticated;
  });
  authObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"]
  });

  window.addEventListener("pagehide", stopOverviewPolling, { once: true });

  const visibilityObserver = new MutationObserver(enforceRealVisibility);
  [...demoTaskGroups, realTaskGroup, runMetrics, demoTimeline]
    .filter((element): element is HTMLElement => element !== null)
    .forEach((element) => {
      visibilityObserver.observe(element, {
        attributes: true,
        attributeFilter: ["hidden"]
      });
    });

  setMode(mode);
  renderPublicImport();
}

export function startAcquisitionRuntime(): void {
  if (started || typeof document === "undefined") return;
  if (document.readyState === "loading") {
    if (waitingForDom) return;
    waitingForDom = true;
    document.addEventListener("DOMContentLoaded", () => {
      waitingForDom = false;
      startAcquisitionRuntime();
    }, { once: true });
    return;
  }
  started = true;
  initialiseRuntime();
}
