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
    <span class="catalog-item-type">${escapeHtml(item.type)}</span>
    <span class="catalog-item-status">${escapeHtml(item.status)}</span>
    <span class="catalog-item-unit">${escapeHtml(item.unit)}</span>
    ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
  </li>`;
}

function packageRow(
  pkg: PackageVersion,
  canManage: boolean
): string {
  const controls = canManage
    ? `<button data-action="activate-package" data-id="${escapeHtml(pkg.id)}"
         data-etag="${escapeHtml(`"${pkg.revision}"`)}"
         ${pkg.status === "active" ? "disabled" : ""}>激活</button>
       <button data-action="retire-package" data-id="${escapeHtml(pkg.id)}"
         data-etag="${escapeHtml(`"${pkg.revision}"`)}"
         ${pkg.status === "retired" ? "disabled" : ""}>停用</button>`
    : "";
  const components = (pkg.components ?? [])
    .map((component) =>
      `<li>${escapeHtml(String(component.componentCatalogItemId ?? ""))}
         × ${String(component.quantityMicros ?? "")}</li>`)
    .join("");
  return `<li class="catalog-package" data-package-id="${escapeHtml(pkg.id)}">
    <strong>${escapeHtml(pkg.id)}</strong>
    <span>${escapeHtml(pkg.status)} · v${pkg.version} · rev ${pkg.revision}</span>
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
    <span>${escapeHtml(policy.status)} · rev ${policy.revision}</span>
    ${policy.currency ? `<span>${escapeHtml(policy.currency)}</span>` : ""}`);
  if (sensitive && policy.listUnitPriceMinor !== undefined) {
    rows.push(`<span class="sensitive">list ${policy.listUnitPriceMinor}</span>`);
  }
  if (canManage) {
    rows.push(`<button data-action="activate-policy" data-id="${escapeHtml(policy.id)}"
      data-etag="${escapeHtml(`"${policy.revision}"`)}"
      ${policy.status === "active" ? "disabled" : ""}>激活</button>`);
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
      return `<section class="growth-panel"><p>产品目录为空。</p></section>`;
    case "conflict":
      return `<section class="growth-panel"><p class="growth-conflict">
        操作冲突：${escapeHtml(state.message)}</p></section>`;
    case "error":
      return `<section class="growth-panel"><p class="growth-error">
        加载失败：${escapeHtml(state.message)}</p></section>`;
    case "ready": {
      const items = state.items.map(itemRow).join("");
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
        <h2>产品目录</h2>
        <ul class="catalog-items">${items}</ul>
        <h3>套餐版本</h3>
        <ul class="catalog-packages">${packages}</ul>
        <h3>定价策略</h3>
        <ul class="catalog-policies">${policies}</ul>
      </section>`;
    }
  }
}
