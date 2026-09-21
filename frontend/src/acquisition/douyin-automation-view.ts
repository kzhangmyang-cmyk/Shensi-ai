import {
  type DouyinAutomationController, type DouyinAutomationDraft,
  type DouyinAutomationState } from "./douyin-automation-controller";
import {
  isDouyinCommentOutreachCandidate,
  type DouyinLoginInteraction,
  type DouyinLoginKey,
  type DouyinPolicyInput,
  type DouyinRunCandidate
} from "./douyin-automation-api";
import { connectorCopy, getInstalledDesktopRuntime } from "../desktop/desktop-runtime";
import { mountDesktopAccountStatus, type DesktopAccountUiRuntime } from "../desktop/desktop-account-status-view";
import { patchStableView } from "../desktop/stable-view";
import { acquisitionCandidateDetailRequest } from "./detail-center-entry";

const escape = (value: string) => value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
const stateLabel: Record<string, string> = { awaiting_scan: "等待登录", active: "已连接", login_expired: "登录已失效", risk_paused: "风险暂停", disconnected: "未连接" };
const runLabel: Record<string, string> = { scheduled: "已排期", queued: "排队中", running: "采集中", succeeded: "已完成", partial: "部分完成", paused: "已安全暂停", cancelled: "已取消", failed: "采集失败" };
const phaseLabel: Record<string, string> = { queued: "排队中", starting_browser: "正在启动浏览器", opening_douyin: "正在打开抖音", searching: "正在搜索", collecting_comments: "正在采集评论", finalizing: "正在整理候选人", completed: "采集完成" };
const browserModeLabel: Record<string, string> = { visible: "可视窗口已打开", headless: "后台浏览器运行中" };
const terminalRunStates = new Set(["succeeded", "partial", "paused", "cancelled", "failed"]);
const loginKeys = new Set<DouyinLoginKey>([
  "Enter", "Tab", "Backspace", "Escape",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"
]);
const renderedActivitySequence = Symbol("renderedActivitySequence");
const renderedErrorCode = Symbol("renderedErrorCode");
const renderedQueuedRunToken = Symbol("renderedQueuedRunToken");
type ObservationHost = HTMLElement & {
  [renderedActivitySequence]?: number | null;
  [renderedErrorCode]?: string | null;
  [renderedQueuedRunToken]?: string | null;
};

function activityBrowserLabel(phase: string, browserMode: string): string {
  if (phase === "completed") return "浏览器采集已结束";
  return phase === "queued" ? "等待浏览器启动" : browserModeLabel[browserMode] ?? browserMode;
}

function localizedCrawlerError(code: string, state: string): string {
  const known: Record<string, string> = {
    crawler_candidate_budget_exhausted: "该历史运行曾因旧候选额度结束；新采集不再受此额度限制。",
    mediacrawler_partial: "采集已部分完成，请检查公开记录后再继续。",
    crawler_ingestion_failed: "候选人整理失败，请稍后重试或联系管理员。",
    crawler_ingestion_lease_expired: "候选人整理等待超时，请稍后重试。",
    crawler_lease_expired: "采集任务等待超时，请稍后重试。",
    mediacrawler_job_paused: "采集已安全暂停，请检查后再继续。",
    mediacrawler_job_failed: "采集失败，请稍后重试或联系管理员。"
  };
  if (known[code]) return known[code];
  return state === "partial"
    ? "采集已部分完成，请检查公开记录后再继续。"
    : "采集遇到问题，请稍后重试或联系管理员。";
}

function candidateKind(candidate: DouyinRunCandidate): string {
  return /comment/iu.test(candidate.status) ? "需求评论者" : /creator/iu.test(candidate.status) ? "内容创作者" : "公开候选人";
}

