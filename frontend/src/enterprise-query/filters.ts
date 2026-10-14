import { escapeHtml as e } from '../demo/demo-ui';
import { industryNodes, industryPath, searchIndustries } from './industry';
import { mountRegionPicker } from './region-picker';
import { regionPath } from './regions';

export function mountEnterpriseFilters(form: HTMLFormElement, changed: () => void) {
  const host = form.querySelector<HTMLElement>('[data-enterprise-filters]')!;
  host.innerHTML = `<div class="enterprise-region-picker enterprise-industry-picker"></div>
    <div class="enterprise-industry-picker" data-industry-picker><input type="hidden" name="industry" value="">
      <details><summary aria-label="选择行业">行业 · <span data-industry-label>全部行业</span></summary>
        <div class="enterprise-industry-panel">
          <label>查找行业<input data-industry-search aria-label="行业名称或代码" placeholder="名称或代码，例如 塑料 / 2921" maxlength="80"></label>
          <div data-industry-results class="enterprise-industry-results" hidden></div>
          <div data-industry-levels class="enterprise-industry-levels"></div>
          <p data-industry-path aria-live="polite">全部行业</p>
          <p>国民经济行业分类四级；选上级包含其下级。仅筛选已有资料中明确匹配的行业。</p>
          <footer><button type="button" data-industry-clear>不限行业</button><button type="button" data-industry-done>完成</button></footer>
        </div>
      </details>
    </div>`;
  const chips=form.ownerDocument.createElement('div');chips.className='enterprise-condition-chips';chips.dataset.conditionChips='';chips.hidden=true;form.append(chips);
  function renderChips(){
    const value=(name:string)=>(form.querySelector<HTMLInputElement>(`[name=${name}]`)?.value||'').trim();
    const entries=[['keyword','关键词',value('keyword')],['region','地区',regionPath(value('region')).map(n=>n.name).join(' / ')],['industry','行业',industryPath(value('industry')).map(n=>n.name).join(' / ')],['size','规模',value('size')]].filter(entry=>entry[2]);
    chips.hidden=!entries.length;
    const markup=entries.map(([key,label,value])=>`<button type="button" data-condition-clear="${key}" aria-label="清除${label}：${e(value)}" title="${e(value)}">${label}：${e(value)} <span aria-hidden="true">×</span></button>`).join('');
    if(chips.innerHTML!==markup)chips.innerHTML=markup;
  }
  const region = mountRegionPicker(host.querySelector('.enterprise-region-picker')!, ()=>{renderChips();changed();});
  const input = host.querySelector<HTMLInputElement>('[name=industry]')!;
  const details = host.querySelector<HTMLDetailsElement>('[data-industry-picker] details')!;
  const search = host.querySelector<HTMLInputElement>('[data-industry-search]')!;
  const results = host.querySelector<HTMLElement>('[data-industry-results]')!;
  const levels = host.querySelector<HTMLElement>('[data-industry-levels]')!;
  function render() {
    const path = industryPath(input.value);
    host.querySelector('[data-industry-label]')!.textContent = path.at(-1)?.name || '全部行业';
    host.querySelector('[data-industry-path]')!.textContent = path.length ? path.map(n => `${n.code} ${n.name}`).join(' / ') : '全部行业';
    levels.innerHTML = ['门类','大类','中类','小类'].map((label, level) => {
      const parent = level === 0 ? '' : path[level-1]?.code;
      const options = parent === undefined ? [] : industryNodes.filter(n => n.parent === parent);
      return `<label>${label}<select data-industry-level="${level}" aria-label="行业${label}" ${options.length ? '' : 'disabled'}><option value="">${level === 0 ? '全部行业' : '不限下级'}</option>${options.map(n => `<option value="${n.code}" ${path[level]?.code === n.code ? 'selected' : ''}>${n.code} ${e(n.name)}</option>`).join('')}</select></label>`;
    }).join('');
  }
  function choose(code: string) { input.value = code; render(); renderChips(); changed(); }
  host.addEventListener('change', event => {
    const target = event.target as HTMLSelectElement;
    if (target.dataset.industryLevel !== undefined) {
      const level = Number(target.dataset.industryLevel);
      choose(target.value || industryPath(input.value)[level-1]?.code || '');
    }
  });
  search.addEventListener('input', () => {
    const term = search.value.trim();
    results.hidden = !term; levels.hidden = Boolean(term);
    if (!term) { results.replaceChildren(); return; }
    const matches = searchIndustries(term);
    results.innerHTML = `<p role="status">${matches.length ? `匹配 ${matches.length} 项${matches.length > 60 ? '，显示前60项，请细化关键词' : ''}` : '没有匹配行业，请尝试其他名称或代码'}</p>${matches.slice(0,60).map(n => `<button type="button" data-industry-code="${n.code}"><strong>${n.code} ${e(n.name)}</strong><small>${e(industryPath(n.code).map(p => p.name).join(' / '))}</small></button>`).join('')}`;
  });
  host.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button) return;
    if (button.dataset.industryCode) { choose(button.dataset.industryCode); search.value = ''; results.hidden = true; levels.hidden = false; }
    if (button.hasAttribute('data-industry-clear')) { choose(''); search.value = ''; results.hidden = true; levels.hidden = false; }
    if (button.hasAttribute('data-industry-done')) { details.open = false; details.querySelector('summary')!.focus(); }
  });
  details.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); details.open = false; details.querySelector('summary')!.focus(); }
  });
  form.addEventListener('input',renderChips);
  form.addEventListener('change',renderChips);
  chips.addEventListener('click',event=>{
    const button=(event.target as Element).closest<HTMLButtonElement>('[data-condition-clear]');if(!button)return;
    event.stopPropagation();const key=button.dataset.conditionClear!;
    if(key==='region')region.reset();
    else if(key==='industry'){input.value='';search.value='';results.hidden=true;levels.hidden=false;render();}
    else {const control=form.querySelector<HTMLInputElement>(`[name=${key}]`);if(control)control.value='';}
    renderChips();changed();
  });
  render();
  return {
    reset() { region.reset(); input.value = ''; search.value = ''; results.hidden = true; levels.hidden = false; details.open = false; render(); renderChips(); },
    setRemote(remote: boolean) { host.hidden = remote; if (remote) host.querySelectorAll('details').forEach(d=>{d.open=false;}); },
  };
}
