import type {OperatingBaseline} from './decision-simulation-engine.js';

interface SummaryEvidence {
  planId:string;sampleCount:number;samplesWithFundingGap:number;samplesWithBacklog:number;
  maximumBacklogUnits:number;profitRangeMinor:number[];worstMinimumCashMinor:number;
}
interface SensitivityEvidence {factor:string;direction:string;plans:SummaryEvidence[]}
export interface OperatingRecommendation {
  id:string;title:string;priority:'high'|'normal';evidenceKind:'simulation_signal';
  evidence:string;evidenceRefs:string[];action:string;mechanism:string;
  costAndPrerequisites:string;ownerRole:string;timeframe:string;reviewMetric:string;
  validation:'pilot_required';
  scenarioComparison?:{label:string;baselineProfitRangeMinor:number[];changedProfitRangeMinor:number[];baselineWorstCashMinor:number;changedWorstCashMinor:number};
}

/** Explain saved model signals; actions remain proposals, not measured savings. */
export function operatingRecommendations(baseline:OperatingBaseline,summary:SummaryEvidence,sensitivity:SensitivityEvidence[]):OperatingRecommendation[]{
  const items:OperatingRecommendation[]=[];
  const common={evidenceKind:'simulation_signal' as const,validation:'pilot_required' as const};
  const comparison=(factor:string)=>{
    const scenario=sensitivity.find(item=>item.factor===factor&&item.direction==='down')?.plans.find(plan=>plan.planId==='baseline');
    if(!scenario)return undefined;
    return {label:factor==='procurement'?'采购成本倍率下调10%，其他已实现路径固定':'新增应收延后减少1月（下限0），其他已实现路径固定',baselineProfitRangeMinor:[...summary.profitRangeMinor],changedProfitRangeMinor:[...scenario.profitRangeMinor],baselineWorstCashMinor:summary.worstMinimumCashMinor,changedWorstCashMinor:scenario.worstMinimumCashMinor};
  };
  if(baseline.collectionMonths>0||summary.samplesWithFundingGap>0){
    items.push({...common,id:'collections',title:'先核对回款节点与现金缺口',priority:summary.samplesWithFundingGap>0?'high':'normal',
      evidence:`基线账期${baseline.collectionMonths}月；${summary.sampleCount}条模拟路径中${summary.samplesWithFundingGap}条出现期初或月末资金缺口。`,evidenceRefs:['input.baseline.collectionMonths','report.plans[0].samplesWithFundingGap','report.sensitivity.collectionDelay.down'],
      action:'按客户核对应收到期、验收和开票节点；先对一个可协商客户试行分阶段验收/收款，建立到期提醒。',mechanism:'提前完成验收与回款可缩短资金占用；不把尚未回款收入当作可用现金。',
      costAndPrerequisites:'需核实合同及客户同意，不单方面改账期；财务与销售投入时间，折扣成本另行报价。模型不包含坏账和催收成本。',ownerRole:'财务负责人 + 销售负责人',timeframe:'7日核对到期表，30日复盘试点',reviewMetric:'实际到期回款率、逾期天数、月末现金；同时检查客户投诉与折扣成本。',scenarioComparison:comparison('collectionDelay')});
  }
  if(baseline.unitCostMinor>0&&(baseline.monthlyOrders>0||baseline.backlogUnits>0)){
    items.push({...common,id:'procurement',title:'小批量验证采购与单位成本优化',priority:'normal',
      evidence:`人工确认单位直接成本${(baseline.unitCostMinor/100).toFixed(2)}元；成本敏感性展示同一经营起点下的条件结果。`,evidenceRefs:['input.baseline.unitCostMinor','report.sensitivity.procurement.down'],
      action:'对主要采购项做同规格比价、批量阶梯与交付条款核对，选一个品类小批量试用；有库存时先补库存周转与损耗数据再决定采购量。',mechanism:'降低合格交付所需单位直接成本；减少损耗可能有帮助，但当前库存与损耗未建模。',
      costAndPrerequisites:'保持质量标准与交付稳定；需供应商报价、检验及试单成本，不以低价替代质量。10%只是模型扰动，不是可实现降价承诺。',ownerRole:'采购负责人 + 质量负责人',timeframe:'14日完成比价与试单，30日复盘',reviewMetric:'合格品单位全成本、到货准时率、不良率和缺货次数。',scenarioComparison:comparison('procurement')});
  }
  if(summary.samplesWithBacklog>0){
    items.push({...common,id:'delivery',title:'先消除交付瓶颈，再评估扩容',priority:'high',evidence:`${summary.samplesWithBacklog}/${summary.sampleCount}条路径出现积压，最大${summary.maximumBacklogUnits}件。`,evidenceRefs:['report.plans[0].samplesWithBacklog','report.plans[0].maximumBacklogUnits'],
      action:'记录一个完整交付周期的等待、返工与岗位负荷，试行排程和跨岗备份；只有确认重复性瓶颈后再对自动化做小规模试点。',mechanism:'减少等待和中断可能提升有效交付；当前模型不区分工序、返工或自动化效果，需现场验证。',costAndPrerequisites:'需要工时、质量与设备报价；保留质量、人员安全和客户交期约束，不默认裁员或直接扩大固定投入。',ownerRole:'运营负责人',timeframe:'7日定位瓶颈，14日试点，30日复盘',reviewMetric:'按期交付率、积压件数、返工率、加班工时；收益与投入有实际数据后再算回收期。'});
  }
  if(baseline.priceMinor<=baseline.unitCostMinor&&baseline.monthlyOrders>0){
    items.push({...common,id:'unit_economics',title:'先核实单笔贡献，再增加销量',priority:'high',evidence:`基线售价${(baseline.priceMinor/100).toFixed(2)}元，不高于直接成本${(baseline.unitCostMinor/100).toFixed(2)}元。`,evidenceRefs:['input.baseline.priceMinor','input.baseline.unitCostMinor'],action:'核对产品组合、折扣与成本口径，对一个客户分组测试报价或交付规格，不全面涨价。',mechanism:'在单位贡献未改善前增加销量可能扩大亏损。',costAndPrerequisites:'需分产品成本和客户接受度数据，维持质量及合同承诺；不承诺涨价后需求不变。',ownerRole:'经营负责人 + 销售负责人',timeframe:'7日核算，14日小范围试点',reviewMetric:'单笔贡献、转化率、复购与投诉；同时比较订单数量变化。'});
  }
  if(baseline.monthlyOrders<baseline.capacityUnits&&summary.samplesWithBacklog===0){
    items.push({...common,id:'demand_validation',title:'先验证有效需求，避免盲目扩产',priority:'normal',evidence:`基线订单${baseline.monthlyOrders}件/月，产能${baseline.capacityUnits}件/月；本次路径未出现积压。`,evidenceRefs:['input.baseline.monthlyOrders','input.baseline.capacityUnits','report.plans[0].samplesWithBacklog'],action:'选择一个目标客群或渠道做小预算测试，记录线索到付费及交付全过程；不先增加固定产能。',mechanism:'验证需求与单位贡献后再投入，避免把假设订单增长当作已获得客户。',costAndPrerequisites:'用户先确认试验预算上限；需获客成本、退单与回款数据，当前模型未计算渠道ROI。',ownerRole:'销售负责人',timeframe:'14日试验，30日复盘',reviewMetric:'付费转化、获客全成本、单笔贡献及实际回款，而非仅统计线索数。'});
  }
  return items.sort((a,b)=>(a.priority==='high'?0:1)-(b.priority==='high'?0:1));
}
