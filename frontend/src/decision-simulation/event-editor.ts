import { escapeHtml as e } from '../demo/demo-ui';
import type { SimulationInput } from './samples';
type Options=SimulationInput['options'];
type Event=NonNullable<Options['events']>[number];
export const eventTemplates:Record<Event['template'],{label:string;factor:'demand'|'procurement'|'delivery'|'collectionDelay';value:number;applies:string}>={
  staffing_shortage:{label:'人员缺勤 / 岗位空缺',factor:'delivery',value:.8,applies:'交付依赖员工工时'},
  staffing_recovery:{label:'人员熟练度提升',factor:'delivery',value:1.1,applies:'已具备培训或学习改善条件；不含培训费用'},
  sales_gain:{label:'销售渠道需求增加',factor:'demand',value:1.15,applies:'存在可带来新增订单的渠道；不含营销费用'},
  sales_loss:{label:'销售渠道需求下降',factor:'demand',value:.85,applies:'订单受到渠道波动影响'},
  cost_rise:{label:'采购单价上涨',factor:'procurement',value:1.1,applies:'单位直接成本受外购价格影响'},
  cost_fall:{label:'采购单价下降',factor:'procurement',value:.9,applies:'单位直接成本受外购价格影响'},
  payment_delay:{label:'客户付款延迟',factor:'collectionDelay',value:1,applies:'存在赊销；影响生效月全部新增应收，不含坏账'},
  payment_recovery:{label:'客户恢复基准账期',factor:'collectionDelay',value:0,applies:'新增应收不再额外延期；不追溯改变旧欠款'},
};

/** Opt-in editor writes the same canonical options JSON used by the existing form. */
export function mountEventEditor(host:HTMLElement,read:()=>Options,write:(options:Options)=>void){
  host.innerHTML=`<details><summary>日常经营事件 · 可选</summary><p>默认不启用。只添加适合本企业的事件；概率和强度是可调整模拟假设，不是预测。生效月用事件值<strong>替代</strong>对应背景因子，不额外叠加。同因素时间重叠会拒绝，不丢弃任何事件。</p>
    <label>适用事件<select data-event-template>${Object.entries(eventTemplates).map(([id,item])=>`<option value="${id}">${e(item.label)} · ${e(item.applies)}</option>`).join('')}</select></label>
    <div class="decision-event-fields"><label>开始月<input data-event-start type="number" min="1" max="24" value="1"></label><label>持续月数<input data-event-duration type="number" min="1" max="24" value="1"></label><label>本路径发生概率（0–1）<input data-event-probability type="number" min="0" max="1" step=".05" value="0.25"></label><label><span data-event-value-label>最终交付倍率（1=无扰动）</span><input data-event-value type="number" min="0" max="24" step=".05" value="0.8"></label></div>
    <label>假设依据<input data-event-note maxlength="500" value="模拟假设，未按企业历史校准"></label><button type="button" data-event-add>确认适用并添加事件</button><p role="status" data-event-status></p><div data-event-list></div><p>本版仅改变需求、产能效率、单位采购成本或新增应收账期；不包含坏账、招聘培训费用、返工、设备或融资模型。</p></details>`;
  const q=(name:string)=>host.querySelector<HTMLInputElement>(`[data-event-${name}]`)!;
  const select=host.querySelector<HTMLSelectElement>('[data-event-template]')!;
  const sync=()=>{try{
    const events=read().events??[];
    if(q('status').textContent==='波动参数JSON无效，请先修正。')q('status').textContent='';
    host.querySelector('[data-event-list]')!.innerHTML=events.length?events.map((event,index)=>`<p>${e(eventTemplates[event.template]?.label??event.template)} · M${event.startMonth}–M${event.startMonth+event.durationMonths-1} · 替代值${event.value} · 概率${event.probability} <button type="button" data-event-remove="${index}">移除</button><br>${e(event.assumption)}</p>`).join(''):'<p>未启用事件，仅使用背景波动。</p>';
    host.querySelectorAll<HTMLButtonElement>('[data-event-remove]').forEach(button=>button.onclick=()=>{const options=read();write({...options,events:options.events?.filter((_,index)=>index!==Number(button.dataset.eventRemove))});sync();});
  }catch{q('status').textContent='波动参数JSON无效，请先修正。';}};
  select.onchange=()=>{const item=eventTemplates[select.value as Event['template']];q('value').value=String(item.value);q('value-label').textContent=item.factor==='collectionDelay'?'最终额外延期月数（整数）':`最终${item.factor==='delivery'?'交付':item.factor==='demand'?'需求':'采购成本'}倍率（1=无扰动）`;};
  host.querySelector<HTMLButtonElement>('[data-event-add]')!.onclick=()=>{try{
    const options=read(),template=select.value as Event['template'],item=eventTemplates[template];
    const event:Event={template,startMonth:Number(q('start').value),durationMonths:Number(q('duration').value),value:Number(q('value').value),probability:Number(q('probability').value),assumption:q('note').value.trim()};
    if(!item||!event.assumption||!Number.isInteger(event.startMonth)||!Number.isInteger(event.durationMonths)||event.startMonth<1||event.durationMonths<1||event.startMonth+event.durationMonths-1>options.months||!Number.isFinite(event.value)||event.value<0||event.value>24||!Number.isFinite(event.probability)||event.probability<0||event.probability>1)throw new Error('请填写有效月份、强度、概率及假设，事件不得超出模拟期间。');
    if((options.events??[]).some(other=>other.template===template||(eventTemplates[other.template].factor===item.factor&&other.startMonth<event.startMonth+event.durationMonths&&event.startMonth<other.startMonth+other.durationMonths)))throw new Error('事件重复或同因素月份冲突，请调整月份或移除已有事件。');
    if((['staffing_shortage','sales_loss','cost_fall'].includes(template)&&event.value>1)||(['staffing_recovery','sales_gain','cost_rise'].includes(template)&&event.value<1)||(item.factor==='collectionDelay'&&!Number.isInteger(event.value))||(template==='payment_delay'&&event.value<1)||(template==='payment_recovery'&&event.value!==0))throw new Error('事件方向不匹配：下降倍率不高于1，上升倍率不低于1；延期为正整数，恢复基准账期为0。');
    write({...options,events:[...(options.events??[]),event]});q('status').textContent='已加入模拟假设。生成后按同一事件路径比较各方案。';sync();
  }catch(error){q('status').textContent=error instanceof Error?error.message:'无法添加事件';}};
  sync();return {sync};
}
