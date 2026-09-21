/** Internal deterministic model, not a public DTO or a calibrated forecast. */
export interface OperatingShock {
  demand: number; procurement: number; collectionDelay: number; delivery: number;
  events?: Array<OperatingEvent & {backgroundValue:number}>;
}
export interface OperatingEvent {
  template:string; startMonth:number; durationMonths:number; value:number; probability:number; assumption:string;
}
export const operatingEventFactors:Readonly<Record<string,'demand'|'procurement'|'collectionDelay'|'delivery'>>={
  staffing_shortage:'delivery',staffing_recovery:'delivery',sales_gain:'demand',sales_loss:'demand',cost_rise:'procurement',cost_fall:'procurement',payment_delay:'collectionDelay',payment_recovery:'collectionDelay',
};

export function validateOperatingEvents(events:readonly OperatingEvent[],months:number):void {
  integer(events.length,0,8);
  const occupied=new Set<string>(),ids=new Set<string>();
  for(const event of events){
    const factor=Object.hasOwn(operatingEventFactors,event.template)?operatingEventFactors[event.template]:undefined;
    if(!factor||ids.has(event.template)||typeof event.assumption!=='string'||!event.assumption.trim()||event.assumption.length>500)throw new Error('invalid_operating_event');
    ids.add(event.template);integer(event.startMonth,1,months);integer(event.durationMonths,1,months-event.startMonth+1);finite(event.probability,0,1);finite(event.value,0,24);
    if(['staffing_shortage','sales_loss','cost_fall'].includes(event.template))finite(event.value,0,1);
    if(['staffing_recovery','sales_gain','cost_rise'].includes(event.template))finite(event.value,1,24);
    if(event.template==='payment_recovery'&&event.value!==0)throw new Error('invalid_operating_event_recovery');
    if(event.template==='payment_delay')integer(event.value,1,24);
    if(factor==='collectionDelay')integer(event.value,0,24);
    for(let month=event.startMonth;month<event.startMonth+event.durationMonths;month++){
      const key=`${factor}:${month}`;
      if(occupied.has(key))throw new Error('overlapping_operating_events');
      occupied.add(key);
    }
  }
}
export interface ScheduledAmount { dueMonth: number; amountMinor: number }
export interface OperatingBaseline {
  cashMinor: number; monthlyOrders: number; backlogUnits: number; capacityUnits: number;
  priceMinor: number; unitCostMinor: number; fixedCostMinor: number; collectionMonths: number;
  receivables: readonly ScheduledAmount[]; payables: readonly ScheduledAmount[];
}
export interface OperatingPlan {
  id: string; demandMultiplier: number; capacityMultiplier: number;
  priceMultiplier: number; costMultiplier: number; extraFixedCostMinor: number;
}
export interface OperatingAssumptions {
  demand: readonly number[]; procurement: readonly number[];
  collectionDelay: readonly number[]; delivery: readonly number[];
  /** Convex lag/common-component weights, NOT estimated correlation coefficients. */
  persistence: number; commonWeight: number;
}
export interface OperatingMonth {
  month: number; orders: number; delivered: number; backlogUnits: number;
  revenueMinor: number; receiptsMinor: number; paymentsMinor: number;
  profitMinor: number; cashMinor: number; receivablesMinor: number;
  shock: OperatingShock;
}

