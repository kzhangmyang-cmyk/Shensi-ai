import type {
  AcquisitionPrivateDomainHandoffStatus,
  CandidateDouyinIdentityResolutionOperation
} from "./detail-center-api";
import type { AcquisitionTaskDetail } from "./runtime-api";
import type { VisualReaderControlState } from "./visual-reader-controller";

export type AcquisitionDetailCenterMode = "plan" | "candidates";
export type AcquisitionDetailCenterStatus = "loading" | "ready" | "error";

export interface AcquisitionCandidateDetail {
  candidate: Record<string, unknown> | null;
  evidence: Array<Record<string, unknown>>;
  qualification: Record<string, unknown> | null;
  financialValue: Record<string, unknown> | null;
  battleCard: Record<string, unknown> | null;
  reviews: Array<Record<string, unknown>>;
  intelligenceOperation: Record<string, unknown> | null;
  identityResolutionOperation: CandidateDouyinIdentityResolutionOperation | null;
  privateDomainHandoff: AcquisitionPrivateDomainHandoffStatus | null;
}

export interface AcquisitionHandoffDialogState {
  open: boolean;
  busy: boolean;
  recovering?: boolean;
  runId: string;
  discoveredEventId: string;
  decisionVersion: string;
  mode: "create_new" | "link_existing";
  existingCustomerId: string;
  followUp: {
    title: string;
    dueAt: string;
    priority: "high" | "medium" | "normal";
  };
}

export interface AcquisitionIdentityVerificationState {
  status:
    | "idle"
    | "fetching"
    | "ready_to_confirm"
    | "confirming"
    | "confirmed"
    | "failed";
  profileUrl: string;
  rationale: string;
  evidenceIds: string[];
  operationId: string | null;
  message: string | null;
  error: string | null;
}

export interface AcquisitionVisualArtifactState {
  artifactId: string;
  status: "loading" | "ready" | "expired" | "error";
  objectUrl: string | null;
  message: string | null;
}

export interface AcquisitionDetailCenterState {
  mode: AcquisitionDetailCenterMode;
  status: AcquisitionDetailCenterStatus;
  detail: AcquisitionTaskDetail | null;
  selectedCandidateId: string | null;
  candidateDetail: AcquisitionCandidateDetail | null;
  message: string | null;
  error: string | null;
  loadingMoreCandidates?: boolean;
  runControlBusy?: boolean;
  runControlReason?: string;
  handoffDialog?: AcquisitionHandoffDialogState | null;
  identityVerification?: AcquisitionIdentityVerificationState | null;
  visualReader?: VisualReaderControlState;
  visualArtifact?: AcquisitionVisualArtifactState | null;
}

type DataRecord = Record<string, unknown>;

const RUN_STATUS_LABELS: Readonly<Record<string, string>> = {
  queued: "排队中",
  running: "运行中",
  pause_requested: "正在暂停",
  paused: "已暂停",
  cancel_requested: "正在取消",
  cancelled: "已取消",
  succeeded: "已完成",
  succeeded_empty: "已完成 · 无结果",
  partial_success: "部分完成",
  failed: "运行失败",
  budget_exhausted: "预算已用完"
};

const SHARD_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: "等待执行",
  queued: "排队中",
  running: "运行中",
  succeeded: "已完成",
  succeeded_empty: "已完成 · 无结果",
  partial_success: "部分完成",
  failed: "执行失败",
  cancelled: "已取消",
  budget_exhausted: "预算已用完"
};

const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "running",
  "pause_requested",
  "cancel_requested"
]);

const TERMINAL_SHARD_STATUSES = new Set([
  "cancelled",
  "succeeded",
  "succeeded_empty",
  "partial_success",
  "failed",
  "budget_exhausted"
]);

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  baidu_ai_search: "百度 AI 搜索",
  tencent_web_search: "腾讯云联网搜索",
  tavily: "Tavily 搜索",
  serper: "Serper 搜索",
  brave: "Brave 搜索",
  serpapi: "SerpApi 搜索"
};

const MODEL_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  moonshot: "Kimi（月之暗面）",
  minimax: "MiniMax",
  zhipu: "智谱 AI",
  deepseek: "DeepSeek",
  qwen: "通义千问",
  doubao: "豆包",
  hunyuan: "腾讯混元",
  qianfan: "百度千帆"
};

const HARD_GATE_LABELS: Readonly<Record<string, string>> = {
  missing_original_source: "缺少原始公开来源",
  identity_unresolved: "主体身份尚未确认",
  do_not_contact: "已进入勿扰名单",
  explicit_rejection: "客户已明确拒绝",
  non_public_or_sensitive_data: "包含非公开或敏感数据",
  stale_evidence: "证据时效已过",
  schema_invalid: "研判结构无效"
};

function isRecord(value: unknown): value is DataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): DataRecord | null {
  return isRecord(value) ? value : null;
}

function records(value: unknown): DataRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function textValue(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character] ?? character);
}

function readableLabel(
  value: unknown,
  labels: Readonly<Record<string, string>>,
  fallback = "待确认"
): string {
  if (typeof value !== "string" || !value) return fallback;
  return labels[value] ?? value;
}

function renderTextList(values: string[], emptyText = "暂未配置"): string {
  if (values.length === 0) {
    return `<span class="replica-acquisition-detail-empty-value">${emptyText}</span>`;
  }
  return `<ul class="replica-acquisition-detail-tags">${values
    .map((value) => `<li>${escapeHtml(value)}</li>`)
    .join("")}</ul>`;
}

