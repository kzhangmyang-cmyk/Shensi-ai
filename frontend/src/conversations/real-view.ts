import type { OutreachBatchState } from "../acquisition/outreach-batch-controller";
import { renderOutreachBatchView } from "../acquisition/outreach-batch-view";
import type {
  RealConversationsSnapshot,
  RealPublicInteraction
} from "./real-api";

export interface RealConversationsViewState {
  status: "loading" | "ready" | "error";
  snapshot: RealConversationsSnapshot | null;
  selectedInteractionKey: string | null;
  outreach: OutreachBatchState;
  error: string | null;
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

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "采集时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestamp));
}

function runStatusLabel(status: RealPublicInteraction["runStatus"]): string {
  const labels: Record<RealPublicInteraction["runStatus"], string> = {
    queued: "排队中",
    running: "采集中",
    pause_requested: "正在暂停",
    paused: "已暂停",
    cancel_requested: "正在取消",
    cancelled: "已取消",
    succeeded: "采集完成",
    succeeded_empty: "采集完成 · 无结果",
    partial_success: "部分完成",
    failed: "采集失败",
    budget_exhausted: "预算已用完"
  };
  return labels[status];
}

function renderInteractionRow(
  item: RealPublicInteraction,
  selected: boolean
): string {
  return `<button type="button" class="real-conversation-row ${selected ? "selected" : ""}" data-real-conversations-action="select" data-interaction-key="${escapeHtml(item.key)}">
    <span class="real-conversation-row-heading"><b>${escapeHtml(item.displayName || "未命名公开主体")}</b><em>${item.outreachEligible ? "可审批外联" : "仅查看证据"}</em></span>
    <small>${escapeHtml(item.taskName)}</small>
    <p>${escapeHtml(item.excerpt || "公开证据未提供摘要")}</p>
    <time>${escapeHtml(formatTime(item.runUpdatedAt))}</time>
  </button>`;
}

function renderSelected(item: RealPublicInteraction | undefined): string {
  if (!item) {
    return `<section class="demo-panel demo-empty real-conversation-empty"><h2>暂无已采集的抖音公开互动</h2><p>请先在获客中心运行抖音公开采集。这里不会用浏览器演示数据填充。</p></section>`;
  }
  return `<section class="demo-panel real-public-evidence" aria-label="选中的公开候选证据">
    <header><div><span class="demo-status">公开候选证据</span><h2>${escapeHtml(item.displayName || "未命名公开主体")}</h2><p>${escapeHtml(item.taskName)} · ${escapeHtml(runStatusLabel(item.runStatus))}</p></div><span class="demo-chip">${item.outreachEligible ? "精确公开视频" : "仅可阅读"}</span></header>
    <article>
      <small>公开内容摘录</small>
      <blockquote>${escapeHtml(item.excerpt || "公开证据未提供摘要")}</blockquote>
      <dl>
        <div><dt>候选状态</dt><dd>${escapeHtml(item.candidateStatus)}</dd></div>
        <div><dt>采集运行</dt><dd>${escapeHtml(item.runId)}</dd></div>
        <div><dt>最近运行时间</dt><dd>${escapeHtml(formatTime(item.runUpdatedAt))}</dd></div>
      </dl>
      <a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">打开抖音公开来源</a>
    </article>
  </section>`;
}

function renderOutreachWorkspace(
  item: RealPublicInteraction | undefined,
  outreach: OutreachBatchState
): string {
  if (!item) return "";
  if (outreach.phase === "loading") {
    return `<section class="demo-panel real-conversations-outreach-cta is-loading" aria-live="polite"><div><span class="demo-status">正在恢复审批状态</span><h3>正在查询该候选人的最新审批批次</h3><p>以服务器返回的 runId 与 candidateId 归属为准，不使用本地记录推断。</p></div><button type="button" disabled>查询中…</button></section>`;
  }
  if (outreach.phase === "error") {
    return `<section class="demo-panel real-conversations-outreach-cta is-disabled" role="alert"><div><span class="demo-status">审批批次恢复失败</span><h3>无法确认当前候选人的最新审批状态</h3><p>${escapeHtml(outreach.error ?? "请刷新公开证据后重试")}</p></div><button type="button" disabled>暂不可创建或审批</button></section>`;
  }
  if (outreach.batch) {
    return `<section class="real-conversations-outreach" aria-label="公开证据外联审批工作台"><div data-real-conversations-outreach-host></div></section>`;
  }
  if (!item.outreachEligible) {
    return `<section class="demo-panel real-conversations-outreach-cta is-disabled"><div><span class="demo-status">仅查看公开证据</span><h3>公开来源不符合精确评论条件</h3><p>只有精确的 https://www.douyin.com/video/{id} 公开证据可进入人工审批。</p></div><button type="button" disabled>无法创建待审批批次</button></section>`;
  }
  return `<section class="demo-panel real-conversations-outreach-cta"><div><span class="demo-status">人工审批必需</span><h3>为当前候选人创建公开证据外联批次</h3><p>仅包含当前一名候选人；创建后仍需编辑、保存修订、逐条复核并二次确认。</p>${outreach.error ? `<small role="alert">${escapeHtml(outreach.error)}</small>` : ""}</div><button type="button" data-real-conversations-action="create-outreach">创建单候选待审批批次</button></section>`;
}

