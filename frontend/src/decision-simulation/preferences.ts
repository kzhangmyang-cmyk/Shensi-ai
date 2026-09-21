import {escapeHtml as e} from '../demo/demo-ui';
import type {components} from '../generated/decision-simulation';
import type {SimulationRecord} from './samples';
type Preferences=components['schemas']['DecisionPreferences'];
const labels={cash:'现金安全',profit:'经营利润',delivery:'交付稳定'};
export function mountDecisionPreferences(host:HTMLElement){
  host.innerHTML=`<details class="decision-preferences"><summary>决策偏好 · 可选</summary><p>只用于方案排序与现金底线核对，不改变利润和随机路径。可跳过，不推断人格。</p><label><input type="checkbox" data-pref-enabled>本次使用我确认的偏好</label><fieldset><legend>优先考虑</legend>${Object.entries(labels).map(([key,label],i)=>`<label><input type="radio" name="decision-priority" value="${key}" ${i===0?'checked':''}>${label}</label>`).join('')}</fieldset><label>现金底线（元，可留空）<input type="number" min="0" max="10000000000" step="0.01" data-pref-floor></label><label><input type="checkbox" data-pref-pilot checked>先小范围试点</label><label><input type="checkbox" data-pref-weekly checked>每周复盘（取消则每月）</label><label><input type="checkbox" data-pref-learning>允许根据我本次明确反馈提出偏好候选</label><button type="button" data-pref-confirm>确认本次偏好</button><button type="button" data-pref-clear>清除本次偏好</button><p data-pref-status role="status">未启用；不会自动学习或读取聊天。</p><details><summary>给出明确反馈</summary><p>反馈仅生成待确认候选，不立即改变已确认偏好。</p>${Object.entries(labels).map(([key,label])=>`<button type="button" data-feedback="${key}">我更看重${label}</button>`).join('')}<p data-pref-candidate role="status"></p><button type="button" data-pref-accept hidden>确认采用候选</button></details><p>偏好随新报告保存。清除或关闭仅影响本次输入，不删除历史报告快照；长期保存、关闭学习与导出请使用下方个人档案；不会自动读取聊天或改写偏好。</p></details>`;
  const q=(selector:string)=>host.querySelector<HTMLInputElement>(selector)!;
  const status=host.querySelector<HTMLElement>('[data-pref-status]')!;
  const candidateText=host.querySelector<HTMLElement>('[data-pref-candidate]')!;
  let confirmed:Preferences|undefined;let candidate:Preferences['priority']|undefined;
  const clearCandidate=()=>{candidate=undefined;candidateText.textContent='';q('[data-pref-accept]').hidden=true;};
  const collect=(confirmedFrom:Preferences['confirmedFrom']):Preferences=>{
    const value=q('[data-pref-floor]').value.trim(),amount=Number(value);
    if(value&&(!Number.isFinite(amount)||amount<0||amount>1e10))throw new Error('现金底线应为有效非负金额');
    return {priority:([...host.querySelectorAll<HTMLInputElement>('[name=decision-priority]')].find(input=>input.checked)?.value??'cash') as Preferences['priority'],...(value?{cashFloorMinor:Math.round(amount*100)}:{}),pilotFirst:q('[data-pref-pilot]').checked,reviewCadence:q('[data-pref-weekly]').checked?'weekly':'monthly',learningEnabled:q('[data-pref-learning]').checked,confirmedFrom};
  };
  const confirm=(source:Preferences['confirmedFrom'])=>{try{if(!q('[data-pref-enabled]').checked){status.textContent='请先勾选本次使用偏好；未启用时不参与排序。';return;}confirmed=collect(source);status.textContent=`已确认：${labels[confirmed.priority]}优先 · ${confirmed.pilotFirst?'先试点':'未要求先试点'} · ${confirmed.reviewCadence==='weekly'?'每周':'每月'}复盘。生成新报告时保存。`;clearCandidate();}catch(error){status.textContent=error instanceof Error?error.message:'请检查偏好';}};
  host.addEventListener('change',()=>{confirmed=undefined;clearCandidate();status.textContent=q('[data-pref-enabled]').checked?'偏好已修改，请确认后再生成。':'未启用；不会自动学习或读取聊天。';});
  q('[data-pref-confirm]').onclick=()=>confirm('self_report');
  host.querySelectorAll<HTMLButtonElement>('[data-feedback]').forEach(button=>button.onclick=()=>{if(!q('[data-pref-learning]').checked||!q('[data-pref-enabled]').checked){status.textContent='请先启用本次偏好并允许明确反馈候选。';return;}candidate=button.dataset.feedback as Preferences['priority'];candidateText.textContent=`候选：${labels[candidate]}优先。来源：你刚才的明确反馈；尚未采用。`;q('[data-pref-accept]').hidden=false;});
  q('[data-pref-accept]').onclick=()=>{if(!candidate)return;host.querySelectorAll<HTMLInputElement>('[name=decision-priority]').forEach(input=>{input.checked=input.value===candidate;});confirm('explicit_feedback');};
  const set=(value:Preferences|undefined)=>{confirmed=value?structuredClone(value):undefined;clearCandidate();q('[data-pref-enabled]').checked=!!value;q('[data-pref-floor]').value=value?.cashFloorMinor===undefined?'':String(value.cashFloorMinor/100);q('[data-pref-pilot]').checked=value?.pilotFirst??true;q('[data-pref-weekly]').checked=value?.reviewCadence!=='monthly';q('[data-pref-learning]').checked=value?.learningEnabled??false;host.querySelectorAll<HTMLInputElement>('[name=decision-priority]').forEach(input=>{input.checked=input.value===(value?.priority??'cash');});status.textContent=value?`已读取保存偏好：${labels[value.priority]}优先。可修改、重新确认或清除本次偏好。`:'未启用；不会自动学习或读取聊天。';};
  q('[data-pref-clear]').onclick=()=>set(undefined);
  return {set,read:()=>{if(!q('[data-pref-enabled]').checked)return undefined;if(!confirmed)throw new Error('请先确认本次决策偏好');return structuredClone(confirmed);}};
}

export function renderPreferenceAssessment(record:SimulationRecord):string{
  const preferences=record.input.decisionPreferences,assessment=record.report.preferenceAssessment;
  if(!preferences||!assessment)return '';
  return `<section class="decision-preference-assessment"><h3>已确认偏好 · 方案适配</h3><p>${e(labels[preferences.priority])}优先 · ${preferences.pilotFirst?'先小范围试点':'未要求先试点'} · ${preferences.reviewCadence==='weekly'?'每周':'每月'}复盘 · 来源：${preferences.confirmedFrom==='explicit_feedback'?'明确反馈后确认':'自主填写确认'}</p><p>${e(assessment.basis)}；只比较当前样本，不改变原有计算。</p><ol>${assessment.plans.map(plan=>`<li>${e(plan.planId==='baseline'?'维持现状':plan.planId)} · ${plan.meetsCashFloor===null?'未设置现金底线':plan.meetsCashFloor?'样本满足现金底线':'至少一个样本低于现金底线'}</li>`).join('')}</ol>${preferences.cashFloorMinor===undefined?'':`<p>现金底线：¥${(preferences.cashFloorMinor/100).toFixed(2)}；检查期初及月末，不涵盖月内支付峰值。</p>`}</section>`;
}
