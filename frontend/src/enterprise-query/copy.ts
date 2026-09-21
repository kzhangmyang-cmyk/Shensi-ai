import {escapeHtml as e} from '../demo/demo-ui';

export function copyButton(value:string|undefined,label:string){
  return value ? `<button type="button" class="enterprise-copy" data-copy-value="${e(value)}" aria-label="复制${e(label)}" title="复制${e(label)}">复制</button>` : '';
}

export async function copyEnterpriseValue(button:HTMLButtonElement){
  const detail=button.closest('.enterprise-query-detail');
  const status=detail?.querySelector<HTMLElement>('[data-copy-status]');
  button.disabled=true;
  try{
    const clipboard=globalThis.navigator?.clipboard;
    if(!clipboard)throw new Error('clipboard unavailable');
    await clipboard.writeText(button.dataset.copyValue||'');
    if(status?.isConnected)status.textContent='已复制';
  }catch{if(status?.isConnected)status.textContent='复制失败，请选中文字手动复制。';}
  finally{button.disabled=false;}
}