function renderMain(state: RealConversationsViewState): string {
  const snapshot = state.snapshot;
  const interactions = snapshot?.interactions ?? [];
  const selected = interactions.find((item) =>
    item.key === state.selectedInteractionKey) ?? interactions[0];
  const heading = `<header class="real-conversations-heading">
    <div><span class="demo-status">真实 · 抖音公开互动</span><h2>公开互动与候选证据</h2><p>读取 MediaCrawler 已采集的抖音公开内容和候选证据；这不是平台私信会话。</p></div>
    <button type="button" data-real-conversations-action="retry">刷新公开证据</button>
  </header>`;

  if (state.status === "loading" && snapshot === null) {
    return `<section class="real-conversations" aria-label="抖音公开互动">${heading}<section class="demo-panel demo-empty" role="status"><h2>正在读取真实公开互动…</h2><p>数据来自现有获客任务和候选证据接口。</p></section></section>`;
  }
  if (state.status === "error" && snapshot === null) {
    return `<section class="real-conversations" aria-label="抖音公开互动">${heading}<section class="demo-panel demo-empty" role="alert"><h2>真实公开互动读取失败</h2><p>${escapeHtml(state.error)}</p><button type="button" data-real-conversations-action="retry">重新加载</button></section></section>`;
  }

  return `<section class="real-conversations" aria-label="抖音公开互动">
    ${heading}
    ${state.error ? `<p class="real-conversations-warning" role="alert">${escapeHtml(state.error)}</p>` : ""}
    <section class="real-conversations-grid">
      <aside class="demo-panel real-conversation-list" aria-label="公开候选证据列表">
        <div><b>${interactions.length} 条候选证据</b><small>${snapshot?.runsRead ?? 0} 个最新运行已读取</small></div>
        <nav>${interactions.length > 0
          ? interactions.map((item) => renderInteractionRow(item, item.key === selected?.key)).join("")
          : "<p>当前没有候选证据。</p>"}</nav>
      </aside>
      ${renderSelected(selected)}
    </section>
    ${renderOutreachWorkspace(selected, state.outreach)}
  </section>`;
}

function renderInspector(state: RealConversationsViewState): string {
  const snapshot = state.snapshot;
  const failed = snapshot?.failedRuns ?? [];
  const truncated = snapshot?.truncatedRunIds ?? [];
  return `<section class="demo-panel real-conversations-inspector">
    <header><span class="demo-status">能力与审批边界</span><h3>公开证据外联 · 非官方 inbox</h3></header>
    <dl>
      <div><dt>真实数据源</dt><dd>抖音获客任务的最新运行与公开候选证据</dd></div>
      <div><dt>平台私信会话</dt><dd>这里不是官方 inbox，也不伪造会话线程</dd></div>
      <div><dt>浏览器直接发送</dt><dd>不提供；必须经过服务器批次与人工二次确认</dd></div>
    </dl>
    <section><b>公开证据外联</b><p>仅精确公开视频 URL 可创建单候选批次；profile、查询、hash、HTTP 或其他主机证据仍可阅读但不可审批。</p></section>
    <section><b>外联回执</b><p>审批后只展示服务器返回的动作状态与平台回执引用；不会根据本地选择伪造候选归属。</p></section>
    ${failed.length > 0 ? `<section role="alert"><b>部分运行读取失败</b><ul>${failed.map((item) => `<li>${escapeHtml(item.taskName)}：${escapeHtml(item.reason)}</li>`).join("")}</ul></section>` : ""}
    ${truncated.length > 0 ? `<section><b>结果范围</b><p>${truncated.length} 个运行仍有后续分页；当前仅展示接口首批结果。</p></section>` : ""}
    <p class="real-conversations-safety-note">复核勾选前审批按钮保持禁用；本页没有绕过批次审批的直发入口。</p>
  </section>`;
}

export function renderRealConversationsView(
  state: RealConversationsViewState,
  main: HTMLElement,
  inspector: HTMLElement
): void {
  main.innerHTML = renderMain(state);
  const host = main.querySelector<HTMLElement>(
    "[data-real-conversations-outreach-host]"
  );
  if (host) renderOutreachBatchView(host, state.outreach);
  inspector.innerHTML = renderInspector(state);
}