function formatMinorAmount(currency: unknown, amountMinor: unknown): string {
  const code = textValue(currency, "CNY").toUpperCase();
  const amount = finiteNumber(amountMinor) / 100;
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

function progressValue(value: unknown): number {
  return Math.max(0, finiteNumber(value));
}

function progressPercent(current: number, limit: number): string {
  const percent = Math.min(100, Math.max(0, (current / limit) * 100));
  return String(Number(percent.toFixed(1)));
}

function renderRunProgressMetric(input: {
  metric: "requests" | "results" | "duration" | "shards";
  label: string;
  current: unknown;
  limit: unknown;
  unit: string;
  emptyWhenZero?: boolean;
}): string {
  const current = progressValue(input.current);
  const limit = progressValue(input.limit);
  const noLimitKind = input.emptyWhenZero ? "empty" : "unbounded";
  const valueText = limit > 0
    ? `${current} / ${limit} ${input.unit}`
    : input.emptyWhenZero
      ? `${current} / 0 ${input.unit}`
      : `${current} ${input.unit} · 未设置上限`;
  const indicator = limit > 0
    ? (() => {
      const percent = progressPercent(current, limit);
      return `
        <div
          class="replica-acquisition-run-progress-track"
          role="progressbar"
          aria-label="${escapeHtml(input.label)}"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="${percent}"
        >
          <i style="--run-progress-percent: ${percent}%" data-progress-percent="${percent}"></i>
        </div>
      `;
    })()
    : `
      <div class="replica-acquisition-run-progress-track is-${noLimitKind}" data-progress-limit="${noLimitKind}">
        <i aria-hidden="true"></i>
      </div>
    `;
  return `
    <article class="replica-acquisition-run-progress-item" data-run-progress-metric="${input.metric}">
      <div><span>${escapeHtml(input.label)}</span><strong>${escapeHtml(valueText)}</strong></div>
      ${indicator}
    </article>
  `;
}

function renderRunLiveIndicator(status: string): string {
  if (!ACTIVE_RUN_STATUSES.has(status)) return "";
  return `
    <span class="replica-acquisition-run-live" data-acquisition-run-live role="status" aria-live="polite">
      <i aria-hidden="true"></i>实时更新中
    </span>
  `;
}

const AUTOMATION_STEP_LABELS: Readonly<Record<string, string>> = {
  discover_video_urls: "发现公开视频",
  resolve_video_ids: "解析视频标识",
  fetch_public_comment_samples: "采集公开评论样本",
  normalize_platform_events: "规范化公开事件",
  aggregate_actor_signals: "聚合需求信号",
  qualify_candidates: "资格研判",
  refresh_run_presentation: "刷新运行投影"
};

const COMMENT_ERROR_LABELS: Readonly<Record<string, string>> = {
  public_sample_unavailable: "公开样本暂不可用，可稍后再次运行",
  access_restricted: "访问受限，已保留可用公开样本",
  rate_limited: "访问或频率受限，已保留可用公开样本",
  no_public_comments: "未发现可用的一级公开评论样本，不代表没有客户",
  partial_success: "部分公开样本已完成，受限部分可稍后重试"
};

function renderCommentAutomation(detail: AcquisitionTaskDetail): string {
  const presentation = record(detail.presentation);
  if (!presentation) return "";
  const summary = record(presentation.summary) ?? {};
  const steps = records(presentation.automationSteps);
  const signals = records(presentation.commentSignals);
  const hasProjection = steps.length > 0 || signals.length > 0 || [
    "discoveredVideos", "commentsSampled", "validDemandSignals", "unresolvedActors", "highPotentialSignals"
  ].some((key) => typeof summary[key] === "number");
  if (!hasProjection) return "";
  const candidateEvents = records(presentation.candidateEvents);
  const metrics = [
    ["已发现视频", finiteNumber(summary.discoveredVideos), "个视频"],
    ["已采样评论", finiteNumber(summary.commentsSampled), "条评论"],
    ["有效需求信号", finiteNumber(summary.validDemandSignals), "条"],
    ["待核验主体", finiteNumber(summary.unresolvedActors), "个"],
    ["高潜信号", finiteNumber(summary.highPotentialSignals), "个"]
  ];
  const stepsHtml = steps.map((step) => {
    const error = typeof step.errorCode === "string" ? COMMENT_ERROR_LABELS[step.errorCode] : null;
    return `<li data-automation-step-id="${escapeHtml(textValue(step.id))}" data-status="${escapeHtml(textValue(step.status))}">
      <strong>${escapeHtml(AUTOMATION_STEP_LABELS[textValue(step.id, "")] ?? textValue(step.id))}</strong>
      <span>${escapeHtml(textValue(step.message))}</span>
      <small>${finiteNumber(step.processedCount)} 项 · ${escapeHtml(error ?? readableLabel(step.status, SHARD_STATUS_LABELS))}</small>
    </li>`;
  }).join("");
  const notices = steps.map((step) => typeof step.errorCode === "string" ? COMMENT_ERROR_LABELS[step.errorCode] : null)
    .filter((item): item is string => item !== null);
  const signalsHtml = signals.map((signal) => {
    const candidate = candidateEvents.find((event) => textValue(event.candidateId, "") === textValue(signal.candidateId, ""));
    const qualification = record(candidate?.qualification);
    const highIntent = signal.identityStatus === "resolved"
      && (qualification?.grade === "S" || qualification?.grade === "A")
      && strings(qualification?.hardGateFailures).length === 0;
    const highPotential = signal.intentBand === "strong_signal" && signal.identityStatus === "needs_research";
    const label = highIntent ? "高意向" : highPotential ? "高潜需求信号" : "需求信号";
    const confidence = Math.round(Math.max(0, Math.min(1, finiteNumber(signal.confidence))) * 100);
    const reasons = strings(signal.reasons);
    return `<button type="button" class="replica-acquisition-comment-signal" data-acquisition-detail-action="select-candidate" data-candidate-id="${escapeHtml(textValue(signal.candidateId))}">
      <span class="replica-acquisition-comment-initials" aria-hidden="true">评</span>
      <span class="replica-acquisition-comment-copy"><strong>${escapeHtml(label)} · ${escapeHtml(textValue(signal.displayName))}</strong><em>${escapeHtml(textValue(signal.text))}</em>${reasons.length > 0 ? `<span class="replica-acquisition-comment-reasons">${reasons.map((reason) => `<i>${escapeHtml(reason)}</i>`).join("")}</span>` : ""}<small>${escapeHtml(textValue(signal.handle, "公开用户"))} · ${escapeHtml(textValue(signal.ipLabel, "公开主体"))} · ${escapeHtml(textValue(signal.sourceUrl))} · ${escapeHtml(textValue(signal.occurredAt))}</small></span>
      <span class="replica-acquisition-comment-meta">${confidence}%<small>${escapeHtml(signal.identityStatus === "resolved" ? "身份已核验" : "身份待核验")}</small></span>
    </button>`;
  }).join("");
  return `<section class="replica-acquisition-comment-automation" aria-label="公开评论自动化进程">
    <header><div><span>公开评论自动化</span><h4>自动化进程</h4></div><small>仅服务端投影，不按本地时间推演</small></header>
    <div class="replica-acquisition-comment-metrics" aria-label="公开评论计数带">${metrics.map(([label, value, unit]) => `<span><small>${escapeHtml(label)}</small><strong>${value} ${escapeHtml(unit)}</strong></span>`).join("")}</div>
    ${stepsHtml ? `<ol class="replica-acquisition-automation-steps">${stepsHtml}</ol>` : ""}
    ${notices.length > 0 ? `<p class="replica-acquisition-comment-notice" role="status">${escapeHtml(notices[0]!)}</p>` : ""}
    ${signalsHtml ? `<div class="replica-acquisition-comment-signals" aria-live="polite">${signalsHtml}</div>` : ""}
  </section>`;
}

const VISUAL_SESSION_STATUS_LABELS: Readonly<Record<string, string>> = {
  created: "已授权",
  collecting: "正在读取",
  completed: "已完成",
  partial_success: "部分完成",
  aborted: "已停止",
  expired: "已过期"
};

const VISUAL_STEP_LABELS: Readonly<Record<string, string>> = {
  authorize_visual_reader: "确认授权",
  read_visible_comment_cards: "读取可见评论卡",
  extract_visible_text: "提取可见文字",
  persist_visual_observations: "保存观察",
  review_visual_signal_confidence: "检查置信度"
};

function visualExtensionLabel(state: VisualReaderControlState): string {
  if (state.extensionStatus === "ready") {
    return state.extensionVersion
      ? `已连接（${state.extensionVersion}）`
      : "已连接";
  }
  if (state.extensionStatus === "unavailable") return "未检测到";
  if (state.extensionStatus === "probing") return "检测中";
  return "待检测";
}

function renderVisualReaderMetric(label: string, value: number, unit: string): string {
  return `<span><small>${escapeHtml(label)}</small><strong>${value} ${escapeHtml(unit)}</strong></span>`;
}

function visualReaderEligibility(
  detail: AcquisitionTaskDetail,
  visual: VisualReaderControlState
): { allowed: boolean; reason: string } {
  const plan = record(detail.plan) ?? {};
  const payload = record(plan.payload) ?? {};
  const run = record(detail.latestRun);
  const currentVersionId = textValue(plan.currentVersionId, "");
  const approvedVersionId = textValue(plan.approvedVersionId, "");
  const planVersion = finiteNumber(plan.version, 0);
  if (plan.status !== "approved" || !currentVersionId || !approvedVersionId
    || currentVersionId !== approvedVersionId || planVersion < 1) {
    return { allowed: false, reason: "仅已批准且版本未变更的计划可授权读取" };
  }
  if (textValue(run?.planVersionId, "") !== approvedVersionId
    || finiteNumber(run?.planVersion, 0) !== planVersion) {
    return { allowed: false, reason: "当前运行版本与已批准计划不一致，无法授权读取" };
  }
  if (!run || !["queued", "running"].includes(textValue(run.status, ""))) {
    return { allowed: false, reason: "仅排队中或运行中的任务可授权读取" };
  }
  if (payload.targetPlatform !== "douyin" || detail.task.platform !== "douyin") {
    return { allowed: false, reason: "当前计划不是抖音任务，无法授权读取" };
  }
  if (record(payload.douyinPublicCommentSample)?.enabled !== true) {
    return { allowed: false, reason: "当前已批准计划未启用公开评论样本" };
  }
  if (visual.extensionStatus !== "ready") {
    return { allowed: false, reason: "请先安装、启用并连接授权浏览器读取器" };
  }
  if (visual.busy) {
    return { allowed: false, reason: "正在处理视觉读取请求，请稍候" };
  }
  return { allowed: true, reason: "已满足授权条件，可读取当前页面中可见的一级评论" };
}

function renderVisualReader(
  detail: AcquisitionTaskDetail,
  visual: VisualReaderControlState | undefined
): string {
  if (!visual) return "";
  const session = visual.session;
  const eligibility = visualReaderEligibility(detail, visual);
  const usage = session?.usage ?? visual.projection?.usage ?? null;
  const limits = session?.limits ?? null;
  const active = session !== null && ["created", "collecting"].includes(session.status);
  const latestRunId = textValue(record(detail.latestRun)?.id, "");
  const canAuthorize = session === null && latestRunId.length > 0 && eligibility.allowed;
  const remainingDurationSeconds = session
    ? Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.parse(session.updatedAt)) / 1_000))
    : 0;
  const remaining = limits && usage ? {
    videos: Math.max(0, limits.maxVideos - usage.videoCount),
    comments: Math.max(
      0,
      limits.maxVideos * limits.maxCommentsPerVideo - usage.observationCount
    ),
    scrolls: Math.max(0, limits.maxScrolls - usage.scrollCount),
    ocr: Math.max(0, limits.maxOcrCalls - usage.ocrCallCount)
  } : null;
  const projectionSteps = visual.projection?.visualSteps ?? [];
  const steps = projectionSteps.length === 0 ? "" : `
    <ol class="replica-acquisition-visual-reader-steps" aria-label="服务端视觉读取步骤">
      ${projectionSteps.map((step) => `<li data-visual-step-id="${escapeHtml(step.id)}" data-status="${escapeHtml(step.status)}">
        <strong>${escapeHtml(VISUAL_STEP_LABELS[step.id] ?? step.id)}</strong>
        <span>${escapeHtml(step.message)}</span>
        <small>${finiteNumber(step.processedCount)} 项 / ${escapeHtml(readableLabel(step.status, SHARD_STATUS_LABELS))}</small>
      </li>`).join("")}
    </ol>
  `;
  const statusText = session
    ? VISUAL_SESSION_STATUS_LABELS[session.status] ?? session.status
    : "尚未授权";
  return `
    <section
      class="replica-acquisition-visual-reader"
      data-acquisition-visual-reader
      data-extension-status="${escapeHtml(visual.extensionStatus)}"
      data-session-status="${escapeHtml(session?.status ?? "idle")}"
    >
      <header>
        <div>
          <span>授权可见评论读取</span>
          <h4>读取当前抖音页面</h4>
        </div>
        <div class="replica-acquisition-visual-reader-status" aria-live="polite">
          <strong>${escapeHtml(statusText)}</strong>
          <small>浏览器读取器：${escapeHtml(visualExtensionLabel(visual))}</small>
        </div>
      </header>

      <div class="replica-acquisition-visual-reader-consent">
        <label>
          <input
            type="checkbox"
            name="visualReaderArtifactUpload"
            ${visual.artifactUploadEnabled ? "checked" : ""}
            ${session || visual.busy ? "disabled" : ""}
          >
          <span>上传已遮挡的单张评论卡 WebP</span>
        </label>
        <p>关闭后仅提交文字观察。只上传已遮挡的单张评论卡 WebP；不读取 Cookie，不发私信，不点赞或评论。</p>
      </div>

      ${remaining ? `<div class="replica-acquisition-visual-reader-budget" aria-label="视觉读取剩余限额">
        ${renderVisualReaderMetric("剩余视频", remaining.videos, "个")}
        ${renderVisualReaderMetric("剩余评论容量", remaining.comments, "条")}
        ${renderVisualReaderMetric("剩余采集批次", remaining.scrolls, "次")}
        ${renderVisualReaderMetric("剩余 OCR", remaining.ocr, "次")}
        ${renderVisualReaderMetric("剩余授权时长", remainingDurationSeconds, "秒")}
      </div>` : ""}

      ${usage ? `<div class="replica-acquisition-visual-reader-facts" aria-label="服务端视觉读取计数">
        ${renderVisualReaderMetric("DOM", usage.domObservationCount, "条")}
        ${renderVisualReaderMetric("可访问性", usage.accessibilityObservationCount, "条")}
        ${renderVisualReaderMetric("OCR", usage.ocrObservationCount, "条")}
        ${renderVisualReaderMetric("低置信度", usage.lowConfidenceObservationCount, "条")}
        ${renderVisualReaderMetric("制品", usage.artifactCount, "个")}
      </div>` : ""}

      ${steps}
      ${visual.message ? `<p class="replica-acquisition-visual-reader-message" role="status" aria-live="polite">${escapeHtml(visual.message)}</p>` : ""}
      ${visual.error ? `<p class="replica-acquisition-visual-reader-message is-error" role="alert">${escapeHtml(visual.error)}</p>` : ""}
      ${session === null ? `<p class="replica-acquisition-visual-reader-message replica-acquisition-visual-reader-eligibility" role="status">${escapeHtml(eligibility.reason)}</p>` : ""}

      <footer>
        ${visual.extensionStatus === "unavailable" ? `<button type="button" data-acquisition-detail-action="retry-visual-reader-probe">重新检测读取器</button>` : ""}
        ${session === null ? `<button
          type="button"
          class="is-primary"
          data-acquisition-detail-action="authorize-visual-reader"
          ${canAuthorize ? "" : "disabled"}
        >${visual.busy ? "正在授权" : "授权读取当前抖音页面"}</button>` : ""}
        ${active ? `<button
          type="button"
          class="is-danger"
          data-acquisition-detail-action="stop-visual-reader"
          ${visual.busy ? "disabled" : ""}
        >${visual.busy ? "正在停止" : "停止读取"}</button>` : ""}
      </footer>
    </section>
  `;
}

