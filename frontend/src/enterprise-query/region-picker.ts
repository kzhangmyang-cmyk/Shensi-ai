import {escapeHtml as e} from '../demo/demo-ui';
import {regionChildren,regionPath,searchRegions} from './regions';

export function mountRegionPicker(host: HTMLElement, changed: ()=>void) {
  host.innerHTML = `<input type="hidden" name="region" value=""><details><summary aria-label="选择地区">地区 · <span data-region-label>不限地区</span></summary><div class="enterprise-industry-panel">
    <label>查找地区<input data-region-search aria-label="省份或城市名称" placeholder="省份或城市名称，例如 河南 / 郑州" maxlength="80"></label>
    <div data-region-results class="enterprise-industry-results" hidden></div>
    <div class="enterprise-industry-levels"><label>省份<select data-region-province aria-label="省份"></select></label><label>地级或直辖单位<select data-region-city aria-label="地级或直辖单位"></select></label></div>
    <p data-region-path aria-live="polite"></p><p data-region-note></p>
    <p>区划目录：2023年快照。仅筛选已有资料中明确的地区；不代表全国企业数据已接入。</p>
    <footer><button type="button" data-region-clear>不限地区</button><button type="button" data-region-done>完成</button></footer></div></details>`;
  const input=host.querySelector<HTMLInputElement>('[name=region]')!;
  const details=host.querySelector('details')!;
  const province=host.querySelector<HTMLSelectElement>('[data-region-province]')!;
  const city=host.querySelector<HTMLSelectElement>('[data-region-city]')!;
  const search=host.querySelector<HTMLInputElement>('[data-region-search]')!;
  const results=host.querySelector<HTMLElement>('[data-region-results]')!;
  function render() {
    const path=regionPath(input.value), parent=path[0], selected=path.at(-1);
    host.querySelector('[data-region-label]')!.textContent=selected?.name || '不限地区';
    host.querySelector('[data-region-path]')!.textContent=path.map(n=>n.name+(n.kind==='direct'?'（省直辖县级）':'')).join(' / ') || '全国目录 · 不限地区';
    province.innerHTML='<option value="">全国 / 不限</option>'+regionChildren('').map(n=>`<option value="${n.code}" ${n.code===parent?.code?'selected':''}>${e(n.name)}</option>`).join('');
    const children=parent ? regionChildren(parent.code) : [];
    city.disabled=!children.length;
    city.innerHTML='<option value="">不限下级</option>'+children.map(n=>`<option value="${n.code}" ${n.code===selected?.code?'selected':''}>${e(n.name)}${n.kind==='direct'?'（省直辖县级）':''}</option>`).join('');
    host.querySelector('[data-region-note]')!.textContent=parent?.kind==='municipality'?'直辖市直接按本市筛选，不设地级市层。': parent && !children.length?'此目录未提供该地区下级，不补造城市。':'包含地级市、地区、自治州、盟；省直辖县级单位单独标注。';
  }
  function choose(code:string) { input.value=code; render(); changed(); }
  province.addEventListener('change',()=>{ choose(province.value); province.focus(); });
  city.addEventListener('change',()=>{ choose(city.value || province.value); city.focus(); });
  search.addEventListener('input',()=>{
    results.hidden=!search.value.trim();
    if(results.hidden) { results.replaceChildren(); return; }
    const matches=searchRegions(search.value);
    results.innerHTML=`<p role="status">${matches.length ? `匹配 ${matches.length} 项${matches.length>40?'，显示前40项':''}`:'没有匹配地区'}</p>`+matches.slice(0,40).map(n=>`<button type="button" data-region-code="${n.code}"><strong>${e(n.name)}${n.kind==='direct'?'（省直辖县级）':''}</strong><small>${e(regionPath(n.code).map(p=>p.name).join(' / '))}</small></button>`).join('');
  });
  host.addEventListener('click',event=>{
    const button=(event.target as Element).closest<HTMLButtonElement>('button');
    if(!button)return;
    if(button.dataset.regionCode || button.hasAttribute('data-region-clear')) { choose(button.dataset.regionCode || ''); search.value=''; results.hidden=true; }
    if(button.hasAttribute('data-region-done')) {details.open=false; details.querySelector('summary')!.focus();}
  });
  details.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();details.open=false;details.querySelector('summary')!.focus();}});
  render();
  return {reset(){input.value='';search.value='';results.hidden=true;details.open=false;render();}};
}
