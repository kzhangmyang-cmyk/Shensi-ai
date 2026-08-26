import type {
  RealConversationsSnapshot,
  RealPublicInteraction
} from "./real-api";

export interface RealConversationsViewState {
  status: "loading" | "ready" | "error";
  snapshot: RealConversationsSnapshot | null;
  selectedInteractionKey: string | null;
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

function renderReadOnlyComposer(): string {
  return `
    <section class="real-conversation-send-boundary" aria-labelledby="real-conversation-send-title">
      <div><b id="real-conversation-send-title">平台回复（未接入）</b><span>当前页面仅可读取真实公开互动。</span></div>
      <label for="real-conversation-message">回复内容</label>
      <textarea id="real-conversation-message" rows="3" disabled placeholder="没有接入官方 inbox、私信或评论发送 API"></textarea>
      <div><small id="real-conversation-send-help">没有接入官方 inbox、私信或评论发送 API；本页不会发起评论、回复或私信。</small><button type="button" class="demo-primary" disabled aria-describedby="real-conversation-send-help">发送不可用</button></div>
    </section>`;
}

function renderInteractionRow(
  item: RealPublicInteraction,
  selected: boolean
): string {
  return `<button type="button" class="real-conversation-row ${selected ? "selected" : ""}" data-real-conversations-action="select" data-interaction-key="${escapeHtml(item.key)}">
    <span class="real-conversation-row-heading"><b>${escapeHtml(item.displayName || "未命名公开主体")}</b><em>候选证据</em></span>
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
    <header><div><span class="demo-status">公开候选证据</span><h2>${escapeHtml(item.displayName || "未命名公开主体")}</h2><p>${escapeHtml(item.taskName)} · ${escapeHtml(runStatusLabel(item.runStatus))}</p></div><span class="demo-chip">抖音公开来源</span></header>
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
    return `<section class="real-conversations" aria-label="抖音公开互动">${heading}<section class="demo-panel demo-empty" role="status"><h2>正在读取真实公开互动…</h2><p>数据来自现有获客任务和候选证据接口。</p></section>${renderReadOnlyComposer()}</section>`;
  }
  if (state.status === "error" && snapshot === null) {
    return `<section class="real-conversations" aria-label="抖音公开互动">${heading}<section class="demo-panel demo-empty" role="alert"><h2>真实公开互动读取失败</h2><p>${escapeHtml(state.error)}</p><button type="button" data-real-conversations-action="retry">重新加载</button></section>${renderReadOnlyComposer()}</section>`;
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
    ${renderReadOnlyComposer()}
  </section>`;
}

function renderInspector(state: RealConversationsViewState): string {
  const snapshot = state.snapshot;
  const failed = snapshot?.failedRuns ?? [];
  const truncated = snapshot?.truncatedRunIds ?? [];
  return `<section class="demo-panel real-conversations-inspector">
    <header><span class="demo-status">只读能力边界</span><h3>公开互动，不是私信收件箱</h3></header>
    <dl>
      <div><dt>真实数据源</dt><dd>抖音获客任务的最新运行与公开候选证据</dd></div>
      <div><dt>平台私信会话</dt><dd>未接入官方 inbox API</dd></div>
      <div><dt>评论 / 回复 / 私信发送</dt><dd>禁用</dd></div>
    </dl>
    <section><b>外联回执</b><p>现有接口仅能凭已知批次 ID 查询已审批外联动作；当前页面无法按采集运行发现批次，因此不会猜测或伪造回执。</p></section>
    ${failed.length > 0 ? `<section role="alert"><b>部分运行读取失败</b><ul>${failed.map((item) => `<li>${escapeHtml(item.taskName)}：${escapeHtml(item.reason)}</li>`).join("")}</ul></section>` : ""}
    ${truncated.length > 0 ? `<section><b>结果范围</b><p>${truncated.length} 个运行仍有后续分页；当前仅展示接口首批结果。</p></section>` : ""}
    <p class="real-conversations-safety-note">本页不会发起评论、回复或私信。</p>
  </section>`;
}

export function renderRealConversationsView(
  state: RealConversationsViewState,
  main: HTMLElement,
  inspector: HTMLElement
): void {
  main.innerHTML = renderMain(state);
  inspector.innerHTML = renderInspector(state);
}