function tabButton(
  mode: AcquisitionDetailCenterMode,
  current: AcquisitionDetailCenterMode,
  label: string
): string {
  const selected = current === mode;
  const tabId = `acquisition-detail-tab-${mode}`;
  const panelId = `acquisition-detail-panel-${mode}`;
  return `
    <button
      type="button"
      id="${tabId}"
      role="tab"
      aria-selected="${selected}"
      aria-controls="${panelId}"
      tabindex="${selected ? 0 : -1}"
      data-acquisition-detail-action="switch-mode"
      data-mode="${mode}"
      class="${selected ? "is-active" : ""}"
    >${label}</button>
  `;
}

function renderTabs(mode: AcquisitionDetailCenterMode): string {
  return `
    <div class="replica-acquisition-detail-tabs" role="tablist" aria-label="任务详情视图">
      ${tabButton("plan", mode, "计划详情")}
      ${tabButton("candidates", mode, "候选研判")}
    </div>
  `;
}

function renderStateMessage(state: AcquisitionDetailCenterState): string | null {
  if (state.status === "loading") {
    return `
      <div class="replica-acquisition-detail-state" role="status" aria-live="polite">
        <strong>${escapeHtml(state.message ?? "正在加载真实任务详情…")}</strong>
        <span>正在读取计划、运行与候选数据。</span>
      </div>
    `;
  }
  if (state.status === "error") {
    return `
      <div class="replica-acquisition-detail-state is-error" role="alert">
        <strong>任务详情加载失败</strong>
        <span>${escapeHtml(state.error ?? "请稍后重试")}</span>
        <button type="button" data-acquisition-detail-action="retry">重新加载</button>
      </div>
    `;
  }
  if (state.detail === null
    && !(state.mode === "candidates" && state.selectedCandidateId)) {
    return `
      <div class="replica-acquisition-detail-state" role="status">
        <strong>尚未选择真实任务</strong>
        <span>请先从任务列表选择一项。</span>
      </div>
    `;
  }
  return null;
}

function renderRunControls(
  planStatus: string,
  planVersion: unknown,
  latestRun: DataRecord | null,
  busy: boolean,
  reason: string
): string {
  const status = latestRun === null ? null : textValue(latestRun.status, "queued");
  const currentPlanVersion = typeof planVersion === "number" && Number.isFinite(planVersion)
    ? planVersion
    : null;
  const runPlanVersion = typeof latestRun?.planVersion === "number"
    && Number.isFinite(latestRun.planVersion)
    ? latestRun.planVersion
    : null;
  const canContinueBudgetRun = status === "budget_exhausted"
    && planStatus === "approved"
    && currentPlanVersion !== null
    && runPlanVersion !== null
    && currentPlanVersion > runPlanVersion;
  const actions: Array<{ action: string; label: string; danger?: boolean }> = [];
  if (status === null) {
    if (planStatus === "approved") actions.push({ action: "start", label: "启动运行" });
  } else if (["queued", "running"].includes(status)) {
    actions.push(
      { action: "pause", label: "暂停运行" },
      { action: "cancel", label: "取消运行", danger: true }
    );
  } else if (status === "paused") {
    actions.push(
      { action: "resume", label: "继续运行" },
      { action: "cancel", label: "取消运行", danger: true }
    );
  } else if (status === "pause_requested") {
    actions.push({ action: "cancel", label: "取消运行", danger: true });
  } else if (canContinueBudgetRun) {
    actions.push({ action: "start", label: "追加预算后续跑" });
  } else if ([
    "cancelled",
    "succeeded",
    "succeeded_empty",
    "partial_success",
    "failed"
  ].includes(status) && planStatus === "approved") {
    actions.push({ action: "start", label: "再次运行" });
  }
  if (actions.length === 0) {
    if (status === "budget_exhausted") {
      return `
        <div class="replica-acquisition-run-note" role="note">
          预算已用完，请先调整预算并重新审批后再续跑。
        </div>
      `;
    }
    if (status === "cancel_requested") {
      return `
        <div class="replica-acquisition-run-note" role="status">
          取消请求已提交，系统正在安全停止当前运行。
        </div>
      `;
    }
    return "";
  }
  return `
    <div class="replica-acquisition-run-controls" data-run-status="${escapeHtml(status ?? "not_started")}">
      <label>
        <span>操作原因</span>
        <input name="runControlReason" maxlength="2000" value="${escapeHtml(reason)}" placeholder="暂停、继续或取消时请填写原因">
      </label>
      <div>${actions.map(({ action, label, danger }) => `
        <button
          type="button"
          class="${danger ? "is-danger" : ""}"
          data-acquisition-detail-action="run-control"
          data-acquisition-run-action="${action}"
          ${busy ? "disabled" : ""}
        >${busy ? "正在处理…" : label}</button>
      `).join("")}</div>
    </div>
  `;
}

