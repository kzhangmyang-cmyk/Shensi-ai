import type {components} from '../generated/decision-simulation';
import {escapeHtml as e} from '../demo/demo-ui';
import type {SimulationRecord} from '../decision-simulation/samples';
import type {GrowthHttpClient} from '../growth/http';
type Schemas=components['schemas'];
type Memory=Schemas['DecisionMemory'];
type Preferences=Schemas['DecisionPreferences'];
export interface DecisionMemoryApi {
 get():Promise<Memory>;
 saveProfile(input:Schemas['DecisionProfileWrite']):Promise<Memory>;
 deleteProfile(input:Schemas['DecisionMemoryRevision']):Promise<Memory>;
 saveReview(input:Schemas['DecisionReviewWrite']):Promise<Memory>;
 adopt(input:Schemas['DecisionCandidateAdoption']):Promise<Memory>;
 export():Promise<unknown>;
}
export function createOperatingMemoryApi(http:GrowthHttpClient):DecisionMemoryApi{
 const path='/api/v1/agent-memory/operating';
 return {get:async()=>(await http.request<Memory>(path)).body,
  saveProfile:async body=>(await http.request<Memory>(path+'/profile',{method:'PUT',body})).body,
  deleteProfile:async body=>(await http.request<Memory>(path+'/profile',{method:'DELETE',body})).body,
  saveReview:async body=>(await http.request<Memory>(path+'/reviews',{method:'PUT',body})).body,
  adopt:async body=>(await http.request<Memory>(path+'/adopt',{method:'POST',body})).body,
  export:async()=>(await http.request<unknown>(path+'/export')).body};
}
const labels={cash:'现金安全',profit:'经营利润',delivery:'交付稳定'};
const errors:Record<string,string>={decision_memory_revision_conflict:'另一页面已修改记录。请刷新个人记录后重试，当前编辑未提交。',decision_learning_disabled:'个人档案或学习已关闭，不能采用候选。',decision_candidate_unavailable:'这项候选已不存在，请刷新记录。',decision_memory_input_invalid:'请完整填写有效日期、数值、来源和归因说明。',decision_review_plan_locked:'已有实际结果，不能改写原计划；请保留原目标。',decision_review_capacity:'已达到200项复盘上限；现有记录仍可更新或导出。'};
const message=(error:unknown)=>error instanceof Error?(errors[error.message]??error.message):'保存失败，请重试';

