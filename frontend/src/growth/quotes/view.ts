import type {
  QuoteCaseRow,
  QuoteVersionRow,
  QuoteWorkbenchState
} from "./controller";
import type { QuotePreviewInput } from "./api";

export interface QuoteCatalogItemOption {
  id: string;
  name: string;
}

export interface QuotePolicyOption {
  id: string;
  currency: string;
  listUnitPriceMinor?: number;
}

export interface QuoteWorkbenchViewOptions {
  items?: readonly QuoteCatalogItemOption[];
  policies?: readonly QuotePolicyOption[];
  canDraft?: boolean;
  canApprove?: boolean;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function formatMoney(minor: number | undefined, currency = "CNY"): string {
  if (!Number.isSafeInteger(minor)) return "--";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2
  }).format((minor ?? 0) / 100);
}

function etag(kind: "case" | "version", id: string, revision: number): string {
  return `\"quote-${kind}:${id}:${revision}\"`;
}

function versionRow(
  version: QuoteVersionRow,
  canApprove: boolean,
  canSubmit: boolean
): string {
  const quoted = typeof version.quotedAmountMinor === "number"
    ? `<span>${formatMoney(version.quotedAmountMinor)}</span>` : "";
  const versionEtag = etag("version", version.id, version.lifecycleRevision);
  const action = version.status === "draft" && canSubmit
    ? `<button type="button" data-quote-action="submit-version"
         data-version-id="${escapeHtml(version.id)}"
         data-etag="${escapeHtml(versionEtag)}">提交审批</button>`
    : version.status === "draft"
      ? `<span class="growth-muted">待完成商机评估后提交审批</span>`
    : version.status === "submitted" && canApprove
      ? `<label class="quote-decision-reason"><span>审批说明</span>
           <input data-quote-decision-reason maxlength="500" placeholder="填写批准或驳回原因" />
         </label>
         <div class="quote-version-actions">
           <button type="button" data-quote-action="approve-version"
             data-version-id="${escapeHtml(version.id)}"
             data-etag="${escapeHtml(versionEtag)}">批准报价</button>
           <button type="button" class="is-secondary" data-quote-action="reject-version"
             data-version-id="${escapeHtml(version.id)}"
             data-etag="${escapeHtml(versionEtag)}">驳回</button>
         </div>`
      : "";
  return `<li class="quote-version" data-version-id="${escapeHtml(version.id)}">
    <div><strong>版本 ${version.version}</strong><span>${escapeHtml(version.status)} · 修订 ${version.lifecycleRevision}</span>${quoted}</div>
    ${action}
  </li>`;
}

function caseSelectionRow(item: QuoteCaseRow): string {
  const subject = item.dealId || item.customerId || item.candidateId || "未关联";
  return `<li class="quote-case-option" data-quote-case-id="${escapeHtml(item.id)}" data-quote-case-status="${escapeHtml(item.status)}" data-quote-case-search="${escapeHtml(`${subject} ${item.id}`.toLocaleLowerCase("zh-CN"))}">
    <div><strong>${escapeHtml(subject)}</strong><span>${escapeHtml(caseStatusLabel(item.status))} · 修订 ${item.revision}</span></div>
    <a href="#growth/quotes?case=${encodeURIComponent(item.id)}">继续报价</a>
  </li>`;
}

function caseStatusLabel(status: string): string {
  return ({ open: "进行中", closed: "已关闭", cancelled: "已取消" } as Record<string, string>)[status] ?? status;
}

export function matchesQuoteCaseFilter(status: string, filter: string, text: string, query: string): boolean {
  return (filter === "all" || status === filter)
    && text.toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN"));
}

function quoteInput(state: QuoteWorkbenchState): Partial<QuotePreviewInput> {
  return "input" in state ? state.input : {};
}

function optionsMarkup(
  values: readonly { id: string; name?: string; currency?: string }[],
  selected: string | undefined,
  empty: string
): string {
  if (values.length === 0) return `<option value="">${escapeHtml(empty)}</option>`;
  return values.map((value) => `<option value="${escapeHtml(value.id)}"${value.id === selected ? " selected" : ""}>${escapeHtml(value.name ?? `${value.id} · ${value.currency ?? ""}`)}</option>`).join("");
}