function renderPlanOverview(
  detail: AcquisitionTaskDetail,
  state: AcquisitionDetailCenterState
): string {
  const plan = record(detail.plan) ?? {};
  const payload = record(plan.payload) ?? plan;
  const icp = record(payload.icp) ?? {};
  const operations = records(payload.operations);
  const connections = records(payload.providerConnections);
  const latestRun = record(detail.latestRun);
  const planBudget = record(payload.budgetSnapshot)
    ?? record(plan.budgetSnapshot)
    ?? {};
  const runBudgetLimit = record(latestRun?.budgetSnapshot) ?? planBudget;
  const runModel = record(latestRun?.modelSnapshotRef);
  const planModel = record(payload.modelSnapshotRef);
  const model = runModel ?? planModel ?? {};
  const runBudget = record(latestRun?.consumedBudget) ?? {};
  const terminalShardCount = detail.shards.filter((rawShard) => {
    const shard = record(rawShard);
    return shard !== null
      && typeof shard.status === "string"
      && TERMINAL_SHARD_STATUSES.has(shard.status);
  }).length;
  const objective = textValue(payload.objective, detail.task.objective);
  const planStatus = plan.status === "approved"
    ? "已批准"
    : plan.status === "archived" ? "已归档" : "草稿";

  const operationHtml = operations.length === 0
    ? `<div class="replica-acquisition-detail-empty-value">暂未配置搜索操作</div>`
    : operations.map((operation) => {
      const operationId = textValue(operation.operationId);
      const subject = operation.subjectChannel === "individual"
        ? "个人主体" : "企业主体";
      const allocated = record(operation.allocatedBudget) ?? {};
      return `
        <article class="replica-acquisition-operation">
          <div><strong>${escapeHtml(operationId)}</strong><span>${subject}</span></div>
          <p>${escapeHtml(textValue(operation.query, textValue(operation.sourceRef, "未配置查询")))}</p>
          <small>${finiteNumber(allocated.requests)} 次请求 · ${finiteNumber(allocated.results)} 条结果 · ${finiteNumber(allocated.durationSeconds)} 秒</small>
        </article>
      `;
    }).join("");

  const connectionHtml = connections.length === 0
    ? `<span class="replica-acquisition-detail-empty-value">暂未配置搜索连接</span>`
    : connections.map((connection) => {
      const provider = readableLabel(connection.providerId, PROVIDER_LABELS);
      const connectionStatus = connection.status === "active" ? "已启用" : textValue(connection.status);
      return `<li><strong>${escapeHtml(provider)}</strong><span>${escapeHtml(connectionStatus)} · ${escapeHtml(textValue(connection.connectionId))}</span></li>`;
    }).join("");

  const shardHtml = detail.shards.length === 0
    ? `<span class="replica-acquisition-detail-empty-value">当前运行尚未生成分片</span>`
    : detail.shards.map((rawShard) => {
      const shard = record(rawShard) ?? {};
      return `
        <li>
          <div><strong>${escapeHtml(textValue(shard.operationId, textValue(shard.id)))}</strong><span>${escapeHtml(readableLabel(shard.status, SHARD_STATUS_LABELS))}</span></div>
          <small>${finiteNumber(shard.evidenceCount)} 条证据</small>
        </li>
      `;
    }).join("");

  const runHtml = latestRun === null
    ? `<div class="replica-acquisition-run-empty"><strong>尚未运行</strong><span>计划已保存，但还没有真实运行记录。</span></div>
      ${renderRunControls(
        String(plan.status ?? "draft"),
        plan.version,
        null,
        state.runControlBusy === true,
        state.runControlReason ?? ""
      )}`
    : `
      <div class="replica-acquisition-run-summary">
        <strong>${escapeHtml(readableLabel(latestRun.status, RUN_STATUS_LABELS))}</strong>
        <span>${finiteNumber(latestRun.evidenceCount)} 条证据</span>
        ${renderRunLiveIndicator(textValue(latestRun.status, "queued"))}
      </div>
      <div class="replica-acquisition-run-progress" aria-label="本次运行资源进度">
        ${renderRunProgressMetric({
          metric: "requests",
          label: "请求消耗",
          current: runBudget.requests,
          limit: runBudgetLimit.maxRequests,
          unit: "次请求"
        })}
        ${renderRunProgressMetric({
          metric: "results",
          label: "结果产出",
          current: runBudget.results,
          limit: runBudgetLimit.maxResults,
          unit: "条结果"
        })}
        ${renderRunProgressMetric({
          metric: "duration",
          label: "运行时长",
          current: runBudget.durationSeconds,
          limit: runBudgetLimit.maxDurationSeconds,
          unit: "秒"
        })}
        ${renderRunProgressMetric({
          metric: "shards",
          label: "终态分片",
          current: terminalShardCount,
          limit: detail.shards.length,
          unit: "个分片",
          emptyWhenZero: true
        })}
      </div>
      ${renderRunControls(
        String(plan.status ?? "draft"),
        plan.version,
        latestRun,
        state.runControlBusy === true,
        state.runControlReason ?? ""
      )}
    `;

  return `
    <section class="replica-acquisition-detail-panel" id="acquisition-detail-panel-plan" role="tabpanel" aria-labelledby="acquisition-detail-tab-plan" data-acquisition-detail-panel="plan">
      <header class="replica-acquisition-detail-heading">
        <div><span>当前计划 · v${finiteNumber(plan.version, 1)}</span><h3>${escapeHtml(textValue(payload.name, detail.task.name))}</h3></div>
        <strong>${planStatus}</strong>
      </header>

      <article class="replica-acquisition-detail-section">
        <h4>获客目标</h4>
        <p>${escapeHtml(objective)}</p>
      </article>

      <div class="replica-acquisition-detail-grid">
        <article class="replica-acquisition-detail-section"><h4>目标行业</h4>${renderTextList(strings(icp.industries))}</article>
        <article class="replica-acquisition-detail-section"><h4>目标地区</h4>${renderTextList(strings(icp.regions))}</article>
        <article class="replica-acquisition-detail-section"><h4>企业 ICP</h4>${renderTextList(strings(icp.organizationCriteria))}</article>
        <article class="replica-acquisition-detail-section"><h4>个人 ICP</h4>${renderTextList(strings(icp.individualCriteria))}</article>
      </div>

      <article class="replica-acquisition-detail-section">
        <h4>排除项</h4>
        ${renderTextList(strings(icp.exclusionRules), "暂无排除规则")}
      </article>

      <article class="replica-acquisition-detail-section">
        <h4>搜索操作</h4>
        <div class="replica-acquisition-operation-list">${operationHtml}</div>
      </article>

      <div class="replica-acquisition-detail-grid">
        <article class="replica-acquisition-detail-section">
          <h4>预算上限</h4>
          <p>${finiteNumber(planBudget.maxRequests)} 次请求 · ${finiteNumber(planBudget.maxResults)} 条结果</p>
          <small>${escapeHtml(formatMinorAmount(planBudget.billingCurrency, planBudget.maxAmountMinor))} · ${finiteNumber(planBudget.maxDurationSeconds)} 秒</small>
        </article>
        <article class="replica-acquisition-detail-section">
          <h4>AI 模型</h4>
          <p>${escapeHtml(readableLabel(model.provider, MODEL_PROVIDER_LABELS))}</p>
          <small>${escapeHtml(textValue(model.model))}</small>
        </article>
        <article class="replica-acquisition-detail-section">
          <h4>搜索连接</h4>
          <ul class="replica-acquisition-connection-list">${connectionHtml}</ul>
        </article>
      </div>

      <article class="replica-acquisition-detail-section">
        <h4>最新运行</h4>
        ${runHtml}
      </article>

      ${renderCommentAutomation(detail)}

      ${renderVisualReader(detail, state.visualReader)}

      <article class="replica-acquisition-detail-section">
        <h4>运行分片</h4>
        <ul class="replica-acquisition-shard-list">${shardHtml}</ul>
      </article>
    </section>
  `;
}

function decisionEngineLabel(value: unknown): string {
  if (value === "model") return "AI 模型研判";
  if (value === "rules") return "规则引擎研判";
  return "尚未研判";
}

function candidateSubjectLabel(value: unknown): string {
  return value === "individual" ? "个人主体" : "企业主体";
}

function candidateEventId(event: DataRecord): string {
  return textValue(event.candidateId, textValue(record(event.candidate)?.id, ""));
}

function renderCandidateList(
  events: DataRecord[],
  selectedCandidateId: string | null
): string {
  return events.map((event) => {
    const candidate = record(event.candidate) ?? {};
    const qualification = record(event.qualification);
    const financial = record(event.financialValue);
    const candidateId = candidateEventId(event);
    const grade = textValue(qualification?.grade, "待评估");
    const score = qualification === null ? "待评分" : `${finiteNumber(qualification.score)} 分`;
    const financialLabel = financial === null
      ? "财务价值待评估"
      : `财务等级 ${textValue(financial.grade)} · ${formatMinorAmount(financial.currency, financial.expectedRevenueMinor)}`;
    const selected = candidateId === selectedCandidateId;
    return `
      <button
        type="button"
        class="replica-acquisition-candidate${selected ? " is-selected" : ""}"
        data-acquisition-detail-action="select-candidate"
        data-candidate-id="${escapeHtml(candidateId)}"
        aria-pressed="${selected}"
      >
        <span class="replica-acquisition-candidate-name">${escapeHtml(textValue(candidate.displayName, textValue(candidate.publicDisplayName, "未命名候选")))}</span>
        <span>${candidateSubjectLabel(candidate.subjectKind)}</span>
        <strong>意向等级 ${escapeHtml(grade)}</strong>
        <span>${escapeHtml(score)} · ${decisionEngineLabel(qualification?.decisionEngine)}</span>
        <span>${finiteNumber(event.evidenceCount)} 条证据</span>
        <span>${escapeHtml(financialLabel)}</span>
      </button>
    `;
  }).join("");
}

function renderSignals(value: unknown, emptyText: string): string {
  const signals = records(value);
  if (signals.length === 0) return `<li>${emptyText}</li>`;
  return signals.map((signal) => `
    <li><strong>${escapeHtml(textValue(signal.name))}</strong><span>${finiteNumber(signal.score)} 分</span></li>
  `).join("");
}