function finite(value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error('invalid_operating_input');
}
function integer(value: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  finite(value, min, max);
  if (!Number.isSafeInteger(value)) throw new Error('invalid_operating_integer');
  return value;
}
function money(value: number): number { return integer(value, -Number.MAX_SAFE_INTEGER); }
function randomStream(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateOperatingPaths(options: {
  seed: number; samples: number; months: number; assumptions: OperatingAssumptions; events?:readonly OperatingEvent[];
}): OperatingShock[][] {
  const { seed, samples, months, assumptions: a } = options;
  integer(seed, 0, 4294967295); integer(samples, 1, 1000); integer(months, 1, 24);
  finite(a.persistence, 0, 1); finite(a.commonWeight, 0, 1);
  for (const range of [a.demand, a.procurement, a.collectionDelay, a.delivery]) {
    if (range.length !== 2) throw new Error('invalid_operating_range');
    finite(range[0], 0, 24); finite(range[1], range[0], 24);
  }
  integer(a.collectionDelay[0]); integer(a.collectionDelay[1]);
  const events=options.events??[];validateOperatingEvents(events,months);
  return Array.from({ length: samples }, (_, sample) => {
    const random = randomStream((seed + Math.imul(sample, 0x9e3779b1)) >>> 0);
    // Separate per-template streams preserve the old background path and are order-independent.
    const activeEvents=events.filter(event=>{
      let hash=2166136261;for(const char of event.template)hash=Math.imul(hash^char.charCodeAt(0),16777619);
      return randomStream((seed^Math.imul(sample,0x9e3779b1)^hash)>>>0)()<event.probability;
    });
    let previous: number[] | undefined;
    return Array.from({ length: months }, (_,index) => {
      const common = random();
      const quantiles = Array.from({ length: 4 }, (_, factor) => {
        const fresh = a.commonWeight * common + (1 - a.commonWeight) * random();
        return previous ? a.persistence * previous[factor] + (1 - a.persistence) * fresh : fresh;
      });
      previous = quantiles;
      const interpolate = (range: readonly number[], q: number) => range[0] + (range[1] - range[0]) * q;
      // Common adversity lowers demand/delivery while increasing cost/delay.
      const shock:OperatingShock={
        demand: interpolate(a.demand, 1 - quantiles[0]),
        procurement: interpolate(a.procurement, quantiles[1]),
        collectionDelay: Math.min(a.collectionDelay[1], Math.floor(a.collectionDelay[0] + (a.collectionDelay[1] - a.collectionDelay[0] + 1) * quantiles[2])),
        delivery: interpolate(a.delivery, 1 - quantiles[3]),
      };
      if(events.length){
        shock.events=[];
        for(const event of [...activeEvents].sort((left,right)=>left.template.localeCompare(right.template))){
          if(index+1<event.startMonth||index+1>=event.startMonth+event.durationMonths)continue;
          const factor=operatingEventFactors[event.template];
          shock.events.push({...event,backgroundValue:shock[factor]});
          shock[factor]=event.value;
        }
      }
      return shock;
    });
  });
}

/** Monthly accrual: new orders → delivered units → AR → due-date receipt.
 * Direct unit costs are paid on delivery; fixed costs monthly. Opening AR/AP
 * retain supplied due dates. Negative cash signals an unfunded gap, not a loan.
 */
export function simulateOperatingPlans(
  baseline: OperatingBaseline, plans: readonly OperatingPlan[], paths: readonly (readonly OperatingShock[])[],
) {
  money(baseline.cashMinor);
  for (const value of [baseline.monthlyOrders, baseline.backlogUnits, baseline.capacityUnits,
    baseline.priceMinor, baseline.unitCostMinor, baseline.fixedCostMinor]) integer(value);
  integer(baseline.collectionMonths, 0, 24);
  for (const entries of [baseline.receivables, baseline.payables]) {
    integer(entries.length, 0, 10000);
    for (const entry of entries) { integer(entry.dueMonth, 1, 48); integer(entry.amountMinor); }
  }
  integer(plans.length, 1, 10); integer(paths.length, 1, 1000);
  const ids = new Set<string>();
  for (const plan of plans) {
    if (typeof plan.id !== 'string' || !plan.id.trim() || plan.id.length > 100 || ids.has(plan.id)) throw new Error('invalid_operating_plan_id');
    ids.add(plan.id);
    for (const value of [plan.demandMultiplier, plan.capacityMultiplier, plan.priceMultiplier, plan.costMultiplier]) finite(value, 0, 10);
    integer(plan.extraFixedCostMinor);
  }
  for (const path of paths) {
    integer(path.length, 1, 24);
    if (path.length !== paths[0].length) throw new Error('inconsistent_operating_horizon');
    for (const shock of path) {
      for (const value of [shock.demand, shock.procurement, shock.delivery]) finite(value, 0, 24);
      integer(shock.collectionDelay, 0, 24);
    }
  }
  return plans.map(plan => ({
    planId: plan.id,
    modelVersion: paths.some(path=>path.some(shock=>shock.events!==undefined))?'operating-monthly-v2-events':'operating-monthly-v1',
    samples: paths.map(path => {
      let cash = baseline.cashMinor;
      let backlog = baseline.backlogUnits;
      let receivables = baseline.receivables.map(entry => ({ ...entry }));
      let minimumCashMinor = cash;
      let totalProfitMinor = 0;
      const months: OperatingMonth[] = path.map((shock, index) => {
        const month = index + 1;
        const orders = integer(Math.floor(baseline.monthlyOrders * plan.demandMultiplier * shock.demand));
        const capacity = integer(Math.floor(baseline.capacityUnits * plan.capacityMultiplier * shock.delivery));
        const available = integer(backlog + orders);
        const delivered = Math.min(available, capacity);
        backlog = available - delivered;
        const revenueMinor = integer(Math.round(delivered * baseline.priceMinor * plan.priceMultiplier));
        const directCost = integer(Math.round(delivered * baseline.unitCostMinor * plan.costMultiplier * shock.procurement));
        const operatingCost = integer(directCost + baseline.fixedCostMinor + plan.extraFixedCostMinor);
        receivables.push({ dueMonth: month + baseline.collectionMonths + shock.collectionDelay, amountMinor: revenueMinor });
        const receiptsMinor = receivables.filter(entry => entry.dueMonth <= month).reduce((sum, entry) => integer(sum + entry.amountMinor), 0);
        receivables = receivables.filter(entry => entry.dueMonth > month);
        const openingPayments = baseline.payables.filter(entry => entry.dueMonth === month).reduce((sum, entry) => integer(sum + entry.amountMinor), 0);
        const paymentsMinor = integer(operatingCost + openingPayments);
        const profitMinor = money(revenueMinor - operatingCost);
        cash = money(cash + receiptsMinor - paymentsMinor);
        minimumCashMinor = Math.min(minimumCashMinor, cash);
        totalProfitMinor = money(totalProfitMinor + profitMinor);
        return { month, orders, delivered, backlogUnits: backlog, revenueMinor, receiptsMinor, paymentsMinor,
          profitMinor, cashMinor: cash, receivablesMinor: receivables.reduce((sum, entry) => integer(sum + entry.amountMinor), 0), shock: structuredClone(shock) };
      });
      return { months, minimumCashMinor, totalProfitMinor, fundingGapMinor: Math.max(0, -minimumCashMinor) };
    }),
  }));
}