function renderEditor(
  state: Extract<QuoteWorkbenchState, { kind: "editing" | "previewing" | "preview_ready" }>,
  options: QuoteWorkbenchViewOptions
): string {
  const input = quoteInput(state);
  const items = options.items ?? [];
  const policies = options.policies ?? [];
  const selectedPolicy = policies.find((item) => item.id === input.pricingPolicyVersionId)
    ?? policies[0];
  const offered = Number.isSafeInteger(input.offeredUnitPriceMinor)
    ? Number(input.offeredUnitPriceMinor) : selectedPolicy?.listUnitPriceMinor;
  const canSubmit = Boolean(
    state.case.dealId
    && (state.case.candidateId || state.case.authorityKind === "crm")
  );
  const versions = "versions" in state
    ? state.versions.map((version) => versionRow(
        version,
        options.canApprove === true,
        canSubmit
      )).join("")
    : "";
  const previewBlock = state.kind === "preview_ready"
    ? `<section class="quote-preview" aria-label="报价预览">
        <div><span>客户报价</span><strong>${formatMoney(state.preview.quotedAmountMinor, state.preview.currency)}</strong></div>
        <div><span>建议开价</span><strong>${formatMoney(state.preview.recommendedOpeningQuotedAmountMinor, state.preview.currency)}</strong></div>
        <div><span>预计毛利率</span><strong>${(state.preview.grossMarginBps / 100).toFixed(2)}%</strong></div>
        <div><span>审批门槛</span><strong>${escapeHtml(state.preview.gate.status)}</strong></div>
        <button type="button" data-quote-action="save-draft"
          data-case-id="${escapeHtml(state.case.id)}"
          data-etag="${escapeHtml(etag("case", state.case.id, state.case.revision))}">保存为报价草稿</button>
      </section>`
    : "";
  const unavailable = items.length === 0 || policies.length === 0;
  return `<section class="growth-panel quote-workbench">
    <header class="growth-section-heading">
      <div><span class="demo-status is-real">报价流程</span><h2>报价工作台</h2></div>
      <p>关联对象 ${escapeHtml(state.case.dealId || state.case.customerId || state.case.candidateId || state.case.id)}</p>
    </header>
    <div class="growth-command-strip" aria-label="报价工作台状态">
      <article><span>报价案例</span><strong>${escapeHtml(state.case.status)}</strong><small>修订 ${state.case.revision}</small></article>
      <article><span>报价版本</span><strong>${"versions" in state ? state.versions.length : 0}</strong><small>当前案例历史</small></article>
      <article><span>可用产品</span><strong>${items.length}</strong><small>来自产品目录</small></article>
      <article><span>定价策略</span><strong>${policies.length}</strong><small>${options.canApprove ? "具备审批权限" : "按当前权限操作"}</small></article>
    </div>
    ${unavailable ? `<div class="growth-empty-action"><h3>报价资料未就绪</h3><p>至少需要一个产品和一条已生效的定价策略。</p><a href="#growth/catalog">检查产品与定价</a></div>` : `
      <form class="quote-editor-form" data-quote-preview-form data-case-id="${escapeHtml(state.case.id)}" data-etag="${escapeHtml(etag("case", state.case.id, state.case.revision))}">
        <label><span>产品</span><select name="catalogItemId" required>${optionsMarkup(items, input.catalogItemId, "暂无产品")}</select></label>
        <label><span>定价策略</span><select name="pricingPolicyVersionId" required>${optionsMarkup(policies, input.pricingPolicyVersionId, "暂无策略")}</select></label>
        <label><span>数量</span><input name="quantity" type="number" min="0.000001" step="0.000001" required value="${escapeHtml((Number(input.quantityMicros ?? 1_000_000) / 1_000_000).toString())}" /></label>
        <label><span>单价（元）</span><input name="offeredUnitPrice" type="number" min="0" step="0.01" required value="${escapeHtml(((offered ?? 0) / 100).toFixed(2))}" /></label>
        <label><span>整单优惠（元）</span><input name="orderDiscount" type="number" min="0" step="0.01" value="${escapeHtml((Number(input.orderDiscountMinor ?? 0) / 100).toFixed(2))}" /></label>
        <label><span>客户目标价（元）</span><input name="customerTargetPrice" type="number" min="0" step="0.01" value="${input.customerTargetPriceMinor === null || input.customerTargetPriceMinor === undefined ? "" : escapeHtml((Number(input.customerTargetPriceMinor) / 100).toFixed(2))}" /></label>
        <label><span>账期（天）</span><input name="paymentTermDays" type="number" min="0" max="3650" step="1" required value="${escapeHtml(String(input.paymentTermDays ?? 30))}" /></label>
        <label><span>区域</span><input name="region" maxlength="120" value="${escapeHtml(input.surchargeContext?.region ?? "")}" placeholder="例如 CN" /></label>
        <label><span>交付方式</span><input name="deliveryMethod" maxlength="120" value="${escapeHtml(input.surchargeContext?.deliveryMethod ?? "")}" placeholder="例如 standard" /></label>
        <label class="quote-checkbox"><input name="manualEscalation" type="checkbox"${input.manualEscalation ? " checked" : ""} /><span>提交人工例外审批</span></label>
        <button type="submit"${state.kind === "previewing" || options.canDraft === false ? " disabled" : ""}>${state.kind === "previewing" ? "正在计算…" : "生成报价预览"}</button>
      </form>`}
    ${previewBlock}
    <section class="quote-version-list"><h3>报价版本</h3><ul>${versions || "<li class=\"growth-muted\">还没有保存的报价版本。</li>"}</ul></section>
  </section>`;
}

