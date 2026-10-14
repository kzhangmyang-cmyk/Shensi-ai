import type {components} from '../generated/decision-simulation';
import type {GrowthHttpClient} from '../growth/http';
import {mountDecisionPreferences} from '../decision-simulation/preferences';
import {createOperatingMemoryApi,mountDecisionMemory} from './operating-memory';

/** Same records and controls as simulation; opening a chat never loads/applies memory. */
export function mountOperatingWorkbench(host:HTMLElement,http:GrowthHttpClient,live:()=>boolean){
 let selected:components['schemas']['OperatingMemorySelection']|undefined;
 let initialized=false;let disposed=false;let generation=0;
 const valid=()=>!disposed&&host.isConnected&&live();
 host.innerHTML='<details data-agent-operating-workbench><summary>经营偏好与执行复盘</summary><div data-operating-content></div></details>';
 const details=host.querySelector('details')!;
 const initialize=()=>{
  if(initialized||!valid())return;initialized=true;
  const content=host.querySelector<HTMLElement>('[data-operating-content]')!;
  content.innerHTML='<p>与星盘共用本人经营领域档案。先保存，再点击“用于本次输入”才用于后续文字问答；语音与获客命令不使用此偏好。现金底线仅由星盘确定性计算核对，不当成公司现金事实。</p><div data-operating-editor></div><div data-operating-memory></div><p data-operating-selection role="status">本次问答未使用长期偏好。</p><button type="button" data-operating-clear>取消本次问答偏好</button><section><h3>原报告建议复盘</h3><p>读取本人已保存的星盘建议，使用同一计划与复盘记录；不把聊天回答当作已执行业务。</p><button type="button" data-operating-reports>读取本人报告</button><div data-operating-report-list></div><div data-operating-reviews></div><p data-operating-report-status role="status"></p></section>';
  const editorHost=content.querySelector<HTMLElement>('[data-operating-editor]')!;
  const editor=mountDecisionPreferences(editorHost);
  const status=content.querySelector<HTMLElement>('[data-operating-selection]')!;
  const clear=()=>{selected=undefined;status.textContent='本次问答未使用长期偏好。';};
  editorHost.addEventListener('change',clear);editorHost.addEventListener('click',clear);
  content.querySelector<HTMLButtonElement>('[data-operating-clear]')!.onclick=clear;
  const memory=mountDecisionMemory(content.querySelector<HTMLElement>('[data-operating-memory]')!,createOperatingMemoryApi(http),{
   read:editor.read,set:(value,selection)=>{editor.set(value);selected=selection;status.textContent='已选用本人经营偏好；每次文字问答会重新校验启用状态与版本。';}
  },valid,(name,text)=>{
   const url=URL.createObjectURL(new Blob([text],{type:'application/json;charset=utf-8'}));
   const link=host.ownerDocument.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  const reportStatus=content.querySelector<HTMLElement>('[data-operating-report-status]')!;
  const list=content.querySelector<HTMLElement>('[data-operating-report-list]')!;
  const reviews=content.querySelector<HTMLElement>('[data-operating-reviews]')!;
  content.querySelector<HTMLButtonElement>('[data-operating-reports]')!.onclick=()=>{
   const token=++generation;reportStatus.textContent='正在读取本人报告…';
   void http.request<components['schemas']['ListItem'][]>('/api/v1/decision-simulations').then(({body})=>{
    if(!valid()||token!==generation)return;list.replaceChildren();
    for(const report of body){
     const button=host.ownerDocument.createElement('button');button.type='button';button.textContent=report.title;button.dataset.operatingReport=report.runId;list.append(button);
     button.onclick=()=>{
      const current=++generation;reportStatus.textContent='正在读取原报告建议…';
      void http.request<components['schemas']['Record']>(`/api/v1/decision-simulations/${encodeURIComponent(report.runId)}`).then(({body:record})=>{
       if(!valid()||current!==generation)return;memory.showReport(reviews,record);reportStatus.textContent=`原报告：${record.input.title}；旧报告快照保持不变。`;
      }).catch(()=>{if(valid()&&current===generation)reportStatus.textContent='原报告读取失败，请重试。';});
     };
    }
    reportStatus.textContent=body.length?'选择报告查看其原始建议与个人复盘。':'尚无已保存报告；不会补造建议。';
   }).catch(()=>{if(valid()&&token===generation)reportStatus.textContent='报告列表读取失败，请重试。';});
  };
 };
 details.addEventListener('toggle',()=>{if(details.open)initialize();});
 details.querySelector('summary')!.addEventListener('click',initialize);
 return {selection:()=>valid()?selected:undefined,clear(){selected=undefined;const status=host.querySelector('[data-operating-selection]');if(status)status.textContent='角色或会话已变化，请重新显式选择偏好。';},dispose(){disposed=true;selected=undefined;generation++;}};
}
