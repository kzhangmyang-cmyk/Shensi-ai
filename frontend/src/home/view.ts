import {createAcquisitionApi} from '../acquisition/runtime-api';
import {runStatusLabel} from '../acquisition/runtime-model';
import {entryArt} from './entry-art';
import {installHomeMotion} from './motion';
const entries=[
 ['acquisition','获客中心','发现线索，推进客户关系'],
 ['agents','智能体中心','多角色协作，解决经营问题'],
 ['decision-simulation','星盘决策模拟','推演不同选择，看清经营走势'],
];
const more=[['dashboard','自动营销总览'],['conversations','社媒对话'],['private-domain','私域客户池'],['enterprise-query','企业查询'],['growth/advisor','增长顾问'],['growth/catalog','客户目录'],['growth/quotes','报价工作台'],['growth/finance','财务经营'],['growth/roi','ROI经营分析'],['financial-council','财务委员会'],['settings','设置中心']];
export function mountHome(host:HTMLElement,api:Pick<ReturnType<typeof createAcquisitionApi>,'getOverview'>|undefined,live:()=>boolean){
 installHomeMotion(host.ownerDocument);
 host.innerHTML=`<section class="shensi-home" aria-label="首页"><header class="home-intro"><span class="home-eyebrow">工作台 <span aria-hidden="true">/</span> 首页<button type="button" class="home-motion-toggle" data-home-motion-toggle aria-pressed="false" aria-label="暂停首页装饰动效">暂停动效</button></span><h2>今天，从一个好决策开始</h2><p>连接客户、团队与经营决策。</p></header><nav class="shensi-home-primary" aria-label="常用入口">${entries.map(([route,title,description],index)=>`<a href="#${route}" data-home-entry="${route}">${entryArt(route)}<div class="home-entry-copy"><span class="home-entry-number" aria-hidden="true">0${index+1}</span><h3>${title}</h3><p>${description}</p><span class="home-entry-action"><span class="home-entry-action-label">进入${title}</span><i class="ph ph-arrow-right" aria-hidden="true"></i></span></div></a>`).join('')}</nav><details class="shensi-home-more"><summary><span>更多功能</span><span class="home-more-preview" aria-hidden="true"><span><i class="ph ph-buildings"></i>企业查询</span><span><i class="ph ph-chats-circle"></i>社媒对话</span><span><i class="ph ph-users"></i>私域客户池</span><span><i class="ph ph-chart-bar"></i>财务经营</span></span><i class="ph ph-caret-right" aria-hidden="true"></i></summary><nav aria-label="更多功能">${more.map(([route,title])=>`<a href="#${route}">${title}<i class="ph ph-arrow-up-right" aria-hidden="true"></i></a>`).join('')}</nav></details><section class="shensi-home-tasks" aria-label="获客任务状态"><header><h3>继续任务</h3><button type="button" data-home-refresh>刷新状态</button></header><div data-home-tasks role="status"></div><a href="#acquisition">返回获客任务 →</a></section></section>`;
 const root=host.querySelector<HTMLElement>('.shensi-home')!;const target=root.querySelector<HTMLElement>('[data-home-tasks]')!;
 const motion=root.querySelector<HTMLButtonElement>('[data-home-motion-toggle]')!;
 motion.onclick=()=>{
  const paused=motion.getAttribute('aria-pressed')!=='true';
  motion.setAttribute('aria-pressed',String(paused));motion.textContent=paused?'继续动效':'暂停动效';
  motion.setAttribute('aria-label',paused?'继续首页装饰动效':'暂停首页装饰动效');
  root.querySelectorAll('shensi-home-art').forEach(art=>art.setAttribute('data-paused',String(paused)));
 };
 const button=root.querySelector<HTMLButtonElement>('[data-home-refresh]')!;let generation=0;
 const valid=()=>root.isConnected&&live();
 async function refresh(){
  if(!api){target.textContent='进入获客中心查看任务。';button.hidden=true;return;}
  const token=++generation;button.disabled=true;target.textContent='正在读取任务状态…';
  try{const value=await api.getOverview();if(!valid()||token!==generation)return;
   const active=value.tasks.filter(task=>task.latestRun&&['queued','running','pause_requested','cancel_requested','paused'].includes(task.latestRun.status));
   target.replaceChildren();
   if(!active.length)target.textContent='最近任务中没有进行中或暂停的任务。';
   else for(const task of active){const row=host.ownerDocument.createElement('p');row.textContent=`${task.name} · ${runStatusLabel(task.latestRun!.status)}`;target.append(row);}
  }catch{if(valid()&&token===generation)target.textContent='任务状态暂时不可用，可重试或进入获客中心查看。';}
  finally{if(valid()&&token===generation)button.disabled=false;}
 }
 button.onclick=()=>{void refresh();};void refresh();
}
