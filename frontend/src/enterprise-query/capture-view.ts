import type {EnterpriseCapture} from '../../../desktop/src/shared/enterprise-browser';
import {escapeHtml as e} from '../demo/demo-ui';
import {copyButton,copyEnterpriseValue} from './copy';

/** Uses the desktop capture contract directly; it never fabricates CRM identifiers. */
export function renderEnterpriseCapture(host:HTMLElement,capture:EnterpriseCapture){
  let selected=-1;let page=0;
  host.innerHTML=`<p class="enterprise-capture-source">爱企查 · 当前可见页 ${capture.items.length} 家 · ${e(new Date(capture.capturedAt).toLocaleString())} · 未保存到客户池</p><div class="enterprise-query-panes"><section class="enterprise-query-list" aria-label="网站企业列表"></section><aside class="enterprise-query-detail" aria-label="网站企业详情"></aside></div>`;
  const list=host.querySelector<HTMLElement>('section')!;const detail=host.querySelector<HTMLElement>('aside')!;
  function showDetail(resetScroll=false){
    const previousScroll=detail.scrollTop;
    list.querySelectorAll<HTMLElement>('[data-capture-company]').forEach(row=>{const active=Number(row.dataset.captureCompany)===selected;row.classList.toggle('selected',active);row.setAttribute('aria-pressed',String(active));});
    const item=capture.items[selected];
    if(!item){detail.innerHTML='<h2>企业详情</h2><div class="enterprise-query-empty"><h3>选择一家企业</h3><p>点击列表查看当前网页提供的真实资料。</p></div>';return;}
    const fields=[['法定代表人',item.legalPerson],['注册资本',item.capital],['成立时间',item.founded],['统一社会信用代码',item.creditCode],['企业类型',item.companyType],['所属行业',item.industry],['地址',item.address],['公开联系方式',item.contactInfo],['公开邮箱',item.email],['参保人数（非员工总数）',item.insuredEmployees]];
    const fieldRows=(rows:typeof fields)=>rows.map(([name,value])=>`<div><dt>${e(name!)}</dt><dd class="${value?'':'enterprise-field-missing'}">${e(value||'当前页未提供')}${['公开联系方式','公开邮箱','统一社会信用代码'].includes(name!)?copyButton(value,name!):''}</dd></div>`).join('');
    detail.innerHTML=`<header><h2>企业详情</h2><button type="button" data-capture-close aria-label="关闭企业详情（Esc）">关闭 <span aria-hidden="true">×</span></button></header><h3>${e(item.company)} ${copyButton(item.company,'企业名称')}</h3><p role="status" data-copy-status></p><section class="enterprise-detail-group"><h4>工商资料</h4><dl>${fieldRows(fields.filter(([name])=>!['地址','公开联系方式','公开邮箱'].includes(name!)))}</dl></section><section class="enterprise-detail-group"><h4>地址与联系</h4><dl>${fieldRows(fields.filter(([name])=>['地址','公开联系方式','公开邮箱'].includes(name!)))}</dl></section><section class="enterprise-query-scope"><h4>经营范围</h4><p>${e(item.businessScope||'当前页未提供')}</p></section><p>来源：${e(item.sourceUrl)}</p><p>详情缺失字段可在内置浏览器打开该企业原始详情后读取；不会自动逐家访问或保存客户。</p>`;
    detail.scrollTop=resetScroll?0:previousScroll;
  }
  function showList(){
    const start=page*10;const visible=capture.items.slice(start,start+10);
    list.innerHTML=`<header>本次读取 <strong>${capture.items.length}</strong> 家企业</header>${visible.length?visible.map((item,n)=>`<button type="button" class="enterprise-query-row enterprise-capture-row" data-capture-company="${start+n}" aria-pressed="false"><span><strong>${e(item.company)}</strong><small>${e(item.address||'地址未提供')}</small></span><span>${e(item.legalPerson||'法人未提供')}</span><span>${e(item.founded||'成立时间未提供')}</span></button>`).join(''):'<div class="enterprise-query-empty" role="status"><h3>当前页没有企业资料</h3><p>请在内置浏览器打开企业列表或详情后重新读取。</p></div>'}<footer><span data-capture-range>显示 ${visible.length?start+1:0}–${start+visible.length} / ${capture.items.length} 家</span><span><button type="button" data-capture-page="-1" ${page===0?'disabled':''}>上一页</button> ${capture.items.length?page+1:0} / ${Math.ceil(capture.items.length/10)} <button type="button" data-capture-page="1" ${start+10>=capture.items.length?'disabled':''}>下一页</button></span></footer>`;
    showDetail();
  }
  function closeDetail(){
    const previous=selected;selected=-1;showDetail();
    const row=list.querySelector<HTMLElement>(`[data-capture-company="${previous}"]`);
    if(row)row.focus({preventScroll:true});
    else {list.tabIndex=-1;list.focus({preventScroll:true});}
  }
  host.onkeydown=event=>{if(event.key==='Escape'&&selected>=0){event.preventDefault();event.stopPropagation();closeDetail();}};
  host.onclick=event=>{
    const button=(event.target as Element).closest<HTMLButtonElement>('button');if(!button||button.disabled)return;
    event.stopPropagation();
    if(button.hasAttribute('data-copy-value')){void copyEnterpriseValue(button);return;}
    if(button.hasAttribute('data-capture-close')){closeDetail();return;}
    if(button.dataset.captureCompany!==undefined){selected=Number(button.dataset.captureCompany);showDetail(true);}
    else if(button.dataset.capturePage){page+=Number(button.dataset.capturePage);showList();list.scrollTop=0;list.tabIndex=-1;list.focus({preventScroll:true});}
  };
  showList();
  return {update(next:EnterpriseCapture){capture=next;host.querySelector('.enterprise-capture-source')!.textContent=`爱企查 · 本次累计 ${capture.items.length} 家 · ${new Date(capture.capturedAt).toLocaleString()} · 未保存到客户池`;const scroll=list.scrollTop;showList();list.scrollTop=scroll;}};
}