function renderReasons(value: unknown): string {
  const reasons = strings(value);
  if (reasons.length === 0) return `<li>暂无资格理由</li>`;
  return reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
}

function renderHardGates(value: unknown): string {
  const failures = strings(value);
  if (failures.length === 0) return `<li>未命中硬门禁</li>`;
  return failures.map((failure) => `<li>${escapeHtml(readableLabel(failure, HARD_GATE_LABELS))}</li>`).join("");
}

function renderFinancialDetail(value: DataRecord | null): string {
  if (value === null) {
    return `<div class="replica-acquisition-detail-empty-value">财务价值待评估</div>`;
  }
  const factors = record(value.factors) ?? {};
  return `
    <div class="replica-acquisition-financial-summary">
      <strong>财务等级 ${escapeHtml(textValue(value.grade))} · ${finiteNumber(value.score)} 分</strong>
      <span>预计收入 ${escapeHtml(formatMinorAmount(value.currency, value.expectedRevenueMinor))}</span>
      <span>预计毛利 ${escapeHtml(formatMinorAmount(value.currency, value.expectedGrossProfitMinor))}</span>
      <span>预计贡献 ${escapeHtml(formatMinorAmount(value.currency, value.expectedContributionMinor))}</span>
    </div>
    <dl class="replica-acquisition-factor-list">
      <div><dt>盈利能力</dt><dd>${Math.round(finiteNumber(factors.profitability))}%</dd></div>
      <div><dt>现金流</dt><dd>${Math.round(finiteNumber(factors.cashFlow))}%</dd></div>
      <div><dt>信用质量</dt><dd>${Math.round(finiteNumber(factors.creditQuality))}%</dd></div>
      <div><dt>成交概率</dt><dd>${Math.round(finiteNumber(factors.closeProbability))}%</dd></div>
    </dl>
  `;
}

function renderVisualArtifact(
  provenance: DataRecord | null,
  visualArtifact: AcquisitionVisualArtifactState | null | undefined
): string {
  const artifactId = provenance?.kind === "authorized_visual_observation"
    && typeof provenance.artifactId === "string"
    && provenance.artifactId.trim()
    ? provenance.artifactId.trim()
    : null;
  if (!artifactId) return "";
  const active = visualArtifact?.artifactId === artifactId ? visualArtifact : null;
  return `
    <div class="replica-acquisition-visual-artifact" data-visual-artifact-id="${escapeHtml(artifactId)}">
      <button type="button" data-acquisition-detail-action="view-visual-artifact" data-artifact-id="${escapeHtml(artifactId)}"${active?.status === "loading" ? " disabled" : ""}>
        ${active?.status === "loading" ? "正在读取遮挡裁剪…" : "查看遮挡裁剪"}
      </button>
      ${active?.status === "ready" && active.objectUrl ? `
        <figure>
          <img src="${escapeHtml(active.objectUrl)}" alt="已遮挡的评论卡裁剪">
          <figcaption>仅显示服务端授权返回的 image/webp 遮挡裁剪。</figcaption>
          <button type="button" data-acquisition-detail-action="close-visual-artifact">关闭裁剪</button>
        </figure>
      ` : ""}
      ${active?.message ? `<p role="status">${escapeHtml(active.message)}</p>` : ""}
    </div>
  `;
}

function renderEvidenceDetail(
  items: DataRecord[],
  visualArtifact: AcquisitionVisualArtifactState | null | undefined
): string {
  if (items.length === 0) {
    return `<div class="replica-acquisition-detail-empty-value">尚未读取到公开证据详情</div>`;
  }
  return `<ol class="replica-acquisition-evidence-list">${items.map((item) => {
    const provenance = record(item.provenance);
    const sourceUrl = textValue(item.sourceUrl, textValue(provenance?.sourceUrl, ""));
    return `
    <li>
      <div><strong>${escapeHtml(textValue(item.sourceTitle, "公开来源"))}</strong><span>${escapeHtml(textValue(item.sourcePlatform, "公开网页"))}</span></div>
      <p>${escapeHtml(textValue(item.sourceSnippet, "来源未提供摘要"))}</p>
      ${sourceUrl ? `<small>${escapeHtml(sourceUrl)}</small>` : ""}
      <small>${escapeHtml(textValue(item.publishedAt, textValue(item.fetchedAt, "时间未知")))}</small>
      ${textValue(item.id) ? `<small>证据 ID：${escapeHtml(textValue(item.id))}</small>` : ""}
      ${textValue(item.rawArtifactHash) ? `<small>证据哈希：${escapeHtml(textValue(item.rawArtifactHash))}</small>` : ""}
      ${renderVisualArtifact(provenance, visualArtifact)}
    </li>
  `; }).join("")}</ol>`;
}

function renderBattleCard(value: DataRecord | null): string {
  if (value === null) {
    return `<div class="replica-acquisition-detail-empty-value">客户作战建议尚未生成</div>`;
  }
  const sections = records(value.sections);
  const intelligence = record(value.intelligence);
  const strategies = records(intelligence?.connectionStrategies);
  const openers = records(intelligence?.roleSpecificOpeners);
  const doNotActions = strings(intelligence?.doNotActions);
  const sectionHtml = sections.map((section) => `
    <li><strong>${escapeHtml(textValue(section.label, "作战建议"))}</strong><p>${escapeHtml(textValue(section.content))}</p></li>
  `);
  const strategyHtml = strategies.map((strategy) => `
    <li><strong>${escapeHtml(textValue(strategy.targetRole, "目标角色"))}</strong><p>${escapeHtml(textValue(strategy.openingDraft))}</p></li>
  `);
  const openerHtml = openers.map((opener) => `
    <li><strong>${escapeHtml(textValue(opener.role, "目标角色"))}</strong><p>${escapeHtml(textValue(opener.text))}</p></li>
  `);
  const avoidHtml = doNotActions.map((item) => `
    <li><strong>不建议动作</strong><p>${escapeHtml(item)}</p></li>
  `);
  const content = [...sectionHtml, ...strategyHtml, ...openerHtml, ...avoidHtml];
  return content.length > 0
    ? `<ul class="replica-acquisition-battle-card-list">${content.join("")}</ul>`
    : `<div class="replica-acquisition-detail-empty-value">客户作战卡已生成，但暂无可展示建议</div>`;
}

const REVIEW_ACTION_LABELS: Readonly<Record<string, string>> = {
  approved: "批准跟进",
  rejected: "驳回候选",
  do_not_contact: "禁止联系",
  needs_research: "补充研究",
  reopen: "重新进入研判"
};

function renderReviewHistory(items: DataRecord[]): string {
  if (items.length === 0) {
    return `<div class="replica-acquisition-detail-empty-value">暂无人工审核记录</div>`;
  }
  return `<ol class="replica-acquisition-review-history">${items.map((item) => `
    <li>
      <div><strong>${escapeHtml(readableLabel(item.action, REVIEW_ACTION_LABELS, "人工审核"))}</strong><span>${escapeHtml(textValue(item.createdAt, "时间未知"))}</span></div>
      <p>${escapeHtml(textValue(item.reason, "未填写补充说明"))}</p>
    </li>
  `).join("")}</ol>`;
}

function renderIntelligenceAction(
  candidate: DataRecord,
  operation: DataRecord | null,
  identityResolutionOperation: CandidateDouyinIdentityResolutionOperation | null
): string {
  if (candidate.identityResolved !== true) {
    return `<div class="replica-acquisition-review-note is-warning">主体身份尚未确认，暂不能启动 AI 资格研判。</div>`;
  }
  if (operation?.status === "queued" || operation?.status === "running") {
    return `<div class="replica-acquisition-review-note">AI 客户情报任务正在${operation.status === "queued" ? "排队" : "运行"}，完成后刷新资格与作战卡。</div>`;
  }
  if (operation?.status === "failed") {
    return `<div class="replica-acquisition-review-note is-warning">最近一次 AI 研判失败，请在任务刷新后重试。</div>`;
  }
  if (identityResolutionOperation?.status === "succeeded"
    && identityResolutionOperation.outcome === "verified_consensus") {
    return `<div class="replica-acquisition-review-note">AI 研判由自动主体核验流程创建，正在同步服务端状态。</div>`;
  }
  return `
    <div class="replica-acquisition-intelligence-start">
      <div><strong>尚未完成 AI 资格研判</strong><span>系统将研究公开证据、计算意向等级与财务价值，并生成客户作战卡。</span></div>
      <button type="button" data-acquisition-detail-action="start-intelligence">启动 AI 研判</button>
    </div>
  `;
}

function isDouyinIndividual(candidate: DataRecord): boolean {
  return candidate.subjectKind === "individual"
    && textValue(candidate.sourcePlatform, "").toLowerCase().includes("douyin");
}

function isUnresolvedDouyinIndividual(candidate: DataRecord): boolean {
  return isDouyinIndividual(candidate) && candidate.identityResolved !== true;
}

function identityRationaleValue(
  state: AcquisitionIdentityVerificationState | null | undefined
): string {
  return state?.rationale
    ?? "已人工核对本次受控抓取的抖音公开主页，与候选需求主体一致。";
}

function identityProfileInputValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/u, "");
    return url.protocol === "https:"
      && (hostname === "www.douyin.com" || hostname === "douyin.com")
      && path.startsWith("/user/")
      && path.length > "/user/".length
      ? value.trim()
      : "";
  } catch {
    return "";
  }
}

function renderManualIdentityVerificationForm(
  candidate: DataRecord,
  state: AcquisitionIdentityVerificationState | null | undefined,
  automaticOperation: CandidateDouyinIdentityResolutionOperation | null
): string {
  const busy = state?.status === "fetching" || state?.status === "confirming";
  const fetched = state?.status === "ready_to_confirm"
    && (state.evidenceIds?.length ?? 0) > 0;
  const suggestedProfileUrl = automaticOperation?.outcome !== "conflicting"
      && automaticOperation?.profileCandidates.length === 1
    ? automaticOperation.profileCandidates[0]?.publicProfileUrl
    : undefined;
  const profileUrl = identityProfileInputValue(
    automaticOperation?.outcome === "conflicting"
      ? ""
      : state?.profileUrl || suggestedProfileUrl || candidate.publicProfileUrl
  );
  const evidenceIds = state?.evidenceIds ?? [];
  const evidenceHtml = evidenceIds.length === 0
    ? `<div class="replica-acquisition-detail-empty-value">先抓取精确公开主页，返回的公开证据才可用于身份确认。</div>`
    : `<ol class="replica-acquisition-identity-evidence">${evidenceIds
        .map((id) => `
          <li>
            <label>
              <input type="checkbox" name="identityEvidenceId" value="${escapeHtml(id)}" checked${busy ? " disabled" : ""}>
              <span>${escapeHtml(id)}</span>
            </label>
          </li>
        `)
        .join("")}</ol>`;
  return `
    <form class="replica-acquisition-review-form" data-acquisition-detail-form="identity-verification">
      <div class="replica-acquisition-review-note is-warning">当前候选来自抖音公开内容，但还没有确认到精确主页。请填写 HTTPS 的抖音 /user/ 主页，不能使用视频、评论或短链作为主体。</div>
      ${state?.message ? `<div class="replica-acquisition-review-note">${escapeHtml(state.message)}</div>` : ""}
      ${state?.error ? `<div class="replica-acquisition-review-note is-warning">${escapeHtml(state.error)}</div>` : ""}
      <label>
        <span>抖音公开主页</span>
        <input name="identityProfileUrl" type="url" maxlength="2000" required placeholder="https://www.douyin.com/user/..." value="${escapeHtml(profileUrl)}"${busy ? " disabled" : ""}>
      </label>
      <label>
        <span>人工核验说明</span>
        <textarea name="identityRationale" maxlength="2000" required${busy ? " disabled" : ""}>${escapeHtml(identityRationaleValue(state))}</textarea>
      </label>
      ${evidenceHtml}
      <div class="replica-acquisition-review-actions">
        <button type="submit" data-identity-action="fetch"${busy ? " disabled" : ""}>${state?.status === "fetching" ? "正在抓取…" : fetched ? "重新抓取主页证据" : "抓取公开主页证据"}</button>
        <button type="submit" class="is-primary" data-identity-action="confirm"${!fetched || busy ? " disabled" : ""}>${state?.status === "confirming" ? "正在确认…" : "确认主体并启动 AI 研判"}</button>
      </div>
    </form>
  `;
}

const IDENTITY_STAGE_LABELS: Readonly<Record<string, string>> = {
  public_page: "正在核验抖音公开页",
  independent_search: "正在交叉检索独立公开结果",
  consensus_gate: "正在比对两类公开证据",
  identity_confirmation: "正在确认候选主体",
  intelligence_dispatch: "正在启动 AI 研判"
};

const IDENTITY_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  verified_consensus: "抖音公开页与独立搜索结果共同指向唯一公开主页",
  not_found: "未找到规范用户主页",
  insufficient_evidence: "只有一种独立证据类别",
  ambiguous: "存在多个有效候选主页",
  conflicting: "两类证据指向不同主页",
  access_restricted: "页面需要登录、验证码或无法公开验证",
  redirect_not_allowed: "重定向离开允许域名",
  stale_candidate: "候选版本在处理期间变化",
  provider_unavailable: "搜索或抓取服务暂不可用"
};

const IDENTITY_EVIDENCE_CLASS_LABELS: Readonly<Record<string, string>> = {
  douyin_public_page: "抖音公开页",
  independent_search_result: "独立搜索结果"
};

const IDENTITY_ACCESS_STATUS_LABELS: Readonly<Record<string, string>> = {
  indexed_summary: "公开索引摘要",
  public_content: "公开内容",
  access_restricted: "访问受限"
};

function renderAutomaticIdentityEvidence(
  operation: CandidateDouyinIdentityResolutionOperation
): string {
  if (operation.evidence.length === 0) {
    return `<div class="replica-acquisition-detail-empty-value">自动核验尚未记录可展示的公开证据。</div>`;
  }
  return `<ol class="replica-acquisition-evidence-list">${operation.evidence
    .map((item) => `
      <li>
        <div><strong>${escapeHtml(readableLabel(item.evidenceClass, IDENTITY_EVIDENCE_CLASS_LABELS))}</strong><span>${escapeHtml(readableLabel(item.accessStatus, IDENTITY_ACCESS_STATUS_LABELS))}</span></div>
        <p>${escapeHtml(item.publicProfileUrl)}</p>
        <small>${escapeHtml(item.sourceUrl)} · ${escapeHtml(item.fetchedAt)}</small>
      </li>
    `)
    .join("")}</ol>`;
}

function renderAutomaticProfileCandidates(
  operation: CandidateDouyinIdentityResolutionOperation
): string {
  if (operation.profileCandidates.length === 0) return "";
  return `
    <div class="replica-acquisition-review-note">
      <strong>待人工核对的公开主页</strong>
      <ol>${operation.profileCandidates.map((item) => `
        <li><span>${escapeHtml(item.publicProfileUrl)}</span><small>${escapeHtml(item.evidenceIds.join("、"))}</small></li>
      `).join("")}</ol>
    </div>
  `;
}

function renderIdentityVerificationWorkbench(
  candidate: DataRecord,
  state: AcquisitionIdentityVerificationState | null | undefined,
  automaticOperation: CandidateDouyinIdentityResolutionOperation | null
): string {
  if (!isDouyinIndividual(candidate)) return "";
  if (automaticOperation?.status === "queued"
    || automaticOperation?.status === "running") {
    const stage = automaticOperation.currentStage
      ? readableLabel(automaticOperation.currentStage, IDENTITY_STAGE_LABELS)
      : "等待自动核验任务开始";
    return `
      <section class="replica-acquisition-detail-section replica-acquisition-identity-section">
        <h5>主体核验</h5>
        <div class="replica-acquisition-review-note" role="status"><strong>正在自动核验</strong><span>${escapeHtml(stage)}</span></div>
        ${renderAutomaticIdentityEvidence(automaticOperation)}
      </section>
    `;
  }
  if (automaticOperation?.status === "succeeded"
    && automaticOperation.outcome === "verified_consensus") {
    return `
      <section class="replica-acquisition-detail-section replica-acquisition-identity-section">
        <h5>主体核验</h5>
        <div class="replica-acquisition-review-note"><strong>已自动确认，正在进行 AI 研判</strong><span>${escapeHtml(automaticOperation.canonicalProfileUrl ?? "规范主页待同步")}</span></div>
        ${renderAutomaticIdentityEvidence(automaticOperation)}
      </section>
    `;
  }
  if (!isUnresolvedDouyinIndividual(candidate)) return "";
  if (automaticOperation?.status === "requires_review") {
    const outcome = automaticOperation.outcome;
    return `
      <section class="replica-acquisition-detail-section replica-acquisition-identity-section">
        <h5>主体核验</h5>
        <div class="replica-acquisition-review-note is-warning"><strong>证据不足，需要人工确认</strong><span>${escapeHtml(outcome ? readableLabel(outcome, IDENTITY_OUTCOME_LABELS) : "自动核验未形成唯一结论")}</span></div>
        ${renderAutomaticProfileCandidates(automaticOperation)}
        ${renderAutomaticIdentityEvidence(automaticOperation)}
        ${renderManualIdentityVerificationForm(candidate, state, automaticOperation)}
      </section>
    `;
  }
  if (automaticOperation?.status === "failed") {
    const outcome = automaticOperation.outcome;
    return `
      <section class="replica-acquisition-detail-section replica-acquisition-identity-section">
        <h5>主体核验</h5>
        <div class="replica-acquisition-review-note is-warning"><strong>${automaticOperation.retryable ? "自动核验暂时失败，可重试" : "自动核验未完成，需要人工确认"}</strong><span>${escapeHtml(outcome ? readableLabel(outcome, IDENTITY_OUTCOME_LABELS) : "自动核验服务暂不可用")}</span></div>
        ${automaticOperation.retryable ? `<div class="replica-acquisition-review-actions"><button type="button" data-acquisition-detail-action="retry-identity-resolution">重试自动核验</button></div>` : ""}
        ${renderAutomaticIdentityEvidence(automaticOperation)}
        ${renderManualIdentityVerificationForm(candidate, state, automaticOperation)}
      </section>
    `;
  }
  return `
    <section class="replica-acquisition-detail-section replica-acquisition-identity-section">
      <h5>主体核验</h5>
      ${renderManualIdentityVerificationForm(candidate, state, automaticOperation)}
    </section>
  `;
}

