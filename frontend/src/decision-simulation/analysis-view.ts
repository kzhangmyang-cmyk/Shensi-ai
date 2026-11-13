import {escapeHtml as e} from '../demo/demo-ui';
import type {components} from '../generated/decision-simulation';
import {mountGalaxyDust} from './galaxy-dust';

type Preparation=components['schemas']['Preparation'];
const roles=[['founder','经营负责人','经营目标','user'],['market','市场','需求与渠道','chart-bar'],['operations','运营','产能与交付','gear'],['finance','财务','现金与成本','coins'],['judge','综合复核','条件与结论','shield-check']] as const;
const states={queued:'等待中',running:'分析中',completed:'已完成',insufficient:'资料不足',failed:'调用失败',cancelled:'已取消'};
const duties:Record<string,string>={founder:'明确经营目标、约束与关键取舍，检查方案是否符合企业当前阶段。',market:'分析市场需求、客户与渠道，核对增长假设和公开依据。',operations:'评估产能、交付与执行资源，识别运营瓶颈。',finance:'核对现金、成本与收益假设，评估资金承受能力。',judge:'综合各角色意见，标明分歧、成立条件与仍需验证的问题。'};

/** Decoration never advances task state. Only server snapshots update the five nodes. */
export function mountDecisionAnalysis(host:HTMLElement,retry:()=>void,retainOnDetach=false){
  const doc=host.ownerDocument,win=doc.defaultView;
  const asset=new URL('./assets/galaxy-cosmos-blue.png',import.meta.url).href;
  host.innerHTML=`<section class="decision-analysis" aria-label="五角色协同分析" data-motion="paused"><div class="decision-galaxy"><div class="decision-galaxy-art" aria-hidden="true"><img src="${e(asset)}" alt="" class="decision-galaxy-base"><canvas class="decision-galaxy-dust" aria-hidden="true"></canvas></div><header><p data-analysis-kind></p><h3>五位智能体，协同推演</h3><p data-analysis-headline>正在结合企业资料与经营模型分析</p></header><div class="decision-galaxy-nodes">${roles.map(([role,label,detail,icon],index)=>`<div class="decision-galaxy-node decision-galaxy-node-${index}" data-analysis-node="${role}" data-state="queued"><i class="ph ph-${icon}" aria-hidden="true"></i><strong>${label}</strong><small>${detail}</small><span data-node-state>等待中</span></div>`).join('')}</div></div><aside class="decision-analysis-sidebar"><h3>分析进度</h3><p>五位智能体从不同角度分析同一份资料</p><ol>${roles.map(([role,label,detail,icon])=>`<li data-analysis-role="${role}" data-state="queued"><i class="ph ph-${icon}" aria-hidden="true"></i><div><strong>${label}</strong><small>${detail}</small><small data-role-model></small></div><span data-role-state>等待中</span></li>`).join('')}</ol><h4>资料来源</h4><div class="decision-analysis-files" data-analysis-files></div><div class="decision-analysis-result" role="status"><strong data-analysis-progress>已完成 0 / 5</strong><p data-analysis-message></p></div><button type="button" data-analysis-retry hidden>重试本次分析</button><button type="button" data-reduce-motion aria-pressed="false">减少动态效果</button></aside></section>`;
  const root=host.querySelector<HTMLElement>('.decision-analysis')!;
  const background=doc.createElement('img');background.src=asset;background.alt='';background.className='decision-cosmos-background';background.setAttribute('aria-hidden','true');root.prepend(background);
  const progressHeader=doc.createElement('div');progressHeader.className='decision-analysis-progress-header';
  progressHeader.innerHTML='<strong data-analysis-percent></strong><progress max="5" value="0" aria-label="已完成角色数量"></progress>';
  root.querySelector('.decision-analysis-sidebar h3')!.after(progressHeader);
  const findings=doc.createElement('footer');findings.className='decision-analysis-findings';
  findings.innerHTML='<div><i class="ph ph-file-text" aria-hidden="true"></i><div><strong data-findings-heading>阶段性发现</strong><p>来自当前已保存的角色分析</p></div></div><dl><div><dd data-findings-count>0</dd><dt>条分析观察</dt></div><div><dd data-evidence-count>0</dd><dt>处原文依据</dt></div></dl><button type="button" data-analysis-open-results>查看分析依据 <i class="ph ph-arrow-right" aria-hidden="true"></i></button>';
  root.append(findings);
  const galaxy=root.querySelector<HTMLElement>('.decision-galaxy')!;
  galaxy.querySelector('header')!.append(root.querySelector('[data-reduce-motion]')!);
  const atmosphere=doc.createElement('img');atmosphere.src=asset;atmosphere.alt='';atmosphere.className='decision-galaxy-atmosphere';atmosphere.setAttribute('aria-hidden','true');galaxy.prepend(atmosphere);
  galaxy.append(root.querySelector<HTMLCanvasElement>('canvas')!);
  const dust=mountGalaxyDust(root.querySelector<HTMLCanvasElement>('canvas')!);
  const q=<T extends HTMLElement=HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
  const evidence=doc.createElement('section');evidence.className='decision-analysis-evidence';evidence.dataset.analysisEvidence='';evidence.setAttribute('aria-live','polite');root.after(evidence);
  let snapshot:Preparation|undefined,mode:'live'|'history'|'empty'='live',selectedRole:string='founder';
  const showRole=(role:string)=>{
    selectedRole=role;const agent=snapshot?.agents.find(item=>item.role===role);
    for(const [key]of roles)q(`[data-analysis-node="${key}"]`).setAttribute('aria-pressed',String(key===role));
    evidence.innerHTML=`<h3>${e(roles.find(item=>item[0]===role)?.[1]??role)} · ${mode==='empty'?'职责说明':mode==='history'?'保存结果':'角色详情'}</h3><p>${e(duties[role]??'')}</p>${agent?`<p>${e(states[agent.state])} · ${e(agent.provider??'')} / ${e(agent.model??'')}</p>${agent.observations.map(item=>`<p>${e(item.text)}</p><details><summary>查看保存依据</summary>${item.sourceRefs.map(ref=>`<p><code>${e(ref)}</code> ${e(snapshot?.sources.find(source=>source.sourceRef===ref)?.text??'此引用未保存在当前记录')}</p>`).join('')}</details>`).join('')||'<p>当前没有可显示的角色正文。</p>'}`:mode==='empty'?'<p>待开始 · 尚无分析结果。查看职责不会启动模型。</p>':'<p>此记录未保存该角色结果；没有重新调用模型。</p>'}`;
  };
  for(const [role,label]of roles){const node=q(`[data-analysis-node="${role}"]`);node.tabIndex=0;node.setAttribute('role','button');node.setAttribute('aria-label',`查看${label}结果`);node.onclick=()=>showRole(role);node.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();showRole(role);}};}
  q<HTMLButtonElement>('[data-analysis-open-results]').onclick=()=>{const role=snapshot?.agents.find(agent=>agent.observations.length)?.role;if(role){showRole(role);evidence.scrollIntoView?.({block:'nearest',behavior:'smooth'});}};
  const media=win?.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reduced=false,active=false,disposed=false,state:Preparation['state']='awaiting_confirmation';
  const syncMotion=()=>{root.dataset.motion=!disposed&&active&&!doc.hidden&&!reduced&&!media?.matches&&(state==='analyzing'||mode==='history'||mode==='empty')?'running':'paused';dust.setRunning(root.dataset.motion==='running');q('[data-reduce-motion]').setAttribute('aria-pressed',String(reduced||Boolean(media?.matches)));q('[data-reduce-motion]').textContent=media?.matches?'已遵循系统减少动态':reduced?'恢复动态效果':'减少动态效果';};
  q<HTMLButtonElement>('[data-reduce-motion]').onclick=()=>{reduced=!reduced;syncMotion();};
  q<HTMLButtonElement>('[data-analysis-retry]').onclick=()=>{if(state==='failed')retry();};
  doc.addEventListener('visibilitychange',syncMotion);media?.addEventListener('change',syncMotion);
  function dispose(){if(disposed)return;disposed=true;active=false;syncMotion();dust.dispose();doc.removeEventListener('visibilitychange',syncMotion);media?.removeEventListener('change',syncMotion);observer?.disconnect();}
  const observer=win?.MutationObserver?new win.MutationObserver(()=>{if(!root.isConnected){if(retainOnDetach){active=false;syncMotion();}else dispose();}}):undefined;observer?.observe(doc.body,{childList:true,subtree:true});
  return {
    update(value:Preparation,displayMode:'live'|'history'|'empty'='live'){
      snapshot=value;mode=displayMode;root.dataset.displayMode=mode;
      progressHeader.hidden=mode==='empty';findings.hidden=mode==='empty';
      q('.decision-analysis-sidebar h3').textContent=mode==='empty'?'五角色职责':'分析进度';
      for(const [role,label]of roles)q(`[data-analysis-node="${role}"]`).setAttribute('aria-label',`查看${label}${mode==='empty'?'职责':'结果'}`);
      state=value.state;root.dataset.state=state;
      const completed=value.agents.filter(agent=>agent.state==='completed').length;
      const observations=value.agents.flatMap(agent=>agent.observations);
      const refs=new Set(observations.flatMap(item=>item.sourceRefs).filter(ref=>value.sources.some(source=>source.sourceRef===ref)));
      q('progress').setAttribute('value',String(completed));q('progress').hidden=mode==='empty';
      q('[data-analysis-percent]').textContent=mode==='empty'?'预览':`${completed*20}%`;
      q('[data-findings-count]').textContent=String(observations.length);
      q('[data-evidence-count]').textContent=String(refs.size);
      q('[data-findings-heading]').textContent=observations.length?'阶段性发现':'尚无分析结果';
      q<HTMLButtonElement>('[data-analysis-open-results]').disabled=!observations.length;
      q('[data-analysis-kind]').textContent=`${value.dataKind==='synthetic'?'合成示例':'企业资料'} · ${value.files.length}份文件`;
      q('[data-analysis-progress]').textContent=`已完成 ${value.agents.filter(agent=>agent.state==='completed').length} / 5`;
      q('[data-analysis-headline]').textContent=state==='failed'?'本次分析未完成':state==='completed'?'分析完成，报告已保存':'正在结合企业资料与经营模型分析';
      q('[data-analysis-message]').textContent=state==='failed'?'资料与已校对条件已保留。重试将重新请求五个角色，不会自动发送或新增业务数据。':state==='completed'?'已保存真实角色分析与100条条件情景。':'光效仅表示协作状态；完成数量来自实际模型任务。';
      q('[data-analysis-files]').innerHTML=value.files.map(file=>`<span><i class="ph ph-file-text" aria-hidden="true"></i>${e(file.fileName)}</span>`).join('');
      for(const [role]of roles){const agent=value.agents.find(item=>item.role===role),current=agent?.state??'queued';const node=q(`[data-analysis-node="${role}"]`),row=q(`[data-analysis-role="${role}"]`);node.dataset.state=current;row.dataset.state=current;node.querySelector('[data-node-state]')!.textContent=states[current];row.querySelector('[data-role-state]')!.textContent=states[current];row.querySelector('[data-role-model]')!.textContent=agent?.model?`${agent.provider??''} / ${agent.model}`:'';}
      if(mode!=='live'){
        q('[data-analysis-headline]').textContent=mode==='history'?'历史查看 · 已保存的五角色分析':'星系预览 · 尚无五角色结果';
        q('[data-analysis-message]').textContent=mode==='history'?'仅查看保存内容，不重新调用模型。星尘为氛围动画，不是历史执行时序回放。':'当前没有角色分析，星尘仅为独立动效预览，不代表正在运行任务。';
        if(mode==='empty')q('[data-analysis-progress]').textContent='尚未开始角色分析';
        for(const [role]of roles)if(!value.agents.some(agent=>agent.role===role)){q(`[data-analysis-node="${role}"] [data-node-state]`).textContent=mode==='empty'?'待开始':'未保存';q(`[data-analysis-role="${role}"] [data-role-state]`).textContent=mode==='empty'?'待开始':'未保存';}
      }
      q<HTMLButtonElement>('[data-analysis-retry]').hidden=mode!=='live'||state!=='failed';showRole(selectedRole);syncMotion();
    },
    setActive(value:boolean){active=value;syncMotion();},dispose,
  };
}
