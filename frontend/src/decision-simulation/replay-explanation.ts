import { escapeHtml as e } from '../demo/demo-ui';
import type { SimulationRecord } from './samples';
import { eventTemplates } from './event-editor';

type Month = SimulationRecord['report']['replays'][number]['samples'][number]['months'][number];
const money=(value:number)=>(value/100).toLocaleString('zh-CN',{maximumFractionDigits:2});
const percent=(value:number)=>`${value>=1?'+':''}${((value-1)*100).toLocaleString('zh-CN',{maximumFractionDigits:1})}%`;

/** Read saved realized factors, never invent business events from an outcome. */
export function monthFactors(month:Month):string[]|null {
  const s=month.shock;
  if(!s||![s.demand,s.procurement,s.delivery,s.collectionDelay].every(Number.isFinite))return null;
  return [`需求${percent(s.demand)}`,`采购成本${percent(s.procurement)}`,`交付效率${percent(s.delivery)}`,`回款延后${s.collectionDelay}月`];
}

export function replayComparison(record:SimulationRecord,plan:number,comparison:number,sample:number,month:number):string {
  const selected=record.report.replays[plan].samples[sample].months;
  const other=record.report.replays[comparison].samples[sample].months;
  const paired=selected.length===other.length&&selected.every((value,index)=>monthFactors(value)&&monthFactors(other[index])&&(['demand','procurement','delivery','collectionDelay'] as const).every(key=>value.shock[key]===other[index].shock[key]));
  const id=record.report.replays[comparison].planId;
  return `${id==='baseline'?'维持现状':id}：${paired?'相同已保存波动路径':'波动路径不一致或缺失，仅展示结果差值，不能视为同条件方案效果'}；本方案减对照：现金差额 ¥${money(selected[month].cashMinor-other[month].cashMinor)}；经营利润差额 ¥${money(selected[month].profitMinor-other[month].profitMinor)}。`;
}

export function renderReplayExplanation(record:SimulationRecord,plan:number,sample:number,month:number):string {
  const run=record.report.replays[plan], path=run.samples[sample].months, selected=path[month];
  const factors=monthFactors(selected), b=record.input.baseline;
  const currentPlan=run.planId==='baseline'?{demandMultiplier:1,capacityMultiplier:1,priceMultiplier:1,costMultiplier:1,extraFixedCostMinor:0}:record.input.alternatives.find(item=>item.id===run.planId);
  const eventText=(item:Month)=>item.shock?.events===undefined?'未记录具体业务事件':item.shock.events.length?item.shock.events.map(event=>`${eventTemplates[event.template]?.label??event.template}（M${event.startMonth}–M${event.startMonth+event.durationMonths-1}，背景值${event.backgroundValue.toFixed(3)}被${event.value}替代；假设：${event.assumption}）`).join('；'):'本月无已启用事件生效';
  return `<header><h3>这些结果如何形成</h3><p>情景${sample+1} · M${month+1} · 因素变化相对无扰动值，不是相对上月。金额为已保存计算结果，不是单因素贡献分摊。</p></header>
    <div class="decision-factor-current">${factors?factors.map(text=>`<span>${e(text)}</span>`).join(''):'<p>此历史记录未保存完整因素，无法还原本月原因。</p>'}</div>
    <p data-realized-events>${e(eventText(selected))}。事件发生概率为输入假设，非历史预测；替代对应背景值，不叠加扣减。</p>
    <ol class="decision-factor-chain">
      <li><strong>需求 → 订单 → 交付</strong><p>基线月订单${b.monthlyOrders} × 方案需求倍率${currentPlan?e(String(currentPlan.demandMultiplier)):'未保存'} × 当月需求因子，向下取整得到订单。产能${b.capacityUnits} × 方案产能倍率${currentPlan?e(String(currentPlan.capacityMultiplier)):'未保存'} × 交付效率，限制当月交付。已保存：订单${selected.orders}、交付${selected.delivered}、期末积压${selected.backlogUnits}件。</p></li>
      <li><strong>交付与采购成本 → 收入和经营利润</strong><p>交付 × 基线单价 × 方案价格倍率形成收入；交付 × 单位成本 × 方案成本倍率 × 采购因子形成直接成本，再扣固定费用。已保存：收入 ¥${money(selected.revenueMinor)}，经营利润 ¥${money(selected.profitMinor)}。</p></li>
      <li><strong>账期 → 回款 → 现金</strong><p>${factors?`本月新增收入按基线账期${b.collectionMonths}月 + 延后${selected.shock.collectionDelay}月安排在M${selected.month+b.collectionMonths+selected.shock.collectionDelay}回款；`:'缺少因素，无法还原本月新增收入的回款月份；'}期初应收应付按原到期月结算。已保存：回款 ¥${money(selected.receiptsMinor)} − 支付 ¥${money(selected.paymentsMinor)} = 本月净现金流 ¥${money(selected.receiptsMinor-selected.paymentsMinor)}；月末现金 ¥${money(selected.cashMinor)}。回款延迟不直接扣减本月经营利润。</p></li>
    </ol><details open><summary>逐月因素与结果（元）</summary><div class="decision-factor-table-scroll"><table class="decision-factor-table"><thead><tr><th>月份</th><th>实际因素与事件</th><th>净现金流</th><th>经营利润</th><th>月末现金</th></tr></thead><tbody>${path.map(item=>`<tr data-factor-month="${item.month}" ${item.month===selected.month?'aria-current="true"':''}><th>M${item.month}</th><td>${e(monthFactors(item)?.join(' · ')??'因素未保存，无法还原')}${item.shock?.events?.length?`<br>${e(eventText(item))}`:''}</td><td>${money(item.receiptsMinor-item.paymentsMinor)}</td><td>${money(item.profitMinor)}</td><td>${money(item.cashMinor)}</td></tr>`).join('')}</tbody></table></div></details>
    <details><summary>来源与模拟假设</summary><p data-factor-assumptions>${e(record.input.assumptionNote)}</p><p>来源：本报告保存的输入、逐月因素及计算结果。种子${record.input.options.seed}；引擎${e(run.modelVersion)}。未保存具体业务事件的历史记录，不能进一步归因为员工离职或客户流失；这些因素不是已发生事实或现实概率。</p></details>`;
}