export function renderQuoteWorkbench(
  state: QuoteWorkbenchState,
  options: QuoteWorkbenchViewOptions = {}
): string {
  switch (state.kind) {
    case "loading_case":
      return `<section class="growth-panel"><p>正在加载报价…</p></section>`;
    case "assessment_required":
      return `<section class="growth-panel quote-assessment">
        <header class="growth-section-heading">
          <div><span class="demo-status is-real">商机评估</span><h2>确认报价依据</h2></div>
          <p>商机 ${escapeHtml(state.dealId)}</p>
        </header>
        <p class="growth-muted">由商机负责人根据真实跟进情况填写。保存后，该评估会冻结为本次正式报价的依据。</p>
        <form class="quote-editor-form quote-assessment-form" data-quote-assessment-form>
          <label class="quote-checkbox"><input name="demandConfirmed" type="checkbox" /><span>需求已确认</span></label>
          <label class="quote-checkbox"><input name="budgetConfirmed" type="checkbox" /><span>预算已确认</span></label>
          <label class="quote-checkbox"><input name="decisionMakerConfirmed" type="checkbox" /><span>决策人已确认</span></label>
          <label><span>成交概率（%）</span><input name="closeProbability" type="number" min="0" max="100" step="0.01" required value="50" /></label>
          <label class="quote-assessment-summary"><span>评估依据</span><textarea name="evidenceSummary" minlength="10" maxlength="1000" required placeholder="例如：已确认设备规格和预算区间，技术负责人计划本周组织决策会。"></textarea></label>
          <button type="submit">保存评估并进入报价</button>
        </form>
      </section>`;
    case "case_selection":
      {
        const open = state.cases.filter((item) => item.status === "open").length;
        const closed = state.cases.filter((item) => item.status === "closed").length;
        const cancelled = state.cases.filter((item) => item.status === "cancelled").length;
      return `<section class="growth-panel quote-case-selection">
        <nav class="quote-state-tabs" role="tablist" aria-label="报价状态">
          <button type="button" class="active" role="tab" aria-selected="true" data-quote-list-filter="all">全部报价</button>
          <button type="button" role="tab" aria-selected="false" data-quote-list-filter="open">进行中</button>
          <button type="button" role="tab" aria-selected="false" data-quote-list-filter="closed">已关闭</button>
          <button type="button" role="tab" aria-selected="false" data-quote-list-filter="cancelled">已取消</button>
        </nav>
        <div class="quote-list-toolbar">
          <label><i class="ph ph-magnifying-glass" aria-hidden="true"></i><span class="sr-only">搜索客户或报价</span><input type="search" placeholder="搜索客户或报价" data-quote-list-query></label>
          <label><span class="sr-only">状态筛选</span><select data-quote-status-filter><option value="all">状态筛选：全部</option><option value="open">进行中</option><option value="closed">已关闭</option><option value="cancelled">已取消</option></select></label>
          <a href="#growth/catalog"><i class="ph ph-users" aria-hidden="true"></i>从客户开始</a>
          <button type="button" data-quote-list-refresh><i class="ph ph-arrow-clockwise" aria-hidden="true"></i><span class="sr-only">刷新</span></button>
        </div>
        <div class="quote-overview-grid">
          <section class="quote-case-list" aria-label="报价案例列表">
            <header class="quote-case-summary"><p><strong>全部报价 ${state.cases.length}</strong><span>· 进行中 ${open} · 已关闭 ${closed} · 已取消 ${cancelled}</span></p></header>
            <div class="quote-case-table" role="table">
              <div class="quote-case-table-head" role="row"><span>客户 / 商机</span><span>状态</span><span>修订版本</span><span>操作</span></div>
              ${state.cases.length === 0
                ? `<div class="growth-table-empty quote-empty"><i class="ph ph-file-text" aria-hidden="true"></i><strong>暂无报价案例</strong><span>从客户目录选择客户或活跃商机后即可开始报价。</span><a href="#growth/catalog">前往客户目录</a></div>`
                : `<ul>${state.cases.map(caseSelectionRow).join("")}</ul>`}
            </div>
          </section>
          <aside class="quote-readiness" aria-label="报价前准备"><h3>报价前准备</h3><ol>
            <li><i class="ph ph-users" aria-hidden="true"></i><span><b>客户与需求</b><small>客户信息、需求背景、业务目标等</small></span><a href="#growth/catalog">准备资料</a></li>
            <li><i class="ph ph-receipt" aria-hidden="true"></i><span><b>产品和定价</b><small>产品方案、配置明细、价格与条款等</small></span><a href="#growth/catalog">准备资料</a></li>
            <li><i class="ph ph-shield-check" aria-hidden="true"></i><span><b>报价权限</b><small>折扣权限、审批流程、报价规范等</small></span><a href="#settings">准备资料</a></li>
          </ol></aside>
        </div>
        <section class="quote-standard-flow" aria-label="标准流程"><h3>标准流程</h3><ol>
          <li><i class="ph ph-users" aria-hidden="true"></i><span><b>客户需求</b><small>了解客户需求与场景</small></span></li>
          <li><i class="ph ph-file-text" aria-hidden="true"></i><span><b>生成报价</b><small>生成报价方案</small></span></li>
          <li><i class="ph ph-shield-check" aria-hidden="true"></i><span><b>核对与审批</b><small>内部核对与审批</small></span></li>
          <li><i class="ph ph-chart-line-up" aria-hidden="true"></i><span><b>跟进状态</b><small>跟进与客户反馈</small></span></li>
        </ol></section>
        <details class="quote-history" open><summary>执行与审批记录</summary><p>${state.cases.length === 0 ? "暂无记录" : `${state.cases.length} 个报价案例`}</p></details>
      </section>`;
      }
    case "conflict":
      return `<section class="growth-panel"><p class="growth-conflict">${escapeHtml(state.message)}</p></section>`;
    case "error":
      return `<section class="growth-panel"><p class="growth-error">${escapeHtml(state.message)}</p></section>`;
    case "hard_blocked":
      return `<section class="growth-panel"><p class="growth-error">报价无法成立：优惠或附加费用使最终金额不大于零。</p></section>`;
    case "saving":
    case "submitting":
    case "publication_pending":
      return `<section class="growth-panel"><p>正在处理报价…</p></section>`;
    case "publication_failed":
      return `<section class="growth-panel"><p class="growth-error">发布失败：${escapeHtml(state.errorCode)}</p></section>`;
    case "case_created":
      return `<section class="growth-panel"><p>报价案例已创建，正在打开…</p></section>`;
    case "draft_saved":
      return `<section class="growth-panel"><p>报价草稿已保存。</p>${versionRow(state.version, options.canApprove === true, false)}</section>`;
    case "submitted":
      return `<section class="growth-panel"><p>报价已提交审批：${escapeHtml(state.approval.status)}</p></section>`;
    case "approved":
      return `<section class="growth-panel"><p>报价已批准。</p>${versionRow(state.version, options.canApprove === true, true)}</section>`;
    case "rejected":
      return `<section class="growth-panel"><p>报价已驳回：${escapeHtml(state.approval.status)}</p></section>`;
    case "editing":
    case "previewing":
    case "preview_ready":
      return renderEditor(state, options);
  }
}
