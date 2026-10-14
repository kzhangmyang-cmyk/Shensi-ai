import { simulateOperatingPlans, type OperatingBaseline, type OperatingPlan, type OperatingShock } from './decision-simulation-engine.js';
import {operatingRecommendations} from './decision-operating-recommendations.js';

type Runs = ReturnType<typeof simulateOperatingPlans>;
function summarize(runs: Runs) {
  const baseline = runs[0];
  return runs.map(run => {
    const profits = run.samples.map(sample => sample.totalProfitMinor);
    const cashSorted = [...run.samples.map(sample => sample.minimumCashMinor)].sort((a,b)=>a-b);
    const tail = Math.max(1, Math.ceil(cashSorted.length * 0.05));
    const worst5PctMeanCashMinor = Math.round(cashSorted.slice(0, tail).reduce((sum, value) => sum + value, 0) / tail);
    return {
      planId: run.planId,
      sampleCount: run.samples.length,
      profitRangeMinor: [Math.min(...profits), Math.max(...profits)],
      worstMinimumCashMinor: cashSorted[0],
      worst5PctMeanCashMinor,
      samplesWithFundingGap: run.samples.filter(sample => sample.fundingGapMinor > 0).length,
      samplesWithBacklog: run.samples.filter(sample => sample.months.some(month => month.backlogUnits > 0)).length,
      maximumBacklogUnits: Math.max(...run.samples.map(sample => Math.max(...sample.months.map(month => month.backlogUnits)))),
      pairedProfitDifferenceMinor: profits.map((profit, index) => profit - baseline.samples[index].totalProfitMinor),
    };
  });
}

/** Conditional, one-factor-at-a-time stress comparison; not a variance
 * decomposition or a causal estimate. Other realized paths stay fixed even
 * when their generating assumptions share a common component. */
export function analyzeOperatingPlans(
  baseline: OperatingBaseline, alternatives: readonly OperatingPlan[], paths: readonly (readonly OperatingShock[])[],
) {
  const unchanged: OperatingPlan = { id: 'baseline', demandMultiplier: 1, capacityMultiplier: 1, priceMultiplier: 1, costMultiplier: 1, extraFixedCostMinor: 0 };
  const plans = [unchanged, ...alternatives];
  const runs = simulateOperatingPlans(baseline, plans, paths);
  const factors = ['demand', 'procurement', 'collectionDelay', 'delivery'] as const;
  const sensitivity = factors.flatMap(factor => (['down', 'up'] as const).map(direction => {
    const delta = direction === 'up' ? 1 : -1;
    const changed = paths.map(path => path.map(shock => ({ ...shock, [factor]: Math.max(0, Math.min(24,
      factor === 'collectionDelay' ? shock[factor] + delta : shock[factor] * (1 + delta * 0.1),
    )) })));
    return {
      factor, direction,
      adjustment: factor === 'collectionDelay' ? 'one_month_clamped_0_24' : 'ten_percent_clamped_0_24',
      plans: summarize(simulateOperatingPlans(baseline, plans, changed)),
    };
  }));
  const contribution = baseline.priceMinor - baseline.unitCostMinor;
  const breakEvenUnits = baseline.fixedCostMinor === 0 && contribution >= 0
    ? 0 : contribution > 0 ? Math.ceil(baseline.fixedCostMinor / contribution) : null;
  const summaries=summarize(runs);
  return {
    modelVersion: runs[0].modelVersion,
    plans: summaries,
    recommendations:operatingRecommendations(baseline,summaries[0],sensitivity),
    replays: runs,
    sensitivity,
    externalFactorImpact: [] as Array<{id:string;label:string;impact:string}>,
    threshold: {
      unitsForMonthlyOperatingBreakEven: breakEvenUnits,
      withinBaselineCapacity: breakEvenUnits !== null && breakEvenUnits <= baseline.capacityUnits,
      conditions: 'Constant baseline unit price/cost and fixed cost; no shocks, financing, tax, depreciation or opening-AR/AP profit. Units must be delivered; this is NOT a cash break-even threshold.',
    },
  };
}
