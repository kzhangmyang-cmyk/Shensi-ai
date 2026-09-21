/** Fixed visible-DOM pager. No URL construction, private APIs or hidden state. */
export function enterprisePaginationPage(action:'inspect'|'next',expectedPage?:number){
  const visible=(node:Element)=>node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden';
  const all=(selector:string)=>Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible);
  const leaves=all('[role=dialog],.modal,.ant-modal,.ivu-modal').map(el=>el.innerText).join(' ');
  const base={page:0,hasNext:false,signature:'',keyword:new URLSearchParams(location.search).get('q')||'',notice:''};
  if(location.origin!=='https://aiqicha.baidu.com'||location.pathname!=='/s')return {...base,status:'blocked',notice:'网站已离开普通搜索页，请重新搜索。'};
  const restriction=all('h1,h2,h3,p,span,div').find(el=>el.children.length<4&&el.innerText.length<160&&/免费机会已用完|开通超级会员\s*查看更多\d+条查询结果|请完成验证|拖动滑块|访问过于频繁/.test(el.innerText));
  if(restriction)return {...base,status:'blocked',notice:`网站限制：${restriction.innerText.trim()}。已有结果保留，已停止加载。`};
  if(/会员|次数|验证|频繁/.test(leaves))return {...base,status:'blocked',notice:'网站显示会员、次数或验证提示，请在内置浏览器查看；已有结果已保留。'};
  const next=all('[title="下一页"],[aria-label="下一页"]').find(el=>el.closest('ul'));
  const pager=next?.closest('ul');
  const active=Array.from(pager?.querySelectorAll<HTMLElement>('li,[aria-current=page]')||[]).find(el=>el.getAttribute('aria-current')==='page'||/active|selected/.test(el.className));
  const page=Number(active?.innerText.trim());
  const signature=all('.items h3').map(el=>el.innerText.trim()).join('\n');
  const hasNext=!!next&&!next.matches('[disabled],[aria-disabled=true]')&&!/disabled/.test(next.className);
  const notice=all('p,span,div').filter(el=>el.children.length<4).map(el=>el.innerText.trim()).find(text=>/^当前展示\d+条/.test(text)&&text.length<120)||'';
  const state={...base,page,signature,hasNext,notice,status:'ready'};
  if(!Number.isInteger(page)||page<1||!signature)return {...state,status:'blocked',hasNext:false,notice:'未识别当前搜索页码或企业卡片，请查看内置浏览器。'};
  if(action==='next'){
    if(page!==expectedPage)return {...state,status:'changed',notice:'网站页码已变化，请重新搜索，避免混入其他页面。'};
    if(!hasNext)return {...state,status:'end',notice:notice||'网站当前没有可用的下一页。'};
    next!.click();return {...state,status:'clicked'};
  }
  return state;
}
