import {validateEnterpriseQuery, type EnterpriseCapture, type EnterpriseQuery} from '../../../desktop/src/shared/enterprise-browser';
import {mergeEnterpriseCards,type EnterpriseSearchCapture,type EnterprisePagination} from '../../../desktop/src/shared/enterprise-browser';

/** Explicit local preview; never calls the business API or converts prospects. */
export function mountBrowserEnterprisePreview(root: HTMLElement, onCapture?: (capture:EnterpriseCapture|null,append?:boolean)=>void) {
  const bridge = (window as unknown as { shensiEnterpriseBrowser?: { readPreview(): Promise<EnterpriseCapture>; openLocal?(keyword?:string): Promise<void>; captureLocal?(): Promise<EnterpriseCapture>; queryLocal?(query:EnterpriseQuery):Promise<EnterpriseCapture>; searchLocal?(keyword:string):Promise<EnterpriseSearchCapture>;nextLocal?(batchId:string):Promise<{capture?:EnterpriseCapture;pagination:EnterprisePagination}> } }).shensiEnterpriseBrowser;
  if (!bridge) return;
  const section = document.createElement('section');
  section.className = 'enterprise-browser-preview';
  section.innerHTML = `<header><h3>企业浏览器 · 当前页预览</h3>${bridge.openLocal ? '<button type="button" data-local-open>打开爱企查</button><button type="button" data-local-capture>读取内置浏览器当前页</button>' : ''}<button type="button" data-browser-read>${bridge.openLocal ? '可选 · 读取 Chrome 扩展预览' : '读取 Chrome 扩展预览'}</button><button type="button" data-browser-clear hidden>关闭预览</button></header><p role="status">${bridge.openLocal ? '优先使用内置浏览器：打开爱企查、本人登录并搜索，再读取当前页；不需要安装 Chrome。扩展预览只供已安装扩展的用户选用。' : '使用 Chrome 扩展发送当前页后在此读取；预览不自动保存客户。'}</p><div data-browser-rows></div>`;
  root.prepend(section);
  const status = section.querySelector<HTMLElement>('[role="status"]')!;
  const rows = section.querySelector<HTMLElement>('[data-browser-rows]')!;
  const button = section.querySelector<HTMLButtonElement>('[data-browser-read]')!;
  const clear = section.querySelector<HTMLButtonElement>('[data-browser-clear]')!;
  const open = section.querySelector<HTMLButtonElement>('[data-local-open]');
  const captureButton = section.querySelector<HTMLButtonElement>('[data-local-capture]');
  const retry=document.createElement('button');retry.type='button';retry.dataset.browserRetry='';retry.textContent='重试读取';retry.hidden=true;status.after(retry);
  let lastRead:(()=>Promise<EnterpriseCapture>)|undefined;let lastScope='';
  const more=document.createElement('button');more.type='button';more.dataset.browserMore='';more.textContent='加载更多企业';more.hidden=true;retry.after(more);
  let accumulated:EnterpriseCapture|undefined;let pagination:EnterprisePagination|undefined;
  let generation=0;
  let reading=false;
  function closePreview(){generation++;lastRead=undefined;accumulated=undefined;pagination=undefined;more.hidden=true;retry.hidden=true;rows.replaceChildren();clear.hidden=true;onCapture?.(null);status.textContent='预览已关闭，未写入客户池。';}
  async function openSearch(keyword?:string) {
    if (!open || open.disabled) return;
    open.disabled = true; status.textContent = '正在打开爱企查…';
    try { await bridge!.openLocal!(keyword); status.textContent = keyword ? `已打开爱企查搜索“${keyword}”。地区、行业精确条件请在网站中选择；返回此处读取可见结果。` : '爱企查已打开。完成登录和搜索后，返回此处读取当前页。'; }
    catch (error) { status.textContent = error instanceof Error ? error.message : '打开失败，请重试'; }
    finally { open.disabled = false; }
  }
  open?.addEventListener('click', () => void openSearch());
  clear.addEventListener('click', closePreview);
  async function read(load: () => Promise<EnterpriseCapture>, scope='') {
    if(reading)return;reading=true;const current=++generation;
    accumulated=undefined;pagination=undefined;more.hidden=true;
    lastRead=load;lastScope=scope;retry.hidden=true;section.setAttribute('aria-busy','true');section.dataset.state='loading';
    onCapture?.(null);rows.replaceChildren();clear.hidden=true;
    button.disabled = true; if (captureButton) captureButton.disabled = true; status.textContent = '正在读取本机预览…';
    try {
      const capture:EnterpriseSearchCapture = await load();
      if (!section.isConnected || current!==generation) return;
      accumulated=capture;pagination=capture.pagination;more.hidden=!(onCapture&&bridge?.nextLocal&&pagination?.hasNext);
      if(onCapture){onCapture(capture);clear.hidden=false;status.textContent=`${scope}已回传 ${capture.items.length} 家可见企业，请在下方列表点击查看详情；未保存到客户池。`;return;}
      rows.replaceChildren();
      const table = document.createElement('table');
      const thead = document.createElement('thead'); const head = document.createElement('tr'); thead.append(head); table.append(thead);
      for (const label of ['企业名称', '法定代表人', '注册资本', '成立时间', '地址', '公开联系方式']) {
        const cell = document.createElement('th'); cell.textContent = label; head.append(cell);
      }
      const body = document.createElement('tbody'); table.append(body);
      for (const item of capture.items) {
        const row = document.createElement('tr'); body.append(row);
        for (const value of [item.company, item.legalPerson, item.capital, item.founded, item.address, item.contactInfo]) { const cell = document.createElement('td'); cell.textContent = value || '未提供'; row.append(cell); }
      }
      rows.append(table); clear.hidden = false;
      for (const item of capture.items) {
        if (!item.creditCode && !item.businessScope) continue;
        const detail = document.createElement('details'); const summary = document.createElement('summary');
        summary.textContent = `${item.company} · 查看完整资料`; detail.append(summary);
        const list = document.createElement('dl');
        for (const [label, value] of [['统一社会信用代码', item.creditCode], ['企业类型', item.companyType], ['所属行业', item.industry], ['参保人数（非员工总数）', item.insuredEmployees], ['公开邮箱', item.email], ['经营范围', item.businessScope]]) {
          const term = document.createElement('dt'); term.textContent = label || '';
          const description = document.createElement('dd'); description.textContent = value || '当前页未提供'; list.append(term, description);
        }
        detail.append(list); rows.append(detail);
      }
      status.textContent = `来源：爱企查当前页 · 读取时间：${new Date(capture.capturedAt).toLocaleString()} · 去重后 ${capture.items.length} 家。仅本机预览，尚未正式保存客户；不代表全部搜索结果。`;
    } catch (error) { if(current===generation && section.isConnected){rows.replaceChildren(); clear.hidden = true;retry.hidden=false;section.dataset.state='error'; status.textContent = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /,'') : '读取失败，请重新发送浏览器预览';} }
    finally { reading=false;section.setAttribute('aria-busy','false');if(section.dataset.state==='loading')section.dataset.state='ready';button.disabled = false; if (captureButton) captureButton.disabled = false; }
  }
  retry.addEventListener('click',()=>{if(lastRead)void read(lastRead,lastScope);});
  more.addEventListener('click',async()=>{
    if(reading||!pagination||!accumulated||!bridge.nextLocal)return;
    const current=generation;const old=accumulated;reading=true;more.disabled=true;button.disabled=true;if(captureButton)captureButton.disabled=true;
    section.setAttribute('aria-busy','true');more.textContent='正在读取下一页…';
    try{
      const result=await bridge.nextLocal(pagination.batchId);
      if(current!==generation||!section.isConnected)return;
      pagination=result.pagination;
      if(result.capture){accumulated={...result.capture,items:mergeEnterpriseCards(old.items,result.capture.items)};onCapture?.(accumulated,true);status.textContent=`第 ${pagination.page} 页已读取 · 新增 ${accumulated.items.length-old.items.length} 家 · 累计 ${accumulated.items.length} 家。${pagination.notice}`;}
      else status.textContent=`累计 ${old.items.length} 家。${pagination.notice}`;
      more.hidden=!pagination.hasNext;
    }catch(error){if(current===generation&&section.isConnected)status.textContent=`${error instanceof Error?error.message.replace(/^Error invoking remote method '[^']+': Error: /,''):'读取失败'} 已有 ${old.items.length} 家保留，可重试。`;}
    finally{reading=false;more.disabled=false;button.disabled=false;if(captureButton)captureButton.disabled=false;more.textContent='加载更多企业';section.setAttribute('aria-busy','false');}
  });
  button.addEventListener('click', () => void read(() => bridge.readPreview()));
  captureButton?.addEventListener('click', () => void read(() => bridge.captureLocal!()));
  async function query(query:EnterpriseQuery){
    try{validateEnterpriseQuery(query);}catch(error){status.textContent=(error as Error).message;return;}
    if(!bridge?.queryLocal){status.textContent='当前应用尚未加载条件查询，请重启最新开发版。';return;}
    await read(()=>bridge.queryLocal!(query));
  }
  async function search(keyword:string){
    if(keyword.trim().length<2){status.textContent='普通搜索请输入至少2字关键词，例如“塑料”。不会使用地区或行业替代关键词。';return;}
    if(!bridge?.searchLocal){status.textContent='请重启最新开发版以使用普通搜索。';return;}
    await read(()=>bridge.searchLocal!(keyword.trim()),`普通搜索“${keyword.trim()}” · 未应用地区、行业及规模筛选。`);
  }
  return {openSearch,query,search,clear:closePreview};
}
