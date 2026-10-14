import type { EnterpriseQuery } from '../shared/enterprise-browser.ts';

/** Serialized into the isolated world; only this fixed page operation is exposed. */
export async function enterpriseQueryPage(query: EnterpriseQuery, phase: 'prepare' | 'submit' | 'result' | 'ordinary-result') {
  const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const all = (selector: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(selector)].filter(visible);
  const label = (el: Element) => (el as HTMLElement).innerText?.replace(/\s+/g,' ').trim() || '';
  const stop = () => {
    const text = all('h1,h2,h3,p,span,div,section').filter(el => el.children.length < 2).map(label).join(' ');
    if (/开通超级会员\s*解锁高级搜索|解锁高级搜索|高级搜索次数已用完/.test(text)) return '当前爱企查账号没有可用的高级搜索权限。网站要求开通会员或查询次数已用完；未读取结果。';
    if (/安全验证|请完成验证|拖动滑块|访问过于频繁|访问异常/.test(text)) return '爱企查要求人工验证或限制访问，请在内置浏览器正常处理后再查询。';
    if (location.pathname === '/login' || location.hostname === 'passport.baidu.com' || location.hostname === 'wappass.baidu.com') return '请先在内置爱企查窗口登录本人账号。';
    return '';
  };
  const blocked = stop();
  if (blocked) return {status:'blocked',message:blocked};
  if (location.origin !== 'https://aiqicha.baidu.com') return {status:'blocked',message:'请在内置爱企查窗口完成登录。'};
  if (phase === 'result' || phase==='ordinary-result') {
    if (location.pathname === (phase==='ordinary-result'?'/s':'/advancesearch/list')) return {status:'results',message:''};
    return {status:'waiting',message:'正在等待网站查询结果'};
  }
  if (location.pathname !== '/advancesearch') return {status:'unsupported',message:'网站未进入高级搜索页，请检查登录和页面提示。'};
  const pause = () => new Promise(resolve=>setTimeout(resolve,150));
  const wait = async (probe:()=>HTMLElement | undefined) => {
    for (let n=0;n<30;n++) { const el=probe(); if(el) return el; if(stop()) throw new Error(stop()); await pause(); }
    throw new Error('网站筛选控件未出现或已改版，未提交查询。');
  };
  const click = (el:HTMLElement|null|undefined) => { if(!el) throw new Error('网站缺少对应选项，未放宽筛选条件。'); el.click(); };
  try {
    if(phase === 'submit') {
      const button=all('[data-log-an="advancesearch-show-list"]')[0];
      if(!button || button.hasAttribute('disabled')) return {status:'waiting',message:'网站查询条件仍在计算'};
      click(button); return {status:'submitted',message:''};
    }
    await wait(()=>all('.search-key input')[0]);
    // Clear site-retained conditions before applying this request. No saved templates are modified.
    click(all('[data-log-an="advancesearch-reset"]')[0]); await pause();
    const input=all('.search-key input')[0] as HTMLInputElement;
    input.value=query.keyword; input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true})); input.dispatchEvent(new Event('blur',{bubbles:true}));
    if(query.region.length) {
      click(all('.province-trigger')[0]);
      const modal=await wait(()=>all('.province-modal-dialog')[0]);
      const row=(level:number,name:string)=>all('.col',modal)[level]?.querySelectorAll<HTMLElement>('.col-item');
      const named=(level:number,name:string)=>[...(row(level,name)||[])].find(el=>label(el.querySelector('.col-item-text')!)===name);
      click(named(0,query.region[0])); await pause();
      if(query.region.length===2) {
        // Row click selects a province as well as expanding it. Reset keeps its city column but clears the broad selection.
        click(all('.reset-btn',modal)[0]); await pause(); click(named(1,query.region[1])); await pause();
      }
      const selection=all('.footer-tag',modal).map(label).join('');
      if(selection!==query.region.join('-')) throw new Error('网站地区选中结果不一致，未提交查询。');
      click(all('.confirm-btn',modal)[0]); await pause();
      if(all('.province-trigger-tag-text').map(label).join('')!==query.region.join('-')) throw new Error('网站没有确认所选地区，未提交查询。');
    }
    if(query.industry.length) {
      click(all('.select-trigger-wrapper')[0]);
      const panel=await wait(()=>all('.select-multi')[0]);
      click(all('[data-log-an="advancesearch-industryCode1-reset"]',panel)[0]); await pause();
      const group=(level:number,name:string)=>all('ul',panel)[level]?.querySelectorAll<HTMLElement>('.tree-select-wrap');
      const named=(level:number,name:string)=>[...(group(level,name)||[])].find(el=>label(el.querySelector('.title')!)===name);
      if(query.industry.length===2) { click(named(0,query.industry[0])?.querySelector<HTMLElement>('.title')); await pause(); }
      const level=query.industry.length-1;
      const leaf=named(level,query.industry[level]);
      const checkbox=leaf?.querySelector<HTMLInputElement>('input[type=checkbox]');
      if(!checkbox) throw new Error('爱企查没有同名行业选项，未改用上级或关键词。');
      if(!checkbox.checked) checkbox.click(); await pause();
      const selected=[...(all('ul',panel)[level]?.querySelectorAll<HTMLInputElement>('input[type=checkbox]')||[])].filter(el=>el.checked);
      if(!checkbox.checked || selected.length!==1) throw new Error('网站行业未精确选中，未提交查询。');
      click(all('[data-log-an="advancesearch-industryCode1-submit"]',panel)[0]); await pause();
    }
    // The site's count is debounced; wait for a usable visible submit, not an internal API or state object.
    await new Promise(resolve=>setTimeout(resolve,700));
    const message=stop();
    return message ? {status:'blocked',message} : {status:'ready',message:''};
  } catch(error) {return {status:'unsupported',message:error instanceof Error?error.message:'网站筛选失败，未提交查询。'};}
}