export function mountDecisionMemory(host:HTMLElement,api:DecisionMemoryApi,editor:{read():Preferences|undefined;set(value:Preferences|undefined,selection?:Schemas['OperatingMemorySelection']):void},live:()=>boolean,download:(name:string,content:string)=>void){
 let memory:Memory|undefined;let busy=false;let reviewHost:HTMLElement|undefined;let report:SimulationRecord|undefined;let generation=0;
 const cardVersions=new WeakMap<HTMLElement,{revision:number;saved:string|undefined}>();
 const receive=(value:Memory)=>{if(!memory||value.revision>=memory.revision)memory=value;};
 host.innerHTML='<details class="decision-memory"><summary>我的长期偏好与复盘</summary><p>个人偏好只归当前账号与工作区，不是企业共享事实或SOP。读取不会自动用于本次报告。</p><div data-memory-summary>正在读取个人记录…</div><div class="decision-memory-actions"><button type="button" data-memory-refresh>刷新个人记录</button><button type="button" data-memory-use>用于本次输入</button><button type="button" data-memory-save>将上方已确认偏好保存为长期偏好</button><button type="button" data-memory-toggle>关闭长期偏好与学习</button><button type="button" data-memory-learning>关闭反馈学习</button><button type="button" data-memory-export>导出本人偏好与复盘JSON</button><button type="button" data-memory-delete>删除个人偏好档案</button></div><p>删除仅清除长期偏好和待确认候选；已保存报告快照与手动复盘保留。目前不支持单独删除历史报告。清除本次输入请使用上方按钮。</p><p data-memory-status role="status"></p></details>';
 const status=host.querySelector<HTMLElement>('[data-memory-status]')!;
 const valid=()=>host.isConnected&&live();
 const button=(name:string)=>host.querySelector<HTMLButtonElement>(`[data-memory-${name}]`)!;
 const controls=()=>{
   host.querySelectorAll<HTMLButtonElement>('button').forEach(item=>item.disabled=busy||(!memory&&item!==button('refresh')));
   button('use').disabled=busy||!memory?.profile?.enabled;
   button('toggle').disabled=busy||!memory?.profile;
   button('learning').disabled=busy||!memory?.profile;
 };
 const summary=()=>{
   const profile=memory?.profile;
   host.querySelector('[data-memory-summary]')!.innerHTML=profile?`<p><strong>${e(labels[profile.preferences.priority])}优先</strong> · ${profile.enabled?'长期偏好已开启':'长期偏好已关闭'} · ${profile.preferences.learningEnabled?'允许明确反馈候选':'反馈学习已关闭'}</p><p>${profile.preferences.cashFloorMinor===undefined?'未设置现金底线':`现金底线 ¥${(profile.preferences.cashFloorMinor/100).toFixed(2)}`} · ${profile.preferences.pilotFirst?'先试点':'未要求先试点'} · ${profile.preferences.reviewCadence==='weekly'?'每周':'每月'}复盘</p>`:'<p>没有保存长期偏好。可先在上方确认，再显式保存。</p>';
   button('toggle').textContent=profile?.enabled?'关闭长期偏好与学习':'启用长期偏好';
   button('learning').textContent=profile?.preferences.learningEnabled?'关闭反馈学习':'开启明确反馈候选';controls();
 };
 async function action(work:()=>Promise<Memory>,success:string){
   if(busy||!valid())return;busy=true;controls();
   try{const value=await work();if(!valid())return;receive(value);summary();status.textContent=success;}
   catch(error){if(valid())status.textContent=message(error);}
   finally{busy=false;if(valid())controls();}
 }
 const refresh=()=>action(()=>api.get(),'已读取本人记录，尚未应用到当前报告。');
 button('refresh').onclick=()=>{void refresh();};
 button('use').onclick=()=>{if(!memory?.profile?.enabled||busy||!valid())return;editor.set(structuredClone(memory.profile.preferences),{domain:'operating',revision:memory.revision});status.textContent='已显式选用经营领域偏好；旧报告不变，不应用到获客命令。';};
 button('save').onclick=()=>{void action(async()=>{const preferences=editor.read();if(!preferences)throw new Error('请先在上方启用并确认本次偏好');return api.saveProfile({expectedRevision:memory!.revision,enabled:true,preferences});},'长期偏好已保存；不会回写旧报告。');};
 button('toggle').onclick=()=>{void action(()=>api.saveProfile({expectedRevision:memory!.revision,enabled:!memory!.profile!.enabled,preferences:memory!.profile!.preferences}),'长期偏好状态已更新；关闭时不生成或采用候选。');};
 button('learning').onclick=()=>{void action(()=>api.saveProfile({expectedRevision:memory!.revision,enabled:memory!.profile!.enabled,preferences:{...memory!.profile!.preferences,learningEnabled:!memory!.profile!.preferences.learningEnabled}}),'反馈学习状态已更新。');};
 button('delete').onclick=()=>{void action(()=>api.deleteProfile({expectedRevision:memory!.revision}),'个人偏好已删除，历史报告快照与复盘保留。');};
 button('export').onclick=()=>{if(busy||!valid())return;busy=true;controls();void api.export().then(value=>{if(valid()){download('Shensi-个人偏好与复盘.json',JSON.stringify(value,null,2));status.textContent='已导出本人有权访问的偏好与复盘。';}}).catch(error=>{if(valid())status.textContent=message(error);}).finally(()=>{busy=false;if(valid())controls();});};
 void refresh();

 function renderReviews(target:HTMLElement,current:SimulationRecord,only?:string){
   if(!valid()||!target.isConnected||current!==report||target!==reviewHost||!memory)return;
   const kept=only?[...target.querySelectorAll<HTMLElement>('[data-review-id]')].filter(card=>card.dataset.reviewId!==only):[];
   const renderedRevision=memory.revision;
   target.innerHTML=`<section class="decision-review"><h3>执行与复盘</h3><p>认领建议 → 保存计划 → 录入实际结果。数值目标由你填写，不等于模型预测；差额不是因果收益。手动复盘不会完成CRM或增长顾问业务。</p>${(current.report.recommendations??[]).map(suggestion=>{
     const saved=memory!.reviews.find(item=>item.runId===current.runId&&item.recommendationId===suggestion.id);
     const field=(key:string,label:string,value:unknown,type='text')=>`<label>${label}<input data-review-field="${key}" type="${type}" ${type==='number'?'step="any" min="-1000000000000" max="1000000000000"':''} value="${e(value===undefined?'':String(value))}" maxlength="2000"></label>`;
     return `<details data-review-id="${e(suggestion.id)}"><summary>${e(suggestion.title)} · ${saved?.state==='reviewed'?'已录入复盘':saved?'已认领计划':'尚未认领'}</summary><p>原始依据：${e(saved?.originalEvidence??suggestion.evidence)}</p><fieldset data-plan ${saved?.result?'disabled':''}><legend>本人认领的计划</legend>${field('action','计划行动',saved?.plan.action??suggestion.action)}${field('metric','复盘指标',saved?.plan.metric)}${field('unit','单位（如 元/件、天、%）',saved?.plan.unit)}${field('baseline','试点前基线',saved?.plan.baseline,'number')}${field('target','计划目标',saved?.plan.target,'number')}${field('dueDate','计划复盘日期',saved?.plan.dueDate,'date')}${field('planSource','计划依据/来源',saved?.plan.source)}</fieldset><button type="button" data-save-plan ${saved?.result?'disabled':''}>${saved?'更新计划':'认领并保存计划'}</button>${saved?`<fieldset><legend>实际结果 · 手动录入</legend>${field('actual','实际值（与上方相同指标/单位）',saved.result?.actual,'number')}${field('observedDate','实际观察日期',saved.result?.observedDate,'date')}${field('resultSource','结果来源（如单据/台账及期间）',saved.result?.source)}${field('attribution','归因不确定性/其他影响',saved.result?.attribution)}<label>我的明确偏好反馈（可选）<select data-review-field="feedbackPriority"><option value="">不提出偏好变化</option value="cash">更重视现金安全</option><option value="profit">更重视经营利润</option><option value="delivery">更重视交付稳定</option></select></label></fieldset><button type="button" data-save-result>保存实际结果与复盘</button>`:'<p>先保存计划，再录入实际结果。</p>'}${saved?.comparison?`<p>实际−目标：${e(String(saved.comparison.actualMinusTarget))} ${e(saved.plan.unit)}；实际−基线：${e(String(saved.comparison.actualMinusBaseline))} ${e(saved.plan.unit)}。手填同指标对照，非因果归因。</p><p>来源：${e(saved.result!.source)}；观察日期：${e(saved.result!.observedDate)}；录入时间：${e(saved.recordedAt)}；归因说明：${e(saved.result!.attribution)}</p>`:''}${saved?.candidate?`<p>待确认候选：${e(labels[saved.candidate])}优先（来自你的明确复盘反馈）</p><button type="button" data-adopt-review>确认更新长期偏好</button>`:''}<p role="status" data-review-status></p></details>`;
   }).join('')||'<p>此历史报告没有保存建议，不补造复盘对象。</p>'}</section>`;
   target.querySelectorAll<HTMLElement>('[data-review-id]').forEach(card=>{
     const recommendationId=card.dataset.reviewId!;
     const saved=memory!.reviews.find(item=>item.runId===current.runId&&item.recommendationId===recommendationId);
     const existing=kept.find(item=>item.dataset.reviewId===recommendationId);
     if(existing){const version=cardVersions.get(existing);if(version&&version.saved===JSON.stringify(saved))version.revision=renderedRevision;card.replaceWith(existing);return;}
     const version={revision:renderedRevision,saved:JSON.stringify(saved)};cardVersions.set(card,version);
     const feedbackSelect=card.querySelector<HTMLSelectElement>('[data-review-field=feedbackPriority]');
     if(feedbackSelect)for(const option of feedbackSelect.options)option.selected=option.value===(saved?.result?.feedbackPriority??'');
     const read=(key:string)=>(card.querySelector<HTMLInputElement|HTMLSelectElement>(`[data-review-field=${key}]`)!.value??'').trim();
     const number=(key:string)=>{const raw=read(key),value=Number(raw);if(!raw||!Number.isFinite(value))throw new Error('请填写完整有效数值，空值不是0');return value;};
     const currentView=()=>valid()&&target===reviewHost&&report===current&&card.isConnected;
     const save=async(result:boolean,adopt=false)=>{
       if(busy||!currentView())return;busy=true;controls();card.querySelectorAll<HTMLButtonElement>('button').forEach(item=>item.disabled=true);
       const resultStatus=card.querySelector<HTMLElement>('[data-review-status]')!;
       try{
         const base={expectedRevision:version.revision,runId:current.runId,recommendationId};
         const plan=saved?.result?saved.plan:{action:read('action'),metric:read('metric'),unit:read('unit'),baseline:number('baseline'),target:number('target'),dueDate:read('dueDate'),source:read('planSource')};
         const feedback=result?read('feedbackPriority'):'';
         const value=await(adopt?api.adopt(base):api.saveReview({...base,plan,...(result?{result:{actual:number('actual'),observedDate:read('observedDate'),source:read('resultSource'),attribution:read('attribution'),...(feedback?{feedbackPriority:feedback as Preferences['priority']}:{})}}:{})}));
         if(!currentView())return;receive(value);summary();renderReviews(target,current,recommendationId);target.querySelector<HTMLElement>(`[data-review-id="${recommendationId}"]`)?.setAttribute('open','');
       }catch(error){if(currentView())resultStatus.textContent=message(error);}
       finally{busy=false;if(valid())controls();if(currentView())card.querySelectorAll<HTMLButtonElement>('button').forEach(item=>item.disabled=item.hasAttribute('data-save-plan')&&!!saved?.result);}
     };
     card.querySelector<HTMLButtonElement>('[data-save-plan]')!.onclick=()=>{void save(false);};
     const resultButton=card.querySelector<HTMLButtonElement>('[data-save-result]');if(resultButton)resultButton.onclick=()=>{void save(true);};
     const adoptButton=card.querySelector<HTMLButtonElement>('[data-adopt-review]');if(adoptButton)adoptButton.onclick=()=>{void save(false,true);};
   });
   const reload=target.ownerDocument.createElement('button');reload.type='button';reload.textContent='刷新复盘（放弃未保存编辑）';reload.dataset.refreshReviews='';target.querySelector('h3')!.after(reload);
   reload.onclick=()=>{if(busy)return;const token=++generation;void api.get().then(value=>{if(!valid()||token!==generation||target!==reviewHost||!target.isConnected)return;receive(value);summary();renderReviews(target,current);}).catch(error=>{if(valid()&&token===generation)status.textContent=message(error);});};
 }
 return {showReport(target:HTMLElement,current:SimulationRecord){reviewHost=target;report=current;const token=++generation;target.textContent='正在读取本人执行记录…';void api.get().then(value=>{if(!valid()||generation!==token||!target.isConnected)return;receive(value);summary();renderReviews(target,current);}).catch(error=>{if(valid()&&generation===token&&target.isConnected)target.textContent=message(error);});}};
}
