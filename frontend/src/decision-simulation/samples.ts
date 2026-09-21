import type { components } from '../generated/decision-simulation';
export type SimulationInput = components['schemas']['Input'];
export type SimulationRecord = components['schemas']['Record'];
export type SimulationHistory = components['schemas']['ListItem'];
export function operatingExample(kind: 'normal' | 'cash' | 'capacity'): SimulationInput {
  return {
    runId: crypto.randomUUID(), title: {normal:'示例 · 正常经营',cash:'示例 · 回款延迟',capacity:'示例 · 产能受限'}[kind],
    dataKind:'synthetic', assumptionNote:'隔离示例，非企业历史数据。需求±15%、采购成本±10%、交付效率85%–100%；月回款延迟0–1月，持续权重0.4、共同不利扰动权重0.2。',
    baseline:{cashMinor:kind==='cash'?300000:6000000,monthlyOrders:100,backlogUnits:kind==='capacity'?30:0,capacityUnits:kind==='capacity'?70:120,
      priceMinor:10000,unitCostMinor:6000,fixedCostMinor:250000,collectionMonths:kind==='cash'?3:1,
      receivables:[{dueMonth:1,amountMinor:1200000}],payables:[{dueMonth:1,amountMinor:800000}]},
    alternatives:[{id:'扩容与需求增长',demandMultiplier:1.15,capacityMultiplier:1.3,priceMultiplier:1,costMultiplier:1,extraFixedCostMinor:50000}],
    options:{seed:7,samples:100,months:12,assumptions:{demand:[0.85,1.15],procurement:[0.9,1.1],collectionDelay:[0,1],delivery:[0.85,1],persistence:0.4,commonWeight:0.2}},
  };
}
