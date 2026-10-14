import { escapeHtml as e } from "../demo/demo-ui";
import { filterEnterprises, type Enterprise } from "./model";
import { createEnterpriseApi } from "./api";
import { mountBrowserEnterprisePreview } from './browser-preview';
import { mountEnterpriseFilters } from './filters';
import { industryPath } from './industry';
import { regionPath } from './regions';
import { renderEnterpriseCapture } from './capture-view';
import {copyButton,copyEnterpriseValue} from './copy';

/** The directory is intentionally empty until an authorized data source is connected. */
export function mountEnterpriseQuery(host: HTMLElement, previewApi?: Pick<ReturnType<typeof createEnterpriseApi>, "list" | "join">): void {
  host.innerHTML = `<section class="enterprise-query" aria-label="企业查询">
    ${previewApi ? "" : '<label class="enterprise-query-source">数据来源 <select aria-label="数据来源" data-source><option value="existing">已有企业资料</option><option value="gleif">免费公开数据 · GLEIF中国LEI企业</option></select></label><p data-source-note></p>'}
    <form class="enterprise-query-filters" aria-label="企业筛选">
      <label class="enterprise-query-search"><i class="ph ph-magnifying-glass" aria-hidden="true"></i><input name="keyword" aria-label="企业名称、行业或关键词" placeholder="企业名称、行业或关键词" maxlength="200"></label>
      <div data-enterprise-filters></div>
      <label>企业规模<select name="size" aria-label="企业规模"><option value="">全部规模</option><option>1–49人</option><option>50–99人</option><option>100–499人</option><option>500–999人</option><option>1000人以上</option></select></label>
      <button type="submit">筛选已有资料</button>
    </form>
    <div class="enterprise-query-panes">
      <section class="enterprise-query-list" aria-label="企业列表">
        <header>共 <strong>0</strong> 家企业</header>
        <div class="enterprise-query-columns"><span>企业信息</span><span>行业</span><span>地区</span><span>规模</span><span>成立时间</span></div>
        <div class="enterprise-query-empty" role="status"><i class="ph ph-buildings" aria-hidden="true"></i><h3>暂无企业资料</h3><p>接入您提供的企业数据后，可在这里搜索、筛选并查看详情。</p></div>
        <footer>共 0 条记录<span>10 条/页</span></footer>
      </section>
      <aside class="enterprise-query-detail" aria-label="企业详情"><h2>企业详情</h2><div class="enterprise-query-empty"><i class="ph ph-identification-card" aria-hidden="true"></i><h3>选择一家企业</h3><p>点击左侧企业，查看基本信息、经营信息和联系方式。</p></div></aside>
    </div>
  </section>`;
  const root = host.querySelector<HTMLElement>(".enterprise-query")!;
  const localPanes=root.querySelector<HTMLElement>('.enterprise-query-panes')!;
  const captured=document.createElement('div');captured.hidden=true;localPanes.after(captured);
  let captureView:ReturnType<typeof renderEnterpriseCapture>|undefined;
  const browser = !previewApi ? mountBrowserEnterprisePreview(root,(capture,append)=>{
    localPanes.hidden=!!capture;captured.hidden=!capture;
    if(capture){if(append&&captureView)captureView.update(capture);else captureView=renderEnterpriseCapture(captured,capture);}else {captured.replaceChildren();captureView=undefined;}
  }) : undefined;
  if (browser) {
    root.querySelector('form')!.insertAdjacentHTML('beforeend','<button type="button" data-online-search aria-describedby="enterprise-online-scope">普通搜索 · 爱企查</button>');
    root.querySelector('form')!.insertAdjacentHTML('afterend','<p id="enterprise-online-scope" class="enterprise-capture-source" role="status">普通搜索仅支持关键词。已选地区、行业或规模时不会执行；省市及门类/二级行业可使用下方高级条件查询，需网站权限。非会员按网站实际可见范围回传。</p><details class="enterprise-advanced-query"><summary>高级条件查询（需要网站权限）</summary><p>省市 + 门类/二级行业，关键词可不填。更细行业及人数规模不自动转换。</p><button type="button" data-advanced-search>执行高级条件查询</button></details>');
  }
  root.querySelector("form")?.insertAdjacentHTML("beforeend", '<button type="button" class="enterprise-query-reset" data-reset-filters>重置筛选</button>');
  const api = previewApi ?? createEnterpriseApi();
  let remote = false;
  let remoteTotal = 0;
  let queryVersion = 0;
  let items: Enterprise[] = [];
  let selected = "";
  let tab = "basic";
  let page = 0;
  let busy = false;
  let error = "";
  let loading = true;
  const checked = new Set<string>();
  const keys = new Map<string, string>();
  const filters = mountEnterpriseFilters(root.querySelector('form')!, () => { page = 0; refresh(); });
  function refresh() {
    if (!root.isConnected) return;
    const form = root.querySelector<HTMLFormElement>("form")!;
    const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
    const filtered = remote ? items : filterEnterprises(items, { keyword: value("keyword"), region: value("region"), industry: value("industry"), size: value("size") });
    const total = remote ? remoteTotal : filtered.length;
    const sourceNote = root.querySelector<HTMLElement>('[data-source-note]');
    if (sourceNote) sourceNote.textContent = remote ? '在线名称查询：仅覆盖GLEIF中国LEI企业，不是全国工商库；不支持地区、行业、规模或电话条件。' : loading ? '正在读取已有企业资料…' : error ? '已有资料读取失败，可重试；在线查询使用独立入口。' : `已有企业资料 ${items.filter(item=>item.status !== 'excluded').length} 家。筛选已有资料不会在线搜索；要找新企业，请使用“普通搜索 · 爱企查”。`;
    root.querySelector<HTMLButtonElement>('button[type=submit]')!.textContent = remote ? '在线查询名称' : '筛选已有资料';
    const visible = remote ? filtered : filtered.slice(page * 10, page * 10 + 10);
    if (!remote) page = Math.min(page, Math.max(0, Math.ceil(filtered.length / 10) - 1));
    if (!filtered.some(item => item.id === selected)) selected = "";
    const list = root.querySelector<HTMLElement>(".enterprise-query-list")!;
    list.innerHTML = `<header>共 <strong>${total}</strong> 家企业</header><div class="enterprise-query-columns"><span>企业信息</span><span>行业</span><span>地区</span><span>规模</span><span>成立时间</span></div>${visible.length ? visible.map(item => `<button type="button" class="enterprise-query-row ${selected === item.id ? "selected" : ""}" data-company="${e(item.id)}" aria-pressed="${selected === item.id}"><span><strong>${e(item.company)}</strong><small>${e(item.description || "暂无简介")}</small></span><span>${e(item.business || "未提供")}</span><span>${e(item.country || "未提供")}</span><span>未提供</span><span>未提供</span></button>`).join("") : `<div class="enterprise-query-empty"><i class="ph ph-buildings" aria-hidden="true"></i><h3>${loading ? "正在读取企业资料" : error ? "企业资料读取失败" : items.length ? "没有匹配的企业" : "暂无企业资料"}</h3><p>${e(error || (items.length ? "请尝试其他关键词，或重置筛选条件。" : remote ? "请输入企业名称搜索；没有结果仅表示该名称未在当前LEI范围匹配。" : "接入您提供的企业数据后，可在这里搜索、筛选并查看详情。"))}</p>${error ? '<button type="button" data-reload>重试</button>' : ""}</div>`}<footer><span>共 ${total} 条记录</span><span><button type="button" data-page="-1" ${loading || page === 0 ? "disabled" : ""}>上一页</button> ${total ? page + 1 : 0} <button type="button" data-page="1" ${loading || (page + 1) * 10 >= total ? "disabled" : ""}>下一页</button></span></footer>`;
    list.querySelectorAll<HTMLElement>("[data-company]").forEach(row => {
      const company = items.find(item => item.id === row.dataset.company);
      if (company) { row.children[3].textContent = company.size || "未提供"; row.children[4].textContent = company.founded || "未提供"; }
      const wrapper = document.createElement("div");
      wrapper.className = "enterprise-query-selectable-row";
      row.before(wrapper);
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox"; checkbox.checked = checked.has(row.dataset.company!);
      checkbox.dataset.checkCompany = row.dataset.company;
      checkbox.setAttribute("aria-label", `勾选${company?.company || "企业"}`);
      wrapper.append(checkbox, row);
    });
    const columns = list.querySelector<HTMLElement>(".enterprise-query-columns")!;
    const visibleIds = visible.map(item => item.id);
    const checkAll = document.createElement("input");
    checkAll.type = "checkbox"; checkAll.dataset.checkAll = "true";
    checkAll.setAttribute("aria-label", "勾选本页企业");
    checkAll.checked = visibleIds.length > 0 && visibleIds.every(id => checked.has(id));
    checkAll.indeterminate = visibleIds.some(id => checked.has(id)) && !checkAll.checked;
    checkAll.disabled = !visibleIds.length;
    columns.prepend(checkAll);
    list.querySelector("header")?.insertAdjacentHTML("beforeend", `<span class="enterprise-query-selection-count">已勾选 ${checked.size} 家</span>`);
    if (checked.size) list.querySelector("header")?.insertAdjacentHTML("beforeend", '<button type="button" data-clear-selection>清空勾选</button>');
    const detail = root.querySelector<HTMLElement>(".enterprise-query-detail")!;
    const item = items.find(item => item.id === selected);
    if (!item) {
      detail.innerHTML = '<h2>企业详情</h2><div class="enterprise-query-empty"><i class="ph ph-identification-card" aria-hidden="true"></i><h3>选择一家企业</h3><p>点击左侧企业，查看基本信息、经营信息和联系方式。</p></div>';
      return;
    }
    const fields = tab === "basic" ? [["企业名称", item.company], ["统一社会信用代码", item.creditCode], ["成立时间", item.founded], ["所属行业", item.business], ["所属地区", item.country], ["企业规模", item.size], ["企业官网", item.website]] : tab === "operating" ? [["经营范围", item.description], ["注册资本", item.capital], ["经营状态", item.operatingStatus]] : [["联系人", item.contact], ["联系方式", item.contactInfo], ["企业官网", item.website]];
    if (tab === "basic") {
      fields.splice(3, 0, ["企业类型", undefined], ["注册资本", item.capital]);
      fields.splice(fields.length - 1, 0, ["经营状态", item.operatingStatus], ["法定代表人", undefined], ["注册地址", undefined]);
      if (item.lei) fields.push(["LEI", item.lei], ["登记编号（来源登记机关）", item.registryNumber], ["登记机关代码", item.registryAuthority], ["LEI登记状态", item.leiRegistrationStatus === 'LAPSED' ? '续期已逾期（不代表企业注销）' : item.leiRegistrationStatus], ["登记地址", item.address], ["邮政编码", item.postalCode], ["来源更新时间", item.sourceUpdatedAt]);
    }
    detail.innerHTML = `<header><h2>企业详情</h2><button type="button" data-close aria-label="关闭企业详情"><i class="ph ph-x" aria-hidden="true"></i></button></header><h3>${e(item.company)}</h3><p>${e(item.description || "暂无简介")}</p><div class="enterprise-query-tabs" role="tablist">${[["basic", "基本信息"], ["operating", "经营信息"], ["contact", "联系方式"]].map(([id, name]) => `<button type="button" role="tab" aria-selected="${tab === id}" data-tab="${id}">${name}</button>`).join("")}</div><dl>${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${e(value || "未提供")}</dd></div>`).join("")}</dl><p>数据来源：${e(item.sourceLabel || "已有企业线索资料")}</p><p role="status">${e(error)}</p><button type="button" class="enterprise-query-join" data-join ${busy || item.customerId || !item.leadId || !item.tenantProspectId ? "disabled" : ""}>${busy ? "正在加入…" : item.customerId ? "已加入客户池" : "加入客户池"}</button>${!item.customerId && (!item.leadId || !item.tenantProspectId) ? item.lei ? '<p>公开资料仅供查询，企业资料导入客户池待接入。</p>' : '<p>需先完成线索核验，再加入客户池。</p>' : ""}`;
    detail.querySelectorAll<HTMLElement>('[role="tab"]').forEach(button => { button.tabIndex = button.dataset.tab === tab ? 0 : -1; });
    detail.querySelector('h3')?.insertAdjacentHTML('beforeend',copyButton(item.company,'企业名称'));
    detail.querySelector('h3')?.insertAdjacentHTML('afterend','<p role="status" data-copy-status></p>');
    if(tab==='contact')detail.querySelectorAll('dl>div').forEach(row=>{if(row.querySelector('dt')?.textContent==='联系方式')row.querySelector('dd')?.insertAdjacentHTML('beforeend',copyButton(item.contactInfo,'联系方式'));});
    detail.querySelector<HTMLElement>('[role="status"]')?.setAttribute("aria-live", "polite");
    if (tab === "basic") detail.querySelector("dl")?.insertAdjacentHTML("afterend", `<section class="enterprise-query-scope"><h4>经营范围</h4><p>${e(item.description || "未提供")}</p></section>`);
  }
  async function load() {
    const version = ++queryVersion;
    loading = true; error = ""; refresh();
    try {
      if (remote) {
        const keyword = (root.querySelector<HTMLInputElement>('[name="keyword"]')?.value || "").trim();
        if (keyword.length < 2) throw new Error("请输入至少2字的企业名称后搜索。GLEIF仅覆盖已登记LEI的企业。");
        const result = await createEnterpriseApi().searchPublic(keyword, page + 1);
        if (version !== queryVersion || !root.isConnected) return;
        items = result.items; remoteTotal = result.total; page = result.page - 1;
      } else {
        const result = await api.list();
        if (version !== queryVersion || !root.isConnected) return;
        items = result;
      }
    } catch (cause) {
      if (version !== queryVersion || !root.isConnected) return;
      items = []; remoteTotal = 0; error = cause instanceof Error ? cause.message : "读取失败";
    }
    loading = false; refresh();
  }
  root.addEventListener("click", async event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!button || button.disabled) return;
    if(button.hasAttribute('data-copy-value')){event.stopPropagation();void copyEnterpriseValue(button);return;}
    if (button.hasAttribute('data-online-search')) {
      const unsupported = [['region', '地区'], ['industry', '行业'], ['size', '规模']]
        .filter(([name]) => root.querySelector<HTMLInputElement>(`[name=${name}]`)!.value.trim()).map(([, label]) => label);
      const notice = root.querySelector<HTMLElement>('#enterprise-online-scope')!;
      if (unsupported.length) {
        notice.textContent = `普通搜索不支持已选的${unsupported.join('、')}条件，尚未发起查询。请使用支持的高级条件查询，或明确清除这些条件后再搜索。`;
        return;
      }
      notice.textContent = '本次普通搜索仅使用关键词，没有地区、行业或规模条件；结果以网站实际可见范围为准。';
      const keyword=root.querySelector<HTMLInputElement>('[name=keyword]')!.value.trim();
      button.disabled=true;const text=button.textContent;button.textContent='正在搜索并读取…';
      try{await browser?.search(keyword);}finally{button.disabled=false;button.textContent=text;}
      return;
    }
    if (button.hasAttribute('data-advanced-search')) {
      const keyword=root.querySelector<HTMLInputElement>('[name=keyword]')!.value.trim();
      const region=regionPath(root.querySelector<HTMLInputElement>('[name=region]')!.value).map(node=>node.name);
      const industry=industryPath(root.querySelector<HTMLInputElement>('[name=industry]')!.value).map(node=>node.name);
      if(root.querySelector<HTMLSelectElement>('[name=size]')!.value){root.querySelector<HTMLElement>('.enterprise-browser-preview [role=status]')!.textContent='爱企查企业规模不是员工人数分组，不能精确对应。请将企业规模设为全部规模后查询。';return;}
      button.disabled=true;const text=button.textContent;button.textContent='正在按条件查询…';
      try{await browser?.query({keyword,region,industry});}finally{button.disabled=false;button.textContent=text;}
      return;
    }
    if (button.hasAttribute("data-reset-filters")) {
      browser?.clear();
      root.querySelector<HTMLFormElement>("form")!.reset(); filters.reset(); page = 0;
      if (remote) { queryVersion++; items = []; remoteTotal = 0; loading = false; error = ""; }
    }
    else if (button.hasAttribute("data-clear-selection")) checked.clear();
    else if (button.dataset.clearFilter) {
      const input = root.querySelector<HTMLFormElement>("form")!.elements.namedItem(button.dataset.clearFilter) as HTMLInputElement;
      input.value = ""; input.hidden = false; page = 0;
    }
    else if (button.dataset.company) { selected = button.dataset.company; tab = "basic"; error = ""; }
    else if (button.dataset.tab) tab = button.dataset.tab;
    else if (button.hasAttribute("data-close")) selected = "";
    else if (button.dataset.page) { page += Number(button.dataset.page); if (remote) { void load(); return; } }
    else if (button.hasAttribute("data-reload")) { void load(); return; }
    else if (button.hasAttribute("data-join")) {
      const item = items.find(item => item.id === selected);
      if (!item || busy) return;
      busy = true; error = ""; refresh();
      const key = keys.get(item.id) || crypto.randomUUID(); keys.set(item.id, key);
      try { item.customerId = await api.join(item, key); error = previewApi ? "模拟成功：已加入客户池，未写入真实数据。" : "已加入客户池，可在私域客户池查看。"; } catch (cause) { error = cause instanceof Error ? cause.message : "加入失败"; }
      busy = false;
    } else return;
    refresh();
  });
  root.addEventListener("keydown", event => {
    const target = event.target as HTMLElement;
    if (target.getAttribute("role") !== "tab") return;
    const order = ["basic", "operating", "contact"];
    const index = order.indexOf(tab);
    const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : -1;
    if (next < 0) return;
    event.preventDefault(); tab = order[next]; refresh();
    root.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
  });
  root.addEventListener("change", event => {
    const input = event.target as HTMLInputElement;
    if (input.hasAttribute("data-source")) {
      browser?.clear();
      remote = input.value === "gleif"; queryVersion++; items = []; selected = ""; checked.clear(); page = 0; remoteTotal = 0; error = ""; loading = false;
      root.querySelector<HTMLFormElement>("form")!.reset(); filters.reset(); filters.setRemote(remote);
      root.querySelector<HTMLElement>('[name="size"]')!.parentElement!.hidden = remote;
      root.querySelector<HTMLElement>("[data-source-note]")!.textContent = remote ? "免费CC0公开数据：仅覆盖中国已登记LEI的企业，不是全国工商库；按企业名称搜索，不提供行业、规模、电话。" : "";
      if (!remote) void load(); else refresh();
      return;
    }
    if (input.dataset.checkCompany) {
      if (input.checked) checked.add(input.dataset.checkCompany); else checked.delete(input.dataset.checkCompany);
      selected = input.dataset.checkCompany; tab = "basic"; refresh();
    } else if (input.dataset.checkAll) {
      root.querySelectorAll<HTMLInputElement>("[data-check-company]").forEach(row => {
        if (input.checked) checked.add(row.dataset.checkCompany!); else checked.delete(row.dataset.checkCompany!);
      });
      refresh();
    }
  });
  root.querySelector("form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    browser?.clear();
    page = 0; if (remote) void load(); else refresh();
  });
  void load();
}