function reviewButton(
  action: string,
  className = "",
  disabled = false
): string {
  return `<button type="button" class="${className}" data-acquisition-detail-action="review" data-review-action="${action}"${disabled ? " disabled" : ""}>${escapeHtml(readableLabel(action, REVIEW_ACTION_LABELS))}</button>`;
}

function renderReviewActions(
  candidate: DataRecord,
  qualification: DataRecord | null,
  operation: DataRecord | null,
  identityResolutionOperation: CandidateDouyinIdentityResolutionOperation | null
): string {
  if (qualification === null) {
    return renderIntelligenceAction(
      candidate,
      operation,
      identityResolutionOperation
    );
  }
  const status = textValue(candidate.status, "normalized");
  const hardGateFailures = strings(qualification.hardGateFailures);
  if (status === "pending_review") {
    return `
      <form class="replica-acquisition-review-form" data-acquisition-detail-form="review">
        ${hardGateFailures.length > 0
          ? `<div class="replica-acquisition-review-note is-warning">当前命中 ${hardGateFailures.length} 项硬门禁，不能批准跟进；可驳回或补充研究。</div>`
          : `<div class="replica-acquisition-review-note">AI 只提供建议。请人工核对证据后作出最终决定。</div>`}
        <label><span>审核原因或补充说明</span><textarea name="reviewReason" maxlength="2000" placeholder="驳回、补充研究时必须填写原因"></textarea></label>
        <div class="replica-acquisition-review-actions">
          ${reviewButton("approved", "is-primary", hardGateFailures.length > 0)}
          ${reviewButton("needs_research")}
          ${reviewButton("rejected")}
          ${reviewButton("do_not_contact", "is-danger")}
        </div>
      </form>
    `;
  }
  if (status === "rejected") {
    return `
      <form class="replica-acquisition-review-form" data-acquisition-detail-form="review">
        <div class="replica-acquisition-review-note">候选已被驳回。只有出现新的公开证据后，服务端才会允许重新研判。</div>
        <label><span>重开原因</span><textarea name="reviewReason" maxlength="2000" required placeholder="说明新增证据或重开理由"></textarea></label>
        <div class="replica-acquisition-review-actions">${reviewButton("reopen", "is-primary")}</div>
      </form>
    `;
  }
  return `<div class="replica-acquisition-review-note">当前候选状态：${escapeHtml(status)}。此状态没有可提交的人工审核动作。</div>`;
}

function renderPrivateDomainHandoff(
  candidate: DataRecord,
  detail: AcquisitionCandidateDetail | null
): string {
  const statusResult = detail?.privateDomainHandoff;
  if (statusResult && "handoff" in statusResult) {
    const completed = statusResult;
    const handoff = completed.handoff;
    const dueAt = textValue(completed.todo.dueAt, "待确认");
    const attributionMissing = !textValue(handoff.runId, "")
      || !textValue(handoff.discoveredEventId, "");
    const recoveryAction = attributionMissing
      ? completed.recovery
        ? `<button type="button" data-acquisition-detail-action="open-private-domain-handoff">验证并补全历史归因</button>`
        : `<span class="replica-acquisition-review-note is-warning">历史归因不可验证，不能创建获客绑定商机</span>`
      : "";
    return `
      <div class="replica-acquisition-handoff-complete" data-private-domain-handoff-id="${escapeHtml(handoff.id)}">
        <strong>已完成 CRM/私域交接</strong>
        <dl>
          <div><dt>Lead ID</dt><dd>${escapeHtml(handoff.leadId)}</dd></div>
          <div><dt>Customer ID</dt><dd>${escapeHtml(handoff.customerId)}</dd></div>
          <div><dt>Todo ID</dt><dd>${escapeHtml(handoff.todoId)}</dd></div>
          <div><dt>首次跟进时间</dt><dd>${escapeHtml(dueAt)}</dd></div>
        </dl>
        <div class="replica-acquisition-review-actions">
          <a href="#private-domain" data-private-domain-customer-id="${escapeHtml(handoff.customerId)}">查看客户</a>
          <a href="#private-domain" data-private-domain-customer-id="${escapeHtml(handoff.customerId)}" data-todo-id="${escapeHtml(handoff.todoId)}">查看待办</a>
          <button type="button" data-acquisition-detail-action="open-quote-workbench"
            data-candidate-id="${escapeHtml(candidate.id)}"
            data-customer-id="${escapeHtml(handoff.customerId)}">打开报价工作台</button>
          ${recoveryAction}
        </div>
      </div>
    `;
  }
  const status = textValue(candidate.status, "");
  if (status !== "approved" && status !== "converted_to_lead") return "";
  const pending = statusResult && "inProgress" in statusResult
    ? statusResult.inProgress
    : null;
  const label = pending || status === "converted_to_lead"
    ? "继续完成私域交接"
    : "交接至 CRM/私域";
  const description = pending
    ? `已恢复原交接请求（阶段：${escapeHtml(pending.stage)}；跟进时间：${escapeHtml(pending.request.followUp.dueAt)}）。`
    : "交接后将创建或关联真实客户，并创建一条关联的首次跟进待办。";
  return `
    <div class="replica-acquisition-intelligence-start">
      <div><strong>${label}</strong><span>${description}</span></div>
      <button type="button" data-acquisition-detail-action="open-private-domain-handoff">${label}</button>
    </div>
  `;
}

function renderHandoffDialog(
  dialog: AcquisitionHandoffDialogState | null | undefined
): string {
  if (!dialog?.open) return "";
  const dueDate = new Date(dialog.followUp.dueAt);
  const dueAt = Number.isFinite(dueDate.getTime())
    ? new Date(
        dueDate.getTime() - dueDate.getTimezoneOffset() * 60_000
      ).toISOString().slice(0, 16)
    : dialog.followUp.dueAt.slice(0, 16);
  return `
    <dialog class="replica-acquisition-handoff-dialog" open aria-labelledby="acquisition-handoff-title">
      <form data-acquisition-detail-form="private-domain-handoff">
        <header>
          <div><span>CRM/私域</span><h4 id="acquisition-handoff-title">交接真实候选</h4></div>
          <button type="button" data-acquisition-detail-action="close-private-domain-handoff"${dialog.busy ? " disabled" : ""}>关闭</button>
        </header>
        ${dialog.recovering ? "<p>正在继续服务端已保留的原交接请求；为避免重复或改写目标，本次参数不可编辑。</p>" : ""}
        <p>固定获客来源：Run <code>${escapeHtml(dialog.runId)}</code> · 发现事件 <code>${escapeHtml(dialog.discoveredEventId)}</code></p>
        <fieldset${dialog.busy || dialog.recovering ? " disabled" : ""}>
          <legend>交接模式</legend>
          <label><input type="radio" name="handoffMode" value="create_new"${dialog.mode === "create_new" ? " checked" : ""}> 创建新客户</label>
          <label><input type="radio" name="handoffMode" value="link_existing"${dialog.mode === "link_existing" ? " checked" : ""}> 关联已有客户</label>
          <label><span>已有 Customer ID</span><input name="existingCustomerId" maxlength="255" value="${escapeHtml(dialog.existingCustomerId)}"${dialog.mode === "link_existing" ? " required" : ""}></label>
          <label><span>首次跟进标题</span><input name="followUpTitle" maxlength="500" required value="${escapeHtml(dialog.followUp.title)}"></label>
          <label><span>首次跟进时间</span><input name="followUpDueAt" type="datetime-local" required value="${escapeHtml(dueAt)}"></label>
          <label><span>优先级</span><select name="followUpPriority">
            ${(["high", "medium", "normal"] as const).map((priority) =>
              `<option value="${priority}"${dialog.followUp.priority === priority ? " selected" : ""}>${priority === "high" ? "高" : priority === "medium" ? "中" : "普通"}</option>`
            ).join("")}
          </select></label>
        </fieldset>
        <footer><button type="submit"${dialog.busy ? " disabled" : ""}>${dialog.busy ? "正在交接…" : dialog.recovering ? "继续原交接" : "确认交接"}</button></footer>
      </form>
    </dialog>
  `;
}