function saveDisabledReason(state: DouyinAutomationState, planName: string, keywords: string[]): string | null {
  if (!state.account || state.account.state !== "active") return "请先连接抖音账号";
  if (state.phase === "saving") return "正在保存计划…";
  if (state.phase === "running") return "正在启动或运行采集…";
  if (state.activeRunId && (!state.crawlerStatus
    || state.crawlerStatus.runId !== state.activeRunId)) return "等待服务器返回首次观测状态";
  if (state.crawlerStatus && (!terminalRunStates.has(state.crawlerStatus.state)
    || state.crawlerStatus.candidateProjectionState === "pending")) return "当前采集尚未结束";
  if (!planName.trim()) return "请输入计划名称";
  if (!keywords.some((keyword) => keyword.trim())) return "至少添加 1 个关键词";
  return null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isLoginKey(value: string): value is DouyinLoginKey {
  return loginKeys.has(value as DouyinLoginKey);
}

function closeDialog(dialog: HTMLDialogElement | null): void {
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function loginFailureCopy(
  code: NonNullable<NonNullable<DouyinAutomationState["loginSession"]>["failureCode"]>
): string {
  const copy = {
    douyin_login_ui_unsupported: "当前抖音登录页暂不受支持，请关闭后重新打开；若仍失败，请联系管理员更新登录适配。",
    douyin_verification_required: "抖音要求完成安全验证，请重新打开登录页并按页面提示完成验证。",
    douyin_login_page_unavailable: "无法读取抖音登录页面，请关闭后重试。",
    douyin_login_page_not_allowed: "抖音登录页面拒绝访问，请检查网络或账号环境后重试。",
    douyin_browser_unavailable: "安全登录环境暂时不可用，请关闭后重试。",
    douyin_browser_command_timeout: "登录页响应超时，请关闭后重新打开登录页。",
    douyin_login_open_failed: "抖音登录页打开失败，请关闭后重试。"
  } as const;
  return copy[code];
}

function qrStatusCopy(
  status: NonNullable<DouyinAutomationState["loginSession"]>["qrStatus"]
): string {
  const copy = {
    opening: "正在打开抖音登录页并生成二维码…",
    ready: "二维码已就绪，请使用抖音 App 扫码。",
    expired: "二维码已失效，请点击“刷新二维码”。",
    network_error: "二维码请求失败，请检查网络后重试。",
    verification_required: "抖音要求完成安全验证，请在登录窗口中按提示处理。"
  } as const;
  return status ? copy[status] : "正在读取二维码状态…";
}

export function douyinLiveLoginHash(sessionId: string): string {
  return `#douyin-live-login?sessionId=${encodeURIComponent(sessionId)}`;
}

export interface DouyinAutomationViewOptions {
  desktopRuntime?: DesktopAccountUiRuntime | null;
  mountLiveLogin?: (
    host: HTMLElement,
    sessionId: string
  ) => (() => void) | Promise<() => void>;
}

async function mountDefaultLiveLogin(
  host: HTMLElement,
  sessionId: string
): Promise<() => void> {
  const { mountEmbeddedDouyinLiveLogin } = await import("./douyin-live-login-entry");
  return mountEmbeddedDouyinLiveLogin(host, sessionId);
}

function loginDialog(state: DouyinAutomationState): string {
  const session = state.loginSession;
  if (!session) return "";
  const awaiting = session.state === "awaiting_scan";
  const failure = session.failureCode;
  if (session.interactionSurface === "external_window") {
    const title = failure ? "抖音登录未完成"
      : session.state === "active" ? "账号已连接"
        : session.state === "login_expired" ? "登录已过期" : "在外部浏览器完成登录";
    const status = failure
      ? loginFailureCopy(failure)
      : session.state === "active"
        ? "登录已保存，登录窗口已自动关闭。"
      : session.runtimeState === "starting"
        ? "正在打开外部浏览器…"
        : session.runtimeState === "crashed"
          ? session.diagnostic?.message ?? "外部浏览器已意外关闭，请重新打开登录页。"
          : session.authState === "verification_required"
            ? "抖音要求完成安全验证，请在外部浏览器中按提示处理。"
            : session.authState === "authenticated"
              ? "登录已确认，正在绑定账号。"
              : session.state === "login_expired"
                ? "登录会话已过期，请重新打开登录页。"
                : "已打开外部浏览器，请在浏览器中完成登录。";
    const actions = awaiting && !failure
      ? `<button type="button" class="primary" data-douyin-action="confirm-login" ${state.interactionPending ? "disabled" : ""}>${state.interactionPending ? "正在检测…" : "我已完成登录，重新检测"}</button><button type="button" class="secondary" data-douyin-action="cancel-login">取消登录</button>`
      : session.state === "active"
        ? `<button type="button" class="secondary" data-douyin-action="close-login">关闭</button>`
        : `<button type="button" class="primary" data-douyin-action="create-session">重新打开登录页</button><button type="button" class="secondary" data-douyin-action="cancel-login">取消</button>`;
    return `<dialog class="douyin-login-dialog" open aria-labelledby="douyinLoginTitle"><div><span class="douyin-eyebrow">EXTERNAL LOGIN</span><h3 id="douyinLoginTitle">${title}</h3><p class="douyin-login-status" role="status" aria-live="polite">${escape(status)}</p><p class="douyin-login-help">此登录由本机独立浏览器窗口完成；本页无需二维码截图或远程画面。</p><div class="douyin-actions">${actions}</div></div></dialog>`;
  }
  const title = failure ? "抖音登录未完成"
    : awaiting ? "打开抖音登录页"
      : session.state === "active" ? "账号已连接" : "登录已过期";
  const status = failure
    ? loginFailureCopy(failure)
    : awaiting
      ? qrStatusCopy(session.qrStatus)
      : escape(stateLabel[session.state] ?? session.state);
  const page = session.loginPage;
  const liveLoginLink = awaiting && !failure
    ? `<a class="secondary douyin-action-link" data-douyin-live-login href="${escape(douyinLiveLoginHash(session.id))}" target="_blank" rel="noopener noreferrer">在新标签页打开（备用）</a>`
    : "";
  const embeddedLiveLogin = awaiting && !failure
    ? `<section class="douyin-embedded-live-login-slot" data-douyin-live-login-slot aria-label="可交互的抖音登录窗口"><div class="douyin-login-page-loading" role="status">正在加载安全登录窗口…</div></section>`
    : "";
  const readyQr = awaiting && !failure && session.qrStatus === "ready"
    && session.qrImageDataUrl
    ? `<figure class="douyin-login-qr" data-douyin-login-qr><img src="${escape(session.qrImageDataUrl)}" alt="可使用抖音 App 扫描的登录二维码"><figcaption>无需操作远程画面，直接使用抖音 App 扫码</figcaption></figure>`
    : "";
  const compatibilityCaptureStatus = session.qrStatus === "opening"
    ? "正在载入抖音登录页…"
    : "兼容截图暂不可用，可继续使用安全登录窗口/二维码状态";
  const fallback = !failure && page
    ? `<details class="douyin-login-fallback" data-douyin-login-fallback><summary>备用：使用截图控制登录</summary><div class="douyin-login-surface" data-douyin-login-surface role="application" aria-label="抖音登录页面交互画面" aria-busy="${state.interactionPending ? "true" : "false"}" tabindex="0" style="aspect-ratio:${page.width}/${page.height}"><img src="${escape(page.imageDataUrl)}" width="${page.width}" height="${page.height}" draggable="false" alt="抖音登录页面实时画面">${state.interactionPending ? `<span class="douyin-login-busy">操作处理中…</span>` : ""}</div><p class="douyin-login-help">仅在真实登录窗口不可用时使用；可点击画面、输入文字或使用 Enter、Tab、方向键与滚轮。</p></details>`
    : !failure && awaiting
      ? `<details class="douyin-login-fallback" data-douyin-login-fallback><summary>备用：使用截图控制登录</summary><div class="douyin-login-page-loading" role="status">${compatibilityCaptureStatus}</div></details>`
      : "";
  const sessionActions = awaiting && !failure
    ? `<button type="button" class="primary" data-douyin-action="refresh-qr" ${state.interactionPending ? "disabled" : ""}>${state.interactionPending ? "正在刷新…" : "刷新二维码"}</button><button type="button" class="secondary" data-douyin-action="create-session" ${state.connectionPending || session.qrStatus === "opening" ? "disabled" : ""}>${session.qrStatus === "opening" ? "登录环境启动中…" : "创建新登录会话"}</button>`
    : session.state === "login_expired" || failure
      ? `<button type="button" class="primary" data-douyin-action="create-session">创建新登录会话</button>`
      : "";
  return `<dialog class="douyin-login-dialog" open aria-labelledby="douyinLoginTitle"><div><span class="douyin-eyebrow">SECURE LOGIN PAGE</span><h3 id="douyinLoginTitle">${title}</h3><p class="douyin-login-status" role="status" aria-live="polite">${status}</p>${readyQr}${embeddedLiveLogin}${liveLoginLink ? `<p class="douyin-login-help">“刷新二维码”只更新二维码；画面断开时使用窗口内的“重新连接画面”。新标签页仅作备用。</p><div class="douyin-actions douyin-login-primary-actions">${liveLoginLink}</div>` : ""}${fallback}<div class="douyin-actions">${sessionActions}<button type="button" class="secondary" data-douyin-action="close-login">关闭</button></div></div></dialog>`;
}

function formDraft(form: HTMLFormElement, state: DouyinAutomationState): DouyinAutomationDraft {
  const data = new FormData(form);
  const newKeyword = String(data.get("newKeyword") ?? "").trim();
  const keywordInputs = [...form.querySelectorAll<HTMLInputElement>("[data-douyin-keyword]")]
    .map((input) => input.value.trim()).filter(Boolean);
  return {
    planName: String(data.get("planName") ?? "").trim(),
    policy: {
      keywords: [...new Set([...keywordInputs, ...(newKeyword ? [newKeyword] : [])])],
      schedule: { enabled: data.get("scheduleEnabled") === "on", localTime: String(data.get("localTime")), timeZone: String(data.get("timeZone")) },
      dailyCandidateLimit: state.draftPolicy.dailyCandidateLimit,
      collectCreators: data.get("collectCreators") === "on",
      collectDemandComments: data.get("collectDemandComments") === "on",
      limits: { ...state.draftPolicy.limits, maxComments: Number(data.get("maxComments") ?? 100) }
    }
  };
}

export function renderDouyinAutomationView(host: HTMLElement, state: DouyinAutomationState,
  inspectedCandidateId: string | null = null): void {
  const policy = state.policy;
  const account = state.account;
  const session = state.loginSession;
  const hasOutstandingRun = Boolean(state.runIntent && (!state.crawlerStatus
    || state.crawlerStatus.runId !== state.runIntent.acquisitionRunId));
  const status = hasOutstandingRun ? null : state.crawlerStatus;
  const localStatus = status && !terminalRunStates.has(status.state)
    ? state.localCrawlerStatus : null;
  const activity = localStatus?.activity ?? status?.activity;
  const localEnded = localStatus && terminalRunStates.has(localStatus.state);
  const interrupted = status && ["cancelled", "failed", "paused"].includes(status.state);
  const activityTitle = localStatus?.controlState === "paused" && !localEnded ? "已暂停，保留当前进度"
    : localStatus?.controlState === "pausing" && !localEnded ? "正在暂停"
    : localStatus?.controlState === "stopping" && !localEnded ? "正在保存结果并停止"
    : interrupted ? runLabel[status.state]! : localEnded ? "本机采集结束，等待结果入库"
    : activity ? phaseLabel[activity.phase] ?? activity.phase : "";
  const activityWindow = interrupted ? "本次采集已停止" : localEnded ? "本机采集已结束"
    : activity ? activityBrowserLabel(activity.phase, activity.browserMode) : "";
  const currentKeyword = interrupted ? activity?.currentKeyword ?? "未执行" : activity?.currentKeyword
    ?? (activity?.phase === "completed" ? "本轮关键词已处理完毕" : "等待分配关键词");
  const historicalRun = state.historicalRun === true && !hasOutstandingRun;
  const activityHost = host as ObservationHost;
  const activitySequence = activity?.sequence ?? null;
  const activityLive = activitySequence !== null && activityHost[renderedActivitySequence] !== activitySequence
    ? "polite" : "off";
  activityHost[renderedActivitySequence] = activitySequence;
  const errorCode = status?.lastErrorCode ?? null;
  const errorLive = errorCode !== null && activityHost[renderedErrorCode] !== errorCode ? "polite" : "off";
  activityHost[renderedErrorCode] = errorCode;
  const queuedRunToken = hasOutstandingRun && state.runIntent
    ? `${state.runIntent.id}:${state.runIntent.acquisitionRunId}` : null;
  const queuedLive = queuedRunToken !== null && activityHost[renderedQueuedRunToken] !== queuedRunToken
    ? "polite" : "off";
  activityHost[renderedQueuedRunToken] = queuedRunToken;
  const candidates = hasOutstandingRun ? [] : state.candidates;
  const selected = new Set(state.selectedCandidateIds);
  const inspector = candidates.find((candidate) => candidate.id === inspectedCandidateId)
    ?? candidates.find((candidate) => selected.has(candidate.id)) ?? candidates[0] ?? null;
  const draft = state.draftPolicy;
  const keywordInputs = draft.keywords.map((keyword, index) => `<label class="douyin-keyword"><span class="sr-only">关键词 ${index + 1}</span><input data-douyin-keyword value="${escape(keyword)}" maxlength="100"><button type="button" data-douyin-action="remove-keyword" aria-label="删除关键词 ${escape(keyword)}">×</button></label>`).join("");
  const disabledReason = saveDisabledReason(state, state.planName, draft.keywords);
  const suggestionDisabled = !state.planId || !policy || ["loading", "saving", "running"].includes(state.phase);
  const errorRetryAction = state.errorRetry === "reconnect" ? "connect"
    : state.errorRetry === "cancel" ? "cancel-login" : "retry";
  const errorRetryLabel = state.errorRetry === "reconnect" ? "重新打开登录页"
    : state.errorRetry === "cancel" ? "重试取消登录" : "重试";
  const connector = state.connectorStatus;
  const connectorStatus = connector ? connectorCopy(connector) : null;
  patchStableView(host, `
    <section class="douyin-control-stack" aria-label="抖音自动获客控制台" data-phase="${state.phase}">
      <header class="douyin-control-hero">
        <div><span class="douyin-eyebrow">AUTOMATIC ACQUISITION</span><h2>抖音自动获客</h2><p>服务器定时采集公开内容，每个外联批次都需要人工确认。</p></div>
        <span class="douyin-live-pill ${account?.state === "active" ? "is-live" : ""}">${escape(account ? stateLabel[account.state] ?? account.state : "未连接")}</span>
      </header>
      ${connector && connectorStatus ? `<div class="douyin-inline-status ${connector.state === "crashed" ? "is-warning" : ""}" role="status" data-douyin-connector-state="${connector.state}"><strong>${escape(connectorStatus.title)}</strong>${connector.diagnostic?.message ? `<span>${escape(connector.diagnostic.message)}</span>` : ""}${connectorStatus.action ? `<button type="button" class="secondary" data-douyin-action="restart-connector">${escape(connectorStatus.action)}</button>` : ""}</div>` : ""}
      ${state.error ? `<div class="douyin-alert" role="alert" tabindex="-1">${escape(state.error)}${state.phase === "error" ? `<button type="button" data-douyin-action="${errorRetryAction}">${errorRetryLabel}</button>` : ""}</div>` : ""}
      <div class="douyin-setup-grid">
        <article class="douyin-panel douyin-account-card">
          <div class="douyin-panel-title"><span class="douyin-step">01</span><div><h3>抖音账号</h3><p>一个工作区连接一个专用账号</p></div></div>
          ${account ? `<div class="douyin-account-identity"><span class="douyin-account-mark">抖</span><div><strong>${escape(account.displayName ?? "已连接抖音账号")}</strong><span>状态：${escape(stateLabel[account.state] ?? account.state)}</span><small>最近校验 ${account.lastValidatedAt ? escape(new Date(account.lastValidatedAt).toLocaleString("zh-CN", { hour12: false })) : "待校验"}</small></div></div>` : `<div class="douyin-empty"><strong>连接抖音账号</strong><p>打开登录页后即可设置自动采集。凭据不会返回浏览器。</p></div>`}
          <div class="douyin-actions">${account && account.state === "active" ? `<button type="button" class="secondary" data-douyin-action="disconnect">断开连接</button>` : `<button type="button" class="primary" data-douyin-action="connect" ${state.connectionPending ? "disabled" : ""}>${state.connectionPending ? "正在打开…" : account ? "重新打开抖音登录页" : "打开抖音登录页"}</button>`}</div>
        </article>
        <article class="douyin-panel douyin-policy-card">
          <div class="douyin-panel-title"><span class="douyin-step">02</span><div><h3>MediaCrawler 采集计划</h3><p>${state.planId ? `当前计划：${escape(state.planName || state.planId)}` : "尚未保存"}</p></div></div>
          <form data-douyin-policy-form>
            <label class="douyin-plan-name"><span>计划名称</span><input name="planName" value="${escape(state.planName)}" maxlength="200" placeholder="例如：工业除尘需求获客" required></label>
            <div class="douyin-field-head"><div><label>手工关键词</label><small>手工关键词无需搜索 API 或 AI 模型。</small></div><button type="button" class="text-button" data-douyin-action="suggest" ${suggestionDisabled ? "disabled" : ""}>AI 智能生成（可选）</button></div>
            <div class="douyin-keywords" data-douyin-keywords>${keywordInputs}<label class="douyin-keyword is-new"><span class="sr-only">新关键词</span><input name="newKeyword" data-douyin-new-keyword placeholder="+添加关键词" maxlength="100"></label></div>
            ${state.suggestionError ? `<p class="douyin-inline-status is-warning" role="status">${escape(state.suggestionError)}</p>` : ""}
            <div class="douyin-form-grid">
              <label><span>每次采集评论数</span><input name="maxComments" type="number" min="1" max="10000" step="1" value="${draft.limits.maxComments ?? 100}" required></label>
              <label><span>每日时间</span><input name="localTime" type="time" value="${escape(draft.schedule.localTime)}" required></label>
              <label><span>时区</span><select name="timeZone"><option value="Asia/Shanghai" ${draft.schedule.timeZone === "Asia/Shanghai" ? "selected" : ""}>Asia/Shanghai (UTC+8)</option><option value="Asia/Hong_Kong" ${draft.schedule.timeZone === "Asia/Hong_Kong" ? "selected" : ""}>Asia/Hong_Kong (UTC+8)</option><option value="UTC" ${draft.schedule.timeZone === "UTC" ? "selected" : ""}>UTC</option></select></label>
            </div>
            <div class="douyin-checks"><label><input name="scheduleEnabled" type="checkbox" ${draft.schedule.enabled ? "checked" : ""}> 启用每日定时</label><label><input name="collectCreators" type="checkbox" ${draft.collectCreators ? "checked" : ""}> 保留视频作者资料（仅来源）</label><label><input name="collectDemandComments" type="checkbox" ${draft.collectDemandComments ? "checked" : ""}> 采集需求评论</label></div>
            <p class="douyin-inline-status">按去重评论计数，视频和作者资料不计入；达到数量或没有更多结果即结束。保存后从下一次采集生效，不改变当前运行；候选人数不设上限。</p>
            <p class="douyin-inline-status" data-douyin-disabled-reason aria-live="polite">${disabledReason ? escape(disabledReason) : "可直接保存，无需配置公开搜索连接或 AI 模型。"}</p>
            <div class="douyin-actions"><button type="button" class="secondary" data-douyin-action="save-only" ${disabledReason ? "disabled" : ""} aria-describedby="douyinSaveReason">仅保存</button><button type="button" class="primary" data-douyin-action="save-and-run" ${disabledReason ? "disabled" : ""} aria-describedby="douyinSaveReason">保存并立即运行</button></div>
            <span id="douyinSaveReason" class="sr-only">${disabledReason ? escape(disabledReason) : "计划可以保存并运行"}</span>
          </form>
        </article>
      </div>
      <article class="douyin-panel douyin-run-panel">
        ${localStatus?.controlState && !localEnded ? `<div class="douyin-actions"><button type="button" class="secondary" data-douyin-action="${localStatus.controlState === "paused" ? "resume-collection" : "pause-collection"}" ${["pausing", "stopping"].includes(localStatus.controlState) ? "disabled" : ""}>${localStatus.controlState === "paused" ? "继续采集" : "暂停采集"}</button><button type="button" class="secondary" data-douyin-action="stop-collection" ${localStatus.controlState === "stopping" ? "disabled" : ""}>结束采集并保存</button><small>暂停保留当前任务，暂停时间不计入采集时长；结束后保存结果，不再继续。</small></div>` : ""}
        <div class="douyin-panel-title"><span class="douyin-step">03</span><div><h3>实时采集</h3><p>${status ? escape(runLabel[status.state] ?? status.state) : state.runIntent ? "排队中" : historicalRun ? "历史采集结果" : "保存计划后可立即运行"}</p></div></div>
        ${status ? `<div class="douyin-run-observation"><div class="douyin-run-live-activity" role="status" aria-live="${activityLive}" aria-atomic="true"><div class="douyin-run-observation-head"><strong>${escape(activityTitle)}</strong><span>${escape(activityWindow)}</span></div><span>当前关键词：${escape(currentKeyword)}</span></div><div class="douyin-run-observation-details"><span>第 ${status.attempt} 次尝试</span><span>更新于 ${escape(new Date(localStatus?.updatedAt ?? status.updatedAt).toLocaleString("zh-CN", { hour12: false }))}</span></div></div><div class="douyin-run-metrics">${localStatus?.commentCount != null ? `<div><span>本机已保存去重评论</span><strong>${localStatus.commentCount}${localStatus.commentTarget != null ? ` / ${localStatus.commentTarget}` : ""}</strong></div>` : ""}${localStatus ? `<div><span>本机公开记录</span><strong>${localStatus.recordCount}</strong></div>` : ""}<div><span>${localStatus ? "已入库公开记录" : "公开记录"}</span><strong>${status.recordCount}</strong></div></div>${status.lastErrorCode && status.lastErrorCode !== "crawler_candidate_budget_exhausted" ? `<p class="douyin-safe-reason" role="status" aria-live="${errorLive}">运行提示：${escape(localizedCrawlerError(status.lastErrorCode, status.state))}</p>` : ""}` : state.runIntent ? `<div class="douyin-empty" role="status" aria-live="${queuedLive}" aria-atomic="true"><strong>排队中</strong><p>已提交采集，等待服务器返回首次观测状态。</p></div>` : historicalRun ? `<div class="douyin-empty"><strong>历史采集结果</strong><p>已载入保存的候选人与公开证据；此运行没有实时爬虫状态。</p></div>` : `<div class="douyin-empty"><strong>暂无采集运行</strong><p>系统不会用演示数据替代服务器状态。</p></div>`}
      </article>
      <article class="douyin-panel douyin-candidates-panel">
        <div class="douyin-panel-title"><span class="douyin-step">04</span><div><h3>候选人与证据</h3><p>点击候选人查看证据；仅勾选具备可评论视频的候选人进入待审批批次。</p></div></div>
        ${candidates.length ? `<div class="douyin-candidate-workspace"><div class="douyin-candidate-table" role="listbox" aria-label="候选人列表">${candidates.map((candidate, index) => { const eligible = isDouyinCommentOutreachCandidate(candidate); const inspected = inspector?.id === candidate.id; return `<div class="douyin-candidate-row ${inspected ? "is-active" : ""} ${eligible ? "" : "is-outreach-ineligible"}" role="option" aria-selected="${inspected}" tabindex="${inspected ? 0 : -1}" data-candidate-index="${index}"><input type="checkbox" data-douyin-candidate data-candidate-index="${index}" aria-label="${escape(eligible ? `选择 ${candidate.displayName} 加入待审批批次` : `${candidate.displayName} 缺少可评论视频，不能加入待审批批次`)}" ${eligible && selected.has(candidate.id) ? "checked" : ""} ${eligible ? "" : "disabled"}><span class="douyin-candidate-kind">${candidateKind(candidate)}</span><strong>${escape(candidate.displayName)}</strong><span>${escape(candidate.evidence.excerpt.slice(0, 70))}</span><em>${!eligible ? "仅查看 · 缺少可评论视频" : selected.has(candidate.id) ? "可评论 · 已加入本批次" : "可评论 · 未加入本批次"}</em></div>`; }).join("")}</div>${inspector ? `<aside class="douyin-evidence-inspector" aria-label="证据查看器"><span class="douyin-eyebrow">EVIDENCE</span><h4>${escape(inspector.displayName)}</h4><p>${escape(inspector.evidence.excerpt)}</p><a href="${escape(inspector.evidence.sourceUrl)}" target="_blank" rel="noreferrer">查看公开来源</a><div class="douyin-actions"><button type="button" class="secondary" data-douyin-action="review-candidate" data-candidate-id="${escape(inspector.id)}" ${state.planId?.trim() ? "" : "disabled"}>核对并交接私域</button></div><small>仅展示服务器保存的公开证据摘要；永久不联系身份已由服务器过滤。</small></aside>` : ""}</div><div class="douyin-actions"><span>已选 ${state.selectedCandidateIds.length} 人</span><button type="button" class="primary" data-douyin-action="create-batch" ${state.selectedCandidateIds.length === 0 ? "disabled" : ""}>生成待审批批次</button></div>` : `<div class="douyin-empty"><strong>${status?.candidateProjectionState === "pending" && terminalRunStates.has(status.state) ? "正在整理候选人" : status?.state === "running" ? "正在发现候选人" : "暂无候选人"}</strong><p>${status?.candidateProjectionState === "pending" && terminalRunStates.has(status.state) ? "公开记录已保存，候选人正在整理。" : status?.state === "partial" ? "本次为部分结果，已保留可用公开证据。" : "运行采集后，有需求线索的评论者将显示在这里。"}</p></div>`}
      </article>
      ${loginDialog(state)}
    </section>`);
}

export function mountDouyinAutomationView(host: HTMLElement, controller: DouyinAutomationController,
  onCreateBatch: (runId: string, candidateIds: string[]) => void | Promise<void>,
  options: DouyinAutomationViewOptions = {}): () => void {
  const desktopStatus = mountDesktopAccountStatus(host, options.desktopRuntime === undefined ? getInstalledDesktopRuntime() : options.desktopRuntime,
    () => controller.getState().account);
  const maxLoginPointerMovement = 8;
  let state = controller.getState();
  let inspectedCandidateId: string | null = null;
  let batchCreationPending = false;
  let closedLoginSessionId: string | null = null;
  let loginPointerGesture: ({
    kind: "surface";
    pointerId: number;
    sessionId: string;
    normalizedX: number;
    normalizedY: number;
    clientX: number;
    clientY: number;
  } | {
    kind: "connect";
    pointerId: number;
    sessionId: string | null;
    clientX: number;
    clientY: number;
  }) | null = null;
  let suppressedLoginClick: "surface" | "connect" | null = null;
  let suppressLoginClickTimer: ReturnType<typeof setTimeout> | null = null;
  let liveLoginMount: {
    sessionId: string;
    host: HTMLElement;
    unmount: (() => void) | null;
    disposed: boolean;
  } | null = null;
  let mounted = true;
  const disposeLiveLogin = () => {
    const current = liveLoginMount;
    if (!current) return;
    liveLoginMount = null;
    current.disposed = true;
    current.unmount?.();
  };
  const syncLiveLogin = () => {
    const session = state.loginSession;
    const slot = host.querySelector<HTMLElement>("[data-douyin-live-login-slot]");
    const shouldMount = Boolean(slot && session?.state === "awaiting_scan"
      && session.interactionSurface !== "external_window"
      && !session.failureCode && closedLoginSessionId !== session.id);
    if (!shouldMount || !slot || !session) {
      disposeLiveLogin();
      return;
    }
    if (liveLoginMount?.sessionId === session.id) {
      slot.replaceWith(liveLoginMount.host);
      return;
    }
    disposeLiveLogin();
    const liveHost = host.ownerDocument.createElement("div");
    liveHost.className = "douyin-embedded-live-login";
    liveHost.dataset.douyinEmbeddedLiveLogin = "";
    liveHost.innerHTML = `<div class="douyin-login-page-loading" role="status">正在加载安全登录窗口…</div>`;
    slot.replaceWith(liveHost);
    const record = {
      sessionId: session.id,
      host: liveHost,
      unmount: null as (() => void) | null,
      disposed: false
    };
    liveLoginMount = record;
    let result: (() => void) | Promise<() => void>;
    try {
      result = (options.mountLiveLogin ?? mountDefaultLiveLogin)(liveHost, session.id);
    } catch {
      liveHost.innerHTML = `<div class="douyin-login-page-loading" role="alert">安全登录窗口加载失败，请使用新标签页备用入口。</div>`;
      return;
    }
    void Promise.resolve(result).then((unmount) => {
      if (record.disposed || liveLoginMount !== record) unmount();
      else record.unmount = unmount;
    }, () => {
      if (!record.disposed && liveLoginMount === record) {
        liveHost.innerHTML = `<div class="douyin-login-page-loading" role="alert">安全登录窗口加载失败，请使用新标签页备用入口。</div>`;
      }
    });
  };
  const render = () => {
    const currentLoginSessionId = state.loginSession?.id ?? null;
    if (closedLoginSessionId && closedLoginSessionId !== currentLoginSessionId) {
      closedLoginSessionId = null;
    }
    if (inspectedCandidateId && !state.candidates.some((candidate) => candidate.id === inspectedCandidateId)) {
      inspectedCandidateId = null;
    }
    renderDouyinAutomationView(host, state, inspectedCandidateId);
    desktopStatus.render();
    if (batchCreationPending) {
      const button = host.querySelector<HTMLButtonElement>("[data-douyin-action=create-batch]");
      if (button) {
        button.disabled = true;
        button.textContent = "正在生成…";
      }
    }
    if (closedLoginSessionId === currentLoginSessionId) {
      closeDialog(host.querySelector<HTMLDialogElement>(".douyin-login-dialog"));
    }
    syncLiveLogin();
  };
  const inspectCandidate = (index: number, focus = false) => {
    const candidate = state.candidates[index];
    if (!candidate) return;
    inspectedCandidateId = candidate.id;
    render();
    if (focus) host.querySelector<HTMLElement>(`.douyin-candidate-row[data-candidate-index="${index}"]`)?.focus();
  };
  const unsubscribe = controller.subscribe((next) => {
    state = next;
    render();
  });
  const clearLoginPointerGesture = (pointerId?: number) => {
    if (!loginPointerGesture || (pointerId !== undefined && loginPointerGesture.pointerId !== pointerId)) return;
    const activePointerId = loginPointerGesture.pointerId;
    loginPointerGesture = null;
    try {
      host.releasePointerCapture?.(activePointerId);
    } catch {
      // The browser may already have released capture after pointer cancellation.
    }
  };
  const pointerdown = (event: PointerEvent) => {
    const element = event.target as HTMLElement | null;
    if (event.button !== 0 || !event.isPrimary) return;
    const loginSurface = element?.closest<HTMLElement>("[data-douyin-login-surface]");
    const session = state.loginSession;
    if (loginSurface && session?.state === "awaiting_scan"
      && !session.failureCode && !state.interactionPending) {
      const bounds = loginSurface.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      loginSurface.focus();
      loginPointerGesture = {
        kind: "surface",
        pointerId: event.pointerId,
        sessionId: session.id,
        normalizedX: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
        normalizedY: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
        clientX: event.clientX,
        clientY: event.clientY
      };
    } else {
      const connectButton = element?.closest<HTMLButtonElement>(
        "button[data-douyin-action=connect], button[data-douyin-action=create-session]"
      );
      if (!connectButton || connectButton.disabled || state.connectionPending) return;
      loginPointerGesture = {
        kind: "connect",
        pointerId: event.pointerId,
        sessionId: session?.id ?? null,
        clientX: event.clientX,
        clientY: event.clientY
      };
    }
    try {
      host.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is an enhancement; the delegated host listener remains the fallback.
    }
  };
  const pointerup = (event: PointerEvent) => {
    const gesture = loginPointerGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    clearLoginPointerGesture(event.pointerId);
    if (Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) > maxLoginPointerMovement) return;
    const session = state.loginSession;
    if (gesture.kind === "surface"
      && (session?.state !== "awaiting_scan" || session.failureCode || session.id !== gesture.sessionId)) return;
    if (gesture.kind === "connect"
      && (state.connectionPending || (session?.id ?? null) !== gesture.sessionId)) return;
    suppressedLoginClick = gesture.kind;
    if (suppressLoginClickTimer) clearTimeout(suppressLoginClickTimer);
    suppressLoginClickTimer = setTimeout(() => {
      suppressedLoginClick = null;
      suppressLoginClickTimer = null;
    }, 0);
    if (gesture.kind === "surface") {
      void controller.interactLogin({
        type: "click",
        normalizedX: gesture.normalizedX,
        normalizedY: gesture.normalizedY
      });
    } else {
      void controller.connect();
    }
  };
  const pointercancel = (event: PointerEvent) => clearLoginPointerGesture(event.pointerId);
  const click = (event: Event) => {
    const element = event.target as HTMLElement | null;
    const loginSurface = element?.closest<HTMLElement>("[data-douyin-login-surface]");
    if (loginSurface && state.loginSession?.state === "awaiting_scan") {
      if (state.interactionPending) return;
      if (suppressedLoginClick === "surface") {
        suppressedLoginClick = null;
        if (suppressLoginClickTimer) clearTimeout(suppressLoginClickTimer);
        suppressLoginClickTimer = null;
        return;
      }
      const pointer = event as MouseEvent;
      const bounds = loginSurface.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        loginSurface.focus();
        void controller.interactLogin({
          type: "click",
          normalizedX: clamp((pointer.clientX - bounds.left) / bounds.width, 0, 1),
          normalizedY: clamp((pointer.clientY - bounds.top) / bounds.height, 0, 1)
        });
      }
      return;
    }
    const target = element?.closest<HTMLElement>("[data-douyin-action]");
    if (target) {
      const action = target.dataset.douyinAction;
      if ((action === "connect" || action === "create-session")
        && suppressedLoginClick === "connect") {
        suppressedLoginClick = null;
        if (suppressLoginClickTimer) clearTimeout(suppressLoginClickTimer);
        suppressLoginClickTimer = null;
      }
      else if (action === "connect") void controller.connect();
      else if (action === "create-session") void controller.connect();
      else if (action === "confirm-login") void controller.confirmLogin();
      else if (action === "refresh-qr") void controller.interactLogin({ type: "refresh_qr" });
      else if (action === "disconnect") void controller.disconnect();
      else if (action === "suggest") void controller.suggestKeywords();
      else if (action === "pause-collection") void controller.controlCollection?.("pause");
      else if (action === "resume-collection") void controller.controlCollection?.("resume");
      else if (action === "stop-collection") void controller.controlCollection?.("stop");
      else if (action === "save-only" || action === "save-and-run") {
        const form = target.closest<HTMLFormElement>("[data-douyin-policy-form]");
        if (form && form.reportValidity()) {
          const draft = formDraft(form, state);
          if (action === "save-only") void controller.save(draft);
          else void controller.saveAndRun(draft);
        }
      }
      else if (action === "retry") void controller.load(state.planId, state.planName, state.activeRunId);
      else if (action === "restart-connector") void controller.restartConnector();
      else if (action === "close-login") { closedLoginSessionId = state.loginSession?.id ?? null; disposeLiveLogin(); closeDialog(host.querySelector<HTMLDialogElement>(".douyin-login-dialog")); void controller.cancelLogin(); host.querySelector<HTMLElement>("[data-douyin-action=connect]")?.focus(); }
      else if (action === "cancel-login") void controller.cancelLogin();
      else if (action === "remove-keyword") { target.closest(".douyin-keyword")?.remove(); updateActionAvailability(); }
      else if (action === "review-candidate") {
        if (!state.planId?.trim()) return;
        const candidate = state.candidates.find((item) => item.id === target.dataset.candidateId);
        if (!candidate) return;
        const detail = acquisitionCandidateDetailRequest(candidate.id, state.planId, state.activeRunId ?? undefined);
        if (!detail) return;
        const document = host.ownerDocument;
        const DetailEvent = document.defaultView?.CustomEvent ?? CustomEvent;
        document.dispatchEvent(new DetailEvent("goodjob:acquisition-detail-open-requested", { detail }));
      }
      else if (action === "create-batch" && state.activeRunId && !batchCreationPending) {
        batchCreationPending = true;
        const button = target as HTMLButtonElement;
        button.disabled = true;
        button.textContent = "正在生成…";
        let completion: void | Promise<void>;
        try {
          completion = onCreateBatch(state.activeRunId, [...state.selectedCandidateIds]);
        } catch {
          batchCreationPending = false;
          if (mounted) render();
          return;
        }
        void Promise.resolve(completion).then(
          () => {
            batchCreationPending = false;
            if (mounted) render();
          },
          () => {
            batchCreationPending = false;
            if (mounted) render();
          }
        );
      }
      return;
    }
    if (element?.matches("[data-douyin-candidate]")) return;
    const row = element?.closest<HTMLElement>(".douyin-candidate-row");
    if (row) inspectCandidate(Number(row.dataset.candidateIndex));
  };
  const updateActionAvailability = () => {
    const form = host.querySelector<HTMLFormElement>("[data-douyin-policy-form]");
    if (!form) return;
    const draft = formDraft(form, state);
    const reason = saveDisabledReason(state, draft.planName, draft.policy.keywords);
    form.querySelectorAll<HTMLButtonElement>("[data-douyin-action=save-only], [data-douyin-action=save-and-run]").forEach((button) => { button.disabled = Boolean(reason); });
    const visible = form.querySelector<HTMLElement>("[data-douyin-disabled-reason]");
    if (visible) visible.textContent = reason ?? "可直接保存，无需配置公开搜索连接或 AI 模型。";
    const accessible = form.querySelector<HTMLElement>("#douyinSaveReason");
    if (accessible) accessible.textContent = reason ?? "计划可以保存并运行";
  };
  const input = () => updateActionAvailability();
  const change = (event: Event) => { const target = event.target as HTMLInputElement | null; if (target?.closest("[data-douyin-policy-form]")) updateActionAvailability(); if (!target?.matches("[data-douyin-candidate]")) return; const index = Number(target.dataset.candidateIndex); const candidate = state.candidates[index]; if (candidate) { inspectedCandidateId = candidate.id; controller.toggleCandidate(candidate.id); } };
  const submit = (event: Event) => {
    const form = event.target as HTMLFormElement; if (!form.matches("[data-douyin-policy-form]")) return; event.preventDefault();
    if (form.reportValidity()) void controller.saveAndRun(formDraft(form, state));
  };
  const keydown = (event: KeyboardEvent) => {
    const eventTarget = event.target as HTMLElement | null;
    const loginSurface = eventTarget?.closest<HTMLElement>("[data-douyin-login-surface]");
    if (loginSurface && state.loginSession?.state === "awaiting_scan") {
      let input: DouyinLoginInteraction | null = null;
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        input = { type: "text", text: event.key };
      } else if (isLoginKey(event.key)) {
        input = { type: "key", key: event.key };
      }
      if (input) {
        event.preventDefault();
        void controller.interactLogin(input);
      }
      return;
    }
    const row = eventTarget?.closest<HTMLElement>(".douyin-candidate-row"); if (!row || !["ArrowDown", "ArrowUp", " ", "Enter"].includes(event.key)) return;
    if (eventTarget?.matches("[data-douyin-candidate]") && event.key === " ") return;
    event.preventDefault();
    if (event.key === "Enter") { inspectCandidate(Number(row.dataset.candidateIndex), true); return; }
    if (event.key === " ") { const index = Number(row.dataset.candidateIndex); const candidate = state.candidates[index]; if (candidate) { inspectedCandidateId = candidate.id; controller.toggleCandidate(candidate.id); if (!isDouyinCommentOutreachCandidate(candidate)) render(); } return; }
    const rows = [...host.querySelectorAll<HTMLElement>(".douyin-candidate-row")]; const index = rows.indexOf(row); const next = rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]; next?.focus();
  };
  const wheel = (event: WheelEvent) => {
    const element = event.target as HTMLElement | null;
    const loginSurface = element?.closest<HTMLElement>("[data-douyin-login-surface]");
    if (!loginSurface || state.loginSession?.state !== "awaiting_scan"
      || state.interactionPending) return;
    const bounds = loginSurface.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const deltaX = clamp(event.deltaX / bounds.width, -1, 1);
    const deltaY = clamp(event.deltaY / bounds.height, -1, 1);
    if (deltaX === 0 && deltaY === 0) return;
    event.preventDefault();
    void controller.interactLogin({ type: "scroll", deltaX, deltaY });
  };
  host.addEventListener("pointerdown", pointerdown); host.addEventListener("pointerup", pointerup); host.addEventListener("pointercancel", pointercancel); host.addEventListener("click", click); host.addEventListener("input", input); host.addEventListener("change", change); host.addEventListener("submit", submit); host.addEventListener("keydown", keydown); host.addEventListener("wheel", wheel, { passive: false });
  return () => { mounted = false; desktopStatus.dispose(); disposeLiveLogin(); clearLoginPointerGesture(); if (suppressLoginClickTimer) clearTimeout(suppressLoginClickTimer); unsubscribe(); host.removeEventListener("pointerdown", pointerdown); host.removeEventListener("pointerup", pointerup); host.removeEventListener("pointercancel", pointercancel); host.removeEventListener("click", click); host.removeEventListener("input", input); host.removeEventListener("change", change); host.removeEventListener("submit", submit); host.removeEventListener("keydown", keydown); host.removeEventListener("wheel", wheel); };
}
