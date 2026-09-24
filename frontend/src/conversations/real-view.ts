import type { OutreachBatchState } from "../acquisition/outreach-batch-controller";
import type { OutreachBatch } from "../acquisition/outreach-batch-api";
import { renderOutreachBatchView } from "../acquisition/outreach-batch-view";
import { patchStableView } from "../desktop/stable-view";
import type {
  RealConversationsSnapshot,
  RealPublicInteraction
} from "./real-api";

export interface RealConversationsViewState {
  status: "loading" | "ready" | "error";
  snapshot: RealConversationsSnapshot | null;
  selectedInteractionKey: string | null;
  outreach: OutreachBatchState;
  outreachHistory?: OutreachBatch[];
  error: string | null;
  activeTab?: "direct_messages" | "comments" | "history";
  candidateQuery?: string;
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

const maxPublicMediaUrlLength = 2_000;

function safePublicMediaUrl(value: string | undefined): string | null {
  if (typeof value !== "string" || value.length === 0
    || value.length > maxPublicMediaUrlLength
    || !/^https:\/\/[^/\\?#]/iu.test(value)
    || value.includes("\\")
    || /[\p{White_Space}\p{Cc}\p{Cf}]/u.test(value)
    || /%(?![0-9A-Fa-f]{2})/u.test(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0 ? value : null;
  } catch { return null; }
}

function renderCandidateAvatar(
  item: RealPublicInteraction,
  modifier = ""
): string {
  const url = safePublicMediaUrl(item.avatarUrl);
  return `<span class="real-conversation-avatar${modifier}" aria-hidden="true"><i class="ph ph-user"></i>${url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-real-conversation-media="avatar">` : ""}</span>`;
}

function renderEvidenceCover(
  item: RealPublicInteraction,
  modifier = ""
): string {
  const url = safePublicMediaUrl(item.coverUrl);
  return `<span class="real-conversation-evidence-media${modifier}" aria-hidden="true"><i class="ph ph-video-camera"></i>${url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-real-conversation-media="cover">` : ""}</span>`;
}

function bindPublicMediaFallbacks(root: ParentNode): void {
  root.querySelectorAll<HTMLImageElement>("[data-real-conversation-media]").forEach((image) => {
    if (image.dataset.realConversationMediaBound === "true") return;
    image.dataset.realConversationMediaBound = "true";
    image.addEventListener("error", () => {
      image.hidden = true;
      image.closest<HTMLElement>(
        ".real-conversation-avatar, .real-conversation-evidence-media"
      )?.classList.add("is-media-unavailable");
    }, { once: true });
  });
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

function candidateStatusLabel(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    discovered: "新发现",
    new: "新发现",
    unresolvable: "身份待核对",
    normalized: "资料已整理",
    qualified: "符合条件",
    pending_review: "待人工复核",
    approved: "已批准",
    rejected: "已拒绝",
    do_not_contact: "不再联系",
    needs_research: "需补充研究",
    converted_to_lead: "已转为客户",
    creator_candidate: "内容创作者"
  };
  return labels[status] ?? "状态待确认";
}

function renderInteractionRow(
  item: RealPublicInteraction,
  selected: boolean
): string {
  return `<button type="button" class="real-conversation-row ${selected ? "selected" : ""}" data-real-conversations-action="select" data-interaction-key="${escapeHtml(item.key)}">
    ${renderCandidateAvatar(item)}
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
    <article>${renderEvidenceCover(item, " real-public-evidence-cover")}
      <div class="real-public-evidence-copy">
      <small>公开内容摘录</small>
      <blockquote>${escapeHtml(item.excerpt || "公开证据未提供摘要")}</blockquote>
      <dl>
        <div><dt>候选状态</dt><dd>${escapeHtml(candidateStatusLabel(item.candidateStatus))}</dd></div>
        <div><dt>采集运行</dt><dd>${escapeHtml(item.runId)}</dd></div>
        <div><dt>最近运行时间</dt><dd>${escapeHtml(formatTime(item.runUpdatedAt))}</dd></div>
      </dl>
      <a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">打开抖音公开来源</a>
      ${renderPrivateDomainEntry(item)}
      </div>
    </article>
  </section>`;
}

function renderPrivateDomainEntry(item: RealPublicInteraction): string {
  return `<div class="douyin-actions"><button type="button" class="secondary" data-real-conversations-action="review-candidate" ${item.planId.trim() ? "" : "disabled"}>核对并交接私域</button></div>`;
}

function renderRecipientContext(item: RealPublicInteraction | undefined): string {
  if (!item) return "";
  return `<section class="demo-panel real-conversation-recipient" aria-label="当前私信收件人">
    <header>
      <div class="real-conversation-recipient-person">${renderCandidateAvatar(item, " real-conversation-avatar--recipient")}<div><h2>${escapeHtml(item.displayName || "未命名公开主体")}</h2><p>${escapeHtml(item.taskName)}</p></div></div>
      <dl><div><dt>来源</dt><dd>公开视频与评论</dd></div><div><dt>候选状态</dt><dd>${escapeHtml(candidateStatusLabel(item.candidateStatus))}</dd></div></dl>
    </header>
    ${renderPrivateDomainEntry(item)}
    <details class="real-conversation-evidence"><summary>${renderEvidenceCover(item)}<div><strong>与当前任务相关的公开内容</strong><small>展开查看证据与公开来源</small></div><i class="ph ph-caret-down" aria-hidden="true"></i></summary><div class="real-conversation-evidence-body"><p>${escapeHtml(item.excerpt || "公开证据未提供摘要")}</p><time>${escapeHtml(formatTime(item.runUpdatedAt))}</time><a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看来源 <i class="ph ph-arrow-square-out" aria-hidden="true"></i></a></div></details>
  </section>`;
}

function renderOutreachWorkspace(
  item: RealPublicInteraction | undefined,
  outreach: OutreachBatchState,
  history: OutreachBatch[] = []
): string {
  if (!item) return "";
  if (outreach.phase === "loading") {
    return `<section class="demo-panel real-conversations-outreach-cta is-loading" aria-live="polite"><div><span class="demo-status">正在恢复审批状态</span><h3>正在查询该候选人的最新审批批次</h3><p>以服务器返回的 runId 与 candidateId 归属为准，不使用本地记录推断。</p></div><button type="button" disabled>查询中…</button></section>`;
  }
  if (outreach.phase === "error") {
    return `<section class="demo-panel real-conversations-outreach-cta is-disabled" role="alert"><div><span class="demo-status">审批批次恢复失败</span><h3>无法确认当前候选人的最新审批状态</h3><p>${escapeHtml(outreach.error ?? "请刷新公开证据后重试")}</p></div><button type="button" disabled>暂不可创建或审批</button></section>`;
  }
  if (outreach.batch) {
    const labels: Record<OutreachBatch["state"], string> = {
      awaiting_approval: "待审批", approved: "已审批", rejected: "已拒绝", paused: "已暂停"
    };
    const picker = history.length > 1 ? `<details class="demo-panel"><summary>高级选项 · 查看历史审批记录</summary><label>历史记录（最近 50 个）
      <select aria-label="历史审批批次" data-real-conversations-batch ${outreach.phase !== "ready" ? "disabled" : ""}>
        ${history.map((batch, index) => `<option value="${escapeHtml(batch.id)}" ${batch.id === outreach.batch?.id ? "selected" : ""}>${index === 0 ? "最新 · " : ""}${escapeHtml(formatTime(batch.createdAt))} · ${labels[batch.state]} · ${batch.candidates.filter((candidate) => candidate.selected).length} 人 · 修订 ${batch.revision}</option>`).join("")}
      </select></label></details>` : "";
    return `<section class="real-conversations-outreach" aria-label="公开证据外联审批工作台">${picker}<div data-real-conversations-outreach-host data-stable-preserve-children></div></section>`;
  }
  if (!item.outreachEligible) {
    return `<section class="demo-panel real-conversations-outreach-cta is-disabled"><div><span class="demo-status">仅查看公开证据</span><h3>公开来源不符合精确评论条件</h3><p>只有精确的 https://www.douyin.com/video/{id} 公开证据可进入人工审批。</p></div><button type="button" disabled>无法创建待审批批次</button></section>`;
  }
  return `<section class="demo-panel real-conversations-outreach-cta"><div><span class="demo-status">准备私信</span><h3>为当前收件人准备私信草稿</h3><p>创建后可直接编辑并独立确认私信，不会批准或排队评论。</p>${outreach.error ? `<small role="alert">${escapeHtml(outreach.error)}</small>` : ""}</div><button type="button" data-real-conversations-action="create-outreach">准备私信草稿</button></section>`;
}

function renderOperationalHelp(state: RealConversationsViewState): string {
  const failed = state.snapshot?.failedRuns ?? [];
  const truncated = state.snapshot?.truncatedRunIds ?? [];
  const summary = [
    failed.length > 0 ? `${failed.length} 个运行未读到完整结果` : "",
    truncated.length > 0 ? `${truncated.length} 个运行仍有后续候选` : ""
  ].filter(Boolean).join(" · ") || "发送前核对与真实回执";
  return `<details class="real-conversations-help" data-real-conversations-help>
    <summary><span>发送与审批说明</span><small>${escapeHtml(summary)}</small><i class="ph ph-caret-down" aria-hidden="true"></i></summary>
    <div class="real-conversations-help-body">
      <section><b>发送前核对</b><p>提交前会核对发送账号、精确收件人与私信正文；完成勾选后才可排队。</p></section>
      <section><b>公开来源</b><p>候选人与来源内容来自当前抖音获客任务，本页不伪造平台私信会话。</p></section>
      <section><b>执行与回执</b><p>实际发送由桌面应用处理，结果以服务器动作状态与平台回执为准。</p></section>
      ${failed.length > 0 ? `<section class="real-conversations-help-alert" role="alert"><b>部分运行需要重新读取</b><ul>${failed.map((item) => `<li>${escapeHtml(item.taskName)}：${escapeHtml(item.reason)}</li>`).join("")}</ul></section>` : ""}
      ${truncated.length > 0 ? `<section><b>结果范围</b><p>${truncated.length} 个运行仍有后续分页；已读取部分候选，请刷新后重试。</p></section>` : ""}
    </div>
  </details>`;
}

function renderMain(state: RealConversationsViewState): string {
  const snapshot = state.snapshot;
  const interactions = snapshot?.interactions ?? [];
  const query = state.candidateQuery?.trim().toLocaleLowerCase("zh-CN") ?? "";
  const visibleInteractions = query ? interactions.filter((item) =>
    [item.displayName, item.taskName, item.excerpt].some((value) =>
      value.toLocaleLowerCase("zh-CN").includes(query))) : interactions;
  const selected = interactions.find((item) =>
    item.key === state.selectedInteractionKey) ?? interactions[0];
  const activeTab = state.activeTab ?? "direct_messages";
  const tabs = `<nav class="real-conversations-tabs" aria-label="社媒对话工作区">${[
    ["direct_messages", "私信"], ["comments", "公开评论"], ["history", "发送记录"]
  ].map(([value, label]) => `<button type="button" data-real-conversations-action="tab" data-real-conversations-tab="${value}" aria-current="${activeTab === value ? "page" : "false"}">${label}</button>`).join("")}</nav>`;
  const heading = activeTab === "direct_messages"
    ? `<header class="real-conversations-heading">
      <div><span class="demo-status">真实 · 抖音公开候选</span><h2>社媒对话</h2><p>选择收件人、编辑私信，确认后由桌面应用发送；私信无需先发表评论。</p></div>
      <button type="button" data-real-conversations-action="retry">刷新公开证据</button>
    </header>${tabs}`
    : `<div class="real-conversations-secondary-toolbar">
      ${tabs}
      <button type="button" data-real-conversations-action="retry">刷新公开证据</button>
    </div>`;
  const accountStrip = `<div class="real-conversations-account-strip"><i class="ph ph-shield-check" aria-hidden="true"></i><span>每次发送前都会核对发送账号、精确收件人与正文</span><button type="button" data-xhs-open>小红书私信</button><a href="#acquisition">管理账号</a></div>`;

  if (state.status === "loading" && snapshot === null) {
    return `<section class="real-conversations" aria-label="抖音公开互动">${heading}${accountStrip}<section class="demo-panel demo-empty" role="status"><h2>正在读取真实公开互动…</h2><p>数据来自现有获客任务和候选证据接口。</p></section></section>`;
  }
  if (state.status === "error" && snapshot === null) {
    return `<section class="real-conversations" aria-label="抖音公开互动">${heading}${accountStrip}<section class="demo-panel demo-empty" role="alert"><h2>真实公开互动读取失败</h2><p>${escapeHtml(state.error)}</p><button type="button" data-real-conversations-action="retry">重新加载</button></section></section>`;
  }

  return `<section class="real-conversations" aria-label="抖音公开互动">
    ${heading}
    ${accountStrip}
    ${state.error ? `<p class="real-conversations-warning" role="alert">${escapeHtml(state.error)}</p>` : ""}
    <section class="real-conversations-grid" data-real-conversations-tab-panel="${activeTab}">
      <aside class="demo-panel real-conversation-list" aria-label="公开候选证据列表">
        <div><b>选择收件人</b><small>${interactions.length} 位已采集真实候选 · ${snapshot?.runsRead ?? 0} 个运行</small></div>
        <label><span class="sr-only">搜索候选人</span><input type="search" value="${escapeHtml(state.candidateQuery ?? "")}" placeholder="搜索候选人" data-real-conversations-candidate-search></label>
        <nav>${visibleInteractions.length > 0
          ? visibleInteractions.map((item) => renderInteractionRow(item, item.key === selected?.key)).join("")
          : "<p>没有匹配的真实候选人。</p>"}</nav>
      </aside>
      ${activeTab === "direct_messages"
        ? `<div class="real-conversation-compose-pane">${renderRecipientContext(selected)}${renderOutreachWorkspace(selected, state.outreach)}${renderOperationalHelp(state)}</div>`
        : renderSelected(selected)}
    </section>
    ${activeTab === "direct_messages" ? "" : `${renderOutreachWorkspace(selected, state.outreach, activeTab === "history" ? state.outreachHistory : [])}${renderOperationalHelp(state)}`}
  </section>`;
}

export function renderRealConversationsView(
  state: RealConversationsViewState,
  main: HTMLElement,
  inspector: HTMLElement
): void {
  const activeTab = state.activeTab ?? "direct_messages";
  const directMessageTab = activeTab === "direct_messages";
  main.classList.toggle("is-conversations-direct-message", directMessageTab);
  inspector.hidden = true;
  inspector.replaceChildren();
  patchStableView(main, renderMain(state));
  const host = main.querySelector<HTMLElement>(
    "[data-real-conversations-outreach-host]"
  );
  const batch = state.outreach.batch;
  const selectedInteraction = state.snapshot?.interactions.find((item) =>
    item.key === state.selectedInteractionKey) ?? state.snapshot?.interactions[0];
  const account = batch ? state.snapshot?.accounts.find((item) =>
    item.id === batch.accountId
    && item.state === "active") : undefined;
  const candidates = batch?.candidates.flatMap((candidate) => {
    if (candidate.candidateId !== selectedInteraction?.candidateId) return [];
    const interaction = state.snapshot?.interactions.find((item) =>
      item.runId === batch.runId && item.candidateId === candidate.candidateId);
    return interaction ? [{
      candidateId: candidate.candidateId,
      displayName: interaction.displayName,
      evidenceExcerpt: interaction.excerpt,
      evidenceSourceUrl: interaction.sourceUrl
    }] : [];
  }) ?? [];
  if (host) renderOutreachBatchView(host, state.outreach, {
    account: account ?? null,
    candidates,
    surface: activeTab,
    compactDirectMessage: directMessageTab
      && state.snapshot?.interactions.length === 1
  });
  const directMessageCompose = host?.querySelector("[data-outreach-direct-message-compose]");
  directMessageCompose?.querySelector(
    "[data-outreach-direct-message-account-summary]"
  )?.insertAdjacentHTML("beforeend", '<a href="#acquisition" class="outreach-account-manage">管理或连接发送账号</a>');
  bindPublicMediaFallbacks(main);
}