function renderCandidateDetail(
  event: DataRecord | undefined,
  detail: AcquisitionCandidateDetail | null,
  identityVerification?: AcquisitionIdentityVerificationState | null,
  visualArtifact?: AcquisitionVisualArtifactState | null
): string {
  const candidate = detail?.candidate ?? record(event?.candidate);
  if (candidate === null) {
    return `
      <div class="replica-acquisition-detail-state">
        <strong>请选择一个候选</strong>
        <span>选择后可查看资格理由、信号、硬门禁与财务价值。</span>
      </div>
    `;
  }
  const candidateId = candidateEventId(event ?? {}) || textValue(candidate.id);
  const candidateSnapshot = candidate;
  const qualification = detail
    ? detail.qualification
    : record(event?.qualification);
  const financial = detail
    ? detail.financialValue
    : record(event?.financialValue);
  return `
    <article class="replica-acquisition-selected-candidate" data-selected-candidate-id="${escapeHtml(candidateId)}">
      <header>
        <div><span>${candidateSubjectLabel(candidate.subjectKind)}</span><h4>${escapeHtml(textValue(candidate.displayName, textValue(candidate.publicDisplayName, "未命名候选")))}</h4></div>
        <strong>${qualification ? `意向等级 ${escapeHtml(textValue(qualification.grade))}` : "意向待评估"}</strong>
      </header>
      ${qualification === null ? `
        <div class="replica-acquisition-detail-empty-value">该候选尚未完成资格研判。</div>
      ` : `
        <div class="replica-acquisition-detail-grid">
          <section><h5>资格理由</h5><ul>${renderReasons(qualification.reasons)}</ul></section>
          <section><h5>正向信号</h5><ul>${renderSignals(qualification.positiveSignals, "暂无正向信号")}</ul></section>
          <section><h5>负向信号</h5><ul>${renderSignals(qualification.negativeSignals, "暂无负向信号")}</ul></section>
          <section><h5>硬门禁</h5><ul>${renderHardGates(qualification.hardGateFailures)}</ul></section>
        </div>
        <p class="replica-acquisition-qualification-meta">${decisionEngineLabel(qualification.decisionEngine)} · ${finiteNumber(qualification.score)} 分 · 置信度 ${Math.round(finiteNumber(qualification.confidence) * 100)}%</p>
      `}
      <section class="replica-acquisition-detail-section">
        <h5>财务价值</h5>
        ${renderFinancialDetail(financial)}
      </section>
      <section class="replica-acquisition-detail-section">
        <h5>公开证据链</h5>
        ${renderEvidenceDetail(detail?.evidence ?? [], visualArtifact)}
      </section>
      <section class="replica-acquisition-detail-section">
        <h5>客户作战建议</h5>
        ${renderBattleCard(detail?.battleCard ?? null)}
      </section>
      ${renderIdentityVerificationWorkbench(
        candidateSnapshot,
        identityVerification,
        detail?.identityResolutionOperation ?? null
      )}
      <section class="replica-acquisition-detail-section replica-acquisition-review-section">
        <h5>人工审核</h5>
        ${renderReviewActions(
          candidateSnapshot,
          qualification,
          detail?.intelligenceOperation ?? null,
          detail?.identityResolutionOperation ?? null
        )}
      </section>
      <section class="replica-acquisition-detail-section replica-acquisition-handoff-section">
        <h5>CRM/私域交接</h5>
        ${renderPrivateDomainHandoff(candidateSnapshot, detail)}
      </section>
      <section class="replica-acquisition-detail-section">
        <h5>审核历史</h5>
        ${renderReviewHistory(detail?.reviews ?? [])}
      </section>
    </article>
  `;
}

function renderCandidateSummary(summary: DataRecord | null): string {
  if (summary === null) return "";
  const revenues = records(summary.expectedRevenueByCurrency);
  const revenueText = revenues.length === 0
    ? "预计收入待评估"
    : revenues.map((item) => formatMinorAmount(item.currency, item.amountMinor)).join(" · ");
  return `
    <div class="replica-acquisition-candidate-summary" aria-label="候选统计">
      <span>已搜索来源 ${finiteNumber(summary.sourcesSearched)}</span>
      <span>已分析页面 ${finiteNumber(summary.pagesAnalyzed)}</span>
      <span>发现主体 ${finiteNumber(summary.organizationsFound)}</span>
      <span>去重候选 ${finiteNumber(summary.dedupedCandidates)}</span>
      <span>有效商机 ${finiteNumber(summary.validOpportunities)}</span>
      <span>高意向 ${finiteNumber(summary.highIntent)}</span>
      <span>${escapeHtml(revenueText)}</span>
    </div>
  `;
}

function renderCandidatePanel(state: AcquisitionDetailCenterState): string {
  const detail = state.detail;
  if (detail === null) {
    const candidateId = state.selectedCandidateId;
    if (!candidateId) return "";
    const candidate = state.candidateDetail?.candidate ?? { id: candidateId };
    const event = { candidateId, candidate };
    return `
      <section class="replica-acquisition-detail-panel" id="acquisition-detail-panel-candidates" role="tabpanel" aria-labelledby="acquisition-detail-tab-candidates" data-acquisition-detail-panel="candidates">
        <div class="replica-acquisition-review-note">该候选来自用户导入的公开线索，可先独立完成主体核验，无需预先创建获客任务。</div>
        <div class="replica-acquisition-candidate-layout is-standalone">
          <div class="replica-acquisition-candidate-inspector">
            ${renderCandidateDetail(
              event,
              state.candidateDetail,
              state.identityVerification,
              state.visualArtifact
            )}
          </div>
        </div>
      </section>
    `;
  }
  const latestRun = record(detail.latestRun);
  if (latestRun === null) {
    return `
      <section class="replica-acquisition-detail-panel" id="acquisition-detail-panel-candidates" role="tabpanel" aria-labelledby="acquisition-detail-tab-candidates" data-acquisition-detail-panel="candidates">
        <div class="replica-acquisition-detail-state" role="status">
          <strong>任务尚未运行</strong>
          <span>启动真实运行后，候选与研判结果会显示在这里。</span>
        </div>
      </section>
    `;
  }
  const presentation = record(detail.presentation);
  const events = records(presentation?.candidateEvents);
  const runStatus = textValue(latestRun.status, "queued");
  const active = ACTIVE_RUN_STATUSES.has(runStatus);
  const paused = runStatus === "paused";
  const selectedInspector = state.selectedCandidateId && state.candidateDetail
    ? `<div class="replica-acquisition-candidate-inspector">${renderCandidateDetail(
      undefined,
      state.candidateDetail,
      state.identityVerification,
      state.visualArtifact
    )}</div>`
    : "";
  if (events.length === 0) {
    const evidenceCount = finiteNumber(latestRun.evidenceCount);
    const emptyTitle = active
      ? "运行中，尚未形成候选"
      : paused
        ? "运行已暂停，当前尚无候选"
        : "运行已结束，未发现符合条件的候选";
    const emptyDetail = active
      ? "，系统仍在去重和研判。"
      : paused
        ? "，继续运行后将接着去重和研判。"
        : "，但没有候选通过当前筛选条件。";
    return `
      <section class="replica-acquisition-detail-panel" id="acquisition-detail-panel-candidates" role="tabpanel" aria-labelledby="acquisition-detail-tab-candidates" data-acquisition-detail-panel="candidates">
        ${renderCandidateSummary(record(presentation?.summary))}
        <div class="replica-acquisition-detail-state" role="status">
          <strong>${emptyTitle}</strong>
          <span>已发现 ${evidenceCount} 条公开证据${emptyDetail}</span>
        </div>
        ${selectedInspector}
      </section>
    `;
  }
  const selectedEvent = events.find((event) =>
    candidateEventId(event) === state.selectedCandidateId
  );
  return `
    <section class="replica-acquisition-detail-panel" id="acquisition-detail-panel-candidates" role="tabpanel" aria-labelledby="acquisition-detail-tab-candidates" data-acquisition-detail-panel="candidates">
      ${renderCandidateSummary(record(presentation?.summary))}
      <div class="replica-acquisition-candidate-layout">
        <div class="replica-acquisition-candidate-list" aria-label="候选列表">
          ${renderCandidateList(events, state.selectedCandidateId)}
        </div>
        <div class="replica-acquisition-candidate-inspector">
          ${renderCandidateDetail(
            selectedEvent,
            state.candidateDetail,
            state.identityVerification,
            state.visualArtifact
          )}
        </div>
      </div>
      ${presentation?.hasMore === true ? `
        <div class="replica-acquisition-candidate-pagination">
          <span>已加载 ${events.length} 条候选</span>
          <button type="button" data-acquisition-detail-action="load-more-candidates"${state.loadingMoreCandidates ? " disabled" : ""}>
            ${state.loadingMoreCandidates ? "正在加载…" : "加载更多候选"}
          </button>
        </div>
      ` : ""}
    </section>
  `;
}

export function renderAcquisitionDetailCenter(
  state: AcquisitionDetailCenterState
): string {
  const statusMessage = renderStateMessage(state);
  const content = statusMessage ?? (state.mode === "plan"
    ? renderPlanOverview(state.detail as AcquisitionTaskDetail, state)
    : renderCandidatePanel(state));
  return `
    <section
      class="replica-acquisition-detail-view"
      data-acquisition-detail-mode="${state.mode}"
      data-acquisition-detail-status="${state.status}"
      aria-busy="${state.status === "loading"}"
    >
      ${renderTabs(state.mode)}
      ${state.message && state.status === "ready"
        ? `<div class="replica-acquisition-detail-message" role="status">${escapeHtml(state.message)}</div>`
        : ""}
      ${state.error && state.status === "ready"
        ? `<div class="replica-acquisition-detail-message is-error" role="alert">${escapeHtml(state.error)}</div>`
        : ""}
      ${content}
      ${renderHandoffDialog(state.handoffDialog)}
    </section>
  `;
}
