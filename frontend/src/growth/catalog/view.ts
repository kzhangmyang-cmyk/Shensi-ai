import type {
  CatalogPageState,
  CatalogPolicyRow
} from "./controller";
import type {
  CatalogItem,
  PackageVersion,
} from "./api";

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function nullable(value: string | null): string {
  return value === null ? "" : escapeHtml(value);
}

function itemRow(item: CatalogItem): string {
  return `<li class="catalog-item" data-item-id="${escapeHtml(item.id)}">
    <strong>${escapeHtml(item.name)}</strong>
    <span class="catalog-item-code">${escapeHtml(item.code)}</span>
    <span class="catalog-item-type">${escapeHtml(({ product: "产品", service: "服务", package: "套餐" })[item.type])}</span>
    <span class="catalog-item-status">${statusLabel(item.status)}</span>
    <span class="catalog-item-unit">${escapeHtml(item.unit)}</span>
    ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
  </li>`;
}

function statusLabel(value: string): string {
  return escapeHtml(({ active: "已启用", draft: "草稿", retired: "已停用" } as Record<string, string>)[value] ?? value);
}

function catalogControls(canManage: boolean): string {
  return `${canManage ? '<div class="catalog-actions"><button type="button" data-action="create-item">新增产品 / 服务</button></div>' : ""}
    <p data-catalog-feedback role="status" aria-live="polite"></p><div data-catalog-editor></div>`;
}

function packageRow(
  pkg: PackageVersion,
  canManage: boolean
): string {
  const controls = canManage
    ? `<button data-action="activate-package" data-id="${escapeHtml(pkg.id)}"
         data-etag="${escapeHtml(`"package-version:${pkg.id}:${pkg.revision}"`)}"
         ${pkg.status !== "draft" ? "disabled" : ""}>激活</button>
       <button data-action="retire-package" data-id="${escapeHtml(pkg.id)}"
         data-etag="${escapeHtml(`"package-version:${pkg.id}:${pkg.revision}"`)}"
         ${pkg.status !== "active" ? "disabled" : ""}>停用</button>`
    : "";
  const components = (pkg.components ?? [])
    .map((component) =>
      `<li>${escapeHtml(String(component.componentCatalogItemId ?? ""))}
         × ${Number(component.quantityMicros) / 1_000_000}</li>`)
    .join("");
  return `<li class="catalog-package" data-package-id="${escapeHtml(pkg.id)}">
    <strong>${escapeHtml(pkg.id)}</strong>
    <span>${statusLabel(pkg.status)} · 版本 ${pkg.version} · 修订 ${pkg.revision}</span>
    ${pkg.currency ? `<span>${escapeHtml(pkg.currency)}</span>` : ""}
    <span>生效 ${escapeHtml(pkg.validFrom)}</span>
    ${components ? `<ul>${components}</ul>` : ""}
    ${controls}
  </li>`;
}

function policyRow(
  policy: CatalogPolicyRow,
  sensitive: boolean,
  canManage: boolean
): string {
  const rows: string[] = [];
  rows.push(`<li class="catalog-policy" data-policy-id="${escapeHtml(policy.id)}">
    <strong>${escapeHtml(policy.id)}</strong>
    <span>${statusLabel(policy.status)} · 修订 ${policy.revision}</span>
    ${policy.currency ? `<span>${escapeHtml(policy.currency)}</span>` : ""}`);
  if (sensitive && policy.listUnitPriceMinor !== undefined) {
    rows.push(`<span class="sensitive">标价 ${escapeHtml(new Intl.NumberFormat("zh-CN", { style: "currency", currency: policy.currency ?? "CNY" }).format(policy.listUnitPriceMinor / 100))}</span>`);
  }
  if (canManage) {
    rows.push(`<button data-action="activate-policy" data-id="${escapeHtml(policy.id)}"
      data-etag="${escapeHtml(`"pricing-policy:${policy.id}:${policy.revision}"`)}"
      ${policy.status !== "draft" ? "disabled" : ""}>激活</button>`);
  }
  if (policy.validFrom) {
    rows.push(`<span>生效 ${escapeHtml(policy.validFrom)}</span>`);
  }
  rows.push("</li>");
  return rows.join("");
}

export function renderCatalogPage(state: CatalogPageState): string {
  switch (state.kind) {
    case "loading":
      return `<section class="growth-panel"><p>正在加载产品目录…</p></section>`;
    case "forbidden":
      return `<section class="growth-panel"><p class="growth-forbidden">
        当前工作区无权访问产品目录。</p></section>`;
    case "empty":
      return `<section class="growth-panel catalog-page"><p>产品目录为空。先新增产品或服务，再创建并激活定价策略。</p>${catalogControls(state.canManage === true)}</section>`;
    case "conflict":
      return `<section class="growth-panel"><p class="growth-conflict">
        操作冲突：${escapeHtml(state.message)}</p></section>`;
    case "error":
      return `<section class="growth-panel"><p class="growth-error">
        加载失败：${escapeHtml(state.message)}</p></section>`;
    case "ready": {
      const items = state.items.map(itemRow).join("");
      const packageRows = [...state.packagesByItem.values()].flat();
      const packages = [...state.packagesByItem.entries()]
        .map(([itemId, rows]) =>
          `<li class="catalog-package-group" data-item="${escapeHtml(itemId)}">
             ${rows.map((row) => packageRow(row, state.canManage)).join("")}
           </li>`)
        .join("");
      const policies = state.policies
        .map((row) => policyRow(row, state.sensitive, state.canManage))
        .join("");
      return `<section class="growth-panel catalog-page">
        <header class="growth-section-heading"><div><span class="demo-status is-real">商业基础数据</span><h2>产品目录</h2></div><p>集中维护产品、套餐版本和定价策略，供报价工作台直接使用。</p></header>
        ${catalogControls(state.canManage)}
        ${state.canManage ? '<button type="button" data-action="create-policy">新增定价策略</button>' : ""}
        <div class="growth-command-strip" aria-label="产品目录概览">
          <article><span>产品</span><strong>${state.items.length}</strong><small>${state.items.filter((item) => item.status === "active").length} 个已启用</small></article>
          <article><span>套餐版本</span><strong>${packageRows.length}</strong><small>${packageRows.filter((item) => item.status === "active").length} 个生效中</small></article>
          <article><span>定价策略</span><strong>${state.policies.length}</strong><small>${state.policies.filter((item) => item.status === "active").length} 条生效中</small></article>
          <article><span>当前权限</span><strong>${state.canManage ? "可管理" : "只读"}</strong><small>${state.sensitive ? "可查看敏感价格" : "敏感价格已隐藏"}</small></article>
        </div>
        <div class="catalog-workbench-grid">
          <section><h3>产品</h3><ul class="catalog-items">${items}</ul></section>
          <section><h3>套餐版本</h3><ul class="catalog-packages">${packages}</ul></section>
          <section><h3>定价策略</h3><ul class="catalog-policies">${policies}</ul></section>
        </div>
      </section>`;
    }
  }
}
