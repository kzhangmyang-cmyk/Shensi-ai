import type {DecisionSimulationInput} from './decision-simulation-service.js';
import type {FinanceSpreadsheetCell} from './finance-document-inspection.js';
import {generateOperatingPaths} from './decision-simulation-engine.js';
import {analyzeOperatingPlans} from './decision-simulation-analysis.js';

/** Derived evidence is named separately from uploaded file references. Models explain, not calculate. */
export function decisionCalculationCells(input:DecisionSimulationInput):FinanceSpreadsheetCell[]{
  const money=(minor:number)=>(minor/100).toFixed(2);
  const b=input.baseline;
  const confirmed=[
    `人工确认的模拟基线：期初现金${money(b.cashMinor)}元，每月订单${b.monthlyOrders}件，期初积压${b.backlogUnits}件，每月交付产能${b.capacityUnits}件。`,
    `人工确认的模拟基线：销售单价${money(b.priceMinor)}元，单位直接成本${money(b.unitCostMinor)}元，每月固定费用${money(b.fixedCostMinor)}元，基础回款周期${b.collectionMonths}个月。`,
    `人工确认的期初应收：${b.receivables.length?b.receivables.map(item=>`模拟第${item.dueMonth}月到期${money(item.amountMinor)}元`).join('；'):'没有余额（明确假设，不是审计结论）'}。期初应付：${b.payables.length?b.payables.map(item=>`模拟第${item.dueMonth}月到期${money(item.amountMinor)}元`).join('；'):'没有余额（明确假设，不是审计结论）'}。`,
    `人工确认的假设说明：${input.assumptionNote}`,
    `波动区间为假设而非历史估计：${JSON.stringify(input.options.assumptions)}。样本${input.options.samples}条，期限${input.options.months}个月，种子${input.options.seed}。`,
    `备选方案（乘数1为不变；extraFixedCostMinor按分）：${JSON.stringify(input.alternatives)}。`,
    `显式经营事件假设：${JSON.stringify(input.options.events??[])}。默认未启用。发生时替代相应月份背景因子，同因素重叠已拒绝。概率/强度不是历史校准，不代表现实发生概率；不得虚构未启用事件。`,
  ];
  const report=analyzeOperatingPlans(b,input.alternatives,generateOperatingPaths(input.options));
  const summary=(plan:typeof report.plans[number])=>`方案${plan.planId==='baseline'?'维持现状':plan.planId}：最差月末现金${money(plan.worstMinimumCashMinor)}元，累计经营利润范围${plan.profitRangeMinor.map(money).join('–')}元，资金缺口${plan.samplesWithFundingGap}/${plan.sampleCount}条样本，积压${plan.samplesWithBacklog}/${plan.sampleCount}条样本，最大积压${plan.maximumBacklogUnits}件。`;
  const calculated=[...report.plans.map(summary),...report.sensitivity.flatMap(change=>change.plans.map(plan=>`条件敏感性，${change.factor}${change.direction==='up'?'+':'-'}${change.factor==='collectionDelay'?'1月':'10%'}，其他已生成路径不变。${summary(plan)}`)),
    `条件盈亏平衡交付量：${report.threshold.unitsForMonthlyOperatingBreakEven===null?'单位贡献不足，没有有限平衡量':`${report.threshold.unitsForMonthlyOperatingBreakEven}件/月`}，${report.threshold.withinBaselineCapacity?'基线产能可覆盖':'基线产能不可覆盖'}。基线价格成本不变，不是现金平衡点。`,
    '规则计算限制：收入按交付确认，回款到期计现金。直接成本在交付月支付。不含库存、融资、税及折旧。只检查期初及月末现金。样本区间不是置信区间，缺口占比不是现实失败概率。'];
  return [...confirmed.map((text,index)=>({sourceRef:`confirmed:${index+1}`,sheetName:'用户确认的模拟条件',row:index+1,column:1,text})),
    ...calculated.map((text,index)=>({sourceRef:`calc:${index+1}`,sheetName:'确定性算法结果',row:index+1,column:1,text}))];
}
